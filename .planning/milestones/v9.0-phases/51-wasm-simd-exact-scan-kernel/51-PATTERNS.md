# Phase 51: WASM SIMD Exact-Scan Kernel - Pattern Map

**Mapped:** 2026-06-30
**Files analyzed:** 5 (3 new, 1 modified, 1 new test)
**Analogs found:** 5 / 5 (every file has a concrete in-repo analog)

## File Classification

| New/Modified File (suggested path) | Role | Data Flow | Closest Analog | Match Quality |
|------------------------------------|------|-----------|----------------|---------------|
| `src/retrieval/simd-kernel.ts` (loader/wrapper: decode blob, feature-detect, instantiate, expose `scanCosine(query, data, norms, count, dim)`) | utility / loader | transform (batch matrix→scores) | `scripts/eval/49-wasm-simd-probe.cjs` (WAT + memory layout + instantiation) **and** `src/retrieval/topk.ts` `loadVectorIndex` (try/catch → null fallback) | exact (probe is the measured reference) |
| `src/retrieval/simd-kernel-wasm.ts` (committed generated base64 `.wasm` blob + decode-to-bytes) | config / generated data module | static / transform | `src/consolidation/gloss-embeddings.ts` `float32ArrayToBase64` / `base64ToFloat32Array` (base64 ↔ typed-array with alignment copy) | role-match (same base64↔buffer idiom; here bytes→`Uint8Array` not f32) |
| `scripts/gen-simd-kernel.cjs` (dev-only: read WAT → `wabt` assemble → write base64 `.ts`) + `src/retrieval/simd-kernel.wat` (in-repo WAT source) | build script + config/source | transform (codegen) | `scripts/copy-viz-assets.cjs` (dev-only `.cjs` build helper, fs writes, fail-loud) + probe `WAT`/`wabt` assemble flow | role-match (script shape) + exact (WAT/wabt usage) |
| `src/retrieval/topk.ts` `topkIndexed` (MODIFIED: call kernel w/ scalar fallback; partial-select top-k) | service method | request-response (online hot path) | itself — existing `topkIndexed` (lines 379-402) + `topk` brute-force fallback (340-366) + constructor warning (314-328) | exact (in-place modification of the analog) |
| `tests/simd-kernel.test.ts` (set-identical top-k vs `cosineSimF32`; kernel-unavailable fallback) | test | request-response | `tests/topk-index.test.ts` (set-identity + fallback cases) + `scripts/eval/41-topk-equivalence.cjs` (boundary-tie set-identity logic) | exact (same assertions, one phase prior) |

## Pattern Assignments

### `src/retrieval/simd-kernel.ts` (loader/wrapper, transform)

**Analog A — the WAT kernel + WASM memory layout** is `scripts/eval/49-wasm-simd-probe.cjs`. This is the *measured reference*; production adapts it (D-01 fuses the reciprocal-norm; D-03 inlines the blob instead of assembling WAT at runtime).

**WAT `f32x4` dot kernel** (`49-wasm-simd-probe.cjs` lines 35-61) — adapt this. D-01 changes it to also take a `normsPtr` (f64 row norms) + `qNorm` and emit cosine = `dot / (qNorm * norms[r])` directly, so the JS norm-divide loop disappears:
```wat
(module
  (import "env" "mem" (memory $mem 1))
  (func (export "scan") (param $qPtr i32) (param $mPtr i32) (param $outPtr i32) (param $n i32) (param $dimsBytes i32)
    (local $r i32) (local $i i32) (local $rowBase i32) (local $acc v128)
    ...
      (local.set $acc
        (f32x4.add (local.get $acc)
          (f32x4.mul
            (v128.load (i32.add (local.get $qPtr) (local.get $i)))
            (v128.load (i32.add (local.get $rowBase) (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 16)))   ;; 4 floats = 16 bytes per step
    ...
    (f32.store (i32.add (local.get $outPtr) (i32.mul (local.get $r) (i32.const 4)))
      (f32.add
        (f32.add (f32x4.extract_lane 0 (local.get $acc)) (f32x4.extract_lane 1 (local.get $acc)))
        (f32.add (f32x4.extract_lane 2 (local.get $acc)) (f32x4.extract_lane 3 (local.get $acc)))))
    ...))
```
Note: `dimsBytes = dim*4` and the inner stride is 16 bytes — requires `dim % 4 == 0` (1536 satisfies this; the loader must guard `dim % 4 === 0` and fall back otherwise).

**WASM memory-region layout + instantiation** (`49-wasm-simd-probe.cjs` lines 89-99) — adapt this. Single shared `WebAssembly.Memory`, three regions `[query | matrix | scores]`, page-sized with headroom:
```javascript
// ---- wasm memory layout: [query 1536f][matrix N*1536f][scores N f] ----
const qBytes=DIMS*4, mBytes=N*DIMS*4, sBytes=N*4;
const total=qBytes+mBytes+sBytes;
const pages=Math.ceil(total/65536)+4;
const memory=new WebAssembly.Memory({ initial:pages, maximum:pages });
const inst=await WebAssembly.instantiate(wasmModule, { env:{ mem:memory } });
const scan=inst.exports.scan;
const qPtr=0, mPtr=qBytes, outPtr=qBytes+mBytes, dimsBytes=DIMS*4;
new Float32Array(memory.buffer, mPtr, N*DIMS).set(flat); // load corpus once
const scoreView=new Float32Array(memory.buffer, outPtr, N);
const qView=new Float32Array(memory.buffer, qPtr, DIMS);
```
Per-query call (probe lines 105-106) — set query view, invoke `scan`, read score view:
```javascript
function wasmKernel(q){ qView.set(q.vec); scan(qPtr,mPtr,outPtr,N,dimsBytes); }
```

**Data this consumes — the `LoadedIndex` shape** (`src/retrieval/topk.ts` lines 55-64). The contiguous `data: Float32Array` is *exactly* the matrix region the kernel wants; `norms: Float64Array` is the precomputed per-row L2 norm the fused reciprocal-norm (D-01) consumes:
```typescript
interface LoadedIndex {
  dim: number;
  count: number;
  ids: string[];
  /** length = count * dim, row-major. */
  data: Float32Array;
  /** length = count; ||row_i||. */
  norms: Float64Array;
}
```
Discretion note (CONTEXT D-09): the WAT folds reciprocal-norm using `norms` already on the index — do NOT recompute. If WAT can only consume f32, pass a per-call f64→f32 norm copy or divide in WAT via an f32 norms region; pick whichever keeps the kernel simplest while emitting cosine directly.

**Analog B — the silent-fallback try/catch** is `loadVectorIndex` (`src/retrieval/topk.ts` lines 153-191). The kernel loader must mirror this exact shape: `try { detect + instantiate; return wrapper } catch { return null }`. D-08 requires SIMD-missing / instantiation-error / `dim % 4 !== 0` / dim-mismatch ALL return null → scalar fallback, never throw:
```typescript
function loadVectorIndex(indexPath: string): LoadedIndex | null {
  try {
    if (!existsSync(indexPath)) return null;
    ...
    return { dim, count, ids, data, norms };
  } catch {
    return null;
  }
}
```
Feature-detection (Claude's discretion per D-09): validate the SIMD opcodes compile via `WebAssembly.validate(bytes)` on the inlined blob (it contains `v128`/`f32x4` ops, so validation fails on a runtime without SIMD), then `WebAssembly.compile`; any throw → null.

---

### `src/retrieval/simd-kernel-wasm.ts` (generated base64 blob module, static)

**Analog** is `src/consolidation/gloss-embeddings.ts` (lines 97-110) — the project's established base64 ↔ typed-array idiom, including the **mandatory alignment copy** (`readFileSync`/`Buffer.from(b64,'base64')` carry no alignment guarantee — `loadVectorIndex` lines 179-185 has the same caveat). The blob here is raw `.wasm` bytes (`Uint8Array`), so adapt to bytes-not-f32, but reuse the alignment-copy structure:
```typescript
/** Encode a Float32Array as a base64 string (browser-compatible via Buffer on Node). */
function float32ArrayToBase64(arr: Float32Array): string {
  const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return bytes.toString('base64');
}

/** Decode a base64 string back to a Float32Array. */
function base64ToFloat32Array(b64: string): Float32Array {
  const bytes = Buffer.from(b64, 'base64');
  // Ensure alignment: copy to a new ArrayBuffer to guarantee 4-byte alignment
  const aligned = new ArrayBuffer(bytes.length);
  Buffer.from(aligned).set(bytes);
  return new Float32Array(aligned);
}
```
For the kernel: this module exports a `const WASM_BASE64 = '...'` plus a `wasmBytes(): Uint8Array` that does `Buffer.from(WASM_BASE64, 'base64')` (no f32 view needed — `WebAssembly.compile` takes the `BufferSource` directly, alignment-agnostic). D-03: committed, generated, loads with zero FS access. Mark the file as generated (see generated-file header convention in `scripts/copy-viz-assets.cjs` comment style) and do-not-edit-by-hand.

---

### `scripts/gen-simd-kernel.cjs` + `src/retrieval/simd-kernel.wat` (dev-only regen script + WAT source)

**Analog A — dev-only `.cjs` build helper shape** is `scripts/copy-viz-assets.cjs` (lines 1-40). Same conventions: `#!/usr/bin/env node`, top doc-comment explaining *why* it exists and that it runs at build/dev time only, `require('fs')` destructure, fail-loud on missing input (`console.error(...); process.exit(1)`), success `console.log`. Crucially per D-04 it is a STANDALONE manual dev command — it must NOT be wired into `postbuild`/`postinstall` (copy-viz-assets IS in `postbuild`; the regen script must NOT be, or `wabt` would be pulled into production install):
```javascript
#!/usr/bin/env node
/**
 * copy-viz-assets — ship the viz frontend into dist.
 * ...
 */
const { cpSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');
const root = join(__dirname, '..');
...
for (const name of assets) {
  const from = join(srcDir, name);
  if (!existsSync(from)) {
    console.error(`copy-viz-assets: missing source asset ${from}`);
    process.exit(1);
  }
  ...
}
console.log('copy-viz-assets: ...');
```

**Analog B — the WAT→bytes assembly via `wabt`** is `49-wasm-simd-probe.cjs` (lines 63-67). The regen script reads `simd-kernel.wat`, assembles with `simd:true`, then base64-encodes the binary and writes `simd-kernel-wasm.ts` (the inverse of the probe, which keeps bytes in memory):
```javascript
const wabt = await wabtInit();
const mod = wabt.parseWat('dotscan.wat', WAT, { simd: true });
const { buffer: wasmBytes } = mod.toBinary({});
const wasmModule = await WebAssembly.compile(wasmBytes);
```
`wabt` is already a devDep (`package.json` line 76) — D-04 keeps it dev-only. Build is `tsc` only (`package.json` line 36), no bundler, so the inlined `.ts` blob is the only portable option.

---

### `src/retrieval/topk.ts` — `topkIndexed` MODIFIED (service method, request-response hot path)

**Analog is the method itself** (lines 379-402). Today it does scalar dot + per-row norm-divide + full `.sort()`. The modification: (a) call the kernel for the dot+cosine fold (D-01), (b) replace `.sort().slice(0,k)` with a partial-select (D-02), (c) on `kernel === null` keep the existing scalar loop verbatim (D-08):
```typescript
private topkIndexed(queryVec: Float32Array, k: number): Array<{ id: string; score: number }> {
  const idx = this.index!;
  if (queryVec.length !== idx.dim) return [];            // L-2 dim-mismatch skip — KEEP

  let qNorm = 0;
  for (let j = 0; j < idx.dim; j++) qNorm += queryVec[j]! * queryVec[j]!;
  qNorm = Math.sqrt(qNorm);

  const { dim, count, data, norms, ids } = idx;
  const scored: Array<{ id: string; score: number }> = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * dim;
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += queryVec[j]! * data[base + j]!;   // ← kernel replaces this loop + the divide
    const denom = qNorm * norms[i]!;
    scored[i] = { id: ids[i]!, score: denom === 0 ? 0 : dot / denom };      // same denom guard as cosineSimF32
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);              // ← D-02: replace with partial-select
}
```
Preserve EXACTLY: the `queryVec.length !== idx.dim → return []` guard, the `denom === 0 ? 0` guard (matches `cosineSimF32` line 209-210), and the byte-equivalence contract in the docstring (lines 368-378, update to note f32x4 horizontal-sum ordering per D-07). The kernel handle is loaded once (constructor or module-init) alongside `this.index`; when null, the scalar body above runs unchanged.

**Partial-select (D-02)** replaces `.sort(...).slice(0,k)`. No existing partial-select in repo — net-new. Keep it pure JS, trivially verifiable (a fixed-size min-heap of size k, or quickselect on an index array). Must produce a set-identical result to the full sort (tolerating identical-score tie reorder, per D-07). Choice of heap vs quickselect is Claude's discretion.

**Constructor load + stderr-warning pattern** (lines 314-328) is the analog for wiring the kernel handle. Mirror it: attempt load, on null emit a one-line stderr warning (never stdout — hot path emits structured output) and proceed with scalar:
```typescript
if (opts?.indexPath) {
  this.index = loadVectorIndex(opts.indexPath);
  if (this.index === null) {
    process.stderr.write(
      `[recense] vector index unavailable at ${opts.indexPath} — falling back to brute-force scan\n`,
    );
  }
} else {
  this.index = null;
}
```

**LEAVE UNTOUCHED (D-06):** `cosineSimF32` (200-211), brute-force `topk` (340-366), `topkTombstoned` (409-426). Their per-row `Buffer` decode (Pitfall 5: `new Float32Array(buf, byteOffset, len/4)`) is awkward for WASM's contiguous model and they run cold.

---

### `tests/simd-kernel.test.ts` (test, request-response)

**Analog is `tests/topk-index.test.ts`** — same fixture machinery and the two cases this phase needs already exist there one phase prior.

**Set-identity assertion** (topk-index.test.ts lines 130-152) — the D-07 bar. Note `idSet(got)).toEqual(idSet(ref))` for set-identity and `toBeCloseTo(refScore, 6)` for scores (NOT `toBe` — D-07 forbids bitwise gating; sub-ULP f32x4 horizontal-sum differences are accepted):
```typescript
const got = indexed.topk(q, k);
const ref = bruteforceTopk(livePairs, q, k);
expect(idSet(got)).toEqual(idSet(ref));               // set-identical (D-07 recall@10=1.000)
const refScore = new Map(ref.map(r => [r.id, r.score]));
for (const hit of got) {
  expect(hit.score).toBeCloseTo(refScore.get(hit.id)!, 6);   // close, NOT bitwise-equal (D-07)
  expect(hit.score).not.toBe(0);
}
```

**Fixture + brute-force reference helpers** (lines 41-90) — reuse directly: `vec(seed)` deterministic vectors, `bruteforceTopk` ground truth via `cosineSimF32`, temp-file DB + `initSchema` + `SemanticStore.upsertNode`/`setEmbedding` + `buildVectorIndex` to persist a real sidecar. **Important:** use `DIM` divisible by 4 (the file uses `DIM = 8`, which works — keep a `% 4 === 0` dim so the SIMD path actually exercises, not just the fallback).

**Kernel-unavailable fallback case** (lines 154-171) — adapt this fallback test to force the *kernel* (not the index) unavailable and assert set-identical results to the scalar scan. The mechanism to simulate kernel-unavailability is Claude's discretion (e.g. inject a null kernel / a dim not divisible by 4 / a forced detect-fail), mirroring how case 2 simulates a missing artifact:
```typescript
const fallback = new CandidateRetriever(db, { indexPath });
const bruteforce = new CandidateRetriever(db); // no index — the consolidator path
const a = fallback.topk(q, 10);
const ref = bruteforceTopk(livePairs, q, 10);
expect(idSet(a)).toEqual(idSet(ref));
```

**Boundary-tie set-identity logic** (`scripts/eval/41-topk-equivalence.cjs` doc lines, the "± tie reorder" handling) — the existing live-brain gate that already operationalizes D-07. The new kernel inherits this gate; the unit test just needs the simpler `idSet().toEqual()` + `toBeCloseTo` since fixture vectors avoid exact-score ties at the k-boundary. Reference it so the planner knows the live-brain equivalence is covered by extending `41-topk-equivalence.cjs` (or a `51-` sibling), not only the unit test.

---

## Shared Patterns

### Silent fallback — corrupt/unavailable derived artifact is never authoritative (D-08, T-41-04)
**Source:** `src/retrieval/topk.ts` `loadVectorIndex` (153-191, try/catch→null) + constructor stderr warning (318-324) + `topk` index-null drop-through (346-348).
**Apply to:** `simd-kernel.ts` loader (return null on any detect/instantiate failure) and `topkIndexed` (kernel-null → existing scalar body). A kernel fault MUST behave exactly like a missing sidecar: warn once to stderr, fall back, never throw, never break recall.

### Float32Array / buffer alignment copy
**Source:** `gloss-embeddings.ts` `base64ToFloat32Array` (104-110) and `loadVectorIndex` (179-185 — "no alignment guarantee for a 4/8-byte typed-array view at an arbitrary byteOffset").
**Apply to:** the base64 blob decode (`simd-kernel-wasm.ts`) and any typed-array view created over `memory.buffer` regions. `WebAssembly.compile` is alignment-agnostic for the blob bytes, but f32 views over WASM memory must sit at 16-byte-aligned region offsets for `v128.load` (the probe's `qPtr=0`, `mPtr=qBytes`, `outPtr=qBytes+mBytes` are all multiples of `DIMS*4` = 6144 bytes → aligned; preserve this when laying out regions).

### Denom guard (cosine never NaN/Infinity)
**Source:** `cosineSimF32` line 209-210 and `topkIndexed` line 397-398: `denom === 0 ? 0 : dot / denom`.
**Apply to:** the fused reciprocal-norm in the kernel/wrapper — a zero query-norm or zero row-norm must yield score 0, never NaN. If folded in WAT, guard in JS at the boundary or ensure `norms[i] || 1` semantics match the scalar path.

### Pitfall 5 — Buffer view with byteOffset + length
**Source:** `topk.ts` lines 88-89, 354-359 (`new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)`).
**Apply to:** any place the new code re-decodes embeddings from DB BLOBs (the test fixture path). The hot kernel path consumes the already-contiguous `LoadedIndex.data`, so it sidesteps this — but the tests that seed via `setEmbedding` and the live-brain gate must keep the byteOffset-aware decode.

### Read-only on the graph (online path)
**Source:** `topk.ts` header (lines 5-9): retrieval never writes embeddings; graph is source of truth, vector index is a derived cache.
**Apply to:** all new code. The kernel reads `LoadedIndex` and `WebAssembly.Memory`; it writes nothing to the DB. No sleep-pass change (the sidecar it scans is already built end-of-pass in Phase 41).

## No Analog Found

| Component | Role | Data Flow | Reason / guidance |
|-----------|------|-----------|-------------------|
| Partial-select top-k (heap / quickselect) | utility | transform | No existing partial-select in repo — every top-k today is `.sort().slice(k)` (`topk.ts` 364, 401, 425; `rrfFuse` 252-255; probe `topkFromScores` line 31). Net-new but small/standard; verify set-identical to the full sort (RESEARCH/standard algorithm, not a codebase pattern). |
| WASM SIMD feature-detection mechanism | utility | — | No WASM anywhere in `src/` today (probe is the only WASM, and it assumes SIMD). The detect mechanism is genuinely new (D-09 discretion) — use `WebAssembly.validate` on the SIMD-bearing blob + try/catch compile. The *behavior* (silent scalar fallback) has an analog (above); the *detection code* does not. |

## Metadata

**Analog search scope:** `src/retrieval/`, `src/consolidation/`, `scripts/`, `scripts/eval/`, `tests/`.
**Files scanned:** topk.ts, 49-wasm-simd-probe.cjs, 49-SPIKE-FINDINGS.md, gloss-embeddings.ts, copy-viz-assets.cjs, 41-topk-equivalence.cjs, topk-index.test.ts, package.json.
**Pattern extraction date:** 2026-06-30
