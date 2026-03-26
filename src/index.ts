/**
 * ClosedLoop - Local-First Autonomous Coding Agent
 *
 * Powered by Ollama + Paperclip AI with RAG for reliable offline code generation.
 * Main entry point. Initializes RAG indexer and starts the ClosedLoop server.
 */

import { createProxy, checkAssignedIssues, initializeRAG } from './proxy-server';
import { ragIndexer } from './rag-indexer';
import { getConfig, getPaperclipApiUrl, getCompanyId, getAgentKeys } from './config';
// DISABLED: Old epic-decomposer (local LLM) - replaced by epic-decoder (GLM-5)
// import { checkGoalsForDecomposition } from './epic-decomposer';
import { checkEpicsForReview } from './epic-reviewer';

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

// On startup: reset errored agents, then start processing
setTimeout(() => {
  resetErroredAgents()
    .then(() => checkAssignedIssues())
    .catch(() => {});
}, 5000);

// DISABLED: Old epic-decomposer startup check
// setTimeout(() => {
//   checkGoalsForDecomposition().catch(() => {});
// }, 10000);

// Run epic reviewer every 3 minutes (checks if all tickets in an epic are in_review)
setInterval(() => {
  checkEpicsForReview().catch(() => {});
}, 180000);

// Check for epic reviews shortly after startup
setTimeout(() => {
  checkEpicsForReview().catch(() => {});
}, 30000);

console.log('[closedloop] ClosedLoop started.');
