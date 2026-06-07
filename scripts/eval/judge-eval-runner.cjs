/**
 * Judge eval-runner — Haiku 4.5 vs local Qwen candidates on the brain-memory judge task.
 * Read-only experiment; touches no repo code. Run from the repo so node_modules resolves:
 *
 *   NODE_PATH=$(pwd)/node_modules \
 *   node scripts/eval/judge-eval-runner.cjs \
 *     --eval scripts/eval/judge-eval-set.json \
 *     --ollama "qwen3.6:27b,qwen3.6:35b-a3b" \
 *     --haiku claude-haiku-4-5
 *
 * Pull the local models first (`ollama pull qwen3.6:27b`), and pass the EXACT tags
 * from `ollama list` — the qwen3.6 tags below are placeholders.
 * Requires ANTHROPIC_API_KEY in env for the Haiku baseline (omit --haiku to skip it).
 * Scores ONLY cases you've labeled; unlabeled cases are reported and skipped.
 */
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// ---- args -----------------------------------------------------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const EVAL = arg('--eval', 'scripts/eval/judge-eval-set.json');
const HAIKU = arg('--haiku', 'claude-haiku-4-5');          // pass --haiku "" to skip
const OLLAMA_MODELS = (arg('--ollama', 'qwen3.6:27b,qwen3.6:35b-a3b') || '').split(',').map(s => s.trim()).filter(Boolean);
const OLLAMA_URL = arg('--ollama-url', 'http://localhost:11434/v1');
const OUT = arg('--out', 'scripts/eval/judge-eval-results.json');
const RELATIONS = ['confirm', 'extend', 'contradict', 'unrelated'];

// ---- faithful copy of the engine's judge prompt (src/model/judge.ts) -------
const JUDGE_PROMPT_PREFIX = `You are a knowledge graph judge. Given a new claim and a list of candidate nodes from a knowledge graph, determine which single candidate (if any) best matches the claim and how they relate.

Return ONLY valid JSON with exactly these fields:
{
  "best_candidate_id": "<id of best match, or null if none match>",
  "relation": "<confirm | extend | contradict | unrelated>",
  "magnitude": <float in [0.0, 1.0] — PE severity; use 0.0 for non-contradict>
}

Relations:
- "confirm": claim reaffirms the candidate's existing value
- "extend": claim adds new information to the candidate
- "contradict": claim directly conflicts with the candidate (magnitude = severity of conflict)
- "unrelated": no meaningful match; use null for best_candidate_id

New claim: `;

function buildPrompt(c) {
  const candidateList = c.candidates.map(x => `  - id: "${x.id}", value: "${x.value}"`).join('\n');
  return JUDGE_PROMPT_PREFIX + `"${c.claim}"\n\nCandidates:\n${candidateList}\n\nReturn ONLY the JSON object.`;
}

// ---- faithful-ish parseVerdict (tolerant: salvage first {...}; track parse health) ----
function parseVerdict(text) {
  let obj = null, salvaged = false, ok = true;
  try { obj = JSON.parse(text); }
  catch {
    const m = text && text.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); salvaged = true; } catch { ok = false; } }
    else ok = false;
  }
  if (!obj || typeof obj !== 'object') return { best_candidate_id: null, relation: 'unrelated', magnitude: 0, parseOk: false, salvaged };
  const rel = RELATIONS.includes(obj.relation) ? obj.relation : 'unrelated';
  const mag = typeof obj.magnitude === 'number' ? Math.min(1, Math.max(0, obj.magnitude)) : 0;
  const bid = (typeof obj.best_candidate_id === 'string' && obj.best_candidate_id) ? obj.best_candidate_id : null;
  return { best_candidate_id: bid, relation: rel, magnitude: mag, parseOk: ok, salvaged };
}

// ---- providers ------------------------------------------------------------
async function callHaiku(client, prompt) {
  const msg = await client.messages.create({
    model: HAIKU, max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}
async function callOllama(client, model, prompt) {
  const r = await client.chat.completions.create({
    model, temperature: 0, max_tokens: 8192,   // Qwen 3.6 are reasoning models — leave room for the think pass + JSON (256 truncated mid-thought → empty content)
    response_format: { type: 'json_object' },   // Ollama JSON mode — matches production's format constraint
    messages: [{ role: 'user', content: prompt }],
  });
  return r.choices?.[0]?.message?.content ?? '';
}

// ---- scoring --------------------------------------------------------------
const DANGER = (label, pred) => {
  if (label === 'contradict' && (pred === 'confirm' || pred === 'extend')) return 'strengthened-a-conflict';   // worst: stale fact reinforced
  if (label === 'unrelated' && pred !== 'unrelated') return 'spurious-link';                                    // mints junk edges/contradictions
  if ((label === 'confirm' || label === 'contradict') && pred === 'unrelated') return 'missed-relation';        // drops a real relationship
  return null;
};

function score(rows) {
  const n = rows.length;
  let relCorrect = 0, bidCorrect = 0, bidTotal = 0, parseFail = 0, salvaged = 0, errors = 0;
  const magAbs = []; const conf = {}; const dangers = {};
  for (const r of RELATIONS) conf[r] = { confirm: 0, extend: 0, contradict: 0, unrelated: 0 };
  for (const row of rows) {
    if (row.error) { errors++; continue; }
    if (!row.pred.parseOk) parseFail++;
    if (row.pred.salvaged) salvaged++;
    conf[row.label.relation][row.pred.relation]++;
    if (row.label.relation === row.pred.relation) relCorrect++;
    // best_candidate_id (skip unrelated labels)
    if (row.label.relation !== 'unrelated') {
      bidTotal++;
      if (row.label.best_candidate_id && row.pred.best_candidate_id === row.label.best_candidate_id) bidCorrect++;
    }
    // magnitude MAE only on labeled contradicts with a numeric label magnitude
    if (row.label.relation === 'contradict' && typeof row.label.magnitude === 'number') {
      magAbs.push(Math.abs(row.pred.magnitude - row.label.magnitude));
    }
    const d = DANGER(row.label.relation, row.pred.relation);
    if (d) dangers[d] = (dangers[d] || 0) + 1;
  }
  return {
    n, scored: n - errors, errors,
    relAcc: n - errors ? relCorrect / (n - errors) : 0,
    bidAcc: bidTotal ? bidCorrect / bidTotal : null,
    magMAE: magAbs.length ? magAbs.reduce((a, b) => a + b, 0) / magAbs.length : null,
    magN: magAbs.length, parseFail, salvaged, conf, dangers,
  };
}

// ---- main -----------------------------------------------------------------
(async () => {
  const all = JSON.parse(fs.readFileSync(EVAL, 'utf8'));
  const labeled = all.filter(c => c.label && RELATIONS.includes(c.label.relation));
  // Resolve best_candidate_index (0-based; '' or -1 = none) → best_candidate_id for scoring
  for (const c of labeled) {
    const li = c.label.best_candidate_index;
    if (li !== undefined && li !== null && li !== '' && Number(li) >= 0) {
      c.label.best_candidate_id = c.candidates[Number(li)] ? c.candidates[Number(li)].id : null;
    } else if (!c.label.best_candidate_id) {
      c.label.best_candidate_id = null;
    }
  }
  const badLabels = all.filter(c => c.label && c.label.relation && !RELATIONS.includes(c.label.relation));
  console.log(`Eval set: ${all.length} cases | labeled: ${labeled.length} | unlabeled (skipped): ${all.length - labeled.length}`);
  if (badLabels.length) console.log(`⚠ ${badLabels.length} case(s) have an invalid relation label (must be one of ${RELATIONS.join('/')})`);
  if (!labeled.length) { console.log('\nNothing labeled yet — fill in label.relation (+ best_candidate_id, magnitude for contradicts) in ' + EVAL); process.exit(0); }

  const providers = [];
  if (HAIKU) {
    if (!process.env.ANTHROPIC_API_KEY) console.log('⚠ ANTHROPIC_API_KEY not set — skipping Haiku baseline');
    else { const c = new Anthropic(); providers.push({ name: `haiku:${HAIKU}`, call: (p) => callHaiku(c, p) }); }
  }
  if (OLLAMA_MODELS.length) {
    const oc = new OpenAI({ baseURL: OLLAMA_URL, apiKey: 'ollama' });
    for (const m of OLLAMA_MODELS) providers.push({ name: `ollama:${m}`, call: (p) => callOllama(oc, m, p) });
  }
  if (!providers.length) { console.log('No providers to test.'); process.exit(1); }

  const results = {};
  for (const prov of providers) {
    process.stdout.write(`\nRunning ${prov.name} on ${labeled.length} cases`);
    const rows = [];
    for (const c of labeled) {
      const prompt = buildPrompt(c);
      try {
        const text = await prov.call(prompt);
        rows.push({ case_id: c.case_id, label: c.label, pred: parseVerdict(text), raw: text.slice(0, 300) });
      } catch (e) {
        rows.push({ case_id: c.case_id, label: c.label, error: String(e.message || e).slice(0, 200) });
      }
      process.stdout.write('.');
    }
    results[prov.name] = { rows, score: score(rows) };
  }

  // ---- report ----
  console.log('\n\n========================= JUDGE EVAL =========================');
  const hdr = ['provider', 'rel-acc', 'best-id-acc', 'mag-MAE(contradict)', 'parse-fail', 'errors'];
  console.log(hdr.join('  |  '));
  for (const [name, { score: s }] of Object.entries(results)) {
    console.log([
      name,
      (s.relAcc * 100).toFixed(1) + '%',
      s.bidAcc == null ? 'n/a' : (s.bidAcc * 100).toFixed(1) + '%',
      s.magMAE == null ? `n/a(0)` : `${s.magMAE.toFixed(3)} (n=${s.magN})`,
      `${s.parseFail}${s.salvaged ? ` (+${s.salvaged} salvaged)` : ''}`,
      String(s.errors),
    ].join('  |  '));
  }

  console.log('\n--- dangerous errors (graph-corrupting misclassifications) ---');
  for (const [name, { score: s }] of Object.entries(results)) {
    const d = s.dangers; const tot = Object.values(d).reduce((a, b) => a + b, 0);
    console.log(`${name}: ${tot} total` + (tot ? ' — ' + Object.entries(d).map(([k, v]) => `${k}=${v}`).join(', ') : ''));
  }

  console.log('\n--- confusion matrices (rows=label, cols=prediction) ---');
  for (const [name, { score: s }] of Object.entries(results)) {
    console.log(`\n${name}`);
    console.log('              ' + RELATIONS.map(r => r.slice(0, 8).padStart(9)).join(''));
    for (const r of RELATIONS) console.log(r.padEnd(13) + RELATIONS.map(p => String(s.conf[r][p]).padStart(9)).join(''));
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nPer-case detail (incl. raw model output) → ${OUT}`);
  console.log('\nNote: Ollama calls run at temperature 0 (greedy) for stable comparison; Haiku uses default sampling.');
})();
