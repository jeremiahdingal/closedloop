/**
 * Structured JSON schemas for inter-agent communication.
 *
 * Small local models struggle with freeform instructions.
 * Typed contracts reduce misinterpretation and review loop iterations.
 *
 * Flow: Strategist → TicketSpec → Tech Lead → BuildManifest → Local Builder
 *       → ReviewVerdict (Reviewer) → DiffVerdict (Diff Guardian)
 */

// ─── Strategist → Tech Lead ──────────────────────────────────────

export interface TicketSpec {
  /** Short title for the ticket */
  title: string;
  /** One sentence: what "done" looks like */
  objective: string;
  /** Exact file paths to create or modify */
  files: string[];
  /** Acceptance criteria as concrete checks */
  acceptanceCriteria: string[];
  /** Other ticket titles this depends on */
  dependencies: string[];
  /** Complexity estimate: 'low' | 'medium' | 'high' */
  complexity: 'low' | 'medium' | 'high';
}

// ─── Tech Lead → Local Builder ───────────────────────────────────

export interface BuildManifest {
  /** Files to create (new) */
  createFiles: Array<{
    path: string;
    purpose: string;
    pattern?: string; // e.g. "follow orders.routes.ts"
  }>;
  /** Files to modify (existing) */
  modifyFiles: Array<{
    path: string;
    action: string; // e.g. "add import + register route"
  }>;
  /** Import rules to follow */
  importRules: string[];
  /** Build command to verify */
  buildCommand: string;
  /** Key constraints */
  constraints: string[];
}

// ─── Reviewer → (Local Builder or Diff Guardian) ─────────────────

export interface ReviewVerdict {
  /** 'approved' or 'rejected' */
  decision: 'approved' | 'rejected';
  /** File-level issues found */
  issues: Array<{
    file: string;
    line?: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
  }>;
  /** Build passed? */
  buildPassed: boolean;
  /** Summary for the audit trail */
  summary: string;
}

// ─── Diff Guardian → (Visual Reviewer or Local Builder) ──────────

export interface DiffVerdict {
  /** 'approved' or 'rejected' */
  decision: 'approved' | 'rejected';
  /** Checklist results */
  checks: Array<{
    name: string;
    passed: boolean;
    detail?: string;
  }>;
  /** Files with policy violations */
  violations: Array<{
    file: string;
    rule: string;
    message: string;
  }>;
  /** Summary for the audit trail */
  summary: string;
}

// ─── Parsers: extract structured JSON from LLM freeform output ───

/**
 * Try to extract a JSON block from LLM output.
 * Models often wrap JSON in ```json ... ``` or produce it inline.
 */
function extractJsonBlock(content: string): string | null {
  // Try fenced code block first
  const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // Try raw JSON object
  const rawObj = content.match(/(\{[\s\S]*\})/);
  if (rawObj) {
    try {
      JSON.parse(rawObj[1]);
      return rawObj[1];
    } catch { /* not valid JSON */ }
  }

  return null;
}

/**
 * Parse a TicketSpec from Strategist output.
 * Falls back to extracting from freeform text if JSON parsing fails.
 */
export function parseTicketSpec(content: string): TicketSpec | null {
  const json = extractJsonBlock(content);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed.title && parsed.objective) {
        return {
          title: String(parsed.title),
          objective: String(parsed.objective),
          files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
          acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria.map(String) : [],
          dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String) : [],
          complexity: ['low', 'medium', 'high'].includes(parsed.complexity) ? parsed.complexity : 'medium',
        };
      }
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Parse a BuildManifest from Tech Lead output.
 */
export function parseBuildManifest(content: string): BuildManifest | null {
  const json = extractJsonBlock(content);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed.createFiles || parsed.modifyFiles) {
        return {
          createFiles: Array.isArray(parsed.createFiles) ? parsed.createFiles : [],
          modifyFiles: Array.isArray(parsed.modifyFiles) ? parsed.modifyFiles : [],
          importRules: Array.isArray(parsed.importRules) ? parsed.importRules.map(String) : [],
          buildCommand: String(parsed.buildCommand || 'yarn build'),
          constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : [],
        };
      }
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Parse a ReviewVerdict from Reviewer output.
 */
export function parseReviewVerdict(content: string): ReviewVerdict | null {
  const json = extractJsonBlock(content);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed.decision) {
        return {
          decision: parsed.decision === 'approved' ? 'approved' : 'rejected',
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
          buildPassed: Boolean(parsed.buildPassed),
          summary: String(parsed.summary || ''),
        };
      }
    } catch { /* fall through */ }
  }

  // Fallback: detect decision from keywords in freeform text
  const lower = content.toLowerCase();
  const approved = /\bapproved\b|\blgtm\b|\blooks good\b|\bno issues\b|\bready for pr\b/.test(lower);
  if (approved || /\brejected\b/.test(lower)) {
    return {
      decision: approved ? 'approved' : 'rejected',
      issues: [],
      buildPassed: !lower.includes('build fail'),
      summary: content.substring(0, 500),
    };
  }

  return null;
}

/**
 * Parse a DiffVerdict from Diff Guardian output.
 */
export function parseDiffVerdict(content: string): DiffVerdict | null {
  const json = extractJsonBlock(content);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed.decision) {
        return {
          decision: parsed.decision === 'approved' ? 'approved' : 'rejected',
          checks: Array.isArray(parsed.checks) ? parsed.checks : [],
          violations: Array.isArray(parsed.violations) ? parsed.violations : [],
          summary: String(parsed.summary || ''),
        };
      }
    } catch { /* fall through */ }
  }

  // Fallback: detect from keywords
  const lower = content.toLowerCase();
  const approved = /\bdiff_approved\b/.test(lower);
  const rejected = /\bdiff_rejected\b/.test(lower);
  if (approved || rejected) {
    return {
      decision: approved ? 'approved' : 'rejected',
      checks: [],
      violations: [],
      summary: content.substring(0, 500),
    };
  }

  return null;
}

/**
 * Format a TicketSpec as a prompt section for the Tech Lead.
 */
export function formatTicketSpecForTechLead(spec: TicketSpec): string {
  return `## Structured Ticket Spec (JSON)
\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

**Title:** ${spec.title}
**Objective:** ${spec.objective}
**Complexity:** ${spec.complexity}
**Files:** ${spec.files.join(', ') || '(to be determined)'}
**Acceptance Criteria:**
${spec.acceptanceCriteria.map(c => `- [ ] ${c}`).join('\n') || '- [ ] Build passes'}
${spec.dependencies.length > 0 ? `**Dependencies:** ${spec.dependencies.join(', ')}` : ''}`;
}

/**
 * Format a BuildManifest as a prompt section for the Local Builder.
 */
export function formatBuildManifestForBuilder(manifest: BuildManifest): string {
  const creates = manifest.createFiles.map(f =>
    `  - CREATE: ${f.path} — ${f.purpose}${f.pattern ? ` (follow ${f.pattern})` : ''}`
  ).join('\n');
  const modifies = manifest.modifyFiles.map(f =>
    `  - MODIFY: ${f.path} — ${f.action}`
  ).join('\n');

  return `## Build Manifest (from Tech Lead)
${creates ? `\n**New files:**\n${creates}` : ''}
${modifies ? `\n**Modify existing:**\n${modifies}` : ''}
${manifest.importRules.length > 0 ? `\n**Import rules:**\n${manifest.importRules.map(r => `  - ${r}`).join('\n')}` : ''}
${manifest.constraints.length > 0 ? `\n**Constraints:**\n${manifest.constraints.map(c => `  - ${c}`).join('\n')}` : ''}
**Build command:** ${manifest.buildCommand}`;
}
