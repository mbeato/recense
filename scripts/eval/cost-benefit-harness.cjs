/**
 * EVAL-04 Token Cost-Benefit / Breakeven Harness — recense write ledger + breakeven combiner.
 *
 * Measures what a recense sleep pass costs in tokens (extract→Haiku, judge→Sonnet) per
 * ingested turn, amortized over the consolSkipThreshold gate that skips sub-threshold
 * episodes. Combines with EVAL-03 read-side savings (injection efficiency) to compute
 * the breakeven session count where recense pays for itself.
 *
 * Currency = tokens with a retail-$ translation.
 * Subscription marginal cost ≈ $0; retail-$ figures are "API list price equivalent."
 * No paid or direct-API run is triggered — headless path degrades gracefully.
 *
 * PRICE CONSTANTS:
 *   Source: Anthropic public pricing page — estimates as of 2026-06-19.
 *   These are RETAIL LIST prices per million tokens. Subscription marginal cost is $0.
 *   Only per-token rates are stored here; no headline $ is hardcoded.
 *
 * Two-part output:
 *   PART A — WRITE LEDGER: run the real sleep pass over a scratch copy of the db,
 *             measure per-call token usage via the headless usage sink.
 *   PART B — BREAKEVEN COMBINER: load EVAL-03 read savings + compute net(N) table.
 *
 * Run:
 *   npm run eval:cost-benefit
 *   npm run build && node scripts/eval/cost-benefit-harness.cjs
 *   npm run build && node scripts/eval/cost-benefit-harness.cjs --db /tmp/nonexistent.db
 *
 * Real measured run (requires `claude` auth + headless providers):
 *   RECENSE_JUDGE_PROVIDER=claude-headless \
 *   RECENSE_EXTRACTOR_PROVIDER=claude-headless \
 *   npm run eval:cost-benefit
 *
 * Key invariants:
 *   - Never touches live recense.db for writes (VACUUM INTO scratch first).
 *   - Never fabricates token numbers (write ledger marked measured:false when unavailable).
 *   - --with-longmemeval is a STUB; it prints what it would run + exits that arm without spending.
 *   - No paid direct-API calls from this harness (budget cap, 2026-06-19).
 */
'use strict';

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { execSync } = require('child_process');

// ── arg parser (mirrors injection-efficiency-harness.cjs convention) ───────────
const arg   = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const flag  = (k)    => process.argv.includes(k);

const DB_PATH     = arg('--db',            process.env['RECENSE_DB'] || path.join(os.homedir(), '.config', 'recense', 'recense.db'));
const OUT         = arg('--out',           'scripts/eval/results/cost-benefit-PENDING.json');
const SAMPLE_N    = parseInt(arg('--sample', '25'), 10);
const READ_SAVINGS_PATH = arg('--read-savings', null);
const WITH_LONGMEMEVAL  = flag('--with-longmemeval');
const SCRATCH_ARG       = arg('--scratch',  null);

// ── compiled engine modules (require `npm run build` first) ────────────────────
const Database        = require('better-sqlite3');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');

// ── PRICE CONSTANTS (Anthropic list price, 2026-06-19) ─────────────────────────
// Source: https://www.anthropic.com/pricing (estimates as of 2026-06-19).
// These are $/million tokens for DIRECT API access.
// Subscription marginal cost is $0 — these are "API-list equivalent" estimates only.
const PRICES = {
  // claude-haiku-4-5 (extraction model in the sleep pass)
  'claude-haiku-4-5': {
    input_per_m:              0.80,
    output_per_m:             4.00,
    cache_write_per_m:        1.00,
    cache_read_per_m:         0.08,
  },
  // claude-sonnet-4-6 (judge model in the sleep pass)
  'claude-sonnet-4-6': {
    input_per_m:              3.00,
    output_per_m:             15.00,
    cache_write_per_m:        3.75,
    cache_read_per_m:         0.30,
  },
};
const PRICES_DATED = '2026-06-19';

// ── helpers ──────────────────────────────────────────────────────────────────

function header(title) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + title);
  console.log('─'.repeat(60));
}

/**
 * Compute retail-$ for a usage record using the price table.
 * Returns 0 if the model is not in PRICES.
 */
function retailUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const inp    = (usage.input_tokens                 || 0) / 1e6 * p.input_per_m;
  const out    = (usage.output_tokens                || 0) / 1e6 * p.output_per_m;
  const cwrite = (usage.cache_creation_input_tokens  || 0) / 1e6 * p.cache_write_per_m;
  const cread  = (usage.cache_read_input_tokens      || 0) / 1e6 * p.cache_read_per_m;
  return inp + out + cwrite + cread;
}

/** Sum an array of numbers (handles empty array → 0). */
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

/**
 * Apply the consolidator skip-threshold gate to a sampled episode row,
 * returning the effective threshold for that episode.
 * Mirrors consolidator.ts ~line 84 + ~420 gate:
 *   per-source override > per-role (assistant vs. other) > global consolSkipThreshold.
 *   hard_keep=1 always processed (threshold effectively 0).
 */
function effectiveThreshold(episode, config) {
  if (episode.hard_keep) return 0; // hard_keep=1 always processed
  // Per-source override wins over per-role.
  const sourceThreshold = config.salience.consolSkipThresholdBySource[episode.source];
  if (sourceThreshold !== undefined) return sourceThreshold;
  // Per-role.
  if (episode.role === 'assistant') return config.consolSkipThresholdAssistant;
  return config.consolSkipThreshold;
}

/** Load the newest injection-efficiency results JSON (EVAL-03 read credit). */
function loadReadSavings(readSavingsPath) {
  // If an explicit path was given, use it.
  let candidate = readSavingsPath;

  if (!candidate) {
    // Glob the newest injection-efficiency-*.json in the results dir.
    const resultsDir = path.join('scripts', 'eval', 'results');
    let found = null;
    let foundMtime = 0;
    try {
      const files = fs.readdirSync(resultsDir);
      for (const f of files) {
        if (f.startsWith('injection-efficiency') && f.endsWith('.json')) {
          const fp = path.join(resultsDir, f);
          const m = fs.statSync(fp).mtimeMs;
          if (m > foundMtime) { foundMtime = m; found = fp; }
        }
      }
    } catch { /* results dir absent */ }
    candidate = found;
  }

  if (!candidate) {
    return { read_savings_per_session: 0, source: 'none', note: 'No injection-efficiency results found; use --read-savings to specify path. Breakeven computed with read savings = 0.' };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    const pe = raw.point_estimate;
    if (!pe || pe.flat_missing) {
      return { read_savings_per_session: 0, source: candidate, note: 'injection-efficiency results missing flat baseline (flat_missing=true); using 0.' };
    }
    const savings = (pe.flat_tokens || 0) - (pe.injected_tokens || 0);
    if (savings <= 0) {
      return { read_savings_per_session: 0, source: candidate, note: `Computed savings = ${savings} (flat_tokens=${pe.flat_tokens}, injected_tokens=${pe.injected_tokens}); using 0.` };
    }
    return { read_savings_per_session: savings, source: candidate, note: null };
  } catch (e) {
    return { read_savings_per_session: 0, source: candidate, note: `Failed to parse ${candidate}: ${e.message}` };
  }
}

// ── PART B: breakeven table ──────────────────────────────────────────────────

/**
 * Compute the breakeven table for N ∈ {1,2,5,10,20,50}.
 * net(N) = total_write_tokens − read_savings_per_session × N
 * Breakeven = smallest N where net ≤ 0.
 */
function computeBreakeven(totalWriteTokens, readSavingsPerSession, writeMeasured) {
  const Ns = [1, 2, 5, 10, 20, 50];
  const rows = [];
  for (const n of Ns) {
    // net is only meaningful with a measured write debit; null otherwise so the
    // display/JSON never imply a breakeven the cost side was never measured for.
    const net_tokens = writeMeasured ? Math.round(totalWriteTokens - readSavingsPerSession * n) : null;
    rows.push({ n_sessions: n, cumulative_read_savings_tokens: readSavingsPerSession * n, net_tokens });
  }
  const breakevenN = writeMeasured && readSavingsPerSession > 0
    ? (rows.find(r => r.net_tokens <= 0)?.n_sessions ?? null)
    : null;
  const gap = breakevenN === null && writeMeasured && readSavingsPerSession > 0
    ? Math.round(totalWriteTokens - readSavingsPerSession * 50)
    : null;
  return { table: rows, breakeven_n: breakevenN, note: breakevenNote(writeMeasured, readSavingsPerSession, breakevenN, gap) };
}

function breakevenNote(writeMeasured, readSavingsPerSession, breakevenN, gap) {
  if (!writeMeasured) return 'Cannot compute breakeven without a measured write ledger. Re-run with RECENSE_JUDGE_PROVIDER=claude-headless RECENSE_EXTRACTOR_PROVIDER=claude-headless.';
  if (readSavingsPerSession === 0) return 'Read savings = 0 (no EVAL-03 data); breakeven cannot be computed. Run npm run eval:injection first.';
  if (breakevenN !== null) return `Breakeven at N=${breakevenN} sessions: cumulative read savings first exceed write cost.`;
  return `Not reached within 50 sessions (gap at N=50: ${gap} tokens). Write cost exceeds the modeled read savings at this sample size.`;
}

// ── main ─────────────────────────────────────────────────────────────────────

(async function main() {
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe','pipe','ignore'] }).toString().trim(); } catch {}
  let engine_version = 'unknown';
  try { engine_version = require('../../package.json').version; } catch {}
  const date = new Date().toISOString();

  console.log('\nEVAL-04 Token Cost-Benefit / Breakeven Harness');
  console.log('Write ledger: real sleep pass over scratch copy + usage-envelope instrumentation');
  console.log('Breakeven: combined with EVAL-03 read credit → net(N) sessions table');
  console.log(`DB:      ${DB_PATH}`);
  console.log(`Sample:  ${SAMPLE_N}`);
  console.log('Subscription marginal cost ≈ $0. Retail-$ = API-list estimate only.');

  // ── (0) Open live DB readonly — graceful degrade if missing/unopenable ──────
  let liveDb;
  try {
    liveDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    console.log(`\nno data: recense.db missing or unopenable at ${DB_PATH} — nothing to measure`);
    console.log('Tip: run `recense init` then ingest some episodes to populate the DB.');
    process.exit(0);
  }

  // ── Check for non-empty db ──────────────────────────────────────────────────
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

  // ── Build scratch path (NEVER write to live db) ─────────────────────────────
  const scratchPath = SCRATCH_ARG || path.join(os.tmpdir(), `recense-eval04-scratch-${Date.now()}.db`);

  // Use VACUUM INTO to produce a clean single-file copy (WAL-safe; checkpoints un-written WAL pages).
  try {
    liveDb.prepare('VACUUM INTO ?').run(scratchPath);
  } catch (e) {
    liveDb.close();
    console.log(`\nno data: failed to VACUUM INTO scratch db at ${scratchPath}: ${e.message}`);
    process.exit(0);
  }
  liveDb.close();
  console.log(`Scratch DB: ${scratchPath} (VACUUM INTO from live — WAL-safe)`);

  // ── (1) Open scratch db read-write ─────────────────────────────────────────
  const scratchDb = new Database(scratchPath);

  // ── PART A: WRITE LEDGER ───────────────────────────────────────────────────
  header('PART A — WRITE LEDGER  [skip-threshold split + per-call usage]');

  // Sample N most-recent UNCONSOLIDATED episodes from the scratch db.
  let sampledRows;
  let selectionCriteria;
  let consolidatedFilterUsed;

  const unconsolidatedCount = scratchDb.prepare('SELECT COUNT(*) AS n FROM episode WHERE consolidated=0').get().n;
  if (unconsolidatedCount >= SAMPLE_N) {
    sampledRows = scratchDb.prepare(
      'SELECT id, ts, salience, hard_keep, role, source FROM episode WHERE consolidated=0 ORDER BY ts DESC LIMIT ?'
    ).all(SAMPLE_N);
    consolidatedFilterUsed = true;
    selectionCriteria = 'unconsolidated (consolidated=0), most-recent N';
  } else {
    // Fallback: most-recent overall (note in results).
    sampledRows = scratchDb.prepare(
      'SELECT id, ts, salience, hard_keep, role, source FROM episode ORDER BY ts DESC LIMIT ?'
    ).all(SAMPLE_N);
    consolidatedFilterUsed = false;
    selectionCriteria = `fallback: all episodes (only ${unconsolidatedCount} unconsolidated, < requested ${SAMPLE_N}), most-recent N`;
  }

  const n_requested = SAMPLE_N;
  const n_found     = sampledRows.length;

  console.log(`  Requested sample:  ${n_requested}`);
  console.log(`  Found:             ${n_found} (${selectionCriteria})`);

  if (n_found === 0) {
    scratchDb.close();
    console.log('\nno data: no episodes found in scratch db — nothing to measure');
    process.exit(0);
  }

  // ── Skip-threshold split (LLM-free gate mirror) ──────────────────────────────
  const config = { ...DEFAULT_CONFIG, dbPath: scratchPath };
  let n_below_threshold = 0;
  let n_extracted = 0;
  const thresholdsUsed = { global: config.consolSkipThreshold, assistant: config.consolSkipThresholdAssistant };
  const bySourceUsed   = config.salience.consolSkipThresholdBySource;

  for (const ep of sampledRows) {
    const threshold = effectiveThreshold(ep, config);
    if (!ep.hard_keep && ep.salience < threshold) {
      n_below_threshold++;
    } else {
      n_extracted++;
    }
  }

  console.log(`\n  Skip-threshold split (LLM-free gate):`);
  console.log(`    n_below_threshold (skipped, $0 write): ${n_below_threshold}`);
  console.log(`    n_extracted (will be processed):       ${n_extracted}`);
  console.log(`    global threshold:                      ${thresholdsUsed.global}`);
  console.log(`    assistant threshold:                   ${thresholdsUsed.assistant}`);
  console.log(`  Per-turn write cost amortizes over ALL ${n_found} sampled episodes (not just extracted).`);

  // ── longmemeval arm — STUB behind approval gate ──────────────────────────────
  if (WITH_LONGMEMEVAL) {
    header('--with-longmemeval ARM  [STUB — not executed]');
    console.log('  This arm would measure answerer-token-delta work-savings:');
    console.log('    1. Full-context baseline: all session turns in-context → count input tokens');
    console.log('    2. recense-retrieval: inject top-K memory nodes → count input tokens');
    console.log('    3. Delta = full_context_tokens - recense_tokens per question');
    console.log('  Estimated cost: ~$3-5 (requires ANTHROPIC_API_KEY + LongMemEval-S dataset)');
    console.log('  To run: approve budget + add ANTHROPIC_API_KEY, then implement this arm.');
    console.log('  Per the API budget cap (2026-06-19), this harness does NOT trigger that run.');
  } else {
    console.log('\n  Note: --with-longmemeval arm (answerer-token-delta) is available on approval;');
    console.log('  pass --with-longmemeval to see what it would run (still no API calls).');
  }

  // ── Install usage sink + trim scratch db to sample ───────────────────────────
  // Trim the scratch db to the sampled episodes to bound the sleep pass.
  const sampledIds = sampledRows.map(r => r.id);
  // Delete non-sampled unconsolidated rows only (leave consolidated rows to avoid FK issues).
  // For the "fallback all" path, we can still trim non-sampled unconsolidated to the sample.
  if (consolidatedFilterUsed) {
    const placeholders = sampledIds.map(() => '?').join(',');
    try {
      scratchDb.prepare(
        `DELETE FROM episode WHERE consolidated=0 AND id NOT IN (${placeholders})`
      ).run(...sampledIds);
    } catch { /* non-critical — pass may just process more episodes */ }
  }

  // ── Headless run ──────────────────────────────────────────────────────────────
  let writeLedger;

  // Check if the headless providers are configured.
  const judgeProvider    = process.env['RECENSE_JUDGE_PROVIDER']     || '';
  const extractorProvider = process.env['RECENSE_EXTRACTOR_PROVIDER'] || '';
  const headlessActive   = judgeProvider === 'claude-headless' && extractorProvider === 'claude-headless';

  if (!headlessActive) {
    console.log('\n  Write ledger: headless providers NOT active (RECENSE_JUDGE_PROVIDER and');
    console.log('  RECENSE_EXTRACTOR_PROVIDER must both be "claude-headless" for a measured run).');
    console.log('  Marking write_ledger.measured=false — no fabricated numbers.');
    writeLedger = {
      measured: false,
      reason: `Headless providers not configured (RECENSE_JUDGE_PROVIDER="${judgeProvider}", RECENSE_EXTRACTOR_PROVIDER="${extractorProvider}"). Set both to "claude-headless" for a measured run.`,
      stack_used: `judge=${judgeProvider || 'unset'}, extractor=${extractorProvider || 'unset'}`,
    };
  } else {
    // Try to require the compiled dist modules.
    let setHeadlessUsageSink, runConsolidation;
    try {
      ({ setHeadlessUsageSink } = require('../../dist/src/model/claude-headless-client'));
      ({ runConsolidation }    = require('../../dist/src/consolidation/run-sleep-pass'));
    } catch (e) {
      writeLedger = {
        measured: false,
        reason: `Could not require dist modules: ${e.message}. Run npm run build first.`,
        stack_used: `judge=${judgeProvider}, extractor=${extractorProvider}`,
      };
    }

    if (!writeLedger) {
      // Accumulate per-call usage keyed by model.
      const perModelCalls = {}; // { model: [{ usage, total_cost_usd, duration_ms }] }
      setHeadlessUsageSink(u => {
        if (!perModelCalls[u.model]) perModelCalls[u.model] = [];
        perModelCalls[u.model].push({ usage: u.usage, total_cost_usd: u.total_cost_usd, duration_ms: u.duration_ms });
      });

      const passLog = [];
      let passError = null;

      try {
        await runConsolidation(
          scratchDb,
          scratchPath,
          process.env,
          msg => { passLog.push(msg); console.log(`  [sleep-pass] ${msg}`); },
        );
      } catch (e) {
        passError = e.message || String(e);
        console.log(`  [sleep-pass] ERROR: ${passError}`);
      } finally {
        setHeadlessUsageSink(null);
      }

      const totalCalls = Object.values(perModelCalls).reduce((s, arr) => s + arr.length, 0);

      if (totalCalls === 0 && !passError) {
        writeLedger = {
          measured: false,
          reason: 'Sleep pass completed but the usage sink captured 0 calls. The `claude` binary may not be available in this environment, or all episodes were skipped by the threshold gate.',
          stack_used: `judge=${judgeProvider}, extractor=${extractorProvider}`,
          pass_log: passLog,
        };
      } else if (passError && totalCalls === 0) {
        writeLedger = {
          measured: false,
          reason: `Sleep pass error: ${passError}`,
          stack_used: `judge=${judgeProvider}, extractor=${extractorProvider}`,
          pass_log: passLog,
        };
      } else {
        // Aggregate per-model token counts.
        const perModelSummary = {};
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheWriteTokens = 0;
        let totalCacheReadTokens = 0;
        let totalRetailUsd = 0;

        for (const [model, calls] of Object.entries(perModelCalls)) {
          const inputTokens        = sum(calls.map(c => c.usage?.input_tokens ?? 0));
          const outputTokens       = sum(calls.map(c => c.usage?.output_tokens ?? 0));
          const cacheWriteTokens   = sum(calls.map(c => c.usage?.cache_creation_input_tokens ?? 0));
          const cacheReadTokens    = sum(calls.map(c => c.usage?.cache_read_input_tokens ?? 0));
          const modelRetailUsd     = sum(calls.map(c => retailUsd(model, c.usage)));
          const avgDurationMs      = calls.length > 0 ? Math.round(sum(calls.map(c => c.duration_ms ?? 0)) / calls.length) : 0;

          totalInputTokens       += inputTokens;
          totalOutputTokens      += outputTokens;
          totalCacheWriteTokens  += cacheWriteTokens;
          totalCacheReadTokens   += cacheReadTokens;
          totalRetailUsd         += modelRetailUsd;

          perModelSummary[model] = {
            n_calls: calls.length,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheWriteTokens,
            cache_read_input_tokens: cacheReadTokens,
            total_tokens: inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
            retail_usd_estimate: +modelRetailUsd.toFixed(6),
            avg_duration_ms: avgDurationMs,
          };
        }

        const totalAllTokens = totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;
        // Per-turn cost amortized over ALL sampled episodes (not just extracted).
        const perTurnTokens = n_found > 0 ? totalAllTokens / n_found : 0;

        console.log('\n  Write ledger:');
        console.log(`    Total calls captured: ${totalCalls}`);
        console.log(`    Total tokens (all models): ${totalAllTokens}`);
        console.log(`    Per-turn write tokens (amortized over ${n_found} sampled): ${perTurnTokens.toFixed(1)}`);
        console.log(`    Retail-$ estimate (API list price): $${totalRetailUsd.toFixed(6)}`);
        console.log(`    Subscription marginal cost: $0 (billed to Max subscription, not API)`);

        writeLedger = {
          measured: true,
          stack_used: `judge=${judgeProvider}, extractor=${extractorProvider}`,
          n_calls_total: totalCalls,
          per_model: perModelSummary,
          totals: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cache_creation_input_tokens: totalCacheWriteTokens,
            cache_read_input_tokens: totalCacheReadTokens,
            all_tokens: totalAllTokens,
            per_turn_tokens_amortized: +perTurnTokens.toFixed(2),
          },
          retail_usd: +totalRetailUsd.toFixed(6),
          subscription_marginal_usd: 0,
          prices_dated: PRICES_DATED,
          prices_source: 'Anthropic public pricing page (estimates only)',
          pass_log: passLog,
          ...(passError ? { pass_error: passError } : {}),
        };
      }
    }
  }

  scratchDb.close();

  // ── PART B: BREAKEVEN COMBINER ────────────────────────────────────────────────
  header('PART B — BREAKEVEN COMBINER  [net(N) table vs EVAL-03 read credit]');

  const readLedger = loadReadSavings(READ_SAVINGS_PATH);
  console.log(`  Read savings source: ${readLedger.source}`);
  console.log(`  Read savings per session: ${readLedger.read_savings_per_session} tokens`);
  if (readLedger.note) console.log(`  Note: ${readLedger.note}`);

  const totalWriteTokens = writeLedger.measured ? (writeLedger.totals?.all_tokens ?? 0) : 0;
  const breakevenResult  = computeBreakeven(totalWriteTokens, readLedger.read_savings_per_session, writeLedger.measured === true);

  console.log('\n  N sessions | Cumul. read savings (tok) | Net tokens');
  console.log('  ---------- | ------------------------- | ----------');
  for (const row of breakevenResult.table) {
    const net_str = row.net_tokens === null ? 'n/a (write not measured)' : row.net_tokens.toLocaleString();
    const prefix  = row.n_sessions === breakevenResult.breakeven_n ? '  ← BREAKEVEN' : '';
    console.log(`  ${String(row.n_sessions).padEnd(10)} | ${String(row.cumulative_read_savings_tokens).padEnd(25)} | ${net_str}${prefix}`);
  }
  console.log(`\n  ${breakevenResult.note}`);

  // Batch-size-independent invariant: the N-table breakeven scales with the
  // arbitrary --sample size, so also report the per-turn ratio. Each ingested
  // turn costs `per_turn_write` tokens; the memory saves `read_savings_per_session`
  // inject-tokens every subsequent session → sessions-of-reuse to repay ONE turn.
  const perTurnWrite = writeLedger.measured ? (writeLedger.totals?.per_turn_tokens_amortized ?? 0) : 0;
  if (writeLedger.measured && readLedger.read_savings_per_session > 0) {
    const sessionsPerTurn = perTurnWrite / readLedger.read_savings_per_session;
    console.log(`  Per-turn breakeven (batch-size-independent): ${sessionsPerTurn.toFixed(1)} sessions of reuse repay one ingested turn`);
    console.log(`    (per-turn write ${perTurnWrite.toFixed(0)} tok ÷ per-session inject saving ${readLedger.read_savings_per_session} tok). Inject-savings floor only — excludes avoided re-derivation.`);
  }

  // ── Results JSON ──────────────────────────────────────────────────────────────
  const meta = {
    eval:           'cost-benefit',
    date,
    commit,
    engine_version,
    db_path:        DB_PATH,
    scratch_path:   scratchPath,
  };

  const sampleBlock = {
    requested:             n_requested,
    found:                 n_found,
    selection_criteria:    selectionCriteria,
    consolidated_filter:   consolidatedFilterUsed,
  };

  const skipSplitBlock = {
    n_below_threshold,
    n_extracted,
    thresholds: {
      global:    thresholdsUsed.global,
      assistant: thresholdsUsed.assistant,
      per_source: bySourceUsed,
    },
  };

  const resultEnvelope = {
    meta,
    sample: sampleBlock,
    skip_split: skipSplitBlock,
    write_ledger: writeLedger,
    read_ledger: {
      source: readLedger.source,
      read_savings_per_session: readLedger.read_savings_per_session,
      note: readLedger.note,
    },
    breakeven: breakevenResult,
    caveats: [
      `Sample size: ${n_found} episodes (requested ${n_requested}). Results are representative only at this scale.`,
      `Stack used: judge=${judgeProvider || 'unset'}, extractor=${extractorProvider || 'unset'}.`,
      `Read savings source: ${readLedger.source}.`,
      'Subscription marginal cost ≈ $0; retail-$ figures are API-list estimates only (not actual charges).',
      'Token counts from the headless usage envelope, not a re-tokenization.',
      `Price constants dated ${PRICES_DATED} (Anthropic public pricing page); may drift.`,
      'Per-turn write cost is amortized over ALL sampled episodes including those skipped by the threshold gate.',
    ],
  };

  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));

  console.log('\n' + '─'.repeat(60));
  console.log(`Results written -> ${OUT}`);
  console.log('─'.repeat(60) + '\n');
})().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
