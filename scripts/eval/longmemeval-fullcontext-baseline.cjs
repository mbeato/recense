/**
 * LongMemEval full-context baseline — NO memory system.
 *
 * The canonical comparison arm: the entire haystack (all sessions, chronological,
 * with session dates) is stuffed directly into the answer model's context. Same
 * answer model (ANSWER_MODEL = Haiku), same prompt skeleton as the harness
 * (history → current date → question → "Answer:"), same scorer downstream — so
 * memory-system-vs-full-context is the ONLY variable.
 *
 * Token budget: Haiku context is 200K. Input is capped at INPUT_BUDGET_TOKENS
 * (chars/4 proxy); when a haystack exceeds it, the OLDEST sessions are dropped
 * first (chronological truncation, the standard baseline treatment — disclosed
 * per-question in the output as truncated_sessions).
 *
 *   NODE_PATH=$(pwd)/node_modules node scripts/eval/longmemeval-fullcontext-baseline.cjs \
 *     --eval scripts/eval/results/longmemeval-ku-only.jsonl \
 *     --out scripts/eval/results/longmemeval-fullcontext-baseline.jsonl \
 *     [--limit 2] [--concurrency 2]
 *
 * Resume: question_ids already in --out are skipped (same convention as the harness).
 * Score with the existing scorer:
 *   node scripts/eval/longmemeval-scorer.cjs --hypotheses <out> --eval <eval> --out <scored>
 */
'use strict';
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const EVAL = arg('--eval', 'scripts/eval/results/longmemeval-ku-only.jsonl');
const OUT = arg('--out', 'scripts/eval/results/longmemeval-fullcontext-baseline.jsonl');
const LIMIT = parseInt(arg('--limit', '0'), 10);
const CONCURRENCY = Math.max(1, parseInt(arg('--concurrency', '2'), 10));

const ANSWER_MODEL = 'claude-haiku-4-5-20251001'; // matches harness ANSWER_MODEL (DEFAULT_CONFIG.anthropicModel)
const INPUT_BUDGET_TOKENS = 185_000;              // headroom under Haiku 200K for prompt skeleton + output
const CHARS_PER_TOKEN = 4;                        // proxy used throughout the repo

function buildSessionText(session, date) {
  const turns = session.map(t => `${t.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${t.content || ''}`).join('\n');
  return `--- Session (${date || 'undated'}) ---\n${turns}`;
}

function buildPrompt(q) {
  const sessions = q.haystack_sessions || [];
  const dates = q.haystack_dates || [];
  // chronological order is the file order; drop OLDEST first when over budget
  const blocks = sessions.map((s, i) => buildSessionText(s, dates[i]));
  const budgetChars = INPUT_BUDGET_TOKENS * CHARS_PER_TOKEN;
  let kept = [...blocks];
  let truncated = 0;
  let total = kept.reduce((n, b) => n + b.length, 0);
  while (total > budgetChars && kept.length > 1) {
    total -= kept[0].length;
    kept.shift(); // oldest first
    truncated++;
  }
  const history = kept.join('\n\n');
  const currentDateLine = q.question_date ? `\nCurrent Date: ${q.question_date}` : '';
  // Mirrors the harness answer prompt skeleton (history → date → question → "Answer:")
  const prompt = `I will give you the full history of conversations between you and a user. Please answer the question based on the relevant parts of the history.\n\n\nConversation History:\n\n${history}${currentDateLine}\nQuestion: ${q.question}\nAnswer:`;
  return { prompt, truncated };
}

(async () => {
  const questions = fs.readFileSync(EVAL, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const done = new Set(
    fs.existsSync(OUT)
      ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).question_id)
      : []
  );
  let todo = questions.filter(q => !done.has(q.question_id));
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);
  if (done.size) console.log(`[resume] skipping ${done.size} already-complete question(s)`);
  console.log(`Full-context baseline: ${todo.length} question(s) | model ${ANSWER_MODEL} | concurrency ${CONCURRENCY}`);
  if (!todo.length) return;

  const client = new Anthropic();
  let inTok = 0, outTok = 0, errors = 0, idx = 0;
  const t0 = Date.now();

  async function worker() {
    while (idx < todo.length) {
      const q = todo[idx++];
      const { prompt, truncated } = buildPrompt(q);
      try {
        const resp = await client.messages.create({
          model: ANSWER_MODEL,
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }],
        });
        const hypothesis = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        inTok += resp.usage?.input_tokens || 0;
        outTok += resp.usage?.output_tokens || 0;
        fs.appendFileSync(OUT, JSON.stringify({
          question_id: q.question_id,
          question_type: q.question_type,
          hypothesis,
          truncated_sessions: truncated,
        }) + '\n');
        process.stdout.write('.');
      } catch (e) {
        errors++;
        fs.appendFileSync(OUT, JSON.stringify({
          question_id: q.question_id,
          question_type: q.question_type,
          hypothesis: '',
          error: String(e.message || e).slice(0, 200),
        }) + '\n');
        process.stdout.write('E');
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  // Haiku 4.5 pricing: $1/M input, $5/M output
  const cost = (inTok / 1e6) * 1 + (outTok / 1e6) * 5;
  console.log(`\nDone: ${todo.length - errors} ok, ${errors} errors | ${mins} min | ${(inTok / 1e6).toFixed(2)}M in / ${(outTok / 1e3).toFixed(1)}K out ≈ $${cost.toFixed(2)}`);
})();
