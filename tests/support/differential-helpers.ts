/**
 * differential-helpers.ts (62-28-PLAN.md, Task 2) — the ONE definition site for the marker
 * scheme and the hard-failure gate shared by every oracle-driven differential in this phase.
 *
 * Extracted (not copied) from `tests/css-liveness-differential.test.ts`, which originated
 * `classMarker`/`idMarker`/`throwIfFailures` (62-19-PLAN.md Task 1, hard-gated by 62-25). A
 * second, independently-maintained copy of this scheme in `tests/html-wrapper-differential.test.ts`
 * would be exactly the "two parts of the module hold different opinions about one boundary"
 * failure mode `62-VERIFICATION.md` names as this phase's own recurring root cause
 * (T-62-28-06) — so this module is the one place either differential may define them, and
 * both import from here.
 */

/**
 * Delimiter-bounded so no probe name's marker is ever a substring of another probe name's
 * marker (e.g. "legal" is a prefix of "legalid" — a bare `PL_${name}` scheme would make
 * `PL_legal` a false-positive substring match of `PL_legalid`).
 */
export function classMarker(name: string): string {
  return `PL[${name}]`;
}

export function idMarker(name: string): string {
  return `PLID[${name}]`;
}

/**
 * The hard gate: throws with every unclassified divergence's full text (up to the first ten,
 * so a run with hundreds of failures still produces a readable report) if `failures` is
 * non-empty. A bounded magnitude counter is not a gate (CR-11, `62-REVIEW.md`) — this throws
 * unconditionally on ANY unattributed divergence, no matter how small `failures.length` is.
 */
export function throwIfFailures(failures: string[], contextLabel: string): void {
  if (failures.length === 0) return;
  const shown = failures.slice(0, 10);
  throw new Error(
    `${contextLabel}: ${failures.length} unclassified divergence(s) found. First ${shown.length}:\n\n` +
      shown.join('\n---\n')
  );
}
