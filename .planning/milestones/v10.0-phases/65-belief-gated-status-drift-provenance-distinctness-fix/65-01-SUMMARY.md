---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 01
subsystem: testing
tags: [structural-guard, provenance, session-id, drift-03, regex, vitest, audit]

# Dependency graph
requires:
  - phase: 64-entity-resolution-hardening
    provides: resolved-entity fields on ClaimDecision (not consumed directly by this plan, but the phase-order gate)
provides:
  - "LOCKED D-02 verdict: PRIMARY shape (richer sessionId minted at ingest-cli.ts:188) selected for DRIFT-03's provenance-distinctness redesign"
  - "Per-consumer blast-radius table covering all 17 files / 48 hits from the live session_id/sessionId grep"
  - "Shipped structural test (findSessionIdContentBranches) locking the audit's central no-content-inspection claim"
affects: [65-04, 65-06, 65-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Structural guard shape: exported pure predicate + real src/ walk asserting [] + planted-offender non-vacuousness check through the SAME predicate (mirrors tests/no-ats-domain-table.test.ts and tests/src-import-boundary.test.ts)"
    - "Comment-stripping before regex matching for structural guards whose own doc comments name the forbidden patterns in prose"

key-files:
  created:
    - .planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/65-SESSION-ID-AUDIT.md
    - tests/session-id-provenance-consumers.test.ts
  modified: []

key-decisions:
  - "D-02 VERDICT: PRIMARY shape selected — mint a richer per-email sessionId at ingest-cli.ts:188 (ingest:gmail:<sender-domain>:<thread-id>); PendingContradiction, countDistinctProvenance, and the episode schema stay byte-unchanged"
  - "src/adapter/memory-ops.ts's dual mint/unrelated session_id use (per-engine-instance UUID, distinct from gmail-thread keying) does not count against the PRIMARY decision rule — orthogonal identifier space, zero coupling to ingest-cli.ts:188"

patterns-established:
  - "Structural lock for a research-gate claim: when an audit doc makes a factual claim about the codebase (e.g. 'no consumer inspects X'), ship a regex-based predicate test with a real-walk + planted-offender pair in the same commit, not just prose in the audit"

requirements-completed: [DRIFT-03]

# Metrics
duration: 35min
completed: 2026-08-03
---

# Phase 65 Plan 01: Session-ID Provenance Consumer Audit + Structural Lock Summary

**Audited all 17 files / 48 live `session_id`/`sessionId` call sites under `src/`, locked the D-02 PRIMARY shape (richer per-email sessionId minted at `ingest-cli.ts:188`) as the DRIFT-03 provenance-distinctness redesign's mechanism, and shipped a non-vacuous regex-based structural test that fails CI if any future `src/` code inspects a session id's string content.**

## Performance

- **Duration:** 35 min
- **Completed:** 2026-08-03
- **Tasks:** 2
- **Files modified:** 2 (both new files created; zero `src/` changes)

## Accomplishments

- Discharged the D-02 research gate that blocks Plan 65-07's provenance-key mint-site edit: every one of the 17 files matching the live `grep -rn "session_id\|sessionId" src --include="*.ts"` (48 hits) now has an explicit classification (mint / passthrough / value-semantic / unrelated) and a `no`/`yes` breakage verdict — no blanks, no "maybe".
- Locked exactly one grep-able verdict line: `**Shape selected:** PRIMARY (richer sessionId minted at ingest)`, satisfying the CONTEXT D-02 decision rule (zero extra `value-semantic` consumers beyond `countDistinctProvenance`; zero `passthrough` consumers found to parse/prefix-match/split/equality-compare session-id content).
- Shipped `tests/session-id-provenance-consumers.test.ts` — an exported `findSessionIdContentBranches(source, relPath)` predicate, a real walk over all 104 `src/**/*.ts` files asserting `[]`, five planted-offender non-vacuousness checks through the same predicate, a comment-stripping regression check, and a four-real-mint-line allowlist regression — all 11 tests green.
- Performed and recorded the required mutation check: planting `if (e.sessionId.startsWith('ingest:')) { /* planted */ }` in `src/ingest/pipeline.ts` made the real-walk test fail and correctly name `src/ingest/pipeline.ts:84` in the assertion diff; reverted, confirmed green again, confirmed `git diff --stat -- src/` shows zero net changes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Audit every session_id consumer and record the LOCKED D-02 verdict** - `152e83b` (docs)
2. **Task 2: Ship the structural lock that keeps the audit's central claim true** - `a7bcafb` (test)

_Note: Task 2 was flagged `tdd="true"` in the plan, but the "feature" here is a self-contained structural-guard file (predicate + its own tests in one file, matching the `no-ats-domain-table.test.ts` / `src-import-boundary.test.ts` precedent shape) — there is no separate `src/` implementation site to RED/GREEN split against. See "TDD Gate Compliance" below._

## Files Created/Modified

- `.planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/65-SESSION-ID-AUDIT.md` (121 lines) - Per-consumer blast-radius table (17 rows), cardinality/cost check, LOCKED `## VERDICT` (PRIMARY), three named accepted limitations (D-03 forward-only, sender-domain rotation, D-12 cross-run interleaving)
- `tests/session-id-provenance-consumers.test.ts` (213 lines) - Exported `findSessionIdContentBranches` predicate + three `describe` blocks (real walk, non-vacuousness, allowed-mint regression)

**Consumer-file count vs table-row count:** 17 files (live grep) = 17 table rows. Match confirmed.

**Files scanned by the structural guard's real walk:** 104 `src/**/*.ts` files (well above the >100 acceptance bar).

**Task 2 mutation-check result:** PASS — planted offender in `src/ingest/pipeline.ts:84` caused the real-walk assertion to fail with the exact offending line named in the diff (`src/ingest/pipeline.ts:84 — if (e.sessionId.startsWith('ingest:')) { /* planted */ }`); revert restored green (11/11 passing) with zero net `src/` diff.

## Decisions Made

- **D-02 VERDICT locked as PRIMARY**, not FALLBACK. The per-consumer table shows exactly one `value-semantic` row (`src/consolidation/update-decision.ts`'s `countDistinctProvenance`) and zero `passthrough` rows that inspect session-id content (`pipeline.ts`, `episode-store.ts`, `schema.ts`, `types.ts`, `semantic-store.ts`, `consolidator.ts` are all pure carriers). Both PRIMARY conditions from CONTEXT D-02 are satisfied, so Plan 65-07 should mint the richer key directly at `ingest-cli.ts:188` rather than adding a `provenance_key` field to `PendingContradiction`.
- `src/adapter/memory-ops.ts` required extra scrutiny: it mints a per-engine-instance UUID (`:304`) that CAN flow into `episode.session_id` for non-inferred MCP `add()` writes, and separately forwards that same UUID to the always-`inferred` `ask()`/responder path. Both sub-uses were judged unrelated to the D-02 gmail-thread redesign (orthogonal identifier space, zero coupling to `ingest-cli.ts:188`), documented in one combined table row rather than invented as a second file-row (the "one row per file" table rule).
- `src/recall/index.ts` and `src/responder/index.ts` both write `episode.session_id` but only ever with `origin: 'inferred'` — structurally excluded from `countDistinctProvenance` by the pre-existing D-19 origin filter — so they are classified `unrelated` despite technically touching the same DB column.

## Deviations from Plan

None - plan executed exactly as written. No `src/` file was permanently modified (the mutation check's temporary edit was reverted within Task 2, before the commit).

## TDD Gate Compliance

Task 2 (`tdd="true"`) does not have a separate RED-then-GREEN commit pair: the plan's own precedent shape (`tests/no-ats-domain-table.test.ts`, `tests/src-import-boundary.test.ts`) bundles the exported predicate and its tests in a single guard file, with no `src/` implementation site to split against. The task's actual TDD-equivalent discipline — proving the guard is non-vacuous by making it fail against a real planted offender, then reverting — was performed as the plan's own explicit "Mutation check" acceptance criterion and is recorded above, which serves the same "prove the RED case is real" purpose the RED/GREEN split exists for.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 65-07 (the gmail-adapter mint-site edit) can now proceed against a LOCKED decision: mint `ingest:gmail:<normalized-sender-domain>:<gmail-thread-id>` directly in `src/adapter/ingest-cli.ts:188`, with `src/lib/types.ts`, `src/consolidation/update-decision.ts`, and `src/db/schema.ts` staying untouched.
- The shipped structural test (`tests/session-id-provenance-consumers.test.ts`) will catch any future regression where a `src/` file starts inspecting session-id string content — this stays green and enforced regardless of which later Phase 65 plan lands the actual mint-site change.
- No blockers for Plan 65-04 (key derivation) or Plan 65-06 (adapter capture), which do not depend on this plan's artifacts directly but share the same locked D-02 mechanism context.

---
*Phase: 65-belief-gated-status-drift-provenance-distinctness-fix*
*Completed: 2026-08-03*

## Self-Check: PASSED

- FOUND: `.planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/65-SESSION-ID-AUDIT.md`
- FOUND: `tests/session-id-provenance-consumers.test.ts`
- FOUND commit: `152e83b`
- FOUND commit: `a7bcafb`
