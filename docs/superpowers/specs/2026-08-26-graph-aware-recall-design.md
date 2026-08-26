# Graph-Aware Recall: Activation-First Retrieval Core

**Date:** 2026-08-26
**Status:** Draft for review
**Scope:** Retrieval core (`src/retrieval/`), explicit recall (`src/recall/`), ambient rendering (`src/adapter/ambient-recall.ts`), sleep-pass learning (Phases 5–6), eval harness (`src/eval/`).

## 1. Problem

Recense's graph is decoration at query time. The ambient block (SessionStart / UserPromptSubmit) is hybrid BM25+cosine plus a small entity-anchor channel; its `↳` hop lines are rendered from real edges but never influence retrieval. `recense recall`'s typed-predicate branch is capped at a single hop, and its schema-neighborhood fallback takes exactly one non-recursive sideways hop. The existing spreading-activation code (`retrieveCueless`, `src/retrieval/engine.ts:270-297`) runs only cue-less at SessionStart, walks out-edges only, and multiplies by raw edge weights that all sit at the schema default (`w = 0.1` on every one of the 19,603 relation edges — nothing ever strengthens them).

Current graph scale: ~29k live nodes (18.2k facts, 9.8k entities, 794 schemas, 166 docs, 68 insights), ~29.7k edges, mean out-degree 2.7, max 272. `extends` is 83% of typed relation edges.

Four target behaviors (user-set success bar):

1. **Associative surfacing** — facts not textually similar to the query but connected through edges appear in results.
2. **Explained connections** — surfaced results carry the real path that justifies them.
3. **Smarter ranking** — structurally central, well-connected facts outrank isolated trivia.
4. **Cross-cluster insights** — non-obvious links between separate graph regions get synthesized (write-time, surfaced at query time).

Both surfaces share one new core; ambient keeps its hard constraints (LLM-free, one embed, ~2.5s, fail-open).

## 2. Research grounding

Two independent research passes (Fable web-research agent; GPT-5.6 Sol via codex, adversarial mandate) converged on the same architecture and the same corrections. Load-bearing findings:

- **HippoRAG 2 (ICML 2025, arXiv:2502.14802)** is the strongest published associative-memory retriever: Personalized PageRank over a fact graph, seeded by query-to-triple matching, blended with dense retrieval. Its ablations dictate several choices below (query-to-triple seeding +12.5 recall@5; passage/doc nodes in the walk at ~0.05 weight +6; mid-retrieval LLM filter worth only ~0.7 — skip it).
- **Capped spreading activation with row-normalized transfer ≈ truncated PPR** (direct-comparison literature: Springer 978-3-319-12979-2_11). With the normalization fix, our design inherits PPR's known-good behavior while keeping per-relation control and path provenance — which PPR alone cannot produce, and which is our differentiator.
- **ACT-R fan effect**: associative strength `S − ln(fan)` exponentiates to multiplicative `1/fan` — full weighted-degree normalization, not `1/√degree`. Both researchers rejected the draft's `1/√degree` independently (mass conservation; ACT-R fidelity).
- **Validation-gated Hebbian learning (Kairos, NeurIPS 2025 wkshp; HeLa-Mem, arXiv:2604.16839)**: strengthening edges because retrieval surfaced them is a rich-get-richer feedback loop; the named fix is gating on validated use, saturating bounded updates, and decay of the learned bonus toward a structural prior.
- **Known graph-method regression**: HippoRAG 1 and GraphRAG both *lose* to dense retrieval on single-hop factual queries. The eval must include a single-hop regression set, and doc nodes participate in the walk at low weight specifically to hedge this.
- **Eval-first**: both reports' #1 recommendation. MuSiQue-style composed bridge probes (not HotpotQA-style — ~35% of those are solvable by type matching alone); retrieval-recall metrics, not just answer quality; graph-off ablation every run.

## 3. Design

### 3.1 Activation core — truncated personalized PageRank with provenance

New module `src/retrieval/activation.ts`. Pure, read-only, LLM-free. Fail-open at every call site.

**Input:** seed map `nodeId → seedMass` (see 3.2), config, batched edge reader.
**Output:** `Map<nodeId, { activation: number, paths: ContributionPath[], hopDepth: number }>` where `ContributionPath` is one of the top-m contributing paths (m = 3 default): an ordered list of `{ src, rel, dst, kind }` steps back to a seed. Not a single backpointer — additive evidence from converging paths must be representable (both research passes flagged single-backpointer as misrepresentation).

**Propagation (per hop, h = 1..H; H = 2 ambient, 3 explicit recall):**

```
transfer(u→v) = a(u) × damping × relWeight(rel, kind, direction) × w(u,v) / outMass(u)
outMass(u)    = Σ over u's ELIGIBLE edges of relWeight × w      (row normalization = 1/weighted-fan)
```

- `damping = 0.5` (HippoRAG's tuned value; geometric mass decay makes effective depth ~2–3 hops).
- Row normalization conserves mass: a degree-272 hub emits the same total mass as a degree-2 node. The normalization exponent is a config knob (`spreadFanExponent`, default 1.0) for ablation only.
- **Additive accumulation** across seeds and paths — convergent evidence compounds.
- **ε-residual stop** (`spreadActivationFloor`, default 0.02 of normalized seed mass): transfers below ε are dropped; a hop with no surviving transfers terminates the walk early. Frontier cap (`spreadFrontierCap`, 64/hop, pruned **after** per-hop aggregation) is a safety bound, not the primary control.
- **Cycle handling:** per-path visited set; a node may accumulate from multiple distinct paths but a single path never revisits a node.
- **Determinism:** stable id-asc tiebreaks everywhere (house convention).

**Edge eligibility policy — enforced at every hop, not just at seeding.** Per-kind table (config `spreadRelWeights`, defaults):

| kind / rel | fwd | rev | notes |
|---|---|---|---|
| `relation` (typed preds: `depends_on`, `uses`, `runs_on`, …) | 1.0 | 0.8 | association is near-symmetric; direction slightly favored |
| `relation` / `extends` | 0.7 | 0.5 | elaboration chains; 83% of typed edges — must not dominate |
| `abstracts` (member→schema) | 0.8 | 0.8 | two hops through a schema = sibling facts; a major associative channel |
| `derived_from` (insight provenance) | 0.9 | 0.6 | how insights surface |
| `schema_rel` | 0.6 | 0.6 | stored undirected |
| `cites` | 0.4 | 0.2 | |
| `doc_link` / `doc_reference` | 0.3 | 0.3 | doc graph participates weakly |
| `doc_containment` | 0.0 | 0.0 | excluded from propagation entirely |

Liveness (`tombstoned = 0`), stale-entity (B2 discipline), scope, and origin checks apply to every traversed node at every hop — the same guards `retrieveRanked` applies to its candidates today. Nothing is exempted by arriving via the graph.

**Execution shape:** app-side batched frontier. One prepared statement per hop over the whole frontier (`WHERE src IN (json_each(?)) OR dst IN (json_each(?))`, joined against live nodes; `idx_edge_dst` exists), accumulation and provenance in TS Maps. No recursive CTEs in the ranker (both reports: multi-path accumulation + per-hop pruning is awkward and explosion-prone in CTEs). No per-node N+1 loops. Precompute/caches: per-node weighted out-mass may be cached in memory at startup or computed per-frontier batch; decide at implementation time by measurement, not upfront.

**Budget:** 2–3 SQL round trips, tens of ms worst case at current scale; work is bounded by ε + caps, independent of graph size (the answer to the known ~50k-memory degradation concern). Wrapped in try/catch; on any failure both surfaces return exactly today's hybrid-only results.

### 3.2 Seeding

- Seeds = existing hybrid BM25+cosine results over node values. Fact nodes are triple-shaped, so this is already on the right side of HippoRAG 2's decisive query-to-triple ablation; no NER/entity-linking stage is introduced.
- **Seed mass normalization** (ACT-R `W_j = W/n`): total seed budget 1.0 split across seeds proportional to hybrid match score. Queries with many seeds must not out-activate queries with few.
- **Node specificity multiplier**: seed mass × `1/max(1, supportCount)` where supportCount = number of supporting episodes (`consolidation_event` rows). IDF analog; stops generic hub entities dominating the reset distribution. Precomputed per query via one grouped statement.
- **Doc nodes** enter the seed set at `0.05 ×` their match score (HippoRAG 2's dense–sparse integration; hedges the single-hop regression).

### 3.3 Fusion and result channels

- **RRF (Reciprocal Rank Fusion)** between the hybrid ranking and the activation ranking (`k = 60` standard), replacing the draft's raw weighted score sum — activation and cosine/RRF scores are not commensurate. A weighted-sum blend stays available behind `spreadFusionMode: 'rrf' | 'weighted'` for ablation.
- **Associative channel**: nodes with activation but no text-similarity qualify as a third candidate channel, following the exact pattern `anchoredIds` established in `retrieveRanked` (floor-exempt — they cleared a different bar — but never tombstone/stale/scope-exempt). Capped at `assocSlotCap` (default 2) of the 5 ambient slots so association never crowds out direct hits.
- `spreadHops = 0` reproduces current behavior byte-for-byte. Dark-launchable; ships dark until eval says otherwise.
- `retrieve()` and `retrieveCueless()` are not modified (D-29). New method alongside them; `retrieveRanked` callers opt in via options.

### 3.4 Surface integration

- **Ambient block** (`ambient-recall.ts`): associative-channel facts render their strongest real path compactly — `↳ via <label> —runs_on→ <label>` — replacing decorative hops with true provenance. Activation values are real numbers and may be rendered (WR-02 satisfied: never a fabricated magnitude). Char budgets and `AMBIENT_K` unchanged.
- **`recense recall`** (`src/recall/index.ts`): the schema-neighborhood fallback branch is replaced by the activation core; the typed-predicate branch stays untouched (precision instrument; its multi-hop generalization stays deferred). Top-m paths go to composition as evidence triples through the existing `--evidence` machinery, which already re-verifies every `(src, rel, dst)` against real edge rows. The compose prompt gains a "connections" section so answers state *why* results relate. The never-write invariant (no upsert/strengthen/tombstone from recall) is unchanged.
- **Viz**: trace payload already carries `{seeds, hops}` with a `hop` field that never exceeds 1 today. The core emits real multi-hop traces (hop = 1..H) through the existing `ActivationTraceSink` seam; `trace.js` renders them with its existing envelope logic. Near-zero frontend work. D-97 hot-path guard (SessionStart hard-wired to Noop sink) unchanged.

### 3.5 Usage learning — validation-gated, shadow-first (Phase 5)

Every relation edge sits at `w = 0.1`; the graph never learns which connections matter. Fix on the write side, preserving recall's read-only invariant:

- **Separate overlay**: `w_usage REAL NOT NULL DEFAULT 0` column on `edge`, apart from the semantic/structural `w`. Query-time `w_effective = w + w_usage`. Truth and popularity are never conflated in one number.
- **Gate on validated use, not exposure** (Kairos): the initial signal is *facts cited in a composed `recense recall` answer* — `--evidence` already verifies the triples. Ambient surfacing alone never strengthens (it is the ranker's own bias). Additional outcome signals (user acted on it, explicit confirmation) can be added later.
- **Update rule**: saturating (`ln(1+uses)`-shaped or asymptotic), hard cap, per-session dedup (repeat queries in one session count once), applied during the sleep pass from the existing `surfaced_event` table, extended with an outcome flag (exposure vs validated-use) — never at query time.
- **Decay**: `w_usage` decays toward zero (the structural prior is the floor — a real typed relation is never erased by disuse), slower than node-strength decay (ACT-R does not decay associative strengths at all; Graphiti substitutes contradiction-driven invalidation).
- **Shadow mode first**: log the updates and compare would-be rankings offline against the eval suite; `w_usage` affects live ranking only after a chronologically split eval (train-period reinforcement, test-period queries) shows no popularity entrenchment regression.
- Exposures *and* outcomes are logged so counterfactual evaluation stays possible.

### 3.6 Cross-cluster insights — candidate discovery, validated promotion (Phase 6)

Write-time, in the sleep pass; query-time synthesis would violate the ambient budget.

- **Bridge detector**: flags nodes whose neighborhoods span ≥2 schemas/scopes that are otherwise weakly interconnected. Topology produces *candidates only*.
- **Promotion pipeline**: an insight node is minted only after semantic validation (LLM judges the connection real and non-trivial), novelty check (not already an insight/schema_rel), contradiction check, and provenance capture (`derived_from` edges to both sides). Because `derived_from` conducts activation (0.9), promoted insights surface through the recall core with no further work.
- **Precondition**: measure the existing insight reflector's output quality first (Sol's finding — don't build a second generator before evaluating the first).
- Deliberately last-phased.

## 4. Configuration

New knobs in `src/lib/config.ts`, all defaulted, all documented in-place: `spreadHops` (ambient 2 / recall 3; 0 = off), `spreadDamping` (0.5), `spreadActivationFloor` (0.02), `spreadFrontierCap` (64), `spreadFanExponent` (1.0), `spreadRelWeights` (table above), `spreadFusionMode` ('rrf'), `assocSlotCap` (2), `spreadPathsPerNode` (3), `docSeedWeight` (0.05); Phase 5 adds `usageGate`, `usageIncrement`, `usageCap`, `usageDecayLambda`, `usageShadowMode` (true).

## 5. Testing & evaluation

**Phase 1 deliverable — the eval suite comes before any ranking change** (both research passes, top recommendation):

- **Bridge probes over recense's own corpus**, MuSiQue-style: real 2–3-edge evidence paths where the terminal fact has low lexical/cosine similarity to the query, the first anchor is retrievable, and no shortcut edge exists. Gold = seeds, bridge nodes, terminal evidence, acceptable path variants. Distractors: hubs, stale facts, scope conflicts, duplicate entities.
- **Single-hop factual regression set** — catches the documented graph-hurts-easy-queries failure mode.
- **Abstention probes** — unanswerable queries; an engine that confidently surfaces plausible-but-wrong paths is worse than one that returns nothing.
- **Modes**: oracle-seed (propagation quality in isolation) and end-to-end (seeding + propagation).
- **Metrics**: seed recall, supporting-evidence recall@k, bridge-node/valid-path recall, path-provenance correctness, MRR/nDCG, context tokens, nodes/edges expanded, p50/p95 latency. Retrieval-recall is primary; answer quality secondary (it confounds the composing LLM with the engine).
- **Ablation arms under matched candidate/token budgets**: pure cosine, hybrid (today), typed traversal, 2-hop, 3-hop, exact PPR. Graph-off ablation reported on every run.
- Runs through the existing eval harness (`src/eval/`, `eval_snapshot`, queries-37 precedent).

**Unit/invariant tests** (repo style, deterministic fixture graph on the mock store): activation math incl. row normalization and mass conservation, ε-stop, per-kind eligibility and direction weights, cycle handling, top-m path provenance correctness, additive convergence, determinism, zero-writes-during-recall invariant, `spreadHops=0` byte-identity.

**Exact-PPR oracle test**: offline exact PPR (sparse power iteration; milliseconds at this scale) asserts the truncated production pass stays within overlap@10 on fixture and snapshot graphs — divergence flags over-truncation or a weighting bug.

**Latency benchmark**: synthetic 50k-edge graph; spread pass budget < 50ms.

## 6. Phasing

1. **Eval suite** (bridge probes, regression set, abstention, harness arms). Baseline numbers recorded.
2. **Activation core** + config + unit/oracle tests + ambient integration behind `spreadHops` flag; tune against eval; flip on when it beats baseline without single-hop regression.
3. **`recense recall` integration** — fallback replacement, evidence paths, connections section in composition.
4. **Rendering** — ambient via-paths; multi-hop viz traces.
5. **Usage learning** — exposure/outcome logging, shadow mode, chronological eval, then live.
6. **Bridge-insight candidates + validated promotion** (after measuring the existing reflector).

Each phase lands independently; the system is never in a broken intermediate state.

## 7. Non-goals / deferred

- No query-time LLM calls in the ambient path; no mid-retrieval LLM filters anywhere (HippoRAG 2 ablation: ~0.7 recall — not worth it).
- No modification of `retrieve()`, `retrieveCueless()` (D-29), or typed-traversal internals; typed multi-hop stays deferred.
- No edge embeddings; no community-summary (GraphRAG-style) global search — schema/insight nodes already play that role.
- **Deferred to future work**: bi-temporal contradiction invalidation (Graphiti-style `t_valid`/`t_invalid` — a real gap, but an orthogonal subsystem); Kairos-style emergent edge creation from repeated validated co-activation; power-law base-level activation as an alternative to exponential node decay.
