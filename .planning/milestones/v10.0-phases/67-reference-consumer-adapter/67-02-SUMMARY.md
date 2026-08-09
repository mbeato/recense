---
phase: 67-reference-consumer-adapter
plan: 02
subsystem: api
tags: [outcome-loop, idempotency, terminal-refusal, http-consumer, vitest, stub-server]

# Dependency graph
requires:
  - phase: 67-reference-consumer-adapter
    plan: "01"
    provides: "AdapterConfig/loadAdapterConfig, ProposalClient/createProposalClient/ActionProposalRecord/ProposalHttpError, LocalRow/findByProposalId/putLocalRow/listLocalRows/newLocalId"
provides:
  - "clients/proposal-reference/index.ts: syncProposals() list->map->approve/reject->refusal-terminal outcome loop (D-03)"
  - "decideOutcome() pure confidence-only decision policy, never reads evidence_quote"
  - "main() fail-closed CLI entry (sync|list) + require.main entry guard"
  - "9-case stub-server behavioral proof covering D-02/D-03/D-07"
affects: [67-03-docs-and-e2e]

# Tech tracking
tech-stack:
  added: []
  patterns: ["write-pending-before-POST crash-safety", "numeric-status-only refusal mapping (never the detail string)", "per-item try/catch with 401 rethrow-to-abort", "node:http stub server for in-dir behavioral proof"]

key-files:
  created:
    - clients/proposal-reference/index.ts
    - clients/proposal-reference/tests/sync-loop.test.ts

key-decisions:
  - "refusalReasonForStatus() maps the numeric HTTP status (400/404/409) to the closed refusalReason vocabulary locally in index.ts — the adapter never parses or branches on the server's `detail` string, only the status code and the (unused) `error` enum shape"
  - "row is hoisted to a `let row: LocalRow | undefined` above the per-item try so the catch block can update it on a 503/409-class refusal without re-deriving fields from the record"
  - "resolveLogPath() does its own string-slicing instead of importing node:path, keeping index.ts's import surface exactly as scoped by the plan (./config, ./proposal-client, ./local-store, node:fs)"
  - "Task 2 test fixtures use a loosely-typed `Fixture` (Record<string, unknown> & {id: string}) rather than the adapter's own ActionProposalRecord type, so the unknown-kind and quote-injection tests can construct wire payloads the adapter's real type would reject at compile time — mirrors how a real attacker-controlled server response arrives as untyped JSON"

requirements-completed: [CONSUME-01]

# Metrics
duration: 25min
completed: 2026-08-03
---

# Phase 67 Plan 02: List/Map/Approve-Reject Outcome Loop Summary

**Implemented and behaviorally proved the adapter's one genuinely new piece of logic — the idempotent, fail-closed, terminal-refusal outcome loop that IS the milestone's "context-layer proposes / system-of-record confirms" demo.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2
- **Files modified:** 2 (both created)

## Accomplishments
- `index.ts` exports `syncProposals`, `decideOutcome`, and `main`: a schema-gated, per-item try/catch loop that writes a local row BEFORE the HTTP call (crash-safe), branches on the numeric HTTP status only (401 aborts the whole sync, 503 defers, 400/404/409 write a terminal `refused` row), and never reads `evidence_quote`/`change_from` or the response `detail` string
- `decideOutcome` is a small pure function (confidence-only) so the demo's decision policy is one obvious, readable place a jobfill engineer can copy and replace
- `main()` dispatches `sync`/`list` against a fail-closed `loadAdapterConfig()` gate; `list` prints only the six closed-vocabulary/structured fields, never model prose
- `sync-loop.test.ts` proves all 9 `<behavior>` cases against a real `node:http` stub server on a free port: happy path, reject-but-applied, replay idempotency, 409-terminal (asserted on the stub's recorded call list, not just row status), 503-deferred-then-retried, schema-version stop (zero POSTs/zero rows even for well-versioned batch-mates), unknown-kind skip-just-that-record, 401 abort, and quote-is-data injection resistance (sentinel never appears in the persisted store file)

## Task Commits

Each task was committed atomically:

1. **Task 1: The list → map → approve/reject outcome loop** - `aab1394` (feat)
2. **Task 2: Stub-server behavioral proof of the loop** - `522e765` (test)

## Files Created/Modified
- `clients/proposal-reference/index.ts` - `syncProposals`/`decideOutcome`/`main` + `require.main` entry guard, 257 lines
- `clients/proposal-reference/tests/sync-loop.test.ts` - 9 behavioral test cases against a `node:http` stub, 303 lines

## Decisions Made
- No deviations from the plan's `<interfaces>`/`<naming_lock>` — all exports and the `SyncReport` shape (`{listed, applied, skipped, refused, deferred}`) match exactly.
- Both the unrecognised-kind skip and the "already non-pending" idempotent-replay skip increment the same `report.skipped` counter — the plan's `SyncReport` interface has no separate bucket for the two cases, and both are semantically "this record needed no action this pass."
- `resolveLogPath()` avoids a `node:path` import by doing its own `lastIndexOf('/')` slicing, honoring the plan's explicit "importing only from ./config, ./proposal-client, ./local-store, and node:fs" scope for `index.ts`.

## Deviations from Plan

None - plan executed exactly as written. All acceptance criteria greps/commands in both tasks passed on the first implementation attempt with no iteration needed.

## Issues Encountered

None.

## TDD Gate Compliance

Task 2 carries `tdd="true"` in the plan frontmatter, but per the plan's own task split, Task 1 (not tdd-tagged) already implemented `syncProposals`/`decideOutcome`/`main` in full — Task 2's sole job is the in-dir behavioral proof (`<files>` lists only the test file). There is consequently no separate RED-must-fail phase for Task 2: the 9 test cases were written against the already-implemented loop and passed on first run (`9 passed (9)`). This is not a gate violation — it reflects the plan's explicit design ("Behavioral proof lands in Task 2") rather than a new-behavior TDD cycle. No `feat`/`refactor` follow-up commit was needed after the `test` commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 67-03 can now write `docs/reference-client.md`'s proposal-consumer section and the repo-level e2e, driving `main()`/`syncProposals()` against a live `createBrainHttpServer` instance exactly as `<interfaces>` documents.
- No blockers. Full plan-level verification passed: `npx vitest run clients/proposal-reference/tests/` (18/18 passing across all three in-dir suites), `npx tsc --noEmit -p clients/proposal-reference/tsconfig.json` (clean), `grep -rn "from '.*\/src\/\|require(.*\/src\/" clients/proposal-reference/` (empty), `git diff --stat package-lock.json` (empty — net-zero new deps holds).

---
*Phase: 67-reference-consumer-adapter*
*Completed: 2026-08-03*

## Self-Check: PASSED

Both created source files + this SUMMARY.md verified present on disk. Both task commit hashes (aab1394, 522e765) verified present in `git log`.
