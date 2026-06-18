/**
 * ConsolidationSink — SEAM-02 interface + impls (D-48/D-49, ROADMAP SC2).
 *
 * Every applyDecision branch + schema emitted/falsified emits exactly one event via
 * the ConsolidationSink. The SQLiteConsolidationSink persists it to consolidation_event
 * INSIDE the same per-episode db.transaction as the graph mutation it describes (D-48) —
 * event and graph mutation commit atomically, preventing crash-induced corpus drift.
 *
 * Each event is stamped with:
 *   - id       = newId() (UUID v4) — stable record id (D-49)
 *   - ts       = injected clock.nowMs() (D-12)
 *   - schema_version = SCHEMA_VERSION — corpus consumers can version-gate (D-49)
 *
 * Implementations:
 *   SQLiteConsolidationSink — production: writes to consolidation_event via EventStore
 *   NoopConsolidationSink   — default in Consolidator; no writes, no external state
 *   MockConsolidationSink   — test helper: captures events to a public array
 *
 * reconstructCorpus() provides the ROADMAP SC2 replay demo: SELECT from
 * consolidation_event LEFT JOIN node, tagged with training_eligible so a downstream
 * consumer can filter the training corpus to eligible nodes.
 *
 * Threat mitigations:
 *   T-05-SINK-TX:    emit() must be called INSIDE an existing per-episode db.transaction
 *                    (enforced by Consolidator/SchemaInducer callers; this file cannot
 *                    enforce the call-site, but the grep gate in the verify step checks it).
 *   T-05-SINK-WRITE: this plan writes ONLY to recense.db copies; production activation is
 *                    gated behind Plan 05-05.
 *   T-05-SINK-KEY:   log emits event counts/types only; no keys or node PII beyond the
 *                    existing sleep pass.
 */
import type Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../db/schema';
import { newId } from '../lib/hash';
import type { Clock } from '../lib/clock';
import type { EventStore } from '../db/event-store';

// ---------------------------------------------------------------------------
// Event type enum (one per applyDecision branch + schema emitted/falsified, D-49)
// ---------------------------------------------------------------------------

/**
 * Ten distinct outcome types — mirrors the applyDecision branches 1:1 (D-49):
 *   confirm, extend, unrelated                    — the three top-level branches
 *   contradict_hold                               — HOLD / recordContradiction path
 *   contradict_reconcile                          — mid-band tombstone-and-replace
 *   contradict_oscillation                        — flip-back escalated to append-new
 *   contradict_append_new                         — extreme/categorical divergence
 *   contradict_force_destabilize                  — N-distinct force-destabilize
 *   schema_emitted                                — new schema node created
 *   schema_falsified                              — schema tombstoned by erosion/contradiction
 */
export type ConsolidationEventType =
  | 'confirm'
  | 'extend'
  | 'unrelated'
  | 'contradict_hold'
  | 'contradict_reconcile'
  | 'contradict_oscillation'
  | 'contradict_append_new'
  | 'contradict_force_destabilize'
  | 'schema_emitted'
  | 'schema_falsified'
  | 'entity_merge';  // Phase 25 addition — entity dedup pass (D-10)

// ---------------------------------------------------------------------------
// Input shape (what callers supply — id/ts/schema_version are minted internally)
// ---------------------------------------------------------------------------

export interface ConsolidationEventInput {
  event_type: ConsolidationEventType;
  node_id?: string | null;
  candidate_id?: string | null;
  episode_id?: string | null;
  value?: string | null;
  origin?: string | null;
  magnitude?: number | null;
  payload?: string | null;
}

// ---------------------------------------------------------------------------
// ConsolidationSink interface
// ---------------------------------------------------------------------------

/**
 * Narrow seam called synchronously inside per-episode db.transaction (D-48).
 * No async/await — better-sqlite3 is synchronous; an await between the graph
 * mutation and its emit would break the atomicity guarantee.
 */
export interface ConsolidationSink {
  emit(event: ConsolidationEventInput): void;
}

// ---------------------------------------------------------------------------
// SQLiteConsolidationSink — production implementation
// ---------------------------------------------------------------------------

export class SQLiteConsolidationSink implements ConsolidationSink {
  private readonly eventStore: EventStore;
  private readonly clock: Clock;

  constructor(eventStore: EventStore, clock: Clock) {
    this.eventStore = eventStore;
    this.clock = clock;
  }

  /**
   * Mint id=newId(), ts=clock.nowMs(), schema_version=SCHEMA_VERSION, then delegate
   * to EventStore.append. Synchronous — safe inside an existing db.transaction (D-48).
   */
  emit(event: ConsolidationEventInput): void {
    this.eventStore.append({
      id: newId(),
      ts: this.clock.nowMs(),
      schema_version: SCHEMA_VERSION,
      event_type: event.event_type,
      node_id: event.node_id ?? null,
      candidate_id: event.candidate_id ?? null,
      episode_id: event.episode_id ?? null,
      value: event.value ?? null,
      origin: event.origin ?? null,
      magnitude: event.magnitude ?? null,
      payload: event.payload ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// NoopConsolidationSink — default (no writes, no external state)
// ---------------------------------------------------------------------------

export class NoopConsolidationSink implements ConsolidationSink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emit(_event: ConsolidationEventInput): void {
    // Intentional no-op — used as the default when no sink is injected.
  }
}

// ---------------------------------------------------------------------------
// MockConsolidationSink — test helper
// ---------------------------------------------------------------------------

export class MockConsolidationSink implements ConsolidationSink {
  /** All emitted events in emission order. */
  readonly events: ConsolidationEventInput[] = [];

  emit(event: ConsolidationEventInput): void {
    this.events.push(event);
  }

  /** Reset captured events (useful across test cases). */
  reset(): void {
    this.events.length = 0;
  }
}

// ---------------------------------------------------------------------------
// reconstructCorpus — ROADMAP SC2 replay demonstration
// ---------------------------------------------------------------------------

/**
 * Replay the consolidation_event table joined against the node table.
 * Returns all event records tagged with the matched node's training_eligible flag
 * (null when node_id is null or the node no longer exists).
 *
 * This is the SEAM-02 corpus reconstruction demonstration — no trainer or model
 * consumes this beyond assembling the records (Level-3 training deferred to v3).
 *
 * The training_eligible column from the node table acts as the corpus filter:
 * downstream consumers can filter to records where training_eligible = 1.
 */
export function reconstructCorpus(db: Database.Database): Array<{
  id: string;
  event_type: string;
  value: string | null;
  origin: string | null;
  schema_version: number;
  training_eligible: number | null;
}> {
  return db
    .prepare(
      `SELECT
         ce.id,
         ce.event_type,
         ce.value,
         ce.origin,
         ce.schema_version,
         n.training_eligible
       FROM consolidation_event ce
       LEFT JOIN node n ON ce.node_id = n.id
       ORDER BY ce.ts ASC`
    )
    .all() as Array<{
    id: string;
    event_type: string;
    value: string | null;
    origin: string | null;
    schema_version: number;
    training_eligible: number | null;
  }>;
}
