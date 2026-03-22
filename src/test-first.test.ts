import { describe, it, expect } from 'vitest';
import { parseTestSpecs, parseTestOutput, formatTestResultForPrompt } from './test-first';

describe('parseTestSpecs', () => {
  it('extracts TEST: blocks with code fences', () => {
    const content = `Here are the acceptance tests:

TEST: api/src/services/items/items.test.ts
\`\`\`typescript
import { describe, it, expect } from 'vitest';

describe('items API', () => {
  it('returns 200 on GET /items', () => {
    expect(true).toBe(true);
  });
});
\`\`\`

Now implement the code.`;

    const tests = parseTestSpecs(content);
    expect(tests).toHaveLength(1);
    expect(tests[0].path).toBe('api/src/services/items/items.test.ts');
    expect(tests[0].content).toContain("describe('items API'");
  });

  it('extracts multiple TEST: blocks', () => {
    const content = `TEST: src/utils.test.ts
\`\`\`typescript
import { describe, it, expect } from 'vitest';
describe('utils', () => { it('works', () => expect(1).toBe(1)); });
\`\`\`

TEST: src/helpers.spec.ts
\`\`\`typescript
import { describe, it, expect } from 'vitest';
describe('helpers', () => { it('works', () => expect(2).toBe(2)); });
\`\`\``;

    const tests = parseTestSpecs(content);
    expect(tests).toHaveLength(2);
    expect(tests[0].path).toBe('src/utils.test.ts');
    expect(tests[1].path).toBe('src/helpers.spec.ts');
  });

  it('ignores non-test file paths', () => {
    const content = `TEST: src/index.ts
\`\`\`typescript
export const foo = 1;
\`\`\``;

    const tests = parseTestSpecs(content);
    expect(tests).toHaveLength(0);
  });

  it('ignores empty or too-short code blocks', () => {
    const content = `TEST: src/foo.test.ts
\`\`\`typescript
// empty
\`\`\``;

    const tests = parseTestSpecs(content);
    expect(tests).toHaveLength(0);
  });

  it('returns empty array for content without TEST: blocks', () => {
    const content = 'Just assign this to the Local Builder for implementation.';
    expect(parseTestSpecs(content)).toEqual([]);
  });
});

describe('parseTestOutput', () => {
  it('parses vitest summary with passed and failed', () => {
    const output = `
 Test Files  1 failed | 2 passed (3)
      Tests  3 passed | 1 failed (4)
   Start at  12:00:00
   Duration  150ms
`;
    const result = parseTestOutput(output);
    expect(result.passCount).toBe(3);
    expect(result.failCount).toBe(1);
  });

  it('parses all-passed summary', () => {
    const output = `
 Test Files  3 passed (3)
      Tests  10 passed (10)
`;
    const result = parseTestOutput(output);
    expect(result.passCount).toBe(10);
    expect(result.failCount).toBe(0);
  });

  it('returns zeros for unrecognized output', () => {
    const result = parseTestOutput('some random output');
    expect(result.passCount).toBe(0);
    expect(result.failCount).toBe(0);
  });
});

describe('formatTestResultForPrompt', () => {
  it('shows passing status when all tests pass', () => {
    const formatted = formatTestResultForPrompt(
      { passed: true, passCount: 5, failCount: 0, output: '', durationMs: 100 },
      ['src/foo.test.ts']
    );
    expect(formatted).toContain('ALL TESTS PASSED');
    expect(formatted).toContain('Passed: 5');
  });

  it('shows failure details when tests fail', () => {
    const formatted = formatTestResultForPrompt(
      { passed: false, passCount: 3, failCount: 2, output: 'Error: expected 1 to be 2', durationMs: 200 },
      ['src/foo.test.ts']
    );
    expect(formatted).toContain('TESTS FAILED');
    expect(formatted).toContain('Failed: 2');
    expect(formatted).toContain('expected 1 to be 2');
    expect(formatted).toContain('do NOT modify the test files');
  });

  it('returns empty string for no test files', () => {
    const formatted = formatTestResultForPrompt(
      { passed: true, passCount: 0, failCount: 0, output: '', durationMs: 0 },
      []
    );
    expect(formatted).toBe('');
  });
});
