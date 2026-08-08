/**
 * Behavioral suite for the EMIT-01/EMIT-04/EMIT-06 emission seam wired in Phase 66, Plan 66-04:
 * `Consolidator.maybeEmitProposal`, called at the nine decisive `applyDecision` sites, gated on
 * the imported `isEmissionEligible` predicate and the all-or-nothing intent/resolved-entity
 * field set, writing through the REAL `SQLiteActionProposalSink` over a REAL `ActionProposalStore`
 * on a REAL in-memory SQLite DB.
 *
 * Every assertion reads `action_proposal` rows back out of SQLite directly (`SELECT * FROM
 * action_proposal`), never through a mock sink — this exercises the real DDL, the real CHECK
 * constraints, and the real `INSERT OR IGNORE` replay-collapse mechanism (D-07/EMIT-04, shipped
 * by Phase 66-01/66-02).
 *
 * Harness reused from `tests/emission-hold-sentinel.test.ts` (in-memory DB, FakeClock, the
 * content-keyed `MarkerProvider`, the three-distinct-provenance force-destabilize recipe) per
 * that file's documented "each consumer keeps its own copy" convention — `MarkerProvider` is not
 * exported anywhere.
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
import type { ModelProvider } from '../src/model/provider';
import { MockModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { SQLiteConsolidationSink, type ConsolidationSink } from '../src/consolidation/sink';
import { EventStore } from '../src/db/event-store';
import { newId } from '../src/lib/hash';
import type { NodeRow } from '../src/lib/types';
import {
  SQLiteActionProposalSink,
  NoopActionProposalSink,
  PROPOSAL_CONTRACT_VERSION,
  type ActionProposalSink,
} from '../src/consolidation/action-proposal-sink';
import { ActionProposalStore, type ActionProposalRecord } from '../src/db/action-proposal-store';
import { isEmissionEligible } from '../src/consolidation/status-drift';

// ---------------------------------------------------------------------------
// Embed helper — constant vector for every text (cosine 1.0 between any two embedded texts),
// copied from tests/emission-hold-sentinel.test.ts per that file's documented convention.
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

/** Construct a Consolidator wired with a REAL SQLiteConsolidationSink + the given proposal sink
 * (real SQLiteActionProposalSink or NoopActionProposalSink). Mirrors
 * tests/emission-hold-sentinel.test.ts's makeConsolidatorWithRealSink, extended with an explicit
 * proposalSink parameter so both the real-sink and Noop-sink cases share one helper. */
function makeConsolidatorWithProposalSink(
  h: Harness,
  provider: ModelProvider,
  proposalSink: ActionProposalSink,
): Consolidator {
  const sink: ConsolidationSink = new SQLiteConsolidationSink(new EventStore(h.db), h.clock);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink, () => {}, undefined, undefined, undefined, undefined,
    proposalSink,
  );
}

/** Convenience: the real sink, over a real ActionProposalStore on the harness's own DB. */
function makeConsolidatorWithRealProposalSink(h: Harness, provider: ModelProvider): Consolidator {
  const proposalSink: ActionProposalSink = new SQLiteActionProposalSink(
    new ActionProposalStore(h.db, h.clock), h.clock,
  );
  return makeConsolidatorWithProposalSink(h, provider, proposalSink);
}

function seedNode(h: Harness, value: string, opts: { s?: number; c?: number } = {}): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'fact', value, origin: 'observed', s: opts.s, c: opts.c });
  h.store.setEmbedding(id, constVec(h.config.embeddingDimensions));
  return id;
}

/** Seed a resolvable entity node — lets a claim's intent_entity descriptor resolve to a real
 * node id via the exact channel (mirrors tests/consolidation-resolution.test.ts's seedEntity). */
function seedEntity(h: Harness, value: string): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'entity', value, origin: 'observed' });
  h.store.setEmbedding(id, constVec(h.config.embeddingDimensions));
  return id;
}

function getNodeById(h: Harness, id: string): NodeRow {
  const row = h.db.prepare('SELECT * FROM node WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) throw new Error(`getNodeById: node ${id} not found`);
  return row;
}

function findNodeIdByValue(h: Harness, value: string): string | null {
  const row = h.db.prepare('SELECT id FROM node WHERE value = ?').get(value) as { id: string } | undefined;
  return row?.id ?? null;
}

function episodeContentById(h: Harness, episodeId: string): string {
  const row = h.db.prepare('SELECT content FROM episode WHERE id = ?').get(episodeId) as { content: string } | undefined;
  if (!row) throw new Error(`episodeContentById: episode ${episodeId} not found`);
  return row.content;
}

function allProposalRows(h: Harness): ActionProposalRecord[] {
  return h.db.prepare('SELECT * FROM action_proposal').all() as ActionProposalRecord[];
}

function proposalRowsForEntity(h: Harness, entityNodeId: string): ActionProposalRecord[] {
  return h.db
    .prepare('SELECT * FROM action_proposal WHERE entity_node_id = ?')
    .all(entityNodeId) as ActionProposalRecord[];
}

function consolidationEventTypesForCandidate(h: Harness, candidateId: string): string[] {
  return (
    h.db
      .prepare('SELECT event_type FROM consolidation_event WHERE node_id = ? OR candidate_id = ?')
      .all(candidateId, candidateId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

// ---------------------------------------------------------------------------
// MarkerProvider — content-keyed extraction + claim-value-keyed judge resolution (copied from
// tests/emission-hold-sentinel.test.ts per that file's documented duplication convention).
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

function swapProvider(consolidator: Consolidator, provider: ModelProvider): void {
  (consolidator as unknown as { provider: ModelProvider }).provider = provider;
}

// ---------------------------------------------------------------------------
// Shared recipe: mint an anchor belief, then drive N distinct-provenance contradictions.
// Reuses the exact three-distinct-provenance force-destabilize recipe from
// tests/emission-hold-sentinel.test.ts's counterexample (fresh-mint resistance ~0.05, magnitude
// 0.03 keeps each individual ratio under peReconcileBandLow=0.8, so the first two hold and the
// third crosses contractionN=3 and force-destabilizes).
// ---------------------------------------------------------------------------

interface ForceDestabilizeRecipeOpts {
  entity: string | null; // null = do not seed a resolvable entity (resolution abstains)
  gmailSourced: boolean; // false = non-gmail source on every episode (intent fields dropped structurally)
}

async function runForceDestabilizeRecipe(
  h: Harness,
  opts: ForceDestabilizeRecipeOpts,
): Promise<{ consolidator: Consolidator; nodeId: string; thirdEpisodeId: string; entityId: string | null }> {
  const entityId = opts.entity !== null ? seedEntity(h, opts.entity) : null;
  const anchorId = seedNode(h, `anchor placeholder (${opts.entity ?? 'no-entity'}/${opts.gmailSourced})`);
  const BELIEF_VALUE = `${opts.entity ?? 'Unknown Corp'} application status: submitted, awaiting review`;
  const CONTRADICT_VALUE = `${opts.entity ?? 'Unknown Corp'} application status: rejected`;
  const MINT_MARKER = `[EP-MINT-${opts.entity}-${opts.gmailSourced}]`;
  const source = opts.gmailSourced ? 'gmail' : 'obsidian';

  const mintProvider = new MarkerProvider(
    constEmbedFn(h.config.embeddingDimensions),
    [{ marker: MINT_MARKER, claims: [{ type: 'fact', value: BELIEF_VALUE }] }],
    () => ({ relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] }),
  );
  const proposalSink: ActionProposalSink = new SQLiteActionProposalSink(
    new ActionProposalStore(h.db, h.clock), h.clock,
  );
  const consolidator = makeConsolidatorWithProposalSink(h, mintProvider, proposalSink);
  h.episodes.append({
    content: `Update ${MINT_MARKER}: ${BELIEF_VALUE}`,
    origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
    session_id: 'sess-mint', source, event_ts: 1_000_000,
  });
  await consolidator.consolidate();

  const nodeId = findNodeIdByValue(h, BELIEF_VALUE);
  if (!nodeId) throw new Error('recipe: mint failed to produce a node');

  const markers = ['[EP-CTX-A]', '[EP-CTX-B]', '[EP-CTX-C]'];
  let thirdEpisodeId = '';
  for (const [i, marker] of markers.entries()) {
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker, claims: [{
        type: 'fact', value: CONTRADICT_VALUE,
        intent_status: 'rejected', intent_entity: opts.entity ?? 'Unknown Corp', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === BELIEF_VALUE);
        if (!target) throw new Error('recipe fixture: belief node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.03, contradicted_ids: [target.id] };
      },
    ));
    const episode = h.episodes.append({
      content: `Update ${marker}: ${CONTRADICT_VALUE}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: `sess-ctx-${i}`, source, event_ts: 2_000_000 + i * 100_000,
    });
    thirdEpisodeId = episode.id;
    await consolidator.consolidate();
  }

  return { consolidator, nodeId, thirdEpisodeId, entityId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('action-proposal-emission — decisive change writes a proposal through the real sink', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('a decisive force-destabilize with all four intent/resolved-entity fields writes exactly one action_proposal row, byte-identical to the stored episode content', async () => {
    const { nodeId, thirdEpisodeId, entityId } = await runForceDestabilizeRecipe(h, {
      entity: 'Acme Corp', gmailSourced: true,
    });
    expect(entityId).not.toBeNull();

    const rows = proposalRowsForEntity(h, entityId!);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // EMIT-06: evidence_quote is the stored episode.content column, byte-for-byte (strict
    // equality, not a substring/trimmed comparison).
    const storedContent = episodeContentById(h, thirdEpisodeId);
    expect(row.evidence_quote).toBe(storedContent);
    expect(row.evidence_episode).toBe(thirdEpisodeId);

    expect(row.change_to).toBe('rejected');
    expect(row.change_field).toBe('status');
    expect(row.entity_node_id).toBe(entityId);
    expect(row.entity_descriptor).toBe('Acme Corp');
    expect(row.status).toBe('pending');
    expect(row.schema_version).toBe(PROPOSAL_CONTRACT_VERSION);
    expect(row.confidence).toBe('high');

    // The graph mutation also happened: original tombstoned, new value node exists.
    const original = getNodeById(h, nodeId);
    expect(original.tombstoned).toBeTruthy();
    expect(findNodeIdByValue(h, 'Acme Corp application status: rejected')).not.toBeNull();
  });

  it('the resolver abstaining (no seeded entity) writes zero action_proposal rows, but the graph write and consolidation_event still happen', async () => {
    const { nodeId } = await runForceDestabilizeRecipe(h, { entity: null, gmailSourced: true });

    expect(allProposalRows(h)).toEqual([]);
    // Graph write happened: original tombstoned, decisive event recorded.
    const eventTypes = consolidationEventTypesForCandidate(h, nodeId);
    expect(eventTypes).toContain('contradict_force_destabilize');
  });

  it('a non-gmail episode (no intent fields threaded, structurally) writes zero action_proposal rows even with an entity resolvable in principle', async () => {
    const { nodeId, entityId } = await runForceDestabilizeRecipe(h, {
      entity: 'Globex Corp', gmailSourced: false,
    });
    expect(entityId).not.toBeNull();

    expect(proposalRowsForEntity(h, entityId!)).toEqual([]);
    const eventTypes = consolidationEventTypesForCandidate(h, nodeId);
    expect(eventTypes).toContain('contradict_force_destabilize');
  });

  it('a confirm outcome writes zero action_proposal rows even with all four fields present', async () => {
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Initrode Corp');
    const BELIEF_VALUE = 'Initrode Corp application status: submitted, awaiting review';
    const existingId = seedNode(h, BELIEF_VALUE);

    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: BELIEF_VALUE, // exact match -> D-17 fast path, no judge call
        intent_status: 'applied',
        intent_entity: 'Initrode Corp',
        intent_confidence: 'high',
      }])],
      judgeScript: [],
    });
    const consolidator = makeConsolidatorWithRealProposalSink(h, provider);
    h.episodes.append({
      content: BELIEF_VALUE,
      origin: 'observed', salience: 1.0, hard_keep: 1, role: 'user',
      session_id: 'sess-confirm', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    expect(proposalRowsForEntity(h, entityId)).toEqual([]);
    const eventTypes = consolidationEventTypesForCandidate(h, existingId);
    expect(eventTypes).toContain('confirm');
  });

  it('an extend outcome writes zero action_proposal rows even with all four fields present', async () => {
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Umbrella Corp');
    const candidateId = seedNode(h, 'Umbrella Corp application status');

    const verdict: JudgeVerdict = { best_candidate_id: candidateId, relation: 'extend', magnitude: 0.2 };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Umbrella Corp moved application to interviewing',
        intent_status: 'interviewing',
        intent_entity: 'Umbrella Corp',
        intent_confidence: 'high',
      }])],
      judgeScript: [verdict],
    });
    const consolidator = makeConsolidatorWithRealProposalSink(h, provider);
    h.episodes.append({
      content: 'Umbrella Corp moved application to interviewing',
      origin: 'observed', salience: 1.0, hard_keep: 1, role: 'user',
      session_id: 'sess-extend', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    expect(proposalRowsForEntity(h, entityId)).toEqual([]);
    const eventTypes = consolidationEventTypesForCandidate(h, candidateId);
    expect(eventTypes).toContain('extend');
  });

  it('an unrelated (auto-standalone) outcome writes zero action_proposal rows even with all four fields present', async () => {
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Soylent Corp');

    const provider = new MockModelProvider({
      // Zero-vector embed -> no cosine candidate clears the threshold -> auto-unrelated.
      embedFn: (_t: string) => new Float32Array(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Soylent Corp withdrew the offer',
        intent_status: 'rejected',
        intent_entity: 'Soylent Corp',
        intent_confidence: 'medium',
      }])],
      judgeScript: [],
    });
    const consolidator = makeConsolidatorWithRealProposalSink(h, provider);
    h.episodes.append({
      content: 'Soylent Corp withdrew the offer',
      origin: 'observed', salience: 1.0, hard_keep: 1, role: 'user',
      session_id: 'sess-unrelated', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    expect(proposalRowsForEntity(h, entityId)).toEqual([]);
    const mintedId = findNodeIdByValue(h, 'Soylent Corp withdrew the offer');
    expect(mintedId).not.toBeNull();
    const eventTypes = consolidationEventTypesForCandidate(h, mintedId!);
    expect(eventTypes).toContain('unrelated');
  });

  it('an oscillation-escalated outcome writes zero action_proposal rows even with all four fields present', async () => {
    const dims = h.config.embeddingDimensions;
    const embedFn = constEmbedFn(dims);
    const entityId = seedEntity(h, 'Oscillation Corp');
    const anchorId = seedNode(h, 'anchor placeholder (oscillation)');
    const V1 = 'Oscillation Corp application status: submitted';
    const V2 = 'Oscillation Corp application status: rejected';
    const MINT_MARKER = '[EP-OSC-MINT]';
    const RECONCILE_MARKER = '[EP-OSC-RECONCILE]';
    const FLIP_BACK_MARKER = '[EP-OSC-FLIPBACK]';

    // Mint V1.
    const mintProvider = new MarkerProvider(
      embedFn,
      [{ marker: MINT_MARKER, claims: [{ type: 'fact', value: V1 }] }],
      () => ({ relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] }),
    );
    const consolidator = makeConsolidatorWithRealProposalSink(h, mintProvider);
    h.episodes.append({
      content: `Update ${MINT_MARKER}: ${V1}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-osc-mint', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    // First contradiction, non-gmail (no intent fields threaded regardless of claim content) —
    // mid-band ratio (magnitude 0.06 vs fresh resistance ~0.05) routes to reconcile: tombstones
    // V1's node, mints a new node carrying prev_value=V1.
    swapProvider(consolidator, new MarkerProvider(
      embedFn,
      [{ marker: RECONCILE_MARKER, claims: [{ type: 'fact', value: V2 }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === V1);
        if (!target) throw new Error('oscillation fixture: V1 node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.06, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${RECONCILE_MARKER}: ${V2}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-osc-reconcile', source: 'obsidian', event_ts: 2_000_000,
    });
    await consolidator.consolidate();

    const reconciledId = findNodeIdByValue(h, V2);
    if (!reconciledId) throw new Error('oscillation fixture: reconcile did not mint V2');

    // Second contradiction, gmail + full intent fields + resolvable entity: claim value flips
    // BACK to V1 -> isOscillation(V1, reconciledNode.prev_value=V1) is true -> 'contradict_oscillation'.
    swapProvider(consolidator, new MarkerProvider(
      embedFn,
      [{ marker: FLIP_BACK_MARKER, claims: [{
        type: 'fact', value: V1,
        intent_status: 'applied', intent_entity: 'Oscillation Corp', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === V2);
        if (!target) throw new Error('oscillation fixture: V2 node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.06, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${FLIP_BACK_MARKER}: ${V1}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-osc-flipback', source: 'gmail', event_ts: 3_000_000,
    });
    await consolidator.consolidate();

    expect(proposalRowsForEntity(h, entityId)).toEqual([]);
    const eventTypes = consolidationEventTypesForCandidate(h, reconciledId);
    expect(eventTypes).toContain('contradict_oscillation');
  });

  it('same-transaction atomicity: a later statement failing inside the per-episode transaction rolls back both the graph mutation and the action_proposal row', async () => {
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Atomic Corp');
    const anchorId = seedNode(h, 'anchor placeholder (atomicity)');
    const V1 = 'Atomic Corp application status: submitted';
    const V2 = 'Atomic Corp application status: rejected';
    const MINT_MARKER = '[EP-ATOMIC-MINT]';
    const CONTRADICT_MARKER = '[EP-ATOMIC-CONTRADICT]';

    const mintProvider = new MarkerProvider(
      constEmbedFn(dims),
      [{ marker: MINT_MARKER, claims: [{ type: 'fact', value: V1 }] }],
      () => ({ relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] }),
    );
    const consolidator = makeConsolidatorWithRealProposalSink(h, mintProvider);
    h.episodes.append({
      content: `Update ${MINT_MARKER}: ${V1}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-atomic-mint', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    const originalId = findNodeIdByValue(h, V1);
    if (!originalId) throw new Error('atomicity fixture: mint failed');

    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(dims),
      [{ marker: CONTRADICT_MARKER, claims: [{
        type: 'fact', value: V2,
        intent_status: 'rejected', intent_entity: 'Atomic Corp', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === V1);
        if (!target) throw new Error('atomicity fixture: V1 node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.06, contradicted_ids: [target.id] };
      },
    ));
    const contradictEpisode = h.episodes.append({
      content: `Update ${CONTRADICT_MARKER}: ${V2}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-atomic-contradict', source: 'gmail', event_ts: 2_000_000,
    });

    // Poison markConsolidated on the REAL episodes store instance — a later statement inside
    // the SAME per-episode db.transaction that already committed the graph mutation and the
    // action_proposal insert. better-sqlite3 rolls back the whole transaction on a thrown
    // error; the per-episode try/catch in consolidate() then quarantines the episode instead
    // of rethrowing (H-2 poison-episode isolation), so this call must not throw.
    h.episodes.markConsolidated = () => {
      throw new Error('poisoned: simulated failure after graph write + proposal write');
    };

    await consolidator.consolidate();

    // Neither artifact persisted: the original node is still live and unchanged, no V2 node
    // exists, and zero action_proposal rows were written.
    const original = getNodeById(h, originalId);
    expect(original.tombstoned).toBeFalsy();
    expect(original.value).toBe(V1);
    expect(findNodeIdByValue(h, V2)).toBeNull();
    expect(proposalRowsForEntity(h, entityId)).toEqual([]);

    // The episode itself was never marked consolidated (the write that would have set it
    // rolled back along with everything else in the same transaction).
    const episodeRow = h.db.prepare('SELECT consolidated FROM episode WHERE id = ?').get(contradictEpisode.id) as { consolidated: number };
    expect(episodeRow.consolidated).toBe(0);
  });

  it('re-running consolidate() over the same episode (replay) collapses to exactly one action_proposal row (EMIT-04)', async () => {
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Replay Corp');
    // High-resistance candidate (s=0.8, c=0.8 -> resistance=0.64) that append-new never
    // mutates, so re-processing the SAME episode against the SAME live candidate produces the
    // identical decision every time.
    const candidateId = seedNode(h, 'Replay Corp current status on file', { s: 0.8, c: 0.8 });
    const MARKER = '[EP-REPLAY]';

    const provider = new MarkerProvider(
      constEmbedFn(dims),
      [{ marker: MARKER, claims: [{
        type: 'fact', value: 'Replay Corp status changed to interviewing',
        intent_status: 'interviewing', intent_entity: 'Replay Corp', intent_confidence: 'high',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.id === candidateId);
        if (!target) throw new Error('replay fixture: candidate not found among candidates');
        // ratio = 2.0 / 0.64 = 3.125 >= peReconcileBandHigh(2.0), resistance 0.64 >=
        // peAppendNewMinResistance(0.3) -> 'append-new' (candidate untouched, both coexist).
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 2.0, contradicted_ids: [target.id] };
      },
    );
    const consolidator = makeConsolidatorWithRealProposalSink(h, provider);
    const episode = h.episodes.append({
      content: `Update ${MARKER}: Replay Corp status changed to interviewing`,
      origin: 'observed', salience: 1.0, hard_keep: 1, role: 'user',
      session_id: 'sess-replay', source: 'gmail', event_ts: 1_000_000,
    });

    await consolidator.consolidate();
    const rowsAfterFirst = proposalRowsForEntity(h, entityId);
    expect(rowsAfterFirst).toHaveLength(1);
    const firstId = rowsAfterFirst[0]!.id;

    // Simulate replay: reset the episode's consolidated flag so consolidate() reprocesses the
    // IDENTICAL episode against the SAME (untouched) candidate.
    h.db.prepare('UPDATE episode SET consolidated = 0 WHERE id = ?').run(episode.id);
    await consolidator.consolidate();

    const rowsAfterReplay = proposalRowsForEntity(h, entityId);
    expect(rowsAfterReplay).toHaveLength(1);
    expect(rowsAfterReplay[0]!.id).toBe(firstId);
  });

  it('WR-03: a multi-contradicted_ids verdict emits for the primary ONLY — the secondary tombstones with zero action_proposal rows of its own', async () => {
    // The deliberate exclusion recorded at 66-04-PLAN.md:196 and restated in
    // applySecondaryContradiction's doc comment: secondaries emit three event types
    // isEmissionEligible accepts, and none of them is routed through the proposal gate.
    // Before this test the decision existed only as an ABSENT call, so an added gate call
    // would have inverted it silently. Non-vacuousness is proven three ways: the secondary
    // node really is tombstoned, its consolidation_event really is an emission-eligible
    // type, and the primary really did emit — so the zero is a scoped zero, not an
    // everything-was-zero.
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Secondary Corp');
    // resistance = effective_s * c ≈ 0.8 * 0.8 = 0.64 on both, so magnitude 1.0 gives
    // ratio ≈ 1.56 — inside [peReconcileBandLow 0.8, peReconcileBandHigh 2.0) — and BOTH
    // the primary and the secondary route to 'reconcile', the branch that tombstones.
    const primaryId = seedNode(h, 'Secondary Corp application status: submitted', { s: 0.8, c: 0.8 });
    const secondaryId = seedNode(h, 'Secondary Corp recruiter screen scheduled', { s: 0.8, c: 0.8 });
    const MARKER = '[EP-SECONDARY]';
    const CONTRADICT_VALUE = 'Secondary Corp application status: rejected';

    const provider = new MarkerProvider(
      constEmbedFn(dims),
      [{ marker: MARKER, claims: [{
        type: 'fact', value: CONTRADICT_VALUE,
        intent_status: 'rejected', intent_entity: 'Secondary Corp', intent_confidence: 'high',
      }] }],
      () => ({
        relation: 'contradict',
        best_candidate_id: primaryId,
        magnitude: 1.0,
        contradicted_ids: [primaryId, secondaryId],
      }),
    );
    const consolidator = makeConsolidatorWithRealProposalSink(h, provider);
    h.episodes.append({
      content: `Update ${MARKER}: ${CONTRADICT_VALUE}`,
      origin: 'observed', salience: 1.0, hard_keep: 1, role: 'user',
      session_id: 'sess-secondary', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    // The secondary branch genuinely fired and genuinely retired a live belief.
    expect(getNodeById(h, secondaryId).tombstoned).toBeTruthy();
    expect(consolidationEventTypesForCandidate(h, secondaryId)).toContain('contradict_reconcile');
    // And the event type it emitted IS one the proposal seam accepts — so the zero below is
    // the exclusion, not an ineligible-event-type coincidence.
    expect(isEmissionEligible('contradict_reconcile')).toBe(true);

    // Exactly one proposal for the whole claim: the primary's. Never one per contradicted id.
    const rows = allProposalRows(h);
    expect(rows).toHaveLength(1);
    expect(rows).toEqual(proposalRowsForEntity(h, entityId));
    expect(rows[0]!.belief_node_id).not.toBe(secondaryId);
    // The primary reconcile names the newly-minted node, not either retired one.
    expect(rows[0]!.belief_node_id).toBe(findNodeIdByValue(h, CONTRADICT_VALUE));
    expect(getNodeById(h, primaryId).tombstoned).toBeTruthy();
  });

  it('with NoopActionProposalSink injected, a decisive force-destabilize case writes zero action_proposal rows despite the graph mutation happening', async () => {
    const entityId = seedEntity(h, 'Hooli Corp');
    const anchorId = seedNode(h, 'anchor placeholder (noop sink)');
    const BELIEF_VALUE = 'Hooli Corp application status: submitted, awaiting review';
    const CONTRADICT_VALUE = 'Hooli Corp application status: rejected';
    const MINT_MARKER = '[EP-NOOP-MINT]';

    const mintProvider = new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: MINT_MARKER, claims: [{ type: 'fact', value: BELIEF_VALUE }] }],
      () => ({ relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] }),
    );
    // Default Consolidator construction (no proposalSink arg) already defaults to
    // NoopActionProposalSink — but pass it explicitly here so the intent is unambiguous.
    const consolidator = makeConsolidatorWithProposalSink(h, mintProvider, new NoopActionProposalSink());
    h.episodes.append({
      content: `Update ${MINT_MARKER}: ${BELIEF_VALUE}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-noop-mint', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    const nodeId = findNodeIdByValue(h, BELIEF_VALUE);
    if (!nodeId) throw new Error('noop-sink fixture: mint failed');

    const markers = ['[EP-NOOP-A]', '[EP-NOOP-B]', '[EP-NOOP-C]'];
    for (const [i, marker] of markers.entries()) {
      swapProvider(consolidator, new MarkerProvider(
        constEmbedFn(h.config.embeddingDimensions),
        [{ marker, claims: [{
          type: 'fact', value: CONTRADICT_VALUE,
          intent_status: 'rejected', intent_entity: 'Hooli Corp', intent_confidence: 'high',
        }] }],
        (_claim, candidates) => {
          const target = candidates.find((c) => c.value === BELIEF_VALUE);
          if (!target) throw new Error('noop-sink fixture: belief node not found among candidates');
          return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.03, contradicted_ids: [target.id] };
        },
      ));
      h.episodes.append({
        content: `Update ${marker}: ${CONTRADICT_VALUE}`,
        origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
        session_id: `sess-noop-ctx-${i}`, source: 'gmail', event_ts: 2_000_000 + i * 100_000,
      });
      await consolidator.consolidate();
    }

    // Graph mutation happened normally (Noop sink only affects the proposal seam).
    const eventTypes = consolidationEventTypesForCandidate(h, nodeId);
    expect(eventTypes).toContain('contradict_force_destabilize');
    // Zero action_proposal rows anywhere in the table — Noop writes nothing, ever.
    expect(allProposalRows(h)).toEqual([]);
    expect(proposalRowsForEntity(h, entityId)).toEqual([]);
  });
});
