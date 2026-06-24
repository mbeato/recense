---
phase: 37
slug: typed-predicate-edges-build
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-06-20
validated: 2026-06-22
---

> **Post-execution status (backfilled 2026-06-22 at v7.0 milestone close):** This contract was authored at plan time and left at `draft` after execution. Refreshed to reflect actual outcomes: all Wave-0 files exist, the typed-predicates + typed-traversal unit suites pass (38 tests, re-run 2026-06-22), the D-08 grep guard returns 0 mutation calls in `src/recall/`, and the TYPED-02f precision gate (37-04) cleared GO with founder D-04/D-05 sign-off (typed top-3 83.3% ≥ 75% AND lift +45.8pts ≥ +20pts; payload 3.8 vs 20 nodes; compose +63.9pts). Typed recall is live at 92% coverage (STATE.md).

# Phase 37 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `37-RESEARCH.md` §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | `vitest.config.ts` (root) |
| **Quick run command** | `npm test -- --run <pattern>` |
| **Full suite command** | `npm test -- --run` |
| **Build prerequisite** | `npm run build` (required before `.cjs` eval harnesses) |
| **Estimated runtime** | ~30–60 seconds (unit suite); eval harness is opt-in/longer |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --run <pattern>` for the touched module.
- **After every plan wave:** Run `npm test -- --run` (full unit suite).
- **Before `/gsd:verify-work`:** Full suite green + D-08 grep guard returns 0 hits.
- **Max feedback latency:** ~60 seconds for unit tiers (the precision eval harness is a separate, founder-gated step, not part of the per-commit loop).

---

## Per-Requirement Verification Map

> Task-level IDs are filled by the planner. This maps phase requirements → test type from RESEARCH §Validation Architecture.

| Req ID | Behavior | Wave | Test Type | Automated Command | File Exists | Status |
|--------|----------|------|-----------|-------------------|-------------|--------|
| TYPED-01a | `PREDICATES` closed set is exactly the 12 predicates | 0 | unit | `npm test -- --run typed-predicates` | ✅ | ✅ green |
| TYPED-01b | `parseTriples` drops out-of-vocab predicates | 0 | unit | `npm test -- --run typed-predicates` | ✅ | ✅ green |
| TYPED-01c | Consolidator emits typed edges via `upsertEdge` with `kind='relation'` | 1 | unit | `npm test -- --run consolidator` | ✅ | ✅ green |
| TYPED-01d | D-03 regression: merged-prompt claim count ≥ baseline × 0.85 | 1 | integration | `node scripts/eval/37-precision-harness.cjs --regression-only --dry-run` | ✅ | ✅ green |
| TYPED-02a | `getOutEdgesWithRel` returns the `rel` field | 0 | unit | `npm test -- --run semantic-store` | ✅ | ✅ green |
| TYPED-02b | `typedReach` returns only nodes reachable via the named predicate | 2 | unit | `npm test -- --run typed-traversal` | ✅ | ✅ green |
| TYPED-02c | Recall returns typed-path payload when cosine ≥ threshold | 2 | unit | `npm test -- --run recall-engine` (mock gloss embeddings) | ✅ | ✅ green |
| TYPED-02d | Recall falls back to schema-neighborhood when cosine < threshold | 2 | unit | `npm test -- --run recall-engine` | ✅ | ✅ green |
| TYPED-02e | Typed path never calls `upsertEdge`/`strengthen` (D-08 guard) | 2 | static / grep | `grep -rn 'upsertEdge\|strengthen' src/recall/` (0 mutation calls) | ✅ | ✅ green |
| TYPED-02f | Build gate PRIMARY: typed top-3% ≥ 75% AND lift ≥ +20pts | 3 | eval harness | `node scripts/eval/37-precision-harness.cjs` | ✅ | ✅ green (83.3% / +45.8pts, founder GO) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `src/model/typed-predicates.ts` — `PREDICATES`, `PRED_SET`, `parseTriples`, `Triple` (ported from spike `lib/vocab.ts`)
- [x] `src/db/semantic-store.ts::getOutEdgesWithRel` — new prepared statement + public method (critical landmine fix)
- [x] `src/lib/config.ts::predicateGlossThreshold` — new `EngineConfig` field + `DEFAULT_CONFIG` value (0.35)
- [x] `tests/typed-predicates.test.ts` — unit tests for `parseTriples`, closed-set assertion
- [x] `tests/typed-traversal.test.ts` — unit tests for `typedReach`
- [x] `scripts/eval/37-precision-harness.cjs` — build-gate harness scaffold (modeled on `replay-ku-harness.cjs`)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| D-05 query-set sign-off | TYPED-02f | Founder must accept the re-derived query set before the precision gate binds (anti-circularity, no-inflated-metrics) | Implementer drafts 20–30 predicate-balanced queries from the post-Wave-1 live-DB copy; founder reviews per-query and signs off; only then does Wave 3 gate run |
| GO/NO-GO merge decision | TYPED-02f | Deterministic PRIMARY metric is the gate; founder owns the final merge call with the numbers on the table (D-04) | Run harness, present typed-vs-untyped top-3% + lift + payload-size; founder confirms ≥75% AND +20pts before merge |

---

## Validation Sign-Off

- [x] All tasks have automated verify or a Wave 0 dependency
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING test files above
- [x] No watch-mode flags
- [x] Feedback latency < 60s for unit tiers
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-22 (backfilled at v7.0 close — unit suites green, D-08 guard clean, TYPED-02f gate cleared GO with founder D-04/D-05 sign-off)
