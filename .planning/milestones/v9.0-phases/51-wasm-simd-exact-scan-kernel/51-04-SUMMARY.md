---
phase: 51-wasm-simd-exact-scan-kernel
plan: "04"
subsystem: retrieval/simd-kernel
tags: [gap-closure, bounds-guard, reproducibility, wasm, simd]
dependency_graph:
  requires: ["51-03"]
  provides: ["WR-02-fix", "WR-03-fix"]
  affects: ["src/retrieval/simd-kernel.ts", "tests/simd-kernel.test.ts", "package.json"]
tech_stack:
  added: []
  patterns: ["TDD red/green", "symmetric bounds guard", "pretest lifecycle hook"]
key_files:
  created: []
  modified:
    - src/retrieval/simd-kernel.ts
    - tests/simd-kernel.test.ts
    - package.json
decisions:
  - "Use 'norms.length < count' (not strict ===) so a longer norms array is harmless — loop only reads [0, count)"
  - "Pin wabt to exact '1.0.39' without running npm install — lockfile reconciliation deferred to developer"
metrics:
  duration: "~5 min"
  completed: "2026-06-30"
requirements: [SCALE-03]
---

# Phase 51 Plan 04: SIMD Kernel Gap Closure (WR-02 + WR-03) Summary

**One-liner:** Symmetric norms.length bounds guard eliminates silent NaN-score path; pretest now byte-compares committed WASM blob against WAT source on every test run.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| RED | Add failing test — short norms → null | d96b1a7 | tests/simd-kernel.test.ts |
| GREEN | Add norms.length guard + JSDoc (WR-02) | e021a0c | src/retrieval/simd-kernel.ts |
| 2 | Wire --check into pretest + pin wabt (WR-03) | 5ece23d | package.json |

## What Was Built

### WR-02: Symmetric norms.length guard (src/retrieval/simd-kernel.ts)

Added `if (norms.length < count) return null;` immediately after the existing `data.length !== count * dim` check in `loadSimdKernel`. The module header's stated contract ("Bounds guards before any allocation; mismatch → null") is now fully honored — both the data matrix and the reciprocal-norms sidecar are validated before any WASM allocation occurs.

The guard uses `< count` (not `!== count`) because the loop only reads indices `[0, count)` — a longer norms array is harmless but a shorter one corrupts scores for the last rows. Updated the JSDoc null-return enumeration to explicitly list `norms.length < count (norms shape mismatch)`.

Added regression test: builds valid data (COUNT * DIM_GUARD floats, DIM_GUARD=8 divisible by 4) with a norms array of length COUNT-1, asserts `loadSimdKernel` returns null without throwing. Test count: 13 → 14.

### WR-03: Pretest lifecycle hook + exact wabt pin (package.json)

- `pretest`: changed from `"npm run build"` to `"npm run build && node scripts/gen-simd-kernel.cjs --check"` — the reproducibility byte-compare + cosine self-test now fires on every `npm test`.
- `wabt` devDependency: `"^1.0.39"` → `"1.0.39"` (caret dropped) — prevents a patch/minor resolution from changing codegen and breaking the byte-compare against an unchanged WAT.
- Verified `gen-simd-kernel.cjs --check` exits 0 against the currently-committed blob before wiring the hook (gate is green at baseline, not red).

## Verification

```
npx vitest run tests/simd-kernel.test.ts  → 14 passed (14)
grep -n "norms.length" src/retrieval/simd-kernel.ts  → lines 10, 68
node scripts/gen-simd-kernel.cjs --check  → reproducibility OK + cosine self-test OK
node -e "const p=require('./package.json'); process.exit(p.scripts.pretest.includes('gen-simd-kernel.cjs --check') && p.devDependencies.wabt==='1.0.39' ? 0 : 1)"  → exit 0
```

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes introduced.

## Self-Check: PASSED

- `src/retrieval/simd-kernel.ts` — modified, guard at line 68
- `tests/simd-kernel.test.ts` — modified, new test at line 263
- `package.json` — modified, pretest + wabt pin
- Commits d96b1a7, e021a0c, 5ece23d — all present in git log
