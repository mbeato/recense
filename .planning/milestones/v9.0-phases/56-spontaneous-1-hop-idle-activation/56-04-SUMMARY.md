---
phase: 56-spontaneous-1-hop-idle-activation
plan: 04
subsystem: test
tags: [typescript, vitest, viz, retrieval-engine, idle-activation, regression-guard]

# Dependency graph
requires:
  - phase: 56-01
    provides: "src/retrieval/honest-trace.ts — buildHonestOneHopTrace pure helper + HonestTraceReader interface"
  - phase: 56-02
    provides: "src/viz/server.ts — pickSpontaneousSeeds(pool, count, rng) exported pure sampler; the eligible-seed pool builder and spontaneousInterval emitter region"
provides:
  - "tests/spontaneous-idle-activation.test.ts — SPONT-06 regression lock: deterministic real-edge cross-check of every spontaneous hop + no-activation_trace-write / no-new-Database() guard"
affects: [56-05, viz-spontaneous-emitter-regression-safety]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Deterministic seeded LCG rng injected into pickSpontaneousSeeds for reproducible sampling in tests (mirrors the injectable-rng seam Plan 02 exposed)"
    - "Real-edge cross-check pattern (assert against store.getOutEdgesWithRel(hop.src), not the payload) mirrors the Phase-55 guard style in tests/activation-trace-wiring.test.ts:435-460"
    - "Static source-text block-slice guard (readServer + stripComments + toContain/not.toContain) mirrors tests/viz-ambient-liveliness.test.ts's server.ts inspection pattern"

key-files:
  created:
    - tests/spontaneous-idle-activation.test.ts
  modified: []

key-decisions:
  - "Task 2's dynamic no-write guard exercises the emit-payload construction directly (pickSpontaneousSeeds + buildHonestOneHopTrace against a fixture reader) rather than starting a real HTTP server and waiting out real setInterval timers (SPONT_CADENCE_MS=2500ms / REPLAY_IDLE_GAP_MS=5000ms) — the plan explicitly permitted this as the second option ('directly invoking the extracted emit-payload construction against the reader'), and it is deterministic/fast versus a timing-dependent live-server test."
  - "buildFixture() uses count === pool.length when calling pickSpontaneousSeeds so the full 3-seed eligible pool (including the 8-edge seedA) is always picked deterministically — this guarantees the top-N truncation assertion always has data to check, while the injected seeded rng still exercises the real shuffle/sampling code path (order is still randomized, just the full set is retained)."
  - "SPONT_HOP_TOPN=6 kept as a private literal constant in the test file (not imported/exported), mirroring the existing AMBIENT_HOP_TOPN convention documented in the Phase-55 guard test — matches the plan's own D-10 discretion language."

requirements-completed: [SPONT-06]

# Metrics
duration: ~20min
completed: 2026-07-01
---

# Phase 56 Plan 04: SPONT-06 spontaneous-hop honesty + no-write regression lock Summary

**Deterministic vitest guard (`tests/spontaneous-idle-activation.test.ts`) that cross-checks every emitted spontaneous 1-hop trace against the store as a real live `kind='relation'` PRED_SET out-edge, and proves the emit path writes no `activation_trace` row and opens no new `Database()`.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 2 completed
- **Files modified:** 1 (created)

## Accomplishments

- Real-edge cross-check: every hop's `(src → dst)` is verified present in `store.getOutEdgesWithRel(hop.src)` with `kind === 'relation'` and `PRED_SET.has(rel)` — not a trust-the-payload assertion.
- Exclusion proofs at the highest weight: a structural `extends` edge (weight 0.99, the single highest weight in the fixture) and a PRED_SET edge to a tombstoned dst (weight 0.95) are both proven absent from hops, confirming liveness-before-slot and the kind/PRED_SET filter both hold even against an adversarially high-weight distractor.
- Top-N truncation proven: `seedA` carries 8 live semantic edges (one more than `SPONT_HOP_TOPN=6`); exactly 6 hops (`r1..r6`, the top-6 by weight) are emitted for that seed.
- Determinism proven: `pickSpontaneousSeeds` called twice with a fresh instance of the same seeded rng produces byte-identical picked-seed order and identical hop arrays.
- No-write guard: `activation_trace` row COUNT and MAX(id) are read before/after exercising `pickSpontaneousSeeds` + `buildHonestOneHopTrace` against the fixture and asserted unchanged.
- Static source-text guard: the spontaneous-emitter region of `src/viz/server.ts` (from the "eligible-seed pool" comment through `spontaneousInterval.unref();`) is sliced, comments stripped, and asserted to contain no `new Database(`, no `INSERT INTO activation_trace`, and no `.run(` — while still containing `pickSpontaneousSeeds`/`buildHonestOneHopTrace` as a sanity check that the slice captured real code, not an empty match.
- Full project suite: 2553 passed / 3 skipped (was 2550/3 pre-plan — net +3 new tests, zero regressions); `tsc --noEmit` clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Honesty guard — every spontaneous hop is a real live PRED_SET out-edge (deterministic)** - `5107485` (test)
2. **Task 2: No-DB-write guard + read-only static gate (D-10/D-11)** - `dcc3e21` (test)

_Note: no plan-metadata commit — `.planning/` is gitignored per project convention; STATE.md/ROADMAP.md/SUMMARY.md updates are on-disk only and are not committed to git (matches 56-01/56-02 precedent)._

## Files Created/Modified

- `tests/spontaneous-idle-activation.test.ts` - SPONT-06 regression lock: a fixture-store honesty guard (real-edge cross-check, structural/tombstone exclusion, top-N truncation, determinism) plus a no-activation_trace-write guard and a static source-text read-only gate over `src/viz/server.ts`'s spontaneous emitter region.

## Decisions Made

- **Exercised the emit-payload construction directly rather than a live server + real timers for the no-write guard.** The plan offered two seams; starting `startVizServer` and waiting out `SPONT_CADENCE_MS` (2500ms) plus the shared `REPLAY_IDLE_GAP_MS` (5000ms) idle gate would make the test slow and timing-fragile. Calling `pickSpontaneousSeeds` + `buildHonestOneHopTrace` directly against a fixture reader (the exact same call shape the interval body uses) is deterministic, fast, and still proves the construction that produces the SSE payload never touches `activation_trace`.
- **`count === pool.length` in `pickSpontaneousSeeds` calls.** Guarantees the 8-edge `seedA` (needed for the top-N truncation assertion) is always among the picked seeds, removing dependency on guessing the injected rng's numeric output, while the rng still deterministically drives the internal shuffle order (verified via the double-run equality check).

## Deviations from Plan

None - plan executed exactly as written. Both tasks matched the plan's `<action>`/`<acceptance_criteria>` verbatim: real-edge cross-check via `getOutEdgesWithRel`, structural/tombstone exclusion at the highest weight, top-N cap, `score:null`/`hop:1` on every hop, honest `src` attribution, fixed pool + injected rng determinism (Task 1); no-write proof plus a static grep-style guard mirroring the Phase-54 `viz-ambient-liveliness.test.ts` source-text pattern (Task 2).

## Issues Encountered

One transient failure during development: the first version of the static guard's `not.toContain('new Database(')` assertion failed because the sliced block's own comments contain the literal phrase "no new Database()" (documentation text, not code). Fixed by adding a `stripComments()` helper (mirroring the one already in `tests/viz-ambient-liveliness.test.ts`) before running the `toContain`/`not.toContain` checks — resolved within the same task, no commit needed for the fix since it landed before the Task 2 commit.

## Known Stubs

None.

## Threat Flags

None — test-only additions exercising existing read-only code paths; no new inputs/writers/DB handles introduced. Matches the plan's own threat model (T-56-08 mitigated by this test itself; T-56-09 N/A since no server/interval was started in-test, so there is no leaked handle to guard against).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SPONT-06 is now machine-verified: the regression lock will fail CI if a future change reintroduces a fabricated edge/magnitude, lets a tombstoned/structural target leak into hops, or adds a write/second-Database-handle to the spontaneous emitter.
- Plan 05 (whatever remains in Phase 56) can proceed; no blockers from this plan.

---
*Phase: 56-spontaneous-1-hop-idle-activation*
*Completed: 2026-07-01*

## Self-Check: PASSED

- `tests/spontaneous-idle-activation.test.ts` — FOUND
- `5107485` — FOUND (in git log)
- `dcc3e21` — FOUND (in git log)
