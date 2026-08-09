---
phase: 62-multi-inbox-email-ingest-hardening
plan: 10
subsystem: security
tags: [email-ingest, event-ordering, date-clamp, gap-closure, cr-03]

# Dependency graph
requires:
  - phase: 62-05
    provides: "event_ts wiring — normalizeGmailMessage(...).event_ts + orderEpisodesForConsolidation ascending sort"
provides:
  - "parseEmailDate clamped to nowMs on the accepted-future branch (CR-03 fix) — the return is always null or <= nowMs, never a value the caller could read as in the future"
  - "Corrected JSDoc/design-block claim: the T-62-23 'sort myself last cannot be expressed' overclaim replaced by the bounded guarantee plus its named residual"
  - "Regression lock at unit + end-to-end level in tests/gmail-future-date-ordering.test.ts, including a deliberate lock on the accepted residual"
affects: [63-offline-intent-classification, 65-belief-gated-status-drift]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Math.min(parsed, nowMs) clamp on a security-load-bearing parse's accepted branch — caps a sender-controlled value at a caller-supplied trusted ceiling rather than only rejecting it outright"]

key-files:
  created:
    - tests/gmail-future-date-ordering.test.ts
  modified:
    - src/source/gmail-adapter.ts
    - tests/gmail-event-ts.test.ts

key-decisions:
  - "Implemented 62-VERIFICATION.md gaps[1] missing: bullet 1 verbatim (Math.min(parsed, nowMs)) rather than bullet 3's literal ordering assertion, per this plan's <interfaces> CRITICAL resolution — the two bullets are mutually inconsistent under the clamp (measured arithmetic below), and bullet 1 is what both the reviewer and verifier prescribe with the exact expression"
  - "Locked the resulting residual (clamped forged header still outranks earlier-in-window genuine messages) as a DELIBERATE regression test in Task 3, not left implied or silently accepted"
  - "[Rule 1 - bug in pre-existing fixtures] tests/gmail-event-ts.test.ts's makeRaw() default date and 3 direct parseEmailDate assertions used a same-day-but-later-time-of-day header (10 hours after NOW), which the new clamp now clamps to NOW — moved the fixtures to the day before NOW so they keep testing plain well-formed parsing instead of silently starting to test the clamp; not anticipated by the plan's stated diff-confinement acceptance criterion for this file, documented here as a necessary deviation"

requirements-completed: [EMAIL-04]

# Metrics
duration: ~35min
completed: 2026-07-30
---

# Phase 62 Plan 10: CR-03 Forged-Future-Date Clamp Summary

**Closed CR-03 (BLOCKER): `parseEmailDate` now clamps every accepted future-dated `Date:` header to `nowMs`, so a sender-forged header can never buy more ordering advantage than sending honestly at the pull instant — proved RED-before-GREEN at unit and end-to-end-ordering level, with the residual the clamp does not close locked as a deliberate, measured, accepted test rather than left implied.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-30
- **Tasks:** 3 (RED / GREEN / residual lock)
- **Files modified:** 2 production+test-reconciliation, 1 new test file

## Accomplishments

- Closed `62-VERIFICATION.md` gaps[1] / `62-REVIEW.md` CR-03 (BLOCKER): `parseEmailDate`'s final `return parsed;` is now `return Math.min(parsed, nowMs);` — the accepted-future branch can never return a value greater than `nowMs`
- Corrected the JSDoc and file-level `EMAIL-04` design block: the shipped T-62-23 "'sort myself last' cannot be expressed (mitigated)" claim — false inside the 48h window — is replaced by a four-part statement of what is actually guaranteed (far-past accepted, beyond-window still null, in-window clamped-to-nowMs with the "no capability the sender didn't already have" reasoning, and the named residual with its real fix)
- Preserved `tests/gmail-event-ts.test.ts:88-96`'s existing `not.toBeNull()` lock exactly as written and strengthened it with a `toBe(NOW)` assertion, so a silent clamp revert now fails this pre-existing test too
- Locked the CR-03 reproduction as a regression at unit level (clamp invariant over a header set), no-marginal-advantage level (exact equality between a forged and an honestly-present-dated header, through both `parseEmailDate` directly and the real `normalizeGmailMessage`), and end-to-end level (through `orderEpisodesForConsolidation`, proving the final slot is now decided by the non-sender-controlled `EpisodeRow.id` tie-break rather than the forged value)
- Locked the accepted residual — a clamped forged header still outranks genuine messages dated earlier in the same pull window — as a deliberate test with its exact bound (zero marginal advantage over sending at the pull instant) and its real fix (Gmail's server-assigned `internalDate`) named for the backlog

## Task Commits

Each task was committed atomically:

1. **Task 1: Demonstrate the ordering lever with failing tests (RED)** — `3bcb96d` (test)
2. **Task 2: Clamp the accepted-future branch and correct the JSDoc overclaim (GREEN)** — `a2b1c39` (fix)
3. **Task 3: Measure and record the residual the clamp does not close** — `ff51cb6` (test)

**Plan metadata:** committed as part of this SUMMARY commit (worktree mode — STATE.md/ROADMAP.md updates deferred to orchestrator)

## RED evidence (Task 1)

Verify command exited non-zero as required (`EXIT=1` confirmed independently). 7 of 13 tests in the new `tests/gmail-future-date-ordering.test.ts` failed against the unfixed code; 6 passed (the unaffected branches: far-future-null, the two never-clamped genuine-past headers, "older never in final slot" in both id-tie-break runs, and the far-future-index-preservation case).

`NOW = Date.UTC(2026, 5, 9)` = `1780963200000` ms.

| Test | Pre-fix observed value | Expected (post-fix) |
|---|---|---|
| `parseEmailDate(forged47h, NOW)` clamps to exactly NOW | `1781132400000` (= NOW + 47h, delta **169,200,000 ms = 47.0 hours**) | `1780963200000` (NOW) |
| `parseEmailDate(forged24h, NOW)` clamps to exactly NOW | `1781049600000` (= NOW + 24h, delta 86,400,000 ms = 24.0 hours) | `1780963200000` (NOW) |
| invariant: result is null or `<= NOW` over the full header set | `false` (violated by `forged47h`/`forged24h`) | `true` |
| `forged47h` == `presentDated` under `parseEmailDate` | `1781132400000` ≠ `1780963200000` | equal |
| `forged47h` == `presentDated` through `normalizeGmailMessage` | unequal `event_ts` | equal |
| `forged.event_ts === present.event_ts === NOW` (end-to-end setup) | `forged.event_ts = 1781132400000` ≠ `present.event_ts = 1780963200000` | both `1780963200000` |
| final-slot id-tie-break flip | **`forged` occupied the final event-time-bearing slot in BOTH id-tie-break runs** (`finalAIsForged === finalBIsForged === true` in both) — the forged VALUE decided position, not the tie-break | flips between runs |

The pre-fix `parseEmailDate(forged47h, NOW)` value (`1781132400000`) and its 47-hour delta from `NOW` exactly match the arithmetic recorded in the plan's `<objective>` reproduction table (`1785595126000` at `nowMs = 1785425926000`, same 47h delta, different absolute `nowMs` because this test file uses its own fixed `NOW` per the sibling-file convention).

`git diff --exit-code src/source/gmail-adapter.ts` exited 0 in this state (no production edit in Task 1). `npx tsc --noEmit` exited 0.

## The fix (Task 2)

```ts
if (parsed > nowMs + MAX_FUTURE_SKEW_MS) return null;
// CR-03: a future-dated header inside the skew window is still sender-controlled, so it is
// clamped to nowMs and can never exceed it — the forgery buys no ordering advantage over an
// honest header dated at the pull instant.
return Math.min(parsed, nowMs);
```

Constants (`MIN_PLAUSIBLE_EVENT_MS`, `MAX_FUTURE_SKEW_MS`) and every guard above the final return are byte-for-byte unchanged. `git diff -U0 src/source/gmail-adapter.ts` confirmed changes confined to exactly three regions: the file-level `EMAIL-04` design block, `parseEmailDate`'s JSDoc, and its final return statement — nothing at or below the `normalizeGmailMessage` provenance-header lines (plan 62-11's territory).

### The rewritten JSDoc's four-part claim

1. **(i) far-past forgery** — still harmless and accepted (T-62-24, unchanged): it sorts the forged evidence earlier, so genuine newer evidence still wins.
2. **(ii) beyond the 48h skew window** — still returns `null` and the episode is still excluded from reordering entirely (T-62-23, true only for this branch now — the old JSDoc claimed this held for the whole future direction, which was false).
3. **(iii) inside the window (the CR-03 fix)** — the value is clamped to `nowMs`, so `parseEmailDate` can never return `> nowMs`; the maximum ordering position a forgery can buy equals the position obtainable for free by sending at the pull instant, so the forgery confers no capability the sender did not already have.
4. **(iv) the named residual** — within one pull, a clamped forged header still sorts after genuine messages dated earlier in that same pull window, bounded by the pull interval and equivalent to sending at the pull instant; the real fix (Gmail's server-assigned `internalDate`, not sender-controlled) requires changing `RawGmailMessage`, `RealGmailFetcher.fetchMessages`, and every test fake — deliberately out of scope here, flagged for the backlog.

The file-level `EMAIL-04` design block (`:29-40`) was corrected in the same terms — it previously claimed the clamp "closes" the attack; it now states the bounded guarantee plus the residual.

### `tests/gmail-event-ts.test.ts:88-96` reconciliation

The existing assertion `expect(parseEmailDate(future24h, NOW)).not.toBeNull()` holds exactly as written — the clamp returns `NOW`, which is non-null — and was **not edited or deleted**. A second assertion, `expect(parseEmailDate(future24h, NOW)).toBe(NOW)`, was added in the same `it()`, with the `it()` title extended to "...and is clamped to nowMs" and the file-level doc block's bullet 1 updated to match. A silent revert of the clamp now fails this pre-existing test in addition to the new file's clamp-invariant block.

### Deviation: pre-existing fixture collision (Rule 1 — bug, not a plan-scope-of-record edit)

The plan's acceptance criterion for this task stated the diff to `tests/gmail-event-ts.test.ts` should be confined to the 24h-future `it()` block, its title, and the file-level doc block. Running the task-2 verify command surfaced a real collision the plan's own analysis did not anticipate:

- `NOW = Date.UTC(2026, 5, 9)` = `2026-06-09T00:00:00.000Z` (exact midnight).
- `makeRaw()`'s default fixture date, and three direct `parseEmailDate` unit tests ("parses a well-formed header", "+0530 offset", "GMT named zone"), all used `'Mon, 9 Jun 2026 10:00:00 ...'` — **10 hours AFTER `NOW`**, same calendar day.
- Pre-fix, that 10-hour-future header was inside the accepted (unclamped) window and returned its raw parsed value, which these tests pinned exactly.
- Post-fix, ANY header later than `nowMs` — not just deliberately-forged multi-hour-ahead ones — clamps to `nowMs`. These four fixtures would have silently started asserting the clamp's output instead of testing "does a well-formed RFC 2822 header parse correctly," changing what they tested without any visible signal.

Fix applied: moved the four affected header literals (and the corresponding expected values, which are either computed dynamically via `Date.parse`/`Date.UTC` of the same literal, or the one hardcoded `Date.UTC` call updated to match) to the day **before** `NOW` (`'Mon, 8 Jun 2026 10:00:00 ...'`), safely outside the clamp's reach, so they resume testing plain well-formed parsing. Also updated two `not.toContain` negative-string-literal assertions in the unrelated "no date interpolated" test to reference the new default date, for precision (they remained trivially true either way — the provenance header never interpolates a date — but now reference the actual fixture value). No assertion was weakened: every changed expectation still pins an exact value; only the input date and its dependent exact-value literal moved.

Verified: `npx vitest run tests/gmail-future-date-ordering.test.ts tests/gmail-event-ts.test.ts tests/episode-order.test.ts tests/gmail-adapter.test.ts tests/backfill-chronological-order.test.ts` → 5 files / 59 tests, all passed. `npx tsc --noEmit` exits 0.

## Named residual, its bound, and its real fix (Task 3)

**What the clamp closes:** `parseEmailDate` can never return a value `> nowMs`. A forged `Date:` no longer buys a position after messages that arrive up to 48 hours *later* than the attacker's own message — the net-new capability plan 62-05 introduced (a position genuinely unobtainable by honest sending) is removed.

**What the clamp does NOT close:** within a single pull, a clamped forged header still sorts after genuine messages dated earlier in that same pull window. Locked as a deliberate test (`describe('parseEmailDate clamp — NAMED RESIDUAL...')`):
- `forged.event_ts (NOW)` is still `> older.event_ts (NOW - 1h)`, so `orderEpisodesForConsolidation` still places `forged` in the final slot in that two-row scenario — asserted as the true post-fix reality, not weakened to match the unachievable aspiration.
- **Bound, measured:** `parseEmailDate(forged47h, NOW) - parseEmailDate(presentDated, NOW) === 0` — a forged header buys **exactly zero milliseconds** of advantage over an honest header sent at the pull instant.
- **Pre-fix contrast, measured:** `Date.parse(forged47h) - NOW === 47 * 3_600_000` (the raw header still literally carries the 47-hour forgery) while `parseEmailDate(forged47h, NOW) - NOW === 0` (the parse no longer propagates it). Pre-fix, both expressions evaluated to `47 * 3_600_000` — the parse propagated the forgery unchanged, which is exactly what Task 1's RED evidence recorded.

**Equivalent honest capability:** the residual is bounded by the pull interval (`GmailAdapter.pull()` reads `nowMs` once per pull, per this plan's `<threat_model>` trust-boundary table) and is equivalent to the sender simply sending at the pull instant — a capability the sender already has without forging anything.

**The real fix (not done here, flagged for the backlog):** use Gmail's server-assigned `internalDate` (not sender-controlled) as the `event_ts` source, or as the clamp ceiling. Cost: changes `RawGmailMessage`, `RealGmailFetcher.fetchMessages`, and every test fake — a rearchitecture beyond this gap-closure wave's "small and surgical" scope.

**Why `62-VERIFICATION.md` gaps[1] `missing:` bullet 3 is unachievable as literally worded, with the arithmetic:** bullet 3 asked for an assertion that a `now+47h` forged header does NOT occupy the final event-time-bearing slot versus a `now-1h` genuine header. Under bullet 1's prescribed clamp, `parseEmailDate(forged47h, NOW) = NOW = 1780963200000` while `parseEmailDate(genuineMinus1h, NOW) = NOW - 3_600_000 = 1780959600000`. Since `1780963200000 > 1780959600000`, `orderEpisodesForConsolidation`'s ascending sort still places the forged episode last. The two `missing:` bullets are mutually inconsistent under the fix both bullets otherwise agree on; this plan implements bullet 1 verbatim (per its own reviewer/verifier-matching precision) and asserts the property that is both true and the actual security content — zero marginal advantage over honest sending — rather than the unachievable literal wording of bullet 3.

Verified: `npx vitest run tests/gmail-future-date-ordering.test.ts tests/gmail-event-ts.test.ts tests/episode-order.test.ts` → 3 files / 43 tests, all passed. `git diff a2b1c39 --exit-code src/source/gmail-adapter.ts` exits 0 (no further production edits beyond Task 2).

## Full-suite counts

- **Post-build pre-plan baseline** (this worktree, after `npm run build` to populate `dist/` for CLI-subprocess tests): `192 test files passed | 1 skipped (193)`, `2879 passed | 4 skipped (2883)`.
- **Post-plan (after all three tasks):** `193 test files passed | 1 skipped (194)`, `2895 passed | 4 skipped (2899)`.
- Delta: +1 test file (`tests/gmail-future-date-ordering.test.ts`), +16 tests (13 from Task 1 + 3 from Task 3), 0 new failures, 0 newly-skipped.

`npx tsc --noEmit` exits 0 at every checkpoint.

## Files Created/Modified

- `tests/gmail-future-date-ordering.test.ts` (new) — the CR-03 reproduction locked as a regression: clamp invariant, no-marginal-advantage equality, end-to-end ordering consequence through `orderEpisodesForConsolidation`, and the named-residual deliberate lock
- `src/source/gmail-adapter.ts` — `parseEmailDate`'s final return clamped to `nowMs`; JSDoc and file-level `EMAIL-04` block corrected to state only the bounded guarantee plus the residual
- `tests/gmail-event-ts.test.ts` — 24h-future lock strengthened (not weakened); four pre-existing fixtures using a same-day-later-time header moved to the day before `NOW` to keep testing well-formed parsing rather than silently starting to test the clamp

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pre-existing `tests/gmail-event-ts.test.ts` fixtures collided with the mandated clamp**
- **Found during:** Task 2 verify command
- **Issue:** `makeRaw()`'s default date and three direct `parseEmailDate` assertions used a header 10 hours after the file's `NOW` constant. The clamp — mandated verbatim by this plan and by `62-REVIEW.md` CR-03's fix — now clamps ANY header later than `nowMs`, so these fixtures would have silently started testing clamp behavior instead of their stated purpose (well-formed RFC 2822 parsing), or (as observed) simply failed 4 tests outright.
- **Fix:** Moved the four affected header literals from "9 Jun 2026" (future relative to NOW) to "8 Jun 2026" (past relative to NOW), updating dependent exact-value expectations to match. No assertion was weakened or removed; the 24h-future test's already-planned reconciliation was untouched by this fix.
- **Files modified:** `tests/gmail-event-ts.test.ts` (in addition to the plan's stated 24h-future `it()` block, title, and file-level doc block)
- **Verification:** `npx vitest run tests/gmail-future-date-ordering.test.ts tests/gmail-event-ts.test.ts tests/episode-order.test.ts tests/gmail-adapter.test.ts tests/backfill-chronological-order.test.ts` — 59/59 passed
- **Committed in:** `a2b1c39` (Task 2)

---

**Total deviations:** 1 auto-fixed (Rule 1, pre-existing test fixture collision with the mandated fix)
**Impact on plan:** Necessary for the plan's own hard requirement ("Every previously-green test must stay green") and for the full-suite-green success criterion; without it, 4 tests fail that this plan's mandated fix legitimately breaks. Confined to test fixtures only — no weakening of the clamp, no change to its scope, no change to `src/source/gmail-adapter.ts` beyond what Task 2 already specified.

## Issues Encountered

None beyond the deviation documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- CR-03 (BLOCKER) is closed: `parseEmailDate` can never return a value greater than `nowMs`, verified at unit, cross-parse-equality, and end-to-end-ordering granularity
- The named residual (bounded by the pull interval, equivalent to honest send-at-pull-instant) is explicitly not claimed as closed — flagged for the backlog with its real fix (Gmail `internalDate`) named, so a future verification pass reads a reasoned decision rather than an apparent omission
- `62-VERIFICATION.md` gaps[1] and `62-REVIEW.md` CR-03 are both addressed; the remaining gap-closure items in this wave are owned by sibling plans (62-09 on `strip-hidden.ts`, 62-11 on the provenance-header lines below `normalizeGmailMessage`'s `:300`)
- All EMAIL-01/EMAIL-02 VERIFIED files (`src/adapter/gmail-auth-cli.ts`, `src/adapter/runtime-config.ts`, `src/lib/config.ts`, `src/adapter/recense-doctor.ts`) and DRIFT-03/04 files (`src/consolidation/update-decision.ts`) confirmed untouched (`git diff --exit-code` clean)
- `src/db/schema.ts` untouched, `SCHEMA_VERSION` unchanged

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*

## Self-Check: PASSED

- FOUND: tests/gmail-future-date-ordering.test.ts
- FOUND: src/source/gmail-adapter.ts
- FOUND: tests/gmail-event-ts.test.ts
- FOUND: .planning/phases/62-multi-inbox-email-ingest-hardening/62-10-SUMMARY.md
- FOUND commit: 3bcb96d (Task 1 RED)
- FOUND commit: a2b1c39 (Task 2 GREEN)
- FOUND commit: ff51cb6 (Task 3 residual lock)
- FOUND commit: 4724d77 (SUMMARY)
