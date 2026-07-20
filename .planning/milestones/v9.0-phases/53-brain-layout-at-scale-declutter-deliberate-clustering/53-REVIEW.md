---
phase: 53-brain-layout-at-scale-declutter-deliberate-clustering
reviewed: 2026-06-30T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - src/viz/modules/graph.js
  - src/viz/modules/lod.js
  - src/viz/modules/constants.js
  - tests/viz-layout-guards.test.ts
  - tests/viz-seed-determinism.test.ts
  - tests/viz-lod-density.test.ts
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 53: Code Review Report

**Reviewed:** 2026-06-30
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Reviewed the Phase 53 brain-layout-at-scale changes: the `seedNodePositions` rewrite,
the `halton()`/`sampleInHull()` continuous-sampling helpers, the `buildHazeLayer` rewire,
the wall-clock `SETTLE_BUDGET_MS` settle, and the `OVERVIEW_NODE_CAP` density cap.

The **determinism focus (D-08) is sound**: the `brainVol` placement path contains no
`Math.random`; positions are a pure function of node index, the fixed Halton counter
start, and fixed three-pass placement order. `sampleCounter` and `hazeSampleCounter`
are correctly created fresh inside their respective functions (not module-global), so
they reset per pass and cannot drift across re-renders. The `SAMPLE_GUARD` (8192) cap
cannot infinite-loop and — given any realistic hull occupancy fraction — cannot
mass-fallback (probability of 8192 consecutive rejections is effectively zero). The
world↔local matrix conversion in the Pass-2 member clustering is mathematically correct.
The locked anchors (`BRAIN_SCALE=460`, `revealSettled()` body, `nodeRadius()`) are intact.

Two substantive issues found, both presentation-layer (no Critical): the wall-clock settle
mechanism is effectively dead at runtime due to a `cooldownTicks(0)` race, and the
`OVERVIEW_NODE_CAP` budget counts a different schema set than the one it actually keeps
visible (guard-set ≠ ship-set drift, so the cap can be exceeded). Three Info-level items.

## Warnings

### WR-01: `cooldownTicks(0)` makes `onEngineStop` win the reveal race — `SETTLE_BUDGET_MS` is dead and no settle/containment ever runs

**File:** `src/viz/modules/graph.js:744-770`
**Issue:**
The settle block sets `Graph.cooldownTicks(0)` and registers both
`Graph.onEngineStop(revealSettled)` and `setTimeout(revealSettled, SETTLE_BUDGET_MS)`,
with comments asserting "the sim runs freely until SETTLE_BUDGET_MS elapses (wall-clock
**primary** path)" and that `onEngineStop` is a "fallback."

The bundled force-graph engine (`src/viz/vendor/3d-force-graph.min.js`) stops with:
`++cntTicks > cooldownTicks ? (engineRunning=false, onEngineStop()) : (layout.tick(), onEngineTick())`.
With `cooldownTicks(0)`, the **first** animation frame evaluates `1 > 0` → true → the
engine stops and `onEngineStop()` fires at ~16ms, and crucially `layout.tick()` /
`onEngineTick()` are taken in the *else* branch and never execute. Consequences:

- `revealSettled()` runs at ~frame 1 (via `onEngineStop`), pinning nodes at their raw
  seed positions. The `setTimeout(revealSettled, 250)` is then a no-op (idempotent
  `_settled` guard already set). The "wall-clock primary path" does not control anything.
- `brainContainment` (registered via `Graph.onEngineTick`, line 744) **never runs** — zero
  containment correction.
- The force tuning (`charge.strength(-15)`, link distances, line 707-710) and
  `Graph.d3ReheatSimulation()` (line 711) are dead — no tick ever executes them.

So there is no force settle at all; the layout is purely the seed positions. The static
result was founder-approved (chrome), so this is not a visual defect — but a whole block
of runtime code (force tuning, reheat, per-tick containment) is dead, the `SETTLE_BUDGET_MS`
tunable does nothing, and the comments are actively misleading for the next maintainer.

**Fix:** Decide the intended behavior and make the code match it. If the intent is "no
settle, just render seeds" (which is what currently happens), delete the force tuning /
`d3ReheatSimulation` / `onEngineTick(brainContainment)` / `SETTLE_BUDGET_MS` setTimeout and
say so. If the intent is a real 250ms wall-clock settle, let the engine run and let the
timeout stop it, e.g.:
```js
Graph.cooldownTicks(Infinity);       // run freely; wall-clock budget controls the stop
Graph.cooldownTime(SETTLE_BUDGET_MS); // engine's own wall-clock stop → fires onEngineStop
// keep onEngineStop(revealSettled); drop the redundant setTimeout
```
(`cooldownTime` is the engine's native wall-clock budget and triggers `onEngineStop`, so
`brainContainment` runs for the full budget and the reveal still fires once.)

### WR-02: `OVERVIEW_NODE_CAP` budget counts `schemaMembers` but keeps all `__cat==='schema'` visible — cap can be exceeded (guard-set ≠ ship-set)

**File:** `src/viz/modules/lod.js:122-134`
**Issue:**
The cap computes the schema reservation as
`const schemaCount = [...schemaMembers.keys()].length` and then admits
`hazeBudget = OVERVIEW_NODE_CAP - schemaCount` haze nodes. But `schemaMembers` is populated
only from `'abstracts'` edges (line 62-69), so it counts only schemas that have at least one
member. The set that `nodeVisible` actually keeps unconditionally visible is every node with
`__cat === 'schema'` (line 189: `if (n.__cat !== 'member') return true;`), and a node is
classified `'schema'` purely from `n.type === 'schema'` (line 76) regardless of whether it has
any `'abstracts'` edge. A member-less schema (e.g. all members tombstoned/absent, or a freshly
formed schema) is therefore `__cat==='schema'` and always-visible but **not** counted in
`schemaCount`.

Result: with `K` member-less schemas, the visible overview is
`(realSchemaCount) + hazeBudget = OVERVIEW_NODE_CAP + K` — the cap is silently exceeded by `K`.
The trigger on line 122 (`overviewCount > OVERVIEW_NODE_CAP`) uses the *correct* full schema+haze
count, so the budget subtraction is the lone inconsistency. The existing tests never surface this
because every schema in `buildCtx` is given members.

**Fix:** Count the schema set that is actually kept visible, so the guard set equals the ship set:
```js
let schemaCount = 0;
for (const n of allNodes) if (n.__cat === 'schema') schemaCount++;
const hazeBudget = Math.max(0, OVERVIEW_NODE_CAP - schemaCount);
```

## Info

### IN-01: Pass-3 haze placement in `seedNodePositions` is dead work in the `brainVol` path

**File:** `src/viz/modules/graph.js:359-364` (and overwrite at `473-484`)
**Issue:** Pass 3 places every haze node via `placeInHull` (advancing `sampleCounter` and
writing `n.x/y/z`). In the `brainVol` path, `buildHazeLayer` immediately re-samples and
overwrites those same `n.x/y/z` from its own disjoint Halton stream (`473-484`), so the Pass-3
haze positions are discarded. Pass 3 is only consumed by the **null-brainVol** fallback (where
`buildHazeLayer`'s else-branch reads the seeded `node.x`). This is wasted computation and is
confusing — a reader expects the Pass-3 positions to be the haze positions.
**Fix:** Either skip Pass-3 haze when `brainVol` is present, or add a comment noting the Pass-3
haze write exists only for the null-`brainVol` consumer in `buildHazeLayer`.

### IN-02: `hazeOpacityScale` is computed from the pre-cap `overviewCount`, double-attenuating capped haze

**File:** `src/viz/modules/lod.js:153-158`
**Issue:** `hazeOpacityScale` is derived from the raw `overviewCount` (which still includes the
suppressed long-tail haze). When `overviewCount` exceeds `OVERVIEW_NODE_CAP` and also exceeds
`DENSITY_THIN_START`, the ~`OVERVIEW_NODE_CAP` *visible* haze nodes are both suppressed-down AND
dimmed as if the full pre-cap density were on screen — i.e. dimmed for a crowd that isn't
rendered. The actual visible density is held near the cap (~3000, below `DENSITY_THIN_START`),
so by the feature's own logic it should barely dim. Minor visual inconsistency only.
**Fix:** If exact density-driven dimming is desired, compute `hazeOpacityScale` from the
post-cap visible count (`min(overviewCount, OVERVIEW_NODE_CAP)` or `schemaCount + admittedHaze`).
Otherwise leave as-is and note the intentional coupling.

### IN-03: Null-`brainVol` path is non-deterministic (`Math.random`), unlike the D-08 `brainVol` path

**File:** `src/viz/modules/graph.js:238-248`
**Issue:** The null-`brainVol` fallback scatters via `Math.random`, so reloads without an
occupancy grid produce a different layout each time — in contrast to the deterministic
`brainVol` path (D-08). This is the documented, intentional fallback (the layout-guards test
explicitly excludes this branch), and `buildHazeLayer` already has a deterministic
`_hashIndex` scatter (`491-497`) for its own null path. Flagged only so the asymmetry is a
deliberate, recorded choice rather than an oversight. No fix required unless reload-stability
without a brain mesh is wanted (then mirror the `_hashIndex` scatter used in `buildHazeLayer`).

---

_Reviewed: 2026-06-30_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
