---
phase: 54-viz-ambient-liveliness-and-replay-traces
plan: "01"
subsystem: viz/presentation
tags: [constants, ambient-liveliness, replay-echo, twinkle, sc5]
dependency_graph:
  requires: [Phase 52 honest-traces, Phase 53 Halton layout]
  provides: [54-01: Phase-54 ambient-liveliness tunables exported from constants.js]
  affects: [src/viz/modules/trace.js (Plan 02 consumer), src/viz/server.ts (Plan 03 consumer), tests/viz-ambient-liveliness.test.ts (Plan 04 guard consumer)]
tech_stack:
  added: []
  patterns: [flat ESM export const, spec-midpoint starting values tuned at visual checkpoint]
key_files:
  modified:
    - src/viz/modules/constants.js
decisions:
  - "REPLAY_DIM = 0.5 (< 1): honesty-by-construction invariant baked into the value itself (SC3)"
  - "ACT_SCALE_GAIN = 0.9 vs. spec-safe 0.7: using spec midpoint per plan; founder tunes at Plan 05 checkpoint"
  - "All 10 constants appended as new block after DEGRADE_FPS; no existing constants modified"
metrics:
  duration_minutes: 5
  completed_date: "2026-06-30"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 1
---

# Phase 54 Plan 01: constants.js Ambient-Liveliness Tunables Summary

**One-liner:** Added 10 named tunable constants to constants.js as the single-source-of-truth foundation for Phase-54's three-layer ambient-liveliness system (live recall amplification, replay echo, twinkle).

## What Was Built

Appended a new export block — "Phase 54 — ambient liveliness" — to `src/viz/modules/constants.js`, adding exactly 10 flat `export const` exports matching the existing `constants.js` style:

**Layer 1 — live recall amplification:**
- `ACT_SCALE_GAIN = 0.9` — size-pulse gain (replaces inline 0.35 in trace.js)
- `ACT_BRIGHTEN_GAIN = 0.55` — opacity boost gain (replaces inline 0.4)
- `ACT_HAZE_LERP = 0.95` — haze color-lerp factor (replaces inline 0.8)

**Layer 2 — replay echo:**
- `REPLAY_IDLE_GAP_MS = 5000` — idle gap before replay begins
- `REPLAY_CADENCE_MS = 4000` — interval between replay broadcasts
- `REPLAY_DIM = 0.5` — intensity multiplier vs. live (< 1, SC3 honesty invariant)
- `REPLAY_HISTORY_N = 20` — recent real rows kept in server replay ring buffer

**Layer 3 — ambient twinkle:**
- `TWINKLE_COUNT = 80` — rotating twinkle subset size (~0.5% of 15k corpus)
- `TWINKLE_PERIOD_MS = 2000` — sine breathe period per node
- `TWINKLE_AMP = 0.15` — brightness amplitude (neutral palette only)

All starting values are spec midpoints from `docs/superpowers/specs/2026-06-30-viz-ambient-liveliness-replay-traces-design.md`. Founder tunes at the Plan 05 visual checkpoint.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 — add 10 tunables | 6998cf4 | feat(54-01): add 10 Phase-54 ambient-liveliness tunables to constants.js |

## Acceptance Criteria Verification

- [x] All 10 constants exported (`grep -c ""` returns 10) — PASS
- [x] `REPLAY_DIM = 0.5 < 1` (honesty invariant SC3) — PASS
- [x] `DECAY_ATTACK_MS` still `140` (no existing constants modified) — PASS
- [x] `npx vitest run tests/viz-layout-guards.test.ts` — 22/22 PASS (no regression)
- [x] `node --input-type=module` import test — all invariants PASS

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — this plan adds inert constant declarations only; no data flow, no render paths.

## Threat Flags

None — pure constant declarations with no input, network, DB, or execution path. T-54-01 mitigated: `REPLAY_DIM < 1` baked into the starting value.

## Self-Check: PASSED

- `src/viz/modules/constants.js` — FOUND (modified, 41 lines added)
- Commit `6998cf4` — FOUND
- `ACT_SCALE_GAIN`, `REPLAY_DIM`, `TWINKLE_COUNT` exported and importable — VERIFIED
- `viz-layout-guards.test.ts` 22/22 green — VERIFIED
