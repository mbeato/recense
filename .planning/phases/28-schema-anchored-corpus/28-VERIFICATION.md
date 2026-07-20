---
phase: 28-schema-anchored-corpus
verified: 2026-06-19T14:33:00Z
status: passed
score: 5/6 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Hero verify — legible forest on the live brain"
    expected: "recense promote-corpus on WAL-safe DB copy produces 17 schemas, ≥1 directed parent→child containment nest visible in the corpus view, distinct solid/directed containment edges vs faint/dashed reference edges, first render not dominated by dogfooding-noise schemas (no 'Output file paths'/'Git commit hashes'/'Tool identifiers'), clicking a corpus node opens its doc in-place"
    why_human: "Visual legibility, corpus layout, and edge-style rendering on the live DB cannot be verified programmatically. Task 3 of plan 28-04 was a blocking human checkpoint (gate=blocking) explicitly left STOPPED in the SUMMARY pending founder approval. Plan says founder should type 'approved' after eyeballing the forest and confirming the cosine threshold (0.55) produces a clean hierarchy, not a hairball."
---

# Phase 28: Schema-Anchored Corpus Verification Report

**Phase Goal:** Pivot the reader corpus from project-scope docs to the abstraction graph rendered as prose — a doc anchors on a schema (the generalization is the thesis) and cites direct facts as evidence; LLM-free mass-gated promotion; hierarchy mirrors the `abstracts` ladder via containment + reference edges; decide-cheap/generate-lazy; read-only projection (a doc must never strengthen the schema it renders — self-confirmation guard).
**Verified:** 2026-06-19T14:33:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Schema-anchored doc generation: given a schema id + centroid, `gatherFactsForSchema` returns ≥1 fact from the schema's `abstracts` neighborhood; `generateDocForSchema` produces a thesis-framed doc citing those facts | ✓ VERIFIED | `gatherFactsForSchema` exports in `src/reader/doc-gather.ts`; spine query uses `kind = 'abstracts'` and binds `params.schemaId`; `generateDocForSchema` in `src/reader/doc-generator.ts` calls `gatherFactsForSchema` + `buildSchemaDocPrompt`; 18/18 doc-gather tests pass; no `provider.embed` call inside `gatherFactsForSchema` (centroid is precomputed) |
| 2 | LLM-free mass-gated promotion: `CorpusPromoter.promote()` is deterministic for a fixed snapshot, makes zero model calls, and selects 15–60 schema candidates using SQL COUNT + noise filter | ✓ VERIFIED | `src/consolidation/corpus-promoter.ts` (513 lines) — no `ModelProvider` injected; gate uses `highMass=10/lowMass=7/noiseCap=0.5`; 17/17 corpus-promoter tests pass including gate-predicate, determinism, and zero-LLM-call tests; sleep-pass config sets `corpusCosineThreshold: 0.55` (lower than `schemaRelSimilarityThreshold ~0.72` for enrichment) |
| 3 | Schema→schema ladder enrichment + ≥1 parent→child nest: `promote()` derives `doc_containment` (directed, parent = larger-evidence-mass) + `doc_reference` edges using centroid-cosine, enriching past the ~95 schema_rel baseline; forest invariant (each child ≤1 parent) | ✓ VERIFIED | `cosineSimF32` + centroid-ladder in `corpus-promoter.ts`; CORPUS-03 test asserts `doc_containment` edges exist, parent-of-larger-mass direction, and forest invariant (each `dst` has ≤1 parent); wipe-and-rebuild ensures idempotency; no shared-evidence intersection code (centroid-cosine is the spine as required by CRITICAL_ARCHITECTURE_CORRECTION) |
| 4 | Containment + reference corpus edges in the flat 2D corpus: `/graph?type=doc` returns `doc_link`+`doc_containment`+`doc_reference` between live doc nodes only; corpus.js renders containment as solid/directed and reference as faint/dashed; clicking a node opens its doc in-place | ✓ VERIFIED | `stmtDocLinks` in `src/viz/server.ts` uses `kind IN ('doc_link','doc_containment','doc_reference') AND src IN (...tombstoned=0) AND dst IN (...tombstoned=0)`; `corpus.js` has `linkDirectionalArrowLength`, `linkLineDash`, kind-aware `linkColor`/`linkWidth` callbacks; `CONTAINMENT_COLOR = 'rgba(110,90,130,0.70)'` (no amber/cyan); `onNodeClick → openDocReader` chain unchanged; 27/27 viz-corpus-graph tests pass |
| 5 | Self-confirmation guard (CORPUS-05, BLOCKING): generating/nesting/linking a schema-doc leaves source schema `s`/`c`/incident-edge-weights/member-set byte-for-byte unchanged; new nodes are exclusively `type='doc'`; new edges are exclusively `doc_containment`/`doc_reference`/`cites`; `PRAGMA foreign_key_check` empty | ✓ VERIFIED | CORPUS-05 blocking snapshot-diff test in `tests/corpus-promoter.test.ts` (lines 475–554): snapshots schema state before `promote()`, re-snapshots after, asserts equality; new-node type assertion; new-edge kind assertion; FK assertion; test is executing `it(...)` (not skipped); SUMMARY documents it was verified to go RED under an injected `store.strengthen(schemaId)` call |
| 6 | Legible forest visible on the live brain: live `recense promote-corpus` on canonical DB produces a corpus with ≥1 visible parent→child nest, distinct edge styling, noise-free promoted set, working node-click open | ? HUMAN NEEDED | Task 3 of plan 28-04 was a `checkpoint:human-verify` (gate=blocking) explicitly left STOPPED in the SUMMARY. Submission context claims founder-verified evidence (17 schemas / 7 containment + 2 reference / 4-deep nest / 0 invented citations), but this is not recorded as a formal approval in planning files. The SUMMARY states "STOPPED" at this task. Human confirmation required. |

**Score:** 5/6 truths verified (Truth 6 requires human confirmation)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/schema.ts` | v12 migration: `doc_containment` + `doc_reference` added to edge.kind CHECK; `SCHEMA_VERSION=12`; `doc_link` retained | ✓ VERIFIED | `SCHEMA_VERSION = 12`; edge CHECK includes all 7 kinds; migration guard is idempotent; 17/17 v12 migration tests pass |
| `src/consolidation/corpus-promoter.ts` | `class CorpusPromoter` + `class NoopCorpusPromoter`; ≥120 lines; centroid-cosine (not intersection); doc→doc edges only | ✓ VERIFIED | 513 lines; both classes present; `cosineSimF32` + centroid math; all `upsertEdge` calls use doc node ids only |
| `src/adapter/promote-corpus-cli.ts` | `recense promote-corpus [--db] [--dry-run]`; WR-02 (path-validate before lock); lock-guarded | ✓ VERIFIED | WR-02 pattern confirmed (`resolveSharedDbPath` before `acquireLock`); `finally` releases lock; `--dry-run` support; registered in `recense.ts` |
| `src/reader/doc-gather.ts` | `gatherFactsForSchema(deps, params, opts)` — three D-09 sources (spine/semantic/entity-hop); no `provider.embed` in schema path | ✓ VERIFIED | Function exported; spine query uses `kind = 'abstracts'`; `provider.embed` only in legacy `gatherFacts` path (confirmed by grep); `computeSchemaCentroid` also exported (CORPUS-06 helper) |
| `src/reader/doc-generator.ts` | `generateDocForSchema`; `buildSchemaDocPrompt` with thesis framing; shared FACT_REF citation-verify loop | ✓ VERIFIED | Both functions present; thesis framing confirmed ("This deep-dive's thesis is a generalization…"); `gatherFactsForSchema` called (not `gatherFacts`); `verifyCitations()` factored as shared internal helper |
| `src/consolidation/corpus-generator.ts` | `generateCorpusDocs()` — offline batch prose fill; per-doc failure isolation; maxDocs cap | ✓ VERIFIED | 195 lines; `generateDocForSchema` called per stub; per-doc try/catch; `maxDocs` cap with logged deferred count; 9/9 corpus-generator tests pass |
| `src/adapter/generate-corpus-cli.ts` | `recense generate-corpus [--db] [--max]`; WR-02; registered in `recense.ts` | ✓ VERIFIED | WR-02 pattern; `--max` support; registered as `generate-corpus` in `recense.ts` |
| `src/viz/server.ts` | `stmtDocLinks` returns all three doc-edge kinds with both-endpoints-live-doc guard | ✓ VERIFIED | Replacement query confirmed with `kind IN ('doc_link','doc_containment','doc_reference') AND src IN (...) AND dst IN (...)` |
| `src/viz/modules/corpus.js` | Kind-aware link styling; `linkDirectionalArrowLength` + `linkLineDash`; no amber/cyan in rest-state constants | ✓ VERIFIED | All four callbacks confirmed; `CONTAINMENT_COLOR` is muted slate/mauve; amber only in `HOVER_NODE` (hover-only as required by founder-locked palette) |
| `tests/corpus-promoter.test.ts` | CORPUS-02/03/05 tests — gate, noise, ladder, snapshot-diff (BLOCKING), hysteresis, idempotency | ✓ VERIFIED | 584 lines; 17/17 pass; no `describe.skip` or `it.skip`; FK assertion present |
| `tests/schema-v12-migration.test.ts` | v12 idempotency + FK-clean + new kinds + `doc_link` retained + version stamp | ✓ VERIFIED | 17/17 pass |
| `tests/doc-gather.test.ts` | `gatherFactsForSchema` tests unskipped; existing `gatherFacts` regression preserved | ✓ VERIFIED | 18/18 pass; `gatherFactsForSchema` appears 11 times |
| `tests/viz-corpus-graph.test.ts` | CORPUS-04 tests unskipped; `doc_containment`/`doc_reference` in payload; tombstoned-endpoint exclusion | ✓ VERIFIED | 27/27 pass; `doc_containment` appears 30 times |
| `tests/corpus-generator.test.ts` | Fill-empty-stub, skip-non-empty, fill-in-place stable-edge, failure-isolation, maxDocs cap, `computeSchemaCentroid` | ✓ VERIFIED | 9/9 pass |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `consolidator.ts` Phase C | `CorpusPromoter.promote()` | Called after `deriveSchemaRelations()`, before `runEvictionSweep()` | ✓ WIRED | `consolidator.ts:727` calls `await this.deriver.deriveSchemaRelations()` then `:731` calls `await this.corpusPromoter.promote()` then `:732` calls `this.strength.runEvictionSweep()` — exact ordering |
| `run-sleep-pass.ts` | `new CorpusPromoter(...)` passed to `new Consolidator(...)` | DI wiring at construction | ✓ WIRED | `run-sleep-pass.ts:353` instantiates with `highMass:10, lowMass:7, noiseCap:0.5, corpusCosineThreshold:0.55, massGapMin:2, minMembers:4`; passed as `corpusPromoter` arg |
| `run-sleep-pass.ts` | `generateCorpusDocs()` | Called after `consolidator.consolidate()` returns; env-gated | ✓ WIRED | `run-sleep-pass.ts:395` inside `if (env['RECENSE_CORPUS_GEN'] !== '0')` — after consolidate, before scope-stamping |
| `CorpusPromoter` Phase B | `doc-writer` / `store.upsertNode` for doc stubs | `type='doc', s=0, origin='inferred'` — lifecycle-exempt | ✓ WIRED | `corpus-promoter.ts:427-438` uses `store.upsertNode({type:'doc', origin:'inferred', s:0, c:1.0})` + FTS delete; never touches source schemas |
| `doc_containment`/`doc_reference` edge writes | doc node ids only (D-03) | `src`/`dst` bound to `docId` values, never to schema ids | ✓ WIRED | `corpus-promoter.ts` wipe-rebuild loop uses `parentDocId` and `childDocId` (the doc node ids looked up from the schema stub); confirmed by CORPUS-05 snapshot test (new edges only doc_containment/doc_reference/cites) |
| `corpus.js` link styling | vendored `force-graph 1.43.5` API | `linkDirectionalArrowLength` + `linkLineDash` callbacks | ✓ WIRED | Both methods confirmed present in `src/viz/vendor/force-graph.min.js` (RESEARCH Assumption A4); callback functions wired |
| `gatherFactsForSchema` | `schema.abstracts` edges | `SELECT ... WHERE e.kind = 'abstracts' AND e.src = schemaId` | ✓ WIRED | `doc-gather.ts` spine query confirmed; no string interpolation (parameterized `?`) |
| `generate-doc-cli.ts` lazy path | `generateDocForSchema` (not `generateDoc`) for schema-anchored slugs | Routes based on whether slug resolves to a live schema node | ✓ WIRED | `generate-doc-cli.ts:149-164` checks `SELECT ... WHERE id = ? AND type = 'schema'`; schema → `generateDocForSchema`; non-schema → `generateDoc` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `corpus-promoter.ts` promote() | `schemaInfos` (per-schema mass + centroid + noise) | `stmtGetSchemaNodes`, `stmtGetSchemaMembersWithValues`, D-37-gated clusterable query | Yes — live DB queries; no hardcoded values | ✓ FLOWING |
| `doc-gather.ts` gatherFactsForSchema | `gathered` (Map of GatheredFact) | `SELECT ... WHERE kind='abstracts'` (spine), `hybridTopk` (semantic), entity-hop | Yes — DB queries against live abstracts edges | ✓ FLOWING |
| `doc-generator.ts` generateDocForSchema | `facts` (GatheredFact[]) | `gatherFactsForSchema` return value | Yes — flows from real DB evidence | ✓ FLOWING |
| `corpus-generator.ts` generateCorpusDocs | `stubs` (empty doc nodes) | `SELECT ... WHERE type='doc' AND value='' AND tombstoned=0` | Yes — finds real empty stubs created by CorpusPromoter | ✓ FLOWING |
| `viz/server.ts` /graph?type=doc | `edgeRows` | `stmtDocLinks.all()` | Yes — live DB query; both-endpoints-live guard prevents stale data | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles clean | `npx tsc --noEmit` | 0 errors | ✓ PASS |
| Full test suite green | `npx vitest run` | 1766 passed, 3 skipped (0 failing) | ✓ PASS |
| CORPUS-05 self-confirmation test | `npx vitest run tests/corpus-promoter.test.ts -t "self-confirmation"` | 2 passed | ✓ PASS |
| Schema-v12 migration | `npx vitest run tests/schema-v12-migration.test.ts` | 17 passed | ✓ PASS |
| CORPUS-04 corpus endpoint | `npx vitest run tests/viz-corpus-graph.test.ts` | 27 passed | ✓ PASS |
| CORPUS-01 gather | `npx vitest run tests/doc-gather.test.ts` | 18 passed | ✓ PASS |
| CORPUS-06 generator | `npx vitest run tests/corpus-generator.test.ts` | 9 passed | ✓ PASS |
| Phase 27 regression | `npx vitest run tests/doc-writer.test.ts tests/doc-generator.test.ts` | 41 passed | ✓ PASS |

### Probe Execution

Step 7c: No probe-*.sh files exist for this phase. Spot-checks above cover the equivalent behaviors.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| CORPUS-01 | 28-02 | Schema-anchored doc generation (schema = thesis, abstracts-neighborhood = evidence) | ✓ SATISFIED | `gatherFactsForSchema` + `generateDocForSchema` + `buildSchemaDocPrompt` implemented; tests green |
| CORPUS-02 | 28-03 | LLM-free mass-gated promotion + noise filter; 15–60 candidates; deterministic | ✓ SATISFIED | `CorpusPromoter` with `highMass/lowMass/noiseCap`; no ModelProvider injected; determinism test passes |
| CORPUS-03 | 28-01/03 | Schema→schema ladder enrichment via centroid-cosine + mass-direction; ≥1 parent→child nest | ✓ SATISFIED (programmatic) / ? HUMAN for live-brain visual | Centroid-cosine + mass-direction ladder in code; forest-invariant test passes; `corpusCosineThreshold=0.55` enriches past baseline; live-brain render requires human eye |
| CORPUS-04 | 28-01/04 | Containment + reference corpus edges in flat 2D corpus; supersedes READER-04 doc_link | ✓ SATISFIED | `stmtDocLinks` replacement; corpus.js kind-aware styling; 27/27 endpoint tests pass |
| CORPUS-05 | 28-03 | Read-only projection / self-confirmation guard (BLOCKING) | ✓ SATISFIED | BLOCKING snapshot-diff test green; non-skipped; verified to go RED under injected strengthen() per SUMMARY |
| CORPUS-06 | 28-06 | Eager offline corpus-doc generation in sleep pass | ✓ SATISFIED | `corpus-generator.ts` + `generate-corpus-cli.ts` + sleep-pass wiring; 9/9 tests pass |

**Note on REQUIREMENTS.md traceability:** CORPUS-01 through CORPUS-06 are defined in `28-SPEC.md` but are NOT registered in `.planning/REQUIREMENTS.md` (which only covers SCOPE/DEDUP/RETR/READER requirements). This is a documentation gap — the requirements exist and are implemented, but the central traceability table does not list Phase 28. This does not block phase completion but should be remedied.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `tests/corpus-promoter.test.ts` (none found) | — | No TBD/FIXME/XXX/skipped tests | — | — |
| `src/consolidation/corpus-promoter.ts` (none found) | — | No TBD/FIXME/XXX | — | — |
| `src/consolidation/corpus-generator.ts:103` | 103 | Comment uses "placeholder" referring to CorpusPromoter's eager empty doc stubs | INFO | This is a code comment accurately describing the empty `value=''` state of stubs — NOT a stub code smell. No impact. |

No debt markers (TBD/FIXME/XXX) found in any key Phase 28 files. No unresolved placeholders that map to rendering or user-visible output.

### Human Verification Required

#### 1. Hero Verify — Legible Forest on the Live Brain

**Test:** Make a WAL-safe copy: `cp ~/.config/recense/recense.db /tmp/corpus28.db && cp ~/.config/recense/recense.db-wal /tmp/corpus28.db-wal 2>/dev/null; cp ~/.config/recense/recense.db-shm /tmp/corpus28.db-shm 2>/dev/null`. Then run `recense promote-corpus --db /tmp/corpus28.db` (LLM-free — subscription billing only if prose is lazily generated later). Then `recense viz --db /tmp/corpus28.db`, open the corpus view (full-window expanded-only #btn-corpus toggle). Confirm:
- (a) containment edges are solid + arrowed; reference edges are faint + dashed
- (b) ≥1 visible parent→child nest
- (c) the promoted nodes are content-meaningful — NOT dominated by "Output file paths" / "Git commit hashes" / "Tool identifiers"
- (d) reads as a forest, not a hairball
- (e) clicking a corpus node opens its doc in-place

**Expected:** Corpus renders a legible hierarchical graph with 15–60 promoted schema nodes, structurally distinct edge types (containment = solid/directed/heavier; reference = faint/dashed/no-arrow), ≥1 parent→child nesting level visible, and a noise-free promoted set. First 1–2 docs load without the stub "still generating" state (CORPUS-06 offline gen should have pre-filled some stubs in the sleep pass).

**Why human:** Visual legibility, hierarchy depth, noise filtering quality, and edge rendering cannot be asserted programmatically. The plan's Task 3 was an explicit `checkpoint:human-verify` (gate=blocking) per 28-04-PLAN.md. The planning files show this task was left STOPPED pending founder approval.

### Gaps Summary

All programmatic checks pass. The only outstanding item is the blocking human checkpoint (Task 3 of plan 28-04), which was explicitly deferred as a human verification gate in the plan and was not formally approved in the planning artifacts. The submission context claims founder-verified live-brain evidence (17 schemas / 7 containment + 2 reference / 4-deep nest), but this was not recorded as a formal "approved" signal in the SUMMARY or STATE.md (the SUMMARY explicitly says "STOPPED"). This should be completed before closing Phase 28.

---

_Verified: 2026-06-19T14:33:00Z_
_Verifier: Claude (gsd-verifier)_
