# Phase 50: Verification + Regression Gates - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-29
**Phase:** 50-verification-regression-gates
**Areas discussed:** Gate execution surface, Baseline + thresholds, Judge-fires proof, Re-run scope + budget

---

## Gate scope (founder reframe — raised by user)

User interrupted the gray-area flow with "i dont really want a ci regression gate" and asked what the remaining phases are. Confirmed only Phases 50 + 51 remain in v9.0 (52 viz effectively done). Reframed the phase: strip CI enforcement, keep the verification substance.

| Option | Description | Selected |
|--------|-------------|----------|
| Verify + on-demand script | Re-run, record v9.0-final numbers, prove judge, discharge deferred checks, commit baseline + manual `npm run gate`. No CI enforcement. | ✓ |
| Verify only, docs as record | Re-run + record + prove judge; no gate script at all. | |
| Keep full CI gate | Original scope — LLM-free axes block merges in CI + local accuracy tier. | |

**User's choice:** Verify + on-demand script
**Notes:** Accuracy axes can't run reproducibly in GitHub CI (need `claude -p`, tokens, non-deterministic) → merge-blocking CI gate would be flaky theater. The on-demand script gives Phase 51 the cheap re-runnable latency/recall safety net it actually needed.

---

## Gate content (Baseline + thresholds, part 1)

| Option | Description | Selected |
|--------|-------------|----------|
| Cheap axes only | `npm run gate` = LLM-free axes (R@K floor, latency ceiling, token); accuracy in separate `gate:accuracy`. | ✓ |
| All-in-one gate | Single `npm run gate` runs everything incl. LLM harnesses — token spend every run. | |

**User's choice:** Cheap axes only
**Notes:** Matches the Phase-51 use case ($0, fast, deterministic).

## Thresholds (Baseline + thresholds, part 2)

| Option | Description | Selected |
|--------|-------------|----------|
| Floor / ceiling | Recall ≥ floor, latency p95 ≤ ceiling, token ≤ ceiling vs committed baseline. | ✓ |
| Relative tolerance band | Fail if any axis moves > ±N% from baseline. | |
| Exact match | Byte-exact equality vs baseline. | |

**User's choice:** Floor / ceiling
**Notes:** Deterministic axes make simple floors/ceilings robust and readable.

---

## Judge-fires proof

| Option | Description | Selected |
|--------|-------------|----------|
| Binary assertion in gate | Counter > 0 on a fixed replay set ("broadening still fires") + record 368 in docs. | ✓ |
| Floor assertion in gate | Counter ≥ floor (e.g. ≥300). | |
| Recorded evidence only | Record 368 in docs, no automated re-check. | |

**User's choice:** Binary assertion in gate
**Notes:** Robust to LLM variance; a floor would be a magic number that drifts with the replay set. Implementation must measure at the candidate-escalation layer (LLM-free) to stay in the cheap gate — flagged for researcher.

---

## Re-run scope + budget

### Eval stack

| Option | Description | Selected |
|--------|-------------|----------|
| Subscription headless | Record on the shipped Haiku/Sonnet `claude -p` stack — numbers match a real install. | ✓ |
| API stack | Cheaper/faster eval, but not the default config. | |
| Both columns | Subscription + API side-by-side. | |

**User's choice:** Subscription headless

### Budget / re-run scope

| Option | Description | Selected |
|--------|-------------|----------|
| Full suite, probe-first | Run everything, probe-estimate first, no hard cap. | |
| Full suite, soft cap | Same, abort if probe > ~$25. | |
| Minimal scope | Only what baseline + deferred checks strictly require. | |

**User's choice:** Free-text — "review the previous runs we've done im pretty sure any of the evals are multi hour and way too expensive."
**Notes:** Reviewed recorded costs from `docs/evals.md` + `scripts/eval/results/`: KU finish-78 ~$14/15min on API (1–3 hr on subscription); LoCoMo-J similar; EVAL-02 cheap (~25 min, $0 local); R@K + latency LLM-free + fast. Led to the "reuse recent + cheap re-run only" decision below.

### Accuracy re-run handling (follow-up)

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse recent + cheap re-run only | Fresh LLM-free axes for the gate baseline; reuse recorded KU/LoCoMo-J/counter for docs. No multi-hour LLM re-run. | ✓ |
| + tiny EVAL-02 fresh | Same, plus a fresh EVAL-02. | (folded in below) |
| Full fresh re-run | Re-run KU + LoCoMo-J despite hours. | |

**User's choice:** Reuse recent + cheap re-run only

### EVAL-02 correction (inconsistency surfaced by Claude)

Claude flagged that the only recorded EVAL-02 (`correctness-PENDING.json`, commit f779bfb, Jun-27) **predates Phases 46–48**, so reusing it can't discharge RECON-04 (post-46–48 no-regression). EVAL-02 is the cheap accuracy eval (~25 min, $0 local).

| Option | Description | Selected |
|--------|-------------|----------|
| Re-run EVAL-02 fresh | Fresh run on the 46–48 pipeline so RECON-04 is genuinely verified. | ✓ |
| Reuse with caveat | Record the pre-46 number, flagged. | |

**User's choice:** Re-run EVAL-02 fresh
**Notes:** The cheap exception — it's the actual deferred check and is not the multi-hour kind being avoided.

---

## Claude's Discretion

- Exact CLI surface of `npm run gate` / `gate:accuracy` / `--update-baseline` and the baseline JSON schema.
- Epsilon/tolerance constants for floors/ceilings.
- Gate script location (`scripts/eval/` is the natural home).

## Deferred Ideas

- Full CI regression gate with merge-blocking enforcement — dropped as overkill for a single-founder project; revisit if external contributors arrive.
- Scheduled (nightly/weekly) authed CI run of the full LLM suite — considered, not adopted (token + auth cost).
