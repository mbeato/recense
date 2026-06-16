/**
 * calendar-tombstone — deterministic sleep-pass cancellation tombstone (D-05, Plan 20-04).
 *
 * Design decisions locked here:
 *  D-05: Cancelled Google Calendar events tombstone exactly the nodes linked to them via
 *        node_temporal.source_event_id — never by summary/value match (LLM-free, D-05).
 *  CONSOL-03: This runs ONLY in the offline sleep pass, never in the online hot path.
 *             The CalendarAdapter writes the cancelled-master side-channel; this step reads
 *             it and performs the graph mutation (tombstone). Separation of duties: adapter
 *             = event detection, tombstone step = graph mutation.
 *  Idempotent: clearing the meta set after tombstoning means a second run on the same set
 *             is a no-op. Multiple tombstones on an already-tombstoned node are no-ops
 *             (SemanticStore.tombstone only sets tombstoned=1, idempotent by design).
 *
 * T-20-11 (Spoofing): the calendar:cancelled set is written ONLY by our own CalendarAdapter
 * from verified API status==='cancelled' events; it is not externally writable.
 */

/**
 * Minimal interface for the store parameter.
 * SemanticStore implements both halves; tests may inject a stub.
 */
export interface TombstoneStore {
  /** Tombstone a node by id (sets tombstoned=1, clears training_eligible, removes from FTS). */
  tombstone(id: string): void;
  /** Find all node_ids whose node_temporal.source_event_id matches the given calendar event id. */
  getNodeIdsBySourceEventId(sourceEventId: string): string[];
}

export interface TombstoneMeta {
  /** Read a meta value by key. Returns null if not found. */
  getMeta(key: string): string | null;
  /** Write or overwrite a meta key/value pair. */
  setMeta(key: string, value: string): void;
}

/**
 * Process all pending calendar cancellations for the given accounts.
 *
 * For each accountId:
 *  1. Read `calendar:cancelled:<accountId>` from meta (JSON string[])
 *  2. For each cancelled master id, find all nodes via node_temporal.source_event_id
 *  3. Tombstone each matching node
 *  4. Clear the meta set to '' (empty JSON array)
 *
 * Returns the total count of nodes tombstoned across all accounts.
 *
 * This function is called in the offline sleep pass, AFTER the consolidation step
 * (CONSOL-03 discipline: graph mutations live in the sleep pass, not in adapters).
 *
 * @param store      Store with tombstone + getNodeIdsBySourceEventId (SemanticStore in prod).
 * @param meta       Meta store with getMeta/setMeta (same SemanticStore in prod).
 * @param accountIds Google account ids to process (from config.googleAccounts.map(a => a.id)).
 */
export function runCalendarCancellations(
  store: TombstoneStore,
  meta: TombstoneMeta,
  accountIds: string[],
): number {
  let totalTombstoned = 0;

  for (const accountId of accountIds) {
    const metaKey = `calendar:cancelled:${accountId}`;
    const raw = meta.getMeta(metaKey);

    let cancelledIds: string[];
    try {
      cancelledIds = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      // Corrupt meta — treat as empty and reset
      cancelledIds = [];
    }

    if (cancelledIds.length === 0) {
      continue;
    }

    for (const eventId of cancelledIds) {
      const nodeIds = store.getNodeIdsBySourceEventId(eventId);
      for (const nodeId of nodeIds) {
        store.tombstone(nodeId);
        totalTombstoned++;
      }
    }

    // Clear the side-channel after processing (idempotent reset)
    meta.setMeta(metaKey, '[]');
  }

  return totalTombstoned;
}
