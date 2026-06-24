#!/usr/bin/env node
/**
 * Phase 38.1 de-risk probe — does the ~2000-claim KU corpus now DEDUP post-embed-on-mint?
 *
 * Background: the Phase 35 RANK-02 "no win" was confounded. The replay-ku harness ingests
 * ~2000 claims into ONE consolidation pass; pre-38.1 every mid-pass-minted node had
 * embedding=NULL (topk filters `embedding IS NOT NULL`), so NO claim could see a sibling →
 * every claim minted 'unrelated' (tomb=0 contra=0 dup≈2000) → uniform node strength → RANK-01
 * had no gradient to rank on. 38.1 (embed-on-mint) makes minted nodes topk-visible same-pass.
 *
 * This probe re-runs the harness's exact per-case consolidation (consolidateCase) on the FIRST
 * N real KU cases and reports judge-engagement (tomb/contra/dup + full event breakdown). If the
 * graph now differentiates (dup collapses, tomb/contra > 0), a strength gradient exists and the
 * full 3.4h RANK-02 sweep is worth running. If dup is still ≈claims, it does not.
 *
 * JUDGE: production stack — headless Sonnet via claude -p (RECENSE_MODEL_PROVIDER=claude-headless),
 * the SAME judge the real RANK-02 sweep uses, so the numbers actually predict the sweep.
 * Extraction is REPLAYED (no LLM). Embeddings are real (OpenAI; OPENAI_API_KEY required).
 *
 * Usage:
 *   PROBE_CASES=1 RECENSE_MODEL_PROVIDER=claude-headless node scripts/eval/38.1-dedup-probe.cjs
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

const N = parseInt(process.env.PROBE_CASES || '1', 10);
const ATTRIBUTION_FILE = path.join(os.homedir(), '.recense-eval-cache/eval01-n20-2026-06-16/n20-attribution.jsonl');
const KU_FILE          = path.join(os.homedir(), '.recense-eval-cache/eval01-n20-2026-06-16/eval20-ku.jsonl');

function parseJsonl(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function queryEngagement(db) {
  const tombstones = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned = 1').get().n;
  const nodes      = db.prepare('SELECT COUNT(*) AS n FROM node').get().n;
  const rows       = db.prepare('SELECT event_type, COUNT(*) AS n FROM consolidation_event GROUP BY event_type ORDER BY n DESC').all();
  let contradicts = 0, duplicateMints = 0;
  for (const r of rows) {
    if (r.event_type.startsWith('contradict_')) contradicts += r.n;
    if (r.event_type === 'unrelated')           duplicateMints += r.n;
  }
  return { tombstones, nodes, contradicts, duplicateMints, rows };
}

(async () => {
  const tStartAll = Date.now();
  const attr = new Map(parseJsonl(ATTRIBUTION_FILE).map(r => [r.question_id, r]));
  const ku   = new Map(parseJsonl(KU_FILE).map(r => [r.question_id, r]));
  const ids  = [...attr.keys()].filter(id => ku.has(id)).slice(0, N);

  const judge = process.env.RECENSE_MODEL_PROVIDER === 'claude-headless'
    ? 'headless Sonnet (claude -p, subscription)'
    : (process.env.RECENSE_JUDGE_PROVIDER || 'default/direct-API');

  console.log(`\nPhase 38.1 dedup probe — ${ids.length} case(s)`);
  console.log(`Judge:      ${judge}`);
  console.log(`Embeddings: OpenAI (${DEFAULT_CONFIG.openaiEmbedModel})`);
  console.log(`Baseline (pre-38.1, every case): tomb=0  contra=0  dup≈claims (all 'unrelated')\n`);

  for (const id of ids) {
    const claims = attr.get(id).claims;
    const dbPath = path.join(os.tmpdir(), `probe381-${process.pid}-${id}.db`);
    const db = new Database(dbPath);
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath };
    const episodes = new EpisodicStore(db, realClock, config);
    for (let i = 0; i < claims.length; i++) {
      episodes.append({
        content: claims[i].value, origin: 'observed', salience: 1.0, hard_keep: 1,
        role: 'user', session_id: `probe-${id}-c${i}`, source: 'conversation',
      });
    }
    process.stdout.write(`[consolidate] ${id} (${claims.length} claims)...\n`);
    const t = Date.now();
    await runConsolidation(db, dbPath, process.env, () => {}, {
      replayExtract(content) { return [{ type: 'fact', value: content }]; },
    });
    const e = queryEngagement(db);
    const secs = ((Date.now() - t) / 1000).toFixed(0);
    console.log(`\n  ${id}: claims=${claims.length} nodes=${e.nodes} tomb=${e.tombstones} contra=${e.contradicts} dup=${e.duplicateMints}  (${secs}s)`);
    console.log(`  event breakdown: ${e.rows.map(r => `${r.event_type}=${r.n}`).join('  ')}`);
    const dedupPct = ((1 - e.duplicateMints / claims.length) * 100).toFixed(1);
    console.log(`  → ${dedupPct}% of claims did NOT mint-unrelated (pre-38.1 this was ~0%)\n`);
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
  }
  console.log(`Done in ${((Date.now() - tStartAll) / 1000).toFixed(0)}s total.`);
})().catch(e => { console.error('PROBE ERROR:', e && e.stack || e); process.exit(1); });
