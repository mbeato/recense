/**
 * remember-cli — recense remember "<fact>" [--scope <s>] [--db <path>] (Phase 33, Plan 33-01).
 *
 * Synchronous, verbatim, curated WRITE path. Stores the fact BYTE-FOR-BYTE as a curated
 * node (origin=asserted_by_user, high resistance seed), then runs a synchronous "mini
 * sleep-pass": embed → top-k neighbor retrieve → judge contradiction → in-place update
 * on contradiction, else insert. This in-place reconsolidation is the differentiator vs
 * appending to a flat file.
 *
 * Design invariants:
 *  D-01  Auto-apply + report-after: applies the update immediately, then prints what changed.
 *  D-03  High-resistance seeding: s=0.9, c=0.95 → resistance ≈ 0.85; passive observed
 *        contradictions (PE ~0.3–0.5) ratio < peReconcileBandLow → HOLD (passive shielded).
 *  D-04  Force-reconcile: an explicit remember contradiction ALWAYS at least reconciles —
 *        even if routeContradiction returns 'hold' (the D-03 high resistance would block it).
 *        Applied at the call site, NOT by mutating routeContradiction.
 *  D-05  Decay/eviction exempt: live (tombstoned=0) node is intrinsically eviction-immune;
 *        no new node column needed. The sleep pass extracts from episodes, not node rows
 *        directly — so a curated node is never re-extracted/mangled.
 *
 * Safety invariants:
 *  WR-02  Validate DB path BEFORE acquireLock — process.exit() with the lock held leaks it.
 *  T-33-01 Lock fast-fails; on false print "lock held — try again" + process.exit(0).
 *  T-33-02 Resolve best_candidate_id via store.getNode; if null/tombstoned → INSERT path.
 *  T-33-04 D-04 force-reconcile guarantees an explicit contradiction always lands.
 *
 * Threat mitigations:
 *  T-33-01 concurrent sleep pass → acquireLock fast-fails; no partial write, no corruption.
 *  T-33-02 hallucinated best_candidate_id → getNode null-check → INSERT fallback.
 *  T-33-04 D-01 preview makes the in-place update visible, never silent.
 *
 * Entry point:
 *  - Spawned by recense.ts dispatcher (`recense remember "<fact>" [--scope <s>] [--db PATH]`)
 *  - `require.main === module` guard: never auto-runs when imported by unit tests.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG, type EngineConfig } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { EventStore } from '../db/event-store';
import { SQLiteConsolidationSink } from '../consolidation/sink';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
import { cwdToScope } from '../lib/scope';
import { DefaultModelProvider } from '../model/provider';
import { CandidateRetriever } from '../retrieval/topk';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';
import { routeContradiction, isOscillation } from '../consolidation/update-decision';
import { newId, sha256 } from '../lib/hash';
import { StrengthDecayManager } from '../strength/decay';

const LOG_PATH = '/tmp/recense-remember.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] remember: ${msg}\n`);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * D-03 high-resistance seed values for curated facts.
 *
 * Fresh-node defaults are s=0.1, c=0.5 → resistance = effectiveStrength(0.1,…)*0.5 ≈ 0.05,
 * which is far too weak — any moderate PE magnitude would overwrite a curated fact.
 *
 * With s=0.9, c=0.95: resistance ≈ effectiveStrength(0.9, now, now, λ)*0.95 = 0.9*0.95 ≈ 0.855.
 * A passive observed contradiction (typical PE magnitude ~0.3–0.5) → ratio = 0.4/0.855 ≈ 0.47.
 * If peReconcileBandLow ≈ 0.5 (DEFAULT_CONFIG), ratio < peReconcileBandLow → HOLD (D-03 passive
 * direction shielded). An EXPLICIT remember force-reconciles regardless (D-04).
 * These two directions are deliberately asymmetric.
 */
const SEED_S = 0.9;
const SEED_C = 0.95;

/**
 * Top-k neighbor count for the mini judge pass.
 *
 * Rationale: 8 is enough to surface a contradicting belief without flooding the judge;
 * the sleep pass uses config.candidateK (typically 10–20) for a full batch pass.
 * A single explicit `remember` judges one claim against at most 8 neighbors — acceptable
 * latency (~2–5s for one judge call on the subscription-billed headless Sonnet).
 */
const REMEMBER_K = 8;

/**
 * Cosine floor for neighbor nomination.
 *
 * Matches the consolidator's `unrelatedSimilarityThreshold` per the Phase-26 lesson:
 * contradictions sit at ~0.48 cosine, well above 0.30 floor.
 * Do NOT raise this threshold — raising it is a documented TRAP (cosine-weakness lesson:
 * the weakness is threshold/cue-shape-bound, not the embedder; real contradictions sit
 * at ~0.48 which is safely above 0.30 but would be filtered by any threshold ≥ 0.50).
 */
const NEIGHBOR_COSINE_FLOOR = 0.30;

// ---------------------------------------------------------------------------
// Exported helpers (for unit tests — the CLI imports these in isolation)
// ---------------------------------------------------------------------------

export interface RememberArgs {
  fact: string;
  scope?: string;
  dbPath?: string;
}

/**
 * Parse `remember` argv into structured args.
 * The fact is the first non-flag, non-flag-value positional argument starting at argv[2]
 * (because `remember-cli` is spawned with `process.argv.slice(3)` from the dispatcher,
 * so argv[2] here = the original argv[3] = `"<fact>"`).
 *
 * Exported for unit tests.
 */
export function parseRememberArgs(argv: string[]): RememberArgs | null {
  let fact: string | undefined;
  let scope: string | undefined;
  let dbPath: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--scope' || arg === '-s') {
      scope = argv[++i];
    } else if (arg === '--db') {
      dbPath = argv[++i];
    } else if (arg && !arg.startsWith('-')) {
      if (fact === undefined) fact = arg;
    }
  }

  if (!fact) return null;
  return { fact: fact.trim(), scope, dbPath };
}

// ---------------------------------------------------------------------------
// Core reconsolidation logic (exported for unit tests)
// ---------------------------------------------------------------------------

export interface RememberResult {
  action: 'insert' | 'reconcile' | 'oscillation';
  newNodeId: string;
  supersededNodeId?: string;
  prevValue?: string;
  scope: string;
}

/**
 * Run the synchronous mini-pass: embed → top-k → judge → route/force-reconcile → apply.
 *
 * All async work (embed, judge) happens BEFORE the db.transaction.
 * The transaction itself is synchronous (no await inside — better-sqlite3 is sync).
 *
 * Exported for unit tests (inject a stub provider and retriever).
 */
export async function runRemember(
  db: Database.Database,
  store: SemanticStore,
  sink: SQLiteConsolidationSink,
  strength: StrengthDecayManager,
  clock: { nowMs(): number },
  config: EngineConfig,
  provider: {
    embed(texts: string[]): Promise<Float32Array[]>;
    judge(
      claim: string,
      candidates: Array<{ id: string; value: string }>,
    ): Promise<{ best_candidate_id: string | null; relation: string; magnitude: number }>;
  },
  retriever: { topk(queryVec: Float32Array, k: number): Array<{ id: string; score: number }> },
  verbatimText: string,
  resolvedScope: string,
): Promise<RememberResult> {
  // ── T-33-02: Idempotency guard — short-circuit if a byte-identical live node exists ──
  // SHA-256 hash of the verbatim text matches value_hash on the node row.
  const existingHash = sha256(verbatimText);
  const existingRow = (db
    .prepare(
      `SELECT id FROM node WHERE value_hash = ? AND tombstoned = 0 LIMIT 1`,
    )
    .get(existingHash)) as { id: string } | undefined;

  if (existingRow) {
    // Already stored verbatim — no-op (idempotent re-insert guard)
    process.stdout.write(`already stored [${resolvedScope}]\n  "${verbatimText}"\n`);
    return { action: 'insert', newNodeId: existingRow.id, scope: resolvedScope };
  }

  // ── Phase A: async work BEFORE the transaction ──────────────────────────────
  const embedResults = await provider.embed([verbatimText]);
  const qvec = embedResults[0];
  if (!qvec) throw new Error('embed returned empty results');

  // Retrieve top-k neighbors, apply cosine floor, drop tombstoned and self-matches
  const neighbors = retriever.topk(qvec, REMEMBER_K).filter(n => n.score >= NEIGHBOR_COSINE_FLOOR);

  // Build candidates: resolve each neighbor → {id, value}, drop tombstoned/missing
  const candidates: Array<{ id: string; value: string }> = [];
  for (const n of neighbors) {
    const node = store.getNode(n.id);
    if (!node || node.tombstoned) continue;
    if (node.value_hash === existingHash) continue; // skip self-match by value
    candidates.push({ id: n.id, value: node.value });
  }

  let verdict: { best_candidate_id: string | null; relation: string; magnitude: number } | null = null;
  if (candidates.length > 0) {
    verdict = await provider.judge(verbatimText, candidates);
  }

  // ── Phase B: synchronous transaction (no await inside) ───────────────────────
  let result!: RememberResult;

  db.transaction(() => {
    const now = clock.nowMs();

    if (!verdict || verdict.relation !== 'contradict' || !verdict.best_candidate_id) {
      // ── INSERT path: no neighbors, or judge didn't find a contradiction ──────
      const newNodeId = newId();
      store.upsertNode({
        id: newNodeId,
        type: 'fact',
        value: verbatimText,
        origin: 'asserted_by_user',
        s: SEED_S,
        c: SEED_C,
      });
      sink.emit({
        event_type: 'unrelated',
        node_id: newNodeId,
        candidate_id: null,
        episode_id: null,
        value: verbatimText,
        origin: 'asserted_by_user',
        magnitude: 0,
      });
      result = { action: 'insert', newNodeId, scope: resolvedScope };
    } else {
      // ── CONTRADICT path ───────────────────────────────────────────────────────
      // T-33-02: resolve the superseded node; fall through to INSERT if null/tombstoned
      const supersededNode = store.getNode(verdict.best_candidate_id);
      if (!supersededNode || supersededNode.tombstoned) {
        // Judge returned a bad/tombstoned id — treat as unrelated INSERT
        const newNodeId = newId();
        store.upsertNode({
          id: newNodeId,
          type: 'fact',
          value: verbatimText,
          origin: 'asserted_by_user',
          s: SEED_S,
          c: SEED_C,
        });
        sink.emit({
          event_type: 'unrelated',
          node_id: newNodeId,
          candidate_id: null,
          episode_id: null,
          value: verbatimText,
          origin: 'asserted_by_user',
          magnitude: 0,
        });
        result = { action: 'insert', newNodeId, scope: resolvedScope };
        return;
      }

      // Compute D-16 resistance = effective_s * c
      const effectiveS = strength.effectiveStrength(
        supersededNode.s,
        supersededNode.last_access,
        now,
        config.lambda,
      );
      const resistance = effectiveS * supersededNode.c;

      // Route by PE magnitude / resistance (spec §4 step 3, D-15/D-16)
      let action = routeContradiction(verdict.magnitude, resistance, config);

      // D-04 force-reconcile: an explicit remember MUST always at least reconcile —
      // even if routeContradiction returns 'hold' (high resistance from D-03 seed would
      // block a passive contradiction, but an explicit user assertion must land).
      if (action === 'hold') {
        action = 'reconcile';
      }

      // D-20 oscillation guard: flip-back → append-new (mint standalone, no tombstone)
      if (action === 'reconcile' && isOscillation(verbatimText, supersededNode.prev_value)) {
        const oscId = newId();
        store.upsertNode({
          id: oscId,
          type: 'fact',
          value: verbatimText,
          origin: 'asserted_by_user',
          s: SEED_S,
          c: SEED_C,
        });
        sink.emit({
          event_type: 'contradict_oscillation',
          node_id: oscId,
          candidate_id: supersededNode.id,
          episode_id: null,
          value: verbatimText,
          origin: 'asserted_by_user',
          magnitude: verdict.magnitude,
        });
        result = {
          action: 'oscillation',
          newNodeId: oscId,
          supersededNodeId: supersededNode.id,
          prevValue: supersededNode.value,
          scope: resolvedScope,
        };
        return;
      }

      if (action === 'reconcile') {
        // Mid-band reconcile (tombstone old + mint new current):
        //   1. Tombstone the superseded node.
        //   2. Mint a new node with verbatim value + prev_value breadcrumb (D-20).
        store.tombstone(supersededNode.id);
        const reconciledId = newId();
        store.upsertNode({
          id: reconciledId,
          type: 'fact',
          value: verbatimText,
          origin: 'asserted_by_user',
          s: SEED_S,
          c: SEED_C,
          prev_value: supersededNode.value, // explicit one-deep breadcrumb (D-20)
        });
        sink.emit({
          event_type: 'contradict_reconcile',
          node_id: reconciledId,
          candidate_id: supersededNode.id,
          episode_id: null,
          value: verbatimText,
          origin: 'asserted_by_user',
          magnitude: verdict.magnitude,
        });
        result = {
          action: 'reconcile',
          newNodeId: reconciledId,
          supersededNodeId: supersededNode.id,
          prevValue: supersededNode.value,
          scope: resolvedScope,
        };
      } else {
        // action === 'append-new' (should not reach here after D-04 override, but be safe)
        const appendId = newId();
        store.upsertNode({
          id: appendId,
          type: 'fact',
          value: verbatimText,
          origin: 'asserted_by_user',
          s: SEED_S,
          c: SEED_C,
        });
        sink.emit({
          event_type: 'unrelated',
          node_id: appendId,
          candidate_id: null,
          episode_id: null,
          value: verbatimText,
          origin: 'asserted_by_user',
          magnitude: 0,
        });
        result = { action: 'insert', newNodeId: appendId, scope: resolvedScope };
      }
    }
  }).immediate();

  // ── After the transaction: stamp node_scope + set embedding ─────────────────
  // Do NOT use stampNodeScopes (joins through episode.cwd — no episode here).
  // Call upsertNodeScope directly (D-10, idempotent INSERT OR REPLACE).
  store.upsertNodeScope({
    node_id: result.newNodeId,
    scope: resolvedScope,
    updated_at: clock.nowMs(),
  });

  // Set the embedding on the new node (so it's retrievable in future queries).
  // Capture value_hash from getNode to close the stale race (L-1 guard).
  const newNode = store.getNode(result.newNodeId);
  if (newNode?.value_hash) {
    store.setEmbedding(result.newNodeId, qvec, newNode.value_hash);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv;

  // ── Parse args ───────────────────────────────────────────────────────────────
  const args = parseRememberArgs(argv);
  if (!args) {
    process.stderr.write(
      'Usage: recense remember "<fact>" [--scope <scope>] [--db <path>]\n' +
      'Stores a verbatim curated fact with in-place reconsolidation.\n',
    );
    process.exit(0);
  }

  const verbatimText = args.fact;

  // ── WR-02: Validate DB path BEFORE acquiring the lock ────────────────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense remember: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // ── T-33-01: Acquire write lock (fast-fail, no queue) ────────────────────────
  if (!acquireLock()) {
    process.stderr.write(
      'recense remember: Lock held by another process (sleep pass running?) — try again — exiting\n',
    );
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog(`remember starting: fact="${verbatimText.slice(0, 60)}..."`);

    db = new Database(dbPath);
    initSchema(db);
    const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);
    const eventStore = new EventStore(db);
    const sink = new SQLiteConsolidationSink(eventStore, realClock);
    const strength = new StrengthDecayManager(db, realClock, config);
    const retriever = new CandidateRetriever(db);

    // Build the judge provider (mirror run-sleep-pass.ts:291,305-309)
    const judgeConfig: EngineConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };
    const provider = new DefaultModelProvider({
      generateConfig: judgeConfig,
      judgeConfig,
      embedConfig: config,
    });

    // Resolve scope: --scope <s> wins, else derive from process.cwd()
    const resolvedScope = args.scope ?? cwdToScope(process.cwd());

    const result = await runRemember(
      db, store, sink, strength, realClock, config,
      provider, retriever, verbatimText, resolvedScope,
    );

    // ── D-01 output contract ──────────────────────────────────────────────────
    if (result.action === 'insert') {
      process.stdout.write(`✓ stored [${result.scope}]\n  "${verbatimText}"\n`);
    } else if (result.action === 'reconcile') {
      process.stdout.write(
        `✓ reconsolidated [${result.scope}]\n` +
        `  updated: "${result.prevValue}" → "${verbatimText}"\n` +
        `  (was tombstoned; 1 neighbor judged, PE=reconcile)\n`,
      );
    } else if (result.action === 'oscillation') {
      process.stdout.write(
        `✓ stored [${result.scope}] (oscillation — both values coexist)\n  "${verbatimText}"\n`,
      );
    }

    fileLog(`done: action=${result.action} newNodeId=${result.newNodeId}`);
  } catch (err) {
    fileLog(`error: ${err}`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (dispatched via recense.ts subprocess),
// NOT when imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] remember FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
