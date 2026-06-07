/**
 * Contradiction-focused judge eval-set builder (read-only on brain.db, no API calls).
 *
 * WHY THIS EXISTS: the cosine gray-zone extractor (judge-eval-extract.cjs) surfaces almost
 * no contradictions — conflicting values on the same subject do NOT sit in the mid-cosine
 * band, so the mined 48-case set had only n=1 contradiction (and both local Qwen models
 * missed it, calling the conflict `extend` — the graph-corrupting direction). The judge's
 * load-bearing dimension (contradiction detection + 0–1 magnitude calibration) was therefore
 * essentially untested.
 *
 * So contradictions are CONSTRUCTED, not mined: each case takes a REAL brain.db node as the
 * stored belief (candidate) and pairs it with a hand-authored claim that states an opposing
 * value on the same subject, hand-labeled relation=contradict with a calibrated magnitude
 * (mild correction ~0.3 → categorical reversal ~0.9). Near-miss controls (same subject but
 * actually confirm/extend) keep the set from being gamed by always answering "contradict".
 *
 * Candidates for each case = the target node + its top real cosine neighbors from brain.db,
 * mirroring what the consolidator would co-retrieve when judging a claim about that subject.
 * Target placement varies per case so the right answer is not always candidate[0].
 *
 * Output schema matches judge-eval-runner.cjs exactly:
 *   { case_id, claim, candidates:[{id,value,cosine}], top_cosine, band,
 *     label:{ best_candidate_index, relation, magnitude } }
 *
 * Run:  node scripts/eval/judge-eval-contradiction-build.cjs ./brain.db
 */
const Database = require('better-sqlite3');
const fs = require('fs');

const DB = process.argv[2] || './brain.db';
const OUT = 'scripts/eval/judge-eval-contradiction-set.json';
const NEIGHBORS = 3; // real distractor candidates added alongside each target

// ---- hand-authored cases (the experiment design; grounded in real node ids) ----
// magnitude calibration:
//   ~0.3  mild correction / numeric drift on the same kind of fact
//   ~0.45-0.55 moderate: a parameter/region/SKU change
//   ~0.6-0.7  significant: role/direction reversal
//   ~0.85-0.9 categorical/definitional reversal
// target_slot = index where the target (correct candidate) is placed among neighbors.
const CASES = [
  // ---- contradictions (n=13) ----
  { target_value_hint: "HTTP 431 means 'Request Header Fields Too Large' — server rejected the request because headers sent were too big",
    claim: "HTTP 431 is returned when the server times out waiting for the client to finish sending its request.",
    relation: 'contradict', magnitude: 0.9, target_slot: 0 },

  { target_value_hint: "OpenAI text-embedding models cannot be switched to Vertex without re-embedding the entire knowledge graph due to different vector dimensions",
    claim: "OpenAI text-embedding vectors are the same dimensionality as Vertex's, so we can switch embedding providers without re-embedding the graph.",
    relation: 'contradict', magnitude: 0.85, target_slot: 1 },

  { target_value_hint: "Single-developer personal tool with one user; no multi-tenant or production traffic and no near-term scaling plans",
    claim: "brain-memory runs as a multi-tenant production service handling concurrent traffic from many users.",
    relation: 'contradict', magnitude: 0.9, target_slot: 0 },

  { target_value_hint: "Stop hook triggers consolidation directly, launchd is belt-and-suspenders fallback for unclean session exits",
    claim: "launchd is what triggers consolidation directly; the Stop hook is only the belt-and-suspenders fallback for unclean exits.",
    relation: 'contradict', magnitude: 0.7, target_slot: 2 },

  { target_value_hint: "Fast mitigation for cross-project bleed: move three hooks from ~/.claude/settings.json to brain-memory/.claude/settings.json",
    claim: "To fix the cross-project bleed, move the three hooks out of brain-memory/.claude/settings.json and back into the global ~/.claude/settings.json.",
    relation: 'contradict', magnitude: 0.6, target_slot: 1 },

  { target_value_hint: "Claude-on-Vertex is billed as Model Garden partner-model inference, a different billing SKU than GenAI App Builder",
    claim: "Claude-on-Vertex is billed under the same SKU as GenAI App Builder.",
    relation: 'contradict', magnitude: 0.55, target_slot: 0 },

  { target_value_hint: "adaptive-thinking.log has not been touched since Apr 16, indicating the classifier has been inactive for approximately 7 weeks",
    claim: "adaptive-thinking.log is being written continuously — the classifier has been active the entire time.",
    relation: 'contradict', magnitude: 0.7, target_slot: 1 },

  { target_value_hint: "Azure for Students provides $100 credit with no hard RPM limits, covering chat and embeddings in one credit pool",
    claim: "Azure for Students gives a $100 credit but enforces strict hard RPM limits on chat and embeddings.",
    relation: 'contradict', magnitude: 0.5, target_slot: 0 },

  { target_value_hint: "fusion: pin on faint street grid with small dot center, ship (4.5), most on-brand storytelling, represents spot-in-spot put-on chain",
    claim: "fusion was the weakest, least on-brand icon concept and got dropped from the shortlist.",
    relation: 'contradict', magnitude: 0.7, target_slot: 2 },

  { target_value_hint: "For single-user dogfood testing, start with rock-bottom quota to get unblocked today, then re-up when limits are hit",
    claim: "For the single-user dogfood, request a large quota upfront rather than starting at rock-bottom.",
    relation: 'contradict', magnitude: 0.5, target_slot: 1 },

  { target_value_hint: "createAnthropicClient routes all LLM calls including judge, claim-extractor, schema-naming, and recall-compose through the configured provider",
    claim: "createAnthropicClient only routes the judge call; the claim-extractor and schema-naming use a separate hardcoded Anthropic client.",
    relation: 'contradict', magnitude: 0.6, target_slot: 0 },

  { target_value_hint: "Must request online_prediction_requests_per_minute_per_base_model quota of approximately 60 requests/min for anthropic-claude-haiku-4-5 in us-east5",
    claim: "The anthropic-claude-haiku-4-5 requests/min quota should be requested in us-central1.",
    relation: 'contradict', magnitude: 0.45, target_slot: 1 },

  { target_value_hint: "brain.db holds 149 live nodes from sessions with engine ranking and injecting top ~2000 chars",
    claim: "The engine's brain.db now holds roughly 1,300 live nodes.",
    relation: 'contradict', magnitude: 0.3, target_slot: 0 },

  // ---- near-miss controls (n=4): same subject, NOT a conflict ----
  { target_value_hint: "HTTP 431 means 'Request Header Fields Too Large' — server rejected the request because headers sent were too big",
    claim: "HTTP 431 'Request Header Fields Too Large' is returned when the request headers are too big.",
    relation: 'confirm', magnitude: 0, target_slot: 0 },

  { target_value_hint: "Single-developer personal tool with one user; no multi-tenant or production traffic and no near-term scaling plans",
    claim: "This is a single-developer personal tool with one user and no production traffic or near-term scaling plans.",
    relation: 'confirm', magnitude: 0, target_slot: 1 },

  { target_value_hint: "Stop hook triggers consolidation directly, launchd is belt-and-suspenders fallback for unclean session exits",
    claim: "The Stop hook's consolidation runs the offline sleep pass, which calls Haiku once per episode.",
    relation: 'extend', magnitude: 0, target_slot: 0 },

  { target_value_hint: "Must request online_prediction_requests_per_minute_per_base_model quota of approximately 60 requests/min for anthropic-claude-haiku-4-5 in us-east5",
    claim: "The us-east5 haiku quota request should also document the single-user dogfood usage to speed approval.",
    relation: 'extend', magnitude: 0, target_slot: 1 },
];

// ---- helpers (mirror judge-eval-extract.cjs) ----
function decode(buf) {
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
const byNormValue = new Map(nodes.map(n => [norm(n.value), n]));

const out = [];
const missing = [];
CASES.forEach((c, idx) => {
  const target = byNormValue.get(norm(c.target_value_hint));
  if (!target) { missing.push(c.target_value_hint.slice(0, 60)); return; }

  // top real cosine neighbors (exclude self + exact value dups)
  const scored = nodes
    .filter(m => m.id !== target.id && norm(m.value) !== norm(target.value))
    .map(m => ({ id: m.id, value: m.value, cos: cosine(target.vec, m.vec) }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, NEIGHBORS);

  // assemble candidate list with the target inserted at target_slot
  const cands = scored.map(s => ({ id: s.id, value: s.value, cosine: +s.cos.toFixed(3) }));
  const slot = Math.min(c.target_slot, cands.length);
  cands.splice(slot, 0, { id: target.id, value: target.value, cosine: 1.0 });

  out.push({
    case_id: idx + 1,
    claim: c.claim,
    candidates: cands,
    top_cosine: Math.max(...scored.map(s => s.cos), 0).toFixed ? +Math.max(...scored.map(s => s.cos)).toFixed(3) : 0,
    band: null,
    label: { best_candidate_index: slot, relation: c.relation, magnitude: c.magnitude },
  });
});

if (missing.length) {
  console.error(`\n⚠ ${missing.length} target value(s) not found in ${DB} (skipped):`);
  missing.forEach(m => console.error(`   - ${m}`));
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
const byRel = out.reduce((a, c) => (a[c.label.relation] = (a[c.label.relation] || 0) + 1, a), {});
console.log(`\nWrote ${out.length} cases → ${OUT}`);
console.log('Relation spread:', Object.entries(byRel).map(([k, v]) => `${k}=${v}`).join('  '));
console.log('Contradiction magnitudes:', out.filter(c => c.label.relation === 'contradict').map(c => c.label.magnitude).sort((a, b) => a - b).join(', '));
console.log('\n--- sample (claim → target value @ slot) ---');
for (const c of out.filter((_, i) => i % 4 === 0)) {
  const t = c.candidates[c.label.best_candidate_index];
  console.log(`\n[#${c.case_id}] ${c.label.relation}${c.label.relation === 'contradict' ? ' mag=' + c.label.magnitude : ''} (slot ${c.label.best_candidate_index}/${c.candidates.length})`);
  console.log(`  claim:  ${c.claim.slice(0, 100)}`);
  console.log(`  target: ${t.value.slice(0, 100)}`);
}
