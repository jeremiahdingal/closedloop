import { beforeEach, describe, expect, it, vi } from 'vitest';

const collectMonorepoContextMock = vi.fn(async () => 'FULL TARGET PROJECT CONTEXT');
const postCommentMock = vi.fn(async () => {});
const callZAIMock = vi.fn();
const getEpicTicketsMock = vi.fn();
const getActionableEpicTicketsMock = vi.fn();
const getBranchNameMock = vi.fn(async (issueId: string) => `branch-${issueId}`);
const execSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
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
  getActionableEpicTickets: getActionableEpicTicketsMock,
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
  rmSync: rmSyncMock,
  writeFileSync: writeFileSyncMock,
  readFileSync: readFileSyncMock,
}));

describe('epic-reviewer-agent', () => {
  beforeEach(() => {
    vi.resetModules();
    collectMonorepoContextMock.mockClear();
    postCommentMock.mockClear();
    callZAIMock.mockReset();
    getEpicTicketsMock.mockReset();
    getActionableEpicTicketsMock.mockReset();
    getBranchNameMock.mockClear();
    execSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    readFileSyncMock.mockReset();
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
      overlappingFiles: [],
      overlapSummary: '',
      reconciliationBranchName: '',
      reconciliationActive: false,
    });

    const secondPrompt = await buildReviewPrompt(epic as any, {
      attemptCount: 2,
      injectedFullContext: true,
      lastSummary: 'Prior review',
      lastBuildErrors: 'Type error',
      lastAppliedFixes: ['SHO-1: src/file.ts'],
      overlappingFiles: ['src/file.ts'],
      overlapSummary: '- src/file.ts <- SHO-1, SHO-2',
      reconciliationBranchName: '',
      reconciliationActive: false,
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
    getActionableEpicTicketsMock.mockResolvedValue([
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
      execSyncMock.mock.calls.some(call => String((call as any[])[0]).includes('git worktree add --force'))
    ).toBe(true);
    expect(
      postCommentMock.mock.calls.some(call => String((call as any[])[2]).includes('Build authority result: green.'))
    ).toBe(true);
    expect(
      postCommentMock.mock.calls.some(call => String((call as any[])[2]).includes('Epic Reviewer Visible Model Output'))
    ).toBe(true);
  });

  it('caps retries at five failed build attempts', async () => {
    const { runEpicReviewerAgent, getEpicReviewerState, resetEpicReviewerState } = await import('./epic-reviewer-agent');
    resetEpicReviewerState();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'goal-2', title: 'Epic Two', description: '', status: 'active' }],
    });
    getActionableEpicTicketsMock.mockResolvedValue([
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

  it('switches to reconciliation mode after overlap is detected', async () => {
    const { runEpicReviewerAgent, getEpicReviewerState, resetEpicReviewerState } = await import('./epic-reviewer-agent');
    resetEpicReviewerState();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'goal-3', title: 'Epic Three', description: 'Desc', status: 'active' }],
    });
    getActionableEpicTicketsMock.mockResolvedValue([
      { id: 'ticket-3', identifier: 'SHO-3', title: 'Third ticket', status: 'in_review', goalId: 'goal-3' },
      { id: 'ticket-4', identifier: 'SHO-4', title: 'Fourth ticket', status: 'in_review', goalId: 'goal-3' },
    ]);

    callZAIMock
      .mockResolvedValueOnce('VERDICT: APPROVED\nSUMMARY:\nNeed integration reconciliation')
      .mockResolvedValueOnce(
        'VERDICT: CHANGES_REQUESTED\n' +
        'TARGET: EPIC_RECONCILE\n' +
        'FILE: src/shared.ts\n```ts\nexport const reconciled = true;\n```\n' +
        'SUMMARY:\nResolved epic conflicts'
      );

    let buildAttempts = 0;
    readFileSyncMock.mockReturnValue('<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n');
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('--name-only') && command.includes('branch-ticket-3')) {
        return 'src/shared.ts\nsrc/one.ts\n';
      }
      if (command.includes('--name-only') && command.includes('branch-ticket-4')) {
        return 'src/shared.ts\nsrc/two.ts\n';
      }
      if (command.includes('git diff main...branch-ticket-')) {
        return 'diff --git a/src/shared.ts b/src/shared.ts\n+change';
      }
      if (command.includes('git diff main...epic/')) {
        return 'diff --git a/src/shared.ts b/src/shared.ts\n<<<<<<< HEAD\n=======\n>>>>>>>';
      }
      if (command === 'git diff --name-only --diff-filter=U') {
        return 'src/shared.ts\n';
      }
      if (command === 'yarn build') {
        buildAttempts += 1;
        if (buildAttempts === 1) {
          const error = new Error('build failed') as any;
          error.stdout = Buffer.from('failing before reconcile');
          error.stderr = Buffer.from('compile error');
          throw error;
        }
        return '';
      }
      return '';
    });

    await runEpicReviewerAgent();

    const state = getEpicReviewerState('goal-3');
    expect(state?.attemptCount).toBe(2);
    expect(state?.reconciliationActive).toBe(true);
    expect(state?.overlappingFiles).toContain('src/shared.ts');
    expect(
      execSyncMock.mock.calls.some(call => String((call as any[])[0]).includes('git merge --no-ff --no-commit branch-ticket-3'))
    ).toBe(true);
    expect(
      postCommentMock.mock.calls.some(call => String((call as any[])[2]).includes('Epic Reconciliation Branch Created'))
    ).toBe(true);
  });

  it('treats blocked duplicate tickets as non-blocking for epic readiness', async () => {
    const { runEpicReviewerAgent, resetEpicReviewerState } = await import('./epic-reviewer-agent');
    resetEpicReviewerState();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'goal-4', title: 'Epic Four', description: 'Desc', status: 'active' }],
    });
    getActionableEpicTicketsMock.mockResolvedValue([
      { id: 'ticket-5', identifier: 'SHO-5', title: 'Canonical ticket', status: 'in_review', goalId: 'goal-4' },
    ]);
    callZAIMock.mockResolvedValue('VERDICT: APPROVED\nSUMMARY:\nGreen');

    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('git diff')) {
        return 'diff --git a/src/canonical.ts b/src/canonical.ts\n+export const canonical = true;';
      }
      if (command === 'yarn build') {
        return '';
      }
      return '';
    });

    await runEpicReviewerAgent();

    expect(callZAIMock).toHaveBeenCalledTimes(1);
    expect(
      postCommentMock.mock.calls.some(call => String((call as any[])[2]).includes('Build authority result: green.'))
    ).toBe(true);
  });

  it('skips duplicate Epic Reviewer wakes while a run is already active', async () => {
    const { runEpicReviewerAgent, resetEpicReviewerState } = await import('./epic-reviewer-agent');
    resetEpicReviewerState();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'goal-5', title: 'Epic Five', description: 'Desc', status: 'active' }],
    });
    getActionableEpicTicketsMock.mockResolvedValue([
      { id: 'ticket-6', identifier: 'SHO-6', title: 'Sixth ticket', status: 'in_review', goalId: 'goal-5' },
    ]);
    callZAIMock.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          setTimeout(() => resolve('VERDICT: APPROVED\nSUMMARY:\nGreen'), 25);
        })
    );
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('git diff')) return 'diff --git a/src/file.ts b/src/file.ts\n+ok';
      if (command === 'yarn build') return '';
      return '';
    });

    const firstRun = runEpicReviewerAgent();
    await new Promise(resolve => setTimeout(resolve, 5));
    const secondRun = runEpicReviewerAgent();
    await Promise.all([firstRun, secondRun]);

    expect(callZAIMock).toHaveBeenCalledTimes(1);
  });

  it('can delete duplicate files from ticket branches when Epic Reviewer requests it', async () => {
    const { runEpicReviewerAgent, resetEpicReviewerState } = await import('./epic-reviewer-agent');
    resetEpicReviewerState();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'goal-6', title: 'Epic Six', description: 'Desc', status: 'active' }],
    });
    getActionableEpicTicketsMock.mockResolvedValue([
      { id: 'ticket-7', identifier: 'SHO-7', title: 'Seventh ticket', status: 'in_review', goalId: 'goal-6' },
    ]);
    callZAIMock.mockResolvedValue(
      'VERDICT: CHANGES_REQUESTED\n' +
      'TICKET: SHO-7\n' +
      'DELETE FILE: src/duplicate.tsx\n' +
      'TICKET: SHO-7\n' +
      'FILE: src/canonical.tsx\n```tsx\nexport const Canonical = () => null;\n```\n' +
      'SUMMARY:\nRemoved duplicate file and kept canonical implementation'
    );

    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('git diff')) return 'diff --git a/src/canonical.tsx b/src/canonical.tsx\n+ok';
      if (command === 'yarn build') return '';
      return '';
    });

    await runEpicReviewerAgent();

    expect(
      rmSyncMock.mock.calls.some(call => String((call as any[])[0]).includes('src\\duplicate.tsx'))
    ).toBe(true);
    expect(
      execSyncMock.mock.calls.some(call => String((call as any[])[0]).includes('git add "src/duplicate.tsx"'))
    ).toBe(true);
    expect(
      postCommentMock.mock.calls.some(call => String((call as any[])[2]).includes('deleted `src/duplicate.tsx`'))
    ).toBe(true);
  });
});
