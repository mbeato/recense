/**
 * StatusDrift unit tests — Phase 65, Plan 65-05.
 *
 * This suite is the shipped proof of three phase-level claims:
 *  - DRIFT-01's "machinery unmodified" claim: the module never touches `routeContradiction`
 *    (the gate-to-hold composition block below calls the REAL function).
 *  - DRIFT-02's hold-not-flip claim: a low-confidence claim damps to 0, which the unmodified
 *    `routeContradiction` deterministically routes to 'hold' across multiple resistances.
 *  - DRIFT-04's no-silent-revert claim: a stale backfilled contradiction is DROPPED, not held
 *    (the staleness block below).
 *
 * Constructs StatusDrift directly against an in-memory SQLite DB (Database(':memory:') +
 * initSchema) — no Consolidator, no ModelProvider, no provider stub of any kind. That absence
 * is itself part of the D-04-style zero-LLM evidence: nothing in this harness could call an
 * LLM even by accident because nothing here ever constructs one. `consolidation_event` and
 * `episode` rows are seeded with direct prepared INSERTs — there is no public write primitive
 * for `consolidation_event` outside the sink, and dragging a clock + a transaction into a unit
 * suite through the sink would buy nothing here.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { newId, sha256 } from '../src/lib/hash';
import { routeContradiction } from '../src/consolidation/update-decision';
import type { ConsolidationEventType } from '../src/consolidation/sink';
import {
  StatusDrift,
  dampByConfidence,
  SUPPORTING_EVENT_TYPES,
  EMISSION_ELIGIBLE_EVENT_TYPES,
  isEmissionEligible,
} from '../src/consolidation/status-drift';
import type { IntentConfidence } from '../src/model/claim-extractor';

const STATUS_DRIFT_SOURCE_PATH = resolve(__dirname, '../src/consolidation/status-drift.ts');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  config: EngineConfig;
  drift: StatusDrift;
}

function makeHarness(configOverrides: Partial<EngineConfig> = {}): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:', ...configOverrides };
  const drift = new StatusDrift(db, config);
  return { db, config, drift };
}

let seedCounter = 0;

/** Seed a bare fact node via a direct INSERT (StatusDrift never reads value_hash/s/c). */
function seedNode(h: Harness, value = `node-${seedCounter++}`): string {
  const id = newId();
  h.db
    .prepare(
      `INSERT INTO node (id, type, value, value_hash, origin, last_access)
       VALUES (?, 'fact', ?, ?, 'observed', ?)`,
    )
    .run(id, value, sha256(value), 1_000_000);
  return id;
}

/** Seed an episode row carrying the given source-asserted event_ts (nullable). */
function seedEpisode(h: Harness, eventTs: number | null): string {
  const id = newId();
  h.db
    .prepare(
      `INSERT INTO episode (id, ts, content, origin, salience, role, session_id, source, event_ts)
       VALUES (?, 1000000, 'seed episode', 'observed', 0.5, 'user', ?, 'gmail', ?)`,
    )
    .run(id, `sess-${seedCounter++}`, eventTs);
  return id;
}

/**
 * Seed a consolidation_event row against `nodeId` with the given event type, joined to a
 * freshly-minted episode carrying `eventTs`. Works for ANY ConsolidationEventType, including
 * non-supporting ones (e.g. 'contradict_hold'), so the same helper covers both the
 * supporting-evidence cases and the "hold is not supporting evidence" case.
 */
function seedSupportingEvidence(
  h: Harness,
  nodeId: string,
  eventType: ConsolidationEventType,
  eventTs: number,
): void {
  const episodeId = seedEpisode(h, eventTs);
  h.db
    .prepare(
      `INSERT INTO consolidation_event (id, ts, schema_version, event_type, node_id, episode_id)
       VALUES (?, 1000000, ?, ?, ?, ?)`,
    )
    .run(newId(), SCHEMA_VERSION, eventType, nodeId, episodeId);
}

/**
 * Enumerate every user table dynamically from sqlite_master and record COUNT(*) plus every
 * TEXT/BLOB-shaped column's sorted contents — a whole-database proof, not a single-table one.
 * Mirrors tests/intent-conservation.test.ts's snapshotDb helper (reused per plan instruction),
 * applied here to ALL tables since StatusDrift touches node, episode, and consolidation_event.
 */
function snapshotDb(db: Database.Database): Record<string, { count: number; rows: string }> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const snapshot: Record<string, { count: number; rows: string }> = {};
  for (const { name } of tables) {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    const rows = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
    snapshot[name] = { count, rows };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// dampByConfidence — pure, no DB
// ---------------------------------------------------------------------------

describe('dampByConfidence', () => {
  const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

  it('high confidence (factor 1) passes the magnitude through unchanged', () => {
    expect(dampByConfidence(0.5, 'high', config)).toBe(0.5);
  });

  it('medium confidence (factor 0.6) reduces the magnitude', () => {
    expect(dampByConfidence(0.5, 'medium', config)).toBeCloseTo(0.3, 10);
  });

  it('low confidence (factor 0) zeroes the magnitude', () => {
    expect(dampByConfidence(0.5, 'low', config)).toBe(0);
  });

  it('confidence undefined passes the magnitude through unchanged (not a status claim)', () => {
    expect(dampByConfidence(0.5, undefined, config)).toBe(0.5);
  });

  it.each(['high', 'medium', 'low'] as const)(
    'a configured factor of 5 for %s never produces a magnitude greater than the input',
    (confidence) => {
      const amplifyConfig = {
        ...config,
        statusDriftConfidenceDamping: { high: 5, medium: 5, low: 5 } as Record<IntentConfidence, number>,
      };
      const result = dampByConfidence(0.5, confidence, amplifyConfig);
      expect(result).toBeLessThanOrEqual(0.5);
      if (confidence === 'high') expect(result).toBe(0.5); // identity, not 2.5
    },
  );

  it('a negative configured factor floors to 0, never negative', () => {
    const negConfig = {
      ...config,
      statusDriftConfidenceDamping: { high: 1, medium: 0.6, low: -1 } as Record<IntentConfidence, number>,
    };
    expect(dampByConfidence(0.5, 'low', negConfig)).toBe(0);
  });

  it('a missing key in the damping map fails open to the unchanged magnitude, not NaN', () => {
    const missingKeyConfig = {
      ...config,
      statusDriftConfidenceDamping: { high: 1, medium: 0.6 } as unknown as Record<IntentConfidence, number>,
    };
    expect(dampByConfidence(0.5, 'low', missingKeyConfig)).toBe(0.5);
  });

  it('a NaN configured factor fails open to the unchanged magnitude, not NaN propagation', () => {
    const nanConfig = {
      ...config,
      statusDriftConfidenceDamping: { high: 1, medium: 0.6, low: NaN } as Record<IntentConfidence, number>,
    };
    expect(dampByConfidence(0.5, 'low', nanConfig)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Gate-to-hold composition (DRIFT-02) — the ONLY place in the phase where the D-09 design
// claim ("a low-confidence classification cannot produce a decisive flip on its own") is
// PROVEN against the real routing function rather than merely asserted. REVIEW-BLOCKING:
// the paired 'high' control below is mandatory — without it this block would pass even if
// routeContradiction were (incorrectly) returning 'hold' unconditionally for every input.
// ---------------------------------------------------------------------------

describe('gate-to-hold composition (DRIFT-02)', () => {
  const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
  const resistances = [0.05, 0.81, 0] as const; // fresh-node, strong-node, zero

  it.each(resistances)(
    'low confidence damps to 0 → routeContradiction holds at resistance %f',
    (resistance) => {
      const damped = dampByConfidence(0.9, 'low', config);
      expect(routeContradiction(damped, resistance, config)).toBe('hold');
    },
  );

  it('paired control: high confidence does NOT hold at the fresh-node resistance', () => {
    const damped = dampByConfidence(0.9, 'high', config);
    expect(routeContradiction(damped, 0.05, config)).not.toBe('hold');
  });
});

// ---------------------------------------------------------------------------
// StatusDrift.evaluate — event_ts staleness (DRIFT-04)
// ---------------------------------------------------------------------------

describe('StatusDrift.evaluate — event_ts staleness (DRIFT-04)', () => {
  it('drops a contradicting claim whose event_ts predates the newest supporting evidence', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'contradict_reconcile', 500);
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: 100,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'drop', reason: 'stale-event', priorEventTs: 500, claimEventTs: 100 });
  });

  it('proceeds (ok) when the claim is newer than the most recent supporting evidence', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 100);
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: 500,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.5, damped: false, staleness: 'ok' });
  });

  it('proceeds when the two timestamps are EQUAL (ties favor applying the update)', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 300);
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: 300,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.5, damped: false, staleness: 'ok' });
  });

  it('proceeds with unknown-claim-ts when claimEventTs is null', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 300);
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: null,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.5, damped: false, staleness: 'unknown-claim-ts' });
  });

  it('proceeds with unknown-prior-ts when the node has no dated supporting evidence', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: 100,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.5, damped: false, staleness: 'unknown-prior-ts' });
  });

  it('guard-off (statusDriftEventTsGuard: false) never drops, even for a much older claim', () => {
    const h = makeHarness({ statusDriftEventTsGuard: false });
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 999_999);
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: 1,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.5, damped: false, staleness: 'guard-off' });
  });

  it('contradict_hold is NOT supporting evidence: reports unknown-prior-ts, proceeds despite an older claim', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'contradict_hold', 999_999);
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: 1,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.5, damped: false, staleness: 'unknown-prior-ts' });
  });

  it('MAX semantics: three supporting rows at increasing event_ts use the newest for comparison', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 100);
    seedSupportingEvidence(h, nodeId, 'contradict_reconcile', 300);
    seedSupportingEvidence(h, nodeId, 'extend', 200);
    // Claim is newer than two of the three rows but older than the newest (300) — must still drop.
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'high',
      claimEventTs: 250,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'drop', reason: 'stale-event', priorEventTs: 300, claimEventTs: 250 });
  });

  it('structural no-op: confidence undefined bypasses staleness entirely, even with a far-newer prior', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 999_999_999);
    const result = h.drift.evaluate({
      magnitude: 0.42,
      confidence: undefined,
      claimEventTs: 1,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.42, damped: false, staleness: 'not-applicable' });
  });
});

// ---------------------------------------------------------------------------
// Structural guarantees: master switch, read-only, no-LLM, no-lattice
// ---------------------------------------------------------------------------

describe('structural guarantees', () => {
  it('statusDriftEnabled: false → guard-off proceed with the original magnitude', () => {
    const h = makeHarness({ statusDriftEnabled: false });
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 999_999_999); // would otherwise force a drop
    const result = h.drift.evaluate({
      magnitude: 0.5,
      confidence: 'low',
      claimEventTs: 1,
      candidateNodeId: nodeId,
    });
    expect(result).toEqual({ action: 'proceed', magnitude: 0.5, damped: false, staleness: 'guard-off' });
  });

  it('read-only: a drop-path evaluation leaves the whole database byte-identical', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    seedSupportingEvidence(h, nodeId, 'confirm', 999_999);
    const before = snapshotDb(h.db);
    h.drift.evaluate({ magnitude: 0.5, confidence: 'high', claimEventTs: 1, candidateNodeId: nodeId });
    const after = snapshotDb(h.db);
    expect(after).toEqual(before);
  });

  it('read-only: a proceed-path evaluation leaves the whole database byte-identical', () => {
    const h = makeHarness();
    const nodeId = seedNode(h);
    const before = snapshotDb(h.db);
    h.drift.evaluate({ magnitude: 0.5, confidence: 'medium', claimEventTs: null, candidateNodeId: nodeId });
    const after = snapshotDb(h.db);
    expect(after).toEqual(before);
  });

  it('no-LLM: the constructor signature has no ModelProvider or provider parameter', () => {
    const h = makeHarness();
    expect(h.drift).toBeInstanceOf(StatusDrift);
    const source = readFileSync(STATUS_DRIFT_SOURCE_PATH, 'utf8');
    const match = source.match(/constructor\(([^)]*)\)/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/[Pp]rovider/);
  });

  it('no-lattice: the real module carries zero status-vocabulary literals or IntentStatus references', () => {
    const source = readFileSync(STATUS_DRIFT_SOURCE_PATH, 'utf8');
    expect(findLatticeVocabulary(source)).toEqual([]);
  });

  it('no-lattice guard is not vacuous: a planted offender is caught by the same predicate', () => {
    const planted = "const NEXT: Record<string, string> = { applied: 'interviewing' };";
    expect(findLatticeVocabulary(planted).length).toBeGreaterThan(0);
  });
});

/** Strip block and line comments before matching — the module's own header discusses the banned vocabulary in prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const LATTICE_TOKENS = ["'applied'", "'interviewing'", "'rejected'", "'offer'", 'IntentStatus'];

/** Pure predicate: returns the banned tokens found in comment-stripped `source`, or [] if clean. */
export function findLatticeVocabulary(source: string): string[] {
  const stripped = stripComments(source);
  return LATTICE_TOKENS.filter((token) => stripped.includes(token));
}

// ---------------------------------------------------------------------------
// Emission eligibility (D-13)
// ---------------------------------------------------------------------------

describe('emission eligibility (D-13)', () => {
  // Exhaustive list of all twelve current ConsolidationEventType members. When Phase 66 or a
  // later phase adds a thirteenth event type, this list must grow and the new type's
  // eligibility must be a deliberate decision — it will not be silently swept in.
  const ALL_EVENT_TYPES: readonly ConsolidationEventType[] = [
    'confirm',
    'extend',
    'unrelated',
    'contradict_hold',
    'contradict_reconcile',
    'contradict_oscillation',
    'contradict_append_new',
    'contradict_force_destabilize',
    'schema_emitted',
    'schema_falsified',
    'entity_merge',
    'fact_merge',
  ];

  it('exactly the three research-named event types are emission-eligible (by difference, not by three isolated toBe(true) calls)', () => {
    const eligible = ALL_EVENT_TYPES.filter(isEmissionEligible);
    expect(eligible).toEqual(['contradict_reconcile', 'contradict_append_new', 'contradict_force_destabilize']);
  });

  it('contradict_hold is never emission-eligible', () => {
    expect(isEmissionEligible('contradict_hold')).toBe(false);
    expect(EMISSION_ELIGIBLE_EVENT_TYPES.has('contradict_hold')).toBe(false);
  });

  it('EMISSION_ELIGIBLE_EVENT_TYPES has exactly size 3', () => {
    expect(EMISSION_ELIGIBLE_EVENT_TYPES.size).toBe(3);
  });
});

// Sanity: SUPPORTING_EVENT_TYPES is a strict superset-of-context but excludes contradict_hold
// (asserted directly since the staleness block above only proves it behaviorally).
describe('SUPPORTING_EVENT_TYPES sanity', () => {
  it('excludes contradict_hold and unrelated/schema/merge outcomes', () => {
    expect(SUPPORTING_EVENT_TYPES.has('contradict_hold')).toBe(false);
    expect(SUPPORTING_EVENT_TYPES.has('unrelated')).toBe(false);
    expect(SUPPORTING_EVENT_TYPES.has('schema_emitted')).toBe(false);
    expect(SUPPORTING_EVENT_TYPES.has('schema_falsified')).toBe(false);
    expect(SUPPORTING_EVENT_TYPES.has('entity_merge')).toBe(false);
    expect(SUPPORTING_EVENT_TYPES.has('fact_merge')).toBe(false);
  });
});
