# 55-02 SUMMARY — Founder visual verification of ambient 1-hop pathways (SC1)

**Status:** ✅ Complete — SC1 approved by founder ("looks good"), 2026-07-01
**Type:** checkpoint:human-verify (blocking gate)

## What was verified

With Plan 55-01 shipped, ordinary per-prompt (ambient) `retrieveRanked` recalls now emit each
retrieved seed's real top-6 live `relation` 1-hop out-edges as `hops` (score:null, rank-only), with
seeds carrying their real cosine/RRF magnitude. The founder opened `recense viz` and observed real
recalls firing against the live brain (`~/.config/recense/recense.db`).

## Verification session

- `viz_trace_enabled` was `0` on the live DB (tracing off) — set to `1` so the ambient sink writes
  the trace rows the viz SSE loop reads. (Left ON; the founder's own prompts now light the viz too.)
- Fired real ambient recalls via the exact `ambientRecall()` path (`src/adapter/ambient-recall.ts`
  → `RetrievalEngine.retrieveRanked`) against the live brain — 6 varied memory-shaped queries,
  spaced ~1.8s so each animates distinctly. Every recall lit 3–13 real hop pulses (vs `hops:[]`
  before 55-01).

## Gap found and closed at the checkpoint → Plan 55-03

Initial visual check surfaced a **Phase 52 frontend gap** (NOT a 55-01 regression): seed nodes
activated but hop pathways were imperceptible. Root-caused via systematic debugging:

- Data layer proven correct end-to-end — hops present in `activation_trace` AND delivered over the
  SSE `/events` wire (captured raw), with the correct `{node_id, score:null, hop:1}` shape.
- The break was in `trace.js` recall-path `applyTrace`: hop nodes were activated with **no color
  arg**, defaulting to amber (`HOT_COLOR`) at 0.3 intensity — visually indistinguishable from (and
  dimmer than) the amber seeds. The intended `KIND_COLOR.recall_hop` **cyan** was defined but never
  wired into the recall path, and no seed→hop edge lines were drawn.

Founder directed the fix scope: **cyan hop nodes + animated edge-line pulses**. Implemented as
Plan 55-03 (see `55-03-SUMMARY.md`). After a browser hard-reload, the founder confirmed SC1:
amber seeds with cyan pulses racing along the real seed→hop edges to cyan neighbor nodes.

## Density decision (D-02)

`AMBIENT_HOP_TOPN = 6` **accepted** as-is — no tuning requested. Density reads alive-and-intentional;
sparse object-heavy seeds (e.g. 3 hops) are the expected/honest asymmetric out-edge case, not a bug.

## Success criteria

- ✅ SC1 confirmed: per-prompt (ambient) recall lights real 1-hop pathways in the viz.
- ✅ AMBIENT_HOP_TOPN density accepted at 6.
- ✅ Honesty preserved & visually confirmed: pathways trace real edges; no fabricated pulses.
