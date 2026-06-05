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
    // STUB — intentionally wrong so TDD RED tests fail
    return -1;
  }

  /**
   * Materialize lazy decay for a node (STR-01).
   * Reads the stored s and last_access, computes effective_s, and writes it back
   * along with last_access = clock.nowMs().
   *
   * Must be called BEFORE any mutation so there is no double-counting.
   */
  materializeDecay(nodeId: string): void {
    // STUB — no-op
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
    // STUB — no-op
  }

  /**
   * Eviction sweep (T-03-EVICT, STR-03).
   * Scans all nodes; evicts those where:
   *   tombstoned = 1  AND  effective_s < evictionSThreshold  AND  c < evictionCThreshold
   *
   * The AND-gate means tombstoned=0 nodes are structurally protected regardless of s/c.
   * Returns the ids of evicted nodes (deleted from DB).
   */
  runEvictionSweep(): string[] {
    // STUB — no-op
    return [];
  }
}
