import { beforeEach, describe, expect, it, vi } from 'vitest';

const postCommentMock = vi.fn(async () => {});
const patchIssueMock = vi.fn(async () => true);
const getIssueDetailsMock = vi.fn();
const getIssueLabelMock = vi.fn(async (issueId: string) => {
  const labels: Record<string, string> = {
    'goal-1': 'GOAL-1',
    'ticket-1': 'SHO-1',
    'ticket-2': 'SHO-2',
    'ticket-3': 'SHO-3',
  };
  return labels[issueId] || issueId;
});
const writeFileSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const existsSyncMock = vi.fn(() => false);
const mkdirSyncMock = vi.fn();
const fetchMock = vi.fn();
const runEpicReviewerAgentMock = vi.fn(async () => {});

const goalTicketMap: Record<string, string[]> = {};
const ticketGoalMap: Record<string, string> = {};

vi.stubGlobal('fetch', fetchMock);

vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\target-project',
  getPaperclipApiUrl: () => 'http://paperclip.test',
  getCompanyId: () => 'company-1',
}));

vi.mock('./agent-types', () => ({
  AGENTS: { strategist: 'strategist-id' },
  goalTicketMap,
  ticketGoalMap,
  issueComplexityCache: {},
}));

vi.mock('./paperclip-api', () => ({
  postComment: postCommentMock,
  patchIssue: patchIssueMock,
  getIssueDetails: getIssueDetailsMock,
  getIssueLabel: getIssueLabelMock,
}));

vi.mock('./epic-reviewer-agent', () => ({
  runEpicReviewerAgent: runEpicReviewerAgentMock,
}));

vi.mock('fs', () => ({
  writeFileSync: writeFileSyncMock,
  readFileSync: readFileSyncMock,
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

describe('goal-system overlap suppression', () => {
  beforeEach(() => {
    vi.resetModules();
    postCommentMock.mockClear();
    patchIssueMock.mockClear();
    getIssueDetailsMock.mockReset();
    getIssueLabelMock.mockClear();
    writeFileSyncMock.mockClear();
    readFileSyncMock.mockClear();
    existsSyncMock.mockImplementation(() => false);
    mkdirSyncMock.mockClear();
    fetchMock.mockReset();
    runEpicReviewerAgentMock.mockClear();
    Object.keys(goalTicketMap).forEach(key => delete goalTicketMap[key]);
    Object.keys(ticketGoalMap).forEach(key => delete ticketGoalMap[key]);
  });

  it('blocks duplicate sibling tickets and favors the more foundational owner', async () => {
    const { enforceGoalOverlapSuppression, getOverlapBlockForTicket } = await import('./goal-system');

    goalTicketMap['goal-1'] = ['ticket-1', 'ticket-2'];
    ticketGoalMap['ticket-1'] = 'goal-1';
    ticketGoalMap['ticket-2'] = 'goal-1';

    await enforceGoalOverlapSuppression('goal-1', [
      {
        id: 'ticket-1',
        identifier: 'SHO-1',
        title: 'Build shared cash checkout API',
        description:
          '**Objective:** Build the foundational shared checkout API\n' +
          '**Files:** packages/app/cash/checkout.ts, packages/app/cash/types.ts\n' +
          '**Dependencies:** None',
        status: 'todo',
        createdAt: '2026-03-27T09:00:00.000Z',
      },
      {
        id: 'ticket-2',
        identifier: 'SHO-2',
        title: 'Build checkout confirmation screen',
        description:
          '**Objective:** Build the checkout confirmation UI\n' +
          '**Files:** packages/app/cash/checkout.ts, packages/app/cash/confirm.tsx\n' +
          '**Dependencies:** SHO-1',
        status: 'todo',
        createdAt: '2026-03-27T10:00:00.000Z',
      },
    ] as any);

    const blocked = getOverlapBlockForTicket('ticket-2');
    expect(blocked?.canonicalTicketId).toBe('ticket-1');
    expect(blocked?.canonicalIdentifier).toBe('SHO-1');
    expect(blocked?.overlappingFiles).toContain('packages/app/cash/checkout.ts');
    expect(postCommentMock).toHaveBeenCalledWith(
      'ticket-2',
      null,
      expect.stringContaining('[PAPERCLIP_OVERLAP_BLOCK]')
    );
    expect(patchIssueMock).toHaveBeenCalledWith(
      'ticket-2',
      expect.objectContaining({ status: 'todo', assigneeAgentId: undefined })
    );
  });

  it('ignores blocked duplicates when deciding goal readiness', async () => {
    const { enforceGoalOverlapSuppression, checkGoalCompletion } = await import('./goal-system');

    goalTicketMap['goal-1'] = ['ticket-1', 'ticket-2', 'ticket-3'];
    ticketGoalMap['ticket-1'] = 'goal-1';
    ticketGoalMap['ticket-2'] = 'goal-1';
    ticketGoalMap['ticket-3'] = 'goal-1';

    await enforceGoalOverlapSuppression('goal-1', [
      {
        id: 'ticket-1',
        identifier: 'SHO-1',
        title: 'Build shared API',
        description:
          '**Objective:** Build the shared API\n' +
          '**Files:** packages/app/cash/api.ts\n' +
          '**Dependencies:** None',
        status: 'in_review',
        createdAt: '2026-03-27T09:00:00.000Z',
      },
      {
        id: 'ticket-2',
        identifier: 'SHO-2',
        title: 'Build confirmation UI',
        description:
          '**Objective:** Build the confirmation screen\n' +
          '**Files:** packages/app/cash/api.ts, packages/app/cash/confirm.tsx\n' +
          '**Dependencies:** SHO-1',
        status: 'todo',
        createdAt: '2026-03-27T10:00:00.000Z',
      },
      {
        id: 'ticket-3',
        identifier: 'SHO-3',
        title: 'Build receipt screen',
        description:
          '**Objective:** Build the receipt screen\n' +
          '**Files:** packages/app/cash/receipt.tsx\n' +
          '**Dependencies:** SHO-1',
        status: 'in_review',
        createdAt: '2026-03-27T11:00:00.000Z',
      },
    ] as any);

    getIssueDetailsMock.mockImplementation(async (issueId: string) => {
      const issues: Record<string, any> = {
        'ticket-1': { id: 'ticket-1', status: 'in_review' },
        'ticket-2': { id: 'ticket-2', status: 'todo' },
        'ticket-3': { id: 'ticket-3', status: 'in_review' },
      };
      return issues[issueId] || null;
    });

    await checkGoalCompletion('ticket-1');

    expect(patchIssueMock).toHaveBeenCalledWith('goal-1', expect.objectContaining({ status: 'in_review' }));
    expect(
      postCommentMock.mock.calls.some(call =>
        String((call as any[])[2]).includes('overlapping duplicate tickets remain blocked')
      )
    ).toBe(true);
  });
});
