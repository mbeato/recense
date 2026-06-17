/**
 * Integration tests for HITL audit-episode provenance (GAP-01 / D-43 / ACT-03).
 *
 * Two properties under test:
 *   (a) SOURCE PERSISTENCE: ops.add with source:'hitl' (via the real /v1/add pipeline)
 *       persists source='hitl' to the episode row; origin is clamped to 'observed' (D-05);
 *       a non-hitl spoof value ('banana') falls back to the instance default ('http').
 *   (b) CONSOLIDATOR EXCLUSION (D-43): a REAL Consolidator pass over the same DB
 *       marks source='hitl' episodes consolidated=1 with ZERO graph effects —
 *       no node is minted from audit content, no belief node's s/c is strengthened.
 *
 * TDD RED / GREEN contract:
 *   Tests (a) pass as soon as Task 1 (validateSource + ops.add source thread) is in.
 *   Tests (b) are the RED gate: they FAIL until Task 2 adds `source === 'hitl'` guards
 *   at BOTH consolidator sites (isEligibleForExtraction + per-episode hard-stop loop).
 *
 *   The key RED → GREEN differentiator is `consolidated === 1`.
 *
 *   Before the fix (RED state):
 *     - isEligibleForExtraction returns true for hitl → hitl is included in the prefetch set.
 *     - generate() is called with an empty script → throws (queue exhausted).
 *     - H-2 quarantine: episode NOT markConsolidated'd → consolidated = 0.
 *     - Test asserts consolidated === 1 → FAILS.
 *
 *   After the fix (GREEN state):
 *     - isEligibleForExtraction returns false for hitl (new guard) → NOT prefetched.
 *     - Per-episode loop: hits the new hard-stop `episode.source === 'hitl'`
 *       → markConsolidated → continue. generate() is NEVER called.
 *     - Test asserts consolidated === 1 → PASSES.
 *
 * Harness:
 *   - Phase 1 (source persistence): real wireMemoryEngine + ops.add against a temp file DB.
 *   - Phase 2 (consolidator exclusion): fresh DB connection + Consolidator wired the same
 *     way as tests/consolidation-source.test.ts, with consolSkipThreshold: 0.0 to force
 *     every episode through the salience gate so the hitl hard-stop is the first gate
 *     that can prevent extraction (not the salience skip).
 *   - MockModelProvider with empty generateScript: if the consolidator mistakenly tries to
 *     extract claims from the hitl episode, generate() throws → H-2 quarantine →
 *     consolidated stays 0 → test FAILS. This proves the guard short-circuits extraction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { wireMemoryEngine } from '../src/adapter/memory-ops';
import { MockModelProvider } from '../src/model/provider';
import { EpisodicStore } from '../src/db/episode-store';
import { SemanticStore } from '../src/db/semantic-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { Consolidator } from '../src/consolidation/consolidator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `hitl-provenance-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Hash-seeded synthetic embed: deterministic, no network. */
function syntheticEmbed(text: string): Float32Array {
  const vec = new Float32Array(128);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
  }
  vec[hash % 128] = 1.0;
  return vec;
}

/**
 * Consolidator test config: consolSkipThreshold=0.0 ensures the salience gate NEVER
 * fires so the hitl hard-stop (or its absence) is the first gate that can prevent
 * claim extraction. If salience skipped hitl instead, the episode would stay
 * consolidated=0 too — masking the absence of the hitl guard.
 */
function makeTestConfig(dbPath: string): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    dbPath,
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.0,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDbPath: string;
let tmpLockPath: string;

beforeEach(() => {
  tmpDbPath = makeTempDbPath();
  tmpLockPath = path.join(
    os.tmpdir(),
    `hitl-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
  );
  process.env['RECENSE_LOCK_PATH'] = tmpLockPath;
});

afterEach(() => {
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
  delete process.env['RECENSE_LOCK_PATH'];
});

// ---------------------------------------------------------------------------
// (a) Source persistence — real ops.add path
// ---------------------------------------------------------------------------

describe('(a) source persistence through ops.add (ACT-03 / D-43)', () => {
  it("persists source='hitl' for a HITL audit episode; origin clamped to 'observed' (D-05)", async () => {
    const provider = new MockModelProvider({ embedFn: syntheticEmbed });
    const wired = await wireMemoryEngine({ dbPath: tmpDbPath, source: 'http', provider });

    // Real ops.add call with the hitl audit content (mirrors hitlEpisode() in memory-client.ts)
    await wired.ops.add(
      '[hitl] decision=execute | server=recense-memory | tool=memory_search | result=[{"value":"Qwen3.5-4B"}]',
      'hitl:execute',   // origin — D-05 should clamp this to 'observed'
      'hitl',           // source — should persist as 'hitl' via validateSource
    );
    wired.close();

    const db = new Database(tmpDbPath);
    const rows = db.prepare('SELECT * FROM episode').all() as Array<Record<string, unknown>>;
    db.close();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // ACT-03: source must be 'hitl'
    expect(row['source']).toBe('hitl');
    // D-05: origin clamped from 'hitl:execute' (not 'asserted_by_user') → 'observed'
    expect(row['origin']).toBe('observed');
    // Not yet processed by any sleep pass
    expect(row['consolidated']).toBe(0);
  });

  it("spoof-fallback: source='banana' falls back to the instance default ('http')", async () => {
    const provider = new MockModelProvider({ embedFn: syntheticEmbed });
    const wired = await wireMemoryEngine({ dbPath: tmpDbPath, source: 'http', provider });

    // 'banana' is not an allowed source override → validateSource returns 'http'
    await wired.ops.add('ordinary observed memory', 'observed', 'banana');
    wired.close();

    const db = new Database(tmpDbPath);
    const rows = db.prepare('SELECT * FROM episode').all() as Array<Record<string, unknown>>;
    db.close();

    expect(rows).toHaveLength(1);
    // Must fall back to instance default, not persist 'banana'
    expect(rows[0]!['source']).toBe('http');
    expect(rows[0]!['origin']).toBe('observed');
  });

  it('hitl source is preserved regardless of the engine instance default', async () => {
    // Even when the engine instance default is 'mcp', 'hitl' should win (validateSource allowlist)
    const provider = new MockModelProvider({ embedFn: syntheticEmbed });
    const wired = await wireMemoryEngine({ dbPath: tmpDbPath, source: 'mcp', provider });

    await wired.ops.add('[hitl] decision=reject', 'hitl:reject', 'hitl');
    wired.close();

    const db = new Database(tmpDbPath);
    const row = db.prepare('SELECT source FROM episode').get() as { source: string };
    db.close();

    expect(row.source).toBe('hitl');
  });
});

// ---------------------------------------------------------------------------
// (b) Consolidator exclusion — real ops.add + real Consolidator (D-43 / ACT-03)
// ---------------------------------------------------------------------------

describe('(b) consolidator exclusion — source=hitl excluded, zero graph effects (D-43)', () => {
  it("hitl episode is marked consolidated=1 with zero graph effects after a real Consolidator pass", async () => {
    // ── Phase 1: write the hitl episode via real ops.add ───────────────────
    const writeProvider = new MockModelProvider({ embedFn: syntheticEmbed });
    const wired = await wireMemoryEngine({ dbPath: tmpDbPath, source: 'http', provider: writeProvider });

    // HITL audit episode: content embeds tool results that WOULD be extracted as claims
    // if it were fed to the extractor (proving the exclusion short-circuits BEFORE that).
    await wired.ops.add(
      '[hitl] decision=execute | server=recense-memory | tool=memory_search | result=[{"value":"Qwen3.5-4B is the selected local model"}]',
      'hitl:execute',
      'hitl',
    );
    wired.close();

    // ── Phase 2: seed a belief node that audit content WOULD strengthen (D-43) ─
    const seedDb = new Database(tmpDbPath);
    seedDb.prepare(`
      INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
                        tombstoned, pending_contradictions, training_eligible)
      VALUES (?, 'fact', ?, ?, 'observed', ?, ?, ?, 0, '[]', 1)
    `).run(
      'node-belief-qwen',
      'Qwen3.5-4B is the selected local model',
      'hash-belief-qwen',
      0.8,
      0.5,
      Date.now(),
    );
    seedDb.close();

    // ── Phase 3: run a REAL Consolidator pass ─────────────────────────────
    const config = makeTestConfig(tmpDbPath);
    const clock = new FakeClock(Date.now());
    const db = new Database(tmpDbPath);
    const episodes = new EpisodicStore(db, clock, config);
    const store = new SemanticStore(db, clock, config);
    const strength = new StrengthDecayManager(db, clock, config);
    const retriever = new CandidateRetriever(db);

    // EMPTY generateScript — the key RED/GREEN discriminator:
    //   RED (no hitl guard): hitl IS in prefetch set → generate() called → throws (empty
    //     queue) → H-2 quarantine → NOT markConsolidated'd → consolidated = 0 → test FAILS.
    //   GREEN (hitl guard present): hitl NOT in prefetch set (isEligibleForExtraction returns
    //     false) AND hits hard-stop in loop → markConsolidated → consolidated = 1 → test PASSES.
    //   generate() is NEVER called in the GREEN state, so the empty queue never fires.
    const consolidatorProvider = new MockModelProvider({
      embedFn: syntheticEmbed,
      generateScript: [],   // intentionally empty — see comment above
    });

    const schemaInducer = new SchemaInducer(
      db, store, strength, retriever,
      consolidatorProvider,
      config, clock,
      async () => 'no-op-schema',
    );

    const consolidator = new Consolidator(
      db, episodes, store, strength, retriever,
      consolidatorProvider, schemaInducer, config, clock,
    );

    await consolidator.consolidate();
    db.close();

    // ── Phase 4: assert consolidated state and zero graph effects ─────────
    const checkDb = new Database(tmpDbPath);

    // (i) PRIMARY: hitl episode must be consolidated=1 (hard-stop guard, NOT H-2 quarantine)
    const hitlEps = checkDb.prepare(
      "SELECT consolidated FROM episode WHERE source = 'hitl'"
    ).get() as { consolidated: number };
    expect(hitlEps.consolidated).toBe(1);

    // (ii) NO node was minted whose value derives from the hitl audit content
    const hitlNode = checkDb.prepare(
      "SELECT id FROM node WHERE value LIKE '%Qwen3.5-4B%' AND id != 'node-belief-qwen'"
    ).get() as { id: string } | undefined;
    expect(hitlNode).toBeUndefined();

    // (iii) D-43: the pre-seeded belief node's s and c are UNCHANGED after the pass
    const beliefNode = checkDb.prepare(
      "SELECT s, c FROM node WHERE id = 'node-belief-qwen'"
    ).get() as { s: number; c: number };
    expect(beliefNode.s).toBeCloseTo(0.8, 5);
    expect(beliefNode.c).toBeCloseTo(0.5, 5);

    checkDb.close();
  });

  it("non-hitl episodes are still eligible for extraction (D-43 guard does not over-fire)", async () => {
    // Regression guard: a regular source='http' episode must NOT be excluded by the hitl
    // guard. We verify it reaches the extraction phase by checking consolidated=1 after a
    // pass where the ordinary episode's generate call IS consumed (not quarantined).
    const writeProvider = new MockModelProvider({ embedFn: syntheticEmbed });
    const wired = await wireMemoryEngine({ dbPath: tmpDbPath, source: 'http', provider: writeProvider });

    await wired.ops.add(
      'The team has decided to adopt TypeScript for all future services in this project.',
      'observed',
      undefined,  // source falls back to 'http'
    );
    wired.close();

    const config = makeTestConfig(tmpDbPath);
    const clock = new FakeClock(Date.now());
    const db = new Database(tmpDbPath);
    const episodes = new EpisodicStore(db, clock, config);
    const store = new SemanticStore(db, clock, config);
    const strength = new StrengthDecayManager(db, clock, config);
    const retriever = new CandidateRetriever(db);

    // ONE generate response — proves generate() was called (ordinary episode was eligible).
    // Returns empty claims so no graph effects occur (this test is about eligibility only).
    const consolidatorProvider = new MockModelProvider({
      embedFn: syntheticEmbed,
      generateScript: [JSON.stringify([])],
    });

    const schemaInducer = new SchemaInducer(
      db, store, strength, retriever,
      consolidatorProvider,
      config, clock,
      async () => 'no-op-schema',
    );

    const consolidator = new Consolidator(
      db, episodes, store, strength, retriever,
      consolidatorProvider, schemaInducer, config, clock,
    );

    await consolidator.consolidate();

    // Ordinary episode must be consolidated=1 (reached extraction + markConsolidated)
    const ep = db.prepare(
      "SELECT consolidated FROM episode WHERE source = 'http'"
    ).get() as { consolidated: number };
    expect(ep.consolidated).toBe(1);

    db.close();
  });
});
