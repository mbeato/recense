/**
 * EpisodicStore — unconditional append-only episodic log (INGEST-01).
 *
 * STUB — will fail INGEST-01 tests (TDD RED phase).
 * Replace methods with real implementation in GREEN.
 */
import type Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { EpisodeRow, EpisodeRole, Origin } from '../lib/types';

/** Parameters accepted by EpisodicStore.append(). */
export interface AppendEventParams {
  content: string;
  origin: Origin;
  /** Heuristic salience [0,1] — computed by AllocationGate (D-03). */
  salience: number;
  /** SQLite bool 0|1 — computed by AllocationGate (D-03). */
  hard_keep: number;
  role: EpisodeRole;
  session_id: string;
  source_inference_id?: string | null;
}

export class EpisodicStore {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly config: EngineConfig,
  ) {}

  /** Unconditional insert — always appends, never drops. Returns the stored row. */
  append(_params: AppendEventParams): EpisodeRow {
    throw new Error('EpisodicStore.append: not implemented');
  }

  /** All episodes not yet consolidated, sorted hard_keep DESC then salience DESC. */
  listUnconsolidated(): EpisodeRow[] {
    return [];
  }

  /** Retrieve a single episode by id; null if not found. */
  getEpisode(_id: string): EpisodeRow | null {
    return null;
  }
}
