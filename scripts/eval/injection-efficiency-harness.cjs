/**
 * EVAL-03 Injection-Efficiency Harness — recense bounded SessionStart injection vs flat MEMORY.md baseline (D-33).
 *
 * $0, LLM-free: SQLite reads + spawned LLM-free CLI + char counting only.
 * No LLM/embedding/judge module is imported or invoked; never touches model APIs.
 *
 * Run:
 *   npm run eval:injection
 *   npm run build && node scripts/eval/injection-efficiency-harness.cjs
 *   npm run build && node scripts/eval/injection-efficiency-harness.cjs --db /tmp/nonexistent.db
 *
 * Key requirements:
 *   - Always run `npm run build` before this script (requires compiled dist/ output).
 *   - Token counting uses Math.round(chars/4) — same proxy the session-start-cli char cap uses.
 *   - Spawns dist/src/adapter/session-start-cli.js with a synthetic SessionStart stdin payload.
 *   - Opens recense.db with {readonly:true, fileMustExist:true}; never runs DDL or writes.
 *   - Gracefully exits 0 with a "no data" message when db is missing or empty (CI-smoke safe).
 *   - Results JSON written to --out path with meta and three measurement blocks.
 *
 * Three measurements (all computed live from the real db + injection path — no hardcoded figures):
 *   (a) POINT ESTIMATE: spawn real session-start-cli, measure injected payload size vs flat file.
 *   (b) SCALING CURVE: project flat-file-of-everything tokens vs bounded injection budget at Nx node counts.
 *   (c) BELIEF-CORRECTION COUNT: tombstoned + prev_value nodes = in-place auto-corrections the engine made.
 */
'use strict';

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { execSync, spawnSync } = require('child_process');

// ---- arg parser (mirrors correctness-harness.cjs convention) ----------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DB_PATH   = arg('--db',   process.env['RECENSE_DB'] || path.join(os.homedir(), '.config', 'recense', 'recense.db'));
const CWD_ARG   = arg('--cwd',  process.cwd());
const FLAT_PATH = arg('--flat', path.join(os.homedir(), '.claude', 'projects', '-Users-you-recense', 'memory', 'MEMORY.md'));
const OUT       = arg('--out',  'scripts/eval/results/injection-efficiency-PENDING.json');

// ---- compiled engine modules (require npm run build first) ------------------
// Failing require here means `npm run build` hasn't been run yet.
const Database        = require('better-sqlite3');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');

// ---- helpers ----------------------------------------------------------------

/** Char-based token proxy — same formula the session-start-cli char cap uses. */
function charsToTokens(chars) {
  return Math.round(chars / 4);
}

/** Count non-empty lines in a string. */
function countNonEmptyLines(text) {
  if (!text) return 0;
  return text.split('\n').filter(l => l.trim().length > 0).length;
}

/** Count top-level MEMORY.md list entries (lines starting with "- "). */
function countFlatEntries(text) {
  return text.split('\n').filter(l => l.startsWith('- ')).length;
}

/** Print a section header. */
function header(title) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + title);
  console.log('─'.repeat(60));
}

// ---- main -------------------------------------------------------------------

(function main() {
  // Resolve current git commit for results metadata
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

  // Engine version from package.json
  let engine_version = 'unknown';
  try { engine_version = require('../../package.json').version; } catch {}

  const date = new Date().toISOString();

  console.log('\nEVAL-03 Injection-Efficiency Harness');
  console.log('$0, LLM-free: SQLite reads + spawned session-start-cli + char counting');
  console.log(`DB:   ${DB_PATH}`);
  console.log(`CWD:  ${CWD_ARG}`);
  console.log(`Flat: ${FLAT_PATH}`);

  // ── (0) Open DB readonly — graceful degrade if missing/unopenable ──────────
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    console.log(`\nno data: recense.db missing or unopenable at ${DB_PATH} — nothing to measure`);
    console.log('Tip: run `recense init` then a sleep pass to populate the DB.');
    process.exit(0);
  }

  // ── Check for non-empty db ─────────────────────────────────────────────────
  let n_live_nodes;
  try {
    n_live_nodes = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned=0').get().n;
  } catch {
    db.close();
    console.log(`\nno data: recense.db at ${DB_PATH} has no node table — run a writer CLI first`);
    process.exit(0);
  }

  if (n_live_nodes === 0) {
    db.close();
    console.log(`\nno data: recense.db at ${DB_PATH} has 0 live nodes — nothing to measure`);
    process.exit(0);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // (a) POINT ESTIMATE — spawn real session-start-cli, measure injected payload
  // ────────────────────────────────────────────────────────────────────────────
  header('(a) POINT ESTIMATE  [today\'s actual injection]');

  const cliPath = path.join(process.cwd(), 'dist', 'src', 'adapter', 'session-start-cli.js');
  const stdinPayload = JSON.stringify({ hookEventName: 'SessionStart', cwd: CWD_ARG });

  const spawnResult = spawnSync(
    process.execPath,
    [cliPath, '--db', DB_PATH],
    {
      input: stdinPayload,
      encoding: 'utf8',
      timeout: 15_000,
    }
  );

  if (spawnResult.error || spawnResult.status !== 0) {
    const err = spawnResult.error ? spawnResult.error.message : (spawnResult.stderr || '(non-zero exit)');
    console.error(`\nERROR: session-start-cli spawn failed: ${err}`);
    console.error('Ensure `npm run build` has been run and the DB path is correct.');
    db.close();
    process.exit(1);
  }

  let injectedText = '';
  try {
    const cliOut = JSON.parse(spawnResult.stdout);
    injectedText = cliOut?.hookSpecificOutput?.additionalContext ?? '';
  } catch {
    console.error(`\nERROR: failed to parse session-start-cli stdout as JSON`);
    console.error('stdout was:', spawnResult.stdout.slice(0, 200));
    db.close();
    process.exit(1);
  }

  const injected_chars  = injectedText.length;
  const injected_tokens = charsToTokens(injected_chars);
  const injected_nodes  = countNonEmptyLines(injectedText);

  // ── Flat baseline ───────────────────────────────────────────────────────────
  let flat_chars   = null;
  let flat_tokens  = null;
  let flat_entries = null;
  let flat_missing = false;

  try {
    const flatText  = fs.readFileSync(FLAT_PATH, 'utf8');
    flat_chars   = flatText.length;
    flat_tokens  = charsToTokens(flat_chars);
    flat_entries = countFlatEntries(flatText);
  } catch {
    flat_missing = true;
    console.log(`Note: flat baseline file not found at ${FLAT_PATH}; skipping baseline comparison.`);
  }

  const token_reduction_pct =
    flat_tokens !== null && flat_tokens > 0
      ? +(((flat_tokens - injected_tokens) / flat_tokens) * 100).toFixed(1)
      : null;

  console.log(`  Injected chars:          ${injected_chars}`);
  console.log(`  Injected tokens (~):     ${injected_tokens}`);
  console.log(`  Injected nodes:          ${injected_nodes}`);

  if (!flat_missing) {
    console.log(`  Flat baseline chars:     ${flat_chars}`);
    console.log(`  Flat baseline tokens (~):${flat_tokens}`);
    console.log(`  Flat list entries:       ${flat_entries}`);
    console.log(`  Token reduction:         ${token_reduction_pct}%  (recense injects ${injected_tokens} tok vs flat ${flat_tokens} tok)`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // (b) SCALING CURVE — projection, clearly labeled
  // ────────────────────────────────────────────────────────────────────────────
  header('(b) SCALING CURVE  [projection / upper bound — not measured values]');

  const avgCharsRow = db.prepare("SELECT AVG(LENGTH(value)) AS avg_chars FROM node WHERE tombstoned=0").get();
  const avg_chars   = avgCharsRow ? +avgCharsRow.avg_chars.toFixed(1) : 0;

  const injection_budget_tokens = DEFAULT_CONFIG.injectionTokenBudget; // read from config, never hardcoded
  const injection_budget_chars  = injection_budget_tokens * 4;         // same proxy the CLI uses

  // Crossover: how many nodes until a hypothetical flat-file-of-everything hits the budget?
  // flat_projected_tokens = n_nodes * avg_chars / 4
  // crossover when: n_nodes * avg_chars / 4 = injection_budget_tokens
  // => n_nodes = injection_budget_tokens * 4 / avg_chars
  const crossover_nodes = avg_chars > 0 ? Math.round((injection_budget_tokens * 4) / avg_chars) : null;

  const multiples = [1, 2, 5, 10];
  console.log(`  Live node count:         ${n_live_nodes}`);
  console.log(`  Avg chars/node:          ${avg_chars}`);
  console.log(`  recense injection budget:${injection_budget_tokens} tokens (${injection_budget_chars} chars) — O(1) constant`);
  if (crossover_nodes !== null) {
    console.log(`  Flat exceeds recense at: ~${crossover_nodes} nodes (at avg ${avg_chars} chars/node)`);
  }

  console.log('');
  console.log('  Node count  | Flat-of-everything tokens (projected) | recense budget');
  console.log('  ----------- | ------------------------------------- | --------------');

  const crossover_table = [];
  for (const mult of multiples) {
    const n = n_live_nodes * mult;
    const proj_flat_tokens = Math.round(n * avg_chars / 4);
    const label = mult === 1 ? `${n} (current)` : `${n} (${mult}x)`;
    const exceeds = proj_flat_tokens > injection_budget_tokens ? ' ← exceeds budget' : '';
    console.log(`  ${label.padEnd(11)} | ${String(proj_flat_tokens + ' (projected upper bound)').padEnd(37)} | ${injection_budget_tokens} tokens${exceeds}`);
    crossover_table.push({ n_nodes: n, mult, projected_flat_tokens: proj_flat_tokens, recense_budget_tokens: injection_budget_tokens });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // (c) LIVE BELIEF-CORRECTION COUNT — pure SQL, no spawning
  // ────────────────────────────────────────────────────────────────────────────
  header('(c) BELIEF-CORRECTION COUNTS  [live from db]');

  const tombstoned          = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned=1').get().n;
  const prev_value_corrections = db.prepare('SELECT COUNT(*) AS n FROM node WHERE prev_value IS NOT NULL').get().n;
  const episodes            = db.prepare('SELECT COUNT(*) AS n FROM episode').get().n;

  console.log(`  Tombstoned nodes:        ${tombstoned}  (beliefs that were replaced in-place)`);
  console.log(`  Prev-value corrections:  ${prev_value_corrections}  (live nodes that carry a prev_value trail)`);
  console.log(`  Episode rows:            ${episodes}  (total raw episodic turns ingested)`);
  console.log('');
  console.log('  These in-place auto-corrections would require manual MEMORY.md edits in a flat system.');

  db.close();

  // ── Build results envelope (mirrors correctness-harness shape) ────────────
  const meta = {
    eval:           'injection-efficiency',
    date,
    commit,
    engine_version,
    db_path:        DB_PATH,
    cwd:            CWD_ARG,
    flat_path:      FLAT_PATH,
  };

  const point_estimate = {
    injected_chars,
    injected_tokens,
    injected_nodes,
    flat_chars:      flat_missing ? null : flat_chars,
    flat_tokens:     flat_missing ? null : flat_tokens,
    flat_entries:    flat_missing ? null : flat_entries,
    token_reduction_pct: flat_missing ? null : token_reduction_pct,
    flat_missing,
  };

  const scaling_projection = {
    n_live_nodes,
    avg_chars,
    injection_budget_tokens,
    crossover_nodes,
    crossover_table,
  };

  const belief_correction = {
    tombstoned,
    prev_value_corrections,
    episodes,
  };

  const resultEnvelope = { meta, point_estimate, scaling_projection, belief_correction };

  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));

  console.log('\n' + '─'.repeat(60));
  console.log(`Results written -> ${OUT}`);
  console.log('─'.repeat(60) + '\n');
})();
