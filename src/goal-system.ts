/**
 * Goal/Epic system — decompose broad requests into narrow execution tickets.
 *
 * Paperclip has a flat issue schema (no native parent/child). We track hierarchy
 * via title convention ([Goal]/[Epic]), in-memory maps, and .tickets/ files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getPaperclipApiUrl, getCompanyId } from './config';
import { AGENTS, goalTicketMap, ticketGoalMap, issueComplexityCache } from './agent-types';
import { postComment, patchIssue, getIssueDetails, getIssueLabel } from './paperclip-api';
import { slugify } from './utils';
import { Issue } from './types';

const COMPLEXITY_SCORE_THRESHOLD = 7;
const TICKETS_DIR = '.tickets';

// ─── Complexity scoring ────────────────────────────────────────────

interface ComplexityResult {
  score: number;
  signals: string[];
}

export function scoreComplexity(title: string, description: string): ComplexityResult {
  const text = `${title} ${description}`.toLowerCase();
  let score = 0;
  const signals: string[] = [];

  // Greenfield / from-scratch signals (+2 each)
  const greenfield = [
    /\bfrom scratch\b/, /\bgreenfield\b/, /\bnew system\b/, /\bnew platform\b/,
    /\bbuild (?:a |an |the )?(?:whole |full |entire |complete )?(?:app|system|platform|dashboard)\b/,
  ];
  for (const re of greenfield) {
    if (re.test(text)) { score += 2; signals.push(`greenfield: ${re.source}`); }
  }

  // Multi-module signals (+2 each)
  const multiModule = [
    /\bfull.?stack\b/, /\bmulti.?module\b/, /\bentire dashboard\b/, /\bentire platform\b/,
  ];
  for (const re of multiModule) {
    if (re.test(text)) { score += 2; signals.push(`multi-module: ${re.source}`); }
  }

  // Architecture keywords (+2)
  if (/\barchitecture\b/.test(text) || /\bdata model\b.*\bapi\b.*\bui\b/.test(text)) {
    score += 2; signals.push('architecture keywords');
  }

  // Auth + realtime (+1 each)
  if (/\bauth\b/.test(text)) { score += 1; signals.push('auth keyword'); }
  if (/\brealtime\b|\bwebsocket\b/.test(text)) { score += 1; signals.push('realtime keyword'); }

  // Fix/bug signals (-2)
  if (/\bfix\b|\bbug\b|\bbroken\b|\bnot working\b/.test(text)) {
    score -= 2; signals.push('fix/bug signal (-2)');
  }

  // Narrow UI phrases (-2)
  if (/\badd a (?:button|field|column|label|icon)\b/.test(text)) {
    score -= 2; signals.push('narrow UI phrase (-2)');
  }

  // Cosmetic phrases (-1)
  if (/\bupdate (?:text|color|style|padding)\b/.test(text)) {
    score -= 1; signals.push('cosmetic phrase (-1)');
  }

  return { score: Math.max(0, Math.min(10, score)), signals };
}

export function isGoalIssue(issue: { title: string; description?: string }): boolean {
  if (/\[goal\]|\[epic\]/i.test(issue.title)) return true;
  const result = scoreComplexity(issue.title, issue.description || '');
  return result.score >= COMPLEXITY_SCORE_THRESHOLD;
}

// ─── Ticket decomposition ──────────────────────────────────────────

interface ParsedTicket {
  title: string;
  objective: string;
  files: string;
  acceptanceCriteria: string;
  dependencies: string;
  body: string;
}

function parseTicketBlocks(spec: string): ParsedTicket[] {
  const tickets: ParsedTicket[] = [];
  const blocks = spec.split(/^## Ticket:\s*/m).slice(1);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const title = lines[0]?.trim() || 'Untitled';
    const body = lines.slice(1).join('\n');

    const objectiveMatch = body.match(/\*\*Objective:\*\*\s*(.*)/i);
    const filesMatch = body.match(/\*\*Files:\*\*\s*(.*)/i);
    const depsMatch = body.match(/\*\*Dependencies:\*\*\s*(.*)/i);
    const acMatch = body.match(/\*\*Acceptance Criteria:\*\*([\s\S]*?)(?=\*\*|$)/i);

    tickets.push({
      title,
      objective: objectiveMatch?.[1]?.trim() || '',
      files: filesMatch?.[1]?.trim() || '',
      acceptanceCriteria: acMatch?.[1]?.trim() || '',
      dependencies: depsMatch?.[1]?.trim() || '',
      body,
    });
  }

  return tickets;
}

export async function decomposeGoalIntoTickets(
  goalIssueId: string,
  spec: string
): Promise<string[]> {
  const goalIssue = await getIssueDetails(goalIssueId);
  const goalIdentifier = goalIssue?.identifier || goalIssueId.slice(0, 8);
  const tickets = parseTicketBlocks(spec);

  if (tickets.length === 0) {
    console.log(`[goal] No ## Ticket: blocks found in spec for ${goalIdentifier}`);
    return [];
  }

  const workspace = getWorkspace();
  const ticketsDir = path.join(workspace, TICKETS_DIR);
  fs.mkdirSync(ticketsDir, { recursive: true });

  const createdIds: string[] = [];
  goalTicketMap[goalIssueId] = [];

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    const nn = String(i + 1).padStart(2, '0');
    const slug = slugify(t.title);
    const ticketTitle = `[${goalIdentifier}] ${t.title}`;
    const ticketDesc =
      `Parent goal: ${goalIdentifier}\n\n` +
      `**Objective:** ${t.objective}\n` +
      `**Files:** ${t.files}\n\n` +
      `**Acceptance Criteria:**\n${t.acceptanceCriteria}\n\n` +
      `**Dependencies:** ${t.dependencies}`;

    // Write .tickets/ file
    const ticketFile = path.join(ticketsDir, `${goalIdentifier}-${nn}-${slug}.md`);
    const ticketMd =
      `# ${ticketTitle}\n\n` +
      `Parent: ${goalIdentifier}\nStatus: todo\n\n` +
      `## Objective\n${t.objective}\n\n` +
      `## Acceptance Criteria\n${t.acceptanceCriteria}\n\n` +
      `## Implementation Notes\n${t.files}\n`;
    fs.writeFileSync(ticketFile, ticketMd, 'utf8');

    // Create Paperclip issue
    try {
      const res = await fetch(`${getPaperclipApiUrl()}/api/companies/${getCompanyId()}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: ticketTitle,
          description: ticketDesc,
          status: 'todo',
          goalId: goalIssueId,
          assigneeAgentId: AGENTS.strategist,
        }),
      });

      if (res.ok) {
        const created = await res.json() as any;
        const ticketId = created.id || created.issueId;
        const ticketLabel = created.identifier || ticketId?.slice(0, 8);
        createdIds.push(ticketId);
        goalTicketMap[goalIssueId].push(ticketId);
        ticketGoalMap[ticketId] = goalIssueId;
        console.log(`[goal] Created ticket ${nn}: ${t.title} -> ${ticketLabel}`);
      } else {
        console.error(`[goal] Failed to create ticket ${t.title}: ${res.status}`);
      }
    } catch (err: any) {
      console.error(`[goal] Error creating ticket ${t.title}:`, err.message);
    }
  }

  // Post summary comment
  const summary = tickets
    .map((t, i) => `${i + 1}. **${t.title}** — ${t.objective}`)
    .join('\n');
  await postComment(
    goalIssueId,
    null,
    `**Goal decomposed into ${tickets.length} tickets:**\n\n${summary}`
  );

  return createdIds;
}

/**
 * Get all tickets for a goal (excluding the goal itself and cancelled tickets)
 */
export async function getEpicTickets(goalId: string): Promise<any[]> {
  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/companies/${getCompanyId()}/issues`);
    if (!res.ok) return [];

    const data = await res.json() as any;
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

    return issues.filter(
      (i: any) => i.goalId === goalId && i.id !== goalId && i.status !== 'cancelled'
    );
  } catch {
    return [];
  }
}

/**
 * Reload goal/ticket mappings from Paperclip API
 * Called on startup to restore in-memory maps
 */
export async function reloadGoalTicketMappings(): Promise<void> {
  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/companies/${getCompanyId()}/issues`);
    if (!res.ok) return;

    const data = await res.json() as any;
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

    // Clear existing maps by removing all keys
    Object.keys(goalTicketMap).forEach(key => delete goalTicketMap[key]);
    Object.keys(ticketGoalMap).forEach(key => delete ticketGoalMap[key]);

    // Build mappings from issues with goalId
    for (const issue of issues) {
      if (issue.goalId && issue.id !== issue.goalId) {
        // This is a ticket belonging to a goal
        if (!goalTicketMap[issue.goalId]) {
          goalTicketMap[issue.goalId] = [];
        }
        goalTicketMap[issue.goalId].push(issue.id);
        ticketGoalMap[issue.id] = issue.goalId;
      }
    }

    const goalCount = Object.keys(goalTicketMap).length;
    const ticketCount = Object.keys(ticketGoalMap).length;
    console.log(`[goal] Reloaded ${goalCount} goals with ${ticketCount} tickets`);
  } catch (err: any) {
    console.error(`[goal] Failed to reload mappings: ${err.message}`);
  }
}

// ─── Goal completion check ─────────────────────────────────────────

export async function checkGoalCompletion(ticketIssueId: string): Promise<void> {
  const goalId = ticketGoalMap[ticketIssueId];
  if (!goalId) return;

  const siblingIds = goalTicketMap[goalId] || [];
  if (siblingIds.length === 0) return;

  let allDone = true;
  for (const sibId of siblingIds) {
    const sib = await getIssueDetails(sibId);
    if (!sib || sib.status !== 'in_review') {
      allDone = false;
      break;
    }
  }

  if (allDone) {
    console.log(`[goal] All ${siblingIds.length} tickets reached in_review - marking goal ${await getIssueLabel(goalId)} as in_review`);
    await patchIssue(goalId, { status: 'in_review' } as any);
    await postComment(goalId, null, `_All ${siblingIds.length} sub-tickets are complete. Goal moved to in_review._`);

    // Immediately run Epic Reviewer as the build authority for ready epics
    console.log(`[goal] Running Epic Reviewer build authority for ready epics`);
    try {
      const { runEpicReviewerAgent } = await import('./epic-reviewer-agent');
      await runEpicReviewerAgent();
    } catch (err: any) {
      console.error(`[goal] Epic Reviewer build authority failed: ${err.message}`);
    }
  }
}
