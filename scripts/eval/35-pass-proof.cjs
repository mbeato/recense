#!/usr/bin/env node
/**
 * Pass-boundary proof (Phase 35 follow-up debug tool).
 *
 * Hypothesis (from code trace): consolidation can't merge/contradict claims that arrive in
 * the SAME pass, because newly-minted nodes get embedding=NULL and are only embedded by
 * reembedDirty (pass START + Phase C, AFTER the per-episode judging loop). topk filters
 * `embedding IS NOT NULL`, so a mid-pass-minted node is invisible to the next episode's
 * candidate search → every claim mints 'unrelated' → contra=0. This is exactly what the
 * replay-ku harness does: ingest ~2000 claims → ONE pass.
 *
 * Proof: feed the SAME clear contradiction pair two ways.
 *   Scenario A (one batch):  append A+B, consolidate ONCE      → expect contra=0 (bug repro)
 *   Scenario B (two passes): append A, consolidate; append B, consolidate → expect contra>=1
 *
 * Judge routed to LOCAL ollama (free, proven-correct by 35-judge-probe). Needs OPENAI_API_KEY
 * (reembedDirty embeds via OpenAI). No claude -p, no metered API.
 */
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const Database = require('better-sqlite3');
const { initSchema }       = require('../../dist/src/db/schema');
const { EpisodicStore }    = require('../../dist/src/db/episode-store');
const { DEFAULT_CONFIG }   = require('../../dist/src/lib/config');
const { realClock }        = require('../../dist/src/lib/clock');
const { runConsolidation } = require('../../dist/src/consolidation/run-sleep-pass');

const A = "User's personal best time in the charity 5K run is 27 minutes 12 seconds.";
const B = "User's personal best time in the charity 5K run is 25 minutes 50 seconds.";

// Force the free local judge regardless of sleep.env's claude-headless setting.
const ENV = {
  ...process.env,
  RECENSE_JUDGE_PROVIDER: 'local',
  RECENSE_JUDGE_LOCAL_MODEL: process.env.RECENSE_JUDGE_LOCAL_MODEL || 'qwen3.6:35b-a3b',
  RECENSE_EXTRACTOR_PROVIDER: 'local', // bypassed by replayExtract, but set for cleanliness
};
const REPLAY = { replayExtract: (content) => [{ type: 'fact', value: content }] };

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `pass-proof-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  return { db, dbPath, episodes: new EpisodicStore(db, realClock, config) };
}
function append(s, content, tag) {
  s.episodes.append({ content, origin: 'observed', salience: 1.0, hard_keep: 1, role: 'user', session_id: tag, source: 'conversation' });
}
function engagement(db) {
  const tombstones = db.prepare('SELECT COUNT(*) n FROM node WHERE tombstoned=1').get().n;
  const nodes = db.prepare('SELECT COUNT(*) n FROM node').get().n;
  const rows = db.prepare('SELECT event_type, COUNT(*) n FROM consolidation_event GROUP BY event_type').all();
  let contradicts = 0, unrelated = 0; const breakdown = {};
  for (const r of rows) {
    breakdown[r.event_type] = r.n;
    if (String(r.event_type).startsWith('contradict')) contradicts += r.n;
    if (r.event_type === 'unrelated') unrelated += r.n;
  }
  return { nodes, tombstones, contradicts, unrelated, breakdown };
}
const show = (label, e) => console.log(`  ${label}: nodes=${e.nodes} tombstones=${e.tombstones} contradicts=${e.contradicts} unrelated=${e.unrelated}  events=${JSON.stringify(e.breakdown)}`);

(async () => {
  console.log(`Pass-boundary proof — judge=local(${ENV.RECENSE_JUDGE_LOCAL_MODEL}), embed=OpenAI`);
  console.log(`Pair:\n  A = "${A}"\n  B = "${B}"  (clear contradiction; near-identical phrasing → high cosine)\n`);

  // Scenario A — one batch (reproduces the harness)
  console.log(`=== Scenario A: append A+B, consolidate ONCE (the harness's single-pass design) ===`);
  const a = freshDb();
  append(a, A, 'A-batch-1'); append(a, B, 'A-batch-2');
  await runConsolidation(a.db, a.dbPath, ENV, () => {}, REPLAY);
  const ea = engagement(a.db); show('after 1 pass', ea);
  a.db.close(); try { fs.unlinkSync(a.dbPath); } catch {}

  // Scenario B — two passes (incremental, like real production)
  console.log(`\n=== Scenario B: append A, consolidate; then append B, consolidate (incremental) ===`);
  const b = freshDb();
  append(b, A, 'B-pass1');
  await runConsolidation(b.db, b.dbPath, ENV, () => {}, REPLAY);
  show('after pass 1 (A only)', engagement(b.db));
  append(b, B, 'B-pass2');
  await runConsolidation(b.db, b.dbPath, ENV, () => {}, REPLAY);
  const eb = engagement(b.db); show('after pass 2 (B vs embedded A)', eb);
  b.db.close(); try { fs.unlinkSync(b.dbPath); } catch {}

  console.log(`\n=== VERDICT ===`);
  if (ea.contradicts === 0 && eb.contradicts >= 1) {
    console.log(`  CONFIRMED: same pair → contra=0 in one batch, contra=${eb.contradicts} across two passes.`);
    console.log(`  The pass boundary (mid-pass minted nodes are unembedded → invisible to topk) is the cause.`);
    console.log(`  ⇒ The RANK-02 sweep ran on a degenerate single-pass graph (no merges/contradictions →`);
    console.log(`     uniform strength → no signal). The "no win" is an ARTIFACT, not a verdict on strength ranking.`);
  } else {
    console.log(`  Scenario A contra=${ea.contradicts}, Scenario B contra=${eb.contradicts} — re-read; hypothesis not cleanly confirmed.`);
  }
})().catch(e => { console.error('proof error:', e.stack || e.message || e); process.exit(1); });
