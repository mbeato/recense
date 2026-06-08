/**
 * eval-snapshot: record/replay engine for SEAM-03 regression detection (D-51/D-52/D-53).
 *
 * recordSnapshot: captures a query → expected-answer pair as a curated regression anchor
 * (D-51) — the expected_answer is the human-blessed value from the deterministic,
 * LLM-free retrieval path (D-52).
 *
 * replaySnapshots: re-runs each snapshot query against the current retrieval engine and
 * reports match/regression via embedding-similarity ≥ τ (snapshotMatchThreshold, D-53).
 *
 * Design invariants:
 *  - Gate target is the LLM-free retrieval path (D-52); ZERO Level-3 code — no LLM inference.
 *  - All embed awaits resolve before result-assembly loop (async-before-sync discipline;
 *    no await inside any DB transaction).
 *  - cosineSimF32 from retrieval/topk for the τ match (D-53).
 *  - Prepared statements compiled per-call (acceptable: each function is called once per
 *    CLI invocation; the RetrievalEngine prepares its own hot-path statements).
 *
 * Threat mitigations:
 *  - T-05-SNAP-I: query/expectedAnswer are passed as prepared-statement bind params only —
 *    never interpolated into a SQL or shell string.
 */
import type Database from 'better-sqlite3';
import type { EngineConfig } from '../lib/config';
import { newId } from '../lib/hash';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { CandidateRetriever, cosineSimF32 } from '../retrieval/topk';
import { StrengthDecayManager } from '../strength/decay';
import { AllocationGate } from '../gate/allocation-gate';
import { RetrievalEngine } from '../retrieval/engine';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecordSnapshotParams {
  /** The query text being snapshotted (treated as data, not code). */
  query: string;
  /** The human-blessed expected answer from the LLM-free retrieval path (D-51). */
  expectedAnswer: string;
  /** Snapshot timestamp (ms since epoch). Caller controls the clock (D-12). */
  ts: number;
  /** Optional session id for provenance tracking. */
  sessionId?: string;
}

export interface SnapshotResult {
  /** eval_snapshot row id. */
  id: string;
  /** Original query text. */
  query: string;
  /** Blessed expected answer at record time. */
  expected: string;
  /** Answer returned by the current retrieval engine on replay. */
  actual: string;
  /** cosineSimF32(expected_embed, actual_embed). */
  cosine: number;
  /** true when cosine ≥ config.snapshotMatchThreshold (D-53). */
  match: boolean;
}

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface SnapshotRow {
  id: string;
  ts: number;
  query: string;
  expected_answer: string;
  created_session: string | null;
}

// ---------------------------------------------------------------------------
// recordSnapshot
// ---------------------------------------------------------------------------

/**
 * Insert one eval_snapshot row with a new UUID id.
 *
 * Returns the inserted id. Uses a prepared statement for bound-param insertion
 * (T-05-SNAP-I: query/expectedAnswer are data, not SQL fragments).
 */
export function recordSnapshot(
  db: Database.Database,
  params: RecordSnapshotParams,
): string {
  const id = newId();
  const stmt = db.prepare(
    `INSERT INTO eval_snapshot (id, ts, query, expected_answer, created_session)
     VALUES (?, ?, ?, ?, ?)`
  );
  stmt.run(
    id,
    params.ts,
    params.query,
    params.expectedAnswer,
    params.sessionId ?? null,
  );
  return id;
}

// ---------------------------------------------------------------------------
// replaySnapshots
// ---------------------------------------------------------------------------

/**
 * Replay all eval_snapshot rows against the current deterministic retrieval path (D-52).
 *
 * For each snapshot:
 *  1. embed([query]) → queryVec (batched with all other queries)
 *  2. engine.retrieve(queryVec) → current answer (LLM-free, D-52)
 *  3. embed([expected_answer, current_answer]) → pair (batched)
 *  4. cosineSimF32(expectedVec, currentVec) — match when ≥ τ (D-53)
 *
 * Async-before-sync discipline: ALL embed awaits resolve before the result-assembly
 * loop — no await inside any DB-access block (better-sqlite3 is synchronous).
 *
 * Returns an array of SnapshotResult. Empty when no snapshots exist.
 */
export async function replaySnapshots(
  db: Database.Database,
  embed: (texts: string[]) => Promise<Float32Array[]>,
  config: EngineConfig,
): Promise<SnapshotResult[]> {
  // ── 0. Read all snapshot rows (sync) ────────────────────────────────────
  const rows = db.prepare('SELECT * FROM eval_snapshot ORDER BY ts ASC').all() as SnapshotRow[];
  if (rows.length === 0) return [];

  // ── 1. Build the LLM-free retrieval engine (D-52) ───────────────────────
  // Construct deps here rather than in the caller so the function signature
  // stays minimal: (db, embed, config). realClock is correct for production;
  // tests use a mock embed and don't exercise time-dependent scoring.
  const store    = new SemanticStore(db, realClock, config);
  const retriever = new CandidateRetriever(db);
  const strength = new StrengthDecayManager(db, realClock, config);
  const gate     = new AllocationGate(config);
  const engine   = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate);

  // ── 2. Async-before-sync: batch embed all query texts first ─────────────
  const queryTexts = rows.map(r => r.query);
  const queryVecs  = await embed(queryTexts);

  // ── 3. Sync: retrieve current answers via the LLM-free path (D-52) ──────
  const currentAnswers: string[] = rows.map((_row, i) => {
    const qv = queryVecs[i];
    if (!qv) return '';
    const result = engine.retrieve(qv);
    return result.results[0]?.value ?? '';
  });

  // ── 4. Async-before-sync: batch embed [expected, actual] pairs ───────────
  const compareTexts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    compareTexts.push(rows[i]!.expected_answer);
    compareTexts.push(currentAnswers[i]!);
  }
  const compareVecs = await embed(compareTexts);

  // ── 5. Assemble results (pure sync) ─────────────────────────────────────
  return rows.map((row, i) => {
    const expectedVec = compareVecs[i * 2];
    const actualVec   = compareVecs[i * 2 + 1];
    const cosine = (expectedVec && actualVec)
      ? cosineSimF32(expectedVec, actualVec)
      : 0;
    return {
      id:       row.id,
      query:    row.query,
      expected: row.expected_answer,
      actual:   currentAnswers[i]!,
      cosine,
      match:    cosine >= config.snapshotMatchThreshold,
    };
  });
}
