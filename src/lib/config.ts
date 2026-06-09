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

  /**
   * Per-source salience multiplier (D-60).
   * Applied AFTER the honest composite cap (Math.min(composite, 1.0)) — noisy sources
   * earn lower salience rather than being pinned or trusted (D-03 never pinned).
   * 'claude-code': 1.0 → zero behavior change on the existing conversation path.
   * 'gmail': 0.35 → noisiest channel; must earn confidence through consolidation.
   * Unknown sources fall back to 'claude-code' weight (1.0) for back-compat.
   * D-13 calibration placeholders — tune against real channel volume.
   */
  sourceWeights: Record<string, number>;

  /**
   * Per-source consolidation skip threshold (D-60, mirrors consolSkipThresholdAssistant).
   * Sources not listed fall back to consolSkipThreshold (global 0.2 default).
   * 'gmail': 0.4 → higher bar; most email is lower-signal than conversation turns.
   * 'granola': 0.25 → slightly above default; transcripts denser but noisier.
   * D-13 calibration placeholders — tune against real consolidation cost vs. recall.
   * Reversibility: remove an entry to restore the global consolSkipThreshold for that source.
   */
  consolSkipThresholdBySource: Record<string, number>;
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
   * 'local' routes ALL Anthropic-family calls (judge/extractor/schema-naming/recall-compose)
   * to a local Ollama OpenAI-compatible endpoint (see localBaseUrl/localModel).
   * Faithfulness note: narrow transport seam, NOT the Phase 5 SEAM-01 ModelProvider abstraction.
   */
  modelProvider: 'anthropic' | 'vertex' | 'local';

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
   * OpenAI-compatible base URL for the local provider (Ollama). Used only when
   * modelProvider === 'local'. Default targets a local Ollama instance.
   */
  localBaseUrl: string;

  /**
   * Local model id served by Ollama (e.g. a Qwen reasoning model). Used only when
   * modelProvider === 'local'.
   */
  localModel: string;

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

  // --- Phase 4: learning layer tunables (D-35/36/42/45) ---

  /**
   * Min distinct non-inferred supporting instances for a candidate cluster to become
   * a named schema (D-36). N=3 balances noise (too few → spurious schemas) vs.
   * latency (too high → schemas never form on sparse MEMORY.md cadence).
   * Tune against real brain.db — start conservative.
   */
  schemaMinSupport: number;

  /**
   * Intra-cluster cohesion τ: mean pairwise cosine among cluster members must reach
   * this threshold before the cluster earns a name (D-36). 0.7 rejects loose, catch-all
   * clusters that would produce vague schema labels.
   */
  schemaCohesionThreshold: number;

  /**
   * Join-centroid cosine τ (D-35): a candidate instance joins the nearest existing
   * schema if cosine(instance.embedding, schema.centroid) >= this value; else seeds
   * a new candidate cluster. 0.75 is tighter than unrelatedSimilarityThreshold (0.3) —
   * schema membership requires genuine semantic alignment, not just rough proximity.
   */
  schemaJoinCentroidThreshold: number;

  /**
   * Max node count for the bounded 1-hop recall neighborhood (D-42).
   * 20 nodes: enough context for the schema-prior LLM compose without blowing the
   * prompt budget. Increase if 1-hop inference proves too shallow in dogfood.
   */
  recallNeighborhoodBudget: number;

  /**
   * Cosine similarity threshold for echo detection (D-45).
   * A replayed turn embedding with cosine >= this to a recent inferred episode is
   * classified as an echo and has source_inference_id backfilled. 0.85 is high to
   * catch paraphrases without flagging thematically-related but independent observations.
   */
  echoSimilarityThreshold: number;

  /**
   * Recency window (ms) for echo-detection candidates (D-45).
   * 24h (86_400_000 ms): inferred episodes older than this are not echo candidates —
   * a user revisiting an inference topic after a day is likely adding genuine new
   * information, not echoing. Tune if same-session echoes dominate in dogfood.
   */
  echoRecencyWindowMs: number;

  // --- Phase 5: eval-snapshot tunables (SEAM-03) ---

  /**
   * Band-cutpoint τ for the D-53 embedding-similarity replay match (SEAM-03).
   * cosine(expected_answer_embed, replayed_answer_embed) ≥ τ → match; below → regression.
   * A non-regressing engine's answer text should barely move — calibrate tighter than
   * deletedSimilarityThreshold (0.7). Set to 0.85 as a placeholder; TODO calibrate against
   * real retrieval drift measurements on the founder's brain.db (D-13).
   */
  snapshotMatchThreshold: number;

  // --- Phase 6: multi-channel ingestion tunables (D-60/D-65/D-68/D-69) ---

  /**
   * Gmail ingestion scope — native Gmail search query string (D-65).
   * Conservative default: primary inbox, no promotions/social/updates, 90-day window.
   * Tighten to 'label:brain' for explicit opt-in only. Change without code changes;
   * narrowing does NOT auto-re-ingest: use brain-ingest --reset-cursor gmail after
   * query changes that may cause gaps (historyId cursor is query-independent).
   *
   * OAuth note (D-68): Gmail refresh token + client ID/secret live EXCLUSIVELY in
   * ~/.config/brain-memory/sleep.env (chmod 600, gitignored), sourced by the launchd
   * wrapper — same secret-handling pattern as the LLM keys. Never add a token or
   * clientSecret field here. Secrets must not appear in config literals.
   */
  gmail: { query: string };

  /**
   * Watched export folder for meeting transcripts (D-69).
   * Empty string = disabled (fail-safe default — no directory watched unless set).
   * Set to the directory the founder drops/exports Granola/Otter/Zoom files into;
   * the adapter walks it on each pull cycle by file mtime.
   * Supported formats: .md, .txt, .vtt (speaker-turn aware); new formats = new parser.
   */
  transcripts: { dir: string };

  /**
   * Obsidian vault root path (D-56/D-61).
   * Empty string = disabled (fail-safe default — vault not walked unless set).
   * Set to the root of the founder's Obsidian vault; the adapter walks recursively,
   * one episode per note (split on headings when a note exceeds maxContentBytes).
   * Origin: asserted_by_user (D-61) — the founder's own curated second brain.
   * WARNING: only the founder's own vault should use this path. A third-party vault
   * would let external content masquerade as asserted_by_user (D-61 correctness guard).
   */
  obsidian: { dir: string };

  /**
   * List of enabled source adapter names (D-63 discretion, D-66).
   * Default: [] — all adapters off (fail-safe, mirrors modelProvider default).
   * Populate per environment, e.g. ['gmail', 'granola'] for the launchd cycle.
   * Adapters not in this list are skipped even if their config fields are populated,
   * preventing surprise ingestion when credentials are absent.
   */
  enabledSources: string[];

  // --- Phase 7: iMessage channel (D-70/D-71/D-74) ---

  /**
   * iMessage channel configuration (D-70/D-71/D-74).
   * channel.enable: false (default) — channel is off until self-hoster opts in (fail-closed, D-74).
   *   Set true only after populating chatDbPath and allowlist.
   * channel.chatDbPath: empty = disabled; set to ~/Library/Messages/chat.db after granting
   *   macOS Full Disk Access to the watcher process — see README.md onboarding.
   * channel.allowlist: [] (default = answers no one until configured, D-74).
   *   Entries are normalized phone/email handles matched against handle.id in chat.db.
   *   Unlisted senders are silently ignored — never confirms the surface exists.
   * channel.pollIntervalMs: 2000 — poll cadence for chat.db change detection.
   *   Near-instant feel; FSEvents watcher may replace this at Claude's discretion (D-71).
   *   Lower = faster reply but more syscalls; do not go below 500ms.
   */
  channel: {
    enable: boolean;
    chatDbPath: string;
    allowlist: string[];
    pollIntervalMs: number;
  };

  // --- Phase 7: Telegram channel (primary query surface) ---

  /**
   * Telegram bot channel configuration (the recommended query surface).
   * A Telegram bot has its own identity, so — unlike iMessage on a shared Apple ID —
   * the bot never receives its own replies and there is no self-echo loop.
   *
   * telegram.enable: false (default) — off until the self-hoster opts in (fail-closed).
   *   When both telegram.enable and channel.enable are set, Telegram takes precedence.
   * telegram.allowlist: [] (default = answers no one). Entries are numeric Telegram
   *   user IDs (as strings) matched against update.message.from.id. Unlisted senders
   *   are silently ignored.
   * telegram.pollIntervalMs: 2000 — getUpdates long-poll cadence; floored at 500ms.
   *
   * The bot token is a SECRET and is NOT stored here — it is read from the
   * BRAIN_MEMORY_TELEGRAM_TOKEN environment variable (sleep.env, chmod 600, gitignored).
   */
  telegram: {
    enable: boolean;
    allowlist: string[];
    pollIntervalMs: number;
  };
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
  // Per-source salience multipliers (D-60 calibration placeholders — tune against real volume, D-13)
  sourceWeights: {
    'claude-code': 1.0, // zero behavior change on the existing conversation path
    obsidian: 0.9,      // founder's own vault — near-trusted; still gated + honest
    granola: 0.5,       // meeting transcripts — moderate signal; attributed speaker turns
    gmail: 0.35,        // noisiest channel; must earn confidence through consolidation volume
  },
  // Per-source consolidation skip threshold (D-60, mirrors consolSkipThresholdAssistant)
  consolSkipThresholdBySource: {
    gmail: 0.4,    // higher bar: email is lower-signal; aggressive skip saves LLM budget
    granola: 0.25, // slightly above global 0.2; transcripts denser but noisier than conversation
  },
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
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: 'qwen3.6:35b-a3b',
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
  schemaMinSupport: 3,
  schemaCohesionThreshold: 0.7,
  schemaJoinCentroidThreshold: 0.75,
  recallNeighborhoodBudget: 20,
  echoSimilarityThreshold: 0.85,
  echoRecencyWindowMs: 86_400_000,
  snapshotMatchThreshold: 0.85, // TODO calibrate — tighter than deletedSimilarityThreshold (0.7); real drift data pending

  // Phase 6: multi-channel ingestion (D-60/D-65/D-68/D-69)
  gmail: {
    // Conservative scope (D-65): primary inbox, no categories, 90-day window.
    // Tighten to 'label:brain' for strict opt-in; see EngineConfig.gmail for OAuth note (D-68).
    query: 'in:inbox -category:promotions -category:social -category:updates newer_than:90d',
  },
  transcripts: {
    dir: '', // empty = disabled; set to the folder exports land in (D-69)
  },
  obsidian: {
    dir: '', // empty = disabled; set to vault root — founder's own vault only (D-56/D-61)
  },
  enabledSources: [], // default-off fail-safe; populate per environment to activate adapters (D-66)

  // Phase 7: iMessage channel (D-70/D-71/D-74)
  channel: {
    enable: false,           // default-off fail-closed; set true only after allowlist is populated
    chatDbPath: '',          // empty = disabled; set path in config after Full Disk Access grant
    allowlist: [],           // [] = answers no one (D-74 fail-closed); add your own handle(s)
    pollIntervalMs: 2_000,   // 2s poll cadence — near-instant feel, tunable (D-71)
  },

  // Phase 7: Telegram channel (primary query surface) — token from env, not here
  telegram: {
    enable: false,           // default-off fail-closed; set true after populating allowlist
    allowlist: [],           // [] = answers no one; add your numeric Telegram user ID(s)
    pollIntervalMs: 2_000,   // 2s getUpdates cadence — near-instant feel, tunable
  },
};
