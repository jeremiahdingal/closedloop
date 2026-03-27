import { beforeEach, describe, expect, it, vi } from 'vitest';

const getIssueDetailsMock = vi.fn();
const getIssueCommentsMock = vi.fn();
const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\target-project',
  getAgents: () => ({
    strategist: 'strategist-id',
    'tech lead': 'dad994d7-5d3e-4101-ae57-82c7be9b778b',
    'local builder': 'caf931bf-516a-409f-813e-a29e14decb10',
    reviewer: 'reviewer-id',
    sentinel: 'sentinel-id',
    deployer: 'deployer-id',
    'visual reviewer': 'visual-id',
  }),
  getBlockedAgents: () => [],
  getDelegationRules: () => ({}),
}));

vi.mock('./paperclip-api', () => ({
  getIssueDetails: getIssueDetailsMock,
  getIssueComments: getIssueCommentsMock,
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

describe('buildLocalBuilderContext', () => {
  beforeEach(() => {
    vi.resetModules();
    getIssueDetailsMock.mockReset();
    getIssueCommentsMock.mockReset();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it('only injects Tech Lead referenced files that already exist in the repo', async () => {
    const { buildLocalBuilderContext } = await import('./context-builder');

    getIssueDetailsMock.mockResolvedValue({
      id: 'issue-1',
      identifier: 'SHO-1',
      title: 'Implement checkout hook',
      status: 'todo',
      priority: 'medium',
      description: 'Create the hook and wire it in.',
    });
    getIssueCommentsMock.mockResolvedValue([
      {
        authorAgentId: 'dad994d7-5d3e-4101-ae57-82c7be9b778b',
        createdAt: '2026-03-27T12:00:00.000Z',
        body: 'Update `packages/app/apiHooks/useCompleteOrder.ts` and `packages/app/cashier/checkout/OrderCompletedScreen.tsx`.',
      },
    ]);
    existsSyncMock.mockImplementation((targetPath: string) =>
      targetPath.includes('packages/app/apiHooks/useCompleteOrder.ts')
    );
    readFileSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath.includes('useCompleteOrder.ts')) {
        return 'export function useCompleteOrder() { return null }';
      }
      return '';
    });

    const context = await buildLocalBuilderContext('issue-1', 'caf931bf-516a-409f-813e-a29e14decb10');

    expect(context).toContain('packages/app/apiHooks/useCompleteOrder.ts');
    expect(context).not.toContain('OrderCompletedScreen.tsx (current)');
    expect(context).toContain('Do NOT use broad monorepo context');
    expect(context).not.toContain('## Monorepo Structure');
  });
});
