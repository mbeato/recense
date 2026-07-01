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
  /**
   * Seeds that initiated the spreading-activation pass. Back-compat union (D-07):
   *   - bare string id — legacy / ingestion-kind producers (cascade, remember bridge)
   *   - {node_id, score} — recall path emitters that carry a per-seed retrieval score
   * Both shapes are JSON-serialised to the `seeds` TEXT column (shape-agnostic serialisation).
   */
  seeds: Array<string | { node_id: string; score: number | null }>;
  /**
   * 1-hop activated neighbours (JSON-serialised in DB). `score` is `null` when the
   * emitter has only rank order and no measured activation/similarity magnitude
   * (WR-02: never present a fabricated number as a real activation value).
   *
   * `src` (optional): the id of the seed this hop is a REAL out-edge of (Phase 55
   * SC1 edge lines). Present on the ambient retrieveRanked path so the viz can draw
   * an honest source-seed→hop pathway; absent on curated/cueless/ingestion producers
   * (the viz falls back to lighting the hop node with no connecting line). NEVER a
   * guessed seeds[0] — only the actual seed whose getOutEdgesWithRel yielded this dst.
   */
  hops: Array<{ node_id: string; src?: string; score: number | null; hop: number }>;
  /** Emission timestamp (ms). Defaults to clock.nowMs() when omitted. */
  ts?: number;
  /**
   * Row-level kind discriminator (D-09). Nullable — `null` / omitted means back-compat recall.
   *   recall rows:     kind='recall' | null (treated identically — NULL is the back-compat shape)
   *   ingestion rows:  kind='new_node' | 'reconsolidation' | 'oscillation' | consolidation-neutral
   * Written as a bound param — never string-interpolated (T-52-01, extends T-10-02).
   */
  kind?: string | null;
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
    // T-52-01: kind is a bound param — never string-interpolated (extends T-10-02).
    this.insert = db.prepare(
      'INSERT INTO activation_trace (ts, query_id, seeds, hops, kind) VALUES (?, ?, ?, ?, ?)'
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
    // seeds/hops JSON-serialised (T-10-02: shape-agnostic, no injection surface).
    // kind is a bound param written as NULL when omitted (T-52-01).
    this.insert.run(
      ts,
      trace.query_id,
      JSON.stringify(trace.seeds),
      JSON.stringify(trace.hops),
      trace.kind ?? null,
    );
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
// SwitchableActivationTraceSink — runtime-togglable wrapper (WR-04)
// ---------------------------------------------------------------------------

/**
 * A sink whose backing implementation flips between SQLite and Noop at runtime
 * based on the `viz_trace_enabled` meta flag, so a long-running process (the
 * launchd watcher) starts/stops tracing when `recense viz` toggles the flag —
 * WITHOUT a restart. Engines hold a stable reference to this wrapper; the owner
 * calls refresh() (cheap indexed meta read) once per poll tick to re-evaluate.
 *
 * Default is Noop until the first refresh() confirms the flag is '1' (fail-closed).
 */
export class SwitchableActivationTraceSink implements ActivationTraceSink {
  private readonly db: Database.Database;
  private readonly clock: Clock;
  private delegate: ActivationTraceSink;
  private readonly flagStmt: Database.Statement;

  constructor(db: Database.Database, clock: Clock) {
    this.db = db;
    this.clock = clock;
    this.flagStmt = db.prepare("SELECT value FROM meta WHERE key = 'viz_trace_enabled'");
    this.delegate = new NoopActivationTraceSink();
    this.refresh();
  }

  /**
   * Re-read viz_trace_enabled and swap the backing sink on transition only
   * (no churn while the flag is steady). Returns the active enabled state.
   */
  refresh(): boolean {
    const row = this.flagStmt.get() as { value: string } | undefined;
    const enabled = row?.value === '1';
    const isSqlite = this.delegate instanceof SQLiteActivationTraceSink;
    if (enabled && !isSqlite) {
      this.delegate = new SQLiteActivationTraceSink(this.db, this.clock);
    } else if (!enabled && isSqlite) {
      this.delegate = new NoopActivationTraceSink();
    }
    return enabled;
  }

  emit(trace: ActivationTraceInput): void {
    this.delegate.emit(trace);
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
