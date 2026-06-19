/**
 * corpus-generator tests (CORPUS-06, Plan 28-06).
 *
 * Covers generateCorpusDocs and computeSchemaCentroid:
 *
 * generateCorpusDocs:
 *  (a) Fills an empty schema doc stub; skips a non-empty one (idempotency).
 *  (b) Fill-in-place keeps the SAME stub node id (stable-edge invariant, BUG-2c):
 *      a seeded doc_containment edge to the stub still resolves to a live node
 *      after generation; PRAGMA foreign_key_check is empty.
 *  (c) A provider that throws on one schema does not abort the loop:
 *      generated/failed tally is correct and the other stub is filled.
 *  (d) maxDocs cap is respected: stubs beyond the cap are counted as deferred, not generated.
 *
 * computeSchemaCentroid:
 *  (e) Returns null when no D-37-gated members have embeddings.
 *  (f) Returns the correct mean for 2 seeded member embeddings.
 *
 * All tests use in-memory SQLite. The provider is a stub that returns canned markdown.
 * No real LLM calls.
 */
import Database from 'better-sqlite3';
import { describe, test, expect, vi } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { generateCorpusDocs } from '../src/consolidation/corpus-generator';
import { computeSchemaCentroid } from '../src/reader/doc-gather';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store };
}

/** Seed a live fact node (with embedding so it contributes to centroids). */
function seedFact(
  store: SemanticStore,
  db: Database.Database,
  id: string,
  embedding?: number[],
): void {
  store.upsertNode({ id, type: 'fact', value: `fact ${id}`, origin: 'observed', s: 0.5, c: 0.8, last_access: 500 });
  if (embedding) store.setEmbedding(id, new Float32Array(embedding));
}

/** Seed a live schema node. */
function seedSchema(store: SemanticStore, id: string, label: string): void {
  store.upsertNode({ id, type: 'schema', value: label, origin: 'observed', s: 0.3, c: 0.6, last_access: 400 });
}

/** Create an 'abstracts' edge from schemaId → memberId. */
function abstracts(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'abstracts', 0.8, 400, 'abstracts')",
  ).run(schemaId, memberId);
}

/**
 * Seed an empty corpus doc stub exactly as CorpusPromoter does.
 * Returns the stub's node id.
 */
function seedEmptyStub(store: SemanticStore, schemaId: string, now = 1000): string {
  const stubId = `stub-${schemaId}`;
  store.upsertNode({ id: stubId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: now });
  store.upsertNodeDoc({ node_id: stubId, slug: schemaId, generated_at: now, updated_at: now });
  store.upsertNodeScope({ node_id: stubId, scope: schemaId, updated_at: now });
  return stubId;
}

/** A stub provider that returns canned schema doc markdown. */
function makeStubProvider(
  markdownFn: (schemaId: string) => string | Error,
): { generate: (prompt: string) => Promise<string>; embed: never; judge: never; judgeBatch: never } {
  return {
    generate: vi.fn(async (prompt: string): Promise<string> => {
      // Extract the schemaId from "thesis" line in the prompt (schema doc format).
      // The prompt contains the schemaLabel; we key off a discriminator injected by the test.
      // Instead: let callers inject a single canned markdown; schemaId extracted from the stub.
      // We use a closure that maps by call order — simpler + no prompt-parsing dependency.
      const result = typeof markdownFn === 'function'
        ? markdownFn(prompt)
        : markdownFn;
      if (result instanceof Error) throw result;
      return result as string;
    }),
    embed: undefined as never,
    judge: undefined as never,
    judgeBatch: undefined as never,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('generateCorpusDocs', () => {

  test('(a) fills an empty stub; skips a non-empty stub (idempotency)', async () => {
    const { db, store } = makeDb();

    // Schema A: has an empty stub → should be filled
    const schemaA = 'schema-a-fill';
    seedSchema(store, schemaA, 'Schema A Label');
    seedFact(store, db, 'fact-a1');
    abstracts(db, schemaA, 'fact-a1');
    const stubAId = seedEmptyStub(store, schemaA);

    // Schema B: has a non-empty stub → should be skipped
    const schemaB = 'schema-b-skip';
    seedSchema(store, schemaB, 'Schema B Label');
    const stubBId = `stub-${schemaB}`;
    store.upsertNode({ id: stubBId, type: 'doc', value: '# Already generated\n\ncontent', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: stubBId, slug: schemaB, generated_at: 1000, updated_at: 1000 });
    store.upsertNodeScope({ node_id: stubBId, scope: schemaB, updated_at: 1000 });

    const provider = makeStubProvider(() => '# Schema A\n\nGenerated prose for schema A.');
    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, now: 2000 },
    );

    // Tally: 1 generated, 0 failed, 0 deferred
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(0);

    // Stub A filled with prose
    const docA = db.prepare('SELECT value FROM node WHERE id = ?').get(stubAId) as { value: string } | undefined;
    expect(docA?.value).toContain('# Schema A');

    // Stub B unchanged (still has original content)
    const docB = db.prepare('SELECT value FROM node WHERE id = ?').get(stubBId) as { value: string } | undefined;
    expect(docB?.value).toContain('# Already generated');
  });

  test('(b) fill-in-place keeps the SAME stub node id; corpus edge still resolves; FK clean', async () => {
    const { db, store } = makeDb();

    // Parent stub
    const schemaParent = 'schema-parent-stable';
    seedSchema(store, schemaParent, 'Parent Schema');
    seedFact(store, db, 'fact-p1');
    abstracts(db, schemaParent, 'fact-p1');
    const parentStubId = seedEmptyStub(store, schemaParent);

    // Child stub (already has content — so only the parent is generated this pass)
    const schemaChild = 'schema-child-stable';
    seedSchema(store, schemaChild, 'Child Schema');
    const childStubId = `stub-${schemaChild}`;
    store.upsertNode({ id: childStubId, type: 'doc', value: '# Child', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: childStubId, slug: schemaChild, generated_at: 1000, updated_at: 1000 });
    store.upsertNodeScope({ node_id: childStubId, scope: schemaChild, updated_at: 1000 });

    // Corpus containment edge: parentStub → childStub (as CorpusPromoter writes)
    store.upsertEdge({
      src: parentStubId,
      dst: childStubId,
      rel: 'doc_containment',
      kind: 'doc_containment',
      w: 0.9,
      last_access: 1000,
    });

    const preNodeId = parentStubId; // the id BEFORE generation

    const provider = makeStubProvider(() => '# Parent Schema\n\nGenerated.');
    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, now: 2000 },
    );

    expect(result.generated).toBe(1);

    // Same node id — fill-in-place (stable-edge invariant)
    const docNode = db.prepare('SELECT id, value, tombstoned FROM node WHERE id = ?').get(preNodeId) as
      | { id: string; value: string; tombstoned: number }
      | undefined;
    expect(docNode).toBeDefined();
    expect(docNode!.id).toBe(preNodeId);
    expect(docNode!.tombstoned).toBe(0);
    expect(docNode!.value.length).toBeGreaterThan(0);

    // Containment edge still points at a LIVE parent (not dangling)
    const edge = db.prepare(
      "SELECT src, dst FROM edge WHERE kind = 'doc_containment'",
    ).get() as { src: string; dst: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.src).toBe(parentStubId); // unchanged stub id

    const parent = db.prepare('SELECT tombstoned FROM node WHERE id = ?').get(edge!.src) as { tombstoned: number };
    expect(parent.tombstoned).toBe(0); // forest survives

    // FK clean
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    expect(fkViolations).toHaveLength(0);
  });

  test('(c) provider throws on one schema → other stubs still filled; tally correct', async () => {
    const { db, store } = makeDb();

    // Schema X: provider will throw
    const schemaX = 'schema-x-throws';
    seedSchema(store, schemaX, 'Schema X Throws');
    seedFact(store, db, 'fact-x1');
    abstracts(db, schemaX, 'fact-x1');
    const stubXId = seedEmptyStub(store, schemaX);

    // Schema Y: provider will succeed
    const schemaY = 'schema-y-succeeds';
    seedSchema(store, schemaY, 'Schema Y Succeeds');
    seedFact(store, db, 'fact-y1');
    abstracts(db, schemaY, 'fact-y1');
    const stubYId = seedEmptyStub(store, schemaY);

    // Provider: throw for schema X's label; succeed for schema Y.
    let callCount = 0;
    const mockProvider = {
      generate: vi.fn(async (_prompt: string): Promise<string> => {
        callCount++;
        if (callCount === 1) {
          throw new Error('simulated LLM failure for schema X');
        }
        return '# Schema Y\n\nSuccess.';
      }),
      embed: undefined as never,
      judge: undefined as never,
      judgeBatch: undefined as never,
    };

    const logs: string[] = [];
    const result = await generateCorpusDocs(
      { db, store, provider: mockProvider as any },
      { maxDocs: 25, log: (m) => logs.push(m), now: 2000 },
    );

    // 1 generated (Y), 1 failed (X), 0 deferred
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deferred).toBe(0);

    // X is still empty (the throw prevented writeDoc)
    const docX = db.prepare('SELECT value FROM node WHERE id = ?').get(stubXId) as { value: string };
    expect(docX.value.trim()).toBe('');

    // Y is filled
    const docY = db.prepare('SELECT value FROM node WHERE id = ?').get(stubYId) as { value: string };
    expect(docY.value).toContain('# Schema Y');

    // A failure log line should exist
    const failLine = logs.find(l => l.includes('failed for schema') && l.includes(schemaX));
    expect(failLine).toBeDefined();
  });

  test('(d) maxDocs cap: stubs beyond cap are deferred, not generated', async () => {
    const { db, store } = makeDb();

    // Seed 3 empty stubs
    for (let i = 0; i < 3; i++) {
      const schemaId = `schema-cap-${i}`;
      seedSchema(store, schemaId, `Schema Cap ${i}`);
      seedFact(store, db, `fact-cap-${i}`);
      abstracts(db, schemaId, `fact-cap-${i}`);
      seedEmptyStub(store, schemaId);
    }

    const provider = makeStubProvider(() => '# Schema\n\nContent.');
    const logs: string[] = [];

    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 2, log: (m) => logs.push(m), now: 2000 },  // cap = 2
    );

    // Only 2 generated, 1 deferred
    expect(result.generated).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(1);

    // A deferred log line should be emitted
    const deferLine = logs.find(l => l.includes('deferring'));
    expect(deferLine).toBeDefined();

    // Exactly 2 doc nodes should have non-empty prose
    const filledDocs = db.prepare(
      "SELECT COUNT(*) as n FROM node WHERE type='doc' AND tombstoned=0 AND length(value) > 0",
    ).get() as { n: number };
    expect(filledDocs.n).toBe(2);
  });

});

// ── computeSchemaCentroid ──────────────────────────────────────────────────

describe('computeSchemaCentroid', () => {

  test('(e) returns null when no D-37-gated members have embeddings', () => {
    const { db, store } = makeDb();

    const schemaId = 'schema-no-embed';
    seedSchema(store, schemaId, 'Schema Without Embeddings');

    // Add a fact member with NO embedding
    store.upsertNode({ id: 'fact-no-embed', type: 'fact', value: 'no embedding', origin: 'observed', s: 0.5, c: 0.8, last_access: 500 });
    abstracts(db, schemaId, 'fact-no-embed');

    const result = computeSchemaCentroid(db, schemaId);
    expect(result).toBeNull();
  });

  test('(e-2) returns null for a schema with no members at all', () => {
    const { db, store } = makeDb();
    seedSchema(store, 'schema-empty', 'Empty Schema');

    const result = computeSchemaCentroid(db, 'schema-empty');
    expect(result).toBeNull();
  });

  test('(e-3) excludes inferred members (D-37 firewall)', () => {
    const { db, store } = makeDb();
    const schemaId = 'schema-d37';
    seedSchema(store, schemaId, 'D37 Schema');

    // Member with origin='inferred' and embedding — D-37 gate must exclude it
    store.upsertNode({ id: 'fact-inferred', type: 'fact', value: 'inferred', origin: 'inferred', s: 0, c: 1.0, last_access: 500 });
    store.setEmbedding('fact-inferred', new Float32Array([1, 0, 0, 0]));
    abstracts(db, schemaId, 'fact-inferred');

    // Result must be null — only the inferred node has an embedding but it is gated out
    const result = computeSchemaCentroid(db, schemaId);
    expect(result).toBeNull();
  });

  test('(f) returns the correct mean for 2 seeded member embeddings', () => {
    const { db, store } = makeDb();
    const schemaId = 'schema-centroid';
    seedSchema(store, schemaId, 'Centroid Schema');

    // Fact 1: [1, 0, 0, 0]
    seedFact(store, db, 'fact-c1', [1, 0, 0, 0]);
    abstracts(db, schemaId, 'fact-c1');

    // Fact 2: [0, 1, 0, 0]
    seedFact(store, db, 'fact-c2', [0, 1, 0, 0]);
    abstracts(db, schemaId, 'fact-c2');

    const result = computeSchemaCentroid(db, schemaId);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);

    // Mean of [1,0,0,0] and [0,1,0,0] → [0.5, 0.5, 0, 0]
    expect(result![0]).toBeCloseTo(0.5);
    expect(result![1]).toBeCloseTo(0.5);
    expect(result![2]).toBeCloseTo(0);
    expect(result![3]).toBeCloseTo(0);
  });

  test('(f-2) tombstoned members are excluded from the centroid', () => {
    const { db, store } = makeDb();
    const schemaId = 'schema-tomb';
    seedSchema(store, schemaId, 'Tombstone Schema');

    // Live fact: [1, 0, 0, 0]
    seedFact(store, db, 'fact-live', [1, 0, 0, 0]);
    abstracts(db, schemaId, 'fact-live');

    // Tombstoned fact: [0, 1, 0, 0] — should not contribute to centroid
    seedFact(store, db, 'fact-tomb', [0, 1, 0, 0]);
    store.tombstone('fact-tomb');
    abstracts(db, schemaId, 'fact-tomb');

    const result = computeSchemaCentroid(db, schemaId);
    expect(result).not.toBeNull();
    // Only live fact contributes → centroid = [1, 0, 0, 0]
    expect(result![0]).toBeCloseTo(1.0);
    expect(result![1]).toBeCloseTo(0.0);
  });

});
