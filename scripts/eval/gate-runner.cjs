/**
 * Phase 50 Regression Gate — cheap, deterministic, LLM-free.
 *
 * On-demand guard over deterministic axes: LoCoMo R@5/R@10, latency p50/p95,
 * token-structural (injected_tokens), and the binary judge-fire contradiction
 * assertion (total_contradicts > 0 from frozen JSON).
 *
 * Run:
 *   npm run gate                          # full fresh-run mode
 *   npm run gate:baseline                 # re-record and rewrite committed baseline
 *   node scripts/eval/gate-runner.cjs --run --locomo <path> --latency <path> ...
 *
 * Key requirements:
 *   - Mode-guard: refuses to run without --run or --update-baseline (T-40-03 pattern).
 *   - Fail-closed: missing baseline OR any required result JSON / missing key → GATE FAIL + exit 1.
 *   - Never exit 0 on absent/corrupt inputs.
 *   - --update-baseline writes only measured values; any axis without output is a hard error.
 *   - No new runtime dependencies: only fs, path, child_process (all built-in).
 *   - D-01 on-demand-not-CI: no .github/workflows/ enforcement; Phase 51 consumer only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---- arg parser (mirrors correctness-harness.cjs convention) -----------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const IS_RUN             = process.argv.includes('--run');
const IS_UPDATE_BASELINE = process.argv.includes('--update-baseline');

// ---- mode guard (mirrors locomo-harness.cjs lines 84-98) ---------------------
if (!IS_RUN && !IS_UPDATE_BASELINE) {
  console.error('Usage: gate-runner.cjs [--run | --update-baseline] [options]');
  console.error('');
  console.error('  --run               Run deterministic cheap axes and compare vs baseline (GATE-01).');
  console.error('  --update-baseline   Run cheap axes and rewrite the committed baseline JSON (GATE-03).');
  console.error('');
  console.error('Options:');
  console.error('  --baseline <path>     Committed baseline JSON (default: scripts/eval/results/gate-baseline.json)');
  console.error('  --locomo <path>       Read LoCoMo R@K from this scored JSON instead of running harness');
  console.error('  --latency <path>      Read latency from this result JSON instead of running harness');
  console.error('  --injection <path>    Read injected_tokens from this result JSON instead of running harness');
  console.error('  --contradicts <path>  Frozen judge-fire counter JSON (default: scripts/eval/results/46-recon03-ku-bm25on.json)');
  console.error('');
  console.error('Note: --locomo/--latency/--injection override flags skip harness execution and read');
  console.error('      from provided result JSONs directly. Used to test the comparator in isolation.');
  process.exit(1);
}

// ---- config ------------------------------------------------------------------
const BASELINE_PATH      = arg('--baseline',    'scripts/eval/results/gate-baseline.json');
const LOCOMO_OVERRIDE    = arg('--locomo',      null);
const LATENCY_OVERRIDE   = arg('--latency',     null);
const INJECTION_OVERRIDE = arg('--injection',   null);
const CONTRADICTS_PATH   = arg('--contradicts', 'scripts/eval/results/46-recon03-ku-bm25on.json');

// ---- helpers -----------------------------------------------------------------

/** Read and parse a JSON file. Prints GATE FAIL and exits 1 on any error (fail-closed). */
function readJsonSafe(filepath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filepath, 'utf8');
  } catch (e) {
    console.error(`GATE FAIL: cannot read ${label} (${filepath}): ${e.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`GATE FAIL: cannot parse ${label} (${filepath}): ${e.message}`);
    process.exit(1);
  }
}

/**
 * Drill into a nested key path like 'scores.rAtK.r5'. Prints GATE FAIL and exits 1 if
 * any key is absent or null — ensures fail-closed behavior on missing expected keys.
 */
function requireKey(obj, keyPath, label, filepath) {
  const keys = keyPath.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object' || !(k in cur)) {
      console.error(`GATE FAIL: missing key '${keyPath}' in ${label} (${filepath})`);
      process.exit(1);
    }
    cur = cur[k];
  }
  if (cur == null) {
    console.error(`GATE FAIL: null value at '${keyPath}' in ${label} (${filepath})`);
    process.exit(1);
  }
  // WR-03: every axis read via requireKey is a numeric score; a present-but-non-numeric
  // value (e.g. "n/a") would evade the NaN-comparing comparator and fail open. Fail closed.
  if (typeof cur !== 'number' || Number.isNaN(cur)) {
    console.error(`GATE FAIL: non-numeric value at '${keyPath}' in ${label} (${filepath})`);
    process.exit(1);
  }
  return cur;
}

/** Resolve current git short commit for baseline metadata. */
function getCommit() {
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  return commit;
}

/** Read engine version from package.json. */
function getEngineVersion() {
  try { return JSON.parse(fs.readFileSync('package.json', 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

// ---- axis collectors ---------------------------------------------------------

/**
 * LoCoMo R@5 / R@10 axis.
 * If --locomo override is given, reads directly from that path.
 * Otherwise spawns locomo-harness.cjs --run --retrieval-only then locomo-scorer.cjs.
 */
function runLocomoAxis() {
  if (LOCOMO_OVERRIDE) {
    const d   = readJsonSafe(LOCOMO_OVERRIDE, 'locomo override');
    const r5  = requireKey(d, 'scores.rAtK.r5',  'locomo override', LOCOMO_OVERRIDE);
    const r10 = requireKey(d, 'scores.rAtK.r10', 'locomo override', LOCOMO_OVERRIDE);
    return { r5, r10, source: LOCOMO_OVERRIDE };
  }
  const hypPath    = 'scripts/eval/results/gate-locomo-hyp.jsonl';
  const scoredPath = 'scripts/eval/results/gate-locomo-scored.json';
  console.log('Running LoCoMo retrieval harness (--retrieval-only)...');
  try {
    execSync(`node scripts/eval/locomo-harness.cjs --run --retrieval-only --out ${hypPath}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`GATE FAIL: locomo harness exited non-zero: ${e.message}`);
    process.exit(1);
  }
  console.log('Running LoCoMo scorer...');
  try {
    execSync(`node scripts/eval/locomo-scorer.cjs --in ${hypPath} --out ${scoredPath}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`GATE FAIL: locomo scorer exited non-zero: ${e.message}`);
    process.exit(1);
  }
  const d   = readJsonSafe(scoredPath, 'locomo scored result');
  const r5  = requireKey(d, 'scores.rAtK.r5',  'locomo scored', scoredPath);
  const r10 = requireKey(d, 'scores.rAtK.r10', 'locomo scored', scoredPath);
  return { r5, r10, source: scoredPath };
}

/**
 * Latency p50/p95 axis.
 * If --latency override is given, reads directly from that path.
 * Otherwise spawns 41-latency-after.cjs.
 */
function runLatencyAxis() {
  if (LATENCY_OVERRIDE) {
    const d   = readJsonSafe(LATENCY_OVERRIDE, 'latency override');
    const p50 = requireKey(d, 'warm.indexed.p50_ms', 'latency override', LATENCY_OVERRIDE);
    const p95 = requireKey(d, 'warm.indexed.p95_ms', 'latency override', LATENCY_OVERRIDE);
    return { p50_ms: p50, p95_ms: p95, source: LATENCY_OVERRIDE };
  }
  const outPath = 'scripts/eval/results/gate-latency-run.json';
  console.log('Running latency harness...');
  try {
    execSync(`node scripts/eval/41-latency-after.cjs --out ${outPath}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`GATE FAIL: latency harness exited non-zero: ${e.message}`);
    process.exit(1);
  }
  const d   = readJsonSafe(outPath, 'latency result');
  const p50 = requireKey(d, 'warm.indexed.p50_ms', 'latency', outPath);
  const p95 = requireKey(d, 'warm.indexed.p95_ms', 'latency', outPath);
  return { p50_ms: p50, p95_ms: p95, source: outPath };
}

/**
 * Token-structural axis (injected_tokens proxy, char/4, LLM-free).
 * If --injection override is given, reads directly from that path.
 * Otherwise spawns injection-efficiency-harness.cjs.
 */
function runInjectionAxis() {
  if (INJECTION_OVERRIDE) {
    const d      = readJsonSafe(INJECTION_OVERRIDE, 'injection override');
    const tokens = requireKey(d, 'point_estimate.injected_tokens', 'injection override', INJECTION_OVERRIDE);
    return { injected_tokens: tokens, source: INJECTION_OVERRIDE };
  }
  const outPath = 'scripts/eval/results/gate-injection-run.json';
  console.log('Running injection-efficiency harness...');
  try {
    execSync(`node scripts/eval/injection-efficiency-harness.cjs --out ${outPath}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`GATE FAIL: injection harness exited non-zero: ${e.message}`);
    process.exit(1);
  }
  const d      = readJsonSafe(outPath, 'injection result');
  const tokens = requireKey(d, 'point_estimate.injected_tokens', 'injection', outPath);
  return { injected_tokens: tokens, source: outPath };
}

/**
 * Judge-fire contradiction counter (binary > 0 assertion, D-06).
 * Always reads from the FROZEN --contradicts JSON — no fresh consolidation, no LLM.
 * This axis is never run from scratch in the cheap gate (see 50-PATTERNS.md §Judge-Fire Counter).
 */
function readContradictsAxis() {
  const d     = readJsonSafe(CONTRADICTS_PATH, 'contradicts (frozen judge-fire counter)');
  const total = requireKey(d, 'scores.total_contradicts', 'contradicts', CONTRADICTS_PATH);
  return { total_contradicts: total, source: CONTRADICTS_PATH };
}

// ---- --update-baseline flow --------------------------------------------------

if (IS_UPDATE_BASELINE) {
  console.log('Gate: --update-baseline — collecting cheap axis values...');

  const locomo      = runLocomoAxis();
  const latency     = runLatencyAxis();
  const injection   = runInjectionAxis();
  const contradicts = readContradictsAxis();
  const commit        = getCommit();
  const engineVersion = getEngineVersion();

  // CR-01: --update-baseline only re-records the CHEAP axes. Merge onto the prior baseline so
  // the accuracy-tier floors (eval02_floor/locomo_j_floor/ku_floor) and accuracy_floor_provenance
  // — armed separately by Plan 50-03 — survive a re-baseline instead of being silently wiped
  // (which would revert gate:accuracy to all-SKIP/PASS and disarm the belief-correction gate).
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch { /* first-ever baseline */ }

  // Compute cheap-axis thresholds: floors = baseline - epsilon (~0.02); ceilings = baseline * headroom.
  const newBaseline = {
    meta: {
      ...(prior.meta || {}),            // preserve accuracy_floor_provenance + any prior meta keys
      eval:           'gate-baseline',
      version:        'v9.0-final',
      date:           new Date().toISOString(),
      commit,
      engine_version: engineVersion,
      recorded_from: {
        ...((prior.meta && prior.meta.recorded_from) || {}),
        locomo_rAtK: locomo.source,
        latency:     latency.source,
        injection:   injection.source,
        contradicts: contradicts.source,
      },
    },
    scores: {
      ...(prior.scores || {}),          // preserve any accuracy-tier recorded scores
      locomo_r5:         locomo.r5,
      locomo_r10:        locomo.r10,
      lat_p50_ms:        latency.p50_ms,
      lat_p95_ms:        latency.p95_ms,
      injected_tokens:   injection.injected_tokens,
      total_contradicts: contradicts.total_contradicts,
    },
    thresholds: {
      ...(prior.thresholds || {}),      // preserve eval02_floor / locomo_j_floor / ku_floor
      locomo_r5_floor:          Math.max(0, +parseFloat((locomo.r5  - 0.02).toFixed(4))),
      locomo_r10_floor:         Math.max(0, +parseFloat((locomo.r10 - 0.02).toFixed(4))),
      lat_p95_ceiling_ms:       Math.ceil(latency.p95_ms * 1.15),
      injected_tokens_ceiling:  Math.ceil(injection.injected_tokens * 1.10),
      contradicts_floor:        1,
    },
  };

  const outDir = path.dirname(path.resolve(BASELINE_PATH));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2));
  console.log(`Baseline updated -> ${BASELINE_PATH}`);
  process.exit(0);
}

// ---- --run flow --------------------------------------------------------------

// 1. Load and validate baseline first (fail-closed — checked before any harness execution).
const baseline = readJsonSafe(BASELINE_PATH, 'baseline');
if (!baseline.thresholds || typeof baseline.thresholds !== 'object') {
  console.error(`GATE FAIL: baseline missing 'thresholds' block (${BASELINE_PATH})`);
  process.exit(1);
}
// WR-02: a missing individual cheap-axis floor would silently disable that axis (the comparator
// is guarded by `!= null`) and still GATE PASS — an invisible regression hole. Require all
// cheap-axis floors up front and fail closed if any is absent. (contradicts_floor defaults to 1.)
for (const k of ['locomo_r5_floor', 'locomo_r10_floor', 'lat_p95_ceiling_ms', 'injected_tokens_ceiling']) {
  if (baseline.thresholds[k] == null) {
    console.error(`GATE FAIL: baseline missing required threshold '${k}' (${BASELINE_PATH})`);
    process.exit(1);
  }
}

// 2. Collect axis values (run harnesses or read from override paths).
const locomo      = runLocomoAxis();
const latency     = runLatencyAxis();
const injection   = runInjectionAxis();
const contradicts = readContradictsAxis();

// 3. Floor/ceiling comparator (D-04).
const failures = [];
const t = baseline.thresholds;

if (t.locomo_r5_floor != null && locomo.r5 < t.locomo_r5_floor) {
  console.error(`GATE FAIL: locomo_r5 ${locomo.r5} < floor ${t.locomo_r5_floor}`);
  failures.push('locomo_r5');
}
if (t.locomo_r10_floor != null && locomo.r10 < t.locomo_r10_floor) {
  console.error(`GATE FAIL: locomo_r10 ${locomo.r10} < floor ${t.locomo_r10_floor}`);
  failures.push('locomo_r10');
}
if (t.lat_p95_ceiling_ms != null && latency.p95_ms > t.lat_p95_ceiling_ms) {
  console.error(`GATE FAIL: lat_p95_ms ${latency.p95_ms} > ceiling ${t.lat_p95_ceiling_ms}`);
  failures.push('lat_p95_ms');
}
if (t.injected_tokens_ceiling != null && injection.injected_tokens > t.injected_tokens_ceiling) {
  console.error(`GATE FAIL: injected_tokens ${injection.injected_tokens} > ceiling ${t.injected_tokens_ceiling}`);
  failures.push('injected_tokens');
}

// D-06: binary >0 assertion — contradicts_floor defaults to 1 (the binary floor).
const contradicts_floor = (t.contradicts_floor != null) ? t.contradicts_floor : 1;
if (contradicts.total_contradicts < contradicts_floor) {
  console.error(`GATE FAIL: total_contradicts ${contradicts.total_contradicts} < floor ${contradicts_floor}`);
  failures.push('total_contradicts');
}

// 4. Exit based on failures (copy exit shape from correctness-harness.cjs lines 77-86).
if (failures.length > 0) {
  process.exit(1);
}

console.log('GATE PASS');
process.exit(0);
