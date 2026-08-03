#!/usr/bin/env node
'use strict';

/**
 * 69-entity-anchor-latency.cjs — Phase 69 D-03 honest hook-latency probe.
 *
 * Measures the ADDED cost of entity anchoring on the ambient hot path: warm up, then measure
 * REPS (default 30) repetitions of `ambientRecall` against the LIVE graph for a small,
 * committed set of synthetic, entity-heavy probe prompts (hand-written, NEVER taken from the
 * gitignored eval set), once with `entityAnchoringEnabled:false` and once with `true`,
 * reporting p50/p95/max per arm and the delta.
 *
 * The embedding call is isolated from the measurement: each probe is pre-embedded ONCE via the
 * real OpenAI embedder, then a MockModelProvider-style stub returns the cached vector for every
 * measured call — so the reported delta is the anchoring work itself, not OpenAI network
 * jitter. This is stated in both the header and the printed output because the number's meaning
 * depends on it.
 *
 * This is a PROBE, not a gate: no threshold assertion, no non-zero exit on a slow result (a
 * threshold here would be a flaky test on dev-machine variance). It reports; Task 3 (69-06)
 * reads the numbers and applies D-03/G5's soft-gate judgment.
 *
 * Run:
 *   npm run build
 *   node scripts/eval/69-entity-anchor-latency.cjs --db ~/.config/recense/recense.db
 *   node scripts/eval/69-entity-anchor-latency.cjs --db <path> --reps 50
 *
 * Requires OPENAI_API_KEY (one real embed per probe, ONCE, before the measured loop — never
 * inside the timed section).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
const { initSchema } = require(DIST + '/db/schema');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');
const { realClock } = require(DIST + '/lib/clock');
const { ambientRecall } = require(DIST + '/adapter/ambient-recall');
const { DefaultModelProvider, MockModelProvider } = require(DIST + '/model/provider');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DB_PATH = arg('--db', null);
if (!DB_PATH) {
  console.error('Usage: 69-entity-anchor-latency.cjs --db <path to recense.db> [--reps 30]');
  console.error('  --db is required — this probe measures against the LIVE graph, not a scratch DB.');
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`FAIL: DB not found at ${DB_PATH}`);
  process.exit(1);
}

const REPS = parseInt(arg('--reps', '30'), 10) || 30;

// Hand-written literals — entity-heavy, distinctive proper nouns, NEVER taken from the eval set.
const PROBES = [
  'what do you remember about my conversations with Aurevion',
  'tell me everything you know about the recense project architecture',
  'what facts are linked to VTX athletes',
  'summarize what you know about Jobfill and its integrations',
  'what did I discuss about brain-memory phase 69 with Claude',
];

const CWD = '/Users/evaluser/brain-memory';

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

(async () => {
  // Not opened read-only: ambientRecall's activation-trace sink may need write access when
  // viz_trace_enabled is on in this DB (matches production SessionStart-hook behavior — a
  // capped ring buffer, net row count neutral, not a new invariant beyond normal operation).
  const db = new Database(DB_PATH);
  initSchema(db);
  const nodeCount = db.prepare('SELECT count(*) AS n FROM node').get().n;

  // Pre-embed each probe ONCE via the real embedder, outside the timed section.
  const embedConfig = { ...DEFAULT_CONFIG, dbPath: DB_PATH };
  const realProvider = new DefaultModelProvider({ generateConfig: embedConfig, judgeConfig: embedConfig, embedConfig });
  const vectors = await realProvider.embed(PROBES);
  const cache = new Map(PROBES.map((p, i) => [p, vectors[i]]));
  const mockProvider = new MockModelProvider({ embedFn: t => cache.get(t) });

  console.log(`[69-entity-anchor-latency] db=${DB_PATH} nodes=${nodeCount} reps=${REPS} probes=${PROBES.length}`);
  console.log('[69-entity-anchor-latency] methodology: embeddings pre-cached (real OpenAI, once, outside the timed loop) — measured delta is anchoring work only, not embed network jitter.');

  const results = {};
  for (const entityAnchoringEnabled of [false, true]) {
    const config = { ...DEFAULT_CONFIG, dbPath: DB_PATH, entityAnchoringEnabled };
    // warm-up (discarded)
    for (const probe of PROBES) {
      await ambientRecall(db, probe, mockProvider, config, realClock, CWD);
    }
    const latencies = [];
    for (let r = 0; r < REPS; r++) {
      for (const probe of PROBES) {
        const t0 = Date.now();
        await ambientRecall(db, probe, mockProvider, config, realClock, CWD);
        latencies.push(Date.now() - t0);
      }
    }
    latencies.sort((a, b) => a - b);
    results[entityAnchoringEnabled ? 'on' : 'off'] = {
      samples: latencies.length,
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      max_ms: latencies[latencies.length - 1],
    };
  }
  db.close();

  const off = results.off;
  const on = results.on;
  const deltaP50 = on.p50_ms - off.p50_ms;
  const deltaP95 = on.p95_ms - off.p95_ms;

  console.log('[69-entity-anchor-latency] result:', JSON.stringify({ node_count: nodeCount, reps: REPS, probes: PROBES.length, off, on, delta_p50_ms: deltaP50, delta_p95_ms: deltaP95 }));
  console.log(
    `anchoring OFF p50/p95 = ${off.p50_ms}/${off.p95_ms} ms; ON p50/p95 = ${on.p50_ms}/${on.p95_ms} ms; ` +
    `delta p50/p95 = +${deltaP50}/+${deltaP95} ms over ${REPS} reps x ${PROBES.length} probes on a graph of ${nodeCount} live nodes`
  );
})().catch(e => { console.error('69-entity-anchor-latency error:', e.message); process.exit(1); });
