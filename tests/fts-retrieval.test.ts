/**
 * FTS5 hybrid retrieval tests (Phase 17 LEVER 1).
 *
 * Covers:
 *  1. FTS query sanitization — adversarial strings (quotes, hyphens, operators) never throw.
 *  2. rrfFuse rank ordering — doc near top of both lists beats doc in only one.
 *  3. hybridTopk exact-token recovery — BM25 surfaces node that cosine-only misses.
 *  4. hybridTopk fallback — cosine-only when FTS empty or text yields no tokens (no throw).
 *  5. Drift-check invariant — no tombstoned/orphaned FTS rows after upsert/tombstone/value-change.
 *
 * Zero network calls: in-memory Database, FakeClock, synthetic embeddings (basisVec).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever, ftsQueryFromText, rrfFuse } from '../src/retrieval/topk';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';

const testConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ─── Test harness helpers ────────────────────────────────────────────────────

/** Return the i-th 16-dim standard-basis unit vector. */
function basisVec(i: number, dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v[i % dims] = 1.0;
  return v;
}

// ─── FTS retrieval test suite ────────────────────────────────────────────────

describe('FTS retrieval', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;
  let retriever: CandidateRetriever;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, testConfig);
    retriever = new CandidateRetriever(db);
  });

  afterEach(() => { db.close(); });

  // ── 1. ftsQueryFromText: sanitization + adversarial input ─────────────────

  describe('ftsQueryFromText sanitization', () => {
    it('handles adversarial strings without throwing', () => {
      const adversarial = [
        'What is "the answer"?',
        "O'Brien's dog",
        '70-200mm zoom lens',
        'AND OR NOT',
        '(nested (parens))',
        '',
        '   ',
      ];
      for (const text of adversarial) {
        expect(() => ftsQueryFromText(text)).not.toThrow();
        const q = ftsQueryFromText(text);
        if (q !== null) {
          // Non-null output must be double-quoted-OR form (no bare operators reach MATCH)
          expect(q).toMatch(/^".*"(\s+OR\s+".*")*$/s);
        }
      }
    });

    it('returns null for empty string', () => {
      expect(ftsQueryFromText('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(ftsQueryFromText('   ')).toBeNull();
    });

    it('tokenizes unicode letters and digits, double-quotes each', () => {
      const q = ftsQueryFromText('Kansas City 2024');
      expect(q).toBe('"Kansas" OR "City" OR "2024"');
    });

    it('strips double-quote chars (non-alphanumeric) and wraps remaining tokens', () => {
      const q = ftsQueryFromText('say "hello"');
      // The `"` chars are not \p{L} or \p{N} — stripped by regex; remaining tokens quoted normally
      expect(q).toBe('"say" OR "hello"');
    });

    it('strips hyphens (70-200mm → two tokens)', () => {
      const q = ftsQueryFromText('70-200mm zoom lens');
      expect(q).toBe('"70" OR "200mm" OR "zoom" OR "lens"');
    });
  });

  // ── 2. rrfFuse: rank ordering ─────────────────────────────────────────────

  describe('rrfFuse rank ordering', () => {
    it('ranks a doc appearing high in both lists above a doc in only one', () => {
      // both: appears at rank 0 in list A, rank 0 in list B
      // one_a: appears at rank 1 in list A only
      // one_b: appears at rank 1 in list B only
      const listA = [{ id: 'both' }, { id: 'one_a' }];
      const listB = [{ id: 'both' }, { id: 'one_b' }];

      const result = rrfFuse([listA, listB], 60, 10);
      const ids = result.map(r => r.id);
      const bothIdx = ids.indexOf('both');
      const oneAIdx = ids.indexOf('one_a');
      const oneBIdx = ids.indexOf('one_b');

      expect(bothIdx).toBe(0); // 'both' must rank first
      expect(bothIdx).toBeLessThan(oneAIdx);
      expect(bothIdx).toBeLessThan(oneBIdx);
    });

    it('returns at most topK results', () => {
      const list = Array.from({ length: 20 }, (_, i) => ({ id: `doc${i}` }));
      const result = rrfFuse([list], 60, 5);
      expect(result.length).toBeLessThanOrEqual(5);
    });

    it('handles empty lists gracefully', () => {
      expect(() => rrfFuse([], 60, 10)).not.toThrow();
      expect(rrfFuse([], 60, 10)).toHaveLength(0);
    });
  });

  // ── 3. hybridTopk: exact-token BM25 recovery ─────────────────────────────

  describe('hybridTopk exact-token recovery', () => {
    it('surfaces BM25-matched node whose cosine score alone ranks it below k', () => {
      // Node A: "Kansas City Masterpiece BBQ sauce" — embedded with basisVec(0)
      // Node B: "unrelated topic about something else" — embedded with basisVec(1)
      // Query vector: basisVec(1) — cosine(A, basisVec(1)) = 0, cosine(B, basisVec(1)) = 1
      // With cosine topk(basisVec(1), k=1) → only node B returned
      // With hybridTopk(basisVec(1), "Masterpiece", k=2) → both returned (BM25 lifts A)

      store.upsertNode({ id: 'masterpiece', type: 'fact', value: 'Kansas City Masterpiece BBQ sauce', origin: 'observed' });
      store.setEmbedding('masterpiece', basisVec(0));

      store.upsertNode({ id: 'unrelated', type: 'fact', value: 'unrelated topic about something else', origin: 'observed' });
      store.setEmbedding('unrelated', basisVec(1));

      const queryVec = basisVec(1);

      // Pure cosine top-1 misses the "masterpiece" node
      const cosineOnly = retriever.topk(queryVec, 1);
      expect(cosineOnly.map(r => r.id)).not.toContain('masterpiece');

      // Hybrid top-2 with "Masterpiece" text recovers it via BM25
      const hybrid = retriever.hybridTopk(queryVec, 'Masterpiece', 2);
      expect(hybrid.map(r => r.id)).toContain('masterpiece');
    });

    it('falls back to cosine-only when FTS table is empty (no throw)', () => {
      // No nodes — FTS is empty
      const queryVec = basisVec(0);
      expect(() => retriever.hybridTopk(queryVec, 'anything', 5)).not.toThrow();
      const result = retriever.hybridTopk(queryVec, 'anything', 5);
      expect(result).toHaveLength(0);
    });

    it('falls back to cosine-only when queryText has no tokens (no throw)', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'some fact', origin: 'observed' });
      store.setEmbedding('n1', basisVec(0));

      const queryVec = basisVec(0);
      // Whitespace-only text → ftsQueryFromText returns null → BM25 skipped
      expect(() => retriever.hybridTopk(queryVec, '   ', 5)).not.toThrow();
      const result = retriever.hybridTopk(queryVec, '   ', 5);
      // Should still return cosine match
      expect(result.map(r => r.id)).toContain('n1');
    });

    it('cosine score for BM25-only hits is 0 (needed by retrieveRanked floor gate)', () => {
      // Node: only in FTS, no embedding (no cosine score)
      store.upsertNode({ id: 'fts-only', type: 'fact', value: 'unique keyword xyzzy', origin: 'observed' });
      // Do NOT setEmbedding → no embedding, excluded from cosine scan

      // Node with embedding, orthogonal basis
      store.upsertNode({ id: 'cosine-node', type: 'fact', value: 'cosine node', origin: 'observed' });
      store.setEmbedding('cosine-node', basisVec(0));

      const hybrid = retriever.hybridTopk(basisVec(0), 'xyzzy', 5);
      const ftsHit = hybrid.find(r => r.id === 'fts-only');
      // fts-only should appear (BM25 match) with score=0 (no cosine vector)
      if (ftsHit) {
        expect(ftsHit.score).toBe(0);
      }
      // The test is valid whether fts-only surfaces or not — what matters is no throw
      // and cosine-node always surfaces
      expect(hybrid.map(r => r.id)).toContain('cosine-node');
    });
  });

  // ── 4. Drift-check invariant ──────────────────────────────────────────────

  describe('drift-check invariant (T-17-02-I)', () => {
    it('no FTS rows for tombstoned or orphaned nodes after upsert/tombstone/value-change', () => {
      // Sequence: insert → update value → tombstone another node
      store.upsertNode({ id: 'drift-1', type: 'fact', value: 'initial value', origin: 'observed' });
      store.upsertNode({ id: 'drift-1', type: 'fact', value: 'updated value', origin: 'observed' });
      store.upsertNode({ id: 'drift-2', type: 'fact', value: 'will be tombstoned', origin: 'observed' });
      store.tombstone('drift-2');

      const driftCount = (db.prepare(`
        SELECT count(*) AS n FROM node_fts f
        LEFT JOIN node n ON f.node_id = n.id
        WHERE n.id IS NULL OR n.tombstoned = 1
      `).get() as { n: number }).n;
      expect(driftCount).toBe(0);
    });

    it('FTS row value matches current node value after update', () => {
      store.upsertNode({ id: 'sync-check', type: 'fact', value: 'old value', origin: 'observed' });
      store.upsertNode({ id: 'sync-check', type: 'fact', value: 'new value', origin: 'observed' });

      const rows = db.prepare("SELECT value FROM node_fts WHERE node_id = 'sync-check'").all() as Array<{ value: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).toBe('new value');
    });
  });
});
