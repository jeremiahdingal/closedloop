/**
 * ClosedLoop - Local-First Autonomous Coding Agent
 *
 * Powered by Ollama + Paperclip AI with RAG for reliable offline code generation.
 * Main entry point. Initializes RAG indexer and starts the ClosedLoop server.
 */

import { createProxy, checkAssignedIssues, initializeRAG } from './proxy-server';
import { getConfig } from './config';
import { checkActiveGoalsForDecode } from './epic-decoder';
import { reloadGoalTicketMappings } from './goal-system';
import { ensureEpicReviewerNativeAdapter, ensureRepoAwareOpenCodeAdapters, ensureUpstreamOpenCodeAdapters } from './adapter-config';
import { monitorStuckRuns, normalizeOrchestrationRecovery, monitorCompletedBuilderRuns, monitorCompletedReviewerRuns } from './run-guardrails';
import { monitorActiveRuns, checkForErrorsInRunningRuns } from './during-execution';
import { getPaperclipApiUrl } from './config';

async function waitForPaperclip(maxRetries = 30, intervalMs = 2000): Promise<boolean> {
  const url = `${getPaperclipApiUrl()}/api/health`;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`[closedloop] Paperclip ready (attempt ${i})`);
        return true;
      }
    } catch {}
    if (i < maxRetries) {
      console.log(`[closedloop] Waiting for Paperclip... (attempt ${i}/${maxRetries})`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  console.error(`[closedloop] Paperclip not reachable after ${maxRetries} attempts`);
  return false;
}

// Load configuration
const config = getConfig();
console.log(`[closedloop] Starting ClosedLoop for ${config.project.name}`);

// Initialize RAG indexer
initializeRAG().catch((err) => {
  console.error('[closedloop] Failed to initialize RAG:', err.message);
});

// Start the proxy server
createProxy();

// Run background checker every 2 minutes so builder wakeups happen promptly.
setInterval(() => {
  checkAssignedIssues().catch(() => {});
}, 2 * 60 * 1000);

// Run Epic Decoder heartbeat every 60 seconds so active goals can start the flow.
setInterval(() => {
  checkActiveGoalsForDecode().catch(() => {});
}, 60000);

// Stuck-run guardrail sweep every minute (cancel stale -> single retry -> escalate).
setInterval(() => {
  monitorStuckRuns().catch(() => {});
}, 60000);

// Monitor completed builder runs every 30 seconds to detect workspace changes,
// commit them, and move tickets to in_review.
setInterval(() => {
  monitorCompletedBuilderRuns().catch(() => {});
}, 30000);

// During-execution monitoring: check for file changes every 30s to detect idle runs
setInterval(() => {
  monitorActiveRuns().catch(() => {});
}, 30000);

// Check for errors in running runs every 30 seconds
setInterval(() => {
  checkForErrorsInRunningRuns().catch(() => {});
}, 30000);

// Monitor completed reviewer runs - handle approved/rejected output
setInterval(() => {
  monitorCompletedReviewerRuns().catch(() => {});
}, 30000);

// Re-enforce native OpenCode adapters for the upstream orchestration path.
setInterval(() => {
  ensureUpstreamOpenCodeAdapters().catch(() => {});
}, 5 * 60 * 1000);

// Keep repo-aware agents on native local adapters so they can inspect the
// workspace directly and keep the run UI visible without the bridge path.
setInterval(() => {
  ensureRepoAwareOpenCodeAdapters().catch(() => {});
}, 5 * 60 * 1000);

// Keep Epic Reviewer on the native local adapter so it can inspect the workspace
// directly and keep the run UI visible without the bridge path.
setInterval(() => {
  ensureEpicReviewerNativeAdapter().catch(() => {});
}, 5 * 60 * 1000);

// On startup: wait for Paperclip, then sync adapters, reload mappings, and
// kick off goal decomposition + assigned-issue checks.
setTimeout(async () => {
  const ready = await waitForPaperclip();
  if (!ready) {
    console.error('[closedloop] Proceeding without Paperclip — syncs will retry on interval');
  }
  await ensureRepoAwareOpenCodeAdapters().catch(e => console.log(`[closedloop] Repo-aware sync: ${e.message}`));
  await ensureEpicReviewerNativeAdapter().catch(e => console.log(`[closedloop] Epic Reviewer sync: ${e.message}`));
  await ensureUpstreamOpenCodeAdapters().catch(e => console.log(`[closedloop] Upstream sync: ${e.message}`));
  await normalizeOrchestrationRecovery();
  await reloadGoalTicketMappings();
  await checkActiveGoalsForDecode();
  await checkAssignedIssues();
}, 2000);

// DISABLED: Old periodic epic review - now handled by Epic Reviewer agent
// setInterval(() => {
//   checkEpicsForReview().catch(() => {});
// }, 60000);

// DISABLED: Old startup epic review - now handled by Epic Reviewer agent
// setTimeout(() => {
//   checkEpicsForReview().catch(() => {});
// }, 30000);

console.log('[closedloop] ClosedLoop started.');
