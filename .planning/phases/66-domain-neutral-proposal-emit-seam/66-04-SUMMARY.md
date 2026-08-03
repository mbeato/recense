---
phase: 66-domain-neutral-proposal-emit-seam
plan: 04
subsystem: consolidation
tags: [action-proposal, emission-seam, sqlite, consolidator, recense-doctor, sleep-pass]

# Dependency graph
requires:
  - phase: 66-01
    provides: action_proposal table + ActionProposalStore
  - phase: 66-02
    provides: ActionProposalSink triad (SQLite/Noop/Mock), proposalId(), actionProposalSinkEnabled knob
  - phase: 65
    provides: EMISSION_ELIGIBLE_EVENT_TYPES / isEmissionEligible predicate + emission-hold-sentinel.test.ts's shipped D-13 sentinel
provides:
  - maybeEmitProposal helper wired at the 9 decisive applyDecision sites in Consolidator
  - Live sleep pass injects SQLiteActionProposalSink behind actionProposalSinkEnabled, else NoopActionProposalSink
  - recense doctor dimension 10 (Proposal sink posture + pending count)
  - Behavioral proof suite against the real sink (tests/action-proposal-emission.test.ts)
  - Phase 65's hold sentinel extended + discharged against the real sink, Half B narrowed to the hold-only sub-branch
affects: [67-reference-consumer-adapter, 68-telegram-hitl-belief-kind]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Gated emission helper: a single private method (maybeEmitProposal) funnels every proposal emission through one isEmissionEligible check + one all-or-nothing field guard, called from 9 call sites rather than re-implementing the gate at each site"
    - "Trailing Noop-default constructor param for optional consumer seams (matches the existing sink/deriver/corpusPromoter/insightReflector/docGraphDeriver convention)"
    - "Structural sentinel narrowing: when a shipped structural scan's anchor is wider than the invariant it protects, narrow the anchor and add the over-narrowing guard in the SAME commit as the new forbidden token, never as two separate changes"

key-files:
  created:
    - tests/action-proposal-emission.test.ts
  modified:
    - src/consolidation/consolidator.ts
    - src/consolidation/run-sleep-pass.ts
    - src/adapter/recense-doctor.ts
    - tests/emission-hold-sentinel.test.ts

key-decisions:
  - "maybeEmitProposal threads episode.content (not a re-read) as evidence_quote — the exact row the per-episode loop already holds, post strip-hidden/redact/capContent, which is precisely what EMIT-06's verbatim guarantee is defined against"
  - "Half B's primary anchor narrowed from the outer '// action === '\''hold'\''' block to the hold-ONLY '// Hold only (distinctCount < contradictionN)' sub-branch, because the outer block also lexically contains the two legitimate contradict_force_destabilize emit sites this phase gates — adding 'maybeEmitProposal' to the forbidden list against the old anchor would have false-failed on correct code"
  - "checkProposalSink never returns fail() — a dark knob being off is a posture, not a fault, and a missing/unreadable action_proposal table degrades to a pass with an 'unavailable' detail rather than double-failing alongside checkDb"

requirements-completed: [EMIT-01, EMIT-06]

# Metrics
duration: 25min
completed: 2026-08-03
---

# Phase 66 Plan 04: Consolidator Emission Wiring + Sleep-Pass Injection + Doctor Dimension 10 Summary

**Nine decisive `applyDecision` branches now emit through a single gated `maybeEmitProposal` helper into the real `SQLiteActionProposalSink`, injected in the live sleep pass behind `actionProposalSinkEnabled`, surfaced as `recense doctor`'s tenth dimension, with Phase 65's shipped hold sentinel extended to the real sink and its Half B anchor deliberately narrowed to close the exact gap the narrowing was meant to prevent.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-03T06:57Z (approx, first commit 06:58:21Z)
- **Completed:** 2026-08-03T07:10:29Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `Consolidator.maybeEmitProposal` gates every emission on the imported `isEmissionEligible` predicate (never a locally re-derived set) and an all-or-nothing check across `claimResolvedEntityId`/`claimResolvedEntityDescriptor`/`claimIntentStatus`/`claimIntentConfidence` — wired at exactly the 9 decisive sites (confirm, extend×2, unrelated, contradict_oscillation, contradict_reconcile, contradict_append_new, contradict_force_destabilize×2); the hold arm and `applySecondaryContradiction` get no gate call at all.
- The live sleep pass (`run-sleep-pass.ts`) injects a real `SQLiteActionProposalSink` over a real `ActionProposalStore` only when `actionProposalSinkEnabled` is true, else the same `NoopActionProposalSink` the `Consolidator` constructor already defaults to — two independent barriers (T-66-12).
- `recense doctor` gained a tenth dimension (`checkProposalSink`) reporting the knob's posture and, when enabled, the pending `action_proposal` count via a read-only DB open — never failing on a dark knob or a missing/unreadable table.
- A new 10-case behavioral suite (`tests/action-proposal-emission.test.ts`) proves the seam against the real DDL: exact-content emission, resolver-abstention/non-gmail zero-emission, confirm/extend/unrelated/oscillation zero-emission, same-transaction atomicity (failing a real statement, not stubbing the sink), EMIT-04 replay collapse, and Noop-sink zero-writes.
- Phase 65's `emission-hold-sentinel.test.ts` header promise is discharged: the file now wires a real `SQLiteActionProposalSink`, its two Half A cases carry parallel `action_proposal` assertions, and Half B's primary anchor is narrowed from the outer `// action === 'hold'` block to the `// Hold only (distinctCount < contradictionN)` sub-branch — proven correct by an over-narrowing guard and a planted `maybeEmitProposal` offender.

## Task Commits

1. **Task 1: Consolidator — proposalSink param, maybeEmitProposal helper, 9 gated call sites** - `3bf8d74` (feat)
2. **Task 2: Sleep-pass injection behind the dark knob + doctor dimension 10** - `1369c3c` (feat)
3. **Task 3: Emission behavioral tests + extend Phase 65's hold sentinel to the real sink** - `4259ab7` (test)

_No TDD gate applies — this plan's tasks are not `tdd="true"` at the plan-frontmatter level; Task 3 is internally test-first in spirit (tests written to prove already-wired behavior) but is a single commit._

## Files Created/Modified

- `src/consolidation/consolidator.ts` - `proposalSink` field/param (Noop default), `proposalsEmitted` counter, `maybeEmitProposal` helper, 9 call sites, `applyDecision` now threads `episodeContent`, `EMIT-66` pass-end log line
- `src/consolidation/run-sleep-pass.ts` - constructs `SQLiteActionProposalSink`/`NoopActionProposalSink` based on `config.actionProposalSinkEnabled`, threads it as the `Consolidator`'s trailing argument
- `src/adapter/recense-doctor.ts` - `checkProposalSink` (dimension 10), registered in the `dimensions` array, header/threat-mitigation block updated (nine→ten, `T-66-05` added)
- `tests/emission-hold-sentinel.test.ts` - `makeConsolidatorWithRealSink` widened with a real proposal sink, `actionProposalRowsForEntity`/`seedEntity` helpers, parallel `action_proposal` assertions on both Half A cases, Half B anchor narrowed + `'maybeEmitProposal'` forbidden token + over-narrowing guard + planted offender, header discharged
- `tests/action-proposal-emission.test.ts` (new) - 10-case behavioral suite against the real sink/store/DDL

## Decisions Made

- `episodeContent` is threaded as a new required parameter on `applyDecision` (not re-read from the DB inside it) — the loop already holds the exact post-processing row, and threading it costs zero extra DB reads inside the transaction.
- Half B's anchor narrowing and the `'maybeEmitProposal'` forbidden-token addition were shipped in the SAME commit (Task 3), per the plan's explicit instruction — adding the token first against the old wide anchor would have false-failed on the two legitimate `contradict_force_destabilize` sites this phase adds.
- The two Half A behavioral cases in `emission-hold-sentinel.test.ts` were each given a freshly-seeded resolvable entity (`seedEntity`) rather than relying on resolution abstaining to produce a vacuous zero — this makes the "hold never emits" and "force-destabilize emits exactly once" assertions test the `isEmissionEligible` gate specifically, not merely an unrelated abstention.
- The atomicity test in the new suite fails the transaction by monkeypatching the REAL `EpisodicStore.markConsolidated` on the harness's live instance to throw — not by stubbing the proposal sink — so the property under test is the real `db.transaction(...).immediate()` boundary, per the plan's explicit instruction.
- The EMIT-04 replay test drives the SAME episode through `consolidate()` twice (resetting `episode.consolidated` between runs) against an `append-new` outcome whose candidate node is never mutated by that route, so both runs produce byte-identical `proposalId()` inputs without needing to fight emergent re-routing from a changed graph state.

## Deviations from Plan

None - plan executed exactly as written. The one required deviation-adjacent action was itself mandated by the plan's acceptance criteria: Task 3 required temporarily inserting `this.maybeEmitProposal('contradict_hold', decision, episodeId, episodeContent, decision.bestCandidateId, null)` into the hold-only sub-branch of `consolidator.ts` to prove Half B fails, then reverting it. This was performed exactly as specified (see "Verification Performed" below) and is not a deviation from the plan — it is one of the plan's own acceptance criteria.

## Issues Encountered

One self-inflicted bug caught by `npm run typecheck` during Task 1: the first draft of `maybeEmitProposal`'s JSDoc contained the literal substring `claimIntent*/` inside prose, which prematurely closed the `/** ... */` block comment and cascaded into ~80 parser errors starting at the next line. Fixed by rewording to `claimIntent-family` (no literal `*/` substring). No functional code was affected — this was a comment-only defect caught before any commit.

## Verification Performed

- `npm run typecheck` exits 0 after every task.
- `npx vitest run tests/emission-hold-sentinel.test.ts tests/status-drift-wiring.test.ts tests/consolidation-intent.test.ts` passed (28/28) after Task 1.
- `npx vitest run tests/recense-doctor.test.ts tests/recense-doctor-gmail-accounts.test.ts` passed (28/28) after Task 2, plus 8 additional test files touching `run-sleep-pass.ts` wiring (75/75) as an out-of-plan-but-in-scope sanity check.
- `npx vitest run tests/action-proposal-emission.test.ts tests/emission-hold-sentinel.test.ts` passed (19/19) after Task 3.
- **Half B fail-then-revert check (required by Task 3's acceptance criteria):** inserted `this.maybeEmitProposal('contradict_hold', decision, episodeId, episodeContent, decision.bestCandidateId, null);` into the hold-only sub-branch. Result: 1 failed / 8 passed, with the exact expected failure —
  ```
  AssertionError: expected [ Array(1) ] to deeply equal []
  - []
  + [
  +   "primary hold branch (applyDecision): contains forbidden emission identifier \"maybeEmitProposal\"",
  + ]
  ```
  Reverted immediately after (`git diff src/consolidation/consolidator.ts` confirmed byte-identical to the committed state); re-ran the sentinel suite to confirm 9/9 green again.
- **`npm test` full-suite regression check**, run twice:
  - After Tasks 1–2 (no new tests added yet): **3759 passed | 6 expected fail | 4 skipped** (223 test files, 1 skipped file).
  - After Task 3 (12 new tests: 10 in the new file + 2 added to the sentinel file): **3771 passed | 6 expected fail | 4 skipped** (224 test files, 1 skipped file).
  - Delta is exactly +12 passed / +1 file, matching the new tests added — zero regressions, zero new failures against either baseline measurement.
- Grep-based acceptance criteria (all passed): `maybeEmitProposal` call-site count = 9; `proposalSink.emit(` count = 1; no locally re-declared `new Set<ConsolidationEventType>`; `isEmissionEligible` referenced ≥2×; hold-only sub-branch contains zero gate calls; `applySecondaryContradiction` contains zero `maybeEmitProposal`/`proposalSink` references; `maybeEmitProposal` body contains zero `await`; `run-sleep-pass.ts` diff scoped to exactly the 2 imports + proposalSink const + 1 Consolidator argument; `checkProposalSink` contains zero `fail(` calls; doctor header wording bumped nine→ten with zero remaining "nine" occurrences; sentinel file's removed-`expect(`-line count = 1 (the old wide-anchor presence check, replaced by the narrowed equivalent).

## Known Stubs

None - no stub patterns introduced. All wiring is live and exercised end-to-end by the new behavioral suite.

## Threat Flags

None beyond what the plan's own `<threat_model>` already anticipated (T-66-14/15/06/16/04/12/05/20, all `mitigate`, all covered by the tests added in this plan). No new network endpoints, auth paths, or trust-boundary schema changes were introduced beyond what 66-01/66-02/66-03 already established.

## User Setup Required

None - no external service configuration required. `actionProposalSinkEnabled` remains dark (`false`) by default per D-04/T-66-12; no action needed to keep the current no-op posture.

## Next Phase Readiness

- Plan 66-05 (per `.planning/phases/66-domain-neutral-proposal-emit-seam/66-05-PLAN.md`, not yet executed by this run) can proceed — the emission seam this plan wires is exactly what any remaining Phase 66 work or Phase 67's reference consumer adapter will read `action_proposal` rows through.
- Phase 67 (Reference Consumer Adapter) and Phase 68 (Telegram HITL Belief-Kind Extension) both depend on this plan's emission seam being live and gated correctly; both are unblocked.
- Carry-forward reminder (recorded per this plan's own instruction, not implemented here): Phase 67's `docs/reference-client.md` contract section (CONSUME-03) must document the `change_from`/`change_to` type asymmetry this plan locks in — `change_from` is recense's prior belief TEXT (often a full sentence), `change_to` is a token from the closed `IntentStatus` vocabulary. A consumer maps on `change_to`; `change_from` is approver context only.
- No blockers identified.

---
*Phase: 66-domain-neutral-proposal-emit-seam*
*Completed: 2026-08-03*

## Self-Check: PASSED

- FOUND: `.planning/phases/66-domain-neutral-proposal-emit-seam/66-04-SUMMARY.md`
- FOUND: `tests/action-proposal-emission.test.ts`
- FOUND: commit `3bf8d74` (Task 1)
- FOUND: commit `1369c3c` (Task 2)
- FOUND: commit `4259ab7` (Task 3)
