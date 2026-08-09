---
phase: 67-reference-consumer-adapter
plan: 01
subsystem: api
tags: [http-client, fetch, fail-closed-config, json-store, boundary-guard, vitest]

# Dependency graph
requires:
  - phase: 66-domain-neutral-proposal-emit-seam
    provides: "frozen v66 HTTP contract — GET /v1/proposals, POST /v1/proposals/:id/approve|reject, 16-field ActionProposalRecord with schema_version"
provides:
  - "clients/proposal-reference/ directory: structural sibling of clients/telegram/ with its own compile boundary"
  - "CONSUME-02 sibling import-boundary guard, wired into npm test via vitest.config.ts"
  - "Fail-closed AdapterConfig + loadAdapterConfig() reading RECENSE_SERVE_URL/TOKEN/REFERENCE_STORE_PATH"
  - "createProposalClient() HTTP consumer (listProposals/approve/reject) against the frozen v66 routes, raw-status ProposalHttpError"
  - "Adapter-owned LocalRow local store keyed on recense proposalId for replay-safety"
affects: [67-02-mapping-loop, 67-03-docs-and-e2e]

# Tech tracking
tech-stack:
  added: []
  patterns: ["zero-import HTTP client module (Node global fetch only)", "atomic tmp->rename 0600 JSON store", "fail-closed config gate on presence of a bearer token"]

key-files:
  created:
    - clients/proposal-reference/tsconfig.json
    - clients/proposal-reference/tests/import-boundary.test.ts
    - clients/proposal-reference/config.ts
    - clients/proposal-reference/proposal-client.ts
    - clients/proposal-reference/local-store.ts
    - clients/proposal-reference/tests/local-store.test.ts
  modified:
    - vitest.config.ts
    - package.json

key-decisions:
  - "tsconfig.json is a byte-identical copy of clients/telegram/tsconfig.json (verified via md5) — no paths/references into src/"
  - "proposal-client.ts has zero imports (Node global fetch only), mirroring clients/telegram/memory-client.ts; the 16-field ActionProposalRecord and its enums are redeclared by hand per CONSUME-02"
  - "ProposalHttpError carries a machine-readable status: number so 67-02's caller can branch on the numeric HTTP status without this module interpreting or branching on the detail string itself"
  - "LocalRow deliberately excludes evidence_quote/change_from (T-67-02, quote is data) and entity_node_id/belief_node_id (64's D-08 non-stable-FK caveat) — only closed-vocabulary/structured fields persist"
  - "local-store.ts follows TDD: RED test committed first (8 behavior cases from the plan), then GREEN implementation — both passed on first attempt, no refactor commit needed"

requirements-completed: [CONSUME-01, CONSUME-02]

# Metrics
duration: 20min
completed: 2026-08-03
---

# Phase 67 Plan 01: Reference Consumer Adapter Scaffold Summary

**Stood up `clients/proposal-reference/` as a paths-free structural sibling of `clients/telegram/` with its own CONSUME-02 boundary guard, a fail-closed HTTP config/client pair against the frozen v66 proposal contract, and a replay-safe adapter-owned local row store.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 3
- **Files modified:** 8 (6 created, 2 modified)

## Accomplishments
- `clients/proposal-reference/tsconfig.json` is byte-identical to `clients/telegram/tsconfig.json` (no `paths`/`references` into `src/`); `npm test` now discovers and runs the adapter's own import-boundary guard via the extended `vitest.config.ts` include glob
- `config.ts` + `proposal-client.ts` give the adapter a fail-closed, zero-engine-dependency HTTP consumer for `GET /v1/proposals` and `POST /v1/proposals/:id/approve|reject`, surfacing raw numeric HTTP statuses via `ProposalHttpError` without interpreting `detail` strings
- `local-store.ts` gives the adapter its own durable local row vocabulary keyed on the recense proposal id, with atomic 0600 writes and a read path that cannot throw — built TDD (RED test, then GREEN implementation)

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold compile boundary + CONSUME-02 guard + CI wiring** - `0c5eeb3` (feat)
2. **Task 2: Fail-closed adapter config and HTTP proposal client** - `1cb67cc` (feat)
3. **Task 3: Adapter-owned local row store** - `4abbd80` (test, RED) → `abbe36c` (feat, GREEN)

## Files Created/Modified
- `clients/proposal-reference/tsconfig.json` - paths-free compile boundary, byte-identical to telegram's
- `clients/proposal-reference/tests/import-boundary.test.ts` - CONSUME-02 sibling copy of the telegram guard, scans the whole adapter tree incl. its own tests/
- `clients/proposal-reference/config.ts` - `AdapterConfig` + `loadAdapterConfig()`, fail-closed `enabled` gate on `RECENSE_SERVE_TOKEN`
- `clients/proposal-reference/proposal-client.ts` - `createProposalClient()`, locally-declared `ActionProposalRecord`/`ProposalKind`/`ProposalStatus`, `ProposalHttpError`
- `clients/proposal-reference/local-store.ts` - `LocalRow`, `LocalStatus`, `findByProposalId`, `putLocalRow`, `listLocalRows`, `newLocalId`
- `clients/proposal-reference/tests/local-store.test.ts` - 8 behavior-driven test cases
- `vitest.config.ts` - added `clients/proposal-reference/tests/**/*.test.ts` to `test.include`
- `package.json` - added `build:proposal-reference` script mirroring the `build:client` precedent

## Decisions Made
- No deviations from the naming lock or interfaces block — all exports match the plan's `<naming_lock>` and `<interfaces>` sections exactly.
- TDD Task 3 needed no refactor pass: the GREEN implementation passed all 8 behavior cases on the first write.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. All acceptance criteria in the plan's three tasks verified directly via the exact `grep`/`diff`/`tsc`/`vitest` commands specified in each task's `<acceptance_criteria>` block.

## TDD Gate Compliance

Task 3 (`tdd="true"`) followed the RED → GREEN sequence correctly:
- RED: `4abbd80 test(67-01): add failing test for adapter local row store` — confirmed failing (module not found) before any implementation existed
- GREEN: `abbe36c feat(67-01): implement adapter-owned local row store` — all 8 tests passed on first implementation attempt
- REFACTOR: not needed; no commit made

## User Setup Required

None - no external service configuration required. `RECENSE_SERVE_TOKEN`/`RECENSE_SERVE_URL`/`RECENSE_REFERENCE_STORE_PATH` are consumed the same way telegram's client env vars are — deferred to whoever wires up the adapter's runtime env, out of this plan's scope.

## Next Phase Readiness

- 67-02 (mapping loop) can now import `AdapterConfig`/`loadAdapterConfig` from `config.ts`, `ProposalClient`/`createProposalClient`/`ActionProposalRecord` from `proposal-client.ts`, and `LocalRow`/`findByProposalId`/`putLocalRow`/`listLocalRows`/`newLocalId` from `local-store.ts` to build the list→map→approve/reject outcome loop (D-03).
- No blockers. Full plan-level verification passed: `npx vitest run clients/proposal-reference/tests/` (9/9 passing across both test files), `npx tsc --noEmit -p clients/proposal-reference/tsconfig.json` (clean), `git diff --stat package-lock.json` (empty — net-zero new deps holds), `grep -rn "from '.*\/src\/\|require(.*\/src\/" clients/proposal-reference/` (empty — zero engine imports).

---
*Phase: 67-reference-consumer-adapter*
*Completed: 2026-08-03*

## Self-Check: PASSED

All 6 created source files + this SUMMARY.md verified present on disk. All 4 task commit hashes (0c5eeb3, 1cb67cc, 4abbd80, abbe36c) verified present in `git log`.
