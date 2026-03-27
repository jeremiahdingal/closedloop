import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch and config before importing delegation
vi.mock('./config', () => ({
  getPaperclipApiUrl: () => 'http://localhost:3100',
  loadConfig: () => ({
    project: { name: 'Test' },
    paperclip: { apiUrl: 'http://localhost:3100', companyId: 'test-co', agents: {}, agentKeys: {} },
    ollama: { models: {}, ports: {}, timeouts: {} },
  }),
  getAgents: () => ({
    strategist: 'strat-id',
    'tech lead': 'tech-id',
    'local builder': 'builder-id',
    reviewer: 'reviewer-id',
    'diff guardian': 'dg-id',
    sentinel: 'sentinel-id',
    deployer: 'deployer-id',
    'visual reviewer': 'vr-id',
    'complexity router': 'cr-id',
    'scaffold architect': 'sa-id',
  }),
  getBlockedAgents: () => [],
  getDelegationRules: () => ({
    strategist: ['tech lead', 'reviewer', 'visual reviewer'],
    'tech lead': ['local builder'],
    reviewer: ['diff guardian'],
  }),
  getOllamaPorts: () => ({ proxyPort: 3201, ollamaPort: 11434 }),
  getAgentModel: () => undefined,
  getBurstModel: () => undefined,
  getRemoteBuilderModel: () => 'glm-5',
  getWorkspace: () => '/tmp/test',
  getCompanyId: () => 'test-co',
  getArtistConfig: () => ({}),
}));

// Import after mocks
import { AGENTS, DELEGATION_RULES, AGENT_ALIASES, issueRemoteFlags, issueBuilderModelOverrides, issueBuilderBurstMode } from './agent-types';
import { detectAndDelegate } from './delegation';

describe('detectAndDelegate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => '' });
    vi.stubGlobal('fetch', fetchMock);
    // Clear shared state
    issueRemoteFlags.clear();
    issueBuilderModelOverrides.clear();
    issueBuilderBurstMode.clear();
  });

  it('delegates when content mentions a valid target', async () => {
    const stratId = AGENTS.strategist;
    const delegated = await detectAndDelegate('issue-1', stratId, 'Please hand this to the **Tech Lead** for implementation.');

    expect(delegated).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/issues/issue-1'),
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('does not delegate to agents outside the org chart', async () => {
    const stratId = AGENTS.strategist;
    // Strategist cannot delegate to "local builder" directly (must go through tech lead)
    const delegated = await detectAndDelegate('issue-2', stratId, 'Send to the deployer for release.');

    // deployer is not in strategist's allowed targets
    expect(delegated).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not delegate when no agent names found', async () => {
    const stratId = AGENTS.strategist;
    const delegated = await detectAndDelegate('issue-3', stratId, 'This looks good, no further action needed.');
    expect(delegated).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips markdown formatting when detecting agents', async () => {
    const stratId = AGENTS.strategist;
    const delegated = await detectAndDelegate('issue-4', stratId, 'Route this to **Tech Lead** for review.');
    expect(delegated).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('propagates remote flag when delegating to local builder', async () => {
    const techId = AGENTS['tech lead'];
    issueRemoteFlags.set('issue-5', 'glm-5');

    const delegated = await detectAndDelegate('issue-5', techId, 'Send to the local builder for implementation.');

    expect(delegated).toBe(true);
    expect(issueBuilderModelOverrides.get('issue-5')).toBe('glm-5');
    expect(issueBuilderBurstMode.has('issue-5')).toBe(true);
    expect(issueRemoteFlags.has('issue-5')).toBe(false); // consumed
  });

  it('keeps remote flag for intermediate hops', async () => {
    const stratId = AGENTS.strategist;
    issueRemoteFlags.set('issue-6', 'glm-5');

    // Strategist delegates to Tech Lead (not Local Builder)
    const delegated = await detectAndDelegate('issue-6', stratId, 'Send to the tech lead for breakdown.');

    // Remote flag should persist (not consumed yet)
    expect(delegated).toBe(true);
    expect(issueRemoteFlags.has('issue-6')).toBe(true);
    expect(issueBuilderModelOverrides.has('issue-6')).toBe(false);
  });

  it('reroutes "local builder" mention from Strategist to Tech Lead', async () => {
    const stratId = AGENTS.strategist;
    const delegated = await detectAndDelegate('issue-7', stratId, 'Send to the local builder for coding.');

    // Should have been rerouted to tech lead
    expect(delegated).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.assigneeAgentId).toBe(AGENTS['tech lead']);
  });
});
