/**
 * ClosedLoop - Local-First Autonomous Coding Agent
 *
 * Powered by Ollama + Paperclip AI with RAG for reliable offline code generation.
 * Main entry point. Initializes RAG indexer and starts the ClosedLoop server.
 */

import { createProxy, checkAssignedIssues, initializeRAG } from './proxy-server';
import { ragIndexer } from './rag-indexer';
import { getConfig, getPaperclipApiUrl, getCompanyId, getAgentKeys } from './config';
import { AGENTS } from './agent-types';
// DISABLED: Old epic-decomposer (local LLM) - replaced by epic-decoder (GLM-5)
// import { checkGoalsForDecomposition } from './epic-decomposer';
import { reloadGoalTicketMappings } from './goal-system';

// Load configuration
const config = getConfig();
console.log(`[closedloop] Starting ClosedLoop for ${config.project.name}`);

/**
 * Reset errored agents to idle on startup so Paperclip will dispatch to them.
 */
async function resetErroredAgents(): Promise<void> {
  const PAPERCLIP_API = getPaperclipApiUrl();
  const COMPANY_ID = getCompanyId();

  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/agents`);
    if (!res.ok) return;
    const data = await res.json() as any;
    const agents = Array.isArray(data) ? data : data.agents || data.data || [];

    for (const agent of agents) {
      if (agent.status === 'error') {
        try {
          await fetch(`${PAPERCLIP_API}/api/agents/${agent.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'idle' }),
          });
          console.log(`[closedloop] Reset ${agent.name} from error -> idle`);
        } catch {}
      }
    }
  } catch (err: any) {
    console.log(`[closedloop] Could not reset agents: ${err.message}`);
  }
}

// Initialize RAG indexer
initializeRAG().catch((err) => {
  console.error('[closedloop] Failed to initialize RAG:', err.message);
});

// Start the proxy server
createProxy();

// Run background checker every 60 seconds
setInterval(() => {
  checkAssignedIssues().catch(() => {});
}, 60000);

// DISABLED: Old epic-decomposer (local LLM) - replaced by epic-decoder (GLM-5)
// Run epic decomposer every 2 minutes
// setInterval(() => {
//   checkGoalsForDecomposition().catch(() => {});
// }, 120000);

// On startup: reload goal/ticket mappings, reset errored agents, then start processing
setTimeout(async () => {
  await reloadGoalTicketMappings();
  await resetErroredAgents();
  await checkAssignedIssues();
  
  // Run Epic Reviewer Agent on startup to check all epics
  try {
    const { runEpicReviewerAgent } = await import('./epic-reviewer-agent');
    await runEpicReviewerAgent();
    console.log('[closedloop] Epic Reviewer Agent completed startup check');
  } catch (err: any) {
    console.log(`[closedloop] Epic Reviewer Agent failed: ${err.message}`);
  }
}, 5000);

// DISABLED: Old epic-decomposer startup check
// setTimeout(() => {
//   checkGoalsForDecomposition().catch(() => {});
// }, 10000);

// DISABLED: Old periodic epic review - now handled by Epic Reviewer agent
// setInterval(() => {
//   checkEpicsForReview().catch(() => {});
// }, 60000);

// DISABLED: Old startup epic review - now handled by Epic Reviewer agent
// setTimeout(() => {
//   checkEpicsForReview().catch(() => {});
// }, 30000);

console.log('[closedloop] ClosedLoop started.');
