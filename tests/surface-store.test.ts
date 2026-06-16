/**
 * Unit tests for SurfaceStore.rank() — RED phase (TDD plan 21-02).
 *
 * Covers the complete ranking spec: P0 tier gate, blend ordering (salience + proximity),
 * D-10 past-event guard, recurring exemption, D-07 exclusion (all outcome branches),
 * D-09 rolling-24h cap with P0 bypass, tombstoned exclusion, and novelty seam
 * (score = W_PROX*proximity + W_SAL*salience, W_NOV=0 this phase).
 *
 * These tests MUST fail before SurfaceStore is implemented (RED state).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { SurfaceStore } from '../src/db/surface-store';
import { FakeClock } from '../src/lib/clock';

// ---------------------------------------------------------------------------
// Constants — mirrored from ranking_spec for assertions
// ---------------------------------------------------------------------------

const H = 60 * 60 * 1000;      // 1 hour in ms
const D = 24 * H;               // 1 day in ms

const DEFAULT_GRACE_MS = 3 * H;        // D-10 past-event grace
const ROLLING_24H_MS = 24 * H;         // D-09 rolling cap window
const PROXIMITY_HORIZON_MS = 7 * D;    // linear proximity transform horizon
const W_PROX = 0.5;
const W_SAL = 0.5;

// Fixed NOW for deterministic tests: 2026-01-01T00:00:00.000Z
const NOW_MS = 1735689600000;

function toISO(ms: number): string {
  return new Date(ms).toISOString();
}

/** Expected blended score per the ranking_spec formula. */
function expectedScore(msToDue: number, s: number): number {
  const prox = Math.max(0, Math.min(1, 1 - msToDue / PROXIMITY_HORIZON_MS));
  const sal = Math.max(0, Math.min(1, s));
  return W_PROX * prox + W_SAL * sal; // + W_NOV * 0 = omitted
}

// ---------------------------------------------------------------------------
// Per-test temp DB lifecycle
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `surface-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

let db: Database.Database;
let tmpPath: string;

beforeEach(() => {
  tmpPath = makeTempDbPath();
  db = new Database(tmpPath);
  initSchema(db);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Seed helpers — raw SQL inserts to stay at the pure DB layer
// ---------------------------------------------------------------------------

/** Insert a minimal node row (required fields only). */
function seedNode(
  id: string,
  s: number,
  tombstoned: number = 0,
  value: string = `value-of-${id}`,
): void {
  db.prepare(`
    INSERT INTO node (id, type, value, value_hash, origin, s, c,
                      last_access, tombstoned, pending_contradictions, training_eligible)
    VALUES (?, 'fact', ?, ?, 'observed', ?, 0.5, ?, ?, '[]', 0)
  `).run(id, value, `hash-${id}`, s, NOW_MS, tombstoned);
}

/** Insert a node_temporal row. */
function seedTemporal(
  nodeId: string,
  dueAtMs: number,
  actionType: string = 'meeting',
  recurrenceRule: string | null = null,
): void {
  db.prepare(`
    INSERT INTO node_temporal (node_id, due_at, action_type, recurrence_rule, source_event_id, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(nodeId, toISO(dueAtMs), actionType, recurrenceRule, NOW_MS);
}

/** Insert a surfaced_event row. */
function seedSurfacedEvent(
  nodeId: string,
  occDueAtMs: number,
  outcome: string = 'surfaced',
  snoozeUntilMs: number | null = null,
  createdAtMs: number = NOW_MS - 1000,
): void {
  db.prepare(`
    INSERT INTO surfaced_event (node_id, occurrence_due_at, outcome, snooze_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    nodeId,
    toISO(occDueAtMs),
    outcome,
    snoozeUntilMs !== null ? toISO(snoozeUntilMs) : null,
    createdAtMs,
    createdAtMs,
  );
}

// Default opts — match the ranking_spec defaults exactly
const RANK_OPTS = {
  nowMs:         NOW_MS,
  gracePeriodMs: DEFAULT_GRACE_MS,
  capWindow:     ROLLING_24H_MS,
  maxNonP0:      5,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SurfaceStore.rank()', () => {

  // ---- Tier gate -----------------------------------------------------------

  it('tier gate: node due in 2h is P0 (tier=0), node due in 5 days is lower (tier=1)', () => {
    seedNode('p0-node', 0.3);
    seedNode('lower-node', 0.3);
    seedTemporal('p0-node', NOW_MS + 2 * H);    // 2h → <24h → P0
    seedTemporal('lower-node', NOW_MS + 5 * D); // 5 days → >24h → lower

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    const p0 = items.find(i => i.node_id === 'p0-node');
    const lower = items.find(i => i.node_id === 'lower-node');
    expect(p0).toBeDefined();
    expect(lower).toBeDefined();
    expect(p0!.tier).toBe(0);
    expect(lower!.tier).toBe(1);
    // P0 must sort before lower regardless of score
    expect(items[0]!.node_id).toBe('p0-node');
    expect(items[1]!.node_id).toBe('lower-node');
  });

  // ---- Blend ordering — salience -------------------------------------------

  it('blend ordering: equal proximity → higher node.s ranks first', () => {
    // Same due_at → same msToDue → same proximity; score difference from salience only
    const dueAtMs = NOW_MS + 3 * D;
    seedNode('high-sal', 0.9);
    seedNode('low-sal', 0.2);
    seedTemporal('high-sal', dueAtMs);
    seedTemporal('low-sal', dueAtMs);

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.length).toBe(2);
    expect(items[0]!.node_id).toBe('high-sal');
    expect(items[1]!.node_id).toBe('low-sal');
  });

  // ---- Blend ordering — proximity ------------------------------------------

  it('blend ordering: equal salience → sooner due_at ranks first (higher proximity)', () => {
    const s = 0.5;
    seedNode('sooner', s);
    seedNode('later', s);
    seedTemporal('sooner', NOW_MS + 2 * D); // 2 days → higher proximity
    seedTemporal('later', NOW_MS + 5 * D);  // 5 days → lower proximity

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.length).toBe(2);
    expect(items[0]!.node_id).toBe('sooner');
    expect(items[1]!.node_id).toBe('later');
  });

  // ---- D-10 past-event guard -----------------------------------------------

  it('past-event guard: one-off due 5h ago (beyond 3h grace) is excluded', () => {
    seedNode('stale', 0.5);
    seedNode('fresh', 0.5);
    // 5h ago — beyond the 3h grace window → excluded
    seedTemporal('stale', NOW_MS - 5 * H, 'meeting', null);
    // 1h ago — within the 3h grace window → included
    seedTemporal('fresh', NOW_MS - 1 * H, 'meeting', null);

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    const ids = items.map(i => i.node_id);
    expect(ids).not.toContain('stale');
    expect(ids).toContain('fresh');
  });

  // ---- Recurring exemption -------------------------------------------------

  it('recurring exemption: recurring item beyond grace is NOT excluded by past-event guard', () => {
    // Both nodes have due_at 5h ago — beyond the 3h grace window
    seedNode('recurring', 0.5);
    seedNode('oneoff', 0.5);
    // recurrence_rule non-null → recurring → bypasses past-event guard (D-10)
    seedTemporal('recurring', NOW_MS - 5 * H, 'meeting', 'FREQ=DAILY');
    // recurrence_rule null → one-off → excluded by past-event guard
    seedTemporal('oneoff', NOW_MS - 5 * H, 'meeting', null);

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    const ids = items.map(i => i.node_id);
    expect(ids).toContain('recurring');
    expect(ids).not.toContain('oneoff');
  });

  // ---- D-07 exclusion — dismissed ------------------------------------------

  it('D-07 exclusion: outcome=dismissed → excluded', () => {
    const dueAtMs = NOW_MS + 2 * D;
    seedNode('dismissed-node', 0.5);
    seedTemporal('dismissed-node', dueAtMs);
    seedSurfacedEvent('dismissed-node', dueAtMs, 'dismissed');

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.map(i => i.node_id)).not.toContain('dismissed-node');
  });

  // ---- D-07 exclusion — completed ------------------------------------------

  it('D-07 exclusion: outcome=completed → excluded', () => {
    const dueAtMs = NOW_MS + 2 * D;
    seedNode('completed-node', 0.5);
    seedTemporal('completed-node', dueAtMs);
    seedSurfacedEvent('completed-node', dueAtMs, 'completed');

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.map(i => i.node_id)).not.toContain('completed-node');
  });

  // ---- D-07 exclusion — snoozed future -------------------------------------

  it('D-07 exclusion: outcome=snoozed with snooze_until in future → excluded', () => {
    const dueAtMs = NOW_MS + 2 * D;
    seedNode('snoozed-future', 0.5);
    seedTemporal('snoozed-future', dueAtMs);
    // snooze expires 1h from now — still active
    seedSurfacedEvent('snoozed-future', dueAtMs, 'snoozed', NOW_MS + 1 * H);

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.map(i => i.node_id)).not.toContain('snoozed-future');
  });

  // ---- D-07 exclusion — snoozed past → included again ---------------------

  it('D-07 exclusion: outcome=snoozed with snooze_until in past → included again', () => {
    const dueAtMs = NOW_MS + 2 * D;
    seedNode('snoozed-past', 0.5);
    seedTemporal('snoozed-past', dueAtMs);
    // snooze expired 1h ago → treat as active again
    seedSurfacedEvent('snoozed-past', dueAtMs, 'snoozed', NOW_MS - 1 * H);

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.map(i => i.node_id)).toContain('snoozed-past');
  });

  // ---- D-07 exclusion — surfaced (already shown) ---------------------------

  it('D-07 exclusion: outcome=surfaced → excluded (already shown this occurrence)', () => {
    const dueAtMs = NOW_MS + 2 * D;
    seedNode('surfaced-node', 0.5);
    seedTemporal('surfaced-node', dueAtMs);
    seedSurfacedEvent('surfaced-node', dueAtMs, 'surfaced');

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.map(i => i.node_id)).not.toContain('surfaced-node');
  });

  // ---- D-07 exclusion — seen (acknowledged) --------------------------------

  it('D-07 exclusion: outcome=seen → excluded (already shown this occurrence)', () => {
    const dueAtMs = NOW_MS + 2 * D;
    seedNode('seen-node', 0.5);
    seedTemporal('seen-node', dueAtMs);
    seedSurfacedEvent('seen-node', dueAtMs, 'seen');

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.map(i => i.node_id)).not.toContain('seen-node');
  });

  // ---- D-09 rolling-24h cap with P0 bypass ---------------------------------

  it('D-09 cap: 5 prior non-P0 surfaced events in window → lower tier capped; P0 bypasses', () => {
    // Seed 5 cap-filler nodes with surfaced_event rows in the rolling window.
    // No node_temporal rows → filler nodes never appear in rank() eligible query.
    // They exist only to fill the cap counter (capUsed = 5, maxNonP0 = 5 → allowed = 0).
    for (let i = 0; i < 5; i++) {
      const id = `cap-filler-${i}`;
      seedNode(id, 0.1);
      db.prepare(`
        INSERT INTO surfaced_event (node_id, occurrence_due_at, outcome, snooze_until, created_at, updated_at)
        VALUES (?, ?, 'surfaced', NULL, ?, ?)
      `).run(id, toISO(NOW_MS - 2 * H), NOW_MS - 1000, NOW_MS - 1000);
    }

    // A new eligible lower-tier item (would normally surface, but cap is exhausted)
    seedNode('new-lower', 0.5);
    seedTemporal('new-lower', NOW_MS + 3 * D); // tier=1

    // A P0 item — must bypass the cap
    seedNode('p0-item', 0.5);
    seedTemporal('p0-item', NOW_MS + 2 * H); // tier=0 (P0)

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank({ ...RANK_OPTS, maxNonP0: 5 }); // capUsed=5 → allowed=0

    const ids = items.map(i => i.node_id);
    expect(ids).not.toContain('new-lower'); // lower tier capped out
    expect(ids).toContain('p0-item');       // P0 bypasses cap
  });

  // ---- Tombstoned exclusion ------------------------------------------------

  it('tombstoned: node with tombstoned=1 never appears in results', () => {
    seedNode('live-node', 0.5, 0);
    seedNode('dead-node', 0.5, 1); // tombstoned=1
    seedTemporal('live-node', NOW_MS + 3 * D);
    seedTemporal('dead-node', NOW_MS + 3 * D);

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    const ids = items.map(i => i.node_id);
    expect(ids).toContain('live-node');
    expect(ids).not.toContain('dead-node');
  });

  // ---- Novelty seam — score formula ----------------------------------------

  it('novelty seam: score equals W_PROX*proximity + W_SAL*salience exactly (novelty contributes 0)', () => {
    const msToDue = 3 * D; // 3 days from now — lower tier
    const s = 0.6;
    seedNode('scored-node', s, 0, 'test-value');
    seedTemporal('scored-node', NOW_MS + msToDue);

    const store = new SurfaceStore(db, new FakeClock(NOW_MS));
    const items = store.rank(RANK_OPTS);

    expect(items.length).toBe(1);
    const expected = expectedScore(msToDue, s);
    expect(items[0]!.score).toBeCloseTo(expected, 10);
    // Tier must be 1 (lower) since 3D > 24H
    expect(items[0]!.tier).toBe(1);
  });

});
