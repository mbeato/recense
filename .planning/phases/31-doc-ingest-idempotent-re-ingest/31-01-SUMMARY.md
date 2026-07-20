---
phase: 31-doc-ingest-idempotent-re-ingest
plan: "01"
subsystem: ingest-project-cli
tags: [doc-ingest, idempotency, redaction, episodic, DOCING-01]
dependency_graph:
  requires: [Phase 30 core ingest command]
  provides: [emitDocEpisodes helper, doc-walk in both real-run branches, content-hash idempotency tests]
  affects: [src/adapter/ingest-project-cli.ts, tests/ingest-project-reingest.test.ts]
tech_stack:
  added: []
  patterns: [chunkNote/noteTitle reuse from obsidian-adapter, contentExternalId content-hash dedup, redactSecrets boundary guard]
key_files:
  created:
    - tests/ingest-project-reingest.test.ts
  modified:
    - src/adapter/ingest-project-cli.ts
decisions:
  - "emitDocEpisodes uses realpathSync for both the project root AND the docs/ dir to handle macOS symlink indirection (/var → /private/var in tmpdir) — resolving the base canonically before walking prevents T-31-PATH containment false-negatives"
  - "Docs emitted BEFORE the survey in both real-run branches so a survey transport failure still leaves project docs ingested (deterministic path first)"
  - "relPath normalized to forward slashes (sep replacement) before use as contentExternalId key for cross-platform stability"
  - "normalizeObsidianNote deliberately NOT called — doc episodes hand-build the record with origin='observed' (T-31-ORIGIN); obsidian-adapter hardcodes asserted_by_user"
metrics:
  duration: "~15 minutes"
  completed: "2026-06-20"
  tasks_completed: 2
  files_changed: 2
  commits: 3
---

# Phase 31 Plan 01: Doc-Ingest + Idempotent Re-Ingest Summary

Extends `recense ingest-project <dir>` to ingest the project's own documentation (README.md, CLAUDE.md, docs/**/*.md) as episodes alongside the agentic survey — delivering DOCING-01.

## What Was Built

**`collectDocPaths(dir)`** — collects README.md, CLAUDE.md (project root only), and every .md file from docs/ via a recursive walk. Uses `realpathSync` at the project root and each walked entry to guard against symlink escape (T-31-PATH) and handle macOS /var→/private/var indirection.

**`emitDocEpisodes(opts)`** — for each doc path: reads content, chunks via `chunkNote`, applies `redactSecrets` per section, calls `pipeline.recordEvent` with `origin='observed'`, `source='project-doc'`, content-hash `externalId` via `contentExternalId`. Returns `{ docCount, episodeCount }`. dryRun=true returns would-be counts without any writes.

**Wired into 3 branches of `main()`:** dry-run (dryRun=true, no writes), --consolidate, and default (deferred) — docs emitted first in both real-run branches before the LLM survey.

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 RED | Failing tests: origin/source, redaction, relPath stability, dryRun | 4a25302 |
| 1 GREEN | collectDocPaths + emitDocEpisodes implementation | 7af2b08 |
| 2 | Wire emitDocEpisodes into all 3 main() branches + idempotency already covered by tests | f3d617c |

## Verification

- `npx tsc --noEmit`: exits 0 (0 lines output)
- `npx vitest run tests/ingest-project-reingest.test.ts`: 11/11 pass
- `npx vitest run tests/ingest-project-cli.test.ts`: 21/21 pass (no regression)
- `grep -n "source: 'project-doc'" src/adapter/ingest-project-cli.ts`: hits line 459
- `grep -n "origin: 'observed'" src/adapter/ingest-project-cli.ts`: hits lines 269, 457
- `grep -n "normalizeObsidianNote" src/adapter/ingest-project-cli.ts`: 0 hits (correct)
- `grep -c "emitDocEpisodes(" src/adapter/ingest-project-cli.ts`: 4 (1 definition + 3 branch calls)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] macOS symlink indirection in realpathSync containment guard**

- **Found during:** Task 1 GREEN — test "ingests CLAUDE.md and docs/**/*.md in addition to README.md" failing with docCount=2 instead of 3
- **Issue:** macOS `/var/folders` is a symlink to `/private/var/folders`; `realpathSync(candidatePath)` inside the walk returned `/private/var/...` while `resolve(dir)` returned `/var/...`, so the containment check `realPath.startsWith(resolvedProjectDir + sep)` always failed for tmpdir entries
- **Fix:** Applied `realpathSync(resolve(dir))` for the project root in `collectDocPaths` AND for README/CLAUDE individual files and the docs/ dir, so the base and all walked paths share the same canonical prefix
- **Files modified:** src/adapter/ingest-project-cli.ts
- **Commit:** 7af2b08

## Known Stubs

None — all doc-ingest paths are fully wired. The emitDocEpisodes function reads real files and calls pipeline.recordEvent with real content.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundaries introduced. All surfaces match the plan's threat model:
- T-31-PATH: realpathSync containment guard implemented and tested
- T-31-SECRET: redactSecrets applied per section before content or externalId is computed
- T-31-ORIGIN: origin='observed' enforced; normalizeObsidianNote not called (grep-verified)

## Self-Check: PASSED

Files exist:
- `src/adapter/ingest-project-cli.ts`: FOUND (modified)
- `tests/ingest-project-reingest.test.ts`: FOUND (created)

Commits exist:
- 4a25302: FOUND
- 7af2b08: FOUND
- f3d617c: FOUND
