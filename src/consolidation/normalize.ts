/**
 * Shared value normalizer for the consolidation pass.
 *
 * Used by:
 *  - Plan 02-02 fast path (D-17): normalized exact-match → confirm, no judge call.
 *  - Plan 02-03 oscillation guard (D-20): normalized prev_value compare before reconcile.
 *
 * Both consumers MUST use this function so they agree on normalization.
 * Pure, module-level, no deps.
 */

/**
 * Normalize a node value for comparison: lowercase, trim outer whitespace,
 * and collapse internal whitespace runs to a single space.
 *
 * Example: "  Foo   Bar  " → "foo bar"
 */
export function normalizeValue(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}
