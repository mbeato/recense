---
phase: 41-vector-index-and-hot-path-latency
plan: 01
artifact: SPIKE-FINDINGS
requirement: [PERF-01, PERF-02]
sut_commit: f7631e9
date: 2026-06-24
harness: scripts/eval/41-index-spike.cjs
results: scripts/eval/results/41-index-spike.json (gitignored, local-only)
coldref: scripts/eval/results/41-index-spike-coldref-mock.json (gitignored, local-only)
---

# Phase 41 Mechanism Spike — Findings

Resolves D-03/D-04/D-09 on REAL numbers from the live brain **before** Plan 41-02
commits the index mechanism. Two exact candidates were measured against the brute-force
baseline at k=10 over the live `recense.db` (**10,192 embedded live nodes**, ~11.3k total),
read-only. sqlite-vec was the third candidate but was **not loadable on this machine**
(module not installed) and is recorded as unmeasured-here.

The live-brain warm baseline that PERF-02 gates against is the **Phase 40 number: 45/46 ms**
(`live-latency.cjs`, same query set). This spike reproduces it (47/49 ms — within run-to-run
noise) and adds the COLD felt-path measurement that Phase 40 never took.

---

## 1. Measured latency (p50 / p95, k=10, live brain)

Two embed conditions are reported because they isolate two different signals:

- **Real-embed run** (`41-index-spike.json`): each COLD subprocess re-embeds its query via
  the OpenAI API, so the cold cells include the embed network round-trip. This is realistic
  for the felt path but its variance **swamps the index delta** (baseline vs zero-dep cold
  differ by less than the embed jitter). Use it for WARM; treat its cold delta as noise-bound.
- **Mock-embed cold reference** (`41-index-spike-coldref-mock.json`): identical harness with
  zero-API seeded query vectors, so the COLD cells reflect **spawn + open 172 MB DB + marshal
  ~10k embedding rows + build/scan** with NO embed-network confound. This is the honest
  isolation of the index's cold contribution.

| Mechanism  | Mode | p50 (ms) | p95 (ms) | Source |
|------------|------|----------|----------|--------|
| baseline (brute-force) | warm | **47** | **49** | real-embed |
| zero-dep (flat buffer) | warm | **13** | **14** | real-embed |
| baseline (brute-force) | cold | 171 | 182 | mock-cold-ref (embed-isolated) |
| zero-dep (flat buffer) | cold | 191 | 208 | mock-cold-ref (embed-isolated) |
| baseline (brute-force) | cold (w/ real embed) | 404 | 621 | real-embed (network-bound) |
| zero-dep (flat buffer) | cold (w/ real embed) | 419 | 775 | real-embed (network-bound) |
| sqlite-vec | warm/cold | — | — | **unavailable** (module not installed) |

Flat-index from-scratch build cost: **~50 ms** for 10,192 vectors × 1536 dims.

## 2. Deltas

**vs the brute-force baseline (this spike, same run):**
- WARM: zero-dep **13/14 ms vs 47/49 ms** → **~3.6× faster**, −34 ms p50, −35 ms p95. Clean win.
- COLD (embed-isolated): zero-dep **191/208 ms vs 171/182 ms** → **~20 ms SLOWER**. The
  from-scratch flat-buffer build adds cost on top of the row-marshaling that both mechanisms
  already pay; nothing is saved cold because the buffer is thrown away when the process exits.

**vs the committed Phase 40 warm baseline (45/46 ms):**
- zero-dep warm **13/14 ms** beats it by **~32/32 ms** (≈3.4×). Comfortably clears the PERF-02
  bar (strictly below baseline beyond run-to-run noise — D-08).
- baseline warm here (47/49 ms) reproduces Phase 40 (45/46 ms) within noise — the harness is
  measuring the same thing.

## 3. Top-k SET equivalence (PERF-03 / D-10)

| Comparison | Result |
|------------|--------|
| zero-dep WARM vs brute-force | **20/20 queries set-identical** |
| zero-dep COLD vs brute-force | **20/20 queries set-identical** |
| sqlite-vec vs brute-force | unavailable |

Set-equivalence is order-independent, so identical-score float-tie reorder is tolerated
automatically (D-10's "± tie reorder" allowance). The zero-dep path is **byte-exact** to the
brute-force cosine — it computes the same `dot / (||q|| · ||row||)`, just over one contiguous
`Float32Array` with precomputed row norms instead of re-decoding a `Float32Array` view per row
per query. No approximation is introduced (D-01), so PERF-03 is satisfied **by construction**.

## 4. The cold-path finding (load-bearing — D-06)

The embed-isolated cold numbers confirm exactly what D-06 predicted: **an in-memory flat
buffer does not help the cold felt path (SessionStart-inject, recall-cli) unless it is
persisted.** A fresh process's ~170 ms cold floor is dominated by process spawn + opening the
172 MB SQLite file + marshaling ~10k embedding rows out of SQLite — and building the flat
buffer from scratch on top of that makes zero-dep ~20 ms *slower* cold than brute-force.

The WARM win (in-process `serve`/`mcp`) is real and large because the buffer is built once and
reused. The COLD win only materializes when the cold process **reads a pre-built persisted
sidecar** instead of re-marshaling rows — i.e. it skips the row-marshaling that is the cold
floor. The from-scratch cold number measured here is the **upper bound** on the persisted cold
path (a persisted read is strictly cheaper than rebuild-from-rows); Plan 41-02 must implement
persistence (D-06) for the cold surfaces to benefit at all.

## 5. Decision

Decision: **Ship the zero-dep contiguous flat-`Float32Array` exact index** (D-03(a)) behind the
existing `CandidateRetriever` seam; do **NOT** introduce sqlite-vec. Rationale (D-04 tie-break):
the zero-dep path clears the PERF-02 bar with comfortable margin on the WARM in-process surface
(**13/14 ms vs the 45/46 ms Phase-40 baseline, ~3.4×**), is **byte-exact** to brute-force
(20/20 top-k set-identical, so PERF-03 holds by construction), and keeps the **net-zero-new-
runtime-deps** streak intact. sqlite-vec was the escalation option *only if* JS could not clear
the bar — JS clears it decisively, and sqlite-vec was not even loadable here (no installed
binary), so escalating would add per-platform native-binary shipping on the macOS+Linux CI
matrix for no measured benefit. HNSW/ANN stays deferred (D-01 — premature at 10k nodes).

**Persistence artifact (D-06):** a **serialized flat-buffer sidecar** — the contiguous
`Float32Array` (rows × 1536 f32) + a parallel `Float64Array` of precomputed row norms + the
id array, written to disk at the **end of each sleep pass** (D-05) and memory-mapped / read by
the online `CandidateRetriever`. This is what lets the COLD surfaces (SessionStart-inject,
recall-cli) skip the ~170 ms row-marshaling floor; without it only the warm in-process path
(`serve`/`mcp`) benefits. The sidecar is a derived cache — graph stays source of truth,
rebuildable from `node.embedding` at any time.

**Tombstoned-scan verdict (`topkTombstoned`, D-07 / Claude's-discretion):** leave it on
brute-force for now — **do not build it a second index.** The tombstoned 'deleted'-scan set is
the small minority of nodes (tombstoned rows only) versus the ~10k live set the main scan
covers; its brute-force cost is a small fraction of the 47 ms live scan and it runs only on the
deleted-classification path, not every recall. Indexing it would add a second persisted sidecar
and a second end-of-pass build for marginal gain. Revisit only if the tombstoned set grows
large enough to show up in profiling.

## 6. What Plan 41-02 consumes

- Mechanism: zero-dep flat-buffer exact scan behind `CandidateRetriever.topk`/`hybridTopk`
  (signatures unchanged — D-02 implicit seam). Must return **real cosine scores** (the floor
  gate at 0.3 and `hybridTopk`'s cosine score map depend on them).
- Persistence: serialized flat-buffer sidecar, built at end-of-sleep-pass (offline), read
  by the online cold processes. This is the piece that delivers the COLD win.
- Out of scope for the index: `topkTombstoned` (stays brute-force) and the offline
  consolidator's `topk` (stays brute-force — mid-pass, before the end-of-pass index exists, D-07).
- Gate (Plan 41-03): the 20/20 top-k equivalence asserted here must hold under the persisted
  implementation, plus the 3-harness no-regression (LongMemEval / KU / LOCOMO).

---

*Real numbers, live brain, read-only. No writes to `~/.config/recense/recense.db` occurred
(opened `readonly:true, fileMustExist:true`; sqlite-vec path would have used a tmpdir copy).*
