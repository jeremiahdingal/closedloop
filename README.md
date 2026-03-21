# ClosedLoop

ClosedLoop is a local-first autonomous coding system built around Paperclip, Ollama, and a bridge runtime that keeps Local Builder in a build-fix loop until code is green.

The important current story is not just "generate code locally." It is "make weaker local models reliable by giving them continuous execution, build feedback, and bounded handoff rules."

## Current Status

This repository is in an active transition from the older `src/` ClosedLoop orchestration path to the newer `packages/bridge/` control plane.

What is true today:

- `packages/bridge` is the intended owner of the Local Builder lifecycle.
- Local Builder is expected to edit, build, and repair until the workspace is green before handing off.
- Reviewer and Diff Guardian should only see build-green work.
- The bridge already posts real Paperclip comments and reassignments.
- A live Paperclip issue has already reached the bridge-owned Builder green-handoff point.

What is not fully finished:

- The bridge still talks to Ollama directly over HTTP instead of using a true persistent CLI worker like pi-mono.
- Reviewer and Diff Guardian validation are real, but still heuristic-heavy and not yet deeply project-aware.
- The full live Paperclip path still needs continued end-to-end verification across Reviewer, Diff Guardian, and final PR/human-review handoff.

## Why This Exists

The main problem being solved is a failure mode common with smaller local coding models:

1. Builder writes code that does not compile.
2. Builder hands off anyway.
3. Reviewer becomes the first place where the broken build is discovered.
4. The system loops between Builder and Reviewer without ever enforcing a green build.

ClosedLoop is being reshaped around one core invariant:

- Local Builder must not hand off on a red build.

That invariant is the reason the bridge exists.

## Architecture

There are currently two important layers:

### `packages/bridge`

This is the reliability-first runtime and the long-term control plane for Local Builder.

It currently handles:

- webhook intake
- role routing
- per-issue session directories
- builder retry loop
- build execution and log capture
- per-attempt state persistence
- checkpoints before builder writes
- Paperclip comments and reassignment
- Reviewer and Diff Guardian validation flow

### `src/`

This is the older ClosedLoop integration layer.

It still matters for:

- shared config loading
- Paperclip API integration
- RAG/context plumbing
- other shared agent logic

But it is no longer supposed to own the Local Builder lifecycle. That responsibility is being moved behind the bridge boundary.

## Agent Flow

The intended Paperclip flow is:

`Strategist -> Tech Lead -> Local Builder -> Reviewer -> Diff Guardian -> Human review / PR creation`

Supporting and side-path agents:

- `Sentinel`
  - used for deployment-oriented or safety-oriented follow-up work
- `Artist`
  - used for UI inspection, screenshots, and visual checks
- `Coder Remote`
  - configured but currently blocked in this project

The most important runtime rule is:

- Local Builder must stay in the bridge-owned edit -> build -> fix loop until green before Reviewer or Diff Guardian see the issue.

## Agent Roles

### `Strategist`

Turns a high-level request into a clearer implementation direction. This agent is for planning, scoping, and deciding what kind of work should happen next.

### `Tech Lead`

Translates the strategy into a concrete build task for Local Builder. This role is the planning-to-execution handoff point.

### `Local Builder`

Implements code changes in the target workspace. In the current architecture, this role is the most important one: it should write code, run the build, repair errors, and only hand off after the workspace is green.

### `Reviewer`

Performs semantic and code-quality review after Builder is green. Reviewer should not be the first place broken builds are discovered.

### `Diff Guardian`

Performs post-build mechanical validation on the resulting diff. This is where suspicious changes, risky diff patterns, or policy failures should be caught after the build already passes.

### `Sentinel`

Handles safety- or deploy-adjacent follow-up paths. It is part of the broader workflow, but not the current center of the bridge effort.

### `Deployer`

Owns deployment-oriented actions after the code path is considered ready.

### `Artist`

Handles visual verification, UI inspection, and screenshot-driven review. This is especially useful for frontend tasks and presentation checks.

## Repository Guide

Top-level areas that matter most:

- `packages/bridge/`
  - current control plane for Local Builder build-fix-handoff flow
- `src/`
  - older ClosedLoop integration path and supporting infrastructure
- `.paperclip/project.json`
  - project, workspace, Paperclip, and model configuration
- `LOCAL_BUILDER_BRIDGE_HANDOFF.md`
  - short canonical handoff for the next coding model
- `LOCAL_BUILDER_BRIDGE_AUDIT.md`
  - deeper reasoning and audit context
- `CONFIG_SUMMARY.md`
  - configuration overview

## What Has Been Proven

The bridge is already more than a plan.

Confirmed in this repo:

- root TypeScript build passes with `npm run build`
- bridge build passes with `npm --prefix packages/bridge run build`
- bridge sessions persist attempt state and logs on disk
- builder retries against real build failures are happening in practice
- Paperclip comments and reassignment paths are wired in the bridge
- a live Paperclip Builder run reached a build-green handoff and posted the ready-for-review comment

This means the repo already proves the key idea: weaker local models do better when they are kept inside a continuous execution loop with immediate feedback.

## What Still Needs Work

The remaining problems are mostly about reliability and refinement, not direction.

Main gaps:

- retries are still too prompt-driven
- targeted repair mode should be stricter
- repeated identical failures should trigger narrower repair logic faster
- checkpoint-based recovery can become more selective
- Reviewer and Diff Guardian need richer project-aware validation
- the Ollama backend should eventually be replaced by a true persistent worker process

## Planned Direction

The intended next shape of the system is:

1. Builder owns edit -> build -> fix until green.
2. Reviewer only handles semantic and quality review after green.
3. Diff Guardian only handles post-build mechanical validation.
4. Human review / PR creation only happens after those gates pass.

Longer-term technical direction:

- keep `packages/bridge` as the only owner of Local Builder orchestration
- move more runtime enforcement out of prompts and into deterministic checks
- tighten targeted repair mode around touched files and exact diagnostics
- use checkpoints and fingerprints to avoid repeating the same bad loop
- evolve the bridge into a true persistent local worker backend

## Quick Start

### Prerequisites

- Node.js 18+
- Ollama
- Paperclip
- Git

### Install

```bash
npm install
npm run build
npm --prefix packages/bridge run build
```

### Run

Main project:

```bash
npm start
```

Bridge:

```bash
npm --prefix packages/bridge run build
node packages/bridge/dist/index.js
```

### Configuration

The main configuration lives in `.paperclip/project.json`.

At minimum, make sure these are correct:

- workspace path
- Paperclip API URL
- company ID
- agent IDs
- Ollama model names and ports

## Recommended Reading Order For Another AI

If another model needs to get productive quickly, read in this order:

1. `README.md`
2. `LOCAL_BUILDER_BRIDGE_HANDOFF.md`
3. `LOCAL_BUILDER_BRIDGE_AUDIT.md`
4. `.paperclip/project.json`
5. `packages/bridge/src/index.ts`
6. `packages/bridge/src/session.ts`
7. `src/proxy-server.ts`

## Working Assumptions

When continuing this project, assume:

- the bridge direction is correct
- overlapping builder orchestration should not be reintroduced
- build-green gating is non-negotiable
- prompt-only repair is not enough
- reliability matters more than elegance in the autonomous lane

## Short Version

If you only remember one thing, remember this:

ClosedLoop is becoming a bridge-driven local coding system where Local Builder must keep repairing until the code builds cleanly, and only then can the rest of the Paperclip workflow continue.
