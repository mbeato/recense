---
phase: 28-schema-anchored-corpus
plan: 03
subsystem: corpus-promoter
tags: [corpus, schema, promotion, cosine, containment, reference, tdd, d43-self-confirmation]
dependency_graph:
  requires: [28-01, 28-02]
  provides: [CorpusPromoter.promote(), NoopCorpusPromoter, promote-corpus CLI, consolidator Phase C wiring]
  affects: [consolidator.ts, run-sleep-pass.ts, recense.ts, promote-corpus-cli.ts]
tech_stack:
  added: []
  patterns: [centroid-cosine+mass-direction ladder, eager doc stubs (lifecycle-exempt), wipe+rebuild derived cache, D-05 hysteresis, D-37 clusterable firewall]
key_files:
  created:
    - src/consolidation/corpus-promoter.ts
    - src/adapter/promote-corpus-cli.ts
  modified:
    - tests/corpus-promoter.test.ts
    - src/lib/types.ts
    - src/consolidation/consolidator.ts
    - src/consolidation/run-sleep-pass.ts
    - src/adapter/recense.ts
decisions:
  - EdgeKind type extended to include doc_containment/doc_reference (were in DDL from 28-01 but missing from TypeScript union)
  - cosineSimF32 centroid logic mirrored verbatim from SchemaRelationDeriver (Pitfall-5 byteOffset decode)
  - Noise filter uses NOISE_PATTERNS array from 28-RESEARCH.md (calibrated on live brain)
  - Forest rule: bestParent map (childSchemaId → { parentSchemaId, sim }) keeps single strongest parent
  - Reference edge ordering: lexicographic by docId for idempotent upsert
  - corpusCosineThreshold=0.55 (enrichment knob — lower than schemaRelSimilarityThreshold ~0.72)
  - promote-corpus CLI operates on ALL schemas (no positional schema-id arg — T-28-PATH + idempotency)
  - NoopCorpusPromoter as consolidator DI default (mirrors NoopSchemaRelationDeriver pattern)
metrics:
  duration: ~40min
  completed: 2026-06-19
  tasks_completed: 3 of 3 (Task 1 TDD complete; Task 2 checkpoint approved; Task 3 complete)
  test_counts: 17/17 corpus-promoter; 1746/1749 full suite
---

# Phase 28 Plan 03: CorpusPromoter Implementation Summary

**One-liner:** LLM-free CorpusPromoter with mass gate + noise filter + centroid-cosine+mass-direction corpus edge ladder, lifecycle-exempt eager doc stubs, and wired into sleep-pass Phase C via `recense promote-corpus` CLI.

## What Was Built

### Task 1 (commit `facaa58` RED + `c42e730` GREEN): CorpusPromoter — mass gate + noise filter + cosine+mass ladder + eager stubs + edge rebuild

**`src/consolidation/corpus-promoter.ts`** — new file, 513 lines.

`class CorpusPromoter` with constructor `(db, store, clock, opts: CorpusPromoterOpts)` and `async promote(opts?: { dryRun? }): Promise<PromoteResult>`:

**Phase A (read-only, async-free):**
1. D-37 clusterable firewall: `SELECT id, embedding FROM node WHERE tombstoned=0 AND origin!='inferred' AND type IN ('fact','entity') AND embedding IS NOT NULL` — exact mirror of SchemaRelationDeriver
2. Per-schema mass (`COUNT DISTINCT live fact|entity members`), noise_frac (NOISE_PATTERNS regex), centroid (byteOffset Float32Array decode, mean), existing doc stub check
3. Promotion gate (D-05/D-06/D-07): promote when `mass >= highMass` OR (`mass >= lowMass AND existingDocId`); tombstone when `mass < lowMass AND existingDocId`; noise-filtered
4. Cosine+mass ladder (D-01R/D-02R): for each promoted-schema pair above `corpusCosineThreshold` with `mass >= minMembers`: mass gap >= `massGapMin` -> CONTAINMENT candidate (parent = larger-mass); gap < `massGapMin` -> REFERENCE candidate. Forest rule: `bestParent` map keeps single highest-cosine parent per child

**Phase B (one `db.transaction().immediate()`, no await — T-02-ASYNC):**
- Tombstone demoted doc stubs
- Create lifecycle-exempt doc stubs for new promotions: `upsertNode` (type='doc', s=0, origin='inferred') + FTS delete + `upsertNodeDoc` (slug=schemaId, Pitfall 4) + `upsertNodeScope`
- Wipe all `doc_containment` + `doc_reference` edges (D-04 derived-cache discipline)
- Rebuild `doc_containment` (src=parentDocId, dst=childDocId) + `doc_reference` (lexicographic stable order) edges — D-03: both endpoints are doc node IDs only (Pitfall 6 guard)

`class NoopCorpusPromoter` — returns zero counts, satisfies Consolidator DI contract.

**Type fix (Rule 3 auto-fix):** `src/lib/types.ts EdgeKind` extended with `'doc_containment' | 'doc_reference'`.

**`tests/corpus-promoter.test.ts`** — 17 tests:
- CORPUS-02: gate correctness, determinism, noise filter pass/fail, hysteresis keep/tombstone, dryRun
- CORPUS-03: containment directed parent->child, forest invariant, doc-only edges, >=1 corpus edge, idempotent wipe+rebuild, result count matches DB
- CORPUS-05 (BLOCKING D-43): snapshot-diff test — source schema s/c/incident-edges/member-set unchanged; new nodes exclusively type='doc'; new edges exclusively doc_containment/doc_reference/cites; FK clean
- NoopCorpusPromoter: completes without error, returns zero counts

### Task 2 (checkpoint:human-verify — CORPUS-05 guard): APPROVED

The CORPUS-05 snapshot-diff test was verified green, non-skipped (executing `it(...)`), and confirmed to fail LOUDLY under a `store.strengthen(schemaId)` injection. `PRAGMA foreign_key_check` assertion is present and passes after `promote()`. Founder typed "approved" to continue.

### Task 3 (commit `d57d6a6`): promote-corpus CLI + consolidator + sleep-pass wiring

**`src/adapter/promote-corpus-cli.ts`** — new file, 112 lines. Mirrors `generate-doc-cli.ts` pattern:
- Parses `--db` + `--dry-run`; NO positional schema-id arg (T-28-PATH + idempotency)
- Validates `dbPath` via `resolveSharedDbPath` BEFORE `acquireLock()` (WR-02)
- Exits 0 (not 1) when lock is held — consistent with generate-doc-cli
- Constructs `CorpusPromoter` with Phase-28 constants (highMass=10, lowMass=7, noiseCap=0.5, corpusCosineThreshold=0.55, massGapMin=2, minMembers=4)
- Emits JSON result line: `{promoted: count, containment, reference, tombstoned, dryRun}`
- `releaseLock()` in `finally` on all paths
- `require.main` guard for test isolation

**`src/consolidation/consolidator.ts`** — added:
- Import: `NoopCorpusPromoter` + `CorpusPromoter` type from `./corpus-promoter`
- Private field: `private readonly corpusPromoter: CorpusPromoter | NoopCorpusPromoter`
- Constructor param (after `deriver`): `corpusPromoter: CorpusPromoter | NoopCorpusPromoter = new NoopCorpusPromoter()`
- Phase C insertion: `await this.corpusPromoter.promote()` between `deriveSchemaRelations()` and `runEvictionSweep()`

**`src/consolidation/run-sleep-pass.ts`** — added:
- Import: `CorpusPromoter` from `../consolidation/corpus-promoter`
- Instantiates `const corpusPromoter = new CorpusPromoter(db, store, realClock, { ... })` with Phase-28 constants after `SchemaRelationDeriver` construction
- Passes `corpusPromoter` as final arg to `new Consolidator(...)`

**`src/adapter/recense.ts`** — added:
- `case 'promote-corpus': spawnScript('promote-corpus-cli.js', process.argv.slice(3)); break`
- Updated usage string to include `promote-corpus`

## Test Results

```
corpus-promoter.test.ts: 17/17 passed
Full suite: 1746/1749 passed (1 test file skipped, 3 tests skipped — all pre-existing)
tsc --noEmit: clean
dist: rebuilt (npm run build)
Smoke check: node dist/src/adapter/promote-corpus-cli.js → "No DB path" (exits cleanly)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] EdgeKind TypeScript type missing doc_containment/doc_reference**
- **Found during:** Task 1 tsc run
- **Issue:** `src/lib/types.ts EdgeKind` union did not include `'doc_containment'` or `'doc_reference'`. These were added to the SQLite DDL `edge.kind CHECK` constraint in plan 28-01 but the TypeScript type was not updated.
- **Fix:** Extended EdgeKind union to add both values.
- **Files modified:** `src/lib/types.ts`
- **Commit:** c42e730

## Known Stubs

- All promoted doc nodes have `value = ''` (empty stub) — this is intentional by design (D-04: prose stays lazy, generated on first `/doc?slug=<schemaId>` access). Not a bug; documented in architecture.

## Threat Flags

None — all code writes only to type='doc' nodes and doc->doc edges (D-03). No new network endpoints or auth paths introduced. `promote-corpus-cli.ts` validates dbPath before lock acquisition (WR-02).

## Self-Check: PASSED

- src/consolidation/corpus-promoter.ts: FOUND
- src/adapter/promote-corpus-cli.ts: FOUND
- tests/corpus-promoter.test.ts: FOUND (17/17)
- Commit facaa58 (TDD RED): FOUND
- Commit c42e730 (TDD GREEN + type fix): FOUND
- Commit d57d6a6 (Task 3 — CLI + DI wiring): FOUND
- tsc --noEmit: clean
- Full suite 1746/1749 green (3 pre-existing skips)
- dist: rebuilt
- recense.ts dispatch: registered (`grep -c "promote-corpus" src/adapter/recense.ts` == 3)
- consolidator.ts promote() positioned after deriveSchemaRelations(), before runEvictionSweep() (lines 727/731/732)
