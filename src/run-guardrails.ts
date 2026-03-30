import { AGENTS } from './agent-types';
import { getCompanyId, getPaperclipApiUrl, getStuckRunMaxRetries, getStuckRunThresholdMs } from './config';
import { findAssignedIssues, patchIssue, postComment, wakeAgent } from './paperclip-api';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();

const ORCHESTRATION_AGENT_IDS = new Set<string>([
  AGENTS['complexity router'],
  AGENTS.strategist,
  AGENTS['tech lead'],
  AGENTS['local builder'],
  AGENTS.reviewer,
  AGENTS['diff guardian'],
  AGENTS['visual reviewer'],
  AGENTS.sentinel,
  AGENTS.deployer,
  AGENTS['epic reviewer'],
  AGENTS['epic decoder'],
].filter(Boolean));

const BUILD_FLOW_AGENT_IDS = new Set<string>([
  AGENTS['complexity router'],
  AGENTS.strategist,
  AGENTS['tech lead'],
  AGENTS['local builder'],
  AGENTS.reviewer,
  AGENTS['diff guardian'],
  AGENTS['visual reviewer'],
  AGENTS.sentinel,
  AGENTS.deployer,
].filter(Boolean));

const stallRetriesByKey = new Map<string, number>();
const escalatedByKey = new Set<string>();

interface PaperclipAgent {
  id: string;
  name: string;
  status?: string;
  currentRunId?: string | null;
  lastHeartbeatAt?: string | null;
  updatedAt?: string | null;
}

function getAgentIssueKey(agentId: string, issueId: string | null): string {
  return `${agentId}:${issueId || 'none'}`;
}

function getAgentStaleAgeMs(agent: PaperclipAgent): number {
  const ts = new Date(agent.lastHeartbeatAt || agent.updatedAt || 0).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return Number.MAX_SAFE_INTEGER;
  return Date.now() - ts;
}

async function fetchAgents(): Promise<PaperclipAgent[]> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/agents`);
    if (!res.ok) return [];
    const data = await res.json() as any[] | { agents?: any[]; data?: any[] };
    const list = Array.isArray(data) ? data : data.agents || data.data || [];
    return list as PaperclipAgent[];
  } catch {
    return [];
  }
}

async function cancelRunBestEffort(agent: PaperclipAgent): Promise<void> {
  const runId = agent.currentRunId || '';
  const endpoints: Array<{ method: 'POST' | 'PATCH'; url: string; body?: any }> = [];

  if (runId) {
    endpoints.push(
      { method: 'POST', url: `${PAPERCLIP_API}/api/runs/${runId}/cancel`, body: {} },
      { method: 'POST', url: `${PAPERCLIP_API}/api/agent-runs/${runId}/cancel`, body: {} },
      { method: 'POST', url: `${PAPERCLIP_API}/api/agents/${agent.id}/runs/${runId}/cancel`, body: {} },
      { method: 'PATCH', url: `${PAPERCLIP_API}/api/runs/${runId}`, body: { status: 'cancelled' } },
      { method: 'PATCH', url: `${PAPERCLIP_API}/api/agent-runs/${runId}`, body: { status: 'cancelled' } },
    );
  }

  endpoints.push(
    { method: 'POST', url: `${PAPERCLIP_API}/api/agents/${agent.id}/interrupt`, body: {} },
    { method: 'PATCH', url: `${PAPERCLIP_API}/api/agents/${agent.id}`, body: { status: 'idle' } },
  );

  for (const endpoint of endpoints) {
    try {
      await fetch(endpoint.url, {
        method: endpoint.method,
        headers: { 'Content-Type': 'application/json' },
        body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
      });
    } catch {
      // best-effort only
    }
  }
}

async function getPrimaryAssignedIssueId(agentId: string): Promise<string | null> {
  const assigned = await findAssignedIssues(agentId);
  if (assigned.length === 0) return null;
  return assigned[0].id;
}

export async function monitorStuckRuns(): Promise<void> {
  const thresholdMs = getStuckRunThresholdMs();
  const maxRetries = getStuckRunMaxRetries();
  const agents = await fetchAgents();

  for (const agent of agents) {
    if (!ORCHESTRATION_AGENT_IDS.has(agent.id)) continue;
    const status = String(agent.status || '').toLowerCase();
    const runningOrQueued = status === 'running' || status === 'queued';
    if (!runningOrQueued) continue;

    const ageMs = getAgentStaleAgeMs(agent);
    if (ageMs < thresholdMs) continue;

    const issueId = await getPrimaryAssignedIssueId(agent.id);
    const retryKey = getAgentIssueKey(agent.id, issueId);
    const retries = stallRetriesByKey.get(retryKey) || 0;

    await cancelRunBestEffort(agent);

    if (retries < maxRetries) {
      stallRetriesByKey.set(retryKey, retries + 1);
      const issueIds = issueId ? [issueId] : [];
      await wakeAgent(
        agent.id,
        `stuck_run_retry:${retries + 1}/${maxRetries}`,
        'automation',
        issueIds.length ? { issueIds } : {}
      );

      if (issueId) {
        await postComment(
          issueId,
          null,
          `[AUTO-RECOVERY] Cancelled stale ${agent.name} run after ${Math.round(ageMs / 1000)}s and retried (${retries + 1}/${maxRetries}).`
        );
      }
      console.log(`[guardrails] Retried stale ${agent.name} (${retries + 1}/${maxRetries})`);
      continue;
    }

    if (!escalatedByKey.has(retryKey)) {
      escalatedByKey.add(retryKey);
      if (issueId) {
        await postComment(
          issueId,
          null,
          `[ESCALATION] ${agent.name} run stalled again after retry. Auto-retries stopped to avoid loops. Please inspect model/runtime state before resuming.`
        );
      }
      console.log(`[guardrails] Escalated stalled ${agent.name} after ${retries} retries`);
    }
  }
}

export async function normalizeOrchestrationRecovery(): Promise<void> {
  const agents = await fetchAgents();
  const thresholdMs = getStuckRunThresholdMs();
  const staleStatuses = new Set(['running', 'queued']);

  let resetAgents = 0;
  for (const agent of agents) {
    if (!ORCHESTRATION_AGENT_IDS.has(agent.id)) continue;
    const status = String(agent.status || '').toLowerCase();

    if (status === 'error') {
      await fetch(`${PAPERCLIP_API}/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'idle' }),
      }).catch(() => {});
      resetAgents++;
      continue;
    }

    if (staleStatuses.has(status) && getAgentStaleAgeMs(agent) >= thresholdMs) {
      await cancelRunBestEffort(agent);
      resetAgents++;
    }
  }

  let normalizedIssues = 0;
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (res.ok) {
      const data = await res.json() as any[] | { issues?: any[]; data?: any[] };
      const issues = Array.isArray(data) ? data : data.issues || data.data || [];
      for (const issue of issues) {
        const status = String(issue.status || '').toLowerCase();
        const assignee = String(issue.assigneeAgentId || '');
        if (!assignee) continue;

        if ((status === 'done' || status === 'cancelled') && assignee) {
          const ok = await patchIssue(issue.id, { assigneeAgentId: undefined } as any);
          if (ok) normalizedIssues++;
          continue;
        }

        if (status === 'in_review' && BUILD_FLOW_AGENT_IDS.has(assignee)) {
          const ok = await patchIssue(issue.id, { assigneeAgentId: AGENTS.reviewer } as any);
          if (ok) normalizedIssues++;
          continue;
        }

        if ((status === 'todo' || status === 'in_progress') && assignee === AGENTS['epic reviewer']) {
          const ok = await patchIssue(issue.id, { assigneeAgentId: undefined } as any);
          if (ok) normalizedIssues++;
        }
      }
    }
  } catch {
    // best-effort only
  }

  console.log(`[guardrails] Recovery normalization complete (agents reset: ${resetAgents}, issues normalized: ${normalizedIssues})`);
}

