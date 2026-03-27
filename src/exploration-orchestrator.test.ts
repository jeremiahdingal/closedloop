/**
 * Tests for exploration-orchestrator.ts
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

// Mock agent-types
vi.mock('./agent-types', () => ({
  AGENTS: {
    strategist: 'strat-id',
    'tech lead': 'tl-id',
    'local builder': 'lb-id',
    reviewer: 'rev-id',
    'diff guardian': 'dg-id',
    'visual reviewer': 'vr-id',
    'complexity router': 'cr-id',
  },
  AGENT_NAMES: {},
  issueProcessingLock: {},
  issueBuilderPasses: {},
  issueBuilderBurstMode: new Set(),
}));

// Mock paperclip-api
vi.mock('./paperclip-api', () => ({
  postComment: vi.fn().mockResolvedValue(undefined),
  getIssueDetails: vi.fn().mockResolvedValue({ title: 'Test', description: 'Test issue' }),
  getIssueComments: vi.fn().mockResolvedValue([]),
  getAgentName: vi.fn().mockResolvedValue('Test Agent'),
}));

// Mock worktree-ops
vi.mock('./worktree-ops', () => ({
  createWorktree: vi.fn().mockResolvedValue({
    path: 'C:\\test\\workspace\\.worktrees\\test-branch',
    branch: 'test-branch',
    label: 'A',
    issueId: 'test-issue',
  }),
  removeWorktree: vi.fn(),
  cleanupWorktrees: vi.fn(),
  getWorktreeDiffStats: vi.fn().mockReturnValue('1 file changed, 10 insertions(+)'),
  getWorktreeDiff: vi.fn().mockReturnValue('+ added line'),
  mergeWinningApproach: vi.fn().mockResolvedValue(undefined),
}));

// Mock code-extractor
vi.mock('./code-extractor', () => ({
  applyCodeBlocks: vi.fn().mockReturnValue({ written: [], fileContents: {} }),
}));

// Mock context-builder
vi.mock('./context-builder', () => ({
  buildLocalBuilderContext: vi.fn().mockResolvedValue('test context'),
  buildIssueContext: vi.fn().mockResolvedValue('test context'),
  setRAGIndexer: vi.fn(),
  getRAGIndexer: vi.fn(),
}));

// Mock git-ops
vi.mock('./git-ops', () => ({
  getBranchName: vi.fn().mockResolvedValue('SHO-50-test'),
  commitAndPush: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock utils
vi.mock('./utils', () => ({
  truncate: (s: string, n: number) => s.length > n ? s.slice(0, n) + '...' : s,
  extractIssueId: vi.fn(),
  extractAgentId: vi.fn(),
  sleep: vi.fn(),
}));

import {
  parseApproachHints,
  buildApproachPrompt,
  buildComparisonPrompt,
  parseReviewerSelection,
  explorationStates,
} from './exploration-orchestrator';
import { ApproachResult, ExplorationState, WorktreeInfo } from './types';

describe('exploration-orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    explorationStates.clear();
  });

  describe('parseApproachHints', () => {
    it('returns null when no [EXPLORE] marker present', () => {
      expect(parseApproachHints('Just a normal response')).toBeNull();
    });

    it('returns null when [EXPLORE] present but no approach headers', () => {
      expect(parseApproachHints('[EXPLORE]\nSome text without approaches')).toBeNull();
    });

    it('returns null when only one approach is defined', () => {
      const content = '[EXPLORE]\n## Approach A: Single approach\nDetails here';
      expect(parseApproachHints(content)).toBeNull();
    });

    it('parses two approaches from Tech Lead output', () => {
      const content = `[EXPLORE]

## Approach A: Minimal changes
Modify the existing SettingsPage.tsx to add a toggle.
Keep all changes in one file.

## Approach B: Clean separation
Create a new ThemeToggle component and ThemeContext provider.
Better maintainability.`;

      const result = parseApproachHints(content);
      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result![0].label).toBe('A');
      expect(result![0].description).toContain('Minimal changes');
      expect(result![1].label).toBe('B');
      expect(result![1].description).toContain('Clean separation');
    });

    it('parses three approaches', () => {
      const content = `[EXPLORE]
## Approach A: In-place edit
Details A
## Approach B: New module
Details B
## Approach C: Hybrid
Details C`;

      const result = parseApproachHints(content);
      expect(result).not.toBeNull();
      expect(result).toHaveLength(3);
      expect(result![2].label).toBe('C');
    });
  });

  describe('buildApproachPrompt', () => {
    it('appends approach directive to base context', () => {
      const result = buildApproachPrompt('Base context here', {
        label: 'A',
        description: 'Use minimal changes',
      });

      expect(result).toContain('Base context here');
      expect(result).toContain('EXPLORATION MODE: APPROACH A');
      expect(result).toContain('Use minimal changes');
    });

    it('includes strict instruction to follow approach', () => {
      const result = buildApproachPrompt('ctx', {
        label: 'B',
        description: 'Create new modules',
      });

      expect(result).toContain('Follow these approach-specific instructions strictly');
    });
  });

  describe('buildComparisonPrompt', () => {
    const makeResult = (label: string, buildSuccess: boolean): ApproachResult => ({
      label,
      worktree: { path: `/tmp/${label}`, branch: `test-${label}`, label, issueId: 'issue-1' },
      buildSuccess,
      buildOutput: buildSuccess ? 'Build passed' : 'TS2345: type error',
      filesWritten: ['src/index.ts'],
      fileContents: { 'src/index.ts': 'code' },
      diffStats: '1 file changed',
    });

    it('shows all approaches failed when none pass', () => {
      const state: ExplorationState = {
        issueId: 'issue-1',
        approaches: [],
        results: [makeResult('A', false), makeResult('B', false)],
        status: 'comparing',
        createdAt: Date.now(),
      };

      const prompt = buildComparisonPrompt(state);
      expect(prompt).toContain('ALL approaches failed');
      expect(prompt).toContain('REJECTED');
    });

    it('suggests the single passing approach', () => {
      const state: ExplorationState = {
        issueId: 'issue-1',
        approaches: [],
        results: [makeResult('A', true), makeResult('B', false)],
        status: 'comparing',
        createdAt: Date.now(),
      };

      const prompt = buildComparisonPrompt(state);
      expect(prompt).toContain('Only approach A passed');
      expect(prompt).toContain('SELECTED: Approach A');
    });

    it('asks for comparison when multiple pass', () => {
      const state: ExplorationState = {
        issueId: 'issue-1',
        approaches: [],
        results: [makeResult('A', true), makeResult('B', true)],
        status: 'comparing',
        createdAt: Date.now(),
      };

      const prompt = buildComparisonPrompt(state);
      expect(prompt).toContain('Multiple approaches passed');
      expect(prompt).toContain('pick the best one');
    });

    it('shows build errors for failed approaches', () => {
      const state: ExplorationState = {
        issueId: 'issue-1',
        approaches: [],
        results: [makeResult('A', false)],
        status: 'comparing',
        createdAt: Date.now(),
      };

      const prompt = buildComparisonPrompt(state);
      expect(prompt).toContain('TS2345');
    });
  });

  describe('parseReviewerSelection', () => {
    it('parses explicit SELECTED response', () => {
      const result = parseReviewerSelection('SELECTED: Approach A because it has fewer changes');
      expect(result.selected).toBe('A');
      expect(result.rejected).toBe(false);
    });

    it('parses case-insensitive SELECTED', () => {
      const result = parseReviewerSelection('selected: approach B');
      expect(result.selected).toBe('B');
    });

    it('parses REJECTED response', () => {
      const result = parseReviewerSelection('REJECTED: Both approaches have issues with the API integration');
      expect(result.selected).toBeNull();
      expect(result.rejected).toBe(true);
      expect(result.reason).toContain('Both approaches');
    });

    it('fallback: detects "prefer approach X" pattern', () => {
      const result = parseReviewerSelection('I prefer approach B because it is cleaner');
      expect(result.selected).toBe('B');
    });

    it('fallback: detects "pick approach X" pattern', () => {
      const result = parseReviewerSelection('I would pick approach A');
      expect(result.selected).toBe('A');
    });

    it('returns no selection for unparseable content', () => {
      const result = parseReviewerSelection('The code looks fine overall');
      expect(result.selected).toBeNull();
      expect(result.rejected).toBe(false);
    });

    it('fallback: detects "best approach X"', () => {
      const result = parseReviewerSelection('The best approach C is the winner');
      expect(result.selected).toBe('C');
    });
  });
});
