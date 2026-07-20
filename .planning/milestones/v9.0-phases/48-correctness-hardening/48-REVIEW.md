---
phase: 48-correctness-hardening
reviewed: 2026-06-27T00:00:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - src/db/semantic-store.ts
  - tests/store.test.ts
  - tests/consolidation.test.ts
  - tests/schema.test.ts
findings:
  critical: 0
  warning: 3
  info: 1
  total: 4
status: issues_found
---

# Phase 48: Code Review Report

**Reviewed:** 2026-06-27
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Phase 48 introduces a single production change (`embedding_model` stamp+assert guard in `setEmbedding`) and four regression tests (3 for HARD-04, 1 for HARD-02). The production change is **correctly implemented**: it mirrors the existing `embedding_dims` guard exactly — null/first-write stamps the meta key, mismatch throws fail-closed, same value is a no-op, ordering is after dims check and before the embedding write, signature unchanged, no false-positive on the happy path. No blockers in the production code.

Two findings concern the HARD-02 IMMEDIATE-mode spy test's soundness: the assertion threshold is underspecified (can be satisfied by unrelated transactions) and the `markSkipped` Phase-B path mentioned in the comment is never exercised. One finding is a missing jsdoc update. One info item is stale version comments in schema.test.ts (pre-existing, visible because the file is in scope).

---

## Warnings

### WR-01: HARD-02 spy — assertion `>= 1` can be satisfied by unrelated post-patch transactions (vacuous pass risk)

**File:** `tests/consolidation.test.ts:1770-1814`

**Issue:** The spy wraps `h.db.transaction` starting from inside the test body. All Harness components (`h.store`, `h.episodes`, `h.strength`, `h.retriever`) are constructed in `makeHarness()` which runs in `beforeEach()` — before the test body and before the spy. Their pre-constructed better-sqlite3 `Transaction` objects call native `.immediate()` directly; those calls are **invisible** to the spy because they bypass the patched `db.transaction` wrapper entirely.

The Consolidator and `makeNoOpSchemaInducer(h)` are constructed inside the test body, after the spy is installed. Any `h.db.transaction(fn)` calls they make in their constructors return a `wrappedTxn` whose `.immediate` is intercepted. If `SchemaInducer`'s constructor (or the Consolidator's constructor for non-Phase-B bookkeeping) creates a transaction that later calls `.immediate()`, `immediateCallCount` reaches 1 independently of whether the Phase-B per-episode write transaction uses IMMEDIATE.

In that scenario the assertion `expect(immediateCallCount).toBeGreaterThanOrEqual(1)` passes even though the Phase-B transaction never called `.immediate()`. The test provides no proof that Phase-B specifically uses IMMEDIATE — it only proves that *some* post-patch-constructed transaction called `.immediate()`.

**Fix:** Tighten the assertion or restructure to distinguish Phase-B calls. One approach: capture the Consolidator's Phase-B transaction object specifically (e.g., via a named wrapper logged by the spy) and assert that transaction used `.immediate()`. Alternatively, count how many times `.immediate()` fires and assert a minimum that can only be reached by Phase-B (e.g., `>= 2` if both Phase-B transactions fire in the same scenario), or add a comment explaining exactly which transaction object is being counted and why the count cannot be satisfied by unrelated callers.

---

### WR-02: HARD-02 spy — `markSkipped` Phase-B path is never exercised

**File:** `tests/consolidation.test.ts:1757-1815`

**Issue:** The test comment names two Phase-B transactions that must use IMMEDIATE: "markSkipped at :507" and "the per-episode graph write at :953-969". The test episode has `salience: 0.8` and `hard_keep: 0`. The harness config has `consolSkipThreshold: 0.2` (line 124). Since `0.8 > 0.2`, the episode is **not** skipped — the `markSkipped` transaction at :507 never fires.

The `toBeGreaterThanOrEqual(1)` assertion can only ever count calls from the per-episode write path (at best). The `markSkipped` path is entirely untested, despite being explicitly listed in the comment as a covered invariant.

**Fix:** Add a second sub-test (or a second episode in the same test) with `salience: 0.1, hard_keep: 0` and assert that `immediateCallCount` increases after the pass, proving that the skip path also uses IMMEDIATE. Example:

```typescript
// After the normal-salience episode, add a sub-threshold episode to cover markSkipped
h.episodes.append({
  content: 'low-salience skip episode',
  origin: 'observed',
  salience: 0.1,  // below consolSkipThreshold=0.2 → markSkipped fires
  hard_keep: 0,
  role: 'user',
  session_id: 'session-hard02-skip',
});
await consolidator.consolidate();
// Now immediateCallCount should reflect both Phase-B paths
expect(immediateCallCount).toBeGreaterThanOrEqual(2);
```

---

### WR-03: `setEmbedding` jsdoc not updated for HARD-04 model-stamp guard

**File:** `src/db/semantic-store.ts:365-375`

**Issue:** The existing jsdoc explicitly documents L-1 (stale-vector guard) and L-2 (embedding dims stamp/assert) but is silent about the new HARD-04 `embedding_model` stamp+assert added in this phase. A caller reading only the method contract would not know `setEmbedding` also validates that `config.openaiEmbedModel` matches the stored model and throws on mismatch.

This matters because: (a) callers integrating a new embedding provider model need to know they must update the meta key (e.g., via a migration step) before the first `setEmbedding` call, not just change the dims; (b) the throw message references `embedding provider model changed` but the doc never mentions a model-consistency contract exists.

**Fix:** Add to the existing jsdoc block:

```typescript
 * HARD-04 / L-2: stamp embedding model — first call writes `embedding_model` to meta;
 * subsequent calls assert `config.openaiEmbedModel` matches. Throws on mismatch to
 * catch provider model changes before any mixed-model vector is stored.
```

---

## Info

### IN-01: Stale inline comments in schema.test.ts say `SCHEMA_VERSION (8)` — actual version is 14

**File:** `tests/schema.test.ts:80, 93`

**Issue:** Two `initSchema(db)` call-sites carry the comment `// stamps SCHEMA_VERSION (8)`. The schema version has since advanced to 14 (asserted at line 24: `expect(SCHEMA_VERSION).toBe(14)`). These comments are misleading — a reader of the downgrade-guard or upgrade-path tests sees a wrong version number that contradicts the assertion at the top of the describe block.

These comments are pre-existing and were not introduced by phase 48 (the diff only added the block comment above the downgrade guard test). Flagged because the file is in scope.

**Fix:** Change both occurrences to `// stamps current SCHEMA_VERSION` or `// stamps SCHEMA_VERSION (14)`.

---

_Reviewed: 2026-06-27_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
