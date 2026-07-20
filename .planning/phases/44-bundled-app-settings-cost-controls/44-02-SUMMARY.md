---
phase: 44-bundled-app-settings-cost-controls
plan: 02
subsystem: config
tags: [settings, cost-controls, corpus-gen, schema-induction, wiring, typescript]

# Dependency graph
requires:
  - plan: 44-01
    provides: loadMergedConfig, EngineConfig.corpusGen/corpusGenMax/schemaInductionEnabled
provides:
  - run-sleep-pass.ts reads corpusGen/corpusGenMax from merged config (not raw env)
  - ingest-project-cli.ts reads corpusGen/corpusGenMax from merged config
  - consolidator.ts gates induceSchemas() on config.schemaInductionEnabled
affects:
  - 44-04 (config CLI — same loadMergedConfig path; gate already in place)
  - 44-05 (viz-server routes — reads merged config; schemaInductionEnabled visible)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "D-06: loadMergedConfig(dbPath, env) replaces DEFAULT_CONFIG spread at sleep-pass entry point"
    - "D-05 env-wins: config.corpusGen/corpusGenMax already embed env overrides via applyEnvOverrides in loadMergedConfig"
    - "D-11 gate: if (this.config.schemaInductionEnabled !== false) — default-on (undefined = run)"
    - "T-44-05 fail-OPEN: undefined schemaInductionEnabled still runs induction (old callers safe)"
    - "T-44-06 observability: log 'schema induction skipped' when gate fires"

key-files:
  created:
    - tests/settings-call-sites.test.ts
  modified:
    - src/consolidation/run-sleep-pass.ts
    - src/adapter/ingest-project-cli.ts
    - src/consolidation/consolidator.ts

key-decisions:
  - "loadMergedConfig already applies env overrides via applyEnvOverrides — no separate env-wins logic at call sites needed"
  - "ingest-project-cli dirtySentinelPath preserved as spread override over loadMergedConfig result"
  - "schemaInductionEnabled gate uses !== false (not === true) so undefined is treated as enabled (fail-OPEN, T-44-05)"
  - "Only induceSchemas + deriveSchemaRelations gated — corpus promotion, insight reflection, DocGraphDeriver are independent"

patterns-established:
  - "Settings-aware sleep pass: loadMergedConfig(dbPath, env) as first config line in runConsolidation"

requirements-completed: [D-06, D-11]

# Metrics
duration: 8min
completed: 2026-06-25
---

# Phase 44 Plan 02: Sleep-Pass Settings Wiring Summary

**Corpus-gen and schema-induction now driven by settings.json merged config (D-06/D-11); env still wins (D-05); Lite preset demonstrably skips both optional phases**

## Performance

- **Duration:** ~8 min
- **Completed:** 2026-06-25
- **Tasks:** 2
- **Files modified:** 3 + 1 new test file

## Accomplishments

- `run-sleep-pass.ts`: replaced `{ ...DEFAULT_CONFIG, dbPath }` with `loadMergedConfig(dbPath, env)` — settings.json now flows into the entire pass; the two `env['RECENSE_CORPUS_GEN*']` literal reads replaced with `config.corpusGen` and `config.corpusGenMax` (both already embed env overrides via `applyEnvOverrides`)
- `ingest-project-cli.ts`: identical replacement at lines 652/769/795; `dirtySentinelPath` preserved as a spread override
- `consolidator.ts`: `induceSchemas()` + `deriveSchemaRelations()` wrapped in `if (this.config.schemaInductionEnabled !== false) { ... }` with one-line skip log for observability (T-44-06); Lite preset (schemaInductionEnabled=false) exits the block; undefined falls through to run (T-44-05 fail-OPEN)
- 10 tests in `tests/settings-call-sites.test.ts`: 7 for D-05/D-06 env-wins precedence, 3 for D-11 gate (false/true/undefined)

## Task Commits

1. **Task 1:** `90e68c3` — `feat(44-02): route corpus-gen call sites through loadMergedConfig (D-06)`
2. **Task 2:** `43a2c71` — `feat(44-02): gate schema induction on config.schemaInductionEnabled (D-11)`

## Files Created/Modified

- `src/consolidation/run-sleep-pass.ts` — added `loadMergedConfig` import; replaced config construction and corpus-gen guards
- `src/adapter/ingest-project-cli.ts` — added `loadMergedConfig` import; replaced config construction and corpus-gen guards
- `src/consolidation/consolidator.ts` — wrapped `induceSchemas()` + `deriveSchemaRelations()` in schemaInductionEnabled gate
- `tests/settings-call-sites.test.ts` — NEW: 10 tests covering Task 1 (env-wins precedence) and Task 2 (gate)

## Decisions Made

- `loadMergedConfig` already handles env override application internally via `applyEnvOverrides`, so the call sites don't need explicit env-wins logic — just use `config.corpusGen` and `config.corpusGenMax` directly
- Used `!== false` (not `=== true`) for the schemaInductionEnabled gate so undefined behaves as enabled — old callers without the field keep existing behaviour (fail-OPEN, T-44-05)
- Only `induceSchemas` and `deriveSchemaRelations` are gated — `corpusPromoter.promote()`, `docGraphDeriver`, and `insightReflector` are independent of schema induction and are not gated (plan only said to gate the "optional schema layer")
- The standard preset fallback (when no settings file) gives corpusGen=false, schemaInductionEnabled=true — this is the correct behaviour and the tests document it

## Deviations from Plan

None — plan executed exactly as written. Both D-05/D-06 (env-wins corpus-gen routing) and D-11 (schemaInductionEnabled gate) implemented. All three threat mitigations verified:
- T-44-05: fail-OPEN gate (undefined = run)
- T-44-06: one-line log when schema induction skipped
- T-44-07: env still wins (founder's sleep.env/RECENSE_CORPUS_GEN workflow unbroken; tested)

## Known Stubs

None.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes introduced.
The gate exclusively controls which in-process LLM calls run during the offline sleep pass.

---
*Phase: 44-bundled-app-settings-cost-controls*
*Completed: 2026-06-25*
