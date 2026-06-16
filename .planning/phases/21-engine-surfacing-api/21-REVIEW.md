---
phase: 21-engine-surfacing-api
reviewed: 2026-06-16T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/db/schema.ts
  - src/db/surface-store.ts
  - src/adapter/memory-ops.ts
  - src/adapter/serve-cli.ts
  - tests/surface-store.test.ts
  - tests/memory-ops-surface.test.ts
  - tests/surface-routes.test.ts
  - tests/surface-sentinel.test.ts
  - tests/surfaced-event-schema.test.ts
findings:
  critical: 0
  warning: 3
  info: 2
  total: 5
status: issues_found
---

# Phase 21: Code Review Report

**Reviewed:** 2026-06-16T00:00:00Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Reviewed the Phase 21 engine-surfacing API: the `surfaced_event` table (schema v9),
the LLM-free `SurfaceStore.rank()` engine, the `surface()`/`surfaceSeen()` ops, the
`GET /v1/surface` + `POST /v1/surface/seen` routes, and the D-43 sentinel.

The load-bearing correctness invariants hold:

- **D-43 (no belief strengthening):** `surfaceSeen()` writes only `surfaced_event`;
  `rank()` is read-only by construction. Verified by the sentinel test asserting
  byte-identical `node.s`/`node.c`. No `node` mutation exists on any surface path.
- **D-08 (operational isolation):** confirmed via grep — zero `surfaced_event`
  references in `src/consolidation/`.
- **SQL parameterization:** every filter value is a bound parameter; no string
  interpolation anywhere in `SurfaceStore` or the upsert. No injection surface.
- **Read-handle/write-lock boundary:** `rank()` runs on the read-only handle with no
  lock; `surfaceSeen()` acquires the single-writer lock with `try/finally` release.
- **Input validation:** the POST route validates types, date-parseability, and the
  outcome enum before any write; node-existence is checked before the upsert (no
  orphan rows).

Three correctness/robustness defects worth fixing surfaced in the D-09 rolling-cap
logic and the snooze contract, plus two minor quality items. None are blockers.

## Warnings

### WR-01: `outcome='snoozed'` without `snooze_until` is a silent no-op snooze

**File:** `src/adapter/serve-cli.ts:450-466`, `src/adapter/memory-ops.ts:432-457`, `src/db/surface-store.ts:125-134`
**Issue:** The documented contract (`SurfaceSeenParams.snooze_until`: "required when
outcome = 'snoozed'", memory-ops.ts:125) is not enforced. The route only validates
`snooze_until` *when present* (serve-cli.ts:458). A `POST /v1/surface/seen` with
`{ outcome: 'snoozed' }` and no `snooze_until` is accepted (200), writes
`outcome='snoozed', snooze_until=NULL`, and then in `isExcluded()` takes the branch
`snooze_until !== null && ... ` → `null !== null` is `false` → **not excluded**. The
item the user tried to snooze keeps surfacing on every subsequent `rank()`. For the
Phase 22 notify-only push client this means a "snooze" produces repeated unwanted
notifications.
**Fix:** Reject the combination at the route (preferred — fail fast):
```ts
if (parsed.outcome === 'snoozed' &&
    (typeof parsed.snooze_until !== 'string' || Number.isNaN(Date.parse(parsed.snooze_until)))) {
  jsonError(res, 400, { error: 'bad_request', detail: "snooze_until is required when outcome='snoozed'" });
  logRequest('POST', url, 400, Date.now() - start);
  return;
}
```
Alternatively, define and implement a deterministic null-snooze semantic (e.g., treat
`snoozed` + null as "snooze until next occurrence") rather than the current accidental
"snooze does nothing."

### WR-02: D-09 cap over-counts — P0 / snoozed / seen surfacings consume the non-P0 budget

**File:** `src/db/surface-store.ts:181-185, 222-223, 269-272`
**Issue:** The cap-window count query counts **every** non-terminal `surfaced_event`
row (`outcome NOT IN ('completed','dismissed')`), but `surfaced_event` carries no tier
discriminator, so the count includes P0 acknowledgements and snoozed/seen rows. The
spec and the in-code comment both say this is "max **non-P0** items per rolling 24h"
and that "P0 items bypass the cap" — but here P0 surfacings *deplete* `capUsed`
(surface-store.ts:223), shrinking `allowed = max(0, maxNonP0 - capUsed)` for genuine
lower-tier items. Concretely: acknowledge 5 urgent P0 meetings in 24h →
`capUsed = 5 = maxNonP0` → `allowed = 0` → a legitimate 3-day-out deadline (tier 1)
is silently suppressed for the rest of the window, even though no lower-tier item was
ever surfaced. P0 items themselves are returned unbounded, so the cap is mis-applied
in exactly the wrong direction. The existing D-09 test (surface-store.test.ts:321) only
asserts `capUsed=5` from filler rows and does not exercise the P0-starves-lower case.
**Fix:** Make the count tier-aware. `surfaced_event` has both `created_at` and
`occurrence_due_at`, so P0-at-surface-time is reconstructable
(`occurrence_due_at - created_at < P0_THRESHOLD_MS`). Exclude P0 rows from the cap
count, e.g. add a predicate that drops rows whose occurrence was within the P0 window
at surface time, or persist the tier on the row at write time and filter on it:
```sql
SELECT COUNT(*) AS n FROM surfaced_event
WHERE created_at >= @windowStart
  AND outcome NOT IN ('completed', 'dismissed')
  AND (julianday(occurrence_due_at) - julianday(created_at/86400000.0 ... )) -- exclude P0
```
(simplest robust path: add a `tier` column written by `surfaceSeen()` and count
`WHERE tier = 1`).

### WR-03: `limit` query param does not limit results and is unbounded

**File:** `src/adapter/serve-cli.ts:404-414`
**Issue:** The `limit` query param maps to `maxNonP0` (the rolling cap), not to a
response-size limit. P0 items bypass the cap entirely (surface-store.ts:272), so a
caller passing `?limit=2` still receives every eligible P0 item plus up to 2 lower-tier
items — the response is not bounded by `limit`. There is also no upper bound on the
parsed value: `?limit=1000000` sets `maxNonP0 = 1_000_000`, effectively disabling the
cap and returning all lower-tier rows. A REST caller (Tonos, curl) will reasonably read
`limit` as a page size and get a surprising, potentially large payload.
**Fix:** Either rename the param to reflect that it tunes the non-P0 cap and clamp it
to a sane ceiling, or implement a true response cap applied after `rank()`:
```ts
if (limitRaw !== null) {
  const n = Number(limitRaw);
  if (Number.isFinite(n) && n > 0) surfaceOpts.maxNonP0 = Math.min(Math.floor(n), 50);
}
```
If a hard total-result ceiling is desired, slice the combined `rank()` output in the
route before responding.

## Info

### IN-01: `idx_surfaced_event_node_occ` duplicates the UNIQUE index

**File:** `src/db/schema.ts:302-306`
**Issue:** `UNIQUE(node_id, occurrence_due_at)` (schema.ts:145) already creates an
implicit index on `(node_id, occurrence_due_at)`. The v9 migration then explicitly
creates `idx_surfaced_event_node_occ` on the same columns — and the adjacent comment
(schema.ts:302) even states the pair is "covered by UNIQUE constraint" immediately
before creating the redundant index. Dead/redundant DDL.
**Fix:** Drop the `idx_surfaced_event_node_occ` creation; the UNIQUE constraint already
serves the exclusion lookup (`stmtSurfacedEvent`) and the cap window has its own
`idx_surfaced_event_outcome`.

### IN-02: `due_at >= @pastCutoff` relies on canonical ISO-8601 lexical ordering

**File:** `src/db/surface-store.ts:173, 217`
**Issue:** The past-event guard compares `node_temporal.due_at` (TEXT) against an ISO
string from `new Date(...).toISOString()` using SQL string comparison. This is only
chronologically correct if every stored `due_at` is the exact canonical
`YYYY-MM-DDTHH:mm:ss.sssZ` form. A non-canonical writer (e.g. `...T00:00:00Z` without
milliseconds, or a non-`Z` offset) would sort lexically wrong at the boundary
(`'Z' > '.'`), letting a just-stale one-off item slip past the grace cutoff. The
Phase 20 Calendar adapter currently controls this format, so it is latent rather than
live.
**Fix:** Either assert/normalize `due_at` to canonical `toISOString()` form at write
time (node_temporal upsert), or compare on epoch ms rather than ISO text to remove the
format dependency.

---

_Reviewed: 2026-06-16T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
