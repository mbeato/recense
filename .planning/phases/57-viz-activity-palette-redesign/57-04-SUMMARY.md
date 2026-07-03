---
phase: 57-viz-activity-palette-redesign
plan: 04
subsystem: viz-client
tags: [viz, motion-profile, salience, D-05, D-06, D-08, D-12, invariants-test]
dependency_graph:
  requires:
    - luminance-equalized KIND_COLOR palette + D-02 luminance-band invariant (57-02)
    - founder-approved locked palette + ratcheted Y_MIN/Y_MAX band (57-03)
  provides:
    - four-per-layer motion-profile constant blocks in constants.js (live/replay/spontaneous/twinkle)
    - D-06 monotonic SC3 ordering invariants (attack ms, halo/scale)
    - D-05 floored dim factors (REPLAY_DIM/SPONT_DIM)
    - consolidated WR-02 + REPLAY_DIM<1 locks in the D-12 invariants file
  affects: [57-06]
tech_stack:
  added: []
  patterns:
    - "named-tunable + inline-rationale JSDoc convention extended to attack-ms/halo-scale/pulse-thickness channels (no object literals)"
    - "source-parse regex invariant lock (export const NAME = value) reused for the new motion-profile channels"
key_files:
  created: []
  modified:
    - src/viz/modules/constants.js
    - tests/viz-activity-palette-invariants.test.ts
    - tests/viz-ambient-liveliness.test.ts
decisions:
  - "Re-homed the standalone 'Activation decay envelope' section (DECAY_ATTACK_MS/HOLD/FADE/FLOOR) directly into the new Layer 1 motion-profile block rather than leaving a duplicate/aliased copy — imports are by name, so physical relocation within the same file is transparent to every consumer (trace.js, viz-ambient-liveliness.test.ts)."
  - "Derived TWINKLE_ATTACK_MS=500 as exactly one quarter of the existing TWINKLE_PERIOD_MS=2000 — a sine breathe's natural rise-to-peak — rather than an arbitrary number, giving the twinkle attack value a traceable rationale."
  - "Added a twinkle pulse-thickness constant (TWINKLE_PULSE_THICKNESS) even though twinkle has no traveling edge pulse today, to keep all four layers structurally symmetric for 57-06's consumption; documented inline as reserved for a future twinkle micro-pulse."
  - "Kept the SPONT_DIM/REPLAY_DIM ordering strictly '<' (not '<=') to preserve the exact historical WR-02/honesty-invariant wording, even though the new floored values (0.6/0.7) leave headroom either way."
metrics:
  duration_min: 20
  completed: 2026-07-03
  tasks: 2
  files_touched: 3
---

# Phase 57 Plan 04: Per-Layer Motion Profiles + SC3 Ordering Locks Summary

Restructured the Phase-54/56 layer-constants region into four named motion-profile blocks (live/replay/spontaneous/twinkle) carrying the PRIMARY salience-ordering channels (attack sharpness, halo/scale), re-homed live's founder-tuned decay envelope pixel-equivalent as the top profile, floored every subordinate dim factor to a perceptual minimum, and consolidated the SC3 ordering + floor invariants (including the never-written WR-02 lock and the migrated REPLAY_DIM<1 lock) into the dedicated D-12 invariants file.

## What Was Built

**Task 1 — Four per-layer motion profiles in `constants.js` (commit `c23244e`):**

Removed the standalone "Activation decay envelope" section (previously at the top of the file, lines 108-129) and re-homed its four exports (`DECAY_ATTACK_MS=80`, `DECAY_HOLD_MS=600`, `DECAY_FADE_MS=2500`, `DECAY_FLOOR=0.04`) directly into a new unified "Phase 57 D-06/D-08 — four per-layer motion profiles" section, alongside the existing `ACT_SCALE_GAIN`/`ACT_BRIGHTEN_GAIN`/`ACT_HAZE_LERP` — all seven values unchanged (D-08 pixel-equivalence; imports are by name, so relocation within the file is transparent to every existing consumer). Added two new live-layer channels: `LIVE_HALO_SCALE=1.0` and `LIVE_PULSE_THICKNESS=1.0`.

For replay, spontaneous, and twinkle, added named attack-ms / halo-scale / pulse-thickness channels following the existing individually-JSDoc'd `export const` convention (never object literals):

| Layer | Attack ms | Halo/scale | Pulse thickness |
|-------|-----------|------------|------------------|
| Live | `DECAY_ATTACK_MS` = 80 | `LIVE_HALO_SCALE` = 1.0 | `LIVE_PULSE_THICKNESS` = 1.0 |
| Replay | `REPLAY_ATTACK_MS` = 200 | `REPLAY_HALO_SCALE` = 0.75 | `REPLAY_PULSE_THICKNESS` = 0.7 |
| Spontaneous | `SPONT_ATTACK_MS` = 400 | `SPONT_HALO_SCALE` = 0.55 | `SPONT_PULSE_THICKNESS` = 0.5 |
| Twinkle | `TWINKLE_ATTACK_MS` = 500 | `TWINKLE_HALO_SCALE` = 0.3 | `TWINKLE_PULSE_THICKNESS` = 0.3 |

Attack ms holds strictly `80 < 200 < 400 < 500`; halo/scale holds strictly `1.0 > 0.75 > 0.55 > 0.3`. Cadence (`REPLAY_CADENCE_MS`, `SPONT_CADENCE_MS`, `TWINKLE_PERIOD_MS`) and density (`TWINKLE_COUNT` — the only layer where population density is a meaningful channel, since the other three are single-event pulses, not a population) were reused unchanged, per D-06's "free to vary for feel" carve-out.

Floored the dim factors: `REPLAY_DIM` raised `0.4 → 0.7` and `SPONT_DIM` raised `0.3 → 0.6`, both now `>= 0.6` with `SPONT_DIM (0.6) < REPLAY_DIM (0.7) < 1` intact. Every new/changed constant carries a JSDoc stating its layer character, the PROVISIONAL status, and the Stage-2 (D-09) ratchet note.

**Task 2 — Lock SC3 ordering + dim floors; migrate WR-02/REPLAY_DIM locks (commit `fb9e2b7`, `tdd="true"`):**

Added a `describe('D-06 motion-profile SC3 ordering + D-05 dim floors', ...)` block to `tests/viz-activity-palette-invariants.test.ts` with a named `FLOOR_BOUND = 0.6` provisional constant (Stage-2-ratchet comment) and four sub-groups, all source-parsing the relevant constants out of `constants.js`:
- Monotonic attack: `DECAY_ATTACK_MS < REPLAY_ATTACK_MS < SPONT_ATTACK_MS < TWINKLE_ATTACK_MS`
- Monotonic halo: `LIVE_HALO_SCALE > REPLAY_HALO_SCALE > SPONT_HALO_SCALE > TWINKLE_HALO_SCALE`
- Dim floors: `REPLAY_DIM >= FLOOR_BOUND`, `SPONT_DIM >= FLOOR_BOUND`
- WR-02 + SC3: `SPONT_DIM < REPLAY_DIM` (56-REVIEW.md WR-02, previously never locked) and `REPLAY_DIM < 1` (migrated from `viz-ambient-liveliness.test.ts:482-489`)

Removed the `REPLAY_DIM < 1` source-parse `it()` block from `tests/viz-ambient-liveliness.test.ts`, leaving a one-line comment pointing to its new home. The `REPLAY_DIM` import at line 102 and the file's other behavioral replay-peak tests (which still consume the real `REPLAY_DIM` value) were left untouched, per the plan's explicit scope note.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria met on the first pass (both tasks' provisional values were authored to already satisfy the ordering/floor constraints, so Task 2's tests passed immediately against Task 1's Task-1-authored constants).

### TDD Note (Task 2, `tdd="true"`)

Task 2 is tagged `tdd="true"` but, like 57-01's Task 3, tests behavior that Task 1 (earlier in the same plan) already implemented — there was no separate implementation step after the test was written; both the constants and their invariant locks were authored to satisfy the same ordering/floor requirements from the plan's `<interfaces>` block. Writing the tests therefore passed on first run (GREEN immediately) rather than a genuine RED→GREEN transition. This is expected given the task's actual role (a regression lock seeded onto already-correct code from Task 1, not driving new implementation), consistent with how 57-01 documented the same pattern.

## Verification

- `node -e "..."` (Task 1 acceptance script) — `profiles authored, live preserved, floors ok`
- `npx vitest run tests/viz-activity-palette-invariants.test.ts` — 31/31 passing (17 D-10 + 8 D-02 + 6 new D-06/D-05)
- `npx vitest run tests/viz-ambient-liveliness.test.ts` — 42/42 passing (no regression; `grep -c "REPLAY_DIM" tests/viz-ambient-liveliness.test.ts` = 21, confirming the import + behavioral tests remain)
- `npx tsc --noEmit` — clean (exit 0)
- `npm test` (full suite) — 171 files passed / 1 skipped, 2587 tests passed / 4 skipped (up from 2582 at 57-03 close; +5 net new tests after removing 1 migrated test and adding 6; no failures)
- Live re-home confirmed pixel-equivalent: `ACT_SCALE_GAIN=1.05`, `ACT_BRIGHTEN_GAIN=0.95`, `ACT_HAZE_LERP=0.95`, `DECAY_ATTACK_MS=80`, `DECAY_HOLD_MS=600`, `DECAY_FADE_MS=2500`, `DECAY_FLOOR=0.04` all unchanged

## Known Stubs

None — no stubs introduced. All new motion-profile constants are real, consumed-by-name exports; trace.js consumption of the new attack/halo/pulse-thickness channels is explicitly out of scope for this plan (57-06 wires it).

## Threat Flags

None — this plan only adds/retunes numeric constants in `constants.js` and test assertions in two `tests/viz-*.test.ts` files (client-side render-config only). No new network endpoints, auth paths, file-access patterns, or schema changes. Matches the plan's own threat register (T-57-05 SC3-ordering tampering: mitigated via the new D-12 monotonic locks; T-57-SC: n/a, no package installs).

## Self-Check: PASSED

- `src/viz/modules/constants.js` — FOUND
- `tests/viz-activity-palette-invariants.test.ts` — FOUND
- `tests/viz-ambient-liveliness.test.ts` — FOUND
- Commit `c23244e` — FOUND in git log
- Commit `fb9e2b7` — FOUND in git log

---
*Phase: 57-viz-activity-palette-redesign*
*Completed: 2026-07-03*
