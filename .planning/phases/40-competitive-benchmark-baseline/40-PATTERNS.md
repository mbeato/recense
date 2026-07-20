# Phase 40: Competitive Benchmark Baseline - Pattern Map

**Mapped:** 2026-06-22
**Files analyzed:** 4 new files + 1 config extension
**Analogs found:** 4 / 4

---

## File Classification

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `scripts/eval/locomo-harness.cjs` | harness (orchestrator) | batch / request-response | `scripts/eval/longmemeval-harness.cjs` | exact (clone-and-adapt) |
| `scripts/eval/locomo-scorer.cjs` | scorer (judge client) | request-response | `scripts/eval/longmemeval-scorer.cjs` | exact (clone-and-adapt) |
| `scripts/eval/latency-curve.cjs` | utility (benchmark probe) | batch / file-I/O | `scripts/eval/replay-ku-harness.cjs` (scratch DB + CandidateRetriever pattern) + `longmemeval-harness.cjs` (IS_PROBE + Date.now() timing) | role-match |
| `scripts/eval/fixtures/locomo-mini.jsonl` | fixture / config | file-I/O | `scripts/eval/fixtures/longmemeval-mini.jsonl` | exact |
| `meta` config snapshot (D-10) | config extension in scorer output | — | `scripts/eval/longmemeval-scorer.cjs` meta block + `src/lib/config.ts` DEFAULT_CONFIG | exact |

---

## Verified Function Names

The research document named several helpers. Below is their **actual** status after grepping the live source:

| Research-named helper | Actual location / name | Exists? |
|------------------------|------------------------|---------|
| `makeScratchDb()` | `longmemeval-harness.cjs` lines 185-207 | YES |
| `buildRetrievalEngine()` | `longmemeval-harness.cjs` lines 215-223 | YES |
| `runBoundedPool()` | `longmemeval-harness.cjs` lines 289-302 | YES |
| `resolveProviderOverlay()` | `dist/src/consolidation/run-sleep-pass.js` (exported) | YES |
| `instrumentTopkResults` (variable) | `longmemeval-harness.cjs` line 479 — local var `instrumentTopkResults`, assigned at line 723 | YES (variable, not a function) |
| `IS_PROBE` guard | `longmemeval-harness.cjs` line 89 | YES |
| `IS_DRY_RUN` guard | `longmemeval-harness.cjs` line 88 | YES |
| `meta.commit` + `meta.engine_version` | `longmemeval-scorer.cjs` lines 453-461 | YES |
| `formatSession(session, date)` | `longmemeval-harness.cjs` lines 275-280 | YES |
| `parseJudgeVerdict()` | `longmemeval-scorer.cjs` lines 121-148 | YES |
| `src/model/config.ts` | does NOT exist | NO — the config lives entirely in `src/lib/config.ts`; `DEFAULT_CONFIG` is at line 712 |

---

## Pattern Assignments

### `scripts/eval/locomo-harness.cjs` (harness, batch)

**Analog:** `scripts/eval/longmemeval-harness.cjs`

**Imports block** (lines 44-79):
```javascript
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

if (!process.env.RECENSE_SDK_MAX_RETRIES) {
  process.env.RECENSE_SDK_MAX_RETRIES = '10';
}

const DIST = require('path').resolve(__dirname, '../../dist/src');
const { initSchema }            = require(DIST + '/db/schema');
const { EpisodicStore }         = require(DIST + '/db/episode-store');
const { realClock }             = require(DIST + '/lib/clock');
const { DEFAULT_CONFIG }        = require(DIST + '/lib/config');
const { runConsolidation, resolveProviderOverlay } = require(DIST + '/consolidation/run-sleep-pass');
const { createClaudeHeadlessClient } = require(DIST + '/model/claude-headless-client');
const { RetrievalEngine }       = require(DIST + '/retrieval/engine');
const { CandidateRetriever }    = require(DIST + '/retrieval/topk');
const { SemanticStore }         = require(DIST + '/db/semantic-store');
const { StrengthDecayManager }  = require(DIST + '/strength/decay');
const { AllocationGate }        = require(DIST + '/gate/allocation-gate');
const { OpenAIEmbedder }        = require(DIST + '/model/embedder');
const { NoopActivationTraceSink } = require(DIST + '/viz/activation-sink');
const Database                  = require('better-sqlite3');
```

**Arg parsing / IS_PROBE / IS_DRY_RUN guards** (lines 83-168):
```javascript
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i !== -1 ? process.argv[i + 1] : d;
};

const IS_DRY_RUN   = process.argv.includes('--dry-run');
const IS_PROBE     = process.argv.includes('--probe');
const KEEP_DBS     = process.argv.includes('--keep-dbs');
const IS_INSTRUMENT = process.argv.includes('--instrument');

const CONCURRENCY = Math.max(1, parseInt(arg('--concurrency', '4'), 10) || 4);
const TOP_K = Math.max(1, parseInt(arg('--topk', '10'), 10) || 10);

const PROBE_LIMIT = 10;  // For locomo: set to 1 (one full conversation)
```
LOCOMO difference: `PROBE_LIMIT = 1` (one conversation, all its QA pairs), not 10 individual questions.

**`makeScratchDb()` — copy verbatim** (lines 185-207):
```javascript
function makeScratchDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `brain-eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, realClock, config);
  return {
    db, dbPath, episodes,
    cleanup() {
      try { db.close(); } catch {}
      if (!KEEP_DBS) { try { fs.unlinkSync(dbPath); } catch {} }
    },
  };
}
```

**`buildRetrievalEngine()` — copy verbatim** (lines 215-223):
```javascript
function buildRetrievalEngine(db, dbPath) {
  const config    = { ...DEFAULT_CONFIG, dbPath };
  const retriever = new CandidateRetriever(db);
  const store     = new SemanticStore(db, realClock, config);
  const strength  = new StrengthDecayManager(db, realClock, config);
  const gate      = new AllocationGate(config);
  const traceSink = new NoopActivationTraceSink();
  return new RetrievalEngine(db, realClock, config, retriever, store, strength, gate, traceSink);
}
```

**`runBoundedPool()` — copy verbatim** (lines 289-302):
```javascript
async function runBoundedPool(items, concurrency, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}
```

**`formatSession(session, date)` — copy verbatim** (lines 275-280):
```javascript
function formatSession(session, date) {
  const turns = session
    .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');
  return date ? `[Session date: ${date}]\n${turns}` : turns;
}
```
LOCOMO difference: the LoCoMo session format is `{name, dia_id, text}` turns (not `{role, content}`), so the map function changes to `turn.name + ': ' + turn.text`. Date comes from `session_N_date_time` field. Also prepend `[Session ${sessionIdx}]` tag for R@K tracking.

**`resolveProviderOverlay()` + headless transport pattern** (lines 313-325, 441-456):
```javascript
// Key guard: check if answer is headless before requiring ANTHROPIC_API_KEY
const answerOverlay = resolveProviderOverlay(process.env, 'RECENSE_ANSWER_PROVIDER');
const isAnswerHeadless = answerOverlay.modelProvider === 'claude-headless';
if (!isAnswerHeadless && !process.env.ANTHROPIC_API_KEY) { process.exit(1); }
if (!process.env.OPENAI_API_KEY) { process.exit(1); }

// Client construction
if (answerOverlay.modelProvider === 'claude-headless') {
  const { client } = createClaudeHeadlessClient({ ...DEFAULT_CONFIG, ...answerOverlay });
  anthropicClient = client;
} else {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropicClient = new Anthropic({ maxRetries: harnessMaxRetries });
}
```

**Dataset loader** (lines 231-243 — `parseJsonl`):
```javascript
// LME uses parseJsonl (one object per line):
function parseJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  // ...
}
```
LOCOMO difference: dataset is a single JSON array, NOT JSONL. Replace with:
```javascript
function parseLoCoMo(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));  // array of 10 conversation objects
}
```

**`instrumentTopkResults` tap — how it is populated** (lines 479, 718-724):
```javascript
// Declare at top of processQuestion scope:
let instrumentTopkResults = null;

// After CandidateRetriever.topk() call:
const topkResults = evalRetriever.topk(queryVec, TOP_K);
instrumentTopkResults = topkResults;  // expose for instrumentation
```
LOCOMO extension: after capturing `instrumentTopkResults`, add session-index hit logic:
```javascript
// R@K hit: does any top-K result come from a session in qa.evidence?
const hitSessions = new Set(qa.evidence.map(e => parseInt(e.split(':')[0].replace('D','')) - 1));
// Then query scratch.db consolidation_event -> episode for session_idx stored in content prefix
```

**`runConsolidation()` call — once per conversation, AFTER all session appends** (lines 648-656):
```javascript
await runConsolidation(
  scratch.db,
  scratch.dbPath,
  process.env,
  (msg) => { if (msg.includes('skipped (consolidation error)')) quarantineCount++; }
);
```
LOCOMO critical difference: consolidation is called ONCE per conversation (outer loop), NOT once per QA pair (inner loop). All `~19-35` session episodes are appended first, then a single `runConsolidation()`, then all `~200` QA pairs are evaluated against the consolidated DB.

**IS_PROBE exit pattern** (lines 920-931):
```javascript
if (IS_PROBE) {
  const perQuestion = completedCount > 0 ? totalCost / completedCount : 0;
  console.log(`\nProbe: ${completedCount} questions, $${totalCost.toFixed(4)} total...`);
  console.log('Re-run without --probe to evaluate the full set.');
  process.exit(0);
}
```
LOCOMO difference: probe = 1 conversation (not 10 questions); report conversation-level cost and extrapolate ×10.

**Per-question result appended immediately** (line 892):
```javascript
fs.appendFileSync(OUT_FILE, JSON.stringify(result) + '\n');
```

**Latency measurement point** (lines 688-724 — around `evalRetriever.topk()`):
The harness does NOT currently time the topk call separately. For LOCOMO D-06a, add explicit timing:
```javascript
const retrievalStart = Date.now();
const topkResults = evalRetriever.topk(queryVec, TOP_K);
const retrievalMs = Date.now() - retrievalStart;
// Store in result: result.retrieval_ms = retrievalMs
```

---

### `scripts/eval/locomo-scorer.cjs` (scorer, request-response)

**Analog:** `scripts/eval/longmemeval-scorer.cjs`

**Imports + arg parsing** (lines 30-55):
```javascript
'use strict';
const fs            = require('fs');
const path          = require('path');
const childProcess  = require('child_process');
const OpenAI        = require('openai');

const DIST = path.resolve(__dirname, '../../dist/src');
const { resolveProviderOverlay }     = require(DIST + '/consolidation/run-sleep-pass');
const { createClaudeHeadlessClient } = require(DIST + '/model/claude-headless-client');
const { DEFAULT_CONFIG }             = require(DIST + '/lib/config');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const IS_MOCK = process.argv.includes('--mock');
```

**`getCommit()` and `getEngineVersion()` helpers — copy verbatim** (lines 82-97):
```javascript
function getCommit() {
  try {
    return childProcess.execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return 'unknown'; }
}
function getEngineVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}
```

**`parseJudgeVerdict()` — copy verbatim** (lines 121-148):
```javascript
function parseJudgeVerdict(text) {
  if (!text) return { label: 0, parseOk: false };
  const lower = text.toLowerCase().trim();

  // JSON envelope salvage (fenced-JSON, yes/no, 0/1 edge cases)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj.correct === 'boolean') return { label: obj.correct ? 1 : 0, parseOk: true };
      if (obj.verdict === 'yes' || obj.verdict === 'correct') return { label: 1, parseOk: true };
      if (obj.verdict === 'no'  || obj.verdict === 'incorrect') return { label: 0, parseOk: true };
      // LoCoMo mem0 Appendix A prompt returns {"label":"CORRECT"} — add:
      if (obj.label === 'CORRECT') return { label: 1, parseOk: true };
      if (obj.label === 'WRONG')   return { label: 0, parseOk: true };
    } catch {}
  }
  // Plain text fallback...
  if (lower.includes('correct') && !lower.includes('incorrect')) return { label: 1, parseOk: true };
  if (lower.includes('incorrect') || lower.includes('wrong'))    return { label: 0, parseOk: true };
  return { label: 0, parseOk: false };
}
```
LOCOMO change: the mem0 Appendix A prompt returns `{"label": "CORRECT"}` or `{"label": "WRONG"}`, not `"correct": true/false` or `yes/no`. The `parseJudgeVerdict` from LME handles the JSON envelope but needs the `obj.label` branch added (shown above).

**Judge call shape** (lines 207-219 in longmemeval-scorer.cjs):
```javascript
const response = await client.chat.completions.create({
  model:       'gpt-4o-mini',    // locomo: paper-version judge (not gpt-4o-2024-08-06)
  max_tokens:  10,               // same: verbatim from mem0 paper
  temperature: 0,                // same
  messages: [{ role: 'user', content: prompt }],  // same: no system prompt
});
```
LOCOMO change: judge model is `gpt-4o-mini` (mem0 paper Appendix A), NOT `gpt-4o-2024-08-06` (LME default).

**`buildLoCoMoJudgePrompt()` — NEW function** (replaces the LME multi-template `buildJudgePrompt`):
The LoCoMo scorer uses ONE generic prompt (mem0 Appendix A) — NOT the LME question-type-conditional templates:
```javascript
function buildLoCoMoJudgePrompt(question, goldAnswer, hypothesis) {
  // Verbatim mem0 Appendix A (arXiv 2504.19413) — single generic template:
  return `Your task is to label an answer to a question as "CORRECT" or "WRONG".\n` +
    `You will be given the following data:\n` +
    `(1) a question (posed by one user to another user),\n` +
    `(2) a 'gold' (ground truth) answer,\n` +
    `(3) a generated answer which you will score as CORRECT/WRONG.\n\n` +
    `Be generous with grading — as long as the generated answer touches on the same ` +
    `topic as the gold answer it should be counted as CORRECT.\n\n` +
    `Return a JSON object with a single key "label" whose value is "CORRECT" or "WRONG".\n\n` +
    `Question: ${question}\n` +
    `Gold answer: ${goldAnswer}\n` +
    `Generated answer: ${hypothesis}`;
}
```

**Category filter** (new, no LME analog):
```javascript
// Skip adversarial category (category === 5) from scoring denominator entirely
if (qa.category === 5) continue;
```

**Output envelope** (lines 453-465 in longmemeval-scorer.cjs — reuse shape, extend meta):
```javascript
const meta = {
  eval:                    'locomo-10',
  date:                    new Date().toISOString().slice(0, 10),
  commit:                  getCommit(),          // git rev-parse --short HEAD
  engine_version:          getEngineVersion(),   // package.json version
  questions_total:         perQuestion.length,
  questions_adversarial_excluded: adversarialCount,
  judge_model:             'gpt-4o-mini',        // record exact model string per D-05
  // D-10 config snapshot (extend over base LME meta):
  sut_config: {
    embed_model:              DEFAULT_CONFIG.openaiEmbedModel,
    embed_dimensions:         DEFAULT_CONFIG.embeddingDimensions,
    extract_model:            DEFAULT_CONFIG.claudeHeadlessExtractModel,
    judge_model_internal:     DEFAULT_CONFIG.claudeHeadlessJudgeModel,
    consol_skip_threshold:    DEFAULT_CONFIG.consolSkipThreshold,
    consol_skip_threshold_assistant: DEFAULT_CONFIG.consolSkipThresholdAssistant,
    rank_strength_weight:     DEFAULT_CONFIG.rankStrengthWeight,
    ranked_retrieval_k:       DEFAULT_CONFIG.rankedRetrievalK,
    ranked_retrieval_floor:   DEFAULT_CONFIG.rankedRetrievalFloor,
    candidate_k:              DEFAULT_CONFIG.candidateK,
    entity_anchor_k:          DEFAULT_CONFIG.entityAnchorK,
    typed_anchor_pool_k:      DEFAULT_CONFIG.typedAnchorPoolK,
    injection_token_budget:   DEFAULT_CONFIG.injectionTokenBudget,
    insight_surfacing_enabled: DEFAULT_CONFIG.insightSurfacingEnabled,
    predicate_gloss_threshold: DEFAULT_CONFIG.predicateGlossThreshold,
  },
};
const scores = { headline: overallJ, by_category: byCategory, rAtK: { r5, r10 } };
const envelope = { meta, scores, per_question: perQuestion };
```

**Output file write** (line 469 in longmemeval-scorer.cjs):
```javascript
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(envelope, null, 2));
```

---

### `scripts/eval/latency-curve.cjs` (utility, batch / file-I/O)

**Primary analog:** `scripts/eval/replay-ku-harness.cjs` lines 226-265 (scratch DB factory + CandidateRetriever pattern)

**Secondary analog:** `scripts/eval/longmemeval-harness.cjs` lines 83-90 (IS_PROBE / Date.now() pattern)

**Scratch DB factory for latency curve** (from replay-ku-harness.cjs lines 230-251):
```javascript
function makeScratchDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `latency-curve-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  return {
    db, dbPath, config,
    cleanup() {
      try { db.close(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
    },
  };
}
```

**CandidateRetriever.topk() call + timing** (from replay-ku-harness.cjs lines 257-264 + longmemeval-harness.cjs lines 717-720):
```javascript
// From replay-ku-harness.cjs — how CandidateRetriever is constructed:
const retriever = new CandidateRetriever(scratch.db);

// Timing pattern (add Date.now() wrapping around the topk call):
const t0 = Date.now();
const topkResults = retriever.topk(queryVec, K);
const retrievalMs = Date.now() - t0;
```

**Latency curve output envelope** (modeled on `cost-benefit-probe.json` write-ledger format):
```json
{
  "meta": {
    "eval": "latency-curve",
    "date": "<ISO>",
    "commit": "<git hash>",
    "engine_version": "0.1.0",
    "embed_model": "text-embedding-3-small",
    "k": 10,
    "queries_per_n": 20
  },
  "curve": [
    { "n_nodes": 1000, "p50_ms": 2.1, "p95_ms": 4.3, "samples": 20 },
    { "n_nodes": 2000, "p50_ms": 3.8, "p95_ms": 7.1, "samples": 20 }
  ]
}
```

**p50 / p95 computation** (no existing analog — standard percentile):
```javascript
function percentile(sortedArr, p) {
  const idx = Math.ceil(p / 100 * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}
// Usage:
const latencies = samples.map(...).sort((a, b) => a - b);
const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
```

---

### `scripts/eval/fixtures/locomo-mini.jsonl` (fixture, file-I/O)

**Analog:** `scripts/eval/fixtures/longmemeval-mini.jsonl` (existing committed dry-run fixture)

Pattern: a minimal slice of the real dataset that exercises the full parsing and schema-validation path with zero API calls. For LoCoMo: 1 conversation object (locomo10.json[0]) trimmed to 3-5 QA pairs, stored as a single-element JSON array in a `.jsonl` file (one line, the JSON array). The harness `--dry-run` path should accept either format (single JSON array or JSONL) — or simply use `locomo-mini.json` (not `.jsonl`) to avoid confusion.

---

### Config Snapshot Extension (D-10)

**Analog:** `scripts/eval/longmemeval-scorer.cjs` meta block (lines 453-461) + `src/lib/config.ts` DEFAULT_CONFIG (lines 712-782)

**Source of frozen knobs** — exact field names from `src/lib/config.ts` DEFAULT_CONFIG:

| Config key in DEFAULT_CONFIG | Line | Value |
|------------------------------|------|-------|
| `openaiEmbedModel` | 737 | `'text-embedding-3-small'` |
| `embeddingDimensions` | 738 | `1536` |
| `claudeHeadlessExtractModel` | 735 | `'claude-haiku-4-5'` |
| `claudeHeadlessJudgeModel` | 734 | `'claude-sonnet-4-6'` |
| `consolSkipThreshold` | 741 | `0.2` |
| `consolSkipThresholdAssistant` | 742 | `0.5` |
| `rankStrengthWeight` | 749 | `0` |
| `rankedRetrievalK` | 761 | `10` |
| `rankedRetrievalFloor` | 762 | `0.3` |
| `candidateK` | 739 | `5` |
| `entityAnchorK` | 740 | `5` |
| `typedAnchorPoolK` | 757 | `20` |
| `injectionTokenBudget` | 758 | `500` |
| `insightSurfacingEnabled` | 782 | `false` |
| `predicateGlossThreshold` | 752 | `0.35` |

Read at scorer time via `require(DIST + '/lib/config').DEFAULT_CONFIG` (same import as harness). The commit hash is captured by `childProcess.execSync('git rev-parse --short HEAD', ...)` (longmemeval-scorer.cjs lines 82-87, copy verbatim).

---

## Shared Patterns

### resolveProviderOverlay
**Source:** `scripts/eval/longmemeval-harness.cjs` lines 313-325 and `longmemeval-scorer.cjs` lines 60-66
**Apply to:** `locomo-harness.cjs` and `locomo-scorer.cjs`

The harness checks `RECENSE_ANSWER_PROVIDER` for the answer/rewrite path; the scorer checks `RECENSE_SCORER_PROVIDER`. Both fall back to `RECENSE_MODEL_PROVIDER`. Pattern:
```javascript
const overlay = resolveProviderOverlay(process.env, 'RECENSE_ANSWER_PROVIDER');
const isHeadless = overlay.modelProvider === 'claude-headless';
```

### IS_DRY_RUN + IS_PROBE guard structure
**Source:** `scripts/eval/longmemeval-harness.cjs` lines 88-89, 413-419, 920-931
**Apply to:** `locomo-harness.cjs`

All three modes (dry-run, probe, full) must be structurally identical — the only differences are: which items are sliced from the dataset, whether LLM calls are skipped, and whether the process exits early. The `--dry-run` path must call `scratch.episodes.append()` for schema validation even though it skips consolidation and retrieval.

### Incremental output append
**Source:** `scripts/eval/longmemeval-harness.cjs` line 892
**Apply to:** `locomo-harness.cjs`
```javascript
fs.appendFileSync(OUT_FILE, JSON.stringify(result) + '\n');
```
Each conversation result is appended immediately so a killed run loses at most one in-flight conversation.

### Output envelope shape `{ meta, scores, per_question }`
**Source:** `scripts/eval/longmemeval-scorer.cjs` lines 453-465
**Apply to:** `locomo-scorer.cjs`

The top-level shape is shared; the meta fields differ by eval (locomo adds `sut_config`, `questions_adversarial_excluded`; scores adds `rAtK`).

### Token / cost write-ledger format
**Source:** `scripts/eval/results/cost-benefit-probe.json`
**Apply to:** `locomo-harness.cjs` (probe cost report) and `locomo-scorer.cjs` (GPT-4o-mini API cost)

The write-ledger records `per_model` usage with `n_calls`, `input_tokens`, `output_tokens`, `total_tokens`, and `retail_usd_estimate`. The cost-std files use the same `usage.per_model` shape (see `cost-std-baseline.json` lines 32-50). For LoCoMo, separate the subscription-billed extraction/consolidation (Haiku/Sonnet via `claude -p`) from the direct-API scorer cost (GPT-4o-mini OpenAI $).

### T-14-DB isolation rule
**Source:** `scripts/eval/longmemeval-harness.cjs` line 34 (comment) + `makeScratchDb()` implementation
**Apply to:** all three new scripts

Every question / conversation must use a fresh scratch DB under `os.tmpdir()`. The live `recense.db` env var must never be read. Scratch DBs are unlinked in `cleanup()` unless `--keep-dbs` is set.

---

## No Analog Found

| File | Role | Reason |
|------|------|--------|
| `scripts/eval/fixtures/locomo-mini.jsonl` | fixture | No LoCoMo fixture exists yet; derive from `locomo10.json[0]` with 5 QA pairs — but the fixture *format* pattern is `longmemeval-mini.jsonl` |
| R@K session-index tracking (within harness) | algorithm | No existing harness implements session-index-aware hit logic; this is new code within `locomo-harness.cjs`. Pattern described in RESEARCH Item 3 (Option A). |

---

## Metadata

**Analog search scope:** `scripts/eval/`, `src/lib/config.ts`, `scripts/eval/results/`
**Files scanned:** `longmemeval-harness.cjs` (950 lines, full read), `longmemeval-scorer.cjs` (485 lines, full read), `replay-ku-harness.cjs` (partial: lines 1-265), `cost-benefit-probe.json` (full), `cost-std-baseline.json` (partial), `src/lib/config.ts` (lines 710-790)
**Pattern extraction date:** 2026-06-22

---

## PATTERN MAPPING COMPLETE

**Phase:** 40 - Competitive Benchmark Baseline
**Files classified:** 4 new files + 1 config extension
**Analogs found:** 4 / 4 (all new files have strong analog matches)

### Coverage
- Files with exact analog (clone-and-adapt): 2 (`locomo-harness.cjs`, `locomo-scorer.cjs`)
- Files with role-match analog: 1 (`latency-curve.cjs`)
- Files with fixture analog: 1 (`locomo-mini.jsonl`)
- Files with no analog (new logic within an analoged file): R@K session-index hit tracking

### Key Patterns Identified
- All three harness scripts copy `makeScratchDb()`, `buildRetrievalEngine()`, `runBoundedPool()`, `resolveProviderOverlay()` verbatim from `longmemeval-harness.cjs`
- The LoCoMo harness outer loop is per-conversation (10 iterations), inner loop is per-QA-pair — inverted from LME (500 independent questions). Consolidation fires ONCE per conversation, not per QA pair.
- The LoCoMo scorer uses a SINGLE judge prompt (mem0 Appendix A, `gpt-4o-mini`, `{"label":"CORRECT"|"WRONG"}` JSON) — not the LME multi-template `buildJudgePrompt()`. `parseJudgeVerdict()` copies verbatim but needs the `obj.label` branch added.
- Dataset loader changes from `parseJsonl()` to `JSON.parse()` — `locomo10.json` is a JSON array, not JSONL.
- D-10 config snapshot reads `DEFAULT_CONFIG` from `dist/src/lib/config` (NOT `src/model/config.ts` — that file does not exist). Knob names and current values are verified at `src/lib/config.ts` lines 712-782.
- `src/model/config.ts` cited in CONTEXT.md does not exist — the correct path is `src/lib/config.ts`.

### File Created
`.planning/phases/40-competitive-benchmark-baseline/40-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. Planner can reference analog patterns (with file:line citations) in PLAN.md task action sections.
