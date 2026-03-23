# ClosedLoop Improvement Backlog

## Completed (Medium Effort)

### 1. Structured JSON Communication (MetaGPT pattern) ✅
Agents pass typed JSON contracts between each other. Defined strict schemas:
- `TicketSpec` JSON: Strategist output → Tech Lead input
- `BuildManifest` JSON: Tech Lead output → Local Builder file plan
- `ReviewVerdict` JSON: structured approve/reject with file+line issues
- `DiffVerdict` JSON: Diff Guardian checklist results

Parsers extract JSON from freeform LLM output with keyword fallback. Prompts updated to request JSON output.

### 2. Test-First Workflow ✅
Strategist or Tech Lead can define acceptance tests BEFORE the builder writes code:
- `TEST:` blocks in agent output are parsed and written to workspace
- Builder exit condition: build passes AND tests pass
- Tests define concrete acceptance criteria beyond "build succeeds"
- Test results injected into builder prompts with pass/fail counts

### 3. AST-Based RAG ✅
RAG index now extracts structural metadata using regex-based AST parsing:
- Function signatures with parameter types and return types
- Interface/type definitions with field shapes
- Enum definitions with values
- Import/export relationships

AST search text gets 2x boost in RAG scoring. Enables structural queries like "find all functions that accept orderId."

### 4. Success Rate Tracking for Model Routing ✅
Track which model succeeded/failed for which task complexity level:
- Persistent store at `.paperclip/success-rates.json`
- Per-model stats: total, success rate, avg passes, rescue count
- Complexity-range filtering (e.g. "how does deepcoder:14b do at score 5-7?")
- Threshold recommendation engine: auto-suggests raising/lowering the complexity threshold
- Confidence levels: low (<10 samples), medium (10-30), high (30+)

## Completed (High Effort)

### 5. Parallel Worktree Exploration ✅
For ambiguous/complex tasks (score >= 7 or Tech Lead `[EXPLORE]` signal), spawns 2-3 Local Builder instances in separate git worktrees with different approaches:
- Each approach runs sequentially (shared GPU) in an isolated git worktree
- `node_modules` shared via Windows junctions (no multi-GB duplication)
- Reviewer compares results from all passing approaches
- Auto-selects when only one approach passes build
- Winner's branch merged onto canonical issue branch, losers cleaned up
- New modules: `worktree-ops.ts` (git worktree CRUD) + `exploration-orchestrator.ts` (orchestration, comparison, selection)
- 20 new tests (154 total)

## High Effort

### 6. Property-Based Testing in Diff Guardian
Instead of reviewing diffs syntactically, Diff Guardian generates Hypothesis-style property tests for changed code and runs them. Example: "for any valid payment amount, the create endpoint should return 201 and the get endpoint should return the same amount." Anthropic's research found real NumPy bugs with this approach.

### 7. Event-Sourced State (OpenHands pattern)
Every agent action becomes an immutable event. Any agent can replay history. Enables: full audit trail, forking from any point, debugging failed pipelines by replaying events. Current approach mixes state across Maps and files — event sourcing unifies it.
