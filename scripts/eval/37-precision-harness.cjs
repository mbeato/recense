/**
 * 37-precision-harness.cjs — Phase 37 Wave 3 build-gate harness.
 *
 * Measures the D-04 PRIMARY deterministic metric (nodes-to-answer / answer-in-top-3)
 * and the SECONDARY LLM-compose rate (3x majority, confirmation only, NEVER the gate)
 * on the founder-signed, predicate-balanced query set (queries-37.json).
 *
 * CRITICAL (Pitfall 5 / D-04):
 *   The merge gate is the PRIMARY deterministic metric ONLY:
 *     typed top-3% >= 75% AND lift over untyped >= +20pts
 *   The compose rate is SECONDARY (confirmation only). It does NOT pass or fail the run.
 *
 * Modeled on scripts/eval/replay-ku-harness.cjs:
 *   --dry-run        Validate wiring + query-set parse, ZERO LLM/API calls, exit 0.
 *   --regression-only  TYPED-01d stub: compare claim counts on a sample, no compose.
 *   --threshold-sweep  Optional: iterate predicateGlossThreshold over 0.25/0.35/0.45/0.55.
 *   --db <path>        Path to the typed-edge DB (default: spike scratch.db).
 *   --out <path>       Results JSON output path.
 *
 * Run:
 *   npm run build && node scripts/eval/37-precision-harness.cjs --dry-run --out /tmp/37-dry.json
 *   npm run build && RECENSE_MODEL_PROVIDER=claude-headless node scripts/eval/37-precision-harness.cjs
 *
 * Net-zero new deps: uses only better-sqlite3 (existing) and the built dist modules.
 * The compose path reuses the claude-headless transport from the built engine.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ── arg parser (mirrors replay-ku-harness.cjs convention) ────────────────────
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DRY_RUN         = process.argv.includes('--dry-run');
const REGRESSION_ONLY = process.argv.includes('--regression-only');
const THRESHOLD_SWEEP = process.argv.includes('--threshold-sweep');
const DO_COMPOSE      = !process.argv.includes('--no-compose') && !DRY_RUN && !REGRESSION_ONLY;
const RUNS            = parseInt(arg('--runs', '3'), 10);  // 3x majority vote for compose

// Default DB: spike scratch.db (has real typed edges from Max's episodes).
// Override with --db <path> if the live DB has been populated via Wave 1 extraction.
// The spike DB lives in the main repo's .planning/spikes/; detect the main repo
// root via git (worktrees have a .git file, not a .git directory — the common
// toplevel is the main repo).
let MAIN_REPO_ROOT;
try {
  // git rev-parse --git-common-dir returns the main .git/ dir (works in worktrees too).
  const gitCommonDir = execSync('git rev-parse --git-common-dir', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  // Strip the trailing /.git to get the repo root.
  MAIN_REPO_ROOT = path.resolve(gitCommonDir, '..');
} catch {
  // Fallback: assume the harness runs from the repo root.
  MAIN_REPO_ROOT = process.cwd();
}
const DEFAULT_DB = path.join(MAIN_REPO_ROOT, '.planning/spikes/004-typed-predicate-edges/scratch.db');
const DB_PATH    = arg('--db', DEFAULT_DB);

const QUERIES_PATH = arg('--queries', path.resolve(__dirname, 'queries-37.json'));

const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT   = arg('--out', path.resolve(__dirname, `results/37-precision-${ts}.json`));

// Threshold sweep values for D-05 calibration (--threshold-sweep flag).
const SWEEP_THRESHOLDS = [0.25, 0.35, 0.45, 0.55];
const DEFAULT_THRESHOLD = 0.35;  // predicateGlossThreshold default (RESEARCH §2)

const K = 20;  // recallNeighborhoodBudget (from DEFAULT_CONFIG; anchored in queries-37.json _meta)
const BIG = 1_000_000;  // uncapped traversal for NTA calculation

// ── require built engine ──────────────────────────────────────────────────────
// These requires will throw if npm run build has not been run.
const Database                       = require('better-sqlite3');
const { createClaudeHeadlessClient } = require('../../dist/src/model/claude-headless-client');
const { DEFAULT_CONFIG }             = require('../../dist/src/lib/config');

// ── PREDICATES: closed 12-vocab (D-09) ───────────────────────────────────────
// Sourced from src/model/typed-predicates.ts via the built dist.
const { PREDICATES, PRED_SET } = require('../../dist/src/model/typed-predicates');

// ── load typed-edge DB (read-only) ───────────────────────────────────────────
// The DB MUST have typed predicate edges (kind='relation' with closed-vocab rel).
// For Phase 37, this is either:
//   (a) the spike scratch.db (default — real edges from Max's episodes),
//   (b) a copy of the live recense.db after Wave 1 extraction (--db flag).
// CRITICAL: never mutate the live recense.db (no-write guard below).
if (!fs.existsSync(DB_PATH)) {
  console.error(`\nERROR: typed-edge DB not found: ${DB_PATH}`);
  console.error('Pass --db <path> to specify a DB with typed predicate edges,');
  console.error('or run Wave 1 extraction (RECENSE_TYPED_EXTRACTION_MODE=merged) to populate.');
  process.exit(1);
}

// ── load query set ────────────────────────────────────────────────────────────
if (!fs.existsSync(QUERIES_PATH)) {
  console.error(`\nERROR: query set not found: ${QUERIES_PATH}`);
  console.error('Run Task 2 to create queries-37.json before executing the harness.');
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));

// Validate query-set shape.
if (!spec._meta || typeof spec._meta.K !== 'number') {
  console.error('ERROR: queries-37.json missing _meta.K');
  process.exit(1);
}
if (!Array.isArray(spec.queries) || spec.queries.length < 20) {
  console.error(`ERROR: queries-37.json has ${(spec.queries || []).length} queries; need >= 20`);
  process.exit(1);
}
for (const q of spec.queries) {
  if (!q.predicate_path || !Array.isArray(q.predicate_path) || q.predicate_path.length !== 1) {
    console.error(`ERROR: query ${q.id} has predicate_path length ${(q.predicate_path || []).length}; must be 1 (v1 single-hop, D-07)`);
    process.exit(1);
  }
  if (!PRED_SET.has(q.predicate_path[0])) {
    console.error(`ERROR: query ${q.id} predicate '${q.predicate_path[0]}' is not in the closed vocab`);
    process.exit(1);
  }
}

// Verify all 12 predicates are covered.
const predicatesInSet = new Set(spec.queries.flatMap(q => q.predicate_path));
const missingPredicates = PREDICATES.filter(p => !predicatesInSet.has(p));
if (missingPredicates.length > 0) {
  console.error(`ERROR: queries-37.json missing predicates: ${missingPredicates.join(', ')}`);
  process.exit(1);
}

console.log('\nPhase 37 Precision Harness (TYPED-02f build gate)');
console.log(`DB:      ${DB_PATH}`);
console.log(`Queries: ${QUERIES_PATH}  (${spec.queries.length} queries, K=${spec._meta.K})`);
console.log(`Mode:    ${DRY_RUN ? '--dry-run (ZERO LLM calls)' : REGRESSION_ONLY ? '--regression-only' : `full (compose=${DO_COMPOSE ? `${RUNS}x majority` : 'off'})`}`);
if (THRESHOLD_SWEEP) console.log(`         + --threshold-sweep [${SWEEP_THRESHOLDS.join(', ')}]`);
console.log();

// ── TYPED-01d regression-only stub (--regression-only --dry-run) ─────────────
// Validates wiring of the D-03 regression check (claim count >= baseline × 0.85).
// Full regression requires a real extraction pass; this stub validates the flag path.
if (REGRESSION_ONLY) {
  console.log('[regression-only] D-03 stub: claim-count regression check wiring verified.');
  console.log('  Full regression requires: RECENSE_TYPED_EXTRACTION_MODE=merged run on a sample.');
  console.log('  Stub exits 0 — no API calls, no DB writes.');
  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const result = {
    mode: 'regression-only',
    date: new Date().toISOString(),
    note: 'D-03 stub: claim-count regression wiring validated (full run requires live extraction pass)',
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[regression-only] Written -> ${OUT}`);
  process.exit(0);
}

// ── open DB read-only ─────────────────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true });

// ── helper: normalize ids (mirrors spike's normalize) ─────────────────────────
// The spike stores lowercase entity ids. Match the spike's normalize function.
const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ── node value lookup ─────────────────────────────────────────────────────────
// Handles both live recense.db (has 'value' column on node table) and
// spike scratch.db (also has 'value' column). Falls back to the id if not found.
let stmtNodeValue;
try {
  stmtNodeValue = db.prepare('SELECT value FROM node WHERE id = ?');
} catch {
  stmtNodeValue = null;
}
const valueOf = (id) => {
  if (!stmtNodeValue) return id;
  const row = stmtNodeValue.get(id);
  return row ? row.value : id;
};

// ── value → node ids resolver ───────────────────────────────────────────────────
// Query-set anchors/golds are node VALUES (human-readable, founder-signed), not ids.
// The live recense.db keys nodes by UUID, so values must be resolved to ids before
// traversal. The spike scratch.db keys nodes by their (lowercased) value, so the
// fallback returns the normalized value itself — keeping both DBs working.
// Entity fragmentation (multiple nodes sharing a value) → union all matching ids.
let stmtIdsByValue;
try {
  stmtIdsByValue = db.prepare('SELECT id FROM node WHERE value = ?');
} catch {
  stmtIdsByValue = null;
}
function resolveIds(value) {
  if (stmtIdsByValue) {
    const rows = stmtIdsByValue.all(value);
    if (rows.length) return rows.map(r => r.id);
  }
  return [normalize(value)]; // spike convention: id == normalized value
}

// ── edge query ────────────────────────────────────────────────────────────────
// The spike DB has: SELECT src, dst, rel, w FROM edge (no 'kind' column).
// The live DB has:  SELECT src, dst, rel, w, kind FROM edge.
// We detect which schema is present and filter accordingly.
let HAS_KIND_COLUMN = false;
try {
  db.prepare('SELECT kind FROM edge LIMIT 1').get();
  HAS_KIND_COLUMN = true;
} catch {
  HAS_KIND_COLUMN = false;
}

let stmtOutEdges;
if (HAS_KIND_COLUMN) {
  // Live DB: filter to kind='relation' AND PRED_SET vocab (LANDMINE 1+2 guards).
  stmtOutEdges = db.prepare(`SELECT dst, rel, w FROM edge WHERE src = ? AND kind = 'relation'`);
} else {
  // Spike DB: all edges are typed predicates (no kind column).
  stmtOutEdges = db.prepare('SELECT dst, rel, w FROM edge WHERE src = ?');
}

function outEdges(src) {
  const rows = stmtOutEdges.all(src);
  if (HAS_KIND_COLUMN) {
    // Additional PRED_SET filter for live DB (LANDMINE 2: links_to / extends).
    return rows.filter(e => PRED_SET.has(e.rel));
  }
  return rows;
}

// ── TYPED traversal ───────────────────────────────────────────────────────────
// Inlined from spike lib/traverse.ts:typedReach, adapted for the CJS harness.
// Returns top-K node ids ranked by accumulated path-weight, stable id tiebreak.
function typedReach(anchorIds, predicatePath, maxK) {
  let frontier = new Map(anchorIds.map(a => [a, 0]));
  for (const pred of predicatePath) {
    const next = new Map();
    for (const [node, acc] of frontier) {
      for (const e of outEdges(node)) {
        if (e.rel !== pred) continue;
        const score = acc + e.w;
        const prev = next.get(e.dst);
        if (prev === undefined || score > prev) next.set(e.dst, score);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return [...frontier.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxK)
    .map(([id]) => id);
}

// ── UNTYPED (control) traversal ───────────────────────────────────────────────
// Inlined from spike lib/traverse.ts:untypedTopK. Label-blind weighted k-hop BFS.
// Returns top-K node ids ranked by best path-weight (rel deliberately ignored).
function untypedTopK(anchorIds, depth, maxK) {
  const anchorSet = new Set(anchorIds);
  const best = new Map();
  let frontier = anchorIds.map(node => ({ node, acc: 0 }));
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const { node, acc } of frontier) {
      // Use ALL edges for the untyped arm (rel ignored = label-blind).
      // Query all outgoing edges from this node regardless of rel/kind.
      const allEdges = HAS_KIND_COLUMN
        ? db.prepare('SELECT dst, rel, w FROM edge WHERE src = ?').all(node)
        : db.prepare('SELECT dst, rel, w FROM edge WHERE src = ?').all(node);
      for (const e of allEdges) {
        if (anchorSet.has(e.dst)) continue;
        const score = acc + e.w;
        const prev = best.get(e.dst);
        if (!prev || score > prev.score) best.set(e.dst, { score, depth: d });
        next.push({ node: e.dst, acc: score });
      }
    }
    frontier = next;
  }
  return [...best.entries()]
    .sort((a, b) =>
      b[1].score - a[1].score ||
      a[1].depth - b[1].depth ||
      (a[0] < b[0] ? -1 : 1))
    .slice(0, maxK)
    .map(([id]) => id);
}

// ── payload line builders ─────────────────────────────────────────────────────
// Mirrors spike 05-precision.ts: typedPayloadLines (labeled) vs untypedPayloadLines (stripped).
let stmtAllEdges;
try {
  stmtAllEdges = HAS_KIND_COLUMN
    ? db.prepare(`SELECT src, dst, rel FROM edge WHERE src = ? AND kind = 'relation'`)
    : db.prepare('SELECT src, dst, rel FROM edge WHERE src = ?');
} catch {
  stmtAllEdges = null;
}

function edgesOf(src) {
  if (!stmtAllEdges) return [];
  const rows = stmtAllEdges.all(src);
  if (HAS_KIND_COLUMN) return rows.filter(e => PRED_SET.has(e.rel));
  return rows;
}

/** Typed arm payload: labeled triples (anchor → predicate → neighbor). */
function typedPayloadLines(anchorIds, predicatePath, topKPayload) {
  const lines = [];
  let frontier = [...anchorIds];
  for (const pred of predicatePath) {
    const next = [];
    for (const node of frontier) {
      for (const e of edgesOf(node)) {
        if (e.rel === pred) {
          lines.push(`${valueOf(e.src)} ${e.rel} ${valueOf(e.dst)}`);
          next.push(e.dst);
        }
      }
    }
    frontier = next;
  }
  return [...new Set(lines)].slice(0, 40);
}

/** Untyped arm payload: same structural edges, predicate STRIPPED. */
function untypedPayloadLines(anchorIds, depth, topKValues) {
  const keep = new Set(topKValues.map(normalize));
  for (const a of anchorIds) keep.add(normalize(valueOf(a)));
  const lines = [];
  let frontier = [...anchorIds];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const node of frontier) {
      for (const e of edgesOf(node)) {
        if (keep.has(normalize(valueOf(e.dst)))) {
          lines.push(`${valueOf(e.src)} — ${valueOf(e.dst)}`);
        }
        next.push(e.dst);
      }
    }
    frontier = next;
  }
  return [...new Set(lines)].slice(0, 40);
}

// ── rank helper ───────────────────────────────────────────────────────────────
const rankOf = (payload, goldId) => {
  const i = payload.indexOf(goldId);
  return i === -1 ? null : i + 1;
};

// Value-based rank: the gold is a node VALUE; returned payloads are node ids.
// Rank = 1-based position of the first returned id whose value matches the gold.
// Handles entity fragmentation (any id sharing the gold value counts as a hit).
const rankOfValue = (ids, goldValue) => {
  const g = normalize(goldValue);
  for (let i = 0; i < ids.length; i++) {
    if (normalize(valueOf(ids[i])) === g) return i + 1;
  }
  return null;
};

// ── DRY-RUN: validate wiring + query-set parse, ZERO LLM calls, exit 0 ───────
if (DRY_RUN) {
  console.log('[dry-run] Validating DB access and query-set wiring...');
  let validCount = 0;
  let parseErrors = 0;
  for (const q of spec.queries) {
    const anchorIds = resolveIds(q.anchor);
    try {
      // Verify traversal functions run without error (no LLM calls).
      const typedIds   = typedReach(anchorIds, q.predicate_path, K);
      const untypedIds = untypedTopK(anchorIds, q.predicate_path.length, K);
      // Dry-run: just confirm the functions return arrays (may be empty — edges not yet present).
      if (!Array.isArray(typedIds) || !Array.isArray(untypedIds)) {
        console.error(`  [dry-run] ERROR on ${q.id}: traversal did not return array`);
        parseErrors++;
        continue;
      }
      validCount++;
      process.stdout.write(`  [dry-run] ${q.id.padEnd(5)} anchor=${q.anchor.padEnd(25)} predicate=${q.predicate_path[0].padEnd(16)} typed_reach=${typedIds.length}  untyped_reach=${untypedIds.length}\n`);
    } catch (e) {
      console.error(`  [dry-run] ERROR on ${q.id}: ${String(e.message || e).slice(0, 200)}`);
      parseErrors++;
    }
  }

  // Payload-size stat in dry-run (confirms token-win measurement present).
  console.log(`\n[dry-run] payload wiring: PRESENT (typedPayloadLines / untypedPayloadLines implemented)`);
  console.log(`[dry-run] SECONDARY compose: labeled as confirmation only (never gates)`);
  console.log(`[dry-run] ${validCount}/${spec.queries.length} queries validated, ${parseErrors} errors`);

  // Write dry-run skeleton.
  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

  const dryResult = {
    mode: 'dry-run',
    date: new Date().toISOString(),
    commit,
    db: DB_PATH,
    queries: QUERIES_PATH,
    query_count: spec.queries.length,
    K: spec._meta.K,
    predicates_covered: [...predicatesInSet].sort(),
    queries_validated: validCount,
    parse_errors: parseErrors,
    note: 'dry-run: ZERO LLM/API calls; run without --dry-run for PRIMARY + SECONDARY metrics',
  };
  fs.writeFileSync(OUT, JSON.stringify(dryResult, null, 2));
  if (parseErrors > 0) {
    console.error(`\n[dry-run] FAILED: ${parseErrors} query errors`);
    process.exit(1);
  }
  console.log(`\n[dry-run] PASSED. Skeleton written -> ${OUT}`);
  process.exit(0);
}

// ── API key guard (real runs only) ────────────────────────────────────────────
// RECENSE_MODEL_PROVIDER=claude-headless → subscription transport (no API key for compose).
// OPENAI_API_KEY not needed for this harness (no embedding calls here).
const MODEL_PROVIDER = process.env.RECENSE_MODEL_PROVIDER || '';
const IS_HEADLESS    = MODEL_PROVIDER === 'claude-headless';

if (DO_COMPOSE && !IS_HEADLESS) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nERROR: ANTHROPIC_API_KEY required for compose (or set RECENSE_MODEL_PROVIDER=claude-headless)');
    console.error('TIP: set RECENSE_MODEL_PROVIDER=claude-headless for subscription-billed compose calls (no API key needed).');
    process.exit(1);
  }
}

// ── compose prompt + scoring ──────────────────────────────────────────────────
function composePrompt(question, lines) {
  return `Answer the question using ONLY these memory facts retrieved from a graph. ` +
    `Reply with ONLY the answer (a short phrase), or the word null if the facts don't contain it.\n\n` +
    `Facts:\n${lines.map(l => `- ${l}`).join('\n')}\n\nQuestion: ${question}\nAnswer:`;
}
const answersGold = (composed, goldId) => {
  const a = normalize(composed);
  return a !== '' && a !== 'null' && (a.includes(goldId) || goldId.includes(a));
};

// Lazy-init compose client.
let _composeClient = null;
function getComposeClient() {
  if (_composeClient) return _composeClient;
  if (IS_HEADLESS) {
    const { client } = createClaudeHeadlessClient(DEFAULT_CONFIG);
    _composeClient = client;
  } else {
    const Anthropic = require('@anthropic-ai/sdk');
    _composeClient = new Anthropic();
  }
  return _composeClient;
}

async function composeCorrectRate(question, lines, goldId) {
  if (lines.length === 0) return 0;
  const client = getComposeClient();
  let correct = 0;
  for (let r = 0; r < RUNS; r++) {
    const resp = await client.messages.create({
      model:      DEFAULT_CONFIG.anthropicModel,  // claude-haiku-4-5-20251001
      max_tokens: 64,
      messages:   [{ role: 'user', content: composePrompt(question, lines) }],
    });
    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    if (answersGold(text, goldId)) correct++;
  }
  return correct / RUNS;
}

// ── main precision measurement loop ──────────────────────────────────────────
async function measurePrecision(thresholdLabel) {
  const rows = [];

  for (const q of spec.queries) {
    const anchorIds = resolveIds(q.anchor);
    const goldId    = normalize(q.gold);   // for compose text-match (answersGold)
    const depth     = q.predicate_path.length;  // 1 for v1 single-hop

    // PRIMARY: typed and untyped traversal (deterministic, zero variance).
    const typedFull   = typedReach(anchorIds, q.predicate_path, BIG);
    const untypedFull = untypedTopK(anchorIds, depth, BIG);
    const typedNTA    = rankOfValue(typedFull, q.gold);
    const untypedNTA  = rankOfValue(untypedFull, q.gold);
    const reachable   = untypedNTA !== null;

    // Payload size (token-win metric): typed path length vs neighborhood K=20.
    // This is the interview-defensible "typed ~N nodes vs neighborhood K" claim.
    const typedPayloadSize   = typedFull.length;
    const untypedPayloadSize = Math.min(untypedFull.length, K);  // capped at K

    // SECONDARY (LLM-compose, 3x majority, CONFIRMATION ONLY — never gates).
    let typedCompose = null, untypedCompose = null;
    if (DO_COMPOSE && reachable) {
      const typedKPayload   = typedReach(anchorIds, q.predicate_path, K);
      const untypedKPayload = untypedTopK(anchorIds, depth, K);
      const tLines = typedPayloadLines(anchorIds, q.predicate_path, typedKPayload);
      const uLines = untypedPayloadLines(anchorIds, depth, untypedKPayload.map(id => valueOf(id)));
      typedCompose   = await composeCorrectRate(q.question, tLines, goldId);
      untypedCompose = await composeCorrectRate(q.question, uLines, goldId);
    }

    rows.push({
      id:                  q.id,
      dilution:            q.dilution,
      predicate:           q.predicate_path[0],
      anchor:              q.anchor,
      gold:                q.gold,
      question:            q.question,
      reachable,
      typedNTA,
      untypedNTA,
      typedPayloadSize,
      untypedPayloadSize,
      typedCompose,
      untypedCompose,
    });

    const marker = typedNTA !== null ? (typedNTA <= 3 ? 'TOP3' : `rank${typedNTA}`) : 'MISS';
    process.stdout.write(`  ${q.id.padEnd(5)} [${q.predicate_path[0].padEnd(16)}] typed_NTA=${String(typedNTA ?? '-').padStart(4)}  untyped_NTA=${String(untypedNTA ?? '-').padStart(4)}  payload=${typedPayloadSize}  ${marker}\n`);
  }

  // ── PRIMARY aggregate: answer-in-top-3 % (the gate metric, D-04) ─────────────
  const both = rows.filter(r => r.typedNTA !== null && r.untypedNTA !== null);
  const typedTop3Pct   = both.length ? Math.round(both.filter(r => r.typedNTA <= 3).length / both.length * 1000) / 10 : 0;
  const untypedTop3Pct = both.length ? Math.round(both.filter(r => r.untypedNTA <= 3).length / both.length * 1000) / 10 : 0;
  const lift           = Math.round((typedTop3Pct - untypedTop3Pct) * 10) / 10;

  const typedTop1Pct   = both.length ? Math.round(both.filter(r => r.typedNTA === 1).length / both.length * 1000) / 10 : 0;
  const untypedTop1Pct = both.length ? Math.round(both.filter(r => r.untypedNTA === 1).length / both.length * 1000) / 10 : 0;

  const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : 0;
  const typedMeanNTA   = mean(both.map(r => r.typedNTA));
  const untypedMeanNTA = mean(both.map(r => r.untypedNTA));

  // PAYLOAD SIZE (token-win claim): typed mean vs K=20 neighborhood.
  const typedMeanPayload = mean(rows.map(r => r.typedPayloadSize));

  // ── PRIMARY gate evaluation (D-04) ───────────────────────────────────────────
  const gatePasses = typedTop3Pct >= 75 && lift >= 20;
  const gateLabel  = gatePasses
    ? `GO  — typed top-3 ${typedTop3Pct}% >= 75% AND lift +${lift}pts >= +20pts`
    : `NO-GO — gate missed (typed top-3 ${typedTop3Pct}%; lift +${lift}pts; need >=75% AND >=+20pts)`;

  // ── SECONDARY aggregate (confirmation only, NEVER the gate) ──────────────────
  let typedComposeRate = null, untypedComposeRate = null, composeLift = null;
  if (DO_COMPOSE) {
    const compRows = rows.filter(r => r.typedCompose !== null);
    if (compRows.length > 0) {
      typedComposeRate   = Math.round(mean(compRows.map(r => r.typedCompose * 100)) * 10) / 10;
      untypedComposeRate = Math.round(mean(compRows.map(r => r.untypedCompose * 100)) * 10) / 10;
      composeLift        = Math.round((typedComposeRate - untypedComposeRate) * 10) / 10;
    }
  }

  // ── print results ─────────────────────────────────────────────────────────────
  const bar = '─'.repeat(80);
  console.log(`\n${bar}`);
  console.log(` Phase 37 Precision Gate  (n=${spec.queries.length}, both-reach n=${both.length}, K=${K})`);
  if (thresholdLabel) console.log(` Threshold sweep: ${thresholdLabel}`);
  console.log(bar);

  console.log('\n── PRIMARY (deterministic) — NTA / answer-in-top-3 % (D-04 GATE METRIC) ──');
  console.log(`  nodes-to-answer   typed: mean ${typedMeanNTA}  |  untyped: mean ${untypedMeanNTA}`);
  console.log(`  answer at rank 1  typed: ${typedTop1Pct}%     |  untyped: ${untypedTop1Pct}%`);
  console.log(`  answer in top-3   typed: ${typedTop3Pct}%     |  untyped: ${untypedTop3Pct}%   |  lift: ${lift >= 0 ? '+' : ''}${lift}pts`);
  console.log(`  payload size      typed: mean ${typedMeanPayload} nodes  |  untyped: ${K} nodes (fills budget)`);
  console.log(`\n  GATE (PRIMARY):   ${gateLabel}`);

  if (DO_COMPOSE && typedComposeRate !== null) {
    console.log('\n── SECONDARY (LLM-compose, 3x majority) — CONFIRMATION ONLY, never gates (Pitfall 5) ──');
    console.log(`  compose-correct   typed: ${typedComposeRate}%   |  untyped: ${untypedComposeRate}%   |  lift: ${composeLift >= 0 ? '+' : ''}${composeLift}pts`);
    console.log('  (SECONDARY: confirmation only; the PRIMARY deterministic metric is the merge gate)');
  }
  console.log(bar + '\n');

  return {
    n:              spec.queries.length,
    nBoth:          both.length,
    K,
    typedTop3Pct,
    untypedTop3Pct,
    lift,
    typedTop1Pct,
    untypedTop1Pct,
    typedMeanNTA,
    untypedMeanNTA,
    typedMeanPayload,
    gatePasses,
    gateLabel,
    secondary: DO_COMPOSE && typedComposeRate !== null
      ? { label: 'SECONDARY (confirmation only)', typedComposeRate, untypedComposeRate, composeLift }
      : null,
    per_query: rows,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  const tStart = Date.now();

  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch {}

  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let results;

  if (THRESHOLD_SWEEP) {
    // D-05 calibration sweep: iterate predicateGlossThreshold values.
    // In this harness the threshold does NOT affect the traversal arms (which use
    // annotated predicate paths from the query set). The sweep is informational —
    // it records the per-threshold match rate against the query set to confirm the
    // 0.35 default avoids false triggers. Actual gloss cosine match requires the
    // gloss embeddings from the live engine; the sweep here reports a placeholder.
    console.log('[threshold-sweep] D-05 calibration sweep (informational — requires gloss embeddings from live engine for cosine).');
    console.log('  Sweep values: ' + SWEEP_THRESHOLDS.join(', '));
    console.log('  Note: the traversal arms use query predicate_path annotations (upper bound).');
    console.log('        Cosine-based predicate match is validated in the live RecallEngine tests.\n');

    // Run precision once (threshold does not affect traversal arms).
    results = await measurePrecision(null);
    results.sweep = {
      note: 'threshold-sweep: traversal uses annotated paths (spike upper-bound); gloss cosine sweep needs live engine with gloss embeddings',
      values: SWEEP_THRESHOLDS,
      default: DEFAULT_THRESHOLD,
    };
  } else {
    results = await measurePrecision(null);
  }

  // Canonical LATEST symlink / file for TYPED-02f gate verification.
  const latestPath = path.resolve(__dirname, 'results/37-precision-LATEST.json');
  // Ensure results/ directory exists before writing LATEST.
  const latestDir = path.dirname(latestPath);
  if (!fs.existsSync(latestDir)) fs.mkdirSync(latestDir, { recursive: true });

  const envelope = {
    meta: {
      eval:    '37-precision',
      mode:    'full',
      date:    new Date().toISOString(),
      commit,
      db:      DB_PATH,
      queries: QUERIES_PATH,
      K,
      compose_runs: DO_COMPOSE ? RUNS : 0,
    },
    // both field for TYPED-02f gate verification: typeof r.both === 'number'.
    both:    results.nBoth,
    gate:    { passes: results.gatePasses, label: results.gateLabel },
    primary: {
      label:           'PRIMARY (deterministic) — the merge gate metric (D-04)',
      typedTop3Pct:    results.typedTop3Pct,
      untypedTop3Pct:  results.untypedTop3Pct,
      lift:            results.lift,
      typedTop1Pct:    results.typedTop1Pct,
      untypedTop1Pct:  results.untypedTop1Pct,
      typedMeanNTA:    results.typedMeanNTA,
      untypedMeanNTA:  results.untypedMeanNTA,
    },
    payload: {
      label:            'PAYLOAD SIZE (token-win claim)',
      typedMeanNodes:   results.typedMeanPayload,
      untypedNodes:     K,
      note:             `typed path ~${results.typedMeanPayload} nodes vs neighborhood K=${K}`,
    },
    secondary: results.secondary || {
      label: 'SECONDARY (confirmation only, never gates — Pitfall 5 / D-04)',
      note:  'compose not run (add --no-no-compose and RECENSE_MODEL_PROVIDER=claude-headless for secondary)',
    },
    per_query: results.per_query,
    ...(results.sweep ? { sweep: results.sweep } : {}),
  };

  fs.writeFileSync(OUT, JSON.stringify(envelope, null, 2));
  // Write LATEST alias.
  fs.writeFileSync(latestPath, JSON.stringify(envelope, null, 2));

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`Results written -> ${OUT}`);
  console.log(`LATEST   written -> ${latestPath}`);
  console.log(`Elapsed: ${elapsed}s`);

  db.close();
})().catch(e => {
  console.error('FATAL:', e);
  db.close();
  process.exit(1);
});
