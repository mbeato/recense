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

## `--no-think` experiment (REJECTED) — `judge-eval-contradiction-nothink.log`

The local sleep pass at 35b-a3b-with-thinking runs ~11 min/episode (multiple judge/extract calls,
each spending the 8192-token think budget) — too slow for the recurring pass. Hypothesis: disable
Qwen's reasoning pass (`--no-think` appends the `/no_think` soft switch, drops `max_tokens` to 1024,
and omits `response_format` to mirror the production OllamaClient) for a large speedup. Tested on the
17-case contradiction set:

| config (qwen3.6:35b-a3b) | rel-acc | contradiction detection | parse-fail | throughput |
| ------------------------ | ------- | ----------------------- | ---------- | ---------- |
| think (baseline)         | 100%    | 13/13                   | 0          | ~33s/case  |
| **--no-think**           | 17.6%   | **2/13** (11 missed)    | **14/17**  | ~32s/case  |

**Rejected on both axes:**
1. **No speedup** — ~32s/case, identical to thinking. The latency is dominated by prompt processing
   of the candidate list + model base cost, NOT think-token generation. So no-think can't fix throughput.
2. **Accuracy collapses** — on the hard judge task the model *ignores* `/no_think` and reasons anyway,
   then truncates mid-think at the 1024 cap → **13/17 empty outputs** → SAFE_VERDICT `unrelated` →
   11/13 contradictions MISSED (the graph-corrupting direction). The 3 that returned were correct.
   Raising max_tokens back to 8192 just reproduces think mode.

**Conclusion:** the think pass is load-bearing AND is not the speed bottleneck. There is no
fast-no-think config for this model/task. Throughput must be solved another way — **split-routing**
(small fast model for high-volume extraction; keep 35b-a3b *with thinking* for the judge) is the
highest-value path and aligns with the Phase 5 ModelProvider split. Alternatives: accept the
hourly-launchd grind, or keep the judge on Haiku (reintroduces spend).

## Extraction model bake-off — `extract-bakeoff.cjs` / `extract-bakeoff.log`

Extraction is the high-volume sleep-pass step and is *forgiving* (safe-fallback parsing — bad output
drops claims, never corrupts the graph), so the goal is the fastest model that clears a "good enough"
bar. `extract-bakeoff.cjs` runs the engine's REAL extraction prompt + parser through each candidate on
K real episodes, measuring latency + parse-success + claim count, then scores each output for
faithfulness+coverage (1–5) with Haiku as reference judge. (5 episodes, 2026-06-07:)

| model (local unless noted)      | avg latency | avg claims | parse-fail | quality (1–5) |
| ------------------------------- | ----------- | ---------- | ---------- | ------------- |
| haiku:claude-haiku-4-5 (API)    | 3.2s        | 12.6       | 0          | 4.80          |
| **qwen2.5:7b-instruct**         | **7.9s** (~4s warm) | 8.8 | 0          | **4.20**      |
| qwen2.5:3b-instruct             | 5.3s        | 14.0       | 0          | 2.80 ❌       |
| qwen3-vl:8b-instruct-q8_0       | 24.3s       | 21.0       | 0          | 5.00          |

**Winner for local extraction: `qwen2.5:7b-instruct`** — faithful (q4.20, no hallucinations), ~4s/episode
warm, non-reasoning (no think-pass tax), free. Comparable speed to Haiku's API call, at $0.

- **qwen2.5:3b — DISQUALIFIED.** Fast but q2.80: it intermittently **regurgitates the prompt's few-shot
  examples as if extracted** (the judge caught `"Jane Doe is the founder"` / `"Never inflate metrics"`
  — both prompt examples, absent from the source — on 2 of 5 episodes). A graph-writing path can't inject
  hallucinated facts. Smaller-than-7B is a false economy here.
- **qwen3-vl:8b — best quality (q5.0) but too slow (24s, over-extracts).** Not worth 3× the latency.

### Implication for split-routing
Fast local extraction is now *solved* (7b). But the per-claim **judge** on local 35b-a3b-with-thinking
remains the dominant sleep-pass cost (judge calls scale with claim count, each ~30s). So the viable
configs both need per-call-type routing (= the Phase 5 ModelProvider split):
- **All-local ($0):** extraction→qwen2.5:7b, judge→qwen3.6:35b-a3b — accept the offline/overnight grind.
- **Cost-optimized (fast):** extraction→qwen2.5:7b (free), judge→Haiku (fast, strong, small spend; judge
  outputs are tiny). Best latency; reintroduces minor judge spend.

---

## EVAL-01: LongMemEval-S harness (`longmemeval-harness.cjs`)

End-to-end benchmark measuring how well brain-memory answers questions over a long conversation
history. Uses the LongMemEval-S question set (`scripts/eval/fixtures/longmemeval-mini.jsonl` for
smoke; full `longmemeval-s.jsonl` for the real run). Each question runs the full engine path:
ingest sessions → sleep pass consolidation → retrieval → answer. GPT-4o scores the final answer
against the gold label (yes/no/value match).

See full documentation in `docs/evals.md`.

### Run (cost probe first — required before full run)

```sh
# Step 1: probe — 10 questions, prints cost estimate, exits
npm run eval:longmemeval:probe

# Step 2: full run (only after probe confirms budget)
npm run eval:longmemeval
```

Flags: `--probe` (10-question cost estimate), `--dry-run` (zero API, MockModelProvider),
`--eval <path>` (override fixture), `--out <path>` (override results file).

### CI smoke (zero API)

```sh
npm run build && node scripts/eval/longmemeval-harness.cjs --dry-run --eval scripts/eval/fixtures/longmemeval-mini.jsonl
```

### Scorer

GPT-4o scores each answer (`exact`, `substring`, `semantic`, `no`). The headline metric is
**exact + substring recall** on the full question set. The knowledge-update sub-score
(questions requiring a contradicted fact to be updated) is reported separately — this is the
dimension where brain-memory's PE-gated reconsolidation is expected to outperform ADD-only systems.

**Two caveats (do not drop):**

1. **The scorer is GPT-4o, not a fixed oracle.** Evaluation cost scales with question count (~$0.01–0.02/question at full scale). Always run `--probe` first.
2. **LongMemEval-S is a subset.** The mini fixture (`longmemeval-mini.jsonl`) is the CI smoke set — it does not produce a reportable headline score. Full score requires the full 500-question set.

---

## EVAL-02: Correctness suite (`correctness-harness.cjs`)

Measures belief-correction rate: when a user states a fact, then later contradicts it, does
brain-memory update the stored belief and suppress the stale one? Runs each fictional-persona
case end-to-end through the real engine on a scratch DB. Compares against an ADD-only baseline
(no sleep pass — both facts accumulate, stale recall is guaranteed).

See full documentation in `docs/evals.md`.

### Run

```sh
npm run eval:correctness
```

Dry-run (zero API — CI smoke mode):

```sh
npm run eval:correctness:dry
```

Flags: `--dry-run` (MockModelProvider, zero API), `--cases <path>` (override fixture),
`--out <path>` (override results file).

### Cases

`scripts/eval/cases/correctness-cases.json` — fictional personas (Ana Kowalski, etc.),
each with an `initial_fact`, a `contradicting_fact`, a `query_probe`, and an `expected_answer_hint`.
~17 cases: ~13 contradictions + 4 controls (confirm/extend), magnitude spread 0.3–0.9.

### Scorecard metrics

| metric | description |
| ------ | ----------- |
| `belief-correction rate` | fraction of contradiction cases where retrieval returns the new fact (not the old one) |
| `stale-recall rate` | fraction of cases where the old (stale) fact still surfaces — lower is better |
| `tombstone presence` | fraction where the engine created a tombstone for the old belief |
| ADD-only baseline | always 0% correction, 100% stale — both facts are always present |

### CI smoke (zero API)

```sh
npm run build && node scripts/eval/correctness-harness.cjs --dry-run
```

**Two caveats (do not drop):**

1. **Fictional cases are clear-cut.** The case set uses unambiguous value changes (numeric drift, categorical reversal) — real-world contradictions are harder. This measures the lower bound of the belief-correction mechanism, not production accuracy on noisy input.
2. **ADD-only is a weak baseline.** It is the floor, not a competitor. The correctness suite establishes that brain-memory clears the bar of "does anything at all" on belief correction; a stronger comparison requires running mem0 or similar against the same cases.
