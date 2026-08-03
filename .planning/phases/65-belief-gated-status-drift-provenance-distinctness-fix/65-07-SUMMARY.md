---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 07
subsystem: consolidation
tags: [gmail, provenance, session-id, pe-gate, structural-guard, vitest]

# Dependency graph
requires:
  - phase: 65-01
    provides: "The D-02 session-id/sessionId consumer audit and its LOCKED verdict (65-SESSION-ID-AUDIT.md)"
  - phase: 65-03
    provides: "provenanceDistinctnessEnabled dark config knob"
  - phase: 65-06
    provides: "NormalizedRecord.provenance_key + Gmail adapter threading (invariant 7)"
provides:
  - "PRIMARY-shape sessionId mint at src/adapter/ingest-cli.ts:188 consuming NormalizedRecord.provenance_key"
  - "DRIFT-03 locked pair (D-07) asserted directly on the real countDistinctProvenance mechanism, keys built from the real deriveGmailProvenanceKey"
  - "End-to-end proof of the mint in both switch positions plus the non-gmail control (tests/ingest-cli.test.ts)"
  - "DRIFT-01 structural lock (tests/pe-machinery-lock.test.ts): normalized-body source pin over routeContradiction/isOscillation, exact node/edge column-set pin, bi-temporal/supersedes token ban across node/edge/episode, four-value PE config pin"
affects: [65-08, "Belief-Gated Status Drift + Provenance-Distinctness Fix (phase close)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Normalized-function-body source pin (comment/whitespace-tolerant) read from disk at test time, mirroring tests/no-ats-domain-table.test.ts / tests/src-import-boundary.test.ts's exported-predicate + non-vacuousness shape"
    - "Provenance-distinctness locked-pair tests build entries via the real derivation function, never hand-written key strings"

key-files:
  created:
    - tests/pe-machinery-lock.test.ts
  modified:
    - src/adapter/ingest-cli.ts
    - tests/update-decision.test.ts
    - tests/ingest-cli.test.ts

key-decisions:
  - "VERDICT implemented verbatim: PRIMARY (richer sessionId minted at ingest), per 65-SESSION-ID-AUDIT.md's ## VERDICT section — decision rule's two conditions (zero other value-semantic consumers, zero content-inspecting passthrough consumers) were both satisfied."
  - "The FALLBACK shape (optional provenance_key field on PendingContradiction, schema migration, consolidator threading) was NOT implemented — only one shape executes per the plan's branching instruction."
  - "episode table is pinned against the bi-temporal token list only, not an exact column set, because the unselected FALLBACK verdict would have added a nullable provenance_key sidecar column there — the guard stays correct under either verdict without per-plan re-derivation."

patterns-established:
  - "DRIFT-01 machinery lock: any future PR touching routeContradiction/isOscillation/PE bands or adding a bi-temporal/supersedes column now fails a dedicated, non-vacuous structural test instead of relying on review discipline alone."

requirements-completed: [DRIFT-01, DRIFT-03]

duration: 25min
completed: 2026-08-02
---

# Phase 65 Plan 07: Wire Provenance-Distinctness Mint + Pin DRIFT-01 Machinery Summary

**PRIMARY-shape sessionId mint wired at the single ingest-cli.ts call site so `countDistinctProvenance` can finally exceed 1 on Gmail-only evidence, with the D-07 locked pair proven on the real mechanism and a non-vacuous DRIFT-01 structural lock shipped.**

## Verdict Implemented

**PRIMARY** (richer `sessionId` minted at ingest), read verbatim from `65-SESSION-ID-AUDIT.md`'s `## VERDICT` section:

> **Shape selected:** PRIMARY (richer sessionId minted at ingest)

The FALLBACK shape (optional `provenance_key` field threaded through `PendingContradiction`, a schema migration, and consolidator changes) was **not** implemented — the plan's branching instruction is exclusive-or, and the audit's decision rule (zero other `value-semantic` consumers, zero content-inspecting `passthrough` consumers) selected PRIMARY.

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-02T23:14:xx (worktree base correction) 
- **Completed:** 2026-08-02T23:22:42Z
- **Tasks:** 3 completed
- **Files modified:** 4 (1 source, 3 test — 1 new)

## Accomplishments

- `src/adapter/ingest-cli.ts`'s `appendBatch` mint now honors `r.provenance_key` when the adapter supplies one, falling back to the collapsed per-source literal otherwise — a single expression change, exactly as scoped by the PRIMARY branch.
- The DRIFT-03 "D-07 locked pair" now lands on the real `countDistinctProvenance` function (previously only proven at the key-derivation layer in `tests/provenance-key.test.ts`), with keys built via the real `deriveGmailProvenanceKey` rather than hand-written strings — a derivation regression now fails both suites.
- End-to-end proof in `tests/ingest-cli.test.ts`: driving the real `runPullPhase` with a fake Gmail adapter produces three distinct counted session ids when the per-message keys are independent, one collapsed id when they share the dark-off literal, and the non-gmail control still mints `'ingest:granola'` byte-identically. A content-identity assertion proves the dark switch affects provenance only.
- DRIFT-01 shipped as an executable test (`tests/pe-machinery-lock.test.ts`): `routeContradiction` and `isOscillation` are pinned by normalized (comment/whitespace-tolerant) body read from disk at test time; `node`/`edge` column sets are pinned exactly; `node`/`edge`/`episode` are scanned for eight bi-temporal/supersedes token names; the four PE-related `DEFAULT_CONFIG` values are pinned. All pins are non-vacuous (planted-offender checks go through the same exported helpers).

## Task Commits

1. **Task 1: Wire the LOCKED shape from the 65-01 audit verdict** - `824812c` (feat)
2. **Task 2: Land the D-07 locked pair on countDistinctProvenance and prove the mint end to end** - `2fae0fc` (test)
3. **Task 3: Pin DRIFT-01 — the PE machinery and the schema column set** - `11a0f0c` (test)

_Task 2 and Task 3 are `tdd="true"` but production code was already correct after Task 1 (PRIMARY leaves `countDistinctProvenance` byte-unchanged); their "RED" phase is the mutation checks below, not a failing-test-before-code cycle in the traditional sense._

## Files Created/Modified

- `src/adapter/ingest-cli.ts` — mint expression changed to `r.provenance_key ?? \`ingest:${r.source}\`` with a comment block naming the fallback, dark-switch equivalence, D-03 forward-only limitation, and the byte-unchanged mechanism claim.
- `tests/update-decision.test.ts` — new `describe('DRIFT-03 locked pair (D-07)')` nested inside the existing `countDistinctProvenance` block: direction A (3 distinct sender-domain+thread keys → 3), direction B (3 forwards of one thread → 1), pre-phase regression (collapsed key → 1), D-19-preserved (inferred entry with a fresh distinct key still → 3), and mixed Gmail/Claude-Code session-id cardinality (→ 4).
- `tests/ingest-cli.test.ts` — new `describe('runPullPhase — provenance_key mint end to end ...')`: enabled (3 distinct), disabled (1 collapsed, byte-equal to `'ingest:gmail'`), non-gmail control (`'ingest:granola'`), and a content-identity assertion across enabled/disabled runs.
- `tests/pe-machinery-lock.test.ts` (new) — `normalizedFunctionBody` + `findBitemporalTokenViolations` exported pure helpers, pinned expected bodies for `routeContradiction`/`isOscillation`, exact `node`/`edge` column-set pins, `BITEMPORAL_TOKENS` scan across `node`/`edge`/`episode`, and the four-value PE config pin. 9 test cases (≥8 required).

## Decisions Made

- Implemented PRIMARY exactly as specified — single-expression change, no touch to `src/lib/types.ts`, `src/consolidation/update-decision.ts`, `src/db/schema.ts`, `src/ingest/pipeline.ts`, `src/db/episode-store.ts`, or `src/consolidation/consolidator.ts` (all verified byte-unchanged via `git diff`).
- `episode`'s bi-temporal-token pin is deliberately token-list-only, not an exact column set — documented inline in the test as the FALLBACK-verdict asymmetry, per the plan's explicit instruction.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria satisfied on the first implementation pass; no Rule 1–4 fixes were needed.

## Mutation Check Results (required by Task 2 + Task 3 acceptance criteria)

1. **Mutation check #1 (Task 2):** Temporarily reverted `ingest-cli.ts`'s mint back to the plain `` `ingest:${r.source}` `` literal (no `provenance_key` consumption). The end-to-end enabled case (`tests/ingest-cli.test.ts`, "enabled: three independent Gmail records...") FAILED as expected (`expected 1 to be 3`). Reverted via exact byte-for-byte restore (confirmed `git diff --stat` empty); test re-ran green.
2. **Mutation check #2 (Task 2):** Temporarily removed the `origin !== 'inferred'` guard from `countDistinctProvenance` (unconditional `sessions.add(entry.session_id)`). The D-19 case (`tests/update-decision.test.ts`, "D-19 preserved...") FAILED as expected (`expected 4 to be 3`). Reverted via exact byte-for-byte restore; test re-ran green.
3. **Mutation check (Task 3):** Temporarily changed `peReconcileBandLow`'s comparison in `routeContradiction` from `<` to `<=`. The source pin (`tests/pe-machinery-lock.test.ts`, "routeContradiction matches its pinned normalized body") FAILED as expected (string mismatch on the flipped operator). Reverted via exact byte-for-byte restore; test re-ran green (9/9).

All three mutations were applied and reverted via file-copy round-trips (`cp` to a scratch backup, `sed`/`Edit`, then `cp` the backup back), with `git diff --stat` confirming zero net diff after each revert before continuing.

## Issues Encountered

None.

## Known Stubs

None — no new UI surfaces, no hardcoded empty/placeholder values introduced by this plan.

## Threat Flags

None — all threat-model dispositions from the plan's `<threat_model>` section (T-65-07-FARM, T-65-07-D19, T-65-07-HALFWIRE, T-65-07-BITEMP, T-65-07-MACHINERY, T-65-07-MIGRATE) are mitigated by the work described above; T-65-07-HALFWIRE and T-65-07-MIGRATE are FALLBACK-only threats that do not apply under the PRIMARY verdict actually implemented.

## User Setup Required

None — no external service configuration required.

## Collateral Verification

- `npm run typecheck` exits 0.
- `npx vitest run tests/update-decision.test.ts tests/ingest-cli.test.ts tests/pe-machinery-lock.test.ts tests/ingest.test.ts tests/ingest-cli-multiaccount.test.ts tests/episode-event-ts.test.ts tests/schema.test.ts tests/schema-v12-migration.test.ts tests/store.test.ts tests/consolidation.test.ts tests/consolidator.test.ts tests/session-id-provenance-consumers.test.ts` — 247/247 pass, no collateral regression.
- `git diff src/consolidation/update-decision.ts` — empty (zero net changes; both mutation checks were reverted byte-for-byte).
- **Out-of-scope, pre-existing:** a full `npx vitest run` also surfaced 23 failures across 7 files (`tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`, `tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`, `tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`, `tests/locomo-scorer.test.ts`). Root cause confirmed unrelated to this plan: these tests `spawnSync` compiled artifacts under `dist/` (e.g. `dist/src/adapter/turn-capture-cli.js`), and `dist/` is gitignored and does not exist in this worktree (no build step was run). None of these files import or exercise `src/adapter/ingest-cli.ts`, `src/consolidation/update-decision.ts`, or `src/db/schema.ts`. Logged here per the scope-boundary rule; not fixed (would require an unrelated `npm run build` step outside this plan's task list).

## Next Phase Readiness

- The mint is wired and the mechanism-level locked pair proves `countDistinctProvenance` can now exceed 1 on Gmail-only evidence when `provenanceDistinctnessEnabled` is flipped on — the hard prerequisite Phase 65's remaining plans (drift-layer wiring, `ClaimDecision` drift fields, per-source `contradictionN` lookup, sink changes — all explicitly deferred to 65-08 by this plan) depend on.
- DRIFT-01 is now enforced by a shipped test, not just review discipline — safe to build 65-08's drift-layer work on top without accidentally reopening the PE-gate-unmodified or no-new-data-model guarantees.
- No blockers.

---
*Phase: 65-belief-gated-status-drift-provenance-distinctness-fix*
*Completed: 2026-08-02*

## Self-Check: PASSED

- FOUND: src/adapter/ingest-cli.ts
- FOUND: tests/update-decision.test.ts
- FOUND: tests/ingest-cli.test.ts
- FOUND: tests/pe-machinery-lock.test.ts
- FOUND commit 824812c (feat: wire PRIMARY sessionId mint)
- FOUND commit 2fae0fc (test: D-07 locked pair + e2e proof)
- FOUND commit 11a0f0c (test: DRIFT-01 machinery lock)
