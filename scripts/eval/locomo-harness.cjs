/**
 * LoCoMo-10 harness (BENCH-01) — end-to-end: ingest → consolidate-once → retrieve → answer.
 *
 * Run from the repo root (requires a prior `npm run build`):
 *
 *   # Dry-run mode: zero API calls, validates fixture parsing + scratch DB
 *   node scripts/eval/locomo-harness.cjs --dry-run
 *   node scripts/eval/locomo-harness.cjs --dry-run --eval scripts/eval/fixtures/locomo-mini.json
 *
 *   # Probe mode: run ONE conversation (all its QA pairs), print cost, exit — do NOT proceed to full run
 *   node scripts/eval/locomo-harness.cjs --probe
 *
 *   # Full run (PAID — requires explicit --run flag, ANTHROPIC_API_KEY or headless transport,
 *     and OPENAI_API_KEY for embedding)
 *   OPENAI_API_KEY=... node scripts/eval/locomo-harness.cjs --run
 *
 *   # Top-K: override number of retrieved nodes fed into the answer prompt (default 10)
 *   node scripts/eval/locomo-harness.cjs --run --topk 20
 *
 * Dataset path (LoCoMo-10 — NOT committed, CC BY-NC 4.0):
 *   scripts/eval/locomo10.json
 *
 * Key requirements:
 *  - Each conversation runs on a fresh scratch DB; the live recense.db is never read (T-14-DB).
 *  - Sessions are read from c.conversation.session_N (nested under "conversation" key in raw data).
 *  - Turn format is {speaker, dia_id, text} — NOT {name, dia_id, text} (RESEARCH inaccuracy corrected).
 *  - One episode is appended per session, tagged [Session N] for R@K tracking.
 *  - runConsolidation() is called ONCE per conversation AFTER all session appends (Pitfall 4).
 *  - QA pairs with category === 5 (adversarial) are skipped from scoring (never count in denominator).
 *  - Retrieval is timed separately from embed and answer gen (retrieval-only latency = D-06a).
 *  - R@K hit: any top-K node whose contributing session is in qa.evidence → hit.
 *  - --probe runs ONE conversation, reports cost + session count, exits 0.
 *  - --dry-run reads mini fixture, skips consolidation + retrieval + answer gen, exits 0.
 *  - --run is required for the full 10-conversation paid run (Pitfall 5 / T-40-03).
 *  - Each completed conversation is appended to OUT_FILE immediately (incremental output).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---- SDK retry budget (must be set BEFORE loading dist modules) -------------
if (!process.env.RECENSE_SDK_MAX_RETRIES) {
  process.env.RECENSE_SDK_MAX_RETRIES = '10';
}

// Engine internals — require dist (run `npm run build` before this script).
const DIST = require('path').resolve(__dirname, '../../dist/src');
const { initSchema }            = require(DIST + '/db/schema');
const { EpisodicStore }         = require(DIST + '/db/episode-store');
const { realClock }             = require(DIST + '/lib/clock');
const { DEFAULT_CONFIG }        = require(DIST + '/lib/config');
const { runConsolidation, resolveProviderOverlay } = require(DIST + '/consolidation/run-sleep-pass');
const { createClaudeHeadlessClient } = require(DIST + '/model/claude-headless-client');
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
const IS_RUN     = process.argv.includes('--run');
const KEEP_DBS   = process.argv.includes('--keep-dbs');

// Gate: refuse to run full 10-conversation paid run unless --run/--probe/--dry-run is explicit (T-40-03)
if (!IS_DRY_RUN && !IS_PROBE && !IS_RUN) {
  console.error('Usage: locomo-harness.cjs [--dry-run | --probe | --run] [options]');
  console.error('');
  console.error('  --dry-run   Zero API calls. Validates parsing + episode append. Safe for CI.');
  console.error('  --probe     Run ONE conversation (all its QA pairs), report cost/session count, exit.');
  console.error('  --run       Full 10-conversation paid run. Requires OPENAI_API_KEY (+ ANTHROPIC_API_KEY');
  console.error('              or RECENSE_ANSWER_PROVIDER=claude-headless for subscription-billed answers).');
  console.error('');
  console.error('Options:');
  console.error('  --eval <path>    Dataset path (default: scripts/eval/locomo10.json)');
  console.error('  --out <path>     Output file (default: scripts/eval/results/locomo-hypotheses-PENDING.jsonl)');
  console.error('  --topk <n>       Top-K retrieved nodes for answer prompt (default: 10)');
  console.error('  --keep-dbs       Skip scratch DB cleanup (for manual inspection)');
  process.exit(1);
}

const TOP_K = Math.max(1, parseInt(arg('--topk', '10'), 10) || 10);

// Probe: run ONE conversation only.
const PROBE_LIMIT = 1;

// --dry-run defaults to committed mini fixture; probe/run default to downloaded dataset
const EVAL_DEFAULT = IS_DRY_RUN
  ? 'scripts/eval/fixtures/locomo-mini.json'
  : 'scripts/eval/locomo10.json';

const EVAL_FILE = arg('--eval', EVAL_DEFAULT);
const OUT_FILE  = arg('--out', 'scripts/eval/results/locomo-hypotheses-PENDING.jsonl');

// Approximate Haiku 4.5 pricing (USD per million tokens) — probe cost estimation only
const HAIKU_INPUT_COST_PER_M  = 0.80;
const HAIKU_OUTPUT_COST_PER_M = 4.00;

const ANSWER_MODEL = DEFAULT_CONFIG.anthropicModel; // claude-haiku-4-5-20251001

// Answer-gen concurrency: pool the per-QA answer calls to hide subprocess cold-start.
// claude-headless spawns one `claude -p` per answer (~10-30s cold-start each); serial
// answering made a full run ~10-20h. Pooling keeps answers subscription-billed (still
// claude -p, still on the /usage meter) and only improves wall-clock. Dial down via
// RECENSE_ANSWER_CONCURRENCY if the subscription rate-limits under concurrent load.
const ANSWER_CONCURRENCY = Math.max(1, parseInt(process.env.RECENSE_ANSWER_CONCURRENCY || '6', 10) || 6);

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
 * Parse the LoCoMo-10 dataset: a single JSON array of 10 conversation objects.
 * Each object has shape:
 *   { sample_id, conversation: { speaker_a, speaker_b, session_1: [{speaker,dia_id,text}], session_1_date_time, ... }, qa: [...] }
 *
 * Distinct from LongMemEval: this is a JSON array, NOT JSONL (T-40-SCHEMA-01).
 */
function parseLoCoMo(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array in ${filePath}, got ${typeof parsed}`);
  }
  return parsed;
}

/**
 * Extract all sessions from a raw LoCoMo conversation object.
 *
 * Raw schema: sessions are nested under the top-level "conversation" key
 * (e.g. conv.conversation.session_1, conv.conversation.session_2, ...).
 * The flat locomo-mini.json fixture normalises them to top-level (for dry-run).
 *
 * Returns an array of { session, date, sessionIdx } in ascending session_N order.
 * sessionIdx is 0-based (session_1 → 0, session_2 → 1, ...).
 */
function extractSessions(conv) {
  // Determine if this is the raw nested format (has "conversation" key) or flat (locomo-mini.json)
  const container = (conv.conversation && typeof conv.conversation === 'object')
    ? conv.conversation
    : conv;

  const sessions = [];
  // Iterate session_1, session_2, ... up to session_50 (LoCoMo has at most ~35 sessions per conv)
  for (let n = 1; n <= 50; n++) {
    const sessionKey = `session_${n}`;
    const dateKey    = `session_${n}_date_time`;
    const sessionData = container[sessionKey];
    if (!Array.isArray(sessionData)) break; // no more sessions
    sessions.push({
      session:    sessionData,
      date:       typeof container[dateKey] === 'string' ? container[dateKey] : null,
      sessionIdx: n - 1,  // 0-based: session_1 → 0
    });
  }
  return sessions;
}

/**
 * Format a LoCoMo session into an episode content string.
 *
 * Turn format: {speaker, dia_id, text} (NOT {role, content} as in LME).
 * Prepends "[Session N]" tag (1-based) for R@K session-index tracking.
 * Optionally prefixes with the session date when present.
 *
 * @param {Array}  session       Array of {speaker, dia_id, text} turn objects.
 * @param {number} sessionIdx    0-based index (session_1 = idx 0).
 * @param {string} [date]        Optional date string from session_N_date_time.
 */
function formatSession(session, sessionIdx, date) {
  const sessionTag = `[Session ${sessionIdx + 1}]`;  // 1-based label
  const turns = session
    .map(turn => `${turn.speaker}: ${turn.text}`)
    .join('\n');
  return date
    ? `${sessionTag}\n[Session date: ${date}]\n${turns}`
    : `${sessionTag}\n${turns}`;
}

/**
 * Parse a LoCoMo evidence dialog-ID to a 0-based session index.
 * "D1:9"  → parseInt("1") - 1 = 0 (session_1)
 * "D3:4"  → parseInt("3") - 1 = 2 (session_3)
 */
function evidenceToSessionIdx(dialogId) {
  const sessionNum = parseInt(dialogId.split(':')[0].replace('D', ''), 10);
  return sessionNum - 1; // 0-based
}

// ---- bounded concurrency pool -----------------------------------------------

/**
 * Runs fn(item) for each item in items, with at most `concurrency` in-flight at once.
 * Items are processed in queue order; workers race to grab the next item.
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
    const answerOverlay    = resolveProviderOverlay(process.env, 'RECENSE_ANSWER_PROVIDER');
    const isAnswerHeadless = answerOverlay.modelProvider === 'claude-headless';
    if (!isAnswerHeadless && !process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not set — required for answer generation (use --dry-run for zero-API mode)');
      console.error('TIP: set RECENSE_MODEL_PROVIDER=claude-headless to use the subscription-billed transport.');
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
      console.error('Acquire LoCoMo-10 from the LoCoMo repository (CC BY-NC 4.0):');
      console.error('  https://github.com/snap-research/locomo');
      console.error('  Place as scripts/eval/locomo10.json (gitignored)');
    }
    process.exit(1);
  }

  const allConversations = parseLoCoMo(EVAL_FILE);
  if (!allConversations.length) {
    console.error(`No conversations found in ${EVAL_FILE}`);
    process.exit(1);
  }

  const limit         = IS_PROBE ? PROBE_LIMIT : allConversations.length;
  const conversations = allConversations.slice(0, limit);

  if (IS_DRY_RUN) {
    console.log(`[dry-run] Loaded ${conversations.length} conversation(s) from ${EVAL_FILE} (zero API mode)`);
  } else if (IS_PROBE) {
    console.log(`[probe] Running ${conversations.length} conversation(s) to estimate cost and latency`);
  } else {
    console.log(`[run] Processing ${conversations.length} conversation(s) from ${EVAL_FILE}`);
  }

  // ---- output dir setup -----------------------------------------------------
  fs.mkdirSync(path.dirname(path.resolve(OUT_FILE)), { recursive: true });

  // ---- probe tracking -------------------------------------------------------
  const probeStats = { inputTokens: 0, outputTokens: 0 };

  // ---- embedder (real mode only) -------------------------------------------
  const embedder = IS_DRY_RUN
    ? null
    : new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DEFAULT_CONFIG.embeddingDimensions);

  // ---- anthropic client (real mode only) ------------------------------------
  let anthropicClient = null;
  if (!IS_DRY_RUN) {
    const answerOverlay = resolveProviderOverlay(process.env, 'RECENSE_ANSWER_PROVIDER');
    if (answerOverlay.modelProvider === 'claude-headless') {
      const { client } = createClaudeHeadlessClient({ ...DEFAULT_CONFIG, ...answerOverlay });
      anthropicClient = client;
      console.log('[transport] Answer: claude-headless (subscription-billed via claude -p)');
    } else {
      const Anthropic = require('@anthropic-ai/sdk');
      const harnessMaxRetries = Math.max(1, parseInt(process.env.RECENSE_SDK_MAX_RETRIES || '10', 10) || 10);
      anthropicClient = new Anthropic({ maxRetries: harnessMaxRetries });
    }
  }

  // ---- telemetry state ------------------------------------------------------
  let completedConvCount = 0;
  const wallStart = Date.now();

  // ---- per-conversation pipeline --------------------------------------------
  async function processConversation(conv) {
    const convStart  = Date.now();
    const sampleId   = conv.sample_id || `conv-${Math.random().toString(36).slice(2)}`;

    // Extract sessions from the raw (nested) or flat (fixture) shape
    const sessionList = extractSessions(conv);
    if (sessionList.length === 0) {
      console.error(`[warn] ${sampleId}: no sessions found — skipping`);
      return;
    }

    // QA pairs are always at the top-level qa key
    const allQA      = Array.isArray(conv.qa) ? conv.qa : [];
    // Scoreable QA = non-adversarial (category !== 5)
    const scoreableQA = allQA.filter(qa => qa.category !== 5);

    const scratch     = makeScratchDb();
    const convResults = [];

    try {
      if (IS_DRY_RUN) {
        // Dry-run: append episodes for schema validation, skip consolidation + retrieval + answer gen
        for (const { session, date, sessionIdx } of sessionList) {
          const content = formatSession(session, sessionIdx, date);
          scratch.episodes.append({
            content,
            origin:     'observed',
            salience:   1.0,
            hard_keep:  1,
            role:       'user',
            source:     'conversation',
            session_id: `${sampleId}-s${sessionIdx}`,
          });
        }

        // Dry-run: emit one result per scoreable QA pair with stub answer
        for (const qa of scoreableQA) {
          convResults.push({
            sample_id:    sampleId,
            question:     qa.question || '',
            gold_answer:  qa.answer !== undefined ? qa.answer : '',
            category:     qa.category,
            hypothesis:   DRY_RUN_STUB_ANSWER,
            evidence:     qa.evidence || [],
            hit5:         false,
            hit10:        false,
            retrieval_ms: null,
            embed_ms:     null,
            answer_ms:    null,
            topk_ids:     [],
            topk_scores:  [],
          });
        }

      } else {
        // Real mode: full pipeline

        // Step 1: ingest ALL sessions as episodes (one per session, tagged [Session N])
        for (const { session, date, sessionIdx } of sessionList) {
          const content = formatSession(session, sessionIdx, date);
          scratch.episodes.append({
            content,
            origin:     'observed',
            salience:   1.0,
            hard_keep:  1,
            role:       'user',
            source:     'conversation',
            session_id: `${sampleId}-s${sessionIdx}`,
          });
        }

        // Step 2: consolidate ONCE per conversation, AFTER all session appends (Pitfall 4)
        let quarantineCount = 0;
        await runConsolidation(
          scratch.db,
          scratch.dbPath,
          process.env,
          (msg) => {
            if (msg.includes('skipped (consolidation error)')) quarantineCount++;
          }
        );

        // Step 3–5: inner QA loop — embed, retrieve (timed), answer
        const evalRetriever = new CandidateRetriever(scratch.db);
        const evalStore     = new SemanticStore(scratch.db, realClock, { ...DEFAULT_CONFIG, dbPath: scratch.dbPath });

        // Bounded-concurrency answer-gen: pool the per-QA answer calls to hide claude -p
        // cold-start. Results are written by index (qaResults) to preserve output order
        // despite out-of-order completion. The sync topk timing (D-06a) stays isolated —
        // there is no await between its Date.now() bracket and the call, so concurrency
        // cannot inflate retrieval_ms (embed_ms/answer_ms become wall-clock-under-load,
        // which is fine: headline retrieval latency is measured separately on the live brain).
        const qaResults = new Array(scoreableQA.length);
        await runBoundedPool(scoreableQA.map((qa, qaIdx) => ({ qa, qaIdx })), ANSWER_CONCURRENCY, async ({ qa, qaIdx }) => {
          const questionText = qa.question || '';
          const goldAnswer   = qa.answer !== undefined ? qa.answer : '';

          let hypothesis   = DRY_RUN_STUB_ANSWER;
          let embedMs      = null;
          let retrievalMs  = null;
          let answerMs     = null;
          let topkIds      = [];
          let topkScores   = [];
          let hit5         = false;
          let hit10        = false;

          try {
            // Step 3: embed the question (record embed_ms separately from retrieval)
            const embedStart = Date.now();
            const [queryVec] = await embedder.embed([questionText]);
            embedMs = Date.now() - embedStart;

            // Step 4: retrieve top-K nodes — retrieval-only timing (excludes embed + answer)
            // D-06a: t0/t1 wraps ONLY the topk call
            const retrievalStart = Date.now();
            const topkResults    = evalRetriever.topk(queryVec, TOP_K);
            retrievalMs          = Date.now() - retrievalStart;

            topkIds    = topkResults.map(r => r.id);
            topkScores = topkResults.map(r => r.score);

            // R@K session-level hit (Option A from RESEARCH Item 3):
            // hitSessions = 0-based session indices from qa.evidence dialog IDs
            const hitSessions = new Set(
              (qa.evidence || []).map(e => evidenceToSessionIdx(e))
            );

            // For each top-K node, find the session index of its contributing episode
            // via the [Session N] tag embedded in the episode content.
            // Query: consolidation_event → episode (by episode_id), extract [Session N] prefix.

            /** Build a set of session indices from a list of node IDs. */
            function retrievedSessionsForIds(nodeIds) {
              if (nodeIds.length === 0) return new Set();
              const nodeIdsJson = JSON.stringify(nodeIds);
              const rows = scratch.db.prepare(`
                SELECT DISTINCT ce.node_id, e.content
                FROM consolidation_event ce
                JOIN episode e ON ce.episode_id = e.id
                WHERE ce.node_id IN (SELECT value FROM json_each(?))
              `).all(nodeIdsJson);
              const sessionIdxs = new Set();
              for (const row of rows) {
                const match = row.content && row.content.match(/^\[Session (\d+)\]/);
                if (match) {
                  sessionIdxs.add(parseInt(match[1], 10) - 1); // 0-based
                }
              }
              return sessionIdxs;
            }

            const sessionsAt5  = retrievedSessionsForIds(topkIds.slice(0, 5));
            const sessionsAt10 = retrievedSessionsForIds(topkIds.slice(0, 10));

            hit5  = [...sessionsAt5].some(s => hitSessions.has(s));
            hit10 = [...sessionsAt10].some(s => hitSessions.has(s));

            // Step 5: format retrieved nodes and generate answer (answer_ms separate)
            const resolvedEntries = topkResults
              .map(r => ({ id: r.id, node: evalStore.getNode(r.id) }))
              .filter(({ node }) => node !== null);

            const retrievedText = resolvedEntries.length > 0
              ? resolvedEntries.map(({ node }) => `- ${node.value}`).join('\n')
              : '(no relevant memory entries found)';

            const answerPrompt =
              `I will give you several memory entries from conversations between two users. ` +
              `Please answer the question based on the relevant memory entries.\n\n` +
              `Memory Entries:\n\n${retrievedText}\n\n` +
              `Question: ${questionText}\nAnswer:`;

            const answerStart = Date.now();
            const answerResponse = await anthropicClient.messages.create({
              model:      ANSWER_MODEL,
              max_tokens: 256,
              messages:   [{ role: 'user', content: answerPrompt }],
            });
            answerMs = Date.now() - answerStart;
            hypothesis = answerResponse.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('')
              .trim();

            // Accumulate probe tokens
            if (IS_PROBE && answerResponse.usage) {
              probeStats.inputTokens  += answerResponse.usage.input_tokens  || 0;
              probeStats.outputTokens += answerResponse.usage.output_tokens || 0;
            }

          } catch (qaErr) {
            hypothesis = DRY_RUN_STUB_ANSWER;
            process.stderr.write(`[qa-error] ${sampleId}: ${String(qaErr.message || qaErr).slice(0, 200)}\n`);
          }

          qaResults[qaIdx] = {
            sample_id:    sampleId,
            question:     questionText,
            gold_answer:  goldAnswer,
            category:     qa.category,
            hypothesis,
            evidence:     qa.evidence || [],
            hit5,
            hit10,
            retrieval_ms: retrievalMs,
            embed_ms:     embedMs,
            answer_ms:    answerMs,
            topk_ids:     topkIds,
            topk_scores:  topkScores,
            ...(quarantineCount > 0 ? { quarantine_count: quarantineCount } : {}),
          };
        });
        // Push in stable QA order (skip any holes from mid-pool failures).
        for (const r of qaResults) { if (r) convResults.push(r); }
      }

    } catch (convErr) {
      const errMsg = String(convErr.message || convErr).slice(0, 300);
      process.stderr.write(`[conv-error] ${sampleId}: ${errMsg}\n`);
      convResults.push({
        sample_id: sampleId,
        error:     errMsg,
        hypothesis: DRY_RUN_STUB_ANSWER,
      });
    } finally {
      scratch.cleanup();
    }

    // Append all QA results for this conversation immediately (incremental output)
    for (const result of convResults) {
      fs.appendFileSync(OUT_FILE, JSON.stringify(result) + '\n');
    }

    // Telemetry to stderr
    const elapsedSec = (Date.now() - convStart) / 1000;
    completedConvCount++;
    const wallElapsedMs = Date.now() - wallStart;
    const avgMsPerConv  = wallElapsedMs / completedConvCount;
    const remaining     = conversations.length - completedConvCount;
    const etaSec        = Math.round((remaining * avgMsPerConv) / 1000);
    process.stderr.write(
      `[${sampleId}] ${elapsedSec.toFixed(1)}s | sessions=${sessionList.length} qa=${scoreableQA.length} | ETA ~${etaSec}s (${completedConvCount}/${conversations.length})\n`
    );
  }

  // ---- run the pool -----------------------------------------------------------
  // LoCoMo: sequential (concurrency=1) — consolidation is CPU+LLM-bound per conversation.
  if (conversations.length > 0) {
    await runBoundedPool(conversations, 1, processConversation);
  }

  // ---- summary ----------------------------------------------------------------
  const elapsedMs = Date.now() - tStart;

  if (IS_DRY_RUN) {
    console.log(`[dry-run] Done. ${completedConvCount} conversation(s) processed (zero API mode). Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
    process.exit(0);
  }

  if (IS_PROBE) {
    const inputCost        = (probeStats.inputTokens  / 1_000_000) * HAIKU_INPUT_COST_PER_M;
    const outputCost       = (probeStats.outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
    const totalCost        = inputCost + outputCost;
    const elapsedMin       = elapsedMs / 60_000;
    const conv             = conversations[0];
    const sessionCount     = conv ? extractSessions(conv).length : '?';
    const scoreableQACount = conv ? (Array.isArray(conv.qa) ? conv.qa.filter(qa => qa.category !== 5).length : 0) : '?';

    console.log(`\nProbe: 1 conversation, ${sessionCount} session(s), ${scoreableQACount} scoreable QA pair(s)`);
    console.log(`  Answer-gen cost: $${totalCost.toFixed(4)} total (${probeStats.inputTokens} in + ${probeStats.outputTokens} out tokens)`);
    console.log(`  Extrapolated ×10 conversations: ~$${(totalCost * 10).toFixed(3)} (answer-gen only)`);
    console.log(`  Elapsed: ${elapsedMin.toFixed(1)} min`);
    console.log('Note: consolidation costs (extraction + judge) are not measured here — check API billing.');
    console.log('Re-run with --run to evaluate all 10 conversations.');
    process.exit(0);
  }

  console.log(`Done. ${completedConvCount} conversation(s) processed. Output: ${OUT_FILE}. Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
})();
