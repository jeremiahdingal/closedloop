/**
 * ClosedLoop HTTP Server
 * 
 * Local-first, Ollama-powered proxy for Paperclip AI agents.
 * Handles communication between Paperclip agents and local Ollama instances.
 * Uses RAG for grounded, reliable code generation.
 */

import * as http from 'http';
import { getConfig, getOllamaPorts, getPaperclipApiUrl, getCompanyId, getBurstModel } from './config';
import { getAgentName, getIssueDetails, patchIssue, postComment, findAssignedIssue } from './paperclip-api';
import { AGENTS, BLOCKED_AGENTS, AGENT_NAMES } from './agent-types';
import { extractIssueId, extractAgentId } from './utils';
import { createPullRequest } from './git-ops';
import { buildIssueContext, setRAGIndexer } from './context-builder';
import { executeBashBlocks } from './bash-executor';
import { detectAndDelegate } from './delegation';
import { runArtistStage } from './artist-recorder';
import { runDiffGuardian } from './diff-guardian';
import { ragIndexer } from './rag-indexer';
import { OllamaRequest } from './types';

const { proxyPort, ollamaPort } = getOllamaPorts();
const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();

// Track recent agent runs to prevent spam
const recentAgentRuns = new Map<string, number>();
const DELEGATION_COOLDOWN_MS = 5 * 60 * 1000;

// Track Reviewer <-> Local Builder loops to prevent infinite cycles
// Key: issueId, Value: { count: number, lastReset: number }
const issueLoopCounts = new Map<string, { count: number; lastReset: number }>();
const MAX_LOOP_PASSES = 20; // Auto-create PR after 20 passes for human intervention
const LOOP_RESET_WINDOW_MS = 60 * 60 * 1000; // Reset count after 1 hour of no activity

// Track issues that should use burst model (greenfield first pass)
const issueBuilderBurstMode = new Set<string>();

/**
 * Track and detect Reviewer <-> Local Builder loops
 * Returns true if loop exceeds MAX_LOOP_PASSES
 */
function trackLoop(issueId: string, agentId: string): { count: number; exceeded: boolean } {
  const now = Date.now();
  let loopData = issueLoopCounts.get(issueId);

  // Initialize or reset if window expired
  if (!loopData || now - loopData.lastReset > LOOP_RESET_WINDOW_MS) {
    loopData = { count: 0, lastReset: now };
  }

  // Increment on Reviewer -> Local Builder handoff
  if (agentId === AGENTS.reviewer || agentId === AGENTS['local builder']) {
    loopData.count++;
    issueLoopCounts.set(issueId, loopData);
  }

  return {
    count: loopData.count,
    exceeded: loopData.count >= MAX_LOOP_PASSES,
  };
}

/**
 * Reset loop counter for an issue (e.g., after successful PR)
 */
function resetLoopCounter(issueId: string): void {
  issueLoopCounts.delete(issueId);
}

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
        console.log(`[closedloop] Auto-resolved issue for ${agentName}: ${issueId.slice(0, 8)}`);
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
        console.log(`[closedloop] Skipping ${agentName} - issue ${issueId.slice(0, 8)} is ${issueState.status}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: `_Issue is ${issueState.status}, no action needed._` },
          })
        );
        return;
      }
    }

    // Visual Reviewer bypasses Ollama and runs deterministic recorder
    if (issueId && agentId === AGENTS['visual reviewer']) {
      console.log(`[proxy:${proxyPort}] Visual Reviewer -> feature recorder | issue=${issueId.slice(0, 8)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Visual Reviewer feature recorder started._',
          },
        })
      );

      setImmediate(async () => {
        await runArtistStage(issueId);
      });
      return;
    }

    // Local Builder is bridge-owned now; forward immediately instead of running in the proxy.
    if (issueId && agentId === AGENTS['local builder']) {
      const localBuilderIssue = await getIssueDetails(issueId);
      const bridgeUrl = getBridgeUrl();

      // Determine if burst mode should be used (greenfield first pass)
      const useBurst = issueBuilderBurstMode.has(issueId);
      const burstModel = useBurst ? getBurstModel() : undefined;
      if (useBurst) {
        console.log(`[closedloop] Burst mode active for ${issueId.slice(0, 8)} — using ${burstModel}`);
        issueBuilderBurstMode.delete(issueId); // One-shot: only first pass uses burst
      }

      console.log(`[closedloop] Forwarding Local Builder assignment to bridge: ${bridgeUrl}`);

      try {
        const bridgeRes = await fetch(`${bridgeUrl}/webhook/issue-assigned`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueId,
            assigneeAgentId: agentId,
            title: localBuilderIssue?.title || 'Local Builder task',
            description: localBuilderIssue?.description || '',
            ...(burstModel ? { modelOverride: burstModel } : {}),
          }),
        });

        if (!bridgeRes.ok) {
          const bridgeText = await bridgeRes.text();
          console.error(`[closedloop] Bridge forward failed with status ${bridgeRes.status}: ${bridgeText}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Bridge forward failed: ${bridgeRes.status}` }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '_Local Builder assignment forwarded to bridge._',
            },
          })
        );
      } catch (err: any) {
        console.error('[closedloop] Failed to forward Local Builder assignment to bridge:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Bridge unreachable: ${err.message}` }));
      }

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
      const issueContext = await buildIssueContext(issueId, agentId || '');
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
              // Tech Lead → Local Builder: activate burst mode for greenfield scaffold
              if (agentId === AGENTS['tech lead'] && content.toLowerCase().includes('local builder')) {
                issueBuilderBurstMode.add(issueId);
                console.log(`[closedloop] Burst mode activated for ${issueId.slice(0, 8)} (first pass from Tech Lead)`);
              }
              await detectAndDelegate(issueId, agentId, content);
            }

            // Strategist/Sentinel/Deployer/Reviewer: execute bash commands
            if (agentId) {
              const commandsWereExecuted = await executeBashBlocks(issueId, agentId, content);

              // After executing bash commands, re-prompt the agent
              if (commandsWereExecuted && agentId !== AGENTS['local builder']) {
                console.log(`[closedloop] Commands executed - re-assigning to ${AGENT_NAMES[agentId] || 'agent'} for follow-up...`);
                try {
                  const currentIssue = await getIssueDetails(issueId);
                  await patchIssue(issueId, {
                    assigneeAgentId: agentId,
                    description: currentIssue?.description || '',
                  });
                  console.log(`[closedloop] Re-assigned issue ${issueId.slice(0, 8)} to ${AGENT_NAMES[agentId]} for follow-up`);
                } catch (err: any) {
                  console.error(`[closedloop] Failed to re-assign for follow-up:`, err.message);
                }
              }
            }

            // Reviewer: validate changes and approve/reject before PR creation
            if (agentId === AGENTS.reviewer) {
              const lower = content.toLowerCase();
              const reviewApproved =
                lower.includes('approved') ||
                lower.includes('looks good') ||
                lower.includes('lgtm') ||
                lower.includes('no issues') ||
                lower.includes('ready for pr') ||
                lower.includes('meet the project standards') ||
                lower.includes('meets the project standards') ||
                (lower.includes('result') && lower.includes('pass') && !lower.includes('send back'));

              if (reviewApproved) {
                console.log(`[closedloop] Reviewer APPROVED changes for ${issueId.slice(0, 8)}`);

                // Reset loop counter on successful approval
                resetLoopCounter(issueId);

                // Send to Diff Guardian for final validation before PR
                console.log(`[closedloop] Sending to Diff Guardian for final validation...`);
                try {
                  await patchIssue(issueId, { assigneeAgentId: AGENTS['diff guardian'] });
                  console.log(`[closedloop] Auto-assigned to Diff Guardian`);
                } catch (err: any) {
                  console.error(`[closedloop] Failed to trigger Diff Guardian:`, err.message);
                  // Fallback: run Diff Guardian mechanically
                  const diffResult = await runDiffGuardian(issueId);
                  if (diffResult.approved) {
                    await createPullRequest(issueId);
                    resetLoopCounter(issueId);
                  } else {
                    await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                  }
                }
              } else {
                // Reviewer rejected - track loop
                const loopStatus = trackLoop(issueId, agentId);
                console.log(`[closedloop] Reviewer found issues - sending back to Local Builder (loop: ${loopStatus.count}/${MAX_LOOP_PASSES})`);
                
                // Check if loop exceeded
                if (loopStatus.exceeded) {
                  console.log(`[closedloop] LOOP EXCEEDED (${loopStatus.count}) during Reviewer rejection`);
                  await postComment(
                    issueId,
                    null,
                    `**Review Loop Exceeded - Manual Review Required**\n\n` +
                    `This issue has been rejected by Reviewer ${loopStatus.count} times.\n` +
                    `Please review the feedback and provide clearer guidance.\n\n` +
                    `**Recent Reviewer feedback:**\n${content.slice(0, 500)}...`
                  );
                }
                
                try {
                  await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                  console.log(`[closedloop] Sent back to Local Builder for fixes`);
                } catch (err: any) {
                  console.error(`[closedloop] Failed to send back to Local Builder:`, err.message);
                }
              }
            }

            // Diff Guardian: final validation before PR creation
            if (agentId === AGENTS['diff guardian']) {
              const diffResult = await runDiffGuardian(issueId);

              if (diffResult.approved) {
                // Create PR after diff guardian approval
                try {
                  await createPullRequest(issueId);
                  console.log(`[closedloop] PR created after DiffGuardian approval`);
                  
                  // Reset loop counter on successful PR
                  resetLoopCounter(issueId);

                  // Trigger Visual Reviewer for visual audit
                  await patchIssue(issueId, { assigneeAgentId: AGENTS['visual reviewer'] });
                  console.log(`[closedloop] Auto-assigned to Visual Reviewer for feature recording`);
                } catch (prErr: any) {
                  console.error(`[closedloop] Failed to create PR:`, prErr.message);
                  await postComment(issueId, null, `_DiffGuardian approved but PR creation failed: ${prErr.message}_`);
                }
              } else {
                // Diff Guardian rejected - track loop
                const loopStatus = trackLoop(issueId, agentId);
                console.log(`[closedloop] DiffGuardian found issues (loop: ${loopStatus.count}/${MAX_LOOP_PASSES})`);
                
                // Diff Guardian sends back to Local Builder
                await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                console.log(`[closedloop] Sent back to Local Builder for fixes`);
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
    console.log(`[closedloop] :${proxyPort} -> ollama:${ollamaPort}`);
  });

  return server;
}

function getBridgeUrl(): string {
  const projectConfig = getConfig() as any;
  return projectConfig.closedloop?.bridgeUrl || 'http://localhost:3202';
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

      console.log(`[closedloop] Background check: ${agentName} has assigned issue ${issue.identifier || issue.id.slice(0, 8)}`);

      try {
        await patchIssue(issue.id, {
          assigneeAgentId: agentId,
          priority: issue.priority || 'medium',
        });
        recentAgentRuns.set(recentRunKey, Date.now());
        console.log(`[closedloop] Triggered wakeup for ${agentName} on ${issue.identifier || issue.id.slice(0, 8)}`);
      } catch (err: any) {
        console.log(`[closedloop] Failed to trigger ${agentName}: ${err.message}`);
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
  console.log('[closedloop] RAG index initialized');
}

