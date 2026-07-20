---
phase: 44-bundled-app-settings-cost-controls
plan: 01
subsystem: config
tags: [settings, config, presets, cost-controls, typescript]

# Dependency graph
requires:
  - phase: core-engine
    provides: EngineConfig interface and DEFAULT_CONFIG in src/lib/config.ts
provides:
  - PresetName type and SettingsFile interface exported from src/lib/config.ts
  - PRESET_CONFIGS constant with lite/standard/full preset baselines
  - corpusGen/corpusGenMax/schemaInductionEnabled fields in EngineConfig + DEFAULT_CONFIG
  - src/adapter/settings-loader.ts with defaultSettingsPath, loadSettingsFile, writeSettingsFile, loadMergedConfig
affects:
  - 44-02 (run-sleep-pass env-read refactor — imports loadMergedConfig)
  - 44-04 (config CLI — imports writeSettingsFile + loadMergedConfig)
  - 44-05 (viz-server settings routes — imports loadMergedConfig + writeSettingsFile)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "settings-loader mirrors runtime-config.ts: existsSync guard + try/catch → null on failure"
    - "D-05 precedence: DEFAULT_CONFIG → preset baseline → sanitized overrides → env (later wins)"
    - "D-12 core guardrail: consolSkipThreshold/Assistant >= 1 or < 0 stripped before merge"
    - "chmod 0o600 applied by writeSettingsFile (mirrors sleep.env posture)"

key-files:
  created:
    - src/adapter/settings-loader.ts
    - tests/settings-loader.test.ts
  modified:
    - src/lib/config.ts

key-decisions:
  - "D-05: env > settings.json > preset > DEFAULT_CONFIG precedence (mirrors resolveDbPath shape)"
  - "D-11: preset + overrides model — SettingsFile stores preset name + explicit overrides map"
  - "D-12: core guardrail as loader sanitization — consolSkipThreshold outside (0,1) stripped silently"
  - "D-04: settings.json in ~/.config/recense/ alongside recense.db and sleep.env"
  - "Unknown preset falls back to 'standard' (T-44-04); missing/malformed file returns null (T-44-03)"
  - "sleepFrequencyHours is a SettingsFile-only field — NOT added to EngineConfig (D-07)"

patterns-established:
  - "loadSettingsFile: existsSync + JSON.parse in try/catch → null (never throws, T-44-03)"
  - "writeSettingsFile: writeFileSync + chmodSync 0o600 (T-44-02)"
  - "loadMergedConfig builds EngineConfig with spread merge then applyEnvOverrides() on top"

requirements-completed: [D-04, D-05, D-11, D-12]

# Metrics
duration: 5min
completed: 2026-06-24
---

# Phase 44 Plan 01: Settings Persistence Foundation Summary

**settings.json preset+overrides loader with D-05 precedence (env>file>preset>DEFAULT) and D-12 core guardrail (consolSkipThreshold clamped to (0,1))**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-06-24T23:39:00Z
- **Completed:** 2026-06-24T23:44:26Z
- **Tasks:** 2 (TDD: RED + GREEN per task)
- **Files modified:** 3

## Accomplishments
- Added `corpusGen`, `corpusGenMax`, `schemaInductionEnabled` to EngineConfig + DEFAULT_CONFIG with correct defaults (true/25/true)
- Exported `PresetName`, `SettingsFile`, `PRESET_CONFIGS` from config.ts — lite/standard/full preset baselines defined with only the optional cost-lever layer
- Created `src/adapter/settings-loader.ts` with four exports: defaultSettingsPath, loadSettingsFile, writeSettingsFile, loadMergedConfig
- 24 unit tests covering all six behavioral probes from the plan (D-05 precedence, D-12 guardrail, resilience, chmod-600)

## Task Commits

Each task was committed atomically:

1. **RED (Tasks 1 & 2):** `2767feb` — `test(44-01): add failing tests for settings-loader`
2. **Task 1 GREEN:** `ec11856` — `feat(44-01): add PresetName, SettingsFile, PRESET_CONFIGS + corpusGen fields to config.ts`
3. **Task 2 GREEN:** `7e385e9` — `feat(44-01): implement settings-loader with D-05 precedence and D-12 core guardrail`

_Note: Tasks 1 & 2 shared a single test file (tests/settings-loader.test.ts), so RED was committed once covering both._

## Files Created/Modified
- `src/lib/config.ts` — Added corpusGen/corpusGenMax/schemaInductionEnabled to EngineConfig + DEFAULT_CONFIG; added PresetName type, SettingsFile interface, PRESET_CONFIGS constant
- `src/adapter/settings-loader.ts` — NEW: defaultSettingsPath, loadSettingsFile, writeSettingsFile, loadMergedConfig with full precedence + D-12 guardrail
- `tests/settings-loader.test.ts` — NEW: 24 tests covering PRESET_CONFIGS shapes, all six behavioral probes, chmod-600 assertion

## Decisions Made
- Shared RED commit for both tasks since test file imports settings-loader (which doesn't exist during Task 1 RED — can't isolate the two RED phases)
- `sleepFrequencyHours` placed in `SettingsFile.overrides` only (not in EngineConfig) per D-07 — it's a scheduler artifact, not a runtime config field
- `sanitizeCoreGuardrail` strips both `consolSkipThreshold` and `consolSkipThresholdAssistant` when outside `(0, 1)` — ensures the indirect-disable path (crank threshold to skip everything) is blocked regardless of which threshold is abused

## Deviations from Plan

None — plan executed exactly as written. All four threat mitigations (T-44-01 through T-44-04) are implemented:
- T-44-01: loadMergedConfig sanitizes core-disabling salience thresholds
- T-44-02: writeSettingsFile chmod 0o600
- T-44-03: loadSettingsFile never throws; loadMergedConfig always returns valid DEFAULT-based config
- T-44-04: unknown preset falls back to 'standard'

## Issues Encountered
None.

## Next Phase Readiness
- `loadMergedConfig(dbPath)` is ready for 44-02 to import and use at run-sleep-pass.ts call sites
- `writeSettingsFile` is ready for 44-04 (config CLI) and 44-05 (viz-server POST /settings)
- `defaultSettingsPath()` is the canonical settings location for all consumers

---
*Phase: 44-bundled-app-settings-cost-controls*
*Completed: 2026-06-24*
