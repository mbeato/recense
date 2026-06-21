---
phase: 37
slug: typed-predicate-edges-build
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-20
---

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
| TYPED-01a | `PREDICATES` closed set is exactly the 12 predicates | 0 | unit | `npm test -- --run typed-predicates` | ❌ W0 | ⬜ pending |
| TYPED-01b | `parseTriples` drops out-of-vocab predicates | 0 | unit | `npm test -- --run typed-predicates` | ❌ W0 | ⬜ pending |
| TYPED-01c | Consolidator emits typed edges via `upsertEdge` with `kind='relation'` | 1 | unit | `npm test -- --run consolidator` | ❌ W0 | ⬜ pending |
| TYPED-01d | D-03 regression: merged-prompt claim count ≥ baseline × 0.85 | 1 | integration | `node scripts/eval/37-precision-harness.cjs --regression-only --dry-run` | ❌ W0 | ⬜ pending |
| TYPED-02a | `getOutEdgesWithRel` returns the `rel` field | 0 | unit | `npm test -- --run semantic-store` | ❌ W0 | ⬜ pending |
| TYPED-02b | `typedReach` returns only nodes reachable via the named predicate | 2 | unit | `npm test -- --run typed-traversal` | ❌ W0 | ⬜ pending |
| TYPED-02c | Recall returns typed-path payload when cosine ≥ threshold | 2 | unit | `npm test -- --run recall-engine` (mock gloss embeddings) | ❌ W0 | ⬜ pending |
| TYPED-02d | Recall falls back to schema-neighborhood when cosine < threshold | 2 | unit | `npm test -- --run recall-engine` | ❌ W0 | ⬜ pending |
| TYPED-02e | Typed path never calls `upsertEdge`/`strengthen` (D-08 guard) | 2 | static / grep | `grep -rn 'upsertEdge\|strengthen' src/recall/` (0 hits) | ✅ | ⬜ pending |
| TYPED-02f | Build gate PRIMARY: typed top-3% ≥ 75% AND lift ≥ +20pts | 3 | eval harness | `node scripts/eval/37-precision-harness.cjs` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/model/typed-predicates.ts` — `PREDICATES`, `PRED_SET`, `parseTriples`, `Triple` (ported from spike `lib/vocab.ts`)
- [ ] `src/db/semantic-store.ts::getOutEdgesWithRel` — new prepared statement + public method (critical landmine fix)
- [ ] `src/lib/config.ts::predicateGlossThreshold` — new `EngineConfig` field + `DEFAULT_CONFIG` value (0.35)
- [ ] `tests/typed-predicates.test.ts` — unit tests for `parseTriples`, closed-set assertion
- [ ] `tests/typed-traversal.test.ts` — unit tests for `typedReach`
- [ ] `scripts/eval/37-precision-harness.cjs` — build-gate harness scaffold (modeled on `replay-ku-harness.cjs`)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| D-05 query-set sign-off | TYPED-02f | Founder must accept the re-derived query set before the precision gate binds (anti-circularity, no-inflated-metrics) | Implementer drafts 20–30 predicate-balanced queries from the post-Wave-1 live-DB copy; founder reviews per-query and signs off; only then does Wave 3 gate run |
| GO/NO-GO merge decision | TYPED-02f | Deterministic PRIMARY metric is the gate; founder owns the final merge call with the numbers on the table (D-04) | Run harness, present typed-vs-untyped top-3% + lift + payload-size; founder confirms ≥75% AND +20pts before merge |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING test files above
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s for unit tiers
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
