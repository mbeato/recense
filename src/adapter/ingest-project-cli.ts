/**
 * ingest-project-cli — recense ingest-project <dir> (Phase 30 Plan 02).
 *
 * Surveys an unexplored repo across the 5 calibrated areas via the Plan-01
 * tool-enabled survey transport, emits summarized why-level observations as
 * one episode per belief-line (scope-tagged, origin='observed',
 * source='project-survey'), and hands off to consolidation: deferred to the
 * scheduled sleep pass by default (D-01), or inline under the lock with
 * --consolidate (D-02).
 *
 * Design invariants (from CLAUDE.md / 30-02-PLAN.md threat model):
 *  - Episodes carry origin='observed' (NEVER 'asserted_by_user' / 'inferred').
 *    Survey output must never self-confirm a belief (T-30-06).
 *  - isRefusalOrToolFailure areas are retried once then skipped — the apology
 *    text is never ingested (T-30-07 / D-07).
 *  - --dry-run runs the full survey but prints counts and writes ZERO rows
 *    (T-30-05 / D-05).
 *  - --scope is threaded via a synthetic home-rooted cwd so consolidation's
 *    stampNodeScopes derives the override scope correctly (INGEST-02 / Pitfall 3).
 *  - The live brain (~/.config/recense/recense.db) is the default write target
 *    (D-04 — the spike's live-refuse guard is NOT carried).
 *  - Default path holds NO write lock (deferred sentinel handoff, D-01).
 *    --consolidate uses the real global lock intentionally (D-02).
 *  - OPENAI_API_KEY pre-flight ONLY under --consolidate (Seam 5).
 *  - Net-zero new runtime deps — no new packages added (T-30-SC).
 *
 * Modeled on import-memory-cli.ts (WR-02: arg validation before acquireLock).
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, join, relative, resolve, sep } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import type { EngineConfig } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { AllocationGate, IngestionPipeline } from '../ingest/pipeline';
import { cwdToScope } from '../lib/scope';
import { contentExternalId } from '../source/source-adapter';
import { chunkNote, noteTitle } from '../source/obsidian-adapter';
import { redactSecrets } from '../source/redact';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath, resolveDirtySentinelPath } from './runtime-config';
import { createClaudeHeadlessSurveyClient } from '../model/claude-headless-client';
import { runConsolidation, resolveProviderOverlay } from '../consolidation/run-sleep-pass';
import {
  SURVEY_AREAS,
  type SurveyArea,
  buildSurveyPrompt,
  splitObservations,
  isRefusalOrToolFailure,
} from './survey-observations';
import type Anthropic from '@anthropic-ai/sdk';

const LOG_PATH = '/tmp/recense-ingest-project.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ingest-project: ${msg}\n`);

// ── Parsed CLI arguments ──────────────────────────────────────────────────────

export interface IngestArgs {
  /** Positional: the repo directory to survey. */
  dir: string;
  /** --dry-run: run the survey but write 0 rows. */
  dryRun: boolean;
  /** --consolidate: run the sleep pass inline under the lock after feeding. */
  consolidate: boolean;
  /** --force: re-survey even when fingerprint is unchanged (D-08). */
  force: boolean;
  /** --db <path>: override target DB (default = live brain). */
  db?: string;
  /** --scope <slug>: override the derived scope (threaded via synthetic cwd). */
  scope?: string;
  /** --desc <text>: override the repo description used in the survey prompt. */
  desc?: string;
}

/**
 * Parse the ingest-project CLI argv (the part after `recense ingest-project`).
 *
 * Positional arg: argv[0] = <dir>
 * Flags: --dry-run, --consolidate, --db <path>, --scope <slug>, --desc <text>
 */
export function parseIngestArgs(argv: string[]): IngestArgs {
  const dir = argv[0] ?? '';
  const dryRun = argv.includes('--dry-run');
  const consolidate = argv.includes('--consolidate');
  const force = argv.includes('--force');

  const dbIdx = argv.indexOf('--db');
  const db = dbIdx >= 0 ? argv[dbIdx + 1] : undefined;

  const scopeIdx = argv.indexOf('--scope');
  const scope = scopeIdx >= 0 ? argv[scopeIdx + 1] : undefined;

  const descIdx = argv.indexOf('--desc');
  const desc = descIdx >= 0 ? argv[descIdx + 1] : undefined;

  return { dir, dryRun, consolidate, force, ...(db ? { db } : {}), ...(scope ? { scope } : {}), ...(desc ? { desc } : {}) };
}

// ── Scope resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the scope slug for the survey.
 *
 * Without --scope: derive from dir via cwdToScope(dir) (works for home-rooted paths).
 * With --scope: return the slug directly (Pitfall 3: for non-home-rooted dirs like
 *   /tmp/checkout, cwdToScope would return 'global' — so the explicit slug wins).
 */
export function resolveSurveyScope(opts: { dir: string; scope?: string }): string {
  if (opts.scope) return opts.scope;
  return cwdToScope(opts.dir);
}

/**
 * Resolve the cwd to pass to recordEvent so consolidation's stampNodeScopes derives
 * the correct scope.
 *
 * Without --scope: use the real dir (works for home-rooted paths).
 * With --scope: synthesize a home-rooted cwd `/Users/<user>/<scope>` (or /home on Linux)
 *   so cwdToScope(syntheticCwd) === scope. This is the critical Pitfall-3 fix:
 *   the synthetic cwd makes the EXISTING stampNodeScopes derive the override scope with
 *   ZERO consolidation-engine changes.
 */
export function resolveSurveyCwd(opts: { dir: string; scope?: string }): string {
  if (!opts.scope) return opts.dir;
  // Synthesize a home-rooted path that cwdToScope will map to opts.scope
  const home = homedir(); // e.g. /Users/vtx or /home/vtx
  return `${home}/${opts.scope}`;
}

// ── Repo description ──────────────────────────────────────────────────────────

/**
 * Derive a one-line description of the repo for the survey prompt (D-10).
 *
 * Tries to read the first heading or paragraph from README.md; falls back to
 * the dir basename when no README exists or it has no heading. A --desc override
 * skips the README entirely.
 */
export async function deriveRepoDesc(dir: string, descOverride?: string): Promise<string> {
  if (descOverride) return descOverride;

  const readmePath = join(dir, 'README.md');
  if (existsSync(readmePath)) {
    try {
      const content = readFileSync(readmePath, 'utf8');
      // Extract first markdown heading (# ... or ## ...)
      const headingMatch = /^#{1,2}\s+(.+)$/m.exec(content);
      if (headingMatch?.[1]) return headingMatch[1].trim();
      // Fall back to first non-empty line
      const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0);
      if (firstLine) return firstLine;
    } catch {
      // Fall through to basename
    }
  }

  return basename(dir);
}

// ── Repo fingerprint (REINGEST-02) ────────────────────────────────────────────

/**
 * Return the git HEAD sha and dirty status for a repo directory, or null if
 * dir is not inside a git repository.
 *
 * ALWAYS uses the arg-array form spawnSync('git', ['-C', dir, ...], ...)
 * — never a shell string, never shell:true (T-31-INJECT).
 *
 * Error handling (T-31-GITERR):
 *   - If `git status --porcelain` fails (non-zero exit), treat as clean to
 *     avoid a false dirty→re-survey loop. Worst case: a genuinely-dirty tree
 *     is skipped once; `--force` is the escape hatch.
 */
export function gitFingerprint(dir: string): { sha: string; dirty: boolean } | null {
  const headResult = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (headResult.status !== 0 || headResult.error) return null;
  const sha = headResult.stdout.trim();
  if (!sha || sha.length < 7) return null;

  const statusResult = spawnSync('git', ['-C', dir, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  // non-zero = git error (not dirty); treat as clean (T-31-GITERR)
  const dirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0;
  return { sha, dirty };
}

/**
 * Compute a fingerprint string for a project directory.
 *
 * Git repo: `git:<sha>:<clean|dirty>`
 * Non-git dir: `mtime:<maxMtimeMs>` over the provided docPaths.
 *
 * The fingerprint is stable for identical state and changes when:
 * - HEAD moves (new commit), OR
 * - Working tree goes dirty, OR
 * - A tracked doc's mtime advances (non-git fallback).
 *
 * Uses path.resolve(dir) before calling gitFingerprint so the canonical
 * absolute path is passed to `git -C` (T-31-INJECT).
 */
export function computeProjectFingerprint(dir: string, docPaths: string[]): string {
  const fp = gitFingerprint(resolve(dir));
  if (fp !== null) {
    return `git:${fp.sha}:${fp.dirty ? 'dirty' : 'clean'}`;
  }
  // Mtime fallback for non-git dirs (mirrors ObsidianAdapter D-67 pattern)
  let max = 0;
  for (const p of docPaths) {
    try {
      const s = statSync(p);
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch {
      // Unreadable/non-existent path — skip gracefully (no throw)
    }
  }
  return `mtime:${max}`;
}

// ── DB path resolution ────────────────────────────────────────────────────────

/**
 * Resolve the target DB path.
 *
 * D-04: the live brain (~/.config/recense/recense.db) is the default — the spike's
 * live-refuse guard is NOT carried here (this is the production command, not a
 * throwaway spike). Use resolveDbPath WITH fallback-to-default.
 *
 * D-06: --db <path> overrides the default.
 */
export function resolveTargetDb(argv: string[]): string {
  // resolveDbPath with fallback=true (default overload) returns the live brain when no --db / env
  return resolveDbPath(argv);
}

// ── OPENAI_API_KEY pre-flight ─────────────────────────────────────────────────

/**
 * Pre-flight check for OPENAI_API_KEY — gated on --consolidate ONLY (Seam 5).
 *
 * The default path (deferred consolidation) does NOT embed episodes and does NOT
 * need the key. Only --consolidate (inline sleep pass) triggers embedding.
 * Throws if consolidate=true and the key is absent.
 */
export function checkOpenAiKeyIfConsolidate(
  consolidate: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!consolidate) return;
  if (!env['OPENAI_API_KEY']) {
    throw new Error(
      'OPENAI_API_KEY is missing — --consolidate runs the sleep pass inline and requires it.\n' +
      '  Export it (e.g. from ~/.config/recense/sleep.env) before running — exiting',
    );
  }
}

// ── Survey loop ───────────────────────────────────────────────────────────────

/** Return type for runSurveyAndFeed. */
export interface SurveyFeedResult {
  /** Per-area episode count (would-be counts on --dry-run). */
  perAreaCounts: Record<string, number>;
  /** Total episodes fed (0 on --dry-run). */
  totalFed: number;
  /** Areas skipped after refusal retry (D-07). */
  skippedAreas: string[];
}

/**
 * Survey each area, feed one episode per belief-line, return per-area counts.
 *
 * Options:
 *  - surveyArea: injectable transport function (area, repoDir, repoDesc) → text
 *  - dryRun: run survey + count but write 0 rows (pipeline.recordEvent NOT called)
 *
 * Refusal handling (D-07 / T-30-07):
 *  If isRefusalOrToolFailure(response), retry the area ONCE.
 *  If still a refusal, skip the area (feed 0 episodes) and add to skippedAreas.
 *  The apology text is NEVER ingested.
 */
export async function runSurveyAndFeed(opts: {
  dir: string;
  scope: string;
  repoDesc: string;
  pipeline: Pick<IngestionPipeline, 'recordEvent'>;
  surveyArea: (area: string, repoDir: string, repoDesc: string) => Promise<string>;
  dryRun: boolean;
}): Promise<SurveyFeedResult> {
  const { dir, scope, repoDesc, pipeline, dryRun } = opts;
  const cwd = resolveSurveyCwd({ dir, scope });

  const perAreaCounts: Record<string, number> = {};
  let totalFed = 0;
  const skippedAreas: string[] = [];

  for (const area of SURVEY_AREAS) {
    let text = await opts.surveyArea(area, dir, repoDesc);

    // D-07: retry once on refusal / tool failure
    if (isRefusalOrToolFailure(text)) {
      fileLog(`refusal: area=${area} retrying once`);
      text = await opts.surveyArea(area, dir, repoDesc);
      if (isRefusalOrToolFailure(text)) {
        fileLog(`refusal: area=${area} second attempt also failed — skipping`);
        perAreaCounts[area] = 0;
        skippedAreas.push(area);
        process.stdout.write(`  area=${area}: SKIPPED (refusal/tool-failure after retry)\n`);
        continue;
      }
    }

    const observations = splitObservations(text);
    perAreaCounts[area] = observations.length;

    if (dryRun) {
      // Dry-run: print counts + samples, write nothing
      const samples = observations.slice(0, 2).map(l => `    • ${l}`).join('\n');
      process.stdout.write(`  area=${area}: ${observations.length} would-be episodes\n${samples ? samples + '\n' : ''}`);
    } else {
      // Real run: feed episodes
      for (const content of observations) {
        pipeline.recordEvent({
          content,
          role: 'user',
          origin: 'observed', // T-30-06: NEVER 'asserted_by_user'
          sessionId: `project-survey:${scope}:${area}`,
          source: 'project-survey',
          externalId: contentExternalId(`${scope}/${area}`, content),
          cwd,
        });
        totalFed++;
      }
      process.stdout.write(`  area=${area}: ${observations.length} episodes\n`);
      fileLog(`fed: area=${area} episodes=${observations.length}`);
    }
  }

  return { perAreaCounts, totalFed, skippedAreas };
}

// ── Doc walk + emitDocEpisodes ────────────────────────────────────────────────

/**
 * Collect absolute paths of documentation files for a project directory.
 *
 * Returns:
 *  - `<dir>/README.md`   — if it exists (project root only, NOT .claude/CLAUDE.md)
 *  - `<dir>/CLAUDE.md`   — if it exists (project root only)
 *  - Every `.md` file found by a recursive walk of `<dir>/docs/` (if docs/ exists)
 *
 * Security (T-31-PATH):
 *  - dir is resolved to an absolute path via path.resolve.
 *  - Symlinks that resolve outside the resolved project dir are skipped.
 *  - README.md and CLAUDE.md are read from the project root ONLY — never from
 *    parent dirs or sub-dirs like .claude/.
 *
 * Returns sorted paths for deterministic ordering.
 */
export function collectDocPaths(dir: string): string[] {
  // Use realpathSync for the project root so symlinked tmp dirs (macOS /var → /private/var)
  // produce a canonical base that matches the realpathSync results in the walk (T-31-PATH).
  let resolvedDir: string;
  try {
    resolvedDir = realpathSync(resolve(dir));
  } catch {
    resolvedDir = resolve(dir); // fall back if dir doesn't exist yet (shouldn't happen)
  }
  const paths: string[] = [];

  // Project-root only files
  for (const name of ['README.md', 'CLAUDE.md']) {
    const candidate = join(resolvedDir, name);
    if (existsSync(candidate)) {
      // Resolve to canonical path (macOS /var → /private/var) for consistent relative paths
      let realCandidate = candidate;
      try { realCandidate = realpathSync(candidate); } catch { /* use unresolved */ }
      paths.push(realCandidate);
    }
  }

  // Recursive walk of docs/ if it exists
  const docsDir = join(resolvedDir, 'docs');
  if (existsSync(docsDir)) {
    // Resolve docsDir canonically so the containment guard matches realpathSync results
    let realDocsDir = docsDir;
    try { realDocsDir = realpathSync(docsDir); } catch { /* skip */ }
    walkDocDir(realDocsDir, resolvedDir, paths);
  }

  return paths.sort();
}

/**
 * Recursively walk a directory collecting .md file paths.
 * Skips symlinks that resolve outside the resolved project boundary (T-31-PATH).
 */
function walkDocDir(dirPath: string, resolvedProjectDir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dirPath).sort();
  } catch {
    return; // not readable — skip gracefully
  }

  for (const entry of entries) {
    const candidatePath = join(dirPath, entry);

    // T-31-PATH: realpathSync resolves symlinks; verify the resolved path stays
    // inside the project boundary (prevents symlink escape out of tree).
    let realPath: string;
    try {
      realPath = realpathSync(candidatePath);
    } catch {
      continue; // broken symlink or inaccessible — skip
    }

    // Containment: must be strictly inside resolvedProjectDir
    if (!realPath.startsWith(resolvedProjectDir + sep) &&
        realPath !== resolvedProjectDir) {
      continue; // symlink escape — skip (T-31-PATH)
    }

    let stat: import('fs').Stats;
    try {
      stat = statSync(realPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      walkDocDir(realPath, resolvedProjectDir, out);
    } else if (entry.endsWith('.md')) {
      out.push(realPath);
    }
  }
}

/** Return type for emitDocEpisodes. */
export interface DocEpisodeResult {
  /** Number of doc files processed. */
  docCount: number;
  /** Total episodes emitted (0 on dryRun). */
  episodeCount: number;
}

/**
 * Walk a project's own documentation files and emit one episode per chunk.
 *
 * For each file from collectDocPaths(opts.dir):
 *  - Reads content (skips unreadable files).
 *  - Chunks via chunkNote (D-58 parity).
 *  - Per section: builds `[[title]]\n<section.text>`, applies redactSecrets (T-31-SECRET).
 *  - Calls pipeline.recordEvent with:
 *      origin='observed' (T-31-ORIGIN — NEVER 'asserted_by_user')
 *      source='project-doc'
 *      role='user'
 *      sessionId=`project-doc:<scope>:<relPath>`
 *      externalId=contentExternalId(relPath, redactedContent) — content-hash dedup key
 *      cwd=opts.cwd
 *
 * dryRun=true: increments counters but NEVER calls pipeline.recordEvent (T-30-05 parity).
 *
 * relPath uses forward slashes even on Windows for cross-platform stability of the
 * content-hash key (gotcha 7 from the plan).
 */
export async function emitDocEpisodes(opts: {
  dir: string;
  scope: string;
  cwd: string;
  pipeline: Pick<IngestionPipeline, 'recordEvent'>;
  dryRun: boolean;
}): Promise<DocEpisodeResult> {
  const { dir, scope, cwd, pipeline, dryRun } = opts;
  const resolvedDir = resolve(dir);

  const docPaths = collectDocPaths(dir);
  // Use the canonical resolved dir (same as collectDocPaths uses) for relative path computation
  let canonicalResolvedDir: string;
  try {
    canonicalResolvedDir = realpathSync(resolve(dir));
  } catch {
    canonicalResolvedDir = resolve(dir);
  }
  let episodeCount = 0;

  for (const filePath of docPaths) {
    // Compute relPath relative to the resolved project dir
    const rawRelPath = relative(canonicalResolvedDir, filePath);
    // Normalize to forward slashes for cross-platform stable hashing (gotcha 7)
    const relPath = rawRelPath.split(sep).join('/');

    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      fileLog(`doc-skip: unreadable file=${filePath}`);
      continue;
    }

    const title = noteTitle(relPath);
    const sections = chunkNote(content, DEFAULT_CONFIG.maxContentBytes);
    let fileSectionCount = 0;

    for (const section of sections) {
      const rawContent = `[[${title}]]\n${section.text}`;
      // T-31-SECRET: redact before the content lands on the record AND before hashing
      const redacted = redactSecrets(rawContent);

      if (!dryRun) {
        pipeline.recordEvent({
          content: redacted,
          role: 'user',
          origin: 'observed', // T-31-ORIGIN: NEVER 'asserted_by_user'
          sessionId: `project-doc:${scope}:${relPath}`,
          source: 'project-doc',
          // T-31-SECRET: externalId computed from POST-redaction content
          externalId: contentExternalId(relPath, redacted),
          cwd,
        });
      }

      episodeCount++;
      fileSectionCount++;
    }

    fileLog(`doc-emit: relPath=${relPath} sections=${fileSectionCount} dryRun=${dryRun}`);
  }

  return { docCount: docPaths.length, episodeCount };
}

// ── main() ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Carry the headless timeout bump — surveys take ~90-100s/area (spike data)
  if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
    process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
  }

  const argv = process.argv.slice(2); // slice off node + script
  const args = parseIngestArgs(argv);

  // ── Validate <dir> BEFORE acquiring the lock (WR-02) ─────────────────────────
  if (!args.dir) {
    process.stderr.write('Usage: recense ingest-project <dir> [--dry-run] [--consolidate] [--force] [--db <path>] [--scope <slug>] [--desc <text>]\n');
    process.exit(1);
  }
  if (!existsSync(args.dir)) {
    process.stderr.write(`ingest-project: directory not found: ${args.dir}\n`);
    process.exit(1);
  }

  // ── OPENAI_API_KEY pre-flight (only when --consolidate) ───────────────────────
  try {
    checkOpenAiKeyIfConsolidate(args.consolidate, process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // ── Resolve scope + cwd ───────────────────────────────────────────────────────
  const scope = resolveSurveyScope({ dir: args.dir, scope: args.scope });
  const repoDesc = await deriveRepoDesc(args.dir, args.desc);

  // ── Print resolved scope + target DB BEFORE any write (D-09, D-04) ──────────
  const dbPath = resolveTargetDb(argv);
  process.stdout.write(`recense ingest-project\n`);
  process.stdout.write(`  dir:     ${args.dir}\n`);
  process.stdout.write(`  scope:   ${scope}\n`);
  process.stdout.write(`  db:      ${dbPath}\n`);
  process.stdout.write(`  desc:    ${repoDesc}\n`);
  process.stdout.write(`  dry-run: ${args.dryRun}\n`);
  process.stdout.write(`\n`);

  if (args.dryRun) {
    process.stdout.write(`DRY RUN — survey running (transport called), writing ZERO rows\n\n`);
  }

  fileLog(`start: dir=${args.dir} scope=${scope} db=${dbPath} dryRun=${args.dryRun} consolidate=${args.consolidate}`);

  // ── Build the survey transport ────────────────────────────────────────────────
  const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath, dirtySentinelPath: resolveDirtySentinelPath() };
  const judgeConfig: EngineConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };

  const surveyAreaFn = async (area: string, repoDir: string, repoDescStr: string): Promise<string> => {
    const { client, model } = createClaudeHeadlessSurveyClient(judgeConfig, repoDir);
    const prompt = buildSurveyPrompt(area as SurveyArea, { repoDir, repoDesc: repoDescStr });
    fileLog(`survey: area=${area} model=${model}`);
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const block = response.content[0] as { text?: string } | undefined;
    return (block?.text ?? '').trim();
  };

  if (args.dryRun) {
    // Dry-run: run doc walk + survey, print counts, write nothing
    const dummyPipeline = { recordEvent: () => { /* never called in dryRun */ } };

    // Emit doc episodes first (deterministic, cheap) — dryRun=true → no writes
    const docResult = await emitDocEpisodes({
      dir: args.dir,
      scope,
      cwd: resolveSurveyCwd({ dir: args.dir, scope: args.scope }),
      pipeline: dummyPipeline as unknown as IngestionPipeline,
      dryRun: true,
    });
    process.stdout.write(`  docs: ${docResult.episodeCount} would-be episodes from ${docResult.docCount} docs\n`);
    fileLog(`dry-run: docs docCount=${docResult.docCount} episodeCount=${docResult.episodeCount}`);

    const result = await runSurveyAndFeed({
      dir: args.dir,
      scope,
      repoDesc,
      pipeline: dummyPipeline as unknown as IngestionPipeline,
      surveyArea: surveyAreaFn,
      dryRun: true,
    });
    const total = Object.values(result.perAreaCounts).reduce((a, b) => a + b, 0);
    process.stdout.write(`\ndry-run complete: ${total} would-be episodes across ${SURVEY_AREAS.length} areas\n`);
    if (result.skippedAreas.length > 0) {
      process.stdout.write(`skipped areas (refusal): ${result.skippedAreas.join(', ')}\n`);
    }
    return;
  }

  // ── Real run ──────────────────────────────────────────────────────────────────
  if (args.consolidate) {
    // --consolidate: acquire lock, feed, run inline consolidation, release (D-02)
    if (!acquireLock()) {
      process.stderr.write('Lock held by another process — exiting\n');
      process.exit(0);
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      initSchema(db);
      const episodes = new EpisodicStore(db, realClock, config);
      const pipeline = new IngestionPipeline(new AllocationGate(config), episodes);

      // ── Cursor skip-gate (REINGEST-02 / T-31-CURSOR) ──────────────────────────
      // MUST use SemanticStore — NOT EpisodicStore (T-31-CURSOR: EpisodicStore
      // silently disables cursors). Instantiate from the SAME db handle.
      const semanticStore = new SemanticStore(db, realClock, config);
      const docPaths = collectDocPaths(args.dir);
      const fingerprint = computeProjectFingerprint(args.dir, docPaths);
      const stored = semanticStore.getMeta(`cursor:project:${scope}`);
      const surveySkipped = !args.force && stored !== null && stored === fingerprint;

      // Emit doc episodes BEFORE the survey (deterministic, independent of cursor — D-06)
      const docResult = await emitDocEpisodes({
        dir: args.dir,
        scope,
        cwd: resolveSurveyCwd({ dir: args.dir, scope: args.scope }),
        pipeline,
        dryRun: false,
      });
      process.stdout.write(`  docs: ${docResult.episodeCount} doc episodes from ${docResult.docCount} docs\n`);
      fileLog(`consolidate: docs docCount=${docResult.docCount} episodeCount=${docResult.episodeCount}`);

      let total = 0;
      let skippedAreas: string[] = [];
      if (surveySkipped) {
        process.stdout.write(`  survey skipped (unchanged) — fingerprint matches cursor\n`);
        fileLog(`consolidate: survey skipped fingerprint=${fingerprint}`);
      } else {
        const result = await runSurveyAndFeed({
          dir: args.dir,
          scope,
          repoDesc,
          pipeline,
          surveyArea: surveyAreaFn,
          dryRun: false,
        });
        total = result.totalFed;
        skippedAreas = result.skippedAreas;
        // Commit cursor AFTER survey succeeds, BEFORE consolidation (A3: cursor not gated on consolidation)
        semanticStore.setMeta(`cursor:project:${scope}`, fingerprint);
        fileLog(`consolidate: cursor committed fingerprint=${fingerprint}`);
      }

      fileLog(`consolidation: starting inline sleep pass`);
      await runConsolidation(db, dbPath, process.env, fileLog);
      fileLog('consolidation: complete');

      process.stdout.write(`\ningest-project complete: ${total} episodes fed, consolidation done${surveySkipped ? ' (survey skipped)' : ''}\n`);
      if (skippedAreas.length > 0) {
        process.stdout.write(`skipped areas (refusal): ${skippedAreas.join(', ')}\n`);
      }
      fileLog(`done: totalFed=${total} skipped=${skippedAreas.join(',')}`);
    } catch (err) {
      fileLog(`error: ${err}`);
      process.stderr.write(`ingest-project FAILED: ${err}\nSee ${LOG_PATH}\n`);
      process.exitCode = 1;
    } finally {
      db?.close();
      releaseLock();
    }
  } else {
    // Default path: feed episodes and defer consolidation to the scheduled sleep pass.
    // NO LOCK is held — the dirtySentinelPath in config makes EpisodicStore.append
    // touch the sentinel on each observed insert, which triggers the launchd watcher (D-01).
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      initSchema(db);
      const episodes = new EpisodicStore(db, realClock, config);
      const pipeline = new IngestionPipeline(new AllocationGate(config), episodes);

      // ── Cursor skip-gate (REINGEST-02 / T-31-CURSOR) ──────────────────────────
      // MUST use SemanticStore — NOT EpisodicStore (T-31-CURSOR: EpisodicStore
      // silently disables cursors). Instantiate from the SAME db handle.
      const semanticStore = new SemanticStore(db, realClock, config);
      const docPaths = collectDocPaths(args.dir);
      const fingerprint = computeProjectFingerprint(args.dir, docPaths);
      const stored = semanticStore.getMeta(`cursor:project:${scope}`);
      const surveySkipped = !args.force && stored !== null && stored === fingerprint;

      // Emit doc episodes BEFORE the survey (deterministic, independent of cursor — D-06)
      const docResult = await emitDocEpisodes({
        dir: args.dir,
        scope,
        cwd: resolveSurveyCwd({ dir: args.dir, scope: args.scope }),
        pipeline,
        dryRun: false,
      });
      process.stdout.write(`  docs: ${docResult.episodeCount} doc episodes from ${docResult.docCount} docs\n`);
      fileLog(`default: docs docCount=${docResult.docCount} episodeCount=${docResult.episodeCount}`);

      let total = 0;
      let skippedAreas: string[] = [];
      if (surveySkipped) {
        process.stdout.write(`  survey skipped (unchanged) — fingerprint matches cursor\n`);
        fileLog(`default: survey skipped fingerprint=${fingerprint}`);
      } else {
        const result = await runSurveyAndFeed({
          dir: args.dir,
          scope,
          repoDesc,
          pipeline,
          surveyArea: surveyAreaFn,
          dryRun: false,
        });
        total = result.totalFed;
        skippedAreas = result.skippedAreas;
        // Commit cursor AFTER survey succeeds (deferred commit, RQ3); not on dry-run (N/A here — dry-run returned early)
        semanticStore.setMeta(`cursor:project:${scope}`, fingerprint);
        fileLog(`default: cursor committed fingerprint=${fingerprint}`);
      }

      process.stdout.write(`\ningest-project complete: ${total} episodes fed${surveySkipped ? ' (survey skipped)' : ''}\n`);
      if (!surveySkipped) {
        process.stdout.write(`Consolidation deferred to the scheduled sleep pass.\n`);
      }
      if (skippedAreas.length > 0) {
        process.stdout.write(`skipped areas (refusal): ${skippedAreas.join(', ')}\n`);
      }
      fileLog(`done: totalFed=${total} skipped=${skippedAreas.join(',')}`);
    } catch (err) {
      fileLog(`error: ${err}`);
      process.stderr.write(`ingest-project FAILED: ${err}\nSee ${LOG_PATH}\n`);
      process.exitCode = 1;
    } finally {
      db?.close();
      // Note: NO releaseLock() here — the default path never acquires a lock (D-01)
    }
  }
}

// Only run when invoked as the entry point (dispatched via recense.ts subprocess),
// NOT when imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ingest-project FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
