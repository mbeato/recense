---
phase: 64-entity-resolution-hardening
reviewed: 2026-08-03T00:25:42Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/consolidation/consolidator.ts
  - src/consolidation/entity-resolution.ts
  - src/lib/config.ts
  - tests/consolidation-resolution.test.ts
  - tests/entity-resolution.test.ts
  - tests/intent-conservation.test.ts
  - tests/intent-source-gate.test.ts
  - tests/resolution-conservation.test.ts
  - tests/resolution-sentinels.test.ts
findings:
  critical: 0
  warning: 2
  info: 5
  total: 7
status: issues_found
---

# Phase 64: Code Review Report

**Reviewed:** 2026-08-03T00:25:42Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Reviewed the Phase 64 entity-resolution hardening diff (base `7fafac8..HEAD`): the hoisted `gmailSourced` gate, the new standalone `EntityResolver`, the two config knobs, the resolution branch in `consolidate()`, and all five new/extended test suites. Verification performed during review: all 55 tests in the six suites pass; `tsc --noEmit` is clean; `entity-resolution.ts` has zero `await`s, zero write-primitive calls, and no `ModelProvider` import (the two "ModelProvider" occurrences at lines 24 and 146 are comment prose only, matching the stated intent); `grep` confirms no ungated `claim.intent_*` fill site remains in consolidator.ts.

Load-bearing invariants were traced adversarially and hold:

- **Gate correctness (WR-01/D-10):** all three claim-side fill sites (fast-path confirm consolidator.ts:824-826, auto-unrelated :922-924, pendingJudges push :948-950) are gated on `gmailSourced`; the post-judge fill site (:1014-1016) inherits from site 3 and carries an explicit non-compensating warning. The gate at :716 sits textually after the inferred/echo/hitl hard stop at :706 and inherits it by construction. gmail episodes use the bare-array extraction path (`isTypedExtractionSource` excludes gmail), so the merged-parse path cannot bypass the gate.
- **Index alignment:** `decisionSlots[i]` ↔ `claims[i]` ↔ `claimVecs[i]` holds on every route, including the pendingJudges `slotIdx` round-trip; the resolution branch's `vec: claimVecs[i]` (consolidator.ts:1041) is correctly aligned.
- **All-or-nothing (D-07):** `claimResolvedEntityId`/`claimResolvedEntityDescriptor` are assigned only together at the single write point (consolidator.ts:1048-1049); tested over a mixed hit/abstain pass with a non-vacuity check.
- **Read-only (D-12):** the resolver's only SQL is two SELECT prepared statements; both filter `tombstoned = 0`; `resolveEntityByName`'s three ladder statements also filter tombstoned; the exact-channel result is re-filtered by node type before inclusion.
- **Clamping/determinism:** `Math.max(0, cosineSimF32(...))` plus the `Number.isFinite` guard keeps scores in [0,1], making the `entityResolutionFloor > 1.0` dark-off switch structurally unreachable; the resolve sort tie-breaks by id, so repeat runs over unchanged state are deterministic.
- **Inertness (D-08/D-09):** the two-pass snapshot tests, schema-column negative tests, and payload scans confirm no DB schema change and no persisted delta from resolution firing vs. not firing (within the blind spots noted in WR-02 below).
- **Zero net-new LLM/embed calls (D-04):** type-level (no provider in the constructor) plus the runtime call-count parity sentinel.

No blockers found. Two warnings concern guard/test completeness — the enforcement mechanisms are hand-maintained subsets of the contracts they claim to enforce — plus five informational items.

## Warnings

### WR-01: D-12 read-only source-guard regex is a hand-maintained subset of the write API

**File:** `tests/entity-resolution.test.ts:307`
**Issue:** The "review-blocking" source guard strips comments and asserts absence of `/upsertNode|upsertEdge|\.strengthen\(|\.tombstone\(|db\.transaction/`. But the actual write surface reachable from `EntityResolver`'s dependencies (`db`, `SemanticStore`) is larger: `setEmbedding`, `recordContradiction`, `upsertNodeTemporal`, `upsertNodeScope`, `db.exec`, and raw `INSERT`/`UPDATE`/`DELETE` text inside a `db.prepare(...)` string are all invisible to this guard. A future edit adding `store.setEmbedding(...)` or `db.prepare('UPDATE node SET ...')` to the resolver would sail through the tripwire that the file's header declares review-blocking. This is the guard-set != contract-set drift pattern: D-12's prose contract ("its only SQL is two read-only prepared SELECTs") is strictly broader than what the test enforces.
**Fix:**
```ts
const forbidden = /upsertNode|upsertEdge|upsertNodeTemporal|setEmbedding|recordContradiction|\.strengthen\(|\.tombstone\(|db\.transaction|db\.exec/;
expect(forbidden.test(stripped)).toBe(false);
// Enforce SELECT-only SQL directly, not just by API-name blocklist:
for (const m of stripped.matchAll(/\.prepare\(\s*`([^`]*)`/g)) {
  expect(m[1]!.trim().toUpperCase().startsWith('SELECT')).toBe(true);
}
```

### WR-02: Inertness snapshot has two blind spots — numeric columns are never compared, and id-normalization can mask id-substitution leaks

**File:** `tests/resolution-conservation.test.ts:137-228, 487-533`
**Issue:** The strengthened `snapshotDb` compares `COUNT(*)`, the `value`/`content` column, `payload`, and (for `consolidation_event`) id-normalized TEXT columns. Two classes of resolution-conditional leak would pass both two-pass tests despite the "byte-for-byte identical" claim:
1. **Numeric columns are omitted entirely.** `node.s`, `node.c`, `node.last_access`, `edge.w`, and `consolidation_event.magnitude` (REAL, so excluded from the TEXT-column concatenation) are never snapshotted. A hypothetical bug of the shape "when resolved, strengthen the resolved entity" (the exact self-confirmation class the project's correctness constraints name) would leave counts and text columns identical between the resolving and dark-off arms and pass both conservation tests.
2. **`<ID>` normalization masks id substitution.** Because `node_id`/`candidate_id`/`episode_id` are normalized to a presence marker, a bug that substituted `claimResolvedEntityId` for `bestCandidateId` in a sink emit (or in `strengthen`'s target) produces `<ID>` in both arms and compares equal. The direct entityId scan at :524-532 covers only `payload`, not the id-shaped columns.
Neither leak exists today (verified by reading `applyDecision` — resolved fields are consumed nowhere), so this is a robustness gap in the guard, not a live defect. But this file self-describes as the review-blocking D-09 inertness guard, so its blind spots are in scope.
**Fix:** (a) Add a numeric projection to `snapshotDb`, e.g. `SELECT s, c FROM node ORDER BY value` and `SELECT w FROM edge ORDER BY src, dst` (values keyed by deterministic columns, ids excluded). (b) In the payload-scan test, assert the resolved `entityId` appears in **no** column of `consolidation_event`:
```ts
const evRows = h.db.prepare(`SELECT * FROM consolidation_event`).all() as Array<Record<string, unknown>>;
for (const row of evRows) {
  for (const v of Object.values(row)) {
    if (typeof v === 'string') expect(v).not.toContain(entityId);
  }
}
```

## Info

### IN-01: "FTS table absent" catch comment overstates the degradation path

**File:** `src/consolidation/entity-resolution.ts:159-164, 210-213`
**Issue:** The catch around `stmtFtsCandidates.all()` claims to handle "FTS table absent," but `db.prepare` compiles eagerly in the constructor — if `node_fts` does not exist at construction time, `new EntityResolver(...)` throws inside the `Consolidator` constructor, before any catch is reachable. Only post-construction drops (the scenario the unit test exercises via `DROP TABLE node_fts`) degrade gracefully. In practice this adds no new failure mode — `CandidateRetriever` (topk.ts:345) and the consolidator's own `stmtBm25Candidates` (consolidator.ts:350) already eagerly prepare against `node_fts`, so boot already requires the table — but the comment describes a guarantee the code does not provide.
**Fix:** Reword the comment to "MATCH syntax error or table dropped after construction — graceful degradation," or wrap the prepare in a lazy/nullable initialization if construction-time absence should genuinely degrade.

### IN-02: Dense channel emits zero-evidence candidates and counts them in `channelCounts.dense`

**File:** `src/consolidation/entity-resolution.ts:241-252`
**Issue:** `scored.slice(0, k)` keeps candidates whose cosine is exactly 0 (e.g. zero-norm stored embeddings, or orthogonal vectors). These are merged with `channels: ['dense']` and counted in `denseCount` despite carrying no dense evidence, and their lex scores can participate in the margin check. Direction of error is abstention (safe per D-05), but Phase 65's DRIFT-05 measurement consumes these counters — `dense=k` on a pass where the dense channel contributed nothing skews the per-channel attribution data the counters exist to provide.
**Fix:** Filter before slicing: `const top = scored.filter(s => s.dense > 0).slice(0, k);`

### IN-03: Entities minted earlier in the same episode are invisible to that episode's resolution

**File:** `src/consolidation/consolidator.ts:1029-1055`
**Issue:** The resolution branch runs in Phase A, before this episode's Phase B transaction. If one gmail episode's extraction yields both an entity claim (which will mint "Acme Corp" via the unrelated route in Phase B) and an intent claim whose descriptor is "Acme Corp", resolution abstains this pass — the node does not exist yet at resolve time. This is a forced consequence of the T-02-ASYNC architecture and errs toward abstention, so it is correct; it is worth recording because Phase 65's measurement will observe a systematic first-contact abstain for every newly-seen company, which should not be misread as a resolver precision problem.
**Fix:** No code change. Note the first-contact abstain pattern in Phase 65's DRIFT-05 measurement notes.

### IN-04: LIKE-wildcard metacharacters in email-controlled descriptors reach `resolveEntityByName`'s contains rung

**File:** `src/consolidation/entity-resolution.ts:187` (via `src/db/semantic-store.ts:196-201`)
**Issue:** `claimIntentEntity` originates from email content (attacker-influenceable via the extraction model). The exact channel passes it to `resolveEntityByName`, whose third rung interpolates it into `LIKE '%' || LOWER(@name) || '%'` — `%`/`_` in the descriptor act as wildcards (bound param, so no SQL injection; this is match-semantics smuggling only). Traced impact: a wildcard-matched node enters only the *candidate* pool; the final decision still requires `max(lex, dense) >= 0.75` against the raw descriptor plus the margin, which an unrelated wildcard match cannot clear — the confident-or-null gate neutralizes the vector. Pre-existing surface (Phase 37), not introduced by this diff; recorded for completeness since Phase 64 is the first place an email-derived string reaches this rung.
**Fix:** Optional hardening in `semantic-store.ts`: escape `%`/`_` in `@name` with an `ESCAPE` clause.

### IN-05: Dead comment in the embed-count sentinel

**File:** `tests/resolution-sentinels.test.ts:518-519`
**Issue:** "Override embed to the zero fn (makeCountingProvider's embed already returns zero vectors but let's keep it explicit...)" — no override follows; the code uses `makeCountingProvider`'s embed as-is. The comment describes an action the code does not take.
**Fix:** Delete the first sentence of the comment or reduce it to "makeCountingProvider's embed returns zero vectors, giving the auto-unrelated route."

---

_Reviewed: 2026-08-03T00:25:42Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
