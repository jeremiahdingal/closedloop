/**
 * Delegation detection and handling
 */

import { DELEGATION_RULES, AGENT_ALIASES, BLOCKED_AGENTS, recentDelegations, DELEGATION_COOLDOWN_MS } from './agent-types';
import { getPaperclipApiUrl } from './config';
import { AGENTS } from './agent-types';

export interface DelegationTarget {
  name: string;
  id: string;
}

/**
 * Detect delegation in LLM output and reassign the issue.
 * Paperclip auto-wakes the new assignee when assigneeAgentId changes.
 */
export async function detectAndDelegate(
  issueId: string,
  agentId: string,
  content: string
): Promise<void> {
  const allowedTargets = DELEGATION_RULES[agentId];
  if (!allowedTargets) {
    console.log(`[delegation] No delegation rules for agent ${agentId}`);
    return;
  }

  // Strip markdown formatting so **Tech Lead** matches as "tech lead"
  const clean = content.replace(/\*\*/g, '').replace(/_/g, '').toLowerCase();

  // Look for any mention of agent names in the content
  const found: DelegationTarget[] = [];
  for (const [alias, targetId] of Object.entries(AGENT_ALIASES)) {
    if (clean.includes(alias) && allowedTargets.includes(targetId)) {
      if (!BLOCKED_AGENTS.has(targetId)) {
        found.push({ name: alias, id: targetId });
      } else {
        console.log(`[delegation] Skipped delegation to ${alias} (blocked)`);
      }
    }
  }

  console.log(`[delegation] Found ${found.length} targets`, found.map((f) => f.name));

  if (found.length === 0) {
    console.log(`[delegation] No valid delegation targets found in content`);
    console.log(`[delegation] Content preview (first 800 chars):`, content.substring(0, 800).replace(/\n/g, '\\n'));
    return;
  }

  // Delegate to the first valid target (highest priority in org chart)
  const target = found[0];

  // Dedup: skip if we already delegated this issue to this target recently
  const dedupKey = `${issueId}:${target.id}`;
  const lastDelegation = recentDelegations[dedupKey];
  if (lastDelegation && Date.now() - lastDelegation < DELEGATION_COOLDOWN_MS) {
    console.log(`[delegation] Skipped duplicate delegation ${issueId.slice(0, 8)} -> ${target.name} (cooldown)`);
    return;
  }

  // Reassign the issue via Paperclip API -- this triggers auto-wakeup
  try {
    const res = await fetch(`${getPaperclipApiUrl()}/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeAgentId: target.id }),
    });

    if (res.ok) {
      recentDelegations[dedupKey] = Date.now();
      const fromName = getAgentName(agentId);
      console.log(
        `[delegation] DELEGATED issue ${issueId.slice(0, 8)}: ${fromName} -> ${target.name} (auto-wakeup triggered)`
      );
    } else {
      const text = await res.text();
      console.error(`[delegation] Delegation failed: ${res.status} ${text}`);
    }
  } catch (err: any) {
    console.error(`[delegation] Delegation error:`, err.message);
  }
}

function getAgentName(agentId: string): string {
  const names: Record<string, string> = {
    [AGENTS.strategist]: 'Strategist',
    [AGENTS['tech lead']]: 'Tech Lead',
    [AGENTS['local builder']]: 'Local Builder',
    [AGENTS.reviewer]: 'Reviewer',
    [AGENTS.sentinel]: 'Sentinel',
    [AGENTS.deployer]: 'Deployer',
    [AGENTS['visual reviewer']]: 'Visual Reviewer',
    [AGENTS['diff guardian']]: 'Diff Guardian',
    [AGENTS['complexity router']]: 'Complexity Router',
  };
  return names[agentId] || agentId.slice(0, 8);
}
