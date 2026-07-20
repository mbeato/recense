---
phase: 58-node-presentation-motion-overhaul
plan: 04
subsystem: viz
tags: [three.js, shader-material, matcap, onbeforecompile, png-encoding]

# Dependency graph
requires:
  - phase: 58-node-presentation-motion-overhaul plan 02
    provides: The existing shared node-material onBeforeCompile (rim injection) this plan extends in-place
provides:
  - "scripts/gen-matcap.mjs — regenerable grayscale matcap generator (zlib-only PNG encode/decode, no canvas/pngjs dep) with a --check self-verify"
  - "src/viz/vendor/matcaps/focus-matcap.png — committed 256x256 grayscale (R=G=B) studio-lit sphere texture"
  - "graph.js: uMatcapTex/uMatcapMix uniforms + vViewNormal varying inside the existing shared onBeforeCompile; mat.userData.matcapMixUniform per-node handle"
  - "graph.js: _focusGeo (32-seg) + exported focusNodeGeometry(node)/unfocusNodeGeometry(node) helpers"
  - "detail.js: selectNode/clearSelection drive the matcap mix target (1 on focus+1-hop, 0 on deselect) + focus-geometry swap, damped via one registerTick callback"
  - "constants.js: MATCAP_MIX_LAMBDA (Phase-58 focus matcap section)"
affects: [58-05 (Stage-1 visual checkpoint verifies the lit-glass-bead look live)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Zero-dependency PNG encode/decode via Node's builtin zlib (deflateSync/inflateSync) + hand-rolled CRC32/chunk framing — avoids adding canvas/pngjs as a devDependency for a one-shot asset-generation script"
    - "Matcap luminance-only compositing: sample a grayscale texture by view-space normal, multiply by the fragment's own already-computed color, then mix() by a per-node uniform — keeps hue on-palette while adding material richness"
    - "Damped per-node uniform fade tracked in a small Map (not O(allNodes)): entries are added when a target is set and pruned once settled at 0, mirroring labels.js's registerTick damp pattern"

key-files:
  created:
    - scripts/gen-matcap.mjs
    - src/viz/vendor/matcaps/focus-matcap.png
  modified:
    - src/viz/modules/graph.js
    - src/viz/modules/detail.js
    - src/viz/modules/constants.js
    - tests/viz-seed-determinism.test.ts
    - tests/viz-haze-selection.test.ts

key-decisions:
  - "PNG encode/decode written from scratch on top of Node's builtin zlib rather than adding a canvas/pngjs devDependency — net-zero new deps, and the encoder/decoder only need to understand the one fixed format (8-bit truecolor RGB, filter-type None) this script itself always produces, since --check re-decodes its own committed asset"
  - "matcap sphere lit with an analytic 3-light (key/fill/specular) Blinn-Phong rig rather than a rendered three.js scene — deterministic pure function (byte-identical --check re-render), no headless-GL/canvas dependency"
  - "Matcap fade-in/out is driven from an independent setNodeMatcap/clearNodeMatcap pair in detail.js, decoupled from applyFocusDim/clearFocusDim's dim-mode branching (which differs for schema vs plain-node selection) — so the focused node always gets the 32-seg geometry + matcap treatment regardless of which dim path (neighborhood vs schema-membership) is active"
  - "Matcap target is only ever set when node.__mat.userData.matcapMixUniform exists — this is a silent no-op for haze-tier nodes (InstancedMesh has no per-node __mat), so D-10 (haze never gets matcap) holds structurally rather than via an explicit category check"

requirements-completed: [D-09, D-10, D-11, D-12, D-15]

# Metrics
duration: ~20min
completed: 2026-07-05
---

# Phase 58 Plan 04: Focus-Tier Matcap Material Richness Summary

**Selected node + 1-hop neighbors now read as damped-fade lit glass beads via a script-generated grayscale matcap sampled inside the existing shared node shader and multiplied by the node's own LOCKED-palette hue, plus a 32-seg focus geometry on the selected node.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-05T15:02Z (Task 1 commit)
- **Completed:** 2026-07-05T15:11Z (Task 3 commit)
- **Tasks:** 3/3 completed
- **Files modified:** 7 (2 created, 5 modified)

## Accomplishments

- `scripts/gen-matcap.mjs`: a standalone manual dev script (never runs at install/build) that renders an analytic studio-lit grayscale sphere and encodes it as a valid PNG using only Node's builtin `zlib` — no canvas/pngjs/three.js dependency. `--check` re-decodes the committed asset, asserts every pixel is grayscale (R≈G≈B) within tolerance, and byte-compares it against a fresh deterministic render, so the committed texture can never silently drift or gain a baked-in hue (D-15).
- `src/viz/vendor/matcaps/focus-matcap.png` committed (256x256, 8-bit truecolor RGB, grayscale by construction).
- `graph.js`'s existing shared node-material `onBeforeCompile` (the same function that already injects the rim effect) now also injects a `vViewNormal` varying and `uMatcapTex`/`uMatcapMix` uniforms; the fragment shader samples the matcap by view-space normal, multiplies it by the node's own already-computed `gl_FragColor.rgb` (luminance-only, D-10/D-04-safe), and `mix()`s it in by `uMatcapMix` — appended after the rim line, never replacing it. `mat.userData.matcapMixUniform` exposes the per-node uniform for detail.js.
- `graph.js` gained a sibling `_focusGeo = SphereGeometry(1,32,32)` plus exported `focusNodeGeometry(node)`/`unfocusNodeGeometry(node)` helpers that swap `node.__mesh.geometry` in place (no new mesh allocation).
- `detail.js`'s `selectNode` fades the focused node + its 1-hop adjacency neighbors' matcap mix toward 1 and swaps the focused node onto `_focusGeo`; `clearSelection` (invoked on every new selection and from `closeDetail`) fades back toward 0 and restores `_sharedGeo`. A single `registerTick` callback damps each tracked node's `uMatcapMix` via `THREE.MathUtils.damp(..., MATCAP_MIX_LAMBDA, dt)`, pruning settled (target-0) entries from its tracking `Map` so the tick cost stays proportional to the currently-focused set, never `O(allNodes)`.
- `MATCAP_MIX_LAMBDA` added to `constants.js` under a new Phase-58 section (feel constant, D-15 UNLOCKED).
- Haze/overview tiers never get matcap: `setMatcapTarget` is a no-op whenever `node.__mat.userData.matcapMixUniform` is absent, which is structurally true for every haze `InstancedMesh` instance (no per-node `__mat` at all) — so D-10 holds without an explicit category branch.

## Task Commits

Each task was committed atomically:

1. **Task 1: gen-matcap.mjs offline generator + --check grayscale self-verify + committed PNG** - `76af519` (feat)
2. **Task 2: Matcap onBeforeCompile extension + 32-seg _focusGeo + focus geometry swap (graph.js)** - `9b04106` (feat)
3. **Task 3: Drive the matcap mix on select/deselect + damped fade in registerTick (detail.js)** - `8d584cf` (feat)

_No plan-metadata commit made in worktree mode — orchestrator commits SUMMARY.md/STATE.md/ROADMAP.md after merge._

## Files Created/Modified

- `scripts/gen-matcap.mjs` - Offline matcap generator + `--check` self-verify (zlib-only PNG encode/decode, analytic studio-lit sphere render)
- `src/viz/vendor/matcaps/focus-matcap.png` - Committed grayscale matcap asset
- `src/viz/modules/graph.js` - Extended the shared node `onBeforeCompile` with matcap uniforms/varying; added `_focusGeo` + `_matcapTex` module-scope constants; added exported `focusNodeGeometry`/`unfocusNodeGeometry` helpers
- `src/viz/modules/detail.js` - `setNodeMatcap`/`clearNodeMatcap`/`setMatcapTarget` + a `registerTick` damp callback; wired into `selectNode` (fade-in + geometry swap) and `clearSelection` (fade-out + geometry restore)
- `src/viz/modules/constants.js` - New `MATCAP_MIX_LAMBDA` under a "Phase 58 — focus matcap" section
- `tests/viz-seed-determinism.test.ts` - Added `TextureLoader` mock stub (Rule 1 fix — see Deviations)
- `tests/viz-haze-selection.test.ts` - Added `Matrix4`/`TextureLoader` mock stubs + moved DOM-global setup into `vi.hoisted` (Rule 1 fix — see Deviations)

## Decisions Made

- PNG encode/decode built from scratch on Node's builtin `zlib` (no canvas/pngjs dependency) — the encoder/decoder only need to agree with each other's fixed format (8-bit truecolor RGB, filter-type None), since `--check` always re-decodes this script's own committed output.
- The analytic 3-light Blinn-Phong sphere render is a pure deterministic function of pixel coordinates — guarantees byte-identical `--check` re-renders with zero headless-GL/canvas dependency, mirroring `gen-simd-kernel.cjs`'s regenerable-derived-asset convention.
- Matcap fade-in/out lives in its own `setNodeMatcap`/`clearNodeMatcap` pair, independent of `applyFocusDim`/`clearFocusDim`'s existing dim-mode branching (plain-neighborhood dim vs schema-membership dim) — so a schema-node selection still gets the lit-glass-bead + 32-seg treatment on the schema node itself, without duplicating or fighting the dim logic.
- Matcap targeting relies on the structural absence of `mat.userData.matcapMixUniform` on haze nodes (no per-instance `__mat` on an `InstancedMesh`) rather than an explicit `__cat === 'haze'` check — D-10 holds by construction.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `tests/viz-seed-determinism.test.ts` needed a `TextureLoader` mock stub**
- **Found during:** Task 2 (matcap `onBeforeCompile` extension)
- **Issue:** `graph.js` now constructs `new THREE.TextureLoader().load(...)` at module scope (loading `_matcapTex` once). This test's THREE mock (pre-existing) didn't export `TextureLoader`, so importing `graph.js` (via `seedNodePositions`) failed at import time.
- **Fix:** Added a minimal `TextureLoader` mock class (`load()` returning `{}`) and exported it from the mock factory, mirroring the same file's existing `PlaneGeometry` stub added in Plan 02.
- **Files modified:** `tests/viz-seed-determinism.test.ts`
- **Verification:** `npx vitest run tests/viz-seed-determinism.test.ts` passes (22/22).
- **Committed in:** `9b04106` (Task 2 commit)

**2. [Rule 1 - Bug] `tests/viz-haze-selection.test.ts` broke after detail.js started importing graph.js**
- **Found during:** Task 3 (wiring `focusNodeGeometry`/`unfocusNodeGeometry` into detail.js)
- **Issue:** `detail.js` now imports `graph.js` for the focus-geometry helpers. This test file's own top-level `(globalThis as any).window = {...}` assignment (positioned textually before its `import { initDetail } from '../src/viz/modules/detail.js'` line, with a comment claiming "Must be set BEFORE the module is imported") does NOT actually run before the import: ES static imports are fully hoisted and evaluated before any of the importing module's own top-level statements, regardless of source position. `graph.js`'s module-scope `const COMPACT = Math.min(window.innerWidth, window.innerHeight) <= 500` (pre-existing code, unrelated to this plan) now runs during that hoisted import evaluation, before `window` exists — throwing `ReferenceError: window is not defined`. The same import chain also hit a missing `Matrix4` mock (`graph.js`'s module-scope `_inv = new THREE.Matrix4()`) and the same missing `TextureLoader` as fix #1.
- **Fix:** Moved the DOM-global setup (`document`/`window`/`location`/`BroadcastChannel`/`performance`) into a `vi.hoisted(() => {...})` block — vitest's supported mechanism for code that must run before all `vi.mock` calls and imports, regardless of source position. Added minimal `Matrix4` and `TextureLoader` mock stubs to the existing THREE mock factory.
- **Files modified:** `tests/viz-haze-selection.test.ts`
- **Verification:** `npx vitest run tests/viz-haze-selection.test.ts` passes (5/5, was previously erroring at import with "window is not defined" once detail.js gained the graph.js import).
- **Committed in:** `8d584cf` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — test-mock bugs made unavoidable by this plan's own new module-scope dependencies)
**Impact on plan:** Both fixes are direct, minimal consequences of the matcap texture load / focus-geometry import this plan requires — no scope creep beyond what those additions necessitated.

## Issues Encountered

None beyond the two deviations above. Full `npx vitest run` at close: 164 files passed / 7 failed (23 tests), all 7 failing files pre-existing and unrelated to `src/viz/modules/*` (CLI-subprocess exit-code tests already logged in `deferred-items.md` by Plan 02 — `adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`). All 15 `tests/viz-*.test.ts` files (306 tests) pass green, including the two haze-regression files named in this plan's own acceptance criteria.

`tsc --noEmit` shows pre-existing errors in `tests/viz-labels-selection.test.ts` (from Plan 03, unrelated to this plan's files) — not touched here, out of scope.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The matcap machinery is code-complete and unit/source-verified: `node scripts/gen-matcap.mjs --check` exits 0, the source-scan verify commands from all three tasks pass, and the full `tests/viz-*.test.ts` suite (306 tests) is green.
- **Live visual verification is explicitly deferred to the Stage-1 founder checkpoint (Plan 05)** per this plan's own `<verification>` section: does the focused node + 1-hop neighborhood actually read as "lit glass beads" on real hardware, with hue unchanged and the overview constellation unaffected? This has NOT been visually confirmed in this plan.
- `focusNodeGeometry`/`unfocusNodeGeometry` (graph.js) and `mat.userData.matcapMixUniform` are now part of the ctx-adjacent surface any future plan touching node selection/focus should be aware of.

---
*Phase: 58-node-presentation-motion-overhaul*
*Completed: 2026-07-05*

## Self-Check: PASSED

- FOUND: scripts/gen-matcap.mjs
- FOUND: src/viz/vendor/matcaps/focus-matcap.png
- FOUND: src/viz/modules/graph.js
- FOUND: src/viz/modules/detail.js
- FOUND: src/viz/modules/constants.js
- FOUND: tests/viz-seed-determinism.test.ts
- FOUND: tests/viz-haze-selection.test.ts
- FOUND commit: 76af519
- FOUND commit: 9b04106
- FOUND commit: 8d584cf
