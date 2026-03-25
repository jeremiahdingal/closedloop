/**
 * Remote AI integration — GLM-5 via z.ai (Zhipu AI BigModel)
 *
 * Used for:
 * - Remote App Architect: generates architecture specs for complex/greenfield issues
 * - Remote Rescue: breaks builder out of repeated error loops
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getRemoteConfig } from './config';
import { postComment } from './paperclip-api';
import { remoteArchitectCalled } from './agent-types';
import { slugify } from './utils';
import { Issue } from './types';

const Z_AI_API_KEY = process.env.Z_AI_API_KEY || '';
const TICKETS_DIR = '.tickets';

// ─── Core z.ai caller ──────────────────────────────────────────────

export async function callZAI(prompt: string, systemPrompt: string): Promise<string> {
  const remote = getRemoteConfig();
  const apiBase = remote?.appArchitect?.apiBase || 'https://open.bigmodel.cn/api/paas/v4';
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
