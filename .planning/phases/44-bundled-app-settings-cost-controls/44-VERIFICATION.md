---
phase: 44-bundled-app-settings-cost-controls
verified: 2026-06-24T23:10:00Z
status: human_needed
score: 12/12 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Open browser at http://127.0.0.1:7810, click the Settings button"
    expected: "Panel slides in from the left; preset selector shows 'Standard'; schema/corpus toggles render with current values from GET /settings; usage readout (30d headline + per-feature lines + all-time total) renders once the sleep pass has run at least one LLM call"
    why_human: "Visual rendering and CSS animation cannot be verified via grep; the fetch chain to /settings and /usage routes is verified by unit tests but the actual DOM interaction needs a running server"
  - test: "Change a toggle (e.g. turn on 'readable corpus docs'), click Save"
    expected: "Panel header shows 'Standard (modified)'; subsequent GET /settings returns the new override in the overrides map; settings.json on disk reflects the change with chmod 600"
    why_human: "Round-trip persistence through a running viz server cannot be verified statically"
  - test: "Run `recense config show` in a terminal after installing settings.json"
    expected: "Prints preset header with '(modified)' label when overrides diverge from preset baseline; shows 'core: extract + reconsolidation — always on' line with no toggle; source column labels env/settings.json/preset:name/default correctly"
    why_human: "CLI output format requires a running binary with a real settings file on disk"
  - test: "Run `recense config set consolSkipThreshold 1.5` — should warn and not persist the value"
    expected: "D-12 guardrail: stderr warning that value was stripped; post-write loadMergedConfig shows the threshold fell back to the preset/DEFAULT value (0.2)"
    why_human: "Requires running binary and readable output"
  - test: "Run `recense config apply` on macOS after setting sleepFrequencyHours to 2 in settings.json"
    expected: "Launchd plist regenerated with <integer>7200</integer> in the StartInterval key; `launchctl list | grep recense` shows the updated job"
    why_human: "Platform-specific launchd operation, macOS required, cannot verify statically"
---

# Phase 44: Bundled-App Settings & Cost Controls — Verification Report

**Phase Goal:** Settings surface (CLI + in-app panel) letting a bundled-app user control and see which token-spending sleep-pass features run — presets (Lite/Standard/Full), granular toggles, token-usage readout, and a settings panel inside the viz frontend with zero new Electron IPC.

**Verified:** 2026-06-24T23:10:00Z
**Status:** HUMAN_NEEDED (all automated checks VERIFIED; 5 human visual/runtime items remain — Task 3 of plan 06 is the blocking gate)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D-02: Settings panel lives inside the viz frontend (src/viz/modules/settings.js), not a new Electron window; preload is empty | VERIFIED | `apps/tray/src/preload.ts` is intentionally empty with `export {}`; `settings.js` created at `src/viz/modules/settings.js`; `app.js:35,237` imports and calls `initSettings(ctx)` |
| 2 | D-03: Three consumers (CLI, HTTP, frontend) share one settings.json via the same loader API | VERIFIED | CLI: `config-cli.ts` uses `writeSettingsFile`/`loadMergedConfig`; HTTP: `viz/server.ts:46-49` imports the same; frontend: calls `/settings` route which calls the same functions. All use `defaultSettingsPath()` as the canonical path |
| 3 | D-04: settings.json lives in ~/.config/recense/ alongside recense.db and sleep.env | VERIFIED | `settings-loader.ts:39`: `join(homedir(), '.config', 'recense', 'settings.json')` |
| 4 | D-05: Precedence env > settings.json > preset > DEFAULT_CONFIG | VERIFIED | `settings-loader.ts:108-138`: merge order is `DEFAULT_CONFIG → PRESET_CONFIGS[preset] → sanitizedOverrides → dbPath`, then `applyEnvOverrides()` last |
| 5 | D-06: run-sleep-pass.ts and ingest-project-cli.ts consult merged config (not raw process.env) for corpusGen/corpusGenMax | VERIFIED | `run-sleep-pass.ts:416`: `const config = loadMergedConfig(dbPath, env)`; `run-sleep-pass.ts:569,625`: `config.corpusGen` / `config.corpusGenMax` used (not `process.env`); same pattern confirmed in `ingest-project-cli.ts:652,773,799` |
| 6 | D-07: sleepFrequencyHours in settings.json drives launchd StartInterval via recense config apply | VERIFIED | `recense-scheduler.ts:51-75`: `getSchedulerIntervalSeconds()` reads `sf.overrides.sleepFrequencyHours`, integer-coerces, substitutes `__FREQUENCY__` in plist; `plist.template:60-61` has `<key>StartInterval</key><integer>__FREQUENCY__</integer>` |
| 7 | D-08: token_usage_ledger table exists in schema v14 and the production sleep pass installs the ledger sink | VERIFIED | `schema.ts:11`: `SCHEMA_VERSION = 14`; `schema.ts:177-187`: full DDL with all columns; `schema.ts:597-605`: v14 migration block; `sleep-pass-cli.ts:111-131`: `stmtLedgerInsert` prepared and installed via `setHeadlessUsageSink()` |
| 8 | D-09: Each LLM call is tagged by feature (corpus_gen/schema_abstract/extract/judge); /usage aggregates by feature_tag | VERIFIED | `claude-headless-client.ts:101-110`: `setHeadlessFeature()` + `deriveFeatureTag()` (Haiku→extract, Sonnet→judge); `run-sleep-pass.ts:629/644`: corpus_gen bracket; `consolidator.ts:932/936`: schema_abstract bracket; `viz/server.ts:336-354`: two GROUP BY feature_tag prepared statements |
| 9 | D-10: /usage returns rolling_30d + all_time; frontend shows 30d headline + all-time total | VERIFIED | `viz/server.ts:1083-1084`: `rolling_30d: summarise(rows30d), all_time: summarise(rowsAll)`; `settings.js:411-469`: `appendFullUsageReadout` renders 30d headline ("this period you spent N tokens") + per-feature breakdown + all-time total |
| 10 | D-11: Preset + overrides model; divergence label "(modified)" in UI and CLI | VERIFIED | `config.ts:873-917`: `SettingsFile` interface + `PRESET_CONFIGS`; `settings-loader.ts:121-133`: merge logic; `config-cli.ts:116-123`: D-11 divergence detection + label; `settings.js:120-132`: `hasOverrides` drives header textContent |
| 11 | D-12: Core (extract + reconsolidation) has no toggle in UI/CLI AND loader hard-strips thresholds outside (0,1) | VERIFIED | `settings-loader.ts:167-188`: `sanitizeCoreGuardrail()` strips `consolSkipThreshold`/`consolSkipThresholdAssistant` >= 1 or < 0; `settings.js:159-167`: static "always on" label row, no checkbox; `config-cli.ts:40-48`: SETTABLE_KEYS whitelist excludes all core fields |
| 12 | Phantom-field bug fixed: settings.js sums input_tokens+output_tokens (not phantom total_tokens) | VERIFIED | `settings.js:371-372,447-449`: `(row.input_tokens || 0) + (row.output_tokens || 0)` used in both `appendUsageLines` and `appendFullUsageReadout`; `viz/server.ts:1071-1074`: same sum in the server-side `summarise()` function |

**Score:** 12/12 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/adapter/settings-loader.ts` | D-05 precedence + D-12 guardrail + chmod-600 writes | VERIFIED | Full implementation; `loadMergedConfig`, `loadSettingsFile`, `writeSettingsFile`, `defaultSettingsPath` all present |
| `src/lib/config.ts` | PresetName, SettingsFile, PRESET_CONFIGS, corpusGen/corpusGenMax/schemaInductionEnabled in EngineConfig + DEFAULT_CONFIG | VERIFIED | `config.ts:557,565,573,849-851,864-917` |
| `src/consolidation/run-sleep-pass.ts` | loadMergedConfig replaces DEFAULT_CONFIG spread; corpus_gen feature bracket | VERIFIED | Line 416, 565-644 |
| `src/consolidation/consolidator.ts` | schemaInductionEnabled gate + schema_abstract feature bracket | VERIFIED | Lines 922-943 |
| `src/db/schema.ts` | token_usage_ledger DDL + v14 migration | VERIFIED | Lines 11, 177-187, 597-605 |
| `src/model/claude-headless-client.ts` | setHeadlessFeature, deriveFeatureTag, feature_tag in HeadlessUsage | VERIFIED | Lines 62-110 |
| `src/adapter/sleep-pass-cli.ts` | Production ledger sink installed after initSchema | VERIFIED | Lines 105-131 |
| `src/adapter/config-cli.ts` | show/get/set/preset/apply subcommands with D-11/D-12 | VERIFIED | Lines 89-101; all five subcommands dispatch |
| `src/adapter/recense.ts` | case 'config' dispatch + 'config' in usage string | VERIFIED | Lines 79-80, 152 |
| `src/adapter/recense-scheduler.ts` | getSchedulerIntervalSeconds + renderPlistContent + __FREQUENCY__ substitution | VERIFIED | Lines 40-75, 119 |
| `scripts/com.recense.sleep-pass.plist.template` | StartInterval with __FREQUENCY__ placeholder (not StartCalendarInterval) | VERIFIED | Lines 60-61 |
| `src/viz/server.ts` | GET /settings, POST /settings, GET /usage routes | VERIFIED | Lines 18-20, 929-1084 |
| `src/viz/modules/settings.js` | D-02 no-IPC panel; D-09 adjacent usage lines; D-10 30d+all-time; D-11 divergence; D-12 always-on core row | VERIFIED | Full file; initFoo pattern; fetchSettings/fetchUsage/render/save |
| `src/viz/modules/app.js` | import initSettings + initSettings(ctx) call | VERIFIED | Lines 35, 237 |
| `src/viz/index.html` | btn-settings button + settings-panel div | VERIFIED | Lines 42, 120-125 |
| `apps/tray/src/preload.ts` | Intentionally empty (D-102 zero-IPC) | VERIFIED | Contains only `export {}` with explanatory comment |
| `tests/settings-loader.test.ts` | 24 tests (D-05 precedence, D-12 guardrail, resilience, chmod-600) | VERIFIED | 24 tests pass |
| `tests/settings-call-sites.test.ts` | 10 tests (env-wins precedence + schema gate) | VERIFIED | 10 tests pass |
| `tests/token-usage-ledger.test.ts` | 9 tests (feature tagging, sink, DB rows) | VERIFIED | 9 tests pass |
| `tests/config-cli.test.ts` | 28 tests (all subcommands, D-11/D-12/D-07) | VERIFIED | 28 tests pass |
| `tests/viz-settings-routes.test.ts` | 18 tests (GET/POST /settings, GET /usage, 403/405 guards) | VERIFIED | 18 tests pass |
| `tests/viz-settings-panel.test.ts` | 23 tests (panel render, toggles, save, usage readout, no-innerHTML) | VERIFIED | 23 tests pass |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `sleep-pass-cli.ts` | `token_usage_ledger` (DB) | `setHeadlessUsageSink` + prepared INSERT | VERIFIED | Lines 111-131; sink installed after `initSchema(db)`, cleared in `finally` |
| `run-sleep-pass.ts` | `settings.json` | `loadMergedConfig(dbPath, env)` at line 416 | VERIFIED | Replaces prior `{ ...DEFAULT_CONFIG, dbPath }` spread |
| `consolidator.ts` | schema induction gate | `if (this.config.schemaInductionEnabled !== false)` | VERIFIED | Line 926; `!== false` means undefined = run (fail-OPEN) |
| `run-sleep-pass.ts` | corpus_gen feature tag | `setHeadlessFeature('corpus_gen')` bracket at line 629 | VERIFIED | try/finally null-reset at line 644 |
| `consolidator.ts` | schema_abstract feature tag | `setHeadlessFeature('schema_abstract')` bracket at line 932 | VERIFIED | try/finally null-reset at line 936 |
| `viz/server.ts` | `settings.json` | `writeSettingsFile` on POST; `loadMergedConfig` on GET | VERIFIED | Lines 1027, 934, 1030 |
| `viz/server.ts` | `token_usage_ledger` | compiled GROUP BY prepared statements | VERIFIED | Lines 330-354; two statements (30d, all-time) |
| `settings.js` | `/settings` route | `fetch('/settings')` in `fetchSettings()` + POST in `save()` | VERIFIED | Lines 82-86, save() calls `fetch('/settings', {method:'POST',...})` |
| `settings.js` | `/usage` route | `fetch('/usage')` in `fetchUsage()` | VERIFIED | Lines 93-99 |
| `recense.ts` | `config-cli.ts` | `case 'config': require('./config-cli')` | VERIFIED | Lines 79-80 |
| `recense-scheduler.ts` | `settings.json` | `getSchedulerIntervalSeconds()` reads `sleepFrequencyHours` | VERIFIED | Lines 51-57 |
| `app.js` | `settings.js` | `import { initSettings }` + `initSettings(ctx)` | VERIFIED | Lines 35, 237 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `settings.js` render() | `settingsData` (preset/overrides/effective) | `fetch('/settings')` → `viz/server.ts` GET /settings → `loadMergedConfig` → `settings.json` on disk | Yes — reads live file; defaults to `{preset:'standard',overrides:{}}` gracefully when missing | FLOWING |
| `settings.js` appendFullUsageReadout() | `usageData` (rolling_30d/all_time/byFeature) | `fetch('/usage')` → `viz/server.ts` GET /usage → two prepared SELECT statements on `token_usage_ledger` | Yes — live DB query; zeroed aggregates when ledger is empty (not null/static) | FLOWING |
| `run-sleep-pass.ts` corpus gate | `config.corpusGen` / `config.corpusGenMax` | `loadMergedConfig(dbPath, env)` merging settings.json + env | Yes — reads live settings.json then applies env overrides | FLOWING |
| `consolidator.ts` schema gate | `this.config.schemaInductionEnabled` | Config passed to Consolidator constructor; built by `loadMergedConfig` | Yes — same merged config chain | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles clean | `npx tsc --noEmit` | exit 0, no output | PASS |
| 112 phase-44 unit tests pass | `npx vitest run tests/settings-loader.test.ts tests/settings-call-sites.test.ts tests/token-usage-ledger.test.ts tests/config-cli.test.ts tests/viz-settings-routes.test.ts tests/viz-settings-panel.test.ts` | 6 files, 112 tests, all passed | PASS |
| settings.js sums input+output (not phantom total_tokens) | `grep "input_tokens.*output_tokens" src/viz/modules/settings.js` | 2 matches (appendUsageLines:372, appendFullUsageReadout:449) | PASS |
| D-12 guardrail strips threshold >= 1 | `grep -A5 "consolSkipThreshold >= 1" src/adapter/settings-loader.ts` | `delete safe.consolSkipThreshold` at line 177 | PASS |
| SETTABLE_KEYS excludes core fields | `grep -A10 "SETTABLE_KEYS" src/adapter/config-cli.ts` | Whitelist of 6 keys; no consolSkipThreshold (core) | PASS |
| preload is empty (D-102) | read `apps/tray/src/preload.ts` | `export {}` only | PASS |

### Probe Execution

Step 7c: SKIPPED — no `scripts/*/tests/probe-*.sh` probes exist for this phase; the phase does not declare probe-based verification.

### Requirements Coverage

Phase 44 traces to locked decisions D-01..D-12 in 44-CONTEXT.md (not REQUIREMENTS.md IDs).

| Decision | Plan | Status | Evidence |
|----------|------|--------|----------|
| D-01: Full phase including tray UI | 44-01 through 44-06 | SATISFIED | All 6 plans executed; tray UI delivered as viz frontend panel |
| D-02: Zero-IPC thin shell; settings panel in viz frontend | 44-06 | SATISFIED | `settings.js` in `src/viz/modules/`; preload is empty `export {}` |
| D-03: One settings.json, three consumers | 44-01/04/05/06 | SATISFIED | All three consumers use same `defaultSettingsPath()` and loader API |
| D-04: settings.json in ~/.config/recense/ | 44-01 | SATISFIED | `settings-loader.ts:39` |
| D-05: env > settings.json > preset > DEFAULT_CONFIG | 44-01 | SATISFIED | `loadMergedConfig` merge order verified |
| D-06: run-sleep-pass + ingest-project-cli use merged config | 44-02 | SATISFIED | `loadMergedConfig` at line 416 in run-sleep-pass.ts; same in ingest-project-cli.ts |
| D-07: sleepFrequencyHours drives launchd StartInterval | 44-04 | SATISFIED | `__FREQUENCY__` placeholder substituted by `getSchedulerIntervalSeconds()` |
| D-08: token_usage_ledger in recense.db; production sink wired | 44-03 | SATISFIED | Schema v14 DDL + migration; sink installed in sleep-pass-cli.ts |
| D-09: Feature tags (corpus_gen/schema_abstract/extract/judge); /usage by feature | 44-03/05/06 | SATISFIED | `setHeadlessFeature` brackets + model-derived fallback; GROUP BY query; panel renders per-feature lines adjacent to each toggle |
| D-10: Rolling 30d + all-time readout | 44-05/06 | SATISFIED | Two prepared statements in server.ts; `appendFullUsageReadout` in settings.js |
| D-11: Preset + overrides; divergence label "(modified)" | 44-01/04/06 | SATISFIED | PRESET_CONFIGS; `loadMergedConfig` merge; divergence detection in CLI and frontend |
| D-12: Core guardrail — no toggle + loader sanitization | 44-01/04/06 | SATISFIED | `sanitizeCoreGuardrail()` in loader; SETTABLE_KEYS whitelist; always-on static row in UI |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| (none in phase-44 files) | — | — | — |

Scanned all 22 phase-44 created/modified files. No TBD/FIXME/XXX debt markers. No placeholder returns. No empty implementations. The `export {}` in preload.ts is intentional and structurally required (D-102), not a stub.

### Pre-Existing Test Failures (not regressions)

6 corpus-promoter test failures exist in the suite and are **pre-existing** — confirmed by `git log`: the last commits to `tests/corpus-promoter.test.ts`, `tests/corpus-hub-promoter.test.ts`, and `tests/corpus-promoter-always-promote.test.ts` all predate the phase-44 commit chain. No phase-44 commit touched these files. Do not block phase-44 on these.

```
FAIL tests/corpus-hub-promoter.test.ts (2 tests)
FAIL tests/corpus-promoter-always-promote.test.ts (2 tests)
FAIL tests/corpus-promoter.test.ts (2 tests)
```

---

### Human Verification Required

These items were marked as a `checkpoint:human-verify` blocking gate in plan 44-06 Task 3. The automated test suite (23/23 passing in `tests/viz-settings-panel.test.ts`) covers all structural behaviors, but the live visual and CLI behaviors require human verification:

#### 1. Settings Panel Visual Render

**Test:** Start the viz server (`recense viz`), open http://127.0.0.1:7810 in a browser, click the "Settings" button.
**Expected:** Panel slides in from the left. Preset selector shows "Standard". Schema abstraction and corpus docs toggles visible with correct boolean values. Tuning number inputs populated. Token usage section shows "no usage recorded yet" (or actual data if sleep pass has run).
**Why human:** CSS slide animation, DOM rendering from real HTTP responses, visual layout — cannot verify via grep.

#### 2. Save Round-Trip with Divergence Label

**Test:** Toggle "readable corpus docs" on, click Save.
**Expected:** Panel header changes to "Standard (modified)". POST /settings logged in network tab. Subsequent GET /settings returns `{preset:'standard', overrides:{corpusGen:true}, effective:{...}}`. `~/.config/recense/settings.json` on disk updated with mode 600.
**Why human:** Requires a running server and browser network tab; file permissions require OS inspection.

#### 3. Core Guardrail Visual Confirmation

**Test:** Inspect the settings panel UI for "extract + reconsolidation" section.
**Expected:** A static label row "core: extract + reconsolidation — always on (this is recense)" with NO checkbox or toggle control. Schema abstraction and corpus docs each have a checkbox.
**Why human:** Visual layout — confirmed by unit test mock but needs live browser confirmation.

#### 4. `recense config show` Output Format

**Test:** Run `recense config show` in a terminal.
**Expected:** Prints preset header (e.g., "Standard" or "Standard (modified)"); "always on — this is recense" line for core; per-lever rows with source label (env/settings.json/preset:standard/default).
**Why human:** CLI output format requires a running binary with a real settings file.

#### 5. `recense config apply` Launchd Regen (macOS)

**Test:** Set `sleepFrequencyHours: 2` in settings.json, run `recense config apply`.
**Expected:** Launchd plist regenerated with `<integer>7200</integer>` in StartInterval. Verified via `launchctl list | grep recense`.
**Why human:** Platform-specific operation; macOS launchd required.

---

## Gaps Summary

None. All 12 automated must-haves are VERIFIED. The only open items are 5 human verification steps (the expected blocking gate from plan 44-06 Task 3, approved by operator on 2026-06-24 per the SUMMARY — but full structured human-verify sign-off is recorded here for the orchestrator).

The operator confirmation recorded in 44-06-SUMMARY.md ("Task 3 — Human visual verification: APPROVED (2026-06-24)") provides strong evidence that the human gate was satisfied. The verifier records it here as human_needed per the verification protocol because it requires the orchestrator to confirm the gate was formally closed.

---

_Verified: 2026-06-24T23:10:00Z_
_Verifier: Claude (gsd-verifier)_
