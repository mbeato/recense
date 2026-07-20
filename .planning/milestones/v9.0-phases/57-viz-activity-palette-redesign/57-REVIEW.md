---
phase: 57-viz-activity-palette-redesign
reviewed: 2026-07-03T19:27:08Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - docs/superpowers/evidence/57-stage1-palette/APPROVAL.md
  - docs/superpowers/evidence/57-stage1-palette/TRIGGER-STEPS.md
  - docs/superpowers/evidence/57-stage2-system/APPROVAL.md
  - src/viz/modules/constants.js
  - src/viz/modules/detail.js
  - src/viz/modules/effects.js
  - src/viz/modules/graph.js
  - src/viz/modules/trace.js
  - src/viz/server.ts
  - tests/viz-activity-palette-invariants.test.ts
  - tests/viz-ambient-liveliness.test.ts
findings:
  critical: 0
  warning: 5
  info: 7
  total: 12
status: issues_found
---

# Phase 57: Code Review Report (re-review after 57-08 gap closure)

**Reviewed:** 2026-07-03T19:27:08Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

Re-review of the Phase 57 viz activity-palette redesign after gap-closure plan 57-08 (commits a72feec, 194de76) addressed the two Critical findings from the prior review.

**Both prior Criticals are verified fixed:**

- **CR-01 (traceNodes leak) — CLOSED.** All five `_applyIngestion` add-sites (`new_node` trace.js:983-989, `oscillation` :1009-1015, `reconsolidation` seed+candidate :1044-1056, neutral fallback :1089-1095) now schedule own-trace-scoped fades mirroring the recall/replay/spontaneous pattern. Audit: 11 `ctx.traceNodes.add(` sites in trace.js are all covered by 7 scoped `delete` sites; the reconsolidation fade correctly includes `candidateHop.node_id` only when the candidate is realized. The one remaining un-faded add (`detail.js:436` focusNode) is now an explicitly documented deliberate sticky-until-reload reveal (detail.js:424-430) — the prior review's "decide explicitly" disposition was taken. A behavioral regression test locks the new_node path (viz-ambient-liveliness.test.ts:728-756).
- **CR-02 (replay amber flash) — CLOSED, both layers.** Client: non-recall replay rows now resolve `seedColor`/`hopColor` to `KIND_COLORS.neutral` (trace.js:734-735), so `activate()`'s `kindColor || HOT_COLOR` fallback is never reached from the replay branch. Server: defense-in-depth admission guard `(row.kind == null || row.kind === 'recall')` (server.ts:492) keeps ingestion-kind rows out of the replay ring entirely, matching the TRIGGER-STEPS promise that replay echoes recalls only. A regression test locks the client path against the exact revert shape (viz-ambient-liveliness.test.ts:698-726).

Both in-scope test files pass (79/79, run during this review). The D-10 source-parse mechanism, palette luminance math, monotonic motion-profile orderings, and server security posture (loopback bind + Host guard, parameterized SQL, traversal guards, read-only DB) were re-checked and hold.

**No new Critical defects found.** Two new warnings surfaced in this pass (a silent-mis-parse shape in `parseSchedulerScalars`, and a frozen-tint accumulation defect in the twinkle rotation amplified by this phase's `TWINKLE_AMP` raise), plus the three prior warnings which remain present as expected (WR-01/WR-02 were explicitly out of scope for 57-08; WR-03 remains unaddressed). Prior info items all persist and are carried over.

## Warnings

### WR-01 (carryover, unchanged): `activate()` halo coalesce path lacks the envelope's lower-level guard — a subordinate activation demotes an in-flight higher-salience halo

**File:** `src/viz/modules/trace.js:333-344` vs. the guard at `trace.js:365`
**Issue:** Unchanged from the prior review (explicitly out of scope for 57-08; re-reported per instruction, not a regression). The node-envelope path refuses to restart on a lower incoming level (`if ((node.__act || 0) < level)`), but the halo coalesce branch unconditionally resets `t0`/`level`/`haloScale` and recolors `uColor`. A lower-salience activation arriving within HALO_LIFE_MS (900ms) of a live one shrinks and recolors the live halo (e.g. amber 1.0-scale → lavender 0.55-scale) while the node envelope still honors the live peak — an internally inconsistent frame. Masked today by server-side idle gating (5s live gap before replay/spontaneous fire), but `activate` is also driven by the local test-trace button, detail.js ripple, and any future producer.
**Fix:** Guard the coalesce restart on salience, with care not to break the oscillation strobe (which deliberately re-triggers the SAME node at decreasing levels — an exemption for same-color re-triggers, or an elapsed-based restart, keeps it working):

```js
if (halos[hi].node === node) {
  const sameColor = halos[hi].mat.uniforms?.uColor &&
    halos[hi].mat.uniforms.uColor.value.equals?.(kindColor || HOT_COLOR);
  if (level >= halos[hi].level || sameColor || (performance.now() - halos[hi].t0) >= HALO_LIFE_MS) {
    halos[hi].t0 = performance.now();
    halos[hi].level = level;
    halos[hi].haloScale = haloScale;
    /* copy color */
  }
  found = true; break;
}
```

### WR-02 (carryover, surface grew): own-trace-scoped fades are not refcounted — overlapping traces sharing a node id still clobber each other

**File:** `src/viz/modules/trace.js:757-762, 841-846, 945-950, 984-989, 1009-1015, 1048-1056, 1089-1095`
**Issue:** Unchanged in kind from the prior review (explicitly out of scope for 57-08; re-reported per instruction), but the CR-01 fix grew the collision surface from 3 to 7 delete-by-id sites. `ctx.traceNodes` is a Set, not a refcount: when two traces add the SAME id — two live recalls within ~1.18s on overlapping seeds, a live recall overlapping a pending spontaneous fade on a shared hop, or (new since the fix) a sleep-pass consolidation event (`neutral`/`new_node` fade, ~2.68s window) landing on a node a concurrent recall just lit — the earlier trace's fade timeout deletes the id and calls `revealTrace`, re-hiding a node whose later-trace envelope is still mid-hold/fade. The WR-06 and CR-01 regression tests both cover only disjoint-id cases. Transient (node vanishes early rather than leaking), but it is the same race class WR-06/CR-01 set out to close.
**Fix:** Refcount — `Map<id, count>` behind `addTraceNode/releaseTraceNode` helpers (hide only at zero), or the minimal patch of skipping the delete while the node is still in the `active` set:

```js
addedIds.forEach(id => {
  const n = ctx.idMap.get(id);
  if (n && active.has(n)) return; // a later trace re-lit it — its own fade releases it
  ctx.traceNodes.delete(id);
});
```

Add a shared-id regression test.

### WR-03 (carryover, unchanged): no behavioral test covers the D-06 motion-profile plumbing — the phase's core mechanism is only locked at the constants level

**File:** `tests/viz-activity-palette-invariants.test.ts` (whole file), `tests/viz-ambient-liveliness.test.ts` (Layer 2 suite)
**Issue:** Still true after 57-08 (the new tests lock CR-01/CR-02 code paths, not profile wiring). The invariants file locks constant ORDERINGS via source-parse and viz-ambient-liveliness locks `REPLAY_DIM` intensity, but nothing asserts the profiles are WIRED: no test checks `node.__actAttackMs === REPLAY_ATTACK_MS` after a replay row, `SPONT_ATTACK_MS` after a spontaneous row, that `evalEnvelope` honors per-node `__actAttackMs` over the global, that halos scale by `haloScale`, or that `spawnPulse` receives per-layer thickness. Deleting the 4th argument from every `activate(...)` call in the replay/spontaneous branches — silently reverting the whole D-06 salience system to live-profile behavior — would pass all 79 tests.
**Fix:** Add behavioral assertions using the existing `makeCtx` harness:

```ts
ctx.applyTrace({ seeds: [{ node_id: 'b', score: 0.9 }], hops: [], replay: true });
expect(nodeB.__actAttackMs).toBe(REPLAY_ATTACK_MS);
ctx.applyTrace({ seeds: [{ node_id: 'c', score: null }], hops: [], kind: 'spontaneous' });
expect(nodeC.__actAttackMs).toBe(SPONT_ATTACK_MS);
```

### WR-04 (new): `parseSchedulerScalars` regex silently mis-parses expression-valued or comment-shadowed constants — the "fail-fast" claim only covers absent names

**File:** `src/viz/server.ts:87-98`; mirrored regex in `tests/viz-activity-palette-invariants.test.ts:87, 206`
**Issue:** The parse regex `export\s+const\s+NAME\s*=\s*([\d.]+)` captures the FIRST numeric token after `=`, not the full initializer. Two silent-failure shapes:
1. **Expression values:** if a scalar is ever refactored to a derived expression — a live temptation in this codebase, e.g. `TWINKLE_ATTACK_MS` is documented as "a quarter of TWINKLE_PERIOD_MS" (constants.js:540-541) — `export const REPLAY_IDLE_GAP_MS = 4 * 1000;` parses as **4**, not 4000, and the replay scheduler would fire on a 4ms idle gap. No throw, no drift detection.
2. **Comment shadowing:** the parse does not strip comments; a commented-out `// export const REPLAY_CADENCE_MS = 9999;` line appearing BEFORE the real declaration would win `String.match`'s first-match semantics.
Neither shape is caught by the invariants suite: Test C (test:95-103) deliberately calls the same `parseSchedulerScalars` and compares against the SAME regex applied to the same file — the two paths agree by construction, so a shared parse bug is invisible. Test B's exactly-once check counts only real `export const` declarations, so it also misses both shapes. Not currently incorrect (all seven values are plain integer literals today), but the mechanism is the phase's new cross-boundary contract and its stated guarantee ("fail-fast: throws ... rather than silently defaulting — T-57-01", server.ts:81-82) is narrower than the comment claims.
**Fix:** Anchor the capture to a full simple-literal statement so anything else fails to match and throws:

```ts
const match = src.match(new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*([\\d.]+)\\s*;`, 'm'));
```

The `^...m` anchor kills the comment-shadow shape (comment lines start with `//` or `*`); the trailing `;` kills the expression shape (`= 4 * 1000;` no longer matches → throw at startVizServer init). Apply the same anchor to the test's `parseFromConstantsJs`/`parseConst` helpers.

### WR-05 (new): twinkle rotation never restores the outgoing subset to `__hazeBase` — the whole haze cloud accumulates frozen steel-blue tint, doubled by this phase's `TWINKLE_AMP` raise

**File:** `src/viz/modules/trace.js:610-621` (rotation rebuild), `:634-643` (per-node write); amplitude raised at `src/viz/modules/constants.js:556-558`
**Issue:** When the twinkle subset rotates (every TWINKLE_COUNT=220 frames, ~9s at idle 24fps), `twinkleSubset` is simply replaced; the outgoing 220 nodes are left at whatever `lerp(__hazeBase, TWINKLE_TINT, breath)` color the last frame happened to write — a random frozen value anywhere in [0, TWINKLE_AMP]. Nothing restores them: the main tick restores `__hazeBase` only on activation expiry, and `lod.js:268` restores only trace-revealed nodes. Since the rotation window walks the entire haze pool contiguously and wraps, the steady state is that essentially every haze node outside the current subset carries a stale random tint (mean lerp ≈ TWINKLE_AMP/2 ≈ 0.21 toward steel-blue 0xaec2d6) until it is re-picked minutes later — at which point it is re-frozen at a new random value. This contradicts the documented design ("breathes a ROTATING SUBSET ... setColorAt only" — the non-subset cloud is supposed to sit at its calibrated base palette) and permanently drifts the founder-calibrated haze colors toward steel-blue. The defect predates this phase (Phase 54), but this phase touched twinkleTick (attack-ramp addition, trace.js:630-632) and raised `TWINKLE_AMP` 0.18 → 0.42 (constants.js:557), more than doubling the magnitude of the frozen tint — which is why it is reported as a warning here rather than left as legacy.
**Fix:** Restore the outgoing subset before rebuilding (skip active nodes — the main tick owns their restore):

```js
if (twinkleSubset.length === 0 || (twinkleFrame > 0 && twinkleFrame % TWINKLE_COUNT === 0)) {
  for (const node of twinkleSubset) {           // restore OUTGOING subset to base
    if (active.has(node) || node.__hazeIdx == null || !node.__hazeBase) continue;
    ctx.hazeMesh.setColorAt(node.__hazeIdx, node.__hazeBase);
  }
  // ... existing rebuild ...
}
```

(The existing end-of-tick `instanceColor.needsUpdate` flush covers the writes.)

## Info

### IN-01 (carryover): effects.js bloom comment misstates which hues sit below the threshold

**File:** `src/viz/modules/effects.js:150-153`
**Issue:** Still present. The comment claims the 0.72 gate "keeps every LOCKED identity hue (floor oscillation Y≈0.675) safely below the threshold" — but four of the eight identity hues sit ABOVE 0.72 on the 0-1 scale (recall_seed 0.758, recall_hop 0.766, spontaneous 0.756, replay 0.880; verified this pass), and the trailing clause omits recall_hop from the flare set. Documentation drift only (behavior founder-approved live), but this comment is the calibration record for the next bloom retune.
**Fix:** Reword to "keeps the four muted event hues (new_node/reconsolidation/oscillation/neutral, Y≈0.678-0.700) below the gate while recall_seed/recall_hop/spontaneous/replay (Y≈0.756-0.880) flare above it."

### IN-02 (carryover): realized spontaneous peak (0.6) can exceed realized replay peak — SC3 lock holds on constants, not rendered intensity

**File:** `src/viz/modules/trace.js:783-790, 695-698`
**Issue:** Still present. Spontaneous seeds use a full 1.0 base (`1.0 × SPONT_DIM = 0.6`) while replay seeds use a score-derived base (`score × REPLAY_DIM`); any replayed recall with seed score < ~0.857 renders dimmer than a spontaneous seed. Safe today only because the layers never co-render (server gates spontaneous behind an empty replay buffer). Worth a comment at the `intensity = 1.0` site noting the ordering is layer-temporal, not per-peak.

### IN-03 (carryover, pre-existing): haze proximity-fallback click can select nodes behind the camera or focus-hidden instances

**File:** `src/viz/modules/graph.js:983-997`
**Issue:** Still present (pre-Phase-57 code). The 10px screen-space fallback projects every haze node but never checks NDC z (points behind the camera mirror into the threshold) nor whether the instance is zero-scaled/focus-hidden (still in `hazeInstanceMap`).
**Fix:** Skip candidates with `_proxPt.z > 1 || _proxPt.z < -1` and ids in `ctx.focusedHaze`.

### IN-04 (carryover, pre-existing): `recenter()` calls `ctx.markActive()` twice

**File:** `src/viz/modules/graph.js:807, 814`
**Issue:** Still present. The same guard-wrapped call fires before and after `Graph.cameraPosition(...)` synchronously in the same frame; the second is redundant. Remove one or comment why both exist.

### IN-05 (carryover, pattern repeated): viz-ambient-liveliness.test.ts replaces global `setTimeout` with a no-op at module scope; save/restore restores the no-op

**File:** `tests/viz-ambient-liveliness.test.ts:96, 656-657/681, 733-734/753-755`
**Issue:** Still present, and the new CR-01 test (57-08) repeats the same pattern: `realSetTimeout` captured in both the WR-06 and CR-01 tests is the module-scope no-op from line 96, not the platform timer, so the `finally` blocks restore a no-op. Safe under vitest per-file isolation; fragile if isolation is ever disabled.
**Fix:** Prefer `vi.useFakeTimers()`/`vi.spyOn(globalThis, 'setTimeout')` scoped per-test.

### IN-06 (carryover): POST /settings reads an unbounded request body

**File:** `src/viz/server.ts:1163-1167`
**Issue:** Still present. Body chunks concatenate with no size cap before `JSON.parse`. Mitigated to informational by loopback-only bind + Host-header guard.
**Fix:** Cap in the `data` handler, e.g. destroy the request past 64 KiB.

### IN-07 (carryover): duplicate hop entries in a row are not deduped — double activation and stacked edge pulses

**File:** `src/viz/modules/trace.js:192-201` (`traceEdgesFromHops`), consumers at 710, 795, 889
**Issue:** Still present. Seeds dedupe via a `visited` set; hops have none. A payload repeating a hop id spawns stacked additive wavefronts on the same edge (visibly brighter than one honest pulse) and burns TRACE_MAX_EDGES budget. The function's contract is "defensive cap" — dedup belongs with it.
**Fix:** Track a `seen` Set alongside the length cap.

---

_Reviewed: 2026-07-03T19:27:08Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
