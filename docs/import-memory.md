# `recense import-memory` — runbook

Migrate the per-project `~/.claude/projects/*/memory/*.md` recall-facts into recense
via the existing ingestion pipeline, so the redundant `MEMORY.md` fact store collapses
into the one brain. Phase 999.3, decisions **D-S4 / D-S5 / D-S7**.

The importer is **repeatable and idempotent** — re-running it on unchanged files adds
zero new episodes. It **never deletes or modifies a source file**; retirement is a
separate, human-confirmed step (D-S7).

## Usage

```
recense import-memory --dry-run            # print the import/skip plan, write nothing
recense import-memory --project <slug>     # limit to one project
recense import-memory                       # real import (writes episodes)
```

Flags:

- `--dry-run` — scan and print what *would* be imported/skipped. Opens no DB, takes no
  lock, writes nothing.
- `--project <slug>` — restrict to a single project (matched against the folder slug,
  e.g. `brain-memory`).
- `--db <path>` — DB path override (otherwise `RECENSE_DB` env, hydrated from the launchd
  env file like every other `recense` command).
- `--base <dir>` — scan-root override (defaults to `~/.claude/projects`). Mainly for tests.

## What gets imported vs skipped (D-S5)

- **Imported:** every other `*.md` fact file under each project's `memory/` dir. One
  episode per file, `source='memory-import'`, `cwd` = the project's path (so consolidation
  derives the right scope, D-S3), `external_id='memory-import:<project>:<filename>'`
  (stable → idempotent re-runs).
- **Skipped — `MEMORY.md` index files.** These are deterministic indexes, not facts.
- **Skipped — load-bearing policy bundles** (matched by filename):
  `voice_profile`, `feedback_no_inflated_metrics`, `feedback_drop_concentrations`,
  `outreach_framework`, `user_job_search_strategy`, `reference_linkedin_playbook`,
  `user_profile`. Retrieval is probabilistic; these stay deterministic config so a
  load-bearing rule is never at risk of being dropped.

The `resume` project maps to `global` scope (personal job-search material that should
surface everywhere).

## Cost

Importing the corpus (~280 files) costs roughly **$1–2 in embeddings** during the sleep
pass that consolidates the imported episodes (extraction + embedding of the new facts).
Run `--dry-run` first to see the exact file count. Check the live API budget before a
real run.

## consolidate → verify → retire flow (D-S7)

**Never delete a source file until its facts are verified retrievable in recense.**

1. **Dry-run review.** `recense import-memory --dry-run` — confirm the policy bundles and
   `MEMORY.md` indexes are skipped and the per-file scopes look right.
2. **Import with adapters disabled.** Run the real import with source adapters off so the
   import is the only thing entering the graph this cycle:
   ```
   RECENSE_ENABLED_SOURCES= recense import-memory
   ```
   This appends the episodes but does not consolidate them.
3. **Consolidate manually.** Trigger one sleep pass so the imported episodes become facts
   and get their scope stamped:
   ```
   RECENSE_ENABLED_SOURCES= recense sleep-pass
   ```
4. **Verify retrievability.** For a sample of migrated facts per project, run
   `recense recall "<query>"` and confirm the fact returns with the correct `[scope]`
   marker. Spot-check **≥3 facts per project across ≥3 projects**.
5. **Write the migration report** (`999.3-MIGRATION.md`): counts (imported/skipped),
   embedding cost actually incurred, verification samples (query → returned? → scope
   correct?), and any facts that failed to surface (investigate before retiring those).
6. **Retire — founder-gated.** Only after verification and explicit founder sign-off,
   **move** (never delete) the migrated `projects/*/memory/*.md` fact files to an archive
   dir (e.g. `~/.claude/projects-memory-archive-<date>/`). **Leave `MEMORY.md` indexes and
   the policy bundles in place.**

Re-running the importer after retirement is safe: archived files are gone from the scan
root, and any remaining files dedup on their stable `external_id`.
