# Native Adapter Migration Handoff

## Objective
Continue the native-adapter migration without using any local Paperclip fork copy.

This handoff is intentionally split into two phases:
1. `Epic Reviewer` first
2. Expand the native local pattern to the next repo-aware agents that benefit from workspace reads

Do not redesign the whole orchestration system in one pass.
Do not use `packages/paperclip-fork`; that directory has been deleted from this workspace.

---

## Verified Current State
These items are present in the main repo right now:
1. `Epic Reviewer` sync logic targets `codex_local` in [src/adapter-config.ts](C:/Users/dinga/Projects/closedloop/src/adapter-config.ts).
2. Upstream orchestration sync logic targets `opencode_local` for:
   - `Complexity Router`
   - `Strategist`
   - `Tech Lead`
   - `Local Builder`
   - `Coder Remote`
   - `Visual Reviewer`
   - `Sentinel`
   - `Deployer`
   - `Epic Decoder`
3. Repo-aware sync logic targets `opencode_local` for:
   - `Scaffold Architect`
   - `Reviewer`
   - `Diff Guardian`
4. The wake helper in [src/paperclip-api.ts](C:/Users/dinga/Projects/closedloop/src/paperclip-api.ts) does send `issueId` and `issueIds` inside both `payload` and `contextSnapshot`.
5. `sanitizeForWin1252()` already exists in [src/paperclip-api.ts](C:/Users/dinga/Projects/closedloop/src/paperclip-api.ts) and normalizes arrows and other non-WIN1252 characters for comment posting.

What is not verified in the main repo path:
1. No main-repo file currently proves that server-side wake context enrichment landed in the non-fork runtime.
2. No main-repo file currently proves that OpenCode fallback summaries landed in the non-fork runtime.
3. No end-to-end autonomous epic flow is verified from the current non-fork path.

Workspace note:
1. `packages/paperclip-fork` was deleted and shows as a deleted path in git status.
2. The remaining untracked local artifacts are `.playwright-cli/`, `.playwright/`, `output/`, and `pnpm-lock.yaml`.

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
6. Do not recreate or use `packages/paperclip-fork`.

---

## Phase 1
# Epic Reviewer -> Native Local Adapter

## Goal
Move `Epic Reviewer` from `http` to a Paperclip native local adapter so it can inspect the repo directly and stop depending on giant monorepo/context injection.

Status:
1. Done in repo config/sync logic: `Epic Reviewer` is targeted to `codex_local`.
2. Done in repo config/sync logic: its prompt is trimmed to a compact review contract.
3. Remaining: verify the live Paperclip environment actually reflects that config and produces useful runs.

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

Status:
1. In progress in repo config/sync logic: upstream orchestration agents are targeted to `opencode_local`.
2. Done in repo config/sync logic: the adapter sync now targets the upstream orchestration set.
3. Remaining: validate the live runs against the actual Paperclip environment and trim any prompt/context pieces that are no longer needed.

## Recommended Phase 2 Verification Order
1. `Complexity Router`
2. `Strategist`
3. `Tech Lead`
4. `Local Builder`
5. `Coder Remote`
6. `Visual Reviewer`
7. `Sentinel`
8. `Deployer`
9. `Epic Decoder`

Keep `Scaffold Architect`, `Reviewer`, and `Diff Guardian` on the native local path as already targeted repo-aware agents.

## Why These Agents
1. They are inspection-heavy or repo-aware by nature.
2. They benefit from reading files directly.
3. They do not require the highest-frequency execution path to succeed first.
4. They are better candidates than builder agents for low-risk native-local adoption.

## Phase 2 Scope
1. Migrate the upstream orchestration agents to native local adapter execution.
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
1. Verify live adapter state for each migrated agent through the real Paperclip API/UI, not through any deleted fork path.
2. Confirm `Scaffold Architect`, `Reviewer`, and `Diff Guardian` actually run with useful workspace-aware output.
3. Confirm `Complexity Router` and `Tech Lead` can start without immediately stalling the flow.
4. Remove any remaining unnecessary injected repo dump and keep only concise task instructions.
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
4. Output quality does not regress into generic "need more context" replies.
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
The repo-aware and upstream orchestration agents validated on the real Paperclip runtime with trimmed prompt stuffing and no reliance on `packages/paperclip-fork`.

---

## Final Checklist
1. Epic Reviewer targeted to `codex_local` and validated in the real environment
2. Epic Reviewer no longer forced to HTTP
3. Epic Reviewer prompt materially trimmed
4. Upstream orchestration agents targeted to native local OpenCode and validated in the real environment
5. Wake payloads/context snapshots carry real issue linkage
6. Paperclip UI visibly shows native local workspace reads for migrated agents
7. Any runtime-specific fixes are made in the real Paperclip path, not in a deleted fork copy
