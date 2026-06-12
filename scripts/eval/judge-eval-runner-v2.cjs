/**
 * Judge eval-runner v2 — validates local judge candidates against the CURRENT production
 * contract (quick task 260611-ue6): contradicted_ids field in the prompt/verdict, plus
 * order-swap consistency resolution (JUDGE_ORDER_SWAP, chooseConsistentVerdict).
 *
 * Supersedes judge-eval-runner.cjs for model selection — the v1 runner tests the pre-M2
 * prompt and is kept untouched for comparability with the 2026-06-07 recorded runs.
 *
 *   NODE_PATH=$(pwd)/node_modules node scripts/eval/judge-eval-runner-v2.cjs \
 *     --eval scripts/eval/judge-eval-contradiction-set.json \
 *     --ollama "qwen3.6:35b-a3b,qwen3.6:27b,qwen2.5:7b-instruct" \
 *     --haiku claude-haiku-4-5
 *
 * New metrics vs v1:
 *   cid-recall   — contradict-labeled cases where contradicted_ids contains the labeled id
 *   cid-spurious — total ids emitted beyond the labeled one (over-tombstoning risk)
 *   swap-flip    — cases where forward and reversed orderings disagreed on relation
 *                  (resolved verdict is what gets scored — mirrors production)
 */
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// ---- args -----------------------------------------------------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const EVAL = arg('--eval', 'scripts/eval/judge-eval-contradiction-set.json');
const HAIKU = arg('--haiku', 'claude-haiku-4-5');          // pass --haiku "" to skip
const OLLAMA_MODELS = (arg('--ollama', 'qwen3.6:35b-a3b,qwen3.6:27b,qwen2.5:7b-instruct') || '').split(',').map(s => s.trim()).filter(Boolean);
const OLLAMA_URL = arg('--ollama-url', 'http://localhost:11434/v1');
const OUT = arg('--out', 'scripts/eval/judge-eval-v2-results.json');
const RELATIONS = ['confirm', 'extend', 'contradict', 'unrelated'];

// ---- faithful copy of the CURRENT engine judge prompt (src/model/judge.ts @ 260611-ue6) ----
const JUDGE_PROMPT_PREFIX = `You are a knowledge graph judge. Given a new claim and a list of candidate nodes from a knowledge graph, determine which candidate(s) (if any) the claim contradicts and which single candidate best matches overall.

Return ONLY valid JSON with exactly these fields:
{
  "best_candidate_id": "<id of best match, or null if none match>",
  "relation": "<confirm | extend | contradict | unrelated>",
  "magnitude": <float in [0.0, 1.0] — PE severity; use 0.0 for non-contradict>,
  "contradicted_ids": ["<id>", ...]
}

Relations:
- "confirm": claim reaffirms the candidate's existing value
- "extend": claim adds new information to the candidate
- "contradict": claim directly conflicts with the candidate (magnitude = severity of conflict)
- "unrelated": no meaningful match; use null for best_candidate_id

For relation "contradict": list the ids of ALL candidates the claim contradicts in "contradicted_ids" (best_candidate_id should also appear in the list). For every other relation use an empty array [].

New claim: `;

function buildPrompt(claim, candidates) {
  const candidateList = candidates.map(x => `  - id: "${x.id}", value: "${x.value}"`).join('\n');
  return JUDGE_PROMPT_PREFIX + `"${claim}"\n\nCandidates:\n${candidateList}\n\nReturn ONLY the JSON object.`;
}

// ---- faithful parseVerdict incl. contradicted_ids fail-safe (src/model/judge.ts) ----
function parseVerdict(text) {
  let obj = null, salvaged = false, ok = true;
  try { obj = JSON.parse(text); }
  catch {
    const m = text && text.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); salvaged = true; } catch { ok = false; } }
    else ok = false;
  }
  if (!obj || typeof obj !== 'object') return { best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [], parseOk: false, salvaged };
  const rel = RELATIONS.includes(obj.relation) ? obj.relation : 'unrelated';
  const mag = typeof obj.magnitude === 'number' ? Math.min(1, Math.max(0, obj.magnitude)) : 0;
  const bid = (typeof obj.best_candidate_id === 'string' && obj.best_candidate_id) ? obj.best_candidate_id : null;
  let cids = Array.isArray(obj.contradicted_ids)
    ? [...new Set(obj.contradicted_ids.filter(x => typeof x === 'string'))]
    : [];
  // production fail-safe: contradict with empty list → [best_candidate_id]; non-contradict → []
  if (rel === 'contradict') { if (cids.length === 0 && bid !== null) cids = [bid]; }
  else cids = [];
  return { best_candidate_id: bid, relation: rel, magnitude: mag, contradicted_ids: cids, parseOk: ok, salvaged };
}

// ---- faithful chooseConsistentVerdict (src/model/judge.ts @ 260611-ue6) ----
function chooseConsistentVerdict(v1, v2) {
  if (v1.relation === v2.relation) {
    if (v1.relation === 'contradict') {
      const v2Set = new Set(v2.contradicted_ids || []);
      return { ...v1, contradicted_ids: (v1.contradicted_ids || []).filter(id => v2Set.has(id)) };
    }
    return v1;
  }
  // disagreement: take the NON-destructive verdict — never escalate to contradict
  if (v1.relation === 'contradict') return v2;
  if (v2.relation === 'contradict') return v1;
  return v1;
}

// ---- providers ------------------------------------------------------------
async function callHaiku(client, prompt) {
  const msg = await client.messages.create({
    model: HAIKU, max_tokens: 256, temperature: 0,   // production pins temperature 0 (260611-tjw A1)
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}
async function callOllama(client, model, prompt) {
  // Mirrors v1 think-mode settings (validated): temperature 0, json_object, max_tokens 8192.
  const r = await client.chat.completions.create({
    model, temperature: 0, max_tokens: 8192,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });
  return r.choices?.[0]?.message?.content ?? '';
}

// ---- scoring --------------------------------------------------------------
const DANGER = (label, pred) => {
  if (label === 'contradict' && (pred === 'confirm' || pred === 'extend')) return 'strengthened-a-conflict';
  if (label === 'unrelated' && pred !== 'unrelated') return 'spurious-link';
  if ((label === 'confirm' || label === 'contradict') && pred === 'unrelated') return 'missed-relation';
  return null;
};

function score(rows) {
  const n = rows.length;
  let relCorrect = 0, bidCorrect = 0, bidTotal = 0, parseFail = 0, salvaged = 0, errors = 0;
  let cidRecallHit = 0, cidRecallTotal = 0, cidSpurious = 0, swapFlips = 0;
  const magAbs = []; const conf = {}; const dangers = {};
  for (const r of RELATIONS) conf[r] = { confirm: 0, extend: 0, contradict: 0, unrelated: 0 };
  for (const row of rows) {
    if (row.error) { errors++; continue; }
    if (!row.pred.parseOk) parseFail++;
    if (row.pred.salvaged) salvaged++;
    if (row.swapFlip) swapFlips++;
    conf[row.label.relation][row.pred.relation]++;
    if (row.label.relation === row.pred.relation) relCorrect++;
    if (row.label.relation !== 'unrelated') {
      bidTotal++;
      if (row.label.best_candidate_id && row.pred.best_candidate_id === row.label.best_candidate_id) bidCorrect++;
    }
    if (row.label.relation === 'contradict') {
      cidRecallTotal++;
      const cids = row.pred.contradicted_ids || [];
      if (row.label.best_candidate_id && cids.includes(row.label.best_candidate_id)) cidRecallHit++;
      cidSpurious += cids.filter(id => id !== row.label.best_candidate_id).length;
      if (typeof row.label.magnitude === 'number') magAbs.push(Math.abs(row.pred.magnitude - row.label.magnitude));
    }
    const d = DANGER(row.label.relation, row.pred.relation);
    if (d) dangers[d] = (dangers[d] || 0) + 1;
  }
  return {
    n, scored: n - errors, errors,
    relAcc: n - errors ? relCorrect / (n - errors) : 0,
    bidAcc: bidTotal ? bidCorrect / bidTotal : null,
    cidRecall: cidRecallTotal ? cidRecallHit / cidRecallTotal : null,
    cidSpurious, swapFlips,
    magMAE: magAbs.length ? magAbs.reduce((a, b) => a + b, 0) / magAbs.length : null,
    magN: magAbs.length, parseFail, salvaged, conf, dangers,
  };
}

// ---- main -----------------------------------------------------------------
(async () => {
  const all = JSON.parse(fs.readFileSync(EVAL, 'utf8'));
  const labeled = all.filter(c => c.label && RELATIONS.includes(c.label.relation));
  for (const c of labeled) {
    const li = c.label.best_candidate_index;
    if (li !== undefined && li !== null && li !== '' && Number(li) >= 0) {
      c.label.best_candidate_id = c.candidates[Number(li)] ? c.candidates[Number(li)].id : null;
    } else if (!c.label.best_candidate_id) {
      c.label.best_candidate_id = null;
    }
  }
  console.log(`Eval set: ${all.length} cases | labeled: ${labeled.length} | contract: contradicted_ids + order-swap (production @ 260611-ue6)`);
  if (!labeled.length) process.exit(0);

  const providers = [];
  if (HAIKU) {
    if (!process.env.ANTHROPIC_API_KEY) console.log('⚠ ANTHROPIC_API_KEY not set — skipping Haiku reference');
    else { const c = new Anthropic(); providers.push({ name: `haiku:${HAIKU}`, call: (p) => callHaiku(c, p) }); }
  }
  if (OLLAMA_MODELS.length) {
    const oc = new OpenAI({ baseURL: OLLAMA_URL, apiKey: 'ollama' });
    for (const m of OLLAMA_MODELS) providers.push({ name: `ollama:${m}`, call: (p) => callOllama(oc, m, p) });
  }
  if (!providers.length) process.exit(1);

  const results = {};
  for (const prov of providers) {
    process.stdout.write(`\nRunning ${prov.name} on ${labeled.length} cases (x2 calls: order-swap)`);
    const rows = [];
    const tStart = Date.now();
    for (const c of labeled) {
      try {
        // Production behavior: forward call, then reversed-candidates call, then resolve.
        const t1 = await prov.call(buildPrompt(c.claim, c.candidates));
        const v1 = parseVerdict(t1);
        let pred = v1, swapFlip = false;
        if (c.candidates.length >= 2) {
          const t2 = await prov.call(buildPrompt(c.claim, [...c.candidates].reverse()));
          const v2 = parseVerdict(t2);
          swapFlip = v1.relation !== v2.relation;
          pred = chooseConsistentVerdict(v1, v2);
          pred.parseOk = v1.parseOk && v2.parseOk;
          pred.salvaged = v1.salvaged || v2.salvaged;
        }
        rows.push({ case_id: c.case_id, label: c.label, pred, swapFlip, raw: t1.slice(0, 300) });
      } catch (e) {
        rows.push({ case_id: c.case_id, label: c.label, error: String(e.message || e).slice(0, 200) });
      }
      process.stdout.write('.');
    }
    const elapsedMs = Date.now() - tStart;
    results[prov.name] = { rows, score: score(rows), elapsedMs, perCaseMs: Math.round(elapsedMs / labeled.length) };
  }

  console.log('\n\n==================== JUDGE EVAL v2 (production contract) ====================');
  const hdr = ['provider', 'rel-acc', 'best-id', 'cid-recall', 'cid-spurious', 'swap-flips', 'mag-MAE', 'parse-fail', 'errors', 's/case'];
  console.log(hdr.join('  |  '));
  for (const [name, r] of Object.entries(results)) {
    const s = r.score;
    console.log([
      name,
      (s.relAcc * 100).toFixed(1) + '%',
      s.bidAcc == null ? 'n/a' : (s.bidAcc * 100).toFixed(1) + '%',
      s.cidRecall == null ? 'n/a' : (s.cidRecall * 100).toFixed(1) + '%',
      String(s.cidSpurious),
      String(s.swapFlips),
      s.magMAE == null ? 'n/a' : s.magMAE.toFixed(3),
      `${s.parseFail}${s.salvaged ? ` (+${s.salvaged} salvaged)` : ''}`,
      String(s.errors),
      (r.perCaseMs / 1000).toFixed(1),
    ].join('  |  '));
  }

  console.log('\n--- dangerous errors (graph-corrupting misclassifications) ---');
  for (const [name, { score: s }] of Object.entries(results)) {
    const tot = Object.values(s.dangers).reduce((a, b) => a + b, 0);
    console.log(`${name}: ${tot} total` + (tot ? ' — ' + Object.entries(s.dangers).map(([k, v]) => `${k}=${v}`).join(', ') : ''));
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nPer-case detail → ${OUT}`);
})();
