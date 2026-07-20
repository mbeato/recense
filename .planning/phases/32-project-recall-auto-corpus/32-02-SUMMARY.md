---
phase: 32-project-recall-auto-corpus
plan: "02"
subsystem: corpus-promotion
tags: [corpus, promoter, landing-doc, always-promote, scope-anchored, tdd]
dependency_graph:
  requires:
    - 31-01 (doc-ingest with node_scope tagging on facts)
    - 28-03 (CorpusPromoter.promote + Phase B transaction discipline)
    - 28-06 (generateCorpusDocs schema-chapter path)
    - 27-02 (generateDoc project-scope path + writeDoc fill-in-place)
  provides:
    - CorpusPromoter.promoteScope(scope) — scope-anchored always-promote bypass
    - generateCorpusDocs landing-doc path — fills slug=scope stubs via generateDoc
  affects:
    - 32-03 (trigger wiring: ingest → promoteScope + generateCorpusDocs)
tech_stack:
  added: []
  patterns:
    - TDD (RED/GREEN per task)
    - Single IMMEDIATE transaction (T-02-ASYNC)
    - D-37 firewall (inferred members excluded from scope identification)
    - Idempotent stub reuse via stmtGetLiveDocForSlug
    - Additive containment edges (not wipe-and-rebuild) to coexist with organic promote()
key_files:
  created:
    - tests/corpus-promoter-always-promote.test.ts
    - tests/corpus-generator-landing.test.ts
  modified:
    - src/consolidation/corpus-promoter.ts
    - src/consolidation/corpus-generator.ts
decisions:
  - "promoteScope is ADDITIVE (not wipe-and-rebuild): it re-writes landing→chapter edges on every call rather than managing the global doc_containment cache; organic promote() owns the wipe-and-rebuild and will preserve or re-derive these edges on its next pass"
  - "Landing-doc slug = the project scope string (not a schema id); chapter-doc slug = schemaId — Pitfall 4 distinction preserved; node_doc.slug and node_scope.scope both = scope for landing docs"
  - "stmtGetSchemasInScope uses DISTINCT + subquery existence check to find schemas with at least one D-37-gated member in scope S — same firewall as promote()'s stmtGetSchemaMembersWithValues"
  - "generateCorpusDocs replaces schema-only INNER-JOIN with a broader ALL-live-empty-stubs query + per-stub classification (slug→schema? → schema path : landing path) to mirror generate-doc-cli.ts dispatch"
  - "Failure log message preserved as 'failed for schema <slug>' for backward compatibility with existing corpus-generator.test.ts assertions"
metrics:
  duration: ~12 minutes
  completed: "2026-06-20"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 2
---

# Phase 32 Plan 02: Scope-Anchored Always-Promote + Landing Doc Generation Summary

Scope-anchored always-promote bypass (D-04) + landing-doc generation routing — the mechanism that guarantees a freshly-onboarded project scope is fully browsable in the Reader after a single sleep pass, without a manual `recense generate-doc` step.

## What Was Built

**Task 1: `CorpusPromoter.promoteScope(scope, opts?)` (RED: c4a8b3d, GREEN: db1059c)**

Added a public `promoteScope` method to `CorpusPromoter` implementing the D-04 scope-anchored always-promote bypass. For a given project scope S:

- Phase A (read-only): refuses early if `scope === GLOBAL_SCOPE` or empty (D-04 bound). Uses a new `stmtGetSchemasInScope` prepared statement (D-37-gated: same firewall as existing Phase A) to find schemas with at least one abstracted member tagged `node_scope = S`.
- Phase B (single `this.db.transaction().immediate()`, NO await — T-02-ASYNC): creates chapter-doc stubs (mirrors the existing eager-stub block exactly: upsertNode → FTS delete → upsertNodeDoc{slug=schemaId} → upsertNodeScope{scope=schemaId}) and a landing-doc stub (slug = scope string, NOT a schemaId — Pitfall 4 distinction). Writes `doc_containment` edges from landing→chapter (w=1.0, deterministic onboarding spine).
- Idempotent: `stmtGetLiveDocForSlug` reuses existing stubs by slug.
- D-43 safe: writes ONLY type='doc' nodes + doc→doc edges; never touches source schemas' s/c/abstracts.

5 test behaviors covered (bypass gate, containment edges, organic gate regression, idempotent + GLOBAL guard, D-43 self-confirmation). All 27 tests in the combined promoter suite pass.

**Task 2: `generateCorpusDocs` landing-doc path (RED: f163cf1, GREEN: 35b8e77)**

Extended `generateCorpusDocs` in `corpus-generator.ts` to fill landing-doc stubs (slug = project scope string) in addition to schema-chapter stubs:

- Replaced the schema-only `INNER-JOIN slug → schema node` stub query with a broader query selecting ALL live empty doc stubs (`type='doc', tombstoned=0, length(value)=0`).
- Added per-stub classification: `stmtSchemaForSlug.get(slug)` → if the slug is a live schema node → existing schema-chapter path (computeSchemaCentroid + generateDocForSchema); else → new landing-doc path (`generateDoc(deps, slug)`).
- Mirrors the dispatch in `generate-doc-cli.ts:149-166` exactly.
- Per-doc try/catch isolation, maxDocs cap, and deferred accounting unchanged.
- Fill-in-place via existing `writeDoc` (stable-edge invariant: doc_containment edges from promoteScope are preserved after prose is filled).

3 test behaviors covered (landing filled in place, schema path regression, per-doc isolation). All 12 tests in the combined generator suite pass.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| c4a8b3d | test(32-02) | Add failing tests for promoteScope always-promote bypass (RED) |
| db1059c | feat(32-02) | Add promoteScope to CorpusPromoter — scope-anchored always-promote bypass (D-04) |
| f163cf1 | test(32-02) | Add failing tests for generateCorpusDocs landing-doc extension (RED) |
| 35b8e77 | feat(32-02) | Extend generateCorpusDocs to fill landing-doc stubs via project-scope generateDoc |

## TDD Gate Compliance

RED/GREEN cycle was followed for both tasks:

1. Task 1 RED: `c4a8b3d` — 5 test behaviors defined, 7 tests failing (`promoteScope is not a function`)
2. Task 1 GREEN: `db1059c` — 27 tests passing (all promoter suite)
3. Task 2 RED: `f163cf1` — 3 test behaviors defined, 3 tests failing (landing stub not selected by current query)
4. Task 2 GREEN: `35b8e77` — 39 tests passing (full verification suite)

## Deviations from Plan

None — plan executed exactly as written.

The D-04 "re-add vs wipe" design choice was noted in the plan action ("choose and document") — chosen: promoteScope re-adds landing→chapter edges on every call (additive, idempotent) rather than wiping the global cache. This lets it coexist with organic `promote()`'s wipe-and-rebuild without coordination. The organic pass may overwrite these edges on its next run, but `promoteScope` runs again on the next ingest/sleep cycle so they are restored. Documented as a key decision.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. All writes are internal to the DB (type='doc' nodes + doc→doc edges). T-32-BYP (always-promote bypass) mitigated by GLOBAL_SCOPE guard + scope filtering. T-32-TX (transaction discipline) satisfied: single IMMEDIATE, no await. T-32-SCONF (self-confirmation) satisfied: D-43 guard asserted by Test 5.

## Self-Check

PASSED — verified below.
