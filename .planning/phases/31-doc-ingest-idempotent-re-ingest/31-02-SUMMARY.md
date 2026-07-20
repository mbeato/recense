---
phase: 31-doc-ingest-idempotent-re-ingest
plan: "02"
subsystem: ingest-project-cli
tags: [cursor, fingerprint, idempotency, reingest, REINGEST-01, REINGEST-02]
dependency_graph:
  requires: [Phase 31 Plan 01 (emitDocEpisodes + collectDocPaths)]
  provides: [git/mtime fingerprint, SemanticStore cursor skip-gate, --force flag, D-07 dup-rate gate tests]
  affects: [src/adapter/ingest-project-cli.ts, tests/ingest-project-reingest.test.ts]
tech_stack:
  added: []
  patterns: [spawnSync arg-array form (T-31-INJECT), SemanticStore cursor (T-31-CURSOR), deferred cursor commit (RQ3), mtime fallback (D-67 pattern)]
key_files:
  created: []
  modified:
    - src/adapter/ingest-project-cli.ts
    - tests/ingest-project-reingest.test.ts
decisions:
  - "gitFingerprint uses arg-array spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD']) — never shell string, never cwd trick (T-31-INJECT)"
  - "cursor uses new SemanticStore(db, realClock, config) on SAME db handle as EpisodicStore — NOT EpisodicStore (T-31-CURSOR)"
  - "cursor committed AFTER runSurveyAndFeed succeeds, BEFORE db.close() — deferred commit (RQ3 crash safety)"
  - "dry-run path returns early before opening DB → never writes cursor (D-09)"
  - "git status --porcelain error treated as clean (T-31-GITERR) to avoid false re-survey loop; --force is the escape hatch"
  - "D-07 gate tests use MockModelProvider (deterministic) — proves wiring, not model behavior"
metrics:
  duration: "~20 minutes"
  completed: "2026-06-20"
  tasks_completed: 3
  files_changed: 2
  commits: 6
---

# Phase 31 Plan 02: Idempotent Re-ingest via SemanticStore Cursor Summary

Makes `recense ingest-project <dir>` idempotent: a second run on an unchanged repo skips the expensive agentic survey structurally (fingerprint cursor match), and a changed-fact re-ingest reconciles in place via the PE-gated judge rather than minting duplicates.

## What Was Built

**`gitFingerprint(dir)`** — calls `spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], ...)` (arg-array form, T-31-INJECT) to get the HEAD sha; then `git status --porcelain` for dirty status; returns `null` for non-git dirs. Exported from `ingest-project-cli.ts`.

**`computeProjectFingerprint(dir, docPaths)`** — wraps gitFingerprint; returns `git:<sha>:<clean|dirty>` for git repos or `mtime:<maxMtimeMs>` over docPaths for non-git dirs (mirrors ObsidianAdapter D-67 pattern). Exported.

**`force: boolean` in `IngestArgs`** — parsed from `--force` flag in `parseIngestArgs`. Usage string updated.

**SemanticStore cursor skip-gate** — wired into BOTH real-run branches (`--consolidate` + default):
- `new SemanticStore(db, realClock, config)` on the SAME db handle (T-31-CURSOR)
- `getMeta('cursor:project:<scope>')` → compare with current fingerprint
- If unchanged AND !force → skip survey, print "survey skipped (unchanged)"
- After survey succeeds: `setMeta('cursor:project:<scope>', fingerprint)` (deferred commit, RQ3)
- dry-run branch returns before opening DB → cursor never written (D-09)

**D-07 dup-rate gate tests** — two deterministic tests in `tests/ingest-project-reingest.test.ts`:
1. "unchanged re-run yields zero new consolidated beliefs" — cursor skip → 0 new survey calls → 0 new nodes after second consolidation
2. "changed fact reconciles in place (tombstone+new, not duplicate)" — MockModelProvider contradict verdict → old node tombstoned, exactly 1 live new node with updated value, FK-clean

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 RED | Failing fingerprint + --force tests | fb16fe5 |
| 1 GREEN | gitFingerprint + computeProjectFingerprint + force flag | 1f81b01 |
| 2 RED | Cursor skip-gate tests T-31-CURSOR-1 through T-31-CURSOR-4 | 8e25ab8 |
| 2 GREEN | SemanticStore cursor wired into both real-run branches | 21e25d6 |
| 3 | D-07 dup-rate gate tests (unchanged + changed-fact reconcile) | 62bfb83 |

## Verification

- `npx tsc --noEmit`: exits 0 (0 lines output)
- `npx vitest run tests/ingest-project-reingest.test.ts`: 27/27 pass
- `npx vitest run tests/ingest-project-cli.test.ts`: 21/21 pass (no regression)
- `grep -n "spawnSync('git'" src/adapter/ingest-project-cli.ts`: lines 183 + 191 (arg-array form, T-31-INJECT verified)
- `grep -n "new SemanticStore(" src/adapter/ingest-project-cli.ts`: lines 660 + 729 (2 hits, one per real-run branch)
- `grep -n "cursor:project:" src/adapter/ingest-project-cli.ts`: getMeta hits (663, 732) + setMeta hits (694, 763)

## Deviations from Plan

None — plan executed exactly as written. The TDD sequence (RED → GREEN per task) was followed. The dry-run path uses Research RQ3 option (b) — skip the cursor check entirely rather than opening a DB just to read it (simpler, D-09 compliant).

## Known Stubs

None — all cursor paths are fully wired. The fingerprint is computed from real git/mtime state; the cursor is stored in the real SemanticStore meta table.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundaries introduced. All surfaces match the plan's threat model:
- T-31-INJECT: arg-array form verified by grep (lines 183, 191); never shell string
- T-31-CURSOR: SemanticStore confirmed (grep lines 660, 729); EpisodicStore NOT passed to getMeta/setMeta
- T-31-DRYCURSOR: dry-run returns before DB open; setMeta never called (tested T-31-CURSOR-3)
- T-31-GITERR: git status error treated as clean (line 195 comment)
- T-31-SC: no new npm packages; child_process + fs are Node built-ins

## Self-Check: PASSED

Files exist:
- `src/adapter/ingest-project-cli.ts`: FOUND (modified)
- `tests/ingest-project-reingest.test.ts`: FOUND (modified)

Commits exist:
- fb16fe5: FOUND
- 1f81b01: FOUND
- 8e25ab8: FOUND
- 21e25d6: FOUND
- 62bfb83: FOUND
