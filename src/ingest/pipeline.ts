/**
 * IngestionPipeline — the write-path vertical slice (INGEST-01 + INGEST-02).
 *
 * Data flow (spec §3 WRITE path):
 *   event → AllocationGate.score() → EpisodicStore.append() (unconditional)
 *
 * Invariants:
 *  - store.append() is called unconditionally on every recordEvent() call
 *    (INGEST-01: "the gate tags, it never gates").
 *  - The gate's honest salience value is persisted unchanged (D-03).
 *  - No code path in recordEvent() skips the append.
 *
 * Re-exports:
 *  EpisodicStore, AllocationGate, and IngestionPipeline are all exported from
 *  this module so downstream consumers can import from one entry point.
 */
import type { EpisodeRow, EpisodeRole, Origin } from '../lib/types';
import { AllocationGate } from '../gate/allocation-gate';
import { EpisodicStore } from '../db/episode-store';

export { AllocationGate } from '../gate/allocation-gate';
export { EpisodicStore } from '../db/episode-store';
export type { AppendEventParams } from '../db/episode-store';

/** Parameters for a single conversation event entering the pipeline. */
export interface RecordEventParams {
  content: string;
  role: EpisodeRole;
  origin: Origin;
  sessionId: string;
  sourceInferenceId?: string;
}

export class IngestionPipeline {
  constructor(
    private readonly gate: AllocationGate,
    private readonly store: EpisodicStore,
  ) {}

  /**
   * Score and unconditionally append a conversation event.
   *
   * 1. Calls gate.score(content, role) → { salience, hardKeep }
   * 2. Calls store.append() with the gate's output — always, no conditional.
   * 3. Returns the stored EpisodeRow (with honest salience persisted, D-03).
   */
  recordEvent(e: RecordEventParams): EpisodeRow {
    const { salience, hardKeep } = this.gate.score(e.content, e.role);
    return this.store.append({
      content: e.content,
      role: e.role,
      origin: e.origin,
      session_id: e.sessionId,
      source_inference_id: e.sourceInferenceId ?? null,
      salience,
      hard_keep: hardKeep ? 1 : 0,
    });
  }
}
