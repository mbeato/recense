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

### Known gap

The **contradiction** dimension is undertested: the set has only **n=1** contradict case,
and both Qwen models called it `extend` (the one strengthened-a-conflict each). `mag-MAE`
is therefore a single-point number, not a distribution. Building out contradiction coverage
is a follow-up task — treat the current contradict/magnitude results as not yet conclusive.
