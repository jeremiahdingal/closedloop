/**
 * ClosedLoop HTTP Server
 * 
 * Local-first, Ollama-powered proxy for Paperclip AI agents.
 * Handles communication between Paperclip agents and local Ollama instances.
 * Uses RAG for grounded, reliable code generation.
 */

import * as http from 'http';
import { getConfig, getOllamaPorts, getPaperclipApiUrl, getCompanyId, getAgentModel } from './config';
import { getAgentName, getIssueDetails, patchIssue, postComment, findAssignedIssue } from './paperclip-api';
import { AGENTS, BLOCKED_AGENTS, AGENT_NAMES, issueProcessingLock, issueBuilderPasses, issueBuilderBurstMode } from './agent-types';
import { isGoalIssue, scoreComplexity, decomposeGoalIntoTickets, checkGoalCompletion } from './goal-system';
import { callRemoteArchitect } from './remote-ai';
import { extractIssueId, extractAgentId, sleep } from './utils';
import { applyCodeBlocks } from './code-extractor';
import { commitAndPush, createPullRequest } from './git-ops';
import { buildIssueContext, buildLocalBuilderContext, setRAGIndexer, getRAGIndexer } from './context-builder';
import { executeBashBlocks } from './bash-executor';
import { detectAndDelegate } from './delegation';
import { runArtistStage } from './artist-recorder';
import { runDiffGuardian } from './diff-guardian';
import { ragIndexer } from './rag-indexer';
import { OllamaRequest, OllamaResponse } from './types';

const { proxyPort, ollamaPort } = getOllamaPorts();
const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();

// Track recent agent runs to prevent spam
const recentAgentRuns = new Map<string, number>();
const DELEGATION_COOLDOWN_MS = 5 * 60 * 1000;

// Track Reviewer ↔ Local Builder loops to prevent infinite cycles
// Key: issueId, Value: { count: number, lastReset: number }
const issueLoopCounts = new Map<string, { count: number; lastReset: number }>();
const MAX_LOOP_PASSES = 20; // Auto-create PR after 20 passes for human intervention
const LOOP_RESET_WINDOW_MS = 60 * 60 * 1000; // Reset count after 1 hour of no activity

/**
 * Track and detect Reviewer ↔ Local Builder loops
 * Returns true if loop exceeds MAX_LOOP_PASSES
 */
function trackLoop(issueId: string, agentId: string): { count: number; exceeded: boolean } {
  const now = Date.now();
  let loopData = issueLoopCounts.get(issueId);

  // Initialize or reset if window expired
  if (!loopData || now - loopData.lastReset > LOOP_RESET_WINDOW_MS) {
    loopData = { count: 0, lastReset: now };
  }

  // Increment on Reviewer → Local Builder handoff
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
        console.log(`[closedloop] Skipping ${agentName} — issue ${issueId.slice(0, 8)} is ${issueState.status}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: `_Issue is ${issueState.status}, no action needed._` },
          })
        );
        return;
      }
    }

    // Hook 1: Goal guard — prevent Local Builder from directly handling Goal/Epic issues
    if (issueId && agentId === AGENTS['local builder']) {
      const builderIssue = await getIssueDetails(issueId);
      if (builderIssue && isGoalIssue(builderIssue)) {
        console.log(`[closedloop] Goal guard: redirecting Goal issue ${issueId.slice(0, 8)} away from Local Builder`);
        await postComment(issueId, null, '_Goal/Epic issue detected — redirecting to Complexity Router for decomposition._');
        const routerTarget = AGENTS['complexity router'] || AGENTS.strategist;
        await patchIssue(issueId, { assigneeAgentId: routerTarget });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '_Redirected Goal issue to Complexity Router._' } }));
        return;
      }
    }

    // Hook 2: Burst model override for greenfield scaffold issues
    if (agentId === AGENTS['local builder'] && issueId && issueBuilderBurstMode.has(issueId)) {
      const burstModel = getAgentModel('local builder burst');
      if (burstModel) {
        parsedBody.model = burstModel;
        console.log(`[closedloop] Burst mode: using ${burstModel} for ${issueId.slice(0, 8)}`);
      }
    }

    // Visual Reviewer bypasses Ollama and runs deterministic recorder
    if (issueId && agentId === AGENTS['visual reviewer']) {
      console.log(`[proxy:${proxyPort}] ${agentName} -> feature recorder | issue=${issueId.slice(0, 8)}`);
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

    // Build Ollama payload — use our configured model, not the Paperclip adapter template
    const configuredModel = agentId ? getAgentModel(AGENT_NAMES[agentId]?.toLowerCase() || '') : null;
    const ollamaPayload: OllamaRequest = {
      model: configuredModel || parsedBody.model,
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
            // Complexity Router output is routing metadata — don't pollute issue comments
            if (agentId !== AGENTS['complexity router']) {
              await postComment(issueId, agentId, content.trim());
            }

            // Detect delegation and reassign via API (triggers auto-wakeup)
            if (agentId) {
              await detectAndDelegate(issueId, agentId, content);
            }

            // Hook 3: Complexity Router post-response — score issue and route
            if (agentId === AGENTS['complexity router'] && issueId) {
              const routerIssue = await getIssueDetails(issueId);
              if (routerIssue) {
                const complexity = scoreComplexity(routerIssue.title, routerIssue.description || '');
                console.log(`[closedloop] Complexity Router scored ${issueId.slice(0, 8)}: ${complexity.score}/10 [${complexity.signals.join(', ')}]`);
                if (complexity.score >= 7) {
                  // Complex issue — call Remote Architect then hand to Strategist
                  await callRemoteArchitect(issueId, routerIssue);
                }
                // Always route to Strategist after scoring
                await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
                console.log(`[closedloop] Complexity Router -> Strategist`);
              }
            }

            // Hook 4: Strategist Goal decomposition — parse ## Ticket: blocks
            if (agentId === AGENTS.strategist && issueId) {
              const stratIssue = await getIssueDetails(issueId);
              if (stratIssue && isGoalIssue(stratIssue) && content.includes('## Ticket:')) {
                console.log(`[closedloop] Strategist produced ticket decomposition for Goal ${issueId.slice(0, 8)}`);
                await decomposeGoalIntoTickets(issueId, content);
              }
            }

            // Local Builder: extract code blocks, write files, commit (no PR yet)
            if (agentId === AGENTS['local builder']) {
              if (issueProcessingLock[issueId]) {
                console.log(`[closedloop] Skipping duplicate Local Builder run for ${issueId.slice(0, 8)} (already processing)`);
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
                    console.log(`[closedloop] Local Builder wrote ${writtenFiles.length} files (pass ${pass})`);

                    // Commit, push, and check build result
                    const buildResult = await commitAndPush(issueId, writtenFiles, fileContents);

                    // Track Reviewer ↔ Local Builder loops
                    const loopStatus = trackLoop(issueId, agentId);
                    console.log(`[closedloop] Loop count: ${loopStatus.count}/${MAX_LOOP_PASSES}`);

                    // If build failed, send back to Local Builder to fix FIRST
                    if (!buildResult.success) {
                      // Check loop count even on build failure to prevent infinite loops
                      if (loopStatus.exceeded) {
                        console.log(`[closedloop] LOOP EXCEEDED on build failure (${loopStatus.count}) - Creating PR for human intervention`);
                        await postComment(
                          issueId,
                          null,
                          `⚠️ **Build Loop Exceeded (${loopStatus.count} passes)**\n\n` +
                          `Build has failed repeatedly. Creating PR for human intervention.\n\n` +
                          `Last error:\n\`\`\`\n${(buildResult.output || '').slice(0, 500)}\n\`\`\``
                        );
                        try {
                          await createPullRequest(issueId);
                          resetLoopCounter(issueId);
                          console.log(`[closedloop] PR created for human intervention (build failures)`);
                        } catch (prErr: any) {
                          console.error(`[closedloop] Failed to create PR:`, prErr.message);
                        }
                        await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                      } else {
                        console.log(`[closedloop] Build FAILED (pass ${loopStatus.count}) - sending back to Local Builder`);
                        await postComment(
                          issueId,
                          AGENTS['local builder'],
                          `⚠️ **Build Failed - Fix Before Review**\n\n` +
                          `Your code committed successfully but the build failed. Please fix the build errors before sending to Reviewer.\n\n` +
                          `\`\`\`\n${buildResult.output || 'Build error output not available'}\n\`\`\`\n\n` +
                          `**Action required:**\n` +
                          `1. Run \`yarn build\` locally to see full errors\n` +
                          `2. Fix the build errors in the files you just wrote\n` +
                          `3. Re-commit and the build will be verified again`
                        );
                        await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                        console.log(`[closedloop] Sent back to Local Builder for build fixes`);
                      }
                    } else {
                      // Build passed - continue with normal flow
                      // Check if loop exceeded - auto create PR for human intervention
                      if (loopStatus.exceeded) {
                        console.log(`[closedloop] LOOP EXCEEDED (${loopStatus.count}) - Creating PR for human intervention`);
                        await postComment(
                          issueId,
                          null,
                          `⚠️ **Auto-PR Created: Review Loop Exceeded**\n\n` +
                          `This issue has gone through ${loopStatus.count} Reviewer ↔ Local Builder cycles.\n` +
                          `A human developer should now review the changes.\n\n` +
                          `**What happened:**\n` +
                          `- Local Builder and Reviewer couldn't reach agreement after ${loopStatus.count} passes\n` +
                          `- This may indicate:\n` +
                          `  - Complex requirements needing clarification\n` +
                          `  - Conflicting feedback between agents\n` +
                          `  - Technical debt in existing codebase\n\n` +
                          `**Next steps:**\n` +
                          `1. Review the PR and comment history\n` +
                          `2. Manually resolve any remaining issues\n` +
                          `3. Merge when ready\n`
                        );
                        try {
                          await createPullRequest(issueId);
                          resetLoopCounter(issueId);
                          console.log(`[closedloop] PR created for human intervention`);
                          // Still send to Reviewer for final approval
                          await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                        } catch (prErr: any) {
                          console.error(`[closedloop] Failed to create PR:`, prErr.message);
                        }
                        // Skip normal flow - already sent to Reviewer
                      } else {
                        // Normal flow: Send to Reviewer
                        console.log(`[closedloop] Pass ${pass}: Sending to Reviewer...`);
                        try {
                          await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                          console.log(`[closedloop] Auto-assigned to Reviewer`);
                        } catch (err: any) {
                          console.error(`[closedloop] Failed to trigger Reviewer:`, err.message);
                        }
                      }
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

              // After executing bash commands, re-prompt the agent (but NOT Strategist —
              // Strategist should delegate, not loop on bash output)
              if (commandsWereExecuted && agentId !== AGENTS['local builder'] && agentId !== AGENTS.strategist) {
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
              const reviewApproved =
                content.toLowerCase().includes('approved') ||
                content.toLowerCase().includes('looks good') ||
                content.toLowerCase().includes('lgtm') ||
                content.toLowerCase().includes('no issues') ||
                content.toLowerCase().includes('ready for pr');

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
                    `⚠️ **Review Loop Exceeded - Manual Review Required**\n\n` +
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

                  // Mark issue as in_review to stop further processing
                  await patchIssue(issueId, { status: 'in_review', assigneeAgentId: AGENTS['visual reviewer'] } as any);
                  console.log(`[closedloop] Issue marked in_review, assigned to Visual Reviewer`);

                  // Hook 7: Goal completion check after PR creation
                  await checkGoalCompletion(issueId);
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
