---
phase: 51-wasm-simd-exact-scan-kernel
plan: "01"
subsystem: retrieval
tags: [wasm, simd, cosine-kernel, f32x4, blob-module]
dependency_graph:
  requires: []
  provides: [src/retrieval/simd-kernel.wat, scripts/gen-simd-kernel.cjs, src/retrieval/simd-kernel-wasm.ts]
  affects: [src/retrieval/topk.ts (Plan 02 loader)]
tech_stack:
  added: []
  patterns: [base64-inlined-wasm-blob, dev-only-regen-script, wasm-simd-f32x4]
key_files:
  created:
    - src/retrieval/simd-kernel.wat
    - scripts/gen-simd-kernel.cjs
    - src/retrieval/simd-kernel-wasm.ts
  modified:
    - package.json
decisions:
  - "Fused reciprocal-norm in WAT (D-01): cosine = rawDot * rnPtr[r] * recipQNorm — one pass, no separate JS divide loop"
  - "Precomputed f32 reciprocal-norm region (rnPtr): loader supplies 1/||row_r|| per row; zero-norm -> 0 -> score 0 (denom-guard)"
  - "WebAssembly.validate as SIMD feature-detection hook: the blob contains v128/f32x4 ops so validation fails on non-SIMD runtimes (D-08 detection)"
  - "wabt stays devDep-only: gen:simd-kernel is a standalone npm script, not in postbuild/postinstall/prepare (D-04, T-51-SC)"
metrics:
  duration_minutes: 3
  tasks_completed: 3
  tasks_total: 3
  completed_date: "2026-06-30"
---

# Phase 51 Plan 01: WASM SIMD Kernel Artifact Summary

Produced the reproducible, committed WASM SIMD cosine kernel artifact: an in-repo WAT source with fused reciprocal-norm cosine (D-01), a dev-only regen script with `--check` reproducibility gate and cosine self-test, and the generated base64-inlined TS blob module that Plan 02's loader imports.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Author fused-cosine f32x4 WAT kernel | ed0219c | src/retrieval/simd-kernel.wat |
| 2 | Write dev-only regen script + npm entry | d187e44 | scripts/gen-simd-kernel.cjs, package.json |
| 3 | Generate and commit base64 blob module | 8b9b183 | src/retrieval/simd-kernel-wasm.ts |

## Decisions Made

1. **WAT param order and kernel design:** `scan(qPtr, mPtr, rnPtr, outPtr, recipQNorm, n, dimsBytes)`. After the f32x4 horizontal sum, the kernel multiplies by `rnPtr[r]` (precomputed f32 reciprocal row-norm) and then by `recipQNorm` (query reciprocal norm). This eliminates the JS scalar norm-divide loop (D-01). The loader pre-computes `1/||row_r||` from the sidecar's `norms: Float64Array` and converts to f32; zero-norm rows store 0 as reciprocal, producing score 0 — matching `cosineSimF32`'s denom-guard exactly.

2. **SIMD feature-detection approach:** `WebAssembly.validate(bytes)` on the blob acts as the detection gate — the blob contains `v128`/`f32x4` opcodes, so validation returns false on a runtime without SIMD support. The loader (Plan 02) wraps this in a try/catch and falls back to the scalar scan (D-08).

3. **Memory layout for `--check` fixture:** `qPtr=0, mPtr=16, rnPtr=48, outPtr=56` for a `dim=4, count=2` fixture — all accesses 16-byte aligned, within 1 WASM page. Scores verified: `score[0]=1.000000` (cos angle = 0) and `score[1]=0.666667` (=20/30) matched JS reference within sub-1e-6.

## Verification Results

- `node scripts/gen-simd-kernel.cjs --check` exits 0 (reproducibility gate PASS + cosine self-test PASS)
- `npm run build` compiles `simd-kernel-wasm.ts` with no type errors
- `WebAssembly.validate(wasmBytes())` returns true (valid SIMD module)
- `grep -c 'f32x4' src/retrieval/simd-kernel.wat` = 7 (contains f32x4.add x2, f32x4.mul x1, f32x4.extract_lane x4)
- `package.json` has zero `postinstall|prepare` entries; `gen:simd-kernel` not in `postbuild`
- WASM_BASE64 blob reproduced byte-for-byte from WAT on two consecutive runs

## Deviations from Plan

None — plan executed exactly as written. The blob file was generated as a side-effect of the Task 2 acceptance verification run (`node scripts/gen-simd-kernel.cjs`), which ran the default mode and produced `simd-kernel-wasm.ts` before Task 3's explicit generation step. No behavioral deviation.

## Known Stubs

None. The WAT kernel is fully implemented, the regen script is production-complete, and the blob is a real WASM binary (not a placeholder).

## Threat Surface Scan

No new surface beyond the plan's threat model. The inlined base64 WASM blob is opaque but reproducible from the in-repo WAT via `--check`. The `gen:simd-kernel` script is not wired into any install lifecycle hook (T-51-SC satisfied). The WAT trusts loader-supplied pointers (T-51-02 acknowledged — loader's responsibility in Plan 02).

## Self-Check: PASSED

Files verified present:
- FOUND: src/retrieval/simd-kernel.wat
- FOUND: scripts/gen-simd-kernel.cjs
- FOUND: src/retrieval/simd-kernel-wasm.ts

Commits verified in git log:
- ed0219c — feat(51-01): author fused-cosine f32x4 WAT kernel
- d187e44 — feat(51-01): add dev-only regen script + gen:simd-kernel npm entry
- 8b9b183 — feat(51-01): generate and commit base64 WASM blob module
