# Requirements — v6.0 Project Onboarding

**Milestone goal:** Onboard a fresh/unexplored project into the brain on demand via an agentic survey (summarized knowledge, not raw code) → episodes → consolidation; generalized doc ingest; idempotent re-ingest; scoped project recall + auto-corpus.

**Core value alignment:** The memory *learns and stays correct over time*. Onboarding feeds the same abstraction + reconsolidation machinery — a re-ingest of a changed project updates the right belief in place rather than duplicating, and the survey produces generalizations (schemas) the user never explicitly stated.

## v6.0 Requirements

### INGEST — Agentic project survey (core)

- [x] **INGEST-01**: A user can run `recense ingest-project <dir>` to onboard a project; an agent surveys the repo (README, structure, key modules, conventions, entry points, gotchas) and emits **summarized observations** as episodes through the existing pipeline.
- [ ] **INGEST-02**: Ingested project knowledge is **scope-tagged** to that project (`node_scope`), so recall and the corpus attribute it under the correct `[scope]`.
- [x] **INGEST-03**: The survey emits **summarized semantic knowledge** (architecture, conventions, decisions, current state, gotchas) — raw code dumps and low-value structural facts (e.g. "file X imports Y") are excluded by a quality gate.
- [ ] **INGEST-04**: Ingestion runs entirely through the **offline** episodic → consolidation path (origin=`observed`); it never blocks an online path and yields facts + schemas like any other source.

### DOCING — Generalized document ingest

- [ ] **DOCING-01**: A user can ingest a project's **own documents** (README, `docs/*.md`, `CLAUDE.md`) directly — not only the single configured Obsidian vault dir — with origin=`observed` and project scope.

### REINGEST — Idempotent re-ingest

- [ ] **REINGEST-01**: Re-running ingestion on a changed project **reconciles with existing beliefs** (updates in place via reconsolidation) rather than minting duplicates; a second run on an unchanged project is a near-no-op.
- [ ] **REINGEST-02**: A **per-project cursor** makes re-ingest incremental — only changed/new content is re-surveyed and re-ingested, not a full re-survey each run.

### RECALL — Project recall surface

- [ ] **RECALL-01**: A user can recall a specific project's ingested knowledge via **scoped recall** (`[scope]`-filtered).
- [ ] **RECALL-02**: Onboarding **auto-promotes/generates the project's schema-anchored corpus doc** so a newly-onboarded project is immediately browsable in the reader.

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
| INGEST-02 | Phase 30 | Pending |
| INGEST-03 | Phase 29 | Complete |
| INGEST-04 | Phase 30 | Pending |
| DOCING-01 | Phase 31 | Pending |
| REINGEST-01 | Phase 31 | Pending |
| REINGEST-02 | Phase 31 | Pending |
| RECALL-01 | Phase 32 | Pending |
| RECALL-02 | Phase 32 | Pending |

**Coverage:**
- v6.0 requirements: 9 total (INGEST 4 · DOCING 1 · REINGEST 2 · RECALL 2)
- Mapped to phases: 9
- Unmapped: 0

---
*Requirements defined: 2026-06-19 (v6.0 Project Onboarding). Prior milestone reqs archived at milestones/v5.0-REQUIREMENTS.md.*
