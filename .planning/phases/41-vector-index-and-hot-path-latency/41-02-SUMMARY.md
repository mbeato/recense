---
phase: 41-vector-index-and-hot-path-latency
plan: 02
subsystem: retrieval
tags: [vector-index, cosine, flat-buffer, latency, perf, sidecar, sleep-pass]

# Dependency graph
requires:
  - phase: 41-01
    provides: "41-SPIKE-FINDINGS.md — locked mechanism (zero-dep flat-buffer sidecar; sqlite-vec rejected; topkTombstoned stays brute-force)"
  - phase: 40
    provides: "warm latency baseline (45/46 ms) the index measures against (PERF-02 anchor)"
provides:
  - "Persisted exact vector index (zero-dep flat-buffer sidecar) behind unchanged CandidateRetriever.topk"
  - "buildVectorIndex(db, indexPath) — end-of-sleep-pass serializer (offline, derived/rebuildable)"
  - "vectorIndexPath(dbPath) — single path helper (<dbPath>.vindex) shared by build + readers"
  - "Three cold online callers (session-start, recall-cli, ambient-recall) read the index, brute-force fallback when absent"
affects: ["41-03 (cold gate + 3-harness equivalence — reads this index)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Serialized flat-buffer sidecar (contiguous Float32Array + precomputed Float64 norms + parallel id array) as a derived, rebuildable cache"
    - "Opt-in index via constructor option; existing callers stay brute-force by default (D-07)"
    - "Atomic publish (write .tmp then rename) so a cold reader never sees a half-written artifact"
    - "End-of-sleep-pass derived-cache build with log-not-throw error posture (mirrors graph-hygiene)"

key-files:
  created:
    - "tests/topk-index.test.ts"
  modified:
    - "src/retrieval/topk.ts"
    - "src/consolidation/run-sleep-pass.ts"
    - "src/adapter/session-start-cli.ts"
    - "src/adapter/recall-cli.ts"
    - "src/adapter/ambient-recall.ts"

key-decisions:
  - "Sidecar path = <dbPath>.vindex, derived through one vectorIndexPath() helper so build + all readers never drift"
  - "Index opt-in via { indexPath } ctor arg; the consolidator's indexless retriever (run-sleep-pass.ts:428) stays brute-force unchanged (D-07)"
  - "topkTombstoned and hybridTopk signatures untouched; hybridTopk gets indexed cosine for free via this.topk (D-02 implicit seam)"
  - "Build is failure-tolerant (logged, never thrown) — a corrupt/missing artifact falls back to brute-force, never authoritative (T-41-04)"

patterns-established:
  - "Derived-cache discipline: graph is source of truth; sidecar rebuildable from node.embedding at any pass"
  - "Cold-path persistence (D-06): the win materializes only because cold processes read a pre-built artifact, not an in-memory rebuild"

requirements-completed: [PERF-01]

# Metrics
duration: 6min
completed: 2026-06-24
---

# Phase 41 Plan 02: Vector Index + Hot-Path Latency Summary

**Zero-dep flat-`Float32Array` exact vector index, persisted as a `<dbPath>.vindex` sidecar built at the end of every sleep pass, read by the three cold online callers behind the unchanged `CandidateRetriever.topk` seam — byte-equivalent cosine scores, brute-force fallback when absent, consolidator stays brute-force.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-06-24T02:42:00Z
- **Completed:** 2026-06-24T02:47:36Z
- **Tasks:** 2
- **Files modified:** 5 (+1 test created)

## Accomplishments

- Implemented the spike-locked **zero-dep contiguous flat-buffer exact index** (D-03(a)/D-04) behind `CandidateRetriever.topk` — one contiguous `Float32Array` of all live embeddings + a precomputed `Float64Array` of row norms + a parallel id array, scanned with the identical `dot / (||q|| · ||row||)` as `cosineSimF32`. Returns **real cosine scores** so the floor gate (engine.ts ~388) and `hybridTopk`'s `cosineScoreMap` keep working unchanged.
- Built the **persisted sidecar** (D-06, the load-bearing requirement): `buildVectorIndex()` serializes the live (`embedding IS NOT NULL AND tombstoned = 0`) set to `<dbPath>.vindex` via an atomic write-then-rename. This is what lets the COLD surfaces skip the ~170 ms row-marshal floor — an in-memory-only buffer would have been ~20 ms *slower* cold per the spike.
- Wired the build hook into `run-sleep-pass.ts` **after** consolidation + graph hygiene and immediately **before** `log('Sleep pass complete')` (D-05) — all build cost stays offline; failure is logged, never thrown.
- Pointed the **three cold online callers** (`session-start-cli`, `recall-cli`, `ambient-recall`) at the persisted index with automatic brute-force fallback when the artifact is absent (first run before any pass).
- Held the invariants: `topk`/`hybridTopk`/`topkTombstoned` **signatures unchanged** (no new exported VectorIndex type — D-02 implicit seam); `topkTombstoned` and the offline consolidator stay **brute-force** (D-07); the index is a **derived cache** (PERF-01 — graph stays source of truth).

## Task Commits

1. **Task 1 (RED): failing index spec** - `c70132a` (test)
2. **Task 1 (GREEN): persisted exact index behind CandidateRetriever** - `9147b6e` (feat)
3. **Task 2: end-of-pass build/persist + cold-caller wiring** - `c248d41` (feat)

**Plan metadata:** (this commit) `docs(41-02): complete vector-index plan`

_TDD task 1: test → feat (no refactor commit needed — implementation was clean on first GREEN)._

## Files Created/Modified

- `tests/topk-index.test.ts` (created) - Four behaviors: index top-k == brute-force set + real cosine scores; brute-force fallback when no artifact; `topkTombstoned` stays brute-force and classifies the deleted set; `hybridTopk` carries real cosine values.
- `src/retrieval/topk.ts` - Added the sidecar format (`buildVectorIndex`/`loadVectorIndex`), `vectorIndexPath()`, the opt-in `{ indexPath }` ctor arg, and `topkIndexed()`. `topk` uses the index when loaded, falls back to the existing brute-force scan otherwise.
- `src/consolidation/run-sleep-pass.ts` - End-of-pass `buildVectorIndex()` call (after hygiene, before "Sleep pass complete"), failure-tolerant; logs `index: rebuilt N vectors -> <path>`. The consolidation retriever (line 428) is unchanged — still indexless/brute-force (D-07).
- `src/adapter/session-start-cli.ts` / `recall-cli.ts` / `ambient-recall.ts` - Construct `CandidateRetriever` with `{ indexPath: vectorIndexPath(dbPath) }` (ambient uses `config.dbPath`).

## Decisions Made

- **Sidecar binary layout:** little-endian header (`RVIX` magic, version, dim, count) + length-prefixed UTF-8 ids + contiguous f32 data + parallel f64 norms. Norms precomputed so each query row costs one dot product + one query-norm sqrt — byte-equivalent to `cosineSimF32`.
- **Atomic publish:** write to `<path>.tmp` then `rename` — a cold reader mid-pass never sees a partial file. On any load failure (missing/corrupt/wrong magic/version/truncated/dim-mismatch) `loadVectorIndex` returns null → brute-force fallback with a one-line **stderr** warning (never stdout — the hot path emits structured output).
- **Path helper (`vectorIndexPath`)** centralizes `<dbPath>.vindex` so the build and all readers can never drift.
- **`topkTombstoned` left brute-force** per the spike verdict (small set; a second sidecar + second end-of-pass build is not worth it).

## Deviations from Plan

None - plan executed exactly as written. The mechanism, persistence artifact, path convention, and tombstoned verdict all match the locked 41-SPIKE-FINDINGS decision; the verify path is satisfied (`tsc` clean, the index spec + consolidation/adapter specs green, `grep "index: rebuilt"` matches).

## Issues Encountered

- The plan's verify commands referenced `npx vitest run src/retrieval/topk.index.test.ts` and `--dir src/consolidation|src/adapter`, but this repo's vitest `include` is `tests/**/*.test.ts` (no `src/` tests). Placed the spec at `tests/topk-index.test.ts` and ran the equivalent module specs by explicit path (`tests/consolidator.test.ts`, `tests/consolidation.test.ts`, `tests/sleep-pass-*.test.ts`, `tests/ambient-recall.test.ts`, `tests/adapter-inject.test.ts`, `tests/recall*.test.ts`) — all green. This is a path convention difference, not a behavior change.

## Known Stubs

None. The index returns real cosine scores over real embeddings; the build/persist path is fully wired and exercised by the spec (fallback) and the consolidation/sleep-pass specs (no regression).

## User Setup Required

None - no external service configuration required. The sidecar is built automatically at the end of the next sleep pass; until then the cold callers transparently fall back to brute-force.

## Next Phase Readiness

- **41-03 (cold gate + equivalence)** can now assert top-k SET equivalence (index == brute-force) under the *persisted* implementation and measure the cold SessionStart-inject wall-clock with the sidecar present. The 20/20 byte-exactness the spike proved holds by construction here.
- One operational note for 41-03: the persisted cold win only appears **after** a sleep pass has run and written `<dbPath>.vindex` — a cold measurement on a brain that has never slept will measure the brute-force fallback, not the index. Build the index (run one pass) before taking the cold numbers.

## Self-Check: PASSED

- `tests/topk-index.test.ts` — FOUND
- `src/retrieval/topk.ts` — FOUND
- `.planning/phases/41-vector-index-and-hot-path-latency/41-02-SUMMARY.md` — FOUND
- commit `c70132a` (test RED) — FOUND
- commit `9147b6e` (feat index) — FOUND
- commit `c248d41` (feat build+wire) — FOUND

---
*Phase: 41-vector-index-and-hot-path-latency*
*Completed: 2026-06-24*
