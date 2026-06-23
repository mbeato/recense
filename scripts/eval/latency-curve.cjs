/**
 * Latency-vs-N curve for recense retrieval (D-06b, BENCH-02).
 *
 * Measures retrieval-ONLY p50/p95 latency across controlled node counts
 * (default: 1K/2K/5K/9K/15K/20K) using a public LoCoMo-derived node pool.
 * The live recense.db is never touched — scratch DBs in os.tmpdir() only (T-14-DB).
 *
 * Run modes:
 *   --quick          Smoke-test mode: single small N (200), 2 queries, mock embeddings. Zero API. CI-safe.
 *   --mock-embed     Use zero-vectors instead of calling the OpenAI embedder (for CI/dry-run).
 *   (no flags)       Full run: N-list + queries-per-n queries embedded via OpenAI API.
 *
 * Options:
 *   --n-list 1000,2000,5000,9000,15000,20000   Comma-separated N values to measure
 *   --queries-per-n 20                          Queries to embed and time per N
 *   --k 10                                      Top-K for each topk() call
 *   --out <path>                                Output JSON path
 *   --pool <path>                               Node pool fixture path
 *   --quick                                     Shortcut: --n-list 200 --queries-per-n 2 --mock-embed
 *   --mock-embed                                Use zero-vectors (no OpenAI call)
 *
 * Output envelope:
 *   { meta: { eval, date, commit, engine_version, embed_model, k, queries_per_n }, curve: [{n_nodes, p50_ms, p95_ms, samples}] }
 *
 * Timing is retrieval-ONLY: the Date.now() window wraps ONLY the CandidateRetriever.topk() call.
 * Embed time and any answer generation are excluded (Pitfall 4).
 *
 * Node pool: public LoCoMo-derived text (CC BY-NC 4.0), no private brain content.
 * The pool is cycled when N > pool.length.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ---- arg parsing ------------------------------------------------------------

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i !== -1 ? process.argv[i + 1] : d;
};

const IS_QUICK      = process.argv.includes('--quick');
const IS_MOCK_EMBED = process.argv.includes('--mock-embed') || IS_QUICK;

// --quick shortcuts: n-list 200, 2 queries, mock embed
const N_LIST_ARG    = arg('--n-list',       IS_QUICK ? '200' : '1000,2000,5000,9000,15000,20000');
const QUERIES_PER_N = parseInt(arg('--queries-per-n', IS_QUICK ? '2' : '20'), 10) || (IS_QUICK ? 2 : 20);
const K             = parseInt(arg('--k', '10'), 10) || 10;
const OUT           = arg('--out', 'scripts/eval/results/latency-curve-N.json');
const POOL_PATH     = arg('--pool', 'scripts/eval/fixtures/locomo-node-pool.json');

const N_LIST = N_LIST_ARG
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => !isNaN(n) && n > 0);

if (N_LIST.length === 0) {
  console.error('--n-list must contain at least one positive integer');
  process.exit(1);
}

// Guard: full run requires OPENAI_API_KEY unless mock-embed
if (!IS_MOCK_EMBED && !process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set — required for embedding test queries.');
  console.error('Use --mock-embed (or --quick) for a zero-API run.');
  process.exit(1);
}

// ---- engine imports (require dist; run `npm run build` first) ---------------

const DIST = path.resolve(__dirname, '../../dist/src');
const { initSchema }         = require(DIST + '/db/schema');
const { realClock }          = require(DIST + '/lib/clock');
const { DEFAULT_CONFIG }     = require(DIST + '/lib/config');
const { CandidateRetriever } = require(DIST + '/retrieval/topk');
const { SemanticStore }      = require(DIST + '/db/semantic-store');
const { OpenAIEmbedder }     = require(DIST + '/model/embedder');
const Database               = require('better-sqlite3');

// ---- percentile helper ------------------------------------------------------

/**
 * Compute the p-th percentile of a sorted numeric array.
 * Uses the ceil-based index (PATTERNS §443-446):
 *   idx = Math.ceil(p / 100 * len) - 1
 *
 * @param {number[]} sortedArr  Sorted ascending array of numbers.
 * @param {number}   p          Percentile (0-100).
 * @returns {number}
 */
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = Math.ceil(p / 100 * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

// ---- scratch DB factory (T-14-DB) -------------------------------------------

/**
 * Creates a unique temp-file SQLite DB, initialises the schema.
 * Never touches the live recense.db.
 */
function makeScratchDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `latency-curve-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  return {
    db,
    dbPath,
    config,
    cleanup() {
      try { db.close(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
    },
  };
}

// ---- node pool loader -------------------------------------------------------

function loadNodePool(poolPath) {
  const resolved = path.resolve(process.cwd(), poolPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Node pool not found: ${resolved}`);
    console.error('Generate it from scripts/eval/fixtures/locomo-node-pool.json (Task 1 of plan 40-04).');
    process.exit(1);
  }
  const pool = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(pool) || pool.length === 0) {
    console.error('Node pool must be a non-empty JSON array of strings.');
    process.exit(1);
  }
  return pool;
}

// ---- populate scratch DB with N nodes from the pool -------------------------

/**
 * Insert N nodes into the scratch DB by cycling the pool.
 * Uses SemanticStore.upsertNode + SemanticStore.setEmbedding so that
 * CandidateRetriever.topk() can scan them (requires node.embedding IS NOT NULL).
 *
 * Random unit vectors are used for embeddings — the cosine scores are not
 * meaningful here, only the scan cost (which scales with N × dims).
 *
 * @param {Database.Database} db      Scratch DB instance.
 * @param {object}            config  Engine config (with dbPath).
 * @param {string[]}          pool    Node value pool (cycled when N > pool.length).
 * @param {number}            n       Number of nodes to insert.
 * @param {number}            dims    Embedding dimensionality.
 */
function populateScratchDb(db, config, pool, n, dims) {
  const store = new SemanticStore(db, realClock, config);

  for (let i = 0; i < n; i++) {
    const value = pool[i % pool.length];
    const id    = `lc-node-${i}`;

    store.upsertNode({
      id,
      type:   'fact',
      value:  `${value} [${i}]`,  // suffix index to ensure uniqueness per node
      origin: 'observed',
      s:      0.5,
      c:      0.5,
    });

    // Random unit vector for cosine scan cost measurement
    const raw = new Float32Array(dims);
    for (let d = 0; d < dims; d++) {
      raw[d] = (Math.random() * 2) - 1;  // uniform [-1, 1]
    }
    // Normalize to unit vector
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += raw[d] * raw[d];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < dims; d++) raw[d] /= norm;

    store.setEmbedding(id, raw);
  }
}

// ---- build query vectors (mock or real) -------------------------------------

/**
 * Produce QUERIES_PER_N query vectors for the latency measurement.
 * In mock mode: zero Float32Arrays (no API call).
 * In real mode: embed the first QUERIES_PER_N pool values via OpenAIEmbedder.
 *
 * @param {string[]}          pool      Node value pool.
 * @param {OpenAIEmbedder|null} embedder Real embedder (null in mock mode).
 * @param {number}            dims      Embedding dimensionality.
 * @returns {Promise<Float32Array[]>}
 */
async function buildQueryVectors(pool, embedder, dims) {
  const queryStrings = [];
  for (let i = 0; i < QUERIES_PER_N; i++) {
    queryStrings.push(pool[i % pool.length]);
  }

  if (IS_MOCK_EMBED) {
    // Zero vectors for --mock-embed / --quick (no API calls)
    return queryStrings.map(() => new Float32Array(dims));
  }

  // Real embed: batch all queries at once to minimise round-trips
  const vecs = await embedder.embed(queryStrings);
  return vecs;
}

// ---- commit hash helper -----------------------------------------------------

function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ---- main -------------------------------------------------------------------

(async () => {
  const pool   = loadNodePool(POOL_PATH);
  const dims   = DEFAULT_CONFIG.embeddingDimensions || 1536;
  const commit = getCommitHash();

  const embedder = IS_MOCK_EMBED
    ? null
    : new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, dims);

  console.log(`[latency-curve] mode: ${IS_QUICK ? 'quick' : IS_MOCK_EMBED ? 'mock-embed' : 'full'}`);
  console.log(`[latency-curve] N-list: ${N_LIST.join(', ')} | queries-per-n: ${QUERIES_PER_N} | K: ${K}`);
  console.log(`[latency-curve] pool: ${pool.length} values | embed: ${IS_MOCK_EMBED ? 'mock (zero vectors)' : DEFAULT_CONFIG.openaiEmbedModel}`);

  // Build query vectors ONCE — same queries reused across all N values
  const queryVectors = await buildQueryVectors(pool, embedder, dims);
  console.log(`[latency-curve] embedded ${queryVectors.length} query vectors`);

  const curve = [];

  for (const n of N_LIST) {
    process.stdout.write(`[latency-curve] N=${n}: populating scratch DB... `);
    const scratch = makeScratchDb();

    try {
      populateScratchDb(scratch.db, scratch.config, pool, n, dims);

      const retriever = new CandidateRetriever(scratch.db);

      // Verify node count with embedded vectors
      const nodeCount = scratch.db
        .prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned=0 AND embedding IS NOT NULL')
        .get().n;

      process.stdout.write(`${nodeCount} nodes ready. Timing topk()... `);

      const latencies = [];

      for (const qVec of queryVectors) {
        // Retrieval-ONLY timing: wraps ONLY the topk() call (Pitfall 4, BENCH-02)
        const t0 = Date.now();
        retriever.topk(qVec, K);
        const ms = Date.now() - t0;
        latencies.push(ms);
      }

      // Sort ascending, then compute percentiles
      latencies.sort((a, b) => a - b);

      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);

      console.log(`p50=${p50}ms p95=${p95}ms samples=${latencies.length}`);

      curve.push({
        n_nodes: n,
        p50_ms:  p50,
        p95_ms:  p95,
        samples: latencies.length,
      });

    } finally {
      scratch.cleanup();
    }
  }

  // ---- write output -----------------------------------------------------------

  const outPath = path.resolve(process.cwd(), OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const result = {
    meta: {
      eval:           'latency-curve',
      date:           new Date().toISOString(),
      commit,
      engine_version: (DEFAULT_CONFIG.engineVersion || '0.1.0'),
      embed_model:    IS_MOCK_EMBED ? 'mock-zero-vector' : DEFAULT_CONFIG.openaiEmbedModel,
      k:              K,
      queries_per_n:  QUERIES_PER_N,
      mock_embed:     IS_MOCK_EMBED,
    },
    curve,
  };

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`[latency-curve] written: ${outPath}`);

  // Print summary table
  console.log('\n  N        p50 (ms)   p95 (ms)   samples');
  console.log('  -------  ---------  ---------  -------');
  for (const row of curve) {
    const nStr   = String(row.n_nodes).padStart(7);
    const p50Str = String(row.p50_ms).padStart(9);
    const p95Str = String(row.p95_ms).padStart(9);
    const sStr   = String(row.samples).padStart(7);
    console.log(`  ${nStr}  ${p50Str}  ${p95Str}  ${sStr}`);
  }
})();
