import { describe, it, expect } from 'vitest';
import {
  parseTicketSpec,
  parseBuildManifest,
  parseReviewVerdict,
  parseDiffVerdict,
  formatTicketSpecForTechLead,
  formatBuildManifestForBuilder,
} from './agent-contracts';

describe('parseTicketSpec', () => {
  it('parses valid JSON from fenced code block', () => {
    const content = `Here is the ticket:
\`\`\`json
{
  "title": "Add payment types CRUD",
  "objective": "Create a full CRUD API for payment types",
  "files": ["api/src/services/payment-types/payment-types.routes.ts"],
  "acceptanceCriteria": ["Build passes", "GET /payment-types returns 200"],
  "dependencies": [],
  "complexity": "low"
}
\`\`\``;
    const spec = parseTicketSpec(content);
    expect(spec).not.toBeNull();
    expect(spec!.title).toBe('Add payment types CRUD');
    expect(spec!.files).toHaveLength(1);
    expect(spec!.complexity).toBe('low');
  });

  it('parses inline JSON object', () => {
    const content = '{"title":"Fix login","objective":"Fix broken login","files":[],"acceptanceCriteria":["Build passes"],"dependencies":[],"complexity":"low"}';
    const spec = parseTicketSpec(content);
    expect(spec).not.toBeNull();
    expect(spec!.title).toBe('Fix login');
  });

  it('returns null for freeform text with no JSON', () => {
    const content = 'Please implement the payment types CRUD. Create routes and service files.';
    expect(parseTicketSpec(content)).toBeNull();
  });

  it('defaults complexity to medium if invalid', () => {
    const content = '```json\n{"title":"Test","objective":"Test obj","complexity":"extreme"}\n```';
    const spec = parseTicketSpec(content);
    expect(spec!.complexity).toBe('medium');
  });

  it('handles missing arrays gracefully', () => {
    const content = '```json\n{"title":"Test","objective":"Test obj"}\n```';
    const spec = parseTicketSpec(content);
    expect(spec!.files).toEqual([]);
    expect(spec!.acceptanceCriteria).toEqual([]);
    expect(spec!.dependencies).toEqual([]);
  });
});

describe('parseBuildManifest', () => {
  it('parses a valid build manifest', () => {
    const content = `\`\`\`json
{
  "createFiles": [{"path": "api/src/services/items/items.routes.ts", "purpose": "CRUD routes"}],
  "modifyFiles": [{"path": "api/src/index.ts", "action": "register items router"}],
  "importRules": ["Use bare module paths for shared types"],
  "buildCommand": "yarn build",
  "constraints": ["Do not modify existing routes"]
}
\`\`\``;
    const manifest = parseBuildManifest(content);
    expect(manifest).not.toBeNull();
    expect(manifest!.createFiles).toHaveLength(1);
    expect(manifest!.modifyFiles).toHaveLength(1);
    expect(manifest!.buildCommand).toBe('yarn build');
  });

  it('returns null for content without manifest fields', () => {
    const content = '```json\n{"title":"not a manifest"}\n```';
    expect(parseBuildManifest(content)).toBeNull();
  });
});

describe('parseReviewVerdict', () => {
  it('parses structured JSON verdict', () => {
    const content = `\`\`\`json
{
  "decision": "rejected",
  "issues": [{"file": "api/src/index.ts", "line": 15, "severity": "error", "message": "Missing import"}],
  "buildPassed": false,
  "summary": "Build fails due to missing import"
}
\`\`\``;
    const verdict = parseReviewVerdict(content);
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('rejected');
    expect(verdict!.issues).toHaveLength(1);
    expect(verdict!.issues[0].severity).toBe('error');
  });

  it('falls back to keyword detection for freeform approval', () => {
    const content = 'Code looks good. LGTM — ready for PR.';
    const verdict = parseReviewVerdict(content);
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('approved');
  });

  it('falls back to keyword detection for freeform rejection', () => {
    const content = 'REJECTED: Build fails with missing module error.';
    const verdict = parseReviewVerdict(content);
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('rejected');
  });

  it('returns null for ambiguous content', () => {
    const content = 'The code needs some more work but I am not sure.';
    expect(parseReviewVerdict(content)).toBeNull();
  });
});

describe('parseDiffVerdict', () => {
  it('parses structured JSON verdict', () => {
    const content = `\`\`\`json
{
  "decision": "approved",
  "checks": [{"name": "no parallel files", "passed": true}, {"name": "deletion ratio", "passed": true}],
  "violations": [],
  "summary": "All checks pass"
}
\`\`\``;
    const verdict = parseDiffVerdict(content);
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('approved');
    expect(verdict!.checks).toHaveLength(2);
  });

  it('falls back to DIFF_APPROVED keyword', () => {
    const content = 'All checks pass.\n\nDIFF_APPROVED';
    const verdict = parseDiffVerdict(content);
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('approved');
  });

  it('falls back to DIFF_REJECTED keyword', () => {
    const content = 'Found parallel files.\n\nDIFF_REJECTED';
    const verdict = parseDiffVerdict(content);
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('rejected');
  });
});

describe('formatTicketSpecForTechLead', () => {
  it('formats spec with all fields', () => {
    const formatted = formatTicketSpecForTechLead({
      title: 'Add items CRUD',
      objective: 'Create CRUD API for items',
      files: ['api/src/services/items/items.routes.ts'],
      acceptanceCriteria: ['Build passes', 'GET /items returns 200'],
      dependencies: ['Add database migration'],
      complexity: 'medium',
    });
    expect(formatted).toContain('Add items CRUD');
    expect(formatted).toContain('medium');
    expect(formatted).toContain('Build passes');
    expect(formatted).toContain('Add database migration');
  });
});

describe('formatBuildManifestForBuilder', () => {
  it('formats manifest with create and modify sections', () => {
    const formatted = formatBuildManifestForBuilder({
      createFiles: [{ path: 'api/src/services/items/items.routes.ts', purpose: 'CRUD routes', pattern: 'orders.routes.ts' }],
      modifyFiles: [{ path: 'api/src/index.ts', action: 'register items router' }],
      importRules: ['Use bare module paths'],
      buildCommand: 'yarn build',
      constraints: ['Do not remove existing routes'],
    });
    expect(formatted).toContain('CREATE: api/src/services/items/items.routes.ts');
    expect(formatted).toContain('MODIFY: api/src/index.ts');
    expect(formatted).toContain('follow orders.routes.ts');
    expect(formatted).toContain('yarn build');
  });
});
