# Requirements — Milestone v9.0 Memory Quality

**Goal:** Make recense's belief-correction and retrieval work on messy real-world data (not just clean cases) and lock the gains behind regression gates, validated on LoCoMo / LongMemEval-KU / EVAL-02.

**Grounding:** June-2026 deep-research pass (8 verified findings) + ARCH-REVIEW + the load-bearing 999.2 root cause. All external magnitudes (+11.2pp recall, judge-fires) are 2026 arXiv preprints / vendor-self-reported — **validate on our own data before claiming**. Memory quality is the leading priority; cost is secondary.

---

## v9.0 Requirements

### RECON — Reconsolidation candidate broadening (resolves backlog 999.2)

> Problem: the PE-gated reconsolidation judge fires **zero** on-topic contradictions on LongMemEval-KU — real contradicting facts embed at cosine ~0.48 and never clear the 0.7 escalation gate, so KU "correctness" comes from extraction + recency, NOT the differentiating belief-update mechanism. Research confirms this is structural (dense cosine cannot separate contradictions). Fix: decouple candidate generation from the cosine gate.

- [ ] **RECON-01**: For each new fact, contradiction-candidate generation produces a **union** of (a) entity/subject-keyed graph lookup, (b) BM25 lexical (reuse `node_fts` FTS5), (c) dense top-k — not the cosine gate alone.
- [ ] **RECON-02**: The union candidate set is fed to the existing Sonnet judge for ADD/UPDATE/contradict screening, preserving existing tombstone + provenance + self-confirmation guards.
- [ ] **RECON-03**: On LongMemEval-KU, the reconsolidation judge **fires on real contradictions** (>0, ideally majority of true-contradiction cases) — measurable via the escalation/judge counters.
- [ ] **RECON-04**: KU belief-correction improves measurably vs the extraction+recency-only baseline AND EVAL-02 clean-case belief-correction holds (no regression); load-bearing invariants intact (no self-confirmation, no evidence-backed decay-delete).

### RETR — Hybrid retrieval recall (online hot path)

> Problem: session-level R@5 ~77–88% on LoCoMo; QA is retrieval-bound.

- [x] **RETR-01**: Online retrieval fuses BM25 (`node_fts`) + dense via RRF or z-score-normalized weighted score, on the **LLM-free** hot path (hard constraint).
- [x] **RETR-02**: The fusion weight is a single tunable scalar (config-exposed), defaulted via held-out selection.
- [ ] **RETR-03**: R@5/R@10 improve on LoCoMo with no per-category regression vs pure-cosine. (Note: an off-the-shelf reranker over fused top-k HURT in the research — do NOT add a reranker without measuring.)
- [x] **RETR-04**: Hot-path retrieval latency stays within budget (live-brain p50 ~45 ms today); no online LLM calls introduced.

### HARD — Correctness hardening (from ARCH-REVIEW)

- [x] **HARD-01**: Close the C-2 self-confirmation loop — assistant output entering as `origin:'observed'` must not strengthen a fact without a judge (upholds the never-let-inferred-output-strengthen invariant).
- [x] **HARD-02**: All write transactions use `db.transaction().immediate()` (consolidator Phase B, `txUpsertNode`) so a lost upgrade race no longer aborts the whole sleep pass on `SQLITE_BUSY_SNAPSHOT`.
- [x] **HARD-03**: `initSchema` reads the stored `SCHEMA_VERSION` first and throws on `stored > compile-time` (no silent re-stamp by a stale binary).
- [x] **HARD-04**: Embedding model + dims are stamped in meta at first embed and asserted on write/decode (a dims/model change fails closed instead of silently producing NaN cosines).

### SCALE — Scale + data-model spike (spike-first; may conclude "defer")

- [x] **SCALE-01**: Measure a vectorlite (HNSW, npm-loadable) vs brute-force O(N) cosine recall/latency crossover at recense's actual node scale (~10–50k); produce a go/no-go. (Approximate ANN remains out-of-scope until exact-index latency measurably hurts — this requirement is to *measure*, not adopt.) — **DONE (Phase 49): NO-GO on ANN.** Exact scan p95 19.5 ms @14k (under budget); crossover ~33k. Held-out HNSW is recall-exact at ef≥256 but adds a native dep + index lifecycle; pure-JS fast-exact failed (int8 no speedup, dim-reduce kills recall to 0.73). **WASM SIMD f32x4 exact scan measured 4.9× faster at recall@10=1.000, portable** → adopt that instead (SCALE-03). Findings: `phases/49-scale-data-model-spike/49-SPIKE-FINDINGS.md`.
- [x] **SCALE-02**: Written recommendation on Zep-style bi-temporal validity intervals and/or DCPM-style doubly-linked supersedes chains vs the current tombstone reconsolidation, with better-sqlite3 migration cost. — **DONE (Phase 49): DEFER, keep tombstone-always.** No current forcing function; additive nullable columns are O(1), backfill/constraints force full `node_v*` recreation. Prefer additive supersedes-chain columns first if ever needed.
- [ ] **SCALE-03**: Replace the scalar-JS exact cosine scan on the retrieval hot path with a portable **WASM SIMD (f32x4) dot-product kernel** (prebuilt `.wasm`, no node-gyp / native build) — byte-exact (recall@10=1.000), ~4–5× faster scan; fold reciprocal-norm into the kernel + partial-select top-k to realize the full speedup end-to-end. Born from the Phase-49 spike (`49-wasm-simd-probe.cjs`). Defers ANN to a six-figure-node future trigger.

### GATE — Verification + regression gates (discharges deferred Phase 43)

- [ ] **GATE-01**: An automated regression gate (CI / pre-merge) runs the eval harness and blocks merges that regress below baseline.
- [ ] **GATE-02**: Thresholds cover accuracy + latency + token axes AND belief-correction (EVAL-02) + retrieval recall (R@K).
- [ ] **GATE-03**: Baseline = v9.0-final figures (intentional re-baseline); the full suite is re-run with documented before/after deltas, the Phase-1 judge-fires claim is proven, and `docs/evals.md` is updated with the new numbers + judge-validation evidence.

---

## Future Requirements (deferred)

- **Approximate ANN build** — only if SCALE-01 shows exact-index/brute-force latency measurably hurts at the real corpus size.
- **Graph-guided iterative ("active reconstruction") retrieval** (MRAgent-style, +23% LoCoMo) — LLM-in-loop; violates the LLM-free hot path; viable only in the offline sleep pass or as an optional mode.
- **BEAM benchmark (ICLR 2026)** — 10M-token conversations, currently unsaturated; a later target once v9.0 lands.
- **DEO-style query-embedding optimization for negation** — training-free negation-aware query rewrite; revisit if RECON candidate broadening proves insufficient.

## Out of Scope

- **Replacing text-embedding-3-small to "fix" contradictions** — research shows no encoder (BGE-M3/e5/large) separates negation (NevIR near-random); the durable answer is lexical + LLM screening, not a new embedder.
- **Multi-tenancy / many-user hosting** — engine stays single-tenant (instance-per-user via server mode); namespace multi-tenancy is SEED-003, not v9.0.
- **Model weight training / LoRA** — learning lives in the substrate, not the model (v3 via seams).

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| RECON-01 | Phase 46 | Pending |
| RECON-02 | Phase 46 | Pending |
| RECON-03 | Phase 46 | Pending |
| RECON-04 | Phase 46 | Pending |
| RETR-01 | Phase 47 | Complete |
| RETR-02 | Phase 47 | Complete |
| RETR-03 | Phase 47 | Pending |
| RETR-04 | Phase 47 | Complete |
| HARD-01 | Phase 48 | Complete |
| HARD-02 | Phase 48 | Complete |
| HARD-03 | Phase 48 | Complete |
| HARD-04 | Phase 48 | Complete |
| SCALE-01 | Phase 49 | Pending |
| SCALE-02 | Phase 49 | Pending |
| GATE-01 | Phase 50 | Pending |
| GATE-02 | Phase 50 | Pending |
| GATE-03 | Phase 50 | Pending |
