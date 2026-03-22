/**
 * Complexity Router — Three-way gate for issue classification.
 *
 * Scores issue complexity (0-10) and provides the Remote Architect call.
 * The actual routing logic lives in proxy-server.ts.
 */

// Remote AI config
const Z_AI_API_KEY = process.env.Z_AI_API_KEY || '';
const Z_AI_API_BASE = process.env.Z_AI_API_BASE || 'https://open.bigmodel.cn/api/paas/v4';
const REMOTE_ARCHITECT_MODEL = process.env.REMOTE_ARCHITECT_MODEL || 'glm-5';

/**
 * Score issue complexity on a 0-10 scale.
 *
 * High scores (>=7) → Remote Architect
 * Low scores (<7) → Local Strategist
 * (Scaffold detection is separate — handled by detectScaffoldConfig)
 */
export function scoreComplexity(title: string, description: string): number {
  const text = (title + '\n' + description).toLowerCase();
  let score = 3; // baseline: assume medium complexity

  // Signals that INCREASE complexity
  const complexSignals: [RegExp, number][] = [
    [/from scratch|greenfield|brand new|whole app/i, 2],
    [/multi[- ]?module|full[- ]?stack|end[- ]?to[- ]?end/i, 2],
    [/architect|system design|infrastructure/i, 2],
    [/build (?:a|an|the) (?:complete|full|entire|whole)/i, 2],
    [/auth(?:entication|orization)|oauth|jwt|session/i, 1],
    [/real[- ]?time|websocket|pub[- ]?sub|streaming/i, 1],
    [/migration|data model redesign|schema overhaul/i, 1],
    [/multiple (?:services|endpoints|apis|modules)/i, 1],
    [/\[goal\]|\[epic\]/i, 2],
  ];

  // Signals that DECREASE complexity
  const simpleSignals: [RegExp, number][] = [
    [/fix|bug|broken|crash|error|typo/i, -2],
    [/update (?:text|label|title|color|style|icon|status|name|description)/i, -1],
    [/change (?:the |a |)(?:text|label|title|color|style|status|name)/i, -1],
    [/add (?:a |)(?:button|field|column|input|link)/i, -1],
    [/rename|move|refactor/i, -1],
    [/cosmetic|spacing|padding|margin|font/i, -1],
    [/crud|simple api|basic endpoint/i, -1],
  ];

  for (const [pattern, delta] of complexSignals) {
    if (pattern.test(text)) score += delta;
  }

  for (const [pattern, delta] of simpleSignals) {
    if (pattern.test(text)) score += delta; // delta is already negative
  }

  // Clamp to 0-10
  return Math.max(0, Math.min(10, score));
}

/**
 * Call GLM-5 Remote Architect via z.ai for architecture specifications.
 * Returns the arch spec content string, or null on failure.
 */
export async function callRemoteArchitect(
  issueId: string,
  title: string,
  description: string
): Promise<string | null> {
  if (!Z_AI_API_KEY) {
    console.log('[remote-architect] Z_AI_API_KEY not set — skipping');
    return null;
  }

  console.log(`[remote-architect] Calling GLM-5 for issue ${issueId.slice(0, 8)}: ${title.slice(0, 50)}`);

  const systemPrompt = `You are a senior software architect specializing in TypeScript monorepos.
You are designing for a cross-platform POS app using:
- Cloudflare Workers + itty-router + Kysely + D1 (SQLite) for API
- React Native + Expo for mobile
- Next.js for web
- Zustand + TanStack React Query for state
- Zod for validation
- ULID for IDs

Produce a detailed architecture specification with:
1. Entity definitions (fields, types, relationships)
2. API endpoints (method, path, request/response)
3. File structure (exact paths)
4. Implementation order (dependencies between components)

Use structured, machine-parseable format with ## Ticket: sections for each sub-task.
Each ticket should have: Objective, Files, Acceptance Criteria, Dependencies.`;

  const userPrompt = `Design the architecture for:\n\n**${title}**\n\n${description}`;

  try {
    const res = await fetch(`${Z_AI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Z_AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: REMOTE_ARCHITECT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    } as any);

    if (!res.ok) {
      console.error(`[remote-architect] z.ai API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    console.log(`[remote-architect] Got ${content.length} chars from GLM-5`);
    return content || null;
  } catch (err: any) {
    console.error(`[remote-architect] Failed: ${err.message}`);
    return null;
  }
}
