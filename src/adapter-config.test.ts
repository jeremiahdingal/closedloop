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
    strategist: 'strategist-id',
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
});
