# Roadmap: brain-memory (recense)

## Milestones

- ✅ **v1.0 Core learning loop** — Phases 1–8 (shipped 2026-06-09) — full detail: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Open-Source Release** — Phases 9–10 (shipped 2026-06-10) — full detail: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0 Interface Layer** — Phases 11–17 (shipped 2026-06-13)
- ✅ **v3.1 Schema Depth & Brain-Window Polish** — Phases 18–19 (shipped 2026-06-15)
- ✅ **v4.0 Proactive Memory** — Phases 20–23 (shipped 2026-06-17) — full detail: [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)
- 🔲 **v5.0 Foundational Memory Store + Reader Layer** — Phases 24–27 (active)

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

### v5.0 Foundational Memory Store + Reader Layer (Phases 24–27) — active

recense becomes the single source of truth for the founder's knowledge. Dependency chain: 24 → 25 → 26 → 27. Phase 24's clean-consolidation gate (SCOPE-01) unblocks all downstream phases. Phase 27 depends on 24 (scope), 25 (clean entities for gather), and 26 (semantic gather breadth).

**Engine invariants across all phases:** single-tenant; graph is source of truth, vector is derived cache; never delete an evidence-backed fact via decay; surfacing/inference never strengthens a belief (D-43); online paths stay LLM-free; agents live outside the engine.

- [ ] **Phase 24: Foundational Store** — verify the already-landed engine layer + import-memory CLI: confirm FK-free consolidation, re-enable the hourly agent, then run the human-gated consolidate→verify→retire migration
- [ ] **Phase 25: Entity Dedup / Prune** — repeatable consolidation pass merges near-duplicate entities into canonical nodes, rewiring edges and tombstoning duplicates without losing provenance
- [ ] **Phase 26: Retrieval-Embedding Fix** — fix the sub-0.7 cosine weakness (query-instruction prefix and/or text-embedding-3-large), validated via cached extraction replay (~$3–5 API)
- [ ] **Phase 27: Reader Layer** — productize the validated reader slice: doc-as-node generation with inline citations, /doc route + Reader/Brain toggle, staleness/regen, doc→doc corpus graph

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
**Plans**: TBD

### Phase 25: Entity Dedup / Prune

**Goal**: The entity layer is cleaned up — near-duplicate entity nodes (e.g. the 8+ "brain-memory" fragments surfaced by the reader slice) are merged into canonical nodes via a repeatable, origin-guarded consolidation pass, so retrieval and doc generation are no longer muddied by fragments
**Depends on**: Phase 24 (`node_scope` live and consolidation stable — scope-aware merging requires clean scope attribution)
**Requirements**: DEDUP-01, DEDUP-02, DEDUP-03
**Success Criteria** (what must be TRUE):
  1. Running the dedup pass against the live DB produces a canonical entity node for each near-duplicate cluster (matched by value similarity + embedding cosine above threshold); the pass is repeatable and produces the same result on a second run — DEDUP-01
  2. After the pass, the canonical node carries all edges that previously pointed to any duplicate; duplicates are tombstoned, not deleted; `PRAGMA foreign_key_check` returns empty; evidence-backed provenance is preserved for every merged node — DEDUP-02
  3. The distinct entity count for "brain-memory" (currently 8+ fragments) drops to 1 canonical node with no observable regression to recall accuracy on a sample query set — DEDUP-03
**Plans**: TBD

### Phase 26: Retrieval-Embedding Fix

**Goal**: The sub-0.7 cosine retrieval weakness — which prevents the reconsolidation judge from engaging on knowledge-update cases because contradicting count-claims never cluster as candidates — is diagnosed and fixed, and the fix is validated via the cached extraction-replay harness without re-extraction
**Depends on**: Phase 25 (clean entity layer ensures the fix is validated against a representative graph, not one muddied by duplicate nodes)
**API budget**: ~$3–5 (extraction-replay re-eval; explicit approval required before any paid run)
**Requirements**: RETR-01, RETR-02, RETR-03
**Success Criteria** (what must be TRUE):
  1. The root cause of the sub-0.7 cosine weakness is diagnosed (embedder model, missing query-instruction prefix, or cosine threshold); a fix is applied — either the query-instruction prefix for the current embedder, upgrade to `text-embedding-3-large`, or both — RETR-01
  2. Running the extraction-replay harness (no re-extraction from granite) shows improved EVAL-01 KU retrieval score with reconsolidation judge engaging on at least some KU contradiction cases; EVAL-02 belief-correction score does not regress below 84.6% — RETR-02
  3. Any embedder model change triggers a full re-embedding of stored node texts so the vector cache stays consistent with the graph; the graph remains the source of truth throughout (no node deleted; embeddings are derived and rebuildable) — RETR-03
**Plans**: TBD

### Phase 27: Reader Layer

**Goal**: The validated reader slice (19/19 citations resolve, 0 invented) is promoted to a real product feature — doc-as-node lifecycle-exempt generation with inline fact-refs, a /doc route with Reader/Brain toggle, citation staleness detection and regen, and a navigable doc→doc corpus graph — retiring Obsidian as the authoring layer
**Depends on**: Phase 24 (scope-aware fact gather), Phase 25 (clean entity layer for gather quality), Phase 26 (semantic embedding breadth for complete coverage beyond lexical+entity gather); the validated slice already works on lexical+entity gather, so this phase promotes rather than rebuilds
**Requirements**: READER-01, READER-02, READER-03, READER-04
**Success Criteria** (what must be TRUE):
  1. A generated project doc exists as a `type='doc'` node — excluded from recall-embedding, eviction, decay, `training_eligible`, and claim-extraction; its write path routes through the single-writer consolidator; every substantive claim carries an inline `recense://fact/<id>` ref that resolves to a live node — READER-01
  2. The viz serves the doc at a `/doc` route; a Reader/Brain toggle lets the user switch between the prose view and a brain graph focused on that doc's cited atoms; clicking a fact-ref in the prose focuses the correct atom in the graph with selection state preserved across the toggle — READER-02
  3. On doc load, the reader detects stale citations (`node.last_access > doc.generatedAt`), surfaces a `prev_value → value` diff for changed facts, and flags refs to tombstoned facts as "cited fact was removed"; a regenerate action rebuilds the doc from current facts — READER-03
  4. A doc→doc corpus graph (`doc_link` edges) is navigable in the viz; centering on a project surfaces its docs alongside neighboring projects and related entities, subsuming the need for a separate per-project graph view — READER-04
**Plans**: TBD
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
| 24. Foundational Store | v5.0 | 0/TBD | Not started | - |
| 25. Entity Dedup / Prune | v5.0 | 0/TBD | Not started | - |
| 26. Retrieval-Embedding Fix | v5.0 | 0/TBD | Not started | - |
| 27. Reader Layer | v5.0 | 0/TBD | Not started | - |
