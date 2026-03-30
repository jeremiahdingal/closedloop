/**
 * Test Writer — Generates Vitest test files for code written by Local Builder.
 *
 * Strategy:
 * 1. Deterministic: If files match a CRUD service pattern, generate tests from scaffold templates
 * 2. LLM fallback: For non-scaffold API files, use a small model to generate tests
 * 3. Skip: Frontend files (no @testing-library installed), non-API files
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getOllamaPorts, getAgentModel } from './config';
import { callOpenCodeCLI } from './remote-ai';

export interface TestWriterResult {
  filesWritten: string[];
  fileContents: Record<string, string>;
}

/**
 * Generate test files for files written by Local Builder.
 * Called after build passes, before Reviewer.
 */
export async function generateTestsForFiles(
  issueId: string,
  writtenFiles: string[],
  fileContents: Record<string, string>
): Promise<TestWriterResult> {
  const workspace = getWorkspace();
  const result: TestWriterResult = { filesWritten: [], fileContents: {} };

  // Only generate tests for API service/route files
  const testableFiles = writtenFiles.filter(f =>
    f.match(/api\/src\/services\/.*\.(service|routes)\.ts$/) &&
    !f.includes('.test.') &&
    !f.includes('.spec.')
  );

  if (testableFiles.length === 0) {
    return result;
  }

  for (const filePath of testableFiles) {
    const testPath = filePath.replace(/\.ts$/, '.test.ts');
    const fullTestPath = path.join(workspace, testPath);

    // Skip if test already exists
    if (fs.existsSync(fullTestPath)) continue;

    const sourceCode = fileContents[filePath] || '';
    if (!sourceCode) continue;

    try {
      const testContent = await generateTestWithLLM(filePath, sourceCode);
      if (testContent) {
        const dir = path.dirname(fullTestPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullTestPath, testContent, 'utf8');
        result.filesWritten.push(testPath);
        result.fileContents[testPath] = testContent;
        console.log(`[test-writer] Generated: ${testPath}`);
      }
    } catch (err: any) {
      console.log(`[test-writer] Failed for ${filePath}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Use a local LLM to generate a Vitest test for an API service file.
 * Uses a smaller/faster model than the Builder since test gen is more templated.
 */
async function generateTestWithLLM(filePath: string, sourceCode: string): Promise<string | null> {
  const { ollamaPort } = getOllamaPorts();
  // Use diff guardian model (small, fast) for test generation — it's templated work
  const model = getAgentModel('diff guardian') || 'qwen3:4b';

  const systemPrompt = `You are a test engineer. Generate a Vitest test file for the given TypeScript service.

RULES:
- Use vitest: import { describe, it, expect, vi, beforeEach } from 'vitest'
- Mock the database with a Kysely query builder chain mock:
  - Create a mockQueryBuilder object where every method (selectFrom, insertInto, updateTable, deleteFrom, where, selectAll, values, set, returningAll) returns itself via mockReturnThis()
  - execute and executeTakeFirstOrThrow are separate vi.fn() mocks
- vi.mock the db import: vi.mock('../../infra/db', () => ({ db: () => mockQueryBuilder }))
- vi.mock ulidx: vi.mock('ulidx', () => ({ ulid: () => 'mock-ulid-001' }))
- Use dynamic import for the service: const { serviceName } = await import('./file.service')
- Test each exported function: getAll, getById, create, update, delete
- Assert that the correct Kysely methods were called with correct arguments
- Use beforeEach to call vi.clearAllMocks()
- Output ONLY the test file content, no explanation`;

  const userPrompt = `Generate a Vitest test for this file at ${filePath}:\n\n\`\`\`typescript\n${sourceCode}\n\`\`\``;

  try {
    let content = await callOpenCodeCLI(userPrompt, systemPrompt, model, 120000);

    // Extract code block if wrapped in markdown
    const codeBlockMatch = content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      content = codeBlockMatch[1];
    }

    // Basic validation — must have vitest imports
    if (!content.includes('vitest') || !content.includes('describe')) {
      return null;
    }

    return content.trim() + '\n';
  } catch {
    return null;
  }
}
