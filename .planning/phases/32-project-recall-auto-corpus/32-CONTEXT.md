# Phase 32: Project Recall + Auto-Corpus - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Two capabilities, both layered onto the live Phase-30/31 onboarding pipeline (`recense ingest-project`) and the Phase-28 corpus machinery:

1. **RECALL-01** — A **`--scope <project>` filter** on `recense recall` that returns only the named project's knowledge (plus cross-cutting global facts), excluding other named projects.
2. **RECALL-02** — Onboarding **auto-promotes and auto-generates** the project's corpus so a newly-ingested project is immediately browsable in the Reader **without a manual `recense generate-doc` step**. The corpus is **both** the project's per-schema chapter docs **and** a new project-level landing doc.

**In scope:**
- A `--scope` flag on `recall-cli.ts`, threaded to the recall path; post-retrieval scope filtering ({project, global}) that preserves "scope never feeds ranking."
- A NEW **project landing doc** (slug = project scope) using the existing project-scope `generateDoc()` path, linking/summarizing the project's schema chapter docs.
- **Scope-anchored always-promote**: bypass the corpus mass-gate ONLY for the just-onboarded project (its landing doc + its schemas' chapter docs), so onboarding guarantees a browsable corpus.
- Wiring auto-promote+generate into **both** the deferred sleep-pass path (default) and the inline `--consolidate` path.

**Out of scope (other phases / not this phase):**
- Changing how the **organic/global** corpus grows — global & conversation-induced schemas keep the existing mass-hysteresis gate untouched (D-04). The bypass is project-onboarding-only.
- Scope-filtering the session-start ambient inject as a hard requirement — `ambientRecall` already renders the `[scope]` marker (display-only); whether it also gains a `--scope` filter is Claude's discretion, not a phase deliverable.
- Re-tuning retrieval/cosine, embedder swaps, judge changes — settled in Phase 26.

Requirements delivered: **RECALL-01, RECALL-02**.
</domain>

<decisions>
## Implementation Decisions

### Scoped recall (RECALL-01)
- **D-01: `--scope <slug>` returns project + global facts.** Result set = facts whose `node_scope` ∈ `{slug, 'global'}`; **other named projects are excluded**. Rationale: a project view that drops all global/cross-cutting knowledge is too narrow to be useful; SC1 ("facts from other projects are excluded") is satisfied by excluding *other named* projects, and `global` is shared context, not another project. Filtering happens **post-retrieval** on the assembled neighborhood/members — it MUST NOT feed ranking or scoring (locked: D-S1, scope is provenance-only, never a retrieval signal — `999.3`). Add the flag in `recall-cli.ts:resolveQuery()` and thread to `RecallEngine.recall()`.

### Corpus anchoring (RECALL-02)
- **D-02: Both per-schema chapter docs AND a project landing doc.** Keep the existing schema-anchored corpus model (one chapter doc per schema, slug = schemaId — `corpus-promoter.ts`). ADD a new **project landing doc**: slug = the project scope (e.g. `usage`), generated via the existing **project-scope** `generateDoc()` path (`doc-gather.ts` scope-gather + `generate-doc-cli.ts`'s non-schema branch), that reads as a coherent project overview and links/summarizes the project's schema chapters. The landing doc is the Reader entry point for the project; chapters are the detail.

### Trigger timing (RECALL-02)
- **D-03: Deferred-by-default AND inline on `--consolidate`.** Default ingest still defers consolidation to the hourly sleep pass (locked: Phase 30 D-01) — the sleep pass auto-promotes+generates the project corpus (satisfies SC2's "after the sleep pass" wording). ADDITIONALLY, when the user passes `--consolidate` (already an inline, lock-held path — `ingest-project-cli.ts:728`), run promote + `generateCorpusDocs()` inline under the same lock so the project is browsable the instant the command returns. The deferred path stays LLM-free at call time.

### Promotion gating (RECALL-02)
- **D-04: Scope-anchored always-promote — project landing doc + its schema chapters only.** Onboarding bypasses the mass/noise gate ONLY for the just-ingested project: always-promote the project landing doc AND the chapter docs for that project's induced schemas, so the project is fully browsable day-one (no dangling links from the landing doc). **Global and conversation-induced schemas keep the existing mass-hysteresis gate unchanged** — the bypass must be bounded to the onboarded scope to avoid polluting the organic corpus with thin schemas.

### Claude's Discretion (planner/researcher decides)
- **D-05: Deferred-path force-promotion signal — meta marker is the leading candidate.** The default (deferred) path needs the globally-running sleep pass to learn WHICH scope to force-promote. Founder left the mechanism to research/planner. Recommended: a **pending-promotion marker in `SemanticStore` meta** (e.g. `pending-corpus-promotion:<scope>`), written by `ingest-project` and consumed+cleared by the next sleep pass — reuses the existing meta/cursor plumbing (same store as `cursor:project:<scope>`), crash-safe. Alternative (derive-from-`node_scope`: promote any scope with facts but no landing doc) was noted but is weaker — re-scans every pass and can't distinguish "just ingested" from "intentionally unpromoted."
- **Landing-doc → chapter edge model.** How the project landing doc links its schema chapters. Leading fit: `doc_containment` parent→child (landing = root, chapters = children), mirroring the existing containment hierarchy (`corpus-promoter.ts` Phase B). Planner's call.
- **Where scope filtering sits in `RecallEngine`.** Post-schema-resolution member filter vs. candidate prefilter, and empty-result handling when nothing matches {scope, global}. Must preserve D-S1 (filter, never rank).
- **Whether `ambientRecall` (session-start inject) also accepts a scope filter.** Not a phase deliverable; only add if cheap and obviously useful.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### ROADMAP / requirements (read first)
- `.planning/ROADMAP.md` §"Phase 32: Project Recall + Auto-Corpus" — goal + 3 success criteria (SC1 scoped recall excludes other projects; SC2 auto-promote+generate after sleep pass, no manual generate-doc; SC3 reads as coherent project overview).
- `.planning/REQUIREMENTS.md` — RECALL-01, RECALL-02 wording.

### Scoped recall (RECALL-01)
- `src/adapter/recall-cli.ts` — `resolveQuery()` (the argv parser; add `--scope` here, validate before lock per WR-02), `engine.recall()` call site.
- `src/recall/index.ts` — `RecallEngine.recall()`: two-stage schema resolution (Case A best-match IS a schema; Case B reverse-lookup via `abstracts` edges), then `store.getOutEdges()` neighborhood assembly. Scope filter goes AFTER schema resolution.
- `src/adapter/ambient-recall.ts` — already batch-reads scopes via `store.getNodeScopes()` and renders the `[scope]` marker (`:146`), display-only (D-S6). Template for scope surfacing; optional scope-filter target.
- `src/db/semantic-store.ts` — `getNodeScope()` / `getNodeScopes()` (read), `getOutEdges()`; consider a scope-filtered edge query. Scope writes (`upsertNodeScope`) happen ONLY in consolidation.
- `src/retrieval/topk.ts` — brute-force cosine `CandidateRetriever`; KEEP scope OUT of here (preserve D-S1).

### Auto-corpus (RECALL-02)
- `src/consolidation/corpus-promoter.ts` — mass-gated, LLM-free, schema-anchored promotion (Phase A read-only analysis → Phase B single immediate transaction). Creates per-schema doc stubs (slug=schemaId, origin='inferred', FTS-suppressed) + `doc_containment`/`doc_reference` edges. The always-promote bypass (D-04) and the landing-doc promotion (D-02) hook here.
- `src/consolidation/corpus-generator.ts` — `generateCorpusDocs()`: queries empty live schema doc stubs, calls `generateDocForSchema()` + `writeDoc()` (fill-in-place, stable-edge invariant). The offline generation step.
- `src/adapter/generate-doc-cli.ts` — the MANUAL step this phase removes the need for. Note its dispatch: slug resolves to a schema → `generateDocForSchema()`; else → project-scope `generateDoc()` (the landing-doc path D-02 reuses). Stays as a `--force` regenerate fallback.
- `src/reader/doc-gather.ts` — scope-gather query (`:65` — `SELECT … FROM node_scope ns JOIN node n … WHERE ns.scope = ? AND n.type='fact'`) used by the project-scope `generateDoc()`. The landing doc's citation spine.
- `src/adapter/ingest-project-cli.ts` — onboarding command. Inline `--consolidate` path (`:665-743`, lock held, `runConsolidation` at `:728`) is where inline auto-corpus (D-03) hooks; default path (`:744-818`) defers and writes the pending-promotion marker (D-05).
- `src/consolidation/run-sleep-pass.ts` — `runConsolidation`, `stampNodeScopes`, and the `generateCorpusDocs()` call (`:395-413`, gated on `RECENSE_CORPUS_GEN`). The deferred path consumes the pending-promotion marker here.

### Scope plumbing (already built — 999.3)
- `.planning/phases/999.3-scope-aware-provenance-memory-importer/999.3-CONTEXT.md` — `node_scope` sidecar; **scope = provenance, NOT tenancy**; **scope never feeds retrieval/ranking** (D-S1) — the load-bearing constraint for RECALL-01.
- `src/lib/scope.ts` — `cwdToScope()`, `resolveNodeScope()` (collapse to one slug or 'global').

### Prior phase context (the pipeline this phase extends)
- `.planning/phases/31-doc-ingest-idempotent-re-ingest/31-CONTEXT.md` — cursor (`cursor:project:<scope>`) + meta plumbing pattern (template for the D-05 pending-promotion marker); reconciliation that keeps the corpus current on re-ingest.
- `.planning/phases/30-core-ingest-command/30-CONTEXT.md` — `origin='observed'`, scope derivation, deferred-consolidation D-01, `--consolidate`/`--db`/`--dry-run` flags.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Scope filter pattern already exists** — `doc-gather.ts:65` JOINs `node_scope` + filters `WHERE scope = ?`; RECALL-01 reuses this shape (extended to `IN (slug,'global')`).
- **Project-scope `generateDoc()` path** — `generate-doc-cli.ts`'s non-schema branch already generates a scope-anchored doc from `doc-gather`'s scope spine. D-02's landing doc is this path, just auto-invoked instead of manual.
- **`generateCorpusDocs()` is already automatic in the sleep pass** (default-on) — RECALL-02's deferred path is mostly "promote the right stubs"; generation already fires.
- **Meta/cursor plumbing** (`SemanticStore.getMeta/setMeta`) — direct template for the D-05 `pending-corpus-promotion:<scope>` marker.

### Established Patterns
- **Scope never feeds ranking (D-S1)** — filtering is post-retrieval, display/selection-only. Hard constraint on RECALL-01.
- **Deferred-consolidation default (D-01)** — ingest stays LLM-free at call time; inline only on explicit `--consolidate`.
- **Corpus = abstraction graph as prose, schema = chapter** (Phase 28) — per-schema docs are the existing model; the landing doc is additive, not a replacement.
- **CorpusPromoter Phase B = single immediate transaction, no await inside** (T-02-ASYNC) — the always-promote bypass must stay within this discipline.

### Integration Points
- `recall-cli.ts` `resolveQuery()` → `RecallEngine.recall()` — add scope flag + post-resolution filter.
- `corpus-promoter.ts` — add scope-anchored always-promote (project landing doc + that project's schema chapters), bounded to the onboarded scope.
- `ingest-project-cli.ts` — inline path calls promote+generate after `runConsolidation`; deferred path writes the pending-promotion marker.
- `run-sleep-pass.ts` — consumes the marker, force-promotes the scope, then existing `generateCorpusDocs()` fills stubs.
</code_context>

<specifics>
## Specific Ideas

- **"Project + global, exclude other projects"** is the founder's recall semantics — a project view should carry shared/global knowledge, just not bleed in *other* named projects.
- **"Both" corpus = landing doc + chapters** — the founder wants a single coherent project-overview entry point (the landing doc) backed by the detailed per-schema chapters, not just a graph of disconnected chapter docs.
- **Onboarding must guarantee a browsable corpus** — hence always-promote bypassing the mass gate for the onboarded project; a freshly-onboarded project that silently fails the mass gate (no corpus at all) is the failure mode being designed out.
- **Bypass is strictly bounded to the onboarded scope** — the founder explicitly does NOT want every thin conversation schema force-promoted; the global corpus keeps its mass-hysteresis discipline.
- **Live validation target:** `/Users/vtx/usage` (already onboarded in Phase 30 — 248 facts, 23 schemas, `[usage]` recall works) is the natural test project for both `recall --scope usage` and the auto-corpus.
</specifics>

<deferred>
## Deferred Ideas

- **Scope-filtered session-start ambient inject** — giving `ambientRecall` a hard scope filter at session start. Possible but not a phase deliverable; only if cheap (Claude's discretion, D-05 area).
- **Derive-from-DB force-promotion** (promote any scope with facts but no landing doc) — considered for the deferred signal but weaker than the meta marker; could revisit if the marker proves brittle.
- **Mass-gate bypass for non-onboarding scopes** — explicitly rejected; the organic/global corpus keeps its mass-hysteresis gate.

### Reviewed Todos (not folded)
None — no pending todos matched this phase.

</deferred>

---

*Phase: 32-project-recall-auto-corpus*
*Context gathered: 2026-06-20*
