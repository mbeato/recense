/**
 * tests/ambient-recall.test.ts — in-process coverage of the ambient recall core
 * (quick-260612-rt1): the UserPromptSubmit per-prompt recall path.
 *
 * Verifies:
 *   a. injection block format when a seeded node clears the 0.5 floor
 *   b. '' when nothing clears the floor (orthogonal embedding)
 *   c. buildHookOutput payload shape (UserPromptSubmit hookSpecificOutput contract)
 *   d. trace row gating: viz_trace_enabled=1 + non-empty results → exactly one
 *      activation_trace row (seeds = surfaced ids, hops = []); flag absent → zero rows
 *   e. per-line value cap at MAX_VALUE_CHARS
 *
 * Harness mirrors memory-ops-trace.test.ts: temp FILE DB in tmpdir, initSchema on a
 * setup handle, node seeded via SemanticStore.upsertNode + setEmbedding with FIXED_VEC,
 * MockModelProvider with embedFn → FIXED_VEC so cosine = 1.0 clears the 0.5 floor.
 * SCRATCH temp DB only — never the production DB. ZERO real API calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { FakeClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { MockModelProvider } from '../src/model/provider';
import {
  ambientRecall,
  buildHookOutput,
  AMBIENT_K,
  AMBIENT_FLOOR,
  MAX_VALUE_CHARS,
} from '../src/adapter/ambient-recall';

// ---------------------------------------------------------------------------
// Helpers (memory-ops-trace.test.ts pattern)
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `ambient-recall-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Fixed embedding shared by the mock provider and the seeded node (cosine = 1.0). */
const FIXED_VEC = new Float32Array([0, 1, 0]);

/** Orthogonal to FIXED_VEC — cosine 0.0, below the 0.5 floor. */
const ORTHO_VEC = new Float32Array([1, 0, 0]);

const SEEDED_NODE_ID = 'ambient-test-node-1';
const SEEDED_VALUE = 'a seeded ambient fact';

/** Seed one node whose embedding equals the mock embedFn output (cosine = 1.0). */
function seedNode(db: Database.Database, value: string = SEEDED_VALUE): void {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNode({
    id: SEEDED_NODE_ID,
    type: 'fact',
    value,
    origin: 'observed',
    s: 0.8,
  });
  store.setEmbedding(SEEDED_NODE_ID, FIXED_VEC);
}

/** Set viz_trace_enabled in meta (memory-ops-trace.test.ts setFlag helper). */
function setFlag(db: Database.Database, value: '0' | '1'): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', ?)").run(value);
}

function countTraceRows(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM activation_trace').get() as { n: number };
  return row.n;
}

function getLatestTraceRow(db: Database.Database): { seeds: string; hops: string } {
  return db.prepare('SELECT seeds, hops FROM activation_trace ORDER BY id DESC LIMIT 1')
    .get() as { seeds: string; hops: string };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDbPath: string;
let db: Database.Database;

const PROMPT = 'some prompt long enough to embed';

beforeEach(() => {
  tmpDbPath = makeTempDbPath();
  // Schema on a setup handle, closed before the test handle opens (serve-cli pattern).
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();
  db = new Database(tmpDbPath);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
});

function config() {
  return { ...DEFAULT_CONFIG, dbPath: tmpDbPath };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('ambientRecall', () => {
  it('a. returns the injection block when a seeded node clears the floor', async () => {
    seedNode(db);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));

    const text = await ambientRecall(db, PROMPT, provider, config(), clock);

    expect(text.startsWith('Recalled from brain-memory (ambient):')).toBe(true);
    expect(text).toContain(SEEDED_VALUE);
    expect(text).toContain('(observed, score 1.00)');
  });

  it('b. returns "" when nothing clears the floor (orthogonal embedding)', async () => {
    seedNode(db);
    const provider = new MockModelProvider({ embedFn: () => ORTHO_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));

    const text = await ambientRecall(db, PROMPT, provider, config(), clock);

    expect(text).toBe('');
  });

  it('c. buildHookOutput produces the exact UserPromptSubmit payload shape', () => {
    expect(JSON.parse(buildHookOutput('x'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'x',
      },
    });
  });

  it('d. trace row written iff viz_trace_enabled=1 AND results non-empty', async () => {
    seedNode(db);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));

    // Flag absent → zero rows.
    await ambientRecall(db, PROMPT, provider, config(), clock);
    expect(countTraceRows(db)).toBe(0);

    // Flag on → exactly one row, seeds contain the node id, hops = [].
    setFlag(db, '1');
    await ambientRecall(db, PROMPT, provider, config(), clock);
    expect(countTraceRows(db)).toBe(1);
    const trace = getLatestTraceRow(db);
    expect(JSON.parse(trace.seeds) as string[]).toContain(SEEDED_NODE_ID);
    expect(JSON.parse(trace.hops)).toEqual([]);
  });

  it('e. fact-line values are truncated to MAX_VALUE_CHARS', async () => {
    const longValue = 'v'.repeat(500);
    seedNode(db, longValue);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));

    const text = await ambientRecall(db, PROMPT, provider, config(), clock);

    // The value portion is capped: 200 v's appear, 201 consecutive v's never do.
    expect(text).toContain('v'.repeat(MAX_VALUE_CHARS));
    expect(text).not.toContain('v'.repeat(MAX_VALUE_CHARS + 1));
  });

  it('tuning knobs are exported with the planned values', () => {
    expect(AMBIENT_K).toBe(5);
    expect(AMBIENT_FLOOR).toBe(0.5);
  });
});
