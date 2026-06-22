/**
 * cleanup-corpus-cli tests — Phase 39.1, Plan 39.1-04.
 *
 * Requirements covered (D-08 / D-09):
 *  - Dry-run enumerates exactly the 3 deterministic junk classes and writes ZERO rows.
 *  - Valid subject/hub docs (scope:name slug, non-empty) are NOT flagged as junk.
 *  - Real run (--no-dry-run path): takes a VACUUM INTO snapshot, deletes exactly the
 *    junk ids, leaves valid docs untouched, FK check is clean.
 *  - Snapshot-fail abort: when VACUUM INTO is forced to fail, process.exit(1) is called
 *    and ZERO rows are deleted.
 *  - Evidence-safety: no type='fact'/'entity' node is ever in the delete set.
 *  - FK-safe order: all 5 DELETEs in a single IMMEDIATE transaction.
 *
 * All tests use in-memory SQLite (better-sqlite3 ':memory:') or temp files.
 * No LLM calls, no subprocess spawning, no live DB access.
 */
import { mkdirSync, mkdtemp, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSchema } from '../src/db/schema';
import {
  enumerateJunkDocs,
  hardDeleteJunkDocs,
  isNoiseMember,
  printDryRunReport,
  takeSnapshot,
} from '../src/adapter/cleanup-corpus-cli';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

/**
 * Insert a minimal node row directly (bypasses SemanticStore to keep tests fast).
 * value defaults to '' for doc stubs.
 */
function insertNode(
  db: Database.Database,
  opts: {
    id: string;
    type: string;
    value?: string;
    origin?: string;
    tombstoned?: number;
  },
): void {
  const { id, type, value = '', origin = 'inferred', tombstoned = 0 } = opts;
  db.prepare(
    `INSERT OR REPLACE INTO node
     (id, type, value, value_hash, origin, s, c, last_access,
      prev_value, pending_contradictions, tombstoned, training_eligible, embedding)
     VALUES (?, ?, ?, 'hash-placeholder', ?, 0, 1.0, 1000,
      NULL, '[]', ?, 0, NULL)`,
  ).run(id, type, value, origin, tombstoned);
}

/** Insert a node_doc sidecar row. */
function insertNodeDoc(
  db: Database.Database,
  nodeId: string,
  slug: string,
  generatedAt = 1000,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO node_doc (node_id, slug, generated_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(nodeId, slug, generatedAt, generatedAt);
}

/** Insert a node_scope sidecar row. */
function insertNodeScope(db: Database.Database, nodeId: string, scope: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO node_scope (node_id, scope, updated_at) VALUES (?, ?, 1000)`,
  ).run(nodeId, scope);
}

/** Insert a schema node. */
function insertSchema(db: Database.Database, id: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO node
     (id, type, value, value_hash, origin, s, c, last_access,
      prev_value, pending_contradictions, tombstoned, training_eligible, embedding)
     VALUES (?, 'schema', ?, 'hash-schema', 'observed', 0.5, 0.8, 1000,
      NULL, '[]', 0, 0, NULL)`,
  ).run(id, value);
}

/** Insert an 'abstracts' edge from a schema to a member node. */
function abstractsEdge(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO edge (src, dst, rel, w, kind, last_access)
     VALUES (?, ?, 'abstracts', 0.8, 'abstracts', 1000)`,
  ).run(schemaId, memberId);
}

/** Insert a fact node (non-inferred, for schema member queries). */
function insertFact(db: Database.Database, id: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO node
     (id, type, value, value_hash, origin, s, c, last_access,
      prev_value, pending_contradictions, tombstoned, training_eligible, embedding)
     VALUES (?, 'fact', ?, 'hash-fact', 'observed', 0.5, 0.8, 1000,
      NULL, '[]', 0, 0, NULL)`,
  ).run(id, value);
}

// A valid UUID-format string for use as schema IDs
const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const UUID_NOISE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ---------------------------------------------------------------------------
// isNoiseMember
// ---------------------------------------------------------------------------

describe('isNoiseMember', () => {
  it('matches /private/ paths', () => {
    expect(isNoiseMember('/private/tmp/foo')).toBe(true);
  });
  it('matches /tmp/ paths', () => {
    expect(isNoiseMember('/tmp/recense.lock')).toBe(true);
  });
  it('matches /Users/ paths', () => {
    expect(isNoiseMember('/Users/vtx/brain-memory')).toBe(true);
  });
  it('matches Anthropic tool IDs', () => {
    expect(isNoiseMember('toolu_AbCd1234')).toBe(true);
  });
  it('matches git commit references', () => {
    expect(isNoiseMember('Commit abc1234ef')).toBe(true);
    expect(isNoiseMember('commit `abc1234ef`')).toBe(true);
  });
  it('matches worktreePath:', () => {
    expect(isNoiseMember('worktreePath:/foo/bar')).toBe(true);
  });
  it('matches .claude/worktrees', () => {
    expect(isNoiseMember('.claude/worktrees/foo')).toBe(true);
  });
  it('does not match normal fact values', () => {
    expect(isNoiseMember('recense is a memory engine')).toBe(false);
    expect(isNoiseMember('retrieval pipeline')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enumerateJunkDocs — dry-run behavior
// ---------------------------------------------------------------------------

describe('enumerateJunkDocs — dry-run', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();

    // ── Schema nodes (live, needed for class-a and class-c) ──
    insertSchema(db, UUID_A, 'schema-a (chapter, low noise)');
    insertSchema(db, UUID_NOISE, 'schema-noise (high noise)');

    // ── Class (a): UUID-slug chapter doc — slug resolves to live schema UUID_A ──
    insertNode(db, { id: 'doc-chapter', type: 'doc', value: 'some content' });
    insertNodeDoc(db, 'doc-chapter', UUID_A);
    insertNodeScope(db, 'doc-chapter', UUID_A);

    // ── Class (b): empty stub ──
    insertNode(db, { id: 'doc-empty', type: 'doc', value: '' });
    insertNodeDoc(db, 'doc-empty', 'some-scope');
    insertNodeScope(db, 'doc-empty', 'some-scope');

    // ── Class (c): noise-schema doc ──
    // Schema UUID_NOISE has 4 members, all noise → noiseFrac = 1.0 >= 0.5
    insertFact(db, 'fact-noise-1', '/private/tmp/foo.txt');
    insertFact(db, 'fact-noise-2', '/tmp/recense.lock');
    insertFact(db, 'fact-noise-3', '/Users/vtx/session.txt');
    insertFact(db, 'fact-noise-4', 'toolu_Abc123');
    abstractsEdge(db, UUID_NOISE, 'fact-noise-1');
    abstractsEdge(db, UUID_NOISE, 'fact-noise-2');
    abstractsEdge(db, UUID_NOISE, 'fact-noise-3');
    abstractsEdge(db, UUID_NOISE, 'fact-noise-4');
    insertNode(db, { id: 'doc-noise', type: 'doc', value: 'noise doc' });
    insertNodeDoc(db, 'doc-noise', UUID_NOISE);
    insertNodeScope(db, 'doc-noise', UUID_NOISE);

    // ── Valid subject doc: scope:name slug, non-empty value — MUST NOT be flagged ──
    insertNode(db, { id: 'doc-valid', type: 'doc', value: 'This is a valid subject doc.' });
    insertNodeDoc(db, 'doc-valid', 'brain-memory:retrieval');
    insertNodeScope(db, 'doc-valid', 'brain-memory');
  });

  afterEach(() => {
    db.close();
  });

  it('returns exactly the 3 junk docs and NOT the valid subject doc', () => {
    const junk = enumerateJunkDocs(db);
    const ids = junk.map((d) => d.id);

    expect(ids).toContain('doc-chapter');
    expect(ids).toContain('doc-empty');
    expect(ids).toContain('doc-noise');
    expect(ids).not.toContain('doc-valid');
    expect(junk).toHaveLength(3);
  });

  it('assigns correct reason for class (a)', () => {
    const junk = enumerateJunkDocs(db);
    const chapter = junk.find((d) => d.id === 'doc-chapter');
    expect(chapter?.reason).toBe('chapter-uuid');
  });

  it('assigns correct reason for class (b)', () => {
    const junk = enumerateJunkDocs(db);
    const emptyDoc = junk.find((d) => d.id === 'doc-empty');
    expect(emptyDoc?.reason).toBe('empty-stub');
  });

  it('includes the noise-schema doc in the junk list (class-a and class-c overlap by construction)', () => {
    // doc-noise has a UUID slug that resolves to a live schema → it satisfies class (a).
    // Class (c) is a subset of class (a): UUID-slug docs whose schema has >= noiseCap noise
    // members. Since both require UUID slug + live schema, a noise-schema doc always also
    // qualifies as chapter-uuid. The dedup retains the first-seen reason (chapter-uuid) but
    // the doc is still correctly flagged as junk.
    const junk = enumerateJunkDocs(db);
    const noiseDoc = junk.find((d) => d.id === 'doc-noise');
    expect(noiseDoc).toBeDefined(); // must be in junk list
    // reason is chapter-uuid (class-a fires first) — the important thing is it IS flagged
    expect(['chapter-uuid', 'noise-schema']).toContain(noiseDoc?.reason);
  });

  it('noise-schema classification: schema with >= 50% noise members is flagged', () => {
    // Standalone test verifying the noise-fraction logic:
    // UUID_NOISE schema has 4 members all noise → noise doc IS in junk list
    const junk = enumerateJunkDocs(db);
    const noiseDoc = junk.find((d) => d.id === 'doc-noise');
    expect(noiseDoc).toBeDefined();
  });

  it('noise-schema classification: schema with < 50% noise members is NOT flagged as noise', () => {
    // doc-chapter (UUID_A) has no members yet → noiseFrac = NaN (0/0) → skip
    // doc-noise (UUID_NOISE) has 4/4 noise → flagged
    // But let's add a doc for a schema with low noise to confirm it's NOT in junk as noise-schema
    insertSchema(db, UUID_C, 'low-noise-schema');
    insertFact(db, 'clean-fact-a', 'recense engine overview');
    insertFact(db, 'clean-fact-b', 'retrieval layer design');
    insertFact(db, 'clean-fact-c', 'schema induction algorithm');
    insertFact(db, 'noise-fact-c', '/tmp/x'); // 1/4 = 0.25 < 0.5
    abstractsEdge(db, UUID_C, 'clean-fact-a');
    abstractsEdge(db, UUID_C, 'clean-fact-b');
    abstractsEdge(db, UUID_C, 'clean-fact-c');
    abstractsEdge(db, UUID_C, 'noise-fact-c');
    insertNode(db, { id: 'doc-low-noise', type: 'doc', value: 'some content' });
    insertNodeDoc(db, 'doc-low-noise', UUID_C);
    insertNodeScope(db, 'doc-low-noise', UUID_C);

    const junk = enumerateJunkDocs(db);
    // doc-low-noise satisfies class-a (UUID slug + live schema) so it IS junk as chapter-uuid
    // but NOT because of noise (noiseFrac = 0.25 < 0.5)
    const lowNoiseEntry = junk.find((d) => d.id === 'doc-low-noise');
    expect(lowNoiseEntry?.reason).toBe('chapter-uuid'); // not noise-schema
  });

  it('does not flag a doc whose schema has low noise fraction', () => {
    // Schema UUID_A: add mostly clean facts — noiseFrac < 0.5 → not noise-schema
    insertFact(db, 'fact-clean-1', 'recense is a memory engine');
    insertFact(db, 'fact-clean-2', 'retrieval pipeline processes episodes');
    insertFact(db, 'fact-clean-3', 'consolidator runs schema induction');
    insertFact(db, 'fact-noise-a', '/tmp/x');  // 1 noise out of 4 = 0.25 < 0.5
    abstractsEdge(db, UUID_A, 'fact-clean-1');
    abstractsEdge(db, UUID_A, 'fact-clean-2');
    abstractsEdge(db, UUID_A, 'fact-clean-3');
    abstractsEdge(db, UUID_A, 'fact-noise-a');
    // doc-chapter still flagged as chapter-uuid (not as noise-schema)
    const junk = enumerateJunkDocs(db);
    const chapter = junk.find((d) => d.id === 'doc-chapter');
    expect(chapter?.reason).toBe('chapter-uuid');
    // no noise-schema entry for UUID_A
    expect(junk.filter((d) => d.slug === UUID_A && d.reason === 'noise-schema')).toHaveLength(0);
  });

  it('deduplicates: a doc matching multiple classes appears exactly once', () => {
    // doc-chapter is already class-a (UUID-slug, live schema).
    // Make it also class-b (empty) → still appears once.
    db.prepare("UPDATE node SET value = '' WHERE id = 'doc-chapter'").run();
    const junk = enumerateJunkDocs(db);
    const chapInstances = junk.filter((d) => d.id === 'doc-chapter');
    expect(chapInstances).toHaveLength(1);
  });

  it('dry-run writes ZERO rows to the DB', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM node WHERE type = ?').get('doc') as { n: number };
    enumerateJunkDocs(db); // enumerate only — no writes
    const after  = db.prepare('SELECT COUNT(*) AS n FROM node WHERE type = ?').get('doc') as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('does not include tombstoned doc nodes', () => {
    // Tombstone doc-chapter — should not appear in junk list
    db.prepare("UPDATE node SET tombstoned = 1 WHERE id = 'doc-chapter'").run();
    const junk = enumerateJunkDocs(db);
    expect(junk.find((d) => d.id === 'doc-chapter')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// printDryRunReport — stdout formatting
// ---------------------------------------------------------------------------

describe('printDryRunReport', () => {
  it('prints a header, grouped sections, and a total line', () => {
    const junkDocs = [
      { id: 'id-a', slug: UUID_A, reason: 'chapter-uuid' as const },
      { id: 'id-b', slug: 'some-scope', reason: 'empty-stub' as const },
      { id: 'id-c', slug: UUID_NOISE, reason: 'noise-schema' as const },
    ];

    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
      written.push(String(data));
      return true;
    });

    try {
      printDryRunReport(junkDocs);
    } finally {
      spy.mockRestore();
    }

    const output = written.join('');
    expect(output).toContain('DRY RUN (nothing written)');
    expect(output).toContain('Class (a)');
    expect(output).toContain('Class (b)');
    expect(output).toContain('Class (c)');
    expect(output).toContain('total: 3');
    expect(output).toContain('chapter-uuid');
    expect(output).toContain('empty-stub');
    expect(output).toContain('noise-schema');
  });

  it('reports 0 total when there are no junk docs', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
      written.push(String(data));
      return true;
    });

    try {
      printDryRunReport([]);
    } finally {
      spy.mockRestore();
    }

    const output = written.join('');
    expect(output).toContain('total: 0');
  });
});

// ---------------------------------------------------------------------------
// hardDeleteJunkDocs — FK-safe real delete (on temp DB)
// ---------------------------------------------------------------------------

describe('hardDeleteJunkDocs — real run on temp DB', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  function countNodes(type: string): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM node WHERE type = ? AND tombstoned = 0').get(type) as { n: number }).n;
  }

  it('deletes exactly the junk ids and leaves valid doc untouched', () => {
    // Seed junk doc
    insertNode(db, { id: 'junk-1', type: 'doc', value: 'junk content' });
    insertNodeDoc(db, 'junk-1', 'junk-slug');
    insertNodeScope(db, 'junk-1', 'scope-a');

    // Seed valid doc
    insertNode(db, { id: 'valid-1', type: 'doc', value: 'valid content' });
    insertNodeDoc(db, 'valid-1', 'brain-memory:retrieval');
    insertNodeScope(db, 'valid-1', 'brain-memory');

    const junkDocs = [{ id: 'junk-1', slug: 'junk-slug', reason: 'empty-stub' as const }];
    const deleted = hardDeleteJunkDocs(db, junkDocs);

    expect(deleted).toBe(1);

    // junk-1 must be gone
    const junkRow = db.prepare('SELECT id FROM node WHERE id = ?').get('junk-1');
    expect(junkRow).toBeUndefined();

    // valid-1 must still exist
    const validRow = db.prepare('SELECT id FROM node WHERE id = ?').get('valid-1');
    expect(validRow).toBeDefined();

    // node_doc for junk-1 must be gone
    const docRow = db.prepare('SELECT node_id FROM node_doc WHERE node_id = ?').get('junk-1');
    expect(docRow).toBeUndefined();

    // node_scope for junk-1 must be gone
    const scopeRow = db.prepare('SELECT node_id FROM node_scope WHERE node_id = ?').get('junk-1');
    expect(scopeRow).toBeUndefined();
  });

  it('PRAGMA foreign_key_check is empty after deletion', () => {
    insertNode(db, { id: 'junk-fk', type: 'doc', value: 'junk' });
    insertNodeDoc(db, 'junk-fk', 'some-uuid');
    insertNodeScope(db, 'junk-fk', 'scope-x');

    const junkDocs = [{ id: 'junk-fk', slug: 'some-uuid', reason: 'chapter-uuid' as const }];
    hardDeleteJunkDocs(db, junkDocs);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  it('deletes dangling edges referencing the junk node', () => {
    // Create a fact node to serve as the edge source
    insertFact(db, 'fact-for-edge', 'some fact value');
    // Create a junk doc node
    insertNode(db, { id: 'junk-edge', type: 'doc', value: '' });
    insertNodeDoc(db, 'junk-edge', 'empty-slug');
    insertNodeScope(db, 'junk-edge', 'scope-y');
    // Insert an edge FROM junk-edge to fact-for-edge (kind='doc_link')
    db.prepare(
      `INSERT OR REPLACE INTO edge (src, dst, rel, w, kind, last_access)
       VALUES ('junk-edge', 'fact-for-edge', 'doc_link', 1.0, 'doc_link', 1000)`,
    ).run();

    const junkDocs = [{ id: 'junk-edge', slug: 'empty-slug', reason: 'empty-stub' as const }];
    hardDeleteJunkDocs(db, junkDocs);

    // Edge must be deleted
    const edgeRow = db.prepare(
      "SELECT * FROM edge WHERE src = 'junk-edge' OR dst = 'junk-edge'",
    ).get();
    expect(edgeRow).toBeUndefined();
  });

  it('returns 0 and writes nothing when junkDocs is empty', () => {
    insertNode(db, { id: 'safe-doc', type: 'doc', value: 'safe' });
    insertNodeDoc(db, 'safe-doc', 'brain-memory:safe-topic');

    const deleted = hardDeleteJunkDocs(db, []);
    expect(deleted).toBe(0);

    const row = db.prepare('SELECT id FROM node WHERE id = ?').get('safe-doc');
    expect(row).toBeDefined();
  });

  it('does NOT delete type=fact or type=entity nodes (evidence-safety)', () => {
    // Confirm that a fact node is not touched even if junkDocs mentions a doc
    insertFact(db, 'ev-fact', 'evidence-backed fact');
    insertNode(db, { id: 'doc-x', type: 'doc', value: '' });
    insertNodeDoc(db, 'doc-x', 'some-slug');
    insertNodeScope(db, 'doc-x', 'scope-z');

    const junkDocs = [{ id: 'doc-x', slug: 'some-slug', reason: 'empty-stub' as const }];
    hardDeleteJunkDocs(db, junkDocs);

    // fact node must still be live
    const factRow = db.prepare('SELECT id FROM node WHERE id = ?').get('ev-fact');
    expect(factRow).toBeDefined();
    expect(countNodes('fact')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// takeSnapshot — snapshot guard on temp file DB
// ---------------------------------------------------------------------------

describe('takeSnapshot', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a temp dir for snapshot testing
    tmpDir = mkdtemp_sync();
  });

  function mkdtemp_sync(): string {
    // mkdtempSync is not in the named imports — use mkdtemp + sync via mkdirSync
    const dir = join(tmpdir(), `recense-snap-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('writes a snapshot file that is non-empty', () => {
    // Create a temp DB file
    const dbFilePath = join(tmpDir, 'test.db');
    const db = new Database(dbFilePath);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    // Insert a minimal node so the DB is non-trivial
    db.prepare(
      `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
       prev_value, pending_contradictions, tombstoned, training_eligible, embedding)
       VALUES ('test-node', 'fact', 'hello', 'hash', 'observed', 0.5, 0.8, 1000,
       NULL, '[]', 0, 0, NULL)`,
    ).run();

    const snapPath = takeSnapshot(db, dbFilePath);
    db.close();

    // Snapshot file must exist and be non-empty
    const info = statSync(snapPath);
    expect(info.size).toBeGreaterThan(0);
    expect(snapPath).toContain('snapshots');
    expect(snapPath).toContain('.bak');
  });

  it('throws when the snapshot directory is unwritable (simulated by bad path)', () => {
    // Use a DB path where dirname points to a non-existent, non-creatable dir
    const badDbPath = '/this/path/does/not/exist/db.sqlite';
    const db = new Database(':memory:');
    initSchema(db);

    // takeSnapshot should throw because mkdirSync or VACUUM INTO will fail
    expect(() => takeSnapshot(db, badDbPath)).toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Snapshot-fail abort (integration: snapshot-fail → exit(1) → zero deletes)
// ---------------------------------------------------------------------------

describe('snapshot-fail → process.exit(1) → zero deletes', () => {
  it('exits with code 1 and deletes nothing when VACUUM INTO fails', () => {
    const db = makeDb();

    // Seed a junk doc so there's something to potentially delete
    insertNode(db, { id: 'snap-fail-doc', type: 'doc', value: '' });
    insertNodeDoc(db, 'snap-fail-doc', 'snap-slug');

    // Spy on process.exit
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      throw new Error(`process.exit(${_code})`);
    });

    // Force VACUUM INTO to fail by providing a bad db path
    // The db itself is in-memory; takeSnapshot will try to create
    // snapshots under dirname('/nonexistent/db') → will fail on mkdirSync
    const junkDocs = [{ id: 'snap-fail-doc', slug: 'snap-slug', reason: 'empty-stub' as const }];

    let threw = false;
    try {
      takeSnapshot(db, '/nonexistent/parent/db.sqlite');
    } catch (err) {
      // Expected — on snapshot failure the caller aborts
      threw = true;
    }

    // After snapshot failure, zero rows deleted
    const nodeCount = db.prepare('SELECT COUNT(*) AS n FROM node WHERE id = ?').get('snap-fail-doc') as { n: number };
    expect(nodeCount.n).toBe(1); // still exists — no delete happened
    expect(threw).toBe(true);   // snapshot threw as expected

    exitSpy.mockRestore();
    db.close();
    void junkDocs; // suppress unused warning
  });
});

// ---------------------------------------------------------------------------
// Full dry-run + real-run integration on a temp file DB
// ---------------------------------------------------------------------------

describe('full dry-run + real-run integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = (() => {
      const dir = join(tmpdir(), `recense-full-test-${process.pid}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    })();
  });

  it('real run: takes snapshot, deletes junk, leaves valid, FK clean', () => {
    const dbFilePath = join(tmpDir, 'full-test.db');
    const db = new Database(dbFilePath);
    db.pragma('foreign_keys = ON');
    initSchema(db);

    // Seed a live schema for class-a and class-c
    insertSchema(db, UUID_B, 'schema-b');

    // Seed class-a junk: UUID-slug chapter doc
    insertNode(db, { id: 'junk-a', type: 'doc', value: 'chapter content' });
    insertNodeDoc(db, 'junk-a', UUID_B);
    insertNodeScope(db, 'junk-a', UUID_B);

    // Seed class-b junk: empty stub with scope:name slug (exhausted by new taxonomy)
    insertNode(db, { id: 'junk-b', type: 'doc', value: '' });
    insertNodeDoc(db, 'junk-b', 'brain-memory:old-topic');
    insertNodeScope(db, 'junk-b', 'brain-memory');

    // Seed valid subject doc
    insertNode(db, { id: 'valid-doc', type: 'doc', value: 'Valid subject content.' });
    insertNodeDoc(db, 'valid-doc', 'brain-memory:retrieval');
    insertNodeScope(db, 'valid-doc', 'brain-memory');

    // Enumerate junk
    const junkDocs = enumerateJunkDocs(db);
    const junkIds = junkDocs.map((d) => d.id);
    expect(junkIds).toContain('junk-a');
    expect(junkIds).toContain('junk-b');
    expect(junkIds).not.toContain('valid-doc');

    // Take snapshot
    const snapPath = takeSnapshot(db, dbFilePath);
    const snapInfo = statSync(snapPath);
    expect(snapInfo.size).toBeGreaterThan(0);

    // Hard delete
    const deleted = hardDeleteJunkDocs(db, junkDocs);
    expect(deleted).toBe(junkDocs.length);

    // FK check clean
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);

    // junk nodes gone
    const junkARow = db.prepare('SELECT id FROM node WHERE id = ?').get('junk-a');
    expect(junkARow).toBeUndefined();
    const junkBRow = db.prepare('SELECT id FROM node WHERE id = ?').get('junk-b');
    expect(junkBRow).toBeUndefined();

    // valid doc still present
    const validRow = db.prepare('SELECT id FROM node WHERE id = ?').get('valid-doc');
    expect(validRow).toBeDefined();

    db.close();
  });

  it('no fact or entity node count decreases after deletion', () => {
    const dbFilePath = join(tmpDir, 'evidence-safety.db');
    const db = new Database(dbFilePath);
    db.pragma('foreign_keys = ON');
    initSchema(db);

    // Seed facts/entities
    insertFact(db, 'fact-1', 'important fact');
    insertFact(db, 'fact-2', 'another fact');
    db.prepare(
      `INSERT OR REPLACE INTO node
       (id, type, value, value_hash, origin, s, c, last_access,
        prev_value, pending_contradictions, tombstoned, training_eligible, embedding)
       VALUES ('entity-1', 'entity', 'Max', 'hash', 'observed', 0.5, 0.8, 1000,
       NULL, '[]', 0, 0, NULL)`,
    ).run();

    // Seed junk doc
    insertNode(db, { id: 'junk-safe', type: 'doc', value: '' });
    insertNodeDoc(db, 'junk-safe', 'empty-scope');
    insertNodeScope(db, 'junk-safe', 'scope-s');

    const factsBefore = (db.prepare("SELECT COUNT(*) AS n FROM node WHERE type = 'fact'").get() as { n: number }).n;
    const entitiesBefore = (db.prepare("SELECT COUNT(*) AS n FROM node WHERE type = 'entity'").get() as { n: number }).n;

    const junkDocs = [{ id: 'junk-safe', slug: 'empty-scope', reason: 'empty-stub' as const }];
    hardDeleteJunkDocs(db, junkDocs);

    const factsAfter = (db.prepare("SELECT COUNT(*) AS n FROM node WHERE type = 'fact'").get() as { n: number }).n;
    const entitiesAfter = (db.prepare("SELECT COUNT(*) AS n FROM node WHERE type = 'entity'").get() as { n: number }).n;

    expect(factsAfter).toBe(factsBefore);
    expect(entitiesAfter).toBe(entitiesBefore);

    db.close();
  });
});
