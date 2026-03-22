```
     ██████╗██╗      ██████╗ ███████╗███████╗██████╗ ██╗      ██████╗  ██████╗ ██████╗
    ██╔════╝██║     ██╔═══██╗██╔════╝██╔════╝██╔══██╗██║     ██╔═══██╗██╔═══██╗██╔══██╗
    ██║     ██║     ██║   ██║███████╗█████╗  ██║  ██║██║     ██║   ██║██║   ██║██████╔╝
    ██║     ██║     ██║   ██║╚════██║██╔══╝  ██║  ██║██║     ██║   ██║██║   ██║██╔═══╝
    ╚██████╗███████╗╚██████╔╝███████║███████║██████╔╝███████╗╚██████╔╝╚██████╔╝██║
     ╚═════╝╚══════╝ ╚═════╝ ╚══════╝╚══════╝╚═════╝ ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝
```

<p align="center">
  <strong>⚠️ Local AI agents are dumb. They hallucinate, break code, and get stuck in loops.</strong>
</p>

<p align="center">
  <em>ClosedLoop fixes this with orchestration — making 14B models outperform 70B models through RAG, build-green enforcement, and reflection memory. All local. All free.</em>
</p>

---

## 💡 The Problem

You've tried local AI coding. You know the pain:

- ❌ **Hallucinates imports** — generates code for APIs that don't exist
- ❌ **Breaks existing code** — deletes exports, ignores your patterns
- ❌ **Spins in circles** — tries the same broken fix 5 times
- ❌ **Can't handle multi-file work** — loses context across files

**This isn't the model's fault. It's the workflow.**

ClosedLoop isn't another agent. It's an **orchestration layer** that makes mediocre models produce elite results.

Think of it like this:
- **Individual agents** = junior devs (fast, cheap, make mistakes)
- **ClosedLoop system** = senior tech lead + code review + CI/CD + institutional memory

**The system is the product.**

---

## 🎯 The North Star

> **Make local AI agents actually usable for complex, multi-file development — without $300/month API bills.**

Most AI coding tools charge per token, cap your usage, or send your proprietary code to remote servers. ClosedLoop flips that model entirely:

- 💰 **$0/month** — no API keys, no subscriptions, no per-token billing
- 🔒 **Your code stays on your machine** — zero data leaves your network
- 🖥️ **Consumer hardware** — runs on a PC with a decent GPU (16GB+ VRAM recommended)
- ♾️ **Unlimited usage** — run it 24/7, no rate limits, no quotas
- 🤖 **Full autonomy** — from issue ticket to merged PR, hands-free

---

## 🎯 Why ClosedLoop Exists

Most local AI coding tools just wrap Ollama and call it a day. Then they wonder why the AI:
- Writes code that doesn't build
- Repeats the same mistakes
- Hallucinates your entire codebase

ClosedLoop was built on one principle: **Orchestration > Model Size**

A 14B model with:
- RAG grounding (sees your actual code)
- Build-green enforcement (can't ship broken code)
- Reflection memory (learns from rejections)
- Multi-agent handoffs (specialized roles)

...will outperform a 70B model thrown at the problem raw.

This is the difference between "AI coding" and "AI engineering."

---

## ⚡ What Is ClosedLoop?

ClosedLoop is an **autonomous multi-agent coding system** that orchestrates 9 specialized AI agents to take a task from idea to deployed code — all running locally on your machine using [Ollama](https://ollama.ai).

Think of it as your own private AI engineering team:

```
  📋 Issue Created
       │
       ▼
  ┌─────────────────┐
  │ 🧭 Complexity   │──── Simple bug?  ────▶ Straight to Strategist
  │    Router        │──── Greenfield app? ─▶ Remote Architect (GLM-5)
  └────────┬────────┘──── CRUD entity? ────▶ Scaffold Engine (zero-shot)
           │
           ▼
  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
  │ 🧠 Strategist   │────▶│ 📐 Tech Lead    │────▶│ 🔨 Local Builder│
  │    (CTO)        │     │    (Architect)   │     │    (Engineer)   │
  └─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                           │
                          RAG Context + Reflection Memory ──┘
                                                           │
                     ┌─────────────────────────────────────┤
                     │          Build Loop (up to 20 passes)
                     │                                     │
                     ▼                                     ▼
  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
  │ 📝 Reviewer     │────▶│ 🛡️ Diff Guardian │────▶│ 👁️ Visual       │
  │    (Quality)    │     │    (Policy Gate) │     │    Reviewer     │
  └─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                           │
                                                           ▼
                                                   🎉 PR Created & Merged
```

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         YOUR MACHINE (Consumer PC)                       │
│                                                                          │
│  ┌──────────────┐    ┌──────────────────────────────────────────────┐   │
│  │  📎 Paperclip │    │          ClosedLoop Proxy (port 3201)        │   │
│  │  AI Platform  │◄──►│                                              │   │
│  │  (port 3100)  │    │  ┌────────────┐  ┌────────────────────────┐ │   │
│  └──────────────┘    │  │ 🧠 RAG     │  │ 🔀 Delegation Engine  │ │   │
│                       │  │ (AST+KW)   │  │ (Org Chart Routing)   │ │   │
│  ┌──────────────┐    │  └────────────┘  └────────────────────────┘ │   │
│  │  🦙 Ollama   │    │  ┌────────────┐  ┌────────────────────────┐ │   │
│  │  LLM Server  │◄──►│  │ 📦 Git Ops │  │ 🏗️ Scaffold Engine    │ │   │
│  │  (port 11434) │    │  │ (Branch/PR) │  │ (Zero-Shot CRUD)      │ │   │
│  └──────────────┘    │  └────────────┘  └────────────────────────┘ │   │
│                       └──────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │              Bridge Server (port 3202)                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │   │
│  │  │ 🔄 Build Loop │  │ 💾 Sessions  │  │ 🆘 Remote Rescue     │ │   │
│  │  │ (Green Gate)  │  │ (Checkpoints) │  │ (GLM-5 Fallback)     │ │   │
│  │  └──────────────┘  └──────────────┘  └────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                     Your Project Workspace                        │   │
│  │  📁 Source Code  │  🧪 Tests  │  📊 .reflections/  │  📋 .tickets/│   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 🤖 The Agent Team

Each agent runs a different local model sized to its job — small models for routing, bigger models for code generation:

| Agent | Role | Model | Why This Model |
|-------|------|-------|----------------|
| 🧭 **Complexity Router** | Classifies incoming issues (bug vs. feature vs. epic) | `qwen3:4b` | Fast triage — only needs to output one routing decision |
| 🧠 **Strategist** | CTO — analyzes, plans, decomposes work | `qwen3.5:9b` | Newer architecture for better reasoning; planning doesn't need code-gen size |
| 📐 **Tech Lead** | Architect — specs, file lists, patterns | `deepcoder:14b` | Must understand codebase structure and dependencies |
| 🔨 **Local Builder** | Engineer — writes actual code | `deepcoder:14b` | Core code generation, burst mode uses `qwen3-coder:30b` |
| 📝 **Reviewer** | Quality gate — code review + build check | `glm-4.7:flash` | Fast, high-quality judgment for approve/reject decisions |
| 🛡️ **Diff Guardian** | Policy enforcer — mechanical diff validation | `qwen3:4b` | Checklist evaluation, no creative work needed |
| 👁️ **Visual Reviewer** | UI/UX auditor — screenshot analysis | `qwen3-vl:8b` | Vision model for visual regression and accessibility checks |
| 🔐 **Sentinel** | DevOps — CI/CD monitoring, security scans | `deepseek-r1:8b` | Reasoning model for root-cause analysis |
| 🚀 **Deployer** | Infrastructure — deployment execution | `qwen3:8b` | Script execution and infrastructure tasks |

### 🏢 Delegation Org Chart

Agents follow a strict hierarchy — no agent can skip levels:

```
                    🧭 Complexity Router
                           │
                    🧠 Strategist (CTO)
                    ┌──────┼──────────────┐
              📐 Tech Lead  📝 Reviewer   👁️ Visual Reviewer
                    │              │
              🔨 Local Builder  🛡️ Diff Guardian
                                   │
                              👁️ Visual Reviewer

              🔐 Sentinel ──▶ 🚀 Deployer
```

---

## ✨ Features — Why Each One Exists

### 🧠 RAG-Enhanced Code Generation
> **Problem:** LLMs hallucinate file paths, invent non-existent APIs, and ignore your project conventions.
>
> **Solution:** Before generating any code, ClosedLoop queries an AST-enhanced index of your entire codebase. The builder sees the top 10 most relevant existing files — their exports, function signatures, interface shapes, and patterns — grounding every generation in reality.

```bash
npm run rag-index   # Index your codebase (run once, re-run after major changes)
```

### 🔨 Scaffold Engine (Zero-Shot CRUD)
> **Problem:** CRUD APIs are boilerplate. Spending 20 LLM passes on routes/service/schema/types for a simple entity is wasteful.
>
> **Solution:** When the Complexity Router detects a CRUD ticket (entity + fields + table), the Scaffold Engine generates all files deterministically in one shot — no LLM needed. Routes, service layer, Zod schemas, DB types, enum entries, and index.ts registration. The builder only runs if the scaffold's build fails.

### 🧭 Three-Way Complexity Router
> **Problem:** A bug fix and a "build a whole app from scratch" are fundamentally different tasks, but they enter the same pipeline.
>
> **Solution:** Every incoming issue gets a complexity score (0–10) based on keyword signals. Three paths:
> - **Score < 7 + CRUD signals** → Scaffold Engine (zero-shot, no LLM)
> - **Score < 7** → Strategist (standard local pipeline)
> - **Score ≥ 7** → Remote Architect via GLM-5 (architecture spec first, then decompose)

### 📋 Goal/Epic Decomposition
> **Problem:** "Build a complete POS system" is too broad for a single builder pass.
>
> **Solution:** Issues tagged `[Goal]` or `[Epic]` (or scoring ≥ 7) are automatically decomposed into narrow, buildable sub-tickets. Each gets its own Paperclip issue, `.tickets/` spec file, and parent tracking. The system monitors all child tickets and auto-completes the parent when all children are done.

### 🔁 Build-Green Loop with Tried-Approaches Memory
> **Problem:** The builder writes code, the build fails, it tries the same broken approach again in circles.
>
> **Solution:** The bridge enforces a **build-green invariant** — code doesn't leave the builder until `yarn build` passes. Every failed attempt is recorded with its fingerprint, changed files, and error. On retry, the builder sees what it already tried and is instructed to take a different approach. Up to 20 passes before escalation.

### 🆘 Remote Rescue (GLM-5 Fallback)
> **Problem:** Local models get stuck on the same error. After 3+ identical failures, they need outside help.
>
> **Solution:** When the same build error fingerprint repeats 3+ times, ClosedLoop calls GLM-5 (via z.ai API) with the error context and touched files. The remote model provides a rescue fix that the local builder applies. Also fires as a last resort before human escalation at 20 passes. **Completely optional** — if no API key is set, the system continues locally.

### 📝 Reflection Memory
> **Problem:** The reviewer rejects code for "wrong import path" on Monday. On Tuesday, the builder makes the same mistake because it has no memory of past feedback.
>
> **Solution:** Every reviewer/diff guardian rejection saves a reflection to `.reflections/{component}.md`. On future builds touching those same files, the builder sees past feedback injected into its prompt. Reflections accumulate and are capped at 2KB per component to keep prompts lean.

### 💬 Communicative Dehallucination
> **Problem:** The builder assumes wrong things about the codebase and generates code based on those assumptions.
>
> **Solution:** The builder prompt includes a "Pre-Flight Check" — before writing any code, the LLM must list which files it will modify vs. create, and state its assumptions explicitly. This forces the model to reason about the codebase before generating, catching misunderstandings early. Inspired by the [ChatDev](https://github.com/OpenBMB/ChatDev) pattern.

### 🛡️ Diff Guardian (Policy Gate)
> **Problem:** The reviewer says "looks good" but the diff contains `console.log` spam, deleted exports, secrets in code, or scope creep.
>
> **Solution:** Diff Guardian runs a mechanical checklist — no subjective judgment:
> - All files `.ts`/`.tsx` (no `.js` drift)
> - No secrets or API keys in diff
> - No debug code (`console.log`, `TODO`)
> - Deletion ratio < 70% per file
> - All existing exports preserved
> - No parallel/duplicate files
> - Scope matches issue description

### 👁️ Visual Reviewer (Playwright Screenshots)
> **Problem:** Code passes build and review, but the UI is broken — wrong layout, missing elements, accessibility failures.
>
> **Solution:** The Visual Reviewer uses a vision LLM (`qwen3-vl:8b`) to analyze Playwright screenshots of every app route. Checks layout quality, color harmony, typography hierarchy, WCAG AA contrast (4.5:1), touch target sizes (44px+), and design system adherence.

### ⏪ Auto-Revert on Rejection
> **Problem:** Reviewer rejects the code, sends it back to builder, but the workspace still has the broken changes. The next build attempt starts from a corrupted state.
>
> **Solution:** When reviewer or diff guardian rejects, the workspace is automatically reverted to the last green (build-passing) checkpoint. The builder always starts fresh from known-good state.

### 🌐 Bridge ↔ Proxy Git Deduplication
> **Problem:** Both the proxy and the bridge had their own git logic — branching, committing, pushing. Two implementations, two places for bugs.
>
> **Solution:** The bridge delegates all git operations to the proxy's `/git/sync` endpoint via HTTP. One source of truth for branch naming, commit messages, and push logic. The bridge sends file contents; the proxy handles the rest.

### 🔀 Remote Flag Propagation
> **Problem:** A complex issue enters through the Remote Architect path. By the time it reaches the Local Builder 3 delegation hops later, the system has forgotten it was a complex issue that needs special handling.
>
> **Solution:** `issueRemoteFlags` tracks which issues came through the complex path. The flag persists across delegation hops (Strategist → Tech Lead) and is consumed when reaching the Local Builder — activating burst model override and special handling. Intermediate agents don't lose the context.

### 💥 Burst Model Support
> **Problem:** Small local models (14B) struggle with greenfield code generation. Large models (30B) are too slow for iterative repair passes.
>
> **Solution:** First pass of a greenfield scaffold task uses `qwen3-coder:30b` (burst mode) for maximum generation quality. Subsequent repair passes drop to `deepcoder:14b` for fast iteration. Best of both worlds — quality for the initial generation, speed for fixes.

### 🧪 134-Test Safety Net
> **Problem:** Rapid refactoring across 15+ modules risks breaking things silently.
>
> **Solution:** Comprehensive test suite covering all pure-logic modules:
> - `utils.test.ts` — slugify, truncate, safeJsonParse, normalizeRoute, extractIssueId
> - `complexity-router.test.ts` — scoring for bugs, cosmetic, CRUD, greenfield, epics
> - `scaffold-engine.test.ts` — CRUD generation, config detection, patching
> - `epic-decomposer.test.ts` — ticket parsing from various formats
> - `delegation.test.ts` — org chart enforcement, remote flag propagation
> - `code-extractor.test.ts` — package.json validation, destructive change detection
> - `agent-contracts.test.ts` — JSON contract parsing, formatting, keyword fallback
> - `test-first.test.ts` — acceptance test spec parsing, vitest output parsing
> - `ast-indexer.test.ts` — function/interface/enum/import extraction
> - `success-tracker.test.ts` — outcome recording, model stats, threshold recommendations

### 🖥️ Control Panel (closedloop.cmd)
> **Problem:** Managing Ollama + Paperclip + ClosedLoop + Bridge manually is tedious.
>
> **Solution:** Windows batch script with menu-driven control — start/stop all services, check status, wake agents, view logs, build RAG index. One command to rule them all.

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **GPU VRAM** | 8GB (7B models only) | 16GB+ (run 14B-30B models) |
| **RAM** | 16GB | 32GB |
| **Storage** | 20GB for models | 50GB+ for model variety |
| **Node.js** | 18+ | 20+ |
| **OS** | Windows 10/11 | Windows 11 |

### Installation

```bash
# 1. Clone
git clone https://github.com/jeremiahdingal/closedloop.git
cd closedloop

# 2. Install dependencies
npm install

# 3. Pull the models you need (pick based on your VRAM)
ollama pull qwen3:4b            # Routing + Diff Guardian (2.5GB)
ollama pull qwen3.5:9b          # Strategist (6.6GB) — newest architecture for planning
ollama pull deepcoder:14b       # Tech Lead + Local Builder (9GB)
ollama pull glm-4.7:flash       # Reviewer — fast approve/reject decisions
ollama pull qwen3-vl:8b         # Visual Reviewer (5GB)
ollama pull nomic-embed-text    # RAG embeddings (300MB)

# 4. Build
npm run build

# 5. Index your codebase for RAG
npm run rag-index

# 6. Start ClosedLoop
npm start
```

### Configuration

Edit `.paperclip/project.json`:

```json
{
  "project": {
    "name": "Your Project",
    "workspace": "C:\\path\\to\\your\\project"
  },
  "paperclip": {
    "apiUrl": "http://127.0.0.1:3100",
    "companyId": "your-company-id",
    "agents": {
      "strategist": "agent-uuid",
      "tech lead": "agent-uuid",
      "local builder": "agent-uuid",
      "reviewer": "agent-uuid",
      "diff guardian": "agent-uuid",
      "visual reviewer": "agent-uuid",
      "sentinel": "agent-uuid",
      "deployer": "agent-uuid",
      "complexity router": "agent-uuid",
      "scaffold architect": "agent-uuid"
    }
  },
  "ollama": {
    "proxyPort": 3201,
    "ollamaPort": 11434,
    "models": {
      "strategist": "qwen3.5:9b",
      "tech lead": "deepcoder:14b",
      "local builder": "deepcoder:14b",
      "local builder burst": "qwen3-coder:30b",
      "reviewer": "glm-4.7:flash",
      "diff guardian": "qwen3:4b",
      "visual reviewer": "qwen3-vl:8b",
      "complexity router": "qwen3:4b"
    }
  }
}
```

### Optional: Remote Rescue (GLM-5)

For the escape-hatch when local models get stuck:

```bash
set Z_AI_API_KEY=your-zhipu-ai-key   # z.ai API key
```

This is **100% optional**. Without it, ClosedLoop runs fully offline — rescue just falls through to the local retry loop.

---

## 📁 Module Structure

```
closedloop/
├── src/
│   ├── index.ts              # 🚪 Entry point, RAG init
│   ├── proxy-server.ts       # 🔀 HTTP proxy, agent routing, delegation hooks
│   ├── agent-types.ts        # 🤖 Agent IDs, org chart, delegation rules
│   ├── delegation.ts         # 📨 Detect & execute agent handoffs
│   ├── config.ts             # ⚙️  Project configuration loader
│   ├── types.ts              # 📝 TypeScript interfaces
│   ├── context-builder.ts    # 🧠 RAG-enhanced prompt building
│   ├── rag-indexer.ts        # 📊 File-based RAG indexing with AST boost
│   ├── ast-indexer.ts        # 🌳 Regex-based AST extraction (functions, interfaces, enums)
│   ├── agent-contracts.ts    # 📐 Typed JSON schemas for inter-agent communication
│   ├── test-first.ts         # 🧪 Acceptance test parsing, writing, and execution
│   ├── success-tracker.ts    # 📈 Model success rate tracking and threshold tuning
│   ├── code-extractor.ts     # 📦 Parse FILE: blocks from LLM output
│   ├── git-ops.ts            # 🔀 Branch, commit, PR creation
│   ├── bash-executor.ts      # 💻 Safe shell command execution
│   ├── scaffold-engine.ts    # 🏗️  Zero-shot CRUD generation
│   ├── goal-system.ts        # 📋 Epic decomposition + complexity scoring
│   ├── epic-decomposer.ts    # ✂️  Parse sub-tickets from strategist output
│   ├── remote-ai.ts          # 🌐 GLM-5 remote architect integration
│   ├── artist-recorder.ts    # 🎬 Playwright screenshot capture
│   └── diff-guardian.ts      # 🛡️  Policy validation engine
├── packages/
│   └── bridge/
│       └── src/
│           ├── index.ts      # 🌉 Webhook server (port 3202)
│           └── session.ts    # 🔄 Build loop, sessions, rescue, reflections
├── prompts/                  # 📜 Agent system prompts
│   ├── strategist.txt
│   ├── tech-lead.txt
│   ├── local-builder.txt
│   ├── reviewer.txt
│   ├── diff-guardian.txt
│   ├── visual-reviewer.txt
│   ├── complexity-router.txt
│   ├── sentinel.txt
│   └── deployer.txt
├── closedloop.cmd            # 🖥️  Windows control panel
└── .paperclip/
    └── project.json          # ⚙️  Single source of truth for config
```

---

## 🧪 Testing

```bash
# Run all 134 tests
npx vitest run

# Watch mode during development
npx vitest --watch
```

| Test Suite | Tests | What It Covers |
|------------|-------|----------------|
| `utils.test.ts` | 16 | String utils, JSON parsing, ID extraction |
| `complexity-router.test.ts` | 10 | Scoring bugs vs features vs greenfield vs epics |
| `scaffold-engine.test.ts` | 20 | CRUD generation, config detection, file patching |
| `epic-decomposer.test.ts` | 7 | Ticket parsing from markdown/numbered lists |
| `delegation.test.ts` | 7 | Org chart enforcement, remote flag propagation |
| `code-extractor.test.ts` | 9 | Package.json validation, destructive change detection |
| `agent-contracts.test.ts` | 16 | JSON contract parsing, formatting, keyword fallback |
| `test-first.test.ts` | 11 | Acceptance test spec parsing, vitest output parsing |
| `ast-indexer.test.ts` | 16 | Function/interface/enum/import AST extraction |
| `success-tracker.test.ts` | 13 | Outcome recording, model stats, threshold tuning |

---

## 💡 Design Philosophy

1. **Local-first, cloud-optional** — Everything runs on your machine. Remote APIs are escape hatches, not dependencies.
2. **Right-sized models** — A 4B model can route. A 14B model can code. Don't waste VRAM on tasks that don't need it.
3. **Build-green invariant** — Code doesn't leave the builder until the build passes. No exceptions.
4. **Memory over repetition** — Tried-approaches and reflection memory prevent the same mistake twice.
5. **Mechanical gates over subjective review** — Diff Guardian uses checklists, not opinions. Objective, repeatable, fast.
6. **Fail gracefully** — Remote rescue is optional. Burst mode is optional. Every feature degrades to the local baseline.

---

## 📊 Cost Comparison

| Approach | Monthly Cost | Privacy | Offline | Unlimited |
|----------|-------------|---------|---------|-----------|
| GPT-4 API | $50-500+ | ❌ Code sent to OpenAI | ❌ | ❌ Rate limited |
| Claude API | $50-300+ | ❌ Code sent to Anthropic | ❌ | ❌ Rate limited |
| GitHub Copilot | $19/user | ❌ Code sent to GitHub | ❌ | ⚠️ Fair use limits |
| Cursor Pro | $20/user | ❌ Code sent to cloud | ❌ | ⚠️ Fast request limits |
| **ClosedLoop** | **$0** | ✅ **Fully local** | ✅ **Yes** | ✅ **Unlimited** |

*One-time cost: a GPU that can run 14B+ models (RTX 3060 12GB ~$200 used, RTX 4060 Ti 16GB ~$400)*

---

### 📐 Structured JSON Communication (MetaGPT Pattern)
> **Problem:** Agents pass instructions in freeform text. Small local models misinterpret vague instructions, causing extra review loops.
>
> **Solution:** Typed JSON contracts between agents — `TicketSpec` (Strategist → Tech Lead), `BuildManifest` (Tech Lead → Builder), `ReviewVerdict` (Reviewer), `DiffVerdict` (Diff Guardian). Parsers extract JSON from LLM output with keyword fallback for when the model outputs freeform text instead.

### 🧪 Test-First Workflow
> **Problem:** "Build passes" is a weak exit condition — code can build but be logically wrong.
>
> **Solution:** Tech Lead can define acceptance tests (`TEST:` blocks) before the builder writes code. Tests are written to the workspace and run alongside the build. The builder's exit condition becomes "build passes AND tests pass." Test results are injected into retry prompts.

### 🌳 AST-Based RAG Indexing
> **Problem:** Flat text search misses structural queries like "find all functions that accept orderId."
>
> **Solution:** RAG index now extracts function signatures (with params and return types), interface field shapes, enum values, and import relationships using regex-based AST parsing. AST matches get a 2x scoring boost in RAG queries, surfacing structurally relevant files first.

### 📈 Success Rate Tracking
> **Problem:** The complexity routing threshold (score >= 7 → remote) is a static guess. No data on whether it's right.
>
> **Solution:** Every task outcome is recorded: model used, complexity score, pass count, whether rescue was needed. A threshold recommendation engine analyzes boundary performance and suggests raising/lowering the threshold based on real data. Confidence levels (low/medium/high) prevent premature adjustments.

---

## 🗺️ Roadmap

See [IMPROVEMENTS.md](IMPROVEMENTS.md) for the full backlog. Highlights:

- 🔀 **Parallel worktree exploration** — Spawn multiple builder instances, pick the best result
- 🧪 **Property-based testing in Diff Guardian** — Generate Hypothesis-style property tests for changed code
- 📜 **Event-sourced state** — Full audit trail, replay from any point

---

## 🤝 Contributing

ClosedLoop is open source. Contributions welcome:

1. Fork the repository
2. Create a feature branch
3. Run `npx vitest run` to verify tests pass
4. Submit a PR

---

<p align="center">
  <strong>Built for developers who believe AI should work for you — not bill you.</strong>
</p>

<p align="center">
  <sub>⭐ Star this repo if you believe local AI is the future of software development.</sub>
</p>

## License

MIT
