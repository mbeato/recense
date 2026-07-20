# Phase 29: Survey Quality Spike - Context

**Gathered:** 2026-06-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove — before building the full `ingest-project` command — that an **agentic survey of one real repo produces facts and schemas with genuine semantic signal** (not raw-code noise) when run through the *existing* offline episodic → consolidation pipeline. The phase output is a **go/no-go decision** plus **calibration inputs** (summarization prompt shape, summarization level, quality-gate definition, scope-tagging convention) that Phases 30–32 consume.

**This is a SPIKE** (experiment, not product): throwaway harness, run on a scratch DB, no production wiring. The `ingest-project` command, SourceAdapter implementation, idempotent re-ingest, and scoped recall/auto-corpus are all OUT of scope (Phases 30–32).

Requirement: **INGEST-03** (summarized semantic knowledge; raw-code dumps and structural trivia excluded by a quality gate).

</domain>

<decisions>
## Implementation Decisions

### Spike experiment design (founder-confirmed — load-bearing)
- **D-01 (Survey target):** Survey **`~/usage`** (package `@mbeato/contextscope` — a CLI + local Next.js dashboard auditing per-turn Claude Code token context). Founder-chosen: small/self-contained (~673 non-vendored files), well-known to the founder so fact quality is judgeable, and clearly distinct from recense (no collision with customer-zero brain content). Scope slug derives to **`usage`** via `cwdToScope('/Users/vtx/usage')`.
- **D-02 (Go/no-go judgment method):** **LLM-judge tally + founder spot-check.** A throwaway judge pass scores each resulting fact `genuine | noise` and reports a per-area tally; the founder spot-checks the verdicts. This is the success measure for Success Criterion 2 (≥5 genuine facts per surveyed area). More rigorous/repeatable than pure eyeballing, and the judge harness is disposable.

### Survey mechanism (Claude's discretion — recommended defaults, founder may override at plan time)
- **D-03 (Survey agent transport):** Use the **existing `claude -p` headless transport** (Claude Code CLI with Read/Grep/Glob), the same stack already used for extract/judge — **net-zero new runtime deps** (engine invariant). The survey runs as a throwaway spike script, **NOT** a `SourceAdapter` implementation (the adapter is Phase 30 work).
- **D-04 (Episode emission path):** The spike script splits the survey agent's output into episode-sized records and appends them through the **real pipeline** — `IngestionPipeline.recordEvent` → `EpisodicStore.append` — with `origin='observed'` (never `asserted_by_user`), `source='project-survey'`, and a content-addressed `external_id` (`contentExternalId`). Each emitted episode's **cwd must be set to `/Users/vtx/usage`** so consolidation's `resolveNodeScope` stamps facts `[usage]` — validating the scope-tagging convention is a spike deliverable.
- **D-05 (Isolation):** Run the spike on a **scratch DB**, never the live brain — experimental survey episodes must not pollute customer-zero. Use a fresh DB (or a WAL-safe copy: `.db`+`-wal`+`-shm`, per the WAL-copy gotcha). Set `RECENSE_LOCK_PATH=/tmp/recense-spike.lock` so the spike's consolidation pass does not collide with the live hourly sleep-pass (global write lock fast-fails, no queue).
- **D-06 (Surveyed areas):** Survey across the INGEST-03 areas — **architecture, conventions, decisions, current state, gotchas** — because Success Criterion 2 measures ≥5 genuine facts *per surveyed area*. `usage` has real surface for each (README.md, AGENTS.md, DESIGN.md, PLAN.md, app/, bin/, lib/, plugin/, scripts/).
- **D-07 (Quality-gate definition — calibration deliverable):** The gate **keeps** summarized semantic ("why-level") knowledge — architecture rationale, conventions, design decisions, current state, gotchas — and **excludes** raw code lines, structural trivia ("file X imports Y", dependency lists), boilerplate, and config dumps. The exact gate phrasing is itself a Phase-30 calibration output (Success Criterion 4).
- **D-08 (Summarization prompt shape — calibration deliverable):** Prompt the survey agent for **summarized observations per area, "why not what,"** with an explicit instruction to emit **no raw code and no import/dependency graphs**, as natural-language belief statements (≈one belief per line) suited to the existing claim extractor. The final prompt shape is recorded as calibration for Phase 30.

### Claude's Discretion
- Number of survey episodes / chunking granularity, judge model tier (reuse the existing judge-tier config as in `generate-doc-cli`), and the exact go/no-go threshold framing are left to plan/execution, subject to the criteria above.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 29: Survey Quality Spike" — goal, 4 success criteria, v6.0 engine invariants
- `.planning/REQUIREMENTS.md` — INGEST-03 (this phase), plus INGEST-01/02/04, REINGEST-01/02, RECALL-01/02 (downstream context)
- `.planning/PROJECT.md` §"Current Milestone: v6.0 Project Onboarding" — the agentic-survey primitive and the 4 confirmed capabilities

### Ingestion seams the spike rides
- `src/source/source-adapter.ts` — `NormalizedRecord` shape, `SourceAdapter` contract, `contentExternalId`, origin/role rules (the Phase-30 adapter target; spike emits records of the same shape without implementing the interface)
- `src/adapter/ingest-cli.ts` — `runPullPhase` / `recordEvent` precedent for feeding non-conversation records into the pipeline under a lock
- `src/ingest/pipeline.ts` — `IngestionPipeline` + `AllocationGate` (the episode append path)
- `src/db/episode-store.ts` — `EpisodicStore.append`
- `src/lib/scope.ts` — `cwdToScope` / `resolveNodeScope` (scope-tagging: `/Users/vtx/usage` → `usage`)
- `src/consolidation/run-sleep-pass.ts` — `runConsolidation` (the offline path that mints facts + induces schemas)
- `src/adapter/import-memory-cli.ts` — precedent for emitting episodes from a non-conversational source
- `src/adapter/lockfile.ts` — lock + `RECENSE_LOCK_PATH` override
- `src/adapter/generate-doc-cli.ts` / `src/llm/claude-headless-client.ts` — judge-tier model + headless `claude -p` transport precedent (reuse for both the survey agent and the D-02 judge)

### Surveyed repo
- `/Users/vtx/usage/` — survey target (README.md, AGENTS.md, DESIGN.md, PLAN.md, app/, bin/, lib/, plugin/, scripts/)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`IngestionPipeline.recordEvent` / `EpisodicStore.append`**: the spike emits survey observations as episodes through this exact path — no new ingestion code, just a feeder script.
- **`cwdToScope` / `resolveNodeScope`**: scope tagging is free if each survey episode carries `cwd=/Users/vtx/usage`; consolidation stamps `[usage]`.
- **`runConsolidation`**: the same offline pass that fires on conversation turns produces facts + induces schemas from survey episodes — Success Criteria 2 & 3 ride it unchanged.
- **Headless `claude -p` transport** (`claude-headless-client.ts`, judge-tier config in `generate-doc-cli.ts`): reused for the survey agent AND the D-02 genuine/noise judge — net-zero new deps.
- **`contentExternalId`**: idempotent dedup key for survey records (full re-ingest idempotency is Phase 31, but the helper applies now).

### Established Patterns
- **Net-zero new runtime deps** + **offline-only ingestion** (origin=`observed`) + **graph-as-truth** — all v6.0 invariants the spike must honor.
- **Spike = throwaway on scratch DB**: don't wire production CLI; don't touch the live brain DB.
- **Global write lock is one lock**: override `RECENSE_LOCK_PATH` to avoid colliding with the hourly sleep pass.

### Integration Points
- Survey output → episode records (`source='project-survey'`, `origin='observed'`, `cwd=/Users/vtx/usage`) → `recordEvent` → scratch DB → `runConsolidation` → facts `[usage]` + ≥1 schema → recall/judge inspection.

</code_context>

<specifics>
## Specific Ideas

- The spike must produce **written calibration notes** (Success Criterion 4): the final summarization prompt shape (D-08), the summarization level, the quality-gate definition (D-07), and the scope-tagging convention (D-04) — explicitly framed as inputs for Phase 30's `ingest-project` command.
- Success bar to hit: (1) survey completes with no new deps; (2) ≥5 facts/area judged genuine (D-02 judge tally + spot-check); (3) ≥1 schema induced from `usage` facts; (4) calibration notes written. All four → go; shortfall → no-go with documented reasons.

</specifics>

<deferred>
## Deferred Ideas

- **Full `ProjectSurveyAdapter` (SourceAdapter implementation) + `recense ingest-project <dir>` command** → Phase 30 (INGEST-01/02/04).
- **Idempotent re-ingest + per-project cursor + doc ingest** → Phase 31 (DOCING-01, REINGEST-01/02).
- **Scoped project recall + auto-promoted/-generated corpus doc** → Phase 32 (RECALL-01/02).

### Reviewed Todos (not folded)
- **`content-hardening-deferred.md`** (matched 0.6 on keywords "phase","structural") — false match; it's transcript/PDF content hardening, orthogonal to a survey spike. Not folded.
- **`viz-search-and-hull-quality.md`** (matched 0.4 on "phase","quality") — false match; viz work unrelated to ingestion. Not folded.

</deferred>

---

*Phase: 29-survey-quality-spike*
*Context gathered: 2026-06-19*
