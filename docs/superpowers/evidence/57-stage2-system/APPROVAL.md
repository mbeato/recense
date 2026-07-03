# Phase 57 Stage-2 System Approval Record (D-15/D-16)

**Date:** 2026-07-03
**Gate:** 57-07 Stage-2 founder checkpoint — full-system live tune sign-off (D-16)
**Verdict:** Approved AS-IS. No value changes requested.

## What was reviewed

The full activity system, tuned and reviewed live over the real hull per
`TRIGGER-STEPS.md` in this directory: the four per-layer motion profiles
(attack ms / halo-scale / pulse-thickness for live, replay, spontaneous,
twinkle), the floored dim factors (`REPLAY_DIM`, `SPONT_DIM`), the recalibrated
global bloom (`UnrealBloomPass` strength/radius/threshold), and the renderer
exposure/tone-mapping surface.

## Approved values (locked)

| Surface | File | Approved value(s) |
|---|---|---|
| Live attack ms / halo scale / pulse thickness | `src/viz/modules/constants.js` | `DECAY_ATTACK_MS=80`, `LIVE_HALO_SCALE=1.0`, `LIVE_PULSE_THICKNESS=1.0` |
| Replay attack ms / halo scale / pulse thickness / dim | `src/viz/modules/constants.js` | `REPLAY_ATTACK_MS=200`, `REPLAY_HALO_SCALE=0.75`, `REPLAY_PULSE_THICKNESS=0.7`, `REPLAY_DIM=0.7` |
| Spontaneous attack ms / halo scale / pulse thickness / dim | `src/viz/modules/constants.js` | `SPONT_ATTACK_MS=400`, `SPONT_HALO_SCALE=0.55`, `SPONT_PULSE_THICKNESS=0.5`, `SPONT_DIM=0.6` |
| Twinkle attack ms / halo scale / pulse thickness | `src/viz/modules/constants.js` | `TWINKLE_ATTACK_MS=500`, `TWINKLE_HALO_SCALE=0.3`, `TWINKLE_PULSE_THICKNESS=0.3` |
| Bloom strength / radius / threshold | `src/viz/modules/effects.js` | `new UnrealBloomPass(vec2, 0.6, 0.4, 0.72)` |
| Renderer exposure / tone-mapping | `src/viz/modules/graph.js` | THREE default (`NoToneMapping`, `toneMappingExposure=1`) — no explicit setter added |

No numeric values were changed from their pre-checkpoint (57-04/57-05)
provisional state — every value above is exactly what was staged for the
founder's review in `TRIGGER-STEPS.md`.

## How sign-off was obtained

**Honesty note:** Sign-off was given verbally by the founder in response to
the execute-phase checkpoint prompt (reply: "approved" — full system approved
as-is, no value changes requested). The founder did **not** capture or supply
screenshots of each layer firing over the hull during this session.

Per this plan's Task 1 output, `TRIGGER-STEPS.md` (this directory) documents
the exact real, honest actions that fire each layer live, the salience-
ordering read (live > replay > spontaneous > twinkle via motion/scale), the
WR-06 non-clobber check, and the bloom/exposure judgment — those steps were
available to the founder for the review, but no image evidence was produced
as part of this approval. This file is the durable record of the verbal
approval itself; it does not claim to include visual capture evidence. If
per-layer screenshots are captured in a future session, they should be added
to this directory alongside this record.

## Disposition

Approval accepted as sufficient to proceed with Task 2's ratchet (locking the
approved motion-profile/floor/bloom/exposure values and tightening the D-12
`FLOOR_BOUND` invariant to its already-tightest bound) per the founder's
explicit "approved as-is" response. No numeric values changed in
`constants.js`, `effects.js`, or `graph.js` — only their JSDoc/comment status
(from "PROVISIONAL — ratchets at Stage 2" to "LOCKED — founder-approved as-is
at Stage-2 (57-07, D-09)") and the `FLOOR_BOUND` test comment (PROVISIONAL to
ratcheted/locked) were updated. This mirrors the Stage-1 (57-03) precedent
recorded in `docs/superpowers/evidence/57-stage1-palette/APPROVAL.md`.
