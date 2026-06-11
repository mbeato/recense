# brain-memory evals

This document covers the two published evaluations — EVAL-01 (LongMemEval-S) and EVAL-02 (EVAL-02: Correctness suite) — along with the methodology behind each, the judge-model validation evidence, and the honest caveats that context any published numbers.

The goal is reproducibility and honesty, not benchmark warfare. brain-memory numbers are published at face value with repro commands, cost estimates, and methodology disclosure. Competitor figures are self-reported with differing methodologies; we note the differences explicitly. If a number looks bad, that is intentional — we publish whatever the harness produces.

---

## EVAL-01: LongMemEval-S benchmark

### What it measures

[LongMemEval](https://arxiv.org/abs/2410.10813) is an academic benchmark for long-term memory in LLM assistants. It presents a multi-session conversation history to a memory system, then asks questions that require remembering facts across sessions. The benchmark includes five question categories: single-hop, multi-hop, temporal reasoning, knowledge-update, and null/negative. The **knowledge-update category** is the most relevant for brain-memory: it asks questions about facts that changed across sessions, directly exercising whether the system resolved the contradiction to the current value.

We run LongMemEval-S (the standard published split), not a custom subset, so the methodology is directly comparable to the benchmark paper and any vendor claiming a LongMemEval score.

### Methodology

1. **Ingest** — each test case's conversation sessions are fed into a fresh scratch database (isolated per-question, never touching the live `brain.db`) as episodic writes. Each session is prefixed with its date from `haystack_dates` (e.g. `[Session date: 2023/05/20 (Sat) 02:21]`) and the episode `ts` is set to the parsed session date, so the engine's temporal ordering reflects the historical conversation timeline. This is critical for temporal-reasoning and knowledge-update question types. Episodes are ingested with `source: 'conversation'`, which routes extraction through the `CONVERSATION_EXTRACTION_PROMPT` (defined in `src/source/extraction-prompts.ts`). This prompt explicitly targets personal episodic details — durations, quantities, events, preferences — that the default extraction prompt omits. This is the same per-source extraction seam (`promptForSource`, D-62) used by production adapters (gmail, transcripts); the harness uses it to ensure benchmark ingestion is representative of real conversation ingestion.
2. **Sleep pass** — `runConsolidation` is called programmatically after ingestion. This triggers the same PE-gated belief-correction and schema-induction code the hourly launchd job runs.
3. **Retrieve** — after consolidation, the question is embedded with the same OpenAI embedder used in the sleep pass, then the top K (default 10, `--topk` flag) graph nodes are retrieved by brute-force cosine similarity over all embedded, non-tombstoned nodes (`CandidateRetriever.topk`). This is the engine's top-k candidate retrieval substrate — the same primitive the production spreading-activation path uses internally. **The production hook-injection wrapper (`RetrievalEngine.retrieve`) is NOT used.** That wrapper returns at most one result and gates on a deleted-similarity cosine threshold (0.7) calibrated for production session-start injection, not benchmark QA — it would cause nearly every question to abstain because the gold node typically sits at cosine ~0.48 (under the threshold). For the benchmark we want all K best candidates regardless of absolute cosine score.
4. **Answer generation** — the answer prompt is structurally equivalent to the official LongMemEval QA template (`src/generation/run_generation.py`, non-CoT form), adapted for brain-memory's memory-node retrieval format (retrieved graph nodes rather than raw session history). The `Current Date` field is populated from `question_date`. The prompt ends with an open-ended `Answer:` (no "just the factual answer" constraint) so the model can respond "I don't have information about that" for abstention questions. **This is an equivalent, not a verbatim port** — the official template receives raw session text; ours receives retrieved memory nodes.
5. **Scoring** — GPT-4o-2024-08-06 judges each answer binary (correct / incorrect) using the per-question-type judge prompts ported verbatim from the official LongMemEval `src/evaluation/evaluate_qa.py` (`get_anscheck_prompt`). Four distinct templates are used: temporal-reasoning (off-by-one leniency for day counts), knowledge-update (accepts "previous information along with an updated answer"), single-session-preference (rubric-based), and a default template for all other types. Questions whose `question_id` ends in `_abs` use the abstention template regardless of their `question_type`, matching the official scoring protocol. The judge model is the same model the benchmark paper used.

The harness is `scripts/eval/longmemeval-harness.cjs`. Results are committed as JSON under `scripts/eval/results/`.

### Cost-probe gate

Before running the full 500-question suite, a `--probe` flag runs 10 questions and reports `$/question` and estimated total cost. The full run is gated on human approval of the probe output. This prevents accidentally spending $50+ on a misconfigured run.

```sh
npm run eval:longmemeval:probe
# Reports: N questions, $X total, ~$Y/question
# Expected output: estimated spend and wall-clock before you commit to the full run
```

### Rate-limit behavior and concurrency guidance

The harness parallelises questions (each on its own scratch DB). Every parallel question
triggers consolidation, embedding, and answer-gen API calls simultaneously. At high
concurrency (≥ 8) the Anthropic API returns 70–80% 429s, which fail even with the SDK's
retry-after backoff.

**Default concurrency is 4** (`--concurrency 4`). The SDK is configured with 10 retries
for eval runs (vs. production default of 2), allowing it to absorb short bursts via
retry-after backoff without immediately failing. Raise concurrency only after a `--probe`
run completes with **zero error lines and zero quarantined episodes**.

```sh
# Tune the SDK retry budget (default 10 for eval runs):
BRAIN_MEMORY_SDK_MAX_RETRIES=15 npm run eval:longmemeval:probe
```

**Quarantine errors** — if an episode fails to consolidate (e.g. a 429 survives all
retries), the H-2 quarantine guard isolates that episode and the harness records:
- `episodes_quarantined: N` — the count of isolated episodes
- `error: "N episode(s) quarantined during consolidation — memory incomplete"` — marks
  the question result as invalid

Questions with `error` fields are **excluded from scoring** (the scorer skips them and
reports the count in `questions_skipped_error`). They are re-attempted when running with
`--retry-errors`. A published score must come from a run with zero errors and zero quarantines.

### Run the full eval

```sh
npm run eval:longmemeval
# Expected: ~$TBD, ~TBD min (filled in after first recorded run)
```

Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment. Keys are read from the environment or `~/.config/brain-memory/sleep.env`.

### Recorded results

| System | Headline score | Knowledge-update sub-score | Run date | Commit | Methodology |
|--------|---------------|---------------------------|----------|--------|-------------|
| brain-memory | TBD — recorded in 14-05 | TBD — recorded in 14-05 | TBD | TBD | end-to-end QA, GPT-4o-2024-08-06 binary judge |
| mem0 (self-reported) | 94.4% | — | — | — | end-to-end QA |
| Mastra Observational Memory (self-reported) | 95% | — | — | — | end-to-end QA, Gemini 2.5 Flash |
| agentmemory (self-reported) | 95.2% | — | — | — | **retrieval-only R@5, not end-to-end QA** |
| GPT-4o (paper baseline) | 60.6% | — | — | — | LongMemEval paper |
| ChatGPT (paper baseline) | 57.73% | — | — | — | LongMemEval paper |

The knowledge-update sub-score is reported separately because it is the most architecturally relevant number for brain-memory's core claim: if a stored belief is contradicted by new information, does the system return the current value or a stale one? The headline score aggregates across all categories, which may obscure this signal.

---

## EVAL-02: Correctness suite (belief-correction)

### What it measures

EVAL-02 measures whether brain-memory actually corrects stored beliefs when contradicting information arrives. It does not rely on the LongMemEval question set or the GPT-4o judge. Instead, it runs end-to-end through the real engine on a scratch database with hand-authored fictional-persona cases, then queries whether the system now returns the new value or the old one.

This is the "anyone can observe it correct a belief" evaluation: run one command, watch a stored fact get updated in place with a tombstone, compare against the ADD-only baseline that accumulates duplicates instead.

### Case-set composition

The case set is a **hand-authored fictional-persona set committed to the repo** (`scripts/eval/cases/correctness-cases.json`). All personas are fictional (no real-world data).

- **17 total cases** — 13 contradiction cases + 4 control cases (2 confirm + 2 extend)
- **~75% contradiction / ~25% control** — controls prevent the set from being gameable by always answering "contradicted"
- **Magnitude spread** — mild numeric drift (~0.3), moderate parameter/region change (~0.45–0.55), significant role/direction reversal (~0.6–0.7), categorical/definitional reversal (~0.85–0.9)
- **Failure-mode coverage** — numeric facts, categorical preferences, temporal facts, directional opposites

Cases are public and can be inspected directly. They were authored fresh for this evaluation; they do not derive from the founder's private `brain.db`.

### Methodology

Each case runs the full engine cycle:

1. Ingest the initial fact (episodic write to scratch DB, origin `asserted_by_user`)
2. Run consolidation (`runConsolidation` programmatically) — initial fact becomes a graph node
3. Ingest the contradicting fact (episodic write, origin `asserted_by_user`)
4. Run consolidation again — PE-gated update logic fires; belief should be corrected
5. Query with `query_probe` — does the system return the new value?

**ADD-only baseline:** the same cases run without any consolidation. Both facts are appended as episodes; no sleep pass runs. This is the simplest possible memory architecture — add everything, never update. The contrast makes the belief-correction mechanism visible.

### Scorecard metrics

| Metric | Definition |
|--------|-----------|
| Belief-correction rate | Fraction of contradiction cases where the query returns the new value (not the stale one) |
| Stale-recall rate | Fraction of contradiction cases where the query returns the old (stale) value |
| Duplicate count | Number of nodes in the graph for the same subject after both ingestion passes |
| Tombstone presence | Whether the old belief has a tombstone record — evidence the update happened by the engine's write path, not by chance |

The ADD-only baseline expected scores: correction rate = 0%, stale rate = 100%, duplicates = 2 per case (one for each episode row), tombstone = absent.

### Run

```sh
npm run eval:correctness
# Expected: ~$TBD, ~TBD min (filled in after first recorded run)
```

Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment.

A `--dry-run` mode runs the harness with `MockModelProvider` (zero API calls) for CI smoke testing:

```sh
npm run eval:correctness:dry
```

### Recorded results

| System | Belief-correction rate | Stale-recall rate | Avg duplicates | Tombstone present | Run date | Commit |
|--------|----------------------|------------------|---------------|-------------------|----------|--------|
| brain-memory | TBD — recorded in 14-05 | TBD | TBD | TBD | TBD | TBD |
| ADD-only baseline | 0% | 100% | 2.0 | No | same run | same |

---

## Supporting evidence: judge-model validation

The judge that scores EVAL-01 (GPT-4o-2024-08-06) and the internal brain-memory contradiction judge (used in the sleep pass) were separately validated against a hand-labeled gold set before being trusted.

The judge eval harness is documented in [scripts/eval/README.md](../scripts/eval/README.md). Key findings relevant to the evals above:

**Contradiction detection (17-case set, `judge-eval-contradiction-set.json`):**

| Provider | Relation accuracy | Contradiction detection | Dangerous errors |
|----------|------------------|------------------------|-----------------|
| claude-haiku-4-5 | 100% | 13/13 | 0 |
| qwen3.6:27b (local) | 100% | 13/13 | 0 |
| qwen3.6:35b-a3b (local) | 100% | 13/13 | 0 |

All three models caught 13/13 contradictions as `contradict` and all 4 controls correctly. This closes the gap that previously blocked trusting a local judge on contradiction detection: the load-bearing direction (never reinforcing a stale fact by calling a conflict `extend`/`confirm`) is handled identically by the local Qwen model and Haiku.

**Caveat:** magnitude prediction is poorly calibrated by every model. None differentiate mild from severe: all models saturate predictions toward high values even on true-0.3 mild-drift cases. The PE-gated update design treats `magnitude` as a coarse "conflict present" signal, not a precise 0–1 severity dial. This is a documented limitation, not a local-vs-API discriminator — all tested models share it.

The broader judge eval (48-case mined set) and extraction model bake-off are documented in `scripts/eval/README.md`.

---

## Caveats

1. **Constructed cases are cleaner than real-world ambiguous conflicts.** The EVAL-02 cases state directly opposing values on the same subject — that is the common, unambiguous belief-update scenario. Subtle near-paraphrase conflicts, ironic or hypothetical statements, and multi-hop contradictions are harder. The correctness suite proves parity on clear value-conflicts; it does not characterize performance on ambiguous input.

2. **Single-tenant; one brain.db per user.** Every eval runs on a scratch DB in isolation. Production behavior depends on graph size, history density, and the specific extraction model in use. Scale effects are not measured here.

3. **Extraction quality is not proven.** Claim extraction in the sleep pass uses the same class of LLM prompt that [mem0 #3009](https://github.com/mem0ai/mem0/issues/3009) reported with ~80% silent failure on some inputs. The allocation gate and provenance guards bound the damage — bad extraction produces noisy nodes, not feedback loops — but extraction quality on real-world ambiguous input is not a published number.

4. **Judge magnitude is uncalibrated.** As noted in the judge validation section, magnitude is a coarse conflict-detection signal, not a precise severity dial. Evals that treat it as quantitative would be misleading. brain-memory uses it only as a gate: "is the PE signal high enough to trigger a destabilizing update?"

5. **Competitor numbers are self-reported with differing methodologies.** The comparison rows in EVAL-01's results table are taken from vendor documentation and academic papers, not from running those systems through the same harness. Methodology differs: agentmemory's 95.2% is retrieval-only R@5, which is not the same measurement as end-to-end question answering. We flag each comparison row's methodology explicitly; no head-to-head rerun is claimed or implied.

6. **Published numbers are pinned to a commit.** The recorded scores in this document and the README are dated and tied to the engine version and commit hash that produced them. Brain-memory's architecture may improve or regress between releases; numbers are re-recorded at significant releases, not guaranteed fresh at any given HEAD.

---

See the [README benchmark table](../README.md#benchmark-results) for the summary view with repro commands. Raise questions or methodology concerns via GitHub issues.
