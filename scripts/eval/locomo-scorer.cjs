/**
 * LoCoMo scorer (BENCH-02/03) — gpt-4o-mini judge, mem0 Appendix A prompt, category-5 skip.
 *
 * Implements the verbatim mem0/Zep LoCoMo LLM-judge protocol (arXiv 2504.19413, Appendix A)
 * so recense's J score is directly comparable to mem0's published 66.88%.
 *
 * Key invariants:
 *  - Judge: gpt-4o-mini, temperature=0, max_tokens=10, single user message (no system prompt)
 *  - Prompt: verbatim mem0 Appendix A — "be generous, same topic = CORRECT"
 *  - Denominator: count(qa.category !== 5) — adversarial excluded from both num and denom
 *  - Output meta: full D-10 v7.0 config snapshot (sut_commit, engine_version, all 15 knobs)
 *  - --mock: deterministic substring judge (zero API) for CI
 *
 * Run from the repo root:
 *
 *   # Real judging (requires OPENAI_API_KEY)
 *   node scripts/eval/locomo-scorer.cjs \
 *     --in scripts/eval/results/locomo-hypotheses-PENDING.jsonl \
 *     --out scripts/eval/results/locomo-PENDING.json
 *
 *   # Mock mode (zero API — substring match stand-in for CI)
 *   node scripts/eval/locomo-scorer.cjs --mock \
 *     --in /tmp/locomo-hyp.jsonl \
 *     --out /tmp/locomo-score.json
 *
 * Output envelope:
 *   { meta: { eval, date, sut_commit, engine_version, judge_model, questions_total,
 *             questions_adversarial_excluded, sut_config },
 *     scores: { headline, by_category, rAtK: { r5, r10 } },
 *     per_question: [...] }
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const childProcess  = require('child_process');
const OpenAI        = require('openai');

// Engine dist modules — loaded eagerly so node --check catches require errors at startup.
const DIST = path.resolve(__dirname, '../../dist/src');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');

// ---- arg parsing ------------------------------------------------------------

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i !== -1 ? process.argv[i + 1] : d;
};

const IS_MOCK = process.argv.includes('--mock');

// --in  : hypotheses JSONL produced by locomo-harness.cjs
// --out : result JSON path (default uses commit hash for traceability)
const HYPOTHESES_FILE = arg('--in',  'scripts/eval/results/locomo-hypotheses-PENDING.jsonl');
const OUT_FILE        = arg('--out', null); // resolved below after getCommit()

// ---- metadata helpers -------------------------------------------------------

function getCommit() {
  try {
    return childProcess.execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

function getEngineVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const COMMIT = getCommit();
const RESOLVED_OUT = OUT_FILE || `scripts/eval/results/locomo-${COMMIT}.json`;

// ---- LoCoMo category codes --------------------------------------------------
// Verified empirically by Plan 40-01 (A2 mitigation):
//   1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial
const LOCOMO_CATEGORIES = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial', // excluded from denominator
};

// ---- verdict parsing --------------------------------------------------------

/**
 * Parse the gpt-4o-mini judge response for a binary CORRECT/WRONG verdict.
 *
 * The mem0 Appendix A prompt returns {"label":"CORRECT"} or {"label":"WRONG"}.
 * This parser handles that envelope first, then falls back to the legacy
 * yes/no / correct/incorrect patterns from longmemeval-scorer.cjs for robustness.
 */
function parseJudgeVerdict(text) {
  if (!text) return { label: 0, parseOk: false };

  const lower = text.toLowerCase().trim();

  // JSON envelope — primary path for the mem0 Appendix A prompt
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      // mem0 Appendix A: {"label":"CORRECT"} or {"label":"WRONG"}
      if (obj.label === 'CORRECT') return { label: 1, parseOk: true };
      if (obj.label === 'WRONG')   return { label: 0, parseOk: true };
      // Legacy LME envelopes (fallback robustness)
      if (typeof obj.correct === 'boolean') return { label: obj.correct ? 1 : 0, parseOk: true };
      if (obj.verdict === 'yes' || obj.verdict === 'correct') return { label: 1, parseOk: true };
      if (obj.verdict === 'no'  || obj.verdict === 'incorrect') return { label: 0, parseOk: true };
    } catch {}
  }

  // Plain text fallback
  if (lower.startsWith('yes') || (lower.includes('correct') && !lower.includes('incorrect'))) {
    return { label: 1, parseOk: true };
  }
  if (lower.startsWith('no') || lower.includes('incorrect') || lower.includes('wrong')) {
    return { label: 0, parseOk: true };
  }
  if (lower.trim() === '1') return { label: 1, parseOk: true };
  if (lower.trim() === '0') return { label: 0, parseOk: true };

  return { label: 0, parseOk: false };
}

// ---- judge prompt -----------------------------------------------------------

/**
 * Build the verbatim mem0 Appendix A judge prompt (arXiv 2504.19413).
 *
 * Single generic template — NOT the LME per-question-type templates.
 * Returns a string suitable as a single user message (no system prompt).
 * The prompt asks for {"label":"CORRECT"|"WRONG"} JSON output.
 */
function buildLoCoMoJudgePrompt(question, goldAnswer, hypothesis) {
  return (
    `Your task is to label an answer to a question as "CORRECT" or "WRONG".\n` +
    `You will be given the following data:\n` +
    `(1) a question (posed by one user to another user),\n` +
    `(2) a 'gold' (ground truth) answer,\n` +
    `(3) a generated answer which you will score as CORRECT/WRONG.\n\n` +
    `Be generous with grading — as long as the generated answer touches on the same ` +
    `topic as the gold answer it should be counted as CORRECT.\n\n` +
    `Return a JSON object with a single key "label" whose value is "CORRECT" or "WRONG".\n\n` +
    `Question: ${question}\n` +
    `Gold answer: ${goldAnswer}\n` +
    `Generated answer: ${hypothesis}`
  );
}

// ---- judge functions --------------------------------------------------------

/**
 * Calls gpt-4o-mini (paper version) to judge whether hypothesis is correct.
 * Uses the verbatim mem0 Appendix A prompt, temperature=0, max_tokens=10.
 * No system prompt — single user message.
 */
async function judgeWithGpt4oMini(client, question, goldAnswer, hypothesis) {
  const prompt = buildLoCoMoJudgePrompt(question, goldAnswer, hypothesis);
  try {
    const response = await client.chat.completions.create({
      model:       'gpt-4o-mini',
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.choices?.[0]?.message?.content ?? '';
    const { label, parseOk } = parseJudgeVerdict(text);
    return { label, raw: text.slice(0, 100), parseOk };
  } catch (e) {
    return { label: 0, raw: '', parseOk: false, error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * Mock judge for CI (--mock): deterministic verdict based on gold-answer substring match.
 * Zero OpenAI API calls.
 */
function judgeWithMock(goldAnswer, hypothesis) {
  if (!hypothesis || hypothesis === 'dry-run-stub-answer') {
    return { label: 0, raw: 'mock-no-answer', parseOk: true };
  }
  const label = hypothesis.toLowerCase().includes((goldAnswer || '').toLowerCase()) ? 1 : 0;
  return { label, raw: label ? 'mock-match' : 'mock-no-match', parseOk: true };
}

// ---- JSONL helpers ----------------------------------------------------------

function parseJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch (e) {
      console.error(`[warn] Skipping malformed JSONL line ${i + 1}: ${String(e.message || e).slice(0, 80)}`);
    }
  }
  return out;
}

// ---- main -------------------------------------------------------------------

(async () => {
  // ---- load hypotheses -------------------------------------------------------
  if (!fs.existsSync(HYPOTHESES_FILE)) {
    console.error(`Hypotheses file not found: ${HYPOTHESES_FILE}`);
    console.error('Run the harness first: node scripts/eval/locomo-harness.cjs ...');
    process.exit(1);
  }

  const hypotheses = parseJsonl(HYPOTHESES_FILE);

  if (!hypotheses.length) {
    console.error('No hypotheses found in input file');
    process.exit(1);
  }

  // ---- key guard (real mode only) -------------------------------------------
  if (!IS_MOCK && !process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set — required for gpt-4o-mini judging (use --mock for zero-API mode)');
    process.exit(1);
  }

  let openaiClient = null;
  if (!IS_MOCK) {
    openaiClient = new OpenAI();
  }

  console.log(`Scoring ${hypotheses.length} hypothesis row(s) via ${IS_MOCK ? 'mock (substring match)' : 'gpt-4o-mini'}`);

  // ---- per-question scoring --------------------------------------------------
  const perQuestion = [];
  let adversarialCount = 0;
  process.stdout.write('Judging');

  for (const row of hypotheses) {
    const category   = row.category;
    const question   = row.question   || '';
    const goldAnswer = row.answer     || '';
    const hypothesis = row.hypothesis || row.error || '';

    // BENCH-03 invariant: category 5 (adversarial) is excluded from BOTH numerator and
    // denominator. The J-score denominator = count(category !== 5).
    if (category === 5) {
      adversarialCount++;
      continue;
    }

    let result;
    if (IS_MOCK) {
      result = judgeWithMock(goldAnswer, hypothesis);
    } else {
      result = await judgeWithGpt4oMini(openaiClient, question, goldAnswer, hypothesis);
    }

    const categoryLabel = LOCOMO_CATEGORIES[category] || `category-${category}`;

    perQuestion.push({
      question_id:    row.question_id || `row-${perQuestion.length}`,
      category,
      category_label: categoryLabel,
      autoeval_label: result.label,
      hypothesis,
      answer:         goldAnswer,
      judge_raw:      result.raw,
      parse_ok:       result.parseOk,
      hit5:           row.hit5 ?? null,   // R@K from harness (passed through)
      hit10:          row.hit10 ?? null,
      ...(result.error ? { error: result.error } : {}),
    });

    process.stdout.write('.');
  }

  console.log(''); // newline after dots

  // ---- aggregate scores -----------------------------------------------------

  const totalScored  = perQuestion.filter(r => !r.error).length;
  const totalCorrect = perQuestion.filter(r => !r.error && r.autoeval_label === 1).length;
  const headline     = totalScored > 0 ? totalCorrect / totalScored : 0;

  // Per-category breakdown (LoCoMo: multi-hop, temporal, open-domain, single-hop)
  const catBuckets = {};
  for (const r of perQuestion) {
    if (r.error) continue;
    const cat = r.category_label || `category-${r.category}`;
    if (!catBuckets[cat]) catBuckets[cat] = { correct: 0, total: 0 };
    catBuckets[cat].correct += r.autoeval_label;
    catBuckets[cat].total   += 1;
  }
  const byCategory = {};
  for (const [cat, counts] of Object.entries(catBuckets)) {
    byCategory[cat] = counts.total > 0 ? counts.correct / counts.total : 0;
  }

  // R@K aggregation: r5/r10 from harness hit5/hit10 fields
  const rAtKRows = perQuestion.filter(r => !r.error && r.hit5 !== null);
  const r5  = rAtKRows.length > 0 ? rAtKRows.filter(r => r.hit5).length  / rAtKRows.length : null;
  const r10 = rAtKRows.length > 0 ? rAtKRows.filter(r => r.hit10).length / rAtKRows.length : null;

  // ---- D-10 config snapshot --------------------------------------------------
  // Read live DEFAULT_CONFIG values at scorer time — records the actual frozen v7.0 knobs.
  // Field names match the verified src/lib/config.ts DEFAULT_CONFIG keys (PATTERNS table).
  const sutConfig = {
    openaiEmbedModel:              DEFAULT_CONFIG.openaiEmbedModel,
    embeddingDimensions:           DEFAULT_CONFIG.embeddingDimensions,
    claudeHeadlessExtractModel:    DEFAULT_CONFIG.claudeHeadlessExtractModel,
    claudeHeadlessJudgeModel:      DEFAULT_CONFIG.claudeHeadlessJudgeModel,
    consolSkipThreshold:           DEFAULT_CONFIG.consolSkipThreshold,
    consolSkipThresholdAssistant:  DEFAULT_CONFIG.consolSkipThresholdAssistant,
    rankStrengthWeight:            DEFAULT_CONFIG.rankStrengthWeight,
    rankedRetrievalK:              DEFAULT_CONFIG.rankedRetrievalK,
    rankedRetrievalFloor:          DEFAULT_CONFIG.rankedRetrievalFloor,
    candidateK:                    DEFAULT_CONFIG.candidateK,
    entityAnchorK:                 DEFAULT_CONFIG.entityAnchorK,
    typedAnchorPoolK:              DEFAULT_CONFIG.typedAnchorPoolK,
    injectionTokenBudget:          DEFAULT_CONFIG.injectionTokenBudget,
    insightSurfacingEnabled:       DEFAULT_CONFIG.insightSurfacingEnabled,
    predicateGlossThreshold:       DEFAULT_CONFIG.predicateGlossThreshold,
  };

  // ---- build output envelope ------------------------------------------------

  const meta = {
    eval:                           'locomo-10',
    date:                           new Date().toISOString().slice(0, 10),
    sut_commit:                     COMMIT,
    engine_version:                 getEngineVersion(),
    judge_model:                    IS_MOCK ? 'mock-substring' : 'gpt-4o-mini',
    questions_total:                perQuestion.length,
    questions_adversarial_excluded: adversarialCount,
    sut_config:                     sutConfig,
  };

  const scores   = { headline, by_category: byCategory, rAtK: { r5, r10 } };
  const envelope = { meta, scores, per_question: perQuestion };

  // ---- write results ---------------------------------------------------------
  fs.mkdirSync(path.dirname(RESOLVED_OUT), { recursive: true });
  fs.writeFileSync(RESOLVED_OUT, JSON.stringify(envelope, null, 2));

  // ---- report ----------------------------------------------------------------
  console.log(`\n=== LoCoMo Scores ===`);
  console.log(`Headline J:  ${(headline * 100).toFixed(2)}% (${totalCorrect}/${totalScored})`);
  console.log(`Adversarial excluded (cat 5): ${adversarialCount}`);
  console.log(`\nPer-category breakdown:`);
  for (const [cat, score] of Object.entries(byCategory)) {
    const bucket = catBuckets[cat];
    const n = bucket ? bucket.total : 0;
    console.log(`  ${cat.padEnd(20)} ${(score * 100).toFixed(1)}% (n=${n})`);
  }
  if (r5 !== null || r10 !== null) {
    console.log(`\nRetrieval R@K:`);
    if (r5  !== null) console.log(`  R@5  = ${(r5  * 100).toFixed(1)}% (n=${rAtKRows.length})`);
    if (r10 !== null) console.log(`  R@10 = ${(r10 * 100).toFixed(1)}% (n=${rAtKRows.length})`);
  }
  console.log(`\nResults -> ${RESOLVED_OUT}`);
  console.log(`Judge: ${meta.judge_model} | commit: ${meta.sut_commit} | engine: ${meta.engine_version}`);
})();
