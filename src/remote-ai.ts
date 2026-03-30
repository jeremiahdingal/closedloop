/**
 * Remote AI integration — GLM-5 via z.ai (Zhipu AI BigModel)
 *
 * Used for:
 * - Remote App Architect: generates architecture specs for complex/greenfield issues
 * - Remote Rescue: breaks builder out of repeated error loops
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  getWorkspace,
  getRemoteConfig,
  getRunnerBackend,
  getRunnerTimeoutMs,
} from './config';
import { postComment } from './paperclip-api';
import { remoteArchitectCalled } from './agent-types';
import { slugify } from './utils';
import { Issue } from './types';

const Z_AI_API_KEY = process.env.Z_AI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_AUTH_TOKEN || process.env.OPENAI_API_KEY || '';
const TICKETS_DIR = '.tickets';

// ─── Core z.ai caller ──────────────────────────────────────────────

export async function callZAI(prompt: string, systemPrompt: string): Promise<string> {
  const remote = getRemoteConfig();
  const apiBase = remote?.appArchitect?.apiBase || process.env.Z_AI_API_BASE || 'https://api.z.ai/api/coding/paas/v4';
  const model = remote?.appArchitect?.model || 'glm-5';

  if (!Z_AI_API_KEY) {
    throw new Error('Z_AI_API_KEY not set');
  }

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Z_AI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(300000),
  } as any);

  if (!res.ok) {
    throw new Error(`z.ai ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// ─── OpenAI Codex adapter ──────────────────────────────────────────

export async function callOpenAI(prompt: string, systemPrompt: string): Promise<string> {
  const model = process.env.OPENAI_MODEL || 'codex-mini-latest';
  const apiBase = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';

  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_AUTH_TOKEN or OPENAI_API_KEY not set');
  }

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(300000),
  } as any);

  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// ─── Codex CLI adapter ──────────────────────────────────────────────
// Uses `codex exec` to run prompts through the locally-installed Codex CLI.
// This is the default mechanism for Paperclip remote calls.

export async function callCodexCLI(prompt: string, systemPrompt: string): Promise<string> {
  const model = process.env.OPENAI_MODEL || 'gpt-5.3-codex';
  const combinedPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
  const tmpDir = path.join(getWorkspace(), '.paperclip-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const timestamp = Date.now();
  const outputFile = path.join(tmpDir, `codex-out-${timestamp}.txt`);

  try {
    execSync(
      `codex exec -m ${model} --ephemeral -o "${outputFile}" -`,
      {
        cwd: getWorkspace(),
        input: combinedPrompt,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 600000, // 10 min
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    if (fs.existsSync(outputFile)) {
      const result = fs.readFileSync(outputFile, 'utf8').trim();
      fs.unlinkSync(outputFile);
      return result;
    }

    throw new Error('Codex CLI produced no output file');
  } catch (err: any) {
    // Clean up temp file on failure
    try { fs.unlinkSync(outputFile); } catch {}

    // If execSync threw with stdout/stderr, include them
    const stderr = err.stderr?.toString()?.trim() || '';
    const stdout = err.stdout?.toString()?.trim() || '';
    throw new Error(`Codex CLI failed: ${err.message}${stderr ? `\nstderr: ${stderr}` : ''}${stdout ? `\nstdout: ${stdout}` : ''}`);
  }
}

// ─── OpenCode CLI adapter ─────────────────────────────────────────
// Uses `opencode run` to invoke Ollama models via the OpenCode CLI.
// This replaces direct Ollama HTTP calls so logs integrate with Paperclip.
// Serialized via queue: Ollama can only serve one model at a time on
// consumer hardware, so concurrent calls deadlock.

import { spawn } from 'child_process';

interface QueuedModelJob {
  run: () => Promise<string>;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

const modelQueue: QueuedModelJob[] = [];
let ollamaRunning = false;

function resolveOpenCodeExecutable(): string {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN;
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const userProfile = process.env.USERPROFILE || '';
    const candidates = [
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(userProfile, 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.exe'),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return 'opencode';
}

async function drainOllamaQueue(): Promise<void> {
  if (ollamaRunning) return;
  ollamaRunning = true;
  while (modelQueue.length > 0) {
    const job = modelQueue.shift()!;
    try {
      const result = await job.run();
      job.resolve(result);
    } catch (err: any) {
      job.reject(err);
    }
  }
  ollamaRunning = false;
}

function runOpenCodeCli(
  prompt: string,
  systemPrompt: string,
  model: string = 'qwen3:8b',
  timeoutMs: number = getRunnerTimeoutMs()
): Promise<string> {
  const combinedPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  // Normalize model: strip ollama/ prefix if caller already included it
  const ollamaModel = model.replace(/^ollama\//, '');

  const run = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const opencodeBin = resolveOpenCodeExecutable();
      console.log(`[runner:opencode] cmd="${opencodeBin} run -m ollama/${ollamaModel} --format json" cwd="${getWorkspace()}"`);
      const child = spawn(
        opencodeBin,
        ['run', '-m', `ollama/${ollamaModel}`, '--format', 'json'],
        {
          cwd: getWorkspace(),
          shell: process.platform === 'win32',
        }
      );

      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (err?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve(value || '');
        }
      };

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {}
        done(new Error(`OpenCode CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        done(
          new Error(
            `OpenCode CLI failed (ollama/${ollamaModel}): ${err.message}${stderr ? `\nstderr: ${stderr}` : ''}${stdout ? `\nstdout: ${stdout}` : ''}`
          )
        );
      });

      child.on('close', (code) => {
        if (code !== 0) {
          done(
            new Error(
              `OpenCode CLI failed (ollama/${ollamaModel}): exit ${code}${stderr ? `\nstderr: ${stderr}` : ''}${stdout ? `\nstdout: ${stdout}` : ''}`
            )
          );
          return;
        }

        const lines = stdout.toString().split('\n').filter(Boolean);
        const textParts: string[] = [];
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'text' && event.part?.text) {
              textParts.push(event.part.text);
            }
          } catch {}
        }

        const result = textParts.join('');
        if (!result.trim()) {
          console.log(`[runner:opencode] No text output from ollama/${ollamaModel}; returning fallback`);
          done(undefined, '_No text output from model._');
          return;
        }
        console.log(`[runner:opencode] Completed ollama/${ollamaModel} (${result.length} chars)`);
        done(undefined, result);
      });

      // Feed prompt via stdin
      if (child.stdin) {
        child.stdin.write(combinedPrompt);
        child.stdin.end();
      }
    });

  return new Promise<string>((resolve, reject) => {
    modelQueue.push({ run, resolve, reject });
    console.log(`[runner:opencode] Queued ollama/${ollamaModel} (queue depth: ${modelQueue.length})`);
    drainOllamaQueue();
  });
}

function runOllamaCli(
  prompt: string,
  systemPrompt: string,
  model: string = 'qwen3:8b',
  timeoutMs: number = getRunnerTimeoutMs()
): Promise<string> {
  const combinedPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  const ollamaModel = model.replace(/^ollama\//, '');

  const run = (): Promise<string> =>
    new Promise((resolve, reject) => {
      console.log(`[runner:ollama] cmd="ollama run ${ollamaModel}" cwd="${getWorkspace()}"`);
      const child = spawn(
        'ollama',
        ['run', ollamaModel],
        {
          cwd: getWorkspace(),
          shell: process.platform === 'win32',
        }
      );

      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (err?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve(value || '');
        }
      };

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {}
        done(new Error(`Ollama CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        done(
          new Error(
            `Ollama CLI failed (${ollamaModel}): ${err.message}${stderr ? `\nstderr: ${stderr}` : ''}${stdout ? `\nstdout: ${stdout}` : ''}`
          )
        );
      });

      child.on('close', (code) => {
        if (code !== 0) {
          done(
            new Error(
              `Ollama CLI failed (${ollamaModel}): exit ${code}${stderr ? `\nstderr: ${stderr}` : ''}${stdout ? `\nstdout: ${stdout}` : ''}`
            )
          );
          return;
        }

        const text = stdout.trim();
        if (!text) {
          console.log(`[runner:ollama] No text output from ${ollamaModel}; returning fallback`);
          done(undefined, '_No text output from model._');
          return;
        }
        console.log(`[runner:ollama] Completed ${ollamaModel} (${text.length} chars)`);
        done(undefined, text);
      });

      if (child.stdin) {
        child.stdin.write(combinedPrompt);
        child.stdin.end();
      }
    });

  return new Promise<string>((resolve, reject) => {
    modelQueue.push({ run, resolve, reject });
    console.log(`[runner:ollama] Queued ${ollamaModel} (queue depth: ${modelQueue.length})`);
    drainOllamaQueue();
  });
}

export async function callModelCLI(
  prompt: string,
  systemPrompt: string,
  model: string = 'qwen3:8b',
  timeoutMs: number = getRunnerTimeoutMs()
): Promise<string> {
  const backend = getRunnerBackend();

  if (backend === 'opencode_cli') {
    return runOpenCodeCli(prompt, systemPrompt, model, timeoutMs);
  }

  if (backend === 'hybrid') {
    try {
      return await runOllamaCli(prompt, systemPrompt, model, timeoutMs);
    } catch (err: any) {
      console.log(`[runner:hybrid] Ollama failed, falling back to OpenCode: ${err.message}`);
      return runOpenCodeCli(prompt, systemPrompt, model, timeoutMs);
    }
  }

  return runOllamaCli(prompt, systemPrompt, model, timeoutMs);
}

// Backward-compatible wrapper for existing call sites.
export function callOpenCodeCLI(
  prompt: string,
  systemPrompt: string,
  model: string = 'qwen3:8b',
  timeoutMs: number = getRunnerTimeoutMs()
): Promise<string> {
  return callModelCLI(prompt, systemPrompt, model, timeoutMs);
}

// ─── Unified dispatcher ────────────────────────────────────────────
// Set REMOTE_LLM_PROVIDER in .env:
//   codex   -> Codex CLI (default, recommended)
//   openai  -> OpenAI HTTP API
//   zai     -> z.ai/GLM-5

export async function callRemoteLLM(prompt: string, systemPrompt: string): Promise<string> {
  const provider = process.env.REMOTE_LLM_PROVIDER || 'codex';
  if (provider === 'openai') {
    return callOpenAI(prompt, systemPrompt);
  }
  if (provider === 'zai') {
    return callZAI(prompt, systemPrompt);
  }
  return callCodexCLI(prompt, systemPrompt);
}

// ─── Remote App Architect ──────────────────────────────────────────

export async function callRemoteArchitect(
  issueId: string,
  issue: Issue
): Promise<string | null> {
  // Guard: only call once per issue
  if (remoteArchitectCalled[issueId]) {
    console.log(`[remote] Architect already called for ${issueId.slice(0, 8)}`);
    return remoteArchitectCalled[issueId].specRelPath;
  }

  if (!Z_AI_API_KEY) {
    console.log('[remote] Z_AI_API_KEY not set — skipping Remote Architect');
    return null;
  }

  console.log(`[remote] Calling Remote Architect (GLM-5) for ${issueId.slice(0, 8)}`);
  await postComment(issueId, null, '_Remote Architect (GLM-5) generating architecture spec..._');

  const systemPrompt =
    'You are a senior software architect. Given a project request, produce a detailed architecture spec ' +
    'with data models, API contracts, UI wireframes, and implementation tickets. ' +
    'Use ## Ticket: <title> format for each decomposed work unit. ' +
    'Each ticket should have: **Objective:**, **Files:**, **Acceptance Criteria:**, **Dependencies:**.';

  const userPrompt =
    `Project: ${issue.title}\n\n` +
    `Description:\n${issue.description || 'No description provided.'}\n\n` +
    'Produce an architecture spec with implementation tickets using the ## Ticket: format.';

  try {
    const spec = await callZAI(userPrompt, systemPrompt);

    // Write arch spec to .tickets/
    const workspace = getWorkspace();
    const ticketsDir = path.join(workspace, TICKETS_DIR);
    fs.mkdirSync(ticketsDir, { recursive: true });

    const identifier = issue.identifier || issueId.slice(0, 8);
    const specFile = `arch-spec-${slugify(identifier)}.md`;
    const specPath = path.join(ticketsDir, specFile);
    fs.writeFileSync(specPath, spec, 'utf8');

    remoteArchitectCalled[issueId] = { calledAt: Date.now(), specRelPath: `${TICKETS_DIR}/${specFile}` };

    // Post as comment (truncated if too long)
    const truncated = spec.length > 8000 ? spec.slice(0, 8000) + '\n\n... (truncated, full spec in .tickets/)' : spec;
    await postComment(issueId, null, `**Architecture Spec (GLM-5):**\n\n${truncated}`);

    console.log(`[remote] Architect spec written to ${specPath}`);
    return `${TICKETS_DIR}/${specFile}`;
  } catch (err: any) {
    console.error(`[remote] Architect failed:`, err.message);
    await postComment(issueId, null, `_Remote Architect failed: ${err.message}. Falling back to local planning._`);
    return null;
  }
}

// ─── Remote Rescue ─────────────────────────────────────────────────

export async function callRemoteRescue(
  issueId: string,
  errorContext: string,
  touchedFiles: string[],
  roleAgentId: string | null
): Promise<string | null> {
  if (!Z_AI_API_KEY) {
    console.log('[rescue] Z_AI_API_KEY not set — skipping Remote Rescue');
    return null;
  }

  const remote = getRemoteConfig();
  const apiBase = remote?.rescue?.model
    ? (remote?.appArchitect?.apiBase || 'https://open.bigmodel.cn/api/paas/v4')
    : 'https://open.bigmodel.cn/api/paas/v4';
  const model = remote?.rescue?.model || 'glm-5';

  console.log(`[rescue] Calling Remote Rescue (${model}) for ${issueId.slice(0, 8)}`);
  await postComment(issueId, roleAgentId, `_Remote Rescue (${model}) engaged for repeated build failures..._`);

  const systemPrompt =
    'You are a senior engineer rescuing a TypeScript monorepo build ' +
    '(Next.js + React Native + Cloudflare Workers). ' +
    'Produce exact, minimal code fixes using FILE: blocks.';

  const userPrompt =
    'Workspace: shop-diary-v3\nTouched files:\n' + touchedFiles.join('\n') +
    '\n\nRepeated build error:\n' + errorContext.substring(0, 800) +
    '\n\nFix using FILE: format:\nFILE: relative/path/to/file.ext\n```lang\n// code\n```';

  try {
    const res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Z_AI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(300000),
    } as any);

    if (!res.ok) throw new Error(`z.ai ${res.status}`);

    const data = await res.json() as any;
    const rescueContent = data.choices?.[0]?.message?.content || '';
    await postComment(issueId, roleAgentId, rescueContent);
    return rescueContent;
  } catch (err: any) {
    console.error(`[rescue] Failed:`, err.message);
    await postComment(issueId, roleAgentId, `_Remote Rescue failed: ${err.message}. Continuing locally._`);
    return null;
  }
}
