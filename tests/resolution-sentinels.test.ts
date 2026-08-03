/**
 * Sentinel suite — Phase 64, Plan 03, Task 3.
 *
 * Structural evidence for:
 *  - D-03 (guard inheritance by construction): hitl/inferred/echo episodes never reach the
 *    resolution branch — Pitfall 6 names this exact defect class ("an independent scan
 *    silently fails to inherit the guard") as having shipped twice before in this codebase.
 *  - D-10 (WR-01 source gating blocks RESOLUTION, not just threading): a non-gmail episode
 *    whose extraction response smuggles intent fields must not resolve, even against a tracked
 *    entity that WOULD resolve cleanly had the fields been threaded. The paired gmail positive
 *    control in the same test proves the negative case is not vacuous — that resolution IS
 *    reachable and DOES fire for the identical scripted response over the same seeded node,
 *    just not from the gated source.
 *  - D-04 (zero net-new provider calls): the strongest form of this guarantee is TYPE-LEVEL —
 *    `EntityResolver`'s constructor takes no `ModelProvider` (see entity-resolution.ts
 *    constructor JSDoc) — so this module cannot call a provider even by accident. The runtime
 *    call-count equality asserted below is the belt to that type-level suspenders, not the
 *    primary defense.
 *
 * LOOSENING ANY ASSERTION HERE RE-OPENS: (a) the guard-inheritance defect class (D-03/Pitfall 6),
 * (b) the WR-01 prompt-injection path into Phase 64 resolution (D-10), or (c) an undetected
 * provider-call regression in the resolution branch (D-04). This file is review-blocking.
 *
 * Harness copied from tests/consolidation-resolution.test.ts (itself copied from
 * tests/consolidation-intent.test.ts / tests/intent-source-gate.test.ts — this file exports
 * nothing, duplication is the established convention across this phase).
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
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Embed helpers
// ---------------------------------------------------------------------------

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

function makeAlwaysSameEmbedFn(dims: number): (_text: string) => Float32Array {
  return (_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  };
}

function zeroVec(dims: number): Float32Array {
  return new Float32Array(dims);
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

function makeHarness(configOverrides: Partial<EngineConfig> = {}): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.0,
    salience: {
      ...DEFAULT_CONFIG.salience,
      consolSkipThresholdBySource: { gmail: 0.0 },
    },
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
    echoSimilarityThreshold: 0.85,
    echoRecencyWindowMs: 86_400_000, // 24h
    entityResolutionFloor: 0.75,
    entityResolutionMargin: 0.15,
    bm25CandidateK: 0, // see tests/consolidation-resolution.test.ts header — isolates outer BM25
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
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

function makeConsolidator(h: Harness, provider: ModelProvider): Consolidator {
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
  );
}

function seedEntity(h: Harness, value: string, vec: Float32Array): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'entity', value, origin: 'observed' });
  h.store.setEmbedding(id, vec);
  return id;
}

// ---------------------------------------------------------------------------
// Decision-capture spy
// ---------------------------------------------------------------------------

interface CapturedDecision {
  claimValue: string;
  relation: string;
  claimIntentStatus?: string;
  claimIntentEntity?: string;
  claimIntentConfidence?: string;
  claimResolvedEntityId?: string;
  claimResolvedEntityDescriptor?: string;
}

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

function countRows(db: Database.Database, table: 'node' | 'edge'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Resolution sentinels — D-03 guard inheritance, D-10 source gating, D-04 zero net-new calls', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── D-03: hard-stop guard inheritance ────────────────────────────────────

  describe('hard-stop inheritance (D-03 / Pitfall 6)', () => {
    it('hitl-source episode carrying intent fields: no decision, no resolution, graph unchanged', async () => {
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
      seedEntity(h, 'Acme Corp', zeroVec(h.config.embeddingDimensions));
      const consolidator = makeConsolidator(h, throwingProvider);
      const captured = attachDecisionSpy(consolidator);

      const nodesBefore = countRows(h.db, 'node');
      const edgesBefore = countRows(h.db, 'edge');

      const ep = h.episodes.append({
        content: 'We regret to inform you that your application has been rejected.',
        origin: 'observed',
        salience: 1.0,
        hard_keep: 1,
        role: 'user',
        session_id: 'sess-hitl-resolve',
        source: 'hitl',
      });

      await expect(consolidator.consolidate()).resolves.toBeUndefined();

      expect(h.episodes.getEpisode(ep.id)?.consolidated).toBe(1);
      expect(countRows(h.db, 'node')).toBe(nodesBefore);
      expect(countRows(h.db, 'edge')).toBe(edgesBefore);
      // No decision was ever produced, so there is nothing for the resolver to have touched —
      // both intent and resolved-entity fields are, by construction, absent.
      expect(captured).toHaveLength(0);
    });

    it('inferred-origin episode carrying intent fields: no decision, no resolution, graph unchanged', async () => {
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
      seedEntity(h, 'Acme Corp', zeroVec(h.config.embeddingDimensions));
      const consolidator = makeConsolidator(h, throwingProvider);
      const captured = attachDecisionSpy(consolidator);

      const nodesBefore = countRows(h.db, 'node');
      const edgesBefore = countRows(h.db, 'edge');

      const ep = h.episodes.append({
        content: 'Ephemeral inference: Acme Corp application likely rejected',
        origin: 'inferred',
        salience: 1.0,
        hard_keep: 1,
        role: 'assistant',
        session_id: 'sess-inferred-resolve',
      });

      await expect(consolidator.consolidate()).resolves.toBeUndefined();

      expect(h.episodes.getEpisode(ep.id)?.consolidated).toBe(1);
      expect(countRows(h.db, 'node')).toBe(nodesBefore);
      expect(countRows(h.db, 'edge')).toBe(edgesBefore);
      expect(captured).toHaveLength(0);
    });

    it('echo episode (backfilled source_inference_id) carrying intent fields: no decision, no resolution, graph unchanged', async () => {
      const dims = h.config.embeddingDimensions;
      const sameEmbedFn = makeAlwaysSameEmbedFn(dims);
      seedEntity(h, 'Acme Corp', zeroVec(dims));

      // Seed a recent inferred episode so detectEcho has something to match against.
      h.episodes.append({
        content: 'Ephemeral inference: Acme Corp application likely rejected',
        origin: 'inferred',
        salience: 0,
        hard_keep: 0,
        role: 'assistant',
        session_id: 'sess-echo-inference-resolve',
      });
      h.clock.advanceMs(1_000); // well within echoRecencyWindowMs

      const provider = new MockModelProvider({
        embedFn: sameEmbedFn,
        generateScript: [JSON.stringify([{
          type: 'fact',
          value: 'Acme Corp application rejected',
          intent_status: 'rejected',
          intent_entity: 'Acme Corp',
          intent_confidence: 'high',
        }])],
        judgeScript: [],
      });
      const consolidator = makeConsolidator(h, provider);
      const captured = attachDecisionSpy(consolidator);

      const nodesBefore = countRows(h.db, 'node');
      const edgesBefore = countRows(h.db, 'edge');

      // Same-vector embedder -> cosine 1.0 against the inferred episode -> echo detected.
      const echoEp = h.episodes.append({
        content: 'Acme Corp application rejected -- identical echo turn',
        origin: 'observed',
        salience: 1.0,
        hard_keep: 1,
        role: 'user',
        session_id: 'sess-echo-turn-resolve',
        source: 'gmail',
      });

      await consolidator.consolidate();

      const refreshed = h.episodes.getEpisode(echoEp.id);
      expect(refreshed?.source_inference_id).not.toBeNull();
      expect(refreshed?.consolidated).toBe(1);
      expect(countRows(h.db, 'node')).toBe(nodesBefore);
      expect(countRows(h.db, 'edge')).toBe(edgesBefore);
      // Zero decisions produced despite a scripted, intent-carrying, resolvable extraction being
      // available -- proves the echo arm of the hard stop discards it before resolution ever runs.
      expect(captured).toHaveLength(0);
    });
  });

  // ── D-10: WR-01 non-gmail smuggling blocks RESOLUTION, not just threading ──

  describe('WR-01 non-gmail smuggling blocks resolution (D-10)', () => {
    it('non-gmail source smuggling intent fields against a resolvable seeded entity: no threading, no resolution — paired with a gmail positive control that DOES resolve', async () => {
      const dims = h.config.embeddingDimensions;
      const embedFn = makeSyntheticEmbedFn(dims);
      const existingValue = 'Acme Corp rejected the application';

      const scriptedResponse = JSON.stringify([{
        type: 'fact',
        value: existingValue,
        intent_status: 'rejected',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      }]);

      // ── Negative case: source='claude-code' ──
      {
        const existingId = newId();
        h.store.upsertNode({ id: existingId, type: 'fact', value: existingValue, origin: 'observed' });
        const embedder = new MockEmbedder(embedFn);
        const [vec] = await embedder.embed([existingValue]);
        h.store.setEmbedding(existingId, vec!);
        // The seeded entity WOULD resolve cleanly if the fields were threaded — this is the
        // point of the paired positive control below.
        seedEntity(h, 'Acme Corp', zeroVec(dims));

        const provider = new MockModelProvider({ embedFn, generateScript: [scriptedResponse], judgeScript: [] });
        const consolidator = makeConsolidator(h, provider);
        const captured = attachDecisionSpy(consolidator);

        h.episodes.append({
          content: existingValue,
          origin: 'observed',
          salience: 1.0,
          hard_keep: 1,
          role: 'user',
          session_id: 'sess-wr01-negative',
          source: 'claude-code',
        });

        await consolidator.consolidate();

        expect(captured).toHaveLength(1);
        expect(captured[0]!.relation).toBe('confirm');
        // D-10: the gate blocked threading -- not the resolver's own abstain path.
        expect(captured[0]!.claimIntentStatus).toBeUndefined();
        expect(captured[0]!.claimIntentEntity).toBeUndefined();
        expect(captured[0]!.claimIntentConfidence).toBeUndefined();
        expect(captured[0]!.claimResolvedEntityId).toBeUndefined();
        expect(captured[0]!.claimResolvedEntityDescriptor).toBeUndefined();
      }

      // ── Positive control: identical scripted response, source='gmail', fresh harness ──
      {
        const h2 = makeHarness();
        const existingId = newId();
        h2.store.upsertNode({ id: existingId, type: 'fact', value: existingValue, origin: 'observed' });
        const embedder = new MockEmbedder(embedFn);
        const [vec] = await embedder.embed([existingValue]);
        h2.store.setEmbedding(existingId, vec!);
        const entityId = (() => {
          const id = newId();
          h2.store.upsertNode({ id, type: 'entity', value: 'Acme Corp', origin: 'observed' });
          h2.store.setEmbedding(id, zeroVec(dims));
          return id;
        })();

        const provider2 = new MockModelProvider({ embedFn, generateScript: [scriptedResponse], judgeScript: [] });
        const consolidator2 = makeConsolidator(h2, provider2);
        const captured2 = attachDecisionSpy(consolidator2);

        h2.episodes.append({
          content: existingValue,
          origin: 'observed',
          salience: 1.0,
          hard_keep: 1,
          role: 'user',
          session_id: 'sess-wr01-positive',
          source: 'gmail',
        });

        await consolidator2.consolidate();

        expect(captured2).toHaveLength(1);
        expect(captured2[0]!.relation).toBe('confirm');
        // Same scripted response, gmail source -> threading AND resolution both fire, proving
        // the negative case above is not vacuous (threading/resolution genuinely work end-to-end).
        expect(captured2[0]!.claimIntentEntity).toBe('Acme Corp');
        expect(captured2[0]!.claimResolvedEntityId).toBe(entityId);
        expect(captured2[0]!.claimResolvedEntityDescriptor).toBe('Acme Corp');
      }
    });
  });

  // ── D-04: zero net-new provider calls (runtime belt to the type-level suspenders) ──

  describe('zero net-new provider calls (D-04)', () => {
    function makeCountingProvider(dims: number, generateResponse: string) {
      const counts = { embed: 0, generate: 0, judge: 0, judgeBatch: 0 };
      const provider: ModelProvider = {
        async embed(texts: string[]): Promise<Float32Array[]> {
          counts.embed++;
          return texts.map(() => new Float32Array(dims));
        },
        async generate(): Promise<string> {
          counts.generate++;
          return generateResponse;
        },
        async judge(): Promise<never> {
          counts.judge++;
          throw new Error('judge should not be called in this sentinel');
        },
        async judgeBatch(items) {
          counts.judgeBatch++;
          if (items.length === 0) return [];
          throw new Error('judgeBatch should not be called in this sentinel');
        },
      };
      return { provider, counts };
    }

    it('provider call counts (embed/generate/judge/judgeBatch) are identical between a resolving run and an entityResolutionFloor:2 (disabled) control run over identical input', async () => {
      const dims = DEFAULT_CONFIG.embeddingDimensions;
      const content = 'Acme Corp rejected the application';
      const scriptedResponse = JSON.stringify([{
        type: 'fact',
        value: content,
        intent_status: 'rejected',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      }]);

      // Resolving run: default entityResolutionFloor (0.75) — the seeded entity resolves.
      const hResolve = makeHarness();
      seedEntity(hResolve, 'Acme Corp', zeroVec(dims));
      const { provider: resolveProvider, counts: resolveCounts } = makeCountingProvider(dims, scriptedResponse);
      const resolveConsolidator = makeConsolidator(hResolve, resolveProvider);
      const capturedResolve = attachDecisionSpy(resolveConsolidator);

      hResolve.episodes.append({
        content, origin: 'observed', salience: 1.0, hard_keep: 1,
        role: 'user', session_id: 'sess-provider-count-resolve', source: 'gmail',
      });
      await resolveConsolidator.consolidate();

      expect(capturedResolve).toHaveLength(1);
      expect(capturedResolve[0]!.claimResolvedEntityId).toBeDefined(); // sanity: this run DID resolve

      // Control run: entityResolutionFloor: 2 — the documented disable value (64-02) —
      // every resolve abstains ('below-floor'), on an otherwise byte-identical input.
      const hControl = makeHarness({ entityResolutionFloor: 2 });
      seedEntity(hControl, 'Acme Corp', zeroVec(dims));
      const { provider: controlProvider, counts: controlCounts } = makeCountingProvider(dims, scriptedResponse);
      const controlConsolidator = makeConsolidator(hControl, controlProvider);
      const capturedControl = attachDecisionSpy(controlConsolidator);

      hControl.episodes.append({
        content, origin: 'observed', salience: 1.0, hard_keep: 1,
        role: 'user', session_id: 'sess-provider-count-control', source: 'gmail',
      });
      await controlConsolidator.consolidate();

      expect(capturedControl).toHaveLength(1);
      expect(capturedControl[0]!.claimResolvedEntityId).toBeUndefined(); // sanity: control abstained

      // The actual D-04 claim: equal counts across ALL FOUR provider methods.
      expect(resolveCounts.embed).toBe(controlCounts.embed);
      expect(resolveCounts.generate).toBe(controlCounts.generate);
      expect(resolveCounts.judge).toBe(controlCounts.judge);
      expect(resolveCounts.judgeBatch).toBe(controlCounts.judgeBatch);

      // Single-episode, fast-path route -> exactly one extraction call, no judge escalation.
      expect(resolveCounts.generate).toBe(1);
      expect(resolveCounts.judge).toBe(0);
    });

    it('provider.embed call count is identical whether or not the claim carrying claimIntentEntity resolves (dense channel reuses the already-computed claim vector, no new embed call)', async () => {
      const dims = DEFAULT_CONFIG.embeddingDimensions;
      // Auto-unrelated route (zero embed via makeCountingProvider below) so the claim's own
      // vector is trivially known, and the resolution branch's `vec: claimVecs[i]` reuses it
      // rather than triggering a fresh embed.
      const content = 'Globex withdrew the offer';
      const scriptedResponse = JSON.stringify([{
        type: 'fact',
        value: content,
        intent_status: 'rejected',
        intent_entity: 'Globex',
        intent_confidence: 'medium',
      }]);

      const hResolve = makeHarness();
      seedEntity(hResolve, 'Globex', zeroVec(dims));
      const { provider: resolveProvider, counts: resolveCounts } = makeCountingProvider(dims, scriptedResponse);
      // Override embed to the zero fn (makeCountingProvider's embed already returns zero vectors
      // but let's keep it explicit and reuse the same counting shape).
      const resolveConsolidator = makeConsolidator(hResolve, resolveProvider);
      const capturedResolve = attachDecisionSpy(resolveConsolidator);
      hResolve.episodes.append({
        content, origin: 'observed', salience: 1.0, hard_keep: 1,
        role: 'user', session_id: 'sess-embed-count-resolve', source: 'gmail',
      });
      await resolveConsolidator.consolidate();
      expect(capturedResolve).toHaveLength(1);
      expect(capturedResolve[0]!.claimResolvedEntityId).toBeDefined();

      const hControl = makeHarness({ entityResolutionFloor: 2 });
      seedEntity(hControl, 'Globex', zeroVec(dims));
      const { provider: controlProvider, counts: controlCounts } = makeCountingProvider(dims, scriptedResponse);
      const controlConsolidator = makeConsolidator(hControl, controlProvider);
      const capturedControl = attachDecisionSpy(controlConsolidator);
      hControl.episodes.append({
        content, origin: 'observed', salience: 1.0, hard_keep: 1,
        role: 'user', session_id: 'sess-embed-count-control', source: 'gmail',
      });
      await controlConsolidator.consolidate();
      expect(capturedControl).toHaveLength(1);
      expect(capturedControl[0]!.claimResolvedEntityId).toBeUndefined();

      expect(resolveCounts.embed).toBe(controlCounts.embed);
    });
  });
});
