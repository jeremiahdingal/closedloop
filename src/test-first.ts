/**
 * Test-First Workflow
 *
 * The Strategist or Tech Lead defines acceptance tests BEFORE the builder writes code.
 * The builder's exit condition becomes "build passes AND tests pass" instead of just "build passes."
 * Tests catch logic bugs that build verification misses.
 *
 * Flow:
 *   1. Tech Lead outputs a test spec (test file path + test code)
 *   2. System writes the test file to workspace
 *   3. Local Builder implements until: build passes AND tests pass
 *   4. Reviewer verifies tests still pass
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────

export interface AcceptanceTest {
  /** Relative path for the test file */
  path: string;
  /** Test file content (vitest or jest) */
  content: string;
}

export interface TestRunResult {
  passed: boolean;
  /** Number of tests that passed */
  passCount: number;
  /** Number of tests that failed */
  failCount: number;
  /** Raw output from the test runner */
  output: string;
  /** Duration in ms */
  durationMs: number;
}

// ─── Extract test specs from agent output ────────────────────────

/**
 * Parse TEST: blocks from Tech Lead or Strategist output.
 * Format:
 *   TEST: path/to/file.test.ts
 *   ```typescript
 *   import { describe, it, expect } from 'vitest';
 *   ...
 *   ```
 */
export function parseTestSpecs(content: string): AcceptanceTest[] {
  const tests: AcceptanceTest[] = [];
  const regex = /TEST:\s*([^\n]+)\n```[\w]*\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const path = match[1].trim();
    const code = match[2].trim();

    // Only accept .test.ts/.test.tsx/.spec.ts/.spec.tsx files
    if (/\.(test|spec)\.(ts|tsx)$/.test(path) && code.length > 20) {
      tests.push({ path, content: code });
    }
  }

  return tests;
}

/**
 * Write acceptance test files to the workspace.
 * Returns list of paths written.
 */
export function writeTestFiles(workspace: string, tests: AcceptanceTest[]): string[] {
  const written: string[] = [];

  for (const test of tests) {
    const fullPath = join(workspace, test.path);
    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, test.content, 'utf8');
      written.push(test.path);
    } catch (err: any) {
      console.error(`[test-first] Failed to write ${test.path}: ${err.message}`);
    }
  }

  return written;
}

/**
 * Check if an issue has acceptance test files in the workspace.
 * Looks for .test.ts files in common locations related to the issue's touched files.
 */
export function findAcceptanceTests(workspace: string, touchedFiles: string[]): string[] {
  const testFiles: string[] = [];

  for (const file of touchedFiles) {
    // Check for co-located test file: foo.ts → foo.test.ts
    const testPath = file.replace(/\.(ts|tsx)$/, '.test.$1');
    if (existsSync(join(workspace, testPath))) {
      testFiles.push(testPath);
    }

    // Check for spec file: foo.ts → foo.spec.ts
    const specPath = file.replace(/\.(ts|tsx)$/, '.spec.$1');
    if (existsSync(join(workspace, specPath))) {
      testFiles.push(specPath);
    }
  }

  return [...new Set(testFiles)];
}

// ─── Run tests ───────────────────────────────────────────────────

/**
 * Run acceptance tests using vitest.
 * Returns structured result with pass/fail counts.
 */
export function runAcceptanceTests(
  workspace: string,
  testFiles: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): TestRunResult {
  const { timeoutMs = 60000, cwd } = options;
  const testDir = cwd || workspace;

  if (testFiles.length === 0) {
    return { passed: true, passCount: 0, failCount: 0, output: 'No test files to run', durationMs: 0 };
  }

  const startTime = Date.now();
  const fileList = testFiles.join(' ');

  try {
    const output = execSync(
      `npx vitest run --reporter=verbose ${fileList}`,
      {
        cwd: testDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const durationMs = Date.now() - startTime;
    const { passCount, failCount } = parseTestOutput(output);

    return {
      passed: true,
      passCount,
      failCount: 0,
      output: output.substring(0, 3000),
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const output = (err.stdout || '') + '\n' + (err.stderr || '');
    const { passCount, failCount } = parseTestOutput(output);

    return {
      passed: false,
      passCount,
      failCount: Math.max(failCount, 1), // At least 1 failure if exit code != 0
      output: output.substring(0, 3000),
      durationMs,
    };
  }
}

/**
 * Parse vitest output for pass/fail counts.
 */
export function parseTestOutput(output: string): { passCount: number; failCount: number } {
  let passCount = 0;
  let failCount = 0;

  // Vitest summary: "Tests  5 passed | 2 failed (7)" or "Tests  5 passed (5)"
  const passMatch = output.match(/Tests\s+.*?(\d+)\s+passed/i);
  const failMatch = output.match(/Tests\s+.*?(\d+)\s+failed/i);
  if (passMatch) passCount = parseInt(passMatch[1], 10);
  if (failMatch) failCount = parseInt(failMatch[1], 10);

  return { passCount, failCount };
}

/**
 * Format test results for inclusion in a builder prompt.
 */
export function formatTestResultForPrompt(result: TestRunResult, testFiles: string[]): string {
  if (testFiles.length === 0) return '';

  const status = result.passed ? 'ALL TESTS PASSED' : 'TESTS FAILED';
  const failOutput = result.passed ? '' : `\n\nTest output:\n${result.output.substring(0, 1500)}`;

  return `
== ACCEPTANCE TESTS ==
Status: ${status}
Files: ${testFiles.join(', ')}
Passed: ${result.passCount} | Failed: ${result.failCount} | Duration: ${result.durationMs}ms
${failOutput}

${result.passed
    ? 'Tests pass. Continue with implementation.'
    : 'CRITICAL: Fix your code until these tests pass. The tests define the acceptance criteria — do NOT modify the test files.'}
`;
}
