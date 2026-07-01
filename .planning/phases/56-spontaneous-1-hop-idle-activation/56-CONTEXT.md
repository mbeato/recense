# Phase 56: Spontaneous 1-hop idle activation - Context

**Gathered:** 2026-07-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Add an honest **idle "default-mode" emitter** to the `recense viz` server so the brain wanders
during idle gaps — it fires genuinely-new **real** 1-hop spreads (NOT replay echoes) even with an
empty replay buffer / zero recent recalls, without fabricating any edge or activation. The emitter
is a read-only SSE-only `setInterval` in `src/viz/server.ts`, mirroring the Phase-54 replay
scheduler, that picks live seed node(s) and reads their real semantic 1-hop out-edges via the
**same honest filter** Phase 55 uses (`kind==='relation' && PRED_SET.has(rel)` + liveness + top-N).
Rendered in a distinct dim indigo/violet "default-mode" hue under a new trace `kind='spontaneous'`.

**In scope:**
- Read-only SSE-only spontaneous emitter in `server.ts` (never writes `activation_trace`, no new
  `Database()`, no LLM, no network — SPONT-03, preserves single-writer + read-only/LLM-free viz).
- Seed selection from a **pre-filtered pool** of live nodes that have ≥1 semantic out-edge.
- Reuse of the Phase-55 semantic-edge filter via a **shared single-source-of-truth helper** (not a
  reimplementation) so it can never drift from the engine's honest builder.
- New `kind: 'spontaneous'` on the SSE trace event; distinct dim indigo/violet color in the client
  (`trace.js` / `constants.js`), subordinate to replay (`SPONT_DIM < REPLAY_DIM`).
- Tray-icon pulse suppression on `kind==='spontaneous'` (idle, not live — same rule as replay).
- Machine guards (SPONT-06): every emitted hop is a real semantic out-edge of its seed
  (cross-checkable against the store); spontaneous never writes an `activation_trace` row.
- Founder visual checkpoint to tune hue / cadence / dim / density.

**Out of scope (hard):**
- No new spread/traversal algorithm, no multi-hop — this reuses the existing honest 1-hop edge read.
- No DB write of any kind from the viz server; no change to what the engine or retrieval returns.
- No regression of Phase 52 honesty guards, Phase 54 replay/twinkle layer guards, or Phase 55
  ambient-hop guards.
- No tray pulse on spontaneous; spontaneous excluded from the replay ring (automatic — see D-11).

</domain>

<decisions>
## Implementation Decisions

### Idle gating vs replay (SPONT-04 — the central behavioral choice)
- **D-01:** **Fallback-when-replay-can't.** Spontaneous fires only when the replay buffer is
  **empty** (fresh/idle brain with no recent real rows to echo). When replay history exists, replay
  owns the idle gap and spontaneous stays silent. This satisfies SC3 ordering (live > replay >
  spontaneous > twinkle) by construction — replay always preempts — and matches the roadmap headline
  ("feels alive *even with an empty replay buffer*"). Cleanest honesty story, simplest to reason about.
- **D-01a:** Gate on the **same idle signal** as replay (`Date.now() - lastLiveRow >= idle gap`), so
  any live activity preempts spontaneous too. Planner: decide whether spontaneous reuses the replay
  interval body (checking `replayBuffer.length === 0` inside it) or runs its own `setInterval` — the
  observable behavior is identical; pick the idiomatic structure. Emitter must `.unref()` like replay.

### Seed selection (SPONT-01)
- **D-02:** **Pre-filtered pool, uniform.** Sample uniformly from live (non-tombstoned) nodes that
  have **≥1 semantic out-edge** (`kind='relation'` with a `PRED_SET` rel). Guarantees every tick
  renders a real pathway (no dud ticks — uniform random over *all* nodes would frequently hit
  doc/structural nodes the honest filter drops). Uniform within the pool = no salience bias to
  defend. Planner: build the eligible-id pool from the edge table (read-only; e.g. distinct `src`
  where `kind='relation'` ∧ rel ∈ PRED_SET ∧ src live), refreshed periodically or on a cadence —
  keep it cheap and read-only.
- **D-03:** **2–3 seeds per tick** (distinct), each expanding its top-N real out-edges (reuse
  Phase-55 `AMBIENT_HOP_TOPN=6`). One seed felt too sparse vs replay's multi-seed rows; 2–3 gives
  density parity while staying honest. **Seed count is a named tunable constant** — tune at the
  founder checkpoint. Seeds within a tick must be distinct nodes.

### Color & density (SPONT-02 / SPONT-06)
- **D-04:** **Dim indigo/violet "default-mode" hue** — clearly distinct from recall amber
  (`0xffb866`) and recall/replay cyan (`0x66d9ff`), evokes default-mode-network/dreaming, reads as
  calm background wandering, fits the muted aubergine/slate palette. Starting direction only; exact
  value tuned at the visual checkpoint.
- **D-05:** **Named tunable constants**, mirroring the Phase-54/55 layer-constants pattern in
  `constants.js` (with the server-side authoritative copy where the scheduler needs it): spontaneous
  hue, idle cadence, `SPONT_DIM`, and density (seed count / top-N). **Hard invariant:
  `SPONT_DIM < REPLAY_DIM` (0.4)** so spontaneous always reads strictly subordinate to replay (SC3).
- **D-06:** Founder visual checkpoint (mirror Phase-54 Plan-05) tunes hue / cadence / dim / density
  against the rendered feel — the numbers only matter on screen.

### Builder reuse + wire tag + honesty guards (SPONT-01 / SPONT-05 / SPONT-06)
- **D-07:** **Shared single source of truth for the honest filter.** Extract the Phase-55 filter core
  (`kind==='relation' && PRED_SET.has(rel)` → weight-desc/dst-asc sort → liveness-before-slot →
  top-N) into one pure helper imported by BOTH the engine emit
  (`engine.ts` `buildAmbientTracePayload`, lines ~391-418) and the viz server. Can't drift when
  PRED_SET / edge-kind rules change — the "same honest builder" promise is literal. The read-only
  viz server obtains graph access via a **read-only `SemanticStore` over its existing db handle** OR
  an edge-reader closure passed to the helper — planner picks; the server must remain read-only
  (no writes, no new `Database()`).
- **D-08:** **Wire tag `kind: 'spontaneous'`** on the SSE trace event (roadmap-specified). Hops carry
  their real `src` seed (SC1 edge lines) and `score: null` (WR-02, rank-only — no fabricated
  magnitude), mirroring the Phase-55 ambient hop shape.
- **D-09:** **Tray suppression (SPONT-05).** Extend the existing `replay===true` pulse-suppress in
  `apps/tray/tray-icon.js` (~lines 122-142) to also suppress on `kind==='spontaneous'` — same
  "idle, not live" rule. A malformed/unparseable trace still pulses (fail toward the liveness
  signal, matching current behavior).
- **D-10:** **Machine guard (SPONT-06).** A test asserts every emitted spontaneous hop `(src→dst)` is
  a real `kind='relation'` PRED_SET out-edge of its seed in the store and `dst` is live — no
  fabricated edge, no fabricated magnitude. Reuse/extend the Phase-55 guard style.
- **D-11:** **Replay-ring exclusion is automatic (SPONT-05).** The replay ring is populated ONLY from
  `activation_trace` DB rows in the live poll; spontaneous is SSE-only and writes no row (D-07/SPONT-03),
  so it can never enter the ring. The guard is simply: assert spontaneous writes no `activation_trace`
  row. No explicit `kind==='spontaneous'` filter on the ring is needed (but a defensive skip is cheap
  if the planner wants belt-and-suspenders).

### Claude's Discretion
- One `setInterval` (checking `replayBuffer.length === 0`) vs a separate spontaneous interval (D-01a).
- Exact construction/refresh strategy for the eligible-seed pool — keep it read-only and cheap (D-02).
- Whether the server reuses a read-only `SemanticStore` or an edge-reader closure for D-07.
- Exact named-constant homes (mirror `constants.js` layer-constants style; server-authoritative copy
  where the scheduler reads it, as replay does for `REPLAY_CADENCE_MS`/`REPLAY_HISTORY_N`).
- Deterministic behavior for the guard test (seeded/injected RNG or fixed pool) so it's reproducible.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract & honesty invariant (read first)
- `.planning/ROADMAP.md` (Phase 56 entry) — goal, approach, SPONT-01…06, SC1–SC4.
- `.planning/phases/52-brain-viz-honest-traces/52-CONTEXT.md` — the honest-traces invariant this phase
  must NOT regress: hops are real edges, `score: null` when no measured magnitude (WR-02), emits are
  fire-and-forget (T-10-05).
- `.planning/phases/55-honest-1-hop-pathways-on-ambient-recall/55-CONTEXT.md` — the honest 1-hop
  builder this phase reuses (edge-kind allowlist D-05, liveness D-07, top-N D-01/02, `score:null`
  hops D-06, `src` on each hop). The PRED_SET structural-exclusion fix is in that phase's close.
- `.planning/phases/54-viz-ambient-liveliness-and-replay-traces/` (PLANs 54-03/54-05 + SUMMARYs) —
  the replay scheduler + twinkle layers this mirrors, and the founder visual-checkpoint precedent.

### Emit / render sites to change or mirror
- `src/viz/server.ts:450-479` — the Phase-54 replay scheduler (`setInterval`, idle-gap gate,
  `.unref()`, SSE-only, read-only). The spontaneous emitter mirrors this exactly. The replay
  buffer/poll (`server.ts:389-448`) shows the `lastLiveRow` idle signal and the `replayBuffer`
  whose emptiness gates spontaneous (D-01). Teardown at `server.ts:1217` (`clearInterval`).
- `src/retrieval/engine.ts:368-418` — `buildAmbientTracePayload`, the Phase-55 honest filter to
  extract into the shared helper (D-07). Note `SEED_K`, `AMBIENT_HOP_TOPN` constants near the top.
- `src/db/semantic-store.ts:~487-504` — `getOutEdges` / `getOutEdgesWithRel` prepared reads
  (`{dst, rel, w, kind}`); the read primitive the shared helper needs. `getNode` for liveness.
- `src/model/typed-predicates.ts:35` — `PRED_SET` (the semantic-edge allowlist source of truth).
- `src/viz/modules/constants.js:336-375` — the Phase-54/55 layer-constants block; add the
  spontaneous named constants here (hue, cadence, `SPONT_DIM`, density) with `SPONT_DIM < REPLAY_DIM`.
- `src/viz/modules/trace.js:236-253` — `KIND_COLORS` map + the pre-dimmed replay-hop color pattern;
  add the `spontaneous` kind color (dim indigo/violet) following the same construction.
- `apps/tray/tray-icon.js:122-142` — the `replay===true` pulse-suppress to extend for
  `kind==='spontaneous'` (D-09).

### Project guards (load-bearing)
- `CLAUDE.md` (project) — Consolidator is the SOLE graph writer; viz emits/reads are read-only and
  fire-and-forget (T-10-05); LLM-free / read-only viz server; graph is source of truth. Faithfulness:
  no fabricated edges or magnitudes.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildAmbientTracePayload` (`engine.ts:391-418`): the exact honest 1-hop filter — extract its core
  into a shared pure helper (D-07) rather than copying it.
- Phase-54 replay `setInterval` (`server.ts:460-479`): the read-only, idle-gated, `.unref()`'d,
  SSE-only emitter template — copy its structure, swap the row source for live-seed spontaneous hops
  and gate on `replayBuffer.length === 0`.
- `getOutEdgesWithRel` / `getNode` (`semantic-store.ts`): existing prepared reads; no new SQL for the
  hop read. A pool-building read (distinct semantic-edge srcs) is the one new read-only query.
- `KIND_COLORS` + `REPLAY_HOP_COLOR` construction (`trace.js:236-253`): template for adding a
  per-kind dim spontaneous color.

### Established Patterns
- Idle layers gate on `lastLiveRow` and any live poll preempts them (SC3). `SPONT_DIM < REPLAY_DIM`
  encodes the visual subordination as a hard invariant.
- Named tunable constants with a server-side authoritative copy where the scheduler reads them
  (as replay does for `REPLAY_CADENCE_MS` / `REPLAY_HISTORY_N`), tuned at a founder visual checkpoint.
- Trace emits are fire-and-forget; the viz server holds a read-only DB handle and never writes.
- `score: null` for rank-only hops (WR-02); each hop carries its real `src` seed (SC1 edge lines).

### Integration Points
- Spontaneous emitter (`server.ts` interval) → SSE `trace` event `{seeds, hops, kind:'spontaneous'}`
  → `hud.js` → `trace.js applyTrace` (dispatch on `row.kind`) → dim indigo/violet render. In
  parallel, the SSE event reaches `tray-icon.js`, which must NOT pulse on `kind==='spontaneous'`.
- No DB row is written, so nothing downstream of `activation_trace` (replay ring, persistence) sees
  spontaneous — exclusion by construction (D-11).

</code_context>

<specifics>
## Specific Ideas

- Honesty through-line (non-negotiable, from Phases 52/55): every spontaneous pulse traces a real
  semantic out-edge the graph actually stores — a top-N subset is honest truncation, fabrication is
  not. The machine guard (SPONT-06 / D-10) is the regression lock.
- "Default-mode network" framing: the emitter is the brain wandering to a salient-but-random memory
  when it has nothing live to do — dim indigo/violet reads as that calm background mode, visually
  below both recall (amber) and replay (cyan).
- Density errs toward liveliness (2–3 seeds × top-N hops) because the founder symptom is idle
  emptiness, not clutter — tune down only if it reads busy at the checkpoint.

</specifics>

<deferred>
## Deferred Ideas

- **Strength/degree-weighted seed selection** — biasing wandering toward salient/well-connected
  memories would feel more lifelike, but introduces a selection bias to defend and makes rich nodes
  recur; rejected in favor of uniform-over-eligible-pool (D-02). Revisit only if uniform reads flat
  at the checkpoint.
- **Spontaneous as an always-on / deeper-idle enrichment layer alongside replay** — considered
  (D-01 alternatives) but rejected for the cleaner fallback-only gating; revisit if the empty-buffer
  fallback feels too rare in practice.
- **Both-direction (in+out) 1-hop for spontaneous** — inherits the Phase-55 out-edges-only decision
  and its accepted `src<dst` under-count risk; not reopened here.

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 56-spontaneous-1-hop-idle-activation*
*Context gathered: 2026-07-01*
