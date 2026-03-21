# ClosedLoop

Local-first autonomous coding system. Paperclip agents orchestrated through Ollama, with a bridge runtime that keeps Local Builder in a build-fix loop until green.

## Pipeline

```
Complexity Router → Strategist → Tech Lead → Local Builder → (build green) → Reviewer → Diff Guardian → Visual Reviewer → PR
```

## Agents

| Agent | Model | Role |
|---|---|---|
| Complexity Router | qwen3:4b | Triage — routes to Strategist or Remote Architect |
| Strategist | qwen3:8b | CTO — decomposes goals, delegates to Tech Lead |
| Tech Lead | deepcoder:14b | Translates strategy into implementation tasks |
| Local Builder | qwen2.5-coder:14b | Writes code, must build green before handoff |
| Reviewer | rnj-1:8b | Code quality review (only sees green builds) |
| Diff Guardian | qwen3:4b | Policy gate — no secrets, no scope creep, no parallel files |
| Visual Reviewer | qwen3-vl:8b | Screenshot-based UI/UX audit |
| Sentinel | deepseek-r1:8b | DevOps, CI/CD monitoring |
| Deployer | qwen3:8b | Deployment execution |
| Coder Remote | GLM-5 (z.ai) | Complex/greenfield architecture (remote) |

## Architecture

### `src/` — ClosedLoop Proxy (:3201)

Ollama proxy that intercepts agent ↔ LLM traffic. Handles:
- Agent identification and model routing
- Issue context injection (RAG-enriched)
- Delegation detection and auto-reassignment
- Reviewer approval → Diff Guardian → Visual Reviewer pipeline
- Bash command execution for diagnostic agents

### `packages/bridge/` — Builder Bridge (:3202)

Reliability runtime for Local Builder. Owns the build-green invariant:
- Webhook intake from proxy
- Per-issue session directories with state persistence
- Builder retry loop with checkpoints
- Build execution, error fingerprinting, targeted repair
- Remote rescue via GLM-5 (z.ai) after 3 repeated identical errors
- Paperclip comment posting and reassignment on completion

### `.paperclip/project.json` — Single source of truth

All agent IDs, model assignments, delegation rules, timeouts, and workspace config.

## Quick Start

### Prerequisites

- Node.js 18+
- Ollama (with models pulled)
- Paperclip
- Git

### Install & Build

```bash
npm install
npm run build
cd packages/bridge && npm install && npm run build && cd ../..
```

### Run

Use the control panel:
```bash
closedloop.cmd
```

Or manually:
```bash
# Terminal 1: ClosedLoop proxy
node dist/index.js

# Terminal 2: Builder bridge
node packages/bridge/dist/index.js
```

### Environment

Create `.env` in repo root:
```
Z_AI_API_KEY=your_z_ai_key_here
```

### Configuration

Edit `.paperclip/project.json`:
- `project.workspace` — path to target codebase
- `paperclip.agents` — agent UUIDs from Paperclip
- `paperclip.agentKeys` — agent API tokens
- `ollama.models` — model assignments per agent
- `delegationRules` — org chart routing

## Key Design Decisions

1. **Build-green invariant** — Local Builder never hands off on a red build. The bridge enforces this mechanically, not via prompts.
2. **Two-system split** — Proxy handles planning agents (Strategist, Tech Lead, Reviewer). Bridge handles execution (Local Builder build loop).
3. **Config-driven** — `project.json` is the single source of truth. Swap projects by editing one file and rebuilding RAG.
4. **Remote rescue** — After 3 identical build failures, GLM-5 via z.ai provides a fresh perspective before escalating to human.
5. **Diff Guardian as gate** — Mechanical policy enforcement between Reviewer approval and PR creation. No scope creep, no secrets, no parallel files.

## File Guide

```
src/
  index.ts          — entry point, starts proxy + background checker
  proxy-server.ts   — HTTP proxy, pipeline orchestration
  config.ts         — project.json loader
  agent-types.ts    — agent IDs, aliases, delegation rules
  delegation.ts     — auto-reassignment on delegation keywords
  diff-guardian.ts   — destructive change detection
  artist-recorder.ts — Playwright screenshot recorder
  context-builder.ts — RAG context injection
  git-ops.ts        — branch/commit/PR creation
  rag-indexer.ts    — codebase indexing

packages/bridge/
  src/index.ts      — webhook server
  src/session.ts    — builder session lifecycle, retry loop

prompts/            — agent system prompts with org charts
.paperclip/         — project config (gitignored)
closedloop.cmd      — Windows control panel
```
