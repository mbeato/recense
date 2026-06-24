/**
 * 41-index-spike — Phase 41 mechanism spike (PERF-01/02, D-03/D-04/D-09).
 *
 * Resolves the vector-index mechanism question on REAL numbers from the live brain
 * BEFORE the implementation commits to a dependency. Compares THREE exact retrievers
 * at k=10 over the same query set, in TWO timing modes each (D-09):
 *
 *   (1) baseline   — CandidateRetriever.topk (current brute-force O(N) cosine scan).
 *   (2) zero-dep   — one contiguous flat Float32Array (rows × dims) + precomputed
 *                    Float64Array norms + id array; scan via dot-over-precomputed-norms.
 *                    This IS the derived/rebuildable index of D-03(a). Zero new deps.
 *   (3) sqlite-vec — vec0 loadable extension over a SCRATCH tmpdir copy (NEVER the live
 *                    DB). If the extension binary is not installed/loadable on this
 *                    platform, recorded as `unavailable` with the load-error string —
 *                    the harness still produces a decision from baseline + zero-dep.
 *
 * Timing modes (D-09):
 *   - WARM scan-only : build the index/cache ONCE, time only the per-query scan loop
 *                      (matches the serve/mcp in-process path; comparable to the 45/46 ms
 *                      Phase-40 baseline).
 *   - COLD end-to-end: a full fresh `node` subprocess per query (spawn → open db →
 *                      build/attach index → single scan → print) via spawnSync, so the
 *                      felt SessionStart-inject / recall-cli path is captured. The zero-dep
 *                      cold cost includes building the flat buffer from scratch — this is
 *                      the lower bound; a real cold process would read a persisted sidecar
 *                      (D-06), so the from-scratch number OVERSTATES the persisted cold path.
 *
 * Read-only on the live brain throughout (readonly:true, fileMustExist:true). All
 * sqlite-vec work happens on a tmpdir copy of the live DB — never the live file (T-41-01).
 * sqlite-vec is loaded ONLY here for measurement; NOT added to package.json (T-41-02).
 *
 * Output: scripts/eval/results/41-index-spike.json
 *   { meta:{eval, date, commit, node_count, k, mock_embed}, results:[{mechanism, mode,
 *     p50_ms, p95_ms, samples}], topk_equivalence:{...}, sqlite_vec:{...} }
 *
 * Run:
 *   node scripts/eval/41-index-spike.cjs --mock-embed                 # API-free / CI
 *   OPENAI_API_KEY=... node scripts/eval/41-index-spike.cjs          # real live-brain run
 *   node scripts/eval/41-index-spike.cjs --out <path>
 *
 * Internal (do not invoke directly): --cold-worker <mechanism> <queryIndex>
 *   single fresh-process scan emitting `COLDTOPK <json ids>` — used by the COLD harness.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
const { CandidateRetriever } = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG }     = require(DIST + '/lib/config');
const { OpenAIEmbedder }     = require(DIST + '/model/embedder');

// ---- arg parsing ------------------------------------------------------------

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const IS_MOCK_EMBED = process.argv.includes('--mock-embed');
const K             = parseInt(arg('--k', '10'), 10) || 10;
const REPEATS       = parseInt(arg('--repeats', '5'), 10) || 5;
const OUT           = arg('--out', 'scripts/eval/results/41-index-spike.json');
const DIMS          = DEFAULT_CONFIG.embeddingDimensions || 1536;

const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');

// QUERIES reused from live-latency.cjs (the warm-only baseline tool) so the spike's
// deltas report against the SAME cue set as the Phase-40 45/46 ms number.
const QUERIES = [
  'When did the user move to a new city?',
  'What hobby did the user pick up recently?',
  "Who did the user have a conflict with at work?",
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

// ---- shared helpers ---------------------------------------------------------

// ceil-based percentile (matches latency-curve.cjs PATTERNS §443-446)
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

function getCommitHash() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

// Pitfall 5: decode an embedding BLOB with byteOffset + length (Buffer slices may
// have a nonzero byteOffset, so `new Float32Array(buf.buffer)` would be wrong).
function decodeEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Embed the QUERIES set. Mock mode returns a deterministic non-zero unit vector per
// query (a zero vector makes every cosine 0, collapsing the top-k tie set and making
// the equivalence check meaningless). Seeded by query index so cold-worker subprocesses
// reproduce the SAME query vector without re-embedding.
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
  if (IS_MOCK_EMBED) return QUERIES.map((_, i) => mockVector(i));
  const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DIMS);
  return embedder.embed(QUERIES);
}

// ---- zero-dep flat-buffer index (D-03a) -------------------------------------

// Load ALL live embeddings ONCE into a single contiguous flat Float32Array
// (rows × dims) plus a parallel precomputed-norms Float64Array and an id array.
// This is the rebuildable derived index. Returns the build object + build time (ms).
function buildFlatIndex(db) {
  const t0 = Date.now();
  const rows = db.prepare(
    'SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0'
  ).all();

  const n = rows.length;
  const flat  = new Float32Array(n * DIMS);
  const norms = new Float64Array(n);
  const ids   = new Array(n);

  let w = 0;
  for (let r = 0; r < n; r++) {
    const v = decodeEmbedding(rows[r].embedding);
    if (v.length !== DIMS) continue; // L-2: skip dim-mismatched legacy rows
    let norm = 0;
    const base = w * DIMS;
    for (let d = 0; d < DIMS; d++) {
      const x = v[d];
      flat[base + d] = x;
      norm += x * x;
    }
    norms[w] = Math.sqrt(norm);
    ids[w] = rows[r].id;
    w++;
  }
  return { flat, norms, ids, count: w, buildMs: Date.now() - t0 };
}

// Scan the flat buffer for one query: cosine = dot / (||q|| * precomputed_norm).
function flatTopk(index, queryVec, k) {
  const { flat, norms, ids, count } = index;
  let qNorm = 0;
  for (let d = 0; d < DIMS; d++) qNorm += queryVec[d] * queryVec[d];
  qNorm = Math.sqrt(qNorm);

  const scored = new Array(count);
  for (let r = 0; r < count; r++) {
    let dot = 0;
    const base = r * DIMS;
    for (let d = 0; d < DIMS; d++) dot += queryVec[d] * flat[base + d];
    const denom = qNorm * norms[r];
    scored[r] = { id: ids[r], score: denom === 0 ? 0 : dot / denom };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ---- sqlite-vec (D-03b) — best-effort, scratch-copy only --------------------

// Attempt to load the sqlite-vec vec0 extension and run KNN over a tmpdir COPY of
// the live DB. Returns { available:true, topkFn, scratchPath } or
// { available:false, error }. NEVER touches the live DB file.
function trySqliteVec(liveDbPath) {
  let sqliteVec;
  try {
    sqliteVec = require('sqlite-vec');
  } catch (e) {
    return { available: false, error: `sqlite-vec module not installed: ${e.message}` };
  }
  let scratchPath;
  try {
    // Copy the live DB to a tmpdir scratch file (T-41-01: never load the extension
    // against the live file; the vec0 virtual table is built in the scratch copy).
    scratchPath = path.join(os.tmpdir(), `41-spike-vec-${process.pid}-${Date.now()}.db`);
    fs.copyFileSync(liveDbPath, scratchPath);

    const sdb = new Database(scratchPath);
    sqliteVec.load(sdb); // throws if the platform binary is absent/unloadable

    // Build a vec0 virtual table from the live embeddings (exact KNN).
    sdb.exec(`CREATE VIRTUAL TABLE vec_nodes USING vec0(embedding float[${DIMS}])`);
    const rows = sdb.prepare(
      'SELECT rowid, id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0'
    ).all();
    const idByRowid = new Map();
    const ins = sdb.prepare('INSERT INTO vec_nodes(rowid, embedding) VALUES (?, ?)');
    const insTx = sdb.transaction((rs) => {
      for (const r of rs) {
        const v = decodeEmbedding(r.embedding);
        if (v.length !== DIMS) continue;
        ins.run(r.rowid, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        idByRowid.set(r.rowid, r.id);
      }
    });
    insTx(rows);

    const knn = sdb.prepare(
      'SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
    );
    const topkFn = (queryVec, k) => {
      const buf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
      const hits = knn.all(buf, k);
      // vec0 default distance is L2; for UNIT vectors L2-rank == cosine-rank. We DO NOT
      // claim vec0 returns cosine scores here — the spike measures rank/latency only and
      // checks set-equivalence against brute-force cosine. (41-02 owns the cosine-distance
      // metric choice if vec-sqlite is selected.)
      return hits.map(h => ({ id: idByRowid.get(h.rowid), score: -h.distance }));
    };
    return { available: true, topkFn, scratchPath, db: sdb, count: idByRowid.size };
  } catch (e) {
    try { if (scratchPath) fs.unlinkSync(scratchPath); } catch {}
    return { available: false, error: `sqlite-vec load/build failed: ${e.message}` };
  }
}

// ---- COLD worker (single fresh-process scan) --------------------------------
// Invoked as a subprocess: `node 41-index-spike.cjs --cold-worker <mechanism> <qIdx> [--mock-embed]`.
// Builds the index from scratch, runs ONE scan, prints `COLDTOPK <json ids>`, exits.
async function runColdWorker() {
  const mechanism = arg('--cold-worker');
  const qIdx = parseInt(arg('--cold-q', '0'), 10) || 0;

  let queryVec;
  if (IS_MOCK_EMBED) {
    queryVec = mockVector(qIdx);
  } else {
    const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DIMS);
    [queryVec] = await embedder.embed([QUERIES[qIdx]]);
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let ids;
  if (mechanism === 'baseline') {
    const retriever = new CandidateRetriever(db);
    ids = retriever.topk(queryVec, K).map(h => h.id);
  } else if (mechanism === 'zero-dep') {
    const index = buildFlatIndex(db); // from-scratch build is part of the cold cost
    ids = flatTopk(index, queryVec, K).map(h => h.id);
  } else {
    db.close();
    process.stdout.write('COLDTOPK []\n');
    return;
  }
  db.close();
  process.stdout.write('COLDTOPK ' + JSON.stringify(ids) + '\n');
}

// Time a full cold subprocess per query for a mechanism. Returns {p50, p95, samples, lastIdsByQuery}.
function measureCold(mechanism, queryCount) {
  const latencies = [];
  const idsByQuery = [];
  const baseArgs = [__filename, '--cold-worker', mechanism, '--k', String(K)];
  if (IS_MOCK_EMBED) baseArgs.push('--mock-embed');

  for (let r = 0; r < REPEATS; r++) {
    for (let q = 0; q < queryCount; q++) {
      const a = baseArgs.concat(['--cold-q', String(q)]);
      const t0 = Date.now();
      const res = spawnSync(process.execPath, a, { encoding: 'utf8' });
      const ms = Date.now() - t0;
      if (res.status !== 0) {
        throw new Error(`cold worker ${mechanism} q=${q} exited ${res.status}: ${res.stderr || ''}`);
      }
      latencies.push(ms);
      if (r === 0) {
        const line = (res.stdout.split('\n').find(l => l.startsWith('COLDTOPK ')) || 'COLDTOPK []');
        idsByQuery[q] = JSON.parse(line.slice('COLDTOPK '.length));
      }
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    samples: latencies.length,
    idsByQuery,
  };
}

// ---- set equivalence (D-10) -------------------------------------------------
// Two top-k id lists are equivalent if their SETS match. Identical-score tie reorder
// is tolerated automatically because set comparison is order-independent; genuine
// membership differences (a different node entirely) are caught.
function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every(x => sb.has(x));
}

// ---- main -------------------------------------------------------------------

(async () => {
  if (process.argv.includes('--cold-worker')) {
    await runColdWorker();
    return;
  }

  const commit = getCommitHash();
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const nodeCount = db.prepare(
    'SELECT count(*) AS n FROM node WHERE embedding IS NOT NULL AND tombstoned = 0'
  ).get().n;

  console.log(`[41-spike] DB=${DB_PATH} embedded_live_nodes=${nodeCount} K=${K} repeats=${REPEATS} mock=${IS_MOCK_EMBED}`);

  const queryVecs = await embedQueries();
  console.log(`[41-spike] embedded ${queryVecs.length} query vectors (${IS_MOCK_EMBED ? 'mock' : DEFAULT_CONFIG.openaiEmbedModel})`);

  const results = [];

  // ---- BASELINE (warm) ----
  const baseRetriever = new CandidateRetriever(db);
  const baselineWarmIds = [];
  {
    for (const v of queryVecs) baseRetriever.topk(v, K); // warm-up
    const lat = [];
    for (let r = 0; r < REPEATS; r++) {
      for (let qi = 0; qi < queryVecs.length; qi++) {
        const t0 = Date.now();
        const hits = baseRetriever.topk(queryVecs[qi], K);
        lat.push(Date.now() - t0);
        if (r === 0) baselineWarmIds[qi] = hits.map(h => h.id);
      }
    }
    lat.sort((a, b) => a - b);
    results.push({ mechanism: 'baseline', mode: 'warm', p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95), samples: lat.length });
    console.log(`[41-spike] baseline warm p50=${percentile(lat,50)}ms p95=${percentile(lat,95)}ms`);
  }

  // ---- ZERO-DEP (warm) ----
  const flatIndex = buildFlatIndex(db);
  console.log(`[41-spike] zero-dep flat index built: ${flatIndex.count} vecs in ${flatIndex.buildMs}ms`);
  const zeroWarmIds = [];
  {
    for (const v of queryVecs) flatTopk(flatIndex, v, K); // warm-up
    const lat = [];
    for (let r = 0; r < REPEATS; r++) {
      for (let qi = 0; qi < queryVecs.length; qi++) {
        const t0 = Date.now();
        const hits = flatTopk(flatIndex, queryVecs[qi], K);
        lat.push(Date.now() - t0);
        if (r === 0) zeroWarmIds[qi] = hits.map(h => h.id);
      }
    }
    lat.sort((a, b) => a - b);
    results.push({ mechanism: 'zero-dep', mode: 'warm', p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95), samples: lat.length });
    console.log(`[41-spike] zero-dep warm p50=${percentile(lat,50)}ms p95=${percentile(lat,95)}ms`);
  }

  // ---- sqlite-vec (warm) — best-effort ----
  const vec = trySqliteVec(DB_PATH);
  const vecWarmIds = [];
  let sqliteVecMeta;
  if (vec.available) {
    console.log(`[41-spike] sqlite-vec available: ${vec.count} vecs in vec0 scratch table`);
    for (const v of queryVecs) vec.topkFn(v, K); // warm-up
    const lat = [];
    for (let r = 0; r < REPEATS; r++) {
      for (let qi = 0; qi < queryVecs.length; qi++) {
        const t0 = Date.now();
        const hits = vec.topkFn(queryVecs[qi], K);
        lat.push(Date.now() - t0);
        if (r === 0) vecWarmIds[qi] = hits.map(h => h.id);
      }
    }
    lat.sort((a, b) => a - b);
    results.push({ mechanism: 'sqlite-vec', mode: 'warm', p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95), samples: lat.length });
    console.log(`[41-spike] sqlite-vec warm p50=${percentile(lat,50)}ms p95=${percentile(lat,95)}ms`);
    sqliteVecMeta = { available: true, vec_count: vec.count };
    try { vec.db.close(); } catch {}
    try { fs.unlinkSync(vec.scratchPath); } catch {}
  } else {
    console.log(`[41-spike] sqlite-vec UNAVAILABLE: ${vec.error}`);
    sqliteVecMeta = { available: false, error: vec.error };
  }

  db.close(); // close live DB before spawning cold subprocesses (each opens its own)

  // ---- COLD end-to-end (subprocess per query) ----
  console.log('[41-spike] measuring COLD end-to-end (subprocess spawn + build + scan)...');
  const baseCold = measureCold('baseline', queryVecs.length);
  results.push({ mechanism: 'baseline', mode: 'cold', p50_ms: baseCold.p50_ms, p95_ms: baseCold.p95_ms, samples: baseCold.samples });
  console.log(`[41-spike] baseline cold p50=${baseCold.p50_ms}ms p95=${baseCold.p95_ms}ms`);

  const zeroCold = measureCold('zero-dep', queryVecs.length);
  results.push({ mechanism: 'zero-dep', mode: 'cold', p50_ms: zeroCold.p50_ms, p95_ms: zeroCold.p95_ms, samples: zeroCold.samples });
  console.log(`[41-spike] zero-dep cold p50=${zeroCold.p50_ms}ms p95=${zeroCold.p95_ms}ms`);
  // NOTE: zero-dep cold includes the from-scratch flat-buffer build (lower bound).
  // A real cold process reads a persisted sidecar (D-06), so this OVERSTATES the persisted path.

  // ---- top-k SET equivalence (D-10) ----
  let zeroWarmMatch = 0, zeroColdMatch = 0, vecWarmMatch = 0;
  for (let qi = 0; qi < queryVecs.length; qi++) {
    if (setsEqual(baselineWarmIds[qi], zeroWarmIds[qi])) zeroWarmMatch++;
    if (zeroCold.idsByQuery[qi] && setsEqual(baselineWarmIds[qi], zeroCold.idsByQuery[qi])) zeroColdMatch++;
    if (vec.available && vecWarmIds[qi] && setsEqual(baselineWarmIds[qi], vecWarmIds[qi])) vecWarmMatch++;
  }
  const topk_equivalence = {
    queries: queryVecs.length,
    zero_dep_warm_vs_baseline: `${zeroWarmMatch}/${queryVecs.length}`,
    zero_dep_cold_vs_baseline: `${zeroColdMatch}/${queryVecs.length}`,
    sqlite_vec_warm_vs_baseline: vec.available ? `${vecWarmMatch}/${queryVecs.length}` : 'unavailable',
    note: 'set-equivalence; identical-score tie reorder tolerated automatically (order-independent set compare, D-10).',
  };
  console.log(`[41-spike] top-k equivalence (zero-dep warm vs baseline): ${zeroWarmMatch}/${queryVecs.length}`);

  // ---- write output ----
  const outPath = path.resolve(process.cwd(), OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = {
    meta: {
      eval: '41-index-spike',
      date: new Date().toISOString(),
      commit,
      node_count: nodeCount,
      k: K,
      repeats: REPEATS,
      mock_embed: IS_MOCK_EMBED,
      embed_model: IS_MOCK_EMBED ? 'mock-seeded-unit-vector' : DEFAULT_CONFIG.openaiEmbedModel,
      flat_index_build_ms: flatIndex.buildMs,
      baseline_warm_ref_phase40: { p50_ms: 45, p95_ms: 46, note: 'Phase 40 live-latency.cjs over ~11.3k nodes' },
    },
    results,
    topk_equivalence,
    sqlite_vec: sqliteVecMeta,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`[41-spike] written: ${outPath}`);
})().catch(e => { console.error('41-spike error:', e.stack || e.message); process.exit(1); });
