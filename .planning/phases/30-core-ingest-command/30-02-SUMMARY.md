---
phase: 30-core-ingest-command
plan: "02"
subsystem: ingest-project-command
tags: [ingest, survey, headless-client, scope-threading, tdd, cli]
dependency_graph:
  requires: [30-01]
  provides: [ingest-project-cli, recense-ingest-project-command]
  affects: [30-03]
tech_stack:
  added: []
  patterns: [tdd-red-green, standalone-cli, synthetic-cwd-scope-threading, deferred-consolidation]
key_files:
  created:
    - src/adapter/ingest-project-cli.ts
    - tests/ingest-project-cli.test.ts
  modified:
    - src/adapter/recense.ts
decisions:
  - key: scope-threaded-via-synthetic-cwd
    rationale: "resolveSurveyCwd synthesizes a home-rooted path /Users/<user>/<scope> when --scope is set; cwdToScope(syntheticCwd)===scope so stampNodeScopes derives the override scope with ZERO consolidation-engine changes — resolves RESEARCH Pitfall 3"
  - key: no-lock-on-default-path
    rationale: "Default path holds no write lock; config.dirtySentinelPath makes EpisodicStore.append touch the sentinel on each observed insert, the scheduled hourly pass consolidates (D-01 deferred handoff is free)"
  - key: live-brain-default-target
    rationale: "D-04: the live brain is the default DB target; the spike's live-refuse guard is NOT carried — this is the production command, not a throwaway spike"
  - key: openai-key-gated-on-consolidate
    rationale: "Seam 5: OPENAI_API_KEY pre-flight only under --consolidate; the default path does not embed and does not need it"
metrics:
  duration_minutes: 35
  completed_date: "2026-06-20T14:19:56Z"
  tasks_completed: 2
  files_changed: 3
---

# Phase 30 Plan 02: Core Ingest Command Summary

**One-liner:** `recense ingest-project <dir>` command — tool-enabled survey → scope-tagged observed episodes via synthetic cwd threading, retry-once-skip on refusal, --dry-run / --db / --scope / --desc / --consolidate flags, wired in recense.ts dispatcher.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 RED | Failing tests for ingest-project-cli pure surface | `728ad53` | tests/ingest-project-cli.test.ts |
| 1+2 GREEN | ingest-project-cli implementation + dispatcher | `f3318c2` | src/adapter/ingest-project-cli.ts, src/adapter/recense.ts |

Note: Task 1 (pure helpers) and Task 2 (survey loop + dispatcher) were implemented together in a single GREEN commit since they share the same file and the tests cover both.

## What Was Built

### `src/adapter/ingest-project-cli.ts` (new file, 456 lines)

Standalone CLI modeled on `import-memory-cli.ts`.

**Pure helpers (exported for unit tests):**
- **`parseIngestArgs(argv)`** — parses positional `<dir>` + `--dry-run`, `--consolidate`, `--db`, `--scope`, `--desc`
- **`resolveSurveyScope({dir, scope})`** — `--scope` wins; else `cwdToScope(dir)`
- **`resolveSurveyCwd({dir, scope})`** — when `--scope` set, synthesizes `/Users/<user>/<scope>` so `cwdToScope(cwd)===scope`; else returns `dir` unchanged
- **`deriveRepoDesc(dir, descOverride?)`** — reads first README heading, falls back to basename; `--desc` override wins
- **`resolveTargetDb(argv)`** — delegates to `resolveDbPath(argv)` WITH fallback-to-default (live brain default, D-04)
- **`checkOpenAiKeyIfConsolidate(consolidate, env)`** — throws if `consolidate=true` and `OPENAI_API_KEY` absent (Seam 5)
- **`runSurveyAndFeed({dir, scope, repoDesc, pipeline, surveyArea, dryRun})`** — injectable survey loop with refusal retry and dry-run support

**`main()` flow:**
1. Validate `<dir>` exists before any lock (WR-02)
2. `checkOpenAiKeyIfConsolidate` pre-flight (gated on `--consolidate`)
3. Resolve scope, repoDesc, dbPath — print all before any write (D-09)
4. Build `EngineConfig` with `dirtySentinelPath: resolveDirtySentinelPath()` (free deferred handoff)
5. Build `createClaudeHeadlessSurveyClient` transport per area
6. `runSurveyAndFeed` loop: survey 5 areas, retry-once-skip refusals, feed episodes
7. Default path: feed into DB, close, no lock held
8. `--consolidate` path: `acquireLock()`, feed, `runConsolidation()`, close+releaseLock in finally
9. Carry headless timeout bump (`RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS=600000` if unset)

### `src/adapter/recense.ts` (modified)

Added:
- `case 'ingest-project': spawnScript('ingest-project-cli.js', process.argv.slice(3)); break;`
- `ingest-project` added to the usage string Commands list
- grep count: 3 occurrences (case line + comment + usage string)

### `tests/ingest-project-cli.test.ts` (new file, 21 tests)

Covers all acceptance criteria:
- `parseIngestArgs` — flag parsing, defaults
- `resolveSurveyScope` — home-rooted derive, --scope override (Pitfall 3)
- `resolveSurveyCwd` — cwdToScope round-trip: `cwdToScope(resolveSurveyCwd({dir:'/tmp/checkout', scope:'my-clone'})) === 'my-clone'`
- `deriveRepoDesc` — README heading, basename fallback, --desc override
- `resolveTargetDb` — live brain default (D-04), --db override
- `runSurveyAndFeed` — `origin:'observed'`, never `'asserted_by_user'`; cwd-derived scope threading
- Refusal retry: architecture refused twice → 0 episodes + in `skippedAreas`; first-refuse-then-succeed → episode recorded
- `--dry-run`: `recordEvent` never called, per-area counts returned
- `checkOpenAiKeyIfConsolidate` — key required only when `consolidate=true`

## Verification

```
npx vitest run tests/ingest-project-cli.test.ts
# → Test Files  1 passed (1) | Tests  21 passed (21)

npx tsc --noEmit
# → (clean, no output)

grep -c "ingest-project" src/adapter/recense.ts
# → 3

git diff package.json
# → (empty — net-zero deps)

git diff --stat scripts/spike/survey-feeder.ts
# → (empty — spike untouched)
```

## Deviations from Plan

None — plan executed exactly as written.

One structural decision that was clarified during implementation: Task 1 and Task 2 were committed together in a single GREEN commit (`f3318c2`) since `main()` (Task 2) imports and calls the Task 1 helpers, making them a single coherent unit. The RED commit (`728ad53`) covered tests for both tasks, which is consistent with the plan's test-first approach.

## TDD Gate Compliance

| Phase | Commit | Type |
|-------|--------|------|
| RED | `728ad53` | `test(30-02)` |
| GREEN | `f3318c2` | `feat(30-02)` |

Both RED and GREEN gate commits present in correct order.

## Known Stubs

None. All exported helpers are fully implemented. No placeholders, no TODO-flagged paths.

## Threat Flags

None. All STRIDE mitigations from the plan's threat register are implemented and tested:

- **T-30-05 (Tampering / live-brain pollution):** `--dry-run` runs survey, prints counts, writes 0 rows — asserted in unit test
- **T-30-06 (Tampering / self-confirmation):** Every episode is `origin:'observed'` — asserted in unit test; `'asserted_by_user'` explicitly asserted absent
- **T-30-07 (Tampering / refusal ingestion):** `isRefusalOrToolFailure` gate + retry-once-then-skip — asserted in two unit tests
- **T-30-08 (DoS / write-lock contention):** Default path holds NO lock; `--consolidate` uses real global lock with fast-fail
- **T-30-09 (Information disclosure / scope mis-attribution):** `--scope` threaded via synthetic cwd; resolved scope printed before write
- **T-30-SC:** `package.json` unchanged (net-zero deps confirmed via `git diff`)

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/adapter/ingest-project-cli.ts | FOUND |
| src/adapter/recense.ts (case ingest-project) | FOUND |
| tests/ingest-project-cli.test.ts | FOUND |
| commit 728ad53 (test RED) | FOUND |
| commit f3318c2 (feat GREEN) | FOUND |
| grep -c ingest-project recense.ts ≥ 2 | 3 — PASS |
| npx tsc --noEmit clean | PASS |
| package.json unchanged | PASS |
| scripts/spike/survey-feeder.ts untouched | PASS |
