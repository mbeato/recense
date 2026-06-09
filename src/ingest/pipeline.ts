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
  /**
   * Source adapter name (D-57). Defaults to 'claude-code' — zero behavior change on
   * existing call sites. Wave 2/3 adapters supply this so gate.score() applies
   * sourceWeights scoring centrally, keeping per-source salience honest (D-03/D-60).
   */
  source?: string;
  /**
   * Per-source dedup key (D-59). Null / omitted = no dedup (each append is distinct).
   * Adapters set this to a stable message/note identifier so re-ingestion is idempotent.
   */
  externalId?: string | null;
  /**
   * Working directory of the Claude Code session (DEBT-06).
   * Defaults to '' (globally visible). Only Claude Code hook adapters supply this;
   * email/ingest adapters leave it empty so their episodes are always globally visible.
   */
  cwd?: string;
}

export class IngestionPipeline {
  constructor(
    private readonly gate: AllocationGate,
    private readonly store: EpisodicStore,
  ) {}

  /**
   * Score and unconditionally append a conversation event.
   *
   * 1. Resolves source (default 'claude-code') so gate.score() applies per-source
   *    sourceWeights centrally — adapters (Wave 2/3) call recordEvent with source
   *    so scoring stays honest and in one place (D-57/D-60).
   * 2. Calls gate.score(content, role, source) → { salience, hardKeep }
   * 3. Calls store.append() with the gate's output — always, no conditional (INGEST-01).
   * 4. Returns the stored EpisodeRow (honest salience persisted, D-03; dedup-aware, D-59).
   */
  recordEvent(e: RecordEventParams): EpisodeRow {
    // Resolve source so all callers default to 'claude-code' without code changes
    const source = e.source ?? 'claude-code';
    const { salience, hardKeep } = this.gate.score(e.content, e.role, source);
    return this.store.append({
      content: e.content,
      role: e.role,
      origin: e.origin,
      session_id: e.sessionId,
      source_inference_id: e.sourceInferenceId ?? null,
      salience,
      hard_keep: hardKeep ? 1 : 0,
      source,
      external_id: e.externalId ?? null,
      cwd: e.cwd ?? '',
    });
  }
}
