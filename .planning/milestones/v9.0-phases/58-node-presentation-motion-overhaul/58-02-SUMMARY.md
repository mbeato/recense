---
phase: 58-node-presentation-motion-overhaul
plan: 02
subsystem: viz
tags: [three.js, shader-material, instancedmesh, raycasting, billboard-impostor]

# Dependency graph
requires:
  - phase: 57-viz-activity-palette-redesign
    provides: luminance-equalized identity palette + LOCKED 0.72 bloom threshold this plan's blending choice must respect
provides:
  - Haze InstancedMesh renders as billboard radial-falloff quads (soft atmosphere) instead of dim opaque spheres
  - ctx.hazeRayProxy — invisible sphere InstancedMesh for correct orientation-agnostic haze raycasting
  - ALPHA_TEST_THRESHOLD named constant (constants.js)
affects: [58-05 (Stage-1 visual checkpoint verifies this haze look live)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Instanced billboard impostor: vertex shader rebuilds a camera-facing basis from viewMatrix columns, discarding the instance's own rotation, for cheap per-instance billboarding with zero CPU-side per-frame work"
    - "alphaTest discard (not additive blending) preserves depthWrite:true mutual occlusion on translucent radial-falloff quads without needing a depth sort"
    - "Raycast proxy pattern: an invisible orientation-agnostic sphere InstancedMesh sharing the SAME instanceMatrix attribute object as the visible mesh, so hide/restore mutations on one automatically apply to both"
    - "Material.opacity property proxy via Object.defineProperty on a raw ShaderMaterial, forwarding get/set to a uniform, to preserve an existing plain-property read/write contract (detail.js focus-dim) without touching the consuming module"

key-files:
  created: []
  modified:
    - src/viz/modules/graph.js
    - src/viz/modules/constants.js
    - tests/viz-haze-activation.test.ts
    - tests/viz-haze-selection.test.ts
    - tests/viz-seed-determinism.test.ts

key-decisions:
  - "Both haze raycast call sites (hover at pointermove and click at pointerup) were repointed to ctx.hazeRayProxy, not just the click site the plan's interfaces section named — the hover raycast uses the identical intersectObject(ctx.hazeMesh) pattern and would have the same orientation-dependent-hit-testing bug against the billboard quads"
  - "hazeRayProxy shares hazeMesh's instanceMatrix by object reference (not a copy) so the existing focus-hide/restore code (which mutates ctx.hazeMesh via setMatrixAt) keeps the proxy in sync for free"
  - "detail.js's ctx.hazeMat.opacity = X contract (focus-dim) is preserved via an Object.defineProperty getter/setter proxying to the uniform — a raw ShaderMaterial's opacity property is not auto-synced to any GPU uniform by WebGLRenderer (verified in vendored three.module.js: refreshMaterialUniforms only does that for built-in materials), so detail.js needed zero changes"
  - "Task 1's commit temporarily hardcoded 0.02 for the alphaTestThreshold uniform's initial value (constants.js doesn't yet exist at that commit); Task 2's commit swaps it to the ALPHA_TEST_THRESHOLD import, matching the plan's task-boundary file ownership"

requirements-completed: [HAZE-IMPOSTOR, D-16]

# Metrics
duration: 15min
completed: 2026-07-05
---

# Phase 58 Plan 02: Haze Billboard Impostor Summary

**Haze InstancedMesh swapped from a shared-sphere MeshBasicMaterial to a custom billboard ShaderMaterial with radial-falloff + alphaTest discard, plus an invisible sphere raycast proxy so clicks/hover still hit correctly.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-05T15:38:33Z (base commit)
- **Completed:** 2026-07-05T15:51:13Z
- **Tasks:** 2 completed
- **Files modified:** 5

## Accomplishments

- `buildHazeLayer` (graph.js) now constructs a `THREE.ShaderMaterial` (billboard vertex shader + radial `smoothstep` falloff fragment with an `alphaTest`-style discard) instead of the old `MeshBasicMaterial` + Fresnel-rim `onBeforeCompile`, backed by a new module-scope `_hazeQuadGeo` `PlaneGeometry`
- Normal blending only — no `AdditiveBlending` anywhere in `buildHazeLayer` — so dense overlapping haze can never stack luminance across the LOCKED 0.72 bloom threshold (T-58-02 mitigated)
- All existing instancing bookkeeping preserved verbatim: the Halton per-instance loop, `setMatrixAt`/`setColorAt`, `hazeInstanceMap`/`hazeNodeIdMap`, `hazeMat._baseOpacity`
- New `ctx.hazeRayProxy` — an invisible sphere `InstancedMesh` sharing `hazeMesh`'s `instanceMatrix` object — is now the raycast target for both haze hover and haze click, fixing the orientation-dependence a billboard quad's real (non-billboarded) instance rotation would otherwise introduce
- New `ALPHA_TEST_THRESHOLD` constant in a clean additive `constants.js` section (no LOCKED constant touched)

## Task Commits

1. **Task 1: Swap haze geometry+material to a billboard radial-falloff ShaderMaterial + raycast proxy** - `37ac598` (feat)
2. **Task 2: Add HAZE_FALLOFF/alphaTest constants and update haze test mocks** - `07e0264` (feat)

_No plan-metadata commit yet — this SUMMARY.md is committed separately per worktree convention (STATE.md/ROADMAP.md updates deferred to the orchestrator)._

## Files Created/Modified

- `src/viz/modules/graph.js` - `buildHazeLayer` material/geometry swap, `_hazeQuadGeo` module const, `ctx.hazeRayProxy` construction, both haze raycast call sites repointed to the proxy, updated doc comments
- `src/viz/modules/constants.js` - new additive `// === Phase 58 — haze impostor ===` section with `ALPHA_TEST_THRESHOLD`
- `tests/viz-haze-activation.test.ts` - added `PlaneGeometry` mock stub to the THREE mock
- `tests/viz-haze-selection.test.ts` - added `PlaneGeometry` mock stub to the THREE mock
- `tests/viz-seed-determinism.test.ts` - added `PlaneGeometry` mock stub (Rule 1 fix — see Deviations)

## Decisions Made

- Both haze raycast call sites (hover + click), not just the click site named in the plan's interfaces section, were repointed to `ctx.hazeRayProxy` — see Deviations.
- `hazeRayProxy.instanceMatrix = hazeMesh.instanceMatrix` (shared reference, not a copy) so the existing focus-hide/restore code (`_hideHazeInstance`/`_restoreHazeInstance`, which mutates `ctx.hazeMesh` directly) automatically keeps the proxy's hit-test geometry in sync with zero extra bookkeeping.
- `hazeMat.opacity` is proxied via `Object.defineProperty` (getter/setter forwarding to the `hazeOpacity` uniform) rather than modifying `detail.js` — confirmed in the vendored `three.module.js` that `refreshMaterialUniforms` only auto-syncs `material.opacity` into a uniform for built-in materials, not raw `ShaderMaterial`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Haze hover raycast also needed repointing to the proxy**
- **Found during:** Task 1 (billboard swap implementation)
- **Issue:** The plan's interfaces section named only the click-site raycast (`graph.js:965`) for repointing to the proxy, but the hover raycast (`_onHazePointerMove`) uses the identical `hazeRay.intersectObject(ctx.hazeMesh, false)` pattern. Left unchanged, hover hit-testing would go orientation-dependent and wrong against the billboard quad's real (non-billboarded) instance rotation — the exact bug class the proxy exists to prevent.
- **Fix:** Repointed both `intersectObject` call sites (hover at the former line ~951, click at the former line ~1037) to `ctx.hazeRayProxy`.
- **Files modified:** src/viz/modules/graph.js
- **Verification:** Source-scan confirms `ctx.hazeRayProxy` referenced at both raycast call sites; no remaining `intersectObject(ctx.hazeMesh` in the file.
- **Committed in:** 37ac598 (Task 1 commit)

**2. [Rule 1 - Bug] `tests/viz-seed-determinism.test.ts` broke after the geometry swap**
- **Found during:** Task 1, running the broader test suite beyond the two files the plan scoped
- **Issue:** This test imports `seedNodePositions` from `graph.js`, which runs the whole module's top-level code at import time — including the new module-scope `const _hazeQuadGeo = new THREE.PlaneGeometry(2, 2)`. The test's THREE mock (pre-existing, unrelated to this plan) didn't export `PlaneGeometry`, so import failed with "No PlaneGeometry export is defined on the three mock."
- **Fix:** Added the same minimal `PlaneGeometry` mock stub used in the two plan-scoped haze test files.
- **Files modified:** tests/viz-seed-determinism.test.ts
- **Verification:** `npx vitest run tests/viz-seed-determinism.test.ts` passes (9/9); confirmed via re-run after the fix.
- **Committed in:** 07e0264 (Task 2 commit, bundled with the other mock updates)

---

**Total deviations:** 2 auto-fixed (both Rule 1 - bug fixes required by the geometry/raycast swap)
**Impact on plan:** Both fixes are direct correctness consequences of the billboard-quad swap this plan implements — no scope creep beyond what the swap itself required.

## Issues Encountered

None beyond the two deviations above.

## Out-of-Scope Test Failures (logged, not fixed)

Running the full `npx vitest run` suite (beyond this plan's scoped tests) surfaces 23 pre-existing failures across 7 files (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`) — all CLI-subprocess exit-code tests in unrelated engine surfaces, none touching `src/viz/modules/*`. Logged to `.planning/phases/58-node-presentation-motion-overhaul/deferred-items.md` per the scope-boundary rule; not investigated or fixed here.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The haze billboard-impostor swap is code-complete and unit-verified (source scan + all four viz tests importing `graph.js` green). The plan's own `<verification>` section flags a **live visual check as deferred to the Plan 05 Stage-1 checkpoint** ("haze reads as atmosphere; no rectangular occlusion; no fake flare in dense clusters") — that verification has NOT been run in this plan and remains open for Plan 05.
- `ctx.hazeRayProxy` is now part of the ctx surface any future plan touching haze interaction (hover/click/focus) should be aware of.

---
*Phase: 58-node-presentation-motion-overhaul*
*Completed: 2026-07-05*

## Self-Check: PASSED

- FOUND: src/viz/modules/graph.js
- FOUND: src/viz/modules/constants.js
- FOUND: .planning/phases/58-node-presentation-motion-overhaul/58-02-SUMMARY.md
- FOUND: .planning/phases/58-node-presentation-motion-overhaul/deferred-items.md
- FOUND commit: 37ac598
- FOUND commit: 07e0264
