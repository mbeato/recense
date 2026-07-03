# Roadmap: brain-memory (recense)

## Milestones

- ✅ **v1.0 Core learning loop** — Phases 1–8 (shipped 2026-06-09) — full detail: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Open-Source Release** — Phases 9–10 (shipped 2026-06-10) — full detail: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0 Interface Layer** — Phases 11–17 (shipped 2026-06-13)
- ✅ **v3.1 Schema Depth & Brain-Window Polish** — Phases 18–19 (shipped 2026-06-15)
- ✅ **v4.0 Proactive Memory** — Phases 20–23 (shipped 2026-06-17) — full detail: [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)
- ✅ **v5.0 Foundational Memory Store + Reader Layer** — Phases 24–28 (shipped 2026-06-19) — full detail: [milestones/v5.0-ROADMAP.md](milestones/v5.0-ROADMAP.md)
- ✅ **v6.0 Project Onboarding** — Phases 29–34 (shipped 2026-06-22) — full detail: [milestones/v6.0-ROADMAP.md](milestones/v6.0-ROADMAP.md). Agentic project survey → episodes → consolidation, generalized doc ingest, idempotent re-ingest, scoped recall + auto-corpus; plus folded-in standalone phases: synchronous curated write (`recense remember`, Phase 33) and cross-surface visual polish (Phase 34).
- ✅ **v7.0 Retrieval & Reasoning Depth** — Phases 35–39.1 (shipped 2026-06-23) — full detail: [milestones/v7.0-ROADMAP.md](milestones/v7.0-ROADMAP.md). Recency/strength-weighted ranking (dark), spike-gated typed predicate edges (37 precision gate GO: typed top-3 83.3% / +45.8pts / payload 3.8 vs 20), stored reflections (REFLECT-01 live, -02 dark), reader wiki-parity (index + backlinks), corpus quality (project-hub + LLM-named subject docs via zero-intervention exhaust-gate + FIX-STALL-01 consolidation fix). Phase 39.1-05 live doc-verification deferred async post-close. Bi-temporal validity + markdown-export explicitly deferred.
- ✅ **Phase 39.2 — Multi-Level Corpus Graph from Schema Projection** (COMPLETE 2026-06-23 — VERIFICATION passed) (INSERTED 2026-06-23, post-v7.0 corpus-thread increment; standalone, runs alongside/before v8.0). Turn the corpus doc layer from a shallow 2-level hub→subject star into a multi-level interconnected doc→doc graph, **derived as a projection of the existing schema/fact graph** — LLM-free, ~$0, no re-ingest, no re-embed, works on docs already in the live DB. Origin: 39.1-05 live verify found `doc_reference` near-empty (4 edges) so every doc relates only to one of two project hubs; the rich structure already exists one layer down (2018 `abstracts` edges + shared facts/entities; subjects carry `subject-schema-ids` meta). Scope: (1) derive `doc_reference` edges subject↔subject + cross-project from shared schema-facts/entities + abstraction-ladder adjacency; (2) multi-level + non-strict/many-to-many containment from the `abstracts` ladder; (3) corpus 2D viz foregrounds the doc→doc graph. OUT of scope (deferred to a later corpus-CONTENT phase): exhaust-rejection LLM-judge, fixing hollow/empty subject docs, killing the ~200 regenerated schema-UUID chapter docs, substantive subject naming. Constraints: LLM-free, graph-as-truth, net-zero deps.

  **Plans:** 4 plans in 3 waves (Wave 1: 39.2-01 | Wave 2: 39.2-02, 39.2-04 | Wave 3: 39.2-03).

  - [x] 39.2-01-PLAN.md — DocGraphDeriver core: LLM-free projection of doc_reference (IDF shared-members + schema_rel adjacency, top-K, union) + multi-level doc_containment (strict-ALL ladder ancestry, multi-parent DAG, acyclic, hub-indexes-all) [wave 1]
  - [x] 39.2-02-PLAN.md — Retire corpus-promoter centroid-cosine doc-edges + wire DocGraphDeriver into Phase C after promote() (D-11 single ownership, D-20) [wave 2]
  - [x] 39.2-03-PLAN.md — Viz + reader foregrounding: scope-hue node coloring, dimmed UUID chapters, 3 distinct edge types, hub-anchored force, richer backlinks [wave 3, human-verify]
  - [x] 39.2-04-PLAN.md — `recense derive-doc-graph` backfill CLI (live one-shot, --dry-run/--db, JSON counts) [wave 2]
  - [x] 39.2-05-PLAN.md — Content rebuild (founder-added at human-verify): fix promoteSubjects index-mapping (empty subject-schema-ids root cause) + existing-subject scope correction + subject→chapter containment + `backfill-subjects` CLI [wave 4]
- ✅ **v8.0 Performance, Efficiency & Competitive Parity** — Phases 40–45 (shipped 2026-06-26) — full detail: [milestones/v8.0-ROADMAP.md](milestones/v8.0-ROADMAP.md). LoCoMo competitive baseline (honest, reproducible: J=86.0% relative-only, R@5/R@10 77.3/82.2%, p50/p95 45/46ms) → zero-dep flat-buffer vector index (warm ~3.4×, byte-exact top-k, killed brute-force cosine at 7000+ nodes) → token/cost audit (marginal write ~7.1k tok/turn, per-source consolSkipThreshold lever) → productization phases folded in: bundled-app settings + cost controls (Phase 44), subscription-default install + billing-leak warning (Phase 45). **Phase 43 (Eval Regression Gates) DEFERRED — not built; GATE-01/02/03 + Phase 41 PERF-03(b) carried forward.** Hard rule held: every competitive number reproducible or cited — no inflated metrics.
- 🚧 **v9.0 Memory Quality** — Phases 46–50 (in progress) — Reconsolidation candidate broadening (resolves backlog 999.2 — judge fires on real KU contradictions), hybrid BM25+dense retrieval on the LLM-free hot path, correctness hardening (C-2/M-5/M-9/L-2), scale+data-model spike (vectorlite ANN crossover; bi-temporal recommendation), verification + regression gates (discharges deferred Phase 43). Grounded in June-2026 deep-research pass; all external magnitudes are preprints — validate on own data.

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

**Plans**: 3 plans + 2 gap-closure (SC2 / WR-01-02-03)

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

### v9.0 Memory Quality (Phases 46–50) — IN PROGRESS

Goal: make recense's belief-correction and retrieval work on messy real-world data and lock the gains behind regression gates, validated on LoCoMo / LongMemEval-KU / EVAL-02.

**Dependency shape:** Phase 47 depends on 46 (reuses candidate machinery). Phase 50 depends on 46–48. Phase 48 and 49 are independent — can run in parallel with 46/47.

**Engine invariants across all phases:** single-tenant; graph is source of truth, vector is derived cache; online paths stay LLM-free; never strengthen a fact from inferred output (self-confirmation guard); no accuracy regression accepted for a latency/token win; net-zero new runtime deps.

- [x] **Phase 46: Reconsolidation Candidate Broadening** — decouple contradiction-candidate generation from the single cosine gate (entity/subject-keyed + BM25 node_fts + dense union) so the belief-update judge actually fires on real KU contradictions (today: zero) (completed 2026-06-28)
- [x] **Phase 47: Hybrid Retrieval Recall** — BM25+dense fusion (RRF/z-score, tunable scalar) on the LLM-free hot path to lift LoCoMo R@5/R@10 with no per-category regression; depends on 46 (completed 2026-06-30)
- [x] **Phase 48: Correctness Hardening** — close C-2 self-confirmation loop, immediate() write txns (M-5), schema-version read-first guard (M-9), embedding model/dims stamp+assert (L-2); each with a regression test; independent of 46/47 (completed 2026-06-28)
- [x] **Phase 49: Scale + Data-Model Spike** — measure vectorlite ANN vs brute-force crossover at real node scale + go/no-go; written bi-temporal/supersedes-vs-tombstone recommendation with migration cost; independent; a "defer" outcome is valid (completed 2026-06-28)
- [x] **Phase 50: Verification + Regression Gates** — re-run full eval suite on the improved pipeline, prove Phase-46 judge fires on real contradictions, lock regression gates (on-demand `npm run gate`, not CI — D-01), update docs/evals.md; depends on 46–48
- [x] **Phase 51: WASM SIMD Exact-Scan Kernel** — replace the scalar-JS exact cosine scan with a portable prebuilt WASM `f32x4` dot-product kernel (no node-gyp); byte-exact (recall@10=1.000), ~4.9× kernel speedup measured in the Phase-49 spike; fold reciprocal-norm + partial-select top-k for the full win. Removes scale pressure to ~85k–190k nodes with zero approximation and zero new native deps; defers ANN. Depends on 50 (gates catch any regression) (completed 2026-06-30)

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
| _(35–39.1 shipped under tag `v7.0` 2026-06-23 — see milestones/v7.0-ROADMAP.md; per-row entries not backfilled)_ | v7.0 | — | Complete | 2026-06-23 |
| 39.2. Multi-Level Corpus Graph (inserted, folded into v8.0) | v8.0 | 5/5 | Complete | 2026-06-23 |
| 39.3. Reader Generation Phase-Status (inserted, folded into v8.0) | v8.0 | 4/4 | Complete | 2026-06-23 |
| 40. Competitive Benchmark Baseline | v8.0 | 5/5 | Complete | 2026-06-24 |
| 41. Vector Index + Hot-Path Latency | v8.0 | 3/3 | Complete | 2026-06-25 |
| 42. Token / Cost Efficiency Audit | v8.0 | 4/4 | Complete | 2026-06-25 |
| 43. Eval Regression Gates | v8.0 | 0/0 | **Deferred (not built)** | — |
| 44. Bundled-App Settings & Cost Controls | v8.0 | 6/6 | Complete | 2026-06-26 |
| 45. Subscription-Default Install & Billing-Leak Warning | v8.0 | 6/6 | Complete | 2026-06-26 |
| 46. Reconsolidation Candidate Broadening | v9.0 | 2/2 | Complete   | 2026-06-28 |
| 47. Hybrid Retrieval Recall | v9.0 | 3/3 | Complete   | 2026-06-30 |
| 48. Correctness Hardening | v9.0 | 2/2 | Complete    | 2026-06-28 |
| 49. Scale + Data-Model Spike | v9.0 | 3/3 | Complete   | 2026-06-28 |
| 50. Verification + Regression Gates | v9.0 | 2/4 | In Progress|  |
| 51. WASM SIMD Exact-Scan Kernel | v9.0 | 5/5 | Complete    | 2026-06-30 |

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

> **✅ SHIPPED 2026-06-26** (phases 40–45; Phase 43 deferred — see below). Archived: [milestones/v8.0-ROADMAP.md](milestones/v8.0-ROADMAP.md). 24 plans (40:5, 41:3, 42:4, 44:6, 45:6) + folded-in standalone corpus increments 39.2 (5) / 39.3 (4). Suite green at close: 2383 passed / 3 skipped. **Phase 43 (Eval Regression Gates) was NOT built** — empty dir, deferred behind Phase 42's reset-window eval; GATE-01/02/03 + Phase 41 PERF-03(b) carried forward as the next milestone's opener. The detail below is retained as history.

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

### Phase 39.3: Reader Generation Phase-Status + Lock-Aware Queueing (INSERTED)

**Goal:** Fix the reader's doc-generation feedback so it tells the truth about what the generator is doing. Today a regenerate click on a busy engine (sleep pass holding the write lock) loses the lock race: the detached `generate-doc` CLI bails at `acquireLock()` — exiting `0`, identical to success, with no log line — the read-only viz server can't see why, and the reader falls back to a `generated_at`-comparison hack that shows a generic "timed out or errored." Replace this with (1) a per-phase progress UI driven by the generator's real pipeline stages, and (2) a genuine queue: on lock contention the CLI **waits** (re-stamping `queued`) instead of dying, giving up only after the doc-gen timeout budget with an honest `failed` end-state. Status crosses the detached-child→read-only-server boundary via a per-slug status file (the server only ever reads it — T-27-11 preserved). Reader/viz-only; the engine, online paths, and write model are untouched.
**Requirements**: RGS-01 (reader surfaces named generation phases queued→gathering→generating→verifying→finalizing, replacing the pure time-estimate bar), RGS-02 (lock-contention becomes a real wait-queue with give-up-after-budget, not a silent bail), RGS-03 (status flows child→server via a per-slug status file read by the read-only server; authoritative `failed` phase replaces the `generated_at` silent-no-op hack; no engine/online-path change)
**Depends on:** Phase 39 reader layer + Phase 27/28 corpus reader + generate-doc CLI / viz server (all live). Independent of the v8.0 perf line — standalone reader-ergonomics increment, same pattern as inserted 39.1/39.2.
**Success Criteria** (what must be TRUE):

  1. The reader shows the generator's real phase by name — `queued`, `gathering`, `generating`, `verifying`, `finalizing` — with the long `generating` phase keeping a time estimate and the others rendered as discrete steps; the prior pure-estimate elapsed bar is gone — RGS-01
  2. A regenerate (or lazy-open generate) issued while another process holds the write lock does NOT bail — the CLI parks in `queued`, re-acquires when the lock frees, and proceeds; if the lock never frees within the doc-gen timeout budget the reader shows an honest `failed: engine stayed busy`, not an infinite spinner — RGS-02
  3. Status crosses the detached-child→server boundary through a per-slug status file: the CLI is the only writer, the viz server only reads it (DB handle stays read-only — T-27-11), and an authoritative `failed` phase (with reason) replaces the reader's `prevGeneratedAt`/`fetchGeneratedAt` silent-no-op detection; generic "timed out or errored" string removed — RGS-03
  4. No engine or online-path change: no new node/edge types, no write-path mutation, no online LLM cost; the status file is `/tmp`-scoped and path-safe (URL-supplied slug cannot traverse), stale files (crashed child) are treated as absent — RGS-03

**Plans:** 4/4 plans complete

- [x] 39.3-01-PLAN.md — gen-status.ts foundation: shared per-slug status-file module (PHASES, hashed path-safe statusPath, atomic writeStatus, stale-aware readStatus, clearStatus) + unit tests (RGS-03) [wave 1]
- [x] 39.3-02-PLAN.md — doc-generator onPhase callbacks (FS-free phase events) + CLI bounded lock-wait loop (queued re-stamp, give-up-after-budget → failed:engine stayed busy) + onPhase→writeStatus + finalizing/done/failed wiring; lockfile.ts untouched (RGS-01/02/03) [wave 2]
- [x] 39.3-03-PLAN.md — viz server send202Generating reads gen-status, forwards { status:'generating', phase, elapsedMs, error? }; DB handle stays read-only (RGS-01/03) [wave 2]
- [x] 39.3-04-PLAN.md — reader phase-aware stepper (generating keeps the time estimate, others discrete) + poll-loop phase/error handling + DELETE prevGeneratedAt/fetchGeneratedAt silent-no-op hack & generic 'timed out or errored' string; founder visual checkpoint (RGS-01/03) [wave 3, human-verify]

### Phase 40: Competitive Benchmark Baseline ✅ COMPLETE (2026-06-24 — VERIFICATION passed; BENCH-01/02/03 all PASS)

> **Baseline landed (v7.0 SUT, commit `d41d5c8`).** LoCoMo-10: **J=86.0%** (lenient mem0 Appendix-A judge — explicitly NOT a clean mem0 win; 68% of hedged non-answers judged CORRECT, so cited relative-only), retrieval **R@5/R@10 = 77.3/82.2%**, live-brain retrieval **p50/p95 = 45/46 ms** over ~11.3k nodes, synthetic curve 1k–20k. Full numbers + reproduction + no-inflated-metrics caveats in `40-BASELINE.md`; competitor targets in `40-COMPETITOR-TARGETS.md`. SUT deliberately froze TRUE v7.0 (excludes Phase 39.2 corpus machinery that had crept into `runConsolidation` at HEAD).

**Goal:** Stand up an apples-to-apples competitive benchmark and record honest baselines on all three axes, so "at or above competitors" becomes a falsifiable target instead of a slogan. Adds LOCOMO (the bench mem0/Zep actually cite) alongside the existing LongMemEval + KU replay harness; captures recense's current accuracy, retrieval latency (p50/p95), and token cost per write+recall; and pins the specific competitor numbers to beat with their sources.
**Concrete competitor targets (researched 2026-06-20, treat with methodology skepticism):** MemPalace claims LongMemEval R@5 **96.6%** (BUT the independent source teardown shows this is measured in "raw mode" = ChromaDB's default embedding model with the palace structure NOT involved — it measures the embedder, not the architecture; their lossy compression drops it to 84.2%) and LoCoMo R@10 **88.9%**, ConvoMem 92.9%; mem0 markets "~26% more accurate / 91% lower latency / 90% fewer tokens vs OpenAI memory"; Zep/Graphiti publish DMR + LongMemEval. claude-mem publishes **no accuracy benchmark** — only a "~10x token savings" retrieval claim. **Lesson baked into BENCH-03: a competitor headline number must be understood (what configuration/metric/dataset slice produced it) before it counts as a target — citing it is not enough.**
**Requirements**: BENCH-01 (LOCOMO harness runs reproducibly on recense), BENCH-02 (baseline accuracy/latency/token recorded), BENCH-03 (competitor targets cited AND methodology-understood — no inflated/unsourced/misread numbers)
**Depends on:** v7.0 complete (system under test is final). Gates Phases 41–43.
**Success Criteria** (what must be TRUE):

  1. LOCOMO runs against recense reproducibly (scripted, re-runnable) and produces an accuracy score alongside the existing LongMemEval + KU harness — BENCH-01
  2. A written baseline records recense's current accuracy, retrieval latency (p50/p95 on the live ~7000-node brain), and token cost per write and per recall — BENCH-02
  3. The competitor numbers to beat (mem0, Zep/Graphiti, MemPalace on LOCOMO/DMR/LongMemEval) are documented with their published sources AND with a one-line note on what each number actually measures (e.g. MemPalace's 96.6% = raw-embedder mode, not architecture); every recense number is reproducible from a committed script — no unsourced, rounded-up, or methodology-misread figures (founder no-inflated-metrics rule, applied to reading competitors too) — BENCH-03

**Plans:** 5/5 plans complete

- [x] 40-01-PLAN.md - Wave 0 foundation: acquire LoCoMo-10 (gitignored), verify category codes by count, dry-run fixture, category-5 + R@K unit-test scaffolds (BENCH-01)
- [x] 40-02-PLAN.md - locomo-harness.cjs: clone longmemeval harness, JSON-array loader, per-session ingest + consolidate-once, category-5 skip, retrieval-only latency, session-level R@K, --run/--probe/--dry-run gates (BENCH-01, BENCH-02)
- [x] 40-03-PLAN.md - locomo-scorer.cjs: mem0 Appendix A judge (gpt-4o-mini/temp-0/max_tokens-10), category-5 denominator, D-10 v7.0 config snapshot in meta (BENCH-02, BENCH-03)
- [x] 40-04-PLAN.md - latency-curve.cjs (retrieval-only p50/p95 vs N, public node pool) + 40-COMPETITOR-TARGETS.md methodology note (Zep 84% DO-NOT-CITE, mem0 66.88% primary) (BENCH-02, BENCH-03)
- [x] 40-05-PLAN.md - operator-gated: D-01 cost probe HARD GATE + official baseline run on v7.0-tagged SUT + 40-BASELINE.md write-up (autonomous: false) (BENCH-02)

### Phase 41: Vector Index + Hot-Path Latency

**Goal:** Replace brute-force O(N) cosine on the hot recall path with the unbuilt `sqlite-vec`/HNSW vector-index seam, and profile/optimize the latency-critical surfaces (recall, SessionStart inject). The live brain is already 7000+ nodes — past the stated ~5K comfort zone for brute-force scan — so this is the headline latency lever. The index is a derived, rebuildable cache (graph stays source of truth); the online path stays LLM-free.
**Requirements**: PERF-01 (vector index replaces brute-force cosine, derived/rebuildable), PERF-02 (recall + SessionStart inject latency profiled and measurably improved vs the Phase 40 baseline), PERF-03 (no accuracy regression on the harness)
**Depends on:** Phase 40 (baseline to measure against). Independent of Phase 42 — can run in parallel.
**Success Criteria** (what must be TRUE):

  1. Recall nomination uses an ANN/vector index (`sqlite-vec` or HNSW) instead of brute-force cosine; the index is derived from node embeddings and rebuildable from the graph (never authoritative) — PERF-01
  2. Retrieval p50/p95 and SessionStart inject latency improve measurably vs the Phase 40 baseline on the live-scale brain; the online path remains LLM-free — PERF-02
  3. Accuracy on LOCOMO/LongMemEval/KU shows no regression vs baseline — a latency win that costs accuracy is rejected — PERF-03

**Plans:** 3/3 plans complete

Plans:
**Wave 1**

- [x] 41-01-PLAN.md — Spike: instrumented cold+warm comparison harness (zero-dep flat-buffer vs sqlite-vec vs brute-force) on the live brain; records the mechanism decision → zero-dep flat-buffer sidecar (PERF-01, PERF-02)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 41-02-PLAN.md — Build the chosen exact index behind CandidateRetriever (real cosine scores, persisted, end-of-pass build; consolidator stays brute-force) (PERF-01)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 41-03-PLAN.md — Gates: top-k equivalence (PERF-03(a) PASS, byte-exact 40/40) + cold+warm latency delta vs Phase 40 baseline (PERF-02 PASS — warm 13/14ms ~3.4×, cold 72/77ms −24ms). PERF-03(b) 3-harness end-to-end re-run OPEN (hours-scale consolidation; needs user approval — see 41-PERF-REPORT.md)

### Phase 42: Token / Cost Efficiency Audit

**Goal:** Measure recense's token/cost profile end-to-end and tune it, then quantify the savings vs competitors defensibly. recense's "pay at sleep, save at recall" architecture is a token-efficiency bet that has never been measured against a competitor; v7.0's ranking + reflections promised recall-token savings — this phase proves whether they paid off. Measures write cost (Haiku extract / Sonnet judge), recall inject cost, and tunes the levers (`consolSkipThreshold`, inject/neighborhood budget).
**Progressive-disclosure evaluation (founder-directed 2026-06-20):** both competitors lead with **progressive-disclosure retrieval** as their token mechanism — claude-mem's `search`(compact index)→`timeline`→`get_observations`(detail on demand, ~10x claim), MemPalace's L0→L3 layered load. recense uses a *different* strategy (schema-prior compression + bounded budgets). This phase **evaluates** progressive disclosure (likely in the MCP/recall surface) head-to-head against recense's current strategy and **adopts it only if the harness shows a real token win with no accuracy loss** — measured, not on faith (baseline-first discipline). Declining is a valid outcome if schema-prior compression already wins.
**Requirements**: COST-01 (per-write + per-recall token cost measured against baseline), COST-02 (levers tuned for a measured net reduction with no accuracy regression), COST-03 (savings vs competitors stated defensibly with sources), COST-04 (progressive-disclosure evaluated vs schema-prior compression; adopted only on a measured token win)
**Depends on:** Phase 40 (baseline). Independent of Phase 41 — can run in parallel.
**Success Criteria** (what must be TRUE):

  1. ✅ **COST-01 (measured 2026-06-25, deferred-run battery):** marginal write path (Haiku extract+judge) = **~7,118 tok/turn, 0% Sonnet escalation** (27 Haiku calls / 99,647 tok / $0.33); corpus-gen is a separate backlog subsystem (Sonnet 28 calls / 271,288 tok / $1.54 / 22 docs) and the naive 26,495 tok/turn headline overstates marginal write ~3.7×. Clean breakeven ~6.2 sessions (vs naive 22.9). Source: `scripts/eval/results/42-writeside-breakdown-measured.json`.
  2. ✅ **COST-02 (validated 2026-06-25 by $0 live-brain inspection, NOT synthetic benchmarks — KU/LoCoMo/LongMemEval all force salience=1.0, lever no-op):** global 0.5 rejected as UNSAFE (drops project-survey [8 high-band] + project-doc [42 high-band] knowledge). **Per-source `consolSkipThreshold: { 'claude-code': 0.5 }` applied** (2,444 affected claude-code episodes are conversational noise) — captures ~87% of the token win with near-zero knowledge loss. STEP 4 (LoCoMo/LongMemEval no-regression confirm) **SKIPPED** per founder decision (lever-blind + ~7.4hr/OpenAI-$ to reproduce the frozen v7.0 baseline while proving nothing about the lever).
  3. The token-efficiency claim vs competitors (e.g. mem0's ~90% / claude-mem's ~10x retrieval savings) is stated with both recense's reproduced number and the cited competitor figure — no inflated comparison — COST-03
  4. Progressive-disclosure retrieval (index-first → detail-on-demand) is benchmarked against recense's schema-prior compression on the token axis; adopted into the recall/MCP surface only if it shows a measured token win with no accuracy regression, else explicitly declined with the numbers — COST-04

**Plans:** 4/4 plans complete

Plans:
**Wave 1** *(parallel — no file overlap)*

- [x] 42-01-PLAN.md — Lever-sweep harness: greedy one-at-a-time per-lever token attribution + KU inner-loop gate (cheap parts run now; write-side instrumented but deferred) (COST-01, COST-02)
- [x] 42-02-PLAN.md — Progressive-disclosure A/B harness: claude-mem fact-index→detail vs recense one-shot inject, oracle + fixed-top-K brackets; LLM-free $0 run now; decline-with-numbers valid (COST-04)

**Wave 2** *(blocked on Wave 1)*

- [x] 42-03-PLAN.md — Competitor-savings report: reproduced recall-side headline + write-side breakeven separate + mem0/claude-mem cited with methodology notes (COST-03)

**Wave 3** *(blocked on Wave 2; autonomous: false)*

- [x] 42-04-PLAN.md — Deferred-run runbook + cost-probe hard gate: documented reset-window procedure for the write-side breakdown + LOCOMO/LongMemEval no-regression confirm (D-06 defer-the-run) (COST-01, COST-02)

### Phase 43: Eval Regression Gates

**Goal:** Turn the benchmark harness into a CI gate so the accuracy/latency/token numbers won earned in 40–42 can't silently regress. "Lock down performance" means continuous, not one-shot — a PR that drops accuracy, inflates latency, or balloons token cost past a threshold fails the gate.
**Requirements**: GATE-01 (harness runs as an automated gate), GATE-02 (thresholds on all three axes block regressions)
**Depends on:** Phases 40–42 (gates freeze whatever they achieved). Comes last.
**Success Criteria** (what must be TRUE):

  1. The LOCOMO/LongMemEval/KU + latency + token harness runs as a scripted, automatable gate (CI or pre-merge), reproducibly — GATE-01
  2. The gate enforces thresholds on accuracy, latency (p50/p95), and token cost; a change that regresses any axis past its threshold fails visibly — GATE-02
  3. The gate's baseline numbers are the v8.0-final figures, and the gate is documented so the founder can re-baseline intentionally (not by silent drift) — GATE-03

**Plans:** 0 plans (run `/gsd-plan-phase 43`)

### Phase 44: Bundled-App Settings & Cost Controls

**Goal:** User-facing settings/toggles so a bundled-app user can control which *token-spending* features run — without a re-architecture. Token cost is recense's only real marginal cost and it's wildly uneven across features; a distributable app needs both control (toggle off what you don't value) and transparency (see what's spending).

**Track/timing:** PRODUCTIZATION — belongs on the distribution / tray-app track, matters when onboarding a non-founder user (Tonos as early client, then third parties). NOT a v8.0 (perf/parity) item. Orthogonal to the eval/perf phases (40–43); depends on nothing in them. For customer-zero (founder), env vars already suffice.

**Key insight — the levers already exist as env/config; the gap is a settings *surface* (no `src/adapter/*settings*`):**

- `RECENSE_CORPUS_GEN=0` → skip readable corpus docs entirely (the highest-cost, most-optional feature — Sonnet doc-gen ~42s each)
- `RECENSE_CORPUS_GEN_MAX` (25) → docs-per-pass throttle
- `consolSkipThreshold` / `consolSkipThresholdBySource` → gate low-salience turns out of the dominant Haiku extraction cost
- `corpusSubjectDriftThreshold` (3) → subject-doc re-promote frequency
- sleep-pass cron frequency → how often *any* cost-bearing work runs

**Scope:**

1. **Presets over a wall of switches:** *Lite* (extract + reconsolidation only — the non-optional moat), *Standard* (+ schema abstraction), *Full* (+ readable corpus docs).
2. **Granular toggles** for the cost-bearing pieces (the levers above).
3. **Token-usage readout** — "this period you spent N tokens, M on readable docs" (the contextscope instinct applied inward).

**Guardrail (load-bearing):** the core (extract + prediction-error reconsolidation) is **non-optional** — toggling it off = not recense. The optional layer is corpus docs, schema depth, viz, frequency. Make that line explicit so a user can't accidentally gut the value.

**Architecture note:** the online hook is already LLM-free — **100% of token cost lives in the offline sleep pass** — so this is a *switch on the offline pass*, NOT a re-architecture to "run it elsewhere." Readable docs are already lazy/offline.

**Cheap MVP (~a day, if wanted before the full phase):** surface just `RECENSE_CORPUS_GEN` + sleep frequency + salience threshold via a `recense config` command. Full presets + usage readout + tray UI is the phase.

**Depends on:** Nothing in 40–43 — orthogonal productization/distribution-track phase (independent of the perf/parity line). Promoted from backlog 2026-06-24; sequenced as the next actionable phase while Phase 43 is deferred behind Phase 42's reset-window eval. Standalone (not folded into the v8.0 perf milestone), same pattern as the inserted Phase 39.2.

**Requirements:** none (no Phase-44 IDs in REQUIREMENTS.md; plans trace to locked decisions D-01..D-12 in 44-CONTEXT.md)

**Plans:** 6/6 plans complete

- [x] 44-01-PLAN.md — Settings types + merge loader (settings.json, env>file>preset>DEFAULT precedence, D-12 core guardrail)
- [x] 44-02-PLAN.md — Wire merged config into sleep-pass + ingest call sites (corpus-gen + schema-induction gating, env still wins)
- [x] 44-03-PLAN.md — Token-usage ledger table + feature-tagged live sink (best-effort, never aborts the pass)
- [x] 44-04-PLAN.md — `recense config` CLI (show/get/set/preset/apply) + launchd frequency regen
- [x] 44-05-PLAN.md — viz-server GET/POST /settings + GET /usage routes (localhost-only, key-whitelisted)
- [x] 44-06-PLAN.md — viz frontend settings panel + token readout (no new IPC; human visual check)

### Phase 45: Subscription-Default Install & Billing-Leak Warning

**Goal:** Make `claude -p` Max-subscription billing the default for the sleep-pass and simplify the install flow around it, while surfacing the real direct-API billing footgun instead of a false safety guarantee. Today the in-code default is still direct-API (`config.ts` `modelProvider:'anthropic'`) and the env-strip "billing-leak fixed" claim is false in practice — `ANTHROPIC_API_KEY` in `~/.claude/settings.json` re-injects into `claude -p` and bills the API. Subscription should be the default; the footgun should be named (warn-only), not silently "handled."
**Design/PRD (read before planning):** `docs/superpowers/specs/2026-06-26-subscription-default-install-design.md`
**Scope:** (1) flip `DEFAULT_CONFIG.modelProvider` → `claude-headless`; (2) restructure `recense init` (provider step with subscription default, drop the required Anthropic key on the subscription path, acknowledge-gate when the settings.json key is detected); (3) `recense doctor` — new billing-posture dimension + `claude` CLI login check + rework the API-key dimension; (4) README + `docs/evals.md` staleness.
**Constraints (load-bearing):** OpenAI key still required (embeddings — subscription covers Anthropic only); recense never edits `~/.claude/settings.json` (detect + warn only); no inflated safety claims (the env-strip must not be described as preventing API billing).
**Depends on:** Phase 44 (settings surface). Orthogonal to the dropped Phase 43 eval-gate work.
**Success Criteria** (what must be TRUE):

  1. A fresh `recense init` defaults to subscription billing and produces a working sleep-pass without an Anthropic API key (OpenAI key still required)
  2. When `ANTHROPIC_API_KEY` is present in `~/.claude/settings.json`, `init` blocks on an acknowledgement and `recense doctor` flags it as a failing dimension until resolved, and recense never edits that file
  3. `recense doctor` verifies the `claude` CLI is present + logged in, and no longer reports a missing Anthropic key as a failure under subscription mode

**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 45-01-settings-key-detector-PLAN.md — shared ~/.claude/settings.json ANTHROPIC_API_KEY detector (D-14, keystone)
- [x] 45-02-config-default-flip-PLAN.md — flip DEFAULT_CONFIG.modelProvider to claude-headless + reconcile fallout (D-01/02/03)
- [x] 45-03-docs-prereqs-and-staleness-PLAN.md — README subscription prereqs + footgun line; evals.md staleness note (D-15/16)
- [x] 45-04-billing-leak-investigation-PLAN.md — empirical D-17 leak reproduction (autonomous:false, records finding)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 45-05-init-subscription-path-PLAN.md — init provider step + subscription path + acknowledge gate (D-04..D-10)
- [x] 45-06-doctor-billing-and-cli-PLAN.md — doctor billing-posture + claude-CLI probe + reworked api-key dimension (D-11/12/13)

## Phase Details — v9.0 Memory Quality

recense moves from "correctness on clean cases" to "correctness on messy real-world data" — making the PE-gated reconsolidation judge actually fire on real contradictions and lifting retrieval recall, then locking the gains behind CI regression gates. Every new mechanism is grounded in the June-2026 deep-research pass: dense cosine structurally cannot separate contradictions/negations (NevIR near-random; "Semantic Collapse"), so the fix is broadening candidate generation, not swapping the embedder.

**Engine invariants across all phases:** single-tenant; graph is source of truth, vector is derived cache; online paths stay LLM-free; never strengthen a fact from inferred output (D-43); no accuracy regression accepted for a latency/token win; net-zero new runtime deps.

### Phase 46: Reconsolidation Candidate Broadening

**Goal**: Decouple contradiction-candidate generation from the single cosine gate so the PE-gated belief-update judge actually fires on real LongMemEval-KU contradictions (today: zero fires — contradicting facts embed at cosine ~0.48 and never clear the 0.7 escalation gate). Generate candidates via a union of entity/subject-keyed graph lookup + BM25 lexical (`node_fts` FTS5) + dense top-k, feeding the existing Sonnet judge, without regressing EVAL-02 clean cases or load-bearing invariants.
**Depends on**: Nothing — first phase of v9.0
**Requirements**: RECON-01, RECON-02, RECON-03, RECON-04
**Success Criteria** (what must be TRUE):

  1. For each new fact, candidate generation produces a union of (a) entity/subject-keyed graph lookup, (b) BM25 `node_fts` FTS5 lexical match, and (c) dense top-k cosine — the cosine gate alone no longer determines the candidate set — RECON-01
  2. The union candidate set is fed to the existing Sonnet judge for ADD/UPDATE/contradict screening; all existing provenance, tombstone, and self-confirmation guards are preserved — RECON-02
  3. On LongMemEval-KU, the reconsolidation judge fires on real contradictions — measurably above zero (ideally a majority of true-contradiction cases), verifiable via escalation/judge-call counters — RECON-03
  4. KU belief-correction improves measurably vs the extraction+recency-only baseline; EVAL-02 clean-case belief-correction shows no regression; load-bearing invariants intact (no self-confirmation minting, no evidence-backed node deleted by decay) — RECON-04

**Plans**: 2 plans

- [x] 46-01-PLAN.md — BM25 lexical candidate broadening: config knob, consolidator union/D-04 gate/D-06 counters, unit tests (RECON-01, RECON-02)
- [x] 46-02-PLAN.md — Validate on LongMemEval-KU: judge-fire (contradict) counter > 0 A/B + EVAL-02 clean-case no-regression (RECON-03, RECON-04)

### Phase 47: Hybrid Retrieval Recall

**Goal**: Lift LoCoMo session-level R@5/R@10 by fusing BM25 (`node_fts`) + dense retrieval on the LLM-free online hot path, with no per-category regression and latency within the live-brain p50 budget (~45 ms today). Reuses the Phase 46 BM25 + candidate machinery. Research note: an off-the-shelf reranker over fused top-k HURT in the June-2026 research — do NOT add a reranker without measuring.
**Depends on**: Phase 46 (BM25 node_fts candidate machinery is live and validated)
**Requirements**: RETR-01, RETR-02, RETR-03, RETR-04
**Success Criteria** (what must be TRUE):

  1. Online retrieval fuses BM25 (`node_fts`) + dense via RRF or z-score-normalized weighted score; no LLM calls introduced on the hot path — RETR-01
  2. The fusion weight is a single tunable scalar exposed in config, with a default selected via held-out evaluation — RETR-02
  3. R@5/R@10 improve on LoCoMo vs the pure-dense baseline with no per-category regression — RETR-03
  4. Hot-path retrieval latency stays within budget (live-brain p50 ~45 ms today); profiled and confirmed on the live brain — RETR-04

**Plans**: 3 plans

- [x] 47-01-PLAN.md — expose bm25FusionWeight as a config scalar threaded into hybridTopk/retrieveRanked (dark default 0)
- [x] 47-02-PLAN.md — held-out bm25FusionWeight sweep on LoCoMo → **w\*=0 null result** (BM25 fusion does not beat dense cosine; ship dark). Held-out temporal-reasoning lead logged as follow-up.
- [x] 47-03-PLAN.md — thread queryForEmbed into responder.respond→retrieveRanked + set DEFAULT_CONFIG.bm25FusionWeight=w* (no-op at w*=0)

### Phase 48: Correctness Hardening

**Goal**: Close four load-bearing correctness gaps identified in the ARCH-REVIEW — the C-2 self-confirmation loop, M-5 write-txn isolation, M-9 schema-version read-first guard, and L-2 embedding model/dims stamp+assert — each with a regression test that fails before the fix and passes after. Independent of Phases 46/47 and can run in parallel.
**Depends on**: Nothing — independent of Phases 46/47; can run in parallel
**Requirements**: HARD-01, HARD-02, HARD-03, HARD-04
**Success Criteria** (what must be TRUE):

  1. Assistant output entering as `origin:'observed'` cannot strengthen a fact without a judge call; the C-2 self-confirmation loop is closed and verified by a test that RED-fails before the fix — HARD-01
  2. All write transactions in the consolidator (Phase B) and `txUpsertNode` use `db.transaction().immediate()` so a lost upgrade race no longer aborts the sleep pass on `SQLITE_BUSY_SNAPSHOT`; regression test RED-fails before fix — HARD-02
  3. `initSchema` reads the stored `SCHEMA_VERSION` first and throws a descriptive error on `stored > compile-time`; a stale binary can no longer silently re-stamp a newer schema; regression test RED-fails before fix — HARD-03
  4. Embedding model + dims are stamped in meta at first embed and asserted on every write/decode call; a model or dims change fails closed instead of silently producing NaN cosines; regression test RED-fails before fix — HARD-04

**Plans**: 2 plans

- [x] 48-01-PLAN.md — HARD-04: stamp+assert embedding_model in setEmbedding (mirrors dims guard) + regression tests
- [x] 48-02-PLAN.md — HARD-01/02/03: audit C-2/M-5/M-9 guards, label existing tests, write the missing M-5 IMMEDIATE-mode test

### Phase 49: Scale + Data-Model Spike

**Goal**: Produce a written, evidence-backed answer to two architecture questions that currently sit as open decisions: (1) at what node scale does the exact flat-buffer vector index cross over with an approximate ANN (vectorlite/HNSW), and (2) should the reconsolidation model add bi-temporal validity intervals and/or doubly-linked supersedes chains vs the current tombstone approach? A "defer" outcome on either question is an explicit valid result — the point is to measure and decide, not to adopt.
**Depends on**: Nothing — independent spike; can run in parallel with Phases 46/47/48
**Requirements**: SCALE-01, SCALE-02
**Success Criteria** (what must be TRUE):

  1. A scripted crossover measurement (vectorlite HNSW vs brute-force O(N) cosine) is run over recense's actual node scale (~10–50k synthetic + live brain); recall/latency crossover point is identified; a written go/no-go is produced — SCALE-01
  2. A written recommendation on Zep-style bi-temporal validity intervals and/or DCPM-style doubly-linked supersedes chains vs the current tombstone reconsolidation model is produced, with better-sqlite3 migration cost estimated — SCALE-02

**Plans**: 3 plans

- [x] 49-01-PLAN.md — provision HNSW ANN as a bench-only devDependency + verify loadability early (D-02/D-02b)
- [x] 49-02-PLAN.md — build + run the crossover benchmark (exact cosine vs HNSW over 11.3k/25k/50k nodes; recall@k, p50/p95, build, memory)
- [x] 49-03-PLAN.md — write 49-SPIKE-FINDINGS.md: SCALE-01 go/no-go + SCALE-02 bi-temporal/supersedes-vs-tombstone recommendation + migration cost

### Phase 50: Verification + Regression Gates

**Goal**: Re-run the full eval suite (EVAL-02 strict-semantic+substring, LoCoMo strict-J+R@K, LongMemEval-KU finish-78) on the improved pipeline from Phases 46–48, prove the Phase 46 judge fires on real contradictions with counters, lock CI/pre-merge regression gates on all three axes + belief-correction + retrieval recall, and update `docs/evals.md` with new numbers and judge-validation evidence. Discharges the deferred Phase 43. Runs after Phases 46–48 land.
**Depends on**: Phase 46 (candidate broadening), Phase 47 (hybrid retrieval), Phase 48 (correctness hardening)
**Requirements**: GATE-01, GATE-02, GATE-03
**Success Criteria** (what must be TRUE):

  1. An automated CI/pre-merge gate runs the eval harness reproducibly and blocks merges that regress below thresholds — GATE-01
  2. Gate thresholds cover accuracy (EVAL-02 belief-correction + LoCoMo J), retrieval recall (R@5/R@10), latency (p50/p95), and token cost; any axis regression past its threshold fails visibly — GATE-02
  3. Baseline is intentionally re-set to v9.0-final figures; the full eval suite is re-run with documented before/after deltas; Phase 46 judge-fires on real KU contradictions are proved via escalation counters; `docs/evals.md` is updated with new numbers and judge-validation evidence — GATE-03

**Plans**: 4 plans

- [x] 50-01-PLAN.md — Cheap LLM-free deterministic gate runner (R@K, latency, token-structural, binary judge-fire) + floor/ceiling baseline + npm scripts
- [x] 50-02-PLAN.md — Opt-in paid accuracy-tier gate (gate:accuracy: LoCoMo-J + EVAL-02 + KU), key-guarded, never in the cheap path
- [x] 50-03-PLAN.md — Record fresh v9.0-final baseline + fresh EVAL-02 n=13 (discharges RECON-04)
- [x] 50-04-PLAN.md — docs/evals.md v9.0-final record: honest provenance, 368-contradicts judge evidence, before/after deltas, deferred-check discharge

### Phase 51: WASM SIMD Exact-Scan Kernel

**Goal**: Replace the scalar-JS exact cosine scan on the LLM-free retrieval hot path with a portable, prebuilt WASM SIMD (`f32x4`) dot-product kernel — keeping the flat brute-force structure (no ANN graph, no index lifecycle, no tombstone-rebuild) and byte-exact recall, while cutting scan latency ~4–5×. This is the Phase-49 spike's chosen alternative to adopting an approximate ANN: it removes scale pressure to ~85k–190k nodes with zero approximation surface and zero new native dependencies (a `.wasm` blob needs no node-gyp / native build and runs in any Node — preserving "installs everywhere").
**Depends on**: Phase 50 (regression gates must be live first, so latency/recall gates catch any regression the kernel introduces)
**Requirements**: SCALE-03
**Success Criteria** (what must be TRUE):

  1. A prebuilt `.wasm` `f32x4` dot-product kernel is checked into the repo and used by the retrieval path (`src/retrieval/topk.ts`); it requires no native build or assembler at install time — SCALE-03
  2. Retrieval is byte-exact vs the prior scalar scan (recall@10 = 1.000 on the eval set; no approximation), with the exact scalar path retained as a verified fallback when SIMD is unavailable — SCALE-03
  3. Measured scan-latency improvement of ~4–5× on the kernel and a materially faster full per-query p95 (reciprocal-norm folded into the kernel + partial-select top-k so the post-scan tail no longer dominates); the Phase-50 latency gate passes — SCALE-03

**Plans**: 3 plans

- [x] 51-01-PLAN.md — Reproducible WASM kernel artifact: in-repo WAT (fused f32x4 dot + reciprocal-norm cosine), dev-only regen script (`--check` reproducibility + math self-test), committed base64 blob module
- [x] 51-02-PLAN.md — Kernel loader: blob decode + SIMD feature-detect + instantiate-once over the index matrix, `scanCosine` (cosine direct), `partialSelectTopK`, safe null fallback; unit tests for exactness/partial-select/fallback
- [x] 51-03-PLAN.md — Wire kernel into `topkIndexed` with verbatim scalar fallback (D-05/D-06/D-08); CandidateRetriever integration test; live-brain `51-topk-equivalence` gate (recall@10=1.000 + ~4–5× kernel / faster full p95)
- [x] 51-04-PLAN.md — Gap closure: norms.length bounds guard (WR-02) + wire gen-simd-kernel `--check` into pretest & pin wabt exact (WR-03)
- [x] 51-05-PLAN.md — Gap closure: harden 51-topk-equivalence gate (fail-loud real-embed, hard max|Δscore| budget, recall@10 metric, f32-vs-f64 comment fix) + live-brain `--real-embed` SC2 proof (WR-01)

### Phase 52: Brain Viz Honest Traces

**Goal**: Make the `recense viz` brain firing honest to the engine and meaningful across both recall and ingestion, instead of cluttered theater. Drive the recall animation from the real scored 1-hop neighbors the server already emits (`engine.ts:316`) rather than the client-side fake 4-hop BFS in `trace.js` (which discards `row.hops` at `hud.js:152`); demote `MAX_HOPS`/`TRACE_FANOUT`/`TRACE_MAX_EDGES` from content generators to safety caps. Add an honest-core + decay-tail glow so the brain briefly "holds" the recalled set. Bridge ingestion events (`new_node` / `reconsolidation` / `oscillation` — currently emitted to the consolidation sink but never reaching the viz) onto the same `activation_trace` SSE stream via a nullable row-level `kind` column and a fire-and-forget switchable bridge that never perturbs consolidation. Per-event color/motion vocabulary with reconsolidation (prediction-error belief-update-in-place) as the hero magenta flash. **Presentation-layer only** — no retrieval/consolidation logic, scoring, or graph-traversal changes.
**Depends on**: Nothing. Orthogonal to the v9.0 memory-quality line (Phases 46–51) — pure presentation-layer rework, can run independently at any time.
**Requirements**: Presentation-layer; no REQUIREMENTS.md entry. The approved design spec is the contract: `docs/superpowers/specs/2026-06-29-brain-viz-honest-traces-design.md`.
**Success Criteria** (what must be TRUE):

  1. A recall trace fires ONLY seeds + their real scored 1-hop neighbors (matching `row.hops`, ≤ caps) — no topology BFS; seed/edge brightness tracks retrieval score.
  2. Lit nodes hold then decay on the tail envelope; viz-disabled path stays zero-cost (Noop sink) and consolidation is unaffected (bridge failures swallowed).
  3. `remember` of a new unrelated fact → green blip; a contradicting fact → magenta flash on the existing node with NO duplicate spawned; an unresolved contradiction → orange wavering pulse.

**Plans**: 6 plans

- [x] 52-01-PLAN.md — Schema + sink nullable `kind` column (D-09 additive migration)
- [x] 52-02-PLAN.md — Recall honesty core: drive from real hops, delete client BFS, D-06 decay envelope + exactly-N test
- [x] 52-03-PLAN.md — Per-kind color/motion vocabulary + reconsolidation magenta hero choreography
- [x] 52-04-PLAN.md — Backend kind plumbing: SSE payload + event_type→kind on the capped sleep-pass cascade
- [x] 52-05-PLAN.md — Synchronous `remember` ingestion bridge (fire-and-forget) + zero-duplicate test
- [~] 52-06-PLAN.md — Founder visual checkpoint → **VERIFIED-WITH-PUNCH-LIST → RESOLVED**. Code confirmed correct end-to-end (engine/bridge/SSE/choreography; 2,442 tests). Visual gap (node-flash prominence at overview zoom) fixed by quick task **260629-tqq (FIX-52A)** — additive bloom-caught node-flash halo. Founder re-verification of the rendered result still pending. See `52-06-SUMMARY.md`.

### Node-Flash Prominence (FIX-52A) — done as quick task, not a phase

Per founder ("this fix shouldn't have to be a whole phase"), the node-flash prominence gap was
fixed as quick task **`260629-tqq`** rather than a standalone phase. Fix: additive halo mesh spawned
at each `activate()` in `src/viz/modules/trace.js`, living in `ctx.pulseGroup` so the bloom pass
catches it — the same proven-visible path as the `spawnPulse` edge wavefronts. Fixed 16-unit world
radius so it reads at overview zoom; coalesces repeat activations; presentation-only (zero change to
the verified data path / kind mapping / choreography). tsc clean, 2,442 tests green. See
`.planning/quick/260629-tqq-fix-52a-legible-node-activation-flashes-/260629-tqq-SUMMARY.md`.
**Founder-approved** (2026-06-29): palette desaturated into the rose/slate/mauve theme + soft-glow halo; node flashes now legible and on-theme at overview zoom.

### Phase 53: Brain Layout at Scale (declutter + deliberate clustering)

**Goal**: Make the `recense viz` brain read as a deliberate, clustered, organic structure at scale
(~15k+ nodes) instead of a dense, visibly-gridded, "very full" cloud. Three coupled symptoms the
founder reported at 15k nodes (2026-06-29): (1) **visible gridlines** — nodes snap to a lattice;
(2) **feels too full** — the whole corpus renders at overview; (3) **no longer feels clustered/
deliberate** — no connectivity-driven grouping. **Presentation/layout-layer only** — no engine,
retrieval, or data-model changes. Performance-sensitive: the layout already degrades as nodes grow,
so any added settling/forces must stay within the existing rAF/idle budget.

**Root-cause findings (already traced — start here, don't re-investigate):**

- `src/viz/modules/graph.js:171–221` `seedNodePositions()` — each node is dropped onto a randomly
  chosen **occupied voxel center** of the brain-hull occupancy grid (`occupied[...]`, line 213),
  scaled by `BRAIN_SCALE` (460), with only **±2 units of jitter** (line 218). Voxel spacing ≫ ±2, so
  nodes snap to a visible lattice → the gridlines.

- `src/viz/modules/graph.js:598` `Graph.cooldownTicks(12)` then pin (`n.fx = n.x`, ~line 607) — the
  force sim runs only 12 ticks and freezes, far too few to reorganize 15k nodes into
  connectivity-based clusters; nodes stay at their grid seed positions.

- Adaptive-density band lives in `src/viz/modules/constants.js` (~line 190+, "Adaptive density")
  and `lod.js` — overview currently renders schema super-nodes + haze; the member-hiding / density
  adaptation is the lever for the "too full" symptom.

**Depends on**: Phase 52 (shares the viz; must not regress the now-approved honest-traces flashes).
**Requirements**: Presentation-layer; design contract is the Phase 52 viz design spec + this gap.
**Success Criteria** (what must be TRUE):

  1. No visible lattice/gridlines at ~15k nodes — node placement fills space (cell-filling jitter or
     a blue-noise/Poisson seed), not snapped to voxel centers.

  2. Overview at ~15k nodes reads as readable and deliberate, not an undifferentiated full cloud —
     adaptive density / LOD keeps screen fullness in the calibrated band as the corpus grows.

  3. Related nodes visibly cluster (connectivity-driven), so the brain feels deliberate — within the
     existing performance budget (no frame-rate regression at 15k vs today).

  4. Zero engine/retrieval/data-model change; Phase 52 honest-traces flashes still render correctly.

**Plans**: 3 plans in 3 waves

Plans:
**Wave 1**

- [x] 53-01-PLAN.md — graph.js: continuous in-hull + schema-centroid + deterministic seeding (kills lattice, starts clustered, stable) + wall-clock SETTLE_BUDGET_MS settle replacing cooldownTicks(12); revealSettled() body locked (D-01/02/03/04/07/08)

**Wave 2** *(depends on 53-01 — shares constants.js)*

- [x] 53-02-PLAN.md — lod.js: overview density cap (OVERVIEW_NODE_CAP, schema-largest-first ranking, haze remainder) holding screen fullness in the calibrated band at scale (D-05/06)

**Wave 3** *(depends on 53-01 + 53-02)*

- [x] 53-03-PLAN.md — verification: machine-checkable layout/locked-anchor/Phase-52 guards + full viz suite + dist build + founder visual checkpoint at ~15k with constant tuning; autonomous: false (D-09)

### Phase 54: Viz Ambient Liveliness and Replay Traces

**Goal**: Make `recense viz` feel alive and engaging when pinned while working, without fabricating
engine activity. Two founder symptoms after Phase 53: (1) **idle dead air** — activation traces fire
only on real recalls, so between them the brain is static; (2) **real activations are too subtle** to
notice at node scale. **Presentation-layer only** — the viz server stays read-only / no-engine /
LLM-free, and the Phase 52 honest-traces invariant is preserved. Design contract:
`docs/superpowers/specs/2026-06-30-viz-ambient-liveliness-replay-traces-design.md`.

**Approach (from approved spec):** a three-layer activity hierarchy, strictly ranked in intensity so
honesty holds by construction —

- **Live recall (brightest):** amplify the real-event flash (size-pulse ~1.35×→~1.8–2× + brighten +
  snappier attack; haze color-overshoot since haze is a color-only InstancedMesh).

- **Replay echo (dimmer, real-but-past):** a server idle scheduler re-emits recent real
  `activation_trace` rows (flag `replay:true`) during idle gaps; the client renders a softer echo of
  the same real hops. Stays inside the viz server's read-only boundary (re-reads existing rows only).

- **Twinkle (faintest):** dim, slow, neutral-palette brightness shimmer on a small rotating node
  subset; no pulses/halos/event-colors.

**Depends on**: Phase 52 (honest traces — must not regress) and Phase 53 (Halton layout).
**Requirements**: Presentation-layer; design contract is the 2026-06-30 spec above.
**Success Criteria** (what must be TRUE):

  1. Alive at idle: pinned with no user recalls, the brain shows continuous gentle life (twinkle)
     punctuated by periodic replay echoes of real recent recalls.

  2. Events pop: a real recall is clearly noticeable at overview zoom, distinctly stronger than a
     replay echo.

  3. Honest hierarchy: live > replay > twinkle is always legible; replays read as rehearsal, not
     live; no fabricated edges (pulses/halos only on real hops).

  4. Not distracting: ambient layers read as meaningful, not loud/noisy (founder felt-quality call).
  5. Bounded + in-boundary: no frame-rate regression at ~15k; viz server stays read-only/LLM-free.

  Founder visual checkpoint confirms 1–4 on the live viz (52/53 idiom). Fresh spontaneous retrievals
  are deferred to a follow-up.

**Plans:** 5/5 plans complete

Plans:
**Wave 1**

- [x] 54-01-PLAN.md — constants.js: 10 ambient-liveliness tunables (Wave 1 foundation)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 54-02-PLAN.md — trace.js: Layer1 amplify + Layer2 client replay branch + Layer3 twinkle (Wave 2)
- [x] 54-03-PLAN.md — server.ts: idle-replay scheduler, replay:true, read-only boundary (Wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 54-04-PLAN.md — tests/viz-ambient-liveliness.test.ts: SC1/SC3/SC5 machine guards (Wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 54-05-PLAN.md — founder visual checkpoint + constant tuning, autonomous:false (Wave 4)

### Phase 55: Honest 1-hop pathways on ambient recall

**Goal**: Make the viz show pathway-hop pulses on **every** recall, not just occasional curated
recalls. Founder symptom from the Phase 54 checkpoint: live flashes light seed nodes but rarely show
the spreading-activation pathways ("trace firing/hops") that make the brain feel alive.

**Root cause (Phase 54 debug, evidence-backed)**: the dominant live trace source — per-prompt
**ambient recall** (`retrieveRanked`, `src/retrieval/engine.ts` emit sites ~499/518) — emits
`hops: []` by design ("no spread loop ran"). But the retrieved seeds carry **real graph out-edges**
(measured 40–72 each over a 17,687-edge graph). The curated path already surfaces these honestly at
`recall/index.ts:525` with `score: null` (rank-only). Only curated recalls that find a
bestMatch+neighborhood currently emit pathways, so they're rare.

**Approach**: have `retrieveRanked` surface each seed's real 1-hop out-edges as `hops`, `score: null`
(rank-only — WR-02-safe, NOT fabricated edges/scores). Mirror the curated path. This is a
**Phase-52 retrieval-engine change on the honesty-critical emit path** — needs its own plan + extended
Plan-04-style machine guards (assert ambient hops are real edges, score:null, no fabricated magnitudes).

**Depends on**: Phase 52 (honest-traces invariant — must not regress), Phase 54 (viz layers).
**Requirements**: SC3 honesty invariant (no fabricated edges) preserved and machine-verified.
**Success Criteria** (what must be TRUE):

  1. A per-prompt recall lights real 1-hop pathways in the viz (not just seed nodes).
  2. Emitted hops are real graph out-edges with `score: null`; no fabricated edge or magnitude (SC3).
  3. Phase 52 honesty guards + Phase 54 layer guards still pass.

**Plans:** 3/2 plans complete

Plans:
**Wave 1**

- [x] 55-01-PLAN.md — Honest ambient 1-hop pathway emit (both retrieveRanked sites) + SC2/SC3 machine guards

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 55-02-PLAN.md — Founder visual verification of ambient pathways (SC1) + AMBIENT_HOP_TOPN tuning
- [x] 55-03 (gap closure) — Cyan 1-hop nodes + honest seed→hop edge pulses (fixes Phase 52 recall_hop-never-wired gap surfaced at the 55-02 checkpoint)

### Phase 56: Spontaneous 1-hop idle activation

**Goal:** Honest idle "default-mode" brain wandering for `recense viz` — during idle gaps the brain fires genuinely-new real 1-hop spreads (NOT replay echoes), so it feels alive even with an empty replay buffer / zero recent recalls, without fabricating any edge or activation.

**Approach:** A read-only idle emitter (SSE-only — never writes `activation_trace`, so the viz server stays read-only/LLM-free and the single-writer invariant holds) picks a random LIVE node and reads its real semantic (`PRED_SET`, `kind='relation'`) 1-hop out-edges via the same honest builder as Phase-55 ambient recall. Rendered in a distinct "default-mode" color (NOT recall amber, NOT replay cyan) under a new trace `kind='spontaneous'`. Activity ordering preserved (SC3): live recall > replay echo > spontaneous > twinkle. Deferred-from-Phase-54 layer.

**Depends on:** Phase 52 (honest-traces invariant — must not regress), Phase 54 (viz idle layers: replay + twinkle), Phase 55 (honest ambient 1-hop pathways + PRED_SET semantic-edge filter).

**Requirements:**

- SPONT-01: During idle, an emitter picks a random LIVE node and reads its REAL semantic (`PRED_SET`, `kind='relation'`) 1-hop out-edges via the same honest builder as ambient recall — real edges only, no fabrication.
- SPONT-02: Spontaneous activity is visually distinct — its own color (a dim "default-mode" hue, NOT recall amber, NOT replay cyan) and its own trace `kind='spontaneous'`, so it can never be mistaken for a live query result.
- SPONT-03: Honesty + no-DB-write — the emitter is read-only, emits an SSE-only event (never writes an `activation_trace` row), preserving single-writer + read-only/LLM-free viz server invariants.
- SPONT-04: Activity ordering (SC3): live > replay > spontaneous > twinkle. Spontaneous is preempted by any live/replay activity and only fires after the idle gap.
- SPONT-05: Tray icon does NOT pulse on spontaneous events (idle, not live — same rule as replay); `kind='spontaneous'` excluded from the replay ring buffer.
- SPONT-06: Machine guards — every spontaneous hop is a real semantic out-edge of its seed (cross-checkable against the store); cadence/density are named tunable constants; founder visual checkpoint tunes density.

**Success Criteria** (what must be TRUE):

  1. Idle viz shows genuinely-new spontaneous 1-hop pathways (distinct color) even with an empty replay buffer / no recent recalls.
  2. Spontaneous pulses trace only real semantic edges; no fabricated edge, no DB write; honesty invariant preserved and machine-verified.
  3. Tray icon stays at rest during spontaneous activity; live recalls + sleep-pass still pulse it.
  4. Founder confirms density/feel at the visual checkpoint.

**Plans:** 5/5 plans complete

Plans:

- [x] 56-01-PLAN.md — Shared honest 1-hop helper extraction + engine re-point (correctness spine, D-07)
- [x] 56-02-PLAN.md — Read-only SSE-only spontaneous idle emitter in server.ts (gate, pool, unref, teardown)
- [x] 56-03-PLAN.md — Client render (dim-indigo default-mode hue) + SPONT constants + tray suppression
- [x] 56-04-PLAN.md — SPONT-06 machine guard: real-edge cross-check + no-DB-write (deterministic)
- [x] 56-05-PLAN.md — Founder visual checkpoint: tune hue/cadence/dim/density (non-autonomous)

### Phase 57: viz activity-palette redesign

**Goal:** Redesign the viz activity color system so hue carries IDENTITY and salience comes from motion/scale/density — never from brightness-scaling saturated hues. The current model (saturated hue × dim factor on a dark additive-blended background) has required founder rescue three times (Phase 54 replay, Phase 55 hops, Phase 56 spontaneous): every "subordinate" layer trends toward invisible because dimming a saturated hue drives it below the perceptual floor.

**Approach:** (1) Luminance-equalized identity palette — every activity kind gets a high-luminance pastel/bioluminescent hue that survives dimming (live amber-gold, replay ice-cyan, spontaneous lavender, ingestion greens/magenta, all within a bounded luminance band); (2) salience ordering (SC3: live > replay > spontaneous > twinkle) expressed through attack sharpness, halo size, pulse thickness, cadence, and density — machine-checkable ordering invariants move from color constants to motion/scale constants; (3) one bloom/tone-mapping calibration pass against the real hull backdrop; (4) founder visual checkpoint closes it. Honesty constraints untouched — presentation layer only (per the faithfulness clause: viz chrome is free).

**Requirements** (derived at plan-phase 2026-07-02 — VIZ-PAL-*):

- **VIZ-PAL-01**: Luminance-equalized identity palette — all 7 KIND_COLOR entries + a new replay identity hue, each hand-picked with computed luminance inside a machine-tested band; oscillation moved off amber-family (D-01/02/03/04).
- **VIZ-PAL-02**: SC3 salience ordering re-expressed as per-layer motion profiles (attack/halo/pulse/cadence/density) with machine-checkable monotonic ordering on the salient channels; brightness bounded by hard test-enforced dim floors (D-05/06/07/08).
- **VIZ-PAL-03**: Single shared source of truth for scheduler constants consumed by both the client and the viz server — structurally kills the WR-01 mirror-drift class (D-10).
- **VIZ-PAL-04**: WR-06 fixed in-phase — own-trace-scoped fades in all three trace.js branches (live/replay/spontaneous) so concurrent traces never clobber each other (D-11).
- **VIZ-PAL-05**: One dedicated invariants test file owns all palette/motion locks (band membership, dim floors, monotonic ordering, shared-source sync); subsumes the never-written WR-02 lock; migrates the scattered REPLAY_DIM<1 lock in (D-12).
- **VIZ-PAL-06**: One global bloom/tone-mapping/exposure calibration pass against the real hull backdrop, verified by founder eyeball + captured per-layer evidence; global-only, no selective bloom (D-13/14/15).
- **VIZ-PAL-07**: Two-stage founder checkpoint — Stage 1 mid-phase palette hue sign-off, Stage 2 closing full-system tune — with provisional values ratcheted to founder-approved locks (D-16/D-09).

**Depends on:** Phase 56
**Plans:** 2/7 plans executed

Plans:
**Wave 1**

- [x] 57-01-PLAN.md — Shared scheduler-constants source of truth: server source-parses constants.js, hand-mirrored block deleted (kills WR-01) + dedicated D-12 invariants file seeded with the shared-source-sync lock [wave 1] (VIZ-PAL-03, VIZ-PAL-05)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 57-02-PLAN.md — Luminance-equalized identity palette: 8 identity hues (incl. new replay ice-cyan) in a tested band, oscillation off amber; replay-hue trace.js restructure (kills REPLAY_HOP_COLOR bit-shift); band-membership invariant [wave 2] (VIZ-PAL-01, VIZ-PAL-05)

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 57-03-PLAN.md — Stage-1 founder checkpoint: palette-on-hull hue sign-off before motion work; ratchet approved hues + band bounds; capture Stage-1 screenshots (D-15) [wave 3, checkpoint] (VIZ-PAL-01, VIZ-PAL-07)

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 57-04-PLAN.md — Four per-layer motion profiles (attack/halo/pulse/cadence/density), live re-homed pixel-equivalent, dim floors ≥0.6; monotonic SC3 ordering + floor invariants + migrate WR-02/REPLAY_DIM<1 locks [wave 4] (VIZ-PAL-02, VIZ-PAL-05)
- [ ] 57-05-PLAN.md — Global bloom/tone-mapping + renderer exposure provisional recalibration (single composer, no selective bloom) [wave 4] (VIZ-PAL-06)

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 57-06-PLAN.md — trace.js consumes per-layer motion profiles (salience from motion/scale) + WR-06 own-trace-scoped fades in all three branches [wave 5] (VIZ-PAL-02, VIZ-PAL-04)

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 57-07-PLAN.md — Stage-2 founder checkpoint: full-system live tune (motion + floors + bloom + exposure), ratchet-lock all provisional values + tighten D-12 invariants + per-layer evidence + 2558-suite gate [wave 6, checkpoint] (VIZ-PAL-02, VIZ-PAL-06, VIZ-PAL-07, VIZ-PAL-05)

## Backlog

_(empty — no backlog items)_
