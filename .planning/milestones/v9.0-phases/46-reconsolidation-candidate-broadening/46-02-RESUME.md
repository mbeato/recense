# Plan 46-02 — PAUSED for Anthropic quota (resume post-reset)

**Paused:** 2026-06-28, ~70% weekly Anthropic usage consumed, ~2.5h to reset.
**Why paused:** every remaining step needs the `claude -p` judge (Anthropic subscription).
Local Ollama fallback is non-viable (35b judge would take *days* vs hours on claude -p).

## DONE — RECON-03 PROVEN ✅

BM25-ON KU replay complete. Judge-fire (contradict) counter = **368 across 14 clean cases**
vs pre-Phase-46 baseline of **ZERO**. RECON-03 (judge fires on real KU contradictions) PROVEN.

- Artifact (gitignored, on disk): `scripts/eval/results/46-recon03-ku-bm25on.json`
- Commits: `f4de897` (parallelize harness), `fc87eb1` (--only-cases filter)

**Per-case contradicts:**
```
CLEAN (14):  6a1eabeb=35 ce6d2d27=31 184da446=31 08e075c7=28 b6019101=17
             e493bb7c=15 01493427=18 db467c8c=30 dfde3500=6 9bbe84a2=22
             0977f2af=25 42ec0761=21 2133c1b5_abs=42 07741c45=47   → sum 368
CORRUPTED (4): ed4ddc30=0 5831f84d=0 4b24c848=0 e66b632c=0   (limit-corrupted, excluded)
```
The 4 corrupted cases hit a mid-run rate-limit: judge returned empty → false 0 contradicts +
inflated dup-mints (~1800 each). They contributed 0, so headline 368 already excludes them.

## DECIDED — OFF isolation via pre-46 baseline (no fresh OFF run)

Fresh BM25-OFF A/B was killed: it costs the same as ON (~5h, judges nearly as much because
most KU claims have a cosine neighbor regardless of BM25). Isolation instead rests on:
1. **Documented pre-Phase-46 baseline**: KU judge-fires = 0 (STATE.md / backlog 999.2).
2. **Code-level certainty**: with `bm25CandidateK=0`, low-cosine contradiction claims hit
   `cosineGate && anchors.length===0 && bm25Candidates.length===0` → skipped (consolidator.ts:813).
   They structurally cannot be judged without BM25 → OFF≈0 is not in question.

## TODO post-reset (needs claude -p / Anthropic headroom)

### 1. Re-run the 4 corrupted cases → splice into ON JSON (cosmetic: pristine 18/18)
```bash
cd /Users/vtx/brain-memory && npm run build
node scripts/eval/replay-ku-harness.cjs --parallel-cases 4 \
  --only-cases ed4ddc30,5831f84d,4b24c848,e66b632c \
  --out scripts/eval/results/46-recon03-ku-bm25on-rerun4.json
node /private/tmp/claude-501/-Users-vtx-brain-memory/5133c2a8-f438-4ac0-96a2-bdeaf9b0ee3d/scratchpad/splice-rerun.cjs \
  scripts/eval/results/46-recon03-ku-bm25on.json \
  scripts/eval/results/46-recon03-ku-bm25on-rerun4.json
```
(splice script also lives in scratchpad; recreate from this note if cleared.)

### 2. EVAL-02 clean-case no-regression (RECON-04) — MUST run via claude -p, not local
`scripts/eval/eval02-sweep.sh` defaults to local Ollama (qwen3.6:35b) = too slow.
Override to claude -p judge, compare clean-case belief-correction vs pre-46 baseline
(eval02-sweep.csv). Confirm no regression.

### 3. Founder checkpoint (Task 2) + write 46-02-SUMMARY.md
Sign off: RECON-03 counter > 0 (✅ 368), EVAL-02 no regression (pending #2), invariants intact.

## Optional: route claude -p via GCP/Vertex to dodge the subscription weekly cap
(User note) Building GCP/Vertex history could let the remaining heavy runs bypass the
subscription weekly limit. Setup task, not done — evaluate before the next big run.
