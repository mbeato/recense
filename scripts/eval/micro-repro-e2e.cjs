/**
 * Minimal end-to-end reproduction for cases 4, 5, 11, 12.
 * Uses REAL granite extraction + REAL judge (no replay).
 * Mirrors correctness-harness.cjs runBrainMemoryCase() exactly.
 *
 * Run:
 *   OPENAI_API_KEY=... RECENSE_EXTRACTOR_PROVIDER=local \
 *   RECENSE_EXTRACTOR_LOCAL_MODEL=granite4.1:8b \
 *   RECENSE_JUDGE_PROVIDER=local RECENSE_JUDGE_LOCAL_MODEL=qwen3.6:35b-a3b \
 *   node scripts/eval/micro-repro-e2e.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3');
const { initSchema } = require('../../dist/src/db/schema');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');
const { realClock } = require('../../dist/src/lib/clock');
const { EpisodicStore } = require('../../dist/src/db/episode-store');
const { runConsolidation } = require('../../dist/src/consolidation/run-sleep-pass');
const { CandidateRetriever } = require('../../dist/src/retrieval/topk');
const { SemanticStore } = require('../../dist/src/db/semantic-store');
const { StrengthDecayManager } = require('../../dist/src/strength/decay');
const { AllocationGate } = require('../../dist/src/gate/allocation-gate');
const { RetrievalEngine } = require('../../dist/src/retrieval/engine');
const { NoopActivationTraceSink } = require('../../dist/src/viz/activation-sink');
const { OpenAIEmbedder } = require('../../dist/src/model/embedder');

if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY required');
  process.exit(1);
}

const correctnessCases = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'cases/correctness-cases.json'), 'utf8'
));

function getCase(caseId) {
  return correctnessCases.find(c => c.case_id === caseId);
}

function makeScratchDb() {
  const dbPath = path.join(os.tmpdir(), `brain-e2e-${process.pid}-${Date.now()}.db`);
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, realClock, config);
  return {
    db, dbPath, config, episodes,
    cleanup() {
      try { db.close(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
    },
  };
}

async function runCase(caseId) {
  const c = getCase(caseId);
  if (!c) return;

  const { db, dbPath, config, episodes, cleanup } = makeScratchDb();
  try {
    const s1 = `case-${caseId}-s1`;
    const s2 = `case-${caseId}-s2`;

    const env = process.env;

    // Pass 1
    episodes.append({
      content: c.initial_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: s1,
      source: 'conversation',
    });

    // Log what gets extracted in pass 1
    const nodes_before_pass1 = db.prepare('SELECT type, value FROM node WHERE tombstoned = 0').all();
    await runConsolidation(db, dbPath, env, msg => console.log(`  [LOG] ${msg}`));
    const nodes_after_pass1 = db.prepare('SELECT type, value, tombstoned FROM node ORDER BY rowid').all();
    console.log(`  Pass 1 graph:`);
    for (const n of nodes_after_pass1) {
      console.log(`    [${n.tombstoned ? 'TOMB' : 'LIVE'}] (${n.type}) "${n.value}"`);
    }

    // Pass 2
    episodes.append({
      content: c.contradicting_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: s2,
      source: 'conversation',
    });

    await runConsolidation(db, dbPath, env, msg => console.log(`  [LOG] ${msg}`));
    const nodes_after_pass2 = db.prepare('SELECT type, value, tombstoned FROM node ORDER BY rowid').all();
    console.log(`  Pass 2 graph:`);
    for (const n of nodes_after_pass2) {
      console.log(`    [${n.tombstoned ? 'TOMB' : 'LIVE'}] (${n.type}) "${n.value}"`);
    }

    // Query
    const embedder = new OpenAIEmbedder(config.openaiEmbedModel, config.embeddingDimensions);
    const [queryVec] = await embedder.embed([c.query_probe]);
    const retriever = new CandidateRetriever(db);
    const store = new SemanticStore(db, realClock, config);
    const strength = new StrengthDecayManager(db, realClock, config);
    const gate = new AllocationGate(config);
    const traceSink = new NoopActivationTraceSink();
    const engine = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate, traceSink);
    const results = engine.retrieveRanked(queryVec, config.rankedRetrievalK, config.rankedRetrievalFloor);

    const tombCount = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned = 1').get().n;
    const liveFactCount = db.prepare("SELECT COUNT(*) AS n FROM node WHERE tombstoned = 0 AND type = 'fact'").get().n;
    const topBelief = results.length > 0 ? results[0].value : '[no result]';
    const hintLower = c.expected_answer_hint.toLowerCase();
    const corrected = results.some(r => r.value.toLowerCase().includes(hintLower));

    console.log(`  Tombstones: ${tombCount}, Live facts: ${liveFactCount}`);
    console.log(`  Now believes: "${topBelief}"`);
    console.log(`  Expected hint: "${c.expected_answer_hint}"`);
    console.log(`  → ${corrected ? '✓ CORRECTED' : '✗ STILL STALE'}`);

    return { caseId, corrected, tombstones: tombCount };
  } finally {
    cleanup();
  }
}

async function main() {
  console.log('\n=== E2E repro: real granite4.1:8b extraction + real judge ===\n');
  console.log(`Extractor: ${process.env.RECENSE_EXTRACTOR_LOCAL_MODEL || 'default'}`);
  console.log(`Judge: ${process.env.RECENSE_JUDGE_LOCAL_MODEL || 'default'}`);

  const targetCases = [4, 5, 11, 12];

  for (const caseId of targetCases) {
    const c = getCase(caseId);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`CASE ${caseId}: ${c.initial_fact}`);
    console.log(`CONTRA: ${c.contradicting_fact}`);
    console.log(`${'='.repeat(60)}`);
    try {
      await runCase(caseId);
    } catch (err) {
      console.error(`ERROR in case ${caseId}: ${err.message}`);
    }
  }

  console.log('\n=== Done ===\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
