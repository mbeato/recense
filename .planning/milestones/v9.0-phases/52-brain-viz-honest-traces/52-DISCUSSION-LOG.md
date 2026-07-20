# Phase 52: Brain Viz Honest Traces - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-29
**Phase:** 52-brain-viz-honest-traces
**Areas discussed:** Ingestion bridge scope, Cascade filter, Reconsolidation hero motion, Verification strategy, Decay-tail / intensity

---

## Gray-area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Ingestion bridge scope | Flood risk + spec-vs-code gap | ✓ |
| Reconsolidation hero motion | Choreography fidelity | ✓ |
| Verification strategy | How to verify a visual feature | ✓ |
| Decay-tail / intensity tuning | Lock constants now vs tune later | ✓ |

**User's choice:** All four selected.
**Notes:** Context framed up-front that the approved design spec is the contract and locks most decisions; only genuinely-open implementation gray areas were surfaced. A scout grounded the gray areas in real code before presenting.

---

## Ingestion bridge scope

| Option | Description | Selected |
|--------|-------------|----------|
| Both — reuse existing throttle | `remember` streams live; sleep pass reuses `lightConsolidatedNodes` cascade upgraded to emit `kind`. Flood-safe, surgical, closes spec-vs-code gap. | ✓ |
| Remember-only | Bridge only on synchronous `remember`; leave cascade untagged. Matches spec literally but hero magenta rarely shows + two divergent systems. | |
| Both — new throttled stream | Both paths bridge; fresh throttle on sleep-pass stream. Redundant with existing cascade. | |

**User's choice:** Both — reuse existing throttle.
**Notes:** Scout confirmed the sleep-pass consolidator emits the same `unrelated`/`contradict_reconcile`/`contradict_oscillation` events at tens-to-low-hundreds per pass (would overflow `RING_CAP=50`), and that `lightConsolidatedNodes` already replays them capped at `CASCADE_MAX=24` / `CASCADE_GAP_MS=300`. The spec never mentioned this existing cascade — surfaced as an inconsistency.

---

## Cascade filter (follow-up)

| Option | Description | Selected |
|--------|-------------|----------|
| Only the 3 narrative kinds | Light only new_node/reconsolidation/oscillation; skip confirm/extend/schema/dedup as clutter. | |
| All events, 3 kinds colored | Keep lighting all consolidated nodes; color the 3 hero kinds, neutral for the rest. | ✓ |

**User's choice:** All events, 3 kinds colored.
**Notes:** Founder keeps the post-pass cascade as ambient activity; the theater being killed is the recall-path BFS, not the sleep-pass cascade. Neutral color constrained to non-amber (palette lock).

---

## Reconsolidation hero motion

| Option | Description | Selected |
|--------|-------------|----------|
| Full choreography | Arriving green blip merges into magenta-flashed existing node, settles, no duplicate. | ✓ |
| Phased — flash first | Ship magenta flash only; defer arriving-blip merge. | |

**User's choice:** Full choreography.
**Notes:** The hero moment sells the core differentiator (prediction-error belief-update-in-place); worth the extra motion code for v1.

---

## Verification strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Structural test + visual checkpoint | Unit test payload→exactly-N-lit-edges parity + contradiction→magenta+zero-dupes; plus founder visual check. | ✓ |
| Visual checkpoint only | Founder eyeballs all criteria; no automated assertions. | |

**User's choice:** Structural test + visual checkpoint.
**Notes:** The "fires only real hops / no BFS" honesty guarantee needs a regression guard so it can't silently regress later.

---

## Decay-tail / intensity tuning

| Option | Description | Selected |
|--------|-------------|----------|
| Accept as starting constants | Ship spec's 140/600/2500ms as named tunable constants; tune at checkpoint. | ✓ |
| Decide values now | Pin different values before implementation. | |

**User's choice:** Accept as starting constants.
**Notes:** Numbers only matter against the rendered feel; tune visually at the founder checkpoint.

---

## Claude's Discretion

- Exact neutral hex for non-hero cascade events (non-amber, per palette lock).
- Easing curves for the decay envelope and the arriving-blip travel path.
- Whether the ingestion bridge is a new small adapter or extends an existing module (follow `SwitchableActivationTraceSink` gating either way).

## Deferred Ideas

None — discussion stayed within the spec's presentation-layer scope.
