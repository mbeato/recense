/**
 * LongMemEval scorer (EVAL-01) — GPT-4o-2024-08-06 judge + per-category aggregation.
 *
 * Ports the LongMemEval evaluate_qa protocol to JS using the already-in-project
 * openai package. Binary correct/incorrect judging via GPT-4o-2024-08-06.
 *
 * Run from the repo root:
 *
 *   # Real judging (requires OPENAI_API_KEY)
 *   node scripts/eval/longmemeval-scorer.cjs \
 *     --hypotheses scripts/eval/results/longmemeval-hypotheses-PENDING.jsonl \
 *     --eval scripts/eval/longmemeval-s.jsonl \
 *     --out scripts/eval/results/longmemeval-PENDING.json
 *
 *   # Mock mode (zero API — substring match stand-in for CI)
 *   node scripts/eval/longmemeval-scorer.cjs --mock \
 *     --hypotheses /tmp/lme-hyp.jsonl \
 *     --eval scripts/eval/fixtures/longmemeval-mini.jsonl \
 *     --out /tmp/lme-score.json
 *
 * The KU (knowledge-update) sub-score is always surfaced in scores.by_category —
 * this is brain-memory's highest-positioning number (PE-gated reconsolidation structural edge).
 *
 * Output envelope:
 *   { meta: { eval, date, commit, engine_version, questions_total, judge_model },
 *     scores: { headline, by_category: { 'knowledge-update': X, ... } },
 *     per_question: [...] }
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const childProcess  = require('child_process');
const OpenAI        = require('openai');

// ---- arg parsing ------------------------------------------------------------

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i !== -1 ? process.argv[i + 1] : d;
};

const IS_MOCK = process.argv.includes('--mock');

const HYPOTHESES_FILE = arg('--hypotheses', 'scripts/eval/results/longmemeval-hypotheses-PENDING.jsonl');
const EVAL_FILE       = arg('--eval',        'scripts/eval/longmemeval-s.jsonl');
const OUT_FILE        = arg('--out',         'scripts/eval/results/longmemeval-PENDING.json');

const JUDGE_MODEL     = 'gpt-4o-2024-08-06';

// The 7 canonical LongMemEval question types (used for by_category aggregation)
const QUESTION_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session-reasoning',
  'knowledge-update',
  'temporal-reasoning',
  'abstention',
];

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

// ---- verdict parsing (salvage pattern from judge-eval-runner.cjs) -----------

/**
 * Parse the GPT-4o judge response for a binary correct/incorrect verdict.
 * Tolerant: accepts "yes"/"no", "correct"/"incorrect", "1"/"0", or JSON {"correct": true/false}.
 * Falls back to 0 (incorrect) on parse failure.
 */
function parseJudgeVerdict(text) {
  if (!text) return { label: 0, parseOk: false };

  const lower = text.toLowerCase().trim();

  // Check for JSON envelope first (salvage pattern)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj.correct === 'boolean') return { label: obj.correct ? 1 : 0, parseOk: true };
      if (obj.verdict === 'yes' || obj.verdict === 'correct') return { label: 1, parseOk: true };
      if (obj.verdict === 'no'  || obj.verdict === 'incorrect') return { label: 0, parseOk: true };
    } catch {}
  }

  // Plain text patterns
  if (lower.startsWith('yes') || lower.includes('correct') && !lower.includes('incorrect')) {
    return { label: 1, parseOk: true };
  }
  if (lower.startsWith('no') || lower.includes('incorrect')) {
    return { label: 0, parseOk: true };
  }
  if (lower.trim() === '1') return { label: 1, parseOk: true };
  if (lower.trim() === '0') return { label: 0, parseOk: true };

  return { label: 0, parseOk: false };
}

// ---- judge prompt construction (ported verbatim from LongMemEval) -----------
//
// Source: https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
// Function: get_anscheck_prompt(task, question, answer, response, abstention)
//
// The official evaluate_qa.py sends a single user message (no system prompt) and
// uses temperature=0, max_tokens=10. We follow the same structure.
// Abstention questions are identified by question_id suffix "_abs" — their
// question_type is one of the 6 regular types, not a distinct category.

/**
 * Build the per-question-type judge prompt verbatim from the official LongMemEval
 * evaluate_qa.py implementation (get_anscheck_prompt).
 *
 * @param {string}  questionType  - LongMemEval question_type field
 * @param {string}  question      - The question text
 * @param {string}  goldAnswer    - The gold/reference answer (or rubric for preference)
 * @param {string}  hypothesis    - The system's generated response
 * @param {boolean} isAbstention  - true when question_id ends with "_abs"
 * @returns {string} Full prompt to send as the user message (no system prompt)
 */
function buildJudgePrompt(questionType, question, goldAnswer, hypothesis, isAbstention) {
  if (isAbstention) {
    // Abstention template — verbatim from evaluate_qa.py
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${goldAnswer}\n\nModel Response: ${hypothesis}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }

  if (questionType === 'temporal-reasoning') {
    // Temporal-reasoning template — verbatim from evaluate_qa.py (off-by-one leniency)
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${goldAnswer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }

  if (questionType === 'knowledge-update') {
    // Knowledge-update template — verbatim from evaluate_qa.py
    // Accepts "previous information along with an updated answer" as correct
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${goldAnswer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }

  if (questionType === 'single-session-preference') {
    // Preference template — verbatim from evaluate_qa.py (rubric-based)
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${goldAnswer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }

  // Default template — verbatim from evaluate_qa.py
  // Covers: single-session-user, single-session-assistant, multi-session-reasoning, and any other type
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${goldAnswer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
}

// ---- judge functions --------------------------------------------------------

/**
 * Calls GPT-4o-2024-08-06 to judge whether hypothesis is correct given the gold answer.
 * Uses the official LongMemEval per-question-type prompt (no system prompt, temperature=0).
 * Returns autoeval_label: 1 (correct) or 0 (incorrect).
 */
async function judgeWithGpt4o(client, questionType, question, goldAnswer, hypothesis, isAbstention) {
  const prompt = buildJudgePrompt(questionType, question, goldAnswer, hypothesis, isAbstention);
  try {
    const response = await client.chat.completions.create({
      model: JUDGE_MODEL,
      max_tokens: 16,
      temperature: 0,
      messages: [
        { role: 'user', content: prompt },
      ],
    });
    const text = response.choices?.[0]?.message?.content ?? '';
    const { label, parseOk } = parseJudgeVerdict(text);
    return { label, raw: text.slice(0, 100), parseOk };
  } catch (e) {
    return { label: 0, raw: '', parseOk: false, error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * Mock judge: for abstention questions, correct iff hypothesis contains no-information
 * language. For all other types, uses case-insensitive substring match of goldAnswer
 * in hypothesis. Zero API calls — used in CI / --mock mode.
 */
function judgeWithMock(questionType, goldAnswer, hypothesis, isAbstention) {
  if (!hypothesis || hypothesis === 'dry-run-stub-answer') {
    return { label: 0, raw: 'mock-no-answer', parseOk: true };
  }

  if (isAbstention) {
    // Correct iff hypothesis indicates no-information (mirrors abstention judge criteria)
    const lower = hypothesis.toLowerCase();
    const noInfoSignals = [
      "don't have information",
      "do not have information",
      "no information",
      "not available",
      "cannot find",
      "can't find",
      "i don't know",
      "i do not know",
      "unable to find",
      "no relevant",
      "unanswerable",
      "not mentioned",
      "not found",
    ];
    const label = noInfoSignals.some(s => lower.includes(s)) ? 1 : 0;
    return { label, raw: label ? 'mock-abstain-correct' : 'mock-abstain-incorrect', parseOk: true };
  }

  const label = hypothesis.toLowerCase().includes(goldAnswer.toLowerCase()) ? 1 : 0;
  return { label, raw: label ? 'mock-match' : 'mock-no-match', parseOk: true };
}

// ---- main -------------------------------------------------------------------

(async () => {
  // ---- load files -----------------------------------------------------------
  if (!fs.existsSync(HYPOTHESES_FILE)) {
    console.error(`Hypotheses file not found: ${HYPOTHESES_FILE}`);
    console.error('Run the harness first: node scripts/eval/longmemeval-harness.cjs ...');
    process.exit(1);
  }
  if (!fs.existsSync(EVAL_FILE)) {
    console.error(`Eval dataset not found: ${EVAL_FILE}`);
    process.exit(1);
  }

  const hypotheses    = parseJsonl(HYPOTHESES_FILE);
  const evalQuestions = parseJsonl(EVAL_FILE);

  if (!hypotheses.length)    { console.error('No hypotheses found'); process.exit(1); }
  if (!evalQuestions.length) { console.error('No eval questions found'); process.exit(1); }

  // ---- join hypotheses to gold answers by question_id ----------------------
  const evalMap = new Map(evalQuestions.map(q => [q.question_id, q]));
  const hypMap  = new Map(hypotheses.map(h => [h.question_id, h]));

  // Pairs: only questions that have both a hypothesis and a gold answer.
  // Skip hypotheses with an error field — degraded memory (harness quarantine or
  // pipeline failure) is not a valid measurement; including it would inflate the
  // denominator with a guaranteed-0 or unreliable score.
  const pairs = [];
  let skippedHarnessErrors = 0;
  for (const [qid, hyp] of hypMap.entries()) {
    const gold = evalMap.get(qid);
    if (!gold) {
      console.warn(`[warn] hypothesis ${qid} has no matching gold question — skipped`);
      continue;
    }
    if (hyp.error) {
      skippedHarnessErrors++;
      continue;
    }
    pairs.push({ qid, hyp, gold });
  }

  if (skippedHarnessErrors > 0) {
    console.warn(
      `[warn] Skipped ${skippedHarnessErrors} hypothesis(es) with error field — degraded memory runs excluded from scoring.\n` +
      `       Re-run harness with --retry-errors to repair, then re-score.`
    );
  }

  if (!pairs.length) {
    console.error('No matching question_ids between hypotheses and eval dataset');
    process.exit(1);
  }

  // ---- key guard (real mode only) ------------------------------------------
  if (!IS_MOCK && !process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set — required for GPT-4o judging (use --mock for zero-API mode)');
    process.exit(1);
  }

  const openaiClient = IS_MOCK ? null : new OpenAI();

  console.log(`Scoring ${pairs.length} question(s) via ${IS_MOCK ? 'mock (substring match)' : JUDGE_MODEL}`);

  // ---- per-question scoring -------------------------------------------------
  const perQuestion = [];
  process.stdout.write('Judging');

  for (const { qid, hyp, gold } of pairs) {
    const question     = gold.question || '';
    const goldAnswer   = gold.answer   || '';
    const questionType = gold.question_type || hyp.question_type || 'unknown';
    const hypothesis   = hyp.hypothesis || hyp.error || '';
    // Abstention questions are identified by question_id suffix "_abs" (not question_type)
    const isAbstention = typeof qid === 'string' && qid.endsWith('_abs');

    let result;
    if (IS_MOCK) {
      result = judgeWithMock(questionType, goldAnswer, hypothesis, isAbstention);
    } else {
      result = await judgeWithGpt4o(openaiClient, questionType, question, goldAnswer, hypothesis, isAbstention);
    }

    perQuestion.push({
      question_id:    qid,
      question_type:  questionType,
      autoeval_label: result.label,
      hypothesis,
      answer:         goldAnswer,
      judge_raw:      result.raw,
      parse_ok:       result.parseOk,
      ...(result.error ? { error: result.error } : {}),
    });

    process.stdout.write('.');
  }

  console.log(''); // newline after dots

  // ---- aggregate scores -----------------------------------------------------

  const totalScored = perQuestion.filter(r => !r.error).length;
  const totalCorrect = perQuestion.filter(r => !r.error && r.autoeval_label === 1).length;
  const headline = totalScored > 0 ? totalCorrect / totalScored : 0;

  // Per-category breakdown (always include knowledge-update even when count is 0)
  const byCategory = {};

  // Initialize all known types to null (no data) — we'll fill them in
  for (const qt of QUESTION_TYPES) {
    byCategory[qt] = null;
  }

  // Accumulate per category
  const catBuckets = {};
  for (const r of perQuestion) {
    if (r.error) continue;
    const qt = r.question_type || 'unknown';
    if (!catBuckets[qt]) catBuckets[qt] = { correct: 0, total: 0 };
    catBuckets[qt].correct += r.autoeval_label;
    catBuckets[qt].total   += 1;
  }

  // Fill in computed scores; ensure knowledge-update key always present
  for (const [qt, counts] of Object.entries(catBuckets)) {
    byCategory[qt] = counts.total > 0 ? counts.correct / counts.total : 0;
  }

  // Guarantee knowledge-update key exists even when no KU questions in this run
  if (!('knowledge-update' in byCategory) || byCategory['knowledge-update'] === null) {
    byCategory['knowledge-update'] = catBuckets['knowledge-update']
      ? catBuckets['knowledge-update'].correct / catBuckets['knowledge-update'].total
      : 0;
  }

  // Strip nulls for categories with no data in this run (keep known types that ran)
  const finalByCategory = {};
  for (const [qt, score] of Object.entries(byCategory)) {
    if (score !== null) finalByCategory[qt] = score;
  }
  // Always include knowledge-update (even as 0 if no KU questions)
  if (!('knowledge-update' in finalByCategory)) finalByCategory['knowledge-update'] = 0;

  // ---- build output envelope ------------------------------------------------

  const meta = {
    eval:                    'longmemeval-s',
    date:                    new Date().toISOString().slice(0, 10),
    commit:                  getCommit(),
    engine_version:          getEngineVersion(),
    questions_total:         perQuestion.length,
    questions_skipped_error: skippedHarnessErrors,
    judge_model:             IS_MOCK ? 'mock-substring' : JUDGE_MODEL,
  };

  const scores = { headline, by_category: finalByCategory };

  const envelope = { meta, scores, per_question: perQuestion };

  // ---- write results --------------------------------------------------------
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(envelope, null, 2));

  // ---- report ---------------------------------------------------------------
  console.log(`\n=== LongMemEval Scores ===`);
  console.log(`Headline accuracy:  ${(headline * 100).toFixed(1)}% (${totalCorrect}/${totalScored})`);
  console.log(`\nPer-category breakdown:`);
  for (const [qt, score] of Object.entries(finalByCategory)) {
    const bucket = catBuckets[qt];
    const n = bucket ? bucket.total : 0;
    const mark = qt === 'knowledge-update' ? ' <-- KU (positioning key)' : '';
    console.log(`  ${qt.padEnd(28)} ${(score * 100).toFixed(1)}% (n=${n})${mark}`);
  }

  console.log(`\nResults -> ${OUT_FILE}`);
  console.log(`Judge: ${meta.judge_model} | commit: ${meta.commit} | engine: ${meta.engine_version}`);
})();
