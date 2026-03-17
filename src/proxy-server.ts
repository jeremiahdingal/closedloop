/**
 * HTTP Proxy Server for Ollama
 */

import * as http from 'http';
import { getOllamaPorts, getPaperclipApiUrl, getCompanyId } from './config';
import { getAgentName, getIssueDetails, patchIssue, postComment, findAssignedIssue } from './paperclip-api';
import { AGENTS, BLOCKED_AGENTS, AGENT_NAMES, issueProcessingLock, issueBuilderPasses } from './agent-types';
import { extractIssueId, extractAgentId, sleep } from './utils';
import { applyCodeBlocks } from './code-extractor';
import { commitAndPush, createPullRequest } from './git-ops';
import { buildIssueContext, buildLocalBuilderContext, setRAGIndexer, getRAGIndexer } from './context-builder';
import { executeBashBlocks } from './bash-executor';
import { detectAndDelegate } from './delegation';
import { runArtistStage } from './artist-recorder';
import { ragIndexer } from './rag-indexer';
import { OllamaRequest, OllamaResponse } from './types';

const { proxyPort, ollamaPort } = getOllamaPorts();
const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();

// Track recent agent runs to prevent spam
const recentAgentRuns = new Map<string, number>();
const DELEGATION_COOLDOWN_MS = 5 * 60 * 1000;

export function createProxy(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    let issueId = extractIssueId(parsedBody);
    const agentId = extractAgentId(parsedBody);
    const agentName = await getAgentName(agentId || '');

    // If no issue in payload, check if this agent has an assigned issue
    if (!issueId && agentId) {
      const assignedIssueId = await findAssignedIssue(agentId);
      if (assignedIssueId) {
        issueId = assignedIssueId;
        console.log(`[proxy] Auto-resolved issue for ${agentName}: ${issueId.slice(0, 8)}`);
      }
    }

    // Block disabled agents
    if (agentId && BLOCKED_AGENTS.has(agentId)) {
      console.log(`[proxy:${proxyPort}] BLOCKED ${agentName} (disabled agent)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Agent is currently disabled._',
          },
        })
      );
      return;
    }

    // Guard: skip processing if issue is already completed
    if (issueId) {
      const issueState = await getIssueDetails(issueId);
      if (issueState && (issueState.status === 'in_review' || issueState.status === 'done' || issueState.status === 'cancelled')) {
        console.log(`[proxy] Skipping ${agentName} — issue ${issueId.slice(0, 8)} is ${issueState.status}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: `_Issue is ${issueState.status}, no action needed._` },
          })
        );
        return;
      }
    }

    // Artist bypasses Ollama and runs deterministic recorder
    if (issueId && agentId === AGENTS.artist) {
      console.log(`[proxy:${proxyPort}] ${agentName} -> feature recorder | issue=${issueId.slice(0, 8)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Artist feature recorder started._',
          },
        })
      );

      setImmediate(async () => {
        await runArtistStage(issueId);
      });
      return;
    }

    // Build Ollama payload
    const ollamaPayload: OllamaRequest = {
      model: parsedBody.model,
      stream: parsedBody.stream ?? false,
      messages: [...(parsedBody.messages || [])],
    };

    // Enrich with issue context or heartbeat context
    if (issueId) {
      // Local Builder gets enhanced context with existing file contents and RAG
      const issueContext =
        agentId === AGENTS['local builder']
          ? await buildLocalBuilderContext(issueId, agentId)
          : await buildIssueContext(issueId, agentId || '');
      if (issueContext) {
        ollamaPayload.messages.push({
          role: 'user',
          content: issueContext,
        });
      }
    } else if (parsedBody.context) {
      const heartbeatMsg = buildHeartbeatContext(parsedBody.context);
      ollamaPayload.messages.push({ role: 'user', content: heartbeatMsg });
    }

    console.log(
      `[proxy:${proxyPort}] ${agentName} -> ollama:${ollamaPort} | model=${ollamaPayload.model} | issue=${issueId?.slice(0, 8) || 'none'} | msgs=${ollamaPayload.messages.length}`
    );

    try {
      const ollamaRes = await fetch(`http://127.0.0.1:${ollamaPort}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaPayload),
      });

      const ollamaData = await ollamaRes.text();

      res.writeHead(ollamaRes.status, {
        'Content-Type': 'application/json',
      });
      res.end(ollamaData);

      // Post LLM output as comment and handle delegation
      if (issueId) {
        try {
          const parsed = JSON.parse(ollamaData);
          const content = parsed.message?.content || parsed.response || '';

          if (content.trim()) {
            await postComment(issueId, agentId, content.trim());

            // Detect delegation and reassign via API (triggers auto-wakeup)
            if (agentId) {
              await detectAndDelegate(issueId, agentId, content);
            }

            // Local Builder: extract code blocks, write files, commit (no PR yet)
            if (agentId === AGENTS['local builder']) {
              if (issueProcessingLock[issueId]) {
                console.log(`[proxy] Skipping duplicate Local Builder run for ${issueId.slice(0, 8)} (already processing)`);
              } else {
                issueProcessingLock[issueId] = true;
                try {
                  const { written: writtenFiles, fileContents } = applyCodeBlocks(content);
                  if (writtenFiles.length > 0) {
                    // Track pass count
                    if (!issueBuilderPasses[issueId]) {
                      try {
                        const branchName = await getBranchName(issueId);
                        const { execSync } = await import('child_process');
                        const { getWorkspace } = await import('./config');
                        execSync(`git rev-parse --verify ${branchName}`, {
                          cwd: getWorkspace(),
                          stdio: 'pipe',
                        });
                        issueBuilderPasses[issueId] = 1;
                      } catch {
                        issueBuilderPasses[issueId] = 0;
                      }
                    }
                    issueBuilderPasses[issueId]++;
                    const pass = issueBuilderPasses[issueId];
                    console.log(`[proxy] Local Builder wrote ${writtenFiles.length} files (pass ${pass})`);

                    // Commit and push (no PR)
                    await commitAndPush(issueId, writtenFiles, fileContents);

                    // Send to Reviewer
                    console.log(`[proxy] Pass ${pass}: Sending to Reviewer...`);
                    try {
                      await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                      console.log(`[proxy] Auto-assigned to Reviewer`);
                    } catch (err: any) {
                      console.error(`[proxy] Failed to trigger Reviewer:`, err.message);
                    }
                  }
                } finally {
                  issueProcessingLock[issueId] = false;
                }
              }
            }

            // Strategist/Sentinel/Deployer/Reviewer: execute bash commands
            if (agentId) {
              const commandsWereExecuted = await executeBashBlocks(issueId, agentId, content);

              // After executing bash commands, re-prompt the agent
              if (commandsWereExecuted && agentId !== AGENTS['local builder']) {
                console.log(`[proxy] Commands executed - re-assigning to ${AGENT_NAMES[agentId] || 'agent'} for follow-up...`);
                try {
                  const currentIssue = await getIssueDetails(issueId);
                  await patchIssue(issueId, {
                    assigneeAgentId: agentId,
                    description: currentIssue?.description || '',
                  });
                  console.log(`[proxy] Re-assigned issue ${issueId.slice(0, 8)} to ${AGENT_NAMES[agentId]} for follow-up`);
                } catch (err: any) {
                  console.error(`[proxy] Failed to re-assign for follow-up:`, err.message);
                }
              }
            }

            // Reviewer: validate changes and approve/reject before PR creation
            if (agentId === AGENTS.reviewer) {
              const reviewApproved =
                content.toLowerCase().includes('approved') ||
                content.toLowerCase().includes('looks good') ||
                content.toLowerCase().includes('lgtm') ||
                content.toLowerCase().includes('no issues') ||
                content.toLowerCase().includes('ready for pr');

              if (reviewApproved) {
                console.log(`[proxy] Reviewer APPROVED changes for ${issueId.slice(0, 8)}`);

                // Create PR after reviewer approval
                try {
                  await createPullRequest(issueId);
                  console.log(`[proxy] PR created after Reviewer approval`);
                } catch (prErr: any) {
                  console.error(`[proxy] Failed to create PR:`, prErr.message);
                  await postComment(issueId, null, `_Reviewer approved but PR creation failed: ${prErr.message}_`);
                }

                // Trigger Artist for visual audit after PR creation
                try {
                  await patchIssue(issueId, { assigneeAgentId: AGENTS.artist });
                  console.log(`[proxy] Auto-assigned to Artist for feature recording`);
                } catch (err: any) {
                  console.error(`[proxy] Failed to trigger Artist:`, err.message);
                }
              } else {
                console.log(`[proxy] Reviewer found issues - sending back to Local Builder`);
                try {
                  await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                  console.log(`[proxy] Sent back to Local Builder for fixes`);
                } catch (err: any) {
                  console.error(`[proxy] Failed to send back to Local Builder:`, err.message);
                }
              }
            }
          } else {
            await postComment(issueId, agentId, '_Agent completed run but produced no text output._');
          }
        } catch {
          await postComment(issueId, agentId, '_Agent run completed. Response could not be parsed._');
        }
      }
    } catch (err: any) {
      console.error(`[proxy:${proxyPort}] ${agentName} Ollama error:`, err.message);
      if (issueId) {
        await postComment(issueId, agentId, `_Agent run failed: ${err.message}_`);
      }
      res.writeHead(502);
      res.end(JSON.stringify({ error: `Ollama unreachable: ${err.message}` }));
    }
  });

  server.listen(proxyPort, '127.0.0.1', () => {
    console.log(`[proxy] :${proxyPort} -> ollama:${ollamaPort}`);
  });

  return server;
}

async function getBranchName(issueId: string): Promise<string> {
  const { getIssueDetails } = await import('./paperclip-api');
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}
  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || 'Code changes';
  return `${identifier}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`.replace(/-+$/, '');
}

function buildHeartbeatContext(context: any): string {
  const parts: string[] = [];
  if (context.wakeReason) parts.push(`Wake reason: ${context.wakeReason}`);
  if (context.paperclipWorkspace?.cwd) {
    parts.push(`Workspace: ${context.paperclipWorkspace.cwd}`);
  }
  if (parts.length === 0) {
    parts.push('This is a routine heartbeat check. Report your current status briefly.');
  }
  return parts.join('\n');
}

// Background issue assignment checker
export async function checkAssignedIssues(): Promise<void> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { issues?: any[]; data?: any[] };
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

    const assignedIssues = issues.filter(
      (i: any) => (i.status === 'todo' || i.status === 'in_progress') && i.assigneeAgentId
    );

    for (const issue of assignedIssues) {
      const agentId = issue.assigneeAgentId;
      const agentName = AGENT_NAMES[agentId] || 'unknown';

      if (BLOCKED_AGENTS.has(agentId)) continue;

      const recentRunKey = `${agentId}:${issue.id}`;
      if (recentAgentRuns.has(recentRunKey)) {
        const lastRun = recentAgentRuns.get(recentRunKey)!;
        if (Date.now() - lastRun < DELEGATION_COOLDOWN_MS) continue;
      }

      console.log(`[proxy] Background check: ${agentName} has assigned issue ${issue.identifier || issue.id.slice(0, 8)}`);

      try {
        await patchIssue(issue.id, {
          assigneeAgentId: agentId,
          priority: issue.priority || 'medium',
        });
        recentAgentRuns.set(recentRunKey, Date.now());
        console.log(`[proxy] Triggered wakeup for ${agentName} on ${issue.identifier || issue.id.slice(0, 8)}`);
      } catch (err: any) {
        console.log(`[proxy] Failed to trigger ${agentName}: ${err.message}`);
      }
    }
  } catch (err: any) {
    // Silent fail
  }
}

// Initialize RAG indexer
export async function initializeRAG(): Promise<void> {
  await ragIndexer.initialize();
  setRAGIndexer(ragIndexer);
  console.log('[proxy] RAG index initialized');
}
