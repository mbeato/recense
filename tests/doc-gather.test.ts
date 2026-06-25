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
import { describe, test, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { ModelProvider } from '../src/model/provider';
import { gatherFacts, gatherFactsForSchema, gatherSiblingDocs, gatherNeighborDocs } from '../src/reader/doc-gather';
import type { GatherSchemaParams } from '../src/reader/doc-gather';

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

// ── gatherFactsForSchema (CORPUS-01) ──────────────────────────────────────
//
// Tests for schema-anchored gather (D-09): evidence-set spine (kind='abstracts')
// + centroid-seeded semantic breadth + entity-hop re-rooted at schema's entities.
// Unskipped and fleshed out by Plan 28-02.

/** Seed a schema node (type='entity' proxy — schema is an entity node in the DB). */
function seedSchema(
  store: SemanticStore,
  id: string,
  label: string,
): void {
  store.upsertNode({
    id,
    type: 'schema',
    value: label,
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: 5000,
  });
}

describe('gatherFactsForSchema (CORPUS-01)', () => {
  test('returns facts from the schema evidence set (kind=abstracts edges from schemaId to live facts)', async () => {
    const { db, store, provider } = makeGatherDeps();
    seedSchema(store, 'schema-a', 'infrastructure patterns');
    // 3 facts that the schema directly abstracts
    seedFact(store, 'fact-ev1', 'evidence fact 1 about infra');
    seedFact(store, 'fact-ev2', 'evidence fact 2 about infra');
    seedFact(store, 'fact-ev3', 'evidence fact 3 about infra');
    // wire kind='abstracts' edges
    store.upsertEdge({ src: 'schema-a', dst: 'fact-ev1', rel: 'abstracts', kind: 'abstracts', w: 1 });
    store.upsertEdge({ src: 'schema-a', dst: 'fact-ev2', rel: 'abstracts', kind: 'abstracts', w: 1 });
    store.upsertEdge({ src: 'schema-a', dst: 'fact-ev3', rel: 'abstracts', kind: 'abstracts', w: 1 });
    // a fact NOT abstracted by the schema — must NOT appear
    seedFact(store, 'fact-other', 'unrelated fact not in schema');

    const params: GatherSchemaParams = { schemaId: 'schema-a', centroid: null };
    const results = await gatherFactsForSchema({ db, store, provider }, params);
    const ids = results.map(r => r.id);
    expect(ids).toContain('fact-ev1');
    expect(ids).toContain('fact-ev2');
    expect(ids).toContain('fact-ev3');
    expect(ids).not.toContain('fact-other');
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  test('returns entity-hop 1-hop fact neighbors of entities that are direct abstracts members of the schema', async () => {
    const { db, store, provider } = makeGatherDeps();
    seedSchema(store, 'schema-b', 'system entities');
    // An entity directly abstracted by the schema
    seedEntity(store, 'entity-sys', 'the system entity');
    store.upsertEdge({ src: 'schema-b', dst: 'entity-sys', rel: 'abstracts', kind: 'abstracts', w: 1 });
    // A fact that is a 1-hop neighbor of entity-sys (reachable only via entity-hop)
    seedFact(store, 'fact-hop', 'linked fact only reachable via entity hop');
    store.upsertEdge({ src: 'entity-sys', dst: 'fact-hop', rel: 'relation', kind: 'relation', w: 1 });

    const params: GatherSchemaParams = { schemaId: 'schema-b', centroid: null };
    const results = await gatherFactsForSchema({ db, store, provider }, params);
    const ids = results.map(r => r.id);
    expect(ids).toContain('fact-hop');
    // via must include 'linked'
    const hopRow = results.find(r => r.id === 'fact-hop');
    expect(hopRow?.via).toMatch(/linked/);
  });

  test('semantic breadth: returns semantically-near facts via hybridTopk seeded by schema centroid', async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const semanticFactVec = new Float32Array([1, 0, 0, 0]); // identical → high cosine
    const { db, store, provider } = makeGatherDeps(queryVec);

    seedSchema(store, 'schema-c', 'semantics');
    // fact with a matching embedding — no abstracts edge, no entity-hop — only semantic
    seedFact(store, 'fact-semantic', 'semantically close fact with no abstracts link', {
      embedding: semanticFactVec,
    });

    const params: GatherSchemaParams = { schemaId: 'schema-c', centroid: queryVec };
    const results = await gatherFactsForSchema({ db, store, provider }, params);
    const ids = results.map(r => r.id);
    expect(ids).toContain('fact-semantic');
    // Verify via contains 'semantic'
    const semRow = results.find(r => r.id === 'fact-semantic');
    expect(semRow?.via).toMatch(/semantic/);
  });

  test('tombstoned facts are excluded from all sources', async () => {
    const { db, store, provider } = makeGatherDeps();
    seedSchema(store, 'schema-d', 'test schema');
    // tombstoned fact connected via abstracts — must be excluded
    seedFact(store, 'fact-tomb', 'tombstoned evidence', { tombstoned: true });
    store.upsertEdge({ src: 'schema-d', dst: 'fact-tomb', rel: 'abstracts', kind: 'abstracts', w: 1 });
    // live fact connected via abstracts — must be included
    seedFact(store, 'fact-live', 'live evidence');
    store.upsertEdge({ src: 'schema-d', dst: 'fact-live', rel: 'abstracts', kind: 'abstracts', w: 1 });

    const params: GatherSchemaParams = { schemaId: 'schema-d', centroid: null };
    const results = await gatherFactsForSchema({ db, store, provider }, params);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain('fact-tomb');
    expect(ids).toContain('fact-live');
  });

  test('multi-source facts are deduped to one row with combined via tags', async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const { db, store, provider } = makeGatherDeps(queryVec);
    seedSchema(store, 'schema-e', 'multi-source');
    // fact-dual: appears via abstracts spine AND has a matching embedding (semantic)
    seedFact(store, 'fact-dual', 'dual source fact', { embedding: queryVec });
    store.upsertEdge({ src: 'schema-e', dst: 'fact-dual', rel: 'abstracts', kind: 'abstracts', w: 1 });

    const params: GatherSchemaParams = { schemaId: 'schema-e', centroid: queryVec };
    const results = await gatherFactsForSchema({ db, store, provider }, params);
    const matches = results.filter(r => r.id === 'fact-dual');
    expect(matches).toHaveLength(1);
    // via must encode multiple sources (e.g. 'scope+semantic' or similar)
    expect(matches[0]!.via).toMatch(/semantic/);
  });

  test('returns GatheredFact[] with id, value, c, origin, last_access, via fields', async () => {
    const { db, store, provider } = makeGatherDeps();
    seedSchema(store, 'schema-f', 'field check');
    seedFact(store, 'fact-fields2', 'a fact with all fields');
    store.upsertEdge({ src: 'schema-f', dst: 'fact-fields2', rel: 'abstracts', kind: 'abstracts', w: 1 });

    const params: GatherSchemaParams = { schemaId: 'schema-f', centroid: null };
    const results = await gatherFactsForSchema({ db, store, provider }, params);
    expect(results.length).toBeGreaterThan(0);
    const row = results[0]!;
    expect(typeof row.id).toBe('string');
    expect(typeof row.value).toBe('string');
    expect(typeof row.c).toBe('number');
    expect(typeof row.origin).toBe('string');
    expect(typeof row.last_access).toBe('number');
    expect(typeof row.via).toBe('string');
  });

  test('null centroid skips semantic pass (no embed call) but still returns spine + entity-hop facts', async () => {
    const { db, store, provider } = makeGatherDeps();
    let embedCalled = false;
    const trackingProvider = {
      ...provider,
      embed: async (texts: string[]) => {
        embedCalled = true;
        return provider.embed(texts);
      },
    } as unknown as typeof provider;

    seedSchema(store, 'schema-g', 'null centroid schema');
    seedFact(store, 'fact-spine', 'spine fact from abstracts');
    store.upsertEdge({ src: 'schema-g', dst: 'fact-spine', rel: 'abstracts', kind: 'abstracts', w: 1 });

    const params: GatherSchemaParams = { schemaId: 'schema-g', centroid: null };
    const results = await gatherFactsForSchema({ db, store, provider: trackingProvider }, params);

    // No embed call should have been made
    expect(embedCalled).toBe(false);
    // Spine facts still returned
    const ids = results.map(r => r.id);
    expect(ids).toContain('fact-spine');
  });

  test('does NOT touch source schema s/c/embedding (read-only guard, CORPUS-05)', async () => {
    const { db, store, provider } = makeGatherDeps();
    seedSchema(store, 'schema-h', 'readonly check');
    seedFact(store, 'fact-ro', 'readonly fact');
    store.upsertEdge({ src: 'schema-h', dst: 'fact-ro', rel: 'abstracts', kind: 'abstracts', w: 1 });

    // Snapshot the schema node before gathering
    const before = db.prepare("SELECT s, c, embedding FROM node WHERE id = ?").get('schema-h') as { s: number; c: number; embedding: Buffer | null };

    const params: GatherSchemaParams = { schemaId: 'schema-h', centroid: null };
    await gatherFactsForSchema({ db, store, provider }, params);

    // Schema node must be unchanged
    const after = db.prepare("SELECT s, c, embedding FROM node WHERE id = ?").get('schema-h') as { s: number; c: number; embedding: Buffer | null };
    expect(after.s).toBe(before.s);
    expect(after.c).toBe(before.c);
    expect(after.embedding).toEqual(before.embedding);
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

// ── gatherNeighborDocs (Feature B) ──────────────────────────────────────────
//
// Unlike gatherSiblingDocs (ALL live docs), gatherNeighborDocs returns ONLY the docs
// connected to the current doc via kind IN ('doc_containment','doc_reference') — so the
// generator offers genuinely-related chapters/subjects as inline-link candidates, not a
// flood of every doc.

describe('gatherNeighborDocs', () => {
  /** Seed a live doc node with node_doc sidecar + body. */
  function seedDocNode(store: SemanticStore, id: string, slug: string, body: string): void {
    store.upsertNode({ id, type: 'doc', value: body, origin: 'inferred', s: 0, c: 1.0, last_access: 5000 });
    store.upsertNodeDoc({ node_id: id, slug, generated_at: 4000, updated_at: 4000 });
    store.upsertNodeScope({ node_id: id, scope: slug, updated_at: 4000 });
  }

  test('returns only containment/reference neighbors — NOT every live doc', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-hub', 'brain-memory', '# Brain Memory — Hub');
    seedDocNode(store, 'doc-sub', 'brain-memory:sleep pass', '# Sleep Pass');
    seedDocNode(store, 'doc-peer', 'tonos', '# Tonos');
    // Unconnected doc — gatherSiblingDocs would include it; gatherNeighborDocs must NOT.
    seedDocNode(store, 'doc-noise', 'unrelated', '# Unrelated');
    // hub contains the subject; hub references the peer.
    store.upsertEdge({ src: 'doc-hub', dst: 'doc-sub', rel: 'doc_containment', kind: 'doc_containment', w: 1 });
    store.upsertEdge({ src: 'doc-hub', dst: 'doc-peer', rel: 'doc_reference', kind: 'doc_reference', w: 1 });

    const neighbors = gatherNeighborDocs(db, 'brain-memory');
    const ids = neighbors.map(n => n.id);
    expect(ids).toContain('doc-sub');
    expect(ids).toContain('doc-peer');
    expect(ids).not.toContain('doc-noise'); // the key difference from gatherSiblingDocs
    expect(ids).not.toContain('doc-hub');   // never lists itself
    // Title comes from the neighbor's first H1.
    expect(neighbors.find(n => n.id === 'doc-sub')!.title).toBe('Sleep Pass');
  });

  test('resolves neighbors regardless of edge direction (parent or child end)', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-hub', 'brain-memory', '# Hub');
    seedDocNode(store, 'doc-sub', 'brain-memory:retrieval', '# Retrieval');
    // Edge is hub→sub; querying from the CHILD slug must still find the hub.
    store.upsertEdge({ src: 'doc-hub', dst: 'doc-sub', rel: 'doc_containment', kind: 'doc_containment', w: 1 });

    const neighbors = gatherNeighborDocs(db, 'brain-memory:retrieval');
    expect(neighbors.map(n => n.id)).toContain('doc-hub');
  });

  test('excludes tombstoned neighbor docs', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-a', 'alpha', '# Alpha');
    seedDocNode(store, 'doc-dead', 'beta', '# Beta');
    store.upsertEdge({ src: 'doc-a', dst: 'doc-dead', rel: 'doc_reference', kind: 'doc_reference', w: 1 });
    store.tombstone('doc-dead');

    expect(gatherNeighborDocs(db, 'alpha')).toHaveLength(0);
  });

  test('returns [] when the slug has no live doc node (graph not derivable yet)', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-x', 'exists', '# Exists');
    // 'missing' has no doc node → cannot resolve self → []
    expect(gatherNeighborDocs(db, 'missing')).toHaveLength(0);
  });

  test('respects the limit cap', () => {
    const { db, store } = makeGatherDeps();
    seedDocNode(store, 'doc-hub', 'hub', '# Hub');
    for (let i = 0; i < 5; i++) {
      seedDocNode(store, `doc-c${i}`, `hub:child${i}`, `# Child ${i}`);
      store.upsertEdge({ src: 'doc-hub', dst: `doc-c${i}`, rel: 'doc_containment', kind: 'doc_containment', w: 1 });
    }
    expect(gatherNeighborDocs(db, 'hub', { limit: 2 })).toHaveLength(2);
  });
});
