# Phase 41: Vector Index + Hot-Path Latency - Context

**Gathered:** 2026-06-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the brute-force O(N) cosine scan on the hot recall path with a derived, rebuildable vector index, and profile/optimize the latency-critical **online** surfaces (recall + SessionStart inject). The live brain is 7000+ nodes — past the ~5K comfort zone for brute-force — so this is the headline latency lever.

The brute-force scan lives in `src/retrieval/topk.ts` (`CandidateRetriever.topk` / `hybridTopk` / `topkTombstoned`): each query loads every embedded live node into JS and computes cosine in a tight loop. The index replaces only the **cosine list** — BM25 already uses an FTS5 index; the strength list + RRF fusion stay in JS. The floor gate (0.3) and `hybridTopk`'s preK fetch both depend on real cosine **scores** coming back, so any index MUST return real cosine scores.

**In scope:** vector index replacing brute-force cosine on the online hot path (PERF-01); recall + SessionStart-inject latency profiled and measurably improved vs the Phase 40 baseline (PERF-02); no accuracy regression on the harness (PERF-03).

**Out of scope (own phases):** token/cost efficiency + progressive disclosure (Phase 42), CI regression gates (Phase 43). True approximate ANN / HNSW is **deferred until N demands it** (see decisions), not a separate phase.

**Engine invariants carried forward (Phase 40 / PROJECT.md):** index is a **derived cache** (graph stays source of truth; vector is rebuildable, never authoritative); the online path stays **LLM-free**; **a latency win that costs accuracy is rejected** (PERF-03 is a hard gate); success is measured **relative to the Phase 40 baseline** (D-06 latency-vs-N curve, D-10 frozen v7.0 config).
</domain>

<decisions>
## Implementation Decisions

### Accuracy posture (PERF-01 / PERF-03)
- **D-01:** **Exact now, ANN seam later.** Use an exact KNN index (byte-equivalent cosine, just out of the JS loop) — results match brute-force, so PERF-03 "no accuracy regression" is satisfied **by construction** (no recall@k tolerance to argue). True approximate ANN (HNSW) is **deferred** — it only pays off at much larger N (50K+) and would introduce an approximation the hard accuracy gate must defend. At 7K nodes it is premature.
- **D-02 (seam):** Keep the HNSW-later seam **implicit** — keep `CandidateRetriever.topk` / `hybridTopk` signatures stable and put the exact index behind them, as the existing seam already anticipates (`topk.ts:7` — *"Seam: swap to sqlite-vec/HNSW only when measured latency hurts"*). **No new VectorIndex interface / abstraction now** — HNSW drops in by swapping the implementation when N demands it. Simplicity-first; no speculative structure.

### Approach & dependency (the net-zero-deps question)
- **D-03:** **Spike to decide the mechanism** before committing it in the plan. Two exact candidates:
  - **(a) Zero-dep in-memory/persisted contiguous-buffer exact scan** — load all embeddings once into one flat `Float32Array` + precomputed norms, scan the flat buffer. This **is** the derived/rebuildable index (PERF-01) with **zero new deps and zero deployment change**, byte-exact. Kills the current per-query cost of re-marshaling 7K SQLite rows + allocating 7K `Float32Array` views.
  - **(b) sqlite-vec loadable extension** — exact KNN in C/SIMD, persisted on-disk (`vec0` virtual table), scans inside SQLite without marshaling rows to JS. Breaks the net-zero streak; adds per-platform binary shipping on the macOS+Linux CI matrix.
- **D-04 (tie-break):** **Prefer zero-dep unless it fails the PERF-02 bar.** If the zero-dep cache clears PERF-02 (measurably better p50/p95 vs baseline) with comfortable margin → ship it, keep net-zero deps. Escalate to sqlite-vec **only** if JS can't clear the bar. (HNSW/hnswlib is off the table for this phase per D-01.)

### Freshness / rebuild contract (PERF-01 derived-cache semantics)
- **D-05:** **Index reflects the last completed sleep pass.** Embeddings are written ONLY in the offline sleep pass (`setEmbedding`); the online path is strictly read-only on them (D-43). The index is **built/refreshed at the end of each sleep pass** and may lag until the next pass — which is correct, since online activity never changes embeddings. All build cost stays **offline** (matches the standing constraint that the hot path only reads).
- **D-06 (consequence — persistence required):** Because cold processes (SessionStart inject, `recall-cli`) must read a **ready** index rather than rebuild one, the index MUST be **persisted** (sqlite-vec's on-disk `vec0` table, or a serialized flat-buffer sidecar for the JS path). The persistence mechanism is part of what the D-03 spike compares.

### Scope (which scans switch off brute-force)
- **D-07:** **Online hot path only.** The index serves online recall + SessionStart inject + the tombstoned 'deleted' scan on that path (`topkTombstoned`). The **offline consolidator KEEPS brute-force** — it runs mid-sleep-pass on embeddings it is actively writing, *before* the end-of-pass index exists (D-05), and it is not latency-critical. This avoids a mid-pass index-staleness trap.

### Success bars
- **D-08 (PERF-02):** Bar = p50/p95 **strictly below the Phase 40 baseline beyond run-to-run noise**. Report **cold SessionStart-inject wall-clock** as the headline felt number (the hook blocks the user every session), but **do NOT pre-commit a hard ms SLA** before the baseline is known. Set a soft target once the numbers are in.
- **D-09 (spike measurement basis):** Measure **both** cold end-to-end wall-clock (process spawn + index load/attach + scan — the real felt path for hook/CLI) **and** warm scan-only (in-process — the path for `serve`/`mcp`), weighting the decision toward whichever matches each live surface. Cold measurement is what exposes whether an in-memory cache must be persisted (D-06) to actually help.
- **D-10 (PERF-03):** Bar = **top-k SET identical** to brute-force (tolerating reordering only within identical-score float ties), gated on **all three harnesses**: LongMemEval-S, KU replay, LOCOMO, end-to-end accuracy unchanged. Because the index is exact (D-01), this is cheap to assert — a direct `index.topk == bruteforce.topk` equivalence check over a query set, separate from re-running the full expensive eval.

### Claude's Discretion (planner / researcher / spike resolve)
- Exact persistence artifact (sqlite-vec `vec0` on-disk vs serialized flat-buffer sidecar) — decided by the D-03 spike output.
- Whether the online tombstoned 'deleted' scan needs the index or its set is small enough to leave as-is — profile during the spike (D-07 includes it in scope but it's the smaller set).
- Exact instrumentation harness for the spike (reuse the Phase 40 latency-vs-N tooling / `instrumentTopkResults` tap).
- Float sum-order tie differences between C/SIMD and JS cosine — treated as no-regression under D-10's "± tie reorder" allowance.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition & milestone discipline
- `.planning/ROADMAP.md` §"Phase 41: Vector Index + Hot-Path Latency" — goal, PERF-01/02/03, success criteria; index-as-derived-cache + LLM-free-online invariants.
- `.planning/ROADMAP.md` §"Phase Details — v8.0 Performance, Efficiency & Competitive Parity" — engine invariants, baseline-first discipline, dependency shape 40 → {41,42} → 43 (41 independent of 42).
- `.planning/phases/40-competitive-benchmark-baseline/40-CONTEXT.md` — the baseline this phase measures against: D-06 (live p50/p95 + reproducible latency-vs-N curve), D-10 (frozen v7.0 commit + serialized config snapshot), D-07 (token surface). PERF-02/03 are defined *relative to* these numbers.

### The brute-force surface being replaced (primary edit targets)
- `src/retrieval/topk.ts` — `CandidateRetriever`: `topk` (brute-force cosine, the O(N) scan), `hybridTopk` (BM25+cosine RRF — index replaces the cosine list only; preK fetch + score-return contract), `topkTombstoned` (the 'deleted' scan), `cosineSimF32`, `rrfFuse`. Line 7 is the explicit seam comment (D-02).
- `src/retrieval/engine.ts` — `retrieveRanked` (floor gate at the cosine score, ~line 388), and `retrieve`/`retrieveCueless` (D-29 deleted/unreachable classification + the `topkTombstoned` second scan, ~lines 538/551; the SessionStart-inject budget logic depends on these — **do not alter their behavior**).
- `src/lib/config.ts` — `candidateK` (5), `rankStrengthWeight` (0, dark), `lambda`, recall floor knobs — the params the index path must preserve.

### Online cold-process hot-path surfaces (the latency targets)
- `src/adapter/session-start-cli.ts` — SessionStart inject (cold process; headline felt-latency number per D-08).
- `src/adapter/recall-cli.ts` — `recall` CLI (cold process).
- `src/adapter/ambient-recall.ts` — cue-less ambient recall (no-fusion `topk` path).

### Accuracy + latency harnesses (PERF-02/03 gates)
- `scripts/eval/longmemeval-harness.cjs` — end-to-end harness with the `instrumentTopkResults` top-k tap (reuse for both the D-10 top-k equivalence check and D-09 latency instrumentation).
- `scripts/eval/replay-ku-harness.cjs` — KU replay (cached-extraction, cheap re-run).
- `scripts/eval/locomo-harness.cjs` + `scripts/eval/locomo-scorer.cjs` + `scripts/eval/locomo10.json` — LOCOMO harness/dataset (built in Phase 40).
- `scripts/eval/results/` — Phase 40 baseline result JSONs (the comparison anchor for PERF-02).

### Engine invariants
- `CLAUDE.md` (project) §Constraints — online paths LLM-free + fast; all cost in the offline sleep pass; graph source of truth / vector derived cache; net-zero-new-runtime-deps tradition (the D-03/D-04 dependency tension).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `CandidateRetriever` (`topk.ts`): already the single seam for the cosine scan; index integrates behind its existing methods (D-02). `cosineSimF32` is the exact reference the equivalence check (D-10) compares against.
- Phase 40 latency/top-k instrumentation (`instrumentTopkResults` tap, latency-vs-N curve tooling): reuse directly for the spike (D-09) and the PERF-02/03 gates.
- The eval suite (longmemeval / KU replay / LOCOMO) already runs the full retrieval path — gate PERF-03 by re-running these, plus a cheap direct `index.topk == bruteforce.topk` equivalence assertion (D-10).

### Established Patterns
- Online path is strictly read-only on embeddings; all embedding writes happen in the offline sleep pass — this is what makes the D-05 "rebuild at sleep-pass end" contract correct and keeps all build cost offline.
- `hybridTopk` fuses cosine (to be indexed) with FTS5 BM25 (already indexed) + strength via RRF — the index must return **cosine scores** so the floor gate and the score map keep working; it changes which scan produces the cosine list, nothing downstream.
- Cold CLI/hook processes (SessionStart, `recall-cli`) re-read all rows per invocation today — this is why persistence (D-06), not just an in-memory cache, is required to help the named latency surfaces.

### Integration Points
- Index build/persist hooks into the **end of the sleep pass / consolidation** (offline), not any online write path.
- The exact mechanism (zero-dep flat-buffer sidecar vs sqlite-vec `vec0` extension) is decided by the D-03 spike; both persist on-disk and both are read by the online `CandidateRetriever`.
- The offline consolidator's `topk` use stays on brute-force (D-07) — it must NOT be repointed at the end-of-pass index.
</code_context>

<specifics>
## Specific Ideas

- The spike is the load-bearing artifact of this phase (D-03/D-04/D-09): it measures the zero-dep in-memory/persisted exact scan against the sqlite-vec extension on the **live ~7000-node brain**, reporting both cold end-to-end wall-clock and warm scan-only, and resolves the dependency question on real numbers — consistent with the founder's measured-not-on-faith / baseline-first discipline (cited in Phases 40 and 42).
- Net-zero-new-runtime-deps has been a touted property of every milestone to date; this is the first phase that pressures it. The default (D-04) protects the streak unless the numbers force the dep.
- Honest framing for the write-up: PERF-02 reported as a delta vs the committed Phase 40 baseline with the cold SessionStart-inject wall-clock as the felt headline; PERF-03 as an exact top-k equivalence (no accuracy traded for latency).
</specifics>

<deferred>
## Deferred Ideas

- **Approximate ANN / HNSW (hnswlib)** — deferred until the brain grows past where exact-linear scan hurts (50K+ nodes). Drops in behind the implicit seam (D-02) by swapping the implementation; no re-plumbing of the recall path. Not a separate planned phase — a posture.
- **Indexing the offline consolidator's `topk`** — out of scope this phase (D-07); revisit only if offline consolidation latency ever becomes a concern (it isn't latency-critical and has a mid-pass freshness conflict).

### Reviewed Todos (not folded)
None — the todo list was empty at discussion time; discussion stayed within phase scope.
</deferred>

---

*Phase: 41-vector-index-and-hot-path-latency*
*Context gathered: 2026-06-23*
