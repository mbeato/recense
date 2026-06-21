# Phase 37: Typed Predicate Edges — Build - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Promote the spike-004-validated typed predicate edges into the **live** engine across three surfaces:

1. **Model (TYPED-01):** the schema + `edge` model carry a predicate type.
2. **Extraction (TYPED-01):** offline consolidation extraction emits typed edges.
3. **Recall (TYPED-02):** recall traverses a typed relational *path* instead of dumping an untyped schema-neighborhood, returning a smaller, more precise payload.

**Gate satisfied:** Phase 36 spike (`.planning/spikes/004-typed-predicate-edges/`) returned a founder **GO (2026-06-20)**, resting on the **precision** axis (+22–30pts), not reachability (marginal +5.3pts @ K=20).

**Engine invariants (do not violate):** all LLM/embedding cost stays in the offline sleep pass; the online recall path stays LLM-free and fast; graph is source of truth, vector is derived cache; self-confirmation guard intact (inferred output never mints or strengthens a typed edge); never resurface a tombstoned node; net-zero new runtime deps.

</domain>

<decisions>
## Implementation Decisions

### Edge model (TYPED-01)
- **D-01:** Store the predicate type in the **existing free-text `rel` field** on `kind='relation'` edges, constrained to the closed 12-predicate vocabulary. **No migration, no new column, no `kind`-enum expansion.** Traversal filters edges by `rel`.
  - Rationale: edges are already one-row-per-relation; `rel: string` already exists (`src/lib/types.ts:68`); the spike used exactly this (`upsertEdge(db, s, o, predicate)`). A dedicated indexed `predicate` column only buys a traversal index that is unjustified at ~7k nodes; promoting predicates into the `EdgeKind` enum conflates edge *classification* with relation *semantics*.
  - Note: the "two rows (typed + untyped)" intuition was an A/B **measurement artifact** in the spike (the untyped control was the same edge read with `rel` ignored — `02-extract.ts:12`), never stored data. Live engine = one edge per relation.

### Extraction integration (TYPED-01)
- **D-02:** **Fold** typed-triple extraction into the existing entity/fact `EXTRACTION_PROMPT` — one Haiku call per episode emits facts **and** `{subject, predicate, object}` typed edges. Avoids ~2× extraction cost (the dominant sleep-pass cost, gated by `consolSkipThreshold`).
- **D-03:** Gate D-02 behind a **fact-quality regression check** — the heavier merged prompt must not degrade existing fact extraction. If folding degrades facts, fall back to a separate triple-extraction call (the spike's validated prompt).

### Merge gate / measurement (TYPED-02)
- **D-04:** **Deterministic precision is the primary merge gate** — nodes-to-answer / answer-in-top-3 (variance-free; the +29.5pts anchor the GO rested on). **LLM-judged compose-quality is secondary confirmation** (3× majority to tame CLI temp-0 variance). Do not let the noisy judge gate the merge on small N.
- **D-05:** **Re-derive the query set with founder sign-off** before the gate binds (spike caveat: golds were Claude-authored and founder-accepted at GO, not line-by-line verified). Add the deferred LLM-judged answer-quality metric to the build harness.

### Recall traversal shape (TYPED-02)
- **D-06:** **Augment-with-fallback.** When the query confidently maps to a predicate path, recall returns the **typed path** — a small precise payload (the token win). When it doesn't, fall back to today's schema-neighborhood assembly (`schema→abstracts→members`, K=20), **unchanged**. One mode OR the other per query — never path *plus* neighborhood (that would re-bloat the payload and erase the win).
  - Rejected: parallel + RRF merge (re-mixes the typed path into a neighborhood, loses the small-payload win); full replace (breaks "what do I know about X" category queries that have no single predicate path).

### Query→predicate matching (TYPED-02, online LLM-free)
- **D-07:** **Embedding-match predicate glosses.** At sleep (offline), embed a short gloss per predicate (e.g. `located_in` → "where is / based in / located"). At recall, cosine-match the **already-embedded** query cue against the 12 predicate embeddings; above a **tunable threshold**, follow that predicate from the resolved anchor (`bestMatch`) — this IS the "confident match" that triggers D-06's typed-path mode. Below threshold → neighborhood fallback.
  - Fully LLM-free online (reuses the existing query embedding; only a 12-way cosine added). Fits "pay embedding cost at sleep, cheap online."
  - The threshold is the same tunable confidence knob referenced in D-06.
  - **v1 scope:** single-predicate-from-anchor. Multi-hop predicate chaining is a **research item** (see RESEARCH below), not a v1 commitment.
  - Rejected: keyword/pattern map (brittle, English-pattern-bound, misses paraphrases, maintenance liability across 12 predicates × phrasings).

### Locked invariants (no separate discussion — confirmed by founder)
- **D-08 (self-confirmation guard):** typed edges are minted **only at sleep from episodes**, never from recall/inferred output, and inferred output never strengthens a typed edge's weight (success criterion 3).
- **D-09 (predicate granularity):** keep the **12-predicate closed vocabulary** for v1. Granularity refinement is a noted lever (the spike's q02 "both arms fail on coarse predicate" finding), not a v1 task.

### Claude's Discretion
- Exact gloss wording per predicate, the cosine threshold value, and multi-hop path handling are delegated to the phase researcher to pin (D-07).
- Whether folding (D-02) lands as a single merged prompt or a sectioned prompt is a planning/implementation detail, subject to the D-03 fact-quality gate.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spike 004 — the GO basis + locked calibration (MOST IMPORTANT)
- `.planning/spikes/004-typed-predicate-edges/README.md` — founder GO verdict, the precision-vs-reachability results, K-sweep, calibration notes (vocabulary, prompt shape, traversal sketch), honest caveats, cost.
- `.planning/spikes/004-typed-predicate-edges/lib/vocab.ts` — the closed 12-predicate vocabulary + `TYPED_EXTRACTION_PROMPT` (the validated triple-extraction prompt shape).
- `.planning/spikes/004-typed-predicate-edges/lib/traverse.ts` — the recall-traversal sketch (typed path-weight ranking + control fairness / symmetry invariant). Upper bound for typed recall.
- `.planning/spikes/004-typed-predicate-edges/05-precision.ts` — the precision metric the merge gate (D-04) is modeled on (nodes-to-answer + compose-correctness).
- `.planning/spikes/MANIFEST.md` §"Requirements — Phase 36/37" — the carry-forward design constraints (control fairness, K=20, metric gap, cost lever).

### Roadmap + spike context
- `.planning/ROADMAP.md` §"Phase 37: Typed Predicate Edges — Build" — goal, requirements TYPED-01/02, three success criteria.
- `.planning/phases/36-typed-predicate-edges-spike/36-CONTEXT.md` — the pre-locked experiment design (D-01…D-07) the spike executed.

### Live engine — integration points
- `src/lib/types.ts:65` — `EdgeRow` (the `rel`/`kind` fields D-01 builds on); `EdgeKind` enum at line 27.
- `src/db/semantic-store.ts:384` — `upsertEdge` (writes typed edges); `getOutEdges`/`getInEdges` (traversal primitives).
- `src/db/schema.ts` — edge table DDL (currently `edge_v12`); confirms no migration needed for D-01.
- `src/recall/index.ts` — current schema-neighborhood recall (D-06 augments this; `recallNeighborhoodBudget` = K=20 source, `recallSidewaysHopBudget`).
- `src/source/extraction-prompts.ts` — `EXTRACTION_PROMPT` (D-02 folds typed extraction into this).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `EdgeRow.rel` (`src/lib/types.ts:68`): already free-text; D-01 reuses it as the predicate slot — zero schema change.
- `upsertEdge` (`src/db/semantic-store.ts:384`): already upserts `{src, dst, rel, w, kind}` — emits typed edges as-is once extraction supplies a `rel` from the closed vocab.
- `getOutEdges`/`getInEdges`: predicate-filtered traversal is a `rel`-filter over these existing primitives.
- Query embedding in `RecallEngine` (`src/recall/index.ts`): D-07's predicate match reuses the already-computed online query embedding — no new online embedding cost.
- The production headless transport (`createClaudeHeadlessClient`) that the spike reused verbatim for extraction.

### Established Patterns
- One-row-per-relation edges with `kind` (classification) + `rel` (label) separation — D-01 honors it.
- Recall caps payload at `recallNeighborhoodBudget` (K=20) — D-06's typed path lives under the same budget.
- All LLM/embedding cost in the offline sleep pass; online recall LLM-free — D-02 (sleep) and D-07 (online cosine, no LLM) both honor it.
- Tunable dark-default knobs (cf. Phase 35 `rankStrengthWeight`) — the D-07 threshold should follow the same tunable-knob pattern.

### Integration Points
- Extraction: `src/source/extraction-prompts.ts` → `EXTRACTION_PROMPT` (D-02).
- Write: `src/db/semantic-store.ts::upsertEdge` (typed edge emission).
- Recall: `src/recall/index.ts` (D-06 augment + D-07 predicate match).
- Schema/DDL: `src/db/schema.ts` (verify no migration needed; vocab constraint is application-level, not a CHECK).

</code_context>

<specifics>
## Specific Ideas

- The closed 12-predicate vocabulary is fixed for v1: `built_by, works_on, part_of, uses, depends_on, runs_on, located_in, integrates_with, supersedes, prefers, evaluated, configured_with`.
- The token win must be a measured *reduction*: typed path returns ~2-node payloads where the neighborhood returned ~20 (D-06). The harness must record payload size, not just answer correctness.
- Predicate matching glosses should be phrased as the natural-language question forms users actually ask ("where is X", "what does X use"), not the bare predicate token.

</specifics>

<deferred>
## Deferred Ideas

- **Thinking-on/off extraction cost lever** → **Phase 42 (token efficiency).** `MAX_THINKING_TOKENS=0` cuts extraction cost ~25× with a modest recall drop; flipping the default affects ALL extraction and deserves its own baseline-before-optimize pass. Out of scope for Phase 37.
- **Multi-hop predicate chaining** — v1 is single-predicate-from-anchor (D-07). Chaining ≥2 predicates online, LLM-free, is a research/follow-on item.
- **Predicate granularity refinement** — the 12-vocab leaves some queries unsolved by either arm (spike q02). Finer predicates are a future lever, not v1 (D-09).
- **Dedicated indexed `predicate` column** — revisit only if predicate-filtered traversal is ever proven too slow at much larger scale (rejected for v1, D-01).

None of these block Phase 37 — discussion stayed within phase scope.

</deferred>

---

*Phase: 37-typed-predicate-edges-build*
*Context gathered: 2026-06-20*
