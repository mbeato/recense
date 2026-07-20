# Phase 57: viz activity-palette redesign - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-02
**Phase:** 57-viz-activity-palette-redesign
**Areas discussed:** Palette scope & derivation, Salience channel mapping, Machine-checkable invariants, Bloom/tone-mapping calibration

---

## Todo cross-reference (pre-discussion)

| Option | Description | Selected |
|--------|-------------|----------|
| None — all out of scope | Mark all 4 keyword matches reviewed-but-not-folded | ✓ |
| viz-search-and-hull-quality | Hull jaggedness + in-app search (structural) | |
| corpus-brain-3d-transition | Camera fly-through (structural) | |
| content-hardening / prompt-prefix todos | Engine-side keyword noise | |

**User's choice:** None — all out of scope
**Notes:** All 4 listed under Reviewed Todos in CONTEXT.md deferred section.

---

## Palette scope & derivation

| Option | Description | Selected |
|--------|-------------|----------|
| All activity kinds | All 7 KIND_COLOR entries + replay identity hue + twinkle tint | ✓ |
| Only the rescued layers | Replay + spontaneous + twinkle only | |
| Roadmap's four only | Live, replay, spontaneous, ingestion only | |

**User's choice:** All activity kinds — one coherent system.

| Option | Description | Selected |
|--------|-------------|----------|
| Colorimetric band + hand-tuned hues | Hand-picked hues, machine-tested luminance band | ✓ |
| Fully derived palette | Fixed OKLCH L/C, hues by angle rotation | |
| Hand-picked, checkpoint-verified only | No luminance test | |

**User's choice:** Colorimetric band + hand-tuned hues.

| Option | Description | Selected |
|--------|-------------|----------|
| Both stay locked | Tissue palette + bg untouched; amber exclusive to live retrieval/hover | ✓ |
| Tissue locked, amber rule relaxed | Amber-exclusivity renegotiable | |
| Both renegotiable at checkpoint | Whole visual system on the table | |

**User's choice:** Both stay locked.

| Option | Description | Selected |
|--------|-------------|----------|
| Semantic families allowed | Related kinds may share a hue family; motion carries distinction | ✓ |
| Minimum hue-angle separation, machine-checked | Enforced pairwise hue distance | |
| Every kind fully distinct | ~8 fully separated pastels | |

**User's choice:** Semantic families allowed (replay ice-cyan as cooler echo of live-hop cyan is intended).

---

## Salience channel mapping

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded, not retired | Dim factors keep mild ordering with hard test-enforced floor (≥~0.6) | ✓ |
| Fully retired | All layers at full palette luminance | |
| Planner decides per layer | Per-layer choice during planning | |

**User's choice:** Bounded, not retired.

| Option | Description | Selected |
|--------|-------------|----------|
| Full per-layer motion profile | Named constants block per layer; monotonic ordering on salient channels | ✓ |
| One primary discriminator per adjacent pair | Single locked channel per pair | |
| Composite salience score | Computed strictly-decreasing salience function | |

**User's choice:** Full per-layer motion profile.

| Option | Description | Selected |
|--------|-------------|----------|
| Stays neutral, gets a motion profile | No identity hue (honest); breathe params join profile system | ✓ |
| Gets its own identity hue | Twinkle as first-class palette entry | |
| Untouched entirely | Twinkle outside the new system | |

**User's choice:** Stays neutral, gets a motion profile.

| Option | Description | Selected |
|--------|-------------|----------|
| Re-homed, values preserved | Live's tuned constants migrate into profile structure, pixel-equivalent | ✓ |
| Untouched, referenced only | Invariants reference live read-only | |
| Fully on the table | Live redesigned too | |

**User's choice:** Re-homed, values preserved.

---

## Machine-checkable invariants

| Option | Description | Selected |
|--------|-------------|----------|
| Ratchet from the checkpoint | Provisional bounds; founder-approved values ± tolerance become the lock | ✓ |
| Pre-specified, checkpoint constrained | Band fixed up front from colorimetry | |
| Wide guard band only | Generous never-again floor only | |

**User's choice:** Ratchet from the checkpoint.

| Option | Description | Selected |
|--------|-------------|----------|
| Single shared source of truth | One module consumed by TS server + ESM client | ✓ |
| Keep mirrors + exhaustive sync tests | WR-01 fix pattern generalized | |
| Planner decides | Research feasibility first | |

**User's choice:** Single shared source of truth.

| Option | Description | Selected |
|--------|-------------|----------|
| In scope, all three branches | Own-trace-scoped fades in live, replay, spontaneous branches | ✓ |
| Spontaneous branch only | Highest-frequency collision only | |
| Out of scope — separate quick task | Land independently | |

**User's choice:** In scope, all three branches (WR-06).

| Option | Description | Selected |
|--------|-------------|----------|
| One dedicated invariants file | Band membership, floors, SC3 ordering, source sync in one place | ✓ |
| Per-layer files, shared helpers | Keep per-phase test file pattern | |
| Planner decides | Defer topology | |

**User's choice:** One dedicated invariants file.

---

## Bloom/tone-mapping calibration

| Option | Description | Selected |
|--------|-------------|----------|
| Bloom + exposure/tone-mapping | Composer params + renderer exposure; bg/hull/tissue locked | ✓ |
| Bloom params only | UnrealBloom threshold/strength/radius only | |
| Full compositing surface | Including per-layer blending modes | |

**User's choice:** Bloom + exposure/tone-mapping.

| Option | Description | Selected |
|--------|-------------|----------|
| Global only | One composer, global settings | ✓ |
| Selective bloom allowed if needed | Escape hatch via planner | |
| Defer to research | Assess composer capability first | |

**User's choice:** Global only.

| Option | Description | Selected |
|--------|-------------|----------|
| Founder eyeball + captured evidence | Live checkpoint + per-layer screenshots as approval record | ✓ |
| Founder eyeball only | No artifacts | |
| Measured contrast assertions | Automated pixel sampling (flaky) | |

**User's choice:** Founder eyeball + captured evidence.

| Option | Description | Selected |
|--------|-------------|----------|
| Two-stage checkpoint | Stage 1 mid-phase hue sign-off; Stage 2 closing full-system tune | ✓ |
| Single closing checkpoint | One 54-05-style checkpoint | |
| Checkpoint per plan | Founder look after every visual plan | |

**User's choice:** Two-stage checkpoint.

---

## Claude's Discretion

- Luminance metric (relative Y vs OKLCH L) + provisional band bounds.
- Shared-module mechanism across the TS-server / ESM-client boundary.
- Channel coverage beyond attack/halo per profile; profile block naming/shape.
- Starting hue hexes for non-roadmap-named kinds (incl. moving oscillation off amber-family).
- Restructuring of trace.js pre-dimmed replay color construction.
- Ratchet tolerance width.

## Deferred Ideas

- Per-layer selective bloom (rejected as second salience system).
- Trace-material blending-mode changes (additive → normal per layer).
- Automated screenshot contrast assertions.
- Reviewed-not-folded todos: viz-search-and-hull-quality, corpus-brain-3d-transition,
  cache-constant-prompt-prefix, content-hardening-deferred.
