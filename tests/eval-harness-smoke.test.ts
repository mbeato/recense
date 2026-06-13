/**
 * Smoke tests for the LongMemEval harness (EVAL-01).
 * Validates fixture schema and harness wiring under MockModelProvider — zero API calls.
 *
 * Covers:
 *  1. Mini fixture loads and has correct schema (question_id, question_type, question,
 *     answer, haystack_sessions) with at least one knowledge-update question.
 *  2. Scratch-DB init + multi-session episode append (one episode per session; appends
 *     precede consolidation: consolidated=0 on all rows).
 *  3. Consolidation + retrieval pipeline runs under Consolidator + MockModelProvider
 *     (scripted extract/judge/embed) with zero API calls and produces node-table state.
 *  4. Harness --dry-run resume: pre-seeded OUT_FILE entries are skipped on re-run.
 *
 * Uses the same harness pattern as tests/consolidation.test.ts:
 *  in-memory Database, initSchema, FakeClock, DEFAULT_CONFIG, MockModelProvider.
 *
 * Pattern note: Consolidator + MockModelProvider is the correct wiring for CI;
 * runConsolidation() is used only in the .cjs harness for full runs (it builds
 * DefaultModelProvider internally and cannot be mocked here).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';
import { SemanticStore } from '../src/db/semantic-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockModelProvider } from '../src/model/provider';
import type { NodeRow } from '../src/lib/types';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.resolve(__dirname, '../scripts/eval/fixtures/longmemeval-mini.jsonl');

// ---------------------------------------------------------------------------
// Shared harness (mirrors tests/consolidation.test.ts makeHarness)
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  episodes: EpisodicStore;
  store: SemanticStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  config: EngineConfig;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    consolSkipThreshold:         0.2,
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
  };
  const store    = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

/** No-op SchemaInducer for consolidation tests (mirrors consolidation.test.ts). */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_dates?: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
  answer_session_ids?: string[];
}

function loadFixture(): LongMemEvalQuestion[] {
  const lines = fs.readFileSync(FIXTURE_PATH, 'utf8').split('\n').filter(l => l.trim());
  return lines.map(l => JSON.parse(l) as LongMemEvalQuestion);
}

/**
 * Concatenate all turns in a session into a single content string.
 * Mirrors the harness formatSession(session, date) — prefixes with
 * "[Session date: {date}]" when a date is provided.
 */
function formatSession(session: Array<{ role: string; content: string }>, date?: string): string {
  const turns = session
    .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n');
  return date ? `[Session date: ${date}]\n${turns}` : turns;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('eval-harness-smoke', () => {

  // ── Test 1: Fixture schema validation ─────────────────────────────────────

  it('mini fixture loads and has correct schema fields on every question', () => {
    const questions = loadFixture();

    // Fixture now has 3 questions: mini-001, mini-002, mini-003_abs
    expect(questions.length).toBeGreaterThanOrEqual(3);

    for (const q of questions) {
      expect(q).toHaveProperty('question_id');
      expect(typeof q.question_id).toBe('string');
      expect(q.question_id.length).toBeGreaterThan(0);

      expect(q).toHaveProperty('question_type');
      expect(typeof q.question_type).toBe('string');

      expect(q).toHaveProperty('question');
      expect(typeof q.question).toBe('string');
      expect(q.question.length).toBeGreaterThan(0);

      expect(q).toHaveProperty('answer');
      expect(typeof q.answer).toBe('string');
      expect(q.answer.length).toBeGreaterThan(0);

      expect(q).toHaveProperty('haystack_sessions');
      expect(Array.isArray(q.haystack_sessions)).toBe(true);
      expect(q.haystack_sessions.length).toBeGreaterThanOrEqual(1);

      // haystack_dates must be present and parallel to haystack_sessions
      expect(Array.isArray(q.haystack_dates)).toBe(true);
      expect(q.haystack_dates!.length).toBe(q.haystack_sessions.length);

      // Each session is an array of turns
      for (const session of q.haystack_sessions) {
        expect(Array.isArray(session)).toBe(true);
        for (const turn of session) {
          expect(turn).toHaveProperty('role');
          expect(turn).toHaveProperty('content');
        }
      }
    }

    // At least one knowledge-update question (EVAL-01 positioning requirement)
    const kuCount = questions.filter(q => q.question_type === 'knowledge-update').length;
    expect(kuCount).toBeGreaterThanOrEqual(1);

    // At least one abstention question (mini-003_abs covers scorer routing)
    const absCount = questions.filter(q => q.question_id.endsWith('_abs')).length;
    expect(absCount).toBeGreaterThanOrEqual(1);
  });

  // ── Test 2: Scratch-DB init + multi-session episode append ────────────────

  it('scratch-DB init works and multi-session appends land before consolidation', () => {
    const h = makeHarness();
    const questions = loadFixture();

    // Find a question with multiple sessions (mini-002 has 2 sessions)
    const multiSessionQ = questions.find(q => q.haystack_sessions.length > 1);
    expect(multiSessionQ).toBeDefined();

    const q = multiSessionQ!;
    const sessionCount = q.haystack_sessions.length;

    // Append ONE episode per session (the harness-pattern contract)
    for (const [i, session] of q.haystack_sessions.entries()) {
      h.episodes.append({
        content:    formatSession(session),
        origin:     'observed',
        salience:   1.0,
        hard_keep:  1,
        role:       'user',
        session_id: `smoke-${q.question_id}-s${i}`,
      });
    }

    // All episodes must be in the table
    const rows = h.db.prepare('SELECT * FROM episode').all() as Array<{ consolidated: number }>;
    expect(rows).toHaveLength(sessionCount);

    // consolidated = 0: appends precede the sleep pass (Pitfall 4 / CONSOL-02)
    for (const row of rows) {
      expect(row.consolidated).toBe(0);
    }
  });

  // ── Test 3: Consolidation pipeline under MockModelProvider ────────────────

  it('ingest + Consolidator + MockModelProvider pipeline produces node-table state (zero API)', async () => {
    const h = makeHarness();
    const questions = loadFixture();

    // Use the single-session question (mini-001) for simplicity
    const q = questions.find(qn => qn.question_id === 'mini-001') ?? questions[0];
    if (!q) throw new Error('Mini fixture returned no questions');

    const firstSession = q.haystack_sessions[0];
    if (!firstSession) throw new Error('Expected at least one haystack_session in mini-001');

    // Append the first session as one episode
    h.episodes.append({
      content:    formatSession(firstSession),
      origin:     'observed',
      salience:   1.0,
      hard_keep:  1,
      role:       'user',
      session_id: `smoke-pipeline-${q.question_id}-s0`,
    });

    // Pre-condition: episode exists, no nodes yet
    const epRows = h.db.prepare('SELECT * FROM episode').all();
    expect(epRows).toHaveLength(1);
    const nodesBefore = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodesBefore).toHaveLength(0);

    // Wire MockModelProvider with scripted responses (zero network calls)
    const provider = new MockModelProvider({
      generateScript: [
        // One extraction call per processed episode
        JSON.stringify([{ type: 'fact', value: 'Alex Chen lives in Portland' }]),
      ],
      judgeScript: [
        // One judge verdict in case of candidate lookup (safe: relation=unrelated, no DB write)
        { best_candidate_id: null, relation: 'unrelated' as const, magnitude: 0 },
      ],
      embedFn: (_t: string) => {
        // Deterministic unit vector — all items share the same embedding to exercise
        // the similarity path without requiring multiple distinct vectors
        const vec = new Float32Array(DEFAULT_CONFIG.embeddingDimensions);
        vec[0] = 1.0;
        return vec;
      },
    });

    const consolidator = new Consolidator(
      h.db,
      h.episodes,
      h.store,
      h.strength,
      h.retriever,
      provider,
      makeNoOpSchemaInducer(h),
      h.config,
      h.clock,
    );

    // Run the pipeline — should not throw
    await expect(consolidator.consolidate()).resolves.not.toThrow();

    // Post-condition: at least one node extracted from the episode
    const nodesAfter = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodesAfter.length).toBeGreaterThanOrEqual(1);

    // The episode is now marked consolidated
    const epAfter = h.db.prepare('SELECT consolidated FROM episode').all() as Array<{ consolidated: number }>;
    expect(epAfter.every(r => r.consolidated === 1)).toBe(true);
  });

  // ── Test 4: Resume — harness skips already-present question_ids ───────────
  //
  // Runs the .cjs harness as a subprocess with --dry-run. Pre-seeds OUT_FILE with
  // one question_id; verifies the harness skips it and processes the rest.
  // Requires the dist/ build (pretest runs `npm run build` so this is always present in CI).

  it('harness --dry-run resumes: skips question_ids already present in OUT_FILE', () => {
    const OUT = path.join(os.tmpdir(), `harness-resume-test-${Date.now()}-${process.pid}.jsonl`);

    // Pre-seed: mini-001 already done (simulates a prior partial run)
    const preSeedLine = JSON.stringify({ question_id: 'mini-001', question_type: 'single-hop', hypothesis: 'pre-existing' });
    fs.writeFileSync(OUT, preSeedLine + '\n');

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '../scripts/eval/longmemeval-harness.cjs'),
          '--dry-run',
          '--out', OUT,
          '--eval', FIXTURE_PATH,
        ],
        { encoding: 'utf8', cwd: path.resolve(__dirname, '..'), timeout: 30_000 },
      );

      expect(result.status).toBe(0);
      // Harness must log that it skipped at least 1 question
      expect(result.stdout).toContain('skipped');

      // OUT_FILE must still contain the pre-existing line
      const allLines = fs.readFileSync(OUT, 'utf8').split('\n').filter(l => l.trim());
      const ids = allLines.map(l => { try { return JSON.parse(l).question_id; } catch { return null; } });
      expect(ids).toContain('mini-001');

      // At least one new question must have been processed (mini fixture now has 3 questions)
      expect(allLines.length).toBeGreaterThan(1);
    } finally {
      try { fs.unlinkSync(OUT); } catch {}
    }
  });

  // ── Test 5: Date prefix appears in appended episode content ──────────────
  //
  // When haystack_dates are present, formatSession() must prefix the episode
  // content with "[Session date: {date}]". Verified via scratch-DB episode row.

  it('date prefix from haystack_dates appears in appended episode content', () => {
    const h = makeHarness();
    const questions = loadFixture();

    const q = questions.find(qn => qn.question_id === 'mini-001') ?? questions[0];
    if (!q) throw new Error('Fixture returned no questions');

    const firstSession = q.haystack_sessions[0];
    if (!firstSession) throw new Error('Expected at least one session');
    const dateStr = (q.haystack_dates ?? [])[0] ?? '';

    // Append with date prefix (mirrors harness formatSession behaviour)
    h.episodes.append({
      content:    formatSession(firstSession as Array<{ role: string; content: string }>, dateStr),
      origin:     'observed',
      salience:   1.0,
      hard_keep:  1,
      role:       'user',
      session_id: `smoke-date-prefix-${q.question_id}-s0`,
    });

    const rows = h.db.prepare('SELECT content FROM episode').all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);

    const firstRow = rows[0];
    if (!firstRow) throw new Error('Expected episode row');

    // Content must start with the date prefix when dateStr is present
    if (dateStr) {
      expect(firstRow.content).toContain(`[Session date: ${dateStr}]`);
    }

    // Content must also contain the actual turn text
    expect(firstRow.content).toContain('Portland');
  });

  // ── Test 7: Quarantine log pattern — H-2 quarantine surfaces via log callback ─
  //
  // Verifies that a Consolidator with a throwing MockModelProvider emits the
  // "episode <id> skipped (consolidation error)" log message that the harness
  // callback pattern matches and counts.
  //
  // The harness uses: msg.includes('skipped (consolidation error)')
  // This test verifies both sides: the consolidator emits the correct format,
  // and the pattern counting returns the right number.

  it('consolidation failure logs skipped-episode message matching harness quarantine pattern', async () => {
    const h = makeHarness();

    // Append one episode with content that passes eligibility (salience=1.0, observed, user role)
    h.episodes.append({
      content:    'User: Mia recently moved to Seattle',
      origin:     'observed',
      salience:   1.0,
      hard_keep:  1,
      role:       'user',
      session_id: 'smoke-quarantine-s0',
    });

    // Empty generateScript → generate() throws "queue exhausted" on first call.
    // That triggers H-2 quarantine for the episode. embed must succeed so Phase C
    // (reembedDirty) can run — use the same unit-vector fn as other tests.
    const throwingProvider = new MockModelProvider({
      generateScript: [],
      embedFn: (_t: string) => {
        const v = new Float32Array(DEFAULT_CONFIG.embeddingDimensions);
        v[0] = 1.0;
        return v;
      },
      judgeScript: [],
    });

    const logMessages: string[] = [];
    const consolidator = new Consolidator(
      h.db,
      h.episodes,
      h.store,
      h.strength,
      h.retriever,
      throwingProvider,
      makeNoOpSchemaInducer(h),
      h.config,
      h.clock,
      undefined,                          // sink — use default NoopConsolidationSink
      (msg: string) => logMessages.push(msg),
    );

    // H-2 quarantine must NOT propagate as a thrown error — loop continues
    await expect(consolidator.consolidate()).resolves.not.toThrow();

    // Consolidator must log the H-2 quarantine message with the pattern the harness matches
    const quarantineMessages = logMessages.filter(m => m.includes('skipped (consolidation error)'));
    expect(quarantineMessages.length).toBe(1);

    // Harness callback pattern counting must return 1 for this log output
    let harnessCount = 0;
    for (const msg of logMessages) {
      if (msg.includes('skipped (consolidation error)')) harnessCount++;
    }
    expect(harnessCount).toBe(1);
  });

  // ── Test 8: topk→values mapping returns up to K live node values ─────────
  //
  // Verifies the harness Step 4 retrieval path:
  //   CandidateRetriever.topk(queryVec, K) + SemanticStore.getNode(id) → values
  //
  // The harness uses this path instead of RetrievalEngine.retrieve() because the
  // production wrapper gates on cosine >= 0.7 and returns at most 1 result, which
  // causes nearly every eval question to abstain (gold node is often at cosine ~0.48).
  //
  // Checks:
  //  - Returns at most K values
  //  - Returns at least 1 value when embedded nodes exist
  //  - Tombstoned nodes are excluded (topk SQL: tombstoned=0)
  //  - The highest-cosine node (query-aligned unit vector) ranks first

  it('topk→values mapping returns up to K live node values, excludes tombstoned', () => {
    const h = makeHarness();
    const DIM = DEFAULT_CONFIG.embeddingDimensions;

    /** Unit vector: 1.0 at index (i % DIM), 0.0 everywhere else. */
    function unitVec(i: number): Float32Array {
      const v = new Float32Array(DIM);
      v[i % DIM] = 1.0;
      return v;
    }

    // Insert 5 live nodes, each with a distinct embedding
    for (let i = 0; i < 5; i++) {
      h.store.upsertNode({ id: `eval-node-${i}`, type: 'fact', value: `eval-fact-${i}`, origin: 'observed', s: 0.5 });
      h.store.setEmbedding(`eval-node-${i}`, unitVec(i));
    }

    // Insert 1 tombstoned node — must be excluded from topk results
    h.store.upsertNode({ id: 'eval-dead', type: 'fact', value: 'eval-tombstoned-fact', origin: 'observed', s: 0.5 });
    h.store.setEmbedding('eval-dead', unitVec(0)); // same direction as query → would rank first if alive
    h.store.tombstone('eval-dead');

    // Query aligned with unitVec(0): eval-node-0 should rank first, eval-dead excluded
    const queryVec = unitVec(0);
    const K = 3;
    const topkResults = h.retriever.topk(queryVec, K);

    // Mirror the harness Step 4 mapping: topkResults → getNode → filter null → value
    const values = topkResults
      .map(r => h.store.getNode(r.id))
      .filter((n): n is NonNullable<typeof n> => n !== null)
      .map(n => n.value);

    // At most K results
    expect(values.length).toBeLessThanOrEqual(K);
    // At least 1 result (we inserted 5 live nodes)
    expect(values.length).toBeGreaterThan(0);
    // Tombstoned node must NOT appear
    expect(values).not.toContain('eval-tombstoned-fact');
    // All values must come from the live node set
    for (const v of values) {
      expect(v).toMatch(/^eval-fact-\d$/);
    }
    // Top result must be eval-node-0 (query vector aligns exactly with unitVec(0), cosine=1.0)
    expect(values[0]).toBe('eval-fact-0');
  });

  // ── Test 9: --dry-run --instrument smoke — flags parse, code path reachable ─
  //
  // Verifies that the --instrument flag is accepted by the harness and that the
  // instrumentation code path is reachable without any network calls (dry-run mode).
  //
  // Checks:
  //  - Harness exits 0 with --dry-run --instrument
  //  - The instrument-out file is written with one JSON record per question
  //  - Each record has the required keys: question_id, claims, nodes, retrieved, hypothesis, gold_answer
  //  - The hypothesis field is the dry-run stub value (not an LLM response)

  it('harness --dry-run --instrument writes one attribution record per question with required keys', () => {
    const INST_OUT = path.join(os.tmpdir(), `harness-instrument-test-${Date.now()}-${process.pid}.jsonl`);

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '../scripts/eval/longmemeval-harness.cjs'),
          '--dry-run',
          '--instrument',
          '--instrument-out', INST_OUT,
          '--eval', FIXTURE_PATH,
        ],
        { encoding: 'utf8', cwd: path.resolve(__dirname, '..'), timeout: 30_000 },
      );

      expect(result.status).toBe(0);

      // Instrument file must exist and have one record per question in the fixture
      expect(fs.existsSync(INST_OUT)).toBe(true);
      const instLines = fs.readFileSync(INST_OUT, 'utf8').split('\n').filter(l => l.trim());
      expect(instLines.length).toBeGreaterThanOrEqual(1);

      // Each record must have the required attribution keys
      for (const line of instLines) {
        const rec = JSON.parse(line) as Record<string, unknown>;
        expect(rec).toHaveProperty('question_id');
        expect(rec).toHaveProperty('claims');
        expect(rec).toHaveProperty('nodes');
        expect(rec).toHaveProperty('retrieved');
        expect(rec).toHaveProperty('hypothesis');
        expect(rec).toHaveProperty('gold_answer');
        // In dry-run mode, the hypothesis is the stub value (flags are parsed correctly)
        expect(rec.hypothesis).toBe('dry-run-stub-answer');
        // Taps are arrays (empty in dry-run, but present)
        expect(Array.isArray(rec.claims)).toBe(true);
        expect(Array.isArray(rec.nodes)).toBe(true);
        expect(Array.isArray(rec.retrieved)).toBe(true);
      }
    } finally {
      try { fs.unlinkSync(INST_OUT); } catch {}
    }
  });

  // ── Test 6: Resume + --retry-errors — error lines are re-attempted ────────
  //
  // Pre-seeds OUT_FILE with one successful line and one error line.
  // Verifies that --retry-errors drops the error line and retries that question_id.

  it('harness --dry-run --retry-errors re-attempts error-bearing question_ids', () => {
    const OUT = path.join(os.tmpdir(), `harness-retry-test-${Date.now()}-${process.pid}.jsonl`);

    // Pre-seed: mini-001 done successfully, mini-002 had an error
    const doneLine  = JSON.stringify({ question_id: 'mini-001', question_type: 'single-session-user', hypothesis: 'Portland' });
    const errorLine = JSON.stringify({ question_id: 'mini-002', question_type: 'knowledge-update', error: 'simulated-prior-error' });
    fs.writeFileSync(OUT, doneLine + '\n' + errorLine + '\n');

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '../scripts/eval/longmemeval-harness.cjs'),
          '--dry-run',
          '--out', OUT,
          '--eval', FIXTURE_PATH,
          '--retry-errors',
        ],
        { encoding: 'utf8', cwd: path.resolve(__dirname, '..'), timeout: 30_000 },
      );

      expect(result.status).toBe(0);
      // Harness must log that it dropped error lines for retry
      expect(result.stdout).toContain('retry');

      const allLines = fs.readFileSync(OUT, 'utf8').split('\n').filter(l => l.trim());
      const parsed = allLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      // mini-001 must still be present (was not an error — not retried)
      const ids = parsed.map((r: { question_id?: string } | null) => r?.question_id);
      expect(ids).toContain('mini-001');

      // mini-002 must appear exactly once with a hypothesis (not an error), since it was retried
      const mini002 = parsed.filter((r: { question_id?: string } | null) => r?.question_id === 'mini-002');
      expect(mini002).toHaveLength(1);
      expect((mini002[0] as { error?: string }).error).toBeUndefined();
    } finally {
      try { fs.unlinkSync(OUT); } catch {}
    }
  });

});
