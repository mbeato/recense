# Phase 51: WASM SIMD Exact-Scan Kernel - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-30
**Phase:** 51-wasm-simd-exact-scan-kernel
**Areas discussed:** Kernel scope, Packaging, Scan-path coverage, Exactness bar

> Note: questions were re-explained in plain language (jargon stripped) at the founder's
> request before answers were given. Founder's first-pass intent was "move as much as we can
> to WASM to speed up everything" + "accept same memories"; Claude surfaced the
> diminishing-returns ceiling on kernel scope, then gave pros/cons + a recommendation on
> packaging and coverage, which the founder locked.

---

## Kernel scope (what runs in WASM vs JS)

| Option | Description | Selected |
|--------|-------------|----------|
| Dot + reciprocal-norm in WASM; partial-select top-k in JS | Kernel emits cosine directly; JS does fast top-K pick. Spike's measured "full win". | ✓ |
| Bare dot only | WASM multiply only; norm-divide + full sort stay scalar. Leaves ~2.5× ceiling. | |
| Everything in WASM (incl. selection) | Max in theory; partial-select in WASM is fiddly, hard to verify, ~no extra speed. | |

**User's choice:** "okay to move as much as we can to speed up everything" → resolved, after
Claude flagged the ceiling, to dot + reciprocal-norm in WASM with a JS partial-select top-k.
**Notes:** Claude explained that the *sort* is the one place "more WASM" stops buying speed and
starts buying risk; founder accepted stopping at the proven full-win line rather than forcing
selection into WASM.

---

## Packaging (how the prebuilt `.wasm` ships and loads)

| Option | Description | Selected |
|--------|-------------|----------|
| Bake into code (base64-inline a committed `.ts`) | Zero runtime path resolution; survives any install/bundle layout; tiny blob. | ✓ |
| Commit `.wasm`, read from disk | Tidy but adds runtime path resolution — classic install/bundle breakage source. | |
| Assemble from WAT at build | Makes wabt a build dep + build step; risks the "no compiler on user machine" property. | |

**User's choice:** "not sure, need pros and cons / what you think is best" → accepted Claude's
recommendation: bake into code (base64-inline).
**Notes:** Rationale — the whole reason WASM was chosen over the faster-but-fragile ANN path was
"installs everywhere." Inlining is the most bulletproof version of that; blob is small enough
that inlining is free. `wabt` stays dev-only with a regeneration script.

---

## Scan-path coverage

| Option | Description | Selected |
|--------|-------------|----------|
| `topkIndexed` only (the hot path) | Constantly-used online scan; contiguous layout already WASM-ready. Biggest felt win, smallest change. | ✓ |
| Indexed + tombstoned | Also the rare "deleted" second scan; needs per-row Buffer marshaling for modest gain. | |
| All cosine paths | Includes brute-force fallback + cosineSimF32; most marshaling for paths that rarely run. | |

**User's choice:** deferred to Claude ("same as 2") → accepted recommendation: hot path only.
**Notes:** Reconciled with the "speed up everything" intent — "everything" in practice means the
path users feel; the rare/cold backup paths give no perceptible benefit and add risk/code.

---

## Exactness bar

| Option | Description | Selected |
|--------|-------------|----------|
| Set-identical top-k (recall@10 = 1.000) | Same memories returned; accept sub-ULP score wiggle from FP summation order. | ✓ |
| Bitwise-identical scores | Forces matching scalar summation order; defeats SIMD parallelism. Overkill. | |
| You decide on the bar | Defer to planner/researcher. | |

**User's choice:** "accept same memories" → set-identical top-k.
**Notes:** Explained that differing add-order in `f32x4` makes scores differ only in the last
float bit — physics of floating point, not an error, imperceptible. The roadmap's "byte-exact"
is operationalized as set-identity, not bitwise score identity.

---

## Claude's Discretion

- WASM SIMD feature-detection mechanism + Node-version-floor handling (the *behavior* — silent
  scalar fallback — is locked as D-08; the detection code shape is Claude's).
- WASM memory layout / instantiation details (adapt the probe's working layout).
- Partial-select algorithm choice (binary heap vs quickselect).
- Whether the fused reciprocal-norm reuses the sidecar's precomputed `norms` vs recomputes.

## Deferred Ideas

- ANN / HNSW (native or WASM-HNSW) — future-trigger only (~30k nodes or >40ms felt p95);
  out of this phase per the Phase-49 spike.
- Pushing top-k selection into WASM — deliberately not done (diminishing returns); revisit only
  if profiling ever shows the JS partial-select dominating.
