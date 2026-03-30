import { getCompanyId, getPaperclipApiUrl, getWorkspace } from './config';
import { AGENTS } from './agent-types';

const UPSTREAM_NATIVE_OPENCODE_AGENT_IDS = new Set<string>([
  AGENTS['complexity router'],
  AGENTS.strategist,
  AGENTS['tech lead'],
  AGENTS['local builder'],
  AGENTS['coder remote'],
  AGENTS['visual reviewer'],
  AGENTS.sentinel,
  AGENTS.deployer,
  AGENTS['epic decoder'],
].filter(Boolean));

const REPO_AWARE_OPENCODE_AGENT_IDS = new Set<string>([
  AGENTS['scaffold architect'],
  AGENTS.reviewer,
  AGENTS['diff guardian'],
].filter(Boolean));

const EPIC_REVIEWER_AGENT_ID = AGENTS['epic reviewer'];
const EPIC_REVIEWER_TIMEOUT_SEC = 1800;
const SCAFFOLD_ARCHITECT_TIMEOUT_SEC = 600;
const REVIEWER_TIMEOUT_SEC = 900;
const DIFF_GUARDIAN_TIMEOUT_SEC = 600;
const UPSTREAM_TIMEOUT_SEC = 900;
const LONG_TIMEOUT_SEC = 1800;

const OPENCODE_COMPLEXITY_ROUTER_MODEL = 'ollama/qwen3:8b';
const OPENCODE_STRATEGIST_MODEL = 'ollama/qwen3:8b';
const OPENCODE_TECH_LEAD_MODEL = 'ollama/deepcoder:14b';
const OPENCODE_LOCAL_BUILDER_MODEL = 'ollama/devstal:8b-small';
const OPENCODE_CODER_REMOTE_MODEL = 'ollama/qwen2.5-coder:7b';
const OPENCODE_VISUAL_REVIEWER_MODEL = 'ollama/qwen3:8b';
const OPENCODE_SENTINEL_MODEL = 'ollama/qwen3:4b';
const OPENCODE_DEPLOYER_MODEL = 'ollama/qwen3:8b';
const OPENCODE_EPIC_DECODER_MODEL = 'ollama/qwen3:8b';
const SCAFFOLD_ARCHITECT_MODEL = 'ollama/qwen3:8b';
const REVIEWER_MODEL = 'ollama/qwen3:8b';
const DIFF_GUARDIAN_MODEL = 'ollama/qwen3:4b';

function sharedIssueContextLines(): string[] {
  return [
    'You have been woken by the ClosedLoop orchestrator.',
    'Your assigned issue details are in the INSTRUCTIONS.md file in your workspace root.',
    'Read INSTRUCTIONS.md first to understand your task.',
    '',
  ];
}

function buildNativePromptTemplate(
  agentName: string,
  instructions: string[],
  outputSections: string[],
): string {
  return [
    ...sharedIssueContextLines(),
    `You are ${agentName} for this project.`,
    'Read the workspace directly and do not ask for pasted file contents.',
    ...instructions,
    '',
    'Use exactly this structure:',
    ...outputSections,
  ].join('\n');
}

function buildEpicReviewerPromptTemplate(): string {
  return buildNativePromptTemplate('Epic Reviewer', [
    'Review the epic PRs, reconcile duplicate or parallel files into canonical paths, and keep the review PR-first.',
    'Use the workspace to inspect related files as needed.',
  ], [
    '## Summary',
    '- What you reviewed',
    '## Findings',
    '- Key issues or blockers',
    '## Actions',
    '- Concrete repo reads or fixes',
    '## Verdict',
    '- VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED',
    '## Next',
    '- Immediate next step and any blocker',
  ]);
}

function buildPromptTemplate(agentName: string, instructions: string[], outputSections: string[]): string {
  return buildNativePromptTemplate(agentName, instructions, outputSections);
}

function buildScaffoldArchitectPromptTemplate(): string {
  return buildPromptTemplate('Scaffold Architect', [
    'Continue your assigned Paperclip work.',
    'Read the workspace directly when you need repo context.',
    'Always output a non-empty markdown run report, even if blocked or no task is available.',
    'Never return an empty response.',
  ], [
    '## Summary',
    '- What you did or checked',
    '## Actions',
    '- Concrete steps completed in this run',
    '## Next',
    '- Immediate next step and any blocker',
  ]);
}

function buildReviewerPromptTemplate(): string {
  return buildPromptTemplate('Reviewer', [
    'READ ONLY - Do not modify any files. Do not run builds. Do not write code.',
    'Review the current change set for correctness, tests, and duplicate-file drift.',
    'Treat ambiguous conclusions as non-approval.',
    'If changes are acceptable, return `VERDICT: APPROVED`.',
    'Otherwise return `VERDICT: CHANGES_REQUESTED` with concrete blockers.',
    'Output format:',
    '[STATE: approved]',
    '[FEEDBACK: Your review comments]',
    '[FILES: files you reviewed]',
  ], [
    '## Summary',
    '- What you checked',
    '## Findings',
    '- Key issues or blockers',
    '## Verdict',
    '- VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED',
    '## Next',
    '- Immediate next step and any blocker',
  ]);
}

function buildDiffGuardianPromptTemplate(): string {
  return buildPromptTemplate('Diff Guardian', [
    'Inspect the diff for duplicate or parallel files, destructive deletions, and export regressions.',
    'Fail closed on uncertainty.',
    'If the change set is safe, return `VERDICT: APPROVED`.',
    'Otherwise return `VERDICT: CHANGES_REQUESTED` with the specific drift or policy issue.',
  ], [
    '## Summary',
    '- What you checked',
    '## Findings',
    '- Key issues or blockers',
    '## Verdict',
    '- VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED',
    '## Next',
    '- Immediate next step and any blocker',
  ]);
}

async function syncNativeRepoAwareAgent(
  agent: any,
  desiredAdapterType: string,
  desiredAdapterConfig: Record<string, unknown>,
  logLabel: string,
): Promise<void> {
  const api = getPaperclipApiUrl();
  const needsType = agent.adapterType !== desiredAdapterType;
  const needsConfig = Object.entries(desiredAdapterConfig).some(([key, value]) => {
    const currentValue = agent.adapterConfig?.[key];
    if (typeof value === 'number') {
      return Number(currentValue ?? 0) !== value;
    }
    return String(currentValue ?? '') !== String(value);
  });
  if (!needsType && !needsConfig) return;

  const patchRes = await fetch(`${api}/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adapterType: desiredAdapterType,
      adapterConfig: desiredAdapterConfig,
    }),
  });

  if (patchRes.ok) {
    console.log(`[closedloop] Set ${logLabel} -> ${desiredAdapterType}`);
  } else {
    const err = await patchRes.text();
    console.log(`[closedloop] Failed ${logLabel} sync: ${patchRes.status} ${err.slice(0, 200)}`);
  }
}

export async function ensureUpstreamOpenCodeAdapters(): Promise<void> {
  const api = getPaperclipApiUrl();
  const companyId = getCompanyId();
  const cwd = getWorkspace();

  try {
    const res = await fetch(`${api}/api/companies/${companyId}/agents`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { agents?: any[]; data?: any[] };
    const agents = Array.isArray(data) ? data : data.agents || data.data || [];

    for (const agent of agents) {
      if (!UPSTREAM_NATIVE_OPENCODE_AGENT_IDS.has(agent.id)) continue;

      let desiredAdapterConfig: Record<string, unknown> | null = null;
      let logLabel = agent.name;

      if (agent.id === AGENTS['complexity router']) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_COMPLEXITY_ROUTER_MODEL,
          timeoutSec: UPSTREAM_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Complexity Router', [
            'Route the issue to the right downstream agent based on scope, risk, and missing context.',
            'Do not implement the task yourself unless you are the only viable execution path.',
          ], [
            '## Routing',
            '- Best downstream agent or blocker',
            '## Findings',
            '- Scope signals and risks',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Complexity Router';
      } else if (agent.id === AGENTS.strategist) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_STRATEGIST_MODEL,
          timeoutSec: UPSTREAM_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Strategist', [
            'Produce a concise plan and delegate work to the right downstream agents.',
            'Keep the plan actionable and avoid broad speculation.',
          ], [
            '## Summary',
            '- What you assessed',
            '## Plan',
            '- Ordered implementation steps',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Strategist';
      } else if (agent.id === AGENTS['tech lead']) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_TECH_LEAD_MODEL,
          timeoutSec: UPSTREAM_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Tech Lead', [
            'Translate the issue into a clear implementation plan with canonical file boundaries.',
            'Hand off implementation details to the builder when appropriate.',
          ], [
            '## Summary',
            '- What you assessed',
            '## Architecture',
            '- Design choices and boundaries',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Tech Lead';
      } else if (agent.id === AGENTS['local builder']) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_LOCAL_BUILDER_MODEL,
          timeoutSec: LONG_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Local Builder', [
            'Implement the assigned ticket directly in the workspace.',
            'Prefer canonical existing files over creating duplicate parallel implementations.',
            'Keep styling and project conventions aligned with the repository rules.',
          ], [
            '## Summary',
            '- What you changed or checked',
            '## Files',
            '- Files read or written',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Local Builder';
      } else if (agent.id === AGENTS['coder remote']) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_CODER_REMOTE_MODEL,
          timeoutSec: LONG_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Coder Remote', [
            'Implement the assigned remote coding task with repository-aware changes.',
            'Use the workspace directly and avoid duplicate file trees.',
          ], [
            '## Summary',
            '- What you changed or checked',
            '## Files',
            '- Files read or written',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Coder Remote';
      } else if (agent.id === AGENTS['visual reviewer']) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_VISUAL_REVIEWER_MODEL,
          timeoutSec: UPSTREAM_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Visual Reviewer', [
            'Inspect the current implementation for visual and layout regressions using the workspace and any attached visual context.',
            'Call out any UI mismatches or missing states clearly.',
          ], [
            '## Summary',
            '- What you checked',
            '## Findings',
            '- Visual issues or blockers',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Visual Reviewer';
      } else if (agent.id === AGENTS.sentinel) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_SENTINEL_MODEL,
          timeoutSec: UPSTREAM_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Sentinel', [
            'Watch for stuck runs, drift, retries, and unsafe transitions.',
            'Fail closed when the state looks inconsistent.',
          ], [
            '## Summary',
            '- What you checked',
            '## Findings',
            '- Risks or blockers',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Sentinel';
      } else if (agent.id === AGENTS.deployer) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_DEPLOYER_MODEL,
          timeoutSec: UPSTREAM_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Deployer', [
            'Verify deployment readiness, rollout steps, and the expected post-deploy checks.',
            'Report blockers before any release action.',
          ], [
            '## Summary',
            '- What you checked',
            '## Deployment',
            '- Readiness and rollout notes',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Deployer';
      } else if (agent.id === AGENTS['epic decoder']) {
        desiredAdapterConfig = {
          cwd,
          model: OPENCODE_EPIC_DECODER_MODEL,
          timeoutSec: UPSTREAM_TIMEOUT_SEC,
          promptTemplate: buildPromptTemplate('Epic Decoder', [
            'Break the epic into ordered, reviewable tickets and keep the flow PR-first.',
            'Only split work when there is a clear execution path.',
          ], [
            '## Summary',
            '- What you decomposed',
            '## Breakdown',
            '- Proposed ticket order and dependencies',
            '## Next',
            '- Immediate next step and any blocker',
          ]),
        };
        logLabel = 'Epic Decoder';
      }

      if (!desiredAdapterConfig) continue;
      await syncNativeRepoAwareAgent(agent, 'opencode_local', desiredAdapterConfig, logLabel);
    }
  } catch (err: any) {
    console.log(`[closedloop] Could not sync upstream OpenCode adapters: ${err.message}`);
  }
}

export async function ensureOrchestrationHttpAdapters(): Promise<void> {
  return ensureUpstreamOpenCodeAdapters();
}

export async function ensureRepoAwareOpenCodeAdapters(): Promise<void> {
  const api = getPaperclipApiUrl();
  const companyId = getCompanyId();
  const cwd = getWorkspace();

  try {
    const res = await fetch(`${api}/api/companies/${companyId}/agents`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { agents?: any[]; data?: any[] };
    const agents = Array.isArray(data) ? data : data.agents || data.data || [];

    for (const agent of agents) {
      if (!REPO_AWARE_OPENCODE_AGENT_IDS.has(agent.id)) continue;

      if (agent.id === AGENTS['scaffold architect']) {
        await syncNativeRepoAwareAgent(agent, 'opencode_local', {
          cwd,
          model: SCAFFOLD_ARCHITECT_MODEL,
          timeoutSec: SCAFFOLD_ARCHITECT_TIMEOUT_SEC,
          promptTemplate: buildScaffoldArchitectPromptTemplate(),
        }, 'Scaffold Architect');
        continue;
      }

      if (agent.id === AGENTS.reviewer) {
        await syncNativeRepoAwareAgent(agent, 'opencode_local', {
          cwd,
          model: REVIEWER_MODEL,
          timeoutSec: REVIEWER_TIMEOUT_SEC,
          promptTemplate: buildReviewerPromptTemplate(),
        }, 'Reviewer');
        continue;
      }

      if (agent.id === AGENTS['diff guardian']) {
        await syncNativeRepoAwareAgent(agent, 'opencode_local', {
          cwd,
          model: DIFF_GUARDIAN_MODEL,
          timeoutSec: DIFF_GUARDIAN_TIMEOUT_SEC,
          promptTemplate: buildDiffGuardianPromptTemplate(),
        }, 'Diff Guardian');
      }
    }
  } catch (err: any) {
    console.log(`[closedloop] Could not sync repo-aware OpenCode adapters: ${err.message}`);
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
