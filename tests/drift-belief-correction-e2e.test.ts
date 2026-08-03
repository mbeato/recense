/**
 * DRIFT-02 and DRIFT-04 proven end to end through real consolidate() passes (Phase 65, Plan 65-09).
 *
 * Each `describe` block below opens with the requirement text it proves, quoted VERBATIM from
 * .planning/REQUIREMENTS.md, so a future reader sees the mapping without cross-referencing.
 * In short: DRIFT-02 says a single ambiguous email holds rather than flips a status and
 * produces no proposal; the DRIFT-03 consequence says provenance distinctness (sender identity
 * + thread lineage, quote/forward-stripped) is what lets genuinely independent evidence -- and
 * only genuinely independent evidence -- release a held belief; DRIFT-04 says out-of-order
 * evidence cannot silently revert a newer status.
 *
 * Every outcome asserted below comes from a REAL `consolidate()` pass over real seeded
 * episodes -- no assertion path calls the drift decision method, the PE-gate routing function,
 * or the distinct-provenance counter directly. Those are proven in their own unit suites
 * (`tests/status-drift.test.ts`, `tests/pe-machinery-lock.test.ts`,
 * `tests/update-decision.test.ts`); this file's whole value is exercising the COMPOSITION —
 * the drift layer, the PE gate, the provenance-distinctness key, and the consolidator's
 * contradict branches wired together, exactly as Plan 65-08 wired them.
 *
 * Fixture provenance keys come from the REAL `deriveGmailProvenanceKey`
 * (src/source/provenance-key.ts), never a hand-written session_id string -- so a derivation
 * regression surfaces here too. `resolveGmailSessionId` below applies the exact same ternary
 * `gmail-adapter.ts:590-592` applies in production (`provenanceDistinctnessEnabled ? derived :
 * COLLAPSED_GMAIL_PROVENANCE_KEY`) so the harness config genuinely gates which session_id a
 * fixture episode carries, mirroring the real ingest path without duplicating its decision
 * logic.
 *
 * `provenanceDistinctnessEnabled: true` is set explicitly (and commented why) in every
 * fixture EXCEPT the dark-default case: the shipped default is `false` pending Plan 65-10's
 * dry-run (src/lib/config.ts DEFAULT_CONFIG), so these suites are testing the behavior the
 * switch unlocks. The dark-default case is what keeps that fact visible in the test suite
 * itself, not just in a config comment (D-14/D-15 honesty discipline applied to the test
 * layer) -- it is deliberate, not a redundant duplicate.
 *
 * The content-keyed `MarkerProvider` below (copied from tests/status-drift-wiring.test.ts's
 * documented duplication convention) branches on a marker substring in the extraction prompt
 * and THROWS on an unrecognized prompt, and its judge resolver resolves `best_candidate_id`
 * from the LIVE `candidates` array by matching the belief's current value string -- never off
 * call order or a fixed queue. A call-order-indexed script would return the "right" verdict
 * regardless of whether the drift layer or the provenance key were actually consulted,
 * producing a green test that proves nothing (tests/backfill-chronological-order.test.ts names
 * this defect class T-62-36; this file follows the same discipline).
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import type { ModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { MockModelProvider } from '../src/model/provider';
import { SQLiteConsolidationSink, type ConsolidationSink } from '../src/consolidation/sink';
import { EventStore } from '../src/db/event-store';
import { newId } from '../src/lib/hash';
import type { NodeRow } from '../src/lib/types';
import { deriveGmailProvenanceKey, COLLAPSED_GMAIL_PROVENANCE_KEY } from '../src/source/provenance-key';

// ---------------------------------------------------------------------------
// Embed helper — constant vector for every text (cosine 1.0 between any two embedded texts).
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

function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Wired with a REAL SQLiteConsolidationSink so consolidation_event rows land in the DB --
 * required because the drift layer's staleness guard queries that table directly (mirrors
 * tests/status-drift-wiring.test.ts's makeConsolidatorWithRealSink). */
function makeConsolidatorWithRealSink(h: Harness, provider: ModelProvider): Consolidator {
  const sink: ConsolidationSink = new SQLiteConsolidationSink(new EventStore(h.db), h.clock);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink,
  );
}

function seedNode(h: Harness, value: string): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'fact', value, origin: 'observed' });
  h.store.setEmbedding(id, constVec(h.config.embeddingDimensions));
  return id;
}

function getNodeById(h: Harness, id: string): NodeRow {
  const row = h.db.prepare('SELECT * FROM node WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) throw new Error(`getNodeById: node ${id} not found`);
  return row;
}

function getLiveNodeByValue(h: Harness, value: string): NodeRow | undefined {
  return h.db
    .prepare("SELECT * FROM node WHERE type = 'fact' AND tombstoned = 0 AND value = ?")
    .get(value) as NodeRow | undefined;
}

function pendingContradictionsCount(node: NodeRow): number {
  return (JSON.parse(node.pending_contradictions || '[]') as unknown[]).length;
}

function swapProvider(consolidator: Consolidator, provider: ModelProvider): void {
  (consolidator as unknown as { provider: ModelProvider }).provider = provider;
}

/**
 * Mirrors gmail-adapter.ts:590-592's exact ternary -- the ONE decision point that gates
 * whether an episode's session_id carries the real derived provenance key or the collapsed
 * fallback. Calls the REAL `deriveGmailProvenanceKey`; does not re-derive or duplicate its
 * internal logic.
 */
function resolveGmailSessionId(
  h: Harness,
  args: { fromHeader: string; threadId: string; bodyText: string },
): string {
  const derived = deriveGmailProvenanceKey({
    fromHeader: args.fromHeader,
    threadId: args.threadId,
    bodyText: args.bodyText,
    minResidualChars: h.config.provenanceMinResidualChars,
  });
  return h.config.provenanceDistinctnessEnabled ? derived : COLLAPSED_GMAIL_PROVENANCE_KEY;
}

// ---------------------------------------------------------------------------
// MarkerProvider — content-keyed extraction + claim-value-keyed judge resolution (copied from
// tests/status-drift-wiring.test.ts per that file's documented duplication convention).
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

/**
 * Establish a belief node through a REAL first `consolidate()` pass (extend from a seeded
 * anchor), rather than a hand-seeded node -- so every downstream case in this file exercises
 * the genuine `consolidation_event` -> `episode.event_ts` join the drift layer's staleness
 * guard depends on (DRIFT-04), not a hand-inserted row.
 */
async function establishBelief(
  h: Harness,
  value: string,
  opts: { eventTs?: number | null } = {},
): Promise<{ consolidator: Consolidator; nodeId: string }> {
  const anchorId = seedNode(h, `anchor for: ${value}`);
  const mintMarker = `[EP-MINT:${value}]`;
  const mintProvider = new MarkerProvider(
    constEmbedFn(h.config.embeddingDimensions),
    [{ marker: mintMarker, claims: [{ type: 'fact', value }] }],
    () => ({ relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] }),
  );
  const consolidator = makeConsolidatorWithRealSink(h, mintProvider);
  h.episodes.append({
    content: `Establishing update ${mintMarker}: ${value}`,
    origin: 'observed',
    salience: 0.9,
    hard_keep: 1,
    role: 'user',
    session_id: 'sess-establish-belief',
    source: 'gmail',
    event_ts: opts.eventTs ?? null,
  });
  await consolidator.consolidate();
  const row = h.db.prepare('SELECT id FROM node WHERE value = ?').get(value) as { id: string };
  return { consolidator, nodeId: row.id };
}

/**
 * Establish a belief node through a REAL first `consolidate()` pass over an EMPTY graph, so the
 * auto-unrelated branch (`consolidator.ts:947-973`) fires deterministically: zero cosine
 * candidates, zero anchors, zero BM25 hits -- and, critically, no judge call at all. This is
 * the genuine cold-start mint path this plan (65-11) exists to close: `establishBelief`'s
 * seeded anchor is exactly what let the shipped DRIFT-04 e2e suite pass over
 * `65-VERIFICATION.md`'s second `missing` item, because it always mints via 'extend' and never
 * exercises the 'unrelated' branch every brand-new tracked entity's FIRST status email actually
 * takes. Do NOT modify `establishBelief` -- the existing cases above depend on its 'extend'
 * path; this is a sibling, not a replacement.
 */
async function establishBeliefColdStart(
  h: Harness,
  value: string,
  opts: { eventTs?: number | null } = {},
): Promise<{ consolidator: Consolidator; nodeId: string }> {
  const mintMarker = `[EP-COLDSTART-MINT:${value}]`;
  const mintProvider = new MarkerProvider(
    constEmbedFn(h.config.embeddingDimensions),
    [{ marker: mintMarker, claims: [{ type: 'fact', value }] }],
    () => {
      throw new Error(
        'establishBeliefColdStart: judge resolver was called -- the auto-unrelated branch ' +
        '(consolidator.ts:947-973) makes NO judge call. If this throws, the fixture stopped ' +
        'taking the cold-start mint path and silently reverted to an extend/confirm mint.',
      );
    },
  );
  const consolidator = makeConsolidatorWithRealSink(h, mintProvider);
  h.episodes.append({
    content: `Establishing update ${mintMarker}: ${value}`,
    origin: 'observed',
    salience: 0.9,
    hard_keep: 1,
    role: 'user',
    session_id: 'sess-establish-belief-coldstart',
    source: 'gmail',
    event_ts: opts.eventTs ?? null,
  });
  await consolidator.consolidate();
  const row = h.db.prepare('SELECT id FROM node WHERE value = ?').get(value) as { id: string };
  return { consolidator, nodeId: row.id };
}

/**
 * Non-vacuity anchor for the cold-start cases below: asserts the node's ONLY
 * consolidation_event row is the 'unrelated' mint itself, with candidate_id null and
 * node_id equal to the minted node. Without this, a fixture that accidentally mints via
 * 'extend' or 'confirm' would pass for the wrong reason and re-hide the DRIFT-04 gap.
 */
function assertColdStartMint(h: Harness, nodeId: string): void {
  const rows = h.db
    .prepare('SELECT event_type, candidate_id, node_id FROM consolidation_event WHERE node_id = ?')
    .all(nodeId) as Array<{ event_type: string; candidate_id: string | null; node_id: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event_type).toBe('unrelated');
  expect(rows[0]!.candidate_id).toBeNull();
  expect(rows[0]!.node_id).toBe(nodeId);
}

// ---------------------------------------------------------------------------
// Shared contradiction-fixture runner for the DRIFT-03 consequence cases
// ---------------------------------------------------------------------------

interface ContradictionEmailFixture {
  marker: string;
  fromHeader: string;
  threadId: string;
  body: string;
}

/**
 * Establishes `belief.value`, then runs each fixture as its OWN separate `consolidate()` pass
 * (never batched into one pass) -- this sidesteps any question of intra-pass processing order
 * entirely, mirroring tests/status-drift-wiring.test.ts's per-source-threshold tests (two
 * separate sequential consolidate() calls). Every fixture uses IDENTICAL confidence (`low`)
 * and magnitude (`0.5`) -- only bodies and sender domains/threads vary, per the plan's
 * discrimination requirement.
 */
async function runContradictionFixtures(
  h: Harness,
  belief: { value: string; eventTs?: number },
  fixtures: readonly ContradictionEmailFixture[],
  contradictValue: string,
): Promise<{ oldNodeId: string; finalOldNode: NodeRow; newNode: NodeRow | undefined }> {
  const { consolidator, nodeId: oldNodeId } = await establishBelief(h, belief.value, {
    eventTs: belief.eventTs ?? 1_000_000,
  });

  for (const [i, fx] of fixtures.entries()) {
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: fx.marker, claims: [{
        type: 'fact', value: contradictValue,
        intent_status: 'rejected', intent_entity: 'entity', intent_confidence: 'low',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === belief.value);
        if (!target) throw new Error(`fixture "${fx.marker}": belief node not found among candidates`);
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    ));
    const sessionId = resolveGmailSessionId(h, { fromHeader: fx.fromHeader, threadId: fx.threadId, bodyText: fx.body });
    h.episodes.append({
      content: `Update ${fx.marker}: ${fx.body}`,
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: sessionId,
      source: 'gmail',
      event_ts: (belief.eventTs ?? 1_000_000) + 1_000_000 + i * 100_000,
    });
    await consolidator.consolidate();
  }

  const finalOldNode = getNodeById(h, oldNodeId);
  const newNode = getLiveNodeByValue(h, contradictValue);
  return { oldNodeId, finalOldNode, newNode };
}

const INDEPENDENT_FIXTURES: readonly ContradictionEmailFixture[] = [
  {
    marker: '[EP-IND-A]',
    fromHeader: 'Recruiter One <hr@careers.acme-corp.example>',
    threadId: 'threadIndependentA01',
    body: 'Hi, I wanted to personally follow up -- the hiring committee met today and discussed your candidacy directly (ref case-alpha).',
  },
  {
    marker: '[EP-IND-B]',
    fromHeader: 'Recruiter Two <talent@globex.example>',
    threadId: 'threadIndependentB02',
    body: 'Following up separately from our end -- our team reviewed your file this week and wanted to give you a direct heads up (ref case-beta).',
  },
  {
    marker: '[EP-IND-C]',
    fromHeader: 'Recruiter Three <people@initech.example>',
    threadId: 'threadIndependentC03',
    body: 'Writing to you personally with an update -- leadership discussed your application in our meeting today (ref case-gamma).',
  },
];

// Three forwards of one underlying message: three different forwarding senders, three
// different (Gmail-assigned) thread ids -- deliberately still varying thread id like the
// independent fixture above, so what proves the negative here is the RESIDUAL gate (pure
// quotation, near-zero non-whitespace residual), not an accidental shared thread id.
const FORWARD_FIXTURES: readonly ContradictionEmailFixture[] = [
  {
    marker: '[EP-FWD-A]',
    fromHeader: 'Colleague One <fwd1@example.com>',
    threadId: 'threadForwardedOne01',
    body: '> Please see the note below.\n> Regards,\n> Original Sender',
  },
  {
    marker: '[EP-FWD-B]',
    fromHeader: 'Colleague Two <fwd2@example.com>',
    threadId: 'threadForwardedTwo02',
    body: '> Please see the note below.\n> Regards,\n> Original Sender',
  },
  {
    marker: '[EP-FWD-C]',
    fromHeader: 'Colleague Three <fwd3@example.com>',
    threadId: 'threadForwardedThr03',
    body: '> Please see the note below.\n> Regards,\n> Original Sender',
  },
];

// ---------------------------------------------------------------------------
// DRIFT-02: a single ambiguous email holds
// ---------------------------------------------------------------------------

describe('DRIFT-02: a single ambiguous email holds', () => {
  // REQUIREMENTS.md, verbatim: "A single ambiguous email does not flip a status — the update
  // holds until evidence clears the PE gate, and a held (non-decisive) update produces no
  // proposal."
  it('one ambiguous low-confidence gmail email holds: node stays live, value unchanged, one pending contradiction recorded', async () => {
    const h = makeHarness({ provenanceDistinctnessEnabled: true });
    const BELIEF_VALUE = 'Acme Corp application status: submitted, awaiting review';
    const { consolidator, nodeId } = await establishBelief(h, BELIEF_VALUE, { eventTs: 1_000_000 });

    const CONTRADICT_MARKER = '[EP-AMBIGUOUS-HOLD]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: CONTRADICT_MARKER, claims: [{
        type: 'fact', value: 'Acme Corp application status: possibly rejected',
        intent_status: 'rejected', intent_entity: 'Acme Corp', intent_confidence: 'low',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === BELIEF_VALUE);
        if (!target) throw new Error('ambiguous-hold fixture: belief node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    ));

    const sessionId = resolveGmailSessionId(h, {
      fromHeader: 'HR <hr@onedomain.example.com>',
      threadId: 'threadAmbiguous000001',
      bodyText: 'We wanted to give you a brief personal note about where things stand with your application.',
    });
    h.episodes.append({
      content: `Update ${CONTRADICT_MARKER}: an ambiguous personal note about the application`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: sessionId, source: 'gmail', event_ts: 2_000_000,
    });
    await consolidator.consolidate();

    const node = getNodeById(h, nodeId);
    expect(node.tombstoned).toBeFalsy();
    expect(node.value).toBe(BELIEF_VALUE);
    expect(pendingContradictionsCount(node)).toBe(1);
  });

  it('the held update produces no emission-eligible consolidation event -- honoring "a held update produces no proposal"', async () => {
    const h = makeHarness({ provenanceDistinctnessEnabled: true });
    const BELIEF_VALUE = 'Stark Industries application status: submitted, awaiting review';
    const { consolidator, nodeId } = await establishBelief(h, BELIEF_VALUE, { eventTs: 1_000_000 });

    const CONTRADICT_MARKER = '[EP-AMBIGUOUS-HOLD-NO-PROPOSAL]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: CONTRADICT_MARKER, claims: [{
        type: 'fact', value: 'Stark Industries application status: possibly rejected',
        intent_status: 'rejected', intent_entity: 'Stark Industries', intent_confidence: 'low',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === BELIEF_VALUE);
        if (!target) throw new Error('hold-no-proposal fixture: belief node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    ));
    const sessionId = resolveGmailSessionId(h, {
      fromHeader: 'HR <hr@stark.example.com>',
      threadId: 'threadHoldNoProposal01',
      bodyText: 'A brief personal note about where your application currently stands.',
    });
    h.episodes.append({
      content: `Update ${CONTRADICT_MARKER}: a brief personal note`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: sessionId, source: 'gmail', event_ts: 2_000_000,
    });
    await consolidator.consolidate();

    const events = h.db
      .prepare('SELECT event_type FROM consolidation_event WHERE node_id = ? OR candidate_id = ?')
      .all(nodeId, nodeId) as Array<{ event_type: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.event_type === 'contradict_hold')).toBe(true);
    // Not by name -- literally none of the three decisive/proposal-shaped event types appear.
    const emissionShapedTypes = ['contradict_reconcile', 'contradict_append_new', 'contradict_force_destabilize'];
    expect(events.some((e) => emissionShapedTypes.includes(e.event_type))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DRIFT-03 consequence: independence releases, forwarding does not
// ---------------------------------------------------------------------------

describe('DRIFT-03 consequence: independence releases, forwarding does not', () => {
  // REQUIREMENTS.md, verbatim: "Provenance distinctness is derived from sender identity +
  // thread lineage with quoted/forwarded content stripped first, so countDistinctProvenance
  // can fire on genuinely independent email evidence and a forwarded or quoted thread cannot
  // manufacture false independence."
  it('three genuinely independent status emails cross the distinct-provenance threshold: tombstone-and-mint-new', async () => {
    const h = makeHarness({ provenanceDistinctnessEnabled: true });
    const BELIEF_VALUE = 'Globex Corp application status: submitted, awaiting review';
    const CONTRADICT_VALUE = 'Globex Corp application status: rejected';

    const { finalOldNode, newNode } = await runContradictionFixtures(
      h, { value: BELIEF_VALUE }, INDEPENDENT_FIXTURES, CONTRADICT_VALUE,
    );

    // DRIFT-01 requires tombstone-and-mint-new specifically, not an in-place rewrite.
    expect(finalOldNode.tombstoned).toBeTruthy();
    expect(newNode).toBeDefined();
    expect(newNode!.prev_value).toBe(BELIEF_VALUE);
  });

  it('three forwards of one underlying thread do NOT cross the threshold: belief holds unchanged', async () => {
    const h = makeHarness({ provenanceDistinctnessEnabled: true });
    const BELIEF_VALUE = 'Initech Corp application status: submitted, awaiting review';
    const CONTRADICT_VALUE = 'Initech Corp application status: rejected';

    const { finalOldNode, newNode } = await runContradictionFixtures(
      h, { value: BELIEF_VALUE }, FORWARD_FIXTURES, CONTRADICT_VALUE,
    );

    expect(finalOldNode.tombstoned).toBeFalsy();
    expect(finalOldNode.value).toBe(BELIEF_VALUE);
    // Three hold entries were recorded (three attempts), but they collapse to ONE distinct
    // provenance (the residual gate fires before sender/thread are ever consulted), so the
    // force-destabilization threshold is never crossed.
    expect(pendingContradictionsCount(finalOldNode)).toBe(3);
    expect(newNode).toBeUndefined();
  });

  it('two of three independent status emails do not yet cross the threshold: belief still holds', async () => {
    const h = makeHarness({ provenanceDistinctnessEnabled: true });
    const BELIEF_VALUE = 'Wayne Enterprises application status: submitted, awaiting review';
    const CONTRADICT_VALUE = 'Wayne Enterprises application status: rejected';

    const { finalOldNode, newNode } = await runContradictionFixtures(
      h, { value: BELIEF_VALUE }, INDEPENDENT_FIXTURES.slice(0, 2), CONTRADICT_VALUE,
    );

    // Proves the threshold is exactly 3 (DEFAULT_CONFIG.contradictionN), not something lower --
    // two distinct provenances is still below it.
    expect(finalOldNode.tombstoned).toBeFalsy();
    expect(finalOldNode.value).toBe(BELIEF_VALUE);
    expect(pendingContradictionsCount(finalOldNode)).toBe(2);
    expect(newNode).toBeUndefined();
  });

  // Dark default (D-14/D-15 honesty discipline): the SAME three-independent-domain fixture as
  // above, run under the STOCK config (provenanceDistinctnessEnabled: false is the shipped
  // DEFAULT_CONFIG value -- NOT an override chosen to make this test pass). This keeps the
  // phase's differentiator gated behind the switch visible in the test suite itself, not only
  // in a config comment: without this case, a reader could believe DRIFT-03 ships live when it
  // in fact ships dark pending Plan 65-10's dry-run.
  it('dark default: the same three-independent fixture does NOT correct the belief under stock config', async () => {
    const h = makeHarness({ provenanceDistinctnessEnabled: false });
    expect(h.config.provenanceDistinctnessEnabled).toBe(DEFAULT_CONFIG.provenanceDistinctnessEnabled);
    const BELIEF_VALUE = 'Umbrella Corp application status: submitted, awaiting review';
    const CONTRADICT_VALUE = 'Umbrella Corp application status: rejected';

    const { finalOldNode, newNode } = await runContradictionFixtures(
      h, { value: BELIEF_VALUE }, INDEPENDENT_FIXTURES, CONTRADICT_VALUE,
    );

    expect(finalOldNode.tombstoned).toBeFalsy();
    expect(finalOldNode.value).toBe(BELIEF_VALUE);
    expect(newNode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DRIFT-04: out-of-order evidence cannot revert
// ---------------------------------------------------------------------------

describe('DRIFT-04: out-of-order evidence cannot revert', () => {
  // REQUIREMENTS.md, verbatim: "Out-of-order evidence (a rejection arriving after an offer)
  // does not silently revert a newer status."
  const DAY10 = 10 * 86_400_000;
  const DAY30 = 30 * 86_400_000;

  it('a rejection dated before an established offer, ingested and consolidated afterwards, does not revert the offer', async () => {
    const h = makeHarness();
    const OFFER_VALUE = 'Acme Corp application status: offer extended';
    const { consolidator, nodeId } = await establishBelief(h, OFFER_VALUE, { eventTs: DAY30 });

    const REJECTION_MARKER = '[EP-STALE-REJECTION]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: REJECTION_MARKER, claims: [{
        type: 'fact', value: 'Acme Corp application status: rejected',
        intent_status: 'rejected', intent_entity: 'Acme Corp', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === OFFER_VALUE);
        if (!target) throw new Error('DRIFT-04 no-revert fixture: offer node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${REJECTION_MARKER}: Acme Corp application status: rejected`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-stale-rejection', source: 'gmail', event_ts: DAY10, // older than the offer's supporting evidence
    });
    await consolidator.consolidate();

    const node = getNodeById(h, nodeId);
    expect(node.tombstoned).toBeFalsy();
    expect(node.value).toBe(OFFER_VALUE);
    // Dropped, not held: no pending_contradictions entry at all -- distinguishes this from a
    // held-but-undecided outcome.
    expect(pendingContradictionsCount(node)).toBe(0);
  });

  it('the drop path produces ZERO new consolidation_event rows for the stale rejection -- no audit trail, not just an unchanged node', async () => {
    const h = makeHarness();
    const OFFER_VALUE = 'Wayne Enterprises application status: offer extended';
    const { consolidator, nodeId } = await establishBelief(h, OFFER_VALUE, { eventTs: DAY30 });
    const eventsBefore = (
      h.db.prepare('SELECT COUNT(*) AS n FROM consolidation_event WHERE node_id = ? OR candidate_id = ?').get(nodeId, nodeId) as { n: number }
    ).n;

    const REJECTION_MARKER = '[EP-STALE-REJECTION-NO-AUDIT]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: REJECTION_MARKER, claims: [{
        type: 'fact', value: 'Wayne Enterprises application status: rejected',
        intent_status: 'rejected', intent_entity: 'Wayne Enterprises', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === OFFER_VALUE);
        if (!target) throw new Error('DRIFT-04 no-audit fixture: offer node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${REJECTION_MARKER}: Wayne Enterprises application status: rejected`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-stale-rejection-no-audit', source: 'gmail', event_ts: DAY10,
    });
    await consolidator.consolidate();

    const eventsAfter = (
      h.db.prepare('SELECT COUNT(*) AS n FROM consolidation_event WHERE node_id = ? OR candidate_id = ?').get(nodeId, nodeId) as { n: number }
    ).n;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('discriminates on time, not content: the identical pair in CHRONOLOGICAL order (rejection first, offer second) DOES leave the offer as the surviving belief', async () => {
    const h = makeHarness();
    const REJECTED_VALUE = 'Globex Corp application status: rejected';
    const OFFER_VALUE = 'Globex Corp application status: offer extended';
    const { consolidator, nodeId: rejectedNodeId } = await establishBelief(h, REJECTED_VALUE, { eventTs: DAY10 });

    const OFFER_MARKER = '[EP-CHRONO-OFFER]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: OFFER_MARKER, claims: [{
        type: 'fact', value: OFFER_VALUE,
        intent_status: 'offer', intent_entity: 'Globex Corp', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === REJECTED_VALUE);
        if (!target) throw new Error('DRIFT-04 chronological fixture: rejected node not found among candidates');
        // Freshly-minted node resistance (s=0.1, c=0.5 -> resistance=0.05); magnitude 0.06 ->
        // ratio 1.2 -> mid-band reconcile (tombstone old + mint new current).
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.06, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${OFFER_MARKER}: ${OFFER_VALUE}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-chrono-offer', source: 'gmail', event_ts: DAY30, // newer -- not stale
    });
    await consolidator.consolidate();

    const rejectedNode = getNodeById(h, rejectedNodeId);
    expect(rejectedNode.tombstoned).toBeTruthy();
    const offerNode = getLiveNodeByValue(h, OFFER_VALUE);
    expect(offerNode).toBeDefined();
    expect(offerNode!.prev_value).toBe(REJECTED_VALUE);
  });

  it('abstains honestly: event_ts:null on the contradicting episode falls back to pre-Phase-65 hold behavior rather than dropping', async () => {
    const h = makeHarness();
    const OFFER_VALUE = 'Initech Corp application status: offer extended';
    const { consolidator, nodeId } = await establishBelief(h, OFFER_VALUE, { eventTs: DAY30 });

    const NULL_TS_MARKER = '[EP-NULL-TS-REJECTION]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: NULL_TS_MARKER, claims: [{
        type: 'fact', value: 'Initech Corp application status: rejected',
        intent_status: 'rejected', intent_entity: 'Initech Corp', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === OFFER_VALUE);
        if (!target) throw new Error('DRIFT-04 null-ts fixture: offer node not found among candidates');
        // resistance=0.05 (fresh mint); magnitude 0.02 -> ratio 0.4 -> hold. A recorded
        // pending_contradictions entry (not a mutation) is the discriminating signal that this
        // claim was HELD, not silently dropped.
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.02, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${NULL_TS_MARKER}: Initech Corp application status: rejected`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-null-ts-rejection', source: 'gmail', event_ts: null,
    });
    await consolidator.consolidate();

    const node = getNodeById(h, nodeId);
    expect(node.tombstoned).toBeFalsy();
    expect(node.value).toBe(OFFER_VALUE);
    expect(pendingContradictionsCount(node)).toBe(1);
  });

  it("cold-start ('unrelated'-minted) belief: a stale backfilled contradiction cannot revert it", async () => {
    // REQUIREMENTS.md, verbatim: "Out-of-order evidence (a rejection arriving after an offer)
    // does not silently revert a newer status." This is 65-VERIFICATION.md's BLOCKER
    // regression guard: every case above establishes its belief via establishBelief()'s
    // seeded-anchor 'extend' path, which structurally cannot reach the cold-start 'unrelated'
    // mint that every brand-new tracked entity's FIRST status email actually takes (no existing
    // candidate at all -> consolidator.ts:947-973's auto-unrelated gate).
    const h = makeHarness();
    const OFFER_VALUE = 'Massive Dynamic application status: offer extended';
    const { consolidator, nodeId } = await establishBeliefColdStart(h, OFFER_VALUE, { eventTs: DAY30 });
    assertColdStartMint(h, nodeId);
    const eventsBefore = (
      h.db.prepare('SELECT COUNT(*) AS n FROM consolidation_event WHERE node_id = ? OR candidate_id = ?').get(nodeId, nodeId) as { n: number }
    ).n;

    const REJECTION_MARKER = '[EP-COLDSTART-STALE-REJECTION]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: REJECTION_MARKER, claims: [{
        type: 'fact', value: 'Massive Dynamic application status: rejected',
        intent_status: 'rejected', intent_entity: 'Massive Dynamic', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === OFFER_VALUE);
        if (!target) throw new Error('cold-start stale fixture: offer node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${REJECTION_MARKER}: Massive Dynamic application status: rejected`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-coldstart-stale-rejection', source: 'gmail', event_ts: DAY10, // older than the mint
    });
    await consolidator.consolidate();

    const node = getNodeById(h, nodeId);
    expect(node.tombstoned).toBeFalsy();
    expect(node.value).toBe(OFFER_VALUE);
    expect(pendingContradictionsCount(node)).toBe(0);
    const eventsAfter = (
      h.db.prepare('SELECT COUNT(*) AS n FROM consolidation_event WHERE node_id = ? OR candidate_id = ?').get(nodeId, nodeId) as { n: number }
    ).n;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("cold-start chronological control: a NEWER contradiction against an 'unrelated'-minted belief still routes normally", async () => {
    // States what proves the fix discriminates on TIME rather than blanket-suppressing every
    // contradiction against a cold-start-minted node: the identical mint, only NEWER, still
    // corrects the belief by tombstone-and-mint-new through the unmodified PE machinery.
    const h = makeHarness();
    const OFFER_VALUE = 'Massive Dynamic Holdings application status: offer extended';
    const REJECTED_VALUE = 'Massive Dynamic Holdings application status: rejected';
    const { consolidator, nodeId } = await establishBeliefColdStart(h, OFFER_VALUE, { eventTs: DAY10 });
    assertColdStartMint(h, nodeId);

    const REJECTION_MARKER = '[EP-COLDSTART-CHRONO]';
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: REJECTION_MARKER, claims: [{
        type: 'fact', value: REJECTED_VALUE,
        intent_status: 'rejected', intent_entity: 'Massive Dynamic Holdings', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === OFFER_VALUE);
        if (!target) throw new Error('cold-start chronological fixture: offer node not found among candidates');
        // Observed cold-start mint resistance is identical to the 'extend' mint's: upsertNode
        // is called with no s/c override on either path (both default to s=0.1, c=0.5 ->
        // resistance=0.05). magnitude 0.06 -> ratio 1.2 -> mid-band reconcile, mirroring the
        // existing chronological control's 0.06-against-0.05 reasoning above.
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.06, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${REJECTION_MARKER}: ${REJECTED_VALUE}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-coldstart-chrono', source: 'gmail', event_ts: DAY30, // newer -- not stale
    });
    await consolidator.consolidate();

    const oldNode = getNodeById(h, nodeId);
    expect(oldNode.tombstoned).toBeTruthy();
    const newNode = getLiveNodeByValue(h, REJECTED_VALUE);
    expect(newNode).toBeDefined();
    expect(newNode!.prev_value).toBe(OFFER_VALUE);
  });
});
