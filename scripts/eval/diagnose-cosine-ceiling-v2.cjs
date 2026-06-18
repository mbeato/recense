/**
 * Cosine-ceiling diagnosis V2 — VALID same-domain pairs from the LIVE DB.
 *
 * Fixes V1's measurement flaw. V1 paired longmemeval questions against the
 * founder's own DB nodes (cross-domain → near-zero cosine regardless of model),
 * so it could not reveal a model ceiling. V2 samples REAL nodes from the live DB
 * and pairs each with a hand-written, PARAPHRASED question whose correct answer
 * IS that node's current value — a fair semantic-match test.
 *
 * Usage (run from repo root after `npm run build`):
 *
 *   # Dry-run ($0 — no API, no DB scan beyond sampling; prints the pairs):
 *   node scripts/eval/diagnose-cosine-ceiling-v2.cjs --dry-run
 *
 *   # Real run (~$0 — ~36 short embeddings + a read-only topk scan):
 *   OPENAI_API_KEY=... node scripts/eval/diagnose-cosine-ceiling-v2.cjs
 *
 * Optional flags:
 *   --dry-run    Print the sampled pairs + questions; zero API calls
 *   --db PATH    Override DB path (else RECENSE_DB env, else homedir default)
 *
 * Security (T-26-01): OPENAI_API_KEY read from process.env only — never logged,
 * never written to any file. The live DB is opened READ-ONLY (T-26-02): no
 * writes, no mutations, no config changes.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---- arg parsing -----------------------------------------------------------
const arg    = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const IS_DRY = process.argv.includes('--dry-run');

// Resolve DB path the way the engine does: --db > RECENSE_DB > homedir default.
function defaultDbPath() {
  return path.join(os.homedir(), '.config', 'recense', 'recense.db');
}
const DB_PATH = arg('--db', process.env['RECENSE_DB'] || defaultDbPath());

// Reference thresholds (from src/lib/config.ts — printed for context only)
const CANDIDATE_BAND = 0.7; // deletedSimilarityThreshold — the band a contradiction must clear

// ---- dist + better-sqlite3 checks ------------------------------------------
let Database;
try { Database = require('better-sqlite3'); }
catch (e) {
  console.error('[diag-v2] better-sqlite3 not found. Run from repo root with node_modules installed.');
  process.exit(1);
}

const DIST_EMBEDDER = path.join(__dirname, '../../dist/src/model/embedder.js');
const DIST_TOPK     = path.join(__dirname, '../../dist/src/retrieval/topk.js');
if (!fs.existsSync(DIST_EMBEDDER) || !fs.existsSync(DIST_TOPK)) {
  console.error('[diag-v2] dist/ not found. Run `npm run build` before running this script.');
  process.exit(1);
}

let OpenAIEmbedder, cosineSimF32, CandidateRetriever;
try {
  ({ OpenAIEmbedder } = require(DIST_EMBEDDER));
  ({ cosineSimF32, CandidateRetriever } = require(DIST_TOPK));
} catch (e) {
  console.error('[diag-v2] Failed to load compiled modules:', e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SAMPLE: 18 valid same-domain pairs from the live DB.
//
// Each entry pins a node by id-prefix and supplies a hand-written PARAPHRASED
// question whose answer is that node's CURRENT value. Questions deliberately
// avoid the node's distinctive content words (testing semantic, not lexical,
// match). The 10 prev_value nodes (reconsolidation happened) come first — they
// are the heart of the "contradicting claims never cluster" symptom.
// ---------------------------------------------------------------------------
const PAIRS = [
  // --- prev_value nodes (reconsolidation occurred; question asks the CURRENT value) ---
  { idp: '77159c27', has_prev: true,  q: 'is there a bulk way to load all my old project notes into the brain at once?' },
  { idp: 'ab8750c7', has_prev: true,  q: 'should i worry about spending tokens when running parallel design explorations?' },
  { idp: '5db1c554', has_prev: true,  q: 'is the old file-change polling background job still around or did we kill it?' },
  { idp: '81c6a3f5', has_prev: true,  q: 'where did all the money go during the model evaluation work?' },
  { idp: '5d87e69e', has_prev: true,  q: 'what kinds of new data connectors are we deliberately not building?' },
  { idp: '21fc25aa', has_prev: true,  q: 'what mistakes does the AI engineering guru warn coding agents about?' },
  { idp: '799cbcd1', has_prev: true,  q: 'should the engine be specialized for one chat tool or general across input types?' },
  { idp: 'c27f02d2', has_prev: true,  q: 'which part of the pipeline eats most of the API spend?' },
  { idp: '6d1fe51b', has_prev: true,  q: 'roughly how many sub-agents does the big web investigation workflow spin up?' },
  { idp: 'b02f2904', has_prev: true,  q: 'when does running the assistant from a script accidentally charge per-token instead of the flat plan?' },
  // --- fill nodes (no prev_value; spread of types + degrees) ---
  { idp: '6811af13', has_prev: false, q: 'what license and language is the competing graph-memory project?' },
  { idp: '5d205420', has_prev: false, q: 'what actually triggers the sleep pass to run, and what is the backup mechanism?' },
  { idp: 'f9c86e1f', has_prev: false, q: 'which free local model was the only one good enough to act as the verifier?' },
  { idp: '0ff38221', has_prev: false, q: 'what landing-page layout did that design agency find converts best?' },
  { idp: '619b6fa6', has_prev: false, q: 'what runtime version did we just bump the service up to?' },
  { idp: '21ee6e78', has_prev: false, q: 'how is the brands site set to cache its responses at the edge?' },
  { idp: 'f75df155', has_prev: false, q: 'what does the fitness-tracking platform forbid us from showing publicly in the app?' },
  { idp: '64f4ea90', has_prev: false, q: 'how are visit images stored and handed back to the client?' },
];

// Subset for the real retrieval trace (mix of prev_value + fill).
const TRACE_IDPS = ['77159c27', '81c6a3f5', 'c27f02d2', '6d1fe51b', '6811af13'];

// ---------------------------------------------------------------------------
// Resolve pinned nodes against the live DB (read-only).
// ---------------------------------------------------------------------------
function loadNodes(db) {
  const stmt = db.prepare(
    "SELECT id, type, value, prev_value, (embedded_hash IS NOT NULL) AS has_emb FROM node " +
    "WHERE id LIKE ? AND tombstoned = 0 LIMIT 1"
  );
  const degStmt = db.prepare(
    "SELECT count(*) AS d FROM edge WHERE src = ? OR dst = ?"
  );
  const resolved = [];
  for (const p of PAIRS) {
    const row = stmt.get(p.idp + '%');
    if (!row) {
      console.error(`[diag-v2] WARNING: pinned node ${p.idp} not found / tombstoned — skipping`);
      continue;
    }
    const deg = degStmt.get(row.id, row.id).d;
    resolved.push({ ...p, id: row.id, type: row.type, value: row.value,
                    prev_value: row.prev_value, has_emb: !!row.has_emb, degree: deg });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[diag-v2] BLOCKER: live DB not found at: ${DB_PATH}`);
    console.error('[diag-v2] Set RECENSE_DB or pass --db /path/to/recense.db. Stopping.');
    process.exit(1);
  }

  // READ-ONLY open (T-26-02): never writes the graph.
  const db = new Database(DB_PATH, { readonly: true });

  let nodes;
  try {
    nodes = loadNodes(db);
  } catch (e) {
    db.close();
    console.error('[diag-v2] Failed to sample nodes:', e.message);
    process.exit(1);
  }

  if (nodes.length === 0) {
    db.close();
    console.error('[diag-v2] No pinned nodes resolved. Stopping.');
    process.exit(1);
  }

  // ---- DRY RUN ------------------------------------------------------------
  if (IS_DRY) {
    console.log('[diag-v2] --dry-run: zero API calls (sample + question print only)');
    console.log(`[diag-v2] DB (read-only): ${DB_PATH}`);
    console.log(`[diag-v2] Resolved pairs: ${nodes.length} (${nodes.filter(n => n.has_prev).length} prev_value)`);
    console.log('');
    for (const n of nodes) {
      console.log(`  ${n.id.slice(0, 8)} [${n.type}] prev=${n.has_prev} deg=${n.degree} emb=${n.has_emb}`);
      console.log(`    Q: ${n.q}`);
      console.log(`    A(node.value): ${n.value.slice(0, 80)}`);
    }
    db.close();
    console.log(`\n[diag-v2] Dry-run OK — ${nodes.length} valid same-domain pairs ready.`);
    process.exit(0);
  }

  // ---- REAL RUN -----------------------------------------------------------
  // T-26-01: key from env only.
  const apiKey = process.env['OPENAI_API_KEY'] || '';
  if (!apiKey) {
    db.close();
    console.error('[diag-v2] OPENAI_API_KEY not set. Export from sleep.env and retry. Stopping.');
    process.exit(1);
  }

  const questions = nodes.map(n => n.q);
  const values    = nodes.map(n => n.value);

  console.log('[diag-v2] Embedding valid same-domain pairs (question × node.value)...');
  console.log(`[diag-v2] Pairs: ${nodes.length} (${nodes.filter(n => n.has_prev).length} prev_value)`);
  console.log('[diag-v2] No instruction prefix — D-03 (OpenAI models are symmetric)');
  console.log('');

  const smallEmb = new OpenAIEmbedder('text-embedding-3-small', 1536);
  const largeEmb = new OpenAIEmbedder('text-embedding-3-large', 1536);

  // Embed questions + values under both models (4 batched calls total).
  console.log('[diag-v2] Embedding with text-embedding-3-small@1536 ...');
  const qSmall = await smallEmb.embed(questions);
  const vSmall = await smallEmb.embed(values);
  console.log('[diag-v2] Embedding with text-embedding-3-large@1536 ...');
  const qLarge = await largeEmb.embed(questions);
  const vLarge = await largeEmb.embed(values);

  const results = nodes.map((n, i) => ({
    id: n.id, type: n.type, has_prev: n.has_prev, degree: n.degree,
    small: cosineSimF32(qSmall[i], vSmall[i]),
    large: cosineSimF32(qLarge[i], vLarge[i]),
  }));

  // ---- Per-pair table -----------------------------------------------------
  console.log('\n=== Per-pair cosine (question × node.value) ===');
  console.log(`  candidate band = ${CANDIDATE_BAND}`);
  console.log(`  ${'id'.padEnd(10)} ${'prev'.padEnd(5)} ${'deg'.padStart(3)} ${'small'.padStart(8)} ${'large'.padStart(8)} ${'Δ(L-S)'.padStart(8)} ${'S≥.7'.padStart(5)} ${'L≥.7'.padStart(5)}`);
  console.log('  ' + '-'.repeat(64));
  for (const r of results) {
    const d = (r.large - r.small);
    console.log(`  ${r.id.slice(0,8).padEnd(10)} ${String(r.has_prev).padEnd(5)} ${String(r.degree).padStart(3)} ${r.small.toFixed(4).padStart(8)} ${r.large.toFixed(4).padStart(8)} ${((d>=0?'+':'')+d.toFixed(4)).padStart(8)} ${(r.small>=0.7?'Y':'·').padStart(5)} ${(r.large>=0.7?'Y':'·').padStart(5)}`);
  }

  // ---- Aggregates ---------------------------------------------------------
  const N = results.length;
  const smallClears = results.filter(r => r.small >= 0.7).length;
  const largeClears = results.filter(r => r.large >= 0.7).length;
  const belowSmall  = results.filter(r => r.small < 0.7);
  const lifts       = belowSmall.filter(r => r.large >= 0.7).length;
  const liftRate    = belowSmall.length > 0 ? lifts / belowSmall.length : 0;

  console.log('\n=== Aggregates ===');
  console.log(`  N pairs                       : ${N}`);
  console.log(`  small@1536 clears 0.7         : ${smallClears}/${N}`);
  console.log(`  large@1536 clears 0.7         : ${largeClears}/${N}`);
  console.log(`  pairs below 0.7 under small   : ${belowSmall.length}`);
  console.log(`  large LIFTS above 0.7         : ${lifts}/${belowSmall.length} (${(liftRate*100).toFixed(0)}% of below-0.7)`);

  // ---- Real retrieval trace (subset) --------------------------------------
  console.log('\n=== Real retrieval trace (small@1536, live DB, read-only) ===');
  const retriever = new CandidateRetriever(db);
  const traceNodes = nodes.filter(n => TRACE_IDPS.includes(n.idp));
  const traceQs = traceNodes.map(n => n.q);
  const traceQVecs = await smallEmb.embed(traceQs);

  console.log(`  ${'id'.padEnd(10)} ${'prev'.padEnd(5)} ${'rank'.padStart(5)} ${'cosine'.padStart(8)} ${'top-k?'.padStart(7)}`);
  console.log('  ' + '-'.repeat(40));
  const traceResults = [];
  for (let i = 0; i < traceNodes.length; i++) {
    const n = traceNodes[i];
    const hits = retriever.topk(traceQVecs[i], 20); // top-20 scan
    const idx = hits.findIndex(h => h.id === n.id);
    const rank = idx === -1 ? null : idx + 1;
    const cos  = idx === -1 ? null : hits[idx].score;
    const topCos = hits.length > 0 ? hits[0].score : 0;
    traceResults.push({ id: n.id, has_prev: n.has_prev, rank, cos, topCos });
    console.log(`  ${n.id.slice(0,8).padEnd(10)} ${String(n.has_prev).padEnd(5)} ${(rank===null?'miss':String(rank)).padStart(5)} ${(cos===null?'—':cos.toFixed(4)).padStart(8)} ${(rank!==null && rank<=10?'Y':'·').padStart(7)}`);
  }

  db.close();

  // ---- Cost note ----------------------------------------------------------
  const allTexts = [...questions, ...values, ...questions, ...values, ...traceQs];
  const chars = allTexts.reduce((s, t) => s + t.length, 0);
  const tokens = Math.round(chars / 4);
  const costSmall = (tokens * 0.6 / 1_000_000) * 0.02; // ~60% of texts on small
  const costLarge = (tokens * 0.4 / 1_000_000) * 0.13; // ~40% on large
  console.log('\n=== Estimated cost ===');
  console.log(`  Texts embedded: ${allTexts.length}  Est. tokens: ~${tokens.toLocaleString()}`);
  console.log(`  Est. cost: ~$${(costSmall + costLarge).toFixed(4)} (well under $0.01)`);

  // ---- Verdict ------------------------------------------------------------
  console.log('\n=== Verdict ===');
  if (smallClears / N >= 0.5) {
    console.log('  NO-GO (not model-bound): small@1536 already clears 0.7 on a majority of valid');
    console.log('  same-domain pairs. The retrieval weakness is NOT a model ceiling.');
    console.log('  Look next at: content-ingestion coverage + specific live reconsolidation cue cases.');
  } else if (belowSmall.length > 0 && liftRate >= 1/3) {
    console.log('  GO (model-bound): same-domain pairs routinely sit below 0.7 under small,');
    console.log(`  and large lifts ${(liftRate*100).toFixed(0)}% of them over 0.7. The swap is justified.`);
  } else {
    console.log('  AMBIGUOUS: results do not cleanly support GO or NO-GO. Recommend the smallest');
    console.log('  next test — expand the same-domain sample or trace the specific failing cue cases.');
  }

})().catch(e => {
  console.error('[diag-v2] Fatal error:', e.message);
  process.exit(1);
});
