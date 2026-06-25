/**
 * Phase 44 Plan 02 — Settings call-site wiring tests.
 *
 * Covers:
 *   Task 1 (run-sleep-pass.ts + ingest-project-cli.ts): loadMergedConfig env-wins precedence
 *     — env RECENSE_CORPUS_GEN='0' wins over settings.json (D-05/D-06); absent env defers
 *     to the merged config value.
 *   Task 2 (consolidator.ts): schemaInductionEnabled gate — a Consolidator built with
 *     config.schemaInductionEnabled=false must NOT call inducer.induceSchemas(); true/undefined
 *     must call it (fail-OPEN default, T-44-05).
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { loadMergedConfig } from '../src/adapter/settings-loader';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockModelProvider } from '../src/model/provider';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { Consolidator } from '../src/consolidation/consolidator';

// ---------------------------------------------------------------------------
// Temp-file helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), `recense-call-sites-test-${process.pid}`);
const TMP_SETTINGS = join(TMP_DIR, 'settings.json');

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Consolidator test harness (minimal, mirrors consolidator.test.ts pattern)
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

function makeHarness(configOverrides: Partial<EngineConfig> = {}): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(1_000_000);
  const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:', ...configOverrides };
  const episodes = new EpisodicStore(db, clock, config);
  const store = new SemanticStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

function makeSpyInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'spy-schema',
  );
}

// ---------------------------------------------------------------------------
// Task 1: loadMergedConfig env-wins precedence (D-05 / D-06)
// ---------------------------------------------------------------------------

describe('loadMergedConfig: env-wins corpus-gen precedence (D-05/D-06)', () => {
  let savedCorpusGen: string | undefined;
  let savedCorpusGenMax: string | undefined;

  beforeEach(() => {
    savedCorpusGen = process.env['RECENSE_CORPUS_GEN'];
    savedCorpusGenMax = process.env['RECENSE_CORPUS_GEN_MAX'];
    // Ensure test starts clean
    delete process.env['RECENSE_CORPUS_GEN'];
    delete process.env['RECENSE_CORPUS_GEN_MAX'];
    ensureTmpDir();
  });

  afterEach(() => {
    // Restore env
    if (savedCorpusGen === undefined) {
      delete process.env['RECENSE_CORPUS_GEN'];
    } else {
      process.env['RECENSE_CORPUS_GEN'] = savedCorpusGen;
    }
    if (savedCorpusGenMax === undefined) {
      delete process.env['RECENSE_CORPUS_GEN_MAX'];
    } else {
      process.env['RECENSE_CORPUS_GEN_MAX'] = savedCorpusGenMax;
    }
  });

  it('env RECENSE_CORPUS_GEN=0 → corpusGen=false even when settings.json preset=full (env wins)', () => {
    // Write a settings file with full preset (corpusGen=true)
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'full', overrides: {} }));
    process.env['RECENSE_CORPUS_GEN'] = '0';

    const config = loadMergedConfig(':memory:', process.env, TMP_SETTINGS);
    expect(config.corpusGen).toBe(false);
  });

  it('env RECENSE_CORPUS_GEN absent + settings preset=lite → corpusGen=false', () => {
    // Write lite preset (corpusGen=false)
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'lite', overrides: {} }));
    // No env override
    const config = loadMergedConfig(':memory:', {}, TMP_SETTINGS);
    expect(config.corpusGen).toBe(false);
  });

  it('env RECENSE_CORPUS_GEN absent + settings preset=full → corpusGen=true', () => {
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'full', overrides: {} }));
    // No env override
    const config = loadMergedConfig(':memory:', {}, TMP_SETTINGS);
    expect(config.corpusGen).toBe(true);
  });

  it('env RECENSE_CORPUS_GEN=1 → corpusGen=true even when settings preset=lite', () => {
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'lite', overrides: {} }));
    process.env['RECENSE_CORPUS_GEN'] = '1';
    const config = loadMergedConfig(':memory:', process.env, TMP_SETTINGS);
    expect(config.corpusGen).toBe(true);
  });

  it('env RECENSE_CORPUS_GEN_MAX overrides settings.json corpusGenMax (env wins)', () => {
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'full', overrides: { corpusGenMax: 5 } }));
    process.env['RECENSE_CORPUS_GEN_MAX'] = '99';
    const config = loadMergedConfig(':memory:', process.env, TMP_SETTINGS);
    expect(config.corpusGenMax).toBe(99);
  });

  it('env RECENSE_CORPUS_GEN_MAX absent → corpusGenMax from settings.json overrides', () => {
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'standard', overrides: { corpusGenMax: 10 } }));
    const config = loadMergedConfig(':memory:', {}, TMP_SETTINGS);
    expect(config.corpusGenMax).toBe(10);
  });

  it('no settings file + no env → uses standard preset fallback (corpusGen=false, schemaInductionEnabled=true)', () => {
    // When no settings file exists, loadMergedConfig falls back to the 'standard' preset
    // (not raw DEFAULT_CONFIG) because the preset-layer always applies (T-44-04).
    // Standard = schema abstraction on, corpus docs off.
    const config = loadMergedConfig(':memory:', {}, '/nonexistent/settings.json');
    expect(config.corpusGen).toBe(false);
    expect(config.schemaInductionEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 2: consolidator schemaInductionEnabled gate (D-11 / T-44-05)
// ---------------------------------------------------------------------------

describe('Consolidator: schemaInductionEnabled gate (D-11)', () => {
  it('induceSchemas NOT called when schemaInductionEnabled=false (Lite preset off)', async () => {
    const h = makeHarness({ schemaInductionEnabled: false });
    const inducer = makeSpyInducer(h);
    const induceSpy = vi.spyOn(inducer, 'induceSchemas');

    const provider = new MockModelProvider({ embedFn: () => new Float32Array(h.config.embeddingDimensions) });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, inducer, h.config, h.clock,
    );

    // consolidate() with no episodes still runs Phase C where the gate lives
    await consolidator.consolidate();
    expect(induceSpy).not.toHaveBeenCalled();
  });

  it('induceSchemas IS called when schemaInductionEnabled=true', async () => {
    const h = makeHarness({ schemaInductionEnabled: true });
    const inducer = makeSpyInducer(h);
    const induceSpy = vi.spyOn(inducer, 'induceSchemas');

    const provider = new MockModelProvider({ embedFn: () => new Float32Array(h.config.embeddingDimensions) });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, inducer, h.config, h.clock,
    );

    await consolidator.consolidate();
    expect(induceSpy).toHaveBeenCalledOnce();
  });

  it('induceSchemas IS called when schemaInductionEnabled=undefined (fail-OPEN default, T-44-05)', async () => {
    // An EngineConfig built without the field (or with undefined) should still run induction.
    // This preserves backward compat: old callers/tests that don't set the field get the same
    // behavior as before this gate was added.
    const configWithoutField = { ...DEFAULT_CONFIG, dbPath: ':memory:' } as EngineConfig;
    // Force undefined to simulate an older caller that never set the field
    (configWithoutField as unknown as Record<string, unknown>)['schemaInductionEnabled'] = undefined;

    const h = makeHarness();
    h.config = configWithoutField;
    const inducer = makeSpyInducer(h);
    const induceSpy = vi.spyOn(inducer, 'induceSchemas');

    const provider = new MockModelProvider({ embedFn: () => new Float32Array(h.config.embeddingDimensions) });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, inducer, configWithoutField, h.clock,
    );

    await consolidator.consolidate();
    expect(induceSpy).toHaveBeenCalledOnce();
  });
});
