/**
 * Agent IDs, names, and delegation rules
 */

import { getAgents, getBlockedAgents, getDelegationRules } from './config';

// Agent ID constants
export const AGENTS = getAgents();

// Reverse lookup: ID -> name
export const AGENT_NAMES: Record<string, string> = {};
for (const [name, id] of Object.entries(AGENTS)) {
  AGENT_NAMES[id] = name;
}

// Blocked agents set
export const BLOCKED_AGENTS = new Set(getBlockedAgents());

// Delegation rules (org chart)
export const DELEGATION_RULES: Record<string, string[]> = {};
const rawRules = getDelegationRules();
for (const [role, targets] of Object.entries(rawRules)) {
  const agentId = AGENTS[role] || role;
  DELEGATION_RULES[agentId] = targets.map((t) => AGENTS[t] || t);
}

// Agent aliases for delegation detection (lowercase -> ID)
export const AGENT_ALIASES: Record<string, string> = {
  'tech lead': AGENTS['tech lead'],
  'tech lead (engineering)': AGENTS['tech lead'],
  'local builder': AGENTS['local builder'],
  'local builder (engineer)': AGENTS['local builder'],
  reviewer: AGENTS.reviewer,
  'diff guardian': AGENTS['diff guardian'],
  'visual reviewer': AGENTS['visual reviewer'],
  'visual reviewer (ui/ux)': AGENTS['visual reviewer'],
  sentinel: AGENTS.sentinel,
  deployer: AGENTS.deployer,
  'coder remote': AGENTS['coder remote'],
  'remote coder': AGENTS['coder remote'],
  'coder remote (engineer)': AGENTS['coder remote'],
  // Keep backward compat for prompts that still say "artist"
  artist: AGENTS['visual reviewer'],
  'artist (ui/ux)': AGENTS['visual reviewer'],
  // Complexity Router targets
  strategist: AGENTS.strategist,
  'epic decoder': AGENTS['epic decoder'],
};

// Bash execution is disabled for bridge-side agents.
// The local build gate is removed, so agents should not run shell commands here.
export const BASH_AGENTS = new Set<string>();

// Dangerous command patterns to block
export const BLOCKED_COMMANDS = [
  /rm\s+-rf\s+\//i,
  /del\s+\/s/i,
  /\btaskkill\b/i,
  /\bstop-process\b/i,
  /\bkillall\b/i,
  /\bpkill\b/i,
  /\bkill\b.+\bnode(?:\.exe)?\b/i,
  /\bget-process\b.+\bnode(?:\.exe)?\b/i,
  /format\s+[a-z]:/i,
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\/sd/i,
  /shutdown/i,
  /reboot/i,
];

// Delegation cooldown (5 minutes)
export const DELEGATION_COOLDOWN_MS = 5 * 60 * 1000;

// Track recent delegations to prevent duplicates
export const recentDelegations: Record<string, number> = {};

// Track how many times Local Builder has run on an issue
export const issueBuilderPasses: Record<string, number> = {};

// Track per-issue import validation failures
export const issueImportFailures: Record<string, number> = {};

// Lock per issue to prevent concurrent Local Builder processing
export const issueProcessingLock: Record<string, boolean> = {};

// Lock per issue to prevent concurrent Artist/Visual Reviewer processing
export const artistProcessingLock: Record<string, boolean> = {};

// Track issues flagged for remote model override (flows through delegation chain)
export const issueRemoteFlags = new Map<string, string>();

// Track per-issue builder model overrides (consumed when delegation reaches Local Builder)
export const issueBuilderModelOverrides = new Map<string, string>();

// Track issues in burst mode (greenfield scaffolds get larger model)
export const issueBuilderBurstMode = new Set<string>();

// Goal/Epic tracking — Paperclip has flat schema, so we track parent-child here
export const goalTicketMap: Record<string, string[]> = {};   // goalIssueId -> [ticketIssueId, ...]
export const ticketGoalMap: Record<string, string> = {};     // ticketIssueId -> goalIssueId
export const issueComplexityCache: Record<string, { score: number; signals: string[] }> = {};
export const remoteArchitectCalled: Record<string, { calledAt: number; specRelPath: string }> = {};
