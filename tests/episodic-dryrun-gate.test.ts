/**
 * Episodic dry-run gate tests (TEMP-03, D-07).
 *
 * Verifies three invariants:
 *
 *   1. Live-DB guard — the harness REFUSES (non-zero exit) when handed a snapshot path
 *      that resolves under ~/.config/recense. Ensures the gate can never accidentally
 *      operate on the live production database (T-20-12).
 *
 *   2. Off-check proof — running the harness with --off-check and the committed fixture
 *      produces ZERO node_temporal rows. Proves the default-OFF state (RECENSE_ENABLE_EPISODIC_EMAIL
 *      unset) cannot write temporal rows even after full mock-consolidation (T-20-13).
 *
 *   3. Verdict JSON shape — the D-07 buildVerdict logic emits the correct JSON schema
 *      (verdict + three named sub-checks), and that a synthesized ratio of 1.8 yields
 *      ratioPass=false → overall verdict=FAIL (any sub-check miss → FAIL).
 *
 * Tests 1 and 2 call the harness as a subprocess (spawnSync) — same pattern as
 * tests/eval-harness-smoke.test.ts Test 4.
 * Test 3 is a unit test of the verdict logic inline (no subprocess).
 *
 * All tests use zero API keys. The full paid A/B (~$0.20) is NOT run here — it requires
 * human approval at the Task 2 checkpoint.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockModelProvider } from '../src/model/provider';
import { NoopConsolidationSink } from '../src/consolidation/sink';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HARNESS_PATH  = path.resolve(__dirname, '../scripts/eval/episodic-dryrun.cjs');
const FIXTURE_PATH  = path.resolve(__dirname, 'fixtures/episodic-dryrun-fixture.json');
const LIVE_DB_PATH  = path.join(os.homedir(), '.config', 'recense', 'recense.db');

// ---------------------------------------------------------------------------
// In-process harness (mirrors eval-harness-smoke.test.ts makeHarness)
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
    consolSkipThreshold: 0.2,
    candidateK: 5,
  };
  const store     = new SemanticStore(db, clock, config);
  const episodes  = new EpisodicStore(db, clock, config);
  const strength  = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Deterministic unit-vector embed: all inputs map to the same vector. */
function makeUnitEmbedFn(dims: number): (t: string) => Float32Array {
  return () => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  };
}

// ---------------------------------------------------------------------------
// D-07 buildVerdict logic (mirrors harness implementation for inline testing)
// ---------------------------------------------------------------------------

interface VerdictInput {
  ratioValue:     number;
  promoClaims:    number;
  eval02Baseline: number | null;
  eval02Variant:  number | null;
}

interface VerdictResult {
  verdict: 'PASS' | 'FAIL';
  checks: {
    ratio:          number;
    ratioPass:      boolean;
    promoClaims:    number;
    promoPass:      boolean;
    eval02Baseline: number | null;
    eval02Variant:  number | null;
    eval02Pass:     boolean;
  };
}

/**
 * Local copy of the harness buildVerdict() — used for the verdict-shape unit test.
 * Any change to the harness's verdict schema must be mirrored here.
 */
function buildVerdict({ ratioValue, promoClaims, eval02Baseline, eval02Variant }: VerdictInput): VerdictResult {
  const ratioPass  = ratioValue >= 1.0 && ratioValue <= 1.5;
  const promoPass  = promoClaims === 0;
  const eval02Pass = (eval02Baseline === null || eval02Variant === null)
    ? true
    : eval02Variant >= eval02Baseline;
  const verdict = ratioPass && promoPass && eval02Pass ? 'PASS' : 'FAIL';
  return {
    verdict,
    checks: {
      ratio:          +ratioValue.toFixed(3),
      ratioPass,
      promoClaims,
      promoPass,
      eval02Baseline,
      eval02Variant,
      eval02Pass,
    },
  };
}

// ---------------------------------------------------------------------------
// Environment isolation — ensure RECENSE_ENABLE_EPISODIC_EMAIL is unset in tests
// ---------------------------------------------------------------------------

let _savedFlag: string | undefined;
afterEach(() => {
  if (_savedFlag !== undefined) {
    process.env['RECENSE_ENABLE_EPISODIC_EMAIL'] = _savedFlag;
    _savedFlag = undefined;
  } else {
    delete process.env['RECENSE_ENABLE_EPISODIC_EMAIL'];
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('episodic-dryrun-gate', () => {

  // ── Test 1: Live-DB guard ─────────────────────────────────────────────────
  //
  // The harness MUST refuse a snapshot path under ~/.config/recense with a
  // non-zero exit code. Prevents accidental reads/writes to the live production DB.

  it('harness refuses --snapshot path under ~/.config/recense (live-DB guard)', () => {
    const result = spawnSync(
      process.execPath,
      [
        HARNESS_PATH,
        '--off-check',
        '--snapshot', LIVE_DB_PATH,
      ],
      {
        encoding: 'utf8',
        cwd:      path.resolve(__dirname, '..'),
        timeout:  15_000,
        env:      { ...process.env, RECENSE_ENABLE_EPISODIC_EMAIL: undefined },
      },
    );

    // Must exit non-zero
    expect(result.status, 'harness must refuse live-DB path with non-zero exit').not.toBe(0);

    // Stderr must mention the live-DB directory
    const stderr = result.stderr ?? '';
    expect(stderr).toContain('.config/recense');
    expect(stderr).toContain('ERROR');
  });

  // ── Test 2: Off-check proof — ZERO node_temporal rows ─────────────────────
  //
  // Running the harness with --off-check and the committed fixture must:
  //   a) exit 0 (success)
  //   b) print that ZERO node_temporal rows were written
  //
  // This proves the default-OFF state cannot write temporal rows even after
  // full mock-consolidation over temporal-bearing email content (T-20-13).

  it('--off-check exits 0 and reports ZERO node_temporal rows with flag OFF (no API keys)', () => {
    const result = spawnSync(
      process.execPath,
      [
        HARNESS_PATH,
        '--off-check',
        '--snapshot', FIXTURE_PATH,
      ],
      {
        encoding: 'utf8',
        cwd:      path.resolve(__dirname, '..'),
        timeout:  60_000,
        // Ensure flag is unset in the subprocess environment
        env:      { ...process.env, RECENSE_ENABLE_EPISODIC_EMAIL: undefined },
      },
    );

    // Must exit 0
    if (result.status !== 0) {
      console.error('--- harness stdout ---');
      console.error(result.stdout);
      console.error('--- harness stderr ---');
      console.error(result.stderr);
    }
    expect(result.status).toBe(0);

    // Stdout must confirm ZERO temporal rows
    const stdout = result.stdout ?? '';
    expect(stdout).toContain('node_temporal rows written: 0');
    expect(stdout).toContain('PASS');
  });

  // ── Test 3: Verdict JSON shape — synthesized ratio 1.8 → ratioPass=false → FAIL ──
  //
  // Verifies the D-07 verdict structure:
  //   - JSON has the three named sub-checks (ratio, promoClaims, eval02)
  //   - Any sub-check miss (here: ratio=1.8 > 1.5) yields verdict='FAIL'
  //   - ratioPass is false at 1.8
  //   - promoPass and eval02Pass can be true simultaneously without overriding the FAIL

  it('buildVerdict with synthesized ratio=1.8 yields ratioPass=false and verdict=FAIL', () => {
    const result = buildVerdict({
      ratioValue:     1.8,
      promoClaims:    0,
      eval02Baseline: 0.5,
      eval02Variant:  0.5,
    });

    // Verdict must be FAIL (any sub-check miss → FAIL)
    expect(result.verdict).toBe('FAIL');

    // Ratio sub-check: 1.8 is above the 1.5× cap
    expect(result.checks.ratio).toBeCloseTo(1.8);
    expect(result.checks.ratioPass).toBe(false);

    // Promo sub-check: 0 promo claims → promoPass=true (not the cause of FAIL)
    expect(result.checks.promoClaims).toBe(0);
    expect(result.checks.promoPass).toBe(true);

    // EVAL-02 sub-check: variant ≥ baseline → eval02Pass=true (not the cause of FAIL)
    expect(result.checks.eval02Baseline).toBe(0.5);
    expect(result.checks.eval02Variant).toBe(0.5);
    expect(result.checks.eval02Pass).toBe(true);

    // Shape: all required check keys are present
    expect(result.checks).toHaveProperty('ratio');
    expect(result.checks).toHaveProperty('ratioPass');
    expect(result.checks).toHaveProperty('promoClaims');
    expect(result.checks).toHaveProperty('promoPass');
    expect(result.checks).toHaveProperty('eval02Baseline');
    expect(result.checks).toHaveProperty('eval02Variant');
    expect(result.checks).toHaveProperty('eval02Pass');
  });

  it('buildVerdict with ratio=1.2 and zero promo claims → PASS', () => {
    const result = buildVerdict({
      ratioValue:     1.2,
      promoClaims:    0,
      eval02Baseline: 0.8,
      eval02Variant:  0.85,
    });

    expect(result.verdict).toBe('PASS');
    expect(result.checks.ratioPass).toBe(true);
    expect(result.checks.promoPass).toBe(true);
    expect(result.checks.eval02Pass).toBe(true);
  });

  it('buildVerdict with ratio=0.9 (below 1.0 minimum) → ratioPass=false → FAIL', () => {
    // The superset prompt must produce AT LEAST as many claims as the baseline (≥1.0 floor)
    const result = buildVerdict({
      ratioValue:     0.9,
      promoClaims:    0,
      eval02Baseline: null,
      eval02Variant:  null,
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.checks.ratioPass).toBe(false);
  });

  it('buildVerdict with promoClams=3 → promoPass=false → FAIL regardless of ratio', () => {
    const result = buildVerdict({
      ratioValue:     1.1,
      promoClaims:    3,
      eval02Baseline: null,
      eval02Variant:  null,
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.checks.promoPass).toBe(false);
    expect(result.checks.promoClaims).toBe(3);
  });

  // ── Test 4: Off-switch confirmed via in-process Consolidator ──────────────
  //
  // An in-process variant of the off-check: uses TypeScript-imported engine
  // components (no subprocess) to confirm the invariant under a controlled env.
  // This provides a fast CI fallback that doesn't depend on the compiled harness.
  //
  // Verifies: with RECENSE_ENABLE_EPISODIC_EMAIL unset, ingesting 3 gmail-source
  // episodes via Consolidator+MockModelProvider (scripted to return baseline claims
  // with no due_at) produces zero node_temporal rows.

  it('in-process: consolidating gmail episodes with flag OFF writes zero node_temporal rows', async () => {
    _savedFlag = process.env['RECENSE_ENABLE_EPISODIC_EMAIL'];
    delete process.env['RECENSE_ENABLE_EPISODIC_EMAIL'];

    const h = makeHarness();

    // Load fixture to mirror the harness fixture content
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Array<{ id: string; subject: string; body: string }>;

    // Append 3 gmail-source episodes
    for (const email of fixture) {
      h.episodes.append({
        content:    `Subject: ${email.subject}\n\n${email.body}`,
        origin:     'observed',
        salience:   0.7,
        hard_keep:  0,
        role:       'user',
        session_id: `ip-off-check-${email.id}`,
        source:     'gmail',
      });
    }

    // Script mock: returns one baseline claim per episode — no due_at, no action_type
    const generateScript = fixture.map((email, i) =>
      JSON.stringify([{ type: 'fact', value: `Email ${i + 1} about: ${email.subject}` }])
    );
    const judgeScript = Array.from({ length: fixture.length * 3 }, () => ({
      best_candidate_id: null as string | null,
      relation:          'unrelated' as const,
      magnitude:         0,
    }));

    const provider = new MockModelProvider({
      generateScript,
      judgeScript,
      embedFn: makeUnitEmbedFn(h.config.embeddingDimensions),
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, makeNoOpSchemaInducer(h), h.config, h.clock,
      new NoopConsolidationSink(),
      () => {}, // silent log
    );

    await consolidator.consolidate();

    // No node_temporal rows must be written
    const temporalCount = (h.db.prepare('SELECT COUNT(*) AS n FROM node_temporal').get() as { n: number }).n;
    expect(temporalCount).toBe(0);

    // Sanity: nodes were created (consolidation ran, not skipped entirely)
    const nodeCount = (h.db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;
    expect(nodeCount).toBeGreaterThan(0);
  });

  // ── Test 5: Fixture file integrity ───────────────────────────────────────
  //
  // The fixture must be a valid JSON array of email objects with required fields.

  it('fixture file is a valid JSON array with id, subject, and body on every entry', () => {
    expect(fs.existsSync(FIXTURE_PATH), `fixture not found at ${FIXTURE_PATH}`).toBe(true);

    const raw     = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const fixture = JSON.parse(raw) as unknown[];

    expect(Array.isArray(fixture)).toBe(true);
    expect(fixture.length).toBeGreaterThanOrEqual(1);

    for (const email of fixture as Record<string, unknown>[]) {
      expect(email).toHaveProperty('id');
      expect(email).toHaveProperty('subject');
      expect(email).toHaveProperty('body');
      expect(typeof email['id']).toBe('string');
      expect(typeof email['subject']).toBe('string');
      expect(typeof email['body']).toBe('string');
      expect((email['subject'] as string).length).toBeGreaterThan(0);
      expect((email['body'] as string).length).toBeGreaterThan(0);
    }
  });

});
