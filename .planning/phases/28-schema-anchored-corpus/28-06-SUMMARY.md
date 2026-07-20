---
phase: 28
plan: "06"
subsystem: consolidation
tags: [corpus, offline-generation, sleep-pass, cli]
dependency-graph:
  requires: [28-04]
  provides: [CORPUS-06]
  affects: [run-sleep-pass, generate-doc-cli, generate-corpus-cli]
tech-stack:
  added: []
  patterns:
    - computeSchemaCentroid extracted from inline to doc-gather.ts (D-37 gate, Pitfall-5 decode)
    - generateCorpusDocs per-doc try/catch failure isolation with deferred cap
    - sleep-pass env-gated extension pattern (RECENSE_CORPUS_GEN / RECENSE_CORPUS_GEN_MAX)
key-files:
  created:
    - src/consolidation/corpus-generator.ts
    - src/adapter/generate-corpus-cli.ts
    - tests/corpus-generator.test.ts
  modified:
    - src/reader/doc-gather.ts (added computeSchemaCentroid)
    - src/adapter/generate-doc-cli.ts (use computeSchemaCentroid helper, remove inline copy)
    - src/consolidation/run-sleep-pass.ts (wire generateCorpusDocs after consolidate())
    - src/adapter/recense.ts (register generate-corpus subcommand)
decisions:
  - "Use inducerProvider (generateConfig=judgeConfig) in the sleep pass — already the correct judge-tier slot; no new provider object needed"
  - "now parameter passed from caller's clock rather than Date.now() inside generateCorpusDocs (D-12)"
  - "Best-effort wrapper in run-sleep-pass: corpus generation failure never aborts the sleep pass (consolidation already committed)"
  - "deferred count is always logged even when 0 (no silent truncation)"
metrics:
  duration: "~30 minutes"
  completed: "2026-06-19"
  tasks_completed: 7
  files_changed: 7
---

# Phase 28 Plan 06: CORPUS-06 Eager Offline Corpus-Doc Generation Summary

Moves schema-anchored corpus doc prose generation OFFLINE into the sleep pass so every promoted schema's deep-dive is ready before any user clicks it — eliminating the ~42s headless LLM call on the online path. The lazy-on-click path (generate-doc-cli) stays as the fallback for any stub the sleep pass hasn't reached.

## What Was Built

**computeSchemaCentroid helper** — extracted from the inline copy in `generate-doc-cli.ts` into `src/reader/doc-gather.ts`. Applies the D-37 gate (tombstoned=0, origin!='inferred', type IN ('fact','entity'), embedding NOT NULL) and Pitfall-5 Float32Array byteOffset decode. Now the single canonical definition; both the CLI and the new generator call it.

**generateCorpusDocs** (`src/consolidation/corpus-generator.ts`) — batch function that queries live empty schema doc stubs and fills each with prose via `generateDocForSchema`. Idempotent (empty-only), per-doc failure isolated (try/catch per stub, continues on throw), maxDocs-capped with logged deferred count, no internal lock management. Returns `{ generated, failed, deferred }` tally.

**Sleep-pass wiring** (`run-sleep-pass.ts`) — `generateCorpusDocs` is called after `consolidator.consolidate()` returns while the sleep pass still holds its lock. This is the right ordering: CorpusPromoter runs inside Phase C of consolidation and creates the empty stubs; corpus generation runs immediately after to fill them. Env-gated: `RECENSE_CORPUS_GEN=0` disables, `RECENSE_CORPUS_GEN_MAX` sets the per-pass cap (default 25). Failure is best-effort: an unexpected throw logs and continues (consolidation already completed).

**generate-corpus CLI** (`src/adapter/generate-corpus-cli.ts`) — manual lock-guarded entry point mirroring the promote-corpus pattern. Validates dbPath before acquiring lock (WR-02), builds judge-tier DefaultModelProvider (generateConfig=judgeConfig, D-04), calls generateCorpusDocs, emits JSON tally. Supports `--db` and `--max <n>`. Registered as `recense generate-corpus` in recense.ts dispatch.

**Tests** (`tests/corpus-generator.test.ts`) — 9 tests passing:
- Fill empty stub, skip non-empty (idempotency)
- Fill-in-place stable id + doc_containment edge still resolves (non-dangling) + FK clean
- Per-doc failure isolation (generated/failed tally correct; other stubs unaffected)
- maxDocs cap respected (deferred count and log line correct)
- computeSchemaCentroid: null for no members, null for inferred-only, correct mean for 2 embeddings, tombstoned exclusion

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints or auth paths introduced. `generateCorpusDocs` is write-only to existing `type='doc'` nodes via `writeDoc` (same path as the lazy CLI); source schemas are never mutated (D-43 self-confirmation guard inherited from `generateDocForSchema`).

## Self-Check: PASSED

- `/Users/vtx/brain-memory/src/consolidation/corpus-generator.ts` — exists
- `/Users/vtx/brain-memory/src/adapter/generate-corpus-cli.ts` — exists
- `/Users/vtx/brain-memory/tests/corpus-generator.test.ts` — exists
- Commit 4bce161 — exists (verified via `git log`)
- `npx tsc --noEmit` — clean (0 errors)
- 9/9 corpus-generator tests passing
- 58/58 adjacent tests (doc-writer, doc-generator, corpus-promoter) still green
- No `npm run build` / dist emit performed
