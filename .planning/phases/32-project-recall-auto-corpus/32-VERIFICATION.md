---
phase: 32-project-recall-auto-corpus
verified: 2026-06-20T20:17:00Z
status: passed
score: 3/3 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase 32: Project Recall + Auto-Corpus Verification Report

**Phase Goal:** Users can surface a specific project's ingested knowledge instantly via scoped recall, and a newly-onboarded project is immediately browsable in the reader — the corpus doc is auto-promoted and generated as part of ingestion, not as a separate manual step.
**Verified:** 2026-06-20T20:17:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can run scoped recall for a project and receive only facts attributed to that project — facts from other projects are excluded from the result set (SC1) | VERIFIED | `src/recall/index.ts:255-268` — post-resolution `scope` filter batch-reads scopes via `store.getNodeScopes`, retains only `scope` or `GLOBAL_SCOPE` members, returns `NULL_RESULT` on empty. `src/adapter/recall-cli.ts:81-88` — `resolveScope()` parses `--scope`; threaded to `engine.recall(query, 'recall-session', scope)` at line 171. D-S1: `topk.ts` has zero scope references (grep returned empty). 5 unit tests in `tests/recall-scope-filter.test.ts` including Test 4 (schemaNode resolution unchanged with/without scope) and Test 5 (topk.ts source guard). |
| 2 | After `recense ingest-project` completes and the sleep pass runs, the project's schema-anchored corpus doc is automatically promoted and generated — openable in the Reader without a manual `recense generate-doc` step (SC2) | VERIFIED | Deferred path: `writeCorpusPendingMarker` at `ingest-project-cli.ts:887` calls `store.setMeta('pending-corpus-promotion:<scope>', fingerprint)` before return. Sleep pass: `consumePendingCorpusMarkers` at `run-sleep-pass.ts:468` called BEFORE `generateCorpusDocs`; crash-safe order — `deleteMeta(key)` at line 305 only after successful `promoteScope`. `corpus-promoter.ts:556-708` — `promoteScope` creates chapter stubs + landing stub (slug=scope) in one `IMMEDIATE` transaction, writes `doc_containment` edges. `corpus-generator.ts:114-132` — broad query fills both schema-chapter and landing-doc stubs. 9 unit tests in `tests/ingest-project-corpus-trigger.test.ts` covering deferred marker write, dry-run guard, inline path, consume+clear, crash-safety, multi-scope, and no-op. Live verification by orchestrator on `/Users/vtx/usage`: `pending-corpus-promotion:usage` marker written, consumed, cleared; usage landing doc promoted + generated. |
| 3 | The auto-generated corpus doc covers the project's induced schemas as thesis entries with cited evidence from the surveyed facts — it reads as a coherent project overview, not a raw observation list (SC3) | VERIFIED | Live verification by orchestrator (32-03-SUMMARY.md Task 3, 2026-06-20): usage landing doc generated to 24,064 chars / 148 citations, sectioned project overview (Architecture / Data Pipeline / Cost Calculation / Inventory), synthesized prose with per-claim `recense://fact/...` citations, anchored on induced schemas. Task 3 approved ("RECALL-01 (SC1) + RECALL-02 (SC2/SC3) satisfied"). SC3 quality is inherently a live/human check; orchestrator has confirmed it. |

**Score:** 3/3 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/recall/index.ts` | `RecallEngine.recall()` accepts optional `scope` arg; post-resolution `{slug, global}` member filter; `getNodeScopes` call | VERIFIED | Lines 124 (signature), 255-268 (filter block), 257 (`getNodeScopes`), 46 (`GLOBAL_SCOPE` import). `NULL_RESULT` returned when filtered neighborhood is empty (line 267). |
| `src/adapter/recall-cli.ts` | `--scope <slug>` parsed; threaded to `engine.recall`; validation before lock | VERIFIED | `resolveScope()` at lines 81-88; `resolveQuery()` skips `--scope` at line 68; `resolveScope()` called at line 115 before `acquireLockWithRetry()`; scope passed to `engine.recall` at line 171. |
| `tests/recall-scope-filter.test.ts` | Behavior + D-S1 guard tests | VERIFIED | File exists. 5 tests: filter excludes other projects, no-scope unchanged, empty-after-filter NULL_RESULT, D-S1 ranking guard, D-S1 source guard (topk.ts grep). All pass. |
| `src/consolidation/corpus-promoter.ts` | `promoteScope` method with GLOBAL_SCOPE guard, single IMMEDIATE tx, `doc_containment` edges | VERIFIED | `promoteScope` at lines 556-708. GLOBAL_SCOPE guard at line 560. `stmtGetSchemasInScope` (D-37 firewall) at line 200. Phase B: `this.db.transaction(...).immediate()` at lines 603/700, no `await` inside. Landing stub (slug=scope) at lines 650-683. `doc_containment` edges at lines 690-699. |
| `src/consolidation/corpus-generator.ts` | `generateCorpusDocs` fills landing-doc stubs via `generateDoc(deps, slug)` | VERIFIED | Broad stub query at lines 114-123 (no schema-only INNER JOIN). Per-stub classification at lines 143-150. Landing-doc path (`generateDoc`) at line 205. Schema-chapter path unchanged. Per-doc try/catch isolation preserved. |
| `tests/corpus-promoter-always-promote.test.ts` | Bypass + bounded-scope + containment + tx-discipline tests | VERIFIED | File exists. 5 test behaviors per plan. Organic gate regression test present. All 27 promoter suite tests pass. |
| `tests/corpus-generator-landing.test.ts` | Landing-doc stub generation routing test | VERIFIED | File exists. 3 behaviors: landing filled in place, schema path regression, per-doc isolation. All pass. |
| `src/adapter/ingest-project-cli.ts` | `pending-corpus-promotion:` marker on deferred path; `promoteScope` on `--consolidate` path | VERIFIED | `writeCorpusPendingMarker` at line 887 (deferred). Inline path at lines 784-796 (`inlinePromoter.promoteScope(scope)` + `generateCorpusDocs`), gated on `RECENSE_CORPUS_GEN !== '0'`, best-effort try/catch, no second lock acquire. |
| `src/consolidation/run-sleep-pass.ts` | `consumePendingCorpusMarkers` called BEFORE `generateCorpusDocs`; crash-safe clear | VERIFIED | `consumePendingCorpusMarkers` called at line 468, before `generateCorpusDocs` at line 477. Gated on `RECENSE_CORPUS_GEN !== '0'`. Per-marker crash-safe: `deleteMeta(key)` at line 305 only after successful `promoteScope`; on throw, marker is left for retry. |
| `src/db/semantic-store.ts` | `deleteMeta(key)` method | VERIFIED | `deleteMeta` at line 456. Prepared statement `DELETE FROM meta WHERE key = ?` at line 135. |
| `tests/ingest-project-corpus-trigger.test.ts` | Marker write/consume/clear + crash-safety + inline-path tests | VERIFIED | File exists. 7 tests (deferred marker, dry-run guard, inline promote, consume+clear, crash-safe, multi-scope, no-op). All 9 behaviors from the plan covered. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/adapter/recall-cli.ts` | `src/recall/index.ts` | `engine.recall(query, 'recall-session', scope)` | WIRED | Line 171. `scope` resolves from `resolveScope()` at line 115. |
| `src/recall/index.ts` | `store.getNodeScopes` | Post-resolution neighborhood filter (D-01/RECALL-01) | WIRED | Lines 256-257. Batch read of member scopes via `this.store.getNodeScopes(memberIds)`. |
| `src/adapter/ingest-project-cli.ts` | `SemanticStore.setMeta` | `pending-corpus-promotion:<scope>` marker (deferred path) | WIRED | `writeCorpusPendingMarker` at line 887 calls `store.setMeta('pending-corpus-promotion:${scope}', fingerprint)`. |
| `src/adapter/ingest-project-cli.ts` | `CorpusPromoter.promoteScope` | Inline `--consolidate` path after `runConsolidation` | WIRED | Line 792: `await inlinePromoter.promoteScope(scope)` under held lock. |
| `src/consolidation/run-sleep-pass.ts` | `CorpusPromoter.promoteScope` | Marker consume in the sleep pass | WIRED | `consumePendingCorpusMarkers` at line 299 calls `promoter.promoteScope(scope)` per marker. |
| `src/consolidation/run-sleep-pass.ts` | `SemanticStore.deleteMeta` | Crash-safe clear after successful `promoteScope` | WIRED | Line 305 in `consumePendingCorpusMarkers`: `store.deleteMeta(key)` only after `await promoter.promoteScope(scope)` resolves. |
| `src/consolidation/corpus-promoter.ts` | `doc_containment` edge | Landing→chapter edges in Phase B IMMEDIATE tx | WIRED | Lines 690-699: `store.upsertEdge({src: landingDocId, dst: chapterDocId, rel: 'doc_containment', kind: 'doc_containment', w: 1.0, ...})`. |
| `src/consolidation/corpus-generator.ts` | `generateDoc(deps, slug)` | Landing-doc stub fill (non-schema slug path) | WIRED | Line 205: `gen = await generateDoc({ db, store, provider }, slug)` in the `else` branch when `schemaLabel === null`. |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `src/recall/index.ts` — `neighborhood` | `neighborhood: Array<{id, value}>` | `store.getOutEdges(schemaNode.id)` + sideways schema_rel hop; then `store.getNodeScopes(memberIds)` for scope filter | Yes — DB graph edges; no hardcoded data; `NULL_RESULT` on empty | FLOWING |
| `src/consolidation/corpus-promoter.ts` — `promoteScope` | `scopedSchemaIds` | `stmtGetSchemasInScope.all(scope)` — live DB query with D-37 firewall | Yes — parameterized DB query returns live schema rows | FLOWING |
| `src/consolidation/corpus-generator.ts` — stubs | `stubs` | `stubStmt.all()` — `SELECT n.id, nd.slug FROM node n JOIN node_doc nd ...` | Yes — DB query; only fills empty (length=0) stubs | FLOWING |
| `src/consolidation/run-sleep-pass.ts` — marker scan | `markerRows` | `db.prepare("SELECT key FROM meta WHERE key LIKE 'pending-corpus-promotion:%'").all()` | Yes — parameterized LIKE scan; real DB rows | FLOWING |

---

### Behavioral Spot-Checks

Step 7b: SKIPPED for corpus-generation behaviors (require live LLM / sleep pass). Covered instead by the 26 unit tests and the orchestrator live run.

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 26 phase-32 unit tests pass | `npx vitest run tests/recall-scope-filter.test.ts tests/corpus-promoter-always-promote.test.ts tests/corpus-generator-landing.test.ts tests/ingest-project-corpus-trigger.test.ts` | 4 files / 26 tests / 0 failures | PASS |
| TypeScript clean | `npx tsc --noEmit` | (no output = clean) | PASS |
| D-S1 guard: topk.ts has no scope | `grep -n "scope" src/retrieval/topk.ts` | (no output) | PASS |

---

### Probe Execution

No `probe-*.sh` files declared or conventional for this phase. Phase is unit-tested; live verification was performed by the orchestrator against a WAL-safe DB copy and recorded in 32-03-SUMMARY.md. Step 7c: SKIPPED.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| RECALL-01 | 32-01-PLAN.md | `--scope <slug>` post-resolution provenance filter on `recense recall`; D-S1-safe (scope never enters ranking) | SATISFIED | `src/recall/index.ts:124,255-268`; `src/adapter/recall-cli.ts:81-88,171`; 5 tests green; topk.ts grep clean |
| RECALL-02 | 32-02-PLAN.md, 32-03-PLAN.md | Auto-corpus: `promoteScope` + landing-doc generation + both ingest trigger paths (deferred marker + inline `--consolidate`) + sleep-pass consume | SATISFIED | `corpus-promoter.ts:556-708`; `corpus-generator.ts:114-241`; `ingest-project-cli.ts:769-796,881-888`; `run-sleep-pass.ts:461-489`; `semantic-store.ts:456`; 21 tests green; live run on /Users/vtx/usage confirmed |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | — | — | — |

No TBD/FIXME/XXX markers in any file modified by this phase. No stub implementations, empty handlers, or hardcoded-empty returns in the phase deliverables.

**Operational note (pre-existing, not a phase-32 defect):** the headless-client process lingers after `generateDoc` / the sleep pass's `generateCorpusDocs` completes (open handle at 0% CPU). DB writes land correctly; the phase's wiring is not the cause. Affects all 18 corpus stubs / the Phase-28 `generateCorpusDocs` path. Logged as a follow-up item, not a gap for this phase.

---

### Human Verification Required

None — all three success criteria were verified. SC1 and SC2 are fully code-verifiable and confirmed by 26 passing unit tests. SC3 ("coherent project overview") required a live run, which the orchestrator performed and approved on 2026-06-20 against a WAL-safe copy of the live brain (24,064 chars / 148 citations, sectioned structure, schema-anchored with resolving citations). Task 3 gate recorded as "APPROVED" in 32-03-SUMMARY.md.

---

### Gaps Summary

No gaps. All three roadmap success criteria are verified:
- SC1 (scoped recall) — fully code-verifiable; VERIFIED
- SC2 (auto-promote+generate after sleep pass) — fully code-verifiable; VERIFIED
- SC3 (coherent overview quality) — requires live run; orchestrator confirmed APPROVED

Phase goal achieved.

---

_Verified: 2026-06-20T20:17:00Z_
_Verifier: Claude (gsd-verifier)_
