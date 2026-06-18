/**
 * Judge-replay isolation probe — Phase 26 plan 06 (D-02).
 *
 * Runs the live judge over the ~30 surfaced near-duplicate claim/candidate pairs
 * from the V3 NN scan (26-DIAGNOSIS-V3.md M2/M3), reads the verdicts, and recomputes
 * PE routing to split the duplicate-fact failure into two buckets:
 *
 *   (a) judge-miss   — judge returns unrelated/extend for a same-belief restatement.
 *       Fix target: src/model/judge.ts (prompt / classification).
 *   (b) pe-escape    — judge returns contradict but routeContradiction routes to
 *       append-new or hold instead of reconcile.
 *       Fix target: config.ts PE band constants / routeContradiction.
 *
 * The output DRIVES 26-07. Do not fix blind.
 *
 * Usage (run from repo root after `npm run build`):
 *   node scripts/eval/judge-replay-isolate.cjs [--dry-run] [--db PATH] [--out PATH] [--sample N]
 *
 *   --dry-run    NN scan + pollution filter only; no judge calls (zero cost/latency)
 *   --db PATH    Override DB path (else RECENSE_DB env, else homedir default)
 *   --out PATH   Output JSON path (default scripts/eval/results/judge-replay-isolate.json)
 *   --sample N   Live fact nodes to scan (default 400; matches v3)
 *
 * Judge provider: resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER').
 *   Default = free local stack (D-03). Set RECENSE_JUDGE_PROVIDER=claude-headless for
 *   headless Sonnet; MUST run under --setting-sources project to avoid the self-ingestion
 *   hook loop ([[claude-headless-self-ingestion-loop]]).
 *
 * Security (T-26-08..T-26-11):
 *   - Live DB opened READ-ONLY; probe makes ZERO writes to DB or config.
 *   - API keys read from process.env only; never logged, never written to results.
 *   - Pollution pairs (SUBCHECK_OK, "exit code 0", "completed with status") excluded
 *     from the judged set — they are self-ingestion artifacts, not real beliefs (D-05).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---- arg parsing -----------------------------------------------------------
const arg    = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const IS_DRY = process.argv.includes('--dry-run');
const SAMPLE = parseInt(arg('--sample', '400'), 10);

function defaultDbPath() {
  return path.join(os.homedir(), '.config', 'recense', 'recense.db');
}
const DB_PATH  = arg('--db', process.env['RECENSE_DB'] || defaultDbPath());
const OUT_PATH = arg('--out', path.join(__dirname, 'results', 'judge-replay-isolate.json'));

// cosine threshold for the NN scan (matches v3 — surface pairs >= 0.6)
const NN_THRESHOLD = 0.6;

// ---- dist module paths -----------------------------------------------------
const DIST_TOPK          = path.join(__dirname, '../../dist/src/retrieval/topk.js');
const DIST_JUDGE         = path.join(__dirname, '../../dist/src/model/judge.js');
const DIST_CONFIG        = path.join(__dirname, '../../dist/src/lib/config.js');
const DIST_UPDATE        = path.join(__dirname, '../../dist/src/consolidation/update-decision.js');
const DIST_SLEEP_PASS    = path.join(__dirname, '../../dist/src/consolidation/run-sleep-pass.js');

for (const p of [DIST_TOPK, DIST_JUDGE, DIST_CONFIG, DIST_UPDATE, DIST_SLEEP_PASS]) {
  if (!fs.existsSync(p)) {
    console.error(`[judge-replay] dist module not found: ${p}\nRun 'npm run build' first.`);
    process.exit(1);
  }
}

let Database;
try { Database = require('better-sqlite3'); }
catch { console.error('[judge-replay] better-sqlite3 not found. Run from repo root.'); process.exit(1); }

const { cosineSimF32 }          = require(DIST_TOPK);
const { AnthropicJudge }        = require(DIST_JUDGE);
const { DEFAULT_CONFIG }        = require(DIST_CONFIG);
const { routeContradiction }    = require(DIST_UPDATE);
const { resolveProviderOverlay } = require(DIST_SLEEP_PASS);

// ---- helpers ---------------------------------------------------------------

/** Decode a stored embedding BLOB (Buffer) → Float32Array (same as v3). */
function decodeVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Pollution filter — returns true for pairs that are self-ingestion artifacts,
 * not real beliefs.  Drop pairs containing SUBCHECK_OK check-reply tokens,
 * "exit code 0" task-runner lines, or "completed with status" status strings.
 * These inflate the near-dup count (D-05 / T-26-11) and should not be judged.
 *
 * Pattern matches are case-insensitive on the combined value text.
 */
const POLLUTION_RE = /SUBCHECK_OK|exit\s+code\s+0|completed\s+with\s+status/i;
// pollution exclusion — self-ingest artifacts are not real beliefs
function isPollution(valueA, valueB) {
  return POLLUTION_RE.test(valueA) || POLLUTION_RE.test(valueB);
}

/**
 * Pure inline effectiveStrength — mirrors src/strength/decay.ts without a DB write.
 * effective_s = s * exp(-lambda * deltaDays)
 */
function effectiveStrengthInline(s, lastAccessMs, nowMs, lambda) {
  const deltaDays = Math.max(0, nowMs - lastAccessMs) / 86_400_000;
  return s * Math.exp(-lambda * deltaDays);
}

// ---- main ------------------------------------------------------------------

(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[judge-replay] BLOCKER: live DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  // T-26-08: open READ-ONLY — probe makes zero writes
  const db = new Database(DB_PATH, { readonly: true });

  // ── Step 1: NN scan on stored vectors (mirrors diagnose-claim-path-v3.cjs) ──
  const factRows = db.prepare(
    "SELECT id, value, s, c, last_access, embedding " +
    "FROM node WHERE type='fact' AND tombstoned = 0 AND embedding IS NOT NULL " +
    "ORDER BY last_access DESC LIMIT ?"
  ).all(SAMPLE);

  console.log(`[judge-replay] Fact nodes loaded: ${factRows.length} (stored vectors, no re-embed)`);

  const decoded = factRows.map(r => ({
    id: r.id,
    value: r.value,
    s: r.s,
    c: r.c,
    last_access: r.last_access,
    vec: decodeVec(r.embedding),
  }));

  // Build candidate near-dup pairs (cosine >= NN_THRESHOLD, non-identical, non-pollution)
  const allPairs = [];
  for (let i = 0; i < decoded.length; i++) {
    for (let j = i + 1; j < decoded.length; j++) {
      const a = decoded[i];
      const b = decoded[j];
      if (a.vec.length !== b.vec.length) continue;
      if (a.value === b.value) continue;
      const cos = cosineSimF32(a.vec, b.vec);
      if (cos < NN_THRESHOLD) continue;
      allPairs.push({ a, b, cos });
    }
  }
  allPairs.sort((x, y) => y.cos - x.cos);

  // Pollution exclusion (D-05 / T-26-11)
  const cleanPairs = allPairs.filter(p => !isPollution(p.a.value, p.b.value));
  const pollutionCount = allPairs.length - cleanPairs.length;
  const topPairs = cleanPairs.slice(0, 30);

  console.log(`[judge-replay] Candidate pairs: ${allPairs.length} total | ${pollutionCount} pollution-excluded | ${cleanPairs.length} clean | top ${topPairs.length} to judge`);

  if (IS_DRY) {
    console.log('\n[judge-replay] --dry-run: no judge calls. Top pairs:');
    topPairs.forEach((p, i) => {
      console.log(`  [${i + 1}] cos=${p.cos.toFixed(4)}`);
      console.log(`      A (${p.a.id.slice(0, 8)}): ${p.a.value.slice(0, 80)}`);
      console.log(`      B (${p.b.id.slice(0, 8)}): ${p.b.value.slice(0, 80)}`);
    });
    db.close();
    console.log('\n[judge-replay] Dry-run OK.');
    process.exit(0);
  }

  // ── Step 2: resolve judge provider (D-03 — free local stack by default) ─────
  const overlay = resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER');
  const judgeConfig = { ...DEFAULT_CONFIG, dbPath: DB_PATH, ...overlay };

  console.log(`[judge-replay] Judge provider: ${judgeConfig.modelProvider}`);
  if (judgeConfig.modelProvider === 'claude-headless') {
    console.warn('[judge-replay] WARNING: headless/API judge selected — must run under --setting-sources project (D-03, [[claude-headless-self-ingestion-loop]])');
  }

  const judge = new AnthropicJudge(judgeConfig);
  const nowMs = Date.now();
  const lambda = DEFAULT_CONFIG.lambda;

  // ── Step 3 & 4: judge each pair + recompute PE routing ─────────────────────
  const results = [];
  let judged = 0;

  for (const pair of topPairs) {
    const { a, b, cos } = pair;
    process.stdout.write(`  [${++judged}/${topPairs.length}] cos=${cos.toFixed(4)} judging...`);

    // Construct judge call: claim = A's value, candidate = B (id + value)
    let verdict;
    try {
      verdict = await judge.judge(a.value, [{ id: b.id, value: b.value }]);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
      results.push({ pairIdx: judged, cosine: cos, claimId: a.id, candidateId: b.id,
        claimValue: a.value, candidateValue: b.value,
        relation: 'error', magnitude: 0, resistance: null, routedAction: null, bucket: 'error',
        error: e.message });
      continue;
    }

    // Step 3: for contradict verdicts, recompute PE routing
    let resistance = null;
    let routedAction = null;
    if (verdict.relation === 'contradict') {
      const effectiveS = effectiveStrengthInline(b.s, b.last_access, nowMs, lambda);
      resistance = effectiveS * b.c; // D-16: resistance = effective_s * c
      routedAction = routeContradiction(verdict.magnitude, resistance, DEFAULT_CONFIG);
    }

    // Step 4: classify into buckets
    // judge-miss: judge returns unrelated/extend for a same-belief pair
    // pe-escape:  judge returns contradict but routed to append-new or hold
    // correct:    judge returns confirm, or contradict → reconcile
    let bucket;
    if (verdict.relation === 'unrelated' || verdict.relation === 'extend') {
      bucket = 'judge-miss';
    } else if (verdict.relation === 'contradict' && (routedAction === 'append-new' || routedAction === 'hold')) {
      bucket = 'pe-escape';
    } else if (verdict.relation === 'confirm' || (verdict.relation === 'contradict' && routedAction === 'reconcile')) {
      bucket = 'correct';
    } else {
      bucket = 'unknown';
    }

    console.log(` ${verdict.relation}/${bucket}${routedAction ? `(${routedAction})` : ''}`);

    results.push({
      pairIdx: judged,
      cosine: parseFloat(cos.toFixed(4)),
      claimId: a.id,
      candidateId: b.id,
      claimValue: a.value,
      candidateValue: b.value,
      relation: verdict.relation,
      magnitude: verdict.magnitude,
      resistance: resistance !== null ? parseFloat(resistance.toFixed(6)) : null,
      routedAction,
      bucket,
    });
  }

  db.close();

  // ── Step 5: tabulate + determine dominant failure path ──────────────────────
  const counts = { 'judge-miss': 0, 'pe-escape': 0, 'correct': 0, 'error': 0, 'unknown': 0 };
  for (const r of results) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;

  const judgeMiss = counts['judge-miss'];
  const peEscape  = counts['pe-escape'];

  let dominantPath;
  let fixTarget;
  if (judgeMiss > peEscape) {
    dominantPath = 'judge-miss';
    fixTarget = 'judge prompt (src/model/judge.ts) — judge mis-classifies same-belief restatements as unrelated/extend';
  } else if (peEscape > judgeMiss) {
    dominantPath = 'pe-escape';
    fixTarget = 'PE routing (config.ts band constants / routeContradiction) — judge says contradict but routing escapes to append-new/hold';
  } else if (judgeMiss === 0 && peEscape === 0) {
    dominantPath = 'none';
    fixTarget = 'no dominant failure — pairs classified as correct; investigate further';
  } else {
    dominantPath = 'both';
    fixTarget = 'both — judge-miss and pe-escape tied; fix both src/model/judge.ts and config.ts PE band constants';
  }

  // ── Step 6: print summary ───────────────────────────────────────────────────
  console.log('\n=== Judge-replay bucket summary ===');
  console.log(`  Pairs judged   : ${results.length}`);
  console.log(`  judge-miss     : ${judgeMiss}`);
  console.log(`  pe-escape      : ${peEscape}`);
  console.log(`  correct        : ${counts['correct']}`);
  console.log(`  error/unknown  : ${(counts['error'] ?? 0) + (counts['unknown'] ?? 0)}`);
  console.log(`\n  Dominant path  : ${dominantPath}`);
  console.log(`  Fix target     : ${fixTarget}`);

  // ── Step 7: write verdict JSON ─────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  // T-26-09: never write API keys to the results file
  const meta = {
    judgeProvider: judgeConfig.modelProvider,
    pairCount: results.length,
    pollutionExcluded: pollutionCount,
    date: new Date().toISOString(),
  };

  const out = {
    meta,
    summary: { judgeMiss, peEscape, correct: counts['correct'],
      errorUnknown: (counts['error'] ?? 0) + (counts['unknown'] ?? 0),
      dominantPath, fixTarget },
    pairs: results,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n[judge-replay] Results written to ${OUT_PATH}`);
  console.log(`[judge-replay] Done. Dominant failure: ${dominantPath} → ${fixTarget}`);
})().catch(e => { console.error('[judge-replay] Fatal:', e.message); process.exit(1); });
