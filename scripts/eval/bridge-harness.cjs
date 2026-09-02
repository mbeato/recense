#!/usr/bin/env node
/**
 * Bridge-probe harness (graph-aware recall Phase 1, spec §5).
 *
 * Runs every retrieval arm over every bridge probe in oracle-seed and end-to-end modes on a
 * READ-ONLY DB snapshot, scores retrieval recall (never answer quality), reports graph-off
 * deltas vs the `hybrid` arm on every run, and writes the house results envelope.
 * Zero LLM/embedding calls: query vectors are the seeds' stored embeddings.
 *
 * Usage:
 *   npm run build && node scripts/eval/bridge-harness.cjs --run --db scripts/eval/fixtures/bridge-snapshot.db [--probes scripts/eval/cases/bridge-probes.json] [--mode oracle|e2e|both] [--k 10] [--floor 0.3] [--e2e-seed-k 10] [--out scripts/eval/results/bridge-<commit>.json]
 *   OPENAI_API_KEY=... node scripts/eval/bridge-harness.cjs --embed-abstention   # one-time cache of abstention query vectors
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const { realClock } = require('../../dist/src/lib/clock');
const { loadMergedConfig } = require('../../dist/src/adapter/settings-loader');
const { SemanticStore } = require('../../dist/src/db/semantic-store');
const { CandidateRetriever } = require('../../dist/src/retrieval/topk');
const { StrengthDecayManager } = require('../../dist/src/strength/decay');
const { AllocationGate } = require('../../dist/src/gate/allocation-gate');
const { RetrievalEngine } = require('../../dist/src/retrieval/engine');
const { ARMS, readEmbedding, edgeExistence } = require('../../dist/src/eval/bridge-arms');
const { scoreProbe, aggregate } = require('../../dist/src/eval/bridge-metrics');
const { loadAdjacency } = require('../../dist/src/eval/ppr-reference');
const { spreadParamsFromConfig } = require('../../dist/src/retrieval/activation');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const RUN = process.argv.includes('--run');
const EMBED_ABSTENTION = process.argv.includes('--embed-abstention');
const DB_PATH = arg('--db', 'scripts/eval/fixtures/bridge-snapshot.db');
const PROBES = arg('--probes', 'scripts/eval/cases/bridge-probes.json');
const ABSTENTION = path.resolve(__dirname, 'cases/abstention-probes.json');
const ABSTENTION_CACHE = path.resolve(__dirname, 'fixtures/abstention-embeddings.json');
const MODE = arg('--mode', 'both');
const K = parseInt(arg('--k', '10'), 10);
const FLOOR = parseFloat(arg('--floor', '0.3'));
const E2E_SEED_K = parseInt(arg('--e2e-seed-k', '10'), 10);
let COMMIT = 'unknown';
try { COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const OUT = arg('--out', path.resolve(__dirname, `results/bridge-${COMMIT}.json`));

if (!RUN && !EMBED_ABSTENTION) {
  console.error('Usage: bridge-harness.cjs --run --db <snapshot> [--probes ...] [--mode oracle|e2e|both] [--k N] [--floor F] [--out ...]\n       bridge-harness.cjs --embed-abstention   (requires OPENAI_API_KEY)');
  process.exit(1);
}

// ---- one-time abstention vector cache -------------------------------------
if (EMBED_ABSTENTION) {
  if (!process.env.OPENAI_API_KEY) { console.error('ERROR: OPENAI_API_KEY required for --embed-abstention'); process.exit(1); }
  const { OpenAIEmbedder } = require('../../dist/src/model/embedder');
  const cfg = loadMergedConfig(DB_PATH);
  const set = JSON.parse(fs.readFileSync(ABSTENTION, 'utf8'));
  (async () => {
    const embedder = new OpenAIEmbedder(cfg.openaiEmbedModel, cfg.embeddingDimensions);
    const vecs = await embedder.embed(set.probes.map(p => p.query));
    const cache = { _meta: { model: cfg.openaiEmbedModel, dims: cfg.embeddingDimensions }, vectors: {} };
    set.probes.forEach((p, i) => { cache.vectors[p.id] = Array.from(vecs[i]); });
    fs.writeFileSync(ABSTENTION_CACHE, JSON.stringify(cache));
    console.log(`cached ${set.probes.length} abstention vectors → ${ABSTENTION_CACHE}`);
  })().catch(e => { console.error(e); process.exit(1); });
  return;
}

// ---- run ------------------------------------------------------------------
if (!fs.existsSync(DB_PATH)) { console.error(`ERROR: snapshot not found: ${DB_PATH}`); process.exit(1); }
if (!fs.existsSync(PROBES)) { console.error(`ERROR: probe set not found: ${PROBES} (run npm run eval:bridge:derive)`); process.exit(1); }

const db = new Database(DB_PATH, { readonly: true });
const config = loadMergedConfig(DB_PATH);
const store = new SemanticStore(db, realClock, config);
const retriever = new CandidateRetriever(db);
const strength = new StrengthDecayManager(db, realClock, config);
const gate = new AllocationGate(config);
const engine = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate);
const spreadOverride = (p) => ({
  ...p,
  damping: parseFloat(arg('--spread-damping', String(p.damping))),
  activationFloor: parseFloat(arg('--spread-floor', String(p.activationFloor))),
  frontierCap: parseInt(arg('--spread-frontier-cap', String(p.frontierCap)), 10),
  fanExponent: parseFloat(arg('--spread-fan-exp', String(p.fanExponent))),
});
const supportCounts = new Map(db.prepare(`SELECT node_id, COUNT(*) AS c FROM consolidation_event WHERE node_id IS NOT NULL GROUP BY node_id`).all().map(r => [r.node_id, r.c]));
const docIds = new Set(db.prepare(`SELECT id FROM node WHERE type = 'doc' AND tombstoned = 0`).all().map(r => r.id));
const spreadParams2 = spreadOverride(spreadParamsFromConfig(config, 2));
const spreadParams3 = spreadOverride(spreadParamsFromConfig(config, 3));
const ctx = {
  db, store, retriever, engine, adjacency: loadAdjacency(db), k: K, floor: FLOOR, e2eSeedK: E2E_SEED_K,
  spreadParams2, spreadParams3, supportCounts, docIds,
};
const edges = edgeExistence(db);
const probeSet = JSON.parse(fs.readFileSync(PROBES, 'utf8'));
const modes = MODE === 'both' ? ['oracle', 'e2e'] : [MODE];

const perProbe = [];
const buckets = {};
let skippedNoEmbedding = 0;
for (const mode of modes) {
  buckets[mode] = {};
  for (const arm of ARMS) buckets[mode][arm.name] = [];
  for (const probe of probeSet.probes) {
    const queryVec = readEmbedding(db, probe.seed.id);
    if (!queryVec) { skippedNoEmbedding++; continue; }
    for (const arm of ARMS) {
      const res = arm.run({ probe, queryVec, mode }, ctx);
      if (res === null) continue;
      const s = scoreProbe(res, probe.terminal.id, probe.bridge.id, edges);
      buckets[mode][arm.name].push(s);
      perProbe.push({ id: probe.id, mode, arm: arm.name, ...s });
    }
    process.stdout.write('.');
  }
}
process.stdout.write('\n');
if (skippedNoEmbedding > 0) console.error(`skipped ${skippedNoEmbedding} probe(s) whose seed embedding is missing in this snapshot`);

const scores = {};
const delta = {};
for (const mode of modes) {
  scores[mode] = {};
  delta[mode] = {};
  for (const arm of ARMS) {
    const list = buckets[mode][arm.name];
    scores[mode][arm.name] = list.length === 0 ? null : aggregate(list);
  }
  const base = scores[mode].hybrid;
  for (const arm of ARMS) {
    const a = scores[mode][arm.name];
    delta[mode][arm.name] = a && base ? { r10: +(a.r10 - base.r10).toFixed(4), mrr: +(a.mrr - base.mrr).toFixed(4) } : null;
  }
}

// ---- abstention (only if the vector cache exists and matches the config) ---
let abstention = null;
if (fs.existsSync(ABSTENTION_CACHE)) {
  const cache = JSON.parse(fs.readFileSync(ABSTENTION_CACHE, 'utf8'));
  if (cache._meta.model !== config.openaiEmbedModel || cache._meta.dims !== config.embeddingDimensions) {
    console.error('abstention cache model/dims mismatch — rerun --embed-abstention; reporting abstention as null');
  } else {
    const set = JSON.parse(fs.readFileSync(ABSTENTION, 'utf8'));
    abstention = {};
    for (const arm of ARMS) {
      let fp = 0, n = 0;
      for (const p of set.probes) {
        const vec = Float32Array.from(cache.vectors[p.id]);
        const fake = { id: p.id, query: p.query, seed: { id: '__none__', type: 'fact', value: p.query }, bridge: { id: '__none__', type: 'fact', value: '' }, terminal: { id: '__none__', type: 'fact', value: '' }, path: [{ src: '', rel: '', kind: '', dir: 'fwd', dst: '' }, { src: '', rel: '', kind: '', dir: 'fwd', dst: '' }], seed_outdeg: 0, dilution: 'lo', stratum: '', cosine_seed_terminal: 0 };
        const res = arm.run({ probe: fake, queryVec: vec, mode: 'e2e' }, ctx);
        if (res === null) continue;
        n++;
        if (res.rankedIds.length > 0) fp++;
      }
      abstention[arm.name] = n === 0 ? null : { n, false_positive_rate: +(fp / n).toFixed(4) };
    }
  }
} else {
  console.error('no abstention vector cache — abstention block reported as null (run --embed-abstention once)');
}

const envelope = {
  meta: {
    eval: 'bridge-probes',
    date: new Date().toISOString().slice(0, 10),
    sut_commit: COMMIT,
    db_source: probeSet._meta.db_source,
    probes_total: probeSet.probes.length,
    founder_signoff: probeSet._meta.founder_signoff,
    k: K, floor: FLOOR, e2e_seed_k: E2E_SEED_K,
    sut_config: {
      bm25FusionWeight: config.bm25FusionWeight,
      rankStrengthWeight: config.rankStrengthWeight,
      lambda: config.lambda,
      spreadDecay: config.spreadDecay,
      rankedRetrievalFloor: config.rankedRetrievalFloor,
      spread: { spreadParams2, spreadParams3 },
    },
  },
  scores: { ...scores, delta_vs_hybrid: delta, abstention },
  per_probe: perProbe,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(envelope, null, 2));

// ---- console report ---------------------------------------------------------
for (const mode of modes) {
  console.log(`\n== ${mode} (k=${K}, floor=${FLOOR}) ==`);
  console.log('arm         n    r@5    r@10   r@20   bridge@10  MRR    p50ms  p95ms  Δr10 vs hybrid');
  for (const arm of ARMS) {
    const a = scores[mode][arm.name];
    if (!a) { console.log(`${arm.name.padEnd(11)} n/a`); continue; }
    const d = delta[mode][arm.name];
    console.log(`${arm.name.padEnd(11)} ${String(a.n).padEnd(4)} ${a.r5.toFixed(3)}  ${a.r10.toFixed(3)}  ${a.r20.toFixed(3)}  ${a.bridge_r10.toFixed(3)}      ${a.mrr.toFixed(3)}  ${a.latency_p50.toFixed(1).padEnd(6)} ${a.latency_p95.toFixed(1).padEnd(6)} ${d ? (d.r10 >= 0 ? '+' : '') + d.r10.toFixed(3) : '-'}`);
  }
}
if (abstention) {
  console.log('\n== abstention (false-positive rate over out-of-domain queries) ==');
  for (const arm of ARMS) { const a = abstention[arm.name]; console.log(`${arm.name.padEnd(11)} ${a ? a.false_positive_rate.toFixed(3) : 'n/a'}`); }
}
console.log(`\nresults → ${OUT}`);
