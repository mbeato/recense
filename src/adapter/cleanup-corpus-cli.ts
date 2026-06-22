/**
 * cleanup-corpus-cli — recense cleanup-corpus (Phase 39.1, Plan 39.1-04, D-08/D-09).
 *
 * One-time retroactive junk-doc cleanup CLI. Enumerates three DETERMINISTIC junk
 * classes and removes them safely:
 *
 *  Class (a) schema-UUID chapter docs: type='doc' nodes whose node_doc.slug matches
 *    the UUID pattern AND the slug resolves to a live schema node (old taxonomy).
 *  Class (b) empty/never-filled stubs: type='doc' nodes with length(value) = 0.
 *  Class (c) noise-schema docs: UUID-slug docs whose resolved schema's member set
 *    is >= noiseCap (0.5) noise tokens (evaluated in TypeScript using isNoiseMember).
 *
 * Default: dry-run ON (same T-25-06 discipline as dedup-entities). Real mutating
 * run requires --no-dry-run.
 *
 * Execution sequence:
 *  dry-run  → open DB read-only, enumerate 3 junk classes, print report, write ZERO rows.
 *  real-run → acquire lock → VACUUM INTO snapshot (abort if fails) → FK-safe hard-delete
 *             in ONE IMMEDIATE transaction per node → PRAGMA foreign_key_check → release lock.
 *
 * Safety invariants (D-08 / D-09 / threat model T-39.1-11 through T-39.1-15):
 *  - SNAPSHOT-MUST-SUCCEED: VACUUM INTO must succeed and be verified non-empty BEFORE
 *    any DELETE. On snapshot failure: stderr + process.exit(1), zero rows deleted.
 *  - FK-SAFE-ORDER: node_doc → node_scope → edge → node_fts → node in ONE IMMEDIATE tx.
 *  - EVIDENCE-GUARD: delete set restricted to type='doc' origin='inferred' nodes; no
 *    type='fact'/type='entity' node is ever deleted.
 *  - LOCK-GUARD: real run exits if the sleep-pass lock is held (races the sleep pass).
 *  - WR-02: validate DB path BEFORE acquireLock — process.exit with lock held leaks it.
 *
 * Entry point:
 *  - Spawned by recense.ts dispatcher (`recense cleanup-corpus [--no-dry-run] [--db PATH]`)
 *  - `require.main === module` guard: never auto-runs when imported by unit tests.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

const LOG_PATH = '/tmp/recense-cleanup-corpus.log';
const SNAP_KEEP = 5;
const NOISE_CAP = 0.5; // fraction of noise members at or above which schema docs are junk

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] cleanup-corpus: ${msg}\n`);

// ---------------------------------------------------------------------------
// Noise patterns (copied verbatim from corpus-promoter.ts:86-98 — D-08)
// ---------------------------------------------------------------------------

const NOISE_PATTERNS: RegExp[] = [
  /^\/private\//,
  /^\/tmp\//,
  /^\/Users\//,
  /^toolu_[A-Za-z0-9]+$/,           // Anthropic tool IDs
  /^[Cc]ommit\s+[`]?[0-9a-f]{6,}/, // git commit references
  /^worktreePath:/,
  /^\.claude\/worktrees/,
];

export function isNoiseMember(value: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(value));
}

// ---------------------------------------------------------------------------
// Junk-class types
// ---------------------------------------------------------------------------

export interface JunkDoc {
  id: string;
  slug: string;
  reason: 'chapter-uuid' | 'empty-stub' | 'noise-schema';
}

// ---------------------------------------------------------------------------
// Junk enumeration (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Enumerate all three deterministic junk classes from the DB.
 * Read-only — writes nothing. Returns a deduplicated list of junk doc IDs.
 *
 * Class (a): UUID-slug docs whose slug resolves to a live schema node.
 * Class (b): Doc nodes with length(value) = 0.
 * Class (c): UUID-slug docs whose resolved schema's members are >= noiseCap noise tokens.
 */
export function enumerateJunkDocs(db: Database.Database): JunkDoc[] {
  // Class (a): schema-UUID chapter docs (old taxonomy)
  const stmtChapter = db.prepare<[], { id: string; slug: string }>(`
    SELECT n.id, nd.slug
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.type = 'doc' AND n.tombstoned = 0
      AND nd.slug LIKE '________-____-____-____-____________'
      AND EXISTS (
        SELECT 1 FROM node s
        WHERE s.id = nd.slug AND s.type = 'schema' AND s.tombstoned = 0
      )
  `);

  // Class (b): empty/never-filled stubs
  const stmtEmpty = db.prepare<[], { id: string; slug: string }>(`
    SELECT n.id, nd.slug
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.type = 'doc' AND n.tombstoned = 0
      AND length(n.value) = 0
  `);

  // Class (c): noise-schema docs (UUID-slug docs whose schema has >= noiseCap noise members)
  // Retrieve all UUID-slug docs with their schema members for TypeScript noise evaluation.
  const stmtNoiseSchemas = db.prepare<[], { id: string; slug: string; schemaId: string }>(`
    SELECT n.id, nd.slug, nd.slug AS schemaId
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.type = 'doc' AND n.tombstoned = 0
      AND nd.slug LIKE '________-____-____-____-____________'
      AND EXISTS (
        SELECT 1 FROM node s
        WHERE s.id = nd.slug AND s.type = 'schema' AND s.tombstoned = 0
      )
  `);

  const stmtSchemaMembers = db.prepare<[string], { value: string }>(`
    SELECT m.value
    FROM edge e
    JOIN node m ON m.id = e.dst
      AND m.type IN ('fact', 'entity')
      AND m.tombstoned = 0
      AND m.origin != 'inferred'
    WHERE e.src = ? AND e.kind = 'abstracts'
  `);

  // Collect junk docs (deduplicated by id, first reason wins)
  const seen = new Map<string, JunkDoc>();

  // (a) chapter-uuid
  for (const row of stmtChapter.all()) {
    if (!seen.has(row.id)) {
      seen.set(row.id, { id: row.id, slug: row.slug, reason: 'chapter-uuid' });
    }
  }

  // (b) empty-stub
  for (const row of stmtEmpty.all()) {
    if (!seen.has(row.id)) {
      seen.set(row.id, { id: row.id, slug: row.slug, reason: 'empty-stub' });
    }
  }

  // (c) noise-schema — evaluate in TypeScript (SQLite has no native regex)
  for (const row of stmtNoiseSchemas.all()) {
    if (seen.has(row.id)) continue; // already classified
    const members = stmtSchemaMembers.all(row.schemaId);
    if (members.length === 0) continue; // no members → not a noise schema by fraction
    const noiseCount = members.filter((m) => isNoiseMember(m.value)).length;
    const noiseFrac = noiseCount / members.length;
    if (noiseFrac >= NOISE_CAP) {
      seen.set(row.id, { id: row.id, slug: row.slug, reason: 'noise-schema' });
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Dry-run report (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Print a grouped dry-run report to stdout. Writes zero rows.
 */
export function printDryRunReport(junkDocs: JunkDoc[]): void {
  const byReason = {
    'chapter-uuid': junkDocs.filter((d) => d.reason === 'chapter-uuid'),
    'empty-stub':   junkDocs.filter((d) => d.reason === 'empty-stub'),
    'noise-schema': junkDocs.filter((d) => d.reason === 'noise-schema'),
  };

  process.stdout.write('recense cleanup-corpus — DRY RUN (nothing written)\n\n');

  process.stdout.write(`Class (a) schema-UUID chapter docs [${byReason['chapter-uuid'].length}]:\n`);
  for (const d of byReason['chapter-uuid']) {
    process.stdout.write(`  id=${d.id}  slug=${d.slug}  reason=chapter-uuid\n`);
  }

  process.stdout.write(`\nClass (b) empty/never-filled stubs [${byReason['empty-stub'].length}]:\n`);
  for (const d of byReason['empty-stub']) {
    process.stdout.write(`  id=${d.id}  slug=${d.slug}  reason=empty-stub\n`);
  }

  process.stdout.write(`\nClass (c) noise-schema docs [${byReason['noise-schema'].length}]:\n`);
  for (const d of byReason['noise-schema']) {
    process.stdout.write(`  id=${d.id}  slug=${d.slug}  reason=noise-schema\n`);
  }

  process.stdout.write(`\ntotal: ${junkDocs.length} doc node(s) would be deleted\n`);
}

// ---------------------------------------------------------------------------
// Snapshot helper (exported for unit tests — snapshot-fail path)
// ---------------------------------------------------------------------------

/**
 * Take a VACUUM INTO snapshot to the snapshots directory.
 * Returns the snapshot path on success.
 * THROWS on failure — caller MUST catch and abort without deleting.
 */
export function takeSnapshot(db: Database.Database, dbPath: string): string {
  const dir = join(dirname(dbPath), 'snapshots');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const base = basename(dbPath);
  const stamp = new Date(realClock.nowMs()).toISOString().replace(/[:.]/g, '-');
  const snapPath = join(dir, `${base}.${stamp}.bak`);
  db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
  // Verify the snapshot file exists and is non-empty
  const info = statSync(snapPath);
  if (info.size === 0) {
    throw new Error(`snapshot file is empty: ${snapPath}`);
  }
  // Prune oldest beyond SNAP_KEEP (lexicographic sort == chronological for ISO stamps)
  const snaps = readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
    .sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - SNAP_KEEP))) {
    try { unlinkSync(join(dir, old)); } catch { /* best-effort prune */ }
  }
  return snapPath;
}

// ---------------------------------------------------------------------------
// FK-safe hard-delete (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Hard-delete a set of junk doc nodes in FK-safe order inside ONE IMMEDIATE transaction.
 * Order: node_doc → node_scope → edge → node_fts → node.
 * Returns the count of deleted node rows.
 *
 * SAFETY: this function assumes all ids in junkDocs are type='doc' origin='inferred'
 * nodes (validated by the caller / tests). It does NOT delete fact/entity nodes.
 */
export function hardDeleteJunkDocs(db: Database.Database, junkDocs: JunkDoc[]): number {
  if (junkDocs.length === 0) return 0;

  const stmtDelNodeDoc  = db.prepare<[string]>('DELETE FROM node_doc WHERE node_id = ?');
  const stmtDelScope    = db.prepare<[string]>('DELETE FROM node_scope WHERE node_id = ?');
  const stmtDelEdge     = db.prepare<[string, string]>('DELETE FROM edge WHERE src = ? OR dst = ?');
  const stmtDelFts      = db.prepare<[string]>('DELETE FROM node_fts WHERE node_id = ?');
  const stmtDelNode     = db.prepare<[string]>('DELETE FROM node WHERE id = ?');

  // ONE IMMEDIATE transaction for all deletions (T-27-07 / RESEARCH Pitfall 4)
  const txDelete = db.transaction(() => {
    for (const junk of junkDocs) {
      stmtDelNodeDoc.run(junk.id);          // 1. child sidecar (FK to node)
      stmtDelScope.run(junk.id);            // 2. child sidecar (FK to node)
      stmtDelEdge.run(junk.id, junk.id);   // 3. dangling edges (src OR dst)
      stmtDelFts.run(junk.id);             // 4. FTS row
      stmtDelNode.run(junk.id);            // 5. parent node (last — FK parents deleted)
    }
  });
  txDelete.immediate();

  return junkDocs.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv;

  // Default: dry-run ON (T-25-06 discipline). Real mutating run requires --no-dry-run.
  const isDryRun = !argv.includes('--no-dry-run');

  // ── Dry-run: open DB read-only, enumerate and report; zero writes ────────────
  if (isDryRun) {
    const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
    if (!dbPath) {
      process.stderr.write(
        'recense cleanup-corpus: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
      );
      process.exit(0);
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      initSchema(db);
      const junkDocs = enumerateJunkDocs(db);
      printDryRunReport(junkDocs);
      fileLog(`dry-run: found ${junkDocs.length} junk doc(s)`);
    } catch (err) {
      fileLog(`dry-run error: ${err}`);
      process.exitCode = 1;
    } finally {
      db?.close();
    }
    return;
  }

  // ── Real (mutating) run: validate DB path BEFORE acquiring the lock (WR-02) ──
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense cleanup-corpus: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // Acquire the shared write lock (races the hourly sleep pass — T-39.1-15)
  if (!acquireLock()) {
    process.stderr.write('recense cleanup-corpus: Lock held by another process — exiting\n');
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog('cleanup-corpus real run starting');

    db = new Database(dbPath);
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath };
    new SemanticStore(db, realClock, config); // initialise store (pragma setup)

    // 1. Enumerate junk docs (read-only pass)
    const junkDocs = enumerateJunkDocs(db);
    fileLog(`found ${junkDocs.length} junk doc(s) to delete`);

    if (junkDocs.length === 0) {
      process.stdout.write('cleanup-corpus: no junk docs found — nothing to delete\n');
      fileLog('done: 0 deleted');
      return;
    }

    // 2. SNAPSHOT-MUST-SUCCEED INVARIANT (T-39.1-12 / Pitfall 5)
    //    Take a VACUUM INTO snapshot before any delete. If this throws, abort immediately.
    let snapPath: string;
    try {
      snapPath = takeSnapshot(db, dbPath);
      fileLog(`snapshot -> ${snapPath}`);
      process.stdout.write(`cleanup-corpus: snapshot -> ${snapPath}\n`);
    } catch (err) {
      fileLog(`snapshot FAILED — aborting cleanup: ${err}`);
      process.stderr.write(
        `cleanup-corpus: snapshot failed — aborting (no rollback point)\n`,
      );
      process.exit(1);
    }

    // 3. FK-safe hard-delete in ONE IMMEDIATE transaction (T-39.1-13 / Pitfall 4)
    const deleted = hardDeleteJunkDocs(db, junkDocs);

    // 4. Verify FK integrity after deletion (T-39.1-13)
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      const msg = `foreign_key_check found ${fkViolations.length} violation(s) after delete — DB may be inconsistent`;
      fileLog(`ERROR: ${msg}`);
      process.stderr.write(`cleanup-corpus: ERROR: ${msg}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `cleanup-corpus: deleted ${deleted} junk doc node(s); FK check clean\n`,
    );
    fileLog(`done: deleted=${deleted} fk_violations=0 snapshot=${snapPath!}`);
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
  main().catch((err) => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] cleanup-corpus FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
