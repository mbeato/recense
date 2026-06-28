---
phase: 46-reconsolidation-candidate-broadening
plan: "01"
subsystem: consolidation
tags: [bm25, candidate-broadening, recon-01, recon-02, fts5, d04-gate, d07-isolation]
dependency_graph:
  requires: []
  provides: [bm25CandidateK-knob, BM25-candidate-source, D04-gate-extension, D06-counters]
  affects: [src/consolidation/consolidator.ts, src/lib/config.ts, tests/consolidator.test.ts]
tech_stack:
  added: []
  patterns:
    - BM25 FTS5 candidate source via prepared statement (mirrors CandidateRetriever.stmtBm25)
    - Phase A sync read before db.transaction (T-02-ASYNC invariant preserved)
    - Dark-knob isolation switch (bm25CandidateK=0 reproduces pre-46 behavior, mirrors rankStrengthWeight=0)
    - Observability counters at method scope accumulating across all chunks/episodes
key_files:
  created: []
  modified:
    - src/lib/config.ts
    - src/consolidation/consolidator.ts
    - tests/consolidator.test.ts
decisions:
  - "D-03: bm25CandidateK=5 default (mirrors candidateK/entityAnchorK calibration placeholders)"
  - "D-04: cosineGate extended with bm25Candidates.length===0 — the load-bearing rescue gate"
  - "D-07: bm25CandidateK=0 as dark isolation switch (reproduces pre-Phase-46 behavior)"
  - "T-02-ASYNC: stmtBm25Candidates.all() is sync Phase A read, never inside db.transaction"
  - "T-17-02-T: claim.value passes through ftsQueryFromText() before reaching MATCH placeholder"
  - "Test fixture: existing node has embedded_hash='sentinel' (reembedDirty-safe) + embedding IS NULL (topk-invisible) to isolate BM25 rescue path"
metrics:
  duration: "~18 minutes"
  completed: "2026-06-28"
  tasks_completed: 3
  tasks_total: 3
  files_modified: 3
  tests_added: 2
  tests_total: 80
---

# Phase 46 Plan 01: BM25 Candidate Broadening Summary

BM25 lexical candidate source wired into the offline consolidation sleep pass so the contradiction-candidate set fed to the existing Sonnet judge becomes cosine top-k ∪ M1 entity/subject anchors ∪ BM25 (node_fts FTS5), with the D-04 gate extended to rescue low-cosine claims with lexical hits into judge escalation.

## Tasks Completed

### Task 1: bm25CandidateK config knob (commit 422f70a)

Added `bm25CandidateK: number` to `EngineConfig` interface immediately after `entityAnchorK` (~line 248 → now ~line 258), with full doc comment explaining the dark isolation switch. Added `bm25CandidateK: 5` to `DEFAULT_CONFIG` immediately after `entityAnchorK: 5` (~line 774 → now ~line 785), with inline comment noting default-ON and isolation semantics.

**Edit ranges in config.ts:**
- Interface: lines 258–273 (new JSDoc + property)
- DEFAULT_CONFIG: line 785 (new default)

### Task 2: Consolidator wiring — five edit sites + D-06 counters (commit 9ea0846)

**Edit site 1 (import, line 39):** Extended named import from `'../retrieval/topk'` to include `ftsQueryFromText` alongside `cosineSimF32`.

**Edit site 2 (field declaration, lines 233–242):** Added `private readonly stmtBm25Candidates: Database.Statement` immediately after `stmtLiveNodesForLinks`.

**Edit site 3 (constructor init, lines 292–299):** Initialized `stmtBm25Candidates` immediately after `stmtLiveNodesForLinks`:
```sql
SELECT f.node_id AS id
FROM node_fts f JOIN node n ON n.id = f.node_id AND n.tombstoned = 0
WHERE node_fts MATCH ?
ORDER BY rank LIMIT ?
```
SQL mirrors `CandidateRetriever.stmtBm25` (topk.ts:301-306) exactly.

**Edit site 4 (BM25 fetch block, lines 782–800):** Inserted after M1 provenance-sibling anchor block (`}` at ~line 776), inside the `else` branch (D-17 fast-path precedence preserved). Guard `if (this.config.bm25CandidateK > 0)`, `ftsQueryFromText(claim.value)` as mandatory sanitizer (T-17-02-T), try/catch for FTS-absent graceful degradation (mirrors topk.ts:hybridTopk 460-465).

**Edit site 5a (D-04 gate, line 813):** Extended `if (cosineGate && anchors.length === 0)` to `if (cosineGate && anchors.length === 0 && bm25Candidates.length === 0)`. This is the load-bearing change.

**Edit site 5b (D-02 union, lines 826–836):** Appended `...bm25Candidates.map(c => ({ id: c.id, value: this.store.getNode(c.id)?.value ?? '' }))` after anchors spread in `judgeCandidates`. D-02 ordering: cosine → anchors → BM25.

**D-06 counters (method scope, lines 565–572):** Declared `let cosineCandidateTotal`, `anchorCandidateTotal`, `bm25CandidateTotal`, `judgeFiredContradiction` at `consolidate()` method scope, BEFORE the outer chunk loop (line 573), so they accumulate across all chunks and episodes. Counter accumulations at lines 802–804. `judgeFiredContradiction` incremented at the `applyDecision` call site (lines 949–952) via a pre-txn loop (applyDecision is a separate method and cannot see local counters). RECON-03 log emitted at line 983, after the outer chunk loop closes (line 980).

**T-02-ASYNC compliance:** The BM25 `stmtBm25Candidates.all(...)` call is a synchronous better-sqlite3 call, located inside the claim for-loop in Phase A, well before the `db.transaction()` call at line 948. No `await` precedes it.

### Task 3: Unit tests (commit 7883e17)

Added `describe('Phase 46 RECON-01/D-04: BM25 lexical rescue')` block with `BM25CapturingProvider` class and two tests.

**Fixture design:** The existing fact node ("recense stores facts in memory") is:
- In `node_fts`: yes (via `store.upsertNode` → stmtFtsInsert sync)
- In topk: NO — `embedding IS NULL` (topk WHERE embedding IS NOT NULL skips it)
- In reembedDirty: NO — `embedded_hash = 'bm25-test-sentinel'` (reembedDirty WHERE embedded_hash IS NULL skips it)

This isolates the BM25 path: `candidates = []` → `cosineGate = true` (candidates.length===0 branch) → `cosineIdSet = {}` → BM25 finds the node (not in cosineIdSet) → `bm25Candidates = [{existingNodeId}]` → with bm25K=5 gate does not fire, with bm25K=0 gate fires.

**Test A (bm25CandidateK=5):** `judgeCalls > 0` and `existingNodeId in capturedCandidates.flat()`. Proves D-04 BM25 rescue escalation.

**Test B (bm25CandidateK=0):** `judgeCalls === 0`. Proves D-07 isolation switch reproduces pre-46 behavior.

## Verification

- `npm run build`: clean (tsc)
- `npm test -- tests/consolidator.test.ts tests/consolidation.test.ts tests/update-decision.test.ts`: 80 tests pass (78 existing + 2 new BM25 tests)
- No raw text at MATCH: `grep "MATCH.*claim.value"` returns nothing
- D-04 gate: `cosineGate && anchors.length === 0 && bm25Candidates.length === 0` at line 813
- ftsQueryFromText: 4 occurrences in consolidator.ts (comment, import, call, comment)
- RECON-03 log: line 983 after outer chunk loop

## Deviations from Plan

None — plan executed exactly as written.

## node_fts Fixture Detail (for Plan 46-02)

In the test harness (`makeHarness`), `initSchema(db)` creates `node_fts` as an FTS5 virtual table with `tokenize='unicode61 remove_diacritics 2'`. The backfill is a no-op for an empty DB. `store.upsertNode()` triggers `stmtFtsInsert` inside `txUpsertNode`, so any node added via `store.upsertNode` is automatically FTS-indexed. Plan 46-02's harness run on real data will benefit from this same mechanism — the FTS index is kept current by SemanticStore. No manual node_fts inserts are needed in production or eval harnesses.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The new `stmtBm25Candidates` prepared statement reads from `node_fts` (existing FTS5 table) with bound parameters only — no SQL injection surface. T-46-01 (raw text → MATCH) mitigated by `ftsQueryFromText()` + bound `?`. T-46-02 (FTS-absent / MATCH error) mitigated by try/catch fallback.

## Self-Check: PASSED

- src/lib/config.ts: FOUND — bm25CandidateK in interface and DEFAULT_CONFIG
- src/consolidation/consolidator.ts: FOUND — all 5 edit sites applied, D-06 counters, RECON-03 log
- tests/consolidator.test.ts: FOUND — BM25CapturingProvider + 2 new tests
- Commits:
  - 422f70a: feat(46-01): add bm25CandidateK config knob — FOUND
  - 9ea0846: feat(46-01): wire BM25 lexical candidate broadening into consolidator — FOUND
  - 7883e17: test(46-01): BM25 rescue escalation + bm25CandidateK=0 isolation-switch regression — FOUND
- All 80 tests passing
