/**
 * Shared row types and enumerations for the brain-memory engine.
 * Field names mirror spec §1 data model exactly.
 */

/** Origin of a node or episode — immutable and propagating (spec §1). */
export type Origin = 'observed' | 'asserted_by_user' | 'inferred';

/**
 * One provenance-distinct contradiction record stored in node.pending_contradictions.
 * Carries session_id + origin so force-destabilization can count distinct sessions
 * while excluding inferred-origin entries (D-19, mirrors the strengthen() origin-guard).
 */
export interface PendingContradiction {
  episode_id: string;
  session_id: string;
  origin: Origin;
}

/** Semantic node classification (spec §1). */
export type NodeType = 'entity' | 'fact' | 'schema';

/** Role of a conversation episode (D-10). */
export type EpisodeRole = 'user' | 'assistant' | 'tool';

/** Graph edge classification — typed relation or schema-evidence provenance (spec §1). */
export type EdgeKind = 'relation' | 'abstracts';

/**
 * Full SQLite row shape for the node table (spec §1).
 * tombstoned and training_eligible are stored as SQLite INTEGER (0|1).
 */
export interface NodeRow {
  id: string;
  type: NodeType;
  value: string;
  /** SHA-256 of value; drives re-embedding (STORE-02 dirty-flag). */
  value_hash: string;
  /** Float32Array stored as BLOB; null when node is dirty (not yet embedded). */
  embedding: Buffer | null;
  /** Hash the embedding was computed from; null == dirty; != value_hash == stale. */
  embedded_hash: string | null;
  origin: Origin;
  /** Usage-driven strength (Hebbian). */
  s: number;
  /** Evidence-driven confidence (bounded by D-14 self-limiting increment). */
  c: number;
  /** Timestamp (ms) of most recent access — used by lazy decay. */
  last_access: number;
  /** Previous value text; null for first-write nodes (one-deep superseded pointer). */
  prev_value: string | null;
  /** Timestamp (ms) when prev_value was the current value. */
  prev_ts: number | null;
  /** JSON array of PendingContradiction records (was bare episode-id strings in Phase 1). */
  pending_contradictions: string;
  /** SQLite bool: 1 if superseded (decays faster, excluded from eviction guard). */
  tombstoned: number;
  /** Derived: 1 when origin ∈ {observed,asserted_by_user} ∧ ¬tombstoned ∧ c ≥ τ. */
  training_eligible: number;
}

/**
 * Full SQLite row shape for the edge table (spec §1).
 */
export interface EdgeRow {
  src: string;
  dst: string;
  rel: string;
  /** Edge strength — Hebbian + lazy decay, same rules as node.s. */
  w: number;
  last_access: number;
  kind: EdgeKind;
}

/**
 * Full SQLite row shape for the episode table (spec §1 + D-08/09/10).
 */
export interface EpisodeRow {
  id: string;
  /** Timestamp (ms) of the event. */
  ts: number;
  content: string;
  origin: Origin;
  /** Heuristic salience score [0,1] — honest tag, never pinned (D-03). */
  salience: number;
  /** SQLite bool: 1 if force-kept by hard-keep allowlist (D-03). */
  hard_keep: number;
  /** SQLite bool: 1 if the sleep pass has processed this episode. */
  consolidated: number;
  /** Points to injected inference episode to prevent self-confirmation (spec §1). */
  source_inference_id: string | null;
  /** Conversation role (D-10). */
  role: EpisodeRole;
  /** Session identifier for debugging and Phase 3 adapter (D-10). */
  session_id: string;
}

/**
 * Full SQLite row shape for the meta table (key-value store for engine state).
 */
export interface MetaRow {
  key: string;
  value: string;
}

/**
 * Parameters accepted by SemanticStore.upsertNode().
 * The store fills in value_hash, embedded_hash, prev_value, prev_ts, and training_eligible.
 */
export interface UpsertNodeParams {
  id: string;
  type: NodeType;
  value: string;
  origin: Origin;
  /** Initial/updated strength. Preserves existing value if omitted; defaults to 0.1 for new nodes. */
  s?: number;
  /** Initial/updated confidence. Preserves existing value if omitted; defaults to 0.5 for new nodes. */
  c?: number;
  /** Whether this node is tombstoned. Preserves existing value if omitted; defaults to false for new nodes. */
  tombstoned?: boolean;
  /** last_access timestamp (ms). Always updated to clock.nowMs() if omitted. */
  last_access?: number;
  /**
   * Explicit one-deep superseded value. When supplied on a NEW-id upsert, it is written
   * to the new node's prev_value column so a tombstone-and-replace flow (Plan 03 reconcile)
   * can carry flip-back history across the tombstone boundary (D-20).
   * When OMITTED, the existing in-place value-change carry is unchanged —
   * do NOT regress STORE-02 / Phase-1.
   */
  prev_value?: string | null;
}
