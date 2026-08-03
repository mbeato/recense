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
- ✅ **v9.0 Memory Quality** — Phases 46–61 (shipped 2026-07-20) — full detail: [milestones/v9.0-ROADMAP.md](milestones/v9.0-ROADMAP.md); audit: [milestones/v9.0-MILESTONE-AUDIT.md](milestones/v9.0-MILESTONE-AUDIT.md). Engine: reconsolidation candidate broadening (union graph+BM25+dense — judge fires 368 KU contradicts vs pre-46 ZERO; belief-correction 84.6%, no clean-case regression), hybrid BM25+dense fusion live on the LLM-free hot path (honest null w*=0, ships dark), correctness hardening (C-2/M-5/M-9/L-2), ANN NO-GO → portable WASM SIMD f32x4 exact-scan kernel (byte-exact, ~4–5×), regression gates merge-blocking in CI (offline gate:ci required check; accuracy floors armed; docs/evals.md re-baselined v9.0-final). Viz overhaul 52–61: honest traces, layout at 15.4k nodes, ambient liveliness + spontaneous idle activation, identity palette, node/motion overhaul, HUD integration, settings/stats depth, corpus index-column browsing — all founder-signed-off.
- 🚧 **v10.0 Action Proposals** — Phases 62–68 (roadmapped 2026-07-29, not yet built) — full detail: below, "Phase Details — v10.0 Action Proposals". recense ingests real events across both inboxes, decides *what changed* about a tracked entity as a belief, and emits domain-neutral action proposals that a separate system of record confirms — proving the context-layer-proposes / system-of-record-confirms split. Promoted from ROADMAP backlog **B-01**. The differentiator is Phase 65 (belief-gated status drift riding the existing PE-gate/`supersedes` machinery unmodified); the largest new correctness risk is Phase 66's "D-43-for-proposals" self-confirmation vector.

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

<details>
<summary>✅ v9.0 Memory Quality (Phases 46–61) — SHIPPED 2026-07-20</summary>

- [x] Phase 46: Reconsolidation Candidate Broadening (2/2 plans) — completed 2026-06-28
- [x] Phase 47: Hybrid Retrieval Recall (3/3 plans) — completed 2026-06-30
- [x] Phase 48: Correctness Hardening (2/2 plans) — completed 2026-06-28
- [x] Phase 49: Scale + Data-Model Spike (3/3 plans) — completed 2026-06-28
- [x] Phase 50: Verification + Regression Gates (4/4 plans) — completed 2026-07-01; GATE-01 CI merge-block closed by quick 260720-nup (2026-07-20)
- [x] Phase 51: WASM SIMD Exact-Scan Kernel (5/5 plans) — completed 2026-07-01
- [x] Phase 52: Brain Viz Honest Traces (6/6 plans) — completed 2026-06-29
- [x] Phase 53: Brain Layout at Scale (3/3 plans) — completed 2026-06-30
- [x] Phase 54: Viz Ambient Liveliness + Replay Traces (5/5 plans) — completed 2026-06-30
- [x] Phase 55: Honest 1-hop Pathways on Ambient Recall (3/3 plans) — completed 2026-07-01
- [x] Phase 56: Spontaneous 1-hop Idle Activation (5/5 plans) — completed 2026-07-01
- [x] Phase 57: Viz Activity-Palette Redesign (8/8 plans) — completed 2026-07-04
- [x] Phase 58: Node Presentation & Motion Overhaul (8/8 plans) — completed 2026-07-06
- [x] Phase 59: HUD Integration (visible-but-belong) (7/7 plans) — completed 2026-07-08
- [x] Phase 60: Settings + Stats Depth (11/11 plans) — completed 2026-07-14
- [x] Phase 61: Corpus Chrome — Index Column + Project Browsing (18/18 plans) — completed 2026-07-17

Full phase details: [milestones/v9.0-ROADMAP.md](milestones/v9.0-ROADMAP.md)

</details>

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
| 50. Verification + Regression Gates | v9.0 | 4/4 | Complete | 2026-07-01 |
| 51. WASM SIMD Exact-Scan Kernel | v9.0 | 5/5 | Complete    | 2026-06-30 |
| 52. Brain Viz Honest Traces | v9.0 | 6/6 | Complete | 2026-06-29 |
| 53. Brain Layout at Scale | v9.0 | 3/3 | Complete | 2026-06-30 |
| 54. Viz Ambient Liveliness + Replay Traces | v9.0 | 5/5 | Complete | 2026-06-30 |
| 55. Honest 1-hop Pathways on Ambient Recall | v9.0 | 3/3 | Complete | 2026-07-01 |
| 56. Spontaneous 1-hop Idle Activation | v9.0 | 5/5 | Complete | 2026-07-01 |
| 57. Viz Activity-Palette Redesign | v9.0 | 8/8 | Complete | 2026-07-04 |
| 58. Node Presentation & Motion Overhaul | v9.0 | 8/8 | Complete | 2026-07-06 |
| 59. HUD Integration | v9.0 | 7/7 | Complete | 2026-07-08 |
| 60. Settings + Stats Depth | v9.0 | 11/11 | Complete | 2026-07-14 |
| 61. Corpus Chrome — Index Column | v9.0 | 18/18 | Complete | 2026-07-17 |
| 62. Multi-Inbox Email Ingest Hardening | v10.0 | 31/31 | Complete   | 2026-08-02 |
| 63. Offline Intent Classification | v10.0 | 6/6 | Complete    | 2026-08-02 |
| 64. Entity Resolution Hardening | v10.0 | 4/4 | Complete    | 2026-08-03 |
| 65. Belief-Gated Status Drift + Provenance-Distinctness Fix | v10.0 | 11/11 | Complete    | 2026-08-03 |
| 66. Domain-Neutral Proposal Emit Seam | v10.0 | 5/5 | Complete    | 2026-08-03 |
| 67. Reference Consumer Adapter | v10.0 | 3/3 | Complete    | 2026-08-03 |
| 68. Telegram HITL Belief-Kind Extension | v10.0 | 1/3 | In Progress|  |

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

**Plans:** 6/6 complete + 1 gap-closure plan (59-07)

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

**Plans:** 6/6 complete + 1 gap-closure plan (59-07)

Plans:
**Wave 1**

- [x] 45-01-settings-key-detector-PLAN.md — shared ~/.claude/settings.json ANTHROPIC_API_KEY detector (D-14, keystone)
- [x] 45-02-config-default-flip-PLAN.md — flip DEFAULT_CONFIG.modelProvider to claude-headless + reconcile fallout (D-01/02/03)
- [x] 45-03-docs-prereqs-and-staleness-PLAN.md — README subscription prereqs + footgun line; evals.md staleness note (D-15/16)
- [x] 45-04-billing-leak-investigation-PLAN.md — empirical D-17 leak reproduction (autonomous:false, records finding)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 45-05-init-subscription-path-PLAN.md — init provider step + subscription path + acknowledge gate (D-04..D-10)
- [x] 45-06-doctor-billing-and-cli-PLAN.md — doctor billing-posture + claude-CLI probe + reworked api-key dimension (D-11/12/13)

## Phase Details — v10.0 Action Proposals

> **Active milestone** — roadmapped 2026-07-29, promoted from ROADMAP backlog B-01 (below, now emptied). Phases continue from 62 (v9.0 ended at Phase 61). Full context: `PROJECT.md` "Current Milestone" section, `REQUIREMENTS.md` (30 requirements), `research/{SUMMARY,ARCHITECTURE,PITFALLS}.md`.

recense ingests real events across both inboxes, decides *what changed* about a tracked entity as a belief, and emits domain-neutral action proposals that a separate system of record confirms — proving the context-layer-proposes / system-of-record-confirms split across a real product boundary. The genuinely new work is CLASSIFY → RESOLVE → DRIFT → EMIT; EMAIL, CONSUME, and APPROVE extend already-shipped machinery (v4.0 multi-account Gmail fan-out, v9.0 RECON candidate generation, v4.0 Telegram HITL).

**Engine invariants across all phases:** sleep pass is sole graph writer; online paths LLM-free; graph is source of truth; D-43 (inference never strengthens a fact) — extended in Phase 66 to a new "D-43-for-proposals" sentinel covering the approve/reject write path; `source:'hitl'` excluded from consolidation; single-tenant; agents live outside the engine (tsconfig + import-boundary test, replicated for the new client); net-zero new runtime dependencies (confirmed holding for all of v10.0 by research); no accuracy regression traded for a latency/token win.

**Dependency shape:** 62 → 63 (EMAIL-03's hidden-content stripping is a hard prerequisite for enabling CLASSIFY-01 on gmail content, not an optimization — an attacker-controlled hidden instruction must not reach the classifier whose output drives a proposed change to an external system of record) → 64 (resolution runs against episodes 63 already flagged status-relevant) → 65 (needs 63's classification output and 64's resolved entity) → 66 (needs 65's validated gating semantics before wiring real emission — cheaper to fix a threshold or the provenance-distinctness key before a consumer depends on the stream than after) → {67, 68} (both depend only on 66's frozen HTTP contract; parallel-safe with each other).

**Foundation-phase call (explicit deviation from the research-proposed 8-phase list):** research's `SUMMARY.md` proposed a standalone "Proposal Schema & Sink Foundation" phase ahead of classification, to freeze the `action_proposal` table shape early for two later workstreams. That phase owns no REQ-IDs of its own — its deliverables are exactly EMIT-01 (`ActionProposalSink`) and EMIT-02 (the proposal record shape). It is folded into Phase 66 here instead: neither Phase 63 (CLASSIFY) nor Phase 64 (RESOLVE) ever touches the `action_proposal` table — both only add optional fields to the in-memory `ClaimDecision` (mirroring the TEMP-02 `due_at`/`action_type` precedent) — so nothing upstream of Phase 66 is actually gated on the table shape existing early. The two workstreams the schema needs to freeze for (emission logic, HTTP read/ack routes) are both *inside* Phase 66 itself, so declaring the schema as Phase 66's first task achieves the identical freeze without a phase that has zero requirements of its own and no independently observable success criteria — which would also push this "standard" (5–8 phase) milestone to 8 phases for no coverage gain. Net-zero requirement-coverage effect: EMIT-01/EMIT-02 are still satisfied, just inside Phase 66.

- [x] **Phase 62: Multi-Inbox Email Ingest Hardening** — Guided account-N onboarding, per-account query scoping (backfill-only, honestly documented), HTML/hidden-content stripping, chronological backfill ordering. (8/8 plans executed 2026-07-30 incl. gap closure 62-06..62-08; **RE-VERIFICATION status: gaps_found, 3/4 must-haves (2026-07-30, third pass)** — see `62-VERIFICATION.md` + `62-REVIEW.md`. Round-1 gaps: 62-06 CLOSED (e2e test now wiring-discriminating, RED observed), 62-08 CLOSED (dead `idx_episode_event_ts` dropped), 62-07 PARTIAL. NOT complete — 3 blockers, each reproduced against the built `dist/`: (1) `STYLE_BLOCK_RE` (`strip-hidden.ts:201`) was left out of 62-07's quote-aware fix — there are FOUR attribute-scanning regexes, the plan enumerated three — so a quoted `>` in a `<style>` open tag still leaks class-hidden text; (2) `normalizeGmailMessage` (`gmail-adapter.ts:329-333`) builds the provenance header from raw `Subject:`/`From:` with zero stripping, so Unicode Tags-block codepoints reach `record.content` verbatim — EMAIL-03 falsified twice over; (3) `parseEmailDate`'s 48h future-skew window is unclamped, so a forged `Date: now+47h` is guaranteed to sort last and override genuine same-batch state — undermines EMAIL-04. All 2883 tests pass with all three present; none is covered. Round-2 and round-3 gaps CLOSED by 62-09..62-12. Round-4 (2026-07-30 re-verification): EMAIL-01/02/04 SATISFIED (zero-diff regression check); EMAIL-03 still FAILED — VF-01 (blocker: a CSS comment adjacent to a hiding selector defeats `harvestHidingSelectors`, class-hidden payload reaches `record.content` end-to-end), NEW-01 (62-12 regression: `<letter` inside a RAWTEXT body deletes to EOF), WR-02 (escalated: 126 s of ingest CPU for one crafted 512 KB body, no input cap). Planned as 62-13..62-15, waves 9-11.) (completed 2026-07-30)
- [x] **Phase 63: Offline Intent Classification** — Sleep pass classifies status-relevant gmail episodes inside the existing extraction call; zero net-new LLM calls; hitl guard inherited structurally, not re-implemented. (completed 2026-08-02)
- [x] **Phase 64: Entity Resolution Hardening** — Broadened candidate generation + confident-or-null resolution against recense's own graph; descriptor-only, never a consumer ID. (completed 2026-08-03)
- [x] **Phase 65: Belief-Gated Status Drift + Provenance-Distinctness Fix** — Status lifecycle rides the existing PE-gate/`supersedes` machinery unmodified; redesigned provenance-distinctness key makes `countDistinctProvenance` reachable on email evidence without becoming farmable. (completed 2026-08-03)
- [x] **Phase 66: Domain-Neutral Proposal Emit Seam** — `ActionProposalSink` + `action_proposal` table + `/v1/proposals` routes; a named "D-43-for-proposals" sentinel test closes the milestone's largest correctness risk structurally. (completed 2026-08-03)
- [x] **Phase 67: Reference Consumer Adapter** — In-repo `clients/proposal-reference/` proves the contract end-to-end with its own import-boundary test. (completed 2026-08-03)
- [ ] **Phase 68: Telegram HITL Belief-Kind Extension** — Second `kind:'belief'` on the existing StoredProposal union; batching + hold-exclusion bound approval fatigue.
- [ ] **Phase 69: Retrieval Upgrade — Entity-Anchored Ambient Recall** — Entity-anchored candidate generation (reusing Phase 64's union generator), same-project rank treatment, 1-hop relations in the injected block, cited-evidence recall mode. Gated on a 58-prompt eval set from real sessions. Seed: SEED-005.

### Phase 62: Multi-Inbox Email Ingest Hardening

**Goal**: A user can onboard a second Gmail account through a guided flow and scope each inbox's initial backfill independently, and no hidden/attacker-controlled content from either inbox can reach a future classifier.
**Depends on**: Nothing (first phase of v10.0; phases continue from Phase 61)
**Requirements**: EMAIL-01, EMAIL-02, EMAIL-03, EMAIL-04
**Success Criteria** (what must be TRUE):

  1. A user can authorize an additional Google account through a guided CLI flow (loopback OAuth redirect, the current Desktop-client flow recense already uses) that mints and stores `GOOGLE_<ID>_REFRESH_TOKEN` without hand-rolling OAuth or hand-editing env files — EMAIL-01
  2. A user can set a per-account Gmail query that scopes that account's initial backfill independently of other accounts; the documented limitation — incremental pulls are NOT query-filtered, because `users.history.list` accepts no `q` parameter — is stated in the config doc comment and surfaced by `recense doctor`, never implied away — EMAIL-02
  3. Hidden or invisible content in HTML-only emails (`display:none`, zero-width characters, hidden spans) is deterministically stripped before any content reaches the extractor, verified by a regression fixture containing a hidden injected instruction that must not survive into episode content — EMAIL-03
  4. A fresh account's initial backfill batch is consolidated in chronological order (derived from the email's own `Date:` header), so an older message in the same backfill cannot silently apply over newer state — EMAIL-04

**Plans**: 31 plans in 24 waves (62-06..62-08 gap closure added 2026-07-30; 62-09..62-11 gap closure added 2026-07-30 after re-verification; 62-12 gap closure added 2026-07-30 from `62-REVIEW.md` BL-01/BL-02/BL-03; 62-13..62-15 gap closure added 2026-07-30 from `62-VERIFICATION.md` VF-01/NEW-01/WR-02; **62-16..62-19 gap closure added 2026-07-31** from `62-VERIFICATION.md` FB-01/T62-91 and `62-REVIEW.md` CR-04/WR-09/IN-05 — replaces the hand-rolled CSS scanner with a spec-conformant tokenizer after six independent bypasses of one contract; **62-20..62-25 gap closure added 2026-07-31** from `62-VERIFICATION.md` CR-05..CR-11/WR-10 — extends the same conformant-engine argument to the CSS declaration layer and, per operator decision D-GAP-02, adopts a conformant HTML parser for the comment/`<style>`/attribute layers; **62-26..62-31 gap closure added 2026-08-01** from `62-VERIFICATION.md` CR-01/CR-02/CR-03/WR-03 and `62-REVIEW.md` WR-01..WR-10 — round 7. The three blockers are two instances of the same two-lists-one-boundary failure mode (CR-01, CR-03) plus the third cost bound derived from an enumerated shape set rather than the algorithm's worst case (CR-02). What makes this round different from the six before it is that the STRUCTURAL gap is sequenced FIRST: the phase's only oracle-driven differential holds the HTML wrapper fixed, so the entire HTML layer three plans rewrote is untested — 62-28 builds an HTML-wrapper generator with ground truth from parse5, a parser production does NOT use, and must independently rediscover CR-01 and CR-03 against the unfixed module before any fix lands)

Plans:
**Wave 1**

- [x] 62-01-PLAN.md — Per-account Gmail query scoping via a real env-file config surface, with the backfill-only limitation stated in the config doc comment and surfaced by a new `recense doctor` dimension (EMAIL-02, wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 62-02-PLAN.md — `recense gmail-auth <id>`: guided loopback-OAuth onboarding that mints `GOOGLE_<ID>_REFRESH_TOKEN` and registers the account, reusing `writeEnvFile` (EMAIL-01, wave 2)
- [x] 62-03-PLAN.md — `stripHiddenContent`: deterministic, idempotent markup + hidden-content removal at the Gmail boundary, with the named hidden-injection regression fixture (EMAIL-03, wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 62-04-PLAN.md — Additive `episode.event_ts` (SCHEMA_VERSION 16) threaded from the `Date:` header through the adapter contract, with a plausibility window that rejects forged far-future dates (EMAIL-04, wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 62-05-PLAN.md — `orderEpisodesForConsolidation`: slot-preserving chronological reorder inside `consolidate()`, proven end-to-end on a reverse-chronological backfill batch (EMAIL-04, wave 4)

**Wave 5** *(gap closure — from `62-VERIFICATION.md` gaps[0] and `62-REVIEW.md` CR-01/WR-01; all three run in parallel, no file overlap)*

- [x] 62-06-PLAN.md — Make the EMAIL-04 end-to-end proof wiring-discriminating: content-keyed extraction instead of a call-order script, measured RED against a reverted `consolidator.ts:532` (EMAIL-04, wave 5)
- [x] 62-07-PLAN.md — Quote-aware tag matching across all three `stripHiddenContent` regexes, closing the CR-01 quoted-`>` hidden-content bypass, with a measured backtracking bound (EMAIL-03, wave 5)
- [x] 62-08-PLAN.md — Drop the dead `idx_episode_event_ts` index in place in the v16 migration, with an already-migrated-DB regression lock (EMAIL-04, wave 5)

**Wave 6** *(gap closure — from `62-VERIFICATION.md` re-verification gaps[0]/gaps[1] and `62-REVIEW.md` CR-01/CR-02/CR-03; both run in parallel, no file overlap: 62-09 owns `strip-hidden.ts`, 62-10 owns `gmail-adapter.ts`)*

- [x] 62-09-PLAN.md — Make `STYLE_BLOCK_RE` quote-aware (the FOURTH attribute-scanning regex 62-07 missed), give the named fixture a `<style>` tag with a quoted `>`, and add a source guard so a fifth bare-attribute-class regex fails the suite (EMAIL-03, wave 6)
- [x] 62-10-PLAN.md — Clamp `parseEmailDate`'s accepted future-skew branch to `nowMs` and correct the JSDoc overclaim, removing the net-new "forge a Date to sort last" capability plan 62-05 introduced (EMAIL-04, wave 6)

**Wave 7** *(blocked on Wave 6 — writes BOTH files owned by the wave-6 plans)*

- [x] 62-11-PLAN.md — Export a narrow `stripInvisibleCodepoints` stage-1 primitive and apply it to the sender-controlled `From:`/`Subject:` headers before the provenance header is built, closing the header-borne Unicode-Tags-block injection path (EMAIL-03, wave 7)

**Wave 8** *(gap closure — from `62-REVIEW.md` BL-01/BL-02/BL-03, all three Critical; single plan, owns `strip-hidden.ts` alone)*

- [x] 62-12-PLAN.md — Build all four tag-scanning literals from one shared `ATTRS` fragment that permits an unquoted `<` (reversing 62-09's net regression) and widens the `</style>` tail, and derive the invisible-codepoint set from `\p{Default_Ignorable_Code_Point}` instead of a hand-maintained list (EMAIL-03, wave 8)

**Wave 9** *(gap closure — from `62-VERIFICATION.md` VF-01 (blocker) + NEW-01; single plan, owns `strip-hidden.ts` alone)*

- [x] 62-13-PLAN.md — Linear CSS comment scanner built from a closed enumeration of the three CSS Syntax contexts where `/*` is not a comment — string token, unquoted url-token, backslash escape — ahead of the bare-selector check (VF-01) and a RAWTEXT-scoped close-tag scan so a `<letter` inside a `<style>`/`<script>` body stops deleting to EOF (NEW-01), with every historical bypass audited against a shipped test in both directions (EMAIL-03, wave 9)

**Wave 10** *(gap closure — WR-02 algorithmic half; blocked on wave 9, writes the same file)*

- [x] 62-14-PLAN.md — Two exact linear bounds — a hoisted stray-`<` fail-safe and a linear rule harvest replacing `RULE_RE`'s backtracking scan — taking the verification report's 512 KB adversarial shape from 126 s to milliseconds, measured across twelve adversarial shapes with equivalence demonstrated against the pre-change module (EMAIL-03, wave 10)

**Wave 11** *(gap closure — WR-02 input-cap half + phase-closing evidence; blocked on wave 10 for the measurement that sizes the cap)*

- [x] 62-15-PLAN.md — Fail-closed `MAX_STRIP_INPUT` bound on `raw.bodyText` at the adapter boundary, sized from the worst shape in 62-14's ranked twelve-shape measurement, plus a `dist/`-level reproduction of every finding this wave closed (EMAIL-03, wave 11)

**Wave 12** *(blocked on Wave 11 completion — gap closure round 5, 2026-07-31)*

- [x] 62-16-PLAN.md — Adopt `css-tree@3.2.1` (pinned) behind a §4.3 conformance gate, then build the liveness oracle WR-09 said did not exist and adjudicate every open finding against it — no production code changes (EMAIL-03, wave 12)

**Wave 13** *(blocked on Wave 12 completion)*

- [x] 62-17-PLAN.md — Replace `stripCssComments` and the brace-partition scan with a token-stream harvest incl. §4.3.7 escape decoding, closing every leak the oracle confirmed live (EMAIL-03, wave 13)

**Wave 14** *(blocked on Wave 13 completion)*

- [x] 62-18-PLAN.md — Delete `STYLE_BLOCK_RE` and locate `<style>` elements linearly with stage 4's own primitives, eliminating T62-91's quadratic (156 s → 2.5 ms at the cap boundary); re-size-or-confirm the cap on a corrected shape set; fix IN-05 (EMAIL-03, wave 14)

**Wave 15** *(blocked on Wave 14 completion)*

- [x] 62-19-PLAN.md — Close WR-09: oracle-driven both-directions differential with exhaustive token-boundary adjacency, plus a dispositioned divergence table against the pre-wave-12 baseline (EMAIL-03, wave 15)

**Wave 16** *(gap closure round 6 — from `62-VERIFICATION.md` CR-05..CR-11 + WR-10 and `62-REVIEW.md`; both run in parallel, no file overlap: 62-20 owns `strip-hidden.ts`, 62-21 owns `package.json`)*

- [x] 62-20-PLAN.md — Token-derived hiding-declaration signature at both call sites, EOF frame drain, no fail-open harvest bound, CRLF-correct escape decode (CR-05/CR-06/CR-08/CR-09, EMAIL-03, wave 16)
- [x] 62-21-PLAN.md — Adopt a conformant HTML parser behind a §13.2.5 conformance gate: four-criterion measured selection, exact pin in `dependencies`, blocking-human legitimacy gate; no production code changes (D-GAP-02, EMAIL-03, wave 16)

**Wave 17** *(blocked on Wave 16; 62-22 owns `strip-hidden.ts`, 62-23 owns the tsconfig/typing surface — no file overlap)*

- [x] 62-22-PLAN.md — One `scanHtml` pass feeding stage 2 and stage 3, closing the `<style>`-inside-a-comment stage-ordering leak structurally, plus a re-derived 1 MiB cost bound (CR-10, EMAIL-03, wave 17)
- [x] 62-23-PLAN.md — Enforce the documented `src/` isolation boundary for real: tests-scoped tsconfig project, corrected documentation, and a shipped non-vacuous import-boundary test (WR-10, EMAIL-03, wave 17)

**Wave 18** *(blocked on Wave 17 — writes `strip-hidden.ts`)*

- [x] 62-24-PLAN.md — Stages 4 and 5 driven by the parser's start tags with decoded attribute values, restoring the browser's HTML-decode-then-CSS-tokenize layering, with a dispositioned divergence table (CR-07, EMAIL-03, wave 18)

**Wave 19** *(blocked on Wave 18 — the CR-11 hard gate lands AFTER the leak fixes, per the sequencing decision recorded in 62-25-PLAN.md)*

- [x] 62-25-PLAN.md — Turn the differential's leak counter into a gate (named per-mechanism predicates, exact counts, injection-proved blocking) and derive the oracle's declaration verdict from css-tree's parser instead of a copy of production's regexes (CR-11 + CR-05's oracle half, EMAIL-03, wave 19)

**Wave 20** *(gap closure round 7 — from `62-VERIFICATION.md` CR-01/CR-02/CR-03/WR-03 and `62-REVIEW.md` WR-01..WR-10; both run in parallel, no file overlap: 62-26 owns `package.json`, 62-27 owns the CSS differential + CI + requirements record)*

- [x] 62-26-PLAN.md — Install `parse5@7.3.0` as an exact-pinned devDependency behind a blocking-human legitimacy gate, so an HTML ground truth can be computed by a parser production does not use; no test and no production code (WR-03 prerequisite, EMAIL-03, wave 20)
- [x] 62-27-PLAN.md — Causal leak attribution (a predicate must prove its mechanism by counterfactual, not co-occur with it), oracle preconditions moved out of the `it.fails` bodies, `npm run typecheck` wired into CI, and the inverted EMAIL requirement record corrected (WR-02/WR-04/WR-06 + doc defect, EMAIL-03, wave 20)

**Wave 21** *(blocked on Wave 20 — the structural fix, sequenced BEFORE every point fix so its non-vacuousness is demonstrated rather than argued)*

- [x] 62-28-PLAN.md — HTML-wrapper differential: 22 named wrapper shapes crossed against a fixed hiding rule, adjudicated by a parse5-derived rendered-text oracle, run against the unfixed module and recorded rediscovering the CR-01 and CR-03 families on its own; hard-gated, injection-proved (WR-03, EMAIL-03, wave 21)

**Wave 22** *(blocked on Wave 21 — sole owner of `strip-hidden.ts` this wave)*

- [x] 62-29-PLAN.md — One compiler-checked dispositioned element-name source driving deletion, harvest context and the RAWTEXT close-defect regex; the one-sided `selfClosingSyntax` exclusion deleted; thirteen exact-output leak locks (CR-01/CR-03/WR-01/WR-08, EMAIL-03, wave 22)

**Wave 23** *(blocked on Wave 22 — writes `strip-hidden.ts`)*

- [x] 62-30-PLAN.md — Hoist the stray-`<` truncation ahead of the stage-6 sweep (18 min of ingest CPU at the cap -> milliseconds), re-derive `MAX_STRIP_INPUT_CODE_UNITS` against the shape family that falsified it, and make the cost gates calibration-relative (CR-02/WR-07, EMAIL-03, wave 23)

**Wave 24** *(blocked on Wave 23 — writes `strip-hidden.ts`; phase-closing evidence)*

- [x] 62-31-PLAN.md — Normalize removal ranges instead of assuming them, make the close-tag boundary quote-aware, collapse the doc block to current state behind a shipped identifier guard, and assemble the round-7 evidence sweep and residual register (WR-05/WR-09/WR-10, EMAIL-03, wave 24)

**Planning note:** research Pitfall 5 proposed sorting a backfill batch by `Date:` header *before appending*. That fix would be dead code here — `listUnconsolidated()` is `ORDER BY hard_keep DESC, salience DESC`, so append order is discarded. Plan 62-05 corrects this and lands the ordering at the consolidation seam without modifying the SQL replay-priority order.

### Phase 63: Offline Intent Classification

**Goal**: The sleep pass decides, from gmail episodes only, whether an email implies a status change to a tracked entity — at zero net-new LLM-call cost — while online paths stay LLM-free and the existing `source==='hitl'` exclusion structurally extends to the new classification path instead of being re-implemented.
**Depends on**: Phase 62 (EMAIL-03's hidden-content stripping must land before classification is enabled on gmail content — a hard prerequisite, not a nice-to-have)
**Requirements**: CLASSIFY-01, CLASSIFY-02, CLASSIFY-03, CLASSIFY-04
**Research flag**: Needs a research/design pass during planning — the classification prompt itself, and mapping job-status evidence onto PE magnitude, is where the genuinely deep new work in this milestone concentrates (per `research/SUMMARY.md`).
**Success Criteria** (what must be TRUE):

  1. A gmail episode implying a status change produces optional intent/entity/confidence fields as part of the SAME extraction call gmail episodes already make (mirroring the TEMP-02 `due_at`/`action_type` optional-field pattern) — a token-cost check confirms no second LLM call was added per episode — CLASSIFY-01
  2. Classification runs as a branch inside the existing per-episode consolidator loop, after the existing `source==='hitl'` hard-stop; a sentinel test proves hitl-sourced episodes are never classified — CLASSIFY-02
  3. SessionStart inject, retrieval, `/v1/surface`, and the new `/v1/proposals` route all remain LLM-free, confirmed by an automated regression test that fails if any online path calls the model provider — CLASSIFY-03
  4. The classified status vocabulary stays limited to the four scoped states (applied/interviewing/rejected/offer), and no sender-domain fingerprint table exists anywhere in config or code — sender domain is at most a weak prior the model reads, never a routing table — CLASSIFY-04

**Plans**: 6 plans (3 waves)

Plans:
**Wave 1**

- [x] 63-01-PLAN.md — ExtractedClaim intent contract: 4-state/3-level closed vocabularies, drop-on-mismatch coercers, JSON schema, all-or-nothing parse gate (wave 1)
- [x] 63-02-PLAN.md — gmail intent-classification prompt block shared across both gmail prompt variants + CLASSIFY-04 no-fingerprint-table structural guard (wave 1)
- [x] 63-03-PLAN.md — CLASSIFY-03 online LLM-free regression sentinel across SessionStart inject, retrieval, and GET /v1/surface (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 63-04-PLAN.md — consolidator threading through ClaimDecision/PendingJudge at all four decision sites + hitl/inferred/echo sentinel + one-generate-call sentinel (wave 2)
- [x] 63-06-PLAN.md — honest input-token delta measurement for the enlarged prompt prefix, with founder checkpoint (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 63-05-PLAN.md — cross-stage conservation: vocabulary parity prompt/schema/parser/decision + zero-DB-delta inertness proof (wave 3)

### Phase 64: Entity Resolution Hardening

**Goal**: A classified episode resolves to the correct tracked entity in recense's own graph, or to nothing at all — never to a wrong guess that could corrupt an external system of record recense has no write access to fix.
**Depends on**: Phase 63 (resolution only runs against episodes Phase 63 has already flagged as status-relevant)
**Requirements**: RESOLVE-01, RESOLVE-02, RESOLVE-03
**Success Criteria** (what must be TRUE):

  1. Entity resolution for a classified email uses broadened candidate generation — exact/entity-keyed match ∪ BM25 lexical ∪ dense cosine union, reusing v9.0's RECON machinery — never dense-cosine alone — RESOLVE-01
  2. When no candidate clears the confidence floor, resolution abstains and no proposal is produced from that episode, rather than emitting a best-available guess — RESOLVE-02
  3. A resolved entity is exposed as recense's own stable node reference plus a human-readable descriptor; recense never mirrors, imports, or queries a consumer's canonical ID space — the consumer's own adapter owns the match into its IDs — RESOLVE-03

**Plans**: 4 plans (3 waves)

Plans:
**Wave 1**

- [x] 64-01-PLAN.md — close 63 WR-01: gate intent-field pickup on episode.source === 'gmail' at the fill sites, three-route regression (wave 1)
- [x] 64-02-PLAN.md — standalone EntityResolver: three-channel union generator (exact ∪ BM25 ∪ dense) + confident-or-null floor/margin knobs (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 64-03-PLAN.md — thread claimResolvedEntityId/Descriptor from one branch inside the guarded per-episode loop; sentinels for guard inheritance, source gating, zero net-new provider calls (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 64-04-PLAN.md — D-09 inertness: two-pass whole-DB conservation (resolution on vs off) with payload-aware snapshot; full-suite regression (wave 3)

### Phase 65: Belief-Gated Status Drift + Provenance-Distinctness Fix

**Goal**: Status transitions for a tracked entity update through the existing PE-gated belief machinery completely unmodified, and email evidence can finally satisfy (or correctly fail to satisfy) the distinct-provenance mechanism the differentiator depends on — closing the gap where every Gmail episode today shares one literal `session_id`, making `countDistinctProvenance` mathematically unreachable on email-only evidence.
**Depends on**: Phase 63 (classification output), Phase 64 (resolved entity)
**Requirements**: DRIFT-01, DRIFT-02, DRIFT-03, DRIFT-04, DRIFT-05
**Research flag**: Needs a research/design pass during planning — the provenance-distinctness key redesign is a deliberate change to a load-bearing correctness mechanism; it requires its own explicit design decision and a dry-run against real multi-email status threads before being enabled live (per `research/SUMMARY.md` and `research/PITFALLS.md` Pitfall 3). This is a hard prerequisite for DRIFT-02 to work as claimed, not an optimization to layer on later.
**Success Criteria** (what must be TRUE):

  1. A status lifecycle (applied → interviewing → rejected → offer) is stored as an ordinary fact node and updated only through the existing PE-gated `routeContradiction()`/tombstone/`supersedes` machinery — no new data model, no bi-temporal or supersedes-chain columns — DRIFT-01
  2. A single ambiguous status email holds rather than flipping the belief, and a held (non-decisive) update produces no downstream proposal — DRIFT-02
  3. Provenance distinctness for email evidence is derived from sender identity + thread lineage with quoted/forwarded content stripped first — a test proves 3 genuinely independent status emails count as distinct provenance while 3 copies of one forwarded/quoted thread do not farm false independence — DRIFT-03
  4. Out-of-order evidence (e.g. a rejection processed after an offer during backfill) does not silently revert a newer status — DRIFT-04
  5. Belief-correction accuracy on real multi-inbox traffic is measured and recorded honestly against recense's own harness — with no external accuracy bar cited, since none exists for this feature class — before Phase 66 wires any consumer live — DRIFT-05

**Plans**: 11 plans in 7 waves

Plans:
**Wave 1**

- [x] 65-01-PLAN.md — session_id blast-radius audit (D-02 research gate) + consumer structural lock
- [x] 65-02-PLAN.md — strip-quoted.ts: LLM-free quoted/forwarded detector + residual-emptiness judge (D-06/D-07)
- [x] 65-03-PLAN.md — six Phase 65 dark config knobs, all defaulting to pre-phase behavior (D-09/D-11/D-14/D-16)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 65-04-PLAN.md — provenance-key.ts: sender-domain + thread-lineage key composition, D-07 locked pair at key level
- [x] 65-05-PLAN.md — status-drift.ts: confidence damping, event_ts staleness guard, emission-eligibility predicate (D-09/D-11b/D-13)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 65-06-PLAN.md — Gmail threadId capture, NormalizedRecord.provenance_key threading, backfill chronological ordering (D-04/D-11a)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 65-07-PLAN.md — wire the LOCKED placement shape + D-07 locked pair on countDistinctProvenance + DRIFT-01 machinery/schema pin

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 65-08-PLAN.md — consolidator wiring: drift layer before both routeContradiction sites, per-source contradictionN, counters

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 65-09-PLAN.md — end-to-end DRIFT-02/DRIFT-04 proofs + D-13 hold-never-emits sentinel
- [x] 65-10-PLAN.md — DRIFT-05 dry-run harness + honest measurement + blocking enablement checkpoint

**Wave 7** *(gap closure — 65-VERIFICATION.md DRIFT-04 blocker)*

- [x] 65-11-PLAN.md — SUPPORTING_EVENT_TYPES counts the cold-start `'unrelated'` mint as founding evidence, so the event_ts staleness guard protects a brand-new entity's first status email (DRIFT-04)

### Phase 66: Domain-Neutral Proposal Emit Seam

**Goal**: A validated belief update emits a domain-neutral proposal that a consumer can read and act on over HTTP, and an approve/reject decision can never feed back into recense's own belief — closing the milestone's single largest new correctness risk structurally, not just by documentation or review discipline.
**Depends on**: Phase 64 (resolved entity feeds the proposal's `entity` field), Phase 65 (validated gating semantics — cheaper to fix a threshold or the provenance-distinctness key before any consumer depends on the emission stream than after)
**Requirements**: EMIT-01, EMIT-02, EMIT-03, EMIT-04, EMIT-05, EMIT-06, EMIT-07
**Note**: This phase also owns the additive `action_proposal` table + `ActionProposalSink` foundation (research's proposed standalone "Proposal Schema & Sink Foundation" phase, folded in here — see the milestone-level "Foundation-phase call" note above).
**Success Criteria** (what must be TRUE):

  1. Proposals are emitted through a new `ActionProposalSink` (Noop default, mirroring `ConsolidationSink`) into an additive `action_proposal` table — an install with no consumer configured pays zero cost — EMIT-01
  2. A consumer can list pending proposals and record approve/reject outcomes over the existing authenticated `recense serve` surface (`GET /v1/proposals`, `POST /v1/proposals/:id/approve|reject`), mirroring the shipped `/v1/surface` pattern; each proposal is a flat `{entity, proposed_change, evidence_episode, confidence}` record in recense's own vocabulary with no consumer-specific fields, and carries a deterministic id so a replayed or double-delivered proposal cannot be applied twice — EMIT-02, EMIT-03, EMIT-04
  3. Approving or rejecting a proposal writes only proposal status — never `node.s` or `node.c` — proven by a named "D-43-for-proposals" sentinel test (the milestone's largest new correctness risk, closed structurally here, not merely documented) — EMIT-05
  4. A proposal carries its raw quoted evidence verbatim alongside the structured change, so an approver never decides from model prose alone — EMIT-06
  5. A stale or superseded proposal (its originating belief has since moved again) is detected and refused before an approval can apply it — EMIT-07

**Plans**: 5 plans in 4 waves (planned 2026-08-03). Denser than Phase 65's 10 because the phase is a copy-adapt of three shipped patterns — the `ConsolidationSink` triad, the `surfaced_event`/`SurfaceStore`/`/v1/surface` stack, and the exported-predicate structural-test shape — plus wiring and two sentinels. The frozen `action_proposal` shape is declared first (66-01) so the two workstreams research names, emission logic and HTTP surface, can proceed in parallel against it.

Plans:
**Wave 1**

- [x] 66-01-PLAN.md — Frozen contract foundation: additive schema-v17 `action_proposal` table + `ActionProposalStore` + pure staleness classifier + three-way frozen-key-set lock (EMIT-02, EMIT-04, EMIT-07, wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 66-02-PLAN.md — `ActionProposalSink` triad (interface / Noop default / SQLite) + deterministic content-hash `proposalId` + `actionProposalSinkEnabled` dark knob (EMIT-01, EMIT-04, EMIT-06, wave 2)
- [x] 66-03-PLAN.md — HTTP surface: `GET /v1/proposals` lock-free read + `POST /v1/proposals/:id/approve|reject` per-call lock, typed 404/409/503 mapping, EMIT-07 staleness refusal with durable terminal status (EMIT-03, EMIT-05, EMIT-07, wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 66-04-PLAN.md — Consolidator emission wiring at the nine decisive `applyDecision` sites gated on the imported `isEmissionEligible`, verbatim evidence quote, sleep-pass injection behind the dark knob, doctor dimension 10, and Phase 65's hold sentinel extended to the real sink (EMIT-01, EMIT-06, wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 66-05-PLAN.md — The named "D-43-for-proposals" two-layer sentinel (exported structural predicate + planted offender; whole-table `node`/`edge` runtime snapshot) and the D-13 online-LLM-free regression extended to `/v1/proposals` (EMIT-03, EMIT-05, wave 4)

### Phase 67: Reference Consumer Adapter

**Goal**: A thin in-repo consumer proves the emit-seam contract works end-to-end without recense knowing the consumer's schema, and the pattern is documented well enough for a real third-party integration (jobfill, later, in its own repo) to be built against it.
**Depends on**: Phase 66 (needs a stable, versioned HTTP contract to consume)
**Requirements**: CONSUME-01, CONSUME-02, CONSUME-03
**Success Criteria** (what must be TRUE):

  1. An in-repo reference consumer adapter (`clients/proposal-reference/`, a structural sibling of `clients/telegram/`) reads pending proposals and maps them onto its own local rows, proving the contract end-to-end — CONSUME-01
  2. The reference adapter imports zero engine modules — enforced by its own `tsconfig.json` boundary (no `paths` into `src/`) and its own import-boundary test, a sibling copy of `clients/telegram/tests/import-boundary.test.ts`'s guard rather than a reuse of it (the existing test only scans `clients/telegram/`) — CONSUME-02
  3. `docs/reference-client.md` documents the proposal contract well enough that a third-party consumer could be written against it, following the existing adopter-template pattern — CONSUME-03

**Plans**: 3 plans in 3 waves

Plans:
**Wave 1**

- [x] 67-01-PLAN.md — Adapter scaffold: compile boundary, sibling import-boundary guard wired into `npm test`, fail-closed config, HTTP proposal client, and the adapter-owned local row store (CONSUME-01, CONSUME-02, wave 1)

**Wave 2** *(blocked on Wave 1)*

- [x] 67-02-PLAN.md — The D-03 outcome loop (list to map to apply to approve/reject to terminal refusal) plus its stub-server behavioral proof: replay idempotency, 409-terminal, schema-stop, kind-skip (CONSUME-01, wave 2)

**Wave 3** *(blocked on Wave 2)*

- [x] 67-03-PLAN.md — Repo-level end-to-end proof through the adapter's public entry against the real served contract incl. the 409 refusal round-trip, and the `docs/reference-client.md` proposal-consumer section with both mandatory carry-forwards (CONSUME-01, CONSUME-02, CONSUME-03, wave 3)

### Phase 68: Telegram HITL Belief-Kind Extension

**Goal**: A user approves or rejects a belief-shaped proposal from the same Telegram surface already used for tool-call approvals, without rubber-stamping becoming the path of least resistance as multi-inbox email volume grows.
**Depends on**: Phase 66 (needs the emit seam's stable contract to poll and act on)
**Requirements**: APPROVE-01, APPROVE-02, APPROVE-03, APPROVE-04
**Success Criteria** (what must be TRUE):

  1. A user can approve or reject a belief-shaped proposal from Telegram, with the concrete `from → to` transition visible on the decision itself — APPROVE-01
  2. Belief-kind proposals are a `kind` discriminator on the existing `StoredProposal` union that bypasses the client-side LLM tool-mapping step while reusing the existing expiry and rate-cap machinery — zero changes to `proposal-engine.ts` or `proposal-store.ts` — APPROVE-02
  3. Same-entity same-day proposals are batched into one prompt, and held (non-decisive) updates are never surfaced to the user — APPROVE-03
  4. Raw numeric confidence is never shown to the user and is never a programmatic approval gate — the PE gate is the only gate — APPROVE-04

**Plans**: 3 plans

Plans:

**Wave 1**

- [x] 68-01-PLAN.md — StoredProposal becomes a kind-discriminated union with a belief member that rides the frozen store's expiry/cap machinery, plus the /v1/proposals HTTP bridge and the zero-diff lock (APPROVE-02, wave 1)

**Wave 2** *(blocked on Wave 1)*

- [ ] 68-02-PLAN.md — The v3 callback codec and the structured decision surface (from → to on the tap targets), and the poll pass that batches same-entity same-day proposals into one prompt behind a default-OFF gate (APPROVE-01, APPROVE-03, APPROVE-04, wave 2)

**Wave 3** *(blocked on Wave 2)*

- [ ] 68-03-PLAN.md — The '3|' dispatch branch and belief decision handler with full refusal mapping and the approval-rate self-report, the numeric-confidence absence scan, and the repo-level e2e against the real served contract (APPROVE-01, APPROVE-02, APPROVE-04, wave 3)

### Phase 69: Retrieval Upgrade — Entity-Anchored Ambient Recall

**Goal**: A memory-shaped prompt in any Claude Code session surfaces the facts that actually answer it — including facts reachable only by name rather than by topic similarity — instead of the five most cosine-similar nodes, and the agent can verify what it was given rather than falling back to grep.
**Depends on**: Phase 64 (reuses that phase's broadened candidate generator — exact/entity-keyed ∪ BM25 ∪ dense union over the RECON machinery — rather than building a second, divergent one for the recall path)
**Requirements**: TBD (derive from SEED-005 during discuss/plan)
**Seed**: `.planning/seeds/SEED-005-retrieval-upgrade-recall-audit.md` — findings F1–F5 from a 1,942-turn / 302-session live transcript audit (`scripts/eval/recall-audit.py`)
**Success Criteria** (what must be TRUE):

  1. Ambient recall reaches facts anchored by a proper noun in the prompt, not only by blended-prompt topic similarity — the audit's "contract with vtx" class (asked twice, whiffed twice, facts present in the graph) resolves, via LLM-free indexed entity lookup on the hot path
  2. Cross-project recall is preserved (resume sessions legitimately pull VTX/recense facts), but a foreign-project deep-dive document no longer outranks own-project facts — the audit measured 49% of scoped injected lines as foreign, scoring *higher* than own-project (0.541 vs 0.530)
  3. The injected block carries each fact's 1-hop relations — the edges `buildHonestOneHopTrace` already computes for the viz trace and currently discards before injection — within the existing token budget
  4. `recense recall` can return cited evidence (node ids + traversed edges) instead of only an LLM-composed prose inference, so a caller can verify a claim without grepping
  5. Every change is gated on the 58-prompt memory-shaped eval set extracted from real sessions (`scripts/eval/recall-audit-evalset.py`): no regression on the 42 currently-hit prompts, and the injected-line relevance improves on the whiffs

**Explicit decision reversal**: criterion 2 contradicts **D-S1** ("scope is provenance, not a retrieval signal"). This must be recorded as a deliberate reversal in the phase CONTEXT with its rationale, not slipped in as an implementation detail.

**Plans**: TBD

## Backlog

_B-01 (Email ingest → domain-neutral action proposals) was promoted to the v10.0 Action Proposals milestone on 2026-07-29 — see "Current Milestone: v10.0 Action Proposals" in PROJECT.md and "Phase Details — v10.0 Action Proposals" above._

**B-02 through B-05 captured 2026-07-30** from a competitive/literature review triggered by an inbound email from a directly overlapping project (Dense-Mem, `github.com/markhuangai/dense-mem`). Ranked by expected quality improvement to recense. Full reasoning and source links in each item.

### B-02: Provenance ceiling on belief confidence, not just salience

**Source:** [arXiv 2606.22030](https://arxiv.org/html/2606.22030) — "When Does Belief-Based Agent Memory Help? Reliability-Conditional Updating and Provenance-Capped Poisoning Defense". Composes trust as `r = min(provenance, content)`: content-inferred confidence can only *lower* trust within a channel's ceiling, never raise it. Measured: volumetric flood attacks held at **0% success vs 100%** for last-write-wins baselines.

**Gap in recense:** provenance is applied to **salience** (`allocation-gate.ts:88-93`, `composite * sourceWeight`, gmail=0.35, post-cap — multiplicative, so actually stricter than the paper's `min()`), and `hardKeep` excludes observed channels, and `decay.ts:191` never evicts evidence-backed nodes. But there is **no provenance ceiling on the confidence of the resulting fact node**. Once a gmail episode clears `consolSkipThresholdBySource.gmail` (0.4), the fact it produces can strengthen through repetition toward the same confidence as an `asserted_by_user` fact.

**Why it matters here:** combined with the deferred `session_id: 'ingest:gmail'` provenance collapse (Phase 65 / DRIFT-03), volumetric flooding via email is the soft spot — on exactly the ingest surface Phase 62 opened. Reframes Phase 65's provenance work as security hardening rather than bookkeeping.

**Shape:** cap consolidated-node confidence by the originating channel's weight. Small and surgical; touches the strength/confidence path, not the graph model.

### B-03: Taint propagation through `derived_from` edges

**Source:** same paper. It names **taint-tracking through derivation chains** as *required* to stop laundering (poison routed via a trusted intermediary defeats naive provenance tiering) — and explicitly states the authors characterize the requirement but **do not implement it**.

**Why recense is positioned for it:** the substrate already exists — `derived_from` edges (`EdgeKind` in `types.ts:38`) with citation-verification such that injection cannot fabricate targets (`insight-generator.ts:187`, T-38-05). Insight nodes are already `origin='inferred'`, confidence-capped, and non-strengthening (`types.ts:23`), and the live-fact predicate already excludes `inferred` (`types.ts:69`).

**Why it's the strongest item:** a named open problem in current literature, buildable on shipped machinery, and aligned with the stored positioning decision (lead with abstraction + PE-gating; never claim OSS/local/in-place/viz as unique). This is contribution, not catch-up.

**Shape:** propagate a distrust/taint scalar along `derived_from` in-edges during the sleep pass; a belief derived from tainted members inherits a capped ceiling. Needs its own design pass — do not fold into another phase.

### B-04: Reliability from epistemic markers in the extraction call

**Source:** same paper. Extracting per-observation reliability from linguistic hedging ("maybe" lowers, "confirmed" raises) moves contradiction/staleness accuracy from **67% → 100%** on LoCoMo. Critically, the paper also shows that *constant* reliability degenerates belief-updating into "soft recency-following" — indistinguishable from last-write-wins. Without a reliability signal, Bayesian updating **ties** naive overwrite (~36 token-F1).

**Shape:** an optional confidence field on the existing per-episode extraction call — the TEMP-02 `due_at`/`action_type` threading precedent, so **zero net-new LLM calls**. Hard constraint: it may only ever *lower* confidence, never raise it, composing under B-02's ceiling. That matches the existing D-43 non-strengthening doctrine rather than fighting it.

**Note:** cheap, but its value is conditional on B-02 landing — the paper's own finding is that reliability without a provenance cap is what lets confidently-phrased poison through.

### B-05: Run the MnemeBrain Belief Maintenance Benchmark

**Source:** [BMB](https://mnemebrain.github.io/mnemebrain-benchmark/) / [MnemeBrain architecture](https://mnemebrain.ai/blog/mnemebrain-hn-post.html). 48 tasks across 8 categories (contradiction detection, belief revision, evidence tracking, temporal decay, explainability, sandboxing, consolidation). Open source with a public leaderboard. Reported: MnemeBrain 100% / lite 93%, structured memory 36%, mem0 29%, all retrieval-based systems 0% on contradiction detection.

**Honest expectation — this is the reason to run it, not a reason to skip it:** recense resolves contradictions at **write** time (tombstone-and-replace, one-deep `prev_value` breadcrumb). MnemeBrain computes TruthState at **read** time as a pure function over an append-only EvidenceLedger (polarity `SUPPORTS`/`ATTACKS` + weight + source + timestamp), which is *why* it can claim 100% — the contradiction is never destroyed. After a recense reconcile the contradiction is not a queryable belief state. recense's extreme/categorical-divergence path (`consolidator.ts:1275`) and flip-back path (`:1224`, `:1323`) do leave both values coexisting, so there is a partial BOTH state, but only at extreme magnitude. Mitigating detail: `consolidation_event` is retained and keyed by `episode_id`, and the sink emits `contradict_reconcile` / `contradict_force_destabilize` — the history exists, just not as belief state.

**Why run it anyway:** it is the emerging third-party evaluation frame in this space. Better to own the number than to have an interviewer or a competitor produce it first. A poor contradiction-detection score is defensible if it is a stated design tradeoff; it is not defensible as a surprise.

**Explicitly NOT recommended** (evaluated and declined 2026-07-30):

- **Belnap four-valued rewrite** — architectural rewrite of the write path; collides with the engine-faithfulness constraint in CLAUDE.md.
- **AGM/TMS formalization** — Kumiho's staked ground ([paper](https://kumiho.io/pdfs/kumiho_AI_cognitive_memory_paper.pdf), PDF did not parse, unread). PE-gated reconsolidation is a defensible alternative foundation, not a weaker version of AGM.
- **Deterministic freshness signals** — already shipped. [arXiv 2606.01435](https://arxiv.org/pdf/2606.01435) argues LLMs must not judge recency (inconsistent temporal reasoning, hallucinated timestamps, context-dependent reversals) and prescribes explicit timestamps → insertion order → deterministic tiebreak. Phase 62 shipped exactly that (`event_ts` + `orderEpisodesForConsolidation`), and `JudgeVerdict` carries no freshness field — the judge decides only `relation` + `magnitude`. Keep as a talking point, no work needed.

**Deferred but worth reconsidering:** bi-temporal fact validity windows (Zep/Graphiti; +15pts over mem0 on LongMemEval, 63.8% vs 49.0%). Phase 62 explicitly declined bi-temporal columns. Becoming table stakes for temporal reasoning, but a larger change than B-02–B-04.
