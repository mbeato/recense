---
phase: 44-bundled-app-settings-cost-controls
plan: 04
subsystem: config-cli
tags: [config, cli, presets, cost-controls, typescript, launchd, scheduler]

# Dependency graph
requires:
  - phase: 44-01
    provides: settings-loader API (loadMergedConfig, loadSettingsFile, writeSettingsFile, defaultSettingsPath)
provides:
  - src/adapter/config-cli.ts with runConfigCommand(sub, args, settingsPath?, schedulerOverride?)
  - recense config show/get/set/preset/apply subcommands wired into recense.ts dispatcher
  - recense-scheduler.ts getSchedulerIntervalSeconds() and renderPlistContent() helpers
  - __FREQUENCY__ placeholder in plist template replaced by StartInterval (D-07)
affects:
  - 44-05 (viz-server settings routes — same settings.json backing store)
  - launchd plist — StartCalendarInterval replaced with StartInterval driven by sleepFrequencyHours

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Non-auto-invoking CLI module dispatched via require() — mirrors runSchedulerCommand pattern"
    - "Optional settingsPath + schedulerOverride params enable test isolation without mocks"
    - "Double-cast (as unknown as Record<string, unknown>) for EngineConfig dynamic key access"
    - "process.exit mock must throw to stop code execution in Vitest tests"

key-files:
  created:
    - src/adapter/config-cli.ts
    - tests/config-cli.test.ts
  modified:
    - src/adapter/recense.ts
    - src/adapter/recense-scheduler.ts
    - scripts/com.recense.sleep-pass.plist.template

key-decisions:
  - "D-11: divergence label computed by comparing overrides to preset+DEFAULT baseline; sleepFrequencyHours excluded (scheduler-only, not runtime)"
  - "D-12: post-write loadMergedConfig re-check for consolSkipThreshold fields; warns if guardrail stripped value"
  - "D-07: StartCalendarInterval (Minute=0) replaced with StartInterval + __FREQUENCY__ placeholder; default 3600s preserves hourly cadence"
  - "T-44-14: getSchedulerIntervalSeconds coerces to integer; non-numeric falls back to 3600s default"
  - "runConfigCommand accepts optional schedulerOverride for spy-testing apply without require() mocking"
  - "SETTABLE_KEYS whitelist omits schemaInductionEnabled (preset-controlled only) and all core fields"

requirements-completed: [D-04, D-07, D-11, D-12]

# Metrics
duration: 15min
completed: 2026-06-24
---

# Phase 44 Plan 04: recense config CLI + launchd frequency regen Summary

**recense config CLI (show/get/set/preset/apply) operating on settings.json with D-11 divergence label, D-12 core guardrail, and D-07 launchd StartInterval driven by sleepFrequencyHours**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-06-24
- **Tasks:** 2 auto
- **Files modified:** 5

## Accomplishments

- Created `src/adapter/config-cli.ts` exporting `runConfigCommand(sub, args, settingsPath?, schedulerOverride?)`
- `show`: prints preset header with D-11 "(modified)" label when any override diverges from the preset+DEFAULT baseline; always-on core line (D-12)
- `get`: single lever value + source label (env/settings.json/preset:name/default)
- `set`: T-44-11 whitelist (6 keys); boolean/numeric coercion; T-44-12 post-write guardrail warning for consolSkipThreshold fields
- `preset`: sets preset name, clears overrides whose key the new preset explicitly defines (D-11 clean switch)
- `apply`: delegates to `runSchedulerCommand('install', [])` on macOS; prints croner restart guidance on Linux (D-07)
- Wired `case 'config'` into `recense.ts` dispatch; added `config` to usage string
- Replaced `StartCalendarInterval` with `StartInterval + __FREQUENCY__` in plist template
- Exported `getSchedulerIntervalSeconds()` and `renderPlistContent()` from recense-scheduler.ts; `installMacOSScheduler` now reads `sleepFrequencyHours` and substitutes seconds into the plist
- 28 unit tests covering all acceptance criteria

## Task Commits

1. **Task 1** `1501382` — `feat(44-04): add config-cli.ts with show/get/set/preset + recense.ts wiring`
2. **Task 2** `86828cc` — `feat(44-04): add __FREQUENCY__ plist placeholder and scheduler frequency helpers (D-07)`

## Files Created/Modified

- `src/adapter/config-cli.ts` — NEW: full config CLI implementation
- `tests/config-cli.test.ts` — NEW: 28 tests covering show/get/set/preset round-trips, D-11/D-12, plist rendering
- `src/adapter/recense.ts` — Added `case 'config'` dispatch and `config` to usage string
- `src/adapter/recense-scheduler.ts` — Added `getSchedulerIntervalSeconds`, `renderPlistContent` exports; updated `installMacOSScheduler` to use them
- `scripts/com.recense.sleep-pass.plist.template` — Replaced `StartCalendarInterval` dict with `StartInterval + __FREQUENCY__`

## Decisions Made

- `sleepFrequencyHours` excluded from the D-11 divergence check (it's a scheduler artifact, not a runtime EngineConfig lever)
- `schemaInductionEnabled` is shown in `config show` but NOT in the `set` whitelist — it's only controllable via `preset`
- Optional `schedulerOverride` param on `runConfigCommand` instead of vi.mock() — keeps the module pure and the test readable
- Default interval is 3600s (matches prior `StartCalendarInterval Minute=0` hourly cadence)

## Deviations from Plan

None — plan executed exactly as written. All four threat mitigations in scope implemented:
- T-44-11: SETTABLE_KEYS whitelist with exit 1 on unknown keys
- T-44-12: post-write loadMergedConfig re-check + stderr warning if guardrail stripped value
- T-44-13: config apply delegates to existing installMacOSScheduler via runSchedulerCommand
- T-44-14: integer coercion in getSchedulerIntervalSeconds before plist substitution

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes. The plist substitution uses integer-coerced values only (T-44-14).
