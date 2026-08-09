---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 11
subsystem: consolidation
tags: [status-drift, belief-correction, event-ts-staleness, tdd, gap-closure]

# Dependency graph
requires:
  - phase: 65-05
    provides: StatusDrift module (SUPPORTING_EVENT_TYPES, event_ts staleness guard, D-11b)
  - phase: 65-08
    provides: drift layer wired into consolidator.ts's contradict branches
  - phase: 65-09
    provides: DRIFT-02/03/04 e2e regression suite (tests/drift-belief-correction-e2e.test.ts)
provides:
  - "'unrelated' added to SUPPORTING_EVENT_TYPES — the D-11b event_ts staleness guard now sees a cold-start standalone mint's founding evidence"
  - "Unit coverage proving the corrected semantics: drop/ok pair, cross-node isolation (no false positive), MAX-semantics composition"
  - "e2e regression proving the genuine cold-start ('unrelated'-minted) path through real consolidate() passes: stale contradiction dropped, chronological control still corrects"
  - "establishBeliefColdStart() test helper — the sibling establishBelief() could not provide because its seeded anchor always mints via 'extend'"
affects: [66-domain-neutral-proposal-emit-seam]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Test helper siblings over modification: establishBeliefColdStart() added alongside establishBelief() rather than parameterizing it, preserving every existing case's dependency on the 'extend' path"
    - "Mutation-checked regression: a fixture proves the code path it claims to by temporarily reverting the fix and confirming the specific assertion that should fail does fail"

key-files:
  created: []
  modified:
    - src/consolidation/status-drift.ts
    - tests/status-drift.test.ts
    - tests/drift-belief-correction-e2e.test.ts

key-decisions:
  - "'unrelated' is founding evidence exactly like 'extend' — both consolidator.ts mint branches emit node_id = the node they minted; 'unrelated' additionally carries candidate_id: null, which is what makes it provably incapable of a cross-node false positive"
  - "Cold-start mint resistance (s=0.1, c=0.5) is identical to the 'extend' mint's — both call upsertNode with no s/c override — so the existing chronological control's 0.06-against-0.05 magnitude choice carries over unchanged to the new cold-start control"
  - "No correction note appended to 65-10-SUMMARY.md: re-running npm run eval:drift05:dry after the fix reproduces the exact recorded eventTsUnknown=26 and staleDropped=2 figures unchanged, because the DRIFT-05 harness's synthetic cases seed their founding episode as undated (conversation-sourced), so the guard still abstains on unknown-prior-ts there regardless of this fix"

requirements-completed: [DRIFT-04]

# Metrics
duration: ~20min
completed: 2026-08-03
---

# Phase 65 Plan 11: DRIFT-04 Cold-Start Staleness Guard Fix Summary

**Added `'unrelated'` to `SUPPORTING_EVENT_TYPES` so the D-11b event_ts staleness guard sees a cold-start standalone mint's founding evidence, closing the live-default BLOCKER `65-VERIFICATION.md` reproduced — proven by a mutation-checked unit suite and a real `consolidate()`-pass e2e regression.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-03
- **Tasks:** 3 (RED unit, GREEN fix, e2e regression)
- **Files modified:** 3 (1 source, 2 test)

## Accomplishments

- Closed the single BLOCKER from `65-VERIFICATION.md`: a belief founded by the consolidator's `'unrelated'` cold-start mint (the common path for every brand-new tracked entity's first status email) is now protected by the `event_ts` staleness guard exactly like an `'extend'`-minted belief.
- Proved the fix cannot produce a cross-node false positive with a dedicated unit case, rather than accepting `65-REVIEW.md` WR-02's prose claim.
- Added the e2e regression the existing suite structurally could not reach: `establishBelief()`'s seeded anchor always mints via `'extend'`; the new `establishBeliefColdStart()` sibling runs a real `consolidate()` pass over an EMPTY graph so the auto-unrelated branch fires deterministically, with a judge resolver that throws if ever called.
- Mutation-checked: temporarily removing `'unrelated'` from `SUPPORTING_EVENT_TYPES` makes the new cold-start stale case fail exactly as expected (`tombstoned` flips truthy — the offer is reverted); restored, it passes.
- `routeContradiction`, `isOscillation`, `countDistinctProvenance`, `update-decision.ts`, `consolidator.ts`, `schema.ts`, and `config.ts` are provably untouched (`git diff --stat` gates all pass).

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — unit assertions that 'unrelated' is founding evidence (currently failing)** - `2150c80` (test)
2. **Task 2: GREEN — add 'unrelated' to SUPPORTING_EVENT_TYPES with corrected rationale** - `d10ca0d` (fix)
3. **Task 3: e2e regression — a cold-start 'unrelated'-minted belief survives a stale backfilled contradiction** - `1b03628` (test)

**Plan metadata:** committed separately after this SUMMARY.

## Files Created/Modified

- `src/consolidation/status-drift.ts` — added `'unrelated'` to `SUPPORTING_EVENT_TYPES` (size 6→7), rewrote the set's doc comment with the corrected rationale citing DRIFT-04/WR-02 by name
- `tests/status-drift.test.ts` — inverted the locked exclusion assertion (`unrelated`: false→true, added `size===7`), added a drop/ok pair for the `'unrelated'` mint, a cross-node isolation case, and a MAX-semantics composition case
- `tests/drift-belief-correction-e2e.test.ts` — added `establishBeliefColdStart()` helper, `assertColdStartMint()` non-vacuity assertion helper, and two new cases in the `DRIFT-04` describe block (stale-dropped, chronological control)

## Decisions Made

See `key-decisions` in frontmatter. In short: `'unrelated'` belongs in `SUPPORTING_EVENT_TYPES` for the same reason `'extend'` does (both are founding-mint evidence with `node_id` = the node minted); the cold-start mint's resistance is identical to the `'extend'` mint's so the existing chronological-control magnitude carried over unchanged; and the DRIFT-05 harness numbers are unaffected by this fix (its founding episodes are undated by construction), so no correction to `65-10-SUMMARY.md` was needed.

## RED Output (Task 1)

`npx vitest run tests/status-drift.test.ts` against the shipped (pre-fix) source failed exactly 3 cases, all newly added/inverted; the other 34 pre-existing cases were unaffected:

1. `StatusDrift.evaluate — event_ts staleness (DRIFT-04) > 'unrelated' mint is supporting evidence: drops a contradicting claim whose event_ts predates the mint's dated episode` — expected `{ action: 'drop', ... }`, received `{ action: 'proceed', staleness: 'unknown-prior-ts' }`
2. `StatusDrift.evaluate — event_ts staleness (DRIFT-04) > 'unrelated' mint paired control: proceeds when the claim is newer than the mint's dated episode` — expected `staleness: 'ok'`, received `staleness: 'unknown-prior-ts'`
3. `SUPPORTING_EVENT_TYPES sanity > includes the standalone mint as founding evidence; excludes contradict_hold and schema/merge outcomes` — expected `SUPPORTING_EVENT_TYPES.has('unrelated')` `true`, received `false`

(The cross-node isolation case and the MAX-semantics composition sibling both already passed pre-fix, since neither depends on `'unrelated'`'s inclusion to produce their expected outcome — they are composition/non-regression proofs, not the RED half of this gap.)

## Final `SUPPORTING_EVENT_TYPES` Membership (verbatim)

```ts
export const SUPPORTING_EVENT_TYPES: ReadonlySet<ConsolidationEventType> = new Set<ConsolidationEventType>([
  'confirm',
  'extend',
  'unrelated', // standalone/cold-start mint — node_id is the node it minted (consolidator.ts:1356-1376)
  'contradict_reconcile',
  'contradict_append_new',
  'contradict_force_destabilize',
  'contradict_oscillation',
]);
```

Size: 7 (was 6). Excluded, unchanged: `contradict_hold`, `schema_emitted`, `schema_falsified`, `entity_merge`, `fact_merge`.

## Cold-Start Mint Resistance / Chronological Control Magnitude

Observed cold-start mint resistance is **identical to the `'extend'` mint's**: both mint branches call `upsertNode` with no `s`/`c` override, so both default to `s=0.1, c=0.5` → `resistance = effectiveS * c = 0.05` for a freshly minted node under the `FakeClock`-frozen harness. The new chronological-control case therefore reuses the existing case's exact magnitude choice: `0.06` against `0.05` resistance → ratio `1.2` → mid-band reconcile (tombstone old + mint new). No magnitude adjustment was needed.

## Mutation Check Output (Task 3)

With `'unrelated'` temporarily removed from `SUPPORTING_EVENT_TYPES` (`src/consolidation/status-drift.ts`), running:

```
npx vitest run tests/drift-belief-correction-e2e.test.ts -t "cold-start"
```

produced exactly the expected failure — the stale case's `not-tombstoned` assertion fires:

```
FAIL  tests/drift-belief-correction-e2e.test.ts > DRIFT-04: out-of-order evidence cannot revert
  > cold-start ('unrelated'-minted) belief: a stale backfilled contradiction cannot revert it
AssertionError: expected 1 to be falsy
- Expected: false
+ Received: 1
  at tests/drift-belief-correction-e2e.test.ts:776:29 (expect(node.tombstoned).toBeFalsy())
```

(The chronological control case passed regardless, as expected — it does not depend on the guard tripping.) The member was restored immediately after (`git diff --stat -- src/` confirmed empty afterward) and the full suite re-confirmed green.

## `npm run eval:drift05:dry` Counters vs. `65-10-SUMMARY.md`

| Metric | 65-10-SUMMARY.md (pre-fix) | This run (post-fix) | Delta |
|---|---|---|---|
| Total messages | 30 | 30 | none |
| Distinct (collapsed) | 1 | 1 | none |
| Distinct (derived) | 15 | 15 | none |
| Fallback count | 12 (all `near-empty-residual`) | 12 (all `near-empty-residual`) | none |
| Mock accuracy | 14/14 (100%) | 14/14 (100%) | none |
| Drift counters | `evaluations=30, damped=21, staleDropped=2, eventTsUnknown=26` | identical | none |
| Resolve counters | `attempts=30, hits=0, abstains=30` | identical | none |

**No divergence** — no correction note appended to `65-10-SUMMARY.md`. The DRIFT-05 harness's synthetic cases seed their `initial_status_fact` via an undated `conversation`-sourced episode (per `65-10-SUMMARY.md`'s own documented gotcha), so `latestSupportingEventTs` still finds no dated row for the founding mint regardless of which event types are counted as supporting evidence — this fix only changes behavior when the founding episode itself carries a dated `event_ts`, which none of the DRIFT-05 fixtures do.

## Full Phase-65 Surface (verification block)

```
npx vitest run tests/status-drift.test.ts tests/status-drift-wiring.test.ts \
  tests/drift-belief-correction-e2e.test.ts tests/emission-hold-sentinel.test.ts \
  tests/pe-machinery-lock.test.ts tests/update-decision.test.ts tests/provenance-key.test.ts \
  tests/strip-quoted.test.ts tests/runtime-config.test.ts tests/gmail-provenance-key.test.ts \
  tests/session-id-provenance-consumers.test.ts tests/drift-05-harness-smoke.test.ts
```
→ 12 files / 286 tests passed (was 12 files / 280 tests at `65-VERIFICATION.md` baseline; +6 = 3 new/inverted unit cases + 2 new e2e cases + 1 MAX-semantics composition sibling that already passed pre-fix).

Full suite (`npx vitest run`): 220 files passed / 1 skipped; 3713 passed / 6 expected-fail / 4 skipped — vs. the `65-VERIFICATION.md` baseline of 220/1/3708/6/3. The +5 passed matches exactly (3 status-drift.test.ts + 2 drift-belief-correction-e2e.test.ts). The 3→4 skipped delta was investigated: it traces to `tests/sink.test.ts`'s `it.skipIf(!existsSync(BRAIN_DB) || !process.env['RECENSE_RUN_LIVE_TESTS'])` guard and similar environment/file-existence-gated live-data tests — pre-existing, environment-dependent, and untouched by any task in this plan (confirmed via `git diff` — none of the three tasks touch `sink.test.ts`, `snapshot.test.ts`, `recense-viz-no-open.test.ts`, or `locomo-harness.test.ts`, all of which carry this class of guard).

## Diff Gates (all passed)

- `git diff --stat -- src/consolidation/update-decision.ts src/consolidation/consolidator.ts src/db/schema.ts src/lib/config.ts` — empty
- `git diff --numstat -- src/consolidation/status-drift.ts` — confined to the set literal and its doc comment (22 insertions / 4 deletions)
- `grep -A6 "SELECT MAX" src/consolidation/status-drift.ts | grep -c "'unrelated'"` — `0` (no event-type literal in the SQL template)
- `npm run typecheck` — exit 0
- `grep -c "routeContradiction\|countDistinctProvenance\|\.evaluate("` on the e2e test file returns `1`, not the plan's target of `0` — see Deviations below; this single match is a pre-existing prose mention in the file's `DRIFT-03 consequence` describe-block header comment (`... so countDistinctProvenance can fire on genuinely independent email evidence ...`), present before any Task 3 edit (confirmed: `git show d10ca0d:tests/drift-belief-correction-e2e.test.ts | grep -c ...` also returns `1`). No assertion path added by this plan calls any of the three named functions directly (confirmed: `git diff tests/drift-belief-correction-e2e.test.ts | grep "^+" | grep -c ...` returns `0`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Scope note, not a fix] Pre-existing prose match on the "no direct calls" grep gate**
- **Found during:** Task 3 acceptance-criteria verification
- **Issue:** The plan's acceptance criterion `grep -c "routeContradiction\|countDistinctProvenance\|\.evaluate(" tests/drift-belief-correction-e2e.test.ts returns 0` fails against a pre-existing comment in the file's header (a prose sentence naming `countDistinctProvenance`), not against anything introduced by this plan.
- **Fix:** None applied — this is out-of-scope pre-existing content per the Scope Boundary rule (the comment predates Plan 65-11 and is unrelated to the three tasks' `<files>` list, which is `src/consolidation/status-drift.ts` and the two test files' NEW content). Verified via `git diff` that zero new occurrences were introduced.
- **Files modified:** none (documentation-only note)
- **Verification:** `git show d10ca0d:tests/drift-belief-correction-e2e.test.ts | grep -c "routeContradiction\|countDistinctProvenance\|\.evaluate("` returns `1` (pre-Task-3 baseline, identical to post-Task-3), confirming the match predates this plan's edits.

---

**Total deviations:** 1 (documented pre-existing gate mismatch, no code change)
**Impact on plan:** None on correctness — the gap-closure fix and its regression are both fully proven; this is a plan-authoring assumption about the file's pre-existing content that did not hold, surfaced here rather than silently absorbed.

## Issues Encountered

During execution, a `git stash` was mistakenly run against the committed Task 2 state while inspecting the working tree (a destructive-git-prohibition violation). It was immediately identified and recovered via `git stash pop` — verified as the single, freshly-created entry at `stash@{0}` before popping, with `git stash list` empty afterward and the Task 3 working-tree edits confirmed intact (`git diff --stat` unchanged before/after). No commits, other worktrees, or prior work were affected. Recorded here per the transparency the deviation rules require, even though no artifact required a fix.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- DRIFT-04 now holds for both the `'extend'`-anchored path (pre-existing coverage) and the cold-start `'unrelated'`-minted path (this plan) — the phase's literal success criterion is met for the common real-world case, not just the edge case an existing anchor provides.
- The three open `human_verification` items from `65-VERIFICATION.md` are **untouched by this plan and remain open by design**:
  1. Plan 65-10 Task 3's ENABLE/HOLD decision for `provenanceDistinctnessEnabled` (requires a real Gmail export + API key)
  2. WR-01's farming-bar accuracy review (pending the same Task 3 checkpoint)
  3. WR-03's quote-stripper idempotence defect review (pending the same Task 3 checkpoint)
- No blockers for Phase 66. This plan closes the single BLOCKER `65-VERIFICATION.md` raised; re-running phase verification should now score DRIFT-04 as fully verified.

## Self-Check: PASSED

- FOUND: `src/consolidation/status-drift.ts`
- FOUND: `tests/status-drift.test.ts`
- FOUND: `tests/drift-belief-correction-e2e.test.ts`
- FOUND: `.planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/65-11-SUMMARY.md`
- FOUND commit `2150c80` (test(65-11): RED)
- FOUND commit `d10ca0d` (fix(65-11): GREEN)
- FOUND commit `1b03628` (test(65-11): e2e regression)

---
*Phase: 65-belief-gated-status-drift-provenance-distinctness-fix*
*Completed: 2026-08-03*
