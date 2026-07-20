---
phase: 54-viz-ambient-liveliness-and-replay-traces
plan: "02"
subsystem: viz-client
tags: [trace, ambient, liveliness, replay, twinkle, three-js, tdd]
dependency_graph:
  requires: [54-01]
  provides: [layer1-amplification, layer2-replay-echo, layer3-twinkle]
  affects: [src/viz/modules/trace.js]
tech_stack:
  added: []
  patterns: [tdd-red-green, source-text-guard, lazy-init, closure-state]
key_files:
  created:
    - tests/viz-ambient-liveliness.test.ts
  modified:
    - src/viz/modules/trace.js
decisions:
  - "Behavioral test for ACT_SCALE_GAIN scale coefficient (not clamped, clearly distinguishable at 1.35 vs 1.9); source-text guards for ACT_BRIGHTEN_GAIN and ACT_HAZE_LERP (clamping to Math.min(1,...) makes opacity values identical at peak)"
  - "Twinkle neutral tint 0x7a8a9a (cool blue-gray) — not HOT amber, not any KIND_COLOR event hue, so twinkle reads as decorative ambient at a glance"
  - "Per-instance phase offset 750ms per hazeIdx unit for visual spread across the subset without per-node state"
  - "Rotation cadence: every TWINKLE_COUNT frames (re-pick the subset) — gives visual variation without per-frame O(N) allNodes scan (Pitfall 2)"
  - "Replay branch slots before kind dispatch (returns early) so row.replay rows never reach _applyIngestion; uses same traceEdgesFromHops path as live recall for honesty"
metrics:
  duration: "8m"
  completed: "2026-06-30T20:12:21Z"
  tasks_completed: 3
  files_changed: 2
---

# Phase 54 Plan 02: trace.js Three-Layer Ambient Liveliness Summary

All three client-side render layers implemented in `src/viz/modules/trace.js` in a single plan with no merge conflict surface: Layer 1 (live recall amplification via named gain constants), Layer 2 (replay echo branch at REPLAY_DIM intensity), and Layer 3 (bounded ambient twinkle tick on the master rAF loop).

## Tasks Completed

| Task | Name | Type | RED commit | GREEN commit |
|------|------|------|------------|--------------|
| 1 | Layer 1 — amplify live recall flash | TDD | d36236b | 712103b |
| 2 | Layer 2 (client) — replay echo branch | TDD | 4223642 | 1a57da6 |
| 3 | Layer 3 — bounded ambient twinkle tick | auto | — | 8c74e18 |

## What Was Built

**Layer 1 — Live recall amplification (SC2):**
- `ACT_SCALE_GAIN`, `ACT_BRIGHTEN_GAIN`, `ACT_HAZE_LERP` imported from `constants.js`
- Regular-node scale: `1 + a * 0.35` → `1 + a * ACT_SCALE_GAIN` (0.9 → ~1.9× at peak)
- Regular-node opacity: `a * 0.4` → `a * ACT_BRIGHTEN_GAIN` (0.55 → brighter peak)
- Haze color lerp: `a * 0.8` → `a * ACT_HAZE_LERP` (0.95 → stronger color shift)
- `setColorAt` only in haze path; `setMatrixAt` never introduced (SC5 perf invariant)

**Layer 2 — Replay echo branch (SC3):**
- `REPLAY_DIM` imported from `constants.js`
- `row.replay === true` branch added in `applyTrace` after back-compat guard, before kind dispatch
- Uses same `normalizeSeed` + `traceEdgesFromHops` path as live recall (no ctx.adj — honesty)
- `activate(node, intensity * REPLAY_DIM)` for seeds and hops — replay strictly dimmer than live
- Empty-seed guard: returns early with no side effects (Pitfall 3 from 54-RESEARCH.md)
- Fade-back `setTimeout` mirrors live recall pattern

**Layer 3 — Ambient twinkle tick (SC1):**
- `TWINKLE_COUNT`, `TWINKLE_PERIOD_MS`, `TWINKLE_AMP` imported from `constants.js`
- `twinkleTick(now)` function defined inside `initTrace` closure (accesses shared `active` Set)
- Registered via `ctx.registerTick(twinkleTick)` alongside the existing main tick
- Lazy init: `if (!ctx.hazeMesh || !ctx.allNodes?.length) return;` on first tick
- Subset built once from `allNodes.filter(n => n.__cat === 'haze' && n.__hazeIdx != null)`, up to `TWINKLE_COUNT` nodes
- Rotated every `TWINKLE_COUNT` frames via a `twinklePtr` window pointer (Pitfall 2)
- Stateless sine breathe: `TWINKLE_AMP * (0.5 + 0.5 * Math.sin(phase))` with per-hazeIdx phase offset
- Neutral/cool tint `THREE.Color(0x7a8a9a)` — not HOT amber, not any KIND_COLOR event hue
- Active nodes skipped: `if (active.has(node)) continue;` (live/replay flash has priority)
- One `instanceColor.needsUpdate = true` per tick (not per node)
- No `spawnPulse`, no `revealTrace`, no halos, no `setMatrixAt`

**Tests created (`tests/viz-ambient-liveliness.test.ts`):**
- 4 Layer 1 tests (1 behavioral + 2 source-text + 1 non-regression)
- 7 Layer 2 tests (2 behavioral intensity + 1 hop-honesty + 1 empty-seed + 1 non-replay + 2 source-text)
- 7 Layer 3 tests (registration, setColorAt call, active-skip, revealTrace absent, lazy guard, constants, setMatrixAt regression)
- Total plan tests: 18 new; 39 passing across all three suites

## Success Criteria Verification

- **SC1 (machine slice):** `twinkleTick` registered via `ctx.registerTick`; fires at 24fps idle (master loop confirmed non-sleeping in 54-RESEARCH.md). Verified by `ticks.length === 2` and setColorAt call tests.
- **SC2 (machine slice):** Scale at peak = `1 + ACT_SCALE_GAIN` (1.9 vs old 1.35); behavioral test + source-text guards green.
- **SC3 (machine slice):** Replay strictly dimmer (`replayPeak ≈ livePeak * REPLAY_DIM`); twinkle calls no spawnPulse/revealTrace; Phase 52 honesty guards (21 tests) remain green.
- **SC5:** `setMatrixAt` absent from trace.js code lines (comment-stripped source-text guard).

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All three layers are wired to real data (constants from 54-01, real haze nodes from ctx.allNodes, real activation state from the `active` Set).

## Threat Flags

None. All changes are browser-side render code with no network/DB/auth/exec surface. The only trust boundary (SSE row → `applyTrace`) is handled by the existing replay branch which reuses the already-validated live path (traceEdgesFromHops, no ctx.adj) and caps intensity via REPLAY_DIM.

## Self-Check: PASSED

Files exist:
- `src/viz/modules/trace.js` — FOUND (modified)
- `tests/viz-ambient-liveliness.test.ts` — FOUND (created)
- `.planning/phases/54-viz-ambient-liveliness-and-replay-traces/54-02-SUMMARY.md` — FOUND (this file)

Commits exist (verified via `git log --oneline`):
- d36236b — test(54-02): add failing tests for Layer 1 amplification
- 712103b — feat(54-02): amplify live recall flash through gain constants
- 4223642 — test(54-02): add failing tests for Layer 2 replay echo branch
- 1a57da6 — feat(54-02): add replay echo branch in applyTrace
- 8c74e18 — feat(54-02): add ambient twinkle tick (Layer 3) and Layer 3 tests

Test suite: 39/39 passing (`npx vitest run tests/viz-ambient-liveliness.test.ts tests/trace-honest-recall.test.ts tests/viz-haze-activation.test.ts`)
