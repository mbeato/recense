---
phase: 32-project-recall-auto-corpus
plan: "03"
subsystem: corpus-trigger
tags: [corpus, pending-marker, ingest-trigger, sleep-pass, tdd, recall-02]
dependency_graph:
  requires:
    - 32-02 (CorpusPromoter.promoteScope + generateCorpusDocs landing-doc path)
    - 31-02 (SemanticStore cursor skip-gate + ingest-project deferred/consolidate paths)
  provides:
    - writeCorpusPendingMarker — exported helper that writes pending-corpus-promotion:<scope> marker
    - consumePendingCorpusMarkers — exported helper that consumes markers in the sleep pass
    - SemanticStore.deleteMeta(key) — crash-safe marker clear primitive
    - Inline --consolidate: promoteScope + generateCorpusDocs called after runConsolidation under the held lock
    - Deferred default path: pending-corpus-promotion:<scope> marker written before return
    - Sleep pass: marker-consume step before generateCorpusDocs (same-pass stub fill)
  affects:
    - Task 3 (live SC2 verification on /Users/vtx/usage — pending human gate)
tech_stack:
  added: []
  patterns:
    - TDD RED/GREEN (test first, then implement)
    - Crash-safe marker protocol (write before return; clear only after success)
    - Best-effort per-marker try/catch (failure logs + retries next pass)
    - T-01-SQL (bound LIKE literal for marker scan — no string interpolation)
    - T-32-MARK (crash-safety: marker survives a throwing promoteScope)
    - T-32-LOCK (inline corpus runs under the already-held lock — no second acquireLock)
key_files:
  created:
    - tests/ingest-project-corpus-trigger.test.ts
  modified:
    - src/adapter/ingest-project-cli.ts
    - src/consolidation/run-sleep-pass.ts
    - src/db/semantic-store.ts
decisions:
  - "deleteMeta chosen over setMeta(key,'') for clean 'consumed' semantics — a missing row is unambiguous vs an empty string value"
  - "consumePendingCorpusMarkers exported from run-sleep-pass.ts (where all corpus machinery lives) rather than ingest-project-cli.ts, so tests can import independently of the CLI"
  - "Inline --consolidate corpus step is best-effort (try/catch): a generation failure must not fail a successfully completed consolidation — mirror of the sleep pass's own corpus posture"
  - "The pending marker is ALWAYS (re)written on the deferred path regardless of surveySkipped — idempotent (promoteScope reuses stubs), ensures the corpus exists even for unchanged-project re-ingests"
metrics:
  duration: ~18 minutes
  completed: "2026-06-20"
  tasks_completed: 2
  tasks_total: 3
  files_created: 1
  files_modified: 3
---

# Phase 32 Plan 03: Corpus Trigger Wiring (RECALL-02) Summary

Crash-safe pending-corpus-promotion marker protocol + inline promote+generate on --consolidate — wires the D-03/D-05 trigger paths so `recense ingest-project` auto-promotes and generates the project corpus without any manual `recense generate-doc` step.

## What Was Built

**Task 1: `writeCorpusPendingMarker` + inline --consolidate corpus step (RED: 210ad5b, GREEN: 93f0494)**

Deferred default path (lines ~880-895 of `ingest-project-cli.ts`):
- `writeCorpusPendingMarker(store, scope, fingerprint)` exported from `ingest-project-cli.ts`
- Calls `store.setMeta('pending-corpus-promotion:<scope>', fingerprint)` after cursor commit + episode feed
- The fingerprint is already computed — re-ingest overwrites the same key idempotently
- NOT called on dry-run (returns early) or on the --consolidate path (done inline)
- Stdout updated to note the corpus will be auto-promoted on the next sleep pass

Inline --consolidate path (lines ~765-810 of `ingest-project-cli.ts`):
- After `await runConsolidation(db, dbPath, process.env, fileLog)`, under the ALREADY-HELD lock:
- Constructs a `CorpusPromoter` with the live params (mirrors `run-sleep-pass.ts` lines 354-361)
- Constructs a `DefaultModelProvider` with judge-tier config (mirrors `generate-doc-cli.ts:133-139`)
- `await inlinePromoter.promoteScope(scope)` — landing + chapter stubs created
- `await generateCorpusDocs({db, store: semanticStore, provider}, {maxDocs, log, now})` gated on `RECENSE_CORPUS_GEN !== '0'`
- Entire corpus step in a best-effort try/catch (T-32-LOCK: no second acquireLock)
- Does NOT write a pending marker (work is done inline)

`SemanticStore.deleteMeta(key)` added:
- New `stmtDeleteMeta` prepared statement: `DELETE FROM meta WHERE key = ?` (T-01-SQL)
- New `deleteMeta(key: string): void` public method with JSDoc explaining crash-safe clear semantics

Imports added to `ingest-project-cli.ts`:
- `CorpusPromoter` from `../consolidation/corpus-promoter`
- `generateCorpusDocs` from `../consolidation/corpus-generator`
- `DefaultModelProvider` from `../model/provider`

**Task 2: `consumePendingCorpusMarkers` + sleep-pass wiring (also in GREEN: 1ff4afb)**

`consumePendingCorpusMarkers` exported from `run-sleep-pass.ts`:
- T-01-SQL scan: `db.prepare("SELECT key FROM meta WHERE key LIKE 'pending-corpus-promotion:%'").all()`
- Per-marker: parse scope = `key.slice('pending-corpus-promotion:'.length)`
- Per-marker: `await promoter.promoteScope(scope)` — landing + chapter stubs
- CRASH-SAFE ORDER (T-32-MARK): `store.deleteMeta(key)` called ONLY after successful promoteScope
- On throw: log + LEAVE marker intact so the next pass retries (idempotent)
- Per-marker best-effort try/catch: one scope failure does not abort others

Wired into `runSleepPass` (lines ~462-473 of `run-sleep-pass.ts`):
- Added BEFORE the existing `generateCorpusDocs` call
- Gated on `env['RECENSE_CORPUS_GEN'] !== '0'` (shares the corpus-disable switch)
- Uses the `corpusPromoter` instance already constructed above (lines 354-361, same params)
- Outer try/catch as a safety net (inner per-marker catches handle the real errors)

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 210ad5b | test(32-03) | Add failing tests for ingest-project corpus trigger + sleep-pass marker-consume (RED) |
| 93f0494 | feat(32-03) | Wire writeCorpusPendingMarker into deferred path + inline corpus promote on --consolidate |
| 1ff4afb | feat(32-03) | Add consumePendingCorpusMarkers + wire into sleep pass before generateCorpusDocs |

## TDD Gate Compliance

RED/GREEN cycle followed for both tasks (interleaved — Task 1 and Task 2 tests were committed together in the RED commit, then GREEN implementations added):

1. RED commit (210ad5b): 9 tests written, 6 failing (writeCorpusPendingMarker + consumePendingCorpusMarkers not yet exported), 3 passing (trivial no-op/null-check behaviors)
2. Task 1 GREEN (93f0494): writeCorpusPendingMarker exported + deferred/inline paths wired → 5/9 passing
3. Task 2 GREEN (1ff4afb): consumePendingCorpusMarkers exported + sleep-pass wired → 9/9 passing

## Verification

- `npx vitest run tests/ingest-project-corpus-trigger.test.ts tests/ingest-project-cli.test.ts tests/ingest-project-reingest.test.ts` — 58/58 green
- `npx tsc --noEmit` — clean
- Task 3 (live SC2 verification on /Users/vtx/usage) — awaiting founder human-verify gate

## Deviations from Plan

None — plan executed exactly as written.

The plan noted "add `deleteMeta(key)` if chosen vs `setMeta(key, '')` — chosen: `deleteMeta` for clean consumed semantics (null unambiguous vs empty string). Documented as a key decision.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns. All writes are DB-local (meta table key/value rows + type='doc' nodes + doc→doc edges). T-32-MARK and T-32-LOCK mitigations verified by source read and test coverage.

| Flag | File | Description |
|------|------|-------------|
| None | — | No new trust-boundary surface introduced |

## Known Stubs

None. The corpus stubs created by `promoteScope` are intentionally empty (prose filled by `generateCorpusDocs` in the same or next pass). This is by design — the stubs are the scaffolding for the prose generation step, not content holes.

## Self-Check

PASSED — verified below.
