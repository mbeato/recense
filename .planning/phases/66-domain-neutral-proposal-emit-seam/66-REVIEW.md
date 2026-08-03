---
phase: 66-domain-neutral-proposal-emit-seam
reviewed: 2026-08-03T07:36:25Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - src/adapter/memory-ops.ts
  - src/adapter/recense-doctor.ts
  - src/adapter/serve-cli.ts
  - src/consolidation/action-proposal-sink.ts
  - src/consolidation/consolidator.ts
  - src/consolidation/run-sleep-pass.ts
  - src/db/action-proposal-store.ts
  - src/db/schema.ts
  - src/lib/config.ts
  - tests/action-proposal-contract.test.ts
  - tests/action-proposal-emission.test.ts
  - tests/action-proposal-sink.test.ts
  - tests/action-proposal-write-isolation.test.ts
  - tests/emission-hold-sentinel.test.ts
  - tests/online-llm-free-sentinel.test.ts
  - tests/proposal-routes.test.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 66: Code Review Report

**Reviewed:** 2026-08-03T07:36:25Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

Reviewed the Phase 66 proposal-emit seam end to end: the `ActionProposalSink` triad, `action_proposal` DDL (schema v17), deterministic `proposalId` hashing, the 9 `maybeEmitProposal` sites in `applyDecision`, the `/v1/proposals` routes, the approve/reject ops in `memory-ops.ts`, the doctor dimension, and all seven test files.

Verified sound (traced, not assumed):

- **Emission gate**: `maybeEmitProposal` gates on the imported `isEmissionEligible` (never a re-derived set); `EMISSION_ELIGIBLE_EVENT_TYPES` is exactly `{contradict_reconcile, contradict_append_new, contradict_force_destabilize}` — hold and oscillation excluded; all 9 sites gated uniformly. The narrowed Half B sentinel anchors correctly on the hold-only sub-branch (over-narrowing guard test confirms the extracted block contains `contradict_hold` and excludes `contradict_force_destabilize`).
- **Transaction atomicity**: `SQLiteActionProposalSink.emit` is fully synchronous and its store is built on the same DB handle as the per-episode `db.transaction`, so the proposal row commits/rolls back with the graph write; the atomicity test poisons `markConsolidated` and proves rollback of both artifacts.
- **id determinism**: `proposalId` hashes a locked 5-element `JSON.stringify` array; array encoding makes `null` vs `''` for `change_from` distinguishable and cross-field collision impossible; `belief_node_id` (random) and timestamps correctly excluded; `INSERT OR IGNORE` on the content-hash PK is exercised by real replay tests.
- **Route security**: auth (constant-time, before body read) precedes both proposal routes; id shape-checked (`/^[0-9a-f]{64}$/`) before any store call; all error details are fixed literals; sentinel tests prove `evidence_quote`/`entity_descriptor`/`change_to` never leak into 4xx/5xx bodies; all SQL uses bound parameters; `/v1/proposals` routes are LLM-free with `embedCount === 0` asserted.
- **Write isolation (static + runtime)**: `ActionProposalStore`'s only write statements touch `action_proposal`; the D-43-for-proposals two-layer sentinel is non-vacuous (planted offenders, anchor-presence assertions, byte-identical whole-table comparison over varied s/c values).
- **Dark knob**: `actionProposalSinkEnabled` defaults `false`; `run-sleep-pass` injects Noop when off; Consolidator constructor default is also Noop (two barriers), with a behavioral Noop test.

The defects found cluster on the approve/reject write path (check-then-act races that break the phase's own "durable refusal" and "re-delivery is a no-op" guarantees), a fail-open non-null assertion in the staleness gate, cross-module lifecycle interactions the DDL comment did not account for (eviction-sweep FK pinning, unbounded pending-list starvation), and a config-typing gap under the only documented enable path.

## Critical Issues

### CR-01: approve/reject status transitions are check-then-act — no re-check under the lock, unconditional UPDATE

**File:** `src/adapter/memory-ops.ts:573-640`, `src/db/action-proposal-store.ts:175-177,206-208`
**Issue:** All of `getById`, the `status !== 'pending'` check, and the EMIT-07 staleness classification run **before** `acquireLockWithRetry()`, and `updateStatus` is an unconditional `UPDATE action_proposal SET status=@status, updated_at=@now WHERE id=@id` — no `AND status='pending'` guard, no re-validation after the lock is held. Three concrete violations of the phase's own stated guarantees follow:

1. **Double-settle**: concurrent `approve` and `reject` on the same id both read `status='pending'` pre-lock, then serialize on the lock and both write. Both callers receive 200 with contradictory acks (`{status:'approved'}` and `{status:'rejected'}`); last writer wins. This directly breaks `ProposalNotPendingError`'s contract ("re-delivery on an already-terminal proposal is a no-op, EMIT-04's consumer-side half") — a consumer that acted on the 200 `approved` ack now disagrees with the stored terminal state.
2. **Non-durable refusal**: the D-10 comment says a stale refusal "writes a durable terminal status BEFORE throwing so re-delivery cannot resurrect a refused proposal." A concurrent `reject` that read `pending` before the stale-approve's `expired`/`superseded` write will overwrite that terminal status with `rejected` (and vice versa: a stale approve can overwrite a just-committed `rejected` with `expired`). The terminal status is not durable.
3. **Staleness TOCTOU**: the staleness inputs are read before the lock ("still before the lock, because it is a pure read") and never re-checked under it. The hourly sleep pass holds the same single-writer lockfile — it can acquire the lock between the `ok` verdict and the approve's lock acquisition, tombstone the belief (ordinary reconsolidation), release, and then the approve writes `approved` on a now-superseded proposal. The approve-time staleness refusal (EMIT-07/Pitfall 13, the phase's named guarantee) holds only up to this window; Phase 67's consumer would then execute an action from a superseded belief.

**Fix:** Make the transition compare-and-set and re-check staleness under the lock:
```ts
// action-proposal-store.ts — conditional transition
this.stmtUpdateStatusIfPending = db.prepare(`
  UPDATE action_proposal SET status = @status, updated_at = @now
  WHERE id = @id AND status = 'pending'
`);
transitionFromPending(id: string, status: ProposalStatus, nowMs: number): boolean {
  return this.stmtUpdateStatusIfPending.run({ id, status, now: nowMs }).changes === 1;
}

// memory-ops.ts approveProposal — do the decisive work under the lock
if (!(await acquireLockWithRetry())) throw new MemoryBusyError();
try {
  const proposal = proposalWriteStore.getById(id);
  if (!proposal) throw new ProposalNotFoundError(id);
  if (proposal.status !== 'pending') throw new ProposalNotPendingError(id, proposal.status);
  const inputs = proposalWriteStore.getStalenessInputs(id);
  const verdict = inputs === null
    ? 'entity_gone'                                  // fail closed — see WR-01
    : classifyProposalStaleness({ ...inputs, nowMs: realClock.nowMs() });
  if (verdict !== 'ok') {
    const terminal = verdict === 'expired' ? 'expired' : 'superseded';
    proposalWriteStore.transitionFromPending(id, terminal, realClock.nowMs());
    throw new ProposalStaleError(id, verdict);
  }
  if (!proposalWriteStore.transitionFromPending(id, 'approved', realClock.nowMs())) {
    throw new ProposalNotPendingError(id, proposalWriteStore.getById(id)!.status);
  }
  return { status: 'approved' };
} finally { releaseLock(); }
```
The pre-lock `getById` fast-fail can stay as an optimization, but the decisive check must repeat under the lock. Apply the same CAS to `rejectProposal` and the stale-terminal write. (D-43 write isolation is unaffected — the reads are already SELECT-only.)

## Warnings

### WR-01: fail-open `inputs!` non-null assertion — null staleness inputs classify as `ok`

**File:** `src/adapter/memory-ops.ts:586-588`
**Issue:** `getStalenessInputs` uses **inner** JOINs to `node` twice, so it returns `null` not only when the proposal is missing but when either referenced node row is gone. The comment "Cannot be null here: getById() above already proved the row exists" is false — `getById` touches only `action_proposal`. Worse, the failure mode is silent and fail-open: `classifyProposalStaleness({ ...inputs!, nowMs })` with `inputs === null` does **not** throw — `{ ...null }` spreads to `{}`, so `entityTombstoned`/`beliefTombstoned` are `undefined` (falsy) and `expiresAt <= nowMs` is `undefined <= n` → `false` → verdict `'ok'`. A proposal whose entity node no longer exists — the exact `entity_gone` case the gate exists for — gets **approved**. Today FK enforcement makes the row-deletion path unreachable on connections that ran `initSchema` (which is why this is a Warning, not a Blocker), but FKs are per-connection pragmas that the codebase's own migration pattern toggles off (v7/v11/v12/v13 table swaps), and any future `node` recreation that forgets `action_proposal` child handling orphans these rows silently.
**Fix:** Fail closed:
```ts
const inputs = proposalWriteStore.getStalenessInputs(id);
if (inputs === null) {
  // referenced node row gone — strictly worse than tombstoned
  proposalWriteStore.transitionFromPending(id, 'superseded', realClock.nowMs());
  throw new ProposalStaleError(id, 'entity_gone');
}
```
Alternatively use `LEFT JOIN` and treat a missing node as `tombstoned = true`.

### WR-02: `action_proposal` FKs silently and permanently block the eviction sweep; no proposal GC exists

**File:** `src/db/schema.ts:219-249`, interaction with `src/strength/decay.ts:198-239`
**Issue:** The DDL comment asserts FK safety because "SemanticStore.tombstone() sets a tombstoned flag rather than deleting, and no code path issues DELETE FROM episode" — but it omits the code path that **does** issue `DELETE FROM node`: `runEvictionSweep()` hard-deletes tombstoned, decayed nodes, and its child-wipe list (`edge`, `node_scope`, `node_temporal`, `node_insight` — the T-38-01 precedent) was not extended for `action_proposal`. Any node referenced by any proposal row (`entity_node_id` or `belief_node_id`) makes the per-node delete transaction throw `SQLITE_CONSTRAINT_FOREIGNKEY`, which the sweep's bare `catch {}` swallows — so the node is silently retried and re-failed on every pass, forever. Because proposal rows are never deleted (terminal `approved`/`rejected`/`expired`/`superseded` rows persist indefinitely; there is no TTL purge), the pin is permanent, and the belief nodes most likely to be referenced by proposals (tombstoned by reconcile/force-destabilize — the very events that emit) are precisely the sweep's targets. `surfaced_event` has the same shape, but there it is documented as deliberate (D-08 comment in decay.ts); here the DDL comment's safety claim is simply incomplete.
**Fix:** Either (a) add `DELETE FROM action_proposal WHERE entity_node_id = ? OR belief_node_id = ?` (or a terminal-status-only variant) to the sweep's child-wipe order before `stmtDeleteNode`, or (b) document the pin as deliberate in both the DDL comment and decay.ts, and add a terminal-row GC (e.g. delete terminal rows older than N × PROPOSAL_TTL_MS) so the pin set is bounded. At minimum correct the schema.ts comment to acknowledge `decay.ts` deletes nodes.

### WR-03: `listPending` starvation — expired rows are never transitioned and monopolize the LIMIT-100 window oldest-first

**File:** `src/db/action-proposal-store.ts:149-154,184-186`, `src/adapter/serve-cli.ts:520-534`
**Issue:** `listPending` selects `status='pending' ORDER BY created_at ASC LIMIT 100` with no `expires_at` filter. Nothing ever transitions a pending row to `expired` except an explicit approve attempt on that specific id (the D-10 refusal path). So rows past their 14-day TTL stay `pending` forever unless an operator happens to POST approve on each one, and because ordering is oldest-first, they occupy the *front* of the window. Once ≥100 stale pending rows accumulate (a consumer outage, a burst of low-value proposals, or simply time), every newer proposal becomes permanently invisible to `GET /v1/proposals` — the only list endpoint — while the visible 100 are all guaranteed-409 corpses. Per-stage logic is all correct; the cross-stage lifecycle (emit → list → settle) has no path that drains dead rows.
**Fix:** Either exclude expired rows from the read: `WHERE status = 'pending' AND expires_at > @now` (still leaving the durable transition to approve-time, per D-10), or lazily sweep before listing: `UPDATE action_proposal SET status='expired', updated_at=@now WHERE status='pending' AND expires_at <= @now` under the write lock. The read-filter variant preserves `listPending`'s lock-free read-only property.

### WR-04: `actionProposalSinkEnabled` missing from `SettingsFile.overrides` — the documented enable path works only via an untyped unknown-key passthrough

**File:** `src/lib/config.ts:1069-1085`, `src/adapter/settings-loader.ts:148-156`, `src/adapter/recense-doctor.ts:436-441`
**Issue:** The doctor's detail text instructs the operator to "set overrides.actionProposalSinkEnabled: true in settings.json to enable," but `SettingsFile['overrides']` is a `Pick` of six keys that does **not** include `actionProposalSinkEnabled`. It works at runtime only by accident: `sanitizeCoreGuardrail` copies all keys and the merge spreads them, so unknown JSON keys silently pass through — directly contradicting `isSettingsFileShape`'s own comment ("unknown keys in overrides are silently ignored by the spread," which is false). Consequences: (1) any typed writer of settings.json (`recense config`-style tooling) cannot set the knob without a cast; (2) the natural cleanup implied by the existing comment — validating overrides against the typed key set — would silently kill the only documented enable path while every test stays green (tests enable the sink by constructing it directly, never through `loadMergedConfig`); (3) the same passthrough means arbitrary settings.json keys can override *any* `EngineConfig` field (pre-existing, but this phase is the first to make an undocumented-key passthrough load-bearing).
**Fix:** Add `'actionProposalSinkEnabled'` to the `Pick` in `SettingsFile.overrides`, and fix the stale `isSettingsFileShape` comment. Ideally add one test that goes settings.json → `loadMergedConfig` → `runConsolidation`-level sink selection so the documented path is exercised.

## Info

### IN-01: `ActionProposalStore.db` and `.clock` are dead fields

**File:** `src/db/action-proposal-store.ts:118-131`
**Issue:** Both are stored in the constructor and never referenced afterwards (`updateStatus` takes `nowMs` from the caller; statements are prepared from the constructor's local `db` parameter). Dead state invites the false impression that the store timestamps its own writes.
**Fix:** Drop the fields (keep the constructor parameters if the signature is contractual, or remove `clock` entirely — three call sites pass it).

### IN-02: `applySecondaryContradiction` JSDoc asserts the opposite of reality

**File:** `src/consolidation/consolidator.ts:1741`
**Issue:** "T-02-ASYNC: pure sync method (no await); never called inside a db.transaction." It is *only ever* called inside the per-episode `db.transaction` (via `applyDecision`, consolidator.ts:1160-1176,1517-1521). The actual invariant is "sync, so it is *safe* inside a transaction." Misleading doc on a threat-model line is how the next reader draws the wrong conclusion about where writes may go.
**Fix:** Reword to "pure sync method (no await) — safe to call inside the per-episode db.transaction, where it always runs."

### IN-03: contract test derives ids with a different serialization than the locked `proposalId` encoding

**File:** `tests/action-proposal-contract.test.ts:95-104`
**Issue:** `makeRecord` builds ids as `sha256(JSON.stringify({ entity_node_id, field, from, to, evidence_episode }))` — object form with different key names — while the frozen contract (`proposalId`, action-proposal-sink.ts:79-92) locks a 5-element *array* encoding that Phase 67's reference consumer must reproduce exactly. The test's local hash is functionally fine for its own assertions, but a consumer author copying from the contract test (its stated audience) would ship a wrong id derivation.
**Fix:** Have `makeRecord` import and use the real `proposalId()` (it already accepts the needed `Pick`), or add a comment stating this local hash is deliberately NOT the contract encoding.

---

_Reviewed: 2026-08-03T07:36:25Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
