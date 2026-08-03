/**
 * End-to-end resolution suite — Phase 64, Plan 03, Task 2.
 *
 * Proves RESOLVE-01/02/03 through the REAL `consolidate()` path (not against
 * `EntityResolver` in isolation, which `tests/entity-resolution.test.ts` already covers at the
 * unit level) — i.e. that the Task 1 wiring in `src/consolidation/consolidator.ts` actually
 * threads a resolved entity id/descriptor onto the in-memory `ClaimDecision` for a gmail
 * episode, across all three decision routes (fast-path confirm, auto-unrelated,
 * judge-escalated), and that the all-or-nothing contract (D-07) holds everywhere.
 *
 * REVIEW-BLOCKING: the all-or-nothing invariant assertion (looped over every captured decision)
 * is the D-07 guard this file exists to prove. Loosening it to a per-case check only, or
 * removing it, silently reopens the "one field without the other" defect class the plan calls
 * out explicitly. Do not narrow it without a corresponding CONTEXT.md decision update.
 *
 * Harness copied verbatim from tests/consolidation-intent.test.ts (that file exports nothing —
 * duplication is the established convention in this phase, see tests/intent-source-gate.test.ts's
 * header for the same note), extended with:
 *   - entityResolutionFloor / entityResolutionMargin set explicitly (not relying on the shipped
 *     DEFAULT_CONFIG values) so abstain-vs-resolve is deterministic per case.
 *   - bm25CandidateK: 0 — disables ONLY the consolidator's own outer union-generator BM25 pass
 *     (Phase 46 D-07 dark-knob), which would otherwise FTS-match a seeded entity node's name
 *     against claim text and accidentally escalate an intended auto-unrelated case to judge.
 *     This does NOT touch EntityResolver's own internal BM25 channel (entity-resolution.ts has
 *     no dependency on this config field at all), so resolution-outcome tests are unaffected.
 *   - salience: 1.0 / hard_keep: 1 on every appended episode + consolSkipThresholdBySource.gmail
 *     neutralized, so no gmail episode is salience-skipped before reaching the branch under test.
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
import { NoopConsolidationSink } from '../src/consolidation/sink';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Embed helpers (copied from tests/consolidation-intent.test.ts)
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

/** All-zero vector of the harness embedding dimension — used to seed entities with a dense
 * channel that structurally contributes nothing, so resolution outcomes are lexically driven. */
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

function makeHarness(): Harness {
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
      // consolSkipThresholdBySource.gmail (0.4) wins over the flat threshold above — neutralize
      // it explicitly so no gmail episode is skipped before reaching the resolution branch.
      consolSkipThresholdBySource: { gmail: 0.0 },
    },
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
    echoSimilarityThreshold: 0.85,
    echoRecencyWindowMs: 86_400_000, // 24h
    // RESOLVE-03: explicit, not relied-upon-default — deterministic abstain-vs-resolve per case.
    entityResolutionFloor: 0.75,
    entityResolutionMargin: 0.15,
    // Phase 46 D-07 dark knob: disables ONLY the consolidator's own outer BM25 union pass (see
    // file header) — EntityResolver's internal BM25 channel is untouched by this field.
    bm25CandidateK: 0,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

/** No-op SchemaInducer: prevents LLM calls during Phase C. */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Construct a Consolidator with default sink/deriver (clock is passed explicitly). */
function makeConsolidator(h: Harness, provider: ModelProvider): Consolidator {
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
  );
}

/** Construct a Consolidator with a custom log sink — used to observe the RESOLVE-64 line. */
function makeConsolidatorWithLog(h: Harness, provider: ModelProvider, log: (msg: string) => void): Consolidator {
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    new NoopConsolidationSink(), log,
  );
}

/** Seed an entity node through the real upsert primitive (populates node_fts like production).
 * Passing `vec` explicitly (even a zero vector) prevents Phase A's reembedDirty() from later
 * assigning it an embedding derived from the harness's own embedFn (embedded_hash would no
 * longer be NULL) — this is what makes "seed zero embeddings, let dense contribute nothing"
 * (plan instruction) actually hold regardless of which embedFn the test's provider uses. */
function seedEntity(h: Harness, value: string, vec: Float32Array): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'entity', value, origin: 'observed' });
  h.store.setEmbedding(id, vec);
  return id;
}

// ---------------------------------------------------------------------------
// Decision-capture spy (test-local, instance-scoped — see tests/consolidation-intent.test.ts
// header for the full rationale: ClaimDecision is module-internal/unexported by design, D-08)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Consolidator end-to-end entity resolution — RESOLVE-01/02/03', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── Route 1: fast-path confirm ───────────────────────────────────────────

  it('gmail, fast-path confirm route: resolves claimIntentEntity to the seeded entity node', async () => {
    const dims = h.config.embeddingDimensions;
    const embedFn = makeSyntheticEmbedFn(dims);
    const existingValue = 'Acme Corp rejected the application';
    const existingId = newId();
    h.store.upsertNode({ id: existingId, type: 'fact', value: existingValue, origin: 'observed' });
    const embedder = new MockEmbedder(embedFn);
    const [vec] = await embedder.embed([existingValue]);
    h.store.setEmbedding(existingId, vec!);

    const entityId = seedEntity(h, 'Acme Corp', zeroVec(dims));

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
      content: existingValue,
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-fastpath-resolve',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.relation).toBe('confirm');
    // Input untouched (D-07): the raw descriptor the extraction emitted is still there.
    expect(captured[0]!.claimIntentEntity).toBe('Acme Corp');
    // Output: resolved to the seeded node, descriptor exact (D-08 — never normalized/reconstructed).
    expect(captured[0]!.claimResolvedEntityId).toBe(entityId);
    expect(captured[0]!.claimResolvedEntityDescriptor).toBe('Acme Corp');
  });

  // ── Route 2: auto-unrelated ──────────────────────────────────────────────

  it('gmail, auto-unrelated route: resolves claimIntentEntity to the seeded entity node', async () => {
    const dims = h.config.embeddingDimensions;
    const entityId = seedEntity(h, 'Globex', zeroVec(dims));

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Globex withdrew the offer',
        intent_status: 'rejected',
        intent_entity: 'Globex',
        intent_confidence: 'medium',
      }])],
      // Zero-vector embed -> no cosine candidate clears the threshold, no anchors, and BM25 is
      // disabled at the consolidator's own union layer (bm25CandidateK: 0) -> auto-unrelated.
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);
    const captured = attachDecisionSpy(consolidator);

    h.episodes.append({
      content: 'Globex withdrew the offer',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-unrelated-resolve',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.relation).toBe('unrelated');
    expect(captured[0]!.claimIntentEntity).toBe('Globex');
    expect(captured[0]!.claimResolvedEntityId).toBe(entityId);
    expect(captured[0]!.claimResolvedEntityDescriptor).toBe('Globex');
  });

  // ── Route 3: judge-escalated ─────────────────────────────────────────────
  // Proves the branch covers the post-judge fill, not just the two synchronous routes.

  it('gmail, judge-escalated route: resolves claimIntentEntity to the seeded entity node', async () => {
    const dims = h.config.embeddingDimensions;
    const candidateId = newId();
    const candidateValue = 'Globex application status';
    h.store.upsertNode({ id: candidateId, type: 'fact', value: candidateValue, origin: 'observed', s: 0.3, c: 0.6 });
    const sameEmbedFn = makeAlwaysSameEmbedFn(dims);
    const embedder = new MockEmbedder(sameEmbedFn);
    const [vec] = await embedder.embed([candidateValue]);
    h.store.setEmbedding(candidateId, vec!);

    const entityId = seedEntity(h, 'Globex', zeroVec(dims));

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
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-judge-resolve',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.relation).toBe('extend');
    expect(captured[0]!.claimIntentEntity).toBe('Globex');
    expect(captured[0]!.claimResolvedEntityId).toBe(entityId);
    expect(captured[0]!.claimResolvedEntityDescriptor).toBe('Globex');
  });

  // ── Unknown entity: abstain, no mint ─────────────────────────────────────

  it('gmail episode naming an untracked entity: both resolved fields absent, no node minted', async () => {
    const dims = h.config.embeddingDimensions;
    seedEntity(h, 'Acme Corp', zeroVec(dims)); // only Acme Corp is tracked

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Zzyzx Robotics rejected the application',
        intent_status: 'rejected',
        intent_entity: 'Zzyzx Robotics',
        intent_confidence: 'high',
      }])],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);
    const captured = attachDecisionSpy(consolidator);

    h.episodes.append({
      content: 'Zzyzx Robotics rejected the application',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-unknown-entity',
      source: 'gmail',
    });

    const mintedBefore = (h.db.prepare(
      `SELECT COUNT(*) AS n FROM node WHERE type = 'entity' AND value = 'Zzyzx Robotics'`
    ).get() as { n: number }).n;

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    // Input still threaded (extraction genuinely emitted it) — only the OUTPUT is absent.
    expect(captured[0]!.claimIntentEntity).toBe('Zzyzx Robotics');
    expect(captured[0]!.claimResolvedEntityId).toBeUndefined();
    expect(captured[0]!.claimResolvedEntityDescriptor).toBeUndefined();

    const mintedAfter = (h.db.prepare(
      `SELECT COUNT(*) AS n FROM node WHERE type = 'entity' AND value = 'Zzyzx Robotics'`
    ).get() as { n: number }).n;
    expect(mintedBefore).toBe(0);
    expect(mintedAfter).toBe(0); // D-12: resolution never mints on a miss
  });

  // ── No intent fields: zero resolution cost ───────────────────────────────

  it('gmail episode whose claim carries no intent fields: no resolved fields, zero resolution attempts', async () => {
    const dims = h.config.embeddingDimensions;
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'Max prefers dark roast coffee' }])],
      judgeScript: [],
    });

    const logLines: string[] = [];
    const consolidator = makeConsolidatorWithLog(h, provider, (msg) => logLines.push(msg));
    const captured = attachDecisionSpy(consolidator);

    h.episodes.append({
      content: 'Max prefers dark roast coffee',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-no-intent-resolve',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.claimIntentEntity).toBeUndefined();
    expect(captured[0]!.claimResolvedEntityId).toBeUndefined();
    expect(captured[0]!.claimResolvedEntityDescriptor).toBeUndefined();

    const resolveLine = logLines.find((l) => l.startsWith('RESOLVE-64'));
    expect(resolveLine).toBeDefined();
    expect(resolveLine).toContain('attempts=0');
    expect(resolveLine).toContain('hits=0');
    expect(resolveLine).toContain('abstains=0');
  });

  // ── Near-duplicate separation ─────────────────────────────────────────────

  it('near-duplicate: resolves to the exact-match entity, never to the near-duplicate', async () => {
    const dims = h.config.embeddingDimensions;
    const acmeCorpId = seedEntity(h, 'Acme Corp', zeroVec(dims));
    seedEntity(h, 'Acme Consulting', zeroVec(dims));

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Acme Corp rejected the application',
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
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-near-duplicate',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.claimResolvedEntityId).toBe(acmeCorpId);
    expect(captured[0]!.claimResolvedEntityDescriptor).toBe('Acme Corp');
  });

  // ── Descriptor identity ───────────────────────────────────────────────────
  // D-08 / RESOLVE-03: the resolved descriptor is the node's own canonical `value` verbatim —
  // never lowercased, trimmed, or reconstructed. Uses a mixed-case, punctuated entity name so a
  // silent normalization bug (e.g. accidentally returning the query descriptor instead of the
  // node's value) would be caught even if the two strings happened to be equal case-insensitively.

  it('descriptor identity: claimResolvedEntityDescriptor is the seeded node value verbatim, not normalized', async () => {
    const dims = h.config.embeddingDimensions;
    const entityValue = 'Stripe, Inc.';
    const entityId = seedEntity(h, entityValue, zeroVec(dims));

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Stripe, Inc. extended an offer',
        intent_status: 'offer',
        intent_entity: entityValue,
        intent_confidence: 'high',
      }])],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);
    const captured = attachDecisionSpy(consolidator);

    h.episodes.append({
      content: 'Stripe, Inc. extended an offer',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-descriptor-identity',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.claimResolvedEntityId).toBe(entityId);
    // toBe, not toEqual/toMatch: exact character-for-character identity is the contract.
    expect(captured[0]!.claimResolvedEntityDescriptor).toBe(entityValue);
  });

  // ── All-or-nothing invariant, asserted over every decision in a single multi-route pass ──

  it('all-or-nothing invariant: every captured decision across a mixed-route pass has both resolved fields present or both absent', async () => {
    const dims = h.config.embeddingDimensions;
    seedEntity(h, 'Acme Corp', zeroVec(dims));
    seedEntity(h, 'Globex', zeroVec(dims));
    // 'Zzyzx Robotics' is deliberately NOT seeded (untracked -> abstain case).

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(dims),
      generateScript: [
        JSON.stringify([{
          type: 'fact', value: 'Acme Corp rejected the application',
          intent_status: 'rejected', intent_entity: 'Acme Corp', intent_confidence: 'high',
        }]),
        JSON.stringify([{
          type: 'fact', value: 'Globex withdrew the offer',
          intent_status: 'rejected', intent_entity: 'Globex', intent_confidence: 'medium',
        }]),
        JSON.stringify([{
          type: 'fact', value: 'Zzyzx Robotics rejected the application',
          intent_status: 'rejected', intent_entity: 'Zzyzx Robotics', intent_confidence: 'high',
        }]),
        JSON.stringify([{ type: 'fact', value: 'Max prefers dark roast coffee' }]), // no intent fields
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);
    const captured = attachDecisionSpy(consolidator);

    h.episodes.append({
      content: 'Acme Corp rejected the application', origin: 'observed', salience: 1.0,
      hard_keep: 1, role: 'user', session_id: 'sess-mix-1', source: 'gmail',
    });
    h.episodes.append({
      content: 'Globex withdrew the offer', origin: 'observed', salience: 1.0,
      hard_keep: 1, role: 'user', session_id: 'sess-mix-2', source: 'gmail',
    });
    h.episodes.append({
      content: 'Zzyzx Robotics rejected the application', origin: 'observed', salience: 1.0,
      hard_keep: 1, role: 'user', session_id: 'sess-mix-3', source: 'gmail',
    });
    h.episodes.append({
      content: 'Max prefers dark roast coffee', origin: 'observed', salience: 1.0,
      hard_keep: 1, role: 'user', session_id: 'sess-mix-4', source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(4);
    // D-07: loop over EVERY captured decision, not a case-by-case check.
    for (const decision of captured) {
      const hasId = decision.claimResolvedEntityId !== undefined;
      const hasDescriptor = decision.claimResolvedEntityDescriptor !== undefined;
      expect(hasId).toBe(hasDescriptor);
    }
    // Sanity: at least one hit and at least one abstain are actually present in this pass,
    // so the loop above is not vacuously true over an all-absent or all-present set.
    const hits = captured.filter((d) => d.claimResolvedEntityId !== undefined);
    const abstains = captured.filter((d) => d.claimResolvedEntityId === undefined);
    expect(hits.length).toBeGreaterThan(0);
    expect(abstains.length).toBeGreaterThan(0);
    // The raw input field is never overwritten by the output, across every decision that had one.
    expect(captured[0]!.claimIntentEntity).toBe('Acme Corp');
    expect(captured[1]!.claimIntentEntity).toBe('Globex');
    expect(captured[2]!.claimIntentEntity).toBe('Zzyzx Robotics');
    expect(captured[3]!.claimIntentEntity).toBeUndefined();
  });
});
