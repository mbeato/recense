# Phase 47: Hybrid Retrieval Recall - Context

**Gathered:** 2026-06-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Bring **BM25 (`node_fts`) + dense cosine fusion back onto the LLM-free online retrieval hot path**, with a single config-exposed tunable fusion-weight scalar selected on held-out data, and **re-enable it in the product QA responder** — lifting LoCoMo session-level R@5/R@10 (today ~77–88%, QA is retrieval-bound) with **no per-category regression** vs pure cosine and within the hot-path latency budget (live-brain p50 ~45 ms today).

**In scope:**
- Make the BM25-list weight in the existing `rrfFuse` a config-exposed tunable scalar; pick its default by held-out selection on LoCoMo.
- Wire fusion into the product answer path (`responder → retrieveRanked`) by passing `queryText`, and into the LoCoMo eval harness (which today measures pure `topk`).
- Prove R@5/R@10 gain with a per-category no-regression gate; run with LEVER 2 temporal sort ON as the staleness guard.

**Out of scope (own phases / future):**
- z-score / score-normalized fusion — RETR-01 allowed it; **RRF chosen** (see D-01). Not building both.
- The strength-ranked third RRF list (`rankStrengthWeight`, Phase 35) — stays **dark at 0**; 47 is BM25+dense only.
- Any reranker over fused top-k — research showed it **HURT**; explicitly forbidden without separate measurement (RETR-03 note).
- Replacing the embedder, adding a new online LLM call, or any new runtime dep.
- The answer-prompt/abstention experiment (uncommitted `locomo-harness.cjs` answerer-V2 diff) — separate concern; R@K is retrieval-only and independent of the answerer.
- WASM SIMD exact-scan kernel (SCALE-03 → Phase 51); locking the regression gates (GATE → Phase 50).

</domain>

<decisions>
## Implementation Decisions

### Fusion method (RETR-01, RETR-02)
- **D-01:** Use **weighted RRF**, not z-score. Keep `rrfFuse([cosineList, bm25List], k=60, topK, weights)`. The cosine-list weight is **fixed at 1.0**; the **BM25-list weight is the single tunable scalar** (RETR-02). Rationale: already implemented, score-scale agnostic (BM25 negative-unbounded vs cosine [0,1] need no normalization), net-zero new code path. z-score's raw-magnitude blend was rejected — adds normalization + a pool-dependent failure mode for no proven gain.
- **D-02:** The scalar is a new config knob (BM25 fusion weight). `weight = 0` must reproduce **exactly today's pure-cosine** behavior (the dark/isolation-knob convention, mirrors `bm25CandidateK=0` and `rankStrengthWeight=0`) for A/B and regression isolation.

### Anti-regression guard (the 9ea5eabc lesson)
- **D-03:** Fusion runs **with LEVER 2 temporal annotation ON** (the newest-supported-first reorder already in `retrieveRanked`). The prior failure (BM25 surfaced a stale "Hawaii" trip over current "Paris") is exactly a stale-over-current ordering problem; recency reorder + the temporal-reasoning category catch it. **No new mechanism** invented for this.
- **D-04:** The **held-out per-category R@K no-regression check is the hard gate** (RETR-03). The shipped weight default is only valid if no LoCoMo category regresses vs pure cosine on the held-out test set. This is the structural defense against repeating 9ea5eabc, not a hand-picked weight ceiling.

### Held-out tuning (RETR-02)
- **D-05:** **Deterministic tune/test split** of LoCoMo conversations. Grid-sweep the BM25 weight on the **tune** set; lock `w* = argmax(R@5)` subject to the D-04 no-per-category-regression constraint; report R@5/R@10 + per-category **on the held-out test set only**. Prevents overfitting the shipped default. (Planner/researcher decide the exact split partition + grid points.)
- **D-06:** The weight sweep is **LLM-free and cheap** — R@K is computed from retrieved node-ids vs gold node-ids, no answer generation needed. Only end-to-end QA accuracy (if reported) is LLM-billed; tuning the scalar is not.

### Ship posture & scope
- **D-07:** **Enable in the product responder now.** Pass `queryForEmbed`/`queryText` through `responder.respond → retrieval.retrieveRanked(cueVec, k, floor, queryText)` so the live QA path uses hybrid fusion immediately, with `w*` as the default. The held-out + per-category gate (D-04) de-risks the 9ea5eabc repeat; the `w=0` knob (D-02) remains the instant fallback. Not shipping dark — the phase's point is lifting *live* recall.
- **D-08:** Update the **LoCoMo eval harness** to add a hybrid retrieval arm (it currently calls pure `evalRetriever.topk`, line ~464) so RETR-03 is actually measurable; the harness must exercise the same fusion+temporal path the responder uses.

### Hard invariants to preserve (guardrails for the planner — not decisions)
- **LLM-free hot path** (hard constraint): no API call introduced in retrieval. The Q→declarative rewrite already in `respond()` (LEVER 3) is the *only* existing pre-retrieval LLM call and is unchanged.
- Hot-path latency stays within budget (RETR-04); fusion is rank-math over already-fetched candidate lists — no extra scans beyond the existing BM25 `MATCH`.
- `ftsQueryFromText()` sanitization is MANDATORY before any `MATCH` (T-17-02-T); FTS-absent path falls back to cosine-only gracefully (already handled in `hybridTopk`).
- Graph = source of truth, vector = derived cache; no evidence-backed node deleted by decay; no inferred output strengthens a fact (self-confirmation guard); net-zero new runtime deps.
- `queryText` must be user/question-derived, never LLM output (T-04-03-I) — the responder feeds `queryForEmbed` (user-derived, possibly LEVER-3-rewritten) which satisfies this.

### Claude's Discretion
- Exact config-knob name + placement beside `bm25CandidateK` / `rankStrengthWeight` / `rankedRetrievalFloor` in `config.ts` (~lines 785–807).
- Exact tune/test partition strategy and grid points for the weight sweep (D-05).
- Whether the responder passes the raw bounded question or the LEVER-3-rewritten `queryForEmbed` as `queryText` (both are user-derived; pick what measures better).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap (the WHAT — locked)
- `.planning/REQUIREMENTS.md` §RETR (RETR-01..04) — BM25+dense fusion on LLM-free hot path, single tunable scalar via held-out selection, R@5/R@10 gain with no per-category regression, latency budget, no reranker. Also §"Out of Scope".
- `.planning/ROADMAP.md` line 186 (Phase 47 goal) + line 183 (engine invariants across all phases).

### Retrieval hot path — the code being changed
- `src/retrieval/topk.ts` — `hybridTopk()` (line ~444, the RRF fusion path, already wires cosine+BM25[+strength]), `rrfFuse()` (line ~239, weighted, k=60 — the D-01/D-02 edit site for the tunable BM25 weight), `ftsQueryFromText()` (line ~226, MANDATORY MATCH sanitizer), `CandidateRetriever.stmtBm25` (line ~301).
- `src/retrieval/engine.ts` — `retrieveRanked()` (line ~388, routes through `hybridTopk` when `queryText` supplied; LEVER 1 fusion + LEVER 2 temporal sort at ~456 + floor gate + B2 stale-entity filter). This is where the responder's `queryText` flows in (D-07).
- `src/responder/index.ts` — `respond()` facts-first call to `retrieveRanked` (line ~191, **currently NO queryText → pure cosine**; the D-07 edit site). Lines 186–190 document the 9ea5eabc regression that disabled BM25 here.

### Config knobs
- `src/lib/config.ts` — `bm25CandidateK` (~258/785), `rankStrengthWeight` (~342/794, dark at 0 — KEEP dark, out of scope), `rankedRetrievalK`/`rankedRetrievalFloor` (~394/806–807). Add the new BM25 fusion-weight knob beside these (D-02).

### Eval harness
- `scripts/eval/locomo-harness.cjs` — `evalRetriever.topk(queryVec, TOP_K)` (line ~464, pure-cosine retrieval; the D-08 edit site for the hybrid arm), R@5/R@10 computation (~500–501 via `retrievedSessionsForIds`). NOTE: the uncommitted working-tree diff here is an answerer-V2 prompt experiment (abstention) — OUT of scope for 47, do not entangle.

### Prior-phase grounding
- `.planning/phases/46-reconsolidation-candidate-broadening/46-CONTEXT.md` — the *offline* BM25 union counterpart; D-01/D-02 there explicitly keep candidate-gen UNRANKED and defer online RRF fusion to "Phase 47 (RETR)". Confirms the seam.
- Research grounding (REQUIREMENTS.md §RETR note + Phase 17 origin): dense cosine alone is retrieval-bound; lexical fusion lifts recall, but an off-the-shelf reranker over fused top-k HURT — measure before adding anything beyond weighted RRF. External magnitudes are 2026 preprints — validate on our own LoCoMo data before claiming.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **The entire fusion stack already exists** (Phase 17 LEVER 1): `hybridTopk` (cosine+BM25 RRF), `rrfFuse` (weighted), `ftsQueryFromText` (sanitized), `node_fts` FTS5 table, `stmtBm25`. Phase 47 makes the BM25 weight tunable + flips the responder switch ON — it does NOT build fusion from scratch. SCHEMA_VERSION unchanged.
- **LEVER 2 temporal sort** is already inside `retrieveRanked` (newest-supported-first reorder, orphan-safe) — D-03 just keeps it ON when fusion is on.
- **Dark/isolation-knob convention** (`bm25CandidateK=0`, `rankStrengthWeight=0`, `insightSurfacingEnabled=false`): D-02's `weight=0` reproduces pure cosine, following the established A/B pattern.

### Established Patterns
- `retrieveRanked` already handles the RRF-vs-cosine ordering difference (RRF interleaves → `continue` past below-floor; pure cosine sorted → `break`). The hybrid floor-gate path is built.
- BM25-only hits carry `score=0` and fail the 0.3 product floor by design; the eval arm uses no floor to let all fused results through (already implemented in `retrieveRanked` / harness).

### Integration Points
- `responder/index.ts:191` — add the `queryText` 4th arg (D-07).
- `rrfFuse` weights array (`topk.ts` ~487/494) — thread the new config scalar as the BM25-list weight (D-01/D-02).
- `config.ts` — add the fusion-weight knob to `EngineConfig` + defaults (D-02).
- `locomo-harness.cjs:464` — add hybrid retrieval arm + per-category R@K reporting (D-08).

</code_context>

<specifics>
## Specific Ideas

- The decisive pass/fail signal is **held-out test R@5/R@10 up with zero per-category regression** vs the pure-cosine baseline (D-04). If any category regresses, the weight is wrong or temporal sort isn't compensating — that gate, not vibes, decides the shipped default.
- Do NOT reintroduce the 9ea5eabc failure mode: a BM25 lexical match must not float a stale fact above the current one. Temporal sort ON (D-03) + per-category gate (D-04) is the structural answer; verify specifically on the temporal-reasoning category.
- Resist scope creep into z-score, a reranker, or the strength list — all explicitly deferred/forbidden.

</specifics>

<deferred>
## Deferred Ideas

- **z-score / score-normalized weighted fusion** — RETR-01 permitted it; RRF chosen (D-01). Revisit only if weighted RRF underperforms on held-out.
- **Strength-ranked third RRF list** (`rankStrengthWeight`, Phase 35) — stays dark at 0; folding it into the online ranking is its own tuning exercise, not 47.
- **Reranker over fused top-k** — research showed it hurt; only with separate measurement (Future Requirements).
- **DEO-style negation-aware query rewrite** — REQUIREMENTS.md Future Requirements; revisit if fusion recall proves insufficient.
- **Answerer-V2 / abstention prompt** (uncommitted harness diff) — separate answer-quality concern; track independently of retrieval recall.

### Reviewed Todos (not folded)
- `todos/content-hardening-deferred.md`, `todos/corpus-brain-3d-transition.md`, `todos/viz-search-and-hull-quality.md` — matched only on bare keywords "phase"/"brain" (false positives, unrelated to retrieval). Not folded.
- `todos/2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` — judge/extraction prompt-prefix caching; a cost optimization on the offline sleep pass, unrelated to the online retrieval hot path. Not folded.

</deferred>

---

*Phase: 47-hybrid-retrieval-recall*
*Context gathered: 2026-06-28*
