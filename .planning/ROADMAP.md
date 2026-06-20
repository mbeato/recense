# Roadmap: brain-memory (recense)

## Milestones

- ✅ **v1.0 Core learning loop** — Phases 1–8 (shipped 2026-06-09) — full detail: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Open-Source Release** — Phases 9–10 (shipped 2026-06-10) — full detail: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0 Interface Layer** — Phases 11–17 (shipped 2026-06-13)
- ✅ **v3.1 Schema Depth & Brain-Window Polish** — Phases 18–19 (shipped 2026-06-15)
- ✅ **v4.0 Proactive Memory** — Phases 20–23 (shipped 2026-06-17) — full detail: [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)
- ✅ **v5.0 Foundational Memory Store + Reader Layer** — Phases 24–28 (shipped 2026-06-19) — full detail: [milestones/v5.0-ROADMAP.md](milestones/v5.0-ROADMAP.md)
- 🔲 **v6.0 Project Onboarding** — Phases 29–32 (active)

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

- [ ] 24-01-PLAN.md — verify FK-free clean sleep pass + live [scope] attribution, re-enable hourly agent (SCOPE-01/02 gate)
- [ ] 24-02-PLAN.md — import-memory --dry-run gate check: ≥193 facts, 0 policy-bundle leaks (SCOPE-03)
- [ ] 24-03-PLAN.md — human-gated real import + sleep pass, recall verification, migration report, founder-gated source retirement (SCOPE-04)

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
| 32. Project Recall + Auto-Corpus | v6.0 | 0/TBD | Not started | - |

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

## Phase Details — v6.0 Project Onboarding

recense onboards a fresh/unexplored project into the brain on demand via an agentic survey → episodes → consolidation. Builds on v5.0 scope provenance, the SourceAdapter seam, and the schema-anchored corpus. Spike-first: Phase 29 proves survey quality before the full build.

**Engine invariants across all phases:** single-tenant; graph is source of truth, vector is derived cache; online paths LLM-free (all LLM/embedding cost in the offline sleep pass); origin=`observed` for all survey/doc ingest (never `asserted_by_user`); never strengthen a fact from inferred output; net-zero new runtime deps; summarized semantic knowledge only (no raw code indexing).

- [x] **Phase 29: Survey Quality Spike** (INGEST-03) — prove agentic-survey fact/schema signal on one real project; go/no-go for the build phases (completed 2026-06-20)
- [x] **Phase 30: Core Ingest Command** (INGEST-01/02/04) — `recense ingest-project <dir>`: survey agent → summarized episodes → scope-tagged facts + schemas via the offline pipeline — depends on 29 (completed 2026-06-20)
- [x] **Phase 31: Doc Ingest + Idempotent Re-ingest** (DOCING-01, REINGEST-01/02) — direct project-doc ingest + per-project cursor + in-place belief reconciliation on re-ingest — depends on 30 (completed 2026-06-20)
- [ ] **Phase 32: Project Recall + Auto-Corpus** (RECALL-01/02) — scoped project recall + auto-promoted/-generated schema-anchored corpus doc — depends on 30+31

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

**Plans**: TBD
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

**Plans:** 2 plans

Plans:
**Wave 1**
- [ ] 33-01-PLAN.md — `recense remember` engine + CLI: verbatim curated store + synchronous mini-pass reconsolidation (embed → top-k → judge → D-04 force-reconcile, else insert) + D-03 high-resistance seed + scope-stamp + lock + dispatcher + unit tests (REMEMBER-01, REMEMBER-02)

**Wave 2** *(depends on 33-01)*
- [ ] 33-02-PLAN.md — native-memory cutover: D-06 global CLAUDE.md directive + D-07 settings.json kill-switch investigation + founder-gated one-time verbatim migration of the 12 `.md` files (write → D-08 value_hash verify → D-09 archive); `autonomous: false` (REMEMBER-03)
