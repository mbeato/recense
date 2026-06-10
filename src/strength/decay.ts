/**
 * StrengthDecayManager — the sole owner of s / c / last_access mutations (spec §2.6).
 *
 * Implements:
 *  - Lazy multiplicative decay: effective_s = s·exp(−λ·Δdays), materialized on read.
 *  - Self-limiting Hebbian strength increment: s ← s + η(1−s).
 *  - Self-limiting confidence increment (D-14): c ← c + β(1−c) — never reaches 1.0 (STR-02).
 *  - Origin guard: inferred claims cannot strengthen a node (T-03-SELFCONF, CLAUDE.md).
 *  - AND-gated eviction sweep: tombstoned ∧ low effective_s ∧ low c (T-03-EVICT).
 *
 * This class prepares its own statements against the node table and does NOT
 * delegate to SemanticStore — it is the single-writer of s/c/last_access (§2.6).
 *
 * No Date.now() calls — all time reads go through the injected Clock (D-12).
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { Origin, NodeRow } from '../lib/types';

/**
 * Minimum age (ms) a tombstoned node must sit at before eviction eligibility.
 * 30 days — gates genuine abandonment vs. recently-superseded nodes still in the graph.
 *
 * Defined here (not config.ts) because config.ts carries an uncommitted local override
 * that must not be changed. This constant is the correct home for the eviction threshold.
 * Replaces the unreachable `evictionCThreshold` predicate (M-1 — c is monotonically
 * non-decreasing so c < 0.15 is structurally dead).
 */
const EVICTION_TOMBSTONE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class StrengthDecayManager {
  private readonly db: Database.Database;
  private readonly clock: Clock;
  private readonly config: EngineConfig;

  // Prepared statements — initialized once, never per-call
  private readonly stmtGetNode: Database.Statement;
  private readonly stmtUpdateDecay: Database.Statement;
  private readonly stmtUpdateIncrement: Database.Statement;
  private readonly stmtGetAllNodes: Database.Statement;
  private readonly stmtDeleteNode: Database.Statement;
  // M-1 FK-safe eviction: delete edges referencing the node BEFORE deleting the node itself.
  private readonly stmtDeleteEdgesForNode: Database.Statement;

  constructor(db: Database.Database, clock: Clock, config: EngineConfig) {
    this.db = db;
    this.clock = clock;
    this.config = config;

    // Read node by id
    this.stmtGetNode = db.prepare('SELECT * FROM node WHERE id = ?');

    // Write back decayed s + updated last_access (materializeDecay)
    this.stmtUpdateDecay = db.prepare(
      'UPDATE node SET s = @s, last_access = @last_access WHERE id = @id'
    );

    // Write back strengthened s + c + updated last_access (strengthen)
    this.stmtUpdateIncrement = db.prepare(
      'UPDATE node SET s = @s, c = @c, last_access = @last_access WHERE id = @id'
    );

    // Full scan for eviction sweep
    this.stmtGetAllNodes = db.prepare('SELECT * FROM node');

    // Delete evicted nodes
    this.stmtDeleteNode = db.prepare('DELETE FROM node WHERE id = ?');
    // FK-safe: remove all edges referencing a node before deleting it (M-1 FK invariant).
    // edge.src and edge.dst both reference node(id); both directions must be cleaned up.
    this.stmtDeleteEdgesForNode = db.prepare('DELETE FROM edge WHERE src = ? OR dst = ?');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Pure function: compute effective strength at a given instant.
   * effective_s = s · exp(−λ · Δdays)  where  Δdays = (nowMs − lastAccessMs) / 86_400_000
   *
   * No DB access. Safe to call at any time without side effects.
   */
  effectiveStrength(
    s: number,
    lastAccessMs: number,
    nowMs: number,
    lambda: number
  ): number {
    // L-8: clamp Δt to ≥ 0 — clock rollback (NTP correction, VM resume, FakeClock rewind)
    // would produce negative deltaDays → exp(+λ·Δdays) → effective_s > s. Clamping to 0
    // treats rollback as "no time passed" (s unchanged) — correct and safe.
    const deltaDays = Math.max(0, nowMs - lastAccessMs) / 86_400_000;
    return s * Math.exp(-lambda * deltaDays);
  }

  /**
   * Materialize lazy decay for a node (STR-01).
   * Reads the stored s and last_access, computes effective_s, and writes it back
   * along with last_access = clock.nowMs().
   *
   * Must be called BEFORE any mutation so there is no double-counting.
   */
  materializeDecay(nodeId: string): void {
    const row = this.stmtGetNode.get(nodeId) as NodeRow | undefined;
    if (!row) return;
    const nowMs = this.clock.nowMs();
    const effective = this.effectiveStrength(row.s, row.last_access, nowMs, this.config.lambda);
    this.stmtUpdateDecay.run({ id: nodeId, s: effective, last_access: nowMs });
  }

  /**
   * Strengthen a node after a confirming claim (STR-01, STR-02, T-03-SELFCONF).
   *
   *  1. Origin guard: if claimOrigin === 'inferred', return immediately — inferred
   *     output must never strengthen a fact (self-confirmation prevention, CLAUDE.md).
   *  2. Materialize decay first (STR-01: no double-count, no unpaired strengthening).
   *  3. Apply self-limiting Hebbian increment: s ← s + η(1−s).
   *  4. Apply self-limiting confidence increment: c ← c + β(1−c) (D-14, STR-02).
   */
  strengthen(nodeId: string, claimOrigin: Origin): void {
    // T-03-SELFCONF: inferred output must never strengthen a fact (CLAUDE.md correctness guard)
    if (claimOrigin === 'inferred') return;

    // STR-01: materialize decay FIRST — no double-count, no unpaired strengthening
    this.materializeDecay(nodeId);

    // Re-read the now-decayed row
    const row = this.stmtGetNode.get(nodeId) as NodeRow | undefined;
    if (!row) return;

    const nowMs = this.clock.nowMs();
    // Self-limiting Hebbian increment: s ← s + η(1−s)
    const newS = row.s + this.config.eta * (1 - row.s);
    // Self-limiting confidence increment (D-14): c ← c + β(1−c) — bounded, never reaches 1
    const newC = row.c + this.config.beta * (1 - row.c);

    this.stmtUpdateIncrement.run({ id: nodeId, s: newS, c: newC, last_access: nowMs });
  }

  /**
   * Eviction sweep (T-03-EVICT, STR-03).
   *
   * Scans all nodes; evicts those where ALL three conditions hold:
   *   tombstoned = 1  AND  effective_s < evictionSThreshold  AND  age > EVICTION_TOMBSTONE_AGE_MS
   *
   * The tombstone-age gate replaces the unreachable `c < evictionCThreshold` predicate (M-1):
   * `c` is monotonically non-decreasing (strengthen() only increments it) so c < 0.15 was
   * structurally dead code. The age gate makes STR-03 reachable for genuinely abandoned tombstones.
   *
   * The AND-gate on tombstoned=1 means tombstoned=0 nodes are structurally protected regardless.
   * No origin=observed/asserted_by_user node with tombstoned=0 can ever be evicted. (T-03-EVICT)
   *
   * Delete order: edges first (FK-safe), then node, in a per-node .immediate() transaction.
   * A failure on one node continues to the next so a single FK constraint never aborts the sweep.
   *
   * Returns the ids of evicted nodes (deleted from DB).
   */
  runEvictionSweep(): string[] {
    const rows = this.stmtGetAllNodes.all() as NodeRow[];
    const nowMs = this.clock.nowMs();
    const evicted: string[] = [];

    for (const row of rows) {
      // Compute the lazy effective strength at current time
      const effectiveS = this.effectiveStrength(row.s, row.last_access, nowMs, this.config.lambda);

      // AND-gated predicate: tombstoned + low effective_s + tombstone age > 30d (T-03-EVICT, M-1)
      if (
        row.tombstoned === 1 &&
        effectiveS < this.config.evictionSThreshold &&
        (nowMs - row.last_access) > EVICTION_TOMBSTONE_AGE_MS
      ) {
        // FK-safe per-node transaction: delete edges before node to satisfy REFERENCES constraint.
        // .immediate() prevents SQLITE_BUSY_SNAPSHOT in WAL mode (M-5 prerequisite for sweep).
        // try/catch: one bad node never aborts the sweep (M-1 robustness invariant).
        try {
          this.db.transaction(() => {
            this.stmtDeleteEdgesForNode.run(row.id, row.id);
            this.stmtDeleteNode.run(row.id);
          }).immediate();
          evicted.push(row.id);
        } catch {
          // Continue — failure on one node must not abort the rest of the sweep.
        }
      }
    }

    return evicted;
  }
}
