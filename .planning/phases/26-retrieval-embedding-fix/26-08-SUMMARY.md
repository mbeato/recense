---
phase: 26-retrieval-embedding-fix
plan: "08"
subsystem: consolidation
tags: [fact-dedup, dedup, tombstone, remediation, pollution-exclusion]
dependency_graph:
  requires: [entity-dedup (Phase 25)]
  provides: [fact-level dedup pass, recense dedup-facts CLI]
  affects: [src/consolidation, src/adapter, src/consolidation/sink.ts]
tech_stack:
  added: []
  patterns: [union-find clustering, normalizeValue blocking, cosineSimF32, tombstone-only, FK-safe edge rewire]
key_files:
  created:
    - src/consolidation/fact-dedup.ts
    - src/adapter/dedup-facts-cli.ts
    - tests/fact-dedup.test.ts
  modified:
    - src/consolidation/sink.ts (added 'fact_merge' to ConsolidationEventType)
    - src/adapter/recense.ts (dispatcher case + usage line)
decisions:
  - "Used 'fact_merge' as the event_type (not 'entity_merge') — distinct audit trail for fact vs entity merges"
  - "POLLUTION_PATTERNS covers SUBCHECK_OK, exit-code-0, completed-with-status shapes surfaced in 26-DIAGNOSIS-V3.md M2"
  - "FactDedup deliberately omits sidecar inheritance (node_scope / node_temporal) — fact nodes do not use those sidecars; EntityDedup D-06 sidecar step is not carried over to keep the engine minimal"
metrics:
  duration: "~25 min"
  completed: "2026-06-18"
  tasks_completed: 2
  tasks_deferred: 1
  files_created: 3
  files_modified: 2
---

# Phase 26 Plan 08: Fact-Level Dedup Pass Summary

**One-liner:** Fact-node dedup engine with SUBCHECK_OK/exit-code-0 pollution exclusion, tombstone-only merges, FK-safe edge rewire — `recense dedup-facts` CLI with --dry-run default.

---

## What Was Built

### Task 1: FactDedup engine (committed 4f9faab)

`src/consolidation/fact-dedup.ts` — `class FactDedup` generalizing `EntityDedup` to `type='fact'` nodes:

- **Same machinery as EntityDedup:** union-find transitive clustering (D-03), `normalizeValue` blocking bucket (D-01), `cosineSimF32 >= threshold` confirmation, degree-based canonical selection (D-05), FK-safe rewire-then-tombstone per-cluster `.immediate()` transaction, `PRAGMA foreign_key_check` assertion (D-08), dry-run zero-write path (D-11).
- **Fact-specific change — pollution exclusion (D-05):** `isSelfIngestionPollution(value)` predicate filters out self-ingestion artifacts BEFORE bucketing. Patterns matched: `SUBCHECK_OK`, "Task … completed/executed … exit code 0", "completed with status". These inflated the V3 152-pair count (26-DIAGNOSIS-V3.md M2) and are not real beliefs. Excluded from candidate set only — NOT tombstoned (cleanup of ~747 polluted episodes is a separate TODO).
- **Tombstone-only:** losers get `store.tombstone()`, NEVER `DELETE FROM node` (D-09).
- **Repeatable:** second run is a no-op because tombstoned nodes are excluded from the live snapshot (D-02).
- **Provenance:** `fact_merge` event emitted per merged pair (D-10).
- **Added `'fact_merge'` to `ConsolidationEventType`** in `src/consolidation/sink.ts`.

`tests/fact-dedup.test.ts` — 17 tests (all passing):
- dry-run tombstones 0, real run tombstones losers + keeps canonical + rewires edges
- pollution exclusion: SUBCHECK_OK, exit-code-0, completed-with-status pairs NOT clustered
- repeatability (second run = no-op)
- tombstone-not-delete (loser row exists with tombstoned=1)
- FK clean (PRAGMA foreign_key_check empty)
- canonical selection (highest-degree node wins)
- origin guard (mid-reconciliation node never merged)
- provenance event (fact_merge type)
- transitive cluster (A~B + B~C → single canonical)
- distinct facts NOT clustered

### Task 2: dedup-facts CLI + dispatcher (committed d1dfda6)

`src/adapter/dedup-facts-cli.ts` — mirrors `dedup-entities-cli.ts` exactly, wrapping `FactDedup`:
- `--dry-run` is the DEFAULT (T-25-06 / T-26-19); real write requires `--no-dry-run`
- `--threshold <n>` overrides default 0.88; `--db <path>` or `RECENSE_DB` env selects DB
- File lock guard (`acquireLock`); `LOG_PATH = /tmp/recense-dedup-facts.log`
- `require.main === module` guard for subprocess dispatch isolation
- NOT wired into the hourly sleep pass (opt-in only)

`src/adapter/recense.ts` — dispatcher wired:
- `case 'dedup-facts': spawnScript('dedup-facts-cli.js', process.argv.slice(3)); break;`
- `dedup-facts` added to the Commands usage line

### Task 3: DEFERRED (blocking checkpoint:human-verify)

The live-write run against `~/.config/recense/recense.db` is a **blocking human checkpoint** per the plan (`type="checkpoint:human-verify" gate="blocking"`). The engine and CLI are fully built and tested on scratch DBs. The real-write run has NOT been executed.

**To proceed:**
1. Back up the live DB: `cp ~/.config/recense/recense.db ~/.config/recense/recense.db.bak-$(date +%Y%m%d)`
2. Dry-run on the live DB: `node dist/src/adapter/recense.js dedup-facts --dry-run`
3. Review proposed clusters — confirm they are real duplicate beliefs (not pollution, not distinct facts)
4. If clusters look correct: `node dist/src/adapter/recense.js dedup-facts --no-dry-run`
5. Verify: `sqlite3 ~/.config/recense/recense.db "PRAGMA foreign_key_check;"` → empty; second `--no-dry-run` → 0 tombstoned; spot-check recall

---

## Verification

### Build
`npm run build` — clean (tsc + postbuild). 0 errors.

### Tests
`npx vitest run tests/fact-dedup.test.ts` — 17/17 passed.

### Acceptance criteria (Task 1)
- `grep -c "class FactDedup" src/consolidation/fact-dedup.ts` → 1 ✓
- `grep -Ec "type *= *'fact'" src/consolidation/fact-dedup.ts` → 2 ✓
- `grep -Eic "SUBCHECK_OK|exit code|self.?ingest|pollut" src/consolidation/fact-dedup.ts` → 18 ✓
- `grep -c "store.tombstone\|tombstone(" src/consolidation/fact-dedup.ts` → 2 ✓
- `grep -c "DELETE FROM node" src/consolidation/fact-dedup.ts` → 0 ✓
- `grep -c "foreign_key_check" src/consolidation/fact-dedup.ts` → 3 ✓

### Acceptance criteria (Task 2)
- `grep -c "dedup-facts" src/adapter/recense.ts` → 3 ✓
- `grep -c "FactDedup" src/adapter/dedup-facts-cli.ts` → 5 ✓
- `grep -Ec "dry.?run" src/adapter/dedup-facts-cli.ts` → 10 ✓
- `grep -c "require.main === module" src/adapter/dedup-facts-cli.ts` → 2 ✓
- `grep -c "RECENSE_DB\|--db" src/adapter/dedup-facts-cli.ts` → 3 ✓

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing type] Added 'fact_merge' to ConsolidationEventType**
- **Found during:** Task 1 implementation (`npm run build` error TS2322)
- **Issue:** `sink.ts` `ConsolidationEventType` union did not include `'fact_merge'`; emitting it in `fact-dedup.ts` caused a type error
- **Fix:** Added `| 'fact_merge'` to the union in `src/consolidation/sink.ts` alongside the existing `'entity_merge'` entry
- **Files modified:** `src/consolidation/sink.ts`
- **Commit:** 4f9faab

**2. FactDedup omits sidecar inheritance (D-06)**
- **Found during:** Task 1 — deliberate decision, not a bug
- **Reason:** Fact nodes do not use `node_scope` or `node_temporal` sidecars. Carrying over EntityDedup's D-06 sidecar step would add dead code. Noted as a deviation for clarity.
- **Impact:** None — fact nodes have no sidecars to inherit

---

## Known Stubs

None. The engine and CLI are fully functional. The live-write run is gated behind a human checkpoint (Task 3), which is by design (T-26-19, gated-live-write-needs-real-offswitch).

---

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries introduced. The `fact_merge` addition to `ConsolidationEventType` is a type extension within the existing consolidation_event table — no schema migration needed (the column is `TEXT`).

---

## Self-Check

### Files exist
- src/consolidation/fact-dedup.ts — FOUND
- src/adapter/dedup-facts-cli.ts — FOUND
- tests/fact-dedup.test.ts — FOUND
- src/consolidation/sink.ts (modified) — FOUND
- src/adapter/recense.ts (modified) — FOUND

### Commits exist
- 4f9faab — feat(26-08): FactDedup engine — fact-node clustering with pollution exclusion
- d1dfda6 — feat(26-08): opt-in recense dedup-facts CLI + dispatcher wiring

## Live Write — COMPLETED 2026-06-18 (orchestrator)

Checkpoint approved by Max ("back up + real write", then explicit go for the `--no-dry-run`). Backup taken (`~/.config/recense/recense.db.bak-20260618-135202`, 74M) before the write.

- `recense dedup-facts --no-dry-run`: **44 cluster(s) merged, 50 node(s) tombstoned**
- Live fact nodes: 4054 → **4004** active
- `PRAGMA foreign_key_check`: **empty (FK-clean)**
- Tombstone-only: losers persist with `tombstoned=1` (nothing deleted) — D-06 preserved
- Repeatable: second `--no-dry-run` = **0 cluster / 0 node** (no-op) ✓
- Recall: identical result on backup (pre) vs live (post) — **no regression** (the null inference is the pre-existing RETR-01 sub-0.7 behavior, present in both)

RETR-03 delivered: residual exact-dup fact nodes collapsed on the live graph; opt-in CLI remains for future runs (not wired into the hourly sleep pass).

## Self-Check: PASSED
