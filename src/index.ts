/**
 * ClosedLoop - Local-First Autonomous Coding Agent
 *
 * Powered by Ollama + Paperclip AI with RAG for reliable offline code generation.
 * Main entry point. Initializes RAG indexer and starts the ClosedLoop server.
 */

import { createProxy, checkAssignedIssues, initializeRAG } from './proxy-server';
import { ragIndexer } from './rag-indexer';
import { getConfig } from './config';
import { checkGoalsForDecomposition } from './epic-decomposer';

// Load configuration
const config = getConfig();
console.log(`[closedloop] Starting ClosedLoop for ${config.project.name}`);

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

// Run epic decomposer every 2 minutes
setInterval(() => {
  checkGoalsForDecomposition().catch(() => {});
}, 120000);

// Run immediately on startup
setTimeout(() => {
  checkAssignedIssues().catch(() => {});
}, 5000);

// Check for epics shortly after startup
setTimeout(() => {
  checkGoalsForDecomposition().catch(() => {});
}, 10000);

console.log('[closedloop] ClosedLoop started.');
