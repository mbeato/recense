---
phase: 32-project-recall-auto-corpus
plan: "01"
subsystem: recall
tags: [recall, scope-filter, RECALL-01, D-S1, D-01, provenance]
dependency_graph:
  requires: [src/recall/index.ts, src/db/semantic-store.ts, src/lib/scope.ts, src/adapter/recall-cli.ts]
  provides: [scope-filtered-recall]
  affects: [src/recall/index.ts, src/adapter/recall-cli.ts, tests/recall-scope-filter.test.ts]
tech_stack:
  added: []
  patterns: [post-resolution-member-filter, D-S1-scope-provenance-not-ranking, validate-before-lock-WR02]
key_files:
  created:
    - tests/recall-scope-filter.test.ts
  modified:
    - src/recall/index.ts
    - src/adapter/recall-cli.ts
decisions:
  - "Scope filter is a POST-RESOLUTION member filter (not a candidate prefilter) — preserves exact topk + schema-resolution path so scope provably never alters ranking (D-S1)"
  - "Members with no node_scope annotation treated as global (kept) — mirrors ambient-recall display rule D-S6"
  - "Empty-after-filter returns NULL_RESULT without LLM compose call (D-05 discretion)"
  - "resolveScope() is permissive — empty/missing --scope value resolves to undefined (no error, no lock acquired)"
  - "GLOBAL_SCOPE import added to recall/index.ts for the {slug, global} filter"
metrics:
  duration: "~4 minutes"
  completed: "2026-06-20"
  tasks: 2
  files_modified: 3
  files_created: 1
---

# Phase 32 Plan 01: Scope-Filtered Recall (RECALL-01) Summary

Post-resolution `--scope <slug>` provenance filter on `recense recall`. Returns only the named project's knowledge plus cross-cutting `global` facts; excludes all other named projects. Scope never enters ranking (D-S1 locked).

## What Was Built

**Task 1 (TDD: RED + GREEN): Scope filter in `RecallEngine.recall()`**

Added an optional third parameter `scope?: string` to `RecallEngine.recall()` in `src/recall/index.ts`. When set, after the full neighborhood is assembled (primary members from `abstracts` edges + single sideways `schema_rel` hop), the filter batch-reads node scopes via `store.getNodeScopes(memberIds)` and retains only members whose scope is the passed slug or `GLOBAL_SCOPE`. Members with no scope annotation (undefined) are kept as global.

The filter is applied after schema resolution (Case A/B) and topk — scope never enters `CandidateRetriever`. If the filtered neighborhood is empty, `NULL_RESULT` is returned without an LLM compose call.

`GLOBAL_SCOPE` is imported from `../lib/scope`.

**Task 2: `--scope` flag in `recall-cli.ts`**

Added `resolveScope()` helper that scans argv for `--scope`, returns the lowercased slug or undefined. Updated `resolveQuery()` to skip `--scope` and its value (same consume-flag+value branch as `--db`/`--query`) so positional query parsing is unaffected. `resolveScope()` is called in the validate-before-lock region (WR-02). Scope threaded to `engine.recall(query, 'recall-session', scope)`.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| ae17964 | test(32-01) | Add failing scope filter tests for RecallEngine.recall (RED) |
| f2ee5d5 | feat(32-01) | Add post-resolution scope filter to RecallEngine.recall (GREEN) |
| 042b1a4 | feat(32-01) | Parse --scope in recall-cli and thread to engine.recall |

## Test Coverage

`tests/recall-scope-filter.test.ts` — 5 tests, all green:

- **Test 1**: scope filter includes {slug, global} members, excludes other named-project members
- **Test 2**: no scope arg produces byte-identical neighborhood to baseline (two-arg callers unchanged)
- **Test 3**: returns NULL_RESULT (no LLM call) when all members are filtered out by scope
- **Test 4 (D-S1)**: schema resolution identical with/without scope when best cosine match is out-of-scope
- **Test 5 (D-S1 source guard)**: topk.ts contains no scope filtering reference in code

Full recall suites: `recall.test.ts` (10 tests) + `recall-scope.test.ts` (2 tests) + `ambient-recall.test.ts` (8 tests) — all 25 pass. `tsc --noEmit` clean.

## Verification

- `npx vitest run tests/recall-scope-filter.test.ts` — 5/5 green
- `npx vitest run tests/recall.test.ts tests/recall-scope.test.ts tests/ambient-recall.test.ts` — 20/20 green (no regressions)
- `npx tsc --noEmit` — clean
- `grep -n "scope" src/retrieval/topk.ts` — zero output (D-S1 confirmed)
- `src/recall/index.ts` contains `getNodeScopes` (line 257) and `GLOBAL_SCOPE` import (line 46)
- `src/adapter/recall-cli.ts` contains `resolveScope` function and `--scope` flag consumed in `resolveQuery()`

## Acceptance Criteria

- [x] RECALL-01 satisfied (SC1): scoped recall returns only the named project's facts plus global; other named projects excluded
- [x] Filter applied AFTER schema resolution + topk; ranking unchanged (D-S1)
- [x] Two-arg callers unchanged (`scope` is optional)
- [x] `tsc --noEmit` clean
- [x] All recall suites green

## Deviations from Plan

None — plan executed exactly as written. TDD RED/GREEN cycle followed per plan `tdd="true"` frontmatter.

## Known Stubs

None.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes added. The `--scope` flag is used only as an equality filter in the engine (never interpolated into SQL or shell — T-32-01 mitigated by the existing `getNodeScopes` parameterized query). D-S1 (T-32-02) asserted via source grep + behavioral test.

## TDD Gate Compliance

- RED gate: `ae17964` — `test(32-01)` commit with failing tests before implementation
- GREEN gate: `f2ee5d5` — `feat(32-01)` commit making tests pass

## Self-Check

Files exist:
- src/recall/index.ts — FOUND
- src/adapter/recall-cli.ts — FOUND
- tests/recall-scope-filter.test.ts — FOUND

Commits exist:
- ae17964 — FOUND (RED test commit)
- f2ee5d5 — FOUND (GREEN implementation commit)
- 042b1a4 — FOUND (Task 2 commit)

## Self-Check: PASSED
