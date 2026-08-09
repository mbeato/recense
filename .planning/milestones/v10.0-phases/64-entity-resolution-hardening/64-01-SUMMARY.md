---
phase: 64-entity-resolution-hardening
plan: 01
subsystem: consolidation
tags: [consolidator, intent-classification, security-hardening, prompt-injection, gmail]

# Dependency graph
requires:
  - phase: 63-offline-intent-classification
    provides: "claimIntentStatus/claimIntentEntity/claimIntentConfidence threading through ClaimDecision at all four fill sites"
provides:
  - "Structural gmail-only isolation of intent fields — a hoisted gmailSourced predicate gating all three claim-side fill sites"
  - "Regression proof (three-route + mutation-checked) that non-gmail episodes cannot smuggle intent fields into ClaimDecision"
affects: [64-02, 64-03, 64-04, 65-belief-gated-status-drift, 66-domain-neutral-proposal-emit-seam]

tech-stack:
  added: []
  patterns:
    - "Hoisted per-episode source gate declared after the hard-stop, before the per-claim loop — inherits the hard-stop guard by construction (Pitfall 6 / D-03 discipline)"
    - "One-gate covers a multi-site carrier: gating only at the pendingJudges.push site (site 3) is sufficient for the post-judge fill site (site 4) that reads from it — documented with an explicit non-compensation warning comment at site 4"
    - "Mutation-check-as-verification: revert the gate locally, confirm the exact expected test cases fail, restore, record the observed count in the SUMMARY (not a literal RED-before-GREEN TDD split, since Task 1 already shipped the implementation this test proves)"

key-files:
  created:
    - tests/intent-source-gate.test.ts
  modified:
    - src/consolidation/consolidator.ts

key-decisions:
  - "D-10 implemented via option (a) from 63-REVIEW: gate at the consolidator fill sites (episode.source === 'gmail' ? claim.intent_x : undefined), not a parser-side change — claim-extractor.ts stays source-agnostic by design, consolidator is the single audit point"
  - "Site 4 intentionally left ungated — it reads pre-gated values from the site-3 pendingJudges carrier; adding a second gate there would be redundant, so a warning comment documents the inheritance instead"
  - "episodeSource was NOT additionally threaded onto ClaimDecision — plan explicitly marks this optional and not required for WR-01 closure; deferred to a future phase if downstream planners want it"

requirements-completed: [RESOLVE-02]

duration: 12min
completed: 2026-08-02
---

# Phase 64 Plan 01: WR-01 Source-Gated Intent Threading Summary

**Hoisted `gmailSourced` predicate gates all three claim-side intent fill sites in `consolidator.ts`, closing 63-VERIFICATION WR-01 structurally, proven by a mutation-checked three-route regression test.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-08-02T19:35Z (approx, first Read after worktree reset)
- **Completed:** 2026-08-02T19:43Z
- **Tasks:** 2
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- Closed 63-VERIFICATION **WR-01** (source-agnostic intent-field threading) structurally: a non-gmail episode whose extraction response smuggles `intent_status`/`intent_entity`/`intent_confidence` now produces a `ClaimDecision` with all three `claimIntent*` fields `undefined`, at all three claim-side fill sites (fast-path confirm, auto-unrelated, judge-escalated pendingJudges carrier)
- Gmail episodes still thread all three fields exactly as Phase 63 shipped them — zero regression, proven by two positive-control test cases
- Added a five-case regression suite (`tests/intent-source-gate.test.ts`) covering all three non-gmail decision routes plus two gmail positive controls, with a mutation check confirming the assertions are load-bearing (not vacuous)

## Task Commits

Each task was committed atomically:

1. **Task 1: Hoist a per-episode gmail predicate and gate the three claim-side intent fill sites** - `0a78452` (fix)
2. **Task 2: Three-route WR-01 smuggling regression test** - `57bd8bf` (test)

_Note: Task 2 is marked `tdd="true"` in the plan, but its own `<action>`/`<acceptance_criteria>` prescribe writing the finished regression test directly (since Task 1 already shipped the gate it proves) plus a one-time mutation check as the load-bearing verification method — not a literal RED-before-GREEN split across separate commits. Followed the plan's explicit instructions over the generic TDD default._

## Files Created/Modified
- `src/consolidation/consolidator.ts` — hoisted `const gmailSourced = episode.source === 'gmail';` after the inferred/echo/hitl hard stop (line 674, hard stop at 664); gated all three `claimIntent*` fields at the fast-path confirm site (~782-784), the auto-unrelated site (~880-882), and the `pendingJudges.push` site (~908-910) with `gmailSourced ? claim.intent_x : undefined`; added a non-compensation warning comment at the post-judge fill site (site 4, ~972-975) documenting that it inherits the site-3 gate; updated the `claimIntentStatus` JSDoc on `ClaimDecision` to state gmail-only population is structural, not incidental
- `tests/intent-source-gate.test.ts` — new file, 401 lines, five test cases (3 non-gmail routes + 2 gmail positive controls)

## Decisions Made
- Gate positioned strictly after the hard stop (line 674 > 664) so it inherits the inferred/echo/hitl guard by construction — matches D-03/Pitfall 6 discipline required by the plan
- Site 4 left ungated by design (inherits from site 3's carrier); documented with an explicit warning rather than adding a redundant second gate
- No `episodeSource` field added to `ClaimDecision` — plan marked this optional/planner-discretion and not required for the mandatory minimum; deferred

## Deviations from Plan

None — plan executed exactly as written. No PATTERNS.md file existed in the phase directory (the plan's `<read_first>` referenced it), but the plan's own `<action>` blocks and `64-CONTEXT.md` (D-10, D-11) were sufficient and fully self-contained; this is a missing-optional-reference, not a blocker.

## Mutation Check Result (required record, per plan `<output>`)

Performed once, as instructed by Task 2's acceptance criteria:

1. Reverted Task 1's gate locally (`gmailSourced ? claim.intent_x : undefined` → `claim.intent_x` at all three sites via a scripted, non-committed edit)
2. Ran `npx vitest run tests/intent-source-gate.test.ts`
3. **Observed: exactly 3 of 5 tests failed** — the three non-gmail-route cases (`claude-code` fast-path, `granola` auto-unrelated, `transcript` judge-escalated), each failing with `expected 'X' to be undefined` / received the smuggled scripted value. The 2 gmail positive-control cases still passed.
4. Restored the gate from a pre-edit backup; confirmed `git diff` against the committed state was empty and all 5 tests passed again

This confirms the regression suite's assertions are load-bearing, not vacuous.

## Issues Encountered

**Worktree base mismatch at spawn.** The worktree's HEAD was on an unrelated, older commit (`f779bfb`, phase 45 content) rather than the expected phase-64 base (`7fafac8`). Per the `<worktree_branch_check>` setup step, verified the working tree was clean, then ran the prescribed `git reset --hard 7fafac8c0dc6ff97d61f697800bddb4dd1d3ed72` to correct it before any file reads or edits. This is expected setup-step behavior, not a deviation from the plan's task content.

**Pre-existing, out-of-scope test failures.** A full-suite `npx vitest run` (beyond the plan's own named verification set) surfaces 24 failures across 8 unrelated files (`adapter-capture.test.ts`, `adapter-inject.test.ts`, `episodic-dryrun-gate.test.ts`, `eval-harness-smoke.test.ts`, `locomo-harness.test.ts`, `locomo-latency-curve.test.ts`, `locomo-scorer.test.ts`, `strip-hidden.test.ts`) — all CLI-subprocess-spawning or timing/perf-sensitive tests, none touching `consolidator.ts` or intent classification/resolution code, last modified by commits well before this phase. Logged to `.planning/phases/64-entity-resolution-hardening/deferred-items.md` per the scope-boundary rule; not fixed. The plan's own required verification set (typecheck + 7 named consolidation/intent test files, 92 tests) all pass green.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

WR-01 is closed structurally; Phase 64's entity resolver (64-02/03/04) can now consume `claimIntentEntity` knowing it is gmail-sourced-only by construction, not by prompt convention. No blockers for subsequent plans in this phase.

## Self-Check: PASSED

- FOUND: tests/intent-source-gate.test.ts
- FOUND: .planning/phases/64-entity-resolution-hardening/deferred-items.md
- FOUND: commit 0a78452 (Task 1)
- FOUND: commit 57bd8bf (Task 2)

---
*Phase: 64-entity-resolution-hardening*
*Completed: 2026-08-02*
