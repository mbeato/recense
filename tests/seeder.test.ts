/**
 * ClaimExtractor seam + INGEST-03: ColdStartSeeder one-shot seed.
 * All tests use MockClaimExtractor — no live API calls.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { MockClaimExtractor } from '../src/model/claim-extractor';
import type { ExtractedClaim } from '../src/model/claim-extractor';
import { ColdStartSeeder } from '../src/seeder/cold-start';
import type { NodeRow, EdgeRow } from '../src/lib/types';

// ─── ClaimExtractor: MockClaimExtractor ──────────────────────────────────────

describe('ClaimExtractor: MockClaimExtractor', () => {
  it('returns scripted claims deterministically (no network)', async () => {
    const scripted: ExtractedClaim[] = [
      { type: 'entity', value: 'Jane Doe' },
      { type: 'fact', value: 'TypeScript is used', links: ['Jane Doe'] },
    ];
    const mock = new MockClaimExtractor(scripted);
    const result = await mock.extract('any content', 'user');
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('entity');
    expect(result[0]!.value).toBe('Jane Doe');
    expect(result[1]!.links).toContain('Jane Doe');
  });

  it('returns the same scripted claims on every call (ignores content and sourceType)', async () => {
    const scripted: ExtractedClaim[] = [{ type: 'fact', value: 'consistent fact' }];
    const mock = new MockClaimExtractor(scripted);
    const r1 = await mock.extract('content one', 'user');
    const r2 = await mock.extract('content two', 'project');
    expect(r1).toEqual(r2);
    expect(r1[0]!.value).toBe('consistent fact');
  });

  it('returns an empty array when scripted with no claims', async () => {
    const mock = new MockClaimExtractor([]);
    const result = await mock.extract('any content', 'reference');
    expect(result).toHaveLength(0);
  });

  it('returns claims with optional links field intact', async () => {
    const scripted: ExtractedClaim[] = [
      { type: 'entity', value: 'NodeA', links: ['NodeB', 'NodeC'] },
      { type: 'fact', value: 'NodeB' }, // no links field
    ];
    const mock = new MockClaimExtractor(scripted);
    const result = await mock.extract('any', 'reference');
    expect(result[0]!.links).toEqual(['NodeB', 'NodeC']);
    expect(result[1]!.links).toBeUndefined();
  });
});

// ─── INGEST-03: ColdStartSeeder ───────────────────────────────────────────────

describe('INGEST-03: ColdStartSeeder', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;
  let tmpDir: string;
  let claudeTmpFile: string;

  /** Two scripted claims: first links to second — exercises wikilink edge creation. */
  const SCRIPTED_CLAIMS: ExtractedClaim[] = [
    { type: 'entity', value: 'recense is a project', links: ['TypeScript'] },
    { type: 'fact', value: 'TypeScript', links: [] },
  ];

  const makeConfig = (memDir: string, claudeFile: string = ''): EngineConfig => ({
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    coldStartMemoryDir: memDir,
    coldStartClaudeFile: claudeFile,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));

    // Create tmpDir for fixture memory files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-seed-'));

    // Fixture: one real memory file + one MEMORY.md index (to be excluded)
    fs.writeFileSync(
      path.join(tmpDir, 'project.md'),
      '---\ntype: project\n---\n# Recense\n\nA memory engine for AI agents.',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'MEMORY.md'),
      '# Index\n- [[project]]\n',
    );

    // Claude fixture lives in a subdirectory so it is NOT enumerated by the memory dir scan
    const claudeDir = path.join(tmpDir, 'claude-dir');
    fs.mkdirSync(claudeDir);
    claudeTmpFile = path.join(claudeDir, 'CLAUDE.md');
    fs.writeFileSync(claudeTmpFile, '# Hard Rules\n\nNever inflate metrics.\nAlways use TypeScript.');

    // Build store using the tmpDir config so the store is fresh for each test
    store = new SemanticStore(db, clock, makeConfig(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeded nodes have origin=asserted_by_user, c≈0.8, s≈0.1, and embedded_hash null (D-06)', async () => {
    const mock = new MockClaimExtractor(SCRIPTED_CLAIMS);
    const cfg = makeConfig(tmpDir);
    const seeder = new ColdStartSeeder(store, mock, cfg);
    await seeder.seed();

    const nodes = db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBe(2);

    for (const node of nodes) {
      expect(node.origin).toBe('asserted_by_user');
      expect(node.c).toBeGreaterThanOrEqual(0.75);
      expect(node.c).toBeLessThanOrEqual(0.85);
      expect(node.s).toBeGreaterThanOrEqual(0.05);
      expect(node.s).toBeLessThanOrEqual(0.15);
      expect(node.embedded_hash).toBeNull();
      expect(node.tombstoned).toBe(0);
    }
  });

  it('wikilink in a claim produces a relation edge in the edge table (D-05)', async () => {
    const mock = new MockClaimExtractor(SCRIPTED_CLAIMS);
    const cfg = makeConfig(tmpDir);
    const seeder = new ColdStartSeeder(store, mock, cfg);
    await seeder.seed();

    const edges = db.prepare('SELECT * FROM edge').all() as EdgeRow[];
    expect(edges.length).toBeGreaterThanOrEqual(1);

    const edge = edges[0]!;
    expect(edge.rel).toBe('links_to');
    expect(edge.kind).toBe('relation');

    // Verify src = 'recense is a project' and dst = 'TypeScript'
    const srcNode = db
      .prepare('SELECT value FROM node WHERE id = ?')
      .get(edge.src) as { value: string } | undefined;
    const dstNode = db
      .prepare('SELECT value FROM node WHERE id = ?')
      .get(edge.dst) as { value: string } | undefined;
    expect(srcNode?.value).toBe('recense is a project');
    expect(dstNode?.value).toBe('TypeScript');
  });

  it('second seed() call is a no-op — node count unchanged and meta seeded is set (D-07)', async () => {
    const mock = new MockClaimExtractor(SCRIPTED_CLAIMS);
    const cfg = makeConfig(tmpDir);
    const seeder = new ColdStartSeeder(store, mock, cfg);

    await seeder.seed();
    const countAfterFirst = (
      db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }
    ).n;
    const seededMeta = store.getMeta('seeded');

    await seeder.seed(); // second call — must be a no-op
    const countAfterSecond = (
      db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }
    ).n;

    expect(seededMeta).not.toBeNull();
    expect(countAfterFirst).toBe(2);
    expect(countAfterSecond).toBe(2); // no new nodes on second call
  });

  it('MEMORY.md index file is excluded from seeding (D-04)', async () => {
    // tmpDir contains project.md AND MEMORY.md
    // If MEMORY.md were processed, mock would produce duplicate nodes → 4 total
    // Correct exclusion means only project.md is processed → 2 nodes
    const mock = new MockClaimExtractor(SCRIPTED_CLAIMS);
    const cfg = makeConfig(tmpDir);
    const seeder = new ColdStartSeeder(store, mock, cfg);
    await seeder.seed();

    const count = (db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;
    expect(count).toBe(2); // only project.md processed; MEMORY.md excluded
  });

  it('coldStartClaudeFile is included as an additional source (D-04)', async () => {
    // claudeTmpFile is in a subdirectory — NOT enumerated by memory dir scan
    // With coldStartClaudeFile configured, it is appended as a separate source
    // 2 sources × 2 scripted claims = 4 nodes
    const mock = new MockClaimExtractor(SCRIPTED_CLAIMS);
    const cfg = makeConfig(tmpDir, claudeTmpFile);
    const seeder = new ColdStartSeeder(store, mock, cfg);
    await seeder.seed();

    const count = (db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;
    expect(count).toBe(4);
  });

  it('meta seeded flag is set after successful seed()', async () => {
    const mock = new MockClaimExtractor(SCRIPTED_CLAIMS);
    const cfg = makeConfig(tmpDir);
    const seeder = new ColdStartSeeder(store, mock, cfg);

    expect(store.getMeta('seeded')).toBeNull();
    await seeder.seed();
    expect(store.getMeta('seeded')).not.toBeNull();
  });

  it('zero-sources guard (D-81): throws when no source files resolve and seeded flag is NOT set', async () => {
    // Empty dir has no .md files; claudeFile '' is falsy → collectSources() returns []
    // D-81 guard must throw BEFORE setMeta('seeded') is reached
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-empty-'));
    const freshDb = new Database(':memory:');
    initSchema(freshDb);
    try {
      const mock = new MockClaimExtractor([]);
      const cfg = makeConfig(emptyDir, '');
      const freshStore = new SemanticStore(freshDb, clock, cfg);
      const seeder = new ColdStartSeeder(freshStore, mock, cfg);
      await expect(seeder.seed()).rejects.toThrow();
      expect(freshStore.getMeta('seeded')).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      freshDb.close();
    }
  });

  it('files whose real path resolves outside coldStartMemoryDir are skipped (T-04-PATH)', async () => {
    // Create a file outside tmpDir
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.md');
    fs.writeFileSync(outsideFile, '# Outside content');

    // Create a symlink inside tmpDir pointing to the outside file
    const symlinkPath = path.join(tmpDir, 'escaped.md');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
      symlinkCreated = true;
    } catch {
      // Symlink creation may fail in some CI environments — skip the symlink assertion
    }

    try {
      const mock = new MockClaimExtractor(SCRIPTED_CLAIMS);
      const cfg = makeConfig(tmpDir);
      const seeder = new ColdStartSeeder(store, mock, cfg);
      await seeder.seed();

      if (symlinkCreated) {
        // escaped.md symlink resolves outside tmpDir — seeder must skip it
        // Only project.md should be processed (MEMORY.md excluded) → 2 nodes
        // Without protection, escaped.md runs mock too → 4 nodes
        const count = (db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;
        expect(count).toBe(2);
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
