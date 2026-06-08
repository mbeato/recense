/**
 * eval-snapshot tests (SEAM-03, D-51/D-52/D-53).
 *
 * Task 1 (unit): recordSnapshot inserts correctly; replaySnapshots distinguishes
 *   match (cosine ≥ τ) from regression (cosine < τ) on the deterministic LLM-free path.
 * Task 2 (round-trip): engine-level round-trip against a COPY of brain.db —
 *   record one snapshot from a real top-ranked node, replay, assert matched=1 regressions=0.
 *   Guarded by fs.existsSync('brain.db') AND process.env.OPENAI_API_KEY — skipped when absent.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { recordSnapshot, replaySnapshots } from '../src/eval/snapshot';

const BASE_CONFIG = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

describe('eval-snapshot', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, BASE_CONFIG);
  });

  afterEach(() => { db.close(); });

  /** Insert a live node with a known embedding (1536-dim basis vector). */
  function addEmbeddedNode(id: string, value: string, vec: Float32Array, s = 0.5): void {
    store.upsertNode({ id, type: 'fact', value, origin: 'observed', s });
    store.setEmbedding(id, vec);
  }

  /** Return the i-th unit basis vector of given dimensionality. */
  function basisVec(i: number, dims = 1536): Float32Array {
    const v = new Float32Array(dims);
    v[i % dims] = 1.0;
    return v;
  }

  // ─── recordSnapshot ────────────────────────────────────────────────────────

  describe('recordSnapshot', () => {
    it('inserts one eval_snapshot row and returns the new id', () => {
      const ts = Date.UTC(2026, 0, 1);
      const id = recordSnapshot(db, { query: 'test query', expectedAnswer: 'test answer', ts });

      const row = db.prepare('SELECT * FROM eval_snapshot WHERE id = ?').get(id) as {
        id: string; ts: number; query: string; expected_answer: string; created_session: string | null;
      } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe(id);
      expect(row!.query).toBe('test query');
      expect(row!.expected_answer).toBe('test answer');
      expect(row!.ts).toBe(ts);
    });

    it('returns a non-empty string id (UUID)', () => {
      const id = recordSnapshot(db, { query: 'q', expectedAnswer: 'a', ts: 1000 });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('stores an optional created_session value', () => {
      const id = recordSnapshot(db, { query: 'q', expectedAnswer: 'a', ts: 1000, sessionId: 'ses-1' });
      const row = db.prepare('SELECT created_session FROM eval_snapshot WHERE id = ?').get(id) as
        { created_session: string | null } | undefined;
      expect(row!.created_session).toBe('ses-1');
    });

    it('uses null for created_session when sessionId is absent', () => {
      const id = recordSnapshot(db, { query: 'q', expectedAnswer: 'a', ts: 1000 });
      const row = db.prepare('SELECT created_session FROM eval_snapshot WHERE id = ?').get(id) as
        { created_session: string | null } | undefined;
      expect(row!.created_session).toBeNull();
    });
  });

  // ─── replaySnapshots — empty table ─────────────────────────────────────────

  describe('replaySnapshots — empty table', () => {
    it('returns empty array when no snapshots exist', async () => {
      const embed = async (texts: string[]): Promise<Float32Array[]> =>
        texts.map(() => new Float32Array(1536));
      const results = await replaySnapshots(db, embed, BASE_CONFIG);
      expect(results).toHaveLength(0);
    });
  });

  // ─── replaySnapshots — match ────────────────────────────────────────────────

  describe('replaySnapshots — match (cosine ≥ τ)', () => {
    it('returns match=true when actual answer text matches expected (cosine ≈ 1.0 ≥ τ)', async () => {
      // Node with value "expected answer" has embedding = basisVec(0)
      const nodeVec = basisVec(0);
      addEmbeddedNode('n1', 'expected answer', nodeVec, 0.9);

      // Snapshot: expected_answer = "expected answer"
      recordSnapshot(db, { query: 'test query', expectedAnswer: 'expected answer', ts: clock.nowMs() });

      // Mock embed: every text maps to nodeVec so:
      //   embed(["test query"]) → [nodeVec] → retrieval finds n1 → actual = "expected answer"
      //   embed(["expected answer", "expected answer"]) → [nodeVec, nodeVec] → cosine = 1.0
      const embed = async (texts: string[]): Promise<Float32Array[]> =>
        texts.map(() => nodeVec);

      const results = await replaySnapshots(db, embed, BASE_CONFIG);

      expect(results).toHaveLength(1);
      expect(results[0]!.match).toBe(true);
      expect(results[0]!.cosine).toBeGreaterThanOrEqual(BASE_CONFIG.snapshotMatchThreshold);
      expect(results[0]!.expected).toBe('expected answer');
      expect(results[0]!.actual).toBe('expected answer');
    });
  });

  // ─── replaySnapshots — regression ──────────────────────────────────────────

  describe('replaySnapshots — regression (cosine < τ)', () => {
    it('returns match=false when actual answer drifted to orthogonal embedding', async () => {
      // Node has value "new answer" with embedding = basisVec(0) (dimension 0)
      const vec0 = basisVec(0);  // query → finds n1 (actual = "new answer")
      const vec1 = basisVec(1);  // orthogonal → represents "old expected answer"
      addEmbeddedNode('n1', 'new answer', vec0, 0.9);

      // Snapshot was blessed with a different expected_answer
      recordSnapshot(db, { query: 'test query', expectedAnswer: 'old expected answer', ts: clock.nowMs() });

      // Mock embed:
      //   embed(["test query"]) → [vec0] → retrieval finds n1 → actual = "new answer"
      //   embed(["old expected answer", "new answer"]) → [vec1, vec0] → cosine = 0.0
      const embed = async (texts: string[]): Promise<Float32Array[]> =>
        texts.map(t => t === 'old expected answer' ? vec1 : vec0);

      const results = await replaySnapshots(db, embed, BASE_CONFIG);

      expect(results).toHaveLength(1);
      expect(results[0]!.match).toBe(false);
      expect(results[0]!.cosine).toBeLessThan(BASE_CONFIG.snapshotMatchThreshold);
      expect(results[0]!.expected).toBe('old expected answer');
      expect(results[0]!.actual).toBe('new answer');
    });
  });

  // ─── replaySnapshots — result shape ────────────────────────────────────────

  describe('replaySnapshots — result shape', () => {
    it('returns id, query, expected, actual, cosine, match fields', async () => {
      const nodeVec = basisVec(0);
      addEmbeddedNode('n1', 'answer', nodeVec, 0.5);
      const id = recordSnapshot(db, { query: 'q', expectedAnswer: 'answer', ts: 1000 });

      const embed = async (texts: string[]): Promise<Float32Array[]> =>
        texts.map(() => nodeVec);
      const results = await replaySnapshots(db, embed, BASE_CONFIG);

      expect(results).toHaveLength(1);
      const r = results[0]!;
      expect(r.id).toBe(id);
      expect(r.query).toBe('q');
      expect(r.expected).toBe('answer');
      expect(typeof r.actual).toBe('string');
      expect(typeof r.cosine).toBe('number');
      expect(typeof r.match).toBe('boolean');
    });
  });

  // ─── Task 2: round-trip on real brain.db copy ──────────────────────────────
  // Guarded: skipped when brain.db absent or OPENAI_API_KEY not set

  describe('round-trip on real brain.db copy', () => {
    const BRAIN_DB = path.resolve('brain.db');
    const hasDb = fs.existsSync(BRAIN_DB);
    const hasApiKey = !!process.env['OPENAI_API_KEY'];
    const skipReason = !hasDb
      ? 'brain.db not found (CI guard)'
      : !hasApiKey
        ? 'OPENAI_API_KEY not set (CI guard)'
        : null;

    it.skipIf(!!skipReason)(`record→replay matched=1 regressions=0 (ROADMAP SC3 / D-54)`, async () => {
      // Copy brain.db to a tmp path so we never touch the real store
      const tmpDb = path.join(require('os').tmpdir(), `seam03-snap-test-${Date.now()}.db`);
      fs.copyFileSync(BRAIN_DB, tmpDb);
      const copyDb = new Database(tmpDb);

      try {
        // Add eval_snapshot table (idempotent)
        initSchema(copyDb);

        // Find the top-ranked node (highest s, has embedding, not tombstoned)
        const topNode = copyDb.prepare(
          'SELECT id, value FROM node WHERE tombstoned=0 AND embedding IS NOT NULL ORDER BY s DESC LIMIT 1'
        ).get() as { id: string; value: string } | undefined;

        expect(topNode).toBeDefined();
        const expectedValue = topNode!.value;

        // Record: query = expectedValue (so embed(query) ≈ embed(expectedValue))
        const ts = Date.now();
        const snapId = recordSnapshot(copyDb, { query: expectedValue, expectedAnswer: expectedValue, ts });
        expect(typeof snapId).toBe('string');

        // Replay with real DefaultModelProvider embed
        const { DefaultModelProvider } = await import('../src/model/provider');
        const config = { ...DEFAULT_CONFIG, dbPath: tmpDb };
        const provider = new DefaultModelProvider({
          generateConfig: config,
          judgeConfig: config,
          embedConfig: config,
        });

        const results = await replaySnapshots(copyDb, provider.embed.bind(provider), config);

        expect(results).toHaveLength(1);
        expect(results[0]!.match).toBe(true);

        const regressions = results.filter(r => !r.match);
        expect(regressions).toHaveLength(0);
      } finally {
        copyDb.close();
        try { fs.unlinkSync(tmpDb); } catch { /* best-effort cleanup */ }
      }
    });
  });
});
