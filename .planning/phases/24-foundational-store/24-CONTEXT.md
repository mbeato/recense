# Phase 24: Foundational Store - Context

**Gathered:** 2026-06-17
**Status:** Ready for planning
**Mode:** `--auto` (decisions auto-selected from locked 999.3 context + runbook; recommended option chosen per gray area)

<domain>
## Phase Boundary

Verify the already-landed engine layer (`node_scope` sidecar, scope-stamping consolidation, recall `[scope]` prefix, `recense import-memory` CLI) is working end-to-end, then run the human-gated MEMORY.md→recense migration.

This phase **verifies and migrates** — it does not build new engine capability. The code already landed on main (999.3 Plans 01+02 + quick-task 260617-e16/ab3b6c8). The work is: (1) prove the FK consolidation fix with a clean live sleep pass and re-enable the hourly agent (SCOPE-01 gate), (2) run the consolidate→verify→retire migration bringing ≥193 founder facts into recense under correct scope provenance (SCOPE-02/03/04).

**Out of scope (belongs to later v5.0 phases or stays deferred):**
- Entity dedup/merge (Phase 25) — the 8+ "brain-memory" fragments are NOT fixed here.
- Embedding/retrieval fix (Phase 26).
- Reader layer (Phase 27).
- Soft current-cwd recall boost and hard project-scoped filtering (D-S6 defers indefinitely; revisit only if bleed proves real).
- Multi-tenant namespaces (permanently out — engine stays single-tenant).
- Migrating `~/vault` (human-reference, kept) or policy bundles (kept as deterministic config).

</domain>

<decisions>
## Implementation Decisions

All carried forward from Phase 999.3 locked decisions (D-S1–D-S7) — see `.planning/phases/999.3-scope-aware-provenance-memory-importer/999.3-CONTEXT.md`. The decisions below are the Phase-24-specific *execution* choices for verification + migration.

### SCOPE-01 — FK-fix verification (the gate)
- **D-01:** Verify the schema-relations DELETE-side FK fix by running a **manual sleep pass on the live DB** (not a throwaway copy) — SCOPE-01 explicitly requires the gate on the live DB. The fix is two commits: schema-relations FK-02 (Phase 23 range) + eviction child-wipe (260617-e16/ab3b6c8).
- **D-02:** A pass is "clean" when ALL hold: completes with no FK error, the dirty sentinel is cleared, and `PRAGMA foreign_key_check` returns empty. Capture `/tmp/recense-sleep.log` as evidence.
- **D-03:** Run the pass via the documented invocation: `set -a; . ~/.config/recense/sleep.env; set +a` then `"$RECENSE_NODE_BIN" "$RECENSE_SLEEP_JS"`. Node-bin pinning is required (better-sqlite3 ABI under nvm).

### Hourly agent re-enable
- **D-04:** Re-enable the launchd hourly sleep-pass agent **only after** a clean manual pass (D-02). The agent is currently `bootout`ed to prevent crash loops; re-enabling before the fix is verified risks re-entering the loop.
- **D-05:** SCOPE-01 is satisfied only after the re-enabled agent **survives one full hourly cycle** (confirm via `/tmp/recense-sleep.log` timestamp + no FK error on the scheduled run), not merely on `bootstrap` success.

### Migration execution (SCOPE-03/04)
- **D-06:** Follow `docs/import-memory.md` D-S7 flow **exactly**, with source adapters disabled so the import is the only thing entering the graph this cycle: `RECENSE_ENABLED_SOURCES= recense import-memory` then `RECENSE_ENABLED_SOURCES= recense sleep-pass`.
- **D-07:** Run `recense import-memory --dry-run` first; gate-check the dry-run output before any real run: **≥193 facts to import, 0 policy-bundle leaks** (7 policy bundles + MEMORY.md indexes skipped). If the count or skip-set drifts from the 2026-06-16 baseline, investigate before importing.
- **D-08:** The importer is idempotent (stable `external_id`) and never touches source files — a real run is safe to re-run.

### Verification depth (SCOPE-04)
- **D-09:** Before retiring anything, verify **≥3 imported facts per project across ≥3 projects** are retrievable via `recense recall "<query>"` AND return with the correct `[scope]` prefix. Investigate any fact that fails to surface before retiring its source.
- **D-10:** Produce `999.3-MIGRATION.md` (the runbook's named report) with: imported/skipped counts, actual embedding cost incurred, per-sample verification table (query → returned? → scope correct?), and any non-surfacing facts. (Report filename keeps the runbook's `999.3-` prefix even though the work lands in Phase 24.)

### Source retirement (D-S7 safety order)
- **D-11:** Retire = **move, never delete.** Only after verification + explicit founder sign-off, move migrated `projects/*/memory/*.md` fact files to a dated archive dir (e.g. `~/.claude/projects-memory-archive-2026-06-17/`). Leave `MEMORY.md` indexes and all policy bundles in place.
- **D-12:** Safety order is consolidate → verify → retire, never delete-before-verified. Retirement is a separate human-confirmed step, not part of the automated migration.

### Budget gate
- **D-13:** Confirm the ~$1–2 embedding cost against the ~$14–15 remaining budget before the real import+sleep-pass run. It is well within budget — proceed, but state the projected cost to the founder first (DeepSeek is the configured judge; embedding is the cost driver here).

### Claude's Discretion
- Exact query strings used for the recall verification samples (D-09) — pick queries that exercise distinct facts per project.
- Archive directory naming/date (D-11) within the `~/.claude/projects-memory-archive-<date>/` convention.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Migration runbook (the operational source of truth)
- `docs/import-memory.md` — the full `recense import-memory` runbook: usage, what gets imported vs skipped (D-S5), the consolidate→verify→retire flow (D-S7), and cost. **The migration steps come from here, not invented at plan time.**

### Locked decisions (provenance + importer design)
- `.planning/phases/999.3-scope-aware-provenance-memory-importer/999.3-CONTEXT.md` — D-S1–D-S7 locked decisions (provenance-not-tenancy, sidecar storage, derive-from-cwd, importer-reuses-pipeline, migrate-recall-facts-only, surface-scope-defer-boost, consolidate→verify→retire) and the cwd→scope mapping.

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` §SCOPE-01..04 — the four requirements this phase satisfies.
- `.planning/ROADMAP.md` §"Phase 24: Foundational Store" — goal + success criteria.
- `.planning/STATE.md` §"Phase 24 — Critical Context" — what already landed vs remaining (Task 3), sleep-pass invocation, FK bug status.

### Key engine files (verified 2026-06-16, from 999.3)
- `src/consolidation/run-sleep-pass.ts` — consolidation entry; scope-stamping + the FK-sensitive path.
- `src/db/schema.ts` — schema v10, `node_scope` sidecar DDL.
- `src/adapter/recense.ts` — CLI dispatcher (`import-memory`, `sleep-pass`, `recall`).
- `src/adapter/ambient-recall.ts` / `src/adapter/session-start-cli.ts` — recall output `[scope]` prefix.

### Knowledge-consolidation initiative (the "why")
- `~/.claude/projects/-Users-vtx-brain-memory/memory/consolidate-knowledge-into-recense.md` — the founder-memory consolidation goal this phase serves; note the open cross-project-bleed scoping question (deferred via D-S6, not resolved here).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `recense import-memory` CLI — already built, idempotent, dry-run safe (verified 193 facts / 7 policy bundles / 12 indexes skipped on 2026-06-16). This phase *runs* it, does not build it.
- `node_scope` sidecar + `cwdToScope`/`resolveNodeScope` helpers — already landed; consolidation already stamps scope.
- Recall `[scope]` prefix in `ambient-recall.ts` / `session-start-cli.ts` — already wired.
- FK-hardened decay eviction (ab3b6c8) — child-wipe of `node_scope` + `node_temporal` before `DELETE FROM node`; this is the fix being verified.

### Established Patterns
- Sidecar tables keyed by `node_id` (`node_temporal`, `activation_trace`, `consolidation_event`, now `node_scope`) — node table stays a pure belief record (faithfulness invariant).
- Sleep pass run via pinned node bin + `sleep.env` hydration (better-sqlite3 ABI under nvm).
- Migration safety pattern: consolidate→verify→retire; move-not-delete; human sign-off gate.

### Integration Points
- The hourly launchd sleep-pass agent (currently `bootout`ed) — re-enabled here after the gate passes.
- `RECENSE_DB` resolution: tray app reads `RECENSE_DB` from `sleep.env`; manual `recense` uses homedir default — confirm both point at the same canonical `~/.config/recense/recense.db` so verification and the live agent agree.

</code_context>

<specifics>
## Specific Ideas

- The SCOPE-01 gate is a **hard prerequisite** for all downstream v5.0 phases (25/26/27) — do not skip or soften it. Plans 25+ cannot begin until the clean pass + re-enabled-agent-survives-a-cycle is real.
- `resume` project maps to `global` scope (personal job-search material that should surface everywhere); per-project slugs map by cwd basename.
- The migration report is named `999.3-MIGRATION.md` (runbook convention) even though it lands in the Phase 24 directory — keep that name so the runbook's instructions match.

</specifics>

<deferred>
## Deferred Ideas

- **Entity dedup** (8+ "brain-memory" fragments, tonos split) — Phase 25 (DEDUP-01/02/03). Surfaced during the reader slice; explicitly NOT addressed in Phase 24.
- **Sub-0.7 cosine retrieval fix** — Phase 26 (RETR-01/02/03).
- **Reader layer productization** — Phase 27 (READER-01..04).
- **Soft current-cwd recall boost / hard project-scoped filtering** — deferred by D-S6; revisit only if cross-project bleed proves real.
- **Cross-project bleed scoping question** (from the consolidate-knowledge memory) — open, but intentionally not resolved here; D-S6 keeps retrieval global.

None of these block Phase 24.

</deferred>

---

*Phase: 24-foundational-store*
*Context gathered: 2026-06-17*
