---
phase: 49-scale-data-model-spike
plan: "03"
subsystem: findings-doc
tags: [spike, scale, data-model, go-no-go, SCALE-01, SCALE-02, D-04, D-05, D-06]
dependency_graph:
  requires: [crossover_measurements, results_json]
  provides: [scale_findings, scale_go_no_go, data_model_recommendation]
  affects: [.planning/phases/49-scale-data-model-spike/49-SPIKE-FINDINGS.md]
tech_stack:
  added: []
  patterns: [Phase-41 SPIKE-FINDINGS format, traced-or-unmeasured-here honesty, schema-delta migration-cost analysis]
key_files:
  created:
    - .planning/phases/49-scale-data-model-spike/49-SPIKE-FINDINGS.md
  modified: []
decisions:
  - "SCALE-01 verdict: NO-GO / DEFER — exact scan p95=19.5ms at the real 14k scale is well under the ~45ms felt-path budget; ANN only pays off past ~33k nodes (crossover identified). Defer is the expected valid outcome."
  - "SCALE-02 verdict: DEFER — keep tombstone-always; no current forcing function for bi-temporal/supersedes. If/when needed, prefer additive nullable supersedes-chain columns first (cheap O(1) ADD COLUMN), bi-temporal intervals only on a real as-of-time requirement."
  - "Recall honesty caveat surfaced in the doc: hnswlib r@10=1.000 is self-match-inflated (queries ∈ corpus); vectorlite's ~0.95 is the representative signal"
  - "Memory numbers flagged directional (rss delta, off-heap native HNSW + GC noise) — not load-bearing"
metrics:
  duration: "~4 minutes"
  completed: "2026-06-28"
  tasks_completed: 2
  files_modified: 1
---

# Phase 49 Plan 03: SCALE-01 go/no-go + SCALE-02 recommendation

## What was built

The single phase deliverable `49-SPIKE-FINDINGS.md` (D-06, Phase-41 format), discharging both
requirements with traced-to-JSON numbers and a desk-analysis data-model recommendation.

**§ SCALE-01 — NO-GO / DEFER.** Per-rung measured table {14k, 25k, 50k} transcribed from
`scripts/eval/results/49-crossover-spike.json`. The exact flat-buffer scan is linear (~1.35 ms/1k
nodes): 19.5 ms p95 at the real 14k scale — under the ≈45/46 ms Phase-40/41 felt-path budget — so the
D-04 gate's latency condition is not met. Crossover identified at **N ≈ 33k nodes** (where exact
scan-only first breaches ~45 ms). ANN recall would clear ≥0.95 at those scales, but the brain (14k,
slow growth) isn't near the crossover, and ANN adds a native dep + 35–142 s offline build. Exact wins
on simplicity + zero-dep + byte-exact correctness. Explicit re-trigger documented: re-measure at ~30k
nodes or if full felt-path p95 > ~40 ms in production.

**§ SCALE-02 — DEFER (keep tombstone-always).** Named all three options (bi-temporal validity
intervals / DCPM supersedes chains / current tombstone-always). Migration cost mapped to the two
codebase cost shapes: nullable additive `ADD COLUMN` is O(1) metadata-only; backfill-into-intervals or
constrained columns force the full `node_v*` recreation (rewrite ~14k rows + rebuild all indexes +
`node_fts`). SCHEMA_VERSION bump 14→15 noted, idempotent, behind the existing downgrade guard. The
four correctness invariants (decay-never-deletes, graph-source-of-truth, single-writer IMMEDIATE,
self-confirmation guard) named as gates. No current forcing function ⇒ defer; if needed later, prefer
additive supersedes-chain columns first. No migration code written (D-05).

## Honesty discipline
- Every SCALE-01 number traces to the results JSON; recall self-match inflation and rss-delta
  imprecision are explicitly flagged in the doc (no inflated metrics).
- Read-only provenance line present; live DB mtime-unchanged invariant cited.

## Self-Check: PASSED
- Frontmatter `requirement: [SCALE-01, SCALE-02]` + `harness:` + `results:` keys present (verify exit 0). ✓
- § SCALE-01 measured table + D-04-gated GO/NO-GO/DEFER verdict + named crossover + read-only line. ✓
- § SCALE-02 three options + schema-delta migration cost + SCHEMA_VERSION + invariants + recommendation; no code. ✓
- Both task verify gates pass; defer framed as a valid outcome throughout. ✓
