---
phase: 33-synchronous-curated-write-recense-remember-lossless-single-f
plan: 01
subsystem: api
tags: [cli, reconsolidation, sqlite, judge, embedding, curated-write]

# Dependency graph
requires:
  - phase: consolidation engine (update-decision, sink, semantic-store)
    provides: routeContradiction/isOscillation routing, SQLiteConsolidationSink, SemanticStore upsert/tombstone/scope, CandidateRetriever, DefaultModelProvider judge/embed
provides:
  - "recense remember \"<fact>\" [--scope <s>] — synchronous verbatim curated write with in-place reconsolidation"
  - "exported runRemember() + parseRememberArgs() helpers for offline unit testing"
  - "remember dispatcher case + usage string in recense.ts"
affects: [33-02 native-memory cutover migration uses recense remember as the sole write path]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "synchronous mini-sleep-pass: embed → top-k → judge → route/force-reconcile → atomic apply (all awaits BEFORE the .immediate() transaction)"
    - "call-site D-04 force-reconcile override on top of the pure routeContradiction"
    - "value_hash short-circuit for byte-identical idempotent re-writes (no embed/judge spent)"

key-files:
  created:
    - src/adapter/remember-cli.ts (490 lines — verbatim store + synchronous reconsolidation core, exported runRemember/parseRememberArgs)
    - tests/remember-cli.test.ts (422 lines — 5 deterministic offline tests)
  modified:
    - src/adapter/recense.ts (remember dispatcher case + usage Commands line)

key-decisions:
  - "D-03 seed: SEED_S=0.9, SEED_C=0.95 → resistance ≈ 0.855, so a passive observed contradiction (PE≈0.4) routes to HOLD (shield), while an explicit remember force-reconciles regardless"
  - "D-04 force-reconcile at call site: if routeContradiction returns 'hold' AND relation==contradict, override to 'reconcile' — an explicit user correction must never be silently dropped"
  - "REMEMBER_K=8 neighbors, NEIGHBOR_COSINE_FLOOR=0.30 (matches consolidator unrelatedSimilarityThreshold; raising it is a documented Phase-26 TRAP — contradictions sit ~0.48)"
  - "No episode written (D-05): curated nodes are written already-final and must never be re-extracted/mangled by the sleep pass"
  - "value_hash idempotency guard short-circuits a byte-identical live re-remember to a terse 'already stored' line before any embed/judge"
  - "No schema change — SCHEMA_VERSION stays 12; no new node column (origin=asserted_by_user + high seed + tombstoned=0 eviction-immunity is the full decay shield)"

patterns-established:
  - "Curated synchronous write CLI: follows dedup-facts-cli skeleton (validate-args-before-lock → acquireLock fast-fail → DB+stores+sink in try → db.close()+releaseLock in finally → require.main guard)"
  - "All async (embed, judge) completed before db.transaction(...).immediate() — no await inside a transaction"

requirements-completed: [REMEMBER-01, REMEMBER-02]

# Metrics
duration: 10min
completed: 2026-06-20
---

# Phase 33-01: Synchronous Curated Write (`recense remember`) Summary

**`recense remember "<fact>"` lands a verbatim curated node and runs a synchronous in-place reconsolidation (tombstone+mint on contradiction), making deliberate facts a lossless, single-path write that the engine updates rather than appends.**

## Performance

- **Duration:** ~10 min
- **Tasks:** 3/3
- **Files modified:** 3 (2 created, 1 modified)
- **Commits:** 08d9264, 9949351, bf71f16 (+ merge c479d88)

## Accomplishments

- **Task 1 — `remember-cli.ts`:** verbatim store + synchronous mini-pass. Parses the fact positional (`argv[3]`), validates the DB path before acquiring the global write lock (WR-02), then embeds the verbatim text, retrieves top-8 neighbors (cosine floor 0.30), judges contradiction, and applies inside one `.immediate()` transaction. INSERT path mints a fresh node + emits `unrelated`; CONTRADICT path tombstones the superseded node, mints a reconciled node with `prev_value`, and emits exactly one `contradict_reconcile`. Scope-stamped via `upsertNodeScope` and embedded via `setEmbedding(value_hash)` after the transaction. Prints the D-01 preview (`✓ stored [scope]` / `✓ reconsolidated [scope]  updated: "<prev>" → "<now>"`).
- **Task 2 — dispatcher:** `case 'remember': spawnScript('remember-cli.js', process.argv.slice(3))` in `recense.ts` (slice(3) to preserve the `"<fact>"` positional), and `remember` appended to the usage `Commands:` line.
- **Task 3 — tests:** 5 deterministic offline tests (stubbed judge/embed, in-memory DB): INSERT-no-neighbor, CONTRADICT→reconcile (FK-clean, one event), D-04 force-reconcile (proves routeContradiction alone returns 'hold' so the override is load-bearing), D-03 passive-resistance via the pure function, idempotent byte-identical re-insert.

## Verification

- `npx tsc --noEmit` — 0 errors mentioning remember-cli / recense.ts.
- `npx vitest run tests/remember-cli.test.ts` — 5/5 pass (447ms, offline, no `claude -p`).
- Acceptance greps confirmed: acquireLock/releaseLock + finally, require.main guard, `origin: 'asserted_by_user'`, one `contradict_reconcile`, `upsertNodeScope`, `routeContradiction`, `SEED_S=0.9`/`SEED_C=0.95`, D-04 override (`action = 'reconcile'` when 'hold'), 0 episode writes, value_hash idempotency.
- `PRAGMA foreign_key_check` empty after contradict-reconcile (asserted in Test 2).

## Deviations

- **Test file path:** placed at `tests/remember-cli.test.ts` (not `test/` as the plan stated) because `vitest.config.ts` only scans `tests/**/*.test.ts` — `test/` would not be discovered. Fixed inline (Rule 1).
- **SUMMARY reconstruction (orchestrator note):** `.planning/` is gitignored, so the executor's worktree-written SUMMARY.md was not committed and was lost on worktree removal (known #2070 + planning-dir-gitignored gotcha). This file was reconstructed by the orchestrator from the executor return and verified against the merged source/tests — content is accurate, not a stale claim.

## Notes for downstream (33-02)

- The migration must use `recense remember "<verbatim>" --scope brain-memory` as the ONLY write path (verbatim, not the lossy import-memory).
- A contradict-reconcile during migration is expected and correct (in-place update), not an error.
- Deterministic verify gate: `SELECT id, tombstoned FROM node WHERE value_hash = ? AND tombstoned = 0` using `sha256` of the SAME trimmed string `remember` stored (the CLI trims the fact).
