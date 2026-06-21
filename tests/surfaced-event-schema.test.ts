/**
 * Schema round-trip test for surfaced_event (Phase 21-01, SURF-02).
 *
 * Proves:
 *   1. initSchema creates surfaced_event with exactly the 7 expected columns
 *   2. schema_version meta value is '9' after initSchema
 *   3. outcome CHECK constraint rejects non-enum values
 *   4. UNIQUE(node_id, occurrence_due_at) rejects duplicate occurrence keys
 *   5. Double-initSchema is idempotent (additive migration safety)
 *   6. FK reference resolves: a node row seeded first allows surfaced_event to reference it
 *
 * Pure DB-layer — no HTTP, no engine, no LLM.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `surfaced-event-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Seed a minimal node row so FK references resolve. */
function seedNode(db: Database.Database, nodeId: string): void {
  db.prepare(`
    INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access, pending_contradictions, tombstoned, training_eligible)
    VALUES (?, 'fact', 'test value', 'hash1', 'observed', 0.1, 0.5, ?, '[]', 0, 0)
  `).run(nodeId, Date.now());
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDbPath: string;

afterEach(() => {
  if (tmpDbPath) {
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('surfaced_event schema (21-01)', () => {

  it('creates surfaced_event with exactly 7 expected columns', () => {
    tmpDbPath = makeTempDbPath();
    const db = new Database(tmpDbPath);
    try {
      initSchema(db);
      const cols = (db.pragma('table_info(surfaced_event)') as Array<{ name: string }>)
        .map(r => r.name);
      expect(cols).toHaveLength(7);
      expect(cols).toContain('id');
      expect(cols).toContain('node_id');
      expect(cols).toContain('occurrence_due_at');
      expect(cols).toContain('outcome');
      expect(cols).toContain('snooze_until');
      expect(cols).toContain('created_at');
      expect(cols).toContain('updated_at');
    } finally {
      db.close();
    }
  });

  it('schema_version meta is "13" after initSchema (v13: insight + derived_from + node_insight)', () => {
    tmpDbPath = makeTempDbPath();
    const db = new Database(tmpDbPath);
    try {
      initSchema(db);
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe('13');
    } finally {
      db.close();
    }
  });

  it('rejects outcome not in the enum (CHECK constraint)', () => {
    tmpDbPath = makeTempDbPath();
    const db = new Database(tmpDbPath);
    try {
      initSchema(db);
      seedNode(db, 'check-node');
      const nowMs = Date.now();
      expect(() => {
        db.prepare(`
          INSERT INTO surfaced_event (node_id, occurrence_due_at, outcome, created_at, updated_at)
          VALUES ('check-node', '2026-06-16T00:00:00.000Z', 'banana', ?, ?)
        `).run(nowMs, nowMs);
      }).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects duplicate (node_id, occurrence_due_at) (UNIQUE constraint)', () => {
    tmpDbPath = makeTempDbPath();
    const db = new Database(tmpDbPath);
    try {
      initSchema(db);
      seedNode(db, 'unique-node');
      const nowMs = Date.now();
      const occurrenceDueAt = '2026-06-16T10:00:00.000Z';
      db.prepare(`
        INSERT INTO surfaced_event (node_id, occurrence_due_at, outcome, created_at, updated_at)
        VALUES ('unique-node', ?, 'surfaced', ?, ?)
      `).run(occurrenceDueAt, nowMs, nowMs);
      expect(() => {
        db.prepare(`
          INSERT INTO surfaced_event (node_id, occurrence_due_at, outcome, created_at, updated_at)
          VALUES ('unique-node', ?, 'seen', ?, ?)
        `).run(occurrenceDueAt, nowMs + 1, nowMs + 1);
      }).toThrow();
    } finally {
      db.close();
    }
  });

  it('initSchema twice is idempotent — no throw, table still present', () => {
    tmpDbPath = makeTempDbPath();
    const db = new Database(tmpDbPath);
    try {
      initSchema(db);
      // Second call must not throw
      expect(() => initSchema(db)).not.toThrow();
      // Table must still exist
      const cols = (db.pragma('table_info(surfaced_event)') as Array<{ name: string }>)
        .map(r => r.name);
      expect(cols).toHaveLength(7);
    } finally {
      db.close();
    }
  });

  it('FK reference resolves — node seeded first lets surfaced_event reference it', () => {
    tmpDbPath = makeTempDbPath();
    const db = new Database(tmpDbPath);
    try {
      initSchema(db);
      seedNode(db, 'fk-node');
      const nowMs = Date.now();
      // Should not throw (FK resolves to the seeded node)
      expect(() => {
        db.prepare(`
          INSERT INTO surfaced_event (node_id, occurrence_due_at, outcome, created_at, updated_at)
          VALUES ('fk-node', '2026-06-16T12:00:00.000Z', 'surfaced', ?, ?)
        `).run(nowMs, nowMs);
      }).not.toThrow();
      // Verify the row was inserted
      const row = db.prepare("SELECT outcome FROM surfaced_event WHERE node_id = 'fk-node'")
        .get() as { outcome: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.outcome).toBe('surfaced');
    } finally {
      db.close();
    }
  });

});
