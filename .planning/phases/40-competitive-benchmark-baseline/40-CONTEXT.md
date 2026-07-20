# Phase 40: Competitive Benchmark Baseline - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up an apples-to-apples competitive benchmark and record honest baselines on all three axes (accuracy, latency, token/cost), so "at or above competitors" becomes falsifiable. Add a **LOCOMO** harness alongside the existing LongMemEval + KU replay harnesses; capture recense's current accuracy, retrieval latency (p50/p95), and token cost per write+recall; and pin competitor numbers with sourced, methodology-understood notes.

**In scope:** LOCOMO harness (BENCH-01), written baseline of accuracy/latency/token (BENCH-02), competitor targets cited + methodology-understood (BENCH-03).

**Out of scope (own phases):** the vector index / latency optimization (Phase 41), token-lever tuning + progressive-disclosure adoption (Phase 42), CI regression gates (Phase 43), reproducing rival pipelines head-to-head (deferred stretch — see Deferred).

**Sequencing note (load-bearing):** the *official* baseline run measures the **frozen v7.0-final system**. v7.0 is build-complete + audited but **not tagged** (held for Phase 39.1 corpus-quality, whose last plan 39.1-05 is still open). Therefore: **build the harness now; run the official baseline only after 39.1-05 lands and v7.0 is tagged.** Phases 41/42 are accuracy-neutral optimizations whose success criteria are defined *relative to this Phase 40 baseline* (PERF-02/03, COST-01/02) — so 40 must precede them. This sequencing was explicitly re-examined and confirmed during discussion (no hidden accuracy-improving phase exists; the only accuracy-adjacent deferred item — bi-temporal validity — was a deliberate v7.0 no, not an oversight).
</domain>

<decisions>
## Implementation Decisions

### Cost Gate (founder budget control — Claude Max 20x)
- **D-01:** A **1-conversation LOCOMO cost probe is a HARD GATE before any full benchmark run.** Run ingest→sleep→retrieve→answer→score on a single LoCoMo conversation, read the actual subscription `usage` / `total_cost_usd` from the `claude -p --output-format json` envelope, extrapolate ×10 to the full LoCoMo-10, and confirm the projected % against Claude Code's `/usage` weekly meter **before** committing to the full run.
- **D-02:** Cost framing for the founder: the heavy benchmark *run* is **Haiku (extract/answer) + Sonnet (judge)** via headless `claude -p` — it hits the **subscription general bucket, not Opus**, and does not need an interactive session (detached `node scripts/eval/...` process, schedulable pre-reset). Estimated **~1–5% of the weekly 20x general budget** for one full run (estimate — D-01 replaces it with a measured number). The **GPT-4o scorer + OpenAI embeddings are direct API $**, independent of the subscription reset.
- **D-03:** Run-timing posture: **build + validate the harness anytime** (cheap, design work); **schedule the heavy official run for right before a weekly reset** if the probe shows meaningful budget use. Don't defer the *phase* — defer the *run*.

### Accuracy Metric (BENCH-01/02)
- **D-04:** Report **both** metrics on LOCOMO — **end-to-end QA accuracy (LLM-judge) as the headline** (matches mem0/Zep, reuses the existing end-to-end harness) **plus retrieval R@K (R@5/R@10) as a secondary diagnostic** (nearly free via the existing `instrumentTopkResults` top-k tap; lets recense answer MemPalace's R@10 framing too).
- **D-05:** Score the headline QA accuracy with the **replicated mem0/Zep LoCoMo LLM-judge protocol** (their judge model + prompt), so the number is directly comparable, and commit a **methodology note documenting the exact protocol used**. This is BENCH-03's no-inflated-metrics rule applied to our own scorer choice. → **Research item:** pin mem0/Zep's exact published LoCoMo judge model + prompt before building the scorer.

### Latency / Token Surface (BENCH-02/03)
- **D-06:** Measure **both**: (a) real-world retrieval **p50/p95 on the live ~7000-node brain** as the headline latency (BENCH-02), AND (b) a **committed script reproducing the latency-vs-N curve on a synthetic/public corpus** so the methodology reproduces without exposing private data (BENCH-03). Brute-force cosine is O(N), so the curve is the honest way to show latency at scale.
- **D-07:** **Token cost** (per-write extract+judge, per-recall inject) is measured on the **reproducible LoCoMo corpus** (portable, scriptable), not the private brain.

### Competitor Targets (BENCH-03)
- **D-08:** **Cite + methodology-note now; do NOT reproduce rival pipelines in this phase.** Document each rival's published number with a one-line note on what configuration/metric/slice produced it (e.g. MemPalace 96.6% = ChromaDB raw-embedder mode, not the palace architecture; drops to 84.2% with their compression). Satisfies BENCH-03 as written, avoids rival-pipeline $ on a budget-sensitive baseline phase.

### LOCOMO Scope + Frozen Config (BENCH-01/02)
- **D-09:** Run the **full standard LoCoMo-10** (all 10 conversations, all categories: single-hop, multi-hop, temporal, open-domain, adversarial) so the overall number is directly comparable to mem0/Zep. Scale is gated by D-01's probe. Per-category breakdown is optional/nice-to-have, not required.
- **D-10:** **Freeze the system-under-test at the v7.0 tag.** The official baseline run captures the **exact commit hash + a serialized config dump** (embed model, judge model, extract model, Phase-35 recency/strength ranking knobs, RRF params, inject/recall budgets, `consolSkipThreshold`) in the results JSON. The existing harness already records `commit` + `engine_version` in result `meta` — extend that to a full config snapshot.

### Claude's Discretion
- R@K ground-truth definition (what counts as a "hit" when recense retrieves facts/nodes, not original LoCoMo sessions) — planner/researcher to resolve against the LoCoMo answer-evidence labels.
- Synthetic-corpus construction for the reproducible latency curve (D-06b) — node-count/embedding-dim fidelity without private content; implementation choice.
- Token-cost-per-write/per-recall exact accounting boundaries (D-07) — reuse the existing write-ledger / probe instrumentation seen in `cost-benefit-probe.json`.
- Abstention handling on adversarial/unanswerable LoCoMo questions — follow the LoCoMo official protocol once the judge protocol is pinned (D-05).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition & milestone discipline
- `.planning/ROADMAP.md` §"Phase 40: Competitive Benchmark Baseline" — goal, BENCH-01/02/03, the researched competitor targets (mem0, Zep/Graphiti, MemPalace, claude-mem) with their methodology caveats.
- `.planning/ROADMAP.md` §"Phase Details — v8.0 Performance, Efficiency & Competitive Parity" — engine invariants (online LLM-free; graph source of truth, vector derived; no accuracy regression for latency/token wins), baseline-first discipline, dependency shape 40 → {41,42} → 43.
- `.planning/v7.0-MILESTONE-AUDIT.md` — the v7.0 system-under-test state (the frozen SUT per D-10); confirms 35–39 build-complete/audited.

### Existing eval harness (reuse — adapt for LOCOMO)
- `scripts/eval/longmemeval-harness.cjs` — the end-to-end pattern to clone for LOCOMO: ingest → sleep pass → retrieve → answer (Haiku) → score (GPT-4o); has the `instrumentTopkResults` top-k tap reused for R@K (D-04) and probe cost/latency instrumentation.
- `scripts/eval/replay-ku-harness.cjs` — KU replay (cached extraction, cheap re-run); the "consolidate once, sweep eval" pattern.
- `scripts/eval/longmemeval-scorer.cjs` — existing GPT-4o scorer (to be supplemented by the replicated rival protocol per D-05).
- `scripts/eval/README.md` — harness conventions (NODE_PATH, provider overlays, dry-run).
- `scripts/eval/longmemeval-s.jsonl` (500 Q) + `scripts/eval/results/longmemeval-ku-only.jsonl` (78) — existing datasets run alongside LOCOMO.

### Cost anchors (for the D-01 probe extrapolation)
- `scripts/eval/results/cost-benefit-probe.json` — measured ~1,470 Haiku tokens/episode extraction (5-episode probe), write-ledger format.
- `scripts/eval/results/cost-std-baseline.json` / `cost-std-twotier.json` — per-model usage (Haiku ~99K tokens / 17 cases) and the `usage.per_model` reporting shape to mirror.

### Engine config / billing model
- `CLAUDE.md` (project) §Constraints — sleep-pass model stack (extract=headless Haiku, judge=headless Sonnet via `claude -p` on Max subscription), `consolSkipThreshold` gating, config location `config.ts:620-622`, subscription-billing framing (`--output-format json` reports per-call `usage`/`total_cost_usd`).
- `src/lib/config.ts` (DEFAULT_CONFIG, ~line 712) — the frozen-config knobs to snapshot per D-10. (NOTE: `src/model/config.ts` does NOT exist — corrected 2026-06-22 during planning; RESEARCH + PATTERNS confirm.)

### To be acquired
- LOCOMO dataset — **not yet downloaded**; acquire the standard LoCoMo-10 set + mem0/Zep's published LoCoMo evaluation (judge protocol + per-category numbers) as the D-05 research item.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `longmemeval-harness.cjs`: full end-to-end scaffold (arg parser, provider overlay resolution, headless `claude -p` answer routing, dry-run mode, top-k tap, probe cost estimation) — the LOCOMO harness is a sibling of this, not a greenfield build.
- `replay-ku-harness.cjs`: cached-extraction / consolidate-once pattern — keeps KU re-runs cheap when LOCOMO is added.
- `cost-benefit-probe.json` write-ledger + `cost-std-*.json` `usage.per_model` shape: the existing token-accounting format to reuse for D-01/D-07.

### Established Patterns
- Online path stays LLM-free; all LLM/embedding cost is offline (sleep pass) — the harness must respect this when measuring recall latency (latency = retrieval only, not answer-gen).
- Result JSON `meta` already carries `commit` + `engine_version` — extend to the D-10 config snapshot.
- Subscription-billed headless transport (`RECENSE_MODEL_PROVIDER=claude-headless` / `RECENSE_ANSWER_PROVIDER`) vs direct-API scorer (GPT-4o) — keep this split explicit in cost reporting (subscription tokens vs $ API).

### Integration Points
- New `scripts/eval/locomo-harness.cjs` (+ scorer adapter) joins the existing eval suite; results land in `scripts/eval/results/`.
- The official run consumes the v7.0-tagged engine (post-39.1-05), reading the live brain for latency (D-06a) and a LoCoMo-loaded scratch DB for accuracy + token (D-07).
</code_context>

<specifics>
## Specific Ideas

- The competitor methodology caveats are already researched and live in ROADMAP §Phase 40 (MemPalace 96.6% = raw-embedder mode → 84.2% compressed; LoCoMo R@10 88.9%; mem0 ~26% more accurate / 91% lower latency / 90% fewer tokens vs OpenAI memory; Zep/Graphiti DMR + LongMemEval; claude-mem no accuracy bench, ~10x retrieval-token claim only). Reuse these verbatim as the D-08 cited targets.
- Founder framing for the baseline write-up: every recense number reproducible from a committed script; every competitor number sourced + one-line "what it actually measures" note. No rounded-up / unsourced / methodology-misread figures.
</specifics>

<deferred>
## Deferred Ideas

- **Reproducing rival pipelines head-to-head** (run mem0 / Zep-Graphiti through the identical LOCOMO harness for true apples-to-apples) — a later stretch, gated on budget; not in Phase 40 (D-08). The most defensible upgrade once the baseline exists.
- **Per-category LoCoMo breakdown** as a first-class reported table (vs overall-only) — nice-to-have, can be added without re-running (D-09).
- **Bi-temporal validity** (Zep/Graphiti-style validity intervals) — deliberately deferred in v7.0; could nudge the LoCoMo temporal slice but is a conscious divergence, not a Phase-40 concern.

### Reviewed Todos (not folded)
None — the todo list was empty at discussion time.
</deferred>

---

*Phase: 40-competitive-benchmark-baseline*
*Context gathered: 2026-06-22*
