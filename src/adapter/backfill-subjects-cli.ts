/**
 * backfill-subjects-cli — recense backfill-subjects [--db <path>] [--scopes <csv>]
 *
 * Force re-promotes subjects for one or more project scopes, bypassing the Stage-1 exhaust
 * gate (createGateOpen / refreshGateOpen). Used to retroactively populate subject-schema-ids
 * on a live brain where all subjects currently have `subject-schema-ids = []` because the
 * original promoteSubjects showed the LLM schema LABELS but asked for UUID IDs back.
 *
 * Design invariants:
 *  WR-02  Validate DB path BEFORE acquireLock — process.exit() with the lock held leaks it.
 *  T-25-07  Lock released in finally on every path (the shared write-lock pattern).
 *  D-43 self-confirmation guard: writes ONLY type='doc' nodes + doc→doc edges (inherited
 *       from SubjectPromoter).
 *  T-02-ASYNC  Phase C inside SubjectPromoter is a single IMMEDIATE transaction with no
 *              await inside — no nested transactions from the CLI layer.
 *  D-12  All time reads via realClock.nowMs() — never Date.now() directly.
 *  require.main guard: importing this module never auto-runs main() (test isolation).
 *
 * Entry point: dispatched by recense.ts via spawnScript('backfill-subjects-cli.js', ...).
 *
 * CLI usage:
 *   recense backfill-subjects [--db <path>] [--scopes <comma-separated-scopes>]
 *
 * Output: JSON to stdout:
 *   { scopes: [{ scope, created, refreshQueued, proposed: [{name, schemaIdCount}] }] }
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { SubjectPromoter } from '../consolidation/corpus-promoter';
import { DefaultModelProvider } from '../model/provider';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

const LOG_PATH = '/tmp/recense-backfill-subjects.log';

const DEFAULT_SCOPES = ['brain-memory', 'vtx', 'tonos'];

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] backfill-subjects: ${msg}\n`);

async function main(): Promise<void> {
  const argv = process.argv;

  // ── 1. Parse --scopes <csv> ───────────────────────────────────────────────
  const scopesIdx = argv.indexOf('--scopes');
  const scopesRaw = scopesIdx !== -1 ? (argv[scopesIdx + 1] ?? '') : '';
  const scopes = scopesRaw
    ? scopesRaw.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_SCOPES;

  // ── 2. Validate DB path BEFORE acquiring lock (WR-02) ─────────────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense backfill-subjects: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // ── 3. Acquire the shared write lock (T-25-08) ────────────────────────────
  if (!acquireLock()) {
    process.stderr.write('recense backfill-subjects: Lock held by another process — exiting\n');
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog(`starting: dbPath=${dbPath} scopes=${scopes.join(',')}`);

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);

    const config = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);

    // ── 4. Construct judge provider (mirrors run-sleep-pass.ts L420+L457) ────
    // Judge-tier provider: resolveProviderOverlay uses RECENSE_JUDGE_PROVIDER env var
    // to select provider; falls back to DEFAULT_CONFIG.modelProvider (claude-headless).
    const judgeConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };

    const provider = new DefaultModelProvider({
      generateConfig: judgeConfig,
      judgeConfig,
      embedConfig: config,
    });

    // ── 5. Construct SubjectPromoter (same driftThreshold as run-sleep-pass.ts L502) ──
    const subjectPromoter = new SubjectPromoter(db, store, realClock, provider, {
      corpusSubjectDriftThreshold: 3,
    });

    // ── 6. Force re-promote each scope ────────────────────────────────────────
    interface ScopeResult {
      scope: string;
      created: number;
      refreshQueued: number;
      proposed: Array<{ name: string; schemaIdCount: number }>;
    }

    const scopeResults: ScopeResult[] = [];

    for (const scope of scopes) {
      fileLog(`promoting scope: ${scope}`);
      const r = await subjectPromoter.promoteSubjects(scope, { force: true });
      scopeResults.push({
        scope,
        created: r.created,
        refreshQueued: r.refreshQueued.length,
        proposed: r.proposed.map(p => ({ name: p.name, schemaIdCount: p.relatedSchemaIds.length })),
      });
      fileLog(
        `scope ${scope}: created=${r.created} refreshQueued=${r.refreshQueued.length} ` +
        `proposed=${r.proposed.length}`,
      );
    }

    fileLog('done');

    // ── 7. Emit result JSON ────────────────────────────────────────────────
    process.stdout.write(
      JSON.stringify({ scopes: scopeResults }) + '\n',
    );
  } catch (err) {
    fileLog(`error: ${err}`);
    process.stderr.write(`recense backfill-subjects: ${err}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (dispatched via recense.ts subprocess),
// NOT when imported by a unit test or when require()-d without being main.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] backfill-subjects FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
