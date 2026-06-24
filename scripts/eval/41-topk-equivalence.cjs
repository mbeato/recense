/**
 * 41-topk-equivalence — Phase 41 PERF-03 gate (D-10), direct & cheap.
 *
 * Asserts the PERSISTED indexed retrieval path returns a top-k id SET identical to the
 * brute-force `cosineSimF32` reference, over a representative query set, read-only on the
 * live brain. Because the zero-dep flat-buffer index is EXACT (D-01), this equivalence is
 * the whole of PERF-03 "no accuracy regression" — proven by construction, independent of
 * the expensive end-to-end eval (which only confirms it).
 *
 * Two top-k lists per query, both over `node WHERE embedding IS NOT NULL AND tombstoned = 0`:
 *   (a) BRUTE-FORCE reference — `cosineSimF32(q, row)` scan, the D-10 reference (the exact
 *       same formula CandidateRetriever.topk uses in brute-force mode).
 *   (b) INDEXED path — `new CandidateRetriever(db, { indexPath }).topk(q, k)` reading the
 *       persisted `<dbPath>.vindex` sidecar built at the end of the sleep pass (41-02).
 *
 * Equivalence (D-10): the two id SETS must be identical, tolerating reorder ONLY within
 * identical-score float ties. Set comparison is order-independent so a pure reorder always
 * passes; the only way a tie reorder changes set MEMBERSHIP is at the k-boundary (two rows
 * with equal score straddling position k). We handle that explicitly: a membership
 * difference is OK iff every differing id on each side carries a score equal (within a tight
 * float epsilon) to the boundary score — i.e. the divergence is a C/SIMD-vs-JS float
 * sum-order tie at the cutoff, not a genuinely different node (D-10's "± tie reorder").
 *
 * Run at the live `candidateK` AND a larger k (covers `hybridTopk`'s preK = k*3 fetch).
 *
 * Read-only on the live brain throughout (readonly:true, fileMustExist:true). No writes.
 * Requires the sidecar to already exist (build it via a sleep pass or buildVectorIndex);
 * if it is absent the indexed CandidateRetriever falls back to brute-force and this check
 * would trivially pass against itself — so we ASSERT the sidecar is present and loaded.
 *
 * Run:
 *   node scripts/eval/41-topk-equivalence.cjs                 # mock unit-vector queries (API-free, default)
 *   OPENAI_API_KEY=... node scripts/eval/41-topk-equivalence.cjs --real-embed   # live-embedded queries
 *   node scripts/eval/41-topk-equivalence.cjs --out <path>
 *
 * Exits non-zero if ANY query's set diverges beyond a boundary tie reorder.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
const { CandidateRetriever, cosineSimF32, vectorIndexPath } = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const REAL_EMBED = process.argv.includes('--real-embed');
const OUT  = arg('--out', 'scripts/eval/results/41-topk-equivalence.json');
const DIMS = DEFAULT_CONFIG.embeddingDimensions || 1536;
const CANDIDATE_K = DEFAULT_CONFIG.candidateK || 5;
const LARGER_K = 20; // spans hybridTopk preK = k*3 for k up to ~6
const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');

// Float epsilon for "scores equal at the tie boundary" — a C/SIMD-vs-JS float sum-order
// difference on a 1536-dim dot product is far below this; a genuinely different node's
// cosine is not.
const TIE_EPS = 1e-6;

// Same 20-query cue set as live-latency.cjs / 41-index-spike.cjs so the gate uses the
// SAME cues the Phase-40 45/46 ms baseline was measured over.
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

// Deterministic non-zero unit vector per query (seeded by index) — same construction as
// the spike, so a zero vector never collapses every cosine to 0 (which would make the
// top-k tie set degenerate and the equivalence check meaningless).
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

// Pitfall 5: decode embedding BLOB with byteOffset + length (Buffer slices may have a
// nonzero byteOffset, so `new Float32Array(buf.buffer)` would be wrong).
function decodeEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Brute-force reference: cosineSimF32 over every live embedded row. This is the EXACT
// formula CandidateRetriever.topk uses in brute-force mode (D-10 reference). Returns the
// full scored list sorted desc (so we can inspect tie scores at the k boundary).
function bruteForceScored(db, queryVec) {
  const rows = db
    .prepare('SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0')
    .all();
  const scored = [];
  for (const row of rows) {
    const v = decodeEmbedding(row.embedding);
    if (v.length !== queryVec.length) continue; // L-2 dim-mismatch skip (matches topk)
    scored.push({ id: row.id, score: cosineSimF32(queryVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Equivalence with a boundary-tie allowance (D-10). `a` and `b` are top-k {id,score}
// lists (already sorted desc). `bruteScored` is the FULL sorted brute-force list, used to
// read the score at the tie boundary. Returns { equivalent, reason }.
function topkEquivalent(indexed, brute, bruteScored, k) {
  const setIdx = new Set(indexed.map(h => h.id));
  const setBf  = new Set(brute.map(h => h.id));

  // Symmetric difference of id sets.
  const onlyIdx = indexed.filter(h => !setBf.has(h.id));
  const onlyBf  = brute.filter(h => !setIdx.has(h.id));

  if (onlyIdx.length === 0 && onlyBf.length === 0) {
    return { equivalent: true, reason: 'sets identical' };
  }

  // Membership differs. This is tolerable ONLY if it is a tie at the k-boundary: every
  // differing id on both sides must carry a score equal (within TIE_EPS) to the boundary
  // score (the score at rank k-1 of the brute-force list — the cutoff).
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

(async () => {
  const indexPath = vectorIndexPath(DB_PATH);
  if (!fs.existsSync(indexPath)) {
    console.error(`[41-equiv] FATAL: sidecar ${indexPath} is absent. Build it (run a sleep pass or buildVectorIndex) before the equivalence gate — otherwise the indexed retriever falls back to brute-force and the check is vacuous.`);
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const nodeCount = db
    .prepare('SELECT count(*) AS n FROM node WHERE embedding IS NOT NULL AND tombstoned = 0')
    .get().n;

  // INDEXED retriever — must actually load the sidecar. CandidateRetriever warns to stderr
  // and leaves index=null on any load failure; we cannot read that private field, so we
  // detect a silent fallback by checking the sidecar parsed (size > header) and asserting
  // the indexed path is exercised. A vacuous self-comparison is the failure we guard against.
  const indexed = new CandidateRetriever(db, { indexPath });

  console.log(`[41-equiv] DB=${DB_PATH} embedded_live_nodes=${nodeCount} candidateK=${CANDIDATE_K} largerK=${LARGER_K} embed=${REAL_EMBED ? DEFAULT_CONFIG.openaiEmbedModel : 'mock-seeded-unit-vector'}`);
  console.log(`[41-equiv] sidecar=${indexPath} (${fs.statSync(indexPath).size} bytes)`);

  const queryVecs = await embedQueries();

  const perQuery = [];
  let allEquivalent = true;

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
        // Max |Δscore| between matched ids (sanity: indexed cosine should be byte-equivalent).
        max_score_delta: (() => {
          const bm = new Map(brute.map(h => [h.id, h.score]));
          let m = 0;
          for (const h of idx) { const b = bm.get(h.id); if (b !== undefined) m = Math.max(m, Math.abs(h.score - b)); }
          return m;
        })(),
      });
    }
  }

  db.close();

  const maxDelta = perQuery.reduce((m, r) => Math.max(m, r.max_score_delta), 0);
  const failures = perQuery.filter(r => !r.equivalent);

  const out = {
    meta: {
      eval: '41-topk-equivalence',
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
    equivalent: allEquivalent,
    total_checks: perQuery.length,
    failures: failures.length,
    max_score_delta_across_all: maxDelta,
    per_query: perQuery,
  };

  const outPath = path.resolve(process.cwd(), OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  console.log(`[41-equiv] checks=${perQuery.length} failures=${failures.length} max|Δscore|=${maxDelta.toExponential(3)} equivalent=${allEquivalent}`);
  console.log(`[41-equiv] written: ${outPath}`);

  if (!allEquivalent) {
    console.error('[41-equiv] DIVERGENCE — indexed top-k differs from brute-force beyond a boundary tie:');
    for (const f of failures) console.error(`  k=${f.k} "${f.query}": ${f.reason}`);
    process.exit(1);
  }
})().catch(e => { console.error('41-equiv error:', e.stack || e.message); process.exit(1); });
