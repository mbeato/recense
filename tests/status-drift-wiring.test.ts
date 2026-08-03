/**
 * Wiring-level proof for the Phase 65 status-drift layer — Plan 65-08.
 *
 * Division of coverage (so a future reader does not duplicate it across the three files):
 *  - THIS FILE proves the drift layer is genuinely CONSULTED at both `applyDecision`
 *    contradict branches (the wiring): evaluate() is called with the right arguments at the
 *    right call sites, a drop short-circuits every graph effect, the damped magnitude reaches
 *    `routeContradiction`, the sink still records the judge's own magnitude, the per-source
 *    threshold is respected, and the four observability counters are accurate.
 *  - `tests/status-drift.test.ts` proves the DECISIONS themselves are correct (the logic) —
 *    `StatusDrift.evaluate` / `dampByConfidence` tested in isolation, no consolidator involved.
 *  - Plan 65-09 proves the end-to-end DRIFT-02/DRIFT-04 outcomes (full-pass fixtures).
 *
 * Spy discipline: `attachDriftSpy` monkey-patches `evaluate` on the consolidator's OWN
 * `statusDrift` instance and DELEGATES to the real implementation (never stubs a return value)
 * — stubbing would make the drop/damping assertions below check the test's own fiction instead
 * of the shipped decision logic in `src/consolidation/status-drift.ts`.
 *
 * Provider discipline: cases that depend on a node id MINTED by a real `consolidate()` pass
 * (the drop cases, the counters case) use a content-keyed `MarkerProvider` that branches on a
 * marker substring in the extraction prompt and a claim-value-keyed judge resolver, following
 * `tests/backfill-chronological-order.test.ts`'s discipline: a call-order-indexed script would
 * return the "right" verdict regardless of whether the drift layer was actually consulted,
 * producing a green test that proves nothing (that file's header names this T-62-36). Cases
 * that only need PRE-SEEDED nodes with known ids use the simpler queue-based
 * `MockModelProvider` — deterministic here because the node ids are known ahead of time and
 * the call sequence is fully controlled by the test.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { MockConsolidationSink, SQLiteConsolidationSink, type ConsolidationSink } from '../src/consolidation/sink';
import { EventStore } from '../src/db/event-store';
import { newId } from '../src/lib/hash';
import type { NodeRow } from '../src/lib/types';

// ---------------------------------------------------------------------------
// Embed helper — constant vector for every text (cosine 1.0 between any two embedded
// texts). Every fixture in this file uses one shared candidate pool sized small enough
// that this is deliberate, not accidental collision.
// ---------------------------------------------------------------------------

function constVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  v[0] = 1.0;
  return v;
}

function constEmbedFn(dims: number): (_t: string) => Float32Array {
  return (_t: string) => constVec(dims);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  episodes: EpisodicStore;
  store: SemanticStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  config: EngineConfig;
}

function makeHarness(overrides: Partial<EngineConfig> = {}): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.0,
    salience: {
      ...DEFAULT_CONFIG.salience,
      consolSkipThresholdBySource: { gmail: 0.0 },
    },
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
    echoSimilarityThreshold: 0.85,
    echoRecencyWindowMs: 86_400_000,
    ...overrides,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

/** No-op SchemaInducer: prevents LLM calls during Phase C. */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Construct a Consolidator wired with a MockConsolidationSink (in-memory capture) and an
 * optional log capture. */
function makeConsolidator(
  h: Harness,
  provider: ModelProvider,
  log: (msg: string) => void = () => {},
): { consolidator: Consolidator; sink: MockConsolidationSink } {
  const sink = new MockConsolidationSink();
  const consolidator = new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink, log,
  );
  return { consolidator, sink };
}

/** Construct a Consolidator wired with a REAL SQLiteConsolidationSink so consolidation_event
 * rows actually land in the DB — needed for tests that assert on that table directly (the
 * drop case's "zero new consolidation_event rows" claim), mirroring
 * tests/consolidation-scope.test.ts's makeConsolidatorWithRealSink pattern. */
function makeConsolidatorWithRealSink(
  h: Harness,
  provider: ModelProvider,
  log: (msg: string) => void = () => {},
): Consolidator {
  const sink: ConsolidationSink = new SQLiteConsolidationSink(new EventStore(h.db), h.clock);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink, log,
  );
}

/** Seed a live node directly via the real upsert primitive (not through a pass). */
function seedNode(
  h: Harness,
  value: string,
  opts: { s?: number; c?: number } = {},
): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'fact', value, origin: 'observed', s: opts.s, c: opts.c });
  h.store.setEmbedding(id, constVec(h.config.embeddingDimensions));
  return id;
}

function getNode(h: Harness, id: string): NodeRow | undefined {
  return h.db.prepare('SELECT * FROM node WHERE id = ?').get(id) as NodeRow | undefined;
}

function countConsolidationEventsForNode(h: Harness, nodeId: string): number {
  return (
    h.db.prepare('SELECT COUNT(*) AS n FROM consolidation_event WHERE node_id = ?').get(nodeId) as {
      n: number;
    }
  ).n;
}

function pendingContradictionsCount(node: NodeRow): number {
  return (JSON.parse(node.pending_contradictions || '[]') as unknown[]).length;
}

// ---------------------------------------------------------------------------
// Drift spy — monkey-patches the consolidator's OWN statusDrift instance, delegating to the
// real implementation. Never touches src/: instance-scoped, mirrors attachDecisionSpy in
// tests/consolidation-intent.test.ts.
// ---------------------------------------------------------------------------

interface DriftCall {
  magnitude: number;
  confidence?: string;
  claimEventTs: number | null;
  candidateNodeId: string;
  resultAction: string;
  resultMagnitude?: number;
  resultDamped?: boolean;
  resultStaleness?: string;
}

interface DriftInputShape {
  magnitude: number;
  confidence?: string;
  claimEventTs: number | null;
  candidateNodeId: string;
}
interface DriftDecisionShape {
  action: string;
  magnitude?: number;
  damped?: boolean;
  staleness?: string;
}

function attachDriftSpy(consolidator: Consolidator): DriftCall[] {
  const calls: DriftCall[] = [];
  const target = consolidator as unknown as {
    statusDrift: { evaluate: (input: DriftInputShape) => DriftDecisionShape };
  };
  const original = target.statusDrift.evaluate.bind(target.statusDrift);
  target.statusDrift.evaluate = (input: DriftInputShape) => {
    const result = original(input);
    calls.push({
      magnitude: input.magnitude,
      confidence: input.confidence,
      claimEventTs: input.claimEventTs,
      candidateNodeId: input.candidateNodeId,
      resultAction: result.action,
      resultMagnitude: result.magnitude,
      resultDamped: result.damped,
      resultStaleness: result.staleness,
    });
    return result;
  };
  return calls;
}

// ---------------------------------------------------------------------------
// snapshotDb — copied verbatim from tests/intent-conservation.test.ts (see that file's
// header for the convention of duplicating this helper rather than exporting it).
// ---------------------------------------------------------------------------

function snapshotDb(db: Database.Database): Record<string, { count: number; values?: string[] }> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const snapshot: Record<string, { count: number; values?: string[] }> = {};
  for (const { name } of tables) {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    let values: string[] | undefined;
    if (cols.includes('value')) {
      values = (
        db.prepare(`SELECT value FROM "${name}" ORDER BY value`).all() as { value: string }[]
      ).map((r) => r.value);
    } else if (cols.includes('content')) {
      values = (
        db.prepare(`SELECT content FROM "${name}" ORDER BY content`).all() as {
          content: string;
        }[]
      ).map((r) => r.content);
    }
    snapshot[name] = values !== undefined ? { count, values } : { count };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// MarkerProvider — content-keyed extraction + claim-value-keyed judge resolution.
//
// Used ONLY where a candidate node's id is not known ahead of time (minted by a real
// consolidate() pass). generate() branches on a marker substring in the prompt and throws
// on an unrecognized prompt (mirrors DynamicReconcileProvider in
// tests/backfill-chronological-order.test.ts). judge() is keyed off the extracted claim's
// OWN value string (deterministic per scripted extraction), never off call order, so the
// verdict is tied to WHICH node the judge actually saw as a candidate.
// ---------------------------------------------------------------------------

class MarkerProvider implements ModelProvider {
  constructor(
    private readonly embedFn: (t: string) => Float32Array,
    private readonly extractionByMarker: Array<{ marker: string; claims: Record<string, unknown>[] }>,
    private readonly judgeResolver: (
      claim: string,
      candidates: Array<{ id: string; value: string }>,
    ) => JudgeVerdict,
  ) {}

  async generate(prompt: string): Promise<string> {
    const hit = this.extractionByMarker.find(({ marker }) => prompt.includes(marker));
    if (!hit) {
      throw new Error(`MarkerProvider: unrecognized prompt (no known marker matched): ${prompt}`);
    }
    return JSON.stringify(hit.claims);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(this.embedFn);
  }

  async judge(claim: string, candidates: Array<{ id: string; value: string }>): Promise<JudgeVerdict> {
    return this.judgeResolver(claim, candidates);
  }

  async judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>,
  ): Promise<JudgeVerdict[]> {
    const results: JudgeVerdict[] = [];
    for (const item of items) results.push(await this.judge(item.claim, item.candidates));
    return results;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatusDrift wiring — consolidator consults the drift layer at both contradict branches (Plan 65-08)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── 1. Primary branch consulted ──────────────────────────────────────────

  it('primary branch consulted: gmail contradict against a primary candidate calls evaluate() with that candidate, the claim confidence, and event_ts', async () => {
    const dims = h.config.embeddingDimensions;
    const n1 = seedNode(h, 'Node N1 initial value', { s: 0.5, c: 0.5 });

    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: n1,
      magnitude: 0.5,
      contradicted_ids: [n1],
    };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Node N1 contradicting claim',
        intent_status: 'interviewing',
        intent_entity: 'N1',
        intent_confidence: 'high',
      }])],
      judgeScript: [verdict],
    });
    const { consolidator } = makeConsolidator(h, provider);
    const driftCalls = attachDriftSpy(consolidator);

    h.episodes.append({
      content: 'Node N1 contradicting claim',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-primary-consulted',
      source: 'gmail',
      event_ts: 4_000_000,
    });

    await consolidator.consolidate();

    expect(driftCalls).toHaveLength(1);
    expect(driftCalls[0]!.candidateNodeId).toBe(n1);
    expect(driftCalls[0]!.confidence).toBe('high');
    expect(driftCalls[0]!.claimEventTs).toBe(4_000_000);
    expect(driftCalls[0]!.magnitude).toBe(0.5);
  });

  // ── 2. Secondary branch consulted ────────────────────────────────────────

  it('secondary branch consulted: a verdict listing a second contradicted id causes an additional evaluate() call carrying the SECONDARY node id', async () => {
    const dims = h.config.embeddingDimensions;
    const n1 = seedNode(h, 'Node N1 initial value', { s: 0.5, c: 0.5 });
    const n2 = seedNode(h, 'Node N2 initial value', { s: 0.5, c: 0.5 });

    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: n1,
      magnitude: 0.5,
      contradicted_ids: [n1, n2],
    };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Node N1+N2 contradicting claim',
        intent_status: 'interviewing',
        intent_entity: 'N1',
        intent_confidence: 'high',
      }])],
      judgeScript: [verdict],
    });
    const { consolidator } = makeConsolidator(h, provider);
    const driftCalls = attachDriftSpy(consolidator);

    h.episodes.append({
      content: 'Node N1+N2 contradicting claim',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-secondary-consulted',
      source: 'gmail',
      event_ts: 4_000_000,
    });

    await consolidator.consolidate();

    expect(driftCalls).toHaveLength(2);
    expect(driftCalls[0]!.candidateNodeId).toBe(n1);
    expect(driftCalls[1]!.candidateNodeId).toBe(n2);
  });

  // ── 3. Damped magnitude reaches routing ──────────────────────────────────

  it('damped magnitude value: statusDriftConfidenceDamping.medium=0.6 and a judge magnitude of 0.5 damps the value the drift layer hands to routing to 0.3', async () => {
    const dims = h.config.embeddingDimensions;
    const nodeId = seedNode(h, 'Node DV initial value', { s: 0.5, c: 0.5 });
    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: nodeId,
      magnitude: 0.5,
      contradicted_ids: [nodeId],
    };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Node DV contradicting claim',
        intent_status: 'interviewing',
        intent_entity: 'DV',
        intent_confidence: 'medium',
      }])],
      judgeScript: [verdict],
    });
    const { consolidator } = makeConsolidator(h, provider);
    const driftCalls = attachDriftSpy(consolidator);

    h.episodes.append({
      content: 'Node DV contradicting claim',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-damped-value',
      source: 'gmail',
      event_ts: 4_000_000,
    });

    await consolidator.consolidate();

    expect(driftCalls).toHaveLength(1);
    expect(driftCalls[0]!.resultAction).toBe('proceed');
    expect(driftCalls[0]!.resultDamped).toBe(true);
    expect(driftCalls[0]!.resultMagnitude).toBe(0.3);
  });

  it('damped magnitude reaches routing: medium confidence (factor 0.6) flips the routed outcome vs the undamped judge magnitude', async () => {
    const dims = h.config.embeddingDimensions;
    // resistance = s * c = 0.8 * 0.5 = 0.4. Undamped ratio = 0.5/0.4 = 1.25 -> 'reconcile'.
    // Damped ratio (0.5*0.6=0.3) = 0.3/0.4 = 0.75 -> 'hold'. The routes DIFFER, proving the
    // damped value (not the judge's raw value) is what reaches routeContradiction.
    async function runOnce(mediumFactor: number): Promise<{ tombstoned: boolean; sink: MockConsolidationSink }> {
      const hh = makeHarness({
        statusDriftConfidenceDamping: { ...DEFAULT_CONFIG.statusDriftConfidenceDamping, medium: mediumFactor },
      });
      const nodeId = seedNode(hh, 'Node R initial value', { s: 0.8, c: 0.5 });
      const verdict: JudgeVerdict = {
        relation: 'contradict',
        best_candidate_id: nodeId,
        magnitude: 0.5,
        contradicted_ids: [nodeId],
      };
      const provider = new MockModelProvider({
        embedFn: constEmbedFn(hh.config.embeddingDimensions),
        generateScript: [JSON.stringify([{
          type: 'fact',
          value: 'Node R contradicting claim',
          intent_status: 'interviewing',
          intent_entity: 'R',
          intent_confidence: 'medium',
        }])],
        judgeScript: [verdict],
      });
      const { consolidator, sink } = makeConsolidator(hh, provider);
      hh.episodes.append({
        content: 'Node R contradicting claim',
        origin: 'observed',
        salience: 0.9,
        hard_keep: 1,
        role: 'user',
        session_id: 'sess-damped-routing',
        source: 'gmail',
        event_ts: 4_000_000,
      });
      await consolidator.consolidate();
      const node = getNode(hh, nodeId);
      return { tombstoned: node!.tombstoned === 1 || (node!.tombstoned as unknown) === true, sink };
    }

    const damped = await runOnce(0.6); // default factor -> damped to 0.3 -> hold (no tombstone)
    const undamped = await runOnce(1.0); // no damping -> 0.5 -> reconcile (tombstones original)

    expect(damped.tombstoned).toBe(false);
    expect(undamped.tombstoned).toBe(true);
    expect(damped.sink.events.some((e) => e.event_type === 'contradict_hold')).toBe(true);
    expect(undamped.sink.events.some((e) => e.event_type === 'contradict_reconcile')).toBe(true);
  });

  // ── 4/5. Drop short-circuits everything, including secondaries ──────────

  it('drop short-circuits everything: a stale primary produces zero new consolidation_event rows, zero new pending_contradictions, no node mutation, and leaves a secondary untouched', async () => {
    const dims = h.config.embeddingDimensions;
    const ANCHOR_VALUE = 'anchor placeholder node';
    const N_VALUE = 'Acme Corp application status: submitted';
    const M_VALUE = 'Globex Corp application status: submitted';
    const CONTRADICT_VALUE = 'Acme Corp application status: rejected';
    const MINT_MARKER = '[EP-MINT-N]';
    const DROP_MARKER = '[EP-DROP]';

    const anchorId = seedNode(h, ANCHOR_VALUE);
    const mId = seedNode(h, M_VALUE); // secondary placeholder — never expected to mutate

    // ── Pass 1: mint N via a real 'extend' outcome tied to a dated gmail episode (T_NEW). ──
    const mintProvider = new MarkerProvider(
      constEmbedFn(dims),
      [{ marker: MINT_MARKER, claims: [{ type: 'fact', value: N_VALUE }] }],
      (_claim, _candidates) => ({
        relation: 'extend',
        best_candidate_id: anchorId,
        magnitude: 0.1,
        contradicted_ids: [],
      }),
    );
    const consolidator = makeConsolidatorWithRealSink(h, mintProvider);
    h.episodes.append({
      content: `Update ${MINT_MARKER}: ${N_VALUE}`,
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-mint-n',
      source: 'gmail',
      event_ts: 5_000_000, // T_NEW
    });
    await consolidator.consolidate();

    const nRow = h.db.prepare('SELECT id FROM node WHERE value = ?').get(N_VALUE) as { id: string } | undefined;
    expect(nRow).toBeDefined();
    const nId = nRow!.id;

    const nEventsBefore = countConsolidationEventsForNode(h, nId);
    expect(nEventsBefore).toBe(1); // the 'extend' mint event
    const nNodeBefore = getNode(h, nId);
    const mNodeBefore = getNode(h, mId);

    // ── Pass 2: episode B carries an OLDER event_ts than N's supporting evidence (T_NEW) —
    // the drop path must fire and produce zero graph effect on both N (primary) and M (secondary).
    const dropDriftCalls = attachDriftSpy(consolidator);
    (consolidator as unknown as { provider: ModelProvider }).provider = new MarkerProvider(
      constEmbedFn(dims),
      [{ marker: DROP_MARKER, claims: [{
        type: 'fact',
        value: CONTRADICT_VALUE,
        intent_status: 'rejected',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === N_VALUE);
        if (!target) throw new Error('drop fixture: N not found among candidates');
        return {
          relation: 'contradict',
          best_candidate_id: target.id,
          magnitude: 0.5,
          contradicted_ids: [target.id, mId],
        };
      },
    );
    h.episodes.append({
      content: `Update ${DROP_MARKER}: ${CONTRADICT_VALUE}`,
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-drop',
      source: 'gmail',
      event_ts: 1_000_000, // T_OLD — predates N's supporting evidence (T_NEW = 5_000_000)
    });
    await consolidator.consolidate();

    // Drift was consulted exactly once — for the PRIMARY — and returned 'drop'. The secondary
    // loop never ran (break happens before it), so applySecondaryContradiction's own evaluate()
    // call for M was never reached.
    expect(dropDriftCalls).toHaveLength(1);
    expect(dropDriftCalls[0]!.candidateNodeId).toBe(nId);
    expect(dropDriftCalls[0]!.resultAction).toBe('drop');

    // No graph effect at all: zero new consolidation_event rows, zero new pending_contradictions,
    // no node mutation — for both N (primary) and M (secondary).
    expect(countConsolidationEventsForNode(h, nId)).toBe(nEventsBefore);
    const nNodeAfter = getNode(h, nId);
    expect(pendingContradictionsCount(nNodeAfter!)).toBe(pendingContradictionsCount(nNodeBefore!));
    expect(nNodeAfter).toEqual(nNodeBefore);

    const mNodeAfter = getNode(h, mId);
    expect(mNodeAfter).toEqual(mNodeBefore);
    expect(countConsolidationEventsForNode(h, mId)).toBe(0);

    // Episode B still completed the pass (not quarantined) despite producing no graph effect.
    const epRows = h.db.prepare("SELECT session_id, consolidated FROM episode WHERE session_id = 'sess-drop'").all() as Array<{ consolidated: number }>;
    expect(epRows).toHaveLength(1);
    expect(epRows[0]!.consolidated).toBe(1);
  });

  // ── 6. Non-gmail no-op: structural, no staleness query ───────────────────

  it('non-gmail no-op: evaluate() returns not-applicable and the magnitude reaching routing equals the judge value unchanged', async () => {
    const dims = h.config.embeddingDimensions;
    const nodeId = seedNode(h, 'Node NG initial value', { s: 0.5, c: 0.5 });
    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: nodeId,
      magnitude: 0.5,
      contradicted_ids: [nodeId],
    };
    // No intent_status/entity/confidence fields — and even if the extraction tried to smuggle
    // them, the D-10 hoisted gmailSourced gate would discard them for a non-gmail source.
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'Node NG contradicting claim' }])],
      judgeScript: [verdict],
    });
    const { consolidator } = makeConsolidator(h, provider);
    const driftCalls = attachDriftSpy(consolidator);

    h.episodes.append({
      content: 'Node NG contradicting claim',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-non-gmail',
      // source omitted -> defaults to 'claude-code' (non-gmail)
    });

    await consolidator.consolidate();

    expect(driftCalls).toHaveLength(1);
    expect(driftCalls[0]!.confidence).toBeUndefined();
    expect(driftCalls[0]!.resultStaleness).toBe('not-applicable');
    expect(driftCalls[0]!.resultMagnitude).toBe(0.5); // unchanged
  });

  it('non-gmail no-op: whole-DB snapshot is identical between stock config and statusDriftEnabled:false', async () => {
    const dims = DEFAULT_CONFIG.embeddingDimensions;

    async function runFixture(overrides: Partial<EngineConfig>): Promise<Database.Database> {
      const hh = makeHarness(overrides);
      const nodeId = seedNode(hh, 'Node NG2 initial value', { s: 0.5, c: 0.5 });
      const verdict: JudgeVerdict = {
        relation: 'contradict',
        best_candidate_id: nodeId,
        magnitude: 0.5,
        contradicted_ids: [nodeId],
      };
      const provider = new MockModelProvider({
        embedFn: constEmbedFn(dims),
        generateScript: [JSON.stringify([{ type: 'fact', value: 'Node NG2 contradicting claim' }])],
        judgeScript: [verdict],
      });
      const { consolidator } = makeConsolidator(hh, provider);
      hh.episodes.append({
        content: 'Node NG2 contradicting claim',
        origin: 'observed',
        salience: 0.9,
        hard_keep: 1,
        role: 'user',
        session_id: 'sess-non-gmail-snapshot',
      });
      await consolidator.consolidate();
      return hh.db;
    }

    const stockDb = await runFixture({});
    const disabledDb = await runFixture({ statusDriftEnabled: false });

    expect(snapshotDb(stockDb)).toEqual(snapshotDb(disabledDb));
  });

  // ── 7. Master switch ──────────────────────────────────────────────────────

  it('master switch: statusDriftEnabled:false routes a gmail low-confidence contradiction exactly as pre-Phase-65 (no damping applied)', async () => {
    const dims = DEFAULT_CONFIG.embeddingDimensions;
    // resistance = 0.8*0.5=0.4. Undamped magnitude 0.5 -> ratio 1.25 -> reconcile.
    // If the (default) 'low' damping factor (0) were applied, magnitude would be 0 -> hold.
    // statusDriftEnabled:false must produce the UNDAMPED (reconcile) outcome.
    const h2 = makeHarness({ statusDriftEnabled: false });
    const nodeId = seedNode(h2, 'Node MS initial value', { s: 0.8, c: 0.5 });
    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: nodeId,
      magnitude: 0.5,
      contradicted_ids: [nodeId],
    };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Node MS contradicting claim',
        intent_status: 'rejected',
        intent_entity: 'MS',
        intent_confidence: 'low',
      }])],
      judgeScript: [verdict],
    });
    const { consolidator, sink } = makeConsolidator(h2, provider);
    const driftCalls = attachDriftSpy(consolidator);

    h2.episodes.append({
      content: 'Node MS contradicting claim',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-master-switch',
      source: 'gmail',
      event_ts: 4_000_000,
    });

    await consolidator.consolidate();

    expect(driftCalls).toHaveLength(1);
    expect(driftCalls[0]!.resultStaleness).toBe('guard-off');
    expect(driftCalls[0]!.resultMagnitude).toBe(0.5); // unchanged despite low confidence
    const node = getNode(h2, nodeId);
    expect(node!.tombstoned).toBeTruthy(); // reconcile tombstones the original
    expect(sink.events.some((e) => e.event_type === 'contradict_reconcile')).toBe(true);
    expect(sink.events.some((e) => e.event_type === 'contradict_hold')).toBe(false);
  });

  // ── 8/9. Per-source contradictionN threshold ──────────────────────────────

  it('per-source threshold: contradictionNBySource:{gmail:2} force-destabilizes at 2 distinct gmail provenances', async () => {
    const dims = DEFAULT_CONFIG.embeddingDimensions;
    const h2 = makeHarness({ contradictionNBySource: { gmail: 2 } });
    // resistance = 0.9*0.9=0.81; magnitude 0.5 -> ratio 0.617 < 0.8 -> hold (both episodes).
    const nodeId = seedNode(h2, 'Node T initial value', { s: 0.9, c: 0.9 });
    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: nodeId,
      magnitude: 0.5,
      contradicted_ids: [nodeId],
    };
    // No intent fields -> drift layer is a structural no-op (isolates this test from staleness/damping).
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [
        JSON.stringify([{ type: 'fact', value: 'Node T contradicting claim one' }]),
        JSON.stringify([{ type: 'fact', value: 'Node T contradicting claim two' }]),
      ],
      judgeScript: [verdict, verdict],
    });
    const { consolidator } = makeConsolidator(h2, provider);

    h2.episodes.append({
      content: 'Node T contradicting claim one',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-thresh-a', source: 'gmail',
    });
    await consolidator.consolidate();

    h2.episodes.append({
      content: 'Node T contradicting claim two',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-thresh-b', source: 'gmail',
    });
    await consolidator.consolidate();

    const node = getNode(h2, nodeId);
    expect(node!.tombstoned).toBeTruthy(); // force-destabilized at distinctCount=2 >= threshold=2
  });

  it('per-source threshold: the stock empty map ({}) does NOT force-destabilize at the same 2 distinct gmail provenances', async () => {
    const dims = DEFAULT_CONFIG.embeddingDimensions;
    const h2 = makeHarness({}); // stock contradictionNBySource: {} -> falls back to global contradictionN=3
    const nodeId = seedNode(h2, 'Node T2 initial value', { s: 0.9, c: 0.9 });
    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: nodeId,
      magnitude: 0.5,
      contradicted_ids: [nodeId],
    };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [
        JSON.stringify([{ type: 'fact', value: 'Node T2 contradicting claim one' }]),
        JSON.stringify([{ type: 'fact', value: 'Node T2 contradicting claim two' }]),
      ],
      judgeScript: [verdict, verdict],
    });
    const { consolidator } = makeConsolidator(h2, provider);

    h2.episodes.append({
      content: 'Node T2 contradicting claim one',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-thresh2-a', source: 'gmail',
    });
    await consolidator.consolidate();

    h2.episodes.append({
      content: 'Node T2 contradicting claim two',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-thresh2-b', source: 'gmail',
    });
    await consolidator.consolidate();

    const node = getNode(h2, nodeId);
    expect(node!.tombstoned).toBeFalsy(); // distinctCount=2 < global contradictionN=3 -> hold only
  });

  // ── 10. Counters ──────────────────────────────────────────────────────────

  it('counters: a pass with one damped, one dropped, and one undated decision reports 1/1/1', async () => {
    const dims = DEFAULT_CONFIG.embeddingDimensions;
    const ANCHOR_VALUE = 'counters anchor node';
    const D_VALUE = 'Node D initial value';
    const E_VALUE = 'Node E initial value';
    const F_VALUE = 'Node F initial value';
    const MINT_D = '[EP-MINT-D]';
    const MINT_E = '[EP-MINT-E]';
    const MINT_F = '[EP-MINT-F]';
    const HIT_D = '[EP-HIT-D]'; // damped: confidence=medium, event_ts newer than prior -> proceed+damped
    const HIT_E = '[EP-HIT-E]'; // dropped: confidence=high, event_ts OLDER than prior -> drop
    const HIT_F = '[EP-HIT-F]'; // undated: confidence=high, event_ts=null -> unknown-claim-ts

    const anchorId = seedNode(h, ANCHOR_VALUE);

    // ── Pass 0: mint D, E, F, each via a real 'extend' tied to a dated (T0) gmail episode. ──
    const mintProvider = new MarkerProvider(
      constEmbedFn(dims),
      [
        { marker: MINT_D, claims: [{ type: 'fact', value: D_VALUE }] },
        { marker: MINT_E, claims: [{ type: 'fact', value: E_VALUE }] },
        { marker: MINT_F, claims: [{ type: 'fact', value: F_VALUE }] },
      ],
      (_claim, _candidates) => ({
        relation: 'extend',
        best_candidate_id: anchorId,
        magnitude: 0.1,
        contradicted_ids: [],
      }),
    );
    // A REAL sink is required here: the drift layer's staleness guard queries the
    // consolidation_event SQL table directly for prior supporting evidence, which a
    // MockConsolidationSink (in-memory capture only) never populates.
    const logLines: string[] = [];
    const consolidator = makeConsolidatorWithRealSink(h, mintProvider, (msg) => logLines.push(msg));

    const T0 = 1_000_000;
    h.episodes.append({ content: `Mint ${MINT_D}: ${D_VALUE}`, origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 'sess-mint-d', source: 'gmail', event_ts: T0 });
    h.episodes.append({ content: `Mint ${MINT_E}: ${E_VALUE}`, origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 'sess-mint-e', source: 'gmail', event_ts: T0 });
    h.episodes.append({ content: `Mint ${MINT_F}: ${F_VALUE}`, origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 'sess-mint-f', source: 'gmail', event_ts: T0 });
    await consolidator.consolidate();

    const dId = (h.db.prepare('SELECT id FROM node WHERE value = ?').get(D_VALUE) as { id: string }).id;
    const eId = (h.db.prepare('SELECT id FROM node WHERE value = ?').get(E_VALUE) as { id: string }).id;
    const fId = (h.db.prepare('SELECT id FROM node WHERE value = ?').get(F_VALUE) as { id: string }).id;

    // ── Counting pass: one damped, one dropped, one undated -- against D, E, F respectively. ──
    const T_NEWER = 5_000_000; // newer than T0 -> not stale
    const T_OLDER = 500_000;   // older than T0 -> stale, drop
    const countingProvider = new MarkerProvider(
      constEmbedFn(dims),
      [
        { marker: HIT_D, claims: [{ type: 'fact', value: 'contradict D', intent_status: 'interviewing', intent_entity: 'D', intent_confidence: 'medium' }] },
        { marker: HIT_E, claims: [{ type: 'fact', value: 'contradict E', intent_status: 'rejected', intent_entity: 'E', intent_confidence: 'high' }] },
        { marker: HIT_F, claims: [{ type: 'fact', value: 'contradict F', intent_status: 'offer', intent_entity: 'F', intent_confidence: 'high' }] },
      ],
      (claim, candidates) => {
        const targetValue = claim === 'contradict D' ? D_VALUE : claim === 'contradict E' ? E_VALUE : F_VALUE;
        const target = candidates.find((c) => c.value === targetValue);
        if (!target) throw new Error(`counters fixture: target for "${claim}" not found`);
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    );
    (consolidator as unknown as { provider: ModelProvider }).provider = countingProvider;

    h.episodes.append({ content: `Update ${HIT_D}: contradict D`, origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 'sess-hit-d', source: 'gmail', event_ts: T_NEWER });
    h.episodes.append({ content: `Update ${HIT_E}: contradict E`, origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 'sess-hit-e', source: 'gmail', event_ts: T_OLDER });
    h.episodes.append({ content: `Update ${HIT_F}: contradict F`, origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 'sess-hit-f', source: 'gmail', event_ts: null });
    await consolidator.consolidate();

    // Two consolidate() passes ran (mint, then counting) -- take the LAST DRIFT-65 line
    // (the counting pass's), not the mint pass's all-zero line.
    const driftLines = logLines.filter((l) => l.startsWith('DRIFT-65'));
    const driftLine = driftLines[driftLines.length - 1];
    expect(driftLine).toBeDefined();
    expect(driftLine).toContain('damped=1');
    expect(driftLine).toContain('staleDropped=1');
    expect(driftLine).toContain('eventTsUnknown=1');

    // Sanity: D and F were mutated (proceed), E was not (drop) -- confirms the three fixtures
    // actually landed on the intended outcome rather than all collapsing to one case.
    expect(getNode(h, dId)).not.toBeUndefined();
    expect(getNode(h, eId)!.pending_contradictions).toBe('[]'); // dropped: no recordContradiction
  });

  // ── 11. Sink honesty ──────────────────────────────────────────────────────

  it('sink honesty: for a damped-but-routed decision, the persisted consolidation_event.magnitude equals the JUDGE value, not the damped one', async () => {
    const dims = DEFAULT_CONFIG.embeddingDimensions;
    // resistance = 0.4*0.5 = 0.2. Damped magnitude (0.5*0.6=0.3) -> ratio 1.5 -> reconcile
    // (also independently forced by resistance < peAppendNewMinResistance=0.3).
    const nodeId = seedNode(h, 'Node SH initial value', { s: 0.4, c: 0.5 });
    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: nodeId,
      magnitude: 0.5,
      contradicted_ids: [nodeId],
    };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Node SH contradicting claim',
        intent_status: 'interviewing',
        intent_entity: 'SH',
        intent_confidence: 'medium',
      }])],
      judgeScript: [verdict],
    });
    const { consolidator, sink } = makeConsolidator(h, provider);
    const driftCalls = attachDriftSpy(consolidator);

    h.episodes.append({
      content: 'Node SH contradicting claim',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-sink-honesty',
      source: 'gmail',
      event_ts: 4_000_000,
    });

    await consolidator.consolidate();

    expect(driftCalls[0]!.resultMagnitude).toBe(0.3); // damped value drove routing
    const reconcileEvent = sink.events.find((e) => e.event_type === 'contradict_reconcile');
    expect(reconcileEvent).toBeDefined();
    expect(reconcileEvent!.magnitude).toBe(0.5); // sink records the judge's own value, not damped
  });
});
