/**
 * Phase 35 RANK-02 strength-weight sweep driver.
 *
 * Sweeps w ∈ {0, 0.25, 0.5, 1.0, 2.0} over the KU harness (default) or the
 * LongMemEval harness + scorer (--lme), collecting one JSON result per w, and
 * prints a comparison table plus the argmax w.
 *
 * Requires:
 *   - OPENAI_API_KEY and ANTHROPIC_API_KEY exported in the shell (never logged here).
 *   - `npm run build` run before executing this script.
 *   - KU path: cached extraction at ~/.recense-eval-cache/eval01-n20-2026-06-16/
 *   - LME path (--lme): scripts/eval/longmemeval-s.jsonl (not committed, ~3 GB).
 *
 * Usage:
 *   # KU sweep (cheap, ~18 cases, runs first):
 *   node scripts/eval/35-strength-sweep.cjs
 *
 *   # LME sweep (paid, needs explicit budget approval ≥$3):
 *   node scripts/eval/35-strength-sweep.cjs --lme
 *
 *   # Override the w grid (comma-separated):
 *   node scripts/eval/35-strength-sweep.cjs --weights 0,0.5,1.0
 *
 *   # Dry-run: validate harness wiring without API calls (KU path only):
 *   node scripts/eval/35-strength-sweep.cjs --dry-run
 *
 *   # Headless sweep (subscription-billed, ~$0 marginal cost):
 *   node scripts/eval/35-strength-sweep.cjs --headless
 *   # Equivalent to: RECENSE_MODEL_PROVIDER=claude-headless node scripts/eval/35-strength-sweep.cjs
 *   # When --headless is active:
 *   #   - Extraction, judge (sleep-pass): use claude-headless (RECENSE_MODEL_PROVIDER)
 *   #   - Answer/rewrite generation (harness): uses RECENSE_ANSWER_PROVIDER → claude-headless
 *   #   - LME scorer judge: uses RECENSE_SCORER_PROVIDER → claude-headless
 *   #   - OPENAI_API_KEY is still required for question embeddings.
 *   #   - ANTHROPIC_API_KEY is NOT required (stripped by the headless transport).
 *
 * Sanity check (Pitfall 3): w values must NOT all produce the same ku_score.
 * Uniform scores mean the queryText fix is not in effect — stop and debug.
 *
 * Output files: scripts/eval/results/35-sweep-w<value>.json for each w.
 * Comparison table printed to stdout; winning w (argmax headline metric) named.
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync, spawnSync } = require('child_process');

// ---- arg parsing ------------------------------------------------------------

const argv = process.argv.slice(2);
const arg  = (k, d) => { const i = argv.indexOf(k); return i !== -1 ? argv[i + 1] : d; };

const IS_LME      = argv.includes('--lme');
const IS_DRY_RUN  = argv.includes('--dry-run');
// --headless: inject RECENSE_MODEL_PROVIDER=claude-headless into child env so the
// entire sweep (extraction, judge, answer-gen, scorer) is subscription-billed.
// Equivalent to exporting RECENSE_MODEL_PROVIDER=claude-headless before running.
// OPENAI_API_KEY is still required for embeddings; ANTHROPIC_API_KEY is not needed.
const IS_HEADLESS = argv.includes('--headless');

// Default w grid (D-05 range). Override with --weights 0,0.25,0.5,1.0,2.0
const weightsArg = arg('--weights', '0,0.25,0.5,1.0,2.0');
const W_GRID     = weightsArg.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

const RESULTS_DIR = path.resolve(__dirname, 'results');

// ---- API key guard ----------------------------------------------------------
// When --headless is active (or RECENSE_MODEL_PROVIDER=claude-headless is set),
// ANTHROPIC_API_KEY is not required — the headless transport strips it and bills
// the Max subscription instead. OPENAI_API_KEY is always required for embeddings.

const effectiveHeadless = IS_HEADLESS || process.env.RECENSE_MODEL_PROVIDER === 'claude-headless';

if (!IS_DRY_RUN) {
  const missing = [];
  if (!process.env.OPENAI_API_KEY)                         missing.push('OPENAI_API_KEY');
  if (!effectiveHeadless && !process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    console.error(`\nERROR: missing environment variable(s): ${missing.join(', ')}`);
    console.error('Export them before running the sweep, or use --dry-run to validate wiring only.');
    console.error('Keys are read from the environment and NEVER written to any output file.');
    if (!effectiveHeadless) {
      console.error('TIP: use --headless to route all LLM calls through the subscription-billed transport (no ANTHROPIC_API_KEY needed).');
    }
    process.exit(1);
  }
}

// ---- helpers ----------------------------------------------------------------

/** Format a w value for use in filenames: 0.25 → "0.25", 1.0 → "1.0". */
function wLabel(w) {
  return String(w);
}

/** Output JSON path for a given w. */
function outPath(w) {
  return path.join(RESULTS_DIR, `35-sweep-w${wLabel(w)}.json`);
}

/** Read a JSON result file; returns null on error. */
function readResult(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

/**
 * Extract the primary headline metric from a result JSON.
 * KU harness  → scores.ku_score (0–1)
 * LME scorer  → scores.headline (0–1)
 * Returns null if the metric is not found.
 */
function extractHeadline(result, isLme) {
  if (!result) return null;
  if (isLme) return result?.scores?.headline ?? null;
  return result?.scores?.ku_score ?? null;
}

/**
 * Extract the knowledge-update sub-score (LME only).
 * Returns null for KU path or when absent.
 */
function extractKuSub(result, isLme) {
  if (!isLme || !result) return null;
  return result?.scores?.by_category?.['knowledge-update'] ?? null;
}

// ---- child env: inherit parent env; inject RECENSE_MODEL_PROVIDER when --headless ----

function buildChildEnv() {
  const env = { ...process.env };
  if (IS_HEADLESS) {
    // --headless: ensure all role-key resolvers see claude-headless as the base provider.
    // Individual harnesses then resolve RECENSE_ANSWER_PROVIDER / RECENSE_SCORER_PROVIDER
    // through resolveProviderOverlay → RECENSE_MODEL_PROVIDER → claude-headless.
    env['RECENSE_MODEL_PROVIDER'] = 'claude-headless';
  }
  return env;
}

// ---- KU sweep: spawns replay-ku-harness.cjs per w --------------------------

function runKuHarness(w, outFile) {
  const harnessPath = path.resolve(__dirname, 'replay-ku-harness.cjs');
  const args = [
    harnessPath,
    '--strength-weight', String(w),
    '--out', outFile,
  ];
  if (IS_DRY_RUN) args.push('--dry-run');

  console.log(`  [w=${w}] running KU harness...`);
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env:   buildChildEnv(),
    cwd:   path.resolve(__dirname, '../..'),
  });
  if (result.status !== 0) {
    console.error(`  [w=${w}] KU harness exited with status ${result.status}`);
    return false;
  }
  return true;
}

// ---- LME sweep: spawns longmemeval-harness.cjs + longmemeval-scorer.cjs ----

function runLmeHarness(w, hypothesesFile) {
  const harnessPath = path.resolve(__dirname, 'longmemeval-harness.cjs');
  const args = [
    harnessPath,
    '--hybrid',
    '--strength-weight', String(w),
    '--out', hypothesesFile,
  ];
  if (IS_DRY_RUN) args.push('--dry-run');

  console.log(`  [w=${w}] running LME harness (--hybrid --strength-weight ${w})...`);
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env:   buildChildEnv(),
    cwd:   path.resolve(__dirname, '../..'),
  });
  if (result.status !== 0) {
    console.error(`  [w=${w}] LME harness exited with status ${result.status}`);
    return false;
  }
  return true;
}

function runLmeScorer(hypothesesFile, outFile) {
  const scorerPath = path.resolve(__dirname, 'longmemeval-scorer.cjs');
  const evalFile   = path.resolve(__dirname, 'longmemeval-s.jsonl');
  const args = [
    scorerPath,
    '--hypotheses', hypothesesFile,
    '--eval',       evalFile,
    '--out',        outFile,
  ];

  console.log(`  scoring LME hypotheses...`);
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env:   buildChildEnv(),
    cwd:   path.resolve(__dirname, '../..'),
  });
  if (result.status !== 0) {
    console.error(`  LME scorer exited with status ${result.status}`);
    return false;
  }
  return true;
}

// ---- main -------------------------------------------------------------------

(async () => {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

  const mode = IS_LME ? 'LME (--lme)' : 'KU (default)';
  console.log('\nPhase 35 Strength-Weight Sweep (RANK-02)');
  console.log(`Mode:     ${mode}`);
  console.log(`W grid:   [${W_GRID.join(', ')}]`);
  console.log(`Commit:   ${commit}`);
  console.log(`Dry-run:  ${IS_DRY_RUN}`);
  console.log(`Headless: ${effectiveHeadless} (subscription-billed via claude -p; OPENAI_API_KEY still needed for embeddings)`);
  console.log(`Out dir:  ${RESULTS_DIR}\n`);

  if (IS_DRY_RUN) {
    console.log('NOTE: --dry-run active. No API calls will be made. Scores will be null.\n');
  }

  // ---- per-w runs -------------------------------------------------------------

  const rows = [];

  for (const w of W_GRID) {
    const jsonOut = outPath(w);
    let ok;

    if (IS_LME) {
      // LME: harness writes hypotheses JSONL; scorer converts to scores JSON.
      const hypothesesFile = path.join(RESULTS_DIR, `35-sweep-lme-hypotheses-w${wLabel(w)}.jsonl`);
      ok = runLmeHarness(w, hypothesesFile);
      if (ok) {
        ok = runLmeScorer(hypothesesFile, jsonOut);
      }
    } else {
      ok = runKuHarness(w, jsonOut);
    }

    const result   = ok ? readResult(jsonOut) : null;
    const headline = extractHeadline(result, IS_LME);
    const kuSub    = extractKuSub(result, IS_LME);

    rows.push({ w, ok, result, headline, kuSub, outFile: jsonOut });

    if (!ok) {
      console.error(`  [w=${w}] FAILED — see errors above. Continuing sweep.\n`);
    } else {
      const headlineStr = headline !== null ? (headline * 100).toFixed(1) + '%' : 'n/a';
      const kuSubStr    = IS_LME && kuSub !== null ? ` (ku-sub: ${(kuSub * 100).toFixed(1)}%)` : '';
      console.log(`  [w=${w}] done → ${headlineStr}${kuSubStr}  (${path.basename(jsonOut)})\n`);
    }
  }

  // ---- comparison table -------------------------------------------------------

  const metricLabel = IS_LME ? 'LME headline' : 'KU score';
  const colW   = 8;
  const colM   = 14;
  const colF   = 10;
  const colSub = IS_LME ? 16 : 0;

  console.log('\n=== Phase 35 Strength-Weight Sweep Results ===\n');
  if (IS_LME) {
    console.log('  ' + 'w'.padEnd(colW) + metricLabel.padEnd(colM) + 'ku-sub-score'.padEnd(colSub) + 'file');
    console.log('  ' + '-'.repeat(colW) + '-'.repeat(colM) + '-'.repeat(colSub) + '-'.repeat(colF + 20));
  } else {
    console.log('  ' + 'w'.padEnd(colW) + metricLabel.padEnd(colM) + 'file');
    console.log('  ' + '-'.repeat(colW) + '-'.repeat(colM) + '-'.repeat(colF + 20));
  }

  for (const row of rows) {
    const wStr  = String(row.w).padEnd(colW);
    const mStr  = (row.headline !== null ? (row.headline * 100).toFixed(1) + '%' : (row.ok ? 'n/a' : 'ERR')).padEnd(colM);
    const sStr  = IS_LME ? (row.kuSub !== null ? (row.kuSub * 100).toFixed(1) + '%' : 'n/a').padEnd(colSub) : '';
    const fStr  = path.basename(row.outFile);
    console.log('  ' + wStr + mStr + sStr + fStr);
  }

  // ---- Pitfall-3 sanity check -------------------------------------------------

  const scored = rows.filter(r => r.headline !== null);
  const allSame = scored.length > 1 && scored.every(r => r.headline === scored[0].headline);

  if (allSame && !IS_DRY_RUN) {
    console.error('\nWARNING (Pitfall 3): all w values produced the same score (' + (scored[0].headline * 100).toFixed(1) + '%).');
    console.error('This indicates the queryText fix is NOT in effect — the pure-cosine topk branch');
    console.error('is being taken regardless of --strength-weight. Stop and debug before trusting results.');
  }

  // ---- argmax (winning w) -----------------------------------------------------

  let winnerId = -1;
  let winScore = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].headline !== null && rows[i].headline > winScore) {
      winScore  = rows[i].headline;
      winnerId  = i;
    }
  }

  console.log('');
  if (winnerId === -1) {
    console.log('Winning w: n/a (no successful runs)');
  } else {
    const winner  = rows[winnerId];
    const baseRow = rows.find(r => r.w === 0);
    const base    = baseRow?.headline ?? null;

    console.log(`Winning w: ${winner.w}  (${metricLabel}: ${(winner.headline * 100).toFixed(1)}%)`);
    if (base !== null && winner.w !== 0) {
      const delta = ((winner.headline - base) * 100).toFixed(1);
      const sign  = winner.headline >= base ? '+' : '';
      console.log(`Delta vs w=0 baseline: ${sign}${delta}pp`);
      const noisy = Math.abs(winner.headline - base) * 100 < 2.0;
      if (noisy) {
        console.log('NOTE: delta is within the ~1–2pt judge-noise band (D-07). No decisive win detected.');
        console.log('      Verdict: no win — all within noise (per D-07).');
      } else {
        console.log('Verdict: delta clears the D-07 noise band.');
      }
    } else if (winner.w === 0) {
      console.log('Winning w is 0 (baseline). No improvement from strength fusion detected.');
    }
  }

  console.log('\nResult files:');
  for (const row of rows) {
    if (row.ok) console.log(`  ${row.outFile}`);
  }
  console.log('');

  // Exit non-zero if any runs failed.
  const failed = rows.filter(r => !r.ok).length;
  if (failed > 0) {
    console.error(`${failed} of ${rows.length} sweep arm(s) failed. Check errors above.`);
    process.exit(1);
  }
})();
