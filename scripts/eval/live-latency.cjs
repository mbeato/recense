/*
 * D-06a: live-brain retrieval-only p50/p95 latency.
 * Opens the live recense.db READ-ONLY, embeds a set of query strings via the real
 * OpenAI embedder, and times ONLY CandidateRetriever.topk() over the full live node
 * set. No writes to the live brain. SUT = whatever dist this runs against (v7.0).
 */
const path = require('path');
const Database = require('better-sqlite3');
const DIST = path.resolve(__dirname, '../../dist/src');
const { CandidateRetriever } = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');
const { OpenAIEmbedder } = require(DIST + '/model/embedder');

const K = parseInt(process.env.LIVE_K || '10', 10) || 10;
const REPEATS = parseInt(process.env.LIVE_REPEATS || '5', 10) || 5;

const DB_PATH = (process.env.RECENSE_DB_PATH || path.join(require('os').homedir(), '.config/recense/recense.db'));

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const QUERIES = [
  'When did the user move to a new city?',
  'What hobby did the user pick up recently?',
  'Who did the user have a conflict with at work?',
  'What is the user\'s favorite kind of music?',
  'How many siblings does the user have?',
  'What health issue was the user dealing with?',
  'Where did the user go on vacation last year?',
  'What pet does the user own?',
  'What did the user study in school?',
  'What is the user planning to do next month?',
  'Who is the user\'s closest friend?',
  'What food does the user dislike?',
  'What car does the user drive?',
  'What was the user celebrating recently?',
  'What book did the user mention reading?',
  'What sport does the user play?',
  'What is the user\'s job?',
  'What gift did the user give someone?',
  'What concern did the user raise about money?',
  'What goal is the user working toward?',
];

(async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const nodeCount = db.prepare('SELECT count(*) AS n FROM node WHERE embedding IS NOT NULL').get().n;
  const retriever = new CandidateRetriever(db);
  const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DEFAULT_CONFIG.embeddingDimensions);

  console.log(`[live-latency] DB=${DB_PATH} embedded_nodes=${nodeCount} K=${K} repeats=${REPEATS} queries=${QUERIES.length}`);
  const vecs = await embedder.embed(QUERIES);

  const latencies = [];
  // warm-up (one pass, discarded)
  for (const v of vecs) retriever.topk(v, K);
  // measured
  for (let r = 0; r < REPEATS; r++) {
    for (const v of vecs) {
      const t0 = Date.now();
      retriever.topk(v, K);
      latencies.push(Date.now() - t0);
    }
  }
  latencies.sort((a, b) => a - b);
  const out = {
    db_path: DB_PATH,
    embedded_nodes: nodeCount,
    k: K,
    samples: latencies.length,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    min_ms: latencies[0],
    max_ms: latencies[latencies.length - 1],
  };
  console.log('[live-latency] result:', JSON.stringify(out));
  db.close();
})().catch(e => { console.error('live-latency error:', e.message); process.exit(1); });
