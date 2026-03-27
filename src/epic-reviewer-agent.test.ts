import { beforeEach, describe, expect, it, vi } from 'vitest';

const collectMonorepoContextMock = vi.fn(async () => 'FULL TARGET PROJECT CONTEXT');
const postCommentMock = vi.fn(async () => {});
const callZAIMock = vi.fn();
const getEpicTicketsMock = vi.fn();
const getBranchNameMock = vi.fn(async (issueId: string) => `branch-${issueId}`);
const execSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

vi.mock('./context-builder', () => ({
  collectMonorepoContext: collectMonorepoContextMock,
}));

vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\target-project',
  getCompanyId: () => 'company-1',
  getPaperclipApiUrl: () => 'http://paperclip.test',
  loadConfig: () => ({ commands: { build: 'yarn build' } }),
}));

vi.mock('./paperclip-api', () => ({
  postComment: postCommentMock,
}));

vi.mock('./remote-ai', () => ({
  callZAI: callZAIMock,
}));

vi.mock('./goal-system', () => ({
  getEpicTickets: getEpicTicketsMock,
}));

vi.mock('./git-ops', () => ({
  getBranchName: getBranchNameMock,
  getDefaultBranch: () => 'main',
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('fs', () => ({
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
}));

describe('epic-reviewer-agent', () => {
  beforeEach(() => {
    vi.resetModules();
    collectMonorepoContextMock.mockClear();
    postCommentMock.mockClear();
    callZAIMock.mockReset();
    getEpicTicketsMock.mockReset();
    getBranchNameMock.mockClear();
    execSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    fetchMock.mockReset();
  });

  it('injects full target-project monorepo context only on the first attempt prompt', async () => {
    const { buildReviewPrompt } = await import('./epic-reviewer-agent');

    const epic = {
      goal: { id: 'goal-1', title: 'Epic', description: 'Desc' },
      tickets: [{ id: 'ticket-1', identifier: 'SHO-1', title: 'First ticket', status: 'in_review', goalId: 'goal-1' }],
    };

    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('git diff')) {
        return 'diff --git a/file.ts b/file.ts\n+change';
      }
      return '';
    });

    const firstPrompt = await buildReviewPrompt(epic as any, {
      attemptCount: 1,
      injectedFullContext: false,
      lastSummary: '',
      lastBuildErrors: '',
      lastAppliedFixes: [],
    });

    const secondPrompt = await buildReviewPrompt(epic as any, {
      attemptCount: 2,
      injectedFullContext: true,
      lastSummary: 'Prior review',
      lastBuildErrors: 'Type error',
      lastAppliedFixes: ['SHO-1: src/file.ts'],
    });

    expect(firstPrompt).toContain('FULL TARGET PROJECT CONTEXT');
    expect(secondPrompt).not.toContain('FULL TARGET PROJECT CONTEXT');
    expect(secondPrompt).toContain('Carry Forward Context');
    expect(collectMonorepoContextMock).toHaveBeenCalledTimes(1);
  });

  it('retries until build is green and preserves first-run-only context injection', async () => {
    const { runEpicReviewerAgent, getEpicReviewerState, resetEpicReviewerState } = await import('./epic-reviewer-agent');
    resetEpicReviewerState();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'goal-1', title: 'Epic', description: 'Desc', status: 'active' }],
    });
    getEpicTicketsMock.mockResolvedValue([
      { id: 'ticket-1', identifier: 'SHO-1', title: 'First ticket', status: 'in_review', goalId: 'goal-1' },
    ]);
    callZAIMock.mockResolvedValue(
      'VERDICT: CHANGES_REQUESTED\n' +
      'TICKET: SHO-1\n' +
      'FILE: src/fix.ts\n```ts\nexport const fixed = true;\n```\n' +
      'SUMMARY:\nApplied a fix'
    );

    let buildAttempts = 0;
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('git diff')) {
        return 'diff --git a/src/fix.ts b/src/fix.ts\n+export const fixed = true;';
      }
      if (command === 'yarn build') {
        buildAttempts += 1;
        if (buildAttempts === 1) {
          const error = new Error('build failed') as any;
          error.stdout = Buffer.from('stdout failure');
          error.stderr = Buffer.from('stderr failure');
          throw error;
        }
        return '';
      }
      return '';
    });

    await runEpicReviewerAgent();

    const state = getEpicReviewerState('goal-1');
    expect(state?.attemptCount).toBe(2);
    expect(state?.injectedFullContext).toBe(true);
    expect(callZAIMock).toHaveBeenCalledTimes(2);
    expect(collectMonorepoContextMock).toHaveBeenCalledTimes(1);
    expect(
      postCommentMock.mock.calls.some(call => String((call as any[])[2]).includes('Build authority result: green.'))
    ).toBe(true);
  });

  it('caps retries at five failed build attempts', async () => {
    const { runEpicReviewerAgent, getEpicReviewerState, resetEpicReviewerState } = await import('./epic-reviewer-agent');
    resetEpicReviewerState();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'goal-2', title: 'Epic Two', description: '', status: 'active' }],
    });
    getEpicTicketsMock.mockResolvedValue([
      { id: 'ticket-2', identifier: 'SHO-2', title: 'Second ticket', status: 'in_review', goalId: 'goal-2' },
    ]);
    callZAIMock.mockResolvedValue('VERDICT: APPROVED\nSUMMARY:\nNo code changes needed');

    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('git diff')) {
        return 'diff --git a/src/fix.ts b/src/fix.ts\n+export const fixed = true;';
      }
      if (command === 'yarn build') {
        const error = new Error('build failed') as any;
        error.stdout = Buffer.from('still failing');
        error.stderr = Buffer.from('compile error');
        throw error;
      }
      return '';
    });

    await runEpicReviewerAgent();

    const state = getEpicReviewerState('goal-2');
    expect(state?.attemptCount).toBe(5);
    expect(callZAIMock).toHaveBeenCalledTimes(5);
    expect(
      postCommentMock.mock.calls.some(call => String((call as any[])[2]).includes('Capped at 5 Attempts'))
    ).toBe(true);
  });
});
