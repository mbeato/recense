/**
 * RetrievalEngine — LLM-free online retrieval over the consolidated graph (RET-01/RET-02).
 *
 * Design decisions:
 *  - Read-only on the graph: never writes s/c/last_access/embeddings (spec §8).
 *  - LLM-free: no API calls; all cost lives in the offline sleep pass.
 *  - Clock-injectable: no Date.now() calls — all time reads via this.clock.nowMs() (D-12).
 *  - Dependency-injected: all collaborators passed via constructor; prepared statements
 *    compiled once (never per-call).
 *
 * STUB: This file is a placeholder for the RED phase (TDD Task 1).
 * Full implementation arrives in Task 2 (GREEN phase).
 */
import type Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { CandidateRetriever } from './topk';
import type { SemanticStore } from '../db/semantic-store';
import type { StrengthDecayManager } from '../strength/decay';
import type { AllocationGate } from '../gate/allocation-gate';

export type RetrieveStatus = 'ok' | 'deleted' | 'unreachable';

export interface RetrieveResult {
  results: Array<{ id: string; value: string; score: number }>;
  status: RetrieveStatus;
}

/** STUB — full implementation in Task 2 (GREEN phase). */
export class RetrievalEngine {
  constructor(
    _db: Database.Database,
    _clock: Clock,
    _config: EngineConfig,
    _retriever: CandidateRetriever,
    _store: SemanticStore,
    _strength: StrengthDecayManager,
    _gate: AllocationGate,
  ) {}

  /** STUB: always returns empty results. Tests will fail (RED). */
  retrieveCueless(): RetrieveResult {
    return { results: [], status: 'ok' };
  }

  /** STUB: always returns empty results. Tests will fail (RED). */
  retrieve(_queryVec?: Float32Array): RetrieveResult {
    return { results: [], status: 'ok' };
  }
}
