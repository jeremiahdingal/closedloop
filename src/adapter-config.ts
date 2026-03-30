import { getCompanyId, getPaperclipApiUrl, getWorkspace } from './config';
import { AGENTS } from './agent-types';

const ORCHESTRATION_HTTP_AGENT_IDS = new Set<string>([
  AGENTS['complexity router'],
  AGENTS['strategist'],
  AGENTS['tech lead'],
  AGENTS['local builder'],
  AGENTS['reviewer'],
  AGENTS['diff guardian'],
  AGENTS['visual reviewer'],
  AGENTS['sentinel'],
  AGENTS['deployer'],
  AGENTS['epic decoder'],
].filter(Boolean));

const EPIC_REVIEWER_AGENT_ID = AGENTS['epic reviewer'];
const EPIC_REVIEWER_TIMEOUT_SEC = 1800;

function buildEpicReviewerPromptTemplate(): string {
  return [
    'You are {{agent.name}} ({{agent.id}}).',
    'Wake reason: {{context.wakeReason}}',
    'Wake source: {{context.wakeSource}}',
    'Issue ID: {{context.issueId}}',
    'Task ID: {{context.taskId}}',
    'Linked issue IDs: {{context.issueIds}}',
    '',
    'You are Epic Reviewer for this project.',
    'Read the workspace directly and do not ask for pasted file contents.',
    'Review the epic PRs, reconcile duplicate or parallel files into canonical paths, and keep the review PR-first.',
    'Use the workspace to inspect related files as needed.',
    '',
    'Use exactly this structure:',
    '## Summary',
    '- What you reviewed',
    '## Findings',
    '- Key issues or blockers',
    '## Actions',
    '- Concrete repo reads or fixes',
    '## Next',
    '- Immediate next step and any blocker',
  ].join('\n');
}

export async function ensureOrchestrationHttpAdapters(): Promise<void> {
  const api = getPaperclipApiUrl();
  const companyId = getCompanyId();
  const targetUrl = 'http://127.0.0.1:3201';

  try {
    const res = await fetch(`${api}/api/companies/${companyId}/agents`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { agents?: any[]; data?: any[] };
    const agents = Array.isArray(data) ? data : data.agents || data.data || [];

    for (const agent of agents) {
      if (!ORCHESTRATION_HTTP_AGENT_IDS.has(agent.id)) continue;
      const needsType = agent.adapterType !== 'http';
      const needsUrl = (agent.adapterConfig?.url || '') !== targetUrl;
      if (!needsType && !needsUrl) continue;

      const patchRes = await fetch(`${api}/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapterType: 'http',
          adapterConfig: { url: targetUrl },
        }),
      });

      if (patchRes.ok) {
        console.log(`[closedloop] Set orchestration adapter for ${agent.name} -> http:${targetUrl}`);
      } else {
        const err = await patchRes.text();
        console.log(`[closedloop] Failed orchestration adapter sync for ${agent.name}: ${patchRes.status} ${err.slice(0, 200)}`);
      }
    }
  } catch (err: any) {
    console.log(`[closedloop] Could not sync orchestration adapters: ${err.message}`);
  }
}

export async function ensureEpicReviewerNativeAdapter(): Promise<void> {
  if (!EPIC_REVIEWER_AGENT_ID) return;

  const api = getPaperclipApiUrl();
  const companyId = getCompanyId();
  const cwd = getWorkspace();
  const desiredAdapterConfig = {
    cwd,
    timeoutSec: EPIC_REVIEWER_TIMEOUT_SEC,
    promptTemplate: buildEpicReviewerPromptTemplate(),
  };

  try {
    const res = await fetch(`${api}/api/companies/${companyId}/agents`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { agents?: any[]; data?: any[] };
    const agents = Array.isArray(data) ? data : data.agents || data.data || [];
    const agent = agents.find((entry) => entry.id === EPIC_REVIEWER_AGENT_ID);
    if (!agent) return;

    const needsType = agent.adapterType !== 'codex_local';
    const needsCwd = (agent.adapterConfig?.cwd || '') !== cwd;
    const needsTimeout = Number(agent.adapterConfig?.timeoutSec || 0) !== EPIC_REVIEWER_TIMEOUT_SEC;
    const needsPrompt = (agent.adapterConfig?.promptTemplate || '') !== desiredAdapterConfig.promptTemplate;
    if (!needsType && !needsCwd && !needsTimeout && !needsPrompt) return;

    const patchRes = await fetch(`${api}/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapterType: 'codex_local',
        adapterConfig: desiredAdapterConfig,
      }),
    });

    if (patchRes.ok) {
      console.log(`[closedloop] Set Epic Reviewer adapter -> codex_local`);
    } else {
      const err = await patchRes.text();
      console.log(`[closedloop] Failed Epic Reviewer adapter sync: ${patchRes.status} ${err.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.log(`[closedloop] Could not sync Epic Reviewer adapter: ${err.message}`);
  }
}
