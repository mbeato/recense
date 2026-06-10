/**
 * DEBT-06: Cross-project retrieval scoping via cwd soft filter.
 *
 * Three behavior assertions (D-93 Option A):
 *   (a) same-cwd: retrieveCueless('/proj/A') returns a node supported by a '/proj/A' episode.
 *   (b) global passthrough: retrieveCueless('/proj/A') also returns a node whose supporting
 *       episodes are ALL cwd='' — evidence-backed global facts are never hidden.
 *   (c) cross-project exclusion: retrieveCueless('/proj/A') does NOT return a node supported
 *       only by '/proj/B' episodes.
 *
 * RED state: tests fail until Task 3 lands the cwd soft filter in retrieveCueless.
 * Analog: tests/retrieval.test.ts (in-memory DB, initSchema, seed nodes, RetrievalEngine).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine, type RetrieveResult } from '../src/retrieval/engine';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { newId } from '../src/lib/hash';

const BASE_CONFIG = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

/**
 * Call retrieveCueless with a cwd argument using a type-safe cast.
 * RED: the function signature doesn't accept cwd yet (Task 3 adds it).
 * GREEN: this cast remains harmless after the signature is updated.
 */
function retrieveWithCwd(engine: RetrievalEngine, cwd: string): RetrieveResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (engine as any).retrieveCueless(cwd) as RetrieveResult;
}

describe('RetrievalEngine cwd scoping (DEBT-06 / D-93)', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;
  let retriever: CandidateRetriever;
  let strength: StrengthDecayManager;
  let gate: AllocationGate;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, BASE_CONFIG);
    retriever = new CandidateRetriever(db);
    strength = new StrengthDecayManager(db, clock, BASE_CONFIG);
    gate = new AllocationGate(BASE_CONFIG);
  });

  afterEach(() => { db.close(); });

  function makeEngine(): RetrievalEngine {
    return new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate);
  }

  /**
   * Insert an episode with an explicit cwd value.
   * Uses direct SQL because EpisodicStore.append gains cwd in Task 2 (after this RED test).
   * Schema v3 ensures the cwd column exists in the fresh in-memory DB.
   */
  function insertEpisode(episodeId: string, cwd: string): void {
    db.prepare(`
      INSERT INTO episode (
        id, ts, content, origin, salience, hard_keep, consolidated,
        source_inference_id, role, session_id, source, external_id, cwd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episodeId,
      clock.nowMs(),
      'test content',
      'observed',
      0.5,   // salience
      0,     // hard_keep
      1,     // consolidated (already processed — only here as evidence)
      null,  // source_inference_id
      'user',
      'sess-test',
      'claude-code',
      null,  // external_id
      cwd,
    );
  }

  /**
   * Link a node to an episode via consolidation_event.
   * This establishes the "evidence" relationship used by the cwd soft filter.
   */
  function linkNodeToEpisode(nodeId: string, episodeId: string): void {
    db.prepare(`
      INSERT INTO consolidation_event (id, ts, schema_version, event_type, node_id, episode_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(newId(), clock.nowMs(), SCHEMA_VERSION, 'strengthen', nodeId, episodeId);
  }

  /**
   * Seed a live node and link it to an episode with the given cwd.
   * Each call creates one node + one episode + one consolidation_event link.
   */
  function addNodeWithEpisode(nodeId: string, value: string, cwd: string): void {
    store.upsertNode({ id: nodeId, type: 'fact', value, origin: 'observed', s: 0.5 });
    const episodeId = newId();
    insertEpisode(episodeId, cwd);
    linkNodeToEpisode(nodeId, episodeId);
  }

  // ─── (a) same-cwd pass ───────────────────────────────────────────────────────

  it('same-cwd: returns a node whose supporting episode has cwd matching the requested cwd', () => {
    addNodeWithEpisode('node-a', 'project A specific fact', '/proj/A');
    const engine = makeEngine();

    const result = retrieveWithCwd(engine, '/proj/A');

    const ids = result.results.map(r => r.id);
    expect(result.status).toBe('ok');
    expect(ids).toContain('node-a');
  });

  // ─── (b) global passthrough (D-93) ──────────────────────────────────────────

  it('global passthrough (D-93): returns nodes whose supporting episodes are ALL cwd="" (empty)', () => {
    addNodeWithEpisode('node-global', 'fact with no project affinity', '');
    addNodeWithEpisode('node-a', 'project A fact', '/proj/A');
    const engine = makeEngine();

    const result = retrieveWithCwd(engine, '/proj/A');

    const ids = result.results.map(r => r.id);
    expect(result.status).toBe('ok');
    // Global node (empty cwd episode) must surface even when filtering for /proj/A
    expect(ids).toContain('node-global');
  });

  // ─── (c) cross-project exclusion ─────────────────────────────────────────────

  it('cross-project exclusion: excludes a node supported only by episodes from a different cwd', () => {
    // Seed only a /proj/B node — nothing for /proj/A
    addNodeWithEpisode('node-b', 'project B specific fact', '/proj/B');
    const engine = makeEngine();

    const result = retrieveWithCwd(engine, '/proj/A');

    const ids = result.results.map(r => r.id);
    expect(result.status).toBe('ok');
    // node-b must NOT appear when the session is /proj/A
    expect(ids).not.toContain('node-b');
  });

  // ─── H-5: orphan nodes (zero consolidation_event rows) surface as global ────

  it('H-5: orphan node (no consolidation_event rows) surfaces in cwd-scoped retrieval', () => {
    // Orphan: seeded node with ZERO consolidation_event rows — no episode linkage at all.
    // Pre-fix: orphan was invisible in cwd-scoped retrieval (83% of live graph affected for
    // fresh installs with seeded corpus but no consolidation pass run yet).
    // Post-fix: orphan treated as global — surfaces in all cwd-scoped queries.
    store.upsertNode({ id: 'node-orphan', type: 'fact', value: 'orphan fact', origin: 'observed', s: 0.5 });

    // Also seed a cross-project node (has an event, but wrong cwd — still excluded)
    addNodeWithEpisode('node-cross', 'cross-project fact', '/proj/B');

    const engine = makeEngine();
    const result = retrieveWithCwd(engine, '/proj/A');

    const ids = result.results.map(r => r.id);
    expect(result.status).toBe('ok');

    // H-5 fix: orphan (event-less) node treated as global → appears for any cwd
    expect(ids).toContain('node-orphan');

    // Cross-project bleed guard regression: node backed by /proj/B events still excluded
    expect(ids).not.toContain('node-cross');
  });

  // ─── backward-compat: no cwd arg → returns all live nodes ───────────────────

  it('no-arg (backward-compat): retrieveCueless() with no cwd returns all live nodes', () => {
    addNodeWithEpisode('node-a', 'project A fact', '/proj/A');
    addNodeWithEpisode('node-b', 'project B fact', '/proj/B');
    addNodeWithEpisode('node-global', 'global fact', '');
    const engine = makeEngine();

    // Call without cwd arg — unchanged global view
    const result = engine.retrieveCueless();

    const ids = result.results.map(r => r.id);
    expect(result.status).toBe('ok');
    expect(ids).toContain('node-a');
    expect(ids).toContain('node-b');
    expect(ids).toContain('node-global');
  });
});
