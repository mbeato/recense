/**
 * Frozen-contract lock for `action_proposal` (EMIT-02, EMIT-04, D-10/EMIT-07).
 *
 * Three independent copies of the 16-field set are asserted equal to each other:
 *  (a) FROZEN_PROPOSAL_FIELDS — a literal array in THIS test file, the reviewer-visible
 *      statement of intent.
 *  (b) Object.keys(ACTION_PROPOSAL_FIELDS) — the compile-time `satisfies` lock in
 *      src/db/action-proposal-store.ts.
 *  (c) PRAGMA table_info(action_proposal) — the runtime DDL in src/db/schema.ts.
 * Any two agreeing while the third disagrees is exactly the drift EMIT-02 must not survive
 * (D-03: an exhaustive key check, not a forbidden-vocabulary grep).
 *
 * Also proves, by executing tests rather than asserting in prose:
 *  - EMIT-04's replay collapse (INSERT OR IGNORE on the content-hash PK).
 *  - D-10's fixed staleness precedence (entity_gone > superseded > expired) across all 8
 *    boolean/expiry combinations.
 *  - listPending()'s pending-only / created_at-ascending / limit discipline.
 *  - updateStatus()'s isolation: only status + updated_at change, nothing else.
 *
 * `foreign_keys = ON` is never disabled — real node/episode rows are seeded so the
 * action_proposal FK references resolve honestly.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { newId, sha256 } from '../src/lib/hash';
import {
  ActionProposalStore,
  ACTION_PROPOSAL_FIELDS,
  classifyProposalStaleness,
  PROPOSAL_TTL_MS,
  type ActionProposalRecord,
} from '../src/db/action-proposal-store';

// ---------------------------------------------------------------------------
// (a) The reviewer-visible statement of intent — a literal copy, NOT derived from
// ACTION_PROPOSAL_FIELDS. If this list and the store's `satisfies` map both drifted
// together, that would defeat the whole point of a three-way check.
// ---------------------------------------------------------------------------
const FROZEN_PROPOSAL_FIELDS: readonly string[] = [
  'belief_node_id',
  'change_field',
  'change_from',
  'change_to',
  'confidence',
  'created_at',
  'entity_descriptor',
  'entity_node_id',
  'evidence_episode',
  'evidence_quote',
  'expires_at',
  'id',
  'kind',
  'schema_version',
  'status',
  'updated_at',
].slice().sort();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

/** Seed a minimal, real `node` row directly via SQL (raw insert — no SemanticStore needed
 * for this contract test; foreign_keys = ON stays enabled throughout). */
function seedNode(db: Database.Database, id: string, value: string): void {
  db.prepare(`
    INSERT INTO node (id, type, value, value_hash, origin, last_access)
    VALUES (@id, 'fact', @value, @value_hash, 'observed', @now)
  `).run({ id, value, value_hash: sha256(value), now: Date.now() });
}

/** Seed a minimal, real `episode` row directly via SQL. */
function seedEpisode(db: Database.Database, id: string, content: string): void {
  db.prepare(`
    INSERT INTO episode (id, ts, content, origin, salience, role, session_id)
    VALUES (@id, @ts, @content, 'observed', 0.5, 'user', 'test-session')
  `).run({ id, ts: Date.now(), content });
}

function makeRecord(
  overrides: Partial<ActionProposalRecord> & {
    entity_node_id: string;
    belief_node_id: string;
    evidence_episode: string;
  }
): ActionProposalRecord {
  const now = overrides.created_at ?? Date.now();
  const base: ActionProposalRecord = {
    id: sha256(
      JSON.stringify({
        entity_node_id: overrides.entity_node_id,
        field: 'status',
        from: 'applied',
        to: 'interviewing',
        evidence_episode: overrides.evidence_episode,
      })
    ),
    kind: 'belief',
    entity_node_id: overrides.entity_node_id,
    entity_descriptor: 'Acme Corp — Senior Engineer',
    belief_node_id: overrides.belief_node_id,
    change_field: 'status',
    change_from: 'applied',
    change_to: 'interviewing',
    evidence_episode: overrides.evidence_episode,
    evidence_quote: 'we would like to schedule an interview',
    confidence: 'high',
    schema_version: 17,
    status: 'pending',
    created_at: now,
    updated_at: now,
    expires_at: now + PROPOSAL_TTL_MS,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// (a)/(b)/(c) three-way frozen-field equality
// ---------------------------------------------------------------------------

describe('action_proposal frozen contract (EMIT-02)', () => {
  it('DDL columns, ACTION_PROPOSAL_FIELDS keys, and the literal frozen list all agree', () => {
    const db = makeDb();
    const ddlCols = (db.pragma('table_info(action_proposal)') as Array<{ name: string }>)
      .map(r => r.name)
      .sort();
    const tsKeys = Object.keys(ACTION_PROPOSAL_FIELDS).sort();

    expect(tsKeys).toEqual(FROZEN_PROPOSAL_FIELDS);
    expect(ddlCols).toEqual(FROZEN_PROPOSAL_FIELDS);
    expect(ddlCols).toEqual(tsKeys);
    expect(FROZEN_PROPOSAL_FIELDS.length).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// EMIT-04 replay collapse
// ---------------------------------------------------------------------------

describe('action_proposal replay collapse (EMIT-04)', () => {
  let db: Database.Database;
  let store: ActionProposalStore;
  let clock: FakeClock;
  let entityId: string;
  let beliefId: string;
  let episodeId: string;

  beforeEach(() => {
    db = makeDb();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new ActionProposalStore(db, clock);
    entityId = newId();
    beliefId = newId();
    episodeId = newId();
    seedNode(db, entityId, 'Acme Corp application');
    seedNode(db, beliefId, 'interviewing');
    seedEpisode(db, episodeId, 'we would like to schedule an interview');
  });

  it('inserting the same record twice yields exactly one row', () => {
    const rec = makeRecord({ entity_node_id: entityId, belief_node_id: beliefId, evidence_episode: episodeId });
    store.insert(rec);
    store.insert(rec);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM action_proposal').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('a replayed insert with a different belief_node_id (same id) still collapses to one row, ' +
     'proving belief_node_id is deliberately outside the id hash', () => {
    const beliefId2 = newId();
    seedNode(db, beliefId2, 'offer');

    const first = makeRecord({
      entity_node_id: entityId, belief_node_id: beliefId, evidence_episode: episodeId,
      created_at: 1000, updated_at: 1000,
    });
    const second = makeRecord({
      entity_node_id: entityId, belief_node_id: beliefId2, evidence_episode: episodeId,
      created_at: 2000, updated_at: 2000,
    });
    // Same content hash (id derived only from entity/field/from/to/episode) despite the
    // differing belief_node_id/created_at/updated_at.
    expect(second.id).toBe(first.id);

    store.insert(first);
    store.insert(second);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM action_proposal').get() as { n: number }).n;
    expect(count).toBe(1);

    const survivor = store.getById(first.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.created_at).toBe(1000);
    expect(survivor!.belief_node_id).toBe(beliefId);
  });
});

// ---------------------------------------------------------------------------
// D-10 staleness precedence (EMIT-07) — table-driven, all 8 combinations
// ---------------------------------------------------------------------------

describe('classifyProposalStaleness precedence (D-10, EMIT-07)', () => {
  const t = 1_000_000;

  const cases: Array<{
    entityTombstoned: boolean;
    beliefTombstoned: boolean;
    expired: boolean;
    expected: 'ok' | 'entity_gone' | 'superseded' | 'expired';
  }> = [
    { entityTombstoned: false, beliefTombstoned: false, expired: false, expected: 'ok' },
    { entityTombstoned: false, beliefTombstoned: false, expired: true, expected: 'expired' },
    { entityTombstoned: false, beliefTombstoned: true, expired: false, expected: 'superseded' },
    { entityTombstoned: false, beliefTombstoned: true, expired: true, expected: 'superseded' },
    { entityTombstoned: true, beliefTombstoned: false, expired: false, expected: 'entity_gone' },
    { entityTombstoned: true, beliefTombstoned: false, expired: true, expected: 'entity_gone' },
    { entityTombstoned: true, beliefTombstoned: true, expired: false, expected: 'entity_gone' },
    { entityTombstoned: true, beliefTombstoned: true, expired: true, expected: 'entity_gone' },
  ];

  it.each(cases)(
    'entityTombstoned=$entityTombstoned beliefTombstoned=$beliefTombstoned expired=$expired -> $expected',
    ({ entityTombstoned, beliefTombstoned, expired, expected }) => {
      const expiresAt = expired ? t : t + 1;
      const verdict = classifyProposalStaleness({
        expiresAt,
        entityTombstoned,
        beliefTombstoned,
        nowMs: t,
      });
      expect(verdict).toBe(expected);
    }
  );

  it('boundary: expiresAt === nowMs is expired (not ok)', () => {
    expect(
      classifyProposalStaleness({ expiresAt: t, entityTombstoned: false, beliefTombstoned: false, nowMs: t })
    ).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// listPending() discipline
// ---------------------------------------------------------------------------

describe('ActionProposalStore.listPending', () => {
  it('excludes non-pending rows and orders by created_at ascending', () => {
    const db = makeDb();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new ActionProposalStore(db, clock);

    const entityId = newId();
    seedNode(db, entityId, 'Acme Corp application');

    const rows: ActionProposalRecord[] = [];
    for (let i = 0; i < 3; i++) {
      const beliefId = newId();
      const episodeId = newId();
      seedNode(db, beliefId, `belief-${i}`);
      seedEpisode(db, episodeId, `evidence ${i}`);
      rows.push(
        makeRecord({
          entity_node_id: entityId,
          belief_node_id: beliefId,
          evidence_episode: episodeId,
          change_to: `state-${i}`,
          created_at: 3000 - i * 1000, // insert out of order: 3000, 2000, 1000
          updated_at: 3000 - i * 1000,
        })
      );
    }
    // Also seed one approved row that must be excluded.
    const approvedBelief = newId();
    const approvedEpisode = newId();
    seedNode(db, approvedBelief, 'approved-belief');
    seedEpisode(db, approvedEpisode, 'approved evidence');
    const approvedRow = makeRecord({
      entity_node_id: entityId,
      belief_node_id: approvedBelief,
      evidence_episode: approvedEpisode,
      change_to: 'approved-state',
      status: 'approved',
      created_at: 500,
      updated_at: 500,
    });

    for (const r of rows) store.insert(r);
    store.insert(approvedRow);

    const pending = store.listPending();
    expect(pending.length).toBe(3);
    expect(pending.every(p => p.status === 'pending')).toBe(true);
    expect(pending.map(p => p.created_at)).toEqual([1000, 2000, 3000]);
  });

  it('respects the limit argument', () => {
    const db = makeDb();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new ActionProposalStore(db, clock);
    const entityId = newId();
    seedNode(db, entityId, 'Acme Corp application');

    for (let i = 0; i < 5; i++) {
      const beliefId = newId();
      const episodeId = newId();
      seedNode(db, beliefId, `belief-${i}`);
      seedEpisode(db, episodeId, `evidence ${i}`);
      store.insert(
        makeRecord({
          entity_node_id: entityId,
          belief_node_id: beliefId,
          evidence_episode: episodeId,
          change_to: `state-${i}`,
          created_at: 1000 + i,
          updated_at: 1000 + i,
        })
      );
    }

    expect(store.listPending(2).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// updateStatus() isolation
// ---------------------------------------------------------------------------

describe('ActionProposalStore.updateStatus isolation', () => {
  it('mutates status + updated_at only; every other column is byte-identical', () => {
    const db = makeDb();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new ActionProposalStore(db, clock);

    const entityId = newId();
    const beliefId = newId();
    const episodeId = newId();
    seedNode(db, entityId, 'Acme Corp application');
    seedNode(db, beliefId, 'interviewing');
    seedEpisode(db, episodeId, 'we would like to schedule an interview');

    const rec = makeRecord({
      entity_node_id: entityId, belief_node_id: beliefId, evidence_episode: episodeId,
      created_at: 1000, updated_at: 1000,
    });
    store.insert(rec);

    const before = store.getById(rec.id)!;
    store.updateStatus(rec.id, 'approved', 5000);
    const after = store.getById(rec.id)!;

    expect(after.status).toBe('approved');
    expect(after.updated_at).toBe(5000);

    const { status: _s1, updated_at: _u1, ...beforeRest } = before;
    const { status: _s2, updated_at: _u2, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
  });
});

// ---------------------------------------------------------------------------
// getStalenessInputs() — reads real node.tombstoned via the store, no bespoke SQL in the test
// ---------------------------------------------------------------------------

describe('ActionProposalStore.getStalenessInputs', () => {
  it('reflects live entity/belief tombstoned flags as booleans', () => {
    const db = makeDb();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new ActionProposalStore(db, clock);

    const entityId = newId();
    const beliefId = newId();
    const episodeId = newId();
    seedNode(db, entityId, 'Acme Corp application');
    seedNode(db, beliefId, 'interviewing');
    seedEpisode(db, episodeId, 'we would like to schedule an interview');

    const rec = makeRecord({ entity_node_id: entityId, belief_node_id: beliefId, evidence_episode: episodeId });
    store.insert(rec);

    const fresh = store.getStalenessInputs(rec.id);
    expect(fresh).not.toBeNull();
    expect(fresh!.entityTombstoned).toBe(false);
    expect(fresh!.beliefTombstoned).toBe(false);
    expect(fresh!.expiresAt).toBe(rec.expires_at);

    db.prepare('UPDATE node SET tombstoned = 1 WHERE id = ?').run(beliefId);
    const afterTombstone = store.getStalenessInputs(rec.id);
    expect(afterTombstone!.beliefTombstoned).toBe(true);
    expect(afterTombstone!.entityTombstoned).toBe(false);
  });
});
