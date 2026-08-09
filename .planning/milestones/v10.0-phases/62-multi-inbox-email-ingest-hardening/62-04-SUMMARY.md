---
phase: 62-multi-inbox-email-ingest-hardening
plan: 04
subsystem: ingest
tags: [schema-migration, gmail, event-ts, security, temporal]

# Dependency graph
requires:
  - phase: 62-01
    provides: "resolveAccountQuery / GmailAdapter per-account plumbing that Task 3 reads-first"
  - phase: 62-03
    provides: "normalizeGmailMessage's stripHiddenContent-before-redactSecrets ordering, which event_ts threading composes with rather than fights"
provides:
  - "episode.event_ts INTEGER — nullable, additive column via guarded ALTER; SCHEMA_VERSION 16"
  - "EpisodeRow.event_ts / AppendEventParams.event_ts? / RecordEventParams.eventTs? / NormalizedRecord.event_ts? — the full field-name chain from adapter to row"
  - "parseEmailDate(header, nowMs) — confident-or-null RFC 2822 Date: header parse with a 48h future-skew security clamp"
  - "GmailAdapter emits event_ts from parseEmailDate on every pulled message"
affects: [62-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive nullable-column migration via PRAGMA table_info guard + ALTER TABLE ADD COLUMN — the same pattern already shipped for source/external_id/cwd/kind, now shipped a fourth time for event_ts"
    - "Explicit nowMs parameter threaded through a pure normalizer, with Date.now() read exactly once at the adapter's single impure call site (mirrors calendar-adapter.ts's selectSyncEvents Date.now()-default-param precedent) — no clock injected into GmailAdapter's constructor"
    - "Argument-anchored grep gate (toBe/toEqual('15'|15)) as the authoritative stale-assertion check across 3 syntactically different receiver forms, in place of a receiver-anchored pattern that would always be one form behind"

key-files:
  created:
    - tests/episode-event-ts.test.ts
    - tests/gmail-event-ts.test.ts
  modified:
    - src/db/schema.ts
    - src/lib/types.ts
    - src/db/episode-store.ts
    - src/ingest/pipeline.ts
    - src/source/source-adapter.ts
    - src/source/gmail-adapter.ts
    - src/adapter/ingest-cli.ts
    - tests/schema.test.ts
    - tests/schema-v11-migration.test.ts
    - tests/schema-v12-migration.test.ts
    - tests/activation-sink.test.ts
    - tests/node-temporal-schema.test.ts
    - tests/node-scope-schema.test.ts
    - tests/surfaced-event-schema.test.ts
    - tests/gmail-adapter.test.ts
    - tests/gmail-adapter-multiaccount.test.ts
    - tests/gmail-hidden-content.test.ts

key-decisions:
  - "MIN_PLAUSIBLE_EVENT_MS = 631152000000 (1990-01-01T00:00:00Z) and MAX_FUTURE_SKEW_MS = 48 * 60 * 60 * 1000 (48 hours) — both module-scope constants in gmail-adapter.ts, next to parseEmailDate."
  - "nowMs reaches normalizeGmailMessage as an explicit fourth parameter (never Date.now() inside the pure function). GmailAdapter.pull() supplies it by reading Date.now() once, at its single impure call site — no Clock was injected into GmailAdapter's constructor; this mirrors the existing Date.now()-default-param pattern in calendar-adapter.ts's selectSyncEvents rather than introducing a new construction-surface dependency."
  - "idx_episode_event_ts (consolidated, event_ts) was KEPT, not dropped as speculative — plan 62-05 (which consumes this plan's event_ts) is expected to order unconsolidated episodes by event_ts in SQL, matching the existing idx_episode_unconsolidated/idx_episode_cwd hot-path index shape. The schema.ts comment flags it explicit as reconsiderable if 62-05 ends up doing the ordering in memory instead, per the plan's instruction not to leave a dead index silently (the file already documents two such removals from the v5 migration)."
  - "SCHEMA_VERSION bumped 15 → 16. All 13 hard-coded literal assertion sites (3 syntactic forms, 7 files) were updated to 16; the 9 dynamic assertions (compared against the SCHEMA_VERSION identifier or String(SCHEMA_VERSION)) were deliberately left untouched, as was the historical-migration string at tests/activation-sink.test.ts:78 ('...via v15 ALTER migration')."
  - "gmail-hidden-content.test.ts (created by plan 62-03, not in this plan's declared file list) also called normalizeGmailMessage directly at 10 sites and broke compilation once the nowMs parameter was added. Fixed as a Rule 3 blocking-issue auto-fix — added a NOW constant and threaded it through, matching the pattern used in gmail-adapter.test.ts / gmail-adapter-multiaccount.test.ts."

requirements-completed: [EMAIL-04]

# Metrics
duration: ~45min
completed: 2026-07-30
---

# Phase 62 Plan 04: Gmail event_ts — Source-Asserted Send Time, Attacker-Hostile Parse Summary

**Every Gmail episode now carries its own send time (`episode.event_ts`, epoch ms, nullable) parsed from the sender-controlled `Date:` header via `parseEmailDate` — a confident-or-null parse with a 48-hour future-skew security clamp that closes the one dangerous forgery direction (schedule stale evidence to apply last), while the additive `SCHEMA_VERSION` 16 migration and all 13 stale-assertion sites land in the same commit as the field's write path.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-07-30
- **Tasks:** 3 (all `type="auto"`, no checkpoints)
- **Files modified:** 14 (+2 new test files); +1 unplanned test file fixed as a Rule 3 deviation

## Accomplishments

- `episode.event_ts INTEGER` exists on fresh and migrated databases — nullable, no default, no backfill, no table rebuild — via the same `PRAGMA table_info` + guarded `ALTER TABLE ADD COLUMN` pattern already shipped three times before (`source`, `external_id`, `cwd`). `SCHEMA_VERSION` is now 16.
- The full field-name chain (`NormalizedRecord.event_ts` → `RecordEventParams.eventTs` → `AppendEventParams.event_ts` → `EpisodeRow.event_ts`) threads a source-asserted event time end-to-end without ever touching the EVAL-ONLY `ts` override or the `ts` column's clock-driven semantics.
- `parseEmailDate(header, nowMs)` is a pure, bounded, attacker-hostile parse: confident-or-null on every failure mode (empty, whitespace, `Date.parse` NaN, below-1990-floor, beyond-48h-future), with the future clamp closing the one exploitable ordering-manipulation direction plan 62-05 would otherwise expose — a forged far-future header cannot buy an episode a later position in chronological reordering, because a rejected header yields `null`, and `null` excludes the episode from that reordering altogether.
- The 13-site, 3-syntactic-form, 7-file stale-schema-version-assertion surface (the plan's own stated highest-risk item, three planning rounds in the making) is fully closed: the receiver-agnostic gate `grep -rnE "to(Be|Equal)\(['\"]?15['\"]?\)" tests/` returns zero matches, its mirror gate on `16` returns exactly 13, and the two dynamic-assertion files plus the one deliberate historical-migration string are provably untouched.

## Task Commits

Each task was committed atomically:

1. **Task 1: Additive episode.event_ts column, SCHEMA_VERSION 16, row type, and store write path** — `7126e7a` (feat)
2. **Task 2: Thread event_ts through the adapter contract, the pipeline, and the ingest CLI** — `971471c` (feat)
3. **Task 3: parseEmailDate with a plausibility window, and GmailAdapter emitting event_ts** — `fb9d9a0` (feat)

**Plan metadata:** (this SUMMARY commit, made by the orchestrator/executor immediately after this file)

## Files Created/Modified

- `src/db/schema.ts` — `SCHEMA_VERSION` 15→16; `event_ts INTEGER` added as the last DDL column with a `ts`-vs-`event_ts` distinguishing comment; guarded v16 migration reusing the existing `cols` Set from the `cwd` guard; `idx_episode_event_ts (consolidated, event_ts)` added with a speculative-index caveat comment for plan 62-05.
- `src/lib/types.ts` — `EpisodeRow.event_ts: number | null` with JSDoc distinguishing it from `ts`.
- `src/db/episode-store.ts` — `AppendEventParams.event_ts?: number | null` (JSDoc explicitly contrasts it against the adjacent EVAL-ONLY `ts` override — production MAY set `event_ts`, MUST NOT set `ts`); `stmtInsert` column/VALUES lists extended; `append` resolves `params.event_ts ?? null`.
- `src/ingest/pipeline.ts` — `RecordEventParams.eventTs?: number | null`; `recordEvent` passes `event_ts: e.eventTs ?? null` into `store.append`. The M-12 `redactSecrets` call and its comment are untouched (`git diff` on this file shows only the two additions).
- `src/source/source-adapter.ts` — `NormalizedRecord.event_ts?: number | null` placed after `origin`/before `role`; a numbered invariant-6 entry added to the interface doc block (derive from source data or set null, never guess; not a salience hint, not a dedup key); `MockSourceAdapter.pull()` gained a one-line passthrough comment, no code change.
- `src/adapter/ingest-cli.ts` — `runPullPhase`'s `pipeline.recordEvent({...})` call gained `eventTs: r.event_ts ?? null`.
- `src/source/gmail-adapter.ts` — `parseEmailDate` (exported, pure) with `MIN_PLAUSIBLE_EVENT_MS`/`MAX_FUTURE_SKEW_MS` module constants and full threat-reasoning JSDoc; `normalizeGmailMessage` gained an explicit `nowMs: number` fourth parameter and sets `event_ts: parseEmailDate(raw.headers.date, nowMs)`; `GmailAdapter.pull()` reads `Date.now()` once and passes it through its `messages.map` call; `RawGmailMessage.headers.date`'s obsolete comment replaced; file-level decision block gained an EMAIL-04 line.
- `tests/episode-event-ts.test.ts` (new) — store-layer coverage (append round-trip, `ts`/`event_ts` independence, dedup non-interference, fresh + legacy-DB migration), extended in Task 2 with pipeline-level (`recordEvent` with/without/null `eventTs`) and CLI-level (`runPullPhase` over a scripted `MockSourceAdapter`, raw-SQL-queried rows, full zero-behaviour-change column assertion for non-Gmail sources) coverage.
- `tests/gmail-event-ts.test.ts` (new) — `parseEmailDate` boundary cases (numeric/named-zone offsets, empty/whitespace/malformed, below-floor, beyond-skew, 24h-passes/72h-rejected pair, never-throws, purity), `normalizeGmailMessage` wiring (default-date success, empty→null, far-future→null-with-everything-else-unchanged, no-date-in-provenance), and an end-to-end `GmailAdapter.pull()` test over two messages a month apart.
- `tests/schema.test.ts`, `tests/schema-v11-migration.test.ts`, `tests/schema-v12-migration.test.ts`, `tests/activation-sink.test.ts`, `tests/node-temporal-schema.test.ts`, `tests/node-scope-schema.test.ts`, `tests/surfaced-event-schema.test.ts` — all 13 literal schema-version assertions (3 syntactic forms) bumped 15→16; stale descriptive strings corrected to name v16/`episode.event_ts`; `tests/activation-sink.test.ts:78`'s historical "v15 ALTER migration" string deliberately left unchanged.
- `tests/gmail-adapter.test.ts`, `tests/gmail-adapter-multiaccount.test.ts`, `tests/gmail-hidden-content.test.ts` — all direct `normalizeGmailMessage(...)` call sites updated to pass the new `nowMs` argument (a fixed `NOW` constant matching each file's fixture date).

## Decisions Made

See `key-decisions` in the frontmatter for the four load-bearing choices (constants, `nowMs` sourcing, index disposition, version-bump scope). One additional note: `gmail-hidden-content.test.ts` was not in this plan's declared `files_modified` list (it was created by plan 62-03) but calls `normalizeGmailMessage` directly at 10 sites; adding the `nowMs` parameter broke its compilation. This was fixed inline as a Rule 3 (auto-fix blocking issue) — the fix is a mechanical signature-update, not a scope change, following the exact pattern already used in the two gmail-adapter test files the plan did declare.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] `tests/gmail-hidden-content.test.ts` broke compilation after `normalizeGmailMessage`'s signature gained `nowMs`**
- **Found during:** Task 3, running `npx tsc --noEmit` after implementing `parseEmailDate` and updating `normalizeGmailMessage`'s signature
- **Issue:** `tests/gmail-hidden-content.test.ts` (created by plan 62-03, which predates this plan and is not in `62-04-PLAN.md`'s declared `files_modified`) calls `normalizeGmailMessage(makeRaw(), 'default', TEST_CONFIG)` at 10 call sites — all missing the new fourth `nowMs` argument, producing 10 `TS2554` errors.
- **Fix:** Added `const NOW = Date.UTC(2026, 5, 9)` (matching the file's fixture default date) and threaded it as the fourth argument at all 10 call sites, identical in shape to the fix already applied to the plan-declared `gmail-adapter.test.ts` / `gmail-adapter-multiaccount.test.ts`.
- **Files modified:** `tests/gmail-hidden-content.test.ts`
- **Verification:** `npx tsc --noEmit` exits 0; `npx vitest run tests/gmail-hidden-content.test.ts` — all 10 tests pass unchanged in behavior (only the call-site signature changed, no assertion changed).
- **Committed in:** `fb9d9a0` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking issue — Rule 3)
**Impact on plan:** Mechanical signature-update fix required by an interface change this plan itself made; no behavior change, no scope creep, no assertion rewritten.

## Issues Encountered

None beyond the deviation above.

## Verification Results

- `npx tsc --noEmit` — exits 0 (checked after every task).
- `npx vitest run tests/episode-event-ts.test.ts tests/gmail-event-ts.test.ts` — 28/28 pass.
- `npx vitest run tests/schema.test.ts tests/schema-v11-migration.test.ts tests/schema-v12-migration.test.ts tests/activation-sink.test.ts tests/node-temporal-schema.test.ts tests/node-scope-schema.test.ts tests/surfaced-event-schema.test.ts tests/store.test.ts tests/sink.test.ts` — 167 passed / 1 skipped (168), `SCHEMA_VERSION` asserted as 16 throughout.
- **Stale-assertion gate:** `grep -rnE "to(Be|Equal)\(['\"]?15['\"]?\)" tests/` — **zero matches** over all of `tests/`.
- **Mirror gate:** `grep -rnE "to(Be|Equal)\(['\"]?16['\"]?\)" tests/` — **exactly 13 matches across exactly 7 files** (`activation-sink.test.ts` ×2, `schema.test.ts` ×2, `schema-v11-migration.test.ts` ×3, `schema-v12-migration.test.ts` ×3, `surfaced-event-schema.test.ts` ×1, `node-temporal-schema.test.ts` ×1, `node-scope-schema.test.ts` ×1).
- **Dynamic assertions confirmed untouched:** `git diff tests/store.test.ts tests/sink.test.ts` — empty on both.
- **Historical string confirmed unchanged:** `tests/activation-sink.test.ts:78` still reads "...gains kind column via v15 ALTER migration".
- `grep -n "event_ts" src/db/schema.ts src/lib/types.ts src/db/episode-store.ts src/ingest/pipeline.ts src/source/source-adapter.ts src/source/gmail-adapter.ts src/adapter/ingest-cli.ts` — field present in all seven files.
- `grep -n "Date.now()" src/source/gmail-adapter.ts` — exactly one occurrence, inside `pull()`; zero occurrences inside `parseEmailDate` or `normalizeGmailMessage`.
- `git diff --stat package.json package-lock.json` — empty; net-zero new runtime dependencies.
- **Full suite, run serially (`npx vitest run --no-file-parallelism`):**
  - The first serial run (before running `npm run build`) showed **23 failed / 2817 passed / 9 skipped** — all 23 failures were subprocess-spawning CLI tests (`locomo-harness`, `locomo-latency-curve`, `locomo-scorer`, and similarly-shaped tests in `adapter-capture`/`adapter-inject`/`episodic-dryrun-gate`/`eval-harness-smoke`) failing with `Cannot find module '.../dist/src/db/schema'` — a missing-build artifact, not a code regression. Per this plan's instruction not to attribute failures to a baseline without verifying it, `npm run build` was run to produce `dist/`.
  - **Post-build, post-plan (this branch, all 3 tasks committed), run serially:** **0 failed / 2845 passed / 4 skipped (191 files, 190 passed / 1 skipped).** This matches the true 0-failure baseline the orchestrator stated. The skip count differs from the orchestrator's stated "3 skipped" by one; investigation showed all skips are legitimately conditional (`skipIf` gated on dataset presence — `LOCOMO10_EXISTS` — or a live-test env var — `RECENSE_RUN_LIVE_TESTS`), none reachable from this plan's changed files, and unrelated to `hasBuild`/`SKIP_NO_DIST` gates (those now run instead of skip, since `dist/` exists).
  - **Net result: zero test failures introduced by this plan.** `dist/` is `.gitignore`d — building it left no tracked changes in the worktree.

## Next Phase Readiness

- `episode.event_ts` and its full field-name chain are ready for plan 62-05 to consume for chronological reordering of unconsolidated episodes.
- `idx_episode_event_ts (consolidated, event_ts)` is in place, matching the shape plan 62-05 is expected to query against; flagged in `schema.ts` as reconsiderable (not silently dead) if 62-05's ordering ends up done in memory instead of in SQL.
- `parseEmailDate`'s semantics (confident-or-null, 48h future-skew clamp, 1990 floor) are the contract plan 62-05 should treat as load-bearing for its ordering logic — a null `event_ts` must stay excluded from reordering, never coerced to a sentinel or backfilled from `ts`.
- No blockers for plan 62-05.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*

## Self-Check: PASSED

- All 9 declared created/modified core files confirmed present on disk (`src/db/schema.ts`, `src/lib/types.ts`, `src/db/episode-store.ts`, `src/ingest/pipeline.ts`, `src/source/source-adapter.ts`, `src/source/gmail-adapter.ts`, `src/adapter/ingest-cli.ts`, `tests/episode-event-ts.test.ts`, `tests/gmail-event-ts.test.ts`).
- All 3 task commit hashes (`7126e7a`, `971471c`, `fb9d9a0`) confirmed present in `git log --oneline --all`.
