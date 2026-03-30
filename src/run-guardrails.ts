import { execSync } from 'child_process';
import { AGENTS } from './agent-types';
import { getCompanyId, getPaperclipApiUrl, getStuckRunMaxRetries, getStuckRunThresholdMs, getWorkspace } from './config';
import { findAssignedIssues, patchIssue, postComment, wakeAgent } from './paperclip-api';
import { createPullRequest } from './git-ops';
import { parseRunOutput, applyFallbackWithLLM, hasErrors, extractErrors, AgentType, diagnoseStuckAgent } from './output-parser';
import { detectDriftIssues, formatDriftReport } from './drift-detector';

const STAGE_PATTERNS = ['*.ts', '*.tsx', '*.js', '*.jsx'];
const IGNORE_PATTERNS = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'node_modules/**',
  'dist/**',
  'build/**',
  '.next/**',
  '.git/**',
  '.env*',
  '*.log',
  'INSTRUCTIONS.md',
  '.tickets/**',
  '.closedloop/**',
];

function shouldStageFile(filePath: string): boolean {
  for (const ignore of IGNORE_PATTERNS) {
    if (filePath.startsWith(ignore.replace('**', ''))) return false;
    if (filePath.includes(ignore.replace('*', ''))) return false;
  }
  for (const pattern of STAGE_PATTERNS) {
    if (filePath.endsWith(pattern.replace('*', ''))) return true;
  }
  return false;
}

function getFilesToStage(workspace: string): string[] {
  try {
    const diff = execSync('git diff --name-only HEAD', { cwd: workspace, encoding: 'utf8', timeout: 10000 });
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: workspace, encoding: 'utf8', timeout: 10000 });
    
    const changedFiles = diff.split('\n').map(f => f.trim()).filter(Boolean);
    const newFiles = untracked.split('\n').map(f => f.trim()).filter(Boolean);
    const allFiles = [...changedFiles, ...newFiles];
    
    return allFiles.filter(shouldStageFile);
  } catch {
    return [];
  }
}

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

async function getPrimaryReviewableIssueId(agentId: string): Promise<string | null> {
  const assigned = await findAssignedIssues(agentId);
  const reviewable = assigned.find((issue) => issue.status === 'in_review');
  return reviewable?.id ?? null;
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

    const issueId =
      agent.id === AGENTS.reviewer
        ? await getPrimaryReviewableIssueId(agent.id)
        : await getPrimaryAssignedIssueId(agent.id);
    const retryKey = getAgentIssueKey(agent.id, issueId);
    const retries = stallRetriesByKey.get(retryKey) || 0;

    await cancelRunBestEffort(agent);

    if (agent.id === AGENTS.reviewer && !issueId) {
      console.log(`[guardrails] Skipped retry for ${agent.name}: no reviewable in_review issue context`);
      continue;
    }

    // Get issue details for diagnosis
    let issueTitle = '';
    let issueDescription = '';
    let runOutput = '';
    
    if (issueId) {
      try {
        const issueRes = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues/${issueId}`);
        if (issueRes.ok) {
          const issueData = await issueRes.json();
          issueTitle = issueData.title || '';
          issueDescription = issueData.description || '';
        }
      } catch { /* best-effort */ }
      
      // Get run output for diagnosis
      const runId = agent.currentRunId;
      if (runId) {
        try {
          const outputRes = await fetch(`${PAPERCLIP_API}/api/runs/${runId}/output`);
          if (outputRes.ok) {
            const outputData = await outputRes.json();
            runOutput = outputData.output || outputData.text || outputData.content || '';
          }
        } catch { /* best-effort */ }
      }
    }

    // Diagnose and recommend action
    let recommendedAction: 'retry' | 'blocked' | 'todo' | 'escalate' = 'retry';
    let diagnosis = '';
    
    if (runOutput && issueTitle) {
      const agentType: AgentType = 
        agent.id === AGENTS.reviewer || agent.id === AGENTS['epic reviewer'] 
          ? 'reviewer' 
          : 'builder';
      
      try {
        const diag = await diagnoseStuckAgent(runOutput, issueTitle, issueDescription, agentType);
        diagnosis = diag.diagnosis;
        recommendedAction = diag.recommendedAction;
        console.log(`[guardrails] Diagnosis for ${agent.name}: ${diagnosis} -> ${recommendedAction}`);
      } catch (err) {
        console.log(`[guardrails] Diagnosis failed for ${agent.name}, defaulting to retry`);
      }
    }

    // Take action based on diagnosis
    if (recommendedAction === 'blocked' && issueId) {
      await patchIssue(issueId, { status: 'blocked' });
      await postComment(issueId, null,
        `🚫 Agent BLOCKED\n` +
        `Diagnosis: ${diagnosis || 'Unable to diagnose'}\n` +
        `Agent stalled after ${Math.round(ageMs / 1000)}s. Needs human intervention.`
      );
      console.log(`[guardrails] ${agent.name}: marked as blocked`);
      escalatedByKey.add(retryKey);
      continue;
    }
    
    if (recommendedAction === 'todo' && issueId) {
      await patchIssue(issueId, { status: 'todo', assigneeAgentId: undefined });
      await postComment(issueId, null,
        `🔄 Agent returned to todo\n` +
        `Diagnosis: ${diagnosis || 'Unable to diagnose'}\n` +
        `This task may need a different agent or approach.`
      );
      console.log(`[guardrails] ${agent.name}: returned to todo`);
      escalatedByKey.add(retryKey);
      continue;
    }
    
    if (recommendedAction === 'escalate') {
      if (!escalatedByKey.has(retryKey)) {
        escalatedByKey.add(retryKey);
        if (issueId) {
          await postComment(issueId, null,
            `⚠️ ESCALATION - Agent doctor recommended escalation\n` +
            `Diagnosis: ${diagnosis || 'Unable to diagnose'}\n` +
            `Please investigate manually.`
          );
        }
      }
      console.log(`[guardrails] ${agent.name}: escalated`);
      continue;
    }

    // Default: retry
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
          `[AUTO-RECOVERY] Cancelled stale ${agent.name} run after ${Math.round(ageMs / 1000)}s and retried (${retries + 1}/${maxRetries}).\n` +
          `Diagnosis: ${diagnosis || 'Unknown'}`
        );
      }
      console.log(`[guardrails] Retried stale ${agent.name} (${retries + 1}/${maxRetries}) - diagnosis: ${diagnosis}`);
      continue;
    }

    // Max retries reached
    if (!escalatedByKey.has(retryKey)) {
      escalatedByKey.add(retryKey);
      if (issueId) {
        await postComment(
          issueId,
          null,
          `[ESCALATION] ${agent.name} run stalled after ${maxRetries} retries. Diagnosis: ${diagnosis || 'Unknown'}. Please inspect manually.`
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

// ─── Builder Run Completion Monitor ────────────────────────────────
// Checks for completed builder runs and handles post-execution lifecycle:
// detects workspace changes, creates branches/PRs, updates ticket status.

const BUILDER_AGENT_IDS = new Set<string>([
  AGENTS['local builder'],
  AGENTS['scaffold architect'],
].filter(Boolean));

const REVIEWER_AGENT_IDS = new Set<string>([
  AGENTS.reviewer,
  AGENTS['epic reviewer'],
].filter(Boolean));

const processedRuns = new Set<string>();

async function handleInterruptedRun(run: any): Promise<void> {
  const workspace = getWorkspace();
  
  // Find the issue assigned to this agent
  const issues = await findAssignedIssues(run.agentId);
  if (issues.length === 0) return;
  const issue = issues[0];
  
  // Check for any uncommitted changes
  let hasChanges = false;
  let changedFiles: string[] = [];
  
  try {
    const diffOutput = execSync('git diff --name-only HEAD', { cwd: workspace, encoding: 'utf8', timeout: 10000 }).trim();
    const untrackedOutput = execSync('git ls-files --others --exclude-standard', { cwd: workspace, encoding: 'utf8', timeout: 10000 }).trim();
    changedFiles = [...diffOutput.split('\n'), ...untrackedOutput.split('\n')]
      .map(f => f.trim())
      .filter(Boolean);
    hasChanges = changedFiles.length > 0;
  } catch { }
  
  if (!hasChanges) {
    // No changes made - just retry
    console.log(`[guardrails] Run ${run.id.slice(0, 8)} interrupted with no changes - will retry`);
    await postComment(issue.id, null,
      `⚠️ Run interrupted/cancelled with no changes. Will retry automatically.`
    );
    return;
  }
  
  // There are partial changes - commit them and let reviewer decide
  console.log(`[guardrails] Run ${run.id.slice(0, 8)} interrupted with ${changedFiles.length} files changed`);
  
  const branchName = `agent/${(issue.identifier || issue.id.slice(0, 8)).toLowerCase()}`;
  
  try {
    const filesToStage = getFilesToStage(workspace);
    
    if (filesToStage.length > 0) {
      execSync(`git checkout -B ${branchName}`, { cwd: workspace, encoding: 'utf8', timeout: 10000 });
      
      for (const file of filesToStage) {
        execSync(`git add "${file}"`, { cwd: workspace, encoding: 'utf8', timeout: 5000 });
      }
      
      const commitMsg = `${issue.identifier}: Partial work (interrupted)\n\nAutomated commit of interrupted run.`;
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: workspace, encoding: 'utf8', timeout: 10000 });
      
      console.log(`[guardrails] Committed partial work for ${issue.identifier}`);
      
      await postComment(issue.id, null,
        `⚠️ Run interrupted with partial work committed.\n` +
        `Files: ${filesToStage.join(', ')}\n` +
        `Status changed to in_review for review.`
      );
      
      // Move to in_review for reviewer to check
      await patchIssue(issue.id, { 
        status: 'in_review',
        assigneeAgentId: AGENTS.reviewer
      });
      
      execSync('git checkout main || git checkout master', { cwd: workspace, encoding: 'utf8', timeout: 10000 });
    } else {
      // No relevant files to stage
      await postComment(issue.id, null,
        `⚠️ Run interrupted. No relevant code changes detected.`
      );
    }
  } catch (err: any) {
    console.log(`[guardrails] Failed to handle interrupted run: ${err.message}`);
    await postComment(issue.id, null,
      `⚠️ Run interrupted. Failed to commit partial work: ${err.message}`
    );
    try { execSync('git checkout main || git checkout master', { cwd: workspace, encoding: 'utf8', timeout: 10000 }); } catch {}
  }
}

async function handleInterruptedReviewerRun(run: any): Promise<void> {
  // Find the issue assigned to this reviewer
  const issues = await findAssignedIssues(run.agentId);
  if (issues.length === 0) return;
  const issue = issues[0];
  
  // Reviewer interrupted - the code is already committed, just re-assign for review
  console.log(`[guardrails] Reviewer run ${run.id.slice(0, 8)} interrupted - re-assigning for review`);
  
  await postComment(issue.id, null,
    `⚠️ Review run interrupted. Re-assigning to reviewer for completion.`
  );
  
  // Re-assign to reviewer
  await patchIssue(issue.id, { 
    assigneeAgentId: AGENTS.reviewer
  });
}

interface ReviewResult {
  decision: 'approved' | 'rejected' | 'unknown';
  feedback: string;
  files: string[];
  usedFallback?: boolean;
}

function parseReviewOutput(output: string): ReviewResult {
  const approved = /\[STATE:\s*approved\]/i.test(output);
  const rejected = /\[STATE:\s*rejected\]/i.test(output);
  
  if (!approved && !rejected) {
    // Fallback: reject for safety if no clear decision
    return {
      decision: 'rejected',
      feedback: 'No [STATE: approved/rejected] block in output - defaulting to rejected for safety',
      files: [],
      usedFallback: true,
    };
  }
  
  const feedbackMatch = output.match(/\[FEEDBACK:\s*(.+?)\]/i);
  const filesMatch = output.match(/\[FILES:\s*(.+?)\]/i);
  
  return {
    decision: approved ? 'approved' : 'rejected',
    feedback: feedbackMatch?.[1]?.trim() || '',
    files: filesMatch?.[1]?.split(',').map(f => f.trim()).filter(Boolean) || [],
  };
}

export async function monitorCompletedBuilderRuns(): Promise<void> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/heartbeat-runs?limit=10`);
    if (!res.ok) return;
    const runs = await res.json() as any[];

    for (const run of runs) {
      if (processedRuns.has(run.id)) continue;
      
      // Handle interrupted/cancelled runs
      if (run.status === 'cancelled' || run.status === 'interrupted') {
        processedRuns.add(run.id);
        await handleInterruptedRun(run);
        continue;
      }
      
      if (run.status !== 'succeeded' && run.status !== 'failed') continue;
      if (!BUILDER_AGENT_IDS.has(run.agentId)) continue;

      processedRuns.add(run.id);

      // Find the issue assigned to this agent
      const issues = await findAssignedIssues(run.agentId);
      if (issues.length === 0) continue;

      const issue = issues[0];
      const workspace = getWorkspace();

      // Fetch run output and parse for state
      let runOutput = '';
      try {
        const outputRes = await fetch(`${PAPERCLIP_API}/api/runs/${run.id}/output`);
        if (outputRes.ok) {
          const outputData = await outputRes.json();
          runOutput = outputData.output || outputData.text || outputData.content || '';
        }
      } catch { /* best-effort */ }

      let result = parseRunOutput(runOutput);
      result = await applyFallbackWithLLM(result, 'builder', runOutput);
      
      if (result.usedFallback) {
        await postComment(issue.id, null,
          `⚠️ Builder output missing [STATE:] block - ${result.reason}`
        );
      }
      
      const hasRunErrors = hasErrors(runOutput);

      // Check if there are uncommitted changes or new commits
      let hasChanges = false;
      try {
        const diffOutput = execSync('git diff --stat HEAD', { cwd: workspace, encoding: 'utf8', timeout: 10000 }).trim();
        const untrackedOutput = execSync('git ls-files --others --exclude-standard', { cwd: workspace, encoding: 'utf8', timeout: 10000 }).trim();
        hasChanges = diffOutput.length > 0 || untrackedOutput.length > 0;
      } catch { }

      // State machine based on parsed output
      if (result.state === 'blocked') {
        // BLOCKED: Don't commit, update status to blocked
        console.log(`[guardrails] Builder run ${run.id.slice(0, 8)}: BLOCKED - ${result.reason || 'No reason provided'}`);
        await patchIssue(issue.id, { status: 'blocked' });
        await postComment(issue.id, null,
          `🚫 Builder run BLOCKED\n` +
          `Reason: ${result.reason || 'No reason provided'}\n` +
          `Summary: ${result.summary || 'N/A'}`
        );
        continue;
      }

      if (result.state === 'todo') {
        // TODO: Return to backlog with recommendation
        console.log(`[guardrails] Builder run ${run.id.slice(0, 8)}: TODO - ${result.recommendation || 'Returned to backlog'}`);
        await patchIssue(issue.id, { status: 'todo' });
        await postComment(issue.id, null,
          `🔄 Builder run returned to todo\n` +
          `Reason: ${result.reason || 'Incomplete work'}\n` +
          `Recommendation: ${result.recommendation || 'Re-run or assign to different agent'}`
        );
        continue;
      }

      if (!hasChanges && result.state !== 'done') {
        // No changes and not marked done - might be stuck or needs retry
        try {
          const log = execSync('git log --oneline -5', { cwd: workspace, encoding: 'utf8', timeout: 10000 }).trim();
          console.log(`[guardrails] Builder run ${run.id.slice(0, 8)} completed, no workspace changes. Recent: ${log.split('\n')[0]}`);
        } catch {}
        
        if (hasRunErrors) {
          const errors = extractErrors(runOutput);
          await postComment(issue.id, null,
            `⚠️ Builder run completed with errors:\n` +
            errors.slice(0, 5).map(e => `- ${e}`).join('\n')
          );
        }
        continue;
      }

      // For done/in_review/unknown - proceed with commit and status transition
      if (!hasChanges) {
        // Check if there are new commits since last known state
        try {
          const log = execSync('git log --oneline -5', { cwd: workspace, encoding: 'utf8', timeout: 10000 }).trim();
          console.log(`[guardrails] Builder run ${run.id.slice(0, 8)} completed, no workspace changes. Recent: ${log.split('\n')[0]}`);
        } catch {}
        continue;
      }

      // There are changes! Stage, commit, create branch, and push
      const branchName = `agent/${(issue.identifier || issue.id.slice(0, 8)).toLowerCase()}`;

      try {
        // Smart stage: only relevant files
        const filesToStage = getFilesToStage(workspace);
        
        if (filesToStage.length === 0) {
          console.log(`[guardrails] Builder run ${run.id.slice(0, 8)}: no relevant files to stage`);
          continue;
        }

        console.log(`[guardrails] Staging ${filesToStage.length} files: ${filesToStage.slice(0, 3).join(', ')}...`);

        // Check for drift issues before committing
        const driftIssues = await detectDriftIssues();
        
        if (driftIssues.length > 0) {
          console.log(`[guardrails] DRIFT DETECTED: ${driftIssues.length} issues found for ${issue.identifier}`);
          
          // Reject the changes - return to todo
          await patchIssue(issue.id, { 
            status: 'todo',
            assigneeAgentId: AGENTS['local builder']
          });
          
          const driftReport = formatDriftReport(driftIssues);
          await postComment(issue.id, null,
            `🚫 BLOCKED - Drift detected!\n\n` +
            `The following drift issues were found:\n${driftReport}\n\n` +
            `Please consolidate duplicate files before submitting for review.\n` +
            `This ticket has been returned to todo.`
          );
          
          // Switch back to main
          execSync('git checkout main || git checkout master', { cwd: workspace, encoding: 'utf8', timeout: 10000 });
          continue;
        }

        // Create branch and commit
        execSync(`git checkout -B ${branchName}`, { cwd: workspace, encoding: 'utf8', timeout: 10000 });
        
        // Stage only relevant files
        for (const file of filesToStage) {
          execSync(`git add "${file}"`, { cwd: workspace, encoding: 'utf8', timeout: 5000 });
        }
        
        const commitMsg = `${issue.identifier}: ${issue.title}\n\nAutomated by Local Builder via ClosedLoop native adapter.`;
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: workspace, encoding: 'utf8', timeout: 10000 });

        console.log(`[guardrails] Builder run ${run.id.slice(0, 8)}: committed ${filesToStage.length} files on ${branchName} for ${issue.identifier}`);

        // Determine target state based on parsed output
        const targetState = result.state === 'done' ? 'done' : 'in_review';
        
        // Update ticket status and assign to reviewer if in_review
        await patchIssue(issue.id, { 
          status: targetState,
          assigneeAgentId: targetState === 'in_review' ? AGENTS.reviewer : undefined 
        });
        
        const reviewerNote = targetState === 'in_review' ? '\nAssigned to Reviewer for code review.' : '';
        await postComment(issue.id, null,
          `Builder run completed. State: ${result.state}\n` +
          `Branch: \`${branchName}\`\n` +
          `Files: ${filesToStage.join(', ')}\n` +
          `Summary: ${result.summary || 'N/A'}\n` +
          `Status changed to ${targetState}.${reviewerNote}`
        );

        // Switch back to main branch
        execSync('git checkout main || git checkout master', { cwd: workspace, encoding: 'utf8', timeout: 10000 });

        console.log(`[guardrails] ${issue.identifier} moved to in_review after builder changes`);
      } catch (err: any) {
        console.log(`[guardrails] Failed to process builder changes for ${issue.identifier}: ${err.message}`);
        // Switch back to main anyway
        try { execSync('git checkout main || git checkout master', { cwd: workspace, encoding: 'utf8', timeout: 10000 }); } catch {}
      }
    }
  } catch (err: any) {
    // Silent fail — this is best-effort monitoring
  }
}

// Monitor completed reviewer runs - handle approved/rejected output
export async function monitorCompletedReviewerRuns(): Promise<void> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/heartbeat-runs?limit=10`);
    if (!res.ok) return;
    const runs = await res.json() as any[];

    for (const run of runs) {
      if (processedRuns.has(run.id)) continue;
      
      // Handle interrupted/cancelled runs
      if (run.status === 'cancelled' || run.status === 'interrupted') {
        processedRuns.add(run.id);
        await handleInterruptedReviewerRun(run);
        continue;
      }
      
      if (run.status !== 'succeeded' && run.status !== 'failed') continue;
      if (!REVIEWER_AGENT_IDS.has(run.agentId)) continue;

      processedRuns.add(run.id);

      // Find the issue assigned to this reviewer
      const issues = await findAssignedIssues(run.agentId);
      if (issues.length === 0) continue;
      
      const issue = issues[0];
      
      // Fetch run output and parse for review decision
      let runOutput = '';
      try {
        const outputRes = await fetch(`${PAPERCLIP_API}/api/runs/${run.id}/output`);
        if (outputRes.ok) {
          const outputData = await outputRes.json();
          runOutput = outputData.output || outputData.text || outputData.content || '';
        }
      } catch { /* best-effort */ }

      const review = parseReviewOutput(runOutput);
      
      if (review.usedFallback) {
        await postComment(issue.id, null,
          `⚠️ Review output missing [STATE: approved/rejected] block - ${review.feedback}`
        );
      }

      if (review.decision === 'approved') {
        // Approved - create PR and mark for Epic Reviewer
        console.log(`[guardrails] Reviewer approved ${issue.identifier}`);
        
        // Create PR
        try {
          await createPullRequest(issue.id);
          console.log(`[guardrails] PR created for ${issue.identifier}`);
        } catch (err: any) {
          console.log(`[guardrails] PR creation failed for ${issue.identifier}: ${err.message}`);
        }
        
        await postComment(issue.id, null,
          `✅ Review APPROVED\n` +
          `Feedback: ${review.feedback || 'Code looks good'}\n` +
          `Files reviewed: ${review.files.join(', ') || 'N/A'}\n` +
          `PR created - will be reviewed by Epic Reviewer.`
        );
      } else if (review.decision === 'rejected') {
        // Rejected - return to todo for builder to fix
        console.log(`[guardrails] Reviewer rejected ${issue.identifier} - returning to todo`);
        
        await patchIssue(issue.id, { 
          status: 'todo',
          assigneeAgentId: AGENTS['local builder']
        });
        
        await postComment(issue.id, null,
          `🔄 Review REJECTED - Returned to todo\n` +
          `Feedback: ${review.feedback || 'Please address review comments'}\n` +
          `Files needing work: ${review.files.join(', ') || 'N/A'}\n` +
          `Reassigned to Local Builder for fixes.`
        );
        
        console.log(`[guardrails] ${issue.identifier} returned to todo after review rejection`);
      }
    }
  } catch (err: any) {
    // Silent fail — this is best-effort monitoring
  }
}
