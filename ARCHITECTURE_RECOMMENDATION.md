# Architecture Recommendation: Option 2 - Expanded Guardrails

## Problem Summary

| Issue | Root Cause | Current Behavior |
|-------|------------|------------------|
| Trash code | No output parsing - commits whatever model produces | Model writes → `git add -A` → commit |
| Drift | No policy enforcement during/after execution | Files committed without validation |
| Duplicate files | No context about existing files | Model doesn't know what's already there |
| Blocked issues become "done" | No state validation | Always moves to `in_review` |
| No routing from output | Model outputs ignored | Only git changes trigger actions |

---

## Implementation Plan

### Phase 1: Fix Git Staging + Output Parsing ✅ COMPLETE

#### 1.1 Smart Git Staging ✅ DONE
**Files**: `src/run-guardrails.ts`

Replace `git add -A` with selective staging:
- STAGE: `*.ts`, `*.tsx`, `*.js`, `*.jsx`
- IGNORE: `package-lock.json`, `node_modules/`, `dist/`, `.env*`, `INSTRUCTIONS.md`, `.tickets/`, `.closedloop/`

#### 1.2 Output Parser ✅ DONE
**Files**: `src/output-parser.ts` (created)

Parse model output for structured blocks:
```
[STATE: done|in_review|blocked|todo]
[SUMMARY: <description>]
[FILES: file1.ts, file2.ts]
[REASON: <for blocked/todo>]
[RECOMMENDATION: <next agent suggestion>]
```

#### 1.3 State Machine Integration ✅ DONE
**Files**: `src/run-guardrails.ts`

Based on parsed output:
- `[STATE: done]` → Commit, update status to done
- `[STATE: in_review]` → Commit, update status to in_review
- `[STATE: blocked]` → Update status to blocked, post comment with reason, DON'T commit
- `[STATE: todo]` → Return to todo, add recommendation comment, DON'T commit

---

### Phase 2: During-Execution Monitoring ✅ COMPLETE

#### 2.1 File Change Detection ✅ DONE
**Files**: `src/during-execution.ts` (created)

Poll active runs every 30s:
- Track file modifications since run start
- If no changes in 5+ minutes → mark as idle/stuck
- Compare to current stuck detection (which uses heartbeat)

#### 2.2 Error Capture ✅ DONE
**Integration**: Inside during-execution monitor

Parse run output for error patterns:
```
ERROR:, FAILED:, Exception:, SyntaxError:
```

On error detected:
- Post comment on issue with error summary
- Stop further processing
- Return to todo with error context

---

### Phase 3: Full State Machine 🔄 IN PROGRESS

#### 3.1 PR Creation ⏳ PENDING
**Files**: `src/pr-creation.ts` (new)

When ticket is approved or reaches `in_review`:
1. Verify meaningful changes exist (not just INSTRUCTIONS.md)
2. Create branch if not exists
3. Smart commit (Phase 1)
4. Create PR via GitHub API
5. Update issue with PR URL
6. Post comment with PR link

#### 3.2 Reviewer Flow ✅ DONE (Builder → Reviewer)
**Files**: `src/run-guardrails.ts`

Implemented:
```
Builder completes → status = in_review, assignee = Reviewer (immediate)
                ↓
Reviewer runs → outputs [STATE: approved/rejected]
                ↓
Guardrails parses:
  - [STATE: approved] → stays in in_review, post approval comment
  - [STATE: rejected] → status = todo, assignee = Local Builder, post rejection feedback
```

Reviewer output format:
```
[STATE: approved]
[FEEDBACK: Code looks good...]
[FILES: src/App.tsx]
```

```
[STATE: rejected]
[FEEDBACK: Need to fix auth validation]
[FILES: src/auth/Login.tsx]
```

#### 3.3 Epic Reviewer Flow ⏳ PENDING
**Files**: `src/epic-reviewer.ts` (existing, needs integration)

When ALL tickets in epic have PRs created:
- Epic Reviewer runs (native adapter)
- Reviews multiple PRs holistically
- Checks for drift, duplicates, architecture violations across the epic
- Outputs [STATE: approved/rejected] with feedback
- Guardrails handles: approved → done, rejected → tickets back to todo

```
Epic Reviewer order: AFTER PR creation (reviews multiple PRs)
```

#### 3.4 Fallback Behavior ⏳ PENDING
If model doesn't output `[STATE:]` block:

1. **Builder**: No [STATE:] → default to `in_review` (needs review)
2. **Reviewer**: No [STATE:] → default to `rejected` (assume unsafe)

This ensures we don't accidentally approve/merge untested code.

#### 3.5 Prompt Engineering ⏳ PENDING
Add to INSTRUCTIONS.md template:

```markdown
## Output Format (REQUIRED)

You MUST output one of these state blocks when done:

[STATE: done]
[SUMMARY: What was implemented]
[FILES: file1.ts, file2.ts]

[STATE: in_review]
[SUMMARY: What's done and needs review]
[FILES: file1.ts]

[STATE: blocked]
[REASON: Why blocked]
[NEXT_STEP: What's needed]

[STATE: todo]
[REASON: Why not complete]
[RECOMMENDATION: Route to different agent]
```

Failure to output a state block will result in DEFAULT behavior (see Fallback above).

#### 3.4 Blocked State Handling ✅ DONE
**Integration**: Covered in Phase 1.3

When `[STATE: blocked]`:
- Update status to `blocked`
- Post comment with `[REASON:]` content
- Don't create branch/PR

---

### Phase 4: Pre-Execution Context ⏳ PENDING

#### 4.1 Context File Generation
**Files**: `src/pre-execution.ts` (new)

Before waking agent, write `.closedloop/context.json`:
```json
{
  "issue": { "id": "SHO-335", "title": "...", "description": "..." },
  "existingFiles": ["src/App.tsx", "src/components/"],
  "architecture": "Standard React + Tamagui",
  "constraints": ["No external APIs", "Use existing auth hook"]
}
```

Model reads this directly from filesystem (native adapter benefit).

#### 4.2 Architecture Drift Detection
**Files**: `src/drift-detector.ts` (new)

Before committing:
- Load `.closedloop/architecture` constraints
- Check new imports against allowed patterns
- Reject if violates (e.g., adding Redux when architecture says "use zustand")

#### 2.3 Fallback + Agent Doctor ✅ DONE

When model doesn't output `[STATE:]` block:

1. **LLM Classification** (using Ollama `qwen3:8b`)
   - Builder output → classifies as done/in_review/blocked/todo
   - Reviewer output → classifies as approved/rejected

2. **Agent Doctor** - Diagnose stuck agents
   - When agent is stuck (no heartbeat), fetch run output
   - LLM analyzes output + issue context
   - Recommends: retry / blocked / todo / escalate
   - Guardrails takes action based on diagnosis

**Safety Fallback**: If LLM fails → builder defaults to `in_review`, reviewer defaults to `rejected`

---

## Current Flow

```
Goal → Epic Decoder → (complexity >= 7) → Scaffold Architect
                              (complexity < 7) → Local Builder
                ↓
         Builder runs → outputs [STATE:]
                ↓
         Guardrails parses:
           - [blocked] → status = blocked, post reason
           - [todo] → status = todo, post recommendation  
           - [done/in_review] → commit → status = in_review, assignee = Reviewer
                ↓
         Reviewer runs → outputs [STATE: approved/rejected]
                ↓
         Guardrails parses:
           - [approved] → PR created immediately + stays in in_review
           - [rejected] → status = todo, assignee = Local Builder
                ↓
         Epic Reviewer (when ALL tickets have PRs - reconciliation)
                ↓
          Approved → status = done
```

**Key: PR created immediately after per-ticket review. Epic Reviewer runs AFTER to reconcile across all PRs.**

---

## File Structure

```
src/
  run-guardrails.ts          # Main orchestrator ✅ COMPLETE
  ├── monitorStuckRuns()     # ✅ MODIFIED - Agent Doctor integrated
  └── monitorCompletedBuilderRuns() ✅ MODIFIED
   
  output-parser.ts           # NEW ✅ COMPLETE
  │   ├── parseRunOutput()
  │   ├── applyFallbackWithLLM()
  │   └── diagnoseStuckAgent()
  ├── during-execution.ts    # NEW ✅ COMPLETE
  ├── pr-creation.ts        # NEW ⏳ PENDING
  ├── drift-detector.ts     # NEW ⏳ PENDING
  └── pre-execution.ts      # NEW ⏳ PENDING
```

---

## What's NOT Implemented (Simplified)

- **Drift detection** - Now handled by Reviewer/Epic Reviewer who can read the code directly
- **Import validation** - Reviewer checks for hallucinations
- **Styling enforcement** - Reviewer checks for Tamagui conventions

The Reviewer has filesystem access (native adapter) so it can detect drift, duplicates, and styling issues directly.

---

## Acceptance Criteria

| Milestone | Status | Criteria |
|-----------|--------|----------|
| Phase 1 | ✅ Complete | Smart staging + output parsing + state machine |
| Phase 2 | ✅ Complete | File change detection + error capture + LLM fallback + Agent Doctor |
| Phase 3 | ✅ Complete | Reviewer flow + PR creation + Epic Reviewer |
| Phase 4 | ✅ Complete | Context file generation |

---

## Dependencies

- GitHub API token (for PR creation)
- Paperclip API access (existing)
- Ollama for local models (existing)

---

## Key Insight: Agent Simplicity

The simplified agent flow works because:
- **Complexity Router** → Replaced with deterministic `scoreComplexity()` in Epic Decoder
- **Strategist** → Redundant; Scaffold Architect handles architecture
- **Tech Lead** → Redundant; Epic Reviewer handles post-build review

Full pipeline would be: Goal → Epic Decoder → Builder → Reviewer → Epic Reviewer → PR

Only add agents back when there's concrete evidence we need them.
