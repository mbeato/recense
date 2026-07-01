# Phase 56: Spontaneous 1-hop idle activation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-01
**Phase:** 56-spontaneous-1-hop-idle-activation
**Areas discussed:** Idle gating vs replay, Seed selection, Color & density, Builder reuse + wire tag

---

## Idle gating vs replay (SPONT-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Fallback when replay can't | Fires only when the replay buffer is empty; replay owns the idle gap whenever it has real rows. Simplest, matches roadmap headline. | ✓ |
| Deeper-idle layer | Replay at 5s idle; spontaneous on its own longer gap (~12-15s) OR empty buffer. Two idle timers. | |
| Always interleaved | Spontaneous on its own cadence alongside replay every idle tick, just dimmer. Weakest layer separation. | |

**User's choice:** Fallback when replay can't
**Notes:** Replay (real past) preempts by construction → SC3 ordering satisfied. Spontaneous is the empty-buffer / fresh-brain default-mode fill.

---

## Seed selection (SPONT-01)

**Sub-decision A — how to pick the seed:**

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-filtered pool | Sample uniformly from live nodes with ≥1 semantic out-edge. Guarantees a real pathway every tick, no salience bias. | ✓ |
| Uniform + retry | Random live node, re-roll up to ~8× if it has no semantic out-edges. Occasional silent no-op ticks. | |
| Strength/degree-weighted | Bias toward strong/well-connected nodes. More lifelike but a bias to defend; rich nodes recur. | |

**Sub-decision B — seeds per tick:**

| Option | Description | Selected |
|--------|-------------|----------|
| Single seed | One node + top-N hops (roadmap-literal singular). Cleanest, but sparse vs replay. | |
| 2-3 seeds | A handful per tick for density parity with replay's multi-seed rows. Tune as named constant. | ✓ |

**User's choice:** Pre-filtered pool; 2-3 seeds per tick
**Notes:** Pool guarantees no dud ticks (uniform-over-all-nodes would frequently hit doc/structural nodes the honest filter drops). 2-3 seeds chosen over single for visual parity with replay; count is a named tunable constant.

---

## Color & density (SPONT-02 / SPONT-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Dim indigo / violet | Default-mode-network / dreaming hue, distinct from amber and cyan, fits aubergine palette. | ✓ |
| Dim muted green | Separate from amber/cyan, organic; risks competing with neutral twinkle at low intensity. | |
| Decide at checkpoint | Lock constraint only, render candidates live. | |

**User's choice:** Dim indigo / violet
**Notes:** Starting direction only; exact value tuned at the founder visual checkpoint. Cadence / dim / density are named tunable constants with the hard invariant `SPONT_DIM < REPLAY_DIM (0.4)`.

---

## Builder reuse + wire tag (SPONT-01 / SPONT-05 / SPONT-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Shared single source of truth | Extract the Phase-55 honest filter into one pure helper both the engine and read-only viz server import. Can't drift. | ✓ |
| Reimplement in server | Parallel copy of the filter in server.ts. Faster but two honesty-critical copies that drift. | |

**User's choice:** Shared single source of truth
**Notes:** Wire tag `kind:'spontaneous'` on the SSE event (locked, roadmap-specified). Tray suppresses pulse on `kind==='spontaneous'` — same rule as replay (locked). Replay-ring exclusion is automatic: spontaneous is SSE-only and writes no `activation_trace` row, so it never enters the ring (locked). Read-only server gets graph access via a read-only SemanticStore or edge-reader closure — planner's discretion.

---

## Claude's Discretion

- One combined interval (`replayBuffer.length === 0` check) vs a separate spontaneous `setInterval`.
- Eligible-seed pool construction/refresh strategy (read-only, cheap).
- Read-only `SemanticStore` vs edge-reader closure for the shared helper's graph access.
- Exact named-constant homes (mirror `constants.js` layer block + server-authoritative copies).
- Deterministic RNG/pool for reproducible guard tests.

## Deferred Ideas

- Strength/degree-weighted seed selection (revisit only if uniform reads flat).
- Spontaneous as an always-on / deeper-idle enrichment layer alongside replay.
- Both-direction (in+out) 1-hop for spontaneous (inherits Phase-55 out-edges-only decision).
