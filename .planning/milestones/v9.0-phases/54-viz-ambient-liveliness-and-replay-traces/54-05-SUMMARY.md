# 54-05 SUMMARY — Founder visual checkpoint + constant tuning

**Plan:** 54-05 (non-autonomous, founder checkpoint)
**Status:** Complete — founder-approved
**Commit:** `7d88685` feat(54-05): bake founder-tuned ambient-liveliness constants

## What happened

Ran the founder visual checkpoint on the live `recense viz` (fresh build served on
127.0.0.1:7820; the pre-existing tray build on 7810 was the old Phase-53 build and was
the source of an initial "nothing looks different" — the founder was viewing the wrong
window until redirected to 7820).

### Tuning (values-only; constants.js)

| Constant | Start (midpoint) | Tuned | Why |
|----------|------------------|-------|-----|
| `ACT_BRIGHTEN_GAIN` | 0.55 | **0.95** | live flash wasn't distinctly stronger than replay |
| `ACT_SCALE_GAIN` | 0.9 | **1.05** | more size pop on live (kept modest re: Pitfall-4 schema overlap) |
| `DECAY_ATTACK_MS` | 140 | **80** | attack felt "soft/unpolished" — snappier ramp (D-06 hold/fade envelope untouched) |
| `REPLAY_DIM` | 0.5 | **0.4** | widen live > replay gap; honesty invariant `< 1` preserved (Plan-04 guard green) |
| `TWINKLE_AMP` | 0.15 | **0.18** | twinkle imperceptible at 0.15 (spec ceiling) |
| `TWINKLE_COUNT` | 80 | **140** | more simultaneous shimmer for a present-but-gentle baseline |

`trace.js`/`server.ts` untouched (logic final). Server-mirrored replay constants
(`REPLAY_IDLE_GAP_MS`, `REPLAY_CADENCE_MS`, `REPLAY_HISTORY_N`) were not changed, so no
server rebuild/restart was required.

## Success criteria

- **SC1 (alive at idle):** twinkle visible + replay echoes confirmed once the replay ring
  was warm. **Founder-confirmed.** Note: the ring fills only from real recall activity while
  the viz is open (WR-01 cold-start); a freshly launched idle brain shows no replays until
  activity accumulates — expected, not a defect.
- **SC2 (events pop):** live flash now bright/snappy and distinctly the strongest layer.
  **Founder-confirmed** ("there and distinct").
- **SC3 (honest hierarchy):** live > replay > twinkle legible; `REPLAY_DIM < 1` machine-guarded.
  **Confirmed** (structure machine-verified in Plan 04).
- **SC4 (not distracting):** ambient reads as gentle baseline. **Founder-confirmed.**

## Verification

- `npm run build` (tsc) — exit 0
- `npx vitest run tests/viz-ambient-liveliness.test.ts tests/trace-honest-recall.test.ts tests/viz-layout-guards.test.ts` — 82/82 green
- `REPLAY_DIM = 0.4` (< 1 honesty invariant holds)

## Deviation / follow-up (scoped to a separate plan)

During the checkpoint the founder noted missing **pathway-hop pulses** ("trace firing/hops").
Root-caused (systematic-debugging): the viz renders `activation_trace.hops` faithfully, but the
dominant live trace source — per-prompt **ambient recall** (`retrieveRanked`) — emits `hops: []`
**by design** (flat top-k, "no spread loop ran"; engine.ts:499/518). Only curated recalls that
find a bestMatch+neighborhood emit pathways (`recall/index.ts:525`), and none fired in the window.

Evidence: the recent seeds each have **40–72 real out-edges** in the 17,687-edge graph — so honest
1-hop pathways exist for nearly every recall; the ambient path simply declines to surface them.
Surfacing each seed's real out-edges (with `score: null`, rank-only — exactly as the curated path
already does, WR-02-safe) would make every recall show honest pathways.

**Decision (founder):** this is a Phase-52 retrieval-engine change, not a Phase-54 dial → captured
as a **separate phase/plan** ("ambient-recall honest 1-hop emission"). Phase 54 approved as-is.
