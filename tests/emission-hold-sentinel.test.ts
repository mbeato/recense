/**
 * D-13 sentinel — `contradict_hold` is unreachable from the emission seam (Phase 65, Plan 65-09).
 *
 * REVIEW-BLOCKING: this file establishes D-13 — "only decisive outcomes may ever feed an
 * emission point" — structurally, BEFORE Phase 66's `ActionProposalSink` exists, so Phase 66
 * inherits a guarded seam rather than creating one. Read this header before wiring any
 * proposal sink into the consolidator's contradict branches.
 *
 *  - Phase 66 MUST gate its `ActionProposalSink` on the exported `isEmissionEligible`
 *    predicate (`src/consolidation/status-drift.ts`) and MUST extend THIS file's behavioral
 *    sentinel to the real sink rather than writing a parallel one.
 *  - Research Pitfall 7's reasoning, restated: a hold is explicitly "not enough evidence yet";
 *    surfacing it as a proposal is the low-value noise that trains an approver to stop
 *    reading, and approval fatigue is the milestone's documented UX failure mode.
 *
 * Two independent halves, per the plan:
 *  - Half A (behavioral): a real `consolidate()` pass over a real seeded belief produces, for
 *    the candidate node, at least one `consolidation_event` row and ZERO rows for which
 *    `isEmissionEligible(event_type)` is true — proven by reading rows back out of SQLite and
 *    applying the REAL predicate imported from `src/consolidation/status-drift`, never a
 *    synthetic list. A firing counterexample (three distinct-provenance contradictions
 *    crossing the force-destabilization threshold) proves the negative assertions are not
 *    vacuous — a harness that silently never reaches the contradict branch would pass the
 *    negative assertion trivially.
 *  - Half B (structural): a comment-stripped source scan of the two hold sub-branches in
 *    `consolidator.ts` (the primary `applyDecision` hold arm and the secondary
 *    `applySecondaryContradiction` hold arm) for any emission-shaped identifier, proven
 *    non-vacuous by a planted offender through the SAME exported predicate.
 *
 * Structural-scan form shipped: the ANCHOR form (locate the two hold arms by their stable
 * textual anchors, extract each arm's balanced `{...}` block from the UNSTRIPPED source, THEN
 * strip comments from that extracted block before matching) rather than the "whole method
 * body" fallback. The anchor form was reliable against the live source (both anchors are
 * load-bearing comments the plan itself points at) and is the more precise invariant — it
 * would not silently pass if a *different* branch of either method grew an emission call.
 * Comments are stripped from the EXTRACTED block, not the whole file, before matching:
 * stripping the whole source first would destroy the very anchor text used to locate the
 * blocks, so the order is find-block-in-real-source, then strip-comments-within-block, then
 * match — not the naive "strip everything, then search" reading of the plan's action text.
 *
 * Harness precedents reused (not reinvented): `tests/consolidation-intent.test.ts`'s harness
 * shape, `tests/status-drift-wiring.test.ts`'s `MarkerProvider` content-keyed provider and
 * `makeConsolidatorWithRealSink` (a real `SQLiteConsolidationSink` is required here — a
 * `MockConsolidationSink` never populates the `consolidation_event` table this file reads
 * directly), and `tests/no-ats-domain-table.test.ts`'s exported-predicate / real-scan /
 * planted-offender shape for the structural half.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { SQLiteConsolidationSink, type ConsolidationSink } from '../src/consolidation/sink';
import { EventStore } from '../src/db/event-store';
import { newId } from '../src/lib/hash';
import type { NodeRow } from '../src/lib/types';
import { isEmissionEligible, EMISSION_ELIGIBLE_EVENT_TYPES } from '../src/consolidation/status-drift';

const CONSOLIDATOR_PATH = resolve(__dirname, '..', 'src', 'consolidation', 'consolidator.ts');

// ---------------------------------------------------------------------------
// Embed helper — constant vector for every text (cosine 1.0 between any two embedded texts),
// mirrors tests/status-drift-wiring.test.ts's constEmbedFn.
// ---------------------------------------------------------------------------

function constVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  v[0] = 1.0;
  return v;
}

function constEmbedFn(dims: number): (_t: string) => Float32Array {
  return (_t: string) => constVec(dims);
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

function makeHarness(overrides: Partial<EngineConfig> = {}): Harness {
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
    echoRecencyWindowMs: 86_400_000,
    ...overrides,
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

/** Wired with a REAL SQLiteConsolidationSink so consolidation_event rows actually land in the
 * DB — required here because this file reads that table directly (mirrors
 * tests/status-drift-wiring.test.ts's makeConsolidatorWithRealSink). */
function makeConsolidatorWithRealSink(h: Harness, provider: ModelProvider): Consolidator {
  const sink: ConsolidationSink = new SQLiteConsolidationSink(new EventStore(h.db), h.clock);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink,
  );
}

function seedNode(h: Harness, value: string, opts: { s?: number; c?: number } = {}): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'fact', value, origin: 'observed', s: opts.s, c: opts.c });
  h.store.setEmbedding(id, constVec(h.config.embeddingDimensions));
  return id;
}

function getNodeById(h: Harness, id: string): NodeRow {
  const row = h.db.prepare('SELECT * FROM node WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) throw new Error(`getNodeById: node ${id} not found`);
  return row;
}

function pendingContradictionsCount(node: NodeRow): number {
  return (JSON.parse(node.pending_contradictions || '[]') as unknown[]).length;
}

/** Every consolidation_event row that is "about" candidateId, on either side of a mint —
 * `node_id` for outcomes that mutate the candidate in place (confirm/hold), `candidate_id` for
 * outcomes that mint a NEW node id and carry the original candidate as `candidate_id`
 * (reconcile/force-destabilize). Reading both columns is what lets this query catch a
 * force-destabilize event even though its `node_id` points at the freshly-minted node. */
function consolidationEventRowsForCandidate(h: Harness, candidateId: string): Array<{ event_type: string }> {
  return h.db
    .prepare('SELECT event_type FROM consolidation_event WHERE node_id = ? OR candidate_id = ?')
    .all(candidateId, candidateId) as Array<{ event_type: string }>;
}

// ---------------------------------------------------------------------------
// MarkerProvider — content-keyed extraction + claim-value-keyed judge resolution (copied from
// tests/status-drift-wiring.test.ts per that file's documented duplication convention; not
// exported anywhere, so each consumer keeps its own copy).
// ---------------------------------------------------------------------------

class MarkerProvider implements ModelProvider {
  constructor(
    private readonly embedFn: (t: string) => Float32Array,
    private readonly extractionByMarker: Array<{ marker: string; claims: Record<string, unknown>[] }>,
    private readonly judgeResolver: (
      claim: string,
      candidates: Array<{ id: string; value: string }>,
    ) => JudgeVerdict,
  ) {}

  async generate(prompt: string): Promise<string> {
    const hit = this.extractionByMarker.find(({ marker }) => prompt.includes(marker));
    if (!hit) {
      throw new Error(`MarkerProvider: unrecognized prompt (no known marker matched): ${prompt}`);
    }
    return JSON.stringify(hit.claims);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(this.embedFn);
  }

  async judge(claim: string, candidates: Array<{ id: string; value: string }>): Promise<JudgeVerdict> {
    return this.judgeResolver(claim, candidates);
  }

  async judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>,
  ): Promise<JudgeVerdict[]> {
    const results: JudgeVerdict[] = [];
    for (const item of items) results.push(await this.judge(item.claim, item.candidates));
    return results;
  }
}

function swapProvider(consolidator: Consolidator, provider: ModelProvider): void {
  (consolidator as unknown as { provider: ModelProvider }).provider = provider;
}

// ---------------------------------------------------------------------------
// Half A — behavioral sentinel
// ---------------------------------------------------------------------------

describe('D-13 sentinel — contradict_hold is unreachable from the emission seam (behavioral)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('a single ambiguous low-confidence gmail contradiction produces zero emission-eligible rows, and the belief does not move', async () => {
    const anchorId = seedNode(h, 'anchor placeholder node');
    const BELIEF_VALUE = 'Acme Corp application status: submitted, awaiting review';
    const MINT_MARKER = '[EP-SENTINEL-MINT]';
    const CONFIRM_MARKER_1 = '[EP-SENTINEL-CONFIRM-1]';
    const CONFIRM_MARKER_2 = '[EP-SENTINEL-CONFIRM-2]';
    const AMBIGUOUS_MARKER = '[EP-SENTINEL-AMBIGUOUS]';

    // ── Pass 1: mint the belief node via a real 'extend' outcome. ──────────────────────────
    const mintProvider = new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: MINT_MARKER, claims: [{ type: 'fact', value: BELIEF_VALUE }] }],
      () => ({ relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] }),
    );
    const consolidator = makeConsolidatorWithRealSink(h, mintProvider);
    h.episodes.append({
      content: `Update ${MINT_MARKER}: ${BELIEF_VALUE}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-sentinel-mint', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    const nodeId = (h.db.prepare('SELECT id FROM node WHERE value = ?').get(BELIEF_VALUE) as { id: string }).id;

    // ── Passes 2-3: two real 'confirm' fast-path passes (D-17 exact match) strengthen the
    // belief through the genuine strengthen() primitive -- not a synthetic s/c override -- so
    // the node this test evaluates carries real, earned resistance. ───────────────────────
    for (const marker of [CONFIRM_MARKER_1, CONFIRM_MARKER_2]) {
      swapProvider(consolidator, new MarkerProvider(
        constEmbedFn(h.config.embeddingDimensions),
        [{ marker, claims: [{ type: 'fact', value: BELIEF_VALUE }] }],
        () => { throw new Error('judge must not be called on a D-17 exact-match fast path'); },
      ));
      h.episodes.append({
        content: `Update ${marker}: ${BELIEF_VALUE}`,
        origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
        session_id: `sess-sentinel-confirm-${marker}`, source: 'gmail', event_ts: 1_000_000,
      });
      await consolidator.consolidate();
    }

    // ── Pass 4: ONE ambiguous, low-confidence contradicting gmail episode. ─────────────────
    swapProvider(consolidator, new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: AMBIGUOUS_MARKER, claims: [{
        type: 'fact', value: 'Acme Corp application status: possibly rejected',
        intent_status: 'rejected', intent_entity: 'Acme Corp', intent_confidence: 'low',
      }] }],
      (_claim, candidates) => {
        const target = candidates.find((c) => c.value === BELIEF_VALUE);
        if (!target) throw new Error('sentinel fixture: belief node not found among candidates');
        return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.5, contradicted_ids: [target.id] };
      },
    ));
    h.episodes.append({
      content: `Update ${AMBIGUOUS_MARKER}: an ambiguous personal note about the application`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-sentinel-ambiguous', source: 'gmail', event_ts: 2_000_000,
    });
    await consolidator.consolidate();

    // The belief did not move.
    const node = getNodeById(h, nodeId);
    expect(node.tombstoned).toBeFalsy();
    expect(node.value).toBe(BELIEF_VALUE);
    expect(pendingContradictionsCount(node)).toBe(1);

    // At least one consolidation_event row exists for this node, and ZERO of them are
    // emission-eligible -- read back from SQLite, checked with the REAL predicate.
    const rows = consolidationEventRowsForCandidate(h, nodeId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => isEmissionEligible(r.event_type as Parameters<typeof isEmissionEligible>[0]))).toEqual([]);
  });

  it('counterexample: three distinct-provenance high-confidence contradictions cross the force-destabilization threshold and DO produce an emission-eligible row', async () => {
    const anchorId = seedNode(h, 'anchor placeholder node (counterexample)');
    const BELIEF_VALUE = 'Globex Corp application status: submitted, awaiting review';
    const CONTRADICT_VALUE = 'Globex Corp application status: rejected';
    const MINT_MARKER = '[EP-COUNTEREXAMPLE-MINT]';

    const mintProvider = new MarkerProvider(
      constEmbedFn(h.config.embeddingDimensions),
      [{ marker: MINT_MARKER, claims: [{ type: 'fact', value: BELIEF_VALUE }] }],
      () => ({ relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] }),
    );
    const consolidator = makeConsolidatorWithRealSink(h, mintProvider);
    h.episodes.append({
      content: `Update ${MINT_MARKER}: ${BELIEF_VALUE}`,
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-counterexample-mint', source: 'gmail', event_ts: 1_000_000,
    });
    await consolidator.consolidate();

    const nodeId = (h.db.prepare('SELECT id FROM node WHERE value = ?').get(BELIEF_VALUE) as { id: string }).id;

    // Three genuinely distinct provenances (three distinct session_ids) against a node whose
    // default fresh-mint resistance (s=0.1, c=0.5 -> resistance=0.05) keeps every individual
    // ratio well under peReconcileBandLow (0.8), so each contradiction individually routes to
    // hold -- only the THIRD distinct provenance crosses contradictionN (default 3) and forces
    // destabilization. This is the control that makes the negative assertion above
    // non-vacuous: a harness that silently never reached the contradict branch would also
    // report zero emission-eligible rows, but for the wrong reason.
    const markers = ['[EP-CTX-A]', '[EP-CTX-B]', '[EP-CTX-C]'];
    for (const [i, marker] of markers.entries()) {
      swapProvider(consolidator, new MarkerProvider(
        constEmbedFn(h.config.embeddingDimensions),
        [{ marker, claims: [{
          type: 'fact', value: CONTRADICT_VALUE,
          intent_status: 'rejected', intent_entity: 'Globex Corp', intent_confidence: 'high',
        }] }],
        (_claim, candidates) => {
          const target = candidates.find((c) => c.value === BELIEF_VALUE);
          if (!target) throw new Error('counterexample fixture: belief node not found among candidates');
          return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.03, contradicted_ids: [target.id] };
        },
      ));
      h.episodes.append({
        content: `Update ${marker}: ${CONTRADICT_VALUE}`,
        origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
        session_id: `sess-counterexample-${i}`, source: 'gmail', event_ts: 2_000_000 + i * 100_000,
      });
      await consolidator.consolidate();
    }

    const rows = consolidationEventRowsForCandidate(h, nodeId);
    const emissionEligibleRows = rows.filter((r) => isEmissionEligible(r.event_type as Parameters<typeof isEmissionEligible>[0]));
    expect(emissionEligibleRows.length).toBeGreaterThan(0);
    expect(emissionEligibleRows.some((r) => r.event_type === 'contradict_force_destabilize')).toBe(true);
  });

  it('secondary hold: a verdict listing a second contradicted id that routes to hold likewise produces zero emission-eligible rows for the secondary node', async () => {
    const primaryId = seedNode(h, 'Node P initial value', { s: 0.5, c: 0.5 });
    const secondaryId = seedNode(h, 'Node S initial value', { s: 0.5, c: 0.5 });

    const verdict: JudgeVerdict = {
      relation: 'contradict',
      best_candidate_id: primaryId,
      magnitude: 0.5,
      contradicted_ids: [primaryId, secondaryId],
    };
    const provider = new MockModelProvider({
      embedFn: constEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{
        type: 'fact', value: 'Node P+S contradicting claim',
        intent_status: 'interviewing', intent_entity: 'P', intent_confidence: 'low',
      }])],
      judgeScript: [verdict],
    });
    const consolidator = makeConsolidatorWithRealSink(h, provider);
    h.episodes.append({
      content: 'Node P+S contradicting claim',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-secondary-hold', source: 'gmail', event_ts: 4_000_000,
    });
    await consolidator.consolidate();

    const secondaryNode = getNodeById(h, secondaryId);
    expect(secondaryNode.tombstoned).toBeFalsy();
    const rows = consolidationEventRowsForCandidate(h, secondaryId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => isEmissionEligible(r.event_type as Parameters<typeof isEmissionEligible>[0]))).toEqual([]);
  });

  it('set integrity: EMISSION_ELIGIBLE_EVENT_TYPES excludes contradict_hold and has exactly 3 members', () => {
    expect(EMISSION_ELIGIBLE_EVENT_TYPES.has('contradict_hold')).toBe(false);
    expect(EMISSION_ELIGIBLE_EVENT_TYPES.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Half B — structural scan
// ---------------------------------------------------------------------------

/**
 * Strip `//` and `/* *\/` comments from a string (order-independent for this module's use:
 * always applied to an already-extracted block, never to the whole file, so the anchor text
 * used to FIND that block survives).
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

/** Extract the balanced `{ ... }` block starting at `openBraceIdx` (inclusive of both braces). */
function extractBalancedBlockFromBrace(src: string, openBraceIdx: number): string {
  let depth = 0;
  let j = openBraceIdx;
  do {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  } while (depth > 0 && j < src.length);
  return src.slice(openBraceIdx, j);
}

const FORBIDDEN_EMISSION_IDENTIFIERS: readonly string[] = [
  'emitProposal',
  'proposalSink',
  'ActionProposalSink',
  'onDecisive',
  'proposals.',
];

/**
 * Locate the two hold sub-branches by their stable textual anchors in the UNSTRIPPED source
 * (the primary `applyDecision` hold arm's `// action === 'hold'` comment, and the secondary
 * `applySecondaryContradiction` hold arm's `hold — apply the same D-19...` comment), extract
 * each arm's enclosing balanced `{...}` block, strip comments from JUST that block, and report
 * any occurrence of a forbidden emission-shaped identifier inside it.
 *
 * An anchor that is not found is silently skipped (not thrown) so this function stays usable
 * against synthetic partial fixtures in the non-vacuousness tests below; the real-source test
 * separately asserts both anchors ARE present, so a silently-skipped anchor cannot make the
 * real-source scan vacuous.
 */
export function findEmissionCallsInHoldBranches(source: string): string[] {
  const offenders: string[] = [];

  function scanAnchor(anchorText: string, label: string): void {
    const anchorIdx = source.indexOf(anchorText);
    if (anchorIdx === -1) return;
    const openBrace = source.lastIndexOf('{', anchorIdx);
    if (openBrace === -1) return;
    const block = extractBalancedBlockFromBrace(source, openBrace);
    const stripped = stripComments(block);
    for (const token of FORBIDDEN_EMISSION_IDENTIFIERS) {
      if (stripped.includes(token)) {
        offenders.push(`${label}: contains forbidden emission identifier "${token}"`);
      }
    }
  }

  scanAnchor("// action === 'hold'", 'primary hold branch (applyDecision)');
  scanAnchor(
    'hold — apply the same D-19 provenance-eligibility gate as the primary',
    'secondary hold branch (applySecondaryContradiction)',
  );

  return offenders;
}

describe('D-13 sentinel — contradict_hold is unreachable from the emission seam (structural)', () => {
  it('the live consolidator.ts hold branches contain no emission-shaped identifier', () => {
    const source = readFileSync(CONSOLIDATOR_PATH, 'utf8');
    // Sanity: both anchors must actually be present in the live source, or the scan below
    // would silently be vacuous (a missing anchor is skipped, not thrown, by design above).
    expect(source).toContain("// action === 'hold'");
    expect(source).toContain('hold — apply the same D-19 provenance-eligibility gate as the primary');
    expect(findEmissionCallsInHoldBranches(source)).toEqual([]);
  });

  it('non-vacuousness: a planted proposalSink.emit call inside a synthetic hold-branch-shaped block is flagged', () => {
    const synthetic = `
      class FakeConsolidator {
        applyDecision() {
          if (foo) {
            doSomething();
          } else {
            // action === 'hold'
            if (eligible) {
              proposalSink.emit(payload);
            }
          }
        }
      }
    `;
    const offenders = findEmissionCallsInHoldBranches(synthetic);
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('comment-stripping is load-bearing: a comment merely naming proposalSink inside the hold block is NOT flagged', () => {
    const synthetic = `
      class FakeConsolidator {
        applyDecision() {
          if (foo) {
            doSomething();
          } else {
            // action === 'hold'
            // Note: Phase 66 must never call proposalSink.emit(...) from this branch.
            if (eligible) {
              recordContradictionOnly();
            }
          }
        }
      }
    `;
    // Without comment-stripping, the literal substring "proposalSink" in the comment above
    // would falsely flag this block -- this test proves the stripping step is doing real work,
    // not just declared in the header.
    expect(findEmissionCallsInHoldBranches(synthetic)).toEqual([]);
  });
});
