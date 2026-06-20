/**
 * import-memory-cli — recense import-memory (Plan 999.3-02, D-S4 / D-S5).
 *
 * A REPEATABLE, idempotent importer that migrates the per-project
 * `~/.claude/projects/*\/memory/*.md` recall-facts into recense via the EXISTING
 * ingestion pipeline (D-S4: no new ingestion engine). Normal consolidation then
 * assigns provenance scope per D-S3 from each episode's mapped cwd.
 *
 * Design invariants:
 *  - REUSES IngestionPipeline.recordEvent — one episode per fact file, source
 *    'memory-import', cwd = the source project's path, external_id =
 *    `memory-import:<project>:<filename>` (stable → (source, external_id) dedup
 *    makes re-runs idempotent; D-59 backstop).
 *  - SKIPS the load-bearing policy bundles and MEMORY.md index files (D-S5) — those
 *    stay deterministic config; retrieval is probabilistic and must never risk
 *    dropping a load-bearing rule. ALSO skips live mutable TRACKER files
 *    (quick-260617-w0u) — append-logs that skills rewrite each session, so a snapshot
 *    would freeze a stale count as a fact.
 *  - NOT one-shot — NO `seeded` meta flag. Safe to re-run any time.
 *  - NEVER deletes or modifies a source file. Retirement is a separate, human-gated
 *    step (D-S7, Task 3 / docs/import-memory.md).
 *  - --dry-run reads & prints the import/skip plan and writes NOTHING (no lock, no
 *    DB open, no episodes).
 *  - Arg validation BEFORE acquireLock (WR-02 lock-leak prevention); lock released
 *    in finally on every path.
 *
 * Operator notes (see docs/import-memory.md):
 *  - Run with adapters disabled (RECENSE_ENABLED_SOURCES=) then trigger a manual
 *    sleep-pass so the imported episodes consolidate + get scope.
 */
import { appendFileSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { AllocationGate, IngestionPipeline } from '../ingest/pipeline';
import { cwdToScope } from '../lib/scope';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

const LOG_PATH = '/tmp/recense-import-memory.log';

/** Source channel tag for every imported episode (D-S4). */
export const IMPORT_SOURCE = 'memory-import';

/**
 * Load-bearing policy bundles that must NOT be imported as probabilistic memory
 * (D-S5). Matched by filename basename WITHOUT the .md extension.
 */
export const POLICY_BUNDLES = new Set<string>([
  'voice_profile',
  'feedback_no_inflated_metrics',
  'feedback_drop_concentrations',
  'outreach_framework',
  'user_job_search_strategy',
  'reference_linkedin_playbook',
  'user_profile',
]);

/**
 * Live, mutable TRACKER files that must NOT be imported as facts (quick-260617-w0u).
 * These are append-log state files that skills (leetcode-drill/-summary, interview-drill)
 * and the session-stop-vault-update hook read AND rewrite every session — importing a
 * snapshot freezes a stale point-in-time count as a "fact". Distinct skip category from
 * POLICY_BUNDLES so the dry-run's "7 policy bundles" gate baseline stays meaningful.
 * Matched by filename basename WITHOUT the .md extension.
 */
export const TRACKER_FILES = new Set<string>([
  'interview_readiness_tracker',
  'leetcode_practice_tracker',
]);

/** Why a scanned file was excluded from import. */
export type SkipReason = 'policy-bundle' | 'memory-index' | 'tracker';

/** One scanned fact file and the decision made about it. */
export interface ImportPlanItem {
  filePath: string;
  filename: string;
  /** Project slug derived from the folder name (basename of the mapped cwd). */
  project: string;
  /** Mapped working directory so consolidation derives scope per D-S3. */
  cwd: string;
  /** Provenance scope `cwdToScope(cwd)` would assign. */
  scope: string;
  /** Stable per-file dedup key for idempotent re-runs. */
  externalId: string;
  action: 'import' | 'skip';
  skipReason?: SkipReason;
}

/** Counts returned by a real import run. */
export interface ImportCounts {
  imported: number;
  skippedPolicy: number;
  skippedIndex: number;
  skippedTracker: number;
}

/**
 * Decide whether a memory file is on the skiplist (D-S5).
 * MEMORY.md index → 'memory-index'; a policy bundle → 'policy-bundle'; else undefined.
 */
export function skipReasonFor(filename: string): SkipReason | undefined {
  // Case-insensitive: skiplist matching must not depend on filename casing
  // (POLICY_BUNDLES / TRACKER_FILES stems are lowercase; index files are conventionally MEMORY.md).
  if (filename.toLowerCase() === 'memory.md') return 'memory-index';
  const stem = filename.replace(/\.md$/i, '').toLowerCase();
  if (POLICY_BUNDLES.has(stem)) return 'policy-bundle';
  if (TRACKER_FILES.has(stem)) return 'tracker';
  return undefined;
}

/**
 * Map a Claude-projects folder name to the source project's cwd (D-S4 / CONTEXT).
 *
 * Folder format: `-Users-<user>-<slug>` (path separators encoded as dashes).
 * The slug capture is greedy so project slugs that themselves contain dashes are
 * preserved (e.g. `-Users-vtx-brain-memory` → `/Users/vtx/brain-memory`).
 * Returns '' for anything that is not a `-Users|home-<user>-<slug>` folder.
 */
export function folderToCwd(folder: string): string {
  const m = /^-(Users|home)-([^-]+)-(.+)$/.exec(folder);
  if (!m) return '';
  const [, root, user, slug] = m;
  return `/${root}/${user}/${slug}`;
}

/** Default scan root: the Claude Code projects directory. */
export function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** True if `p` exists and is a directory (fail-safe: false on any stat error). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan `<baseDir>/*\/memory/*.md` and build the full import/skip plan (D-S4 / D-S5).
 *
 * PURE w.r.t. the DB: reads the filesystem only (no writes, no DB, no lock) so it
 * powers --dry-run safely and is the single source of truth for what a real run does.
 *
 * @param baseDir  Claude-projects root (folders named `-Users-<user>-<slug>`).
 * @param opts.project  Limit to a single project slug (matched against the folder slug).
 */
export function planImport(
  baseDir: string,
  opts: { project?: string } = {},
): ImportPlanItem[] {
  const plan: ImportPlanItem[] = [];
  if (!isDir(baseDir)) return plan;

  for (const folder of readdirSync(baseDir).sort()) {
    const cwd = folderToCwd(folder);
    if (!cwd) continue; // not a -Users-<user>-<slug> project folder
    const project = basename(cwd);
    if (opts.project && project !== opts.project) continue;

    const memDir = join(baseDir, folder, 'memory');
    if (!isDir(memDir)) continue;

    const scope = cwdToScope(cwd);

    for (const filename of readdirSync(memDir).sort()) {
      if (!filename.toLowerCase().endsWith('.md')) continue;
      const filePath = join(memDir, filename);
      if (isDir(filePath)) continue; // skip nested dirs named *.md
      const reason = skipReasonFor(filename);
      plan.push({
        filePath,
        filename,
        project,
        cwd,
        scope,
        externalId: `${IMPORT_SOURCE}:${project}:${filename}`,
        action: reason ? 'skip' : 'import',
        ...(reason ? { skipReason: reason } : {}),
      });
    }
  }
  return plan;
}

/**
 * Execute the import-action items in a plan via IngestionPipeline.recordEvent (D-S4).
 *
 * Reads each fact file's body and appends ONE episode with source='memory-import',
 * the mapped cwd (so consolidation derives scope), and the stable external_id. The
 * (source, external_id) dedup backstop (D-59) makes re-runs idempotent — a second
 * run over unchanged files lands zero new rows.
 *
 * NEVER deletes or modifies a source file. Skipped items are only counted.
 */
export function runImport(
  plan: ImportPlanItem[],
  pipeline: IngestionPipeline,
  log: (msg: string) => void,
): ImportCounts {
  const counts: ImportCounts = { imported: 0, skippedPolicy: 0, skippedIndex: 0, skippedTracker: 0 };
  for (const item of plan) {
    if (item.action === 'skip') {
      if (item.skipReason === 'policy-bundle') counts.skippedPolicy++;
      else if (item.skipReason === 'tracker') counts.skippedTracker++;
      else counts.skippedIndex++;
      continue;
    }
    const content = readFileSync(item.filePath, 'utf8');
    pipeline.recordEvent({
      content,
      role: 'user',
      origin: 'asserted_by_user',
      sessionId: `${IMPORT_SOURCE}:${item.project}`,
      source: IMPORT_SOURCE,
      externalId: item.externalId,
      cwd: item.cwd,
    });
    counts.imported++;
    log(`import: ${item.project} [${item.scope}] ${item.filename}`);
  }
  return counts;
}

/** Render the dry-run plan to stdout (operator-facing; this is not a hook). */
function printPlan(plan: ImportPlanItem[]): void {
  const imports = plan.filter(p => p.action === 'import');
  const skips = plan.filter(p => p.action === 'skip');
  process.stdout.write('recense import-memory — DRY RUN (nothing written)\n\n');
  for (const p of imports) {
    process.stdout.write(`  IMPORT  ${p.project} [${p.scope}]  ${p.filename}\n`);
  }
  for (const p of skips) {
    process.stdout.write(`  skip    ${p.project} (${p.skipReason})  ${p.filename}\n`);
  }
  const policy = skips.filter(s => s.skipReason === 'policy-bundle').length;
  const index = skips.filter(s => s.skipReason === 'memory-index').length;
  const tracker = skips.filter(s => s.skipReason === 'tracker').length;
  process.stdout.write(
    `\nplan: ${imports.length} to import, ${policy} policy-bundle skipped, ${index} index skipped, ${tracker} tracker skipped\n`,
  );
}

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] import-memory: ${msg}\n`);

/** Parse `--project <slug>` from argv; undefined if absent. */
function parseProject(argv: string[]): string | undefined {
  const i = argv.indexOf('--project');
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Resolve scan root from `--base <dir>` argv override or the default projects dir. */
function resolveBaseDir(argv: string[]): string {
  const i = argv.indexOf('--base');
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : defaultProjectsDir();
}

async function main(): Promise<void> {
  const argv = process.argv;
  const dryRun = argv.includes('--dry-run');
  const project = parseProject(argv);
  const baseDir = resolveBaseDir(argv);

  // ── Build the plan from the filesystem (no DB, no lock) ──────────────────────
  const plan = planImport(baseDir, project ? { project } : {});

  if (dryRun) {
    printPlan(plan);
    return;
  }

  // ── Real run: validate DB path BEFORE acquiring the lock (WR-02) ─────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write('No DB path (--db <path> or RECENSE_DB env var) — exiting\n');
    process.exit(0);
  }

  if (!acquireLock()) {
    process.stderr.write('Lock held by another process — exiting\n');
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath };
    const episodes = new EpisodicStore(db, realClock, config);
    const pipeline = new IngestionPipeline(new AllocationGate(config), episodes);

    const counts = runImport(plan, pipeline, fileLog);
    process.stdout.write(
      `imported ${counts.imported} fact file(s); skipped ${counts.skippedPolicy} policy + ${counts.skippedIndex} index + ${counts.skippedTracker} tracker.\n` +
        'Next: run `recense sleep-pass` (adapters disabled) so facts consolidate + get scope. See docs/import-memory.md.\n',
    );
    fileLog(
      `done: imported=${counts.imported} skippedPolicy=${counts.skippedPolicy} skippedIndex=${counts.skippedIndex} skippedTracker=${counts.skippedTracker}`,
    );
  } catch (err) {
    fileLog(`error: ${err}`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (dispatched via recense.ts subprocess),
// NOT when imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] import-memory FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
