---
phase: 42-token-and-cost-efficiency-audit
artifact: DEFERRED-RUN-RUNBOOK
requirements: [COST-01, COST-02]
gate: cost-probe (Phase-40 D-01, blocking)
decision: defer-to-reset
date: 2026-06-24
---

# Deferred-Run Runbook — Phase 42 Reset-Window Battery

**Status:** Documented procedure — NOT executed. All steps run at the next weekly subscription
reset after the founder clears the cost-probe gate (STEP 1).

**Scope:** This runbook closes the deferred halves of COST-01 (full write-side token breakdown)
and COST-02 (per-candidate KU-replay accuracy filter + final LOCOMO / LongMemEval-S no-regression
confirm). It documents the Phase-40 D-01 cost-probe HARD GATE that covers the entire battery.

---

## Preconditions (verify all before STEP 1)

1. **Weekly subscription reset imminent.** All headless claude -p calls bill against the Max
   subscription. Schedule the run at or after the weekly reset so the token headroom is maximum.

2. **Headless providers active.** Export both env vars before running any step:
   `RECENSE_JUDGE_PROVIDER=claude-headless` and `RECENSE_EXTRACTOR_PROVIDER=claude-headless`.
   The write-side harnesses degrade to `measured:false` when these are unset — verify they are
   exported in the current shell or in `~/.config/recense/sleep.env`.

3. **OPENAI_API_KEY set.** Required for the KU-replay real run (text-embedding-3-small) and for
   the final LOCOMO / LongMemEval-S confirm (question + node embeddings, gpt-4o-mini judge).
   Cost is direct-API $, not subscription — confirm the key is valid before running.

4. **Combined-best lever config (from 42-01-SUMMARY.md):**
   ```json
   { "consolSkipThreshold": 0.5 }
   ```
   Ranked by $0 skip-rate delta (+60pp vs baseline 0.2). Established by the greedy lever sweep
   in Phase 42 Plan 01. The KU accuracy verdict for this candidate is the primary deliverable
   of STEP 2 (deferred here from 42-01 per D-06 build-only constraint).

5. **Scratch-DB isolation.** Every harness below opens the live `~/.config/recense/recense.db`
   READ-ONLY and copies it into a scratch path via `VACUUM INTO <tmpfile>`. The live brain is
   never mutated by any step below. Confirm `RECENSE_DB` is unset or points to the live db
   read-only path. Never pass the live db path as a writable scratch target.

6. **Build up-to-date.** Run `npm run build` before any step. All harnesses `require('../../dist/...')`.

---

## STEP 1 — Cost-Probe HARD GATE (Phase-40 D-01, blocking)

**Do NOT proceed to STEP 2 until the founder reviews and approves the projected cost.**
This gate covers the entire battery — STEP 2 (cheap KU run) included.

### Purpose

Estimate the write-side subscription-token cost of the full deferred battery at the combined-best
lever config before spending any tokens. The subscription marginal cost is ~$0 against the Max
plan, but tokens are real and count against the weekly subscription limit. The retail-$ figure
is the "API list price equivalent" used for comparison and planning only.

### Cost-probe command (single-episode write-ledger measurement)

Run this with headless providers active:

```
npm run build && RECENSE_JUDGE_PROVIDER=claude-headless RECENSE_EXTRACTOR_PROVIDER=claude-headless node scripts/eval/cost-benefit-harness.cjs --sample 1 --out scripts/eval/results/42-cost-probe.json
```

Read `write_ledger.totals.all_tokens` from the output JSON. This is the per-episode write cost
(Haiku extraction + Sonnet judgment) at the current config (consolSkipThreshold=0.2, the default).

### Project the full battery cost

At consolSkipThreshold=0.5, the measured skip rate is ~88% (42-01 sweep). Episodes that are
skipped never reach the consolidator — their write cost is zero. Effective consolidation rate
= ~12% of total episodes. Use the following projection:

```
per_ep = write_ledger.totals.all_tokens          # from cost-probe.json
effective_per_ep = per_ep * 0.12                 # ~88% skip at threshold=0.5
N_episodes ≈ 100                                 # approximate live-brain episode count
write_side_tokens ≈ effective_per_ep * N_episodes
locomo_answer_gen ≈ 285 * 1540                   # 285 tok/QA × 1,540 QA (40-BASELINE.md)
total_projected ≈ write_side_tokens + locomo_answer_gen
```

The retail-$ translation uses Anthropic list prices (Haiku $0.80/M in, $4.00/M out;
Sonnet $3.00/M in, $15.00/M out — from cost-benefit-harness.cjs PRICES constants).
Subscription marginal ≈ $0 alongside the retail-$ figure.

### Gate rule

Founder reviews `total_projected` (subscription tokens + retail-$ estimate) and either:
- **Approves:** proceed to STEP 2.
- **Defers:** schedule for a later weekly reset and stop here.

Record the projected cost and the decision in `42-04-SUMMARY.md` under "Cost-probe decision."

---

## STEP 2 — Cheap KU-Replay Inner-Loop Accuracy Validation

**The cheap filter. Runs FIRST of the deferred battery, before the expensive confirm.**
**Cost: near-$0 but NOT zero** — requires `OPENAI_API_KEY` for text-embedding-3-small embeddings
plus judge / headless Sonnet tokens for the KU judgment pass.

### Purpose

Produce the real per-candidate KU accuracy verdict that Phase 42-01 deferred (42-01 ran
`--dry-run` only). The KU replay consolidates the cached 18-case extraction set into a scratch DB
with the lever override applied, then retrieves + scores. Candidates that fail the D-05 noise band
are DEMOTED before the expensive LOCOMO / LongMemEval confirm runs — this is the cheap filter
that prunes losers cheaply.

### Baseline reference

KU baseline at v7.0 config (consolSkipThreshold=0.2, strength_weight=0):
`scripts/eval/results/35-sweep-w0.json` → `scores.ku_score = 0.222` (4/18 = 22.2%).

### Command (NO --dry-run — this is the real run)

Run per combined-best lever candidate. For consolSkipThreshold=0.5:

```
npm run build && OPENAI_API_KEY=sk-... node scripts/eval/replay-ku-harness.cjs --config-override-key consolSkipThreshold --config-override-value 0.5 --out scripts/eval/results/42-ku-real-consolSkipThreshold-0.5.json
```

Verify `meta.config_override.key === "consolSkipThreshold"` and
`meta.config_override.value === 0.5` in the output — this confirms the lever propagated
into the scratch DB config and is not a no-op.

### D-05 noise-band gate rule

Accept / reject each candidate using the Phase-42 D-05 tolerance (≤1pt / within CI):

```
baseline_ku = 0.222   (4 / 18 correct)
candidate_ku = scores.ku_score from the result JSON
delta_pt = (candidate_ku - baseline_ku) * 100   # in percentage points
PASS if delta_pt >= -1.0   # within noise band
FAIL if delta_pt <  -1.0   # outside noise band → demote candidate, do NOT proceed to STEP 3/4
```

Note: with 18 cases, each case = 5.56pp. A drop of 1 case (from 4 to 3 correct) = -5.56pp,
well outside the ≤1pt band. In practice the gate is: ku_correct must remain ≥ 4.

If the combined-best candidate FAILS: do not run STEP 3 or STEP 4 for it. Record the failure
in the cost-savings report update under "KU gate result."

---

## STEP 3 — Full Write-Side Token Breakdown (completes COST-01 deferred half)

**Only run if STEP 2 passed for the combined-best candidate.**
**Requires headless providers active (RECENSE_JUDGE_PROVIDER + RECENSE_EXTRACTOR_PROVIDER).**

### Purpose

Measure the actual per-episode write-side token cost (Haiku extraction + Sonnet judgment) at
consolSkipThreshold=0.5 with `measured:true`. This is the COST-01 deliverable deferred from
Phase 42-01 (42-01 always wrote `write_ledger.measured = false` per the build-only constraint).
Produces the per-model breakdown: Haiku extract tokens vs. Sonnet judge tokens.

### Command

Single `--out` flag for the aggregate result file. Auxiliary per-lever files land automatically
in `path.dirname(--out)` (the harness derives its output directory from `--out`; there is no
separate directory flag):

```
npm run build && RECENSE_JUDGE_PROVIDER=claude-headless RECENSE_EXTRACTOR_PROVIDER=claude-headless node scripts/eval/42-lever-sweep-harness.cjs --lever consolSkipThreshold --values 0.5 --out scripts/eval/results/42-sweep-measured.json
```

Confirm `write_ledger.measured === true` in the result. If still `false`, headless providers
are not active — do not report the numbers as measured.

### What to record from the result

From `scripts/eval/results/42-sweep-measured.json`:

```
write_ledger.per_model.haiku.total_tokens     # Haiku extraction cost
write_ledger.per_model.sonnet.total_tokens    # Sonnet judgment cost
write_ledger.totals.all_tokens                # combined per-episode write cost
write_ledger.subscription_marginal_usd        # ~$0 (headless, Max subscription)
skip_split.skip_rate                          # should be ~88% at threshold=0.5
```

Add these to the cost-savings report (42-COST-SAVINGS-REPORT.md) §2 write-side section
as the "measured at consolSkipThreshold=0.5" row.

---

## STEP 4 — Final No-Regression Confirm (LOCOMO-10 + LongMemEval-S)

**Only run if STEP 2 and STEP 3 passed.**
**Requires OPENAI_API_KEY (embeddings + gpt-4o-mini judge).**
**Long-running: the LoCoMo-10 full run took 7.37 hrs at v7.0 (40-BASELINE.md §3).**

### LOCOMO-10 confirm

Step 4a: generate hypotheses (consolidation + retrieval + answer-gen over all 10 conversations):

```
npm run build && OPENAI_API_KEY=sk-... node scripts/eval/locomo-harness.cjs --run --out scripts/eval/results/locomo-post-42.jsonl
```

Step 4b: score with the verbatim mem0 Appendix-A judge (gpt-4o-mini, temp 0, max_tokens 10):

```
OPENAI_API_KEY=sk-... node scripts/eval/locomo-scorer.cjs --in scripts/eval/results/locomo-post-42.jsonl --out scripts/eval/results/locomo-post-42-scored.json
```

Frozen v7.0 baseline (40-BASELINE.md, commit d41d5c8, tag v7.0):

| Metric | v7.0 baseline | Band (D-05, ≤1pt) |
|--------|--------------|-------------------|
| J (headline) | 86.0% | ≥ 85.0% |
| R@5 | 77.3% | ≥ 76.3% |
| R@10 | 82.2% | ≥ 81.2% |

Accept/reject rule: PASS if all metrics stay within the ≤1pt noise band.
A token win that drops any metric outside the band is REJECTED (COST-02 guardrail).
Record `scores.headline` and `rAtK.r5` / `rAtK.r10` from the result JSON.

### LongMemEval-S confirm

LongMemEval-S requires the dataset file (not committed — ~3 GB; CC BY-NC):

```
curl -L "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.jsonl" -o scripts/eval/longmemeval-s.jsonl
```

Run the harness (full run triggered by providing `--eval`; no separate `--run` flag):

```
npm run build && OPENAI_API_KEY=sk-... node scripts/eval/longmemeval-harness.cjs --eval scripts/eval/longmemeval-s.jsonl --out scripts/eval/results/longmemeval-post-42.jsonl
```

Compare to the LongMemEval-S baseline from the most recent Phase 26/35 real run stored locally.
Apply the same D-05 ≤1pt noise-band accept/reject rule. If the local baseline file does not
exist, run `--probe` first to estimate cost and record in the cost-probe decision.

---

## Result Locations

All result files land under `scripts/eval/results/` (gitignored per `.gitignore:30`).
They are local-only — committed harness source is the reproducibility artifact.

| Step | Result file | Key field |
|------|-------------|-----------|
| 1 (cost-probe) | `42-cost-probe.json` | `write_ledger.totals.all_tokens` |
| 2 (KU real run, threshold=0.5) | `42-ku-real-consolSkipThreshold-0.5.json` | `scores.ku_score`, `meta.config_override` |
| 3 (write-side breakdown) | `42-sweep-measured.json` | `write_ledger.per_model`, `skip_split.skip_rate` |
| 4a (LOCOMO hypotheses) | `locomo-post-42.jsonl` | incremental append per conversation |
| 4b (LOCOMO scored) | `locomo-post-42-scored.json` | `scores.headline`, `rAtK.r5`, `rAtK.r10` |
| 4c (LongMemEval-S) | `longmemeval-post-42.jsonl` | incremental append per question |

---

## After the Run — What to Update

After all steps pass accept/reject:

1. **42-COST-SAVINGS-REPORT.md §2** — add the measured write-side breakdown row
   (Haiku tokens / Sonnet tokens / total per-episode / skip rate at threshold=0.5).

2. **ROADMAP.md — Phase 42 success criteria** — mark COST-01 and COST-02 complete with the
   measured numbers and the KU / LOCOMO / LongMemEval-S accept verdicts.

3. **STATE.md** — update "stopped at" and record the run date + projected-vs-actual cost delta.

4. **40-BASELINE.md** if a new v8.0 baseline supersedes v7.0 — add a row under §7 summary.

If any step FAILS accept/reject: record the failure in 42-COST-SAVINGS-REPORT.md, do NOT
mark the requirement complete, and open a follow-on task to address the regression before
claiming the token win.
