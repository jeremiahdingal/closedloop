/**
 * ClosedLoop HTTP Server
 * 
 * Local-first, Ollama-powered proxy for Paperclip AI agents.
 * Handles communication between Paperclip agents and local Ollama instances.
 * Uses RAG for grounded, reliable code generation.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import {
  getConfig,
  getOllamaPorts,
  getPaperclipApiUrl,
  getCompanyId,
  getAgentModel,
  getAgentKeys,
  getWorkspace,
  getStylingPolicy,
} from './config';
import { getAgentName, getIssueDetails, patchIssue, postComment, findAssignedIssue, findAssignedIssues, getIssueLabel, wakeAgent } from './paperclip-api';
import { AGENTS, BLOCKED_AGENTS, AGENT_NAMES, issueProcessingLock, issueBuilderPasses, issueBuilderBurstMode, issueImportFailures } from './agent-types';
import { isGoalIssue, scoreComplexity, decomposeGoalIntoTickets, checkGoalCompletion, getEpicTickets, enforceGoalOverlapSuppression, getOverlapBlockForTicket } from './goal-system';
import { callRemoteArchitect, callRemoteLLM, callModelCLI } from './remote-ai';
import { extractIssueId, extractAgentId, sleep } from './utils';
import { applyCodeBlocks } from './code-extractor';
import { commitAndPush, createPullRequest, getBranchName } from './git-ops';
import { buildIssueContext, buildLocalBuilderContext, setRAGIndexer, getRAGIndexer } from './context-builder';
import { executeBashBlocks } from './bash-executor';
import { writeIssueContext } from './pre-execution';
import { detectAndDelegate } from './delegation';
import { runArtistStage } from './artist-recorder';
import { runDiffGuardian } from './diff-guardian';
import { runDriftPrecommit } from './ticket-constraints';
import { parseReviewVerdict } from './agent-contracts';
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
const issueBuildFailures = new Map<string, { count: number; lastReset: number }>();
const MAX_LOOP_PASSES = 5; // Auto-create PR after 5 passes for human intervention
const MAX_BUILDER_PASSES = 5; // Hard-stop Local Builder drift after 5 write passes
const MAX_BUILD_FAILURES = 4;
const LOOP_RESET_WINDOW_MS = 60 * 60 * 1000; // Reset count after 1 hour of no activity
const telemetryCounters = {
  driftBlockedWrites: 0,
};
const LOCAL_BUILDER_CONTEXT_CHAR_LIMIT = 14000;

function buildStylingInstructionSentence(): string {
  const styling = getStylingPolicy();
  const parts: string[] = [`Use ${styling.framework} for styling.`];
  if (styling.guidance) parts.push(styling.guidance);
  if (styling.required.length > 0) parts.push(`Preferred styling imports: ${styling.required.join(', ')}.`);
  if (styling.forbidden.length > 0) parts.push(`Avoid: ${styling.forbidden.join(', ')}.`);
  return parts.join(' ');
}

function buildImportFixGuidance(): string {
  const styling = getStylingPolicy();
  const requiredStylingLines =
    styling.required.length > 0
      ? styling.required.map((entry) => `   - ${entry}`).join('\n')
      : `   - Follow ${styling.framework} project conventions`;
  const forbiddenStylingLines =
    styling.forbidden.length > 0
      ? styling.forbidden.map((entry) => `   - ❌ ${entry}`).join('\n')
      : '   - ❌ Do not introduce unapproved styling frameworks';

  return `**💡 How to fix these import errors:**\n\n` +
    `1. **Check package.json** - Only import packages that exist in:\n` +
    `   - \`packages/app/package.json\` (for app code)\n` +
    `   - \`packages/ui/package.json\` (for ui code)\n\n` +
    `2. **Styling rules for this project (${styling.framework}):**\n` +
    `   - ${styling.guidance}\n` +
    `${requiredStylingLines}\n` +
    `${forbiddenStylingLines}\n\n` +
    `3. **Data/API patterns:**\n` +
    `   - Fetch: Use \`fetcherWithToken\` from \`app/utils/fetcherWithToken\`\n` +
    `   - ❌ 'ky' → ✅ Use \`fetcherWithToken\`\n` +
    `   - ❌ 'axios' → ✅ Use native \`fetch\` or \`fetcherWithToken\`\n` +
    `   - ❌ 'lodash' → ✅ Use native array methods (.map, .filter, etc.)\n\n` +
    `4. **Relative imports** - For local files use \`../\` paths:\n` +
    `   - \`import { X } from '../types/db.types'\`\n` +
    `   - \`import { fetcherWithToken } from 'app/utils/fetcherWithToken'\`\n\n`;
}

function parseReviewerVerdictStrict(content: string): 'APPROVED' | 'CHANGES_REQUESTED' | 'AMBIGUOUS' {
  if (/VERDICT:\s*APPROVED\b/i.test(content)) return 'APPROVED';
  if (/VERDICT:\s*(?:CHANGES_REQUESTED|REJECTED)\b/i.test(content)) return 'CHANGES_REQUESTED';

  // Allow explicit structured JSON contract, but reject free-text ambiguity.
  if (/"decision"\s*:\s*"(approved|rejected)"/i.test(content)) {
    const parsed = parseReviewVerdict(content);
    if (parsed?.decision === 'approved') return 'APPROVED';
    if (parsed?.decision === 'rejected') return 'CHANGES_REQUESTED';
  }

  return 'AMBIGUOUS';
}

function trimLocalBuilderContextIfNeeded(agentId: string | null, issueContext: string): string {
  if (agentId !== AGENTS['local builder']) return issueContext;
  if (issueContext.length <= LOCAL_BUILDER_CONTEXT_CHAR_LIMIT) return issueContext;

  const trimmed = issueContext.slice(0, LOCAL_BUILDER_CONTEXT_CHAR_LIMIT);
  const note =
    `\n\n[closedloop] Context truncated to ${LOCAL_BUILDER_CONTEXT_CHAR_LIMIT} chars for Local Builder to avoid adapter timeout.` +
    `\nAsk for specific file context if more detail is needed.`;
  return `${trimmed}${note}`;
}

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

function trackBuildFailure(issueId: string): { count: number; exceeded: boolean } {
  const now = Date.now();
  let failureData = issueBuildFailures.get(issueId);
  if (!failureData || now - failureData.lastReset > LOOP_RESET_WINDOW_MS) {
    failureData = { count: 0, lastReset: now };
  }

  failureData.count++;
  issueBuildFailures.set(issueId, failureData);
  return {
    count: failureData.count,
    exceeded: failureData.count >= MAX_BUILD_FAILURES,
  };
}

function resetBuildFailureCounter(issueId: string): void {
  issueBuildFailures.delete(issueId);
}

/**
 * Reset loop counter for an issue (e.g., after successful PR)
 */
function resetLoopCounter(issueId: string): void {
  issueLoopCounts.delete(issueId);
}

async function wakeAgentForNextAssignedIssue(agentId: string, completedIssueId?: string): Promise<void> {
  if (!agentId || BLOCKED_AGENTS.has(agentId)) return;

  const currentIssue = completedIssueId ? await getIssueDetails(completedIssueId) : null;
  if (currentIssue && currentIssue.assigneeAgentId === agentId) {
    return;
  }

  const remainingIssues = await findAssignedIssues(agentId);
  const nextIssue = remainingIssues.find((issue) => issue.id !== completedIssueId);
  if (!nextIssue) return;

  const recentRunKey = `${agentId}:${nextIssue.id}`;
  const lastRun = recentAgentRuns.get(recentRunKey);
  if (lastRun && Date.now() - lastRun < DELEGATION_COOLDOWN_MS) {
    return;
  }

  const agentName = AGENT_NAMES[agentId] || 'unknown';
  const apiKey = getAgentKeys()[agentId];

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // Write context file and INSTRUCTIONS.md for the follow-up issue
    try {
      const workspace = getWorkspace();
      
      // Write .closedloop/context.json with existing files
      await writeIssueContext(nextIssue.id);
      
      const instructionsContent = [
        `# Agent Instructions`,
        ``,
        `**Agent:** ${agentName}`,
        `**Wake reason:** next_assigned_issue_pending`,
        `**Timestamp:** ${new Date().toISOString()}`,
        ``,
        `## Assigned Issue`,
        ``,
        `### ${nextIssue.identifier || nextIssue.id.slice(0, 8)}: ${nextIssue.title || '(no title)'}`,
        ``,
        `- **ID:** ${nextIssue.id}`,
        `- **Status:** ${nextIssue.status || 'unknown'}`,
        `- **Priority:** ${nextIssue.priority || 'normal'}`,
        ``,
        String(nextIssue.description || '(no description)').trim().slice(0, 2000),
        ``,
        `## Instructions`,
        ``,
        `Process the assigned issue above. Read the workspace files directly.`,
        `Do not ask for pasted content — use the filesystem.`,
      ].join('\n');
      fs.writeFileSync(path.join(workspace, 'INSTRUCTIONS.md'), instructionsContent, 'utf8');
    } catch {}

    const wakeRes = await fetch(`${PAPERCLIP_API}/api/agents/${agentId}/wakeup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'assignment',
        triggerDetail: 'system',
        reason: `next_assigned_issue_pending:${nextIssue.identifier || nextIssue.id.slice(0, 8)}`,
        issueId: nextIssue.id,
        taskId: nextIssue.id,
      }),
    });

    if (!wakeRes.ok) {
      const errText = await wakeRes.text();
      console.log(`[closedloop] Follow-up wakeup failed for ${agentName}: ${wakeRes.status} ${errText.slice(0, 200)}`);
      return;
    }

    recentAgentRuns.set(recentRunKey, Date.now());
    console.log(`[closedloop] Follow-up wakeup sent to ${agentName} for ${nextIssue.identifier || nextIssue.id.slice(0, 8)}`);
  } catch (err: any) {
    console.log(`[closedloop] Failed follow-up wakeup for ${agentName}: ${err.message}`);
  }
}

async function stopOnBuilderPassCap(issueId: string, passCount: number): Promise<void> {
  await postComment(
    issueId,
    null,
    `[DRIFT] ⚠️ **Auto-PR Created: Local Builder Pass Cap Reached**\n\n` +
    `This ticket reached ${passCount} Local Builder passes, which is above the safe drift threshold.\n\n` +
    `**Why it was stopped early:**\n` +
    `- Too many repeated local rewrites without convergence\n` +
    `- Risk of duplicate implementations and architecture drift\n` +
    `- Escalating now so a human or Epic Reviewer can reconcile the branch safely\n`
  );

  try {
    await createPullRequest(issueId);
    resetLoopCounter(issueId);
    resetBuildFailureCounter(issueId);
    await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
    await checkGoalCompletion(issueId);
    console.log(`[closedloop] PR created after Local Builder pass cap (${passCount}/${MAX_BUILDER_PASSES})`);
  } catch (prErr: any) {
    console.error(`[closedloop] Failed to create PR after Local Builder pass cap:`, prErr.message);
    if (!String(prErr.message || '').includes('[PR_PREFLIGHT_FAILED]')) {
      await postComment(issueId, null, `_Local Builder pass cap reached but PR creation failed: ${prErr.message}_`);
    }
  }
}

export function createProxy(): http.Server {
  const server = http.createServer(async (req, res) => {
    // Endpoint: POST /api/trigger-epic-review
    if (req.method === 'POST' && req.url === '/api/trigger-epic-review') {
      console.log(`[closedloop] Manual epic review trigger requested`);
      try {
        const woke = await wakeAgent(AGENTS['epic reviewer'], 'manual_epic_review_trigger', 'on_demand');
        if (!woke) {
          throw new Error('Failed to wake Epic Reviewer agent');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Epic Reviewer agent woken' }));
      } catch (err: any) {
        console.error(`[closedloop] Epic review trigger failed: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Endpoint: POST /api/decode-epic/:goalId
    if (req.method === 'POST' && req.url?.startsWith('/api/decode-epic/')) {
      const goalId = req.url.split('/').pop();
      if (!goalId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Goal ID required' }));
        return;
      }
      console.log(`[closedloop] Manual epic decode trigger for ${goalId}`);
      try {
        const { decodeEpic } = await import('./epic-decoder');
        const result = await decodeEpic(goalId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', decomposed: result, goalId }));
      } catch (err: any) {
        console.error(`[closedloop] Epic decode trigger failed: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

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
        console.log(`[closedloop] Auto-resolved issue for ${agentName}: ${await getIssueLabel(issueId)}`);
      }
    }

    // SECOND GUARD: Re-check issue status after auto-resolution
    // This catches cases where Paperclip sends a done issue or findAssignedIssue returns stale data
    if (issueId && agentId) {
      try {
        const issueState = await getIssueDetails(issueId);
        if (issueState) {
          if (issueState.status === 'done' || issueState.status === 'cancelled') {
            console.log(`[closedloop] GUARD: Skipping ${agentName} — issue ${issueId.slice(0, 8)} is ${issueState.status} (post-resolution check)`);
            // Return early - don't process this issue
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              message: { role: 'assistant', content: `_Issue ${issueId.slice(0, 8)} is ${issueState.status}, no action needed._` },
            }));
            return;
          } else if (issueState.status === 'in_review' && agentId === AGENTS['local builder']) {
            // Local Builder shouldn't process in_review issues - that's for Reviewer/Diff Guardian
            console.log(`[closedloop] GUARD: ${agentName} skipping ${issueId.slice(0, 8)} — status is in_review (waiting for review)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              message: { role: 'assistant', content: `_Issue ${issueId.slice(0, 8)} is in_review, waiting for reviewer._` },
            }));
            return;
          }
        }
      } catch (err: any) {
        console.log(`[closedloop] Guard check failed: ${err.message}`);
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

    // Guard: skip processing if issue is already completed (done/cancelled)
    // NOTE: in_review issues should still be processed by Reviewer/Diff Guardian
    if (issueId) {
      const issueState = await getIssueDetails(issueId);
      if (issueState && (issueState as any).goalId && issueState.id !== (issueState as any).goalId) {
        await enforceGoalOverlapSuppression((issueState as any).goalId);
        const overlapBlock = getOverlapBlockForTicket(issueId);
        if (overlapBlock) {
          const issueLabel = await getIssueLabel(issueId);
          await patchIssue(issueId, { status: 'todo', assigneeAgentId: undefined } as any);
          console.log(`[closedloop] Skipping ${agentName} for ${issueLabel} - blocked by overlap with ${overlapBlock.canonicalIdentifier}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              message: {
                role: 'assistant',
                content: `_Issue ${issueLabel} is blocked by overlap with ${overlapBlock.canonicalIdentifier}; waiting for canonical completion or epic reconciliation._`,
              },
            })
          );
          return;
        }
      }
      if (issueState && (issueState.status === 'done' || issueState.status === 'cancelled')) {
        console.log(`[closedloop] Skipping ${agentName} — issue ${issueId.slice(0, 8)} is ${issueState.status}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: `_Issue is ${issueState.status}, no action needed._` },
          })
        );
        return;
      }
      // Local Builder should skip in_review issues (waiting for review)
      if (issueState && issueState.status === 'in_review' && agentId === AGENTS['local builder']) {
        console.log(`[closedloop] Skipping ${agentName} — issue ${issueId.slice(0, 8)} is in_review (waiting for review)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: `_Issue is in_review, waiting for reviewer._` },
          })
        );
        return;
      }

      // Reviewer/Diff Guardian can process in_review issues only while they remain the assignee.
      // This prevents stale queued wakeups from repeatedly reprocessing an issue after PR creation.
      if (
        issueState &&
        issueState.status === 'in_review' &&
        (agentId === AGENTS.reviewer || agentId === AGENTS['diff guardian']) &&
        issueState.assigneeAgentId !== agentId
      ) {
        console.log(`[closedloop] Skipping stale ${agentName} wakeup for ${issueId.slice(0, 8)} — assignee is no longer ${agentName}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: `_Stale ${agentName} wakeup skipped; issue is already in_review and assigned elsewhere._` },
          })
        );
        return;
      }
    }

    // Hook 1: Goal guard — goals should only enter through Epic Decoder.
    if (issueId && agentId === AGENTS['local builder']) {
      const builderIssue = await getIssueDetails(issueId);
      if (builderIssue && isGoalIssue(builderIssue)) {
        const complexity = scoreComplexity(builderIssue.title, builderIssue.description || '');
        console.log(`[closedloop] Goal guard: ${builderIssue.identifier || issueId.slice(0, 8)} complexity ${complexity.score}/10 -> Epic Decoder`);
        await postComment(
          issueId,
          null,
          `_Goal detected (score: ${complexity.score}/10) -> sending to Epic Decoder for ticket decomposition._`
        );
        await patchIssue(issueId, { assigneeAgentId: AGENTS['epic decoder'] });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '_Redirected Goal issue for decomposition._' } }));
        return;
      }
    }

    // Hook 1b: Epic Decoder is now native opencode_local adapter - let Paperclip handle execution
    // (Previously intercepted and called decodeEpic locally via GLM-5, now delegated to native adapter)

    // Hook 1c: Epic Reviewer is now native codex_local adapter - let Paperclip handle execution
    // (Previously intercepted and handled locally, now delegated to native adapter)

    // Hook 1d: Epic Decoder native adapter - let Paperclip handle execution
    // (Previously intercepted and called decodeEpic locally, now delegated to native adapter)

    // Hook 2: Burst model override for greenfield scaffold issues
    // When burst model is "remote", route to the remote API (glm-5) instead of Ollama
    if (agentId === AGENTS['local builder'] && issueId && issueBuilderBurstMode.has(issueId)) {
      const burstModel = getAgentModel('local builder burst');
      if (burstModel === 'remote') {
        console.log(`[closedloop] Burst mode: routing to REMOTE (glm-5) for ${await getIssueLabel(issueId)}`);
        try {
          const issueContext =  await buildLocalBuilderContext(issueId, agentId);
          const messages = [...(parsedBody.messages || [])];
          if (issueContext) messages.push({ role: 'user', content: issueContext });
          const fullPrompt = messages.map((m: any) => `[${m.role}]: ${m.content}`).join('\n\n');
          const remoteResult = await callRemoteLLM(
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
        console.log(`[closedloop] Burst mode: using ${burstModel} for ${await getIssueLabel(issueId)}`);
      }
    }

    // Hook 3: Coder Remote — route to GLM-5 via z.ai instead of Ollama
    if (agentId === AGENTS['coder remote'] && issueId) {
      console.log(`[proxy:${proxyPort}] Coder Remote -> GLM-5 (remote) | issue=${await getIssueLabel(issueId)}`);
      try {
        const issueContext = await buildLocalBuilderContext(issueId, agentId);
        const messages = [...(parsedBody.messages || [])];
        if (issueContext) messages.push({ role: 'user', content: issueContext });
        const fullPrompt = messages.map((m: any) => `[${m.role}]: ${m.content}`).join('\n\n');
        const remoteResult = await callRemoteLLM(
          fullPrompt,
          'You are a senior full-stack engineer working on a TypeScript monorepo (Next.js + React Native + Cloudflare Workers). ' +
          'Write production-quality code. Output file contents using FILE: path/to/file.ext format followed by code blocks. ' +
          `${buildStylingInstructionSentence()} ` +
          'Use fetcherWithToken from app/utils/fetcherWithToken for API calls.'
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
      console.log(`[proxy:${proxyPort}] ${agentName} -> feature recorder | issue=${await getIssueLabel(issueId)}`);
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

    // Complexity Router uses deterministic scoring and routing.
    // Do not block the pipeline on LLM output for this step.
    if (issueId && agentId === AGENTS['complexity router']) {
      const routerIssue = await getIssueDetails(issueId);
      if (routerIssue) {
        if (isGoalIssue(routerIssue)) {
          console.log(`[closedloop] Complexity Router received goal ${routerIssue.identifier || issueId.slice(0, 8)} -> ignoring unexpected goal assignment`);
          await postComment(
            issueId,
            null,
            `_Complexity Router received a goal unexpectedly and did not process it. Goals must enter through Epic Decoder, not Complexity Router._`
          );
        } else {
          const complexity = scoreComplexity(routerIssue.title, routerIssue.description || '');
          console.log(`[closedloop] Complexity Router scored ${routerIssue.identifier || issueId.slice(0, 8)}: ${complexity.score}/10 [${complexity.signals.join(', ')}]`);
          await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
          console.log(`[closedloop] Complexity Router -> Strategist`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Complexity routing completed; issue delegated to Strategist._',
          },
        })
      );
      return;
    }

    // Strategist routing can be deterministic for non-goal tickets.
    // Keep this stage non-blocking so execution reaches builders reliably.
    if (issueId && agentId === AGENTS.strategist) {
      const stratIssue = await getIssueDetails(issueId);
      if (stratIssue) {
        if (isGoalIssue(stratIssue)) {
          await patchIssue(issueId, { assigneeAgentId: AGENTS['epic decoder'] });
          console.log(`[closedloop] Strategist -> Epic Decoder for goal ${stratIssue.identifier || issueId.slice(0, 8)}`);
        } else {
          await patchIssue(issueId, { assigneeAgentId: AGENTS['tech lead'] });
          console.log(`[closedloop] Strategist -> Tech Lead for ${stratIssue.identifier || issueId.slice(0, 8)}`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Strategy routing completed; issue delegated to next execution stage._',
          },
        })
      );
      return;
    }

    // Tech Lead acts as execution handoff for implementation tickets.
    // Keep this deterministic so coding reaches Local Builder without planner stalls.
    if (issueId && agentId === AGENTS['tech lead']) {
      const leadIssue = await getIssueDetails(issueId);
      if (leadIssue) {
        await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
        console.log(`[closedloop] Tech Lead -> Local Builder for ${leadIssue.identifier || issueId.slice(0, 8)}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Technical plan finalized; delegated to Local Builder._',
          },
        })
      );
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
        const finalIssueContext = trimLocalBuilderContextIfNeeded(agentId || null, issueContext);
        if (finalIssueContext.length !== issueContext.length) {
          console.log(
            `[closedloop] Local Builder context trimmed ${issueContext.length} -> ${finalIssueContext.length} chars to prevent timeout`
          );
        }
        ollamaPayload.messages.push({
          role: 'user',
          content: finalIssueContext,
        });
      }
    } else if (parsedBody.context) {
      const heartbeatMsg = buildHeartbeatContext(parsedBody.context);
      ollamaPayload.messages.push({ role: 'user', content: heartbeatMsg });
    }

    const runnerCommand = `ollama run ${String(ollamaPayload.model || '').replace(/^ollama\//, '')}`;
    const runnerCwd = getConfig().project.workspace;
    console.log(
      `[proxy:${proxyPort}] ${agentName} -> ${runnerCommand} | issue=${issueId ? await getIssueLabel(issueId) : 'none'} | msgs=${ollamaPayload.messages.length}`
    );

    try {
      // Build prompt from messages array for model CLI
      const combinedPrompt = ollamaPayload.messages
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join('\n\n');
      const systemMsgs = ollamaPayload.messages.filter((m: any) => m.role === 'system');
      const nonSystemMsgs = ollamaPayload.messages.filter((m: any) => m.role !== 'system');
      const systemPrompt = systemMsgs.map((m: any) => m.content).join('\n');
      const userPrompt = nonSystemMsgs.map((m: any) => `[${m.role}]: ${m.content}`).join('\n\n');

      console.log(`[proxy:${proxyPort}] step started: adapter invocation (${agentName})`);
      const modelResult = await callModelCLI(userPrompt, systemPrompt, ollamaPayload.model);
      const visibleResult = modelResult.trim() || '_No text output from model._';
      const assistantReport =
        `## Bridge Run\n` +
        `- command: \`${runnerCommand}\`\n` +
        `- cwd: \`${runnerCwd}\`\n` +
        `- stderr excerpt: \`(none)\`\n\n` +
        `## Output\n${visibleResult}`;
      console.log(`[proxy:${proxyPort}] step finished: adapter invocation (${agentName})`);

      // Wrap in Ollama-compatible response format for Paperclip
      const ollamaData = JSON.stringify({
        message: { role: 'assistant', content: assistantReport },
        done: true,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(ollamaData);

      // Post LLM output as comment and handle delegation
      if (issueId) {
        try {
          const content = assistantReport;

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
                } else if (agentId !== AGENTS['complexity router']) {
                  const delegated = await detectAndDelegate(issueId, agentId, content);
                  if (!delegated && agentId === AGENTS.strategist && issueId) {
                    const stratIssue = await getIssueDetails(issueId);
                    if (stratIssue && !isGoalIssue(stratIssue)) {
                      await patchIssue(issueId, { assigneeAgentId: AGENTS['tech lead'] });
                      console.log(`[closedloop] Strategist fallback -> Tech Lead for ${stratIssue.identifier || issueId.slice(0, 8)}`);
                    }
                  }
                }
              } else if (agentId === AGENTS['complexity router']) {
                // Complexity Router: detect delegation and reassign
                const delegated = await detectAndDelegate(issueId, agentId, content);
                if (!delegated) {
                  // No delegation detected - fallback to Strategist
                  await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
                  console.log(`[closedloop] Complexity Router fallback -> Strategist for ${issueId.slice(0, 8)}`);
                }
              } else {
                const delegated = await detectAndDelegate(issueId, agentId, content);
                if (!delegated && agentId === AGENTS.strategist && issueId) {
                  const stratIssue = await getIssueDetails(issueId);
                  if (stratIssue && !isGoalIssue(stratIssue)) {
                    await patchIssue(issueId, { assigneeAgentId: AGENTS['tech lead'] });
                    console.log(`[closedloop] Strategist fallback -> Tech Lead for ${stratIssue.identifier || issueId.slice(0, 8)}`);
                  }
                }
              }
            }

            // Hook 3: Complexity Router post-response — score normal issues and route.
            if (agentId === AGENTS['complexity router'] && issueId) {
              const routerIssue = await getIssueDetails(issueId);
              if (routerIssue) {
                if (isGoalIssue(routerIssue)) {
                  console.log(`[closedloop] Complexity Router received goal ${routerIssue.identifier || issueId.slice(0, 8)} -> ignoring unexpected goal assignment`);
                  await postComment(
                    issueId,
                    null,
                    `_Complexity Router received a goal unexpectedly and did not process it. Goals must enter through Epic Decoder, not Complexity Router._`
                  );
                } else {
                  const complexity = scoreComplexity(routerIssue.title, routerIssue.description || '');
                  console.log(`[closedloop] Complexity Router scored ${routerIssue.identifier || issueId.slice(0, 8)}: ${complexity.score}/10 [${complexity.signals.join(', ')}]`);
                  if (complexity.score >= 7) {
                    await callRemoteArchitect(issueId, routerIssue);
                    console.log(`[closedloop] High complexity — marked for parallel exploration`);
                    await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
                  } else {
                    await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
                  }
                  console.log(`[closedloop] Complexity Router -> Strategist`);
                }
              }
            }

            // Hook 4: Strategist should not decompose goals; Epic Decoder owns goal decomposition.
            if (agentId === AGENTS.strategist && issueId) {
              const stratIssue = await getIssueDetails(issueId);
              if (stratIssue && isGoalIssue(stratIssue) && content.includes('## Ticket:')) {
                console.log(`[closedloop] Ignoring Strategist goal decomposition output for ${stratIssue.identifier || issueId.slice(0, 8)} because Epic Decoder owns goal decomposition`);
              }
            }

            // Local Builder: extract code blocks, write files, commit (no PR yet)
            if (agentId === AGENTS['local builder']) {
              const existingPasses = issueBuilderPasses[issueId] || 0;
              if (existingPasses >= MAX_BUILDER_PASSES) {
                console.log(`[closedloop] Local Builder pass cap already reached for ${await getIssueLabel(issueId)} (${existingPasses}/${MAX_BUILDER_PASSES})`);
                await stopOnBuilderPassCap(issueId, existingPasses);
                return;
              }

              if (issueProcessingLock[issueId]) {
                console.log(`[closedloop] Skipping duplicate Local Builder run for ${await getIssueLabel(issueId)} (already processing)`);
              } else {
                issueProcessingLock[issueId] = true;
                try {
                  const { written: writtenFiles, fileContents } = applyCodeBlocks(content);
                  if (writtenFiles.length > 0) {
                    const issue = await getIssueDetails(issueId);
                    if (issue) {
                      const driftPrecommit = runDriftPrecommit(issue, writtenFiles, getWorkspace());
                      if (!driftPrecommit.ok) {
                        telemetryCounters.driftBlockedWrites += 1;
                        console.log(
                          `[telemetry] DRIFT_BLOCKED_WRITES count=${telemetryCounters.driftBlockedWrites} code=${driftPrecommit.code || 'UNKNOWN'}`
                        );
                        await postComment(
                          issueId,
                          AGENTS['local builder'],
                          `[${driftPrecommit.code || 'DRIFT_BLOCKED'}] Local Builder write blocked before commit.\n\n` +
                          `Details:\n${driftPrecommit.details.map(detail => `- ${detail}`).join('\n')}\n\n` +
                          `Ticket was reassigned for correction. No commit/push was performed.`
                        );
                        await patchIssue(issueId, { assigneeAgentId: AGENTS['tech lead'] });
                        return;
                      }
                    }

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

                    if (pass >= MAX_BUILDER_PASSES) {
                      console.log(`[closedloop] Local Builder pass cap reached for ${await getIssueLabel(issueId)} (${pass}/${MAX_BUILDER_PASSES})`);
                    }

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
                        
                        // Track import validation failures
                        const importFailureKey = `${issueId}-import`;
                        if (!issueImportFailures[issueId]) issueImportFailures[issueId] = 0;
                        issueImportFailures[issueId]++;
                        
                        // After 2 import failures, send to Reviewer for help
                        if (issueImportFailures[issueId] >= 2) {
                          await postComment(
                            issueId,
                            AGENTS['local builder'],
                            `⚠️ **Import Validation Failed - Requesting Reviewer Assistance**\n\n` +
                            `Import validation has failed ${issueImportFailures[issueId]} times. Sending to Reviewer for help.\n\n` +
                            formatValidationResult(validation) +
                            `\n\n${buildImportFixGuidance()}` +
                            `**Reviewer:** Please help fix these import errors. The Local Builder has been unable to resolve them.`
                          );
                          await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                          console.log(`[closedloop] Import validation failed ${issueImportFailures[issueId]} times — assigned to Reviewer`);
                        } else {
                          await postComment(
                            issueId,
                            AGENTS['local builder'],
                            `⚠️ **Import Validation Failed**\n\n` +
                            formatValidationResult(validation) +
                            `\n\n${buildImportFixGuidance()}` +
                            `**Fix the imports above and try again.**`
                          );
                          await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                          console.log(`[closedloop] Import validation failed — retrying Local Builder (attempt ${issueImportFailures[issueId]})`);
                        }
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
                    const commitResult = await commitAndPush(issueId, writtenFiles, fileContents);

                    // If commit/push failed, send back to Local Builder to fix the branch state first
                    if (!commitResult.success) {
                      console.log(`[closedloop] Commit/push FAILED - saving to tried-approaches memory`);

                      // Track build failure count
                      const buildFailureStatus = trackBuildFailure(issueId);

                      // Get issue details for identifier
                      const issueDetails = await getIssueDetails(issueId);
                      const issueIdentifier = issueDetails?.identifier || issueId.slice(0, 8);

                      // Save this failed attempt to global memory
                      try {
                        const { saveTriedApproach } = await import('./tried-approaches');
                        await saveTriedApproach(issueId, issueIdentifier, writtenFiles, commitResult.output || 'Commit/push failed');
                        console.log(`[closedloop] Saved failed attempt to global memory`);
                      } catch (err: any) {
                        console.log(`[closedloop] Failed to save tried-approaches: ${err.message}`);
                      }

                      // Build error hints based on error type
                      let hints = '';
                      const buildOutput = commitResult.output || '';
                      
                      if (buildOutput.includes('multiple package managers') || buildOutput.includes('npm, berry')) {
                        hints = `\n\n**💡 CRITICAL: Package Manager Conflict**\n\n` +
                          `**Problem:** Yarn detects npm lockfiles (package-lock.json) in your branch.\n\n` +
                          `**FIX:**\n` +
                          `1. Check what's in your branch: \`git ls-files | grep package-lock\`\n` +
                          `2. Remove any package-lock.json: \`git rm --cached package-lock.json\` then \`del /s /q package-lock.json\`\n` +
                          `3. Only commit your .ts/.tsx source code changes\n` +
                          `4. DO NOT commit package-lock.json, node_modules, or .yarn/* (except releases/patches)\n\n` +
                          `**This project uses Yarn Berry v3.5.0 ONLY - no npm!**`;
                      } else if (buildOutput.includes('EPERM') || buildOutput.includes('operation not permitted')) {
                        hints = `\n\n**💡 File Lock Issue**\n\n` +
                          `Some files are locked by another process. Try:\n` +
                          `1. Close any editors or processes using node_modules\n` +
                          `2. Delete node_modules and run \`yarn install\`\n` +
                          `3. Only commit source code (.ts/.tsx), not node_modules`;
                      } else if (buildOutput.includes('TS2307') || buildOutput.includes('Cannot find module')) {
                        hints = `\n\n**💡 Module Resolution Error**\n\n` +
                          `- Check import paths are correct (use '../' for relative)\n` +
                          `- Use '@shop-diary/ui' for cross-package imports\n` +
                          `- Verify the imported file exists and exports what you need`;
                      } else if (buildOutput.includes('TS2304') || buildOutput.includes('Cannot find name')) {
                        hints = `\n\n**💡 Missing Type/Variable**\n\n` +
                          `- Add missing imports at the top of the file\n` +
                          `- Check for typos in variable/component names\n` +
                          `- Make sure you're using the correct TypeScript types`;
                      }
                      
                      // Check if build failures exceeded max — create PR for human help
                      if (buildFailureStatus.exceeded) {
                        console.log(`[closedloop] BUILD FAILURES EXCEEDED (${buildFailureStatus.count}/${MAX_BUILD_FAILURES}) - Creating PR for human intervention`);
                        await postComment(
                          issueId,
                          null,
                          `⚠️ **Auto-PR Created: Build Failures Exceeded**\n\n` +
                          `The Local Builder has attempted to fix build errors ${buildFailureStatus.count} times but couldn't resolve them.\n\n` +
                          `**What happened:**\n` +
                          `- Build validation failed ${buildFailureStatus.count} consecutive times\n` +
                          `- The agent is unable to fix the errors automatically\n` +
                          `- This may indicate:\n` +
                          `  - Complex build configuration issues\n` +
                          `  - Missing dependencies or type definitions\n` +
                          `  - Incompatible code changes\n\n` +
                          `**Build error:**\n\`\`\`\n${buildOutput?.slice(0, 1500) || 'See commit for details'}\n\`\`\`\n\n` +
                          `${hints}\n\n` +
                          `**Next steps:**\n` +
                          `1. Review the PR and build errors\n` +
                          `2. Fix the build manually\n` +
                          `3. Merge when ready\n`
                        );
                        try {
                          await createPullRequest(issueId);
                          resetBuildFailureCounter(issueId);
                          resetLoopCounter(issueId);
                          // Clear assignee to prevent further agent wakeups
                          await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
                          console.log(`[closedloop] PR created after build failures exceeded`);
                        } catch (prErr: any) {
                          console.error(`[closedloop] Failed to create PR after build failures:`, prErr.message);
                          if (String(prErr.message || '').includes('[PR_PREFLIGHT_FAILED]')) {
                            console.log('[closedloop] PR preflight blocked; issue parked to avoid retry storm.');
                          }
                        }
                      } else if (buildFailureStatus.count >= 2) {
                        // After 2 build failures, send to Reviewer for help instead of self-assigning
                        // This breaks the loop and gets a fresh perspective on the problem
                        console.log(`[closedloop] Branch sync failure #${buildFailureStatus.count} — sending to Reviewer for assistance`);
                        await postComment(
                          issueId,
                          AGENTS['local builder'],
                          `⚠️ **Commit/Push Failed - Requesting Reviewer Assistance**\n\n` +
                          `The branch sync has failed ${buildFailureStatus.count} times. Sending to Reviewer for a fresh perspective.\n\n` +
                          `**Build error:**\n\`\`\`\n${buildOutput}\n\`\`\`\n\n` +
                          `${hints}\n\n` +
                          `**Reviewer:** Please help identify the issue. The Local Builder has been unable to resolve these build errors.`
                        );
                        await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer });
                        console.log(`[closedloop] Assigned to Reviewer for branch sync assistance`);
                      } else {
                        // Normal flow: send back to Local Builder
                        await postComment(
                          issueId,
                          AGENTS['local builder'],
                          `⚠️ **Commit/Push Failed - Fix Before Review**\n\n` +
                          `The branch sync failed after writing files. Please fix the git or workspace issue before sending to Reviewer.\n\n` +
                          `\`\`\`\n${buildOutput}\n\`\`\`\n\n` +
                          `**💡 How to fix:**\n` +
                          `1. Read the error message above carefully\n` +
                          `2. Check your imports match packages in package.json\n` +
                          `3. DO NOT create package-lock.json (use yarn only)\n` +
                          `4. Only commit .ts/.tsx source files\n` +
                          `5. Run \`yarn turbo run build --filter=@shop-diary/ui --filter=@shop-diary/app\` to test locally\n\n` +
                          `${hints}\n\n` +
                          `**Common fixes:**\n` +
                          `- Import errors → Check packages/app/package.json or packages/ui/package.json\n` +
                          `- Type errors → Add missing imports or fix type definitions\n` +
                          `- Package manager errors → Remove package-lock.json, use yarn\n\n` +
                          `Fix the errors and commit again.`
                        );
                        await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                        console.log(`[closedloop] Sent back to Local Builder for build fixes`);
                      }
                    } else {
                      // Build passed — reset build failure counter
                      resetBuildFailureCounter(issueId);

                      // generate tests for written files before Reviewer
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

                      if (pass >= MAX_BUILDER_PASSES) {
                        await stopOnBuilderPassCap(issueId, pass);
                        return;
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
                          // Clear assignee after PR creation to prevent further wakeups
                          await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
                          console.log(`[closedloop] PR created for human intervention`);
                        } catch (prErr: any) {
                          console.error(`[closedloop] Failed to create PR:`, prErr.message);
                          if (String(prErr.message || '').includes('[PR_PREFLIGHT_FAILED]')) {
                            console.log('[closedloop] PR preflight blocked; issue parked to avoid retry storm.');
                          }
                        }
                        // Skip normal flow - PR already created
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
              const verdict = parseReviewerVerdictStrict(content);

              if (verdict === 'APPROVED') {
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
                    // Clear assignee after PR creation
                    await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
                  } else {
                    await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                  }
                }
              } else {
                if (verdict === 'AMBIGUOUS') {
                  await postComment(
                    issueId,
                    AGENTS.reviewer,
                    `[REVIEW_VERDICT_AMBIGUOUS] Reviewer output did not include a structured verdict. ` +
                    `Expected \`VERDICT: APPROVED\` or \`VERDICT: CHANGES_REQUESTED\`. Treating as non-approval.`
                  );
                }
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
                    // Clear assignee after PR creation
                    await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
                    console.log(`[closedloop] PR created after loop cap`);
                  } catch (prErr: any) {
                    console.error(`[closedloop] Failed to create PR after loop cap:`, prErr.message);
                    if (String(prErr.message || '').includes('[PR_PREFLIGHT_FAILED]')) {
                      console.log('[closedloop] PR preflight blocked; issue parked to avoid retry storm.');
                    }
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

                  // Mark issue as in_review and clear assignee to stop further agent processing
                  await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
                  console.log(`[closedloop] Issue marked in_review, assignee cleared`);

                  // Reset loop counter on successful PR
                  resetLoopCounter(issueId);

                  // Hook 7: Goal completion check after PR creation
                  await checkGoalCompletion(issueId);
                } catch (prErr: any) {
                  console.error(`[closedloop] Failed to create PR:`, prErr.message);
                  if (!String(prErr.message || '').includes('[PR_PREFLIGHT_FAILED]')) {
                    await postComment(issueId, null, `_DiffGuardian approved but PR creation failed: ${prErr.message}_`);
                  }
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
                    // Clear assignee after PR creation
                    await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
                    console.log(`[closedloop] PR created after loop cap`);
                  } catch (prErr: any) {
                    console.error(`[closedloop] Failed to create PR after loop cap:`, prErr.message);
                    if (String(prErr.message || '').includes('[PR_PREFLIGHT_FAILED]')) {
                      console.log('[closedloop] PR preflight blocked; issue parked to avoid retry storm.');
                    }
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
        } finally {
          if (agentId) {
            await wakeAgentForNextAssignedIssue(agentId, issueId);
          }
        }
      }
    } catch (err: any) {
      console.error(`[proxy:${proxyPort}] ${agentName} Ollama error:`, err.message);
      const errorText = String(err?.message || 'Unknown runner error');
      const assistantErrorReport =
        `## Bridge Run\n` +
        `- command: \`${runnerCommand}\`\n` +
        `- cwd: \`${runnerCwd}\`\n` +
        `- stderr excerpt: \`${errorText.slice(0, 400)}\`\n\n` +
        `## Output\n_Runner invocation failed. See stderr excerpt above._`;
      if (issueId) {
        await postComment(issueId, agentId, assistantErrorReport);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: { role: 'assistant', content: assistantErrorReport },
        done: true,
      }));
    }
  });

  server.listen(proxyPort, '127.0.0.1', () => {
    console.log(`[closedloop] :${proxyPort} -> ollama:${ollamaPort}`);
  });

  return server;
}

function buildHeartbeatContext(context: any): string {
  const parts: string[] = [];
  if (context.wakeReason) parts.push(`Wake reason: ${context.wakeReason}`);
  if (context.paperclipWorkspace?.cwd) {
    parts.push(`Workspace: ${context.paperclipWorkspace.cwd}`);
  }
  if (context.issueTitle) parts.push(`Issue title: ${context.issueTitle}`);
  if (context.issueDescription) parts.push(`Issue description: ${context.issueDescription}`);
  if (context.latestCommentBody) parts.push(`Latest comment: ${context.latestCommentBody}`);
  if (context.issueWorkProductSummary) parts.push(`Work products: ${context.issueWorkProductSummary}`);
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

      // Skip Local Builder issues that have already reached the pass cap
      if (agentId === AGENTS['local builder']) {
        const existingPasses = issueBuilderPasses[issue.id] || 0;
        if (existingPasses >= MAX_BUILDER_PASSES) {
          console.log(`[closedloop] Skipping Local Builder wakeup for ${issue.identifier || issue.id.slice(0, 8)} - pass cap already reached (${existingPasses}/${MAX_BUILDER_PASSES})`);
          continue;
        }
        // Also check if issue already has pass cap comment (persists across restarts)
        try {
          const { getIssueComments } = await import('./paperclip-api');
          const comments = await getIssueComments(issue.id);
          const passCapComment = comments.find((c: any) =>
            c.body && (c.body.includes('Pass Cap Reached') || c.body.includes('Local Builder pass cap'))
          );
          if (passCapComment) {
            console.log(`[closedloop] Skipping Local Builder wakeup for ${issue.identifier || issue.id.slice(0, 8)} - pass cap already handled (found comment)`);
            continue;
          }
        } catch {}
      }

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
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const primaryIssue = assignedIssues.find((i: any) => i.assigneeAgentId === agentId);
        const agentIssueIds = assignedIssues
          .filter((i: any) => i.assigneeAgentId === agentId)
          .map((i: any) => i.id);

        // Write context file and INSTRUCTIONS.md to workspace so native adapters can read context
        if (primaryIssue) {
          // Write .closedloop/context.json with issue context
          await writeIssueContext(primaryIssue.id);
          
          const allAgentIssues = assignedIssues.filter((i: any) => i.assigneeAgentId === agentId);
          const instructionsContent = [
            `# Agent Instructions`,
            ``,
            `**Agent:** ${agentName}`,
            `**Wake reason:** assigned_issues_pending`,
            `**Timestamp:** ${new Date().toISOString()}`,
            ``,
            `## Assigned Issues`,
            ``,
            ...allAgentIssues.map((i: any) => [
              `### ${i.identifier || i.id.slice(0, 8)}: ${i.title || '(no title)'}`,
              ``,
              `- **ID:** ${i.id}`,
              `- **Status:** ${i.status || 'unknown'}`,
              `- **Priority:** ${i.priority || 'normal'}`,
              ``,
              String(i.description || '(no description)').trim().slice(0, 2000),
              ``,
            ]).flat(),
            `## Instructions`,
            ``,
            `Process each assigned issue above. Read the workspace files directly.`,
            `Do not ask for pasted content — use the filesystem.`,
          ].join('\n');

          try {
            const workspace = getWorkspace();
            fs.writeFileSync(path.join(workspace, 'INSTRUCTIONS.md'), instructionsContent, 'utf8');
            console.log(`[closedloop] Wrote INSTRUCTIONS.md for ${agentName} (${allAgentIssues.length} issues)`);
          } catch (err: any) {
            console.log(`[closedloop] Failed to write INSTRUCTIONS.md: ${err.message}`);
          }
        }

        const wakeRes = await fetch(`${PAPERCLIP_API}/api/agents/${agentId}/wakeup`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source: 'assignment',
            triggerDetail: 'system',
            reason: `assigned_issues_pending:${issueIds.join(',')}`,
            issueId: primaryIssue?.id,
            taskId: primaryIssue?.id,
          }),
        });

        if (wakeRes.ok) {
          const wakeData = await wakeRes.json() as any;
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


