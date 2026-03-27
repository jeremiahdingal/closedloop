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
import { postComment, patchIssue, getIssueDetails, getIssueLabel, wakeAgent } from './paperclip-api';
import { slugify } from './utils';
import { Issue } from './types';

const COMPLEXITY_SCORE_THRESHOLD = 7;
const TICKETS_DIR = '.tickets';
const GOAL_TICKET_MAP_FILE = '.paperclip-goal-ticket-map.json';
const GOAL_OVERLAP_STATE_FILE = '.paperclip-goal-overlap-state.json';
const OVERLAP_BLOCK_MARKER = '[PAPERCLIP_OVERLAP_BLOCK]';

interface GoalOverlapBlockedTicket {
  canonicalTicketId: string;
  canonicalIdentifier: string;
  overlappingFiles: string[];
  componentTicketIds: string[];
  blockedAt: string;
}

interface GoalOverlapState {
  blockedTickets: Record<string, GoalOverlapBlockedTicket>;
  canonicalTickets: string[];
  updatedAt: string;
}

interface TicketPlanningMetadata {
  objective: string;
  dependencies: string;
  files: string[];
}

interface OverlapCandidateIssue {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  status?: string;
  assigneeAgentId?: string | null;
  createdAt?: string;
}

const goalOverlapStateMap: Record<string, GoalOverlapState> = {};

function getGoalTicketMapPath(): string {
  return path.join(getWorkspace(), GOAL_TICKET_MAP_FILE);
}

function getGoalOverlapStatePath(): string {
  return path.join(getWorkspace(), GOAL_OVERLAP_STATE_FILE);
}

function persistGoalTicketMappings(): void {
  try {
    const payload = {
      goalTicketMap,
      ticketGoalMap,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(getGoalTicketMapPath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err: any) {
    console.error(`[goal] Failed to persist goal-ticket mappings: ${err.message}`);
  }
}

function persistGoalOverlapStates(): void {
  try {
    fs.writeFileSync(
      getGoalOverlapStatePath(),
      JSON.stringify({ goalOverlapStateMap, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (err: any) {
    console.error(`[goal] Failed to persist overlap state: ${err.message}`);
  }
}

function loadPersistedGoalTicketMappings(): void {
  try {
    const mapPath = getGoalTicketMapPath();
    if (!fs.existsSync(mapPath)) return;

    const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as {
      goalTicketMap?: Record<string, string[]>;
      ticketGoalMap?: Record<string, string>;
    };

    Object.keys(goalTicketMap).forEach(key => delete goalTicketMap[key]);
    Object.keys(ticketGoalMap).forEach(key => delete ticketGoalMap[key]);

    for (const [goalId, ticketIds] of Object.entries(raw.goalTicketMap || {})) {
      goalTicketMap[goalId] = Array.from(new Set(ticketIds.filter(Boolean)));
    }

    for (const [ticketId, goalId] of Object.entries(raw.ticketGoalMap || {})) {
      if (ticketId && goalId) {
        ticketGoalMap[ticketId] = goalId;
      }
    }
  } catch (err: any) {
    console.error(`[goal] Failed to load persisted goal-ticket mappings: ${err.message}`);
  }
}

function loadPersistedGoalOverlapStates(): void {
  try {
    const mapPath = getGoalOverlapStatePath();
    if (!fs.existsSync(mapPath)) return;

    const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as {
      goalOverlapStateMap?: Record<string, GoalOverlapState>;
    };

    Object.keys(goalOverlapStateMap).forEach(key => delete goalOverlapStateMap[key]);
    for (const [goalId, state] of Object.entries(raw.goalOverlapStateMap || {})) {
      goalOverlapStateMap[goalId] = state;
    }
  } catch (err: any) {
    console.error(`[goal] Failed to load persisted overlap state: ${err.message}`);
  }
}

function parseTicketPlanningMetadata(issue: Pick<OverlapCandidateIssue, 'title' | 'description'>): TicketPlanningMetadata {
  const description = issue.description || '';
  const objectiveMatch = description.match(/\*\*Objective:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/i);
  const depsMatch = description.match(/\*\*Dependencies:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/i);
  const filesMatch = description.match(/\*\*Files:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/i);

  const rawFiles = (filesMatch?.[1] || '')
    .split(/\r?\n|,/)
    .map(part => part.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  return {
    objective: (objectiveMatch?.[1] || '').trim(),
    dependencies: (depsMatch?.[1] || '').trim(),
    files: Array.from(new Set(rawFiles)),
  };
}

function scoreFoundationalTicket(issue: OverlapCandidateIssue): number {
  const meta = parseTicketPlanningMetadata(issue);
  const text = `${issue.title}\n${meta.objective}\n${meta.dependencies}`.toLowerCase();
  let score = 0;

  const strongSignals = [
    /\bnone\b/,
    /\bfoundational\b/,
    /\bbase\b/,
    /\bshared\b/,
    /\bcore\b/,
    /\bschema\b/,
    /\btypes?\b/,
    /\bapi\b/,
    /\bservice\b/,
    /\bstore\b/,
    /\bhook\b/,
  ];
  const weakSignals = [
    /\bdepends on\b/,
    /\bafter\b/,
    /\brequires\b/,
    /\bui\b/,
    /\bscreen\b/,
    /\bcomponent\b/,
    /\bdialog\b/,
    /\bpage\b/,
  ];

  for (const signal of strongSignals) {
    if (signal.test(text)) score += 3;
  }
  for (const signal of weakSignals) {
    if (signal.test(text)) score -= 2;
  }

  if (meta.files.length <= 2) score += 1;
  return score;
}

function sortByFoundationalPriority(a: OverlapCandidateIssue, b: OverlapCandidateIssue): number {
  const scoreDiff = scoreFoundationalTicket(b) - scoreFoundationalTicket(a);
  if (scoreDiff !== 0) return scoreDiff;

  const createdDiff =
    new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  if (createdDiff !== 0) return createdDiff;

  return String(a.identifier || a.id).localeCompare(String(b.identifier || b.id));
}

function buildGoalOverlapState(tickets: OverlapCandidateIssue[]): GoalOverlapState {
  const ticketById = new Map(tickets.map(ticket => [ticket.id, ticket]));
  const normalizedFiles = new Map<string, string[]>();

  for (const ticket of tickets) {
    const files = parseTicketPlanningMetadata(ticket).files;
    for (const filePath of files) {
      const owners = normalizedFiles.get(filePath) || [];
      owners.push(ticket.id);
      normalizedFiles.set(filePath, owners);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  const overlappingFilesByTicket = new Map<string, Set<string>>();
  for (const ticket of tickets) {
    adjacency.set(ticket.id, new Set());
    overlappingFilesByTicket.set(ticket.id, new Set());
  }

  for (const [filePath, owners] of normalizedFiles.entries()) {
    if (owners.length <= 1) continue;
    for (const owner of owners) {
      overlappingFilesByTicket.get(owner)?.add(filePath);
      const neighbors = adjacency.get(owner)!;
      for (const peer of owners) {
        if (peer !== owner) neighbors.add(peer);
      }
    }
  }

  const blockedTickets: Record<string, GoalOverlapBlockedTicket> = {};
  const canonicalTickets = new Set<string>();
  const visited = new Set<string>();

  for (const ticket of tickets) {
    if (visited.has(ticket.id)) continue;
    const stack = [ticket.id];
    const component: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }

    if (component.length <= 1) continue;

    const componentTickets = component
      .map(id => ticketById.get(id))
      .filter(Boolean) as OverlapCandidateIssue[];
    componentTickets.sort(sortByFoundationalPriority);
    const canonical = componentTickets[0];
    canonicalTickets.add(canonical.id);

    const overlappingFiles = Array.from(
      new Set(component.flatMap(id => Array.from(overlappingFilesByTicket.get(id) || [])))
    ).sort();

    for (const blocked of componentTickets.slice(1)) {
      blockedTickets[blocked.id] = {
        canonicalTicketId: canonical.id,
        canonicalIdentifier: canonical.identifier || canonical.id.slice(0, 8),
        overlappingFiles,
        componentTicketIds: component.slice().sort(),
        blockedAt: new Date().toISOString(),
      };
    }
  }

  return {
    blockedTickets,
    canonicalTickets: Array.from(canonicalTickets).sort(),
    updatedAt: new Date().toISOString(),
  };
}

function getOverlapBlockComment(blockedTicketLabel: string, block: GoalOverlapBlockedTicket): string {
  return (
    `${OVERLAP_BLOCK_MARKER}\n` +
    `**Blocked By Goal Overlap**\n\n` +
    `${blockedTicketLabel} overlaps with sibling work owned by **${block.canonicalIdentifier}**.\n\n` +
    `Overlapping planned files:\n` +
    `${block.overlappingFiles.map(filePath => `- \`${filePath}\``).join('\n')}\n\n` +
    `This ticket is intentionally paused in \`todo\` pending canonical completion or epic reconciliation.`
  );
}

export function getGoalOverlapState(goalId: string): GoalOverlapState | undefined {
  return goalOverlapStateMap[goalId];
}

export function getOverlapBlockForTicket(ticketId: string): GoalOverlapBlockedTicket | undefined {
  const goalId = ticketGoalMap[ticketId];
  if (!goalId) return undefined;
  return goalOverlapStateMap[goalId]?.blockedTickets?.[ticketId];
}

export function isTicketBlockedByOverlap(ticketId: string): boolean {
  return Boolean(getOverlapBlockForTicket(ticketId));
}

export function getActiveEpicTicketIds(goalId: string): string[] {
  const siblingIds = goalTicketMap[goalId] || [];
  return siblingIds.filter(ticketId => !isTicketBlockedByOverlap(ticketId));
}

export async function enforceGoalOverlapSuppression(goalId: string, providedTickets?: OverlapCandidateIssue[]): Promise<GoalOverlapState> {
  const rawTickets = (providedTickets || await getEpicTickets(goalId)) as OverlapCandidateIssue[];
  const tickets = rawTickets.filter(ticket => ticket.id !== goalId && ticket.status !== 'cancelled');
  const previousState = goalOverlapStateMap[goalId];
  const state = buildGoalOverlapState(tickets);
  goalOverlapStateMap[goalId] = state;
  persistGoalOverlapStates();

  for (const ticket of tickets) {
    const block = state.blockedTickets[ticket.id];
    if (!block) continue;

    const label = ticket.identifier || ticket.id.slice(0, 8);
    const previousBlock = previousState?.blockedTickets?.[ticket.id];
    const shouldPostComment =
      !previousBlock ||
      previousBlock.canonicalTicketId !== block.canonicalTicketId ||
      previousBlock.overlappingFiles.join('|') !== block.overlappingFiles.join('|');
    if (shouldPostComment) {
      await postComment(ticket.id, null, getOverlapBlockComment(label, block));
    }

    await patchIssue(ticket.id, {
      status: 'todo',
      assigneeAgentId: undefined,
    } as any);
  }

  return state;
}

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
        persistGoalTicketMappings();
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
  const resolved = new Map<string, any>();
  const knownIds = goalTicketMap[goalId] || [];

  for (const ticketId of knownIds) {
    try {
      const issue = await getIssueDetails(ticketId);
      if (issue && issue.id !== goalId && issue.status !== 'cancelled') {
        resolved.set(issue.id, issue);
      }
    } catch {}
  }

  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/companies/${getCompanyId()}/issues`);
    if (res.ok) {
      const data = await res.json() as any;
      const issues = Array.isArray(data) ? data : data.issues || data.data || [];

      for (const issue of issues.filter(
        (i: any) => i.goalId === goalId && i.id !== goalId && i.status !== 'cancelled'
      )) {
        resolved.set(issue.id, issue);
        ticketGoalMap[issue.id] = goalId;
      }
    }
  } catch {}

  goalTicketMap[goalId] = Array.from(resolved.keys());
  if (goalTicketMap[goalId].length > 0) {
    persistGoalTicketMappings();
  }

  return Array.from(resolved.values());
}

export async function getActionableEpicTickets(goalId: string): Promise<any[]> {
  const tickets = await getEpicTickets(goalId);
  return tickets.filter(ticket => !isTicketBlockedByOverlap(ticket.id));
}

/**
 * Reload goal/ticket mappings from Paperclip API
 * Called on startup to restore in-memory maps
 */
export async function reloadGoalTicketMappings(): Promise<void> {
  loadPersistedGoalTicketMappings();
  loadPersistedGoalOverlapStates();

  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/companies/${getCompanyId()}/issues`);
    if (!res.ok) return;

    const data = await res.json() as any;
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

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

    persistGoalTicketMappings();

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

  const siblingIds = getActiveEpicTicketIds(goalId);
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
    const blockedCount = Object.keys(goalOverlapStateMap[goalId]?.blockedTickets || {}).length;
    console.log(`[goal] All ${siblingIds.length} active tickets reached in_review - marking goal ${await getIssueLabel(goalId)} as in_review`);
    await patchIssue(goalId, { status: 'in_review' } as any);
    await postComment(
      goalId,
      null,
      `_All ${siblingIds.length} active sub-tickets are complete.${blockedCount > 0 ? ` ${blockedCount} overlapping duplicate tickets remain blocked for epic reconciliation.` : ''} Goal moved to in_review._`
    );

    console.log(`[goal] Waking Epic Reviewer agent for ready epics`);
    const woke = await wakeAgent(AGENTS['epic reviewer'], 'ready_epics_pending', 'automation');
    if (!woke) {
      console.error('[goal] Failed to wake Epic Reviewer agent for ready epics');
    }
  }
}
