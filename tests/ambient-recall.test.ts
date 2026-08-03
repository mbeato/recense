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
  renderAmbientBlock,
  AMBIENT_K,
  AMBIENT_FLOOR,
  MAX_VALUE_CHARS,
  AMBIENT_BLOCK_CHAR_BUDGET,
  type RenderRow,
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

/** Fact lines only (drop the header) — mirrors tests/recall-scope.test.ts's helper. */
function factLines(text: string): string[] {
  return text.split('\n').slice(1);
}

/** Write a node_scope sidecar row (tests/recall-scope.test.ts pattern). */
function seedScope(db: Database.Database, nodeId: string, scope: string): void {
  const store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNodeScope({ node_id: nodeId, scope, updated_at: 1 });
}

// ---------------------------------------------------------------------------
// Fixtures — entity anchoring (Phase 69 RECALL-01/RECALL-02, Plan 69-03 Task 3)
// ---------------------------------------------------------------------------

const ANCHOR_SINGLE_FACT_ID = 'anchor-single-fact';
const ANCHOR_SINGLE_FACT_VALUE = 'the contract with zyloquartz sets the terms';

/** One entity + one orthogonally-embedded fact reachable only by name (the F2 shape). */
function seedSingleAnchorFact(db: Database.Database): void {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNode({ id: 'anchor-single-entity', type: 'entity', value: 'zyloquartz', origin: 'observed' });
  store.upsertNode({ id: ANCHOR_SINGLE_FACT_ID, type: 'fact', value: ANCHOR_SINGLE_FACT_VALUE, origin: 'observed' });
  store.setEmbedding(ANCHOR_SINGLE_FACT_ID, ORTHO_VEC);
}

/** One entity, 3 edge-reachable facts + 1 name-only fact — 4 facts reachable ONLY by anchoring. */
function seedAnchorGraph(db: Database.Database): void {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNode({ id: 'anchor-entity', type: 'entity', value: 'zyloquartz', origin: 'observed' });
  ['anchor-edge-1', 'anchor-edge-2', 'anchor-edge-3'].forEach((id, i) => {
    store.upsertNode({ id, type: 'fact', value: `anchored edge fact ${i} re zyloquartz`, origin: 'observed' });
    store.setEmbedding(id, ORTHO_VEC);
    store.upsertEdge({ src: 'anchor-entity', dst: id, rel: 'works_on', w: 1 - i * 0.1, kind: 'relation' });
  });
  store.upsertNode({
    id: 'anchor-name-1',
    type: 'fact',
    value: 'anchored name fact mentions zyloquartz directly',
    origin: 'observed',
  });
  store.setEmbedding('anchor-name-1', ORTHO_VEC);
}

/** seedAnchorGraph's 4 anchor-reachable facts plus 5 independent above-floor cosine hits. */
function seedReservedSlotsGraph(db: Database.Database): void {
  seedAnchorGraph(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  for (let i = 0; i < 5; i++) {
    const id = `cosine-hit-${i}`;
    store.upsertNode({ id, type: 'fact', value: `cosine hit fact ${i}`, origin: 'observed' });
    store.setEmbedding(id, FIXED_VEC);
  }
}

const OWN_FACT_ID = 'scope-own-fact';
const OWN_FACT_VALUE = 'own project fact value';
const FOREIGN_FACT_ID = 'scope-foreign-fact';
const FOREIGN_FACT_VALUE = 'foreign project fact value';
const SCOPE_QUERY_VEC = new Float32Array([1, 0, 0]);
const SCOPE_VEC_HIGH = new Float32Array([1, 0, 0]); // cosine 1.0
const SCOPE_VEC_LOW = new Float32Array([0.6, 0.8, 0]); // cosine 0.6

/** Own-project fact at a LOWER cosine than a foreign-project fact — the nudge test shape. */
function seedScopeNudgeGraph(db: Database.Database): void {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNode({ id: OWN_FACT_ID, type: 'fact', value: OWN_FACT_VALUE, origin: 'observed' });
  store.setEmbedding(OWN_FACT_ID, SCOPE_VEC_LOW);
  store.upsertNode({ id: FOREIGN_FACT_ID, type: 'fact', value: FOREIGN_FACT_VALUE, origin: 'observed' });
  store.setEmbedding(FOREIGN_FACT_ID, SCOPE_VEC_HIGH);
  seedScope(db, OWN_FACT_ID, 'proja');
  seedScope(db, FOREIGN_FACT_ID, 'projb');
}

const FOREIGN_DOC_ID = 'scope-foreign-doc';
const FOREIGN_DOC_VALUE = 'foreign project doc value';
const GLOBAL_DOC_ID = 'scope-global-doc';
const GLOBAL_DOC_VALUE = 'global doc value';
const DEMOTE_QUERY_VEC = new Float32Array([1, 0, 0]);
const DEMOTE_VEC_OWN = new Float32Array([0.8, 0.6, 0]); // cosine 0.8
const DEMOTE_VEC_FOREIGN_DOC = new Float32Array([1, 0, 0]); // cosine 1.0
const DEMOTE_VEC_GLOBAL_DOC = new Float32Array([0.6, 0.8, 0]); // cosine 0.6

/** Own fact (lower cosine) + foreign-scope doc (highest cosine) + global-scope doc (mid cosine). */
function seedForeignDocDemotionGraph(db: Database.Database): void {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNode({ id: OWN_FACT_ID, type: 'fact', value: OWN_FACT_VALUE, origin: 'observed' });
  store.setEmbedding(OWN_FACT_ID, DEMOTE_VEC_OWN);
  store.upsertNode({ id: FOREIGN_DOC_ID, type: 'doc', value: FOREIGN_DOC_VALUE, origin: 'observed' });
  store.setEmbedding(FOREIGN_DOC_ID, DEMOTE_VEC_FOREIGN_DOC);
  store.upsertNode({ id: GLOBAL_DOC_ID, type: 'doc', value: GLOBAL_DOC_VALUE, origin: 'observed' });
  store.setEmbedding(GLOBAL_DOC_ID, DEMOTE_VEC_GLOBAL_DOC);
  seedScope(db, OWN_FACT_ID, 'proja');
  seedScope(db, FOREIGN_DOC_ID, 'projb');
  seedScope(db, GLOBAL_DOC_ID, 'global');
}

const FLOOR_STRONG_ID = 'floor-strong-fact';
const FLOOR_STRONG_VALUE = 'a strong relevant fact';
const FLOOR_WEAK_ID = 'floor-weak-fact';
const FLOOR_WEAK_VALUE = 'an unrelated low relevance fact';

/** One above-floor fact + one below-floor, unanchored fact. */
function seedFloorGraph(db: Database.Database): void {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
  store.upsertNode({ id: FLOOR_STRONG_ID, type: 'fact', value: FLOOR_STRONG_VALUE, origin: 'observed' });
  store.setEmbedding(FLOOR_STRONG_ID, FIXED_VEC);
  store.upsertNode({ id: FLOOR_WEAK_ID, type: 'fact', value: FLOOR_WEAK_VALUE, origin: 'observed' });
  store.setEmbedding(FLOOR_WEAK_ID, ORTHO_VEC);
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

    expect(text.startsWith('Recalled from recense (ambient):')).toBe(true);
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

    // Flag on → exactly one row, seeds contain the node id, hops = [] (no out-edges
    // exist for the seeded node in this fixture, so honest 1-hop hops is empty).
    // Phase 55 (D-06): seeds are now {node_id, score} objects, not bare strings.
    setFlag(db, '1');
    await ambientRecall(db, PROMPT, provider, config(), clock);
    expect(countTraceRows(db)).toBe(1);
    const trace = getLatestTraceRow(db);
    const seeds = JSON.parse(trace.seeds) as Array<{ node_id: string; score: number }>;
    expect(seeds.map(s => s.node_id)).toContain(SEEDED_NODE_ID);
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

  it('f. dark defaults: the injected block is byte-identical to pre-phase (D-09)', async () => {
    seedNode(db);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));

    const text = await ambientRecall(db, PROMPT, provider, config(), clock);

    expect(text).toBe('Recalled from recense (ambient):\n- a seeded ambient fact (observed, score 1.00)');
  });

  it('g. F2 end-to-end: an orthogonally-embedded anchored fact appears when the knob is on, absent when off', async () => {
    seedSingleAnchorFact(db);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const anchorPrompt = 'do you remember anything from the contract i have with zyloquartz';

    const onCfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, entityAnchoringEnabled: true };
    const textOn = await ambientRecall(db, anchorPrompt, provider, onCfg, clock);
    expect(textOn).toContain(ANCHOR_SINGLE_FACT_VALUE);

    const offCfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, entityAnchoringEnabled: false };
    const textOff = await ambientRecall(db, anchorPrompt, provider, offCfg, clock);
    expect(textOff).not.toContain(ANCHOR_SINGLE_FACT_VALUE);
  });

  it('h. reserved slots: anchored facts occupy at most ANCHOR_RESERVED_SLOTS of AMBIENT_K', async () => {
    seedReservedSlotsGraph(db);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const cfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, entityAnchoringEnabled: true };

    const text = await ambientRecall(db, 'tell me everything about zyloquartz please', provider, cfg, clock);
    const lines = factLines(text);

    expect(lines).toHaveLength(AMBIENT_K);
    expect(lines.filter(l => l.includes('cosine hit fact'))).toHaveLength(3);
    expect(lines.filter(l => l.includes('anchored'))).toHaveLength(2);
  });

  it('i. sameProjectRankNudge moves an own-project fact above a higher-cosine foreign fact — never a filter', async () => {
    seedScopeNudgeGraph(db);
    const provider = new MockModelProvider({ embedFn: () => SCOPE_QUERY_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const cfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, sameProjectRankNudge: 0.5 };

    const text = await ambientRecall(db, PROMPT, provider, cfg, clock, '/Users/tester/projA');
    const lines = factLines(text);

    expect(lines[0]).toContain(OWN_FACT_VALUE);
    // Foreign fact remains present — the nudge reorders, it never filters (D-01).
    expect(text).toContain(FOREIGN_FACT_VALUE);
  });

  it('j. the rendered score is the true cosine while the nudge is non-zero', async () => {
    seedScopeNudgeGraph(db);
    const provider = new MockModelProvider({ embedFn: () => SCOPE_QUERY_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const cfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, sameProjectRankNudge: 0.5 };

    const text = await ambientRecall(db, PROMPT, provider, cfg, clock, '/Users/tester/projA');

    // Own fact's true cosine is 0.60; the nudge (0.5) must never appear in the displayed score.
    expect(text).toContain(`${OWN_FACT_VALUE} (observed, score 0.60)`);
  });

  it('k. foreignDocDemotion demotes a foreign-scope doc below an own-project fact; a global-scope doc is not demoted', async () => {
    seedForeignDocDemotionGraph(db);
    const provider = new MockModelProvider({ embedFn: () => DEMOTE_QUERY_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const cfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, foreignDocDemotion: 0.5 };

    const text = await ambientRecall(db, PROMPT, provider, cfg, clock, '/Users/tester/projA');
    const lines = factLines(text);

    expect(lines[0]).toContain(OWN_FACT_VALUE);
    expect(lines[1]).toContain(GLOBAL_DOC_VALUE);
    expect(lines[2]).toContain(FOREIGN_DOC_VALUE);
    // Foreign doc remains present — demotion is ordering-only, never a filter.
    expect(text).toContain(FOREIGN_DOC_VALUE);
  });

  it('l. AMBIENT_FLOOR still gates non-anchored candidates regardless of knob state', async () => {
    seedFloorGraph(db);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const cfg = {
      ...DEFAULT_CONFIG,
      dbPath: tmpDbPath,
      entityAnchoringEnabled: true,
      sameProjectRankNudge: 1,
      foreignDocDemotion: 1,
    };

    const text = await ambientRecall(db, PROMPT, provider, cfg, clock);

    expect(text).toContain(FLOOR_STRONG_VALUE);
    expect(text).not.toContain(FLOOR_WEAK_VALUE);
  });

  it('tuning knobs are exported with the planned values', () => {
    expect(AMBIENT_K).toBe(5);
    // 0.5 → 0.45 tuned from live-graph score probes (3aa350b)
    expect(AMBIENT_FLOOR).toBe(0.45);
  });

  // ── End-to-end doc-link + hop-injection wiring (Phase 69 Plan 69-04 Task 2/3) ──────────

  it('doc-link end-to-end: a doc row renders as title + citation under the knob, absent when dark', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
    store.upsertNode({
      id: 'e2e-doc-1',
      type: 'doc',
      value: '# The Deep-Dive Title\n\nLots of body prose nobody will read here.',
      origin: 'observed',
    });
    store.setEmbedding('e2e-doc-1', FIXED_VEC);
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });

    const onCfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, ambientDocLinkRenderEnabled: true };
    const textOn = await ambientRecall(db, PROMPT, provider, onCfg, clock);
    expect(textOn).toContain('The Deep-Dive Title — recense://doc/e2e-doc-1');
    expect(textOn).not.toContain('Lots of body prose');

    const offCfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, ambientDocLinkRenderEnabled: false };
    const textOff = await ambientRecall(db, PROMPT, provider, offCfg, clock);
    expect(textOff).toContain('# The Deep-Dive Title');
    expect(textOff).not.toContain('recense://doc/');
  });

  it('hop-injection end-to-end: a real 1-hop edge renders under the seeded fact, attributed to the correct src', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
    store.upsertNode({ id: 'e2e-hop-seed', type: 'fact', value: 'seed fact value', origin: 'observed' });
    store.setEmbedding('e2e-hop-seed', FIXED_VEC);
    store.upsertNode({ id: 'e2e-hop-neighbour', type: 'fact', value: 'a real neighbour fact', origin: 'observed' });
    store.upsertEdge({ src: 'e2e-hop-seed', dst: 'e2e-hop-neighbour', rel: 'works_on', w: 1, kind: 'relation' });
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });

    const onCfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, ambientHopInjectionEnabled: true };
    const textOn = await ambientRecall(db, PROMPT, provider, onCfg, clock);
    expect(textOn).toContain('seed fact value');
    expect(textOn).toContain('  ↳ works_on a real neighbour fact');
    expect(textOn).not.toMatch(/↳.*score/);

    const offCfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, ambientHopInjectionEnabled: false };
    const textOff = await ambientRecall(db, PROMPT, provider, offCfg, clock);
    expect(textOff).not.toContain('↳');
  });

  it('hop-injection: a hop whose neighbour node is tombstoned is dropped, never rendered as a placeholder', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
    store.upsertNode({ id: 'e2e-hop-seed2', type: 'fact', value: 'seed fact value two', origin: 'observed' });
    store.setEmbedding('e2e-hop-seed2', FIXED_VEC);
    store.upsertNode({ id: 'e2e-hop-nb2', type: 'fact', value: 'a since-deleted neighbour fact', origin: 'observed' });
    store.upsertEdge({ src: 'e2e-hop-seed2', dst: 'e2e-hop-nb2', rel: 'works_on', w: 1, kind: 'relation' });
    store.tombstone('e2e-hop-nb2'); // liveness: dropped rather than rendered with a placeholder
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });
    const cfg = { ...DEFAULT_CONFIG, dbPath: tmpDbPath, ambientHopInjectionEnabled: true };

    const text = await ambientRecall(db, PROMPT, provider, cfg, clock);
    expect(text).toContain('seed fact value two');
    expect(text).not.toContain('↳');
  });

  it('hop-injection: activation_trace rows are byte-identical in shape whether the knob is on or off (viz sink unaffected, D-06)', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
    store.upsertNode({ id: 'e2e-hop-trace-seed', type: 'fact', value: 'trace seed fact', origin: 'observed' });
    store.setEmbedding('e2e-hop-trace-seed', FIXED_VEC);
    store.upsertNode({ id: 'e2e-hop-trace-nb', type: 'fact', value: 'trace neighbour fact', origin: 'observed' });
    store.upsertEdge({ src: 'e2e-hop-trace-seed', dst: 'e2e-hop-trace-nb', rel: 'works_on', w: 1, kind: 'relation' });
    setFlag(db, '1');
    const provider = new MockModelProvider({ embedFn: () => FIXED_VEC });

    await ambientRecall(db, PROMPT, provider, { ...DEFAULT_CONFIG, dbPath: tmpDbPath, ambientHopInjectionEnabled: false }, clock);
    const traceOff = getLatestTraceRow(db);

    await ambientRecall(db, PROMPT, provider, { ...DEFAULT_CONFIG, dbPath: tmpDbPath, ambientHopInjectionEnabled: true }, clock);
    const traceOn = getLatestTraceRow(db);

    expect(JSON.parse(traceOn.seeds)).toEqual(JSON.parse(traceOff.seeds));
    expect(JSON.parse(traceOn.hops)).toEqual(JSON.parse(traceOff.hops));
  });
});

// ---------------------------------------------------------------------------
// renderAmbientBlock — pure renderer (Phase 69 Plan 69-04 Task 1/2/3)
// ---------------------------------------------------------------------------

function factRow(overrides: Partial<RenderRow> = {}): RenderRow {
  return {
    id: 'row-1',
    value: 'a fact value',
    score: 0.72,
    origin: 'observed',
    type: 'fact',
    ...overrides,
  };
}

describe('renderAmbientBlock', () => {
  it('m. no doc rows, no hops: byte-identical to the pre-phase loop output', () => {
    const rows: RenderRow[] = [factRow({ id: 'a', value: 'alpha fact', score: 1 })];
    const text = renderAmbientBlock(rows);
    expect(text).toBe('Recalled from recense (ambient):\n- alpha fact (observed, score 1.00)');
  });

  it('n. never emits more than AMBIENT_K fact lines', () => {
    const rows: RenderRow[] = Array.from({ length: 8 }, (_, i) =>
      factRow({ id: `r${i}`, value: `fact ${i}` }),
    );
    const text = renderAmbientBlock(rows);
    const factLines = text.split('\n').slice(1).filter(l => l.startsWith('- '));
    expect(factLines).toHaveLength(AMBIENT_K);
  });

  it('o. is pure: same input twice yields the same string, and the source touches no store/db/clock', () => {
    const rows: RenderRow[] = [factRow()];
    expect(renderAmbientBlock(rows)).toBe(renderAmbientBlock(rows));

    const src = fs.readFileSync(path.join(__dirname, '../src/adapter/ambient-recall.ts'), 'utf8');
    const fnStart = src.indexOf('export function renderAmbientBlock');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(/\bstore\.|\bdb\.|\bclock\.|Date\.now/.test(fnBody)).toBe(false);
  });

  it('p. budget: 5 maximal-length facts plus hops never exceed AMBIENT_BLOCK_CHAR_BUDGET content, and hops drop first', () => {
    const rows: RenderRow[] = Array.from({ length: AMBIENT_K }, (_, i) =>
      factRow({
        id: `r${i}`,
        value: 'v'.repeat(500), // truncates to MAX_VALUE_CHARS
        hops: [{ rel: 'works_on', label: 'a neighbour label' }],
      }),
    );
    const text = renderAmbientBlock(rows);
    // Facts alone already consume the full content budget (5 * 200 = AMBIENT_BLOCK_CHAR_BUDGET)
    // — D-06: facts still all render, but zero hop lines are added (dropped first).
    expect(text).not.toContain('↳');
    const factLines = text.split('\n').slice(1);
    expect(factLines).toHaveLength(AMBIENT_K);
  });

  it('q. hops render when the budget has room, beneath their own fact', () => {
    const rows: RenderRow[] = [
      factRow({ id: 'r0', value: 'short fact', hops: [{ rel: 'works_on', label: 'neighbour A' }] }),
    ];
    const text = renderAmbientBlock(rows);
    const lines = text.split('\n');
    expect(lines[1]).toContain('short fact');
    expect(lines[2]).toBe('  ↳ works_on neighbour A');
  });

  it('r. doc row renders as title + recense://doc/<raw id> under docLinks:true, and never contains the body', () => {
    const rows: RenderRow[] = [
      factRow({
        id: 'doc-1',
        type: 'doc',
        value: '# Deep Dive Title\n\nThe brain-memory system does many things...',
        score: 0.9,
      }),
    ];
    const text = renderAmbientBlock(rows, { docLinks: true });
    expect(text).toContain('Deep Dive Title — recense://doc/doc-1 (doc, score 0.90)');
    expect(text).not.toContain('The brain-memory system does many things');
  });

  it('s. doc row renders as pre-phase truncated body when docLinks:false', () => {
    const rows: RenderRow[] = [
      factRow({ id: 'doc-1', type: 'doc', value: '# Deep Dive Title\n\nBody text here', score: 0.9 }),
    ];
    const text = renderAmbientBlock(rows, { docLinks: false });
    expect(text).toContain('# Deep Dive Title');
    expect(text).not.toContain('recense://doc/');
  });

  it('t. non-doc rows are unaffected by docLinks in either state', () => {
    const rows: RenderRow[] = [factRow({ value: 'a plain fact' })];
    expect(renderAmbientBlock(rows, { docLinks: true })).toBe(renderAmbientBlock(rows, { docLinks: false }));
  });

  it('u. anchored-fact provenance renders inside the existing parenthetical', () => {
    const rows: RenderRow[] = [factRow({ value: 'anchored fact value', anchoredVia: 'zyloquartz' })];
    const text = renderAmbientBlock(rows);
    expect(text).toContain('(observed, score 0.72, via zyloquartz)');
  });
});
