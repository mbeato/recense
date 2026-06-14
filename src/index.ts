/**
 * recense public API — Walking Skeleton substrate (Phase 1, Plan 01-01).
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
  PendingContradiction,
} from './lib/types';

// ── Hash utilities ────────────────────────────────────────────────────────────
export { sha256, newId } from './lib/hash';

// ── Schema (STORE-01) ─────────────────────────────────────────────────────────
export { initSchema, SCHEMA_VERSION, DDL } from './db/schema';

// ── Owned write primitive (STORE-01/02) ──────────────────────────────────────
export { SemanticStore } from './db/semantic-store';

// ── Retrieval seam (STORE-03) ─────────────────────────────────────────────────
export { CandidateRetriever, cosineSimF32 } from './retrieval/topk';

// ── Retrieval engine (Phase 3, RET-01/RET-02) ────────────────────────────────
export type { RetrieveResult, RetrieveStatus } from './retrieval/engine';
export { RetrievalEngine } from './retrieval/engine';

// ── Embedder seam (Phase 2, D-21/D-22) ───────────────────────────────────────
export type { Embedder } from './model/embedder';
export { OpenAIEmbedder, MockEmbedder } from './model/embedder';

// ── Judge seam (Phase 2, D-18/D-15) ──────────────────────────────────────────
export type { Judge, JudgeVerdict, JudgeRelation } from './model/judge';
export { AnthropicJudge, MockJudge } from './model/judge';

// ── Consolidation utilities (Phase 2) ────────────────────────────────────────
export { normalizeValue } from './consolidation/normalize';
export { Consolidator } from './consolidation/consolidator';

// ── PE-gated update routing (Phase 2, Plan 03, spec §4 D-15/D-16/D-19/D-20) ─
export type { UpdateAction } from './consolidation/update-decision';
export {
  routeContradiction,
  isOscillation,
  countDistinctProvenance,
} from './consolidation/update-decision';

// ── ModelProvider seam (Phase 5, SEAM-01, D-46) ──────────────────────────────
export type { ModelProvider } from './model/provider';
export { DefaultModelProvider, MockModelProvider } from './model/provider';

// ── ConsolidationSink seam (Phase 5, SEAM-02, D-48/D-49) ─────────────────────
export type { ConsolidationSink, ConsolidationEventType, ConsolidationEventInput } from './consolidation/sink';
export { SQLiteConsolidationSink, NoopConsolidationSink } from './consolidation/sink';
export { EventStore } from './db/event-store';
export { reconstructCorpus } from './consolidation/sink';
