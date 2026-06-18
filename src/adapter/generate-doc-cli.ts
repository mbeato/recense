/**
 * generate-doc-cli — recense generate-doc <slug> (Phase 27, Plan 27-02).
 *
 * Write-capable, lock-guarded CLI that runs the doc-generation pipeline for a project slug:
 *   1. Gather facts (scope ∪ semantic ∪ entity-hop, D-01)
 *   2. Generate a cited markdown deep-dive via the judge-tier model (D-04)
 *   3. Write the result as a lifecycle-exempt type='doc' node via writeDoc (single-writer)
 *   4. Emit a JSON line {nodeId, slug, generated_at, citationCount, invented, tombstoned}
 *
 * Design invariants:
 *  D-02  Idempotent by default: if a doc node already exists for the slug, exit with the
 *        existing node data (no LLM call). Use --force to regenerate.
 *  D-04  Generation uses the judge-tier EngineConfig as the generate head (no new docModel var).
 *  D-06  One generate call per invocation (maxTokens 4000); low-volume lazy posture.
 *  T-27-06  DoS guard: idempotent by default, single generate call, no auto-batch.
 *  T-27-07  All writes through SemanticStore + writeDoc (single-writer invariant).
 *  WR-02  Validate DB path BEFORE acquireLock — process.exit() with the lock held leaks it.
 *  T-25-07  Lock released in finally on every path (the shared write-lock pattern).
 *  require.main guard: importing this module never auto-runs main() (test isolation).
 *
 * Entry point: dispatched by recense.ts via spawnScript('generate-doc-cli.js', ...).
 *
 * CLI usage:
 *   recense generate-doc <slug> [--db <path>] [--force]
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { DefaultModelProvider } from '../model/provider';
import { generateDoc } from '../reader/doc-generator';
import { writeDoc } from '../consolidation/doc-writer';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';

const LOG_PATH = '/tmp/recense-generate-doc.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] generate-doc: ${msg}\n`);

async function main(): Promise<void> {
  const argv = process.argv;

  // ── 1. Parse args ─────────────────────────────────────────────────────────
  // slug is the first positional arg after the command (argv[3] from recense.ts perspective,
  // but when spawned as a child process argv[2] is the first user arg).
  // argv[0]=node, argv[1]=generate-doc-cli.js, argv[2]=<slug>, argv[3..]=flags
  const slug = argv[2] ?? '';
  const isForce = argv.includes('--force');

  if (!slug || slug.startsWith('--')) {
    process.stderr.write('recense generate-doc: usage: recense generate-doc <slug> [--db <path>] [--force]\n');
    process.exit(1);
  }

  // ── 2. Validate DB path BEFORE acquiring lock (WR-02) ─────────────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense generate-doc: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // ── 3. Acquire the shared write lock (T-25-08 / T-27-07) ─────────────────
  if (!acquireLock()) {
    process.stderr.write('recense generate-doc: Lock held by another process — exiting\n');
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog(`starting: slug=${slug} force=${isForce}`);

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);

    const config = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);

    // ── 4. Idempotency: check for existing doc node (D-02 lazy-gen) ──────────
    if (!isForce) {
      const existingDoc = db.prepare(
        `SELECT n.id, nd.generated_at
         FROM node n
         JOIN node_doc nd ON nd.node_id = n.id
         JOIN node_scope ns ON ns.node_id = n.id
         WHERE n.type = 'doc' AND n.tombstoned = 0 AND ns.scope = ?
         LIMIT 1`,
      ).get(slug) as { id: string; generated_at: number } | undefined;

      if (existingDoc) {
        fileLog(`doc already exists for slug=${slug} nodeId=${existingDoc.id} — skipping (use --force to regen)`);
        process.stdout.write(
          JSON.stringify({
            nodeId: existingDoc.id,
            slug,
            generated_at: existingDoc.generated_at,
            citationCount: null,
            invented: null,
            tombstoned: null,
            cached: true,
          }) + '\n',
        );
        return;
      }
    }

    // ── 5. Build the judge-tier provider (D-04 — generateConfig = judgeConfig) ─
    // Doc-gen produces ~4000 tokens of cited prose — far slower than the small judge
    // calls the shared headless client's 120s default was tuned for. A run that crosses
    // 120s gets SIGKILL'd and the headless client returns EMPTY content (its production
    // fail-safe), which would silently persist as an empty "successful" doc. Raise the
    // doc-gen timeout to 600s (~10min headroom) when unset; env-overridable. Scoped to
    // this CLI only — the shared client's empty-on-failure fail-safe is unchanged (the
    // always-on sleep pass relies on it). Matches the sleep-pass slowness precedent.
    if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
      process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
    }

    // The judge-tier config is the strong-model slot in any env — no new docModel var.
    const judgeConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };
    const embedConfig = config; // embedding uses base config (same pattern as sleep-pass)
    const provider = new DefaultModelProvider({
      generateConfig: judgeConfig,   // D-04: judge-tier is the generate head
      judgeConfig,
      embedConfig,
    });

    fileLog(`generating: slug=${slug} provider=${judgeConfig.modelProvider}`);

    // ── 6. Generate ───────────────────────────────────────────────────────────
    const genResult = await generateDoc({ db, store, provider }, slug);

    fileLog(
      `generated: citations=${genResult.citationCount} invented=${genResult.invented} tombstoned=${genResult.tombstoned}`,
    );

    // ── 7. Write ──────────────────────────────────────────────────────────────
    // All writes through the single-writer path (T-27-07).
    const now = realClock.nowMs();
    writeDoc(store, db, {
      docId: genResult.docId,
      slug,
      markdown: genResult.markdown,
      citedFactIds: genResult.citedFactIds,
      now,
    });

    fileLog(`written: nodeId=${genResult.docId}`);

    // ── 8. Emit result JSON ───────────────────────────────────────────────────
    process.stdout.write(
      JSON.stringify({
        nodeId: genResult.docId,
        slug,
        generated_at: now,
        citationCount: genResult.citationCount,
        invented: genResult.invented,
        tombstoned: genResult.tombstoned,
        cached: false,
      }) + '\n',
    );
  } catch (err) {
    fileLog(`error: ${err}`);
    process.stderr.write(`recense generate-doc: ${err}\n`);
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
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] generate-doc FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
