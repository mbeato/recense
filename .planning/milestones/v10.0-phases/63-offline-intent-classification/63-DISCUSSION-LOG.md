# Phase 63: Offline Intent Classification - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-02
**Phase:** 63-offline-intent-classification
**Mode:** `--auto` — every question resolved to the recommended default without user prompts; user should audit below.
**Areas discussed:** Prompt integration, Field shape, Attachment level, Enablement gating, Token-cost verification, LLM-free regression test

---

## Prompt integration

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing gmail superset prompt | Mirror the D-06 precedent (temporal superset): one prompt, one call, classification instructions appended to the constant prefix | ✓ |
| New conditional gmail-classify variant | Second prompt selected per-episode — adds a selection seam and risks a second call | |

**Auto-selected:** Extend existing superset prompt (recommended default).
**Notes:** Cache-ordering constraint folded from the 2026-06-23 prompt-prefix todo: constant prefix first, episode content last.

---

## Field shape

| Option | Description | Selected |
|--------|-------------|----------|
| Enum status + descriptor + categorical confidence | Closed 4-state enum, free-text entity descriptor, `high\|medium\|low`; all-or-nothing presence; drop on out-of-enum | ✓ |
| Numeric confidence float | Raw model confidence 0–1 — rejected by research (arXiv 2402.07632, undetectable miscalibration) | |
| Full proposed_change from/to triple | Phase 66's contract shape — premature here; "from" state lives in the graph, not the email | |

**Auto-selected:** Enum + descriptor + categorical confidence (recommended default).
**Notes:** Exact field names left to planner; semantics locked.

---

## Attachment level

| Option | Description | Selected |
|--------|-------------|----------|
| Per-claim via ClaimDecision | Mirrors TEMP-02 `claimDueAt`/`claimActionType` threading exactly; no schema change | ✓ |
| Per-episode summary object | New plumbing beside the claim path; nothing downstream needs it | |

**Auto-selected:** Per-claim (recommended default).
**Notes:** No DB schema change in Phase 63 per the roadmap foundation-phase call.

---

## Enablement gating

| Option | Description | Selected |
|--------|-------------|----------|
| Always-on for gmail, no flag | Fields are inert until Phases 64/65 consume them; flag would be speculative surface | ✓ |
| New config flag (classification.enabled) | Conservative gate on live brain.db — but gates nothing observable in this phase | |

**Auto-selected:** Always-on, no flag (recommended default).

---

## Token-cost verification (CLASSIFY-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Call-count sentinel + measured token delta | Stub asserts exactly one provider call per gmail episode; honest prefix-growth delta recorded in SUMMARY | ✓ |
| Ledger-only comparison | Coarser; can't distinguish call-count from prompt growth | |

**Auto-selected:** Sentinel + measured delta (recommended default).

---

## LLM-free regression test (CLASSIFY-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Fail-if-called provider stub on online entrypoints | SessionStart inject / retrieval / `/v1/surface` exercised with a throwing stub | ✓ |
| Static import-boundary check only | Weaker alone; optional addition at planner discretion | |

**Auto-selected:** Fail-if-called stub (recommended default); `/v1/proposals` covered when Phase 66 lands.

---

## Claude's Discretion

- Exact `ExtractedClaim`/`ClaimDecision` field names
- Static vs dynamic-only shape of the CLASSIFY-03 test
- Classification prompt wording (flagged for the research pass)

## Todo folding (auto, score ≥ 0.4)

- Folded as constraint: cache-constant prompt-prefix todo (0.6); content-hardening §3 gmail-variant boundary (0.6)
- NOT folded (deviation from mechanical rule, scope guardrail): `corpus-brain-3d-transition.md` (0.6), `viz-search-and-hull-quality.md` (0.4) — viz-domain keyword-noise matches, recorded under Reviewed Todos in CONTEXT.md

## Deferred Ideas

- Entity resolution (Phase 64); PE-magnitude mapping + lifecycle lattice (Phase 65); `action_proposal`/sink/routes (Phase 66)
- Prompt-prefix caching implementation; gmail episodic-variant product decision
