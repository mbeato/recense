---
phase: 52-brain-viz-honest-traces
plan: 03
subsystem: ui
tags: [viz, three, activation-trace, ingestion, per-kind-color, reconsolidation, choreography]

# Dependency graph
requires:
  - phase: 52-02
    provides: applyTrace(row), normalizeSeed, traceEdgesFromHops, KIND_COLOR palette, KIND_COLORS pre-built objects

provides:
  - applyTrace dispatches on row.kind; recall/absent → byte-unchanged Plan-02 path
  - new_node: quiet green blip (KIND_COLOR.new_node, modest intensity, no spreading)
  - oscillation: 3x orange strobing activate calls ~280ms apart (visibly unsettled, bounded)
  - neutral fallback: muted slate for confirm/extend/schema_emitted/etc (non-amber per D-04)
  - reconsolidation hero: green arriving blip (spawnPulse candidate→existing) + magenta flash on existing node
  - activate(node, level, kindColor): __actColor per-node; tick lerps to node.__actColor||HOT_COLOR
  - spawnPulse(from, to, color): color param drives per-kind uColor uniform in wavefront shader

affects: [52-06, viz/trace, viz/hud]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "KIND_COLORS: pre-built THREE.Color objects at initTrace() — zero per-frame allocation"
    - "activate(node, level, kindColor): __actColor stored per-node; tick uses it for lerp target"
    - "_applyIngestion: inner function handles all non-recall kinds; isolates ingestion logic from recall path"
    - "reconsolidation timing: WF_SWEEP (850ms) setTimeout gates magenta flash after blip arrival"

key-files:
  created: []
  modified:
    - src/viz/modules/trace.js

key-decisions:
  - "Implement both tasks in one file edit — Tasks 1 and 2 are inseparable in _applyIngestion; committed as single atomic unit"
  - "activate() 3rd param kindColor defaults to HOT_COLOR — recall path calls activate(node, intensity) unchanged; no recall-path regressions possible"
  - "oscillation strobe: 3 activations at 0ms / 280ms / 560ms — bounded by design (T-52-07 accept disposition); fixed count, standard decay"
  - "reconsolidation graceful degradation: missing candidate → flash-only; missing seed → no-op; never throws"

requirements-completed: [SPEC-SC3, D-03, D-05, D-07-magnitude]

# Metrics
duration: 3min
completed: 2026-06-29
---

# Phase 52 Plan 03: Per-Kind Color + Motion Vocabulary + Reconsolidation Hero Summary

**Per-kind ingestion vocabulary wired into applyTrace: new_node green blip, oscillation orange strobe, muted-neutral fallback, and reconsolidation full D-05 choreography (green arriving evidence blip → magenta in-place belief-update flash → decay); zero duplicate node spawns enforced.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-06-29T22:19:23Z
- **Completed:** 2026-06-29T22:22:50Z
- **Tasks:** 2 (implemented together in one file edit)
- **Files modified:** 1

## Accomplishments

- `applyTrace` dispatches on `row.kind` via `const kind = row.kind ?? null` before the recall path; recall/absent/null falls through to the byte-unchanged Plan-02 path
- `activate(node, level, kindColor)` stores `node.__actColor`; the per-frame tick lerps to `node.__actColor || HOT_COLOR` so each kind's colour drives the activation glow
- `spawnPulse(from, to, color)` parameterizes the `uColor` uniform so the wavefront shader renders per-kind color (used by reconsolidation's green arriving blip)
- `new_node`: single green (`KIND_COLORS.new_node`) activate at modest intensity (max 0.7), no spreading
- `oscillation`: orange (`KIND_COLORS.oscillation`) strobe — 3 activate calls at t=0/280/560ms; decays via standard D-06 envelope; bounded per T-52-07 accept
- `neutral`: muted slate (`KIND_COLORS.neutral`) at low intensity (max 0.5, scaled 0.6×score) — never amber (D-04 palette lock)
- `reconsolidation` (D-05 full choreography): green blip travels candidate→existing (`spawnPulse` with `KIND_COLORS.new_node`); after WF_SWEEP (850ms) setTimeout triggers magenta flash (`KIND_COLORS.reconsolidation`, #ff3b6b) on existing node; standard decay envelope settles; zero `Graph.graphData` mutation (T-52-06 enforced)
- All 17 `tests/trace-honest-recall.test.ts` assertions remain green — recall path behaviour unchanged

## Task Commits

1. **Tasks 1 + 2: per-kind vocabulary + reconsolidation choreography** - `1d0cc42` (feat)

## Files Created/Modified

- `src/viz/modules/trace.js` — KIND_COLOR import + KIND_COLORS at init; activate/spawnPulse color params; tick lerp target; applyTrace kind dispatch; _applyIngestion inner function with all four branches

## Decisions Made

- **Single commit for Tasks 1 + 2**: both tasks landed in `_applyIngestion` in one file; separating via patch staging would have introduced unnecessary risk. Committed atomically.
- **activate() kindColor defaults to HOT_COLOR**: recall path passes no kindColor → `undefined || HOT_COLOR`; amber is the fallback, matching Plan-02 behaviour exactly.
- **oscillation: fixed 3-pulse strobe**: bounded by design (T-52-07 accepted); decays via standard envelope; no unbounded re-trigger risk.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria met on first implementation pass.

## Known Stubs

None — all branches are wired to real KIND_COLORS from the palette constant.

## Threat Flags

None — all changes are client-side presentation only. No new trust boundaries beyond the existing SSE `row.kind` string dispatched via the existing client-trusted SSE channel. T-52-06 (no duplicate node spawns) enforced in code and grep-verifiable.

## Self-Check: PASSED

- `src/viz/modules/trace.js` exists and contains `row.kind` dispatch: FOUND
- `KIND_COLORS.new_node` referenced: FOUND
- `KIND_COLORS.reconsolidation` referenced (magenta flash): FOUND
- `KIND_COLORS.oscillation` 3x activate calls: FOUND
- `KIND_COLORS.neutral` neutral fallback: FOUND
- `spawnPulse(candidateNode, seedNode, KIND_COLORS.new_node)` reconsolidation blip: FOUND
- Zero `Graph.graphData` calls in reconsolidation branch: CONFIRMED (grep returns only comments)
- Commit `1d0cc42` present in git log: FOUND
- `npx vitest run tests/trace-honest-recall.test.ts`: 17/17 PASS

---
*Phase: 52-brain-viz-honest-traces*
*Completed: 2026-06-29*
