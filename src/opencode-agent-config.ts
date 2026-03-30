import { getCompanyId, getPaperclipApiUrl, getWorkspace } from './config';
import { AGENTS } from './agent-types';

const RUN_VISIBILITY_PROMPT_TEMPLATE = [
  'You are {{agent.name}} ({{agent.id}}).',
  'Wake reason: {{context.wakeReason}}',
  'Wake source: {{context.wakeSource}}',
  'Issue ID: {{context.issueId}}',
  'Task ID: {{context.taskId}}',
  'Linked issue IDs: {{context.issueIds}}',
  '',
  'Continue your assigned Paperclip work.',
  'Always output a non-empty markdown run report, even if blocked or no task is available.',
  'Never return an empty response.',
  '',
  'Use exactly this structure:',
  '## Summary',
  '- What you did or checked',
  '## Actions',
  '- Concrete steps completed in this run',
  '## Next',
  '- Immediate next step and any blocker',
].join('\n');

export async function ensureOpencodeRunVisibilityConfig(): Promise<void> {
  const api = getPaperclipApiUrl();
  const companyId = getCompanyId();
  const workspace = getWorkspace().replace(/\\/g, '/');

  try {
    const res = await fetch(`${api}/api/companies/${companyId}/agents`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { agents?: any[]; data?: any[] };
    const agents = Array.isArray(data) ? data : data.agents || data.data || [];

    for (const agent of agents) {
      if (agent.adapterType !== 'opencode_local') continue;

      const detailRes = await fetch(`${api}/api/agents/${agent.id}`);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json() as any;
      const adapterConfig = { ...(detail.adapterConfig || {}) };

      const currentTemplate = String(adapterConfig.promptTemplate || '');
      const needsTemplate = !currentTemplate.includes('## Summary');
      const needsCwd = !adapterConfig.cwd;
      if (!needsTemplate && !needsCwd) continue;

      adapterConfig.promptTemplate = RUN_VISIBILITY_PROMPT_TEMPLATE;
      if (!adapterConfig.cwd) {
        adapterConfig.cwd = workspace;
      }

      const patchRes = await fetch(`${api}/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapterType: 'opencode_local',
          adapterConfig,
        }),
      });

      if (patchRes.ok) {
        console.log(`[closedloop] Updated OpenCode run-visibility config for ${agent.name}`);
      } else {
        const err = await patchRes.text();
        console.log(`[closedloop] Failed to update OpenCode config for ${agent.name}: ${patchRes.status} ${err.slice(0, 200)}`);
      }
    }
  } catch (err: any) {
    console.log(`[closedloop] Could not sync OpenCode run-visibility config: ${err.message}`);
  }
}

const ORCHESTRATION_AGENT_IDS = new Set<string>([
  AGENTS['complexity router'],
  AGENTS['strategist'],
  AGENTS['tech lead'],
  AGENTS['local builder'],
  AGENTS['reviewer'],
  AGENTS['diff guardian'],
  AGENTS['visual reviewer'],
  AGENTS['sentinel'],
  AGENTS['deployer'],
  AGENTS['epic reviewer'],
  AGENTS['epic decoder'],
].filter(Boolean));

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
      if (!ORCHESTRATION_AGENT_IDS.has(agent.id)) continue;
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
