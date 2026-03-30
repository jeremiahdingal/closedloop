import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

vi.mock('./config', () => ({
  getCompanyId: () => 'company-1',
  getPaperclipApiUrl: () => 'http://paperclip.test',
  getWorkspace: () => 'C:\\workspace',
}));

vi.mock('./agent-types', () => ({
  AGENTS: {
    'complexity router': 'complexity-router-id',
    strategist: 'strategist-id',
    'tech lead': 'tech-lead-id',
    'local builder': 'local-builder-id',
    'coder remote': 'coder-remote-id',
    reviewer: 'reviewer-id',
    'diff guardian': 'diff-guardian-id',
    'visual reviewer': 'visual-reviewer-id',
    sentinel: 'sentinel-id',
    deployer: 'deployer-id',
    'scaffold architect': 'scaffold-architect-id',
    'epic reviewer': 'epic-reviewer-id',
    'epic decoder': 'epic-decoder-id',
  },
}));

describe('adapter-config', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('syncs upstream orchestration agents to the native OpenCode adapter', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/api/companies/company-1/agents') && (!init || init.method !== 'PATCH')) {
        return {
          ok: true,
          json: async () => ([
            { id: 'complexity-router-id', name: 'Complexity Router', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'strategist-id', name: 'Strategist', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'tech-lead-id', name: 'Tech Lead', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'local-builder-id', name: 'Local Builder', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'coder-remote-id', name: 'Coder Remote', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'visual-reviewer-id', name: 'Visual Reviewer', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'sentinel-id', name: 'Sentinel', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'deployer-id', name: 'Deployer', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'epic-decoder-id', name: 'Epic Decoder', adapterType: 'http', adapterConfig: { url: 'http://bad.local' } },
            { id: 'reviewer-id', name: 'Reviewer', adapterType: 'opencode_local', adapterConfig: { cwd: 'C:\\workspace' } },
            { id: 'diff-guardian-id', name: 'Diff Guardian', adapterType: 'opencode_local', adapterConfig: { cwd: 'C:\\workspace' } },
            { id: 'epic-reviewer-id', name: 'Epic Reviewer', adapterType: 'codex_local', adapterConfig: { cwd: 'C:\\workspace' } },
          ]),
        };
      }

      return { ok: true, text: async () => '' };
    });

    const { ensureUpstreamOpenCodeAdapters } = await import('./adapter-config');
    await ensureUpstreamOpenCodeAdapters();

    const patchBodies = fetchMock.mock.calls
      .filter(([url, init]) => String(url).includes('/api/agents/') && (init as any)?.method === 'PATCH')
      .map(([, init]) => JSON.parse((init as any).body));

    expect(patchBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapterType: 'opencode_local', adapterConfig: expect.objectContaining({ cwd: 'C:\\workspace', model: 'ollama/qwen3:4b' }) }),
      expect.objectContaining({ adapterType: 'opencode_local', adapterConfig: expect.objectContaining({ cwd: 'C:\\workspace', model: 'ollama/qwen3:8b' }) }),
      expect.objectContaining({ adapterType: 'opencode_local', adapterConfig: expect.objectContaining({ cwd: 'C:\\workspace', model: 'ollama/deepcoder:14b' }) }),
      expect.objectContaining({ adapterType: 'opencode_local', adapterConfig: expect.objectContaining({ cwd: 'C:\\workspace', model: 'ollama/qwen2.5-coder:7b' }) }),
    ]));

    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/agents/reviewer-id') && (init as any)?.method === 'PATCH')).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/agents/diff-guardian-id') && (init as any)?.method === 'PATCH')).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/agents/epic-reviewer-id') && (init as any)?.method === 'PATCH')).toBe(false);
  });

  it('syncs Epic Reviewer to the native local adapter with a compact prompt', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/api/companies/company-1/agents') && (!init || init.method !== 'PATCH')) {
        return {
          ok: true,
          json: async () => ([
            { id: 'epic-reviewer-id', name: 'Epic Reviewer', adapterType: 'http', adapterConfig: { url: 'http://127.0.0.1:3201' } },
          ]),
        };
      }

      return { ok: true, text: async () => '' };
    });

    const { ensureEpicReviewerNativeAdapter } = await import('./adapter-config');
    await ensureEpicReviewerNativeAdapter();

    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/api/agents/epic-reviewer-id') && (init as any)?.method === 'PATCH'
    );

    expect(patchCall).toBeTruthy();
    const [, init] = patchCall!;
    const body = JSON.parse((init as any).body);

    expect(body.adapterType).toBe('codex_local');
    expect(body.adapterConfig.cwd).toBe('C:\\workspace');
    expect(body.adapterConfig.model).toBeUndefined();
    expect(body.adapterConfig.promptTemplate).toContain('Read the workspace directly');
    expect(body.adapterConfig.promptTemplate).toContain('PR-first');
    expect(body.adapterConfig.promptTemplate).toContain('Issue title');
    expect(body.adapterConfig.promptTemplate).toContain('Latest comment');
  });

  it('syncs scaffold architect, reviewer, and diff guardian to the native OpenCode adapter with trimmed prompts', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/api/companies/company-1/agents') && (!init || init.method !== 'PATCH')) {
        return {
          ok: true,
          json: async () => ([
            { id: 'scaffold-architect-id', name: 'Scaffold Architect', adapterType: 'http', adapterConfig: { url: 'http://127.0.0.1:3201' } },
            { id: 'reviewer-id', name: 'Reviewer', adapterType: 'http', adapterConfig: { url: 'http://127.0.0.1:3201' } },
            { id: 'diff-guardian-id', name: 'Diff Guardian', adapterType: 'http', adapterConfig: { url: 'http://127.0.0.1:3201' } },
          ]),
        };
      }

      return { ok: true, text: async () => '' };
    });

    const { ensureRepoAwareOpenCodeAdapters } = await import('./adapter-config');
    await ensureRepoAwareOpenCodeAdapters();

    const patchBodies = fetchMock.mock.calls
      .filter(([url, init]) => String(url).includes('/api/agents/') && (init as any)?.method === 'PATCH')
      .map(([, init]) => JSON.parse((init as any).body));

    expect(patchBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapterType: 'opencode_local',
        adapterConfig: expect.objectContaining({
          cwd: 'C:\\workspace',
          model: 'ollama/qwen3:8b',
          promptTemplate: expect.stringContaining('Issue title'),
        }),
      }),
      expect.objectContaining({
        adapterType: 'opencode_local',
        adapterConfig: expect.objectContaining({
          cwd: 'C:\\workspace',
          model: 'ollama/qwen3:8b',
          promptTemplate: expect.stringContaining('VERDICT: APPROVED'),
        }),
      }),
      expect.objectContaining({
        adapterType: 'opencode_local',
        adapterConfig: expect.objectContaining({
          cwd: 'C:\\workspace',
          model: 'ollama/qwen3:4b',
          promptTemplate: expect.stringContaining('Fail closed'),
        }),
      }),
    ]));
  });
});
