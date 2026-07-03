# Phase 57 Stage-2 Checkpoint — Trigger Steps + Tunable Locations

Written for the founder's closing full-system live tune (57-07 Task 1: build +
stage). This session's `npm run build` confirmed `dist/src/viz/modules/` carries
the current `constants.js` (57-04 motion profiles + 57-04 dim floors), `effects.js`
(57-05 bloom recalibration), `graph.js` (57-05 exposure/tone-mapping doc site), and
`trace.js` (57-06 per-layer motion-profile consumption + own-trace-scoped fades,
WR-06 fix — confirmed by the automated verify: `dist current: fades scoped, system
staged`).

Launch: `recense viz` (or the Recense.app tray) against the real
`~/.config/recense/recense.db`, same as the Stage-1 (57-03) checkpoint. The
browser/Electron view fetches `modules/constants.js`/`effects.js`/`trace.js`
fresh over HTTP on every page load — a normal window reload/reopen (no server
restart needed) picks up this build.

## Per-layer trigger (reused from Stage-1, docs/superpowers/evidence/57-stage1-palette/TRIGGER-STEPS.md)

| Layer / kind | How to fire it |
|---|---|
| Live recall (`recall_seed` + `recall_hop`) | `recense recall "<any real query>"` in a terminal |
| New node (`new_node`) | `recense remember "<a fact that is genuinely new>"` |
| Reconsolidation hero (`reconsolidation`) | `recense remember "<a fact that corrects/contradicts something already stored>"` |
| Oscillation (`oscillation`) | Immediately `recense remember` the ORIGINAL value again right after the reconsolidation above |
| Neutral cascade (`neutral`) | Run `recense sleep-pass` (or wait for the hourly pass) |
| Spontaneous (`spontaneous`) | Let the viz sit idle with an empty replay ring buffer (fresh window / no recent recalls) — idle 1-hop wandering fires |
| Replay echo (`replay`) | Do a few `recense recall` queries, then stop for 5+ seconds — the idle-replay layer echoes recent real rows |
| Twinkle (ambient, non-identity) | Always on in the background at idle — no trigger needed |

## What to judge this session (Stage-2, full-system — not just hue)

Per the plan's `<how-to-verify>`:

1. Trigger each layer and watch the salience ordering read through MOTION/SCALE
   (not brightness): live = sharp attack + big halo (the event); replay = soft
   echo; spontaneous = slow calm drift; twinkle = micro-breathe. Confirm
   live > replay > spontaneous > twinkle reads clearly WITHOUT any layer
   vanishing.
2. Force an idle-to-live transition while spontaneous is firing (start a
   `recense recall` mid-spontaneous-drift); confirm the live pathway is NOT
   clobbered mid-animation (WR-06 fix — own-trace-scoped fades from 57-06).
3. Judge the global bloom/exposure: activation flares glow; resting tissue
   (`TYPE_COLOR` entity/fact/schema) does not bloom or wash out.
4. Capture one screenshot per layer firing over the hull for the durable D-15
   evidence record (store alongside this file in
   `docs/superpowers/evidence/57-stage2-system/`).

## Where each tunable lives (for Task 2's ratchet)

| Tunable | File | Current (provisional) value(s) |
|---|---|---|
| Live attack ms / halo scale / pulse thickness | `src/viz/modules/constants.js` | `DECAY_ATTACK_MS=80`, `LIVE_HALO_SCALE=1.0`, `LIVE_PULSE_THICKNESS=1.0` |
| Replay attack ms / halo scale / pulse thickness / dim | `src/viz/modules/constants.js` | `REPLAY_ATTACK_MS=200`, `REPLAY_HALO_SCALE=0.75`, `REPLAY_PULSE_THICKNESS=0.7`, `REPLAY_DIM=0.7` |
| Spontaneous attack ms / halo scale / pulse thickness / dim | `src/viz/modules/constants.js` | `SPONT_ATTACK_MS=400`, `SPONT_HALO_SCALE=0.55`, `SPONT_PULSE_THICKNESS=0.5`, `SPONT_DIM=0.6` |
| Twinkle attack ms / halo scale / pulse thickness | `src/viz/modules/constants.js` | `TWINKLE_ATTACK_MS=500`, `TWINKLE_HALO_SCALE=0.3`, `TWINKLE_PULSE_THICKNESS=0.3` |
| Dim floor invariant bound | `tests/viz-activity-palette-invariants.test.ts` | `FLOOR_BOUND = 0.6` (D-06/D-05 describe block) |
| Bloom strength / radius / threshold | `src/viz/modules/effects.js` | `new UnrealBloomPass(vec2, 0.6 /*strength*/, 0.4 /*radius*/, 0.72 /*threshold*/)` |
| Renderer exposure / tone-mapping | `src/viz/modules/graph.js` | Left at THREE default (`NoToneMapping`, `toneMappingExposure=1`); knob documented at the `Graph.scene().background` comment site — `Graph.renderer().toneMapping` / `.toneMappingExposure` |

No values were changed in this task — the founder dials all of the above live at
the checkpoint; Task 2 applies the approved numbers and ratchets the D-12
invariants (`FLOOR_BOUND` + monotonic attack/halo ordering) to match.
