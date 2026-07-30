---
phase: 62-multi-inbox-email-ingest-hardening
plan: 06
subsystem: testing
tags: [vitest, consolidation, regression-test, gap-closure]

# Dependency graph
requires:
  - phase: 62-05
    provides: "EMAIL-04 end-to-end regression test (backfill-chronological-order.test.ts) and orderEpisodesForConsolidation wiring in consolidator.ts"
provides:
  - "A wiring-discriminating EMAIL-04 regression test that provably fails when orderEpisodesForConsolidation is unwired from consolidate()"
  - "Observed, recorded RED/GREEN evidence for the discrimination check (in the test file header, not just asserted)"
affects: [62-07, 62-08, 63]

# Tech tracking
tech-stack:
  added: []
  patterns: ["content-keyed mock ModelProvider (branches on prompt substring, not call order/index) for testing async-worker-parallelized extraction paths"]

key-files:
  created: []
  modified:
    - tests/backfill-chronological-order.test.ts

key-decisions:
  - "Removed the call-order-indexed generateScript/generateIdx from DynamicReconcileProvider entirely (no fallback) — an index-based path left in place would have been the exact defect being closed"
  - "Content markers ([EP-OLDER]/[EP-NEWER]) are embedded via template-literal reference to shared constants rather than duplicated literal strings in each fixture, keeping a single source of truth for the marker text"
  - "generate() throws loudly on an unrecognized prompt (neither/both markers) rather than returning a silent default, closing the T-62-39 vacuous-pass class"

patterns-established:
  - "Pattern: when a mock ModelProvider must serve concurrently-interleaved worker calls (PREFETCH_CONCURRENCY), key its response on content found in the prompt, never on call order/count — call-order indexing is fragile by construction under concurrency and can mask wiring defects"

requirements-completed: [EMAIL-04]

duration: ~15min
completed: 2026-07-30
---

# Phase 62 Plan 06: EMAIL-04 Regression Test Wiring-Discrimination Fix Summary

**Rewrote `DynamicReconcileProvider` in the EMAIL-04 end-to-end regression test to be content-keyed (branches on `[EP-OLDER]`/`[EP-NEWER]` prompt markers) instead of call-order-indexed, then measured (not assumed) that the test goes RED when `orderEpisodesForConsolidation` is unwired and GREEN when restored — closing `62-VERIFICATION.md gaps[0]` / threat T-62-36.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-30T16:22:32Z
- **Tasks:** 2/2 completed
- **Files modified:** 1 (`tests/backfill-chronological-order.test.ts`); `src/consolidation/consolidator.ts` touched transiently in Task 2 (deliberate revert + restore) and confirmed byte-identical at plan end

## Accomplishments

- `DynamicReconcileProvider.generate()` is now a pure function of its prompt argument: it returns the older/newer fact value based on which `[EP-OLDER]`/`[EP-NEWER]` marker is present in the episode content reaching the prompt, with no call counter or fixed response queue, so call order, call count, and `PREFETCH_CONCURRENCY` worker interleaving can no longer determine the test's outcome.
- Added a public `seen: Map<string, number>` observation log so both fixture episodes are proven to have reached extraction exactly once — a silently-skipped or silently-double-extracted episode can no longer make the final-value assertion pass vacuously.
- Ran the mandated discrimination measurement: deliberately reverted `src/consolidation/consolidator.ts:532` to the bare `this.episodes.listUnconsolidated()`, observed the rewritten test FAIL with the exact predicted actual value, restored the line byte-identically (verified three independent ways), and re-observed GREEN.
- Recorded the observed RED evidence durably in the test file's header doc comment (not just in this SUMMARY), so a future reader can see the test was measured, not assumed.

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace call-order-indexed extraction with content-keyed extraction** - `9178d06` (test)
2. **Task 2: Prove the test is wiring-discriminating — revert → RED → restore → GREEN** - `4692ca3` (docs)

**Plan metadata:** committed separately by the orchestrator after wave merge (worktree mode skips shared-file commits).

## Files Created/Modified

- `tests/backfill-chronological-order.test.ts` - `DynamicReconcileProvider` rewritten to content-keyed extraction (`[EP-OLDER]`/`[EP-NEWER]` markers, `seen` observation map, throw-on-unrecognized-prompt); both `it()` blocks' fixture content updated to embed the markers; header doc comment updated with the content-keying rationale and the durable RED/GREEN discrimination-check evidence.

## Discrimination Check Evidence (Task 2, verbatim observation)

**Step 2 — revert:** `src/consolidation/consolidator.ts:532` changed from
`const unconsolidated = orderEpisodesForConsolidation(this.episodes.listUnconsolidated());`
to the bare `const unconsolidated = this.episodes.listUnconsolidated();`

**Step 3 — observed RED:**
- Failing test: `EMAIL-04: backfill chronological order (Phase 62 Plan 05) > reverse-chronological Gmail backfill batch: newer status wins, not the stale older one`
- Failing assertion: `expect(currentNodes[0]!.value).toBe(NEWER_VALUE)` (test file line 252)
- Actual reported value: `'application status: submitted, awaiting review'` (`OLDER_VALUE`)
- Expected value: `'application status: offer extended'` (`NEWER_VALUE`)
- This exactly matches the plan's predicted observation — under bare salience order the higher-salience newer episode is processed first and the older episode's reconcile lands last and overwrites it.

**Step 4 — restore:** line 532 restored to
`const unconsolidated = orderEpisodesForConsolidation(this.episodes.listUnconsolidated());`
Confirmed via three independent checks:
1. `git diff --exit-code src/consolidation/consolidator.ts` exits 0 (byte-identical to pre-plan state)
2. `grep -n "orderEpisodesForConsolidation" src/consolidation/consolidator.ts` shows exactly one import line (50) and exactly one call site (532) (plus one pre-existing comment reference at line 562)
3. `sed -n '532p' src/consolidation/consolidator.ts` matches the exact restored line text

**Step 5 — observed GREEN:** `npx vitest run tests/backfill-chronological-order.test.ts` — 2/2 tests pass. `npx tsc --noEmit` exits 0.

**Step 7 — full-suite regression:** `npx vitest run` — **2878 passed / 4 skipped / 0 failed** (193 test files, 192 passed + 1 skipped). Compared against the `62-VERIFICATION.md`-recorded pre-plan baseline of 2858 passed / 3 skipped / 0 failed: no new failures. The +20 passed / +1 skipped delta reflects tests added by intervening Phase 62 plans (01–05) that landed after that baseline was recorded, not any change made by this plan.

## Content-Keying Design Rationale

The original `DynamicReconcileProvider.generate()` returned values from a fixed `generateScript: string[]` array indexed by `generateIdx` (incremented per call). This made the extracted value a function of **call order**, not of which physical episode was being extracted. Combined with two facts about the production code — (1) `prefetchExtractions` (`consolidator.ts:324-400`) issues `provider.generate()` calls from `PREFETCH_CONCURRENCY` concurrent workers, so call order is not guaranteed to track array-slot order under real interleaving, and (2) this codebase's actual reconcile-last-applied-wins semantics mean whichever episode is *processed* last determines the final value — a call-order-indexed script would return the array's values in the order `generate()` happened to be called, which could coincidentally match the "correct" outcome even if `orderEpisodesForConsolidation` were never wired into `consolidate()` at all. The verifier confirmed this failure mode with three independent break/restore cycles.

The fix ties the extracted value to the actual **content** of the prompt reaching `generate()` — `promptPrefix + episode.content` (traced through `extractClaimsWithChunking`, `consolidator.ts:380-384` / `688`) — via two unique marker strings, `[EP-OLDER]` and `[EP-NEWER]`, embedded directly in each fixture episode's content. This makes the mock's behavior a pure function of *which episode* is being extracted, structurally eliminating call order, call count, and worker interleaving as possible confounds. The `provider.seen` map additionally proves each episode was extracted exactly once, closing the "silently skipped/double-extracted episode" vacuous-pass class (T-62-40).

## Decisions Made

- Removed `generateIdx`/`generateScript` entirely rather than keeping an index-based fallback path — an index-based path left in place, even unused by default, would itself be the defect class being closed (T-62-39). Verified by grep gate (`generateIdx|generateScript` returns 0 lines).
- `generate()` throws on any prompt containing neither or both markers, rather than defaulting to a fixed value — a silent default would let the test pass vacuously again (T-62-39).
- The discrimination-check evidence was recorded in the test file's own header doc comment (durable, versioned with the test) rather than only in this SUMMARY, so a future reader auditing the test file itself can see it was measured.

## Deviations from Plan

None — plan executed exactly as written. Both tasks completed per their `<action>` and `<acceptance_criteria>` blocks with no auto-fixes required.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `tests/backfill-chronological-order.test.ts` now genuinely discriminates on the EMAIL-04 `orderEpisodesForConsolidation` wiring — closes `62-VERIFICATION.md gaps[0]` and threat T-62-36 for this test.
- `src/consolidation/consolidator.ts` unchanged from pre-plan state; no production behavior affected.
- `tests/episode-order.test.ts` untouched, still 10/10 passing.
- Ready for `62-07`/`62-08` gap-closure plans and eventual Phase 62 re-verification.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*
