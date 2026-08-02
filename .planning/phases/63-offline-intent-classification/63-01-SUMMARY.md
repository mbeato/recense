---
phase: 63-offline-intent-classification
plan: 01
subsystem: extraction
tags: [typescript, vitest, claim-extraction, json-schema, tdd]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening
    provides: EMAIL-03 hidden-content stripping (hard prerequisite for classifying gmail content)
provides:
  - IntentStatus (4-state closed enum) / IntentConfidence (3-level) vocabularies + ReadonlySet constants
  - toIntentStatus / toIntentConfidence drop-on-mismatch coercers (absence over guess, D-05)
  - intent_status / intent_entity / intent_confidence optional ExtractedClaim fields (all-or-nothing)
  - CLAIM_ARRAY_SCHEMA intent properties built from the shared enum constants
  - All-or-nothing intent parse gate inside parseClaimsFromArray
affects: [63-02 (prompt integration), 63-04 (consolidator threading), 63-05 (invariant guards + prompt/schema/parser parity test)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Drop-on-mismatch coercer (toIntentStatus/toIntentConfidence): returns the value only on closed-set membership, undefined otherwise — the deliberate inverse of toActionType's coerce-to-'other' contract, used when a wrong classification is worse than none (D-05)"
    - "All-or-nothing cross-field gate: compute each field independently, then collapse the whole group to undefined if any one is invalid/missing — distinct from TEMP-02's per-field-independent gate on the same function"

key-files:
  created: [tests/claim-extractor-intent.test.ts]
  modified: [src/model/claim-extractor.ts]

key-decisions:
  - "IntentStatus/IntentConfidence vocabularies and coercers placed directly beneath the existing ActionType block, mirroring its export/JSDoc conventions exactly, per the plan's read_first guidance"
  - "toIntentStatus/toIntentConfidence JSDoc explicitly calls out the D-05 inversion from toActionType so a future reader doesn't 'fix' it into symmetry"
  - "Intent gate implemented as new logic directly after the TEMP-02 gate in parseClaimsFromArray, not a refactor of the temporal gate's per-field shape (D-05 requires cross-field coupling, TEMP-02 does not)"

patterns-established:
  - "Vocabulary-as-ReadonlySet + coerce-function pairing for closed-enum optional annotation fields on ExtractedClaim (now the second instance after ActionType, making it a repeatable pattern for future annotation fields)"

requirements-completed: [CLASSIFY-01, CLASSIFY-04]

# Metrics
duration: ~15min
completed: 2026-08-02
---

# Phase 63 Plan 01: Intent Classification Data Contract Summary

**Added the four-state IntentStatus / three-level IntentConfidence closed vocabularies, drop-on-mismatch coercers, and an all-or-nothing parse gate to `claim-extractor.ts` — the shared data contract every other Phase 63 plan (prompt, consolidator, invariant guards) depends on.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-08-02T20:40:25Z
- **Completed:** 2026-08-02T20:43:07Z
- **Tasks:** 2 completed
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- `IntentStatus` (`applied | interviewing | rejected | offer`) and `IntentConfidence` (`high | medium | low`) closed vocabularies with `ReadonlySet` constants, exported alongside `ACTION_TYPES`-style conventions
- `toIntentStatus` / `toIntentConfidence` drop-on-mismatch coercers — the deliberate D-05 inversion of `toActionType`'s coerce-to-`'other'` contract, JSDoc'd to prevent future "symmetry fixes"
- Three optional fields (`intent_status`, `intent_entity`, `intent_confidence`) added to `ExtractedClaim`, and `CLAIM_ARRAY_SCHEMA` extended with matching properties whose enums are spread from the shared constants (schema/parser parity, load-bearing for 63-05)
- All-or-nothing intent parse gate in `parseClaimsFromArray`: any invalid/missing member of the trio collapses all three to `undefined`, while the claim itself always survives
- 39 new tests (`tests/claim-extractor-intent.test.ts`) proving unit coercion + every behavior-block case, run via full TDD RED→GREEN cycle; `tests/claim-extractor-temporal.test.ts` passes unmodified (18 tests, regression lock)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the intent vocabularies, coercers, ExtractedClaim fields, and JSON schema properties** - `4192bef` (feat)
2. **Task 2: All-or-nothing intent parse gate in parseClaimsFromArray** (TDD):
   - RED: `da4345a` (test) — 4/39 tests failing as expected before implementation
   - GREEN: `6f1746d` (feat) — all 57 tests pass (39 new + 18 unmodified temporal)

**Plan metadata:** committed separately after this SUMMARY (docs: complete plan)

## Files Created/Modified
- `src/model/claim-extractor.ts` - Intent vocabularies, coercers, `ExtractedClaim` fields, `CLAIM_ARRAY_SCHEMA` properties, and the all-or-nothing parse gate in `parseClaimsFromArray`
- `tests/claim-extractor-intent.test.ts` - Unit coverage of `toIntentStatus`/`toIntentConfidence` plus every `<behavior>` bullet from the plan (all-present, per-field out-of-enum, partial-classification rejection, backward-compat, temporal/intent independence, claim-survives-bad-classification), including two cases routed through `parseClaims` (the production fence-tolerant entry path)

## Decisions Made
- Followed the plan's explicit instruction to write the intent gate as NEW logic beside (not a refactor of) the TEMP-02 temporal gate, since the two gates have structurally different semantics (per-field-independent vs. all-or-nothing cross-field)
- Cited D-05 in both the coercer JSDoc and the collapse-guard comment (`grep -c "D-05"` = 8 occurrences) so the "absence over guess" rationale is discoverable at both the vocabulary and gate level

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria for both tasks verified directly (see Self-Check below).

## Issues Encountered

Two files referenced in `<files_to_read>` did not exist in this worktree: `.planning/phases/63-offline-intent-classification/63-PATTERNS.md` (plan referenced it but it was never generated for this phase) and root `CLAUDE.md` / `.planning/config.json` (not present as files in this repo — CLAUDE.md content was already available from the orchestrator's system-reminder context). Neither blocked execution: the plan's own `<interfaces>` section and the live `src/model/claim-extractor.ts` + `tests/claim-extractor-temporal.test.ts` files provided everything needed to mirror existing conventions.

23 pre-existing test failures were found in the full suite run (`tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`, `tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`, `tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`, `tests/locomo-scorer.test.ts`) — all CLI-spawn tests requiring a `dist/` build that does not exist in this fresh worktree. Confirmed unrelated to this plan's changes (verified the spawn target and absence of `dist/`); logged to `.planning/phases/63-offline-intent-classification/deferred-items.md` per the scope-boundary rule, not fixed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The data contract (`ExtractedClaim` intent fields, closed vocabularies, coercers, schema properties, parse gate) is complete and typecheck/test-clean. Plan 63-02 (prompt integration) can now emit into `intent_status`/`intent_entity`/`intent_confidence` via the gmail extraction prompt; Plan 63-04 (consolidator threading) can thread the fields through `ClaimDecision`; Plan 63-05's schema/parser parity test can rely on `INTENT_STATUSES`/`INTENT_CONFIDENCES` being the single source of truth for both `CLAIM_ARRAY_SCHEMA`'s enums and the parser's coercion logic. No blockers.

## Self-Check: PASSED

- FOUND: src/model/claim-extractor.ts
- FOUND: tests/claim-extractor-intent.test.ts
- FOUND: 4192bef (Task 1 commit)
- FOUND: da4345a (Task 2 RED commit)
- FOUND: 6f1746d (Task 2 GREEN commit)

---
*Phase: 63-offline-intent-classification*
*Completed: 2026-08-02*
