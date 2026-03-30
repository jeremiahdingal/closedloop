/**
 * Epic Decoder — Remote LLM decomposition of epics into tickets.
 *
 * Triggered when a high-complexity goal is assigned or when the active-goal
 * heartbeat finds an undecomposed epic.
 * Uses the shared remote LLM adapter (Codex CLI / OpenAI / z.ai) to break
 * down broad epics into narrow, buildable tickets.
 *
 * Output format:
 *   ## Ticket: <title>
 *   **Objective:** <one sentence>
 *   **Files:** <exact file paths>
 *   **Acceptance Criteria:**
 *   - [ ] <testable criterion>
 *   **Dependencies:** <other tickets or None>
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getCompanyId, getPaperclipApiUrl } from './config';
import { getIssueLabel, postComment, patchIssue } from './paperclip-api';
import { callRemoteLLM } from './remote-ai';
import { AGENTS } from './agent-types';
import { decomposeGoalIntoTickets, getEpicTickets, enforceGoalOverlapSuppression, getOverlapBlockForTicket } from './goal-system';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const WORKSPACE = getWorkspace();

interface GoalRecord {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
  parentId: string | null;
  ownerAgentId: string | null;
}

// File-based lock to prevent duplicate decomposition across bridge restarts
const DECOMPOSED_LOCK_FILE = path.join(WORKSPACE, '.epics-decomposed.json');
const epicDecodeInFlight = new Set<string>();

function isEpicDecomposed(goalId: string): boolean {
  try {
    if (!fs.existsSync(DECOMPOSED_LOCK_FILE)) return false;
    const decomposed = JSON.parse(fs.readFileSync(DECOMPOSED_LOCK_FILE, 'utf8'));
    return decomposed.includes(goalId);
  } catch {
    return false;
  }
}

function markEpicDecomposed(goalId: string): void {
  try {
    let decomposed: string[] = [];
    if (fs.existsSync(DECOMPOSED_LOCK_FILE)) {
      decomposed = JSON.parse(fs.readFileSync(DECOMPOSED_LOCK_FILE, 'utf8'));
    }
    if (!decomposed.includes(goalId)) {
      decomposed.push(goalId);
      fs.writeFileSync(DECOMPOSED_LOCK_FILE, JSON.stringify(decomposed, null, 2));
    }
  } catch (err: any) {
    console.error(`[epic-decoder] Failed to write lock file: ${err.message}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Check if an epic needs decomposition and run the Epic Decoder.
 * Called by proxy-server.ts when a high-complexity goal is detected.
 */
export async function decodeEpic(goalId: string): Promise<boolean> {
  if (epicDecodeInFlight.has(goalId)) {
    console.log(`[epic-decoder] Epic ${goalId.slice(0, 8)} is already decoding - skipping duplicate trigger`);
    return false;
  }

  epicDecodeInFlight.add(goalId);
  try {
    const goal = await getGoal(goalId);
    if (!goal) return false;
    const goalLabel = await getIssueLabel(goalId);

    // Check file-based lock FIRST (prevents duplicates across bridge restarts)
    if (isEpicDecomposed(goalId)) {
      console.log(`[epic-decoder] Epic ${goalLabel} is locked (already decomposed) - skipping`);
      return false;
    }

    // Check if already decomposed (has child tickets)
    const existingTickets = await getEpicTickets(goalId);
    if (existingTickets.length > 0) {
      console.log(`[epic-decoder] Epic ${goalLabel} already has ${existingTickets.length} tickets - skipping`);
      markEpicDecomposed(goalId); // Ensure lock exists
      return false;
    }

    console.log(`[epic-decoder] Epic ${goalLabel} "${goal.title}" ready for decomposition`);
    await runEpicDecode(goal);
    markEpicDecomposed(goalId); // Mark as decomposed AFTER success
    return true;
  } catch (err: any) {
    console.error(`[epic-decoder] Decode failed: ${err.message}`);
    return false;
  } finally {
    epicDecodeInFlight.delete(goalId);
  }
}

/**
 * Run the epic decomposition.
 */
async function runEpicDecode(goal: any): Promise<void> {
  // 1. Load PROJECT_STRUCTURE.md for context
  let projectStructure = '';
  try {
    projectStructure = fs.readFileSync(path.join(WORKSPACE, 'PROJECT_STRUCTURE.md'), 'utf8');
  } catch {}

  // 2. Load COMMON_PATTERNS.md for patterns
  let commonPatterns = '';
  try {
    commonPatterns = fs.readFileSync(path.join(WORKSPACE, 'COMMON_PATTERNS.md'), 'utf8');
  } catch {}

  // 3. Build the decode prompt
  const prompt = buildDecodePrompt(goal, projectStructure, commonPatterns);

  // 4. Call remote LLM
  const provider = process.env.REMOTE_LLM_PROVIDER || 'codex';
  console.log(`[epic-decoder] Sending to ${provider} (${prompt.length} chars)`);
  let decodeContent: string;
  try {
    decodeContent = await callRemoteLLM(prompt, buildSystemPrompt());
  } catch (err: any) {
    console.error(`[epic-decoder] Remote LLM failed: ${err.message}`);
    await postComment(goal.id, null, `_Epic Decoder failed: ${err.message}_`);
    return;
  }

  // 5. Parse and create tickets
  if (decodeContent.includes('## Ticket:')) {
    console.log(`[epic-decoder] Ticket decomposition received`);
    try {
      await decomposeGoalIntoTickets(goal.id, decodeContent);
      await postComment(goal.id, null, `✅ Epic Decoder decomposed epic into tickets. Child issues created.`);

      // Assign ALL tickets to Complexity Router so each decoded ticket enters
      // the normal scaffold/classification path.
      const tickets = await getEpicTickets(goal.id);
      if (tickets.length > 0) {
        await enforceGoalOverlapSuppression(goal.id, tickets);
        for (const ticket of tickets) {
          if (getOverlapBlockForTicket(ticket.id)) {
            console.log(`[epic-decoder] Ticket ${ticket.identifier} blocked by overlap; leaving unassigned`);
            continue;
          }
          await patchIssue(ticket.id, { assigneeAgentId: AGENTS['complexity router'] });
          console.log(`[epic-decoder] Ticket ${ticket.identifier} assigned to Complexity Router`);
        }
        const blockedCount = tickets.filter(ticket => getOverlapBlockForTicket(ticket.id)).length;
        console.log(`[epic-decoder] Routed ${tickets.length - blockedCount} tickets to Complexity Router (${blockedCount} blocked by overlap)`);
      }
    } catch (err: any) {
      console.error(`[epic-decoder] Failed to create tickets: ${err.message}`);
      await postComment(goal.id, null, `_Epic Decoder failed to create tickets: ${err.message}_`);
    }
  } else {
    console.log(`[epic-decoder] No ticket decomposition in response`);
    await postComment(goal.id, null, `⚠️ Epic Decoder output did not contain ticket decomposition. Please try again.`);
  }
}

// ─── Prompt Building ────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are an expert software architect specializing in breaking down large epics into narrow, buildable tickets for a POS (point-of-sale) system.

Your output MUST use this exact format for each ticket:

## Ticket: <short descriptive title>
**Objective:** <one sentence — what "done" looks like>
**Files:** <exact file paths to create/modify>
**Acceptance Criteria:**
- [ ] <testable criterion 1>
- [ ] <testable criterion 2>
**Dependencies:** <other ticket titles or "None">

RULES:
1. ONE ticket per feature — narrow scope (1-2 files max)
2. Specific file paths — use exact paths like packages/app/cashier/checkout/CashConfirmModal.tsx
3. Testable criteria — each must be verifiable (build passes, API returns 200, etc.)
4. NO implementation code — do NOT write FILE: blocks or code snippets
5. Order matters — list tickets in dependency order (foundational first)
6. Complete coverage — ensure all features in the epic are covered`;
}

function buildDecodePrompt(
  goal: any,
  projectStructure: string,
  commonPatterns: string
): string {
  let prompt = `**TASK:** Decompose this epic into narrow, buildable tickets.

**Epic:** ${goal.title}
**Description:**
${goal.description || 'No description provided'}

`;

  if (projectStructure) {
    prompt += `**Project Structure:**
${projectStructure.substring(0, 3000)}

`;
  }

  if (commonPatterns) {
    prompt += `**Common Patterns:**
${commonPatterns.substring(0, 3000)}

`;
  }

  prompt += `**OUTPUT:**
Decompose the epic above into tickets using the exact format shown in the system prompt.
Create one ticket per feature. Be specific about file paths. Do NOT write implementation code.`;

  return prompt;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function getGoal(goalId: string): Promise<GoalRecord | null> {
  try {
    const directRes = await fetch(`${PAPERCLIP_API}/api/goals/${goalId}`);
    if (directRes.ok) {
      return await directRes.json() as GoalRecord;
    }
  } catch {}

  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/goals`);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const goals = Array.isArray(data) ? data : data.value || data.goals || data.data || [];
    return goals.find((goal: GoalRecord) => goal.id === goalId) || null;
  } catch {
    return null;
  }
}

export async function checkActiveGoalsForDecode(): Promise<void> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/goals`);
    if (!res.ok) return;

    const data = await res.json() as any;
    const goals = Array.isArray(data) ? data : data.value || data.goals || data.data || [];
    const activeGoals = goals.filter((goal: GoalRecord) => goal.status === 'active');

    for (const goal of activeGoals) {
      if (isEpicDecomposed(goal.id)) continue;

      const existingTickets = await getEpicTickets(goal.id);
      if (existingTickets.length > 0) {
        markEpicDecomposed(goal.id);
        continue;
      }

      const goalLabel = await getIssueLabel(goal.id);
      console.log(`[epic-decoder] Active-goal heartbeat starting ${goalLabel} "${goal.title}"`);
      await decodeEpic(goal.id);
    }
  } catch (err: any) {
    console.error(`[epic-decoder] Active-goal heartbeat failed: ${err.message}`);
  }
}
