/**
 * Epic Decoder — Remote LLM decomposition of epics into tickets.
 *
 * Triggered when a high-complexity goal (score >= 7) is assigned.
 * Uses remote glm-5 to break down broad epics into narrow, buildable tickets.
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
import { getIssueDetails, postComment, patchIssue } from './paperclip-api';
import { callZAI } from './remote-ai';
import { AGENTS } from './agent-types';
import { decomposeGoalIntoTickets } from './goal-system';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const WORKSPACE = getWorkspace();

// Track decode runs per epic: goalId → run count
const epicDecodeRuns = new Map<string, number>();
const MAX_DECODE_RUNS = 2;

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Check if an epic needs decomposition and run the Epic Decoder.
 * Called by proxy-server.ts when a high-complexity goal is detected.
 */
export async function decodeEpic(goalId: string): Promise<boolean> {
  try {
    const goal = await getIssueDetails(goalId);
    if (!goal) return false;

    // Check if already decomposed (has child tickets)
    const existingTickets = await getEpicTickets(goalId);
    if (existingTickets.length > 0) {
      console.log(`[epic-decoder] Epic ${goalId.slice(0, 8)} already has ${existingTickets.length} tickets — skipping`);
      return false;
    }

    // Check run count
    const runCount = epicDecodeRuns.get(goalId) || 0;
    if (runCount >= MAX_DECODE_RUNS) {
      console.log(`[epic-decoder] Epic ${goalId.slice(0, 8)} already decoded ${runCount} times — skipping`);
      return false;
    }

    // Mark this run
    epicDecodeRuns.set(goalId, runCount + 1);

    console.log(`[epic-decoder] Epic "${goal.title}" ready for decomposition (run ${runCount + 1}/${MAX_DECODE_RUNS})`);
    await runEpicDecode(goal, runCount + 1);
    return true;
  } catch (err: any) {
    console.error(`[epic-decoder] Decode failed: ${err.message}`);
    return false;
  }
}

/**
 * Run the epic decomposition.
 */
async function runEpicDecode(
  goal: any,
  runNumber: number
): Promise<void> {
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
  const prompt = buildDecodePrompt(goal, projectStructure, commonPatterns, runNumber);

  // 4. Call remote LLM
  console.log(`[epic-decoder] Sending to glm-5 (${prompt.length} chars)`);
  let decodeContent: string;
  try {
    decodeContent = await callZAI(prompt, buildSystemPrompt());
  } catch (err: any) {
    console.error(`[epic-decoder] Remote LLM failed: ${err.message}`);
    await postComment(goal.id, null, `_Epic Decoder (GLM-5) failed: ${err.message}_`);
    return;
  }

  // 5. Parse and create tickets
  if (decodeContent.includes('## Ticket:')) {
    console.log(`[epic-decoder] Ticket decomposition received`);
    try {
      await decomposeGoalIntoTickets(goal.id, decodeContent);
      await postComment(goal.id, null, `✅ Epic Decoder (GLM-5) decomposed epic into tickets. Child issues created.`);
      
      // Assign first ticket to Tech Lead to start the flow
      const tickets = await getEpicTickets(goal.id);
      if (tickets.length > 0) {
        const firstTicket = tickets[0];
        await patchIssue(firstTicket.id, { assigneeAgentId: AGENTS['tech lead'] });
        console.log(`[epic-decoder] First ticket ${firstTicket.identifier} assigned to Tech Lead`);
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
  commonPatterns: string,
  runNumber: number
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

  if (runNumber > 1) {
    prompt += `**Note:** This is decomposition attempt #${runNumber}. Previous attempts may have failed. Be more thorough.

`;
  }

  prompt += `**OUTPUT:**
Decompose the epic above into tickets using the exact format shown in the system prompt.
Create one ticket per feature. Be specific about file paths. Do NOT write implementation code.`;

  return prompt;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function getEpicTickets(goalId: string): Promise<any[]> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (!res.ok) return [];

    const data = await res.json() as any;
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

    return issues.filter(
      (i: any) => i.goalId === goalId && i.status !== 'cancelled'
    );
  } catch {
    return [];
  }
}
