/**
 * EntityResolver unit tests — Phase 64, Plan 64-02 (D-13 minimum test set).
 *
 * Constructs EntityResolver directly against an in-memory SQLite DB (Database(':memory:') +
 * initSchema) — no Consolidator, no ModelProvider, no provider stub of any kind. The absence
 * of a provider in this file is itself part of the D-04 evidence: nothing here could call an
 * LLM even by accident because nothing in the harness ever constructs one.
 *
 * REVIEW-BLOCKING: the never-dense-only pair (lexical direction + dense direction) below is
 * the structural proof of RESOLVE-01 required by D-02/D-13. Weakening either direction silently
 * reduces the three-channel union back to dense-gated candidate generation — the exact defect
 * a prior milestone (v9.0 RECON-01) spent a milestone fixing one layer down (backlog 999.2).
 * Any change to generateCandidates/resolve that makes ONE of these two cases pass only because
 * the OTHER channel also happens to fire is a regression, not a refactor.
 *
 * Nodes are seeded through SemanticStore's own upsertNode/setEmbedding primitives (never a raw
 * INSERT) so node_fts is populated the same way production does.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { newId } from '../src/lib/hash';
import { EntityResolver, lexicalScore } from '../src/consolidation/entity-resolution';

const DIMS = DEFAULT_CONFIG.embeddingDimensions;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  store: SemanticStore;
  config: EngineConfig;
  resolver: EntityResolver;
}

function makeHarness(configOverrides: Partial<EngineConfig> = {}): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(1_000_000);
  const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:', ...configOverrides };
  const store = new SemanticStore(db, clock, config);
  const resolver = new EntityResolver(db, store, config);
  return { db, store, config, resolver };
}

/** Seed an entity node through the real upsert primitive (populates node_fts like production). */
function seedEntity(h: Harness, value: string, vec?: Float32Array): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'entity', value, origin: 'observed' });
  if (vec) h.store.setEmbedding(id, vec);
  return id;
}

/** All-zero vector of the harness embedding dimension. */
function zeroVec(): Float32Array {
  return new Float32Array(DIMS);
}

/** One-hot vector at `dim`, giving cosine=1 against itself and cosine=0 against any other one-hot. */
function unitVec(dim: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[dim] = 1;
  return v;
}

/**
 * Enumerate every user table dynamically and record COUNT(*) plus, where a stable identifying
 * column exists (`value` for node/node_fts), the sorted list of that column's contents.
 * Mirrors tests/intent-conservation.test.ts's snapshotDb helper (reused per plan instruction).
 */
function snapshotDb(db: Database.Database): Record<string, { count: number; values?: string[] }> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const snapshot: Record<string, { count: number; values?: string[] }> = {};
  for (const { name } of tables) {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    let values: string[] | undefined;
    if (cols.includes('value')) {
      values = (
        db.prepare(`SELECT value FROM "${name}" ORDER BY value`).all() as { value: string }[]
      ).map((r) => r.value);
    } else if (cols.includes('content')) {
      values = (
        db.prepare(`SELECT content FROM "${name}" ORDER BY content`).all() as { content: string }[]
      ).map((r) => r.content);
    }
    snapshot[name] = values !== undefined ? { count, values } : { count };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// lexicalScore (pure helper)
// ---------------------------------------------------------------------------

describe('lexicalScore', () => {
  it('exact match scores 1', () => {
    expect(lexicalScore('Acme Corp', 'Acme Corp')).toBe(1);
  });

  it('near-duplicate scores 0.5', () => {
    expect(lexicalScore('Acme Corp', 'Acme Consulting')).toBe(0.5);
  });

  it('containment-style partial overlap scores 2/3', () => {
    expect(lexicalScore('Stripe', 'Stripe Inc')).toBeCloseTo(2 / 3, 10);
  });

  it('empty input scores 0', () => {
    expect(lexicalScore('', 'anything')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateCandidates / resolve — D-13 minimum test set
// ---------------------------------------------------------------------------

describe('EntityResolver', () => {
  it('never-dense-only, lexical direction: resolves via exact/BM25 with dense channel structurally empty', () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp', zeroVec());

    const result = h.resolver.resolve({ descriptor: 'Acme Corp' }); // vec omitted entirely

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.descriptor).toBe('Acme Corp');
      expect(result.channelCounts.dense).toBe(0);
    }
  });

  it('never-dense-only, dense direction: resolves via dense channel with zero lexical overlap', () => {
    const h = makeHarness();
    const vec = unitVec(0);
    seedEntity(h, 'Widget Industries', vec);

    const result = h.resolver.resolve({ descriptor: 'Acme Corp', vec }); // zero token overlap

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.descriptor).toBe('Widget Industries');
    }

    // Structural attribution check — the winning candidate's lex must be 0, dense must clear the floor.
    const gen = h.resolver.generateCandidates({ text: 'Acme Corp', vec, nodeType: 'entity' });
    const winner = gen.candidates.find((c) => c.value === 'Widget Industries')!;
    expect(winner.lex).toBe(0);
    expect(winner.dense).toBeGreaterThanOrEqual(h.config.entityResolutionFloor);
  });

  it('near-duplicate separation: resolves to the exact match, never the near-duplicate', () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp');
    seedEntity(h, 'Acme Consulting');

    const result = h.resolver.resolve({ descriptor: 'Acme Corp' });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.descriptor).toBe('Acme Corp');
      // BM25 channel is genuinely exercised (both nodes share the "Acme" token) — proves the
      // channel isn't silently dead.
      expect(result.channelCounts.bm25).toBeGreaterThan(0);
    }
  });

  it('near-duplicate under a flat embedder: abstains rather than cross-attributing', () => {
    const h = makeHarness();
    const vec = unitVec(0);
    seedEntity(h, 'Acme Corp', vec);
    seedEntity(h, 'Acme Consulting', vec);

    const result = h.resolver.resolve({ descriptor: 'Acme Corp', vec });

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe('margin-too-close');
    }
  });

  it('unknown entity: abstains, both output fields absent, nothing minted', () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp');
    const before = (h.db.prepare(`SELECT COUNT(*) AS n FROM node`).get() as { n: number }).n;

    const result = h.resolver.resolve({ descriptor: 'Zzyzx Robotics' });

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(['no-candidates', 'below-floor']).toContain(result.reason);
    }
    expect('nodeId' in result).toBe(false);
    expect('descriptor' in result).toBe(false);
    const after = (h.db.prepare(`SELECT COUNT(*) AS n FROM node`).get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('empty graph: no-candidates', () => {
    const h = makeHarness();
    const result = h.resolver.resolve({ descriptor: 'Anything At All' });
    expect(result).toEqual({
      resolved: false,
      reason: 'no-candidates',
      channelCounts: { exact: 0, bm25: 0, dense: 0 },
    });
  });

  it('read-only: a resolve that hits leaves the whole DB byte-identical', () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp');

    const before = snapshotDb(h.db);
    const result = h.resolver.resolve({ descriptor: 'Acme Corp' });
    const after = snapshotDb(h.db);

    expect(result.resolved).toBe(true);
    expect(after).toEqual(before);
  });

  it('read-only: a resolve that abstains leaves the whole DB byte-identical', () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp');

    const before = snapshotDb(h.db);
    const result = h.resolver.resolve({ descriptor: 'Zzyzx Robotics' });
    const after = snapshotDb(h.db);

    expect(result.resolved).toBe(false);
    expect(after).toEqual(before);
  });

  it('FTS absent: still resolves via the exact channel, no throw', () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp');
    h.db.exec('DROP TABLE node_fts');

    expect(() => h.resolver.resolve({ descriptor: 'Acme Corp' })).not.toThrow();
    const result = h.resolver.resolve({ descriptor: 'Acme Corp' });
    expect(result.resolved).toBe(true);
  });

  it('MATCH injection: adversarial descriptor does not throw and produces a normal result', () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp');

    const adversarial = `O'Brien (Ltd) - AND "quoted" OR NEAR *`;
    expect(() => h.resolver.resolve({ descriptor: adversarial })).not.toThrow();
    const result = h.resolver.resolve({ descriptor: adversarial });
    expect(typeof result.resolved).toBe('boolean');
  });

  it('candidate cap: BM25 and dense channels are each capped at the private ENTITY_CANDIDATE_K', () => {
    const h = makeHarness();
    for (let i = 0; i < 12; i++) {
      seedEntity(h, `Acme Corp ${i}`, unitVec(i));
    }

    const { channelCounts } = h.resolver.generateCandidates({
      text: 'Acme Corp',
      vec: unitVec(0),
      nodeType: 'entity',
    });

    expect(channelCounts.bm25).toBeLessThanOrEqual(5);
    expect(channelCounts.dense).toBeLessThanOrEqual(5);
  });

  it('dark switch: entityResolutionFloor set unreachably high abstains on every resolve', () => {
    const h = makeHarness({ entityResolutionFloor: 2 });
    seedEntity(h, 'Acme Corp');

    const result = h.resolver.resolve({ descriptor: 'Acme Corp' });

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe('below-floor');
    }
  });
});

// ---------------------------------------------------------------------------
// Source-level read-only guard (D-12) — comment-stripped, review-blocking
// ---------------------------------------------------------------------------

describe('EntityResolver source guard (D-12 read-only contract)', () => {
  it('contains zero forbidden write calls after stripping comments', () => {
    const srcPath = path.resolve(__dirname, '../src/consolidation/entity-resolution.ts');
    const raw = fs.readFileSync(srcPath, 'utf8');
    // Comment-stripping is mandatory: the module's own header documents these forbidden calls
    // by name, so an unstripped grep would self-invalidate.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const forbidden = /upsertNode|upsertEdge|\.strengthen\(|\.tombstone\(|db\.transaction/;
    expect(forbidden.test(stripped)).toBe(false);
  });
});
