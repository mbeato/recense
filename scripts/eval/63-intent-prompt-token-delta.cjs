/**
 * CLASSIFY-01 gmail intent-classification prompt-prefix token-delta harness (Phase 63 Plan 06).
 *
 * Measures what the enlarged gmail extraction prompt (GMAIL_INTENT_CLASSIFICATION_BLOCK,
 * landed in plan 63-02) actually costs in INPUT TOKENS — honestly, not estimated. Two arms,
 * both derived from live source so neither can drift from what production actually sends:
 *
 *   Arm A (baseline)     = promptForSource('gmail') with GMAIL_INTENT_CLASSIFICATION_BLOCK
 *                           removed by a single exact-string replace
 *   Arm B (w/ classify)  = promptForSource('gmail') exactly as landed
 *
 * The SAME synthetic sample gmail episode (provenance header + short recruiter-rejection
 * body, no real mail, no PII) is appended to both arms, so the two arms differ ONLY by the
 * classification block.
 *
 * CURRENCY IS TOKENS. Any dollar figure quoted alongside a token count is an API list-price
 * equivalent, not an actual charge — the founder's Max subscription (`claude -p`) bills flat
 * regardless of this run; the real cost is subscription token budget, not cash.
 *
 * One full (non---offline) run costs EXACTLY TWO `claude -p` calls — one per arm.
 *
 * Mirrors scripts/eval/cost-benefit-harness.cjs's usage-sink discipline: it NEVER fabricates
 * a token number. When dist/ isn't built, the usage sink captures anything other than exactly
 * one call per arm, or --offline is passed, the result is written with measured:false and an
 * honest reason instead of a guessed figure.
 *
 * Run:
 *   npm run build && node scripts/eval/63-intent-prompt-token-delta.cjs --offline
 *     → CI-safe deterministic mode. Character/word deltas only. $0, no claude -p calls.
 *
 *   npm run build && RECENSE_EXTRACTOR_PROVIDER=claude-headless node scripts/eval/63-intent-prompt-token-delta.cjs
 *     → Measured mode. Spends exactly two claude -p calls against the Max subscription.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OFFLINE = process.argv.includes('--offline');
const OUT = path.join('scripts', 'eval', 'results', '63-intent-prompt-token-delta.json');

// Mirrors EXTRACTION_MAX_TOKENS (src/model/claim-extractor.ts) — the real production
// extraction call's max_tokens, kept identical here so this measurement reflects the
// actual call shape, not a harness-invented one.
const EXTRACTION_MAX_TOKENS = 8192;

// Synthetic sample gmail episode — same shape gmail-adapter.ts produces
// (`From: <sender> · Re: <subject> · Acct: <accountId>` provenance header + body).
// Synthetic only: no real mailbox content, no PII.
const SAMPLE_EPISODE_ROLE = 'user';
const SAMPLE_EPISODE_CONTENT =
  'From: recruiting@example-corp.test · Re: Your application to Example Corp · Acct: default\n\n' +
  'Hi Alex,\n\nThank you for your interest in the Backend Engineer role at Example Corp. ' +
  'After careful review, we have decided not to move forward with your application at this time. ' +
  'We wish you the best in your job search.\n\nBest,\nExample Corp Recruiting Team';

function header(title) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + title);
  console.log('─'.repeat(60));
}

function writeResult(obj) {
  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(obj, null, 2));
  console.log(`\nResults written -> ${OUT}`);
}

/** Write an honest measured:false result and exit non-zero. Never fabricates a number. */
function fail(reason, extra) {
  const result = { measured: false, reason, measured_at: new Date().toISOString(), ...(extra || {}) };
  writeResult(result);
  console.error(`\nFATAL: ${reason}`);
  process.exit(1);
}

(async function main() {
  header('CLASSIFY-01 gmail prompt-prefix token-delta harness');
  console.log('  Currency: tokens. Any $ figure is API list-price equivalent, not an actual charge.');
  console.log(`  Mode: ${OFFLINE ? '--offline (CI-safe, $0)' : 'LIVE (spends exactly 2 claude -p calls)'}`);

  // ── Require compiled dist modules (build prerequisite) ──────────────────────
  let promptForSource;
  let GMAIL_INTENT_CLASSIFICATION_BLOCK;
  let setHeadlessUsageSink;
  let createClaudeHeadlessClient;
  let DEFAULT_CONFIG;
  let resolveProviderOverlay;
  try {
    ({ promptForSource, GMAIL_INTENT_CLASSIFICATION_BLOCK } = require('../../dist/src/source/extraction-prompts'));
    ({ setHeadlessUsageSink, createClaudeHeadlessClient } = require('../../dist/src/model/claude-headless-client'));
    ({ DEFAULT_CONFIG } = require('../../dist/src/lib/config'));
    ({ resolveProviderOverlay } = require('../../dist/src/consolidation/run-sleep-pass'));
  } catch (e) {
    fail(`Run npm run build first: ${e.message}`);
    return;
  }

  // ── Build the two prompt arms from LIVE source ───────────────────────────────
  const armBPrefix = promptForSource('gmail'); // WITH classification, as landed
  const armAPrefix = armBPrefix.replace(GMAIL_INTENT_CLASSIFICATION_BLOCK, ''); // baseline

  if (armAPrefix === armBPrefix) {
    fail(
      "GMAIL_INTENT_CLASSIFICATION_BLOCK removal from promptForSource('gmail') was a no-op — " +
        'the block is not actually interpolated into the live gmail prompt. This would silently ' +
        'produce a bogus zero delta, so the harness refuses to proceed.'
    );
    return;
  }

  // Identical suffix on both arms — mirrors the exact consolidator concatenation
  // (src/consolidation/consolidator.ts): promptForSource(source) + episode.role +
  // '\n\nDocument content:\n' + episode.content.
  const suffix = SAMPLE_EPISODE_ROLE + '\n\nDocument content:\n' + SAMPLE_EPISODE_CONTENT;
  const armAFull = armAPrefix + suffix;
  const armBFull = armBPrefix + suffix;

  // Deterministic cross-check (works with or without a live claude -p run).
  const armAPrefixChars = armAPrefix.length;
  const armBPrefixChars = armBPrefix.length;
  const prefixCharDelta = armBPrefixChars - armAPrefixChars;
  const prefixCharDeltaPct = armAPrefixChars > 0 ? (prefixCharDelta / armAPrefixChars) * 100 : null;

  console.log(`\n  Arm A (baseline) prefix chars:    ${armAPrefixChars}`);
  console.log(`  Arm B (w/ classification) prefix chars: ${armBPrefixChars}`);
  console.log(
    `  Deterministic prefix char delta:  ${prefixCharDelta} (+${
      prefixCharDeltaPct === null ? 'n/a' : prefixCharDeltaPct.toFixed(1)
    }%)`
  );

  const crossCheck = {
    arm_a_prefix_chars: armAPrefixChars,
    arm_b_prefix_chars: armBPrefixChars,
    prefix_char_delta: prefixCharDelta,
    prefix_char_delta_pct: prefixCharDeltaPct === null ? null : +prefixCharDeltaPct.toFixed(2),
  };

  // ── --offline: CI-safe deterministic mode, no claude -p spend ───────────────
  if (OFFLINE) {
    header('OFFLINE MODE — deterministic character/word deltas only, no claude -p spend');
    const armAWords = armAPrefix.split(/\s+/).filter(Boolean).length;
    const armBWords = armBPrefix.split(/\s+/).filter(Boolean).length;

    const result = {
      measured: false,
      reason:
        'Ran with --offline: the token delta was NOT measured (zero claude -p calls made). ' +
        'The character/word deltas below are deterministic string measurements, not tokenizer output.',
      model: null,
      arm_a_input_tokens: null,
      arm_b_input_tokens: null,
      input_token_delta: null,
      input_token_delta_pct: null,
      ...crossCheck,
      arm_a_prefix_words: armAWords,
      arm_b_prefix_words: armBWords,
      prefix_word_delta: armBWords - armAWords,
      measured_at: new Date().toISOString(),
    };
    writeResult(result);
    console.log(`  measured: false (offline mode)`);
    process.exit(0);
    return;
  }

  // ── LIVE mode — two claude -p calls via the headless usage sink ─────────────
  header('LIVE MODE — two claude -p calls (one per arm) via the headless usage sink');

  const overlay = resolveProviderOverlay(process.env, 'RECENSE_EXTRACTOR_PROVIDER');
  const config = { ...DEFAULT_CONFIG, dbPath: '', ...overlay };

  if (config.modelProvider !== 'claude-headless') {
    fail(
      `RECENSE_EXTRACTOR_PROVIDER must be "claude-headless" for a measured run ` +
        `(resolved modelProvider="${config.modelProvider}"). Re-run with: ` +
        `RECENSE_EXTRACTOR_PROVIDER=claude-headless node scripts/eval/63-intent-prompt-token-delta.cjs`,
      crossCheck
    );
    return;
  }

  const { client, model } = createClaudeHeadlessClient(config);

  // Install the sink BEFORE either call, clear it in finally — mirrors
  // cost-benefit-harness.cjs's discipline exactly.
  const captured = [];
  setHeadlessUsageSink(u => { captured.push(u); });

  try {
    await client.messages.create({
      model,
      max_tokens: EXTRACTION_MAX_TOKENS,
      messages: [{ role: 'user', content: armAFull }],
    });
    await client.messages.create({
      model,
      max_tokens: EXTRACTION_MAX_TOKENS,
      messages: [{ role: 'user', content: armBFull }],
    });
  } finally {
    setHeadlessUsageSink(null);
  }

  if (captured.length !== 2) {
    fail(
      `Usage sink captured ${captured.length} call(s), expected exactly 2 (one per arm). ` +
        'The claude binary may be unavailable, unauthenticated, or a call errored/timed out. ' +
        'No token number is fabricated.',
      { calls_captured: captured.length, ...crossCheck }
    );
    return;
  }

  const [armAUsage, armBUsage] = captured;
  const armAInput = armAUsage.usage ? armAUsage.usage.input_tokens : undefined;
  const armBInput = armBUsage.usage ? armBUsage.usage.input_tokens : undefined;

  if (typeof armAInput !== 'number' || typeof armBInput !== 'number') {
    fail(
      'Usage envelope missing input_tokens for one or both arms — the claude -p envelope may ' +
        'have changed shape. No token number is fabricated.',
      {
        arm_a_usage: armAUsage.usage || null,
        arm_b_usage: armBUsage.usage || null,
        ...crossCheck,
      }
    );
    return;
  }

  const inputDelta = armBInput - armAInput;
  const inputDeltaPct = armAInput > 0 ? (inputDelta / armAInput) * 100 : null;

  console.log(`\n  Model: ${model}`);
  console.log(
    `  Arm A input tokens: ${armAInput} ` +
      `(cache_creation=${armAUsage.usage.cache_creation_input_tokens ?? 'n/a'}, ` +
      `cache_read=${armAUsage.usage.cache_read_input_tokens ?? 'n/a'})`
  );
  console.log(
    `  Arm B input tokens: ${armBInput} ` +
      `(cache_creation=${armBUsage.usage.cache_creation_input_tokens ?? 'n/a'}, ` +
      `cache_read=${armBUsage.usage.cache_read_input_tokens ?? 'n/a'})`
  );
  console.log(
    `  Input token delta:  ${inputDelta} (+${inputDeltaPct === null ? 'n/a' : inputDeltaPct.toFixed(1)}%)`
  );

  const result = {
    measured: true,
    model,
    arm_a_input_tokens: armAInput,
    arm_b_input_tokens: armBInput,
    input_token_delta: inputDelta,
    input_token_delta_pct: inputDeltaPct === null ? null : +inputDeltaPct.toFixed(2),
    arm_a_cache_creation_input_tokens: armAUsage.usage.cache_creation_input_tokens ?? null,
    arm_a_cache_read_input_tokens: armAUsage.usage.cache_read_input_tokens ?? null,
    arm_b_cache_creation_input_tokens: armBUsage.usage.cache_creation_input_tokens ?? null,
    arm_b_cache_read_input_tokens: armBUsage.usage.cache_read_input_tokens ?? null,
    ...crossCheck,
    measured_at: new Date().toISOString(),
  };
  writeResult(result);
  header('DONE');
})().catch(err => {
  fail(`Uncaught error: ${err.message || err}`);
});
