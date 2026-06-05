/**
 * ColdStartSeeder — INGEST-03 one-shot cold-start seeding (D-04/05/06/07).
 *
 * Stub: full implementation in GREEN phase.
 *
 * Invariants (all enforced in the full implementation):
 *  - seed() reads per-file memory bodies + CLAUDE.md (D-04), excludes MEMORY.md
 *  - Claims extracted via extractor.extract() (D-05), all async before any DB write (T-04-ASYNC)
 *  - Every seeded node: origin=asserted_by_user, c=0.8, s=0.1, embedded_hash null (D-06)
 *  - [[wikilinks]] targets become relation edges (D-05)
 *  - One-shot: meta 'seeded' flag prevents a second run (D-07)
 *  - All node writes via store.upsertNode (T-04-WRITE — no raw INSERT INTO node)
 *  - Path validation: resolve + realpathSync guards against symlink traversal (T-04-PATH)
 */
import type { SemanticStore } from '../db/semantic-store';
import type { ClaimExtractor } from '../model/claim-extractor';
import type { EngineConfig } from '../lib/config';

export class ColdStartSeeder {
  constructor(
    private readonly store: SemanticStore,
    private readonly extractor: ClaimExtractor,
    private readonly config: EngineConfig,
  ) {}

  async seed(): Promise<void> {
    // Stub — full implementation in GREEN phase
  }
}
