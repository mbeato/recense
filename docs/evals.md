# Recense evals

This document covers the two published evaluations — EVAL-01 (LongMemEval-S) and EVAL-02 (EVAL-02: Correctness suite) — along with the methodology behind each, the judge-model validation evidence, and the honest caveats that context any published numbers.

The goal is reproducibility and honesty, not benchmark warfare. recense numbers are published at face value with repro commands, cost estimates, and methodology disclosure. Competitor figures are self-reported with differing methodologies; we note the differences explicitly. If a number looks bad, that is intentional — we publish whatever the harness produces.

---

## EVAL-01: LongMemEval-S benchmark

### What it measures

[LongMemEval](https://arxiv.org/abs/2410.10813) is an academic benchmark for long-term memory in LLM assistants. It presents a multi-session conversation history to a memory system, then asks questions that require remembering facts across sessions. The benchmark includes five question categories: single-hop, multi-hop, temporal reasoning, knowledge-update, and null/negative. The **knowledge-update category** is the most relevant for recense: it asks questions about facts that changed across sessions, directly exercising whether the system resolved the contradiction to the current value.

We run LongMemEval-S (the standard published split), not a custom subset, so the methodology is directly comparable to the benchmark paper and any vendor claiming a LongMemEval score.

### Methodology

1. **Ingest** — each test case's conversation sessions are fed into a fresh scratch database (isolated per-question, never touching the live `recense.db`) as episodic writes. Each session is prefixed with its date from `haystack_dates` (e.g. `[Session date: 2023/05/20 (Sat) 02:21]`) and the episode `ts` is set to the parsed session date, so the engine's temporal ordering reflects the historical conversation timeline. This is critical for temporal-reasoning and knowledge-update question types. Episodes are ingested with `source: 'conversation'`, which routes extraction through the `CONVERSATION_EXTRACTION_PROMPT` (defined in `src/source/extraction-prompts.ts`). This prompt explicitly targets personal episodic details — durations, quantities, events, preferences — that the default extraction prompt omits. This is the same per-source extraction seam (`promptForSource`, D-62) used by production adapters (gmail, transcripts); the harness uses it to ensure benchmark ingestion is representative of real conversation ingestion.
2. **Sleep pass** — `runConsolidation` is called programmatically after ingestion. This triggers the same PE-gated belief-correction and schema-induction code the hourly launchd job runs.
3. **Retrieve** — after consolidation, the question is embedded with the same OpenAI embedder used in the sleep pass, then the top K (default 10, `--topk` flag) graph nodes are retrieved by brute-force cosine similarity over all embedded, non-tombstoned nodes (`CandidateRetriever.topk`). This is the engine's top-k candidate retrieval substrate — the same primitive the production spreading-activation path uses internally. **The production hook-injection wrapper (`RetrievalEngine.retrieve`) is NOT used.** That wrapper returns at most one result and gates on a deleted-similarity cosine threshold (0.7) calibrated for production session-start injection, not benchmark QA — it would cause nearly every question to abstain because the gold node typically sits at cosine ~0.48 (under the threshold). For the benchmark we want all K best candidates regardless of absolute cosine score.
4. **Answer generation** — the answer prompt is structurally equivalent to the official LongMemEval QA template (`src/generation/run_generation.py`, non-CoT form), adapted for recense's memory-node retrieval format (retrieved graph nodes rather than raw session history). The `Current Date` field is populated from `question_date`. The prompt ends with an open-ended `Answer:` (no "just the factual answer" constraint) so the model can respond "I don't have information about that" for abstention questions. **This is an equivalent, not a verbatim port** — the official template receives raw session text; ours receives retrieved memory nodes.
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
RECENSE_SDK_MAX_RETRIES=15 npm run eval:longmemeval:probe
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
# Recorded 2026-06-12 (knowledge-update subset, n=78): ~$14, ~15 min at --concurrency 8
```

Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment. Keys are read from the environment or `~/.config/recense/sleep.env`.

### Recorded results

| System | Headline score | Knowledge-update sub-score | Run date | Commit | Methodology |
|--------|---------------|---------------------------|----------|--------|-------------|
| recense (KU subset, n=78) | — (subset run; full-set headline not recorded) | **69.2%** (54/78) | 2026-06-12 | 30b950a | end-to-end QA, Haiku 4.5 answerer, GPT-4o-2024-08-06 binary judge |
| Full-context Haiku 4.5 (our measured baseline, same questions/scorer) | — | **79.5%** (62/78) | 2026-06-12 | 30b950a | entire haystack in-context, no memory system — `scripts/eval/longmemeval-fullcontext-baseline.cjs` |
| mem0 (self-reported) | 94.4% | — | — | — | end-to-end QA |
| Mastra Observational Memory (self-reported) | 95% | — | — | — | end-to-end QA, Gemini 2.5 Flash |
| agentmemory (self-reported) | 95.2% | — | — | — | **retrieval-only R@5, not end-to-end QA** |
| GPT-4o (paper baseline) | 60.6% | — | — | — | LongMemEval paper |
| ChatGPT (paper baseline) | 57.73% | — | — | — | LongMemEval paper |

The knowledge-update sub-score is reported separately because it is the most architecturally relevant number for recense's core claim: if a stored belief is contradicted by new information, does the system return the current value or a stale one? The headline score aggregates across all categories, which may obscure this signal.

### Phase 17: lever adoption — regression-set verification (2026-06-13)

**Goal:** Attribute the 18 knowledge-update failures from the 69.2% run to pipeline stage, implement LLM-free-first levers, and confirm ≥5/18 recovered with zero regressions on the 10 stable-correct members.

**Levers adopted (all implemented in Phase 17, $0 LLM-cost in engine):**

| Lever | Flag | Mechanism |
|-------|------|-----------|
| LEVER 1 | `--hybrid` | FTS5 BM25 + cosine RRF hybrid retrieval (hybridTopk) in retrieveRanked; replaces pure cosine |
| LEVER 2 | `--temporal` | Temporal newest-first tie-breaking: conflicting nodes with equal retrieval score sorted by MAX(episode.ts) descending |
| LEVER 3 | `--rewrite` | Ask-time Q→declarative rewrite: question embedded for retrieval as a declarative statement (queryForEmbed), not the raw question |
| LEVER 4 | *(default)* | rankedRetrievalK=10; no gold nodes ranked 11–30 in attribution analysis, so no change |
| LEVER 5 | *(D-62 seam)* | CONVERSATION_EXTRACTION_PROMPT extended at per-source seam for aside facts, personal records, durations, numeric corrections |

**Verification run (API stack, n=28):**

28-question regression set: 18 attribution-run failures + 10 stable-correct members (selected from the 78-subset run). Run with `--hybrid --temporal --rewrite` on the API stack (Haiku 4.5 extraction/judging/answering, GPT-4o-2024-08-06 scorer). No local model providers — API stack only for comparability.

**Comparison baseline disclosure:** The per-question labels come from the attribution re-run (`attribution-18.json`), NOT from the original 69.2% recorded run. The attribution run was an independent API run at default settings (no levers) to identify which 18 questions failed and why. These two baselines are close but not identical due to stochasticity; 2/18 were flagged `recovered_on_rerun=True` (stochastic recoveries present regardless of levers). Recovery counts include both true failures (16) and stochastic recoveries (2) for completeness.

**Results:**

```
Overall: 75.0% (21/28) on the regression set (knowledge-update questions only)
```

| Criterion | Threshold | Actual | Result |
|-----------|-----------|--------|--------|
| A: failures recovered (0→1 vs attribution baseline) | ≥5/18 | **12/18** (10/16 true + 2/2 stochastic) | PASS |
| B: regressions on stable-correct (1→0) | 0 | **1** (9ea5eabc: "most recent family trip") | FAIL |
| C: local EVAL-02 correctness (V8 floor) | ≥84.6% | **69.2%** (9/13; commit 97ec947) | FAIL |
| D: full test suite | green | 912/914 green, 2 skipped | PASS |

**Regression detail (9ea5eabc):** The question asks for the user's most recent family trip destination. This question was stable-correct in both the original 69.2% run and the attribution re-run but regressed with LEVER 1+2+3 active. Probable cause: FTS5 BM25 over-weights the keyword "Hawaii" (which appears in multiple sessions) relative to the newer "Paris" trip, so hybrid retrieval ranks the stale fact above the current value. The LEVER 2 temporal sort does not rescue it because both episode timestamps are close enough that BM25 score dominates RRF. This is a retrieval-layer issue, not an extraction or consolidation issue.

**Abstention member (6aeb4375_abs):** Correctly recovered (label 1). No abstention regression.

**Reproduction command:**

```sh
# API-stack run (Haiku extract/judge/answer; GPT-4o scorer)
node scripts/eval/longmemeval-harness.cjs \
  --hybrid --temporal --rewrite \
  --eval scripts/eval/results/longmemeval-28-regression.jsonl

node scripts/eval/longmemeval-scorer.cjs \
  --hypotheses scripts/eval/results/longmemeval-17-verify-hypotheses.jsonl \
  --eval scripts/eval/results/longmemeval-28-regression.jsonl \
  --out scripts/eval/results/longmemeval-17-verify-SCORED.json
```

Estimated cost: ~$4.13 (28 questions). Do NOT source `sleep.env` before running — it sets `RECENSE_*_PROVIDER=local` which switches to Ollama and produces incomparable results.

**API spend (Phase 17):**

| Run | Cost | Purpose |
|-----|------|---------|
| 17-01 attribution run | ~$2.70 | Instrument harness, attribute 18 failures |
| 17-05 verification run | ~$4.13 | 28-question regression verification with LEVER 1+2+3 |
| **Cumulative** | **~$6.83** | Phase 17 total (≤$12 cap) |

**Phase outcome:** Criterion A passed (12/18 recovered, well above the ≥5 threshold). Criterion B and C both failed: 1 stable-correct regression on 9ea5eabc (BM25 over-indexing) and EVAL-02 local dropped from 84.6% to 69.2%. The EVAL-02 drop is 2 additional contradiction cases failing, all without tombstones — contradiction not detected. Likely cause: LEVER 5 CONVERSATION_EXTRACTION_PROMPT extension at D-62 changed how the extractor formulates simple facts, making some contradiction pairs fail the PE-gated update. This is a $0-cost diagnostic (revert LEVER 5 and re-run EVAL-02). Operator decision required before phase close. **→ Diagnosed and resolved 2026-06-13; the LEVER 5 hypothesis was WRONG — see below.**

---

### Phase 17 gap-closure resolution (2026-06-13)

A single budgeted re-verification confirmed **all five criteria pass**. The 17-05 B/C failures were diagnosed and fixed.

**Real root cause of the EVAL-02 regression — judge batching, not LEVER 5.** Reverting LEVER 5 alone *worsened* EVAL-02 to 53.8% (7/13). Bisection of every commit between the 84.6% V8 baseline (`7d76166`) and HEAD found the cause: the `cea0125` judge-batching refactor ("one think block per episode", quick task 260612-lc0), which landed *after* the baseline and was never correctness-validated. Disabling batching (per-claim judging) restored the exact 84.6% baseline (11/13). The 35b judge loses per-pair accuracy when multiple contradiction pairs share one think block.

**Fix (commit `bedd132`):** Per-claim judging is now the engine default; batching is opt-in via `RECENSE_ENABLE_JUDGE_BATCH=1`. A $0/local correctness restoration.

**Settled lever set:**

| Lever | Disposition |
|-------|-------------|
| LEVER 1 (`--hybrid`) | **Removed from the answer path** (17-08): caused the lone B regression (BM25 over-indexed "Hawaii" over the current "Paris"); zero attribution upside (retrieve_miss=0). `node_fts` infra retained. |
| LEVER 2 (`--temporal`) | Adopted. Comparator made deterministic (17-06, CR-01) + UTC date fix (WR-02). |
| LEVER 3 (`--rewrite`) | Adopted; gated behind an interrogative heuristic (17-08, WR-03). |
| LEVER 4 | Default (rankedRetrievalK=10). |
| LEVER 5 (extraction) | **Dropped** (17-07), exonerated as the EVAL-02 cause. The 5 extract-loss failures it targeted (f9e8c073, 72e3ee87, 01493427, e61a7584, 0e4e4c46) were never recovered by it — a documented extract-loss limitation. |

**Re-verification (API stack, n=28, `--temporal --rewrite`, NO `--hybrid`, per-claim, deterministic comparator):**

```
Overall: 78.6% (22/28) on the regression set (knowledge-update only)
```

| Criterion | Threshold | Actual | Result |
|-----------|-----------|--------|--------|
| A: failures recovered | ≥5/18 | **12/18** (10 true + 2 stochastic) | PASS |
| B: regressions on stable-correct | 0 | **0/10** (9ea5eabc now answers "Paris") | PASS |
| C: local EVAL-02 (V8 floor) | ≥84.6% | **84.6%** (11/13, commit bedd132, free local) | PASS |
| D: full test suite | green | 917 passed / 2 skipped | PASS |
| E: invariants (D-29, D-99 LLM-free SessionStart, single-writer, no self-confirmation) | intact | via suite | PASS |

Still failing (6/18): the 5 extract-loss IDs above + 9bbe84a2 (consolidate-loss) — well clear of the ≥5 threshold.

**Reproduction:**

```sh
node scripts/eval/longmemeval-harness.cjs --temporal --rewrite \
  --eval scripts/eval/results/longmemeval-28-regression.jsonl \
  --out scripts/eval/results/longmemeval-17-reverify-hypotheses.jsonl
node scripts/eval/longmemeval-scorer.cjs \
  --hypotheses scripts/eval/results/longmemeval-17-reverify-hypotheses.jsonl \
  --eval scripts/eval/results/longmemeval-28-regression.jsonl \
  --out scripts/eval/results/longmemeval-17-reverify-SCORED.json
```
(API stack = engine default Haiku 4.5; do NOT source `sleep.env`. Per-claim judging is the default — no flag needed.)

**API spend (updated):**

| Run | Cost | Purpose |
|-----|------|---------|
| 17-01 attribution | ~$2.70 | attribute 18 failures |
| 17-05 verification | ~$4.13 | first 28-q (LEVER 1+2+3) |
| 17-09 re-verification | ~$5–6 (est.) | 28-q, settled levers, per-claim (judge round-trips not separately metered; exact billing not pulled) |
| **Cumulative** | **~$12–12.8** | at/slightly over the $12 soft cap — disclosed |

---

## EVAL-02: Correctness suite (belief-correction)

### What it measures

EVAL-02 measures whether recense actually corrects stored beliefs when contradicting information arrives. It does not rely on the LongMemEval question set or the GPT-4o judge. Instead, it runs end-to-end through the real engine on a scratch database with hand-authored fictional-persona cases, then queries whether the system now returns the new value or the old one.

This is the "anyone can observe it correct a belief" evaluation: run one command, watch a stored fact get updated in place with a tombstone, compare against the ADD-only baseline that accumulates duplicates instead.

### Case-set composition

The case set is a **hand-authored fictional-persona set committed to the repo** (`scripts/eval/cases/correctness-cases.json`). All personas are fictional (no real-world data).

- **17 total cases** — 13 contradiction cases + 4 control cases (2 confirm + 2 extend)
- **~75% contradiction / ~25% control** — controls prevent the set from being gameable by always answering "contradicted"
- **Magnitude spread** — mild numeric drift (~0.3), moderate parameter/region change (~0.45–0.55), significant role/direction reversal (~0.6–0.7), categorical/definitional reversal (~0.85–0.9)
- **Failure-mode coverage** — numeric facts, categorical preferences, temporal facts, directional opposites

Cases are public and can be inspected directly. They were authored fresh for this evaluation; they do not derive from the founder's private `recense.db`.

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
# Recorded 2026-06-12: ~$2, ~10 min (API config); local stack ~25 min, $0 LLM cost
```

Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment.

A `--dry-run` mode runs the harness with `MockModelProvider` (zero API calls) for CI smoke testing:

```sh
npm run eval:correctness:dry
```

### Recorded results

| System | Belief-correction rate | Stale-recall rate | Avg duplicates | Tombstone present | Run date | Commit |
|--------|----------------------|------------------|---------------|-------------------|----------|--------|
| recense (API config) | **92.3%** content-correct (12/13; 84.6–92.3% scorer-credited across runs — substring scorer under-credits correct paraphrases) | 7.7% | 1.76 | Yes (70.6%) | 2026-06-12 | 9293be7 |
| recense (local: granite4.1:8b + qwen3.6:35b-a3b) V8 | **84.6%** scorer-credited, content matches API | 15.4% | 1.41 | Yes (76.5%) | 2026-06-12 | 7d76166 |
| recense (local: granite4.1:8b + qwen3.6:35b-a3b) post-Phase-17 | **69.2%** (9/13) — REGRESSION vs V8; 4 failures, 3 without tombstone | 30.8% | 1.65 | Yes (58.8%) | 2026-06-13 | 97ec947 |
| ADD-only baseline | 0% | 100% | 2.0 | No | same run | same |

---

## EVAL-03: Injection efficiency

### What it measures

EVAL-03 measures recense's bounded per-session SessionStart injection cost versus the flat `MEMORY.md` index it replaced (D-33). It answers the question: how many tokens does recense inject into a Claude Code session, and how does that compare to reading the equivalent flat-file index?

The eval is **$0 and LLM-free** — it uses pure SQLite reads against the live `recense.db`, spawns the production `session-start-cli` (which is itself LLM-free and embedding-free by design), and counts characters via the `chars/4` proxy the CLI already uses for its own char cap. It measures **injection cost, not retrieval quality** (see EVAL-01 for QA accuracy).

### Methodology

Three measurements, all computed live from the real db and the real injection path:

**(a) Point estimate** — spawn `dist/src/adapter/session-start-cli.js --db <db>` with a synthetic `SessionStart` stdin payload, parse the `hookSpecificOutput.additionalContext` field, and measure the injected payload's character/token count and line count. Read the flat `MEMORY.md` baseline file and count its characters, tokens, and top-level list entries (`^- ` lines). Report the delta as token-reduction percentage.

**(b) O(1)-bounded vs O(n) scaling projection** — from the db, compute `n_live_nodes = COUNT(*) WHERE tombstoned=0` and `avg_chars = AVG(LENGTH(value)) WHERE tombstoned=0`. Project a hypothetical "flat-file-of-everything" (one line per fact, no dedup) token cost at current n and 2x/5x/10x multiples. recense's injection is bounded at `DEFAULT_CONFIG.injectionTokenBudget` tokens (read from config, never hardcoded), so the budget line is constant. All projected numbers are labeled as upper bounds. The crossover point (where the flat projection first exceeds the recense budget) is computed and reported.

**(c) Live belief-correction count** — `tombstoned = COUNT(*) WHERE tombstoned=1`; `prev_value_corrections = COUNT(*) WHERE prev_value IS NOT NULL`; `episodes = COUNT(*) FROM episode`. These are in-place auto-corrections the engine made that a flat file would require manual edits for.

Token counting uses `Math.round(chars/4)` — the same proxy the session-start-cli uses for its char cap (`injectionTokenBudget × 4`). This is not a real tokenizer.

### Run

```sh
npm run eval:injection
```

Requires no API keys ($0, LLM-free). Degrades gracefully (`exit 0`, prints "no data") when the db is missing or empty — safe to run in CI without a live db.

### Recorded results

Run date: 2026-06-14. Commit: d4b1b46 (engine v0.1.0, db snapshot at 3,591 live nodes).

**Point estimate:**

| Metric | recense | Flat MEMORY.md baseline |
|--------|---------|------------------------|
| Chars injected | 1,707 | 6,328 |
| Tokens injected (~) | 427 | 1,582 |
| Nodes / entries | 6 nodes | 20 entries |
| Token reduction | **73%** fewer tokens than the flat baseline | — |

**Scaling projection (O(1) vs O(n), upper bound):**

| Node count | Flat-of-everything tokens (projected) | recense budget |
|------------|---------------------------------------|---------------|
| 3,591 (current) | 56,558 (projected upper bound) | 500 tokens |
| 7,182 (2x) | 113,117 (projected upper bound) | 500 tokens |
| 17,955 (5x) | 282,791 (projected upper bound) | 500 tokens |
| 35,910 (10x) | 565,583 (projected upper bound) | 500 tokens |

At 63 chars/node average, a flat-file-of-everything exceeds the 500-token recense budget at approximately 32 nodes. recense's current db has 3,591 live nodes — roughly 113× past the crossover.

**Belief-correction count:**

| Metric | Count |
|--------|-------|
| Tombstoned nodes | 30 |
| Prev-value corrections | 26 |
| Episode rows total | 1,072 |

### Competitor comparison

<!-- COMPETITOR FIGURES PENDING: research agent in flight; orchestrator fills sourced figures -->

"Tokens injected per session" is a recense-specific metric. Most memory systems do not publish per-session injection token counts as a headline number — they report retrieval accuracy or storage efficiency on standardized benchmarks. The closest published axis is mem0's token-savings claim, but the methodology (what constitutes the baseline, what portion of memory is injected per session) is not directly comparable without running both systems against the same session corpus. Any head-to-head comparison in this section will include the source, the methodology, and the measurement date.

### Honesty disclosures

recense does NOT win on every dimension:

1. **Hot-path latency: ~100-150ms vs instant flat-file read.** SessionStart injection is pure synchronous SQLite reads, but it still takes ~100-150ms on the hook path. A flat `MEMORY.md` read via the existing hook is essentially instant (single file read, no SQLite). recense trades some hook latency for bounded, prioritized injection. The latency is documented in the session-start-cli source and is a known trade-off (T-03-3-D).

2. **Raw QA accuracy: 69.2% vs 79.5% full-context.** On the LongMemEval-S knowledge-update subset (n=78), recense scores 69.2% versus 79.5% for full-context Haiku 4.5 (all sessions in-context, no memory system). recense injects fewer tokens than full context and still lags the full-context ceiling by ~10 percentage points. See EVAL-01 for full methodology and breakdown.

### EVAL-03 Caveats

- `chars/4` is an approximation, not a real tokenizer. Actual token counts depend on the tokenizer, model, and content composition (code vs. prose). The char proxy is consistent with the session-start-cli's own cap and provides a reproducible relative comparison, not an absolute token guarantee.
- The flat-file-of-everything projection assumes one line per live node with no deduplication and is a deliberate upper bound. A real flat index (like the `MEMORY.md` this replaced) dedups manually and stays much smaller in practice — see the actual 20-entry / 1,582-token flat baseline in the point-estimate table for a realistic comparison.
- All numbers are pinned to a db snapshot (d4b1b46) and the flat file at that date. Both will drift as the db grows and the flat index is updated. Re-run `npm run eval:injection` to get current figures.
- This eval measures injection cost, not retrieval quality. It does not measure whether the 6 injected nodes are the *right* ones, or what the marginal information value of injecting them is. That is a separate measurement.

---

## Supporting evidence: judge-model validation

The judge that scores EVAL-01 (GPT-4o-2024-08-06) and the internal recense contradiction judge (used in the sleep pass) were separately validated against a hand-labeled gold set before being trusted.

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

2. **Single-tenant; one recense.db per user.** Every eval runs on a scratch DB in isolation. Production behavior depends on graph size, history density, and the specific extraction model in use. Scale effects are not measured here.

3. **Extraction quality is not proven.** Claim extraction in the sleep pass uses the same class of LLM prompt that [mem0 #3009](https://github.com/mem0ai/mem0/issues/3009) reported with ~80% silent failure on some inputs. The allocation gate and provenance guards bound the damage — bad extraction produces noisy nodes, not feedback loops — but extraction quality on real-world ambiguous input is not a published number.

4. **Judge magnitude is uncalibrated.** As noted in the judge validation section, magnitude is a coarse conflict-detection signal, not a precise severity dial. Evals that treat it as quantitative would be misleading. recense uses it only as a gate: "is the PE signal high enough to trigger a destabilizing update?"

5. **Competitor numbers are self-reported with differing methodologies.** The comparison rows in EVAL-01's results table are taken from vendor documentation and academic papers, not from running those systems through the same harness. Methodology differs: agentmemory's 95.2% is retrieval-only R@5, which is not the same measurement as end-to-end question answering. We flag each comparison row's methodology explicitly; no head-to-head rerun is claimed or implied.

6. **Published numbers are pinned to a commit.** The recorded scores in this document and the README are dated and tied to the engine version and commit hash that produced them. Brain-memory's architecture may improve or regress between releases; numbers are re-recorded at significant releases, not guaranteed fresh at any given HEAD.

7. **EVAL-03 injection numbers are a snapshot, not a production SLA.** The injection token count and reduction percentage from EVAL-03 reflect a specific db snapshot and flat-file state. Token reduction will vary based on how many relevant nodes exist, what the current db contains, and how the flat-file baseline evolves. The O(1) budget ceiling (500 tokens) is a config constant; the baseline and db content are user-dependent.

---

See the [README benchmark table](../README.md#benchmark-results) for the summary view with repro commands. Raise questions or methodology concerns via GitHub issues.
