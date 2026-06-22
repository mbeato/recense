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
   * 'deepseek' routes judge calls to DeepSeek's OpenAI-compatible endpoint (ECR-01).
   * 'claude-headless' shells out to the first-party `claude -p` binary on the founder's
   * Max subscription (spike 003; QUICK-260617-qat) — opt-in via env ONLY, default unchanged.
   * Faithfulness note: narrow transport seam, NOT the Phase 5 SEAM-01 ModelProvider abstraction.
   */
  modelProvider: 'anthropic' | 'vertex' | 'local' | 'deepseek' | 'claude-headless';

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
   * OpenAI-compatible base URL for the DeepSeek provider (ECR-01). Used only when
   * modelProvider === 'deepseek'. Default targets DeepSeek-direct.
   * Credential discipline: DEEPSEEK_API_KEY is read from process.env by the SDK,
   * never stored in config (extends T-05-KEY).
   */
  deepseekBaseUrl: string;

  /**
   * DeepSeek model id (e.g. 'deepseek-v4-pro'). Used only when
   * modelProvider === 'deepseek'.
   */
  deepseekModel: string;

  /**
   * Resolved model id for the headless `claude -p` transport (QUICK-260617-qat).
   * This is the value resolveModelId returns for modelProvider === 'claude-headless'.
   * The per-role sleep-pass overlay (resolveProviderOverlay) sets this to the judge or
   * extract model below; the bare default is the judge model (safe higher-stakes default).
   */
  claudeHeadlessModel: string;

  /**
   * Default judge model for the headless transport (spike 003: Sonnet beat the paid
   * Haiku-API judge). Consumed as the per-role default by resolveProviderOverlay.
   */
  claudeHeadlessJudgeModel: string;

  /**
   * Default extract model for the headless transport (spike 003: Haiku).
   * Consumed as the per-role default by resolveProviderOverlay.
   */
  claudeHeadlessExtractModel: string;

  /**
   * EVAL-04 cost lever: when true, the judge head runs two-tier (cheap Haiku first,
   * escalate to Sonnet only on a 'contradict' verdict — see TwoTierJudge). Default false
   * (single Sonnet judge, unchanged). Toggled via env RECENSE_TWO_TIER_JUDGE in
   * run-sleep-pass for A/B; safe because it never touches the cosine escalation gate.
   */
  twoTierJudge: boolean;

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
   * M1: max anchor candidates appended after cosine top-k for contradiction detection (M1).
   * Anchors come from two sources:
   *   - Link anchors: live nodes whose value contains a wikilink in the claim's links array.
   *   - Provenance-sibling anchors: live fact nodes sharing >=1 consolidation_event episode
   *     with an entity-type node that landed in cosine top-k.
   * Anchors are appended AFTER cosine candidates, deduped by id, and capped at this limit.
   * Default 5 matches candidateK — calibration placeholder (D-13 / T-UE6-03).
   */
  entityAnchorK: number;

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

  /**
   * Minimum effective resistance (effective_s × c) a node must have before a `contradict`
   * verdict in the extreme band (ratio >= peReconcileBandHigh) can route to append-new.
   *
   * Without this guard, a fresh node (s=0.1, c=0.5 → resistance=0.05) routes to append-new
   * for ANY judge magnitude >= 0.10 (ratio = magnitude/0.05 >= 2.0), because the reconcile
   * band (magnitude 0.04–0.10) is too narrow to be reached in practice. The result: the old
   * node is never tombstoned, every contradiction produces a duplicate, and belief-correction
   * never completes (D-16 structural defect for fresh nodes).
   *
   * 0.3: a fresh node with s=0.1/c=0.5 (resistance=0.05) cannot reach this — it will always
   * reconcile. An established node needs roughly s=0.6, c=0.5 or s=0.375, c=0.8 to reach 0.3,
   * appropriate evidence for a belief treated as "established enough to coexist with a
   * contradiction." Default 0.3 is a calibration placeholder (D-13).
   */
  peAppendNewMinResistance: number;

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
   * Weight of the strength-ranked third RRF list fused into hybridTopk (Phase 35 RANK-01, D-01).
   * Ships at 0 (dark, D-04): w=0 reproduces today's exact [cosine, bm25] ranking with no change.
   * Raise after eval sweep (RANK-02) confirms a win on KU/LongMemEval harness.
   *
   * Sibling to rankWeightS and rankWeightR, but applies to the CUE-BASED path only
   * (hybridTopk, D-08). The cue-less path (retrieveCueless/SessionStart) is unaffected.
   *
   * CAUTION: effective_s already folds recency via exp(−λ·Δt since last_access) — this is
   * one signal, one knob (D-03). Do NOT add a separate last_access recency list.
   */
  rankStrengthWeight: number;

  /**
   * Phase 37: min cosine for query→predicate confident match (D-07).
   * Below threshold → schema-neighborhood fallback (D-06); at or above → typed-path mode.
   *
   * Default 0.35 — follows the `rankedRetrievalFloor` calibration ("real queries score
   * 0.4–0.6; noise < 0.3"). Ships at 0.35, NOT 0 — a 0-default would never trigger
   * typed-path mode (unlike rankStrengthWeight which ships dark at 0).
   *
   * Calibration: tune against the D-05 build-harness query set. If > 30% of expected-
   * match queries fall below 0.35, lower to 0.30. If unrelated queries trigger typed-path
   * mode, raise toward 0.40. The +29.5pts precision win (spike) is the ceiling.
   */
  predicateGlossThreshold: number;

  /**
   * Phase 37 go-live: number of top retrieval candidates the typed-path seeds the
   * union traversal from (not just the single bestMatch). Live coverage saturates at
   * 20 (gold-reached 50%→71%); larger pools add no recall and only grow the frontier.
   * Recall issues ONE topk at max(candidateK, typedAnchorPoolK) so there is no extra
   * cosine scan and the neighborhood path's bestMatch (topHits[0]) is unchanged.
   */
  typedAnchorPoolK: number;

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

  /**
   * Top-k candidate count for the ranked product question-answering path (retrieveRanked / memory_ask).
   * Default 10 — matches the memory_search SEARCH_TOP_K precedent; provides enough breadth
   * for grounded compose answers. Distinct from candidateK (5), which governs the consolidation
   * judge candidate count and is unrelated to this path.
   */
  rankedRetrievalK: number;

  /**
   * Min cosine similarity for a hit to surface on the ranked retrieval path (retrieveRanked).
   * Default 0.3 — mirrors the memory-ops SEARCH_SCORE_FLOOR precedent ("real queries score
   * 0.4–0.6; noise <0.3 excluded"). Intentionally distinct from deletedSimilarityThreshold (0.7):
   * the 0.7 threshold classifies tombstoned-node deletion (D-29 semantics); this threshold gates
   * live-node surfacing for question-form cues that typically score 0.4–0.6 against stored facts
   * — below the single-hit 0.7 bar but well above noise.
   */
  rankedRetrievalFloor: number;

  /**
   * LEVER 2 (Phase 17): date-annotate retrieveRanked answer-prompt entries using MAX(episode.ts)
   * per node via the consolidation_event → episode join.
   *
   * When true: candidate values are prefixed with `[YYYY-MM-DD]` and sorted newest-supported-first.
   * Orphan nodes (no consolidation_event rows) are treated as undated and never demoted below
   * dated nodes purely on missing data.
   *
   * Default: false — product behaviour is unchanged until measured in 17-05.
   * Enable via env or config once the 17-05 paid measurement confirms improvement.
   */
  temporalAnnotation: boolean;

  // --- Phase 4: learning layer tunables (D-35/36/42/45) ---

  /**
   * Min distinct non-inferred supporting instances for a candidate cluster to become
   * a named schema (D-36). N=3 balances noise (too few → spurious schemas) vs.
   * latency (too high → schemas never form on sparse MEMORY.md cadence).
   * Tune against real recense.db — start conservative.
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
   * A non-regressing engine's answer text should barely move — must stay above
   * deletedSimilarityThreshold (0.7). Default 0.85; recalibrate via
   * scripts/eval/calibrate-snapshot-threshold.cjs once eval_snapshot rows are populated (D-13).
   */
  snapshotMatchThreshold: number;

  // --- Phase 18: schema-relations-engine tunables (SREL-01/02/03) ---

  /**
   * Min member-centroid cosine for a schema_rel edge to form (SREL-01, D-01).
   * High default → few, high-confidence edges only. Calibration placeholder (D-13):
   * start conservative and loosen against observed graph density on real ~1.5k-node recense.db.
   */
  schemaRelSimilarityThreshold: number;

  /**
   * Agglomerative-merge distance cut in (1 − cosine) space (SREL-02, D-03).
   * Schema pairs whose centroid cosine ≳ 0.65 (1−0.35 = 0.65) merge into a super-schema.
   * Calibration placeholder (D-13): tune against real recense.db — lower = more aggressive merge.
   * Consumed by plan 18-02 (SREL-02); present here so 18-01/18-02 stay parallel.
   */
  schemaClusterCutHeight: number;

  /**
   * Max related-schema fan-out for the single sideways recall hop (SREL-03, D-05).
   * Caps the number of top-N schema_rel neighbours followed per query to bound latency.
   * Calibration placeholder (D-13): default 3 — start conservative; raise if retrieval proves
   * too shallow. Consumed by plan 18-03 (SREL-03); present here so waves stay parallel.
   */
  recallSidewaysHopBudget: number;

  // --- Phase 38: derived insight (reflection) tunables (REFLECT-01/02, D-01/D-03/D-04/D-05/D-06) ---

  /**
   * Confidence ceiling for synthesized insight nodes (REFLECT-01, D-04).
   * Insight nodes are capped at this value so they never outrank the evidence-backed
   * schemas they were derived from. Must sit below typical schema confidence.
   *
   * VERIFY-WITH-FOUNDER: suggested default 0.6. Calibrate against live recense.db
   * schema confidence distribution (schemas land ~0.6–0.9 after multiple reinforcements;
   * 0.6 is at the low end, giving insights a weaker-than-typical-schema signal).
   * Tune if insights surface incorrectly at recall time.
   */
  reflectConfidenceCeiling: number;

  /**
   * High-watermark member-mass threshold for hysteresis gate (REFLECT-01, D-03/D-06).
   * A schema cluster qualifies for insight generation when its member count (distinct
   * non-inferred abstracts edges) reaches at least this value.
   * Seeded from Phase 28 CorpusPromoter's highMass:10 (run-sleep-pass.ts:419).
   * Calibrate against live brain: the highest-mass clusters tend to be dogfooding artifacts
   * ("Git commit hashes") — the noise filter (D-03) catches those, but the mass floor still
   * gates against trivially small clusters.
   */
  reflectMassFloorHigh: number;

  /**
   * Low-watermark member-mass threshold for hysteresis gate (REFLECT-01, D-06).
   * When a previously-qualifying cluster's mass drops below this value, the insight is
   * tombstoned (cluster dissolution, mirrors CorpusPromoter's lowMass:7 hysteresis).
   * Must be <= reflectMassFloorHigh. Prevents pass-to-pass thrash on borderline clusters.
   * Seeded from Phase 28 CorpusPromoter's lowMass:7 (run-sleep-pass.ts:420).
   */
  reflectMassFloorLow: number;

  /**
   * Freshness / match threshold for surfacing a pre-computed insight at recall time (REFLECT-02, D-05).
   * An insight is surfaced only when the schema-resolution confidence and the insight's
   * freshness (generated_at vs. member last_access) both clear this threshold.
   * Conservative default 0.7 — start high to avoid stale or marginal insights surfacing;
   * lower after eval (38-04) confirms the compose-token win with no quality regression.
   * Calibrate against the KU/LongMemEval harness (D-05 measurement bar).
   */
  reflectFreshnessThreshold: number;

  /**
   * Master activation flag for surfacing pre-computed insights at recall time (REFLECT-02, D-05).
   * Ships DARK (false) by default — no recall behavior change until plan 38-04 eval proves
   * the compose-token win with no quality regression. Mirrors rankStrengthWeight:0 dark posture.
   *
   * Set to true only after the 38-04 eval confirms the improvement. The eval flips this flag
   * and measures the token-reduction delta on the existing KU/LongMemEval replay harness.
   *
   * D-05: prove-before-activate posture (mirrors Phase 35 D-04).
   */
  insightSurfacingEnabled: boolean;

  // --- Phase 6: multi-channel ingestion tunables (D-60/D-65/D-68/D-69) ---

  /**
   * Gmail ingestion scope — native Gmail search query string (D-65).
   * Conservative default: primary inbox, no promotions/social/updates, 90-day window.
   * Tighten to 'label:brain' for explicit opt-in only. Change without code changes;
   * narrowing does NOT auto-re-ingest: use brain-ingest --reset-cursor gmail after
   * query changes that may cause gaps (historyId cursor is query-independent).
   *
   * OAuth note (D-68): Gmail refresh token + client ID/secret live EXCLUSIVELY in
   * ~/.config/recense/sleep.env (chmod 600, gitignored), sourced by the launchd
   * wrapper — same secret-handling pattern as the LLM keys. Never add a token or
   * clientSecret field here. Secrets must not appear in config literals.
   */
  gmail: { query: string };

  /**
   * Google Calendar ingestion config (TEMP-01, D-08).
   * calendar.enabled: false (fail-safe default) — no Calendar adapter unless explicitly set.
   * D-08: OAuth credentials per account in sleep.env (GOOGLE_<ACCOUNT_ID>_REFRESH_TOKEN).
   * Fail-safe: with enabled=false, no CalendarAdapter is instantiated even if
   * 'gcal' appears in enabledSources — prevents surprise ingestion without creds.
   */
  calendar: {
    enabled: boolean;
  };

  /**
   * Multi-account Google config (TEMP-04, D-08/D-10).
   * Each entry is one Google account id. 'default' maps to backward-compat env keys
   * (GMAIL_* with GOOGLE_DEFAULT_* override). Named accounts (e.g. 'work') require
   * GOOGLE_WORK_REFRESH_TOKEN in sleep.env.
   * Accounts listed here are instantiated as separate adapter instances per source
   * in buildAdapters. Example: [{ id: 'default' }, { id: 'work' }]
   */
  googleAccounts: Array<{ id: string }>;

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

  // --- On-write sleep-pass trigger (L8N-01) ---

  /**
   * Path to the dirty-sentinel file touched on every real new non-inferred episode write.
   * Empty string = disabled (fail-safe default — no filesystem access unless set).
   * Set to ~/.config/recense/.episodes-dirty in the dogfood/launchd setup via
   * RECENSE_DIRTY_SENTINEL; launchd WatchPaths watches the same path.
   * The touch is a no-op when this field is empty — unit tests and embedded uses
   * never hit the filesystem (matches the coldStartMemoryDir / transcripts.dir pattern).
   */
  dirtySentinelPath?: string;

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
    gcal: 0.45,         // D-09: calendar events — more structured than email (0.35), lower than obsidian (0.9)
  },
  // Per-source consolidation skip threshold (D-60, mirrors consolSkipThresholdAssistant).
  // Sources not listed fall back to the per-role default (consolSkipThreshold / consolSkipThresholdAssistant).
  consolSkipThresholdBySource: {
    gmail: 0.4,         // higher bar: email is lower-signal; aggressive skip saves LLM budget
    granola: 0.25,      // slightly above global 0.2; transcripts denser but noisier than conversation
    obsidian: 0.2,      // curated vault content — same as global default; low skip justified
    conversation: 0.2,  // general conversation: same as global default; episodic detail extraction
                        // is the whole point, so don't skip more aggressively than the base rate
    gcal: 0.3,          // calendar events are structured but may repeat; moderate skip threshold
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
  coldStartMemoryDir: '', // empty = disabled; set RECENSE_COLD_START_MEMORY_DIR or configure (D-79)
  coldStartClaudeFile: '', // empty = disabled; set RECENSE_COLD_START_CLAUDE_FILE or configure (D-79)
  modelProvider: 'anthropic',
  anthropicModel: 'claude-haiku-4-5-20251001',
  vertexProjectId: '',
  vertexRegion: '',
  vertexModel: 'claude-haiku-4-5@20251001',
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: 'qwen3.6:35b-a3b',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-v4-pro',
  claudeHeadlessModel: 'claude-sonnet-4-6',        // resolved default = judge model (higher-stakes)
  claudeHeadlessJudgeModel: 'claude-sonnet-4-6',   // spike 003: Sonnet judge on Max
  claudeHeadlessExtractModel: 'claude-haiku-4-5',  // spike 003: Haiku extract on Max
  twoTierJudge: false,                             // EVAL-04 lever, default off (single Sonnet judge)
  openaiEmbedModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
  candidateK: 5,
  entityAnchorK: 5,
  consolSkipThreshold: 0.2,
  consolSkipThresholdAssistant: 0.5,
  unrelatedSimilarityThreshold: 0.3,
  peReconcileBandLow: 0.8,
  peReconcileBandHigh: 2.0,
  peAppendNewMinResistance: 0.3,
  rankWeightS: 1.0,
  rankWeightR: 0.0,
  rankStrengthWeight: 0,  // D-04: dark default — ships w=0; no behavior change at merge
  // Phase 37: min cosine for query→predicate confident match (D-07, RESEARCH §2).
  // Below threshold → schema-neighborhood fallback (D-06); calibrate against D-05 harness.
  predicateGlossThreshold: 0.35,
  // Phase 37 go-live: # of top retrieval candidates the typed-path seeds typedReach from.
  // The single bestMatch is often a fact-sentence or fragmented entity; unioning the top-K
  // recovers the clean edge-bearing entity. Live sweep: gold-reached saturates at 20
  // (50%→71%), small frontier (~3.7). Recall fetches max(candidateK, this) candidates ONCE.
  typedAnchorPoolK: 20,
  injectionTokenBudget: 500,
  spreadDecay: 0.5,
  deletedSimilarityThreshold: 0.7,
  rankedRetrievalK: 10,     // breadth for product Q&A path; matches memory_search SEARCH_TOP_K
  rankedRetrievalFloor: 0.3, // min cosine for ranked path; matches SEARCH_SCORE_FLOOR (noise < 0.3)
  temporalAnnotation: false, // LEVER 2: date-annotate answer-prompt entries; default OFF until 17-05 measured
  schemaMinSupport: 3,
  schemaCohesionThreshold: 0.7,
  schemaJoinCentroidThreshold: 0.75,
  recallNeighborhoodBudget: 20,
  echoSimilarityThreshold: 0.85,
  echoRecencyWindowMs: 86_400_000,
  snapshotMatchThreshold: 0.85, // default; recalibrate via scripts/eval/calibrate-snapshot-threshold.cjs (2026-06-09) once eval_snapshot rows exist — must stay above deletedSimilarityThreshold (0.7)

  // Phase 18: schema-relations-engine (SREL-01/02/03) — calibration placeholders (D-13)
  schemaRelSimilarityThreshold: 0.8,  // start conservative; tune against real recense.db (D-01)
  schemaClusterCutHeight: 0.35,       // 1−0.35 = 0.65 cosine floor for super-schema merge (D-03); plan 18-02 consumer
  recallSidewaysHopBudget: 3,         // max related-schema fan-out per sideways hop (D-05); plan 18-03 consumer

  // Phase 38: derived insight (reflection) tunables (REFLECT-01/02, D-01/D-03/D-04/D-05/D-06)
  reflectConfidenceCeiling: 0.6,      // VERIFY-WITH-FOUNDER: cap insight confidence below schema confidence (D-04)
  reflectMassFloorHigh: 10,           // min cluster member mass to qualify for insight generation (D-03; seeded from Phase-28 highMass:10)
  reflectMassFloorLow: 7,             // hysteresis low-water: dissolve insight when mass drops below this (D-06; seeded from Phase-28 lowMass:7)
  reflectFreshnessThreshold: 0.7,     // conservative recall freshness gate; lower after 38-04 eval (D-05)
  insightSurfacingEnabled: false,     // D-05: ship DARK — no recall behavior change until 38-04 eval proves compose-token win (mirrors rankStrengthWeight:0)

  // Phase 6: multi-channel ingestion (D-60/D-65/D-68/D-69)
  gmail: {
    // Conservative scope (D-65): primary inbox, no categories, 90-day window.
    // Tighten to 'label:brain' for strict opt-in; see EngineConfig.gmail for OAuth note (D-68).
    query: 'in:inbox -category:promotions -category:social -category:updates newer_than:90d',
  },

  // Phase 20: multi-account + Calendar ingestion config (TEMP-01/TEMP-04, D-08/D-10)
  calendar: {
    enabled: false, // fail-safe default; set true once GOOGLE_*_REFRESH_TOKEN is in sleep.env
  },
  googleAccounts: [
    { id: 'default' }, // maps to backward-compat GMAIL_REFRESH_TOKEN / GOOGLE_DEFAULT_REFRESH_TOKEN
  ],

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

  // On-write sleep-pass trigger (L8N-01)
  dirtySentinelPath: '', // empty = disabled; set RECENSE_DIRTY_SENTINEL or configure

};
