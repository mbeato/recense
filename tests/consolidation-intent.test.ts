/**
 * Tests for CLASSIFY-02 intent-field threading through the consolidator (Phase 63-04).
 *
 * Verifies:
 *  - All three decision routes (fast-path confirm, auto-unrelated, judge-escalated) thread
 *    claimIntentStatus/claimIntentEntity/claimIntentConfidence onto the in-memory decision
 *    exactly as ExtractedClaim.intent_status/intent_entity/intent_confidence emitted them.
 *  - A claim with no intent fields yields a decision with all three fields undefined
 *    (backward-compat — D-05 absence-over-guess passthrough).
 *  - hitl, inferred, and echo episodes are NEVER classified — the D-09 hard stop is
 *    inherited by construction, not re-implemented (Pitfall 6).
 *  - Exactly one provider.generate call is made per gmail episode (D-12a) — classification
 *    rides the existing extraction call, it never adds a second one.
 *
 * Observation seam (D-08): the intent fields are inert this phase — nothing consumes them,
 * no DB row is written — so they cannot be observed via a table query. This file uses an
 * instance-level spy (not a subclass — `applyDecision` is a TS `private` method, so a real
 * subclass override would collide at the type level) that monkey-patches the single
 * `Consolidator` instance under test to capture the `ClaimDecision` array passed into
 * `applyDecision` before Phase B applies it. This never touches `src/`: no production
 * export, no ConsolidationSink payload write on the emit path (rejected -- PATTERNS flags
 * that route as a D-08 violation risk), no other observation channel added to the engine.
 *
 * Uses MockModelProvider / raw ModelProvider literals (scripted claims, no API) + in-memory
 * SQLite. Harness forces consolSkipThreshold=0 so the hitl/inferred/echo hard stop — not the
 * salience gate — is the first gate that can prevent extraction (mirrors
 * tests/hitl-audit-provenance.test.ts's makeTestConfig rationale).
 */
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
import { MockEmbedder } from '../src/model/embedder';
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Embed helpers (mirrors consolidation-temporal.test.ts / echo-detection.test.ts)
// ---------------------------------------------------------------------------

/** Hash-seeded synthetic embed: same text -> same vector; different texts -> distinct vectors. */
function makeSyntheticEmbedFn(dims: number): (text: string) => Float32Array {
  return (text: string) => {
    const vec = new Float32Array(dims);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
    }
    vec[hash % dims] = 1.0;
    return vec;
  };
}

/** Zero-vector embed: cosine similarity against any non-zero node -> 0 -> auto-unrelated. */
function makeZeroEmbedFn(dims: number): (_text: string) => Float32Array {
  return (_text: string) => new Float32Array(dims);
}

/** All texts -> the same vector -> cosine similarity 1.0 between any two embedded texts. */
function makeAlwaysSameEmbedFn(dims: number): (_text: string) => Float32Array {
  return (_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  };
}

// ---------------------------------------------------------------------------
// Harness
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
    // Force every episode through the salience gate so the hitl/inferred/echo hard stop
    // is the first gate that can prevent extraction (mirrors hitl-audit-provenance.test.ts).
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.0,
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
    echoSimilarityThreshold: 0.85,
    echoRecencyWindowMs: 86_400_000, // 24h
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

/** No-op SchemaInducer: prevents LLM calls during Phase C (mirrors consolidation-temporal.test.ts). */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Construct a Consolidator with default sink/log/deriver (clock is passed explicitly). */
function makeConsolidator(h: Harness, provider: ModelProvider): Consolidator {
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
  );
}

// ---------------------------------------------------------------------------
// Decision-capture spy (test-local, instance-scoped — see file header)
// ---------------------------------------------------------------------------

/** Structural shape of the fields this file asserts on; NOT imported from consolidator.ts
 * (ClaimDecision is a module-internal, unexported interface — intentionally not widened
 * to a production export just to satisfy this test file, D-08). */
interface CapturedDecision {
  claimValue: string;
  relation: string;
  claimIntentStatus?: string;
  claimIntentEntity?: string;
  claimIntentConfidence?: string;
}

/**
 * Monkey-patches the single Consolidator instance under test so every ClaimDecision passed
 * to the private `applyDecision` method is captured before Phase B applies it. Instance-scoped
 * (not a prototype patch) so it never leaks across tests or other Consolidator instances.
 */
function attachDecisionSpy(consolidator: Consolidator): CapturedDecision[] {
  const captured: CapturedDecision[] = [];
  const target = consolidator as unknown as {
    applyDecision: (decision: CapturedDecision, episodeId: string) => void;
  };
  const original = target.applyDecision.bind(consolidator);
  target.applyDecision = (decision: CapturedDecision, episodeId: string) => {
    captured.push(decision);
    original(decision, episodeId);
  };
  return captured;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Consolidator intent-field threading — CLASSIFY-02', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── 1. Three-route threading ─────────────────────────────────────────────

  describe('three-route threading', () => {
    it('fast-path confirm: threads claimIntentStatus/Entity/Confidence onto the decision', async () => {
      const dims = h.config.embeddingDimensions;
      const embedFn = makeSyntheticEmbedFn(dims);
      const existingValue = 'Acme Corp rejected the application';
      const existingId = newId();
      h.store.upsertNode({ id: existingId, type: 'fact', value: existingValue, origin: 'observed' });
      const embedder = new MockEmbedder(embedFn);
      const [vec] = await embedder.embed([existingValue]);
      h.store.setEmbedding(existingId, vec!);

      const provider = new MockModelProvider({
        embedFn,
        generateScript: [JSON.stringify([{
          type: 'fact',
          value: existingValue, // exact match -> D-17 fast path, no judge call
          intent_status: 'rejected',
          intent_entity: 'Acme Corp',
          intent_confidence: 'high',
        }])],
        judgeScript: [],
      });
      const consolidator = makeConsolidator(h, provider);
      const captured = attachDecisionSpy(consolidator);

      h.episodes.append({
        content: 'Acme Corp rejected the application',
        origin: 'observed',
        salience: 0.9,
        hard_keep: 1,
        role: 'user',
        session_id: 'sess-fastpath-intent',
        source: 'gmail',
      });

      await consolidator.consolidate();

      expect(captured).toHaveLength(1);
      expect(captured[0]!.relation).toBe('confirm');
      expect(captured[0]!.claimIntentStatus).toBe('rejected');
      expect(captured[0]!.claimIntentEntity).toBe('Acme Corp');
      expect(captured[0]!.claimIntentConfidence).toBe('high');
    });

    it('auto-unrelated: threads claimIntentStatus/Entity/Confidence onto the decision', async () => {
      const provider = new MockModelProvider({
        embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
        generateScript: [JSON.stringify([{
          type: 'fact',
          value: 'Globex withdrew the offer',
          intent_status: 'rejected',
          intent_entity: 'Globex',
          intent_confidence: 'medium',
        }])],
        judgeScript: [], // zero-vector embed -> no candidates -> auto-unrelated, no judge call
      });
      const consolidator = makeConsolidator(h, provider);
      const captured = attachDecisionSpy(consolidator);

      h.episodes.append({
        content: 'Globex withdrew the offer',
        origin: 'observed',
        salience: 0.9,
        hard_keep: 1,
        role: 'user',
        session_id: 'sess-unrelated-intent',
        source: 'gmail',
      });

      await consolidator.consolidate();

      expect(captured).toHaveLength(1);
      expect(captured[0]!.relation).toBe('unrelated');
      expect(captured[0]!.claimIntentStatus).toBe('rejected');
      expect(captured[0]!.claimIntentEntity).toBe('Globex');
      expect(captured[0]!.claimIntentConfidence).toBe('medium');
    });

    it('judge-escalated: threads claimIntentStatus/Entity/Confidence onto the decision', async () => {
      const dims = h.config.embeddingDimensions;
      const candidateId = newId();
      const candidateValue = 'Globex application status';
      // s/c mid-range: seeded as a live node so it surfaces as a candidate.
      h.store.upsertNode({ id: candidateId, type: 'fact', value: candidateValue, origin: 'observed', s: 0.3, c: 0.6 });
      const sameEmbedFn = makeAlwaysSameEmbedFn(dims);
      const embedder = new MockEmbedder(sameEmbedFn);
      const [vec] = await embedder.embed([candidateValue]);
      h.store.setEmbedding(candidateId, vec!);

      // Same-vector embedder -> cosine 1.0 vs candidateValue, but claim.value differs from
      // candidateValue -> D-17 exact-match fast path does not fire -> escalates to judge.
      const verdict: JudgeVerdict = { best_candidate_id: candidateId, relation: 'extend', magnitude: 0.2 };
      const provider = new MockModelProvider({
        embedFn: sameEmbedFn,
        generateScript: [JSON.stringify([{
          type: 'fact',
          value: 'Globex moved application to interviewing',
          intent_status: 'interviewing',
          intent_entity: 'Globex',
          intent_confidence: 'high',
        }])],
        judgeScript: [verdict],
      });
      const consolidator = makeConsolidator(h, provider);
      const captured = attachDecisionSpy(consolidator);

      h.episodes.append({
        content: 'Globex moved application to interviewing',
        origin: 'observed',
        salience: 0.9,
        hard_keep: 1,
        role: 'user',
        session_id: 'sess-judge-intent',
        source: 'gmail',
      });

      await consolidator.consolidate();

      expect(captured).toHaveLength(1);
      expect(captured[0]!.relation).toBe('extend');
      expect(captured[0]!.claimIntentStatus).toBe('interviewing');
      expect(captured[0]!.claimIntentEntity).toBe('Globex');
      expect(captured[0]!.claimIntentConfidence).toBe('high');
    });
  });

  // ── 2. Absence passthrough ────────────────────────────────────────────────

  it('claim with no intent fields yields a decision with all three claimIntent* fields undefined (backward-compat)', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'Max prefers dark roast coffee' }])],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);
    const captured = attachDecisionSpy(consolidator);

    h.episodes.append({
      content: 'Max prefers dark roast coffee',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-no-intent',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.claimIntentStatus).toBeUndefined();
    expect(captured[0]!.claimIntentEntity).toBeUndefined();
    expect(captured[0]!.claimIntentConfidence).toBeUndefined();
  });

  // ── 3. hitl sentinel (load-bearing) ──────────────────────────────────────

  it('hitl-source episode is never classified (D-43 / CLASSIFY-02)', async () => {
    const throwingProvider: ModelProvider = {
      async generate(): Promise<never> {
        throw new Error('generate must not be called for a hitl episode');
      },
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array(h.config.embeddingDimensions));
      },
      async judge(): Promise<never> {
        throw new Error('judge must not be called for a hitl episode');
      },
      async judgeBatch(items) {
        if (items.length === 0) return [];
        throw new Error('judgeBatch must not be called for a hitl episode');
      },
    };
    const consolidator = makeConsolidator(h, throwingProvider);
    const captured = attachDecisionSpy(consolidator);

    const ep = h.episodes.append({
      // Unambiguously classify-shaped content — proves the guard, not accidental non-classification.
      content: 'We regret to inform you that your application has been rejected.',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-hitl-intent',
      source: 'hitl',
    });

    const nodesBefore = (h.db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;
    const edgesBefore = (h.db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;

    // Real consolidate() pass completes without throwing — proves no extraction was
    // attempted (the throwing provider would surface as a rejected promise otherwise).
    await expect(consolidator.consolidate()).resolves.toBeUndefined();

    const refreshed = h.episodes.getEpisode(ep.id);
    expect(refreshed?.consolidated).toBe(1);

    const nodesAfter = (h.db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;
    const edgesAfter = (h.db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
    expect(nodesAfter).toBe(nodesBefore);
    expect(edgesAfter).toBe(edgesBefore);

    expect(captured).toHaveLength(0);
  });

  // ── 4. inferred + echo sentinels ─────────────────────────────────────────

  it('inferred-origin episode is never classified (D-09 / CLASSIFY-02)', async () => {
    const throwingProvider: ModelProvider = {
      async generate(): Promise<never> {
        throw new Error('generate must not be called for an inferred-origin episode');
      },
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array(h.config.embeddingDimensions));
      },
      async judge(): Promise<never> {
        throw new Error('judge must not be called for an inferred-origin episode');
      },
      async judgeBatch(items) {
        if (items.length === 0) return [];
        throw new Error('judgeBatch must not be called for an inferred-origin episode');
      },
    };
    const consolidator = makeConsolidator(h, throwingProvider);
    const captured = attachDecisionSpy(consolidator);

    const ep = h.episodes.append({
      content: 'Ephemeral inference: Acme application likely rejected',
      origin: 'inferred',
      salience: 0.9,
      hard_keep: 1,
      role: 'assistant',
      session_id: 'sess-inferred-intent',
    });

    await expect(consolidator.consolidate()).resolves.toBeUndefined();

    const refreshed = h.episodes.getEpisode(ep.id);
    expect(refreshed?.consolidated).toBe(1);
    expect(captured).toHaveLength(0);
  });

  it('echo episode (backfilled source_inference_id) is never classified (D-09 / CLASSIFY-02)', async () => {
    const dims = h.config.embeddingDimensions;
    const sameEmbedFn = makeAlwaysSameEmbedFn(dims);

    // Seed a recent inferred episode so detectEcho has something to match against.
    h.episodes.append({
      content: 'Ephemeral inference: Acme application likely rejected',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'sess-echo-inference',
    });

    h.clock.advanceMs(1_000); // well within echoRecencyWindowMs

    // isEligibleForExtraction cannot see echo (async-only signal, see its header comment) —
    // this observed-origin episode IS included in the Phase A prefetch pool and generate()
    // IS called on it (a "wasted prefetch", by design). The scripted response carries intent
    // fields so that IF the hard stop failed to short-circuit, the threading assertion below
    // would catch it — proving the guard discards the extraction rather than never running it.
    const provider = new MockModelProvider({
      embedFn: sameEmbedFn,
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Acme application rejected',
        intent_status: 'rejected',
        intent_entity: 'Acme',
        intent_confidence: 'high',
      }])],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);
    const captured = attachDecisionSpy(consolidator);

    // Same-vector embedder -> cosine 1.0 against the inferred episode -> echo detected
    // regardless of content, within echoRecencyWindowMs (D-44/D-45).
    const echoEp = h.episodes.append({
      content: 'Acme application rejected -- identical echo turn',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-echo-turn',
      source: 'gmail',
    });

    await consolidator.consolidate();

    const refreshed = h.episodes.getEpisode(echoEp.id);
    expect(refreshed?.source_inference_id).not.toBeNull();
    expect(refreshed?.consolidated).toBe(1);
    // Zero decisions produced despite a scripted, intent-carrying extraction being available —
    // proves the echo arm of the hard stop discards it (Pitfall 6: inherited, not re-implemented).
    expect(captured).toHaveLength(0);
  });

  // ── 5. One-generate-call sentinel (D-12a, Pitfall 15) ────────────────────

  it('exactly one provider.generate call per gmail episode -- single episode', async () => {
    let generateCallCount = 0;
    const countingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array(h.config.embeddingDimensions));
      },
      async generate(): Promise<string> {
        generateCallCount++;
        return JSON.stringify([{
          type: 'fact',
          value: 'Acme rejected the application',
          intent_status: 'rejected',
          intent_entity: 'Acme',
          intent_confidence: 'high',
        }]);
      },
      async judge(): Promise<never> {
        throw new Error('judge should not be called in the one-generate-call sentinel');
      },
      async judgeBatch(items) {
        if (items.length === 0) return [];
        throw new Error('judgeBatch should not be called in the one-generate-call sentinel');
      },
    };
    const consolidator = makeConsolidator(h, countingProvider);

    h.episodes.append({
      content: 'Acme rejected the application',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-one-call',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(generateCallCount).toBe(1);
  });

  it('exactly one provider.generate call per gmail episode -- two episodes (per-episode, not constant)', async () => {
    let generateCallCount = 0;
    const countingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array(h.config.embeddingDimensions));
      },
      async generate(): Promise<string> {
        generateCallCount++;
        return JSON.stringify([{ type: 'fact', value: `claim from call ${generateCallCount}` }]);
      },
      async judge(): Promise<never> {
        throw new Error('judge should not be called in the one-generate-call sentinel');
      },
      async judgeBatch(items) {
        if (items.length === 0) return [];
        throw new Error('judgeBatch should not be called in the one-generate-call sentinel');
      },
    };
    const consolidator = makeConsolidator(h, countingProvider);

    h.episodes.append({
      content: 'Globex moved application to interviewing',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-two-calls-a',
      source: 'gmail',
    });
    h.episodes.append({
      content: 'Initech extended an offer',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-two-calls-b',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(generateCallCount).toBe(2);
  });
});
