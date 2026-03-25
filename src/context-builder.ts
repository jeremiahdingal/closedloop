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
 * Get compact project conventions for code-generating agents (Tech Lead, Local Builder).
 * Reads the Key Patterns and Styling sections from PROJECT_STRUCTURE.md.
 */
function getProjectConventions(): string {
  const structurePath = path.join(WORKSPACE, 'PROJECT_STRUCTURE.md');
  if (!fs.existsSync(structurePath)) return '';

  try {
    const content = fs.readFileSync(structurePath, 'utf8');
    // Extract the Key Patterns, Styling, Imports, and Naming sections
    const sections: string[] = [];
    const sectionRegex = /^## (Key Patterns|Styling|Imports|Naming|Build)\b[\s\S]*?(?=\n## |\n$)/gm;
    let m;
    while ((m = sectionRegex.exec(content)) !== null) {
      sections.push(m[0].trim());
    }
    if (sections.length > 0) {
      return '\n\n== PROJECT CONVENTIONS (MUST FOLLOW) ==\n' + sections.join('\n\n') + '\n';
    }
    // Fallback: return truncated full file
    return '\n\n== PROJECT CONVENTIONS ==\n' + truncate(content, 3000) + '\n';
  } catch {
    return '';
  }
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

  // Tech Lead and Local Builder get project conventions for correct code generation
  if (currentAgentId === AGENTS['tech lead'] || currentAgentId === AGENTS['local builder']) {
    briefing += getProjectConventions();
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

/**
 * Build enhanced context for Local Builder including RAG-retrieved files.
 */
export async function buildLocalBuilderContext(
  issueId: string,
  currentAgentId: string
): Promise<string | null> {
  const baseContext = await buildIssueContext(issueId, currentAgentId);
  if (!baseContext) return null;

  // Get comments to find which files are being discussed
  const comments = await getIssueComments(issueId);
  const filesToRead = new Set<string>();

  // Extract file paths from Tech Lead's task assignment (most recent relevant comment)
  const filePathRegex = /[`']?([\w./\\-]+\.(tsx?|json))[`']?/g;
  for (const comment of comments.slice(0, 5)) {
    if (comment.authorAgentId === AGENTS['tech lead']) {
      const matches = comment.body.matchAll(filePathRegex);
      for (const match of matches) {
        const filePath = match[1];
        if (filePath.match(/\.(tsx?|json)$/)) {
          filesToRead.add(filePath);
        }
      }
      break;
    }
  }

  // Build file context section
  let fileContext = '\n\n== EXISTING FILES (for reference ONLY - DO NOT re-analyze) ==\n';
  fileContext += 'QUICK IMPLEMENTATION GUIDE: Look at these files to understand the current structure.\n';
  fileContext += 'Then IMPLEMENT the required changes directly. DO NOT write analysis or summaries.\n';
  fileContext += 'Output code using FILE: path/to/file.ext format.\n\n';

  let hasFiles = false;
  for (const filePath of filesToRead) {
    const fullPath = path.join(WORKSPACE, filePath);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const truncated = truncate(content, 1500);
        fileContext += `\n--- ${filePath} (current) ---\n${truncated}\n`;
        hasFiles = true;
      } catch (err: any) {
        console.log(`[context] Could not read ${filePath}: ${err.message}`);
      }
    }
  }

  if (!hasFiles) {
    fileContext += '(No existing files - you are creating new files)\n';
  }

  // Add RAG-retrieved context if available
  if (ragIndexer) {
    try {
      const issue = await getIssueDetails(issueId);
      const keywords = extractKeywords(issue?.description || issue?.title || '');
      const relevantFiles = await ragIndexer.search(keywords.join(' '), { limit: 10 });

      if (relevantFiles && relevantFiles.length > 0) {
        fileContext += '\n\n== RAG-RETRIEVED RELEVANT FILES ==\n';
        for (const result of relevantFiles) {
          fileContext += `- ${result.metadata.path}: ${result.metadata.purpose}\n`;
          fileContext += `  Exports: ${result.metadata.exports}\n`;
        }
      }
    } catch (err: any) {
      console.log(`[context] RAG search error: ${err.message}`);
    }
  }

  // Add strong implementation directive
  fileContext += '\n\n== IMPLEMENTATION INSTRUCTION ==\n';
  fileContext += 'DO NOT write analysis, summaries, or "let me check" messages.\n';
  fileContext += 'DO NOT describe what you will do - JUST DO IT.\n';
  fileContext += 'Output each file using: FILE: path/to/file.ext\\n```lang\\ncode\\n```\n';
  fileContext += 'Write ALL required files in ONE response.\n';

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
