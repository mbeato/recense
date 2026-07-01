# 55-03 SUMMARY — Cyan 1-hop nodes + honest seed→hop edge pulses (gap closure)

**Status:** ✅ Complete — founder-confirmed 2026-07-01
**Type:** gap_closure (surfaced at the 55-02 checkpoint; scope directed by founder: hops + edge lines)
**Origin:** Phase 52 defined the `recall_hop` cyan vocabulary but never wired it into the recall
render path, and drew no seed→hop lines — so 55-01's honest hops rendered as invisible faint-amber
flashes indistinguishable from seeds ("nodes activate but no visible pathways").

## Root cause (systematic debugging, verified not guessed)

Pipeline `activation_trace → SSE /events → hud.js → trace.js applyTrace`:
- DB + SSE layers proven correct (hops delivered over the wire, correct shape).
- `trace.js` recall-path `applyTrace` activated hop nodes via `activate(node, intensity)` with **no
  color arg** → defaulted to `HOT_COLOR` amber at ~0.3 intensity. `KIND_COLOR.recall_hop` (cyan)
  was defined in constants but referenced 0 times in `trace.js`; `KIND_COLORS` map omitted it.
- No pathway LINES were drawn — the flat, dst-deduped 55-01 payload dropped which seed each hop
  came from, so the frontend had "no honest source-seed→hop edge to reveal."

## Changes

**Engine (honesty-critical):**
- `src/retrieval/engine.ts` `buildAmbientTracePayload`: each hop now carries `src` = the **actual**
  seed whose `relation` out-edge produced it (never a guessed `seeds[0]`). De-dup shifted from
  dst-only to the `(src,dst)` pair, so every distinct real edge is kept (a dst reached from N seeds
  yields N honest lines).
- `src/viz/activation-sink.ts`: `ActivationTraceInput.hops` gains optional `src?: string` (absent on
  curated/cueless/ingestion producers).

**Frontend:**
- `src/viz/modules/trace.js`: `KIND_COLORS` gains `recall_seed`/`recall_hop`; `traceEdgesFromHops`
  passes `src` through; recall-path `applyTrace` activates hop nodes **cyan** and draws a cyan
  wavefront `spawnPulse(srcNode, hopNode, recall_hop)` along each real seed→hop edge. Hops without
  `src` (curated/legacy/replay) light the node only, no line — back-compat preserved.

## Honesty invariants (held & machine-locked)

- Every drawn line is a **real** `relation` out-edge of the **actual** seed it springs from — the
  SC3 guard in `tests/activation-trace-wiring.test.ts` was extended to assert `hop.src` is the real
  seed and `(src→dst)` is a genuine relation edge cross-checked against the store.
- Hop magnitudes stay `null` (WR-02 — no fabricated brightness); seeds carry real cosine/RRF score.

## Verification

- `npx tsc -p . --noEmit` clean.
- `npm test` full suite: **2534 passed / 3 skipped**, no regressions (Phase 52/54 viz guards green).
- Live confirmation: fired real ambient recalls; verified every emitted hop carries a real `src`
  (cross-checked `seeds.includes(h.src)`); founder confirmed cyan pathway pulses in the viz.

## Commits

- `18e3f16` feat(55-03): ambient hops carry real src seed for honest edge lines
- `93b75f2` feat(55-03): render cyan 1-hop nodes + honest seed->hop edge pulses on recall
