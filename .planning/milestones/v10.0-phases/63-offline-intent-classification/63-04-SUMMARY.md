---
phase: 63-offline-intent-classification
plan: 04
subsystem: consolidation
tags: [typescript, vitest, consolidator, self-confirmation-guard, tdd-adjacent]

# Dependency graph
requires:
  - phase: 63-offline-intent-classification (plan 01)
    provides: IntentStatus/IntentConfidence vocabularies + intent_status/intent_entity/intent_confidence optional ExtractedClaim fields
provides:
  - claimIntentStatus/claimIntentEntity/claimIntentConfidence optional fields on ClaimDecision and PendingJudge
  - All four decision-fill sites (fast-path confirm, auto-unrelated, pendingJudges.push, post-judge) threading the intent fields, structurally below the origin/echo/hitl hard stop
  - Structural proof (D-09 comment + acceptance-criteria grep gates) that classification inherits the existing hard stop rather than re-implementing it
  - tests/consolidation-intent.test.ts: three-route threading, absence passthrough, hitl/inferred/echo sentinels, one-generate-call-per-episode sentinel
affects: [63-05 (invariant guards + schema/parser/prompt parity test), 64 (entity resolution reads claimIntentEntity), 65 (confidence -> PE magnitude mapping), 66 (action_proposal persistence)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Instance-scoped decision-capture spy: monkey-patches a single Consolidator instance's private applyDecision method (not a subclass override, which would collide with TS private at the type level) to observe in-memory ClaimDecision objects that are otherwise inert and never reach the DB (D-08). Test-local only; nothing added to src/."

key-files:
  created: [tests/consolidation-intent.test.ts]
  modified: [src/consolidation/consolidator.ts]

key-decisions:
  - "Observation seam: rejected the sink.emit() payload route PATTERNS flagged as a D-08 violation risk. Used an instance-level spy on the private applyDecision method instead of a subclass override, because ClaimDecision is an unexported module-internal interface and applyDecision is a true TS `private` method — a literal subclass override would fail to typecheck (duplicate private declaration). The spy binds the original method, captures the decision, then forwards the call, so consolidate()'s real behavior (node/edge writes, markConsolidated) is unaffected."
  - "Echo sentinel does NOT use a throws-on-generate provider (unlike hitl/inferred): isEligibleForExtraction cannot see echo status (it's an async-only signal per its own header comment), so an about-to-be-echo-detected observed-origin episode IS included in the Phase A prefetch pool and generate() IS legitimately called on it (a documented 'wasted prefetch'). The echo test instead scripts an intent-carrying claim and asserts zero captured decisions -- proving the hard stop discards the extraction result, not that extraction was skipped entirely."
  - "D-09 structural comment placed immediately above the fast-path fill site (as the plan specified) rather than duplicated at all four sites, to avoid comment noise while still making the invariant discoverable at the first fill site a reader encounters."

patterns-established:
  - "CLASSIFY-02 trailing-comment convention on every added consolidator.ts line, mirroring the existing TEMP-02 convention, so future greps for either milestone's threaded fields stay simple."

requirements-completed: [CLASSIFY-01, CLASSIFY-02, CLASSIFY-04]

# Metrics
duration: ~11min
completed: 2026-08-02
---

# Phase 63 Plan 04: Consolidator Intent-Field Threading Summary

**Threaded claimIntentStatus/claimIntentEntity/claimIntentConfidence through all four ClaimDecision fill sites in the consolidator, proved structurally (grep-gated acceptance criteria) and behaviorally (9 new tests) that the threading sits below the existing hitl/inferred/echo hard stop rather than re-implementing it.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-08-02T20:49:17Z
- **Completed:** 2026-08-02T21:00:27Z
- **Tasks:** 2 completed
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- `claimIntentStatus?: IntentStatus`, `claimIntentEntity?: string`, `claimIntentConfidence?: IntentConfidence` added to `ClaimDecision` and `PendingJudge`, mirroring the TEMP-02 `claimDueAt`/`claimActionType` threading pattern exactly, with JSDoc calling out the D-05 all-or-nothing contract and D-08 inertness (no consumer, no DB write this phase)
- All four decision-fill sites (fast-path confirm, auto-unrelated, `pendingJudges.push`, post-judge) copy the three fields from `claim.intent_status`/`intent_entity`/`intent_confidence` (or from `pendingJudges[i]!.claimIntent*` at the post-judge site), each tagged `// CLASSIFY-02`
- A D-09 block comment sits immediately above the fast-path fill site, recording the structural claim that every fill site is textually after the `origin === 'inferred' || echoSourceId !== null || episode.source === 'hitl'` hard stop inside the same per-episode loop iteration
- `tests/consolidation-intent.test.ts` (9 tests): three-route threading (fast-path confirm, auto-unrelated, judge-escalated), absence passthrough, hitl-source sentinel (the load-bearing D-43/CLASSIFY-02 test), inferred-origin sentinel, echo sentinel, and two one-generate-call sentinels (1 episode -> 1 call, 2 episodes -> 2 calls)
- No consumer method, no `applyDecision`/`db.transaction` reference, no migration, no env flag, no `sink.emit()` payload change, `isEligibleForExtraction` untouched — verified by acceptance-criteria greps

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread the three intent fields through ClaimDecision and PendingJudge at every decision site** - `04e7f91` (feat)
2. **Task 2: Threading coverage, hitl/inferred/echo sentinel, and one-generate-call sentinel** - `531586c` (test)

**Plan metadata:** committed separately after this SUMMARY (docs: complete plan)

## Files Created/Modified
- `src/consolidation/consolidator.ts` - Added `claimIntentStatus`/`claimIntentEntity`/`claimIntentConfidence` to `ClaimDecision` and `PendingJudge`; filled at all four decision routes; D-09 structural comment above the fast-path fill site
- `tests/consolidation-intent.test.ts` - Threading coverage across all three decision routes, absence passthrough, hitl/inferred/echo sentinels, one-generate-call-per-episode sentinel (2 cases)

## Decisions Made
- Chose an instance-scoped monkey-patch spy over a true subclass because `applyDecision` is TS `private` and `ClaimDecision` is unexported — a literal `class TestConsolidator extends Consolidator { private applyDecision... }` override would not typecheck (duplicate private member declaration across the hierarchy). The spy binds the original method before replacing the instance property, so production behavior (DB writes, `markConsolidated`) runs unchanged; only the decision is additionally captured for assertions. This satisfies the plan's "prefer test-local subclass/spy" instruction in spirit while working around the TS `private` constraint the plan's own interface annotations produced.
- The echo sentinel test does not use a throws-on-`generate` provider, unlike the hitl and inferred sentinels. Traced through `isEligibleForExtraction`'s own header comment ("Echo detection... is async and cannot be evaluated here; episodes that later fail echo detection waste one prefetched extraction") and confirmed via `prefetchExtractions`'s catch-and-store-per-episode error handling: an observed-origin episode that will later be echo-excluded is still included in the Phase A prefetch pool, so `generate()` legitimately fires on it. Scripting an intent-carrying claim and asserting zero captured decisions proves the hard stop discards the extraction result at the per-episode loop, which is the actually load-bearing guarantee (D-09) — not that extraction was never attempted (that guarantee only holds for hitl/inferred, both excluded from `isEligibleForExtraction` synchronously).

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria for both tasks verified directly (see Self-Check below).

## Issues Encountered

An initial version of the test file's header comment contained the literal string `sink.emit()` inside an explanatory sentence (describing why that observation route was rejected). The plan's own acceptance criterion (`grep -rn "sink.emit" tests/consolidation-intent.test.ts` returns nothing) is a literal string match, so the explanatory prose itself tripped it as a false positive. Reworded the comment to describe the rejected route without the literal substring (`ConsolidationSink payload write on the emit path`); re-verified the grep returns zero matches after the edit, with typecheck and the full test suite re-run clean.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The threading is complete, typecheck-clean, and structurally + behaviorally proven that the D-09 hard stop is inherited rather than re-implemented (the single most load-bearing design constraint of this phase per PITFALLS.md Pitfall 6). Plan 63-05 (invariant guards + schema/parser/prompt parity test) can build on this; Phase 64 can read `claimIntentEntity` off decisions once a consumer exists; Phase 65 maps `claimIntentConfidence` onto PE magnitude; Phase 66 persists via `action_proposal`. No blockers.

## Self-Check: PASSED

- FOUND: src/consolidation/consolidator.ts
- FOUND: tests/consolidation-intent.test.ts
- FOUND: 04e7f91 (Task 1 commit)
- FOUND: 531586c (Task 2 commit)
- `grep -vE '^\s*(//|\*|/\*)' src/consolidation/consolidator.ts | grep -c claimIntentStatus` = 6
- `grep -c maybeWriteIntent src/consolidation/consolidator.ts` = 0
- `grep -vE '^\s*(//|\*|/\*)' src/consolidation/consolidator.ts | grep -c 'claimIntent'` = 18
- `grep -rn "sink.emit" tests/consolidation-intent.test.ts` = 0 matches
- `grep -rn "intent" src/db/schema.ts` = 0 matches
- `npx vitest run tests/consolidation-intent.test.ts tests/consolidation-temporal.test.ts tests/consolidation.test.ts tests/hitl-audit-provenance.test.ts` = 68 passed
- `npm run typecheck` exits 0
- `git diff --exit-code package.json package-lock.json` = clean

---
*Phase: 63-offline-intent-classification*
*Completed: 2026-08-02*
