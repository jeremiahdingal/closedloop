import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

vi.mock('./config', () => ({
  getPaperclipApiUrl: () => 'http://paperclip.test',
  getCompanyId: () => 'company-1',
  getAgentKeys: () => ({}),
}));

describe('paperclip-api', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
  });

  it('prefers the oldest assigned issue within the same dependency tier', async () => {
    const { findAssignedIssue } = await import('./paperclip-api');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          id: 'ticket-old',
          title: 'Checkout Confirmation Screen',
          status: 'todo',
          assigneeAgentId: 'builder-id',
          updatedAt: '2026-03-27T12:00:00.000Z',
        },
        {
          id: 'ticket-new',
          title: 'Receipt Review Screen',
          status: 'todo',
          assigneeAgentId: 'builder-id',
          updatedAt: '2026-03-27T12:30:00.000Z',
        },
      ]),
    });

    const selected = await findAssignedIssue('builder-id');
    expect(selected).toBe('ticket-old');
  });

  it('still prefers lower dependency tiers before recency', async () => {
    const { findAssignedIssue } = await import('./paperclip-api');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          id: 'ui-ticket',
          title: 'Order Completed Screen',
          status: 'todo',
          assigneeAgentId: 'builder-id',
          updatedAt: '2026-03-27T10:00:00.000Z',
        },
        {
          id: 'api-ticket',
          title: 'API Hook - Complete Order Mutation',
          status: 'todo',
          assigneeAgentId: 'builder-id',
          updatedAt: '2026-03-27T12:00:00.000Z',
        },
      ]),
    });

    const selected = await findAssignedIssue('builder-id');
    expect(selected).toBe('api-ticket');
  });

  it('returns assigned issues in the same dependency-aware order for follow-up wakeups', async () => {
    const { findAssignedIssues } = await import('./paperclip-api');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          id: 'ui-ticket',
          title: 'Order Completed Screen',
          status: 'todo',
          assigneeAgentId: 'builder-id',
          updatedAt: '2026-03-27T10:00:00.000Z',
        },
        {
          id: 'api-ticket',
          title: 'API Hook - Complete Order Mutation',
          status: 'todo',
          assigneeAgentId: 'builder-id',
          updatedAt: '2026-03-27T12:00:00.000Z',
        },
        {
          id: 'hook-ticket',
          title: 'Shared Checkout Hook',
          status: 'todo',
          assigneeAgentId: 'builder-id',
          updatedAt: '2026-03-27T11:00:00.000Z',
        },
      ]),
    });

    const selected = await findAssignedIssues('builder-id');
    expect(selected.map((issue) => issue.id)).toEqual(['api-ticket', 'hook-ticket', 'ui-ticket']);
  });

  it('posts stale agent comments as system notes instead of using the old agent tag', async () => {
    const { postComment } = await import('./paperclip-api');

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'issue-1',
          identifier: 'SHO-999',
          assigneeAgentId: 'reviewer-id',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'issue-1',
          identifier: 'SHO-999',
          assigneeAgentId: 'reviewer-id',
        }),
      });

    await postComment('issue-1', 'tech-id', 'late tech lead comment');

    const postCall = fetchMock.mock.calls.find(
      ([url, options]) =>
        url === 'http://paperclip.test/api/issues/issue-1/comments' &&
        options?.method === 'POST'
    );
    expect(postCall).toBeTruthy();
    expect(postCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  });
});
