/**
 * ClosedLoop Bridge - Paperclip to pi-mono webhook adapter
 * Simple version without type imports
 */

import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSession } from './session';

const app = express();
const PORT = process.env.PORT || 3202;
const CONFIG_PATH = join(__dirname, '..', '..', '..', '.paperclip', 'project.json');

type AgentIds = {
  builder: string;
  reviewer: string;
  diffGuardian: string;
  complexityRouter: string;
};

function loadAgentIds(): AgentIds {
  const fallback = {
    builder: 'caf931bf-516a-409f-813e-a29e14decb10',
    reviewer: 'eace3a19-bded-4b90-827e-cfc00f3900bd',
    diffGuardian: 'f8a2c4e6-9b1d-4f3a-8e5c-2d7b6a9c0e1f',
    complexityRouter: '',
  };

  if (!existsSync(CONFIG_PATH)) {
    return fallback;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as any;
    const agents = parsed.paperclip?.agents || parsed.closedloop?.agents || {};

    return {
      builder: agents.localBuilder || agents['local builder'] || fallback.builder,
      reviewer: agents.reviewer || fallback.reviewer,
      diffGuardian: agents.diffGuardian || agents['diff guardian'] || fallback.diffGuardian,
      complexityRouter: agents.complexityRouter || agents['complexity router'] || fallback.complexityRouter,
    };
  } catch {
    return fallback;
  }
}

const AGENT_IDS = loadAgentIds();

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'closedloop-bridge' });
});

// Paperclip webhook: issue assigned to any agent
app.post('/webhook/issue-assigned', async (req, res) => {
  console.log('[webhook] === REQUEST START ===');
  try {
    const { issueId, assigneeAgentId, title, description } = req.body;
    console.log('[webhook] Parsed body: issue=' + issueId);

    console.log('[webhook] Received: issue=' + issueId + ', agent=' + assigneeAgentId);

    // Determine role from assignee
    let role = 'builder';
    if (assigneeAgentId === AGENT_IDS.reviewer) {
      role = 'reviewer';
      console.log('[webhook] Role: reviewer');
    } else if (assigneeAgentId === AGENT_IDS.diffGuardian) {
      role = 'diff-guardian';
      console.log('[webhook] Role: diff-guardian');
    } else if (AGENT_IDS.complexityRouter && assigneeAgentId === AGENT_IDS.complexityRouter) {
      // Complexity Router is handled by ollama-proxy, not the bridge — ignore here
      console.log('[webhook] Ignoring: complexity-router handled by proxy');
      return res.status(200).send('OK (ignored - complexity router)');
    } else if (assigneeAgentId !== AGENT_IDS.builder) {
      console.log('[webhook] Ignoring: not a handled agent (' + assigneeAgentId + ')');
      return res.status(200).send('OK (ignored)');
    } else {
      console.log('[webhook] Role: builder');
    }
    
    console.log('[webhook] Spawning ' + role + ' session for ' + issueId);
    
    // Spawn session for this role
    await spawnSession({
      issueId: issueId,
      title: title || 'Untitled',
      description: description || '',
      workspace: process.env.WORKSPACE || 'C:\\Users\\dinga\\Projects\\shop-diary-v3',
      role: role,
    });
    
    console.log('[webhook] Session spawned for ' + issueId + ' (' + role + ')');
    res.status(200).send('OK');
  } catch (err: any) {
    console.error('[webhook] Error:', err.message);
    console.error('[webhook] Full error:', err);
    console.error('[webhook] Stack:', err.stack);
    res.status(500).send('Error: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log('[bridge] Listening on port ' + PORT);
  console.log('[bridge] Webhook endpoint: POST /webhook/issue-assigned');
});
