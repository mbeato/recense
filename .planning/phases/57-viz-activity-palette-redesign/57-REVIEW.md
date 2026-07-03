---
phase: 57-viz-activity-palette-redesign
reviewed: 2026-07-03T18:28:52Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - src/viz/modules/constants.js
  - src/viz/modules/effects.js
  - src/viz/modules/graph.js
  - src/viz/modules/trace.js
  - src/viz/server.ts
  - tests/viz-activity-palette-invariants.test.ts
  - tests/viz-ambient-liveliness.test.ts
  - docs/superpowers/evidence/57-stage1-palette/APPROVAL.md
  - docs/superpowers/evidence/57-stage1-palette/TRIGGER-STEPS.md
  - docs/superpowers/evidence/57-stage2-system/APPROVAL.md
findings:
  critical: 2
  warning: 3
  info: 7
  total: 12
status: issues_found
---

# Phase 57: Code Review Report

**Reviewed:** 2026-07-03T18:28:52Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Reviewed the Phase 57 viz activity-palette redesign: the luminance-equalized `KIND_COLOR` identity palette, four per-layer motion profiles, dim floors, bloom recalibration, the D-10 scheduler-scalar source-parse in `server.ts`, and the WR-06 own-trace-scoped fade fix. Per instruction, locked founder-approved values were not flagged as magic numbers; I independently verified the palette math instead — all eight `KIND_COLOR` hues compute Rec.709 Y inside the locked [170, 228] band (oscillation Y=172.16 floor, replay Y=224.53 ceiling), and the D-06 attack/halo orderings are monotonic as claimed. The D-10 parse mechanism is sound (fail-fast, same file the client is served, single-declaration locked by tests). `server.ts` security posture holds: loopback bind + Host-header guard, parameterized SQL throughout, path-traversal guards on all four static roots (raw URL is never percent-decoded, so encoded traversal cannot resolve), read-only DB handle, no-shell spawn args.

Two Critical defects were found, both in the trace pipeline. First, the WR-06 fix (commit 677f8af) removed the global `ctx.traceNodes.clear()` that was — incidentally — the ONLY cleanup path for the five `_applyIngestion` add-sites and for `detail.js focusNode`; those ids now leak into `ctx.traceNodes` forever, permanently un-hiding nodes through the LOD on an all-day tray client. Second, replayed non-recall rows fall through `activate()`'s `kindColor || HOT_COLOR` default and flash HOT amber, violating the project's own locked D-04 guard (amber = live retrieval only) and contradicting the inline comment claiming a "neutral default."

## Critical Issues

### CR-01: WR-06 fix orphaned ingestion-kind and focusNode cleanup — `ctx.traceNodes` now leaks permanently

**File:** `src/viz/modules/trace.js:973, 988, 1014, 1024, 1047` (adds with no matching delete); cross-file consumer `src/viz/modules/lod.js:192`; cross-file adder `src/viz/modules/detail.js:430`
**Issue:** `trace.js` has 11 `ctx.traceNodes.add(...)` call sites but, after the 57-06 own-trace-scoped fade change, only 3 scoped `delete` sites — covering just the 6 adds in the replay, spontaneous, and live-recall branches. The five adds inside `_applyIngestion` (`new_node`, `oscillation`, `reconsolidation` seed + candidate, and the neutral fallback) have never had their own fade timers; before this phase they were cleaned up incidentally by the global `ctx.traceNodes.clear()` in every recall/replay/spontaneous fade (verified in the 677f8af diff). That global clear is now gone and **nothing in the codebase deletes these ids** (grep confirms zero other `traceNodes.delete`/`.clear` sites in detail.js/lod.js/hud.js/app.js). Consequence: every sleep-pass consolidation event (confirm/extend/merge → neutral, reconsolidation, oscillation) permanently adds its seed to `ctx.traceNodes`, and `lod.js:192` (`traceNodes.has(n.id)` in the visibility predicate) keeps those nodes and their lit links revealed forever. On the founder's all-day tray install this accumulates monotonically until page reload, gradually defeating the overview LOD and the founder-calibrated screen-fullness band. The same regression breaks `detail.js focusNode`'s documented contract ("the next trace's fade-back may re-hide it" — it no longer will).
**Fix:** Give each `_applyIngestion` branch its own scoped fade, mirroring the three fixed branches:
```js
// at the end of each _applyIngestion branch that calls ctx.traceNodes.add(...)
const addedIds = [seedId];                       // + candidateHop.node_id in the reconsolidation branch
const fadeMs = DECAY_ATTACK_MS + DECAY_HOLD_MS + 500;   // +700 for the oscillation strobe window
setTimeout(() => {
  addedIds.forEach(id => ctx.traceNodes.delete(id));
  if (ctx.revealTrace) ctx.revealTrace(revealedNodes, []);
}, fadeMs);
```
Then decide `focusNode`'s reveal lifetime explicitly (scoped timer in detail.js, or update its comment to "permanent until reload") rather than leaving it silently permanent.

### CR-02: Replayed non-recall rows render HOT amber — violates the locked D-04 amber-exclusivity guard

**File:** `src/viz/modules/trace.js:731-736` (color selection), `src/viz/modules/trace.js:339, 348, 369, 440, 478` (`kindColor || HOT_COLOR` fallbacks); feeding path `src/viz/server.ts:488-493`
**Issue:** The server's replay ring buffer accepts ANY row with non-empty seeds — including ingestion-kind rows (`kind='oscillation'`, `'new_node'`, `'neutral'`, `'reconsolidation'`) written by the sleep pass (server.ts:488 checks only `Array.isArray(seeds) && seeds.length > 0`). When such a row is re-emitted with `replay: true`, the client replay branch computes `isRecallReplay = false` and passes `seedColor = undefined` / `hopColor = undefined` into `activate()`. But `activate()`'s fallback is `kindColor || HOT_COLOR` — for the node tint (line 369), the halo `uColor` (lines 339/348), and the haze lerp (line 440). Result: an idle replay of a consolidation event flashes **HOT amber** (at REPLAY_DIM 0.7 with a 0.75-scale halo — well above the visibility floor), directly violating the D-04 invariant locked in `constants.js:126-127` ("amber is reserved for retrieval/hover ONLY; neutral MUST use a different hue") and falsely signaling a live retrieval during idle. The inline comment at line 707-708 claims non-recall replay rows "keep the neutral default activation" — the actual default is amber, not neutral, so the code contradicts its own stated intent. Note the D-02 luminance-band test cannot catch this: it locks the hex values, not which color a code path selects.
**Fix:** Make the stated intent real:
```js
const seedColor = isRecallReplay ? KIND_COLORS.recall_seed : KIND_COLORS.neutral;
const hopColor  = isRecallReplay ? KIND_COLORS.recall_hop  : KIND_COLORS.neutral;
```
Alternatively (or additionally, defense-in-depth) filter non-recall rows out of the server replay buffer at `server.ts:488` (`if ((row.kind ?? null) === null || row.kind === 'recall')`) so replay only ever echoes recalls — which is also what the TRIGGER-STEPS replay description promises the founder ("echoes the recent real rows" of recall queries).

## Warnings

### WR-01: `activate()` halo path lacks the envelope's lower-level guard — a subordinate activation demotes an in-flight higher-salience halo

**File:** `src/viz/modules/trace.js:331-360` vs. the guard at `trace.js:365`
**Issue:** The node-envelope path correctly refuses to restart when a lower-level activation arrives (`if ((node.__act || 0) < level)`), so a live amber peak survives a subsequent subordinate re-activation. The halo coalesce path has no such guard: it unconditionally resets `t0`, `level`, `haloScale`, and copies the new `kindColor` into `uColor`. A lower-salience activation arriving within HALO_LIFE_MS (900ms) of a higher one therefore shrinks and recolors the live halo (e.g. amber 1.0-scale → lavender 0.55-scale) while the node envelope still honors the live peak — an internally inconsistent frame. Today this is masked only by server-side timing (idle layers require a 5s live gap), but `applyTrace`/`activate` are also driven by the local test-trace button and any future producer; the asymmetry between the two guards is a latent logic bug, not a designed behavior (the oscillation strobe, which relies on re-triggering at decreasing levels, is same-color/same-scale and would be unaffected by a salience-aware guard).
**Fix:** In the coalesce branch, only restart the halo when the incoming activation is not weaker than the surviving one, mirroring the envelope guard:
```js
if (halos[hi].node === node) {
  if (level >= halos[hi].level || (now - halos[hi].t0) >= HALO_LIFE_MS) {
    halos[hi].t0 = performance.now();
    halos[hi].level = level;
    halos[hi].haloScale = haloScale;
    /* copy color */
  }
  found = true; break;
}
```

### WR-02: Own-trace-scoped fades are not refcounted — overlapping traces sharing a node id still clobber each other

**File:** `src/viz/modules/trace.js:754-759, 838-843, 942-947`
**Issue:** The WR-06 fix scopes deletion by id, but `ctx.traceNodes` is a Set, not a refcount. When two traces add the SAME id — e.g. two live recalls within ~1.18s on overlapping seeds (a repeated query is the common case), or a live recall overlapping a pending spontaneous fade on a shared hop node — the earlier trace's fade timeout deletes the id and calls `revealTrace`, hiding a node the later trace legitimately re-added and whose envelope is still mid-hold/fade. The WR-06 regression test only covers the disjoint-id case (`spont-seed` vs `live-seed`), so this collision shape is untested. Lower severity than CR-01 because the effect is transient (node vanishes early instead of leaking forever), but it is the same race class WR-06 set out to close.
**Fix:** Refcount instead of delete-by-id — e.g. keep `ctx.traceNodes` as a `Map<id, count>` behind small `addTraceNode/releaseTraceNode` helpers (increment on add, decrement on fade, hide only at zero), or as a minimal patch skip the delete when the node is still in the `active` set:
```js
addedIds.forEach(id => {
  const n = ctx.idMap.get(id);
  if (n && active.has(n)) return;   // a later trace re-lit it — let its own fade release it
  ctx.traceNodes.delete(id);
});
```
(The minimal patch requires the later trace's fade to still be pending, which holds since fadeMs < envelope life for every layer.) Add a regression test for the shared-id case.

### WR-03: No behavioral test covers the D-06 motion-profile plumbing — the phase's core mechanism is only locked at the constants level

**File:** `tests/viz-activity-palette-invariants.test.ts` (whole file), `tests/viz-ambient-liveliness.test.ts` (Layer 2 suite)
**Issue:** The invariants file locks the constant ORDERINGS (attack ms, halo scale, dim floors) via source-parse, and viz-ambient-liveliness locks `REPLAY_DIM` intensity behaviorally — but no test asserts that the profiles are actually WIRED: nothing checks that the replay branch passes `REPLAY_PROFILE` into `activate()` (i.e. `node.__actAttackMs === 200` after a replay row), that the spontaneous branch passes `SPONT_PROFILE`, that `evalEnvelope` honors a per-node `__actAttackMs` over the global `DECAY_ATTACK_MS`, that halos scale by `haloScale`, or that `spawnPulse` receives the per-layer thickness. Deleting the 4th argument from every `activate(...)` call in the replay/spontaneous branches — silently reverting the entire D-06 salience system to live-profile behavior — would pass the full test suite. Given the phase's stated goal is moving salience ordering onto motion/scale, this is the highest-value untested surface.
**Fix:** Add behavioral assertions to the invariants file (the `makeCtx` harness in viz-ambient-liveliness already supports it), e.g.:
```ts
ctx.applyTrace({ seeds: [{ node_id: 'b', score: 0.9 }], hops: [], replay: true });
expect(nodeB.__actAttackMs).toBe(REPLAY_ATTACK_MS);   // profile wired, not just imported
ctx.applyTrace({ seeds: [{ node_id: 'c', score: null }], hops: [], kind: 'spontaneous' });
expect(nodeC.__actAttackMs).toBe(SPONT_ATTACK_MS);
```

## Info

### IN-01: effects.js bloom comment misstates which hues sit below the threshold

**File:** `src/viz/modules/effects.js:150-152`
**Issue:** The comment claims the 0.72 gate "keeps every LOCKED identity hue (floor oscillation Y≈0.675) safely below the threshold" — but four of the eight identity hues sit ABOVE 0.72 on the 0-1 scale: recall_seed 0.758, recall_hop 0.766, spontaneous 0.756, replay 0.880. The trailing clause acknowledges HOT/replay/spontaneous flaring by design but omits recall_hop, which also blooms. The behavior was founder-approved live, so this is documentation drift only — but this comment is the calibration record for the next bloom retune and should not misdescribe the gate.
**Fix:** Reword to "keeps the four muted event hues (new_node/reconsolidation/oscillation/neutral, Y≈0.675-0.700) below the gate while recall_seed/recall_hop/spontaneous/replay (Y≈0.756-0.880) flare above it."

### IN-02: Realized spontaneous peak (0.6) can exceed realized replay peak — SC3 lock holds on constants, not on rendered intensity

**File:** `src/viz/modules/trace.js:787, 695-698`
**Issue:** Spontaneous seeds use a full 1.0 base (`1.0 × SPONT_DIM = 0.6`) while replay seeds use a score-derived base (`score × REPLAY_DIM`); any replayed recall with seed score < ~0.857 renders dimmer than a spontaneous seed, inverting the documented "spontaneous is the dimmest activity layer" ordering at the pixel level. Safe today only because the two layers never co-render (server gates spontaneous behind an empty replay buffer), and constants.js documents that assumption — but the D-05/WR-02 test locks multipliers, so this inversion is invisible to the suite. Worth a comment at the spontaneous `intensity = 1.0` site noting the ordering is layer-temporal, not per-peak.

### IN-03: Haze proximity-fallback click can select nodes behind the camera or focus-hidden (zero-scaled) instances

**File:** `src/viz/modules/graph.js:975-997`
**Issue:** The 10px screen-space fallback projects every haze node with `.project(camera)` but never checks NDC z (points behind the camera project to mirrored coordinates that can land inside the threshold) nor whether the instance was zero-scaled by `_hideHazeInstance` (a focus-hidden node remains in `hazeInstanceMap` and can be "clicked" while invisible). Pre-existing (not Phase-57 code), low frequency.
**Fix:** Skip candidates with `_proxPt.z > 1 || _proxPt.z < -1` and skip ids in `ctx.focusedHaze`.

### IN-04: `recenter()` calls `ctx.markActive()` twice

**File:** `src/viz/modules/graph.js:807, 814`
**Issue:** The same guard-wrapped `ctx.markActive()` call appears before and after `Graph.cameraPosition(...)`; the second is redundant (both fire synchronously in the same frame). Harmless; remove one or comment why both exist.

### IN-05: viz-ambient-liveliness.test.ts replaces the global `setTimeout` with a no-op at module scope

**File:** `tests/viz-ambient-liveliness.test.ts:96, 653-654, 678`
**Issue:** The file overwrites `globalThis.setTimeout` with a no-op for its entire lifetime; the WR-06 test's `finally` restores `realSetTimeout` — which is itself the no-op, not the platform timer. Safe under vitest's default per-file isolation, but fragile if isolation is ever disabled or if vitest internals in this worker need real timers. Prefer `vi.spyOn(globalThis, 'setTimeout')`/`vi.useFakeTimers()` scoped per-test.

### IN-06: POST /settings reads an unbounded request body

**File:** `src/viz/server.ts:1159-1163`
**Issue:** Body chunks are concatenated with no size cap; a local client can stream an arbitrarily large body into memory before the JSON.parse rejection. Mitigated by loopback-only bind + Host guard (only local processes can reach it), so informational. A `if (total > 64 * 1024) { req.destroy(); ... }` guard in the `data` handler would close it.

### IN-07: Duplicate hop entries in a row are not deduped — double activation and double edge pulses

**File:** `src/viz/modules/trace.js:192-201` (`traceEdgesFromHops`), consumers at 707, 792, 886
**Issue:** `traceEdgesFromHops` filters by idMap membership and caps at TRACE_MAX_EDGES but does not dedupe `node_id` (seed dedup uses a `visited` set; hops have none). A payload repeating a hop id spawns stacked additive wavefronts on the same edge (visibly brighter than a single honest pulse) and burns cap budget. Honest engine payloads are presumably deduped upstream, but the function's contract is "defensive cap" — dedup belongs with it: track a `seen` Set alongside the length cap.

---

_Reviewed: 2026-07-03T18:28:52Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
