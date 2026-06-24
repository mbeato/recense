/**
 * COST-04 Progressive-Disclosure A/B Harness
 *
 * $0, LLM-free: SQLite reads (readonly) + spawned session-start-cli + char counting only.
 * No LLM/embedding/judge module is imported or invoked; never touches model APIs.
 *
 * Run:
 *   npm run build && node scripts/eval/42-progressive-disclosure-harness.cjs
 *   npm run build && node scripts/eval/42-progressive-disclosure-harness.cjs --db /tmp/nonexistent-recense.db
 *
 * Two challenger expansion policies (D-09 — bracket to avoid overclaiming):
 *   - oracle:      expand only the minimal hit set (best case — 1 node out of TOP_K)
 *   - fixed-top-K: expand all TOP_K hits (realistic case)
 *
 * Incumbent: recense's current one-shot bounded inject ("schema-prior compression") via
 * session-start-cli.
 *
 * A documented decline-with-numbers (verdict=incumbent-wins-decline-documented) is a valid,
 * expected outcome per D-10. Do NOT force a win; report the measured token deltas honestly.
 * No inflated metrics (CLAUDE.md hard rule).
 *
 * D-07 mechanism: fact-index → fact-detail (the literal claude-mem search→get_observations
 * mechanism as challenger vs recense's one-shot bounded inject as incumbent).
 * D-08 surface: MCP pull (challenger) vs SessionStart one-shot push (incumbent).
 * D-09 depth: harness-only A/B — no engine change, no MCP tool built here.
 */
'use strict';

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { execSync, spawnSync } = require('child_process');

// ---- arg parser (mirrors injection-efficiency-harness.cjs convention) --------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DB_PATH = arg('--db',    process.env['RECENSE_DB'] || path.join(os.homedir(), '.config', 'recense', 'recense.db'));
const CWD_ARG = arg('--cwd',  process.cwd());
const TOP_K   = parseInt(arg('--top-k', '5'), 10);
const OUT     = arg('--out',  'scripts/eval/results/42-progressive-disclosure-PENDING.json');

// ---- compiled engine modules (require npm run build first) ------------------
const Database        = require('better-sqlite3');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');

// ---- helpers ----------------------------------------------------------------

/** Char-based token proxy — same formula the session-start-cli char cap uses. */
function charsToTokens(chars) {
  return Math.round(chars / 4);
}

/** Print a section header. */
function header(title) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + title);
  console.log('─'.repeat(60));
}

/**
 * Build a one-line gloss from a node value.
 * First sentence, capped at ~60 chars (~15 tokens) — this is the thin-index step-1 payload.
 */
function gloss(value) {
  const first = value.split(/[.!?\n]/)[0].trim();
  return first.length > 60 ? first.slice(0, 60) + '…' : first;
}

// ---- main -------------------------------------------------------------------

(function main() {
  // Resolve git commit for results metadata
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

  let engine_version = 'unknown';
  try { engine_version = require('../../package.json').version; } catch {}

  const date = new Date().toISOString();

  console.log('\nCOST-04 Progressive-Disclosure A/B Harness');
  console.log('$0, LLM-free: SQLite reads + spawned session-start-cli + char counting');
  console.log(`DB:    ${DB_PATH}`);
  console.log(`CWD:   ${CWD_ARG}`);
  console.log(`TOP_K: ${TOP_K}`);
  console.log(`OUT:   ${OUT}`);

  // ── (0) Open DB readonly — graceful degrade if missing/unopenable ──────────
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    console.log(`\nno data: recense.db missing or unopenable at ${DB_PATH} — nothing to measure`);
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

  console.log(`\nLive nodes: ${n_live_nodes}`);

  // ── Prepare edge count query (1-hop neighborhood size proxy) ────────────────
  const edgeCountStmt = db.prepare('SELECT COUNT(*) AS n FROM edge WHERE src=? OR dst=?');

  // ────────────────────────────────────────────────────────────────────────────
  // (A) INCUMBENT ARM — real session-start-cli spawn (one-shot bounded inject)
  // ────────────────────────────────────────────────────────────────────────────
  header('(A) INCUMBENT  [recense one-shot bounded inject via session-start-cli]');

  const cliPath      = path.join(process.cwd(), 'dist', 'src', 'adapter', 'session-start-cli.js');
  const stdinPayload = JSON.stringify({ hookEventName: 'SessionStart', cwd: CWD_ARG });

  const spawnResult = spawnSync(
    process.execPath,
    [cliPath, '--db', DB_PATH],
    {
      input:    stdinPayload,
      encoding: 'utf8',
      timeout:  15_000,
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
    console.error('\nERROR: failed to parse session-start-cli stdout as JSON');
    console.error('stdout was:', spawnResult.stdout.slice(0, 200));
    db.close();
    process.exit(1);
  }

  const incumbent_tokens = charsToTokens(injectedText.length);

  console.log(`  Injected chars:  ${injectedText.length}`);
  console.log(`  Injected tokens: ${incumbent_tokens}  (chars/4 proxy)`);

  // ────────────────────────────────────────────────────────────────────────────
  // (B) CHALLENGER SIMULATION — two-step progressive disclosure from live DB
  //     No MCP call, no engine spawn — simulated from DB rows directly (D-09)
  // ────────────────────────────────────────────────────────────────────────────
  header('(B) CHALLENGER  [simulated two-step fact-index → fact-detail]');

  // Step 1: thin index — sample TOP_K * 4 nodes by recency, then pick the top TOP_K.
  // In a real system, step-1 returns compact hits from a semantic search.
  // Here we simulate with most-recently-accessed live nodes (LLM-free proxy).
  const oversampleRows = db.prepare(
    'SELECT id, value FROM node WHERE tombstoned=0 ORDER BY last_access DESC LIMIT ?'
  ).all(TOP_K * 4);

  const candidateRows = oversampleRows.slice(0, TOP_K);

  // Build thin-index payload (the step-1 MCP response the agent sees)
  const thinIndexLines = candidateRows.map(r => `[${r.id}] ${gloss(r.value)}`);
  const thinIndexText  = thinIndexLines.join('\n');
  const thin_tokens    = charsToTokens(thinIndexText.length);

  console.log(`  Step 1 (thin index): ${TOP_K} nodes × ~15 tok gloss = ${thin_tokens} tok`);
  for (const line of thinIndexLines) {
    console.log(`    ${line.slice(0, 80)}${line.length > 80 ? '…' : ''}`);
  }

  // Step 2: build detail payloads for each candidate
  // Detail = full node value + " [N neighbors]" count proxy (1-hop neighborhood size)
  const detailPayloads = candidateRows.map(r => {
    const hopCount = edgeCountStmt.get(r.id, r.id).n;
    return `${r.value} [${hopCount} neighbors]`;
  });
  const detailTokens = detailPayloads.map(d => charsToTokens(d.length));

  // Policy A — oracle: expand only 1 node (best-case: agent drills into exactly what it needs)
  // Rationale: oracle knows the answer is in the top hit; requests only that 1 detail.
  const oracle_expansion_tokens = detailTokens[0] || 0;
  const oracle_tokens           = thin_tokens + oracle_expansion_tokens;

  // Policy B — fixed-top-K: expand all TOP_K hits (realistic: agent expands everything retrieved)
  const topk_expansion_tokens = detailTokens.reduce((sum, t) => sum + t, 0);
  const topk_tokens           = thin_tokens + topk_expansion_tokens;

  console.log('\n  Step 2 (detail expansion):');
  console.log(`    Oracle  (1/${TOP_K} nodes): ${oracle_expansion_tokens} expansion tok -> total ${oracle_tokens} tok`);
  console.log(`    Fixed-${TOP_K} (all ${TOP_K} nodes): ${topk_expansion_tokens} expansion tok -> total ${topk_tokens} tok`);

  db.close();

  // ────────────────────────────────────────────────────────────────────────────
  // (C) A/B REDUCTION % + VERDICT
  // ────────────────────────────────────────────────────────────────────────────
  header('(C) REDUCTION % + VERDICT');

  // Positive reduction_pct = challenger uses fewer tokens = challenger wins.
  // Formula mirrors replay-ku-harness.cjs lines 993-996.
  const oracle_reduction_pct = incumbent_tokens > 0
    ? +(((incumbent_tokens - oracle_tokens) / incumbent_tokens) * 100).toFixed(2)
    : null;

  const topk_reduction_pct = incumbent_tokens > 0
    ? +(((incumbent_tokens - topk_tokens) / incumbent_tokens) * 100).toFixed(2)
    : null;

  // D-10: decline-with-numbers is a valid, expected outcome.
  // The realistic case (fixed-top-K) governs the adopt/decline call per D-09.
  let verdict;
  if (topk_reduction_pct !== null && topk_reduction_pct > 0) {
    verdict = 'challenger-wins-top-k';
  } else if (oracle_reduction_pct !== null && oracle_reduction_pct > 0) {
    verdict = 'challenger-wins-oracle';
  } else {
    verdict = 'incumbent-wins-decline-documented';
  }

  console.log(`  Incumbent tokens:           ${incumbent_tokens}`);
  console.log(`  Challenger oracle tokens:   ${oracle_tokens}  (reduction: ${oracle_reduction_pct !== null ? oracle_reduction_pct + '%' : 'n/a'})`);
  console.log(`  Challenger fixed-${TOP_K} tokens: ${topk_tokens}  (reduction: ${topk_reduction_pct !== null ? topk_reduction_pct + '%' : 'n/a'})`);
  console.log(`\n  VERDICT: ${verdict}`);

  if (verdict === 'incumbent-wins-decline-documented') {
    console.log(`  -> recense's bounded inject already wins (${incumbent_tokens} tok vs ${topk_tokens} tok fixed-top-K)`);
    console.log('     Progressive disclosure MCP tool deferred (D-10 documented decline)');
  } else if (verdict === 'challenger-wins-top-k') {
    console.log(`  -> Progressive disclosure wins on the realistic axis (${topk_reduction_pct}% reduction)`);
    console.log('     Consider building the real MCP memory_search + memory_expand tool (D-09)');
  } else {
    console.log(`  -> Challenger wins only on oracle best-case (${oracle_reduction_pct}%); fixed-top-K does not beat incumbent`);
    console.log('     Oracle win alone is insufficient for adopt decision (D-09); incumbent governs');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // (D) BUILD RESULT ENVELOPE
  // T-26-03: no API keys, credentials, or secrets in output
  // ────────────────────────────────────────────────────────────────────────────

  const resultEnvelope = {
    meta: {
      eval:            'progressive-disclosure',
      date,
      commit,
      engine_version,
      db_path:         DB_PATH,
      top_k:           TOP_K,
      n_live_nodes,
      // D-07: mechanism = fact-index → fact-detail vs one-shot bounded inject
      mechanism:       'fact-index-to-fact-detail',
      // D-08: MCP pull surface (challenger) vs SessionStart push surface (incumbent)
      surface:         'mcp-pull-challenger-vs-session-start-push-incumbent',
      // D-09: harness-only A/B — no engine change made
      prototype_depth: 'harness-only-ab',
    },
    // Incumbent = recense's schema-prior compression (one-shot bounded inject via session-start-cli)
    incumbent: {
      policy:  'one-shot-bounded-inject',
      tokens:  incumbent_tokens,
      source:  'session-start-cli',
    },
    // Challenger = progressive disclosure simulation, two bracket policies:
    //   oracle = expand only 1 node (best-case: agent drills into exactly the 1 fact it needs)
    //   top_k  = expand all TOP_K hits (realistic: agent expands all retrieved candidates)
    challenger: {
      oracle: {
        policy:            'oracle-expansion-1-of-top-k',
        thin_index_tokens: thin_tokens,
        expansion_tokens:  oracle_expansion_tokens,
        total_tokens:      oracle_tokens,
        reduction_pct:     oracle_reduction_pct,
      },
      top_k: {
        policy:            `fixed-top-${TOP_K}-expansion`,
        thin_index_tokens: thin_tokens,
        expansion_tokens:  topk_expansion_tokens,
        total_tokens:      topk_tokens,
        reduction_pct:     topk_reduction_pct,
      },
    },
    verdict,
    // T-26-03 guard: no credentials/API keys written
    caveats: [
      'Token counts use chars/4 proxy (EVAL-03 convention) — not a real tokenizer.',
      'Incumbent arm measured from real session-start-cli spawn (actual injected payload).',
      'Challenger arms are simulated from live DB node rows sorted by last_access DESC — no real MCP calls made.',
      `Oracle policy = expand only 1 of ${TOP_K} candidates (progressive disclosure best case; assumes agent needs exactly 1 detail).`,
      `Fixed-top-K policy = expand all ${TOP_K} candidates (realistic case; governs the adopt/decline call per D-09).`,
      'A documented decline (verdict=incumbent-wins-decline-documented) is a valid, expected outcome (D-10).',
      'Subscription marginal cost ≈ $0 (LLM-free harness; no paid API calls made).',
    ],
  };

  // Write results
  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));

  console.log('\n' + '─'.repeat(60));
  console.log(`Results written -> ${OUT}`);
  console.log('─'.repeat(60) + '\n');
})();
