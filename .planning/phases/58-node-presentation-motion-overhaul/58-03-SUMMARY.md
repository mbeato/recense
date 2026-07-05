---
phase: 58-node-presentation-motion-overhaul
plan: 03
subsystem: viz
tags: [three.js, troika-three-text, sdf-text, labels, lod]

# Dependency graph
requires:
  - phase: 58-node-presentation-motion-overhaul plan 01
    provides: Vendored troika-three-text 0.52.4 + JetBrains Mono TTF + import-map entries
provides:
  - "labels.js: initLabels(ctx) — top-N schema SDF label layer, appear-on-approach, depth-tested slate"
  - "labels.js: selectTopSchemas(ctx, n) — pure exported top-N-by-member-count helper"
  - "constants.js: LABEL_TOP_N (30), LABEL_DISTANCE_THRESHOLD (350), LABEL_COLOR (0xaab3c4)"
  - "lod.js: ctx.schemaMembers now published (was computed but not exposed)"
  - "tests/viz-activity-palette-invariants.test.ts: D-15 label-color luminance-band + non-amber lock"
  - "tests/viz-labels-selection.test.ts: top-N selection unit test"
affects: [58-node-presentation-motion-overhaul plan 05 (Stage-1 checkpoint — visual verification + LABEL_DISTANCE_THRESHOLD tuning)]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Diegetic in-scene SDF labels via vendored troika-three-text, faded by camera-distance damp (THREE.MathUtils.damp) inside a ctx.registerTick callback — mirrors the existing effects.js/trace.js tick-registration convention"]

key-files:
  created:
    - src/viz/modules/labels.js
    - tests/viz-labels-selection.test.ts
  modified:
    - src/viz/modules/constants.js
    - src/viz/modules/app.js
    - src/viz/modules/lod.js
    - tests/viz-activity-palette-invariants.test.ts

key-decisions:
  - "LABEL_DISTANCE_THRESHOLD = 350 (Claude's Discretion, provisional) — chosen between detail.js's focus-camera offset (~300 units from a selected node) and the overview camera distance (BRAIN_SCALE*2.2 ≈ 1012 from origin), so labels resolve when approaching/focused on a node but stay hidden at overview; flagged for tuning at the Stage-1 founder checkpoint (Plan 05)"
  - "Exposed ctx.schemaMembers from lod.js (Rule 3 minimal fix) — the Map was already built locally for classification (n.__members) but never published on ctx, despite the plan's interfaces notes and 58-RESEARCH assuming it was; publishing it (one line, mirrors sibling ctx fields already exposed) let labels.js read real member-count data via the same map the plan specified, instead of re-deriving it or leaning on a synthetic-looking test-only path"
  - "Billboard via text.quaternion.copy(camera.quaternion) rather than a full lookAt — simplest correct billboard for camera-facing SDF text, consistent with the module's per-frame tick-driven update style"

requirements-completed: [D-01, D-02, D-03, D-04, D-15]

# Metrics
duration: ~35min
completed: 2026-07-05
---

# Phase 58 Plan 03: Diegetic SDF Schema-Label Layer Summary

**Top-N schema super-nodes now render crisp in-scene troika SDF labels (slate, depth-tested, appear-on-approach) via a new labels.js module, with LABEL_COLOR machine-locked in-band and non-amber and top-N selection unit-tested.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2/2 completed
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `labels.js` exports `initLabels(ctx)`: builds one vendored troika `Text` mesh per top-N schema (by member count), slate `0xaab3c4` at ~0.7 target alpha, `depthTest: true` so opaque node meshes occlude naturally, billboarded to the camera and repositioned every frame via `ctx.registerTick`
- Appear-on-approach (D-03): labels start at opacity 0 and damp toward 0.7 only inside `LABEL_DISTANCE_THRESHOLD` of their schema node (`THREE.MathUtils.damp`, frame-rate independent), and back toward 0 outside it — the overview constellation stays label-free in both viewports
- All N labels call `.sync()` at boot to pre-warm the SDF atlas, avoiding first-approach pop-in
- `selectTopSchemas(ctx, n)` exported as a pure, side-effect-free helper — used by both `initLabels` and the new unit test
- Three new named constants in `constants.js`: `LABEL_TOP_N` (30), `LABEL_DISTANCE_THRESHOLD` (350, provisional), `LABEL_COLOR` (0xaab3c4)
- `app.js` wires `initLabels(ctx)` into the init chain right after `initGraph`/`initLod`
- `tests/viz-activity-palette-invariants.test.ts` gained a `D-15 label color lock` describe block: LABEL_COLOR's relative luminance sits inside the existing [170, 228] D-02 band, and a non-amber-family check (cool B>G>R ordering, the opposite of amber's warm R≈G>B)
- `tests/viz-labels-selection.test.ts` unit-tests `selectTopSchemas` against a synthetic ctx (troika `Text` mocked so labels.js imports without a browser/`three` dependency)

## Task Commits

Each task was committed atomically:

1. **Task 1: Build labels.js (top-N SDF schema labels, appear-on-approach) and wire into app.js** - `3832214` (feat)
2. **Task 2: Lock LABEL_COLOR (band + non-amber, D-15) and unit-test top-N selection** - `ee9a1d2` (test)

_No plan-metadata commit made in worktree mode — orchestrator commits SUMMARY.md/STATE.md/ROADMAP.md after merge._

## Files Created/Modified

- `src/viz/modules/labels.js` - New module: `initLabels(ctx)` + exported pure `selectTopSchemas(ctx, n)` helper
- `src/viz/modules/constants.js` - Added `LABEL_TOP_N`, `LABEL_DISTANCE_THRESHOLD`, `LABEL_COLOR` under a new "Phase 58 — schema labels" section
- `src/viz/modules/app.js` - Imports `initLabels` and calls it after `initGraph`/`initLod`, before `initEffects`
- `src/viz/modules/lod.js` - Now publishes `ctx.schemaMembers` (the Map was already built for classification but not previously exposed on ctx)
- `tests/viz-activity-palette-invariants.test.ts` - New `D-15 label color lock` describe block
- `tests/viz-labels-selection.test.ts` - New unit test for `selectTopSchemas`

## Decisions Made

- `LABEL_DISTANCE_THRESHOLD = 350` chosen against the two known camera-distance regimes in the codebase (focus ~300 units from detail.js's `focusCamera`, overview ~1012 units from origin via `BRAIN_SCALE*2.2`) — comfortably separates "approaching/focused" from "overview". Documented as provisional/Claude's-Discretion in both `constants.js` and this summary; the plan explicitly defers final tuning to the Stage-1 founder checkpoint (Plan 05).
- Exposed `ctx.schemaMembers` from `lod.js` rather than re-deriving member counts inside `labels.js` from `allLinks` — avoids duplicating the `abstracts`-edge aggregation logic that already lives in `lod.js` (single source of truth), and matches what the plan's `<interfaces>` section explicitly assumed was already exposed. See Deviations below.
- Billboard implementation uses `text.quaternion.copy(camera.quaternion)` (matches the camera's own orientation) rather than a `lookAt` call — simpler, correct for a camera-facing label, and consistent with the tick-driven per-frame update pattern already used elsewhere in the module set.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exposed ctx.schemaMembers from lod.js (was computed but never published)**
- **Found during:** Task 1 (labels.js top-N selection)
- **Issue:** The plan's `<interfaces>` section states "lod.js builds schemaMembers (Map<schemaId, Set<memberId>>) ... exposed on ctx" — but reading the actual current `lod.js` source showed `schemaMembers` was only a local closure variable used to compute `n.__members` on each node; it was never assigned onto `ctx`. Reading it as `ctx.schemaMembers` in `labels.js` per the plan's key_links would have been `undefined`, breaking `selectTopSchemas`.
- **Fix:** Added one line, `ctx.schemaMembers = schemaMembers;`, to lod.js's existing ctx-publish block (mirroring the adjacent `memberSchema`/`traceNodes`/etc. exposures already there), plus a one-line JSDoc addition to the "Sets on ctx" list at the top of the file.
- **Files modified:** `src/viz/modules/lod.js`
- **Verification:** `tests/viz-labels-selection.test.ts` exercises `selectTopSchemas` against a synthetic `ctx.schemaMembers`; the existing lod/LOD-density/ambient-liveliness test suites (which also import `lod.js`) still pass (160/160) after the change, confirming no behavior change to any existing consumer.
- **Committed in:** `3832214` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking, missing ctx field)
**Impact on plan:** Necessary for the plan's own specified data-flow to actually work; no architecture change (mirrors an existing, already-established ctx-publish pattern in the same file). No scope creep — no other lod.js behavior touched.

## Issues Encountered

None. The vendored troika `Text` class API (constructor defaults, lazy `material` getter/derivation, `sync()`, `.text`/`.font`/`.fontSize`/`.color` shortcut properties) was read directly from `src/viz/vendor/troika/troika-three-text.esm.js` (Plan 01's vendored file) to confirm the exact property names and behavior before writing `labels.js` — no guessing against stale documentation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

`labels.js` is fully wired and unit-tested; `LABEL_COLOR` is machine-locked. The remaining verification item — visual confirmation that labels render crisp/slate/occluded on approach and stay absent in the overview, plus a DevTools Network-tab check for zero `cdn.jsdelivr.net` requests with labels visible — is explicitly deferred to the Stage-1 founder checkpoint (Plan 05), per this plan's own `<verification>` section. `LABEL_DISTANCE_THRESHOLD` (350, provisional) should be the first thing tuned live at that checkpoint if labels feel like they trigger too early/late.

No blockers.

---
*Phase: 58-node-presentation-motion-overhaul*
*Completed: 2026-07-05*

## Self-Check: PASSED

All 6 created/modified source files + the summary itself verified present on disk; both task commits (`3832214`, `ee9a1d2`) verified present in git log.
