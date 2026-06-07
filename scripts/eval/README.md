# Judge-model eval harness

Measures how well a candidate judge model performs the brain-memory **judge task**:
given a new claim and its top-5 cosine neighbors from the graph, decide which candidate
(if any) it matches and how they relate (`confirm | extend | contradict | unrelated`,
plus a contradiction `magnitude`). The judge prompt here is a byte-for-byte copy of the
live engine prompt in `src/model/judge.ts`.

Purpose: compare a **local Qwen** candidate against the **Haiku** baseline so we can
decide whether the judge can run cheap/local, or must stay on a strong API model. See
the memory note "Judge must be empirically validated" — local parity is not assumed,
it is measured on our own eval.

## Files

- `judge-eval-extract.cjs` — builds an eval set from a `brain.db` (read-only, no API calls)
- `judge-eval-set.json` — 48 hand-labeled gold cases (label fields are ground truth)
- `judge-eval-runner.cjs` — runs candidate models over the set and scores them
- `judge-eval-results.json` — last run's per-case detail (incl. raw model output)
- `judge-eval-3way-v2.log` — last run's console output (baseline record)

## Run

### 1. Build an eval set from a brain.db (optional — a labeled set is committed)

```
node scripts/eval/judge-eval-extract.cjs ./brain.db
```

Writes `scripts/eval/judge-eval-set.json` with **blank** label fields. Each case must be
hand-labeled (ground truth) before scoring. The extractor slices the cosine gray zone
(0.3–0.97) evenly across difficulty bands — that middle is where the judge earns its keep.

### 2. Run the harness

```
NODE_PATH=$(pwd)/node_modules node scripts/eval/judge-eval-runner.cjs --eval scripts/eval/judge-eval-set.json --ollama "qwen3.6:27b,qwen3.6:35b-a3b" --haiku claude-haiku-4-5
```

Or via npm (caller still sets `NODE_PATH` and appends provider flags):

```
NODE_PATH=$(pwd)/node_modules npm run eval:judge -- --ollama "qwen3.6:27b,qwen3.6:35b-a3b" --haiku claude-haiku-4-5
```

Flags: `--eval` (set path), `--haiku <model>` (pass `""` to skip), `--ollama "<m1,m2>"`,
`--ollama-url` (default `http://localhost:11434/v1`), `--out` (results JSON path).

## Label schema

Each case in the eval set carries a ground-truth `label`:

- `relation` — one of `confirm | extend | contradict | unrelated`
- `best_candidate_id` — id of the matching candidate (or `best_candidate_index`, 0-based;
  `''`/`-1` = none). Ignored for `unrelated`.
- `magnitude` — float `[0,1]`, contradiction severity; only scored on `contradict` cases.

## Harness facts (read before trusting a run)

- **Ollama reasoning models need `max_tokens >= 8192`.** Qwen 3.6 spends tokens on a think
  pass before emitting JSON; a 256 cap truncates mid-thought and yields empty content.
- **Haiku returns fenced JSON.** The runner's `parseVerdict` salvages the first `{…}` block
  (functionally equivalent to the engine's `extractJsonObject`), so fenced output scores as
  `salvaged`, not `parse-fail`.
- **`ANTHROPIC_API_KEY` must be set** for the Haiku baseline; omit `--haiku` to skip it.
- **Ollama models must be pulled locally** (`ollama pull qwen3.6:27b`); pass the EXACT tags
  from `ollama list`.
- Ollama runs at `temperature 0` (greedy) for stable comparison; Haiku uses default sampling.

## Last 3-way baseline (`judge-eval-3way-v2.log`, 48 labeled cases)

| provider              | rel-acc | best-id-acc | mag-MAE (contradict) | parse-fail        | errors |
| --------------------- | ------- | ----------- | -------------------- | ----------------- | ------ |
| haiku:claude-haiku-4-5 | 47.9%   | 74.2%       | 0.150 (n=1)          | 0 (+48 salvaged)  | 0      |
| ollama:qwen3.6:27b     | 58.3%   | 93.5%       | 0.850 (n=1)          | 0                 | 0      |
| ollama:qwen3.6:35b-a3b | 64.6%   | 90.3%       | 0.850 (n=1)          | 0                 | 0      |

Dangerous (graph-corrupting) errors: Haiku 10 (all spurious-link); qwen3.6:27b 11
(10 spurious-link, 1 strengthened-a-conflict); qwen3.6:35b-a3b 10 (9 spurious-link,
1 strengthened-a-conflict).

### Known gap (closed below)

The **contradiction** dimension was undertested: the set had only **n=1** contradict case,
and both Qwen models called it `extend` (the one strengthened-a-conflict each). `mag-MAE`
was therefore a single-point number, not a distribution. Closed by the contradiction-focused
set below.

## Contradiction-focused set (`judge-eval-contradiction-set.json`, 17 cases)

Contradictions can't be mined from the cosine gray-zone (conflicting values on the same
subject don't sit in the mid-cosine band — that's why the set above had n=1). They're
**constructed** instead by `judge-eval-contradiction-build.cjs`: each case takes a real
`brain.db` node as the stored belief (candidate) and pairs it with a hand-authored claim
stating an opposing value on the same subject, plus near-miss `confirm`/`extend` controls.
Candidates = target + its real top-cosine neighbors; target placed at varied slots.

- 13 contradictions, magnitudes calibrated 0.3 (mild numeric drift) → 0.9 (categorical reversal)
- 2 `confirm` + 2 `extend` controls (so the set isn't gameable by always answering "contradict")

Build + run:

```bash
node scripts/eval/judge-eval-contradiction-build.cjs ./brain.db
NODE_PATH=$(pwd)/node_modules node scripts/eval/judge-eval-runner.cjs \
  --eval scripts/eval/judge-eval-contradiction-set.json \
  --out scripts/eval/judge-eval-contradiction-results.json \
  --ollama "qwen3.6:27b,qwen3.6:35b-a3b" --haiku claude-haiku-4-5
```

### Result (`judge-eval-contradiction-3way.log`)

| provider               | rel-acc | best-id-acc | mag-MAE (contradict) | dangerous errs |
| ---------------------- | ------- | ----------- | -------------------- | -------------- |
| haiku:claude-haiku-4-5 | 100.0%  | 94.1%       | 0.250 (n=13)         | 0              |
| ollama:qwen3.6:27b     | 100.0%  | 100.0%      | 0.342 (n=13)         | 0              |
| ollama:qwen3.6:35b-a3b | 100.0%  | 100.0%      | 0.350 (n=13)         | 0              |

All three caught **13/13** contradictions as `contradict` and all 4 controls correctly
(`confirm`/`extend`) — **zero** strengthened-a-conflict errors. Both Qwen models matched or
beat Haiku on candidate selection (100% vs 94.1%).

### Decision: GREEN-light local judge on contradiction *detection*

The load-bearing direction — never reinforcing a stale fact by calling a conflict
`extend`/`confirm` — is handled by `qwen3.6:35b-a3b` identically to Haiku on this set. This
closes the gap that blocked trusting local on the judge. Combined with local's accuracy +
candidate-selection edge on the mined set, **split-routing (local extraction + local judge)
is justified** as the next step.

**Two caveats (do not drop):**

1. **Magnitude is poorly calibrated by *every* model — including Haiku.** None differentiate
   mild from severe: Haiku saturates predictions to ~0.85–0.95, both Qwen to ~1.0, even on
   the true-0.3 mild-drift case (#13). MAE (0.25 / 0.34 / 0.35) is "comparable" only in that
   all three are poor. The PE-gated reconsolidation design must treat `magnitude` as a coarse
   "conflict present → high" signal, **not** a precise 0–1 severity dial — and this is not a
   local-vs-Haiku discriminator.
2. **Constructed cases are clearer than the hardest real conflicts.** These state directly
   opposing values; the mined gray-zone case Qwen flubbed was a subtle near-paraphrase. So
   this is *necessary, not sufficient*: it proves parity on clear value-conflicts (the common
   belief-update case), not on subtle/ambiguous ones.
