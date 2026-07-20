# Phase 36: Typed Predicate Edges — Spike - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove — on a **scratch DB, live graph untouched** — that extracting *typed* predicates (`works_at`, `located_in`, `prefers`…) instead of generic untyped edges produces a **measurable lift in multi-hop recall**, yielding a founder-owned go/no-go for the Phase 37 build plus calibration notes (predicate vocabulary, extraction prompt shape, recall-traversal sketch). Off-distribution architecture work: the spike de-risks the "right approach" call before any engine change. Mirrors the Phase 29 / spike-003 spike-first discipline.

**In scope:**
- One typed extraction pass over a sampled corpus on a scratch DB (TYPED-SPIKE-01).
- A clean typed-vs-untyped A/B comparison and a scored go/no-go against an explicit bar.
- Written calibration notes: predicate vocabulary, extraction prompt shape, recall-traversal sketch, founder go/no-go.

**Out of scope (do NOT add here):**
- Any change to the live graph, live schema, consolidation pipeline, or live recall path — that is **Phase 37 (gated on this go/no-go)**.
- New runtime dependencies.
- Markdown/portability concerns, reflection/insights (Phase 38), reader/wiki (Phase 39).

**Grounding reality (informs every decision below):**
- The `edge` table already has `rel TEXT` + a `kind` enum (`src/db/schema.ts:57`) — so *typing the field is schema-cheap*; no migration needed for the label itself.
- The live engine extracts **no entity→entity relations today**. The only `kind='relation'` edge ever written is the structural `extends` edge during consolidation (`consolidator.ts:825`).
- Recall today is a **1-hop schema-neighborhood** walk over `abstracts` edges (`recall/index.ts`); there is **no multi-hop entity→entity→attribute traversal**. So "untyped relation edges" is hypothetical and must be *constructed* as a control — see D-01.
</domain>

<decisions>
## Implementation Decisions

### Baseline / control arm
- **D-01: Synthetic untyped A/B (typing is the only variable).** One extraction pass over the scratch corpus builds the **typed** graph (`alice --works_at--> acme`). A copy of that exact graph **strips the predicate labels** to generic weighted `relation` edges (`alice --relation(w)--> acme`) — identical nodes, identical edge topology, *only* the `rel` typing differs. Lift = `reachability(typed) − reachability(control)`, cleanly attributable to typing. The live schema-neighborhood recall is **not** the control (comparing against it would conflate two changes — adding entity relations AND typing them).

### Predicate vocabulary (calibration note, success criterion 3)
- **D-02: Closed founder-authored set (~8–15 predicates).** The extractor is **constrained** to a fixed list (e.g. `works_at, located_in, prefers, owns, part_of, knows, created_by, manages, uses, born_in…`). Every edge label ∈ the set → no synonym-normalization noise (`works_at` vs `employed_by`), and the query set is easy to anchor. **The exact list is finalized against the real sample** (D-06) so it covers what's actually present. The closed vocabulary IS the calibration note the success criteria require.

### Query set + go-metric (the go/no-go)
- **D-03: Reconstruct multi-hop queries from the sampled episodes.** Pull real entities/attributes from the entity-dense sample (D-06) and form questions whose **gold answer sits ≥2 hops away** (e.g. `where is alice?` → `alice -works_at-> acme -located_in-> denver` → `denver`). **Gold answers are founder-verified against the source episodes.** Queries are **held out from extraction**. ~15–30 queries. (Rejected: auto-generating from the graph — circular, the typed arm would author its own test. "Sample from real recall logs" was infeasible — see Canonical Refs / grounding: recall deliberately never logs query text, `recall-cli.ts:11-12`.)
- **D-04: Metric = answer-reachability %, per arm.** For each query, on each arm: is the gold answer present/reachable in the recall payload **via a correct hop path**? Score = % of queries correct. Deterministic, no LLM-judge variance. (Rejected: pure `recall@k` ignores whether a coherent path/answer assembles; LLM-judged quality adds the spike-003 CLI temp-0 non-determinism, bad for small-N.)
- **D-05: Go bar (founder-owned).**
  - **GO:** `typed ≥ ~70%` reachability **AND** `lift ≥ +20 pts` absolute over control.
  - **NO-GO:** `lift < +10 pts` **OR** `typed < 50%`.
  - **GRAY band (in-between):** explicit founder judgment call with the numbers on the table.
  - Chosen to survive small-N noise and the no-inflated-metrics hard rule — a marginal gap does not count as "measurable."

### Sample + extraction model
- **D-06: Entity-dense slice, not a random sample.** Seed on a few well-connected entity clusters from the real corpus (people/projects/places that co-occur) and pull the episodes around them — **~200–400 episodes**. Guarantees 2-hop chains actually exist to reconstruct queries from (a random slice would be too sparse).
- **D-07: Haiku-first, escalate to Sonnet only on a miss.** Extract typed predicates with **headless Haiku** (the production extract model per spike-003) — a clear of the go bar is then an *honest* go reflecting build reality (no inflation). **Only if Haiku misses**, re-run extraction with **headless Sonnet** to separate "typing doesn't help" from "model couldn't extract good predicates," and record which it was in the calibration notes.

### Claude's Discretion
- **Recall-traversal sketch** (success criterion 3) — how typed-edge recall walks the relational path at query time — is left for the spike researcher/planner to propose. It's a build/traversal concern, not a founder decision. It must be *sketched and exercised* enough to score D-04, but the design is open.
- Scratch-DB construction mechanism (how the entity-dense slice is copied/extracted into an isolated DB) — standard, planner's call; must leave the live DB untouched.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 36: Typed Predicate Edges — Spike" — goal, three success criteria, requirement **TYPED-SPIKE-01**. Also §"Phase 37" — what a GO unlocks (do NOT implement here).
- `.planning/spikes/MANIFEST.md` — spike discipline + the spike-003 model-stack findings (headless Haiku extract / Sonnet judge; Haiku judge over-tombstoning caveat — relevant to D-07).

### Engine grounding (read before designing the spike)
- `src/db/schema.ts:57` — `edge( src, dst, rel TEXT, w REAL, kind TEXT )`; `kind` enum already includes `'relation'`. Typing the `rel` field is schema-cheap (no migration for the label).
- `src/consolidation/consolidator.ts:825` — the ONLY current `kind='relation'` write (`extends`). Confirms there is no live untyped entity-relation graph to beat → control must be synthesized (D-01).
- `src/recall/index.ts` — current recall = 1-hop schema-neighborhood over `abstracts` edges; no multi-hop traversal exists today (motivates the whole spike + the traversal sketch).
- `src/adapter/recall-cli.ts:11-12,37` — recall **deliberately never logs query text** (threat mitigation T-04-03-R; only scope/provider/errors hit `/tmp/recense-recall.log`). This is WHY "sample from real recall logs" was infeasible and D-03 reconstructs from episodes instead.
- `src/model/claude-headless-client.ts` — headless `claude -p` transport for Haiku/Sonnet extraction (D-07).

### Project hard rules
- `CLAUDE.md` (project) — sleep-pass model stack; **no-inflated-metrics** constraint (load-bearing for D-04/D-05); faithfulness (engine mechanisms trace to foundation).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `edge` table `rel`/`kind` columns (`schema.ts:57`) — the spike can store typed predicates in `rel` directly on a scratch DB with no schema change.
- `SemanticStore.upsertEdge` / `getOutEdges` / `getInEdges` (`src/db/semantic-store.ts`) — edge read/write primitives the traversal sketch can reuse against the scratch DB.
- Headless extraction transport (`src/model/claude-headless-client.ts`, `claim-extractor.ts`) — reuse for the typed-predicate extraction prompt; the `claude -p --output-format json` envelope reports per-call `usage` for honest cost accounting.

### Established Patterns
- Spike-first discipline (Phase 29 / spike-003): de-risk on a scratch surface, produce a founder go/no-go + calibration notes, no live mutation until the gated build phase.
- Closed-schema / constrained extraction already used in the engine (`CLAIM_ARRAY_SCHEMA`) — the closed predicate set (D-02) fits this pattern.

### Integration Points
- **None in scope.** The spike must NOT touch the live graph, consolidation pipeline, or recall path. All work is on an isolated scratch DB. Live integration is Phase 37, gated on the D-05 outcome.

</code_context>

<specifics>
## Specific Ideas

- Worked example to anchor the query set and traversal sketch: `where is alice?` → requires `alice -works_at-> acme` then `acme -located_in-> denver`, gold `denver`. The typed arm should return this precise path; the untyped control can only return a fuzzy neighborhood.
- Calibration-notes deliverable should explicitly state: closed vocabulary (the final N predicates), the extraction prompt shape used, the recall-traversal sketch, Haiku-vs-Sonnet outcome (if escalated), and the founder go/no-go with the actual numbers.
</specifics>

<deferred>
## Deferred Ideas

- **Promoting typed extraction into the live pipeline + typed-path recall** — that is **Phase 37 (TYPED-01 / TYPED-02)**, gated on this spike's GO. Do not start on a NO-GO.
- **Open/hybrid predicate vocabulary** with synonym normalization — considered for D-02, deferred to the build if/when a closed set proves too narrow.
- **LLM-judged answer quality** as a recall metric — deferred to the Phase 37 build harness (better tolerance for judge variance than a small-N spike).

### Reviewed Todos (not folded)
- `viz-search-and-hull-quality.md` (matched 0.6 on generic keywords "founder, phase") — viz-layer concern, unrelated to typed edges. Not folded.
- `content-hardening-deferred.md` (matched 0.4 on "phase") — unrelated. Not folded.

</deferred>

---

*Phase: 36-typed-predicate-edges-spike*
*Context gathered: 2026-06-20*
