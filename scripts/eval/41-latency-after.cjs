/**
 * 41-latency-after — Phase 41 PERF-02 measurement on the INDEXED path.
 *
 * Measures the indexed retrieval latency two ways and records them for comparison against
 * the committed Phase-40 baseline (45/46 ms warm, live-latency.cjs over the live brain):
 *
 *   WARM (in-process, the serve/mcp surface): build/load the index ONCE, time only the
 *     per-query `CandidateRetriever.topk` scan. Comparable to the 45/46 ms baseline.
 *
 *   COLD (subprocess per query, the FELT SessionStart-inject / recall-cli surface — D-08
 *     headline): a fresh `node` process per query that opens the live DB read-only,
 *     constructs `CandidateRetriever(db, { indexPath })` exactly as session-start-cli.ts:128
 *     / recall-cli.ts:147 do, runs ONE topk over the persisted sidecar, prints, exits. This
 *     reads the PRE-BUILT `<dbPath>.vindex` — the D-06 cold win — NOT a from-scratch rebuild
 *     (the spike's cold cell rebuilt from rows and was the upper bound; this is the real path).
 *
 * For an apples-to-apples same-machine delta (run-to-run noise differs from the Phase-40
 * machine state), the harness ALSO measures the brute-force baseline in BOTH modes in the
 * same run, so the report can quote both the absolute Phase-40 anchor AND a same-run delta.
 *
 * Read-only on the live brain throughout. Requires the sidecar to already exist; asserts it.
 *
 * Run:
 *   node scripts/eval/41-latency-after.cjs                       # mock unit-vector queries (API-free)
 *   OPENAI_API_KEY=... node scripts/eval/41-latency-after.cjs --real-embed
 *   node scripts/eval/41-latency-after.cjs --out <path> --repeats 5
 *
 * Internal (do not invoke directly): --cold-worker <mechanism> --cold-q <i> [--real-embed]
 *   one fresh-process scan emitting `COLDMS <ms>`; used by the COLD harness.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
const { CandidateRetriever, vectorIndexPath } = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const REAL_EMBED = process.argv.includes('--real-embed');
const K       = parseInt(arg('--k', '10'), 10) || 10;
const REPEATS = parseInt(arg('--repeats', '5'), 10) || 5;
const OUT     = arg('--out', 'scripts/eval/results/41-latency-after.json');
const DIMS    = DEFAULT_CONFIG.embeddingDimensions || 1536;
const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');
const INDEX_PATH = vectorIndexPath(DB_PATH);

const QUERIES = [
  'When did the user move to a new city?',
  'What hobby did the user pick up recently?',
  'Who did the user have a conflict with at work?',
  "What is the user's favorite kind of music?",
  'How many siblings does the user have?',
  'What health issue was the user dealing with?',
  'Where did the user go on vacation last year?',
  'What pet does the user own?',
  'What did the user study in school?',
  'What is the user planning to do next month?',
  "Who is the user's closest friend?",
  'What food does the user dislike?',
  'What car does the user drive?',
  'What was the user celebrating recently?',
  'What book did the user mention reading?',
  'What sport does the user play?',
  "What is the user's job?",
  'What gift did the user give someone?',
  'What concern did the user raise about money?',
  'What goal is the user working toward?',
];

// ceil-based percentile (matches latency-curve.cjs / spike).
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function getCommitHash() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function mockVector(seed) {
  const v = new Float32Array(DIMS);
  let s = (seed + 1) * 2654435761 >>> 0;
  for (let i = 0; i < DIMS; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    v[i] = ((s & 0xffff) / 0xffff) * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return v;
}

async function embedQueries() {
  if (!REAL_EMBED) return QUERIES.map((_, i) => mockVector(i));
  const { OpenAIEmbedder } = require(DIST + '/model/embedder');
  const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DIMS);
  return embedder.embed(QUERIES);
}

// ---- COLD worker (one fresh-process scan, real cold path) -------------------
// `indexed`  → CandidateRetriever(db, { indexPath }) reading the PERSISTED sidecar
//              (the real session-start-cli / recall-cli path).
// `baseline` → CandidateRetriever(db) brute-force (the Phase-40 cold reference).
async function runColdWorker() {
  const mechanism = arg('--cold-worker');
  const qIdx = parseInt(arg('--cold-q', '0'), 10) || 0;

  let queryVec;
  if (REAL_EMBED) {
    const { OpenAIEmbedder } = require(DIST + '/model/embedder');
    const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DIMS);
    [queryVec] = await embedder.embed([QUERIES[qIdx]]);
  } else {
    queryVec = mockVector(qIdx);
  }

  // Time from db-open through scan — the felt cold work after spawn (spawn itself is
  // captured by the parent's wall-clock around spawnSync).
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const retriever = mechanism === 'indexed'
    ? new CandidateRetriever(db, { indexPath: INDEX_PATH })
    : new CandidateRetriever(db);
  const t0 = Date.now();
  retriever.topk(queryVec, K);
  const ms = Date.now() - t0;
  db.close();
  process.stdout.write(`COLDMS ${ms}\n`);
}

// Parent-side cold timing: wall-clock around the whole subprocess (spawn + open + scan) —
// the true felt latency. Also collects the worker's internal open+scan ms for diagnostics.
function measureCold(mechanism, queryCount) {
  const wall = [];
  const inner = [];
  const baseArgs = [__filename, '--cold-worker', mechanism, '--k', String(K)];
  if (REAL_EMBED) baseArgs.push('--real-embed');

  for (let r = 0; r < REPEATS; r++) {
    for (let q = 0; q < queryCount; q++) {
      const a = baseArgs.concat(['--cold-q', String(q)]);
      const t0 = Date.now();
      const res = spawnSync(process.execPath, a, { encoding: 'utf8' });
      const ms = Date.now() - t0;
      if (res.status !== 0) {
        throw new Error(`cold worker ${mechanism} q=${q} exited ${res.status}: ${res.stderr || ''}`);
      }
      wall.push(ms);
      const line = (res.stdout.split('\n').find(l => l.startsWith('COLDMS ')) || 'COLDMS 0');
      inner.push(parseInt(line.slice('COLDMS '.length), 10) || 0);
    }
  }
  wall.sort((a, b) => a - b);
  inner.sort((a, b) => a - b);
  return {
    wall_p50_ms: percentile(wall, 50), wall_p95_ms: percentile(wall, 95),
    inner_p50_ms: percentile(inner, 50), inner_p95_ms: percentile(inner, 95),
    samples: wall.length,
  };
}

function measureWarm(retriever, vecs) {
  for (const v of vecs) retriever.topk(v, K); // warm-up, discarded
  const lat = [];
  for (let r = 0; r < REPEATS; r++) {
    for (const v of vecs) {
      const t0 = Date.now();
      retriever.topk(v, K);
      lat.push(Date.now() - t0);
    }
  }
  lat.sort((a, b) => a - b);
  return { p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95), samples: lat.length };
}

(async () => {
  if (process.argv.includes('--cold-worker')) {
    await runColdWorker();
    return;
  }

  if (!fs.existsSync(INDEX_PATH)) {
    console.error(`[41-after] FATAL: sidecar ${INDEX_PATH} absent — build it before measuring the cold win (otherwise 'indexed' silently falls back to brute-force).`);
    process.exit(2);
  }

  const commit = getCommitHash();
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const nodeCount = db
    .prepare('SELECT count(*) AS n FROM node WHERE embedding IS NOT NULL AND tombstoned = 0')
    .get().n;

  console.log(`[41-after] DB=${DB_PATH} embedded_live_nodes=${nodeCount} K=${K} repeats=${REPEATS} embed=${REAL_EMBED ? DEFAULT_CONFIG.openaiEmbedModel : 'mock'}`);
  console.log(`[41-after] sidecar=${INDEX_PATH} (${fs.statSync(INDEX_PATH).size} bytes)`);

  const vecs = await embedQueries();

  // WARM
  const warmIndexed  = measureWarm(new CandidateRetriever(db, { indexPath: INDEX_PATH }), vecs);
  const warmBaseline = measureWarm(new CandidateRetriever(db), vecs);
  console.log(`[41-after] warm indexed  p50=${warmIndexed.p50_ms}ms p95=${warmIndexed.p95_ms}ms`);
  console.log(`[41-after] warm baseline p50=${warmBaseline.p50_ms}ms p95=${warmBaseline.p95_ms}ms`);

  db.close(); // close before spawning cold subprocesses

  // COLD (subprocess per query)
  console.log('[41-after] measuring COLD (subprocess spawn + open db + scan)...');
  const coldIndexed  = measureCold('indexed', vecs.length);
  const coldBaseline = measureCold('baseline', vecs.length);
  console.log(`[41-after] cold indexed  wall p50=${coldIndexed.wall_p50_ms}ms p95=${coldIndexed.wall_p95_ms}ms (inner p50=${coldIndexed.inner_p50_ms}ms)`);
  console.log(`[41-after] cold baseline wall p50=${coldBaseline.wall_p50_ms}ms p95=${coldBaseline.wall_p95_ms}ms (inner p50=${coldBaseline.inner_p50_ms}ms)`);

  const out = {
    meta: {
      eval: '41-latency-after',
      date: new Date().toISOString(),
      commit,
      db_path: DB_PATH,
      sidecar: INDEX_PATH,
      embedded_live_nodes: nodeCount,
      k: K,
      repeats: REPEATS,
      embed: REAL_EMBED ? DEFAULT_CONFIG.openaiEmbedModel : 'mock-seeded-unit-vector',
      phase40_baseline_warm: { p50_ms: 45, p95_ms: 46, source: 'live-latency.cjs, 40-BASELINE.md §2' },
    },
    warm: { indexed: warmIndexed, baseline_same_run: warmBaseline },
    cold: { indexed: coldIndexed, baseline_same_run: coldBaseline },
  };

  const outPath = path.resolve(process.cwd(), OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`[41-after] written: ${outPath}`);
})().catch(e => { console.error('41-after error:', e.stack || e.message); process.exit(1); });
