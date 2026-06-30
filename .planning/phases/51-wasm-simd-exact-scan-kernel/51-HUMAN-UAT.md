---
status: partial
phase: 51-wasm-simd-exact-scan-kernel
source: [51-VERIFICATION.md]
started: 2026-06-30T21:50:20Z
updated: 2026-06-30T21:50:20Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Real-embedding equivalence at production dimensionality (SC2 / WR-01)
expected: Running the equivalence gate against real OpenAI 1536-dim embeddings (e.g. `node scripts/eval/51-topk-equivalence.cjs --real-embed`) keeps max|Δscore| well below TIE_EPS=1e-6 and recall@10 = 1.000. This confirms the f32 SIMD path is set-identical to the f64 scalar scan at production dimensionality — the gate as run used 20 seeded mock unit-vectors and DIM=8 unit tests, where f32 rounding error is negligible and does not exercise the dim=1536 worst case.
result: [pending]

### 2. norms.length bounds guard (WR-02)
expected: `loadSimdKernel` either rejects a short `norms` array (norms.length < count → return null, matching its stated bounds-check contract) or documents why the guard is unnecessary. Currently `data.length` is validated but `norms.length` is not, so a short norms array yields 1/undefined → NaN scores that silently drop rows.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
