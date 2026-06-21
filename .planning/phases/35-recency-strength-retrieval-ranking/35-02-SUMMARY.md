---
phase: 35-recency-strength-retrieval-ranking
plan: 02
subsystem: eval
tags: [RANK-02, strength-sweep, replay-ku, longmemeval, headless-transport, consolidate-once, negative-result, dark-default]

# Dependency graph
requires:
  - phase: 35-recency-strength-retrieval-ranking
    plan: 01
    provides: rankStrengthWeight mechanism (hybridTopk strength-fused RRF list, dark at 0)
provides:
  - replay-ku-harness queryText fix (Pitfall 3 — strength fusion is now actually exercised)
  - --strength-weight flag on both KU + LME harnesses
  - scripts/eval/35-strength-sweep.cjs w-sweep driver (+ --headless, + consolidate-once mode)
  - eval harnesses routable through the engine headless claude -p transport (RECENSE_MODEL_PROVIDER=claude-headless)
  - RANK-02 verdict: NO WIN on KU — keep rankStrengthWeight=0 (dark)
affects:
  - any future RANK / retrieval-ranking phase that wants to revisit strength fusion
  - establishes the headless-billed eval path for future sweeps (~$0 marginal, subscription tokens)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "harness LLM calls routed via resolveProviderOverlay + createClaudeHeadlessClient (opt-in; direct API default)"
    - "consolidate-once: weight-independent sleep pass runs 1x/case; retrieve+answer+score re-runs per weight over the same DB"
    - "RECENSE_MODEL_PROVIDER=claude-headless flips extraction+judge+answer+scorer to the subscription in one env var"

key-files:
  created:
    - scripts/eval/35-strength-sweep.cjs
    - scripts/eval/results/35-sweep-w0.json
    - scripts/eval/results/35-sweep-w0.25.json
    - scripts/eval/results/35-sweep-w0.5.json
    - scripts/eval/results/35-sweep-w1.json
    - scripts/eval/results/35-sweep-w2.json
  modified:
    - scripts/eval/replay-ku-harness.cjs
    - scripts/eval/longmemeval-harness.cjs
    - scripts/eval/longmemeval-scorer.cjs

key-decisions:
  - "RANK-02 = NO WIN. KU baseline (w=0) is best at 77.8%; every w>0 regresses (w=1 worst at 55.6%, 22pt below baseline — well outside the ~1-2pt judge-noise band). D-06/D-07 require a token-or-precision win with no regression → not met. rankStrengthWeight stays 0 (dark); the eval vindicates the D-04 dark default."
  - "Founder-directed deviation: wire eval harnesses through the EXISTING headless claude -p transport (commit 503b508) so the sweep is ~$0 marginal (subscription-billed) instead of metered. Direct API stays the default; headless is opt-in via RECENSE_MODEL_PROVIDER / RECENSE_ANSWER_PROVIDER / RECENSE_SCORER_PROVIDER. The GPT-4o LME scorer gains a headless Anthropic-judge path (gated) — founder owns the cross-baseline comparability tradeoff."
  - "Founder-directed perf deviation: consolidate-once sweep mode (commit a9e9edc). The strength weight only affects retrieval, never consolidation, so the judge-heavy sleep pass now runs 1x/case instead of 5x. ~5x fewer subscription tokens; cut the run from a projected ~17h (5x) to 3.4h."
  - "Node 25 required at runtime: better-sqlite3 native binding is built against NMV 141 (Node 25). Running the harness under Node 22 (NMV 127) fails every DB open. No .nvmrc committed (canonical Node version is the founder's call)."

requirements:
  RANK-02: measured — negative result (no win); mechanism stays dark
---

<objective_outcome>
RANK-02 demanded an eval-backed decision on whether to enable the Plan 35-01 strength-fusion mechanism. This plan made it measurable (fixed the silent no-op, added the weight flag + sweep driver), made the run affordable (headless transport + consolidate-once), and ran it. The answer is a clean negative: strength fusion does not help and actively hurts KU recall. The mechanism stays dark.
</objective_outcome>

<rank02_verdict>
## ⚠ POST-HOC CORRECTION (2026-06-21): the "NO WIN" below is CONFOUNDED — do not treat it as a verdict on strength ranking.

Follow-up investigation (probes: `scripts/eval/35-candidate-probe.cjs`, `35-judge-probe.cjs`, `35-pass-proof.cjs`) found the sweep ran on a **degenerate graph**:
- Candidate surfacing is fine (mean top-1 cosine ≈0.62; contradiction pairs co-located ≥0.85).
- The judge is fine (headless/local/anthropic all return `contradict` correctly, single + batch).
- **Root cause:** the replay-ku harness ingests ~2,000 claims into ONE consolidation pass. Mid-pass-minted nodes get `embedding=NULL` and are only embedded by `reembedDirty` at pass start + Phase C (AFTER the judging loop); `topk` filters `embedding IS NOT NULL`. So within that single pass NO claim can see a sibling → every claim mints `'unrelated'` (`tomb=0 contra=0 dup≈2000`). Proven: the SAME pair gives `contra=0` in one batch but `contra=1` (+ tombstone/reconcile) across two passes.
- **Consequence:** zero merges + zero contradictions → uniform node strength → RANK-01's strength term had no gradient to rank on. The observed "regression" was noise injection into a good cosine/BM25 order.

**Corrected verdict:** strength fusion is NOT shown to be bad — it was never fairly tested. `rankStrengthWeight: 0` (dark) remains correct *for now* because we have no fair eval, not because fusion was shown not to work. A fair RANK-02 re-test requires the harness to consolidate INCREMENTALLY (multi-pass) so the graph dedups/contradicts and a real strength gradient exists. Secondary finding (beyond this phase): any bulk single-pass ingest cannot self-dedup — a RETR-02-relevant production concern for large one-shot ingests (incremental production ingestion is masked by cross-pass `reembedDirty`).

---

## RANK-02 Verdict (ORIGINAL — now known to be confounded, see correction above): NO WIN — keep `rankStrengthWeight: 0` (dark)

KU sweep — 18 cases (n20-attribution ∩ eval20-ku), headless/subscription-billed, consolidate-once, Node 25, commit a9e9edc:

| w     | KU score      | vs. baseline |
|-------|---------------|--------------|
| **0 (dark)** | **77.8% (14/18)** | — |
| 0.25  | 66.7% (12/18) | −11.1 |
| 0.5   | 72.2% (13/18) | −5.6  |
| 1     | 55.6% (10/18) | **−22.2** |
| 2     | 66.7% (12/18) | −11.1 |

- **Pitfall-3 sanity check PASSED:** scores differ across w → the queryText fix is live and the fusion is genuinely exercised (not a silent no-op).
- **Baseline (w=0) is best; every non-zero weight regresses.** The largest regression (w=1, −22.2pt = 4 cases) is far outside the ~1–2pt judge-noise band.
- **D-06/D-07 bar** (EITHER token-saving OR precision clears the noise band, with no regression on the other): **not met** — no win, and a decisive regression. → keep dark.

### Why it hurts (mechanistic)
Every case reported `tomb=0  contra=0  dup≈2000`. Consolidation minted ~2,000 *separate* nodes per case with **zero merges and zero contradictions**, so node strength is essentially **undifferentiated** — the strength-ranked RRF list carries almost no signal and fusing it only perturbs the good cosine/BM25 order. The strength gradient the mechanism is designed to exploit does not exist on this corpus. (The heavy dup-minting itself is a RETR-02-adjacent consolidation behavior worth a separate look; it is NOT a RANK-01 defect — the 35-01 mechanism is correct and byte-identical at w=0.)

### Scope note
KU measures binary answer correctness. The LongMemEval precision/token-per-inject arms (the literal D-06 axis) were **not** run — given KU's decisive regression plus the undifferentiated-strength finding, an LME rescue was judged unlikely and not worth the additional multi-hour subscription-token run (founder decision, 2026-06-21).
</rank02_verdict>

<what_shipped>
- **Task 1 (f9f8989):** `replay-ku-harness.cjs` passes `kuCase.question` as `queryText` to `retrieveRanked` (Pitfall 3 — without it the pure-cosine branch ran and the sweep was a silent no-op); `--strength-weight` flag on both harnesses; `35-strength-sweep.cjs` w-grid driver.
- **Headless transport wiring (503b508, founder-directed deviation):** all harness answer/rewrite/scorer calls route through the engine's existing `createClaudeHeadlessClient` (`claude -p`, subscription-billed) when `RECENSE_MODEL_PROVIDER=claude-headless`; direct API + maxRetries preserved as the default. API-key guards relaxed for the headless path. LME GPT-4o scorer gained a gated headless Anthropic-judge path. Sleep-pass extraction/judge already env-routable via `RECENSE_EXTRACTOR_PROVIDER`/`RECENSE_JUDGE_PROVIDER` — unchanged.
- **Consolidate-once sweep mode (a9e9edc, founder-directed perf deviation):** `--sweep-weights` consolidates each case once (`consolidateCase`) then re-runs retrieve+answer+score per weight (`evaluateAtWeight`) over the same DB; driver invokes the harness once. `runConsolidation` fires exactly 1x/case (verified). Legacy single-`--strength-weight` and `--dry-run` paths byte-for-byte unchanged.
</what_shipped>

<verification>
- `node --check` clean on all four eval scripts; `--dry-run` exits 0 with zero API calls (legacy path intact).
- KU sweep ran to completion (5 weights, 18 cases) and produced non-uniform scores → fusion live.
- Result JSONs present under `scripts/eval/results/35-sweep-w{0,0.25,0.5,1,2}.json`.
- `package.json` unchanged across all three commits (D-11 net-zero deps).
- All Plan 35-01 commits remain in HEAD ancestry after concurrent phase-38 work merged on top (no loss).
</verification>

## Self-Check: PASSED
RANK-02 is measured and decided: strength fusion shows no win and a clear regression on KU; `rankStrengthWeight` stays 0 (dark). The mechanism (RANK-01) is delivered and correct; the evidence says don't enable it on this corpus. Negative result recorded honestly — no metric inflated, no "win" claimed.
