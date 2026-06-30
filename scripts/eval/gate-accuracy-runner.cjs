/**
 * gate-accuracy-runner.cjs — Opt-in paid accuracy-tier gate (GATE-02 accuracy + belief-correction axes).
 *
 * This is the DELIBERATE, PAID tier gate. It wraps the LLM-routed axes:
 *   - EVAL-02 belief-correction  (correctness-harness.cjs — Haiku extract + Sonnet judge)
 *   - LoCoMo-J headline          (locomo-harness.cjs --run + locomo-scorer.cjs — Haiku + gpt-4o-mini)
 *   - KU finish-78               (replay-ku-harness.cjs — Haiku extract + Sonnet judge)
 *
 * THIS IS NOT WHAT `npm run gate` RUNS. The cheap gate (gate-runner.cjs) is LLM-free.
 * Real token spend only happens here, on explicit `--run`, with valid API keys.
 *
 * Run:
 *   # Cost probe — prints estimated token/cost envelope, exits 0 without running the full suite
 *   node scripts/eval/gate-accuracy-runner.cjs --probe
 *
 *   # Full paid run — real token spend (subscription-billed via claude -p)
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npm run build && node scripts/eval/gate-accuracy-runner.cjs --run
 *
 * CLAUDE.md note: subscription marginal cost ≈ $0, but tokens are real and count against limits.
 *
 * Key invariants:
 *   - No mode flag → usage + exit 1 (mode-guard, T-50-03)
 *   - --run without ANTHROPIC_API_KEY or OPENAI_API_KEY → clear error + exit 1 (fail-closed, T-50-04)
 *   - Missing baseline floor for an axis → SKIP notice (not a pass, never fail-open)
 *   - Floor breach → GATE FAIL per axis, exit 1 after all axes are checked
 *   - This file never spawns or requires gate-runner.cjs (D-03 separation)
 */
'use strict';

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync, spawnSync } = require('child_process');

// ---- arg parser (mirrors judge-eval-runner.cjs convention) -------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const IS_PROBE = process.argv.includes('--probe');
const IS_RUN   = process.argv.includes('--run');

// ---- mode-guard (T-50-03) ----------------------------------------------------
// Refuse to run without an explicit mode flag — prevents accidental invocation.
if (!IS_PROBE && !IS_RUN) {
  console.error('Usage: gate-accuracy-runner.cjs [--probe | --run] [options]');
  console.error('');
  console.error('  --probe     Print estimated token/cost envelope for the full suite; exit 0.');
  console.error('              Does NOT run the paid harnesses — safe for cost review.');
  console.error('  --run       Full paid run of all accuracy axes. Requires:');
  console.error('                ANTHROPIC_API_KEY  — Haiku (extract) + Sonnet (judge) via claude -p');
  console.error('                OPENAI_API_KEY     — gpt-4o-mini (LoCoMo-J scorer) + embeddings (KU)');
  console.error('');
  console.error('  IMPORTANT: This is the DELIBERATE paid tier — NOT what `npm run gate` runs.');
  console.error('  Run `npm run gate` for the cheap LLM-free reproducibility gate.');
  console.error('  Run `node scripts/eval/gate-accuracy-runner.cjs --probe` for a cost estimate first.');
  process.exit(1);
}

const BASELINE_PATH = arg('--baseline', 'scripts/eval/results/gate-baseline.json');
const OUT_DIR       = path.join(os.tmpdir(), `gate-accuracy-${process.pid}`);

// ---- helper: commit hash -----------------------------------------------------
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

// ---- helper: read baseline (thresholds only) ----------------------------------
function readBaseline() {
  // WR-01: the paid tier must never run unguarded. A wholly missing/unparseable baseline → all
  // axes would SKIP and the run would report GATE PASS having enforced nothing (fail-open). Fail
  // closed, matching gate-runner.cjs. Per-axis SKIP is reserved for an individual floor that is
  // intentionally absent while the baseline itself is present and valid.
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`GATE FAIL: baseline not found at ${BASELINE_PATH} — cannot enforce accuracy floors`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    console.error(`GATE FAIL: could not parse baseline at ${BASELINE_PATH}: ${e.message} — cannot enforce accuracy floors`);
    process.exit(1);
  }
}

// ---- helper: spawn a sub-harness synchronously --------------------------------
function runHarness(label, args, opts) {
  console.log(`\n[gate:accuracy] Running ${label}...`);
  const result = spawnSync('node', args, {
    stdio: 'inherit',
    env: { ...process.env },
    ...opts,
  });
  if (result.error) {
    throw new Error(`Failed to spawn ${label}: ${result.error.message}`);
  }
  return result.status;
}

// ---- probe mode --------------------------------------------------------------
if (IS_PROBE) {
  // Static cost estimate based on observed per-run token spend.
  // These are honest estimates derived from locomo-harness.cjs probe output
  // and EVAL-02/KU observed Haiku/Sonnet costs on the founder's subscription.
  //
  // IMPORTANT: subscription marginal cost ≈ $0, but tokens count against limits.
  console.log('');
  console.log('=== gate:accuracy — Cost Probe (PAID TIER, estimated) ===');
  console.log('');
  console.log('This gate wraps three LLM-routed accuracy axes:');
  console.log('');
  console.log('Axis 1: EVAL-02 Belief-Correction (correctness-harness.cjs)');
  console.log('  Cases: ~12 contradiction + control cases');
  console.log('  LLM: Haiku 4.5 (extract) + Sonnet 4.6 (judge) via claude -p subscription transport');
  console.log('  Estimated tokens: ~50k–100k per full run (Haiku extract dominant)');
  console.log('  Subscription marginal cost: ≈ $0 but tokens count against your usage cap');
  console.log('');
  console.log('Axis 2: LoCoMo-J Headline (locomo-harness.cjs --run + locomo-scorer.cjs)');
  console.log('  Cases: 10 conversations (~500 QA pairs, category-5 excluded)');
  console.log('  LLM: Haiku 4.5 (answer-gen, subscription) + gpt-4o-mini (LoCoMo-J scoring, billed)');
  console.log('  Estimated tokens: ~200k–500k Haiku (subscription) + ~100k gpt-4o-mini (~$0.01)');
  console.log('  Note: locomo10.json dataset required (not committed, CC BY-NC 4.0)');
  console.log('  Run `node scripts/eval/locomo-harness.cjs --probe` for a per-conversation estimate.');
  console.log('');
  console.log('Axis 3: KU finish-78 (replay-ku-harness.cjs)');
  console.log('  Cases: 18 KU cases from ~/.recense-eval-cache/eval01-n20-2026-06-16/');
  console.log('  LLM: Haiku 4.5 (extract replay skipped — uses cached claims) + Sonnet (judge)');
  console.log('  Estimated tokens: ~150k–300k per full run');
  console.log('  Subscription marginal cost: ≈ $0 but tokens count against your usage cap');
  console.log('');
  console.log('--- Summary ---');
  console.log('Total estimated tokens: ~400k–900k (subscription-billed Haiku/Sonnet) + ~$0.01 OpenAI');
  console.log('Subscription marginal cost: ≈ $0 (claude -p on your Max subscription)');
  console.log('Real paid cost: ~$0.01–0.05 (OpenAI gpt-4o-mini for LoCoMo-J scoring only)');
  console.log('');
  console.log('To start the full run:');
  console.log('  ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npm run build && node scripts/eval/gate-accuracy-runner.cjs --run');
  process.exit(0);
}

// ---- run mode: key-guard (fail-closed, T-50-04) ------------------------------
// ALWAYS required for --run — there is no dry-run that skips the LLM here.
{
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    console.error('');
    console.error(`ERROR: missing API keys for a paid accuracy run: ${missing.join(', ')}`);
    console.error('Both ANTHROPIC_API_KEY and OPENAI_API_KEY are required — fail-closed (T-50-04).');
    console.error('  ANTHROPIC_API_KEY  — Haiku extract + Sonnet judge via claude -p subscription transport');
    console.error('  OPENAI_API_KEY     — gpt-4o-mini for LoCoMo-J scoring + embeddings for KU');
    console.error('');
    console.error('Run `node scripts/eval/gate-accuracy-runner.cjs --probe` for a cost estimate first.');
    process.exit(1);
  }
}

// ---- run mode: paid orchestration --------------------------------------------

console.log('');
console.log('=================================================================');
console.log('  gate:accuracy — DELIBERATE PAID TIER (GATE-02 accuracy axes)');
console.log('  THIS IS NOT WHAT `npm run gate` RUNS (D-03 separation).');
console.log('  Subscription marginal cost ≈ $0; tokens count against usage cap.');
console.log('=================================================================');
console.log(`  commit: ${commit}`);
console.log(`  date:   ${new Date().toISOString()}`);
console.log('');

const baseline = readBaseline();
const thresholds = baseline.thresholds || {};

// Ensure temp output directory exists
fs.mkdirSync(OUT_DIR, { recursive: true });

const failures = [];
const results  = {};

// ---- Axis 1: EVAL-02 Belief-Correction ----------------------------------------
const eval02Out = path.join(OUT_DIR, 'eval02.json');
console.log('\n--- Axis 1: EVAL-02 Belief-Correction (correctness-harness.cjs) ---');
const eval02Status = runHarness(
  'correctness-harness.cjs',
  ['scripts/eval/correctness-harness.cjs', '--out', eval02Out]
);
if (eval02Status !== 0) {
  console.error('ERROR: correctness-harness.cjs exited non-zero — EVAL-02 axis failed');
  failures.push('eval02 (harness error)');
} else {
  try {
    const eval02Result = JSON.parse(fs.readFileSync(eval02Out, 'utf8'));
    const bcr = eval02Result.scores && eval02Result.scores.brain_memory
      ? eval02Result.scores.brain_memory.belief_correction_rate
      : null;
    results.eval02_belief_correction_rate = bcr;
    console.log(`\n  EVAL-02 belief_correction_rate: ${bcr !== null && bcr !== undefined ? (bcr * 100).toFixed(1) + '%' : 'n/a'}`);
    if (!('eval02_floor' in thresholds)) {
      console.log('  SKIP: eval02 (no baseline floor in gate-baseline.json — informational only)');
    } else if (bcr === null || bcr === undefined) {
      console.error(`  GATE FAIL: eval02 belief_correction_rate is null (no scored cases)`);
      failures.push('eval02 (null score)');
    } else if (bcr < thresholds.eval02_floor) {
      console.error(`  GATE FAIL: eval02 belief_correction_rate ${(bcr * 100).toFixed(1)}% < floor ${(thresholds.eval02_floor * 100).toFixed(1)}%`);
      failures.push(`eval02 (${(bcr * 100).toFixed(1)}% < ${(thresholds.eval02_floor * 100).toFixed(1)}%)`);
    } else {
      console.log(`  PASS: eval02 ${(bcr * 100).toFixed(1)}% >= floor ${(thresholds.eval02_floor * 100).toFixed(1)}%`);
    }
  } catch (e) {
    console.error(`  ERROR: could not read eval02 output: ${e.message}`);
    failures.push('eval02 (output parse error)');
  }
}

// ---- Axis 2: LoCoMo-J Headline -----------------------------------------------
const locomoHypOut = path.join(OUT_DIR, 'locomo-hyp.jsonl');
const locomoOut    = path.join(OUT_DIR, 'locomo.json');
console.log('\n--- Axis 2: LoCoMo-J Headline (locomo-harness.cjs --run + locomo-scorer.cjs) ---');
const locomoStatus = runHarness(
  'locomo-harness.cjs --run',
  ['scripts/eval/locomo-harness.cjs', '--run', '--out', locomoHypOut]
);
if (locomoStatus !== 0) {
  console.error('ERROR: locomo-harness.cjs exited non-zero — LoCoMo-J axis failed');
  failures.push('locomo_j (harness error)');
} else {
  const scorerStatus = runHarness(
    'locomo-scorer.cjs',
    ['scripts/eval/locomo-scorer.cjs', '--in', locomoHypOut, '--out', locomoOut]
  );
  if (scorerStatus !== 0) {
    console.error('ERROR: locomo-scorer.cjs exited non-zero — LoCoMo-J scoring failed');
    failures.push('locomo_j (scorer error)');
  } else {
    try {
      const locomoResult = JSON.parse(fs.readFileSync(locomoOut, 'utf8'));
      const headline = locomoResult.scores && locomoResult.scores.headline != null
        ? locomoResult.scores.headline
        : null;
      results.locomo_j_headline = headline;
      console.log(`\n  LoCoMo-J headline: ${headline !== null ? (headline * 100).toFixed(2) + '%' : 'n/a'}`);
      if (!('locomo_j_floor' in thresholds)) {
        console.log('  SKIP: locomo_j (no baseline floor in gate-baseline.json — informational only)');
      } else if (headline === null || headline === undefined) {
        console.error('  GATE FAIL: locomo_j headline is null (no scored QA pairs)');
        failures.push('locomo_j (null score)');
      } else if (headline < thresholds.locomo_j_floor) {
        console.error(`  GATE FAIL: locomo_j headline ${(headline * 100).toFixed(2)}% < floor ${(thresholds.locomo_j_floor * 100).toFixed(2)}%`);
        failures.push(`locomo_j (${(headline * 100).toFixed(2)}% < ${(thresholds.locomo_j_floor * 100).toFixed(2)}%)`);
      } else {
        console.log(`  PASS: locomo_j ${(headline * 100).toFixed(2)}% >= floor ${(thresholds.locomo_j_floor * 100).toFixed(2)}%`);
      }
    } catch (e) {
      console.error(`  ERROR: could not read locomo scorer output: ${e.message}`);
      failures.push('locomo_j (output parse error)');
    }
  }
}

// ---- Axis 3: KU (replay-ku-harness.cjs) ---------------------------------------
const kuOut = path.join(OUT_DIR, 'ku.json');
console.log('\n--- Axis 3: KU finish-78 (replay-ku-harness.cjs) ---');
const kuStatus = runHarness(
  'replay-ku-harness.cjs',
  ['scripts/eval/replay-ku-harness.cjs', '--out', kuOut]
);
if (kuStatus !== 0) {
  console.error('ERROR: replay-ku-harness.cjs exited non-zero — KU axis failed');
  failures.push('ku (harness error)');
} else {
  try {
    const kuResult = JSON.parse(fs.readFileSync(kuOut, 'utf8'));
    const kuScore = kuResult.scores && kuResult.scores.ku_score != null
      ? kuResult.scores.ku_score
      : null;
    results.ku_score = kuScore;
    console.log(`\n  KU score: ${kuScore !== null ? (kuScore * 100).toFixed(1) + '%' : 'n/a'}`);
    if (!('ku_floor' in thresholds)) {
      console.log('  SKIP: ku (no baseline floor in gate-baseline.json — informational only)');
    } else if (kuScore === null || kuScore === undefined) {
      console.error('  GATE FAIL: ku_score is null (no scored cases)');
      failures.push('ku (null score)');
    } else if (kuScore < thresholds.ku_floor) {
      console.error(`  GATE FAIL: ku_score ${(kuScore * 100).toFixed(1)}% < floor ${(thresholds.ku_floor * 100).toFixed(1)}%`);
      failures.push(`ku (${(kuScore * 100).toFixed(1)}% < ${(thresholds.ku_floor * 100).toFixed(1)}%)`);
    } else {
      console.log(`  PASS: ku ${(kuScore * 100).toFixed(1)}% >= floor ${(thresholds.ku_floor * 100).toFixed(1)}%`);
    }
  } catch (e) {
    console.error(`  ERROR: could not read ku output: ${e.message}`);
    failures.push('ku (output parse error)');
  }
}

// ---- Cleanup temp dir --------------------------------------------------------
try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch {}

// ---- Final verdict -----------------------------------------------------------
console.log('');
console.log('=================================================================');
if (failures.length > 0) {
  console.error('GATE FAIL (accuracy tier):');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  console.log('=================================================================');
  process.exit(1);
} else {
  // WR-04: a flat "GATE PASS" reads identically whether all three axes were enforced or all three
  // were SKIPPED (no floor). Surface any unenforced axis so a disarmed gate never looks fully green.
  const skipped = ['eval02_floor', 'locomo_j_floor', 'ku_floor'].filter(k => !(k in thresholds));
  if (skipped.length > 0) {
    console.warn(`GATE PASS (accuracy tier) — WARNING: ${skipped.length} axis/axes NOT enforced (no baseline floor): ${skipped.join(', ')}`);
  } else {
    console.log('GATE PASS (accuracy tier) — all 3 axes enforced');
  }
  console.log('=================================================================');
  process.exit(0);
}
