# Phase 46: Reconsolidation Candidate Broadening - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning

> Captured in `--auto` mode: gray areas were enumerated, all auto-selected, and each
> resolved to its recommended default. Decisions are grounded in the live code (cited
> in Canonical References) — review before planning if any default looks wrong.

<domain>
## Phase Boundary

Decouple **contradiction-candidate generation** in the offline consolidation sleep pass from the single cosine escalation gate, so the existing PE-gated belief-update (Sonnet) judge actually fires on real LongMemEval-KU contradictions (today: **zero** fires — contradicting facts embed at cosine ~0.48 and never clear the gate).

**In scope:** Broaden the candidate set fed to the judge to a **union** of (a) the existing cosine top-k, (b) the existing M1 entity/subject anchor machinery, and (c) a **new** BM25 lexical pass over `node_fts` (FTS5). Extend the auto-unrelated suppression gate so a BM25 hit rescues a low-cosine claim into judge escalation. Add candidate-source + judge-fire counters for verifiability.

**Out of scope (own phases / future):**
- Hybrid BM25+dense fusion on the **online** retrieval hot path → Phase 47 (RETR).
- The C-2 self-confirmation **fix** → Phase 48 (HARD-01). This phase only *preserves* the existing self-confirmation guard, it does not change it.
- A new subject-hub graph traversal beyond what BM25 lexical match already captures (documented fallback if RECON-03 still reads zero).
- Replacing the embedder, adding a reranker, or any new online LLM call.
- Held-out tuning of the new K knobs → Phase 50 (verification/regression gates).

</domain>

<decisions>
## Implementation Decisions

### BM25 candidate generation (the new union member)
- **D-01:** BM25 query text = `ftsQueryFromText(claim.value)` — reuse the existing FTS5 sanitizer in `src/retrieval/topk.ts` (load-bearing T-17-02-T: never pass raw text to `MATCH`). Lexical match runs over the claim *value* only; entity/link overlap is already covered by the M1 anchor path, so BM25 stays a pure lexical pass and isn't double-counting the same signal.
- **D-03:** New config knob `bm25CandidateK`, default **5** (mirrors `candidateK: 5` / `entityAnchorK: 5` calibration placeholders). Reuse the existing `stmtBm25` prepared statement (`bm25(node_fts)` ordered best-first, tombstone-filtered). No new hard cap on the union beyond the per-source K's — judge candidate list size = cosine ∪ anchors ∪ bm25, bounded by `candidateK + entityAnchorK + bm25CandidateK`.

### Union assembly & ordering into the judge
- **D-02:** Judge candidate order = **cosine candidates → entity/subject anchors → BM25 candidates**, deduped by node id (extend the existing `cosineIdSet` Set to also exclude ids already contributed by anchors before appending BM25). This preserves D-17 fast-path precedence and the current anchor behavior; BM25 only *adds* nodes that neither cosine nor anchors surfaced. Union is **not** ranked/fused (no RRF here) — the judge does the screening; ordering is precedence-for-dedup only.

### Auto-unrelated gate interaction (the load-bearing change)
- **D-04:** Extend the auto-unrelated suppression at `consolidator.ts:759-762`. Today auto-unrelated fires when `cosineGate && anchors.length === 0`. New rule: auto-unrelated fires **only when** cosine is low AND there are **no anchors AND no BM25 candidates**. A BM25 lexical hit rescues the claim into judge escalation exactly like an anchor does. This is the change that lets the judge see the cosine-0.48 contradiction it currently auto-drops.

### Subject-keyed lookup scope
- **D-05:** Reuse the existing M1 entity-anchor machinery as-is for the entity/subject half (link-containment anchors + provenance-sibling anchors). Do **not** add a separate subject-hub graph traversal in this phase — BM25 over `node_fts` already captures subject-keyed lexical overlap on fact nodes, and subject hubs are corpus/doc nodes (the judge screens facts, not docs). Union = cosine ∪ M1-anchors (existing) ∪ BM25 (new). Subject-hub traversal is the documented fallback if RECON-03 still shows zero fires after BM25.

### Instrumentation (RECON-03 verifiability)
- **D-06:** Add candidate-source counters (how many candidates each of cosine / anchor / bm25 contributed) and a "judge fired on a contradiction" counter to the sleep-pass run summary. Counters are **observability only** — they never gate behavior. RECON-03 ("judge fires on real contradictions, >0") is verified from these counters.

### Default / dark-knob behavior
- **D-07:** BM25 candidate broadening ships **ON by default** — it is the point of the phase (judge currently fires zero). The `bm25CandidateK` knob doubles as the isolation switch: `bm25CandidateK = 0` reproduces today's exact behavior (cosine + M1 anchors only) for A/B and regression isolation, mirroring the existing `w=0` dark-RRF pattern in config.

### Hard invariants to preserve (not decisions — guardrails for the planner)
- All new BM25 reads are **sync prepared statements run in Phase A, before any `db.transaction`** (T-02-ASYNC). The union is built in the same pre-transaction read window as the M1 anchors.
- D-17 zero-inference fast path keeps precedence (evaluated on cosine candidates first, unchanged).
- Self-confirmation guard intact (`countDistinctProvenance` excludes `origin:'inferred'`; D-19 record-time drop). No inferred output may strengthen a fact.
- Tombstone + provenance guards on the judge→route→apply path unchanged. PE routing (`update-decision.ts`) is **downstream of candidates and is not modified** by this phase.
- No evidence-backed node deleted by decay; no new online/hot-path LLM call.

### Claude's Discretion
- Exact placement of the BM25 fetch (right after the M1 anchor build, ~`consolidator.ts:754`) and whether `bm25CandidateK` lives beside `candidateK`/`entityAnchorK` in `config.ts` defaults (~lines 773-790). Naming of the new counters. The planner/researcher decide structure.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap (the WHAT — locked)
- `.planning/REQUIREMENTS.md` §RECON (RECON-01..04) — union candidate gen, judge feed, judge-fires>0, no-regression + invariants. Also §"Out of Scope" (no embedder swap, no reranker).
- `.planning/ROADMAP.md` lines 777-786 (Phase 46 goal + 4 success criteria).

### Candidate generation — the code being changed
- `src/consolidation/consolidator.ts` lines ~685-800 — claim loop: cosine `topk` (line 691), D-17 fast path (695-714), **M1 entity-anchor expansion** (716-754), **auto-unrelated cosineGate** (756-762, the D-04 edit site), **judgeCandidates union assembly** (784-790, the D-02 edit site).
- `src/consolidation/update-decision.ts` — PE routing (HOLD/reconcile/append-new). **Read for invariants; not modified by this phase** (it is downstream of candidate generation).

### Reusable BM25 machinery
- `src/retrieval/topk.ts` — `ftsQueryFromText()` (line 226, the MANDATORY MATCH sanitizer, T-17-02-T), `CandidateRetriever.stmtBm25` (line ~302, `bm25(node_fts)` MATCH, tombstone-filtered). `rrfFuse` (line 239) exists but is **not** used here (no fusion in candidate-gen). FTS table-absent path falls back gracefully (line 463) — mirror that resilience.
- `src/db/schema.ts` — `node_fts` FTS5 table definition.

### Config knobs
- `src/lib/config.ts` lines ~773-790 — `candidateK: 5`, `entityAnchorK: 5`, `unrelatedSimilarityThreshold: 0.3`, `peReconcileBand*`. Add `bm25CandidateK: 5` (D-03) beside these.

### Invariants / grounding
- `.planning/ARCH-REVIEW.md` §C-2 (self-confirmation loop) — the invariant this phase must NOT break (the fix itself is Phase 48).
- Prior investigation: `.planning/phases/998.2-retrieval-embeddings-reconsolidation-engages-knowledge-updat/` — earlier reconsolidation/knowledge-update work; check its CONTEXT for prior decisions on the same path.
- Research grounding (no standalone file — summarized in REQUIREMENTS.md §Grounding + PROJECT.md "Key context"): dense cosine *structurally* cannot separate contradictions (NevIR near-random / "Semantic Collapse") → lexical + LLM screening is the durable fix, not a new embedder. All external magnitudes are 2026 preprints — **validate on our own data before claiming.**

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ftsQueryFromText()` + `CandidateRetriever.stmtBm25` (`src/retrieval/topk.ts`): the entire BM25/`node_fts` lexical path already exists and is sanitization-hardened. Phase 46 reuses it in the consolidation candidate path — no new FTS query construction from scratch.
- M1 entity-anchor block (`consolidator.ts:716-754`): the union-of-sources pattern (cosine ∪ anchors, deduped via `cosineIdSet` Set, capped per-source) is already established. BM25 is a third source slotted into the same shape.

### Established Patterns
- **Phase A sync reads before `db.transaction`** (T-02-ASYNC): candidate generation runs entirely in the pre-transaction read window. BM25 reads must follow this — sync prepared statements, never inside the txn.
- **Dark/isolation knob** (e.g. RRF `w=0`): ship-on-but-zeroable. `bm25CandidateK=0` reproduces current behavior for A/B.
- **Counters in run summary**: sleep-pass already emits a run summary; add source/fire counters there.

### Integration Points
- Insert BM25 candidate fetch immediately after the M1 anchor build (~`consolidator.ts:754`).
- Extend the `cosineGate` auto-unrelated condition (~759-762) with a `bm25.length === 0` term (D-04).
- Extend `judgeCandidates` assembly (~784-790) to append deduped BM25 candidates after anchors (D-02).
- Add `bm25CandidateK` to `EngineConfig` + defaults in `config.ts`.

</code_context>

<specifics>
## Specific Ideas

- The phase's single decisive behavioral change: a low-cosine claim with a BM25 lexical hit must reach the judge instead of being auto-classified `unrelated`. If after implementation the judge-fire counter is still 0 on LongMemEval-KU, the BM25 query/text or the gate wiring is wrong — that counter is the phase's pass/fail signal (RECON-03), not a nice-to-have.
- Keep the union **unranked** — resist the temptation to RRF-fuse candidate sources here. Ranking matters for the online retrieval path (Phase 47); for candidate-gen the judge is the ranker.

</specifics>

<deferred>
## Deferred Ideas

- **Subject-hub graph traversal** as a distinct candidate source (beyond BM25 lexical) — only if BM25 proves insufficient for RECON-03. Documented fallback, not built now.
- **DEO-style negation-aware query rewrite** for candidate generation — REQUIREMENTS.md "Future Requirements"; revisit only if candidate broadening proves insufficient.

### Reviewed Todos (not folded)
- `todos/2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` — "Cache constant judge/extraction prompt prefix via --system-prompt". Adjacent (Phase 46 increases judge-call volume, so caching the prompt prefix becomes more valuable), but it's an independent cost optimization, not a candidate-broadening decision. Note for a cost/efficiency pass; **not in Phase 46 scope.**
- `todos/content-hardening-deferred.md`, `todos/corpus-brain-3d-transition.md`, `todos/viz-search-and-hull-quality.md` — matched on the bare keyword "phase" only (false positives, unrelated to reconsolidation). Not folded.

</deferred>

---

*Phase: 46-reconsolidation-candidate-broadening*
*Context gathered: 2026-06-27*
