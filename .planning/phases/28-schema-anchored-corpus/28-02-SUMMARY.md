---
phase: 28-schema-anchored-corpus
plan: "02"
subsystem: reader
tags: [doc-gather, doc-generator, schema-anchored, corpus, tdd, vitest]

# Dependency graph
requires:
  - phase: 28-01
    provides: v12 migration (doc_containment/doc_reference DDL) + Wave-0 test scaffolds with describe.skip stubs

provides:
  - gatherFactsForSchema(deps, params, opts) — D-09 schema-anchored gather with three sources
  - GatherSchemaParams interface — schemaId, centroid (Float32Array|null), schemaLabel
  - buildSchemaDocPrompt(schemaLabel, factBlock, siblings) — thesis-framing prompt builder
  - generateDocForSchema(deps, params, opts) — schema-anchored end-to-end generate path
  - Shared verifyCitations() internal helper — FACT_REF loop factored, not duplicated

affects: [28-03, 28-04, corpus-promoter, promote-corpus-cli, sleep-pass-phase-c]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Schema gather: evidence spine via kind='abstracts' + centroid-seeded semantic (null centroid = skip embed, no throw) + entity-hop re-rooted at abstracted entities"
    - "Citation-verify loop factored into internal verifyCitations() helper shared by scope and schema generation paths"
    - "TDD RED/GREEN per-task: test stubs committed first, implementation follows"

key-files:
  created: []
  modified:
    - src/reader/doc-gather.ts
    - src/reader/doc-generator.ts
    - tests/doc-gather.test.ts
    - tests/doc-generator.test.ts

key-decisions:
  - "gatherFactsForSchema tags spine facts 'scope' (not 'evidence') — identical to gatherFacts so downstream via-handling is unchanged"
  - "null centroid = hard skip of semantic pass (no provider.embed call, no fallback) — D-09 design: the centroid is the faithful vector, caller must pre-compute it"
  - "verifyCitations() factored as an unexported internal helper — FACT_REF regex appears exactly once; schema path reuses it without duplication"
  - "generateDocForSchema uses gatherSiblingDocs(db, schemaId) to exclude the schema's own doc from the sibling list — consistent with scope path"
  - "buildSchemaDocPrompt frames schemaLabel as the THESIS with identical HARD RULES and RELATED DOCS block as buildDocPrompt"

requirements-completed: [CORPUS-01]

# Metrics
duration: 8min
completed: 2026-06-19
---

# Phase 28 Plan 02: Schema-Anchored Gather + Generator Summary

**gatherFactsForSchema (D-09 three-source schema gather with null-centroid skip) + buildSchemaDocPrompt/generateDocForSchema (thesis-framing schema generation path) sharing a factored citation-verify helper**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-06-19T16:37:00Z
- **Completed:** 2026-06-19T16:44:09Z
- **Tasks:** 2 (both TDD RED/GREEN)
- **Files modified:** 4

## Accomplishments

- `gatherFactsForSchema` implements three D-09 sources — abstracts-edge spine, centroid-seeded `hybridTopk` semantic (skipped entirely when centroid is null, no embed call), and 1-hop entity-hop re-rooted at schema's abstracted entities — unioned/deduped by id exactly like `gatherFacts`
- `buildSchemaDocPrompt` frames the schema's human label as the THESIS with the same HARD RULES citation requirement and RELATED DOCS block as `buildDocPrompt`
- `generateDocForSchema` is a complete schema-anchored generate path: calls `gatherFactsForSchema`, builds the thesis prompt, runs the shared `verifyCitations()` helper, throws on empty output, returns `GenerateDocResult`
- Refactored `generateDoc` to use the shared `verifyCitations()` helper — `const FACT_REF` defined exactly once, no duplication between scope and schema paths
- All 1722 tests green, tsc clean, dist rebuilt

## Task Commits

1. **Task 1 RED: gatherFactsForSchema tests** - `21fe3fe` (test)
2. **Task 1 GREEN: gatherFactsForSchema implementation** - `2fd1f43` (feat)
3. **Task 2 RED: schema-thesis generator tests** - `03394e6` (test)
4. **Task 2 GREEN: schema-thesis implementation** - `4d76a5a` (feat)

**Plan metadata:** (docs commit — this SUMMARY + STATE update)

## Files Created/Modified

- `/Users/vtx/brain-memory/src/reader/doc-gather.ts` — Added `GatherSchemaParams` interface + `gatherFactsForSchema()` function (three D-09 sources, union/dedup by id, read-only)
- `/Users/vtx/brain-memory/src/reader/doc-generator.ts` — Factored `verifyCitations()` helper; added `buildSchemaDocPrompt()`, `generateDocForSchema()`; refactored `generateDoc` to use shared helper
- `/Users/vtx/brain-memory/tests/doc-gather.test.ts` — Unskipped `describe.skip` block; fleshed out 8 real tests for `gatherFactsForSchema`
- `/Users/vtx/brain-memory/tests/doc-generator.test.ts` — Added `buildSchemaDocPrompt` (5 tests) + `generateDocForSchema` (5 tests) suites

## Test Suite Counts (full run)

- **1722 passing** | 3 skipped | 26 todo
- `tests/doc-gather.test.ts`: 18 passing (10 pre-existing + 8 new gatherFactsForSchema)
- `tests/doc-generator.test.ts`: 28 passing (17 pre-existing + 11 new schema-thesis)

## Decisions Made

- Tagged spine facts `'scope'` (not a new `'evidence'` tag) — identical to scope-gather so any downstream `via` filtering, display logic, or future corpus tests need no change
- Null centroid is a hard design choice (not a fallback): when the caller passes `centroid: null`, the semantic pass is skipped entirely. This enforces D-09's "no extra embed call" invariant — the centroid must be pre-computed by the caller (promoter/CLI)
- `verifyCitations()` unexported (internal helper) — the interface surface of `doc-generator.ts` is `buildDocPrompt`, `buildSchemaDocPrompt`, `generateDoc`, `generateDocForSchema`, and the type exports. The verify loop is an implementation detail

## Deviations from Plan

None — plan executed exactly as written. The one structural choice (factoring `verifyCitations` from `generateDoc` rather than having `generateDocForSchema` call a lower-level helper) is explicitly called out in the plan ("factor it so both paths share it").

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced by this plan. Both new functions are read-only (no DB writes). The T-28-PI and T-28-INV threat mitigations from the plan's threat model are in place:
- `buildSchemaDocPrompt` includes the verbatim "use ONLY provided facts; cite every claim" HARD RULES (T-28-PI)
- `verifyCitations()` drops any `recense://fact/<id>` with no live node from `citedFactIds` (T-28-INV)
- Both new functions are read-only — no strengthen/setEmbedding/upsertEdge on sources (T-28-SC)

## Next Phase Readiness

- Plan 28-03 (corpus promoter + CLI) can now call `gatherFactsForSchema` + `generateDocForSchema` directly — the gather and generate seams are in place
- The `GatherSchemaParams` interface is exported and ready for callers to construct (schemaId + pre-computed centroid from `SchemaRelationDeriver`)
- No blockers

---
*Phase: 28-schema-anchored-corpus*
*Completed: 2026-06-19*
