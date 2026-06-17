/**
 * tests/recall-scope.test.ts — scope surfacing in ambient recall output (Plan 999.3-01,
 * D-S6 / D-S1).
 *
 * Verifies:
 *  - A recalled fact whose node has a non-global scope renders a `[slug]` marker.
 *  - A 'global' or unscoped node renders with NO marker (lean block).
 *  - Retrieval order and selection are byte-identical with vs without the scope-surfacing
 *    path: scope is read AFTER ranking, for display only, and never enters the score or
 *    filter (the load-bearing D-S1 guarantee).
 *
 * Harness mirrors ambient-recall.test.ts: temp FILE DB, nodes seeded via SemanticStore
 * with FIXED embeddings so retrieveRanked returns a deterministic order. ZERO API calls.
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
import { ambientRecall } from '../src/adapter/ambient-recall';

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `recall-scope-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// Query vector and three node embeddings with strictly decreasing cosine to it, all above
// the AMBIENT_FLOOR (0.45) → deterministic order A (1.0) > B (0.8) > C (0.6).
const QUERY_VEC = new Float32Array([1, 0, 0]);
const VEC_A = new Float32Array([1, 0, 0]);     // cosine 1.0
const VEC_B = new Float32Array([0.8, 0.6, 0]); // cosine 0.8
const VEC_C = new Float32Array([0.6, 0.8, 0]); // cosine 0.6

const VAL_A = 'fact alpha about vtx athletes';
const VAL_B = 'fact bravo about global voice';
const VAL_C = 'fact charlie unscoped detail';

let tmpDbPath: string;
let db: Database.Database;
const PROMPT = 'a memory-shaped question long enough to embed';

function seed(id: string, value: string, vec: Float32Array): void {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNode({ id, type: 'fact', value, origin: 'observed', s: 0.8 });
  store.setEmbedding(id, vec);
}

beforeEach(() => {
  tmpDbPath = makeTempDbPath();
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();
  db = new Database(tmpDbPath);
  seed('node-a', VAL_A, VEC_A);
  seed('node-b', VAL_B, VEC_B);
  seed('node-c', VAL_C, VEC_C);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
});

function config() {
  return { ...DEFAULT_CONFIG, dbPath: tmpDbPath };
}

function run(): Promise<string> {
  const provider = new MockModelProvider({ embedFn: () => QUERY_VEC });
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  return ambientRecall(db, PROMPT, provider, config(), clock);
}

/** Fact lines only (drop the header). */
function factLines(text: string): string[] {
  return text.split('\n').slice(1);
}

/** Strip a leading `[slug] ` provenance marker from a fact line for byte-identity compare. */
function stripMarker(line: string): string {
  return line.replace(/^- \[[^\]]+\] /, '- ');
}

describe('ambientRecall scope surfacing (D-S6)', () => {
  it('renders a [slug] marker for a non-global scope and no marker for global/unscoped', async () => {
    const store = new SemanticStore(db, new FakeClock(0), config());
    store.upsertNodeScope({ node_id: 'node-a', scope: 'vtx', updated_at: 1 });
    store.upsertNodeScope({ node_id: 'node-b', scope: 'global', updated_at: 1 });
    // node-c intentionally unscoped

    const text = await run();

    expect(text).toContain(`[vtx] ${VAL_A}`);
    // global node → no marker
    expect(text).toContain(`- ${VAL_B}`);
    expect(text).not.toContain(`[global] ${VAL_B}`);
    // unscoped node → no marker
    expect(text).toContain(`- ${VAL_C}`);
    expect(text).not.toContain(`[`.concat('global'));
  });

  it('ranking/selection is byte-identical with vs without the scope-surfacing path (D-S1)', async () => {
    // Baseline: NO node_scope rows at all.
    const baseline = factLines(await run());

    // Now add scopes (some non-global) and re-run.
    const store = new SemanticStore(db, new FakeClock(0), config());
    store.upsertNodeScope({ node_id: 'node-a', scope: 'vtx', updated_at: 1 });
    store.upsertNodeScope({ node_id: 'node-c', scope: 'tonos', updated_at: 1 });
    const scoped = factLines(await run());

    // Same number of lines, same order.
    expect(scoped).toHaveLength(baseline.length);

    // Stripping the display-only markers from the scoped run yields EXACTLY the baseline
    // lines, in the same order → scope changed nothing but presentation (display-only).
    expect(scoped.map(stripMarker)).toEqual(baseline);

    // Sanity: order is the deterministic cosine ranking A > B > C, unaffected by scope.
    expect(baseline[0]).toContain(VAL_A);
    expect(baseline[1]).toContain(VAL_B);
    expect(baseline[2]).toContain(VAL_C);

    // And the scoped run actually applied markers (so the strip above is meaningful).
    expect(scoped[0]).toContain(`[vtx] ${VAL_A}`);
    expect(scoped[2]).toContain(`[tonos] ${VAL_C}`);
  });
});
