---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 06
subsystem: ingest
tags: [gmail, provenance, dedup, ordering, drift-03, drift-04]

# Dependency graph
requires:
  - phase: 65-03
    provides: "provenanceDistinctnessEnabled / provenanceMinResidualChars config knobs"
  - phase: 65-04
    provides: "deriveGmailProvenanceKey / COLLAPSED_GMAIL_PROVENANCE_KEY (src/source/provenance-key.ts)"
provides:
  - "RawGmailMessage.threadId captured from the existing messages.get response, zero new API calls"
  - "NormalizedRecord.provenance_key optional field + 7th SourceAdapter invariant documenting its provenance-honesty contract"
  - "normalizeGmailMessage derives and reports provenance_key behind the D-14 dark-launch switch, record.content unchanged"
  - "orderGmailBackfillByEventTime — slot-preserving chronological reorder applied to GmailAdapter.pull()'s query-backfill branch only"
  - "15-case adapter-level test suite (tests/gmail-provenance-key.test.ts) proving the wiring, both mutation checks recorded"
affects: [65-07, 65-08, 65-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Parallel slot-preserving reorder implementation (orderGmailBackfillByEventTime mirrors episode-order.ts's algorithm exactly, deliberately not shared, since NormalizedRecord and EpisodeRow are different types)"
    - "Dark-launch compute-always/report-conditionally switch (provenance_key computed unconditionally, reported behind provenanceDistinctnessEnabled)"

key-files:
  created:
    - tests/gmail-provenance-key.test.ts
  modified:
    - src/source/gmail-adapter.ts
    - src/source/source-adapter.ts
    - tests/gmail-adapter.test.ts
    - tests/gmail-adapter-multiaccount.test.ts
    - tests/gmail-event-ts.test.ts
    - tests/gmail-hidden-content.test.ts
    - tests/gmail-future-date-ordering.test.ts
    - tests/gmail-per-account-query.test.ts
    - tests/ingest-cli-multiaccount.test.ts

key-decisions:
  - "orderGmailBackfillByEventTime is a deliberate parallel implementation of orderEpisodesForConsolidation, not a generalized shared function — EpisodeRow carries DB-only fields NormalizedRecord doesn't have"
  - "provenance_key is derived from raw.bodyText (never strippedBody) so an over-cap message's STRIP_INPUT_OMITTED_MARKER sentinel can never be misread as genuine residual"
  - "tests/ingest-cli-multiaccount.test.ts's RawGmailMessage fixture also needed threadId — out of the plan's files_modified list but required for typecheck (Rule 3 blocking-issue fix)"

requirements-completed: [DRIFT-03, DRIFT-04]

# Metrics
duration: 40min
completed: 2026-08-03
---

# Phase 65 Plan 06: Gmail threadId Capture + Provenance Key Wiring + Backfill Ordering Summary

**Gmail's server-assigned threadId now flows into a derived, dark-launched `provenance_key` on every NormalizedRecord with zero new API calls, and a first-pull backfill batch is reordered oldest-event-first while incremental pulls stay untouched.**

## Performance

- **Duration:** 40 min
- **Completed:** 2026-08-03
- **Tasks:** 3/3 completed
- **Files modified:** 8 modified, 1 created

## Accomplishments

- `RawGmailMessage.threadId` captured from the existing `messages.get` response (`resp.data.threadId`) — no new API call, no quota change, falls back to `''` when absent.
- `NormalizedRecord.provenance_key?: string` added with a 7th adapter invariant on `SourceAdapter` documenting the provenance-honesty contract (source-controlled lineage only, never sender-controlled header reconstruction, collapsed-key fail-closed).
- `normalizeGmailMessage` widened to consume `provenanceDistinctnessEnabled`/`provenanceMinResidualChars`, derives the DRIFT-03 key from `raw.bodyText` (never `strippedBody`) and the invisible-codepoint-stripped `From:`, and reports either the derived key or the collapsed `ingest:gmail` literal behind the D-14 dark-launch switch — `record.content` stays byte-identical either way.
- `orderGmailBackfillByEventTime` — a deliberate parallel implementation of `orderEpisodesForConsolidation`'s slot-preserving reorder — applied only to `GmailAdapter.pull()`'s query-backfill branch (`cursor === null`); the incremental branch is untouched.
- 15-case adapter-level suite (`tests/gmail-provenance-key.test.ts`) plus fixture-only `threadId` additions across every pre-existing Gmail test file.

## Task Commits

1. **Task 1: Capture threadId and add NormalizedRecord.provenance_key** - `f3a3684` (feat)
2. **Task 2: Derive the key in normalizeGmailMessage and order the backfill batch chronologically** - `16853ce` (feat)
3. **Task 3: Adapter-level tests for key flow, content invariance, and backfill ordering** - `9ca5eb2` (test)

_Task 3 is `tdd="true"` in the plan; because it is adding TEST coverage for already-implemented Tasks 1-2 behavior (not new production behavior under a fresh RED/GREEN cycle), it landed as a single `test(...)` commit — there is no separate `feat` commit for Task 3 since the corresponding `feat` commits are Tasks 1-2, made before the tests were written._

## Files Created/Modified

- `src/source/gmail-adapter.ts` - `RawGmailMessage.threadId`, `deriveGmailProvenanceKey` call site in `normalizeGmailMessage`, `orderGmailBackfillByEventTime`, wired into `pull()`'s backfill branch
- `src/source/source-adapter.ts` - `NormalizedRecord.provenance_key?: string` + 7th adapter invariant
- `tests/gmail-provenance-key.test.ts` - new 15-case adapter-level suite (DRIFT-03/DRIFT-04)
- `tests/gmail-adapter.test.ts`, `tests/gmail-adapter-multiaccount.test.ts`, `tests/gmail-event-ts.test.ts`, `tests/gmail-hidden-content.test.ts`, `tests/gmail-future-date-ordering.test.ts`, `tests/gmail-per-account-query.test.ts`, `tests/ingest-cli-multiaccount.test.ts` - fixture-only `threadId` additions, no assertions changed

## Exact provenance_key values recorded (per plan `<output>` spec)

Fixture: `from: 'hr@acme.com'`, `threadId: 't1'`, `bodyText: 'We are moving forward with the next round of interviews.'`, `accountId: 'default'`.

- **Enabled** (`provenanceDistinctnessEnabled: true`): `record.provenance_key === 'ingest:gmail:acme.com:t1'`
- **Disabled** (`provenanceDistinctnessEnabled: false`, the shipped default): `record.provenance_key === 'ingest:gmail'` (== `COLLAPSED_GMAIL_PROVENANCE_KEY`)
- **`record.content` in both runs** (exact string, asserted verbatim in the content-invariance test):
  `From: hr@acme.com · Re: Status update · Acct: default\nWe are moving forward with the next round of interviews.`

## Test files whose fixtures gained `threadId`

`tests/gmail-adapter.test.ts`, `tests/gmail-adapter-multiaccount.test.ts`, `tests/gmail-event-ts.test.ts`, `tests/gmail-hidden-content.test.ts`, `tests/gmail-future-date-ordering.test.ts`, `tests/gmail-per-account-query.test.ts`, `tests/ingest-cli-multiaccount.test.ts` (the last one flagged by `npm run typecheck`, not in the plan's `files_modified` list — see Deviations).

## Mutation check results (acceptance-criteria requirement)

**Mutation check #1** — temporarily changed the derivation call to pass `bodyText: strippedBody` instead of `bodyText: raw.bodyText`:
- Result: **RED as expected.** `tests/gmail-provenance-key.test.ts`'s raw-body-sourcing case failed:
  `expected 'ingest:gmail:huge.com:t-huge' to be 'ingest:gmail'` — the over-cap body's `STRIP_INPUT_OMITTED_MARKER` sentinel (`'[body omitted: exceeds size limit]'`, ~36 non-whitespace chars) cleared the residual threshold and was misread as genuine content, producing a real (non-collapsed) key instead of the expected fail-closed collapse.
- Reverted; full suite green afterward.

**Mutation check #2** — temporarily dropped the `cursor === null` guard so `orderGmailBackfillByEventTime` applied unconditionally:
- Result: **RED as expected.** The incremental-pull test failed:
  expected `['first-fetched-newest', 'second-fetched-oldest']`, received `['second-fetched-oldest', 'first-fetched-newest']` — the incremental branch's fetch order was silently reordered by `event_ts` when it should have been preserved verbatim.
- Reverted; full suite green afterward.

## Decisions Made

- **`orderGmailBackfillByEventTime` is a parallel implementation, not a shared/generalized function.** `orderEpisodesForConsolidation` (`src/consolidation/episode-order.ts`) is typed on `EpisodeRow`, which carries DB-assigned fields (`id`, `ts`, `salience`, `consolidated`) a pre-append `NormalizedRecord` does not have. Widening that load-bearing consolidation-path signature to serve one ingest-side caller was rejected in favor of an intentionally identical algorithm in a second function, documented as such in both files' doc comments — `episode-order.ts` itself was verified untouched (`git diff --stat` shows zero changes).
- **`raw.bodyText`, never `strippedBody`, feeds the key derivation.** Documented inline and proven by the raw-body-sourcing test + mutation check #1: `strippedBody` can be the `STRIP_INPUT_OMITTED_MARKER` sentinel for over-cap messages, which reads as "no quote markers, plenty of residual" and would defeat the residual gate.
- **Backfill reorder is scoped to `cursor === null` only.** The incremental branch (`users.history.list`) already delivers messages in `messageAdded` order and is a small delta, not a full backlog; reordering it would be both unnecessary and (per mutation check #2) actively wrong.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] `tests/ingest-cli-multiaccount.test.ts`'s `RawGmailMessage` fixture also needed `threadId`**
- **Found during:** Task 1 (typecheck verification)
- **Issue:** `npm run typecheck` flagged this file's `makeRaw()` helper as missing the now-required `threadId` field. This file is not in the plan's `files_modified` list, but `RawGmailMessage`'s new required field makes every existing fixture across the codebase a compile error until fixed.
- **Fix:** Added `threadId: 'thread-001'` to the fixture, matching the pattern used in every other affected test file.
- **Files modified:** `tests/ingest-cli-multiaccount.test.ts`
- **Verification:** `npm run typecheck` exits 0; the file's own test suite unaffected (not run as part of this plan's verification block, but its only change is the added fixture field).
- **Committed in:** `f3a3684` (Task 1 commit)

## Self-Check: PASSED

- FOUND: `/Users/vtx/brain-memory/.claude/worktrees/agent-aecd50c2196e547c8/src/source/gmail-adapter.ts`
- FOUND: `/Users/vtx/brain-memory/.claude/worktrees/agent-aecd50c2196e547c8/src/source/source-adapter.ts`
- FOUND: `/Users/vtx/brain-memory/.claude/worktrees/agent-aecd50c2196e547c8/tests/gmail-provenance-key.test.ts`
- FOUND commit `f3a3684`
- FOUND commit `16853ce`
- FOUND commit `9ca5eb2`
