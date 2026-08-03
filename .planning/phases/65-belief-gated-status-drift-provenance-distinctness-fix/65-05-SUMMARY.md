---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 05
subsystem: consolidation
tags: [status-drift, pe-gating, event-ts, staleness-guard, confidence-damping, emission-eligibility, sqlite]

# Dependency graph
requires:
  - phase: 65-03
    provides: "statusDriftEnabled / statusDriftConfidenceDamping / statusDriftEventTsGuard config knobs on EngineConfig"
  - phase: 63
    provides: "IntentConfidence coarse categorical confidence enum from claim-extractor.ts"
  - phase: 64
    provides: "entity-resolution.ts module shape precedent (D-01 standalone-module, D-04 no-ModelProvider, D-12 read-only-contract)"
provides:
  - "StatusDrift class: standalone, read-only, LLM-free decision module (dampByConfidence + event_ts staleness guard)"
  - "EMISSION_ELIGIBLE_EVENT_TYPES / isEmissionEligible — D-13 seam Phase 66 must gate its proposal sink on"
  - "SUPPORTING_EVENT_TYPES — the evidence-for-this-node-value predicate, excluding contradict_hold"
affects: [65-08, 66]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Standalone consolidation-layer decision module mirroring entity-resolution.ts (D-01/D-04/D-12): no ModelProvider param, single prepared read-only SELECT, discriminated-union result type."
    - "Programmatic SQL IN-list generation from an exported Set (SUPPORTING_EVENT_TYPES) so the SQL and the set cannot drift apart."

key-files:
  created:
    - src/consolidation/status-drift.ts
    - tests/status-drift.test.ts
  modified: []

key-decisions:
  - "dampByConfidence clamps every factor to [0,1] at consumption (not config-load), so a malformed/extreme config (even 5) degrades to safe behavior instead of throwing or amplifying."
  - "The event_ts staleness guard returns 'drop', never 'hold', for stale backfilled contradictions — a held claim accumulates toward the provenance-distinctness counter and would eventually force-destabilize a newer correct belief (DRIFT-04 crux)."
  - "contradict_hold is excluded from SUPPORTING_EVENT_TYPES: a hold's episode is contradicting evidence against the candidate, not supporting evidence for it."
  - "contradict_hold and contradict_oscillation are permanently excluded from EMISSION_ELIGIBLE_EVENT_TYPES — a hold is 'not enough evidence yet' (research Pitfall 7) and an oscillation is genuine ambiguity, not a settled transition worth proposing."
  - "Equal claimEventTs/priorEventTs is treated as NOT stale (ties favor applying the update)."

patterns-established:
  - "Emission-eligibility exported as a Set + predicate function so downstream phases (66) gate on the predicate rather than re-deriving the rule."

requirements-completed: [DRIFT-01, DRIFT-02, DRIFT-04]

# Metrics
duration: ~35min
completed: 2026-08-03
---

# Phase 65 Plan 05: Belief-Gated Status Drift — Confidence Damping + Staleness Guard Summary

**Standalone, read-only StatusDrift module: lower-only confidence damping that routes low-confidence contradictions to `hold` through the unmodified `routeContradiction`, plus an `event_ts` staleness guard that drops (not holds) stale backfilled contradictions — with the D-13 emission-eligibility predicate Phase 66 will gate its proposal sink on.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-08-03
- **Tasks:** 2
- **Files modified:** 2 (both created)

## Accomplishments

- `src/consolidation/status-drift.ts` — `dampByConfidence` (D-09 lower-only clamp), `StatusDrift.evaluate` (D-11b event_ts staleness guard), and the D-13 emission-eligibility seam, all read-only and provider-free by construction.
- `tests/status-drift.test.ts` — 33 passing tests covering damping table cases, the real gate-to-hold composition against `routeContradiction`, staleness (drop/proceed/ties/unknown-ts/guard-off/MAX-semantics/contradict_hold-is-not-evidence), and five structural guarantees (master-switch, read-only ×2, no-LLM, no-lattice ×2, emission-eligibility ×3, SUPPORTING_EVENT_TYPES sanity).
- Three mutation checks performed live (clamp removal, drop→proceed, contradict_hold added to eligible set) — all correctly failed the suite, then reverted; file confirmed byte-identical to the committed version afterward.
- Zero changes to `routeContradiction`, `isOscillation`, `countDistinctProvenance`, the PE bands, or the schema — verified via `git diff --stat` returning empty for `update-decision.ts`, `schema.ts`, and `sink.ts`.
- No call site exists yet (`grep -rn "status-drift" src/` returns only a pre-existing Phase 65-03 doc comment in `config.ts`, no code reference) — wiring is Plan 65-08's job.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write status-drift.ts — damping, staleness guard, and the emission-eligibility predicate** - `b06c160` (feat)
2. **Task 2: Unit suite proving damping, staleness, and all five structural guarantees** - `f25667f` (test)

## Files Created/Modified

- `src/consolidation/status-drift.ts` - `StatusDrift` class, `dampByConfidence`, `SUPPORTING_EVENT_TYPES`, `EMISSION_ELIGIBLE_EVENT_TYPES`, `isEmissionEligible`, `DriftInput`/`DriftDecision` types. 250 lines.
- `tests/status-drift.test.ts` - 33-test unit suite against an in-memory SQLite DB, no ModelProvider anywhere. 456 lines.

## Verbatim Exported Shapes (per plan `<output>` instruction)

**`DriftDecision` union (final, as shipped):**
```ts
export type DriftDecision =
  | {
      action: 'proceed';
      magnitude: number;
      damped: boolean;
      staleness: 'ok' | 'unknown-claim-ts' | 'unknown-prior-ts' | 'guard-off' | 'not-applicable';
    }
  | { action: 'drop'; reason: 'stale-event'; priorEventTs: number; claimEventTs: number };
```

**`SUPPORTING_EVENT_TYPES` members:** `confirm`, `extend`, `contradict_reconcile`, `contradict_append_new`, `contradict_force_destabilize`, `contradict_oscillation` (excludes `contradict_hold`, `unrelated`, `schema_emitted`, `schema_falsified`, `entity_merge`, `fact_merge`).

**`EMISSION_ELIGIBLE_EVENT_TYPES` members:** `contradict_reconcile`, `contradict_append_new`, `contradict_force_destabilize` (size 3; permanently excludes `contradict_hold` and `contradict_oscillation`).

## Mutation-Check Results (Task 2 acceptance criteria)

All three performed live against the actual test run, then reverted (confirmed byte-identical to the committed file via `diff` after revert):

1. **Clamp removed** (`Math.min(1, Math.max(0, raw))` → `raw`): 4 tests failed — the three `it.each(['high','medium','low'])` amplification-clamp cases plus the negative-factor-floors-to-0 case (`-0.5` produced instead of `0`).
2. **Drop arm replaced with proceed/ok**: 2 tests failed — "drops a contradicting claim whose event_ts predates the newest supporting evidence" and "MAX semantics: three supporting rows... use the newest for comparison" (both expected `action: 'drop'`, got `action: 'proceed'`).
3. **`contradict_hold` added to `EMISSION_ELIGIBLE_EVENT_TYPES`**: 3 tests failed — the exhaustive-filter equality check, the explicit `contradict_hold` exclusion check, and the `size === 3` check (got size 4).

## Decisions Made

- Fail-open cast (`config.statusDriftConfidenceDamping as Record<IntentConfidence, number | undefined>`) inside `dampByConfidence` to allow a runtime-missing key or NaN without a TypeScript "no overlap" comparison error, while keeping the shipped `EngineConfig` type a full `Record`. This is a defensive runtime guard, not a claim that the config type is itself partial — documented inline.
- `snapshotDb` in the test file was written as a strengthened whole-database version (COUNT + full-row JSON per table) rather than reusing `tests/intent-conservation.test.ts`'s privileged-single-column variant, since `StatusDrift` touches `node`, `episode`, and `consolidation_event` and a single-column snapshot would miss mutations to non-privileged columns.

## Deviations from Plan

None — plan executed exactly as written. All exports, constructor signature, evaluation order, and test coverage match the plan's `<behavior>` and `<action>` blocks verbatim.

## Issues Encountered

None during implementation. One process note: the worktree's base commit initially lagged behind the expected wave-1 merge point (missing the Phase 65-03 config knobs this plan depends on) — corrected via the mandated `git reset --hard` to the documented base commit before writing any code, per the worktree branch-check protocol. No code-level issue.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `StatusDrift` is fully standalone and unit-tested but has zero call sites — Plan 65-08 wires it into the consolidator's contradict branch (both the primary block at `consolidator.ts:1324-1520` and the secondary mirror at `consolidator.ts:1543-1625`), positioned after the existing inferred/echo/hitl hard stop.
- `isEmissionEligible` / `EMISSION_ELIGIBLE_EVENT_TYPES` are ready for Phase 66's `ActionProposalSink` to gate on directly — no re-derivation needed.
- No blockers.

---
*Phase: 65-belief-gated-status-drift-provenance-distinctness-fix*
*Completed: 2026-08-03*

## Self-Check: PASSED

- FOUND: src/consolidation/status-drift.ts
- FOUND: tests/status-drift.test.ts
- FOUND: commit b06c160
- FOUND: commit f25667f
