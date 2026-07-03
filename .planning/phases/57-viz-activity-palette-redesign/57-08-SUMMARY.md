---
phase: 57-viz-activity-palette-redesign
plan: 08
subsystem: viz
tags: [three.js, sse, activation-trace, code-review-gap-closure, regression-tests]

# Dependency graph
requires:
  - phase: 57-01
    provides: KIND_COLOR palette (identity hues) and REPLAY_DIM/SPONT_DIM subordination model
  - phase: 57-06
    provides: WR-06 own-trace-scoped fade pattern (replay + spontaneous branches), removed the prior global ctx.traceNodes.clear()
provides:
  - "CR-01 closed: all five _applyIngestion add-sites (new_node, oscillation, reconsolidation seed+candidate, neutral fallback) now schedule their own scoped fade timer that deletes only the ids that branch added, bounding ctx.traceNodes growth permanently"
  - "detail.js focusNode's reveal-lifetime comment corrected to state the true sticky-until-reload, user-driven semantics (no longer claims a fade-back that never happens)"
  - "CR-02 closed: trace.js replay branch resolves non-recall seedColor/hopColor to KIND_COLORS.neutral instead of undefined, so activate()'s kindColor||HOT_COLOR fallback can never paint a replayed ingestion-kind row live-amber"
  - "server.ts replay buffer admission guard now requires null/recall kind — defense-in-depth so ingestion-kind rows never enter the replay stream at all"
  - "Two behavioral regression tests (viz-ambient-liveliness.test.ts) lock the CR-01/CR-02 code-path selections, closing the WR-03-class blind spot the existing invariant suite didn't cover"
affects: [viz-activity-palette-redesign follow-ons, founder Stage-1/Stage-2 re-review of the palette]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Own-trace-scoped fade timer: every _applyIngestion add-site now captures its own added id(s) in a closure and deletes only those from ctx.traceNodes after a bounded fadeMs, never a global clear — extends the WR-06 pattern from the recall/replay/spontaneous branches to all five ingestion branches"

key-files:
  created: []
  modified:
    - src/viz/modules/trace.js
    - src/viz/modules/detail.js
    - src/viz/server.ts
    - tests/viz-ambient-liveliness.test.ts

key-decisions:
  - "focusNode's reveal stays sticky-until-reload (no scoped fade added) — a user-initiated focus of an LOD-hidden node is deliberate; auto-hiding it would fight the user's explicit camera action. Documented honestly instead of fixed with a timer, per the plan's own DECIDE instruction."
  - "Client-side neutral-color fix (trace.js) and server-side replay-buffer kind filter (server.ts) both landed — belt-and-suspenders: the client fix alone closes the D-04 amber-exclusivity guarantee even if the server filter is ever bypassed or extended incorrectly."

requirements-completed: [VIZ-PAL-01, VIZ-PAL-02, VIZ-PAL-04]

# Metrics
duration: 12min
completed: 2026-07-03
---

# Phase 57 Plan 08: CR-01/CR-02 Gap Closure Summary

**Closed the two verified blocker gaps from 57-VERIFICATION.md (WR-06 fix side effects): permanent ctx.traceNodes leak from five unscoped ingestion add-sites (CR-01), and replayed non-recall rows resolving to live HOT amber via an undefined-color fallback (CR-02) — plus two regression tests locking both code paths.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-03T15:04:56-04:00
- **Completed:** 2026-07-03T15:16:34-04:00
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- All five `_applyIngestion` add-sites (`new_node`, `oscillation`, `reconsolidation` seed+candidate, neutral fallback) now schedule their own scoped fade timer that deletes only the ids that branch added — `ctx.traceNodes.delete(` call-site count in `trace.js` went from 3 to 7, `ctx.traceNodes.clear()` stays at 0.
- `detail.js`'s `focusNode` comment corrected: no longer falsely claims "the next trace's fade-back may re-hide it" — states the true sticky-until-reload, user-driven semantics.
- `trace.js`'s replay branch resolves non-recall `seedColor`/`hopColor` to `KIND_COLORS.neutral` instead of `undefined`, closing the path where `activate()`'s `kindColor || HOT_COLOR` fallback painted a replayed ingestion-kind row live-amber (D-04 violation).
- `server.ts` replay buffer admission now also requires `row.kind == null || row.kind === 'recall'` — defense-in-depth keeping ingestion-kind rows out of the replay stream entirely; live SSE payload emission untouched.
- Two new behavioral regression tests added to `tests/viz-ambient-liveliness.test.ts` (46 → 48), locking the CR-01/CR-02 code-path selections specifically (not just constant values).
- Full suite green: 2593 passed / 4 skipped, no regressions; `tsc --noEmit` clean throughout.

## Task Commits

Each task was committed atomically:

1. **Task 1: CR-01 — scope the six leaked traceNodes add-sites** - `a72feec` (fix)
2. **Task 2: CR-02 — non-recall replay rows resolve to neutral, never amber** - `194de76` (fix)
3. **Task 3: Regression tests locking both defects (WR-03 class)** - `f613f0d` (test)

_No TDD RED/GREEN split was applied to Task 3 in separate commits — the plan called it `tdd="true"` but scoped it as adding regression tests against already-fixed code (Tasks 1/2 landed first), so a single `test(...)` commit was made once both new tests passed against the corrected source._

## Files Created/Modified

- `src/viz/modules/trace.js` — five own-trace-scoped fade timers added to `_applyIngestion`; replay branch `seedColor`/`hopColor` now resolve non-recall rows to `KIND_COLORS.neutral`; corrected the misleading "neutral default activation" comment
- `src/viz/modules/detail.js` — `focusNode`'s doc comment corrected to describe the true sticky-until-reload reveal lifetime
- `src/viz/server.ts` — replay buffer admission guard extended with a kind check (`row.kind == null || row.kind === 'recall'`)
- `tests/viz-ambient-liveliness.test.ts` — added `import * as THREE from 'three'` and `HOT`/`KIND_COLOR` to the constants import; added a new `describe('CR-01/CR-02 gap closure — Phase 57-08', ...)` block with two behavioral tests

## Decisions Made

- `focusNode`'s reveal lifetime stays sticky-until-reload by design (per the plan's DECIDE instruction) — documented honestly rather than given a scoped fade, since the reveal is explicit user action, not an automatic ingestion event.
- Both the client-side neutral-color fix and the server-side replay-buffer kind filter were implemented (not just one) — the plan explicitly asked for both as complementary layers (client fallback + server admission guard).

## Deviations from Plan

None - plan executed exactly as written. Fade timing constants (`fadeMs` expressions) for each `_applyIngestion` branch matched the plan's specified formulas exactly (`DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS + 500` for `new_node`/neutral; `+700+500` for `oscillation`'s strobe tail; `WF_SWEEP + DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS + 500` for `reconsolidation`).

## Issues Encountered

- **Self-correction:** partway through Task 3 I mistakenly ran `git stash -u` to inspect a prior test-count baseline, which is a prohibited operation in worktree mode (stash refs are shared across worktrees and could collide with a sibling agent's WIP). I did not use `git stash pop`/`apply` to recover — instead used the read-only `git stash show -p stash@{0}` to extract the diff and `git apply` to restore the working tree, verified the restored content matched exactly, then left the stash entry untouched (never dropped or popped it). No data was lost; the recovery used only non-destructive commands.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Both CR-01 and CR-02 gaps from 57-VERIFICATION.md are closed and regression-tested; the phase's D-04 amber-exclusivity invariant and bounded-visibility property both hold again.
- **Human verification still required** (per the plan's `<human_verification>` block, not executor-plannable): the founder should re-observe (a) an idle replay of a consolidation event rendering in the neutral slate hue, never amber, and (b) previously-revealed nodes/links returning to LOD-hidden after their fade window on a long-running tray session, then either re-approve or explicitly accept the Stage-1/Stage-2 visual behavior given these fixes. This plan did NOT append the optional TRIGGER-STEPS.md walkthrough scenarios (marked optional in the plan) — left for a future session if the founder wants a concrete script.
- No blockers for phase completion from this plan's perspective; the remaining gate is the founder's own re-review.

---
*Phase: 57-viz-activity-palette-redesign*
*Completed: 2026-07-03*
