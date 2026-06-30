---
status: resolved
phase: 51-wasm-simd-exact-scan-kernel
source: [51-VERIFICATION.md]
started: 2026-06-30T20:59:00Z
updated: 2026-06-30T22:25:13Z
---

## Current Test

[all items resolved]

## Tests

### 1. Real-embedding equivalence at production dimensionality (SC2 / WR-01)
expected: `--real-embed` gate keeps max|Δscore| < 1e-6 and recall@10 = 1.000 at dim=1536.
result: PASS — live brain (15,943 nodes, text-embedding-3-small, dim=1536): equivalent=true, 40/40 checks, failures=0, max|Δscore|=1.801e-7 (< 1e-6 budget, not breached), recall@10=1.0000, kernel 4.64× / full 4.74×, exit 0. Required rebuilding the stale .vindex sidecar (15,828 → 15,943 entries); the rebuild was the ONLY change between the failing 0.995 run and the passing 1.000 run, confirming the misses were stale-index coverage of compound super-nodes, not the f32 kernel.

### 2. norms.length bounds guard (WR-02)
expected: loadSimdKernel rejects a short norms array (norms.length < count → return null) or documents why unnecessary.
result: PASS — plan 51-04 added `if (norms.length < count) return null;` to src/retrieval/simd-kernel.ts with a TDD regression test (14 tests pass, up from 13). JSDoc contract updated.

## Summary

total: 2
passed: 2
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

None — both human-verification items resolved. WR-03 (--check wired into pretest, wabt pinned exact) also closed by plan 51-04.
