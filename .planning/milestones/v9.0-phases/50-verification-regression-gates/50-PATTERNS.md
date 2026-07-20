# Phase 50: Verification + Regression Gates - Pattern Map

**Mapped:** 2026-06-29
**Files analyzed:** 6 (3 new scripts, 1 new JSON, 1 package.json edit, 1 docs edit)
**Analogs found:** 5 / 6 (docs/evals.md has no code analog — content-only update)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `scripts/eval/gate-runner.cjs` | utility/gate | request-response | `scripts/eval/correctness-harness.cjs` | role-match (same CLI shape, exit-code contract) |
| `scripts/eval/gate-accuracy-runner.cjs` | utility/gate | request-response | `scripts/eval/correctness-harness.cjs` | exact (same API-key guard, same cost pattern) |
| `scripts/eval/results/gate-baseline.json` | config/fixture | static | `scripts/eval/results/46-recon03-ku-bm25on.json` + `locomo-d41d5c8.json` + `41-latency-after.json` | schema-composition |
| `package.json` (`gate`, `gate:accuracy`, `gate:baseline` scripts) | config | N/A | `package.json` lines 45–52 (`eval:*` block) | exact |
| `docs/evals.md` | docs | N/A | existing file (content update, no code pattern) | N/A |

---

## Pattern Assignments

### `scripts/eval/gate-runner.cjs` (utility/gate, request-response)

**Primary analog:** `scripts/eval/correctness-harness.cjs`
**Secondary analog:** `scripts/eval/locomo-harness.cjs` (mode-guard pattern, `--retrieval-only`)

**Imports pattern** (`correctness-harness.cjs` lines 29–61):
```javascript
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ---- arg parser (mirrors judge-eval-runner.cjs convention) ------------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DRY_RUN    = process.argv.includes('--dry-run');
const CASES_PATH = arg('--cases', 'scripts/eval/cases/correctness-cases.json');
const OUT        = arg('--out',   'scripts/eval/results/correctness-PENDING.json');
```

**Mode-guard pattern** (`locomo-harness.cjs` lines 84–98):
```javascript
// Gate: refuse to run unless an explicit mode flag is given (T-40-03)
if (!IS_DRY_RUN && !IS_PROBE && !IS_RUN) {
  console.error('Usage: locomo-harness.cjs [--dry-run | --probe | --run] [options]');
  // ... usage text ...
  process.exit(1);
}
```
Apply same pattern to gate-runner: refuse to run without `--run` or `--update-baseline` — prevents accidental invocation with undefined behavior.

**`--retrieval-only` flag** (`locomo-harness.cjs` line 77):
```javascript
const RETRIEVAL_ONLY = process.argv.includes('--retrieval-only');
```
The gate uses `locomo-harness.cjs --retrieval-only` to get LLM-free R@K without answer generation.

**Non-zero exit on failure** (pattern to copy — correctness-harness.cjs does NOT currently assert floors, so construct this fresh from the API-key guard at lines 77–86):
```javascript
if (!DRY_RUN) {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    console.error(`\nERROR: ${missing.join(', ')}`);
    process.exit(1);   // <-- non-zero exit shape to copy
  }
}
```
Copy this `process.exit(1)` shape for floor/ceiling breaches:
```javascript
if (scores.locomo_r5 < baseline.thresholds.locomo_r5_floor) {
  console.error(`GATE FAIL: locomo_r5 ${scores.locomo_r5} < floor ${baseline.thresholds.locomo_r5_floor}`);
  failures.push('locomo_r5');
}
// ... after all checks ...
if (failures.length > 0) process.exit(1);
```

**Results envelope / meta shape** (`correctness-harness.cjs` lines 353–402):
```javascript
const meta = {
  eval: 'correctness',
  date: new Date().toISOString(),
  commit,                              // git rev-parse --short HEAD
  engine_version: require('../../package.json').version,
  cases_total: total,
  dry_run: DRY_RUN,
};
// ...
const resultEnvelope = { meta, scores: { ... }, per_case: [...] };
fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));
console.log(`\nResults written -> ${OUT}`);
```

**Commit resolution** (`correctness-harness.cjs` lines 305–307):
```javascript
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}
```

**`--update-baseline` shape** (construct from the `--out` arg pattern):
```javascript
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const BASELINE_PATH   = arg('--baseline', 'scripts/eval/results/gate-baseline.json');
// ... after running all checks ...
if (UPDATE_BASELINE) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2));
  console.log(`Baseline updated -> ${BASELINE_PATH}`);
  process.exit(0);
}
```

---

### `scripts/eval/gate-accuracy-runner.cjs` (utility/gate, request-response)

**Analog:** `scripts/eval/correctness-harness.cjs` (exact shape)

**API key guard** (`correctness-harness.cjs` lines 77–86):
```javascript
if (!DRY_RUN) {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    console.error(`\nERROR: missing API keys for a real run: ${missing.join(', ')}`);
    console.error('Pass --dry-run to run the ADD-only baseline with zero API calls.');
    process.exit(1);
  }
}
```
Accuracy runner ALWAYS requires keys (no dry-run mode that skips LLM). Print clear spend estimate before proceeding (copy the `--probe` cost-estimation pattern from `locomo-harness.cjs` lines 103–104).

**Cost-probe gate** (`locomo-harness.cjs` line 75, docs/evals.md §"Cost-probe gate"):
```javascript
const IS_PROBE = process.argv.includes('--probe');
// ... if IS_PROBE: run ONE case, print cost estimate, exit 0 ...
```

---

### `scripts/eval/results/gate-baseline.json` (config/fixture)

**Schema composed from three existing result shapes:**

From `46-recon03-ku-bm25on.json` (lines 1–21) — meta + judge-fire counter:
```json
{
  "meta": {
    "eval": "replay-ku",
    "date": "2026-06-28T12:23:36.290Z",
    "commit": "f4de897",
    "embedder": "text-embedding-3-small",
    "total_cases": 18,
    "total_claims": 35443
  },
  "scores": {
    "total_tombstones": 368,
    "total_contradicts": 368
  }
}
```

From `locomo-d41d5c8.json` (lines 28–39) — R@K shape:
```json
{
  "scores": {
    "rAtK": {
      "r5": 0.7727272727272727,
      "r10": 0.8220779220779221
    }
  }
}
```

From `41-latency-after.json` (lines 1–46) — latency p50/p95 shape:
```json
{
  "meta": {
    "eval": "41-latency-after",
    "date": "2026-06-24T02:57:45.688Z",
    "commit": "0fec565",
    "db_path": "/Users/vtx/.config/recense/recense.db",
    "embedded_live_nodes": 10192
  },
  "warm": {
    "indexed": { "p50_ms": 13, "p95_ms": 14, "samples": 100 }
  }
}
```

**Baseline JSON target schema** (compose all three, plus explicit thresholds):
```json
{
  "meta": {
    "eval": "gate-baseline",
    "version": "v9.0-final",
    "date": "<ISO date of recording>",
    "commit": "<git short sha>",
    "engine_version": "0.1.0",
    "recorded_from": {
      "locomo_rAtK": "scripts/eval/results/locomo-d41d5c8.json",
      "latency":     "scripts/eval/results/41-latency-after.json",
      "contradicts": "scripts/eval/results/46-recon03-ku-bm25on.json"
    }
  },
  "scores": {
    "locomo_r5":        0.773,
    "locomo_r10":       0.822,
    "lat_p50_ms":       13,
    "lat_p95_ms":       14,
    "total_contradicts": 368
  },
  "thresholds": {
    "locomo_r5_floor":     0.75,
    "locomo_r10_floor":    0.80,
    "lat_p95_ceiling_ms":  20,
    "contradicts_floor":   1
  }
}
```
`recorded_from` gives provenance (honest per no-inflated-metrics rule). `thresholds` are separate from `scores` so the planner can tune them without touching the measured numbers.

---

### `package.json` (`gate`, `gate:accuracy`, `gate:baseline` scripts)

**Analog:** `package.json` lines 45–52 — the existing `eval:*` script block:
```json
"eval:judge":           "node scripts/eval/judge-eval-runner.cjs --eval scripts/eval/judge-eval-set.json",
"eval:correctness":     "npm run build && node scripts/eval/correctness-harness.cjs",
"eval:correctness:dry": "npm run build && node scripts/eval/correctness-harness.cjs --dry-run",
"eval:longmemeval":     "npm run build && node scripts/eval/longmemeval-harness.cjs",
"eval:longmemeval:probe": "npm run build && node scripts/eval/longmemeval-harness.cjs --probe",
"eval:longmemeval:dry": "npm run build && node scripts/eval/longmemeval-harness.cjs --dry-run",
"eval:injection":       "npm run build && node scripts/eval/injection-efficiency-harness.cjs",
"eval:cost-benefit":    "npm run build && node scripts/eval/cost-benefit-harness.cjs"
```

**New scripts to add** (follow the `npm run build &&` prefix convention for any script that requires compiled dist):
```json
"gate":            "npm run build && node scripts/eval/gate-runner.cjs --run",
"gate:accuracy":   "npm run build && node scripts/eval/gate-accuracy-runner.cjs --run",
"gate:baseline":   "npm run build && node scripts/eval/gate-runner.cjs --run --update-baseline"
```
Note: `eval:judge` is the one case without `npm run build &&` (reads only JSON, no dist import). The gate runner DOES import dist modules so `npm run build &&` is required.

---

### `docs/evals.md` (docs update)

No code pattern analog. Content update only: record v9.0-final numbers with honest provenance. Per CONTEXT.md canonical refs, read the full file before editing to match existing section structure (EVAL-01 through EVAL-04 methodology sections + results table format).

---

## Shared Patterns

### CLI arg parser
**Source:** `scripts/eval/correctness-harness.cjs` lines 35–36, `scripts/eval/locomo-harness.cjs` lines 68–71
**Apply to:** `gate-runner.cjs`, `gate-accuracy-runner.cjs`
```javascript
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
```

### Commit hash resolution
**Source:** `scripts/eval/correctness-harness.cjs` lines 305–307
**Apply to:** `gate-runner.cjs` (for `--update-baseline` meta)
```javascript
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}
```

### Non-zero exit / API key guard
**Source:** `scripts/eval/correctness-harness.cjs` lines 77–86
**Apply to:** both gate runners (accuracy runner always; cheap gate for floor/ceiling breaches)

### Percentile utility
**Source:** `scripts/eval/41-latency-after.cjs` lines 76–80
**Apply to:** `gate-runner.cjs` if latency percentiles are computed inline (vs. reading from a harness result JSON)
```javascript
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
```

### Results envelope write
**Source:** `scripts/eval/correctness-harness.cjs` lines 400–403
**Apply to:** both gate runners, `--update-baseline` path
```javascript
const outDir = path.dirname(OUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));
console.log(`\nResults written -> ${OUT}`);
```

---

## Judge-Fire Counter: Load-Bearing Open Item Answer (D-07)

**Question from CONTEXT.md:** Confirm the contradiction/escalation counter can be asserted LLM-free on a frozen set, so the binary `> 0` assertion can live in the cheap `npm run gate`.

**Answer (concrete):**

The `total_contradicts` counter in `scripts/eval/results/46-recon03-ku-bm25on.json` (`scores.total_contradicts = 368`) was computed by `queryJudgeEngagement()` in `scripts/eval/replay-ku-harness.cjs` lines 313–329:

```javascript
function queryJudgeEngagement(db) {
  // tombstones: nodes with tombstoned=1
  const tombstones = db.prepare('SELECT COUNT(*) AS n FROM node WHERE tombstoned = 1').get().n;

  // contradict events: any contradict_* row in consolidation_event
  const rows = db.prepare(
    "SELECT event_type, COUNT(*) AS n FROM consolidation_event GROUP BY event_type"
  ).all();

  let contradicts = 0;
  for (const r of rows) {
    if (r.event_type.startsWith('contradict_')) contradicts += r.n;
  }
  return { tombstones, contradicts, duplicateMints };
}
```

The `consolidation_event` table is populated by `SQLiteConsolidationSink.emit()` (`src/consolidation/sink.ts` lines 112–126) — written synchronously during consolidation (requires LLM judge at write time). Event types `contradict_hold`, `contradict_reconcile`, `contradict_oscillation`, `contradict_append_new`, `contradict_force_destabilize` are the contradiction-result events (defined in `src/consolidation/sink.ts` lines 53–65).

The `judgeFiredContradiction` counter in `src/consolidation/consolidator.ts` lines 948–952 is an in-memory accumulator logged to stdout only — it does NOT persist independently of the consolidation_event table.

**Gate assertion strategy (fully LLM-free):**

The gate READS the frozen `46-recon03-ku-bm25on.json` and asserts `scores.total_contradicts > 0`. No fresh consolidation call, no Sonnet judge, no LLM required. This is the correct approach per D-12 ("reuse recorded runs — NO fresh run").

If a future gate revision needs to re-assert on a fresh DB (e.g., after Phase 51 changes the pipeline), the `queryJudgeEngagement()` SQLite query itself is LLM-free — but it must run AFTER a prior consolidation pass has populated `consolidation_event`. The gate would need to orchestrate a minimal consolidation first (LLM-required), which should live in `gate:accuracy`, not the cheap `gate`. **The binary `> 0` assertion therefore stays in the cheap gate via the frozen JSON path.**

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `docs/evals.md` (edit) | docs | N/A | Content update; no code pattern applies. Read existing file to match section structure before editing. |

---

## Metadata

**Analog search scope:** `scripts/eval/`, `scripts/eval/results/`, `src/consolidation/`, `src/model/`, `package.json`, `.github/workflows/`
**Files scanned:** 12 source files read + 4 result JSONs read
**Pattern extraction date:** 2026-06-29
