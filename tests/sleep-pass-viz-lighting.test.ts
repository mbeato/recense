/**
 * tests/sleep-pass-viz-lighting.test.ts
 *
 * Phase 19: the hourly sleep pass lights the second brain when it does real work.
 * Verifies lightConsolidatedNodes() — replays the consolidation_event provenance a
 * pass just wrote as a PROGRESSIVE, spaced cascade of flag-gated activation traces
 * (one tiny trace per genuine node operation, in chronological order), so the brain
 * reads as thinking — schema forming → belief correction → tombstones — rather than
 * one summary pulse. The spacing lives entirely AFTER consolidate(); it never
 * touches the critical graph writer.
 *
 * Guarantees pinned:
 *  - flag ON: one trace PER touched op (node_id non-null, ts >= sinceTs), emitted
 *    in ts-ascending (cascade) order; older events and null node_ids excluded.
 *  - spacing: sleep is invoked between emits (ops-1 times), not after the last.
 *  - cap: at most CASCADE_MAX traces (bounds the background process lifetime).
 *  - flag OFF (default): nothing written AND no sleeping (no waste, fast return).
 *  - honesty: a pass that touched nothing emits no trace.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { newId } from '../src/lib/hash';
import {
  lightConsolidatedNodes,
  CASCADE_MAX,
} from '../src/consolidation/run-sleep-pass';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

/** Insert a consolidation_event provenance row (minimal required columns). */
function recordEvent(db: Database.Database, ts: number, nodeId: string | null) {
  db.prepare(
    `INSERT INTO consolidation_event (id, ts, schema_version, event_type, node_id)
     VALUES (?, ?, 1, 'update_strengthen', ?)`,
  ).run(newId(), ts, nodeId);
}

/** Seeds per trace, in emission (id) order — each cascade step is one trace. */
function traceSeeds(db: Database.Database): string[][] {
  const rows = db.prepare('SELECT seeds FROM activation_trace ORDER BY id').all() as Array<{ seeds: string }>;
  return rows.map(r => JSON.parse(r.seeds) as string[]);
}

describe('sleep-pass viz lighting (lightConsolidatedNodes cascade)', () => {
  let db: Database.Database;
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  // No-op sleep keeps tests instant; counts invocations to assert spacing.
  let sleeps: number;
  const sleep = async (_ms: number) => { sleeps++; };
  beforeEach(() => { db = makeDb(); sleeps = 0; });
  afterEach(() => { db.close(); });

  it('flag ON: emits one trace per touched op, in cascade (ts ASC) order; older + null excluded', async () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', '1')").run();
    recordEvent(db, 10, 'old-node');     // before the pass — excluded
    recordEvent(db, 110, 'n2');          // this pass (inserted out of ts order)
    recordEvent(db, 100, 'n1');          // this pass
    recordEvent(db, 120, null);          // no node — excluded

    await lightConsolidatedNodes(db, clock, 50, sleep);

    // Two real ops → two traces, single-seed each, in ts-ascending order.
    expect(traceSeeds(db)).toEqual([['n1'], ['n2']]);
    // Spaced between emits but not after the last.
    expect(sleeps).toBe(1);
  });

  it('caps the cascade at CASCADE_MAX traces', async () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', '1')").run();
    for (let i = 0; i < CASCADE_MAX + 5; i++) recordEvent(db, 100 + i, `n${i}`);

    await lightConsolidatedNodes(db, clock, 50, sleep);

    const count = (db.prepare('SELECT count(*) c FROM activation_trace').get() as { c: number }).c;
    expect(count).toBe(CASCADE_MAX);
  });

  it('flag OFF (default): writes nothing and does not sleep — no waste when no viz window is open', async () => {
    recordEvent(db, 100, 'n1');
    await lightConsolidatedNodes(db, clock, 50, sleep);
    expect(db.prepare('SELECT * FROM activation_trace').all()).toHaveLength(0);
    expect(sleeps).toBe(0);
  });

  it('honesty: a pass that touched no nodes emits no trace', async () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', '1')").run();
    recordEvent(db, 10, 'old-node'); // only pre-pass activity
    await lightConsolidatedNodes(db, clock, 50, sleep);
    expect(db.prepare('SELECT * FROM activation_trace').all()).toHaveLength(0);
    expect(sleeps).toBe(0);
  });
});
