---
phase: 51-wasm-simd-exact-scan-kernel
plan: "05"
subsystem: retrieval/eval
tags: [gap-closure, equivalence-gate, real-embed, f32-precision, sc2, wasm, simd]
dependency_graph:
  requires: ["51-03"]
  provides: ["WR-01-fix", "SC2-real-embed-proof"]
  affects: ["scripts/eval/51-topk-equivalence.cjs"]
tech_stack:
  added: []
  patterns: ["fail-loud guard", "hard budget assertion", "human-verify checkpoint"]
key_files:
  created: []
  modified:
    - scripts/eval/51-topk-equivalence.cjs
decisions:
  - "WR-01 root cause was a precision-CLASS difference (f32 kernel accumulation vs f64 scalar/reference), not sum-ordering — comment corrected accordingly"
  - "Gate fails loud (exit 3) when OPENAI_API_KEY is absent or any query vector is zero/NaN — closes the silent-vacuous-pass hole (project memory: recense-manual-run-env-masked-failures)"
  - "max|Δscore| promoted from informational to a hard MAX_DELTA_BUDGET=1e-6 assertion (exit 1 on breach) — never widen-to-pass"
  - "SC2 proven by REBUILDING the .vindex sidecar then re-running --real-embed; the rebuild was the only change between the failing (recall 0.995) and passing (recall 1.000) runs, confirming the misses were stale-index coverage, not the kernel"
metrics:
  duration: "~7 min (auto) + live-brain verify"
  completed: "2026-06-30"
requirements: [SCALE-03]
---

# Phase 51 Plan 05: Real-Embedding Equivalence Proof (WR-01 / SC2) Summary

**One-liner:** Hardened the `51-topk-equivalence` gate (fail-loud real-embed, hard max|Δ| budget, recall@10, corrected precision-class comment) and proved SC2 on the live brain at production dim=1536 — recall@10=1.000 and max|Δscore|=1.8e-7, kernel set-identical and score-faithful to the scalar scan.

## Tasks

| Task | Type | Status | Commit |
|------|------|--------|--------|
| 1 — Harden gate: fail-loud, MAX_DELTA_BUDGET=1e-6, recall@10, precision-class comment fix | auto | complete | `c75187d` |
| 2 — Run `--real-embed` on live brain (SC2 proof) | human-verify checkpoint | **resolved — PASS** | (verification run, results below) |

## Checkpoint resolution — measured evidence

Run: `node scripts/eval/51-topk-equivalence.cjs --real-embed` against the live brain
(`/Users/vtx/.config/recense/recense.db`, 15,943 embedded live nodes, `text-embedding-3-small`, dim=1536).

| Metric | Result | Bar | Verdict |
|--------|--------|-----|---------|
| equivalent | true | set-identical (D-07) | PASS |
| equivalence checks / failures | 40 / 0 | 0 failures | PASS |
| max\|Δscore\| | 1.801e-7 | < MAX_DELTA_BUDGET=1e-6 | PASS (5.5× under) |
| recall@10 (mean) | 1.0000 | = 1.000 | PASS |
| kernel speedup | 4.64× | ~4–5× (SC3) | PASS |
| full per-query speedup | 4.74× | materially faster (SC3) | PASS |
| exit code | 0 | 0 | PASS |

## Root-cause finding (the load-bearing part)

The first `--real-embed` run (against the existing sidecar) returned recall@10=**0.995** with 5
membership divergences. Investigation showed:

- **The f32 kernel is NOT the cause.** max\|Δscore\| was 1.801e-7 on real embeddings — well under
  the 1e-6 budget. The WR-01 worry that f32 dot error at dim=1536 could meet TIE_EPS=1e-6 did **not
  materialize**; the accelerated path does not change scores. The "never let an accelerated path
  change retrieval results" hard-rule holds.
- **The 5 misses were stale-sidecar coverage.** All brute-only entries were compound `super::` nodes
  present in the DB but absent from the `.vindex` (15,828 indexed vs 15,933 live = ~105 missing).
  `bruteForceScored` and `buildVectorIndex` use the identical filter
  (`SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0`), so the gap was
  purely cache staleness, not a kernel or design difference — the old scalar-indexed path would
  diverge from a full-DB brute-force identically.
- **Proof by rebuild.** Rebuilding the sidecar via `buildVectorIndex` (the derived cache; graph is
  source of truth — atomic temp+rename, as the sleep pass does) brought it to 15,943 entries.
  Re-running `--real-embed` with **no code change** moved recall@10 from 0.995 → **1.000** and
  failures 5 → **0**. This isolates the cause to staleness and confirms the kernel is exact.

## Gaps closed

- **WR-01 / SC2** — equivalence now proven at production dimensionality with real OpenAI embeddings:
  recall@10=1.000, max\|Δ\|=1.8e-7. Gate hardened to fail loud (no vacuous pass) and to assert a hard
  delta budget (no widen-to-pass). Comment corrected to name the f32-vs-f64 precision class.

## Self-Check: PASSED

- Gate exits 0 with real embeddings at dim=1536; recall@10=1.000; max\|Δ\|=1.8e-7 < 1e-6.
- TIE_EPS/MAX_DELTA_BUDGET were NOT widened — the empirical bound is comfortably under budget.

## Follow-up (outside Phase 51 scope)

- The `.vindex` sidecar drifts behind the DB between sleep passes (it was ~105 nodes stale here).
  Retrieval over a stale sidecar silently omits recently-added nodes (including compound super-nodes)
  from exact top-k. Worth a tracked item: ensure the sleep pass rebuild cadence / freshness covers
  newly-promoted compound nodes, or surface sidecar staleness. This is pre-existing and independent
  of the SIMD kernel.
