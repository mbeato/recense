#!/usr/bin/env node
/**
 * Judge-transport probe (Phase 35 follow-up debug tool).
 *
 * The candidate probe proved candidates surface fine (cosine ~0.62, contradiction pairs
 * co-located), so the consolidation 'contra=0 / dup~2000' must be a JUDGE-side failure.
 * The sweep ran the judge claude-headless (RECENSE_MODEL_PROVIDER=claude-headless), which
 * returns empty on any failure → parseVerdict('') → safe 'unrelated'.
 *
 * This probe runs known contradiction/confirm pairs through each judge transport
 * (claude-headless | local | anthropic) via BOTH judge() and judgeBatch() (consolidation
 * uses the batch path). If headless returns 'unrelated'/garbage on a clear contradiction
 * while local/anthropic return 'contradict', the headless judge is the culprit.
 *
 * Usage:
 *   set -a; . ~/.config/recense/sleep.env; set +a   # for ANTHROPIC_API_KEY (anthropic arm)
 *   node scripts/eval/35-judge-probe.cjs [--providers claude-headless,local,anthropic]
 */
const { resolveProviderOverlay } = require('../../dist/src/consolidation/run-sleep-pass');
const { AnthropicJudge }         = require('../../dist/src/model/judge');
const { DEFAULT_CONFIG }         = require('../../dist/src/lib/config');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const PROVIDERS = arg('--providers', 'claude-headless,local,anthropic').split(',').map(s => s.trim()).filter(Boolean);

const ITEMS = [
  { name: 'T1 contradict (synthetic)',
    claim: 'The user\'s favorite programming language is now Rust.',
    candidates: [{ id: 'c1', value: 'The user\'s favorite programming language is Python.' }] },
  { name: 'T2 confirm (synthetic)',
    claim: 'The user\'s personal best 5K time is 25 minutes 50 seconds.',
    candidates: [{ id: 'c2', value: 'User set a personal best of 25:50 in the charity 5K run.' }] },
  { name: 'T3 real pair (case 6a1eabeb)',
    claim: 'User recently set a personal best time of 27:12 in a charity 5K run.',
    candidates: [{ id: 'c3', value: 'User aims to beat their personal best time of 25:50 in a charity 5K run.' }] },
];

function cfgFor(provider) {
  const env = { RECENSE_JUDGE_PROVIDER: provider };
  if (provider === 'local') {
    env.RECENSE_JUDGE_LOCAL_MODEL = process.env.RECENSE_JUDGE_LOCAL_MODEL || 'qwen3.6:35b-a3b';
    if (process.env.RECENSE_LOCAL_BASE_URL) env.RECENSE_LOCAL_BASE_URL = process.env.RECENSE_LOCAL_BASE_URL;
  }
  const overlay = resolveProviderOverlay(env, 'RECENSE_JUDGE_PROVIDER');
  return { ...DEFAULT_CONFIG, ...overlay };
}

function fmt(v) {
  if (!v) return '(null verdict)';
  return `relation=${v.relation} mag=${(v.magnitude ?? 0).toFixed(2)} best=${v.best_candidate_id ?? 'null'}`;
}

(async () => {
  console.log(`Judge-transport probe — providers: ${PROVIDERS.join(', ')}`);
  console.log(`Expectation: T1→contradict, T2→confirm, T3→contradict/extend. A judge returning`);
  console.log(`'unrelated' on T1 has effectively failed (that's the consolidation 'dup-mint' default).\n`);

  for (const provider of PROVIDERS) {
    console.log(`\n========== provider: ${provider} ==========`);
    let judge;
    try {
      const cfg = cfgFor(provider);
      console.log(`  config: modelProvider=${cfg.modelProvider} model=${cfg.modelProvider === 'local' ? cfg.localModel : cfg.modelProvider === 'claude-headless' ? cfg.claudeHeadlessModel : cfg.anthropicModel}`);
      judge = new AnthropicJudge(cfg);
    } catch (e) {
      console.log(`  SKIP — construct failed: ${e.message || e}`);
      continue;
    }

    // single judge() per item (batch-of-1 path)
    console.log(`  --- single judge() ---`);
    for (const it of ITEMS) {
      try {
        const t0 = process.hrtime.bigint();
        const v = await judge.judge(it.claim, it.candidates);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log(`    ${it.name.padEnd(30)} → ${fmt(v)}  (${ms.toFixed(0)}ms)`);
      } catch (e) {
        console.log(`    ${it.name.padEnd(30)} → ERROR ${String(e.message || e).slice(0, 120)}`);
      }
    }

    // judgeBatch() — the path consolidation actually uses
    console.log(`  --- judgeBatch() (consolidation's path) ---`);
    try {
      const t0 = process.hrtime.bigint();
      const vs = await judge.judgeBatch(ITEMS.map(i => ({ claim: i.claim, candidates: i.candidates })));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      vs.forEach((v, i) => console.log(`    ${ITEMS[i].name.padEnd(30)} → ${fmt(v)}`));
      console.log(`    (batch latency ${ms.toFixed(0)}ms)`);
    } catch (e) {
      console.log(`    BATCH ERROR ${String(e.message || e).slice(0, 160)}`);
    }
  }

  console.log(`\nRead: if claude-headless returns 'unrelated' on T1/T3 while local/anthropic return`);
  console.log(`'contradict', the headless judge silently failed → the RANK-02 sweep graph was`);
  console.log(`degenerate because the judge no-op'd, and the no-win result is invalid (re-run needed`);
  console.log(`with a working judge). If ALL providers return 'unrelated', it's a judge-logic/prompt bug.`);
})().catch(e => { console.error('judge-probe error:', e.stack || e.message || e); process.exit(1); });
