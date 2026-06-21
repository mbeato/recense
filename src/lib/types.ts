/**
 * Shared row types and enumerations for the recense engine.
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

/**
 * Semantic node classification (spec §1).
 * Phase 38 (REFLECT-01 D-01): 'insight' added for derived higher-order nodes synthesized by
 * InsightReflector. Insight nodes are origin='inferred', confidence-capped, non-strengthening,
 * decaying — they are NOT doc nodes (different lifecycle: recall artifact vs. reader prose).
 */
export type NodeType = 'entity' | 'fact' | 'schema' | 'doc' | 'insight';

/** Role of a conversation episode (D-10). */
export type EpisodeRole = 'user' | 'assistant' | 'tool';

/**
 * Graph edge classification — typed relation or schema-evidence provenance (spec §1).
 * Phase 38 (REFLECT-01 D-02): 'derived_from' added for edges connecting an insight node to its
 * anchor schema + cited member fact/entity nodes. Single kind serves both recall discovery
 * (getInEdges(schemaId) filtered to kind='derived_from') and invalidation walks
 * (getInEdges(memberId) filtered to kind='derived_from' → dependent insights).
 */
export type EdgeKind = 'relation' | 'abstracts' | 'schema_rel' | 'cites' | 'doc_link' | 'doc_containment' | 'doc_reference' | 'derived_from';

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
  /** Edge strength — Hebbian increment only; NO lazy decay is implemented for edges (unlike node.s). */
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
  /** Channel that produced this episode — D-57 (where-from; defaults to 'claude-code'). */
  source: string;
  /** Per-source dedup key — D-59 (NULL for legacy claude-code episodes; each NULL is distinct). */
  external_id: string | null;
  /** Working directory of the Claude Code session that produced this episode (DEBT-06). Empty '' for global/email episodes. */
  cwd: string;
}

/**
 * Full SQLite row shape for the meta table (key-value store for engine state).
 */
export interface MetaRow {
  key: string;
  value: string;
}

/**
 * Parameters for SemanticStore.upsertNodeTemporal().
 * Written exclusively by the sleep-pass consolidator (CONSOL-03, single writer).
 * action_type must be a valid ActionType string — callers should coerce with toActionType()
 * before passing (D-02 robustness). Using string literal union here to avoid a circular
 * import with claim-extractor.ts (ActionType is defined there).
 */
export interface UpsertNodeTemporalParams {
  node_id: string;
  due_at: string;            // ISO-8601 UTC; next occurrence >= now for recurring
  action_type: string;       // Must be one of the 7 valid ActionType values (D-02)
  recurrence_rule?: string | null;   // RRULE string for recurring (null for one-off)
  source_event_id?: string | null;   // Calendar event id for dedup and cancellation
  updated_at: number;        // epoch ms; set on every upsert
}

/**
 * Row shape returned by SemanticStore.getNodeTemporal().
 */
export interface NodeTemporalRow {
  node_id: string;
  due_at: string;
  action_type: string;
  recurrence_rule: string | null;
  source_event_id: string | null;
  updated_at: number;
}

/**
 * Parameters for SemanticStore.upsertNodeScope() (Plan 999.3-01, D-S2).
 * scope is single-tenant PROVENANCE (which project a fact came from), NOT tenancy (D-S1).
 * Written exclusively by the sleep-pass consolidator (CONSOL-03, single writer).
 */
export interface UpsertNodeScopeParams {
  node_id: string;
  scope: string;       // project slug (e.g. 'vtx') or 'global'
  updated_at: number;  // epoch ms; set on every upsert
}

/**
 * Parameters for SemanticStore.upsertNodeDoc() (READER-01, Plan 27-01).
 * generated_at is a DEDICATED doc field — NOT node.last_access — so the staleness predicate
 * (node.last_access > doc.generated_at) cannot be corrupted when the doc node is accessed.
 * Written exclusively by the doc-writer path (CONSOL-03 discipline, single writer).
 *
 * Upsert semantics: generated_at is write-once (preserved on conflict — set only on first insert);
 * slug and updated_at are always updated.
 */
export interface UpsertNodeDocParams {
  node_id: string;
  slug: string;           // project slug (matches node_scope.scope)
  generated_at: number;   // epoch ms — set once on first generate, NOT updated on conflict
  updated_at: number;     // epoch ms — always updated
}

/**
 * Row shape returned by SemanticStore.getNodeDoc() (READER-01, Plan 27-01).
 * Mirrors the node_doc sidecar table columns.
 */
export interface NodeDocRow {
  node_id: string;
  slug: string;
  generated_at: number;   // epoch ms — NOT node.last_access (CONTEXT D §generatedAt)
  updated_at: number;
}

/**
 * Parameters for SemanticStore.upsertNodeInsight() (REFLECT-01, Plan 38-01).
 * generated_at is a DEDICATED insight field — NOT node.last_access — so the staleness
 * predicate (member.last_access > insight.generated_at) cannot be corrupted when the
 * insight node is accessed. Mirrors node_doc's generated_at write-once convention (D-01).
 * Written exclusively by the InsightReflector path (CONSOL-03 discipline, single writer).
 *
 * Upsert semantics: generated_at is write-once (preserved on conflict — set only on first insert);
 * anchor_schema_id and updated_at are always updated.
 */
export interface UpsertNodeInsightParams {
  node_id: string;
  anchor_schema_id: string;   // schema node id this insight was derived from (D-02)
  generated_at: number;       // epoch ms — set once on first generate, NOT updated on conflict
  updated_at: number;         // epoch ms — always updated
}

/**
 * Row shape returned by SemanticStore.getNodeInsight() (REFLECT-01, Plan 38-01).
 * Mirrors the node_insight sidecar table columns.
 */
export interface NodeInsightRow {
  node_id: string;
  anchor_schema_id: string;   // schema node id this insight was derived from
  generated_at: number;       // epoch ms — NOT node.last_access (write-once staleness anchor)
  updated_at: number;
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
