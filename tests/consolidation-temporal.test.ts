/**
 * Tests for TEMP-02 consolidator temporal write path (CONSOL-03).
 *
 * Verifies:
 *  - Claims carrying due_at/action_type produce a node_temporal row after consolidation
 *  - Claims without due_at produce NO node_temporal row (backward-compat regression guard)
 *  - For gcal-source episodes, source_event_id and recurrence_rule are parsed from the
 *    provenance header by deterministic string parse (never an LLM call)
 *  - A temporal claim confirmed into an existing node also upserts node_temporal (keeps
 *    recurring due_at current, e.g. next-occurrence refresh on re-ingest)
 *
 * Uses MockModelProvider (scripted claims, no API) + in-memory SQLite.
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
import { MockEmbedder } from '../src/model/embedder';
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Embed helpers (mirrors consolidation.test.ts)
// ---------------------------------------------------------------------------

/** Hash-seeded synthetic embed: same text → same vector; different texts → distinct vectors. */
function makeSyntheticEmbedFn(dims: number): (text: string) => Float32Array {
  return (text: string) => {
    const vec = new Float32Array(dims);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
    }
    vec[hash % dims] = 1.0;
    return vec;
  };
}

/** Zero-vector embed: cosine similarity against any non-zero node → 0 → auto-unrelated. */
function makeZeroEmbedFn(dims: number): (_text: string) => Float32Array {
  return (_text: string) => new Float32Array(dims);
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

function makeHarness(): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    consolSkipThreshold: 0.2,
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

/** No-op SchemaInducer: prevents LLM calls during Phase C (mirrors consolidation.test.ts). */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Construct a Consolidator with default sink/log/deriver (clock is passed explicitly). */
function makeConsolidator(h: Harness, provider: ModelProvider): Consolidator {
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Consolidator temporal writes — TEMP-02, CONSOL-03', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── 1. Temporal claim via auto-unrelated path ────────────────────────────

  it('temporal claim (unrelated path) writes node_temporal row with due_at and action_type', async () => {
    // Empty DB: no candidates → auto-unrelated, no judge call needed.
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{
          type: 'fact',
          value: 'Flight AA123 to NYC departs 2026-07-04',
          due_at: '2026-07-04T08:00:00Z',
          action_type: 'flight',
        }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content: 'Flight AA123 to NYC departs 2026-07-04',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-temporal-1',
      source: 'gmail',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT id FROM node').all() as { id: string }[];
    expect(nodes).toHaveLength(1);
    const nodeId = nodes[0]!.id;

    const temporal = h.store.getNodeTemporal(nodeId);
    expect(temporal).not.toBeNull();
    expect(temporal!.due_at).toBe('2026-07-04T08:00:00Z');
    expect(temporal!.action_type).toBe('flight');
    expect(temporal!.recurrence_rule).toBeNull();
    expect(temporal!.source_event_id).toBeNull();
  });

  // ── 2. Non-temporal claim: no node_temporal row (regression guard) ───────

  it('non-temporal claim (no due_at) writes NO node_temporal row — regression guard', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{
          type: 'fact',
          value: 'Max uses TypeScript for all new projects',
        }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content: 'Max always uses TypeScript',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-no-temporal',
    });

    await consolidator.consolidate();

    // Node should have been created (consolidation still runs)
    const nodes = h.db.prepare('SELECT id FROM node').all();
    expect(nodes.length).toBeGreaterThanOrEqual(1);

    // No node_temporal row — backward-compat guarantee (CONSOL-03 sole writer)
    const temporalCount = (
      h.db.prepare('SELECT COUNT(*) AS n FROM node_temporal').get() as { n: number }
    ).n;
    expect(temporalCount).toBe(0);
  });

  // ── 3. gcal episode: Event token → source_event_id ──────────────────────

  it('gcal episode with · Event: token → source_event_id parsed deterministically', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{
          type: 'fact',
          value: 'Weekly standup with engineering team',
          due_at: '2026-07-07T14:00:00Z',
          action_type: 'meeting',
        }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      // Provenance header with Event token (no RRULE — one-off)
      content: 'Cal: Weekly standup · Acct: default · Event: evt-123\nStandup discussion.',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-gcal-event',
      source: 'gcal',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT id FROM node').all() as { id: string }[];
    expect(nodes).toHaveLength(1);

    const temporal = h.store.getNodeTemporal(nodes[0]!.id);
    expect(temporal).not.toBeNull();
    expect(temporal!.source_event_id).toBe('evt-123');
    // One-off event — no RRULE token → recurrence_rule must be null (D-04)
    expect(temporal!.recurrence_rule).toBeNull();
  });

  // ── 4. gcal episode: RRULE token → recurrence_rule ──────────────────────

  it('gcal episode with · RRULE: token → recurrence_rule stored verbatim (D-04)', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{
          type: 'fact',
          value: 'Weekly Monday standup with engineering team',
          due_at: '2026-07-07T14:00:00Z',
          action_type: 'meeting',
        }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content:
        'Cal: Weekly standup · Acct: default · Event: evt-456 · RRULE: FREQ=WEEKLY;BYDAY=MO\nRecurring Monday meeting.',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-gcal-rrule',
      source: 'gcal',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT id FROM node').all() as { id: string }[];
    expect(nodes).toHaveLength(1);

    const temporal = h.store.getNodeTemporal(nodes[0]!.id);
    expect(temporal).not.toBeNull();
    expect(temporal!.source_event_id).toBe('evt-456');
    expect(temporal!.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  // ── 5. gcal one-off (no RRULE token) → recurrence_rule is null ──────────

  it('gcal one-off episode (no · RRULE: token) → recurrence_rule is null', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{
          type: 'fact',
          value: 'One-off sync with Jane Doe on 2026-07-10',
          due_at: '2026-07-10T10:00:00Z',
          action_type: 'appointment',
        }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      // Only Event token — no RRULE (one-off event)
      content: 'Cal: 1:1 with Jane · Acct: default · Event: evt-789\nOne-off sync.',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-gcal-oneoff',
      source: 'gcal',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT id FROM node').all() as { id: string }[];
    expect(nodes).toHaveLength(1);

    const temporal = h.store.getNodeTemporal(nodes[0]!.id);
    expect(temporal).not.toBeNull();
    expect(temporal!.source_event_id).toBe('evt-789');
    // One-off → null (not a recurring master)
    expect(temporal!.recurrence_rule).toBeNull();
  });

  // ── 6. Email temporal claim → recurrence_rule is null ───────────────────

  it('email temporal claim (source=gmail) → recurrence_rule is null (non-gcal)', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{
          type: 'fact',
          value: 'Invoice from Acme Corp due 2026-06-30',
          due_at: '2026-06-30T23:59:00Z',
          action_type: 'deadline',
        }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content: 'From: billing@acme.com · Re: Invoice #1234\nYour invoice is due June 30.',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-email-temporal',
      source: 'gmail',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT id FROM node').all() as { id: string }[];
    expect(nodes).toHaveLength(1);

    const temporal = h.store.getNodeTemporal(nodes[0]!.id);
    expect(temporal).not.toBeNull();
    expect(temporal!.due_at).toBe('2026-06-30T23:59:00Z');
    expect(temporal!.action_type).toBe('deadline');
    // Email source → never gcal provenance → both null
    expect(temporal!.source_event_id).toBeNull();
    expect(temporal!.recurrence_rule).toBeNull();
  });

  // ── 7. Temporal claim via confirm path → upserts node_temporal on existing node ──

  it('temporal claim confirmed into existing node upserts node_temporal for that node', async () => {
    // Pre-seed an existing node so the D-17 fast path fires (exact-match confirm).
    const existingNodeId = newId();
    const existingValue = 'Weekly meeting with the engineering team';
    h.store.upsertNode({ id: existingNodeId, type: 'fact', value: existingValue, origin: 'observed' });

    // Pre-embed the node using the same synthetic function used by the provider.
    const embedFn = makeSyntheticEmbedFn(h.config.embeddingDimensions);
    const embedder = new MockEmbedder(embedFn);
    const [nodeVec] = await embedder.embed([existingValue]);
    h.store.setEmbedding(existingNodeId, nodeVec!);

    // Provider returns the same value → D-17 exact-match confirm (no judge call).
    const provider = new MockModelProvider({
      embedFn,
      generateScript: [
        JSON.stringify([{
          type: 'fact',
          value: existingValue,
          due_at: '2026-07-07T09:00:00Z',
          action_type: 'meeting',
        }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content: 'Weekly engineering standup',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-confirm',
    });

    await consolidator.consolidate();

    // Still just the one node (no new node minted on confirm)
    const nodeCount = (
      h.db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }
    ).n;
    expect(nodeCount).toBe(1);

    // node_temporal upserted for the EXISTING node — keeps recurring due_at current
    const temporal = h.store.getNodeTemporal(existingNodeId);
    expect(temporal).not.toBeNull();
    expect(temporal!.due_at).toBe('2026-07-07T09:00:00Z');
    expect(temporal!.action_type).toBe('meeting');
    expect(temporal!.source_event_id).toBeNull();
    expect(temporal!.recurrence_rule).toBeNull();
  });
});
