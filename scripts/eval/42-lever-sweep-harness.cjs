/**
 * Phase 42 Greedy Lever-Sweep Harness (COST-01 / COST-02).
 *
 * Sweeps in-bounds config levers one-at-a-time against the frozen v7.0 baseline,
 * producing per-lever token attribution (skip-split + recall-side, $0 now) and a
 * combined-best candidate config for plan 42-04's deferred KU-accuracy validation.
 *
 * Currency = tokens with a retail-$ translation.
 * Subscription marginal cost ≈ $0; retail-$ figures are "API list price equivalent."
 * No paid or direct-API run is triggered this phase — write-side measurement degrades
 * gracefully to measured:false. This is the build-only constraint per founder 2026-06-24.
 *
 * MEASURED:FALSE GUARANTEE: write_ledger is always { measured: false } when headless
 * providers are not configured — no fabricated token counts ever written.
 *
 * Cost-probe gate reference: Phase 40 D-01 — any heavy run (write-side sleep pass,
 * real KU accuracy run) is gated behind a cost probe scheduled near the weekly reset.
 * This harness handles only the LLM-free ($0) parts now:
 *   - skip-split: LLM-free, $0, runs now
 *   - KU gate: BUILT, exercised in --dry-run only (validates wiring + config_override echo, $0)
 *   - write-side sleep pass: DEFERRED to 42-04 cost-probe-gated reset window (D-06)
 *
 * DB isolation: live db opened READONLY; VACUUM INTO scratch path under os.tmpdir().
 * The live db is NEVER mutated. (T-42-01 mitigated)
 *
 * Security: no ANTHROPIC_API_KEY / OPENAI_API_KEY ever written to results or console. (T-42-02 / T-26-03)
 * Config: overrides are in-memory spread only; src/lib/config.ts is never written. (T-42-03)
 *
 * Run (wiring validation, $0):
 *   npm run build && node scripts/eval/42-lever-sweep-harness.cjs \
 *     --lever consolSkipThreshold --values 0.2,0.35,0.5 \
 *     --dry-run --out scripts/eval/results/42-sweep-PENDING.json
 *
 *   node scripts/eval/42-lever-sweep-harness.cjs \
 *     --lever consolSkipThreshold --values 0.2,0.35 --dry-run --db /tmp/nonexistent-recense.db
 *   # → "no data" message, exit 0 (graceful degrade)
 *
 * Deferred measured run (requires headless providers + 42-04 runbook reset window):
 *   RECENSE_JUDGE_PROVIDER=claude-headless \
 *   RECENSE_EXTRACTOR_PROVIDER=claude-headless \
 *   node scripts/eval/42-lever-sweep-harness.cjs --lever consolSkipThreshold --values 0.2,0.35,0.5
 */
'use strict';

const fs              = require('fs');
const os              = require('os');
const path            = require('path');
const { execSync, spawnSync } = require('child_process');

// ── arg parser (mirrors cost-benefit-harness.cjs convention) ────────────────
const arg  = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const flag = (k)    => process.argv.includes(k);

const DB_PATH   = arg('--db',     process.env['RECENSE_DB'] || path.join(os.homedir(), '.config', 'recense', 'recense.db'));
const OUT       = arg('--out',    'scripts/eval/results/42-sweep-PENDING.json');
const LEVER     = arg('--lever',  null);
const VALUES_ARG = arg('--values', null);
const SAMPLE_N  = parseInt(arg('--sample', '25'), 10);
const DRY_RUN   = flag('--dry-run');

// Derive output directory from --out (single-result convention; per-lever and KU-gate
// auxiliary files are written into the directory derived from path.dirname(--out)).
const OUT_DIR = path.dirname(OUT);

// ── compiled engine modules (require `npm run build` first) ─────────────────
const Database        = require('better-sqlite3');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');

// ── PRICE CONSTANTS (Anthropic list price, 2026-06-19) ───────────────────────
// Source: https://www.anthropic.com/pricing (estimates as of 2026-06-19).
// These are RETAIL LIST prices per million tokens. Subscription marginal cost is $0.
const PRICES = {
  'claude-haiku-4-5': {
    input_per_m:       0.80,
    output_per_m:      4.00,
    cache_write_per_m: 1.00,
    cache_read_per_m:  0.08,
  },
  'claude-sonnet-4-6': {
    input_per_m:       3.00,
    output_per_m:      15.00,
    cache_write_per_m: 3.75,
    cache_read_per_m:  0.30,
  },
};
const PRICES_DATED = '2026-06-19';

// ── in-bounds levers (D-03: confirmed from frozen v7.0 DEFAULT_CONFIG) ───────
// consolSkipThresholdBySource is nested inside config.salience; handled in buildOverrideConfig.
// RECENSE_CORPUS_GEN is an env-var lever (D-02), not a config key.
const IN_BOUNDS_LEVERS = {
  consolSkipThreshold:          { type: 'number', default: DEFAULT_CONFIG.consolSkipThreshold },
  consolSkipThresholdAssistant: { type: 'number', default: DEFAULT_CONFIG.consolSkipThresholdAssistant },
  consolSkipThresholdBySource:  { type: 'object', default: DEFAULT_CONFIG.salience && DEFAULT_CONFIG.salience.consolSkipThresholdBySource },
  injectionTokenBudget:         { type: 'number', default: DEFAULT_CONFIG.injectionTokenBudget },
  recallNeighborhoodBudget:     { type: 'number', default: DEFAULT_CONFIG.recallNeighborhoodBudget },
  candidateK:                   { type: 'number', default: DEFAULT_CONFIG.candidateK },
  recallSidewaysHopBudget:      { type: 'number', default: DEFAULT_CONFIG.recallSidewaysHopBudget },
  RECENSE_CORPUS_GEN:           { type: 'env',    default: process.env['RECENSE_CORPUS_GEN'] || '(unset)' },
};

// ── helpers ──────────────────────────────────────────────────────────────────

function header(title) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + title);
  console.log('─'.repeat(60));
}

/** Compute retail-$ for a usage record. Returns 0 if model is not in PRICES. */
function retailUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const inp    = (usage.input_tokens                 || 0) / 1e6 * p.input_per_m;
  const out    = (usage.output_tokens                || 0) / 1e6 * p.output_per_m;
  const cwrite = (usage.cache_creation_input_tokens  || 0) / 1e6 * p.cache_write_per_m;
  const cread  = (usage.cache_read_input_tokens      || 0) / 1e6 * p.cache_read_per_m;
  return inp + out + cwrite + cread;
}

/** Sum an array of numbers (handles empty → 0). */
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

/**
 * Apply the consolidator skip-threshold gate to a sampled episode row.
 * Mirrors consolidator.ts gate + cost-benefit-harness.cjs effectiveThreshold (verbatim).
 */
function effectiveThreshold(episode, config) {
  if (episode.hard_keep) return 0; // hard_keep=1 always processed
  const sourceThreshold = config.salience.consolSkipThresholdBySource[episode.source];
  if (sourceThreshold !== undefined) return sourceThreshold;
  if (episode.role === 'assistant') return config.consolSkipThresholdAssistant;
  return config.consolSkipThreshold;
}

/**
 * Build the per-run override config: spread DEFAULT_CONFIG, override exactly one lever.
 * consolSkipThresholdBySource is nested inside config.salience (requires deep merge).
 * RECENSE_CORPUS_GEN is an env-var lever: config unchanged (caller sets process.env).
 * All other levers: simple top-level spread { ...DEFAULT_CONFIG, dbPath, [leverKey]: leverValue }.
 */
function buildOverrideConfig(leverKey, leverValue, dbPath) {
  const base = { ...DEFAULT_CONFIG, dbPath };
  if (leverKey === 'consolSkipThresholdBySource') {
    return { ...base, salience: { ...DEFAULT_CONFIG.salience, consolSkipThresholdBySource: leverValue } };
  }
  if (leverKey === 'RECENSE_CORPUS_GEN') {
    // Env-var lever: config is unchanged; measurement notes the env-var state.
    return base;
  }
  // Standard case: override exactly one key via computed property
  return { ...base, [leverKey]: leverValue };
}

/**
 * Compute the skip-split for sampled episodes under the given lever config.
 * LLM-free gate mirror: no API calls, $0.
 */
function computeSkipSplit(sampledRows, leverConfig) {
  let n_below_threshold = 0;
  let n_extracted       = 0;
  for (const ep of sampledRows) {
    const threshold = effectiveThreshold(ep, leverConfig);
    if (!ep.hard_keep && ep.salience < threshold) {
      n_below_threshold++;
    } else {
      n_extracted++;
    }
  }
  return {
    n_below_threshold,
    n_extracted,
    thresholds: {
      global:     leverConfig.consolSkipThreshold,
      assistant:  leverConfig.consolSkipThresholdAssistant,
      per_source: leverConfig.salience.consolSkipThresholdBySource,
    },
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

(async function main() {
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe','pipe','ignore'] }).toString().trim(); } catch {}
  let engine_version = 'unknown';
  try { engine_version = require('../../package.json').version; } catch {}
  const date = new Date().toISOString();

  console.log('\nPhase 42 Lever-Sweep Harness (COST-01 / COST-02)');
  console.log('Per-lever token attribution (skip-split $0 + KU gate wiring-validated) vs frozen v7.0 baseline.');
  console.log('Write-side sleep pass: DEFERRED to 42-04 cost-probe-gated reset window (D-06).');
  console.log('KU gate: BUILT, exercised in --dry-run only ($0, validates config_override echo).');
  console.log(`DB:      ${DB_PATH}`);
  console.log(`Out:     ${OUT}`);
  console.log(`Lever:   ${LEVER || '(not set — use --lever <key>)'}`);
  console.log(`Values:  ${VALUES_ARG || '(not set — use --values <csv>)'}`);
  console.log(`Sample:  ${SAMPLE_N}`);
  if (DRY_RUN) {
    console.log('Mode:    --dry-run (skip-split runs; KU gate exercised with --dry-run; no API calls)');
  }
  console.log('Subscription marginal cost ≈ $0. Retail-$ = API-list estimate only.');

  // T-42-02 / T-26-03: keys must NEVER appear in result JSON or console output
  // (only check for presence; values are never logged or serialized)

  if (!LEVER) {
    console.log('\nno lever specified. Use --lever <key> --values <csv> to run the sweep.');
    console.log(`In-bounds lever keys: ${Object.keys(IN_BOUNDS_LEVERS).join(', ')}`);
    process.exit(0);
  }

  const candidateValues = VALUES_ARG
    ? VALUES_ARG.split(',').map(s => s.trim()).map(s => {
        const n = Number(s);
        return isNaN(n) ? s : n;
      })
    : [];

  if (candidateValues.length === 0) {
    console.log('\nno values specified. Use --values <csv> e.g. --values 0.2,0.35,0.5');
    process.exit(0);
  }

  // ── (0) Open live DB readonly — graceful degrade if missing/unopenable ───────
  let liveDb;
  try {
    liveDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    console.log(`\nno data: recense.db missing or unopenable at ${DB_PATH} — nothing to measure`);
    process.exit(0);
  }

  let n_episodes;
  try {
    n_episodes = liveDb.prepare('SELECT COUNT(*) AS n FROM episode').get().n;
  } catch {
    liveDb.close();
    console.log(`\nno data: recense.db at ${DB_PATH} has no episode table — run a writer CLI first`);
    process.exit(0);
  }

  if (n_episodes === 0) {
    liveDb.close();
    console.log(`\nno data: recense.db at ${DB_PATH} has 0 episodes — nothing to measure`);
    process.exit(0);
  }

  // ── Build scratch path (NEVER write to live db) — T-42-01 mitigated ─────────
  const scratchPath = path.join(os.tmpdir(), `recense-eval42-scratch-${Date.now()}.db`);

  // VACUUM INTO: WAL-safe clean copy; checkpoints un-written WAL pages.
  try {
    liveDb.prepare('VACUUM INTO ?').run(scratchPath);
  } catch (e) {
    liveDb.close();
    console.log(`\nno data: failed to VACUUM INTO scratch db at ${scratchPath}: ${e.message}`);
    process.exit(0);
  }
  liveDb.close();
  console.log(`Scratch DB: ${scratchPath} (VACUUM INTO from live — WAL-safe, live db read-only)`);

  // ── Open scratch db and sample episodes ──────────────────────────────────────
  const scratchDb = new Database(scratchPath);

  let sampledRows;
  let selectionCriteria;
  let consolidatedFilterUsed;

  const unconsolidatedCount = scratchDb.prepare('SELECT COUNT(*) AS n FROM episode WHERE consolidated=0').get().n;
  if (unconsolidatedCount >= SAMPLE_N) {
    sampledRows = scratchDb.prepare(
      'SELECT id, ts, salience, hard_keep, role, source FROM episode WHERE consolidated=0 ORDER BY ts DESC LIMIT ?'
    ).all(SAMPLE_N);
    consolidatedFilterUsed = true;
    selectionCriteria      = 'unconsolidated (consolidated=0), most-recent N';
  } else {
    sampledRows = scratchDb.prepare(
      'SELECT id, ts, salience, hard_keep, role, source FROM episode ORDER BY ts DESC LIMIT ?'
    ).all(SAMPLE_N);
    consolidatedFilterUsed = false;
    selectionCriteria      = `fallback: all episodes (only ${unconsolidatedCount} unconsolidated, < requested ${SAMPLE_N}), most-recent N`;
  }

  const n_found = sampledRows.length;
  console.log(`\n  Requested sample: ${SAMPLE_N}`);
  console.log(`  Found:            ${n_found} (${selectionCriteria})`);

  if (n_found === 0) {
    scratchDb.close();
    console.log('\nno data: no episodes found in scratch db — nothing to measure');
    process.exit(0);
  }

  // ── Headless active check ─────────────────────────────────────────────────────
  const judgeProvider     = process.env['RECENSE_JUDGE_PROVIDER']     || '';
  const extractorProvider = process.env['RECENSE_EXTRACTOR_PROVIDER'] || '';
  const headlessActive    = judgeProvider === 'claude-headless' && extractorProvider === 'claude-headless';

  if (!headlessActive) {
    console.log('\n  Write ledger: headless providers NOT active.');
    console.log('  Marking write_ledger.measured=false — no fabricated numbers (build-only phase).');
  }

  // ── Baseline skip-split (for delta computation) ───────────────────────────────
  const baselineConfig    = { ...DEFAULT_CONFIG, dbPath: scratchPath };
  const baselineSkipSplit = computeSkipSplit(sampledRows, baselineConfig);
  const baselineSkipRate  = n_found > 0 ? (baselineSkipSplit.n_below_threshold / n_found) : 0;
  const baselineValue     = LEVER === 'consolSkipThresholdBySource'
    ? (DEFAULT_CONFIG.salience && DEFAULT_CONFIG.salience.consolSkipThresholdBySource)
    : (IN_BOUNDS_LEVERS[LEVER] ? IN_BOUNDS_LEVERS[LEVER].default : null);

  header(`Lever Sweep: ${LEVER}  |  candidates: [${candidateValues.join(', ')}]`);
  console.log(`  Baseline value:     ${JSON.stringify(baselineValue)}`);
  console.log(`  Baseline skip rate: ${(baselineSkipRate * 100).toFixed(1)}%  (${baselineSkipSplit.n_below_threshold} / ${n_found})`);

  // ── Per-candidate sweep ───────────────────────────────────────────────────────
  const leverResults = [];

  for (const candidateValue of candidateValues) {
    console.log(`\n  ── Candidate: ${LEVER} = ${JSON.stringify(candidateValue)}`);

    // Build override config for this candidate (T-42-03: in-memory only; config.ts untouched)
    const leverConfig = buildOverrideConfig(LEVER, candidateValue, scratchPath);

    // ── Skip-split (LLM-free, $0) ────────────────────────────────────────────────
    const skipSplit  = computeSkipSplit(sampledRows, leverConfig);
    const skipRate   = n_found > 0 ? (skipSplit.n_below_threshold / n_found) : 0;
    const skipDeltaPp = +(((skipRate - baselineSkipRate) * 100).toFixed(2));

    console.log(`    Skip-split ($0, LLM-free):`);
    console.log(`      n_below_threshold: ${skipSplit.n_below_threshold}  /  n_extracted: ${skipSplit.n_extracted}`);
    console.log(`      skip_rate:         ${(skipRate * 100).toFixed(1)}%  (delta vs baseline: ${skipDeltaPp >= 0 ? '+' : ''}${skipDeltaPp}pp)`);

    // ── Write-ledger (BUILT, RUN DEFERRED per D-06) ───────────────────────────────
    // The write-side instrumentation (setHeadlessUsageSink + runConsolidation) is wired
    // in cost-benefit-harness.cjs (the canonical write-ledger tool). This harness defers
    // the write-side run to 42-04's runbook to avoid subscription spend this phase.
    const writeLedger = {
      measured: false,
      reason: headlessActive
        ? 'Write-side sleep pass deferred to 42-04 cost-probe-gated reset window (D-06 build-now/run-at-reset). Not triggered this phase per founder 2026-06-24 build-only steer.'
        : `Headless providers not configured (RECENSE_JUDGE_PROVIDER="${judgeProvider}", RECENSE_EXTRACTOR_PROVIDER="${extractorProvider}"). Set both to "claude-headless" and re-run in 42-04 reset window.`,
      stack_used:              `judge=${judgeProvider || 'unset'}, extractor=${extractorProvider || 'unset'}`,
      per_model:               null, // populated by deferred run in 42-04
      subscription_marginal_usd: 0,
      prices_dated:            PRICES_DATED,
      prices_source:           'Anthropic public pricing page (estimates only)',
    };

    // ── KU inner-loop gate dispatch — BUILT, --dry-run ONLY this phase (D-04) ───
    // Per the build-only constraint: ALWAYS pass --dry-run to the KU child.
    // This validates: (a) wiring — the child runs and exits 0, and (b) propagation —
    // the lever value lands in the child's meta.config_override, so the gate is NOT
    // a no-op for recall-side levers (candidateK, injectionTokenBudget, etc.).
    const safeValueStr = String(candidateValue).replace(/\./g, '_');
    const kuOutPath = path.join(OUT_DIR, `42-ku-gate-${LEVER}-${safeValueStr}.json`);

    // CRITICAL: --dry-run is ALWAYS passed. Do NOT remove it this phase.
    const kuArgs = [
      path.resolve(__dirname, 'replay-ku-harness.cjs'),
      '--dry-run',
      '--out',                   kuOutPath,
      '--config-override-key',   LEVER,
      '--config-override-value', String(candidateValue),
    ];

    console.log(`    KU gate dispatch (--dry-run, $0):`);
    console.log(`      child: replay-ku-harness.cjs --dry-run --config-override-key ${LEVER} --config-override-value ${candidateValue}`);

    let kuGate = {
      ku_score:                null,     // deferred to 42-04 real run
      ku_scored_cases:         null,     // deferred
      regression:              null,     // deferred
      tolerance_band_pts:      1,        // D-05: ≤1pt noise band
      deferred:                true,
      source:                  kuOutPath,
      config_override_verified: false,
    };

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    const kuResult = spawnSync(process.execPath, kuArgs, {
      stdio:  ['pipe', 'pipe', 'pipe'],
      env:    { ...process.env, RECENSE_MODEL_PROVIDER: 'claude-headless' },
      cwd:    path.resolve(__dirname, '../..'),
    });

    if (kuResult.status === 0) {
      try {
        const kuResultJson = JSON.parse(fs.readFileSync(kuOutPath, 'utf8'));
        const echoedOverride = kuResultJson && kuResultJson.meta && kuResultJson.meta.config_override;
        if (echoedOverride && echoedOverride.key === LEVER) {
          kuGate.config_override_verified = true;
          console.log(`      KU dry-run OK. meta.config_override = { key: "${echoedOverride.key}", value: ${JSON.stringify(echoedOverride.value)} } ✓`);
        } else {
          console.log(`      KU dry-run: config_override not echoed or key mismatch. Got: ${JSON.stringify(echoedOverride)}`);
        }
      } catch (e) {
        console.log(`      KU dry-run: could not read/parse result JSON: ${e.message}`);
      }
    } else {
      const errText = kuResult.stderr ? kuResult.stderr.toString().slice(0, 300) : '(no stderr)';
      console.log(`      KU dry-run: child exited with status ${kuResult.status}. stderr: ${errText}`);
    }

    // ── Per-lever result envelope ─────────────────────────────────────────────────
    const perLeverEnvelope = {
      meta: {
        eval:                    'lever-sweep',
        date,
        commit,
        engine_version,
        db_path:                 DB_PATH,
        scratch_path:            scratchPath,
        lever_under_test:        LEVER,
        lever_value:             candidateValue,
        baseline_value:          baselineValue,
        phase_40_baseline_commit: 'd41d5c8',
      },
      lever: {
        key:                LEVER,
        candidate_value:    candidateValue,
        baseline_value:     baselineValue,
        skip_rate_delta_pp: skipDeltaPp,
        delta_pct:          null,  // write-side token delta deferred to 42-04
      },
      sample: {
        requested:           SAMPLE_N,
        found:               n_found,
        selection_criteria:  selectionCriteria,
        consolidated_filter: consolidatedFilterUsed,
      },
      skip_split:   skipSplit,
      write_ledger: writeLedger,
      ku_gate:      kuGate,
      caveats: [
        'Subscription marginal cost ≈ $0; retail-$ figures are API-list estimates only (not actual charges).',
        'Write-side sleep pass deferred to 42-04 cost-probe-gated reset window (D-06).',
        'KU gate exercised in --dry-run only this phase (validates wiring + config_override echo, $0). Real KU accuracy verdict deferred to 42-04.',
        `Lever acceptance rule (D-05, encoded): a candidate passes only if ku_score stays within ≤${kuGate.tolerance_band_pts}pt noise band of baseline. Verdict deferred to 42-04.`,
      ],
    };

    // Write per-lever file into OUT_DIR (PATTERNS.md naming convention)
    const perLeverFile = path.join(OUT_DIR, `42-sweep-${LEVER}-${safeValueStr}.json`);
    fs.writeFileSync(perLeverFile, JSON.stringify(perLeverEnvelope, null, 2));
    console.log(`    Per-lever result: ${perLeverFile}`);

    leverResults.push({
      candidate_value:          candidateValue,
      skip_rate:                skipRate,
      skip_rate_delta_pp:       skipDeltaPp,
      write_tokens_per_turn:    null,       // deferred to 42-04
      ku_score:                 null,       // deferred to 42-04
      within_band:              'deferred',
      config_override_verified: kuGate.config_override_verified,
      per_lever_file:           perLeverFile,
    });
  }

  // ── Comparison table ──────────────────────────────────────────────────────────
  header('Comparison Table');
  const col1 = 'lever_value';
  const col2 = 'skip_rate';
  const col3 = 'skip_Δ (pp)';
  const col4 = 'write_tok/turn';
  const col5 = 'ku_score';
  const col6 = 'within_band';
  console.log(`  ${col1.padEnd(16)} | ${col2.padEnd(10)} | ${col3.padEnd(11)} | ${col4.padEnd(14)} | ${col5.padEnd(10)} | ${col6}`);
  console.log('  ' + '─'.repeat(82));
  for (const r of leverResults) {
    const lv  = String(JSON.stringify(r.candidate_value)).padEnd(16);
    const sr  = `${(r.skip_rate * 100).toFixed(1)}%`.padEnd(10);
    const sd  = `${r.skip_rate_delta_pp >= 0 ? '+' : ''}${r.skip_rate_delta_pp}`.padEnd(11);
    const wt  = 'deferred'.padEnd(14);
    const ks  = 'deferred'.padEnd(10);
    const wb  = r.within_band;
    console.log(`  ${lv} | ${sr} | ${sd} | ${wt} | ${ks} | ${wb}`);
  }

  // ── Argmax: best candidate per $0 token signal (skip-rate delta as proxy) ────
  // Higher skip-rate increase → more episodes skipped → fewer write tokens in the deferred run.
  // Write-side $ delta will be confirmed/updated in the 42-04 reset-window run.
  header('Argmax: Best Candidate by $0 Token Signal (skip-rate proxy, D-01)');
  const rankedByDelta = [...leverResults].sort((a, b) => b.skip_rate_delta_pp - a.skip_rate_delta_pp);
  const best = rankedByDelta[0];
  console.log(`  Lever:            ${LEVER}`);
  console.log(`  Best candidate:   ${JSON.stringify(best.candidate_value)}`);
  console.log(`  Skip-rate delta:  ${best.skip_rate_delta_pp >= 0 ? '+' : ''}${best.skip_rate_delta_pp}pp vs baseline`);
  console.log('  Note: This is the $0 LLM-free signal only (skip-rate proxy).');
  console.log('  KU no-regression gate (D-05, ≤1pt band) verdict is deferred to 42-04 runbook.');

  const combinedBestConfig = {
    [LEVER]: best.candidate_value,
    _note:                    'Combined-best candidate ranked by $0 skip-rate delta. KU accuracy validation deferred to 42-04.',
    _phase_40_baseline_commit: 'd41d5c8',
  };

  console.log('\n  Combined-best candidate config (hand-off to 42-04 for deferred KU validation):');
  for (const [k, v] of Object.entries(combinedBestConfig)) {
    console.log(`    ${k}: ${JSON.stringify(v)}`);
  }

  // ── Write aggregate result envelope to --out ──────────────────────────────────
  const aggregateEnvelope = {
    meta: {
      eval:                    'lever-sweep',
      date,
      commit,
      engine_version,
      db_path:                 DB_PATH,
      scratch_path:            scratchPath,
      lever_under_test:        LEVER,
      phase_40_baseline_commit: 'd41d5c8',
    },
    baseline: {
      value:      baselineValue,
      skip_split: baselineSkipSplit,
      skip_rate:  baselineSkipRate,
    },
    lever_candidates: leverResults,
    combined_best:    combinedBestConfig,
    // Root-level skip_split reflects the baseline config (for schema parity with cost-benefit-probe.json)
    skip_split: baselineSkipSplit,
    write_ledger: {
      measured:                false,
      reason:                  'Write-side sleep pass deferred to 42-04 cost-probe-gated reset window (D-06).',
      stack_used:              `judge=${judgeProvider || 'unset'}, extractor=${extractorProvider || 'unset'}`,
      per_model:               null,  // populated by deferred run
      subscription_marginal_usd: 0,
      prices_dated:            PRICES_DATED,
      prices_source:           'Anthropic public pricing page (estimates only)',
    },
    ku_gate: {
      ku_score:           null,      // deferred to 42-04
      ku_scored_cases:    null,      // deferred
      regression:         null,      // deferred
      tolerance_band_pts: 1,         // D-05: ≤1pt noise band
      deferred:           true,
      source:             `scripts/eval/results/42-ku-gate-${LEVER}-<value>.json`,
    },
    caveats: [
      `Sample size: ${n_found} episodes (requested ${SAMPLE_N}). Results representative only at this scale.`,
      `Stack used: judge=${judgeProvider || 'unset'}, extractor=${extractorProvider || 'unset'}.`,
      'Subscription marginal cost ≈ $0; retail-$ figures are API-list estimates only (not actual charges).',
      'Write-side sleep pass deferred to 42-04 cost-probe-gated reset window (D-06).',
      'KU gate exercised in --dry-run only this phase ($0, validates wiring + config_override echo). Real KU accuracy verdict deferred to 42-04.',
      'Lever acceptance rule (D-05, encoded): a candidate passes only if ku_score stays within ≤1pt noise band of baseline. Verdict deferred.',
    ],
  };

  // Write aggregate envelope to --out (mirrors cost-benefit-harness result write pattern)
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(aggregateEnvelope, null, 2));

  scratchDb.close();

  console.log('\n' + '─'.repeat(60));
  console.log(`Aggregate result  -> ${OUT}`);
  console.log(`Per-lever files   -> ${OUT_DIR}/42-sweep-${LEVER}-<value>.json`);
  console.log(`KU gate files     -> ${OUT_DIR}/42-ku-gate-${LEVER}-<value>.json`);
  console.log('─'.repeat(60) + '\n');
})().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
