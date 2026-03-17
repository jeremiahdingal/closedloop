# ClosedLoop

**Local-First, Ollama-Powered Autonomous Coding Agent**

ClosedLoop is a reliable, offline-capable AI agent system that automates your software development workflow using local LLMs (Ollama), Paperclip AI, and RAG (Retrieval-Augmented Generation) for grounded code generation.

## Features

- 🏠 **Local-First**: Runs entirely on your machine with Ollama - no cloud APIs required
- 🤖 **Ollama-Powered**: Supports 30B+ parameter models for high-quality code generation
- 📎 **Paperclip AI Integration**: Leverages Paperclip's agent orchestration system
- 🧠 **RAG-Enhanced**: Retrieves relevant codebase context to prevent hallucination
- ♾️ **Closed-Loop Workflow**: Plans → Builds → Reviews → Deploys → Audits → Repeats
- 🔒 **Privacy-Preserving**: Your code never leaves your machine

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ ClosedLoop Architecture                                     │
├─────────────────────────────────────────────────────────────┤
│ Paperclip AI Agents                                         │
│   Strategist → Tech Lead → Local Builder → Reviewer        │
│                          ↓                                  │
│   ┌─────────────────────────────────────────────┐          │
│   │ ClosedLoop (This Project)                   │          │
│   │  - RAG Context Builder (ChromaDB)           │          │
│   │  - Code Extraction & Validation             │          │
│   │  - Git Operations (branch, commit, PR)      │          │
│   │  - Bash Command Execution                   │          │
│   │  - Delegation Detection                     │          │
│   └─────────────────────────────────────────────┘          │
│                          ↓                                  │
│   Local Ollama Instance (qwen3-coder:30b, etc.)            │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

1. **Node.js 18+**
2. **Ollama** - Install from [ollama.ai](https://ollama.ai)
3. **Paperclip AI** - Install from [paperclip.ai](https://paperclip.ai)
4. **Git** - For version control operations

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/jeremiahdingal/closedloop.git
cd closedloop

# 2. Install dependencies
npm install

# 3. Pull required Ollama models
ollama pull qwen3-coder:30b
ollama pull deepseek-r1:14b  # For reviewer
ollama pull nomic-embed-text  # For RAG embeddings

# 4. Build TypeScript
npm run build

# 5. Build RAG index (indexes your codebase)
npm run rag-index

# 6. Start ClosedLoop
npm start
```

### Configuration

ClosedLoop uses Paperclip's configuration format. Edit `.paperclip/project.json`:

```json
{
  "project": {
    "name": "Your Project",
    "workspace": "C:\\path\\to\\your\\project"
  },
  "paperclip": {
    "companyId": "your-company-id",
    "agents": {
      "strategist": "...",
      "tech lead": "...",
      "local builder": "...",
      "reviewer": "..."
    }
  },
  "ollama": {
    "proxyPort": 3201,
    "ollamaPort": 11434,
    "models": {
      "local builder": "qwen3-coder:30b",
      "reviewer": "deepseek-r1:14b"
    }
  }
}
```

## How It Works

### 1. RAG Indexing

Before generating code, ClosedLoop indexes your entire codebase:

```bash
npm run rag-index
```

This creates a ChromaDB vector index containing:
- All TypeScript/JavaScript files
- Exported symbols (functions, classes, interfaces)
- File purposes (from JSDoc comments)
- Code patterns and structure

### 2. Context-Aware Code Generation

When Local Builder receives a task:

1. **Extract keywords** from the issue title/description
2. **Query RAG index** for top 10 relevant files
3. **Inject context** showing:
   - Existing file structure
   - Current exports (to avoid breaking changes)
   - Code patterns to follow
4. **Generate code** with full awareness of the codebase

### 3. Closed-Loop Workflow

```
Issue → Strategist → Tech Lead → Local Builder
                              ↓
                        RAG Context
                              ↓
                    Code Generation
                              ↓
    ┌──────────────────── Reviewer ────────────────────┐
    │                                                  │
    ├─→ Approved → Create PR → Artist Audit → Done    │
    │                                                  │
    └─→ Issues Found → Send Back to Local Builder ────┘
```

## Module Structure

| Module | Purpose |
|--------|---------|
| `index.ts` | Entry point, initializes RAG |
| `rag-indexer.ts` | ChromaDB vector indexing |
| `context-builder.ts` | RAG-enhanced issue context |
| `code-extractor.ts` | Extract code blocks from LLM output |
| `git-ops.ts` | Git branch, commit, PR creation |
| `proxy-server.ts` | HTTP server for Paperclip agents |
| `paperclip-api.ts` | Paperclip API client |
| `agent-types.ts` | Agent IDs and delegation rules |
| `bash-executor.ts` | Execute shell commands |
| `delegation.ts` | Detect agent delegation |
| `artist-recorder.ts` | Playwright UI testing |

## Commands

```bash
# Build TypeScript
npm run build

# Start ClosedLoop
npm start

# Development mode (build + start)
npm run dev

# Build RAG index
npm run rag-index
```

## Why ClosedLoop?

### Problem: AI Code Generation is Unreliable

LLMs hallucinate because they lack context about your existing codebase. They:
- Create duplicate files
- Delete existing exports
- Break established patterns
- Ignore project conventions

### Solution: RAG + Local LLMs

ClosedLoop solves this with:

1. **RAG Grounding**: Retrieves relevant files before generation
2. **Local Models**: Run 30B+ parameter models offline
3. **Validation**: Checks for destructive changes before committing
4. **Closed Loop**: Automatic feedback and revision

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript (strict mode)
- **Vector DB**: ChromaDB
- **LLM Backend**: Ollama
- **Agent Framework**: Paperclip AI
- **Testing**: Playwright (Artist agent)

## License

MIT

## Contributing

ClosedLoop is open source! Contributions welcome:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a PR

---

**Built with ❤️ for local-first AI development**
