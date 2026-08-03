---
phase: 66-domain-neutral-proposal-emit-seam
plan: 03
subsystem: api
tags: [http, sqlite, better-sqlite3, action-proposal, self-confirmation-guard]

# Dependency graph
requires:
  - phase: 66-domain-neutral-proposal-emit-seam (66-01)
    provides: action_proposal table (SCHEMA_VERSION=17), ActionProposalStore, classifyProposalStaleness
provides:
  - "listProposals/approveProposal/rejectProposal ops on MemoryOps"
  - "ProposalNotFoundError/ProposalNotPendingError/ProposalStaleError typed errors"
  - "GET /v1/proposals + POST /v1/proposals/:id/approve|reject authenticated HTTP routes"
  - "tests/proposal-routes.test.ts — frozen response contract + refusal matrix + D-43-for-proposals proof"
affects: [67-reference-consumer-adapter, 68-telegram-hitl-belief-kind-extension, 66-05-verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "D-43-for-proposals: the only write reachable from approve/reject is ActionProposalStore.updateStatus (status + updated_at) — never node, never edge"
    - "Fast-fail-before-lock discipline for the approve path: getById -> pending check -> staleness classify, all as SELECT-only reads, before acquireLockWithRetry"
    - "EMIT-07 durable refusal: a non-'ok' staleness verdict writes the terminal status under lock BEFORE throwing, so re-delivery cannot resurrect a refused proposal (D-10)"

key-files:
  created:
    - tests/proposal-routes.test.ts
  modified:
    - src/adapter/memory-ops.ts
    - src/adapter/serve-cli.ts

key-decisions:
  - "approveProposal has two separate acquireLockWithRetry call sites (the stale-terminal-write branch and the normal-approve branch) rather than one shared lock scope spanning both — keeps each write's lock-hold time minimal and mirrors the mutual exclusivity of the two outcomes"
  - "rejectProposal deliberately has no staleness gate (D-08/EMIT-05): rejecting a stale proposal is harmless and refusing it would leave a dead row pending forever"
  - "POST /v1/proposals/:id/approve|reject drains the request body (to enforce the shared 64KB cap) but never parses it — these routes take no body"

patterns-established:
  - "New authenticated write routes land textually after the existing checkAuth gate with a one-line comment warning future readers not to add auth there — zero new auth code, T-12-03/04/05 inherited for free"

requirements-completed: [EMIT-03, EMIT-05, EMIT-07]

# Metrics
duration: 25min
completed: 2026-08-03
---

# Phase 66 Plan 03: Consumer-Facing Proposal HTTP Surface Summary

**GET /v1/proposals (lock-free list) + POST /v1/proposals/:id/approve|reject (per-call lock), with the EMIT-07 staleness refusal writing a durable terminal status before the 409, closing recense's second self-confirmation vector alongside D-43.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3
- **Files modified:** 3 (2 modified, 1 created)

## Accomplishments

- `listProposals`/`approveProposal`/`rejectProposal` added to `MemoryOps`, wired through a read-only-handle-backed `proposalReadStore` (mirrors the `surface()` D-95 discipline) and a `writeDb`-backed `proposalWriteStore`.
- Three typed errors (`ProposalNotFoundError`, `ProposalNotPendingError`, `ProposalStaleError`) let the route layer map failures to fixed-literal HTTP responses without string-parsing anything.
- `GET /v1/proposals` and `POST /v1/proposals/:id/approve|reject` land after the existing `checkAuth` gate in `serve-cli.ts` with zero new auth code — inherits T-12-03/04/05 verbatim.
- The proposal id is validated against `/^[0-9a-f]{64}$/` before any store call (T-66-02), keeping malformed path text out of the store layer entirely.
- `approveProposal` runs `classifyProposalStaleness` before taking the lock; a non-`ok` verdict writes the terminal status (`expired` or `superseded`) under lock and *then* throws, so a re-delivered approve on a refused proposal can never resurrect it (D-10).
- `tests/proposal-routes.test.ts` (14 tests, all passing) proves the full behavior contract against the real HTTP server: auth-before-parse, the frozen `ACTION_PROPOSAL_FIELDS` key set, both happy paths, the three-way EMIT-07 refusal matrix (each asserting both the response `detail` and the persisted terminal `status`), malformed/unknown id + unknown action handling, a byte-identical `node` table snapshot across one approve and one reject, and zero leakage of `evidence_quote`/`entity_descriptor`/`change_to` into any 4xx/5xx body.

## Task Commits

1. **Task 1: memory-ops proposal ops + typed error classes** - `e0f0a17` (feat)
2. **Task 2: GET /v1/proposals + POST /v1/proposals/:id/approve|reject routes** - `3801c03` (feat)
3. **Task 3: Route integration tests — auth, contract, happy paths, refusal matrix** - `25d1cca` (test)

## Files Created/Modified

- `src/adapter/memory-ops.ts` - Three proposal ops + three typed errors; `proposalReadStore`/`proposalWriteStore` wiring; the only write path is `ActionProposalStore.updateStatus`.
- `src/adapter/serve-cli.ts` - Two new authenticated routes after the existing auth gate; header security-invariant block gains the T-66-02 line.
- `tests/proposal-routes.test.ts` - 14-case integration suite against the real HTTP server with a fail-if-called `ModelProvider`.

## Decisions Made

- Reworded two JSDoc comments in `memory-ops.ts` to avoid the literal string `updateStatus`, keeping the acceptance-criteria grep (`grep -c 'updateStatus'` == 3, one per actual call site) exact rather than inflated by prose mentions. No behavior change — pure comment wording.
- Used `crypto.createHash('sha256')` to mint deterministic 64-hex test fixture ids rather than random UUIDs, so `/^[0-9a-f]{64}$/` validation is exercised with realistic-shaped ids without any collision risk across the 14 test cases (each keyed by an incrementing `seedCounter`).

## Deviations from Plan

None - plan executed exactly as written. The only in-flight adjustment was the comment wording noted above under Decisions Made, made to keep the plan's own acceptance-criteria greps exact — not a functional deviation.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The frozen HTTP contract (`GET /v1/proposals`, `POST /v1/proposals/:id/approve|reject`) is ready for Phase 67 (Reference Consumer Adapter) and Phase 68 (Telegram HITL belief-kind extension) to consume.
- 66-05 (verification) should extend `tests/online-llm-free-sentinel.test.ts` with a fourth dynamic describe block for `/v1/proposals`, per that file's own "PHASE 66 EXTENSION POINT" comment — this plan's `tests/proposal-routes.test.ts` already uses an equivalent fail-if-called provider inline as a cheaper stand-in, but the dedicated sentinel extension is explicitly deferred to 66-05 per the plan's read_first notes.
- Full suite: 3742 passed / 6 expected-fail / 4 skipped at close, with one pre-existing unrelated flaky failure (`tests/strip-hidden.test.ts` — a timing-threshold assertion on an unrelated WR-02 regression test, out of scope for this plan's files; passes cleanly when run in isolation).

---
*Phase: 66-domain-neutral-proposal-emit-seam*
*Completed: 2026-08-03*

## Self-Check: PASSED

All created/modified files confirmed present on disk; all three task commits (`e0f0a17`, `3801c03`, `25d1cca`) confirmed in git history.
