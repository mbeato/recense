---
phase: 44-bundled-app-settings-cost-controls
plan: "05"
subsystem: viz-server
tags: [viz, http-routes, settings, token-ledger, cost-readout, typescript]

# Dependency graph
requires:
  - plan: "44-01"
    provides: settings-loader API (loadMergedConfig/loadSettingsFile/writeSettingsFile)
  - plan: "44-03"
    provides: token_usage_ledger table + feature_tag schema

provides:
  - GET /settings → {preset, overrides, effective} HTTP route in src/viz/server.ts
  - POST /settings → key-whitelisted settings.json write route in src/viz/server.ts
  - GET /usage → rolling-30d + all-time token readout by feature in src/viz/server.ts
  - startVizServer now accepts opts.settingsPath for test isolation

affects:
  - 44-06 (settings panel frontend — calls these routes)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "GET/POST on same path: unified if(url==='/settings') with nested method dispatch"
    - "POST body: req.on('data')/req.on('end') + JSON.parse in try/catch → 400"
    - "Key whitelist: SETTABLE_OVERRIDE_KEYS Set; BOOLEAN_OVERRIDE_KEYS for type dispatch"
    - "Usage aggregates: two compiled prepared statements (30d + all-time) via GROUP BY feature_tag"
    - "startVizServer opts.settingsPath enables test isolation without mocking"
    - "mkdirSync recursive before first writeSettingsFile (D-04 directory guarantee)"

key-files:
  modified:
    - src/viz/server.ts
  created:
    - tests/viz-settings-routes.test.ts

key-decisions:
  - "Routes placed inside existing http.createServer handler → inherit Host-header 403 guard automatically (T-44-16)"
  - "SETTABLE_OVERRIDE_KEYS includes schemaInductionEnabled (it is in SettingsFile.overrides type) despite plan listing 6 — added as Rule 2 to avoid rejecting valid toggle (D-09 panel control)"
  - "Both tasks committed together: tasks 1 + 2 share server.ts and the test file; partial staging adds no value"
  - "startVizServer(opts.settingsPath) avoids vi.mock complexity while achieving test isolation"
  - "mkdirSync({recursive:true}) in POST handler guards first-write case without requiring pre-created dirs"

# Metrics
duration: ~7min
completed: 2026-06-24
---

# Phase 44 Plan 05: Settings + Usage HTTP Routes (viz server) Summary

**GET/POST /settings + GET /usage routes in src/viz/server.ts: localhost-only, key-whitelisted settings persistence + rolling-30d/all-time feature-tagged token readout**

## Performance

- **Duration:** ~7 min
- **Completed:** 2026-06-24
- **Tasks:** 2 (committed together — same files)
- **Files modified:** 2

## Accomplishments

- Added `GET /settings` — returns `{ preset, overrides, effective }` from settings.json + `loadMergedConfig`; defaults to `{ preset: 'standard', overrides: {} }` when no file exists
- Added `POST /settings` — reads chunked body, validates JSON, whitelists 7 override keys (T-44-15), coerces to correct types, merges onto existing SettingsFile, calls `writeSettingsFile`, returns updated state; 400 on bad json / invalid preset / unknown key / wrong type
- Added `GET /usage` — aggregates token_usage_ledger into rolling-30d + all-time totals by feature_tag using two compiled prepared statements; empty ledger → zeroed aggregates
- Updated `startVizServer` signature to accept `opts?: { settingsPath?: string }` for test isolation
- Added `mkdirSync({ recursive: true })` before `writeSettingsFile` to guarantee D-04 directory exists
- Created 18-test file covering all route behaviors including 403/405 guards and DNS-rebinding guard

## Task Commits

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1+2 | GET/POST /settings + GET /usage | 5c58fdd | src/viz/server.ts, tests/viz-settings-routes.test.ts |

_Note: Tasks 1 and 2 were implemented and committed together since they share the same source file (server.ts) and the same test file (viz-settings-routes.test.ts). Partial staging would have provided no meaningful isolation._

## Files Created/Modified

- `src/viz/server.ts` — Added 3 new routes + updated startVizServer signature + prepared statements + imports + whitelist constants. The in-flight elapsedMs WIP change was preserved as instructed.
- `tests/viz-settings-routes.test.ts` — NEW: 18 tests for /settings (GET/POST, whitelist, type coercion, 400/403/405) and /usage (empty ledger, 30d window, all-time, per-feature columns)

## Decisions Made

- `schemaInductionEnabled` added to SETTABLE_OVERRIDE_KEYS (it is in SettingsFile.overrides type — the plan's listed 6 keys omitted it, which would cause POST /settings to reject a valid schema toggle; added as Rule 2 missing critical functionality)
- Both tasks committed as one unit — tasks 1 and 2 share server.ts and tests/viz-settings-routes.test.ts; splitting would require partial staging with no benefit
- `opts.settingsPath` approach chosen over `vi.mock` — clean extension of the existing optional-arg pattern from settings-loader functions; avoids module-mock complexity in tests

## Deviations from Plan

### Auto-added: schemaInductionEnabled in whitelist

**Rule 2 — Missing critical functionality**

- **Found during:** Task 1 implementation
- **Issue:** Plan lists whitelist as 6 keys (omits schemaInductionEnabled), but `schemaInductionEnabled` is a legitimate SettingsFile.overrides key (the schema abstraction toggle). Without it, POST /settings with `{overrides:{schemaInductionEnabled:false}}` would return 400, breaking the panel's control over schema induction.
- **Fix:** Added `schemaInductionEnabled` to SETTABLE_OVERRIDE_KEYS (with boolean type dispatch). Total whitelist = 7 keys.
- **Files modified:** src/viz/server.ts
- **Commit:** 5c58fdd

## Known Stubs

None — routes are fully wired:
- GET /settings reads from real settings.json (or defaults gracefully)
- POST /settings writes to real settings.json (via writeSettingsFile)
- GET /usage reads from live token_usage_ledger table

## Threat Flags

No new threat surface beyond the pre-registered plan threats (T-44-15 through T-44-18) — all mitigated:
- T-44-15: POST /settings SETTABLE_OVERRIDE_KEYS whitelist + type validation ✓
- T-44-16: routes inside existing handler → inherit Host-header 403 guard automatically ✓
- T-44-17: all handlers wrapped in try/catch → 500 'internal error'; no stack/SQL leaked ✓
- T-44-18: settings writes use writeSettingsFile (filesystem only); DB handle stays read-only ✓

## Self-Check: PASSED

- src/viz/server.ts: modified, routes present ✓
- tests/viz-settings-routes.test.ts: created ✓
- `npx tsc --noEmit` clean ✓
- `npx vitest run tests/viz-settings-routes.test.ts` — 18/18 passed ✓
- `grep -c "/settings" src/viz/server.ts` returns 12 (>= 2) ✓
- `grep -c "token_usage_ledger" src/viz/server.ts` returns 2 (>= 1) ✓
- Task commit 5c58fdd: exists ✓
