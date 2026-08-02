/**
 * Structural closure of 63-VERIFICATION WR-01 per 64-CONTEXT D-10 (Phase 64 Plan 01, Task 2).
 *
 * WR-01 finding: `src/consolidation/consolidator.ts` threaded `claim.intent_status` /
 * `claim.intent_entity` / `claim.intent_confidence` onto `ClaimDecision` for ANY episode
 * source. D-11's "gmail-only isolation" was enforced only in prompt text — so a transcript,
 * `claude-code`, or `granola` extraction response that smuggled intent fields (prompt
 * injection, model drift, or merged-mode parse) threaded them straight through into whatever
 * consumes those fields (Phase 64's entity resolver, Phase 66's proposal emit seam).
 *
 * This file proves Task 1's hoisted `gmailSourced` gate closes that path across all three
 * decision routes a claim can take (fast-path confirm, auto-unrelated, judge-escalated), plus
 * two gmail positive controls proving the suite is not vacuously passing because threading is
 * broken everywhere.
 *
 * LOOSENING ANY ASSERTION HERE RE-OPENS A PROMPT-INJECTION PATH FROM NON-GMAIL SOURCES INTO
 * PHASE 64 RESOLUTION AND PHASE 66 PROPOSALS. This is a review-blocking change.
 *
 * Harness/spy patterns copied from tests/consolidation-intent.test.ts (that file exports
 * nothing — duplication is the established convention here, not refactored into a shared
 * helper module in this plan).
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
    // Never let the salience skip gate pre-empt the code path under test (every appended
    // episode also carries salience:1.0/hard_keep:1 below, which alone bypasses the gate --
    // hard_keep===0 is required for the skip to fire -- these flat thresholds are belt-and-
    // suspenders per the plan's explicit instruction).
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.0,
    salience: {
      ...DEFAULT_CONFIG.salience,
      // consolSkipThresholdBySource.gmail (0.4) wins over the flat threshold above -- neutralize
      // it explicitly so a gmail episode is never skipped regardless of hard_keep.
      consolSkipThresholdBySource: { gmail: 0.0 },
    },
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

/** No-op SchemaInducer: prevents LLM calls during Phase C (mirrors consolidation-intent.test.ts). */
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
// Decision-capture spy (test-local, instance-scoped — see tests/consolidation-intent.test.ts
// header for the full rationale: ClaimDecision is module-internal/unexported by design, D-08)
// ---------------------------------------------------------------------------

interface CapturedDecision {
  claimValue: string;
  relation: string;
  claimIntentStatus?: string;
  claimIntentEntity?: string;
  claimIntentConfidence?: string;
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

describe('Consolidator source-gated intent threading — D-10 / WR-01 closure', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── Route 1: fast-path confirm, non-gmail source ('claude-code') ─────────

  it('claude-code source, fast-path confirm route: smuggled intent fields are all undefined', async () => {
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
      content: existingValue,
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-claude-code-fastpath',
      source: 'claude-code',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.relation).toBe('confirm');
    expect(captured[0]!.claimIntentStatus).toBeUndefined();
    expect(captured[0]!.claimIntentEntity).toBeUndefined();
    expect(captured[0]!.claimIntentConfidence).toBeUndefined();
  });

  // ── Route 2: auto-unrelated, non-gmail source ('granola') ─────────────────

  it('granola source, auto-unrelated route: smuggled intent fields are all undefined', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{
        type: 'fact',
        value: 'Globex withdrew the offer',
        intent_status: 'rejected',
        intent_entity: 'Globex',
        intent_confidence: 'medium',
      }])],
      // Zero-vector embed -> cosine 0 -> no candidates, no anchors, no BM25 hit
      // (empty graph) -> auto-unrelated, no judge call.
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
      session_id: 'sess-granola-unrelated',
      source: 'granola',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.relation).toBe('unrelated');
    expect(captured[0]!.claimIntentStatus).toBeUndefined();
    expect(captured[0]!.claimIntentEntity).toBeUndefined();
    expect(captured[0]!.claimIntentConfidence).toBeUndefined();
  });

  // ── Route 3: judge-escalated, non-gmail source ('transcript') ─────────────
  // Proves the site-3 gate (pendingJudges.push) covers the judge-escalation carrier -- site 4
  // inherits from site 3 by construction and does not re-gate (see consolidator.ts comment).

  it('transcript source, judge-escalated route: smuggled intent fields are all undefined', async () => {
    const dims = h.config.embeddingDimensions;
    const candidateId = newId();
    const candidateValue = 'Globex application status';
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
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-transcript-judge',
      source: 'transcript',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.relation).toBe('extend');
    expect(captured[0]!.claimIntentStatus).toBeUndefined();
    expect(captured[0]!.claimIntentEntity).toBeUndefined();
    expect(captured[0]!.claimIntentConfidence).toBeUndefined();
  });

  // ── Positive control 1: gmail, fast-path route ────────────────────────────
  // Identical scripted response shape to the claude-code fast-path case above (same
  // intent_status/intent_entity/intent_confidence values) -- proves the parser genuinely
  // carried the smuggled fields through ExtractedClaim, so the non-gmail cases above are not
  // vacuously passing because threading is broken everywhere.

  it('gmail source (positive control), fast-path confirm route: intent fields all present', async () => {
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
        value: existingValue,
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
      session_id: 'sess-gmail-fastpath',
      source: 'gmail',
    });

    await consolidator.consolidate();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.relation).toBe('confirm');
    expect(captured[0]!.claimIntentStatus).toBe('rejected');
    expect(captured[0]!.claimIntentEntity).toBe('Acme Corp');
    expect(captured[0]!.claimIntentConfidence).toBe('high');
  });

  // ── Positive control 2: gmail, judge-escalated route ──────────────────────
  // Proves site 3 -> site 4 carry still works after gating (the gate applies once at the
  // site-3 push, not re-derived at site 4).

  it('gmail source (positive control), judge-escalated route: intent fields all present', async () => {
    const dims = h.config.embeddingDimensions;
    const candidateId = newId();
    const candidateValue = 'Globex application status';
    h.store.upsertNode({ id: candidateId, type: 'fact', value: candidateValue, origin: 'observed', s: 0.3, c: 0.6 });
    const sameEmbedFn = makeAlwaysSameEmbedFn(dims);
    const embedder = new MockEmbedder(sameEmbedFn);
    const [vec] = await embedder.embed([candidateValue]);
    h.store.setEmbedding(candidateId, vec!);

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
      session_id: 'sess-gmail-judge',
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
