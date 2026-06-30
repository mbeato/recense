/**
 * 51-topk-equivalence — Phase 51 SCALE-03 gate (D-07/D-08).
 *
 * Two-part gate over the live brain:
 *
 * PART 1 — SET-IDENTITY / recall@10=1.000 (hard-fail on divergence):
 *   Asserts that the WASM-kernel-accelerated indexed retrieval path (CandidateRetriever
 *   with sidecar) returns a top-k id SET identical to the brute-force `cosineSimF32`
 *   reference over 20 representative queries. Uses the same boundary-tie equivalence
 *   logic as 41-topk-equivalence.cjs (tolerates only equal-score tie reorder at the
 *   k-boundary). Exits non-zero on any genuine divergence — this is the D-07 gate.
 *
 *   IMPORTANT: The script asserts the sidecar is present and loaded BEFORE comparing.
 *   An absent sidecar causes CandidateRetriever to fall back to brute-force, making the
 *   indexed path COMPARE AGAINST ITSELF — a vacuous "equivalence" that trivially passes.
 *   We FAIL LOUD if the sidecar is absent (mirrors 41-topk-equivalence.cjs caveat).
 *
 * PART 2 — KERNEL-VS-SCALAR LATENCY REPORT (informational; does NOT hard-fail):
 *   Measures per-query p95 for:
 *     (a) scalar dot scan kernel-only (raw dot products, no norm-divide or selection)
 *     (b) WASM scanCosine kernel-only (the production kernel from simd-kernel.ts)
 *     (c) full scalar topk (dot + norm-divide + partialSelectTopK)
 *     (d) full WASM-indexed topk via CandidateRetriever (scanCosine + partialSelectTopK)
 *   Reports kernel_speedup and full_speedup. Target: ~4–5× kernel-only p95 (spike result).
 *   Flags a sub-1× kernel speedup as a regression worth investigating but does NOT exit 1
 *   (hardware variance can affect single runs). The equivalence half is the hard gate.
 *
 * Run:
 *   npm run build && node scripts/eval/51-topk-equivalence.cjs
 *   RECENSE_DB_PATH=... node scripts/eval/51-topk-equivalence.cjs --real-embed
 *
 * Exits 0 when equivalence holds (all queries set-identical, boundary-tie tolerant).
 * Exits 1 on any genuine equivalence divergence or sidecar-absent failure.
 * Writes: scripts/eval/results/51-topk-equivalence.json
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
const { CandidateRetriever, cosineSimF32, vectorIndexPath } = require(DIST + '/retrieval/topk');
const { loadSimdKernel } = require(DIST + '/retrieval/simd-kernel');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');

const REAL_EMBED = process.argv.includes('--real-embed');
const OUT = path.resolve(process.cwd(), 'scripts/eval/results/51-topk-equivalence.json');

const DIMS = DEFAULT_CONFIG.embeddingDimensions || 1536;
const CANDIDATE_K = DEFAULT_CONFIG.candidateK || 5;
const LARGER_K = 20;
const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');

// Boundary-tie epsilon. The WASM kernel computes cosine entirely in f32 (f32x4 lane
// accumulation, f32 horizontal sum, f32 reciprocal norms), while the brute-force reference
// cosineSimF32 computes in f64 — a precision-CLASS difference, not sum reordering at equal
// precision. At dim=1536 each lane sums ~384 f32 products; worst-case accumulation error is
// approximately sqrt(384)·2⁻²⁴ ≈ 1–3e-6 in the dot product, which propagates to the cosine
// and can approach TIE_EPS. The real-embed run asserts the empirically-observed max|Δscore|
// against MAX_DELTA_BUDGET below — if a production run approaches or exceeds that budget, it
// is a finding requiring recalibration with justification, not a silent widen.
const TIE_EPS = 1e-6;

// Documented ceiling for the per-id score precision delta observed in a real-embed run.
// MUST remain >= the empirically-observed max|Δscore|. If a real-embed run pushes max|Δscore|
// near or above this budget, that is a FINDING requiring TIE_EPS recalibration with
// justification — do NOT widen the epsilon merely to make the gate pass.
const MAX_DELTA_BUDGET = TIE_EPS;

// REPEATS for latency measurement (kernel + full).
const REPEATS = 5;

// Same 20-query cue set as 41-topk-equivalence.cjs.
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

// Deterministic non-zero unit vector per query index (seeded by index).
// Same construction as 41-topk-equivalence.cjs / spike.
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

// Pitfall 5: decode embedding BLOB with byteOffset + length.
function decodeEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Brute-force reference: cosineSimF32 over every live embedded row.
// Returns the full sorted list (used to read the boundary score for tie checks).
function bruteForceScored(db, queryVec) {
  const rows = db
    .prepare('SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0')
    .all();
  const scored = [];
  for (const row of rows) {
    const v = decodeEmbedding(row.embedding);
    if (v.length !== queryVec.length) continue; // L-2 dim-mismatch skip
    scored.push({ id: row.id, score: cosineSimF32(queryVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Boundary-tie equivalence check (same logic as 41-topk-equivalence.cjs).
// Returns { equivalent, reason }.
function topkEquivalent(indexed, brute, bruteScored, k) {
  const setIdx = new Set(indexed.map(h => h.id));
  const setBf  = new Set(brute.map(h => h.id));

  const onlyIdx = indexed.filter(h => !setBf.has(h.id));
  const onlyBf  = brute.filter(h => !setIdx.has(h.id));

  if (onlyIdx.length === 0 && onlyBf.length === 0) {
    return { equivalent: true, reason: 'sets identical' };
  }

  const boundaryScore = bruteScored.length >= k
    ? bruteScored[k - 1].score
    : (bruteScored.length ? bruteScored[bruteScored.length - 1].score : 0);

  const allAtBoundary = [...onlyIdx, ...onlyBf].every(
    h => Math.abs(h.score - boundaryScore) <= TIE_EPS,
  );

  if (allAtBoundary) {
    return {
      equivalent: true,
      reason: `boundary tie reorder at score≈${boundaryScore.toFixed(8)} (${onlyIdx.length}+${onlyBf.length} ids swapped, all within ${TIE_EPS} of cutoff)`,
    };
  }

  return {
    equivalent: false,
    reason: `genuine membership divergence: indexed-only=[${onlyIdx.map(h => `${h.id}@${h.score.toFixed(6)}`).join(',')}] brute-only=[${onlyBf.map(h => `${h.id}@${h.score.toFixed(6)}`).join(',')}] boundary≈${boundaryScore.toFixed(8)}`,
  };
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.ceil(p / 100 * s.length) - 1;
  return s[Math.max(0, Math.min(i, s.length - 1))];
}

(async () => {
  // ---- Sidecar presence assertion ----
  const indexPath = vectorIndexPath(DB_PATH);
  if (!fs.existsSync(indexPath)) {
    process.stderr.write(
      `[51-equiv] FATAL: sidecar ${indexPath} is absent. ` +
      `Build it (run a sleep pass or buildVectorIndex) before the equivalence gate — ` +
      `otherwise the indexed retriever falls back to brute-force and the check is vacuous.\n`,
    );
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const nodeCount = db
    .prepare('SELECT count(*) AS n FROM node WHERE embedding IS NOT NULL AND tombstoned = 0')
    .get().n;

  process.stderr.write(
    `[51-equiv] DB=${DB_PATH} embedded_live_nodes=${nodeCount} ` +
    `candidateK=${CANDIDATE_K} largerK=${LARGER_K} ` +
    `embed=${REAL_EMBED ? DEFAULT_CONFIG.openaiEmbedModel : 'mock-seeded-unit-vector'}\n`,
  );
  process.stderr.write(`[51-equiv] sidecar=${indexPath} (${fs.statSync(indexPath).size} bytes)\n`);

  // ---- PART 1: Set-identity equivalence gate ----
  // Build the indexed retriever (WASM kernel loads here if SIMD available + dim%4===0).
  const indexed = new CandidateRetriever(db, { indexPath });

  // ---- Real-embed: fail loud when API key absent or embeddings degenerate ----
  // OpenAIEmbedder reads OPENAI_API_KEY automatically. A missing/invalid key causes
  // embedBatch to fall back to per-input retries, each of which substitutes a zero vector —
  // so without this guard a missing key would yield 20 all-zero vectors and a vacuous pass.
  if (REAL_EMBED) {
    if (!process.env.OPENAI_API_KEY) {
      process.stderr.write(
        '[51-equiv] FATAL: --real-embed requires OPENAI_API_KEY to be set; ' +
        'refusing to run — a missing key yields silent zero-vectors and a vacuous pass.\n',
      );
      process.exit(3);
    }
  }

  const queryVecs = await embedQueries();

  // Validate every real query vector: must be the right length, contain no NaN, and have
  // a non-zero L2 norm. Any degenerate vector (all-zero or NaN-poisoned) means the key
  // or the API call silently failed — exit 3 rather than vacuously passing.
  if (REAL_EMBED) {
    for (let qi = 0; qi < queryVecs.length; qi++) {
      const v = queryVecs[qi];
      if (v.length !== DIMS) {
        process.stderr.write(
          `[51-equiv] FATAL: real embedding for query ${qi} has length ${v.length} (expected ${DIMS}) — ` +
          'real embeddings unavailable/degenerate — not vacuously passing.\n',
        );
        process.exit(3);
      }
      let hasNaN = false;
      let l2sq = 0;
      for (let i = 0; i < v.length; i++) {
        if (!isFinite(v[i])) { hasNaN = true; break; }
        l2sq += v[i] * v[i];
      }
      if (hasNaN || l2sq === 0) {
        process.stderr.write(
          `[51-equiv] FATAL: real embedding for query ${qi} is ${hasNaN ? 'NaN/Inf-poisoned' : 'a zero-vector'} — ` +
          'real embeddings unavailable/degenerate — not vacuously passing.\n',
        );
        process.exit(3);
      }
    }
  }

  const perQuery = [];
  let allEquivalent = true;

  // recall@10: per-query fraction of the indexed top-10 that matches the brute-force top-10.
  // Computed once per query (when k === LARGER_K so bruteScored covers >= 10 entries).
  const recallAt10PerQuery = [];

  for (const k of [CANDIDATE_K, LARGER_K]) {
    for (let qi = 0; qi < queryVecs.length; qi++) {
      const q = queryVecs[qi];
      const bruteScored = bruteForceScored(db, q);
      const brute = bruteScored.slice(0, k);
      const idx = indexed.topk(q, k);

      const verdict = topkEquivalent(idx, brute, bruteScored, k);
      if (!verdict.equivalent) allEquivalent = false;

      perQuery.push({
        k,
        query: QUERIES[qi],
        indexed_ids: idx.map(h => h.id),
        brute_ids: brute.map(h => h.id),
        equivalent: verdict.equivalent,
        reason: verdict.reason,
        max_score_delta: (() => {
          const bm = new Map(brute.map(h => [h.id, h.score]));
          let m = 0;
          for (const h of idx) {
            const b = bm.get(h.id);
            if (b !== undefined) m = Math.max(m, Math.abs(h.score - b));
          }
          return m;
        })(),
      });

      // Compute recall@10 once per query when k === LARGER_K (covers the full top-20,
      // so bruteScored already has >= 10 entries if the corpus is large enough).
      // Reuses bruteScored — no second brute-force scan.
      if (k === LARGER_K) {
        const top10Idx = new Set(idx.slice(0, 10).map(h => h.id));
        const top10Brute = bruteScored.slice(0, 10);
        const denom = Math.min(10, top10Brute.length);
        let intersect = 0;
        for (const h of top10Brute) if (top10Idx.has(h.id)) intersect++;
        recallAt10PerQuery.push(denom > 0 ? intersect / denom : 1);
      }
    }
  }

  const maxDelta = perQuery.reduce((m, r) => Math.max(m, r.max_score_delta), 0);
  const failures = perQuery.filter(r => !r.equivalent);

  // Hard budget assertion: if max|Δscore| meets or exceeds MAX_DELTA_BUDGET, the gate fails.
  // This is a documented precision finding — recalibrate TIE_EPS with justification; do NOT
  // widen merely to pass. Mock-mode observes ~5.191e-8, well within budget.
  let budgetBreached = false;
  if (maxDelta >= MAX_DELTA_BUDGET) {
    budgetBreached = true;
    process.stderr.write(
      `[51-equiv] FATAL: max|Δscore|=${maxDelta.toExponential(3)} meets/exceeds ` +
      `MAX_DELTA_BUDGET=${MAX_DELTA_BUDGET.toExponential(3)} — ` +
      'FINDING: recalibrate TIE_EPS to the empirical bound with justification; ' +
      'do NOT widen the epsilon merely to pass.\n',
    );
  }

  const meanRecallAt10 = recallAt10PerQuery.length > 0
    ? recallAt10PerQuery.reduce((s, v) => s + v, 0) / recallAt10PerQuery.length
    : 0;

  process.stderr.write(
    `[51-equiv] equivalence checks=${perQuery.length} failures=${failures.length} ` +
    `max|Δscore|=${maxDelta.toExponential(3)} budget_breached=${budgetBreached} equivalent=${allEquivalent}\n`,
  );
  process.stderr.write(
    `[51-equiv] recall@10: mean=${meanRecallAt10.toFixed(4)} ` +
    `per_query=[${recallAt10PerQuery.map(v => v.toFixed(3)).join(',')}]\n`,
  );

  // ---- PART 2: Kernel-vs-scalar latency measurement ----
  // Load all live embeddings into a contiguous flat buffer for direct kernel/scalar timing.
  const rows = db
    .prepare('SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0')
    .all();
  const N = rows.length;
  const flat = new Float32Array(N * DIMS);
  const normsBuf = new Float64Array(N);
  const liveIds = [];
  for (let r = 0; r < N; r++) {
    const v = decodeEmbedding(rows[r].embedding);
    const len = Math.min(v.length, DIMS);
    flat.set(v.subarray(0, len), r * DIMS);
    let norm = 0;
    for (let i = 0; i < DIMS; i++) norm += flat[r * DIMS + i] ** 2;
    normsBuf[r] = Math.sqrt(norm);
    liveIds.push(rows[r].id);
  }

  // Try to load the WASM SIMD kernel directly over the live data (timing the raw kernel path).
  // If SIMD is unavailable (dim%4≠0 or runtime lacks support), kernel will be null and we
  // skip the kernel-only timing (report null speedup, not a hard failure).
  let simdKernel = null;
  try {
    simdKernel = loadSimdKernel(flat, normsBuf, N, DIMS);
  } catch {
    // loadSimdKernel never throws (D-08), but wrap defensively.
  }

  let latencyResult = null;

  if (simdKernel !== null) {
    // Representative queries for timing (use the same mock vectors).
    const timingQueries = queryVecs.map(q => {
      let norm = 0;
      for (let i = 0; i < q.length; i++) norm += q[i] * q[i];
      return { vec: q, norm: Math.sqrt(norm) };
    });

    // ---- Scalar kernel-only (raw dot product, no norm-divide or selection) ----
    function scalarDotOnly(q) {
      const dotOut = new Float64Array(N);
      for (let r = 0; r < N; r++) {
        let d = 0;
        const o = r * DIMS;
        for (let i = 0; i < DIMS; i++) d += q.vec[i] * flat[o + i];
        dotOut[r] = d;
      }
      return dotOut;
    }

    // ---- Scalar full topk (dot + norm-divide + select) ----
    const { partialSelectTopK } = require(DIST + '/retrieval/simd-kernel');
    function scalarFullTopK(q, k) {
      const scores = new Float32Array(N);
      for (let r = 0; r < N; r++) {
        let d = 0;
        const o = r * DIMS;
        for (let i = 0; i < DIMS; i++) d += q.vec[i] * flat[o + i];
        const denom = q.norm * normsBuf[r];
        scores[r] = denom === 0 ? 0 : d / denom;
      }
      return partialSelectTopK(scores, liveIds, k);
    }

    // ---- WASM kernel-only ----
    function wasmKernelOnly(q) {
      return simdKernel.scanCosine(q.vec, q.norm);
    }

    // ---- WASM full topk (via CandidateRetriever — the production path) ----
    function wasmFullTopK(q, k) {
      return indexed.topk(q.vec, k);
    }

    // Warmup
    for (const q of timingQueries) {
      scalarDotOnly(q);
      wasmKernelOnly(q);
      scalarFullTopK(q, CANDIDATE_K);
      wasmFullTopK(q, CANDIDATE_K);
    }

    const sKernTimes = [], wKernTimes = [], sFullTimes = [], wFullTimes = [];

    for (let rep = 0; rep < REPEATS; rep++) {
      // Scalar kernel-only p95
      let t0 = process.hrtime.bigint();
      for (const q of timingQueries) scalarDotOnly(q);
      let t1 = process.hrtime.bigint();
      sKernTimes.push(Number(t1 - t0) / 1e6 / timingQueries.length);

      // WASM kernel-only p95
      t0 = process.hrtime.bigint();
      for (const q of timingQueries) wasmKernelOnly(q);
      t1 = process.hrtime.bigint();
      wKernTimes.push(Number(t1 - t0) / 1e6 / timingQueries.length);

      // Scalar full p95
      t0 = process.hrtime.bigint();
      for (const q of timingQueries) scalarFullTopK(q, CANDIDATE_K);
      t1 = process.hrtime.bigint();
      sFullTimes.push(Number(t1 - t0) / 1e6 / timingQueries.length);

      // WASM full p95 (production path)
      t0 = process.hrtime.bigint();
      for (const q of timingQueries) wasmFullTopK(q, CANDIDATE_K);
      t1 = process.hrtime.bigint();
      wFullTimes.push(Number(t1 - t0) / 1e6 / timingQueries.length);
    }

    const skP95 = pct(sKernTimes, 95);
    const wkP95 = pct(wKernTimes, 95);
    const sfP95 = pct(sFullTimes, 95);
    const wfP95 = pct(wFullTimes, 95);
    const kernelSpeedup = +(skP95 / wkP95).toFixed(2);
    const fullSpeedup   = +(sfP95 / wfP95).toFixed(2);

    latencyResult = {
      n_corpus: N,
      n_timing_queries: timingQueries.length,
      repeats: REPEATS,
      scalar_kernel_p95_ms: +skP95.toFixed(3),
      wasm_kernel_p95_ms:   +wkP95.toFixed(3),
      scalar_full_p95_ms:   +sfP95.toFixed(3),
      wasm_full_p95_ms:     +wfP95.toFixed(3),
      kernel_speedup: kernelSpeedup,
      full_speedup:   fullSpeedup,
    };

    process.stderr.write(
      `[51-equiv] latency: scalar_kernel=${skP95.toFixed(3)}ms -> wasm_kernel=${wkP95.toFixed(3)}ms ` +
      `(${kernelSpeedup}x) | scalar_full=${sfP95.toFixed(3)}ms -> wasm_full=${wfP95.toFixed(3)}ms ` +
      `(${fullSpeedup}x)\n`,
    );

    if (kernelSpeedup < 1) {
      process.stderr.write(
        `[51-equiv] WARNING: kernel_speedup=${kernelSpeedup}x < 1.0 — ` +
        `possible SIMD regression; investigate before shipping (hardware variance possible on single run)\n`,
      );
    }
  } else {
    process.stderr.write(
      `[51-equiv] WARNING: WASM SIMD kernel unavailable (dim%4≠0 or SIMD not supported) — ` +
      `latency comparison skipped; equivalence check above is still valid (scalar fallback)\n`,
    );
  }

  db.close();

  // ---- Write results JSON ----
  const out = {
    meta: {
      eval: '51-topk-equivalence',
      date: new Date().toISOString(),
      db_path: DB_PATH,
      sidecar: indexPath,
      embedded_live_nodes: nodeCount,
      candidate_k: CANDIDATE_K,
      larger_k: LARGER_K,
      queries: QUERIES.length,
      embed: REAL_EMBED ? DEFAULT_CONFIG.openaiEmbedModel : 'mock-seeded-unit-vector',
      tie_eps: TIE_EPS,
    },
    equivalence: {
      equivalent: allEquivalent,
      total_checks: perQuery.length,
      failures: failures.length,
      max_score_delta_across_all: maxDelta,
      max_delta_budget: MAX_DELTA_BUDGET,
      budget_breached: budgetBreached,
      recall_at_10: {
        per_query: recallAt10PerQuery,
        mean: meanRecallAt10,
      },
      per_query: perQuery,
    },
    latency: latencyResult,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`[51-equiv] written: ${OUT}\n`);

  // ---- Hard-fail on equivalence divergence or budget breach ----
  if (!allEquivalent || budgetBreached) {
    if (!allEquivalent) {
      process.stderr.write(
        '[51-equiv] DIVERGENCE — WASM-indexed top-k differs from brute-force beyond a boundary tie:\n',
      );
      for (const f of failures) {
        process.stderr.write(`  k=${f.k} "${f.query}": ${f.reason}\n`);
      }
    }
    if (budgetBreached) {
      process.stderr.write(
        `[51-equiv] BUDGET BREACH — max|Δscore|=${maxDelta.toExponential(3)} >= MAX_DELTA_BUDGET=${MAX_DELTA_BUDGET.toExponential(3)}\n`,
      );
    }
    process.exit(1);
  }

  process.stderr.write(
    `[51-equiv] PASS — all queries set-identical, boundary-tie tolerant, ` +
    `max|Δscore|=${maxDelta.toExponential(3)} < budget=${MAX_DELTA_BUDGET.toExponential(3)}, ` +
    `recall@10=${meanRecallAt10.toFixed(4)}\n`,
  );
})().catch(e => {
  process.stderr.write(`[51-equiv] FATAL error: ${e.stack || e.message}\n`);
  process.exit(1);
});
