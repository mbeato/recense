---
phase: 51-wasm-simd-exact-scan-kernel
plan: "02"
subsystem: retrieval
tags: [wasm, simd, cosine-kernel, loader, partial-select, tdd]
dependency_graph:
  requires: [src/retrieval/simd-kernel-wasm.ts]
  provides: [src/retrieval/simd-kernel.ts, tests/simd-kernel.test.ts]
  affects: [src/retrieval/topk.ts (Plan 03 integration)]
tech_stack:
  added: []
  patterns: [wasm-loader-try-catch-null, fixed-size-min-heap-partial-select, wasm-memory-regions]
key_files:
  created:
    - src/retrieval/simd-kernel.ts
    - tests/simd-kernel.test.ts
  modified: []
decisions:
  - "WebAssembly.validate on SIMD blob acts as feature-detection gate (D-09): blob carries v128/f32x4 opcodes, so validate() returns false on non-SIMD runtimes"
  - "new Uint8Array(wasmBytes()) copy for BufferSource: Buffer-pool Uint8Array has ArrayBufferLike; WebAssembly.validate/Module require ArrayBuffer-backed BufferSource"
  - "Fixed-size min-heap for partialSelectTopK (D-02): O(n log k), trivially verifiable set-identity vs full sort+slice"
  - "scores.slice(0, count) per query: WASM score region is reusable shared memory; caller receives a stable copy"
  - "Reciprocal norms as f32 in WASM memory: precomputed once at construction, zero-norm -> 0 (T-51-23 denom guard)"
metrics:
  duration_minutes: 4
  tasks_completed: 3
  tasks_total: 3
  completed_date: "2026-06-30"
---

# Phase 51 Plan 02: Kernel Loader + Wrapper + Tests Summary

Built the WASM SIMD kernel loader/wrapper module and unit test suite: `loadSimdKernel` decodes the committed blob, feature-detects SIMD via `WebAssembly.validate`, compiles/instantiates once, preloads the corpus and reciprocal norms, and exposes a `scanCosine` that emits cosine scores — plus `partialSelectTopK`, a fixed-size min-heap partial selection that is set-identical to the full sort.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing tests for loadSimdKernel + scanCosine | 037ab96 | tests/simd-kernel.test.ts |
| 1+2 (GREEN) | loadSimdKernel, scanCosine, partialSelectTopK impl | 1b5277a | src/retrieval/simd-kernel.ts |
| 3 | Unit tests (all 3 cases) already in RED commit | 037ab96 | tests/simd-kernel.test.ts |

## TDD Gate Compliance

- RED commit (`037ab96`): `test(51-02): add failing tests for loadSimdKernel, scanCosine, partialSelectTopK` — confirmed failed with "Cannot find module" before implementation existed.
- GREEN commit (`1b5277a`): `feat(51-02): implement loadSimdKernel, scanCosine, partialSelectTopK` — all 13 tests pass.

## Decisions Made

1. **BufferSource copy for WebAssembly APIs**: `wasmBytes()` returns a `Buffer.from(b64, 'base64')` which is a `Uint8Array<ArrayBufferLike>` (Node.js Buffer pool). `WebAssembly.validate` and `WebAssembly.Module` require `BufferSource` (an `ArrayBuffer`-backed view). Fixed with `new Uint8Array(wasmBytes())` which copies into a plain `ArrayBuffer`. This is a Rule 1 auto-fix (type error blocking compilation).

2. **SIMD feature-detection**: `WebAssembly.validate(bytes)` on the blob returns false on non-SIMD runtimes because the blob carries v128/f32x4 opcodes. No separate feature-detection flag needed — validate IS the detection (confirmed in Plan 01 SUMMARY, D-09).

3. **Memory layout**: Four contiguous regions in one `WebAssembly.Memory`: `[qPtr=0][mPtr=dim*4][rnPtr=mPtr+count*dim*4][outPtr=rnPtr+count*4]`. All v128.load targets (qPtr and matrix rows) are 16-byte aligned because dim%4===0 ensures `dim*4 mod 16 === 0`.

4. **Partial-select algorithm**: Fixed-size min-heap of capacity k. O(n log k) time, O(k) space. Chosen over quickselect for trivial verifiability of set-identity. Returns the heap contents mapped to `{id, score}` and sorted descending.

5. **scores.slice(0, count)**: `scoresView` aliases reusable WASM memory. Returning `slice()` gives the caller a stable array not clobbered by the next `scanCosine` call. Confirmed by the "stable copy" test.

## Verification Results

- `npx vitest run tests/simd-kernel.test.ts` — 13/13 tests pass.
- `npm run build` — compiles clean (no `any`, strict types, no errors).
- Case 1 (D-07): scanCosine scores match `cosineSimF32(q, row_r)` within `toBeCloseTo(6)` for seeds [7, 13, 42, 99]; zero-norm row → score=0; zero query-norm → all scores=0.
- Case 2 (D-02): idSet equivalence to full sort+slice verified for k in {0, 1, 10, count} across 3 LCG seeds.
- Case 3 (D-08): dim%4≠0 → null (no throw); data-length mismatch → null (no throw); truncated WASM bytes via vi.spyOn → null (no throw).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] BufferSource type mismatch for WebAssembly.validate / Module**
- **Found during:** Task 1 GREEN phase — `npm run build` revealed type errors
- **Issue:** `wasmBytes()` returns `Buffer.from(b64, 'base64')` = `Uint8Array<ArrayBufferLike>`. `WebAssembly.validate` and `WebAssembly.Module` expect `BufferSource` = `ArrayBufferView<ArrayBuffer>`. The `ArrayBufferLike` vs `ArrayBuffer` mismatch caused TS2345 errors.
- **Fix:** `const bytes = new Uint8Array(wasmBytes())` — copies Buffer bytes into a fresh `ArrayBuffer`-backed `Uint8Array`, satisfying `BufferSource`.
- **Files modified:** `src/retrieval/simd-kernel.ts` (one-line change in the same GREEN commit)
- **Commit:** `1b5277a` (included in the GREEN commit before final push)

## Known Stubs

None. `loadSimdKernel` is fully wired: it decodes the real blob from `simd-kernel-wasm.ts`, loads the real corpus, precomputes real reciprocal norms, and runs the real WASM scan kernel. `partialSelectTopK` is a complete implementation.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes. The module is purely in-process computation. Threat mitigations confirmed applied:

| Threat | Status |
|--------|--------|
| T-51-21: out-of-bounds WASM memory | Mitigated: `dim%4===0` and `data.length===count*dim` guards before any allocation |
| T-51-22: kernel fault → score corruption | Mitigated: single try/catch → null; kernel fault degrades to scalar fallback |
| T-51-23: NaN/Infinity in scores | Mitigated: `norms[r]===0 → reciprocal=0`; `qNorm===0 → recipQNorm=0`; no NaN path |

## Self-Check: PASSED

Files verified present:
- FOUND: src/retrieval/simd-kernel.ts
- FOUND: tests/simd-kernel.test.ts

Commits verified in git log:
- 037ab96 — test(51-02): add failing tests for loadSimdKernel, scanCosine, partialSelectTopK
- 1b5277a — feat(51-02): implement loadSimdKernel, scanCosine, partialSelectTopK
