/**
 * DRIFT-05 harness — provenance-key distinctness + belief-correction accuracy (Phase 65, Plan 65-10).
 *
 * Run:
 *   npm run build && node scripts/eval/drift-05-dry-run.cjs --dry-run
 *   npm run build && ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node scripts/eval/drift-05-dry-run.cjs \
 *     --inbox ~/drift05-inbox.jsonl --out scripts/eval/results/drift-05-<date>.json
 *
 * Key requirements (mirrors correctness-harness.cjs's conventions):
 *   - Always run `npm run build` before this script (requires compiled dist/ output).
 *   - --dry-run: zero API/LLM calls, zero network. Section 1 (provenance-key distinctness) and
 *     Section 3 (methodology) run FULLY for real in dry mode — the derivation and the quote
 *     stripper are pure, LLM-free functions. Section 2 (belief-correction) in dry mode substitutes
 *     a SCRIPTED MockModelProvider for the real classifier/judge and is tagged provider:'mock' in
 *     the output so a mock-derived number can never be mistaken for a live one (T-65-10-MOCKNUM).
 *     The scripted magnitude is computed from the REAL live node's resistance (queried from the
 *     scratch DB) so the routing math is exercised faithfully; only the CLASSIFICATION/JUDGING
 *     itself is scripted, not the PE-band arithmetic.
 *   - Real runs (no --dry-run): every case runs through `runConsolidation()` — the real
 *     DefaultModelProvider stack (real Haiku/Sonnet classification + judging) — requires real
 *     ANTHROPIC_API_KEY + OPENAI_API_KEY. This is the honest measurement Task 3's checkpoint reviews.
 *   - Every case (dry or real) uses a fresh scratch DB under os.tmpdir() (T-14-DB precedent);
 *     never inherits an existing DB path.
 *   - --inbox <path>: a JSONL file of REAL exported Gmail messages (one
 *     {from, thread_id, date, body} object per line), supplied by the operator and NEVER
 *     committed (T-65-10-PII). When absent, Section 1 measures the committed synthetic case set
 *     only and says so in the output (`message_source`/`real_inbox_used`).
 *   - --sweep-residual <a,b,c>: comma-separated provenanceMinResidualChars values Section 1
 *     re-evaluates distinctness under. Default 10,20,30.
 *   - This harness NEVER enables `provenanceDistinctnessEnabled` — it reads the shipped
 *     DEFAULT_CONFIG value for the methodology block only. Section 2's episodes are minted
 *     directly (bypassing GmailAdapter) with `session_id` set to the REAL derived key so the
 *     redesigned derivation's effect on belief-correction can be measured without ever flipping
 *     the shipped config flag — enabling that flag is Task 3's human decision, not this script's.
 *
 * Gotchas:
 *   - Section 2's dry-mode magnitude targeting: `routeContradiction`'s bands
 *     (peReconcileBandLow/High) are compared against `ratio = magnitude / resistance`, where
 *     `resistance = effective_s * c` of the CURRENT live candidate node. This harness queries
 *     that node directly from the scratch DB before scripting each pass's judge magnitude, so
 *     the target routing outcome (hold vs reconcile) is reached deterministically regardless of
 *     the exact confirm-path starting values — see `computeMagnitudeForRatio`.
 *   - Each message is ingested and consolidated in its OWN pass (one message = one sleep-pass
 *     cycle) rather than batched. This sidesteps predicting cross-episode extraction-prefetch
 *     order within a single pass and is the realistic cadence for incrementally-arriving email.
 *     It also makes the out-of-order cases a direct test of the D-11(b) CROSS-PASS event_ts
 *     guard specifically (the D-11(a) within-pass backfill sort is covered by existing
 *     episode-order tests, not duplicated here).
 *   - Observed outcome is read from the LAST `consolidation_event` row tied to any of the
 *     case's gmail episodes (ordered by ts): EMISSION_ELIGIBLE_EVENT_TYPES -> 'corrected',
 *     'contradict_hold' -> 'hold', anything else (including "no row at all", e.g. every
 *     message was dropped by the staleness guard) -> 'unchanged'. This mirrors the D-13
 *     predicate already shipped in `src/consolidation/status-drift.ts` rather than
 *     re-deriving a second classification rule.
 *   - Case schema note (documented here per the provenance-key.ts precedent for resolving a
 *     stated plan inconsistency): the plan's action text names seven per-case fields but its
 *     own acceptance criteria requires eight. This harness's case file adds an eighth
 *     `requirement` field (a structured DRIFT-0X tag, distinct from the free-text `rationale`)
 *     as the resolution.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- arg parser (mirrors correctness-harness.cjs convention) ---------------
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };

const DRY_RUN = process.argv.includes('--dry-run');
const CASES_PATH = arg('--cases', 'scripts/eval/cases/drift-05-cases.json');
const OUT = arg('--out', 'scripts/eval/results/drift-05-PENDING.json');
const INBOX_PATH = arg('--inbox', null);
const SWEEP_RESIDUAL = arg('--sweep-residual', '10,20,30').split(',').map(Number);

// ---- compiled engine modules (require npm run build first) -----------------
const Database = require('better-sqlite3');
const { initSchema } = require('../../dist/src/db/schema');
const { DEFAULT_CONFIG } = require('../../dist/src/lib/config');
const { FakeClock, realClock } = require('../../dist/src/lib/clock');
const { EpisodicStore } = require('../../dist/src/db/episode-store');
const { SemanticStore } = require('../../dist/src/db/semantic-store');
const { StrengthDecayManager, effectiveStrength } = require('../../dist/src/strength/decay');
const { CandidateRetriever } = require('../../dist/src/retrieval/topk');
const { MockModelProvider } = require('../../dist/src/model/provider');
const { Consolidator } = require('../../dist/src/consolidation/consolidator');
const { SchemaInducer } = require('../../dist/src/consolidation/schema-induction');
const { SQLiteConsolidationSink } = require('../../dist/src/consolidation/sink');
const { EventStore } = require('../../dist/src/db/event-store');
const {
  deriveGmailProvenanceKey,
  normalizeSenderDomain,
  COLLAPSED_GMAIL_PROVENANCE_KEY,
} = require('../../dist/src/source/provenance-key');
const { stripQuotedForwarded, isNearEmptyResidual } = require('../../dist/src/source/strip-quoted');
const { isEmissionEligible } = require('../../dist/src/consolidation/status-drift');
// runConsolidation is only invoked in the non-dry-run path (real DefaultModelProvider).
const { runConsolidation } = require('../../dist/src/consolidation/run-sleep-pass');

// ---- API key guard (real runs only) -----------------------------------------
if (!DRY_RUN) {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    console.error(`\nERROR: missing API keys for a real run: ${missing.join(', ')}`);
    console.error('Pass --dry-run to run Section 1/3 for real and Section 2 with a scripted mock provider.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Section 1: provenance-key distinctness (pure, real derivation — works in every mode)
// ---------------------------------------------------------------------------

function countNonWhitespace(text) {
  const matches = text.match(/\S/g);
  return matches === null ? 0 : matches.length;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

/**
 * Classify WHY a message fell back to the collapsed key, checking conditions in the SAME
 * order `deriveGmailProvenanceKey` checks them (residual gate first, then domain, then
 * thread-id) so the reason distribution is never mis-attributed.
 */
function classifyFallbackReason(message, residual, minResidualChars) {
  if (isNearEmptyResidual(residual, minResidualChars)) return 'near-empty-residual';
  if (normalizeSenderDomain(message.from) === null) return 'no-domain';
  return 'no-thread-id';
}

function analyzeProvenanceDistinctness(messages, defaultThreshold, sweepThresholds) {
  const total = messages.length;
  const derivedKeysDefault = new Set();
  const fallbackReasons = { 'no-domain': 0, 'no-thread-id': 0, 'near-empty-residual': 0 };
  let fallbackCount = 0;
  const residualLengths = [];

  for (const m of messages) {
    const residual = stripQuotedForwarded(m.body);
    residualLengths.push(countNonWhitespace(residual));

    const key = deriveGmailProvenanceKey({
      fromHeader: m.from,
      threadId: m.thread_id,
      bodyText: m.body,
      minResidualChars: defaultThreshold,
    });
    derivedKeysDefault.add(key);
    if (key === COLLAPSED_GMAIL_PROVENANCE_KEY) {
      fallbackCount++;
      fallbackReasons[classifyFallbackReason(m, residual, defaultThreshold)]++;
    }
  }

  const sweep = {};
  for (const threshold of sweepThresholds) {
    const keys = new Set();
    for (const m of messages) {
      keys.add(deriveGmailProvenanceKey({
        fromHeader: m.from,
        threadId: m.thread_id,
        bodyText: m.body,
        minResidualChars: threshold,
      }));
    }
    sweep[String(threshold)] = keys.size;
  }

  residualLengths.sort((a, b) => a - b);

  return {
    total_messages: total,
    // The collapsed scheme is a SINGLE literal for every gmail message, always — reported as
    // the measured baseline (1 if any messages present, 0 otherwise), not as an assumption.
    distinct_keys_collapsed: total > 0 ? 1 : 0,
    distinct_keys_derived: derivedKeysDefault.size,
    fallback_count: fallbackCount,
    fallback_reason_distribution: fallbackReasons,
    residual_length_distribution: {
      min: residualLengths.length ? residualLengths[0] : 0,
      p25: percentile(residualLengths, 0.25),
      median: percentile(residualLengths, 0.5),
      p75: percentile(residualLengths, 0.75),
      max: residualLengths.length ? residualLengths[residualLengths.length - 1] : 0,
    },
    residual_sweep_by_threshold: sweep,
  };
}

// ---------------------------------------------------------------------------
// Section 2: belief-correction accuracy
// ---------------------------------------------------------------------------

/** All of this harness's initial_status_fact strings follow this exact authored template. */
function entityNameFromInitialFact(initialFact) {
  const m = initialFact.match(/Application to (.+) is in status/);
  return m ? m[1] : 'Unknown Entity';
}

/**
 * Keyword heuristic used ONLY to script the dry-mode MockModelProvider's extraction response.
 * This is NOT a classifier the shipped engine ships — real runs get their intent_status from
 * the real LLM classification call (Phase 63), never from this function.
 */
function inferStatusFromBody(body) {
  const lower = body.toLowerCase();
  if (/regret|not selected|other candidates|declined|unfortunately/.test(lower)) return 'rejected';
  if (/excited to offer|pleased to offer|offer letter/.test(lower)) return 'offer';
  if (/interview/.test(lower)) return 'interviewing';
  return 'applied';
}

function parseDateMs(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? null : t;
}

/** Scenarios where every message in the case must route to 'hold', regardless of confidence. */
const HOLD_TARGET_SCENARIOS = new Set(['hold-single-ambiguous', 'forward-farm', 'quote-farm']);

function targetActionFor(caseObj, message) {
  if (message.intent_confidence === 'low') return 'hold';
  if (HOLD_TARGET_SCENARIOS.has(caseObj.scenario)) return 'hold';
  return 'reconcile';
}

/**
 * Compute a judge magnitude that, once divided by the CURRENT live candidate node's real
 * resistance (effective_s * c, queried live), lands deterministically in the requested band —
 * 'hold' (comfortably below peReconcileBandLow, safe under any confidence damping factor <= 1)
 * or 'reconcile' (just above peReconcileBandLow, safely below peReconcileBandHigh).
 */
function computeMagnitudeForAction(db, config, clock, action) {
  const row = db.prepare("SELECT s, c, last_access FROM node WHERE type = 'fact' AND tombstoned = 0").get();
  if (!row) throw new Error('drift-05 harness: expected exactly one live fact node before scripting a message pass');
  const effS = effectiveStrength(row.s, row.last_access, clock.nowMs(), config.lambda);
  const resistance = effS * row.c;
  const ratio = action === 'hold'
    ? config.peReconcileBandLow * 0.3
    : config.peReconcileBandLow + 0.05 * (config.peReconcileBandHigh - config.peReconcileBandLow);
  return Math.max(0.01, resistance * ratio);
}

function makeScratchDbPath(tag) {
  return path.join(os.tmpdir(), `drift05-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Classify the case's observed outcome from the LAST consolidation_event row tied to any of
 * its gmail episodes — mirrors status-drift.ts's own D-13 emission-eligibility predicate rather
 * than re-deriving a second classification rule. Returns 'unchanged' when no such row exists
 * (e.g. every message was dropped by the staleness guard). */
function classifyObservedOutcome(db) {
  const row = db.prepare(`
    SELECT event_type FROM consolidation_event
    WHERE episode_id IN (SELECT id FROM episode WHERE source = 'gmail')
    ORDER BY ts DESC
    LIMIT 1
  `).get();
  if (!row) return 'unchanged';
  if (isEmissionEligible(row.event_type)) return 'corrected';
  if (row.event_type === 'contradict_hold') return 'hold';
  return 'unchanged';
}

/** Sum the four DRIFT-65 counters and three RESOLVE-64 counters out of accumulated log lines. */
function parseCounters(logLines) {
  const drift = { evaluations: 0, damped: 0, staleDropped: 0, eventTsUnknown: 0 };
  const resolve = { attempts: 0, hits: 0, abstains: 0 };
  const driftRe = /DRIFT-65 evaluations=(\d+) damped=(\d+) staleDropped=(\d+) eventTsUnknown=(\d+)/;
  const resolveRe = /RESOLVE-64 attempts=(\d+) hits=(\d+) abstains=(\d+)/;
  for (const line of logLines) {
    const dm = driftRe.exec(line);
    if (dm) {
      drift.evaluations += Number(dm[1]);
      drift.damped += Number(dm[2]);
      drift.staleDropped += Number(dm[3]);
      drift.eventTsUnknown += Number(dm[4]);
    }
    const rm = resolveRe.exec(line);
    if (rm) {
      resolve.attempts += Number(rm[1]);
      resolve.hits += Number(rm[2]);
      resolve.abstains += Number(rm[3]);
    }
  }
  return { drift, resolve };
}

/** No-op SchemaInducer (mirrors tests/status-drift-wiring.test.ts): prevents LLM naming calls
 * during Phase C in the dry-mode path. */
function makeNoOpSchemaInducer(db, store, strength, retriever, config, clock) {
  return new SchemaInducer(
    db, store, strength, retriever,
    new MockModelProvider(),
    config, clock,
    async (_values) => 'no-op-schema',
  );
}

/**
 * DRY-mode case runner: Consolidator + a SCRIPTED MockModelProvider, one pass per message.
 * Tagged 'mock' in the output — this proves the harness plumbing runs with zero network, not
 * that the labeled accuracy number is real (see file header, T-65-10-MOCKNUM).
 */
async function runCaseDry(caseObj) {
  const dbPath = makeScratchDbPath(`dry-${caseObj.case_id}`);
  const db = new Database(dbPath);
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, clock, config);
  const store = new SemanticStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  const embedFn = (_text) => { const v = new Float32Array(8); v[0] = 1.0; return v; };
  const eventStore = new EventStore(db);
  const sink = new SQLiteConsolidationSink(eventStore, clock);
  const logLines = [];
  const log = (msg) => logLines.push(msg);

  async function pass(provider) {
    const inducer = makeNoOpSchemaInducer(db, store, strength, retriever, config, clock);
    const consolidator = new Consolidator(
      db, episodes, store, strength, retriever,
      provider, inducer, config, clock, sink, log,
    );
    await consolidator.consolidate();
  }

  try {
    // Pass 0: seed the initial belief via a plain conversation-sourced episode (no intent
    // fields — establishes the tracked entity's starting status via an ordinary confirm, zero
    // existing candidates).
    episodes.append({
      content: caseObj.initial_status_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: `drift05-${caseObj.case_id}-init`,
      source: 'conversation',
    });
    const initClaimJson = JSON.stringify([{ type: 'fact', value: caseObj.initial_status_fact }]);
    await pass(new MockModelProvider({ generateScript: [initClaimJson], embedFn, judgeScript: [] }));
    clock.advanceMs(1000);

    // Passes 1..N: one gmail-sourced message per pass, session_id set to the REAL derived
    // provenance key (never gated on provenanceDistinctnessEnabled — see file header).
    const entityName = entityNameFromInitialFact(caseObj.initial_status_fact);
    for (const message of caseObj.messages) {
      const sessionId = deriveGmailProvenanceKey({
        fromHeader: message.from,
        threadId: message.thread_id,
        bodyText: message.body,
        minResidualChars: config.provenanceMinResidualChars,
      });
      episodes.append({
        content: message.body,
        origin: 'observed',
        salience: 1.0,
        hard_keep: 1,
        role: 'user',
        session_id: sessionId,
        source: 'gmail',
        event_ts: parseDateMs(message.date),
      });

      const action = targetActionFor(caseObj, message);
      const magnitude = computeMagnitudeForAction(db, config, clock, action);
      const candidateRow = db.prepare("SELECT id FROM node WHERE type = 'fact' AND tombstoned = 0").get();
      const claimJson = JSON.stringify([{
        type: 'fact',
        value: `${entityName} status: ${inferStatusFromBody(message.body)}`,
        intent_status: inferStatusFromBody(message.body),
        intent_entity: entityName,
        intent_confidence: message.intent_confidence,
      }]);
      const verdict = { relation: 'contradict', best_candidate_id: candidateRow.id, magnitude };

      await pass(new MockModelProvider({ generateScript: [claimJson], embedFn, judgeScript: [verdict] }));
      clock.advanceMs(1000);
    }

    const observedOutcome = classifyObservedOutcome(db);
    const counters = parseCounters(logLines);

    return {
      case_id: caseObj.case_id,
      scenario: caseObj.scenario,
      expected_outcome: caseObj.expected_outcome,
      observed_outcome: observedOutcome,
      correct: observedOutcome === caseObj.expected_outcome,
      drift_counters: counters.drift,
      resolve_counters: counters.resolve,
    };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
    try { fs.unlinkSync(dbPath); } catch { /* best-effort */ }
  }
}

/**
 * REAL-mode case runner: every pass goes through `runConsolidation()` — the real
 * DefaultModelProvider stack (real Haiku/Sonnet classification + judging). This is the honest
 * measurement Task 3's checkpoint reviews; it requires real API keys and makes real API calls.
 */
async function runCaseReal(caseObj) {
  const dbPath = makeScratchDbPath(`real-${caseObj.case_id}`);
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, realClock, config);
  const logLines = [];
  const log = (msg) => logLines.push(msg);

  try {
    episodes.append({
      content: caseObj.initial_status_fact,
      origin: 'asserted_by_user',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: `drift05-${caseObj.case_id}-init`,
      source: 'conversation',
    });
    await runConsolidation(db, dbPath, process.env, log);

    for (const message of caseObj.messages) {
      const sessionId = deriveGmailProvenanceKey({
        fromHeader: message.from,
        threadId: message.thread_id,
        bodyText: message.body,
        minResidualChars: config.provenanceMinResidualChars,
      });
      episodes.append({
        content: message.body,
        origin: 'observed',
        salience: 1.0,
        hard_keep: 1,
        role: 'user',
        session_id: sessionId,
        source: 'gmail',
        event_ts: parseDateMs(message.date),
      });
      await runConsolidation(db, dbPath, process.env, log);
    }

    const observedOutcome = classifyObservedOutcome(db);
    const counters = parseCounters(logLines);

    return {
      case_id: caseObj.case_id,
      scenario: caseObj.scenario,
      expected_outcome: caseObj.expected_outcome,
      observed_outcome: observedOutcome,
      correct: observedOutcome === caseObj.expected_outcome,
      drift_counters: counters.drift,
      resolve_counters: counters.resolve,
    };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
    try { fs.unlinkSync(dbPath); } catch { /* best-effort */ }
  }
}

function sumCounters(results, key) {
  const totals = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r[key])) {
      totals[k] = (totals[k] || 0) + v;
    }
  }
  return totals;
}

function aggregateSection2(results, provider) {
  const perScenario = {};
  for (const r of results) {
    const bucket = perScenario[r.scenario] || (perScenario[r.scenario] = { total: 0, correct: 0 });
    bucket.total++;
    if (r.correct) bucket.correct++;
  }
  const correct = results.filter(r => r.correct).length;
  return {
    provider,
    total_cases: results.length,
    correct,
    accuracy: results.length ? +(correct / results.length).toFixed(3) : null,
    per_scenario: perScenario,
    drift_counters_total: sumCounters(results, 'drift_counters'),
    resolve_counters_total: sumCounters(results, 'resolve_counters'),
    per_case: results,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

(async () => {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));

  let inboxMessages = null;
  if (INBOX_PATH) {
    inboxMessages = fs.readFileSync(INBOX_PATH, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }
  const messageSource = inboxMessages ? 'inbox' : 'synthetic-cases';
  const messagesForSection1 = inboxMessages || cases.flatMap(c => c.messages);

  console.log('\nDRIFT-05 Harness — provenance-key distinctness + belief-correction accuracy');
  console.log(`Cases: ${cases.length} synthetic (${DRY_RUN ? '--dry-run' : 'full run'})`);
  console.log(`Section 1 message source: ${messageSource} (${messagesForSection1.length} messages)\n`);

  // ── Section 1: provenance-key distinctness (real, LLM-free, works in every mode) ──────────
  const section1 = analyzeProvenanceDistinctness(
    messagesForSection1,
    DEFAULT_CONFIG.provenanceMinResidualChars,
    SWEEP_RESIDUAL,
  );
  section1.message_source = messageSource;
  section1.real_inbox_used = inboxMessages !== null;

  console.log('=== Section 1: Provenance-Key Distinctness ===');
  console.log(`  Total messages:        ${section1.total_messages}`);
  console.log(`  Distinct (collapsed):  ${section1.distinct_keys_collapsed}`);
  console.log(`  Distinct (derived):    ${section1.distinct_keys_derived}`);
  console.log(`  Fallback count:        ${section1.fallback_count}`);
  console.log(`  Fallback reasons:      ${JSON.stringify(section1.fallback_reason_distribution)}`);
  console.log(`  Residual (non-ws) len: ${JSON.stringify(section1.residual_length_distribution)}`);
  console.log(`  Sweep (threshold->distinct): ${JSON.stringify(section1.residual_sweep_by_threshold)}`);

  // ── Section 2: belief-correction accuracy ──────────────────────────────────────────────────
  const results = [];
  for (const c of cases) {
    process.stdout.write(`  ... running case ${c.case_id} (${DRY_RUN ? 'mock' : 'live'})...\r`);
    results.push(DRY_RUN ? await runCaseDry(c) : await runCaseReal(c));
  }
  const section2 = aggregateSection2(results, DRY_RUN ? 'mock' : 'live');

  console.log('\n\n=== Section 2: Belief-Correction Accuracy ===');
  console.log(`  Provider:   ${section2.provider}`);
  console.log(`  Accuracy:   ${section2.correct}/${section2.total_cases} (${section2.accuracy === null ? 'n/a' : (section2.accuracy * 100).toFixed(1) + '%'})`);
  console.log(`  Drift counters (total): ${JSON.stringify(section2.drift_counters_total)}`);
  console.log(`  Resolve counters (total): ${JSON.stringify(section2.resolve_counters_total)}`);
  for (const [scenario, s] of Object.entries(section2.per_scenario)) {
    console.log(`    ${scenario.padEnd(28)} ${s.correct}/${s.total}`);
  }

  // ── Section 3: methodology (embedded in the output JSON itself, per D-15) ─────────────────
  const methodology = {
    what_was_measured:
      'Section 1 measures how many distinct provenance keys today\'s collapsed session_id ' +
      'produces (always 1) versus the DRIFT-03 redesigned derivation, over a residual-threshold ' +
      'sweep, with a fallback-reason breakdown. Section 2 measures belief-correction accuracy ' +
      'against a labeled synthetic case set covering hold, release, forwarding/quoting-farm, ' +
      'out-of-order backfill, chronological control, and undated-evidence scenarios.',
    case_count: cases.length,
    real_inbox_included: inboxMessages !== null,
    real_inbox_message_count: inboxMessages ? inboxMessages.length : 0,
    config_used: {
      contradictionNBySource: DEFAULT_CONFIG.contradictionNBySource,
      provenanceDistinctnessEnabled: DEFAULT_CONFIG.provenanceDistinctnessEnabled,
      provenanceMinResidualChars: DEFAULT_CONFIG.provenanceMinResidualChars,
      statusDriftEnabled: DEFAULT_CONFIG.statusDriftEnabled,
      statusDriftConfidenceDamping: DEFAULT_CONFIG.statusDriftConfidenceDamping,
      statusDriftEventTsGuard: DEFAULT_CONFIG.statusDriftEventTsGuard,
    },
    what_this_does_not_cover:
      'The synthetic case set uses obviously-synthetic domains and short, unambiguous email ' +
      'bodies — real inbox threads are messier (longer quote chains, mixed HTML-to-text ' +
      'artifacts, non-English content, multi-recipient CCs). Section 2\'s dry-mode accuracy ' +
      'number is a plumbing proof only (provider:"mock", scripted classification), not a real ' +
      'measurement — only a --dry-run-absent run against real ANTHROPIC_API_KEY/OPENAI_API_KEY ' +
      'and, ideally, a real --inbox export produces a number that should inform the enablement ' +
      'decision. The cross-run out-of-order guard (D-11b) is exercised directly; the ' +
      'within-pass backfill sort (D-11a) is covered by existing episode-order tests, not here.',
    no_external_bar:
      'This measurement is offered on its own terms: no external accuracy bar exists for this ' +
      'feature class — no competitor publishes a methodology-disclosed number for ' +
      'email-to-status classification — so no comparison is offered and none should be inferred.',
  };

  const resultEnvelope = {
    meta: {
      eval: 'drift-05',
      date: new Date().toISOString(),
      dry_run: DRY_RUN,
    },
    provenance_distinctness: section1,
    belief_correction: section2,
    methodology,
  };

  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(resultEnvelope, null, 2));
  console.log(`\nResults written -> ${OUT}`);
})();
