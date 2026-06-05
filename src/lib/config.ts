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
   * Anthropic model for cold-start LLM extraction (D-05).
   * Must be a current, non-deprecated model ID — see DEFAULT_CONFIG note.
   */
  anthropicModel: string;

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
  anthropicModel: 'claude-haiku-4-5-20251001',
  openaiEmbedModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
};
