# ClosedLoop - Autonomous Local-First Coding Agent

```
     ██████╗██╗      ██████╗ ███████╗███████╗██████╗ ██╗      ██████╗  ██████╗ ██████╗
    ██╔════╝██║     ██╔═══██╗██╔════╝██╔════╝██╔══██╗██║     ██╔═══██╗██╔═══██╗██╔══██╗
    ██║     ██║     ██║   ██║███████╗█████╗  ██║  ██║██║     ██║   ██║██║   ██║██████╔╝
    ██║     ██║     ██║   ██║╚════██║██╔══╝  ██║  ██║██║     ██║   ██║██║   ██║██╔═══╝
    ╚██████╗███████╗╚██████╔╝███████║███████║██████╔╝███████╗╚██████╔╝╚██████╔╝██║
     ╚═════╝╚══════╝ ╚═════╝ ╚══════╝╚══════╝╚═════╝ ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝
```

**Local AI coding agent with orchestration.** Runs on Ollama + Paperclip. No API bills.

---

## Current Status

**🚧 In Development** - Not production ready

This is a simplified version that focuses on native adapters with intelligent guardrails.

---

## Architecture

```
Goal → Epic Decoder → Local Builder → Reviewer → Epic Reviewer → PR → Done
         (Direct CLI)    (Native)       (Native)     (Native)
```

### Simplified Agent Flow

1. **Epic Decoder** - Decomposes goals into tickets (Direct CLI)
2. **Local Builder / Scaffold Architect** - Writes code (Native adapter)
3. **Reviewer** - Reviews per-ticket (Native adapter)
4. **Epic Reviewer** - Reviews entire epic holistically (Native adapter)
5. **PR Creation** - After approval

---

## What's Implemented

- ✅ Smart git staging (only .ts/.tsx files)
- ✅ Output parsing (`[STATE:]` blocks)
- ✅ LLM fallback when no state block
- ✅ Agent Doctor for stuck run diagnosis
- ✅ Pre-execution context files (`.closedloop/context.json`)
- ✅ PR creation after approval
- ✅ Epic Reviewer integration

---

## Key Files

```
src/
  index.ts              - Main entry point
  proxy-server.ts       - HTTP proxy
  run-guardrails.ts    - Orchestration & monitoring
  output-parser.ts     - Parse model output
  during-execution.ts  - Monitor active runs
  pre-execution.ts     - Generate context files
  epic-decoder.ts      - Goal decomposition
  epic-reviewer.ts     - Epic-level review
  git-ops.ts           - Git operations
  paperclip-api.ts     - Paperclip client
  remote-ai.ts        - Ollama/Codex wrapper
```

---

## Requirements

- **Ollama** - Local LLM (qwen3:8b, qwen2.5-coder:7b)
- **Paperclip** - Issue tracking
- **GitHub** - PR creation
- **16GB+ VRAM** recommended

---

## Configuration

See `config.yaml` for:
- Paperclip API URL
- Ollama port
- Agent model assignments

---

## Output Format

Agents should output state blocks:

```
[STATE: done|in_review|blocked|todo]
[SUMMARY: Brief description]
[FILES: file1.ts, file2.ts]
```

Reviewers:

```
[STATE: approved|rejected]
[FEEDBACK: Review comments]
```

---

## Fallback Behavior

- **Builder**: No `[STATE:]` → LLM classifies → defaults to `in_review`
- **Reviewer**: No `[STATE:]` → LLM classifies → defaults to `rejected`

---

## Testing

```bash
npm run build
npm start
```

---

## The Problem We Solve

Local AI coding agents:
- Hallucinate imports
- Break existing code
- Spin in circles
- Can't handle multi-file work

ClosedLoop adds orchestration:
- Output parsing and validation
- Agent Doctor for stuck runs
- Epic-level review before merge
- Smart git staging

---

## Roadmap

- [ ] End-to-end testing
- [ ] Drift detection
- [ ] Import validation
- [ ] Visual review integration
