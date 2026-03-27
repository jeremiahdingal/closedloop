import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const postCommentMock = vi.fn(async () => {});
const getIssueDetailsMock = vi.fn(async () => ({
  identifier: 'SHO-101',
  title: 'Test Issue',
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('fs', () => ({
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('./config', () => ({
  getWorkspace: () => 'C:\\workspace',
}));

vi.mock('./paperclip-api', () => ({
  getIssueDetails: getIssueDetailsMock,
  postComment: postCommentMock,
}));

vi.mock('./agent-types', () => ({
  issueBuilderPasses: { 'issue-1': 2 },
}));

vi.mock('./utils', () => ({
  listPngFilesRecursive: vi.fn(() => []),
}));

describe('commitAndPush', () => {
  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    postCommentMock.mockClear();
    getIssueDetailsMock.mockClear();

    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('symbolic-ref')) {
        return Buffer.from('refs/remotes/origin/main');
      }
      return Buffer.from('');
    });
  });

  it('commits and pushes without running any build command', async () => {
    const { commitAndPush } = await import('./git-ops');

    const result = await commitAndPush('issue-1', ['src/example.ts'], {
      'src/example.ts': 'export const example = 1;',
    });

    expect(result).toEqual({ success: true });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      'C:\\workspace\\src\\example.ts',
      'export const example = 1;'
    );

    const commands = execSyncMock.mock.calls.map(([command]) => command);
    expect(commands.some(command => String(command).toLowerCase().includes('build'))).toBe(false);
    expect(commands).toContain('git add "src/example.ts"');
    expect(commands.some(command => String(command).includes('git commit -m "SHO-101: Test Issue (pass 2)"'))).toBe(true);
    expect(commands).toContain('git push -u origin sho-101-test-issue');
    expect(postCommentMock).toHaveBeenCalledTimes(1);
  });
});
