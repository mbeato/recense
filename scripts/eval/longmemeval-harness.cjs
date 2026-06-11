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
 *   # Concurrency: bound parallel workers (default 4, min 1; raise only after error-free probe)
 *   node scripts/eval/longmemeval-harness.cjs --concurrency 8
 *
 *   # Top-K: override number of retrieved nodes fed into the answer prompt (default 10)
 *   node scripts/eval/longmemeval-harness.cjs --topk 20
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

// ---- SDK retry budget (must be set BEFORE loading dist modules) -------------
// anthropic-client.ts reads BRAIN_MEMORY_SDK_MAX_RETRIES at module-load time.
// 10 retries + SDK-native retry-after backoff = self-throttling under 429 load.
// Set only if the caller has not already overridden it.
if (!process.env.BRAIN_MEMORY_SDK_MAX_RETRIES) {
  process.env.BRAIN_MEMORY_SDK_MAX_RETRIES = '10';
}

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

const IS_DRY_RUN     = process.argv.includes('--dry-run');
const IS_PROBE       = process.argv.includes('--probe');
const RETRY_ERRORS   = process.argv.includes('--retry-errors');

// --concurrency N (default 4, min 1). Each question has its own scratch DB and no
// shared state, so in-process parallelism is safe. Probe token accumulation uses
// plain += after each await — safe because Node.js is single-threaded.
// Start at 4; raise only after a probe completes with 0 errors AND 0 quarantines.
// At concurrency 8+ the Anthropic API returns 70-80% 429s even with 10 retries.
const CONCURRENCY = Math.max(1, parseInt(arg('--concurrency', '4'), 10) || 4);

// --topk N: number of top-k nodes to retrieve for the answer-gen prompt (default 10).
// The production hook-injection wrapper (RetrievalEngine.retrieve) gates on cosine >= 0.7
// and returns at most 1 result — correct for production injection, wrong for QA benchmarking.
// Here we use CandidateRetriever.topk directly so every question gets up to K candidates.
const TOP_K = Math.max(1, parseInt(arg('--topk', '10'), 10) || 10);

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
 * Parse a LongMemEval haystack_date string to milliseconds since epoch.
 * Handles both ISO-like "2023/05/20 02:21" and annotated "2023/05/20 (Sat) 02:21" formats.
 * Returns null on parse failure so callers fall back to clock.nowMs().
 */
function parseSessionDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  // Strip day-of-week annotation: "(Sat)", "(Mon)", etc.
  const cleaned = dateStr.replace(/\s*\([A-Za-z]+\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  // Normalise date separators: "2023/05/20 02:21" -> "2023-05-20 02:21"
  const normalized = cleaned.replace(/\//g, '-');
  const ms = Date.parse(normalized);
  return isNaN(ms) ? null : ms;
}

/**
 * Concatenates all turns in a haystack session into a single content string
 * suitable for EpisodicStore.append(). Optionally prefixes with the session date
 * so temporal-reasoning and knowledge-update questions see chronological context.
 *
 * @param {Array}  session  Array of {role, content} turn objects.
 * @param {string} [date]   Optional date string from haystack_dates[i]. If provided
 *                          (and non-empty), the first line of the output is
 *                          "[Session date: {date}]". Omitted when date is falsy
 *                          so fixture rows without the field are handled gracefully.
 */
function formatSession(session, date) {
  const turns = session
    .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');
  return date ? `[Session date: ${date}]\n${turns}` : turns;
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
  // By default, error lines written by prior runs count as done — prevents
  // silently retrying a deterministically-failing question on every resume.
  // Pass --retry-errors to re-attempt questions whose existing line has an
  // `error` field (the error lines are dropped from OUT_FILE at startup so
  // the fresh result supersedes them).
  const doneIds  = new Set();
  const errorIds = new Set();
  if (fs.existsSync(OUT_FILE)) {
    const existingLines = fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(l => l.trim());
    for (const line of existingLines) {
      try {
        const rec = JSON.parse(line);
        if (rec.question_id) {
          if (rec.error) {
            errorIds.add(rec.question_id);
          } else {
            doneIds.add(rec.question_id);
          }
        }
      } catch {}
    }

    if (RETRY_ERRORS && errorIds.size > 0) {
      // Drop error lines from OUT_FILE so fresh results can be appended
      const keptLines = existingLines.filter(line => {
        try {
          const rec = JSON.parse(line);
          return !(rec.error && rec.question_id && errorIds.has(rec.question_id));
        } catch { return true; }
      });
      fs.writeFileSync(OUT_FILE, keptLines.map(l => l + '\n').join(''));
      console.log(`[retry-errors] Dropped ${errorIds.size} error line(s) from ${OUT_FILE} — will retry`);
    } else {
      // Default: error lines count as done (don't retry)
      for (const id of errorIds) doneIds.add(id);
    }

    const totalSkipped = RETRY_ERRORS ? doneIds.size : doneIds.size;
    if (totalSkipped > 0 || (!RETRY_ERRORS && errorIds.size > 0)) {
      const errNote = !RETRY_ERRORS && errorIds.size > 0
        ? ` (${errorIds.size} error line(s) counted as done; use --retry-errors to re-attempt)`
        : '';
      console.log(`[resume] Skipping ${totalSkipped} already-complete question(s)${errNote}`);
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
  // Pass maxRetries explicitly so the answer-gen client also benefits from the
  // higher retry budget set above (SDK reads env at construction time only for
  // the Anthropic SDK default, but we pass it here to be explicit and consistent
  // with what the dist modules use via SDK_MAX_RETRIES).
  const harnessMaxRetries = Math.max(1, parseInt(process.env.BRAIN_MEMORY_SDK_MAX_RETRIES || '10', 10) || 10);
  const anthropicClient = IS_DRY_RUN ? null : new Anthropic({ maxRetries: harnessMaxRetries });

  // ---- telemetry state (shared across workers, safe: += after await) --------
  let completedCount = 0;
  const wallStart = Date.now();

  // ---- per-question pipeline ------------------------------------------------
  async function processQuestion(q) {
    const qStart = Date.now();
    const questionId      = q.question_id;
    const questionType    = q.question_type;
    const questionText    = q.question;
    const questionDate    = q.question_date || '';
    const haystackSessions = Array.isArray(q.haystack_sessions) ? q.haystack_sessions : [];
    // haystack_dates is index-parallel to haystack_sessions; tolerate missing field
    const haystackDates   = Array.isArray(q.haystack_dates) ? q.haystack_dates : [];

    const scratch = makeScratchDb();
    let result;

    try {
      if (IS_DRY_RUN) {
        // Dry-run: append episodes for schema validation, skip all LLM steps
        for (let i = 0; i < haystackSessions.length; i++) {
          const session  = haystackSessions[i];
          const dateStr  = haystackDates[i] || null;
          const tsMs     = parseSessionDate(dateStr);
          scratch.episodes.append({
            content:    formatSession(session, dateStr),
            origin:     'observed',
            salience:   1.0,
            hard_keep:  1,
            role:       'user',
            source:     'conversation',
            session_id: `${questionId}-s${i}`,
            ...(tsMs != null ? { ts: tsMs } : {}),
          });
        }
        result = { question_id: questionId, question_type: questionType, hypothesis: DRY_RUN_STUB_ANSWER };
      } else {
        // Real mode: full pipeline

        // Step 1: ingest ALL haystack sessions as episodes (one episode per session).
        // haystack_dates[i] is prefixed into the content and used as the episode ts
        // so the engine's temporal ordering reflects the historical conversation timeline
        // (critical for temporal-reasoning and knowledge-update questions).
        // source='conversation' routes extraction through the conversation prompt (D-62),
        // which captures personal episodic details that the default prompt misses.
        for (let i = 0; i < haystackSessions.length; i++) {
          const session = haystackSessions[i];
          const dateStr = haystackDates[i] || null;
          const tsMs    = parseSessionDate(dateStr);
          scratch.episodes.append({
            content:    formatSession(session, dateStr),
            origin:     'observed',
            salience:   1.0,
            hard_keep:  1,
            role:       'user',
            source:     'conversation',
            session_id: `${questionId}-s${i}`,
            ...(tsMs != null ? { ts: tsMs } : {}),
          });
        }

        // Step 2: run ONE sleep pass AFTER all appends (Pitfall 4).
        // Count H-2 quarantine events via the log callback so questions with
        // incomplete memory are excluded from scoring rather than silently
        // degrading the result. The consolidator logs:
        //   "episode <id> skipped (consolidation error): <err>"
        let quarantineCount = 0;
        await runConsolidation(
          scratch.db,
          scratch.dbPath,
          process.env,
          (msg) => {
            if (msg.includes('skipped (consolidation error)')) quarantineCount++;
          }
        );

        // Step 3: embed the question
        const [queryVec] = await embedder.embed([questionText]);

        // Step 4: retrieve top-K nodes by cosine similarity over the consolidated graph.
        //
        // The production hook-injection wrapper (RetrievalEngine.retrieve) is NOT used here.
        // That primitive returns at most 1 result and requires cosine >= deletedSimilarityThreshold
        // (0.7) — a gate calibrated for production injection, not benchmark QA. In practice
        // the gold node often sits at cosine ~0.48 (under the gate), so nearly every question
        // would abstain on empty context if we used the production path.
        //
        // Instead we use CandidateRetriever.topk directly: brute-force cosine over all embedded,
        // non-tombstoned nodes, returning the top K (--topk flag, default 10). This is the same
        // substrate the production engine uses internally, without the single-result / threshold
        // gate that serves a different product feature (hook injection).
        let retrievedValues;
        if (queryVec) {
          const evalRetriever = new CandidateRetriever(scratch.db);
          const evalStore     = new SemanticStore(scratch.db, realClock, { ...DEFAULT_CONFIG, dbPath: scratch.dbPath });
          const topkResults   = evalRetriever.topk(queryVec, TOP_K);
          // CandidateRetriever.topk already excludes tombstoned nodes (SQL: tombstoned = 0).
          // getNode() resolves each id to its value; skip any id that resolves to null (race guard).
          retrievedValues = topkResults
            .map(r => evalStore.getNode(r.id))
            .filter(n => n !== null)
            .map(n => n.value);
        } else {
          // Cueless fallback: no query vector available (embed failed or unavailable).
          // Fall back to RetrievalEngine.retrieveCueless() for ranked cue-less retrieval.
          const engine = buildRetrievalEngine(scratch.db, scratch.dbPath);
          const retrieval = engine.retrieveCueless();
          retrievedValues = retrieval.results.map(r => r.value);
        }

        // Step 5: format retrieved nodes for the answer-gen prompt
        const retrievedText = retrievedValues.length > 0
          ? retrievedValues.map(v => `- ${v}`).join('\n')
          : '(no relevant memory entries found)';

        // Step 6: generate answer with Haiku (cheap model — GPT-4o reserved for scorer).
        //
        // Prompt structure is an equivalent of the official LongMemEval QA template
        // (src/generation/run_generation.py), adapted for brain-memory's memory-node
        // retrieval format (retrieved nodes rather than raw session history). The
        // structure is: history entries → current date → question → "Answer:".
        // The open-ended "Answer:" (no "just the factual answer" constraint) allows
        // the model to respond "I don't have information about that" for questions
        // where no relevant memory entries exist — required for correct abstention
        // scoring on _abs questions. See docs/evals.md for provenance details.
        const currentDateLine = questionDate ? `\nCurrent Date: ${questionDate}` : '';
        const answerPrompt = `I will give you several memory entries from conversations between you and a user. Please answer the question based on the relevant memory entries.\n\n\nMemory Entries:\n\n${retrievedText}${currentDateLine}\nQuestion: ${questionText}\nAnswer:`;
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

        // If any episodes were quarantined during consolidation, the memory is
        // incomplete — mark the result as an error so --retry-errors re-attempts it
        // and the scorer excludes it from headline scoring.
        result = {
          question_id: questionId,
          question_type: questionType,
          hypothesis,
          episodes_quarantined: quarantineCount,
          ...(quarantineCount > 0
            ? { error: `${quarantineCount} episode(s) quarantined during consolidation — memory incomplete` }
            : {}),
        };
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

  // ---- error count report (always on stderr so it is visible even when stdout is piped)
  const finalLines = fs.existsSync(OUT_FILE)
    ? fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(l => l.trim())
    : [];
  let finalErrorCount = 0;
  for (const line of finalLines) {
    try { const r = JSON.parse(line); if (r.error) finalErrorCount++; } catch {}
  }
  if (finalErrorCount > 0) {
    process.stderr.write(
      `\n[warn] ${finalErrorCount} error line(s) in ${OUT_FILE}. Re-run with --retry-errors to re-attempt them.\n` +
      `       The recorded run should finish with 0 errors; fix any systematic errors before publishing scores.\n`
    );
  }
})();
