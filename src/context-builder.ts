/**
 * Issue context building with RAG integration
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspace } from './config';
import { getIssueDetails, getIssueComments } from './paperclip-api';
import { AGENTS } from './agent-types';
import { truncate } from './utils';
import { RAGSearchResult } from './types';

const WORKSPACE = getWorkspace();

// RAG indexer - lazily initialized
let ragIndexer: any = null;

export function setRAGIndexer(indexer: any) {
  ragIndexer = indexer;
}

export function getRAGIndexer(): any {
  return ragIndexer;
}

/**
 * Scan the workspace directory and return a structured text representation.
 */
export function scanDirectoryStructure(): string {
  const excludedDirs = new Set([
    'node_modules',
    '.git',
    '.turbo',
    '.screenshots',
    'e2e-tests',
    'dist',
    'build',
    '.next',
  ]);
  const lines: string[] = [];

  function scanDir(dirPath: string, indent: string = '') {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      if (excludedDirs.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else {
        files.push(entry.name);
      }
    }

    dirs.sort();
    files.sort();

    for (const file of files) {
      lines.push(`${indent}${file}`);
    }

    for (const dir of dirs) {
      lines.push(`${indent}${dir}/`);
      scanDir(path.join(dirPath, dir), indent + '  ');
    }
  }

  try {
    scanDir(WORKSPACE);
    const result = lines.join('\n');
    return truncate(result, 10000);
  } catch (err: any) {
    return `Error scanning directory: ${err.message}`;
  }
}

/**
 * Build project context for Strategist planning.
 */
export async function buildStrategistProjectContext(): Promise<string> {
  const structurePath = path.join(WORKSPACE, 'PROJECT_STRUCTURE.md');

  // Try to read PROJECT_STRUCTURE.md first (preferred - compact summary)
  if (fs.existsSync(structurePath)) {
    try {
      const content = fs.readFileSync(structurePath, 'utf8');
      const truncated = truncate(content, 8000);
      return `\n== PROJECT STRUCTURE (from PROJECT_STRUCTURE.md) ==\n${truncated}\n`;
    } catch (err: any) {
      console.log(`[context] Could not read PROJECT_STRUCTURE.md: ${err.message}`);
    }
  }

  // Fallback: scan directory structure
  console.log(`[context] PROJECT_STRUCTURE.md not found, scanning directory...`);
  const dirStructure = scanDirectoryStructure();
  return `\n== PROJECT DIRECTORY STRUCTURE ==\n${dirStructure}\n`;
}

/**
 * Build issue context for agents.
 */
export async function buildIssueContext(
  issueId: string,
  currentAgentId: string
): Promise<string | null> {
  const [issue, comments] = await Promise.all([getIssueDetails(issueId), getIssueComments(issueId)]);

  if (!issue) return null;

  const currentAgentName = getAgentName(currentAgentId);

  // Build the issue briefing
  let briefing = `== ISSUE: ${issue.identifier || 'unknown'} ==\n`;
  briefing += `Title: ${issue.title}\n`;
  briefing += `Status: ${issue.status}\n`;
  briefing += `Priority: ${issue.priority || 'medium'}\n`;

  if (issue.description) {
    briefing += `\nDescription:\n${issue.description}\n`;
  }

  // Strategist gets full project context for planning
  if (currentAgentId === AGENTS.strategist) {
    briefing += `\n\n== PROJECT CONTEXT FOR PLANNING ==\n`;
    const projectContext = await buildStrategistProjectContext();
    briefing += projectContext;
  }

  briefing += `\n== YOUR ASSIGNMENT ==\n`;
  briefing += `You are: ${currentAgentName}\n`;
  briefing += `You were assigned this issue. Read the comment history for context and any specific task instructions from upstream agents.\n`;
  briefing += `When you are done with YOUR part, clearly state your output/decision. If you need to delegate sub-work to a direct report, name the agent explicitly (e.g. "Agent: Tech Lead" or "Assign to: Local Builder").\n`;
  briefing += `Do NOT re-analyze or re-plan work that has already been delegated in the comment history.\n`;

  // Add comment history as conversation context
  if (comments.length > 0) {
    const sorted = comments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    // Keep last 5 comments (newest first) to avoid blowing context on smaller models
    const recent = sorted.slice(0, 5);

    briefing += '\n== COMMENT HISTORY (newest first) ==\n';
    for (const c of recent) {
      const authorName = c.authorAgentId ? await getAgentName(c.authorAgentId) : c.authorUserId || 'user';
      briefing += `\n[${authorName}]:\n${truncate(c.body, 3000)}\n`;
    }
  }

  return briefing;
}

// Tier 1: Shared files that almost every feature touches.
// Always injected so the builder sees existing types/enums and EXTENDS, not overwrites.
const TIER1_SHARED_FILES = [
  'packages/app/types/db.types.ts',
  'packages/app/types/services.enum.ts',
  'api/src/index.ts',
];

/**
 * Read a workspace file safely, return content or null.
 */
function readWorkspaceFile(relativePath: string, maxLen = 3000): string | null {
  try {
    const fullPath = path.join(WORKSPACE, relativePath);
    if (!fs.existsSync(fullPath)) return null;
    const content = fs.readFileSync(fullPath, 'utf8');
    if (!content.trim()) return null;
    return truncate(content, maxLen);
  } catch {
    return null;
  }
}

/**
 * Extract the service domain name from an issue title/description.
 * e.g., "Cash Shifts CRUD API" → "cash-shifts"
 */
function extractDomainFromIssue(title: string, description: string): string | null {
  // Try entity: field first (scaffold convention)
  const entityMatch = description.match(/entity:\s*([\w-]+)/i);
  if (entityMatch) return entityMatch[1];

  // Try table: field
  const tableMatch = description.match(/table:\s*(\w+)/i);
  if (tableMatch) return tableMatch[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  // Try to extract from title pattern like "[Phase X] ... : <Domain> CRUD API"
  const titleMatch = title.match(/:\s*([\w\s]+?)\s*CRUD/i);
  if (titleMatch) return titleMatch[1].trim().toLowerCase().replace(/\s+/g, '-');

  return null;
}

/**
 * Detect if this is a fix pass (Reviewer sent it back) by checking comment history.
 * Returns file paths mentioned in the Reviewer's rejection, plus the Reviewer's feedback.
 */
function detectFixPass(comments: Array<{ authorAgentId?: string; body: string }>): {
  isFixPass: boolean;
  reviewerFeedback: string | null;
  mentionedFiles: string[];
} {
  const filePathRegex = /[`']?([\w./\\-]+\.(tsx?|json|ts))[`']?/g;

  // Look for Reviewer comments (newest first) that indicate rejection
  for (const comment of comments) {
    const body = comment.body || '';
    const isReviewer = body.startsWith('**Reviewer') || comment.authorAgentId === AGENTS.reviewer;
    const isRejection = body.toLowerCase().includes('send back') ||
      body.toLowerCase().includes('reject') ||
      body.toLowerCase().includes('fix') ||
      (body.toLowerCase().includes('issue') && !body.toLowerCase().includes('approved'));

    if (isReviewer && isRejection) {
      const files: string[] = [];
      for (const match of body.matchAll(filePathRegex)) {
        if (match[1].match(/\.(tsx?|json)$/)) files.push(match[1]);
      }
      return { isFixPass: true, reviewerFeedback: truncate(body, 2000), mentionedFiles: files };
    }
  }

  return { isFixPass: false, reviewerFeedback: null, mentionedFiles: [] };
}

/**
 * Build enhanced context for Local Builder including RAG-retrieved files.
 *
 * Context tiers:
 *   Tier 1 — Shared mutation targets (always injected, full contents)
 *   Tier 2 — Pattern exemplar from RAG (similar domain's full service files)
 *   Tier 3 — Fix-pass files (current disk state of files the builder touched)
 */
export async function buildLocalBuilderContext(
  issueId: string,
  currentAgentId: string,
  contextBudget: 'normal' | 'burst' = 'normal'
): Promise<string | null> {
  const baseContext = await buildIssueContext(issueId, currentAgentId);
  if (!baseContext) return null;

  const maxPerFile = contextBudget === 'burst' ? 4000 : 2500;
  const issue = await getIssueDetails(issueId);
  const comments = await getIssueComments(issueId);
  const sortedComments = comments.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  let fileContext = '';

  // ── TIER 1: Shared mutation targets ──
  // These files get modified by every feature. Builder MUST see current state.
  fileContext += '\n\n== SHARED FILES (you MUST extend these, never overwrite) ==\n';
  let tier1Count = 0;
  for (const sharedFile of TIER1_SHARED_FILES) {
    const content = readWorkspaceFile(sharedFile, maxPerFile);
    if (content) {
      fileContext += `\n--- ${sharedFile} (CURRENT - add to this, do NOT replace) ---\n${content}\n`;
      tier1Count++;
    }
  }
  if (tier1Count === 0) {
    fileContext += '(Shared files not found — you may be creating them)\n';
  }

  // ── TIER 2: Pattern exemplar from RAG ──
  // Find a complete existing service domain as reference implementation.
  const domain = extractDomainFromIssue(issue?.title || '', issue?.description || '');
  if (domain && ragIndexer) {
    try {
      const exemplar = ragIndexer.findDomainExemplar(domain, { maxContentPerFile: maxPerFile });
      if (exemplar) {
        fileContext += `\n\n== PATTERN EXEMPLAR: "${exemplar.domain}" service (follow this pattern) ==\n`;
        for (const file of exemplar.files) {
          fileContext += `\n--- ${file.path} ---\n${truncate(file.content, maxPerFile)}\n`;
        }
        console.log(`[context] RAG exemplar: ${exemplar.domain} (${exemplar.files.length} files) for target domain "${domain}"`);
      }
    } catch (err: any) {
      console.log(`[context] RAG exemplar search error: ${err.message}`);
    }
  }

  // ── TIER 3: Fix-pass context ──
  // If Reviewer sent this back, inject the CURRENT disk state of mentioned files.
  const fixInfo = detectFixPass(sortedComments);
  if (fixInfo.isFixPass) {
    fileContext += '\n\n== FIX PASS — Reviewer sent this back for fixes ==\n';
    fileContext += 'The Reviewer found issues with your previous output. Fix ONLY what they flagged.\n';
    fileContext += 'Read their feedback carefully and make targeted edits.\n\n';

    if (fixInfo.reviewerFeedback) {
      fileContext += `== REVIEWER FEEDBACK ==\n${fixInfo.reviewerFeedback}\n\n`;
    }

    // Read current state of files mentioned by Reviewer
    if (fixInfo.mentionedFiles.length > 0) {
      fileContext += '== CURRENT STATE OF FLAGGED FILES (on disk) ==\n';
      for (const filePath of fixInfo.mentionedFiles) {
        const content = readWorkspaceFile(filePath, maxPerFile);
        if (content) {
          fileContext += `\n--- ${filePath} (current on disk — edit this) ---\n${content}\n`;
        }
      }
    }
  } else {
    // First pass — also inject Tech Lead file references (existing behavior)
    const techLeadFiles = new Set<string>();
    const filePathRegex = /[`']?([\w./\\-]+\.(tsx?|json))[`']?/g;
    for (const comment of sortedComments) {
      if (comment.authorAgentId === AGENTS['tech lead']) {
        for (const match of comment.body.matchAll(filePathRegex)) {
          if (match[1].match(/\.(tsx?|json)$/)) techLeadFiles.add(match[1]);
        }
        break;
      }
    }
    if (techLeadFiles.size > 0) {
      fileContext += '\n\n== TECH LEAD FILE REFERENCES ==\n';
      for (const filePath of techLeadFiles) {
        const content = readWorkspaceFile(filePath, maxPerFile);
        if (content) {
          fileContext += `\n--- ${filePath} (current) ---\n${content}\n`;
        }
      }
    }
  }

  // ── Implementation directive ──
  fileContext += '\n\n== IMPLEMENTATION INSTRUCTION ==\n';
  fileContext += 'DO NOT write analysis, summaries, or "let me check" messages.\n';
  fileContext += 'DO NOT describe what you will do - JUST DO IT.\n';
  fileContext += 'Output each file using: FILE: path/to/file.ext\\n```lang\\ncode\\n```\n';
  fileContext += 'Write ALL required files in ONE response.\n';
  fileContext += 'When modifying shared files (db.types.ts, services.enum.ts, index.ts):\n';
  fileContext += '  - KEEP all existing content\n';
  fileContext += '  - ADD your new entries alongside existing ones\n';
  fileContext += '  - Do NOT remove or replace existing exports/types/imports\n';

  return baseContext + fileContext;
}

function getAgentName(agentId: string): string {
  const names: Record<string, string> = {
    [AGENTS.strategist]: 'Strategist',
    [AGENTS['tech lead']]: 'Tech Lead',
    [AGENTS['local builder']]: 'Local Builder',
    [AGENTS.reviewer]: 'Reviewer',
    [AGENTS.sentinel]: 'Sentinel',
    [AGENTS.deployer]: 'Deployer',
    [AGENTS['visual reviewer']]: 'Visual Reviewer',
    [AGENTS['diff guardian']]: 'Diff Guardian',
    [AGENTS['complexity router']]: 'Complexity Router',
  };
  return names[agentId] || agentId.slice(0, 8);
}

function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
  ]);
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !stopwords.has(w));
}
