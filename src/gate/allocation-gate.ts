/**
 * AllocationGate — honest lexical salience + hard-keep flag (INGEST-02).
 *
 * STUB — will fail INGEST-02 tests (TDD RED phase).
 * Replace score() with real implementation in GREEN.
 */
import type { EngineConfig } from '../lib/config';
import type { EpisodeRole } from '../lib/types';

export class AllocationGate {
  constructor(private readonly config: EngineConfig) {}

  /**
   * Score a message for salience [0,1] and hard-keep eligibility.
   * Stub: always returns {salience: 0, hardKeep: false}.
   */
  score(_content: string, _role: EpisodeRole): { salience: number; hardKeep: boolean } {
    return { salience: 0, hardKeep: false };
  }
}
