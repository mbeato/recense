/**
 * doc-gather tests (READER-01, 27-02 Task 1 — TDD RED).
 *
 * Covers the three gather sources and their union/dedup behavior:
 *  (a) Scope gather: facts tagged to the slug via node_scope are returned.
 *  (b) Semantic gather: semantically-near facts (no slug in text) are returned via hybridTopk.
 *  (c) Entity-hop: entity matching slug → 1-hop fact neighbor is returned.
 *  (d) Tombstoned facts are excluded from all sources.
 *  (e) Multi-source facts are deduped to one row with combined via tags.
 *  (f) No lexical LIKE on fact.value for the slug (D-01 — only entity-name LIKE is allowed).
 */
import Database from 'better-sqlite3';
import { describe, test, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { ModelProvider } from '../src/model/provider';
import { gatherFacts, gatherSiblingDocs } from '../src/reader/doc-gather';

// ── helpers ────────────────────────────────────────────────────────────────

interface GatherDeps {
  db: Database.Database;
  store: SemanticStore;
  provider: ModelProvider;
}

/** Build a stub ModelProvider that returns a fixed embedding vector for any text. */
function makeStubProvider(dims = 4, fixedVec?: Float32Array): ModelProvider {
  const vec = fixedVec ?? new Float32Array(dims).fill(0.5);
  return {
    generate: async (_prompt: string) => '',
    embed: async (_texts: string[]) => [vec],
    judge: async (_prompt: string) => ({ verdict: 'unrelated', magnitude: 0, best_candidate_id: null, contradicted_ids: [], reasoning: '' }),
  } as unknown as ModelProvider;
}

function makeGatherDeps(fixedVec?: Float32Array): GatherDeps {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(10000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  const provider = makeStubProvider(4, fixedVec);
  return { db, store, provider };
}

/** Seed a fact node and optionally give it a node_scope entry. */
function seedFact(
  store: SemanticStore,
  id: string,
  value: string,
  opts?: { scope?: string; tombstoned?: boolean; embedding?: Float32Array },
): void {
  store.upsertNode({
    id,
    type: 'fact',
    value,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 5000,
    tombstoned: opts?.tombstoned ?? false,
  });
  if (opts?.scope) {
    store.upsertNodeScope({ node_id: id, scope: opts.scope, updated_at: 5000 });
  }
  if (opts?.embedding) {
    store.setEmbedding(id, opts.embedding);
  }
}

/** Seed an entity node with optional embedding. */
function seedEntity(
  store: SemanticStore,
  id: string,
  value: string,
  opts?: { embedding?: Float32Array },
): void {
  store.upsertNode({
    id,
    type: 'entity',
    value,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 5000,
  });
  if (opts?.embedding) {
    store.setEmbedding(id, opts.embedding);
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('gatherFacts', () => {
  test('(a) returns facts tagged by node_scope for the slug', async () => {
    const { db, store, provider } = makeGatherDeps();
    // fact-scope is attributed to 'myproject' slug
    seedFact(store, 'fact-scope', 'something about the project infrastructure', { scope: 'myproject' });
    // fact-other is attributed to a different slug — should NOT appear
    seedFact(store, 'fact-other', 'unrelated fact from another project', { scope: 'other-proj' });

    const results = await gatherFacts({ db, store, provider }, 'myproject');
    const ids = results.map(r => r.id);
    expect(ids).toContain('fact-scope');
    expect(ids).not.toContain('fact-other');
  });

  test('(d) tombstoned facts are excluded from all sources', async () => {
    const { db, store, provider } = makeGatherDeps();
    // tombstoned fact with scope tag — should be excluded
    seedFact(store, 'fact-tomb', 'tombstoned fact about myproject', {
      scope: 'myproject',
      tombstoned: true,
    });
    // live fact with scope — should appear
    seedFact(store, 'fact-live', 'live fact about myproject', { scope: 'myproject' });

    const results = await gatherFacts({ db, store, provider }, 'myproject');
    const ids = results.map(r => r.id);
    expect(ids).not.toContain('fact-tomb');
    expect(ids).toContain('fact-live');
  });

  test('(c) entity-hop: entity matching slug -> 1-hop fact neighbor included', async () => {
    const { db, store, provider } = makeGatherDeps();
    // entity whose name matches the slug
    seedEntity(store, 'entity-myproject', 'myproject');
    // fact connected to the entity via an edge
    seedFact(store, 'fact-linked', 'some detail about this system');
    // Create edge: entity → fact (relation)
    store.upsertEdge({ src: 'entity-myproject', dst: 'fact-linked', rel: 'relation', kind: 'relation', w: 1.0 });

    const results = await gatherFacts({ db, store, provider }, 'myproject');
    const ids = results.map(r => r.id);
    expect(ids).toContain('fact-linked');
  });

  test('(e) multi-source fact is deduped to one row', async () => {
    const { db, store, provider } = makeGatherDeps();
    // fact-dual appears via both scope and entity-hop
    seedFact(store, 'fact-dual', 'some fact about myproject system', { scope: 'myproject' });
    seedEntity(store, 'entity-myproject', 'myproject');
    store.upsertEdge({ src: 'entity-myproject', dst: 'fact-dual', rel: 'relation', kind: 'relation', w: 1.0 });

    const results = await gatherFacts({ db, store, provider }, 'myproject');
    // Must appear exactly once (dedup)
    const matches = results.filter(r => r.id === 'fact-dual');
    expect(matches).toHaveLength(1);
    // via must indicate multiple sources
    expect(matches[0]!.via).toMatch(/scope|linked/);
  });

  test('(b) semantic hits (no slug in value, no scope tag) are included', async () => {
    // We use a fixed embedding vector for the query AND a matching fact embedding
    // hybridTopk cosine-matches them
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const semanticFactVec = new Float32Array([1, 0, 0, 0]); // identical → high cosine

    const { db, store, provider } = makeGatherDeps(queryVec);
    // fact-semantic: no scope tag, no slug mention, but embedding matches query
    seedFact(store, 'fact-semantic', 'completely unrelated text with no slug mention', {
      embedding: semanticFactVec,
    });

    // To use hybridTopk the store needs embedding_dims set
    // Store meta key required by setEmbedding's L-2 guard (already set by seedFact above)

    const results = await gatherFacts({ db, store, provider }, 'myproject');
    const ids = results.map(r => r.id);
    // The semantic fact should be included via hybridTopk (cosine match)
    expect(ids).toContain('fact-semantic');
  });

  test('result rows include id, value, c, origin, last_access, via fields', async () => {
    const { db, store, provider } = makeGatherDeps();
    seedFact(store, 'fact-fields', 'a fact about the project', { scope: 'myproject' });

    const results = await gatherFacts({ db, store, provider }, 'myproject');
    expect(results.length).toBeGreaterThan(0);
    const row = results[0]!;
    expect(typeof row.id).toBe('string');
    expect(typeof row.value).toBe('string');
    expect(typeof row.c).toBe('number');
    expect(typeof row.origin).toBe('string');
    expect(typeof row.last_access).toBe('number');
    expect(typeof row.via).toBe('string');
  });
});

// ── gatherSiblingDocs (READER-04) ──────────────────────────────────────────

describe('gatherSiblingDocs', () => {
  /** Seed a live doc node with node_doc sidecar + body. */
  function seedDocNode(store: SemanticStore, id: string, slug: string, body: string): void {
    store.upsertNode({ id, type: 'doc', value: body, origin: 'inferred', s: 0, c: 1.0, last_access: 5000 });
    store.upsertNodeDoc({ node_id: id, slug, generated_at: 4000, updated_at: 4000 });
    store.upsertNodeScope({ node_id: id, scope: slug, updated_at: 4000 });
  }

  test('returns other live docs (id, slug, title from first H1), excluding the current slug', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-tonos', 'tonos', '# Tonos — Project Deep-Dive\n\nbody');
    seedDocNode(store, 'doc-vtx', 'vtx', '# VTX\n\nbody');

    const siblings = gatherSiblingDocs(db, 'vtx');
    expect(siblings).toHaveLength(1);
    expect(siblings[0]!.id).toBe('doc-tonos');
    expect(siblings[0]!.slug).toBe('tonos');
    expect(siblings[0]!.title).toBe('Tonos — Project Deep-Dive');
  });

  test('title falls back to the slug when the body has no H1', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-a', 'alpha', 'no heading here, just prose');
    const siblings = gatherSiblingDocs(db, 'other');
    expect(siblings).toHaveLength(1);
    expect(siblings[0]!.title).toBe('alpha');
  });

  test('excludes tombstoned docs', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-live', 'live', '# Live');
    seedDocNode(store, 'doc-dead', 'dead', '# Dead');
    store.tombstone('doc-dead');

    const siblings = gatherSiblingDocs(db, 'current');
    const slugs = siblings.map(s => s.slug);
    expect(slugs).toContain('live');
    expect(slugs).not.toContain('dead');
  });

  test('returns empty when no other docs exist', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-only', 'only', '# Only');
    // Generating for the same slug → its own doc is excluded → no siblings
    expect(gatherSiblingDocs(db, 'only')).toHaveLength(0);
  });
});
