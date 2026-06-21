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
const { runConsolidation }        = require('../../dist/src/consolidation/run-sleep-pass');
const { OpenAIEmbedder }          = require('../../dist/src/model/embedder');

// ---- API key guard (real runs only) -----------------------------------------
if (!DRY_RUN) {
  const missing = [];
  if (!process.env.OPENAI_API_KEY)    missing.push('OPENAI_API_KEY');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    console.error(`\nERROR: missing keys for a real run: ${missing.join(', ')}`);
    console.error('Pass --dry-run to validate cache parsing + scratch DB with zero API calls.');
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

function makeScratchDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `replay-ku-eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(dbPath);
  initSchema(db);
  // rankStrengthWeight: inject --strength-weight so engine.retrieveRanked → hybridTopk reads it.
  const config = { ...DEFAULT_CONFIG, dbPath, rankStrengthWeight: STRENGTH_WEIGHT };
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
  const scratch = makeScratchDb();
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
 * Real run: ingest cached claims as episodes via a replayExtract seam, call
 * runConsolidation once (embed+judge for real; no granite re-extraction), then
 * embed the question and retrieve via retrieveRanked. Score KU correctness with
 * GPT-4o-2024-08-06 and capture judge-engagement.
 *
 * replayExtract: each claim value is appended as its own episode (content = value).
 * runConsolidation intercepts the `generate` head to return [{type:'fact',value:content}]
 * per episode — so embed/judge still run for real (the load-bearing signals).
 *
 * T-26-03: API keys read from env only; never logged or written to results.
 */
async function runRealCase(kuCase, claims, embedder, anthropicClient) {
  const scratch = makeScratchDb();
  try {
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

    // Step 4: embed the question and retrieve via retrieveRanked (the product memory_ask path).
    // NOT raw retrieve() (which has a 0.7 single-hit gate calibrated for production injection).
    const [queryVec] = await embedder.embed([kuCase.question]);

    const retriever  = new CandidateRetriever(scratch.db);
    const store      = new SemanticStore(scratch.db, realClock, scratch.config);
    const strength   = new StrengthDecayManager(scratch.db, realClock, scratch.config);
    const gate       = new AllocationGate(scratch.config);
    const traceSink  = new NoopActivationTraceSink();
    const engine     = new RetrievalEngine(scratch.db, realClock, scratch.config, retriever, store, strength, gate, traceSink);

    // Pass kuCase.question as queryText so retrieveRanked routes through hybridTopk
    // (Pitfall 3 fix — without this arg the pure-cosine topk branch is taken and the
    // strength fusion from rankStrengthWeight / RANK-02 is never exercised).
    const results = engine.retrieveRanked(queryVec, scratch.config.rankedRetrievalK, scratch.config.rankedRetrievalFloor, kuCase.question);

    const retrievedText = results.length > 0
      ? results.map(r => `- ${r.value}`).join('\n')
      : '(no relevant memory entries found)';

    // Step 5: generate answer with Haiku (cheap model; GPT-4o reserved for scorer below).
    const answerPrompt = `I will give you several memory entries from conversations between you and a user. Please answer the question based on the relevant memory entries.\n\n\nMemory Entries:\n\n${retrievedText}\nQuestion: ${kuCase.question}\nAnswer:`;
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

    // Step 6: score KU correctness with GPT-4o-2024-08-06 (autoeval_label 0/1).
    // Same scorer shape as longmemeval-harness.cjs — returns 1 if the answer is correct.
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

    return {
      question_id:     kuCase.question_id,
      question_type:   kuCase.question_type,
      claim_count:     claims.length,
      dry_run:         false,
      ku_correct:      kuCorrect,
      hypothesis,
      tombstones,
      contradicts,
      duplicate_mints: duplicateMints,
    };
  } finally {
    scratch.cleanup();
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
  console.log(`Strength weight: ${STRENGTH_WEIGHT} (--strength-weight; 0 = pure cosine baseline)`);
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
    const outDir = path.dirname(OUT);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const dryRunResult = {
      meta: {
        eval:            'replay-ku',
        mode:            'dry-run',
        cache_id:        'granite+chunk-turns-2',
        date:            new Date().toISOString(),
        commit,
        embedder:        embedderModel,
        strength_weight: STRENGTH_WEIGHT,
        total_cases:     total,
        total_claims:    totalClaims,
      },
      scores: null,
      per_case: null,
      note: 'dry-run: no API calls made; run without --dry-run for real scores',
    };
    fs.writeFileSync(OUT, JSON.stringify(dryRunResult, null, 2));
    console.log(`\n[dry-run] Done. ${total} cases validated. Results skeleton -> ${OUT}`);
    if (!allOk) process.exit(1);
    process.exit(0);
  }

  // ---- real run ---------------------------------------------------------------
  const Anthropic = require('@anthropic-ai/sdk');
  const harnessMaxRetries = Math.max(1, parseInt(process.env.RECENSE_SDK_MAX_RETRIES || '10', 10) || 10);
  const anthropicClient = new Anthropic({ maxRetries: harnessMaxRetries });

  // Embedder constructed from DEFAULT_CONFIG (openaiEmbedModel + embeddingDimensions).
  // Embedder-agnostic: no override flag, no swap (D-01 — swap premise falsified).
  const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DEFAULT_CONFIG.embeddingDimensions);

  const perCase = [];
  let totalTombstones    = 0;
  let totalContradicts   = 0;
  let totalDuplicateMints = 0;
  let kuCorrectCount     = 0;

  console.log('\n  case         | claims | ku | tomb | contradict | dup-mints');
  console.log('  ------------ | ------ | -- | ---- | ---------- | ---------');

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

    const kuStr    = result.error ? 'ERR' : result.ku_correct ? 'YES' : 'no ';
    const tombStr  = result.tombstones  !== null ? String(result.tombstones).padStart(4)  : ' ERR';
    const contrStr = result.contradicts !== null ? String(result.contradicts).padStart(10) : '       ERR';
    const dupStr   = result.duplicate_mints !== null ? String(result.duplicate_mints).padStart(9) : '      ERR';
    console.log(`  ${qid.padEnd(12)} | ${String(result.claim_count).padStart(6)} | ${kuStr} | ${tombStr} | ${contrStr} | ${dupStr}`);
  }

  // ---- aggregate scores -------------------------------------------------------
  const scoredCases = perCase.filter(r => r.ku_correct !== null);
  const kuScore     = scoredCases.length > 0
    ? +(kuCorrectCount / scoredCases.length).toFixed(3)
    : null;

  console.log('\n=== JUDGE-ENGAGEMENT AGGREGATE ===');
  console.log(`  KU score:            ${kuScore !== null ? (kuScore * 100).toFixed(1) + '%' : 'n/a'} (${kuCorrectCount}/${scoredCases.length})`);
  console.log(`  Total tombstones:    ${totalTombstones}`);
  console.log(`  Total contradicts:   ${totalContradicts}  (judge fired: claim contradicted existing belief)`);
  console.log(`  Total dup-mints:     ${totalDuplicateMints}  (unrelated: new node despite near-dup candidate — RETR-02 target)`);
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
      // T-26-03: keys never written to results
    },
    scores: {
      ku_score:            kuScore,
      ku_correct:          kuCorrectCount,
      ku_scored_cases:     scoredCases.length,
      total_tombstones:    totalTombstones,
      total_contradicts:   totalContradicts,
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
