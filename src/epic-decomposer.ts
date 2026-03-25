/**
 * Epic Decomposer — Breaks down goals/epics into sub-tickets.
 *
 * When a goal with level "team" or "company" is detected as active,
 * the decomposer uses the Strategist LLM to break it into individual
 * issues that can flow through the normal ClosedLoop pipeline.
 *
 * Each sub-issue gets:
 * - goalId linked to the parent epic
 * - Assigned to Complexity Router for classification
 * - Natural language description (Scaffold Architect handles structured extraction)
 */

import { getOllamaPorts, getPaperclipApiUrl, getCompanyId, getAgentModel, loadConfig } from './config';
import { AGENTS } from './agent-types';
import * as fs from 'fs';
import * as path from 'path';

const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const { ollamaPort } = getOllamaPorts();

// Track which goals have been decomposed to avoid re-processing
const decomposedGoals = new Set<string>();

interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
  parentId: string | null;
  ownerAgentId: string | null;
}

interface SubTicket {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
}

/**
 * Check for active goals that need decomposition.
 * Called periodically by the background checker.
 */
export async function checkGoalsForDecomposition(): Promise<void> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/goals`);
    if (!res.ok) return;

    const goals = await res.json() as Goal[];
    const activeEpics = goals.filter(g =>
      g.status === 'active' &&
      (g.level === 'team' || g.level === 'company') &&
      !decomposedGoals.has(g.id)
    );

    for (const epic of activeEpics) {
      console.log(`[epic-decomposer] Found active epic: "${epic.title}" (${epic.id.slice(0, 8)})`);

      // Check if this epic already has linked issues
      const existingIssues = await getIssuesForGoal(epic.id);
      if (existingIssues.length > 0) {
        console.log(`[epic-decomposer] Epic already has ${existingIssues.length} issues — skipping`);
        decomposedGoals.add(epic.id);
        continue;
      }

      // Mark BEFORE async decomposition to prevent race condition
      // (next interval fires before decomposition completes → duplicate tickets)
      decomposedGoals.add(epic.id);
      await decomposeEpic(epic);
    }
  } catch (err: any) {
    // Silent fail — will retry next cycle
  }
}

/**
 * Decompose an epic into sub-tickets using the Strategist LLM.
 */
async function decomposeEpic(epic: Goal): Promise<void> {
  console.log(`[epic-decomposer] Decomposing: "${epic.title}"`);

  const systemPrompt = loadDecomposerPrompt();
  const userPrompt = `Epic: ${epic.title}\n\nDescription:\n${epic.description || '(no description provided)'}\n\nDecompose this epic into individual implementation tickets.`;

  const model = getAgentModel('strategist') || 'qwen3:8b';

  try {
    const timeoutSec = loadConfig().ollama.timeouts?.strategist || 900;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

    const ollamaRes = await fetch(`http://127.0.0.1:${ollamaPort}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    const data = await ollamaRes.json() as any;
    clearTimeout(timeoutId);

    const content = data.message?.content || data.response || '';
    console.log(`[epic-decomposer] LLM response: ${content.length} chars`);

    // Parse sub-tickets from response
    const tickets = parseSubTickets(content);

    if (tickets.length === 0) {
      console.log(`[epic-decomposer] No tickets parsed from response`);
      return;
    }

    console.log(`[epic-decomposer] Parsed ${tickets.length} sub-tickets`);

    // Create issues in Paperclip, linked to the epic
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      try {
        const issueRes = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: ticket.title,
            description: ticket.description,
            status: 'todo',
            priority: ticket.priority,
            goalId: epic.id,
            assigneeAgentId: AGENTS['complexity router'],
          }),
        });

        if (issueRes.ok) {
          const issue = await issueRes.json() as any;
          console.log(`[epic-decomposer] Created ${issue.identifier}: ${ticket.title}`);
        } else {
          console.error(`[epic-decomposer] Failed to create ticket "${ticket.title}": ${issueRes.status}`);
        }

        // Small delay to avoid overwhelming the API
        await new Promise(r => setTimeout(r, 500));
      } catch (err: any) {
        console.error(`[epic-decomposer] Error creating ticket: ${err.message}`);
      }
    }

    // Mark epic as achieved once all tickets are created
    try {
      await fetch(`${PAPERCLIP_API}/api/goals/${epic.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'achieved' }),
      });
      console.log(`[epic-decomposer] Epic "${epic.title}" decomposed into ${tickets.length} tickets`);
    } catch {}

  } catch (err: any) {
    console.error(`[epic-decomposer] Decomposition failed: ${err.message}`);
  }
}

/**
 * Parse TICKET: blocks from LLM response.
 */
// Titles that are clearly meta-commentary, not implementation tickets
const JUNK_TITLE_PATTERNS = [
  /^summary/i, /^overview/i, /^introduction/i, /^conclusion/i,
  /^key decisions/i, /^rationale/i, /^how to use/i, /^potential risks/i,
  /^notes?$/i, /^mitigations?/i, /^dependencies/i, /^assumptions/i,
  /^implementation plan/i, /^decomposition/i, /^epic breakdown/i,
];

function isJunkTitle(title: string): boolean {
  return JUNK_TITLE_PATTERNS.some(p => p.test(title.replace(/\*+/g, '').trim()));
}

export function parseSubTickets(content: string): SubTicket[] {
  const tickets: SubTicket[] = [];

  // Parse TICKET: blocks
  const ticketRegex = /TICKET:\s*\n([\s\S]*?)(?=\nTICKET:|$)/g;
  let match;

  while ((match = ticketRegex.exec(content)) !== null) {
    const block = match[1].trim();
    const titleMatch = block.match(/Title:\s*(.+)/i);
    const descMatch = block.match(/Description:\s*([\s\S]*?)(?=\nPriority:|$)/i);
    const priorityMatch = block.match(/Priority:\s*(low|medium|high|urgent)/i);

    if (titleMatch && !isJunkTitle(titleMatch[1])) {
      tickets.push({
        title: titleMatch[1].trim(),
        description: descMatch ? descMatch[1].trim() : block,
        priority: (priorityMatch ? priorityMatch[1].toLowerCase() : 'medium') as any,
      });
    }
  }

  // Fallback: try numbered list format (1. Title\nDescription...)
  if (tickets.length === 0) {
    const numberedRegex = /(?:^|\n)\d+\.\s+\*\*(.+?)\*\*\s*\n([\s\S]*?)(?=\n\d+\.\s+\*\*|$)/g;
    while ((match = numberedRegex.exec(content)) !== null) {
      const title = match[1].trim();
      if (!isJunkTitle(title)) {
        tickets.push({ title, description: match[2].trim(), priority: 'medium' });
      }
    }
  }

  // Fallback: try ## heading format
  if (tickets.length === 0) {
    const headingRegex = /##\s+(?:Ticket\s+\d+[:\s]*)?(.+)\n([\s\S]*?)(?=\n##|$)/g;
    while ((match = headingRegex.exec(content)) !== null) {
      const title = match[1].trim();
      if (!isJunkTitle(title)) {
        tickets.push({ title, description: match[2].trim(), priority: 'medium' });
      }
    }
  }

  return tickets;
}

/**
 * Get issues linked to a goal.
 */
async function getIssuesForGoal(goalId: string): Promise<any[]> {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (!res.ok) return [];

    const data = await res.json() as any;
    const issues = Array.isArray(data) ? data : data.issues || data.data || [];
    return issues.filter((i: any) => i.goalId === goalId && i.status !== 'cancelled');
  } catch {
    return [];
  }
}

/**
 * Load the decomposer prompt.
 */
function loadDecomposerPrompt(): string {
  try {
    const promptPath = path.join(__dirname, '..', 'prompts', 'epic-decomposer.txt');
    return fs.readFileSync(promptPath, 'utf8');
  } catch {
    return DEFAULT_DECOMPOSER_PROMPT;
  }
}

const DEFAULT_DECOMPOSER_PROMPT = `You are the Epic Decomposer. Your job is to break down a high-level epic into individual implementation tickets.

Each ticket should be:
- Self-contained and independently implementable
- Written in natural language (not structured scaffold format)
- Focused on one service/entity/feature
- Clear about what fields, constraints, and relationships are needed

Output each ticket using this format:

TICKET:
Title: <short title for the ticket>
Description: <natural language description including all fields, types, constraints, relationships>
Priority: <low|medium|high|urgent>

Example output:

TICKET:
Title: Build a CRUD API for Payment Types
Description: Create a new service for managing payment types in the POS system. Each payment type has a name (required, text), whether it is active (required, boolean as integer 0/1), and a sort order (optional, integer). This needs full CRUD: list, get by ID, create, update, delete.
Priority: medium

TICKET:
Title: Build a CRUD API for Payments
Description: Create a service for recording payments against orders. Each payment tracks the order it belongs to (orderId, required, references orders), the payment type used (paymentTypeId, required, references payment types), the amount paid (required, decimal), change given back (optional, decimal), and optional notes. Needs full CRUD.
Priority: medium

RULES:
- Write tickets in plain English — the Scaffold Architect will extract structured configs
- Include ALL field details: name, whether required/optional, data type, enums, foreign keys
- Order tickets by dependency (independent ones first)
- Each CRUD API is ONE ticket
- Non-CRUD work (UI, integrations, migrations) gets separate tickets
- Keep titles under 60 characters`;
