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
 *  - Every question runs on a fresh scratch DB; the live recense.db env var is never read (T-14-DB).
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
// anthropic-client.ts reads RECENSE_SDK_MAX_RETRIES at module-load time.
// 10 retries + SDK-native retry-after backoff = self-throttling under 429 load.
// Set only if the caller has not already overridden it.
if (!process.env.RECENSE_SDK_MAX_RETRIES) {
  process.env.RECENSE_SDK_MAX_RETRIES = '10';
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

// --instrument: before scratch.cleanup(), query 4 attribution taps from the scratch DB
//   and append one JSON record per question to INSTRUMENT_OUT.
// --keep-dbs: skip the fs.unlink() inside scratch.cleanup() so DBs survive for manual inspection.
// --instrument-out <path>: override the default sidecar file path (default: attribution-18.jsonl).
const IS_INSTRUMENT  = process.argv.includes('--instrument');
const KEEP_DBS       = process.argv.includes('--keep-dbs');

// --hybrid: LEVER 1 — replace CandidateRetriever.topk with hybridTopk (BM25+cosine RRF).
// Uses the SAME primitive as the product path (Pattern 2: one-primitive-two-consumers).
// No floor applied in eval: every RRF-fused result surfaces regardless of cosine score.
// Composable with --topk (budget lever) and --temporal.
const IS_HYBRID  = process.argv.includes('--hybrid');

// --temporal: LEVER 2 — date-annotate answer-prompt entries using MAX(episode.ts) per node.
// After retrieval, queries the scratch DB for the newest supporting episode ts per retrieved node,
// sorts entries newest-supported-first, and prefixes each with [YYYY-MM-DD].
// Orphan nodes (no consolidation_event rows) are treated as undated and not demoted.
// Composable with --hybrid and --topk.
const IS_TEMPORAL = process.argv.includes('--temporal');

// --rewrite: LEVER 3 — rewrite the question to a declarative statement before embedding.
// Same prompt contract as HybridResponder.respond() in the product path (one-primitive pattern):
//   "Rewrite as a concise declarative statement. Preserve ALL names/numbers/proper nouns VERBATIM."
// Uses ANSWER_MODEL (claude-haiku) — one extra Haiku call per question when set.
// Falls back to the raw question on any error (never blocks a question).
// CAUTION: adds ~$0.001 per question ($0.028 per question-pair for the 28-question sample).
//   Run with the 28-regression sample (~$0.80 total) — well within the 17-05 budget.
// Attribution gate: retrieve_miss=0 in the 18-question eval; rewrite attacks Q->S cosine
//   asymmetry (0.688 vs 0.797 measured) which would cause misses at scale.
// LAST lever to combine with --topk 30 (Pitfall 5: wider context can flip abstention questions).
// Composable with --hybrid, --temporal, --topk.
const IS_REWRITE = process.argv.includes('--rewrite');

// --chunk-turns N: ingest one episode per N-turn window (finer-grained, matching production capture)
// instead of per-session formatSession. `--per-turn` is the back-compat alias for N=1. Validated
// sweet spot N=2 (same-or-better extraction coverage as per-turn at 2x fewer episodes; n=15 + n=30).
// Default (no flag) → CHUNK_TURNS=0 = per-session, byte-identical to today.
const CHUNK_TURNS = process.argv.includes('--per-turn')
  ? 1
  : (parseInt((process.argv.indexOf('--chunk-turns') !== -1 ? process.argv[process.argv.indexOf('--chunk-turns') + 1] : '0'), 10) || 0);

// --replay-claims <attribution.jsonl>: reuse cached granite extraction from a prior
// --instrument attribution.jsonl; valid ONLY when the cache used the same extractor
// (granite) + same --chunk-turns; never calls granite/Ollama for extraction.
const REPLAY_CLAIMS = arg('--replay-claims', null);

// Stable content hash for the replay-claims map keys.
const sha = s => require('crypto').createHash('sha256').update(s).digest('hex');

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

// --strength-weight <w>: RRF strength weight threaded into the direct hybridTopk call (Phase 35
// RANK-02). Only active when --hybrid is also set (the non-hybrid topk branch is unchanged).
// Default 0 (dark) — identical to current behaviour. Sweepable via 35-strength-sweep.cjs.
const STRENGTH_WEIGHT = parseFloat(arg('--strength-weight', '0')) || 0;

// --dry-run defaults to the committed mini fixture; normal/probe default to the downloaded dataset
const EVAL_DEFAULT = IS_DRY_RUN
  ? 'scripts/eval/fixtures/longmemeval-mini.jsonl'
  : 'scripts/eval/longmemeval-s.jsonl';

const EVAL_FILE      = arg('--eval', EVAL_DEFAULT);
const OUT_FILE       = arg('--out', 'scripts/eval/results/longmemeval-hypotheses-PENDING.jsonl');
const INSTRUMENT_OUT = arg('--instrument-out', 'scripts/eval/results/attribution-18.jsonl');

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
 * NEVER touches the live recense.db path — always a fresh isolated temp path (T-14-DB).
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
      // --keep-dbs: skip unlink so scratch DBs survive for manual attribution inspection.
      // The db.close() above still runs to release file descriptors.
      if (!KEEP_DBS) {
        try { fs.unlinkSync(dbPath); } catch {}
      }
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
  // WR-02 fix: Date.parse("YYYY-MM-DD HH:MM") (space-separated, non-ISO) is parsed as LOCAL
  // time by V8. Normalise to an explicit UTC instant so the [YYYY-MM-DD] prefix rendered back
  // via toISOString() (UTC) is always correct regardless of host timezone.
  // "2023-05-20 02:21" → "2023-05-20T02:21Z" (only the first space is replaced).
  const utcNormalized = normalized.replace(' ', 'T') + 'Z';
  const ms = Date.parse(utcNormalized);
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

  // ---- replay-claims: load + parse attribution cache at startup --------------
  // Keyed by question_id → the full attribution record (claims[], ...).
  let replayByQid = null;
  if (REPLAY_CLAIMS) {
    if (!fs.existsSync(REPLAY_CLAIMS)) {
      console.error(`replay-claims: attribution file not found: ${REPLAY_CLAIMS}`);
      process.exit(1);
    }
    const cacheRecords = parseJsonl(REPLAY_CLAIMS);
    replayByQid = new Map();
    for (const rec of cacheRecords) {
      if (rec.question_id && Array.isArray(rec.claims)) {
        replayByQid.set(rec.question_id, rec);
      }
    }
    console.log(`[replay-claims] Loaded ${replayByQid.size} cached question(s) from ${REPLAY_CLAIMS}`);
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
  const harnessMaxRetries = Math.max(1, parseInt(process.env.RECENSE_SDK_MAX_RETRIES || '10', 10) || 10);
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

    // Hoisted for instrumentation access across branches (taps 3+4).
    // Set only in real mode; null in dry-run or cueless-fallback paths.
    let instrumentEvalStore  = null;  // SemanticStore over scratch.db (tap 3)
    let instrumentTopkResults = null; // raw topk hits [{id, score}]   (tap 3)
    let instrumentHypothesis  = null; // final answer text              (tap 4)

    try {
      if (IS_DRY_RUN) {
        // Dry-run: append episodes for schema validation, skip all LLM steps
        for (let i = 0; i < haystackSessions.length; i++) {
          const session  = haystackSessions[i];
          const dateStr  = haystackDates[i] || null;
          const tsMs     = parseSessionDate(dateStr);
          if (CHUNK_TURNS > 0) {
            for (let j = 0; j < session.length; j += CHUNK_TURNS) {
              const window = session.slice(j, j + CHUNK_TURNS);
              const body = window.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n');
              const turnContent = dateStr ? `[Session date: ${dateStr}]\n${body}` : body;
              scratch.episodes.append({
                content:    turnContent,
                origin:     'observed',
                salience:   1.0,
                hard_keep:  1,
                role:       'user',
                source:     'conversation',
                session_id: `${questionId}-s${i}-w${j}`,
                ...(tsMs != null ? { ts: tsMs } : {}),
              });
            }
          } else {
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
        }
        instrumentHypothesis = DRY_RUN_STUB_ANSWER;
        result = { question_id: questionId, question_type: questionType, hypothesis: DRY_RUN_STUB_ANSWER };
      } else {
        // Real mode: full pipeline

        // Step 1: ingest ALL haystack sessions as episodes (one episode per session).
        // haystack_dates[i] is prefixed into the content and used as the episode ts
        // so the engine's temporal ordering reflects the historical conversation timeline
        // (critical for temporal-reasoning and knowledge-update questions).
        // source='conversation' routes extraction through the conversation prompt (D-62),
        // which captures personal episodic details that the default prompt misses.
        //
        // episodeContents: the exact content strings appended, in order — used by
        // --replay-claims to build the positional content-hash → cached-claim-values map.
        const episodeContents = [];
        for (let i = 0; i < haystackSessions.length; i++) {
          const session = haystackSessions[i];
          const dateStr = haystackDates[i] || null;
          const tsMs    = parseSessionDate(dateStr);
          if (CHUNK_TURNS > 0) {
            for (let j = 0; j < session.length; j += CHUNK_TURNS) {
              const window = session.slice(j, j + CHUNK_TURNS);
              const body = window.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n');
              const turnContent = dateStr ? `[Session date: ${dateStr}]\n${body}` : body;
              episodeContents.push(turnContent);
              scratch.episodes.append({
                content:    turnContent,
                origin:     'observed',
                salience:   1.0,
                hard_keep:  1,
                role:       'user',
                source:     'conversation',
                session_id: `${questionId}-s${i}-w${j}`,
                ...(tsMs != null ? { ts: tsMs } : {}),
              });
            }
          } else {
            const sessionContent = formatSession(session, dateStr);
            episodeContents.push(sessionContent);
            scratch.episodes.append({
              content:    sessionContent,
              origin:     'observed',
              salience:   1.0,
              hard_keep:  1,
              role:       'user',
              source:     'conversation',
              session_id: `${questionId}-s${i}`,
              ...(tsMs != null ? { ts: tsMs } : {}),
            });
          }
        }

        // --replay-claims: build per-question content-hash → cached-claim-values map.
        // PREFERRED (content-keyed): caches written by the post-260616-ftj instrument carry
        //   a `content_hash` per claim → group values DIRECTLY by content_hash, no positional
        //   zip, no episodes==groups assumption. 0-claim episodes simply have no entry and
        //   replayExtract returns [] for them — shift-free by construction.
        // FALLBACK (positional zip): OLD caches lacking content_hash group by episode_id in
        //   first-appearance order and zip positionally to episodeContents (best-effort; can
        //   shift when 0-claim episodes are interleaved — the reason content_hash was added).
        let replayExtract;
        if (REPLAY_CLAIMS) {
          const cached = replayByQid.get(questionId);
          if (!cached) {
            throw new Error(`replay-claims: no cache entry for question_id ${questionId}`);
          }
          const replayMap = new Map();
          const hasContentHash = cached.claims.length > 0 && cached.claims[0].content_hash != null;
          if (hasContentHash) {
            // Content-keyed: group values directly by content_hash (skip null-hash rows,
            // e.g. schema_emitted events with no episode_id). Shift-free.
            for (const claim of cached.claims) {
              if (claim.content_hash == null) continue;
              if (!replayMap.has(claim.content_hash)) replayMap.set(claim.content_hash, []);
              replayMap.get(claim.content_hash).push(claim.value);
            }
          } else {
            // Positional fallback for legacy caches (no content_hash field).
            const seenEpIds = [];
            const groupMap = new Map();
            for (const claim of cached.claims) {
              const epId = claim.episode_id;
              if (!groupMap.has(epId)) {
                seenEpIds.push(epId);
                groupMap.set(epId, []);
              }
              groupMap.get(epId).push(claim.value);
            }
            const groups = seenEpIds.map(epId => ({ values: groupMap.get(epId) }));
            if (groups.length > episodeContents.length) {
              // More cache groups than current episodes: definite --chunk-turns mismatch.
              throw new Error(
                `replay-claims: more cache groups than episodes for ${questionId}` +
                ` (groups=${groups.length} episodes=${episodeContents.length})` +
                ` — cache was built with a different --chunk-turns; aborting question`
              );
            }
            if (groups.length < episodeContents.length) {
              // Fewer groups than episodes: some episodes produced 0 claims in the
              // original run (not recorded in consolidation_event). Best-effort
              // positional zip for the first groups.length episodes; the rest map to [].
              process.stderr.write(
                `[replay-claims] ${questionId}: ${episodeContents.length - groups.length} episode(s)` +
                ` had 0 claims in original run — treating as empty (legacy positional fallback;` +
                ` groups=${groups.length} episodes=${episodeContents.length})\n`
              );
            }
            for (let k = 0; k < groups.length; k++) {
              replayMap.set(sha(episodeContents[k]), groups[k].values);
            }
          }
          replayExtract = (content) => {
            const v = replayMap.get(sha(content));
            if (v === undefined) {
              // Not in map: episode had 0 claims in the original run (content-keyed),
              // or fell outside the positional range (legacy fallback).
              return [];
            }
            // type defaults to 'fact' — cache carries no entity/fact distinction;
            // this affects only node typing, never the embedded claim TEXT.
            return v.map(value => ({ type: 'fact', value }));
          };
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
          },
          REPLAY_CLAIMS ? { replayExtract } : undefined
        );

        // LEVER 3 (--rewrite): rewrite the question to a declarative statement before embedding.
        // Same prompt contract as HybridResponder.respond() — one-primitive-two-consumers (Pattern 2).
        // Falls back to questionText on any error so a failed rewrite never blocks a question.
        let questionForEmbed = questionText;
        if (IS_REWRITE) {
          try {
            const rewriteResponse = await anthropicClient.messages.create({
              model:      ANSWER_MODEL,
              max_tokens: 128,
              messages:   [{
                role:    'user',
                content: `Rewrite the following question as a concise declarative statement of fact. ` +
                         `Preserve ALL names, numbers, and proper nouns VERBATIM. ` +
                         `Return ONLY the statement — no preamble, no explanation.\n\n` +
                         `Question: ${questionText}`,
              }],
            });
            const rewritten = rewriteResponse.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('')
              .trim();
            if (rewritten) questionForEmbed = rewritten;
          } catch {
            // Fall back to raw question on error
            questionForEmbed = questionText;
          }
        }

        // Step 3: embed the question (or its declarative rewrite if --rewrite)
        const [queryVec] = await embedder.embed([questionForEmbed]);

        // Step 4: retrieve top-K nodes over the consolidated graph.
        //
        // The production hook-injection wrapper (RetrievalEngine.retrieve) is NOT used here.
        // That primitive returns at most 1 result and requires cosine >= deletedSimilarityThreshold
        // (0.7) — a gate calibrated for production injection, not benchmark QA. In practice
        // the gold node often sits at cosine ~0.48 (under the gate), so nearly every question
        // would abstain on empty context if we used the production path.
        //
        // Default: CandidateRetriever.topk — brute-force cosine over embedded, non-tombstoned nodes.
        // --hybrid (LEVER 1): CandidateRetriever.hybridTopk — same primitive as the product path
        //   (Pattern 2: one-primitive-two-consumers). No floor applied: every RRF-fused result
        //   surfaces (eval arm keeps no cosine floor; product keeps floor on cosine component).
        // --temporal (LEVER 2): after retrieval, query MAX(episode.ts) per retrieved node from
        //   the scratch DB (same join as engine.ts stmtLatestSupportTs), sort entries
        //   newest-supported-first, and date-prefix each with [YYYY-MM-DD]. Orphans undated.
        // --rewrite (LEVER 3): questionForEmbed is the rewritten query (or raw fallback); passed
        //   to hybridTopk for the FTS component when --hybrid is also set.
        // --topk N: composable with all levers (budget lever, separate from retrieval strategy).
        let retrievedValues;
        if (queryVec) {
          const evalRetriever    = new CandidateRetriever(scratch.db);
          const evalStore        = new SemanticStore(scratch.db, realClock, { ...DEFAULT_CONFIG, dbPath: scratch.dbPath });
          // LEVER 1: route through hybridTopk when --hybrid is set.
          // ftsQueryFromText sanitisation is handled inside hybridTopk (same as product path).
          // When --rewrite is also set, pass questionForEmbed so FTS uses the declarative form.
          // Phase 35 RANK-02: when --strength-weight w is set (and --hybrid active), pass w as
          // the 5th positional arg so hybridTopk fuses the RRF strength list at weight w.
          // Args: (queryVec, queryText, k, preK=undefined, strengthWeight, nowMs, lambda).
          const topkResults = IS_HYBRID
            ? evalRetriever.hybridTopk(queryVec, questionForEmbed, TOP_K, undefined, STRENGTH_WEIGHT, Date.now(), DEFAULT_CONFIG.lambda)
            : evalRetriever.topk(queryVec, TOP_K);
          // Expose to instrumentation taps (tap 3: retrieved top-k with scores and values).
          instrumentEvalStore    = evalStore;
          instrumentTopkResults  = topkResults;
          // Resolve node values; skip any id that resolves to null (race guard).
          let resolvedEntries = topkResults
            .map(r => ({ id: r.id, node: evalStore.getNode(r.id) }))
            .filter(({ node }) => node !== null);

          // LEVER 2: temporal annotation when --temporal is set.
          // Query MAX(episode.ts) per node via the same consolidation_event→episode join
          // as engine.ts stmtLatestSupportTs. No floor applied — eval arm surfaces all hits.
          if (IS_TEMPORAL && resolvedEntries.length > 0) {
            const nodeIdsJson = JSON.stringify(resolvedEntries.map(e => e.id));
            const tsRows = scratch.db.prepare(`
              SELECT ce.node_id, MAX(e.ts) AS latest_ts
              FROM consolidation_event ce
              JOIN episode e ON ce.episode_id = e.id
              WHERE ce.node_id IN (SELECT value FROM json_each(?))
              GROUP BY ce.node_id
            `).all(nodeIdsJson);
            const tsMap = new Map(tsRows.map(r => [r.node_id, r.latest_ts]));

            // CR-01 fix: subsequence reorder matching engine.ts — don't express "sort dated
            // sub-sequence in place" as a mixed comparator (intransitive when an undated node
            // lies between two dated nodes). Collect original slot positions of dated nodes,
            // sort those positions newest-first, write dated nodes back into those slots,
            // leave undated (orphan) entries fixed at their original positions.
            const datedSlots = resolvedEntries
              .map((e, i) => (tsMap.has(e.id) ? i : -1))
              .filter(i => i !== -1);
            const datedSorted = datedSlots
              .slice()
              .sort((i, j) => tsMap.get(resolvedEntries[j].id) - tsMap.get(resolvedEntries[i].id));
            const reordered = resolvedEntries.slice();
            datedSlots.forEach((slot, k) => { reordered[slot] = resolvedEntries[datedSorted[k]]; });
            // Apply [YYYY-MM-DD] prefix to dated nodes; leave undated (orphan) values unchanged.
            resolvedEntries = reordered.map(e => {
              const ts = tsMap.get(e.id);
              if (ts !== undefined) {
                const dateStr = new Date(ts).toISOString().slice(0, 10);
                return { id: e.id, node: { ...e.node, value: `[${dateStr}] ${e.node.value}` } };
              }
              return e;
            });
          }

          retrievedValues = resolvedEntries.map(({ node }) => node.value);
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
        // (src/generation/run_generation.py), adapted for recense's memory-node
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
        instrumentHypothesis = hypothesis;  // expose to instrumentation tap 4

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

      // ── Attribution instrumentation dump ────────────────────────────────────
      // Runs BEFORE scratch.cleanup() (via finally) so the scratch DB is still open.
      // Dry-run path: writes a minimal record with empty tap arrays (proves flags parse).
      // Real path: queries all 4 attribution taps from the scratch DB.
      // Wrapped in try/catch so a tap failure never corrupts the scored result.
      // Security (T-17-01-I): dumps only claims/nodes/scores/answers/gold — never env vars
      // or provider config keys (T-05-KEY discipline).
      if (IS_INSTRUMENT) {
        try {
          // Tap 1: extracted claims — consolidation_event rows (event_type, value, episode_id).
          // In dry-run mode the scratch DB has no consolidation_event rows; array will be empty.
          // content_hash = sha(episode.content) lets --replay-claims map cached claims by CONTENT
          // (shift-free) instead of by positional zip — 0-claim episodes simply have no rows here,
          // so a content-keyed map never mis-aligns. LEFT JOIN: events with no/absent episode_id
          // (e.g. schema_emitted) get content_hash=null and are ignored by the content-keyed loader.
          const claimRows = IS_DRY_RUN ? [] : scratch.db.prepare(
            `SELECT ce.event_type AS event_type, ce.value AS value, ce.episode_id AS episode_id, e.content AS content
             FROM consolidation_event ce
             LEFT JOIN episode e ON ce.episode_id = e.id
             ORDER BY ce.ts`
          ).all().map(r => ({
            event_type:   r.event_type,
            value:        r.value,
            episode_id:   r.episode_id,
            content_hash: r.content != null ? sha(r.content) : null,
          }));

          // Tap 2: final graph nodes — all node rows (live and tombstoned) for attribution analysis.
          // In dry-run mode the node table is empty.
          const nodeRows = IS_DRY_RUN ? [] : scratch.db.prepare(
            'SELECT id, type, value, tombstoned, prev_value, s, c FROM node'
          ).all();

          // Tap 3: retrieved top-k with scores and resolved values.
          // instrumentEvalStore / instrumentTopkResults are null in dry-run or cueless-fallback.
          const retrievedWithScores = (instrumentTopkResults || []).map(r => ({
            id: r.id,
            score: r.score,
            value: instrumentEvalStore ? (instrumentEvalStore.getNode(r.id)?.value ?? null) : null,
          }));

          // Tap 4: the final answer (hypothesis).
          const attributionRecord = {
            question_id:   questionId,
            question_type: questionType,
            claims:        claimRows,
            nodes:         nodeRows,
            retrieved:     retrievedWithScores,
            hypothesis:    instrumentHypothesis,
            gold_answer:   q.answer,
          };

          fs.mkdirSync(path.dirname(path.resolve(INSTRUMENT_OUT)), { recursive: true });
          fs.appendFileSync(INSTRUMENT_OUT, JSON.stringify(attributionRecord) + '\n');
        } catch (instErr) {
          // Non-fatal: log warning but do not disrupt the scored result.
          process.stderr.write(`[instrument-warn] ${questionId}: ${String(instErr.message || instErr).slice(0, 200)}\n`);
        }
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
