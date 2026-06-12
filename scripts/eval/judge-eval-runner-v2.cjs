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
 * Batch mode (mirrors engine's judgeBatch, quick task 260612-lc0):
 *   ... --batch 4
 * Groups labeled cases into k-sized batches; issues one LLM call per batch using the
 * engine's JUDGE_BATCH_PROMPT_PREFIX prompt format; applies order-swap (second batch
 * only for contradict items); scores per-case against labeled ground truth.
 * k=1 calls single-claim path per case (equivalent to default mode).
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
// --batch <k>: run in batch mode — groups labeled cases into k-sized batches, issues one
//   LLM call per batch using the engine's batch prompt (JUDGE_BATCH_PROMPT_PREFIX), applies
//   order-swap (second batch only for contradict items), scores per-case. k=1 is equivalent
//   to single-case mode for validation purposes.
const BATCH_K_RAW = arg('--batch', '0');
const BATCH_K = parseInt(BATCH_K_RAW, 10);

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

// ---- faithful copy of batch prompt prefix (src/model/judge.ts @ 260612-lc0) ----
// Relations block and contradicted_ids instruction copied verbatim from JUDGE_PROMPT_PREFIX.
const JUDGE_BATCH_PROMPT_PREFIX = `You are a knowledge graph judge. For EACH numbered claim below, determine which of ITS candidates (if any) it contradicts and which single candidate best matches.
Return ONLY a valid JSON array with EXACTLY one verdict object per claim, in claim order:
[{"claim_index": <int>, "best_candidate_id": ..., "relation": ..., "magnitude": ..., "contradicted_ids": [...]}, ...]

Relations:
- "confirm": claim reaffirms the candidate's existing value
- "extend": claim adds new information to the candidate
- "contradict": claim directly conflicts with the candidate (magnitude = severity of conflict)
- "unrelated": no meaningful match; use null for best_candidate_id

For relation "contradict": list the ids of ALL candidates the claim contradicts in "contradicted_ids" (best_candidate_id should also appear in the list). For every other relation use an empty array [].

`;

function buildPrompt(claim, candidates) {
  const candidateList = candidates.map(x => `  - id: "${x.id}", value: "${x.value}"`).join('\n');
  return JUDGE_PROMPT_PREFIX + `"${claim}"\n\nCandidates:\n${candidateList}\n\nReturn ONLY the JSON object.`;
}

// Build a batch prompt for k items (mirrors AnthropicJudge.judgeBatchOnce, 260612-lc0)
function buildBatchPrompt(items) {
  const parts = [JUDGE_BATCH_PROMPT_PREFIX];
  for (let i = 0; i < items.length; i++) {
    const candidateList = items[i].candidates.map(x => `  - id: "${x.id}", value: "${x.value}"`).join('\n');
    parts.push(`Claim ${i}: "${items[i].claim}"\nCandidates for claim ${i}:\n${candidateList}`);
  }
  return parts.join('\n') + '\n\nReturn ONLY the JSON array.';
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

// ---- parseVerdictBatch — mirrors src/model/judge.ts parseVerdictBatch (260612-lc0) ----
// perItemCandidateIds: Array of Set<string>, one per batch item (T-UE6-02 defensive filter).
const SAFE_VERDICT = { best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] };

function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function parseVerdictBatch(text, n, perItemCandidateIds) {
  const result = Array.from({ length: n }, () => ({ ...SAFE_VERDICT, parseOk: true, salvaged: false }));
  try {
    const json = extractJsonArray(text);
    if (json === null) {
      for (const r of result) r.parseOk = false;
      return result;
    }
    let rawArr;
    try { rawArr = JSON.parse(json); } catch {
      for (const r of result) r.parseOk = false;
      return result;
    }
    if (!Array.isArray(rawArr)) {
      for (const r of result) r.parseOk = false;
      return result;
    }
    for (let i = 0; i < rawArr.length; i++) {
      const raw = rawArr[i];
      if (typeof raw !== 'object' || raw === null) continue; // malformed → leave SAFE

      // Map by claim_index when present/valid; else fall back to array position i
      const claimIndexField = raw['claim_index'];
      let slotIdx;
      if (typeof claimIndexField === 'number' && Number.isInteger(claimIndexField) && claimIndexField >= 0 && claimIndexField < n) {
        slotIdx = claimIndexField;
      } else {
        slotIdx = i;
        if (slotIdx >= n) continue;
      }

      // Apply T-02-PARSE validations (mirrors parseVerdict)
      const relation = raw['relation'];
      const magnitude = raw['magnitude'];
      const bestId = raw['best_candidate_id'];

      if (typeof relation !== 'string' || !RELATIONS.includes(relation)) continue; // leave SAFE

      const mag = typeof magnitude === 'number' ? Math.min(1, Math.max(0, magnitude)) : 0;
      const candidateId = (bestId === null || bestId === undefined) ? null : (typeof bestId === 'string' ? bestId : null);

      // contradicted_ids: same T-02-PARSE logic as parseVerdict
      const rawIds = raw['contradicted_ids'];
      let contradictedIds = Array.isArray(rawIds)
        ? [...new Set(rawIds.filter(x => typeof x === 'string'))]
        : [];
      if (relation === 'contradict') {
        if (contradictedIds.length === 0 && candidateId !== null) contradictedIds = [candidateId]; // contradict-fail-safe
        // T-UE6-02 defensive filter: drop ids outside the actual candidate set for this slot
        const validIds = perItemCandidateIds[slotIdx];
        if (validIds !== undefined) {
          contradictedIds = contradictedIds.filter(id => validIds.has(id));
          // Re-apply fail-safe after filtering
          if (contradictedIds.length === 0 && candidateId !== null && validIds.has(candidateId)) {
            contradictedIds = [candidateId];
          }
        }
      } else {
        contradictedIds = []; // non-contradict: force empty
      }

      result[slotIdx] = { best_candidate_id: candidateId, relation, magnitude: mag, contradicted_ids: contradictedIds, parseOk: true, salvaged: false };
    }
  } catch {
    // Whole-array parse failure → all SAFE_VERDICT
    return Array.from({ length: n }, () => ({ ...SAFE_VERDICT, parseOk: false, salvaged: false }));
  }
  return result;
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
async function callHaikuBatch(client, prompt, batchSize) {
  // Batch calls need more tokens for N verdict objects; mirrors engine max_tokens heuristic
  const maxTokens = Math.min(8192, Math.max(512, 512 * batchSize));
  const msg = await client.messages.create({
    model: HAIKU, max_tokens: maxTokens, temperature: 0,
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
async function callOllamaBatch(client, model, prompt) {
  // Batch response is a JSON array, not a single object — use text format, not json_object.
  const r = await client.chat.completions.create({
    model, temperature: 0, max_tokens: 8192,
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

// ---- batch execution (260612-lc0) ----------------------------------------
// Mirrors AnthropicJudge.judgeBatch: one forward batch call, then ONE swap batch for
// any contradict items (<=2 LLM calls total per batch of k). Scoring is per-case.
async function runBatchMode(prov, labeled, batchSize, rows) {
  // Group labeled cases into chunks of batchSize
  for (let chunkStart = 0; chunkStart < labeled.length; chunkStart += batchSize) {
    const chunk = labeled.slice(chunkStart, chunkStart + batchSize);

    // Filter zero-candidate items → SAFE_VERDICT slot; exclude from prompt
    const promptItems = [];    // { localIdx, c } — items with candidates
    const zeroIdxs = [];       // local indices of zero-candidate items
    for (let j = 0; j < chunk.length; j++) {
      if (!chunk[j].candidates || chunk[j].candidates.length === 0) {
        zeroIdxs.push(j);
      } else {
        promptItems.push({ localIdx: j, c: chunk[j] });
      }
    }

    // Slot verdicts indexed by chunk position; zero-candidate slots pre-filled as SAFE
    const chunkVerdicts = Array.from({ length: chunk.length }, () => null);
    for (const idx of zeroIdxs) {
      chunkVerdicts[idx] = { ...SAFE_VERDICT, parseOk: true, salvaged: false, swapFlip: false };
    }

    try {
      if (promptItems.length === 0) {
        // Nothing to call — all slots already filled with SAFE
      } else if (promptItems.length === 1) {
        // Batch size 1 — delegate to single-claim path (mirrors engine rule)
        const { localIdx, c } = promptItems[0];
        const t1 = await prov.callSingle(buildPrompt(c.claim, c.candidates));
        const v1 = parseVerdict(t1);
        let pred = v1, swapFlip = false;
        if (c.candidates.length >= 2) {
          const t2 = await prov.callSingle(buildPrompt(c.claim, [...c.candidates].reverse()));
          const v2 = parseVerdict(t2);
          swapFlip = v1.relation !== v2.relation;
          pred = chooseConsistentVerdict(v1, v2);
          pred.parseOk = v1.parseOk && v2.parseOk;
          pred.salvaged = v1.salvaged || v2.salvaged;
        }
        chunkVerdicts[localIdx] = { ...pred, swapFlip };
      } else {
        // Batch > 1: one forward batch call
        const batchPromptItems = promptItems.map(({ c }) => ({ claim: c.claim, candidates: c.candidates }));
        const perItemCandidateIds = promptItems.map(({ c }) => new Set(c.candidates.map(x => x.id)));
        const batchK = promptItems.length;

        const t1 = await prov.callBatch(buildBatchPrompt(batchPromptItems), batchK);
        const v1Verdicts = parseVerdictBatch(t1, batchK, perItemCandidateIds);

        // Assign v1 verdicts to chunk slots (promptItems are in order, so v1Verdicts[i] → promptItems[i])
        for (let i = 0; i < promptItems.length; i++) {
          chunkVerdicts[promptItems[i].localIdx] = { ...v1Verdicts[i], swapFlip: false };
        }

        // Order-swap: collect prompt-local indices where v1 is contradict + >=2 candidates
        const swapIndices = []; // indices into promptItems / v1Verdicts
        for (let i = 0; i < promptItems.length; i++) {
          if (v1Verdicts[i].relation === 'contradict' && promptItems[i].c.candidates.length >= 2) {
            swapIndices.push(i);
          }
        }

        if (swapIndices.length > 0) {
          // ONE second batch call containing only the contradict items with reversed candidates
          const swapItems = swapIndices.map(i => ({
            claim: promptItems[i].c.claim,
            candidates: [...promptItems[i].c.candidates].reverse(),
          }));
          const swapCandidateIds = swapIndices.map(i => new Set(promptItems[i].c.candidates.map(x => x.id)));
          const t2 = await prov.callBatch(buildBatchPrompt(swapItems), swapItems.length);
          const v2Verdicts = parseVerdictBatch(t2, swapItems.length, swapCandidateIds);

          for (let si = 0; si < swapIndices.length; si++) {
            const promptIdx = swapIndices[si];
            const chunkIdx = promptItems[promptIdx].localIdx;
            const v1 = v1Verdicts[promptIdx];
            const v2 = v2Verdicts[si];
            const swapFlip = v1.relation !== v2.relation;
            const resolved = chooseConsistentVerdict(v1, v2);
            resolved.parseOk = v1.parseOk && v2.parseOk;
            resolved.salvaged = v1.salvaged || v2.salvaged;
            chunkVerdicts[chunkIdx] = { ...resolved, swapFlip };
          }
        }
      }

      // Emit rows for this chunk
      for (let j = 0; j < chunk.length; j++) {
        const c = chunk[j];
        const verdict = chunkVerdicts[j] || { ...SAFE_VERDICT, parseOk: false, salvaged: false, swapFlip: false };
        const { swapFlip, ...pred } = verdict;
        rows.push({ case_id: c.case_id, label: c.label, pred, swapFlip: swapFlip || false });
        process.stdout.write('.');
      }
    } catch (e) {
      for (const c of chunk) {
        rows.push({ case_id: c.case_id, label: c.label, error: String(e.message || e).slice(0, 200) });
        process.stdout.write('!');
      }
    }
  }
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

  const modeLabel = BATCH_K > 1 ? `batch-k=${BATCH_K}` : 'single-claim';
  console.log(`Eval set: ${all.length} cases | labeled: ${labeled.length} | contract: contradicted_ids + order-swap (production @ 260611-ue6) | mode: ${modeLabel}`);
  if (!labeled.length) process.exit(0);

  const providers = [];
  if (HAIKU) {
    if (!process.env.ANTHROPIC_API_KEY) console.log('warning: ANTHROPIC_API_KEY not set — skipping Haiku reference');
    else {
      const c = new Anthropic();
      providers.push({
        name: `haiku:${HAIKU}`,
        callSingle: (p) => callHaiku(c, p),
        callBatch: (p, k) => callHaikuBatch(c, p, k),
      });
    }
  }
  if (OLLAMA_MODELS.length) {
    const oc = new OpenAI({ baseURL: OLLAMA_URL, apiKey: 'ollama' });
    for (const m of OLLAMA_MODELS) {
      providers.push({
        name: `ollama:${m}`,
        callSingle: (p) => callOllama(oc, m, p),
        callBatch: (p) => callOllamaBatch(oc, m, p),
      });
    }
  }
  if (!providers.length) process.exit(1);

  const results = {};
  for (const prov of providers) {
    if (BATCH_K > 1) {
      // ---- batch mode (260612-lc0) ----------------------------------------
      const batchCount = Math.ceil(labeled.length / BATCH_K);
      process.stdout.write(`\nRunning ${prov.name} [BATCH k=${BATCH_K}] on ${labeled.length} cases (~${batchCount} batches, <=2 LLM calls/batch)`);
      const rows = [];
      const tStart = Date.now();
      await runBatchMode(prov, labeled, BATCH_K, rows);
      const elapsedMs = Date.now() - tStart;
      results[`${prov.name}[batch-k=${BATCH_K}]`] = { rows, score: score(rows), elapsedMs, perCaseMs: Math.round(elapsedMs / labeled.length), mode: 'batch', batchK: BATCH_K };
    } else {
      // ---- single-claim mode (original) -----------------------------------
      process.stdout.write(`\nRunning ${prov.name} on ${labeled.length} cases (x2 calls: order-swap)`);
      const rows = [];
      const tStart = Date.now();
      for (const c of labeled) {
        try {
          // Production behavior: forward call, then reversed-candidates call, then resolve.
          const t1 = await prov.callSingle(buildPrompt(c.claim, c.candidates));
          const v1 = parseVerdict(t1);
          let pred = v1, swapFlip = false;
          if (c.candidates.length >= 2) {
            const t2 = await prov.callSingle(buildPrompt(c.claim, [...c.candidates].reverse()));
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
      results[prov.name] = { rows, score: score(rows), elapsedMs, perCaseMs: Math.round(elapsedMs / labeled.length), mode: 'single' };
    }
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
