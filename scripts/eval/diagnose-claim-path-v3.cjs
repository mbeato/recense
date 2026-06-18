/**
 * Claim-path diagnosis V3 — measure the REAL consolidation cue shape + gates.
 *
 * V1/V2 measured QUESTION-vs-node cues (~0.45 cosine). But production
 * reconsolidation is driven by NEW-CLAIM-vs-stored-node cues during the sleep
 * pass. This script measures the actual cue shape and the threshold bands so we
 * know exactly which lever to pull.
 *
 * GROUNDED FLOW (see 26-DIAGNOSIS-V3.md for file:line refs):
 *   - consolidator.ts embeds `claim.value` (raw claim string) and runs
 *     retriever.topk(queryVec, candidateK=5) against stored node embeddings.
 *   - If top candidate cosine < unrelatedSimilarityThreshold (0.3) AND no anchors
 *     → auto-"unrelated" → a NEW node is minted (the duplicate). Else → judge.
 *   - The judge's contradict verdict then routes via PE/resistance
 *     (peAppendNewMinResistance etc.), NOT via deletedSimilarityThreshold (0.7),
 *     which only gates the retrieval forget/deleted path in engine.ts.
 *
 * Usage (run from repo root after `npm run build`):
 *   node scripts/eval/diagnose-claim-path-v3.cjs --dry-run     # $0, no API
 *   OPENAI_API_KEY=... node scripts/eval/diagnose-claim-path-v3.cjs
 *
 * Optional flags:
 *   --dry-run     Counts + NN scan only (uses STORED vectors); zero API calls
 *   --db PATH     Override DB path (else RECENSE_DB env, else homedir default)
 *   --sample N    Live fact nodes to scan for near-dups (default 400)
 *
 * Security (T-26-01): OPENAI_API_KEY read from process.env only — never logged,
 * never written to any file. Live DB opened READ-ONLY (T-26-02).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---- arg parsing -----------------------------------------------------------
const arg     = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const IS_DRY  = process.argv.includes('--dry-run');
const SAMPLE  = parseInt(arg('--sample', '400'), 10);

function defaultDbPath() {
  return path.join(os.homedir(), '.config', 'recense', 'recense.db');
}
const DB_PATH = arg('--db', process.env['RECENSE_DB'] || defaultDbPath());

// Gates (from src/lib/config.ts defaults — the levers under test)
const UNRELATED_THRESH = 0.3; // unrelatedSimilarityThreshold — below → auto-unrelated → dup minted
const DELETED_THRESH   = 0.7; // deletedSimilarityThreshold — retrieval forget band (NOT consol gate)

let Database;
try { Database = require('better-sqlite3'); }
catch { console.error('[v3] better-sqlite3 not found. Run from repo root.'); process.exit(1); }

const DIST_EMBEDDER = path.join(__dirname, '../../dist/src/model/embedder.js');
const DIST_TOPK     = path.join(__dirname, '../../dist/src/retrieval/topk.js');
if (!fs.existsSync(DIST_EMBEDDER) || !fs.existsSync(DIST_TOPK)) {
  console.error('[v3] dist/ not found. Run `npm run build` first.'); process.exit(1);
}
let OpenAIEmbedder, cosineSimF32;
try {
  ({ OpenAIEmbedder } = require(DIST_EMBEDDER));
  ({ cosineSimF32 }   = require(DIST_TOPK));
} catch (e) { console.error('[v3] load failed:', e.message); process.exit(1); }

// Decode a stored embedding BLOB (Buffer) → Float32Array (Pitfall 5: byteOffset + length).
function decodeVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function bandOf(cos) {
  if (cos < UNRELATED_THRESH) return '<0.3';
  if (cos < DELETED_THRESH)   return '0.3-0.7';
  return '>=0.7';
}

(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[v3] BLOCKER: live DB not found at ${DB_PATH}. Stopping.`);
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true }); // T-26-02: read-only

  // === MEASUREMENT 1: reference distribution — successful reconciliations ===
  // For live nodes with prev_value (these DID reconcile), measure cosine of the
  // CURRENT value vs the PRIOR value it replaced. This is the "belief-vs-belief"
  // shape that cleared the gate and reached the judge as a contradiction.
  const prevRows = db.prepare(
    "SELECT id, value, prev_value FROM node WHERE prev_value IS NOT NULL AND tombstoned = 0"
  ).all();
  console.log(`[v3] Reference set (prev_value, reconciled): ${prevRows.length} nodes`);

  // === MEASUREMENT 2 setup: live fact nodes with stored embeddings ===
  // Reuse STORED vectors — no re-embedding. Bounded NN scan for near-dup pairs.
  const factRows = db.prepare(
    "SELECT id, value, embedding FROM node WHERE type='fact' AND tombstoned = 0 AND embedding IS NOT NULL " +
    "ORDER BY last_access DESC LIMIT ?"
  ).all(SAMPLE);
  console.log(`[v3] Fact-node NN-scan sample: ${factRows.length} (stored vectors, no re-embed)`);

  if (IS_DRY) {
    // Dry-run: do the $0 work that needs no API — the NN scan on stored vectors +
    // print top near-dup pairs. (Reference-set cosine needs fresh embeds → skipped.)
    console.log('[v3] --dry-run: NN scan on stored vectors (zero API calls)\n');
  }

  // --- NN scan on stored vectors (always runs; pure local compute) ---
  const decoded = factRows.map(r => ({ id: r.id, value: r.value, vec: decodeVec(r.embedding) }));
  const pairs = [];
  for (let i = 0; i < decoded.length; i++) {
    for (let j = i + 1; j < decoded.length; j++) {
      if (decoded[i].vec.length !== decoded[j].vec.length) continue;
      const cos = cosineSimF32(decoded[i].vec, decoded[j].vec);
      // Only keep high-cosine non-identical pairs (candidate near-dups)
      if (cos >= 0.6 && decoded[i].value !== decoded[j].value) {
        pairs.push({ a: decoded[i], b: decoded[j], cos });
      }
    }
  }
  pairs.sort((x, y) => y.cos - x.cos);
  const topPairs = pairs.slice(0, 30); // surface top 30 for eyeballing

  console.log(`=== MEASUREMENT 2: top near-duplicate live fact pairs (stored vectors) ===`);
  console.log(`  (cosine >= 0.6, non-identical; top 30 of ${pairs.length} candidate pairs)\n`);
  topPairs.forEach((p, idx) => {
    console.log(`  [${idx + 1}] cos=${p.cos.toFixed(4)}`);
    console.log(`      A: ${p.a.value.slice(0, 90)}`);
    console.log(`      B: ${p.b.value.slice(0, 90)}`);
  });

  // Band distribution for the candidate near-dup pairs
  const nnBands = { '<0.3': 0, '0.3-0.7': 0, '>=0.7': 0 };
  for (const p of pairs) nnBands[bandOf(p.cos)]++;

  if (IS_DRY) {
    console.log(`\n[v3] NN-scan band distribution (candidate near-dup pairs, cos>=0.6 surfaced):`);
    console.log(`  0.3-0.7 : ${nnBands['0.3-0.7']}`);
    console.log(`  >=0.7   : ${nnBands['>=0.7']}`);
    db.close();
    console.log(`\n[v3] Dry-run OK. Run without --dry-run to add reference-set cosine (fresh embeds).`);
    process.exit(0);
  }

  // === REAL RUN: reference-set cosine needs fresh embeddings ===
  const apiKey = process.env['OPENAI_API_KEY'] || '';
  if (!apiKey) {
    db.close();
    console.error('[v3] OPENAI_API_KEY not set. Export from sleep.env and retry. Stopping.');
    process.exit(1);
  }
  const emb = new OpenAIEmbedder('text-embedding-3-small', 1536);

  // MEASUREMENT 1: cosine(value, prev_value) for reconciled nodes.
  console.log('\n[v3] Embedding reference set (value + prev_value) with small@1536 ...');
  const refValues = prevRows.map(r => r.value);
  const refPrevs  = prevRows.map(r => r.prev_value);
  const vVecs = await emb.embed(refValues);
  const pVecs = await emb.embed(refPrevs);
  const refCos = prevRows.map((r, i) => cosineSimF32(vVecs[i], pVecs[i]));

  const refBands = { '<0.3': 0, '0.3-0.7': 0, '>=0.7': 0 };
  for (const c of refCos) refBands[bandOf(c)]++;
  const refSorted = [...refCos].sort((a, b) => a - b);
  const refMean = refCos.reduce((s, v) => s + v, 0) / refCos.length;
  const pct = q => refSorted[Math.floor(refSorted.length * q)] ?? refSorted[0];

  console.log('\n=== MEASUREMENT 1: reference distribution (value vs prev_value, reconciled) ===');
  console.log(`  N=${refCos.length}  mean=${refMean.toFixed(4)}  min=${refSorted[0].toFixed(4)}  max=${refSorted[refSorted.length-1].toFixed(4)}`);
  console.log(`  p10=${pct(0.10).toFixed(4)}  p50=${pct(0.50).toFixed(4)}  p90=${pct(0.90).toFixed(4)}`);
  console.log(`  bands: <0.3=${refBands['<0.3']}  0.3-0.7=${refBands['0.3-0.7']}  >=0.7=${refBands['>=0.7']}`);

  // === MEASUREMENT 3: threshold sweep — how many real pairs each gate admits ===
  // The consolidation candidate gate is unrelatedSimilarityThreshold (0.3): a claim
  // whose best candidate cosine is BELOW it auto-mints a duplicate. So pairs in
  // <0.3 are gated OUT of the judge (→ dup). Quantify for both sets.
  console.log('\n=== MEASUREMENT 3: gate analysis ===');
  console.log('  Consolidation candidate gate = unrelatedSimilarityThreshold (0.3).');
  console.log('  A claim whose top candidate cosine < 0.3 (and no anchor) auto-mints a NEW node.');
  console.log('');
  console.log('  Reference set (reconciled — these reached the judge):');
  console.log(`    below 0.3 (would have been gated out): ${refBands['<0.3']}/${refCos.length}`);
  console.log(`    0.3-0.7 (reached judge, below forget band): ${refBands['0.3-0.7']}/${refCos.length}`);
  console.log(`    >=0.7: ${refBands['>=0.7']}/${refCos.length}`);
  console.log('');
  console.log('  Surfaced near-dup fact pairs (these were minted separately = the symptom):');
  console.log(`    below 0.3: ${nnBands['<0.3']}`);
  console.log(`    0.3-0.7  : ${nnBands['0.3-0.7']}`);
  console.log(`    >=0.7    : ${nnBands['>=0.7']}`);

  // How many of the surfaced near-dup pairs are ABOVE 0.3 (i.e. they DID reach the
  // candidate set, so the 0.3 gate did NOT cause their duplication — the judge/PE
  // routing did)?
  const topAbove03 = topPairs.filter(p => p.cos >= UNRELATED_THRESH).length;
  console.log('');
  console.log(`  Of the top-30 surfaced near-dup pairs, ${topAbove03}/30 have cosine >= 0.3`);
  console.log(`  → they cleared the consolidation candidate gate but were STILL minted as dups.`);

  // === MEASUREMENT 4: cue-shape comparison ===
  console.log('\n=== MEASUREMENT 4: cue-shape comparison ===');
  console.log(`  V2 question-vs-node mean cosine : ~0.45 (recall cue shape)`);
  console.log(`  V3 belief-vs-prior mean cosine  : ${refMean.toFixed(4)} (reconciled reference)`);
  const nnAboveMean = topPairs.reduce((s, p) => s + p.cos, 0) / topPairs.length;
  console.log(`  V3 near-dup pair mean (top 30)  : ${nnAboveMean.toFixed(4)} (symptom set)`);
  console.log(`  → claim/belief-shaped cues ${refMean > 0.5 ? 'DO' : 'do NOT'} score materially higher than question cues.`);

  db.close();

  // === Cost ===
  const chars = [...refValues, ...refPrevs].reduce((s, t) => s + t.length, 0);
  const tokens = Math.round(chars / 4);
  console.log('\n=== Estimated cost ===');
  console.log(`  Texts embedded: ${refValues.length + refPrevs.length}  Est. tokens: ~${tokens.toLocaleString()}`);
  console.log(`  Est. cost: ~$${((tokens / 1_000_000) * 0.02).toFixed(4)} (small@1536 only)`);

  console.log('\n[v3] Done. See 26-DIAGNOSIS-V3.md for the fix recommendation.');
})().catch(e => { console.error('[v3] Fatal:', e.message); process.exit(1); });
