/**
 * Extraction-replay KU harness (RETR-02 validation tool, Plan 26-05).
 *
 * Consumes cached granite extractions from ~/.recense-eval-cache/eval01-n20-2026-06-16/
 * (n20-attribution.jsonl = 18 KU cases, each with pre-extracted claims[]) and re-runs
 * embed → consolidate → retrieve → score WITHOUT re-extracting from granite
 * (avoids ~45h extraction cost).
 *
 * Embedder-agnostic: constructed from DEFAULT_CONFIG.openaiEmbedModel + embeddingDimensions.
 * No embedder swap flag — the swap premise is falsified (D-01).
 *
 * Run:
 *   npm run build && node scripts/eval/replay-ku-harness.cjs --dry-run --out /tmp/replay-ku-dry.json
 *   npm run build && OPENAI_API_KEY=... ANTHROPIC_API_KEY=... node scripts/eval/replay-ku-harness.cjs
 *
 * Sweep mode (Phase 35-02 perf): consolidate once per case, sweep retrieve+answer+score per weight.
 *   node scripts/eval/replay-ku-harness.cjs --sweep-weights 0,0.25,0.5,1.0,2.0
 *   Writes scripts/eval/results/35-sweep-w<w>.json for each weight (same schema as single-weight run).
 *
 * Insight mode (Phase 38-04, REFLECT-02): measure compose-token reduction from insight surfacing.
 *   Consolidation runs ONCE per case (same graph, same judge-engagement). Then evaluation runs
 *   TWICE: insight-OFF (baseline, config.insightSurfacingEnabled=false) and insight-ON.
 *   Insight-ON checks for a live, non-stale insight anchored to the resolved schema node and
 *   uses it as the compose payload instead of the raw K-member neighborhood.
 *   Records per-case composeTokens (chars/4 proxy matching EVAL-03 convention), and aggregate
 *   composeTokensOff / composeTokensOn / composeTokenReductionPct in the result meta.
 *   Sets meta.regression=true if insight-ON KU score falls below insight-OFF by more than
 *   TOLERANCE_BAND_PTS (2 pts) — the Phase-35 D-07 small-tolerance no-regression band.
 *
 *   node scripts/eval/replay-ku-harness.cjs --insight-mode --dry-run --out /tmp/replay-38-dry.json
 *   npm run build && OPENAI_API_KEY=... node scripts/eval/replay-ku-harness.cjs --insight-mode
 *
 * Load-bearing output: judge-engagement (tombstone count + contradict-verdict count +
 * duplicate-mint count) so 26-07's RETR-02 gate is measurable.
 * A KU-score bump alone is insufficient — belief-correction must be confirmed via the
 * judge firing on contradictions (not extraction + recency alone).
 *
 * Key requirements (T-14-DB):
 *   - Every case uses a fresh scratch DB under os.tmpdir(); live DB env var never read.
 *   - --dry-run: ingest + scratch DB build with ZERO API/LLM calls, exit 0.
 *   - Real run: requires OPENAI_API_KEY (embed) + judge keys per resolveProviderOverlay.
 *   - Results written to --out with meta (embedder model, cache id, date, commit).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ---- arg parser (mirrors judge-eval-runner.cjs convention) ------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DRY_RUN          = process.argv.includes('--dry-run');
const CACHE_DIR        = arg('--cache', path.join(os.homedir(), '.recense-eval-cache/eval01-n20-2026-06-16'));
const ATTRIBUTION_FILE = arg('--attribution', path.join(CACHE_DIR, 'n20-attribution.jsonl'));
const KU_FILE          = arg('--ku', path.join(CACHE_DIR, 'eval20-ku.jsonl'));
const OUT              = arg('--out', 'scripts/eval/results/replay-ku-PENDING.json');

// --strength-weight <w>: RRF strength weight passed to retrieveRanked → hybridTopk (Phase 35 RANK-02).
// Default 0 (dark) — identical to current behaviour. Sweepable via 35-strength-sweep.cjs.
const STRENGTH_WEIGHT = parseFloat(arg('--strength-weight', '0')) || 0;

// --sweep-weights <csv>: Phase 35-02 consolidate-once sweep mode.
// When set, consolidation runs ONCE per case; only retrieve+answer+score re-run per weight.
// Writes one results file per weight: scripts/eval/results/35-sweep-w<w>.json
// Ignored in --dry-run mode (dry-run uses the legacy single-weight path).
const sweepWeightsArg = arg('--sweep-weights', null);
const SWEEP_WEIGHTS = sweepWeightsArg
  ? sweepWeightsArg.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n))
  : null;

// --insight-mode: Phase 38-04, REFLECT-02 compose-token measurement.
// When set, each case is evaluated TWICE: insight-OFF (baseline, insightSurfacingEnabled=false)
// and insight-ON (insightSurfacingEnabled=true). The insight-ON path checks the consolidated
// scratch DB for a live non-stale insight anchored to the resolved schema and uses it as
// the compose payload instead of the raw K-member neighborhood (the compose-token win).
// Aggregate composeTokensOff / composeTokensOn / composeTokenReductionPct written to meta.
// regression flag set if insight-ON KU score < insight-OFF by more than TOLERANCE_BAND_PTS.
// Works with --dry-run (zero API calls, placeholder token counts).
const INSIGHT_MODE = process.argv.includes('--insight-mode');

// Phase-35 D-07 small-tolerance no-regression band (percentage points).
// Insight-ON KU score may dip at most this many pts below insight-OFF before regression=true.
const TOLERANCE_BAND_PTS = 2;

// ---- compose-token count helper (REFLECT-02 / T-38-10) ----------------------
// Uses chars/4 proxy — same convention as EVAL-03 injection-efficiency harness.
// This is NOT a real tokenizer; it is consistent with the session-start-cli char cap proxy.
// No-inflated-metrics guard (CLAUDE.md): all counts are measured from the actual payload
// assembled at evaluation time, recorded with meta (embedder/cache/date/commit).
function countComposeTokens(payloadText) {
  return Math.round(payloadText.length / 4);
}

// ---- insight surfacing helper (REFLECT-02) -----------------------------------
// Given an already-consolidated scratch DB and the top hit from retrieveRanked,
// resolves the schema node (Case A: hit IS a schema; Case B: walk incoming 'abstracts'
// edges) then looks for a live, non-stale insight via the reverse 'derived_from' in-edge
// walk. Mirrors RecallEngine.recall() L306-397 logic but as a pure read on the scratch DB.
// Returns the insight text string if a live non-stale insight is found, else null.
//
// T-14-DB: reads only the scratch DB; never touches the live DB path.
// T-38-08: pure read — no upsertNode/upsertEdge/tombstone/strengthen calls.
function findInsightForTopHit(db, store, topHit) {
  if (!topHit) return null;

  // Resolve schema node (Case A: topHit is a schema; Case B: reverse abstracts walk)
  const topNode = store.getNode(topHit.id);
  if (!topNode || topNode.tombstoned === 1) return null;

  let schemaId = null;
  if (topNode.type === 'schema') {
    schemaId = topNode.id;
  } else {
    // Case B: walk incoming 'abstracts' edges to find the schema that abstracts this member
    const inEdges = store.getInEdges(topHit.id);
    for (const inEdge of inEdges) {
      if (inEdge.kind !== 'abstracts') continue;
      const srcNode = store.getNode(inEdge.src);
      if (!srcNode || srcNode.tombstoned === 1 || srcNode.type !== 'schema') continue;
      schemaId = srcNode.id;
      break;
    }
  }

  if (!schemaId) return null;

  // Walk INCOMING 'derived_from' edges on the schema to find a live insight
  const schemaInEdges = store.getInEdges(schemaId);
  let liveInsightId = null;
  for (const inEdge of schemaInEdges) {
    if (inEdge.kind !== 'derived_from') continue;
    const candidate = store.getNode(inEdge.src);
    if (!candidate || candidate.tombstoned === 1 || candidate.type !== 'insight') continue;
    liveInsightId = candidate.id;
    break;
  }

  if (!liveInsightId) return null;

  // FRESHNESS GATE: check node_insight sidecar for staleness
  // Mirrors RecallEngine.recall() L321-350 freshness check
  const insightMeta = store.getNodeInsight(liveInsightId);
  if (!insightMeta) return null; // no sidecar → treat as stale (conservative)

  const insightOutEdges = store.getOutEdges(liveInsightId);
  for (const outEdge of insightOutEdges) {
    if (outEdge.kind !== 'derived_from') continue;
    if (outEdge.dst === schemaId) continue; // skip the anchor schema edge itself
    const depNode = store.getNode(outEdge.dst);
    if (!depNode || depNode.tombstoned === 1) return null; // stale
    if (depNode.last_access > insightMeta.generated_at) return null; // stale
  }

  // Live, non-stale insight found — return its text value
  const insightNode = store.getNode(liveInsightId);
  return insightNode ? insightNode.value : null;
}

// ---- compiled engine modules (require npm run build first) ------------------
// Failing requires here mean `npm run build` has not been run yet.
const Database                    = require('better-sqlite3');
const { initSchema }              = require('../../dist/src/db/schema');
const { DEFAULT_CONFIG }          = require('../../dist/src/lib/config');
const { realClock }               = require('../../dist/src/lib/clock');
const { EpisodicStore }           = require('../../dist/src/db/episode-store');
const { SemanticStore }           = require('../../dist/src/db/semantic-store');
const { StrengthDecayManager }    = require('../../dist/src/strength/decay');
const { CandidateRetriever }      = require('../../dist/src/retrieval/topk');
const { AllocationGate }          = require('../../dist/src/gate/allocation-gate');
const { RetrievalEngine }         = require('../../dist/src/retrieval/engine');
const { NoopActivationTraceSink } = require('../../dist/src/viz/activation-sink');
// runConsolidation and OpenAIEmbedder are only invoked in non-dry-run paths
const { runConsolidation, resolveProviderOverlay } = require('../../dist/src/consolidation/run-sleep-pass');
const { OpenAIEmbedder }          = require('../../dist/src/model/embedder');
const { createClaudeHeadlessClient } = require('../../dist/src/model/claude-headless-client');

// ---- API key guard (real runs only) -----------------------------------------
// RECENSE_ANSWER_PROVIDER (or RECENSE_MODEL_PROVIDER) = claude-headless → skip ANTHROPIC_API_KEY.
// OPENAI_API_KEY is always required for embeddings (not covered by headless).
if (!DRY_RUN) {
  const answerOverlay = resolveProviderOverlay(process.env, 'RECENSE_ANSWER_PROVIDER');
  const isHeadless = answerOverlay.modelProvider === 'claude-headless';
  const missing = [];
  if (!process.env.OPENAI_API_KEY)                      missing.push('OPENAI_API_KEY');
  if (!isHeadless && !process.env.ANTHROPIC_API_KEY)    missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    console.error(`\nERROR: missing keys for a real run: ${missing.join(', ')}`);
    console.error('Pass --dry-run to validate cache parsing + scratch DB with zero API calls.');
    if (!isHeadless) {
      console.error('TIP: set RECENSE_MODEL_PROVIDER=claude-headless to use the subscription-billed transport (no API key needed for answer/score calls).');
    }
    process.exit(1);
  }
}

// ---- JSONL parser -----------------------------------------------------------

function parseJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch (e) {
      console.error(`[warn] Skipping malformed JSONL line ${i + 1} in ${filePath}: ${String(e.message || e).slice(0, 100)}`);
    }
  }
  return out;
}

// ---- scratch DB factory (T-14-DB) -------------------------------------------
// Creates a unique temp-file SQLite DB; never touches the live DB path (T-14-DB).
// rankStrengthWeight in the returned config is used only when building the RetrievalEngine
// via buildEngineForWeight(); the DB itself (nodes, edges, embeddings) is weight-independent.

function makeScratchDb(rankStrengthWeight) {
  const w = (rankStrengthWeight !== undefined) ? rankStrengthWeight : STRENGTH_WEIGHT;
  const dbPath = path.join(
    os.tmpdir(),
    `replay-ku-eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(dbPath);
  initSchema(db);
  // rankStrengthWeight: inject so engine.retrieveRanked → hybridTopk reads it.
  const config = { ...DEFAULT_CONFIG, dbPath, rankStrengthWeight: w };
  const episodes = new EpisodicStore(db, realClock, config);
  return {
    db,
    dbPath,
    episodes,
    config,
    cleanup() {
      try { db.close(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
    },
  };
}

// ---- build a RetrievalEngine over an existing scratch DB at a given weight --
// Used by the sweep path: same consolidated DB, different rankStrengthWeight per call.
// The DB is read-only from the engine's perspective (spec §8 / retrieveRanked is pure read).

function buildEngineForWeight(scratch, w) {
  const config = { ...scratch.config, rankStrengthWeight: w };
  const retriever = new CandidateRetriever(scratch.db);
  const store     = new SemanticStore(scratch.db, realClock, config);
  const strength  = new StrengthDecayManager(scratch.db, realClock, config);
  const gate      = new AllocationGate(config);
  const traceSink = new NoopActivationTraceSink();
  return new RetrievalEngine(scratch.db, realClock, config, retriever, store, strength, gate, traceSink);
}

// ---- judge-engagement counters (queried from consolidation_event after pass) -

/**
 * Count tombstones (nodes with tombstoned=1), contradict-verdict events, and
 * duplicate mints (unrelated events: claims that minted a new node even though
 * a same-belief candidate existed in the graph — the metric RETR-02's fix must
 * drive down).
 *
 * Contradict events: any contradict_* event_type in consolidation_event.
 * Duplicate mints: 'unrelated' event_type in consolidation_event (claim routed to
 * a fresh node rather than confirming/extending/contradicting an existing belief).
 */
function queryJudgeEngagement(db) {
  const tombstones = db
    .prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned = 1')
    .get().n;

  const rows = db
    .prepare("SELECT event_type, COUNT(*) AS n FROM consolidation_event GROUP BY event_type")
    .all();

  let contradicts = 0;
  let duplicateMints = 0;
  for (const r of rows) {
    if (r.event_type.startsWith('contradict_')) contradicts += r.n;
    if (r.event_type === 'unrelated') duplicateMints += r.n;
  }

  return { tombstones, contradicts, duplicateMints };
}

// ---- per-case replay pipeline -----------------------------------------------

/**
 * Dry-run: parse claims, ingest into scratch DB as episodes, no API calls.
 * Returns a skeleton result with zero engagement counts.
 */
function runDryRunCase(kuCase, claims) {
  const scratch = makeScratchDb(STRENGTH_WEIGHT);
  try {
    for (let i = 0; i < claims.length; i++) {
      scratch.episodes.append({
        content:    claims[i].value,
        origin:     'observed',
        salience:   1.0,
        hard_keep:  1,
        role:       'user',
        session_id: `replay-${kuCase.question_id}-c${i}`,
        source:     'conversation',
      });
    }
    return {
      question_id:       kuCase.question_id,
      question_type:     kuCase.question_type,
      claim_count:       claims.length,
      dry_run:           true,
      ku_correct:        null,
      tombstones:        0,
      contradicts:       0,
      duplicate_mints:   0,
    };
  } finally {
    scratch.cleanup();
  }
}

/**
 * Consolidate one case: ingest claims, run runConsolidation ONCE, capture judge-engagement,
 * embed the question. Returns the live scratch handle (NOT yet cleaned up), queryVec, and
 * engagement counters. The caller is responsible for calling scratch.cleanup() after all
 * weights for this case have been evaluated.
 *
 * This is the shared first stage for both the legacy single-weight path and the sweep path.
 * runConsolidation is called exactly once here — it must NOT appear in evaluateAtWeight.
 */
async function consolidateCase(kuCase, claims, embedder, anthropicClient) {
  const scratch = makeScratchDb(STRENGTH_WEIGHT);

  // Step 1: ingest each cached claim value as its own episode.
  // replayExtract (below) routes the extract head to return exactly this value
  // so granite/Ollama is never called. Embed+judge run for real.
  for (let i = 0; i < claims.length; i++) {
    scratch.episodes.append({
      content:    claims[i].value,
      origin:     'observed',
      salience:   1.0,
      hard_keep:  1,
      role:       'user',
      session_id: `replay-${kuCase.question_id}-c${i}`,
      source:     'conversation',
    });
  }

  // Step 2: run ONE consolidation pass with the replay extract seam.
  // Each episode's content IS its claim value — the extractor returns exactly
  // [{type:'fact', value: content}] for each, so granite is never invoked.
  // Embed and judge still run for real (the load-bearing RETR-02 signals).
  // IMPORTANT: this call must not be moved inside any per-weight loop.
  await runConsolidation(
    scratch.db,
    scratch.dbPath,
    process.env,
    () => {},  // no-op log callback
    {
      replayExtract(content) {
        // content is the episode content (= the claim value we appended above).
        // Return it as a single fact claim — no re-extraction, no LLM generate call.
        return [{ type: 'fact', value: content }];
      },
    }
  );

  // Step 3: count judge-engagement AFTER the pass.
  const { tombstones, contradicts, duplicateMints } = queryJudgeEngagement(scratch.db);

  // Step 4: embed the question once (weight-independent).
  const [queryVec] = await embedder.embed([kuCase.question]);

  return { scratch, queryVec, tombstones, contradicts, duplicateMints };
}

/**
 * Evaluate one (case, weight, insightSurfacingEnabled) triple over an already-consolidated scratch DB.
 * Builds a fresh RetrievalEngine with the given rankStrengthWeight, runs retrieveRanked,
 * generates the headless answer, scores KU correctness. Pure read on the DB.
 *
 * REFLECT-02 instrumentation (Phase 38-04):
 *   - Counts composeTokens for the assembled payload (chars/4 proxy, EVAL-03 convention).
 *   - When insightSurfacingEnabled=true, attempts to find a live non-stale insight for the
 *     resolved schema and uses it as the compose payload (one string vs K member lines).
 *   - Returns { kuCorrect, hypothesis, composeTokens, usedInsight } for aggregate reporting.
 *
 * MUST NOT call runConsolidation or scratch.cleanup() — those are caller's responsibility.
 */
async function evaluateAtWeight(consolidated, w, kuCase, anthropicClient, insightSurfacingEnabled) {
  const { scratch, queryVec } = consolidated;
  const engine = buildEngineForWeight(scratch, w);

  // Build a SemanticStore on the same scratch DB for insight lookup (insight-ON mode only).
  // SemanticStore is a pure reader here — no writes (T-38-08).
  const store = insightSurfacingEnabled
    ? new SemanticStore(scratch.db, realClock, scratch.config)
    : null;

  // Pass kuCase.question as queryText so retrieveRanked routes through hybridTopk
  // (Pitfall 3 fix — without this arg the pure-cosine topk branch is taken and the
  // strength fusion from rankStrengthWeight / RANK-02 is never exercised).
  const results = engine.retrieveRanked(
    queryVec,
    scratch.config.rankedRetrievalK,
    scratch.config.rankedRetrievalFloor,
    kuCase.question,
  );

  let retrievedText;
  let usedInsight = false;

  // ---- REFLECT-02 insight surfacing (insightSurfacingEnabled=true) ----
  // Mirrors RecallEngine.recall() L306-397: resolve schema from top hit → find live non-stale
  // insight via reverse derived_from in-edge → use insight text as compose payload.
  // On miss or stale: fall through to the K-member neighborhood (same as insight-OFF).
  if (insightSurfacingEnabled && store !== null && results.length > 0) {
    const insightText = findInsightForTopHit(scratch.db, store, results[0]);
    if (insightText !== null) {
      retrievedText = `- ${insightText}`;
      usedInsight = true;
    }
  }

  if (retrievedText === undefined) {
    // No insight found or insight-OFF mode: use the raw K-member neighborhood
    retrievedText = results.length > 0
      ? results.map(r => `- ${r.value}`).join('\n')
      : '(no relevant memory entries found)';
  }

  // Generate answer with Haiku (cheap model; GPT-4o reserved for scorer below).
  const answerPrompt = `I will give you several memory entries from conversations between you and a user. Please answer the question based on the relevant memory entries.\n\n\nMemory Entries:\n\n${retrievedText}\nQuestion: ${kuCase.question}\nAnswer:`;

  // REFLECT-02: count compose tokens for the assembled payload (chars/4 proxy, EVAL-03 convention).
  // T-38-10 (no-inflated-metrics): measured from the actual payload at evaluation time.
  const composeTokens = countComposeTokens(answerPrompt);

  const answerResponse = await anthropicClient.messages.create({
    model:      DEFAULT_CONFIG.anthropicModel,  // claude-haiku-4-5-20251001
    max_tokens: 256,
    messages:   [{ role: 'user', content: answerPrompt }],
  });
  const hypothesis = answerResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  // Score KU correctness with Haiku (autoeval_label 0/1).
  const scorerPrompt = `You are evaluating whether a predicted answer is correct for a knowledge-update question.
Question: ${kuCase.question}
Gold answer: ${kuCase.answer}
Predicted answer: ${hypothesis}
Reply with exactly one word: "correct" or "incorrect".`;

  const scorerResponse = await anthropicClient.messages.create({
    model:      'claude-haiku-4-5-20251001',  // keep cheap; only used here for KU scoring
    max_tokens: 8,
    messages:   [{ role: 'user', content: scorerPrompt }],
  });
  // autoeval_label: 1 = correct, 0 = incorrect
  const verdict = scorerResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
    .toLowerCase();
  const kuCorrect = verdict.includes('correct') && !verdict.includes('incorrect') ? 1 : 0;

  return { kuCorrect, hypothesis, composeTokens, usedInsight };
}

/**
 * Real run (legacy single-weight path): ingest cached claims, runConsolidation ONCE,
 * embed question, evaluate at STRENGTH_WEIGHT, capture judge-engagement.
 *
 * replayExtract: each claim value is appended as its own episode (content = value).
 * runConsolidation intercepts the `generate` head to return [{type:'fact',value:content}]
 * per episode — so embed/judge still run for real (the load-bearing signals).
 *
 * T-26-03: API keys read from env only; never logged or written to results.
 */
async function runRealCase(kuCase, claims, embedder, anthropicClient) {
  let consolidated;
  try {
    consolidated = await consolidateCase(kuCase, claims, embedder, anthropicClient);
  } catch (e) {
    // If consolidation itself fails, return an error result (no scratch to clean up here
    // since consolidateCase cleans up internally only on success — but makeScratchDb is
    // called inside consolidateCase, so a throw there leaks the scratch. Accept this as
    // an error path: the DB file will be cleaned by OS tmpdir lifecycle).
    return {
      question_id:     kuCase.question_id,
      question_type:   kuCase.question_type,
      claim_count:     claims.length,
      dry_run:         false,
      ku_correct:      null,
      tombstones:      null,
      contradicts:     null,
      duplicate_mints: null,
      error:           String(e.message || e).slice(0, 300),
    };
  }

  try {
    const { kuCorrect, hypothesis, composeTokens, usedInsight } = await evaluateAtWeight(
      consolidated, STRENGTH_WEIGHT, kuCase, anthropicClient, false /* insightSurfacingEnabled */
    );
    return {
      question_id:     kuCase.question_id,
      question_type:   kuCase.question_type,
      claim_count:     claims.length,
      dry_run:         false,
      ku_correct:      kuCorrect,
      hypothesis,
      composeTokens,
      used_insight:    usedInsight,
      tombstones:      consolidated.tombstones,
      contradicts:     consolidated.contradicts,
      duplicate_mints: consolidated.duplicateMints,
    };
  } finally {
    consolidated.scratch.cleanup();
  }
}

/**
 * Sweep mode (Phase 35-02): consolidate each case ONCE, then evaluate at every weight
 * in SWEEP_WEIGHTS over the same already-consolidated scratch DB.
 *
 * Per weight: builds a fresh RetrievalEngine with the new rankStrengthWeight (pure read),
 * runs retrieveRanked → headless answer → headless score.
 *
 * runConsolidation is called exactly once per case (inside consolidateCase).
 * scratch.cleanup() is called AFTER all weights for that case are done.
 *
 * Writes one results file per weight: scripts/eval/results/35-sweep-w<w>.json
 * Judge-engagement values (tombstones/contradicts/duplicateMints) are identical
 * across weights (consolidation ran once) — the same captured values are written
 * into every weight's per-case row.
 */
async function runSweep(caseIds, attributionByQid, kuGoldByQid, embedder, anthropicClient, commit, total, totalClaims, embedderModel) {
  const weights = SWEEP_WEIGHTS;
  const resultsDir = path.resolve(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  // Per-weight accumulators: array of per-case rows, ku_correct counts, engagement totals.
  const perWeightRows    = weights.map(() => []);
  const perWeightCorrect = weights.map(() => 0);
  const perWeightTombstones    = weights.map(() => 0);
  const perWeightContradicts   = weights.map(() => 0);
  const perWeightDupMints      = weights.map(() => 0);

  console.log(`\nSweep mode: ${weights.length} weights [${weights.join(', ')}], ${total} cases`);
  console.log('Consolidation runs ONCE per case; retrieve+answer+score re-runs per weight.\n');

  for (const qid of caseIds) {
    const attr   = attributionByQid.get(qid);
    const kuCase = kuGoldByQid.get(qid);

    process.stdout.write(`  [consolidate] ${qid} (${attr.claims.length} claims)...\r`);

    let consolidated;
    let consolidateError = null;
    try {
      consolidated = await consolidateCase(kuCase, attr.claims, embedder, anthropicClient);
      process.stdout.write(`  [consolidate] ${qid} done (tomb=${consolidated.tombstones} contra=${consolidated.contradicts} dup=${consolidated.duplicateMints})\n`);
    } catch (e) {
      consolidateError = String(e.message || e).slice(0, 300);
      console.error(`  [consolidate] ERROR on ${qid}: ${consolidateError}`);
    }

    for (let wi = 0; wi < weights.length; wi++) {
      const w = weights[wi];

      if (consolidateError !== null || consolidated === undefined) {
        // Consolidation failed — record error for all weights.
        perWeightRows[wi].push({
          question_id:     qid,
          question_type:   kuCase.question_type,
          claim_count:     attr.claims.length,
          dry_run:         false,
          ku_correct:      null,
          tombstones:      null,
          contradicts:     null,
          duplicate_mints: null,
          error:           consolidateError,
        });
        continue;
      }

      let kuCorrect = null;
      let hypothesis = null;
      let composeTokens = null;
      let scoreError = null;
      try {
        // Sweep mode does not enable insight surfacing (Phase 35 strength-weight concern only)
        const result = await evaluateAtWeight(consolidated, w, kuCase, anthropicClient, false);
        kuCorrect     = result.kuCorrect;
        hypothesis    = result.hypothesis;
        composeTokens = result.composeTokens;
        process.stdout.write(`  [w=${w}] ${qid}: ${kuCorrect ? 'correct' : 'incorrect'}\n`);
      } catch (e) {
        scoreError = String(e.message || e).slice(0, 300);
        console.error(`  [w=${w}] ERROR scoring ${qid}: ${scoreError}`);
      }

      const row = {
        question_id:     qid,
        question_type:   kuCase.question_type,
        claim_count:     attr.claims.length,
        dry_run:         false,
        ku_correct:      kuCorrect,
        composeTokens,
        tombstones:      consolidated.tombstones,
        contradicts:     consolidated.contradicts,
        duplicate_mints: consolidated.duplicateMints,
      };
      if (hypothesis !== null) row.hypothesis = hypothesis;
      if (scoreError !== null) row.error = scoreError;

      perWeightRows[wi].push(row);
      if (kuCorrect !== null) {
        perWeightCorrect[wi] += kuCorrect;
        perWeightTombstones[wi]  += consolidated.tombstones;
        perWeightContradicts[wi] += consolidated.contradicts;
        perWeightDupMints[wi]    += consolidated.duplicateMints;
      }
    }

    // All weights for this case done — release the scratch DB now.
    if (consolidated) {
      consolidated.scratch.cleanup();
      consolidated = undefined;
    }
  }

  // Write one results file per weight (same schema + paths that 35-strength-sweep.cjs reads).
  for (let wi = 0; wi < weights.length; wi++) {
    const w        = weights[wi];
    const rows     = perWeightRows[wi];
    const scored   = rows.filter(r => r.ku_correct !== null);
    const correct  = perWeightCorrect[wi];
    const kuScore  = scored.length > 0 ? +(correct / scored.length).toFixed(3) : null;

    const envelope = {
      meta: {
        eval:            'replay-ku',
        mode:            'full',
        cache_id:        'granite+chunk-turns-2',
        date:            new Date().toISOString(),
        commit,
        embedder:        embedderModel,
        strength_weight: w,
        total_cases:     total,
        total_claims:    totalClaims,
        sweep_mode:      true,
        sweep_weights:   weights,
        // T-26-03: keys never written to results
      },
      scores: {
        ku_score:              kuScore,
        ku_correct:            correct,
        ku_scored_cases:       scored.length,
        total_tombstones:      perWeightTombstones[wi],
        total_contradicts:     perWeightContradicts[wi],
        total_duplicate_mints: perWeightDupMints[wi],
      },
      per_case: rows,
    };

    // Output path matches what 35-strength-sweep.cjs reads: results/35-sweep-w<w>.json
    const outFile = path.join(resultsDir, `35-sweep-w${w}.json`);
    fs.writeFileSync(outFile, JSON.stringify(envelope, null, 2));
    console.log(`  [w=${w}] written -> ${outFile}  (ku_score: ${kuScore !== null ? (kuScore * 100).toFixed(1) + '%' : 'n/a'})`);
  }
}

// ---- main -------------------------------------------------------------------

(async () => {
  const tStart = Date.now();

  // ---- load cache files -------------------------------------------------------
  if (!fs.existsSync(ATTRIBUTION_FILE)) {
    console.error(`Attribution cache not found: ${ATTRIBUTION_FILE}`);
    console.error(`Expected: ~/.recense-eval-cache/eval01-n20-2026-06-16/n20-attribution.jsonl`);
    process.exit(1);
  }
  if (!fs.existsSync(KU_FILE)) {
    console.error(`KU gold file not found: ${KU_FILE}`);
    console.error(`Expected: ~/.recense-eval-cache/eval01-n20-2026-06-16/eval20-ku.jsonl`);
    process.exit(1);
  }

  const attributionRecords = parseJsonl(ATTRIBUTION_FILE);
  const kuGoldRecords      = parseJsonl(KU_FILE);

  // Build lookup maps
  const attributionByQid = new Map(attributionRecords.map(r => [r.question_id, r]));
  const kuGoldByQid      = new Map(kuGoldRecords.map(r => [r.question_id, r]));

  // Join on question_id: only process cases present in BOTH files.
  // n20-attribution.jsonl has 18 cases; eval20-ku.jsonl has 20 — join gives 18.
  const caseIds = [...attributionByQid.keys()].filter(id => kuGoldByQid.has(id));
  const total   = caseIds.length;

  if (total === 0) {
    console.error('No matching question_ids found between attribution cache and KU gold file.');
    process.exit(1);
  }

  // Resolve current git commit for results metadata
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

  const embedderModel = DEFAULT_CONFIG.openaiEmbedModel;

  console.log('\nReplay-KU Harness (RETR-02 validation, Plan 26-05)');
  console.log(`Cases: ${total} (from n20-attribution.jsonl ∩ eval20-ku.jsonl)`);
  console.log(`Embedder: ${embedderModel} (from DEFAULT_CONFIG — no swap, D-01)`);
  if (SWEEP_WEIGHTS) {
    console.log(`Sweep weights: [${SWEEP_WEIGHTS.join(', ')}] (--sweep-weights; consolidate-once mode)`);
  } else {
    console.log(`Strength weight: ${STRENGTH_WEIGHT} (--strength-weight; 0 = pure cosine baseline)`);
  }
  if (INSIGHT_MODE) {
    console.log(`Insight mode: ON (--insight-mode; runs each case insight-OFF then insight-ON, records composeTokens)`);
  }
  console.log(`Cache: ${CACHE_DIR}`);
  console.log(DRY_RUN
    ? 'Mode: --dry-run (ingest + scratch DB only, ZERO API calls)\n'
    : 'Mode: full run (embed + consolidate + judge + retrieve + score, real API keys)\n');

  // ---- per-case stats (printed in dry-run mode) --------------------------------
  let totalClaims = 0;
  for (const qid of caseIds) {
    const attr = attributionByQid.get(qid);
    console.log(`  ${qid}: ${attr.claims.length} claims`);
    totalClaims += attr.claims.length;
  }
  console.log(`  Total claims across all cases: ${totalClaims}`);

  if (DRY_RUN) {
    // Validate scratch DB lifecycle and claim ingestion with zero API calls.
    // Always uses the legacy single-weight path regardless of --sweep-weights.
    let allOk = true;
    for (const qid of caseIds) {
      const attr    = attributionByQid.get(qid);
      const kuCase  = kuGoldByQid.get(qid);
      try {
        const result = runDryRunCase(kuCase, attr.claims);
        process.stdout.write(`  [dry-run] ${result.question_id}: ${result.claim_count} claims ingested OK\n`);
      } catch (e) {
        console.error(`  [dry-run] ERROR on ${qid}: ${String(e.message || e).slice(0, 200)}`);
        allOk = false;
      }
    }

    // Write dry-run result skeleton to --out
    // REFLECT-02: include composeTokens / insight-mode fields in skeleton so the schema
    // is verifiable with --dry-run (zero API calls). Token counts are null in dry-run.
    const outDir = path.dirname(OUT);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    // REFLECT-02: always include composeTokens field in dry-run skeleton (null = not yet measured).
    // This satisfies the acceptance criterion: dry-run output contains the new token fields.
    // T-38-10: null here is a schema placeholder, not an inflated metric — real run fills it.
    const dryRunMeta = {
      eval:            'replay-ku',
      mode:            'dry-run',
      cache_id:        'granite+chunk-turns-2',
      date:            new Date().toISOString(),
      commit,
      embedder:        embedderModel,
      strength_weight: STRENGTH_WEIGHT,
      total_cases:     total,
      total_claims:    totalClaims,
      composeTokens:   null,  // REFLECT-02: populated by real run (chars/4 proxy)
    };
    if (INSIGHT_MODE) {
      // REFLECT-02 insight-mode fields (null in dry-run; populated by real run)
      // T-38-10: no-inflated-metrics — these are placeholders only; real run fills them
      dryRunMeta.insight_mode             = true;
      dryRunMeta.composeTokensOff         = null;
      dryRunMeta.composeTokensOn          = null;
      dryRunMeta.composeTokenReductionPct = null;
      dryRunMeta.kuScoreOff               = null;
      dryRunMeta.kuScoreOn                = null;
      dryRunMeta.regression               = null;
      dryRunMeta.tolerance_band_pts       = TOLERANCE_BAND_PTS;
    }
    const dryRunResult = {
      meta:     dryRunMeta,
      scores:   null,
      per_case: null,
      note:     'dry-run: no API calls made; run without --dry-run for real scores',
    };
    fs.writeFileSync(OUT, JSON.stringify(dryRunResult, null, 2));
    console.log(`\n[dry-run] Done. ${total} cases validated. Results skeleton -> ${OUT}`);
    if (!allOk) process.exit(1);
    process.exit(0);
  }

  // ---- real run ---------------------------------------------------------------
  // Route answer + inline scorer calls through the headless claude -p transport
  // (subscription-billed, ~$0 marginal cost) when RECENSE_ANSWER_PROVIDER or
  // RECENSE_MODEL_PROVIDER is set to 'claude-headless'; otherwise use the direct
  // Anthropic SDK (preserves maxRetries for 429 self-throttle on the API path).
  const answerOverlay = resolveProviderOverlay(process.env, 'RECENSE_ANSWER_PROVIDER');
  let anthropicClient;
  if (answerOverlay.modelProvider === 'claude-headless') {
    const { client } = createClaudeHeadlessClient({ ...DEFAULT_CONFIG, ...answerOverlay });
    anthropicClient = client;
    console.log('  Answer/scorer transport: claude-headless (subscription-billed via claude -p)');
  } else {
    const Anthropic = require('@anthropic-ai/sdk');
    const harnessMaxRetries = Math.max(1, parseInt(process.env.RECENSE_SDK_MAX_RETRIES || '10', 10) || 10);
    anthropicClient = new Anthropic({ maxRetries: harnessMaxRetries });
  }

  // Embedder constructed from DEFAULT_CONFIG (openaiEmbedModel + embeddingDimensions).
  // Embedder-agnostic: no override flag, no swap (D-01 — swap premise falsified).
  const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DEFAULT_CONFIG.embeddingDimensions);

  // ---- insight mode (Phase 38-04, REFLECT-02): consolidate once per case, evaluate twice ------
  // insight-OFF (insightSurfacingEnabled=false, raw K-member neighborhood) and
  // insight-ON (insightSurfacingEnabled=true, precomputed insight payload when available).
  // Records per-case composeTokensOff/On and aggregate composeTokenReductionPct.
  // No-regression check: regression=true if insight-ON KU score dips > TOLERANCE_BAND_PTS below OFF.
  //
  // This path is MUTUALLY EXCLUSIVE with sweep mode (different phase concerns).
  // T-38-10: all numbers are measured at evaluation time, recorded with meta — no rounded/assumed wins.
  if (INSIGHT_MODE && !(SWEEP_WEIGHTS && SWEEP_WEIGHTS.length > 0)) {
    console.log(`\n=== INSIGHT MODE (REFLECT-02): insight-OFF vs insight-ON compose-token measurement ===`);
    console.log(`    Consolidation runs ONCE per case; evaluation runs twice (OFF then ON).\n`);

    const perCaseOff = [];
    const perCaseOn  = [];
    let kuCorrectOff = 0;
    let kuCorrectOn  = 0;
    let totalComposeTokensOff = 0;
    let totalComposeTokensOn  = 0;
    let totalTombstonesI    = 0;
    let totalContradicts    = 0;
    let totalDuplicateMints = 0;

    console.log('  case         | claims | tomb | OFF-ku | OFF-tok | ON-ku | ON-tok | insight-hit');
    console.log('  ------------ | ------ | ---- | ------ | ------- | ----- | ------ | -----------');

    for (const qid of caseIds) {
      const attr   = attributionByQid.get(qid);
      const kuCase = kuGoldByQid.get(qid);

      process.stdout.write(`  ... consolidating ${qid}...\r`);

      let consolidated;
      let consolidateError = null;
      try {
        consolidated = await consolidateCase(kuCase, attr.claims, embedder, anthropicClient);
      } catch (e) {
        consolidateError = String(e.message || e).slice(0, 300);
        console.error(`  [consolidate] ERROR on ${qid}: ${consolidateError}`);
      }

      if (consolidateError !== null || !consolidated) {
        const errRow = {
          question_id: qid, question_type: kuCase.question_type,
          claim_count: attr.claims.length, dry_run: false, ku_correct: null,
          composeTokens: null, used_insight: false,
          tombstones: null, contradicts: null, duplicate_mints: null,
          error: consolidateError,
        };
        perCaseOff.push(errRow);
        perCaseOn.push({ ...errRow });
        continue;
      }

      // insight-OFF pass
      let offCorrect = null, offTokens = null;
      let offError = null;
      try {
        const r = await evaluateAtWeight(consolidated, STRENGTH_WEIGHT, kuCase, anthropicClient, false);
        offCorrect = r.kuCorrect;
        offTokens  = r.composeTokens;
        if (r.kuCorrect !== null) { kuCorrectOff += r.kuCorrect; totalComposeTokensOff += r.composeTokens; }
        perCaseOff.push({
          question_id: qid, question_type: kuCase.question_type,
          claim_count: attr.claims.length, dry_run: false,
          ku_correct: r.kuCorrect, composeTokens: r.composeTokens,
          used_insight: false,
          tombstones: consolidated.tombstones, contradicts: consolidated.contradicts,
          duplicate_mints: consolidated.duplicateMints,
        });
      } catch (e) {
        offError = String(e.message || e).slice(0, 300);
        perCaseOff.push({
          question_id: qid, question_type: kuCase.question_type,
          claim_count: attr.claims.length, dry_run: false, ku_correct: null,
          composeTokens: null, used_insight: false,
          tombstones: null, contradicts: null, duplicate_mints: null, error: offError,
        });
      }

      // insight-ON pass (same consolidated scratch DB — same graph, same judge-engagement)
      let onCorrect = null, onTokens = null, onHit = false;
      let onError = null;
      try {
        const r = await evaluateAtWeight(consolidated, STRENGTH_WEIGHT, kuCase, anthropicClient, true);
        onCorrect = r.kuCorrect;
        onTokens  = r.composeTokens;
        onHit     = r.usedInsight;
        if (r.kuCorrect !== null) { kuCorrectOn += r.kuCorrect; totalComposeTokensOn += r.composeTokens; }
        perCaseOn.push({
          question_id: qid, question_type: kuCase.question_type,
          claim_count: attr.claims.length, dry_run: false,
          ku_correct: r.kuCorrect, composeTokens: r.composeTokens,
          used_insight: r.usedInsight,
          tombstones: consolidated.tombstones, contradicts: consolidated.contradicts,
          duplicate_mints: consolidated.duplicateMints,
        });
      } catch (e) {
        onError = String(e.message || e).slice(0, 300);
        perCaseOn.push({
          question_id: qid, question_type: kuCase.question_type,
          claim_count: attr.claims.length, dry_run: false, ku_correct: null,
          composeTokens: null, used_insight: false,
          tombstones: null, contradicts: null, duplicate_mints: null, error: onError,
        });
      }

      totalTombstonesI    += consolidated.tombstones    || 0;
      totalContradicts    += consolidated.contradicts   || 0;
      totalDuplicateMints += consolidated.duplicateMints || 0;

      const offKuStr  = offError  ? '  ERR ' : (offCorrect !== null ? (offCorrect ? '  YES ' : '  no  ') : '  n/a ');
      const onKuStr   = onError   ? '  ERR ' : (onCorrect  !== null ? (onCorrect  ? '  YES ' : '  no  ') : '  n/a ');
      const offTokStr = offTokens !== null ? String(offTokens).padStart(7) : '    n/a';
      const onTokStr  = onTokens  !== null ? String(onTokens).padStart(6) : '   n/a';
      const hitStr    = onHit ? 'YES' : 'no ';
      console.log(`  ${qid.padEnd(12)} | ${String(attr.claims.length).padStart(6)} | ${String(consolidated.tombstones).padStart(4)} | ${offKuStr} | ${offTokStr} | ${onKuStr} | ${onTokStr} | ${hitStr}`);

      consolidated.scratch.cleanup();
    }

    // ---- aggregate insight-mode scores -----------------------------------------------
    const scoredCasesOff = perCaseOff.filter(r => r.ku_correct !== null);
    const scoredCasesOn  = perCaseOn.filter(r => r.ku_correct !== null);
    const kuScoreOff = scoredCasesOff.length > 0 ? +(kuCorrectOff / scoredCasesOff.length).toFixed(3) : null;
    const kuScoreOn  = scoredCasesOn.length  > 0 ? +(kuCorrectOn  / scoredCasesOn.length).toFixed(3)  : null;

    const avgComposeTokensOff = scoredCasesOff.length > 0
      ? +(totalComposeTokensOff / scoredCasesOff.length).toFixed(1)
      : null;
    const avgComposeTokensOn  = scoredCasesOn.length  > 0
      ? +(totalComposeTokensOn  / scoredCasesOn.length).toFixed(1)
      : null;

    // REFLECT-02: composeTokenReductionPct = fractional reduction in tokens (insight-ON vs OFF).
    // Positive = fewer tokens (the desired win). T-38-10: measured number, not rounded/assumed.
    const composeTokenReductionPct = (avgComposeTokensOff !== null && avgComposeTokensOn !== null && avgComposeTokensOff > 0)
      ? +(((avgComposeTokensOff - avgComposeTokensOn) / avgComposeTokensOff) * 100).toFixed(2)
      : null;

    // Phase-35 D-07 no-regression check: insight-ON correctness must not fall below insight-OFF
    // by more than TOLERANCE_BAND_PTS (2 percentage points). regression=true if it does.
    let regression = null;
    if (kuScoreOff !== null && kuScoreOn !== null) {
      const offPct = kuScoreOff * 100;
      const onPct  = kuScoreOn  * 100;
      regression = (offPct - onPct) > TOLERANCE_BAND_PTS;
    }

    console.log('\n=== REFLECT-02 INSIGHT-MODE AGGREGATE ===');
    console.log(`  KU score OFF: ${kuScoreOff !== null ? (kuScoreOff * 100).toFixed(1) + '%' : 'n/a'} (${kuCorrectOff}/${scoredCasesOff.length})`);
    console.log(`  KU score ON:  ${kuScoreOn  !== null ? (kuScoreOn  * 100).toFixed(1) + '%' : 'n/a'} (${kuCorrectOn}/${scoredCasesOn.length})`);
    console.log(`  Avg compose tokens OFF: ${avgComposeTokensOff !== null ? avgComposeTokensOff : 'n/a'}`);
    console.log(`  Avg compose tokens ON:  ${avgComposeTokensOn  !== null ? avgComposeTokensOn  : 'n/a'}`);
    console.log(`  Compose token reduction: ${composeTokenReductionPct !== null ? composeTokenReductionPct + '%' : 'n/a'}`);
    console.log(`  No-regression (tolerance band: ${TOLERANCE_BAND_PTS} pts): ${regression === null ? 'n/a' : regression ? 'REGRESSION DETECTED' : 'PASS'}`);
    console.log(`  Total tombstones: ${totalTombstonesI}  |  contradicts: ${totalContradicts}  |  dup-mints: ${totalDuplicateMints}`);

    // ---- write insight-mode results -----------------------------------------------
    const insightResultEnvelope = {
      meta: {
        eval:                    'replay-ku',
        mode:                    'full',
        insight_mode:            true,
        cache_id:                'granite+chunk-turns-2',
        date:                    new Date().toISOString(),
        commit,
        embedder:                embedderModel,
        strength_weight:         STRENGTH_WEIGHT,
        total_cases:             total,
        total_claims:            totalClaims,
        // REFLECT-02 aggregate token / quality metrics
        composeTokensOff:        avgComposeTokensOff,
        composeTokensOn:         avgComposeTokensOn,
        composeTokenReductionPct,
        kuScoreOff,
        kuScoreOn,
        regression,
        tolerance_band_pts:      TOLERANCE_BAND_PTS,
        // T-26-03: keys never written to results
      },
      scores: {
        ku_score_off:              kuScoreOff,
        ku_correct_off:            kuCorrectOff,
        ku_scored_cases_off:       scoredCasesOff.length,
        ku_score_on:               kuScoreOn,
        ku_correct_on:             kuCorrectOn,
        ku_scored_cases_on:        scoredCasesOn.length,
        total_tombstones:          totalTombstonesI,
        total_contradicts:         totalContradicts,
        total_duplicate_mints:     totalDuplicateMints,
      },
      per_case_off: perCaseOff,
      per_case_on:  perCaseOn,
    };

    const outDir = path.dirname(OUT);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(insightResultEnvelope, null, 2));

    const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(`\nInsight-mode results written -> ${OUT}`);
    console.log(`Elapsed: ${elapsedSec}s`);
    process.exit(0);
  }

  // ---- sweep mode (Phase 35-02): consolidate once per case, sweep weights -----
  if (SWEEP_WEIGHTS && SWEEP_WEIGHTS.length > 0) {
    await runSweep(
      caseIds, attributionByQid, kuGoldByQid,
      embedder, anthropicClient,
      commit, total, totalClaims, embedderModel,
    );
    const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(`\nSweep complete. Elapsed: ${elapsedSec}s`);
    process.exit(0);
  }

  // ---- legacy single-weight real run ------------------------------------------
  const perCase = [];
  let totalTombstones    = 0;
  let totalContradicts   = 0;
  let totalDuplicateMints = 0;
  let kuCorrectCount     = 0;
  let totalComposeTokens = 0;
  let composeTokenCases  = 0;

  console.log('\n  case         | claims | ku | tomb | contradict | dup-mints | compose-tok');
  console.log('  ------------ | ------ | -- | ---- | ---------- | --------- | -----------');

  for (const qid of caseIds) {
    const attr   = attributionByQid.get(qid);
    const kuCase = kuGoldByQid.get(qid);

    process.stdout.write(`  ... running ${qid}...\r`);

    let result;
    try {
      result = await runRealCase(kuCase, attr.claims, embedder, anthropicClient);
    } catch (e) {
      result = {
        question_id:     qid,
        question_type:   kuCase.question_type,
        claim_count:     attr.claims.length,
        dry_run:         false,
        ku_correct:      null,
        tombstones:      null,
        contradicts:     null,
        duplicate_mints: null,
        error:           String(e.message || e).slice(0, 300),
      };
    }

    perCase.push(result);

    if (result.ku_correct !== null)      kuCorrectCount     += result.ku_correct;
    if (result.tombstones !== null)      totalTombstones    += result.tombstones;
    if (result.contradicts !== null)     totalContradicts   += result.contradicts;
    if (result.duplicate_mints !== null) totalDuplicateMints += result.duplicate_mints;
    if (result.composeTokens  !== null && result.composeTokens !== undefined) {
      totalComposeTokens += result.composeTokens;
      composeTokenCases++;
    }

    const kuStr     = result.error ? 'ERR' : result.ku_correct ? 'YES' : 'no ';
    const tombStr   = result.tombstones  !== null ? String(result.tombstones).padStart(4)  : ' ERR';
    const contrStr  = result.contradicts !== null ? String(result.contradicts).padStart(10) : '       ERR';
    const dupStr    = result.duplicate_mints !== null ? String(result.duplicate_mints).padStart(9) : '      ERR';
    const tokStr    = result.composeTokens   !== undefined && result.composeTokens !== null
      ? String(result.composeTokens).padStart(11) : '        n/a';
    console.log(`  ${qid.padEnd(12)} | ${String(result.claim_count).padStart(6)} | ${kuStr} | ${tombStr} | ${contrStr} | ${dupStr} | ${tokStr}`);
  }

  // ---- aggregate scores -------------------------------------------------------
  const scoredCases = perCase.filter(r => r.ku_correct !== null);
  const kuScore     = scoredCases.length > 0
    ? +(kuCorrectCount / scoredCases.length).toFixed(3)
    : null;

  const avgComposeTokens = composeTokenCases > 0
    ? +(totalComposeTokens / composeTokenCases).toFixed(1)
    : null;

  console.log('\n=== JUDGE-ENGAGEMENT AGGREGATE ===');
  console.log(`  KU score:            ${kuScore !== null ? (kuScore * 100).toFixed(1) + '%' : 'n/a'} (${kuCorrectCount}/${scoredCases.length})`);
  console.log(`  Total tombstones:    ${totalTombstones}`);
  console.log(`  Total contradicts:   ${totalContradicts}  (judge fired: claim contradicted existing belief)`);
  console.log(`  Total dup-mints:     ${totalDuplicateMints}  (unrelated: new node despite near-dup candidate — RETR-02 target)`);
  console.log(`  Avg compose tokens:  ${avgComposeTokens !== null ? avgComposeTokens : 'n/a'}  (chars/4 proxy — EVAL-03 convention)`);
  console.log(`  Embedder model:      ${embedderModel}`);

  // ---- write results ----------------------------------------------------------
  const resultEnvelope = {
    meta: {
      eval:            'replay-ku',
      mode:            'full',
      cache_id:        'granite+chunk-turns-2',
      date:            new Date().toISOString(),
      commit,
      embedder:        embedderModel,
      strength_weight: STRENGTH_WEIGHT,
      total_cases:     total,
      total_claims:    totalClaims,
      composeTokens:   avgComposeTokens,
      // T-26-03: keys never written to results
    },
    scores: {
      ku_score:              kuScore,
      ku_correct:            kuCorrectCount,
      ku_scored_cases:       scoredCases.length,
      total_tombstones:      totalTombstones,
      total_contradicts:     totalContradicts,
      total_duplicate_mints: totalDuplicateMints,
    },
    per_case: perCase,
  };

  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));

  const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\nResults written -> ${OUT}`);
  console.log(`Elapsed: ${elapsedSec}s`);
})();
