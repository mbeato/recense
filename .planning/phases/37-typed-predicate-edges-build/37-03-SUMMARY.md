---
phase: 37-typed-predicate-edges-build
plan: 03
subsystem: recall
tags: [typed-edges, typed-traversal, recall, D-06, D-07, D-08, landmine-fix, tdd]
dependency_graph:
  requires:
    - src/model/typed-predicates.ts (PREDICATES, PRED_SET, Predicate — Wave 0)
    - src/db/semantic-store.ts getOutEdgesWithRel (Wave 0 LANDMINE 1 fix)
    - src/lib/config.ts predicateGlossThreshold (Wave 0)
    - src/consolidation/gloss-embeddings.ts loadGlossEmbeddings (Wave 0)
  provides:
    - src/recall/typed-traversal.ts (typedReach, matchPredicate)
    - src/recall/index.ts (D-06 typed-path-OR-fallback augmentation with glossEmbeddings)
  affects:
    - Wave 3 (37-04): build harness uses typedReach + live recall for precision measurement
tech_stack:
  added: []
  patterns:
    - TDD RED/GREEN for Task 1 (typedReach + matchPredicate)
    - D-06 augment-with-fallback: typed-path OR neighborhood, never both
    - Constructor-load pattern for offline artifacts (Pitfall 4 guard)
    - Plain Float32Array dot-product loop for LLM-free 12-way cosine
key_files:
  created:
    - src/recall/typed-traversal.ts
    - tests/typed-traversal.test.ts
    - tests/recall-engine.test.ts
  modified:
    - src/recall/index.ts (D-06 branch + glossEmbeddings field + constructor load)
decisions:
  - "typedReach falls through (not returns null) when typedReach returns empty — allows neighborhood fallback even when predicate was matched but anchor had no typed edges"
  - "D-08 guard enforced by grep assertion: 0 functional upsertEdge/strengthen calls in src/recall/ (only read-only tombstoned checks present)"
  - "glossEmbeddings loaded synchronously in RecallEngine constructor via existing SemanticStore.getMeta — zero per-recall cost, zero online LLM cost"
  - "cosineSimilarity implemented inline as Float32Array loop (~12x1536 FLOPs) — no new dep, negligible latency"
metrics:
  duration: "~35 minutes"
  completed: "2026-06-21T00:10:00Z"
  tasks_completed: 2
  files_changed: 4
  tests_added: 22
---

# Phase 37 Plan 03: Wave 2 Recall Traversal Summary

One-liner: LLM-free typed-path recall (single-hop predicate cosine + typedReach) replacing the K=20 neighborhood when query maps confidently to a predicate (cosine >= 0.35), with D-08 self-confirmation guard enforced by source grep.

## What Was Built

Wave 2 of Phase 37: the online recall half of TYPED-02. No extraction or schema-neighborhood code was changed. The typed branch is additive — it fires above threshold and returns before the existing neighborhood assembly runs (D-06).

### Task 1: typedReach + matchPredicate (TDD RED/GREEN)

Created `src/recall/typed-traversal.ts` with two exports:

**typedReach(store, anchor, predicatePath, K):**
- Port of spike 004 `lib/traverse.ts:39–64` parameterized over the live `SemanticStore`
- Uses `store.getOutEdgesWithRel(node)` (LANDMINE 1 fix from Wave 0 — never the rel-less `getOutEdges`)
- LANDMINE 2 guard: `!PRED_SET.has(e.rel) || e.kind !== 'relation'` → continue — excludes `links_to`/`extends` edges that share `kind='relation'` but are not typed predicates
- Path-weight accumulation, top-K slice, stable id tiebreak — verbatim from spike
- v1: callers pass single-element predicatePath (D-07; multi-hop deferred)

**matchPredicate(cueVec, glossEmbeddings, threshold):**
- Plain `Float32Array` dot-product loop (~12×1536 FLOPs), no new dep
- Returns argmax predicate iff cosine >= threshold, else null
- Returns null when glossEmbeddings is null or empty → always falls back

15/15 typed-traversal tests passing (including links_to decoy, extends decoy, kind!=='relation' case, path-weight ranking, stable tiebreak, null-gloss, below-threshold).

### Task 2: RecallEngine D-06 augmentation

Modified `src/recall/index.ts`:

**Constructor:**
- Added `glossEmbeddings` field (`Record<Predicate, Float32Array> | null`)
- Loaded via `loadGlossEmbeddings(store)` — synchronous meta-table read, ONCE at construction (Pitfall 4: never per-recall, T-37-12 DoS guard)

**recall() method — D-06 branch inserted between bestMatch (:148) and schema resolution (:258):**
1. `matchPredicate(cueVec, this.glossEmbeddings, this.config.predicateGlossThreshold)` — reuses already-computed cueVec (LANDMINE 3: no new online embed)
2. If non-null predicate: `typedReach(this.store, bestMatch.id, [predicate], recallNeighborhoodBudget)`
3. Resolve frontier node values, compose labeled-triple prompt, generate inference
4. Append as `origin='inferred'` episode (D-43) — **the only write in this branch**
5. Return before neighborhood assembly — D-06: typed path OR neighborhood, never both
6. If typedReach returns empty → fall through to neighborhood (not null)
7. If matchPredicate returns null → skip block entirely, neighborhood runs unchanged

**D-08 self-confirmation guard (T-37-09):**
- 0 functional `upsertEdge`/`upsertNode`/`strengthen`/`tombstone()` calls in `src/recall/`
- Only read-only `.tombstoned === 1` checks present (not the tombstone() write method)
- Verified by source grep assertion

7/7 recall-engine tests passing (TYPED-02c above-threshold, TYPED-02d below-threshold/null-gloss, TYPED-02e node+edge count invariant, Pitfall 4 embed-call count).

## Commits

| Hash | Message |
|------|---------|
| `0499efb` | test(37-03): add failing tests for typedReach + matchPredicate |
| `032e3cf` | feat(37-03): port typedReach + matchPredicate (TYPED-02 traversal module) |
| `4ee1c4d` | feat(37-03): augment RecallEngine with D-06 typed-path-OR-fallback branch (TYPED-02) |

## Verification Results

| Check | Result |
|-------|--------|
| `npm test -- --run typed-traversal` | 15/15 PASS |
| `npm test -- --run recall-engine` | 7/7 PASS |
| `npm test -- --run` (full suite) | 1982 PASS / 3 skip / 0 fail |
| `npm run build` | PASS (tsc clean) |
| `grep -c "getOutEdgesWithRel" src/recall/typed-traversal.ts` | 5 (>= 1) |
| `grep -c "getOutEdges(" src/recall/typed-traversal.ts` (rel-less) | 0 (confirmed absent) |
| `grep -c "PRED_SET.has\|kind !== 'relation'" src/recall/typed-traversal.ts` | 4 (>= 1, LANDMINE 2 present) |
| `grep -rn 'upsertEdge\|strengthen' src/recall/` functional hits | 0 (D-08 intact) |
| `grep -c "matchPredicate" src/recall/index.ts` | 5 (>= 1) |
| `grep -c "predicateGlossThreshold" src/recall/index.ts` | 2 (>= 1) |
| `grep -c "loadGlossEmbeddings" src/recall/index.ts` — constructor only | 1 call in ctor (line 116) |

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written. One test logic error was caught and fixed before committing (the "below threshold" matchPredicate test had an incorrect normalization assumption — fixed to use an orthogonal cueVec at dim 12 against a 12-dim gloss set, where all cosines are 0).

## Known Stubs

None. All exported symbols are fully implemented:
- `typedReach` — complete single-hop traversal with LANDMINE 1+2 guards
- `matchPredicate` — complete 12-way cosine with null-safety
- RecallEngine D-06 branch — complete typed-path-OR-fallback
- glossEmbeddings constructor load — complete

## Threat Flags

No new threat surface beyond what the plan's threat model documents.

| Threat | Mitigation | Status |
|--------|-----------|--------|
| T-37-09 (self-confirmation via typed path) | 0 functional upsertEdge/strengthen in src/recall/ | MITIGATED |
| T-37-10 (links_to/extends as typed predicates) | PRED_SET.has(e.rel) && kind==='relation' filter in typedReach | MITIGATED |
| T-37-12 (re-embedding 12 glosses per recall) | loadGlossEmbeddings called once in constructor | MITIGATED |
| T-37-13 (path + neighborhood both returned) | D-06: return before neighborhood assembly | MITIGATED |

## Self-Check: PASSED

- `src/recall/typed-traversal.ts` — EXISTS
- `tests/typed-traversal.test.ts` — EXISTS
- `tests/recall-engine.test.ts` — EXISTS
- `src/recall/index.ts` — MODIFIED (D-06 branch present, loadGlossEmbeddings in constructor)
- Commits 0499efb, 032e3cf, 4ee1c4d — VERIFIED in git log
