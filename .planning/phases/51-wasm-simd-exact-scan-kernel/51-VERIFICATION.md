---
phase: 51-wasm-simd-exact-scan-kernel
verified: 2026-06-30T18:30:00Z
status: passed
score: 3/3 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 2/3 (1 uncertain)
  gaps_closed:
    - "SC2 — real-embedding equivalence proof at production dim=1536: recall@10=1.0000, max|Δscore|=1.801e-7 (< 1e-6 budget, not widened)"
    - "WR-01 — TIE_EPS comment corrected from 'sum-order difference' to f32-vs-f64 precision-class; OPENAI_API_KEY fail-loud guard; hard MAX_DELTA_BUDGET=1e-6 assertion"
    - "WR-02 — norms.length < count guard added to loadSimdKernel (simd-kernel.ts:68); JSDoc updated; regression test added (14/14)"
    - "WR-03 — pretest wired to gen-simd-kernel.cjs --check; wabt pinned exact 1.0.39 (no caret)"
  gaps_remaining: []
  regressions: []
---

# Phase 51: WASM SIMD Exact-Scan Kernel Verification Report

**Phase Goal:** Replace the scalar-JS exact cosine scan on the LLM-free retrieval hot path
with a portable, prebuilt WASM SIMD (f32x4) dot-product kernel — keeping the flat brute-force
structure and byte-exact recall, while cutting scan latency ~4–5x, with zero new native dependencies.

**Verified:** 2026-06-30T18:30:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (plans 51-04 and 51-05)

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Prebuilt .wasm f32x4 kernel checked into repo, used by topk.ts, no native deps at install | VERIFIED | `simd-kernel-wasm.ts` base64 blob; `topk.ts` imports and calls `loadSimdKernel` at lines 13/297/341/432; wabt devDep only; pretest now also runs `--check` byte-compare (WR-03 closed) |
| 2 | Recall@10=1.000 vs scalar scan; max\|Δscore\| < TIE_EPS; verified scalar fallback when SIMD unavailable | VERIFIED | `--real-embed` gate ran on live brain (15,943 nodes, `text-embedding-3-small`, dim=1536): `equivalent=true`, 40/40 checks, failures=0, max\|Δscore\|=1.801e-7 (5.5× under MAX_DELTA_BUDGET=1e-6, not widened), recall@10=1.0000; fallback confirmed by DIM=9 integration test |
| 3 | ~4–5x scan latency improvement; Phase-50 gates pass | VERIFIED | Real-embed run: kernel 4.64×, full per-query 4.74×; 6/6 integration tests pass (topk-simd + topk-index); no changes to topk.ts hot path |

**Score:** 3/3 truths verified

---

### SC2 Gap Closure — Evidence and Adversarial Checks

**Was the epsilon widened to pass?** No. `MAX_DELTA_BUDGET` remains `1e-6` (= `TIE_EPS`). The
observed max\|Δscore\| is 1.801e-7 — 5.5× below the budget. `budget_breached=false` in the
recorded JSON. The 51-05-SUMMARY explicitly states "TIE_EPS/MAX_DELTA_BUDGET were NOT widened."

**Was the recall inflation (0.995 → 1.000) a code change?** No. The root cause was a stale
`.vindex` sidecar (15,828 indexed vs 15,933 live nodes at first run, missing compound `super::` nodes).
The f32 kernel produced identical max\|Δ\|=1.8e-7 in both runs — the misses were brute-force-only
entries absent from the index cache, not kernel-induced divergences. Rebuilding the sidecar (the
derived cache; graph is source of truth) with no code change moved recall 0.995 → 1.000.

**Is the fail-loud gate meaningful?** Yes. The hardened gate:
- Exits 3 if `OPENAI_API_KEY` is absent (no silent zero-vector vacuous pass)
- Exits 3 if any query vector is zero/NaN after embedding
- Exits 1 if `maxDelta >= MAX_DELTA_BUDGET` (hard budget breach — never widen-to-pass)
- The recorded run used `embed="text-embedding-3-small"` (real model, not mock)

**Was "sum-order" comment corrected?** Confirmed by grep — `sum-order` no longer appears in
the TIE_EPS comment region. The comment now correctly names the f32-vs-f64 precision-CLASS
difference and the dim=1536 worst-case accumulation error bound.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/retrieval/simd-kernel.wat` | Fused f32x4 cosine WAT source | VERIFIED | 89 lines; 7 f32x4 occurrences; `scan` signature with `rnPtr`/`recipQNorm`; unchanged |
| `scripts/gen-simd-kernel.cjs` | Dev-only WAT→wasm→base64 regen + `--check` | VERIFIED | `--check` exits 0: "reproducibility OK + cosine self-test OK"; confirmed live |
| `src/retrieval/simd-kernel-wasm.ts` | Committed base64 .wasm blob + `wasmBytes()` | VERIFIED | Unchanged from initial verification; blob matches WAT per `--check` |
| `src/retrieval/simd-kernel.ts` | Blob decode + SIMD detect + instantiate-once loader, scanCosine, partialSelectTopK | VERIFIED | 218 lines (2 added for norms guard); norms.length guard at line 68; JSDoc updated (line 10); WR-02 closed |
| `tests/simd-kernel.test.ts` | Unit tests: scanCosine set-identity, partial-select equivalence, fallback-null | VERIFIED | 14/14 pass (was 13/13); new test: short norms (count-1) → null |
| `src/retrieval/topk.ts` | topkIndexed wired to kernel + partial-select, verbatim scalar fallback | VERIFIED | Unchanged; import line 13; kernel field line 297; load lines 341–353; SIMD path lines 427–432; scalar fallback lines 436–448 |
| `tests/topk-simd.test.ts` | Integration: SIMD set-identity + forced fallback | VERIFIED | 2/2 pass (DIM=8 SIMD, DIM=9 forced scalar fallback) |
| `scripts/eval/51-topk-equivalence.cjs` | Hardened live-brain equivalence gate + latency report | VERIFIED | Fail-loud OPENAI_API_KEY guard; MAX_DELTA_BUDGET=1e-6 hard assertion; recall@10 metric; precision-class comment; real-embed run recorded to JSON |
| `scripts/eval/results/51-topk-equivalence.json` | Real-embed run result | VERIFIED | `equivalent=true`, 40/40, failures=0, max_score_delta=1.801e-7, budget_breached=false, recall_at_10.mean=1, embed="text-embedding-3-small" |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/retrieval/topk.ts` | `src/retrieval/simd-kernel.ts` | `import { loadSimdKernel, partialSelectTopK, type SimdKernel }` | WIRED | Line 13; used at lines 297, 341, 432, 448 |
| `src/retrieval/simd-kernel.ts` | `src/retrieval/simd-kernel-wasm.ts` | `import { wasmBytes }` | WIRED | Line 31; called at line 74 inside loadSimdKernel |
| `scripts/gen-simd-kernel.cjs` | `src/retrieval/simd-kernel.wat` | `readFileSync` | WIRED | Reads WAT as wabt input |
| `scripts/gen-simd-kernel.cjs` | `src/retrieval/simd-kernel-wasm.ts` | `writeFileSync` | WIRED | Default mode writes generated base64 blob |
| `package.json:pretest` | `scripts/gen-simd-kernel.cjs --check` | npm lifecycle | WIRED | `"pretest": "npm run build && node scripts/gen-simd-kernel.cjs --check"` — WR-03 closed |
| `scripts/eval/51-topk-equivalence.cjs` | WASM-indexed CandidateRetriever | `new CandidateRetriever(db, { indexPath }).topk(q, k)` | WIRED | Line 197; real-embed equivalence gate confirmed live |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `topk.ts:topkIndexed` (SIMD path) | `this.kernel.scanCosine(queryVec, qNorm)` | Real WASM memory loaded from .vindex sidecar at construction | Yes | FLOWING |
| `topk.ts:topkIndexed` (scalar fallback) | `scores: Float32Array` → `partialSelectTopK` | Real f32 matrix from .vindex sidecar | Yes | FLOWING |
| `scripts/eval/51-topk-equivalence.cjs` | `indexed.topk(q, k)` results | Live brain DB + sidecar (15,943 nodes; key guard exits 3 if sidecar absent) | Yes — real OpenAI embeddings, confirmed by `embed="text-embedding-3-small"` in JSON | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| simd-kernel unit tests: 14 cases including short-norms → null | `npx vitest run tests/simd-kernel.test.ts` | 14/14 pass (127ms) | PASS |
| topk-simd + topk-index integration (SIMD path + forced scalar fallback) | `npx vitest run tests/topk-simd.test.ts tests/topk-index.test.ts` | 6/6 pass (198ms) | PASS |
| gen-simd-kernel --check: committed blob matches WAT | `node scripts/gen-simd-kernel.cjs --check` | "reproducibility OK + cosine self-test OK" exit 0 | PASS |
| package.json: pretest includes --check and wabt exact-pinned | `node -e "const p=require('./package.json'); process.exit(p.scripts.pretest.includes('gen-simd-kernel.cjs --check') && p.devDependencies.wabt==='1.0.39' ? 0 : 1)"` | exit 0 | PASS |
| norms.length guard present in simd-kernel.ts | `grep -n "norms.length" src/retrieval/simd-kernel.ts` | Lines 10, 68 | PASS |
| TIE_EPS comment no longer says "sum-order" | `grep -c "sum-order" scripts/eval/51-topk-equivalence.cjs` | 0 | PASS |
| Real-embed JSON: budget not breached, recall@10=1.000 | `node -e "const r=require('./scripts/eval/results/51-topk-equivalence.json'); process.exit(r.equivalence.budget_breached||r.equivalence.recall_at_10.mean!==1||r.equivalence.failures!==0?1:0)"` | exit 0 | PASS |

---

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SCALE-03 | 51-01, 51-02, 51-03, 51-04, 51-05 | Portable WASM SIMD f32x4 dot-product kernel; prebuilt .wasm; byte-exact recall@10=1.000; ~4–5x faster scan; reciprocal-norm + partial-select top-k | SATISFIED | All three SC fully verified; real-embed run at dim=1536 on 15,943-node live brain; WR-01/02/03 all closed |

Note: REQUIREMENTS.md line 40 still shows `- [ ] SCALE-03` (unchecked). This is a tracking
doc artifact — update the checkbox to `- [x]` now that the phase is declared complete.

---

### Anti-Pattern Scan (Gap Closure Plans Only)

Files modified by plans 51-04 and 51-05: `src/retrieval/simd-kernel.ts`, `tests/simd-kernel.test.ts`,
`package.json`, `scripts/eval/51-topk-equivalence.cjs`.

| File | Location | Pattern | Severity | Status |
|------|----------|---------|----------|--------|
| All files | — | No TBD/FIXME/XXX debt markers introduced | — | CLEAN |
| All files | — | No placeholder returns or empty handlers | — | CLEAN |
| `simd-kernel.ts` | Line 68 | `norms.length < count` guard | — | Correct fix (WR-02 closed) |
| `package.json` | pretest | `--check` wired | — | Correct (WR-03 closed) |
| `package.json` | devDependencies | `"wabt": "1.0.39"` (exact pin) | — | Correct (WR-03 closed) |

All three review warnings (WR-01, WR-02, WR-03) closed. No new warnings introduced.

---

### Human Verification Required

None.

---

### Gaps Summary

No gaps. All three success criteria are VERIFIED:

- **SC1 (no regression):** Prebuilt .wasm kernel checked in, used by `topkIndexed`, no native
  deps at install. Strengthened: wabt now exact-pinned, `--check` byte-compare wired into pretest.

- **SC2 (closed from UNCERTAIN):** Real-embedding equivalence proof at production dim=1536 with
  15,943 live nodes and `text-embedding-3-small`: recall@10=1.0000, max\|Δscore\|=1.801e-7 (5.5×
  under MAX_DELTA_BUDGET=1e-6; budget not widened). The epsilon was not changed. The earlier 0.995
  recall was caused by a stale sidecar (coverage gap, not kernel error) — rebuilding the sidecar
  with no code change closed the gap. Scalar fallback verified via DIM=9 integration test.

- **SC3 (no regression):** 4.64× kernel / 4.74× full speedup confirmed on live brain; 6/6
  integration tests pass.

Remaining documentation item: update SCALE-03 checkbox in REQUIREMENTS.md from `- [ ]` to `- [x]`.

---

_Verified: 2026-06-30T18:30:00Z_
_Verifier: Claude (gsd-verifier) — Sonnet 4.6_
_Re-verification: initial status was human_needed (2/3); gaps closed by plans 51-04 and 51-05_
