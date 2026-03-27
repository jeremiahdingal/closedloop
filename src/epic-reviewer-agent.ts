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
import { getEpicTickets } from './goal-system';
import { getBranchName, getDefaultBranch } from './git-ops';
import { truncate } from './utils';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const WORKSPACE = getWorkspace();
const MAX_EPIC_RETRIES = 5;

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
  ticketIdentifier: string;
  filePath: string;
  content: string;
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
}

const epicRetryStates = new Map<string, EpicRetryState>();

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
    const tickets = await getEpicTickets(goal.id);
    if (tickets.length === 0) continue;

    const allReady = tickets.every(t => t.status === 'in_review' || t.status === 'done');
    if (!allReady) continue;

    epics.push({ goal, tickets });
  }

  return epics;
}

async function withBranches(tickets: EpicTicket[]): Promise<TicketWithBranch[]> {
  const mapped = await Promise.all(
    tickets.map(async ticket => ({
      ...ticket,
      branchName: await getBranchName(ticket.id),
    }))
  );
  return mapped;
}

async function collectTicketDiff(ticket: TicketWithBranch): Promise<string> {
  try {
    const defaultBranch = getDefaultBranch();
    const diff = execSync(`git diff ${defaultBranch}...${ticket.branchName} -- . ":(exclude)docs/screenshots"`, {
      cwd: WORKSPACE,
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
  prompt += '\n## Ticket Diffs\n\n';

  for (const ticket of ticketInfos) {
    const diff = await collectTicketDiff(ticket);
    if (!diff) continue;
    prompt += `### ${ticket.identifier}: ${ticket.title}\n`;
    prompt += `\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  }

  return prompt;
}

function buildSystemPrompt(): string {
  return `You are the Epic Reviewer, the only automated build-and-repair authority for this system.

Review one epic at a time. Find cross-ticket issues, output exact file fixes, and use any prior build errors to repair the branches.

Required output:
- If no code changes are needed, start with VERDICT: APPROVED
- If changes are needed, start with VERDICT: CHANGES_REQUESTED
- For every file to change, emit:
TICKET: SHO-XX
FILE: relative/path/to/file.ext
\`\`\`typescript
// complete file content
\`\`\`
- Finish with:
SUMMARY:
brief explanation

Rules:
- Output full files, not diffs
- Only tag files to tickets that exist in this epic
- Prior build errors are high-priority signals
- If a previous attempt failed to build, focus on getting the next attempt green`;
}

function parseReviewResult(content: string): ReviewResult {
  const fixes: FileFix[] = [];
  const approved = /VERDICT:\s*APPROVED/i.test(content);
  const ticketFileRegex = /TICKET:\s*(SHO-\d+)\s*\nFILE:\s*([^\n]+)\s*\n```[^\n]*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;

  while ((match = ticketFileRegex.exec(content)) !== null) {
    const [, ticketIdentifier, filePath, fileContent] = match;
    fixes.push({
      ticketIdentifier,
      filePath: filePath.trim(),
      content: fileContent.trim(),
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

  for (const fix of fixes) {
    if (!fixesByTicket.has(fix.ticketIdentifier)) {
      fixesByTicket.set(fix.ticketIdentifier, []);
    }
    fixesByTicket.get(fix.ticketIdentifier)!.push(fix);
  }

  for (const ticket of tickets) {
    const ticketFixes = fixesByTicket.get(ticket.identifier);
    if (!ticketFixes || ticketFixes.length === 0) continue;

    try {
      execSync(`git checkout ${ticket.branchName}`, {
        cwd: WORKSPACE,
        stdio: 'pipe',
        timeout: 10000,
      });

      for (const fix of ticketFixes) {
        const fullPath = path.join(WORKSPACE, fix.filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, fix.content, 'utf8');
        execSync(`git add "${fix.filePath}"`, { cwd: WORKSPACE, stdio: 'pipe' });
        applied.push(`${ticket.identifier}: ${fix.filePath}`);
      }

      try {
        execSync(`git commit -m "${ticket.identifier}: Epic Reviewer automated fixes"`, {
          cwd: WORKSPACE,
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
        cwd: WORKSPACE,
        stdio: 'pipe',
        timeout: 60000,
      });

      await postComment(
        ticket.id,
        null,
        `**Epic Reviewer Automated Fixes**\n\nApplied fixes:\n${ticketFixes.map(f => `- \`${f.filePath}\``).join('\n')}`
      ).catch(() => {});
    } finally {
      try {
        execSync(`git checkout ${defaultBranch}`, {
          cwd: WORKSPACE,
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
        cwd: WORKSPACE,
        stdio: 'pipe',
        timeout: 10000,
      });
      execSync(buildCommand, {
        cwd: WORKSPACE,
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
          cwd: WORKSPACE,
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {}
    }
  }

  return results;
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

async function processEpic(epic: EpicWithTickets): Promise<void> {
  const state = epicRetryStates.get(epic.goal.id) || {
    attemptCount: 0,
    injectedFullContext: false,
    lastSummary: '',
    lastBuildErrors: '',
    lastAppliedFixes: [],
  };

  while (state.attemptCount < MAX_EPIC_RETRIES) {
    state.attemptCount += 1;
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
    const result = parseReviewResult(reviewContent);
    state.lastSummary = result.summary;

    if (result.fixes.length > 0) {
      state.lastAppliedFixes = await applyFixes(epic, result.fixes);
    } else {
      state.lastAppliedFixes = [];
    }

    const buildResults = await buildEpicBranches(epic);
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
  console.log('[epic-reviewer-agent] Starting Epic Reviewer build authority');

  const epics = await collectReadyEpics();
  if (epics.length === 0) {
    console.log('[epic-reviewer-agent] No epics ready for Epic Reviewer');
    return;
  }

  console.log(`[epic-reviewer-agent] Found ${epics.length} ready epic(s)`);
  for (const epic of epics) {
    await processEpic(epic);
  }
}
