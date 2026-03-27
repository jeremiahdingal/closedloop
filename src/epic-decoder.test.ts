import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEpicTicketsMock = vi.fn();
const decomposeGoalIntoTicketsMock = vi.fn();
const patchIssueMock = vi.fn(async () => true);
const postCommentMock = vi.fn(async () => {});
const getIssueLabelMock = vi.fn(async () => 'GOAL-1');
const callZAIMock = vi.fn();
const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => '');
const writeFileSyncMock = vi.fn();
const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\target-project',
  getCompanyId: () => 'company-1',
  getPaperclipApiUrl: () => 'http://paperclip.test',
}));

vi.mock('./paperclip-api', () => ({
  getIssueLabel: getIssueLabelMock,
  postComment: postCommentMock,
  patchIssue: patchIssueMock,
}));

vi.mock('./remote-ai', () => ({
  callZAI: callZAIMock,
}));

vi.mock('./goal-system', () => ({
  decomposeGoalIntoTickets: decomposeGoalIntoTicketsMock,
  getEpicTickets: getEpicTicketsMock,
  enforceGoalOverlapSuppression: vi.fn(async () => ({})),
  getOverlapBlockForTicket: vi.fn(() => undefined),
}));

vi.mock('./agent-types', () => ({
  AGENTS: { 'complexity router': 'complexity-router-id' },
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
}));

describe('epic-decoder', () => {
  beforeEach(() => {
    vi.resetModules();
    getEpicTicketsMock.mockReset();
    decomposeGoalIntoTicketsMock.mockReset();
    patchIssueMock.mockClear();
    postCommentMock.mockClear();
    getIssueLabelMock.mockClear();
    callZAIMock.mockReset();
    existsSyncMock.mockImplementation(() => false);
    readFileSyncMock.mockImplementation(() => '');
    writeFileSyncMock.mockClear();
    fetchMock.mockReset();
  });

  it('skips duplicate decode triggers while one decode is already in flight', async () => {
    const { decodeEpic } = await import('./epic-decoder');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'goal-1',
        title: 'Epic Goal',
        description: 'Desc',
        status: 'active',
      }),
    });
    getEpicTicketsMock.mockResolvedValue([]);
    decomposeGoalIntoTicketsMock.mockResolvedValue(['ticket-1']);
    callZAIMock.mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve(
                '## Ticket: API - Complete Order Endpoint\n' +
                  '**Objective:** Ship endpoint\n' +
                  '**Files:** api/src/services/orders/orders.routes.ts\n' +
                  '**Acceptance Criteria:**\n- [ ] Works\n' +
                  '**Dependencies:** None'
              ),
            25
          )
        )
    );

    const first = decodeEpic('goal-1');
    const second = decodeEpic('goal-1');
    const results = await Promise.all([first, second]);

    expect(results).toEqual([true, false]);
    expect(callZAIMock).toHaveBeenCalledTimes(1);
    expect(decomposeGoalIntoTicketsMock).toHaveBeenCalledTimes(1);
  });
});
