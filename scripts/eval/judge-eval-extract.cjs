/**
 * Judge eval-set extractor (read-only, no API calls).
 * Reconstructs realistic gray-zone judge inputs from a recense.db:
 *   claim = a node's value; candidates = its top-5 cosine neighbors.
 * Mirrors what the consolidator feeds AnthropicJudge.judge(claim, candidates).
 * Output: scripts/eval/judge-eval-set.json (label fields blank for hand-labeling).
 */
const Database = require('better-sqlite3');

const DB = process.argv[2] || './recense.db';
const OUT = 'scripts/eval/judge-eval-set.json';
const UNRELATED_THRESHOLD = 0.3; // config.unrelatedSimilarityThreshold — below this = auto-unrelated, no judge
const TOPK = 5;                   // config.candidateK
const HI = 0.97;                  // exclude near-identical (would fast-path confirm); keep the hard middle
const PER_BAND = 12;
const BANDS = [[0.3, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.97]];

function decode(buf) {
  // Float32Array from Buffer, preserving byteOffset (Pitfall 5)
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const db = new Database(DB, { readonly: true });
const rows = db.prepare(
  "SELECT id, value, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0"
).all();
db.close();

const nodes = rows.map(r => ({ id: r.id, value: r.value, vec: decode(r.embedding) }));
console.log(`Loaded ${nodes.length} live embedded nodes from ${DB}`);

// For each node: top-K neighbors by cosine (excluding self & exact-value duplicates)
const cases = [];
const seenPair = new Set();
for (const n of nodes) {
  const scored = [];
  for (const m of nodes) {
    if (m.id === n.id) continue;
    scored.push({ id: m.id, value: m.value, cos: cosine(n.vec, m.vec) });
  }
  scored.sort((a, b) => b.cos - a.cos);
  const top = scored.slice(0, TOPK);
  const best = top[0];
  if (!best) continue;
  // gray-zone gate: escalates to judge (>= threshold) and not an exact value match (fast-path confirm)
  if (best.cos < UNRELATED_THRESHOLD || best.cos >= HI) continue;
  if (norm(best.value) === norm(n.value)) continue;
  const pairKey = [n.id, best.id].sort().join('|');
  if (seenPair.has(pairKey)) continue;       // dedupe symmetric a<->b
  seenPair.add(pairKey);
  cases.push({
    claim: n.value,
    candidates: top.map(t => ({ id: t.id, value: t.value, cosine: +t.cos.toFixed(3) })),
    top_cosine: +best.cos.toFixed(3),
    band: BANDS.findIndex(([lo, hi]) => best.cos >= lo && best.cos < hi),
    // ↓ you fill these in once (ground truth):
    label: { best_candidate_id: '', relation: '', magnitude: null },
  });
}

// Even spread across difficulty bands (the 0.5–0.85 middle is where the judge earns its keep)
const out = [];
for (let b = 0; b < BANDS.length; b++) {
  const inBand = cases.filter(c => c.band === b).sort((a, z) => a.top_cosine - z.top_cosine);
  out.push(...inBand.slice(0, PER_BAND));
}
out.forEach((c, i) => { c.case_id = i + 1; });

require('fs').writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\nWrote ${out.length} judge eval cases → ${OUT}`);
console.log('Band spread (cosine):', BANDS.map((band, b) =>
  `${band[0]}-${band[1]}: ${out.filter(c => c.band === b).length}`).join('  '));

console.log('\n--- sample cases (claim → best candidate @ cosine) ---');
for (const c of out.filter((_, i) => i % Math.ceil(out.length / 8) === 0)) {
  console.log(`\n[#${c.case_id}] cos=${c.top_cosine}`);
  console.log(`  claim:     ${c.claim.slice(0, 90)}`);
  console.log(`  best cand: ${c.candidates[0].value.slice(0, 90)}`);
}
