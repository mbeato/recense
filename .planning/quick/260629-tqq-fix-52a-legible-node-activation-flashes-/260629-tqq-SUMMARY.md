---
quick_id: 260629-tqq
slug: fix-52a-legible-node-activation-flashes
completed: 2026-06-29
duration_min: 12
tasks_completed: 1
tasks_total: 1
files_modified:
  - src/viz/modules/trace.js
  - tests/trace-honest-recall.test.ts
  - tests/viz-haze-activation.test.ts
commits:
  - hash: 67abf5a
    message: "feat(260629-tqq): additive node-flash halo for legible activations at overview zoom"
decisions:
  - "Used THREE.MeshBasicMaterial (not ShaderMaterial) for halos — simpler, sufficient for solid additive bloom; ShaderMaterial would only add value if per-pixel falloff is needed later"
  - "HALO_RADIUS=16 world units: readable against ~53-unit avg node spacing in 460-unit BRAIN_SCALE cloud without excessive overlap"
  - "HALO_LIFE_MS=900ms / HALO_ATTACK=150ms: snappy flash that reads as 'event happened here' without lingering enough to compete with the reconsolidation magenta hero"
  - "Linear scan for coalesce (halos.find) instead of Map: halos array is tiny (<20 elements in any realistic scenario), linear is allocation-free and faster than Map overhead at this scale"
---

# Phase 260629 Quick Task: FIX-52A Legible Node Activation Flashes Summary

**One-liner:** Additive bloom halo (SphereGeometry + MeshBasicMaterial, AdditiveBlending) spawned on every `activate()` call, grow→fade over 900ms, coalesced on re-activation, living in `ctx.pulseGroup` so the UnrealBloomPass catches it.

## What Was Built

`activate()` in `src/viz/modules/trace.js` now spawns a short-lived additive halo mesh at every activated node — seed nodes, hop nodes, oscillation strobes, reconsolidation magenta flash, new_node green blip, and the neutral fallback. The halo follows the node's live world position each tick (the force-graph moves nodes during layout), grows from 0 to a fixed 16-unit radius over 150ms, then eases out over the remaining 750ms via `_smooth01`. The `reconsolidation` kind produces the highest `level` value (up to 1.0) which directly drives opacity peak, making the magenta hero flash the brightest halo.

**Implementation details:**
- Shared `_haloGeo = new THREE.SphereGeometry(1, 8, 6)` — one allocation at `initTrace()`, reused by all halos (matches `_pulseGeo` pattern)
- Per-halo `THREE.MeshBasicMaterial` with `blending: THREE.AdditiveBlending, transparent: true, depthWrite: false` — disposed on expiry
- `halos[]` array parallel to `pulses[]`, ticked in the same `tick(now)` function
- Coalesce: linear scan of `halos` for `h.node === node`; if found, refresh `t0`/`level`/color instead of pushing a new entry — bounds oscillation's 3x strobe and rapid recall replays
- Tick loop iterates backward (same pattern as pulses loop) for safe splice-during-iteration

**No data-path changes:** `activate()`, `applyTrace()`, `_applyIngestion()`, `traceEdgesFromHops()`, `normalizeSeed()`, choreography timing, kind mapping — all byte-identical.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extend THREE mock in two test files with SphereGeometry + MeshBasicMaterial**
- **Found during:** Task 1 (first test run after trace.js change)
- **Issue:** `initTrace()` now calls `new THREE.SphereGeometry(...)` and `activate()` calls `new THREE.MeshBasicMaterial(...)`. Both `viz-haze-activation.test.ts` and `trace-honest-recall.test.ts` mock the `three` module without these two classes — vitest threw "No SphereGeometry export is defined on the three mock" for 4 tests.
- **Fix:** Added minimal stub implementations of `SphereGeometry` (empty constructor) and `MeshBasicMaterial` (constructor + `color: Color`, `opacity`, `dispose()`) to both test mocks.
- **Files modified:** `tests/trace-honest-recall.test.ts`, `tests/viz-haze-activation.test.ts`
- **Commit:** 67abf5a (included in the same atomic commit as the rendering fix per plan scope)

## Verification

- `npx tsc --noEmit`: clean (no output)
- `npm test`: 2,441 passing, 4 skipped, 0 failing

## Self-Check: PASSED

- `src/viz/modules/trace.js` modified: confirmed
- commit 67abf5a exists: confirmed
- No stubs or placeholder values introduced
- No new network endpoints, auth paths, or schema changes
