---
phase: 38-stored-reflections-derived-insights
verified: 2026-06-22
status: passed_with_open_item
score: REFLECT-01 verified; REFLECT-02 mechanism verified, eval-win UNMEASURED (dark by design, founder activation pending)
backfilled: true
backfill_note: "Authored 2026-06-22 at v7.0 milestone close. Phase 38 executed (38-02/03/04 SUMMARYs; 38-01 has no SUMMARY) but no phase-level VERIFICATION.md was written. This backfill records the live-source evidence and is explicit, per the no-inflated-metrics rule, that REFLECT-02's compose-token win is unmeasured."
---

# Phase 38: Stored Reflections / Derived Insights — Verification Report (backfilled)

**Phase Goal:** Make "reasons over schemas" a durable mechanism — the offline pass reflects over schema clusters and stores derived-insight nodes (`origin=inferred`, non-strengthening, confidence-capped) (REFLECT-01); recall returns a precomputed insight in place of re-synthesizing N facts at compose time, cutting tokens (REFLECT-02).
**Verified:** 2026-06-22 (backfilled at v7.0 close)
**Status:** passed_with_open_item — REFLECT-01 fully verified; REFLECT-02 mechanism verified but its token-win is UNMEASURED and ships DARK.
**Evidence basis:** gsd-integration-checker live-source verification (2026-06-22), 38-02/03/04-SUMMARY.md, `scripts/eval/results/38-insight-tokens.json`.

## Goal Achievement

| # | Truth (ROADMAP Success Criteria) | Status | Evidence |
| --- | --- | --- | --- |
| REFLECT-01 | Offline pass generates derived-insight nodes from schema clusters with `origin=inferred`, `training_eligible=0`, a confidence ceiling; they decay and NEVER strengthen the facts they summarize (self-confirmation guard) | ✓ VERIFIED | `src/consolidation/insight-reflector.ts:363-366` — `upsertNode({type:'insight', origin:'inferred', s:0.1})`. `src/db/semantic-store.ts:312-315` — `training_eligible = (origin !== 'inferred' && …)` → inferred insights always `training_eligible=0`. `src/strength/decay.ts:162` — `if (claimOrigin === 'inferred') return` → `strengthen()` no-ops on insights. `InsightReflector.reflect()` called at consolidator.ts:855 inside `consolidate()` (Phase C: promote → reflect → eviction), reachable only from `run-sleep-pass.ts` — offline-only. **D-43 holds:** zero `strengthen`/`setEmbedding`/`upsertNode`-on-member calls in insight-reflector.ts; members are read-only. |
| REFLECT-02 | Recall surfaces a relevant stored insight in place of/ahead of raw member facts where it answers the query, measurably reducing compose-time tokens on the harness with no quality regression | ⚠ MECHANISM VERIFIED / WIN UNMEASURED | Mechanism: `src/recall/index.ts:318` `if (insightSurfacingEnabled)` gate (default **false**, config.ts:769); freshness gate at :344-361 (any member `last_access > generated_at` → insight stale); surfacing branch makes zero mutations (read-only). **Win unmeasured:** `scripts/eval/results/38-insight-tokens.json` shows `used_insight=false` on all 18 KU cases and `composeTokenReductionPct=0` — the KU corpus consolidates single-pass from scratch and never reaches `reflectMassFloorHigh=10`, so no insight is ever synthesized to surface. The required "measurable token win" is therefore **not demonstrated on any corpus where insights exist**. 38-04-SUMMARY records Task 3 (founder ship-on vs ship-dark decision) as PENDING. |

## Open Item (carried as tech debt, recorded honestly)

- **REFLECT-02 token-win is unmeasured; insight surfacing ships DARK (`insightSurfacingEnabled=false`).** Per the no-inflated-metrics hard rule, the milestone record does NOT claim a compose-token win. The mechanism is correct and zero-risk while dark. To close REFLECT-02 fully, a future run must measure compose-token reduction on a corpus where insights actually exist (mass ≥ `reflectMassFloorHigh`), then the founder decides activation. Tracked in STATE deferred items.

## Invariants

| Invariant | Status | Evidence |
| --- | --- | --- |
| D-43 — never strengthen from inferred output | HOLDS | insight `origin=inferred` → strengthen no-op (decay.ts:162); surfacing branch read-only. |
| Online recall LLM-free | HOLDS | surfacing reads a precomputed insight + freshness check; no new embed/generate on-path. |
| Offline-only generation | HOLDS | `reflect()` runs only inside `consolidate()` (sleep pass). |
| Net-zero new runtime deps | HOLDS | `package.json` unchanged. |

## Verdict

**passed_with_open_item** — REFLECT-01 fully verified (durable, D-43-safe, offline). REFLECT-02's surfacing mechanism is verified and correctly dark-defaulted, but its token-win is unmeasured and its activation is a pending founder decision. No win is claimed.
