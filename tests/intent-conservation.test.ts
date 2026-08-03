/**
 * Cross-stage vocabulary parity + zero-database-delta inertness conservation (Phase 63-05).
 *
 * Phase 63 is a multi-stage pipeline (prompt -> model output -> JSON schema -> parser ->
 * ClaimDecision). Plans 01/02/04 each unit-test one stage in isolation; every one of those
 * tests keeps passing while the stages silently disagree with each other. This file locks
 * the two cross-stage properties per-stage tests structurally cannot catch:
 *
 *  1. The four-state vocabulary is IDENTICAL at every hop -- prompt text, JSON schema enum,
 *     parser coercer, and the in-memory ClaimDecision type (D-04, D-07).
 *  2. Classification is genuinely inert: a full consolidation pass carrying classification
 *     leaves a database indistinguishable from one without it (D-08).
 *
 * Every parity assertion below is driven off the exported INTENT_STATUSES / INTENT_CONFIDENCES
 * constants -- never a literal array retyped in this file. A test that hardcoded the four
 * status strings as a literal array would keep passing while the code vocabulary drifted from
 * the prompt; only asserting against the SAME constant both sides read makes the test meaningful.
 *
 * Phase 64 companion (D-09): `tests/resolution-conservation.test.ts` runs the same inertness
 * discipline for the resolved-entity fields (`claimResolvedEntityId` / `claimResolvedEntityDescriptor`)
 * that Phase 64 threads onto `ClaimDecision` alongside `claimIntentStatus` / `claimIntentEntity` /
 * `claimIntentConfidence`. Its `snapshotDb` is a strengthened superset of this file's helper --
 * it additionally records every table's `payload` column when present and, for
 * `consolidation_event` specifically, an id-normalized concatenation of every TEXT column --
 * closing the blind spot 63-REVIEW flagged as WR-02 (this file's original helper compared only
 * one privileged column per table and never inspected `consolidation_event.payload`).
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import {
  INTENT_STATUSES,
  INTENT_CONFIDENCES,
  CLAIM_ARRAY_SCHEMA,
  toIntentStatus,
  toIntentConfidence,
} from '../src/model/claim-extractor';
import { promptForSource } from '../src/source/extraction-prompts';
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

const ENV_KEY = 'RECENSE_ENABLE_EPISODIC_EMAIL';

/** Run `fn` with RECENSE_ENABLE_EPISODIC_EMAIL set to `value` (undefined = unset), then restore. */
function withEpisodicEmailEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
}

// ---------------------------------------------------------------------------
// Task 1: vocabulary parity across prompt / schema / parser (CLASSIFY-01/04, D-04, D-07)
// ---------------------------------------------------------------------------

describe('vocabulary parity across the classification pipeline', () => {
  describe('prompt covers the schema', () => {
    const envCases: Array<[string, string | undefined]> = [
      ['env unset', undefined],
      ['env=on', 'on'],
    ];

    for (const [label, envValue] of envCases) {
      it(`every INTENT_STATUSES member appears verbatim in promptForSource('gmail') (${label})`, () => {
        withEpisodicEmailEnv(envValue, () => {
          const prompt = promptForSource('gmail');
          for (const status of INTENT_STATUSES) {
            expect(prompt).toContain(status);
          }
        });
      });

      it(`every INTENT_CONFIDENCES member appears verbatim in promptForSource('gmail') (${label})`, () => {
        withEpisodicEmailEnv(envValue, () => {
          const prompt = promptForSource('gmail');
          for (const confidence of INTENT_CONFIDENCES) {
            expect(prompt).toContain(confidence);
          }
        });
      });
    }
  });

  describe('schema equals the constant', () => {
    it('CLAIM_ARRAY_SCHEMA.items.properties.intent_status.enum sorted deep-equals INTENT_STATUSES sorted', () => {
      const schema = CLAIM_ARRAY_SCHEMA as unknown as {
        items: { properties: { intent_status: { enum: string[] } } };
      };
      expect([...schema.items.properties.intent_status.enum].sort()).toEqual(
        [...INTENT_STATUSES].sort(),
      );
    });

    it('CLAIM_ARRAY_SCHEMA.items.properties.intent_confidence.enum sorted deep-equals INTENT_CONFIDENCES sorted', () => {
      const schema = CLAIM_ARRAY_SCHEMA as unknown as {
        items: { properties: { intent_confidence: { enum: string[] } } };
      };
      expect([...schema.items.properties.intent_confidence.enum].sort()).toEqual(
        [...INTENT_CONFIDENCES].sort(),
      );
    });
  });

  describe('parser accepts exactly the constant', () => {
    it('every INTENT_STATUSES member round-trips through toIntentStatus unchanged', () => {
      for (const status of INTENT_STATUSES) {
        expect(toIntentStatus(status)).toBe(status);
      }
    });

    it('every INTENT_CONFIDENCES member round-trips through toIntentConfidence unchanged', () => {
      for (const confidence of INTENT_CONFIDENCES) {
        expect(toIntentConfidence(confidence)).toBe(confidence);
      }
    });

    it('near-miss values (wrong case, trailing space, plural, out-of-vocabulary) all return undefined', () => {
      // Deliberately NOT built from INTENT_STATUSES members with a suffix appended in a loop --
      // these are hand-picked adversarial shapes a real model could plausibly emit.
      const statusNearMisses = [
        'Applied', // wrong case
        'applied ', // trailing space
        'interviewings', // plural
        'other', // toActionType's fallback value -- must NOT leak into intent parsing
        'unknown',
        'pending',
      ];
      for (const nearMiss of statusNearMisses) {
        expect(toIntentStatus(nearMiss)).toBeUndefined();
      }

      const confidenceNearMisses = ['High', 'medium ', 'highest', 'other', 'unknown'];
      for (const nearMiss of confidenceNearMisses) {
        expect(toIntentConfidence(nearMiss)).toBeUndefined();
      }
    });
  });

  it('vocabulary is closed at four statuses / three confidence levels (CLASSIFY-04 tripwire)', () => {
    // This is the tripwire that forces a future vocabulary expansion to be a deliberate,
    // reviewed change to INTENT_STATUSES / INTENT_CONFIDENCES rather than a silent one.
    expect(INTENT_STATUSES.size).toBe(4);
    expect(INTENT_CONFIDENCES.size).toBe(3);
  });

  it("non-vacuousness: a synthetic out-of-vocabulary status ('ghosted') is absent from promptForSource('gmail')", () => {
    // Proves the "prompt contains every member" assertions above are discriminating -- not
    // trivially satisfied by a prompt that happens to contain lots of words.
    const prompt = promptForSource('gmail');
    expect(prompt).not.toContain('ghosted');
  });
});

// ---------------------------------------------------------------------------
// Task 2: classification is inert -- zero database delta (D-08)
// ---------------------------------------------------------------------------

/**
 * NOTE for Phase 66: when `action_proposal` lands, this test suite MUST be updated
 * deliberately -- the delta becomes expected and bounded to that one new table. A silent
 * loosening of this assertion (excluding a table from the snapshot, widening "no intent
 * column anywhere" to "no intent column outside action_proposal", etc.) is a review-blocking
 * change to this file, not routine maintenance (T-63-05-C).
 *
 * REVIEW-BLOCKING (Phase 64 extension): the same discipline covers `claimResolvedEntityId` /
 * `claimResolvedEntityDescriptor` in `tests/resolution-conservation.test.ts`, the companion
 * guard for those two fields. A silent loosening of ITS snapshot comparison or its
 * `consolidation_event.payload` leak scan is likewise review-blocking -- do not treat a change
 * to that file as routine maintenance either.
 */
describe('classification is inert — zero database delta (D-08)', () => {
  interface Harness {
    db: Database.Database;
    clock: FakeClock;
    episodes: EpisodicStore;
    store: SemanticStore;
    strength: StrengthDecayManager;
    retriever: CandidateRetriever;
    config: EngineConfig;
  }

  /** Zero-vector embed: cosine similarity against any node -> 0 -> auto-unrelated path, no judge call. */
  function makeZeroEmbedFn(dims: number): (_text: string) => Float32Array {
    return (_text: string) => new Float32Array(dims);
  }

  function makeHarness(): Harness {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const config: EngineConfig = {
      ...DEFAULT_CONFIG,
      dbPath: ':memory:',
      consolSkipThreshold: 0.0,
      consolSkipThresholdAssistant: 0.0,
      unrelatedSimilarityThreshold: 0.3,
      candidateK: 5,
    };
    const store = new SemanticStore(db, clock, config);
    const episodes = new EpisodicStore(db, clock, config);
    const strength = new StrengthDecayManager(db, clock, config);
    const retriever = new CandidateRetriever(db);
    return { db, clock, episodes, store, strength, retriever, config };
  }

  /** No-op SchemaInducer: prevents LLM calls during Phase C (mirrors consolidation-intent.test.ts). */
  function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
    return new SchemaInducer(
      h.db, h.store, h.strength, h.retriever,
      new MockModelProvider(),
      h.config, h.clock,
      async (_values: string[]) => 'no-op-schema',
    );
  }

  function makeConsolidator(h: Harness, provider: ModelProvider): Consolidator {
    return new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );
  }

  /**
   * Enumerate every user table dynamically from sqlite_master (never a hardcoded list, so a
   * future migration is automatically covered) and record COUNT(*) plus, where a stable
   * identifying column exists (`value` for node / node_fts, `content` for episode), the sorted
   * list of that column's contents. Tables with neither column (FTS5 shadow tables, edge, meta,
   * consolidation_event, etc.) fall back to count-only -- their auxiliary columns (e.g. node ids
   * from newId(), which are random per run by design) are EXPECTED to differ between two
   * independently-run passes even when the pipeline under test is genuinely inert.
   */
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

  it('a consolidation pass WITH classification produces a byte-identical database to one WITHOUT it', async () => {
    const gmailContent = 'Acme Corp rejected the application';

    // Run A: scripted extraction carries the three intent fields on the claim.
    const hA = makeHarness();
    const providerA = new MockModelProvider({
      embedFn: makeZeroEmbedFn(hA.config.embeddingDimensions),
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
    const consolidatorA = makeConsolidator(hA, providerA);
    hA.episodes.append({
      content: gmailContent,
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation',
      source: 'gmail',
    });
    await consolidatorA.consolidate();

    // Run B: identical seed and episode content, but the scripted extraction carries NO
    // intent fields at all -- the only difference between run A and run B.
    const hB = makeHarness();
    const providerB = new MockModelProvider({
      embedFn: makeZeroEmbedFn(hB.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([
          {
            type: 'fact',
            value: gmailContent,
          },
        ]),
      ],
      judgeScript: [],
    });
    const consolidatorB = makeConsolidator(hB, providerB);
    hB.episodes.append({
      content: gmailContent,
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation',
      source: 'gmail',
    });
    await consolidatorB.consolidate();

    expect(snapshotDb(hA.db)).toEqual(snapshotDb(hB.db));
  });

  it('no table anywhere has a column whose name contains "intent"', async () => {
    const h = makeHarness();
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
    const consolidator = makeConsolidator(h, provider);
    h.episodes.append({
      content: 'Acme Corp rejected the application',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-conservation-columns',
      source: 'gmail',
    });
    await consolidator.consolidate();

    const tables = h.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    for (const { name } of tables) {
      const cols = (h.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
        (c) => c.name.toLowerCase(),
      );
      for (const col of cols) {
        expect(col).not.toContain('intent');
      }
    }
  });

  it('sqlite_master SQL text contains no "intent" substring (covers indexes and views too)', async () => {
    const h = makeHarness();
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
    const consolidator = makeConsolidator(h, provider);
    h.episodes.append({
      content: 'Acme Corp rejected the application',
      origin: 'observed',
      salience: 0.9,
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
    expect(allSql).not.toContain('intent');
  });
});
