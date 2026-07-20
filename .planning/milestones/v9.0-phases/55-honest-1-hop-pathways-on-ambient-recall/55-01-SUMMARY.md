---
phase: 55-honest-1-hop-pathways-on-ambient-recall
plan: 01
subsystem: retrieval
tags: [retrieval, activation-trace, viz, sqlite, better-sqlite3, honesty-invariant]

requires:
  - phase: 52-brain-viz-honest-traces
    provides: "activation_trace honesty invariant (score:null rank-only hops, fire-and-forget try/catch emit, T-10-05)"
provides:
  - "retrieveRanked (both emit sites) surfaces each seed's real 1-hop kind='relation' out-edges as hops (score:null, hop:1), capped at AMBIENT_HOP_TOPN=6 per seed"
  - "retrieveRanked seed payload upgraded from string[] to {node_id, score} objects carrying the real cosine/RRF magnitude (D-06)"
  - "buildAmbientTracePayload private helper on RetrievalEngine: kind allowlist, liveness-before-truncate, deterministic weight-desc/dst-asc tiebreak, cross-seed hop de-dup"
  - "Machine-locked SC2/SC3 honesty guards in tests/activation-trace-wiring.test.ts (real-edge cross-check, kind allowlist, liveness, top-N cap, score-honesty split, D-03 tiebreak)"
affects: [55-02, viz-ambient-liveliness, brain-viz-honest-traces]

tech-stack:
  added: []
  patterns:
    - "Ambient 1-hop trace enrichment: filter-live-before-sort-before-truncate (Pitfall 2 order), applied inside the existing T-10-05 try/catch fire-and-forget guard — no new code path that can throw into retrieval"
    - "Seed-score-map-during-scan: vizSeedScores captured in the same loop that builds vizSeedIds (no extra pass over hits)"

key-files:
  created: []
  modified:
    - src/retrieval/engine.ts
    - tests/activation-trace-wiring.test.ts
    - tests/ambient-recall.test.ts

key-decisions:
  - "AMBIENT_HOP_TOPN=6 as a module-level named constant next to SEED_K (D-01/D-02), not exported — test guards assert the literal 6 per plan's Claude's Discretion"
  - "Kind allowlist stays exactly kind==='relation' (D-05/D-05a default lean) — links_to/extends included, no additional rel-based exclusion"
  - "Liveness filter applied before weight-sort/truncate inside buildAmbientTracePayload (D-07, Pitfall 2) — verified by a tombstoned-highest-weight-edge test that would otherwise silently reduce live hop count"
  - "Naive per-seed getOutEdgesWithRel loop (no batching) per RESEARCH Flag 3 — not needed at current seed counts (<=10), and strictly less work than the existing retrieveCueless pattern on the same hot-path budget"

patterns-established:
  - "Pattern: honesty-lock test style — construct a store fixture with real, kind-mixed, tombstoned, and equal-weight edges directly via upsertNode/upsertEdge/tombstone, then cross-check emitted trace payload against store.getOutEdgesWithRel(seed) rather than trusting the implementation's own accounting"

requirements-completed: ["SC3 honesty invariant (no fabricated edges) preserved and machine-verified"]

duration: 35min
completed: 2026-06-30
---

# Phase 55 Plan 01: Honest 1-hop Pathways on Ambient Recall Summary

**Both `retrieveRanked` emit sites now surface each seed's real top-6 live `kind='relation'` out-edges as rank-only hops (score:null) and carry each seed's real cosine/RRF magnitude in the seed payload, machine-locked by five new SC2/SC3 honesty guards.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-07-01T00:48:40Z (session start; plan execution began after context load)
- **Completed:** 2026-06-30T20:56:00-04:00 (local)
- **Tasks:** 3/3 completed
- **Files modified:** 3 (2 planned + 1 deviation fix)

## Accomplishments

- `retrieveRanked`'s two emit sites (temporalAnnotate branch and flat branch) both build honest ambient 1-hop trace payloads instead of the prior `seeds: string[], hops: []` — the founder-reported "pathways rarely show" symptom for ordinary (non-curated) recalls is now addressed at the source.
- New `buildAmbientTracePayload` helper centralizes the honesty logic once: `kind==='relation'` allowlist (D-05), liveness filter applied *before* weight-sort/truncate (D-07, closes the Pitfall 2 displacement bug class), deterministic weight-desc/dst-id-asc tiebreak (D-03), per-seed `AMBIENT_HOP_TOPN=6` cap (D-01/D-02), and cross-seed hop de-dup.
- Seed payloads upgraded from bare `string[]` to `{node_id, score}` objects carrying the seed's real cosine/RRF magnitude (D-06) — the ambient path is now honestly *richer* than the curated path here (curated seeds are `score:null`).
- Five SC2/SC3 machine guards lock the honesty invariant: real-edge cross-check, kind-allowlist (non-relation edges at higher weight never leak), liveness (tombstoned highest-weight edge excluded without reducing live hop count), top-N cap, and the seed-real/hop-null score split. A sixth guard locks the D-03 tiebreak determinism.
- Full suite green (2534 passed / 3 skipped), `tsc -p . --noEmit` clean, no regression to Phase 52 honesty guards or Phase 54 layer guards.

## Task Commits

Each task was committed atomically:

1. **Task 1: Emit real 1-hop relation out-edges + real seed scores at both retrieveRanked emit sites** - `e7a4e11` (feat)
2. **Task 2: Update the two breaking bare-string seed assertions to the D-06 object shape** - `be26e4f` (test)
3. **Task 3: Add SC2/SC3 machine guards locking hop honesty (the regression lock)** - `9b5dc05` (test) — includes the deviation fix to `tests/ambient-recall.test.ts` (see Deviations)

## Files Created/Modified

- `src/retrieval/engine.ts` - `AMBIENT_HOP_TOPN` constant, `buildAmbientTracePayload` private helper, both `retrieveRanked` emit sites rewired to build real seed/hop payloads inside the existing try/catch fire-and-forget guard
- `tests/activation-trace-wiring.test.ts` - two bare-string seed assertions updated to extract `node_id`; six new `it()` guards added (real-edge cross-check, kind allowlist, liveness, top-N cap, score-honesty split, D-03 tiebreak)
- `tests/ambient-recall.test.ts` - one bare-string seed assertion updated to extract `node_id` (deviation, see below)

## Decisions Made

- `AMBIENT_HOP_TOPN` kept private (not exported) — test guards assert against the literal `6` per the plan's explicit "Claude's Discretion" allowance, avoiding an export solely for test convenience.
- `vizSeedScores` map is populated inline during the existing `vizSeedIds` scan loop (no separate pass over `hits`), keeping the added work minimal on the felt-latency hot path per RESEARCH Flag 3's corrected framing (the emit runs synchronously before `return`, not deferred).
- No batching of the per-seed `getOutEdgesWithRel` reads — RESEARCH confirmed the naive per-seed loop (≤10 prepared-statement calls, indexed PK-prefix scan) is strictly less work than the existing `retrieveCueless` pattern already running on the same 45ms p50 budget; batching would be speculative optimization.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated a third bare-string seed assertion outside the plan's file list**
- **Found during:** Task 3 full-suite verification (`npm test`)
- **Issue:** `tests/ambient-recall.test.ts` case `d. trace row written iff viz_trace_enabled=1 AND results non-empty` asserted `JSON.parse(trace.seeds) as string[]).toContain(SEEDED_NODE_ID)` — this test exercises the exact same `retrieveRanked` emit path Task 1 changed, but Phase 55's RESEARCH.md Wave-0 gap scan only covered `tests/activation-trace-wiring.test.ts` and missed this file, so it wasn't listed in the plan's `files_modified`.
- **Fix:** Updated the assertion to parse the new `{node_id, score}` object shape and extract `node_id` before comparing — identical pattern to Task 2's fix, just in a different file. The `hops` assertion (`toEqual([])`) was left unchanged because the test's fixture seeds a single node with zero out-edges, so honestly-empty hops is still the correct expected value (not a regression symptom).
- **Files modified:** `tests/ambient-recall.test.ts`
- **Verification:** `npx vitest run tests/ambient-recall.test.ts` (6/6 pass); full `npm test` (2534 passed / 3 skipped)
- **Committed in:** `9b5dc05` (part of Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 - Bug/stale-test-contract)
**Impact on plan:** Necessary to satisfy the plan's own "npm test full suite green, no regression" verification gate. No scope creep — same D-06 seed-shape mechanical update already scoped and precedented by Task 2, applied to one additional call site the research pass missed.

## Issues Encountered

None beyond the deviation above. Task 1's `npx tsc -p . --noEmit` and targeted `RecallEngine` verification passed on first attempt; the curated path (`src/recall/index.ts`) was untouched and its honesty guards were unaffected throughout.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SC2/SC3 (honesty machine-verified) are locked; both `retrieveRanked` emit sites now emit real, capped, live-only `relation` out-edge hops plus real-score seeds.
- SC1 (the visual "pathways light on every recall" confirmation) is explicitly deferred to Plan 55-02 per this plan's `<success_criteria>` — no visual/founder-checkpoint work was done here.
- Founder Checkpoint items flagged by RESEARCH.md (asymmetric-edge sparsity for object-heavy seeds; `links_to`/`extends` inclusion feel) remain open observations for the 55-02 visual pass, not blockers.

---
*Phase: 55-honest-1-hop-pathways-on-ambient-recall*
*Completed: 2026-06-30*

## Self-Check: PASSED

All created/modified files exist on disk; all three task commit hashes (`e7a4e11`, `be26e4f`, `9b5dc05`) confirmed present in git log.
