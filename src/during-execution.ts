import { execSync } from 'child_process';
import { AGENTS } from './agent-types';
import { getCompanyId, getPaperclipApiUrl, getWorkspace } from './config';
import { findAssignedIssues, patchIssue, postComment, wakeAgent } from './paperclip-api';
import { hasErrors, extractErrors } from './output-parser';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();

const MONITORED_AGENT_IDS = new Set<string>([
  AGENTS['local builder'],
  AGENTS['scaffold architect'],
  AGENTS.reviewer,
  AGENTS['epic reviewer'],
].filter(Boolean));

interface ActiveRun {
  id: string;
  agentId: string;
  status: string;
  startedAt: string;
  issueId?: string;
}

const runFileSnapshots = new Map<string, string>();

function getFileState(workspace: string): string {
  try {
    const diff = execSync('git diff --name-only', { cwd: workspace, encoding: 'utf8', timeout: 5000 }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: workspace, encoding: 'utf8', timeout: 5000 }).trim();
    return `${diff}|${untracked}`;
  } catch {
    return '';
  }
}

async function fetchActiveRuns(): Promise<ActiveRun[]> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/runs?status=running`);
    if (!res.ok) return [];
    
    const data = await res.json() as any[] | { runs?: any[]; data?: any[] };
    const runs = Array.isArray(data) ? data : data.runs || data.data || [];
    
    return runs
      .filter(run => MONITORED_AGENT_IDS.has(run.agentId))
      .map(run => ({
        id: run.id,
        agentId: run.agentId,
        status: run.status,
        startedAt: run.startedAt || run.createdAt,
      }));
  } catch {
    return [];
  }
}

async function fetchRunOutput(runId: string): Promise<string> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/runs/${runId}/output`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.output || data.text || data.content || '';
  } catch {
    return '';
  }
}

export async function monitorActiveRuns(): Promise<void> {
  const workspace = getWorkspace();
  const activeRuns = await fetchActiveRuns();
  
  for (const run of activeRuns) {
    const currentFileState = getFileState(workspace);
    const previousFileState = runFileSnapshots.get(run.id);
    
    runFileSnapshots.set(run.id, currentFileState);
    
    if (!previousFileState) continue;
    
    const hasNewChanges = currentFileState !== previousFileState;
    const runDuration = Date.now() - new Date(run.startedAt).getTime();
    const fiveMinutes = 5 * 60 * 1000;
    
    if (!hasNewChanges && runDuration > fiveMinutes) {
      console.log(`[during-execution] Run ${run.id.slice(0, 8)} has no file changes in ${Math.round(runDuration / 60000)} min`);
      
      const issues = await findAssignedIssues(run.agentId);
      if (issues.length === 0) continue;
      const issue = issues[0];
      
      const output = await fetchRunOutput(run.id);
      if (hasErrors(output)) {
        const errors = extractErrors(output);
        await postComment(issue.id, null,
          `⚠️ Execution has errors with no progress:\n` +
          errors.slice(0, 3).map(e => `- ${e}`).join('\n')
        );
        
        await patchIssue(issue.id, { status: 'todo' });
        console.log(`[during-execution] Run ${run.id.slice(0, 8)}: errors detected, issue ${issue.identifier} returned to todo`);
      }
    }
  }
}

export async function checkForErrorsInRunningRuns(): Promise<void> {
  const activeRuns = await fetchActiveRuns();
  
  for (const run of activeRuns) {
    const issues = await findAssignedIssues(run.agentId);
    if (issues.length === 0) continue;
    const issue = issues[0];
    
    const output = await fetchRunOutput(run.id);
    if (hasErrors(output)) {
      const errors = extractErrors(output);
      
      await postComment(issue.id, null,
        `⚠️ Error detected during execution:\n` +
        errors.slice(0, 5).map(e => `- ${e}`).join('\n')
      );
      
      console.log(`[during-execution] Run ${run.id.slice(0, 8)}: posted error comment for ${issue.identifier}`);
    }
  }
}
