# Phase 26: Cosine-Ceiling Diagnosis — RETR-01

**Date:** 2026-06-18
**Script:** `scripts/eval/diagnose-cosine-ceiling.cjs`
**Models tested:** `text-embedding-3-small@1536` vs `text-embedding-3-large@1536`
**Cost:** ~$0.0002 (11 pairs × 3 texts × 2 models = 66 embeddings)

---

## Raw Measurements

### Per-pair cosine table (query × cue_new / cue_prev)

These pairs come from `n20-attribution.jsonl` — KU cases where a node has a `prev_value`
(indicating a reconsolidation update occurred in the DB during the longmemeval run).

| qid | pair | small@1536 | large@1536 | Δ(L-S) | clears 0.7? |
|-----|------|-----------|-----------|--------|------------|
| ce6d2d27 | new  | -0.0079 | 0.0157 | +0.0236 | none |
| ce6d2d27 | prev | 0.0018 | 0.0250 | +0.0232 | none |
| 01493427 | new  | 0.0526 | 0.0491 | -0.0035 | none |
| 01493427 | prev | 0.0357 | 0.0245 | -0.0112 | none |
| db467c8c | new  | 0.0474 | -0.0027 | -0.0501 | none |
| db467c8c | prev | 0.0111 | 0.0334 | +0.0223 | none |
| ed4ddc30 | new  | -0.0161 | -0.0146 | +0.0015 | none |
| ed4ddc30 | prev | -0.0206 | -0.0290 | -0.0084 | none |
| ed4ddc30 | new  | -0.0529 | 0.0138 | +0.0667 | none |
| ed4ddc30 | prev | -0.0594 | 0.0279 | +0.0873 | none |
| 5831f84d | new  | 0.1158 | 0.0846 | -0.0312 | none |
| 5831f84d | prev | 0.1215 | 0.1628 | +0.0413 | none |
| e66b632c | new  | -0.0179 | -0.0115 | +0.0064 | none |
| e66b632c | prev | 0.0126 | 0.0097 | -0.0029 | none |
| dfde3500 | new  | 0.1264 | 0.0863 | -0.0401 | none |
| dfde3500 | prev | 0.1151 | 0.0902 | -0.0249 | none |
| 0977f2af | new  | 0.0266 | 0.1406 | +0.1140 | none |
| 0977f2af | prev | 0.0930 | 0.1486 | +0.0555 | none |
| 42ec0761 | new  | 0.0304 | 0.0072 | -0.0233 | none |
| 42ec0761 | prev | 0.0659 | 0.0012 | -0.0647 | none |
| 2133c1b5_abs | new  | 0.0874 | 0.0728 | -0.0146 | none |
| 2133c1b5_abs | prev | 0.0697 | 0.1016 | +0.0319 | none |

**Aggregate — pairs clearing 0.7 candidate band:**
- `text-embedding-3-small@1536`: 0 / 11
- `text-embedding-3-large@1536`: 0 / 11
- large lifts pairs above 0.7 that small left below: 0

---

## Root-Cause Analysis

### Why the test pairs show near-zero cosines

The cosines are near-zero (~0.0–0.15) for ALL pairs under BOTH models. This is not a
model-ceiling symptom — it is a **semantic mismatch between the query texts and the node
values being measured**.

**Root cause of near-zero cosines in this test:**

The `n20-attribution.jsonl` `nodes` field contains nodes FROM THE FOUNDER'S LIVE DB that
happened to be retrieved during the longmemeval run. Because the recense DB is populated with
the founder's own memory content (not longmemeval haystack content), the retrieved nodes are
about completely unrelated topics — cocktail classes vs. Ahmadiyya theology, egg
inventories vs. the League of Nations, etc. A question about "What day do I take a
cocktail-making class?" cosine-matching against "Hazrat Mirza Ghulam Ahmad founded the
Ahmadiyya Muslim Community" will produce ~0 regardless of which model is used.

**This means the test pairs in the script are not valid measurement pairs.** A valid test
pair would have the retrieval query and the answer node from the SAME knowledge domain —
i.e., testing whether the question "What day do I take a cocktail-making class?" retrieves
a node like "User has cocktail class on Fridays." THOSE pairs would reveal whether a model
ceiling prevents the cosine from clearing 0.7.

### What the actual longmemeval eval data shows

The `retrieved` field in `n20-attribution.jsonl` contains the REAL retrieval scores from
the eval run (these are the nodes the engine actually scored, not the consolidation nodes
used above). Those show a very different picture:

- 14 out of 18 KU cases had at least one retrieved node above 0.7
- Top cosine scores ranged 0.72–0.84 for cases where relevant content was ingested
- The 4 cases with top score < 0.7:
  - `dfde3500`: top=0.6537 (near-miss, borderline)
  - `9bbe84a2`: top=0.5534
  - `0977f2af`: top=0.3243 (Instant Pot — content NOT ingested at all)
  - `2133c1b5_abs`: top=0.6916 (near-miss)
  - `07741c45`: top=0.5930

- The 2 wrong answers:
  - `a2f3aa27`: ZERO retrieved nodes (content not ingested)
  - `0977f2af`: max 0.32 (content not ingested; 10 retrieved nodes all from unrelated
    founder memory topics)

The failures are **content-coverage failures** (relevant content was never ingested from
the longmemeval haystack), NOT a cosine model-ceiling failure.

### Classification

**NOT model-bound** by this measurement.

The sub-0.7 cosine weakness described in memory notes (`cheap-inference-picks.md`, 
`reconsolidation-underperforms-eval.md`) refers to a context where the RELEVANT content IS
in the DB but the retrieval cosine still fails to clear 0.7 — which would indicate a
model ceiling. This test did not surface such cases because:

1. The test pairs were constructed from mismatched question/node domains (invalid pairs)
2. In the actual eval run, retrieval IS clearing 0.7 for cases where content was ingested
3. The failed cases are due to content non-ingestion, not cosine ceiling

---

## GO / NO-GO Decision

**NO-GO** for the model swap as the primary fix **based on this measurement**.

**Critical caveat:** This result does NOT mean the `text-embedding-3-large` swap is wrong.
It means this specific spot-check failed to measure the right thing. The diagnosis is
**measurement-invalid**, not model-validated. The correct follow-up before GO/NO-GO:

1. **Identify valid test pairs:** Find cases in the founder's actual memory where the
   correct answer node IS in the DB but its retrieval cosine stays below 0.7 for a
   plausible question about that topic. These are the pairs that reveal a model ceiling.
2. **Alternative: run a targeted retrieval trace** — ask the engine a question whose
   answer IS in the DB, check the top candidate's cosine under small vs large.
3. **The sub-0.7 symptom from memory notes was likely observed in live reconsolidation
   testing** (real founder sessions), not in the longmemeval harness. Replicate it there.

The existing eval data (90% KU score, 18/20 correct) actually suggests the retrieval path
is NOT catastrophically broken for the per-turn ingestion scenario. The 2 failures are
content-ingestion gaps, not retrieval-cosine gaps.

---

## Implications for Phase 26 Plan

- RETR-01 root cause is **NOT confirmed** as model-bound by this spot-check
- The plan's prior assumption ("Q-cues never clear 0.7 with text-embedding-3-small") needs
  re-verification against real founder-memory pairs, not longmemeval-derived attribution
- D-04 (single lever first) remains correct — but the lever to pull first may not be the
  model swap; it may be addressing content-ingestion coverage
- The model swap (D-02) is still a valid performance improvement, but the Phase 26
  diagnosis gate (D-01) was not satisfied by this run — the measurement must be redone
  with valid query/node pairs from the live engine

---

## No Secret Exposure

OPENAI_API_KEY was not logged, not written to any file, not included anywhere in this note.
Estimated cost: ~$0.0002 (within the "pennies" envelope per D-10).
