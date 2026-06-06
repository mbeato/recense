/**
 * Central typed configuration (D-13).
 *
 * All tunables live here. Every default carries a comment explaining its role.
 * Values are calibration placeholders — tune against real MEMORY.md cadence.
 * Confidence uses c ← c + β(1−c) self-limiting form (D-14).
 */

/**
 * Role-based salience weights for the Allocation Gate (INGEST-02, D-01/02/03).
 * Weights are compiled once at AllocationGate construction — never per-call.
 */
export interface SalienceConfig {
  /** Per-role base score (D-02: tool output always gets lowest weight). */
  roleWeights: { user: number; assistant: number; tool: number };
  /** Weight of role signal in composite salience score. */
  wRole: number;
  /** Weight of content length signal (normalised to lengthNormWords). */
  wLength: number;
  /** Weight of directive pattern match (imperative/preference statements). */
  wDirective: number;
  /** Weight of correction pattern match (factual corrections). */
  wCorrection: number;
  /** Word count at which the length signal saturates to 1.0. */
  lengthNormWords: number;
  /** Regex strings for imperative / preference markers (compiled once at init). */
  directivePatterns: string[];
  /** Regex strings for factual correction markers (compiled once at init). */
  correctionPatterns: string[];
}

/**
 * Full engine configuration interface (D-13).
 * Plans 02/03/04 READ this; only Plan 01 defines it.
 */
export interface EngineConfig {
  /** Path to the SQLite database file (or ':memory:' for tests). */
  dbPath: string;

  // --- Strength / decay (D-13: all placeholders — calibrate against real MEMORY.md cadence) ---

  /**
   * Decay rate in day^-1. effective_s = s·exp(−λ·Δt).
   * λ=0.05 → half-life ~14 days; conservative for a personal memory that
   * should persist across weeks of sparse access.
   */
  lambda: number;

  /**
   * Hebbian strength increment rate. s ← s + η(1−s).
   * η=0.1: each co-activation adds ~10% of remaining headroom;
   * converges to ~1.0 after ~20 accesses.
   */
  eta: number;

  /**
   * Confidence step for the self-limiting increment (D-14). c ← c + β(1−c).
   * β=0.05 is conservative: needs many independent confirmations to reach 0.9,
   * so a contradiction always has headroom to push back (satisfies STR-02).
   */
  beta: number;

  /**
   * Number of distinct provenance contradictions before force-destabilization
   * (Chen-2020 threshold). N=3 balances noise tolerance vs. responsiveness.
   */
  contradictionN: number;

  /**
   * effective_s threshold for eviction candidacy (AND-gated with c + tombstoned).
   * 0.05 means a node has decayed to <5% of its peak strength.
   */
  evictionSThreshold: number;

  /**
   * Confidence threshold for eviction candidacy (AND-gated).
   * 0.15 means a node has very low confidence support.
   */
  evictionCThreshold: number;

  /**
   * Minimum confidence for training_eligible flag.
   * 0.6: node must have ≥60% confidence before entering the training corpus.
   */
  trainingConfidenceThreshold: number;

  // --- Episode ingestion ---

  /**
   * Maximum bytes for episode content before truncation (D-09).
   * 8KB prevents SQLite file bloat from large tool output dumps.
   */
  maxContentBytes: number;

  /** Salience gate configuration (D-01/02/03). */
  salience: SalienceConfig;

  // --- Cold-start (D-04/D-07) ---

  /** Path to per-file memory bodies directory (D-04). */
  coldStartMemoryDir: string;

  /** Path to CLAUDE.md hard rules file (D-04). */
  coldStartClaudeFile: string;

  // --- Model APIs ---

  /**
   * Selects the transport for the Judge/ClaimExtractor seams ONLY.
   * Default 'anthropic' = ZERO behavior change.
   * Faithfulness note: narrow transport seam, NOT the Phase 5 SEAM-01 ModelProvider abstraction.
   */
  modelProvider: 'anthropic' | 'vertex';

  /**
   * Anthropic model for cold-start LLM extraction (D-05).
   * Must be a current, non-deprecated model ID — see DEFAULT_CONFIG note.
   */
  anthropicModel: string;

  /**
   * GCP project for Vertex. Default '' → the vertex SDK reads ANTHROPIC_VERTEX_PROJECT_ID
   * from env natively (keeps nothing secret in config).
   */
  vertexProjectId: string;

  /**
   * GCP region (e.g. 'us-east5'). Default '' → SDK reads CLOUD_ML_REGION from env natively.
   */
  vertexRegion: string;

  /**
   * Vertex requires the @-version Haiku id; keep anthropicModel untouched for the direct path.
   */
  vertexModel: string;

  /**
   * OpenAI embedding model — Phase 2+ only.
   * Phase 1 uses synthetic vectors; real embedding is CONSOL-02.
   */
  openaiEmbedModel: string;

  /**
   * Embedding vector dimensions — must match openaiEmbedModel output.
   * 1536 dims → 6KB/node at v1 scale (negligible).
   */
  embeddingDimensions: number;

  // --- Phase 2: consolidation tunables (D-13 calibration placeholders) ---

  /**
   * Top-k candidate count passed to the judge (D-18).
   * 5 balances recall (enough candidates) vs. cost (judge evaluates each).
   * Increase if missed-match rate is high in dogfood; decrease if cost is a concern.
   */
  candidateK: number;

  /**
   * Salience below which a non-hard-keep episode is skipped in consolidation replay (CONSOL-01).
   * 0.2 means episodes with <20% salience are skipped unless force-kept.
   * Calibrate against real transcript cadence — too low wastes LLM budget on noise.
   */
  consolSkipThreshold: number;

  /**
   * D-13: assistant turns average 4.5× the length of user turns and are mostly restatement;
   * roughly half fall below 0.5 salience. Skipping them cuts the dominant Haiku extract cost
   * (one call per non-skipped episode) while keeping high-salience assistant decisions and
   * preserving the user/default consolSkipThreshold at 0.2 — all user turns still processed.
   * Reversibility: setting this to 0.2 fully restores the old per-role behaviour.
   */
  consolSkipThresholdAssistant: number;

  /**
   * Best-candidate cosine similarity below which a claim auto-classifies as `unrelated`
   * with no judge call; above it the claim escalates to the judge (UPDATE-02).
   * 0.3 is conservative: only extremely dissimilar claims skip the judge.
   * Safe-direction-only rule: below threshold → unrelated (never auto-confirms).
   */
  unrelatedSimilarityThreshold: number;

  /**
   * PE/resistance ratio below which a `contradict` HOLDs (weak challenge vs. strong node) (D-15/D-16).
   * 0.8: if PE magnitude < 0.8× resistance, the contradiction is not strong enough to reconcile.
   */
  peReconcileBandLow: number;

  /**
   * PE/resistance ratio above which a `contradict` appends a new divergent trace instead of
   * reconciling (D-15/D-16). 2.0: extreme/categorical contradictions coexist rather than overwrite.
   * Between peReconcileBandLow and peReconcileBandHigh → tombstone-and-replace reconcile.
   */
  peReconcileBandHigh: number;

  // --- Phase 3: retrieval tunables (D-24/25/27/29) ---

  /**
   * Weight of effective_s in cue-less rank score. Default: 1.0.
   * score = w_s·effective_s + w_r·recency(last_access).
   * Calibration placeholder — tune against real MEMORY.md session cadence (D-13).
   */
  rankWeightS: number;

  /**
   * Weight of separate recency term in rank score. Default: 0.0.
   * CAUTION: effective_s = s·exp(−λ·Δt since last_access) already encodes recency.
   * Setting w_r > 0 double-counts the same Δt signal; start at 0.0 and raise
   * only if dogfood shows effective_s alone misses fresh-session recall (D-24 caveat).
   */
  rankWeightR: number;

  /**
   * Max tokens to inject at SessionStart. Default: 500.
   * Matches the existing vault-briefing hook budget (session-start-context.ts
   * TOKEN_BUDGET = 500) for comparability during dogfood. Char proxy: budget × 4.
   */
  injectionTokenBudget: number;

  /**
   * Activation boost decay factor for 1-hop spreading activation (D-27).
   * boost = seed_score × edge_w × spreadDecay. Default: 0.5.
   * Calibration placeholder — lower if activation drowns high-strength seeds.
   */
  spreadDecay: number;

  /**
   * Min cosine similarity for the tombstone scan to classify 'deleted' (D-29).
   * Default: 0.7 — intentionally high to avoid false 'deleted' on weak matches.
   * A cue that matches a tombstoned node below this threshold → 'unreachable'.
   */
  deletedSimilarityThreshold: number;
}

/** Default salience weights for the Allocation Gate. Calibrate against real transcripts. */
const DEFAULT_SALIENCE_CONFIG: SalienceConfig = {
  roleWeights: { user: 0.8, assistant: 0.6, tool: 0.2 },
  wRole: 0.30,
  wLength: 0.20,
  wDirective: 0.35,
  wCorrection: 0.15,
  lengthNormWords: 100,
  directivePatterns: [
    '\\balways\\b',
    '\\bnever\\b',
    "\\bdon't\\b",
    '\\bremember\\b',
    '\\bi prefer\\b',
    "\\bplease don't\\b",
  ],
  correctionPatterns: [
    '\\bactually\\b',
    '\\bno,\\b',
    "\\bthat's wrong\\b",
    '\\bincorrect\\b',
    '\\bnot correct\\b',
  ],
};

/**
 * Default engine config.
 * All numeric values are calibration placeholders (D-13) — tune against real usage.
 * NOTE: anthropicModel uses 'claude-haiku-4-5-20251001' (current Haiku 4.5).
 *       Do NOT revert to deprecated 'claude-3-5-haiku-20241022'.
 */
export const DEFAULT_CONFIG: Omit<EngineConfig, 'dbPath'> = {
  lambda: 0.05,
  eta: 0.1,
  beta: 0.05,
  contradictionN: 3,
  evictionSThreshold: 0.05,
  evictionCThreshold: 0.15,
  trainingConfidenceThreshold: 0.6,
  maxContentBytes: 8_000,
  salience: DEFAULT_SALIENCE_CONFIG,
  coldStartMemoryDir: '$HOME/.claude/projects/-Users-you-resume/memory',
  coldStartClaudeFile: '$HOME/.claude/CLAUDE.md',
  modelProvider: 'anthropic',
  anthropicModel: 'claude-haiku-4-5-20251001',
  vertexProjectId: '',
  vertexRegion: '',
  vertexModel: 'claude-haiku-4-5@20251001',
  openaiEmbedModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
  candidateK: 5,
  consolSkipThreshold: 0.2,
  consolSkipThresholdAssistant: 0.5,
  unrelatedSimilarityThreshold: 0.3,
  peReconcileBandLow: 0.8,
  peReconcileBandHigh: 2.0,
  rankWeightS: 1.0,
  rankWeightR: 0.0,
  injectionTokenBudget: 500,
  spreadDecay: 0.5,
  deletedSimilarityThreshold: 0.7,
};
