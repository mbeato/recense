/**
 * verify-deepseek-judge-wiring.cjs
 *
 * Validates that the WIRED engine judge (via RECENSE_JUDGE_PROVIDER=deepseek)
 * reproduces the standalone DeepSeek V4-Pro contradiction-set baseline.
 *
 * PASS criteria: relAcc >= 0.88 AND cidRecall >= 0.85
 * Standalone baseline: relAcc=0.9412, cidRecall=0.9231 (16/17 rel, 12/13 cid).
 *
 * Paid call: ~17 cases, ~$0.01 — well under approval threshold.
 *
 * Credential discipline (T-ECR-01): loads DEEPSEEK_API_KEY from sleep.env if absent;
 * never echoes or logs the key.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 1. Source DEEPSEEK_API_KEY from sleep.env if absent ──────────────────────
if (!process.env['DEEPSEEK_API_KEY']) {
  const sleepEnv = path.join(os.homedir(), '.config', 'recense', 'sleep.env');
  if (fs.existsSync(sleepEnv)) {
    const lines = fs.readFileSync(sleepEnv, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k) process.env[k] = v;
    }
  }
}

if (!process.env['DEEPSEEK_API_KEY']) {
  console.error('ERROR: DEEPSEEK_API_KEY not set and not found in ~/.config/recense/sleep.env');
  process.exit(1);
}

// ── 2. Set judge provider BEFORE requiring dist modules ──────────────────────
process.env['RECENSE_JUDGE_PROVIDER'] = 'deepseek';

// ── 3. Require built dist modules ────────────────────────────────────────────
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config.js');
const { resolveProviderOverlay } = require('../../dist/src/consolidation/run-sleep-pass.js');
const { DefaultModelProvider } = require('../../dist/src/model/provider.js');

// ── 4. Build judgeConfig and verify provider resolved ────────────────────────
const judgeConfig = {
  ...DEFAULT_CONFIG,
  dbPath: ':memory:',
  ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER'),
};

if (judgeConfig.modelProvider !== 'deepseek') {
  console.error(`ERROR: expected judgeConfig.modelProvider='deepseek', got '${judgeConfig.modelProvider}'`);
  process.exit(1);
}

console.log(`Judge provider: ${judgeConfig.modelProvider}, model: ${judgeConfig.deepseekModel}, url: ${judgeConfig.deepseekBaseUrl}`);

const provider = new DefaultModelProvider({
  generateConfig: judgeConfig,
  judgeConfig,
  embedConfig: { ...DEFAULT_CONFIG, dbPath: ':memory:' },
});

// ── 5. Load fixture and map labels ────────────────────────────────────────────
const fixturePath = path.join(__dirname, 'judge-eval-contradiction-set.json');
const all = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const RELATIONS = ['confirm', 'extend', 'contradict', 'unrelated'];

const labeled = all.filter(c => c.label && RELATIONS.includes(c.label.relation));
for (const c of labeled) {
  const li = c.label.best_candidate_index;
  if (li !== undefined && li !== null && li !== '' && Number(li) >= 0) {
    c.label.best_candidate_id = c.candidates[Number(li)] ? c.candidates[Number(li)].id : null;
  } else if (!c.label.best_candidate_id) {
    c.label.best_candidate_id = null;
  }
}

console.log(`Fixture: ${labeled.length} labeled cases | provider: deepseek (wired engine judge)`);
console.log(`Standalone baseline: relAcc=0.9412 (16/17), cidRecall=0.9231 (12/13), cidSpurious=3`);
console.log(`PASS criteria: relAcc >= 0.88 AND cidRecall >= 0.85`);
console.log('Running (engine judge includes order-swap internally)...');
process.stdout.write('\n');

// ── 6. Score function (mirrors judge-eval-runner-v2.cjs score()) ──────────────
function score(rows) {
  const n = rows.length;
  let relCorrect = 0, errors = 0, parseFail = 0;
  let cidRecallHit = 0, cidRecallTotal = 0, cidSpurious = 0;
  for (const row of rows) {
    if (row.error) { errors++; continue; }
    if (row.label.relation === row.pred.relation) relCorrect++;
    if (row.label.relation === 'contradict') {
      cidRecallTotal++;
      const cids = row.pred.contradicted_ids || [];
      if (row.label.best_candidate_id && cids.includes(row.label.best_candidate_id)) cidRecallHit++;
      cidSpurious += cids.filter(id => id !== row.label.best_candidate_id).length;
    }
  }
  const scored = n - errors;
  return {
    n, scored, errors, parseFail,
    relAcc: scored ? relCorrect / scored : 0,
    cidRecall: cidRecallTotal ? cidRecallHit / cidRecallTotal : null,
    cidSpurious,
  };
}

// ── 7. Run the wired engine judge over all labeled cases ──────────────────────
// Note: AnthropicJudge.judge() already applies JUDGE_ORDER_SWAP internally.
// Each call issues ≤2 LLM requests (forward + reversed candidates on contradict).
(async () => {
  const rows = [];
  for (const c of labeled) {
    try {
      const verdict = await provider.judge(c.claim, c.candidates);
      rows.push({ case_id: c.case_id, label: c.label, pred: verdict });
      process.stdout.write('.');
    } catch (e) {
      rows.push({ case_id: c.case_id, label: c.label, error: String(e.message || e).slice(0, 200) });
      process.stdout.write('!');
    }
  }

  process.stdout.write('\n\n');

  const s = score(rows);

  // ── 8. Print results ──────────────────────────────────────────────────────
  console.log('==================== WIRED ENGINE JUDGE (deepseek) ====================');
  console.log(`provider        : deepseek / ${judgeConfig.deepseekModel}`);
  console.log(`n               : ${s.n} (scored: ${s.scored}, errors: ${s.errors})`);
  console.log(`relAcc          : ${(s.relAcc * 100).toFixed(1)}%  (${Math.round(s.relAcc * s.scored)}/${s.scored})`);
  console.log(`cidRecall       : ${s.cidRecall == null ? 'n/a' : (s.cidRecall * 100).toFixed(1) + '%'}`);
  console.log(`cidSpurious     : ${s.cidSpurious}`);
  console.log('');
  console.log('--- baseline (standalone deepseek-v4-pro) ---');
  console.log('relAcc          : 94.1%  (16/17)');
  console.log('cidRecall       : 92.3%  (12/13)');
  console.log('cidSpurious     : 3');
  console.log('');

  const passRelAcc = s.relAcc >= 0.88;
  const passcidRecall = s.cidRecall == null ? false : s.cidRecall >= 0.85;
  const passed = passRelAcc && passcidRecall;

  if (passed) {
    console.log('PASS: relAcc >= 0.88 AND cidRecall >= 0.85 — wired engine judge matches standalone baseline within noise.');
    process.exit(0);
  } else {
    const reasons = [];
    if (!passRelAcc) reasons.push(`relAcc ${(s.relAcc * 100).toFixed(1)}% < 88% threshold`);
    if (!passcidRecall) {
      const val = s.cidRecall == null ? 'n/a' : `${(s.cidRecall * 100).toFixed(1)}%`;
      reasons.push(`cidRecall ${val} < 85% threshold`);
    }
    console.error(`FAIL: wired engine judge diverged from standalone baseline — ${reasons.join('; ')}`);
    console.error('This means the plumbing changed behavior. Investigate before using in eval.');
    process.exit(1);
  }
})();
