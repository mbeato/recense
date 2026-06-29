/**
 * remember-viz-bridge — bridges the synchronous `recense remember` result onto the
 * activation_trace SSE stream so a curated fact lights the brain live (Phase 52, Plan 05).
 *
 * Design invariants:
 *  D-01  One fact → one emit (no loop, no fan-out; far below POLL_MS flood risk).
 *  D-07  Fixed mid score on the reconsolidation hop — never a fabricated magnitude
 *        (the actual PE magnitude lives inside the transaction; the bridge sees only result).
 *  D-08 #2 Zero-duplicate: a reconcile produces ONE reconsolidation trace on the existing
 *        node and ZERO new_node traces — the kind switch enforces this structurally.
 *  T-52-11 Entire body in try/catch swallow; flag-gated Switchable sink; called AFTER the
 *        transaction with only the result — cannot perturb the belief write.
 *
 * WARN-1 (cross-seam shape lock): the reconcile mapping MUST match the exact shape Plan 03's
 * applyTrace reconsolidation branch consumes:
 *   seeds[0] = supersededNodeId  → the EXISTING node (flashed magenta by Plan 03)
 *   hops[0].node_id = newNodeId  → the ARRIVING candidate (green blip that merges in)
 *   kind = 'reconsolidation'     → triggers the hero choreography in Plan 03
 * A shape drift here is caught by the WARN-1 unit assertion in tests/remember-viz-bridge.test.ts.
 *
 * Wiring precedent:
 *  SwitchableActivationTraceSink pattern — src/adapter/ambient-recall.ts:115-116
 *  Fire-and-forget try/catch posture — src/consolidation/run-sleep-pass.ts:91-110
 */
import type Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/hash';
import {
  SwitchableActivationTraceSink,
  type ActivationTraceInput,
} from '../viz/activation-sink';
import type { RememberResult } from './remember-cli';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fixed mid activation score used for the reconsolidation hop (D-07).
 *
 * The actual PE magnitude from the judge lives inside the transaction and is
 * not available at bridge call time. A fixed 0.5 ("mid") accurately represents
 * "evidence strong enough to reconsolidate" without inventing a precise number.
 * This is the correct value under D-07 (WR-02: never present a fabricated magnitude).
 */
const MID_SCORE = 0.5;

// ---------------------------------------------------------------------------
// Pure mapper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Map a RememberResult to an ActivationTraceInput (pure — no I/O, no side effects).
 *
 * Action → kind mapping:
 *   insert      → new_node      (a brand-new fact lands in the graph; quiet green blip)
 *   reconcile   → reconsolidation (contradiction resolved in place; magenta hero flash)
 *   oscillation → oscillation   (flip-back detected; orange wavering pulse)
 *
 * WARN-1 contract (reconcile shape, consumed by Plan 03 applyTrace):
 *   seeds[0]       = supersededNodeId  (existing node — Plan 03 flashes this magenta)
 *   hops[0].node_id = newNodeId        (arriving candidate — Plan 03 animates as green blip)
 *   kind           = 'reconsolidation' (triggers hero choreography)
 */
export function rememberTraceInput(result: RememberResult): ActivationTraceInput {
  const query_id = newId();
  switch (result.action) {
    case 'insert':
      return {
        query_id,
        kind: 'new_node',
        seeds: [result.newNodeId],
        hops: [],
      };

    case 'reconcile':
      // WARN-1: seeds[0] = EXISTING node (superseded); hops[0] = ARRIVING candidate (new).
      // Plan 03's reconsolidation branch flashes seeds[0] magenta and animates hops[0] as
      // the green blip that merges into the existing position — exactly this shape.
      return {
        query_id,
        kind: 'reconsolidation',
        seeds: [result.supersededNodeId!], // bare string → back-compat seeds union (D-07)
        hops: [{ node_id: result.newNodeId, score: MID_SCORE, hop: 1 }],
      };

    case 'oscillation':
      return {
        query_id,
        kind: 'oscillation',
        seeds: [result.newNodeId], // the new oscillating value is the visible node
        hops: [],
      };
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget bridge (exported for wiring in remember-cli + tests)
// ---------------------------------------------------------------------------

/**
 * Emit one activation_trace row if viz is enabled; swallow ALL errors.
 *
 * Call AFTER the remember transaction completes, while the DB handle is still open.
 * A flag-read failure or emit failure MUST NEVER surface to the caller (T-52-11).
 * With viz_trace_enabled absent or '0', this returns immediately with zero writes.
 *
 * @param db    The same open DB handle used by remember-cli (synchronous, no new opens).
 * @param clock The same clock used by remember-cli (injected for testability).
 * @param result The RememberResult from runRemember — action + newNodeId + supersededNodeId.
 */
export function bridgeRememberToViz(
  db: Database.Database,
  clock: Clock,
  result: RememberResult,
): void {
  try {
    const traceSink = new SwitchableActivationTraceSink(db, clock);
    // refresh() re-reads the flag; returns false if disabled → Noop, zero writes.
    // The ctor already calls refresh() once; the explicit call here mirrors the pattern
    // from ambient-recall.ts (documents the intent and re-reads for flag consistency).
    if (!traceSink.refresh()) return;
    traceSink.emit(rememberTraceInput(result));
  } catch {
    // Intentional swallow — T-52-11: a flag-read or sink failure must never perturb
    // the remember write path. This function is fire-and-forget.
  }
}
