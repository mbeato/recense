/**
 * extractor-bakeoff.cjs — Extraction-only model bake-off (QUICK-260612-clb).
 *
 * WHY: measures extraction quality signals for local candidate models through the
 * production CONVERSATION extraction prompt + constrained-decoding (native /api/chat).
 * Exercises the REAL engine path so constrained decoding is exercised end-to-end.
 * No judge, no consolidation, no scratch DB, no API spend.
 *
 * Run:
 *   npm run build && node scripts/eval/extractor-bakeoff.cjs \
 *     --models "qwen2.5:7b-instruct,phi4:latest" \
 *     --limit 5 --out scripts/eval/extractor-bakeoff-results.json
 *
 * Smoke test (already-installed baseline, 3 episodes):
 *   npm run build && node scripts/eval/extractor-bakeoff.cjs \
 *     --models "qwen2.5:7b-instruct" --limit 3
 *
 * T-05-KEY: harness never reads, logs, or forwards ANTHROPIC_API_KEY or OPENAI_API_KEY.
 *           Local path uses the dummy 'ollama' key set inside OllamaClient/createAnthropicClient.
 * T-CLB-02: nativeUrl is derived from config.localBaseUrl inside OllamaClient — not user input.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i !== -1 ? argv[i + 1] : d; };
const hasFlag = (k) => argv.includes(k);

const MODELS_RAW = arg('--models', '');
if (!MODELS_RAW) {
  console.error('Usage: extractor-bakeoff.cjs --models "tag1,tag2,..." [--limit N] [--ollama-url url] [--out path]');
  process.exit(1);
}
const MODELS       = MODELS_RAW.split(',').map(s => s.trim()).filter(Boolean);
const LIMIT        = parseInt(arg('--limit', '0'), 10) || 0;   // 0 = all 34 episodes
const OLLAMA_URL   = arg('--ollama-url', 'http://localhost:11434/v1');
const OUT          = arg('--out', path.join(__dirname, 'extractor-bakeoff-results.json'));
// --think-off: global knob (default ON at native path; this flag forces it in the adapter map).
// Native path already sets think:false — kept as an explicit CLI signal for documentation.
const _THINK_OFF   = hasFlag('--think-off') || true; // always on; stored for future use

// ── Load compiled engine modules (npm run build first) ────────────────────────
const distRoot = path.join(__dirname, '../../dist/src');
let DEFAULT_CONFIG, DefaultModelProvider, parseClaims, EXTRACTION_MAX_TOKENS, CLAIM_ARRAY_SCHEMA, promptForSource;
try {
  ({ DEFAULT_CONFIG }      = require(path.join(distRoot, 'lib/config')));
  ({ DefaultModelProvider } = require(path.join(distRoot, 'model/provider')));
  ({ parseClaims, EXTRACTION_MAX_TOKENS, CLAIM_ARRAY_SCHEMA } = require(path.join(distRoot, 'model/claim-extractor')));
  ({ promptForSource }     = require(path.join(distRoot, 'source/extraction-prompts')));
} catch (e) {
  console.error('Failed to load dist/ modules. Run `npm run build` first.\n' + e.message);
  process.exit(1);
}

// ── Load correctness-cases → flatten to 34 episode inputs ────────────────────
const CASES_PATH = path.join(__dirname, 'cases/correctness-cases.json');
const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
/** @type {Array<{caseId:number, pass:1|2, control_type:string, text:string}>} */
const ALL_EPISODES = [];
for (const c of cases) {
  ALL_EPISODES.push({ caseId: c.case_id, pass: 1, control_type: c.control_type, text: c.initial_fact });
  ALL_EPISODES.push({ caseId: c.case_id, pass: 2, control_type: c.control_type, text: c.contradicting_fact });
}

// ── Few-shot regurgitation check (CONVERSATION prompt examples, lower-cased) ─
const REGREG_FRAGMENTS = [
  'jane doe', 'recense project', '45 minutes each way',
  'react summit', 'dark roast coffee',
];
/**
 * Returns true if any extracted claim value contains a fragment from the
 * CONVERSATION_EXTRACTION_PROMPT few-shot examples. Any hit is a disqualifying
 * signal (model regurgitated the prompt rather than extracting from the source).
 */
function hasRegurgitation(claims) {
  for (const c of claims) {
    const v = (c.value || '').toLowerCase();
    if (REGREG_FRAGMENTS.some(f => v.includes(f))) return true;
  }
  return false;
}

/**
 * Detect parse-fail vs parsed-but-empty. parseClaims returns [] for both, so we
 * recheck the raw text for array syntax presence.
 */
function rawHasArray(text) {
  const s = text.indexOf('[');
  const e = text.lastIndexOf(']');
  return s !== -1 && e !== -1 && e > s;
}

// ── Change-verb heuristic (for normalization sub-table annotation) ────────────
const CHANGE_VERBS = ['moved', 'switched', 'stopped', 'dropped', 'no longer', 'quit', 'started', 'cut'];
function containsChangeVerb(value) {
  const v = value.toLowerCase();
  return CHANGE_VERBS.some(verb => v.includes(verb));
}

// ── Build extraction prompt ───────────────────────────────────────────────────
const CONV_PROMPT_PREFIX = promptForSource('conversation');
function buildPrompt(text) {
  return CONV_PROMPT_PREFIX + '\n\nDocument content:\n' + text;
}

// ── Per-model adapter map ─────────────────────────────────────────────────────
// Keys = exact model tags. Add entries only for models that need overrides.
// think:false + temperature:0 are already the native-path defaults (QUICK-260612-clb),
// so qwen2.5:7b-instruct and similar models need NO adapter entry.
//
// NuExtract: requires temperature:0.2 and uses a different prompt template that the
// engine's generate() path cannot express directly — use the direct-fetch helper.
const ADAPTERS = {
  'hf.co/numind/NuExtract3-GGUF:Q8_0': { temperature: 0.2, useDirectFetch: true },
};

/**
 * Direct /api/chat fetch helper for models with adapter overrides that the engine
 * path cannot express (e.g. NuExtract temperature/template).
 * Uses the same body shape and CLAIM_ARRAY_SCHEMA as the engine's OllamaClient native path.
 * T-CLB-02: URL is derived from OLLAMA_URL (config-controlled), not user content.
 */
async function extractViaDirectFetch(model, prompt, ollamaBaseUrl, adapter) {
  const nativeUrl = ollamaBaseUrl.replace(/\/v1\/?$/, '') + '/api/chat';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    think: false,
    format: CLAIM_ARRAY_SCHEMA,
    options: {
      temperature: adapter.temperature ?? 0,
      num_predict: EXTRACTION_MAX_TOKENS,
    },
  };
  const resp = await fetch(nativeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Ollama /api/chat returned ${resp.status}`);
  const json = await resp.json();
  return json.message?.content ?? '';
}

// ── Main run ──────────────────────────────────────────────────────────────────
(async () => {
  const inputs = LIMIT > 0 ? ALL_EPISODES.slice(0, LIMIT) : ALL_EPISODES;
  console.log(`extractor-bakeoff: ${MODELS.length} model(s), ${inputs.length} inputs, ollama ${OLLAMA_URL}`);
  console.log(`Output: ${OUT}\n`);

  /** @type {Record<string, any[]>} */
  const results = {};

  for (const modelTag of MODELS) {
    process.stdout.write(`Running ${modelTag} `);
    const adapter = ADAPTERS[modelTag];
    const perEp = [];

    // Build provider for non-direct-fetch path (lazily initialized — safe without live Ollama)
    let provider = null;
    if (!adapter?.useDirectFetch) {
      const config = {
        ...DEFAULT_CONFIG,
        modelProvider: 'local',
        localModel: modelTag,
        localBaseUrl: OLLAMA_URL,
        dbPath: ':memory:',
      };
      provider = new DefaultModelProvider({
        generateConfig: config,
        judgeConfig: config,
        embedConfig: config,
      });
    }

    // Wrap the whole model in try/catch: a mid-download or unloadable model is marked
    // errored and skipped; the run continues to the next model.
    try {
      for (const ep of inputs) {
        const t0 = Date.now();
        let raw = '', claims = [], err = null;
        try {
          const prompt = buildPrompt(ep.text);
          if (adapter?.useDirectFetch) {
            raw = await extractViaDirectFetch(modelTag, prompt, OLLAMA_URL, adapter);
          } else {
            raw = await provider.generate(prompt, {
              maxTokens: EXTRACTION_MAX_TOKENS,
              jsonSchema: CLAIM_ARRAY_SCHEMA,
            });
          }
          claims = parseClaims(raw);
        } catch (e) {
          err = String(e.message ?? e).slice(0, 200);
          raw = '';
          claims = [];
        }

        const thinkLeakage = (raw.match(/<think>/g) || []).length;
        const parseFail = claims.length === 0 && !rawHasArray(raw) && err === null;
        const parsedButEmpty = claims.length === 0 && rawHasArray(raw) && err === null;

        perEp.push({
          caseId: ep.caseId,
          pass: ep.pass,
          control_type: ep.control_type,
          text: ep.text,
          ms: Date.now() - t0,
          raw,
          claims,
          thinkLeakage,
          parseFail,
          parsedButEmpty,
          regurgitation: hasRegurgitation(claims),
          err,
        });
        process.stdout.write(err ? 'E' : '.');
      }
    } catch (modelErr) {
      // Entire-model failure (e.g. model not found, Ollama crash)
      const msg = String(modelErr.message ?? modelErr).slice(0, 200);
      process.stdout.write(` [MODEL ERROR: ${msg}]`);
      results[modelTag] = [{ modelError: msg }];
      process.stdout.write('\n');
      continue;
    }

    results[modelTag] = perEp;
    process.stdout.write('\n');
  }

  // ── Metrics summary table ─────────────────────────────────────────────────
  console.log('\n══════════════════════ EXTRACTION BAKE-OFF ══════════════════════');
  const COL = (s, w) => String(s).padEnd(w);
  const header = [
    COL('model', 36), COL('parse-ok', 10), COL('parse-fail', 11), COL('p-empty', 9),
    COL('claims/ep', 10), COL('regreg', 8), COL('think-leak', 11), COL('s/ep', 7),
  ].join('| ');
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const [model, perEp] of Object.entries(results)) {
    if (!Array.isArray(perEp) || perEp[0]?.modelError) {
      console.log(`${COL(model, 36)}| [MODEL ERROR: ${perEp[0]?.modelError ?? 'unknown'}]`);
      continue;
    }

    const valid   = perEp.filter(r => r.err === null);
    const errored = perEp.filter(r => r.err !== null);
    const parseFails    = valid.filter(r => r.parseFail).length;
    const parsedEmpty   = valid.filter(r => r.parsedButEmpty).length;
    const parseOk       = valid.filter(r => !r.parseFail && !r.parsedButEmpty).length;
    const regurgCount   = valid.filter(r => r.regurgitation).length;
    const thinkLeakTotal = valid.reduce((acc, r) => acc + (r.thinkLeakage || 0), 0);
    const avgClaims     = parseOk > 0
      ? (valid.reduce((acc, r) => acc + (r.claims?.length || 0), 0) / (parseOk + parsedEmpty)).toFixed(1)
      : '—';
    const avgMs  = perEp.length > 0
      ? ((perEp.reduce((acc, r) => acc + (r.ms || 0), 0) / perEp.length) / 1000).toFixed(2)
      : '—';

    const disqualified = regurgCount > 0 ? ' REGREG!' : (thinkLeakTotal > 0 ? ' THINK!' : '');
    console.log([
      COL(model + disqualified, 36),
      COL(parseOk, 10),
      COL(parseFails, 11),
      COL(parsedEmpty, 9),
      COL(avgClaims, 10),
      COL(regurgCount + (regurgCount > 0 ? '⚠' : ''), 8),
      COL(thinkLeakTotal + (thinkLeakTotal > 0 ? '⚠' : ''), 11),
      COL(avgMs + 's', 7),
    ].join('| ') + (errored.length ? `  (${errored.length} errs)` : ''));
  }
  console.log('');

  // ── Change-normalization sub-table (pass:2 contradiction inputs, 13 cases) ─
  // Reports raw claim values for human review — DO NOT over-automate pass/fail.
  // Heuristic annotations: ⚑ = contains change-verb (ideally normalized away).
  console.log('═══ Change-normalization (pass:2 contradiction inputs) ══════════');
  console.log('(heuristic ⚑ = claim still contains change-verb language; human review required)\n');

  const contraCaseIds = ALL_EPISODES
    .filter(e => e.pass === 2 && e.control_type === 'contradiction')
    .map(e => e.caseId);

  for (const [model, perEp] of Object.entries(results)) {
    if (!Array.isArray(perEp) || perEp[0]?.modelError) continue;
    console.log(`  ${model}`);
    for (const ep of perEp.filter(r => r.pass === 2 && r.control_type === 'contradiction')) {
      const claimVals = (ep.claims || []).map(c => c.value);
      const flags = claimVals.map(v => containsChangeVerb(v) ? '⚑' : '✓');
      const display = claimVals.length === 0
        ? '[no claims]'
        : claimVals.map((v, i) => `${flags[i]} "${v}"`).join('  |  ');
      console.log(`    case ${String(ep.caseId).padStart(2)}: ${display}`);
    }
    console.log('');
  }

  // ── Write results JSON ────────────────────────────────────────────────────
  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  // Omit raw strings from JSON output to keep files small; claims + metrics are enough.
  const slim = Object.fromEntries(
    Object.entries(results).map(([model, perEp]) => [
      model,
      Array.isArray(perEp) && !perEp[0]?.modelError
        ? perEp.map(({ raw: _r, ...rest }) => rest)
        : perEp,
    ])
  );
  fs.writeFileSync(OUT, JSON.stringify(slim, null, 2));
  console.log(`Results written → ${OUT}`);
})();
