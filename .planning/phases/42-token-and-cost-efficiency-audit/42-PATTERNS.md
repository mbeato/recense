# Phase 42: Token / Cost Efficiency Audit - Pattern Map

**Mapped:** 2026-06-24
**Files analyzed:** 3 new harness files + 1 config read pattern
**Analogs found:** 3 / 3

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/eval/42-lever-sweep-harness.cjs` | harness | batch (greedy per-lever sweep) | `scripts/eval/35-strength-sweep.cjs` + `scripts/eval/cost-benefit-harness.cjs` | role-match composite |
| `scripts/eval/42-progressive-disclosure-harness.cjs` | harness | request-response A/B | `scripts/eval/injection-efficiency-harness.cjs` + `scripts/eval/replay-ku-harness.cjs` (insight-mode) | role-match composite |
| `scripts/eval/results/42-lever-sweep-<lever>.json` | result artifact | — | `scripts/eval/results/cost-benefit-probe.json` | exact schema |

> `src/lib/config.ts` and the existing harnesses are **read-only inputs** for Phase 42. No modifications to source files are planned; the sweep harness reads `DEFAULT_CONFIG` and overrides single keys per lever run.

---

## Pattern Assignments

### `scripts/eval/42-lever-sweep-harness.cjs` (harness, batch sweep)

**Primary analog:** `scripts/eval/35-strength-sweep.cjs`
**Secondary analog:** `scripts/eval/cost-benefit-harness.cjs`

---

**File header / module doc comment** — copy the cost-benefit-harness header style, not the sweep driver style. The lever-sweep harness is a first-class measurement harness with per-call usage instrumentation, not a thin orchestrator. Header must state:
- Currency framing (subscription tokens, retail-$ as API-list equivalent)
- No-inflated-metrics guard
- Cost-probe gate reference (Phase-40 D-01)
- `measured: false` fallback guarantee

---

**Imports pattern** (`cost-benefit-harness.cjs` lines 40-59):
```javascript
'use strict';

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { execSync } = require('child_process');

const arg  = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const flag = (k)    => process.argv.includes(k);

const DB_PATH  = arg('--db', process.env['RECENSE_DB'] || path.join(os.homedir(), '.config', 'recense', 'recense.db'));
const OUT_DIR  = arg('--out-dir', 'scripts/eval/results');
const SAMPLE_N = parseInt(arg('--sample', '25'), 10);

const Database           = require('better-sqlite3');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');
```

The `--lever` and `--values` arg convention for the sweep follows the `--sweep-weights` convention in `replay-ku-harness.cjs` line 68: `sweepWeightsArg.split(',').map(...)`.

---

**Config override pattern** — the ONE pattern that must be extracted from `cost-benefit-harness.cjs` line 296 and generalized. This is the core lever-sweep operation:
```javascript
// cost-benefit-harness.cjs line 296 — base pattern:
const config = { ...DEFAULT_CONFIG, dbPath: scratchPath };

// Lever-sweep generalization: override exactly one key per run.
// `leverKey` is a string key of DEFAULT_CONFIG; `leverValue` is the candidate value.
const config = { ...DEFAULT_CONFIG, dbPath: scratchPath, [leverKey]: leverValue };
```

The in-bounds lever keys and their DEFAULT_CONFIG line numbers from `src/lib/config.ts` lines 739–775:
```
consolSkipThreshold          line 741   default 0.2
consolSkipThresholdAssistant line 742   default 0.5
consolSkipThresholdBySource  line 694   default { gmail:0.4, granola:0.25, ... }  (per-source map)
injectionTokenBudget         line 758   default 500
recallNeighborhoodBudget     line 767   default 20
candidateK                   line 739   default 5
recallSidewaysHopBudget      line 775   default 3
```
`RECENSE_CORPUS_GEN=0` is an env-var feature-drop lever, not a config key — checked via `process.env['RECENSE_CORPUS_GEN']`, not `DEFAULT_CONFIG`.

---

**VACUUM INTO scratch pattern** (`cost-benefit-harness.cjs` lines 243-253):
```javascript
// Build scratch path (NEVER write to live db)
const scratchPath = SCRATCH_ARG || path.join(os.tmpdir(), `recense-eval42-scratch-${Date.now()}.db`);
// VACUUM INTO: WAL-safe clean copy; checkpoints un-written WAL pages.
try {
  liveDb.prepare('VACUUM INTO ?').run(scratchPath);
} catch (e) {
  liveDb.close();
  console.log(`\nno data: failed to VACUUM INTO scratch db at ${scratchPath}: ${e.message}`);
  process.exit(0);
}
liveDb.close();
```

---

**Skip-threshold split** (`cost-benefit-harness.cjs` lines 295-309):
```javascript
const config = { ...DEFAULT_CONFIG, dbPath: scratchPath };
let n_below_threshold = 0;
let n_extracted = 0;
for (const ep of sampledRows) {
  const threshold = effectiveThreshold(ep, config);
  if (!ep.hard_keep && ep.salience < threshold) {
    n_below_threshold++;
  } else {
    n_extracted++;
  }
}
```
The `effectiveThreshold` helper (lines 115-123) must be copied verbatim — it mirrors `consolidator.ts` gate logic.

---

**Usage sink installation + per-model accumulation** (`cost-benefit-harness.cjs` lines 379-411):
```javascript
const { setHeadlessUsageSink } = require('../../dist/src/model/claude-headless-client');
const { runConsolidation }     = require('../../dist/src/consolidation/run-sleep-pass');

const perModelCalls = {}; // { model: [{ usage, total_cost_usd, duration_ms }] }
setHeadlessUsageSink(u => {
  if (!perModelCalls[u.model]) perModelCalls[u.model] = [];
  perModelCalls[u.model].push({ usage: u.usage, total_cost_usd: u.total_cost_usd, duration_ms: u.duration_ms });
});

// ... run pass ...

setHeadlessUsageSink(null); // always clear in finally
```

---

**Headless-not-active fallback** (`cost-benefit-harness.cjs` lines 351-363):
```javascript
const judgeProvider     = process.env['RECENSE_JUDGE_PROVIDER']     || '';
const extractorProvider = process.env['RECENSE_EXTRACTOR_PROVIDER'] || '';
const headlessActive    = judgeProvider === 'claude-headless' && extractorProvider === 'claude-headless';

if (!headlessActive) {
  writeLedger = {
    measured: false,
    reason: `Headless providers not configured (...)`,
    stack_used: `judge=${judgeProvider || 'unset'}, extractor=${extractorProvider || 'unset'}`,
  };
}
```
The sweep harness MUST preserve this fallback — marking `measured: false` rather than fabricating numbers.

---

**Per-lever result JSON envelope** — extends `cost-benefit-probe.json` with lever fields. The result shape must be:
```javascript
// Extend cost-benefit-probe.json meta shape (cost-benefit-probe.json lines 2-8):
const meta = {
  eval:           'lever-sweep',
  date:           new Date().toISOString(),
  commit,
  engine_version,
  db_path:        DB_PATH,
  scratch_path:   scratchPath,
  // Phase-42 extensions:
  lever_under_test: leverKey,     // e.g. 'consolSkipThreshold'
  lever_value:      leverValue,   // e.g. 0.35
  baseline_value:   DEFAULT_CONFIG[leverKey], // e.g. 0.2
  phase_40_baseline_commit: '<frozen v7.0 commit from D-10>',
};
```

The `write_ledger.per_model` block copies from `cost-benefit-probe.json` lines 32-57:
```json
"per_model": {
  "claude-haiku-4-5": {
    "n_calls": ..., "input_tokens": ..., "output_tokens": ...,
    "cache_creation_input_tokens": ..., "cache_read_input_tokens": ...,
    "total_tokens": ..., "retail_usd_estimate": ..., "avg_duration_ms": ...
  },
  "claude-sonnet-4-6": { ... }
}
```

---

**Sweep orchestration pattern** (`35-strength-sweep.cjs` lines 152-176) — the lever-sweep harness is itself the sweep loop, not a caller of another sweep driver. Use the internal loop pattern from `replay-ku-harness.cjs` lines 554-705 (`runSweep` function) rather than the outer spawnSync pattern. The lever-sweep runs the write-side measurement (runConsolidation + usageSink) per lever value in-process, not by spawning child processes.

The spawnSync child-dispatch pattern from `35-strength-sweep.cjs` lines 166-175 applies only for invoking the **KU inner-loop gate** per lever candidate (since KU replay is a separate harness with its own scratch DB lifecycle). The write-side measurement stays in-process.

---

**KU inner-loop gate dispatch** (D-06: run KU gate now; defer write-side to reset window) — adapted from `35-strength-sweep.cjs` lines 152-176:
```javascript
// Dispatch replay-ku-harness.cjs with the lever value injected as an env var
// (or via a temp config override file that the harness reads).
// The harness must NOT re-extract from granite (uses replayExtract seam).
const kuOut = path.join(OUT_DIR, `42-ku-gate-${leverKey}-${leverValue}.json`);
const args = [
  path.resolve(__dirname, 'replay-ku-harness.cjs'),
  '--out', kuOut,
  // future: '--config-override-key', leverKey, '--config-override-value', String(leverValue)
];
const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env:   { ...process.env, RECENSE_MODEL_PROVIDER: 'claude-headless' },
  cwd:   path.resolve(__dirname, '../..'),
});
```

---

**Comparison table and argmax pattern** (`35-strength-sweep.cjs` lines 120-133):
```javascript
function extractHeadline(result, metric) {
  if (!result) return null;
  return result?.scores?.[metric] ?? null;
}
// Print one row per lever value with: lever_value | skip_rate | write_tokens_per_turn | ku_score
```

---

**Result file naming convention** (`replay-ku-harness.cjs` line 700-703, `35-strength-sweep.cjs` lines 104-106):
```javascript
// Pattern: scripts/eval/results/42-sweep-<leverKey>-<leverValue>.json
const outFile = path.join(OUT_DIR, `42-sweep-${leverKey}-${String(leverValue).replace('.', '_')}.json`);
```

---

**Result writing** (`cost-benefit-harness.cjs` lines 590-592):
```javascript
const outDir = path.dirname(OUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));
```

---

### `scripts/eval/42-progressive-disclosure-harness.cjs` (harness, A/B measurement)

**Primary analog:** `scripts/eval/injection-efficiency-harness.cjs` (LLM-free, $0 structure + session-start spawn)
**Secondary analog:** `scripts/eval/replay-ku-harness.cjs` insight-mode (the OFF/ON A/B structure with aggregate reduction %)

---

**File header** — copy from `injection-efficiency-harness.cjs` lines 1-24. Key invariants to state:
- `$0, LLM-free` — oracle and fixed-top-K expansion policies are simulated from the live DB, not via new LLM calls
- `No LLM/embedding/judge module is imported or invoked`
- Two policies bracketed: oracle (best case) and fixed top-K (realistic)
- A documented decline-with-numbers is a valid, expected outcome (D-10)

---

**Arg parser + DB open** (`injection-efficiency-harness.cjs` lines 33-97):
```javascript
'use strict';

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { execSync, spawnSync } = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DB_PATH   = arg('--db',  process.env['RECENSE_DB'] || path.join(os.homedir(), '.config', 'recense', 'recense.db'));
const OUT       = arg('--out', 'scripts/eval/results/42-progressive-disclosure-PENDING.json');
const TOP_K     = parseInt(arg('--top-k', '5'), 10);   // fixed-top-K policy parameter

const Database        = require('better-sqlite3');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');

// DB open: readonly, graceful degrade
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch {
  console.log(`\nno data: recense.db missing or unopenable at ${DB_PATH} — nothing to measure`);
  process.exit(0);
}
```

---

**Token counting proxy** (`injection-efficiency-harness.cjs` line 48; `replay-ku-harness.cjs` line 105):
```javascript
/** Char-based token proxy — same formula the session-start-cli char cap uses. */
function charsToTokens(chars) {
  return Math.round(chars / 4);
}
```
This convention MUST be used consistently. Do not substitute a real tokenizer.

---

**Session-start spawn (incumbent arm)** (`injection-efficiency-harness.cjs` lines 120-150):
```javascript
// Incumbent arm: recense's current one-shot bounded inject ("schema-prior compression")
const cliPath      = path.join(process.cwd(), 'dist', 'src', 'adapter', 'session-start-cli.js');
const stdinPayload = JSON.stringify({ hookEventName: 'SessionStart', cwd: CWD_ARG });

const spawnResult = spawnSync(
  process.execPath,
  [cliPath, '--db', DB_PATH],
  { input: stdinPayload, encoding: 'utf8', timeout: 15_000 }
);

if (spawnResult.error || spawnResult.status !== 0) {
  const err = spawnResult.error ? spawnResult.error.message : (spawnResult.stderr || '(non-zero exit)');
  console.error(`\nERROR: session-start-cli spawn failed: ${err}`);
  db.close();
  process.exit(1);
}

let injectedText = '';
try {
  const cliOut = JSON.parse(spawnResult.stdout);
  injectedText = cliOut?.hookSpecificOutput?.additionalContext ?? '';
} catch {
  console.error(`\nERROR: failed to parse session-start-cli stdout as JSON`);
  db.close();
  process.exit(1);
}

const incumbent_tokens = charsToTokens(injectedText.length);
```

---

**Challenger arm simulation (two-step progressive disclosure)** — no existing analog; described by D-07/D-09. The simulation queries the live DB directly (no MCP call, no engine spawn):

```javascript
// Step 1: thin index — id + one-line gloss only (challenger step-1 payload)
// Gloss = first sentence of node.value, capped at ~60 chars = ~15 tokens.
// `TOP_K` nodes selected by cosine rank (reuse the query embedded by session-start-cli
// or fall back to a sample of top-recency live nodes for the LLM-free simulation).
const nodeRows = db.prepare(
  'SELECT id, value FROM node WHERE tombstoned=0 ORDER BY last_access DESC LIMIT ?'
).all(TOP_K * 4); // oversample; score + rank below

// Gloss function (chars/4 proxy):
function gloss(value) {
  const first = value.split(/[.!?]/)[0].trim();
  return first.length > 60 ? first.slice(0, 60) + '…' : first;
}

// Build thin-index payload (step 1):
const thinIndexLines = nodeRows.slice(0, TOP_K).map(r => `[${r.id}] ${gloss(r.value)}`);
const thin_tokens = charsToTokens(thinIndexLines.join('\n').length);

// Step 2 expansion: oracle vs fixed-top-K policies
// Oracle policy: expand only the nodes the gold answer needs (best case)
// Fixed-top-K policy: expand all TOP_K hits (realistic case)
// For the harness-only A/B the detail payload = full node value + 1-hop count proxy
function detailPayload(nodeRow) {
  // Full value + provenance stub (simulate: "value + [N hop neighbors]")
  return nodeRow.value; // 1-hop neighborhood size comes from DB query in real harness
}
```

---

**A/B split structure + aggregate reporting** (`replay-ku-harness.cjs` insight-mode, lines 867-1014):
```javascript
// OFF = incumbent (one-shot inject), ON = challenger (progressive disclosure)
// Mirror the OFF/ON structure from insight-mode in replay-ku-harness.cjs:
const results = {
  incumbent: { tokens: incumbent_tokens, policy: 'one-shot-bounded-inject' },
  challenger_oracle:  { tokens: oracle_tokens,  policy: 'oracle-expansion' },
  challenger_top_k:   { tokens: topk_tokens,    policy: `fixed-top-${TOP_K}-expansion` },
};

// Reduction % (positive = fewer tokens = challenger wins):
// Mirror from replay-ku-harness.cjs lines 993-996:
const oracle_reduction_pct = incumbent_tokens > 0
  ? +(((incumbent_tokens - oracle_tokens) / incumbent_tokens) * 100).toFixed(2)
  : null;
const topk_reduction_pct = incumbent_tokens > 0
  ? +(((incumbent_tokens - topk_tokens) / incumbent_tokens) * 100).toFixed(2)
  : null;

// D-10: document decline-with-numbers as valid outcome
const verdict = oracle_reduction_pct !== null && oracle_reduction_pct > 0
  ? 'challenger-wins-oracle'
  : (topk_reduction_pct !== null && topk_reduction_pct > 0
    ? 'challenger-wins-top-k'
    : 'incumbent-wins-decline-documented');
```

---

**Result envelope** (`injection-efficiency-harness.cjs` lines 244-280):
```javascript
const resultEnvelope = {
  meta: {
    eval:           'progressive-disclosure',
    date:           new Date().toISOString(),
    commit,
    engine_version,
    db_path:        DB_PATH,
    top_k:          TOP_K,
    // D-07: mechanism = fact-index → fact-detail (challenger) vs one-shot bounded inject (incumbent)
    mechanism:      'fact-index-to-fact-detail',
    // D-08: MCP pull surface only; SessionStart push is the incumbent
    surface:        'mcp-pull-challenger-vs-session-start-push-incumbent',
    // D-09: harness-only A/B, no engine change
    prototype_depth:'harness-only-ab',
  },
  // Incumbent = recense's schema-prior compression (one-shot bounded inject)
  incumbent: {
    policy:         'one-shot-bounded-inject',
    tokens:         incumbent_tokens,
    source:         'session-start-cli',
  },
  // Challenger = progressive disclosure simulation (oracle + fixed-top-K brackets)
  challenger: {
    oracle: {
      policy:           'oracle-expansion',
      thin_index_tokens: thin_tokens,
      expansion_tokens:  oracle_expansion_tokens,
      total_tokens:     oracle_tokens,
      reduction_pct:    oracle_reduction_pct,
    },
    top_k: {
      policy:           `fixed-top-${TOP_K}-expansion`,
      thin_index_tokens: thin_tokens,
      expansion_tokens:  topk_expansion_tokens,
      total_tokens:     topk_tokens,
      reduction_pct:    topk_reduction_pct,
    },
  },
  verdict,
  // D-10: decline-with-numbers is a valid outcome
  caveats: [
    'Token counts use chars/4 proxy (EVAL-03 convention) — not a real tokenizer.',
    'Incumbent arm measured from real session-start-cli spawn.',
    'Challenger arms are simulated from live DB node rows — no real MCP calls made.',
    'Oracle policy is progressive disclosure best case; real agent behavior approximated by fixed-top-K.',
    `A documented decline (verdict=incumbent-wins-decline-documented) is a valid, expected outcome (D-10).`,
    'Subscription marginal cost ≈ $0 (LLM-free harness).',
  ],
};
```

---

### `scripts/eval/results/42-lever-sweep-<lever>.json` (result artifact)

**Exact analog:** `scripts/eval/results/cost-benefit-probe.json`

The result schema extends `cost-benefit-probe.json` with three Phase-42 fields added at the top of `meta` and a `lever` block added at root level:

```json
{
  "meta": {
    "eval": "lever-sweep",
    "date": "...",
    "commit": "...",
    "engine_version": "...",
    "db_path": "...",
    "scratch_path": "...",
    "lever_under_test": "consolSkipThreshold",
    "lever_value": 0.35,
    "baseline_value": 0.2,
    "phase_40_baseline_commit": "<frozen v7.0 commit>"
  },
  "lever": {
    "key": "consolSkipThreshold",
    "candidate_value": 0.35,
    "baseline_value": 0.2,
    "delta_pct": null
  },
  "sample": { ... },
  "skip_split": {
    "n_below_threshold": ...,
    "n_extracted": ...,
    "thresholds": {
      "global": 0.35,
      "assistant": 0.5,
      "per_source": { ... }
    }
  },
  "write_ledger": {
    "measured": true,
    "stack_used": "judge=claude-headless, extractor=claude-headless",
    "n_calls_total": ...,
    "n_episodes_processed": ...,
    "per_model": {
      "claude-haiku-4-5": {
        "n_calls": ..., "input_tokens": ..., "output_tokens": ...,
        "cache_creation_input_tokens": ..., "cache_read_input_tokens": ...,
        "total_tokens": ..., "retail_usd_estimate": ..., "avg_duration_ms": ...
      },
      "claude-sonnet-4-6": { ... }
    },
    "totals": {
      "input_tokens": ..., "output_tokens": ...,
      "cache_creation_input_tokens": ..., "cache_read_input_tokens": ...,
      "all_tokens": ..., "per_turn_tokens_processed": ...
    },
    "retail_usd": ...,
    "subscription_marginal_usd": 0,
    "prices_dated": "2026-06-19"
  },
  "ku_gate": {
    "ku_score": ...,
    "ku_scored_cases": ...,
    "regression": false,
    "tolerance_band_pts": 1,
    "source": "scripts/eval/results/42-ku-gate-consolSkipThreshold-0.35.json"
  },
  "caveats": [ ... ]
}
```

---

## Shared Patterns

### Arg parser convention
**Source:** `injection-efficiency-harness.cjs` line 33 / `cost-benefit-harness.cjs` line 47 (identical)
**Apply to:** all three new harness files
```javascript
const arg  = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const flag = (k)    => process.argv.includes(k);
```

### Header (section separator)
**Source:** `injection-efficiency-harness.cjs` line 64 / `cost-benefit-harness.cjs` line 85-89 (identical)
**Apply to:** all three new harness files
```javascript
function header(title) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + title);
  console.log('─'.repeat(60));
}
```

### Meta block (commit + engine_version)
**Source:** `cost-benefit-harness.cjs` lines 203-207 / `injection-efficiency-harness.cjs` lines 74-81
**Apply to:** all three new harness files
```javascript
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe','pipe','ignore'] }).toString().trim(); } catch {}
let engine_version = 'unknown';
try { engine_version = require('../../package.json').version; } catch {}
const date = new Date().toISOString();
```

### No-data graceful exit
**Source:** `injection-efficiency-harness.cjs` lines 89-113 / `cost-benefit-harness.cjs` lines 217-239
**Apply to:** all three new harness files (any harness that opens recense.db)
```javascript
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch {
  console.log(`\nno data: recense.db missing or unopenable at ${DB_PATH} — nothing to measure`);
  process.exit(0);
}
let n_live_nodes;
try {
  n_live_nodes = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned=0').get().n;
} catch {
  db.close();
  console.log(`\nno data: recense.db has no node table — run a writer CLI first`);
  process.exit(0);
}
if (n_live_nodes === 0) {
  db.close();
  console.log(`\nno data: recense.db has 0 live nodes — nothing to measure`);
  process.exit(0);
}
```

### Token proxy (chars/4)
**Source:** `injection-efficiency-harness.cjs` line 48 / `replay-ku-harness.cjs` line 105
**Apply to:** `42-progressive-disclosure-harness.cjs` + any token sizing in lever-sweep that estimates injection cost
```javascript
function charsToTokens(chars) { return Math.round(chars / 4); }
```

### Subscription vs retail-$ split
**Source:** `cost-benefit-harness.cjs` lines 62-81 + 479
**Apply to:** `42-lever-sweep-harness.cjs` — must copy PRICES table and `retailUsd()` helper verbatim. The framing language must also be copied:
```
Subscription marginal cost ≈ $0; retail-$ figures are API-list estimates only (not actual charges).
```

### `measured: false` guard
**Source:** `cost-benefit-harness.cjs` lines 355-363
**Apply to:** `42-lever-sweep-harness.cjs` write ledger — when headless providers are not configured, the ledger must be `{ measured: false, reason: '...' }`, never a fabricated number.

### Result file write pattern
**Source:** `cost-benefit-harness.cjs` lines 590-592
**Apply to:** all three new harness files
```javascript
const outDir = path.dirname(OUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));
```

### FATAL error exit
**Source:** `cost-benefit-harness.cjs` lines 597-600
**Apply to:** all three new harness files
```javascript
})().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
```

### Keys never written to results (T-26-03)
**Source:** `replay-ku-harness.cjs` line 689 (`// T-26-03: keys never written to results`)
**Apply to:** all three new harness files — no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any API credential must appear in the result JSON or console output.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Thin-index simulation logic inside `42-progressive-disclosure-harness.cjs` | utility | transform | No existing harness simulates a two-step fact-index → fact-detail MCP flow. The `gloss()` function + expansion payload builder are genuinely new. Use D-07 spec (id + one-line gloss for step 1; full value + 1-hop neighborhood for step 2) and bracket with oracle + fixed-top-K as described in D-09. |

---

## Config Levers Reference (read-only)

The lever-sweep harness reads these keys from `src/lib/config.ts` `DEFAULT_CONFIG` (lines 739-775 of the compiled `dist/src/lib/config`). No config.ts modifications are needed.

| Lever key | DEFAULT_CONFIG line | Default value | Type |
|-----------|--------------------:|---------------|------|
| `consolSkipThreshold` | 741 | `0.2` | number |
| `consolSkipThresholdAssistant` | 742 | `0.5` | number |
| `consolSkipThresholdBySource` | 694 | `{ gmail:0.4, granola:0.25, obsidian:0.2, conversation:0.2, gcal:0.3 }` | Record |
| `injectionTokenBudget` | 758 | `500` | number |
| `recallNeighborhoodBudget` | 767 | `20` | number |
| `candidateK` | 739 | `5` | number |
| `recallSidewaysHopBudget` | 775 | `3` | number |

`RECENSE_CORPUS_GEN=0` (env-var feature-drop) is not in `DEFAULT_CONFIG` — gate it with `process.env['RECENSE_CORPUS_GEN'] === '0'` and report it as a lever with its own token delta in the sweep output.

---

## Metadata

**Analog search scope:** `scripts/eval/*.cjs`, `scripts/eval/results/*.json`, `src/lib/config.ts`
**Files scanned:** 6 harness files, 3 result JSONs, 1 config file
**Pattern extraction date:** 2026-06-24
