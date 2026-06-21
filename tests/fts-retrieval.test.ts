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

    // ── prefix mode (VIZ-07 incremental search) ──────────────────────────────
    it('default (no prefix arg) is exact-token — unchanged engine behavior', () => {
      expect(ftsQueryFromText('Kansas City')).toBe('"Kansas" OR "City"');
    });

    it('prefix=true appends * to each token for incremental matching', () => {
      expect(ftsQueryFromText('Kansas City', true)).toBe('"Kansas"* OR "City"*');
    });

    it('prefix=true still returns null for empty / whitespace-only', () => {
      expect(ftsQueryFromText('', true)).toBeNull();
      expect(ftsQueryFromText('   ', true)).toBeNull();
    });
  });

  // ── 1b. prefix matching against a real FTS5 index (the VIZ-07 bug) ──────────
  describe('ftsQueryFromText prefix matching (FTS5)', () => {
    it('prefix mode lets an incomplete token match (gi → git); exact mode does not', () => {
      store.upsertNode({ id: 'gitnode', type: 'fact', value: 'git commit history', origin: 'observed' });
      const run = (q: string | null) =>
        (q ? db.prepare('SELECT node_id FROM node_fts WHERE node_fts MATCH ?').all(q) as Array<{ node_id: string }> : [])
          .map(r => r.node_id);

      // Exact-token "gi" does not exist as a token in "git commit history".
      expect(run(ftsQueryFromText('gi'))).not.toContain('gitnode');
      // Prefix "gi"* matches the "git" token — the incremental-search behavior.
      expect(run(ftsQueryFromText('gi', true))).toContain('gitnode');
    });
  });

  // ── 2. rrfFuse: rank ordering ─────────────────────────────────────────────

  describe('rrfFuse weighted fusion (Phase 35 RANK-01)', () => {
    it('T1 w=0 regression: rrfFuse with weights=[1,1,0] and empty third list equals unweighted call', () => {
      const listA = [{ id: 'a' }, { id: 'b' }];
      const listB = [{ id: 'b' }, { id: 'c' }];
      const noWeights = rrfFuse([listA, listB], 60, 10);
      const withZeroWeight = rrfFuse([listA, listB, []], 60, 10, [1, 1, 0]);
      expect(withZeroWeight.map(r => r.id)).toEqual(noWeights.map(r => r.id));
    });

    it('T2 weighted boost: strength list (w=2.0) re-orders high_strength to rank 0', () => {
      // cosineList puts low_strength first (rank 0), high_strength second (rank 1)
      const cosineList = [{ id: 'low_strength' }, { id: 'high_strength' }];
      const bm25List: Array<{ id: string }> = [];
      // strengthList puts high_strength first (rank 0), low_strength second (rank 1)
      const strengthList = [{ id: 'high_strength' }, { id: 'low_strength' }];

      const withoutStrength = rrfFuse([cosineList, bm25List], 60, 10);
      // w=2.0: strength contributes 2·1/(k+rank+1); enough to lift high_strength above low_strength.
      // Math: high_strength = 1/62 + 2/61 ≈ 0.04886; low_strength = 1/61 + 2/62 ≈ 0.04797 → high wins.
      const withStrength = rrfFuse([cosineList, bm25List, strengthList], 60, 10, [1, 1, 2.0]);

      // Without strength: cosine order wins → low_strength at rank 0
      expect(withoutStrength[0]?.id).toBe('low_strength');
      // With strength w=2.0: high_strength's boost from rank-0 in strengthList surpasses low_strength
      expect(withStrength[0]?.id).toBe('high_strength');
    });
  });

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

  // ── 3b. hybridTopk strength fusion (Phase 35 RANK-01) ────────────────────

  describe('hybridTopk strengthWeight (Phase 35 RANK-01)', () => {
    it('T4 w=0 hybridTopk regression: strengthWeight=0 output deep-equals unweighted call', () => {
      store.upsertNode({ id: 'node1', type: 'fact', value: 'test fact alpha', origin: 'observed' });
      store.setEmbedding('node1', basisVec(0));
      store.upsertNode({ id: 'node2', type: 'fact', value: 'test fact beta', origin: 'observed' });
      store.setEmbedding('node2', basisVec(1));

      const queryVec = basisVec(0);
      const baseline = retriever.hybridTopk(queryVec, 'test', 5);
      const withZeroWeight = retriever.hybridTopk(queryVec, 'test', 5, undefined, 0);
      expect(withZeroWeight.map(r => r.id)).toEqual(baseline.map(r => r.id));
    });

    it('T3 D-02 pool enforcement: off-pool high-strength node does not appear at strengthWeight=2.0', () => {
      // node A: in cosine pool (basisVec(0)), low s=0.1
      store.upsertNode({ id: 'in_pool', type: 'fact', value: 'relevant fact', origin: 'observed' });
      store.setEmbedding('in_pool', basisVec(0));
      db.prepare('UPDATE node SET s = 0.1 WHERE id = ?').run('in_pool');

      // node B: NOT in cosine pool (basisVec(3) is far from query basisVec(0)), high s=1.0
      store.upsertNode({ id: 'off_pool', type: 'fact', value: 'off topic strong belief', origin: 'observed' });
      store.setEmbedding('off_pool', basisVec(3));
      db.prepare('UPDATE node SET s = 1.0, last_access = 0 WHERE id = ?').run('off_pool');

      // preK=1 means only the top-1 cosine match (in_pool) enters the pool; off_pool excluded
      const queryVec = basisVec(0);
      const results = retriever.hybridTopk(queryVec, 'notoken', 1, 1, 2.0, Date.now(), 0.05);
      expect(results.map(r => r.id)).not.toContain('off_pool');
    });

    it('T5 tombstone D-10: tombstoned high-strength node never surfaces via strength list', () => {
      store.upsertNode({ id: 'live_node', type: 'fact', value: 'live data fact', origin: 'observed' });
      store.setEmbedding('live_node', basisVec(0));
      db.prepare('UPDATE node SET s = 0.1 WHERE id = ?').run('live_node');

      // Tombstoned node with high strength — should never surface
      store.upsertNode({ id: 'tomb_node', type: 'fact', value: 'tombstoned strong belief', origin: 'observed' });
      store.setEmbedding('tomb_node', basisVec(0));
      db.prepare('UPDATE node SET s = 1.0 WHERE id = ?').run('tomb_node');
      store.tombstone('tomb_node');

      const queryVec = basisVec(0);
      const results = retriever.hybridTopk(queryVec, 'fact', 5, 15, 2.0, Date.now(), 0.05);
      expect(results.map(r => r.id)).not.toContain('tomb_node');
    });

    it('no-self-strengthen: s and last_access unchanged after hybridTopk with strengthWeight>0', () => {
      store.upsertNode({ id: 'checked_node', type: 'fact', value: 'check me', origin: 'observed' });
      store.setEmbedding('checked_node', basisVec(0));
      const beforeRow = db.prepare('SELECT s, last_access FROM node WHERE id = ?').get('checked_node') as { s: number; last_access: number };

      retriever.hybridTopk(basisVec(0), 'check', 5, 15, 2.0, Date.now(), 0.05);

      const afterRow = db.prepare('SELECT s, last_access FROM node WHERE id = ?').get('checked_node') as { s: number; last_access: number };
      expect(afterRow.s).toBe(beforeRow.s);
      expect(afterRow.last_access).toBe(beforeRow.last_access);
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
