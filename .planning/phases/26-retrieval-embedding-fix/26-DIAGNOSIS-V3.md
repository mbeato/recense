# Phase 26: Claim-Path Diagnosis V3 — RETR-01 (real cue shape + gates)

**Date:** 2026-06-18
**Script:** `scripts/eval/diagnose-claim-path-v3.cjs`
**DB:** `~/.config/recense/recense.db` (live, READ-ONLY)
**Model:** `text-embedding-3-small@1536` (the live engine embedder)
**Cost:** ~$0.0003 (560 short embeddings, small@1536 only; NN scan reused stored vectors)

---

## The real consolidation flow (grounded in code)

V1/V2 tested QUESTION-vs-node cues. That is the retrieval/answering path, not the
reconsolidation path. Production reconsolidation runs in the offline sleep pass, and the
cue that drives it is the **raw extracted claim string**, not a user question and not the
node value being compared. Traced through live code:

1. **Cue text embedded** = `claim.value` (the extracted claim).
   `src/consolidation/consolidator.ts:485-488` —
   `const claimValues = claims.map(c => c.value); const claimVecs = await this.provider.embed(claimValues)`.
2. **Compared against** stored node embeddings via brute-force cosine top-k, k=`candidateK` (5).
   `consolidator.ts:515` — `const candidates = this.retriever.topk(queryVec, this.config.candidateK)`.
   `topk()` scans `node WHERE embedding IS NOT NULL AND tombstoned = 0` (`src/retrieval/topk.ts:97-99`).
3. **Candidate gate (mint-dup vs reach-judge)** = `unrelatedSimilarityThreshold` (0.3).
   `consolidator.ts:583-586` — `cosineGate = candidates.length===0 || candidates[0].score < unrelatedSimilarityThreshold`.
   `consolidator.ts:586` — `if (cosineGate && anchors.length === 0)` → relation `'unrelated'` →
   `applyDecision` mints a brand-new node (`consolidator.ts:854-873`). **This is where a duplicate is born when cosine is genuinely low.**
4. **Above the gate (or with an anchor)** → escalate to `provider.judge`
   (`consolidator.ts:604-622, 639-649`). The judge returns `confirm`/`extend`/`unrelated`/`contradict`.
5. **A `contradict` verdict** then routes by **PE magnitude / resistance**, NOT by any cosine
   threshold: `routeContradiction(decision.magnitude, resistance, config)` where
   `resistance = effectiveStrength * c` (`consolidator.ts:896-902`). The reconcile-vs-append-new
   decision is governed by `peReconcileBandLow` (0.8), `peReconcileBandHigh` (2.0), and
   `peAppendNewMinResistance` (0.3) — `src/lib/config.ts:269-293`.

**Threshold roles, corrected:**
- `unrelatedSimilarityThreshold` **0.3** — the consolidation candidate gate. Below it (no
  anchor) → auto-`unrelated` → duplicate minted. `config.ts:257-263`.
- `deletedSimilarityThreshold` **0.7** — used ONLY by the retrieval forget/deleted path
  (`src/retrieval/engine.ts:533, 546`), NOT by consolidation. V1/V2's "0.7 candidate band"
  framing was wrong for the reconsolidation symptom.
- `candidateK` 5; `consolSkipThreshold` 0.2 (salience, not cosine); `rankedRetrievalFloor`
  0.3 (answering path, not consolidation).

---

## Measurements (read-only)

### M1 — Reference distribution: successful reconciliations (value vs prev_value)

For the 280 live nodes with `prev_value IS NOT NULL, tombstoned=0` (these DID reconcile —
the judge fired contradict and tombstoned the prior belief), cosine of the new value vs the
prior value it replaced:

| stat | value |
|------|-------|
| N | 280 |
| mean | 0.5355 |
| min | 0.2755 |
| p10 | 0.3997 |
| p50 | 0.5243 |
| p90 | 0.6952 |
| max | 0.9613 |

Band distribution: **<0.3 = 1** · **0.3–0.7 = 255** · **≥0.7 = 24**.

Reading: real reconciliations sit overwhelmingly in the **0.3–0.7 band** (255/280 = 91%).
They clear the 0.3 candidate gate with ease (only 1/280 below it) and reach the judge — the
0.7 number is irrelevant to whether a contradiction reaches the judge.

### M2 — Failure population: near-duplicate live fact nodes minted separately

Bounded nearest-neighbor cosine scan over 400 live `type='fact'` nodes (stored vectors, no
re-embedding). 152 non-identical pairs scored ≥0.6. Top surfaced pairs (these are the
symptom — same belief asserted twice, minted as two nodes instead of reconciled):

| cos | A (truncated) | B (truncated) |
|-----|---------------|---------------|
| 0.9711 | "…large at 1536 clears 0.7 on 0 of 18 same-domain pairs" | "…small at 1536 clears 0.7 on 0 of 18 same-domain pairs" |
| 0.9533 | "Reply with exactly the token SUBCHECK_OK and nothing else" | "Reply with exactly this token and nothing else: SUBCHECK_OK" |
| 0.8894 | "…whether extraction pass should block judge or…" | "…whether to block extraction on judge or judge facts as…" |
| 0.8785 | "Task a3fb…f0269 completed successfully" | "Task a79d…d45c3 completed with status complete" |
| 0.8735 | "Task b34yx1k6p completed with exit code 0" | "Task b50b19s3i executed with exit code 0" |
| 0.8253 | "User restarted the session" | "Session was restarted" |
| 0.8240 | "Claude Code subscription should not be marketed as plug and play…" | "Claude Code subscription users need to obtain an API key" |
| 0.7940 | "recense is good for agents but not human readable" | "recense is used for memory facts and agent processing" |

(Some pairs are genuinely distinct facts — e.g. the 24.x-PLAN→decisions rows are different
plans — and would correctly NOT reconcile. But many, like the SUBCHECK_OK and "Task …
exit code 0" pairs, are the same belief restated and SHOULD have collapsed.)

Band distribution of all 152 surfaced near-dup pairs: **<0.3 = 0** · **0.3–0.7 = 104** ·
**≥0.7 = 48**. Top-30 mean cosine = **0.8148**. Every one of the top-30 is ≥0.3.

### M3 — Gate analysis: how many real same-belief pairs are gated OUT?

- The consolidation candidate gate is `unrelatedSimilarityThreshold` = 0.3.
- Reference (reconciled) set below 0.3: **1/280** — i.e. the 0.3 gate almost never blocks a
  real contradiction from reaching the judge.
- Surfaced near-dup (duplicated) pairs below 0.3: **0/152**. **The duplicates were NOT
  gated out by cosine.** They all reached the candidate set (cosine 0.3–0.97) and were
  STILL minted as separate nodes.

**Conclusion: lowering the cosine gate admits ~zero additional pairs** — the symptom pairs
already clear it. There is no cosine threshold to retune that fixes this, and no value to
which `deletedSimilarityThreshold` (0.7) could move that matters, because 0.7 does not gate
this path at all.

### M4 — Cue-shape comparison

| cue shape | mean cosine |
|-----------|-------------|
| V2 question-vs-node (recall cue) | ~0.45 |
| V3 belief-vs-prior (reconciled reference) | 0.5355 |
| V3 near-dup pair (symptom set, top-30) | 0.8148 |

Claim/belief-shaped cues DO score materially higher than question cues, and the actual
duplicates score very high (0.81 mean). The cue shape is not the bottleneck — these pairs
are plenty similar.

---

## Root cause

**The duplicate-fact symptom is NOT model-bound and NOT cosine-gate-bound. It is downstream
of retrieval — in the judge verdict and/or the PE-resistance contradiction routing.**

Evidence: every surfaced duplicate pair cleared the 0.3 candidate gate (cosine 0.7–0.97 for
the worst offenders), so the contradicting claim WAS retrieved into the candidate set. Yet a
second node was minted instead of the pair collapsing. That can only happen at/after the
judge step:
- the judge returned `unrelated`/`extend` (not `contradict`/`confirm`) for a same-belief
  pair, **or**
- the judge returned `contradict` but PE routing chose `append-new`/`hold` instead of
  `reconcile`.

The `config.ts:278-293` comment for `peAppendNewMinResistance` documents this exact failure
class verbatim: *"the old node is never tombstoned, every contradiction produces a duplicate,
and belief-correction never completes (D-16 structural defect for fresh nodes)."* The
`peAppendNewMinResistance: 0.3` guard was added to mitigate it for fresh nodes, but the live
DB still shows 152 near-dup pairs — so either (a) the judge isn't classifying same-belief
restatements as `confirm`/`contradict`, or (b) PE routing still escapes to `append-new`/`hold`
in practice. Distinguishing (a) from (b) requires the judge verdicts, which this read-only
embedding probe cannot see.

Honest caveat: this probe localizes the failure to "post-retrieval" but cannot itself
separate a judge-classification miss from a PE-routing miss. That needs a $0 judge-replay
on the surfaced pairs (run the live judge over the ~30 surfaced near-dup claim/candidate
pairs and read the verdicts) — the recommended next step.

---

## Concrete, quantified fix recommendation

**The lever is NOT a threshold on the cosine path and NOT the embedder model.**

Ranked by evidence:

1. **(PRIMARY) Instrument and fix the judge → PE-routing path, not retrieval.**
   - Lowering `unrelatedSimilarityThreshold` 0.3 → anything admits **0 of the 152** surfaced
     dup pairs that aren't already admitted (they're all ≥0.3). Quantified: a cosine-gate
     retune buys **zero** dup reductions. Do not pull it.
   - The fix space is the judge verdict and PE routing. The single most likely lever, per
     the `config.ts:278-293` analysis, is the contradiction routing for restatements:
     ensure same-belief restatements classify as `confirm` (strengthen, no mint) or
     `contradict→reconcile` (tombstone old, mint one). The smallest next test that names the
     exact lever: **a $0 judge-replay over the top ~30 surfaced near-dup pairs** — feed each
     pair to `provider.judge` and tabulate verdicts. If most come back `unrelated`/`extend`,
     the lever is the **judge prompt/model** (it's failing to recognize restatements). If
     they come back `contradict` but with magnitude too low to clear `peReconcileBandLow`,
     the lever is **PE routing / magnitude calibration** (lower `peReconcileBandLow` or fix
     magnitude estimation).
2. **(SECONDARY) Entity/dedup pass already shipped (Phase 25).** Some of these 152 pairs are
   exactly what an EntityDedup-style merge would catch retroactively. Phase 25's dedup is for
   entities; a fact-level dedup variant could mop up residual fact duplicates that slipped the
   live judge. This is remediation, not prevention.
3. **(NOT IT) Content-ingestion coverage** — was V1's explanation for 2 longmemeval misses,
   orthogonal to this dup symptom. The 152 dups prove the content WAS ingested (twice).
4. **(NOT IT) Embedder model swap** — V2 showed large@1536 lifts 0/18 pairs over any gate;
   V3 shows the dups already score 0.7–0.97 under small. A better embedder changes nothing
   here.

---

## Re-scope guidance for RETR-02 / RETR-03

The phase's working hypothesis — "raise the embedder ceiling so contradicting claims cluster"
— is **disproven**. Contradicting/duplicate claims already cluster at high cosine (0.7–0.97)
and clear the 0.3 candidate gate; they are NOT failing at retrieval. RETR-02/03 should be
rewritten to target the **judge-classification + PE-resistance contradiction routing**, not
the embedder or any cosine threshold. Concretely: the rewritten phase should (1) run a $0
judge-replay over the surfaced near-dup pairs to split the failure into "judge mis-classifies
restatements" vs "PE routing escapes to append-new/hold," then (2) fix whichever it is — a
judge-prompt change to recognize restatements, and/or a PE-magnitude/`peReconcileBandLow`
recalibration so a genuine restatement reconciles instead of minting a dup. Drop the
re-embed + paid-replay plans (Plan 02/03/04 as scoped); there is no model swap to validate.
A fact-level dedup pass (Phase 25 analog) is a reasonable remediation track for the existing
152 residual duplicates, separate from the prevention fix.

---

## No secret exposure

OPENAI_API_KEY read from `process.env` only — never logged, never written here. Live DB
opened READ-ONLY (no writes, no mutations, no config changes). Cost ~$0.0003.
