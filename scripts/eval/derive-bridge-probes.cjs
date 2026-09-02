#!/usr/bin/env node
/**
 * Bridge-probe miner (graph-aware recall Phase 1, spec §5).
 *
 * Mines real seed → bridge → terminal paths from a READ-ONLY recense.db snapshot where the
 * terminal is a live fact that shares no content tokens with the seed value and sits below
 * COSINE_CEILING to it (both from stored embeddings — no API calls). Query text = seed value.
 *
 * Usage: npm run build && node scripts/eval/derive-bridge-probes.cjs --db scripts/eval/fixtures/bridge-snapshot.db [--out scripts/eval/cases/bridge-probes.json] [--target 60]
 *
 * Golds are real reachable nodes (no-inflated-metrics). Output is gitignored: it contains
 * personal-graph values. _meta.founder_signoff starts PENDING.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { COSINE_CEILING, isLexicallyDisjoint, dilutionTier, roundRobinSample } = require('../../dist/src/eval/bridge-probes');
const { eligibleWeight } = require('../../dist/src/eval/ppr-reference');
const { readEmbedding } = require('../../dist/src/eval/bridge-arms');
const { cosineSimF32 } = require('../../dist/src/retrieval/topk');
const { sha256 } = require('../../dist/src/lib/hash');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DB_PATH = arg('--db', null);
const OUT = arg('--out', path.resolve(__dirname, 'cases/bridge-probes.json'));
const TARGET = parseInt(arg('--target', '60'), 10);
const MAX_SEED_LEN = 200;
const MAX_TERM_LEN = 240;

if (!DB_PATH || !fs.existsSync(DB_PATH)) {
  console.error('ERROR: --db <snapshot path> is required and must exist (never point this at the live DB).');
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

// Undirected edge view with direction tag; both hops restricted to relation/abstracts kinds.
const candidates = db.prepare(`
  WITH u AS (
    SELECT src AS a, dst AS b, rel, kind, 'fwd' AS dir FROM edge WHERE kind IN ('relation','abstracts')
    UNION ALL
    SELECT dst AS a, src AS b, rel, kind, 'rev' AS dir FROM edge WHERE kind IN ('relation','abstracts')
  )
  SELECT s.id AS seed_id, s.type AS seed_type, s.value AS seed_value,
         b.id AS bridge_id, b.type AS bridge_type, b.value AS bridge_value,
         t.id AS term_id, t.value AS term_value,
         e1.rel AS rel1, e1.kind AS kind1, e1.dir AS dir1,
         e2.rel AS rel2, e2.kind AS kind2, e2.dir AS dir2,
         (SELECT COUNT(*) FROM edge o WHERE o.src = s.id) AS seed_outdeg
  FROM u e1
  JOIN u e2 ON e1.b = e2.a
  JOIN node s ON s.id = e1.a
  JOIN node b ON b.id = e1.b
  JOIN node t ON t.id = e2.b
  WHERE s.tombstoned = 0 AND b.tombstoned = 0 AND t.tombstoned = 0
    AND t.type = 'fact' AND s.type IN ('fact','entity')
    AND s.id <> t.id AND s.id <> b.id AND b.id <> t.id
    AND s.embedding IS NOT NULL AND t.embedding IS NOT NULL
    AND LENGTH(s.value) <= ${MAX_SEED_LEN} AND LENGTH(t.value) <= ${MAX_TERM_LEN}
    AND NOT EXISTS (
      SELECT 1 FROM edge d WHERE (d.src = s.id AND d.dst = t.id) OR (d.src = t.id AND d.dst = s.id)
    )
`).all();
console.error(`raw 2-hop candidates: ${candidates.length}`);

// Global out-degree terciles over live nodes with >=1 out-edge (queries-37 dilution precedent).
const degs = db.prepare(`SELECT COUNT(*) AS d FROM edge e JOIN node n ON n.id = e.src WHERE n.tombstoned = 0 GROUP BY e.src ORDER BY d`).all().map(r => r.d);
const terciles = [degs[Math.floor(degs.length / 3)] ?? 1, degs[Math.floor((2 * degs.length) / 3)] ?? 2];

// Cheap filters first (eligibility + lexical), then a deterministic shuffle, then lazy cosine.
const lexOk = candidates.filter(c =>
  eligibleWeight(c.kind1, c.rel1, c.dir1) > 0 &&
  eligibleWeight(c.kind2, c.rel2, c.dir2) > 0 &&
  isLexicallyDisjoint(c.seed_value, c.term_value),
);
console.error(`after eligibility + lexical disjointness: ${lexOk.length}`);

const embCache = new Map();
const emb = id => { if (!embCache.has(id)) embCache.set(id, readEmbedding(db, id)); return embCache.get(id); };

const seen = new Set();
const enriched = [];
for (const c of lexOk) {
  const pairKey = `${c.seed_id}|${c.term_id}`;
  if (seen.has(pairKey)) continue;
  seen.add(pairKey);
  const dilution = dilutionTier(c.seed_outdeg, terciles);
  enriched.push({ ...c, dilution, stratum: `${c.bridge_type}:${dilution}`, sortKey: sha256(pairKey) });
}

// Draw more than TARGET so the cosine filter has headroom, then apply cosine lazily.
const drawn = roundRobinSample(enriched, TARGET * 4, c => c.sortKey);
const accepted = [];
const strata = {};
for (const c of drawn) {
  if (accepted.length >= TARGET) break;
  const cos = cosineSimF32(emb(c.seed_id), emb(c.term_id));
  if (!(cos < COSINE_CEILING)) continue;
  strata[c.stratum] = (strata[c.stratum] ?? 0) + 1;
  accepted.push({
    id: `bp${String(accepted.length + 1).padStart(3, '0')}`,
    query: c.seed_value,
    seed: { id: c.seed_id, type: c.seed_type, value: c.seed_value },
    bridge: { id: c.bridge_id, type: c.bridge_type, value: c.bridge_value },
    terminal: { id: c.term_id, type: 'fact', value: c.term_value },
    path: [
      { src: c.seed_id, rel: c.rel1, kind: c.kind1, dir: c.dir1, dst: c.bridge_id },
      { src: c.bridge_id, rel: c.rel2, kind: c.kind2, dir: c.dir2, dst: c.term_id },
    ],
    seed_outdeg: c.seed_outdeg,
    dilution: c.dilution,
    stratum: c.stratum,
    cosine_seed_terminal: Number(cos.toFixed(4)),
  });
}

const out = {
  _meta: {
    db_source: DB_PATH,
    generated_at: new Date().toISOString(),
    total: accepted.length,
    strata,
    founder_signoff: 'PENDING',
    cosine_ceiling: COSINE_CEILING,
  },
  probes: accepted,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`accepted ${accepted.length}/${TARGET} probes; strata: ${JSON.stringify(strata)}`);
if (accepted.length < TARGET) console.error(`NOTE: supply below target — ${drawn.length} drawn, cosine ceiling ${COSINE_CEILING} rejected the rest. Not a silent cap.`);
console.log(OUT);
