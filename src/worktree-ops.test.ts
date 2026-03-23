/**
 * Tests for worktree-ops.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\test\\workspace',
  getOllamaPorts: () => ({ proxyPort: 3201, ollamaPort: 11434 }),
  getPaperclipApiUrl: () => 'http://localhost:3100',
  getCompanyId: () => 'test-company',
  getAgentModel: (name: string) => name === 'local builder' ? 'qwen2.5-coder:14b' : null,
}));

// Mock git-ops
vi.mock('./git-ops', () => ({
  getBranchName: vi.fn().mockResolvedValue('SHO-50-add-dark-mode'),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('')),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  lstatSync: vi.fn().mockReturnValue({ isSymbolicLink: () => false, isDirectory: () => true }),
}));

import { getWorktreeRoot } from './worktree-ops';

describe('worktree-ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getWorktreeRoot', () => {
    it('returns .worktrees directory under workspace', () => {
      const root = getWorktreeRoot('C:\\projects\\myapp');
      expect(root).toBe('C:\\projects\\myapp\\.worktrees');
    });

    it('uses default workspace when not specified', () => {
      const root = getWorktreeRoot();
      expect(root).toBe('C:\\test\\workspace\\.worktrees');
    });
  });
});
