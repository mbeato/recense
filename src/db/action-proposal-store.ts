/**
 * ActionProposalStore — owns every SQL statement touching `action_proposal` (EMIT-01/EMIT-02),
 * with ONE deliberate exception: StrengthDecayManager.runEvictionSweep() (strength/decay.ts)
 * deletes settled (non-pending) proposal rows as part of its FK-safe child-wipe, so a terminal
 * proposal cannot pin an evictable node forever (WR-02, phase 66 review).
 *
 * D-43-for-proposals: this module NEVER writes `node` or `edge`. It holds SELECT-only reads
 * against `node` for the staleness check (getStalenessInputs) and no other node access.
 * T-01-SQL: every statement uses named bound parameters — no string interpolation anywhere.
 * listPending() is read-only by construction — it backs the lock-free `GET /v1/proposals`.
 *
 * Named `action-proposal-store.ts` / class `ActionProposalStore` — deliberately NOT the
 * `proposal-store.ts` that 66-CONTEXT.md floated as a suggestion: `clients/telegram/proposal-store.ts`
 * already exists and Phase 68 edits it. Two files named `proposal-store.ts` in one repo would
 * make every grep, import, and structural scan in this phase and the next ambiguous.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { IntentConfidence } from '../model/claim-extractor';

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

export type ProposalKind = 'belief';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired';
export type StalenessVerdict = 'ok' | 'entity_gone' | 'superseded' | 'expired';

/**
 * Pitfall 13's "practical staleness window even without a superseding event". 14 days is a
 * calibration placeholder, not a law — revisit with real data, not a locked constant.
 */
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Bounds the `GET /v1/proposals` response (T-66-07 denial-of-service mitigation). */
export const PROPOSAL_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Record shape — the frozen EMIT-02 contract (16 fields, D-02/D-02a/D-03)
// ---------------------------------------------------------------------------

export interface ActionProposalRecord {
  id: string;
  kind: ProposalKind;
  entity_node_id: string;
  entity_descriptor: string;
  belief_node_id: string;
  change_field: string;
  change_from: string | null;
  change_to: string;
  evidence_episode: string;
  evidence_quote: string;
  confidence: IntentConfidence;
  schema_version: number;
  status: ProposalStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

/**
 * EMIT-02's compile-time half of the D-03 lock: a key-exhaustive total map over
 * ActionProposalRecord. Adding a field to ActionProposalRecord without adding it here fails
 * `tsc` via the `satisfies` clause below. Do NOT delete this as redundant — it is the
 * mechanism, not decoration.
 */
export const ACTION_PROPOSAL_FIELDS = {
  id: true,
  kind: true,
  entity_node_id: true,
  entity_descriptor: true,
  belief_node_id: true,
  change_field: true,
  change_from: true,
  change_to: true,
  evidence_episode: true,
  evidence_quote: true,
  confidence: true,
  schema_version: true,
  status: true,
  created_at: true,
  updated_at: true,
  expires_at: true,
} satisfies Record<keyof ActionProposalRecord, true>;

// ---------------------------------------------------------------------------
// Pure staleness classifier (D-10, EMIT-07) — no DB, no I/O, no clock read
// ---------------------------------------------------------------------------

export interface StalenessInput {
  expiresAt: number;
  entityTombstoned: boolean;
  beliefTombstoned: boolean;
  nowMs: number;
}

/**
 * classifyProposalStaleness — the D-10 refusal classifier.
 *
 * Precedence is FIXED, not "first match wins" by accident: entity_gone > superseded > expired.
 * A deterministic refusal reason is what makes the 409 `detail` reproducible.
 *  - entity_gone (D-10a): the resolved entity node has been tombstoned — nothing left to apply to.
 *  - superseded  (D-10b): the belief node itself has been tombstoned — the belief moved on via
 *    ordinary reconsolidation before this proposal was approved.
 *  - expired     (D-10c): past its TTL backstop (Pitfall 13), with neither of the above true.
 * Boundary: `expiresAt <= nowMs` is expired (not strictly `<`).
 */
export function classifyProposalStaleness(input: StalenessInput): StalenessVerdict {
  const { expiresAt, entityTombstoned, beliefTombstoned, nowMs } = input;
  if (entityTombstoned) return 'entity_gone';
  if (beliefTombstoned) return 'superseded';
  if (expiresAt <= nowMs) return 'expired';
  return 'ok';
}

// ---------------------------------------------------------------------------
// ActionProposalStore
// ---------------------------------------------------------------------------

export class ActionProposalStore {
  private readonly db: Database.Database;
  private readonly clock: Clock;

  // Prepared statements — compiled once in the constructor (never per-call).
  // T-01-SQL: all filter/write values are bound parameters, never string-interpolated.
  private readonly stmtInsert: Database.Statement;
  private readonly stmtListPending: Database.Statement;
  private readonly stmtGetById: Database.Statement;
  private readonly stmtStalenessInputs: Database.Statement;
  private readonly stmtTransitionFromPending: Database.Statement;

  constructor(db: Database.Database, clock: Clock) {
    this.db = db;
    this.clock = clock;

    // insert(): OR IGNORE is EMIT-04's whole replay mechanism. The PK is a content hash, so a
    // collision means "same change, already recorded" — never data loss.
    this.stmtInsert = db.prepare(`
      INSERT OR IGNORE INTO action_proposal (
        id, kind, entity_node_id, entity_descriptor, belief_node_id,
        change_field, change_from, change_to,
        evidence_episode, evidence_quote, confidence, schema_version,
        status, created_at, updated_at, expires_at
      ) VALUES (
        @id, @kind, @entity_node_id, @entity_descriptor, @belief_node_id,
        @change_field, @change_from, @change_to,
        @evidence_episode, @evidence_quote, @confidence, @schema_version,
        @status, @created_at, @updated_at, @expires_at
      )
    `);

    // WR-03 (phase 66 review): exclude rows past their TTL. Nothing transitions a pending
    // row to 'expired' except an explicit approve attempt on that id (the D-10 refusal
    // path), and ordering is oldest-first — without this filter, >= LIMIT accumulated
    // expired rows would permanently hide every newer proposal from the only list
    // endpoint. The read-filter (not a lazy UPDATE sweep) preserves listPending()'s
    // lock-free read-only property; the DURABLE 'expired' transition still happens only
    // at approve time (D-10). Boundary matches classifyProposalStaleness: expires_at <=
    // now is expired, so only expires_at > now is listed.
    //
    // CR-01 (v10 cross-review): the read filter must be the exact complement of
    // classifyProposalStaleness, which refuses on THREE grounds — entity_gone, superseded,
    // expired. Filtering only the third one re-created the very starvation WR-03 was
    // written to prevent: a tombstoned belief node is the NORMAL outcome of the mechanism
    // that emits proposals (the next contradiction against the same entity tombstones the
    // node the previous proposal named), so those rows stay pending, stay listed, burn the
    // Telegram bridge's per-entity/daily budget, and are guaranteed to 409 on the tap for
    // the full 14-day TTL. Same join as getStalenessInputs below. The INNER JOIN also
    // inherits the fail-closed property for free: a proposal orphaned by a hard-deleted
    // node drops out of the list instead of being surfaced and then refused.
    this.stmtListPending = db.prepare(`
      SELECT p.* FROM action_proposal p
      JOIN node e ON e.id = p.entity_node_id
      JOIN node b ON b.id = p.belief_node_id
      WHERE p.status = 'pending'
        AND p.expires_at > @now
        AND e.tombstoned = 0
        AND b.tombstoned = 0
      ORDER BY p.created_at ASC
      LIMIT @limit
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM action_proposal WHERE id = @id
    `);

    // SELECT ONLY — joins to node twice (entity + belief) reading tombstoned from each.
    // Converts SQLite's 0/1 integers to booleans here so classifyProposalStaleness takes
    // real booleans rather than leaking SQLite's integer-boolean encoding to its callers.
    this.stmtStalenessInputs = db.prepare(`
      SELECT p.expires_at AS expires_at,
             e.tombstoned AS entity_tombstoned,
             b.tombstoned AS belief_tombstoned
      FROM action_proposal p
      JOIN node e ON e.id = p.entity_node_id
      JOIN node b ON b.id = p.belief_node_id
      WHERE p.id = @id
    `);

    // D-43-for-proposals: the only write path here touches action_proposal.status + updated_at.
    // Never node, never edge.
    // CR-01 (phase 66 review): compare-and-set — the `AND status = 'pending'` guard re-checks
    // the precondition atomically inside the UPDATE itself, so a terminal status
    // (approved/rejected/superseded/expired) can never be overwritten by a racing settle.
    this.stmtTransitionFromPending = db.prepare(`
      UPDATE action_proposal SET status = @status, updated_at = @now
      WHERE id = @id AND status = 'pending'
    `);
  }

  insert(row: ActionProposalRecord): void {
    this.stmtInsert.run(row);
  }

  listPending(limit: number = PROPOSAL_LIST_LIMIT): ActionProposalRecord[] {
    // WR-03: expired rows are filtered from the read; their durable status transition
    // still happens only under the write lock at approve time (D-10).
    return this.stmtListPending.all({ limit, now: this.clock.nowMs() }) as ActionProposalRecord[];
  }

  getById(id: string): ActionProposalRecord | null {
    return (this.stmtGetById.get({ id }) as ActionProposalRecord | undefined) ?? null;
  }

  getStalenessInputs(
    id: string
  ): { expiresAt: number; entityTombstoned: boolean; beliefTombstoned: boolean } | null {
    const row = this.stmtStalenessInputs.get({ id }) as
      | { expires_at: number; entity_tombstoned: number; belief_tombstoned: number }
      | undefined;
    if (!row) return null;
    return {
      expiresAt: row.expires_at,
      entityTombstoned: row.entity_tombstoned === 1,
      beliefTombstoned: row.belief_tombstoned === 1,
    };
  }

  /**
   * CAS status transition: pending → `status`. Returns true iff exactly one row changed —
   * i.e. the row existed AND was still 'pending' at write time. A false return means the
   * proposal was already settled (or never existed); the stored terminal status is durable
   * and must never be overwritten (CR-01 double-settle guard; D-10 durable refusal).
   */
  transitionFromPending(id: string, status: ProposalStatus, nowMs: number): boolean {
    return this.stmtTransitionFromPending.run({ id, status, now: nowMs }).changes === 1;
  }
}
