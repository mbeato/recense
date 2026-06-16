---
phase: 22-notify-only-proactive-push
plan: "02"
subsystem: clients/telegram
tags: [surface-http, proactive-config, tdd, client-extension]
dependency_graph:
  requires: [22-01]
  provides: [surface-GET-client, surfaceSeen-POST-client, proactive-config-knobs]
  affects: [22-03-PLAN.md]
tech_stack:
  added: []
  patterns: [GET-fetch-not-postJson, Math.max-floor-env-config, mock-http-server-test]
key_files:
  modified:
    - clients/telegram/memory-client.ts
    - clients/telegram/config.ts
    - clients/telegram/tests/memory-client-surface.test.ts
  created: []
decisions:
  - "surface() uses a dedicated fetch(method:'GET') call — postJson is POST-only (Landmine 3 avoided)"
  - "SurfaceItem and SurfaceSeenParams declared locally in memory-client.ts (CLIENT-01, zero src/ imports)"
  - "proactiveEnabled defaults to false — only literal 'true' (case-insensitive) enables push (D-11)"
  - "pushPollMs floored at 10s; quietHours/digest/snooze env vars follow existing Math.max pattern"
metrics:
  duration: 12m
  completed_date: "2026-06-16"
  tasks: 3
  files: 3
---

# Phase 22 Plan 02: Surface HTTP Methods + Proactive Config Summary

Surface HTTP contract layer and default-OFF proactive runtime config added to the Telegram reference client — `surface()` GET against `/v1/surface`, `surfaceSeen()` POST against `/v1/surface/seen` with local types, and six env-configurable proactive knobs (quiet-hours, digest-hour, push-cadence, snooze-duration) all gated behind `RECENSE_PROACTIVE_ENABLED=false`.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | RED stub — failing tests for surface/surfaceSeen | a5b65ef | clients/telegram/tests/memory-client-surface.test.ts |
| 1 | GREEN — surface() GET + surfaceSeen() POST + local types | de752d6 | clients/telegram/memory-client.ts |
| 2 | Config — default-OFF proactive flag + push knobs | f82cf3c | clients/telegram/config.ts |
| 3 | Comprehensive mock-server test suite | 5610baa | clients/telegram/tests/memory-client-surface.test.ts |

## What Was Built

### `clients/telegram/memory-client.ts`

Two new exported interfaces and two new methods on `MemoryClient`:

- **`SurfaceItem`** — mirrors `src/db/surface-store.ts:SurfaceItem` (declared locally, CLIENT-01)
- **`SurfaceSeenParams`** — mirrors the `POST /v1/surface/seen` body schema (locally declared)
- **`surface(opts?)`** — `fetch(method:'GET')` to `/v1/surface` with optional `?limit=` query param; returns `SurfaceItem[]` or `[]`; uses existing `authHeader` closure and 10s `AbortSignal.timeout`
- **`surfaceSeen(params)`** — routes through the existing `postJson('/v1/surface/seen', params)` helper; discards return value

Key constraint: `surface()` does NOT use `postJson` — postJson hardcodes `method:'POST'` and would return 404 from the GET-only route (Landmine 3 from RESEARCH.md Pitfall 3).

### `clients/telegram/config.ts`

Six new fields added to `ClientConfig` and populated in `loadClientConfig()`:

| Field | Env Var | Default | Floor |
|-------|---------|---------|-------|
| `proactiveEnabled` | `RECENSE_PROACTIVE_ENABLED` | `false` | only `"true"` enables |
| `pushPollMs` | `RECENSE_PUSH_POLL_MS` | 120000 (2 min) | 10000 |
| `quietHoursStart` | `RECENSE_QUIET_HOURS_START` | 22 | — |
| `quietHoursEnd` | `RECENSE_QUIET_HOURS_END` | 7 | — |
| `digestHour` | `RECENSE_DIGEST_HOUR` | 8 | — |
| `snoozeDurationMs` | `RECENSE_SNOOZE_DURATION_MS` | 86400000 (24h) | — |

The existing `enabled` gate is untouched. `proactiveEnabled` is orthogonal — reactive Q&A continues when proactive push is off.

### `clients/telegram/tests/memory-client-surface.test.ts`

9 tests across 2 describe blocks using a real `http.createServer` mock:

- `surface()` issues GET (not POST) — pins Landmine 3
- `surface()` returns scripted items array
- `surface()` returns `[]` on empty response
- `surface({ limit: 2 })` appends `?limit=2`
- `surface()` without limit has no query string
- `surfaceSeen()` sends POST body with node_id, occurrence_due_at, outcome
- Snooze round-trip: `snooze_until` present in POST body (WR-01 satisfiable)
- `surfaceSeen()` resolves on 200
- `surfaceSeen()` rejects with `serve HTTP 404` on non-2xx

## Verification

```
npx vitest run clients/telegram/tests/   →  3 files, 33 tests, all pass
grep "method: 'GET'" memory-client.ts   →  line 126 inside surface()
grep RECENSE_PROACTIVE_ENABLED config.ts →  lines 29, 71
grep "^import" memory-client.ts          →  (empty — zero src/ imports)
```

## Deviations from Plan

None — plan executed exactly as written. TDD flow applied to Task 1 (RED stub commit a5b65ef → GREEN commit de752d6) and Task 3 (comprehensive test file created and verified passing immediately since implementation was complete).

## Known Stubs

None — no placeholders or hardcoded empty values in the delivered artifacts. `surface()` and `surfaceSeen()` are fully wired; `proactiveEnabled` defaults to false (runtime guard, not a stub).

## Threat Flags

None — no new network endpoints, auth paths, or schema changes beyond what the plan's threat model covers (T-22-03, T-22-06, T-22-05, T-22-SC all addressed).

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (test) | a5b65ef | test(22-02): failing stubs — 2/2 tests failed |
| GREEN (feat) | de752d6 | feat(22-02): implementation — 2/2 tests passed |
| Task 3 (test) | 5610baa | test(22-02): comprehensive suite — 9/9 passed |

## Self-Check: PASSED

- `clients/telegram/memory-client.ts` — exists, contains `method: 'GET'` at line 126
- `clients/telegram/config.ts` — exists, contains `RECENSE_PROACTIVE_ENABLED` at lines 29 and 71
- `clients/telegram/tests/memory-client-surface.test.ts` — exists, 9 tests pass
- Commits a5b65ef, de752d6, f82cf3c, 5610baa — all present in git log
