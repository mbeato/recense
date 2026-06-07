/**
 * Claim-extraction model bake-off (read-only on brain.db for inputs).
 *
 * WHY: extraction is the high-volume, latency-dominating step of the sleep pass (1 call per
 * episode). It is forgiving (safe-fallback parsing — bad output just drops claims, never corrupts
 * the graph), so the goal is the FASTEST model that still clears a "good enough" quality bar — the
 * judge stays on the strong model (see judge eval). 35b-a3b-with-thinking is too slow (~11 min/episode
 * sleep pass). This finds a fast extractor for split-routing.
 *
 * Method: pull K real episodes from brain.db; run the engine's REAL extraction prompt + parser
 * (faithful copies of src/model/claim-extractor.ts) through each candidate model; measure
 * latency + parse-success + claim count; then have a strong reference model (Haiku) score each
 * candidate's claims for faithfulness+coverage vs the source (1–5).
 *
 * Run:
 *   NODE_PATH=$(pwd)/node_modules node scripts/eval/extract-bakeoff.cjs \
 *     --db ./brain.db --n 5 \
 *     --ollama "qwen2.5:3b-instruct,qwen2.5:7b-instruct,qwen3-vl:8b-instruct-q8_0" \
 *     --haiku claude-haiku-4-5
 * Requires ANTHROPIC_API_KEY (Haiku baseline + the quality judge). Ollama must be up with models pulled.
 */
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DB = arg('--db', './brain.db');
const N = parseInt(arg('--n', '5'), 10);
const HAIKU = arg('--haiku', 'claude-haiku-4-5');
const OLLAMA_MODELS = (arg('--ollama', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const OLLAMA_URL = arg('--ollama-url', 'http://localhost:11434/v1');

// ---- faithful copy of the engine's extraction prompt (src/model/claim-extractor.ts) ----
const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["brain-memory project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"brain-memory project"}
]

Document type: `;

function buildPrompt(content, sourceType) {
  return EXTRACTION_PROMPT + sourceType + '\n\nDocument content:\n' + content;
}

// ---- faithful copy of parseClaims (src/model/claim-extractor.ts) ----
function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}
function parseClaims(text) {
  const json = extractJsonArray(text);
  if (json === null) return null; // null = parse fail (distinct from [] = parsed-but-empty)
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const type = item.type, value = item.value;
      if ((type !== 'entity' && type !== 'fact' && type !== 'schema') || typeof value !== 'string' || value.trim() === '') return [];
      const links = Array.isArray(item.links) ? item.links.filter(l => typeof l === 'string') : undefined;
      return [{ type, value: value.trim(), links }];
    });
  } catch { return null; }
}

// ---- providers ----
async function callHaiku(client, prompt, maxTokens = 2048) {
  const msg = await client.messages.create({ model: HAIKU, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}
async function callOllama(client, model, prompt) {
  // Extraction is structured, not reasoning — non-reasoning instruct models need no think budget.
  // max_tokens 2048 matches the production extractor; no response_format (array, not object).
  const r = await client.chat.completions.create({ model, temperature: 0, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] });
  return r.choices?.[0]?.message?.content ?? '';
}

// ---- Haiku-judged quality (faithfulness + coverage, 1–5) ----
const QUALITY_PROMPT = (src, claims) => `You are grading a knowledge-extraction system. Given a SOURCE document and the CLAIMS it extracted, rate the extraction 1–5 on faithfulness (claims are accurate to the source, no hallucinations) AND coverage (the important entities/facts are captured).
5 = accurate and captures the key knowledge; 3 = usable but misses notable items or has minor noise; 1 = mostly wrong/empty/hallucinated.
Return ONLY JSON: {"score": <1-5 int>, "note": "<short reason>"}

SOURCE:
${src.slice(0, 4000)}

CLAIMS:
${JSON.stringify(claims, null, 0).slice(0, 3000)}`;

function parseScore(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const o = JSON.parse(m[0]); return typeof o.score === 'number' ? { score: Math.round(o.score), note: String(o.note || '') } : null; }
  catch { return null; }
}

(async () => {
  // ── 1. Pull K representative episodes (varied role, reasonable size) ──
  const db = new Database(DB, { readonly: true });
  const rows = db.prepare(
    "SELECT id, role, content FROM episode WHERE length(content) BETWEEN 300 AND 3500 ORDER BY id DESC LIMIT ?"
  ).all(N * 3);
  db.close();
  // spread: alternate roles, take N
  const picked = [];
  const seenRole = { user: 0, assistant: 0 };
  for (const r of rows) { if (picked.length >= N) break; if (seenRole[r.role] === undefined) seenRole[r.role] = 0; if (seenRole[r.role] < Math.ceil(N / 2)) { picked.push(r); seenRole[r.role]++; } }
  while (picked.length < N && rows[picked.length]) picked.push(rows[picked.length]);
  console.log(`Bake-off on ${picked.length} episodes from ${DB} (roles: ${picked.map(p => p.role).join(', ')})\n`);

  if (!process.env.ANTHROPIC_API_KEY) { console.log('⚠ ANTHROPIC_API_KEY not set — Haiku baseline + quality judge unavailable'); }
  const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  const oc = OLLAMA_MODELS.length ? new OpenAI({ baseURL: OLLAMA_URL, apiKey: 'ollama' }) : null;

  const providers = [];
  if (HAIKU && anthropic) providers.push({ name: `haiku:${HAIKU}`, call: (p) => callHaiku(anthropic, p) });
  for (const m of OLLAMA_MODELS) providers.push({ name: `ollama:${m}`, call: (p) => callOllama(oc, m, p) });
  if (!providers.length) { console.log('No providers.'); process.exit(1); }

  // ── 2. Run extraction per provider per episode ──
  const results = {};
  for (const prov of providers) {
    process.stdout.write(`Running ${prov.name}`);
    const per = [];
    for (const ep of picked) {
      const t0 = Date.now();
      let claims = null, err = null;
      try { claims = parseClaims(await prov.call(buildPrompt(ep.content, ep.role))); }
      catch (e) { err = String(e.message || e).slice(0, 120); }
      per.push({ ep: ep.id, role: ep.role, ms: Date.now() - t0, claims, err });
      process.stdout.write('.');
    }
    results[prov.name] = per;
    process.stdout.write('\n');
  }

  // ── 3. Quality score each (provider, episode) via Haiku ──
  if (anthropic) {
    process.stdout.write('\nScoring quality');
    for (const prov of providers) {
      for (const r of results[prov.name]) {
        if (r.claims && r.claims.length) {
          const src = picked.find(p => p.id === r.ep).content;
          try { r.quality = parseScore(await callHaiku(anthropic, QUALITY_PROMPT(src, r.claims), 256)); } catch { r.quality = null; }
        } else r.quality = { score: 0, note: 'no claims' };
        process.stdout.write('.');
      }
    }
    process.stdout.write('\n');
  }

  // ── 4. Report ──
  console.log('\n===================== EXTRACTION BAKE-OFF =====================');
  console.log(['provider', 'avg-latency', 'avg-claims', 'parse-fail', 'avg-quality(1-5)'].join('  |  '));
  for (const [name, per] of Object.entries(results)) {
    const ok = per.filter(r => r.claims !== null);
    const avgMs = per.reduce((a, r) => a + r.ms, 0) / per.length;
    const avgClaims = ok.length ? ok.reduce((a, r) => a + r.claims.length, 0) / ok.length : 0;
    const parseFail = per.filter(r => r.claims === null).length;
    const q = per.map(r => r.quality && r.quality.score).filter(s => typeof s === 'number');
    const avgQ = q.length ? q.reduce((a, b) => a + b, 0) / q.length : null;
    console.log([
      name,
      `${(avgMs / 1000).toFixed(1)}s`,
      avgClaims.toFixed(1),
      String(parseFail),
      avgQ == null ? 'n/a' : avgQ.toFixed(2),
    ].join('  |  '));
  }

  console.log('\n--- per-episode detail (claims count @ latency, quality) ---');
  for (const [name, per] of Object.entries(results)) {
    console.log(`\n${name}`);
    for (const r of per) console.log(`  ep ${r.ep} (${r.role}): ${r.claims === null ? 'PARSE-FAIL' : r.claims.length + ' claims'} @ ${(r.ms / 1000).toFixed(1)}s${r.quality ? ` q=${r.quality.score} (${r.quality.note.slice(0, 60)})` : ''}${r.err ? ' ERR:' + r.err : ''}`);
  }
})();
