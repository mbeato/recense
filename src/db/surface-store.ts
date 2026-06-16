/**
 * SurfaceStore — LLM-free composite ranking engine (SURF-01).
 *
 * rank() is read-only by construction — D-43.
 * No async/await, no embedding, no LLM calls on this hot path.
 * better-sqlite3 is fully synchronous — no async on the query layer.
 *
 * Scoring spec (D-01/D-02/D-03, ranking_spec in 21-02-PLAN.md):
 *   proximity(msToDue) = clamp(1 - msToDue / PROXIMITY_HORIZON_MS, 0, 1)
 *   salience(node.s)   = clamp(node.s, 0, 1)
 *   novelty            = 0 (no PE signal this phase — D-03 seam kept for future wire-in)
 *   score              = W_PROX * proximity + W_SAL * salience + W_NOV * novelty
 *   tier               = msToDue < P0_THRESHOLD_MS ? 0 (P0) : 1 (lower)
 *   sort               = tier ASC, score DESC
 *
 * T-01-SQL: all filter values are bound parameters — never string-interpolated.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';

// ---------------------------------------------------------------------------
// Ranking constants (ranking_spec from 21-02-PLAN.md)
// ---------------------------------------------------------------------------

/** Items due in less than this window are tier-0 (P0) and bypass the daily cap. */
const P0_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Default D-10 past-event grace: one-off items past this window are excluded. */
const DEFAULT_GRACE_MS = 3 * 60 * 60 * 1000;

/** Default D-09 rolling cap window (timezone-light 24h). */
const ROLLING_24H_MS = 24 * 60 * 60 * 1000;

/** Default D-09 max non-P0 items per rolling 24h window. */
const DEFAULT_CAP = 5;

/** Linear proximity-transform horizon — items beyond this have proximity = 0. */
const PROXIMITY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** D-02 conservative weights — proximity and salience equally weighted. */
const W_PROX = 0.5;
const W_SAL = 0.5;
/** D-03: novelty seam is wired but set to 0 until a PE signal exists. */
const W_NOV = 0.0;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A ranked, actionable item ready for rendering.
 * value and action_type are denormalized from node/node_temporal for cheap rendering
 * (no extra JOIN needed at display time — planner discretion).
 */
export interface SurfaceItem {
  node_id:     string;
  value:       string;       // node.value
  due_at:      string;       // ISO-8601 UTC from node_temporal.due_at
  action_type: string;       // node_temporal.action_type
  tier:        0 | 1;        // 0 = P0 (< 24h), 1 = lower
  score:       number;       // blended composite score [0, 1]
}

/**
 * Options for rank(). All fields optional — ranking_spec defaults apply when omitted.
 */
export interface SurfaceOpts {
  /** Current time in epoch ms (defaults to clock.nowMs()). */
  nowMs?:         number;
  /** D-10 past-event grace window in ms (default: 3h). */
  gracePeriodMs?: number;
  /** D-09 rolling cap window in ms (default: 24h). */
  capWindow?:     number;
  /** D-09 max non-P0 items in the cap window (default: 5). */
  maxNonP0?:      number;
}

// ---------------------------------------------------------------------------
// Internal row shapes returned by prepared statements
// ---------------------------------------------------------------------------

interface EligibleRow {
  node_id:         string;
  due_at:          string;
  action_type:     string;
  recurrence_rule: string | null;
  value:           string;
  s:               number;
  c:               number;
}

interface SurfacedEventRow {
  outcome:      string;
  snooze_until: string | null;
}

interface CapWindowRow {
  occurrence_due_at: string;
  created_at:        number;
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB I/O)
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function proximity(msToDue: number): number {
  return clamp(1 - msToDue / PROXIMITY_HORIZON_MS, 0, 1);
}

function salience(s: number): number {
  return clamp(s, 0, 1);
}

/**
 * D-07 exclusion predicate.
 *
 * Returns true (drop this occurrence from results) when:
 *  - outcome is a terminal state ('completed' or 'dismissed')
 *  - outcome is 'snoozed' AND snooze_until is still in the future
 *  - outcome is 'surfaced' or 'seen' (already shown for this occurrence)
 *
 * Returns false (keep in results) when:
 *  - no surfaced_event row exists for this occurrence
 *  - outcome is 'snoozed' but snooze_until is in the past (snooze expired)
 */
function isExcluded(evt: SurfacedEventRow | undefined, nowMs: number): boolean {
  if (!evt) return false;
  const { outcome, snooze_until } = evt;
  if (outcome === 'completed' || outcome === 'dismissed') return true;
  if (outcome === 'snoozed') {
    return snooze_until !== null && new Date(snooze_until).getTime() > nowMs;
  }
  if (outcome === 'surfaced' || outcome === 'seen') return true;
  return false;
}

// ---------------------------------------------------------------------------
// SurfaceStore
// ---------------------------------------------------------------------------

export class SurfaceStore {
  private readonly db: Database.Database;
  private readonly clock: Clock;

  // Prepared statements — initialized once in constructor (never per-call).
  // T-01-SQL: all filter values are bound parameters, never string-interpolated.
  private readonly stmtEligible: Database.Statement;
  private readonly stmtCapWindowRows: Database.Statement;
  private readonly stmtSurfacedEvent: Database.Statement;

  constructor(db: Database.Database, clock: Clock) {
    this.db    = db;
    this.clock = clock;

    // Eligibility query: node_temporal ⋈ node, tombstoned=0.
    //
    // D-10 recurring-exempt past-event guard: the OR clause lets recurring items
    // (recurrence_rule IS NOT NULL) bypass the pastCutoff filter — their due_at
    // may be in the past but they still require attention.
    //
    // T-01-SQL: @pastCutoff is a named bound parameter, never interpolated.
    this.stmtEligible = db.prepare(`
      SELECT
        nt.node_id,
        nt.due_at,
        nt.action_type,
        nt.recurrence_rule,
        n.value,
        n.s,
        n.c
      FROM node_temporal nt
      JOIN node n ON n.id = nt.node_id
      WHERE n.tombstoned = 0
        AND (nt.due_at >= @pastCutoff OR nt.recurrence_rule IS NOT NULL)
    `);

    // D-09 cap-window rows: the non-terminal items surfaced in the rolling window.
    // Excludes terminal outcomes ('completed', 'dismissed') since those are resolved
    // and should not occupy cap budget.
    //
    // WR-02: the D-09 cap is "max NON-P0 items per rolling 24h" — P0 items bypass the
    // cap and must NOT deplete the non-P0 budget. surfaced_event carries no tier column,
    // so we fetch (occurrence_due_at, created_at) and reconstruct the tier-at-surface-time
    // in rank() rather than COUNT(*)-ing every row. We filter in JS (not SQL) because
    // occurrence_due_at is canonical-ISO text and SQLite's date parser handling of the
    // 'Z'/fractional-seconds form is brittle (see IN-02); new Date().getTime() matches the
    // exact parsing rank() already uses for due_at.
    //
    // T-01-SQL: @windowStart is a named bound parameter.
    this.stmtCapWindowRows = db.prepare(`
      SELECT occurrence_due_at, created_at FROM surfaced_event
      WHERE created_at >= @windowStart
        AND outcome NOT IN ('completed', 'dismissed')
    `);

    // D-07 exclusion lookup: for a given (node_id, occurrence_due_at) pair,
    // fetch the existing surfaced_event outcome/snooze state if any.
    //
    // T-01-SQL: @node_id and @occurrence_due_at are named bound parameters.
    this.stmtSurfacedEvent = db.prepare(`
      SELECT outcome, snooze_until FROM surfaced_event
      WHERE node_id = @node_id AND occurrence_due_at = @occurrence_due_at
    `);
  }

  /**
   * rank() — synchronous, LLM-free composite ranking (SURF-01).
   *
   * rank() is read-only by construction — D-43.
   *
   * Returns SurfaceItem[] sorted by (tier ASC, score DESC):
   *  - P0 items (msToDue < 24h) come first, bypassing the rolling-24h cap.
   *  - Lower-tier items are capped to (maxNonP0 − capUsed) slots.
   *
   * Zero writes, zero LLM/embedding calls. Safe to call on the { readonly: true }
   * DB handle wired in Plan 03.
   */
  rank(opts: SurfaceOpts = {}): SurfaceItem[] {
    const nowMs         = opts.nowMs         ?? this.clock.nowMs();
    const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_MS;
    const capWindow     = opts.capWindow     ?? ROLLING_24H_MS;
    const maxNonP0      = opts.maxNonP0      ?? DEFAULT_CAP;

    // 1. D-10 past-event guard cutoff
    //    Recurring items bypass this via the SQL OR clause (recurrence_rule IS NOT NULL).
    const pastCutoff = new Date(nowMs - gracePeriodMs).toISOString();

    // 2. Pull all eligible rows in one query
    const rows = this.stmtEligible.all({ pastCutoff }) as EligibleRow[];

    // 3. D-09 cap: count NON-P0 non-terminal surfaced_event rows in the rolling window.
    //    WR-02: P0 surfacings bypass the cap, so they must not deplete the non-P0 budget.
    //    A row was P0 at surface time iff (occurrence_due_at − created_at) < P0_THRESHOLD_MS;
    //    only tier-1 (non-P0) rows count toward capUsed. created_at is epoch ms.
    const capRows = this.stmtCapWindowRows.all({ windowStart: nowMs - capWindow }) as CapWindowRow[];
    let capUsed = 0;
    for (const r of capRows) {
      const msToDueAtSurface = new Date(r.occurrence_due_at).getTime() - r.created_at;
      if (msToDueAtSurface >= P0_THRESHOLD_MS) capUsed += 1; // non-P0 only
    }

    // 4. Score each row; partition into P0 (tier=0) and lower (tier=1)
    const p0:    SurfaceItem[] = [];
    const lower: SurfaceItem[] = [];

    for (const row of rows) {
      const dueMs   = new Date(row.due_at).getTime();
      const msToDue = dueMs - nowMs;

      // D-07 exclusion check per occurrence
      const evt = this.stmtSurfacedEvent.get({
        node_id:           row.node_id,
        occurrence_due_at: row.due_at,
      }) as SurfacedEventRow | undefined;
      if (isExcluded(evt, nowMs)) continue;

      // Blended score (D-01/D-02/D-03)
      const prox    = proximity(msToDue);
      const sal     = salience(row.s);
      const novelty = 0; // no PE signal this phase (D-03 seam — W_NOV wired at 0)
      const score   = W_PROX * prox + W_SAL * sal + W_NOV * novelty;

      const tier: 0 | 1 = msToDue < P0_THRESHOLD_MS ? 0 : 1;

      const item: SurfaceItem = {
        node_id:     row.node_id,
        value:       row.value,
        due_at:      row.due_at,
        action_type: row.action_type,
        tier,
        score,
      };

      if (tier === 0) {
        p0.push(item);
      } else {
        lower.push(item);
      }
    }

    // 5. Sort within each tier by score DESC
    p0.sort((a, b)    => b.score - a.score);
    lower.sort((a, b) => b.score - a.score);

    // 6. D-09 cap: P0 items are unlimited; lower tier is capped
    const allowed = Math.max(0, maxNonP0 - capUsed);

    return [...p0, ...lower.slice(0, allowed)];
  }
}
