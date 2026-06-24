---
phase: 44-bundled-app-settings-cost-controls
plan: "03"
subsystem: cost-observability
tags: [token-ledger, feature-tagging, headless-client, sleep-pass, sqlite]
dependency_graph:
  requires: []
  provides: [token_usage_ledger, setHeadlessFeature, production-ledger-sink]
  affects: [44-05-usage-route, 44-06-settings-panel]
tech_stack:
  added: []
  patterns: [best-effort-sink, ambient-feature-tag, model-derived-fallback, try-catch-swallow]
key_files:
  created:
    - tests/token-usage-ledger.test.ts
  modified:
    - src/db/schema.ts
    - src/model/claude-headless-client.ts
    - src/adapter/sleep-pass-cli.ts
    - src/consolidation/run-sleep-pass.ts
    - src/consolidation/consolidator.ts
decisions:
  - "schema_abstract bracketing placed in consolidator.ts (around induceSchemas()) not run-sleep-pass.ts — schema induction is inside consolidate(), plan acceptance criteria for >=4 setHeadlessFeature calls in run-sleep-pass.ts was incorrect"
  - "corpus_gen bracketing placed in run-sleep-pass.ts around generateCorpusDocs() only (not subjectPromoter) since subjectPromoter falls through to model-derived judge fallback correctly"
  - "SCHEMA_VERSION bumped from 13 to 14 following existing migration pattern"
metrics:
  duration_seconds: 349
  completed_date: "2026-06-24T23:47:34Z"
  tasks_completed: 2
  files_changed: 5
---

# Phase 44 Plan 03: Token-Usage Ledger + Feature-Tag Plumbing Summary

Production token-usage ledger with per-call feature tagging (corpus_gen/schema_abstract/extract/judge) using setHeadlessFeature ambient context and model-derived fallbacks, wired into the live sleep pass via best-effort INSERT sink.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | token_usage_ledger table + feature_tag plumbing | 6e6203b | src/db/schema.ts, src/model/claude-headless-client.ts, tests/token-usage-ledger.test.ts |
| 2 | Production ledger sink in sleep pass + phase tagging | 6595560 | src/adapter/sleep-pass-cli.ts, src/consolidation/run-sleep-pass.ts, src/consolidation/consolidator.ts |

## What Was Built

### Task 1: Schema + headless client (6e6203b)

**`src/db/schema.ts`**
- Added `token_usage_ledger` table to DDL: `id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, feature_tag TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd REAL NOT NULL DEFAULT 0`
- v14 migration: `CREATE INDEX IF NOT EXISTS idx_token_usage_ledger_ts ON token_usage_ledger (ts)` — enables cheap window queries (rolling 30d, all-time per D-10)
- SCHEMA_VERSION bumped 13 → 14

**`src/model/claude-headless-client.ts`**
- Added `feature_tag?: string` to `HeadlessUsage` interface
- Added `let currentFeature: string | null = null` module-level ambient
- Added `export function setHeadlessFeature(tag: string | null): void`
- Added `deriveFeatureTag(model: string): string` — Haiku→'extract', Sonnet→'judge', else 'unknown'
- Updated both emit sites to include `feature_tag: currentFeature ?? deriveFeatureTag(useModel)` (ambient wins per D-09)

**`tests/token-usage-ledger.test.ts`** (new, 9 tests)
- feature_tag derivation suite: ambient overrides (corpus_gen, schema_abstract), Sonnet→judge, Haiku→extract, unknown→unknown, clearing ambient restores fallback
- best-effort guard: throwing sink does not interrupt surrounding flow
- DB row assertions: 1 row per emit, correct feature_tag + all token columns + total_cost_usd
- idempotency: token_usage_ledger + index exist after double initSchema

### Task 2: Production sink + phase tagging (6595560)

**`src/adapter/sleep-pass-cli.ts`**
- Import: `setHeadlessUsageSink`, `HeadlessUsage` from claude-headless-client
- Installs production ledger sink after `initSchema(db)`, before `runConsolidation(...)`: `db.prepare(INSERT INTO token_usage_ledger ...).run(Date.now(), u.feature_tag ?? 'unknown', u.model, ...token fields...)` — wrapped in try/catch (T-44-08 best-effort)
- `setHeadlessUsageSink(null)` in finally block clears on both success and error paths

**`src/consolidation/run-sleep-pass.ts`**
- Import: `setHeadlessFeature` from claude-headless-client
- Brackets `generateCorpusDocs()` with `setHeadlessFeature('corpus_gen')` before / `setHeadlessFeature(null)` in finally

**`src/consolidation/consolidator.ts`**
- Import: `setHeadlessFeature` from claude-headless-client
- Brackets `this.inducer.induceSchemas()` with `setHeadlessFeature('schema_abstract')` before / `setHeadlessFeature(null)` in finally

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run tests/token-usage-ledger.test.ts tests/consolidator.test.ts` — 18/18 passed
- Table-existence probe with built dist — confirmed OK

## Deviations from Plan

### Plan Adjustment: schema_abstract bracketing placement

**Found during:** Task 2 implementation

**Issue:** The plan's acceptance criteria stated `grep -c "setHeadlessFeature" src/consolidation/run-sleep-pass.ts` returns >= 4 (implying both corpus_gen AND schema_abstract bracketing in run-sleep-pass.ts). However, `induceSchemas()` is called inside `consolidator.consolidate()`, not directly in run-sleep-pass.ts. Placing `setHeadlessFeature('schema_abstract')` around the entire `consolidate()` call would wrongly tag all extract (Haiku) and judge (Sonnet) calls as schema_abstract since the ambient tag wins over model-derived fallback.

**Fix:** Added schema_abstract bracketing directly in `consolidator.ts` around `this.inducer.induceSchemas()` — the only correct and semantically accurate location. This gives 3 setHeadlessFeature calls in run-sleep-pass.ts (import + corpus_gen set + null) and 3 in consolidator.ts (import + schema_abstract set + null).

**Files modified:** src/consolidation/consolidator.ts (added, not in plan's files_modified)

## Known Stubs

None — the ledger is fully wired and writes real rows per LLM call in the live sleep pass.

## Threat Flags

No new threat surface beyond the plan's pre-registered threats (T-44-08, T-44-09, T-44-10) — all mitigated.

## Self-Check: PASSED

- tests/token-usage-ledger.test.ts: exists ✓
- src/db/schema.ts: token_usage_ledger in DDL ✓
- src/model/claude-headless-client.ts: setHeadlessFeature exported ✓
- src/adapter/sleep-pass-cli.ts: setHeadlessUsageSink installed ✓
- Task 1 commit 6e6203b: exists ✓
- Task 2 commit 6595560: exists ✓
