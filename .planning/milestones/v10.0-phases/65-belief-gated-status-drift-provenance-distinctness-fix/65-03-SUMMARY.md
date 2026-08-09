---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 03
subsystem: config
tags: [typescript, configuration, dark-knobs, feature-flags, testing]

# Dependency graph
requires:
  - phase: 63-offline-intent-classification
    provides: IntentConfidence closed enum (high/medium/low) and INTENT_CONFIDENCES set
  - phase: 64-entity-resolution-hardening
    provides: dark-knob JSDoc convention precedent (entityResolutionFloor, bm25CandidateK)
provides:
  - Six inert Phase 65 configuration knobs on EngineConfig/DEFAULT_CONFIG (contradictionNBySource, provenanceDistinctnessEnabled, provenanceMinResidualChars, statusDriftEnabled, statusDriftConfidenceDamping, statusDriftEventTsGuard)
  - A stock-default test block proving every knob's default reproduces pre-Phase-65 behavior
  - The empirical low:0 → routeContradiction('hold') proof reusable by 65-05's drift layer implementation
affects: [65-04-provenance-key-derivation, 65-05-drift-layer, 65-07-mint-site, 65-08-per-source-threshold-lookup, 65-10-dry-run-harness]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dark-knob JSDoc convention (what it controls / calibration rationale / exact reversal value) extended from Phase 46/64 to six new Phase 65 fields"
    - "Per-source override shape (Record<string, number> falling back to a global) mirrored from consolSkipThresholdBySource onto contradictionNBySource"
    - "Lower-only clamp doctrine (D-09/D-43/B-04) stated in source for statusDriftConfidenceDamping ahead of its Plan 65-05 consumption-side enforcement"

key-files:
  created: []
  modified:
    - src/lib/config.ts
    - tests/runtime-config.test.ts

key-decisions:
  - "All six knobs default to values that reproduce pre-Phase-65 behavior exactly — provenanceDistinctnessEnabled defaults false (dark-launch), statusDriftEnabled defaults true (non-amplifying, safe to ship live)"
  - "statusDriftConfidenceDamping imports IntentConfidence from claim-extractor rather than restating the three-literal union, keeping the enum single-sourced"
  - "No knob was added for the provenance key's own composition (domain/address/hashing) — that stays a module-private literal in Plan 65-04 per the Phase 55-01 precedent"

patterns-established:
  - "Consumption-side clamping over validation-side rejection for confidence-derived multipliers — a malformed config degrades to safe behavior instead of throwing mid-sleep-pass"

requirements-completed: [DRIFT-02, DRIFT-03, DRIFT-04]

# Metrics
duration: ~20min
completed: 2026-08-03
---

# Phase 65 Plan 03: Phase 65 Dark Knobs Summary

**Six Phase 65 configuration knobs (provenance-distinctness dark switch, per-source contradiction-N override, residual-char floor, status-drift master switch, confidence-damping map, event_ts staleness guard) land on `EngineConfig`/`DEFAULT_CONFIG`, each proven to reproduce pre-Phase-65 behavior by a new stock-default test block.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-03T02:32:20Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `src/lib/config.ts` gained six fully-documented fields on `EngineConfig` and matching `DEFAULT_CONFIG` entries: `contradictionNBySource: {}`, `provenanceDistinctnessEnabled: false`, `provenanceMinResidualChars: 20`, `statusDriftEnabled: true`, `statusDriftConfidenceDamping: { high: 1, medium: 0.6, low: 0 }`, `statusDriftEventTsGuard: true`
- Every JSDoc block states an explicit "Reversibility" line naming the value that restores pre-Phase-65 behavior
- `tests/runtime-config.test.ts` gained a `describe('Phase 65 dark knobs — stock defaults reproduce pre-phase behavior', ...)` block with 6 cases, including an empirical proof (not a comment-only claim) that `routeContradiction(0, resistance, config)` always returns `'hold'` across three distinct resistance values (fresh-node, strong-node, zero)
- Confirmed zero consumers of `provenanceDistinctnessEnabled`/`statusDriftEnabled` exist outside `config.ts` — this plan ships strictly inert configuration, as scoped

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the six Phase 65 dark knobs to EngineConfig and DEFAULT_CONFIG** - `2bfc0b0` (feat)
2. **Task 2: Assert the Phase 65 stock defaults reproduce pre-phase behavior** - `ba5e550` (test)

**Plan metadata:** (this commit, following)

## Files Created/Modified
- `src/lib/config.ts` — six new `EngineConfig` fields + `DEFAULT_CONFIG` defaults, plus an `IntentConfidence` type-only import from `../model/claim-extractor`
- `tests/runtime-config.test.ts` — new imports (`DEFAULT_CONFIG`, `INTENT_CONFIDENCES`, `routeContradiction`) and a six-case Phase 65 stock-default `describe` block

## Decisions Made
- Placed the new test block in the existing `tests/runtime-config.test.ts` per the plan's explicit instruction, even though that file's pre-existing content is about DB-path/env resolution rather than `EngineConfig` defaults — the plan's `files_modified` and task action were unambiguous about not creating a new file, so semantic-fit was traded for following the explicit plan direction.
- `routeContradiction` requires a full `EngineConfig` (with `dbPath`), while `DEFAULT_CONFIG` is typed `Omit<EngineConfig, 'dbPath'>`; mirrored the existing `tests/update-decision.test.ts` convention of `{ ...DEFAULT_CONFIG, dbPath: ':memory:' }` rather than inventing a new pattern.

## Deviations from Plan

None - plan executed exactly as written. The `dbPath` spread was a mechanical typing accommodation, not a deviation from any specified behavior (Task 2's action text did not specify how to satisfy `routeContradiction`'s parameter type, and the existing test-suite convention was the obvious, lowest-risk choice).

## Mutation Check Results (Task 2 acceptance criteria)

Per the plan's required mutation check, both mutations were applied, verified, and reverted:

1. **`statusDriftConfidenceDamping.low` temporarily set to `0.5`:** re-ran `tests/runtime-config.test.ts` — all 26 cases still passed, including the `low:0` mechanism case. This confirms case 5 tests the `routeContradiction` **routing property** (magnitude 0 always routes to hold, independent of what `low` happens to be configured as) rather than reading the config's `low` value directly — exactly the "proven not asserted" property the plan required.
2. **`provenanceDistinctnessEnabled` temporarily set to `true`:** re-ran the same suite — case 1 (`provenance-distinctness stays dark...`) failed as expected (`expected true to be false`), all other 25 cases passed. This confirms the stock-default assertion is not vacuous.
3. Both mutations reverted; `git diff src/lib/config.ts` confirmed empty (byte-identical to the committed state) before re-running the full suite one final time — all 26 cases green.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All six knobs exist, default to pre-Phase-65 behavior, and are covered by regression tests — Plan 65-04 (key derivation), 65-05 (drift layer), 65-07 (mint site), and 65-08 (per-source threshold lookup) can now read these fields without contending for `src/lib/config.ts` in their own plans.
- `routeContradiction`'s `low:0 → 'hold'` proof in this plan's test suite is directly reusable evidence for Plan 65-05's drift-layer implementation and its own verification.
- No blockers.

## Self-Check: PASSED

- FOUND: src/lib/config.ts
- FOUND: tests/runtime-config.test.ts
- FOUND: .planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/65-03-SUMMARY.md
- FOUND: commit 2bfc0b0 (Task 1)
- FOUND: commit ba5e550 (Task 2)
- FOUND: commit 45e8833 (this SUMMARY)

---
*Phase: 65-belief-gated-status-drift-provenance-distinctness-fix*
*Completed: 2026-08-03*
