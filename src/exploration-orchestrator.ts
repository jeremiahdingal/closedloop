/**
 * Parallel Worktree Exploration Orchestrator
 *
 * For complex/ambiguous tasks, spawns multiple builder approaches
 * in separate git worktrees. Each approach runs sequentially (Ollama
 * can only serve one model at a time on consumer hardware), but
 * results are isolated. Reviewer picks the best approach.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspace, getOllamaPorts, getAgentModel } from './config';
import { callOpenCodeCLI } from './remote-ai';
import { getIssueDetails, postComment, getIssueComments } from './paperclip-api';
import { AGENTS } from './agent-types';
import { applyCodeBlocks } from './code-extractor';
import { buildLocalBuilderContext } from './context-builder';
import { truncate } from './utils';
import {
  createWorktree,
  removeWorktree,
  cleanupWorktrees,
  getWorktreeDiffStats,
  getWorktreeDiff,
  mergeWinningApproach,
} from './worktree-ops';
import {
  ApproachHint,
  ApproachResult,
  ExplorationState,
  WorktreeInfo,
} from './types';

// In-memory exploration state
export const explorationStates = new Map<string, ExplorationState>();

// Default approaches when Tech Lead doesn't specify explicit ones
const DEFAULT_APPROACHES: ApproachHint[] = [
  {
    label: 'A',
    description:
      'Implement with MINIMAL changes to existing files. Prefer modifying existing modules over creating new ones. Follow the existing code patterns exactly.',
  },
  {
    label: 'B',
    description:
      'Implement with CLEAN SEPARATION. Create new dedicated modules for the new functionality. Keep existing files untouched where possible. Prioritize maintainability and single-responsibility.',
  },
];

/**
 * Parse approach hints from Tech Lead output.
 * Looks for [EXPLORE] block with ## Approach A: / ## Approach B: headers.
 */
export function parseApproachHints(content: string): ApproachHint[] | null {
  // Look for [EXPLORE] marker
  if (!content.includes('[EXPLORE]')) return null;

  const approaches: ApproachHint[] = [];
  const approachRegex = /##\s*Approach\s+([A-Z]):\s*(.*?)(?=##\s*Approach\s+[A-Z]:|$)/gs;

  let match;
  while ((match = approachRegex.exec(content)) !== null) {
    approaches.push({
      label: match[1],
      description: match[2].trim(),
    });
  }

  return approaches.length >= 2 ? approaches : null;
}

/**
 * Build a builder prompt with approach-specific instructions injected.
 */
export function buildApproachPrompt(
  baseContext: string,
  approach: ApproachHint
): string {
  const approachDirective = [
    '',
    '== EXPLORATION MODE: APPROACH ' + approach.label + ' ==',
    'You are implementing ONE specific approach to this task.',
    'Follow these approach-specific instructions strictly:',
    '',
    approach.description,
    '',
    '== END APPROACH DIRECTIVE ==',
    '',
  ].join('\n');

  return baseContext + approachDirective;
}

/**
 * Run a single builder approach in a worktree.
 * Calls Ollama directly (bypassing the proxy loop) with approach-specific context.
 */
async function runBuilderInWorktree(
  issueId: string,
  approach: ApproachHint,
  worktree: WorktreeInfo
): Promise<ApproachResult> {
  const { ollamaPort } = getOllamaPorts();
  const model = getAgentModel('local builder') || 'qwen2.5-coder:14b';
  const ws = getWorkspace();
  const result: ApproachResult = {
    label: approach.label,
    worktree,
    buildSuccess: false,
    buildOutput: '',
    filesWritten: [],
    fileContents: {},
    diffStats: '',
  };

  try {
    // Build context for the builder (using main workspace for RAG/file reading)
    const baseContext = await buildLocalBuilderContext(issueId, AGENTS['local builder']);
    if (!baseContext) {
      result.buildOutput = 'Failed to build context';
      return result;
    }

    // Inject approach-specific directive
    const prompt = buildApproachPrompt(baseContext, approach);

    console.log(`[explore] Running approach ${approach.label} in ${worktree.path}`);
    console.log(`[explore] Model: ${model}, prompt length: ${prompt.length}`);

    // Call Ollama via OpenCode CLI
    const content = await callOpenCodeCLI(prompt, '', model);

    if (!content.trim()) {
      result.buildOutput = 'Builder produced no output';
      return result;
    }

    // Extract code blocks
    const { written, fileContents } = applyCodeBlocks(content, worktree.path);
    result.filesWritten = written;
    result.fileContents = fileContents;

    if (written.length === 0) {
      result.buildOutput = 'Builder produced no code blocks';
      return result;
    }

    // Write files to the worktree
    for (const f of written) {
      const fullPath = path.join(worktree.path, f);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileContents[f]);
    }

    // Stage and commit in the worktree
    const wtOpts = { cwd: worktree.path, stdio: 'pipe' as const, timeout: 30000 };
    for (const f of written) {
      execSync(`git add "${f}"`, wtOpts);
    }

    try {
      execSync(
        `git commit -m "Exploration approach ${approach.label}: ${written.length} files"`,
        wtOpts
      );
    } catch (commitErr: any) {
      const output = commitErr.stdout?.toString() || commitErr.stderr?.toString() || '';
      if (output.includes('nothing to commit')) {
        console.log(`[explore] Approach ${approach.label}: nothing to commit (identical files)`);
        result.buildOutput = 'No changes from existing code';
        return result;
      }
      throw commitErr;
    }

    // Run build in the worktree
    console.log(`[explore] Building approach ${approach.label}...`);
    try {
      execSync('yarn build --force', { ...wtOpts, timeout: 120000 });
      result.buildSuccess = true;
      result.buildOutput = 'Build passed';
      console.log(`[explore] Approach ${approach.label}: BUILD PASSED`);
    } catch (buildErr: any) {
      const stdout = buildErr.stdout?.toString() || '';
      const stderr = buildErr.stderr?.toString() || '';
      result.buildOutput = truncate((stdout + '\n' + stderr).trim(), 3000);
      console.log(`[explore] Approach ${approach.label}: BUILD FAILED`);
    }

    // Get diff stats
    result.diffStats = getWorktreeDiffStats(worktree, ws);
  } catch (err: any) {
    console.error(`[explore] Approach ${approach.label} error:`, err.message);
    result.buildOutput = `Error: ${err.message}`;
  }

  return result;
}

/**
 * Build a comparison prompt for the Reviewer to select the best approach.
 */
export function buildComparisonPrompt(state: ExplorationState): string {
  const lines: string[] = [
    '== PARALLEL EXPLORATION RESULTS ==',
    `${state.results.length} approaches were attempted for this issue.`,
    'You MUST pick the BEST approach or REJECT ALL.',
    '',
  ];

  for (const result of state.results) {
    lines.push(`--- Approach ${result.label} ---`);
    lines.push(`Build: ${result.buildSuccess ? '✅ PASSED' : '❌ FAILED'}`);
    lines.push(`Files changed: ${result.filesWritten.length}`);

    if (result.diffStats) {
      lines.push(`Diff stats:\n${result.diffStats}`);
    }

    if (!result.buildSuccess) {
      lines.push(`Build error:\n${truncate(result.buildOutput, 500)}`);
    }

    // Show truncated diff for passing approaches
    if (result.buildSuccess) {
      const diff = getWorktreeDiff(result.worktree, 150);
      if (diff) {
        lines.push(`\nDiff:\n\`\`\`\n${diff}\n\`\`\``);
      }
    }

    lines.push('');
  }

  const passingCount = state.results.filter(r => r.buildSuccess).length;

  if (passingCount === 0) {
    lines.push('⚠️ ALL approaches failed to build. Respond with: REJECTED: [reason]');
  } else if (passingCount === 1) {
    const passing = state.results.find(r => r.buildSuccess)!;
    lines.push(`Only approach ${passing.label} passed the build. Verify it looks correct.`);
    lines.push(`Respond with: SELECTED: Approach ${passing.label} [brief justification]`);
    lines.push('Or if it looks wrong: REJECTED: [reason]');
  } else {
    lines.push('Multiple approaches passed. Compare the diffs and pick the best one.');
    lines.push('Respond with: SELECTED: Approach [X] [brief justification]');
    lines.push('Or reject all: REJECTED: [reason]');
  }

  return lines.join('\n');
}

/**
 * Parse the Reviewer's selection from their response.
 * Returns the selected approach label or null.
 */
export function parseReviewerSelection(content: string): { selected: string | null; rejected: boolean; reason: string } {
  const selectedMatch = content.match(/SELECTED:\s*Approach\s+([A-Z])/i);
  if (selectedMatch) {
    return { selected: selectedMatch[1].toUpperCase(), rejected: false, reason: '' };
  }

  const rejectedMatch = content.match(/REJECTED:\s*(.*)/i);
  if (rejectedMatch) {
    return { selected: null, rejected: true, reason: rejectedMatch[1].trim() };
  }

  // Fallback: look for "approach A" / "approach B" mentions in approval context
  const approachMention = content.match(/(?:pick|choose|select|prefer|better|best)\s+approach\s+([A-Z])/i);
  if (approachMention) {
    return { selected: approachMention[1].toUpperCase(), rejected: false, reason: '' };
  }

  return { selected: null, rejected: false, reason: 'Could not parse selection' };
}

/**
 * Run the full parallel exploration workflow.
 * Called when a high-complexity issue enters the pipeline.
 */
export async function runExploration(
  issueId: string,
  approaches?: ApproachHint[]
): Promise<ExplorationState> {
  const hints = approaches || DEFAULT_APPROACHES;
  const ws = getWorkspace();

  // Initialize state
  const state: ExplorationState = {
    issueId,
    approaches: hints,
    results: [],
    status: 'running',
    createdAt: Date.now(),
  };
  explorationStates.set(issueId, state);

  await postComment(
    issueId,
    null,
    `🔀 **Parallel Exploration Started**\n\n` +
    `Spawning ${hints.length} approaches in separate worktrees:\n` +
    hints.map(a => `- **Approach ${a.label}:** ${truncate(a.description, 100)}`).join('\n') +
    `\n\nEach approach runs sequentially (shared GPU). Results will be compared by Reviewer.`
  );

  // Run each approach sequentially in its own worktree
  for (const approach of hints) {
    let worktree: WorktreeInfo | null = null;
    try {
      worktree = await createWorktree(issueId, approach.label, ws);
      const result = await runBuilderInWorktree(issueId, approach, worktree);
      state.results.push(result);

      await postComment(
        issueId,
        null,
        `Approach ${approach.label}: ${result.buildSuccess ? '✅ Build PASSED' : '❌ Build FAILED'} ` +
        `(${result.filesWritten.length} files)`
      );
    } catch (err: any) {
      console.error(`[explore] Approach ${approach.label} crashed:`, err.message);
      if (worktree) {
        state.results.push({
          label: approach.label,
          worktree,
          buildSuccess: false,
          buildOutput: `Crash: ${err.message}`,
          filesWritten: [],
          fileContents: {},
          diffStats: '',
        });
      }
    }
  }

  // Update state
  const passingCount = state.results.filter(r => r.buildSuccess).length;

  if (passingCount === 0) {
    state.status = 'failed';
    await postComment(
      issueId,
      null,
      `⚠️ **All ${hints.length} exploration approaches failed to build.**\n` +
      `Sending back to Tech Lead for revised approach.`
    );
    // Cleanup
    cleanupWorktrees(issueId, ws);
    explorationStates.delete(issueId);
    return state;
  }

  if (passingCount === 1) {
    // Only one approach passed — auto-select it
    const winner = state.results.find(r => r.buildSuccess)!;
    state.selectedApproach = winner.label;
    state.status = 'merged';

    await postComment(
      issueId,
      null,
      `🏆 **Auto-selected Approach ${winner.label}** (only passing approach)\n\n` +
      `Files: ${winner.filesWritten.length}\n${winner.diffStats}`
    );

    // Merge winner and cleanup
    await mergeWinningApproach(issueId, winner.worktree, ws);
    cleanupWorktrees(issueId, ws);
    explorationStates.delete(issueId);
    return state;
  }

  // Multiple approaches passed — need Reviewer comparison
  state.status = 'comparing';

  const comparisonPrompt = buildComparisonPrompt(state);
  await postComment(issueId, null, comparisonPrompt);

  // State stays in memory for handleReviewerSelection() to process
  return state;
}

/**
 * Handle the Reviewer's selection after comparing approaches.
 * Called from proxy-server when Reviewer responds to a comparison.
 */
export async function handleReviewerSelection(
  issueId: string,
  reviewContent: string
): Promise<{ handled: boolean; merged: boolean }> {
  const state = explorationStates.get(issueId);
  if (!state || state.status !== 'comparing') {
    return { handled: false, merged: false };
  }

  const ws = getWorkspace();
  const selection = parseReviewerSelection(reviewContent);

  if (selection.rejected) {
    state.status = 'failed';
    await postComment(
      issueId,
      null,
      `❌ **Reviewer rejected all approaches:** ${selection.reason}\nSending back to Tech Lead.`
    );
    cleanupWorktrees(issueId, ws);
    explorationStates.delete(issueId);
    return { handled: true, merged: false };
  }

  if (selection.selected) {
    const winner = state.results.find(r => r.label === selection.selected && r.buildSuccess);
    if (!winner) {
      await postComment(
        issueId,
        null,
        `⚠️ Selected approach ${selection.selected} is not valid or did not pass build. Please select again.`
      );
      return { handled: true, merged: false };
    }

    state.selectedApproach = winner.label;
    state.status = 'merged';

    await postComment(
      issueId,
      null,
      `🏆 **Selected Approach ${winner.label}**\n\nMerging onto issue branch...`
    );

    await mergeWinningApproach(issueId, winner.worktree, ws);
    cleanupWorktrees(issueId, ws);
    explorationStates.delete(issueId);

    return { handled: true, merged: true };
  }

  // Could not parse selection
  await postComment(
    issueId,
    null,
    `Could not understand your selection. Please respond with:\n` +
    `- "SELECTED: Approach [X]" to pick an approach\n` +
    `- "REJECTED: [reason]" to reject all`
  );
  return { handled: true, merged: false };
}

/**
 * Check if an issue is in exploration mode.
 */
export function isExploring(issueId: string): boolean {
  return explorationStates.has(issueId);
}

/**
 * Get the exploration state for an issue.
 */
export function getExplorationState(issueId: string): ExplorationState | undefined {
  return explorationStates.get(issueId);
}
