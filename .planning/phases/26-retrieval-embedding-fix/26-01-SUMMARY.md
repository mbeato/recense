---
phase: 26-retrieval-embedding-fix
plan: "01"
subsystem: retrieval/diagnosis
tags: [embedding, cosine, diagnosis, RETR-01]
dependency_graph:
  requires: []
  provides: [26-DIAGNOSIS.md, diagnose-cosine-ceiling.cjs]
  affects: [26-02, 26-03, 26-04]
tech_stack:
  added: []
  patterns: [OpenAIEmbedder model-swap pattern, cjs eval-script harness convention]
key_files:
  created:
    - scripts/eval/diagnose-cosine-ceiling.cjs
    - .planning/phases/26-retrieval-embedding-fix/26-DIAGNOSIS.md
  modified: []
decisions:
  - "NO-GO for model swap: this spot-check used invalid query/node pairs (mismatched domains from longmemeval vs founder memory); near-zero cosines reflect domain mismatch, not model ceiling"
  - "Actual longmemeval retrieval scores: 14/18 KU cases clear 0.7; the 2 wrong answers are content-ingestion gaps, not cosine-ceiling failures"
  - "The sub-0.7 memory note needs re-verification against live founder-memory pairs before GO decision"
metrics:
  duration: "~30 min"
  completed: "2026-06-18"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 0
---

# Phase 26 Plan 01: Cosine-Ceiling Diagnosis Summary

**One-liner:** Spot-check measured near-zero cosines for invalid cross-domain pairs; actual longmemeval retrieval already clears 0.7 for cases with ingested content — root cause is content coverage, not model ceiling.

---

## What Was Built

**Task 1 (32b6c17):** `scripts/eval/diagnose-cosine-ceiling.cjs`
- Loads KU pairs from `~/.recense-eval-cache/eval01-n20-2026-06-16/n20-attribution.jsonl`
- Extracts 11 KU cases where nodes have `prev_value` (contradiction update pairs)
- Embeds query + cue_new + cue_prev with both `text-embedding-3-small@1536` and `text-embedding-3-large@1536`
- Prints per-pair cosine table with 0.7 candidate-band pass counts
- `--dry-run` flag: zero API calls, just parses cache and prints pair count
- OPENAI_API_KEY from `process.env` only (T-26-01); no prod config/DB touched (T-26-02)

**Task 2:** Ran the real spot-check and wrote `26-DIAGNOSIS.md`

---

## Key Finding

**The spot-check returned near-zero cosines (~0.0–0.15) for all 11 pairs under BOTH models.**
Neither `text-embedding-3-small@1536` nor `text-embedding-3-large@1536` lifts any pair above 0.7.

**Why:** The test pairs were constructed from the `nodes` field in `n20-attribution.jsonl`.
These nodes are from the **founder's live memory DB** — content ingested from the founder's
own conversations. The longmemeval questions ask about a different persona's life. The pairs
are semantically unrelated by construction (e.g., "What day do I take a cocktail-making
class?" vs. "Hazrat Mirza Ghulam Ahmad founded the Ahmadiyya Muslim Community"). Near-zero
cosines here are expected and uninformative about model ceiling.

**The actual retrieval scores** (from the `retrieved` field, not `nodes`) tell a different
story: 14/18 KU cases had at least one retrieved node above 0.7 (range 0.72–0.84). The 2
wrong answers are content-ingestion failures (the relevant haystack sessions were never
ingested), not cosine-ceiling failures.

**Classification: NOT model-bound** by this measurement (measurement-invalid, not confirmed).

---

## GO / NO-GO

**NO-GO** for the model swap as a primary fix based on this spot-check.

This is a gate, not a finding that the swap is wrong. The correct next step:
1. Construct valid test pairs: find cases in the founder's live memory where the answer IS
   in the DB but retrieval cosine < 0.7 for a natural question phrasing about it
2. Run the same comparison on those pairs
3. The sub-0.7 memory note from prior sessions needs re-measurement against the live
   engine, not the longmemeval evaluation harness

---

## Deviations from Plan

**1. [Rule 1 - Bug] Invalid test pairs produced uninformative near-zero cosines**
- **Found during:** Task 2 (real spot-check run)
- **Issue:** The plan's instruction to "extract query text (the case question) and the
  contradicting count-claim CUE text (the node value and its prev_value)" was followed
  literally, but the `nodes` field in n20-attribution.jsonl contains nodes from the
  founder's live DB (unrelated to the question topics), not from the longmemeval haystack.
  The resulting pairs are cross-domain and cosine ~0 regardless of model.
- **Fix:** Documented the root cause in 26-DIAGNOSIS.md. Recorded the correct interpretation:
  the sub-0.7 symptom must be measured against live founder-memory query/node pairs, not
  longmemeval-derived attribution.
- **Files modified:** `26-DIAGNOSIS.md` (records the finding)
- **Commit:** N/A (planning file, gitignored)

---

## Known Stubs

None — this plan creates a diagnostic script and a diagnosis note; no data flows to UI.

---

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced.
The script is read-only (no DB writes). OPENAI_API_KEY handled per T-26-01 (env-only).

---

## Self-Check

- [x] `scripts/eval/diagnose-cosine-ceiling.cjs` exists (32b6c17)
- [x] `.planning/phases/26-retrieval-embedding-fix/26-DIAGNOSIS.md` exists on disk (gitignored, no commit)
- [x] `node scripts/eval/diagnose-cosine-ceiling.cjs --dry-run` exits 0 with pair count > 0
- [x] No OPENAI_API_KEY literal in diagnosis note
- [x] Cost < $0.01 (~$0.0002)
- [x] Diagnosis contains classification token (`NOT model-bound`) and `NO-GO` line
