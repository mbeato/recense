# Brain Viz — Honest Traces

**Date:** 2026-06-29
**Status:** Approved design, pre-implementation

## Problem

The `recense viz` brain firing reads as chaos, not meaning. Two distinct failures:

1. **Volume / aesthetic.** Nodes and schemas now have many edges, so the visualization's
   multi-hop expansion fans out into a wall of pulses.
2. **Semantic dishonesty (the deeper one).** The fired hops are *not* what retrieval did.
   Recall seeds a set of nodes and the engine spreads activation exactly **one** real hop.
   The viz throws that away and re-derives an unrelated 4-hop BFS over the rendered graph
   topology. The animation is theater, decoupled from the engine.

Additionally, **ingestion fires nothing** — the most valuable moments in recense
(a new fact arriving; prediction-error-gated reconsolidation rewriting a belief in place)
are invisible in the brain.

## Root cause (verified)

The server already computes and ships the truth; the client discards it.

- `src/retrieval/engine.ts:298–320` — main retrieval path emits an `activation_trace` row at
  line 316. `seeds` = top-`SEED_K` (10) nodes by base score (line 269). `hops` = the **real**
  1-hop spreading-activation neighbors (lines 271–288, 303–315), each tagged `hop: 1` with a
  real `score`.
- `src/recall/index.ts:514–527` — schema-resolution recall path emits at line 523;
  `hops` are real neighborhood members tagged `hop: 1`, `score: null` (WR-02: refuses to
  fabricate a magnitude).
- `src/viz/modules/hud.js:152` — SSE listener calls `ctx.applyTrace(row.seeds || [])`,
  **discarding `row.hops` entirely**.
- `src/viz/modules/trace.js:242–338` — `applyTrace(seedIds)` runs its own BFS over the
  client adjacency `ctx.adj` (lines 260–289) up to `MAX_HOPS=4` (`constants.js:186`),
  `TRACE_FANOUT=5` (line 192), `TRACE_MAX_EDGES=80` (line 195). This is the clutter, and it is
  pure topology — unrelated to retrieval.

Ingestion events exist but go to a different sink interface the viz never reads:
`src/adapter/remember-cli.ts` emits `unrelated` / `contradict_reconcile` /
`contradict_oscillation` (with `magnitude`, `node_id`, `candidate_id`) to the
ConsolidationSink (`event_type` field) at lines 235, 260, 303, 337, 364 — not to
`activation_trace`.

## Design

### Principle

Every pulse must be true to the engine. A trace fires only along an edge or node the engine
actually touched. Visualization caps (`MAX_HOPS`, `TRACE_FANOUT`, `TRACE_MAX_EDGES`) become
*safety limits*, never *content generators*.

### 1. Drive recall animation from the real payload

- `hud.js:152` passes the **full row** (`seeds` + `hops`) into the animation, not just seeds.
- `trace.js` `applyTrace` is rewritten to animate the server-supplied `hops` directly. The
  client-side BFS over `ctx.adj` is **deleted**.
- Seed intensity ∝ real retrieval score; weak seeds are naturally dim. (This alone resolves
  most of the clutter — the strong top handful dominate, the tail self-attenuates. We light
  whatever the emitted `seeds` array contains and let score do the gating.)
- One wave to the real scored 1-hop neighbors; edge brightness ∝ `score × edge.w`.
- No synthetic second hop — the engine does not traverse one. When `score` is `null`
  (schema-recall path, WR-02), use a fixed mid intensity rather than inventing a magnitude.
- `MAX_HOPS` / `TRACE_FANOUT` / `TRACE_MAX_EDGES` are retained only as defensive caps in case a
  payload is unexpectedly large.

### 2. Decay tail (honest core + hold)

Lit nodes "hold" the recalled set briefly, then release — conveying persistence/strength
without inventing topology:

- bright attack ~140ms → hold ~600ms → exponential fade over ~2.5s with a low floor.
- All four values are tunable constants in `src/viz/modules/constants.js`.
- Replaces the current flat `node.__act -= dt * 0.6` (~1.6s linear) decay in `trace.js:167`.

### 3. Bridge ingestion onto the same stream

- **Schema:** add a nullable `kind` column to the `activation_trace` table
  (`src/viz/activation-sink.ts`). `kind` is **row-level**. Recall rows are `kind = 'recall'`
  (or `NULL`, treated as recall for back-compat) — a single recall row carries both `seeds`
  and `hops`, and the client renders seeds amber / hops cyan *within* that row. Ingestion rows
  carry `kind ∈ {new_node, reconsolidation, oscillation}`. Migration is additive and
  reversible.
- **Producer:** the `remember` path's consolidation events are bridged to `activation_trace`
  when `viz_trace_enabled='1'`, mirroring the existing recall gating
  (`SwitchableActivationTraceSink` pattern, `src/adapter/ambient-recall.ts:115–131`). The
  bridge is **fire-and-forget, wrapped in try/catch, and must never affect consolidation**
  (project `[keep]` guard: Consolidator is the sole graph writer; emits cannot perturb it).
- **Transport:** unchanged — one SSE `trace` event, one ring buffer (`RING_CAP=50`),
  `POLL_MS=250`. The client branches on `row.kind` for color + motion.

### 4. Event color + motion vocabulary

Semantic axis: amber = retrieval, cyan = association, green = encoding,
magenta = reconsolidation, orange = instability.

Recall is one `kind` (`recall`) rendered as two element types (seeds vs hops); ingestion has
three row-level kinds.

| element / `kind` | Meaning | Color | Motion |
|---|---|---|---|
| recall — seed | direct retrieval hit | amber `#ffb866` (keep `HOT`) | bright attack + decay tail |
| recall — 1-hop | spreading association | cyan `#66d9ff`, subordinate (thinner, dimmer) | single wave, faster fade |
| `new_node` | encoding an unrelated fact | green `#66ff99` | quiet single blip at the new node's position |
| `reconsolidation` | **prediction-error belief update in place (hero)** | magenta `#ff3b6b` | error-flash on the **existing/updated** node → settles back to normal. **No duplicate node spawns.** Incoming evidence (`candidate_id`) gets a brief subordinate green "arriving" blip that merges into the updated node and vanishes. |
| `oscillation` | unresolved contradiction | orange `#ff7a1a` | wavering/strobing pulse — visibly unsettled |

Magnitude (from the consolidation event) modulates flash intensity for ingestion kinds, the
way `score` modulates recall kinds.

## Out of scope

- No change to retrieval/consolidation logic, scoring, or graph traversal. This is a
  presentation-layer rework only.
- No new SSE channel, websocket, or transport change.
- No multi-hop retrieval (the engine is 1-hop; we honor that).

## Files touched (anticipated)

- `src/viz/modules/hud.js` — pass full row to `applyTrace`.
- `src/viz/modules/trace.js` — rewrite `applyTrace` to consume real `hops`; delete client BFS;
  new decay envelope; per-`kind` color/motion branching.
- `src/viz/modules/constants.js` — decay-tail constants; new palette entries; demote
  `MAX_HOPS`/`TRACE_FANOUT`/`TRACE_MAX_EDGES` to caps.
- `src/viz/activation-sink.ts` — nullable `kind` column + migration; accept `kind` on emit.
- `src/viz/server.ts` — include `kind` in the `/events` payload (SSE `data`).
- Ingestion bridge — wire `remember`'s consolidation events to the activation-trace sink under
  the viz flag (likely new small adapter alongside `src/adapter/remember-cli.ts` /
  `ambient-recall.ts` switchable-sink pattern).

## Success criteria

1. Recall trace fires **only** seeds + their real scored 1-hop neighbors — no topology BFS.
   Verifiable: a recall whose payload has N hop edges lights exactly N edges (≤ caps), and the
   lit edges match `row.hops`.
2. Seed/edge brightness visibly tracks retrieval score (strong hits brighter than weak).
3. Lit set holds then decays per the tail envelope.
4. `remember` of a new unrelated fact → green blip; a contradicting fact → magenta flash on the
   existing node with no duplicate spawned; an unresolved contradiction → orange wavering pulse.
5. Viz-disabled path remains zero-cost (Noop sink) and consolidation is unaffected
   (bridge failures swallowed).
