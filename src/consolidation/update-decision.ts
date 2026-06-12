/**
 * PE-gated update routing for the consolidation pass (spec §4, D-15/D-16/D-19/D-20).
 *
 * All three functions are PURE — no Database, no clock side-effects.
 * Called by the consolidator's contradict branch inside a synchronous db.transaction.
 *
 * Threat mitigations:
 *  - T-02-DIV0: resistance divisor floored by EPS so a zero-strength/zero-confidence node
 *    never produces NaN/Infinity routing.
 *  - T-02-SELFCONF2: countDistinctProvenance excludes origin=inferred; the consolidator
 *    additionally drops source_inference_id-tagged episodes at record time (D-19).
 *  - T-02-OSC: D-20 one-deep oscillation guard escalates a flip-back to append-new,
 *    preventing tombstone-cycling. Made functional by reconcile carrying the superseded
 *    value into the new node's prev_value (consolidator task 2).
 */
import { normalizeValue } from './normalize';
import type { EngineConfig } from '../lib/config';
import type { PendingContradiction } from '../lib/types';

export type UpdateAction = 'hold' | 'reconcile' | 'append-new';

/** Small epsilon to floor the resistance divisor — prevents NaN/Infinity (T-02-DIV0). */
const EPS = 1e-9;

/**
 * Route a `contradict` verdict to HOLD / reconcile / append-new by comparing
 * judge-emitted PE magnitude to node resistance (spec §4 step 3, D-15/D-16).
 *
 * resistance = effective_s * c  (D-16: node resists overwrite only when BOTH
 *              well-used (high decayed strength) AND well-evidenced (high confidence)).
 *
 * ratio = peMagnitude / max(resistance, EPS)
 *
 *   ratio < peReconcileBandLow                    → 'hold'       (weak challenge vs strong fact)
 *   ratio < peReconcileBandHigh                   → 'reconcile'  (tombstone old + set new current)
 *   ratio >= peReconcileBandHigh
 *     AND resistance >= peAppendNewMinResistance   → 'append-new' (genuine divergence; both coexist)
 *     AND resistance <  peAppendNewMinResistance   → 'reconcile'  (fresh node; coexistence unwarranted)
 *
 * The peAppendNewMinResistance guard prevents fresh nodes (s=0.1, c=0.5 → resistance=0.05) from
 * routing to append-new on any moderate judge magnitude (>= 0.10). Without it, the reconcile
 * band (magnitude 0.04–0.10) is unreachable in practice: every clear contradiction routes to
 * append-new, the old node is never tombstoned, and belief-correction never completes (D-16 fix).
 */
export function routeContradiction(
  peMagnitude: number,
  resistance: number,
  config: EngineConfig,
): UpdateAction {
  const ratio = peMagnitude / Math.max(resistance, EPS);
  // Band 1: weak challenge vs strong fact → HOLD + accumulate pending_contradictions
  if (ratio < config.peReconcileBandLow) return 'hold';
  // Band 2: mid-band → reconcile (tombstone old + set new current value; tombstone-always v1)
  if (ratio < config.peReconcileBandHigh) return 'reconcile';
  // Band 3: extreme / categorical → append-new (genuine divergence; both values coexist)
  // Guard: only route to append-new when the node has meaningful resistance (D-16 fix).
  // A fresh/weak node (resistance < peAppendNewMinResistance) has no basis for "genuine
  // divergence" — the old value is not well-established, so reconcile is the correct action.
  if (resistance < config.peAppendNewMinResistance) return 'reconcile';
  return 'append-new';
}

/**
 * One-deep oscillation guard (D-20).
 *
 * Returns true when reconcile would set a value the node previously held, indicating
 * a flip-back that should coexist as genuine ambiguity rather than tombstone-cycle.
 *
 * D-20 is EXACT one-deep (no time window): prev_value is the immediately-superseded
 * breadcrumb. A second reconcile that would restore the superseded value is escalated
 * to append-new. This overrides spec §4 step 4's "< K sessions ago" wording — one-deep
 * is simpler, unambiguous, and sufficient for the stated correctness requirement.
 */
export function isOscillation(newValue: string, prevValue: string | null): boolean {
  if (prevValue === null) return false;
  return normalizeValue(newValue) === normalizeValue(prevValue);
}

/**
 * Count distinct session_ids in pending_contradictions, excluding entries whose
 * origin is 'inferred' (D-19).
 *
 * "Provenance-distinct" = N *independent* sessions, not N repetitions from one session.
 * An inferred echo is excluded to mirror the strengthen() origin-guard:
 * inferred output must not destabilize a fact any more than it can strengthen one.
 *
 * The consolidator additionally drops source_inference_id-tagged episodes at record time
 * (D-19 seam), so this function never sees them.
 */
export function countDistinctProvenance(entries: PendingContradiction[]): number {
  const sessions = new Set<string>();
  for (const entry of entries) {
    if (entry.origin !== 'inferred') {
      sessions.add(entry.session_id);
    }
  }
  return sessions.size;
}
