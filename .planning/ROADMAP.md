# Roadmap: brain-memory (recense)

## Milestones

- ✅ **v1.0 Core learning loop** — Phases 1–8 (shipped 2026-06-09) — full detail: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Open-Source Release** — Phases 9–10 (shipped 2026-06-10) — full detail: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0 Interface Layer** — Phases 11–17 (shipped 2026-06-13)
- ✅ **v3.1 Schema Depth & Brain-Window Polish** — Phases 18–19 (shipped 2026-06-15)
- ✅ **v4.0 Proactive Memory** — Phases 20–23 (shipped 2026-06-17) — full detail: [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)
- ✅ **v5.0 Foundational Memory Store + Reader Layer** — Phases 24–28 (shipped 2026-06-19) — full detail: [milestones/v5.0-ROADMAP.md](milestones/v5.0-ROADMAP.md)
- ✅ **v6.0 Project Onboarding** — Phases 29–34 (shipped 2026-06-22) — full detail: [milestones/v6.0-ROADMAP.md](milestones/v6.0-ROADMAP.md). Agentic project survey → episodes → consolidation, generalized doc ingest, idempotent re-ingest, scoped recall + auto-corpus; plus folded-in standalone phases: synchronous curated write (`recense remember`, Phase 33) and cross-surface visual polish (Phase 34).
- 🔲 **v7.0 Retrieval & Reasoning Depth** — Phases 35–39 (IN PROGRESS — 35, 36-spike, **37 COMPLETE** (37-04 typed-edges precision gate cleared GO: typed top-3 83.3% / lift +45.8pts / payload 3.8 vs 20 nodes), 38, 38.1, 39 done) — recency/strength-weighted ranking, spike-gated typed predicate edges, stored reflections, reader wiki-parity (index + backlinks). Bi-temporal validity and markdown-export both explicitly deferred.
- 🔲 **v8.0 Performance, Efficiency & Competitive Parity** — Phases 40–43 (planned, starts after v7.0) — prove at-or-above competitors (mem0/Zep) on accuracy + latency + token via LOCOMO baseline, build the vector index (kill brute-force cosine at 7000+ nodes), token-cost audit, then lock it all behind regression gates. Hard rule: every competitive number reproducible or cited — no inflated metrics.

## Phases

<details>
<summary>✅ v1.0 Core learning loop (Phases 1–8) — SHIPPED 2026-06-09</summary>

- [x] Phase 1: Substrate (4/4 plans) — completed 2026-06-05
- [x] Phase 2: Consolidation & Update Core (3/3 plans) — completed 2026-06-05
- [x] Phase 3: Retrieval & Thin Adapter (4/4 plans) — completed 2026-06-06
- [x] Phase 4: Learning Layer (4/4 plans) — completed 2026-06-06
- [x] Phase 5: Level-3 Seams (5/5 plans) — completed 2026-06-08
- [x] Phase 6: Multi-channel Ingestion (7/7 plans) — completed 2026-06-08
- [x] Phase 7: Conversational Access Surface — Telegram (5/5 plans) — completed 2026-06-09
- [x] Phase 8: Self-host Hardening — wire+lock seeder, de-hardcode paths (3/3 plans) — completed 2026-06-09

</details>

<details>
<summary>✅ v2.0 Open-Source Release (Phases 9–10) — SHIPPED 2026-06-10</summary>

- [x] Phase 9: OSS Floor (9/9 plans) — completed 2026-06-09
- [x] Phase 10: Brain-Activation Visualization (5/5 plans) — completed 2026-06-10

Full phase details: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)

</details>

<details>
<summary>✅ v3.0 Interface Layer (Phases 11–17) — SHIPPED 2026-06-13</summary>

- [x] **Phase 11: stdio MCP Server** — Local MCP clients reach brain-memory via `brain mcp` with zero deployment (completed 2026-06-10)
- [x] **Phase 12: HTTP Serving Mode** — Remote consumers reach the same engine over HTTP with auth on by default (completed 2026-06-11)
- [x] **Phase 13: Reference Client Extraction** — Telegram responder moves onto the public interface, proving the agent-outside pattern (completed 2026-06-11)
- [x] **Phase 14: Benchmark, Eval & Positioning** — Published numbers + "memory that stays correct" README frame (completed 2026-06-13)
- [x] **Phase 15: Viz UI Modernization** — Fable 5 re-review of the Opus-built viz UI: cleaner, more modern, more optimized (completed 2026-06-12)
- [x] **Phase 16: Brain Viz Tray App** — Always-accessible tray app showing live pathway activation while you work (completed 2026-06-12)
- [x] **Phase 17: LongMemEval Gap Closure** — Retrieval-first attribution + targeted levers recovered 12/18 failures; all 5 criteria pass (completed 2026-06-13)

</details>

<details>
<summary>✅ v3.1 Schema Depth & Brain-Window Polish (Phases 18–19) — SHIPPED 2026-06-15</summary>

- [x] **Phase 18: Schema Relations Engine** — Sleep pass derives schema-schema edges and hierarchical clusters; recall traverses them sideways, all D-37-safe (completed 2026-06-13)
- [x] **Phase 19: Brain Window Polish** — In-app node search + topic-region highlighting + clean hull from all viewing angles (completed 2026-06-14)

</details>

<details>
<summary>✅ v4.0 Proactive Memory (Phases 20–23) — SHIPPED 2026-06-17</summary>

Full detail archived to [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)

- [x] **Phase 20: Temporal Ingestion Foundation** — node_temporal schema, Google Calendar SourceAdapter, Gmail episodic-variant, multi-account OAuth (completed 2026-06-16)
- [x] **Phase 21: Engine Surfacing API** — LLM-free GET /v1/surface composite ranking, POST /v1/surface/seen, D-43 self-confirmation sentinel (completed 2026-06-16)
- [x] **Phase 22: Notify-Only Proactive Push** — Telegram P0/P1 push, restart-surviving dedup, default-OFF off-switch (completed 2026-06-16)
- [x] **Phase 23: Approval-Gated Any-MCP Execution** — propose→approve via Telegram, execute against any user-configured MCP server behind a hard approval gate + injection hardening (completed 2026-06-17)

</details>

### v5.0 Foundational Memory Store + Reader Layer (Phases 24–28) — SHIPPED 2026-06-19

> Archived: full detail in [milestones/v5.0-ROADMAP.md](milestones/v5.0-ROADMAP.md). Phase 28 (Schema-Anchored Corpus) was added in-milestone and supersedes READER-04. The expanded phase detail below is retained as history.

recense becomes the single source of truth for the founder's knowledge. Dependency chain: 24 → 25 → 26 → 27. Phase 24's clean-consolidation gate (SCOPE-01) unblocks all downstream phases. Phase 27 depends on 24 (scope), 25 (clean entities for gather), and 26 (semantic gather breadth).

**Engine invariants across all phases:** single-tenant; graph is source of truth, vector is derived cache; never delete an evidence-backed fact via decay; surfacing/inference never strengthens a belief (D-43); online paths stay LLM-free; agents live outside the engine.

- [x] **Phase 24: Foundational Store** — verify the already-landed engine layer + import-memory CLI: confirm FK-free consolidation, re-enable the hourly agent, then run the human-gated consolidate→verify→retire migration (completed 2026-06-18; recorded in 999.3-MIGRATION.md)
- [x] **Phase 25: Entity Dedup / Prune** — repeatable consolidation pass merges near-duplicate entities into canonical nodes, rewiring edges and tombstoning duplicates without losing provenance (completed 2026-06-18)
- [x] **Phase 26: Belief-Correction / Duplicate-Fact Fix** (re-scoped 2026-06-18) — RETR-01 diagnosis localized the symptom to the consolidation judge + PE-resistance routing (NOT the embedder/cosine); fix that path + a fact-level dedup pass, validated on the reused replay harness (completed 2026-06-18)
- [x] **Phase 27: Reader Layer** — productize the validated reader slice: doc-as-node generation with inline citations, /doc route + Reader/Brain toggle, staleness/regen, doc→doc corpus graph (completed 2026-06-18)

## Phase Details — v5.0 Foundational Memory Store + Reader Layer

### Phase 24: Foundational Store

**Goal**: The engine layer and import-memory CLI that already landed on main are verified working — a clean FK-free consolidation pass completes and the hourly agent is re-enabled — then the human-gated consolidate→verify→retire migration brings the founder's MEMORY.md facts into recense under correct scope provenance
**Depends on**: Phase 23 (complete); FK consolidation bug root-cause-fixed in code (ab3b6c8 + schema-relations FK fix) — this phase verifies that fix end-to-end
**Requirements**: SCOPE-01, SCOPE-02, SCOPE-03, SCOPE-04
**Success Criteria** (what must be TRUE):

  1. A manual sleep pass completes without a FK error, clears the dirty sentinel, and the hourly launchd sleep-pass agent is re-enabled and survives a cycle — SCOPE-01 gate satisfied
  2. Consolidated facts carry `[scope]` attribution in recall output reflecting the project they originated from; facts from multi-project or personal cwd appear as `[global]` — SCOPE-02 verified live
  3. `recense import-memory --dry-run` shows ≥193 facts to import and 0 policy-bundle leaks; a real run lands all importable facts as episodes without touching source files — SCOPE-03 verified
  4. After running `recense sleep-pass`, at least 3 imported facts per project across at least 3 projects are retrievable via `recense recall` with the correct `[scope]` prefix; a written verification report exists; source files are archived only after the founder sign-off — SCOPE-04 (D-S7 migration complete)

**Plans**: 3 plans

- [x] 24-01-PLAN.md — verify FK-free clean sleep pass + live [scope] attribution, re-enable hourly agent (SCOPE-01/02 gate)
- [x] 24-02-PLAN.md — import-memory --dry-run gate check: ≥193 facts, 0 policy-bundle leaks (SCOPE-03)
- [x] 24-03-PLAN.md — human-gated real import + sleep pass, recall verification, migration report, founder-gated source retirement (SCOPE-04)

### Phase 25: Entity Dedup / Prune

**Goal**: The entity layer is cleaned up — near-duplicate entity nodes (e.g. the 8+ "brain-memory" fragments surfaced by the reader slice) are merged into canonical nodes via a repeatable, origin-guarded consolidation pass, so retrieval and doc generation are no longer muddied by fragments
**Depends on**: Phase 24 (`node_scope` live and consolidation stable — scope-aware merging requires clean scope attribution)
**Requirements**: DEDUP-01, DEDUP-02, DEDUP-03
**Success Criteria** (what must be TRUE):

  1. Running the dedup pass against the live DB produces a canonical entity node for each near-duplicate cluster (matched by value similarity + embedding cosine above threshold); the pass is repeatable and produces the same result on a second run — DEDUP-01
  2. After the pass, the canonical node carries all edges that previously pointed to any duplicate; duplicates are tombstoned, not deleted; `PRAGMA foreign_key_check` returns empty; evidence-backed provenance is preserved for every merged node — DEDUP-02
  3. The distinct entity count for "brain-memory" (currently 8+ fragments) drops to 1 canonical node with no observable regression to recall accuracy on a sample query set — DEDUP-03

**Plans**: 3 plans

- [x] 25-01-PLAN.md — core entity-dedup engine: clustering, canonical selection, FK-safe edge rewire, tombstone, provenance + unit tests (DEDUP-01/02)
- [x] 25-02-PLAN.md — opt-in `recense dedup-entities` CLI with --dry-run default + dispatcher wiring (DEDUP-01)
- [x] 25-03-PLAN.md — founder-gated live run: dry-run → approval → real merge, brain-memory 8+→1, recall regression check, verification artifact (DEDUP-03)

### Phase 26: Belief-Correction / Duplicate-Fact Fix (RE-SCOPED 2026-06-18)

**Goal**: The duplicate-fact / belief-correction-incomplete symptom — contradicting and restated claims mint a second node instead of reconciling with the existing belief — is fixed in the consolidation judge + PE-resistance routing path (where diagnosis localized it), and the fix is validated on the reused extraction-replay harness without re-extraction. (Originally scoped as an embedder/cosine "retrieval fix"; that premise was falsified by diagnosis — the contradicting claims already cluster as candidates, so the bug is post-retrieval.)
**Depends on**: Phase 25 (clean entity layer); RETR-01 diagnosis complete (`26-DIAGNOSIS-V{1,2,3}.md`)
**API budget**: judge-replay diagnosis + extraction-replay validation use LLM-judge calls — cost-gated per the headless-judge billing lesson; the original ~$3–5 re-embed/paid-eval is dropped (no model swap)
**Requirements**: RETR-01, RETR-02, RETR-03
**Success Criteria** (what must be TRUE):

  1. RETR-01 — DONE: the symptom is diagnosed as post-retrieval (consolidation judge verdict + PE-resistance routing), NOT embedder- or cosine-threshold-bound; evidence in `26-DIAGNOSIS-V{1,2,3}.md` (contradicting claims cluster at cosine 0.3–0.97 yet duplicates are minted; gate is `unrelatedSimilarityThreshold` 0.3, not 0.7).
  2. A judge-replay over the surfaced near-duplicate claim/candidate pairs isolates the faulty step (judge-misclassify vs PE-routing-escape); the identified path is fixed so same-belief restatements/contradictions reconcile (tombstone prior + update) instead of minting a duplicate; validated on `replay-ku-harness.cjs` with EVAL-02 belief-correction ≥84.6% and duplicate-minting on the surfaced set measurably reduced — RETR-02
  3. A fact-level dedup/reconciliation pass (Phase 25 entity-dedup analog) collapses residual real duplicate fact nodes, excluding known self-ingestion pollution; losers tombstoned (never deleted), edges rewired, provenance preserved; graph stays source of truth — RETR-03

**Plans**: 4 plans (re-planned 2026-06-18 — old swap/re-embed/paid-eval plans superseded; 26-01 RETR-01 diagnosis DONE)

- [x] 26-01-PLAN.md — RETR-01 diagnosis (DONE; root cause = judge/PE-routing, swap correctly rejected; see 26-DIAGNOSIS-V{1,2,3})
- [superseded] 26-02/26-03/26-04 — embedder-swap harness + re-embed + paid eval; retired (premise falsified)
- [x] 26-05-PLAN.md — RETR-02a: build the embedder-agnostic extraction-replay KU harness (KU score + judge-engagement + duplicate-mint counts; validation tool, no swap)
- [x] 26-06-PLAN.md — RETR-02b: cost-gated judge-replay over the surfaced near-dup pairs; split judge-misclassify vs PE-routing-escape; names the 26-07 fix target
- [x] 26-07-PLAN.md — RETR-02c: fix the implicated judge/PE path so restatements reconcile (tombstone+update) not mint dupes; validate on the harness (EVAL-02 ≥84.6%, dupes reduced)
- [x] 26-08-PLAN.md — RETR-03: opt-in `recense dedup-facts` pass (EntityDedup analog for fact nodes; pollution-excluded, tombstone-only, FK-clean, --dry-run default)

### Phase 27: Reader Layer

**Goal**: The validated reader slice (19/19 citations resolve, 0 invented) is promoted to a real product feature — doc-as-node lifecycle-exempt generation with inline fact-refs, a /doc route with Reader/Brain toggle, citation staleness detection and regen, and a navigable doc→doc corpus graph — retiring Obsidian as the authoring layer
**Depends on**: Phase 24 (scope-aware fact gather), Phase 25 (clean entity layer for gather quality), Phase 26 (semantic embedding breadth for complete coverage beyond lexical+entity gather); the validated slice already works on lexical+entity gather, so this phase promotes rather than rebuilds
**Requirements**: READER-01, READER-02, READER-03, READER-04
**Success Criteria** (what must be TRUE):

  1. A generated project doc exists as a `type='doc'` node — excluded from recall-embedding, eviction, decay, `training_eligible`, and claim-extraction; its write path routes through the single-writer consolidator; every substantive claim carries an inline `recense://fact/<id>` ref that resolves to a live node — READER-01
  2. The viz serves the doc at a `/doc` route; a Reader/Brain toggle lets the user switch between the prose view and a brain graph focused on that doc's cited atoms; clicking a fact-ref in the prose focuses the correct atom in the graph with selection state preserved across the toggle — READER-02
  3. On doc load, the reader detects stale citations (`node.last_access > doc.generatedAt`), surfaces a `prev_value → value` diff for changed facts, and flags refs to tombstoned facts as "cited fact was removed"; a regenerate action rebuilds the doc from current facts — READER-03
  4. A doc→doc corpus graph (`doc_link` edges) is navigable in the viz; centering on a project surfaces its docs alongside neighboring projects and related entities, subsuming the need for a separate per-project graph view — READER-04 _(delivered as the flat 2D corpus; **SUPERSEDED by Phase 28** — the project-doc/`doc_link` corpus is replaced by the schema-anchored abstraction-graph corpus; the flat 2D renderer carries forward)_

**Plans**: 5 plans

- [x] 27-01-PLAN.md — v11 schema (node 'doc', edge 'cites'/'doc_link') + node_doc sidecar + store primitives
- [x] 27-02-PLAN.md — doc gather (scope∪semantic) + generator (judge-tier, cite-verify) + lifecycle-exempt doc-writer + `recense generate-doc` CLI (READER-01)
- [x] 27-03-PLAN.md — DB-backed /doc + lazy-gen spawn + Reader/Brain toggle + fact-ref→atom hero interaction (READER-02)
- [x] 27-04-PLAN.md — citation staleness endpoint + banner/inline markers + prev_value→value diff + regenerate (READER-03)
- [x] 27-05-PLAN.md — doc_link edges + /graph?type=doc corpus graph + expanded-only swap button (READER-04)

**UI hint**: yes

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Substrate | v1.0 | 4/4 | Complete | 2026-06-05 |
| 2. Consolidation & Update Core | v1.0 | 3/3 | Complete | 2026-06-05 |
| 3. Retrieval & Thin Adapter | v1.0 | 4/4 | Complete | 2026-06-06 |
| 4. Learning Layer | v1.0 | 4/4 | Complete | 2026-06-06 |
| 5. Level-3 Seams | v1.0 | 5/5 | Complete | 2026-06-08 |
| 6. Multi-channel Ingestion | v1.0 | 7/7 | Complete | 2026-06-08 |
| 7. Conversational Access Surface (Telegram) | v1.0 | 5/5 | Complete | 2026-06-09 |
| 8. Self-host Hardening | v1.0 | 3/3 | Complete | 2026-06-09 |
| 9. OSS Floor | v2.0 | 9/9 | Complete | 2026-06-09 |
| 10. Brain-Activation Visualization | v2.0 | 5/5 | Complete | 2026-06-10 |
| 11. stdio MCP Server | v3.0 | 6/6 | Complete | 2026-06-10 |
| 12. HTTP Serving Mode | v3.0 | 6/6 | Complete | 2026-06-11 |
| 13. Reference Client Extraction | v3.0 | 7/7 | Complete | 2026-06-11 |
| 14. Benchmark, Eval & Positioning | v3.0 | 5/5 | Complete | 2026-06-13 |
| 15. Viz UI Modernization | v3.0 | 8/8 | Complete | 2026-06-12 |
| 16. Brain Viz Tray App | v3.0 | 6/6 | Complete | 2026-06-12 |
| 17. LongMemEval Gap Closure | v3.0 | 9/9 | Complete | 2026-06-13 |
| 18. Schema Relations Engine | v3.1 | 4/4 | Complete | 2026-06-13 |
| 19. Brain Window Polish | v3.1 | 4/4 | Complete | 2026-06-14 |
| 20. Temporal Ingestion Foundation | v4.0 | 5/5 | Complete | 2026-06-16 |
| 21. Engine Surfacing API | v4.0 | 4/4 | Complete | 2026-06-16 |
| 22. Notify-Only Proactive Push | v4.0 | 3/3 | Complete | 2026-06-16 |
| 23. Approval-Gated Any-MCP Execution | v4.0 | 10/10 | Complete | 2026-06-17 |
| 24. Foundational Store | v5.0 | 3/3 | Complete   | 2026-06-18 |
| 25. Entity Dedup / Prune | v5.0 | 3/3 | Complete   | 2026-06-18 |
| 26. Retrieval-Embedding Fix | v5.0 | 5/5 | Complete   | 2026-06-18 |
| 27. Reader Layer | v5.0 | 5/5 | Complete   | 2026-06-18 |
| 28. Schema-Anchored Corpus | v5.0 | 5/5 | Complete   | 2026-06-19 |
| 29. Survey Quality Spike | v6.0 | 3/3 | Complete    | 2026-06-20 |
| 30. Core Ingest Command | v6.0 | 3/3 | Complete   | 2026-06-20 |
| 31. Doc Ingest + Idempotent Re-ingest | v6.0 | 2/2 | Complete   | 2026-06-20 |
| 32. Project Recall + Auto-Corpus | v6.0 | 3/3 | Complete   | 2026-06-21 |
| 33. Synchronous Curated Write (`recense remember`) | v6.0 | 2/2 | Complete | 2026-06-20 |
| 34. Visual Polish Pass | v6.0 | 3/3 | Complete | 2026-06-20 |

### Phase 28: Schema-Anchored Corpus

**Goal:** Pivot the reader corpus from project-scope docs to the **abstraction graph rendered as prose**. A doc anchors on a **schema** (the generalization is the thesis) or entity, and its body cites direct facts/nodes as evidence — reusing the existing `scope ∪ semantic ∪ entity-hop` gather, re-anchored from a scope to a schema/entity. **Mass-gated promotion** decides which nodes (schema/entity/scope) earn their own doc via a cheap COUNT-style gate (not an LLM call); fine sentence-grained schemas stay lines in a doc. The doc hierarchy mirrors the `abstracts` edge ladder (high schema = broad doc, child schemas = sub-docs → recursive project→infra→deployment nesting for free); cross-cutting topics = clusters spanning scopes. Decide-cheap / generate-lazy: detect + create the doc node + parent stub-link eagerly, generate prose on first access (existing lazy-gen). Corpus edges become **containment (parent→child) + reference** over the abstraction graph.

**Supersedes:** Phase 27 **READER-04** (doc_link-between-projects corpus) — replaced by the schema-anchored, hierarchical corpus. The project-scope doc becomes the degenerate case (anchor = scope).
**Inherits (reuses, untouched):** Phase 27 reader UI + Reader/Brain toggle (READER-02), staleness/regen (READER-03), the flat 2D `force-graph` renderer, lazy-gen, `/doc` routes, the gather machinery, and the lifecycle-exempt read-only doc-writer.
**Guard (load-bearing):** a doc is inferred output and must never strengthen the schema it renders (self-confirmation rule) — doc nodes stay read-only (no embed/decay/training), as they already are.

**Requirements**: CORPUS-01 (schema-anchored doc generation), CORPUS-02 (LLM-free mass-gated promotion + noise filter), CORPUS-03 (schema→schema ladder enrichment via centroid-cosine + mass-direction containment/reference; ≥1 parent→child nest), CORPUS-04 (containment + reference corpus edges in the flat 2D corpus, supersedes READER-04 doc_link), CORPUS-05 (read-only projection / self-confirmation guard) — locked in 28-SPEC.md (5 reqs).
**Depends on:** Phase 27 (reader/render foundation) + the schema/abstraction layer (live brain has 7000+ nodes with real schemas + `abstracts` edges, so viable now)
**Plans:** 4/4 plans complete

Plans:
**Wave 1**

- [x] 28-01-PLAN.md — v12 migration (edge.kind += doc_containment/doc_reference) + Wave-0 test scaffolds (CORPUS-03/04)
- [x] 28-02-PLAN.md — gatherFactsForSchema (D-09 schema-anchored gather) + schema-thesis prompt framing (CORPUS-01)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 28-03-PLAN.md — CorpusPromoter: mass-gate+noise filter, centroid-cosine+mass-direction ladder, eager doc stubs, CLI + sleep-pass wiring; BLOCKING CORPUS-05 snapshot test (CORPUS-02/03/05)
- [x] 28-04-PLAN.md — /graph?type=doc + corpus.js link-kind styling (containment solid/directed, reference faint/dashed); hero-verify legible forest (CORPUS-04)

## Phase Details — v6.0 Project Onboarding — SHIPPED 2026-06-22

> Archived: full detail in [milestones/v6.0-ROADMAP.md](milestones/v6.0-ROADMAP.md) and audit in [v6.0-MILESTONE-AUDIT.md](v6.0-MILESTONE-AUDIT.md). Phases 33 (`recense remember`) and 34 (visual polish) were standalone phases folded into v6.0 at close (founder decision 2026-06-22) → v6.0 = phases 29–34. The expanded phase detail below is retained as history.

recense onboards a fresh/unexplored project into the brain on demand via an agentic survey → episodes → consolidation. Builds on v5.0 scope provenance, the SourceAdapter seam, and the schema-anchored corpus. Spike-first: Phase 29 proves survey quality before the full build.

**Engine invariants across all phases:** single-tenant; graph is source of truth, vector is derived cache; online paths LLM-free (all LLM/embedding cost in the offline sleep pass); origin=`observed` for all survey/doc ingest (never `asserted_by_user`); never strengthen a fact from inferred output; net-zero new runtime deps; summarized semantic knowledge only (no raw code indexing).

- [x] **Phase 29: Survey Quality Spike** (INGEST-03) — prove agentic-survey fact/schema signal on one real project; go/no-go for the build phases (completed 2026-06-20)
- [x] **Phase 30: Core Ingest Command** (INGEST-01/02/04) — `recense ingest-project <dir>`: survey agent → summarized episodes → scope-tagged facts + schemas via the offline pipeline — depends on 29 (completed 2026-06-20)
- [x] **Phase 31: Doc Ingest + Idempotent Re-ingest** (DOCING-01, REINGEST-01/02) — direct project-doc ingest + per-project cursor + in-place belief reconciliation on re-ingest — depends on 30 (completed 2026-06-20)
- [x] **Phase 32: Project Recall + Auto-Corpus** (RECALL-01/02) — scoped project recall + auto-promoted/-generated schema-anchored corpus doc — depends on 30+31 (completed 2026-06-21)

### Phase 29: Survey Quality Spike

**Goal**: Before building the full command, prove that an agentic survey of a real project produces facts and schemas with genuine signal — not noise — when ingested through the existing pipeline. The spike output is a go/no-go decision and calibration input (scope-tagging conventions, summarization prompt shape, quality gate definition) for Phases 30–32.
**Depends on**: Phase 28 (consolidation + corpus pipeline live)
**Requirements**: INGEST-03
**Success Criteria** (what must be TRUE):

  1. A user runs a manual spike: an agent surveys one real repo and emits summarized observations as episodes through the existing pipeline — the spike completes without new runtime deps
  2. After a sleep pass, the resulting facts are inspectable: ≥5 facts per surveyed area (architecture, conventions, decisions) are judged as genuine semantic knowledge, not raw-code noise or structural trivia like "file X imports Y"
  3. At least one schema is induced from the surveyed project's facts — the abstraction layer fires, not just fact storage
  4. The spike produces written calibration notes: what prompt shape / summarization level / quality gate definition to carry into Phase 30

**Plans**: 3 plans

- [x] 29-01-PLAN.md — survey-feeder spike: agentic survey of ~/usage → summarized episodes (origin=observed, cwd=/Users/vtx/usage) → consolidation on a scratch DB (SC1) — code complete (Tasks 1+2, `233b77e`); AWAITING founder survey run (Task 3 checkpoint:human-verify)
- [x] 29-02-PLAN.md — genuine/noise judge harness: per-area tally (≥5-genuine bar) + schema-induction inspection (≥1 bar) over the scratch DB (SC2/SC3)
- [x] 29-03-PLAN.md — 29-CALIBRATION.md calibration notes (prompt shape, summarization level, quality gate, scope-tagging) + founder-owned go/no-go (SC4)

### Phase 30: Core Ingest Command

**Goal**: A user runs `recense ingest-project <dir>` on an unexplored repo: an agent surveys it and emits summarized observations as episodes via the existing offline pipeline, scope-tagged to that project, yielding facts + schemas after a sleep pass. Carries the Phase-29 calibration (prompt shape, quality gate, scope-tagging convention).
**Depends on**: Phase 29 (spike calibration — prompt shape + quality gate proven)
**Requirements**: INGEST-01, INGEST-02, INGEST-04
**Success Criteria** (what must be TRUE):

  1. A user runs `recense ingest-project <dir>` on an unexplored repo and it completes — episodes are written to the DB; no online path is blocked; the command returns promptly (ingestion runs offline)
  2. After a sleep pass, the ingested facts are retrievable via `recense recall` and carry the correct `[scope]` attribution matching the project
  3. The brain produces at least one schema induced from the surveyed project — the same abstraction pipeline that fires on conversation turns fires on survey episodes
  4. Raw code lines and low-value structural facts are absent from the resulting fact set — the quality gate calibrated in Phase 29 is enforced

**Plans**: 3 plans

**Wave 1**

- [x] 30-01-PLAN.md — opt-in tool-enabled survey transport on the headless client (NEW seam — the committed `--tools none` path can't read a repo) + carried pure helpers (splitObservations, isRefusalOrToolFailure, buildSurveyPrompt) with unit tests (INGEST-01)

**Wave 2** *(depends on Wave 1)*

- [x] 30-02-PLAN.md — `recense ingest-project <dir>` standalone CLI: survey→recordEvent (scope-tagged, origin=observed), real `--scope` threading via synthetic cwd, `--dry-run`/`--db`/`--desc`, deferred-default + `--consolidate` inline, retry-then-skip, dispatcher wiring (INGEST-01/02/04)

**Wave 3** *(depends on Wave 2)*

- [x] 30-03-PLAN.md — founder-supervised live SC2 re-validation on the REAL committed transport (the 82% spike number is unsound) + `[scope]` recall (SC2) + ≥1 schema (SC3); `autonomous: false` (INGEST-01/02/04)

### Phase 31: Doc Ingest + Idempotent Re-ingest

**Goal**: Project documents (README, docs/*.md, CLAUDE.md) can be ingested directly via the extended SourceAdapter seam, and re-running ingestion on a changed project updates existing beliefs in place rather than minting duplicates — with a per-project cursor so only changed/new content is re-surveyed.
**Depends on**: Phase 30 (ingest-project command exists; SourceAdapter seam extended)
**Requirements**: DOCING-01, REINGEST-01, REINGEST-02
**Success Criteria** (what must be TRUE):

  1. A user can point ingestion at a project dir and the project's README / docs/*.md / CLAUDE.md are ingested as episodes with origin=`observed` and project scope — without configuring an Obsidian vault
  2. Re-running ingestion on a project where a key fact changed results in the existing belief being updated (tombstone + new node via reconsolidation) rather than a duplicate — a second run on an unchanged project produces zero new consolidated beliefs
  3. The per-project cursor means only changed/new content triggers re-survey — a full re-survey is not triggered when the majority of project content is unchanged

**Plans**: 2 plans

**Wave 1**

- [x] 31-01-PLAN.md — doc ingest: recursive doc walk (README/CLAUDE/docs/**/*.md) + chunkNote/redactSecrets/contentExternalId reuse → episodes (origin=observed, source=project-doc, project scope); content-hash idempotency (DOCING-01)

**Wave 2** *(depends on Wave 1 — same file)*

- [x] 31-02-PLAN.md — per-project cursor: git HEAD/dirty + mtime fingerprint, SemanticStore `cursor:project:<scope>` skip-gate, --force/--dry-run/--db discipline, + D-07 dup-rate reconciliation gate test (REINGEST-01, REINGEST-02)

### Phase 32: Project Recall + Auto-Corpus

**Goal**: Users can surface a specific project's ingested knowledge instantly via scoped recall, and a newly-onboarded project is immediately browsable in the reader — the corpus doc is auto-promoted and generated as part of ingestion, not as a separate manual step.
**Depends on**: Phase 30 (project facts + schemas exist), Phase 31 (corpus stays current through re-ingest)
**Requirements**: RECALL-01, RECALL-02
**Success Criteria** (what must be TRUE):

  1. A user can run scoped recall for a project and receive only facts attributed to that project — facts from other projects are excluded from the result set
  2. After `recense ingest-project` completes and the sleep pass runs, the project's schema-anchored corpus doc is automatically promoted and generated — the user can open it in the Reader without a separate `recense generate-doc` step
  3. The auto-generated corpus doc covers the project's induced schemas as thesis entries with cited evidence from the surveyed facts — it reads as a coherent project overview, not a raw observation list

**Plans**: 3 plans

**Wave 1**

- [x] 32-01-PLAN.md — `--scope <slug>` scoped recall: post-resolution {slug, global} member filter in RecallEngine, D-S1-safe (RECALL-01)
- [x] 32-02-PLAN.md — CorpusPromoter.promoteScope (scope-anchored always-promote: landing doc + induced-schema chapters, landing→chapter doc_containment) + landing-doc generation routing (RECALL-02)

**Wave 2** *(depends on 32-02 promoteScope API)*

- [x] 32-03-PLAN.md — trigger wiring: inline `--consolidate` promote+generate + deferred pending-corpus-promotion:<scope> marker + crash-safe sleep-pass consume; live SC verification on /Users/vtx/usage (RECALL-02)

**UI hint**: yes

### Phase 33: Synchronous Curated Write (recense remember) — lossless single-fact write with reconsolidation; closes the replaces-MEMORY.md promise

**Goal:** Give recense a synchronous, lossless, curated WRITE path so that ALL deliberate facts/memory flow through the brain and nothing else — closing the customer-zero "replaces MEMORY.md" promise. recense already owns the READ path (session-start-cli fires recall); deliberate writes still leak to native Claude Code `.md` memory files because the only existing write paths are passive lossy turn-capture→sleep-pass (~84–90% KU, hourly delay) and batch ingest/import-memory (lossy extraction).

**Requirements**: (to derive in plan) REMEMBER-01 synchronous verbatim curated write; REMEMBER-02 in-place reconsolidation on write; REMEMBER-03 native-memory cutover (directive + retire .md).
**Depends on:** Standalone — NOT the v6.0 project-onboarding phases. Depends only on the already-live consolidation/judge/sink machinery (consolidation/update-decision.ts, sink.ts), semantic-store write primitive, and the embedder.

**Scope / deliverables:**

1. `recense remember "<fact>" [--scope <s>]` CLI subcommand (new `remember-cli.ts`, wired into `recense.ts` dispatcher). Stores text VERBATIM — no lossy extraction.
2. Synchronous reconsolidation ("mini sleep-pass"): embed → retrieve neighbor beliefs → judge (reuse `update-decision.ts` + `sink.ts`) → update-in-place on contradiction, else insert. ~1 judge LLM call/remember (subscription-billed, ~$0 marginal, ~2–5s). This is the differentiator vs. appending to a flat file.
3. Mark fact curated/evidence-backed: decay never kills it; sleep pass never re-extracts/mangles it. Reuse existing evidence-backed/source-type fields; add a column only if needed.
4. Scope: default cwd-derived, `--scope` override.
5. CLAUDE.md hard directive (additive — overrides the harness native-memory protocol per instruction-priority rules): all facts/memory → `recense remember`, never write `.md` memory files. Investigate a `settings.json` kill-switch for the native Claude Code file-based memory feature (belt-and-suspenders).
6. One-time migration: feed the 12 existing `.md` files at `~/.claude/projects/-Users-vtx-brain-memory/memory/` through the NEW verbatim `remember` (NOT lossy import-memory), verify each landed, then delete. Order: write→verify→remove.

**Correctness guards (project-critical):** never let inferred output strengthen a fact (self-confirmation); graph is source of truth; an LLM judge call is acceptable here (explicit user write, NOT the hot online hook path). Reconsolidation is eval-backed — verification must confirm in-place update vs. dup-accumulation.

**Plans:** 2/2 plans complete

Plans:
**Wave 1**

- [x] 33-01-PLAN.md — `recense remember` engine + CLI: verbatim curated store + synchronous mini-pass reconsolidation (embed → top-k → judge → D-04 force-reconcile, else insert) + D-03 high-resistance seed + scope-stamp + lock + dispatcher + unit tests (REMEMBER-01, REMEMBER-02)

**Wave 2** *(depends on 33-01)*

- [x] 33-02-PLAN.md — native-memory cutover: D-06 global CLAUDE.md directive + D-07 settings.json kill-switch investigation + founder-gated one-time verbatim migration of the 12 `.md` files (write → D-08 value_hash verify → D-09 archive); `autonomous: false` (REMEMBER-03)

### Phase 34: Visual Polish Pass

**Goal:** The four live viz surfaces — Reader (prose docs), Corpus 2D graph, Detail panel/page, and the Brain HUD/controls (search/stats/topics/trace/buttons) — are cleaned of rough edges along two axes only: **spacing/alignment consistency** and **states & transitions** (loading/empty/error states, hover/focus feedback, smooth transitions). This is a polish pass, NOT a redesign — composition/structure is untouched; the diff is CSS + state-handling, not layout re-architecture.

**Scope (cross-surface, all four):**

- **Spacing/alignment** — consistent padding/margin scale, no cramped/misaligned/uneven elements on the flagged surfaces.
- **States & transitions** — every async surface has explicit loading/empty/error states (no blank or janky gaps); interactive elements (buttons, fact-refs, graph nodes, list rows) have hover/focus feedback and smooth transitions.

**Out of scope:** structural/composition changes, redesign, new screens, new features, any change to graph data/semantics.

**Load-bearing constraints (founder-locked):**

- **Palette** — muted rose/slate/mauve at rest; **amber reserved for activation/hover ONLY**. Do not reintroduce amber for non-activation states (ref the 27-04 staleness palette violation — `.fact-stale` had to be re-toned off amber).
- **Density anchor** — the 3D brain overview density is founder-locked; no regression.
- **Net-zero new runtime dependencies.**

**Requirements**: VIZ-POLISH-01 (spacing/alignment consistency across all four surfaces), VIZ-POLISH-02 (complete loading/empty/error state coverage + hover/focus feedback + smooth transitions), VIZ-POLISH-03 (palette + density + no-structural-change guard holds) — to be locked at plan time.
**Depends on:** Standalone — all four surfaces already exist and are live (Phases 10/15/19 brain+HUD, 27 reader, 27-05/28 corpus, detail panel). Polishes existing surfaces; builds nothing new.
**Success Criteria** (what must be TRUE):

  1. Across all four surfaces, spacing/alignment follows a consistent scale — the cramped/misaligned/uneven elements the founder flagged are resolved, verified by a per-surface before/after visual review — VIZ-POLISH-01
  2. Every async/interactive surface has explicit loading, empty, and error states (no blank or abrupt gaps), and interactive elements have visible hover/focus feedback with smooth transitions — VIZ-POLISH-02
  3. No amber is introduced for non-activation states (rest stays muted rose/slate/mauve; amber reserved for activation/hover) — verified by grep + visual; the 3D brain density anchor is visually unchanged; the diff is CSS + state-handling only (no structural/composition change); `package.json` runtime deps unchanged — VIZ-POLISH-03

**Plans:** 3/3 plans complete

**UI hint**: yes

Plans:
**Wave 1**

- [x] 34-01-PLAN.md — R1 sticky reader close + B2 HUD declutter + detail-spacing normalization (styles.css, index.html)

**Wave 2** *(depends on 34-01 — shares styles.css/index.html)*

- [x] 34-02-PLAN.md — corpus surface: B3 topics-hide + C1 icon button + C2 force tuning + loading/empty/error states (corpus.js, styles.css, index.html)

**Wave 3** *(depends on 34-01 + 34-02)*

- [x] 34-03-PLAN.md — dist rebuild + VIZ-POLISH-03 guard greps + founder visual checkpoint (autonomous: false)

## Phase Details — v7.0 Retrieval & Reasoning Depth

recense deepens the two weakest edges of the engine — *how it ranks what it retrieves* and *how much it reasons over what it stores* — without touching the core learning loop. The unifying bet is recense's own architecture principle: **pay LLM/embedding cost at sleep, save it at recall.** All three build phases serve token-efficiency *and* use-quality (better ranking → fewer tokens for equal answer; typed paths → precise retrieval instead of neighborhood dumps; stored insights → recall returns a precomputed answer instead of re-synthesizing at compose-time). Bi-temporal validity (Zep/Graphiti-style validity intervals) was evaluated and **deferred** — it adds storage + complexity while serving a "what did I believe in March" question customer-zero rarely asks.

**Engine invariants across all phases:** single-tenant; graph is source of truth, vector is derived cache; online paths stay LLM-free (all LLM/embedding cost in the offline sleep pass); never strengthen a fact from inferred output (self-confirmation guard); never resurface a tombstoned node; net-zero new runtime deps.

**Dependency shape:** 35 and 36 are independent and can run in either order. 37 is **gated** on the 36 spike go/no-go (it does not start on a no-go). 38 is sequenced last (typed edges enrich reflection inputs but are not required).

### Phase 35: Recency/Strength-Weighted Retrieval Ranking

**Goal:** Recall ranks by belief strength and recency blended with semantic similarity, instead of cosine+BM25 alone — so a strongly-reinforced recent belief outranks a stale weak one at equal similarity, improving quality-per-injected-token with zero added online LLM cost. Today `effective_s` (strength-decay) is computed but used only for eviction; it never enters ranking (`src/retrieval/topk.ts`, `src/recall/index.ts`).
**Requirements**: RANK-01 (strength/recency term fused into ranking, tunable, LLM-free), RANK-02 (eval-backed: no regression + a token or precision win)
**Depends on:** Standalone within v7.0 — builds on the live retrieval/recall engine (Phases 3/17/18)
**Success Criteria** (what must be TRUE):

  1. Recall fuses a strength/recency signal (`effective_s` + `last_access`) with the existing cosine+BM25 RRF behind a tunable weight; the online path stays LLM-free — RANK-01
  2. On the existing KU/LongMemEval replay harness, blended ranking shows no regression vs. the cosine+BM25 baseline and delivers at least one of: higher top-k precision, or equal quality at a smaller inject budget (genuine token saving) — RANK-02
  3. The strength/recency term never overrides scope rules and never resurfaces tombstoned nodes (RET-02 invariant holds)

**Plans:** 2/2 plans complete

- [x] 35-01-PLAN.md — Mechanism (RANK-01): weighted rrfFuse + pool-only strength list in hybridTopk + rankStrengthWeight knob (dark default), wired through retrieveRanked; T1..T5 + no-self-strengthen tests
- [x] 35-02-PLAN.md — Eval (RANK-02): KU harness queryText fix + --strength-weight flags + w-sweep driver; paid baseline+sweep run, winning w + D-06/D-07 verdict

### Phase 36: Typed Predicate Edges — Spike

**Goal:** Before committing a build, prove that extracting *typed* relations (predicates like `works_at` / `prefers` / `located_in`) instead of generic weighted `relation` edges produces a measurable lift in multi-hop recall on a real query set — a founder-owned go/no-go plus calibration notes (predicate vocabulary, extraction prompt shape). Mirrors the Phase 29 spike-first discipline. **Off-distribution architecture work — the spike de-risks the "right approach" call before any engine change.**
**Requirements**: TYPED-SPIKE-01 (typed extraction measurably lifts multi-hop recall, or is honestly shown not to)
**Depends on:** Standalone within v7.0 — runs against a scratch DB, no change to the live graph
**Success Criteria** (what must be TRUE):

  1. A spike extracts typed predicates from a sample of real episodes on a scratch DB — no new runtime deps, the live graph untouched
  2. A held-out multi-hop query set (e.g. "where is X" requiring entity→entity→attribute hops) is answered measurably better with typed edges than with the current untyped `relation` edges — or shown not to, with numbers
  3. Written calibration notes: predicate vocabulary (closed set vs open), extraction prompt shape, recall-traversal sketch, and a **founder-owned go/no-go** for Phase 37

**Plans:** 0 plans (run `/gsd-spike 36` or `/gsd-plan-phase 36`)

### Phase 37: Typed Predicate Edges — Build (gated on Phase 36)

**Goal:** If Phase 36 is a go, promote typed predicate extraction into the live consolidation pipeline and recall path: edges carry a predicate type, offline extraction emits them, and recall traverses a typed relational *path* instead of dumping an untyped neighborhood — enabling durable multi-hop reasoning and a smaller, more precise recall payload.
**Requirements**: TYPED-01 (typed edge model + offline typed extraction), TYPED-02 (typed-path recall, fewer tokens at equal/better quality)
**Depends on:** **Phase 36 go/no-go — this phase does not start on a no-go.** Builds on the live consolidation extraction + edge model.
**Success Criteria** (what must be TRUE):

  1. The schema + `edge` model carry predicate types; consolidation extraction emits typed edges through the offline pipeline (all LLM cost at sleep); graph stays source of truth — TYPED-01
  2. Recall assembles a typed relational path; multi-hop queries return a precise path with fewer tokens than the untyped-neighborhood baseline at equal-or-better answer quality on the harness — TYPED-02
  3. Self-confirmation guard intact: inferred output never mints or strengthens a typed edge

**Plans:** 4/4 plans complete

Plans:
**Wave 1**

- [x] 37-01-PLAN.md — Wave 0 primitives: predicate vocab + parseTriples, getOutEdgesWithRel, predicateGlossThreshold config, offline gloss embeddings

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 37-02-PLAN.md — Extraction (TYPED-01): merged {facts,triples} prompt, consolidator typed-edge upsert (origin-guarded), mode switch
- [x] 37-03-PLAN.md — Recall traversal (TYPED-02): typedReach + matchPredicate, D-06 typed-path-OR-fallback augment, D-08 guard

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 37-04-PLAN.md — Build harness + gate (TYPED-02): 37-precision-harness, re-derived query set, D-05 founder sign-off, PRIMARY precision gate

### Phase 38: Stored Reflections / Derived Insights

**Goal:** The sleep pass periodically reflects over schema clusters and stores higher-order derived insights as first-class nodes (`origin=inferred`, non-strengthening, confidence-capped), so recall can return one precomputed insight instead of forcing the online LLM to re-synthesize N raw facts at compose-time — making the "reasons over schemas to handle novel situations" claim a durable engine mechanism, not a recall-time-only effect.
**Requirements**: REFLECT-01 (offline reflection → inferred non-strengthening insight nodes), REFLECT-02 (recall surfaces insights, reducing compose tokens; falsified facts invalidate dependent insights)
**Depends on:** Live schema induction (Phases 4/18); sequenced after Phase 37 (typed edges enrich reflection inputs but are not required)
**Success Criteria** (what must be TRUE):

  1. The offline pass generates derived-insight nodes from schema clusters, stored with `origin=inferred`, `training_eligible=0`, and a confidence ceiling; they decay and never strengthen the facts they summarize (self-confirmation guard) — REFLECT-01
  2. Recall surfaces a relevant stored insight in place of (or ahead of) raw member facts where it answers the query, measurably reducing compose-time tokens on the harness with no quality regression — REFLECT-02
  3. Insights are regenerable/evictable like docs; a falsified or tombstoned underlying fact invalidates or flags the dependent insight (no stale-insight self-confirmation)

**Plans:** 2/4 plans executed

Plans:
**Wave 1**

- [x] 38-01-PLAN.md — Model/DDL foundation: type='insight' + derived_from CHECK migrations (schema v13), node_insight sidecar, eviction child-wipe, config knobs

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 38-02-PLAN.md — InsightReflector deriver: judge-tier synthesis + selection/staleness gate + single-writer write, wired into Phase C; self-confirmation sentinel
- [x] 38-03-PLAN.md — Recall surfacing: augment-with-fallback insight-in-place-of-neighborhood, freshness-gated, LLM-free, behind insightSurfacingEnabled dark default

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 38-04-PLAN.md — Eval: instrument the KU replay harness with compose-token measurement (off vs on), prove the no-regression token win + founder activation decision

### Phase 38.1: Consolidation intra-pass dedup fix (embed-on-mint) (INSERTED)

**Goal:** Claims arriving in the SAME consolidation pass can dedup/contradict each other — a mid-pass-minted node is visible to later episodes' `topk` in that pass, instead of minting permanent duplicate islands. Fixes the bulk-ingest onboarding path (`ingest-project` into a small/empty graph) and unblocks a fair Phase 35 RANK-02 re-test.
**Requirements**: DEDUP-01 (embed-on-mint: minted node's embedding set from the already-computed claim vector so it's `topk`-visible immediately — Option D), DEDUP-02 (no regression: incremental multi-pass path + RANK-01 dark default unchanged; `setEmbedding` stays single writer, T-01-DIRTY intact)
**Depends on:** Inserted after Phase 38 (urgent). Independent correctness fix; gates a fair Phase 35 RANK-02 re-test, and must precede the v8.0 benchmark/gate phases (40–43) so their baselines aren't frozen on a degenerate graph. Design captured in 38.1-CONTEXT.md.
**Plans:** 1/1 plans complete

Plans:
- [x] 38.1-01-PLAN.md — invariant re-verify + thread claimVec & embed-on-mint at value==claim mint sites (per-site audit) + DEDUP-01 intra-pass regression test (DEDUP-01, DEDUP-02)

### Phase 39: Reader Wiki-Parity — Browsable Index + Surfaced Backlinks

**Goal:** Close the two reader-layer ergonomics where recense trails Karpathy's LLM Wiki pattern (the `research-wiki` standard) — a **browsable INDEX** and **surfaced backlinks** — without touching the engine. Both reuse data that already exists (doc nodes; reverse-edge lookup via `idx_edge_dst` / `getInEdges`), so this is presentation-layer parity, not new mechanism. recense already meets-or-beats the LLM Wiki on every *mechanism* dimension (autonomous maintenance, dedup-to-canonical, PE-gated update-don't-rewrite, enforced citations, automatic staleness, self-confirmation immunity, forgetting); these are the two browsing affordances it lacks. **Markdown export (LLM-Wiki gap #3) is explicitly deferred** — recall + reader replace grep, and the queryable-DB-vs-portable-files trade is a deliberate divergence, not a deficiency.
**Requirements**: WIKI-01 (browsable index over existing doc nodes), WIKI-02 (backlinks / "what links here" surfaced in the reader)
**Depends on:** Phase 27/28 reader + corpus layer (live). Independent of 35–38 — can land in any order within v7.0; sequenced last only by convention. Pairs naturally with Phase 34 polish.
**Success Criteria** (what must be TRUE):

  1. The reader exposes a browsable INDEX — a generated index doc and/or `/index` route that lists and links the live doc/landing nodes as a navigable entry point (the `research-wiki` "unindexed content doesn't compound" rule) — built over existing doc nodes, no new engine state — WIKI-01
  2. Viewing a doc (or atom) surfaces its **incoming** references ("referenced by" / what-links-here), not just outgoing cites — reusing the existing reverse-edge lookup (`idx_edge_dst`, `getInEdges`); the panel is read-only and adds no online LLM cost — WIKI-02
  3. No engine change: no new node/edge types required, no write-path mutation; the diff is reader/viz + a generated index doc. Self-confirmation guard untouched (index/backlink surfaces are read-only projections) — WIKI-03

**Plans:** 2/2 plans complete

Plans:
- [x] 39-01-PLAN.md — Backlinks: read-only /doc/backlinks route + reader "Referenced by" section + atom "cited by" (WIKI-02, WIKI-03)
- [x] 39-02-PLAN.md — Browsable index: read-only /index route + #btn-index module/button grouped Projects/Schemas (WIKI-01, WIKI-03)

## Phase Details — v8.0 Performance, Efficiency & Competitive Parity

recense proves it is **at or above competitor memory systems** (mem0, Zep/Graphiti, Letta) on the three axes those systems publish on — **accuracy, latency, and token/cost** — and then locks those numbers behind regression gates so they can't silently rot. This milestone *measures and optimizes*; it does not change the memory model. It starts only after v7.0 (35–39) lands, so the system under test is the final one, not a moving target.

**Load-bearing discipline (founder hard-rule — no inflated metrics):** every "at or above competitors" claim must be reproducible — a benchmark recense ran itself, or a published competitor number cited with its source. No rounded-up or vibe figures. Baseline-before-optimize is therefore mandatory: Phase 40 records honest starting numbers and gates the rest; an optimization counts only if the harness shows it.

**Engine invariants across all phases:** online paths stay LLM-free and fast (the SessionStart hook blocks the user); graph is source of truth, vector is derived cache; the vector index is a *derived rebuildable cache*, never authoritative; no accuracy regression is an acceptable price for latency/token wins (all three axes move together or the trade is rejected).

**Dependency shape:** strict-ish chain 40 → {41, 42} → 43. Phase 40 (baseline + harness) gates everything. 41 (latency) and 42 (token) are independent of each other and can run in parallel once 40 lands. 43 (regression gates) comes last — it freezes whatever 40–42 achieved.

### Phase 39.1: Corpus Quality: project-hub and subject docs via zero-intervention LLM exhaust-gate, retroactive junk-doc cleanup, recense and vtx ingestion (INSERTED)

**Goal:** Make the brain's generated doc corpus genuinely good. Replace the landing-doc + schema-UUID-chapter-doc model with a content-driven taxonomy - one **project-hub doc** per scope (synthesized overview + linked subject index) plus many **LLM-named subject docs** - generated with **zero user intervention** via a two-stage LLM exhaust-gate (Stage 1 harvests cheap signal from the sleep pass's existing extract/judge calls to decide what's worth a doc; Stage 2 spends a dedicated generation call only when a CREATE-on-mass or REFRESH-on-drift gate opens, bounded by a per-pass budget cap + self-draining priority queue). Schema clustering is demoted to an internal signal. Then retroactively hard-delete obsolete/structural junk docs from the live brain (dry-run -> approve -> VACUUM INTO snapshot -> FK-safe delete), and validate the whole pipeline end-to-end by running the `ingest-project` full code survey on recense-itself (scope `brain-memory`) and vtx (scope `vtx`). Sequencing is a hard chain: **Build -> clean -> ingest** (D-11). Directly serves the core value ("stays correct over time") by applying PE-gated reconsolidation to docs.
**Requirements**: No formal requirement IDs (REQUIREMENTS.md retired at v6.0 close); traceability anchored to CONTEXT decisions D-01->D-11.
**Depends on:** Phase 39 (reader index/backlinks surfaces reused for hub<->subject navigation)
**Success Criteria** (what must be TRUE):

  1. Each ingested project scope has exactly one project-hub doc (slug = scope) carrying a synthesized overview + a linked index of its subject docs, with `doc_containment` edges to each subject - D-01, D-04
  2. Subject docs are LLM-named with stable `scope:name` slugs (never schema-UUID slugs), emerge from content (not 1:1 with schema clusters), and are idempotent across passes (no slug-drift duplicate accumulation) - D-02, D-03
  3. Doc generation is zero-intervention: a Stage-1 LLM-free gate decides candidacy (CREATE on mass, REFRESH on drift = atoms touched since `generated_at`), Stage-2 spends a generation call only when a gate opens, and a per-pass budget cap defers overflow to a self-draining marker queue - D-05, D-06, D-07
  4. A one-time cleanup CLI hard-deletes the three deterministic junk classes (old UUID chapter docs, empty stubs, noise-schema docs) after a dry-run + founder approval + a verified VACUUM INTO snapshot, in FK-safe order, touching only `origin='inferred'` doc nodes - D-08, D-09
  5. `ingest-project` full code survey completes on recense (brain-memory) and vtx, and a sleep pass produces hub + LLM-named subject docs in the new taxonomy for both - end-to-end validation - D-10, D-11
**Plans:** 4/5 plans executed

Plans:
- [x] 39.1-01-PLAN.md - Generation layer: generateDocForHub + generateDocForSubject + gatherFactsForSubject + drift config knob (D-01/02/03/04)
- [x] 39.1-02-PLAN.md - SubjectPromoter: Stage-1 CREATE/REFRESH gates + Stage-2 idempotent subject-proposal call + hub<->subject containment (D-02/03/05/06)
- [x] 39.1-03-PLAN.md - Orchestration: sleep-pass exhaust-gate wiring + hub/subject generation dispatch + budget cap & self-draining queue (D-05/07)
- [x] 39.1-04-PLAN.md - Cleanup CLI: dry-run -> snapshot -> FK-safe hard-delete of junk docs; founder-gated live run (D-08/09)
- [ ] 39.1-05-PLAN.md - Ingestion validation: ingest-project full survey on recense + vtx, verify new-taxonomy docs end-to-end (D-10/11)

### Phase 40: Competitive Benchmark Baseline

**Goal:** Stand up an apples-to-apples competitive benchmark and record honest baselines on all three axes, so "at or above competitors" becomes a falsifiable target instead of a slogan. Adds LOCOMO (the bench mem0/Zep actually cite) alongside the existing LongMemEval + KU replay harness; captures recense's current accuracy, retrieval latency (p50/p95), and token cost per write+recall; and pins the specific competitor numbers to beat with their sources.
**Concrete competitor targets (researched 2026-06-20, treat with methodology skepticism):** MemPalace claims LongMemEval R@5 **96.6%** (BUT the independent source teardown shows this is measured in "raw mode" = ChromaDB's default embedding model with the palace structure NOT involved — it measures the embedder, not the architecture; their lossy compression drops it to 84.2%) and LoCoMo R@10 **88.9%**, ConvoMem 92.9%; mem0 markets "~26% more accurate / 91% lower latency / 90% fewer tokens vs OpenAI memory"; Zep/Graphiti publish DMR + LongMemEval. claude-mem publishes **no accuracy benchmark** — only a "~10x token savings" retrieval claim. **Lesson baked into BENCH-03: a competitor headline number must be understood (what configuration/metric/dataset slice produced it) before it counts as a target — citing it is not enough.**
**Requirements**: BENCH-01 (LOCOMO harness runs reproducibly on recense), BENCH-02 (baseline accuracy/latency/token recorded), BENCH-03 (competitor targets cited AND methodology-understood — no inflated/unsourced/misread numbers)
**Depends on:** v7.0 complete (system under test is final). Gates Phases 41–43.
**Success Criteria** (what must be TRUE):

  1. LOCOMO runs against recense reproducibly (scripted, re-runnable) and produces an accuracy score alongside the existing LongMemEval + KU harness — BENCH-01
  2. A written baseline records recense's current accuracy, retrieval latency (p50/p95 on the live ~7000-node brain), and token cost per write and per recall — BENCH-02
  3. The competitor numbers to beat (mem0, Zep/Graphiti, MemPalace on LOCOMO/DMR/LongMemEval) are documented with their published sources AND with a one-line note on what each number actually measures (e.g. MemPalace's 96.6% = raw-embedder mode, not architecture); every recense number is reproducible from a committed script — no unsourced, rounded-up, or methodology-misread figures (founder no-inflated-metrics rule, applied to reading competitors too) — BENCH-03

**Plans:** 0 plans (run `/gsd-plan-phase 40`)

### Phase 41: Vector Index + Hot-Path Latency

**Goal:** Replace brute-force O(N) cosine on the hot recall path with the unbuilt `sqlite-vec`/HNSW vector-index seam, and profile/optimize the latency-critical surfaces (recall, SessionStart inject). The live brain is already 7000+ nodes — past the stated ~5K comfort zone for brute-force scan — so this is the headline latency lever. The index is a derived, rebuildable cache (graph stays source of truth); the online path stays LLM-free.
**Requirements**: PERF-01 (vector index replaces brute-force cosine, derived/rebuildable), PERF-02 (recall + SessionStart inject latency profiled and measurably improved vs the Phase 40 baseline), PERF-03 (no accuracy regression on the harness)
**Depends on:** Phase 40 (baseline to measure against). Independent of Phase 42 — can run in parallel.
**Success Criteria** (what must be TRUE):

  1. Recall nomination uses an ANN/vector index (`sqlite-vec` or HNSW) instead of brute-force cosine; the index is derived from node embeddings and rebuildable from the graph (never authoritative) — PERF-01
  2. Retrieval p50/p95 and SessionStart inject latency improve measurably vs the Phase 40 baseline on the live-scale brain; the online path remains LLM-free — PERF-02
  3. Accuracy on LOCOMO/LongMemEval/KU shows no regression vs baseline — a latency win that costs accuracy is rejected — PERF-03

**Plans:** 0 plans (run `/gsd-plan-phase 41`)

### Phase 42: Token / Cost Efficiency Audit

**Goal:** Measure recense's token/cost profile end-to-end and tune it, then quantify the savings vs competitors defensibly. recense's "pay at sleep, save at recall" architecture is a token-efficiency bet that has never been measured against a competitor; v7.0's ranking + reflections promised recall-token savings — this phase proves whether they paid off. Measures write cost (Haiku extract / Sonnet judge), recall inject cost, and tunes the levers (`consolSkipThreshold`, inject/neighborhood budget).
**Progressive-disclosure evaluation (founder-directed 2026-06-20):** both competitors lead with **progressive-disclosure retrieval** as their token mechanism — claude-mem's `search`(compact index)→`timeline`→`get_observations`(detail on demand, ~10x claim), MemPalace's L0→L3 layered load. recense uses a *different* strategy (schema-prior compression + bounded budgets). This phase **evaluates** progressive disclosure (likely in the MCP/recall surface) head-to-head against recense's current strategy and **adopts it only if the harness shows a real token win with no accuracy loss** — measured, not on faith (baseline-first discipline). Declining is a valid outcome if schema-prior compression already wins.
**Requirements**: COST-01 (per-write + per-recall token cost measured against baseline), COST-02 (levers tuned for a measured net reduction with no accuracy regression), COST-03 (savings vs competitors stated defensibly with sources), COST-04 (progressive-disclosure evaluated vs schema-prior compression; adopted only on a measured token win)
**Depends on:** Phase 40 (baseline). Independent of Phase 41 — can run in parallel.
**Success Criteria** (what must be TRUE):

  1. Token cost is measured per write (extract+judge) and per recall (inject), broken down by lever, against the Phase 40 baseline — COST-01
  2. Levers (`consolSkipThreshold`, inject budget, recall caps, v7.0 ranking/reflection wins) are tuned to a measured net token reduction with no accuracy regression on the harness — COST-02
  3. The token-efficiency claim vs competitors (e.g. mem0's ~90% / claude-mem's ~10x retrieval savings) is stated with both recense's reproduced number and the cited competitor figure — no inflated comparison — COST-03
  4. Progressive-disclosure retrieval (index-first → detail-on-demand) is benchmarked against recense's schema-prior compression on the token axis; adopted into the recall/MCP surface only if it shows a measured token win with no accuracy regression, else explicitly declined with the numbers — COST-04

**Plans:** 0 plans (run `/gsd-plan-phase 42`)

### Phase 43: Eval Regression Gates

**Goal:** Turn the benchmark harness into a CI gate so the accuracy/latency/token numbers won earned in 40–42 can't silently regress. "Lock down performance" means continuous, not one-shot — a PR that drops accuracy, inflates latency, or balloons token cost past a threshold fails the gate.
**Requirements**: GATE-01 (harness runs as an automated gate), GATE-02 (thresholds on all three axes block regressions)
**Depends on:** Phases 40–42 (gates freeze whatever they achieved). Comes last.
**Success Criteria** (what must be TRUE):

  1. The LOCOMO/LongMemEval/KU + latency + token harness runs as a scripted, automatable gate (CI or pre-merge), reproducibly — GATE-01
  2. The gate enforces thresholds on accuracy, latency (p50/p95), and token cost; a change that regresses any axis past its threshold fails visibly — GATE-02
  3. The gate's baseline numbers are the v8.0-final figures, and the gate is documented so the founder can re-baseline intentionally (not by silent drift) — GATE-03

**Plans:** 0 plans (run `/gsd-plan-phase 43`)
