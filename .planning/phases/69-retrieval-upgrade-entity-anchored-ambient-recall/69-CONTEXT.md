# Phase 69: Retrieval Upgrade — Entity-Anchored Ambient Recall - Context

**Gathered:** 2026-08-03 (auto mode — decisions are the recommended defaults; this phase is unusually pre-specified by SEED-005's live-transcript audit and the roadmap's five SCs. Audit trail in 69-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

A memory-shaped prompt in any Claude Code session surfaces the facts that actually answer it — including facts reachable only by NAME rather than by topic similarity — instead of the five most cosine-similar nodes; and the agent can VERIFY what it was given instead of defaulting to grep. Grounded end-to-end in SEED-005's 1,942-turn live audit (findings F1–F5) and gated on the 58-prompt memory-shaped eval set extracted from real sessions.

Scope is exactly the roadmap's five SCs / the seed's improvements 1–4 + the eval gate. Out of phase: temporal/episodic recall (seed improvement 5 — "separate, larger track", F3); re-litigating `bm25FusionWeight=0` as-is (measured-and-closed on LoCoMo; only the NEW eval set could justify revisiting, and that is not this phase's mandate); the three shipped-dark rank knobs (measure-or-delete noted as a follow-up, not an SC); any consolidation/write-path change (retrieval is read-only); the 65-HUMAN-UAT founder items.

Hard prerequisite satisfied: Phase 64 complete — its exported union candidate generator (`src/consolidation/entity-resolution.ts`: `EntityResolver`, `EntityCandidate`, `ChannelName` — "both exported for reuse" per its own header) is the seam this phase extends to the recall path instead of building a second divergent generator (the roadmap's stated reason for placing 69 after 64).

## Derived Requirements (from SEED-005, per the roadmap's "derive during discuss" instruction)

Register these in REQUIREMENTS.md as a RECALL section with Phase-69 traceability rows (the planner's first task owns the doc edit):

- **RECALL-01**: Ambient recall reaches facts anchored by a proper noun in the prompt via **LLM-free indexed entity lookup on the hot path** — distinctive prompt tokens alias/exact-matched to entity nodes, their facts unioned with cosine top-k before ranking. The audit's "contract with vtx" class (asked twice, whiffed twice, facts present) resolves. (F2; SC1)
- **RECALL-02**: Cross-project recall is PRESERVED (resume sessions legitimately pull VTX/recense facts) but a foreign-project deep-dive doc no longer outranks own-project facts — a same-project rank NUDGE plus doc-type demotion/re-rendering (title + `recense://` link, not a truncated 200-char body), never a hard scope filter. (F1+F4; SC2; carries the D-S1 reversal below)
- **RECALL-03**: The injected block carries each fact's 1-hop relations — the edges `buildHonestOneHopTrace` already computes (AMBIENT_HOP_TOPN=6) and currently discards to the viz sink — within the existing token budget (~5 lines × 200 chars unless explicitly re-budgeted). (SC3)
- **RECALL-04**: `recense recall` gains an **evidence mode**: cited node ids + traversed edges instead of only LLM-composed prose, read-only, so a caller can verify a claim without grepping. (SC4)
- **RECALL-05**: Every change is gated on the 58-prompt eval set: no regression on the 42 currently-hit prompts; injected-line relevance improves on the whiffs (the "contract with vtx" class must surface contract facts); ambient block token budget held. `ambient_hit` labels are outcome observations, NOT ground truth — grading is by injected-line relevance. (SC5)

</domain>

<decisions>
## Implementation Decisions

### D-S1 REVERSAL — recorded deliberately, per the roadmap's explicit instruction
- **D-01:** **D-S1 ("scope is provenance, not a retrieval signal") is deliberately PARTIALLY REVERSED for the ambient ranking path.** Rationale: the live audit measured 49% of scoped injected lines as foreign-project, outscoring own-project lines (0.541 vs 0.530) — F1 is real harm on the primary surface. The reversal is bounded: scope becomes a **rank nudge** (same-project boost and/or foreign-doc demotion), NEVER a filter — cross-project recall is load-bearing (interview-prep pattern verified in the manual query log). Scope still never gates existence, only ordering. Applies to the ambient/injected path; `recense recall --scope` semantics unchanged. This paragraph is the required record; the planner must carry it into the plan and the SUMMARY must restate it.

### Entity-anchoring mechanism (RECALL-01)
- **D-02:** Candidate generation reuses **Phase 64's exported generator seam** (`EntityResolver`/channel machinery in `entity-resolution.ts`) — the roadmap's stated dependency reason. The recall path needs the GENERATOR (exact/entity-keyed ∪ BM25 ∪ dense candidates), not the confident-or-null resolver policy: recall unions candidates for ranking rather than abstaining. If the seam needs a light refactor to expose generation without resolution policy, that refactor is in scope (Phase 64's D-01 anticipated exactly this reuse); duplicating it is not.
- **D-03:** Token→entity anchoring is **LLM-free indexed lookup**: distinctive-token extraction from the prompt (capitalization/rarity heuristics, planner discretion), matched via `resolveEntityByName`'s ladder + normalization against live entity nodes; matched entities contribute their facts (entity-keyed edges/values) into the candidate pool ahead of ranking. Hook latency budget is the binding constraint — indexed reads only, measure the added latency, keep the pre-phase path reachable via a dark knob (convention).
- **D-04:** The falsified BM25-RRF fusion result stands: this is graph-native entity anchoring (a different mechanism than the LoCoMo-nulled `bm25FusionWeight`), and the phase must not silently re-enable that weight.

### Scope nudge + doc rendering (RECALL-02)
- **D-05:** Rank treatment shape (nudge magnitude, whether it's own-project-boost, foreign-doc-demotion, or both) is research/planner discretion, tuned against the eval set — but the mechanism must be a bounded ranking adjustment with a dark knob defaulting to pre-phase behavior until the eval gate passes. Doc-type nodes (`type='doc'`) render as **title + recense:// link** in the injected block (F4 — truncated hub-doc bodies are wasted tokens); non-doc facts keep value rendering.

### 1-hop injection (RECALL-03)
- **D-06:** Reuse the edges `buildHonestOneHopTrace` ALREADY computes — do not add a second edge-read pass (the 55-01 precedent explicitly rejected batching/duplication on this path). Rendering is compact (relation + neighbor label), included per-fact within the existing block budget; if budget forces a choice, facts win over hops (hops are enrichment, not replacement). Honest-trace discipline holds: only real edges, no fabrication; the viz sink keeps receiving exactly what it receives today.

### Evidence mode (RECALL-04)
- **D-07:** `recense recall` gains an evidence output (flag or mode; naming planner discretion) returning cited node ids + traversed edges (machine-readable + human-scannable), **read-only** — no strengthening, no `activation_trace` fabrication, D-43 untouched. The existing prose mode remains default for humans; evidence mode is what makes recall verifiable vs grep. The `recense://` citation vocabulary from the corpus/deep-dive layer is the id format precedent.

### Eval gating protocol (RECALL-05)
- **D-08:** **Eval-first**: before any pipeline change lands as default-on, re-run the 58-prompt set against the changed pipeline and grade injected-line relevance. Hard gates (from the seed, verbatim): "contract with vtx" class surfaces contract facts; foreign deep-dives no longer outrank own-project facts at equal-or-better relevance; zero regression on the 42 currently-hit prompts; token budget held. The eval data lives gitignored (verbatim personal prompts — NEVER commit `turn-records.jsonl`/`memory-shaped-evalset.jsonl`); scripts are committed and re-runnable. Results recorded honestly in the SUMMARY (no-inflated-metrics rule; these are founder-personal numbers, interview-defensible).
- **D-09:** All new behavior ships behind dark knobs defaulting to pre-phase behavior; enabling them live is gated on D-08 passing — mirroring the phase-65 dark-launch discipline. (Unlike 65, enablement here needs no founder data export — the eval set already exists locally — so the gate is the eval run itself, automatable, not a human checkpoint.)

### Claude's Discretion
- Distinctive-token heuristic details; nudge/demotion mechanics and magnitudes (eval-tuned); knob names; evidence-mode flag name and output format; hop-rendering format; where the generator-reuse refactor seam sits.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Seed & roadmap (this phase's spec)
- `.planning/seeds/SEED-005-retrieval-upgrade-recall-audit.md` — THE spec: F1–F5 findings, improvement priorities, eval-first requirement, constraints (all verified against live source 2026-08-01)
- `.planning/ROADMAP.md` — Phase 69 entry (5 SCs + the explicit D-S1-reversal instruction + the reuse-64's-generator dependency rationale)
- `.planning/REQUIREMENTS.md` — the planner adds the RECALL-01..05 section + traceability rows derived above

### Eval assets
- `scripts/eval/recall-audit.py`, `scripts/eval/recall-audit-evalset.py` — committed, re-runnable
- `scripts/eval/results/recall-audit/*.jsonl` — gitignored (verbatim personal prompts); regenerate locally, never commit

### Code seams (live source is source of truth)
- `src/adapter/ambient-recall.ts` — AMBIENT_K=5 (:39), AMBIENT_FLOOR=0.45 (:51), the retrieveRanked call with undefined queryText (:132 area), T-RT1-05 read-only invariant, the vizFloor/injection-floor split comment (:126-129 — do NOT add a second floor semantic)
- `src/retrieval/` + `engine.ts:542` — "flat top-k + floor + stale-entity filter" (the thing being upgraded); `retrieveCueless` spread path (exists only on SessionStart bulk today)
- `src/consolidation/entity-resolution.ts` — Phase 64's exported generator/resolver (:4 "both exported for reuse", EntityResolver :136, EntityCandidate :64, ChannelName :61)
- `src/db/semantic-store.ts` — `resolveEntityByName` (:519), entity queries, `node_scope` sidecar
- `buildHonestOneHopTrace` (retrieval layer) — the computed-then-discarded 1-hop edges (AMBIENT_HOP_TOPN=6, 55-01 decisions: private constant, kind allowlist, liveness-before-truncate)
- `src/recall/index.ts` — `RecallEngine.recall()` (the prose-only path evidence mode extends)
- `src/adapter/session-start-cli.ts` / hook wiring — where injected-block rendering lives (doc title+link rendering lands here or in ambient-recall.ts)

### Prior decisions in tension or inherited
- D-S1 (Phase 32/999.3 lineage: scope is provenance) — PARTIALLY REVERSED by D-01 above, deliberately
- 55-01 decisions (AMBIENT_HOP_TOPN privacy, kind allowlist, no batching) — inherited by D-06
- v9.0 research: reranker-over-fused-topk HURT (do not add); `bm25FusionWeight=0` honest null stands (D-04)
- STATE.md engine invariants: online paths LLM-free; graph is source of truth; D-43 non-strengthening (evidence mode read-only)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Phase 64's union generator** (entity-resolution.ts) — exported for exactly this reuse; the recall path consumes generation, not resolution policy.
- **buildHonestOneHopTrace** — the 1-hop edges are already computed per seed on the hot path; injection rendering is the only new work (near-zero new I/O).
- **`resolveEntityByName` ladder + normalizeValue** — the indexed entity-match primitive for token anchoring.
- **58-prompt eval set + scripts** — the live-distribution gate; re-runnable locally.
- **Dark-knob + eval-gate discipline** — phases 64/65/66/68 precedents.

### Established Patterns
- Hook latency is felt every session — indexed reads only, measure added latency, keep pre-phase path reachable.
- Honest-trace invariant (Phase 52 lineage): never fabricate edges; viz keeps receiving what it receives.
- Never commit the gitignored eval JSONLs (verbatim personal prompts).
- No-inflated-metrics: eval numbers recorded honestly with methodology.

### Integration Points
- `ambient-recall.ts` retrieveRanked call — where entity-anchored candidates union in and where rank nudge applies.
- Injected-block renderer — hop lines + doc title/link rendering.
- `RecallEngine.recall()` — evidence mode branch.
- REQUIREMENTS.md — RECALL section registration (planner task 1).
- Downstream: none — final roadmapped phase of the milestone-adjacent track.

</code_context>

<specifics>
## Specific Ideas

- The sharpest acceptance case, verbatim from the audit: "do you remember anything from the contract i have with vtx" — asked twice, whiffed twice, while the facts were hand-queryable. If the changed pipeline doesn't surface contract facts for that prompt, the phase failed regardless of aggregate numbers.
- Grep wins today because its output is verifiable; composed prose isn't. Evidence mode is the direct attack on the 43%-still-grepping number — optimize its output for "can the agent check this claim in one glance".
- Score compression (0.45–0.65, weak separation) means small nudges move ranks — tune against the eval set, not intuition.

</specifics>

<deferred>
## Deferred Ideas

- Temporal/episodic recall (F3: "when did X happen", episode-store search by time+entity) — seed improvement 5, explicitly a separate larger track; strong candidate for the next milestone.
- The three shipped-dark rank knobs (`rankWeightR`, `rankStrengthWeight`, `insightSurfacingEnabled`) — measure-or-delete pass; seed flags it "while in here" but it is outside the roadmap SCs; fold in ONLY if the eval harness makes it free, otherwise defer with a note.
- `bm25FusionWeight` re-evaluation on the new eval set — only with per-category no-regression gate; not this phase.
- B-02/B-03/B-04 backlog (provenance ceiling, taint propagation, hedging reliability) — own design passes.
- 65-HUMAN-UAT founder items — open, untouched.

### Reviewed Todos (not folded)
Same four keyword-noise matches as 63-68. None folded; all stay pending.

</deferred>

---

*Phase: 69-Retrieval Upgrade — Entity-Anchored Ambient Recall*
*Context gathered: 2026-08-03*
