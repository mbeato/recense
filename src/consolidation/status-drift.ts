/**
 * StatusDrift — belief-gated status-drift layer (Phase 65, Plan 65-05).
 *
 * A standalone, read-only, LLM-free decision module that sits structurally BEFORE
 * `routeContradiction` (src/consolidation/update-decision.ts) and hands it a magnitude.
 * It never calls or modifies that function, and it never sees or reasons about the status
 * VALUE being classified — only the coarse categorical confidence Phase 63 attaches to a
 * gmail-sourced claim. Two independent, composable guards:
 *
 *  (a) `dampByConfidence` (D-09) — a lower-only multiplier on a contradicting claim's PE
 *      magnitude, keyed on Phase 63's coarse intent confidence. A low-confidence claim is
 *      damped to 0, which the UNMODIFIED `routeContradiction` deterministically routes to
 *      hold for every possible resistance (magnitude 0 / anything = 0, below every band).
 *  (b) the `event_ts` staleness guard (D-11b) — a contradicting claim whose source-asserted
 *      event time predates the candidate node's most recent dated SUPPORTING evidence is
 *      DROPPED, not held, so stale backfilled evidence cannot accumulate toward
 *      force-destabilization (DRIFT-04 crux; see "Why drop and not hold" below).
 *
 * Mirrors `entity-resolution.ts`'s module shape (Phase 64 D-01/D-04/D-12 precedent):
 * standalone file (not inlined into consolidator.ts) so the read-only/no-LLM/no-lattice
 * guarantees can be asserted at file granularity rather than diluted across a 1600-line file
 * that also contains the machinery this module must never touch.
 *
 * ── Read-only contract (mirrors entity-resolution.ts D-12) ────────────────────────────────
 * This module never calls `upsertNode`, `upsertEdge`, `.strengthen(`, `.tombstone(`, or
 * `recordContradiction`, and never opens a `db.transaction`. Its only SQL is the single
 * prepared SELECT built in the constructor below. Proven by a whole-DB snapshot-equality
 * test (before/after evaluate(), both the drop and proceed paths) in the companion test file.
 *
 * ── Machinery-unmodified contract (D-08/DRIFT-01) ──────────────────────────────────────────
 * The PE routing function, the one-deep oscillation guard, the provenance-distinctness
 * counter, the PE bands, and the data model are all untouched by this phase. This module
 * sits structurally BEFORE the routing call and hands it a magnitude; it never imports or
 * calls the routing function itself.
 *
 * ── No lattice (D-10, research Pitfall 9) ──────────────────────────────────────────────────
 * This module reads the coarse confidence enum only and never the status value or its type.
 * It holds no status vocabulary, no valid-transition table, and no notion of ordering between
 * statuses. Out-of-order or stage-skipping transitions are handled by the CLASSIFIER lowering
 * its own confidence; this module only ever consumes the already-lowered value. Adding any
 * transition awareness here would put domain knowledge in the engine and break the
 * domain-neutrality discipline Phase 66's seam depends on.
 *
 * ── Hard-stop inheritance ───────────────────────────────────────────────────────────────────
 * The caller (Plan 65-08, not this plan) must position its call site textually AFTER the
 * inferred/echo/hitl hard stop in the consolidator's per-episode loop. This module
 * deliberately does NOT re-check origin/echo/hitl itself — a second check with different
 * logic is the drift-prone duplication research Pitfall 6 warns about.
 *
 * ── Why `drop` and not `hold` (DRIFT-04 crux) ──────────────────────────────────────────────
 * A held contradiction is RECORDED into `node.pending_contradictions` and accumulates toward
 * the provenance-distinctness counter, so three stale backfilled rejections would eventually
 * force-destabilize a newer, correct belief. Dropping produces no graph effect at all,
 * mirroring the existing "not provenance-eligible: drop silently" behavior already shipped
 * in the consolidator's hold branch.
 *
 * ── Known limits, stated honestly (mirrors entity-resolution.ts's own section) ─────────────
 *  (a) Cross-run and cross-account interleaving beyond this guard plus the Plan 65-06 backfill
 *      sort is a named, accepted, documented risk this milestone — bi-temporal validity
 *      columns stay deferred.
 *  (b) "Most recent supporting evidence" is derived from the consolidation-event stream
 *      joined to the episode's source-asserted event time; a node whose supporting evidence
 *      is entirely undated (every non-email source today) reports an unknown-prior-timestamp
 *      outcome and the guard abstains — that abstention is reported in the returned decision,
 *      never silent.
 *  (c) The guard is per-candidate-node; because a reconcile tombstones and mints a NEW node
 *      id, the timestamp horizon resets to the minting episode. That is the intended
 *      semantics, not a bug — the new node's own evidence history starts fresh.
 */
import type Database from 'better-sqlite3';
import type { EngineConfig } from '../lib/config';
import type { IntentConfidence } from '../model/claim-extractor';
import type { ConsolidationEventType } from './sink';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One drift evaluation request. `confidence` absent means "not a status claim" (structural no-op). */
export type DriftInput = {
  magnitude: number;
  confidence?: IntentConfidence;
  claimEventTs: number | null;
  candidateNodeId: string;
};

/**
 * Tagged union so the caller must switch exhaustively rather than string-compare, and so
 * Plan 65-08's counters come off the `staleness` discriminant instead of being re-derived.
 */
export type DriftDecision =
  | {
      action: 'proceed';
      magnitude: number;
      damped: boolean;
      staleness: 'ok' | 'unknown-claim-ts' | 'unknown-prior-ts' | 'guard-off' | 'not-applicable';
    }
  | { action: 'drop'; reason: 'stale-event'; priorEventTs: number; claimEventTs: number };

// ---------------------------------------------------------------------------
// dampByConfidence — pure, no DB (D-09)
// ---------------------------------------------------------------------------

/**
 * Multiply a PE magnitude by a confidence-keyed factor clamped to [0, 1] — the structural
 * D-09 lower-only lock (extends the D-43 non-strengthening doctrine and backlog B-04's
 * lower-only constraint). Clamping at consumption rather than rejecting at config-load time
 * is deliberate: a malformed config degrades to safe behavior instead of throwing mid-pass.
 *
 * `confidence === undefined` means the decision carries no intent classification at all
 * (every non-gmail decision in the engine) — pass the magnitude through unchanged.
 *
 * A missing map key or a non-finite configured value also fails open toward the unchanged
 * magnitude rather than toward NaN propagating into a routing ratio.
 */
export function dampByConfidence(
  magnitude: number,
  confidence: IntentConfidence | undefined,
  config: EngineConfig,
): number {
  if (confidence === undefined) return magnitude;
  // Cast to allow a missing key at runtime (a malformed/partial config) without a
  // compile-time "no overlap" comparison error — this is a defensive runtime guard,
  // not a claim that the shipped config type is itself partial.
  const map = config.statusDriftConfidenceDamping as Record<IntentConfidence, number | undefined>;
  const raw = map[confidence];
  if (raw === undefined || !Number.isFinite(raw)) return magnitude;
  const factor = Math.min(1, Math.max(0, raw));
  return magnitude * factor;
}

// ---------------------------------------------------------------------------
// Supporting / emission-eligible event types (D-13)
// ---------------------------------------------------------------------------

/**
 * Event types that count as evidence FOR the candidate node's current value when computing
 * the staleness horizon. A hold's episode is contradicting evidence recorded AGAINST the
 * candidate, not supporting evidence for it — counting it would let the very claim being
 * evaluated raise the bar against itself, so the hold outcome is deliberately excluded here.
 * The unrelated/schema/merge outcomes are excluded as not evidence about this node's value.
 */
export const SUPPORTING_EVENT_TYPES: ReadonlySet<ConsolidationEventType> = new Set<ConsolidationEventType>([
  'confirm',
  'extend',
  'contradict_reconcile',
  'contradict_append_new',
  'contradict_force_destabilize',
  'contradict_oscillation',
]);

/**
 * D-13's structural seam. Phase 66 MUST gate its proposal sink on this predicate rather than
 * re-deriving the rule. The excluded hold outcome may NEVER be added to this set (research
 * Pitfall 7: a hold is explicitly "not enough evidence yet"; surfacing it as a proposal is
 * the noise that trains an approver to stop reading). The oscillation outcome is deliberately
 * excluded too, and this is a Phase 66 decision point, not an oversight: an oscillation is
 * the engine declaring genuine ambiguity between two coexisting values, which is not a
 * settled transition worth proposing. No proposal sink, no proposal table, and no sink
 * instance is created here — this phase ships the predicate only.
 */
export const EMISSION_ELIGIBLE_EVENT_TYPES: ReadonlySet<ConsolidationEventType> = new Set<ConsolidationEventType>([
  'contradict_reconcile',
  'contradict_append_new',
  'contradict_force_destabilize',
]);

export function isEmissionEligible(eventType: ConsolidationEventType): boolean {
  return EMISSION_ELIGIBLE_EVENT_TYPES.has(eventType);
}

// ---------------------------------------------------------------------------
// StatusDrift
// ---------------------------------------------------------------------------

export class StatusDrift {
  private readonly config: EngineConfig;

  // Single read-only prepared statement (D-12). Its `IN` list is generated from
  // SUPPORTING_EVENT_TYPES programmatically so the SQL and the set can never drift apart —
  // no event-type string literal is ever concatenated into the SQL text.
  // Served by the shipped idx_consolidation_event_node index; no schema change is made
  // or needed by this plan.
  private readonly stmtLatestSupportingEventTs: Database.Statement;

  /**
   * No `ModelProvider` parameter and no parameter named `provider` of any kind — that
   * omission is the type-level zero-LLM guarantee (mirrors entity-resolution.ts D-04).
   * No `SemanticStore` either; this module takes only what it reads.
   */
  constructor(db: Database.Database, config: EngineConfig) {
    this.config = config;

    const placeholders = [...SUPPORTING_EVENT_TYPES].map(() => '?').join(',');
    this.stmtLatestSupportingEventTs = db.prepare(`
      SELECT MAX(e.event_ts) AS ts
      FROM consolidation_event ce
      JOIN episode e ON e.id = ce.episode_id
      WHERE ce.node_id = ? AND e.event_ts IS NOT NULL AND ce.event_type IN (${placeholders})
    `);
  }

  private latestSupportingEventTs(nodeId: string): number | null {
    const row = this.stmtLatestSupportingEventTs.get(nodeId, ...SUPPORTING_EVENT_TYPES) as {
      ts: number | null;
    };
    return row.ts ?? null;
  }

  /**
   * Evaluate one contradicting claim. Order below is load-bearing:
   *  1. Master switch — checked before any DB read or confidence read.
   *  2. Structural no-op for every decision without intent confidence — this is what keeps
   *     the drift layer invisible to every non-gmail decision in the engine without a second
   *     source check that could drift from the hoisted gmail-source gate upstream.
   *  3. event_ts staleness guard — only evaluated when the guard is on and the claim carries
   *     a timestamp; abstains (never silently) when either side is unknown.
   *  4. Otherwise proceed, applying the (lower-only) confidence damper.
   */
  evaluate(input: DriftInput): DriftDecision {
    if (!this.config.statusDriftEnabled) {
      return { action: 'proceed', magnitude: input.magnitude, damped: false, staleness: 'guard-off' };
    }

    if (input.confidence === undefined) {
      return { action: 'proceed', magnitude: input.magnitude, damped: false, staleness: 'not-applicable' };
    }

    let staleness: 'ok' | 'unknown-claim-ts' | 'unknown-prior-ts' | 'guard-off';
    if (!this.config.statusDriftEventTsGuard) {
      staleness = 'guard-off';
    } else if (input.claimEventTs === null) {
      staleness = 'unknown-claim-ts';
    } else {
      const prior = this.latestSupportingEventTs(input.candidateNodeId);
      if (prior === null) {
        staleness = 'unknown-prior-ts';
      } else if (input.claimEventTs < prior) {
        // Stale backfilled evidence — DROP, not hold (see header "Why drop and not hold").
        return { action: 'drop', reason: 'stale-event', priorEventTs: prior, claimEventTs: input.claimEventTs };
      } else {
        // Equal timestamps are not "older" — ties favor applying the update.
        staleness = 'ok';
      }
    }

    const damped = dampByConfidence(input.magnitude, input.confidence, this.config);
    return { action: 'proceed', magnitude: damped, damped: damped !== input.magnitude, staleness };
  }
}
