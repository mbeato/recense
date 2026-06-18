/**
 * Cosine-ceiling diagnosis — large@1536 vs small@1536 on KU query/cue pairs.
 *
 * Confirms whether the sub-0.7 retrieval weakness is MODEL-BOUND (a
 * text-embedding-3-small ceiling) before committing to any paid re-embed.
 *
 * Usage (run from repo root after `npm run build`):
 *
 *   # Dry-run ($0 — zero API calls, just parses cache and prints pair count):
 *   node scripts/eval/diagnose-cosine-ceiling.cjs --dry-run
 *
 *   # Real spot-check (pennies — embeds a handful of short texts twice):
 *   OPENAI_API_KEY=... node scripts/eval/diagnose-cosine-ceiling.cjs
 *
 * Optional flags:
 *   --dry-run    Parse cache only; zero API calls
 *   --cache      /path/to/eval-cache-dir  (default: ~/.recense-eval-cache/eval01-n20-2026-06-16)
 *
 * Security (T-26-01): OPENAI_API_KEY is read from process.env only; never
 * logged, never written to any file, never printed to stdout or stderr.
 *
 * Threat mitigation: this script is read-only re: recense.db — it touches no
 * production config and no DB (T-26-02).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---- arg parsing -----------------------------------------------------------
const arg      = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const IS_DRY   = process.argv.includes('--dry-run');
const CACHE_DIR = arg('--cache',
  path.join(os.homedir(), '.recense-eval-cache', 'eval01-n20-2026-06-16'));

const ATTR_FILE = path.join(CACHE_DIR, 'n20-attribution.jsonl');
const KU_FILE   = path.join(CACHE_DIR, 'eval20-ku.jsonl');

// Reference thresholds (from src/lib/config.ts — printed for context only)
const RANKED_RETRIEVAL_FLOOR = 0.3;
const DELETED_SIMILARITY_THRESHOLD = 0.7;  // the "candidate band" floor

// ---- dist check ------------------------------------------------------------
const DIST_EMBEDDER = path.join(__dirname, '../../dist/src/model/embedder.js');
const DIST_TOPK     = path.join(__dirname, '../../dist/src/retrieval/topk.js');

if (!fs.existsSync(DIST_EMBEDDER) || !fs.existsSync(DIST_TOPK)) {
  console.error('[diagnose] dist/ not found. Run `npm run build` before running this script.');
  process.exit(1);
}

let OpenAIEmbedder, cosineSimF32;
try {
  ({ OpenAIEmbedder } = require(DIST_EMBEDDER));
  ({ cosineSimF32 }   = require(DIST_TOPK));
} catch (e) {
  console.error('[diagnose] Failed to load compiled modules:', e.message);
  process.exit(1);
}

// ---- load KU pairs from cache -----------------------------------------------
function loadKuPairs() {
  if (!fs.existsSync(ATTR_FILE)) {
    console.error(`[diagnose] n20-attribution.jsonl not found at: ${ATTR_FILE}`);
    process.exit(1);
  }
  if (!fs.existsSync(KU_FILE)) {
    console.error(`[diagnose] eval20-ku.jsonl not found at: ${KU_FILE}`);
    process.exit(1);
  }

  // Load question text by id
  const questions = new Map();
  for (const line of fs.readFileSync(KU_FILE, 'utf8').split('\n').filter(Boolean)) {
    const d = JSON.parse(line);
    questions.set(d.question_id, d.question);
  }

  // Find KU cases where at least one node has prev_value (value-update cases)
  const pairs = [];
  for (const line of fs.readFileSync(ATTR_FILE, 'utf8').split('\n').filter(Boolean)) {
    const d = JSON.parse(line);
    if (d.question_type !== 'knowledge-update') continue;

    const prevNodes = (d.nodes || []).filter(n => n.prev_value);
    if (prevNodes.length === 0) continue;

    const question = questions.get(d.question_id) || d.question_id;

    // Each (prev_value, value) pair is a contradiction cue the judge must cluster
    for (const node of prevNodes) {
      pairs.push({
        qid:       d.question_id,
        query:     question,          // the KU question = the retrieval query
        cue_new:   node.value,        // new/current value (the correct answer)
        cue_prev:  node.prev_value,   // old value (the cue that was contradicted)
      });
    }
  }

  return pairs;
}

// ---- main ------------------------------------------------------------------
(async () => {
  const pairs = loadKuPairs();

  if (pairs.length === 0) {
    console.error('[diagnose] No KU pairs with prev_value found in cache. Exiting.');
    process.exit(1);
  }

  // ---- DRY RUN: zero API calls -------------------------------------------
  if (IS_DRY) {
    console.log('[diagnose] --dry-run mode: zero API calls (cache parse only)');
    console.log(`[diagnose] Cache dir  : ${CACHE_DIR}`);
    console.log(`[diagnose] KU pairs   : ${pairs.length} (query + cue_new + cue_prev each)`);
    console.log('');
    console.log('Sample pairs:');
    for (const p of pairs.slice(0, 3)) {
      console.log(`  qid=${p.qid}`);
      console.log(`  query   : ${p.query.slice(0, 70)}`);
      console.log(`  cue_new : ${p.cue_new.slice(0, 70)}`);
      console.log(`  cue_prev: ${p.cue_prev.slice(0, 70)}`);
      console.log('');
    }
    console.log(`[diagnose] Dry-run OK — found ${pairs.length} KU pairs ready for embedding.`);
    console.log('[diagnose] Run without --dry-run (with OPENAI_API_KEY set) to embed and measure cosines.');
    process.exit(0);
  }

  // ---- REAL RUN: embed both models and compute cosines --------------------

  // T-26-01: key from env only; never log the key value itself.
  const apiKey = process.env['OPENAI_API_KEY'] || '';
  if (!apiKey) {
    console.error('[diagnose] OPENAI_API_KEY not set. Export it from your sleep.env and retry.');
    console.error('[diagnose] Example: set -a; . ~/.config/recense/sleep.env; set +a');
    process.exit(1);
  }

  console.log('[diagnose] Embedding KU query/cue pairs with two models...');
  console.log(`[diagnose] Pairs: ${pairs.length} (each embedded as 3 texts: query, cue_new, cue_prev)`);
  console.log(`[diagnose] Models: text-embedding-3-small@1536  vs  text-embedding-3-large@1536`);
  console.log(`[diagnose] No instruction prefix — D-03 (OpenAI models are symmetric)`);
  console.log('');

  // Collect all unique texts (queries + cue_new + cue_prev)
  const queryTexts  = pairs.map(p => p.query);
  const cueNewTexts = pairs.map(p => p.cue_new);
  const cuePrevTexts = pairs.map(p => p.cue_prev);
  const allTexts = [...queryTexts, ...cueNewTexts, ...cuePrevTexts];

  // Embed with small model
  const smallEmbedder = new OpenAIEmbedder('text-embedding-3-small', 1536);
  console.log('[diagnose] Embedding with text-embedding-3-small@1536 ...');
  const smallVecs = await smallEmbedder.embed(allTexts);

  // Embed with large model
  const largeEmbedder = new OpenAIEmbedder('text-embedding-3-large', 1536);
  console.log('[diagnose] Embedding with text-embedding-3-large@1536 ...');
  const largeVecs = await largeEmbedder.embed(allTexts);

  const n = pairs.length;

  // Compute cosines per pair for each model
  // Hypothesis: query × cue_new = does the CURRENT value cluster with the question?
  // Hypothesis: query × cue_prev = does the PREVIOUS (contradicted) value cluster?
  // Both are relevant — the judge needs EITHER to surface as a candidate.
  const results = pairs.map((p, i) => {
    const qSmall     = smallVecs[i];
    const qLarge     = largeVecs[i];
    const newSmall   = smallVecs[n + i];
    const newLarge   = largeVecs[n + i];
    const prevSmall  = smallVecs[2 * n + i];
    const prevLarge  = largeVecs[2 * n + i];

    return {
      qid:        p.qid,
      query:      p.query,
      cue_new:    p.cue_new,
      cue_prev:   p.cue_prev,
      // query × cue_new (new value — the answer node)
      small_new:  cosineSimF32(qSmall, newSmall),
      large_new:  cosineSimF32(qLarge, newLarge),
      // query × cue_prev (prev value — the contradicted node)
      small_prev: cosineSimF32(qSmall, prevSmall),
      large_prev: cosineSimF32(qLarge, prevLarge),
    };
  });

  // ---- Print per-pair table -----------------------------------------------
  const LINE_WIDTH = 100;
  const sep = '─'.repeat(LINE_WIDTH);

  console.log('\n=== Per-pair cosine table ===');
  console.log(`  Floor refs: rankedRetrievalFloor=${RANKED_RETRIEVAL_FLOOR}  candidate-band-floor (0.7)=${DELETED_SIMILARITY_THRESHOLD}`);
  console.log(`  "↑0.7" means pair clears the 0.7 candidate band`);
  console.log('');
  console.log(`  ${'qid'.padEnd(14)} ${'pair'.padEnd(8)} ${'small@1536'.padStart(10)} ${'large@1536'.padStart(10)} ${'Δ(L-S)'.padStart(8)} ${'clears 0.7?'.padStart(12)}`);
  console.log('  ' + sep);

  for (const r of results) {
    const qid = r.qid.slice(0, 12).padEnd(14);
    // new-value pair
    const clrSmallNew  = r.small_new  >= 0.7 ? 'S+L' : r.large_new  >= 0.7 ? 'L only' : 'none';
    const clrSmallPrev = r.small_prev >= 0.7 ? 'S+L' : r.large_prev >= 0.7 ? 'L only' : 'none';
    const deltaN = (r.large_new  - r.small_new).toFixed(4);
    const deltaP = (r.large_prev - r.small_prev).toFixed(4);
    console.log(`  ${qid} ${'new'.padEnd(8)} ${r.small_new.toFixed(4).padStart(10)} ${r.large_new.toFixed(4).padStart(10)} ${('+'+deltaN).padStart(8)} ${clrSmallNew.padStart(12)}`);
    console.log(`  ${qid} ${'prev'.padEnd(8)} ${r.small_prev.toFixed(4).padStart(10)} ${r.large_prev.toFixed(4).padStart(10)} ${('+'+deltaP).padStart(8)} ${clrSmallPrev.padStart(12)}`);
  }

  // ---- Aggregate summary --------------------------------------------------
  const smallAbove07New  = results.filter(r => r.small_new  >= 0.7).length;
  const largeAbove07New  = results.filter(r => r.large_new  >= 0.7).length;
  const smallAbove07Prev = results.filter(r => r.small_prev >= 0.7).length;
  const largeAbove07Prev = results.filter(r => r.large_prev >= 0.7).length;

  // Count pairs where large lifts above 0.7 but small does NOT
  const liftsNew  = results.filter(r => r.large_new  >= 0.7 && r.small_new  < 0.7).length;
  const liftsPrev = results.filter(r => r.large_prev >= 0.7 && r.small_prev < 0.7).length;

  console.log('\n=== Aggregate (pairs above 0.7 candidate band) ===');
  console.log(`  ${''.padEnd(20)} ${'small@1536'.padStart(12)} ${'large@1536'.padStart(12)} ${'lifts'.padStart(8)}`);
  console.log(`  ${'query × cue_new'.padEnd(20)} ${String(smallAbove07New).padStart(12)} ${String(largeAbove07New).padStart(12)} ${String(liftsNew).padStart(8)}`);
  console.log(`  ${'query × cue_prev'.padEnd(20)} ${String(smallAbove07Prev).padStart(12)} ${String(largeAbove07Prev).padStart(12)} ${String(liftsPrev).padStart(8)}`);
  console.log(`  ${'total pairs:'.padEnd(20)} ${String(n).padStart(12)}`);

  // ---- Root-cause classification ------------------------------------------
  const isModelBound = (liftsNew > 0 || liftsPrev > 0);
  const classification = isModelBound ? 'model-bound' : 'NOT model-bound';

  console.log('\n=== Root-cause classification ===');
  if (isModelBound) {
    console.log(`  VERDICT: model-bound`);
    console.log(`  Rationale: text-embedding-3-large@1536 lifts ${liftsNew + liftsPrev} pair(s) above 0.7`);
    console.log(`  that text-embedding-3-small@1536 left below 0.7.`);
    console.log(`  The weakness IS the model ceiling, not the threshold or a missing prefix.`);
    console.log(`  GO: proceed with the model swap to text-embedding-3-large@1536.`);
  } else {
    console.log(`  VERDICT: NOT model-bound`);
    console.log(`  Neither model improves the pairs over 0.7.`);
    console.log(`  The fix lever is NOT the model swap — check threshold or other causes.`);
    console.log(`  NO-GO: do NOT proceed with the model swap as the primary fix.`);
  }

  // ---- Estimated cost note ------------------------------------------------
  const totalTexts = allTexts.length * 2; // two model calls
  const estimatedCharsTotal = allTexts.reduce((s, t) => s + t.length, 0) * 2;
  const estimatedTokens = Math.round(estimatedCharsTotal / 4);
  // text-embedding-3-large: $0.13/1M tokens; text-embedding-3-small: $0.02/1M tokens
  const costSmall = (estimatedTokens / 1_000_000) * 0.02;
  const costLarge = (estimatedTokens / 1_000_000) * 0.13;
  const totalCostEst = costSmall + costLarge;
  console.log('\n=== Estimated cost ===');
  console.log(`  Texts embedded: ${totalTexts} (${n} pairs × 3 texts × 2 models)`);
  console.log(`  Est. tokens   : ~${estimatedTokens.toLocaleString()}`);
  console.log(`  Est. cost     : ~$${totalCostEst.toFixed(4)} (small $${costSmall.toFixed(5)} + large $${costLarge.toFixed(5)})`);
  console.log(`  Well under $0.01 — this is the cheap diagnosis spot-check (D-01).`);

})().catch(e => {
  console.error('[diagnose] Fatal error:', e.message);
  process.exit(1);
});
