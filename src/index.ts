/**
 * brain-memory public API — Walking Skeleton substrate (Phase 1, Plan 01-01).
 *
 * Re-exports the primitives that downstream plans (02/03/04) and Phase 2–5 components
 * write against. Do not add higher-level orchestration here — that belongs in engine.ts.
 */

// ── Clock seam (D-12) ────────────────────────────────────────────────────────
export { type Clock, realClock, FakeClock } from './lib/clock';

// ── Central config (D-13) ────────────────────────────────────────────────────
export { type EngineConfig, type SalienceConfig, DEFAULT_CONFIG } from './lib/config';

// ── Shared types (spec §1) ────────────────────────────────────────────────────
export type {
  Origin,
  NodeType,
  EpisodeRole,
  EdgeKind,
  NodeRow,
  EdgeRow,
  EpisodeRow,
  MetaRow,
  UpsertNodeParams,
} from './lib/types';

// ── Hash utilities ────────────────────────────────────────────────────────────
export { sha256, newId } from './lib/hash';

// ── Schema (STORE-01) ─────────────────────────────────────────────────────────
export { initSchema, SCHEMA_VERSION, DDL } from './db/schema';

// ── Owned write primitive (STORE-01/02) ──────────────────────────────────────
export { SemanticStore } from './db/semantic-store';

// ── Retrieval seam (STORE-03) ─────────────────────────────────────────────────
export { CandidateRetriever, cosineSimF32 } from './retrieval/topk';
