/**
 * EventStore — owned append primitive for the consolidation_event table (SEAM-02, D-48).
 *
 * Single-writer: the offline sleep pass is the only caller. Mirrors SemanticStore's
 * prepared-statement discipline (T-01-SQL): one INSERT statement compiled in the
 * constructor; the statement is NOT exported so no path can bypass this primitive.
 *
 * append() is synchronous (better-sqlite3) and safe to call inside an existing
 * db.transaction — it does NOT open its own transaction (D-48 in-transaction requirement).
 */
import type Database from 'better-sqlite3';

/**
 * Full row shape for one consolidation_event record.
 * All nullable fields default to null when the branch does not supply them.
 */
export interface EventRow {
  id: string;
  ts: number;
  schema_version: number;
  event_type: string;
  node_id: string | null;
  candidate_id: string | null;
  episode_id: string | null;
  value: string | null;
  origin: string | null;
  magnitude: number | null;
  payload: string | null;
}

export class EventStore {
  // Prepared once in constructor — never per-call (T-01-SQL; mirrors SemanticStore pattern)
  private readonly stmtAppend: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtAppend = db.prepare(`
      INSERT INTO consolidation_event (
        id, ts, schema_version, event_type,
        node_id, candidate_id, episode_id,
        value, origin, magnitude, payload
      ) VALUES (
        @id, @ts, @schema_version, @event_type,
        @node_id, @candidate_id, @episode_id,
        @value, @origin, @magnitude, @payload
      )
    `);
  }

  /**
   * Append one event row. Synchronous — safe inside an existing db.transaction (D-48).
   * Uses bound @named parameters — never string interpolation (T-01-SQL).
   */
  append(row: EventRow): void {
    this.stmtAppend.run(row);
  }
}
