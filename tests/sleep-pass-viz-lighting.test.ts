/**
 * tests/sleep-pass-viz-lighting.test.ts
 *
 * Phase 19: the hourly sleep pass lights the second brain when it does real work.
 * Verifies lightConsolidatedNodes() — reads the consolidation_event provenance a pass
 * just wrote and emits ONE flag-gated activation trace seeded with the touched nodes.
 *
 * Guarantees pinned:
 *  - flag ON: a trace is written, seeded with exactly the nodes touched since sinceTs
 *    (older events excluded; null node_id excluded).
 *  - flag OFF (default): nothing is written (no waste when no viz window is open).
 *  - honesty: a pass that touched nothing emits no trace.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { newId } from '../src/lib/hash';
import { lightConsolidatedNodes } from '../src/consolidation/run-sleep-pass';

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

function seeds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT seeds FROM activation_trace ORDER BY id').all() as Array<{ seeds: string }>;
  return rows.flatMap(r => JSON.parse(r.seeds) as string[]);
}

describe('sleep-pass viz lighting (lightConsolidatedNodes)', () => {
  let db: Database.Database;
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('flag ON: emits one trace seeded with nodes touched since sinceTs (older + null excluded)', () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', '1')").run();
    recordEvent(db, 10, 'old-node');     // before the pass — excluded
    recordEvent(db, 100, 'n1');          // this pass
    recordEvent(db, 110, 'n2');          // this pass
    recordEvent(db, 120, null);          // no node — excluded

    lightConsolidatedNodes(db, clock, 50);

    const rows = db.prepare('SELECT * FROM activation_trace').all();
    expect(rows).toHaveLength(1);
    expect(seeds(db).sort()).toEqual(['n1', 'n2']);
  });

  it('flag OFF (default): writes nothing — no waste when no viz window is open', () => {
    recordEvent(db, 100, 'n1');
    lightConsolidatedNodes(db, clock, 50);
    expect(db.prepare('SELECT * FROM activation_trace').all()).toHaveLength(0);
  });

  it('honesty: a pass that touched no nodes emits no trace', () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', '1')").run();
    recordEvent(db, 10, 'old-node'); // only pre-pass activity
    lightConsolidatedNodes(db, clock, 50);
    expect(db.prepare('SELECT * FROM activation_trace').all()).toHaveLength(0);
  });
});
