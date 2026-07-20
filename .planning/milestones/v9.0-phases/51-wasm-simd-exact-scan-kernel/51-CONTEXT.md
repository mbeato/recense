# Phase 51: WASM SIMD Exact-Scan Kernel - Context

**Gathered:** 2026-06-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the scalar-JS inner dot-product loop in the exact cosine retrieval scan with a
portable WASM `f32x4` SIMD kernel. Same math, **exact** results (no approximation), ~4.9×
kernel / ~2.5×→ full-path speedup measured in the Phase-49 spike. Removes scale pressure to
~85k–190k embedded nodes with zero new native dependencies and zero approximation surface;
defers ANN/HNSW entirely (a future-only trigger past ~30k nodes of real felt-path pressure).

The kernel plugs into the existing persisted flat-buffer vector index in
`src/retrieval/topk.ts` (`topkIndexed`). The Phase-49 `49-wasm-simd-probe.cjs` hand-WAT
`f32x4` dot kernel is the measured reference implementation.

**Locked upstream by the Phase-49 spike — NOT re-opened here:** WASM-over-ANN decision; the
`f32x4` SIMD dot-product approach; exact-correctness target; the "installs everywhere"
portability requirement (prebuilt `.wasm`, no node-gyp). Depends on Phase 50 (its regression
gates catch any retrieval regression this kernel could introduce).

</domain>

<decisions>
## Implementation Decisions

### Kernel scope — what runs in WASM vs JS
- **D-01:** The WASM kernel computes the **dot product AND folds the per-row reciprocal-norm**,
  so it emits cosine scores directly (one pass, no separate scalar norm-divide loop). This is
  the spike's measured "full win" path.
- **D-02:** **Top-k selection stays in JS**, but upgraded from a full `.sort()` to a
  **partial-select** (heap / quickselect — fish out the best K, don't sort all N). Rationale:
  partial-select is fast and trivially verifiable in JS; pushing the *selection* into WASM is
  fiddly, hard to keep exact-verifiable, and buys ~no additional speed. This is the deliberate
  diminishing-returns ceiling — the founder confirmed stopping here over a full-WASM selection.
  ("Move as much as we can to speed up everything" resolved to: all the work that actually
  buys speed → WASM; the sort → fast JS partial-select.)

### Packaging / how the `.wasm` ships and loads
- **D-03:** Ship the prebuilt `.wasm` **baked into the code as a base64-inlined module**
  (committed generated `.ts`), so it loads with **zero runtime filesystem/path resolution** and
  survives any install/bundle/dist layout. The blob is tiny, so inlining cost is negligible.
- **D-04:** Keep the **WAT source in-repo** plus a **dev-only regeneration script** (assemble
  WAT → `.wasm` → base64 via the existing `wabt` devDep) so the inlined blob is reproducible and
  reviewable. `wabt` stays a **devDependency only** — it MUST NOT enter the production install or
  a post-install/build step (that would forfeit the "no compilation on the user's machine /
  installs everywhere" property that motivated choosing WASM).

### Scan-path coverage
- **D-05:** Accelerate **only the persisted-index hot path (`topkIndexed`)** — the
  contiguous flat-buffer scan that runs on every online retrieval (SessionStart inject, recall,
  ambient). It is both the felt-latency path and the one whose memory layout already suits WASM.
- **D-06:** **Leave the scalar fallbacks untouched:** the brute-force `topk` (no-sidecar /
  corrupt-sidecar fallback), `topkTombstoned` (the "deleted" second scan), and the 2-vector
  `cosineSimF32` helper stay pure JS. They run rarely/cold and their per-row `Buffer` decode is
  awkward for WASM's contiguous-memory model — WASM-ifying them is extra marshaling for speed no
  one perceives. "Speed up everything" = speed up everything that's *felt*, not the rare paths.

### Correctness acceptance bar
- **D-07:** "Exact" means **set-identical top-k** — the returned top-K node id set is identical
  to the scalar `cosineSimF32` scan (recall@10 = 1.000 over the live brain). Sub-ULP score
  differences from `f32x4` horizontal-sum ordering vs sequential scalar summation are **accepted
  and expected** (it is the same dot product, not an approximation). Do NOT gate on
  bitwise-identical scores — that would force matching the scalar summation order and defeat the
  SIMD parallelism that is the whole point. The roadmap's "byte-exact (recall@10=1.000)" framing
  is operationalized as this set-identity bar.

### Load-bearing invariants carried forward (must hold)
- **D-08:** Graph is source of truth; the vector index is a **derived, rebuildable cache**. A
  WASM-kernel failure (SIMD unavailable on an old Node, instantiation error, dim mismatch) MUST
  **silently fall back** to the existing scalar scan and never break recall — mirroring the
  current corrupt-sidecar → brute-force fallback (`topk.ts:318-327`). A kernel fault is never
  authoritative. (Detection/fallback mechanism is Claude's discretion per D-09; the *requirement*
  that it fall back safely is locked.)

### Claude's Discretion
- WASM SIMD feature-detection mechanism and the Node-version floor handling (D-08 fixes the
  *behavior* — silent scalar fallback — not the detection code shape).
- Memory layout / instantiation details (single shared `WebAssembly.Memory`, query+matrix+scores
  regions, page sizing) — the probe demonstrates a working layout to adapt.
- Exact partial-select algorithm (binary heap vs quickselect) for D-02.
- Whether the fused reciprocal-norm reads the precomputed `norms` already in the sidecar vs
  recomputing — pick whatever keeps the kernel simplest while emitting cosine directly.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase-49 spike (the decision + measured reference kernel — read FIRST)
- `.planning/phases/49-scale-data-model-spike/49-SPIKE-FINDINGS.md` — SCALE-01 final
  recommendation: build a WASM SIMD exact-scan kernel, do NOT adopt ANN. Contains the measured
  numbers (kernel ~4.9×, full ~2.5×, recall@10=1.000), the decision matrix, and the rationale for
  every locked-upstream choice above. The "byte-exact" / headroom-to-~85k–190k claims originate here.
- `scripts/eval/49-wasm-simd-probe.cjs` — the hand-written WAT `f32x4` dot kernel + WASM memory
  layout that was measured. **The reference implementation to adapt** (note: it assembles WAT via
  `wabt` at runtime for measurement — production inlines a prebuilt blob per D-03/D-04).

### Integration target (the code this phase modifies)
- `src/retrieval/topk.ts` §`topkIndexed` (lines ~379-402) — the persisted flat-buffer exact scan
  to accelerate (D-05). Note the precomputed `norms` (Float64Array) already on the loaded index.
- `src/retrieval/topk.ts` §`CandidateRetriever` constructor (lines ~292-328) + §`topk`
  (lines ~340-366) — the existing corrupt-sidecar → brute-force fallback pattern to mirror for
  the WASM-unavailable fallback (D-08).
- `src/retrieval/topk.ts` §`cosineSimF32` (lines ~200-211) — the scalar ground-truth the
  set-identity bar (D-07) is measured against. Leave untouched (D-06).

### Build / packaging context
- `package.json` — `build: "tsc"` (no bundler step today); `wabt: "^1.0.39"` already a devDep
  (D-04 keeps it dev-only). No `"files"` field currently — relevant if reconsidering on-disk
  shipping, but D-03 inlines so npm-publish file inclusion is moot.

### Phase dependency
- `.planning/phases/50-verification-regression-gates/` — Phase 50 regression gates that must
  catch any retrieval regression from this kernel (roadmap: "Depends on 50 (gates catch any
  regression)").

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`topk.ts` persisted flat-buffer index** — the loaded `LoadedIndex` already holds a
  contiguous `data: Float32Array` (row-major, `count*dim`) plus precomputed `norms: Float64Array`.
  This is exactly the contiguous layout the WASM kernel wants — no new marshaling needed for the
  hot path. The fused reciprocal-norm (D-01) can consume the existing `norms`.
- **`49-wasm-simd-probe.cjs`** — working WAT kernel + `WebAssembly.Memory` region layout
  (query / matrix / scores) and instantiation flow to adapt for production.
- **Existing fallback pattern** — `loadVectorIndex` returns null → `topk` drops to brute-force;
  the constructor emits a one-line stderr warning. The WASM-unavailable fallback (D-08) reuses
  this exact shape.

### Established Patterns
- Read-only on the graph in retrieval (`topk` never writes embeddings).
- Online hot path is LLM-free and latency-sensitive; all heavy/offline cost lives in the sleep
  pass. This kernel is pure online-path acceleration — no sleep-pass change required (the sidecar
  it scans is already built end-of-pass in Phase 41).
- Corrupt/missing derived-cache artifacts never become authoritative (T-41-04).

### Integration Points
- New code connects at `topkIndexed` only (D-05). The kernel module is loaded once (constructor
  or module-init), feature-detected, and either used or bypassed in favor of the existing scalar
  loop (D-08).

</code_context>

<specifics>
## Specific Ideas

- Founder's framing of the goal: "move as much as we can to WASM to speed up everything" —
  resolved to D-01/D-02 (all speed-buying work in WASM; the sort stays a fast JS partial-select)
  and D-05/D-06 (speed up the felt path, not the rare cold paths). "Speed up everything" ≡ "speed
  up everything that's actually felt."
- Correctness intent stated plainly: "accept same memories" → D-07 set-identical top-k bar.

</specifics>

<deferred>
## Deferred Ideas

- **ANN / HNSW (native or WASM-HNSW)** — explicitly deferred by the Phase-49 spike to a future
  trigger only: revisit when the live brain approaches ~30k embedded nodes OR full felt-path warm
  p95 exceeds ~40ms in production. Not in this phase. The WASM exact kernel removes the pressure
  that would have forced it (~85k–190k node headroom; brain is at ~14k).
- **Pushing top-k selection into WASM** — considered and deliberately not done (D-02);
  diminishing returns. Could be revisited only if profiling ever shows the JS partial-select
  dominating, which the spike's numbers do not predict at realistic scale.

None — discussion otherwise stayed within phase scope.

</deferred>

---

*Phase: 51-wasm-simd-exact-scan-kernel*
*Context gathered: 2026-06-30*
