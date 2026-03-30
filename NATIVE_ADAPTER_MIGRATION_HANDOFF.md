# Native Adapter Migration Handoff

## Objective
Migrate selected agents off the current HTTP bridge path and onto Paperclip native local adapters where direct repo access gives a real upside.

This handoff is intentionally split into two phases:
1. `Epic Reviewer` first
2. Expand the native local pattern to the next repo-aware agents that benefit from workspace reads

Do not redesign the whole orchestration system in one pass.

---

## What We Already Verified
We already proved that a Paperclip native `opencode_local` run can:
1. launch in the project working directory
2. read repo files directly from the workspace
3. show those reads in the Paperclip run UI

Evidence from the verified run:
1. Run URL:
   [c33cdec4](http://127.0.0.1:3100/SHO/agents/scaffold-architect/runs/c33cdec4-7110-422c-9e0c-93e91ad94119)
2. The run UI showed:
   - `Adapter: opencode_local`
   - `Working dir: C:/Users/.../Projects/shop-diary-v3`
3. The raw transcript showed real file reads for:
   - [packages/app/dashboard/categories/screen.tsx](C:/Users/dinga/Projects/shop-diary-v3/packages/app/dashboard/categories/screen.tsx)
   - [packages/app/utils/fetcherWithToken.ts](C:/Users/dinga/Projects/shop-diary-v3/packages/app/utils/fetcherWithToken.ts)

Important nuance:
1. Workspace reads are verified.
2. Final synthesis quality was only partially good.
3. So migration should remove prompt stuffing, but still keep concise policy instructions and output contracts.

---

## Non-Goals
Do not do any of the following in this migration:
1. Do not migrate every orchestration agent at once.
2. Do not keep the bridge in the hot path for agents that are intentionally migrated.
3. Do not delete all prompt context blindly.
4. Do not reintroduce adapter auto-rewrite loops for migrated agents.
5. Do not change models unless required for the native adapter path.

---

## Phase 1
# Epic Reviewer -> Native Local Adapter

## Goal
Move `Epic Reviewer` from `http` to a Paperclip native local adapter so it can inspect the repo directly and stop depending on giant monorepo/context injection.

Prefer:
1. native Codex CLI adapter if that is the Paperclip-supported local adapter you want
2. otherwise native `opencode_local`

The key requirement is native local repo-aware execution with Paperclip UI visibility.

## Why Epic Reviewer First
1. Highest upside from direct repo inspection
2. Lower-frequency than builder agents
3. Review and reconciliation benefit most from native file reads
4. Best place to cut prompt tokens without losing task quality

## Phase 1 Scope
1. Migrate `Epic Reviewer` only
2. Remove its large monorepo/context stuffing
3. Keep its review policy and gating intact
4. Validate the migration in Paperclip UI before touching other agents

## Files / Areas to Inspect
These are the main areas the mini model should inspect first:
1. [src/proxy-server.ts](C:/Users/dinga/Projects/closedloop/src/proxy-server.ts)
   - find Epic Reviewer-specific prompt/context construction
   - find any monorepo injection that is currently used for Epic Reviewer
2. [src/context-builder.ts](C:/Users/dinga/Projects/closedloop/src/context-builder.ts)
   - find reusable injected repo/context blocks
3. [src/adapter-config.ts](C:/Users/dinga/Projects/closedloop/src/adapter-config.ts)
   - find HTTP adapter enforcement logic
4. [src/index.ts](C:/Users/dinga/Projects/closedloop/src/index.ts)
   - find startup or interval code that may push agents back to `http`
5. [.paperclip/project.json](C:/Users/dinga/Projects/closedloop/.paperclip/project.json)
   - inspect current agent IDs, model mappings, and config references

## Concrete Tasks
1. Identify all code paths that force `Epic Reviewer` to `http://127.0.0.1:3201`.
2. Remove `Epic Reviewer` from those enforcement paths.
3. Patch `Epic Reviewer` to the chosen native local adapter.
4. Set the correct project `cwd`.
5. Replace the large injected monorepo prompt with a short policy contract.
6. Preserve the following behavior:
   - PR-first gating
   - only run after epic ticket PRs exist
   - duplicate-file cleanup mandate
   - canonical-file reconciliation
   - bounded completion criteria

## Minimal Prompt Contract for Epic Reviewer
Keep only the following kinds of instructions:
1. Review all PRs for the epic.
2. Reconcile duplicate or parallel files into canonical files.
3. Do not finish until duplicate drift is actually resolved.
4. Follow PR-first policy.
5. Emit a structured review report.

Remove:
1. giant repo tree dumps
2. large pasted file contents
3. repeated monorepo pattern summaries unless they are true policy

## Acceptance Criteria
1. `Epic Reviewer` run page shows native local adapter, not `http`.
2. Run transcript shows direct workspace reads.
3. Prompt is materially smaller than before.
4. Epic Reviewer still detects duplicate-file drift.
5. Epic Reviewer still performs post-PR reconciliation instead of finishing early.

## Do Not Touch Yet
1. Do not migrate `Tech Lead`.
2. Do not migrate `Local Builder`.
3. Do not remove the entire bridge for everyone.
4. Do not rewrite the whole orchestration flow in Phase 1.

## Suggested Validation Task
Use a controlled epic review case with known duplicate-file drift and verify that:
1. the run opens files directly from the repo
2. the UI transcript is populated
3. the output is useful without monorepo stuffing

---

## Phase 2
# Expand Native Local Pattern to the Next Repo-Aware Agents

## Goal
Apply the same native local repo-aware pattern to the next agents where direct workspace reads help most and large prompt stuffing is wasteful.

This phase is explicitly based on the `opencode_local` workspace-read verification we already completed.

## Recommended Phase 2 Order
1. `Scaffold Architect`
2. `Reviewer`
3. `Diff Guardian`

Do not move `Tech Lead` or `Local Builder` in the same pass unless the first three migrations are stable.

## Why These Agents
1. They are inspection-heavy or repo-aware by nature.
2. They benefit from reading files directly.
3. They do not require the highest-frequency execution path to succeed first.
4. They are better candidates than builder agents for low-risk native-local adoption.

## Phase 2 Scope
1. Migrate the next repo-aware agents to native local adapter execution.
2. Remove large agent-specific prompt stuffing for those agents.
3. Keep concise policy prompts and output contracts.
4. Remove bridge reliance for those migrated agents only.

## Files / Areas to Inspect
1. [src/proxy-server.ts](C:/Users/dinga/Projects/closedloop/src/proxy-server.ts)
   - agent-specific context injection
   - review / guard / orchestration logic currently tied to bridge mode
2. [src/context-builder.ts](C:/Users/dinga/Projects/closedloop/src/context-builder.ts)
   - shared prompt stuffing candidates to trim
3. [src/adapter-config.ts](C:/Users/dinga/Projects/closedloop/src/adapter-config.ts)
   - remove migrated agents from HTTP enforcement
4. [src/index.ts](C:/Users/dinga/Projects/closedloop/src/index.ts)
   - confirm no interval/startup logic rewrites migrated adapters
5. [.paperclip/project.json](C:/Users/dinga/Projects/closedloop/.paperclip/project.json)
   - verify agent IDs and any model/config assumptions used by migration scripts or code

## Concrete Tasks
1. For `Scaffold Architect`, remove any unnecessary injected repo dump and keep only concise task instructions.
2. For `Reviewer`, do the same and preserve structured approval semantics.
3. For `Diff Guardian`, preserve fail-closed drift behavior while trimming prompt inflation.
4. Remove each migrated agent from bridge-side adapter enforcement.
5. Verify that each migrated agent shows workspace reads in the Paperclip UI.

## Prompt Design Rule for Phase 2
Keep:
1. task intent
2. policy constraints
3. output contract
4. any truly project-specific rules

Remove:
1. giant repo summaries
2. repeated monorepo scaffolding text
3. pasted code when direct file reads are sufficient

## Acceptance Criteria
1. Each migrated agent runs through Paperclip native local execution.
2. Each run shows repo file reads in the UI.
3. Prompt size decreases materially.
4. Output quality does not regress into generic “need more context” replies.
5. No bridge dependency remains for those migrated agents.

## Do Not Touch Yet
1. Do not migrate `Local Builder`.
2. Do not migrate `Tech Lead`.
3. Do not rework all orchestration agents into native local at once.
4. Do not keep both large prompt stuffing and native repo reads for the same migrated agent unless explicitly used as a fallback.

---

## Implementation Notes for the Mini Model

## Key Principle
For migrated agents:
1. the repo is the context source
2. the prompt is the policy layer

Not the other way around.

## What Success Looks Like
The Paperclip run page for a migrated agent should show:
1. native local adapter
2. correct project working directory
3. real workspace reads or tool calls
4. useful final output with minimal prompt inflation

## What Failure Looks Like
1. run still goes through `http://127.0.0.1:3201`
2. prompt still contains giant repo dumps
3. run output is generic and ignores the task
4. adapter enforcement rewrites the agent back to HTTP

---

## Deliverables

## Deliverable A
`Epic Reviewer` migrated to native local adapter with trimmed prompt stuffing and validated Paperclip UI runs.

## Deliverable B
`Scaffold Architect`, then `Reviewer`, then `Diff Guardian` migrated to the same pattern with trimmed prompt stuffing and no bridge reliance.

---

## Final Checklist
1. Epic Reviewer migrated and validated
2. Epic Reviewer no longer forced to HTTP
3. Epic Reviewer prompt materially trimmed
4. Scaffold Architect migrated cleanly or confirmed already-native and trimmed
5. Reviewer migrated and trimmed
6. Diff Guardian migrated and trimmed
7. No migrated agent is still being pushed back to `http://127.0.0.1:3201`
8. Paperclip UI visibly shows native local workspace reads for migrated agents
