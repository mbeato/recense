---
phase: 67-reference-consumer-adapter
plan: 03
subsystem: testing
tags: [end-to-end-test, vitest, better-sqlite3, http, documentation, adopter-template]

# Dependency graph
requires:
  - phase: 67-reference-consumer-adapter
    plan: "01"
    provides: "clients/proposal-reference/ scaffold, config.ts, proposal-client.ts, local-store.ts"
  - phase: 67-reference-consumer-adapter
    plan: "02"
    provides: "clients/proposal-reference/index.ts syncProposals()/decideOutcome()/main() outcome loop"
provides:
  - "tests/proposal-reference-e2e.test.ts: repo-level proof driving the adapter's own syncProposals() against a real createBrainHttpServer + real ActionProposalStore seed, incl. the full D-03 409 refusal round-trip"
  - "docs/reference-client.md ## Proposal reference client section + API contract proposal endpoints — the CONSUME-03 third-party-buildable contract doc"
affects: [jobfill-live-integration, 68-telegram-hitl-belief-kind]

# Tech tracking
tech-stack:
  added: []
  patterns: ["repo-level e2e as the only legal place to import both the engine and a boundary-guarded client (D-05)"]

key-files:
  created:
    - tests/proposal-reference-e2e.test.ts
  modified:
    - docs/reference-client.md

key-decisions:
  - "The refusal round-trip test asserts the engine durably settles a stale-belief refusal to action_proposal.status='superseded' (not 'pending') at approve time — corrected from the plan's literal wording per src/db/action-proposal-store.ts's ProposalStaleError doc comment and the sibling tests/proposal-routes.test.ts EMIT-07 matrix; documented below as a Rule 1 deviation"
  - "Docs section placement: new '## Proposal reference client' section inserted immediately after '## Telegram reference client' (before '## API contract'); the proposal endpoints were added to the existing '## API contract' section after POST /v1/search; the D-07 fail-closed bullets were added as a new 'Proposal consumer rules' sub-block inside the existing '## Fail-closed pattern' section"
  - "Test harness reused tests/proposal-routes.test.ts's server-spin/seed/teardown pattern nearly verbatim, with per-test adapter store paths under os.tmpdir() unlinked in afterEach"

requirements-completed: [CONSUME-01, CONSUME-02, CONSUME-03]

# Metrics
duration: 35min
completed: 2026-08-03
---

# Phase 67 Plan 03: Repo-Level E2E Proof + Third-Party Docs Summary

**Closed Phase 67 with a repo-level end-to-end test driving the adapter's real `syncProposals()` against a live `createBrainHttpServer` instance (including a full 409 refusal round-trip) and a `docs/reference-client.md` proposal-consumer section documenting the full 16-field contract for a third-party builder.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- `tests/proposal-reference-e2e.test.ts` proves CONSUME-01/CONSUME-02 end-to-end: it seeds real `action_proposal` rows through `ActionProposalStore`/`SemanticStore`, serves them over a real `createBrainHttpServer`, and drives the adapter's own `syncProposals()` (never raw HTTP, never a reimplemented loop) — 6 tests covering the happy path, the D-03 refusal round-trip, D-02 replay safety, the reject path, the D-01 auth gate, and the LLM-free online-path invariant
- `docs/reference-client.md` gained a full `## Proposal reference client` section (directory layout, env vars, how-it-works flow) mirroring the Telegram section's structure, plus `GET /v1/proposals` and `POST /v1/proposals/:id/approve|reject` documentation in `## API contract` with the complete 16-field record, the full refusal/error table, and both mandatory carry-forwards (node ids are not stable FKs; `change_from`/`change_to` asymmetry)
- The fail-closed consumer posture (unknown `schema_version` → stop, unknown `kind` → skip, refusal → terminal, quote is data) is documented in the existing `## Fail-closed pattern` section's imperative-bullet voice

## Task Commits

Each task was committed atomically:

1. **Task 1: Repo-level end-to-end proof, including the refusal round-trip** - `eaa03ef` (test)
2. **Task 2: Document the proposal contract for third-party consumers** - `99dd361` (docs)

## Files Created/Modified
- `tests/proposal-reference-e2e.test.ts` - 339-line repo-level e2e; imports engine modules (`initSchema`, `SemanticStore`, `ActionProposalStore`, `createBrainHttpServer`) to seed/serve, and the adapter's public entry (`syncProposals`, `listLocalRows`, `findByProposalId`) to drive it
- `docs/reference-client.md` - new `## Proposal reference client` section, new API-contract endpoints for `/v1/proposals`, and a new "Proposal consumer rules" sub-block in `## Fail-closed pattern`

## Decisions Made
- Kept `syncProposals`/`listLocalRows`/`findByProposalId` as the only adapter-side calls in every main assertion — no test bypasses the loop with a direct `client.approve`/`.reject` call, preserving the CONSUME-01 proof's validity.
- Placed the new docs section right after the Telegram section (planner discretion per 67-CONTEXT D-06) rather than at the end of the file, keeping the two reference-client write-ups adjacent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug/incorrect plan assumption] Refusal round-trip DB assertion corrected to match live code behavior**
- **Found during:** Task 1 (writing the refusal round-trip test)
- **Issue:** The plan's `<behavior>` and `<acceptance_criteria>` text asserts that after a tombstoned-belief approve attempt, "the `action_proposal` row is still `pending`". Live code (`src/db/action-proposal-store.ts`'s `ProposalStaleError` doc comment: "The terminal status is written to the store BEFORE this throws") and the existing sibling test (`tests/proposal-routes.test.ts`'s EMIT-07 matrix: `expect(getProposalStatus(...)).toBe('superseded')`) both show the row is durably transitioned to `'superseded'`, not left `'pending'`. Per this project's CLAUDE.md rule ("Planning docs are not source of truth... When planning docs disagree with live code, live code wins"), the plan's assumption was wrong.
- **Fix:** The test asserts `getProposalStatus(seed.proposalId)` is `'superseded'` after the refusal, with an inline comment explaining the deviation and citing the source. This is a stronger proof of "terminal, never retried" than the plan's literal wording — the proposal is durably settled and therefore never re-listed by `GET /v1/proposals`, which is why the second `syncProposals()` call lists nothing and re-approves nothing.
- **Files modified:** tests/proposal-reference-e2e.test.ts
- **Verification:** `npx vitest run tests/proposal-reference-e2e.test.ts` — all 6 tests pass, including the refusal round-trip
- **Committed in:** eaa03ef (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug/incorrect-plan-assumption)
**Impact on plan:** The fix corrects a factually wrong assertion the plan specified; the must-haves' actual intent (a proven 409 refusal round-trip that is terminal and never retried) is fully satisfied — more strongly than the plan's literal wording would have been, had it been implemented as written (which would have failed against the real server).

## Issues Encountered

None beyond the deviation documented above. All other acceptance-criteria greps/commands (field-name coverage, refusal-literal coverage, carry-forward coverage, layout-block-matches-disk, no-deletions) passed on the first pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 67 (Reference Consumer Adapter) is complete: CONSUME-01/02/03 are all proven — the adapter maps served proposals onto its own local rows end-to-end through its public entry, the boundary guard holds (`clients/proposal-reference/tests/import-boundary.test.ts` passes, zero `src/` imports), and `docs/reference-client.md` documents the full contract for a third-party builder (jobfill, later, its own repo).
- Full-suite verification passed: `npm test` — 230 test files, 3838 passed / 6 expected-fail / 4 skipped, no regressions against the pre-plan baseline. `npx tsc --noEmit -p tsconfig.json` and `-p tests/tsconfig.json` both clean. `grep -rn "from '.*\/src\/\|require(.*\/src\/" clients/proposal-reference/` empty. `git diff --stat package-lock.json` empty (net-zero new deps holds).
- No blockers for Phase 68 (Telegram HITL Belief-Kind Extension) — zero file overlap (68 touches `clients/telegram/`, this phase touched `clients/proposal-reference/` + `tests/` + `docs/`).

---
*Phase: 67-reference-consumer-adapter*
*Completed: 2026-08-03*

## Self-Check: PASSED

Both `tests/proposal-reference-e2e.test.ts` and this SUMMARY.md verified present on disk. Both task commit hashes (eaa03ef, 99dd361) verified present in `git log`.
