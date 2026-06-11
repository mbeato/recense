/**
 * LongMemEval-S harness (EVAL-01) — end-to-end: ingest -> sleep pass -> retrieve -> answer.
 *
 * Run from the repo root (requires a prior `npm run build`):
 *
 *   # Full run against the downloaded dataset
 *   NODE_PATH=$(pwd)/node_modules \
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
 *   node scripts/eval/longmemeval-harness.cjs \
 *     --eval scripts/eval/longmemeval-s.jsonl \
 *     --out scripts/eval/results/longmemeval-hypotheses-PENDING.jsonl
 *
 *   # Probe mode: run 10 questions, print $/question, exit — do NOT proceed to full run
 *   node scripts/eval/longmemeval-harness.cjs --probe
 *
 *   # Dry-run mode: zero API calls, validates fixture parsing + scratch DB
 *   node scripts/eval/longmemeval-harness.cjs --dry-run
 *
 *   # Concurrency: bound parallel workers (default 8, min 1)
 *   node scripts/eval/longmemeval-harness.cjs --concurrency 16
 *
 *   # Resume: if OUT_FILE already exists, question_ids already present are skipped
 *   node scripts/eval/longmemeval-harness.cjs --out results/my-run.jsonl
 *   # (re-running appends only the missing questions; error lines also count as done)
 *
 * Dataset download (NOT committed — ~3 GB):
 *   curl -L "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.jsonl" \
 *        -o scripts/eval/longmemeval-s.jsonl
 *
 * Key requirements:
 *  - Every question runs on a fresh scratch DB; the live brain.db env var is never read (T-14-DB).
 *  - Answer generation uses claude-haiku (cheap); GPT-4o is reserved for the scorer.
 *  - runConsolidation() is called ONCE per question, AFTER all session appends (Pitfall 4).
 *  - --probe runs exactly 10 questions, reports $/question and wall-clock, then exits 0.
 *  - --dry-run reads the mini fixture, skips all LLM steps, writes fixed answers, exits 0.
 *  - Each completed question is appended to OUT_FILE immediately (incremental output).
 *  - On startup, existing OUT_FILE is parsed; already-present question_ids are skipped.
 *    Error lines written by a prior run also count as done for resume purposes.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// npm packages (already in package.json)
const Anthropic = require('@anthropic-ai/sdk');

// Engine internals — require dist (run `npm run build` before this script).
// Paths are relative to the repo root because this script runs via `node scripts/eval/...`
// from the repo root, and the dist/ dir is at the root level.
const DIST = require('path').resolve(__dirname, '../../dist/src');
const { initSchema }            = require(DIST + '/db/schema');
const { EpisodicStore }         = require(DIST + '/db/episode-store');
const { realClock }             = require(DIST + '/lib/clock');
const { DEFAULT_CONFIG }        = require(DIST + '/lib/config');
const { runConsolidation }      = require(DIST + '/consolidation/run-sleep-pass');
const { RetrievalEngine }       = require(DIST + '/retrieval/engine');
const { CandidateRetriever }    = require(DIST + '/retrieval/topk');
const { SemanticStore }         = require(DIST + '/db/semantic-store');
const { StrengthDecayManager }  = require(DIST + '/strength/decay');
const { AllocationGate }        = require(DIST + '/gate/allocation-gate');
const { OpenAIEmbedder }        = require(DIST + '/model/embedder');
const { NoopActivationTraceSink } = require(DIST + '/viz/activation-sink');
const Database                  = require('better-sqlite3');

// ---- arg parsing ------------------------------------------------------------

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i !== -1 ? process.argv[i + 1] : d;
};

const IS_DRY_RUN = process.argv.includes('--dry-run');
const IS_PROBE   = process.argv.includes('--probe');

// --concurrency N (default 8, min 1). Each question has its own scratch DB and no
// shared state, so in-process parallelism is safe. Probe token accumulation uses
// plain += after each await — safe because Node.js is single-threaded.
const CONCURRENCY = Math.max(1, parseInt(arg('--concurrency', '8'), 10) || 8);

// --dry-run defaults to the committed mini fixture; normal/probe default to the downloaded dataset
const EVAL_DEFAULT = IS_DRY_RUN
  ? 'scripts/eval/fixtures/longmemeval-mini.jsonl'
  : 'scripts/eval/longmemeval-s.jsonl';

const EVAL_FILE = arg('--eval', EVAL_DEFAULT);
const OUT_FILE  = arg('--out', 'scripts/eval/results/longmemeval-hypotheses-PENDING.jsonl');

const PROBE_LIMIT = 10;

// Approximate Haiku 4.5 pricing (USD per million tokens) — used for probe cost estimation only
const HAIKU_INPUT_COST_PER_M  = 0.80;
const HAIKU_OUTPUT_COST_PER_M = 4.00;

const ANSWER_MODEL = DEFAULT_CONFIG.anthropicModel; // claude-haiku-4-5-20251001

const DRY_RUN_STUB_ANSWER = 'dry-run-stub-answer';

// ---- scratch DB factory -----------------------------------------------------

/**
 * Creates a unique temp-file SQLite DB, initialises the schema, and returns
 * an object with the db instance, path, pre-wired EpisodicStore, and cleanup().
 * NEVER touches the live brain.db path — always a fresh isolated temp path (T-14-DB).
 */
function makeScratchDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `brain-eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, realClock, config);
  return {
    db,
    dbPath,
    episodes,
    cleanup() {
      try { db.close(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
    },
  };
}

// ---- retrieval engine factory -----------------------------------------------

/**
 * Wires a RetrievalEngine over an already-consolidated DB.
 * Pattern verbatim from src/adapter/memory-ops.ts ~L213-219.
 */
function buildRetrievalEngine(db, dbPath) {
  const config    = { ...DEFAULT_CONFIG, dbPath };
  const retriever = new CandidateRetriever(db);
  const store     = new SemanticStore(db, realClock, config);
  const strength  = new StrengthDecayManager(db, realClock, config);
  const gate      = new AllocationGate(config);
  const traceSink = new NoopActivationTraceSink();
  return new RetrievalEngine(db, realClock, config, retriever, store, strength, gate, traceSink);
}

// ---- dataset helpers --------------------------------------------------------

/**
 * Parses JSONL: one JSON object per line, skipping blank lines.
 * Defensive: wraps parse errors in per-line try/catch (T-14-DSV).
 */
function parseJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch (e) {
      console.error(`[warn] Skipping malformed JSONL line ${i + 1}: ${String(e.message || e).slice(0, 100)}`);
    }
  }
  return out;
}

/**
 * Concatenates all turns in a haystack session into a single content string
 * suitable for EpisodicStore.append().
 */
function formatSession(session) {
  return session
    .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');
}

// ---- bounded concurrency pool -----------------------------------------------

/**
 * Runs fn(item) for each item in items, with at most `concurrency` in-flight at once.
 * Items are processed in queue order; workers race to grab the next item.
 * Node.js single-threaded event loop guarantees idx++ is atomic between awaits.
 */
async function runBoundedPool(items, concurrency, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// ---- main -------------------------------------------------------------------

(async () => {
  const tStart = Date.now();

  // ---- key guards (non-dry-run only) ----------------------------------------
  if (!IS_DRY_RUN) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not set — required for answer generation (use --dry-run for zero-API mode)');
      process.exit(1);
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY not set — required for question embedding (use --dry-run for zero-API mode)');
      process.exit(1);
    }
  }

  // ---- load dataset ---------------------------------------------------------
  if (!fs.existsSync(EVAL_FILE)) {
    console.error(`Dataset not found: ${EVAL_FILE}`);
    if (!IS_DRY_RUN) {
      console.error('Download LongMemEval-S with:');
      console.error('  curl -L "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.jsonl" -o scripts/eval/longmemeval-s.jsonl');
    }
    process.exit(1);
  }

  const allQuestions = parseJsonl(EVAL_FILE);
  if (!allQuestions.length) {
    console.error(`No questions found in ${EVAL_FILE}`);
    process.exit(1);
  }

  const limit     = IS_PROBE ? PROBE_LIMIT : allQuestions.length;
  const questions = allQuestions.slice(0, limit);

  // ---- resume: skip question_ids already present in OUT_FILE ----------------
  // Error lines written by prior runs also count as done — prevents retrying
  // a deterministically-failing question on every resume (T-14-DSV).
  const doneIds = new Set();
  if (fs.existsSync(OUT_FILE)) {
    const existingLines = fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(l => l.trim());
    for (const line of existingLines) {
      try {
        const rec = JSON.parse(line);
        if (rec.question_id) doneIds.add(rec.question_id);
      } catch {}
    }
    if (doneIds.size > 0) {
      console.log(`[resume] Skipping ${doneIds.size} already-complete question(s) (errors count as done)`);
    }
  }

  const pendingQuestions = questions.filter(q => !doneIds.has(q.question_id));

  if (IS_DRY_RUN) {
    console.log(`[dry-run] Loaded ${questions.length} question(s) from ${EVAL_FILE} (zero API mode, ${pendingQuestions.length} pending)`);
  } else if (IS_PROBE) {
    console.log(`[probe] Running ${pendingQuestions.length} questions to estimate cost and latency`);
  } else {
    console.log(`Running ${pendingQuestions.length} pending question(s) from ${EVAL_FILE} (concurrency=${CONCURRENCY})`);
  }

  // ---- output dir setup -----------------------------------------------------
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  // ---- probe tracking (race-safe: += after each await, Node is single-threaded)
  const probeStats = { inputTokens: 0, outputTokens: 0 };

  // ---- embedder (real mode only) -------------------------------------------
  const embedder = IS_DRY_RUN
    ? null
    : new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DEFAULT_CONFIG.embeddingDimensions);

  // ---- anthropic client (real mode only) ------------------------------------
  const anthropicClient = IS_DRY_RUN ? null : new Anthropic();

  // ---- telemetry state (shared across workers, safe: += after await) --------
  let completedCount = 0;
  const wallStart = Date.now();

  // ---- per-question pipeline ------------------------------------------------
  async function processQuestion(q) {
    const qStart = Date.now();
    const questionId   = q.question_id;
    const questionType = q.question_type;
    const questionText = q.question;
    const haystackSessions = Array.isArray(q.haystack_sessions) ? q.haystack_sessions : [];

    const scratch = makeScratchDb();
    let result;

    try {
      if (IS_DRY_RUN) {
        // Dry-run: append episodes for schema validation, skip all LLM steps
        for (let i = 0; i < haystackSessions.length; i++) {
          const session = haystackSessions[i];
          scratch.episodes.append({
            content:    formatSession(session),
            origin:     'observed',
            salience:   1.0,
            hard_keep:  1,
            role:       'user',
            session_id: `${questionId}-s${i}`,
          });
        }
        result = { question_id: questionId, question_type: questionType, hypothesis: DRY_RUN_STUB_ANSWER };
      } else {
        // Real mode: full pipeline

        // Step 1: ingest ALL haystack sessions as episodes (one episode per session)
        for (let i = 0; i < haystackSessions.length; i++) {
          const session = haystackSessions[i];
          scratch.episodes.append({
            content:    formatSession(session),
            origin:     'observed',
            salience:   1.0,
            hard_keep:  1,
            role:       'user',
            session_id: `${questionId}-s${i}`,
          });
        }

        // Step 2: run ONE sleep pass AFTER all appends (Pitfall 4)
        await runConsolidation(
          scratch.db,
          scratch.dbPath,
          process.env,
          (_msg) => {} // suppress sleep-pass logs; use stderr if debugging
        );

        // Step 3: embed the question
        const [queryVec] = await embedder.embed([questionText]);

        // Step 4: build retrieval engine and retrieve
        const engine = buildRetrievalEngine(scratch.db, scratch.dbPath);
        const retrieval = queryVec
          ? engine.retrieve(queryVec)
          : engine.retrieveCueless();

        // Step 5: format retrieved nodes for the answer-gen prompt
        const retrievedText = retrieval.results.length > 0
          ? retrieval.results.map(r => `- ${r.value}`).join('\n')
          : '(no relevant memory entries found)';

        // Step 6: generate answer with Haiku (cheap model — GPT-4o reserved for scorer)
        const answerPrompt = `Given these memory entries:\n${retrievedText}\n\nAnswer this question: ${questionText}\n\nAnswer with just the factual answer, no explanation.`;
        const answerResponse = await anthropicClient.messages.create({
          model:      ANSWER_MODEL,
          max_tokens: 256,
          messages:   [{ role: 'user', content: answerPrompt }],
        });
        const hypothesis = answerResponse.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('')
          .trim();

        // Accumulate probe tokens (race-safe: += after await, Node single-threaded)
        if (IS_PROBE && answerResponse.usage) {
          probeStats.inputTokens  += answerResponse.usage.input_tokens  || 0;
          probeStats.outputTokens += answerResponse.usage.output_tokens || 0;
        }

        result = { question_id: questionId, question_type: questionType, hypothesis };
      }
    } catch (e) {
      // Per-question failure: record error, continue batch (T-14-DSV)
      result = { question_id: questionId, question_type: questionType, error: String(e.message || e).slice(0, 300) };
    } finally {
      scratch.cleanup();
    }

    // Append result immediately (incremental output — safe: fs.appendFileSync is synchronous)
    fs.appendFileSync(OUT_FILE, JSON.stringify(result) + '\n');

    // Telemetry to stderr: question_id, elapsed, running ETA
    const elapsedSec = (Date.now() - qStart) / 1000;
    completedCount++;
    const wallElapsedMs = Date.now() - wallStart;
    const avgMsPerQ = wallElapsedMs / completedCount;
    const remaining = pendingQuestions.length - completedCount;
    const etaSec = Math.round((remaining * avgMsPerQ) / 1000);
    process.stderr.write(
      `[${questionId}] ${elapsedSec.toFixed(1)}s | ETA ~${etaSec}s (${completedCount}/${pendingQuestions.length})\n`
    );
  }

  // ---- run the pool ---------------------------------------------------------
  if (pendingQuestions.length > 0) {
    await runBoundedPool(pendingQuestions, CONCURRENCY, processQuestion);
  }

  // ---- summary --------------------------------------------------------------
  const totalInFile = doneIds.size + completedCount;
  const elapsedMs = Date.now() - tStart;

  if (IS_DRY_RUN) {
    console.log(`[dry-run] Done. ${completedCount} new result(s) appended to ${OUT_FILE} (${totalInFile} total, ${doneIds.size} skipped). Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
    process.exit(0);
  }

  if (IS_PROBE) {
    // Probe cost report (answer-gen tokens only; consolidation costs tracked via API billing)
    const inputCost  = (probeStats.inputTokens  / 1_000_000) * HAIKU_INPUT_COST_PER_M;
    const outputCost = (probeStats.outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
    const totalCost  = inputCost + outputCost;
    const perQuestion = completedCount > 0 ? totalCost / completedCount : 0;
    const elapsedMin  = elapsedMs / 60_000;
    console.log(`\nProbe: ${completedCount} questions, $${totalCost.toFixed(4)} total (answer-gen only), ~$${perQuestion.toFixed(4)}/question, ~${elapsedMin.toFixed(1)} min`);
    console.log('Note: consolidation costs (extraction + judge calls) are not measured here — check your API billing for the full cost.');
    console.log(`Re-run without --probe to evaluate the full set.`);
    process.exit(0);
  }

  console.log(`Done. ${completedCount} new result(s) appended to ${OUT_FILE} (${totalInFile} total, ${doneIds.size} skipped). Elapsed: ${(elapsedMs / 1000).toFixed(1)}s | ${completedCount > 0 ? (elapsedMs / completedCount / 1000).toFixed(2) : 'n/a'}s/question`);
})();
