# Phase 50: Verification + Regression Gates - Context

**Gathered:** 2026-06-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Verify that the v9.0 pipeline gains (Phases 46–48) actually landed end-to-end with no regression, record the **v9.0-final** numbers in `docs/evals.md`, prove the Phase-46 belief-update judge fires on real contradictions, and leave a **lightweight, on-demand regression guard** behind. Discharges the deferred Phase 43 (GATE-01/02/03).

**Scope reframe (founder decision, this session):** The original ROADMAP framing — "lock regression gates (CI/pre-merge)" — is **narrowed**. There is **no GitHub CI enforcement, no auth-in-CI, no scheduled token spend**. The "gate" is a committed baseline + a manual `npm run gate` the founder runs on demand (notably before merging Phase 51). Rationale: the accuracy axes can't run reproducibly in GitHub CI (need `claude -p`, subscription tokens, non-deterministic), so a merge-blocking CI gate on them would be flaky theater — speculative infrastructure for a single-founder, customer-zero project. The verification underneath (re-run + record + prove judge + update docs) is the load-bearing value and is what this phase delivers.

**In scope:**
- A committed baseline JSON + an on-demand `npm run gate` script over the **LLM-free deterministic axes** (LoCoMo R@5/R@10, latency p50/p95, token-structural), with floor/ceiling thresholds.
- A binary judge-fire assertion (counter > 0 on a frozen replay set) folded into the gate.
- Fresh re-run of only the cheap axes (LLM-free deterministic + the small EVAL-02) on the 46–48 pipeline; reuse of recent recorded heavy-accuracy runs.
- `docs/evals.md` updated with v9.0-final numbers + judge-validation evidence + honest provenance/dating.
- Discharge of the three carried-over deferred checks: RECON-04, pristine KU re-run, PERF-03(b).

**Out of scope:**
- GitHub CI merge-blocking enforcement of any axis (explicitly dropped).
- A multi-hour fresh re-run of KU finish-78 or LoCoMo-J (reused from recent recorded runs instead).
- A separate always-on `gate:accuracy` being part of the default/cheap path (it exists as a deliberate opt-in command only).
- Any retrieval/consolidation logic changes — this phase measures and gates, it does not modify the engine.

</domain>

<decisions>
## Implementation Decisions

### Gate execution surface (Area 1)
- **D-01:** Deliver as **verify + on-demand local script**, NOT a CI gate. Commit a baseline JSON and a `npm run gate` the founder runs by hand. No `.github/workflows/ci.yml` changes for enforcement, no claude-auth-in-CI, no scheduled job.
- **D-02:** The only consumer that needed "gates" is **Phase 51** (WASM SIMD kernel) — and all it needs is a cheap re-runnable LLM-free latency/recall check to confirm the kernel stays byte-exact and faster. `npm run gate` satisfies that.

### Gate content + thresholds (Area 2)
- **D-03:** `npm run gate` covers **LLM-free deterministic axes only** — LoCoMo R@5/R@10 (recall), latency p50/p95, token-structural. Fast, $0, reproducible. The accuracy axes (LoCoMo J, EVAL-02, KU) live in a **separate, deliberate** `npm run gate:accuracy` (real token spend; never the default and never in the cheap gate).
- **D-04:** Pass/fail is **floor / ceiling** vs the committed baseline: recall ≥ floor (e.g. baseline − epsilon), latency p95 ≤ ceiling (e.g. baseline × ~1.15), token cost ≤ ceiling. Simple, predictable, human-readable in the JSON.
- **D-05:** Re-baseline must be **intentional, not silent drift** (GATE-03). Provide an explicit mechanism — a `--update-baseline` flag / `npm run gate:baseline` that rewrites the committed JSON, committed deliberately. Exact CLI shape is Claude's discretion (sensible default).

### Judge-fires proof (Area 3)
- **D-06:** Lock the Phase-46 win with a **binary assertion**: the judge-fire / contradiction-candidate counter must be **> 0** on a frozen replay set. Robust to LLM run-to-run variance (a floor would be a magic number that drifts with the replay set).
- **D-07:** The assertion must be measured at the **candidate-escalation layer** (broadening surfaced contradiction candidates → escalated to the judge), which is **LLM-free**, so it can live inside the cheap `npm run gate`. The judge's actual Sonnet verdict stays in the accuracy tier. **Researcher must confirm** where this counter is instrumented and that it can be asserted LLM-free on a frozen set.
- **D-08:** Record the measured **368 contradicts on 14 clean cases** (vs pre-46 zero) as the proof artifact in `docs/evals.md`, with methodology.

### Re-run scope, stack + budget (Area 4)
- **D-09:** Any **fresh** numbers are recorded on the **subscription headless stack** (Haiku extract / Sonnet judge via `claude -p`) — the shipped config, so the numbers match a real install. Most honest baseline.
- **D-10:** **Fresh re-run now (cheap, $0, minutes):** LoCoMo R@5/R@10 + latency p50/p95 + token-structural → these become the **committed gate baseline**. (Phase 47 changed hybrid retrieval, so R@K must be refreshed — but it's LLM-free and fast.)
- **D-11:** **Fresh re-run now (cheap, ~25 min, $0 local / ~$2 API):** EVAL-02 (n=13) → discharges **RECON-04** with a genuine post-46–48 number. This is the explicit exception to "no fresh accuracy run" because (a) it IS the deferred check and (b) it's not the multi-hour kind. See open item below for *why* a fresh run is required.
- **D-12:** **Reuse recent recorded runs (NO fresh run):** KU finish-78 (`scripts/eval/results/46-recon03-ku-bm25on.json`, Jun 28, ku_correct 7/18, counter=368), LoCoMo-J, and the counter evidence → recorded in `docs/evals.md` as v9.0-final with **honest provenance/dates** (state the commit + date each number came from; do not imply same-day re-run).
- **D-13:** **No multi-hour KU / LoCoMo-J fresh re-run.** Cost is secondary to quality (PROJECT.md), but a 1–3 hr subscription run for numbers we already have recently is not worth it.

### Deferred-check discharge mapping
- **D-14:** **RECON-04** (EVAL-02 clean-case no-regression after 46–48) → fresh EVAL-02 run (D-11).
- **D-15:** **Pristine KU re-run** → reuse `46-recon03-ku-bm25on.json` (D-12), recorded with provenance.
- **D-16:** **PERF-03(b)** (3-harness end-to-end re-run) → covered by fresh latency (D-10) + fresh EVAL-02 (D-11) + reused KU (D-12). Researcher to confirm the "3 harness" set maps to correctness/KU/latency.

### Claude's Discretion
- Exact CLI surface of the gate (`npm run gate`, flags, `--update-baseline` shape) and the baseline JSON schema.
- Epsilon/tolerance constants for floors/ceilings (anchor to the freshly-recorded values; keep latency ceiling generous enough to absorb machine noise).
- Where the gate script lives (`scripts/eval/` alongside the harnesses it wraps is the natural home).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition + requirements
- `.planning/ROADMAP.md` §"Phase 50: Verification + Regression Gates" — goal + GATE-01/02/03 success criteria (note: the "CI/pre-merge" wording is superseded by the founder reframe captured in `<domain>` above).
- `.planning/REQUIREMENTS.md` — GATE-01/02/03 definitions (grep `GATE-0`).
- `.planning/ROADMAP.md` §"Phase 43: Eval Regression Gates" (deferred) — original gate intent this discharges.

### The doc to update + methodology of record
- `docs/evals.md` — the file GATE-03 requires updating; contains EVAL-01 (LongMemEval/KU), EVAL-02 (correctness/belief-correction), EVAL-03 (injection), EVAL-04 (cost-benefit) methodology, recorded results, cost/time, and honesty disclosures. Read before recording any new number.

### Harnesses to wrap (do NOT rebuild — they exist)
- `scripts/eval/locomo-harness.cjs` + `scripts/eval/locomo-scorer.cjs` — LoCoMo J + R@K.
- `scripts/eval/longmemeval-harness.cjs` + `scripts/eval/longmemeval-scorer.cjs` + `scripts/eval/replay-ku-harness.cjs` — KU finish-78 / replay.
- `scripts/eval/correctness-harness.cjs` — EVAL-02 belief-correction (the fresh run for RECON-04).
- `scripts/eval/cost-benefit-harness.cjs` — EVAL-04 token cost-benefit.
- `scripts/eval/latency-curve.cjs`, `scripts/eval/live-latency.cjs`, `scripts/eval/41-latency-after.cjs` — latency p50/p95.
- `scripts/eval/README.md` — harness catalog.
- `package.json` `eval:*` scripts — the pattern to add `gate` / `gate:accuracy` / baseline scripts to.

### Recorded results to reuse / delta against
- `scripts/eval/results/46-recon03-ku-bm25on.json` — reused KU + counter=368 (Jun 28).
- `scripts/eval/results/correctness-PENDING.json` — EVAL-02 @ 84.6%, **commit f779bfb, Jun 27 — PRE-46/47/48** (use only as a delta reference, NOT as the v9.0-final number; see open item).
- `scripts/eval/results/locomo-d41d5c8.json` — prior LoCoMo full results.
- `scripts/eval/results/bm25-weight-sweep.md`, `locomo-hypotheses-PENDING.jsonl` — recent Phase-47 hybrid-retrieval sweeps (Jun 29).

### Judge-fire counter instrumentation (researcher to confirm)
- `src/consolidation/update-decision.ts`, `src/consolidation/sink.ts`, `src/consolidation/consolidator.ts`, `src/model/judge.ts` — where contradiction/escalation/tombstone counters are produced.
- `.planning/phases/46-reconsolidation-candidate-broadening/46-02-SUMMARY.md` — counter=368 methodology + RECON-03 proof.

### What NOT to touch
- `.github/workflows/ci.yml` — existing CI is LLM-free smoke/dry-run only. **Decision D-01: do not add merge-blocking gate enforcement here.** Read only to understand current smoke patterns.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **All eval harnesses already exist** (`scripts/eval/*.cjs`) — this phase wraps them in a gate runner + baseline comparator, it does not author new eval logic.
- **`package.json` `eval:*` script pattern** — add `gate`, `gate:accuracy`, and a baseline-update script following the same shape.
- **CI dry-run/mocked smoke pattern** (`ci.yml`: `eval-harness-smoke`, `--dry-run` steps) — a template if any cheap-axis structural check is ever wired into CI, but per D-01 enforcement is out of scope.

### Established Patterns
- **LLM-free vs LLM split is real and load-bearing:** retrieval R@K + latency are deterministic SQLite/cosine paths (hot path is LLM-free by invariant); accuracy axes route through `claude -p`. The gate design exploits this split (cheap axes in `npm run gate`).
- **Cost-probe gate** (`--probe` on the harnesses, `docs/evals.md` §"Cost-probe gate") — the existing pattern for estimating spend before a real run; reuse if any accuracy run is invoked.
- **Results JSON convention** — harnesses emit `meta` (date, commit, engine_version, db path) + `scores`. The baseline JSON should follow this so provenance is self-describing.

### Integration Points
- Gate script lives in `scripts/eval/`, reads the committed baseline JSON, runs the cheap harnesses, compares floor/ceiling, exits non-zero on breach.
- `docs/evals.md` is the human-facing record updated at phase close.

</code_context>

<specifics>
## Specific Ideas

- The judge-fire proof has a concrete target already measured: **368 contradicts on 14 clean cases vs pre-46 zero** — the gate asserts the binary "still fires," and docs record the magnitude.
- Honest provenance is a hard requirement (no-inflated-metrics rule applies to reading our own old runs too): every reused number in `docs/evals.md` must carry its source commit + date, and must not be presented as a fresh same-day v9.0-final re-run.

</specifics>

<deferred>
## Deferred Ideas

- **Full CI regression gate with merge-blocking enforcement** — explicitly dropped this session as overkill for a single-founder project. If recense ever has external contributors / a real PR flow, revisit (the cheap LLM-free axes could then go into CI cheaply; the accuracy tier would still need a scheduled authed job).
- **Scheduled (nightly/weekly) authed CI run of the full LLM suite** — considered, not adopted (token spend + auth complexity).

## Open Items for Researcher / Planner

1. **Judge-fire counter location + LLM-free measurability** — confirm the contradiction/escalation counter (`update-decision.ts` / `sink.ts`) can be asserted at the candidate-escalation layer WITHOUT a Sonnet call, on a frozen replay set. If it inherently requires the LLM verdict, the binary assertion moves to `gate:accuracy` instead of the cheap `gate` (re-decide with founder).
2. **Frozen replay/eval set for the deterministic baseline** — identify the exact fixed input (LoCoMo subset + replay-KU cache) so R@K + counter are reproducible run-to-run. Phase 47 changed hybrid retrieval, so the LoCoMo R@K baseline must be re-recorded fresh, not reused.
3. **PERF-03(b) "3-harness" definition** — confirm the three harnesses (likely correctness + KU + latency) so the discharge mapping (D-16) is complete.
4. **RECON-04 fresh EVAL-02 is required** — the only recorded EVAL-02 (`correctness-PENDING.json`) is commit f779bfb / Jun-27, **before** Phases 46–48 landed, so it cannot serve as the post-46–48 no-regression evidence. Fresh run mandated (D-11).

</deferred>

---

*Phase: 50-verification-regression-gates*
*Context gathered: 2026-06-29*
