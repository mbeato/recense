/**
 * EVAL-02 Correctness Harness — belief-correction (brain-memory) vs ADD-only baseline.
 *
 * Run:
 *   npm run build && node scripts/eval/correctness-harness.cjs --dry-run
 *   npm run build && ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node scripts/eval/correctness-harness.cjs
 *
 * Key requirements:
 *   - Always run `npm run build` before this script (requires compiled dist/ output).
 *   - --dry-run: runs the ADD-only baseline only (zero API/LLM calls), prints scorecard skeleton.
 *   - Real runs (no --dry-run): ingest->consolidate->ingest->consolidate->query on scratch DBs.
 *   - Every case uses a fresh scratch DB under os.tmpdir(); never inherits an existing DB path (T-14-DB).
 *   - Results JSON written to --out path with meta, scores, and per-case before/after trace.
 *
 * Gotchas:
 *   - runConsolidation() uses DefaultModelProvider internally — requires real ANTHROPIC_API_KEY +
 *     OPENAI_API_KEY. A missing key in real-run mode is caught early and exits non-zero.
 *   - OpenAIEmbedder for query probes (real runs only) also requires OPENAI_API_KEY.
 *   - Scratch DBs are cleaned up after each case (close + unlink); temp files under os.tmpdir().
 *   - corrected scoring uses case-insensitive substring match against expected_answer_hint —
 *     an approximation since node values are extracted claims, not verbatim episode text.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ---- arg parser (mirrors judge-eval-runner.cjs convention) ------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DRY_RUN   = process.argv.includes('--dry-run');
const CASES_PATH = arg('--cases', 'scripts/eval/cases/correctness-cases.json');
const OUT        = arg('--out',   'scripts/eval/results/correctness-PENDING.json');

// ---- compiled engine modules (require npm run build first) ------------------
// Failing requires here means `npm run build` hasn't been run yet.
const Database                = require('better-sqlite3');
const { initSchema }          = require('../../dist/src/db/schema');
const { DEFAULT_CONFIG }      = require('../../dist/src/lib/config');
const { realClock }           = require('../../dist/src/lib/clock');
const { EpisodicStore }       = require('../../dist/src/db/episode-store');
const { SemanticStore }       = require('../../dist/src/db/semantic-store');
const { StrengthDecayManager } = require('../../dist/src/strength/decay');
const { CandidateRetriever }  = require('../../dist/src/retrieval/topk');
const { AllocationGate }      = require('../../dist/src/gate/allocation-gate');
const { RetrievalEngine }     = require('../../dist/src/retrieval/engine');
const { NoopActivationTraceSink } = require('../../dist/src/viz/activation-sink');
// runConsolidation and OpenAIEmbedder are only invoked in non-dry-run paths
const { runConsolidation }    = require('../../dist/src/consolidation/run-sleep-pass');
const { OpenAIEmbedder }      = require('../../dist/src/model/embedder');

// ---- API key guard (real runs only) -----------------------------------------
if (!DRY_RUN) {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    console.error(`\nERROR: missing API keys for a real run: ${missing.join(', ')}`);
    console.error('Pass --dry-run to run the ADD-only baseline with zero API calls.');
    process.exit(1);
  }
}

// ---- helpers ----------------------------------------------------------------

/**
 * Build a fresh scratch DB in os.tmpdir() — named brain-eval-<pid>-<ts>.db.
 * Never inherits an existing DB path from env — always builds a fresh os.tmpdir() path (T-14-DB).
 * Returns { db, dbPath, episodes, config, cleanup }.
 */
function makeScratchDb() {
  const dbPath = path.join(os.tmpdir(), `brain-eval-${process.pid}-${Date.now()}.db`);
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, realClock, config);
  return {
    db,
    dbPath,
    episodes,
    config,
    cleanup() {
      try { db.close(); }  catch { /* best-effort */ }
      try { fs.unlinkSync(dbPath); } catch { /* best-effort */ }
    },
  };
}

/**
 * ADD-only baseline: append initial_fact + contradicting_fact as episodes with NO
 * consolidation. Always stale for contradiction cases; no tombstones; duplicate_count
 * equals the episode row count for these sessions.
 */
function runAddOnlyCase(c) {
  const { db, episodes, cleanup } = makeScratchDb();
  try {
    const s1 = `case-${c.case_id}-s1`;
    const s2 = `case-${c.case_id}-s2`;

    episodes.append({
      content: c.initial_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: s1,
    });
    episodes.append({
      content: c.contradicting_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: s2,
    });

    const dupCount = db
      .prepare('SELECT COUNT(*) AS n FROM episode WHERE session_id IN (?, ?)')
      .get(s1, s2).n;

    return {
      case_id: c.case_id,
      expected_relation: c.expected_relation,
      system: 'add-only',
      corrected: false,
      stale: c.expected_relation === 'contradict', // old fact always persists; no correction
      tombstone_present: false,
      duplicate_count: dupCount,
      trace: {
        stored_belief: c.initial_fact,
        contradicting_input: c.contradicting_fact,
        now_believes: `[${dupCount} episode rows stored with no graph consolidation]`,
      },
    };
  } finally {
    cleanup();
  }
}

/**
 * brain-memory path: ingest initial_fact -> runConsolidation -> ingest contradicting_fact
 * -> runConsolidation -> embed query_probe -> RetrievalEngine.retrieve(queryVec).
 *
 * Scoring:
 *   corrected         — any live node value contains expected_answer_hint (case-insensitive)
 *   stale             — contradiction case, no corrected result, but ≥1 node returned
 *   tombstone_present — any tombstoned node in the scratch DB after consolidation
 *   duplicate_count   — count of live (non-tombstoned) nodes in the DB
 */
async function runBrainMemoryCase(c, env) {
  const { db, dbPath, episodes, config, cleanup } = makeScratchDb();
  try {
    const s1 = `case-${c.case_id}-s1`;
    const s2 = `case-${c.case_id}-s2`;

    // ── Pass 1: ingest initial fact + consolidate ─────────────────────────────
    episodes.append({
      content: c.initial_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: s1,
    });
    await runConsolidation(db, dbPath, env, () => {});

    // ── Pass 2: ingest contradicting fact + consolidate ───────────────────────
    episodes.append({
      content: c.contradicting_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: s2,
    });
    await runConsolidation(db, dbPath, env, () => {});

    // ── Retrieve: embed query_probe then use RetrievalEngine ──────────────────
    const embedder = new OpenAIEmbedder(config.openaiEmbedModel, config.embeddingDimensions);
    const [queryVec] = await embedder.embed([c.query_probe]);

    const retriever  = new CandidateRetriever(db);
    const store      = new SemanticStore(db, realClock, config);
    const strength   = new StrengthDecayManager(db, realClock, config);
    const gate       = new AllocationGate(config);
    const traceSink  = new NoopActivationTraceSink();
    const engine     = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate, traceSink);

    const { results } = engine.retrieve(queryVec);

    // ── Score ─────────────────────────────────────────────────────────────────
    const hintLower = c.expected_answer_hint.toLowerCase();
    const corrected = results.some(r => r.value.toLowerCase().includes(hintLower));
    // stale: contradiction case where old value wasn't replaced (expected hint absent)
    const stale = c.expected_relation === 'contradict' && !corrected && results.length > 0;

    const tombCount = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned = 1').get().n;
    const tombstone_present = tombCount > 0;

    const dupCount = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned = 0').get().n;

    const topBelief = results.length > 0 ? results[0].value : '[no result returned]';

    return {
      case_id: c.case_id,
      expected_relation: c.expected_relation,
      system: 'brain-memory',
      corrected,
      stale,
      tombstone_present,
      duplicate_count: dupCount,
      trace: {
        stored_belief: c.initial_fact,
        contradicting_input: c.contradicting_fact,
        now_believes: topBelief,
      },
    };
  } finally {
    cleanup();
  }
}

// ---- scorecard rendering ----------------------------------------------------

function renderRow(r) {
  let result;
  if (r.system === 'brain-memory') {
    result = r.corrected ? 'CORRECTED   ' : r.stale ? 'STALE       ' : 'UNCHANGED   ';
  } else {
    result = `${r.duplicate_count} dupes     `.slice(0, 12);
  }
  const tomb = r.tombstone_present ? 'YES' : 'no ';
  return `  ${String(r.case_id).padStart(3)} | ${r.expected_relation.padEnd(11)} | ${r.system.padEnd(12)} | ${result} | tomb=${tomb}`;
}

function aggregate(rows) {
  const n = rows.length;
  const contraRows = rows.filter(r => r.expected_relation === 'contradict');
  const corrected  = contraRows.filter(r => r.corrected).length;
  const stale      = contraRows.filter(r => r.stale).length;
  const avgDup     = n > 0 ? rows.reduce((s, r) => s + (r.duplicate_count || 0), 0) / n : 0;
  const tombRate   = n > 0 ? rows.filter(r => r.tombstone_present).length / n : 0;
  return {
    n,
    contradiction_cases: contraRows.length,
    belief_correction_rate: contraRows.length ? +(corrected / contraRows.length).toFixed(3) : null,
    stale_recall_rate:      contraRows.length ? +(stale / contraRows.length).toFixed(3)     : null,
    avg_duplicate_count:    +avgDup.toFixed(2),
    tombstone_rate:         +tombRate.toFixed(3),
  };
}

// ---- main -------------------------------------------------------------------

(async () => {
  const cases       = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const total       = cases.length;
  const contraCount = cases.filter(c => c.expected_relation === 'contradict').length;
  const ctrlCount   = total - contraCount;

  // Resolve current git commit for results metadata
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

  console.log('\nEVAL-02 Correctness Harness');
  console.log(`Cases: ${total} total (${contraCount} contradiction, ${ctrlCount} control)`);
  console.log(DRY_RUN
    ? 'Mode: --dry-run (ADD-only baseline, zero API calls)\n'
    : 'Mode: full run (brain-memory + ADD-only, real API keys)\n');

  const brainMemoryRows = [];
  const addOnlyRows     = [];

  console.log('  case | relation    | system       | result       | tombstone');
  console.log('  ---- | ----------- | ------------ | ------------ | ---------');

  for (const c of cases) {
    // ADD-only runs in all modes (zero API calls)
    const addResult = runAddOnlyCase(c);
    addOnlyRows.push(addResult);
    console.log(renderRow(addResult));

    if (!DRY_RUN) {
      process.stdout.write(`  ... running brain-memory case ${c.case_id}...\r`);
      const bmResult = await runBrainMemoryCase(c, process.env);
      brainMemoryRows.push(bmResult);
      console.log(renderRow(bmResult));
    }
  }

  // Aggregate scores
  const addOnlyScore    = aggregate(addOnlyRows);
  const brainMemoryScore = DRY_RUN ? null : aggregate(brainMemoryRows);

  console.log('\n=== SCORECARD ===');
  function printScore(label, s) {
    console.log(`\n${label}:`);
    console.log(`  Contradiction cases:    ${s.contradiction_cases}`);
    console.log(`  Belief-correction rate: ${s.belief_correction_rate === null ? 'n/a' : (s.belief_correction_rate * 100).toFixed(1) + '%'}`);
    console.log(`  Stale-recall rate:      ${s.stale_recall_rate === null ? 'n/a' : (s.stale_recall_rate * 100).toFixed(1) + '%'}`);
    console.log(`  Avg duplicate count:    ${s.avg_duplicate_count}`);
    console.log(`  Tombstone rate:         ${(s.tombstone_rate * 100).toFixed(1)}%`);
  }

  printScore('ADD-only baseline (no consolidation)', addOnlyScore);
  if (brainMemoryScore) printScore('brain-memory (PE-gated reconsolidation)', brainMemoryScore);

  // Build and write results envelope
  const meta = {
    eval: 'correctness',
    date: new Date().toISOString(),
    commit,
    engine_version: require('../../package.json').version,
    cases_total: total,
    cases_contradiction: contraCount,
    cases_control: ctrlCount,
    dry_run: DRY_RUN,
  };

  const resultEnvelope = {
    meta,
    scores: {
      brain_memory:      brainMemoryScore,
      add_only_baseline: addOnlyScore,
    },
    per_case: [
      ...addOnlyRows,
      ...brainMemoryRows,
    ].sort((a, b) => a.case_id - b.case_id || a.system.localeCompare(b.system)),
  };

  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));
  console.log(`\nResults written -> ${OUT}`);
})();
