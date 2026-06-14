/**
 * Snapshot-match threshold calibration eval — DEBT-04.
 *
 * Sweeps snapshotMatchThreshold (0.70→0.95, step 0.01) against the eval_snapshot rows
 * in the founder's recense.db and reports the cosine distribution + per-threshold match rate.
 *
 * Usage (run from repo root after `npm run build`):
 *
 *   RECENSE_DB=/path/to/recense.db OPENAI_API_KEY=... \
 *   node scripts/eval/calibrate-snapshot-threshold.cjs
 *
 * Optional flags:
 *   --db    /path/to/recense.db    (overrides RECENSE_DB)
 *   --out   results.json         (write detailed results to JSON; default: print only)
 *   --step  0.01                 (threshold sweep step; default 0.01)
 *
 * Security (T-09-15): opens recense.db with { readonly: true } — never writes the graph.
 *
 * NOTES:
 *  - Requires a populated eval_snapshot table (add anchors via `recense snapshot`).
 *  - Requires OPENAI_API_KEY for embedding.
 *  - Requires compiled dist/ (run `npm run build` first).
 *  - Calling replaySnapshots() once with threshold=0.0 collects all cosine values;
 *    the sweep re-thresholds in-memory (single embedding API call, not one per threshold).
 */
'use strict';

const fs    = require('fs');
const path  = require('path');

// ---- arg parsing -----------------------------------------------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DB_PATH  = arg('--db',   process.env['RECENSE_DB'] || '');
const OUT      = arg('--out',  null);
const STEP     = parseFloat(arg('--step', '0.01'));
const SWEEP_LO = 0.70;
const SWEEP_HI = 0.95;

// ---- dependency check: better-sqlite3 + dist/ ------------------------------
let Database;
try { Database = require('better-sqlite3'); }
catch (e) {
  console.error('[calibrate] better-sqlite3 not found. Run from repo root with node_modules installed.');
  process.exit(1);
}

const DIST_SNAPSHOT = path.join(__dirname, '../../dist/src/eval/snapshot.js');
const DIST_CONFIG   = path.join(__dirname, '../../dist/src/lib/config.js');
if (!fs.existsSync(DIST_SNAPSHOT) || !fs.existsSync(DIST_CONFIG)) {
  console.error('[calibrate] dist/ not found. Run `npm run build` before calibrating.');
  process.exit(1);
}

let replaySnapshots, DEFAULT_CONFIG;
try {
  ({ replaySnapshots } = require(DIST_SNAPSHOT));
  ({ DEFAULT_CONFIG }  = require(DIST_CONFIG));
} catch (e) {
  console.error('[calibrate] Failed to load compiled modules:', e.message);
  process.exit(1);
}

// ---- OpenAI embedding provider ---------------------------------------------
const OPENAI_KEY = process.env['OPENAI_API_KEY'] || '';
async function embed(texts) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set — required for embedding');
  const OpenAI = require('openai');
  const client = new OpenAI.default({ apiKey: OPENAI_KEY });
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return res.data.map(d => new Float32Array(d.embedding));
}

// ---- main ------------------------------------------------------------------
(async () => {
  // 1. Validate DB path
  if (!DB_PATH) {
    console.error('[calibrate] No DB path. Set RECENSE_DB or pass --db /path/to/recense.db');
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[calibrate] recense.db not found at: ${DB_PATH}`);
    process.exit(1);
  }

  // 2. Open read-only (T-09-15: calibration script must never write the graph)
  const db = new Database(DB_PATH, { readonly: true });

  try {
    // 3. Check eval_snapshot row count
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM eval_snapshot').get();
    if (c === 0) {
      console.log('[calibrate] eval_snapshot table is empty.');
      console.log('[calibrate] Add reference anchors first via `recense snapshot` CLI,');
      console.log('[calibrate] then re-run this script to measure the threshold.');
      console.log('[calibrate] Exiting — no calibration data available.');
      db.close();
      process.exit(1);
    }

    console.log(`[calibrate] Found ${c} eval_snapshot rows. Running replay at threshold=0.0 to collect cosines...`);
    console.log('[calibrate] (This embeds all queries and expected/current answer pairs — may take a moment)');

    // 4. Run replaySnapshots once at threshold=0.0 so all results are returned
    //    regardless of match/miss, and we get the raw cosine for each pair.
    const zeroConfig = { ...DEFAULT_CONFIG, snapshotMatchThreshold: 0.0 };
    const results = await replaySnapshots(db, embed, zeroConfig);

    const cosines = results.map(r => r.cosine);
    const n = cosines.length;
    if (n === 0) {
      console.log('[calibrate] replaySnapshots returned 0 results (unexpected). Exiting.');
      db.close();
      process.exit(1);
    }

    // 5. Compute basic cosine statistics
    const sorted = [...cosines].sort((a, b) => a - b);
    const mean   = cosines.reduce((s, v) => s + v, 0) / n;
    const min    = sorted[0];
    const max    = sorted[n - 1];
    const p10    = sorted[Math.floor(n * 0.10)] ?? sorted[0];
    const p25    = sorted[Math.floor(n * 0.25)] ?? sorted[0];
    const p50    = sorted[Math.floor(n * 0.50)] ?? sorted[0];
    const p75    = sorted[Math.floor(n * 0.75)] ?? sorted[0];
    const p90    = sorted[Math.floor(n * 0.90)] ?? sorted[0];

    console.log('\n=== Cosine Distribution ===');
    console.log(`  n     : ${n}`);
    console.log(`  min   : ${min.toFixed(4)}`);
    console.log(`  p10   : ${p10.toFixed(4)}`);
    console.log(`  p25   : ${p25.toFixed(4)}`);
    console.log(`  median: ${p50.toFixed(4)}`);
    console.log(`  p75   : ${p75.toFixed(4)}`);
    console.log(`  p90   : ${p90.toFixed(4)}`);
    console.log(`  max   : ${max.toFixed(4)}`);
    console.log(`  mean  : ${mean.toFixed(4)}`);

    // 6. Threshold sweep
    //    At each threshold: "pass" = cosine >= threshold (match = non-regression).
    //    "fail" = cosine < threshold (flagged as regression).
    //    Without labeled ground truth (regression vs non-regression), we report
    //    the pass rate at each threshold rather than FP/FN.
    //    Interpretation: a threshold where most stable pairs fail = too tight (many FP);
    //    a threshold where most degraded pairs pass = too loose (many FN).
    console.log('\n=== Threshold Sweep ===');
    console.log('  threshold  pass  fail  pass%');
    const sweepResults = [];
    for (let t = SWEEP_LO; t <= SWEEP_HI + 1e-9; t += STEP) {
      const tRound = Math.round(t * 100) / 100;
      const pass = cosines.filter(c => c >= tRound).length;
      const fail = n - pass;
      const pct  = ((pass / n) * 100).toFixed(1);
      console.log(`  ${tRound.toFixed(2)}       ${String(pass).padStart(4)}  ${String(fail).padStart(4)}  ${pct}%`);
      sweepResults.push({ threshold: tRound, pass, fail, passRate: pass / n });
    }

    // 7. Recommendation: choose the threshold at the "knee" of the pass-rate curve —
    //    the highest threshold where the pass rate is still >= 0.90 (i.e., at least
    //    90% of existing anchors still pass). This is conservative; tighten manually
    //    by reviewing the per-result cosines in the JSON output.
    //    Constraint: must stay above deletedSimilarityThreshold (0.7).
    const candidates = sweepResults.filter(r => r.passRate >= 0.90 && r.threshold > 0.70);
    const recommended = candidates.length > 0
      ? candidates[candidates.length - 1].threshold   // highest threshold where ≥90% pass
      : sweepResults.find(r => r.threshold === 0.85)?.threshold ?? 0.85;

    console.log(`\n=== Recommendation ===`);
    console.log(`  Recommended threshold: ${recommended.toFixed(2)}`);
    console.log(`  (Highest value where ≥90% of anchors still pass; manually inspect JSON output for edge cases)`);
    console.log(`\n  To apply: update snapshotMatchThreshold in src/lib/config.ts to ${recommended.toFixed(2)}`);
    console.log(`  Then re-run calibration to confirm no regression on the full suite.`);

    // 8. Write JSON output if requested
    if (OUT) {
      const output = {
        date: new Date().toISOString(),
        db: DB_PATH,
        n,
        distribution: { min, p10, p25, p50, p75, p90, max, mean },
        sweep: sweepResults,
        recommended,
        results: results.map(r => ({ id: r.id, query: r.query.slice(0, 80), cosine: r.cosine })),
      };
      fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
      console.log(`\n  Full results written to: ${OUT}`);
    }

  } finally {
    db.close();
  }
})().catch(e => {
  console.error('[calibrate] Fatal error:', e.message);
  process.exit(1);
});
