# Phase 26: Cosine-Ceiling Diagnosis V2 — RETR-01 (corrected experiment)

**Date:** 2026-06-18
**Script:** `scripts/eval/diagnose-cosine-ceiling-v2.cjs`
**DB:** `~/.config/recense/recense.db` (live, opened READ-ONLY)
**Models:** `text-embedding-3-small@1536` vs `text-embedding-3-large@1536`
**Cost:** ~$0.0001 (77 short embeddings across 4 batched calls + a read-only topk scan)

---

## Why V1 was measurement-invalid

V1 (`26-DIAGNOSIS.md`) paired longmemeval KU **questions** against nodes drawn from the
founder's **own live memory DB**. Those two corpora are about entirely different lives — a
question like "What day do I take a cocktail-making class?" was cosine-matched against a
node like "Hazrat Mirza Ghulam Ahmad founded the Ahmadiyya Muslim Community." Cross-domain
pairs score ~0 under any embedding model, so V1 could not reveal a model ceiling — it
measured topical unrelatedness, not embedding quality. V2 fixes this by sampling REAL nodes
from the live DB and writing a paraphrased natural-language question whose correct answer
IS each node's current value (same-domain, semantic-not-lexical match).

---

## Methodology

1. **Live DB, read-only.** Resolved the engine way (`RECENSE_DB` env → homedir default).
   No writes, no config changes, no paid eval.
2. **Stratified sample, 18 nodes.** First 10 with `prev_value IS NOT NULL` and
   `tombstoned=0` (reconsolidation actually happened — the heart of the symptom), then 8
   substantive `fact`/`entity` nodes across a degree spread (0–3) to fill.
3. **Hand-written paraphrased questions.** Each question targets the node's CURRENT value,
   deliberately avoids the node's distinctive content words (testing semantic match, not
   string overlap), and reads as a short recall cue. (E.g. node "Token cost framing: Max
   doesn't burn his weekly quota during design blocks…" → "should i worry about spending
   tokens when running parallel design explorations?")
4. **Fresh, symmetric embeddings.** For each pair: `cosine(embed(question), embed(value))`
   under both models. No instruction prefix (D-03 — OpenAI models are symmetric).
5. **Real retrieval trace** (5-pair subset, including prev_value cases): embed the question
   with small@1536 and run the engine's actual `CandidateRetriever.topk()` cosine scan
   against the live DB's stored embeddings (read-only). Records target rank + cosine.

---

## Per-pair cosine table (question × node.value)

| id | prev_value? | small@1536 | large@1536 | Δ(L−S) | small ≥0.7? | large ≥0.7? |
|----|------------|-----------|-----------|--------|------------|------------|
| 77159c27 | yes | 0.4566 | 0.4693 | +0.0127 | no | no |
| ab8750c7 | yes | 0.5931 | 0.6018 | +0.0088 | no | no |
| 5db1c554 | yes | 0.4176 | 0.4059 | −0.0117 | no | no |
| 81c6a3f5 | yes | 0.4375 | 0.5046 | +0.0671 | no | no |
| 5d87e69e | yes | 0.3393 | 0.3883 | +0.0490 | no | no |
| 21fc25aa | yes | 0.4268 | 0.4757 | +0.0489 | no | no |
| 799cbcd1 | yes | 0.4230 | 0.4725 | +0.0495 | no | no |
| c27f02d2 | yes | 0.3621 | 0.3350 | −0.0271 | no | no |
| 6d1fe51b | yes | 0.5150 | 0.5847 | +0.0697 | no | no |
| b02f2904 | yes | 0.3423 | 0.3849 | +0.0426 | no | no |
| 6811af13 | no  | 0.4651 | 0.4823 | +0.0172 | no | no |
| 5d205420 | no  | 0.4061 | 0.4740 | +0.0679 | no | no |
| f9c86e1f | no  | 0.4180 | 0.3995 | −0.0185 | no | no |
| 0ff38221 | no  | 0.4241 | 0.4884 | +0.0643 | no | no |
| 619b6fa6 | no  | 0.4649 | 0.5130 | +0.0482 | no | no |
| 21ee6e78 | no  | 0.6253 | 0.6022 | −0.0230 | no | no |
| f75df155 | no  | 0.4332 | 0.5250 | +0.0918 | no | no |
| 64f4ea90 | no  | 0.4902 | 0.4855 | −0.0048 | no | no |

## Aggregates

- **small@1536 clears 0.7:** 0 / 18
- **large@1536 clears 0.7:** 0 / 18
- **pairs below 0.7 under small:** 18
- **large LIFTS above 0.7 (of the below-0.7 set):** 0 / 18 (0%)
- **mean cosine:** small ≈ 0.451, large ≈ 0.477 (mean Δ ≈ +0.026)
- **max cosine observed:** small 0.6253, large 0.6253 — neither model reaches 0.7 on any pair
- prev_value subset (n=10): mean small ≈ 0.431, large ≈ 0.462 — no different from the full set

## Real retrieval trace (small@1536, live DB, read-only)

| id | prev_value? | target rank | target cosine | in top-10? |
|----|------------|-------------|---------------|-----------|
| 77159c27 | yes | 12 | 0.4566 | no |
| 81c6a3f5 | yes | 3  | 0.4380 | yes |
| c27f02d2 | yes | miss (not in top-20) | — | no |
| 6d1fe51b | yes | 1  | 0.5150 | yes |
| 6811af13 | no  | 10 | 0.4651 | yes |

The target node IS reachable for most cues (ranks 1, 3, 10, 12) but always at a cosine well
below 0.7. One prev_value cue (c27f02d2) missed the top-20 entirely — outranked by other
nodes that the question's phrasing happened to score higher. Crucially: even when the target
is rank-1 (6d1fe51b at 0.5150), it sits ~0.18 below the 0.7 contradiction/deleted band.

---

## Interpretation

The decisive observation: **paraphrased natural-language questions sit at ~0.45 cosine to
their correct answer node under BOTH models, and the large model does not move them above
0.7 (mean lift only +0.026; 0/18 cross the band).**

This is consistent with the engine's own documented expectation. `src/lib/config.ts`
(rankedRetrievalFloor comment, line ~343) states: *"real queries score 0.4–0.6 against
stored facts — below the single-hit 0.7 bar but well above noise."* My measured 0.34–0.63
range matches that exactly. The 0.3 `rankedRetrievalFloor` (which all 18 pairs clear) is why
ranked retrieval/answering works — and it does: the per-turn eval scored 90% KU.

The 0.7 band is `deletedSimilarityThreshold` (D-29) — the high bar a cue must clear for the
tombstone/contradiction scan to fire. Paraphrased cues structurally cannot reach it, and the
model swap does not change that. So the "contradicting count-claims never cluster as judge
candidates" symptom is **threshold-bound, not model-bound**: the candidate gate is set at a
similarity that semantic (paraphrased) cues do not produce, regardless of small vs large.

Caveat on honesty: the swap is not actively harmful (mean Δ is slightly positive, +0.026),
but +0.026 is far too small to be load-bearing — it would not lift a 0.45 pair to 0.7. The
budget for a re-embed + paid replay would buy a ~3% average cosine bump that crosses zero
thresholds. That does not satisfy the D-01 gate ("confirm model-bound before spending").

---

## GO / NO-GO Verdict

**NO-GO on the model swap as the RETR-01 fix.**

Reasoning, against the architect's stated criteria:
- GO required: same-domain pairs routinely below 0.7 under small **AND** large lifts ≥⅓ of
  them above 0.7. The first half holds (18/18 below 0.7); the second fails hard (0/18, 0%).
- NO-GO trigger ("small already clears 0.7") does **not** literally apply — small clears 0.7
  on 0/18. But the spirit of NO-GO does apply for a stronger reason: **neither model clears
  0.7 on valid same-domain pairs**, and large doesn't lift any. The fix lever is therefore
  NOT the embedder model.

The weakness is **threshold-bound** (and partly content/cue-shape-bound), not model-bound.

### Where to look next (smallest tests first)

1. **Threshold, not model.** Re-examine the 0.7 `deletedSimilarityThreshold` /
   contradiction-candidate gate. Paraphrased semantic cues land at ~0.45; the gate that
   admits a contradiction to the reconsolidation judge appears mis-calibrated for
   question-form cues. A targeted threshold sweep on the contradiction path (read-only, $0)
   is the cheapest next experiment — and it directly tests the actual symptom.
2. **Cue shape.** Reconsolidation in production is driven by NEW-CLAIM cues during
   consolidation, not by user questions. A new claim that restates a fact has much higher
   lexical+semantic overlap than a paraphrased question (e.g. "Node runtime is now v25.5.0"
   vs the stored "Updated service version… to v25.5.0"). The relevant next measurement is
   claim-vs-stored-node cosine during a real consolidation, not question-vs-node — this
   spot-check used questions because that was the V2 design, but it suggests the live
   symptom should be reproduced on the consolidation claim path.
3. **Content-ingestion coverage** remains the explanation for the 2 longmemeval failures
   (V1 finding) — orthogonal to this threshold finding but still real.

Do NOT proceed to the re-embed (Plan 02/03) or the paid replay (Plan 04) on the strength of
the model swap. Re-scope the fix toward the contradiction-candidate threshold / cue path.

---

## No Secret Exposure

OPENAI_API_KEY was read from `process.env` only — never logged, never written to this note.
The live DB was opened READ-ONLY; no writes, no mutations, no config changes.
Cost: ~$0.0001 (well within the "$0 diagnosis" envelope, D-10).
