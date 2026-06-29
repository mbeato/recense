/**
 * tests/remember-viz-bridge.test.ts — remember→viz bridge unit + data-layer tests.
 *
 * Covers:
 *  Task 1: pure rememberTraceInput mapper + WARN-1 cross-seam assertion + fire-and-forget safety
 *  Task 2: data-layer (D-08 #2) — reconcile→one reconsolidation + zero new_node rows (zero-duplicate)
 *
 * Harness:
 *  - Pure-mapper tests: call rememberTraceInput() directly with stub RememberResult shapes.
 *  - Data-layer tests: temp FILE DB (better-sqlite3 cannot open :memory: readonly; same pattern as
 *    memory-ops-trace.test.ts), flag=1 set via meta INSERT, then bridgeRememberToViz() called directly.
 *
 * D-08 #2 (honesty guarantee): a reconcile RememberResult yields EXACTLY 1 reconsolidation row
 * and ZERO new_node rows in activation_trace — no duplicate blip spawned on contradiction.
 *
 * WARN-1 (cross-seam shape assertion): the reconcile mapping MUST match the exact shape Plan 03's
 * applyTrace reconsolidation branch consumes (seeds[0]=existing node; hops[0].node_id=arriving candidate;
 * kind='reconsolidation'). A shape drift here fails this test, not a founder checkpoint.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { rememberTraceInput, bridgeRememberToViz } from '../src/adapter/remember-viz-bridge';
import type { RememberResult } from '../src/adapter/remember-cli';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempPaths: string[] = [];

afterEach(() => {
  for (const p of tempPaths) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ok — already gone or test cleanup
    }
  }
  tempPaths.length = 0;
});

function makeTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `remember-viz-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Open a fresh temp file DB, optionally set viz_trace_enabled='1'. */
function makeFileDb(withFlag: boolean): { db: Database.Database; dbPath: string } {
  const dbPath = makeTempDbPath();
  tempPaths.push(dbPath);
  const db = new Database(dbPath);
  initSchema(db);
  if (withFlag) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', '1')").run();
  }
  return { db, dbPath };
}

// ---------------------------------------------------------------------------
// Task 1: pure rememberTraceInput mapper
// ---------------------------------------------------------------------------

describe('rememberTraceInput — pure action→kind mapper', () => {
  it('insert → kind=new_node, seeds=[newNodeId], hops=[]', () => {
    const result: RememberResult = { action: 'insert', newNodeId: 'A', scope: 'test' };
    const trace = rememberTraceInput(result);
    expect(trace.kind).toBe('new_node');
    expect(trace.seeds).toEqual(['A']);
    expect(trace.hops).toEqual([]);
  });

  it('reconcile → kind=reconsolidation, seeds=[supersededNodeId], hops=[{node_id:newNodeId}]', () => {
    const result: RememberResult = {
      action: 'reconcile',
      newNodeId: 'NEW',
      supersededNodeId: 'OLD',
      scope: 'test',
    };
    const trace = rememberTraceInput(result);
    expect(trace.kind).toBe('reconsolidation');
    expect(trace.seeds).toEqual(['OLD']);
    expect(trace.hops).toHaveLength(1);
    expect(trace.hops[0]!.node_id).toBe('NEW');
    expect(trace.hops[0]!.hop).toBe(1);
    // score is a fixed mid value (not null, not a fabricated magnitude — D-07)
    expect(typeof trace.hops[0]!.score).toBe('number');
    expect(trace.hops[0]!.score).toBeGreaterThan(0);
  });

  it('oscillation → kind=oscillation, seeds=[newNodeId], hops=[]', () => {
    const result: RememberResult = {
      action: 'oscillation',
      newNodeId: 'OSC',
      supersededNodeId: 'OLD',
      scope: 'test',
    };
    const trace = rememberTraceInput(result);
    expect(trace.kind).toBe('oscillation');
    expect(trace.seeds).toEqual(['OSC']);
    expect(trace.hops).toEqual([]);
  });

  it('every action yields exactly ONE kind — never an insert+reconcile bleed', () => {
    const insert = rememberTraceInput({ action: 'insert', newNodeId: 'I', scope: 's' });
    const reconcile = rememberTraceInput({
      action: 'reconcile',
      newNodeId: 'R',
      supersededNodeId: 'S',
      scope: 's',
    });
    const osc = rememberTraceInput({
      action: 'oscillation',
      newNodeId: 'O',
      supersededNodeId: 'P',
      scope: 's',
    });
    // Each result has exactly one kind value (no cross-bleeding)
    expect(insert.kind).toBe('new_node');
    expect(reconcile.kind).toBe('reconsolidation');
    expect(osc.kind).toBe('oscillation');
    // All three kinds are distinct
    const kinds = new Set([insert.kind, reconcile.kind, osc.kind]);
    expect(kinds.size).toBe(3);
  });

  // WARN-1 (cross-seam shape assertion): pins the reconcile output shape EXACTLY to Plan 03's
  // applyTrace reconsolidation branch consumer contract. If the bridge and Plan 03 diverge, THIS
  // test catches it — not a founder checkpoint.
  it('WARN-1 cross-seam: reconcile seeds[0]===supersededNodeId (existing), hops[0].node_id===newNodeId (candidate), kind===reconsolidation', () => {
    const supersededNodeId = 'cross-seam-OLD';
    const newNodeId = 'cross-seam-NEW';
    const result: RememberResult = {
      action: 'reconcile',
      newNodeId,
      supersededNodeId,
      scope: 'test',
    };
    const trace = rememberTraceInput(result);

    // Plan 03 applyTrace reconsolidation branch reads:
    //   row.seeds[0]        → the EXISTING node (flashed magenta)
    //   row.hops[0].node_id → the ARRIVING candidate (green blip that merges into existing)
    //   row.kind            → 'reconsolidation' (triggers the hero choreography)
    expect(trace.seeds[0]).toBe(supersededNodeId); // Plan-03: seeds[0] = existing node
    expect(trace.hops[0]?.node_id).toBe(newNodeId); // Plan-03: hops[0].node_id = arriving candidate
    expect(trace.kind).toBe('reconsolidation'); // Plan-03: reconsolidation branch trigger
  });
});

// ---------------------------------------------------------------------------
// Task 1: bridgeRememberToViz — fire-and-forget safety
// ---------------------------------------------------------------------------

describe('bridgeRememberToViz — fire-and-forget safety', () => {
  it('never throws even when the underlying DB is closed (broken sink)', () => {
    // Use a closed DB handle to force an error inside bridgeRememberToViz.
    // The function must swallow it completely — T-52-11.
    const { db } = makeFileDb(true);
    db.close(); // Force internal error
    const clock = new FakeClock(1_000_000);
    const result: RememberResult = { action: 'insert', newNodeId: 'X', scope: 'test' };
    expect(() => {
      bridgeRememberToViz(db, clock, result);
    }).not.toThrow();
  });

  it('never throws when flag is off (Noop path)', () => {
    const { db } = makeFileDb(false);
    const clock = new FakeClock(1_000_000);
    const result: RememberResult = { action: 'reconcile', newNodeId: 'N', supersededNodeId: 'O', scope: 's' };
    expect(() => {
      bridgeRememberToViz(db, clock, result);
    }).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Task 2: bridgeRememberToViz — data-layer (D-08 #2 zero-duplicate guarantee)
// ---------------------------------------------------------------------------

describe('bridgeRememberToViz — data-layer row counts', () => {
  it('flag off → zero activation_trace rows regardless of action', () => {
    const { db } = makeFileDb(false);
    const clock = new FakeClock(1_000_000);
    bridgeRememberToViz(db, clock, {
      action: 'reconcile',
      newNodeId: 'N',
      supersededNodeId: 'O',
      scope: 'test',
    });
    const count = (
      db.prepare('SELECT COUNT(*) as c FROM activation_trace').get() as { c: number }
    ).c;
    expect(count).toBe(0);
    db.close();
  });

  it('insert result → exactly 1 row with kind=new_node', () => {
    const { db } = makeFileDb(true);
    const clock = new FakeClock(1_000_000);
    bridgeRememberToViz(db, clock, { action: 'insert', newNodeId: 'INS', scope: 'test' });
    const rows = db
      .prepare("SELECT kind FROM activation_trace WHERE kind = 'new_node'")
      .all() as Array<{ kind: string }>;
    expect(rows).toHaveLength(1);
    const total = (
      db.prepare('SELECT COUNT(*) as c FROM activation_trace').get() as { c: number }
    ).c;
    expect(total).toBe(1);
    db.close();
  });

  // D-08 #2 — the load-bearing zero-duplicate honesty guarantee:
  // A contradiction (reconcile) produces ONE reconsolidation trace on the existing node
  // and ZERO new_node traces. No duplicate blip spawned.
  it('D-08 #2: reconcile result → 1 reconsolidation row, ZERO new_node rows', () => {
    const { db } = makeFileDb(true);
    const clock = new FakeClock(1_000_000);
    bridgeRememberToViz(db, clock, {
      action: 'reconcile',
      newNodeId: 'RNEW',
      supersededNodeId: 'ROLD',
      scope: 'test',
    });
    const reconsolidationCount = (
      db
        .prepare("SELECT COUNT(*) as c FROM activation_trace WHERE kind = 'reconsolidation'")
        .get() as { c: number }
    ).c;
    const newNodeCount = (
      db
        .prepare("SELECT COUNT(*) as c FROM activation_trace WHERE kind = 'new_node'")
        .get() as { c: number }
    ).c;
    // One magenta reconsolidation flash on the existing node — zero duplicate blips
    expect(reconsolidationCount).toBe(1);
    expect(newNodeCount).toBe(0);
    db.close();
  });

  it('oscillation result → exactly 1 row with kind=oscillation', () => {
    const { db } = makeFileDb(true);
    const clock = new FakeClock(1_000_000);
    bridgeRememberToViz(db, clock, {
      action: 'oscillation',
      newNodeId: 'OSC',
      supersededNodeId: 'OLD',
      scope: 'test',
    });
    const rows = db
      .prepare("SELECT kind FROM activation_trace WHERE kind = 'oscillation'")
      .all() as Array<{ kind: string }>;
    expect(rows).toHaveLength(1);
    const total = (
      db.prepare('SELECT COUNT(*) as c FROM activation_trace').get() as { c: number }
    ).c;
    expect(total).toBe(1);
    db.close();
  });
});
