---
phase: 51-wasm-simd-exact-scan-kernel
reviewed: 2026-06-30T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/retrieval/topk.ts
  - src/retrieval/simd-kernel.ts
  - src/retrieval/simd-kernel.wat
  - src/retrieval/simd-kernel-wasm.ts
  - scripts/gen-simd-kernel.cjs
  - scripts/eval/51-topk-equivalence.cjs
  - tests/simd-kernel.test.ts
  - tests/topk-simd.test.ts
  - package.json
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 51: Code Review Report

**Reviewed:** 2026-06-30
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

This phase wires a WASM `f32x4` cosine kernel into `topkIndexed` with a verbatim scalar
fallback. The memory-safety engineering is sound: the WASM memory is allocated with a fixed
`maximum === initial` (no growth → buffer never detaches → persistent views stay valid), all
region offsets are 4-byte aligned, the kernel's read/write extents are provably in-bounds
(matrix reads stop exactly at `rnPtr`, rn at `outPtr`, out at `total`, with +4 pages slack),
`scanCosine` returns a `.slice()` copy so callers never alias reusable WASM memory, and every
fault path funnels through `try/catch → null` with a verbatim scalar fallback. No injection,
secret, eval, or path-traversal issues. The `scan` signature is consistent across WAT, loader,
and the self-test, and the loop bounds are correct (no off-by-one).

The substantive concerns are about the **equivalence contract**, not crashes. The kernel computes
cosine entirely in `f32` (f32x4 accumulation + f32 reciprocal norms + f32 reciprocal query-norm),
whereas BOTH the scalar fallback and the brute-force reference compute in `f64`. The accelerated
path is therefore systematically *less precise* than the path it must match — and the equivalence
gate's tie tolerance (`TIE_EPS = 1e-6`) is calibrated below the plausible f32 accumulation error
for the production `dim = 1536`. Given the project hard-rule "never let an accelerated path change
retrieval results," this is the area worth tightening (WR-01). No defect rises to a proven
result-changing BLOCKER — set-identity is empirically gated and unit-tested — but the validation
rigor and a missing guard-symmetry are flagged below.

## Warnings

### WR-01: f32 kernel vs f64 reference — equivalence epsilon likely under-calibrated for dim=1536

**File:** `src/retrieval/simd-kernel.wat:53-85`, `scripts/eval/51-topk-equivalence.cjs:56-58`
**Issue:** The kernel accumulates the dot product in `f32x4` lanes and multiplies by `f32`
reciprocal norms (`f32x4.add`/`f32x4.mul`/`f32x4.extract_lane`/`f32.mul`, `recipQNorm` is an
`f32` param, `rnPtr[r]` is `f32.load`). The scalar fallback (`topk.ts:440-447`) and the
brute-force reference (`cosineSimF32`, `topk.ts:201-212`) accumulate in `f64` and divide. So the
two "equivalent" paths are not the same precision class — the SIMD path has additional f32
rounding at every step.

For `dim = 1536` (the production default, `config.ts:791`) each of the 4 lanes sums ~384 f32
products; worst-case accumulation error is roughly `sqrt(384)·2⁻²⁴ ≈ 1–3e-6` in the dot product,
which propagates to the cosine. The eval's tie tolerance is `TIE_EPS = 1e-6`, and its comment
claims "a C/SIMD-vs-JS float sum-order difference on a 1536-dim dot product is far below this."
That claim conflates *sum reordering at equal precision* with *a precision-class change to f32* —
the latter can meet or exceed `1e-6`. Consequences: the boundary-tie classifier can (a) flag a
legitimate sub-error reorder as a "genuine divergence" (false gate failure), or (b) more
worryingly, let a real non-tie reordering of two genuinely-distinct nodes slip when their true
score gap is below the actual (mis-stated) error bound. The only equivalence evidence is 20 mock
queries over a single corpus; unit tests use `DIM=8` where f32 error is negligible.
**Fix:** Either (a) measure the real worst-case `max|Δscore|` for the production dim on the live
brain and set `TIE_EPS` to that empirical bound (the gate already prints `max|Δscore|` — assert it
stays under a documented threshold), or (b) reduce the precision gap by accumulating the horizontal
sum / applying the reciprocals in higher precision, or (c) at minimum correct the eval comment to
state the true f32 (not "sum-order") error model so the epsilon isn't trusted as tighter than it is.

### WR-02: `loadSimdKernel` guards `data.length` but not `norms.length` — short norms → silent NaN scores

**File:** `src/retrieval/simd-kernel.ts:64-66, 105-109`
**Issue:** The shape pre-validation checks `data.length !== count * dim` but never checks
`norms.length` against `count`. The reciprocal-norm loop reads `norms[r]!` for `r in [0, count)`;
the non-null assertion suppresses the type signal, so a `norms` shorter than `count` yields
`undefined`, and `undefined === 0` is `false` → `1 / undefined` → `NaN` written to
`recipNormsView[r]`. Every score for that row then becomes `NaN`, which silently corrupts the
top-k (a `NaN` never displaces the heap min in `partialSelectTopK`, so affected rows vanish from
results with no error). In production `norms` always equals `count` (built by `loadVectorIndex`),
so real risk is low — but the module's own header advertises "Bounds guards before any allocation;
mismatch → null," and this guard is asymmetric/incomplete.
**Fix:** Add alongside the existing shape check:
```ts
if (norms.length < count) return null;
```

### WR-03: Reproducibility gate is fragile (caret-pinned wabt + byte compare) and not wired into CI

**File:** `package.json:57,77`, `scripts/gen-simd-kernel.cjs:48-76`
**Issue:** `--check` mode compares a freshly-assembled base64 string byte-for-byte against the
committed blob, but `wabt` is pinned with a caret (`"^1.0.39"`). A patch/minor wabt resolution on
a contributor's machine can change codegen and fail `--check` even though `simd-kernel.wat` is
unchanged. Separately, no script runs `gen-simd-kernel.cjs --check` during `pretest`/`test`/CI, so
the inverse — editing the WAT without regenerating the committed blob, leaving the shipped kernel
stale relative to its source — is not caught automatically. The kernel's correctness depends on the
blob matching the reviewed WAT; nothing enforces that on the normal test path.
**Fix:** Pin wabt exactly (`"1.0.39"`, drop the caret) so the byte comparison is deterministic, and
add the check to the test gate, e.g. `"pretest": "npm run build && node scripts/gen-simd-kernel.cjs --check"`
(or a dedicated CI step), so a stale blob fails loudly.

## Info

### IN-01: Zero-norm denom guard differs in form between scalar and SIMD paths

**File:** `src/retrieval/topk.ts:444-446`, `src/retrieval/simd-kernel.ts:106-120`
**Issue:** The scalar path guards the *product* (`denom = qNorm * norms[i]; denom === 0 ? 0 : …`),
while the SIMD path guards each factor independently (`norm === 0 ? 0` and `qNorm === 0 ? 0`).
These are functionally equivalent for any realistic embedding. They diverge only under extreme
underflow (both norms ~1e-162 so their f64 product flushes to 0 while neither factor is exactly 0)
— not reachable with unit-ish embeddings. Noted for completeness; no action required unless inputs
can carry denormal-scale norms.
**Fix:** None needed; optionally document that the two guards are intended to be equivalent.

### IN-02: Eval Part-2 latency corpus zero-pads/truncates mismatched-dim rows instead of skipping

**File:** `scripts/eval/51-topk-equivalence.cjs:251-259`
**Issue:** The latency-only flat buffer uses `len = Math.min(v.length, DIMS)` and
`flat.set(v.subarray(0, len), r*DIMS)`, silently zero-padding short rows and truncating long ones —
whereas the production index (`buildVectorIndex`) *skips* dim-mismatched rows entirely. This only
affects the informational Part-2 timing (Part-1 equivalence uses the real retriever + brute force),
so it cannot mask a correctness divergence, but the timed corpus can differ subtly from production.
**Fix:** Mirror the production skip (`if (v.length !== DIMS) continue;`) for parity, or note the
divergence in the latency report.

### IN-03: `gen-simd-kernel.cjs` never calls `mod.destroy()` on the wabt module

**File:** `scripts/gen-simd-kernel.cjs:49-51`
**Issue:** The parsed wabt module is never destroyed, leaking its WASM instance. Harmless in a
one-shot CLI that exits immediately, but wabt's API expects `module.destroy()`.
**Fix:** Call `mod.destroy()` after `toBinary()` (cosmetic).

---

_Reviewed: 2026-06-30_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
