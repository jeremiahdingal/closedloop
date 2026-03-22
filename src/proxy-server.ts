/**
 * ClosedLoop HTTP Server
 * 
 * Local-first, Ollama-powered proxy for Paperclip AI agents.
 * Handles communication between Paperclip agents and local Ollama instances.
 * Uses RAG for grounded, reliable code generation.
 */

import * as http from 'http';
import { getConfig, getOllamaPorts, getPaperclipApiUrl, getCompanyId, getBurstModel, getWorkspace, getAgentModel, loadConfig } from './config';
import { getAgentName, getIssueDetails, patchIssue, postComment, findAssignedIssue } from './paperclip-api';
import { AGENTS, BLOCKED_AGENTS, AGENT_NAMES } from './agent-types';
import { extractIssueId, extractAgentId } from './utils';
import { createPullRequest } from './git-ops';
import { buildIssueContext, buildLocalBuilderContext, setRAGIndexer } from './context-builder';
import { executeBashBlocks } from './bash-executor';
import { detectAndDelegate } from './delegation';
import { runArtistStage } from './artist-recorder';
import { runDiffGuardian } from './diff-guardian';
import { ragIndexer } from './rag-indexer';
import { OllamaRequest } from './types';
import { detectScaffoldConfig, ScaffoldConfig, parseArchitectOutput } from './scaffold-engine';
import { executeScaffold, formatScaffoldComment } from './scaffold-executor';
import { scoreComplexity, callRemoteArchitect } from './complexity-router';
import { execSync } from 'child_process';
import { getBranchName } from './git-ops';

const { proxyPort, ollamaPort } = getOllamaPorts();
const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();

// Track recent agent runs to prevent spam
const recentAgentRuns = new Map<string, number>();
const DELEGATION_COOLDOWN_MS = 5 * 60 * 1000;

// Track Reviewer <-> Local Builder loops to prevent infinite cycles
// Key: issueId, Value: { count: number, lastReset: number }
const issueLoopCounts = new Map<string, { count: number; lastReset: number }>();
const MAX_LOOP_PASSES = 20; // Auto-create PR after 20 passes for human intervention
const LOOP_RESET_WINDOW_MS = 60 * 60 * 1000; // Reset count after 1 hour of no activity

// Track issues that should use burst model (greenfield first pass)
const issueBuilderBurstMode = new Set<string>();

/**
 * Track and detect Reviewer <-> Local Builder loops
 * Returns true if loop exceeds MAX_LOOP_PASSES
 */
function trackLoop(issueId: string, agentId: string): { count: number; exceeded: boolean } {
  const now = Date.now();
  let loopData = issueLoopCounts.get(issueId);

  // Initialize or reset if window expired
  if (!loopData || now - loopData.lastReset > LOOP_RESET_WINDOW_MS) {
    loopData = { count: 0, lastReset: now };
  }

  // Increment on Reviewer -> Local Builder handoff
  if (agentId === AGENTS.reviewer || agentId === AGENTS['local builder']) {
    loopData.count++;
    issueLoopCounts.set(issueId, loopData);
  }

  return {
    count: loopData.count,
    exceeded: loopData.count >= MAX_LOOP_PASSES,
  };
}

/**
 * Reset loop counter for an issue (e.g., after successful PR)
 */
function resetLoopCounter(issueId: string): void {
  issueLoopCounts.delete(issueId);
}

export function createProxy(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    let issueId = extractIssueId(parsedBody);
    const agentId = extractAgentId(parsedBody);
    const agentName = await getAgentName(agentId || '');

    // If no issue in payload, check if this agent has an assigned issue
    if (!issueId && agentId) {
      const assignedIssueId = await findAssignedIssue(agentId);
      if (assignedIssueId) {
        issueId = assignedIssueId;
        console.log(`[closedloop] Auto-resolved issue for ${agentName}: ${issueId.slice(0, 8)}`);
      }
    }

    // Block disabled agents
    if (agentId && BLOCKED_AGENTS.has(agentId)) {
      console.log(`[proxy:${proxyPort}] BLOCKED ${agentName} (disabled agent)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Agent is currently disabled._',
          },
        })
      );
      return;
    }

    // Guard: skip processing if issue is already completed
    if (issueId) {
      const issueState = await getIssueDetails(issueId);
      if (issueState && (issueState.status === 'in_review' || issueState.status === 'done' || issueState.status === 'cancelled')) {
        console.log(`[closedloop] Skipping ${agentName} - issue ${issueId.slice(0, 8)} is ${issueState.status}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: `_Issue is ${issueState.status}, no action needed._` },
          })
        );
        return;
      }
    }

    // Diff Guardian bypasses Ollama and runs mechanical checks
    if (issueId && agentId === AGENTS['diff guardian']) {
      console.log(`[proxy:${proxyPort}] Diff Guardian -> mechanical check | issue=${issueId.slice(0, 8)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Diff Guardian mechanical check started._',
          },
        })
      );

      setImmediate(async () => {
        try {
          const diffResult = await runDiffGuardian(issueId);
          if (diffResult.approved) {
            await createPullRequest(issueId);
            console.log(`[closedloop] PR created after DiffGuardian approval`);
            resetLoopCounter(issueId);
            // Move to Visual Reviewer and mark in_review to stop the loop
            await patchIssue(issueId, {
              assigneeAgentId: AGENTS['visual reviewer'],
              status: 'in_review',
            });
          } else {
            console.log(`[closedloop] DiffGuardian rejected — sending back to Local Builder`);
            await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
          }
        } catch (err: any) {
          console.error(`[closedloop] DiffGuardian error:`, err.message);
          // Fallback: create PR anyway if diff guardian crashes
          await createPullRequest(issueId);
          await patchIssue(issueId, { status: 'in_review' });
        }
      });
      return;
    }

    // Visual Reviewer bypasses Ollama and runs deterministic recorder
    if (issueId && agentId === AGENTS['visual reviewer']) {
      console.log(`[proxy:${proxyPort}] Visual Reviewer -> feature recorder | issue=${issueId.slice(0, 8)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '_Visual Reviewer feature recorder started._',
          },
        })
      );

      setImmediate(async () => {
        await runArtistStage(issueId);
      });
      return;
    }

    // ─── SCAFFOLD ARCHITECT HANDLER ───
    // Scaffold Architect runs on LLM, outputs SCAFFOLD_CONFIG JSON or NOT_SCAFFOLDABLE.
    // We intercept its response, parse the config, and execute the scaffold engine.
    if (issueId && agentId === AGENTS['scaffold architect']) {
      console.log(`[proxy:${proxyPort}] Scaffold Architect -> ollama | issue=${issueId.slice(0, 8)}`);

      // Build context and call Ollama
      const saIssue = await getIssueDetails(issueId);
      const saPromptPath = require('path').join(__dirname, '..', 'prompts', 'scaffold-architect.txt');
      let saSystemPrompt = '';
      try {
        saSystemPrompt = require('fs').readFileSync(saPromptPath, 'utf8');
      } catch {
        saSystemPrompt = 'You are the Scaffold Architect. Extract a SCAFFOLD_CONFIG JSON from the issue description, or respond NOT_SCAFFOLDABLE.';
      }

      const saModel = getAgentModel('scaffold architect') || 'qwen3:4b';
      const saPayload = {
        model: saModel,
        stream: false,
        messages: [
          { role: 'system', content: saSystemPrompt },
          { role: 'user', content: `Issue: ${saIssue?.title || ''}\n\n${saIssue?.description || ''}` },
        ],
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: '_Scaffold Architect processing..._' } }));

      setImmediate(async () => {
        try {
          const timeoutConfig = loadConfig().ollama.timeouts;
          const timeoutSec = timeoutConfig['scaffold architect'] || 120;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

          const ollamaRes = await fetch(`http://127.0.0.1:${ollamaPort}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saPayload),
            signal: controller.signal,
          });
          const ollamaData = await ollamaRes.json() as any;
          clearTimeout(timeoutId);

          const content = ollamaData.message?.content || ollamaData.response || '';
          console.log(`[scaffold-architect] LLM response (${content.length} chars)`);

          // Post the architect's output as a comment
          await postComment(issueId, null, `**Scaffold Architect:**\n\n${content.trim()}`);

          // Parse SCAFFOLD_CONFIG from response
          const configMatch = content.match(/SCAFFOLD_CONFIG:\s*```(?:json)?\s*([\s\S]*?)```/);
          const notScaffoldable = content.match(/NOT_SCAFFOLDABLE:\s*(.+)/);

          if (configMatch) {
            try {
              const parsed = JSON.parse(configMatch[1].trim());
              const scaffoldConfig = parseArchitectOutput(parsed);

              console.log(`[scaffold-architect] Extracted config: ${scaffoldConfig.entityPascal} (${scaffoldConfig.fields.length} fields)`);
              await postComment(issueId, null,
                `_Scaffold Architect extracted config: **${scaffoldConfig.entityPascal}** with ${scaffoldConfig.fields.length} fields. Running scaffold engine..._`
              );

              // Execute scaffold engine (deterministic)
              const workspace = getWorkspace();
              const scaffoldResult = executeScaffold(scaffoldConfig, workspace);
              const comment = formatScaffoldComment(scaffoldConfig, scaffoldResult);
              await postComment(issueId, null, comment);

              if (scaffoldResult.success) {
                const allFiles = [...scaffoldResult.filesWritten, ...scaffoldResult.filesPatched];
                const newFilesWritten = scaffoldResult.filesWritten.filter(f => !f.includes('skipped'));
                const allSkipped = newFilesWritten.length === 0;

                if (allSkipped) {
                  console.log(`[scaffold-architect] All files exist. Sending to Reviewer.`);
                  await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer, status: 'in_progress' });
                } else {
                  // Git branch/commit/push
                  const workspace = getWorkspace();
                  const branchName = await getBranchName(issueId);
                  const opts = { cwd: workspace, stdio: 'pipe' as const, timeout: 30000 };

                  try {
                    let defaultBranch = 'main';
                    try { execSync('git rev-parse --verify main', { ...opts, stdio: 'pipe' }); } catch { defaultBranch = 'master'; }

                    try { execSync(`git checkout -b ${branchName} ${defaultBranch}`, opts); } catch { execSync(`git checkout ${branchName}`, opts); }

                    for (const f of allFiles) {
                      const cleanPath = f.replace(' (skipped - already exists)', '');
                      try { execSync(`git add "${cleanPath}"`, opts); } catch {}
                    }

                    const identifier = saIssue?.identifier || issueId.slice(0, 8);
                    const commitMsg = `${identifier}: ${saIssue?.title || 'scaffold'} (scaffold-architect)`;
                    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, opts);
                    execSync(`git push -u origin ${branchName}`, { ...opts, timeout: 60000 });

                    await postComment(issueId, null,
                      `_Code committed to branch \`${branchName}\` (scaffold-architect)_\n\nFiles:\n${allFiles.map(f => '- `' + f + '`').join('\n')}`
                    );

                    execSync(`git checkout ${defaultBranch}`, opts);
                    await patchIssue(issueId, { assigneeAgentId: AGENTS.reviewer, status: 'in_progress' });
                    console.log(`[scaffold-architect] Committed and pushed. Sent to Reviewer.`);
                  } catch (gitErr: any) {
                    console.error(`[scaffold-architect] Git failed:`, gitErr.message);
                    await postComment(issueId, null, `_Scaffold files written but git failed: ${gitErr.message}. Sending to Local Builder._`);
                    await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'], status: 'in_progress' });
                  }
                }
              } else {
                // Scaffold engine failed — fall back to Strategist
                console.log(`[scaffold-architect] Scaffold engine had errors. Falling back to Strategist.`);
                await postComment(issueId, null, `_Scaffold engine failed. Routing to Strategist for manual implementation._`);
                await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
              }
            } catch (parseErr: any) {
              console.error(`[scaffold-architect] JSON parse failed:`, parseErr.message);
              await postComment(issueId, null, `_Scaffold Architect produced invalid JSON: ${parseErr.message}. Routing to Strategist._`);
              await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
            }
          } else if (notScaffoldable) {
            console.log(`[scaffold-architect] NOT_SCAFFOLDABLE: ${notScaffoldable[1]}`);
            await postComment(issueId, null, `_Scaffold Architect: not scaffoldable — ${notScaffoldable[1].trim()}. Routing to Strategist._`);
            await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
          } else {
            // Could not parse response — fall back to Strategist
            console.log(`[scaffold-architect] Could not parse response. Falling back to Strategist.`);
            await postComment(issueId, null, `_Scaffold Architect response could not be parsed. Routing to Strategist._`);
            await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
          }
        } catch (err: any) {
          console.error(`[scaffold-architect] Error:`, err.message);
          await postComment(issueId, null, `_Scaffold Architect failed: ${err.message}. Routing to Strategist._`);
          await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
        }
      });

      return;
    }

    // Local Builder is bridge-owned now; forward immediately instead of running in the proxy.
    if (issueId && agentId === AGENTS['local builder']) {
      const localBuilderIssue = await getIssueDetails(issueId);
      const bridgeUrl = getBridgeUrl();

      // Determine if burst mode should be used (greenfield first pass)
      const useBurst = issueBuilderBurstMode.has(issueId);
      const burstModel = useBurst ? getBurstModel() : undefined;
      if (useBurst) {
        console.log(`[closedloop] Burst mode active for ${issueId.slice(0, 8)} — using ${burstModel}`);
        issueBuilderBurstMode.delete(issueId); // One-shot: only first pass uses burst
      }

      console.log(`[closedloop] Forwarding Local Builder assignment to bridge: ${bridgeUrl}`);

      try {
        const bridgeRes = await fetch(`${bridgeUrl}/webhook/issue-assigned`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueId,
            assigneeAgentId: agentId,
            title: localBuilderIssue?.title || 'Local Builder task',
            description: localBuilderIssue?.description || '',
            ...(burstModel ? { modelOverride: burstModel } : {}),
          }),
        });

        if (!bridgeRes.ok) {
          const bridgeText = await bridgeRes.text();
          console.error(`[closedloop] Bridge forward failed with status ${bridgeRes.status}: ${bridgeText}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Bridge forward failed: ${bridgeRes.status}` }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '_Local Builder assignment forwarded to bridge._',
            },
          })
        );
      } catch (err: any) {
        console.error('[closedloop] Failed to forward Local Builder assignment to bridge:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Bridge unreachable: ${err.message}` }));
      }

      return;
    }

    // ─── THREE-WAY COMPLEXITY ROUTER GATE ───
    // When Complexity Router is assigned, classify the issue into one of:
    //   1. SCAFFOLD — deterministic template (free, instant, zero LLM)
    //   2. LOCAL    — simple non-template task, route to Strategist → local LLM
    //   3. REMOTE   — genuinely novel/complex, call GLM-5 Remote Architect first
    if (issueId && agentId === AGENTS['complexity router']) {
      const issue = await getIssueDetails(issueId);
      const title = issue?.title || '';
      const description = issue?.description || '';

      console.log(`[complexity-router] Classifying: ${title.slice(0, 60)}`);

      // Path 1: Template scaffold detection
      const scaffoldConfig = detectScaffoldConfig(title, description);
      if (scaffoldConfig) {
        console.log(`[complexity-router] SCAFFOLD match: ${scaffoldConfig.entityPascal}`);
        await postComment(issueId, null,
          `_Complexity Router: **SCAFFOLD** path detected for ${scaffoldConfig.entityPascal} CRUD API. Generating deterministic code..._`
        );

        const workspace = getWorkspace();
        const scaffoldResult = executeScaffold(scaffoldConfig, workspace);
        const comment = formatScaffoldComment(scaffoldConfig, scaffoldResult);
        await postComment(issueId, null, comment);

        if (scaffoldResult.success) {
          const allFiles = [...scaffoldResult.filesWritten, ...scaffoldResult.filesPatched];
          const newFilesWritten = scaffoldResult.filesWritten.filter(f => !f.includes('skipped'));
          const allSkipped = newFilesWritten.length === 0;

          if (allSkipped) {
            // All files already exist — skip build verification, go directly to Reviewer
            console.log(`[complexity-router] All scaffold files already exist. Sending to Reviewer.`);
            await postComment(issueId, null,
              `_All scaffold files already exist. Skipping to Reviewer for validation._`
            );
            await patchIssue(issueId, {
              assigneeAgentId: AGENTS.reviewer,
              status: 'in_progress',
            });
          } else {
            // New files written — commit to a branch, then send to Reviewer
            console.log(`[complexity-router] Scaffold wrote ${newFilesWritten.length} new files. Committing to branch...`);

            const workspace = getWorkspace();
            const branchName = await getBranchName(issueId);
            const opts = { cwd: workspace, stdio: 'pipe' as const, timeout: 30000 };

            try {
              // Detect default branch
              let defaultBranch = 'main';
              try {
                execSync('git rev-parse --verify main', { ...opts, stdio: 'pipe' });
              } catch {
                defaultBranch = 'master';
              }

              // Create branch from default
              try {
                execSync(`git checkout -b ${branchName} ${defaultBranch}`, opts);
              } catch {
                execSync(`git checkout ${branchName}`, opts);
              }

              // Stage all scaffold files
              for (const f of allFiles) {
                const cleanPath = f.replace(' (skipped - already exists)', '');
                try {
                  execSync(`git add "${cleanPath}"`, opts);
                } catch {}
              }

              // Commit
              const issue = await getIssueDetails(issueId);
              const identifier = issue?.identifier || issueId.slice(0, 8);
              const commitMsg = `${identifier}: ${title} (scaffold)`;
              execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, opts);
              console.log(`[complexity-router] Committed: ${commitMsg}`);

              // Push
              execSync(`git push -u origin ${branchName}`, { ...opts, timeout: 60000 });
              console.log(`[complexity-router] Pushed branch: ${branchName}`);

              await postComment(issueId, null,
                `_Code committed to branch \`${branchName}\` (scaffold)_\n\nFiles:\n${allFiles.map(f => '- `' + f + '`').join('\n')}`
              );

              // Switch back to default branch
              execSync(`git checkout ${defaultBranch}`, opts);

              // Send directly to Reviewer (skip Local Builder for scaffold since build was verified)
              await patchIssue(issueId, {
                assigneeAgentId: AGENTS.reviewer,
                status: 'in_progress',
              });
              console.log(`[complexity-router] Scaffold committed and pushed. Sending to Reviewer.`);
            } catch (gitErr: any) {
              console.error(`[complexity-router] Git commit failed:`, gitErr.message);
              await postComment(issueId, null, `_Scaffold files written but git commit failed: ${gitErr.message}_`);
              // Fallback: send to Local Builder
              await patchIssue(issueId, {
                assigneeAgentId: AGENTS['local builder'],
                status: 'in_progress',
              });

              const bridgeUrl = getBridgeUrl();
              await fetch(`${bridgeUrl}/webhook/issue-assigned`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  issueId,
                  assigneeAgentId: AGENTS['local builder'],
                  title: `Build verification: ${title}`,
                  description: `Scaffold has written files but git commit failed. Fix and commit.\n\nFiles:\n${allFiles.map(f => '- ' + f).join('\n')}`,
                }),
              }).catch((err: any) => {
                console.error(`[complexity-router] Bridge forward failed:`, err.message);
              });
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            message: { role: 'assistant', content: '_Scaffold complete._' },
          }));
          return;
        }

        // Scaffold failed — fall through to Strategist
        console.log(`[complexity-router] Scaffold had errors, falling through to Strategist`);
      } else {
        // No regex match — check if this LOOKS like a CRUD task (natural language)
        // If so, route to Scaffold Architect for NL → ScaffoldConfig extraction
        const crudSignals = ['crud', 'api', 'service', 'endpoint', 'create', 'read', 'update', 'delete'];
        const textLower = (title + ' ' + description).toLowerCase();
        const crudScore = crudSignals.filter(s => textLower.includes(s)).length;

        if (crudScore >= 2 && AGENTS['scaffold architect']) {
          console.log(`[complexity-router] CRUD signals detected (score: ${crudScore}) but no regex match. Routing to Scaffold Architect for NL extraction.`);
          await postComment(issueId, null,
            `_Complexity Router: CRUD signals detected (score: ${crudScore}). Routing to **Scaffold Architect** for config extraction from natural language._`
          );
          await patchIssue(issueId, {
            assigneeAgentId: AGENTS['scaffold architect'],
            status: 'in_progress',
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            message: { role: 'assistant', content: '_Routed to Scaffold Architect._' },
          }));
          return;
        }
      }

      // Path 2 & 3: Score complexity
      const complexityScore = scoreComplexity(title, description);
      console.log(`[complexity-router] Complexity score: ${complexityScore}`);

      if (complexityScore >= 7) {
        // Path 3: REMOTE — genuinely complex, call Remote Architect
        console.log(`[complexity-router] REMOTE path: score ${complexityScore} >= 7`);
        await postComment(issueId, null,
          `_Complexity Router: **REMOTE** path (score: ${complexityScore}/10). Calling GLM-5 Remote Architect for architecture spec..._`
        );

        const archSpec = await callRemoteArchitect(issueId, title, description);
        if (archSpec) {
          // Update issue description with arch spec, then route to Strategist
          await patchIssue(issueId, {
            description: description + '\n\n---\n## Architecture Spec (GLM-5)\n\n' + archSpec,
            assigneeAgentId: AGENTS.strategist,
          });
        } else {
          // Remote failed — route to Strategist anyway
          await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: { role: 'assistant', content: `_Routed to ${archSpec ? 'Strategist (with arch spec)' : 'Strategist (remote unavailable)'}._` },
        }));
        return;
      }

      // Path 2: LOCAL — simple, route directly to Strategist
      console.log(`[complexity-router] LOCAL path: score ${complexityScore} < 7`);
      await postComment(issueId, null,
        `_Complexity Router: **LOCAL** path (score: ${complexityScore}/10). Routing to Strategist._`
      );
      await patchIssue(issueId, { assigneeAgentId: AGENTS.strategist });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: { role: 'assistant', content: '_Routed to Strategist via local path._' },
      }));
      return;
    }

    // Build Ollama payload — override model from agent config if available
    const configuredModel = agentName ? getAgentModel(agentName.toLowerCase()) : undefined;
    const ollamaPayload: OllamaRequest = {
      model: configuredModel || parsedBody.model,
      stream: parsedBody.stream ?? false,
      messages: [...(parsedBody.messages || [])],
    };

    // Enrich with issue context or heartbeat context
    if (issueId) {
      // Use enhanced context for Local Builder (includes Tier 1-3 file contents)
      const isBurst = issueBuilderBurstMode.has(issueId);
      const issueContext = (agentId === AGENTS['local builder'])
        ? await buildLocalBuilderContext(issueId, agentId, isBurst ? 'burst' : 'normal')
        : await buildIssueContext(issueId, agentId || '');
      if (issueContext) {
        ollamaPayload.messages.push({
          role: 'user',
          content: issueContext,
        });
      }
    } else if (parsedBody.context) {
      const heartbeatMsg = buildHeartbeatContext(parsedBody.context);
      ollamaPayload.messages.push({ role: 'user', content: heartbeatMsg });
    }

    console.log(
      `[proxy:${proxyPort}] ${agentName} -> ollama:${ollamaPort} | model=${ollamaPayload.model} | issue=${issueId?.slice(0, 8) || 'none'} | msgs=${ollamaPayload.messages.length}`
    );

    try {
      // Set timeout based on agent config (default 15 min)
      const timeoutConfig = loadConfig().ollama.timeouts;
      const timeoutSec = (agentName ? timeoutConfig[agentName.toLowerCase()] : undefined) || 900;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

      const ollamaRes = await fetch(`http://127.0.0.1:${ollamaPort}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaPayload),
        signal: controller.signal,
      });

      const ollamaData = await ollamaRes.text();
      clearTimeout(timeoutId);

      res.writeHead(ollamaRes.status, {
        'Content-Type': 'application/json',
      });
      res.end(ollamaData);

      // Post LLM output as comment and handle delegation
      if (issueId) {
        try {
          const parsed = JSON.parse(ollamaData);
          const content = parsed.message?.content || parsed.response || '';

          if (content.trim()) {
            // Post as system comment (null agentId) to avoid auth issues
            // Prefix with agent name for attribution
            const commentPrefix = agentName ? `**${agentName}:**\n\n` : '';
            await postComment(issueId, null, commentPrefix + content.trim());

            // Detect delegation and reassign via API (triggers auto-wakeup)
            if (agentId) {
              // Tech Lead → Local Builder: activate burst mode for greenfield scaffold
              if (agentId === AGENTS['tech lead'] && content.toLowerCase().includes('local builder')) {
                issueBuilderBurstMode.add(issueId);
                console.log(`[closedloop] Burst mode activated for ${issueId.slice(0, 8)} (first pass from Tech Lead)`);
              }
              await detectAndDelegate(issueId, agentId, content);
            }

            // Strategist/Sentinel/Deployer/Reviewer: execute bash commands
            if (agentId) {
              const commandsWereExecuted = await executeBashBlocks(issueId, agentId, content);

              // After executing bash commands, re-prompt the agent
              if (commandsWereExecuted && agentId !== AGENTS['local builder']) {
                console.log(`[closedloop] Commands executed - re-assigning to ${AGENT_NAMES[agentId] || 'agent'} for follow-up...`);
                try {
                  const currentIssue = await getIssueDetails(issueId);
                  await patchIssue(issueId, {
                    assigneeAgentId: agentId,
                    description: currentIssue?.description || '',
                  });
                  console.log(`[closedloop] Re-assigned issue ${issueId.slice(0, 8)} to ${AGENT_NAMES[agentId]} for follow-up`);
                } catch (err: any) {
                  console.error(`[closedloop] Failed to re-assign for follow-up:`, err.message);
                }
              }
            }

            // Reviewer: validate changes and approve/reject before PR creation
            if (agentId === AGENTS.reviewer) {
              const lower = content.toLowerCase();
              const reviewApproved =
                lower.includes('approved') ||
                lower.includes('looks good') ||
                lower.includes('lgtm') ||
                lower.includes('no issues') ||
                lower.includes('ready for pr') ||
                lower.includes('meet the project standards') ||
                lower.includes('meets the project standards') ||
                (lower.includes('result') && lower.includes('pass') && !lower.includes('send back'));

              if (reviewApproved) {
                console.log(`[closedloop] Reviewer APPROVED changes for ${issueId.slice(0, 8)}`);

                // Reset loop counter on successful approval
                resetLoopCounter(issueId);

                // Send to Diff Guardian for final validation before PR
                console.log(`[closedloop] Sending to Diff Guardian for final validation...`);
                try {
                  await patchIssue(issueId, { assigneeAgentId: AGENTS['diff guardian'] });
                  console.log(`[closedloop] Auto-assigned to Diff Guardian`);
                } catch (err: any) {
                  console.error(`[closedloop] Failed to trigger Diff Guardian:`, err.message);
                  // Fallback: run Diff Guardian mechanically
                  const diffResult = await runDiffGuardian(issueId);
                  if (diffResult.approved) {
                    await createPullRequest(issueId);
                    resetLoopCounter(issueId);
                  } else {
                    await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                  }
                }
              } else {
                // Reviewer rejected - track loop
                const loopStatus = trackLoop(issueId, agentId);
                console.log(`[closedloop] Reviewer found issues - sending back to Local Builder (loop: ${loopStatus.count}/${MAX_LOOP_PASSES})`);

                // Detect BURST request from Reviewer
                // Reviewer can include "BURST" in rejection to request the stronger model
                const burstRequested = /\bBURST\b/.test(content);
                if (burstRequested) {
                  issueBuilderBurstMode.add(issueId);
                  console.log(`[closedloop] Reviewer requested BURST mode for ${issueId.slice(0, 8)} — next builder pass uses ${getBurstModel()}`);
                }

                // Check if loop exceeded
                if (loopStatus.exceeded) {
                  console.log(`[closedloop] LOOP EXCEEDED (${loopStatus.count}) during Reviewer rejection`);
                  await postComment(
                    issueId,
                    null,
                    `**Review Loop Exceeded - Manual Review Required**\n\n` +
                    `This issue has been rejected by Reviewer ${loopStatus.count} times.\n` +
                    `Please review the feedback and provide clearer guidance.\n\n` +
                    `**Recent Reviewer feedback:**\n${content.slice(0, 500)}...`
                  );
                }

                // Auto-escalate to burst after 3 rejections even without explicit BURST keyword
                if (loopStatus.count >= 3 && !issueBuilderBurstMode.has(issueId)) {
                  issueBuilderBurstMode.add(issueId);
                  console.log(`[closedloop] Auto-escalated to BURST mode after ${loopStatus.count} rejections`);
                }

                try {
                  await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                  console.log(`[closedloop] Sent back to Local Builder for fixes${burstRequested ? ' (BURST)' : ''}`);
                } catch (err: any) {
                  console.error(`[closedloop] Failed to send back to Local Builder:`, err.message);
                }
              }
            }

            // Diff Guardian: final validation before PR creation
            if (agentId === AGENTS['diff guardian']) {
              const diffResult = await runDiffGuardian(issueId);

              if (diffResult.approved) {
                // Create PR after diff guardian approval
                try {
                  await createPullRequest(issueId);
                  console.log(`[closedloop] PR created after DiffGuardian approval`);

                  // Reset loop counter on successful PR
                  resetLoopCounter(issueId);

                  // Mark issue as in_review (PR created, pipeline complete)
                  await patchIssue(issueId, {
                    assigneeAgentId: AGENTS['visual reviewer'],
                    status: 'in_review',
                  });
                  console.log(`[closedloop] Issue marked in_review, assigned to Visual Reviewer`);
                } catch (prErr: any) {
                  console.error(`[closedloop] Failed to create PR:`, prErr.message);
                  await postComment(issueId, null, `_DiffGuardian approved but PR creation failed: ${prErr.message}_`);
                }
              } else {
                // Diff Guardian rejected - track loop
                const loopStatus = trackLoop(issueId, agentId);
                console.log(`[closedloop] DiffGuardian found issues (loop: ${loopStatus.count}/${MAX_LOOP_PASSES})`);
                
                // Diff Guardian sends back to Local Builder
                await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
                console.log(`[closedloop] Sent back to Local Builder for fixes`);
              }
            }
          } else {
            await postComment(issueId, null, `**${agentName || 'Agent'}:** _Completed run but produced no text output._`);
          }
        } catch {
          await postComment(issueId, null, `**${agentName || 'Agent'}:** _Run completed. Response could not be parsed._`);
        }
      }
    } catch (err: any) {
      console.error(`[proxy:${proxyPort}] ${agentName} Ollama error:`, err.message);
      if (issueId) {
        await postComment(issueId, null, `**${agentName || 'Agent'}:** _Run failed: ${err.message}_`);
      }
      res.writeHead(502);
      res.end(JSON.stringify({ error: `Ollama unreachable: ${err.message}` }));
    }
  });

  server.listen(proxyPort, '127.0.0.1', () => {
    console.log(`[closedloop] :${proxyPort} -> ollama:${ollamaPort}`);
  });

  return server;
}

function getBridgeUrl(): string {
  const projectConfig = getConfig() as any;
  return projectConfig.closedloop?.bridgeUrl || 'http://localhost:3202';
}

function buildHeartbeatContext(context: any): string {
  const parts: string[] = [];
  if (context.wakeReason) parts.push(`Wake reason: ${context.wakeReason}`);
  if (context.paperclipWorkspace?.cwd) {
    parts.push(`Workspace: ${context.paperclipWorkspace.cwd}`);
  }
  if (parts.length === 0) {
    parts.push('This is a routine heartbeat check. Report your current status briefly.');
  }
  return parts.join('\n');
}

// Background issue assignment checker
export async function checkAssignedIssues(): Promise<void> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (!res.ok) return;

    const data = await res.json() as any[] | { issues?: any[]; data?: any[] };
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

    const assignedIssues = issues.filter(
      (i: any) => (i.status === 'todo' || i.status === 'in_progress') && i.assigneeAgentId
    );

    for (const issue of assignedIssues) {
      const agentId = issue.assigneeAgentId;
      const agentName = AGENT_NAMES[agentId] || 'unknown';

      if (BLOCKED_AGENTS.has(agentId)) continue;

      const recentRunKey = `${agentId}:${issue.id}`;
      if (recentAgentRuns.has(recentRunKey)) {
        const lastRun = recentAgentRuns.get(recentRunKey)!;
        if (Date.now() - lastRun < DELEGATION_COOLDOWN_MS) continue;
      }

      console.log(`[closedloop] Background check: ${agentName} has assigned issue ${issue.identifier || issue.id.slice(0, 8)}`);

      try {
        // Directly invoke the proxy (self-call) to trigger the full agent flow
        // patchIssue alone doesn't trigger Paperclip to re-run agents
        const config = loadConfig();
        const agentModel = config.ollama?.models?.[agentName.toLowerCase()] || 'qwen3:8b';
        const issueDetails = await getIssueDetails(issue.id);
        const context = await buildIssueContext(issue.id, agentId);

        const selfCallPayload = {
          model: agentModel,
          agentId: agentId,
          issueId: issue.id,
          messages: [
            { role: 'system', content: `You are the ${agentName} agent.` },
            { role: 'user', content: context || `Process issue ${issue.identifier}: ${issueDetails?.title || ''}` },
          ],
          stream: false,
        };

        // Fire-and-forget self-call to port 3201
        fetch(`http://127.0.0.1:${proxyPort}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selfCallPayload),
        }).catch(err => {
          console.log(`[closedloop] Self-call failed for ${agentName}: ${err.message}`);
        });

        recentAgentRuns.set(recentRunKey, Date.now());
        console.log(`[closedloop] Triggered wakeup for ${agentName} on ${issue.identifier || issue.id.slice(0, 8)}`);
      } catch (err: any) {
        console.log(`[closedloop] Failed to trigger ${agentName}: ${err.message}`);
      }
    }
  } catch (err: any) {
    // Silent fail
  }
}

// Initialize RAG indexer
export async function initializeRAG(): Promise<void> {
  await ragIndexer.initialize();
  setRAGIndexer(ragIndexer);
  console.log('[closedloop] RAG index initialized');
}

