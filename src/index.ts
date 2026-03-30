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
import { ensureEpicReviewerNativeAdapter, ensureOrchestrationHttpAdapters } from './adapter-config';
import { monitorStuckRuns, normalizeOrchestrationRecovery } from './run-guardrails';

// Load configuration
const config = getConfig();
console.log(`[closedloop] Starting ClosedLoop for ${config.project.name}`);

// Initialize RAG indexer
initializeRAG().catch((err) => {
  console.error('[closedloop] Failed to initialize RAG:', err.message);
});

// Start the proxy server
createProxy();

// Run background checker every 10 minutes.
// Startup still performs an immediate check so we don't lose newly restarted work.
setInterval(() => {
  checkAssignedIssues().catch(() => {});
}, 10 * 60 * 1000);

// Run Epic Decoder heartbeat every 60 seconds so active goals can start the flow.
setInterval(() => {
  checkActiveGoalsForDecode().catch(() => {});
}, 60000);

// Stuck-run guardrail sweep every minute (cancel stale -> single retry -> escalate).
setInterval(() => {
  monitorStuckRuns().catch(() => {});
}, 60000);

// Re-enforce orchestration adapters on the visible bridge path.
setInterval(() => {
  ensureOrchestrationHttpAdapters().catch(() => {});
}, 5 * 60 * 1000);

// Keep Epic Reviewer on the native local adapter so it can inspect the workspace
// directly and keep the run UI visible without the bridge path.
setInterval(() => {
  ensureEpicReviewerNativeAdapter().catch(() => {});
}, 5 * 60 * 1000);

// On startup: reload goal/ticket mappings, reset errored agents, then start
// active-goal decomposition and assigned-issue checking.
setTimeout(async () => {
  await ensureEpicReviewerNativeAdapter();
  await ensureOrchestrationHttpAdapters();
  await normalizeOrchestrationRecovery();
  await reloadGoalTicketMappings();
  await checkActiveGoalsForDecode();
  await checkAssignedIssues();
}, 5000);

// DISABLED: Old periodic epic review - now handled by Epic Reviewer agent
// setInterval(() => {
//   checkEpicsForReview().catch(() => {});
// }, 60000);

// DISABLED: Old startup epic review - now handled by Epic Reviewer agent
// setTimeout(() => {
//   checkEpicsForReview().catch(() => {});
// }, 30000);

console.log('[closedloop] ClosedLoop started.');
