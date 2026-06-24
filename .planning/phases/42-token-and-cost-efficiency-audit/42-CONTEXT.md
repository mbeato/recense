# Phase 42: Token / Cost Efficiency Audit - Context

**Gathered:** 2026-06-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Measure recense's token/cost profile end-to-end (per write = Haiku extract + Sonnet judge; per recall = inject), broken down **by lever**, against the frozen Phase-40 v7.0 baseline; tune the levers for a measured net token reduction with no accuracy regression; state savings vs competitors defensibly with sources; and benchmark **progressive-disclosure** retrieval against recense's schema-prior compression — adopting it only on a measured token win, else declining with the numbers.

**In scope:** per-write + per-recall token cost measured by lever vs baseline (COST-01); levers tuned to a measured net reduction with no accuracy regression (COST-02); competitor-savings claim stated with recense's reproduced number + cited competitor figure, no inflation (COST-03); progressive disclosure benchmarked vs schema-prior compression, adopted only on a measured token win (COST-04).

**Out of scope (own phases):** the vector index / hot-path latency (Phase 41); CI regression gates (Phase 43); reproducing rival pipelines head-to-head (Phase 40 deferred stretch); the user-facing settings surface for cost controls (Phase 999.1 backlog — env/config levers already suffice for customer-zero).

**Carried forward from Phase 40 (locked, not re-litigated):** baseline = the frozen v7.0-tagged commit + serialized config snapshot (D-10) and its token surface (D-07); cost-gate posture — a 1-conversation cost probe is a HARD GATE before any expensive run, and the heavy run is scheduled near a weekly reset (D-01/D-02/D-03); currency = subscription tokens with a retail-$ translation; online path stays LLM-free; no-inflated-metrics governs every reported figure.
</domain>

<decisions>
## Implementation Decisions

### Lever scope & sweep method (COST-01 / COST-02)
- **D-01:** **Greedy one-at-a-time sweep + one combined-best confirmation run.** Sweep each lever in isolation against the baseline (gives the clean per-lever token attribution COST-01 requires — "broken down by lever"), lock the best value, move to the next; then a single confirmation run at the combined best-of-each setting to catch obvious interaction regressions. No full Cartesian grid — its run count collides with the carried-over cost gate. Interactions assumed second-order.
- **D-02:** **Feature-drop decided per-lever from the measured token delta, not pre-committed.** Turning a whole feature OFF (not just tuning a threshold) is in-bounds *if* the data shows it is the dominant cost and low-value — e.g. `RECENSE_CORPUS_GEN=0` (Sonnet doc-gen, ~42s each, flagged highest-cost/most-optional in the 999.1 backlog). Measure each lever's delta first, then decide at plan/execute time which levers are tune-only vs droppable. Report any dropped feature as a lever with its own token delta.
- **D-03:** **In-bounds levers:** `consolSkipThreshold` + `consolSkipThresholdBySource` (write-side Haiku gate, config.ts:50/694), `consolSkipThresholdAssistant` (config.ts:263), `injectionTokenBudget` (recall inject, default 500, config.ts:361/758), `recallNeighborhoodBudget` (default 20, config.ts:438/767), `candidateK` (5), `RECENSE_CORPUS_GEN` / `RECENSE_CORPUS_GEN_MAX` (offline doc-gen), and the v7.0 ranking/reflection knobs. Planner/researcher pin the exact tunable set from the frozen-config snapshot.

### No-regression guardrail (COST-02)
- **D-04:** **Real accuracy run required per candidate — Phase-41's free set-equivalence gate does NOT apply** (tuning changes extraction/retrieval outputs, so top-k sets move). Gate structure: **KU replay (cached-extraction, cheap, near-$0) as the inner-loop sweep gate** + **LOCOMO (+LongMemEval-S) as the final no-regression confirm** on the best combo. This is the deliberately cheaper structure — still a real gate, not skipped.
- **D-05:** **Tolerance = within-noise band.** A tuned lever is accepted if accuracy stays within run-to-run noise of baseline (≈ ≤1pt / within the metric's CI), not strict zero-drop — lets a real token win through when the "drop" is statistical jitter. The reported result states the band.
- **D-06 (run timing — founder-directed):** **Build now / run-at-reset.** The harness, per-lever token accounting, and the LLM-free recall-inject token measurement (`injection-efficiency-harness`, $0) plus a cheap KU-replay validation are built and run **now**. The **full** eval — write-side token breakdown (sleep pass = Haiku/Sonnet subscription tokens) + the LOCOMO/LongMemEval no-regression confirm — is **deferred to a weekly-reset window**, cost-probe-gated first (Phase-40 D-01). Don't defer the *phase*; defer the *expensive run*. The KU inner-loop gate IS used for the sweep — the founder is choosing the cheaper option *now*, not skipping the test.

### Progressive disclosure (COST-04)
- **D-07 (mechanism):** **Option A — fact-index → fact-detail.** Step 1 returns compact fact hits (id + one-line gloss only); step 2 fetches full value + provenance + 1-hop neighborhood on demand. This is the literal claude-mem `search`→`get_observations` mechanism, head-to-head against recense's mechanism — the cleanest A/B and the most apples-to-apples for the COST-03 "vs claude-mem ~10x" claim. (Schema-index→member-expand was rejected as the comparison arm because schemas *are* recense's compression — using them as the progressive index conflates challenger and incumbent.)
- **D-08 (surface):** **MCP interactive pull surface only.** Progressive disclosure structurally requires an agent in the loop that can make a follow-up call and expand only what it needs; the SessionStart inject is a one-shot LLM-free push (no drill-down, already 500-token-capped), so it is NOT the surface. **Incumbent arm = recense's current one-shot bounded inject ("schema-prior compression").**
- **D-09 (prototype depth):** **Harness-only A/B first — no engine change.** Simulate the two-step token flow: `thin index payload + detail for the hits actually expanded`. Bracket the expansion policy to avoid overclaiming: an **oracle policy** (expand only the facts the gold answer needs = progressive disclosure's best case) and a **fixed top-K policy** (realistic case). Build the real MCP two-step tool (e.g. `memory_search` compact → `memory_expand` detail) **only if** the A/B shows a win.
- **D-10 (valid outcomes):** recense's inject is already budget-capped, so a **documented decline-with-numbers is a valid, expected outcome** if schema-prior compression already wins — not a failure (founder-directed, baseline-first discipline).

### Competitor-savings framing (COST-03)
- **D-11 (self-baseline):** recense's own reproduced "% savings" is measured **vs a flat full-context dump** (bounded recall vs injecting everything / the old MEMORY.md-of-everything). Matches mem0's "vs OpenAI full-context ~90%" and claude-mem's framing, and reuses the scaling curve the `injection-efficiency-harness` already computes (flat-file-of-everything vs bounded inject). Most apples-to-apples with the cited competitor numbers.
- **D-12 (headline axis):** **Recall-side savings is the headline** (the axis competitors actually report — mem0 ~90%, claude-mem ~10x are both recall-side, so the comparison is honest). recense's **write-side (pay-at-sleep) cost is reported separately** as an amortized cost + the breakeven session count (`cost-benefit-harness`). **Never net write and recall into one flattering number** — no-inflated-metrics.

### Claude's Discretion (planner / researcher resolve)
- Exact tunable lever set + per-lever sweep ranges — pin from the frozen v7.0 config snapshot (D-03).
- Exact noise-band threshold — measure baseline run-to-run variance if cheap; else apply the ≤1pt / CI heuristic (D-05).
- Token-accounting boundaries per write/recall — reuse the existing write-ledger / `usage.per_model` shapes (`cost-benefit-probe.json`, `cost-std-*.json`).
- Harness simulation fidelity for the progressive-disclosure A/B — oracle + fixed-top-K policies, gloss-token sizing (D-09).
- Whether the cheap KU-replay validation runs before or alongside the deferred reset-window run.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition & milestone discipline
- `.planning/ROADMAP.md` §"Phase 42: Token / Cost Efficiency Audit" — goal, COST-01/02/03/04, success criteria, the progressive-disclosure-evaluation directive (founder 2026-06-20), competitor figures (mem0 ~90%, claude-mem ~10x) with methodology caveats.
- `.planning/ROADMAP.md` §"Phase Details — v8.0 Performance, Efficiency & Competitive Parity" — engine invariants (online LLM-free; graph source of truth, vector derived; no accuracy regression for a token win), baseline-first discipline, dependency shape 40 → {41,42} → 43 (42 independent of 41).
- `.planning/phases/40-competitive-benchmark-baseline/40-CONTEXT.md` — the baseline this phase measures against: D-07 (token surface measured on the reproducible LoCoMo corpus), D-10 (frozen v7.0 commit + serialized config snapshot), D-01/02/03 (cost-probe gate + run-near-reset posture carried forward verbatim), D-08 (cited competitor methodology notes for COST-03).
- `.planning/phases/41-vector-index-and-hot-path-latency/41-CONTEXT.md` — sibling perf phase; D-10 explains why Phase-41's set-equivalence accuracy trick does NOT carry to Phase 42 (this phase's tuning moves outputs, so a real accuracy run is needed — D-04).

### Existing harnesses & cost-accounting infra (reuse)
- `scripts/eval/cost-benefit-harness.cjs` — EVAL-04 write-ledger (per-call Haiku/Sonnet `usage` via headless sink, VACUUM-INTO scratch DB) + breakeven combiner. Primary write-side token measurement + the breakeven number for D-12.
- `scripts/eval/injection-efficiency-harness.cjs` — EVAL-03 recall-inject measurement: $0/LLM-free, spawns real `session-start-cli`, computes the flat-file-of-everything-vs-bounded scaling curve (the D-11 self-baseline) + belief-correction count. Runnable now (D-06).
- `scripts/eval/locomo-harness.cjs` + `scripts/eval/locomo-scorer.cjs` + `scripts/eval/locomo10.json` — LOCOMO end-to-end (built in Phase 40); the final accuracy-confirm arm (D-04, deferred per D-06).
- `scripts/eval/replay-ku-harness.cjs` — KU replay (cached-extraction, cheap); the inner-loop accuracy gate for the sweep (D-04).
- `scripts/eval/longmemeval-harness.cjs` + `scripts/eval/longmemeval-s.jsonl` (500 Q) — LongMemEval end-to-end, the broader accuracy-confirm arm (D-04).
- `scripts/eval/results/cost-benefit-probe.json` — measured ~1,470 Haiku tokens/episode extraction (write-ledger format to reuse).
- `scripts/eval/results/cost-std-baseline.json` / `cost-std-twotier.json` — per-model `usage.per_model` reporting shape to mirror.
- `scripts/eval/results/` — Phase-40 baseline result JSONs (the comparison anchor for COST-01/02).
- `scripts/eval/README.md` — harness conventions (NODE_PATH, provider overlays, dry-run).

### Engine config / levers / billing
- `src/lib/config.ts` — `DEFAULT_CONFIG` and the tunable knobs: `consolSkipThreshold` (741), `consolSkipThresholdBySource` (50/694), `consolSkipThresholdAssistant` (263/742), `injectionTokenBudget` (361/758), `recallNeighborhoodBudget` (438/767), `candidateK` (236/739), `recallSidewaysHopBudget` (775). The frozen-config snapshot (Phase-40 D-10) is the source of truth for the in-bounds set.
- `src/adapter/session-start-cli.ts` — the recall-inject surface measured by `injection-efficiency-harness`; the incumbent's push side.
- MCP surface (`brain mcp`: `memory_search` / `memory_ask`, from Phase 11) — where the progressive-disclosure pull arm lives (D-08) and the real two-step tool would be built only on a win (D-09).
- `CLAUDE.md` (project) §Constraints — sleep-pass model stack (extract=headless Haiku, judge=headless Sonnet via `claude -p` on Max subscription), `consolSkipThreshold` gating, config location, subscription-billing framing (`--output-format json` reports per-call `usage`/`total_cost_usd`), retail-$ translation.

### Competitor targets (COST-03 — cite, do not reproduce)
- `.planning/ROADMAP.md` §Phase 40 — researched competitor numbers + methodology caveats (mem0 ~90% fewer tokens vs OpenAI full-context memory; claude-mem ~10x retrieval-token via progressive disclosure; MemPalace L0→L3). Reuse verbatim with the one-line "what it measures" notes (Phase-40 D-08).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `cost-benefit-harness.cjs`: real write-side token ledger over a scratch DB + breakeven combiner — the COST-01 write-side measurement and D-12 breakeven, already built.
- `injection-efficiency-harness.cjs`: LLM-free recall-inject measurement + the flat-file-vs-bounded scaling curve — directly the D-11 self-baseline; runnable now, no reset window needed.
- `replay-ku-harness.cjs` / `locomo-harness.cjs` / `longmemeval-harness.cjs`: the accuracy gates (KU inner-loop, LOCOMO/LongMemEval confirm) — D-04.
- `cost-benefit-probe.json` write-ledger + `cost-std-*.json` `usage.per_model` shapes: the token-accounting formats to extend for per-lever breakdown.

### Established Patterns
- Online path LLM-free; all LLM/embedding cost offline (sleep pass). Recall-inject token measurement is therefore $0 and runnable anytime; write-side token measurement requires the sleep pass and is the part that costs subscription tokens (deferred per D-06).
- Subscription-billed headless transport vs direct-API scorer ($) split must stay explicit in cost reporting (subscription tokens vs API $).
- Result JSON `meta` carries `commit` + `engine_version` + the Phase-40 config snapshot — extend with the per-lever setting under test.
- Cost-probe gate before any expensive run; schedule the heavy run near a weekly reset (Phase-40 D-01/03, reaffirmed founder 2026-06-24).

### Integration Points
- The lever-sweep harness wraps the existing cost + accuracy harnesses, varying one config knob per run; results land in `scripts/eval/results/`.
- The progressive-disclosure A/B is a new harness arm (simulated two-step token flow); a real `memory_*` MCP tool change is built only if the A/B wins (D-09).

</code_context>

<specifics>
## Specific Ideas

- The progressive-disclosure A/B is framed as a clean challenger-vs-incumbent contrast: claude-mem's literal fact-index→detail mechanism (challenger) vs recense's current one-shot bounded inject (incumbent). Brackets: oracle expansion (best case) + fixed top-K (realistic). A documented decline-with-numbers is an accepted outcome.
- Competitor-comparison hygiene (founder): every recense figure reproducible from a committed script; every competitor figure sourced with a one-line "what it actually measures" note; recall and write costs never netted into one number.
- Founder run-timing steer (2026-06-24): build + cheap KU validation now; defer the full/expensive eval confirm + write-side sleep-pass run to a cost-probe-gated weekly-reset window. "Not a full eval run again — must defer," but the inner-loop gate is still used.

</specifics>

<deferred>
## Deferred Ideas

- **Schema-as-index hybrid** (progressive disclosure where step-1 returns recense's *schema* layer as the index, step-2 expands to member facts) — the natural follow-on experiment IF Option A shows progressive disclosure has real legs. Out of this phase to keep the A/B's challenger-vs-incumbent contrast clean (D-07).
- **Corpus-doc → doc-body progressive disclosure** (MemPalace L0→L3 over the existing Reader corpus) — wrong granularity for the QA harnesses (a doc is a coarse unit); better for browse than the token-on-QA axis. Possible future browse-surface optimization.
- **Building the real MCP two-step tool** (`memory_search` compact → `memory_expand` detail) — only if the D-09 harness A/B shows a win; otherwise it's dead code (D-09/D-10).
- **User-facing cost-control settings surface** — Phase 999.1 backlog (the levers exist as env/config; the gap is a settings UI, a productization concern, not a v8.0 perf item).
- **Reproducing rival pipelines head-to-head** on the token axis — Phase-40 deferred stretch; the most defensible COST-03 upgrade once the baseline exists, but out of scope here (cite-don't-reproduce).

### Reviewed Todos (not folded)
None — no pending todos matched this phase at discussion time.

</deferred>

---

*Phase: 42-token-and-cost-efficiency-audit*
*Context gathered: 2026-06-24*
