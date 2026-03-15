# Shop Diary AI Agent Orchestration

A fully autonomous, local AI software company powered by [Paperclip AI](https://paperclipai.dev) and [Ollama](https://ollama.ai) local LLMs. Manages the [shop-diary-v2](https://github.com/jeremiahdingal/shop-diary-v2) project through an automated pipeline of specialized AI agents.

## Architecture

```
                    Paperclip AI (:3100)
                         |
                   ollama-proxy (:3201)
                         |
                    Ollama GPU (:11434)
                   RTX 5070 Ti 16GB VRAM
```

### Pipeline Flow

```
Issue Created
     |
     v
Local Builder (pass 1) --> commit + push (NO PR yet)
     |                          |
     |                    build validation
     v
  Reviewer (code review)
     |
     v
  Artist (visual audit)
     |-- start Next.js dev server
     |-- Playwright screenshots (6 routes)
     |-- inject auth into localStorage
     |-- llama3.2-vision:11b analyzes each screen
     |
     v
Local Builder (pass 2) --> commit + push --> PR created
     |                                        |
     |                                  screenshots in PR body
     v
  Issue moved to in_review (pipeline complete)
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| **Strategist** | glm-4.7-flash | CTO-level planning and delegation |
| **Tech Lead** | qwen3:14b | Architecture decisions, task breakdown |
| **Local Builder** | qwen3:14b | Code generation, file writing, git workflow |
| **Reviewer** | qwen2.5-coder:14b | Code review against standards |
| **Artist** | llama3.2-vision:11b | Visual audit with Playwright screenshots |
| **Sentinel** | deepseek-r1:8b | Security and monitoring |
| **Deployer** | qwen3:8b | Deployment automation |

## Files

```
ollama-proxy.js      # Core proxy middleware (all automation logic)
shop-agents.cmd      # Windows control panel (Start/Stop/Status/Wake)
prompts/             # Agent system prompts
  strategist.txt
  tech-lead.txt
  local-builder.txt
  reviewer.txt
  artist.txt
  sentinel.txt
  deployer.txt
  coder-remote.txt
```

## Key Features

### ollama-proxy.js
- Sits between Paperclip and Ollama, enriching LLM calls with issue context
- Extracts code blocks from LLM output and writes files to disk
- Git workflow: branch creation, commit, push, build validation, PR creation
- Agent delegation detection and auto-reassignment
- Artist pipeline: Playwright screenshots + vision model analysis
- Auth injection for headless screenshot capture (bypasses login screen)
- Issue status guard (skips processing for completed issues)
- Concurrent processing lock (prevents duplicate Local Builder runs)
- Comment retry with backoff (handles transient fetch failures)
- Screenshots committed to PR branch and embedded in PR body

### shop-agents.cmd
- One-click Windows control panel
- Start/Stop/Restart all services (Ollama, Paperclip, Proxy)
- Live status dashboard with loaded models and active agents
- Manual agent wakeup with reason
- Live proxy log viewer

## Setup

### Prerequisites
- [Ollama](https://ollama.ai) with GPU support
- [Node.js](https://nodejs.org) 20+
- [Paperclip AI](https://paperclipai.dev) CLI (`npm i -g paperclipai`)
- [Playwright](https://playwright.dev) (installed in target workspace)
- [GitHub CLI](https://cli.github.com) (`gh`) authenticated

### Required Ollama Models
```bash
ollama pull qwen3:14b
ollama pull qwen2.5-coder:14b
ollama pull llama3.2-vision:11b
ollama pull deepseek-r1:8b
ollama pull qwen3:8b
ollama pull glm-4.7-flash
```

### Configuration
1. Update `WORKSPACE` in `ollama-proxy.js` to point to your project
2. Update `COMPANY_ID` and `AGENTS` with your Paperclip company/agent IDs
3. Update `AGENT_KEYS` with your agent API keys
4. Copy prompts to `~/.paperclip/prompts/` (or configure in Paperclip UI)

### Running
```cmd
shop-agents.cmd
```
Or manually:
```bash
# Terminal 1: Ollama
ollama serve

# Terminal 2: Paperclip
paperclipai run

# Terminal 3: Proxy
node ollama-proxy.js
```

## Ports

| Service | Port |
|---------|------|
| Paperclip UI & API | 3100 |
| Ollama Proxy | 3201 |
| Ollama GPU | 11434 |
| Dev Server (screenshots) | 3000 |

## Company

- **Company**: Shop (`ac5c469b-1f81-4f1f-9061-1dd9033ec831`)
- **Project**: shop-diary-v2 (TypeScript, Turborepo, Next.js 14, React Native, Cloudflare Workers)
