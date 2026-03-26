/**
 * ClosedLoop HTTP Server
 * 
 * Local-first, Ollama-powered proxy for Paperclip AI agents.
 * Handles communication between Paperclip agents and local Ollama instances.
 * Uses RAG for grounded, reliable code generation.
 */

import * as http from 'http';
import { getConfig, getOllamaPorts, getPaperclipApiUrl, getCompanyId, getAgentModel, getAgentKeys } from './config';
import { getAgentName, getIssueDetails, patchIssue, postComment, findAssignedIssue } from './paperclip-api';
import { AGENTS, BLOCKED_AGENTS, AGENT_NAMES, issueProcessingLock, issueBuilderPasses, issueBuilderBurstMode } from './agent-types';
import { isGoalIssue, scoreComplexity, decomposeGoalIntoTickets, checkGoalCompletion } from './goal-system';
import { callRemoteArchitect, callZAI } from './remote-ai';
import { extractIssueId, extractAgentId, sleep } from './utils';
import { applyCodeBlocks } from './code-extractor';
import { commitAndPush, createPullRequest } from './git-ops';
import { buildIssueContext, buildLocalBuilderContext, setRAGIndexer, getRAGIndexer } from './context-builder';
import { executeBashBlocks } from './bash-executor';
import { detectAndDelegate } from './delegation';
import { runArtistStage } from './artist-recorder';
import { runDiffGuardian } from './diff-guardian';
import {
  runExploration,
  handleReviewerSelection,
  isExploring,
  getExplorationState,
  parseApproachHints,
} from './exploration-orchestrator';
import { ragIndexer } from './rag-indexer';
import { generateTestsForFiles } from './test-writer';
import { OllamaRequest, OllamaResponse } from './types';

const { proxyPort, ollamaPort } = getOllamaPorts();
const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();

// Track recent agent runs to prevent spam
const recentAgentRuns = new Map<string, number>();
const DELEGATION_COOLDOWN_MS = 90 * 1000; // 90s — Paperclip deduplicates via wakeup API

// Track Reviewer ↔ Local Builder loops to prevent infinite cycles
// Key: issueId, Value: { count: number, lastReset: number, lastAgent: string }
const issueLoopCounts = new Map<string, { count: number; lastReset: number; lastAgent: string }>();
const MAX_LOOP_PASSES = 5; // Auto-create PR after 5 passes for human intervention
const LOOP_RESET_WINDOW_MS = 60 * 60 * 1000; // Reset count after 1 hour of no activity

/**
 * Track and detect Reviewer ↔ Local Builder loops
 * 
 * A "loop pass" is counted when we complete a full cycle:
 * Local Builder → Reviewer → (reject) → Local Builder
 * 
 * We track state transitions to avoid double-counting.
 * Returns true if loop exceeds MAX_LOOP_PASSES
 */
function trackLoop(issueId: string, agentId: string): { count: number; exceeded: boolean } {
  const now = Date.now();
  let loopData = issueLoopCounts.get(issueId);

  // Initialize or reset if window expired
  if (!loopData || now - loopData.lastReset > LOOP_RESET_WINDOW_MS) {
    loopData = { count: 0, lastReset: now, lastAgent: '' };
  }

  // Count a loop pass only when Reviewer rejects and sends back to Local Builder
  // This is detected when:
  // 1. Last agent was Reviewer, and current agent is Local Builder (Reviewer rejected)
  // 2. Last agent was Diff Guardian, and current agent is Local Builder (Diff Guardian rejected)
  const isLoopContinuation = 
    (loopData.lastAgent === AGENTS.reviewer && agentId === AGENTS['local builder']) ||
    (loopData.lastAgent === AGENTS['diff guardian'] && agentId === AGENTS['local builder']);

  if (isLoopContinuation) {
    loopData.count++;
    console.log(`[closedloop] Loop pass #${loopData.count} detected (Reviewer/DiffGuardian → Local Builder)`);
  }

  // Update last agent for next transition detection
  loopData.lastAgent = agentId;
  issueLoopCounts.set(issueId, loopData);

  return {
    count: loopData.count,
    exceeded: loopData.count >= MAX_LOOP_PASSES,
  };
}

/**
 * Get current loop status without modifying state
 * Used to check if loop exceeded before making decisions
 */
function getLoopStatus(issueId: string): { count: number; exceeded: boolean } {
  const loopData = issueLoopCounts.get(issueId);
  if (!loopData) {
    return { count: 0, exceeded: false };
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
    // High-complexity goals (score >= 7) → Epic Decoder (GLM-5)
    // Lower-complexity goals → Strategist (local)
    if (issueId && agentId === AGENTS['local builder']) {
      const builderIssue = await getIssueDetails(issueId);
      if (builderIssue && isGoalIssue(builderIssue)) {
        // Score complexity to decide routing
        const complexity = scoreComplexity(builderIssue.title, builderIssue.description || '');
        
        if (complexity.score >= 7) {
          // High complexity → Epic Decoder (GLM-5)
          console.log(`[closedloop] Goal guard: ${issueId.slice(0, 8)} complexity ${complexity.score}/10 → Epic Decoder`);
          await postComment(issueId, null, `_High-complexity goal detected (score: ${complexity.score}/10) — sending to Epic Decoder (GLM-5) for ticket decomposition._`);
          await patchIssue(issueId, { assigneeAgentId: AGENTS['epic decoder'] });
        } else {
          // Lower complexity → Strategist (local decomposition)
          console.log(`[closedloop] Goal guard: ${issueId.slice(0, 8)} complexity ${complexity.score}/10 → Strategist`);
          await postComment(issueId, null, `_Goal detected (score: ${complexity.score}/10) — sending to Strategist for decomposition._`);
          await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '_Redirected Goal issue for decomposition._' } }));
        return;
      }
    }

    // Hook 1b: Epic Decoder — decompose high-complexity goals using GLM-5
    if (issueId && agentId === AGENTS['epic decoder']) {
      console.log(`[closedloop] Epic Decoder processing high-complexity Goal ${issueId.slice(0, 8)}`);
      // Call epic-decoder module directly (uses GLM-5 via callZAI)
      setImmediate(async () => {
        try {
          const { decodeEpic } = await import('./epic-decoder');
          await decodeEpic(issueId);
        } catch (err: any) {
          console.error(`[closedloop] Epic Decoder failed: ${err.message}`);
        }
      });
    }

    // Hook 2: Burst model override for greenfield scaffold issues
    // When burst model is "remote", route to the remote API (glm-5) instead of Ollama
    if (agentId === AGENTS['local builder'] && issueId && issueBuilderBurstMode.has(issueId)) {
      const burstModel = getAgentModel('local builder burst');
      if (burstModel === 'remote') {
        console.log(`[closedloop] Burst mode: routing to REMOTE (glm-5) for ${issueId.slice(0, 8)}`);
        try {
          const issueContext =  await buildLocalBuilderContext(issueId, agentId);
          const messages = [...(parsedBody.messages || [])];
          if (issueContext) messages.push({ role: 'user', content: issueContext });
          const fullPrompt = messages.map((m: any) => `[${m.role}]: ${m.content}`).join('\n\n');
          const remoteResult = await callZAI(
            fullPrompt,
            'You are a senior full-stack engineer. Write production code. Output file contents using FILE: path/to/file.ext format followed by code blocks.'
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: remoteResult } }));
          return;
        } catch (err: any) {
          console.log(`[closedloop] Remote burst failed, falling back to local: ${err.message}`);
          // Fall through to local Ollama
        }
      } else if (burstModel) {
        parsedBody.model = burstModel;
        console.log(`[closedloop] Burst mode: using ${burstModel} for ${issueId.slice(0, 8)}`);
      }
    }

    // Hook 3: Coder Remote — route to GLM-5 via z.ai instead of Ollama
    if (agentId === AGENTS['coder remote'] && issueId) {
      console.log(`[proxy:${proxyPort}] Coder Remote -> GLM-5 (remote) | issue=${issueId.slice(0, 8)}`);
      try {
        const issueContext = await buildLocalBuilderContext(issueId, agentId);
        const messages = [...(parsedBody.messages || [])];
        if (issueContext) messages.push({ role: 'user', content: issueContext });
        const fullPrompt = messages.map((m: any) => `[${m.role}]: ${m.content}`).join('\n\n');
        const remoteResult = await callZAI(
          fullPrompt,
          'You are a senior full-stack engineer working on a TypeScript monorepo (Next.js + React Native + Cloudflare Workers). ' +
          'Write production-quality code. Output file contents using FILE: path/to/file.ext format followed by code blocks. ' +
          'Use Tamagui for styling (NO Tailwind, NO StyleSheet.create). Use fetcherWithToken from app/utils/fetcherWithToken for API calls.'
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: remoteResult } }));

        // Post-process: extract code blocks and commit like Local Builder
        setImmediate(async () => {
          try {
            const { written: writtenFiles, fileContents } = applyCodeBlocks(remoteResult);
            if (writtenFiles.length > 0) {
              const pass = (issueBuilderPasses[issueId] || 0) + 1;
              issueBuilderPasses[issueId] = pass;
              console.log(`[closedloop] Coder Remote wrote ${writtenFiles.length} files (pass ${pass})`);
              await commitAndPush(issueId, writtenFiles, fileContents);
              await postComment(issueId, agentId, `✅ Coder Remote (GLM-5) wrote ${writtenFiles.length} files (pass ${pass}).`);
            }
          } catch (err: any) {
            console.error(`[closedloop] Coder Remote post-process error: ${err.message}`);
          }
        });
        return;
      } catch (err: any) {
        console.error(`[closedloop] Coder Remote GLM-5 call failed: ${err.message}`);
        await postComment(issueId, agentId, `_Coder Remote (GLM-5) failed: ${err.message}. Falling back to Local Builder._`);
        // Fallback: reassign to local builder
        await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '_GLM-5 unavailable, reassigned to Local Builder._' } }));
        return;
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

    // Build Ollama payload — use our configured model, not Paperclip's adapter template
    const agentNameKey = AGENT_NAMES[agentId || '']?.toLowerCase() || '';
    const configuredModel = agentNameKey ? getAgentModel(agentNameKey) : null;
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
            // Don't post CR output as comments — it pollutes the issue
            if (agentId !== AGENTS['complexity router']) {
              await postComment(issueId, agentId, content.trim());
            }

            // Detect delegation and reassign via API (triggers auto-wakeup)
            if (agentId) {
              // Hook: Tech Lead [EXPLORE] triggers parallel worktree exploration
              if (agentId === AGENTS['tech lead'] && content.includes('[EXPLORE]')) {
                const approaches = parseApproachHints(content);
                if (approaches) {
                  console.log(`[closedloop] Tech Lead requested exploration with ${approaches.length} approaches`);
                  setImmediate(async () => {
                    const result = await runExploration(issueId, approaches);
                    if (result.status === 'merged') {
                      // Auto-selected or single passing approach — continue to Reviewer
                      await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                    } else if (result.status === 'comparing') {
                      // Multiple passing approaches — Reviewer needs to compare
                      await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                    } else if (result.status === 'failed') {
                      // All failed — send back to Tech Lead
                      await patchIssue(issueId, { assigneeAgentId: AGENTS['tech lead'] });
                    }
                  });
                  // Skip normal delegation since we're handling it
                } else {
                  await detectAndDelegate(issueId, agentId, content);
                }
              } else {
                await detectAndDelegate(issueId, agentId, content);
              }
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
                  // Mark for parallel exploration when it reaches the builder
                  console.log(`[closedloop] Issue ${issueId.slice(0, 8)} marked for parallel exploration (score: ${complexity.score})`);
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

                    // Pre-flight import validation (catch hallucinated packages before build)
                    try {
                      const { validateImports, formatValidationResult } = await import('./import-validator');
                      const filesToValidate = writtenFiles.map(f => ({
                        path: f,
                        content: fileContents[f] || '',
                      }));
                      const validation = validateImports(filesToValidate);
                      
                      if (!validation.valid) {
                        console.log(`[closedloop] Import validation FAILED - ${validation.errors.length} errors`);
                        await postComment(
                          issueId,
                          AGENTS['local builder'],
                          `⚠️ **Import Validation Failed**\n\n` +
                          formatValidationResult(validation) +
                          `\n**Please fix these imports before proceeding:**\n` +
                          `- Remove or replace hallucinated packages\n` +
                          `- Use existing packages from package.json\n` +
                          `- Common alternatives:\n` +
                          `  - Instead of 'ky' → use 'fetcherWithToken' from app/utils/fetcherWithToken\n` +
                          `  - Instead of 'axios' → use native 'fetch'\n` +
                          `  - Instead of 'lodash' → use native array methods`
                        );
                        await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                        issueProcessingLock[issueId] = false;
                        return;
                      }
                      
                      if (validation.warnings.length > 0) {
                        console.log(`[closedloop] Import validation warnings: ${validation.warnings.length}`);
                      }
                    } catch (err: any) {
                      console.log(`[closedloop] Import validation skipped: ${err.message}`);
                    }

                    // Commit, push, and check build result
                    const buildResult = await commitAndPush(issueId, writtenFiles, fileContents);

                    // If build failed, send back to Local Builder to fix FIRST
                    if (!buildResult.success) {
                      console.log(`[closedloop] Build FAILED - saving to tried-approaches memory`);
                      
                      // Get issue details for identifier
                      const issueDetails = await getIssueDetails(issueId);
                      const issueIdentifier = issueDetails?.identifier || issueId.slice(0, 8);
                      
                      // Save this failed attempt to global memory
                      try {
                        const { saveTriedApproach } = await import('./tried-approaches');
                        await saveTriedApproach(issueId, issueIdentifier, writtenFiles, buildResult.output || 'Build failed');
                        console.log(`[closedloop] Saved failed attempt to global memory`);
                      } catch (err: any) {
                        console.log(`[closedloop] Failed to save tried-approaches: ${err.message}`);
                      }
                      
                      await postComment(
                        issueId,
                        AGENTS['local builder'],
                        `⚠️ **Build Failed - Fix Before Review**\n\n` +
                        `Your code committed successfully but the build failed. Please fix the build errors before sending to Reviewer.\n\n` +
                        `\`\`\`\n${buildResult.output || 'Build error output not available'}\n\`\`\`\n\n` +
                        `**Action required:**\n` +
                        `1. Run \`yarn build\` locally to see full errors\n` +
                        `2. Fix the build errors in the files you just wrote\n` +
                        `3. Re-commit and the build will be verified again\n\n` +
                        `**Note:** This failed attempt has been saved to GLOBAL memory. Other tickets working on similar files will learn from this error.`
                      );
                      await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                      console.log(`[closedloop] Sent back to Local Builder for build fixes`);
                    } else {
                      // Build passed — generate tests for written files before Reviewer
                      try {
                        const testResult = await generateTestsForFiles(issueId, writtenFiles, fileContents);
                        if (testResult.filesWritten.length > 0) {
                          console.log(`[closedloop] Test Writer generated ${testResult.filesWritten.length} test files`);
                          // Commit test files on the same branch
                          await commitAndPush(issueId, testResult.filesWritten, testResult.fileContents);
                        }
                      } catch (testErr: any) {
                        console.log(`[closedloop] Test generation skipped: ${testErr.message}`);
                      }

                      // Check current loop status before sending to Reviewer
                      const loopStatus = getLoopStatus(issueId);
                      
                      // If loop already exceeded before this pass, skip to PR
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

            // Reviewer: handle exploration comparison if issue is in exploration mode
            if (agentId === AGENTS.reviewer && isExploring(issueId)) {
              const { handled, merged } = await handleReviewerSelection(issueId, content);
              if (handled) {
                if (merged) {
                  // Winner merged — continue normal flow to Reviewer for final review
                  console.log(`[closedloop] Exploration winner merged — sending to Reviewer for final review`);
                  await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                } else {
                  // Rejected or unparseable — send back to Tech Lead
                  const state = getExplorationState(issueId);
                  if (!state || state.status === 'failed') {
                    await patchIssue(issueId, { assigneeAgentId: AGENTS['tech lead'] });
                  }
                }
              }
            }

            // Reviewer: validate changes and approve/reject before PR creation
            if (agentId === AGENTS.reviewer && !isExploring(issueId)) {
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
                // Reviewer rejected - send back to Local Builder
                console.log(`[closedloop] Reviewer found issues - saving to reflection memory`);

                // Save reviewer feedback to reflection memory
                try {
                  const { extractAndSaveReflections } = await import('./reflection-memory');
                  const { getIssueComments } = await import('./paperclip-api');
                  // Get the files from recent builder commits (approximate from recent comments)
                  const recentComments = await getIssueComments(issueId);
                  const fileRegex = /`([\w./\\-]+\.(tsx?|json))`/g;
                  const filesChanged = new Set<string>();
                  
                  for (const comment of recentComments.slice(0, 10)) {
                    if (comment.body.includes('committed') || comment.body.includes('FILE:')) {
                      const matches = comment.body.matchAll(fileRegex);
                      for (const match of matches) {
                        filesChanged.add(match[1]);
                      }
                    }
                  }
                  
                  await extractAndSaveReflections(issueId, Array.from(filesChanged));
                  console.log(`[closedloop] Saved reviewer feedback to reflection memory`);
                } catch (err: any) {
                  console.log(`[closedloop] Failed to save reflections: ${err.message}`);
                }

                // Check if loop exceeded — skip to PR instead of bouncing back
                const loopStatus = getLoopStatus(issueId);
                if (loopStatus.exceeded) {
                  console.log(`[closedloop] LOOP EXCEEDED (${loopStatus.count}) during Reviewer rejection — skipping to PR`);
                  await postComment(
                    issueId,
                    null,
                    `⚠️ **Review Loop Capped (${loopStatus.count}/${MAX_LOOP_PASSES}) — Creating PR for human review**\n\n` +
                    `Builder and Reviewer couldn't converge. Shipping as-is for manual review.\n\n` +
                    `**Last Reviewer feedback:**\n${content.slice(0, 500)}...`
                  );
                  try {
                    await createPullRequest(issueId);
                    resetLoopCounter(issueId);
                    console.log(`[closedloop] PR created after loop cap`);
                  } catch (prErr: any) {
                    console.error(`[closedloop] Failed to create PR after loop cap:`, prErr.message);
                  }
                } else {
                  try {
                    await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                    console.log(`[closedloop] Sent back to Local Builder for fixes`);
                  } catch (err: any) {
                    console.error(`[closedloop] Failed to send back to Local Builder:`, err.message);
                  }
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

                  // Mark issue as in_review to stop further agent processing
                  await patchIssue(issueId, { status: 'in_review' });
                  console.log(`[closedloop] Issue marked in_review`);

                  // Reset loop counter on successful PR
                  resetLoopCounter(issueId);

                  // Hook 7: Goal completion check after PR creation
                  await checkGoalCompletion(issueId);
                } catch (prErr: any) {
                  console.error(`[closedloop] Failed to create PR:`, prErr.message);
                  await postComment(issueId, null, `_DiffGuardian approved but PR creation failed: ${prErr.message}_`);
                }
              } else {
                // Diff Guardian rejected - send back to Local Builder
                const loopStatus = getLoopStatus(issueId);
                console.log(`[closedloop] DiffGuardian found issues (loop: ${loopStatus.count}/${MAX_LOOP_PASSES})`);

                // Check if loop exceeded
                if (loopStatus.exceeded) {
                  console.log(`[closedloop] LOOP EXCEEDED (${loopStatus.count}) during DiffGuardian rejection — skipping to PR`);
                  await postComment(
                    issueId,
                    null,
                    `⚠️ **Review Loop Capped (${loopStatus.count}/${MAX_LOOP_PASSES}) — Creating PR for human review**\n\n` +
                    `Builder and DiffGuardian couldn't converge. Shipping as-is for manual review.\n\n` +
                    `**DiffGuardian findings:** See previous comments.`
                  );
                  try {
                    await createPullRequest(issueId);
                    resetLoopCounter(issueId);
                    console.log(`[closedloop] PR created after loop cap`);
                  } catch (prErr: any) {
                    console.error(`[closedloop] Failed to create PR after loop cap:`, prErr.message);
                  }
                } else {
                  // Diff Guardian sends back to Local Builder
                  await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                  console.log(`[closedloop] Sent back to Local Builder for fixes`);
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
  const agentKeys = getAgentKeys();

  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { issues?: any[]; data?: any[] };
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

    const assignedIssues = issues.filter(
      (i: any) => (i.status === 'todo' || i.status === 'in_progress') && i.assigneeAgentId
    );

    // Group issues by agent — one wakeup per agent, not per issue
    const agentIssueMap = new Map<string, string[]>();
    for (const issue of assignedIssues) {
      const agentId = issue.assigneeAgentId;
      if (BLOCKED_AGENTS.has(agentId)) continue;

      const recentRunKey = `${agentId}:${issue.id}`;
      if (recentAgentRuns.has(recentRunKey)) {
        const lastRun = recentAgentRuns.get(recentRunKey)!;
        if (Date.now() - lastRun < DELEGATION_COOLDOWN_MS) continue;
      }

      if (!agentIssueMap.has(agentId)) agentIssueMap.set(agentId, []);
      agentIssueMap.get(agentId)!.push(issue.identifier || issue.id.slice(0, 8));
    }

    for (const [agentId, issueIds] of agentIssueMap.entries()) {
      const agentName = AGENT_NAMES[agentId] || 'unknown';
      const apiKey = agentKeys[agentId];

      console.log(`[closedloop] Waking ${agentName} for ${issueIds.length} issues: ${issueIds.join(', ')}`);

      try {
        // Use the proper Paperclip wakeup API instead of re-patching the issue
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const wakeRes = await fetch(`${PAPERCLIP_API}/api/agents/${agentId}/wakeup`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source: 'automation',
            triggerDetail: 'system',
            reason: 'assigned_issues_pending',
          }),
        });

        if (wakeRes.ok) {
          const wakeData = await wakeRes.json() as any;
          // Mark all issues for this agent as recently triggered
          for (const issue of assignedIssues.filter((i: any) => i.assigneeAgentId === agentId)) {
            recentAgentRuns.set(`${agentId}:${issue.id}`, Date.now());
          }
          console.log(`[closedloop] Wakeup ${wakeData.status || 'sent'} for ${agentName} (run: ${(wakeData.id || '').slice(0, 8)})`);
        } else {
          const errText = await wakeRes.text();
          console.log(`[closedloop] Wakeup failed for ${agentName}: ${wakeRes.status} ${errText.slice(0, 200)}`);
        }
      } catch (err: any) {
        console.log(`[closedloop] Failed to wake ${agentName}: ${err.message}`);
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
