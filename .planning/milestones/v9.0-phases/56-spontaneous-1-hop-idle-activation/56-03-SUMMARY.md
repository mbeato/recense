---
phase: 56-spontaneous-1-hop-idle-activation
plan: 03
subsystem: ui
tags: [three.js, viz, electron, tray, sse, render]

# Dependency graph
requires:
  - phase: 56-01
    provides: shared buildHonestOneHopTrace helper (server-side, not imported by this plan) establishing the kind:'spontaneous' wire contract
provides:
  - SPONT named constants (SPONT_DIM, SPONT_CADENCE_MS, SPONT_HOP_TOPN, KIND_COLOR.spontaneous) in src/viz/modules/constants.js
  - kind:'spontaneous' render branch in src/viz/modules/trace.js — dim indigo seed→hop 1-hop pathway, intercepted before the ingestion dispatch
  - tray icon pulse suppression extended to kind==='spontaneous' in apps/tray/src/tray-icon.ts
affects: [56-spontaneous-1-hop-idle-activation follow-on plans, viz palette/render conventions]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "New activity-kind render branch follows the replay-branch template (resolve seeds via normalizeSeed, hops via traceEdgesFromHops, activate at kind-specific DIM factor, pre-dimmed hop-pulse color via bit-shift construction) — same shape repeats per Phase-54/55/56 layer"
    - "Client-side activity-layer honesty invariant enforced as a numeric ordering (SPONT_DIM < REPLAY_DIM < 1.0), checkable at module load"

key-files:
  created: []
  modified:
    - src/viz/modules/constants.js
    - src/viz/modules/trace.js
    - apps/tray/src/tray-icon.ts

key-decisions:
  - "KIND_COLOR.spontaneous = 0x8a7fff (dim indigo/violet) — starting direction only, tuned at the founder visual checkpoint like every other layer color"
  - "SPONT_DIM = 0.3, strictly less than REPLAY_DIM (0.4) — enforced as a hard invariant checked at module load, not just documented"
  - "score:null on every spontaneous hop (per wire contract) falls back to the existing mid-intensity path shared with the recall/replay branches — no new fallback logic needed"

patterns-established:
  - "Activity-layer render branches are inserted into applyTrace in strict precedence order (replay, then spontaneous, then ingestion dispatch) — each branch returns immediately so later branches/dispatch never see rows already handled"

requirements-completed: [SPONT-02, SPONT-05]

# Metrics
duration: 15min
completed: 2026-07-01
---

# Phase 56 Plan 03: Spontaneous Client Render + Tray Suppression Summary

**Client renders `kind:'spontaneous'` SSE traces as a dim-indigo seed→hop 1-hop pathway (SPONT_DIM=0.3, strictly below REPLAY_DIM=0.4) and the tray icon no longer pulses on them, keeping idle default-mode wandering visually honest and structurally subordinate to replay.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-01T20:53:20Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Added `SPONT_DIM`, `SPONT_CADENCE_MS`, `SPONT_HOP_TOPN` and `KIND_COLOR.spontaneous` (dim indigo `0x8a7fff`) to `constants.js`, with `SPONT_DIM < REPLAY_DIM` enforced as a checkable invariant
- Added a `kind === 'spontaneous'` render branch to `trace.js` that lights the honest seed→hop pathway at `intensity * SPONT_DIM` in the new indigo hue, intercepted before the `_applyIngestion` dispatch, with a pre-dimmed `SPONT_HOP_COLOR` pulse drawn only when `srcNode` is present
- Extended the tray-icon trace listener to suppress `pulse()` on `kind === 'spontaneous'` (same "idle, not live" treatment as `replay === true`), while preserving fail-toward-liveness on parse failure

## Task Commits

Each task was committed atomically:

1. **Task 1: SPONT named constants + default-mode hue (SPONT_DIM < REPLAY_DIM)** - `ea88100` (feat)
2. **Task 2: trace.js spontaneous render branch (dim indigo seed→hop pathway)** - `86f4d84` (feat)
3. **Task 3: Tray-icon pulse suppression on kind==='spontaneous'** - `cacbff8` (feat)

## Files Created/Modified
- `src/viz/modules/constants.js` - Added `KIND_COLOR.spontaneous`, `SPONT_DIM`, `SPONT_CADENCE_MS`, `SPONT_HOP_TOPN`
- `src/viz/modules/trace.js` - Added `KIND_COLORS.spontaneous`, pre-dimmed `SPONT_HOP_COLOR`, and the `kind === 'spontaneous'` render branch in `applyTrace`
- `apps/tray/src/tray-icon.ts` - Extended the trace-event suppress condition to `isReplay || isSpontaneous`

## Decisions Made
- Dim indigo/violet (`0x8a7fff`) chosen as a starting direction for the default-mode hue, per plan discretion — distinct from amber (`0xffb866`) and cyan (`0x66d9ff`); to be tuned at a founder visual checkpoint like every prior layer color
- Mirrored the existing REPLAY_HOP_COLOR bit-shift dim construction exactly for SPONT_HOP_COLOR (no `multiplyScalar`) so it stays compatible with the minimal test colour stub used by existing render tests

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Client-side spontaneous render + tray suppression are complete and independently verified (no dependency on the server-side plan's files, per this plan's explicit scope)
- Full test suite green (2550 passed / 3 skipped) — no regression in existing replay/recall render or tray tests
- `tsc --noEmit` clean on `apps/tray`
- Flagged (not fixed, out of scope): stray untracked `apps/tray/tray-icon.js` build artifact at the tray app root — recommend founder delete during cleanup (it is not the source and editing it is a no-op)

## Threat Flags

No new threat surface introduced — client-side render/tray changes accept no new privileged input and perform no writes, per the plan's own threat_model disposition (T-56-06/T-56-07 both `mitigate`, both addressed: distinct hue + SPONT_DIM<REPLAY_DIM invariant for spoofing; existing fail-safe guards reused for malformed-row DoS).

---
*Phase: 56-spontaneous-1-hop-idle-activation*
*Completed: 2026-07-01*

## Self-Check: PASSED

All created/modified files found on disk; all 3 task commit hashes (ea88100, 86f4d84, cacbff8) found in git log.
