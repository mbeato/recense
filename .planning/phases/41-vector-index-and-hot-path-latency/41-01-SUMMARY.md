---
phase: 41-vector-index-and-hot-path-latency
plan: 01
subsystem: retrieval
tags: [spike, latency, vector-index, perf]
requires:
  - "Phase 40 baseline (live warm 45/46 ms, ~11.3k nodes)"
  - "dist/src/retrieval/topk.js (CandidateRetriever, cosineSimF32)"
provides:
  - "41-SPIKE-FINDINGS.md — mechanism decision (zero-dep flat-buffer sidecar) for Plan 41-02"
  - "scripts/eval/41-index-spike.cjs — reusable cold+warm index comparison harness"
affects:
  - "Plan 41-02 (reads the Decision: line + persistence artifact + tombstoned verdict)"
tech-stack:
  added: []
  patterns:
    - "contiguous flat Float32Array (rows×dims) + precomputed Float64Array norms exact-cosine scan"
    - "cold end-to-end measurement via subprocess-per-query spawnSync"
    - "embed-isolated mock cold reference to separate index cost from embed-network jitter"
key-files:
  created:
    - "scripts/eval/41-index-spike.cjs"
    - ".planning/phases/41-vector-index-and-hot-path-latency/41-SPIKE-FINDINGS.md"
    - "scripts/eval/results/41-index-spike.json (gitignored, local-only)"
    - "scripts/eval/results/41-index-spike-coldref-mock.json (gitignored, local-only)"
  modified: []
decisions:
  - "Ship zero-dep flat-buffer exact index; sqlite-vec not warranted (D-04 tie-break)"
  - "Persist as serialized flat-buffer sidecar built end-of-sleep-pass (D-06)"
  - "Leave topkTombstoned on brute-force (small set, D-07/discretion)"
metrics:
  duration_min: 8
  completed: 2026-06-24
  tasks: 2
  files: 2
---

# Phase 41 Plan 01: Vector-Index Mechanism Spike Summary

Resolved the index mechanism on real live-brain numbers: the zero-dep contiguous flat-`Float32Array` exact scan beats brute-force ~3.4× warm (13/14 ms vs the Phase-40 45/46 ms bar), is byte-exact (20/20 top-k set-identical), and needs a persisted sidecar (D-06) to help the cold path — sqlite-vec is unwarranted (and was not loadable here).

## What was built

- **`scripts/eval/41-index-spike.cjs`** — a read-only, live-brain cold+warm comparison harness at k=10. Measures three exact retrievers (brute-force baseline, zero-dep flat buffer, sqlite-vec vec0) in two timing modes each (D-09): WARM scan-only (build once, time the scan loop) and COLD end-to-end (subprocess-per-query spawn → open db → build/attach → scan). Reuses `live-latency.cjs`'s QUERIES + read-only-open + percentile pattern and `latency-curve.cjs`'s `--mock-embed` mode + JSON envelope shape. Asserts top-k SET equivalence vs brute-force (D-10). sqlite-vec runs only against a tmpdir copy, never the live file (T-41-01), and degrades to `unavailable` with the load-error string when the binary is absent (never crashes).

- **`41-SPIKE-FINDINGS.md`** — the recorded decision Plan 41-02 reads via `read_first`: per-cell cold+warm p50/p95 table, deltas vs both the brute-force baseline and the Phase-40 committed warm number, the top-k equivalence result, the `Decision:` line + D-04 rationale, the implied persistence artifact (D-06), and the tombstoned-scan verdict (D-07).

## Measured results (live brain, 10,192 embedded nodes)

| Mechanism | Mode | p50 | p95 |
|-----------|------|-----|-----|
| baseline brute-force | warm | 47 ms | 49 ms |
| zero-dep flat buffer | warm | **13 ms** | **14 ms** |
| baseline brute-force | cold (embed-isolated) | 171 ms | 182 ms |
| zero-dep flat buffer | cold (embed-isolated) | 191 ms | 208 ms |
| sqlite-vec | — | unavailable (module not installed) |

- WARM: zero-dep ~3.6× faster than baseline, ~3.4× under the Phase-40 45/46 ms bar — clears PERF-02 (D-08) with margin.
- COLD from-scratch: zero-dep ~20 ms *slower* than baseline — confirms D-06: an in-memory buffer thrown away per process doesn't help the cold felt path; only a persisted sidecar (which skips the ~170 ms row-marshaling floor) does. The from-scratch number is the upper bound on the persisted cold path.
- Top-k equivalence: **20/20 queries set-identical** to brute-force (warm and cold) — byte-exact, PERF-03 satisfied by construction (D-01).

## Decision

Ship the **zero-dep contiguous flat-`Float32Array` exact index** behind the existing `CandidateRetriever` seam, persisted as a **serialized flat-buffer sidecar** built at end-of-sleep-pass (D-06). Net-zero new deps preserved. sqlite-vec was the escalation-only option and is not warranted: JS clears the bar decisively and the native binary wasn't even installable here. `topkTombstoned` stays brute-force (small set). HNSW stays deferred (D-01).

## Deviations from Plan

None — plan executed as written. Two honest refinements within scope:
1. The real-embed COLD cells include the per-subprocess OpenAI embed round-trip, whose network variance swamps the index delta. Added an **embed-isolated mock cold reference** (`41-index-spike-coldref-mock.json`) so the cold index-vs-index delta is measured without the network confound. Both are reported; the findings call out which signal each supports. This strengthens the honesty of the cold comparison (no inflated/obscured metric).
2. Mock query vectors are seeded non-zero unit vectors (not zero vectors) so cosine ties don't collapse and the top-k equivalence check stays meaningful in `--mock-embed`/CI.

## Authentication / Gates

None. The real run used the already-set `OPENAI_API_KEY` for ~20 query embeddings (negligible, well under the $3 threshold).

## Read-only / safety

Live `recense.db` opened `readonly:true, fileMustExist:true`; mtime unchanged after the run (Jun 23 22:06). No sqlite-vec scratch files created (extension never loaded). No writes to the live brain.

## Known Stubs

None. The harness produces real numbers; the findings record a real decision.

## Self-Check: PASSED

- `scripts/eval/41-index-spike.cjs` — FOUND
- `.planning/phases/41-vector-index-and-hot-path-latency/41-SPIKE-FINDINGS.md` — FOUND
- `scripts/eval/results/41-index-spike.json` — FOUND (gitignored, local-only)
- commit `f7631e9` (harness) — FOUND
- commit `b69a701` (findings) — FOUND
