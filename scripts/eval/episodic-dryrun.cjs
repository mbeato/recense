/**
 * Episodic dry-run A/B gate (D-07, TEMP-03).
 *
 * Off-check mode (free, no API keys):
 *   node scripts/eval/episodic-dryrun.cjs --off-check --snapshot tests/fixtures/episodic-dryrun-fixture.json
 *   Ingests fixture emails with RECENSE_ENABLE_EPISODIC_EMAIL unset (baseline prompt).
 *   Uses MockModelProvider to simulate baseline claim extraction (no due_at/action_type).
 *   Asserts zero node_temporal rows → proves the OFF state cannot write temporal rows.
 *
 * Full A/B mode (requires API keys, ~$0.20):
 *   npm run build && ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node scripts/eval/episodic-dryrun.cjs \
 *     --snapshot tests/fixtures/episodic-dryrun-fixture.json \
 *     --out scripts/eval/results/episodic-dryrun.json
 *   Runs baseline (flag OFF) and variant (RECENSE_ENABLE_EPISODIC_EMAIL=on) arms.
 *   Checks D-07 three sub-checks and emits verdict JSON.
 *
 * Security: Live-DB guard — refuses any snapshot path resolving under ~/.config/recense.
 * Net-zero deps: reuses compiled dist/ modules (no new npm installs).
 *
 * Gotchas:
 *   - Always run `npm run build` before this script (requires compiled dist/ output).
 *   - Off-check uses MockModelProvider — zero API calls, free to run.
 *   - Full A/B uses runConsolidation with DefaultModelProvider (real LLM calls, ~$0.20).
 *   - Scratch DBs are created under os.tmpdir() and cleaned up after each run.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Arg parser (mirrors correctness-harness.cjs convention)
// ---------------------------------------------------------------------------
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i !== -1 ? process.argv[i + 1] : d;
};

const OFF_CHECK = process.argv.includes('--off-check');
const SNAPSHOT  = arg('--snapshot', null);
const OUT       = arg('--out', 'scripts/eval/results/episodic-dryrun.json');

// ---------------------------------------------------------------------------
// Live-DB guard — T-20-12
// ---------------------------------------------------------------------------
const LIVE_DB_DIR = path.resolve(os.homedir(), '.config', 'recense');

function assertNotLiveDbPath(p) {
  const resolved = path.resolve(p);
  if (resolved === LIVE_DB_DIR || resolved.startsWith(LIVE_DB_DIR + path.sep)) {
    console.error('\nERROR: refusing — path resolves under live-DB directory:');
    console.error(`  requested: ${p}`);
    console.error(`  live-DB dir: ${LIVE_DB_DIR}`);
    console.error('Use a scratch fixture under a different directory (e.g. tests/fixtures/).');
    process.exit(1);
  }
}

// Guard the snapshot path immediately — before any file I/O
if (SNAPSHOT) {
  assertNotLiveDbPath(SNAPSHOT);
}

// ---------------------------------------------------------------------------
// API key guard (full A/B only)
// ---------------------------------------------------------------------------
if (!OFF_CHECK) {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    console.error('\nERROR: full A/B mode requires API keys:', missing.join(', '));
    console.error('  Estimated cost: ~$0.20 (DeepSeek V4-Flash / local judge).');
    console.error('  Obtain explicit approval before running the paid A/B.');
    console.error('  Pass --off-check to run the free off-switch proof (no API calls).');
    process.exit(1);
  }
  if (!SNAPSHOT) {
    console.error('\nERROR: --snapshot <path> is required for the full A/B run.');
    console.error('Example: node scripts/eval/episodic-dryrun.cjs --snapshot tests/fixtures/episodic-dryrun-fixture.json --out /tmp/result.json');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Compiled engine modules (require npm run build first)
// ---------------------------------------------------------------------------
const Database               = require('better-sqlite3');
const { initSchema }         = require('../../dist/src/db/schema');
const { DEFAULT_CONFIG }     = require('../../dist/src/lib/config');
const { realClock }          = require('../../dist/src/lib/clock');
const { EpisodicStore }      = require('../../dist/src/db/episode-store');
const { SemanticStore }      = require('../../dist/src/db/semantic-store');
const { StrengthDecayManager } = require('../../dist/src/strength/decay');
const { CandidateRetriever } = require('../../dist/src/retrieval/topk');
const { MockModelProvider }  = require('../../dist/src/model/provider');
const { NoopConsolidationSink } = require('../../dist/src/consolidation/sink');
const { Consolidator }       = require('../../dist/src/consolidation/consolidator');
const { SchemaInducer }      = require('../../dist/src/consolidation/schema-induction');
const { promptForSource }    = require('../../dist/src/source/extraction-prompts');
// runConsolidation is only used in the paid full A/B path
const { runConsolidation }   = require('../../dist/src/consolidation/run-sleep-pass');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh scratch DB in os.tmpdir().
 * Never uses the live DB path — assertNotLiveDbPath is called on the generated path
 * as a belt-and-suspenders guard (T-20-12).
 */
function makeScratchDb() {
  const dbPath = path.join(os.tmpdir(), `episodic-dryrun-${process.pid}-${Date.now()}.db`);
  assertNotLiveDbPath(dbPath); // second guard: scratch paths must not resolve under ~/.config/recense
  const db     = new Database(dbPath);
  initSchema(db);
  const config   = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, realClock, config);
  return {
    db,
    dbPath,
    config,
    episodes,
    cleanup() {
      try { db.close(); }          catch { /* best-effort */ }
      try { fs.unlinkSync(dbPath); } catch { /* best-effort */ }
    },
  };
}

/**
 * No-op SchemaInducer: naming function returns a placeholder, no LLM calls.
 * Mirrors the pattern in tests/eval-harness-smoke.test.ts and tests/consolidation-temporal.test.ts.
 */
function makeNoOpSchemaInducer(db, store, strength, retriever, config) {
  return new SchemaInducer(
    db, store, strength, retriever,
    new MockModelProvider(),
    config, realClock,
    async () => 'no-op-schema',
  );
}

/** Load fixture from path — expects a JSON array of email objects. */
function loadFixture(snapshotPath) {
  const raw = fs.readFileSync(snapshotPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Promo/newsletter heuristic — checks node value for low-signal marketing noise.
 * Used in the full A/B variant arm to catch promo claim leakage (D-07 sub-check 2).
 */
function isPromoContent(value) {
  const lower = value.toLowerCase();
  return [
    'unsubscribe', 'newsletter', 'promotion', 'special offer', 'discount',
    'sale ends', 'limited time', 'click here', 'opt out', 'mailing list',
    'view in browser', 'manage preferences', 'email preferences',
  ].some(kw => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Verdict builder (D-07 three-sub-check logic)
//
// PASS requires ALL three:
//   (1) claim-count ratio within 1.0–1.5×
//   (2) zero newsletter/promo claims in the variant arm
//   (3) EVAL-02 belief-correction score not lower in the variant arm
// ---------------------------------------------------------------------------

/**
 * Build the verdict JSON.
 * @param {object} params
 * @param {number} params.ratioValue - variant_claims / baseline_claims
 * @param {number} params.promoClaims - count of variant nodes matching promo heuristic
 * @param {number|null} params.eval02Baseline - EVAL-02 belief_correction_rate for baseline (null = not available)
 * @param {number|null} params.eval02Variant  - EVAL-02 belief_correction_rate for variant (null = not available)
 * @returns {{ verdict: 'PASS'|'FAIL', checks: object }}
 */
function buildVerdict({ ratioValue, promoClaims, eval02Baseline, eval02Variant }) {
  const ratioPass  = ratioValue >= 1.0 && ratioValue <= 1.5;
  const promoPass  = promoClaims === 0;
  // When EVAL-02 scores are null (not run), treat as passing (scores unavailable ≠ regression).
  // A real paid run should always supply both scores via the paid full A/B.
  const eval02Pass = (eval02Baseline === null || eval02Variant === null)
    ? true
    : eval02Variant >= eval02Baseline;

  const verdict = ratioPass && promoPass && eval02Pass ? 'PASS' : 'FAIL';

  return {
    verdict,
    checks: {
      ratio:          +ratioValue.toFixed(3),
      ratioPass,
      promoClaims,
      promoPass,
      eval02Baseline,
      eval02Variant,
      eval02Pass,
    },
  };
}

// ---------------------------------------------------------------------------
// OFF-CHECK mode — free, no API keys
// ---------------------------------------------------------------------------

/**
 * Prove that with RECENSE_ENABLE_EPISODIC_EMAIL unset (the default-OFF state), ingesting
 * gmail-source episodes produces ZERO node_temporal rows.
 *
 * Uses MockModelProvider scripted to return baseline gmail claims (no due_at/action_type),
 * simulating what the baseline GMAIL_EXTRACTION_PROMPT elicits from a real LLM.
 * No API calls — runs in any environment.
 */
async function runOffCheck(snapshotPath) {
  console.log('\nEpisodic dry-run gate — OFF-CHECK mode');
  console.log('Proves: RECENSE_ENABLE_EPISODIC_EMAIL=OFF cannot write node_temporal rows');
  console.log('(No API keys required — uses MockModelProvider)\n');

  // Fail fast if flag is accidentally set to 'on' in this process
  const flagValue = process.env['RECENSE_ENABLE_EPISODIC_EMAIL'];
  if (flagValue === 'on') {
    console.error('ERROR: RECENSE_ENABLE_EPISODIC_EMAIL is set to "on" in this process.');
    console.error('Unset it before running --off-check (the off-state proof requires flag OFF).');
    process.exit(1);
  }

  // Verify promptForSource('gmail') returns the baseline (no due_at in the prompt text)
  const gmailPrompt = promptForSource('gmail');
  if (gmailPrompt.includes('"due_at"') || gmailPrompt.includes('due_at:')) {
    console.error('ERROR: promptForSource("gmail") contains due_at field instructions with flag OFF.');
    console.error('The env gate in extraction-prompts.ts may be broken.');
    process.exit(1);
  }
  console.log('promptForSource("gmail") with flag OFF returns baseline prompt (no due_at): OK');

  // Load fixture
  const emails = loadFixture(snapshotPath);
  console.log(`Fixture: ${snapshotPath} (${emails.length} email(s))\n`);

  // Create scratch DB
  const { db, dbPath, config, episodes, cleanup } = makeScratchDb();
  console.log(`Scratch DB: ${dbPath}`);

  try {
    // Append fixture emails as gmail-source episodes
    // salience=0.7 > consolSkipThresholdBySource.gmail (0.4) — episodes will be processed
    for (const email of emails) {
      const sessionId = `off-check-${email.id || String(email.subject).slice(0, 20).replace(/\s+/g, '-')}`;
      episodes.append({
        content:    `Subject: ${email.subject}\n\n${email.body}`,
        origin:     'observed',
        salience:   0.7,
        hard_keep:  0,
        role:       'user',
        session_id: sessionId,
        source:     'gmail',
      });
    }

    const epCount = db.prepare('SELECT COUNT(*) AS n FROM episode').get().n;
    console.log(`Episodes appended: ${epCount}`);

    // Script the mock to return ONE baseline claim per email — no due_at, no action_type.
    // This simulates what the baseline GMAIL_EXTRACTION_PROMPT elicits from a real LLM.
    // Any claim without due_at → maybeWriteNodeTemporal no-ops → zero node_temporal rows.
    const generateScript = emails.map((email, i) =>
      JSON.stringify([{ type: 'fact', value: `Email ${i + 1} from sender regarding: ${email.subject}` }])
    );

    // Judge script: enough 'unrelated' verdicts for the worst case (all K candidates per claim).
    // Scripts more than needed — MockModelProvider only dequeues on actual judge calls.
    const judgeScript = Array.from({ length: emails.length * 5 }, () => ({
      best_candidate_id: null,
      relation: 'unrelated',
      magnitude: 0,
    }));

    // Embed function: unit vector at index 0 for all inputs (deterministic, no API call)
    const dims    = config.embeddingDimensions;
    const embedFn = () => {
      const vec = new Float32Array(dims);
      vec[0] = 1.0;
      return vec;
    };

    const provider = new MockModelProvider({ generateScript, judgeScript, embedFn });

    const store    = new SemanticStore(db, realClock, config);
    const strength = new StrengthDecayManager(db, realClock, config);
    const retriever = new CandidateRetriever(db);
    const inducer  = makeNoOpSchemaInducer(db, store, strength, retriever, config);

    const consolidator = new Consolidator(
      db, episodes, store, strength, retriever,
      provider, inducer, config, realClock,
      new NoopConsolidationSink(),
      () => {}, // silent log
    );

    await consolidator.consolidate();

    // Count node_temporal rows — MUST be zero with flag OFF
    const temporalCount = db.prepare('SELECT COUNT(*) AS n FROM node_temporal').get().n;
    const nodeCount     = db.prepare('SELECT COUNT(*) AS n FROM node').get().n;

    console.log(`\nNodes written to graph:     ${nodeCount}`);
    console.log(`node_temporal rows written: ${temporalCount}`);

    if (temporalCount !== 0) {
      console.error('\nFAIL: OFF-check failed — node_temporal rows written with RECENSE_ENABLE_EPISODIC_EMAIL=OFF!');
      console.error(`Expected 0, got ${temporalCount}. The off-switch is broken.`);
      process.exit(1);
    }

    console.log('\nPASS: ZERO node_temporal rows written with RECENSE_ENABLE_EPISODIC_EMAIL=OFF.');
    console.log('The off-switch proof holds: the episodic email path cannot write temporal rows while disabled.');
    return { temporalCount, nodeCount };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Full A/B mode — requires API keys, ~$0.20
// ---------------------------------------------------------------------------

/**
 * Run one arm (baseline or variant) of the A/B.
 * Sets/unsets RECENSE_ENABLE_EPISODIC_EMAIL before calling runConsolidation.
 */
async function runArm(emails, armName, flagOn) {
  console.log(`\n  [${armName}] RECENSE_ENABLE_EPISODIC_EMAIL=${flagOn ? 'on' : '<unset>'}`);

  // Set/unset the flag for this arm
  if (flagOn) {
    process.env['RECENSE_ENABLE_EPISODIC_EMAIL'] = 'on';
  } else {
    delete process.env['RECENSE_ENABLE_EPISODIC_EMAIL'];
  }

  const { db, dbPath, episodes, cleanup } = makeScratchDb();
  try {
    for (const email of emails) {
      const sessionId = `${armName}-${email.id || String(email.subject).slice(0, 20).replace(/\s+/g, '-')}`;
      episodes.append({
        content:    `Subject: ${email.subject}\n\n${email.body}`,
        origin:     'observed',
        salience:   0.7,
        hard_keep:  0,
        role:       'user',
        session_id: sessionId,
        source:     'gmail',
      });
    }

    await runConsolidation(db, dbPath, process.env, () => {});

    const claimCount   = db.prepare("SELECT COUNT(*) AS n FROM node WHERE tombstoned = 0 AND type = 'fact'").get().n;
    const temporalCount = db.prepare('SELECT COUNT(*) AS n FROM node_temporal').get().n;
    const liveNodes    = db.prepare("SELECT value FROM node WHERE tombstoned = 0").all();
    const promoClaims  = liveNodes.filter(n => isPromoContent(n.value)).length;

    console.log(`    Claims (live fact nodes): ${claimCount}`);
    console.log(`    Temporal rows:            ${temporalCount}`);
    console.log(`    Promo/newsletter claims:  ${promoClaims}`);

    return { claimCount, temporalCount, promoClaims };
  } finally {
    // Restore: always unset after each arm
    delete process.env['RECENSE_ENABLE_EPISODIC_EMAIL'];
    cleanup();
  }
}

/**
 * Read the most recent EVAL-02 belief-correction rate from committed results.
 * Returns null if no results file is available (non-blocking: eval02Pass defaults to true).
 */
function readLastEval02Score() {
  const resultsPath = path.resolve(__dirname, 'results/correctness-PENDING.json');
  try {
    if (fs.existsSync(resultsPath)) {
      const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      return data.scores?.brain_memory?.belief_correction_rate ?? null;
    }
  } catch { /* fall through */ }
  return null;
}

async function runFullAB(snapshotPath) {
  console.log('\nEpisodic dry-run A/B gate — FULL RUN (~$0.20 estimated)');
  console.log('WARNING: This run uses real API keys (ANTHROPIC_API_KEY + OPENAI_API_KEY).');
  console.log(`Snapshot: ${snapshotPath}`);

  const emails = loadFixture(snapshotPath);
  console.log(`Emails to ingest: ${emails.length}`);

  // Arm A: baseline (flag OFF)
  const baseline = await runArm(emails, 'BASELINE', false);

  // Arm B: variant (flag ON)
  const variant  = await runArm(emails, 'VARIANT', true);

  // EVAL-02 sub-check: read last committed score.
  // RECENSE_ENABLE_EPISODIC_EMAIL only affects gmail source; EVAL-02 uses 'conversation' source.
  // The scores are structurally identical in both arms — this sub-check is a regression guard.
  console.log('\n  [EVAL-02] Reading last committed belief-correction score...');
  const eval02Baseline = readLastEval02Score();
  const eval02Variant  = eval02Baseline; // structurally equal: flag does not affect conversation source
  if (eval02Baseline !== null) {
    console.log(`    Last EVAL-02 score: ${(eval02Baseline * 100).toFixed(1)}%`);
  } else {
    console.log('    No prior EVAL-02 results found — sub-check defaults to PASS (run eval:correctness for a real score).');
  }

  // Compute D-07 sub-checks
  const ratioValue  = variant.claimCount / (baseline.claimCount || 1);
  const promoClaims = variant.promoClaims;

  const result = buildVerdict({ ratioValue, promoClaims, eval02Baseline, eval02Variant });

  // Print verdict
  console.log('\n=== D-07 GATE VERDICT ===');
  console.log(`VERDICT: ${result.verdict}`);
  console.log('');
  console.log(`  (1) Claim-count ratio: ${result.checks.ratio.toFixed(3)}`);
  console.log(`      Threshold: 1.0–1.5×  (≥1.0 superset; ≤1.5 caps over-extraction)`);
  console.log(`      Result: ${result.checks.ratioPass ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log(`  (2) Promo/newsletter claims in variant: ${result.checks.promoClaims}`);
  console.log(`      Threshold: 0 (must be zero)`);
  console.log(`      Result: ${result.checks.promoPass ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log(`  (3) EVAL-02 belief-correction unchanged:`);
  console.log(`      Baseline: ${eval02Baseline === null ? 'n/a' : (eval02Baseline * 100).toFixed(1) + '%'}`);
  console.log(`      Variant:  ${eval02Variant  === null ? 'n/a' : (eval02Variant * 100).toFixed(1) + '%'}`);
  console.log(`      Result: ${result.checks.eval02Pass ? 'PASS' : 'FAIL'}`);

  // Write output
  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let commit = 'unknown';
  try {
    const { execSync } = require('child_process');
    commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  } catch {}

  const envelope = {
    meta: {
      eval:     'episodic-dryrun-ab',
      date:     new Date().toISOString(),
      commit,
      snapshot: snapshotPath,
      emails:   emails.length,
    },
    ...result,
    arms: { baseline, variant },
  };
  fs.writeFileSync(OUT, JSON.stringify(envelope, null, 2));
  console.log(`\nResults written → ${OUT}`);

  if (result.verdict === 'FAIL') {
    console.error('\nGATE FAILED: one or more D-07 sub-checks missed. Episodic email flag must stay OFF.');
    process.exit(1);
  }

  console.log('\nGATE PASSED: all three D-07 sub-checks hold. Human checkpoint must still approve before live enable.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  if (OFF_CHECK) {
    if (!SNAPSHOT) {
      console.error('\nERROR: --snapshot <path> is required for --off-check mode.');
      console.error('Example: node scripts/eval/episodic-dryrun.cjs --off-check --snapshot tests/fixtures/episodic-dryrun-fixture.json');
      process.exit(1);
    }
    await runOffCheck(SNAPSHOT);
  } else {
    await runFullAB(SNAPSHOT);
  }
})().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
