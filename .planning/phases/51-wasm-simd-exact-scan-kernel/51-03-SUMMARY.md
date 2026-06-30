---
phase: 51-wasm-simd-exact-scan-kernel
plan: "03"
subsystem: retrieval
tags: [wasm, simd, cosine-kernel, topk, integration, equivalence-gate]
dependency_graph:
  requires: [src/retrieval/simd-kernel.ts, src/retrieval/simd-kernel-wasm.ts]
  provides: [src/retrieval/topk.ts (WASM-accelerated topkIndexed), tests/topk-simd.test.ts, scripts/eval/51-topk-equivalence.cjs]
  affects: [every CandidateRetriever caller that passes indexPath — session-start, recall, ambient]
tech_stack:
  added: []
  patterns: [simd-kernel-wired-into-retriever, constructor-once-kernel-load, verbatim-scalar-fallback-D-08, partial-select-topk-D-02, live-brain-equivalence-gate]
key_files:
  created:
    - tests/topk-simd.test.ts
    - scripts/eval/51-topk-equivalence.cjs
  modified:
    - src/retrieval/topk.ts
decisions:
  - "Constructor loads kernel once (D-05): corpus pre-loaded into WASM memory at CandidateRetriever construction, not per-query — matches the index load pattern exactly"
  - "dim%4!=0 forces kernel null (Case 2 test lever): DIM=9 in topk-simd.test.ts is the deterministic integration lever for D-08 scalar fallback; no mocking needed"
  - "partialSelectTopK replaces .sort().slice(k) in scalar fallback too: D-02 upgrade applied to both branches — kernel and scalar fallback are now selection-equivalent"
  - "Latency gate is informational, not hard-fail: hardware variance can affect single runs; equivalence (recall@10=1.000) is the hard gate"
metrics:
  duration_minutes: 10
  tasks_completed: 3
  tasks_total: 3
  completed_date: "2026-06-30"
---

# Phase 51 Plan 03: Wire SIMD Kernel + Integration Tests + Live-Brain Gate Summary

SCALE-03 realized end-to-end: `topkIndexed` is WASM-accelerated via the f32x4 cosine kernel (loaded once at construction), set-identical to the scalar scan (recall@10=1.000 on the live 15,796-node brain, 4.45x kernel speedup), with verbatim scalar fallback on any kernel fault (D-08), scalar paths untouched (D-06), and Phase-50 unit/integration gates green.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wire SIMD kernel into topkIndexed with verbatim scalar fallback | c31eb66 | src/retrieval/topk.ts |
| 2 | CandidateRetriever integration tests — set-identity + forced fallback | b9c1dfe | tests/topk-simd.test.ts |
| 3 | Live-brain equivalence + kernel-vs-scalar latency gate | b9f9220 | scripts/eval/51-topk-equivalence.cjs |

## Decisions Made

1. **Constructor-once kernel load:** The `SimdKernel | null` handle is initialized in the `CandidateRetriever` constructor immediately after `this.index` loads. Corpus data is pre-loaded into WASM memory at construction (inside `loadSimdKernel`), so `scanCosine` has zero setup cost per query. When the index is null the kernel is null; when the kernel init fails, one stderr line is emitted and the scalar path runs unchanged (mirrors the existing index-unavailable pattern exactly).

2. **partialSelectTopK in both branches:** The scalar fallback path in `topkIndexed` was also upgraded from `.sort().slice(k)` to `partialSelectTopK` (D-02). This is a pure performance improvement — `partialSelectTopK` is set-identical by construction (O(n log k) min-heap vs O(n log n) full sort). The original scored array was changed from `Array<{id,score}>` to a `Float32Array` to match the kernel's output type, enabling the same `partialSelectTopK(scores, ids, k)` call in both branches.

3. **DIM=9 as kernel-unavailable lever:** The integration test for D-08 uses DIM=9 (not divisible by 4) to force `loadSimdKernel` to return null without any mocking. This is the cleanest deterministic lever: it exercises the real `loadSimdKernel → null` path, the real `this.kernel === null` branch in `topkIndexed`, and confirms set-identical results from the scalar dot loop.

4. **Latency gate: informational, not hard-fail:** The `51-topk-equivalence.cjs` script reports kernel_speedup and full_speedup but does not exit 1 on a sub-4x result. Hardware variance on single runs can affect the measurement. The hard gate is the equivalence check (recall@10=1.000, exit 1 on genuine divergence). This matches the plan spec.

## Verification Results

- `npm run build` — clean, no type errors.
- `npx vitest run tests/topk-index.test.ts tests/topk-simd.test.ts` — 6/6 pass (4 existing + 2 new).
- `node scripts/eval/51-topk-equivalence.cjs` — exit 0:
  - 40 equivalence checks (20 queries × 2 k values), 0 failures
  - max|Δscore| = 5.191e-8 (sub-ULP, within TIE_EPS=1e-6, expected for f32x4 ordering)
  - kernel-only p95: scalar=17.132ms → wasm=3.853ms (**4.45x** speedup)
  - full p95: scalar=17.201ms → wasm=3.857ms (**4.46x** speedup)
  - Live corpus: 15,796 nodes, 1536-dim embeddings
- `git diff 63a582f HEAD -- src/retrieval/topk.ts` — D-06 confirmed: `cosineSimF32`, brute-force `topk`, `topkTombstoned`, `hybridTopk`, `buildVectorIndex`, `loadVectorIndex` untouched.

## Deviations from Plan

### Auto-fixed Issues

None. Plan executed exactly as written. The only implementation choice was upgrading the scalar fallback to also use `partialSelectTopK` (instead of the old `.sort().slice(k)`) — this is strictly an improvement and falls within the plan's stated intent (D-02 partial-select upgrade).

## Known Stubs

None. All three deliverables are fully wired:
- `topkIndexed` calls the real kernel when present, real scalar loop when not.
- `tests/topk-simd.test.ts` uses a real temp DB, real sidecar, real kernel path.
- `scripts/eval/51-topk-equivalence.cjs` reads the live brain, asserts sidecar present, runs real kernel timing.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes. The kernel reads only `LoadedIndex` data (already loaded into memory). Threat mitigations confirmed applied:

| Threat | Status |
|--------|--------|
| T-51-31: kernel fault → score corruption | Mitigated: `this.kernel === null` → verbatim scalar dot loop; 51-equivalence gate asserts recall@10=1.000 on live brain |
| T-51-32: silent retrieval regression | Mitigated: 40-check equivalence gate + 6-test unit/integration suite + existing topk-index.test.ts coverage |
| T-51-33: scope creep into D-06 paths | Mitigated: git diff confirms zero changes to cosineSimF32, brute-force topk, topkTombstoned, hybridTopk |

## Self-Check: PASSED

Files verified present:
- FOUND: src/retrieval/topk.ts (modified)
- FOUND: tests/topk-simd.test.ts (created)
- FOUND: scripts/eval/51-topk-equivalence.cjs (created)

Commits verified in git log:
- c31eb66 — feat(51-03): wire WASM SIMD kernel into topkIndexed with verbatim scalar fallback
- b9c1dfe — feat(51-03): add CandidateRetriever SIMD integration tests — set-identity + forced fallback
- b9f9220 — feat(51-03): add live-brain equivalence gate + kernel-vs-scalar latency report
