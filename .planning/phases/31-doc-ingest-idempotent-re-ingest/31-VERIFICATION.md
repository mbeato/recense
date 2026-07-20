---
phase: 31-doc-ingest-idempotent-re-ingest
verified: 2026-06-20T17:00:00Z
status: passed
score: 3/3 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase 31: Doc-Ingest + Idempotent Re-Ingest Verification Report

**Phase Goal:** Project documents (README, docs/*.md, CLAUDE.md) can be ingested directly via the extended SourceAdapter seam, and re-running ingestion on a changed project updates existing beliefs in place rather than minting duplicates — with a per-project cursor so only changed/new content is re-surveyed.
**Verified:** 2026-06-20T17:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 (SC1 / DOCING-01) | User can point ingestion at a project dir and project's README/docs/*.md/CLAUDE.md are ingested as episodes with origin='observed' and project scope — without configuring an Obsidian vault | VERIFIED | `emitDocEpisodes` in `ingest-project-cli.ts:506-565` implements the doc walk. `collectDocPaths` (line 397) gathers README.md, CLAUDE.md, docs/**/*.md. All episodes carry `origin: 'observed'` (line 548), `source: 'project-doc'` (line 550). Wired into all 3 branches of main() (dry-run at line 638, consolidate at line 689, default at line 765). 28/28 tests pass including origin/source/redaction assertions. |
| 2 (SC2 / REINGEST-01) | Re-running ingestion on a project where a key fact changed results in the existing belief being updated (tombstone + new node) rather than a duplicate; a second run on an unchanged project produces zero new consolidated beliefs | VERIFIED | D-07 dup-rate gate test ("changed fact reconciles in place") in `tests/ingest-project-reingest.test.ts:756-848` uses MockModelProvider with `contradict` verdict. Asserts prior node `tombstoned=1`, exactly 1 live new node with updated value, 0 live old-value nodes, and `PRAGMA foreign_key_check` returns empty. "unchanged re-run yields zero new consolidated beliefs" test (line 647) proves SC2 via cursor structural skip → 0 survey calls on second run → 0 new consolidated beliefs. Both pass live. |
| 3 (SC3 / REINGEST-02) | Per-project cursor means only changed/new content triggers re-survey — a full re-survey is not triggered when the majority of project content is unchanged | VERIFIED | `computeProjectFingerprint` (line 214) computes `git:<sha>:<clean|dirty>` for git repos or `mtime:<maxMtimeMs>` for non-git. SemanticStore cursor stored as `cursor:project:<scope>` via `getMeta`/`setMeta` (lines 685/720, 761/796) in BOTH real-run branches. T-31-CURSOR-1 test (line 562) asserts that when fingerprint matches stored cursor, `surveyCalls` stays 0 on the second run. T-31-CURSOR-2 (--force), T-31-CURSOR-3 (--dry-run), T-31-CURSOR-4 (scratch-db isolation) all pass. |

**Score:** 3/3 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/adapter/ingest-project-cli.ts` | Doc-walk + emitDocEpisodes + cursor skip-gate in both real-run branches + gitFingerprint + computeProjectFingerprint + --force flag | VERIFIED | All functions exist and are substantive. `emitDocEpisodes` at line 506, `collectDocPaths` at 397, `gitFingerprint` at 182, `computeProjectFingerprint` at 214, `resolveProjectRoot` at 389. SemanticStore cursor wired at lines 682-724 (consolidate branch) and 758-800 (default branch). |
| `tests/ingest-project-reingest.test.ts` | Doc-emit tests (origin/source/redaction/idempotency) + fingerprint tests + cursor skip-gate tests + D-07 dup-rate gate | VERIFIED | 28 tests across 4 describe blocks: `project-doc` (8 tests), `project-doc idempotency` (3 tests), `fingerprint helpers` (9 tests), `cursor skip-gate` (4 tests), `D-07 dup-rate gate` (2 tests). All 28 pass. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `ingest-project-cli.ts` | `obsidian-adapter.ts` | `import chunkNote, noteTitle` | WIRED | Line 43: `import { chunkNote, noteTitle } from '../source/obsidian-adapter';`. Both used in `emitDocEpisodes` (lines 535-536). |
| `ingest-project-cli.ts` | `redact.ts` | `import redactSecrets` | WIRED | Line 44: `import { redactSecrets } from '../source/redact';`. Called at line 543 before content lands on record. |
| `ingest-project-cli.ts` | `pipeline.ts` | `pipeline.recordEvent with source='project-doc'` | WIRED | Line 545-555: full `recordEvent` call with `source: 'project-doc'` at line 550. |
| `ingest-project-cli.ts` | `semantic-store.ts` | `new SemanticStore(db, realClock, config).getMeta/setMeta('cursor:project:<scope>')` | WIRED | Line 39: `import { SemanticStore }`. Lines 682, 758: `new SemanticStore(db, realClock, config)`. getMeta at 685/761, setMeta at 720/796. Same `db` handle used for both EpisodicStore and SemanticStore. |
| `ingest-project-cli.ts` | `git (child_process)` | `spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'])` | WIRED | Line 30: `import { spawnSync } from 'child_process'`. Lines 183, 191: arg-array form confirmed (T-31-INJECT — no shell string). |
| `ingest-project-cli.ts` | `runSurveyAndFeed` | `skip-gate guards the survey call; setMeta after it succeeds` | WIRED | `surveySkipped` gate at lines 700-725 (consolidate) and 776-800 (default); setMeta called only inside the `if (!surveySkipped)` branch and only when `skippedAreas.length < SURVEY_AREAS.length` (WR-04 fix). |

### Data-Flow Trace (Level 4)

Not applicable for this phase — the primary artifacts are a CLI adapter and test harness, not a rendering component that surfaces dynamic state. The data flows (doc content → episode store, cursor → skip-gate decision) are verified structurally through the wiring checks and confirmed by deterministic tests.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles clean | `npx tsc --noEmit` | 0 lines output (exit 0) | PASS |
| All reingest tests pass (28 tests) | `npx vitest run tests/ingest-project-reingest.test.ts` | 28 passed, 0 failed | PASS |
| Phase-30 CLI tests pass (regression) | `npx vitest run tests/ingest-project-cli.test.ts` | 21 passed, 0 failed | PASS |
| `source: 'project-doc'` present in implementation | `grep -n "source: 'project-doc'" src/adapter/ingest-project-cli.ts` | line 550 | PASS |
| `normalizeObsidianNote` absent (T-31-ORIGIN) | `grep -n "normalizeObsidianNote" src/adapter/ingest-project-cli.ts` | 0 hits | PASS |
| `emitDocEpisodes` called 4 times (1 def + 3 branches) | `grep -c "emitDocEpisodes(" src/adapter/ingest-project-cli.ts` | 4 | PASS |
| SemanticStore in both real-run branches | `grep -n "new SemanticStore(" src/adapter/ingest-project-cli.ts` | lines 682, 758 | PASS |
| CR-01 root-file symlink containment guard | `sed -n '402,415p' src/adapter/ingest-project-cli.ts` | Guard present: `realCandidate !== join(resolvedDir, name) && !realCandidate.startsWith(resolvedDir + sep)` | PASS |
| WR-01 non-git doc-less dir fingerprint fix | `grep -n "mtime:none:" src/adapter/ingest-project-cli.ts` | line 224: `mtime:none:${Date.now()}` | PASS |
| WR-04 cursor not committed on all-refuse | `grep -n "skippedAreas.length < SURVEY_AREAS.length"` | lines 718, 794 in both real-run branches | PASS |

### Probe Execution

No probe scripts declared for this phase. The phase uses vitest deterministic tests as the verification mechanism.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| DOCING-01 | 31-01-PLAN.md | User can ingest project's own documents (README, docs/*.md, CLAUDE.md) with origin=observed and project scope | SATISFIED | `emitDocEpisodes` + `collectDocPaths` fully implemented; origin/source/scope verified in tests and grep |
| REINGEST-01 | 31-02-PLAN.md | Re-running on changed project reconciles in place via reconsolidation rather than minting duplicates | SATISFIED | D-07 dup-rate gate test proves tombstone+new-not-dup with deterministic MockModelProvider |
| REINGEST-02 | 31-02-PLAN.md | Per-project cursor makes re-ingest incremental — only changed/new content re-surveyed | SATISFIED | `computeProjectFingerprint` + SemanticStore cursor skip-gate in both real-run branches; T-31-CURSOR-1 proves structural skip |

No orphaned requirements: all three Phase 31 requirement IDs appear in the plans and are accounted for above.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| N/A | - | - | - | None found |

No `TBD`/`FIXME`/`XXX` markers, no placeholder implementations, no stubs, no hardcoded empty returns in modified files. Code review findings (CR-01 symlink containment hole, WR-01 mtime:0 pinning, WR-02 dead variable, WR-03 no recursion cap, WR-04 cursor committed on all-refuse) were all addressed in the codebase prior to this verification, confirmed by grep and live test execution.

The REVIEW.md frontmatter shows `status: clean` (all 8 findings resolved). The body text header still says "issues_found" — this is a stale artifact from before the fixes landed; the frontmatter `status: clean` is the authoritative post-fix field. The grep-verified fixes confirm the body is outdated, not the code.

### Human Verification Required

None. All success criteria are verifiable deterministically:
- SC1: wiring verified by grep + 28 passing tests on real in-memory DB
- SC2: D-07 gate proven by deterministic MockModelProvider test
- SC3: cursor structural skip proven by T-31-CURSOR-1 test (surveyCalls=0 on second run)

No visual rendering, real-time behavior, or external service integration in scope for this phase.

### Gaps Summary

No gaps. All three success criteria are fully implemented and test-verified. The two code review blockers from 31-REVIEW.md (CR-01 symlink containment and WR-01 mtime:0 pinning) are both fixed in the shipped implementation — confirmed by grep (lines 408-413 for CR-01, line 224 for WR-01) and by the passing T-31-PATH symlink escape test added as IN-01.

---

_Verified: 2026-06-20T17:00:00Z_
_Verifier: Claude (gsd-verifier)_
