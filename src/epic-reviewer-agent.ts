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
import { getWorkspace, getCompanyId, getPaperclipApiUrl, loadConfig } from './config';
import { postComment } from './paperclip-api';
import { callZAI } from './remote-ai';
import { getEpicTickets, getActionableEpicTickets } from './goal-system';
import { getBranchName, getDefaultBranch } from './git-ops';
import { truncate } from './utils';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const BASE_WORKSPACE = getWorkspace();
const EPIC_REVIEW_WORKTREE_ROOT = path.join(BASE_WORKSPACE, '.paperclip-epic-review');
const MAX_EPIC_RETRIES = 5;
let activeEpicWorkspace = BASE_WORKSPACE;
let epicReviewerInFlight = false;

interface EpicTicket {
  id: string;
  identifier: string;
  title: string;
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

interface FileFix {
  target: string;
  targetType: 'ticket' | 'reconciliation';
  filePath: string;
  operation: 'write' | 'delete';
  content?: string;
}

interface ReviewResult {
  approved: boolean;
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

async function collectReadyEpics(): Promise<EpicWithTickets[]> {
  const goalsRes = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/goals`);
  if (!goalsRes.ok) return [];

  const goals = await goalsRes.json() as any[];
  const activeGoals = goals.filter(g => g.status === 'active' || g.status === 'in_review');

  const epics: EpicWithTickets[] = [];
  for (const goal of activeGoals) {
    const tickets = await getActionableEpicTickets(goal.id);
    if (tickets.length === 0) continue;

    const allReady = tickets.every(t => t.status === 'in_review');
    if (!allReady) continue;

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
        const identifier = String(ticket.identifier || ticket.id || 'ticket').toLowerCase();
        const title = String(ticket.title || 'code-changes')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+$/, '')
          .slice(0, 40);
        branchName = `${identifier}-${title}`.replace(/-+$/, '');
        console.log(`[epic-reviewer-agent] Recovered missing branch name for ${ticket.identifier || ticket.id}: ${branchName}`);
      }

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
    const defaultBranch = getDefaultBranch();
    const diff = execSync(`git diff ${defaultBranch}...${ticket.branchName} -- . ":(exclude)docs/screenshots"`, {
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
    const defaultBranch = getDefaultBranch();
    const changed = execSync(`git diff ${defaultBranch}...${ticket.branchName} --name-only -- . ":(exclude)docs/screenshots"`, {
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
    await postComment(
      epic.goal.id,
      null,
      `**Epic Reconciliation Branch Created**\n\nBranch: \`${branchName}\`\n\nOverlapping files detected:\n${summary || '- overlap detected'}`
    ).catch(() => {});

    return branchName;
  } finally {
    try {
      tryGit(`git checkout ${defaultBranch}`, 10000);
    } catch {}
  }
}

export async function buildReviewPrompt(epic: EpicWithTickets, state: EpicRetryState): Promise<string> {
  let prompt = '';

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
  }
  if (state.overlapSummary) {
    prompt += `\n## Overlap Detection\n${state.overlapSummary}\n`;
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

  return prompt;
}

function buildSystemPrompt(): string {
  return `You are the Epic Reviewer, the only automated build-and-repair authority for this system.

Review one epic at a time. Find cross-ticket issues, output exact file fixes, and use any prior build errors to repair the branches.

Treat these as high-priority drift symptoms that usually require reconciliation, consolidation, or deletion of duplicate files:
- The same concept implemented in multiple parallel paths, for example duplicate hooks/components/modals/panels across sibling folders
- Alternate file names for the same feature, such as both OrderSummary and OrderTotalSummary variants
- Ticket branches creating broad adjacent files outside the intended scope just to make local review pass
- Multiple route/API/client wrappers for the same endpoint or mutation
- Mixing old project conventions with current ones, especially StyleSheet.create or non-Tamagui UI in a Tamagui codebase
- Stray generated files or package-manager artifacts like package-lock.json, extra dashboard/packages, or unrelated test scaffolding outside the ticket scope

When these symptoms appear:
- Prefer one canonical implementation path and remove or replace the alternates
- Favor the path that best matches the current project structure and existing imports
- Do not preserve duplicate files just because they compile
- If drift spans multiple ticket branches, use reconciliation output to produce the final integrated files
- Call out deletions or consolidation explicitly in SUMMARY

Required output:
- If no code changes are needed, start with VERDICT: APPROVED
- If changes are needed, start with VERDICT: CHANGES_REQUESTED
- For normal ticket-branch fixes, emit:
TICKET: SHO-XX
FILE: relative/path/to/file.ext
\`\`\`typescript
// complete file content
\`\`\`
- For normal ticket-branch deletions, emit:
TICKET: SHO-XX
DELETE FILE: relative/path/to/file.ext
- For reconciliation-branch fixes, emit:
TARGET: EPIC_RECONCILE
FILE: relative/path/to/file.ext
\`\`\`typescript
// complete file content
\`\`\`
- For reconciliation-branch deletions, emit:
TARGET: EPIC_RECONCILE
DELETE FILE: relative/path/to/file.ext
- Finish with:
SUMMARY:
brief explanation

Rules:
- Output full files for writes, not diffs
- Use DELETE FILE when duplicate or wrong-path files must be removed
- Only tag files to tickets that exist in this epic
- Use TARGET: EPIC_RECONCILE only when reconciliation mode is active
- Prior build errors are high-priority signals
- If a previous attempt failed to build, focus on getting the next attempt green`;
}

function parseReviewResult(content: string): ReviewResult {
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

  const summaryMatch = content.match(/SUMMARY:\s*([\s\S]+)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : truncate(content, 1000);
  return { approved, fixes, summary };
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
      execSync(`git checkout ${ticket.branchName}`, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 10000,
      });

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

      execSync(`git push origin ${ticket.branchName}`, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 60000,
      });

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

      await postComment(
        epic.goal.id,
        null,
        `**Epic Reviewer Reconciliation Fixes**\n\nApplied fixes on \`${reconciliationBranchName}\`:\n${reconciliationFixes.map(f => `- ${f.operation === 'delete' ? 'deleted' : 'updated'} \`${f.filePath}\``).join('\n')}`
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
      execSync(`git checkout ${ticket.branchName}`, {
        cwd: getEpicWorkspace(),
        stdio: 'pipe',
        timeout: 10000,
      });
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
  for (const ticket of epic.tickets) {
    await postComment(
      ticket.id,
      null,
      `**Epic Review: APPROVED**\n\nEpic Reviewer validated the epic and all build checks passed.\n\n${summary}`
    ).catch(() => {});
  }
  await postComment(
    epic.goal.id,
    null,
    `**Epic Reviewer Complete**\n\nBuild authority result: green.\n\n${summary}`
  ).catch(() => {});
}

async function postEpicFailure(epic: EpicWithTickets, state: EpicRetryState): Promise<void> {
  const message =
    `**Epic Reviewer Capped at ${MAX_EPIC_RETRIES} Attempts**\n\n` +
    `Epic Reviewer remained the build authority for this epic but could not get it green.\n\n` +
    (state.lastSummary ? `Latest summary:\n${state.lastSummary}\n\n` : '') +
    (state.lastBuildErrors ? `Latest build errors:\n\`\`\`\n${truncate(state.lastBuildErrors, 5000)}\n\`\`\`\n` : '');

  await postComment(epic.goal.id, null, message).catch(() => {});
  for (const ticket of epic.tickets) {
    await postComment(ticket.id, null, message).catch(() => {});
  }
}

async function postEpicReviewerVisibleOutput(epic: EpicWithTickets, state: EpicRetryState, reviewContent: string): Promise<void> {
  const message =
    `**Epic Reviewer Visible Model Output ${state.attemptCount}/${MAX_EPIC_RETRIES}**\n\n` +
    `This is the model's visible response, not hidden chain-of-thought.\n\n` +
    `\`\`\`\n${truncate(reviewContent, 12000)}\n\`\`\``;

  try {
    await postComment(epic.goal.id, null, message);
    return;
  } catch {}

  for (const ticket of epic.tickets) {
    await postComment(ticket.id, null, message).catch(() => {});
  }
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
      await postComment(
        epic.goal.id,
        null,
        `**Epic Reviewer Overlap Detection**\n\nMultiple ticket branches modify the same files:\n${state.overlapSummary}\n\nEpic Reviewer will switch to reconciliation mode on a follow-up pass if build authority stays red.`
      ).catch(() => {});
    }
  }

  while (state.attemptCount < MAX_EPIC_RETRIES) {
    state.attemptCount += 1;
    if (state.attemptCount >= 2 && state.overlappingFiles.length > 0) {
      await ensureReconciliationBranch(epic, state);
    }
    const prompt = await buildReviewPrompt(epic, state);
    console.log(`[epic-reviewer-agent] Reviewing epic "${epic.goal.title}" attempt ${state.attemptCount}/${MAX_EPIC_RETRIES}`);

    let reviewContent: string;
    try {
      reviewContent = await callZAI(prompt, buildSystemPrompt());
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

    epicRetryStates.set(epic.goal.id, { ...state });

    if (failures.length === 0) {
      await postEpicSuccess(epic, result.summary);
      return;
    }

    await postComment(
      epic.goal.id,
      null,
      `**Epic Reviewer Attempt ${state.attemptCount}/${MAX_EPIC_RETRIES}**\n\n` +
      `Build remained red after review.\n\n` +
      `Summary:\n${result.summary}\n\n` +
      `Build failures:\n\`\`\`\n${truncate(state.lastBuildErrors, 5000)}\n\`\`\``
    ).catch(() => {});
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
