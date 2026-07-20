---
phase: 49-scale-data-model-spike
plan: "02"
subsystem: eval-harness
tags: [spike, scale, ANN, HNSW, crossover, benchmark, SCALE-01, D-01, D-03]
dependency_graph:
  requires: [ann_lib_provisioned]
  provides: [crossover_measurements, results_json]
  affects: [scripts/eval/49-crossover-spike.cjs]
tech_stack:
  added: []
  patterns: [Phase-41 harness fork, read-only live-brain open, jitter+renormalize corpus scale-up, byte-identical cosineSimF32 ground truth, tmpdir-copy for sqlite extension]
key_files:
  created:
    - scripts/eval/49-crossover-spike.cjs
    - scripts/eval/results/49-crossover-spike.json  # gitignored, local-only (D-06)
  modified: []
decisions:
  - "Measured BOTH ANN arms (both loaded in 49-01): hnswlib-node = PRIMARY (in-process, apples-to-apples vs in-process exact flat scan); vectorlite = SECONDARY (sqlite-extension, includes integration overhead)"
  - "Corpus scaled to {14079 live, 25k, 50k} by jitter(σ=0.05)+renormalize of REAL live embeddings, anchored on the unmodified live set (D-01) — never random vectors"
  - "Exact arm uses production cosineSimF32 as ground truth (byte-identical assertion passes Δ=0); recall@k = |ann_topk ∩ exact_topk| / k"
  - "HONESTY CAVEAT recorded: queries are drawn from real corpus vectors, so hnswlib recall@10=1.000 is self-match-inflated; vectorlite's ~0.95 is more representative of novel-query recall"
  - "rss_delta footprint is approximate (native HNSW memory is off-heap; GC noise gives a negative delta at one rung) — flagged in meta, not presented as precise"
metrics:
  duration: "~6 minutes (full sweep wall-clock 5m50s)"
  completed: "2026-06-28"
  tasks_completed: 2
  files_modified: 1
---

# Phase 49 Plan 02: SCALE-01 Crossover Benchmark — exact flat-buffer vs HNSW ANN

## What was built

`scripts/eval/49-crossover-spike.cjs` — a read-only crossover benchmark forked from the Phase-41
harness trio. It loads the live brain read-only, scales the REAL embedding distribution to
{14079 (live), 25000, 50000} nodes by jitter+renormalize (D-01), and measures the exact
flat-buffer cosine scan (production `cosineSimF32` ground truth) against two HNSW ANN arms
(`hnswlib-node` in-process, `vectorlite` sqlite-extension) at k∈{5,10}: recall vs exact,
query p50/p95, build time, and an approximate rss footprint.

## Measured results (k=10, 25 real-distribution queries, 3 repeats)

| N (nodes) | exact p50/p95 | hnswlib-node p95 · r@10 · build | vectorlite p95 · r@10 · build |
|-----------|---------------|---------------------------------|-------------------------------|
| 14,079 (live) | 18.3 / **19.5 ms** | 1.01 ms · 1.000* · 34.5 s | 0.41 ms · 0.960 · 11.7 s |
| 25,000 | 32.6 / **33.8 ms** | 1.06 ms · 1.000* · 65.6 s | 0.42 ms · 0.960 · 25.2 s |
| 50,000 | 66.8 / **67.9 ms** | 1.09 ms · 1.000* · 141.5 s | 0.42 ms · 0.944 · 54.0 s |

HNSW params: M=16, ef_construction=200, ef_search=64. `*` hnswlib recall is self-match-inflated
(queries ∈ corpus) — treat vectorlite's ~0.95 as the more realistic recall signal.

## Reading the numbers (for Plan 03's D-04 gate)

- **Exact scan is linear in N** (~1.35 ms per 1k nodes). At the real current scale (14k) the
  exact scan-only p95 is **19.5 ms** — well under the Phase-40/41 felt-path reference (≈45/46 ms).
  Exact scan-only crosses ~45 ms only around **N ≈ 33k** and is ~68 ms at 50k.
- **Both ANN arms are ~constant-time** (~1 ms hnswlib, ~0.4 ms vectorlite) with recall that would
  satisfy the ≥0.95 D-04 bar — but **build is expensive** (hnswlib 35–142 s; vectorlite 12–54 s),
  an offline cost.
- Caveat: this harness times the **scan loop only** (no embed round-trip, no DB marshal, no graph
  traversal), so it is NOT directly comparable to the full 45 ms felt path — it isolates the index's
  own contribution. The crossover where the FULL path hurts is later than the scan-only crossover.

## Read-only / honesty invariants held
- Live DB opened `{ readonly: true, fileMustExist: true }`; `meta.live_db_mtime_unchanged === true` asserted at end of run.
- vectorlite tables built on a `mkdtempSync` tmpdir sqlite copy, removed after each rung — live file never written.
- Ground-truth byte-identical to production `cosineSimF32` (asserted, Δ=0). No fabricated numbers; both libs loaded so no `unmeasured-here` fallback was triggered, but the honest fail-path remains in the harness (D-02b).

## Self-Check: PASSED
- Harness runs to exit 0; results JSON has 3 rungs with exact + ANN numbers each. ✓
- recall@5/@10, p50/p95, build_ms, rss captured at {14k, 25k, 50k} (D-03). ✓
- "Defer/no-go is valid" preserved — harness records whatever the numbers say; it does not assume ANN wins. ✓
- Results JSON under gitignored `scripts/eval/results/` (D-06); only the harness `.cjs` is committed. ✓
