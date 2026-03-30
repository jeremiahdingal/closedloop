/**
 * Epic Reviewer — Remote LLM review of all tickets in an epic as a whole.
 *
 * Triggered when all tickets in an epic reach `in_review` status.
 * Uses remote glm-5 to review the combined diff across all tickets,
 * catching cross-ticket issues (conflicting imports, missing types, route gaps).
 *
 * 2-run cap:
 *   Run 1: If issues found → sends specific fix comments per ticket, reassigns to Builder
 *   Run 2: If issues still found → appends comments to PRs and ships anyway (human decides)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getCompanyId, getPaperclipApiUrl } from './config';
import { getIssueDetails, postComment, patchIssue } from './paperclip-api';
import { callRemoteLLM } from './remote-ai';
import { AGENTS } from './agent-types';
import { getBranchName, getDefaultBranch, commitAndPush } from './git-ops';
import { applyCodeBlocks } from './code-extractor';
import { getActionableEpicTickets } from './goal-system';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const WORKSPACE = getWorkspace();

// Track review runs per epic: goalId → run count
const epicReviewRuns = new Map<string, number>();

interface EpicTicket {
  id: string;
  identifier: string;
  title: string;
  status: string;
  goalId: string;
  branchName: string;
  diff: string;
}

interface EpicReviewResult {
  approved: boolean;
  feedback: string; // Overall feedback
  ticketFeedback: Array<{ identifier: string; issueId: string; comment: string }>; // Per-ticket
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Check all active epics for readiness and run the Epic Reviewer.
 * Called periodically by the background checker.
 */
export async function checkEpicsForReview(): Promise<void> {
  try {
    // Get all goals (epics)
    const goalsRes = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/goals`);
    if (!goalsRes.ok) return;

    const goals = await goalsRes.json() as any[];
    const activeGoals = goals.filter((g: any) => g.status === 'active');

    for (const goal of activeGoals) {
      const tickets = await getActionableEpicTickets(goal.id);
      if (tickets.length === 0) continue;

      // Check if ALL tickets are in_review
      const allInReview = tickets.every(t => t.status === 'in_review');
      if (!allInReview) continue;

      const runCount = epicReviewRuns.get(goal.id) || 0;
      if (runCount >= 2) continue; // Already hit the cap

      console.log(`[epic-reviewer] Epic "${goal.title}" ready for review (run ${runCount + 1}/2, ${tickets.length} tickets)`);
      await runEpicReview(goal, tickets, runCount + 1);
    }
  } catch (err: any) {
    console.error(`[epic-reviewer] Check failed: ${err.message}`);
  }
}

/**
 * Run the epic review for a set of tickets.
 */
async function runEpicReview(
  goal: any,
  tickets: EpicTicket[],
  runNumber: number
): Promise<void> {
  // Mark this run immediately to prevent race conditions
  epicReviewRuns.set(goal.id, runNumber);

  // 1. Collect diffs for all tickets
  const ticketsWithDiffs = await collectDiffs(tickets);
  const ticketsWithContent = ticketsWithDiffs.filter(t => t.diff.length > 0);

  if (ticketsWithContent.length === 0) {
    console.log(`[epic-reviewer] No diffs found for epic — skipping`);
    return;
  }

  // 2. Load PROJECT_STRUCTURE.md for context
  let projectStructure = '';
  try {
    projectStructure = fs.readFileSync(path.join(WORKSPACE, 'PROJECT_STRUCTURE.md'), 'utf8');
  } catch {}

  // 3. Collect referenced files (imports mentioned in diffs)
  const referencedFiles = extractReferencedFiles(ticketsWithContent);

  // 4. Build the review prompt
  const prompt = buildReviewPrompt(goal, ticketsWithContent, projectStructure, referencedFiles, runNumber);

  // 5. Call remote LLM
  console.log(`[epic-reviewer] Sending to glm-5 (${prompt.length} chars, ${ticketsWithContent.length} tickets)`);
  let reviewContent: string;
  try {
    reviewContent = await callRemoteLLM(prompt, buildSystemPrompt());
  } catch (err: any) {
    console.error(`[epic-reviewer] Remote LLM failed: ${err.message}`);
    return;
  }

  // 6. Parse the review result
  const result = parseReviewResult(reviewContent, ticketsWithContent);
  console.log(`[epic-reviewer] Result: ${result.approved ? 'APPROVED' : 'CHANGES_REQUESTED'} (${result.ticketFeedback.length} ticket comments)`);

  // 7. Apply the result based on run number
  if (result.approved) {
    // Approved — post summary and leave tickets in in_review for merge
    await postEpicApproval(goal, ticketsWithContent, result);
  } else if (runNumber === 1) {
    // Run 1: Fix code directly using FILE: blocks from the LLM response
    await applyFixesDirectly(goal, ticketsWithContent, reviewContent, result);
  } else {
    // Run 2: Still broken — append comments to PRs and ship for human review
    await appendCommentsAndShip(goal, ticketsWithContent, result);
  }
}

// ─── Data Collection ────────────────────────────────────────────────

async function getLegacyEpicTickets(goalId: string): Promise<EpicTicket[]> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (!res.ok) return [];

    const data = await res.json() as any;
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];

    const goalTickets = issues.filter(
      (i: any) => i.goalId === goalId && i.status !== 'cancelled'
    );

    const result: EpicTicket[] = [];
    for (const issue of goalTickets) {
      const branchName = await getBranchName(issue.id);
      result.push({
        id: issue.id,
        identifier: issue.identifier || issue.id.slice(0, 8),
        title: issue.title,
        status: issue.status,
        goalId: issue.goalId,
        branchName,
        diff: '', // filled later
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function collectDiffs(tickets: EpicTicket[]): Promise<EpicTicket[]> {
  const defaultBranch = getDefaultBranch();
  const opts = { cwd: WORKSPACE, stdio: 'pipe' as const, timeout: 30000 };

  for (const ticket of tickets) {
    try {
      // Get the diff between the ticket branch and the default branch
      const diff = execSync(
        `git diff ${defaultBranch}...${ticket.branchName} -- . ":(exclude)docs/screenshots"`,
        { ...opts, maxBuffer: 1024 * 1024 }
      ).toString().trim();

      // Truncate very large diffs per ticket
      ticket.diff = diff.length > 15000 ? diff.slice(0, 15000) + '\n... (truncated)' : diff;
    } catch (err: any) {
      console.log(`[epic-reviewer] Could not get diff for ${ticket.identifier}: ${err.message}`);
      ticket.diff = '';
    }
  }
  return tickets;
}

/**
 * Extract file paths referenced in diffs (import statements) and read their contents.
 * Only reads files that exist in the workspace and aren't part of the diffs themselves.
 */
function extractReferencedFiles(tickets: EpicTicket[]): Record<string, string> {
  const allDiffs = tickets.map(t => t.diff).join('\n');
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  const referenced: Record<string, string> = {};
  const seen = new Set<string>();

  let match;
  while ((match = importRegex.exec(allDiffs)) !== null) {
    const importPath = match[1];
    // Skip node_modules and relative paths that are likely within the diff itself
    if (importPath.startsWith('.') || importPath.startsWith('@tamagui') || importPath.startsWith('react')) continue;

    // Resolve app/ and @shop-diary/ paths
    let resolvedPath = '';
    if (importPath.startsWith('app/')) {
      resolvedPath = path.join('packages', importPath);
    } else if (importPath.startsWith('@shop-diary/ui/')) {
      resolvedPath = path.join('packages', importPath.replace('@shop-diary/', ''));
    }

    if (!resolvedPath || seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);

    // Try .ts and .tsx extensions
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const fullPath = path.join(WORKSPACE, resolvedPath + ext);
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Cap per file to keep tokens reasonable
          referenced[resolvedPath + ext] = content.length > 2000
            ? content.slice(0, 2000) + '\n// ... truncated'
            : content;
          break;
        }
      } catch {}
    }
  }

  return referenced;
}

// ─── Prompt Building ────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a senior staff engineer doing a final review of an entire feature (epic) before it ships to production.

You are reviewing the COMBINED output of multiple tickets that together implement one feature.
Your job is to catch issues that per-ticket reviews miss:
- Cross-file inconsistencies (type mismatches, wrong imports between files)
- Missing integration points (route not registered, hook not exported, type not added to db.types)
- Naming/pattern violations vs the project conventions
- Logical gaps (e.g., API endpoint exists but no frontend calls it, or vice versa)
- Duplicate code across tickets

OUTPUT FORMAT — you MUST follow this exactly:

If everything looks good:
VERDICT: APPROVED
(brief summary of what looks good)

If changes are needed:
VERDICT: CHANGES_REQUESTED

For EACH file that needs fixing, output the COMPLETE corrected file:

TICKET: SHO-XX
FILE: relative/path/to/file.ext
\`\`\`typescript
// complete corrected file content here
\`\`\`

TICKET: SHO-YY
FILE: relative/path/to/other-file.ext
\`\`\`typescript
// complete corrected file content here
\`\`\`

SUMMARY:
(brief explanation of what was wrong and what you fixed)

IMPORTANT:
- Output the FULL corrected file content, not just the diff or snippet
- Tag each FILE: block to the TICKET it belongs to (so fixes go to the right branch)
- Only fix real bugs and integration issues, not style preferences
- If a file is fine, don't include it — only output files that need changes`;
}

function buildReviewPrompt(
  goal: any,
  tickets: EpicTicket[],
  projectStructure: string,
  referencedFiles: Record<string, string>,
  runNumber: number
): string {
  let prompt = '';

  // Project conventions (truncated)
  if (projectStructure) {
    const truncated = projectStructure.length > 4000
      ? projectStructure.slice(0, 4000) + '\n... (truncated)'
      : projectStructure;
    prompt += `## Project Conventions\n${truncated}\n\n`;
  }

  // Epic context
  prompt += `## Epic: ${goal.title}\n`;
  if (goal.description) {
    prompt += `${goal.description.slice(0, 1000)}\n`;
  }
  prompt += `\nThis is review run ${runNumber}/2.\n`;
  if (runNumber === 2) {
    prompt += `This is the FINAL review. Be pragmatic — only flag blocking issues, not nice-to-haves.\n`;
  }
  prompt += '\n';

  // Combined diffs per ticket
  prompt += `## Ticket Diffs (${tickets.length} tickets)\n\n`;
  for (const ticket of tickets) {
    prompt += `### TICKET: ${ticket.identifier} — ${ticket.title}\n`;
    prompt += `\`\`\`diff\n${ticket.diff}\n\`\`\`\n\n`;
  }

  // Referenced existing files
  const refEntries = Object.entries(referencedFiles);
  if (refEntries.length > 0) {
    prompt += `## Existing Files Referenced by Diffs (${refEntries.length} files)\n\n`;
    for (const [filePath, content] of refEntries.slice(0, 10)) { // Cap at 10 files
      prompt += `### ${filePath}\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
    }
  }

  return prompt;
}

// ─── Result Parsing ─────────────────────────────────────────────────

function parseReviewResult(content: string, tickets: EpicTicket[]): EpicReviewResult {
  const approved = /VERDICT:\s*APPROVED/i.test(content);

  // Parse per-ticket feedback
  const ticketFeedback: EpicReviewResult['ticketFeedback'] = [];
  const ticketBlockRegex = /TICKET:\s*([\w-]+)\s*[—–-]\s*.*?\n([\s\S]*?)(?=TICKET:|SUMMARY:|$)/gi;
  let match;

  while ((match = ticketBlockRegex.exec(content)) !== null) {
    const identifier = match[1].trim();
    const comment = match[2].trim();
    // Find the matching ticket
    const ticket = tickets.find(t =>
      t.identifier.toLowerCase() === identifier.toLowerCase()
    );
    if (ticket && comment) {
      ticketFeedback.push({
        identifier: ticket.identifier,
        issueId: ticket.id,
        comment,
      });
    }
  }

  // Extract summary
  const summaryMatch = content.match(/SUMMARY:\s*([\s\S]*?)$/i);
  const feedback = summaryMatch ? summaryMatch[1].trim() : content.slice(0, 500);

  return { approved, feedback, ticketFeedback };
}

// ─── Result Handlers ────────────────────────────────────────────────

async function postEpicApproval(
  goal: any,
  tickets: EpicTicket[],
  result: EpicReviewResult
): Promise<void> {
  const ticketList = tickets.map(t => `- ${t.identifier}: ${t.title}`).join('\n');
  for (const ticket of tickets) {
    await postComment(
      ticket.id,
      null,
      `**Epic Review: APPROVED**\n\n` +
      `Epic: ${goal.title}\n` +
      `All ${tickets.length} tickets reviewed as a whole by remote reviewer.\n\n` +
      `${result.feedback}\n\n` +
      `Tickets in this epic:\n${ticketList}`
    );
    
    // Update ticket status to done
    await patchIssue(ticket.id, { status: 'done' });
  }
  
  // Also mark goal as done
  await patchIssue(goal.id, { status: 'done' });
  
  console.log(`[epic-reviewer] Epic "${goal.title}" APPROVED — ${tickets.length} tickets marked done`);
}

/**
 * Run 1: Apply fixes directly to ticket branches.
 * Parses FILE: blocks from the LLM response, groups by ticket, commits to each branch.
 */
async function applyFixesDirectly(
  goal: any,
  tickets: EpicTicket[],
  llmResponse: string,
  result: EpicReviewResult
): Promise<void> {
  // Parse TICKET: + FILE: blocks from the response
  const ticketFixMap = parseTicketFiles(llmResponse, tickets);
  let fixedCount = 0;

  for (const [ticketId, fileContent] of Object.entries(ticketFixMap)) {
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) continue;

    try {
      // Apply the code blocks to the workspace (writes files)
      const { written, fileContents } = await applyCodeBlocks(fileContent, ticket.branchName);

      if (written.length > 0) {
        // Commit and push to the ticket's branch
        await commitAndPush(ticket.id, written, fileContents);
        fixedCount += written.length;

        await postComment(
          ticket.id,
          null,
          `**Epic Review (Run 1/2): Auto-fixed ${written.length} files**\n\n` +
          `The Epic Reviewer found cross-ticket issues and applied fixes directly:\n` +
          written.map(f => `- \`${f}\``).join('\n') + '\n\n' +
          `${result.feedback}\n\n` +
          `_Epic will be reviewed one more time after all tickets are updated._`
        );
        console.log(`[epic-reviewer] Fixed ${written.length} files in ${ticket.identifier}`);
      }
    } catch (err: any) {
      console.error(`[epic-reviewer] Failed to apply fixes to ${ticket.identifier}: ${err.message}`);
      // Fallback: post the feedback as a comment
      const fb = result.ticketFeedback.find(f => f.issueId === ticketId);
      if (fb) {
        await postComment(
          ticket.id,
          null,
          `**Epic Review (Run 1/2): Could not auto-fix**\n\n${fb.comment}\n\n_Error: ${err.message}_`
        );
      }
    }
  }

  // For tickets with feedback but no FILE: blocks, post comments
  for (const fb of result.ticketFeedback) {
    if (!ticketFixMap[fb.issueId]) {
      await postComment(
        fb.issueId,
        null,
        `**Epic Review (Run 1/2): Manual fix needed**\n\n${fb.comment}`
      );
    }
  }

  console.log(`[epic-reviewer] Run 1 complete — fixed ${fixedCount} files across ${Object.keys(ticketFixMap).length} tickets`);
}

/**
 * Parse TICKET: + FILE: blocks from LLM response, group by ticket.
 * Returns a map of ticketId -> combined FILE: content string.
 */
function parseTicketFiles(
  content: string,
  tickets: EpicTicket[]
): Record<string, string> {
  const result: Record<string, string> = {};

  // Split by TICKET: markers
  const ticketBlocks = content.split(/(?=TICKET:\s*[\w-]+)/i);

  for (const block of ticketBlocks) {
    const identifierMatch = block.match(/TICKET:\s*([\w-]+)/i);
    if (!identifierMatch) continue;

    const identifier = identifierMatch[1].trim();
    const ticket = tickets.find(t =>
      t.identifier.toLowerCase() === identifier.toLowerCase()
    );
    if (!ticket) continue;

    // Extract FILE: blocks from this ticket section
    const fileBlocks = block.match(/FILE:\s*[\w./\\-]+\.\w+\s*\n```[^\n]*\n[\s\S]*?```/g);
    if (fileBlocks && fileBlocks.length > 0) {
      result[ticket.id] = fileBlocks.join('\n\n');
    }
  }

  return result;
}

async function appendCommentsAndShip(
  goal: any,
  tickets: EpicTicket[],
  result: EpicReviewResult
): Promise<void> {
  const GH_CLI = 'C:\\Program Files\\GitHub CLI\\gh';
  const opts = { cwd: WORKSPACE, stdio: 'pipe' as const, timeout: 30000 };
  const defaultBranch = getDefaultBranch();

  for (const ticket of tickets) {
    // Build the comment for this ticket
    const ticketFb = result.ticketFeedback.find(fb => fb.issueId === ticket.id);
    const prComment = ticketFb
      ? `**Epic Review (Run 2/2 — Final): Shipping with known issues**\n\n${ticketFb.comment}\n\n_Capped at 2 review runs. Human review recommended for the above._`
      : `**Epic Review (Run 2/2 — Final): No specific issues for this ticket.**\n\n${result.feedback}`;

    // Try to find and comment on the PR
    try {
      const prUrl = execSync(
        `"${GH_CLI}" pr view ${ticket.branchName} --json url --jq ".url"`,
        opts
      ).toString().trim();

      if (prUrl) {
        // Extract PR number from URL
        const prNumber = prUrl.split('/').pop();
        execSync(
          `"${GH_CLI}" pr comment ${prNumber} --body "${prComment.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
          opts
        );
        console.log(`[epic-reviewer] Commented on PR ${prNumber} for ${ticket.identifier}`);
      }
    } catch (err: any) {
      console.log(`[epic-reviewer] Could not comment on PR for ${ticket.identifier}: ${err.message}`);
      // Fallback: post on the Paperclip issue
      await postComment(ticket.id, null, prComment);
    }
  }

  console.log(`[epic-reviewer] Run 2 complete — comments appended to PRs, epic "${goal.title}" shipped`);
}
