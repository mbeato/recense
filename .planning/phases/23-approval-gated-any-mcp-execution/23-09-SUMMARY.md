---
phase: 23-approval-gated-any-mcp-execution
plan: "09"
subsystem: memory-engine / audit-provenance
tags: [hitl, audit, d43, act03, consolidation, source-validation, gap-closure]
dependency_graph:
  requires: [23-01, 23-02, 23-03, 23-04, 23-05, 23-06, 23-07, 23-08]
  provides: [source-hitl-provenance, consolidation-hitl-exclusion]
  affects: [serve-cli, memory-ops, consolidator, telegram-memory-client]
tech_stack:
  patterns: [validateSource-allowlist, dual-site-guard, tdd-red-green]
key_files:
  created:
    - tests/validate-source.test.ts
    - tests/hitl-audit-provenance.test.ts
  modified:
    - src/adapter/memory-ops.ts
    - src/adapter/serve-cli.ts
    - src/consolidation/consolidator.ts
    - clients/telegram/memory-client.ts
decisions:
  - validateSource allowlist returns 'hitl' ONLY on exact match; all other values fall back to instance default (spoof-proof, mirrors D-05 validateOrigin discipline)
  - Consolidator exclusion at BOTH sites — isEligibleForExtraction (prefetch gate) and per-episode hard-stop loop — so they cannot drift (per the existing header comment contract)
  - listUnconsolidated query unchanged — hitl rows remain scannable so they are markConsolidated'd (no re-scan pile-up) and queryable as an audit trail by source='hitl'
  - Integration test uses real ops.add + real Consolidator (not mocked) — the integration seam that unit tests missed (GAP-01 root cause)
  - TDD RED/GREEN discriminator: empty generateScript → quarantine (consolidated=0) in RED; hard-stop fires (consolidated=1) in GREEN
metrics:
  duration_minutes: 14
  completed_date: "2026-06-17"
  tasks_completed: 2
  files_changed: 6
---

# Phase 23 Plan 09: HITL Audit-Episode Provenance (D-43 / ACT-03) Summary

**One-liner:** Thread `source='hitl'` through `/v1/add` → `ops.add` via `validateSource` allowlist, and exclude `source='hitl'` episodes from consolidation at both guard sites so HITL audit records are never belief input (closes GAP-01 / D-43 self-confirmation hole).

## Tasks Completed

### Task 1: Thread validated source through /v1/add → ops.add (commit: 4b3815d)

Added `validateSource(raw, fallback)` to `src/adapter/memory-ops.ts` — exact-match-or-fallback: returns `'hitl'` only when `raw === 'hitl'`; everything else (undefined, unknown, spoof attempts) returns `fallback`. Mirrors `validateOrigin`'s D-05 discipline.

Extended `MemoryOps.add(content, rawOrigin?, rawSource?)` with an optional third parameter threaded through `validateSource(rawSource, opts.source)` before `pipeline.recordEvent`. The `source` field in `recordEvent` was previously hardcoded to `opts.source` (the engine instance default).

Updated `/v1/add` handler in `serve-cli.ts` to parse `parsed.source` (same defensive `typeof` guard as origin) and pass it as the third argument to `ops.add`.

Updated `hitlEpisode()` in `clients/telegram/memory-client.ts` to include `source: 'hitl'` in the POST body.

Unit tests in `tests/validate-source.test.ts` (7 assertions): allowlist accept ('hitl'), fallback reject ('banana', 'mcp', undefined, ''), per-instance-default contract, and D-05 validateOrigin unchanged.

### Task 2: Consolidator hitl exclusion + integration test (commit: 22f475c)

Added `source === 'hitl'` guards at BOTH required sites in `src/consolidation/consolidator.ts`:

1. **`isEligibleForExtraction`** (prefetch Phase A gate, line 97): returns `false` for `source === 'hitl'` so audit episodes are never included in the concurrent extraction prefetch pool. This prevents `generate()` from being called on audit content before the per-episode loop even begins.

2. **Per-episode hard-stop loop** (line 441): extended `if (episode.origin === 'inferred' || echoSourceId !== null)` to include `|| episode.source === 'hitl'`. The hitl episode is `markConsolidated()'d` and `continue`'d — mirroring the inferred/echo handling exactly. `listUnconsolidated` query is untouched so rows are re-scanned and closed out (no pile-up).

Integration test `tests/hitl-audit-provenance.test.ts` uses real `wireMemoryEngine` + real `Consolidator` (not mocked) against a temp file DB:
- Source persistence: real `ops.add` with `source:'hitl'` → DB row has `source='hitl'`, `origin='observed'` (D-05 clamp), `consolidated=0`
- Spoof fallback: `source:'banana'` → `source='http'` (instance default)
- Consolidator exclusion: empty `generateScript` → if exclusion absent, `generate()` throws → H-2 quarantine → `consolidated=0` → test FAILS (RED). With exclusion: hard-stop fires → `consolidated=1` → test PASSES (GREEN)
- D-43 no-strengthen: seeded belief node's `s`/`c` unchanged after the pass
- Regression guard: non-hitl episode still eligible for extraction (generate consumed, `consolidated=1`)

## Deviations from Plan

None — plan executed exactly as written.

## Verification Against Success Criteria

| Criterion | Status | Evidence |
|-----------|--------|---------|
| source='hitl' persists through /v1/add → ops.add | VERIFIED | `grep -n "ops.add(parsed.content, origin, source)"` matches serve-cli.ts:349; integration test assertion (a) passes |
| validateSource: only 'hitl' override, else engine default | VERIFIED | `validateSource.test.ts` 7 assertions green; spoof-fallback test in integration test |
| source='hitl' excluded from consolidation at BOTH guard sites | VERIFIED | `grep -n "source === 'hitl'" consolidator.ts` matches lines 97 + 441 |
| hitl episodes markConsolidated'd (no re-scan pile-up) | VERIFIED | Integration test: `hitlEps.consolidated === 1` |
| Zero graph effects (no node, no s/c change) | VERIFIED | Integration test assertions (ii) and (iii) pass |
| D-05 validateOrigin clamp untouched | VERIFIED | `validateOrigin` count unchanged (5); validate-source.test.ts D-05 section green |
| listUnconsolidated unchanged | VERIFIED | `grep -c listUnconsolidated episode-store.ts` = 1 (no source filter added) |
| Full suite green (excluding pre-existing failures) | VERIFIED | 4 pre-existing failures (adapter-capture, adapter-inject, episodic-dryrun-gate, eval-harness-smoke) confirmed pre-existing on base commit 9f809db; all 73 changed-file tests pass |

## Pre-Existing Test Failures (Out of Scope)

Four test files fail on the base commit (9f809db) and after — confirmed pre-existing, not introduced by this plan:
- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)

These are infrastructure/CLI execution tests unrelated to memory-ops or consolidation.

## Self-Check: PASSED

All files verified present. All commits verified in git log.
