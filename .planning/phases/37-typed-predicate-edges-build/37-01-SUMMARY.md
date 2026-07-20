---
phase: 37-typed-predicate-edges-build
plan: 01
subsystem: typed-predicates
tags: [typed-edges, vocab, config, embedding, landmine-fix, tdd]
dependency_graph:
  requires: []
  provides:
    - src/model/typed-predicates.ts (PREDICATES, PRED_SET, Triple, parseTriples, PREDICATE_GLOSSES)
    - src/db/semantic-store.ts (getOutEdgesWithRel)
    - src/lib/config.ts (predicateGlossThreshold)
    - src/consolidation/gloss-embeddings.ts (embedAndStoreGlosses, loadGlossEmbeddings)
  affects:
    - Wave 1 (37-02): extraction fold imports PREDICATE_GLOSSES, parseTriples
    - Wave 2 (37-03): recall traversal uses getOutEdgesWithRel, loadGlossEmbeddings, predicateGlossThreshold
tech_stack:
  added: []
  patterns:
    - TDD RED/GREEN for Task 1 (typed-predicates) and Task 2 (semantic-store)
    - Dark-default config pattern (rankStrengthWeight) used for predicateGlossThreshold at 0.35
    - Meta-table JSON storage for 12 gloss embeddings (base64 Float32Array per predicate)
key_files:
  created:
    - src/model/typed-predicates.ts
    - src/consolidation/gloss-embeddings.ts
    - tests/typed-predicates.test.ts
    - tests/semantic-store.test.ts
  modified:
    - src/db/semantic-store.ts (added stmtGetOutEdgesWithRel + getOutEdgesWithRel)
    - src/lib/config.ts (added predicateGlossThreshold interface field + DEFAULT_CONFIG value)
decisions:
  - "PREDICATE_GLOSSES defined as natural-language question-form strings (CONTEXT.md §specifics), not bare predicate tokens"
  - "predicateGlossThreshold ships at 0.35 not 0 (unlike rankStrengthWeight dark-default) — a 0 default would never trigger typed-path mode"
  - "gloss-embeddings.ts uses meta table JSON storage (RESEARCH Open Question 1 recommendation) over sidecar .bin"
metrics:
  duration: "~25 minutes"
  completed: "2026-06-21T03:56:00Z"
  tasks_completed: 3
  files_changed: 6
  tests_added: 29
---

# Phase 37 Plan 01: Wave 0 Primitives Summary

One-liner: Closed 12-predicate vocab module + LANDMINE 1 fix (getOutEdgesWithRel) + predicateGlossThreshold=0.35 config + offline gloss embed/load helpers via meta table.

## What Was Built

Wave 0 primitives that unblock all downstream Phase 37 plans. No extraction or recall behavior changed — this is the foundation only.

### Task 1: Predicate vocab module + glosses + parseTriples (TDD)

Created `src/model/typed-predicates.ts` porting `PREDICATES`, `PRED_SET`, `Triple`, and `parseTriples` verbatim from spike 004 `lib/vocab.ts`, with two additions:

- **PREDICATE_GLOSSES**: 12 natural-language question-form gloss strings per predicate (D-07) — phrased as "who created or built this", "where is this located or stored / what repo or dir", etc. Embedded ONCE at sleep, cosine-matched LLM-free at recall.
- **Self-referential guard**: `s === obj` drop in parseTriples (T-37-02, V5 addition beyond spike) — stops self-loops from LLM extraction artifacts.

Threat mitigations in place: T-37-01 (PRED_SET.has vocab filter), T-37-02 (s===obj guard), T-37-03 (safe [] fallback, never throws).

### Task 2: getOutEdgesWithRel (LANDMINE 1 fix, TDD)

Added `stmtGetOutEdgesWithRel` prepared statement and `getOutEdgesWithRel(nodeId)` public method to `SemanticStore`. The existing `getOutEdges` omits `rel` from its SQL — predicate-filtered traversal using it would silently drop all edges. This fix is a hard prerequisite for Wave 2 typed-path recall.

Added Pitfall 1 lint hint on `getOutEdges` doc-comment directing typed-traversal callers to `getOutEdgesWithRel`. Added LANDMINE 2 callout in `getOutEdgesWithRel` docstring (callers must also filter by `PRED_SET.has(edge.rel)` to exclude `links_to`/`extends` edges).

### Task 3: predicateGlossThreshold config + offline gloss-embedding store

- `src/lib/config.ts`: added `predicateGlossThreshold: number` to `EngineConfig` interface (with D-07 calibration note) and `predicateGlossThreshold: 0.35` to `DEFAULT_CONFIG` (rationale: follows `rankedRetrievalFloor` calibration from Phase 17; ships at 0.35 not 0 to avoid silent dark-mode behavior).
- `src/consolidation/gloss-embeddings.ts`: `embedAndStoreGlosses(provider, store)` embeds the 12 `PREDICATE_GLOSSES` via `ModelProvider.embed` in a single batch call (offline/sleep only — Pitfall 4 guard), serializes each Float32Array as base64, stores JSON under meta key `predicate_gloss_embeddings`. `loadGlossEmbeddings(store)` reads and deserializes to `Record<Predicate, Float32Array>` (or null if not yet embedded).

## Commits

| Hash | Message |
|------|---------|
| `f9437ce` | test(37-01): add failing tests for typed predicate vocab module |
| `792f7f7` | feat(37-01): port predicate vocab module + glosses + parseTriples |
| `28fcb32` | test(37-01): add failing test for getOutEdgesWithRel on SemanticStore |
| `0793cb4` | feat(37-01): add getOutEdgesWithRel to SemanticStore (LANDMINE 1 fix) |
| `f29d7f0` | feat(37-01): predicateGlossThreshold config + offline gloss-embedding store |

## Verification Results

| Check | Result |
|-------|--------|
| `npm test -- --run typed-predicates` | 23/23 tests PASS |
| `npm test -- --run semantic-store` | 6/6 tests PASS |
| `npm run build` | PASS (tsc clean) |
| `grep -c "'built_by'\|'configured_with'" src/model/typed-predicates.ts` | 2 |
| `grep -c "SELECT dst, rel, w, kind FROM edge WHERE src = ?" src/db/semantic-store.ts` | 1 |
| `grep -c "predicateGlossThreshold" src/lib/config.ts` | 2 (interface + default) |
| `DEFAULT_CONFIG.predicateGlossThreshold` | 0.35 |
| `grep -c "predicate_gloss_embeddings" src/consolidation/gloss-embeddings.ts` | 2 |
| `TYPED_EXTRACTION_PROMPT` not in typed-predicates.ts non-comment lines | 0 (confirmed) |

## Deviations from Plan

None — plan executed exactly as written. The TDD pattern (RED commit, then GREEN commit) was followed for Tasks 1 and 2.

## Known Stubs

None. All exported symbols are fully implemented:
- `PREDICATES` (12-element tuple, complete)
- `PRED_SET` (derived, complete)
- `parseTriples` (full implementation with both guards)
- `PREDICATE_GLOSSES` (all 12 entries, complete)
- `getOutEdgesWithRel` (prepared statement + public method, complete)
- `predicateGlossThreshold` (interface field + default value, complete)
- `embedAndStoreGlosses` / `loadGlossEmbeddings` (complete — awaits live provider/DB call from sleep pass)

## Threat Flags

No new threat surface beyond what the plan's threat model documents. All T-37-01/02/03/04 mitigations are in place.

## Self-Check: PASSED

- `src/model/typed-predicates.ts` — EXISTS
- `src/consolidation/gloss-embeddings.ts` — EXISTS
- `tests/typed-predicates.test.ts` — EXISTS
- `tests/semantic-store.test.ts` — EXISTS
- `src/db/semantic-store.ts` — MODIFIED (getOutEdgesWithRel present)
- `src/lib/config.ts` — MODIFIED (predicateGlossThreshold present)
- Commits f9437ce, 792f7f7, 28fcb32, 0793cb4, f29d7f0 — VERIFIED in git log
