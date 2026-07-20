# Phase 48: Correctness Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-27
**Phase:** 48-correctness-hardening
**Mode:** `--auto` (autonomous, recommended defaults selected)
**Areas discussed:** Phase framing (verify-vs-build), HARD-04 model-stamp shape, Regression-test style, HARD-02 concurrency-test approach

---

## Phase framing — verify-first vs. greenfield build

| Option | Description | Selected |
|--------|-------------|----------|
| Verify-first, close only real gaps | Audit each guard against live code (3 of 4 already implemented per grep), build only the genuine gap, add mandated regression tests | ✓ |
| Build all four from scratch | Treat REQUIREMENTS.md "Pending" status as literal; re-implement all guards | |

**Auto-selected:** Verify-first (recommended default).
**Notes:** Live-source grep on 2026-06-27 found M-9 guard (`schema.ts:607-623`), M-5 `.immediate()` on `txUpsertNode` (`semantic-store.ts:288-295`), and L-2 dims stamp (`semantic-store.ts:374-391`) all already present with explicit issue-code comments. REQUIREMENTS.md / ARCH-REVIEW drifted behind code. Per CLAUDE.md "live code wins" rule, the phase is audit-then-close + regression tests. Only genuine code gap: embedding `model` stamp (HARD-04).

---

## HARD-04 model-stamp shape

| Option | Description | Selected |
|--------|-------------|----------|
| Mirror existing dims path | Add `embedding_model` meta key, stamp on first embed, assert fail-closed on mismatch in `setEmbedding` — same shape as `embedding_dims` | ✓ |
| New config surface / separate guard module | Introduce a dedicated provider-identity guard with config knobs | |

**Auto-selected:** Mirror existing dims path (recommended default).
**Notes:** Single new meta key, single-writer site, no migration. Lowest-risk surgical change.

---

## Regression-test style

| Option | Description | Selected |
|--------|-------------|----------|
| Per-item, colocated, reproduces exact failure | One focused vitest per requirement next to the unit under test, each reproducing the named failure mode | ✓ |
| Single broad integration test | One end-to-end test exercising all four | |

**Auto-selected:** Per-item colocated (recommended default).
**Notes:** "Each with a regression test" is a hard roadmap requirement; per-item tests map 1:1 to requirements and pinpoint regressions.

---

## HARD-02 concurrency-test approach

| Option | Description | Selected |
|--------|-------------|----------|
| Assert IMMEDIATE mode / no SQLITE_BUSY_SNAPSHOT | Assert the write txn opens `.immediate()` (or a focused two-connection no-throw test) rather than a timing-dependent race | ✓ |
| Live WAL upgrade-race reproduction | Spawn concurrent writers to force the original race | |

**Auto-selected:** Assert IMMEDIATE mode (recommended default).
**Notes:** Avoids flaky timing-dependent tests; the lock discipline is what's under test, not a race outcome.

---

## Claude's Discretion

- Test file placement/naming and whether HARD-03's test extends an existing schema test or adds a new file.
- Whether HARD-01's audit surfaces a residual D-17 fast-path gap requiring a code change vs. test-only.

## Deferred Ideas

- ARCH-REVIEW M-4 (SDK timeouts), L-6 (hard-keep pinning), H-2 (poison-episode isolation), H-4 (lockfile hardening) — out of Phase 48's four-item scope.
- Content-ingestion hardening (`content-hardening-deferred.md`) — separate concern, own phase.
