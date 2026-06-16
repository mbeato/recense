/**
 * tests/memory-ops-surface.test.ts — TDD RED for surface() + surfaceSeen() ops (Plan 21-03, Task 1).
 *
 * Behavior under test:
 *   - surface(opts?) returns SurfaceItem[] from SurfaceStore.rank() via the read-path store;
 *     acquires NO lock.
 *   - surfaceSeen({node_id, occurrence_due_at, outcome?, snooze_until?}) acquires the write lock,
 *     upserts one surfaced_event row, releases in finally; returns { status: 'recorded' }.
 *   - Calling surfaceSeen twice with the same (node_id, occurrence_due_at) leaves exactly one row
 *     (idempotent upsert), with the second call's outcome/snooze_until/updated_at winning and
 *     created_at unchanged.
 *   - surfaceSeen on a node_id that does not exist throws SurfaceTargetNotFoundError.
 *
 * These tests MUST FAIL before Task 1 implementation (RED state):
 *   ops.surface / ops.surfaceSeen are not yet on MemoryOps; SurfaceTargetNotFoundError not yet exported.
 *
 * Harness: temp file DB (better-sqlite3 cannot open :memory: readonly),
 * MockModelProvider (offline), hermetic per-test lock path (DEBT-02).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { wireMemoryEngine, MemoryBusyError, SurfaceTargetNotFoundError } from '../src/adapter/memory-ops';
import { MockModelProvider } from '../src/model/provider';
import type { SurfaceItem } from '../src/db/surface-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `memory-ops-surface-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

// ---------------------------------------------------------------------------
// Per-test fixtures
// ---------------------------------------------------------------------------

const MOCK_PROVIDER = new MockModelProvider({ embedFn: () => new Float32Array([0.1, 0.2, 0.3]) });

type OpsWithSurface = {
  surface: (opts?: Record<string, unknown>) => Promise<SurfaceItem[]>;
  surfaceSeen: (params: {
    node_id: string;
    occurrence_due_at: string;
    outcome?: string;
    snooze_until?: string | null;
  }) => Promise<{ status: string }>;
};

let tmpDbPath: string;
let tmpLockPath: string;
let ops: OpsWithSurface;
let closeFn: () => void;
let checkDb: Database.Database;

beforeEach(async () => {
  tmpDbPath = makeTempDbPath();
  tmpLockPath = path.join(os.tmpdir(), `ops-surface-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
  process.env['RECENSE_LOCK_PATH'] = tmpLockPath;

  // Must use a file-based DB — better-sqlite3 cannot open :memory: with { readonly: true }
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();

  const wired = await wireMemoryEngine({
    dbPath: tmpDbPath,
    provider: MOCK_PROVIDER,
    source: 'test',
    separateReadHandle: true,
  });

  // Cast to wide type since surface/surfaceSeen are not yet on MemoryOps (RED state)
  ops = wired.ops as unknown as OpsWithSurface;
  closeFn = wired.close;

  // Separate handle for post-call DB inspection
  checkDb = new Database(tmpDbPath);
});

afterEach(() => {
  checkDb.close();
  closeFn();
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  delete process.env['RECENSE_LOCK_PATH'];
  try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Seed helpers — raw SQL inserts (mirrors surface-store.test.ts pattern)
// ---------------------------------------------------------------------------

function seedNode(id: string, s: number, value = `value-of-${id}`): void {
  const db = new Database(tmpDbPath);
  db.prepare(`
    INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access, tombstoned, pending_contradictions, training_eligible)
    VALUES (?, 'fact', ?, ?, 'observed', ?, 0.5, ?, 0, '[]', 0)
  `).run(id, value, `hash-${id}`, s, Date.now());
  db.close();
}

function seedTemporal(nodeId: string, dueAtMs: number, actionType = 'meeting'): string {
  const dueAt = new Date(dueAtMs).toISOString();
  const db = new Database(tmpDbPath);
  db.prepare(`
    INSERT INTO node_temporal (node_id, due_at, action_type, recurrence_rule, source_event_id, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `).run(nodeId, dueAt, actionType, Date.now());
  db.close();
  return dueAt;
}

// ---------------------------------------------------------------------------
// surface() — read-only, lock-free
// ---------------------------------------------------------------------------

describe('ops.surface()', () => {
  it('returns [] on empty DB (no node_temporal rows)', async () => {
    const items = await ops.surface();
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(0);
  });

  it('returns a ranked SurfaceItem for a seeded future node_temporal', async () => {
    const nodeId = 'surface-test-node';
    seedNode(nodeId, 0.6);
    const dueAt = seedTemporal(nodeId, Date.now() + 60 * 60 * 1000); // 1h from now

    const items = await ops.surface();

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.node_id).toBe(nodeId);
    expect(item.due_at).toBe(dueAt);
    expect(item.tier).toBe(0); // < 24h → P0
    expect(typeof item.score).toBe('number');
    expect(item.score).toBeGreaterThan(0);
    expect(item.action_type).toBe('meeting');
  });

  it('returns items sorted tier ASC then score DESC (P0 before lower)', async () => {
    seedNode('p0-node', 0.5);
    seedNode('lower-node', 0.9);
    seedTemporal('p0-node', Date.now() + 2 * 60 * 60 * 1000);          // 2h → P0 (tier=0)
    seedTemporal('lower-node', Date.now() + 5 * 24 * 60 * 60 * 1000); // 5d → lower (tier=1)

    const items = await ops.surface();

    expect(items.length).toBeGreaterThanOrEqual(2);
    const p0Idx    = items.findIndex(i => i.node_id === 'p0-node');
    const lowerIdx = items.findIndex(i => i.node_id === 'lower-node');
    expect(p0Idx).toBeGreaterThanOrEqual(0);
    expect(lowerIdx).toBeGreaterThanOrEqual(0);
    expect(p0Idx).toBeLessThan(lowerIdx); // P0 must come first
  });
});

// ---------------------------------------------------------------------------
// surfaceSeen() — write path, locked, idempotent upsert
// ---------------------------------------------------------------------------

describe('ops.surfaceSeen()', () => {
  it('inserts a surfaced_event row and returns { status: "recorded" }', async () => {
    const nodeId = 'seen-node-1';
    seedNode(nodeId, 0.5);
    const dueAt = seedTemporal(nodeId, Date.now() + 60 * 60 * 1000);

    const result = await ops.surfaceSeen({ node_id: nodeId, occurrence_due_at: dueAt, outcome: 'seen' });

    expect(result).toEqual({ status: 'recorded' });

    const row = checkDb.prepare('SELECT * FROM surfaced_event WHERE node_id = ? AND occurrence_due_at = ?')
      .get(nodeId, dueAt) as { outcome: string; created_at: number; updated_at: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.outcome).toBe('seen');
    expect(typeof row!.created_at).toBe('number');
    expect(typeof row!.updated_at).toBe('number');
  });

  it('defaults outcome to "seen" when not provided', async () => {
    const nodeId = 'seen-default-outcome';
    seedNode(nodeId, 0.5);
    const dueAt = seedTemporal(nodeId, Date.now() + 60 * 60 * 1000);

    await ops.surfaceSeen({ node_id: nodeId, occurrence_due_at: dueAt });

    const row = checkDb.prepare('SELECT outcome FROM surfaced_event WHERE node_id = ?').get(nodeId) as
      { outcome: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.outcome).toBe('seen');
  });

  it('is idempotent: two calls with same (node_id, occurrence_due_at) leave exactly one row', async () => {
    const nodeId = 'idempotent-node';
    seedNode(nodeId, 0.5);
    const dueAt = seedTemporal(nodeId, Date.now() + 60 * 60 * 1000);

    await ops.surfaceSeen({ node_id: nodeId, occurrence_due_at: dueAt, outcome: 'seen' });
    await ops.surfaceSeen({ node_id: nodeId, occurrence_due_at: dueAt, outcome: 'completed' });

    const rows = checkDb.prepare('SELECT * FROM surfaced_event WHERE node_id = ?').all(nodeId) as
      { outcome: string; created_at: number; updated_at: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('completed'); // second call wins on outcome
  });

  it('second call preserves created_at but updates updated_at', async () => {
    const nodeId = 'idempotent-time-node';
    seedNode(nodeId, 0.5);
    const dueAt = seedTemporal(nodeId, Date.now() + 60 * 60 * 1000);

    await ops.surfaceSeen({ node_id: nodeId, occurrence_due_at: dueAt, outcome: 'seen' });

    const firstRow = checkDb.prepare('SELECT created_at, updated_at FROM surfaced_event WHERE node_id = ?')
      .get(nodeId) as { created_at: number; updated_at: number } | undefined;
    expect(firstRow).toBeDefined();

    // Small delay to ensure updated_at can differ
    await new Promise(r => setTimeout(r, 5));

    await ops.surfaceSeen({ node_id: nodeId, occurrence_due_at: dueAt, outcome: 'completed' });

    const secondRow = checkDb.prepare('SELECT created_at, updated_at FROM surfaced_event WHERE node_id = ?')
      .get(nodeId) as { created_at: number; updated_at: number } | undefined;
    expect(secondRow).toBeDefined();
    expect(secondRow!.created_at).toBe(firstRow!.created_at);             // immutable
    expect(secondRow!.updated_at).toBeGreaterThanOrEqual(firstRow!.updated_at); // updated
  });

  it('throws SurfaceTargetNotFoundError for a node_id not in the node table', async () => {
    await expect(
      ops.surfaceSeen({
        node_id: 'ghost-node-does-not-exist',
        occurrence_due_at: new Date(Date.now() + 3_600_000).toISOString(),
        outcome: 'seen',
      }),
    ).rejects.toBeInstanceOf(SurfaceTargetNotFoundError);
  });

  it('does NOT write a surfaced_event row when the node does not exist', async () => {
    await expect(
      ops.surfaceSeen({
        node_id: 'ghost-node-no-row',
        occurrence_due_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(SurfaceTargetNotFoundError);

    const count = (
      checkDb.prepare('SELECT COUNT(*) AS n FROM surfaced_event').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it('MemoryBusyError is exported and is an Error subclass', () => {
    // Structural: MemoryBusyError must be importable and throwable
    expect(MemoryBusyError).toBeDefined();
    const err = new MemoryBusyError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MemoryBusyError');
  });

  it('SurfaceTargetNotFoundError is exported and is an Error subclass', () => {
    expect(SurfaceTargetNotFoundError).toBeDefined();
    const err = new SurfaceTargetNotFoundError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SurfaceTargetNotFoundError');
  });
});
