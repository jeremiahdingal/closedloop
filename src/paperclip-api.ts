/**
 * Paperclip API client functions
 */

import { Issue, Comment } from './types';
import { getPaperclipApiUrl, getCompanyId, getAgentKeys } from './config';

const agentNameCache: Record<string, string> = {};
const issueLabelCache: Record<string, string> = {};

export async function getAgentName(agentId: string): Promise<string> {
  if (!agentId) return 'unknown';
  if (agentNameCache[agentId]) return agentNameCache[agentId];

  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/agents/${agentId}`);
    if (res.ok) {
      const data = await res.json() as { name: string };
      agentNameCache[agentId] = data.name;
      return data.name;
    }
  } catch (err) {
    // Silent fail
  }

  return agentId.slice(0, 8);
}

export async function getIssueDetails(issueId: string): Promise<Issue | null> {
  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}`);
    if (res.ok) return res.json() as Promise<Issue>;
  } catch (err) {
    // Silent fail
  }
  return null;
}

export async function getIssueLabel(issueId: string): Promise<string> {
  if (!issueId) return 'unknown';
  if (issueLabelCache[issueId]) return issueLabelCache[issueId];

  const issue = await getIssueDetails(issueId);
  const label = issue?.identifier || issueId.slice(0, 8);
  issueLabelCache[issueId] = label;
  return label;
}

export async function getIssueComments(issueId: string): Promise<Comment[]> {
  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}/comments`);
    if (res.ok) return res.json() as Promise<Comment[]>;
  } catch (err) {
    // Silent fail
  }
  return [];
}

export async function patchIssue(
  issueId: string,
  payload: Partial<Issue>
): Promise<boolean> {
  try {
    const normalizedPayload: Record<string, unknown> = { ...payload };
    if (Object.prototype.hasOwnProperty.call(normalizedPayload, 'assigneeAgentId') && normalizedPayload.assigneeAgentId === undefined) {
      normalizedPayload.assigneeAgentId = null;
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPayload, 'assigneeUserId') && normalizedPayload.assigneeUserId === undefined) {
      normalizedPayload.assigneeUserId = null;
    }

    const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizedPayload),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

export async function findAssignedIssue(agentId: string): Promise<string | null> {
  const assigned = await findAssignedIssues(agentId);
  return assigned[0]?.id || null;
}

export async function findAssignedIssues(agentId: string): Promise<Issue[]> {
  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/companies/${getCompanyId()}/issues`);
    if (res.ok) {
      const issues = await res.json() as any[] | { issues?: any[]; data?: any[] };
      const list = Array.isArray(issues)
        ? issues
        : issues.issues || issues.data || [];

      const assigned = list.filter(
        (i: Issue) => i.assigneeAgentId === agentId && i.status !== 'done' && i.status !== 'cancelled'
      );

      if (assigned.length > 0) {
        // Dependency-aware priority: API/backend tickets before frontend/UI tickets.
        // This ensures schemas, services, and routes exist before screens that import them.
        assigned.sort((a: Issue, b: Issue) => {
          const scoreA = ticketDependencyScore(a.title);
          const scoreB = ticketDependencyScore(b.title);
          if (scoreA !== scoreB) return scoreA - scoreB; // lower score = higher priority
          // Prefer the least recently updated issue within the same dependency tier
          // so one "hot" ticket cannot starve older assigned work forever.
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        });
        return assigned;
      }
    }
  } catch (err) {
    // Silent fail
  }
  return [];
}

/**
 * Score a ticket by dependency tier. Lower = should be built first.
 * Tier 0: Database schema, migrations, types
 * Tier 1: API services, routes, middleware
 * Tier 2: Shared hooks, stores, utilities
 * Tier 3: UI components, screens, dialogs (depend on everything above)
 */
function ticketDependencyScore(title: string): number {
  const t = title.toLowerCase();

  // Tier 0 — foundational
  if (/\b(schema|migration|database|table|type|enum)\b/.test(t)) return 0;

  // Tier 1 — API layer
  if (/\b(api|service|route|endpoint|worker|middleware)\b/.test(t)) return 1;

  // Tier 2 — shared logic
  if (/\b(hook|store|zustand|query|util|fetch|helper)\b/.test(t)) return 2;

  // Tier 3 — UI / frontend
  if (/\b(screen|dialog|sheet|component|ui|button|form|layout|page|cashier|dashboard)\b/.test(t)) return 3;

  // Default — treat as mid-priority
  return 2;
}

export async function postComment(
  issueId: string,
  agentId: string | null,
  content: string,
  retries = 3
): Promise<void> {
  let effectiveAgentId = agentId;
  if (agentId) {
    const currentIssue = await getIssueDetails(issueId);
    if (currentIssue && currentIssue.assigneeAgentId !== agentId) {
      console.log(
        `[paperclip] Posting stale agent comment as system note for ${await getIssueLabel(issueId)}: assignee is ${currentIssue.assigneeAgentId || 'none'}, not ${agentId}`
      );
      effectiveAgentId = null;
    }
  }

  const body = JSON.stringify({
    body: sanitizeForWin1252(content),
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (effectiveAgentId && getAgentKeys()[effectiveAgentId]) {
    headers['Authorization'] = `Bearer ${getAgentKeys()[effectiveAgentId]}`;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}/comments`, {
        method: 'POST',
        headers,
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[paperclip] Failed to post comment: ${res.status} ${text}`);
      } else {
        console.log(`[paperclip] Posted comment to issue ${await getIssueLabel(issueId)}`);
      }
      return;
    } catch (err) {
      console.error(`[paperclip] Error posting comment (attempt ${attempt}/${retries}):`, (err as Error).message);
      if (attempt < retries) {
        await sleep(2000 * attempt);
      }
    }
  }
}

export async function wakeAgent(
  agentId: string,
  reason: string,
  source: 'automation' | 'manual' | 'callback' = 'automation'
): Promise<boolean> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const agentKey = getAgentKeys()[agentId];
    if (agentKey && !agentKey.includes('placeholder')) {
      headers['Authorization'] = `Bearer ${agentKey}`;
    }

    const res = await fetch(`${getPaperclipApiUrl()}/api/agents/${agentId}/wakeup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source,
        triggerDetail: source === 'manual' ? 'manual' : 'system',
        reason,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[paperclip] Failed to wake agent ${agentId}: ${res.status} ${text}`);
      return false;
    }

    return true;
  } catch (err: any) {
    console.error(`[paperclip] Error waking agent ${agentId}: ${err.message}`);
    return false;
  }
}

function sanitizeForWin1252(str: string): string {
  if (!str) return str;
  return str
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, '--')
    .replace(/\u2013/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2022/g, '*')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\x00-\xFF]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
