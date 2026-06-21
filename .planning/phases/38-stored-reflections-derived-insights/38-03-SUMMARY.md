---
phase: 38-stored-reflections-derived-insights
plan: "03"
subsystem: recall
tags: [insight-surfacing, augment-with-fallback, freshness-gate, LLM-free, dark-default]
dependency_graph:
  requires: ["38-01"]
  provides: ["38-04"]
  affects: ["src/recall/index.ts"]
tech_stack:
  added: []
  patterns:
    - "augment-with-fallback (D-05): cheaper precomputed path → immediate return on hit, fall-through on miss"
    - "in-edge walk on resolved schema for derived_from insight discovery (mirrors Case-B reverse-abstracts lookup)"
    - "freshness gate: getNodeInsight(id).generated_at vs member last_access — pure read, no embedding"
    - "dark-default flag (insightSurfacingEnabled=false): zero behavior change at merge"
key_files:
  modified:
    - src/recall/index.ts
  created:
    - tests/recall-insight-surfacing.test.ts
decisions:
  - "MATCH GATE = schema-anchor resolution, not embedding: insights have NULL embedding (doc-writer pattern); getInEdges(schemaNode.id) filtered to derived_from already selects the right insight — no cueVec comparison needed"
  - "Freshness check excludes the anchor schema edge itself when walking outgoing derived_from edges (avoid spurious stale detection from the schema being the target)"
  - "On insightInference=null from compose (generate returned null/empty), fall through to neighborhood rather than returning NULL_RESULT — preserves the 'best-effort' contract"
  - "insightNeighborhood array built but marked void for lint; kept for potential future trace integration parity with the neighborhood path"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-21"
  tasks_completed: 1
  files_modified: 2
---

# Phase 38 Plan 03: Insight Surfacing in Recall Summary

## One-liner

Insight surfacing branch folded into recall after schema resolution — single precomputed insight string returned in place of the K=20 member neighborhood, LLM-free freshness-gated, zero mutations, dark-default behind `insightSurfacingEnabled`.

## What Was Built

Added an insight surfacing branch to `RecallEngine.recall()` immediately after Case-A/B schema resolution succeeds, before the neighborhood assembly loop. The branch:

1. **In-edge walk**: calls `getInEdges(schemaNode.id)` filtered to `kind='derived_from'` and `src.type='insight'` and `src.tombstoned !== 1` — finds the dependent insight anchored to the resolved schema. Mirrors the Case-B reverse-abstracts lookup shape exactly.

2. **Freshness gate**: loads `getNodeInsight(insightId)` to get `generated_at`. Walks `getOutEdges(insightId)` filtered to `kind='derived_from'`, skipping the anchor schema target. Any member that is tombstoned OR has `last_access > generated_at` marks the insight stale — identical to the reflector's own staleness predicate applied read-side.

3. **On hit (live + non-stale)**: composes from a single-member payload containing only the insight string — same prompt structure as the neighborhood path, same `provider.generate()` call, one string instead of ~K member facts. Returns immediately (D-05: one mode OR the other, never both). Logs as `origin='inferred'` episode (the only write).

4. **On miss / stale / tombstoned / flag-off**: falls through to today's unchanged neighborhood assembly.

5. **Flag gate**: the entire branch is wrapped in `if (this.config.insightSurfacingEnabled)` — with the dark default (`false`), recall is byte-identical to pre-insight behavior.

## Tests Written

`tests/recall-insight-surfacing.test.ts` — 9 tests covering 5 behaviors:

| Test | Scenario | Result |
|------|----------|--------|
| T1 | Hit — live non-stale insight on resolved schema | insight returned |
| T1b | Hit — single-member payload (not multi-member dump) | prompt contains insight text, not member facts |
| T2a | Miss — no insight exists for schema | neighborhood fallback |
| T2b | Miss — insight is tombstoned | neighborhood fallback |
| T3a | Stale-skip — member last_access > generated_at | neighborhood fallback |
| T3b | Stale-skip — member tombstoned (falsified) | not insight (NULL or neighborhood) |
| T4 | No-mutation — hit path makes zero graph mutations | node/edge counts + sidecar + s/c/tombstoned byte-identical |
| T5 | Flag-off — insightSurfacingEnabled=false | neighborhood used, insight text absent from prompt |
| T5b | Flag-off — single embed call only | embedCallCount=1 (no new embed from insight branch) |

## Acceptance Criteria — All Pass

- `grep -q "insightSurfacingEnabled" src/recall/index.ts` — PASS
- `grep -q "derived_from" src/recall/index.ts` and `getInEdges(schemaNode.id)` present — PASS
- `grep -q "getNodeInsight" src/recall/index.ts` — PASS
- No `upsertNode/upsertEdge/strengthen/tombstone` calls in recall (only in comments) — PASS
- Only one `embed(` line in recall (pre-existing query cue, line 144; no new embed in insight branch) — PASS
- `npx tsc --noEmit` — PASS (clean)
- `npx vitest run tests/recall-insight-surfacing.test.ts` — PASS (9/9 green)

## Invariants Preserved

- **LLM-free online path**: the surfacing branch adds zero new `provider.embed` / `provider.generate` calls beyond the single compose call recall already makes. The insight is selected via schema-anchor resolution (a pure DB read), not via a query→insight embedding comparison.
- **NULL-embedding contract**: insights have a NULL embedding (doc-writer pattern) — no `setEmbedding` was added for insights, and no embedding comparison against insights was introduced.
- **Zero mutations**: `strengthen`, `upsertNode`, `upsertEdge`, `tombstone` are never called in the surfacing branch. Surfacing an insight never reinforces it or its members (T-38-08 / D-43 / LEARN-02 ephemeral-as-fact guarantee).
- **No stale-insight self-confirmation**: a tombstoned member or any member with `last_access > generated_at` marks the insight stale immediately — recall falls back to the live neighborhood (T-38-07).
- **Dark default**: `insightSurfacingEnabled=false` (shipped default) means this merge is a zero-behavior-change no-op until 38-04 eval proves the compose-token win.
- **One mode OR the other**: on a surfacing hit, the function returns before the neighborhood assembly loop runs (D-05).

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The surfacing branch is pure read-side logic on existing DB primitives; it does not widen any trust boundary.

## Self-Check

**Status: PASSED**

- `src/recall/index.ts` — FOUND
- `tests/recall-insight-surfacing.test.ts` — FOUND
- `38-03-SUMMARY.md` — FOUND
- Commit `5c305b8` (RED: test) — FOUND
- Commit `a3da7db` (GREEN: implementation) — FOUND
