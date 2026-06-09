/**
 * ActivationTraceSink — SEAM for spreading-activation trace emission (VIZ-02).
 *
 * Mirrors ConsolidationSink (`src/consolidation/sink.ts`) exactly: same interface →
 * SQLite impl → Noop default → Mock structure. Rename-only from the consolidation domain.
 *
 * Hot-path guard (D-97): session-start-cli is hard-wired to NoopActivationTraceSink and
 * NEVER reads the viz trace flag. The Noop is the default so all existing call sites pay zero.
 *
 * Ring-buffer policy (T-10-01, DoS guard): the activation_trace table is capped at RING_CAP
 * rows. After every INSERT the SQLite impl runs a DELETE that keeps only the RING_CAP highest
 * ids. The table can never grow past 50 rows. Single-writer (the engine's SQLite sink);
 * the viz server reads via a separate readonly handle and NEVER writes.
 *
 * Implementations:
 *   SQLiteActivationTraceSink — production: writes to activation_trace via prepared statements
 *   NoopActivationTraceSink   — default (D-97): inert emit, zero writes, zero external state
 *   MockActivationTraceSink   — test helper: captures emitted traces into a public array
 *
 * Security mitigations:
 *   T-10-01 (DoS — unbounded growth): RING_CAP eviction DELETE after every INSERT (test-asserted).
 *   T-10-02 (SQL injection): prepared statements + bound params only; seeds/hops via JSON.stringify.
 */
import type Database from 'better-sqlite3';
import { newId } from '../lib/hash';
import type { Clock } from '../lib/clock';

// ---------------------------------------------------------------------------
// Ring-buffer cap (T-10-01 — test-asserted)
// ---------------------------------------------------------------------------

/** Maximum rows retained in activation_trace. Eviction runs after every insert. */
export const RING_CAP = 50;

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * What callers supply to emit(). No id/ts minting required from the caller —
 * the SQLite impl mints ts from the injected clock.
 */
export interface ActivationTraceInput {
  /** Caller-minted query identifier (newId()). */
  query_id: string;
  /** Node IDs that seeded the spreading-activation pass. */
  seeds: string[];
  /** 1-hop activated neighbours with scores (JSON-serialised in DB). */
  hops: Array<{ node_id: string; score: number; hop: number }>;
  /** Emission timestamp (ms). Defaults to clock.nowMs() when omitted. */
  ts?: number;
}

// ---------------------------------------------------------------------------
// ActivationTraceSink interface
// ---------------------------------------------------------------------------

/**
 * Narrow seam called synchronously by the engine after each spreading-activation pass.
 * Synchronous only — better-sqlite3 is sync; mirrors ConsolidationSink exactly.
 */
export interface ActivationTraceSink {
  emit(trace: ActivationTraceInput): void;
}

// ---------------------------------------------------------------------------
// SQLiteActivationTraceSink — production implementation
// ---------------------------------------------------------------------------

export class SQLiteActivationTraceSink implements ActivationTraceSink {
  private readonly db: Database.Database;
  private readonly clock: Clock;
  private readonly insert: Database.Statement;
  private readonly evict: Database.Statement;

  constructor(db: Database.Database, clock: Clock) {
    this.db = db;
    this.clock = clock;
    // T-01-SQL: compile prepared statements once in the constructor, never per-call.
    this.insert = db.prepare(
      'INSERT INTO activation_trace (ts, query_id, seeds, hops) VALUES (?, ?, ?, ?)'
    );
    // T-10-02: RING_CAP bound as a parameter, never string-interpolated.
    this.evict = db.prepare(
      'DELETE FROM activation_trace WHERE id NOT IN (SELECT id FROM activation_trace ORDER BY id DESC LIMIT ?)'
    );
  }

  /**
   * Write one row and immediately enforce the ring cap.
   * ts defaults to clock.nowMs() so callers don't need to supply it.
   * seeds and hops are JSON.stringify-serialised (T-10-02: no injection surface).
   */
  emit(trace: ActivationTraceInput): void {
    const ts = trace.ts ?? this.clock.nowMs();
    this.insert.run(ts, trace.query_id, JSON.stringify(trace.seeds), JSON.stringify(trace.hops));
    // Ring eviction — keeps only the RING_CAP highest-id rows (T-10-01).
    this.evict.run(RING_CAP);
  }
}

// ---------------------------------------------------------------------------
// NoopActivationTraceSink — default (D-97 hot-path guard)
// ---------------------------------------------------------------------------

export class NoopActivationTraceSink implements ActivationTraceSink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emit(_trace: ActivationTraceInput): void {
    // Intentional no-op — used as the default when no sink is injected.
  }
}

// ---------------------------------------------------------------------------
// MockActivationTraceSink — test helper
// ---------------------------------------------------------------------------

export class MockActivationTraceSink implements ActivationTraceSink {
  /** All emitted traces in emission order. */
  readonly traces: ActivationTraceInput[] = [];

  emit(trace: ActivationTraceInput): void {
    this.traces.push(trace);
  }

  /** Reset captured traces (useful across test cases). */
  reset(): void {
    this.traces.length = 0;
  }
}
