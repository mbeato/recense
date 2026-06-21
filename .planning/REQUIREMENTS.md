# Requirements — v6.0 Project Onboarding

**Milestone goal:** Onboard a fresh/unexplored project into the brain on demand via an agentic survey (summarized knowledge, not raw code) → episodes → consolidation; generalized doc ingest; idempotent re-ingest; scoped project recall + auto-corpus.

**Core value alignment:** The memory *learns and stays correct over time*. Onboarding feeds the same abstraction + reconsolidation machinery — a re-ingest of a changed project updates the right belief in place rather than duplicating, and the survey produces generalizations (schemas) the user never explicitly stated.

## v6.0 Requirements

### INGEST — Agentic project survey (core)

- [x] **INGEST-01**: A user can run `recense ingest-project <dir>` to onboard a project; an agent surveys the repo (README, structure, key modules, conventions, entry points, gotchas) and emits **summarized observations** as episodes through the existing pipeline.
- [x] **INGEST-02**: Ingested project knowledge is **scope-tagged** to that project (`node_scope`), so recall and the corpus attribute it under the correct `[scope]`.
- [x] **INGEST-03**: The survey emits **summarized semantic knowledge** (architecture, conventions, decisions, current state, gotchas) — raw code dumps and low-value structural facts (e.g. "file X imports Y") are excluded by a quality gate.
- [x] **INGEST-04**: Ingestion runs entirely through the **offline** episodic → consolidation path (origin=`observed`); it never blocks an online path and yields facts + schemas like any other source.

### DOCING — Generalized document ingest

- [x] **DOCING-01**: A user can ingest a project's **own documents** (README, `docs/*.md`, `CLAUDE.md`) directly — not only the single configured Obsidian vault dir — with origin=`observed` and project scope.

### REINGEST — Idempotent re-ingest

- [x] **REINGEST-01**: Re-running ingestion on a changed project **reconciles with existing beliefs** (updates in place via reconsolidation) rather than minting duplicates; a second run on an unchanged project is a near-no-op.
- [x] **REINGEST-02**: A **per-project cursor** makes re-ingest incremental — only changed/new content is re-surveyed and re-ingested, not a full re-survey each run.

### RECALL — Project recall surface

- [ ] **RECALL-01**: A user can recall a specific project's ingested knowledge via **scoped recall** (`[scope]`-filtered).
- [ ] **RECALL-02**: Onboarding **auto-promotes/generates the project's schema-anchored corpus doc** so a newly-onboarded project is immediately browsable in the reader.

### VIZ-POLISH — Cross-surface visual polish (Phase 34, standalone)

> Polish pass over the four live viz surfaces (Reader, Corpus 2D graph, Detail panel/page, Brain HUD/controls). Two axes only: spacing/alignment consistency and states & transitions. CSS + state-handling diff — no structural/composition redesign. Design contract: `phases/34-visual-polish-pass/34-UI-SPEC.md`.

- [ ] **VIZ-POLISH-01**: Across all four surfaces, spacing/alignment follows a consistent scale — the cramped/misaligned/uneven elements the founder flagged (34-ROUGH-EDGES B2, C1, C2 + detail-spacing audit) are resolved, verified by a per-surface before/after visual review.
- [ ] **VIZ-POLISH-02**: Every async/interactive surface has explicit loading, empty, and error states (no blank or abrupt gaps), and interactive elements have visible hover/focus feedback with smooth transitions (corpus state coverage + R1 sticky-on-scroll + B3 mode-state visibility).
- [ ] **VIZ-POLISH-03**: No amber is introduced for non-activation states (rest stays muted rose/slate/mauve; amber reserved for activation/hover); the 3D brain density anchor is visually unchanged; the diff is CSS + state-handling only (no structural/composition change); `package.json` runtime deps unchanged.

## Future Requirements (deferred)

- Continuous auto-watch re-ingest (vs manual `ingest-project` runs) — a watcher that re-surveys on project change.
- Cross-project relationship surfacing (e.g. "these two projects share an architecture pattern").
- Non-markdown doc formats (PDF/source-comment extraction) beyond README/`*.md`/`CLAUDE.md`.

## Out of Scope (explicit exclusions)

- **Raw code indexing / RAG-over-code** — rejected: line-by-line code mints low-value noise facts; the brain stores *semantic knowledge*, not a code index.
- **Multi-tenant namespaces** — scope is attribution provenance, not tenancy (SEED-003 dormant by design); retrieval stays global.
- **Ingesting arbitrary external web content** — this milestone is project onboarding, not a general web ingester.

## Traceability

Each requirement maps to exactly one phase. Filled by the roadmapper.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INGEST-01 | Phase 30 | Complete |
| INGEST-02 | Phase 30 | Complete |
| INGEST-03 | Phase 29 | Complete |
| INGEST-04 | Phase 30 | Complete |
| DOCING-01 | Phase 31 | Complete |
| REINGEST-01 | Phase 31 | Complete |
| REINGEST-02 | Phase 31 | Complete |
| RECALL-01 | Phase 32 | Pending |
| RECALL-02 | Phase 32 | Pending |
| VIZ-POLISH-01 | Phase 34 | Pending |
| VIZ-POLISH-02 | Phase 34 | Pending |
| VIZ-POLISH-03 | Phase 34 | Pending |

**Coverage:**
- v6.0 requirements: 9 total (INGEST 4 · DOCING 1 · REINGEST 2 · RECALL 2)
- Phase 34 (standalone polish): 3 (VIZ-POLISH)
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-06-19 (v6.0 Project Onboarding). Prior milestone reqs archived at milestones/v5.0-REQUIREMENTS.md.*
