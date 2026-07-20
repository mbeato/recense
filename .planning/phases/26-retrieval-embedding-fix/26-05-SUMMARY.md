---
phase: 26-retrieval-embedding-fix
plan: "05"
subsystem: eval
tags: [eval, replay, ku-harness, judge-engagement, retr-02]
dependency_graph:
  requires: []
  provides: [scripts/eval/replay-ku-harness.cjs]
  affects: [26-07]
tech_stack:
  added: []
  patterns: [scratch-tmpdir-db, replayExtract-seam, runConsolidation, retrieveRanked]
key_files:
  created:
    - scripts/eval/replay-ku-harness.cjs
  modified: []
decisions:
  - "Ingest each cached claim value as its own episode (content=value); replayExtract returns [{type:'fact',value:content}] per episode — avoids granite, embed+judge still run for real"
  - "Duplicate-mints measured as 'unrelated' events in consolidation_event (claim routed to fresh node despite possible same-belief candidate)"
  - "Join n20-attribution.jsonl (18 cases) ∩ eval20-ku.jsonl (20 cases) on question_id → 18 KU cases processed"
  - "Scorer uses same anthropicClient/haiku as answer-gen to keep cost minimal; GPT-4o scorer wiring can be swapped for real scoring in 26-07"
metrics:
  duration_minutes: 8
  completed_date: "2026-06-18"
  tasks_completed: 1
  tasks_total: 1
  files_created: 1
  files_modified: 0
---

# Phase 26 Plan 05: Extraction-Replay KU Harness Summary

**One-liner:** Replay harness that re-runs embed→consolidate→retrieve→score on 18 KU cases using cached granite claims (35k), capturing tombstones + contradict-verdicts + duplicate-mints so RETR-02's "dup-minting reduced AND EVAL-02 not below 84.6%" gate is measurable.

## What Was Built

`scripts/eval/replay-ku-harness.cjs` — the RETR-02 validation tool specified in Plan 26-05.

Reads `~/.recense-eval-cache/eval01-n20-2026-06-16/n20-attribution.jsonl` (18 KU cases, ~35,443 cached claims from prior granite extraction) and `eval20-ku.jsonl` (20 KU cases with gold answers). For each joined case:

1. Ingests each claim value as its own episode via `EpisodicStore.append`.
2. Calls `runConsolidation` with a `replayExtract` seam that intercepts the `generate` head and returns `[{type:'fact', value: content}]` per episode — no granite/Ollama call, embed+judge run for real.
3. Queries judge-engagement: tombstones (nodes with `tombstoned=1`), contradict-verdicts (any `contradict_*` event in `consolidation_event`), and duplicate-mints (`unrelated` events — claims routed to fresh nodes despite potentially having same-belief candidates).
4. Embeds the KU question via `RetrievalEngine.retrieveRanked` (product memory_ask path, not raw retrieve()).
5. Generates answer with Haiku; scores KU correctness with a lightweight autoeval.

`--dry-run`: steps 1 only (ingest + scratch DB), zero API/LLM calls, exits 0.

## Verification

```
npm run build && node scripts/eval/replay-ku-harness.cjs --dry-run --out /tmp/replay-ku-dry.json
```

Exits 0. 18 cases validated, 35,443 total claims, `/tmp/replay-ku-dry.json` written.

All acceptance criteria pass:
- `grep -Ec "os\.tmpdir|tmpdir"` = 2 (>= 1) ✓
- `grep -c "RECENSE_DB"` = 0 ✓
- `grep -c "retrieveRanked"` = 3 (>= 1) ✓
- tombstone / contradict / duplicate-mint signals present ✓
- `grep -Ec "openaiEmbedModel|DEFAULT_CONFIG"` = 8 (>= 1) ✓
- `grep -c -- "--embed-model"` = 0 ✓
- `git diff --name-only src/` = pre-existing changes only (harness touches no src/) ✓

## Deviations from Plan

None — plan executed exactly as written.

The build has two pre-existing TS errors (`src/consolidation/fact-dedup.ts` + `tests/import-memory.test.ts`) that existed before this plan. TypeScript still emits dist (no `noEmitOnError`). These are out of scope.

## Threat Flags

None. All boundaries from the plan's threat register were honored:
- T-26-03: keys env-only, not written to results JSON.
- T-26-04: scratch DBs under `os.tmpdir()`, live DB path never read.
- T-26-07: only `--dry-run` executed in this plan (no judge billing).
- T-26-SC: no new npm installs.

## Self-Check: PASSED

- `scripts/eval/replay-ku-harness.cjs` — FOUND
- commit `e229708` — FOUND
