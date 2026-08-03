/**
 * D-09 inertness guard for RESOLVE-01/02/03's output fields (Phase 64, Plan 04, Task 1).
 *
 * This file is the D-09 inertness guard for RESOLVE's output fields (`claimResolvedEntityId` /
 * `claimResolvedEntityDescriptor`): they are in-memory only this phase, and Phase 65 is the
 * first consumer. A silent loosening of the snapshot comparison below or of the payload scan
 * is a REVIEW-BLOCKING change to this file, not routine maintenance.
 *
 * Modelled on `tests/intent-conservation.test.ts`'s two-pass structure (D-08 for Phase 63's own
 * fields), but the `snapshotDb` helper here is deliberately STRENGTHENED beyond that file's
 * version: it additionally records every table's `payload` column when present, and for
 * `consolidation_event` specifically records the sorted, id-normalized concatenation of every
 * TEXT column. This closes the exact blind spot 63-REVIEW flagged as WR-02 in the original
 * helper (it compared only one privileged column per table and never looked at
 * `consolidation_event.payload` at all, the single most plausible future leak channel) — for
 * Phase 64's new fields specifically. The strengthened helper is a strict superset of the
 * Phase 63 one; nothing that file already checked is weakened here.
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
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { SQLiteConsolidationSink } from '../src/consolidation/sink';
import { EventStore } from '../src/db/event-store';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Harness (mirrors tests/consolidation-resolution.test.ts's makeHarness, extended to accept
// per-test entityResolutionFloor/Margin overrides — the exact dark switches this file exercises).
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
      // consolSkipThresholdBySource.gmail (0.4) wins over the flat threshold above — neutralize
      // it explicitly so no gmail episode is skipped before reaching the resolution branch.
      consolSkipThresholdBySource: { gmail: 0.0 },
    },
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
    echoSimilarityThreshold: 0.85,
    echoRecencyWindowMs: 86_400_000,
    entityResolutionFloor: 0.75,
    entityResolutionMargin: 0.15,
    // Phase 46 D-07 dark knob: disables ONLY the consolidator's own outer BM25 union pass, so a
    // seeded entity node's node_fts presence cannot accidentally escalate routing (fast-path vs
    // auto-unrelated vs judge) differently between the two passes under comparison. Does NOT
    // touch EntityResolver's own independent internal BM25 channel (64-03 precedent).
    bm25CandidateK: 0,
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

/** Construct a Consolidator with a REAL SQLiteConsolidationSink (so consolidation_event rows
 * actually exist for the payload-leak scan below — the default NoopConsolidationSink writes
 * nothing, which would make that scan vacuously pass) and a custom log sink — used to observe
 * the RESOLVE-64 line, the sanity control this file's tests use to prove a "resolving" pass
 * genuinely resolved. */
function makeConsolidatorWithLog(h: Harness, provider: ModelProvider, log: (msg: string) => void): Consolidator {
  const sink = new SQLiteConsolidationSink(new EventStore(h.db), h.clock);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink, log,
  );
}

/** Zero-vector embed: cosine similarity against any node -> 0 -> dense channel contributes
 * nothing to either outer consolidator routing or EntityResolver's dense channel. */
function makeZeroEmbedFn(dims: number): (_text: string) => Float32Array {
  return (_text: string) => new Float32Array(dims);
}

/** Seed an entity node through the real upsert primitive (populates node_fts like production). */
function seedEntity(h: Harness, value: string, vec: Float32Array): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'entity', value, origin: 'observed' });
  h.store.setEmbedding(id, vec);
  return id;
}

function zeroVec(dims: number): Float32Array {
  return new Float32Array(dims);
}

// ---------------------------------------------------------------------------
// Strengthened snapshotDb — a superset of tests/intent-conservation.test.ts's helper.
// ---------------------------------------------------------------------------

/** Columns whose values are random per independently-run pass (newId()) even when the
 * pipeline under test is genuinely inert — normalized to a presence marker below so only
 * "an id is/isn't populated here" is compared, never the random value itself. This is the
 * "identify and normalize, don't weaken to one column" path the plan requires. */
const ID_SHAPED_COLUMNS = new Set(['id', 'node_id', 'candidate_id', 'episode_id']);

interface TableSnapshot {
  count: number;
  values?: string[];
  payloads?: string[];
  consolidationEventRows?: string[];
}

/**
 * Enumerate every user table dynamically from sqlite_master (never a hardcoded list) and record:
 *  - COUNT(*) always;
 *  - the sorted `value` (node/node_fts) or `content` (episode) column when present — inherited
 *    unchanged from the Phase 63 helper;
 *  - NEW: the sorted `payload` column when present, for ANY table — closes 63-REVIEW WR-02's
 *    blind spot generically, not just for consolidation_event, so a future table gains the same
 *    coverage automatically;
 *  - NEW: for `consolidation_event` specifically, the sorted, id-normalized concatenation of
 *    every TEXT column (id/node_id/candidate_id/episode_id normalized to a presence marker,
 *    event_type/value/origin/payload compared verbatim) — this is the strengthened, superset
 *    comparison this file exists to add; a leak into any TEXT column of this table, not just
 *    `payload` alone, would be caught here.
 */
function snapshotDb(db: Database.Database): Record<string, TableSnapshot> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const snapshot: Record<string, TableSnapshot> = {};
  for (const { name } of tables) {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    const colInfos = db.prepare(`PRAGMA table_info("${name}")`).all() as {
      name: string;
      type: string;
    }[];
    const cols = colInfos.map((c) => c.name);

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

    let payloads: string[] | undefined;
    if (cols.includes('payload')) {
      payloads = (
        db.prepare(`SELECT payload FROM "${name}" ORDER BY payload`).all() as {
          payload: string | null;
        }[]
      )
        .map((r) => r.payload ?? '')
        .sort();
    }

    let consolidationEventRows: string[] | undefined;
    if (name === 'consolidation_event') {
      const textCols = colInfos.filter((c) => c.type.toUpperCase() === 'TEXT').map((c) => c.name);
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
      consolidationEventRows = rows
        .map((row) =>
          textCols
            .map((c) => {
              const v = row[c];
              if (ID_SHAPED_COLUMNS.has(c)) {
                // Normalize away the random newId() value — presence/absence is the only
                // deterministic, meaningful signal this column carries (e.g. 'extend' with no
                // candidate leaves candidate_id null; that null-vs-non-null pattern IS
                // meaningful and stays compared, the specific random id is not).
                return v == null ? '<NULL>' : '<ID>';
              }
              return v == null ? '<NULL>' : String(v);
            })
            .join('|'),
        )
        .sort();
    }

    snapshot[name] = {
      count,
      ...(values !== undefined ? { values } : {}),
      ...(payloads !== undefined ? { payloads } : {}),
      ...(consolidationEventRows !== undefined ? { consolidationEventRows } : {}),
    };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('D-09 resolution inertness — two-pass whole-DB snapshot equality', () => {
  it('resolution ON (resolves via the exact channel) vs OFF via the entityResolutionFloor dark switch — identical persisted state', async () => {
    const gmailContent = 'Acme Corp rejected the application';
    const dims = DEFAULT_CONFIG.embeddingDimensions;

    // Pass A: shipped defaults — resolution genuinely resolves against a seeded entity.
    const hA = makeHarness({ entityResolutionFloor: 0.75, entityResolutionMargin: 0.15 });
    seedEntity(hA, 'Acme Corp', zeroVec(dims));
    const providerA = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [
        JSON.stringify([
          {
            type: 'fact',
            value: gmailContent,
            intent_status: 'rejected',
            intent_entity: 'Acme Corp',
            intent_confidence: 'high',
          },
        ]),
      ],
      judgeScript: [],
    });
    const logLinesA: string[] = [];
    const consolidatorA = makeConsolidatorWithLog(hA, providerA, (m) => logLinesA.push(m));
    hA.episodes.append({
      content: gmailContent,
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-floor',
      source: 'gmail',
    });
    await consolidatorA.consolidate();

    // Sanity control (required by the plan's acceptance criteria): the resolving pass genuinely
    // resolved at least once. Without this, the equality below could pass vacuously because
    // resolution never fired in either pass — the exact failure mode this control prevents.
    const resolveLineA = logLinesA.find((l) => l.startsWith('RESOLVE-64'));
    expect(resolveLineA).toBeDefined();
    expect(resolveLineA).toContain('hits=1');
    expect(resolveLineA).toContain('abstains=0');

    // Pass B: identical seed entity, identical episode content, identical FakeClock instant —
    // the ONLY difference is entityResolutionFloor: 2, the documented unreachable dark-off
    // switch (scores are clamped to [0, 1], so no candidate can ever clear a floor of 2).
    const hB = makeHarness({ entityResolutionFloor: 2, entityResolutionMargin: 0.15 });
    seedEntity(hB, 'Acme Corp', zeroVec(dims));
    const providerB = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [
        JSON.stringify([
          {
            type: 'fact',
            value: gmailContent,
            intent_status: 'rejected',
            intent_entity: 'Acme Corp',
            intent_confidence: 'high',
          },
        ]),
      ],
      judgeScript: [],
    });
    const logLinesB: string[] = [];
    const consolidatorB = makeConsolidatorWithLog(hB, providerB, (m) => logLinesB.push(m));
    hB.episodes.append({
      content: gmailContent,
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-floor',
      source: 'gmail',
    });
    await consolidatorB.consolidate();

    const resolveLineB = logLinesB.find((l) => l.startsWith('RESOLVE-64'));
    expect(resolveLineB).toBeDefined();
    expect(resolveLineB).toContain('hits=0');
    expect(resolveLineB).toContain('abstains=1');

    // The load-bearing assertion: resolution firing (or not) leaves the persisted database
    // byte-for-byte (modulo the documented random-id normalization) identical either way.
    expect(snapshotDb(hA.db)).toEqual(snapshotDb(hB.db));
  });

  it('resolution ON (resolves cleanly) vs OFF via the entityResolutionMargin dark switch (not the floor) — identical persisted state', async () => {
    const gmailContent = 'Acme Corp rejected the application';
    const dims = DEFAULT_CONFIG.embeddingDimensions;

    // Both passes seed the SAME two near-duplicate entities so the persisted graph is identical
    // in both arms — only the margin config differs, exactly mirroring how the previous test
    // varies the floor. 'Acme Corp' (exact match, lex=1.0) and 'Acme Corporation' (bm25-only
    // match on the shared 'acme' token, lex=0.5 via the Dice coefficient) give a top-2 score
    // gap of 0.5 — comfortably clears a margin of 0.15 (pass A) but not a margin of 0.6 (pass B).
    const buildGraph = (h: Harness): void => {
      seedEntity(h, 'Acme Corp', zeroVec(dims));
      seedEntity(h, 'Acme Corporation', zeroVec(dims));
    };
    const buildProvider = (dims_: number): MockModelProvider =>
      new MockModelProvider({
        embedFn: makeZeroEmbedFn(dims_),
        generateScript: [
          JSON.stringify([
            {
              type: 'fact',
              value: gmailContent,
              intent_status: 'rejected',
              intent_entity: 'Acme Corp',
              intent_confidence: 'high',
            },
          ]),
        ],
        judgeScript: [],
      });

    // Pass A: margin=0.15 — the 0.5 gap clears it, resolution succeeds.
    const hA = makeHarness({ entityResolutionFloor: 0.75, entityResolutionMargin: 0.15 });
    buildGraph(hA);
    const logLinesA: string[] = [];
    const consolidatorA = makeConsolidatorWithLog(hA, buildProvider(dims), (m) => logLinesA.push(m));
    hA.episodes.append({
      content: gmailContent,
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-margin',
      source: 'gmail',
    });
    await consolidatorA.consolidate();

    const resolveLineA = logLinesA.find((l) => l.startsWith('RESOLVE-64'));
    expect(resolveLineA).toBeDefined();
    expect(resolveLineA).toContain('hits=1');
    expect(resolveLineA).toContain('abstains=0');

    // Pass B: identical graph and episode, floor unchanged — only margin raised to 0.6, which
    // the actual 0.5 gap cannot clear ('margin-too-close' abstain, NOT a floor abstain).
    const hB = makeHarness({ entityResolutionFloor: 0.75, entityResolutionMargin: 0.6 });
    buildGraph(hB);
    const logLinesB: string[] = [];
    const consolidatorB = makeConsolidatorWithLog(hB, buildProvider(dims), (m) => logLinesB.push(m));
    hB.episodes.append({
      content: gmailContent,
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-margin',
      source: 'gmail',
    });
    await consolidatorB.consolidate();

    const resolveLineB = logLinesB.find((l) => l.startsWith('RESOLVE-64'));
    expect(resolveLineB).toBeDefined();
    expect(resolveLineB).toContain('hits=0');
    expect(resolveLineB).toContain('abstains=1');

    expect(snapshotDb(hA.db)).toEqual(snapshotDb(hB.db));
  });
});

describe('D-09 schema and payload negative assertions', () => {
  it('no table in the live schema has a column whose name contains "resolved" or "claimresolved" (case-insensitive)', async () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp', zeroVec(h.config.embeddingDimensions));
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([
          {
            type: 'fact',
            value: 'Acme Corp rejected the application',
            intent_status: 'rejected',
            intent_entity: 'Acme Corp',
            intent_confidence: 'high',
          },
        ]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidatorWithLog(h, provider, () => {});
    h.episodes.append({
      content: 'Acme Corp rejected the application',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-columns',
      source: 'gmail',
    });
    await consolidator.consolidate();

    // Enumerate tables from sqlite_master at runtime — never a hard-coded table list, so a
    // future migration is automatically covered.
    const tables = h.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    for (const { name } of tables) {
      const cols = (h.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
        (c) => c.name.toLowerCase(),
      );
      for (const col of cols) {
        expect(col).not.toContain('resolved');
        expect(col).not.toContain('claimresolved');
      }
    }
  });

  it('sqlite_master SQL text contains no reference to the resolved-entity field names or the module name (covers indexes and views too)', async () => {
    const h = makeHarness();
    seedEntity(h, 'Acme Corp', zeroVec(h.config.embeddingDimensions));
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([
          {
            type: 'fact',
            value: 'Acme Corp rejected the application',
            intent_status: 'rejected',
            intent_entity: 'Acme Corp',
            intent_confidence: 'high',
          },
        ]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidatorWithLog(h, provider, () => {});
    h.episodes.append({
      content: 'Acme Corp rejected the application',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-sql',
      source: 'gmail',
    });
    await consolidator.consolidate();

    const rows = h.db.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL`).all() as {
      sql: string;
    }[];
    const allSql = rows
      .map((r) => r.sql)
      .join('\n')
      .toLowerCase();
    expect(allSql).not.toContain('claimresolvedentityid');
    expect(allSql).not.toContain('claimresolvedentitydescriptor');
    expect(allSql).not.toContain('entity_resolution');
  });

  it('after a resolving pass, no consolidation_event.payload value contains "resolved", "claimResolved", or the resolved node id', async () => {
    const h = makeHarness();
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Acme Corp', zeroVec(dims));
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [
        JSON.stringify([
          {
            type: 'fact',
            value: 'Acme Corp rejected the application',
            intent_status: 'rejected',
            intent_entity: 'Acme Corp',
            intent_confidence: 'high',
          },
        ]),
      ],
      judgeScript: [],
    });
    const logLines: string[] = [];
    const consolidator = makeConsolidatorWithLog(h, provider, (m) => logLines.push(m));
    h.episodes.append({
      content: 'Acme Corp rejected the application',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-payload',
      source: 'gmail',
    });
    await consolidator.consolidate();

    // Sanity control: this pass genuinely resolved (against `entityId`) before scanning payload.
    const resolveLine = logLines.find((l) => l.startsWith('RESOLVE-64'));
    expect(resolveLine).toBeDefined();
    expect(resolveLine).toContain('hits=1');

    const rows = h.db
      .prepare(`SELECT payload FROM consolidation_event WHERE payload IS NOT NULL`)
      .all() as { payload: string }[];
    for (const row of rows) {
      const lower = row.payload.toLowerCase();
      expect(lower).not.toContain('resolved');
      expect(lower).not.toContain('claimresolved');
      expect(row.payload).not.toContain(entityId);
    }
  });
});
