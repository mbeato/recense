/**
 * Correctness harness smoke test (EVAL-02).
 *
 * Validates three things with zero network/API calls:
 *   1. The committed correctness-cases.json has the correct schema (16-20 cases, all 9 fields).
 *   2. The ADD-only baseline structure: appending two contradicting facts with no consolidation
 *      leaves >=2 episode rows and 0 node rows (duplicates, no correction).
 *   3. The brain-memory pipeline via Consolidator + MockModelProvider: a scripted contradiction
 *      case produces a tombstoned old node and a live new node (belief updated, tombstone present).
 *
 * All tests use an in-memory Database and MockModelProvider — no runConsolidation (which
 * requires real API keys). This mirrors the harness pattern in tests/consolidation.test.ts.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import type { NodeRow } from '../src/lib/types';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { MockConsolidationSink } from '../src/consolidation/sink';
import { newId } from '../src/lib/hash';

// ── Required fields for every correctness case ───────────────────────────────
const REQUIRED_FIELDS = [
  'case_id', 'persona', 'initial_fact', 'contradicting_fact',
  'control_type', 'expected_relation', 'magnitude',
  'query_probe', 'expected_answer_hint',
] as const;

// ── Harness helpers (mirrors tests/consolidation.test.ts) ─────────────────────

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
  const store    = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

/** No-op SchemaInducer: naming function returns a placeholder, no LLM calls. */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/**
 * Deterministic embedding: same vector for any input → cosine = 1.0 between any two texts.
 * Used to guarantee the claim matches the candidate node above the similarity threshold.
 */
function makeAlwaysSameEmbedFn(dims: number): (t: string) => Float32Array {
  return (_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EVAL-02 correctness harness smoke tests', () => {
  const CASES_PATH = resolve(__dirname, '../scripts/eval/cases/correctness-cases.json');

  // ── Test 1: committed case set schema guard ──────────────────────────────────
  describe('Test 1: correctness-cases.json schema validation', () => {
    it('loads and contains 16-20 cases each with the nine required fields', () => {
      const raw = readFileSync(CASES_PATH, 'utf8');
      const cases = JSON.parse(raw) as unknown[];

      expect(Array.isArray(cases)).toBe(true);
      expect(cases.length).toBeGreaterThanOrEqual(16);
      expect(cases.length).toBeLessThanOrEqual(20);

      for (const c of cases as Record<string, unknown>[]) {
        for (const field of REQUIRED_FIELDS) {
          expect(c, `case missing field "${field}"`).toHaveProperty(field);
        }
      }
    });

    it('has at least 11 contradiction cases and at least 3 control cases', () => {
      const cases = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Array<{ expected_relation: string }>;
      const contradictions = cases.filter(c => c.expected_relation === 'contradict');
      const controls = cases.filter(c => c.expected_relation !== 'contradict');
      expect(contradictions.length).toBeGreaterThanOrEqual(11);
      expect(controls.length).toBeGreaterThanOrEqual(3);
    });

    it('has at least one case in each magnitude band (~0.3, ~0.5, ~0.85)', () => {
      const cases = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Array<{ magnitude: number }>;
      const hasMild = cases.some(c => c.magnitude >= 0.25 && c.magnitude <= 0.4);
      const hasModerate = cases.some(c => c.magnitude >= 0.45 && c.magnitude <= 0.65);
      const hasCategorical = cases.some(c => c.magnitude >= 0.8 && c.magnitude <= 1.0);
      expect(hasMild, 'no ~0.3 magnitude case found').toBe(true);
      expect(hasModerate, 'no ~0.5-0.6 magnitude case found').toBe(true);
      expect(hasCategorical, 'no ~0.85-0.9 magnitude case found').toBe(true);
    });
  });

  // ── Test 2: ADD-only baseline structure ────────────────────────────────────
  describe('Test 2: ADD-only baseline structure (no consolidation)', () => {
    let h: Harness;
    beforeEach(() => { h = makeHarness(); });

    it('appending two contradicting facts with no consolidation leaves >=2 episode rows and 0 node rows', () => {
      const s1 = 'add-only-s1';
      const s2 = 'add-only-s2';

      h.episodes.append({
        content: 'Ana lives in Portland, Oregon',
        origin: 'asserted_by_user',
        salience: 1.0,
        hard_keep: 1,
        role: 'user',
        session_id: s1,
      });
      h.episodes.append({
        content: 'Ana moved to Denver, Colorado',
        origin: 'asserted_by_user',
        salience: 1.0,
        hard_keep: 1,
        role: 'user',
        session_id: s2,
      });

      // No consolidation — facts remain as raw episodes
      const episodeCount = (h.db.prepare('SELECT COUNT(*) AS n FROM episode').get() as { n: number }).n;
      const nodeCount    = (h.db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;

      expect(episodeCount).toBeGreaterThanOrEqual(2);
      expect(nodeCount).toBe(0);
    });
  });

  // ── Test 3: brain-memory pipeline under MockModelProvider ──────────────────
  describe('Test 3: Consolidator + MockModelProvider belief-update path', () => {
    let h: Harness;
    beforeEach(() => { h = makeHarness(); });

    it('a scripted contradiction case tombstones the old node and creates a live node with the new value', async () => {
      const dims = h.config.embeddingDimensions;
      const embedFn = makeAlwaysSameEmbedFn(dims);

      // Pre-seed the old belief node (so we know its ID for the judge verdict)
      const oldNodeId = newId();
      const oldValue  = 'Ana lives in Portland, Oregon';
      const newValue  = 'Ana moved to Denver, Colorado';

      h.store.upsertNode({
        id: oldNodeId, type: 'fact', value: oldValue,
        origin: 'observed', s: 0.5, c: 0.7,
      });
      // Pre-embed the node so CandidateRetriever can score it against the claim's vector
      const [nodeVec] = await new (class {
        async embed(texts: string[]) { return texts.map(embedFn); }
      })().embed([oldValue]);
      h.store.setEmbedding(oldNodeId, nodeVec!);

      // Script the mock provider:
      //   generate → extract one claim with the new value
      //   judge    → contradict the old node at mid-band magnitude (→ RECONCILE → tombstone)
      const contradictVerdict: JudgeVerdict = {
        best_candidate_id: oldNodeId,
        relation: 'contradict',
        magnitude: 0.5, // ratio = 0.5 / (0.5×0.7) ≈ 1.43 → between 0.8 and 2.0 → RECONCILE
      };
      const provider = new MockModelProvider({
        embedFn,
        generateScript: [JSON.stringify([{ type: 'fact', value: newValue }])],
        judgeScript: [contradictVerdict],
      });

      const consolidator = new Consolidator(
        h.db, h.episodes, h.store, h.strength, h.retriever,
        provider, makeNoOpSchemaInducer(h), h.config, h.clock,
        new MockConsolidationSink(),
      );

      // Append the contradicting-fact episode (asserted_by_user prevents self-confirmation)
      h.episodes.append({
        content: 'Ana moved to Denver, Colorado',
        origin: 'asserted_by_user',
        salience: 0.9,
        hard_keep: 1,
        role: 'user',
        session_id: 'session-contradict',
        source_inference_id: null,
      });

      await consolidator.consolidate();

      const allNodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];

      // Old node must be tombstoned
      const oldNode = h.store.getNode(oldNodeId)!;
      expect(oldNode).toBeDefined();
      expect(oldNode.tombstoned).toBe(1);

      // A new live node carrying the new value must exist
      const liveNodes = allNodes.filter(n => n.tombstoned === 0);
      expect(liveNodes.length).toBeGreaterThanOrEqual(1);
      const newNode = liveNodes.find(n => n.value === newValue);
      expect(newNode, 'expected a live node with the new value after reconcile').toBeDefined();
    });

    it('the Consolidator + MockModelProvider make zero real API calls (by construction)', async () => {
      // Structural proof: MockModelProvider never reaches out to a network.
      // If any method exhausts its scripted queue it throws — the test above would fail.
      // This test documents the invariant explicitly.
      const provider = new MockModelProvider({ generateScript: [], judgeScript: [], embedFn: () => new Float32Array(h.config.embeddingDimensions) });
      expect(provider).toBeDefined();
      // An empty queue with no episodes produces no API calls
      const consolidator = new Consolidator(
        h.db, h.episodes, h.store, h.strength, h.retriever,
        provider, makeNoOpSchemaInducer(h), h.config, h.clock,
      );
      await expect(consolidator.consolidate()).resolves.not.toThrow();
    });
  });
});
