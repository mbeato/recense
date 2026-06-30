# recense viz — Ambient Liveliness & Meaningful Replay Traces

**Date:** 2026-06-30
**Status:** approved (founder)
**Layer:** presentation only (`recense viz`). Engine, retrieval, and data model untouched.
**Predecessor:** `2026-06-29-brain-viz-honest-traces-design.md` (Phase 52 — honest traces) and Phase 53 (Halton layout). This spec sits on top of both.

## Problem

After the Phase 53 layout rework the brain reads as static when pinned while working:

1. **Idle dead air.** Activation traces fire only when the engine runs a real retrieval (written to the `activation_trace` table, polled by the viz server, streamed over SSE). Between real recalls — and between Claude Code prompts — nothing moves, so the viz is boring to keep open.
2. **Events too subtle.** When a real recall *does* fire, the node flash (`__act` → color/opacity lerp + a weak `×1.35` size-pulse) is too subtle to notice at the new node scale / overview zoom.
3. **The founder misses the old frequent trace firing** — but those were the *artificial* BFS traces Phase 52 deliberately removed. The fix must add liveliness **without** fabricating engine activity.

## Core idea — a three-layer activity hierarchy

Three ambient/event vocabularies, strictly ranked in intensity so honesty is preserved *by construction*: a live recall never looks like an echo; an echo never looks like a fresh fabricated event.

| Layer | Trigger | Reality | Visual weight |
|-------|---------|---------|---------------|
| 1. Live recall | Real engine/ambient retrieval (writes `activation_trace`) | Real, happening **now** | Brightest: size-pulse + brighten + pathway pulses + halos |
| 2. Replay echo | Idle scheduler re-emits a **recent real** `activation_trace` row | Real, but **past** (rehearsal) | Softer: dimmer/desaturated echo of the same real hops |
| 3. Twinkle | Continuous low-rate ambient | Decorative baseline life | Faintest: dim slow brightness shimmer, neutral palette |

Honesty guarantee: pathway pulses and halos fire **only** on real hops; nothing fabricates edges; intensity is strictly `live > replay > twinkle` so the three are always distinguishable.

## Layer 1 — Live recall amplification (`trace.js`)

Amplify the existing real-event render so it pops at node scale. Existing path (regular/realized nodes, `trace.js` ~399-402):

```
color  = base.lerp(actColor, a*0.8)
opacity= baseOp + a*0.4
scale  = baseR * (1 + a*0.35)   // too weak
```

Changes (all via named constants, tuned on the live viz):
- **Size-pulse:** `1 + a*0.35` → `1 + a*ACT_SCALE_GAIN` with `ACT_SCALE_GAIN ≈ 0.8–1.0` (≈ 1.8–2× peak with `__actGain`).
- **Brighten:** raise the opacity/brightness gain so the peak reads at distance.
- **Snappier attack:** optionally shorten `DECAY_ATTACK_MS` so the "pop" registers; keep the hold/fade envelope (D-06).
- **Haze (InstancedMesh, color-only — no per-frame `setMatrixAt`, perf invariant):** strengthen the color lerp (`a*0.8` → higher) and add a brief peak brightness overshoot so haze-node events are visible without touching the matrix buffer.

No change to which nodes/edges light — only how strongly. Phase 52 honesty path unchanged.

## Layer 2 — Replay echo (server `idle scheduler` + client echo render)

**Server (`src/viz/server.ts`, `/events` SSE):** add an idle-replay scheduler that stays inside the server's hard read-only / no-engine / no-LLM / no-fetch boundary — it only re-reads rows it already has.

- Track the timestamp of the last row pushed to clients.
- When no **new** `activation_trace` row has streamed for `REPLAY_IDLE_GAP_MS` (~4000–6000), begin replaying: every `REPLAY_CADENCE_MS` (~3000–5000), select a recent real row (from the last N rows; cycle or weighted-random toward recency) and broadcast it with an added flag `replay: true`.
- A live (new) row **preempts**: on any genuinely new row, reset the idle timer and stop replaying until idle again. Live always wins.
- The replay broadcast must **not** move the real `/events` cursor backward (T-10-11) — it is a side-channel re-emit, not a cursor rewind.

**Client (`src/viz/modules/trace.js`):** `applyTrace(row)` handles `row.replay === true` by rendering the **same real hops** at reduced intensity (`REPLAY_DIM` ≈ 0.4–0.6 of live), optionally desaturated, and **without** the strongest live cues (e.g. reduced/absent halo) so a replay is never mistaken for a live recall. Same hop set, same edges — just a softer echo.

## Layer 3 — Ambient twinkle (`trace.js`)

A continuous, bounded ambient loop on the existing master rAF tick (`ctx.registerTick`):

- Keep a small rotating subset live at once (`TWINKLE_COUNT` ≈ 0.5–1% of nodes, weighted toward haze so the whole brain shimmers, not just hubs).
- Each twinkle: a slow sine brightness breathe over `TWINKLE_PERIOD_MS` (~1500–2500), low amplitude `TWINKLE_AMP` (~0.12–0.18), **neutral/cool tint — never the event palette**, **no size change, no pulses, no halos**.
- Bounded cost: only the twinkle set is touched per frame (haze via `setColorAt`, never `setMatrixAt`).
- **Integration risk to verify:** the master rAF loop (`stats.js`) must keep ticking when idle for twinkle + replay to run; confirm it does not sleep when no real events are active, or add a low-rate keep-alive.

## Tunable constants (`src/viz/modules/constants.js`)

`ACT_SCALE_GAIN`, `ACT_BRIGHTEN_GAIN`, `REPLAY_IDLE_GAP_MS`, `REPLAY_CADENCE_MS`, `REPLAY_DIM`, `REPLAY_HISTORY_N`, `TWINKLE_COUNT`, `TWINKLE_PERIOD_MS`, `TWINKLE_AMP`. All dialed at the founder visual checkpoint (Phase 53 idiom). Goal feel: **noticeable and meaningful, never loud/distracting.**

## Out of scope / deferred

- **Fresh spontaneous retrievals** ("fresh later"): a sidecar with engine access running real LLM-free retrievals seeded from node embeddings to write *fresh* real traces. Deferred — revisit after the replay version is felt on the live viz. It would cross the viz server's read-only boundary and needs its own faithfulness review.
- Base node saturation/size tweaks (prior founder notes) — not in this scope unless trivially folded during checkpoint tuning.

## Constraints preserved

- Viz server stays **read-only**: no `new Database()`, no embed/LLM/provider, no outbound fetch (replay only re-reads existing rows).
- Online/render paths stay LLM-free.
- Phase 52 honest-traces invariant intact: pulses/halos only on real hops; replay reuses real hops; twinkle fabricates no edges.
- Phase 53 layout (Halton seed, locked anchors) untouched.

## Success criteria

- **SC1 — alive at idle:** pinned with no user recalls, the brain shows continuous gentle life (twinkle) punctuated by periodic replay echoes of real recent recalls.
- **SC2 — events pop:** a real recall is clearly noticeable at overview zoom (size-pulse + brighten), distinctly stronger than a replay echo.
- **SC3 — honest hierarchy:** live > replay > twinkle is always visually legible; replays read as rehearsal, not live; no fabricated edges.
- **SC4 — not distracting:** the ambient layers read as meaningful, not loud/noisy (founder felt-quality call).
- **SC5 — bounded + in-boundary:** no frame-rate regression at ~15k; viz server remains read-only/LLM-free; machine-guarded where checkable (constants exported, replay flag plumbed, twinkle/replay distinct from live).
- **Founder visual checkpoint** confirms SC1–SC4 on the live viz (Phase 52/53 idiom).

## Files touched

- `src/viz/server.ts` — idle-replay scheduler on the `/events` SSE (read-only).
- `src/viz/modules/trace.js` — live-flash amplification; replay-echo render (`row.replay`); ambient twinkle on the master tick.
- `src/viz/modules/constants.js` — the tunables above.
- `tests/` — guards: constants exported; replay flag plumbed live→client; twinkle/replay never escalate above live; honesty (no fabricated edges) preserved.
