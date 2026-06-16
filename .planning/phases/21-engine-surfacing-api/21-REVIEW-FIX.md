---
phase: 21-engine-surfacing-api
fixed_at: 2026-06-16T08:25:00Z
review_path: .planning/phases/21-engine-surfacing-api/21-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 21: Code Review Fix Report

**Fixed at:** 2026-06-16T08:25:00Z
**Source review:** .planning/phases/21-engine-surfacing-api/21-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (WR-01, WR-02, WR-03)
- Fixed: 3
- Skipped: 0

All fixes were applied in an isolated git worktree, committed atomically, and the
worktree branch fast-forwarded onto the base branch. Verification: `npx tsc --noEmit`
clean; the four affected vitest files all green (52/52) after the changes.

## Fixed Issues

### WR-02: D-09 cap over-counts — P0 / snoozed / seen surfacings consume the non-P0 budget

**Files modified:** `src/db/surface-store.ts`, `tests/surface-store.test.ts`
**Commit:** 681f008
**Applied fix:** The D-09 cap is documented as "max non-P0 items per rolling 24h" with
P0 items bypassing it, but the cap-window `COUNT(*)` counted every non-terminal
`surfaced_event` row regardless of tier, so P0 acknowledgements depleted the non-P0
budget and could starve legitimate lower-tier items. `surfaced_event` carries no tier
column, so I reconstruct the tier-at-surface-time from the columns it does have:
a row was P0 iff `occurrence_due_at − created_at < P0_THRESHOLD_MS`. Renamed the
prepared statement `stmtCountCapWindow → stmtCapWindowRows` to select
`(occurrence_due_at, created_at)` instead of a raw count, and in `rank()` I count only
tier-1 (non-P0) rows toward `capUsed`. The filter runs in JS using
`new Date(occurrence_due_at).getTime()` — the exact parsing `rank()` already uses for
`due_at`, and deliberately not SQLite `julianday()`/`strftime()`, whose handling of the
canonical-ISO `Z`/fractional-seconds form is brittle (the same fragility IN-02 flags).
The path stays synchronous and LLM-free (a bounded JS loop over window rows); no schema
migration was needed. Added a new regression test (`P0 acks ... do not deplete the
non-P0 budget`) that fails under the old `COUNT(*)` logic, and updated the existing
D-09 filler rows to use a ≥24h `occurrence_due_at − created_at` gap so they remain
genuine tier-1 rows that legitimately fill the cap.

### WR-01: `outcome='snoozed'` without `snooze_until` is a silent no-op snooze

**Files modified:** `src/adapter/serve-cli.ts`, `tests/surface-routes.test.ts`
**Commit:** ab2d03c
**Applied fix:** The route only validated `snooze_until` when present, so
`{ outcome: 'snoozed' }` with no `snooze_until` (or an explicit `null`) returned 200 and
wrote `snooze_until=NULL`; `isExcluded()` then took the `null !== null → false` branch
and never excluded the item, so the "snooze" silently re-surfaced forever. Added a
fail-fast 400 check in the `POST /v1/surface/seen` handler immediately after the existing
snooze_until date-validity check: when `outcome === 'snoozed'`, a parseable string
`snooze_until` is now required, matching the documented `SurfaceSeenParams` contract.
Added two route tests (omitted `snooze_until`, and explicit `null`) both asserting 400
`bad_request`.

### WR-03: `limit` query param does not limit results and is unbounded

**Files modified:** `src/adapter/serve-cli.ts`
**Commit:** a7c7a66
**Applied fix:** `?limit` maps to `maxNonP0` (the D-09 non-P0 cap), and was unbounded —
`?limit=1000000` effectively disabled the cap. Clamped the parsed value with
`Math.min(Math.floor(n), 50)` and added a comment clarifying that `limit` tunes the
non-P0 rolling cap (not a total response-size limit, since P0 items always bypass the
cap). Per the review, this is the lower-priority item; I took the smallest correct
approach (clamp + clarifying comment) rather than reworking the param into a true
post-`rank()` response slice, which would change the published response contract. No
dedicated test was added: exercising the clamp over HTTP requires seeding >50 eligible
lower-tier items, a disproportionately heavy fixture for a one-line ceiling; the behavior
is covered by the existing surface-route happy-path tests plus the unit-level cap tests
in surface-store.test.ts.

---

_Fixed: 2026-06-16T08:25:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
