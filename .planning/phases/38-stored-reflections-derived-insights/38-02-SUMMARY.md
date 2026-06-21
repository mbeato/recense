---
phase: 38-stored-reflections-derived-insights
plan: "02"
subsystem: consolidation/insight-reflector
tags: [insight, reflection, sleep-pass, phase-c, derived-insights, self-confirmation, tdd]
dependency_graph:
  requires: ["38-01"]  # node_insight sidecar + upsertNodeInsight/getNodeInsight + config knobs
  provides: ["InsightReflector", "synthesizeInsightForSchema", "Phase-C-reflect-wiring"]
  affects: ["consolidator.ts", "run-sleep-pass.ts", "sleep-pass Phase C sequence"]
tech_stack:
  added: []  # net-zero new runtime deps
  patterns:
    - "Phase-A-async → Phase-B-.immediate() deriver mold (SchemaRelationDeriver analog)"
    - "NOISE_PATTERNS/isNoiseMember selection gate (CorpusPromoter verbatim copy, D-03)"
    - "Judge-tier synthesizeInsightForSchema (generateDocForSchema analog, thesis-from-cluster)"
    - "Fill-in-place regen (doc-writer stable-edge pattern, staleness-gated NOT wipe-and-rebuild)"
    - "TDD RED/GREEN: sentinel test first, implementation second"
key_files:
  created:
    - src/reader/insight-generator.ts
    - src/consolidation/insight-reflector.ts
    - tests/insight-reflector.test.ts
  modified:
    - src/consolidation/consolidator.ts
    - src/consolidation/run-sleep-pass.ts
decisions:
  - "Staleness gate departure from wipe-and-rebuild: reflector regenerates ONLY stale clusters (not all-wipe), bounded by node_insight.generated_at vs member last_access — D-03 cost control"
  - "s=0.1 (not s=0 lifecycle-exempt) for insights: decay is desired so dissolved insights eventually evict via AND-gated sweep after tombstone (D-06 'decay (s drops)')"
  - "No-citation fallback: when synthesizeInsightForSchema returns empty citedMemberIds (model did not cite), fall back to all gated members as derived_from targets — staleness dependency is still fully covered"
  - "Inline tombstoned-member query in staleness check: needed to detect when a formerly-cited member was tombstoned after generated_at (non-trivial stale case)"
metrics:
  duration_minutes: 15
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 2
  completed_date: "2026-06-21"
---

# Phase 38 Plan 02: InsightReflector Deriver + Phase C Wiring Summary

**One-liner:** offline reflection deriver that synthesizes one judge-tier `origin='inferred'` insight per qualifying stale schema cluster (Phase A async generate → Phase B `.immediate()` write), with self-confirmation proven by RED-under-injection sentinel and staleness gate verified by no-op-when-unchanged test.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | synthesizeInsightForSchema generator | e39524f | src/reader/insight-generator.ts |
| 2 (RED) | InsightReflector test suite | 6c7772c | tests/insight-reflector.test.ts |
| 2 (GREEN) | InsightReflector + Phase C wiring | 6f84632 | src/consolidation/insight-reflector.ts, consolidator.ts, run-sleep-pass.ts |

## What Was Built

### Task 1: `synthesizeInsightForSchema` (insight-generator.ts)

Judge-tier, read-only generator that mirrors `generateDocForSchema` but for short (one-line) insights:

- Thesis-from-cluster prompt: schema = generalization, members = evidence, insight = "what does X amount to" in one sentence
- `maxTokens: 256` (sentence or two, not a deep-dive)
- Throws on empty trimmed output (never persist an empty insight — mirrors doc-generator backstop)
- `verifyCitations()` pass: `citedMemberIds` are exactly the members the insight drew on (these become `derived_from` targets + staleness dependency set)
- **Read-only by construction**: zero calls to `strengthen`, `setEmbedding`, `tombstone`, `upsertNode`, `upsertEdge` — verified by source grep
- Injection guard: member values placed as DATA content, never interpolated as instructions (T-38-05)

### Task 2: `InsightReflector` + Phase C wiring (TDD RED → GREEN)

**RED (6c7772c):** Four tests written before any implementation:
1. RED-under-injection sentinel: all member s/c/tombstoned/edges byte-identical under injected payload
2. Staleness no-op: second pass over unchanged graph → `provider.generate` ZERO times
3. Regen on stale: touch a member → `generated_at` advances + generate called again
4. Tombstone on dissolution: cluster drops below `reflectMassFloorLow` → insight tombstoned

**GREEN (6f84632):** Implementation that makes all 5 tests pass:

**InsightReflector** (`src/consolidation/insight-reflector.ts`):
- Class shell mirrors `CorpusPromoter` (DI fields, prepared statements in constructor, `NoopInsightReflector`)
- Selection: `NOISE_PATTERNS`/`isNoiseMember` verbatim from corpus-promoter (D-03 same gate)
- Mass gate: `mass >= reflectMassFloorHigh` (promote) with hysteresis demotion at `< reflectMassFloorLow`
- Staleness: `member.last_access > insight.generated_at` via `derived_from` in-edge walk — staleness-gated NOT wipe-and-rebuild (key D-03 departure from deriver template)
- Phase A (async): `await synthesizeInsightForSchema()` for each stale cluster — provider.generate MUST happen here before Phase B
- Phase B (sync, `.immediate()`): upsertNode `type:'insight'`, `origin:'inferred'`, `c:reflectConfidenceCeiling`, `s:0.1`; FTS delete; `upsertNodeInsight` sidecar; `upsertEdge` `kind:'derived_from'` to schema + cited members; fill-in-place regen for existing insights
- **T-02-ASYNC verified**: zero `await` inside `db.transaction()` body

**Phase C wiring** (`consolidator.ts`):
- `insightReflector: InsightReflector | NoopInsightReflector` DI field, defaulting to `new NoopInsightReflector()`
- `await this.insightReflector.reflect()` BETWEEN `corpusPromoter.promote()` (L850) and `runEvictionSweep()` (L854)
- Ordering by line number: 850 (promote) < 853 (reflect) < 854 (eviction) ✓

**run-sleep-pass.ts wiring**:
- `new InsightReflector(db, store, inducerProvider, config, realClock, { massFloorHigh, massFloorLow, confidenceCeiling })` using judge-tier provider
- Passed as new Consolidator arg after `corpusPromoter`

## Verification Results

```
npx tsc --noEmit                              → clean (0 errors)
npx vitest run tests/insight-reflector.test.ts → 5/5 tests pass
Source gate (insight-generator.ts mutations)  → read-only OK (comments only)
await inside db.transaction()                 → 0 (T-02-ASYNC compliant)
Phase C ordering (line numbers)               → promote(850) < reflect(853) < eviction(854)
No package.json change                        → confirmed (net-zero new runtime deps)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Ambiguous column name in inline tombstoned-member query**
- **Found during:** Task 2 GREEN phase (Test 2 — staleness no-op)
- **Issue:** `SELECT MAX(last_access)` with a JOIN between `edge` and `node` — `last_access` is ambiguous since both tables have it
- **Fix:** Qualified to `MAX(n.last_access)` in the inline staleness-check query
- **Files modified:** `src/consolidation/insight-reflector.ts`
- **Commit:** 6f84632

**2. [Rule 1 - Bug] FakeClock method name (clock.advance() vs clock.advanceMs())**
- **Found during:** Test writing (pre-compilation)
- **Issue:** Initial test draft used `clock.advance()` which doesn't exist on FakeClock; correct method is `clock.advanceMs()`
- **Fix:** Corrected to `clock.advanceMs()` in test file
- **Files modified:** `tests/insight-reflector.test.ts`
- **Commit:** 6c7772c

**3. [Rule 1 - Bug] JudgeVerdict shape in stub provider**
- **Found during:** TypeScript compilation check
- **Issue:** Stub judge return type was missing `best_candidate_id`, `relation`, `magnitude`, `contradicted_ids` required by `JudgeVerdict`
- **Fix:** Added full JudgeVerdict shape to mock
- **Files modified:** `tests/insight-reflector.test.ts`
- **Commit:** 6f84632

## Known Stubs

None. All implemented functionality is wired end-to-end:
- `synthesizeInsightForSchema` returns real insight text (from judge-tier provider)
- `InsightReflector.reflect()` synthesizes, writes, and returns metrics
- Phase C wiring is live in `consolidator.ts` and `run-sleep-pass.ts`

The insight surfacing path (recall/index.ts — plan 38-04) is a separate future plan per the phase structure. Not a stub — it's out-of-scope for this plan.

## Threat Flags

No new network endpoints, auth paths, or schema changes beyond what the plan's threat model covers. All surfaces handled within T-38-04 / T-38-05 mitigations.

## Self-Check

### Checking created files exist
- `src/consolidation/insight-reflector.ts` — FOUND
- `src/reader/insight-generator.ts` — FOUND
- `tests/insight-reflector.test.ts` — FOUND
- `src/consolidation/consolidator.ts` (modified) — FOUND
- `src/consolidation/run-sleep-pass.ts` (modified) — FOUND

### Checking commits exist
- e39524f (Task 1) — FOUND
- 6c7772c (TDD RED) — FOUND
- 6f84632 (Task 2 GREEN) — FOUND

## Self-Check: PASSED
