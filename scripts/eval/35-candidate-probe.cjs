#!/usr/bin/env node
/**
 * Candidate-surfacing probe (Phase 35 follow-up debug tool).
 *
 * Question: why does consolidation mint ~2000 'unrelated' nodes/case with 0 merges + 0
 * contradictions? The consolidator gate (consolidator.ts:680) auto-classifies a claim as
 * 'unrelated' WITHOUT the judge when:  candidates[0].score < unrelatedSimilarityThreshold (0.3)
 * AND no entity anchors.  This probe measures, EMBEDDINGS-ONLY (no judge, no claude -p, ~$0):
 *
 *   1. The in-order top-1 cosine distribution — for each claim, its best cosine match against
 *      the graph-so-far (claims 0..i-1), exactly what topk + cosineGate see. What fraction
 *      fall below the 0.3 gate (→ auto-'unrelated', judge never consulted)?
 *   2. Gold-update co-location — the claim closest to the gold answer (the "update"), and
 *      whether its top-K cosine neighbors (the contradicted prior should be here) clear 0.3.
 *
 * Splits the diagnosis: high %-below-threshold → candidate-surfacing/threshold is the
 * bottleneck (fix: candidateK↑ / threshold↓ / anchoring). Many clearing threshold but
 * still contra=0 → judge problem.
 *
 * CAVEAT: replicates the COSINE path only. The real consolidator also has entity-anchor
 * expansion (M1) that can escalate to the judge even when cosineGate fires; anchors are rare
 * on this data (no wikilinks / few provenance siblings), so the cosine path dominates.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/eval/35-candidate-probe.cjs [--limit-cases 1] [--candidate-k 5]
 *     [--threshold 0.3] [--max-claims 0]   # max-claims 0 = all
 */
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { OpenAIEmbedder } = require('../../dist/src/model/embedder');
const { cosineSimF32 }   = require('../../dist/src/retrieval/topk');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const CACHE_DIR  = arg('--cache', path.join(os.homedir(), '.recense-eval-cache/eval01-n20-2026-06-16'));
const LIMIT      = parseInt(arg('--limit-cases', '1'), 10) || 1;
const K          = parseInt(arg('--candidate-k', String(DEFAULT_CONFIG.candidateK ?? 5)), 10);
const THRESH     = parseFloat(arg('--threshold', String(DEFAULT_CONFIG.unrelatedSimilarityThreshold ?? 0.3)));
const MAX_CLAIMS = parseInt(arg('--max-claims', '0'), 10) || 0; // 0 = all

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY required (this probe is embeddings-only).');
  process.exit(1);
}

function parseJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

(async () => {
  const attr = parseJsonl(path.join(CACHE_DIR, 'n20-attribution.jsonl'));
  const ku   = parseJsonl(path.join(CACHE_DIR, 'eval20-ku.jsonl'));
  const kuByQid = new Map(ku.map(k => [k.question_id, k]));
  const embedder = new OpenAIEmbedder(DEFAULT_CONFIG.openaiEmbedModel, DEFAULT_CONFIG.embeddingDimensions);

  const cases = attr.filter(a => kuByQid.has(a.question_id)).slice(0, LIMIT);
  console.log(`Candidate-surfacing probe — ${cases.length} case(s) | candidateK=${K} | unrelatedSimilarityThreshold=${THRESH} | embedModel=${DEFAULT_CONFIG.openaiEmbedModel} dims=${DEFAULT_CONFIG.embeddingDimensions}`);
  console.log(`(embeddings-only; replays consolidator topk → cosineGate in claim order. No judge, no claude -p.)`);

  for (const c of cases) {
    const kc = kuByQid.get(c.question_id);
    let values = c.claims.map(cl => cl.value);
    if (MAX_CLAIMS > 0 && values.length > MAX_CLAIMS) values = values.slice(0, MAX_CLAIMS);
    const N = values.length;

    process.stdout.write(`\n[${c.question_id}] embedding ${N} claims + Q/A ...\r`);
    const vecs = await embedder.embed(values);
    const [qVec] = await embedder.embed([String(kc.question)]);
    const [aVec] = await embedder.embed([String(kc.answer)]);

    // 1. In-order top-1 cosine: claim i vs the graph-so-far (0..i-1) — exactly cosineGate's input.
    const buckets = { '<0.1': 0, '0.1-0.2': 0, '0.2-0.3': 0, '0.3-0.4': 0, '0.4-0.5': 0, '0.5-0.7': 0, '>=0.7': 0 };
    const top1 = [];
    let below = 0, atLeast = 0;
    for (let i = 1; i < N; i++) {
      let best = -1;
      for (let j = 0; j < i; j++) { const s = cosineSimF32(vecs[i], vecs[j]); if (s > best) best = s; }
      top1.push(best);
      if (best < THRESH) below++; else atLeast++;
      const b = best < 0.1 ? '<0.1' : best < 0.2 ? '0.1-0.2' : best < 0.3 ? '0.2-0.3'
        : best < 0.4 ? '0.3-0.4' : best < 0.5 ? '0.4-0.5' : best < 0.7 ? '0.5-0.7' : '>=0.7';
      buckets[b]++;
    }
    const sorted = [...top1].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = top1.reduce((a, b) => a + b, 0) / top1.length;
    const denom = N - 1;

    console.log(`\n[${c.question_id}]  type=${c.question_type}  claims=${N}`);
    console.log(`  Q: ${String(kc.question).slice(0, 110)}`);
    console.log(`  gold answer: ${String(kc.answer).slice(0, 110)}`);
    console.log(`  --- in-order top-1 cosine (each claim vs graph-so-far) ---`);
    for (const [k, v] of Object.entries(buckets)) {
      const pct = (100 * v / denom);
      console.log(`    ${k.padEnd(8)} ${String(v).padStart(5)}  ${'#'.repeat(Math.round(pct / 2))} ${pct.toFixed(1)}%`);
    }
    console.log(`    mean=${mean.toFixed(3)}  median=${median.toFixed(3)}`);
    console.log(`  GATE: ${below} (${(100 * below / denom).toFixed(1)}%) top-1 < ${THRESH} → auto-'unrelated', JUDGE NOT CALLED`);
    console.log(`        ${atLeast} (${(100 * atLeast / denom).toFixed(1)}%) clear ${THRESH} → would escalate to judge`);
    // Threshold sweep: what fraction would escalate to the judge at each candidate cutoff?
    console.log(`  --- escalation % vs unrelatedSimilarityThreshold (does lowering it un-starve the judge?) ---`);
    for (const t of [0.4, 0.3, 0.25, 0.2, 0.15, 0.1]) {
      const esc = top1.filter(s => s >= t).length;
      const pct = 100 * esc / denom;
      console.log(`    thr=${t.toFixed(2)}  escalate ${String(esc).padStart(5)} (${pct.toFixed(1)}%)  ${'#'.repeat(Math.round(pct / 2))}`);
    }

    // 2. Gold-update co-location: claim closest to the gold answer = the "update".
    let aIdx = -1, aBest = -1;
    for (let i = 0; i < N; i++) { const s = cosineSimF32(vecs[i], aVec); if (s > aBest) { aBest = s; aIdx = i; } }
    let qBest = -1, qIdx = -1;
    for (let i = 0; i < N; i++) { const s = cosineSimF32(vecs[i], qVec); if (s > qBest) { qBest = s; qIdx = i; } }
    const neigh = [];
    for (let j = 0; j < N; j++) { if (j === aIdx) continue; neigh.push([j, cosineSimF32(vecs[aIdx], vecs[j])]); }
    neigh.sort((a, b) => b[1] - a[1]);
    const nAbove = neigh.slice(0, K).filter(([, s]) => s >= THRESH).length;

    console.log(`  --- gold-update co-location ---`);
    console.log(`    update claim (closest to answer, cos=${aBest.toFixed(3)}): "${values[aIdx].slice(0, 95)}"`);
    console.log(`    claim closest to question (cos=${qBest.toFixed(3)}): "${values[qIdx].slice(0, 95)}"`);
    console.log(`    update→top-${K} cosine neighbors (the contradicted prior should appear here):`);
    for (let t = 0; t < K && t < neigh.length; t++) {
      const [j, s] = neigh[t];
      console.log(`      ${s.toFixed(3)} ${s >= THRESH ? '>=thr' : '< thr'}  "${values[j].slice(0, 80)}"`);
    }
    console.log(`    → ${nAbove}/${K} of the update's top neighbors clear ${THRESH} (reach the judge as candidates)`);
  }

  console.log(`\nRead: high %-below-threshold ⇒ candidate-surfacing/threshold is the bottleneck (fix candidateK↑ / threshold↓ / anchoring).`);
  console.log(`      Many clearing threshold but contra still 0 in the real run ⇒ judge problem instead.`);
})().catch(e => { console.error('probe error:', e.stack || e.message || e); process.exit(1); });
