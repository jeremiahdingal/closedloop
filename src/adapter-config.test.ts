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
    'scaffold architect': 'scaffold-architect-id',
    strategist: 'strategist-id',
    reviewer: 'reviewer-id',
    'diff guardian': 'diff-guardian-id',
    'epic reviewer': 'epic-reviewer-id',
  },
}));

describe('adapter-config', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('keeps Epic Reviewer out of the HTTP adapter sync list', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/api/companies/company-1/agents') && (!init || init.method !== 'PATCH')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'strategist-id',
              name: 'Strategist',
              adapterType: 'http',
              adapterConfig: { url: 'http://bad.local' },
            },
            {
              id: 'reviewer-id',
              name: 'Reviewer',
              adapterType: 'http',
              adapterConfig: { url: 'http://127.0.0.1:3201' },
            },
            {
              id: 'diff-guardian-id',
              name: 'Diff Guardian',
              adapterType: 'http',
              adapterConfig: { url: 'http://127.0.0.1:3201' },
            },
            {
              id: 'epic-reviewer-id',
              name: 'Epic Reviewer',
              adapterType: 'codex_local',
              adapterConfig: { cwd: 'C:\\workspace' },
            },
          ]),
        };
      }

      return { ok: true, text: async () => '' };
    });

    const { ensureOrchestrationHttpAdapters } = await import('./adapter-config');
    await ensureOrchestrationHttpAdapters();

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).includes('/api/agents/epic-reviewer-id') && (init as any)?.method === 'PATCH'
      )
    ).toBe(false);

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).includes('/api/agents/strategist-id') && (init as any)?.method === 'PATCH'
      )
    ).toBe(true);

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).includes('/api/agents/reviewer-id') && (init as any)?.method === 'PATCH'
      )
    ).toBe(false);

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).includes('/api/agents/diff-guardian-id') && (init as any)?.method === 'PATCH'
      )
    ).toBe(false);
  });

  it('syncs Epic Reviewer to the native local adapter with a compact prompt', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/api/companies/company-1/agents') && (!init || init.method !== 'PATCH')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'epic-reviewer-id',
              name: 'Epic Reviewer',
              adapterType: 'http',
              adapterConfig: { url: 'http://127.0.0.1:3201' },
            },
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
  });

  it('syncs scaffold architect, reviewer, and diff guardian to the native OpenCode adapter with trimmed prompts', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/api/companies/company-1/agents') && (!init || init.method !== 'PATCH')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'scaffold-architect-id',
              name: 'Scaffold Architect',
              adapterType: 'http',
              adapterConfig: { url: 'http://127.0.0.1:3201' },
            },
            {
              id: 'reviewer-id',
              name: 'Reviewer',
              adapterType: 'http',
              adapterConfig: { url: 'http://127.0.0.1:3201' },
            },
            {
              id: 'diff-guardian-id',
              name: 'Diff Guardian',
              adapterType: 'http',
              adapterConfig: { url: 'http://127.0.0.1:3201' },
            },
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
          promptTemplate: expect.stringContaining('Read the workspace directly'),
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
