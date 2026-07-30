/**
 * Slot-preserving chronological reorder of unconsolidated episodes (EMAIL-04).
 *
 * `EpisodicStore.listUnconsolidated()` (`src/db/episode-store.ts`) returns
 * `ORDER BY hard_keep DESC, salience DESC` — the D-03/D-10 replay-priority order that
 * decides which episodes survive a budget-capped, lock-stale-restarted, or
 * FIX-STALL-01 chunk-truncated pass. That SQL ordering is deliberately NOT touched here:
 * a global chronological sort would let an old, low-salience backlog message displace a
 * high-salience recent episode out of a truncated pass, degrading resilience for every
 * source, not just email (T-62-32).
 *
 * Instead, this function refines the array AFTER that query, in place of meaning: among
 * episodes that carry a source-asserted `event_ts` (today: Gmail messages whose `Date:`
 * header parsed with confidence — see plan 62-04's `parseEmailDate`), the older event is
 * processed before the newer one, WITHOUT changing which index slots those episodes
 * occupy. Concretely:
 *   1. Collect the indices of rows where `event_ts !== null && event_ts !== undefined`.
 *   2. Sort the rows at those indices by `event_ts` ascending (tie-break: `id` ascending,
 *      for full determinism when two messages share a `Date:` value to the second).
 *   3. Write the sorted rows back into exactly the collected indices, in order.
 * Rows with `event_ts === null` — every non-Gmail source today, plus any Gmail message
 * whose `Date:` header failed `parseEmailDate`'s plausibility window — are NEVER moved:
 * the positions they already occupy still express the hard_keep/salience priority, and a
 * truncated pass still processes the same PREFIX of the array with the same count. That
 * is what makes this change safe to apply unconditionally to every pass, rather than
 * gating it behind an "is this a backfill?" heuristic (itself a source of bugs).
 *
 * T-62-30: a null `event_ts` — which is exactly what an implausibly-future `Date:` header
 * yields under plan 62-04's clamp — is never moved by this function, so "forge a
 * far-future header to be scheduled last" is not an expressible attack: rejecting the
 * date leaves the episode in its ordinary salience slot instead of granting it a late
 * position.
 *
 * Named residual (T-62-35, not covered here): this orders within ONE pass's
 * unconsolidated set only. Two accounts backfilling in different passes, or new
 * evidence arriving after a pass already completed, are NOT ordered relative to
 * already-consolidated episodes. That cross-pass/cross-account defense is DRIFT-04
 * (Phase 65), which must consult `event_ts` in the routing decision itself
 * (`routeContradiction` et al. — deliberately untouched by this plan).
 */
import type { EpisodeRow } from '../lib/types';

/**
 * Reorder `rows` so that among episodes carrying a non-null `event_ts`, the older one
 * comes first — without moving any row out of the set of index slots event-time-bearing
 * rows already occupy, and without moving any `event_ts === null` row at all.
 *
 * Pure, total, deterministic, allocation-only: never mutates `rows` or any row object.
 * Permutation guarantee: output has the same length and the same multiset of `id`s as
 * the input, always. Idempotent: `orderEpisodesForConsolidation(f(x))` deep-equals `f(x)`.
 */
export function orderEpisodesForConsolidation(rows: readonly EpisodeRow[]): EpisodeRow[] {
  const eventTimeIndices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const eventTs = rows[i]!.event_ts;
    if (eventTs !== null && eventTs !== undefined) {
      eventTimeIndices.push(i);
    }
  }

  // Nothing to reorder: 0 or 1 event-time-bearing rows can't change relative order.
  if (eventTimeIndices.length < 2) {
    return [...rows];
  }

  const sortedEventTimeRows = eventTimeIndices
    .map(i => rows[i]!)
    .sort((a, b) => {
      // event_ts is non-null for every row in this subset (guaranteed by eventTimeIndices).
      const diff = a.event_ts! - b.event_ts!;
      if (diff !== 0) return diff;
      // Deterministic tie-break for equal-second Date: headers.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const result = [...rows];
  for (let slot = 0; slot < eventTimeIndices.length; slot++) {
    result[eventTimeIndices[slot]!] = sortedEventTimeRows[slot]!;
  }
  return result;
}
