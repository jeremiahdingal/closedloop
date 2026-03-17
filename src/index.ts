/**
 * Ollama Proxy for Paperclip (v5) - TypeScript Refactored Version
 *
 * Main entry point. Initializes RAG indexer and starts the proxy server.
 */

import { createProxy, checkAssignedIssues, initializeRAG } from './proxy-server';
import { ragIndexer } from './rag-indexer';
import { getConfig } from './config';

// Load configuration
const config = getConfig();
console.log(`[proxy] Starting Ollama Proxy for ${config.project.name}`);

// Initialize RAG indexer
initializeRAG().catch((err) => {
  console.error('[proxy] Failed to initialize RAG:', err.message);
});

// Start the proxy server
createProxy();

// Run background checker every 60 seconds
setInterval(() => {
  checkAssignedIssues().catch(() => {});
}, 60000);

// Run immediately on startup
setTimeout(() => {
  checkAssignedIssues().catch(() => {});
}, 5000);

console.log('[proxy] All proxies started.');
