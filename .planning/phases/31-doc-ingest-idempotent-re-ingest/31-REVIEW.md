---
phase: 31-doc-ingest-idempotent-re-ingest
reviewed: 2026-06-20T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - src/adapter/ingest-project-cli.ts
  - tests/ingest-project-reingest.test.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: clean
---

# Phase 31: Code Review Report

**Reviewed:** 2026-06-20
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Reviewed the Phase 31 doc-ingest + idempotent re-ingest implementation against the two plans and the security-relevant invariants (T-31-ORIGIN, T-31-SECRET, T-31-PATH, T-31-INJECT, T-31-CURSOR, T-31-DRYCURSOR).

The core wiring is largely correct and the load-bearing invariants are mostly honored: doc episodes are `origin='observed'` / `source='project-doc'` (never `asserted_by_user`), `normalizeObsidianNote` is correctly NOT called, `redactSecrets` runs before content lands and before the hash is computed, `spawnSync('git', [...])` uses the arg-array form, the cursor uses `SemanticStore` (not `EpisodicStore`) on the same db handle, and `--dry-run` never calls `setMeta`.

However, two real defects break stated invariants:

1. **BLOCKER — T-31-PATH partial bypass:** `README.md` / `CLAUDE.md` at the project root are realpath-resolved but NOT containment-checked. A symlinked `README.md`/`CLAUDE.md` pointing outside the tree (e.g. to `~/.ssh/...` or `/etc/...`) is read and ingested into the episode store. The walk enforces containment; the root-file path does not.

2. **WARNING — non-git + no-docs dirs are pinned to `mtime:0` forever:** for a non-git project with no README/CLAUDE/docs, `collectDocPaths` returns `[]`, so the fingerprint is always `mtime:0`. After the first run the survey is skipped permanently regardless of any source-code change — silently defeating REINGEST-02 for that whole class of project. The plan called for the mtime scan to also cover "the survey-relevant files," which was not implemented.

The remaining findings are robustness and test-coverage gaps.

## Critical Issues

### CR-01: Root README.md / CLAUDE.md symlink is read without a containment check (T-31-PATH bypass)

**File:** `src/adapter/ingest-project-cli.ts:384-392`
**Issue:**
The recursive `walkDocDir` correctly skips any entry whose realpath escapes the project boundary (lines 430-434). But the project-root `README.md` / `CLAUDE.md` branch does NOT apply the same containment guard — it realpath-resolves the candidate and pushes it unconditionally:

```ts
for (const name of ['README.md', 'CLAUDE.md']) {
  const candidate = join(resolvedDir, name);
  if (existsSync(candidate)) {
    let realCandidate = candidate;
    try { realCandidate = realpathSync(candidate); } catch { /* use unresolved */ }
    paths.push(realCandidate);   // <-- no "stays inside resolvedDir" check
  }
}
```

If `<dir>/README.md` (or `CLAUDE.md`) is a symlink to a file OUTSIDE the project tree (`~/.ssh/id_rsa`, `/etc/passwd`, a sibling repo's secrets file, `../../private.md`), `emitDocEpisodes` will `readFileSync` it and record its contents as a `project-doc` episode — exactly the info-disclosure the T-31-PATH mitigation says it prevents ("bound all reads under the resolved project dir; README/CLAUDE read from project root only — never parent dirs"). `redactSecrets` only catches a handful of token shapes; arbitrary private file content (SSH keys are PEM, not `sk-`-shaped; private notes, env files with non-matching formats) flows straight through into the brain.

This is the same trust boundary the walk already defends; the root-file path is an unguarded hole in it.

**Fix:** Apply the identical containment guard to the root files before pushing:
```ts
for (const name of ['README.md', 'CLAUDE.md']) {
  const candidate = join(resolvedDir, name);
  if (!existsSync(candidate)) continue;
  let realCandidate: string;
  try { realCandidate = realpathSync(candidate); } catch { continue; }
  // T-31-PATH: a symlinked README/CLAUDE must not escape the project root
  if (realCandidate !== join(resolvedDir, name) &&
      !realCandidate.startsWith(resolvedDir + sep)) {
    continue; // symlink escape — skip
  }
  paths.push(realCandidate);
}
```
Add a test: write `README.md` as a symlink to a file outside `tmpDir` and assert `collectDocPaths` excludes it / its content never reaches `capturedEvents`.

## Warnings

### WR-01: Non-git directory with no docs is fingerprinted as `mtime:0` forever — survey skip-gate misfires (REINGEST-02 hole)

**File:** `src/adapter/ingest-project-cli.ts:214-230`
**Issue:**
`computeProjectFingerprint` falls back to `mtime:<maxMtimeMs>` over `docPaths` ONLY. For a non-git project with no `README.md` / `CLAUDE.md` / `docs/`, `collectDocPaths` returns `[]`, the loop never runs, and the function returns the constant `mtime:0`. Sequence:
- First run: `stored=null` → survey runs → cursor set to `mtime:0`.
- Every subsequent run: `stored === "mtime:0" === current` → `surveySkipped=true`.

The survey is then skipped permanently even if all source files change. This silently defeats the "re-runs the full survey when the repo changed" must-have (Plan 02) for the entire class of non-git, doc-less projects. It is a correctness failure, not just a perf miss, because the cursor is load-bearing for correctness per the plan.

The Plan 02 Task 1 spec explicitly said the mtime scan should cover "docPaths (**and the survey-relevant files**)"; only docPaths was implemented.

**Fix:** When `docPaths` is empty (or in general), broaden the mtime scan to the survey-relevant surface (e.g. top-level source files, `package.json`, or a shallow walk of the dir), or — simpler and safe — treat an empty mtime scan as "always changed" by mixing in a non-constant component:
```ts
let max = 0;
for (const p of docPaths) { try { max = Math.max(max, statSync(p).mtimeMs); } catch {} }
if (docPaths.length === 0) {
  // No fingerprintable surface for a non-git dir → never skip (force re-survey).
  return `mtime:none:${Date.now()}`; // distinct every run → survey always runs
}
return `mtime:${max}`;
```
At minimum, document that non-git doc-less dirs are unsupported by the skip-gate and always re-survey.

### WR-02: `emitDocEpisodes` recomputes `resolvedDir` three times and discards one; relPath base can drift from `collectDocPaths`

**File:** `src/adapter/ingest-project-cli.ts:486-503`
**Issue:**
`emitDocEpisodes` computes `resolvedDir = resolve(dir)` (line 487) but never uses it (dead binding), then independently re-derives `canonicalResolvedDir` via `realpathSync(resolve(dir))` (lines 491-496) to compute relPaths. Meanwhile `collectDocPaths` independently computes its OWN `resolvedDir` (line 377) and returns realpath'd absolute file paths. The two functions duplicate the same realpath logic by copy; if one is later changed (e.g. the fallback behavior on a non-existent dir), relPaths and the hash key silently diverge from the path list, corrupting the dedup key. The `relative(canonicalResolvedDir, filePath)` only stays correct as long as both copies resolve identically.

This is a latent correctness coupling plus a dead variable.

**Fix:** Have `collectDocPaths` return the resolved base alongside the paths (or export a small `resolveProjectRoot(dir)` helper used by both), and delete the unused `resolvedDir` binding at line 487. Single source of truth for the realpath base.

### WR-03: `walkDocDir` has no recursion-depth / cycle bound

**File:** `src/adapter/ingest-project-cli.ts:410-449`
**Issue:**
The walker recurses into every subdirectory whose realpath stays inside the project root. realpath collapses symlink loops to canonical targets, so a self-referential symlink inside the tree won't infinitely loop — but a pathologically deep legitimate directory tree (or a hardlink/bind-mount oddity) can still blow the call stack, and there is no depth cap. For a tool that runs against arbitrary operator-supplied `<dir>` this is a robustness gap. Lower-confidence than CR-01 since realpath neutralizes the common symlink-cycle case, but worth a bound.

**Fix:** Pass a `depth` parameter and cap it (e.g. `if (depth > 32) return;`), or track visited canonical dir paths in a `Set` and skip already-seen ones.

### WR-04: Cursor is committed even when the survey produced zero usable episodes (all areas refused)

**File:** `src/adapter/ingest-project-cli.ts:683-695` (and 752-763)
**Issue:**
`runSurveyAndFeed` retries each area once on refusal/tool-failure and then SKIPS it (feeds 0 episodes, pushes to `skippedAreas`). If every area refuses, `runSurveyAndFeed` returns `{ totalFed: 0, skippedAreas: [all 5] }` — but the code still unconditionally calls `setMeta(cursor, fingerprint)` because `surveySkipped` was false. The fingerprint is now committed for a repo that was never actually surveyed. A subsequent run on the SAME (unchanged) fingerprint will skip the survey entirely, so the transient refusal is frozen in: the project is permanently marked "ingested" with zero survey content until the repo changes or `--force` is used.

The deferred-commit intent ("setMeta AFTER survey succeeds") is being applied to a survey that effectively failed.

**Fix:** Only commit the cursor when the survey actually fed content (or fewer than all areas were skipped):
```ts
if (result.skippedAreas.length < SURVEY_AREAS.length) {
  semanticStore.setMeta(`cursor:project:${scope}`, fingerprint);
} else {
  fileLog('all areas refused — cursor NOT committed (re-survey next run)');
}
```

## Info

### IN-01: No test covers the symlink-escape guard (root files OR walk)

**File:** `tests/ingest-project-reingest.test.ts` (whole file)
**Issue:** T-31-PATH is the only invariant with no test. The walk's containment branch (lines 430-434) and the missing root-file guard (CR-01) are both unexercised, so CR-01 shipped undetected. Adding a symlink-escape test would have caught it.
**Fix:** Add a test that creates a file outside `tmpDir`, symlinks `<tmpDir>/README.md` and `<tmpDir>/docs/leak.md` to it, and asserts the outside content never appears in any recorded episode.

### IN-02: D-07 reconciliation test's "no duplicate" assertion is weakened by a dead variable

**File:** `tests/ingest-project-reingest.test.ts:787-791`
**Issue:** The test computes `liveNewCount = allNodes.filter(n => n.value === newValue).length` (which counts BOTH live and tombstoned) and then never asserts on it — it just re-asserts `liveNewNodes` has length 1 and does `void liveNewCount`. The comment claims "No second live duplicate of the new value" but the only real check is the prior `expect(liveNewNodes).toHaveLength(1)` on line 785, duplicated. The dead `liveNewCount` adds noise and implies a check that isn't made.
**Fix:** Drop `liveNewCount` and the redundant second `expect`, or actually assert something distinct (e.g. that the count of live nodes with `value===oldValue` is 0).

### IN-03: `gitFingerprint` git-repo test is environment-coupled and `dirty` is untested for the true branch

**File:** `tests/ingest-project-reingest.test.ts:367-389`
**Issue:** The "git repo returns {sha,dirty}" test runs against `process.cwd()`, whose dirty state is whatever the working tree happens to be — the test only asserts `typeof dirty === 'boolean'`, never that `dirty=true` is correctly detected when the tree is actually dirty. The dirty-detection path (the load-bearing "tree changed → re-survey" signal) is therefore unverified. The init-ed-temp-repo test only asserts `dirty=false`.
**Fix:** In the temp-repo test, after the initial commit write a new untracked file and assert `gitFingerprint(tmpDir).dirty === true`.

---

_Reviewed: 2026-06-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
