# Phase 55: Honest 1-hop pathways on ambient recall - Context

**Gathered:** 2026-06-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Make per-prompt **ambient recall** (`retrieveRanked`, `src/retrieval/engine.ts` emit sites
~499/518) surface each retrieved seed's **real 1-hop graph out-edges** as `hops` so the viz shows
spreading-activation pathways on **every** recall — not just the rare curated recalls. Mirrors the
already-honest curated path (`src/recall/index.ts:525`).

**In scope:**
- In `retrieveRanked`, for each emitted seed, fetch its real 1-hop `relation` out-edges and emit them
  as `hops` with `score: null` (rank-only, WR-02-safe). Both emit sites (the `temporalAnnotate`
  branch ~499 and the flat branch ~518) get the same treatment.
- Align the ambient seed payload shape to the curated row shape: emit seeds as
  `{node_id, score}` objects carrying their **real** cosine/RRF magnitude (D-04).
- Extended Plan-04-style machine guards asserting emitted hops are real graph edges, `score: null`,
  and no fabricated edge or magnitude (SC3).

**Out of scope (hard):**
- No new spread/traversal loop, no multi-hop. This is a **read of edges that already exist**, not a
  new retrieval algorithm.
- No scoring change, no ranking change, no change to what `retrieveRanked` *returns* to callers —
  this only enriches the fire-and-forget viz trace emit.
- No client/viz changes required by this phase (Phase 52 already consumes `row.hops`); the existing
  `TRACE_FANOUT` / `TRACE_MAX_EDGES` viz caps remain as backstops, untouched.
- No fabricated edges or magnitudes. No regression of Phase 52 honesty guards or Phase 54 layer guards.

</domain>

<decisions>
## Implementation Decisions

### Edge budget / fanout (the load-bearing decision)
- **D-01:** **Cap per-seed by weight.** Every emitted seed expands; for each seed, emit only its
  **top-N highest-weight** real `relation` out-edges. Honest subset — real edges, ranked by the real
  stored edge weight `w`, truncation is honest (a subset of real edges, never invented ones). The
  cap lives in the **engine** (bound before emit); the existing Phase-52 viz `TRACE_MAX_EDGES` /
  `TRACE_FANOUT` stay as a client-side backstop only.
- **D-02:** **Default N = 6** per seed (~up to 60 hops across ~10 seeds before the viz backstop).
  Founder symptom is "pathways rarely show," so err denser, not sparser. **N is a named tunable
  constant** (mirror the Phase 52 D-06 decay-constant precedent) — tune at the founder visual
  checkpoint; the number only matters against the rendered feel.
- **D-03:** Tie-break / determinism — when edge weights tie, order is stable (by the store's edge
  read order / dst id). Planner: pick a deterministic tiebreak so the guard test is reproducible.

### Edge direction
- **D-04 (direction):** **Out-edges only** (`getOutEdges` / `getOutEdgesWithRel`), matching the
  roadmap wording and the measured 40–72 out-edges/seed. **KNOWN RISK (accepted):** Phase 18 CR-01
  found out-edges-only silently missed ~50% of `schema_rel` pairs because those edges store with a
  lexicographic `src<dst` convention. Founder chose out-edges-only knowingly for simplicity. See the
  research flag in canonical refs — researcher MUST confirm whether `kind='relation'` edges are
  stored bidirectionally (so out-edges captures the intended associative neighbors) or `src<dst`
  single-direction (which would silently halve pathways for those seeds). If the latter, surface it
  at the founder checkpoint — but the **decision stays out-edges-only** unless the founder revises.

### Edge-kind allowlist
- **D-05:** **Semantic/association only → `kind === 'relation'`.** This is the clean allowlist:
  `relation` covers associative edges AND typed-predicate edges (they share `kind='relation'` with
  `rel` set). **Excluded:** structural `abstracts` / `schema_rel` (don't read as "thinking
  pathways") and the corpus-document kinds `cites` / `doc_link` / `doc_containment` /
  `doc_reference` / `derived_from` (document structure, not memory associations).
- **D-05a:** LANDMINE 2 (Phase 37): `links_to` / `extends` edges also carry `kind='relation'` but are
  NOT associative-recall edges. Planner: decide whether to include them. Default lean — include all
  `kind='relation'` for simplicity unless the researcher shows they pollute the pathway feel; the
  honest-subset framing holds either way (they are real edges).

### Seed magnitude honesty
- **D-06:** **Emit the real seed score.** Unlike the curated path (rank-only, seed `score: null`),
  ambient seeds carry a **real cosine/RRF magnitude** — emit it (`brightness ∝ real score`). Hops
  stay `score: null` (rank-only, WR-02). This moves the ambient emit from `seeds: string[]` to
  `seeds: [{node_id, score}]` objects, aligning with the curated row shape so the client renders both
  paths uniformly. Researcher: verify the Phase-52 client (`hud.js` / `trace.js`) already accepts the
  `{node_id, score}` seed object shape (the curated path emits it today) — if a string-array
  fallback path still exists, ensure the change doesn't break it.

### Liveness (correctness constraint, not a choice)
- **D-07:** Hop targets MUST be **live** nodes — exclude tombstoned/evicted dst. Mirror the curated
  path's neighborhood filtering. Never light a dead node.

### Honesty / emit safety (locked, carried from Phase 52)
- **D-08:** Emit stays **fire-and-forget** — wrap in try/catch, never surface a sink error to the
  caller, never perturb retrieval (T-10-05). The added edge read must not change what `retrieveRanked`
  returns. Keep it cheap: this is the **LLM-free hot path** (per-prompt, p50/p95 ~45/46 ms today) —
  use a prepared/batched edge read; do not add measurable latency.

### Claude's Discretion
- Exact prepared-statement / batching strategy for the per-seed edge reads (keep hot-path cheap).
- Deterministic tiebreak ordering for equal-weight edges (D-03).
- Whether to include `links_to` / `extends` relation-kind edges (D-05a) — pending researcher signal.
- Exact named constant location for N (mirror `src/viz/modules/constants.js` style or an engine-side
  config knob — planner picks the idiomatic home).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract & honesty invariant (read first)
- `.planning/ROADMAP.md` (Phase 55 entry) — goal, evidence-backed root cause, locked approach, SC1–SC3.
- `.planning/phases/52-brain-viz-honest-traces/52-CONTEXT.md` — the honest-traces invariant this phase
  must NOT regress: hops are real edges, `score: null` when no measured magnitude (WR-02), emits are
  fire-and-forget (T-10-05). D-07 (seed/edge intensity ∝ score; null → fixed mid-intensity) governs
  how the client renders `score: null` hops.
- `docs/superpowers/specs/2026-06-29-brain-viz-honest-traces-design.md` — the Phase 52 design contract
  (palette, motion vocabulary, honesty through-line). Phase 55 feeds the same `activation_trace` row.

### Emit sites to change (server already owns the trace row)
- `src/retrieval/engine.ts:493-524` — the TWO `retrieveRanked` emit sites (temporalAnnotate branch
  ~497-503 and flat branch ~515-522). Both emit `seeds: <string[]>, hops: []` today. This phase
  rewrites both to emit `{node_id, score}` seeds + real top-N `relation` out-edge hops.
- `src/recall/index.ts:511-529` — the curated path to MIRROR. Shows the exact target shape:
  `seeds: [{node_id, score:null}]`, `hops: [{node_id, score:null, hop:1}]`. (Ambient differs only in
  seed `score` being real per D-06.)

### Graph edge reads (reuse — do not write new SQL)
- `src/db/semantic-store.ts:487-504` — `getOutEdges(nodeId)` → `{dst, w, kind}` (no rel) and
  `getOutEdgesWithRel(nodeId)` → `{dst, rel, w, kind}`. Use one of these for the 1-hop read; filter
  to `kind==='relation'` (D-05), rank by `w`, take top-N (D-01).
- `src/db/semantic-store.ts:536-557` — `getInEdges` / `getEdgesForNode` (both-direction). NOT used by
  D-04's out-edges-only decision, but referenced for the research flag below.
- `src/lib/types.ts:38` — `EdgeKind` enum (the allowlist source of truth for D-05).

### Research flags (researcher MUST resolve before planning locks)
- **Edge-storage direction:** confirm whether `kind='relation'` edges are stored bidirectionally or
  `src<dst` single-direction (Phase 18 CR-01 / `src/consolidation/schema-induction.ts` lesson). If
  single-direction, out-edges-only (D-04) silently under-counts — flag at founder checkpoint.
- **Client seed shape:** confirm `src/viz/modules/hud.js` + `src/viz/modules/trace.js` accept
  `{node_id, score}` seed objects (D-06) without breaking any remaining string-array path.
- **Hot-path latency:** confirm the per-seed edge read (≤10 seeds × one prepared read) stays within
  the ~45ms p50 budget; batch if needed (D-08).

### Project guards (load-bearing)
- `CLAUDE.md` (project) — Consolidator-is-sole-graph-writer; emits MUST be fire-and-forget, try/catch,
  never affect the engine path (T-10-05). LLM-free hot path. Graph is source of truth.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `getOutEdges` / `getOutEdgesWithRel` (`semantic-store.ts:487/502`): existing prepared-statement
  edge reads — exactly the 1-hop fetch this phase needs. No new SQL.
- The curated path emit (`recall/index.ts:516-525`): a complete, honest template for the row shape
  (`{node_id, score:null, hop:1}` hops) — copy its structure, swap seed `score` to the real value.
- Phase 52 client already consumes `row.hops` and renders seeds amber / hops cyan with
  `score`-driven brightness (null → fixed mid-intensity, D-07) — **no client change needed** if the
  seed object shape is honored.

### Established Patterns
- `activation_trace` is a 50-row ring buffer; one recall = one row carrying both `seeds` and `hops`.
  Per-recall hop count is the density lever — D-01/D-02 bound it engine-side; viz caps backstop.
- WR-02 / D-07: emit `score: null` when there's no measured magnitude rather than fabricating one.
  Hops here are rank-only (graph adjacency, not a similarity computation) → `null`.
- T-10-05: every trace emit in the engine is already wrapped in try/catch fire-and-forget — extend
  inside the existing guard, do not add a new code path that can throw into retrieval.

### Integration Points
- `retrieveRanked` emit (engine.ts) → `traceSink.emit({query_id, seeds, hops})` → `activation_trace`
  → `server.ts` SSE `trace` event → `hud.js` → `trace.js applyTrace`. Only the first hop (engine
  emit) changes; everything downstream already handles `seeds`+`hops`.

</code_context>

<specifics>
## Specific Ideas

- Honesty through-line (from Phase 52, non-negotiable): every pulse must be true to an edge the graph
  actually stores. Hops are a **real subset** (top-N by weight) of real out-edges — truncation is
  honest, fabrication is not. The machine guard (SC2/SC3) is the regression lock on that promise.
- Density default errs denser (N=6) because the founder symptom is *too few* pathways, not too many —
  tune down only if it reads cluttered at the checkpoint.
- Seeds carry their real cosine/RRF magnitude (D-06) — ambient recall is actually *richer* than the
  curated path here, because it has a measured score the curated path lacks.

</specifics>

<deferred>
## Deferred Ideas

- **Both-direction (in+out) 1-hop pathways** — would close the Phase 18 CR-01 under-count risk for
  `src<dst`-stored edges, but founder chose out-edges-only for this phase (D-04). Revisit only if the
  research flag shows associative edges are single-direction AND the checkpoint reads sparse.
- **Including structural (`abstracts`/`schema_rel`) or doc-graph edges as pathways** — out of scope by
  D-05; a future "show schema/corpus structure in the viz" idea, not associative recall.

</deferred>

---

*Phase: 55-honest-1-hop-pathways-on-ambient-recall*
*Context gathered: 2026-06-30*
