# Phase 57 Stage-1 Checkpoint — Trigger Steps for Each Identity Kind

Written for the founder hue sign-off (57-03 Task: Stage-1 founder checkpoint). No
existing trace-injection/demo path was found in the codebase, so these are the exact
real, honest actions that fire each `KIND_COLOR` identity over the live install —
every kind below is driven by a genuine engine event; nothing is fabricated for the
demo (D-15 durable evidence must reflect real activity).

The founder's `recense viz` (Recense.app tray) is already running against the real
`~/.config/recense/recense.db`. `dist/src/viz/modules/constants.js` on disk already
contains the Stage-1 palette this checkpoint reviews (built 2026-07-03, confirmed by
Task 1's automated verify: `dist palette current`). The browser/Electron view fetches
`modules/constants.js` fresh over HTTP on every page load — a normal window
reload/reopen (no server restart needed) is enough to pick up the current palette.

## Setup

1. Click the Recense menu-bar icon to open the popover, or reopen the full window.
   If it was already open before today's build, reload the page once (Cmd+R / the
   window's reload) so it re-fetches the current `constants.js`.

## Per-kind trigger

| Kind | Hue (identity) | How to fire it |
|------|------------------------------------|-----------------|
| `recall_seed` | amber-gold (`HOT`, unchanged) | `recense recall "<any real query about your own knowledge>"` in a terminal |
| `recall_hop` | cyan (unchanged) | Fires automatically alongside `recall_seed` — the 1-hop associations of the same recall |
| `new_node` | sage-green | `recense remember "<a fact that is genuinely new — not already known>"` |
| `reconsolidation` | rose-mauve hero | `recense remember "<a fact that corrects/contradicts something already stored>"` (belief update in place) |
| `oscillation` | coral-red strobe | Immediately `recense remember` the ORIGINAL value again right after the reconsolidation above (flip-back triggers the oscillation guard) |
| `neutral` | slate | Run `recense sleep-pass` (or wait for the hourly scheduled pass) — ordinary confirm/extend/schema/merge consolidation events replay as the neutral fallback |
| `spontaneous` | pastel lavender | Let the viz sit idle when the replay ring buffer is empty (a fresh window, or no recent real recalls) — idle 1-hop wandering fires instead of replay |
| `replay` | pale ice-cyan | Do a few `recense recall` queries, then stop for 5+ seconds — the idle-replay layer echoes the recent real rows from the ring buffer |
| twinkle (ambient, non-identity) | neutral steel-blue | Always on in the background at idle — no trigger needed, just watch |

## What to look for (Stage-1 sign-off criteria, from the plan)

- Every hue reads as its own identity over the dark additive hull — none vanish.
- `oscillation` no longer looks amber (D-03b) — it should read as coral-red, not
  warm-orange.
- `replay` reads as a cooler, paler sibling of live `recall_hop` cyan — distinguishable
  from live, not identical to it.
- Capture one screenshot per kind firing over the hull (Task 2 stores these under this
  same `docs/superpowers/evidence/57-stage1-palette/` directory as the durable D-15
  approval record).
