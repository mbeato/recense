/**
 * Tests for SemanticStore.getOutEdgesWithRel (TYPED-02a — LANDMINE 1 fix).
 *
 * Verifies that the new prepared-statement method returns the `rel` field in its
 * result, which the existing getOutEdges omits. Predicate-filtered traversal requires
 * the rel field to be present.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';

const testConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

describe('SemanticStore.getOutEdgesWithRel', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, testConfig);

    // Seed two nodes and a typed relation edge between them
    store.upsertNode({ id: 'src-node', type: 'entity', value: 'recense', origin: 'observed' });
    store.upsertNode({ id: 'dst-node', type: 'entity', value: 'better-sqlite3', origin: 'observed' });
    store.upsertEdge({
      src: 'src-node',
      dst: 'dst-node',
      rel: 'uses',
      w: 1.0,
      kind: 'relation',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns the rel field for a typed relation edge', () => {
    const edges = store.getOutEdgesWithRel('src-node');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.rel).toBe('uses');
  });

  it('returns dst, rel, w, kind — the full typed edge shape', () => {
    const edges = store.getOutEdgesWithRel('src-node');
    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(edge.dst).toBe('dst-node');
    expect(edge.rel).toBe('uses');
    expect(edge.w).toBe(1.0);
    expect(edge.kind).toBe('relation');
  });

  it('returns empty array for a node with no outgoing edges', () => {
    const edges = store.getOutEdgesWithRel('dst-node');
    expect(edges).toEqual([]);
  });

  it('returns empty array for an unknown node id', () => {
    const edges = store.getOutEdgesWithRel('nonexistent');
    expect(edges).toEqual([]);
  });

  it('returns all outgoing edges when multiple exist', () => {
    // Add a second destination node and edge
    store.upsertNode({ id: 'dst2', type: 'entity', value: 'launchd', origin: 'observed' });
    store.upsertEdge({
      src: 'src-node',
      dst: 'dst2',
      rel: 'runs_on',
      w: 0.8,
      kind: 'relation',
    });

    const edges = store.getOutEdgesWithRel('src-node');
    expect(edges).toHaveLength(2);
    const rels = edges.map((e: { dst: string; rel: string; w: number; kind: string }) => e.rel).sort();
    expect(rels).toContain('uses');
    expect(rels).toContain('runs_on');
  });

  it('existing getOutEdges still works and does NOT return rel', () => {
    // Verify that the existing method is unaffected — it returns {dst, w, kind} only
    const edges = store.getOutEdges('src-node');
    expect(edges).toHaveLength(1);
    // rel must not be present on the existing getOutEdges result type
    const edge = edges[0] as { dst: string; w: number; kind: string; rel?: string };
    // getOutEdges SQL doesn't select rel, so rel should be undefined at runtime
    expect(edge?.rel).toBeUndefined();
    expect(edge?.dst).toBe('dst-node');
  });
});

// ---------------------------------------------------------------------------
// Phase 37 Fix-2: resolveEntityByName — ranked typed-edge endpoint resolution.
// The original consolidator resolver used `LIKE '%name%' LIMIT 1` with no ordering,
// so "OpenAI" resolved to an arbitrary substring match (the node OPENAI_API_KEY)
// instead of the clean "OpenAI" entity — minting garbage typed edges on live data.
// ---------------------------------------------------------------------------
describe('SemanticStore.resolveEntityByName', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, testConfig);
  });

  afterEach(() => {
    db.close();
  });

  it('prefers an exact entity match over an arbitrary substring match (the OPENAI_API_KEY bug)', () => {
    store.upsertNode({ id: 'key', type: 'entity', value: 'OPENAI_API_KEY', origin: 'observed' });
    store.upsertNode({ id: 'clean', type: 'entity', value: 'OpenAI', origin: 'observed' });
    // Both contain "openai"; the old LIKE-LIMIT-1 could return either. Exact must win.
    expect(store.resolveEntityByName('OpenAI')).toBe('clean');
  });

  it('is case-insensitive on the exact match', () => {
    store.upsertNode({ id: 'n', type: 'entity', value: 'Launchd', origin: 'observed' });
    expect(store.resolveEntityByName('launchd')).toBe('n');
  });

  it('prefers an entity-type node over a fact-type node containing the name', () => {
    store.upsertNode({ id: 'fact', type: 'fact', value: 'recense uses launchd for scheduling', origin: 'observed' });
    store.upsertNode({ id: 'ent', type: 'entity', value: 'launchd', origin: 'observed' });
    expect(store.resolveEntityByName('launchd')).toBe('ent');
  });

  it('picks the shortest containing entity, not an arbitrary one', () => {
    store.upsertNode({ id: 'long', type: 'entity', value: 'OpenAI text-embedding-3-small embedder', origin: 'observed' });
    store.upsertNode({ id: 'short', type: 'entity', value: 'text-embedding-3-small', origin: 'observed' });
    expect(store.resolveEntityByName('text-embedding-3-small')).toBe('short');
  });

  it('does NOT bind a short name to a long fact-sentence node that merely contains it (length cap)', () => {
    // A 4-char name must not resolve to a 200-char note containing "node".
    store.upsertNode({
      id: 'para',
      type: 'entity',
      value: "Node's module resolution prefers .js over .ts by default without preferTsExts, so a stale .js shadows a sibling .ts edit and breaks the build silently",
      origin: 'observed',
    });
    expect(store.resolveEntityByName('node')).toBeNull();
  });

  it('returns null when no acceptable node exists', () => {
    store.upsertNode({ id: 'x', type: 'entity', value: 'recense', origin: 'observed' });
    expect(store.resolveEntityByName('nonexistent-entity')).toBeNull();
  });

  it('returns null for an empty/whitespace name', () => {
    expect(store.resolveEntityByName('   ')).toBeNull();
  });
});
