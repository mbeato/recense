---
phase: 66-domain-neutral-proposal-emit-seam
plan: 01
subsystem: database
tags: [sqlite, better-sqlite3, schema-migration, action-proposal, domain-neutral-seam]

# Dependency graph
requires:
  - phase: 64-entity-resolution-hardening
    provides: "claimResolvedEntityId/claimResolvedEntityDescriptor (D-07/D-08) — the entity fields this plan's record shape carries"
  - phase: 65-belief-gated-status-drift-provenance-distinctness-fix
    provides: "EMISSION_ELIGIBLE_EVENT_TYPES/isEmissionEligible (D-13 sentinel) — this plan's table exists for the sink that gates on it"
provides:
  - "action_proposal table at schema v17 with exactly the 16 frozen columns + three indexes"
  - "src/db/action-proposal-store.ts: ActionProposalStore, ActionProposalRecord, ACTION_PROPOSAL_FIELDS, classifyProposalStaleness, ProposalStatus, StalenessVerdict, ProposalKind, PROPOSAL_TTL_MS, PROPOSAL_LIST_LIMIT"
  - "tests/action-proposal-contract.test.ts: three-way EMIT-02 frozen-field lock, EMIT-04 replay-collapse proof, EMIT-07/D-10 staleness precedence table"
affects: ["66-02", "66-03", "66-04", "66-05", "67-reference-consumer-adapter", "68-telegram-hitl-belief-kind-extension"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Content-hash TEXT PRIMARY KEY + INSERT OR IGNORE as the sole idempotency mechanism (mirrors uq_episode_source_external)"
    - "Frozen-contract lock via three independent copies (literal test array, satisfies-map, live PRAGMA introspection) rather than a forbidden-vocabulary grep"
    - "Pure precedence classifier (no DB/I/O/clock) for refusal-reason determinism"

key-files:
  created:
    - src/db/action-proposal-store.ts
    - tests/action-proposal-contract.test.ts
  modified:
    - src/db/schema.ts
    - tests/activation-sink.test.ts
    - tests/episode-event-ts.test.ts
    - tests/node-scope-schema.test.ts
    - tests/node-temporal-schema.test.ts
    - tests/schema-v11-migration.test.ts
    - tests/schema-v12-migration.test.ts
    - tests/schema.test.ts
    - tests/surfaced-event-schema.test.ts

key-decisions:
  - "belief_node_id (D-02a amendment) is a 17th-beyond-D-02 column carrying the node applyDecision minted for change_to — required for EMIT-07's tombstone check, excluded from the D-07 id hash because it is newId()-random"
  - "change_field/change_from/change_to carry NO CHECK constraint — a CHECK'd enum would encode consumer vocabulary into recense's seam (Pitfall 10)"
  - "Module named action-proposal-store.ts (not proposal-store.ts) to avoid ambiguity with clients/telegram/proposal-store.ts, which Phase 68 edits"

requirements-completed: [EMIT-02, EMIT-04, EMIT-07]

# Metrics
duration: 20min
completed: 2026-08-03
---

# Phase 66 Plan 01: action_proposal Schema + Store + Frozen-Contract Test Summary

**Additive `action_proposal` table at schema v17 (16 frozen columns, no consumer-shaped CHECK constraints) plus the store module that owns every SQL statement touching it and a pure D-10 staleness classifier, locked by a three-way frozen-field test.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-03T02:05Z (approx.)
- **Completed:** 2026-08-03T02:20:42Z
- **Tasks:** 3
- **Files modified:** 11 (2 created, 9 modified — 1 target file + 8 pre-existing tests fixed for the SCHEMA_VERSION bump)

## Accomplishments
- `action_proposal` table shipped as schema v17: 16 frozen columns exactly matching the plan's `<interfaces>` contract, three indexes (`status+created_at`, `entity_node_id+status`, `status+expires_at`), and a v17 migration block following the v9/v14 brand-new-table precedent (`CREATE TABLE IF NOT EXISTS` + no ALTER needed).
- `ActionProposalStore` (`src/db/action-proposal-store.ts`) owns all five statements the table needs: `insert` (INSERT OR IGNORE — EMIT-04's replay mechanism), `listPending`, `getById`, `getStalenessInputs` (SELECT-only join to `node` twice for the D-10 check), `updateStatus` (the module's sole UPDATE — D-43-for-proposals).
- `classifyProposalStaleness` is a pure function implementing D-10's fixed precedence (`entity_gone > superseded > expired`), proven against all 8 boolean/expiry combinations plus the `expiresAt === nowMs` boundary.
- `tests/action-proposal-contract.test.ts` locks EMIT-02's frozen field set three independent ways (literal array, `satisfies` compile-time map, live `PRAGMA table_info` introspection) and proves the lock is non-vacuous by mutation-testing it (see Deviations/Issues below).

## Task Commits

1. **Task 1: action_proposal DDL + v17 migration + SCHEMA_VERSION bump** - `d1423b0` (feat)
2. **Task 2: ActionProposalStore + frozen record type + pure staleness classifier** - `f1116c0` (feat)
3. **Task 3: Frozen-contract test — DDL key set == TS key set, replay collapse, staleness table** - `663007d` (test)

**Deviation fix (Rule 1, discovered during plan-level full-suite verification):** `1ea184a` (fix)

## Files Created/Modified
- `src/db/schema.ts` - `action_proposal` DDL (16 columns, three indexes) + v17 migration block + `SCHEMA_VERSION = 17`; DDL comment on `entity_node_id`/`entity_descriptor` reworded post-hoc to avoid leaking Phase 64's literal camelCase field-name strings into `sqlite_master.sql`
- `src/db/action-proposal-store.ts` - `ActionProposalRecord`, `ACTION_PROPOSAL_FIELDS` (satisfies-locked), `ActionProposalStore`, `classifyProposalStaleness`, `ProposalStatus`/`StalenessVerdict`/`ProposalKind`, `PROPOSAL_TTL_MS`/`PROPOSAL_LIST_LIMIT`
- `tests/action-proposal-contract.test.ts` - three-way frozen-field lock, replay-collapse tests, 8-case staleness table, `listPending`/`updateStatus`/`getStalenessInputs` behavior tests (16 test cases total)
- `tests/activation-sink.test.ts`, `tests/episode-event-ts.test.ts`, `tests/node-scope-schema.test.ts`, `tests/node-temporal-schema.test.ts`, `tests/schema-v11-migration.test.ts`, `tests/schema-v12-migration.test.ts`, `tests/schema.test.ts`, `tests/surfaced-event-schema.test.ts` - updated 13 hardcoded `SCHEMA_VERSION === 16` assertions to 17 (each prior schema-bump phase updated the same assertions in its own commit; this continues that convention)

## Decisions Made
- Followed CONTEXT.md D-02/D-02a/D-03/D-07 exactly: 16 frozen columns including the D-02a amendment (`belief_node_id`), no CHECK on the three `change_*` columns, deterministic content-hash PK.
- Store module named `action-proposal-store.ts` (class `ActionProposalStore`) rather than the `proposal-store.ts` CONTEXT.md floated as a suggestion, per the plan's explicit instruction to avoid collision with `clients/telegram/proposal-store.ts`.
- `getStalenessInputs` converts SQLite's 0/1 tombstoned integers to real booleans at the store boundary so `classifyProposalStaleness` never touches SQLite's integer-boolean encoding.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] DDL comment leaked Phase 64's literal field-name identifiers into `sqlite_master.sql`**
- **Found during:** Task 3's plan-level full-suite verification (`<verification>` item 3: "Full suite still green").
- **Issue:** The `action_proposal` DDL's inline comments on `entity_node_id`/`entity_descriptor` cited `claimResolvedEntityId`/`claimResolvedEntityDescriptor` verbatim (as a provenance citation to Phase 64). SQLite persists CREATE TABLE comments in `sqlite_master.sql`, and `tests/resolution-conservation.test.ts` (a Phase 64 structural guard) asserts that text never contains those exact identifiers anywhere in `sqlite_master`.
- **Fix:** Reworded the two comments to preserve the Phase 64 D-07/D-08 citation without the literal camelCase strings (e.g. "Phase 64 D-07's entity node id field").
- **Files modified:** `src/db/schema.ts`
- **Verification:** `npx vitest run tests/resolution-conservation.test.ts` — 5/5 passed after the fix.
- **Committed in:** `1ea184a`

**2. [Rule 3 - Blocking issue] 13 pre-existing tests hardcoded `SCHEMA_VERSION === 16`**
- **Found during:** Task 3's full-suite run.
- **Issue:** Every prior schema-bump phase (v9 through v16) updated the same set of literal-version assertions across `tests/activation-sink.test.ts`, `tests/episode-event-ts.test.ts`, `tests/node-scope-schema.test.ts`, `tests/node-temporal-schema.test.ts`, `tests/schema-v11-migration.test.ts`, `tests/schema-v12-migration.test.ts`, `tests/schema.test.ts`, `tests/surfaced-event-schema.test.ts` in its own commit — bumping `SCHEMA_VERSION` to 17 without updating these is a direct, in-scope consequence of Task 1's required action, not a pre-existing unrelated failure.
- **Fix:** Updated all 13 assertions (and their describe/test titles where they named the literal version) from 16 → 17, following the exact convention already visible in the file (e.g. `schema v11 (now v16)` → `schema v11 (now v17)`).
- **Files modified:** the 8 test files listed above.
- **Verification:** `npx vitest run` full suite — 3729 passed / 6 expected fail / 4 skipped, zero failures.
- **Committed in:** `1ea184a`

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug, 1 Rule 3 blocking issue)
**Impact on plan:** Both fixes were direct, necessary consequences of Task 1's required `SCHEMA_VERSION` bump and DDL addition. No scope creep — no file was touched outside what the version bump and the pre-existing structural guard test required.

## Issues Encountered
None beyond the two auto-fixed deviations above.

**Non-vacuousness mutation test (Task 3 acceptance criterion):** Per the plan's explicit instruction, the frozen-contract lock was proven non-vacuous by temporarily adding a 17th column (`planted_offender TEXT`) to the `action_proposal` DDL, running `tests/action-proposal-contract.test.ts`, and reverting. Observed failure:
```
AssertionError: expected [ 'belief_node_id', …(16) ] to deeply equal [ 'belief_node_id', …(15) ]
- Expected
+ Received
@@ -10,9 +10,10 @@
    "evidence_episode",
    "evidence_quote",
    "expires_at",
    "id",
    "kind",
+   "planted_offender",
    "schema_version",
    "status",
    "updated_at",
  ]
 ❯ tests/action-proposal-contract.test.ts:137:21
```
After reverting the planted column, `git diff src/db/schema.ts` was empty (file returned to its Task 1-committed state byte-for-byte) and all 16 tests passed again.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
`action_proposal` (schema v17) and `ActionProposalStore` are ready for 66-02 (the `ActionProposalSink` + emission wiring inside `applyDecision`) and 66-03/66-04 (the `/v1/proposals` routes). `classifyProposalStaleness` is ready for 66-04's approve-time D-10 refusal check. No blockers.

---
*Phase: 66-domain-neutral-proposal-emit-seam*
*Completed: 2026-08-03*
