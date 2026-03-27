import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.fn();
const postCommentMock = vi.fn(async () => {});
const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => 'export const useAuthStore = 1;'),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\workspace',
}));

vi.mock('./paperclip-api', () => ({
  postComment: postCommentMock,
}));

vi.mock('./git-ops', () => ({
  getDefaultBranch: () => 'main',
  getBranchName: vi.fn(async () => 'feature-branch'),
}));

describe('runDiffGuardian', () => {
  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    postCommentMock.mockClear();
    fetchMock.mockReset();

    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('--name-only')) {
        return 'packages/app/store/auth.store.ts\n';
      }
      if (command.includes('--numstat')) {
        return '10\t2\tpackages/app/store/auth.store.ts\n';
      }
      if (command.startsWith('git show')) {
        return 'export const useAuthStore = 1;';
      }
      return '';
    });
  });

  it('uses deterministic checks only and sends duplicate stores back to Local Builder', async () => {
    const { runDiffGuardian } = await import('./diff-guardian');

    const result = await runDiffGuardian('issue-1');

    expect(result.approved).toBe(false);
    expect(result.issues.some(issue => issue.type === 'DUPLICATE_STORE')).toBe(true);
    expect(postCommentMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
