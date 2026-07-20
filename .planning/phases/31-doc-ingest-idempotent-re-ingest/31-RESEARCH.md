# Phase 31: Doc Ingest + Idempotent Re-ingest — Research

**Researched:** 2026-06-20
**Domain:** ingest-project-cli extension — doc episode emission + per-project cursor gating
**Confidence:** HIGH (all reuse points verified against live source)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01** — Docs ingest inside the same `ingest-project` run (single command, no separate subcommand). Doc set = README.md + docs/**/*.md + CLAUDE.md.
- **D-02** — Reuse `chunkNote` + `redactSecrets` from obsidian-adapter.ts; feed via existing `pipeline.recordEvent`. Do NOT register as a SourceAdapter in enabledSources.
- **D-03** — origin='observed' for project-docs. Never 'asserted_by_user'. redactSecrets still runs.
- **D-04** — Cursor skips agentic re-survey when repo fingerprint matches. Any change → full re-survey of all 5 areas. Partial/per-area re-survey rejected.
- **D-05** — Fingerprint = git HEAD sha + working-tree-dirty. Non-git dirs use max-mtime fallback. Stored as `cursor:project:<scope>` in SemanticStore.getMeta/setMeta.
- **D-06** — Doc episodes use contentExternalId(relPath, content) per-file. Independent of survey cursor. Unchanged doc re-run = INSERT OR IGNORE near-no-op.
- **D-07** — Trust PE-gated consolidation judge for in-place belief update on real change. Phase gated with a re-ingest dup-rate test.
- **D-08** — `--force` bypasses the cursor and re-surveys even when fingerprint is unchanged.
- **D-09** — `--dry-run` never advances the cursor. `--db <scratch>` gets its own cursor row in that DB.

### Claude's Discretion

- Cursor commit timing (eager post-survey vs deferred thunk).
- Doc chunking granularity for non-Obsidian docs (reuse verbatim vs minimal wrapper).
- git detection mechanism (shell-out vs direct file read).

### Deferred Ideas (OUT OF SCOPE)

- Partial/per-area re-survey.
- Registered project-doc SourceAdapter for hourly background pull.
- Phase 32: Scoped project recall + auto-corpus.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DOCING-01 | Ingest a project's own documents (README, docs/*.md, CLAUDE.md) directly with origin=observed and project scope | chunkNote + redactSecrets + contentExternalId confirmed exported/usable; pipeline.recordEvent call site mapped |
| REINGEST-01 | Re-running on a changed project reconciles with existing beliefs (PE-gated judge) rather than minting duplicates; unchanged re-run = near-no-op | INSERT OR IGNORE confirmed in episode-store; PE judge lives in run-sleep-pass.ts consolidator; consolidation.test.ts pattern confirmed |
| REINGEST-02 | Per-project cursor makes re-ingest incremental — only changed/new content re-surveyed | SemanticStore.getMeta/setMeta confirmed; cursor:obsidian pattern is direct template; timing decision resolved below |
</phase_requirements>

---

## Summary

Phase 31 is a focused extension of `src/adapter/ingest-project-cli.ts` (485 lines, no external deps, plain Node fs). All reuse points named in CONTEXT.md were verified against live source. The implementation risk is low: the helpers exist with the exact signatures claimed, the INSERT OR IGNORE path is confirmed, and the SemanticStore cursor plumbing is a direct copy-adapt from the obsidian pattern.

The three research questions are resolved below with concrete recommendations. The biggest landmine is the `SemanticStore` gotcha (not EpisodicStore) for cursor persistence — already called out in the codebase but easy to get wrong. The second landmine is `--dry-run` cursor discipline, which requires a code path that explicitly skips the cursor write even when a fingerprint was computed. The third is that `project-survey` and `project-doc` are unknown sources in `DEFAULT_CONFIG.sourceWeights` and will fall back to `claude-code` weight (1.0) — this is correct behavior and needs no config change, but should be documented.

**Primary recommendation:** Implement in two splice points in `main()` of `ingest-project-cli.ts` — (1) doc emission loop before the survey, (2) cursor read (skip-gate)/write (post-survey commit) bracketing the survey call. Add `--force` flag to `parseIngestArgs` + `IngestArgs`. Write a dedicated `tests/ingest-project-reingest.test.ts`.

---

## Reuse Points — Confirmed Signatures

### `src/source/obsidian-adapter.ts`

All three helpers are **exported** at the function declaration level — no export-patch needed. [VERIFIED: live source read]

| Symbol | Export | Signature | Notes |
|--------|--------|-----------|-------|
| `chunkNote` | `export function` | `chunkNote(content: string, maxBytes: number): NoteSection[]` | heading-split on `^#{1,2} ` only; headingless oversized → single section (no truncation, capContent downstream); returns `NoteSection[]` always at least 1 element |
| `NoteSection` | `export interface` | `{ heading: string \| null; text: string }` | `text` includes the heading line when applicable |
| `noteTitle` | `export function` | `noteTitle(relPath: string): string` — basename without `.md` | used for provenance header in normalizeObsidianNote; doc emission must build its own header or reuse this |
| `normalizeObsidianNote` | `export function` | `normalizeObsidianNote(section, title, relPath): NormalizedRecord` | sets `origin: 'asserted_by_user'` — **do NOT call directly**; instead copy its pattern with `origin: 'observed'` and `source: 'project-doc'` |
| `redactSecrets` | imported from `'./redact'` then re-exported | `redactSecrets(text: string): string` | exported from `src/source/redact.ts` directly; pure, idempotent, call before content lands on the record |
| `contentExternalId` | re-exported from `source-adapter` | `contentExternalId(relPath: string, content: string): string` | returns `${relPath}#${sha256(content).slice(0, 16)}`; `content` must be the post-redaction string |
| `MetaCursor` | `export interface` | `{ getMeta(key): string\|null; setMeta(key, value): void }` | SemanticStore satisfies this interface — confirmed by ingest-cli.ts wiring |

**Origin inversion (D-03):** `normalizeObsidianNote` hardcodes `origin: 'asserted_by_user'`. Do NOT call it. Build `NormalizedRecord` directly:
```typescript
// src/adapter/ingest-project-cli.ts (new helper)
const record: NormalizedRecord = {
  content: redactSecrets(`[[${noteTitle(relPath)}]]\n${section.text}`),
  source: 'project-doc',
  origin: 'observed',          // D-03: never asserted_by_user
  role: 'user',
  external_id: contentExternalId(relPath, redactedContent),
};
```
Then feed via `pipeline.recordEvent({ ...record, sessionId: 'project-doc:' + scope, externalId: record.external_id, cwd })`.

### `src/source/source-adapter.ts`

`contentExternalId` signature: [VERIFIED: live source read]
```typescript
export function contentExternalId(relPath: string, content: string): string {
  return `${relPath}#${createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)}`;
}
```
`NormalizedRecord` fields: `content`, `source`, `external_id`, `origin`, `role`. No `sessionId` or `cwd` — those are `RecordEventParams` fields added at the `pipeline.recordEvent` call site.

### `src/adapter/ingest-project-cli.ts` — splice points for Phase 31

File structure (485 lines): [VERIFIED: live source read]

| Section | Lines | What Phase 31 touches |
|---------|-------|----------------------|
| `parseIngestArgs` | 83–98 | Add `force: boolean` field + `argv.includes('--force')` |
| `IngestArgs` | 62–76 | Add `force?: boolean` |
| `resolveSurveyScope` | 109–112 | Reuse verbatim for doc scope — same scope as survey |
| `resolveSurveyCwd` | 124–129 | Reuse verbatim — doc episodes need same synthetic cwd for stampNodeScopes |
| `main()` real-run block (default path) | 410–444 | Add: (1) cursor read before survey, (2) doc emission loop, (3) cursor write after survey |
| `main()` consolidate block | 368–409 | Same additions — cursor must work in both paths |
| `main()` dry-run block | 349–366 | Cursor NOT written (D-09); survey still runs for count reporting |

**Key call site (survey episodes, line 263–275):**
```typescript
pipeline.recordEvent({
  content,
  role: 'user',
  origin: 'observed',
  sessionId: `project-survey:${scope}:${area}`,
  source: 'project-survey',
  externalId: contentExternalId(`${scope}/${area}`, content),
  cwd,
});
```
Doc episodes must mirror this pattern with `source: 'project-doc'`, `sessionId: 'project-doc:' + scope + ':' + relPath`, `externalId: contentExternalId(relPath, content)`.

### `src/adapter/ingest-cli.ts` — cursor plumbing pattern

[VERIFIED: live source read]

Critical findings:
1. **SemanticStore, not EpisodicStore.** `buildAdapters` receives `meta: Pick<SemanticStore, 'getMeta' | 'setMeta'>`. The comment is explicit: "Passing the EpisodicStore silently disables cursors." (line 73). Phase 31 must open a `SemanticStore` instance to call `getMeta/setMeta` for `cursor:project:<scope>`.
2. **Cursor key convention:** `cursor:gmail:<accountId>` → Phase 31's key is `cursor:project:<scope>` (e.g. `cursor:project:brain-memory`).
3. **Arg-validate-before-lock pattern (WR-02):** ingest-project-cli already validates `args.dir` before `acquireLock()`. The cursor read (which only needs the DB) should also happen before the lock — or at minimum before any expensive survey work.

### `src/consolidation/run-sleep-pass.ts`

[VERIFIED: live source read]

- `runConsolidation(db, dbPath, process.env, fileLog)` — already called in both `--consolidate` and default paths. No changes needed.
- `stampNodeScopes` — at line 418, runs `AFTER consolidate()`. Derives scope from `episode.cwd` via `cwdToScope`. Doc episodes carrying `cwd = resolveSurveyCwd(...)` will be stamped correctly — same mechanism as survey episodes.
- PE-gated reconsolidation judge — lives inside `Consolidator.consolidate()`. Phase 31 does not need to touch it; the cursor ensures it only fires when the repo changed.

### `src/lib/scope.ts`

[VERIFIED: live source read]

`cwdToScope(cwd)` maps `/Users/<user>/<project>` → `<project>`. `resolveSurveyScope` and `resolveSurveyCwd` are already correct for docs — same scope, same synthetic cwd threading. No new scope machinery needed.

---

## Research Question 1: git Fingerprint (net-zero deps)

**Recommendation: shell-out via `spawnSync('git', ...)` with direct `.git/HEAD` file fallback.**

### Option A: shell-out `git rev-parse HEAD` + `git status --porcelain`

The codebase already uses `execSync` in `recense-scheduler.ts` and `spawnSync` in multiple adapters (pin-node, recense-doctor, recense-init). Pattern is established. [VERIFIED: live source read]

```typescript
import { spawnSync } from 'child_process';

function gitFingerprint(dir: string): { sha: string; dirty: boolean } | null {
  const headResult = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', stdio: 'pipe' });
  if (headResult.status !== 0 || headResult.error) return null; // not a git repo
  const sha = headResult.stdout.trim();
  if (!sha || sha.length < 7) return null;

  const statusResult = spawnSync('git', ['-C', dir, 'status', '--porcelain'],
    { encoding: 'utf8', stdio: 'pipe' });
  // non-zero status = git error (not dirty); treat as clean to avoid false re-surveys
  const dirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0;
  return { sha, dirty };
}
```

**Fingerprint string for cursor storage:** `${sha}:${dirty ? 'dirty' : 'clean'}`

### Option B: read `.git/HEAD` directly

Confirmed the file structure: `.git/HEAD` = `ref: refs/heads/main\n` (symbolic) or a bare SHA (detached). Resolution requires reading `.git/refs/heads/<branch>` or `.git/packed-refs`. The `packed-refs` case is non-trivial (grep the file for the branch name). Detached HEAD is a bare SHA directly in `.git/HEAD`. The implementation is ~30 lines of Node fs and handles the common cases — but submodules, worktrees, and `--separate-git-dir` all add edge cases.

### Decision: shell-out wins

**Reasoning:**
- `git -C <dir> rev-parse HEAD` works correctly for: detached HEAD, symlinked HEAD, packed refs, submodules, non-repo root dirs (git walks up to find the repo root). The file-reading approach breaks on packed refs if the branch is only there (not in `refs/heads/`).
- `spawnSync` is already the codebase's established pattern for system utilities.
- The `--porcelain` dirty-check correctly reports untracked + modified + staged changes.
- net-zero runtime deps — `child_process` is a Node built-in.
- Non-git dirs: `git rev-parse HEAD` exits non-zero → `spawnSync.status !== 0` → return `null` → fall through to mtime fallback.

**Detached HEAD:** `git rev-parse HEAD` still returns the SHA even in detached HEAD. The `-C <dir>` flag ensures the right repo is targeted regardless of the process's cwd.

**mtime fallback (D-05):** When `gitFingerprint(dir)` returns `null`, compute max-mtime over the doc files being ingested (README.md + docs/**/*.md + CLAUDE.md). Store as `mtime:<maxMtimeMs>` in the cursor. This mirrors the ObsidianAdapter D-67 pattern exactly (obsidian-adapter.ts line 246–247).

```typescript
// Mtime fallback for non-git dirs
function mtimeFingerprint(filePaths: string[]): string {
  let max = 0;
  for (const p of filePaths) {
    try { const s = statSync(p); if (s.mtimeMs > max) max = s.mtimeMs; } catch {}
  }
  return `mtime:${max}`;
}
```

**Stored cursor format:** `git:<sha>:<dirty|clean>` or `mtime:<maxMs>`. Prefix discriminates the two cases on next read.

---

## Research Question 2: Doc Chunking Granularity

**Recommendation: reuse `chunkNote` verbatim.**

`chunkNote(content, config.maxContentBytes)` behavior for project docs: [VERIFIED: obsidian-adapter.ts + test suite]

| Doc type | Common shape | chunkNote result |
|----------|-------------|-----------------|
| README.md with headings | Multiple `##` sections | Splits at each heading — correct; each section is one episode |
| README.md without headings + under maxBytes | Single block | Returns one section — correct |
| README.md without headings + huge | Falls through as single section | capContent downstream handles byte cap — no data invented |
| CLAUDE.md | Often a single long block with `##` headings | Splits at headings — correct |
| docs/*.md | Typical structured markdown | Splits at headings — correct |

**Edge cases checked:**

1. **Front-matter (YAML `---` blocks):** Not a heading. If the note has `---\nkey: val\n---\n# Section`, the front-matter becomes the null-heading intro section (before the first `#`), and `# Section` becomes its own section. This is acceptable behavior — the front-matter is captured as context in the intro section.

2. **Code-fenced blocks with `##` inside:** `chunkNote` uses `^(#{1,2}) (.+)$` in multiline mode — this matches headings anywhere in the content including inside code fences. A `## heading` inside a triple-backtick block would incorrectly trigger a split. This is an existing `chunkNote` behavior, not a new issue for Phase 31. In practice, project README files rarely have `##` headings literal in code blocks.

3. **Very large headingless docs:** The single-section fallback is correct; the LLM extractor sees the full content (up to capContent cap). No data loss.

4. **No wrapping needed.** The provenance header `[[title]]` prepended in `normalizeObsidianNote` is the Obsidian-specific pattern. For project docs, use the doc filename as the title (e.g. `[[README]]`, `[[CLAUDE]]`, `[[docs/guide]]`). Same `noteTitle(relPath)` function produces the right basename.

**Conclusion:** call `chunkNote(content, config.maxContentBytes)` directly, build the record manually (not via `normalizeObsidianNote`) to set `origin: 'observed'` and `source: 'project-doc'`. No wrapper needed.

---

## Research Question 3: Cursor Commit Timing

**Recommendation: deferred thunk, committed after survey episodes are written, SKIPPED on `--dry-run`.**

**The fetch/commit split is the right pattern here.** Reasoning:

1. **Crash safety:** The survey loop (`runSurveyAndFeed`) writes episodes via `pipeline.recordEvent` which calls `EpisodicStore.append` (SQLite, synchronous, durable). If the process crashes after episodes are written but before the cursor is committed, the next run re-surveys — episodes are deduplicated by `INSERT OR IGNORE` on `(source, external_id)`. However, survey episodes use `contentExternalId(\`${scope}/${area}\`, content)` where `content` is LLM-generated text. Since the LLM is non-deterministic, a re-survey produces different content → different hashes → no INSERT OR IGNORE dedup → new episodes inserted. This is acceptable (the PE-gated judge handles in-place update) but is the normal "at-least-once" behavior. Committing the cursor eagerly before episodes are written would be WRONG — it would mark the project as ingested even if the survey crashed halfway through.

2. **The correct sequence:**
   ```
   (a) Read cursor → check fingerprint → skip survey if unchanged [D-04]
   (b) Run survey (runSurveyAndFeed) — writes episodes
   (c) Commit cursor ← DEFERRED to here, after (b) succeeds
   ```
   If (b) throws, the cursor is never committed → next run re-surveys → at-least-once. ✓

3. **`--dry-run` must not commit (D-09):** The dry-run path calls a dummy pipeline and returns without writing any rows. The cursor read can still happen (to report "would skip: fingerprint unchanged"), but `commitCursor` must never be called. Implement as a `dryRun` flag passed to the cursor commit point.

4. **`--db <scratch>` gets its own cursor row (D-09):** Since the cursor key is `cursor:project:<scope>` stored in the SemanticStore of the target DB (`dbPath`), using `--db /tmp/x.db` naturally isolates the cursor. No extra logic needed — the SemanticStore is opened from `dbPath`.

5. **Default path vs --consolidate path:** Both paths have the same structure. The cursor commit happens after `runSurveyAndFeed` succeeds, before `runConsolidation`. The consolidation is deferred to the sleep pass on the default path anyway — the episodes are in the DB by the time `commitCursor()` is called.

**Implementation sketch:**
```typescript
// Before survey (inside both default and --consolidate branches):
const semanticStore = new SemanticStore(db, realClock, config);
const storedFingerprint = semanticStore.getMeta(`cursor:project:${scope}`);
const currentFingerprint = computeFingerprint(args.dir, docPaths);

if (!args.force && storedFingerprint && storedFingerprint === currentFingerprint) {
  process.stdout.write(`  cursor: fingerprint unchanged — skipping survey\n`);
  // Still emit docs (per-file content-hash handles their own idempotency)
} else {
  // Run survey
  const result = await runSurveyAndFeed({ ... });
  if (!args.dryRun) {
    semanticStore.setMeta(`cursor:project:${scope}`, currentFingerprint);
  }
}
```

---

## Gotchas / Landmines

### 1. SemanticStore vs EpisodicStore for cursor (CRITICAL)

`ingest-cli.ts` line 73 is explicit: "Passing the EpisodicStore silently disables cursors — re-fetches all data hourly." The `SemanticStore` must be instantiated from the same DB handle to call `getMeta/setMeta`. In `ingest-project-cli.ts`, neither the default path nor the `--consolidate` path currently opens a `SemanticStore`. Phase 31 must add this:

```typescript
const semanticStore = new SemanticStore(db, realClock, config);
```

Add `import { SemanticStore } from '../db/semantic-store';` to the file's imports.

### 2. `--dry-run` cursor-advance prohibition (D-09)

The current dry-run path (lines 349–366) returns early before opening a real DB. In Phase 31, the cursor read should still happen (for the "would skip" message), but requires opening a real DB handle. Either:
- (a) Open the DB in dry-run mode just for the cursor check, or
- (b) Skip the cursor check in dry-run and always report "would run survey"

Option (b) is simpler and safer — `--dry-run` is a preview tool, not a skip-gate validator.

### 3. `project-doc` and `project-survey` are unknown sourceWeights

`DEFAULT_CONFIG.sourceWeights` (config.ts lines 582–591) lists `claude-code`, `obsidian`, `granola`, `gmail`, `gcal`. Neither `project-doc` nor `project-survey` appears. [VERIFIED: live source read]

`AllocationGate.score()` line 92: `const sourceWeight = cfg.sourceWeights[source] ?? cfg.sourceWeights['claude-code'] ?? 1.0;`

Both unknown sources fall back to `1.0` (the `claude-code` weight). This is the **correct behavior** — project docs and survey observations are high-signal, high-trust content. No config change is needed. But the plan should document this so the implementer doesn't think they need to add entries.

### 4. `consolSkipThresholdBySource` fallback

Similarly, `project-doc` and `project-survey` are not in `consolSkipThresholdBySource`. They'll use the global `consolSkipThreshold` (default 0.2). Correct; no config change needed.

### 5. Doc file globbing: `docs/**/*.md` requires recursive walk

Phase 30 does not walk directories. Phase 31's doc emission loop needs a recursive `readdirSync` over `docs/` plus the two top-level files. The ObsidianAdapter's `walkDir` method is a private method — not reusable. Must write a small recursive walk inline in ingest-project-cli, or extract a shared utility. The walk is ~15 lines of Node fs, similar to the ObsidianAdapter pattern (without the symlink path-guard, since we trust the project dir).

**File set (D-01):**
- `${dir}/README.md` (if exists)
- `${dir}/CLAUDE.md` (if exists)
- `${dir}/docs/**/*.md` (if `docs/` exists, recursive, skip non-.md)

### 6. Episode-count assertions in existing tests

`tests/ingest-project-cli.test.ts` contains tests for `runSurveyAndFeed` that count episodes and call `pipeline.recordEvent`. Phase 31 adds a new doc-emission loop that calls `pipeline.recordEvent` separately from the survey loop. The existing tests mock the survey transport and count `recordEvent` calls — they test `runSurveyAndFeed` in isolation, NOT the full `main()`. So they will NOT break from doc emission being added to `main()`.

However, if Phase 31 extracts a `runDocEmitAndFeed` helper (analogous to `runSurveyAndFeed`), its tests must be isolated from the survey tests. No existing test asserts a total episode count for a full run of `main()` — confirmed by reading the test file.

### 7. `contentExternalId` for docs: `relPath` must be stable

The `relPath` parameter is the path relative to the project root (e.g. `README.md`, `docs/guide.md`). It must be computed as `path.relative(dir, filePath)` where `dir` is the project root, not relative to some other base. If `dir` changes between runs (e.g. user provides `/Users/vtx/brain-memory` vs `brain-memory` resolved differently), the hash prefix changes and dedup fails. Always call `path.resolve(args.dir)` to canonicalize before computing relative paths.

### 8. CLAUDE.md vs .claude/CLAUDE.md

D-01 specifies the doc set as `README.md + docs/**/*.md + CLAUDE.md`. It's unambiguous that this is the project root `CLAUDE.md` (e.g. `<dir>/CLAUDE.md`), not `<dir>/.claude/CLAUDE.md`. The user's global CLAUDE.md is out of scope. The plan should be explicit about this path.

### 9. `--force` flag not yet in `parseIngestArgs` or `IngestArgs`

The current `IngestArgs` interface (lines 62–76) has `dir`, `dryRun`, `consolidate`, `db`, `scope`, `desc`. `force` (D-08) does not exist yet. Phase 31 must add it:
```typescript
/** --force: re-survey even when fingerprint is unchanged. */
force: boolean;
```
And in `parseIngestArgs`: `const force = argv.includes('--force');`

---

## Dup-Rate Test Pattern

The gate requirement (D-07): "changed-fact re-ingest → tombstone+new, not dup; unchanged re-run → 0 new consolidated beliefs."

**No existing re-ingest test fixture for ingest-project exists.** The closest patterns to model on:

1. `tests/consolidation.test.ts` — uses `new Database(':memory:')` + `initSchema(db)` + `FakeClock` + `MockModelProvider` + `Consolidator`. Proves UPDATE-01/02/03 (PE-gated reconcile). This is the right harness for "changed belief → tombstone+new."

2. `tests/episode-dedup.test.ts` — tests `INSERT OR IGNORE` dedup on (source, external_id). Models the "unchanged doc → near-no-op" assertion.

3. `tests/obsidian-adapter.test.ts` — tests `chunkNote` + `normalizeObsidianNote` in isolation. Good model for testing the doc emission helper.

**Recommended new test file: `tests/ingest-project-reingest.test.ts`**

Tests to include:
- `T-31-CURSOR-1`: unchanged repo → cursor matches → survey skipped → 0 new episodes (mock survey never called)
- `T-31-CURSOR-2`: `--force` → cursor matches but survey runs anyway
- `T-31-CURSOR-3`: `--dry-run` → cursor not committed even after survey runs
- `T-31-CURSOR-4`: `--db /tmp/x.db` cursor stored in scratch DB, not live DB
- `T-31-DOC-1`: doc emit calls `pipeline.recordEvent` with `origin='observed'`, `source='project-doc'`
- `T-31-DOC-2`: unchanged doc re-emit → INSERT OR IGNORE (same externalId → no new episode)
- `T-31-DOC-3`: edited doc (new content) → new externalId → new episode inserted
- `T-31-SCOPE-1`: doc episodes carry same cwd as survey episodes → stampNodeScopes assigns same scope

The dup-rate gate (D-07) for real changed-fact reconciliation requires a consolidation integration test using `MockModelProvider` to simulate the PE judge returning a "contradicts" verdict → tombstone + new node. Model directly on `consolidation.test.ts` Criterion 1 ("changed fact reconciles").

---

## Files to Create / Modify

| File | Action | Closest Analog |
|------|--------|----------------|
| `src/adapter/ingest-project-cli.ts` | Modify — add `--force` flag, doc emission loop, cursor read/write | Itself (Phase 30) |
| `tests/ingest-project-reingest.test.ts` | Create — cursor + doc emit + dup-rate tests | `tests/ingest-project-cli.test.ts` (helper isolation) + `tests/consolidation.test.ts` (dup-rate) |
| `src/adapter/ingest-project-cli.ts` imports | Add `SemanticStore` import | `src/adapter/ingest-cli.ts` line 38 |

No new source files required. No new dependencies. Net-zero runtime deps maintained.

---

## Architecture: Splice Map for `main()`

```
main()
  ├── parseIngestArgs (add --force)
  ├── validate dir (existing)
  ├── checkOpenAiKeyIfConsolidate (existing)
  ├── resolve scope + cwd (existing)
  │
  ├── [NEW] open DB early (needed for cursor read before lock)
  ├── [NEW] init SemanticStore from DB
  ├── [NEW] computeFingerprint(dir, docPaths) → fingerprint string
  ├── [NEW] read cursor:project:<scope> from SemanticStore
  ├── [NEW] skip-gate: if fingerprint matches AND !force → set surveySkipped=true
  │
  ├── [NEW] emitDocEpisodes(dir, scope, cwd, pipeline, dryRun)
  │     └── walk README.md + CLAUDE.md + docs/**/*.md
  │         for each file: chunkNote → build NormalizedRecord (origin=observed, source=project-doc)
  │         → pipeline.recordEvent (or skip if dryRun)
  │
  ├── if !surveySkipped:
  │     └── runSurveyAndFeed (existing)
  │         → if !dryRun: semanticStore.setMeta(cursor:project:<scope>, fingerprint)
  │
  ├── if consolidate: runConsolidation (existing)
  └── close DB + release lock (existing)
```

**Key sequencing constraint:** The cursor write must happen AFTER `runSurveyAndFeed` succeeds and BEFORE `db.close()`. In the `--consolidate` path, it must happen before `runConsolidation` (the consolidation is best-effort; don't gate the cursor write on it).

---

## Environment Availability

Step 2.6: SKIPPED for runtime deps — this phase adds no new external tools. `git` availability matters for the fingerprint; confirmed present at `/usr/bin/git` on the dev machine. The `spawnSync('git', [...])` path returns `null` (not a git repo) gracefully when git is absent — falls through to mtime fallback.

---

## Sources

- `src/adapter/ingest-project-cli.ts` — live Phase-30 command, all exports + call sites verified [HIGH]
- `src/source/obsidian-adapter.ts` — chunkNote, redactSecrets import, normalizeObsidianNote, MetaCursor, pull() pattern [HIGH]
- `src/source/source-adapter.ts` — contentExternalId signature, NormalizedRecord contract, fetch/commit split [HIGH]
- `src/adapter/ingest-cli.ts` — SemanticStore cursor pattern, buildAdapters gotcha comment, per-account key convention [HIGH]
- `src/consolidation/run-sleep-pass.ts` — runConsolidation, stampNodeScopes, resolveNodeScope [HIGH]
- `src/lib/scope.ts` — cwdToScope, resolveNodeScope [HIGH]
- `src/ingest/pipeline.ts` — RecordEventParams, recordEvent, source fallback logic [HIGH]
- `src/gate/allocation-gate.ts` line 92 — unknown source fallback to claude-code weight [HIGH]
- `src/lib/config.ts` lines 582–600 — sourceWeights, consolSkipThresholdBySource [HIGH]
- `src/db/episode-store.ts` lines 107–152 — INSERT OR IGNORE + dedup backstop [HIGH]
- `src/db/semantic-store.ts` lines 432–440 — getMeta/setMeta [HIGH]
- `tests/ingest-project-cli.test.ts` — existing test structure (no episode-count assertions in full main()) [HIGH]
- `.git/HEAD` + `.git/refs/heads/main` + `.git/packed-refs` — direct inspection of git file structure [HIGH]

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], ...)` exits non-zero when `dir` is not in a git repo | RQ1 | Low — git behavior is well-defined; mtime fallback covers non-git case |
| A2 | Code-fenced `##` headings inside README files are rare enough that chunkNote's regex split is acceptable | RQ2 | Low — project docs rarely have literal `##` in code blocks at column 0 |
| A3 | The `--consolidate` path does not need the cursor write to be gated on consolidation success | RQ3 | Low — consolidation failure shouldn't block marking the survey as complete |

---

## RESEARCH COMPLETE

**Phase:** 31 — Doc Ingest + Idempotent Re-ingest
**Confidence:** HIGH — all reuse points verified against live source

### Key Findings

- All three helpers (`chunkNote`, `redactSecrets`, `contentExternalId`) are exported from their files and usable without modification. `normalizeObsidianNote` must NOT be called — build `NormalizedRecord` directly to set `origin: 'observed'`.
- The cursor MUST use `SemanticStore.getMeta/setMeta`, not EpisodicStore. A `SemanticStore` instance must be added to both `main()` branches. This is the highest-risk gotcha.
- Cursor commit timing: deferred (after survey episodes written, before close), skipped on `--dry-run`. This is the fetch/commit split pattern confirmed by `SourceAdapter.pull()`.
- git fingerprint: `spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'])` + `git status --porcelain`; mtime fallback for non-git dirs. Net-zero deps.
- `project-doc` and `project-survey` fall back to `claude-code` weight (1.0) — correct, no config change needed.
- No existing tests assert total episode count for a full `main()` run — doc emission won't break the test suite.
- New test file needed: `tests/ingest-project-reingest.test.ts` (8 tests).
- Only files to touch: `src/adapter/ingest-project-cli.ts` (extend) + `tests/ingest-project-reingest.test.ts` (new).

### File Created

`.planning/phases/31-doc-ingest-idempotent-re-ingest/31-RESEARCH.md`

### Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Reuse point signatures | HIGH | Read live source, all confirmed |
| Cursor plumbing | HIGH | SemanticStore pattern confirmed in ingest-cli.ts |
| git fingerprint approach | HIGH | spawnSync pattern confirmed in codebase; git file structure inspected |
| Chunking reuse | HIGH | chunkNote tested in obsidian-adapter.test.ts; edge cases analyzed |
| Dup-rate test pattern | HIGH | consolidation.test.ts harness confirmed; episode-dedup.test.ts confirmed |

### Open Questions

None — all three research questions resolved with concrete recommendations.

### Ready for Planning

Research complete. Planner can now create PLAN.md files for Phase 31.
