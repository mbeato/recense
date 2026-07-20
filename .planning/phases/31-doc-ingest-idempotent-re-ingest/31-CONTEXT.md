# Phase 31: Doc Ingest + Idempotent Re-ingest - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Two capabilities, both layered onto the Phase-30 `recense ingest-project <dir>` command:

1. **DOCING-01** — Ingest a project's **own documents** (README, `docs/**/*.md`, `CLAUDE.md`) directly as episodes (`origin='observed'`, project scope), without configuring an Obsidian vault.
2. **REINGEST-01/02** — Re-running `ingest-project` on a changed project **updates beliefs in place** (reconsolidation) instead of minting duplicates, driven by a **per-project cursor** so the expensive agentic survey only re-runs when the repo actually changed.

**In scope:** project-doc reading + episode emission inside the existing `ingest-project` run; a per-project cursor (`cursor:project:<scope>`) keyed on a repo fingerprint; survey-skip-when-unchanged gating; reconciliation correctness for both doc episodes (content-hash) and survey episodes (PE-gated judge); a `--force` bypass; cursor-safety for `--dry-run`/`--db`.

**Out of scope (other phases — do NOT add here):**
- Scoped project recall tuning + auto-promoted/-generated corpus docs → **Phase 32** (RECALL-01/02).
- Partial / per-area / per-file re-survey — explicitly rejected this phase (see D-04). Any change → full re-survey of all 5 areas.
- Registering project-doc ingest as an hourly-pull `SourceAdapter` in `enabledSources` — rejected (D-02); this is an operator command, not a background pull source.

Requirements delivered: **DOCING-01, REINGEST-01, REINGEST-02**.
</domain>

<decisions>
## Implementation Decisions

### Doc ingest (DOCING-01)
- **D-01: Docs ingest inside the same `ingest-project` run.** A single `recense ingest-project <dir>` invocation ingests the project's docs AND runs the agentic survey — onboarding stays one action. No separate subcommand. Doc set = `README.md` + `docs/**/*.md` + `CLAUDE.md` (recursive under `docs/`). Each doc → episode(s) with `origin='observed'`, scope = the same resolved project scope as the survey, `source='project-doc'` (distinct from `'project-survey'` so the two ingest paths are attributable).
- **D-02: Reuse Obsidian's helpers, NOT the registered-adapter shape.** Reuse `chunkNote` (heading-split, byte-cap) and `redactSecrets` from `obsidian-adapter.ts` (export them if not already), feeding doc episodes through the same `pipeline.recordEvent` path the survey already uses. Do NOT generalize `ObsidianAdapter` into a registered `SourceAdapter` in `enabledSources` (that's the hourly background-pull model — wrong for an operator-invoked command). The roadmap's "extended SourceAdapter seam" wording is satisfied by reusing the `NormalizedRecord`/`contentExternalId` contract, not by registering a pull adapter.
- **D-03: Origin is `observed`, never `asserted_by_user`.** Project docs are someone else's docs being observed — NOT the founder's curated vault. This is the key divergence from `ObsidianAdapter` (D-61 there earns `asserted_by_user`); project-doc ingest must NOT inherit that origin. `redactSecrets` still runs per-section before emit (D-63 parity).

### Cursor & re-ingest gating (REINGEST-02)
- **D-04: The cursor SKIPS the agentic re-survey when the repo is unchanged.** This makes "a second run on an unchanged project produces zero new consolidated beliefs" (SC2) a **structural guarantee**, not a bet on the non-deterministic judge. When the repo fingerprint matches the stored cursor → skip the survey entirely (the survey is the expensive, non-deterministic part). Any change → **full re-survey of all 5 areas** (the survey reads holistically; partial/per-area re-survey is rejected as out of scope — D-04 boundary).
- **D-05: Fingerprint = git HEAD sha + working-tree-dirty, mtime fallback.** When `<dir>` is a git repo: the cursor stores `HEAD sha` + a working-tree-dirty marker; unchanged sha AND clean tree → skip survey. When `<dir>` is NOT a git repo: fall back to max-mtime over the ingested/tracked file set (the Obsidian D-67 mechanism). Stored under per-scope meta key `cursor:project:<scope>` via `SemanticStore.getMeta/setMeta` (same store/accessor as `cursor:obsidian`).
- **D-06: Docs keep their own per-file content-hash idempotency — independent of the survey cursor.** Doc episodes use the existing `contentExternalId(relPath, content)` content-addressing (edit → new hash → reconcile; unchanged → `INSERT OR IGNORE` near-no-op). The repo-fingerprint cursor (D-05) gates ONLY the expensive survey. So on an unchanged re-run: docs are a free near-no-op AND the survey is skipped → genuinely zero new beliefs.

### Reconciliation correctness (REINGEST-01)
- **D-07: Trust the PE-gated consolidation judge for in-place update — cursor-bounded.** When content DID change and the survey re-runs, the non-deterministic LLM re-words even unchanged beliefs. Rely on the EXISTING prediction-error-gated reconsolidation judge to update-in-place vs duplicate — no new survey-side idempotency machinery. The cursor (D-04) bounds the judge's exposure by ensuring re-survey only fires on real change. **Gate the phase with a re-ingest dup-rate test** (changed-fact re-ingest → tombstone+new, not dup; unchanged re-run → 0 new consolidated beliefs).

### Ergonomics (Claude-resolved — easy to revise)
- **D-08: `--force` bypasses the cursor.** Re-survey even when the fingerprint is unchanged — for demos, or after the survey prompt itself improves and a fresh survey is wanted. Default is cursor-gated (skip-if-unchanged).
- **D-09: `--dry-run` never advances the cursor.** Preview-only must not commit a fingerprint, or it would falsely mark the project as ingested. `--db <scratch>` targets get their own `cursor:project:<scope>` row in that DB (eval/test runs never poison the live cursor).

### Claude's Discretion (planner/researcher decides)
- **Cursor commit timing.** Whether the fingerprint is committed eagerly after the survey writes episodes, or deferred to a `commitCursor`-style thunk (mirroring `SourceAdapter.pull()`'s fetch/commit split). The fetch/commit split is the established pattern — likely fit — but a one-shot operator command may commit eagerly. Planner's call.
- **Doc chunking granularity for non-Obsidian docs.** Whether `chunkNote`'s heading-split applies verbatim to README/CLAUDE.md or needs per-doc-type framing. Reuse verbatim unless research shows a problem.
- **git detection mechanism.** How to detect a git repo + read HEAD sha + dirty state with net-zero deps (e.g. `git rev-parse HEAD` / `git status --porcelain` via the headless transport's shell, or reading `.git/HEAD`). Research flag.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 30 — the command this phase extends (read FIRST)
- `.planning/phases/30-core-ingest-command/30-CONTEXT.md` — locked Phase-30 decisions: `origin='observed'`, `source='project-survey'`, scope derivation (`cwdToScope` + synthetic-cwd `--scope`), deferred-consolidation via dirty-sentinel, `--dry-run`/`--consolidate`/`--db`/`--desc` flags, `contentExternalId` episode dedup. Phase 31 layers docs + cursor onto this.
- `src/adapter/ingest-project-cli.ts` — the live Phase-30 command. Survey loop emits per-area episodes with `externalId: contentExternalId(`${scope}/${area}`, content)`; `resolveSurveyScope`/`resolveSurveyCwd` (Pitfall-3 synthetic cwd); reads README only for `--desc` today (D-10). Phase 31 adds doc-episode emission + cursor gating here.

### Doc-ingest reference implementation (the helpers to reuse)
- `src/source/obsidian-adapter.ts` — `chunkNote` (heading-split + byte-cap, D-58), per-section `redactSecrets` (D-63), `contentExternalId(relPath, content)` content-addressing (D-59), and the `cursor:obsidian = max mtimeMs` incremental-walk pattern (D-67 — the mtime-fallback template for D-05). INVERT its `origin='asserted_by_user'` (D-61) → `'observed'` (D-03 here).
- `src/source/source-adapter.ts` — `contentExternalId` helper, `NormalizedRecord` contract, and the `pull() → { records, commitCursor }` fetch/commit split (the cursor-commit pattern referenced in Claude's Discretion).

### Cursor / meta-store plumbing
- `src/adapter/ingest-cli.ts` — `buildAdapters` + the cursor-persistence wiring: cursors live in the meta table via `SemanticStore.getMeta/setMeta` (NOT EpisodicStore — that silently disables cursors). Per-account key convention (`cursor:gmail:<accountId>`) is the template for `cursor:project:<scope>`. Also the adapter-isolation + arg-validate-before-lock patterns.
- `src/consolidation/run-sleep-pass.ts` — `runConsolidation` (inline `--consolidate` path) + `resolveNodeScope`/`stampNodeScopes` (scope attribution). The PE-gated reconsolidation judge that D-07 trusts lives in the consolidation path.

### Scope provenance (already built — 999.3)
- `.planning/phases/999.3-scope-aware-provenance-memory-importer/999.3-CONTEXT.md` — `node_scope` sidecar, scope = provenance not tenancy, derive-from-cwd at consolidation.
- `src/lib/scope.ts` — `cwdToScope`.

### ROADMAP / requirements
- `.planning/ROADMAP.md` §"Phase 31: Doc Ingest + Idempotent Re-ingest" — goal + 3 success criteria.
- `.planning/REQUIREMENTS.md` — DOCING-01, REINGEST-01, REINGEST-02 wording.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`obsidian-adapter.ts` helpers** — `chunkNote`, `redactSecrets`, `contentExternalId` are written and tested; doc ingest is mostly reusing them with a different origin/scope/source (D-02/D-03).
- **`contentExternalId` content-addressing** — already gives docs edit→reconcile and unchanged→near-no-op for free (D-06); REINGEST-01 for the doc path is largely a property of the existing pipeline.
- **`cursor:<source>` meta pattern** — `getMeta/setMeta` on `SemanticStore`, with per-account key variants, is the direct template for `cursor:project:<scope>` (D-05).
- **PE-gated reconsolidation judge** — the existing consolidation mechanism is what D-07 leans on for in-place survey-belief updates; no new reconcile machinery.

### Established Patterns
- **`pipeline.recordEvent` direct feed** — the Phase-30 spike-style standalone shape; doc episodes route through the same path as survey episodes (not a registered pull adapter).
- **fetch/commit cursor split** (`SourceAdapter.pull() → { records, commitCursor }`) — the deferred-cursor-commit template (planner decides eager vs deferred).
- **meta cursors MUST use SemanticStore** — passing EpisodicStore silently disables the cursor (re-ingests everything). Hard gotcha called out in `ingest-cli.ts`.

### Integration Points
- `ingest-project-cli.ts` — add doc-reading + episode emission; add cursor read (skip-survey gate) + cursor write (post-survey commit).
- `SemanticStore.getMeta/setMeta` — `cursor:project:<scope>` storage.
- The consolidation path's reconsolidation judge — reconciles changed survey beliefs (no change needed, but the dup-rate gate validates it).
</code_context>

<specifics>
## Specific Ideas

- **The cursor is load-bearing for correctness, not just speed.** The founder's framing: because the agentic survey is non-deterministic (re-survey re-words even unchanged beliefs), "zero new beliefs on unchanged re-run" (SC2) can't be guaranteed by the judge alone — so the cursor's skip-if-unchanged (D-04) is what makes SC2 structural. Docs, being content-hashed, are independently a near-no-op.
- **Two independent idempotency mechanisms, by design (D-06):** docs → per-file content hash (`contentExternalId`); survey → repo-fingerprint cursor (`cursor:project:<scope>`). They don't share a fingerprint; each fits its content type.
- **Same-command onboarding (D-01):** one `ingest-project <dir>` does docs + survey — the founder wants onboarding to stay a single action, consistent with Phase 30's ergonomics.
</specifics>

<deferred>
## Deferred Ideas

- **Partial / per-area / per-file re-survey** — re-surveying only the areas whose input files changed. Rejected for Phase 31 (D-04): the survey reads holistically and file→area mapping is speculative. Revisit only if full re-survey cost becomes painful at scale.
- **Registered project-doc `SourceAdapter`** (hourly background pull of project docs) — rejected (D-02) in favor of the operator-command shape. Could revisit if continuous project-doc sync is ever wanted.
- **Scoped project recall + auto-corpus** — explicitly **Phase 32** (RECALL-01/02). The corpus staying current through re-ingest depends on this phase's reconciliation working.

### Reviewed Todos (not folded)
None — no pending todos matched this phase.

</deferred>

---

*Phase: 31-doc-ingest-idempotent-re-ingest*
*Context gathered: 2026-06-20*
