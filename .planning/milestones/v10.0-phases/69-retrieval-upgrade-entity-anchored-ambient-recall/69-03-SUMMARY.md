---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
plan: 03
subsystem: retrieval
tags: [retrieval, ambient-recall, entity-anchoring, scope-nudge, sqlite, ranking]

# Dependency graph
requires:
  - phase: 69-01
    provides: collectAnchoredFacts / EntityResolver-backed indexed prompt-token -> entity -> facts anchoring
  - phase: 69-02
    provides: retrieveRanked opts.anchoredIds (floor-exempt union) and opts.hopCollector
provides:
  - "cwd-aware ambientRecall — the ambient/injected path now derives its caller's project scope for the first time"
  - "Anchored-candidate union gated on config.entityAnchoringEnabled, fail-open, reserved-slot capped"
  - "Ordering-only same-project rank nudge + foreign-doc demotion (the bounded D-01 D-S1 partial reversal)"
  - "D-01 carve-out recorded at SemanticStore.getNodeScopes' doc comment (single call-site exception)"
affects: [69-04, 69-05, 69-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reserved-slot selection: a stable rankScore-sorted copy of results, then AMBIENT_K - min(RESERVED, anchoredPresent) general-merit slots, backfilled by highest-ranked anchored rows not yet selected, backfilled again by remaining rank order — caps forced-in floor-exempt rows without capping anchored rows that earn a spot on merit"
    - "Ordering-only rank signal: a separate rankScore(r) sort key that never mutates r.score, so the rendered value is always the true cosine regardless of nudge magnitude"
    - "Single-read scope map serving both a pre-existing display marker and a new ranking signal, moved before slicing so both consumers share it"

key-files:
  created: []
  modified:
    - src/adapter/ambient-recall.ts
    - src/adapter/turn-capture-cli.ts
    - src/db/semantic-store.ts
    - tests/ambient-recall.test.ts

key-decisions:
  - "D-01 (verbatim, per plan's required-record instruction): D-S1 ('scope is provenance, not a retrieval signal') is deliberately PARTIALLY REVERSED for the ambient ranking path ONLY. Scope becomes a rank nudge (same-project boost + foreign-doc demotion), NEVER a filter — cross-project recall is preserved, a foreign-scope fact is always still injectable, only its rank position can move. Scope still never gates existence. `recense recall --scope` and every other getNodeScopes(s) caller keep the original filter-never, order-never semantics unchanged; ambient-recall.ts is the single carve-out call site, recorded at SemanticStore.getNodeScopes' own doc comment."
  - "Reserved-slot budget (ANCHOR_RESERVED_SLOTS=2) caps only FORCED-IN floor-exempt anchored rows — an anchored fact that also clears the general rank order on its own merit competes there like any other row and never counts against the budget. This keeps 'anchored' from meaning 'privileged' beyond the F5 precision guard the plan specified."
  - "getCachedNode: node reads for isForeignDoc and the render loop's origin lookup share one Map so no id is read from the node table twice per ambientRecall call."

requirements-completed: [RECALL-01, RECALL-02]

# Metrics
duration: 13min
completed: 2026-08-03
---

# Phase 69 Plan 03: cwd-Aware Ambient Recall — Entity Anchoring + Ordering-Only Scope Nudge Summary

**`ambientRecall` now threads `cwd`, unions entity-anchored facts through reserved floor-exempt slots, and re-orders (never filters) by an ordering-only same-project nudge / foreign-doc demotion — all inert at dark defaults, all gated behind `config.entityAnchoringEnabled` or a `0`-valued weight.**

## Performance

- **Duration:** ~13 min (08:30–08:43 local, commit timestamps)
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- `ambientRecall` gains a 6th optional `cwd` parameter (default `''`), derives `currentScope` via `cwdToScope` (mirroring the `retrieveCueless(cwd)` soft-scoping precedent) — the ambient path can now tell "same project" for the first time. `turn-capture-cli` passes its already-extracted `cwd` through.
- Entity anchoring wired end to end: gated on `config.entityAnchoringEnabled`, constructs an `EntityResolver` in-place, calls `collectAnchoredFacts`, unions the anchored ids into `retrieveRanked` via `opts.anchoredIds`. The whole block is fail-open (any throw resets to `[]`, cosine-only continues) — the hook can never fail because anchoring failed.
- Reserved-slot selection replaces the old `results.slice(0, AMBIENT_K)`: a stable rank-sorted copy of `results` fills `AMBIENT_K - reserved` general-merit slots, then backfills up to `ANCHOR_RESERVED_SLOTS` (2) more with the best anchored rows not already selected, then fills any remainder by rank order. Verified end to end: 5 strong cosine hits + 4 anchored facts injects exactly 3 cosine + 2 anchored.
- Ordering-only same-project rank nudge (`sameProjectRankNudge`) and foreign-doc demotion (`foreignDocDemotion`) computed via a separate `rankScore(r)` sort key that never touches `r.score` — the rendered `score X.XX` is always the true cosine, and every row in `results` stays selectable regardless of rankScore (D-01: nudge, never filter). A GLOBAL-scope doc is never demoted; a foreign-scope doc is, while remaining present.
- `SemanticStore.getNodeScopes`' doc comment amended to record the bounded D-01 partial reversal of D-S1: display-only, filter-never, order-never for every caller EXCEPT `ambient-recall.ts`, where the same map also feeds the ordering-only nudge — never existence, never the cosine floor, never a displayed score. Diff to `semantic-store.ts` is comment-only (verified via `git diff`).
- With `entityAnchoringEnabled:false` and both weights `0` (the shipped defaults), the injected block is byte-identical to pre-phase — locked by a hard-coded expected-string test.

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread cwd into ambientRecall and record the D-01 carve-out at the scope source of truth** - `c67e95b` (feat)
2. **Task 2: Anchored-candidate union with reserved slots, and the ordering-only scope nudge** - `c428edb` (feat)
3. **Task 3: End-to-end ambient tests for anchoring, reserved slots, and the bounded nudge** - `16033bb` (test)
4. **Fixup: reword a Task 1 comment to satisfy the getNodeScopes single-call-site acceptance grep literally** - `1a187f7` (fix)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP, owned by the orchestrator)

## Files Created/Modified
- `src/adapter/ambient-recall.ts` - `cwd` param + `currentScope` derivation; entity-anchoring block (gated, fail-open); reserved-slot selection replacing the flat slice; `rankScore`/`isForeignDoc` ordering-only sort keys; `getCachedNode` shared node-read cache; new `T-RT1-06` threat bullet; two new private constants (`ANCHOR_RESERVED_SLOTS`, `MAX_ANCHOR_PROBE_CHARS`)
- `src/adapter/turn-capture-cli.ts` - passes `cwd` as `ambientRecall`'s 6th argument
- `src/db/semantic-store.ts` - `getNodeScopes` doc comment amended to record the bounded D-01 carve-out (comment-only diff, no signature/body change)
- `tests/ambient-recall.test.ts` - 7 new `it` blocks (f. through l.): dark-default byte-identity, F2 end-to-end anchored-fact appear/absent-by-knob, reserved-slot cap (5+4 -> 3+2), same-project nudge reordering while both facts remain present ("never a filter"), rendered score staying the true cosine while the nudge is non-zero, foreignDocDemotion ordering with a global-scope doc left unaffected, and AMBIENT_FLOOR still gating unanchored candidates regardless of knob state — plus `factLines`/`seedScope` helpers and synthetic entity/edge/doc graph fixtures

## Decisions Made
- D-01 restated verbatim in scope (per the plan's required-record instruction): the D-S1 partial reversal applies to ambient ranking only, the nudge is never a filter, and `recense recall --scope` semantics are unchanged. See `key-decisions` in the frontmatter for the full text.
- Reserved-slot budget caps only facts FORCED in beyond what general rank order would already select — an anchored fact that also clears the top ranks on cosine merit doesn't consume the budget. This was the plan's own step-4 selection algorithm (top `AMBIENT_K - reserved` by rank, backfill anchored, backfill remainder), implemented literally.
- Node reads (`isForeignDoc`'s type check, the render loop's `origin` lookup) share one `getCachedNode` Map so no id is read from the node table twice per call, per the plan's explicit instruction to reuse the renderer's existing `getNode` call.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reworded a Task 1 comment that literally named `getNodeScopes`, doubling the acceptance grep count**
- **Found during:** Post-Task-2 acceptance verification
- **Issue:** Task 1's D-01 comment above the `getNodeScopes` call referenced the method name literally (`` `SemanticStore.getNodeScopes` ``), which made Task 2's acceptance check (`grep -c "getNodeScopes" src/adapter/ambient-recall.ts` returns 1 — "called exactly once") return 2: one real call, one comment mention. The functional invariant (exactly one call) already held; this was a literal-grep/comment-wording mismatch, not a behavior bug.
- **Fix:** Reworded the comment to describe the carve-out without repeating the method's literal name a second time.
- **Files modified:** `src/adapter/ambient-recall.ts`
- **Verification:** `grep -c "getNodeScopes" src/adapter/ambient-recall.ts` now returns 1; `npm run typecheck` clean; `tests/ambient-recall.test.ts` + `tests/recall-scope.test.ts` (15/15) still pass.
- **Committed in:** `1a187f7`

---

**Total deviations:** 1 auto-fixed (1 bug fix, acceptance-criterion literal-match correctness)
**Impact on plan:** Cosmetic wording fix only, no behavior or scope change.

## Issues Encountered
- 24 pre-existing test failures across 8 files (`tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`, `tests/drift-05-harness-smoke.test.ts`, `tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`, `tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`, `tests/locomo-scorer.test.ts`) — the same recurring dist/-dependent environment gap already logged from 69-01/69-02 (all spawn a compiled CLI via `spawnSync`, and this worktree has no `dist/`). Confirmed unrelated to this plan's files; not fixed, per the Scope Boundary rule; appended a short confirming note to the shared `deferred-items.md`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The injected block's *selection and order* are now final for 69-04 to build rendering on top of (doc title+link, hop lines, block budget) — 69-04 explicitly does not touch selection/ranking, only presentation.
- `anchoredById` (keyed `Map<string, AnchoredFact>`) is retained in scope specifically so 69-04's renderer can read `entityValue`/`via` for the provenance marker without a second `collectAnchoredFacts` pass.
- All new behavior remains dark (`entityAnchoringEnabled:false`, `sameProjectRankNudge:0`, `foreignDocDemotion:0`) until 69-06's eval gate passes (D-09) — no live behavior change ships in this plan.
- No blockers for 69-04/69-05/69-06.

## Self-Check: PASSED

All modified files confirmed present on disk; all 4 commit hashes (`c67e95b`, `c428edb`, `16033bb`, `1a187f7`) confirmed present in `git log --oneline --all`.

---
*Phase: 69-retrieval-upgrade-entity-anchored-ambient-recall*
*Completed: 2026-08-03*
