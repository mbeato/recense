# Phase 40 — Competitor Target Verification (BENCH-03)

**Purpose:** Every number in this document is cited with source and methodology caveat.
Treat all figures as estimates with significant caveats — do NOT lift raw numbers without reading the methodology note.

---

## Noise Floor (read before comparing anything)

The LoCoMo benchmark itself has known quality issues:
- **6.4% corrupted answer key** — some ground-truth answers are wrong.
- **Lenient judge (~62.81% acceptance rate for intentionally wrong but topically-related answers)** — the gpt-4o-mini prompt asks the judge to be "generous" (accept if it "touches on the same topic").

**Consequence: differences < 5–7 percentage points on LoCoMo J-scores are not interpretable.** They are within the noise band created by the corrupted key and judge leniency. Only differences substantially larger than this margin carry signal.

Sources: [arXiv 2402.17753 LoCoMo paper] + [dev.to/penfieldlabs LoCoMo audit].

---

## Comparison-Configuration Mismatches

Before comparing recense's measured numbers to any figure below:

| Axis | recense (D-06 / D-07) | Competitors |
|------|-----------------------|-------------|
| Latency | Retrieval-ONLY: `Date.now()` wraps only `CandidateRetriever.topk()` | mem0 "91% lower latency" = full answer-gen pipeline (search + LLM answer) |
| Token cost | Per-write (sleep-pass Haiku extract + Sonnet judge) + per-recall (inject budget) | mem0 "90% fewer tokens" = context-tokens-per-query vs full-context dump |

Do not directly equate numbers across these different definitions.

---

## Competitor Table

### mem0 — LoCoMo Overall J Score

| Field | Value |
|-------|-------|
| Metric | LLM-as-a-Judge (J score) |
| Value | **66.88% ± 0.15** |
| Source | arXiv 2504.19413, Table 2 [CITED] |
| Config | gpt-4o-mini judge (mem0 Appendix A prompt, lenient topic-match), gpt-4o-mini extraction; adversarial category 5 excluded from denominator; 10-run average |
| Methodology note | This is recense's **primary LoCoMo comparator**. The judge is lenient — accepts ~62.81% of intentionally wrong but on-topic answers. "66.88% accuracy" is not everyday accuracy. The relative improvement vs OpenAI memory (52.90% → 66.88%) is the meaningful signal, not the absolute value. |

### mem0 — Latency ("91% lower")

| Field | Value |
|-------|-------|
| Metric | p95 response latency |
| Value | mem0: 1.44s vs full-context: 17.117s (91.6% reduction) |
| Source | arXiv 2504.19413, Table 2 [CITED] |
| Config | Full answer-generation pipeline: search + LLM answer generation. Comparison baseline = passing the entire 26K-token conversation as context. |
| Methodology note | **NOT retrieval-only.** mem0's number includes LLM answer generation (~9s+ per call). recense D-06 measures retrieval-only latency — a fundamentally different boundary. Direct comparison would be misleading. |

### mem0 — Token Efficiency ("90% fewer tokens")

| Field | Value |
|-------|-------|
| Metric | Context tokens per query |
| Value | mem0: 1,764 vs full-context: 26,031 (93.2% reduction) |
| Source | arXiv 2504.19413, Table 2 [CITED] |
| Config | Average context-window tokens injected per answer-generation query. Baseline = full-context approach. |
| Methodology note | Measures context-tokens-per-query, not total write tokens. recense D-07 measures per-write (extract+judge sleep-pass tokens) AND per-recall (inject budget tokens) — different accounting boundaries. |

---

### MemPalace — LongMemEval R@5 (raw ChromaDB)

| Field | Value |
|-------|-------|
| Metric | Retrieval Recall at K=5 |
| Value | **96.6%** |
| Source | github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md [CITED] + independent teardown [github.com/MemPalace/mempalace/issues/703] |
| Config | **RAW ChromaDB baseline** — verbatim session storage with `all-MiniLM-L6-v2` embeddings (`collection.add()` + `collection.query()`). This is NOT the MemPalace palace architecture. |
| Methodology note | **The 96.6% measures the embedder (all-MiniLM-L6-v2), not the MemPalace architecture.** The palace (AAAK mode / spatial memory) is a separate configuration. End-to-end QA accuracy at this configuration ≈ 67.2% (independent analysis). Retrieval recall and answer accuracy are not the same metric. **Do not use this as a target for recense's architecture-level performance.** |

### MemPalace — LongMemEval R@5 (compressed/AAAK)

| Field | Value |
|-------|-------|
| Metric | Retrieval Recall at K=5 |
| Value | **84.2%** |
| Source | github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md [CITED] |
| Config | AAAK compression mode — the actual palace architecture with lossy summarization |
| Methodology note | Single-source (low reliability). This demonstrates the palace architecture degrades retrieval vs the raw embedder. The 84.2% → 96.6% gap is the architecture's lossy-compression cost. |

### MemPalace — LoCoMo R@10

| Field | Value |
|-------|-------|
| Metric | Retrieval Recall at K=10 |
| Value | **88.9%** |
| Source | github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md [CITED] |
| Config | Hybrid v5 mode on LoCoMo: person-name keyword overlap scoring + hybrid retrieval. **No LLM required for this score.** |
| Methodology note | Keyword heuristic, not deep understanding. A different metric (R@10) on a different dataset (LoCoMo) than the 96.6% (LongMemEval R@5). Neither MemPalace figure is a meaningful target for recense's LLM-judge J score. |

---

### Zep/Graphiti — DMR (Deep Memory Retrieval)

| Field | Value |
|-------|-------|
| Metric | DMR (MemGPT benchmark) |
| Value | **94.8%** |
| Source | arXiv 2501.13956, Table [CITED] |
| Config | gpt-4-turbo; established MemGPT benchmark. Zep vs MemGPT (93.4%). |
| Methodology note | Published, peer-reviewed. High reliability. Different benchmark from LoCoMo — not directly comparable to J scores. |

### Zep/Graphiti — LongMemEval

| Field | Value |
|-------|-------|
| Metric | LongMemEval accuracy |
| Value | **71.2%** (gpt-4o), **63.8%** (gpt-4o-mini) |
| Source | arXiv 2501.13956 [CITED] |
| Config | gpt-4o top-10 nodes+edges retrieval; vs full-context baseline 60.2% (gpt-4o) |
| Methodology note | Published, peer-reviewed. High reliability. Zep did NOT evaluate on LoCoMo in their paper. |

### Zep/Graphiti — LoCoMo ~84% (DO NOT CITE)

| Field | Value |
|-------|-------|
| Metric | LoCoMo "accuracy" (marketing) |
| Value | ~84% — **DO NOT CITE** |
| Source | Zep marketing; challenged at github.com/getzep/zep-papers/issues/5 [CITED] |
| Config | Adversarial questions counted in numerator but excluded from denominator (denominator inflation bug) + non-standard system prompt with explicit timestamp handling |
| Corrected value | **~58.44% ± 0.20%** after adversarial-denominator correction |
| Methodology note | **DO NOT CITE the 84% figure.** Independent re-evaluation [getzep/zep-papers#5] documents ~25.56 percentage point inflation from a denominator bug (adversarial counted in numerator, excluded from denominator) plus a non-standard prompt. After correcting the denominator, the score drops to ~58.44% ± 0.20. **Use mem0's 66.88% ± 0.15 as the primary LoCoMo comparator** — it has a known, documented methodology and is peer-reviewed. Zep's corrected 58.44% is also referenced for completeness. |

---

### claude-mem — Token Savings (~10x)

| Field | Value |
|-------|-------|
| Metric | Token efficiency |
| Value | ~10x token savings (claimed) |
| Source | Secondary sources (MindStudio blog, Agentpedia, Augment Code posts) — **NO PRIMARY BENCHMARK** [ASSUMED] |
| Config | Three-layer retrieval: layer-1 session priming (<500 tokens) + layer-2 search index (~50-100 tokens/result) + layer-3 full details (~500-1000 tokens). Comparison baseline = dumping full session history into context at session start. |
| Methodology note | **No accuracy benchmark exists for claude-mem.** The "~10x" is a token-efficiency claim only, compared to a straw-man baseline (full-context dump at session start), which is not how mem0, Zep, or recense measure token cost. No independently measured or peer-reviewed number. **Not a valid competitive target. Cite as: "no accuracy benchmark; token claim vs full-context dump, unverified."** |

---

## Summary Reliability Table

| Competitor | Metric | Value | Reliability | Primary Comparator? |
|------------|--------|-------|-------------|---------------------|
| mem0 | LoCoMo Overall J | **66.88% ± 0.15** | HIGH — peer-reviewed, 10-run avg | **YES — primary LoCoMo comparator** |
| mem0 | Latency p95 | 91% lower (1.44s vs 17.1s) | MEDIUM — own paper, answer-gen included | No — different boundary than D-06 |
| mem0 | Token cost | 90% fewer (1,764 vs 26,031 ctx tokens) | MEDIUM — own paper, ctx-tokens-per-query | No — different accounting than D-07 |
| MemPalace | LongMemEval R@5 raw | 96.6% | MEDIUM — independent reproduction confirms | No — embedder metric, not architecture |
| MemPalace | LongMemEval R@5 compressed | 84.2% | LOW — single source | No |
| MemPalace | LoCoMo R@10 | 88.9% | LOW — single source | No — keyword heuristic, no LLM |
| Zep/Graphiti | DMR | 94.8% | HIGH — peer-reviewed, gpt-4-turbo | No — different benchmark |
| Zep/Graphiti | LongMemEval | 71.2% | HIGH — peer-reviewed, gpt-4o | No — different benchmark |
| Zep/Graphiti | LoCoMo ~84% | **DO NOT CITE** — inflated ~25 pts | NOT VALID | No |
| Zep/Graphiti | LoCoMo corrected | ~58.44% ± 0.20 | MEDIUM — community re-evaluation | Secondary reference only |
| claude-mem | Token savings ~10x | UNVERIFIED | No primary benchmark | No |

---

## How to Use These Numbers

When recense publishes its Phase 40 baseline:

1. **Report recense's LoCoMo J score vs mem0's 66.88%** — same benchmark, same judge protocol (gpt-4o-mini, mem0 Appendix A prompt, adversarial excluded). This is the defensible head-to-head.
2. **Report recense's LoCoMo J score vs Zep's corrected 58.44%** — with a note that this is a community-corrected figure, not the paper's published number.
3. **DO NOT compare recense latency to mem0's "91% lower"** — they measure different things (retrieval-only vs answer-gen-inclusive). Instead, report recense retrieval-only p50/p95 from D-06 as a standalone metric and note the boundary difference explicitly.
4. **DO NOT cite Zep's ~84% LoCoMo figure under any circumstances.**
5. **DO NOT cite claude-mem's "~10x" token claim as a competitive benchmark** — it has no accuracy component and uses a straw-man baseline.
6. **Cite MemPalace 96.6% only with the full caveat**: that is the raw ChromaDB embedder baseline, not the palace architecture, and it measures retrieval recall not answer accuracy.

---

*Source-verified: 2026-06-23. Based on 40-RESEARCH.md Item 4, RESEARCH conclusions, and the CLAUDE.md no-inflated-metrics hard rule.*
