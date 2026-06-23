---
phase: 40-competitive-benchmark-baseline
plan: 02
subsystem: eval
tags: [benchmark, locomo, harness, retrieval-latency, r-at-k, wave-2]
dependency_graph:
  requires:
    - scripts/eval/fixtures/locomo-mini.json (40-01)
    - tests/locomo-harness.test.ts (40-01 scaffolds)
    - scripts/eval/locomo10.json (40-01 gitignored dataset)
  provides:
    - scripts/eval/locomo-harness.cjs
    - tests/locomo-harness.test.ts (un-skipped)
  affects:
    - scripts/eval/results/ (output from full run)
tech_stack:
  added: []
  patterns:
    - Clone-and-adapt of longmemeval-harness.cjs (outer conversation loop vs inner question loop)
    - Retrieval-only latency: Date.now() wraps only the topk() call (D-06a)
    - R@K session-hit via [Session N] tag in episode content + consolidation_event→episode join
    - --run gate prevents autonomous executor from triggering paid full run (T-40-03)
key_files:
  created:
    - scripts/eval/locomo-harness.cjs
  modified:
    - tests/locomo-harness.test.ts
decisions:
  - "formatSession uses {speaker} field not {name} — corrected per 40-01 schema deviation"
  - "extractSessions handles both nested (raw locomo10.json) and flat (locomo-mini.json fixture) shapes"
  - "consolidate ONCE per conversation after all session appends — not per QA pair (Pitfall 4)"
  - "R@K hit: consolidation_event→episode JOIN recovers [Session N] tag for each top-K node"
  - "separate hit5/hit10 computed over top-5 and top-10 node subsets respectively"
  - "PROBE_LIMIT=1 (one full conversation, all its QA pairs) — not 10 individual questions"
  - "runBoundedPool concurrency=1 — consolidation is CPU+LLM-bound per conversation"
metrics:
  duration: "~8 minutes"
  completed: "2026-06-23"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 1
requirements: [BENCH-01, BENCH-02]
---

# Phase 40 Plan 02: LoCoMo Harness — Ingest, Consolidate-Once, Retrieve, R@K

End-to-end LoCoMo harness cloned from longmemeval-harness.cjs: loads a 10-conversation JSON array, ingests one tagged episode per session, consolidates ONCE per conversation, loops non-adversarial QA pairs with retrieval-only latency timing and session-level R@K hit computation.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Harness skeleton — loader, ingest, consolidate-once, gates | `720463c` | `scripts/eval/locomo-harness.cjs` |
| 2 | QA loop — category-5 skip, retrieval-only latency, R@K hit, answer gen | `720463c` | `scripts/eval/locomo-harness.cjs` |
| 3 | Un-skip harness smoke + guard tests (TDD GREEN) | `f651cbf` | `tests/locomo-harness.test.ts` |

Note: Tasks 1 and 2 were implemented together in a single commit since the QA loop is structurally integral to the per-conversation pipeline.

## Key Implementation Details

### Schema Deviation Honoured (from 40-01)

The harness implements the **actual** locomo10.json schema (not RESEARCH's inaccurate description):
- Turn field: `{speaker, dia_id, text}` (not `{name, dia_id, text}`)
- Sessions nested under `conv.conversation.session_N` in raw data; `extractSessions()` handles both raw and flat (fixture) shapes

### Loop Structure (Inverted from LME)

LongMemEval: 500 independent questions, each with its own sessions and consolidation.
LoCoMo: 10 conversations → per-conversation: append N sessions → consolidate ONCE → loop ~200 QA pairs.

```
for each conversation (outer, fresh scratch DB):
  for each session_N: episodes.append([Session N] tagged content)
  runConsolidation(once)
  for each qa (inner, skip category 5):
    embed(question)  → embed_ms
    topk(queryVec)   → retrieval_ms (retrieval-only)
    hit5/hit10       → consolidation_event→episode join, [Session N] match
    answer gen       → answer_ms (outside --dry-run)
  cleanup scratch DB
```

### R@K Session-Level Hit (Option A)

```
hitSessions = Set(qa.evidence.map(e => parseInt(e.split(':')[0].replace('D','')) - 1))
For top-5 node IDs: JOIN consolidation_event → episode, extract [Session N] prefix → 0-based idx
hit5 = any retrieved session idx ∈ hitSessions
hit10 = same over top-10 node IDs
```

### Gate Structure (T-40-03)

```
--dry-run  → zero API, validates parsing + episode append, exits 0 (CI-safe)
--probe    → one conversation, reports cost + session count, exits 0
--run      → full 10-conversation paid run (explicit flag required)
no flag    → prints usage, exits 1 (autonomous executor cannot trigger paid run)
```

## Test Results

```
Test Files  1 passed (1)
     Tests  6 passed | 1 skipped (7)
```

Active tests:
1. locomo-mini.json schema validation (from 40-01)
2. R@K session-hit predicate math (from 40-01)
3. **NEW** harness --dry-run smoke: exits 0, 4 result lines (cat5 excluded)
4. **NEW** no-flag guard: exits non-zero (T-40-03)
5. **NEW** structural pin: category-5 skip in source
6. **NEW** structural pin: [Session N] tag in formatSession

Skipped: locomo10.json full schema (conditional on dataset presence — gitignored)

## Artifact Sizes

| Artifact | Lines | Min Required |
|----------|-------|-------------|
| scripts/eval/locomo-harness.cjs | 612 | 250 |

## Deviations from Plan

### Implementation Consolidation (Tasks 1 + 2 in one commit)

- **Found during:** Task 2 planning
- **Issue:** The QA loop (Task 2) is structurally tied to the per-conversation pipeline (Task 1) — separating them would have created a non-runnable intermediate state.
- **Fix:** Implemented both tasks as a complete harness in one commit. All Task 1 and Task 2 done criteria were verified separately before committing.
- **Files modified:** `scripts/eval/locomo-harness.cjs`
- **Commit:** `720463c`

## Known Stubs

None — the harness is complete for its defined scope. The full run (`--run`) requires OPENAI_API_KEY + ANTHROPIC_API_KEY (or headless transport) and is gated behind an explicit flag. Plan 40-05 owns the official full run.

## Threat Flags

None — all T-40-03/04/05 mitigations implemented as planned:
- T-40-03 (--run gate): harness refuses unguarded full run
- T-40-04 (scratch DB isolation): makeScratchDb() creates fresh tmpdir DB per conversation
- T-40-05 (dry-run zero LLM): IS_DRY_RUN skips all LLM calls; test 3 verifies

## Self-Check: PASSED

- [x] `scripts/eval/locomo-harness.cjs` exists (612 lines, > 250 min)
- [x] `--dry-run --eval scripts/eval/fixtures/locomo-mini.json` exits 0 (zero API)
- [x] `node scripts/eval/locomo-harness.cjs` (no flags) exits non-zero
- [x] Source contains `runConsolidation`, `parseLoCoMo`, `category !== 5`, `retrieval_ms`, `hit5`, `evidence`, `[Session `
- [x] `npx vitest run tests/locomo-harness.test.ts` → 6 passed, 1 skipped
- [x] Commits verified: `720463c`, `f651cbf`
