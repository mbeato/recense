---
phase: 62-multi-inbox-email-ingest-hardening
plan: 05
subsystem: consolidation
tags: [email-ordering, consolidation-seam, security, temporal]

# Dependency graph
requires:
  - phase: 62-04
    provides: "episode.event_ts (nullable epoch ms) and parseEmailDate's confident-or-null future-skew clamp"
provides:
  - "orderEpisodesForConsolidation(rows) — pure, permutation-safe, slot-preserving chronological reorder"
  - "consolidate() processes a fresh account's backfill batch oldest-first among event-time-bearing episodes"
affects: [65]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Slot-preserving reorder: collect indices of a subset, sort only that subset's values, write back into the SAME index set — preserves an existing priority ordering (D-03/D-10 hard_keep/salience) for everything the subset doesn't touch, rather than replacing the whole ordering"
    - "Dynamic-judge test provider: a hand-written ModelProvider (not MockModelProvider's static verdict queue) whose judge() resolves best_candidate_id from the live candidates array, needed when a test's second episode must contradict a node minted at runtime by the first episode (its id is unknowable at test-authoring time)"

key-files:
  created:
    - src/consolidation/episode-order.ts
    - tests/episode-order.test.ts
    - tests/backfill-chronological-order.test.ts
  modified:
    - src/consolidation/consolidator.ts

key-decisions:
  - "Corrected research PITFALLS.md Pitfall 5's proposed fix (sort the backfill batch by Date: header before appending) — verified it would be dead code, since consolidation order is EpisodicStore.listUnconsolidated()'s ORDER BY hard_keep DESC, salience DESC, not append order, and Consolidator.consolidate() processes that list in strict index order. The fix instead wraps listUnconsolidated() with orderEpisodesForConsolidation at the consolidation seam."
  - "Slot-preserving, not a global chronological sort: only the index positions occupied by event_ts-bearing rows are permuted among themselves; null-event_ts rows (every non-Gmail source today, plus any Gmail message whose Date: header parseEmailDate rejected) never move. This keeps the SQL ORDER BY's D-03/D-10 replay-priority semantics — and its truncated-pass resilience guarantee (same prefix, same count survives a budget cap or lock-stale restart) — completely intact for every other source."
  - "SQL ORDER BY in episode-store.ts is untouched (verified via empty git diff --stat as a task acceptance criterion) — a global chronological sort would let an old, low-salience backlog message displace a high-salience recent episode out of a truncated pass, degrading resilience for every source, not just email."
  - "idx_episode_event_ts (consolidated, event_ts), added speculatively in plan 62-04 for an SQL-side ordering, is NOT used by this implementation — the reorder happens entirely in memory over the array already returned by listUnconsolidated() (a single SELECT with no event_ts predicate or ORDER BY term). The index is effectively dead for this feature as implemented. Not dropped in this plan (out of declared file scope, and schema.ts is not in files_modified) — flagged here per the plan's instruction not to leave it silently dead; a future schema-cleanup pass should drop it unless another consumer emerges."
  - "The end-to-end test's fixture assigns the OLDER-state episode LOWER salience and the NEWER-state episode HIGHER salience — the opposite pairing from the plan's illustrative prose (which paired older-state with higher salience and asked for post-reorder order [A,B] with A as the newer episode). That literal example is not achievable simultaneously with 'final value = the newer episode's state' under this codebase's actual reconcile-last-applied-wins mechanics (verified directly against src/consolidation/update-decision.ts's routeContradiction: a mid-band ratio tombstones the existing node and mints a new current node from the LAST-processed contradiction, so whichever episode is processed last determines the survivor). Given bare listUnconsolidated() must place the wrong-should-not-survive episode last (to demonstrate the bug) and the ascending-event_ts reorder must place the newer episode last (so its reconcile is the one that survives, closing the bug), the newer episode necessarily needs the HIGHER salience so it sorts first under bare salience-DESC and last under the event_ts-ascending reorder. This is a Rule 1 (bug in the plan's specific test-fixture prose) correction — the underlying algorithm (episode-order.ts, ascending event_ts, slot-preserving) and every literal acceptance criterion (bare order asserted, reorder differs from bare order, both saliences clear the gmail threshold, both consolidated=1, negative control, ordering-seam guard) are all satisfied exactly as specified."

requirements-completed: [EMAIL-04]

# Metrics
duration: ~50min
completed: 2026-07-30
---

# Phase 62 Plan 05: Slot-Preserving Chronological Reorder at the Consolidation Seam Summary

**`orderEpisodesForConsolidation` wraps `Consolidator.consolidate()`'s call to `listUnconsolidated()` with a pure, permutation-safe reorder that processes event-time-bearing episodes oldest-first while leaving every other episode's array slot untouched — closing the exact bug where a fresh Gmail account's non-chronological backfill batch could let an older message silently overwrite newer status, proven end-to-end through the real, unmodified PE-gate machinery.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-07-30
- **Tasks:** 2 (both `type="auto"`, no checkpoints)
- **Files modified:** 4 (3 new, 1 modified)

## Accomplishments

- **Corrected the research's proposed fix before writing any code.** `PITFALLS.md` Pitfall 5 proposed sorting the backfill batch by `Date:` header at append time. Verified against live source (`src/db/episode-store.ts` `stmtListUnconsolidated` = `ORDER BY hard_keep DESC, salience DESC`, and `Consolidator.consolidate()`'s "EPISODE ORDER IS SEMANTICS" comment) that this would be dead code: consolidation order is not append order, so an append-time sort is discarded by the very next salience-ordered query. The real fix lands at the consolidation seam.
- **`orderEpisodesForConsolidation`** (`src/consolidation/episode-order.ts`) is a pure, allocation-only, permutation-safe reorder: it collects the indices of rows carrying a non-null `event_ts`, sorts only those rows by `event_ts` ascending (tie-break: `id` ascending), and writes them back into exactly the same index slots. Null-`event_ts` rows — every non-Gmail source today, plus any Gmail message whose `Date:` header `parseEmailDate` (plan 62-04) rejected — never move, which is also what closes the forged-far-future-header attack (T-62-30): a rejected date stays in its ordinary salience slot instead of being granted a late position.
- **Wired into `consolidate()`** at the single call site (`orderEpisodesForConsolidation(this.episodes.listUnconsolidated())`), with the existing "EPISODE ORDER IS SEMANTICS" comment block extended in place rather than duplicated elsewhere. `episode-store.ts`'s SQL `ORDER BY` and `update-decision.ts` (`routeContradiction`, `isOscillation`, `countDistinctProvenance`) are both untouched, verified via empty `git diff --stat` on both files.
- **End-to-end proof** (`tests/backfill-chronological-order.test.ts`) exercises the real `consolidate()`, not the sort function in isolation: a two-message reverse-chronological Gmail backfill batch (older status, lower salience, earlier `event_ts`; newer status, higher salience, later `event_ts`) asserts its own preconditions (bare `listUnconsolidated()` order, both saliences clearing `consolSkipThresholdBySource['gmail']` = 0.4, an ordering-seam guard proving the reorder actually differs from the bare order) before asserting the final untombstoned node carries the newer state and both episodes are `consolidated=1`. A null-`event_ts` negative control proves the pass still completes without asserting a value it has no chronological basis to guarantee.

## Task Commits

Each task was committed atomically:

1. **Task 1: `orderEpisodesForConsolidation` — the slot-preserving chronological reorder** — `da36cf4` (feat)
2. **Task 2: Wire into `consolidate()` and prove the backfill case end-to-end** — `1305099` (feat)

**Plan metadata:** (this SUMMARY commit, made immediately after this file)

## Files Created/Modified

- `src/consolidation/episode-order.ts` (new) — `orderEpisodesForConsolidation(rows)`; full doc block covers the slot-preserving rationale, the T-62-30 forged-header defense, and the named cross-pass/cross-account residual.
- `tests/episode-order.test.ts` (new) — 10 tests: reverse-chronological reorder, slot preservation with a null row interspersed, all-null no-op, empty/single-element no-ops, 50-row shuffled permutation property, non-mutation (deep-clone comparison), determinism/idempotence (`f(f(x))` deep-equals `f(x)`), equal-timestamp tie-break by `id`, and the T-62-30 security case (a null `event_ts` never moves to the end).
- `src/consolidation/consolidator.ts` — one new import, one call-site change (`listUnconsolidated()` wrapped), and the "EPISODE ORDER IS SEMANTICS" comment extended with the EMAIL-04 refinement and the rationale for leaving the SQL `ORDER BY` unchanged. Nothing else in `consolidate()` touched (quarantine set, chunk slicing, per-episode loop, skip gate, all downstream branches byte-identical).
- `tests/backfill-chronological-order.test.ts` (new) — the EMAIL-04 end-to-end proof plus the null-`event_ts` negative control, built on the `tests/consolidator.test.ts` harness pattern with a hand-written `DynamicReconcileProvider` (dynamic `judge()` resolving `best_candidate_id` from the live candidate set, since the second episode's contradiction target is minted at runtime).

## Decisions Made

See `key-decisions` in the frontmatter for the four load-bearing choices (the research correction, slot-preserving vs. global sort, the untouched SQL `ORDER BY`, and the dead-index finding). One additional note on the test-fixture correction:

**The plan's illustrative fixture prose was internally inconsistent and could not be implemented literally.** The plan's Task 2 example paired the OLDER-content episode with HIGHER salience and the NEWER-content episode with LOWER salience, then separately required (a) the post-reorder array to differ from the bare array, and (b) the final node value to be the newer episode's state. Tracing this codebase's actual contradiction-routing mechanics (`routeContradiction` mid-band `reconcile`: tombstone the existing node, mint a new current node from the LAST-processed contradiction in the array actually fed to `consolidate()`) shows these three requirements cannot hold simultaneously under the plan's literal salience pairing — whichever episode is fed LAST to `consolidate()` becomes the final value, and the plan's stated salience assignment makes the bare and reordered arrays identical (no fix demonstrated) or makes the reorder produce the OLDER episode as final (contradicting the stated goal), depending on which literal detail is honored. I resolved this by keeping every literal, testable acceptance criterion (bare-order assertion, ordering-seam-differs assertion, both-saliences-clear-threshold assertion, both-consolidated assertion, negative control, final-value-is-the-newer-episode assertion) and swapping only the illustrative salience pairing (newer=higher salience, older=lower salience) to the only assignment under which all of those criteria are simultaneously true and mechanically verified — confirmed empirically: the test passes on the first run with the actual `Consolidator` and no scripted-verdict hand-waving.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in plan prose] Task 2's illustrative salience/event_ts pairing for the end-to-end fixture was internally inconsistent with the stated success assertions**
- **Found during:** Task 2, while designing the end-to-end test fixture
- **Issue:** The plan's literal example (older-content episode = higher salience; newer-content episode = lower salience; expected post-reorder array `[A,B]` with `A`=newer) cannot simultaneously satisfy "bare order differs meaningfully from reorder" and "final value = newer episode's state" under the codebase's real reconcile-last-applied-wins routing (verified against `update-decision.ts`). Implementing it literally would either produce a bare order identical to the reordered one (no bug demonstrated, violating T-62-36) or a final value equal to the OLDER episode even after the fix (contradicting the plan's own stated success criterion).
- **Fix:** Kept every literal, testable acceptance criterion; swapped the illustrative salience pairing (newer episode gets the higher salience, older episode gets the lower one) — the only assignment under which the bare array places the newer episode first (demonstrating the bug: it gets overwritten by the older episode processed last) and the reordered array places the older episode first (fixing it: the newer episode, processed last, survives).
- **Files modified:** `tests/backfill-chronological-order.test.ts` (written directly with the corrected pairing; no separate revert needed)
- **Verification:** Test passes on first run against the real, unmodified `Consolidator`/`routeContradiction`; all other acceptance criteria (bare order, ordering-seam difference, threshold clearance, `consolidated=1`, negative control) hold exactly as specified in the plan.
- **Committed in:** `1305099` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 plan-prose bug — Rule 1)
**Impact on plan:** No change to the shipped algorithm, the production code path, or any acceptance criterion's substance — only the specific numeric salience pairing in one test's illustrative fixture, corrected to make the test actually exercise (and pass) the real mechanism instead of an unreachable combination.

## Issues Encountered

None beyond the deviation above.

## Verification Results

- `npx tsc --noEmit` — exits 0 (checked after each task).
- `npx vitest run tests/episode-order.test.ts` — 10/10 pass.
- `npx vitest run tests/backfill-chronological-order.test.ts` — 2/2 pass.
- `npx vitest run tests/backfill-chronological-order.test.ts tests/episode-order.test.ts tests/consolidator.test.ts tests/consolidation.test.ts tests/consolidation-source.test.ts tests/consolidation-temporal.test.ts tests/consolidation-scope.test.ts` — **87/87 pass, zero assertion edits to any pre-existing test file.**
- `git diff --stat src/db/episode-store.ts src/consolidation/update-decision.ts` — empty on both.
- `grep -n "orderEpisodesForConsolidation" src/consolidation/consolidator.ts` — exactly one import line, one call site, one doc-comment reference.
- **Full suite, serial (`npm run build && npx vitest run --no-file-parallelism`):** **2857 passed / 4 skipped (192 files passed / 1 skipped, 193 total)** — zero failures. Matches the stated 0-failed baseline; the 4-vs-3 skipped-count variance was already investigated and attributed to legitimately conditional `skipIf` gates in plan 62-04's SUMMARY (dataset-presence and live-test env-var gates, none reachable from this plan's changed files).
- **Net result: zero test failures introduced by this plan.**

## Accepted Residual (named, not claimed as closed)

Per the plan's `<context>` and threat T-62-35: this reorder operates within ONE consolidation pass's unconsolidated set only. Two accounts backfilling in different passes, or evidence arriving after a pass already completed, are NOT ordered relative to already-consolidated episodes. The routing-side defense for that cross-pass/cross-account case is DRIFT-04 (Phase 65), which must consult `event_ts` inside `routeContradiction` itself — deliberately untouched here.

## Next Phase Readiness

- `episode.event_ts` now has a full consumer: source-asserted send time flows from Gmail's `Date:` header through to consolidation processing order.
- `idx_episode_event_ts` is confirmed unused by this implementation (in-memory reorder, no SQL predicate on the column) — flagged for a future schema-cleanup pass rather than dropped here (out of this plan's declared file scope).
- No blockers for Phase 65 (Belief-Gated Status Drift), which is expected to consume `event_ts` inside the routing decision itself for the cross-pass residual named above.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*

## Self-Check: PASSED

- `src/consolidation/episode-order.ts` — FOUND
- `tests/episode-order.test.ts` — FOUND
- `tests/backfill-chronological-order.test.ts` — FOUND
- `src/consolidation/consolidator.ts` (modified, diff verified above) — FOUND
- Commit `da36cf4` — FOUND in `git log --oneline --all`
- Commit `1305099` — FOUND in `git log --oneline --all`
