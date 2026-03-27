import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.fn();
const postCommentMock = vi.fn();

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('./paperclip-api', () => ({
  postComment: postCommentMock,
}));

vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\workspace',
  getAgents: () => ({
    strategist: 'strategist-id',
    reviewer: 'reviewer-id',
    sentinel: 'sentinel-id',
    deployer: 'deployer-id',
    'visual reviewer': 'visual-reviewer-id',
    'tech lead': 'tech-lead-id',
    'local builder': 'local-builder-id',
    'diff guardian': 'diff-guardian-id',
    'coder remote': 'coder-remote-id',
    'complexity router': 'complexity-router-id',
    'epic decoder': 'epic-decoder-id',
    'epic reviewer': 'epic-reviewer-id',
  }),
  getBlockedAgents: () => [],
  getDelegationRules: () => ({}),
}));

describe('executeBashBlocks', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    postCommentMock.mockReset();
  });

  it('blocks node-killing commands instead of executing them', async () => {
    const { executeBashBlocks } = await import('./bash-executor');
    const reviewerId = 'reviewer-id';

    const ran = await executeBashBlocks(
      'issue-1',
      reviewerId,
      '```bash\ntaskkill /F /IM node.exe\n```'
    );

    expect(ran).toBe(false);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(postCommentMock).toHaveBeenCalledWith(
      'issue-1',
      null,
      expect.stringContaining('Blocked dangerous command')
    );
  });
});
