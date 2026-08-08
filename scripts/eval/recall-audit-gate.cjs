#!/usr/bin/env node
'use strict';

/**
 * recall-audit-gate.cjs — Phase 69 RECALL-05 eval-first gate (D-08/D-09).
 *
 * Replays the 58-prompt memory-shaped eval set (real personal prompts extracted from real
 * Claude Code sessions — resume, jobfill, brain-memory, VTX, aurevion) against `ambientRecall`
 * on the founder's LIVE graph, once with Phase-69 knobs dark (--baseline, reproduces pre-phase
 * behavior) and once with them lit (--run, compared against the baseline artifact). Encodes
 * D-08's four hard gates (G1 contract-class, G2 no-regression, G3 foreign-doc-ordering, G4
 * budget) as individually-reported, never-short-circuited checks.
 *
 * This is NEVER part of `npm run gate` — it needs a live personal DB, an OPENAI_API_KEY, and a
 * gitignored eval-set file that only exists locally. It replays REAL personal prompts. The
 * OUTPUT is aggregate-only: SHA-256 prompt_id prefixes, counts, and deltas — never a prompt,
 * never `ambient_block`, never a node `value`/title string. A pre-write self-check rejects the
 * write if any output string exceeds 200 chars or matches an input prompt verbatim.
 *
 * Run:
 *   npm run build
 *   node scripts/eval/recall-audit-gate.cjs --baseline --db ~/.config/recense/recense.db
 *   node scripts/eval/recall-audit-gate.cjs --run --db ~/.config/recense/recense.db \
 *     --baseline-json scripts/eval/results/recall-audit/69-gate-baseline.json \
 *     --nudge 0.05 --demote 0.10
 *
 * Args:
 *   --baseline | --run   exactly one required (mode-guard, gate-accuracy-runner.cjs precedent)
 *   --set <path>         eval-set JSONL (default scripts/eval/results/recall-audit/memory-shaped-evalset.jsonl)
 *   --db <path>          live DB (default RECENSE_DB env, else ~/.config/recense/recense.db)
 *   --out <path>         output artifact (default scripts/eval/results/recall-audit/69-gate-<mode>.json)
 *   --baseline-json <path> baseline artifact --run compares against (required for --run)
 *   --nudge <n>           sameProjectRankNudge override for --run (default 0.05)
 *   --demote <n>          foreignDocDemotion override for --run (default 0.10)
 *
 * Fail-closed (each a distinct `GATE FAIL:` + exit 1, gate-accuracy-runner.cjs:76-84 precedent):
 * eval set missing/unparseable/zero-rows, DB missing, OPENAI_API_KEY unset, --run with a
 * missing/unparseable baseline artifact. An absent input NEVER reports a trivial pass.
 *
 * Relevance grading (default, LLM-free, deterministic): mean over a row's injected fact lines
 * of the Dice token-overlap between the normalized prompt and the normalized line value/title
 * (`normalizeValue`, the same normalization the engine uses). This is a LEXICAL PROXY, not a
 * judge — its absolute value is meaningless; only baseline-vs-run deltas on the SAME prompt are
 * interpretable.
 *
 * `--judge` (opt-in, 2026-08-07, discharges the 69-06 follow-up): swaps the lexical proxy for a
 * gpt-4o-mini relevance grade — one call per replayed row, temperature 0, grading every injected
 * fact line 0/1 for "useful context for this prompt", row relevance = mean of labels. This is
 * the explicit PAID tier (locomo-scorer.cjs precedent) and is NEVER the default: without the
 * flag the script stays lexical/offline besides the 58 embeds. Judge mode sends the prompt and
 * the rendered line values to OpenAI — the same provider that already receives every prompt via
 * the replay embed. Judge errors fail CLOSED (3 attempts, then exit 1 — a failed grade never
 * counts as a 0). Artifacts record `grader`; `--run` refuses a baseline graded by a different
 * grader, so G2 deltas are never computed across grading methods. Judge artifacts default to
 * their own `-judge` suffixed paths and never clobber the lexical ones.
 *
 * Parsing note (Claude's-discretion resolution, mirrors 69-04-SUMMARY's documented tension):
 * the rendered block (69-04 grammar) carries a raw node id ONLY on doc-mode lines
 * (`recense://doc/<id>`); plain fact lines carry no id. G1-G4 only need per-line
 * {scope, is_doc, is_anchored, score, value-for-relevance}, all recoverable from the rendered
 * text alone — node_id is populated when present (doc lines) and left null otherwise, which is
 * sufficient because G3 (the only id-adjacent gate) reasons over scope+is_doc, not raw ids.
 *
 * Read-only-intent invariant (T-69-06-WRITE): the DB is opened normally (not SQLite-readonly,
 * since ambientRecall's SwitchableActivationTraceSink prepares a statement against `meta` even
 * when the flag is off) but this script issues zero writes itself. `activation_trace` row count
 * is asserted unchanged at the end; if `viz_trace_enabled` is unexpectedly on, that is NOTED in
 * the output, never silently mutated.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
const { initSchema } = require(DIST + '/db/schema');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');
const { realClock } = require(DIST + '/lib/clock');
const { ambientRecall, AMBIENT_K, AMBIENT_BLOCK_CHAR_BUDGET } = require(DIST + '/adapter/ambient-recall');
const { DefaultModelProvider } = require(DIST + '/model/provider');
const { normalizeValue } = require(DIST + '/consolidation/normalize');
const { cwdToScope, GLOBAL_SCOPE } = require(DIST + '/lib/scope');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const IS_BASELINE = process.argv.includes('--baseline');
const IS_RUN = process.argv.includes('--run');

if (!IS_BASELINE && !IS_RUN) {
  console.error('Usage: recall-audit-gate.cjs [--baseline | --run] [options]');
  console.error('');
  console.error('  --baseline   Replay with all five Phase-69 knobs forced dark. Writes a reusable artifact.');
  console.error('  --run        Replay with the knobs lit; reports G1-G4 against --baseline-json.');
  console.error('');
  console.error('  --set <path>            eval-set JSONL (default scripts/eval/results/recall-audit/memory-shaped-evalset.jsonl)');
  console.error('  --db <path>             live DB (default RECENSE_DB env, else ~/.config/recense/recense.db)');
  console.error('  --out <path>            output artifact path');
  console.error('  --baseline-json <path>  baseline artifact (--run only)');
  console.error('  --nudge <n> --demote <n> rank-weight sweep overrides (--run only)');
  console.error('  --judge                 PAID: grade relevance with gpt-4o-mini instead of the lexical proxy.');
  console.error('                          Never the default. Baseline and run must use the same grader.');
  console.error('');
  console.error('  This is NOT part of `npm run gate` — needs a live personal DB + OPENAI_API_KEY.');
  process.exit(1);
}

const MODE = IS_BASELINE ? 'baseline' : 'run';
const IS_JUDGE = process.argv.includes('--judge');
const GRADER = IS_JUDGE ? 'judge' : 'lexical';
const JUDGE_MODEL = 'gpt-4o-mini';
const GRADER_SUFFIX = IS_JUDGE ? '-judge' : '';
const SET_PATH = path.resolve(arg('--set', 'scripts/eval/results/recall-audit/memory-shaped-evalset.jsonl'));
const DB_PATH = arg('--db', process.env.RECENSE_DB || path.join(os.homedir(), '.config/recense/recense.db'));
const OUT_PATH = path.resolve(arg('--out', `scripts/eval/results/recall-audit/69-gate-${MODE}${GRADER_SUFFIX}.json`));
const BASELINE_JSON_PATH = arg('--baseline-json', path.resolve(`scripts/eval/results/recall-audit/69-gate-baseline${GRADER_SUFFIX}.json`));
const NUDGE = parseFloat(arg('--nudge', '0.05'));
const DEMOTE = parseFloat(arg('--demote', '0.10'));

// ---- fail-closed input checks (never a trivial pass on a missing input) -----------------
if (!fs.existsSync(SET_PATH)) {
  console.error(`GATE FAIL: eval set not found at ${SET_PATH} — cannot replay`);
  process.exit(1);
}
let evalRows;
try {
  evalRows = fs
    .readFileSync(SET_PATH, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
} catch (e) {
  console.error(`GATE FAIL: could not parse eval set at ${SET_PATH}: ${e.message}`);
  process.exit(1);
}
if (evalRows.length === 0) {
  console.error(`GATE FAIL: zero rows parsed from ${SET_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`GATE FAIL: DB not found at ${DB_PATH} — cannot replay against the live graph`);
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error('GATE FAIL: OPENAI_API_KEY not set — the replay needs one embed per prompt');
  process.exit(1);
}
let baselineArtifact = null;
if (IS_RUN) {
  if (!fs.existsSync(BASELINE_JSON_PATH)) {
    console.error(`GATE FAIL: baseline artifact not found at ${BASELINE_JSON_PATH} — run --baseline first`);
    process.exit(1);
  }
  try {
    baselineArtifact = JSON.parse(fs.readFileSync(BASELINE_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error(`GATE FAIL: could not parse baseline artifact at ${BASELINE_JSON_PATH}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(baselineArtifact.rows) || baselineArtifact.rows.length === 0) {
    console.error(`GATE FAIL: baseline artifact at ${BASELINE_JSON_PATH} has no rows`);
    process.exit(1);
  }
  // Grader-mismatch guard: G2 deltas are only interpretable within one grading method.
  // Pre-judge baselines carry no `grader` field — treat absent as 'lexical'.
  const baselineGrader = baselineArtifact.grader || 'lexical';
  if (baselineGrader !== GRADER) {
    console.error(`GATE FAIL: baseline at ${BASELINE_JSON_PATH} was graded with '${baselineGrader}' but this run uses '${GRADER}' — rerun --baseline with the same grader`);
    process.exit(1);
  }
}

let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

// ---- DB open (T-69-06-WRITE: never write ourselves; assert row count unchanged) ---------
const db = new Database(DB_PATH);
initSchema(db);
const vizFlagRow = db.prepare("SELECT value FROM meta WHERE key = 'viz_trace_enabled'").get();
const vizFlagOn = !!vizFlagRow && vizFlagRow.value === '1';
const traceCountBefore = db.prepare('SELECT count(*) AS n FROM activation_trace').get().n;

// ---- config ------------------------------------------------------------------------------
const DARK_KNOBS = {
  entityAnchoringEnabled: false,
  sameProjectRankNudge: 0,
  foreignDocDemotion: 0,
  ambientDocLinkRenderEnabled: false,
  ambientHopInjectionEnabled: false,
};
// --no-anchor (2026-08-07): keep entityAnchoringEnabled dark in --run. Added for the doc-link
// re-gate after the judge re-gate confirmed anchoring's G2 failure — without it, every --run
// conflates the known-failing anchoring knob into whichever OTHER knob is being gated.
const NO_ANCHOR = process.argv.includes('--no-anchor');
const LIT_KNOBS = {
  entityAnchoringEnabled: !NO_ANCHOR,
  sameProjectRankNudge: NUDGE,
  foreignDocDemotion: DEMOTE,
  ambientDocLinkRenderEnabled: true,
  ambientHopInjectionEnabled: true,
};
const knobs = IS_BASELINE ? DARK_KNOBS : LIT_KNOBS;
const config = { ...DEFAULT_CONFIG, dbPath: DB_PATH, ...knobs };
const provider = new DefaultModelProvider({ generateConfig: config, judgeConfig: config, embedConfig: config });

// ---- rendered-block parsing (69-04 grammar) -----------------------------------------------
const HEADER = 'Recalled from recense (ambient):';
const FACT_RE = /^- (?:\[([^\]]+)\] )?(.+) \((doc|[a-zA-Z_]+), score (\d+\.\d\d)(?:, via (.+))?\)$/;
const HOP_RE = /^ {2}↳ (\S+) (.+)$/;
const DOC_SEP = ' — recense://doc/';

function parseBlock(block) {
  const parsedRows = [];
  let charCount = 0;
  let unparseableCount = 0;
  if (!block || block === '{}') return { rows: parsedRows, charCount, unparseableCount };
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === HEADER || line.trim() === '') continue;
    const hopM = HOP_RE.exec(line);
    if (hopM) {
      const [, , label] = hopM;
      charCount += label.length;
      continue;
    }
    const m = FACT_RE.exec(line);
    if (!m) { unparseableCount++; continue; } // counted, never a silent skip (CR-01 2026-08-07): a
    // renderer line the grammar does not describe must surface as a G4 violation, not read as
    // "no line" — the pre-fix skip made a shattered multi-line row indistinguishable from absence.
    const [, scopeRaw, content, originOrDoc, scoreStr, via] = m;
    const scope = scopeRaw || GLOBAL_SCOPE;
    const marker = scopeRaw ? `[${scopeRaw}] ` : '';
    const isDoc = originOrDoc === 'doc';
    let value = content;
    let nodeId = null;
    if (isDoc) {
      const idx = content.indexOf(DOC_SEP);
      if (idx !== -1) {
        value = content.slice(0, idx);
        nodeId = content.slice(idx + DOC_SEP.length);
      }
    }
    charCount += marker.length + value.length;
    parsedRows.push({
      scope,
      value,
      node_id: nodeId,
      is_doc: isDoc,
      is_anchored: !!via,
      score: parseFloat(scoreStr),
    });
  }
  return { rows: parsedRows, charCount, unparseableCount };
}

function diceOverlap(promptText, valueText) {
  const A = new Set(normalizeValue(promptText).split(/\s+/).filter(Boolean));
  const B = new Set(normalizeValue(valueText).split(/\s+/).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const CONTRACT_TERM_RE = /contract|ciiaa|agreement|employment|equity|compensation|salary|terms|signed/i;

// ---- --judge grader (opt-in PAID tier; locomo-scorer.cjs precedent) -----------------------
// One gpt-4o-mini call per row: every injected line graded 0/1 for usefulness to the prompt,
// row relevance = mean. temperature 0. Fail-closed: 3 attempts, then throw (main() exits 1) —
// a failed grade must never silently score 0, which would bias G2 toward whichever arm failed.
const judgeClient = IS_JUDGE ? new (require('openai'))() : null;

async function judgeGradeRow(promptText, values) {
  if (values.length === 0) return [];
  const numbered = values.map((v, i) => `${i + 1}. ${v}`).join('\n');
  const judgePrompt =
    'A coding assistant is about to answer the user prompt below. Candidate memory lines were ' +
    'retrieved to inject as background context. For EACH numbered line, judge whether it is ' +
    'useful context for answering this specific prompt (relevant to its subject, project, or ' +
    'entities — not merely generic). Reply with ONLY a JSON array of 0/1 integers, one per ' +
    `line, in order (length ${values.length}). No other text.\n\n` +
    `User prompt:\n${promptText}\n\nCandidate memory lines:\n${numbered}`;
  let lastErr = 'unparseable response';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await judgeClient.chat.completions.create({
        model: JUDGE_MODEL,
        max_tokens: 10 + 4 * values.length,
        temperature: 0,
        messages: [{ role: 'user', content: judgePrompt }],
      });
      const text = response.choices?.[0]?.message?.content ?? '';
      const m = text.match(/\[[\s\d,]*\]/);
      if (m) {
        const labels = JSON.parse(m[0]);
        if (Array.isArray(labels) && labels.length === values.length && labels.every(x => x === 0 || x === 1)) {
          return labels;
        }
      }
      lastErr = `bad shape: ${text.slice(0, 80)}`;
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 200);
    }
  }
  throw new Error(`judge grading failed after 3 attempts: ${lastErr}`);
}

// ---- replay loop ---------------------------------------------------------------------------
async function main() {
  const perRow = [];
  const g1Matches = []; // prompt_ids of the contract-with-vtx class
  const g1Failures = [];
  const g3Violations = [];
  const g4Violations = [];

  for (const row of evalRows) {
    const promptId = crypto.createHash('sha256').update(row.prompt).digest('hex').slice(0, 12);
    const cwd = '/Users/evaluser/' + String(row.project).toLowerCase();
    const projectScope = cwdToScope(cwd);
    let block = '';
    try {
      block = await ambientRecall(db, row.prompt, provider, config, realClock, cwd);
    } catch (e) {
      console.error(`[recall-audit-gate] prompt_id=${promptId} ambientRecall threw: ${e.message}`);
      block = '';
    }
    const { rows: parsedRows, charCount, unparseableCount } = parseBlock(block);
    const relevances = IS_JUDGE
      ? await judgeGradeRow(row.prompt, parsedRows.map(r => r.value))
      : parsedRows.map(r => diceOverlap(row.prompt, r.value));
    const meanRelevance = relevances.length ? relevances.reduce((a, b) => a + b, 0) / relevances.length : 0;

    // G1 CONTRACT-CLASS (checked here per-row while raw values are still in memory; only the
    // pass/fail boolean + prompt_id is retained past this point — never the value text).
    const isContractClass = /contract/i.test(row.prompt) && /vtx/i.test(row.prompt);
    if (isContractClass) {
      const surfaces = parsedRows.some(r => CONTRACT_TERM_RE.test(r.value));
      if (surfaces) g1Matches.push(promptId);
      else g1Failures.push(promptId);
    }

    // G3 FOREIGN-DOC (run mode only — meaningful once doc rendering is live, but computed for
    // every row so baseline artifacts stay symmetric/comparable).
    const allowedScopes = new Set([projectScope, GLOBAL_SCOPE]);
    const firstAllowedIdx = parsedRows.findIndex(r => allowedScopes.has(r.scope));
    if (firstAllowedIdx !== -1) {
      for (let i = 0; i < firstAllowedIdx; i++) {
        if (parsedRows[i].is_doc && !allowedScopes.has(parsedRows[i].scope)) {
          g3Violations.push(promptId);
          break;
        }
      }
    }

    // G4 BUDGET + GRAMMAR (CR-01 2026-08-07: any non-header line matching neither FACT_RE nor
    // HOP_RE is a violation — malformed renderer output must never read as a silent pass).
    if (charCount > AMBIENT_BLOCK_CHAR_BUDGET || parsedRows.length > AMBIENT_K || unparseableCount > 0) {
      g4Violations.push(promptId);
    }

    perRow.push({
      prompt_id: promptId,
      project: row.project,
      line_count: parsedRows.length,
      char_count: charCount,
      unparseable_line_count: unparseableCount,
      relevance: Number(meanRelevance.toFixed(4)),
      has_anchored: parsedRows.some(r => r.is_anchored),
      has_doc: parsedRows.some(r => r.is_doc),
      contract_class: isContractClass,
    });
  }

  const traceCountAfter = db.prepare('SELECT count(*) AS n FROM activation_trace').get().n;
  db.close();

  const out = {
    mode: MODE,
    commit,
    ts: new Date().toISOString(),
    grader: GRADER,
    ...(IS_JUDGE ? { judge_model: JUDGE_MODEL } : {}),
    knobs,
    row_count: perRow.length,
    viz_trace_enabled_observed: vizFlagOn,
    activation_trace_row_count_before: traceCountBefore,
    activation_trace_row_count_after: traceCountAfter,
    activation_trace_unchanged: traceCountBefore === traceCountAfter,
    rows: perRow,
    distribution: {
      mean_line_count: mean(perRow.map(r => r.line_count)),
      median_char_count: median(perRow.map(r => r.char_count)),
      mean_char_count: mean(perRow.map(r => r.char_count)),
      mean_relevance: Number(mean(perRow.map(r => r.relevance)).toFixed(4)),
      anchored_block_count: perRow.filter(r => r.has_anchored).length,
      unparseable_line_count: perRow.reduce((n, r) => n + r.unparseable_line_count, 0),
    },
  };

  if (IS_RUN) {
    const qualifying = baselineArtifact.rows.filter(r => r.line_count >= 1);

    // G1 — the class must be non-empty; an empty class is a set problem, not a pass.
    const g1Pass = (g1Matches.length + g1Failures.length) > 0 && g1Failures.length === 0;

    // G2 NO-REGRESSION
    let g2Pass = true;
    const g2Failures = [];
    for (const bRow of qualifying) {
      const rRow = perRow.find(r => r.prompt_id === bRow.prompt_id);
      if (!rRow || rRow.line_count < 1 || rRow.relevance < bRow.relevance - 0.01) {
        g2Pass = false;
        g2Failures.push(bRow.prompt_id);
      }
    }

    const g3Pass = g3Violations.length === 0;
    const g4Pass = g4Violations.length === 0;

    out.gates = {
      G1_contract_class: {
        pass: g1Pass,
        detail: {
          description: '"contract with vtx" class surfaces contract facts',
          class_size: g1Matches.length + g1Failures.length,
          surfaced: g1Matches,
          failed: g1Failures,
        },
      },
      G2_no_regression: {
        pass: g2Pass,
        detail: {
          description: 'zero regression on prompts currently-hit in baseline (line_count>=1, relevance held within -0.01)',
          qualifying_row_count: qualifying.length,
          failed: g2Failures,
        },
      },
      G3_foreign_doc: {
        pass: g3Pass,
        detail: {
          description: 'foreign-scope doc line never renders above an own-project/global line',
          violations: g3Violations,
        },
      },
      G4_budget: {
        pass: g4Pass,
        detail: {
          description: `block char count <= ${AMBIENT_BLOCK_CHAR_BUDGET}, line count <= ${AMBIENT_K}, and zero unparseable lines`,
          violations: g4Violations,
        },
      },
    };
    out.all_gates_pass = g1Pass && g2Pass && g3Pass && g4Pass;
  }

  // ---- privacy self-check (T-69-06-PII) — reject the write rather than leak a prompt --------
  const promptSet = new Set(evalRows.map(r => r.prompt));
  let rejected = false;
  const visit = v => {
    if (rejected) return;
    if (typeof v === 'string') {
      if (v.length > 200 || promptSet.has(v)) rejected = true;
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) visit(v[k]);
    }
  };
  visit(out);
  if (rejected) {
    console.error('GATE FAIL: refusing to write output — a string field exceeds 200 chars or matches an input prompt verbatim');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[recall-audit-gate] mode=${MODE} rows=${perRow.length} wrote ${OUT_PATH}`);
  if (vizFlagOn) console.log('[recall-audit-gate] NOTE: viz_trace_enabled was ON in this DB (not mutated).');
  if (!out.activation_trace_unchanged) {
    console.log(`[recall-audit-gate] NOTE: activation_trace row count changed (${traceCountBefore} -> ${traceCountAfter}).`);
  }
  if (IS_RUN) {
    console.log(`[recall-audit-gate] G1=${out.gates.G1_contract_class.pass} G2=${out.gates.G2_no_regression.pass} G3=${out.gates.G3_foreign_doc.pass} G4=${out.gates.G4_budget.pass}`);
  }
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

main().catch(e => {
  console.error(`[recall-audit-gate] fatal: ${e.message}`);
  process.exit(1);
});
