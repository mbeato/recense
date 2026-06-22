#!/usr/bin/env node
/**
 * Phase 37 query-set derivation (D-05 input) — re-derive a predicate-balanced,
 * single-hop query set from LIVE-extracted typed edges for founder sign-off.
 *
 * For each of the 12 predicates: pick up to 2 clean anchor→gold edges (both endpoints
 * short, entity-like, distinct), prefer a higher-frontier anchor (multiple golds for the
 * predicate → a real ranking challenge) paired with a simpler one, assign a dilution tier
 * from the anchor's total out-degree, and template a natural-language question. Emits
 * queries-37.json (harness shape) + a review table for per-query founder sign-off.
 *
 * Usage: node scripts/eval/derive-queries-37.cjs --db <path> [--out <path>] [--per 2]
 *
 * The golds are REAL reachable node values — no fabrication (no-inflated-metrics rule).
 * Founder reviews/edits the output before the gate binds (Task 3, D-05).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DB_PATH = arg('--db', '/tmp/scratch-live-37.db');
const OUT = arg('--out', path.resolve(__dirname, 'queries-37.json'));
const PER = parseInt(arg('--per', '2'), 10);
const MAX_LEN = 34; // endpoint cleanliness cap

const PREDICATES = ['built_by','works_on','part_of','uses','depends_on','runs_on','located_in','integrates_with','supersedes','prefers','evaluated','configured_with'];

const QUESTION = {
  built_by: a => `Who built ${a}?`,
  works_on: a => `What does ${a} work on?`,
  part_of: a => `What is ${a} part of?`,
  uses: a => `What does ${a} use?`,
  depends_on: a => `What does ${a} depend on?`,
  runs_on: a => `What does ${a} run on?`,
  located_in: a => `Where is ${a} located?`,
  integrates_with: a => `What does ${a} integrate with?`,
  supersedes: a => `What did ${a} replace?`,
  prefers: a => `What does ${a} prefer?`,
  evaluated: a => `What did ${a} evaluate?`,
  configured_with: a => `What is ${a} configured with?`,
};

const db = new Database(DB_PATH, { readonly: true });

// All clean typed edges with anchor total out-degree (dilution) + per-predicate frontier.
const rows = db.prepare(`
  WITH typed AS (
    SELECT e.rel AS rel, e.src AS srcid, n1.value AS anchor, n2.value AS gold
    FROM edge e JOIN node n1 ON e.src=n1.id JOIN node n2 ON e.dst=n2.id
    WHERE e.kind='relation' AND e.rel IN (${PREDICATES.map(() => '?').join(',')})
      AND LENGTH(n1.value) <= ${MAX_LEN} AND LENGTH(n2.value) <= ${MAX_LEN}
      AND n1.value <> n2.value
  )
  SELECT rel, srcid, anchor, gold,
    (SELECT COUNT(*) FROM typed t2 WHERE t2.srcid=typed.srcid AND t2.rel=typed.rel) AS frontier,
    (SELECT COUNT(*) FROM edge e3 WHERE e3.src=typed.srcid AND e3.kind='relation') AS outdeg
  FROM typed
`).all(...PREDICATES);

// Soft-noise filter: drop golds that are bare plan/decision refs (real but not entity-defensible).
const noisy = v => /^(D-\d|LEARN-\d|SCOPE-\d|EVAL-\d|RANK-\d|phase \d|Plan |\d\d-\d\d$|Phase \d)/i.test(v.trim());

const byPred = {};
for (const r of rows) {
  if (noisy(r.gold)) continue;
  (byPred[r.rel] ||= []).push(r);
}

// Dilution tier from anchor out-degree (global terciles).
const allOut = rows.map(r => r.outdeg).sort((a, b) => a - b);
const t1 = allOut[Math.floor(allOut.length / 3)] || 2;
const t2 = allOut[Math.floor(2 * allOut.length / 3)] || 5;
const tier = o => (o >= t2 ? 'hi' : o >= t1 ? 'mid' : 'lo');

const queries = [];
const report = [];
let qn = 0;
for (const pred of PREDICATES) {
  const cands = (byPred[pred] || []).sort((a, b) => b.frontier - a.frontier || (a.anchor.length + a.gold.length) - (b.anchor.length + b.gold.length));
  // Prefer distinct anchors, highest frontier first.
  const picked = [];
  const seenAnchor = new Set();
  for (const c of cands) {
    if (picked.length >= PER) break;
    if (seenAnchor.has(c.anchor.toLowerCase())) continue;
    seenAnchor.add(c.anchor.toLowerCase());
    picked.push(c);
  }
  // Backfill if not enough distinct anchors.
  for (const c of cands) { if (picked.length >= PER) break; if (!picked.includes(c)) picked.push(c); }

  if (picked.length === 0) { report.push(`  ${pred.padEnd(16)} : ⚠ NO CLEAN CANDIDATE`); continue; }
  for (const c of picked) {
    qn++;
    queries.push({
      id: `q${String(qn).padStart(2, '0')}`,
      dilution: tier(c.outdeg),
      anchor: c.anchor,
      predicate_path: [pred],
      gold: c.gold,
      question: QUESTION[pred](c.anchor),
      note: `live-derived; anchor frontier=${c.frontier} outdeg=${c.outdeg}`,
    });
    report.push(`  ${pred.padEnd(16)} [${tier(c.outdeg)}] ${c.anchor}  --${pred}-->  ${c.gold}   (frontier ${c.frontier})`);
  }
}

const present = new Set(queries.flatMap(q => q.predicate_path));
const missing = PREDICATES.filter(p => !present.has(p));

const spec = {
  _meta: {
    K: 20,
    note: 'Phase 37 query set re-derived from LIVE-extracted typed edges (both fixes applied: fence + resolver). Single-hop (D-07). Golds are real reachable node values — founder sign-off required before the gate binds (D-05).',
    db_source: DB_PATH,
    predicate_version: 'v1 single-hop',
  },
  queries,
};

if (!process.argv.includes('--print-only')) fs.writeFileSync(OUT, JSON.stringify(spec, null, 2));

console.log(`\n=== Phase 37 query set: ${queries.length} queries across ${present.size}/12 predicates ===`);
console.log(report.join('\n'));
if (missing.length) console.log(`\n⚠ MISSING predicates (no clean candidate yet): ${missing.join(', ')}`);
console.log(`\nWritten: ${process.argv.includes('--print-only') ? '(print-only, not written)' : OUT}`);
db.close();
