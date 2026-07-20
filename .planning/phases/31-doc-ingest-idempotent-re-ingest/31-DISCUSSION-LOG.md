# Phase 31: Doc Ingest + Idempotent Re-ingest - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 31-doc-ingest-idempotent-re-ingest
**Areas discussed:** Doc-ingest mechanism, Cursor's role for the survey, Change-detection signal, Survey reconciliation trust

---

## Doc-ingest mechanism (DOCING-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Same run, reuse helpers | One `ingest-project <dir>` ingests docs + runs survey; doc set = README + docs/**/*.md + CLAUDE.md, origin=observed, reuse obsidian chunkNote/redact | ✓ |
| Separate doc path/flag | Docs via `--docs-only` / separate subcommand, decoupled from survey | |
| Generalize ObsidianAdapter | Registered SourceAdapter in enabledSources pointed at the project dir | |

**User's choice:** Same run, reuse helpers
**Notes:** Onboarding stays one action (consistent with Phase 30). Origin inverts Obsidian's `asserted_by_user` → `observed` (D-03). Distinct `source='project-doc'` for attribution.

---

## Cursor's role for the survey (REINGEST-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Skip survey if unchanged | Cursor skips the agentic re-survey when repo fingerprint unchanged → SC2 ("zero new beliefs") is structural; any change → full re-survey of all 5 areas | ✓ |
| Partial re-survey | Re-survey only the areas whose input files changed | |
| Cursor gates docs only | Survey always re-runs; consolidation judge handles dedup | |

**User's choice:** Skip survey if unchanged
**Notes:** The cursor is load-bearing for correctness because the survey is non-deterministic — the judge alone can't guarantee zero-new-beliefs on an unchanged re-run. Partial/per-area re-survey rejected (holistic survey, speculative file→area mapping).

---

## Change-detection signal (REINGEST-02)

| Option | Description | Selected |
|--------|-------------|----------|
| git sha + dirty, mtime fallback | HEAD sha + working-tree-dirty for git repos; max-mtime fallback for non-git; key `cursor:project:<scope>` | ✓ |
| mtime only | Max mtime over the file set (Obsidian D-67), no git dependency | |
| Content-hash set | Hash each file; compare sets — precise, enables per-file partial | |

**User's choice:** git sha + dirty, mtime fallback
**Notes:** Matches how repos actually change; mtime-only is noisier (touch/checkout bumps without content change). git detection mechanism left to research (net-zero deps).

---

## Survey reconciliation trust (REINGEST-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Trust judge, cursor-bounded | Existing PE-gated judge updates in place; cursor bounds exposure by re-surveying only on real change; phase gated by a dup-rate test | ✓ |
| Add survey idempotency key | Per-area belief slug hard-dedups before the judge | |
| Both + assertion gate | Cursor + judge + explicit dup-rate assertion gate | |

**User's choice:** Trust judge, cursor-bounded
**Notes:** No new reconcile machinery; the cursor (skip-unchanged) is what bounds the non-deterministic judge's exposure. A re-ingest dup-rate test backstops the phase.

---

## Claude's Discretion

- Cursor commit timing (eager vs deferred `commitCursor` thunk).
- Doc chunking granularity for non-Obsidian docs (reuse `chunkNote` verbatim unless research shows a problem).
- git repo detection + HEAD sha + dirty-state read with net-zero deps (research flag).
- Three ergonomic decisions Claude resolved (easy to revise): `--force` cursor bypass (D-08); `--dry-run` never advances the cursor + `--db` scratch gets its own cursor row (D-09); docs keep their own per-file content-hash idempotency independent of the survey cursor (D-06).

## Deferred Ideas

- Partial / per-area / per-file re-survey — rejected this phase (D-04); revisit if full re-survey cost grows.
- Registered project-doc SourceAdapter (hourly background pull) — rejected (D-02); revisit if continuous sync wanted.
- Scoped project recall + auto-corpus — Phase 32 (RECALL-01/02).
