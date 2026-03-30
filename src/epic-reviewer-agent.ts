/**
 * Epic Reviewer Agent - remote review, repair, and build authority for epics.
 *
 * Ticket-level agents no longer run builds. Epic Reviewer is the only automated
 * build-and-repair loop, with a maximum of 5 attempts per epic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { collectMonorepoContext } from './context-builder';
import {
  getWorkspace,
  getCompanyId,
  getPaperclipApiUrl,
  getEpicReviewerRequireOpenPrs,
  loadConfig,
} from './config';
import { postComment, getIssueComments } from './paperclip-api';
import { callRemoteLLM } from './remote-ai';
import { getEpicTickets, getActionableEpicTickets } from './goal-system';
import { formatBranchName, getBranchName, getDefaultBranch } from './git-ops';
import { truncate } from './utils';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const BASE_WORKSPACE = getWorkspace();
const EPIC_REVIEW_WORKTREE_ROOT = path.join(BASE_WORKSPACE, '.paperclip-epic-review');
const MAX_EPIC_RETRIES = 5;
const GH_CLI = process.env.GH_CLI || 'C:\\Program Files\\GitHub CLI\\gh';
let activeEpicWorkspace = BASE_WORKSPACE;
let epicReviewerInFlight = false;

interface EpicTicket {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status: string;
  goalId: string;
}

interface EpicWithTickets {
  goal: any;
  tickets: EpicTicket[];
}

interface TicketWithBranch extends EpicTicket {
  branchName: string;
}

interface PullRequestHead {
  number: number;
  headRefName: string;
}

interface FileFix {
  target: string;
  targetType: 'ticket' | 'reconciliation';
  filePath: string;
  operation: 'write' | 'delete';
  content?: string;
}

interface ReviewResult {
  approved: boolean;
  goalSatisfied: boolean;
  fixes: FileFix[];
  summary: string;
}

interface BuildCheck {
  branchName: string;
  ticketIdentifier: string;
  passed: boolean;
  output?: string;
}

interface EpicRetryState {
  attemptCount: number;
  injectedFullContext: boolean;
  lastSummary: string;
  lastBuildErrors: string;
  lastAppliedFixes: string[];
  overlappingFiles: string[];
  overlapSummary: string;
  reconciliationBranchName: string;
  reconciliationActive: boolean;
}

const epicRetryStates = new Map<string, EpicRetryState>();

async function postTicketsComment(tickets: EpicTicket[], message: string): Promise<void> {
  for (const ticket of tickets) {
    await postComment(ticket.id, null, message).catch(() => {});
  }
}

async function postEpicComment(epic: EpicWithTickets, message: string): Promise<void> {
  await postTicketsComment(epic.tickets, message);
}

function getEpicWorkspace(): string {
  return activeEpicWorkspace;
}

function getEpicWorktreePath(): string {
  return path.join(EPIC_REVIEW_WORKTREE_ROOT, 'active');
}

function resetEpicWorkspace(): void {
  activeEpicWorkspace = BASE_WORKSPACE;
}

function removeEpicWorktree(worktreePath: string): void {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: BASE_WORKSPACE,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {}

  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch {}
}

function prepareEpicWorktree(): string {
  const defaultBranch = getDefaultBranch();
  const worktreePath = getEpicWorktreePath();
  fs.mkdirSync(EPIC_REVIEW_WORKTREE_ROOT, { recursive: true });
  removeEpicWorktree(worktreePath);

  execSync(`git worktree add --force "${worktreePath}" ${defaultBranch}`, {
    cwd: BASE_WORKSPACE,
    stdio: 'pipe',
    timeout: 60000,
  });

  activeEpicWorkspace = worktreePath;
  return worktreePath;
}

export function resetEpicReviewerState(): void {
  epicRetryStates.clear();
}

export function getEpicReviewerState(goalId: string): EpicRetryState | undefined {
  return epicRetryStates.get(goalId);
}

function normalizeBranchName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^origin\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+$/, '');
}

function getTicketBranchPrefix(identifier: string): string {
  return String(identifier || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+$/, '');
}

function listOpenPullRequestHeads(): PullRequestHead[] {
  try {
    const raw = execSync(
      `"${GH_CLI}" pr list --state open --json number,headRefName`,
      {
        cwd: BASE_WORKSPACE,
        stdio: 'pipe',
        timeout: 25000,
      }
    ).toString();
    const data = JSON.parse(raw) as PullRequestHead[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function hasOpenPrForBranch(branchName: string, ticketIdentifier: string): boolean {
  const expected = normalizeBranchName(branchName);
  const ticketPrefix = getTicketBranchPrefix(ticketIdentifier);

  const openPrs = listOpenPullRequestHeads();
  if (openPrs.length === 0) return false;

  for (const pr of openPrs) {
    const head = normalizeBranchName(pr.headRefName);
    if (!head.startsWith(`${ticketPrefix}-`) && head !== ticketPrefix) {
      continue;
    }
    if (head === expected || head.startsWith(expected) || expected.startsWith(head)) {
      return true;
    }
  }

  return false;
}

function listBranchCandidatesForTicket(identifier: string): string[] {
  const ticketPrefix = getTicketBranchPrefix(identifier);
  if (!ticketPrefix) return [];

  try {
    const raw = execSync('git branch -a --format="%(refname:short)"', {
      cwd: getEpicWorkspace(),
      stdio: 'pipe',
      timeout: 15000,
      encoding: 'utf8',
    }).toString();

    const seen = new Set<string>();
    const matches: string[] = [];
    for (const line of raw.split('\n')) {
      const clean = line.trim().replace(/^origin\//, '');
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      const normalized = normalizeBranchName(clean);
      if (normalized.startsWith(`${ticketPrefix}-`) || normalized === ticketPrefix) {
        matches.push(clean);
      }
    }
    return matches;
  } catch {
    return [];
  }
}

function pickBestBranchForTicket(expectedBranch: string, identifier: string): string {
  const candidates = listBranchCandidatesForTicket(identifier);
  if (candidates.length === 0) return expectedBranch;

  const expected = normalizeBranchName(expectedBranch);
  const exact = candidates.find(c => normalizeBranchName(c) === expected);
  if (exact) return exact;

  const forward = candidates.find(c => normalizeBranchName(c).startsWith(expected));
  if (forward) return forward;

  const backward = candidates.find(c => expected.startsWith(normalizeBranchName(c)));
  if (backward) return backward;

  return candidates[0];
}

async function collectReadyEpics(): Promise<EpicWithTickets[]> {
  const goalsRes = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/goals`);
  if (!goalsRes.ok) return [];

  const goals = await goalsRes.json() as any[];
  const activeGoals = goals.filter(g => g.status === 'active' || g.status === 'in_review');

  const epics: EpicWithTickets[] = [];
  const requireOpenPrs = getEpicReviewerRequireOpenPrs();
  for (const goal of activeGoals) {
    const allTickets = await getActionableEpicTickets(goal.id);
    if (allTickets.length === 0) continue;

    const notInReview = allTickets.filter(t => t.status !== 'in_review');
    if (notInReview.length > 0) {
      await postTicketsComment(
        allTickets as any,
        `**Epic Reviewer Gate: Waiting for PR-First Progression**\n\nEpic review is blocked until every ticket is \`in_review\`.\n\nNot ready:\n${notInReview.map(t => `- ${t.identifier} (${t.status})`).join('\n')}`
      );
      continue;
    }

    const tickets = allTickets.filter(t => t.status === 'in_review');
    if (tickets.length === 0) continue;

    if (requireOpenPrs) {
      const ticketBranches = await withBranches(tickets as any);
      const missingPrBranches: string[] = [];
      for (const ticket of ticketBranches) {
        const hasPr = hasOpenPrForBranch(ticket.branchName, ticket.identifier);
        if (!hasPr) {
          missingPrBranches.push(`${ticket.identifier} (${ticket.branchName})`);
        }
      }
      if (missingPrBranches.length > 0) {
        await postTicketsComment(
          tickets as any,
          `**Epic Reviewer Gate: Waiting for PRs**\n\nEpic review is blocked until every ticket has an open PR.\n\nMissing:\n${missingPrBranches.map(b => `- ${b}`).join('\n')}`
        );
        console.log(
          `[epic-reviewer-agent] Skipping ${goal.title} - waiting for open PRs: ${missingPrBranches.join(', ')}`
        );
        continue;
      }
    }

    epics.push({ goal, tickets });
  }

  return epics;
}

async function withBranches(tickets: EpicTicket[]): Promise<TicketWithBranch[]> {
  const mapped = await Promise.all(
    tickets.map(async ticket => {
      let branchName = '';
      try {
        branchName = await getBranchName(ticket.id);
      } catch {}

      if (!branchName) {
        const identifier = String(ticket.identifier || ticket.id || 'ticket');
        const title = String(ticket.title || 'code-changes');
        branchName = formatBranchName(identifier, title);
        console.log(`[epic-reviewer-agent] Recovered missing branch name for ${ticket.identifier || ticket.id}: ${branchName}`);
      }

      branchName = pickBestBranchForTicket(branchName, ticket.identifier || ticket.id);

      return {
        ...ticket,
        branchName,
      };
    })
  );
  return mapped;
}

async function collectTicketDiff(ticket: TicketWithBranch): Promise<string> {
  try {
    const defaultBranch = resolveRevisionName(getDefaultBranch()) || getDefaultBranch();
    const ticketBranch = resolveRevisionName(ticket.branchName);
    if (!ticketBranch) {
      console.log(`[epic-reviewer-agent] Could not resolve branch for ${ticket.identifier}: ${ticket.branchName}`);
      return '';
    }

    const diff = execSync(`git diff ${defaultBranch}...${ticketBranch} -- . ":(exclude)docs/screenshots"`, {
      cwd: getEpicWorkspace(),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    }).toString();
    return truncate(diff, 20000);
  } catch (err: any) {
    console.log(`[epic-reviewer-agent] Could not get diff for ${ticket.identifier}: ${err.message}`);
    return '';
  }
}

async function collectChangedFiles(ticket: TicketWithBranch): Promise<string[]> {
  try {
    const defaultBranch = resolveRevisionName(getDefaultBranch()) || getDefaultBranch();
    const ticketBranch = resolveRevisionName(ticket.branchName);
    if (!ticketBranch) {
      console.log(`[epic-reviewer-agent] Could not resolve changed-files branch for ${ticket.identifier}: ${ticket.branchName}`);
      return [];
    }

    const changed = execSync(`git diff ${defaultBranch}...${ticketBranch} --name-only -- . ":(exclude)docs/screenshots"`, {
      cwd: getEpicWorkspace(),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    }).toString();
    return changed
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch (err: any) {
    console.log(`[epic-reviewer-agent] Could not get changed files for ${ticket.identifier}: ${err.message}`);
    return [];
  }
}

async function detectOverlappingFiles(epic: EpicWithTickets): Promise<{
  overlappingFiles: string[];
  overlapSummary: string;
}> {
  const tickets = await withBranches(epic.tickets);
  const fileOwners = new Map<string, string[]>();

  for (const ticket of tickets) {
    const changedFiles = await collectChangedFiles(ticket);
    for (const filePath of changedFiles) {
      const owners = fileOwners.get(filePath) || [];
      owners.push(ticket.identifier);
      fileOwners.set(filePath, owners);
    }
  }

  const overlaps = Array.from(fileOwners.entries())
    .filter(([, owners]) => owners.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));

  const overlappingFiles = overlaps.map(([filePath]) => filePath);
  const overlapSummary = overlaps.length === 0
    ? ''
    : overlaps
        .map(([filePath, owners]) => `- ${filePath} <- ${owners.join(', ')}`)
        .join('\n');

  return { overlappingFiles, overlapSummary };
}

function getReconciliationBranchName(epic: EpicWithTickets): string {
  const goalSlug = String(epic.goal.title || epic.goal.id || 'epic')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'epic';
  return `epic/${goalSlug}-${String(epic.goal.id).slice(0, 8)}-reconcile`;
}

function getConflictedFiles(): string[] {
  try {
    return execSync('git diff --name-only --diff-filter=U', {
      cwd: getEpicWorkspace(),
      encoding: 'utf8',
      timeout: 10000,
    })
      .toString()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getFilesContainingConflictMarkers(filePaths: string[]): string[] {
  return filePaths.filter(filePath => {
    try {
      const fullPath = path.join(getEpicWorkspace(), filePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      return content.includes('<<<<<<<') && content.includes('=======') && content.includes('>>>>>>>');
    } catch {
      return false;
    }
  });
}

function readConflictedFileContents(filePaths: string[]): string {
  const sections: string[] = [];

  for (const filePath of filePaths) {
    try {
      const fullPath = path.join(getEpicWorkspace(), filePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      sections.push(`### ${filePath}\n\`\`\`\n${truncate(content, 12000)}\n\`\`\``);
    } catch (err: any) {
      sections.push(`### ${filePath}\nCould not read conflicted file: ${err.message}`);
    }
  }

  return sections.join('\n\n');
}

function tryGit(command: string, timeout = 30000): void {
  execSync(command, {
    cwd: getEpicWorkspace(),
    stdio: 'pipe',
    timeout,
  });
}

function resolveRevisionName(revision: string): string | null {
  const candidates = [revision, `origin/${revision}`];
  for (const candidate of candidates) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 10000,
      });
      return candidate;
    } catch {}
  }
  return null;
}

function checkoutDetachedRevision(revision: string): string {
  const resolved = resolveRevisionName(revision) || revision;
  execSync(`git checkout --detach ${resolved}`, {
    cwd: getEpicWorkspace(),
    stdio: 'pipe',
    timeout: 10000,
  });
  return resolved;
}

function pushHeadToBranch(branchName: string): void {
  try {
    execSync(`git push origin HEAD:${branchName}`, {
      cwd: getEpicWorkspace(),
      stdio: 'pipe',
      timeout: 60000,
    });
    return;
  } catch (err: any) {
    const output = `${err.stdout?.toString() || ''}${err.stderr?.toString() || ''}`;
    if (!/non-fast-forward|fetch first|rejected/i.test(output)) {
      throw err;
    }
    console.log('[telemetry] EPIC_PUSH_RETRY reason=non_fast_forward');
  }

  // Branch is behind remote; keep automation moving while still protecting against
  // blind overwrite of unrelated remote updates.
  execSync(`git push --force-with-lease origin HEAD:${branchName}`, {
    cwd: getEpicWorkspace(),
    stdio: 'pipe',
    timeout: 60000,
  });
  console.log('[telemetry] EPIC_PUSH_RETRY mode=force_with_lease');
}

async function ensureReconciliationBranch(epic: EpicWithTickets, state: EpicRetryState): Promise<string> {
  if (state.reconciliationBranchName) {
    return state.reconciliationBranchName;
  }

  const defaultBranch = getDefaultBranch();
  const branchName = getReconciliationBranchName(epic);
  const tickets = await withBranches(epic.tickets);

  try {
    tryGit(`git checkout ${defaultBranch}`, 10000);
    try {
      tryGit(`git branch -D ${branchName}`, 10000);
    } catch {}
    tryGit(`git checkout -b ${branchName} ${defaultBranch}`, 10000);

    for (const ticket of tickets) {
      try {
        tryGit(`git merge --no-ff --no-commit ${ticket.branchName}`, 20000);
        try {
          tryGit(`git commit -m "Merge ${ticket.identifier} into ${branchName}"`, 20000);
        } catch (err: any) {
          const output = `${err.stdout?.toString() || ''}${err.stderr?.toString() || ''}`;
          if (!output.includes('nothing to commit')) {
            throw err;
          }
        }
      } catch (err: any) {
        const conflictedFiles = getConflictedFiles();
        if (conflictedFiles.length === 0) {
          throw err;
        }

        for (const filePath of conflictedFiles) {
          tryGit(`git add "${filePath}"`, 10000);
        }
        tryGit(`git commit -m "WIP unresolved reconciliation conflicts after merging ${ticket.identifier}"`, 20000);
      }
    }

    tryGit(`git push -u origin ${branchName} --force`, 60000);
    state.reconciliationBranchName = branchName;
    state.reconciliationActive = true;

    const summary = state.overlapSummary || state.overlappingFiles.map(filePath => `- ${filePath}`).join('\n');
    await postEpicComment(
      epic,
      `**Epic Reconciliation Branch Created**\n\nBranch: \`${branchName}\`\n\nOverlapping files detected:\n${summary || '- overlap detected'}`
    );

    return branchName;
  } finally {
    try {
      tryGit(`git checkout ${defaultBranch}`, 10000);
    } catch {}
  }
}

const DUPLICATE_FAMILY_REGEX = /(components|hooks|apihooks|schemas|routes|services|screens|dialogs)\//i;
const COMMON_DUPLICATE_BASENAMES = new Set(['index', 'types', 'utils', 'constants', 'schema', 'route', 'routes', 'screen']);

interface DuplicateGroup {
  basename: string;
  entries: Array<{ filePath: string; ticket: string }>;
}

function duplicateCandidateBasename(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (!DUPLICATE_FAMILY_REGEX.test(normalized)) return null;
  const basename = path.basename(normalized, path.extname(normalized)).toLowerCase();
  if (COMMON_DUPLICATE_BASENAMES.has(basename)) return null;
  return basename;
}

async function detectDuplicateBasenameGroups(tickets: TicketWithBranch[]): Promise<DuplicateGroup[]> {
  const filesByBasename = new Map<string, Array<{ filePath: string; ticket: string }>>();
  for (const ticket of tickets) {
    const changedFiles = await collectChangedFiles(ticket);
    for (const filePath of changedFiles) {
      const basename = duplicateCandidateBasename(filePath);
      if (!basename) continue;
      const entries = filesByBasename.get(basename) || [];
      entries.push({ filePath, ticket: ticket.identifier });
      filesByBasename.set(basename, entries);
    }
  }

  return Array.from(filesByBasename.entries())
    .map(([basename, entries]) => ({
      basename,
      entries: Array.from(new Map(entries.map(e => [e.filePath, e])).values()),
    }))
    .filter(group => group.entries.length > 1);
}

export async function buildReviewPrompt(epic: EpicWithTickets, state: EpicRetryState): Promise<{ prompt: string; hasDuplicateWarning: boolean }> {
  let prompt = '';
  let hasDuplicateWarning = false;

  if (!state.injectedFullContext) {
    console.log(`[epic-reviewer-agent] Collecting full monorepo context for ${epic.goal.title}`);
    prompt += `${await collectMonorepoContext()}\n\n`;
  } else {
    prompt += '## Carry Forward Context\n\n';
    prompt += `Attempt: ${state.attemptCount}/${MAX_EPIC_RETRIES}\n`;
    if (state.lastSummary) {
      prompt += `Previous summary:\n${truncate(state.lastSummary, 4000)}\n\n`;
    }
    if (state.lastAppliedFixes.length > 0) {
      prompt += `Previously applied fixes:\n${state.lastAppliedFixes.map(f => `- ${f}`).join('\n')}\n\n`;
    }
    if (state.lastBuildErrors) {
      prompt += `Previous build failures:\n\`\`\`\n${truncate(state.lastBuildErrors, 8000)}\n\`\`\`\n\n`;
    }
    if (state.overlapSummary) {
      prompt += `Overlapping files detected across ticket branches:\n${state.overlapSummary}\n\n`;
    }
  }

  prompt += `## Epic\nTitle: ${epic.goal.title}\n`;
  if (epic.goal.description) {
    prompt += `Description:\n${truncate(epic.goal.description, 2000)}\n`;
  }
  prompt += `Attempt ${state.attemptCount} of ${MAX_EPIC_RETRIES}\n\n`;

  const ticketInfos = await withBranches(epic.tickets);
  prompt += '## Tickets\n';
  for (const ticket of ticketInfos) {
    prompt += `- ${ticket.identifier}: ${ticket.title} (${ticket.branchName})\n`;
    if (ticket.description) {
      prompt += `  Description: ${truncate(ticket.description, 500)}\n`;
    }
  }
  if (state.overlapSummary) {
    prompt += `\n## Overlap Detection\n${state.overlapSummary}\n`;
  }

  // Drift ticket detection: scan comments for [DRIFT] tags emitted by Diff Guardian / Local Builder
  const driftTickets: { identifier: string; reasons: string[] }[] = [];
  for (const ticket of ticketInfos) {
    const comments = await getIssueComments(ticket.id);
    const driftReasons = comments
      .filter(c => typeof c.body === 'string' && c.body.includes('[DRIFT]'))
      .map(c => {
        const match = /\[DRIFT(?::([^\]]+))?\]/.exec(c.body as string);
        return match?.[1] ?? 'architecture drift detected';
      });
    if (driftReasons.length > 0) {
      driftTickets.push({ identifier: ticket.identifier, reasons: driftReasons });
    }
  }
  if (driftTickets.length > 0) {
    prompt += '\n## Drift-Flagged Tickets\n';
    prompt += 'These tickets were automatically flagged for duplicate/parallel-file drift. You MUST emit DELETE FILE operations for every duplicate — a review with 0 deletions for a drift ticket is incomplete.\n';
    for (const dt of driftTickets) {
      prompt += `- ${dt.identifier}: ${dt.reasons.join('; ')}\n`;
    }
    prompt += '\n';
  }

  // Duplicate-basename detection: find same-named files in different path families.
  const duplicateGroups = await detectDuplicateBasenameGroups(ticketInfos);
  if (duplicateGroups.length > 0) {
    hasDuplicateWarning = true;
    prompt += '\n## Duplicate File Warning\n';
    prompt += 'The following filenames appear in multiple locations - you MUST pick one canonical path and DELETE FILE the rest:\n';
    for (const group of duplicateGroups) {
      prompt += `- ${group.basename}:\n`;
      for (const entry of group.entries) {
        prompt += `  - ${entry.filePath} (${entry.ticket})\n`;
      }
    }
    prompt += '\n';
  }

  prompt += '\n## Ticket Diffs\n\n';

  for (const ticket of ticketInfos) {
    const diff = await collectTicketDiff(ticket);
    if (!diff) continue;
    prompt += `### ${ticket.identifier}: ${ticket.title}\n`;
    prompt += `\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  }

  if (state.reconciliationActive && state.reconciliationBranchName) {
    const defaultBranch = getDefaultBranch();
    try {
      const branchDiff = execSync(`git diff ${defaultBranch}...${state.reconciliationBranchName} -- . ":(exclude)docs/screenshots"`, {
        cwd: getEpicWorkspace(),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      }).toString();
      prompt += `## Reconciliation Branch\nBranch: ${state.reconciliationBranchName}\n\n`;
      prompt += `\`\`\`diff\n${truncate(branchDiff, 25000)}\n\`\`\`\n\n`;
    } catch (err: any) {
      prompt += `## Reconciliation Branch\nBranch: ${state.reconciliationBranchName}\nCould not collect reconciliation diff: ${err.message}\n\n`;
    }

    try {
      tryGit(`git checkout ${state.reconciliationBranchName}`, 10000);
      const conflictedFiles = getFilesContainingConflictMarkers(state.overlappingFiles);
      if (conflictedFiles.length > 0) {
        prompt += `## Conflicted Files\n${readConflictedFileContents(conflictedFiles)}\n\n`;
      }
    } finally {
      try {
        tryGit(`git checkout ${defaultBranch}`, 10000);
      } catch {}
    }
  }

  return { prompt, hasDuplicateWarning };
}

function buildSystemPrompt(): string {
  return `You are the Epic Reviewer, the only automated build-and-repair authority for this system.

You review one epic at a time using a three-phase approach:

## Phase 1 — Epic-Level Understanding (Holistic First)
Before looking at any individual ticket diff, treat all tickets as a single unified delivery. The epic is ONE feature — not a collection of independent branches.

Ask yourself:
- What is the end-to-end user flow this epic enables? (e.g. "cashier completes a sale and sees the total")
- What API endpoints, hooks, components, and types does that flow need — end to end?
- What is the MINIMAL canonical set of files to deliver it correctly?
- Which tickets are responsible for which slice of that canonical set?

Map out the ideal file structure BEFORE reading any diff. Then, when you read each diff, you are comparing actual delivery against that pre-defined ideal — not evaluating each ticket in isolation.

Signs that tickets were NOT coordinated as a single feature:
- Multiple tickets each created their own version of the same hook, component, or API client
- Ticket branches diverged in naming (e.g. one uses OrderSummary, another OrderTotalSummary for the same concept)
- A ticket created files well outside its expected scope, encroaching on another ticket's domain
- The combined output has more files than the minimal canonical set requires

These are signs of drift — and each one requires consolidation decisions in Phase 2.

## Phase 2 — Per-Ticket Audit
Review each ticket's diff against the ideal structure from Phase 1.
- Identify files that are duplicates, misplaced, or use wrong conventions.
- For every N duplicate implementations of the same concept, you MUST emit N-1 DELETE FILE operations and 1 FILE write for the canonical version.
- A review that identifies drift or duplicates but produces 0 DELETE FILE operations is INCOMPLETE. You must not approve until duplicates are resolved.

Drift symptoms that require consolidation or deletion:
- The same concept implemented in multiple parallel paths (duplicate hooks/components/modals/panels across sibling folders)
- Alternate file names for the same feature (e.g. OrderSummary vs OrderTotalSummary)
- Ticket branches creating broad adjacent files outside intended scope
- Multiple route/API/client wrappers for the same endpoint or mutation
- Mixing old conventions with current ones (e.g. StyleSheet.create in a Tamagui codebase)
- Stray generated files or package-manager artifacts outside ticket scope

Canonical location heuristics for this project:
- API hooks: packages/app/apiHooks/ (flat, not nested in subdirectories)
- Backend routes: api/src/routes/
- Shared types/schemas: packages/app/types/
- UI components: packages/app/ organized by feature area
- Use fetcherWithToken for API calls, not raw apiClient imports

## Phase 3 — Goal Satisfaction
Does the combined output of all tickets actually satisfy the epic's goal and each ticket's acceptance criteria?
- Check the epic description and each ticket's description for stated objectives.
- Verify the delivered code meets those objectives.
- If the goal is NOT satisfied, explain what is missing or wrong.

## Required Output Format

Start with:
VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED
GOAL_SATISFIED: YES or GOAL_SATISFIED: NO (with brief reason if NO)

For normal ticket-branch fixes, emit:
TICKET: SHO-XX
FILE: relative/path/to/file.ext
\`\`\`typescript
// complete file content
\`\`\`

For normal ticket-branch deletions, emit:
TICKET: SHO-XX
DELETE FILE: relative/path/to/file.ext

For reconciliation-branch fixes, emit:
TARGET: EPIC_RECONCILE
FILE: relative/path/to/file.ext
\`\`\`typescript
// complete file content
\`\`\`

For reconciliation-branch deletions, emit:
TARGET: EPIC_RECONCILE
DELETE FILE: relative/path/to/file.ext

Finish with:
SUMMARY:
brief explanation of what was done, including all deletions and consolidations

## Rules
- Output full files for writes, not diffs
- Use DELETE FILE when duplicate or wrong-path files must be removed
- Only tag files to tickets that exist in this epic
- Use TARGET: EPIC_RECONCILE only when reconciliation mode is active
- Prior build errors are high-priority signals
- If a previous attempt failed to build, focus on getting the next attempt green
- If the Duplicate File Warning section is present, you MUST address every group with DELETE FILE operations`;
}

function parseReviewResult(rawContent: string): ReviewResult {
  const content = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const fixes: FileFix[] = [];
  const approved = /VERDICT:\s*APPROVED/i.test(content);
  const ticketFileRegex = /TICKET:\s*(SHO-\d+)\s*\nFILE:\s*([^\n]+)\s*\n```[^\n]*\n([\s\S]*?)\n```/g;
  const ticketDeleteRegex = /TICKET:\s*(SHO-\d+)\s*\nDELETE FILE:\s*([^\n]+)/g;
  const reconciliationFileRegex = /TARGET:\s*EPIC_RECONCILE\s*\nFILE:\s*([^\n]+)\s*\n```[^\n]*\n([\s\S]*?)\n```/g;
  const reconciliationDeleteRegex = /TARGET:\s*EPIC_RECONCILE\s*\nDELETE FILE:\s*([^\n]+)/g;
  let match: RegExpExecArray | null;

  while ((match = ticketFileRegex.exec(content)) !== null) {
    const [, ticketIdentifier, filePath, fileContent] = match;
    fixes.push({
      target: ticketIdentifier,
      targetType: 'ticket',
      filePath: filePath.trim(),
      operation: 'write',
      content: fileContent.trim(),
    });
  }

  while ((match = ticketDeleteRegex.exec(content)) !== null) {
    const [, ticketIdentifier, filePath] = match;
    fixes.push({
      target: ticketIdentifier,
      targetType: 'ticket',
      filePath: filePath.trim(),
      operation: 'delete',
    });
  }

  while ((match = reconciliationFileRegex.exec(content)) !== null) {
    const [, filePath, fileContent] = match;
    fixes.push({
      target: 'EPIC_RECONCILE',
      targetType: 'reconciliation',
      filePath: filePath.trim(),
      operation: 'write',
      content: fileContent.trim(),
    });
  }

  while ((match = reconciliationDeleteRegex.exec(content)) !== null) {
    const [, filePath] = match;
    fixes.push({
      target: 'EPIC_RECONCILE',
      targetType: 'reconciliation',
      filePath: filePath.trim(),
      operation: 'delete',
    });
  }

  const goalSatisfied = /GOAL_SATISFIED:\s*YES/i.test(content);

  const summaryMatch = content.match(/SUMMARY:\s*([\s\S]+)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : truncate(content, 1000);
  return { approved, goalSatisfied, fixes, summary };
}

async function applyFixes(epic: EpicWithTickets, fixes: FileFix[]): Promise<string[]> {
  const applied: string[] = [];
  const defaultBranch = getDefaultBranch();
  const tickets = await withBranches(epic.tickets);
  const fixesByTicket = new Map<string, FileFix[]>();
  const reconciliationFixes = fixes.filter(fix => fix.targetType === 'reconciliation');

  for (const fix of fixes) {
    if (fix.targetType !== 'ticket') continue;
    if (!fixesByTicket.has(fix.target)) {
      fixesByTicket.set(fix.target, []);
    }
    fixesByTicket.get(fix.target)!.push(fix);
  }

  for (const ticket of tickets) {
    const ticketFixes = fixesByTicket.get(ticket.identifier);
    if (!ticketFixes || ticketFixes.length === 0) continue;

    try {
      checkoutDetachedRevision(ticket.branchName);

      for (const fix of ticketFixes) {
        const fullPath = path.join(getEpicWorkspace(), fix.filePath);
        if (fix.operation === 'delete') {
          fs.rmSync(fullPath, { force: true });
        } else {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, fix.content || '', 'utf8');
        }
        execSync(`git add "${fix.filePath}"`, { cwd: getEpicWorkspace(), stdio: 'pipe' });
        applied.push(`${ticket.identifier}: ${fix.operation === 'delete' ? 'DELETE ' : ''}${fix.filePath}`);
      }

      try {
        execSync(`git commit -m "${ticket.identifier}: Epic Reviewer automated fixes"`, {
          cwd: getEpicWorkspace(),
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch (err: any) {
        const output = `${err.stdout?.toString() || ''}${err.stderr?.toString() || ''}`;
        if (!output.includes('nothing to commit')) {
          throw err;
        }
      }

      pushHeadToBranch(ticket.branchName);

      await postComment(
        ticket.id,
        null,
        `**Epic Reviewer Automated Fixes**\n\nApplied fixes:\n${ticketFixes.map(f => `- ${f.operation === 'delete' ? 'deleted' : 'updated'} \`${f.filePath}\``).join('\n')}`
      ).catch(() => {});
    } finally {
      try {
        execSync(`git checkout ${defaultBranch}`, {
          cwd: getEpicWorkspace(),
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {}
    }
  }

  const reconciliationBranchName = fixes.find(fix => fix.targetType === 'reconciliation') ? getReconciliationBranchName(epic) : '';
  if (reconciliationBranchName && reconciliationFixes.length > 0) {
    try {
      execSync(`git checkout ${reconciliationBranchName}`, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 10000,
      });

      for (const fix of reconciliationFixes) {
        const fullPath = path.join(getEpicWorkspace(), fix.filePath);
        if (fix.operation === 'delete') {
          fs.rmSync(fullPath, { force: true });
        } else {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, fix.content || '', 'utf8');
        }
        execSync(`git add "${fix.filePath}"`, { cwd: getEpicWorkspace(), stdio: 'pipe' });
        applied.push(`EPIC_RECONCILE: ${fix.operation === 'delete' ? 'DELETE ' : ''}${fix.filePath}`);
      }

      try {
        execSync(`git commit -m "Epic Reviewer reconciliation fixes for ${epic.goal.id}"`, {
          cwd: getEpicWorkspace(),
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch (err: any) {
        const output = `${err.stdout?.toString() || ''}${err.stderr?.toString() || ''}`;
        if (!output.includes('nothing to commit')) {
          throw err;
        }
      }

      execSync(`git push origin ${reconciliationBranchName} --force`, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 60000,
      });

      await postEpicComment(
        epic,
        `**Epic Reviewer Reconciliation Fixes**\n\nApplied fixes on \`${reconciliationBranchName}\`:\n${reconciliationFixes.map(f => `- ${f.operation === 'delete' ? 'deleted' : 'updated'} \`${f.filePath}\``).join('\n')}`
      );
    } finally {
      try {
        execSync(`git checkout ${defaultBranch}`, {
          cwd: getEpicWorkspace(),
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {}
    }
  }

  return applied;
}

function getBuildCommand(): string {
  return loadConfig().commands?.build || 'yarn turbo run build --filter=@shop-diary/ui --filter=@shop-diary/app';
}

async function buildEpicBranches(epic: EpicWithTickets): Promise<BuildCheck[]> {
  const defaultBranch = getDefaultBranch();
  const buildCommand = getBuildCommand();
  const tickets = await withBranches(epic.tickets);
  const results: BuildCheck[] = [];

  for (const ticket of tickets) {
    try {
      checkoutDetachedRevision(ticket.branchName);
      execSync(buildCommand, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 180000,
      });
      results.push({
        branchName: ticket.branchName,
        ticketIdentifier: ticket.identifier,
        passed: true,
      });
    } catch (err: any) {
      const output = truncate(`${err.stdout?.toString() || ''}\n${err.stderr?.toString() || ''}`.trim(), 5000);
      results.push({
        branchName: ticket.branchName,
        ticketIdentifier: ticket.identifier,
        passed: false,
        output,
      });
    } finally {
      try {
        execSync(`git checkout ${defaultBranch}`, {
          cwd: getEpicWorkspace(),
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {}
    }
  }

  return results;
}

async function buildReconciliationBranch(branchName: string): Promise<BuildCheck[]> {
  const defaultBranch = getDefaultBranch();
  const buildCommand = getBuildCommand();

  try {
    execSync(`git checkout ${branchName}`, {
      cwd: getEpicWorkspace(),
      stdio: 'pipe',
      timeout: 10000,
    });
    execSync(buildCommand, {
      cwd: getEpicWorkspace(),
      stdio: 'pipe',
      timeout: 180000,
    });
    return [{
      branchName,
      ticketIdentifier: 'EPIC_RECONCILE',
      passed: true,
    }];
  } catch (err: any) {
    const output = truncate(`${err.stdout?.toString() || ''}\n${err.stderr?.toString() || ''}`.trim(), 5000);
    return [{
      branchName,
      ticketIdentifier: 'EPIC_RECONCILE',
      passed: false,
      output,
    }];
  } finally {
    try {
      execSync(`git checkout ${defaultBranch}`, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch {}
  }
}

async function postEpicSuccess(epic: EpicWithTickets, summary: string): Promise<void> {
  await postEpicComment(
    epic,
    `**Epic Reviewer Complete**\n\nBuild authority result: green.\n\n${summary}`
  );
}

async function postEpicFailure(epic: EpicWithTickets, state: EpicRetryState): Promise<void> {
  const message =
    `**Epic Reviewer Capped at ${MAX_EPIC_RETRIES} Attempts**\n\n` +
    `Epic Reviewer remained the build authority for this epic but could not get it green.\n\n` +
    (state.lastSummary ? `Latest summary:\n${state.lastSummary}\n\n` : '') +
    (state.lastBuildErrors ? `Latest build errors:\n\`\`\`\n${truncate(state.lastBuildErrors, 5000)}\n\`\`\`\n` : '');

  await postEpicComment(epic, message);
}

async function postEpicReviewerVisibleOutput(epic: EpicWithTickets, state: EpicRetryState, reviewContent: string): Promise<void> {
  const message =
    `**Epic Reviewer Visible Model Output ${state.attemptCount}/${MAX_EPIC_RETRIES}**\n\n` +
    `This is the model's visible response, not hidden chain-of-thought.\n\n` +
    `\`\`\`\n${truncate(reviewContent, 12000)}\n\`\`\``;

  await postEpicComment(epic, message);
}

async function processEpic(epic: EpicWithTickets): Promise<void> {
  const state = epicRetryStates.get(epic.goal.id) || {
    attemptCount: 0,
    injectedFullContext: false,
    lastSummary: '',
    lastBuildErrors: '',
    lastAppliedFixes: [],
    overlappingFiles: [],
    overlapSummary: '',
    reconciliationBranchName: '',
    reconciliationActive: false,
  };

  if (state.overlappingFiles.length === 0 && !state.overlapSummary) {
    const overlap = await detectOverlappingFiles(epic);
    state.overlappingFiles = overlap.overlappingFiles;
    state.overlapSummary = overlap.overlapSummary;
    if (state.overlappingFiles.length > 0) {
      await postEpicComment(
        epic,
        `**Epic Reviewer Overlap Detection**\n\nMultiple ticket branches modify the same files:\n${state.overlapSummary}\n\nEpic Reviewer will switch to reconciliation mode on a follow-up pass if build authority stays red.`
      );
    }
  }

  while (state.attemptCount < MAX_EPIC_RETRIES) {
    state.attemptCount += 1;
    if (state.attemptCount >= 2 && state.overlappingFiles.length > 0) {
      await ensureReconciliationBranch(epic, state);
    }
    const { prompt, hasDuplicateWarning } = await buildReviewPrompt(epic, state);
    console.log(`[epic-reviewer-agent] Reviewing epic "${epic.goal.title}" attempt ${state.attemptCount}/${MAX_EPIC_RETRIES}`);

    let reviewContent: string;
    try {
      reviewContent = await callRemoteLLM(prompt, buildSystemPrompt());
    } catch (err: any) {
      console.error(`[epic-reviewer-agent] GLM-5 call failed for ${epic.goal.title}: ${err.message}`);
      break;
    }

    state.injectedFullContext = true;
    await postEpicReviewerVisibleOutput(epic, state, reviewContent);
    const result = parseReviewResult(reviewContent);
    state.lastSummary = result.summary;

    if (result.fixes.length > 0) {
      state.lastAppliedFixes = await applyFixes(epic, result.fixes);
    } else {
      state.lastAppliedFixes = [];
    }

    const buildResults = state.reconciliationActive && state.reconciliationBranchName
      ? await buildReconciliationBranch(state.reconciliationBranchName)
      : await buildEpicBranches(epic);
    const failures = buildResults.filter(result => !result.passed);
    state.lastBuildErrors = failures
      .map(result => `${result.ticketIdentifier} (${result.branchName})\n${result.output || 'Unknown build failure'}`)
      .join('\n\n');

    // Post-fix duplicate verification: branch state must be duplicate-free before completion.
    const duplicateGroupsRemaining = await detectDuplicateBasenameGroups(await withBranches(epic.tickets));
    const duplicatesResolved = duplicateGroupsRemaining.length === 0;
    if (duplicatesResolved) {
      console.log('[telemetry] EPIC_DUPLICATE_GROUPS_RESOLVED');
    }
    const goalMet = result.goalSatisfied;
    const buildGreen = failures.length === 0;

    epicRetryStates.set(epic.goal.id, { ...state });

    // Only exit when: builds pass AND duplicates resolved AND goal satisfied
    if (buildGreen && duplicatesResolved && goalMet) {
      await postEpicSuccess(epic, result.summary);
      return;
    }

    // Build carry-forward context for next attempt
    const issues: string[] = [];
    if (!buildGreen) {
      issues.push(`Build remained red.`);
    }
    if (!duplicatesResolved) {
      issues.push(`Duplicate groups still remain (${duplicateGroupsRemaining.length}). Next attempt MUST consolidate and delete duplicate files.`);
      state.lastSummary = (state.lastSummary || '') +
        '\n\n⚠ DELETION AUDIT: Duplicate file groups remain after fixes. Next attempt MUST address duplicate files with explicit deletions.';
    }
    if (!goalMet) {
      issues.push(`Goal is not yet satisfied. Next attempt must address gaps in epic delivery.`);
      state.lastSummary = (state.lastSummary || '') +
        '\n\n⚠ GOAL NOT SATISFIED: The epic goal is not yet met. Next attempt must address gaps.';
    }

    await postEpicComment(
      epic,
      `**Epic Reviewer Attempt ${state.attemptCount}/${MAX_EPIC_RETRIES}**\n\n` +
      `${issues.join('\n')}\n\n` +
      `Summary:\n${result.summary}\n\n` +
      (state.lastBuildErrors ? `Build failures:\n\`\`\`\n${truncate(state.lastBuildErrors, 5000)}\n\`\`\`` : '')
    );
  }

  epicRetryStates.set(epic.goal.id, { ...state });
  await postEpicFailure(epic, state);
}

/**
 * Main entry point - review ready epics and keep Epic Reviewer as build authority.
 */
export async function runEpicReviewerAgent(): Promise<void> {
  if (epicReviewerInFlight) {
    console.log('[epic-reviewer-agent] Epic Reviewer run already in progress - skipping duplicate wake');
    return;
  }

  epicReviewerInFlight = true;
  console.log('[epic-reviewer-agent] Starting Epic Reviewer build authority');
  let worktreePath = '';

  try {
    worktreePath = prepareEpicWorktree();
    console.log(`[epic-reviewer-agent] Using clean worktree ${worktreePath}`);

    const epics = await collectReadyEpics();
    if (epics.length === 0) {
      console.log('[epic-reviewer-agent] No epics ready for Epic Reviewer');
      return;
    }

    console.log(`[epic-reviewer-agent] Found ${epics.length} ready epic(s)`);
    for (const epic of epics) {
      await processEpic(epic);
    }
  } finally {
    if (worktreePath) {
      removeEpicWorktree(worktreePath);
      console.log(`[epic-reviewer-agent] Removed worktree ${worktreePath}`);
    }
    resetEpicWorkspace();
    epicReviewerInFlight = false;
  }
}
