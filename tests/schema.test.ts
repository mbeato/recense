/**
 * schema.test.ts — initSchema idempotency, version guard, and index correctness (M-9, M-10, L-7).
 *
 * Covers:
 *  - SCHEMA_VERSION === 8 on a fresh DB (v8: node_temporal sidecar)
 *  - Four hot-path indexes created; two dead indexes absent (M-10, L-7)
 *  - Downgrade guard: stored > SCHEMA_VERSION → throw (M-9)
 *  - Upgrade path: stored < SCHEMA_VERSION → re-stamps (M-9)
 *  - Idempotent: running initSchema twice leaves schema_version unchanged
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';

describe('initSchema — version and indexes (M-9, M-10, L-7)', () => {
  it('stamps SCHEMA_VERSION = 8 on a fresh in-memory DB', () => {
    const db = new Database(':memory:');
    try {
      initSchema(db);
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        { value: string } | undefined;
      expect(row).toBeDefined();
      expect(Number(row!.value)).toBe(8);
      expect(SCHEMA_VERSION).toBe(8);
    } finally {
      db.close();
    }
  });

  it('creates the four new hot-path indexes (M-10, L-7)', () => {
    const db = new Database(':memory:');
    try {
      initSchema(db);

      const consolidationIndexes = (
        db.pragma('index_list(consolidation_event)') as Array<{ name: string }>
      ).map(r => r.name);
      expect(consolidationIndexes).toContain('idx_consolidation_event_node');
      expect(consolidationIndexes).toContain('idx_consolidation_event_episode');

      const episodeIndexes = (
        db.pragma('index_list(episode)') as Array<{ name: string }>
      ).map(r => r.name);
      expect(episodeIndexes).toContain('idx_episode_origin_ts');

      const edgeIndexes = (
        db.pragma('index_list(edge)') as Array<{ name: string }>
      ).map(r => r.name);
      expect(edgeIndexes).toContain('idx_edge_dst');
    } finally {
      db.close();
    }
  });

  it('does NOT create dead indexes idx_node_eviction or idx_activation_trace_ts (L-7)', () => {
    const db = new Database(':memory:');
    try {
      initSchema(db);

      const nodeIndexes = (
        db.pragma('index_list(node)') as Array<{ name: string }>
      ).map(r => r.name);
      expect(nodeIndexes).not.toContain('idx_node_eviction');

      const traceIndexes = (
        db.pragma('index_list(activation_trace)') as Array<{ name: string }>
      ).map(r => r.name);
      expect(traceIndexes).not.toContain('idx_activation_trace_ts');
    } finally {
      db.close();
    }
  });

  it('throws "newer than this binary" when stored schema_version > SCHEMA_VERSION (M-9 downgrade guard)', () => {
    const db = new Database(':memory:');
    try {
      initSchema(db); // stamps SCHEMA_VERSION (8)
      // Simulate a future DB by hand-stamping a version one above the binary
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION + 1),
      );
      expect(() => initSchema(db)).toThrow(/newer than this binary/);
    } finally {
      db.close();
    }
  });

  it('re-stamps to SCHEMA_VERSION when stored version < SCHEMA_VERSION (upgrade path)', () => {
    const db = new Database(':memory:');
    try {
      initSchema(db); // stamps SCHEMA_VERSION (8)
      // Simulate a stale v4 DB
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')").run();
      initSchema(db); // should upgrade, not throw
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        { value: string };
      expect(Number(row.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('is idempotent — running initSchema twice leaves schema_version unchanged', () => {
    const db = new Database(':memory:');
    try {
      initSchema(db);
      initSchema(db); // second run must be a no-op
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        { value: string };
      expect(Number(row.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
