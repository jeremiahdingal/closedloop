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
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:3201';

// Remote rescue via z.ai (GLM-5)
const Z_AI_API_KEY = process.env.Z_AI_API_KEY || '';
const Z_AI_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const REMOTE_RESCUE_MODEL = process.env.REMOTE_RESCUE_MODEL || 'glm-5';
const REMOTE_RESCUE_THRESHOLD = 3; // same-fingerprint repeat count before rescue fires

// Burst model: one-shot override for first build pass (greenfield scaffold)
const issueBurstModel = new Map<string, string>();

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

interface TriedApproach {
  pass: number;
  files: string[];
  error: string;
  fingerprint: string;
}

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
  triedApproaches: TriedApproach[];
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
    triedApproaches: [],
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

/**
 * Revert workspace to the last green (build-passing) checkpoint.
 * Called when Reviewer or Diff Guardian rejects — ensures the next builder
 * attempt starts from the last known-good state rather than broken code.
 */
function revertToGreenCheckpoint(issueId: string, workspace: string, logPath: string): void {
  try {
    const builderSessionDir = getSessionDir(issueId, 'builder');
    const builderState = loadSessionState(builderSessionDir, issueId, 'builder');
    const greenCheckpoint = builderState.lastGreenCheckpointDir;

    if (!greenCheckpoint || !existsSync(greenCheckpoint)) {
      appendFileSync(logPath, '[REVERT] No green checkpoint available — builder will start from current state\n');
      return;
    }

    appendFileSync(logPath, '[REVERT] Restoring workspace to green checkpoint: ' + greenCheckpoint + '\n');
    restoreCheckpoint(greenCheckpoint, workspace, logPath);
    appendFileSync(logPath, '[REVERT] Workspace reverted to last green state\n');
  } catch (err: any) {
    appendFileSync(logPath, '[REVERT] Failed to revert: ' + err.message + '\n');
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

    await spawnPiMono(config, sessionDir, logPath, role, sessionState, config.modelOverride);
  } catch (err: any) {
    console.error('[spawnSession] Error:', err.message);
    throw err;
  }
}

async function spawnPiMono(config: any, sessionDir: string, logPath: string, role: string, state: SessionState, modelOverride?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('[llm] Starting LLM session for ' + config.issueId + ' (' + role + ')');
    appendFileSync(logPath, '\n[LLM STARTING]\n');
    appendFileSync(logPath, '[STATE] mode=' + state.mode + ' attempt=' + state.attemptCount + '/' + state.maxPasses + '\n');

    // SCAFFOLD MODE: If files were already written by scaffold engine, skip local build gating
    const isScaffoldMode = (config.description || '').includes('Scaffold has already written all files');
    if (isScaffoldMode && role === 'builder') {
      appendFileSync(logPath, '\n[SCAFFOLD MODE] Skipping LLM and handing off without local build validation\n');
      const workspace = config.workspace || WORKSPACE;
      appendFileSync(logPath, '[SCAFFOLD] Epic Reviewer will validate builds later\n');
      state.lastBuildSucceeded = false;
      state.mode = 'implementation';
      touchSessionState(sessionDir, state);
      onComplete(config.issueId, role, 0).then(resolve).catch(reject);
      return;
    }

    const taskPrompt = buildTaskPrompt(config, role);
    appendFileSync(logPath, '[TASK PROMPT]\n' + taskPrompt + '\n\n');

    if (modelOverride) {
      issueBurstModel.set(config.issueId, modelOverride);
      appendFileSync(logPath, '[BURST MODEL] ' + modelOverride + '\n');
    }

    runLlmIteration(config.issueId, taskPrompt, role, config.workspace || WORKSPACE, sessionDir, logPath, state, completionHandler);

    function completionHandler(finalError: any, completion: SessionCompletionResult) {
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
    }
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

  // Check for burst model override (one-shot, first pass only)
  const burstOverride = issueBurstModel.get(issueId);
  if (burstOverride) {
    issueBurstModel.delete(issueId);
    appendFileSync(logPath, '[BURST] Using ' + burstOverride + ' for this pass\n');
  }

  const ollamaCallback = (error: any, result: any) => {
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

          // Record this failed approach for the tried-approaches list
          state.triedApproaches.push({
            pass: state.attemptCount,
            files: [...state.lastChangedFiles],
            error: (errorContext || '').substring(0, 300),
            fingerprint,
          });

          appendFileSync(logPath, '\n[BUILD FAILED - RETRYING]\n');
          appendFileSync(logPath, '[BUILD FINGERPRINT] ' + fingerprint + '\n');
          appendFileSync(logPath, '[REPAIR MODE] ' + state.mode + '\n');
          appendFileSync(logPath, '[TRIED APPROACHES] ' + state.triedApproaches.length + ' total\n');

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
          state.triedApproaches = []; // clear on success
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
  };

  callOllama(prompt, role, workspace, logPath, ollamaCallback, burstOverride);
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
  appendFileSync(logPath, '1. Checking validation gate without local build execution...\n');
  const builderState = loadSessionState(getSessionDir(state.issueId, 'builder'), state.issueId, 'builder');
  const validation = analyzeValidationSummary(role, workspace, builderState);
  appendFileSync(logPath, '[DIFF SUMMARY] files=' + validation.changedFileCount + ' added=' + validation.addedLines + ' deleted=' + validation.deletedLines + ' ratio=' + validation.deletionRatio.toFixed(2) + '\n');

  if (!validation.passed) {
    const reasonText = validation.reasons.join(' | ');
    appendFileSync(logPath, '[' + label + ' REJECTED]\n');
    appendFileSync(logPath, reasonText + '\n');

    saveReflection(workspace, validation.touchedFiles, reasonText);
    postComment(
      state.issueId,
      label + ' found diff-risk signals and sent the issue back to Local Builder.\n\n' +
        'Reasons:\n- ' + validation.reasons.join('\n- ') + '\n',
      roleAgentId
    ).then(() => {
      revertToGreenCheckpoint(state.issueId, workspace, logPath);
      reassignIssue(state.issueId, 'builder').then(() => {
        callback(new Error(reasonText), {
          escalated: false,
          reason: 'validation-failed',
          finalErrorText: reasonText,
        });
      }).catch((err: any) => {
        callback(err, {
          escalated: false,
          reason: 'validation-failed',
          finalErrorText: reasonText,
        });
      });
    }).catch((err: any) => {
      callback(err, {
        escalated: false,
        reason: 'validation-failed',
        finalErrorText: reasonText,
      });
    });
    return;
  }

  appendFileSync(logPath, '[' + label + ' PASSED]\n');
  callback(null, {
    escalated: false,
    reason: 'completed',
  });
}

/**
 * Read a workspace file safely, return content or null.
 */
function readFileFromDisk(workspace: string, relativePath: string, maxLen = 2500): string | null {
  try {
    const fullPath = join(workspace, relativePath);
    if (!existsSync(fullPath)) return null;
    const content = readFileSync(fullPath, 'utf8');
    if (!content.trim()) return null;
    return content.length > maxLen ? content.substring(0, maxLen) + '\n// ... truncated' : content;
  } catch {
    return null;
  }
}

// ── Reflection Memory ──
// Stores per-component review feedback in .reflections/ so future builds learn from past rejections.
const REFLECTIONS_DIR = '.reflections';

function getReflectionsDir(workspace: string): string {
  return join(workspace, REFLECTIONS_DIR);
}

function readReflections(workspace: string, files: string[]): string {
  const reflDir = getReflectionsDir(workspace);
  if (!existsSync(reflDir)) return '';

  const sections: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    // Normalize: api/src/services/orders/orders.routes.ts → orders.routes
    const key = (file.split(/[\\/]/).pop() || file).replace(/\.(ts|tsx|js|jsx)$/, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const reflPath = join(reflDir, key + '.md');
    if (existsSync(reflPath)) {
      try {
        const content = readFileSync(reflPath, 'utf8').trim();
        if (content) {
          sections.push(`[${key}] ${content}`);
        }
      } catch { /* skip */ }
    }
  }

  if (sections.length === 0) return '';
  return '\n== PAST REVIEW FEEDBACK (learn from these) ==\n' + sections.join('\n') + '\n';
}

function saveReflection(workspace: string, files: string[], feedback: string): void {
  if (!feedback || files.length === 0) return;

  const reflDir = getReflectionsDir(workspace);
  try {
    mkdirSync(reflDir, { recursive: true });
  } catch { /* already exists */ }

  // Extract the short feedback (first 500 chars, strip markdown)
  const shortFeedback = feedback
    .replace(/```[\s\S]*?```/g, '') // strip code blocks
    .replace(/\*\*/g, '')
    .substring(0, 500)
    .trim();

  if (!shortFeedback) return;

  const timestamp = new Date().toISOString().slice(0, 10);

  for (const file of files) {
    const key = (file.split(/[\\/]/).pop() || file).replace(/\.(ts|tsx|js|jsx)$/, '');
    const reflPath = join(reflDir, key + '.md');

    try {
      // Append rather than overwrite — accumulate feedback
      const existing = existsSync(reflPath) ? readFileSync(reflPath, 'utf8') : '';
      const entry = `\n[${timestamp}] ${shortFeedback}\n`;

      // Cap at 2000 chars total to keep prompts lean
      const combined = (existing + entry).slice(-2000);
      writeFileSync(reflPath, combined, 'utf8');
    } catch { /* skip */ }
  }
}

// Shared files that almost every feature touches — builder must see these to avoid overwrites
const SHARED_MUTATION_TARGETS = [
  'packages/app/types/db.types.ts',
  'packages/app/types/services.enum.ts',
  'api/src/index.ts',
];

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

  const touchedFiles = state.lastChangedFiles.length > 0 ? state.lastChangedFiles : [];

  // Read current disk state of touched files so the builder sees what it actually wrote
  let fileContents = '';
  for (const filePath of touchedFiles) {
    const content = readFileFromDisk(workspace, filePath);
    if (content) {
      fileContents += `\n--- ${filePath} (current on disk) ---\n${content}\n`;
    }
  }

  // Also inject shared mutation targets so builder doesn't overwrite them
  for (const sharedFile of SHARED_MUTATION_TARGETS) {
    // Skip if already in touched files
    if (touchedFiles.some(f => f.replace(/\\/g, '/') === sharedFile)) continue;
    const content = readFileFromDisk(workspace, sharedFile);
    if (content) {
      fileContents += `\n--- ${sharedFile} (shared — EXTEND, do not overwrite) ---\n${content}\n`;
    }
  }

  // Build tried-approaches context so the builder avoids repeating past failures
  let triedContext = '';
  if (state.triedApproaches.length > 0) {
    const recent = state.triedApproaches.slice(-5); // last 5 approaches
    triedContext = '\n== PREVIOUSLY TRIED (FAILED) ==\n' +
      recent.map((a, i) =>
        `Attempt ${a.pass}: files=[${a.files.join(', ')}] error="${a.error.substring(0, 120)}"`
      ).join('\n') +
      '\nDo NOT repeat these exact approaches. Try a DIFFERENT strategy.\n';
  }

  return `BUILD ERROR - ${state.mode.toUpperCase()} MODE

Attempt: ${state.attemptCount}
Repeated same error: ${state.repeatedErrorCount}
Fingerprint: ${fingerprint}
Workspace: ${workspace}
${triedContext}
You are in targeted repair mode.
Fix only the files related to the failing build.
Do not create new files unless the build error requires it.
Prefer editing the smallest possible set of existing files.

Known touched files:
${touchedFiles.join('\n') || '(unknown)'}
${fileContents ? '\n== CURRENT FILE CONTENTS ON DISK ==' + fileContents : ''}
${readReflections(workspace, touchedFiles)}
Original task:
${originalPrompt}

Error:
${firstError.substring(0, 300)}

CRITICAL RULES - MUST FOLLOW:
1. Fix only the files connected to the reported build failure.
2. Prefer the smallest possible edit set.
3. Do not create unrelated new files.
4. Preserve existing project patterns and naming.
5. When modifying shared files (db.types.ts, services.enum.ts, index.ts): KEEP all existing content, ADD your new entries.
6. Stay in repair mode if the same fingerprint repeats.

Output each file using: FILE: path/to/file.ext
\`\`\`lang
code
\`\`\`

Write the fixed files now:`;
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
  if (files.length === 0) {
    const noFilesError = 'Builder produced no parseable files. Expected FILE blocks or JSON FILE entries.';
    appendFileSync(logPath, noFilesError + '\n');
    callback(new Error(noFilesError), {
      success: false,
      stdout: '',
      stderr: noFilesError + '\n\nLLM output:\n' + String(result.output || '').substring(0, 4000),
      exitCode: 1,
    });
    return;
  }
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

  appendFileSync(logPath, '\n[LOCAL BUILD DISABLED] Syncing builder branch without build validation\n');
  state.lastBuildSucceeded = false;
  state.lastGreenCheckpointDir = checkpointDir || state.lastGreenCheckpointDir || state.lastCheckpointDir;
  state.mode = 'implementation';
  state.repeatedErrorCount = 0;
  state.lastErrorFingerprint = null;
  touchSessionState(sessionDir, state);
  syncBuilderBranch(state.issueId, workspace, state.lastChangedFiles, logPath).then((gitResult) => {
    if (!gitResult.success) {
      callback(new Error(gitResult.message), {
        success: false,
        stdout: '',
        stderr: gitResult.message,
        exitCode: 1,
      });
      return;
    }

    callback(null, {
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  }).catch((err: any) => {
    callback(err, {
      success: false,
      stdout: '',
      stderr: err.message || 'Unknown git sync failure',
      exitCode: 1,
    });
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

  if (files.length > 0) {
    return files;
  }

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    for (const [rawKey, value] of Object.entries(parsed)) {
      if (!rawKey.startsWith('FILE:')) continue;

      const path = rawKey.slice('FILE:'.length).trim();
      if (!path) continue;

      let content = '';
      if (typeof value === 'string') {
        content = value;
      } else if (value && typeof value === 'object' && 'content' in value && typeof (value as any).content === 'string') {
        content = (value as any).content;
      }

      if (!content.trim()) continue;
      files.push({ path, content: content.trim() });
    }
  } catch {
    // Not JSON - ignore and fall through.
  }

  return files;
}

interface GitSyncResult {
  success: boolean;
  message: string;
}

/**
 * Delegate git operations to the proxy's /git/sync endpoint.
 * The proxy owns all git-ops (branch, commit, push) via git-ops.ts.
 * This avoids duplicating git logic across bridge and proxy.
 */
async function syncBuilderBranch(
  issueId: string,
  workspace: string,
  files: string[],
  logPath: string
): Promise<GitSyncResult> {
  const uniqueFiles = Array.from(new Set(files.filter(Boolean)));
  if (uniqueFiles.length === 0) {
    return { success: false, message: 'No builder files were available for git sync.' };
  }

  // Read file contents to send to the proxy (it writes them on the branch)
  const fileContents: Record<string, string> = {};
  for (const file of uniqueFiles) {
    const fullPath = join(workspace, file);
    try {
      if (existsSync(fullPath)) {
        fileContents[file] = readFileSync(fullPath, 'utf8');
      }
    } catch {
      appendFileSync(logPath, '[GIT] Could not read ' + file + ' for sync\n');
    }
  }

  appendFileSync(logPath, '[GIT] Delegating to proxy /git/sync for ' + uniqueFiles.length + ' files\n');

  try {
    const res = await fetch(`${PROXY_URL}/git/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueId, files: uniqueFiles, fileContents }),
      signal: AbortSignal.timeout(180000),
    } as any);

    const result = await res.json() as any;

    if (!res.ok || !result.success) {
      const msg = result.output || result.error || 'proxy git sync failed';
      appendFileSync(logPath, '[GIT] Proxy sync failed: ' + msg + '\n');
      return { success: false, message: msg };
    }

    appendFileSync(logPath, '[GIT] Proxy sync succeeded\n');
    return { success: true, message: result.output || 'Committed and pushed via proxy' };
  } catch (err: any) {
    appendFileSync(logPath, '[GIT] Proxy sync error: ' + err.message + '\n');
    return { success: false, message: 'proxy git sync error: ' + err.message };
  }
}

function runBuild(workspace: string, logPath: string, callback: (error: any, result: any) => void): void {
  // Configurable build command via env vars.
  // Default: wrangler dry-run (esbuild compile check for Cloudflare Workers).
  // Override with BUILD_CMD + BUILD_ARGS for other project types.
  const buildCmd = process.env.BUILD_CMD || 'npx';
  const buildArgs = process.env.BUILD_ARGS
    ? process.env.BUILD_ARGS.split(' ')
    : ['wrangler', 'deploy', 'src/index.ts', '--dry-run', '--outdir', '.wrangler/tmp-build'];
  // BUILD_CWD overrides the build working directory (e.g. "api" subdir for Workers)
  const buildCwd = process.env.BUILD_CWD
    ? join(workspace, process.env.BUILD_CWD)
    : join(workspace, 'api');
  const build = spawn(buildCmd, buildArgs, {
    cwd: buildCwd,
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
  if (modelOverride) {
    appendFileSync(logPath, '[MODEL OVERRIDE] Using ' + modelOverride + '\n');
  }
  if (isRemoteBuilderModel(model)) {
    callRemoteBuilder(prompt, role, logPath, callback, model);
    return;
  }
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

2. If all checks pass, output: DIFF_APPROVED
3. If checks fail, output: DIFF_REJECTED with reasons

Start validation.`;
  }

  const workspace = config.workspace || WORKSPACE;
  const existingFiles = getExistingFilesList(workspace);
  const keyFiles = getKeyFileContents(workspace);
  const reflections = readReflections(workspace, config.lastChangedFiles || []);

  return `Task: ${config.title}

Description:
${config.description}

EXISTING FILES IN WORKSPACE:
${existingFiles}

KEY EXISTING FILES (you MUST preserve all existing content when modifying these):
${keyFiles}
${reflections}
CRITICAL RULES:
1. When modifying an existing file (like api/src/index.ts), you MUST include ALL existing content plus your additions. DO NOT remove existing imports, routes, or exports.
2. Write files using FILE: format (see builder template above).
3. For API code, use bare module paths: import { X } from 'app/types/...' (NOT relative paths to packages/).
4. For frontend code, use @shop-diary/ui and @shop-diary/app aliases.
5. After writing files, the bridge will hand off to Reviewer without running a local build.`;
}

function getKeyFileContents(workspace: string): string {
  // Read key shared files that builders commonly need to modify (append to, not overwrite)
  const keyPaths = [
    'api/src/index.ts',
    'packages/app/types/db.types.ts',
    'packages/app/types/services.enum.ts',
  ];

  const sections: string[] = [];
  for (const relPath of keyPaths) {
    const fullPath = join(workspace, relPath);
    try {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        sections.push(`--- ${relPath} ---\n${content}\n--- end ---`);
      }
    } catch {
      // skip
    }
  }
  return sections.join('\n\n') || '(none found)';
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
    await postComment(issueId, 'Local Builder completed implementation. Ready for Reviewer.', roleAgentId);
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

function isRemoteBuilderModel(model: string): boolean {
  return /^glm-/i.test(model) || /^gpt-/i.test(model);
}

function callRemoteBuilder(
  prompt: string,
  role: string,
  logPath: string,
  callback: (error: any, result: any) => void,
  model: string
): void {
  if (!Z_AI_API_KEY) {
    callback(new Error('Z_AI_API_KEY not set for remote builder'), null);
    return;
  }

  appendFileSync(logPath, '[REMOTE BUILDER] Using ' + model + '\n');
  const systemPrompt =
    'You are the remote build agent for a TypeScript monorepo. ' +
    'Return concrete implementation work using FILE: blocks when changing files. ' +
    'Preserve existing code unless the task explicitly requires removal.';

  fetch(`${Z_AI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Z_AI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(600000),
  } as any).then(async (res) => {
    if (!res.ok) {
      throw new Error('z.ai API error ' + res.status);
    }

    const response = await res.json() as any;
    const llmOutput = response.choices?.[0]?.message?.content || '';
    appendFileSync(logPath, '[REMOTE BUILDER RESPONSE]\n' + llmOutput.substring(0, 2000) + '...\n');

    callback(null, {
      summary: 'Remote builder generated response for ' + role,
      output: llmOutput,
      files: [],
    });
  }).catch((err: any) => {
    appendFileSync(logPath, '[REMOTE BUILDER ERROR] ' + err.message + '\n');
    callback(err, null);
  });
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

### API files (api/src/services/...)
- Import shared types using BARE MODULE PATH: import { X } from 'app/types/...'
- Example: import { Env } from 'app/types/env.types'
- Example: import { DatabaseTables } from 'app/types/services.enum'
- Example: import { TNewOrder } from 'app/types/db.types'
- NEVER use relative paths to packages/ (e.g. ../../../packages/app/) — this WILL break the build
- Import local files with relative paths: import { db } from '../../infra/db'
- Use 'ulidx' for ULID generation (not 'ulid')
- Use { json, error } from 'itty-router'
- Use { sql } from 'kysely' for SQL expressions in migrations

### Frontend files (packages/app/..., packages/ui/...)
- Use @shop-diary/ui for UI components
- Use @shop-diary/app for shared logic
- Use React Native components (View, Text, Pressable), NOT HTML

### Check existing files for patterns
- Look at ${workspace}/api/src/services/orders/orders.routes.ts for API route pattern
- Look at ${workspace}/api/src/services/orders/orders.service.ts for service pattern
- Look at ${workspace}/packages/app/types/schemas/orders.schema.ts for Zod schema pattern

## Pre-Flight Check (do this BEFORE writing any code)
Before generating FILE: blocks, briefly list:
1. Which existing files you will MODIFY (not create from scratch)
2. Which NEW files you will create
3. Any assumptions you are making about the codebase
If something is ambiguous (e.g. unclear which table/schema to use, unclear naming convention), state the assumption explicitly and pick the most conservative option that matches existing patterns.

## Handoff Check
- Do not run local builds from this bridge session
- Keep imports and file structure aligned with existing project patterns
- Epic Reviewer will handle automated build execution later in the pipeline

## Output Format
- Write files using FILE: path/to/file.ext format followed by a code block
- Example:
  FILE: api/src/services/example/example.routes.ts
  \`\`\`typescript
  import { Env } from 'app/types/env.types';
  // ... code ...
  \`\`\`
- Report completion once the files are written cleanly
`;
}

function getReviewerTemplate(workspace: string): string {
  return `# Reviewer Instructions

## Review Checklist
Before approving, verify ALL of the following:

### 1. Code Quality
- [ ] Import paths correct (@shop-diary/ui, not @ui/)
- [ ] TypeScript types correct
- [ ] Follows existing patterns
- [ ] React Native components (View, Text, Pressable), not HTML

### 2. Destructive Change Detection
- [ ] No parallel files (new files duplicating existing functionality)
- [ ] No removed exports without migration
- [ ] No excessive deletions (>70% of file)
- [ ] Existing stores preserved (useUserStore, useShopStore, etc.)

### 3. File Structure
- [ ] Screens in packages/app/{feature}/screen.tsx
- [ ] Hooks in packages/app/apiHooks/
- [ ] Stores in packages/app/store/

## Output Format
- To APPROVE: Output "REVIEW_APPROVED" (triggers Diff Guardian)
- To REJECT: List specific issues, output "REVIEW_REJECTED" (sends back to Builder)

## Common Rejection Reasons
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

### 4. Sanity Validation
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
