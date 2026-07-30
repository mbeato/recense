/**
 * Phase 62 Plan 05 — EMAIL-04 end-to-end proof (backfill-chronological-order).
 *
 * Exercises the REAL `consolidate()` pass (not `orderEpisodesForConsolidation` in
 * isolation): a fresh account's initial backfill delivers two Gmail episodes for the
 * same tracked subject out of chronological order (higher-salience episode first,
 * matching `listUnconsolidated()`'s `ORDER BY hard_keep DESC, salience DESC`), and the
 * older message must not silently apply over the newer state once `consolidate()`
 * has processed both.
 *
 * Design note on the fixture (documented as a deviation in the plan SUMMARY): the two
 * episodes are set up so the OLDER-state episode carries the LOWER salience and the
 * NEWER-state episode carries the HIGHER salience. Given this codebase's actual
 * reconcile-last-applied-wins mechanics (`routeContradiction` mid-band → tombstone +
 * mint new current — see `src/consolidation/update-decision.ts`), this is the only
 * assignment under which:
 *   (a) the bare `listUnconsolidated()` order processes the newer-state episode FIRST
 *       and the older-state episode LAST, so the older episode's reconcile silently
 *       overwrites the newer one — the exact EMAIL-04 bug, demonstrated directly; and
 *   (b) the `orderEpisodesForConsolidation` (ascending event_ts, oldest-first) reorder
 *       processes the older-state episode FIRST and the newer-state episode LAST, so
 *       the newer episode's reconcile is the one that survives — the fix, proven
 *       end-to-end through the unmodified PE-gate machinery.
 *
 * Extraction is content-keyed off `[EP-OLDER]`/`[EP-NEWER]` markers embedded in each
 * episode's content, not off call order or a fixed response queue: `DynamicReconcileProvider.
 * generate()` branches on which marker substring is present in its prompt argument and throws
 * on an unrecognized prompt. This closes `62-VERIFICATION.md` `gaps[0]` / threat T-62-36 ("a
 * green test that proves nothing") — a call-order-indexed script would return the correct
 * extracted value regardless of whether `orderEpisodesForConsolidation` is actually wired into
 * `consolidate()`, because this codebase's genuine "second-processed episode wins" semantics
 * would make the final-value assertion pass either way. A content-keyed provider ties the
 * extracted value to which physical episode was processed, so the assertion is wiring-dependent.
 *
 * A dynamic-judge provider is used instead of `MockModelProvider`'s static verdict
 * queue: the second-processed episode's contradiction target is a node minted at
 * runtime by the first-processed episode (its id is not known ahead of time), so the
 * judge must resolve `best_candidate_id` from the live `candidates` array rather than
 * a hardcoded literal — mirroring exactly what a real judge call does.
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
import type { ModelProvider } from '../src/model/provider';
import { MockModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { orderEpisodesForConsolidation } from '../src/consolidation/episode-order';
import type { EpisodeRow, NodeRow } from '../src/lib/types';

// ---------------------------------------------------------------------------
// Harness (mirrors tests/consolidator.test.ts's makeHarness/makeNoOpSchemaInducer)
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

/**
 * A constant embed function: every text embeds to the SAME vector, so real cosine
 * retrieval (topk) always finds any existing untombstoned fact node as the sole
 * candidate for the next episode's claim — exactly like two real messages about the
 * same tracked entity would embed near-identically.
 */
function makeConstantEmbedFn(dims: number): (t: string) => Float32Array {
  return (_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  };
}

const OLDER_MARKER = '[EP-OLDER]';
const NEWER_MARKER = '[EP-NEWER]';

/**
 * Content-keyed provider: `generate()` is a pure function of its prompt argument — it
 * branches on which episode-content marker (`[EP-OLDER]` / `[EP-NEWER]`) is present, with
 * NO call counter and NO fixed response queue, so call order, call count, and worker
 * interleaving (`prefetchExtractions`'s `PREFETCH_CONCURRENCY` workers) cannot affect the
 * result. An unrecognized prompt (neither or both markers) throws — a silent default would
 * let the test pass vacuously, which is the exact T-62-36 regression class being closed.
 * `judge()` always contradicts the live top candidate (there is only ever one untombstoned
 * fact node for this subject at any point in the pass) at a magnitude that lands the
 * mid-band `reconcile` route against a freshly-minted node's default resistance (s=0.1,
 * c=0.5 -> resistance=0.05; magnitude=0.05 -> ratio=1.0, within
 * [peReconcileBandLow=0.8, peReconcileBandHigh=2.0)).
 */
class DynamicReconcileProvider implements ModelProvider {
  /** Marker -> number of recognized generate() calls that extracted it. */
  public readonly seen = new Map<string, number>();

  constructor(private readonly embedFn: (t: string) => Float32Array) {}

  async generate(prompt: string, _opts?: { maxTokens?: number }): Promise<string> {
    const hasNewer = prompt.includes(NEWER_MARKER);
    const hasOlder = prompt.includes(OLDER_MARKER);
    if (hasNewer && !hasOlder) {
      this.seen.set(NEWER_MARKER, (this.seen.get(NEWER_MARKER) ?? 0) + 1);
      return JSON.stringify([{ type: 'fact', value: NEWER_VALUE }]);
    }
    if (hasOlder && !hasNewer) {
      this.seen.set(OLDER_MARKER, (this.seen.get(OLDER_MARKER) ?? 0) + 1);
      return JSON.stringify([{ type: 'fact', value: OLDER_VALUE }]);
    }
    throw new Error(
      `DynamicReconcileProvider: unrecognized prompt (expected exactly one of ${NEWER_MARKER}/${OLDER_MARKER}): ${prompt}`,
    );
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(this.embedFn);
  }

  async judge(
    _claim: string,
    candidates: Array<{ id: string; value: string }>,
  ): Promise<JudgeVerdict> {
    return {
      relation: 'contradict',
      best_candidate_id: candidates[0]?.id ?? null,
      magnitude: 0.05,
      contradicted_ids: [],
    };
  }

  async judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>,
  ): Promise<JudgeVerdict[]> {
    const results: JudgeVerdict[] = [];
    for (const item of items) results.push(await this.judge(item.claim, item.candidates));
    return results;
  }
}

const OLDER_VALUE = 'application status: submitted, awaiting review';
const NEWER_VALUE = 'application status: offer extended';

describe('EMAIL-04: backfill chronological order (Phase 62 Plan 05)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('reverse-chronological Gmail backfill batch: newer status wins, not the stale older one', async () => {
    // Both saliences clear consolSkipThresholdBySource['gmail'] (0.4) so neither is skipped.
    // Both hard_keep=0 so the hard_keep DESC term does not decide bare order.
    const newerEpisode = h.episodes.append({
      content: `Update ${NEWER_MARKER}: ${NEWER_VALUE}`,
      origin: 'observed',
      salience: 0.9,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-newer',
      source: 'gmail',
      event_ts: 2_000_000, // later send time
    });
    const olderEpisode = h.episodes.append({
      content: `Update ${OLDER_MARKER}: ${OLDER_VALUE}`,
      origin: 'observed',
      salience: 0.5,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-older',
      source: 'gmail',
      event_ts: 1_000_000, // earlier send time
    });

    // ── Precondition (T-62-36): bare listUnconsolidated() is salience-ordered, so the
    // newer-state episode (higher salience) sorts FIRST and the older-state episode
    // sorts LAST — the exact non-chronological backfill ordering the bug depends on.
    const bareOrder = h.episodes.listUnconsolidated();
    expect(bareOrder.map(r => r.id)).toEqual([newerEpisode.id, olderEpisode.id]);
    // Both saliences clear the gmail skip threshold — neither is silently skipped.
    expect(newerEpisode.salience).toBeGreaterThan(h.config.salience.consolSkipThresholdBySource['gmail']!);
    expect(olderEpisode.salience).toBeGreaterThan(h.config.salience.consolSkipThresholdBySource['gmail']!);

    // ── Ordering-seam assertion: a refactor that silently drops the wrapper cannot pass
    // this test. orderEpisodesForConsolidation reorders by ascending event_ts (oldest
    // first) — the older episode first, the newer episode last — which DIFFERS from
    // the bare salience order above.
    const reordered = orderEpisodesForConsolidation(bareOrder);
    expect(reordered.map(r => r.id)).toEqual([olderEpisode.id, newerEpisode.id]);
    expect(reordered.map(r => r.id)).not.toEqual(bareOrder.map(r => r.id));

    const provider = new DynamicReconcileProvider(makeConstantEmbedFn(h.config.embeddingDimensions));

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    await consolidator.consolidate();

    // Both episodes were actually processed (neither skipped nor quarantined) — otherwise
    // this test would prove nothing (T-62-36).
    const rows = h.db
      .prepare('SELECT id, consolidated FROM episode')
      .all() as Array<{ id: string; consolidated: number }>;
    for (const row of rows) {
      expect(row.consolidated).toBe(1);
    }

    // Both episodes actually reached extraction exactly once — a skipped, quarantined, or
    // double-extracted episode cannot make the final-value assertion below pass (T-62-40).
    expect(provider.seen.get(NEWER_MARKER)).toBe(1);
    expect(provider.seen.get(OLDER_MARKER)).toBe(1);

    // The final untombstoned fact node carries the NEWER state, not the older one.
    const currentNodes = h.db
      .prepare("SELECT * FROM node WHERE type = 'fact' AND tombstoned = 0")
      .all() as NodeRow[];
    expect(currentNodes).toHaveLength(1);
    expect(currentNodes[0]!.value).toBe(NEWER_VALUE);

    const tombstonedNodes = h.db
      .prepare("SELECT * FROM node WHERE type = 'fact' AND tombstoned = 1")
      .all() as NodeRow[];
    expect(tombstonedNodes).toHaveLength(1);
    expect(tombstonedNodes[0]!.value).toBe(OLDER_VALUE);
  });

  it('negative control: null event_ts on both episodes — pass completes, final value NOT asserted', async () => {
    // With no event_ts on either episode, there is no chronological basis for ordering;
    // salience order governs exactly as before this plan. Asserting a specific final
    // value here would be asserting the bug (the whole point of event_ts is that
    // WITHOUT it, no ordering guarantee exists) — so only completion is checked.
    h.episodes.append({
      content: `Update ${NEWER_MARKER}: ${NEWER_VALUE}`,
      origin: 'observed',
      salience: 0.9,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-newer-null',
      source: 'gmail',
      event_ts: null,
    });
    h.episodes.append({
      content: `Update ${OLDER_MARKER}: ${OLDER_VALUE}`,
      origin: 'observed',
      salience: 0.5,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-older-null',
      source: 'gmail',
      event_ts: null,
    });

    const provider = new DynamicReconcileProvider(makeConstantEmbedFn(h.config.embeddingDimensions));

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    await expect(consolidator.consolidate()).resolves.not.toThrow();

    const rows = h.db
      .prepare('SELECT id, consolidated FROM episode')
      .all() as Array<{ id: string; consolidated: number }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.consolidated).toBe(1);
    }
    // Deliberately no assertion on which value ended up current — event_ts=null means
    // no ordering guarantee, and asserting one would assert the very bug this closes.
  });
});
