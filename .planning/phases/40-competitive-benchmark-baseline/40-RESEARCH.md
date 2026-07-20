# Phase 40: Competitive Benchmark Baseline - Research

**Researched:** 2026-06-22
**Domain:** Conversational memory evaluation — LoCoMo benchmark, LLM-judge protocols, competitor methodology verification
**Confidence:** MEDIUM-HIGH (core judge protocol and dataset schema verified; some competitor numbers partially inferred from secondary sources; slopcheck unavailable — no new packages proposed)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** 1-conversation LoCoMo cost probe is a HARD GATE before any full benchmark run. Extrapolate ×10 to the full LoCoMo-10 and confirm against Claude Code `/usage` weekly meter.
- **D-02:** Heavy benchmark run is Haiku (extract/answer) + Sonnet (judge) via headless `claude -p` — hits the subscription general bucket. GPT-4o scorer + OpenAI embeddings are direct API $.
- **D-03:** Build + validate the harness anytime (cheap); schedule the heavy official run for right before a weekly reset if probe shows meaningful budget use.
- **D-04:** Report both metrics on LoCoMo — end-to-end QA accuracy (LLM-judge) as headline, plus retrieval R@K (R@5/R@10) as a secondary diagnostic.
- **D-05:** Score the headline QA accuracy with the replicated mem0/Zep LoCoMo LLM-judge protocol. → RESOLVED by this research document.
- **D-06:** Measure both: (a) real-world retrieval p50/p95 on the live ~7000-node brain as headline latency, AND (b) a committed script reproducing the latency-vs-N curve on a synthetic/public corpus.
- **D-07:** Token cost measured on the reproducible LoCoMo corpus, not the private brain.
- **D-08:** Cite + methodology-note competitor numbers now; do NOT reproduce rival pipelines in this phase.
- **D-09:** Run the full standard LoCoMo-10 (all 10 conversations, all categories except adversarial per the standard exclusion).
- **D-10:** Freeze SUT at the v7.0 tag. Capture exact commit hash + serialized config dump in results JSON.

### Claude's Discretion

- R@K ground-truth definition (what counts as a "hit" when recense retrieves facts/nodes, not original LoCoMo sessions).
- Synthetic-corpus construction for the reproducible latency curve (D-06b).
- Token-cost-per-write/per-recall exact accounting boundaries — reuse existing write-ledger / probe instrumentation.
- Abstention handling on adversarial/unanswerable LoCoMo questions — follow the LoCoMo official protocol (adversarial category excluded from denominator).

### Deferred Ideas (OUT OF SCOPE)

- Reproducing rival pipelines head-to-head.
- Per-category LoCoMo breakdown as a first-class reported table.
- Bi-temporal validity.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BENCH-01 | LoCoMo harness runs reproducibly on recense | Dataset schema, category codes, and ingest unit documented below; harness structure cloned from existing `longmemeval-harness.cjs` |
| BENCH-02 | Baseline accuracy/latency/token recorded | Judge protocol pinned; live brain has 9,062 embedded nodes (measured); cost-benefit-probe.json write-ledger format reusable for D-07 |
| BENCH-03 | Competitor targets cited AND methodology-understood | All four competitor claims verified against primary sources; two carry significant caveats (Zep inflated by 25 pts, MemPalace 96.6% is embedder-not-architecture) |
</phase_requirements>

---

## Summary

Phase 40 adds a LoCoMo harness alongside the existing LongMemEval + KU replay harnesses, records honest baselines on all three axes, and pins competitor numbers with sourced methodology notes.

The single most important research finding is the **exact mem0/Zep LoCoMo LLM-judge protocol** (D-05), which is now pinned: **GPT-4o-mini** as judge, a specific prompt from the mem0 paper Appendix A, adversarial category excluded from denominator, 4 evaluated categories (single-hop, multi-hop, open-domain, temporal). This is what makes recense's headline QA number directly comparable.

The second finding is the **LoCoMo-10 dataset characterization**: 10 conversations, 1,986 total QA pairs across 5 category codes (1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial), stored in a single `locomo10.json` at the canonical `snap-research/locomo` repo (CC BY-NC 4.0). The QA struct carries `question`, `answer`, `evidence` (list of dialog IDs), and `category` (int). Category 5 (adversarial) is excluded from all published evaluations — no ground truth available.

The third critical finding: **every competitor number has a significant methodology caveat** (see §Competitor Target Verification). The Zep 84% number is almost certainly inflated by ~26 points due to a denominator bug. MemPalace's 96.6% R@5 measures the embedder alone (ChromaDB baseline), not the palace architecture. The mem0 "26% more accurate" claim is real but means 66.88% vs 52.90% overall J score — not accuracy in the everyday sense (absolute values are modest). The LoCoMo benchmark itself has a 6.4% corrupted answer key and a judge that accepts ~63% of intentionally wrong topically-related answers — differences below ~5-7 points are not interpretable.

**Primary recommendation:** Build the LoCoMo harness as a clone of `longmemeval-harness.cjs`, use GPT-4o-mini as the QA scorer with the verbatim mem0 Appendix A prompt, exclude category 5 from denominator, and supplement with R@10 via the existing `instrumentTopkResults` tap. Treat all competitor J scores as noisy signals and report recense's number with a methodology note stating exactly what it measures.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| LoCoMo ingest (session→episode→sleep) | Eval harness (offline) | recense engine | Harness drives the engine's existing EpisodicStore + runConsolidation pipeline; engine unchanged |
| Retrieval / R@K measurement | recense engine (LLM-free) | Eval harness tap | `CandidateRetriever.topk` is already the retrieval primitive; `instrumentTopkResults` already exposed |
| QA answer generation | Eval harness (Haiku headless) | — | Online path stays LLM-free; answer gen is eval-only cost |
| LLM judge scoring | Eval harness (GPT-4o-mini direct API) | Optional headless scorer path | Must match mem0/Zep protocol; direct OpenAI API maintains cost separation |
| Latency measurement | Eval harness + live brain | Synthetic corpus script | p50/p95 timed around `CandidateRetriever.topk` call only (not answer gen) |
| Token cost measurement | Eval harness write-ledger | `cost-benefit-probe.json` format | Per D-07: measured on LoCoMo corpus, not private brain |
| Config snapshot (D-10) | Eval harness meta | `src/lib/config.ts` DEFAULT_CONFIG | Extend existing `meta.commit` + `meta.engine_version` to include all frozen knobs |

---

## Research Item Resolutions

### Item 1 [HIGH]: The mem0/Zep LoCoMo LLM-Judge Protocol (D-05)

**Status: RESOLVED — plan-ready.**

**Judge model:** `gpt-4o-mini` — confirmed via the mem0 paper (arXiv 2504.19413, Section 2.1: "All language model operations utilized GPT-4o-mini") and corroborated by the mem0/memory-benchmarks repo default (`--judge-model gpt-4o` in the CLI but implementation uses gpt-4o-mini for the actual judging step). [CITED: arxiv.org/html/2504.19413v1]

Note: the mem0/memory-benchmarks CLI flags show `--judge-model gpt-4o` as default, while the paper body states gpt-4o-mini. The paper is the primary source; the open-source benchmarks repo may use gpt-4o as a later default. **For comparability, implement with `gpt-4o-mini` (paper version) and record the exact model string in meta.judge_model.** [ASSUMED: the paper's gpt-4o-mini is the version used to produce the published 66.88 / 52.90 J scores; the benchmarks-repo default of "gpt-4o" may differ]

**Exact judge prompt (Appendix A, verbatim from paper):**
```
Your task is to label an answer to a question as "CORRECT" or "WRONG".
You will be given the following data:
(1) a question (posed by one user to another user),
(2) a 'gold' (ground truth) answer,
(3) a generated answer which you will score as CORRECT/WRONG.
```
The full prompt continues with: be generous with grading — as long as the generated answer touches on the same topic as the gold answer it should be counted as CORRECT; return a JSON with a `"label"` key. [CITED: arxiv.org/html/2504.19413v1, Appendix A] The existing `longmemeval-scorer.cjs` already implements a nearly identical template (per the LongMemEval scorer port comment); the LoCoMo scorer adapter needs to replicate the mem0 Appendix A version specifically.

**Important caveat on the prompt:** The prompt instructs the judge to be "generous" and to count topically-related answers as CORRECT even if factually imprecise. An independent audit [CITED: dev.to/penfieldlabs LoCoMo audit] found this causes the judge to accept ~62.81% of intentionally wrong but topically-related answers. This means the absolute J score is a loose measure — the metric is comparability (everyone scores against the same lenient bar), not accuracy in a strict factual sense. Recense's BENCH-03 methodology note must state this.

**Evaluated categories:** 4 out of 5 — single-hop, multi-hop, open-domain, temporal. [CITED: arxiv.org/html/2504.19413v1, Section 3.1]

**Adversarial category handling:** Excluded from denominator and numerator. The paper states: "The adversarial question category was excluded from our evaluation because ground truth answers were unavailable, and the expected behavior is that the agent should recognize them as unanswerable." Category code 5 in locomo10.json = adversarial; skip these QA pairs entirely during scoring. [CITED: arxiv.org/html/2504.19413v1, Section 3.1]

**Scoring mechanics:** Binary 0/1 per question. Aggregate = count(CORRECT) / count(non-adversarial questions). Reported as a percentage (Overall J). The 26% relative improvement = (66.88 - 52.90) / 52.90. [CITED: arxiv.org/html/2504.19413v1, Table 2]

**Scorer adapter task handoff:** The planner should create a `scripts/eval/locomo-scorer.cjs` that implements:
1. `buildLoCoMoJudgePrompt(question, goldAnswer, hypothesis)` — verbatim from mem0 Appendix A, produces a user message (no system prompt), requests `{"label": "CORRECT"|"WRONG"}` JSON
2. Judge calls: `gpt-4o-mini`, `temperature: 0`, `max_tokens: 10` (matching the paper's stated settings; existing `longmemeval-scorer.cjs` uses `max_tokens: 10`)
3. Category filter: skip rows where `qa.category === 5`
4. Output: same envelope as `longmemeval-scorer.cjs` — `{ meta: { judge_model, questions_total }, scores: { headline, by_category }, per_question: [] }`

---

### Item 2 [HIGH]: LoCoMo-10 Dataset Location and Schema

**Status: RESOLVED — plan-ready.**

**Canonical source:** `https://github.com/snap-research/locomo` (Snap Research, ACL 2024 paper arXiv 2402.17753). [CITED: snap-research.github.io/locomo]

**License:** CC BY-NC 4.0 — non-commercial use permitted. Suitable for this internal benchmark. [CITED: snap-research.github.io/locomo]

**Direct acquisition command:**
```bash
git clone https://github.com/snap-research/locomo.git /tmp/locomo
cp /tmp/locomo/data/locomo10.json scripts/eval/locomo10.json
```
File size: 2.68 MB. Not committed to the repo (same pattern as `longmemeval-s.jsonl` which is ~3 GB). Add `scripts/eval/locomo10.json` to `.gitignore`. [CITED: github.com/snap-research/locomo/blob/main/data/locomo10.json]

**Scale:** 10 conversations, 1,986 total QA pairs. Each conversation has ~300 turns across 19–35 sessions, ~9K tokens per conversation. [CITED: arxiv.org/html/2402.17753v1] The mem0 paper (arXiv 2504.19413) describes the same dataset as "~600 dialogues and 26,000 tokens on average" — this is counting turns differently from the original paper; the standard ingest unit is the per-session block.

**JSON schema (top-level per-conversation object):**
```
{
  "sample_id": "...",                     // conversation identifier
  "speaker_a": "...", "speaker_b": "...", // the two participants
  "session_1": [...],                     // list of turns: {name, dia_id, text}
  "session_1_date_time": "...",           // session timestamp string
  "session_2": [...], ...                 // subsequent sessions (up to ~35)
  "observation": { "session_1": "...", ... }, // pre-generated session summaries (for RAG baselines)
  "qa": [
    {
      "question": "...",
      "answer":   "...",
      "evidence": ["D1:9", "D1:11", ...], // dialog-id refs to supporting turns
      "category": 1                        // int: see category codes below
    },
    ...
  ]
}
```
[CITED: github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py — QA dataclass fields]

**Category numeric codes:** [ASSUMED — multiple third-party harnesses consistent but no official mapping in the snap-research README; confirmed category 5 = adversarial from SimpleMem source and multiple evaluation harnesses]

| Code | Category | Count (approx) |
|------|----------|----------------|
| 1 | Multi-hop | ~290 |
| 2 | Temporal reasoning | ~410 |
| 3 | Open-domain / commonsense | ~77 |
| 4 | Single-hop | ~720 |
| 5 | Adversarial | ~495 (excluded from scoring) |

Note: the brainctl.org benchmarks site references 282 single-hop and 321 temporal; these are plausible given the 10-conversation scope but differ from the full 50-conversation set (7,512 QA pairs). The 1,986 QA pair total across 10 conversations is the standard LoCoMo-10 figure. [ASSUMED for per-category breakdown — verify by counting `category` values after acquiring `locomo10.json`]

**Standard ingest unit:** One episode per conversation session (i.e., `session_1`, `session_2`, etc., each as a single formatted text block). The existing `formatSession()` helper in `longmemeval-harness.cjs` covers the same pattern. Add the `session_N_date_time` string as the session date prefix (already supported by `formatSession(session, date)`). The number of episodes per conversation = number of sessions in that conversation (~19–35).

**Evidence field (for R@K):** `qa.evidence` is a list of dialog IDs like `["D1:9", "D1:11"]`. These reference specific `{session}:{turn_index}` pairs within the conversation. Relevant for the R@K hit definition — see Item 3.

**Evaluation code in the snap-research repo:** The repo has `task_eval/` scripts. These are the original F1-based eval (not LLM-judge). For recense's purposes, implement the mem0-style LLM-judge scorer (Item 1) rather than porting the original F1 code.

---

### Item 3 [MED]: R@K Ground-Truth Definition for recense

**Status: RESOLVED (recommended approach) — research confirms one clear choice is most defensible.**

**The problem:** LoCoMo's `qa.evidence` refers to specific dialog turns (e.g., `"D1:9"`). recense retrieves fact/entity graph nodes, not original sessions. There is no 1:1 mapping between a dialog turn and a graph node.

**Option A — Session-level hit (recommended):** A retrieved node counts as a hit for question Q if that node was extracted from (consolidated from) an episode whose source content came from any session in `qa.evidence`. Implementation: during ingest, record which session index each episode came from in the episode metadata (or derive it from the ingest order). After retrieval, the `instrumentTopkResults` tap exposes `[{id, score}]`. Query the scratch DB for `consolidation_event.episode_id` → `episode.id` → the episode's session index. If any of the top-K retrieved nodes has a contributing episode from one of the evidence sessions, count as a hit.

**Practical complication:** The scratch DB already has `consolidation_event` linking nodes to episodes. The missing piece is which session each episode came from. This requires tagging each episode at ingest time with the session index. **The harness should store `session_idx` in the episode's content prefix (e.g., `[Session 3: ...]`) or in the episode metadata.** Then R@K can be computed post-retrieval without additional schema changes.

**Option B — Semantic similarity proxy:** Embed the gold answer and compute cosine similarity to retrieved node values. If any top-K node has cosine ≥ threshold to the gold answer, count as a hit. This is simpler to implement (no session tracking needed) but is weaker: it measures whether the retrieved nodes say something semantically similar to the gold answer, not whether they come from the right evidence sessions.

**Recommendation: Option A (session-level hit).** Rationale: LoCoMo's `qa.evidence` explicitly identifies which sessions contain the supporting information. Option A measures whether recense retrieved from the right part of the conversation graph — the correct retrieval diagnostic. Option B measures answer similarity, which conflates retrieval quality with node-value quality. Option A is more honest and more directly comparable to MemPalace's R@K definition (which measures "whether the labelled session ranks in top-K"). [VERIFIED: MemPalace BENCHMARKS.md — their R@K definition is session-label-based]

**Implementation sketch for the harness:**
```javascript
// During ingest, tag each episode with session index
const sessionTag = `[Session ${sessionIdx}]`;
const content = formatSession(session, sessionTag + ' ' + sessionDate);
await episodes.append({ content, ... });

// After retrieval, in the --instrument tap:
const hitSessions = new Set(qa.evidence.map(e => parseInt(e.split(':')[0].replace('D','')) - 1));
const retrievedSessionIdxs = new Set(
  topkResults.flatMap(r => getContributingSessionIdxs(scratch.db, r.id))
);
const hit5  = [...hitSessions].some(s => retrievedSessionIdxs has s) // at K=5
const hit10 = /* same at K=10 */
```

**Fallback (Option B) if session-level tracking proves too complex during implementation:** Use cosine similarity ≥ 0.75 between the gold answer embedding and retrieved node embeddings. Acceptable as a secondary diagnostic; the planner should include Option A as the primary target and Option B as an explicit fallback with a methodology note.

---

### Item 4 [MED]: Competitor Target Verification (BENCH-03, D-08)

**Status: RESOLVED with significant caveats. Every number below includes a methodology note.**

#### mem0: "~26% more accurate / 91% lower latency / 90% fewer tokens vs OpenAI memory"

**Source:** mem0 paper, arXiv 2504.19413, Table 2 and abstract. [CITED: arxiv.org/html/2504.19413v1]

**What "26% more accurate" actually measures:**
- Metric: LLM-as-a-Judge (J), scored by GPT-4o-mini, mem0 Appendix A prompt
- Baseline: OpenAI's built-in memory system (not full-context retrieval)
- Scores: mem0 Overall J = **66.88 ± 0.15%**, OpenAI Overall J = **52.90 ± 0.14%**
- Relative improvement = (66.88 - 52.90) / 52.90 = **26.4%**
- Averaged over 10 independent runs; averaged across single-hop, multi-hop, open-domain, temporal (adversarial excluded)
- **Caveat:** "66.88% accuracy" is not everyday accuracy. The judge is lenient: accepts ~62.81% of intentionally wrong topically-related answers. The absolute numbers are loose; the relative improvement is the meaningful signal.

**What "91% lower latency" measures:**
- p95 response latency: mem0 1.44s vs full-context approach 17.117s (Table 2)
- Comparison baseline: the full-context approach (passing the entire 26K-token conversation), NOT OpenAI memory
- **Caveat:** This is latency for the entire answer-generation pipeline (search + LLM answer), not retrieval-only. Recense's D-06 measures retrieval-only latency — different definition.

**What "90% fewer tokens" measures:**
- Average tokens in context: mem0 1,764 vs full-context 26,031 (Table 2)
- Same full-context baseline as latency comparison
- **Caveat:** Measuring context-tokens-per-query, not total write tokens. Recense's D-07 measures per-write (extract+judge) AND per-recall (inject) tokens separately.

**Flag for recense's BENCH-03 note:** The mem0 numbers are real and sourced, but comparison configurations differ from what recense will measure. Recense's latency = retrieval-only (no answer gen). Recense's token cost = write (sleep pass) + recall inject. Do not directly equate.

---

#### MemPalace: LongMemEval R@5 96.6% (raw) / 84.2% (compressed) + LoCoMo R@10 88.9%

**Source:** MemPalace benchmarks/BENCHMARKS.md (develop branch), corroborated by independent teardown at github.com/MemPalace/mempalace/issues/703. [CITED: github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md]

**What "96.6% R@5" actually measures:**
- **The RAW ChromaDB embedder baseline** — verbatim session storage, `all-MiniLM-L6-v2` embeddings, `collection.add() + collection.query()` — not the MemPalace palace architecture
- The palace architecture (AAAK mode / spatial memory) is NOT the 96.6% configuration
- End-to-end QA accuracy at this configuration = ~67.2% (independent analysis) — retrieval recall and answer accuracy are not the same

**What "84.2%" measures:**
- AAAK compressed mode — the palace architecture's lossy summarization
- **Caveat:** This demonstrates the palace architecture degrades retrieval vs the raw embedder

**What "LoCoMo R@10 88.9%" measures:**
- Hybrid v5 mode on LoCoMo: person-name keyword overlap scoring + hybrid retrieval
- **No LLM required for this score** — keyword heuristic, not deep understanding
- A different metric (R@10) on a different dataset from the 96.6% LongMemEval R@5

**Summary note for BENCH-03:** MemPalace's flagship 96.6% is a ChromaDB baseline with `all-MiniLM-L6-v2`, not the palace — it measures the embedder. Do not treat it as a competing architecture result. The 88.9% LoCoMo R@10 uses keyword heuristics, no LLM, in a different retrieval mode. Neither is a meaningful target for recense's LLM-judge J score. Recense should report its own R@10 for comparison context, not as competitive parity.

---

#### Zep/Graphiti: DMR + LongMemEval

**Source:** Zep paper, arXiv 2501.13956. [CITED: arxiv.org/html/2501.13956v1]

**What Zep/Graphiti actually published:**
- DMR (Deep Memory Retrieval, MemGPT benchmark): Zep **94.8%** vs MemGPT 93.4%, using gpt-4-turbo
- LongMemEval (with gpt-4o): Zep **71.2%** vs full-context baseline 60.2% (18.5% relative improvement)
- LongMemEval (with gpt-4o-mini): Zep **63.8%** vs full-context 55.4%
- LoCoMo: **NOT EVALUATED** in the Zep paper — LoCoMo numbers come from third-party re-evaluations

**The "84% LoCoMo accuracy" claim from Zep marketing:**
This number has been challenged. A public GitHub issue [CITED: github.com/getzep/zep-papers/issues/5] documents that:
1. Zep's score was inflated by approximately 25.56 percentage points due to a denominator error (counting adversarial questions in the numerator but excluding them from the denominator)
2. After correcting the denominator, the score drops from ~84% to **58.44% ± 0.20%**
3. Additionally, Zep used a modified system prompt with explicit timestamp handling instructions not present in baseline configurations
4. A corrected re-evaluation puts mem0 at 66.88% and Zep/Graphiti at ~58.44%

**Summary note for BENCH-03:** The Zep paper's DMR (94.8%) and LongMemEval (71.2% with gpt-4o) scores are published and real. Zep did NOT evaluate on LoCoMo in their paper. Third-party LoCoMo evaluations of Zep/Graphiti appear inflated by the adversarial-denominator bug (~84% → ~58%). Do not cite the 84% figure. If comparing on LoCoMo, use mem0's published J score (66.88%) as the primary comparator — that is sourced and has a known methodology.

---

#### claude-mem: "~10x token savings"

**Source:** Multiple secondary sources (MindStudio blog, Agentpedia guide, Augment Code posts) citing the three-layer retrieval architecture. No primary paper or measured benchmark. [ASSUMED — no primary benchmark source found]

**What the "10x" claim actually measures:**
- A layer-1 session priming (<500 tokens) + layer-2 search index (~50-100 tokens/result) + layer-3 full details (~500-1000 tokens on demand) architecture
- "10x savings" compares to dumping full session history into context at session start — a straw-man baseline
- **No accuracy benchmark exists.** The "10x" is a token-efficiency claim only, for a different usage pattern (CC memory injection vs. memory-augmented QA)

**Summary note for BENCH-03:** claude-mem publishes no accuracy benchmark and no independently measured token savings. The ~10x claim is a marketing comparison to a straw-man baseline (full-context dump). Not a valid competitive target — cite it as "no accuracy benchmark; token claim vs full-context dump, unverified." Recense's Phase 42 token comparison should be against a defensible baseline (full-context, or mem0's measured approach), not claude-mem.

---

**Bottom-line reliability assessment for all competitor numbers:**

| Competitor | Metric | Value | Reliability | What Config Produced It |
|------------|--------|-------|-------------|-------------------------|
| mem0 | LoCoMo Overall J | 66.88% ± 0.15 | HIGH — peer-reviewed, 10-run avg | gpt-4o-mini extraction, gpt-4o-mini judge, adversarial excluded |
| mem0 | vs OpenAI latency | 91% lower p95 | MEDIUM — own paper, vs full-context | 1.44s vs 17.1s — full-context baseline, answer-gen included |
| mem0 | vs full-context token | 90% fewer | MEDIUM — own paper, vs full-context | 1,764 vs 26,031 context tokens per query |
| MemPalace | LongMemEval R@5 | 96.6% | MEDIUM — independent reproduction confirms | Raw ChromaDB + all-MiniLM-L6-v2, NOT palace architecture |
| MemPalace | LongMemEval R@5 compressed | 84.2% | LOW — single-source | AAAK compression mode, palace architecture |
| MemPalace | LoCoMo R@10 | 88.9% | LOW — single-source | Hybrid v5 + keyword heuristics, no LLM |
| Zep/Graphiti | DMR | 94.8% | HIGH — peer-reviewed | gpt-4-turbo; established MemGPT benchmark |
| Zep/Graphiti | LongMemEval | 71.2% | HIGH — peer-reviewed | gpt-4o; top-10 nodes+edges |
| Zep/Graphiti | LoCoMo ~84% | NOT VALID | Inflated ~25 pts by denominator bug | Adversarial counted in numerator, excluded from denominator + non-standard prompt |
| claude-mem | Token savings ~10x | UNVERIFIED | No primary benchmark | Straw-man (vs full-context dump), no accuracy claim |

---

### Item 5 [LOW]: Synthetic Corpus for Reproducible Latency-vs-N Curve (D-06b)

**Status: RESOLVED — one concrete approach sufficient.**

**Purpose:** Reproduce recense's brute-force cosine O(N) retrieval latency curve across node counts (e.g., N = 1K, 2K, 5K, 10K, 20K) without exposing private brain content.

**Recommended approach — embed LoCoMo itself:**
The LoCoMo corpus is already acquired for BENCH-01. After the full 10-conversation ingest + sleep pass, the scratch DB(s) will contain a realistic distribution of fact/entity nodes (mix of short strings, sentence-length facts, entity names). Export the node `value` strings from one completed scratch DB, discard all other data, then populate fresh scratch DBs at controlled N values by repeating/truncating the node pool.

Implementation:
```javascript
// After locomo-harness.cjs full run with --keep-dbs:
// 1. Export all node values from one scratch DB:
//    SELECT value FROM node WHERE tombstoned=0 AND embedding IS NOT NULL
// 2. Store as a flat JSON array in scripts/eval/fixtures/locomo-node-pool.json
// 3. latency-curve.cjs:
//    - For N in [1000, 2000, 5000, 9000, 15000, 20000]:
//      - Build scratch DB, insert N nodes (cycle pool if N > pool size)
//      - Embed a set of 20 held-out test queries (reuse locomo QA questions)
//      - Time CandidateRetriever.topk(queryVec, 10) for each query
//      - Report p50/p95 across 20 queries × N
```

This approach:
- Uses the same embedding model (text-embedding-3-small, 1536d) as production
- Uses realistic node value distribution (not random strings)
- No private content: LoCoMo is public domain (CC BY-NC 4.0)
- Reproducible from `locomo10.json` alone
- Script committed to `scripts/eval/latency-curve.cjs`, results to `scripts/eval/results/latency-curve-N.json`

The live brain at time of research: **9,062 embedded nodes** (measured via `SELECT COUNT(*) FROM node WHERE tombstoned=0 AND embedding IS NOT NULL` against the live `recense.db`). This is the "headline" N for the Phase 40 baseline latency measurement.

---

## D-10 Config Snapshot — Fields to Capture

The frozen config snapshot in `meta` should include these fields from `DEFAULT_CONFIG` (src/lib/config.ts):

```json
{
  "sut_commit": "<git rev-parse HEAD>",
  "engine_version": "0.1.0",
  "embed_model": "text-embedding-3-small",
  "embed_dimensions": 1536,
  "extract_model": "claude-haiku-4-5-20251001",
  "judge_model": "claude-sonnet-4-6",
  "consol_skip_threshold": 0.2,
  "consol_skip_threshold_assistant": 0.5,
  "rank_strength_weight": 0,
  "ranked_retrieval_k": 10,
  "ranked_retrieval_floor": 0.3,
  "candidate_k": 5,
  "entity_anchor_k": 5,
  "typed_anchor_pool_k": 20,
  "injection_token_budget": 500,
  "insight_surfacing_enabled": false,
  "predicate_gloss_threshold": 0.35
}
```

This is the complete v7.0 SUT snapshot for BENCH-02 reproducibility.

---

## Standard Stack

No new external packages are required for this phase. The harness uses existing project dependencies.

### Existing Dependencies Reused

| Library | Current Version | Purpose |
|---------|----------------|---------|
| `better-sqlite3` | 12.11.1 (registry) | Scratch DB for eval isolation |
| `openai` | 6.44.0 (registry) | GPT-4o-mini judge + embeddings |
| Engine dist (`dist/src/`) | v0.1.0 | ingest, consolidate, retrieve |

**No new npm packages.** The `locomo-harness.cjs` and `locomo-scorer.cjs` are pure-JS scripts that clone the existing harness pattern. [VERIFIED: npm registry]

### Package Legitimacy Audit

No new packages are being installed in this phase. Existing packages were already in use. Package legitimacy audit not required.

---

## Architecture Patterns

### System Architecture Diagram

```
locomo10.json
    │
    ▼ (loader: 10 conversations)
┌─────────────────────────────────────────────────────────┐
│  locomo-harness.cjs  (per-conversation loop)             │
│                                                          │
│  for each conversation:                                  │
│    ┌─────────────────────────────────────────────────┐  │
│    │  makeScratchDb()  →  EpisodicStore.append()     │  │
│    │  (one episode per session, tagged [Session N])  │  │
│    └─────────────────────────────────────────────────┘  │
│              │                                           │
│              ▼  runConsolidation() [Haiku extract +      │
│              │   Sonnet judge; subscription-billed]      │
│              ▼                                           │
│    ┌─────────────────────────────────────────────────┐  │
│    │  for each QA pair (skip category=5):            │  │
│    │    embed(question) → CandidateRetriever.topk()  │  │  ← latency measured HERE
│    │    instrumentTopkResults → R@K tap              │  │
│    │    Haiku answer gen (subscription)              │  │
│    └─────────────────────────────────────────────────┘  │
│              │                                           │
│              ▼  append result to OUT_FILE.jsonl          │
└─────────────────────────────────────────────────────────┘
              │
              ▼
locomo-scorer.cjs
    GPT-4o-mini judge (direct OpenAI API $)
    → Overall J score + per-category + meta config snapshot
              │
              ▼
scripts/eval/results/locomo-{commit}.json
```

### Recommended Project Structure

```
scripts/eval/
├── locomo-harness.cjs        # NEW: sibling of longmemeval-harness.cjs
├── locomo-scorer.cjs         # NEW: sibling of longmemeval-scorer.cjs
├── latency-curve.cjs         # NEW: D-06b latency-vs-N synthetic curve
├── locomo10.json             # acquired (not committed, add to .gitignore)
├── fixtures/
│   └── locomo-mini.jsonl     # dry-run fixture (1 conversation, 5 QA pairs)
└── results/
    ├── locomo-{commit}.json  # official baseline (post v7.0 tag)
    └── latency-curve-N.json  # D-06b latency curve
```

### Pattern: Clone-and-Adapt from longmemeval-harness.cjs

The LoCoMo harness is NOT a greenfield build. It inherits:
- `makeScratchDb()` — identical
- `buildRetrievalEngine()` — identical
- `runBoundedPool()` — identical
- `resolveProviderOverlay()` — identical
- `instrumentTopkResults` tap — extended for R@K (add session-index tracking)
- `--probe`, `--dry-run`, `--concurrency`, `--topk`, `--keep-dbs` flags — identical
- `meta.commit` + `meta.engine_version` — extended to D-10 full config snapshot

**Key differences from LongMemEval:**
1. Dataset loader: parse `locomo10.json` (single JSON object array, not JSONL)
2. Episode ingest: one episode per session (not one per question as in LongMemEval)
3. Scoring unit: per QA pair within a conversation (nested loop)
4. Category filter: skip `qa.category === 5` before scoring
5. R@K tap: session-index-aware hit logic (Item 3, Option A)
6. Outer loop: 10 conversations (vs 500 independent questions in LongMemEval)

### Anti-Patterns to Avoid

- **Running consolidation once per QA pair:** LoCoMo has ~200 QA pairs per conversation sharing the same episodes. Consolidate ONCE per conversation (after all session ingests), then evaluate all QA pairs against the consolidated scratch DB. (Same pitfall as LongMemEval Pitfall 4.)
- **Reusing the same scratch DB across conversations:** Each conversation must have its own fresh scratch DB. Conversations share no episode history.
- **Counting adversarial questions in the denominator:** Category 5 questions must be skipped entirely — neither counted correct nor incorrect. The J-score denominator = count(category != 5 questions).
- **Using the wrong judge:** Do not use the LongMemEval judge prompt (question-type-conditional, multiple templates). The LoCoMo scorer uses the single generic mem0 Appendix A prompt with gpt-4o-mini. Create a separate scorer file.
- **Measuring latency including answer generation:** Latency for BENCH-02 is retrieval-only — time the `CandidateRetriever.topk()` call only. Answer gen latency is a separate measurement.
- **Running the official baseline before v7.0 is tagged:** The harness can be built and validated anytime. The cost-gated official run waits for the v7.0 tag (D-10, D-03).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Scratch DB isolation | Custom DB factory | `makeScratchDb()` from longmemeval-harness.cjs | Already tested, handles tmpdir cleanup |
| Bounded concurrency | Custom pool | `runBoundedPool()` from longmemeval-harness.cjs | Already handles Node.js single-thread constraints |
| Provider overlay | Custom env parsing | `resolveProviderOverlay()` from run-sleep-pass | Handles RECENSE_SCORER_PROVIDER / RECENSE_MODEL_PROVIDER |
| JSON verdict parsing | Custom regex | `parseJudgeVerdict()` from longmemeval-scorer.cjs | Handles fenced JSON, yes/no, 0/1 edge cases |
| Token usage accounting | Custom tracker | `cost-benefit-probe.json` write-ledger format | Already documents per_model usage + retail_usd_estimate |
| R@K computation | Novel algorithm | `instrumentTopkResults` tap in harness | Tap already exposed; add session-index tracking only |

**Key insight:** This phase is eval infrastructure, not novel algorithms. Every component reuses an existing primitive. The value is in the *combination* (LoCoMo load + session-aware R@K + mem0 judge protocol), not any individual piece.

---

## Common Pitfalls

### Pitfall 1: Wrong LoCoMo Category Codes
**What goes wrong:** Treating category 1 = single-hop based on the paper's narrative order. In the actual locomo10.json, the codes are: 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial (counterintuitive numbering). Filtering out the wrong category produces inflated J scores by including adversarial (category 5) in the denominator.
**How to avoid:** After acquiring `locomo10.json`, run a one-liner to verify: `node -e "const d=require('./locomo10.json'); d.forEach(c => c.qa.forEach(q => console.log(q.category)))" | sort | uniq -c`. Confirm category 5 exists and is the adversarial set before scoring.
**Warning signs:** More than 1,600 scoreable questions (means adversarial included; correct count is ~1,491 non-adversarial).

### Pitfall 2: Conflating Retrieval Recall (R@K) with QA Accuracy
**What goes wrong:** Reporting R@10 as the headline accuracy number makes recense look like MemPalace (which uses R@K). Mem0 and Zep publish J-score (LLM judge accuracy) as their headline. A high R@10 and a mediocre J score is a real outcome; reporting only R@10 would be misleading.
**How to avoid:** D-04 mandates reporting both. J score is the headline. R@K is clearly labeled "retrieval diagnostic" in the BENCH-02 write-up.

### Pitfall 3: Inflated Cost Extrapolation in the D-01 Probe
**What goes wrong:** The cost probe (1 conversation) extrapolates ×10 for 10 conversations. But conversations vary in session count (19–35 sessions each). If the probe conversation is short, ×10 underestimates. If long, ×10 overestimates.
**How to avoid:** Use the median conversation length for extrapolation. Log session count for the probe conversation. Report the range (min×10 to max×10) alongside the median extrapolation.

### Pitfall 4: Measuring Latency for the Full Pipeline, Not Retrieval-Only
**What goes wrong:** Including answer generation (Haiku ~9s/call per cost-benefit-probe.json) in the latency number produces numbers that don't compare to recense's stated "retrieval-only" design. The Phase 41 optimization target is retrieval latency, not answer-gen.
**How to avoid:** Time only `CandidateRetriever.topk(queryVec, K)` with a `Date.now()` before/after. Record separately: `retrieval_ms`, `embed_ms`, `answer_ms`. Report `retrieval_ms` as the headline BENCH-02 latency.

### Pitfall 5: Skipping the --dry-run Gate Before Any Paid Run
**What goes wrong:** The harness silently proceeds to the full 10-conversation run, consuming subscription budget and $$ on embeddings/GPT-4o-mini without a probe gate. With ~1,491 scoreable QA pairs × GPT-4o-mini judge, the scoring alone runs up meaningful API cost.
**How to avoid:** Implement `--probe` (1 conversation, then exit with cost estimate) as the first validation step. The harness must not proceed to full run without an explicit `--run` flag (or the probe completing successfully). Mirror `longmemeval-harness.cjs`'s `IS_PROBE` guard pattern exactly.

### Pitfall 6: Zep LoCoMo Numbers in BENCH-03
**What goes wrong:** Citing Zep's marketed 84% LoCoMo score as a target without noting the ~25-point denominator inflation. Recense then "beats" a number that was never real.
**How to avoid:** The BENCH-03 competitor targets table must include a methodology note for every number. The Zep LoCoMo entry should read: "~84% (Zep marketing) — DO NOT CITE. Independent re-evaluation: 58.44% ± 0.20 after adversarial-denominator correction [github.com/getzep/zep-papers/issues/5]. Use mem0's 66.88% ± 0.15 as the primary comparator."

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|-----------------|--------|
| Original LoCoMo F1 scoring (exact match normalized) | LLM-as-a-Judge (gpt-4o-mini, topic-match lenient) | All 2024-2025 memory papers use J-score; F1 is not the standard anymore |
| Adversarial in denominator | Adversarial excluded | 25-point inflation risk if adversarial included (Zep bug) |
| Full-context retrieval as baseline | Full-context as baseline for latency/token, OpenAI memory as baseline for J-score | mem0 uses two different baselines for two different claims |
| R@5 only | R@10 also reported | MemPalace popularized R@K; mem0 uses J; both needed for competitive coverage |

**Current state of LoCoMo benchmarking (2026):**
- The benchmark has known quality issues: 6.4% corrupted answer key + lenient judge. Differences < 5-7 points are noise.
- The "standard" judge is gpt-4o-mini with the mem0 Appendix A prompt — this is what competitors actually used.
- No standardized harness exists. Every system uses slightly different ingest/prompt configurations, making cross-system comparisons noisy.
- LoCoMo-Refined (github.com/mem-eval-suite/LoCoMo_refined) attempts a stricter evaluation (Qwen3-14B judge, cleaned dataset) but is not yet the community standard. Recense should track this but not use it as the primary comparator (comparability requires the same judge as competitors).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The mem0 paper's "gpt-4o-mini" (Section 2.1) is the exact judge used to produce the 66.88% J score, not the mem0/memory-benchmarks repo's CLI default of "gpt-4o" | Item 1, Judge Model | If wrong: recense's J score uses a different model than competitors' published numbers; not directly comparable. Mitigation: record exact judge model in meta; run both if needed to verify comparability. |
| A2 | LoCoMo category numeric codes: 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial | Item 2, Category Codes | If wrong: filtering out the wrong category inflates J score by ~25-33%. Mitigation: verify by counting category values after acquiring locomo10.json before scoring. |
| A3 | Per-category QA counts in LoCoMo-10: ~720 single-hop, ~410 temporal, ~290 multi-hop, ~77 open-domain, ~495 adversarial | Item 2, Scale | If wrong: cost extrapolation in D-01 probe may be off. Mitigation: count QA pairs from actual locomo10.json at acquisition time. |
| A4 | The mem0 paper's Appendix A judge prompt is the full verbatim protocol (captured via WebFetch) | Item 1, Judge Prompt | If wrong: scorer behavior may diverge from mem0's actual evaluation. Mitigation: cross-check the prompt against the mem0/memory-benchmarks repo's locomo run script when available. |
| A5 | Zep's corrected LoCoMo score is ~58.44% after the denominator fix | Item 4, Zep | If wrong: the corrected number is different from expected. Mitigation: treat as "disputed" — use mem0's 66.88% as the primary comparator, not Zep's numbers. |

**If this table is empty:** All claims in this research were verified or cited — not the case here; A1–A5 all require mitigation in the harness or scorer.

---

## Open Questions (RESOLVED)

> All three carry a planned mitigation — none is a blocking unknown. Q1 → Plan 40-03 implements gpt-4o-mini per the paper and records `meta.judge_model` (calibration re-run with gpt-4o available if results look anomalous). Q2 → keep `locomo10.json` gitignored (Plan 40-01). Q3 → Plan 40-05 D-01 probe uses the median-length conversation and reports a min/max range. Execution can proceed.

1. **Exact judge model: gpt-4o-mini vs gpt-4o in mem0/memory-benchmarks repo**
   - What we know: The mem0 paper (primary source) explicitly states gpt-4o-mini. The memory-benchmarks repo CLI shows `--judge-model gpt-4o` as a default.
   - What's unclear: Whether the benchmarks repo was updated after the paper to use gpt-4o, meaning the published 66.88% was actually with gpt-4o (more expensive) or gpt-4o-mini (paper version).
   - Recommendation: Implement with gpt-4o-mini to match the paper. Record the exact model string in `meta.judge_model`. If recense's results look anomalously different from mem0's published J scores, re-run with gpt-4o as a calibration check.

2. **LoCoMo locomo10.json license scope for the eval fixture**
   - What we know: CC BY-NC 4.0 — non-commercial use permitted.
   - What's unclear: Does including locomo10.json in a public GitHub repo (if recense goes OSS later) satisfy the license? Internal use is unambiguously fine.
   - Recommendation: Keep locomo10.json in `.gitignore` (same pattern as longmemeval-s.jsonl), provide acquisition instructions in the harness header comment. This avoids the license question for the public repo.

3. **Session-count variability in the D-01 probe cost extrapolation**
   - What we know: Conversations have 19–35 sessions each; cost scales with session count.
   - What's unclear: Which conversation to pick as the probe sample for a representative cost estimate.
   - Recommendation: Pick the median-length conversation (sort by session count, pick the 5th or 6th of 10). Document the session count of the probe conversation alongside the ×10 extrapolation.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All harness scripts | ✓ (darwin, zsh) | — | — |
| `better-sqlite3` | Scratch DB | ✓ (in package.json) | 12.11.1 | — |
| `openai` npm package | GPT-4o-mini scorer | ✓ (in package.json) | 6.44.0 | — |
| `OPENAI_API_KEY` | GPT-4o-mini judge + embeddings | ✓ (rotated 2026-06-21, in sleep.env) | — | — |
| `claude -p` (headless) | Haiku extract + Sonnet judge | ✓ (spike 003 live) | — | — |
| locomo10.json | LoCoMo harness | ✗ (not yet acquired) | — | Run `git clone github.com/snap-research/locomo` to acquire |
| Live recense.db (for D-06a latency) | Latency p50/p95 | ✓ (9,062 embedded nodes measured) | 9,062 nodes | — |
| npm run build (dist/) | All harness scripts | ✓ (required before any eval run) | — | Run `npm run build` |

**Missing dependencies with no fallback:**
- locomo10.json — must be acquired before the harness can run. Wave 0 task.

**Missing dependencies with fallback:**
- None.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (existing, `npm run test`) |
| Config file | vitest.config.ts (existing) |
| Quick run command | `npm run build && node scripts/eval/locomo-harness.cjs --dry-run` |
| Full suite command | `npm run test && npm run build && node scripts/eval/locomo-harness.cjs --probe` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BENCH-01 | LoCoMo harness parses locomo10.json and produces result | Smoke | `node scripts/eval/locomo-harness.cjs --dry-run` | ❌ Wave 0 |
| BENCH-01 | Category 5 questions excluded from scoring | Unit | `npm run test -- locomo-scorer` | ❌ Wave 0 |
| BENCH-01 | R@K tap produces session-level hits | Unit | `npm run test -- locomo-harness` | ❌ Wave 0 |
| BENCH-02 | Config snapshot in meta JSON | Smoke | Inspect `locomo-*.json` meta field after --dry-run | ❌ Wave 0 |
| BENCH-03 | Scorer uses gpt-4o-mini judge prompt verbatim | Unit | `npm run test -- locomo-scorer` (mock judge) | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm run build && node scripts/eval/locomo-harness.cjs --dry-run`
- **Per wave merge:** `npm run test && npm run build && node scripts/eval/locomo-harness.cjs --dry-run`
- **Phase gate:** D-01 probe (1 conversation, real API) → budget confirmation → official baseline run

### Wave 0 Gaps

- [ ] `scripts/eval/fixtures/locomo-mini.jsonl` — 1-conversation dry-run fixture (derived from locomo10.json[0]; hand-trim to 5 QA pairs)
- [ ] `scripts/eval/locomo-harness.cjs` — the harness itself (Wave 1 task output, but Wave 0 must define its --dry-run fixture)
- [ ] `scripts/eval/locomo-scorer.cjs` — scorer with mem0 Appendix A prompt (Wave 1)
- [ ] Unit test file for category filtering + R@K hit logic

---

## Security Domain

No network-exposed surface in this phase. The harness scripts write to local files. The only external calls are:
- `claude -p` headless (subscription-billed, existing pattern)
- OpenAI API (direct, for GPT-4o-mini judge + embeddings)

ASVS not applicable to offline eval scripts. API keys (`OPENAI_API_KEY`) must remain in `sleep.env` (not committed), consistent with the existing pattern.

---

## Sources

### Primary (HIGH confidence)

- arXiv 2504.19413 (mem0 paper, HTML version) — judge model, Appendix A prompt, J scores, adversarial exclusion, 26%/91%/90% claim decomposition
- arXiv 2501.13956 (Zep paper, HTML version) — DMR 94.8%, LongMemEval 71.2%, NO LoCoMo evaluation
- arXiv 2402.17753 (original LoCoMo paper, HTML version) — dataset scale, 5 categories, F1 scoring (original), adversarial definition
- github.com/snap-research/locomo — canonical dataset repo, locomo10.json location, 2.68 MB, CC BY-NC 4.0
- github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py — QA struct fields (question, answer, evidence, category), category 5 = adversarial handling

### Secondary (MEDIUM confidence)

- github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md — 96.6% R@5 raw ChromaDB, 84.2% compressed, 88.9% R@10 LoCoMo hybrid v5
- github.com/getzep/zep-papers/issues/5 — Zep LoCoMo inflation analysis (~84% → 58.44% corrected, denominator bug + non-standard prompt)
- dev.to/penfieldlabs LoCoMo audit — 6.4% corrupted answer key, 62.81% judge acceptance rate for intentionally wrong answers, gpt-4o-mini as judge

### Tertiary (LOW confidence — marked [ASSUMED] where used)

- Multiple secondary sources for claude-mem "~10x" claim — not sourced to a primary benchmark
- Category numeric code mapping (1=multi-hop, 4=single-hop) — consistent across third-party harnesses but no official snap-research documentation

---

## Metadata

**Confidence breakdown:**
- Judge protocol (D-05): HIGH — primary source (peer-reviewed paper) with verbatim prompt
- Dataset schema (D-09): MEDIUM-HIGH — schema confirmed via third-party harness code; category codes ASSUMED (consistent across sources but not in official README)
- R@K definition: MEDIUM — recommended approach is defensible; implementation requires session-index tracking not yet in the harness
- Competitor target verification (D-08): HIGH for mem0 and Zep LongMemEval/DMR; MEDIUM for MemPalace; LOW for claude-mem (no primary source)
- Synthetic latency curve approach: MEDIUM — approach is sound, no verification needed beyond implementation

**Research date:** 2026-06-22
**Valid until:** 60 days for stable sources (competitor papers); 30 days for community norms (LoCoMo benchmark standards moving fast in 2026)

---

## RESEARCH COMPLETE

**Phase:** 40 - Competitive Benchmark Baseline
**Confidence:** MEDIUM-HIGH

### Key Findings

1. **Judge protocol pinned (D-05):** GPT-4o-mini, mem0 Appendix A prompt (topic-match lenient, binary CORRECT/WRONG JSON), 4 categories evaluated (exclude adversarial category 5 from denominator entirely). This is what makes recense's J score comparable to mem0's published 66.88%.

2. **LoCoMo-10 dataset located:** `github.com/snap-research/locomo`, `./data/locomo10.json`, 2.68 MB, CC BY-NC 4.0, 10 conversations, 1,986 QA pairs. Schema: `qa[].{question, answer, evidence[], category}`. Adversarial = category 5, skip. Acquire via git clone; do not commit.

3. **Competitor numbers verified with significant caveats:** Zep's 84% LoCoMo claim is inflated ~26 points (denominator bug, confirmed via public GitHub issue). MemPalace 96.6% = ChromaDB raw embedder, not their palace architecture. mem0's 66.88% J score is the most defensible comparator — peer-reviewed, 10-run average, methodology documented.

4. **R@K recommended definition:** Session-level hit using `qa.evidence` dialog IDs mapped to episode session indices via `consolidation_event` → `episode` join. Tag episodes at ingest with `[Session N]` prefix to enable this mapping.

5. **Live brain: 9,062 embedded nodes** (measured 2026-06-22). This is the headline N for D-06a latency measurement. Synthetic latency curve: build from LoCoMo node pool exported from scratch DBs, run at N = 1K / 2K / 5K / 9K / 15K / 20K.

### File Created

`.planning/phases/40-competitive-benchmark-baseline/40-RESEARCH.md`

### Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Judge protocol (D-05) | HIGH | Primary source (arXiv 2504.19413 HTML), verbatim prompt, confirmed model |
| Dataset schema (D-09) | MEDIUM-HIGH | Confirmed via third-party harness source code; category codes consistent but not in official docs |
| Competitor verification (D-08) | HIGH (mem0), LOW (claude-mem) | mem0/Zep primary sources; claude-mem no primary benchmark exists |
| R@K definition | MEDIUM | Sound approach; A1/A2 assumptions need in-harness verification |
| Synthetic latency curve (D-06b) | MEDIUM | Approach is standard; no precedent to compare against |

### Open Questions

- Confirm at acquisition time: `gpt-4o-mini` was the exact model in mem0's paper run (vs later benchmarks-repo default of `gpt-4o`). Record both in meta and report which was used.
- Verify category codes by counting locomo10.json values before scoring (A2 mitigation).

### Ready for Planning

Research complete. Planner can now create PLAN.md. The most critical input for Wave 1 task design is the judge protocol (Item 1), the dataset acquisition task (Item 2), and the R@K session-index tracking approach (Item 3). All three are plan-ready.
