/**
 * Epic Reviewer Agent — Cross-epic review and automated fixing
 *
 * Processes ALL epics at once to save context.
 * Uses GLM-5 via callZAI to review all tickets across all epics.
 * Actually fixes code, builds, and commits to PR branches.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getCompanyId, getPaperclipApiUrl } from './config';
import { getIssueDetails, postComment, patchIssue } from './paperclip-api';
import { callZAI } from './remote-ai';
import { getEpicTickets } from './goal-system';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const WORKSPACE = getWorkspace();

interface EpicTicket {
  id: string;
  identifier: string;
  title: string;
  status: string;
  goalId: string;
}

interface EpicWithTickets {
  goal: any;
  tickets: EpicTicket[];
}

interface FileFix {
  ticketId: string;
  ticketIdentifier: string;
  filePath: string;
  content: string;
}

interface ReviewResult {
  approved: boolean;
  fixes: FileFix[];
  summary: string;
}

/**
 * Collect all active epics with their tickets
 */
async function collectAllEpics(): Promise<EpicWithTickets[]> {
  const goalsRes = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/goals`);
  if (!goalsRes.ok) return [];

  const goals = await goalsRes.json() as any[];
  const activeGoals = goals.filter(g => g.status === 'active');

  const epics: EpicWithTickets[] = [];
  for (const goal of activeGoals) {
    const tickets = await getEpicTickets(goal.id);
    if (tickets.length === 0) continue;

    // Check if ALL tickets are in_review or done
    const allReady = tickets.every(t => t.status === 'in_review' || t.status === 'done');
    if (!allReady) continue;

    epics.push({ goal, tickets });
  }

  return epics;
}

/**
 * Get git diff for a ticket's branch
 */
async function getTicketDiff(ticket: EpicTicket): Promise<string> {
  try {
    const { execSync } = await import('child_process');
    
    // Build expected branch name pattern from ticket identifier
    const ticketNum = ticket.identifier.replace('SHO-', '');
    const branchPattern = `sho-${ticketNum}--`;
    
    // Find the actual branch name from local branches
    const branches = execSync(`git branch`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 10000,
    }).toString();
    
    const branch = branches.split('\n').find(b => b.includes(branchPattern))?.trim().replace('*', '').trim();
    if (!branch) {
      console.log(`[epic-reviewer-agent] No branch found for ${ticket.identifier}`);
      return '';
    }
    
    const diff = execSync(`git diff main...${branch} -- . ":(exclude)docs/screenshots"`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    }).toString();
    
    return diff;
  } catch (err: any) {
    console.log(`[epic-reviewer-agent] Could not get diff for ${ticket.identifier}: ${err.message}`);
    return '';
  }
}

/**
 * Build the review prompt for all epics
 */
async function buildReviewPrompt(epics: EpicWithTickets[]): Promise<string> {
  let prompt = '## Project Conventions\n\n';

  try {
    const projectStructure = fs.readFileSync(path.join(WORKSPACE, 'PROJECT_STRUCTURE.md'), 'utf8');
    // Include more project structure context (8000 chars instead of 4000)
    // This helps GLM-5 understand project patterns, tech stack, and conventions
    prompt += projectStructure.substring(0, 8000);
    if (projectStructure.length > 8000) prompt += '\n... (truncated)';
  } catch {}

  prompt += '\n\n## Epics to Review\n\n';
  prompt += `Reviewing ${epics.length} epics with ${epics.reduce((sum, e) => sum + e.tickets.length, 0)} total tickets.\n\n`;

  for (const epic of epics) {
    prompt += `### Epic: ${epic.goal.title}\n`;
    if (epic.goal.description) {
      prompt += `${epic.goal.description.substring(0, 1000)}\n`;
    }
    prompt += '\n';

    for (const ticket of epic.tickets) {
      prompt += `#### ${ticket.identifier}: ${ticket.title}\n`;
      prompt += `Status: ${ticket.status}\n\n`;
    }
    prompt += '\n';
  }

  prompt += '## Ticket Diffs\n\n';
  let totalDiffChars = 0;
  const MAX_DIFF_CHARS = 100000; // Limit total diff size to 100KB
  
  for (const epic of epics) {
    for (const ticket of epic.tickets) {
      if (totalDiffChars >= MAX_DIFF_CHARS) {
        prompt += '\n... (diffs truncated due to size limit)\n';
        break;
      }
      
      const diff = await getTicketDiff(ticket);
      if (diff) {
        const truncatedDiff = diff.substring(0, 20000); // Max 20KB per ticket
        prompt += `### ${ticket.identifier}: ${ticket.title}\n`;
        prompt += `\`\`\`diff\n${truncatedDiff}\n\`\`\`\n\n`;
        totalDiffChars += truncatedDiff.length;
      }
    }
    if (totalDiffChars >= MAX_DIFF_CHARS) break;
  }

  return prompt;
}

/**
 * Build system prompt for the reviewer
 */
function buildSystemPrompt(): string {
  return `You are a senior staff engineer reviewing multiple epics before they ship to production.

You are reviewing the COMBINED output of multiple tickets across multiple epics.
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

SUMMARY:
(brief explanation of what was wrong and what you fixed)

IMPORTANT:
- Output the FULL corrected file content, not just the diff or snippet
- Tag each FILE: block to the TICKET it belongs to
- Only fix real bugs and integration issues, not style preferences
- If a file is fine, don't include it — only output files that need changes`;
}

/**
 * Parse the LLM response to extract fixes
 */
function parseReviewResult(content: string): ReviewResult {
  const fixes: FileFix[] = [];
  const approved = content.includes('VERDICT: APPROVED');

  // Extract TICKET/FILE blocks
  const ticketFileRegex = /TICKET:\s*(SHO-\d+)\s*\nFILE:\s*([^\n]+)\s*\n\`\`\`\w*\n([\s\S]*?)\n\`\`\`/g;
  let match: RegExpExecArray | null;

  while ((match = ticketFileRegex.exec(content)) !== null) {
    const [, ticketIdentifier, filePath, fileContent] = match;
    fixes.push({
      ticketId: '',
      ticketIdentifier,
      filePath: filePath.trim(),
      content: fileContent.trim(),
    });
  }

  // Extract summary
  const summaryMatch = content.match(/SUMMARY:\s*([\s\S]+)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  return { approved, fixes, summary };
}

/**
 * Apply fixes to files and commit to branches
 */
async function applyFixes(epics: EpicWithTickets[], fixes: FileFix[]): Promise<void> {
  const { execSync } = await import('child_process');

  // Group fixes by ticket
  const fixesByTicket = new Map<string, FileFix[]>();
  for (const fix of fixes) {
    if (!fixesByTicket.has(fix.ticketIdentifier)) {
      fixesByTicket.set(fix.ticketIdentifier, []);
    }
    fixesByTicket.get(fix.ticketIdentifier)!.push(fix);
  }

  for (const [ticketIdentifier, ticketFixes] of fixesByTicket) {
    // Find the ticket
    let ticket: EpicTicket | undefined;
    for (const epic of epics) {
      ticket = epic.tickets.find(t => t.identifier === ticketIdentifier);
      if (ticket) break;
    }

    if (!ticket) {
      console.log(`[epic-reviewer-agent] Ticket ${ticketIdentifier} not found, skipping fixes`);
      continue;
    }

    // Get branch name - find actual branch from git
    const ticketNum = ticketIdentifier.replace('SHO-', '');
    const branchPattern = `sho-${ticketNum}--`;
    const { execSync } = await import('child_process');
    
    let branchName = '';
    try {
      const branches = execSync(`git branch`, {
        cwd: WORKSPACE,
        encoding: 'utf8',
        timeout: 10000,
      }).toString();
      branchName = branches.split('\n').find(b => b.includes(branchPattern))?.trim().replace('*', '').trim() || '';
    } catch {}

    if (!branchName) {
      console.log(`[epic-reviewer-agent] No branch found for ${ticketIdentifier}, skipping fixes`);
      continue;
    }

    try {
      // Checkout branch
      execSync(`git checkout ${branchName}`, {
        cwd: WORKSPACE,
        stdio: 'pipe',
        timeout: 10000,
      });

      // Apply fixes
      for (const fix of ticketFixes) {
        const fullPath = path.join(WORKSPACE, fix.filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, fix.content, 'utf8');
        console.log(`[epic-reviewer-agent] Wrote ${fix.filePath} for ${ticketIdentifier}`);
      }

      // Try to build
      console.log(`[epic-reviewer-agent] Building ${ticketIdentifier}...`);
      let buildFailed = false;
      try {
        execSync('yarn turbo run build --filter=@shop-diary/ui --filter=@shop-diary/app', {
          cwd: WORKSPACE,
          stdio: 'pipe',
          timeout: 180000,
        });
        console.log(`[epic-reviewer-agent] Build PASSED for ${ticketIdentifier}`);
      } catch (buildErr: any) {
        console.log(`[epic-reviewer-agent] Build FAILED for ${ticketIdentifier}: ${buildErr.message}`);
        buildFailed = true;
        // Continue anyway - commit the fixes
      }

      // Commit and push
      const commitMsg = `${ticketIdentifier}: Epic Reviewer automated fixes`;
      execSync('git add -A', { cwd: WORKSPACE, stdio: 'pipe' });

      try {
        execSync(`git commit -m "${commitMsg}"`, {
          cwd: WORKSPACE,
          stdio: 'pipe',
          timeout: 10000,
        });
        execSync(`git push origin HEAD`, {
          cwd: WORKSPACE,
          stdio: 'pipe',
          timeout: 60000,
        });
        console.log(`[epic-reviewer-agent] Committed and pushed fixes for ${ticketIdentifier}`);

        // Post comment
        await postComment(
          ticket.id,
          null,
          `**Epic Reviewer Automated Fixes**\n\n` +
          `Applied cross-epic consistency fixes:\n` +
          ticketFixes.map(f => `- \`${f.filePath}\``).join('\n') +
          `\n\nBuild: ${buildFailed ? 'FAILED (see output)' : 'PASSED'}\n\n` +
          `These fixes were applied automatically by the Epic Reviewer agent.`
        );
      } catch (commitErr: any) {
        if (!commitErr.message?.includes('nothing to commit')) {
          console.log(`[epic-reviewer-agent] Commit failed for ${ticketIdentifier}: ${commitErr.message}`);
        }
      }

      // Checkout back to main
      execSync('git checkout main', { cwd: WORKSPACE, stdio: 'pipe' });
    } catch (err: any) {
      console.error(`[epic-reviewer-agent] Failed to apply fixes for ${ticketIdentifier}: ${err.message}`);
    }
  }
}

/**
 * Main entry point - review all epics and apply fixes
 */
export async function runEpicReviewerAgent(): Promise<void> {
  console.log('[epic-reviewer-agent] Starting Epic Reviewer Agent');

  // 1. Collect all active epics
  const epics = await collectAllEpics();
  if (epics.length === 0) {
    console.log('[epic-reviewer-agent] No epics ready for review');
    return;
  }

  const totalTickets = epics.reduce((sum, e) => sum + e.tickets.length, 0);
  console.log(`[epic-reviewer-agent] Found ${epics.length} epics with ${totalTickets} tickets ready for review`);

  // 2. Build prompt with all epics
  const prompt = await buildReviewPrompt(epics);
  console.log(`[epic-reviewer-agent] Built prompt (${prompt.length} chars)`);

  // 3. Call GLM-5
  console.log('[epic-reviewer-agent] Sending to GLM-5...');
  let reviewContent: string;
  try {
    reviewContent = await callZAI(prompt, buildSystemPrompt());
  } catch (err: any) {
    console.error(`[epic-reviewer-agent] GLM-5 call failed: ${err.message}`);
    return;
  }

  // 4. Parse result
  const result = parseReviewResult(reviewContent);
  console.log(`[epic-reviewer-agent] Result: ${result.approved ? 'APPROVED' : 'CHANGES_REQUESTED'}`);
  console.log(`[epic-reviewer-agent] Fixes to apply: ${result.fixes.length}`);

  if (result.approved) {
    console.log('[epic-reviewer-agent] All epics approved - no fixes needed');
    // Post approval comment to all tickets
    for (const epic of epics) {
      for (const ticket of epic.tickets) {
        await postComment(
          ticket.id,
          null,
          `**Epic Review: APPROVED** ✅\n\n` +
          `All cross-epic consistency checks passed. Ready to merge.\n\n` +
          `${result.summary}`
        ).catch(() => {});
      }
    }
    return;
  }

  // 5. Apply fixes
  if (result.fixes.length > 0) {
    console.log(`[epic-reviewer-agent] Applying ${result.fixes.length} fixes...`);
    await applyFixes(epics, result.fixes);
    console.log('[epic-reviewer-agent] Fixes applied');
  }

  // 6. Post summary
  for (const epic of epics) {
    await postComment(
      epic.goal.id,
      null,
      `**Epic Review Complete**\n\n` +
      `Reviewed ${epic.tickets.length} tickets.\n\n` +
      `Result: ${result.approved ? 'APPROVED ✅' : 'CHANGES_REQUESTED 🔧'}\n\n` +
      `${result.summary}\n\n` +
      (result.fixes.length > 0 ? `Applied ${result.fixes.length} automated fixes across tickets.` : '')
    ).catch(() => {});
  }

  console.log('[epic-reviewer-agent] Review complete');
}
