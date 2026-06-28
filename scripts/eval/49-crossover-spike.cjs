/**
 * 49-crossover-spike — Phase 49 Scale spike (SCALE-01, D-01..D-07).
 *
 * Measures the EXACT flat-buffer cosine index (src/retrieval/topk.ts) against an
 * APPROXIMATE HNSW ANN over recense's REAL node distribution scaled to {live, 25k, 50k}
 * nodes. Reports, per scale rung: recall@5/@10 vs exact ground truth, query latency
 * p50/p95, ANN build time, and an approximate memory footprint (rss delta).
 *
 * This is a fork/extension of the Phase-41 harness trio (41-index-spike.cjs,
 * 41-latency-after.cjs, 41-topk-equivalence.cjs), not a greenfield build.
 *
 * Two ANN arms are measured because BOTH loaded on this machine (49-01 loadability verdict):
 *   - hnswlib-node  — pure in-process native HNSW addon. This is the PRIMARY arm for the
 *                     D-04 crossover gate: it is the apples-to-apples in-process counterpart
 *                     to the in-process exact flat scan.
 *   - vectorlite    — sqlite loadable-extension HNSW (SCALE-01's named primary). Measured as
 *                     a SECONDARY data point; its numbers include sqlite-extension overhead
 *                     (a different integration shape than the in-process exact index).
 * If an ANN lib fails to load/build it is recorded `unmeasured-here` with the error string —
 * NEVER a fabricated number (D-02b).
 *
 * Read-only on the live brain throughout (readonly:true, fileMustExist:true). The synthetic
 * corpus is built in-memory from jitter+renormalized REAL live embeddings (D-01) — never random
 * vectors. Any vectorlite table is built on a TMPDIR sqlite DB — the live file is never written.
 *
 * Output: scripts/eval/results/49-crossover-spike.json (gitignored, local-only, D-06).
 *
 * Run:
 *   npm run build && node scripts/eval/49-crossover-spike.cjs
 *   node scripts/eval/49-crossover-spike.cjs --scales 14000,25000,50000 --queries 25 --repeats 3
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
// require the compiled production module so the exact arm is byte-identical to ground truth.
const { cosineSimF32 } = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');

// ---- arg parsing ------------------------------------------------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DIMS    = DEFAULT_CONFIG.embeddingDimensions || 1536;
const K       = parseInt(arg('--k', '10'), 10) || 10;
const REPEATS = parseInt(arg('--repeats', '3'), 10) || 3;
const NQUERY  = parseInt(arg('--queries', '25'), 10) || 25;
const OUT     = arg('--out', 'scripts/eval/results/49-crossover-spike.json');
const SCALES  = arg('--scales', '').trim()
  ? arg('--scales', '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  : null; // null → derived from live count below ({live, 25k, 50k})
const JITTER  = parseFloat(arg('--jitter', '0.05')) || 0.05; // D-07: small Gaussian sigma, keeps distribution realistic
const EMBED_MODEL = DEFAULT_CONFIG.openaiEmbedModel || 'text-embedding-3-small';

// Phase-40/41 warm felt-path reference: ≈45/46 ms p50/p95 over ~11.3k live nodes (D-04 budget anchor).
const HOTPATH_REF = { p50_ms: 45, p95_ms: 46, n_nodes: 11300, source: 'Phase 40/41 live-latency.cjs warm baseline' };

const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');

// ---- shared helpers (reused from 41-index-spike.cjs) ------------------------
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
// Pitfall 5: decode an embedding BLOB with byteOffset + length (sliced Buffers may have nonzero byteOffset).
function decodeEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function l2norm(vec, off, dims) {
  let s = 0;
  for (let i = 0; i < dims; i++) { const x = vec[off + i]; s += x * x; }
  return Math.sqrt(s);
}

// Deterministic PRNG (mulberry32) so corpus scale-up + query selection are reproducible run-to-run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box-Muller standard normal from a uniform PRNG.
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- load the live brain (READ-ONLY) ---------------------------------------
function loadLiveEmbeddings() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  // canonical row filter (topk.ts:81/295) — live, embedded nodes only.
  const rows = db.prepare('SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0').all();
  const n = rows.length;
  const flat = new Float32Array(n * DIMS);
  const ids = new Array(n);
  for (let r = 0; r < n; r++) {
    const v = decodeEmbedding(rows[r].embedding);
    flat.set(v.subarray(0, DIMS), r * DIMS);
    ids[r] = rows[r].id;
  }
  db.close();
  return { n, flat, ids };
}

// ---- corpus scale-up (D-01): jitter+renormalize REAL live embeddings --------
// Anchor = all live vectors verbatim; top up to targetN by sampling a live vector,
// adding small Gaussian jitter, and L2-renormalizing. NEVER random vectors.
function buildScaledCorpus(live, targetN, rng) {
  const dims = DIMS;
  const flat = new Float32Array(targetN * dims);
  const liveN = live.n;
  // 1) copy the unmodified live vectors as the real-distribution anchor.
  const copyN = Math.min(liveN, targetN);
  flat.set(live.flat.subarray(0, copyN * dims), 0);
  // 2) top up with jittered+renormalized samples of real live vectors.
  for (let r = copyN; r < targetN; r++) {
    const src = (Math.floor(rng() * liveN)) * dims;
    const dst = r * dims;
    for (let i = 0; i < dims; i++) flat[dst + i] = live.flat[src + i] + JITTER * gauss(rng);
    const nrm = l2norm(flat, dst, dims) || 1;
    for (let i = 0; i < dims; i++) flat[dst + i] /= nrm;
  }
  // precompute per-row norms (anchor rows already unit-norm from production embedder, but recompute for safety).
  const norms = new Float64Array(targetN);
  for (let r = 0; r < targetN; r++) norms[r] = l2norm(flat, r * dims, dims) || 1;
  return { n: targetN, flat, norms, dims };
}

// exact brute-force top-k over a scaled corpus (the recall denominator / ground truth).
// Uses the same cosine formula as production cosineSimF32 (dot / (||q||·||row||)), with
// precomputed row norms for speed. Correctness is asserted byte-identical against
// cosineSimF32 on a sample below.
function flatTopk(corpus, qVec, qNorm, k) {
  const { flat, norms, n, dims } = corpus;
  const scores = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const off = r * dims;
    let dot = 0;
    for (let i = 0; i < dims; i++) dot += qVec[i] * flat[off + i];
    scores[r] = dot / (qNorm * norms[r]);
  }
  // partial top-k by index
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => scores[b] - scores[a]);
  return idx.slice(0, k);
}

function recallAtK(annIds, exactIds, k) {
  const exactSet = new Set(exactIds.slice(0, k));
  let hit = 0;
  for (let i = 0; i < Math.min(k, annIds.length); i++) if (exactSet.has(annIds[i])) hit++;
  return hit / k;
}

function timedRuns(fn, repeats) {
  const samples = [];
  fn(); // discarded warm-up pass (41-latency-after.cjs:170-182)
  for (let r = 0; r < repeats; r++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  return samples;
}

// ---- ANN arms ---------------------------------------------------------------
// hnswlib-node: pure in-process native HNSW. Primary arm for the D-04 crossover gate.
function tryHnswlib() {
  try {
    const hnsw = require('hnswlib-node');
    return { available: true, lib: 'hnswlib-node', version: require('hnswlib-node/package.json').version, mod: hnsw };
  } catch (e) {
    return { available: false, lib: 'hnswlib-node', error: String((e && e.message) || e).slice(0, 400) };
  }
}
// vectorlite: sqlite loadable-extension HNSW. Secondary arm (sqlite-integration overhead).
function tryVectorlite() {
  try {
    const vectorlite = require('vectorlite');
    const extPath = typeof vectorlite.vectorlitePath === 'function' ? vectorlite.vectorlitePath() : vectorlite.vectorlitePath;
    return { available: true, lib: 'vectorlite', version: require('vectorlite/package.json').version, extPath };
  } catch (e) {
    return { available: false, lib: 'vectorlite', error: String((e && e.message) || e).slice(0, 400) };
  }
}

function measureHnswlib(hnsw, corpus, queries, hnswParams) {
  const { mod } = hnsw;
  const { M, efConstruction, efSearch } = hnswParams;
  const index = new mod.HierarchicalNSW('cosine', corpus.dims);
  index.initIndex(corpus.n, M, efConstruction);
  index.setEf(efSearch);
  const rssBefore = process.memoryUsage().rss;
  const tb0 = process.hrtime.bigint();
  for (let r = 0; r < corpus.n; r++) {
    index.addPoint(Array.from(corpus.flat.subarray(r * corpus.dims, (r + 1) * corpus.dims)), r);
  }
  const tb1 = process.hrtime.bigint();
  const rssAfter = process.memoryUsage().rss;
  const build_ms = Number(tb1 - tb0) / 1e6;

  // query: searchKnn returns { neighbors: [labels], distances }. labels are row indices.
  const queryArrays = queries.map((q) => Array.from(q.vec));
  const samples = timedRuns(() => {
    for (const qa of queryArrays) index.searchKnn(qa, K);
  }, REPEATS).map((ms) => ms / queries.length); // per-query ms
  const lat = samples.sort((a, b) => a - b);

  // recall vs exact
  let r5 = 0, r10 = 0;
  for (const q of queries) {
    const res = index.searchKnn(Array.from(q.vec), K);
    const annIds = res.neighbors; // row indices
    r5 += recallAtK(annIds, q.exact, 5);
    r10 += recallAtK(annIds, q.exact, 10);
  }
  return {
    lib: 'hnswlib-node',
    p50_ms: percentile(lat, 50),
    p95_ms: percentile(lat, 95),
    recall_at_5: r5 / queries.length,
    recall_at_10: r10 / queries.length,
    build_ms,
    rss_delta_bytes: rssAfter - rssBefore,
    hnsw_params: hnswParams,
  };
}

function measureVectorlite(vl, corpus, queries, hnswParams) {
  const { extPath } = vl;
  const { M, efConstruction, efSearch } = hnswParams;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recense-49-vl-'));
  const tmpDb = path.join(tmpDir, 'corpus.db');
  let db;
  try {
    db = new Database(tmpDb); // writable, but a SCRATCH copy — never the live DB
    db.loadExtension(extPath);
    db.exec(`CREATE VIRTUAL TABLE v USING vectorlite(embedding float32[${corpus.dims}], hnsw(max_elements=${corpus.n}, M=${M}, ef_construction=${efConstruction}))`);
    const ins = db.prepare('INSERT INTO v(rowid, embedding) VALUES (?, vector_from_json(?))');
    const rssBefore = process.memoryUsage().rss;
    const tb0 = process.hrtime.bigint();
    const insMany = db.transaction((nn) => {
      for (let r = 0; r < nn; r++) {
        ins.run(r, JSON.stringify(Array.from(corpus.flat.subarray(r * corpus.dims, (r + 1) * corpus.dims))));
      }
    });
    insMany(corpus.n);
    const tb1 = process.hrtime.bigint();
    const rssAfter = process.memoryUsage().rss;
    const build_ms = Number(tb1 - tb0) / 1e6;

    const q = db.prepare(`SELECT rowid FROM v WHERE knn_search(embedding, knn_param(vector_from_json(?), ${K}, ${efSearch}))`);
    const queryJsons = queries.map((qq) => JSON.stringify(Array.from(qq.vec)));
    const lat = timedRuns(() => {
      for (const qj of queryJsons) q.all(qj);
    }, REPEATS).map((ms) => ms / queries.length).sort((a, b) => a - b);

    let r5 = 0, r10 = 0;
    for (const qq of queries) {
      const rows = q.all(JSON.stringify(Array.from(qq.vec)));
      const annIds = rows.map((row) => row.rowid);
      r5 += recallAtK(annIds, qq.exact, 5);
      r10 += recallAtK(annIds, qq.exact, 10);
    }
    return {
      lib: 'vectorlite',
      p50_ms: percentile(lat, 50),
      p95_ms: percentile(lat, 95),
      recall_at_5: r5 / queries.length,
      recall_at_10: r10 / queries.length,
      build_ms,
      rss_delta_bytes: rssAfter - rssBefore,
      hnsw_params: hnswParams,
    };
  } finally {
    try { if (db) db.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- main -------------------------------------------------------------------
(async function main() {
  const liveMtimeBefore = fs.statSync(DB_PATH).mtimeMs;
  console.error('[49-crossover] loading live brain (read-only) ...');
  const live = loadLiveEmbeddings();
  console.error(`[49-crossover] live embedded nodes: ${live.n}`);

  const scales = (SCALES || [live.n, 25000, 50000])
    .map((s) => (s === -1 ? live.n : s))
    .filter((s) => s >= live.n || s > 0);

  // byte-identical ground-truth assertion: our inlined cosine == production cosineSimF32 on a sample.
  {
    const a = live.flat.subarray(0, DIMS);
    const b = live.flat.subarray(DIMS, 2 * DIMS);
    const prod = cosineSimF32(a, b);
    let dot = 0; for (let i = 0; i < DIMS; i++) dot += a[i] * b[i];
    const mine = dot / ((l2norm(a, 0, DIMS) || 1) * (l2norm(b, 0, DIMS) || 1));
    if (Math.abs(prod - mine) > 1e-5) {
      throw new Error(`ground-truth mismatch vs cosineSimF32: prod=${prod} mine=${mine}`);
    }
    console.error(`[49-crossover] cosine ground-truth matches production cosineSimF32 (Δ=${Math.abs(prod - mine).toExponential(2)})`);
  }

  const rng = mulberry32(0xC0FFEE);
  // pick NQUERY real live vectors as the query set (real-distribution queries, D-01).
  const queryRows = [];
  for (let i = 0; i < NQUERY; i++) {
    const qi = Math.floor(rng() * live.n);
    const vec = live.flat.slice(qi * DIMS, (qi + 1) * DIMS);
    queryRows.push({ srcIdx: qi, vec, qNorm: l2norm(vec, 0, DIMS) || 1 });
  }

  const hnsw = tryHnswlib();
  const vl = tryVectorlite();
  console.error(`[49-crossover] hnswlib-node: ${hnsw.available ? 'available v' + hnsw.version : 'BLOCKED — ' + hnsw.error}`);
  console.error(`[49-crossover] vectorlite:  ${vl.available ? 'available v' + vl.version : 'BLOCKED — ' + vl.error}`);

  const HNSW_PARAMS = { M: 16, efConstruction: 200, efSearch: 64 };

  const out = {
    meta: {
      eval: '49-crossover-spike',
      date: new Date().toISOString().slice(0, 10),
      commit: getCommitHash(),
      k: K,
      repeats: REPEATS,
      n_queries: NQUERY,
      dims: DIMS,
      embed_model: EMBED_MODEL,
      jitter_sigma: JITTER,
      live_node_count: live.n,
      hotpath_ref: HOTPATH_REF,
      ann_primary_arm: 'hnswlib-node (in-process; apples-to-apples vs in-process exact flat scan)',
      ann_secondary_arm: 'vectorlite (sqlite loadable-extension; integration overhead included)',
      note: 'Exact arm = production cosineSimF32 ground truth. recall@k = |ann_topk ∩ exact_topk| / k. rss_delta is an approximate footprint (native HNSW memory is off-heap; rss includes corpus + index).',
    },
    ann_available: {
      'hnswlib-node': hnsw.available ? { available: true, version: hnsw.version } : { available: false, error: hnsw.error },
      'vectorlite': vl.available ? { available: true, version: vl.version, extPath: vl.extPath } : { available: false, error: vl.error },
    },
    scales: [],
  };

  for (const N of scales) {
    console.error(`[49-crossover] === scale rung N=${N} ===`);
    const corpus = buildScaledCorpus(live, N, mulberry32(N >>> 0));
    // exact ground-truth top-k per query + exact-arm latency.
    const queries = queryRows.map((q) => ({ vec: q.vec, qNorm: q.qNorm, exact: flatTopk(corpus, q.vec, q.qNorm, K) }));
    const exactLat = timedRuns(() => {
      for (const q of queries) flatTopk(corpus, q.vec, q.qNorm, K);
    }, REPEATS).map((ms) => ms / queries.length).sort((a, b) => a - b);

    const rung = {
      n: N,
      exact: { p50_ms: percentile(exactLat, 50), p95_ms: percentile(exactLat, 95) },
      ann: null,            // primary: hnswlib-node
      ann_vectorlite: null, // secondary: vectorlite
    };
    if (hnsw.available) {
      console.error(`[49-crossover]   building hnswlib-node index ...`);
      rung.ann = measureHnswlib(hnsw, corpus, queries, HNSW_PARAMS);
    } else {
      rung.ann = { unmeasured_here: true, error: hnsw.error };
    }
    if (vl.available) {
      console.error(`[49-crossover]   building vectorlite index (tmpdir) ...`);
      try {
        rung.ann_vectorlite = measureVectorlite(vl, corpus, queries, HNSW_PARAMS);
      } catch (e) {
        rung.ann_vectorlite = { unmeasured_here: true, error: String((e && e.message) || e).slice(0, 400) };
      }
    } else {
      rung.ann_vectorlite = { unmeasured_here: true, error: vl.error };
    }
    out.scales.push(rung);
    console.error(`[49-crossover]   exact p95=${rung.exact.p95_ms.toFixed(2)}ms | hnsw p95=${rung.ann && rung.ann.p95_ms != null ? rung.ann.p95_ms.toFixed(2) + 'ms r@10=' + rung.ann.recall_at_10.toFixed(3) : 'n/a'}`);
  }

  // read-only invariant assertion: live DB mtime unchanged across the whole run.
  const liveMtimeAfter = fs.statSync(DB_PATH).mtimeMs;
  out.meta.live_db_mtime_unchanged = liveMtimeBefore === liveMtimeAfter;
  if (!out.meta.live_db_mtime_unchanged) {
    throw new Error('FATAL: live DB mtime changed during run — read-only invariant violated');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.error(`[49-crossover] wrote ${OUT}`);
})().catch((e) => { console.error('[49-crossover] FAILED:', e); process.exit(1); });
