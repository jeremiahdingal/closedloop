/**
 * Session Manager - Spawns and monitors pi-mono sessions
 * Phase 2: Full pi-mono integration with build execution
 */

import { spawn, execSync } from 'child_process';
import { writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import * as http from 'http';

const SESSIONS_DIR = join(__dirname, '..', 'sessions');
const CONFIG_PATH = join(__dirname, '..', '..', '..', '.paperclip', 'project.json');
const SESSION_STATE_FILE = 'state.json';
const CHECKPOINTS_DIR = 'checkpoints';
const PAPERCLIP_API = process.env.PAPERCLIP_API || 'http://127.0.0.1:3100';
const WORKSPACE = process.env.WORKSPACE || 'C:\\Users\\dinga\\Projects\\shop-diary-v3';
const OLLAMA_API = process.env.OLLAMA_API || 'http://127.0.0.1:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5-coder:14b';
const LLM_MODEL_BURST = process.env.LLM_MODEL_BURST || 'qwen3-coder:30b';

// Remote rescue via z.ai (GLM-5)
const Z_AI_API_KEY = process.env.Z_AI_API_KEY || '';
const Z_AI_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const REMOTE_RESCUE_MODEL = process.env.REMOTE_RESCUE_MODEL || 'glm-5';
const REMOTE_RESCUE_THRESHOLD = 3; // same-fingerprint repeat count before rescue fires

interface ProjectConfig {
  paperclip?: {
    apiUrl?: string;
    companyId?: string;
    agents?: Record<string, string>;
    agentKeys?: Record<string, string>;
  };
  closedloop?: {
    bridgeUrl?: string;
    agents?: Record<string, string>;
  };
}

let cachedProjectConfig: ProjectConfig | null = null;

type SessionMode = 'implementation' | 'repair' | 'escalated';

interface SessionState {
  issueId: string;
  role: string;
  attemptCount: number;
  maxPasses: number;
  mode: SessionMode;
  lastErrorFingerprint: string | null;
  repeatedErrorCount: number;
  lastChangedFiles: string[];
  lastCheckpointDir: string | null;
  lastGreenCheckpointDir: string | null;
  lastBuildSucceeded: boolean;
  updatedAt: string;
}

interface SessionCompletionResult {
  escalated: boolean;
  reason: 'max-passes' | 'runtime-error' | 'validation-failed' | 'completed';
  finalErrorText?: string;
}

interface ValidationSummary {
  passed: boolean;
  reasons: string[];
  touchedFiles: string[];
  addedLines: number;
  deletedLines: number;
  deletionRatio: number;
  suspiciousFiles: string[];
  changedFileCount: number;
}

function getSessionDir(issueId: string, role: string): string {
  return join(SESSIONS_DIR, issueId, role);
}

function getStatePath(sessionDir: string): string {
  return join(sessionDir, SESSION_STATE_FILE);
}

function getCheckpointsRoot(sessionDir: string): string {
  return join(sessionDir, CHECKPOINTS_DIR);
}

function loadProjectConfig(): ProjectConfig {
  if (cachedProjectConfig) {
    return cachedProjectConfig;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    cachedProjectConfig = JSON.parse(raw) as ProjectConfig;
  } catch {
    cachedProjectConfig = {};
  }

  return cachedProjectConfig;
}

function getPaperclipApiUrl(): string {
  return loadProjectConfig().paperclip?.apiUrl || PAPERCLIP_API;
}

function getProjectAgents(): Record<string, string> {
  const config = loadProjectConfig();
  return config.paperclip?.agents || config.closedloop?.agents || {};
}

function getAgentKeys(): Record<string, string> {
  return loadProjectConfig().paperclip?.agentKeys || {};
}

function getRoleAgentId(role: string): string | null {
  const agents = getProjectAgents();

  if (role === 'builder') {
    return agents.localBuilder || agents['local builder'] || null;
  }

  if (role === 'reviewer') {
    return agents.reviewer || null;
  }

  if (role === 'diff-guardian') {
    return agents.diffGuardian || agents['diff guardian'] || null;
  }

  return null;
}

function createInitialState(issueId: string, role: string): SessionState {
  return {
    issueId,
    role,
    attemptCount: 0,
    maxPasses: 20,
    mode: 'implementation',
    lastErrorFingerprint: null,
    repeatedErrorCount: 0,
    lastChangedFiles: [],
    lastCheckpointDir: null,
    lastGreenCheckpointDir: null,
    lastBuildSucceeded: false,
    updatedAt: new Date().toISOString(),
  };
}

function loadSessionState(sessionDir: string, issueId: string, role: string): SessionState {
  const statePath = getStatePath(sessionDir);

  if (!existsSync(statePath)) {
    return createInitialState(issueId, role);
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SessionState>;
    return {
      ...createInitialState(issueId, role),
      ...parsed,
      issueId,
      role,
    };
  } catch {
    return createInitialState(issueId, role);
  }
}

function saveSessionState(sessionDir: string, state: SessionState): void {
  writeFileSync(getStatePath(sessionDir), JSON.stringify(state, null, 2), 'utf8');
}

function touchSessionState(sessionDir: string, state: SessionState): void {
  state.updatedAt = new Date().toISOString();
  saveSessionState(sessionDir, state);
}

function fingerprintBuildOutput(buildResult: { stdout?: string; stderr?: string } | null): string {
  const raw = `${buildResult?.stdout || ''}\n${buildResult?.stderr || ''}`;
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      (line.includes('Module not found') ||
       line.includes('Cannot find module') ||
       line.includes('Exported identifiers must be unique') ||
       line.includes('Failed to compile') ||
       line.includes('error TS') ||
       line.includes('Build failed'))
    );

  if (lines.length > 0) {
    return lines.slice(0, 3).join(' | ');
  }

  return raw.substring(0, 200).replace(/\s+/g, ' ');
}

function createAttemptCheckpoint(
  sessionDir: string,
  workspace: string,
  attempt: number,
  files: Array<{ path: string; content: string }>
): string | null {
  if (files.length === 0) return null;

  const checkpointDir = join(getCheckpointsRoot(sessionDir), `attempt-${attempt}`);
  mkdirSync(checkpointDir, { recursive: true });

  for (const file of files) {
    const sourcePath = join(workspace, file.path);
    const targetPath = join(checkpointDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });

    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, targetPath);
    } else {
      writeFileSync(targetPath + '.missing', '', 'utf8');
    }
  }

  return checkpointDir;
}

function restoreCheckpoint(checkpointDir: string, workspace: string, logPath: string): void {
  if (!existsSync(checkpointDir)) return;

  const entries = readdirSync(checkpointDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(checkpointDir, entry.name);
    const targetPath = join(workspace, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      restoreCheckpoint(sourcePath, targetPath, logPath);
      continue;
    }

    if (entry.name.endsWith('.missing')) {
      const missingTarget = targetPath.slice(0, -8);
      if (existsSync(missingTarget)) {
        unlinkSync(missingTarget);
        appendFileSync(logPath, '[RESTORE] removed ' + missingTarget + '\n');
      }
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    appendFileSync(logPath, '[RESTORE] copied ' + targetPath + '\n');
  }
}

async function callRemoteRescue(
  issueId: string,
  errorContext: string,
  state: SessionState,
  logPath: string,
  roleAgentId: string | null
): Promise<string | null> {
  if (!Z_AI_API_KEY) {
    appendFileSync(logPath, '[RESCUE] Z_AI_API_KEY not set — skipping remote rescue\n');
    return null;
  }

  appendFileSync(logPath, '[RESCUE] Calling Remote Rescue (GLM-5) after ' + state.repeatedErrorCount + ' repeated errors\n');
  await postComment(
    issueId,
    '_Remote Rescue (GLM-5) engaged after ' + state.repeatedErrorCount + ' repeated build failures. Analyzing..._',
    roleAgentId
  );

  const touchedFiles = state.lastChangedFiles.join('\n');
  const systemPrompt =
    'You are a senior engineer rescuing a TypeScript monorepo build ' +
    '(Next.js + React Native + Cloudflare Workers + Kysely). ' +
    'Produce exact, minimal code fixes using FILE: blocks. ' +
    'Do not rewrite unrelated files. Fix only what the build error requires.';
  const userPrompt =
    'Workspace: shop-diary-v3\n\nTouched files:\n' + touchedFiles +
    '\n\nRepeated build error:\n' + errorContext.substring(0, 800) +
    '\n\nFix the error. Use FILE: format:\n' +
    'FILE: relative/path/to/file.ext\n```lang\n// code\n```';

  try {
    const res = await fetch(`${Z_AI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Z_AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: REMOTE_RESCUE_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(300000),
    } as any);

    if (!res.ok) {
      throw new Error('z.ai API error ' + res.status);
    }

    const data = await res.json() as any;
    const rescueContent = data.choices?.[0]?.message?.content || '';
    await postComment(issueId, sanitizeForWin1252(rescueContent), roleAgentId);
    return rescueContent;
  } catch (err: any) {
    appendFileSync(logPath, '[RESCUE] Failed: ' + err.message + '\n');
    await postComment(
      issueId,
      '_Remote Rescue call failed: ' + err.message + '. Continuing with local repair._',
      roleAgentId
    );
    return null;
  }
}

export async function spawnSession(config: any): Promise<void> {
  console.log('[spawnSession] START for ' + config.issueId + ' (' + (config.role || 'builder') + ')');

  try {
    const role = config.role || 'builder';
    const sessionDir = getSessionDir(config.issueId, role);
    const sessionState = loadSessionState(sessionDir, config.issueId, role);

    mkdirSync(sessionDir, { recursive: true });

    const agentsPath = join(sessionDir, 'AGENTS.md');
    const template = getAgentsTemplate(config.workspace || WORKSPACE, role);
    writeFileSync(agentsPath, template);

    const logPath = join(sessionDir, 'session.log');
    writeFileSync(logPath, 'Session started: ' + new Date().toISOString() + '\n');
    writeFileSync(logPath, 'Role: ' + role + '\n');
    writeFileSync(logPath, 'Issue: ' + config.title + '\n\n', { flag: 'a' });
    appendFileSync(logPath, '\n[TASK]\n' + config.title + '\n\n' + config.description + '\n\n');
    saveSessionState(sessionDir, sessionState);

    console.log('[spawnSession] Creating ' + role + ' session for ' + config.issueId + ' in ' + sessionDir);

    await spawnPiMono(config, sessionDir, logPath, role, sessionState);
  } catch (err: any) {
    console.error('[spawnSession] Error:', err.message);
    throw err;
  }
}

async function spawnPiMono(config: any, sessionDir: string, logPath: string, role: string, state: SessionState): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('[llm] Starting LLM session for ' + config.issueId + ' (' + role + ')');
    appendFileSync(logPath, '\n[LLM STARTING]\n');
    appendFileSync(logPath, '[STATE] mode=' + state.mode + ' attempt=' + state.attemptCount + '/' + state.maxPasses + '\n');

    const taskPrompt = buildTaskPrompt(config, role);
    appendFileSync(logPath, '[TASK PROMPT]\n' + taskPrompt + '\n\n');

    runLlmIteration(config.issueId, taskPrompt, role, config.workspace || WORKSPACE, sessionDir, logPath, state, (finalError, completion) => {
      if (finalError && completion.reason === 'max-passes') {
        const errorText = completion.finalErrorText || (finalError as Error).message || 'Unknown error';
        state.mode = 'escalated';
        touchSessionState(sessionDir, state);
        appendFileSync(logPath, '\n[LOOP EXCEEDED] Max passes (' + state.maxPasses + ') reached. Escalating to human.\n');
        onLoopExceeded(config.issueId, role, state.attemptCount, errorText).then(resolve).catch(reject);
        return;
      }

      if (finalError && completion.reason === 'validation-failed') {
        const errorText = completion.finalErrorText || (finalError as Error).message || 'Validation failed';
        appendFileSync(logPath, '\n[VALIDATION REJECTED] ' + errorText + '\n');
        resolve();
        return;
      }

      if (finalError) {
        const errorText = completion.finalErrorText || (finalError as Error).message || 'Unknown error';
        appendFileSync(logPath, '\n[RUNTIME ERROR] ' + errorText + '\n');
        reject(finalError);
        return;
      }

      onComplete(config.issueId, role, state.attemptCount).then(resolve).catch(reject);
    });
  });
}

function runLlmIteration(
  issueId: string,
  prompt: string,
  role: string,
  workspace: string,
  sessionDir: string,
  logPath: string,
  state: SessionState,
  callback: (error: any, result: SessionCompletionResult) => void
): void {
  state.attemptCount++;
  touchSessionState(sessionDir, state);
  appendFileSync(logPath, '\n[PASS ' + state.attemptCount + '/' + state.maxPasses + ']\n');
  appendFileSync(logPath, '[STATE] mode=' + state.mode + ' repeated=' + state.repeatedErrorCount + '\n');

  callOllama(prompt, role, workspace, logPath, (error, result) => {
    if (error) {
      callback(error, {
        escalated: false,
        reason: 'runtime-error',
        finalErrorText: (error as Error).message,
      });
      return;
    }

    console.log('[llm] Completed:', result.summary);
    appendFileSync(logPath, '[LLM COMPLETED]\n' + result.summary + '\n');

    if (role === 'builder') {
      handleBuilderWork(result, workspace, sessionDir, state, logPath, (buildError, buildResult) => {
        if (buildError && state.attemptCount < state.maxPasses) {
          const errorContext = buildResult.stderr || buildResult.stdout || 'Unknown build error';
          const fingerprint = fingerprintBuildOutput(buildResult);
          const sameFingerprint = state.lastErrorFingerprint === fingerprint;
          state.lastErrorFingerprint = fingerprint;
          state.repeatedErrorCount = sameFingerprint ? state.repeatedErrorCount + 1 : 1;
          state.mode = state.repeatedErrorCount >= 2 ? 'repair' : 'implementation';
          state.lastBuildSucceeded = false;
          touchSessionState(sessionDir, state);

          appendFileSync(logPath, '\n[BUILD FAILED - RETRYING]\n');
          appendFileSync(logPath, '[BUILD FINGERPRINT] ' + fingerprint + '\n');
          appendFileSync(logPath, '[REPAIR MODE] ' + state.mode + '\n');

          // Remote rescue: fire before continuing local retry when same error repeats too many times
          if (sameFingerprint && state.repeatedErrorCount >= REMOTE_RESCUE_THRESHOLD) {
            appendFileSync(logPath, '[RESCUE] Same error repeated ' + state.repeatedErrorCount + ' times — calling Remote Rescue\n');
            const roleAgentId = getRoleAgentId(role);
            callRemoteRescue(issueId, errorContext, state, logPath, roleAgentId).then(rescueContent => {
              state.repeatedErrorCount = 0;
              state.lastErrorFingerprint = null;
              touchSessionState(sessionDir, state);
              const nextPrompt = rescueContent
                ? 'Apply the following rescue fixes and then run yarn build:\n\n' + rescueContent + '\n\nOriginal task:\n' + prompt
                : buildFixPrompt(errorContext, prompt, workspace, state, fingerprint);
              runLlmIteration(issueId, nextPrompt, role, workspace, sessionDir, logPath, state, callback);
            }).catch(() => {
              // Rescue call itself failed — fall through to normal retry
              runLlmIteration(issueId, buildFixPrompt(errorContext, prompt, workspace, state, fingerprint), role, workspace, sessionDir, logPath, state, callback);
            });
            return;
          }

          const fixPrompt = buildFixPrompt(errorContext, prompt, workspace, state, fingerprint);
          appendFileSync(logPath, 'Error context sent to LLM for fix...\n\n');

          runLlmIteration(issueId, fixPrompt, role, workspace, sessionDir, logPath, state, callback);
        } else if (buildError) {
          appendFileSync(logPath, '\n[BUILD FAILED - MAX PASSES REACHED]\n');
          state.mode = 'escalated';
          touchSessionState(sessionDir, state);
          callback(buildError, {
            escalated: true,
            reason: 'max-passes',
            finalErrorText: buildResult?.stderr || buildResult?.stdout || (buildError as Error).message,
          });
        } else {
          appendFileSync(logPath, '\n[BUILD SUCCESS]\n');
          state.mode = 'implementation';
          state.lastBuildSucceeded = true;
          state.lastErrorFingerprint = null;
          state.repeatedErrorCount = 0;
          touchSessionState(sessionDir, state);
          callback(null, {
            escalated: false,
            reason: 'completed',
          });
        }
      });
    } else if (role === 'reviewer' || role === 'diff-guardian') {
      handleValidationWork(role, workspace, sessionDir, logPath, state, callback);
    }
  });
}

function handleValidationWork(
  role: string,
  workspace: string,
  sessionDir: string,
  logPath: string,
  state: SessionState,
  callback: (error: any, result: SessionCompletionResult) => void
): void {
  const label = role === 'reviewer' ? 'REVIEWER' : 'DIFF GUARDIAN';
  const roleAgentId = getRoleAgentId(role);
  appendFileSync(logPath, '\n[' + label + ' VALIDATION]\n');
  appendFileSync(logPath, '1. Running workspace build...\n');
  appendFileSync(logPath, '2. Checking validation gate...\n');
    const builderState = loadSessionState(getSessionDir(state.issueId, 'builder'), state.issueId, 'builder');
    const validation = analyzeValidationSummary(role, workspace, builderState);
    appendFileSync(logPath, '[DIFF SUMMARY] files=' + validation.changedFileCount + ' added=' + validation.addedLines + ' deleted=' + validation.deletedLines + ' ratio=' + validation.deletionRatio.toFixed(2) + '\n');

  runBuild(workspace, logPath, async (buildError, buildResult) => {
    if (buildError) {
      const errorText = buildResult?.stderr || buildResult?.stdout || (buildError as Error).message;
      appendFileSync(logPath, '[' + label + ' FAILED]\n');
      await postComment(
        state.issueId,
        label + ' found a build failure. Sending issue back to Local Builder.\n\n' +
          '```\n' + errorText.substring(0, 1200) + '\n```',
        roleAgentId
      );
      await reassignIssue(state.issueId, 'builder');
      callback(buildError, {
        escalated: false,
        reason: 'validation-failed',
        finalErrorText: errorText,
      });
      return;
    }

    if (!validation.passed) {
      const reasonText = validation.reasons.join(' | ');
      appendFileSync(logPath, '[' + label + ' REJECTED]\n');
      appendFileSync(logPath, reasonText + '\n');
      await postComment(
        state.issueId,
        label + ' found diff-risk signals and sent the issue back to Local Builder.\n\n' +
          'Reasons:\n- ' + validation.reasons.join('\n- ') + '\n',
        roleAgentId
      );
      await reassignIssue(state.issueId, 'builder');
      callback(new Error(reasonText), {
        escalated: false,
        reason: 'validation-failed',
        finalErrorText: reasonText,
      });
      return;
    }

    appendFileSync(logPath, '[' + label + ' PASSED]\n');
    callback(null, {
      escalated: false,
      reason: 'completed',
    });
  });
}

function buildFixPrompt(
  errorContext: string,
  originalPrompt: string,
  workspace: string,
  state: SessionState,
  fingerprint: string
): string {
  const firstError = errorContext.split('\n').find((line: string) =>
    line.includes('Module not found') || line.includes('error') || line.includes('Failed')
  ) || errorContext.substring(0, 500);

  const touchedFiles = state.lastChangedFiles.length > 0 ? state.lastChangedFiles.join('\n') : '(unknown)';

  return `BUILD ERROR - ${state.mode.toUpperCase()} MODE

Attempt: ${state.attemptCount}
Repeated same error: ${state.repeatedErrorCount}
Fingerprint: ${fingerprint}
Workspace: ${workspace}

You are in targeted repair mode.
Fix only the files related to the failing build.
Do not create new files unless the build error requires it.
Prefer editing the smallest possible set of existing files.

Known touched files:
${touchedFiles}

Original task:
${originalPrompt}

Error:
${firstError.substring(0, 300)}

CRITICAL RULES - MUST FOLLOW:
1. Fix only the files connected to the reported build failure.
2. Prefer the smallest possible edit set.
3. Do not create unrelated new files.
4. Preserve existing project patterns and naming.
5. Stay in repair mode if the same fingerprint repeats.

EXAMPLE - Write components like this:

\`\`\`typescript
// packages/ui/src/components/Button.tsx
import React from 'react';
export const Button = ({ children, onClick, variant = 'primary' }: any) => (
  <button
    onClick={onClick}
    style={{
      padding: '8px 16px',
      borderRadius: '4px',
      border: 'none',
      cursor: 'pointer',
      backgroundColor: variant === 'primary' ? '#007bff' : '#6c757d',
      color: 'white',
    }}
  >
    {children}
  </button>
);
\`\`\`

Write the missing component files now. Use ONLY inline styles. NO CSS imports:`;
}

function analyzeValidationSummary(role: string, workspace: string, state: SessionState): ValidationSummary {
  const touchedFiles = Array.from(new Set(state.lastChangedFiles.filter(Boolean)));
  const reasons: string[] = [];
  let addedLines = 0;
  let deletedLines = 0;

  if (touchedFiles.length === 0) {
    reasons.push('No touched files were recorded for the latest builder attempt.');
    return {
      passed: false,
      reasons,
      touchedFiles,
      addedLines,
      deletedLines,
      deletionRatio: 0,
      suspiciousFiles: [],
      changedFileCount: 0,
    };
  }

  const diffStats = readGitDiffStats(workspace, touchedFiles);
  addedLines = diffStats.addedLines;
  deletedLines = diffStats.deletedLines;

  const totalLines = addedLines + deletedLines;
  const deletionRatio = totalLines > 0 ? deletedLines / totalLines : 0;
  const suspiciousFiles = role === 'diff-guardian' ? detectParallelFileSignals(touchedFiles) : [];

  if (touchedFiles.length > 12) {
    reasons.push('Too many files changed in one pass (' + touchedFiles.length + ').');
  }

  if (role === 'reviewer' && deletionRatio > 0.7) {
    reasons.push('Deletion ratio is too high for reviewer validation (' + deletionRatio.toFixed(2) + ').');
  }

  if (role === 'diff-guardian') {
    if (deletionRatio > 0.7) {
      reasons.push('Deletion ratio is too high for diff guardian validation (' + deletionRatio.toFixed(2) + ').');
    }

    if (suspiciousFiles.length > 0) {
      reasons.push('Parallel-file signals detected: ' + suspiciousFiles.join(', '));
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    touchedFiles,
    addedLines,
    deletedLines,
    deletionRatio,
    suspiciousFiles,
    changedFileCount: touchedFiles.length,
  };
}

function readGitDiffStats(workspace: string, files: string[]): { addedLines: number; deletedLines: number } {
  try {
    const pathList = files.map((file) => quotePath(file)).join(' ');
    const output = execSync(`git diff --numstat -- ${pathList}`, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let addedLines = 0;
    let deletedLines = 0;

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;

      const added = parts[0] === '-' ? 0 : Number(parts[0]);
      const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
      if (!Number.isNaN(added)) addedLines += added;
      if (!Number.isNaN(deleted)) deletedLines += deleted;
    }

    return { addedLines, deletedLines };
  } catch {
    return { addedLines: 0, deletedLines: 0 };
  }
}

function detectParallelFileSignals(files: string[]): string[] {
  const suspicious: string[] = [];
  const byDir = new Map<string, string[]>();

  for (const file of files) {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const bucket = byDir.get(dir) || [];
    bucket.push(file);
    byDir.set(dir, bucket);
  }

  for (const [, groupedFiles] of byDir.entries()) {
    for (let i = 0; i < groupedFiles.length; i++) {
      for (let j = i + 1; j < groupedFiles.length; j++) {
        const left = normalizeParallelName(groupedFiles[i]);
        const right = normalizeParallelName(groupedFiles[j]);

        if (!left || !right) continue;

        if (left === right || left.includes(right) || right.includes(left)) {
          suspicious.push(groupedFiles[i] + ' <-> ' + groupedFiles[j]);
        }
      }
    }
  }

  return Array.from(new Set(suspicious));
}

function normalizeParallelName(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  return fileName
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|json|md|css)$/, '')
    .replace(/(\.store|\.schema|\.types|\.type|\.screen|\.component|\.service|\.hook|\.hooks|\.route|\.routes)$/g, '')
    .replace(/^(use|get|set|create|update|delete|fetch)/, '');
}

function quotePath(pathName: string): string {
  return `"${pathName.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function handleBuilderWork(
  result: any,
  workspace: string,
  sessionDir: string,
  state: SessionState,
  logPath: string,
  callback: (error: any, result: any) => void
): void {
  appendFileSync(logPath, '\n[BUILDER WORK]\n');

  const checkpointToRestore =
    state.mode === 'repair'
      ? state.lastGreenCheckpointDir || state.lastCheckpointDir
      : null;

  if (checkpointToRestore) {
    appendFileSync(logPath, '[RESTORE] ' + checkpointToRestore + '\n');
    restoreCheckpoint(checkpointToRestore, workspace, logPath);
  }

  const files = parseFileMarkers(result.output);
  appendFileSync(logPath, 'Found ' + files.length + ' file(s) to create\n');
  state.lastChangedFiles = files.map((file: { path: string; content: string }) => file.path);
  touchSessionState(sessionDir, state);

  const checkpointDir = createAttemptCheckpoint(sessionDir, workspace, state.attemptCount, files);
  if (checkpointDir) {
    state.lastCheckpointDir = checkpointDir;
    appendFileSync(logPath, '[CHECKPOINT] ' + checkpointDir + '\n');
    touchSessionState(sessionDir, state);
  }

  const writeResults: Array<{ path: string; success: boolean; error?: string }> = [];

  for (const file of files) {
    const fullPath = join(workspace, file.path);
    appendFileSync(logPath, 'Writing: ' + fullPath + '\n');

    try {
      const dir = fullPath.substring(0, fullPath.lastIndexOf('\\'));
      if (!require('fs').existsSync(dir)) {
        require('fs').mkdirSync(dir, { recursive: true });
      }

      require('fs').writeFileSync(fullPath, file.content, 'utf8');
      writeResults.push({ path: file.path, success: true });
      appendFileSync(logPath, 'Created: ' + file.path + '\n');
    } catch (e: any) {
      writeResults.push({ path: file.path, success: false, error: e.message });
      appendFileSync(logPath, 'Failed: ' + file.path + ' - ' + e.message + '\n');
    }
  }

  appendFileSync(logPath, '\nRunning yarn build...\n');
  runBuild(workspace, logPath, (buildError, buildResult) => {
    if (buildError) {
      state.lastBuildSucceeded = false;
      touchSessionState(sessionDir, state);
      callback(buildError, buildResult);
      return;
    }

    appendFileSync(logPath, '\n[BUILD SUCCESS]\n');
    state.lastBuildSucceeded = true;
    state.lastGreenCheckpointDir = checkpointDir || state.lastCheckpointDir;
    state.mode = 'implementation';
    state.repeatedErrorCount = 0;
    state.lastErrorFingerprint = null;
    touchSessionState(sessionDir, state);
    callback(null, buildResult);
  });
}

function parseFileMarkers(output: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  const fileRegex = /FILE:\s*([^\n]+)\n```[\w]*\n([\s\S]*?)```/g;
  let match;

  while ((match = fileRegex.exec(output)) !== null) {
    const path = match[1].trim();
    const content = match[2].trim();
    files.push({ path, content });
  }

  const markdownRegex = /```[\w]*\n\s*\/\/\s*([^\n]+\.tsx?)\n([\s\S]*?)```/g;

  while ((match = markdownRegex.exec(output)) !== null) {
    const path = match[1].trim();
    const content = match[2].trim();
    if (!files.some((f) => f.path === path)) {
      files.push({ path, content });
    }
  }

  const headerRegex = /```[\w]*\n\s*(?:File|Filename|Path):\s*([^\n]+)\n([\s\S]*?)```/gi;

  while ((match = headerRegex.exec(output)) !== null) {
    const path = match[1].trim();
    const content = match[2].trim();
    if (!files.some((f) => f.path === path)) {
      files.push({ path, content });
    }
  }

  return files;
}

function runBuild(workspace: string, logPath: string, callback: (error: any, result: any) => void): void {
  const build = spawn('yarn', ['build'], {
    cwd: workspace,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let hasExited = false;

  build.stdout.on('data', (data: Buffer) => {
    const output = data.toString();
    stdout += output;
    console.log('[build] ' + output);
    appendFileSync(logPath, '[BUILD STDOUT] ' + output + '\n');
  });

  build.stderr.on('data', (data: Buffer) => {
    const output = data.toString();
    stderr += output;
    console.error('[build] ' + output);
    appendFileSync(logPath, '[BUILD STDERR] ' + output + '\n');
  });

  build.on('exit', (code: number) => {
    if (hasExited) return;
    hasExited = true;

    setTimeout(() => {
      const result = {
        success: code === 0,
        stdout,
        stderr,
        exitCode: code,
      };

      appendFileSync(logPath, '[BUILD EXIT] Code: ' + code + '\n');
      appendFileSync(logPath, '[BUILD OUTPUT] ' + (stdout.length + stderr.length) + ' bytes captured\n');

      if (code !== 0) {
        console.log('[build] Build failed, stderr length:', stderr.length);
        callback(new Error('Build failed with exit code ' + code), result);
      } else {
        callback(null, result);
      }
    }, 500);
  });

  build.on('error', (err: Error) => {
    console.error('[build] process error:', err.message);
    appendFileSync(logPath, '[BUILD ERROR] ' + err.message + '\n');
    callback(err, null);
  });
}

function callOllama(prompt: string, role: string, workspace: string, logPath: string, callback: (error: any, result: any) => void, modelOverride?: string): void {
  const model = modelOverride || LLM_MODEL;
  const data = JSON.stringify({
    model: model,
    prompt: prompt,
    stream: false,
  });

  const options = {
    hostname: '127.0.0.1',
    port: 11434,
    path: '/api/generate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
    },
    timeout: 600000,
  };

  const req = http.request(options, (res: http.IncomingMessage) => {
    let responseBody = '';
    res.on('data', (chunk: Buffer) => responseBody += chunk);
    res.on('end', () => {
      try {
        const response = JSON.parse(responseBody);
        const llmOutput = response.response || '';

        appendFileSync(logPath, '[LLM RESPONSE]\n' + llmOutput.substring(0, 2000) + '...\n');

        const result = {
          summary: 'LLM generated response for ' + role,
          output: llmOutput,
          files: [],
        };

        callback(null, result);
      } catch (e: any) {
        callback(e, null);
      }
    });
  });

  req.on('error', (e) => {
    console.error('[ollama] Request error:', e.message);
    appendFileSync(logPath, '[OLLAMA ERROR] ' + e.message + '\n');
    callback(e, null);
  });

  req.on('timeout', () => {
    console.error('[ollama] Request timeout');
    appendFileSync(logPath, '[OLLAMA TIMEOUT] Request took too long (>2 min)\n');
    req.destroy();
    callback(new Error('Ollama request timeout'), null);
  });

  req.write(data);
  req.end();
}

function buildTaskPrompt(config: any, role: string): string {
  if (role === 'reviewer') {
    return `Task: Review code changes for ${config.title}

Description:
${config.description}

Instructions:
1. Review the code changes for this issue
2. Check the following:
   - Build passes (run: yarn build)
   - Import paths are correct (@shop-diary/ui, not @ui/)
   - No parallel files created
   - No destructive changes
   - TypeScript types are correct
   - Follows existing patterns

3. If everything looks good, output: REVIEW_APPROVED
4. If there are issues, list them and output: REVIEW_REJECTED

Start your review.`;
  }

  if (role === 'diff-guardian') {
    return `Task: Diff Guard validation for ${config.title}

Description:
${config.description}

Instructions:
1. Run mechanical checks:
   - Check for parallel files (new files alongside existing)
   - Check deletion ratio (< 70%)
   - Verify exports preserved
   - Run build: yarn build

2. If all checks pass, output: DIFF_APPROVED
3. If checks fail, output: DIFF_REJECTED with reasons

Start validation.`;
  }

  const existingFiles = getExistingFilesList(config.workspace || WORKSPACE);

  return `Task: ${config.title}

Description:
${config.description}

EXISTING FILES IN WORKSPACE:
${existingFiles}

CRITICAL RULES - MUST FOLLOW:
1. ONLY import 'react' - NO other npm packages
2. NO CSS imports (no './File.css' imports)
3. Use inline styles ONLY: style={{ padding: '16px', margin: '8px' }}
4. NO className libraries (no clsx, classnames, tailwind-merge)
5. Simple React components with inline styles only

Write code in markdown blocks with file path as the FIRST comment line:
   \`\`\`typescript
   // packages/app/src/YourFile.tsx
   import React from 'react';
   ...
   \`\`\`

After writing files, the build will run automatically.`;
}

function getExistingFilesList(workspace: string): string {
  const collectFiles = (root: string, limit: number): string[] => {
    const results: string[] = [];

    const walk = (dir: string) => {
      if (results.length >= limit || !existsSync(dir)) return;

      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= limit) break;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }

        if (!entry.isFile()) continue;
        if (!/\.(ts|tsx|js|jsx|md|json)$/.test(entry.name)) continue;

        results.push(fullPath);
      }
    };

    try {
      walk(root);
    } catch {
      return [];
    }

    return results;
  };

  const toRelative = (filePath: string) => filePath.replace(workspace + '\\', '').replace(workspace + '/', '');

  const appFiles = collectFiles(join(workspace, 'packages', 'app'), 40);
  const uiFiles = collectFiles(join(workspace, 'packages', 'ui'), 40);

  let list = 'packages/app/:\n';
  appFiles.forEach((file) => {
    list += '  - ' + toRelative(file) + '\n';
  });

  list += '\npackages/ui/:\n';
  uiFiles.forEach((file) => {
    list += '  - ' + toRelative(file) + '\n';
  });

  return list.trim();
}

function extractBuildError(output: string): string {
  const lines = output.split('\n');

  for (const line of lines) {
    if (line.includes('Module not found')) return line.trim();
    if (line.includes('error TS')) return line.trim();
    if (line.includes('Failed to compile')) return line.trim();
  }

  return output.substring(0, 200);
}

async function onComplete(issueId: string, role: string, passCount: number): Promise<void> {
  console.log('[complete] ' + issueId + ' completed in ' + passCount + ' passes');
  const roleAgentId = getRoleAgentId(role);

  if (role === 'builder') {
    await postComment(issueId, 'Local Builder completed implementation. Build passes. Ready for Reviewer.', roleAgentId);
    await reassignIssue(issueId, 'reviewer');
    console.log('[complete] ' + issueId + ' -> Reviewer');
  } else if (role === 'reviewer') {
    await postComment(issueId, 'Reviewer approved. Ready for Diff Guardian.', roleAgentId);
    await reassignIssue(issueId, 'diff-guardian');
    console.log('[complete] ' + issueId + ' -> Diff Guardian');
  } else if (role === 'diff-guardian') {
    await postComment(issueId, 'Diff Guardian approved. Ready for PR creation.', roleAgentId);
    await reassignIssue(issueId, 'human');
    console.log('[complete] ' + issueId + ' -> manual review / PR creation');
  }
}

async function onLoopExceeded(issueId: string, role: string, passCount: number, error: string): Promise<void> {
  console.log('[loop] ' + issueId + ' exceeded 20 passes');
  const roleAgentId = getRoleAgentId(role);

  // Attempt Remote Rescue before escalating to human
  if (Z_AI_API_KEY) {
    console.log('[loop] Attempting Remote Rescue (GLM-5) before human escalation');
    const sessionDir = getSessionDir(issueId, role);
    const state = loadSessionState(sessionDir, issueId, role);
    const logPath = join(sessionDir, 'session.log');
    const rescueContent = await callRemoteRescue(issueId, error, state, logPath, roleAgentId);
    if (rescueContent) {
      state.attemptCount = 0;
      state.mode = 'implementation';
      state.repeatedErrorCount = 0;
      state.lastErrorFingerprint = null;
      saveSessionState(sessionDir, state);
      await reassignIssue(issueId, 'builder');
      console.log('[loop] Remote Rescue provided fixes — restarting builder');
      return;
    }
    console.log('[loop] Remote Rescue unavailable or failed — escalating to human');
  }

  const message =
    '**Build Loop Exceeded (20 passes)**\n\n' +
    'Local Builder has attempted to fix build errors 20 times without success.\n\n' +
    '**Last error**:\n```\n' + error + '\n```\n\n' +
    '**This indicates**:\n' +
    '- Complex dependency issues needing human review\n' +
    '- Missing context about project patterns\n' +
    '- Potential architectural mismatch\n\n' +
    '**Next steps**:\n' +
    '1. Human developer should review the code\n' +
    '2. Check import patterns in existing files\n' +
    '3. Verify package.json dependencies\n' +
    '4. Manually fix and merge\n';

  await postComment(issueId, message, roleAgentId);
  await reassignIssue(issueId, 'human');
  console.log('[loop] ' + issueId + ' -> human review');
}

async function onStuck(issueId: string, role: string, error: string, passCount: number): Promise<void> {
  console.log('[stuck] ' + issueId + ' stuck after ' + passCount + ' passes');

  const message =
    '**Local Builder Stuck**\n\n' +
    'Same build error repeated multiple times:\n\n' +
    '```\n' + error + '\n```\n\n' +
    '**Suggested actions**:\n' +
    '1. Check existing files for correct import patterns\n' +
    '2. Verify package.json has required dependencies\n' +
    '3. Consider alternative implementation approach\n\n' +
    'Human review may be needed.\n';

  await postComment(issueId, message);
}

async function postComment(issueId: string, body: string, agentId: string | null = null, retries = 3): Promise<void> {
  console.log('[paperclip] Comment for ' + issueId + ': ' + body.substring(0, 100));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const agentKeys = getAgentKeys();
  if (agentId && agentKeys[agentId]) {
    headers.Authorization = `Bearer ${agentKeys[agentId]}`;
  }

  const payload = JSON.stringify({ body: sanitizeForWin1252(body) });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}/comments`, {
        method: 'POST',
        headers,
        body: payload,
      });

      if (res.ok) {
        console.log('[paperclip] Posted comment to issue ' + issueId.slice(0, 8));
        return;
      }

      const text = await res.text();
      console.error('[paperclip] Failed to post comment: ' + res.status + ' ' + text);
      return;
    } catch (err) {
      console.error('[paperclip] Error posting comment (attempt ' + attempt + '/' + retries + '):', (err as Error).message);
      if (attempt < retries) {
        await sleep(2000 * attempt);
      }
    }
  }
}

async function reassignIssue(issueId: string, newRole: string): Promise<void> {
  if (newRole === 'human') {
    const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'in_review',
        assigneeAgentId: undefined,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[paperclip] Failed to move issue to manual review: ' + res.status + ' ' + text);
    } else {
      console.log('[paperclip] Moved issue ' + issueId.slice(0, 8) + ' to manual review');
    }
    return;
  }

  const agents = getProjectAgents();
  let agentId: string | undefined;

  if (newRole === 'reviewer') {
    agentId = agents.reviewer;
  } else if (newRole === 'diff-guardian') {
    agentId = agents.diffGuardian || agents['diff guardian'];
  } else if (newRole === 'builder') {
    agentId = agents.localBuilder || agents['local builder'];
  }

  if (!agentId) {
    console.error('[paperclip] No configured agent for role ' + newRole + ' - skipping reassignment');
    return;
  }

  const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assigneeAgentId: agentId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[paperclip] Failed to reassign issue: ' + res.status + ' ' + text);
  } else {
    console.log('[paperclip] Reassigned issue ' + issueId.slice(0, 8) + ' to ' + newRole);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getAgentsTemplate(workspace: string, role: string): string {
  if (role === 'reviewer') {
    return getReviewerTemplate(workspace);
  } else if (role === 'diff-guardian') {
    return getDiffGuardianTemplate(workspace);
  } else {
    return getBuilderTemplate(workspace);
  }
}

function getBuilderTemplate(workspace: string): string {
  return `# Local Builder Instructions

## CRITICAL: Import Paths
- Use the real workspace aliases: @shop-diary/ui and @shop-diary/app
- Use React Native components (View, Text, Pressable, ScrollView) for UI
- Do not invent import paths like packages/... or @dashboard/...
- Check existing files in ${workspace}\\packages\\app and ${workspace}\\packages\\ui for examples

## Build Verification
- After writing files, ALWAYS run: yarn build
- If build fails, read the error and fix IMMEDIATELY
- Common errors:
  - "Module not found packages/..." - Replace with the real @shop-diary aliases
  - "Module not found '@dashboard/...'" - Replace with '@shop-diary/app/...'
  - "Module not found 'ky'" - Use 'fetch' instead (ky not installed)
  - "TS2307: Cannot find module" - Check import path

## Loop Detection
- If you've tried 5+ times and build still fails:
  1. Stop and analyze the pattern
  2. Check existing files for correct patterns
  3. Read the build error carefully and fix the specific issue

## Output Format
- Write files using FILE: path/to/file.ext format
- Run build after all files written
- Report "BUILD_SUCCESS" when build passes
- Report specific errors when stuck
`;
}

function getReviewerTemplate(workspace: string): string {
  return `# Reviewer Instructions

## Review Checklist
Before approving, verify ALL of the following:

### 1. Build Status
- [ ] Build passes (yarn build succeeds)
- [ ] No TypeScript errors
- [ ] No missing dependencies

### 2. Code Quality
- [ ] Import paths correct (@shop-diary/ui, not @ui/)
- [ ] TypeScript types correct
- [ ] Follows existing patterns
- [ ] React Native components (View, Text, Pressable), not HTML

### 3. Destructive Change Detection
- [ ] No parallel files (new files duplicating existing functionality)
- [ ] No removed exports without migration
- [ ] No excessive deletions (>70% of file)
- [ ] Existing stores preserved (useUserStore, useShopStore, etc.)

### 4. File Structure
- [ ] Screens in packages/app/{feature}/screen.tsx
- [ ] Hooks in packages/app/apiHooks/
- [ ] Stores in packages/app/store/

## Output Format
- To APPROVE: Output "REVIEW_APPROVED" (triggers Diff Guardian)
- To REJECT: List specific issues, output "REVIEW_REJECTED" (sends back to Builder)

## Common Rejection Reasons
- Build fails
- Wrong import paths (@ui/ instead of @shop-diary/ui)
- Parallel store files (e.g., auth.store.ts when useUserStore.ts exists)
- Removed exports without migration
`;
}

function getDiffGuardianTemplate(workspace: string): string {
  return `# Diff Guardian Instructions

## Mechanical Checks (Automated)

### 1. Parallel File Detection
- [ ] No new files alongside existing files with similar names
- [ ] No duplicate stores (check workspace packages/app/store/)
- [ ] No duplicate types (check workspace packages/app/types/)

### 2. Deletion Analysis
- [ ] Deletion ratio < 70%
- [ ] No critical files deleted

### 3. Export Preservation
- [ ] Existing exports preserved
- [ ] Store methods intact (signInUser, signOutUser, etc.)
- [ ] Type definitions intact

### 4. Build Verification
- [ ] Build passes on branch
- [ ] No new warnings introduced

## LLM Validation
After mechanical checks pass, validate:
- [ ] Changes make semantic sense
- [ ] No subtle breaking changes
- [ ] Follows project conventions

## Output Format
- To APPROVE: Output "DIFF_APPROVED" (triggers PR creation)
- To REJECT: Output "DIFF_REJECTED" with specific reasons (sends back to Builder)

## Auto-Fix Patterns
For simple issues, attempt fix before rejecting:
- Remove duplicate files - modify existing instead
- Restore removed exports - add back with deprecation notice
`;
}
