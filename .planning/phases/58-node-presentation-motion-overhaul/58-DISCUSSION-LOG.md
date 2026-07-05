# Phase 58: Node Presentation & Motion Overhaul - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-04
**Phase:** 58-node-presentation-motion-overhaul
**Areas discussed:** Todo folding, Labels & the troika dep, Camera focus feel, Matcap sourcing & scope, Checkpoint structure

---

## Todo Folding (pre-discussion)

| Option | Description | Selected |
|--------|-------------|----------|
| Fold corpus↔brain fly-through | Camera transition rides on the new damped/interruptible camera machinery | ✓ |
| Fold viz search / hull quality | Hull quality and/or in-app search joins Phase 58 | |
| Fold neither | Both stay pending as future work | |

**User's choice:** Fold corpus↔brain fly-through only.
**Notes:** Later scoped down during the Camera area — the fold covers only re-driving the existing `transition.js` with the damped grammar; the todo's full Option A fly-through stays pending.

---

## Labels & the troika dep

| Option | Description | Selected |
|--------|-------------|----------|
| Adopt, vendored | Commit to diegetic labels now; vendor per T-10-10; checkpoint judges the result | ✓ |
| Spike first, then gate | Throwaway spike before the dep is committed | |
| Skip diegetic labels | Drop technique #2; labels stay screen-space HTML (Phase 59) | |

| Option | Description | Selected |
|--------|-------------|----------|
| Super-schemas only | Top-of-hierarchy nodes (~tens), most restrained | |
| All schema nodes | Every type='schema' node (~93+) | |
| Top-N schemas by size | N biggest by member count, tunable, ratcheted at checkpoint | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Always on, distance-faded | Permanent scene fixture in both viewports | |
| Full window only | Compact popover stays label-free | |
| Appear on approach | Fade in under a camera-distance threshold; overview stays pure constellation | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Vendored humanist mono | JetBrains/Plex Mono class, shared with Phase-59 HUD | ✓ |
| Vendored humanist sans | Place-name register rather than data-readout | |
| You decide | Claude picks at plan time | |

**User's choices:** Adopt troika vendored; top-N schemas by size; appear-on-approach; vendored humanist mono.

---

## Camera focus feel

| Option | Description | Selected |
|--------|-------------|----------|
| With anticipation | 3–5% pull-back before the dive; asymmetry-as-craft | ✓ |
| No anticipation | Straight orbit-then-dolly | |
| Founder-tuned at checkpoint | Toggleable constant, decide live | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, deepen it | Stronger non-neighbor dim + tightened fog near-plane during focus | ✓ |
| No, camera only | Existing dim/fog values stay as-is | |

| Option | Description | Selected |
|--------|-------------|----------|
| Full Option A | Corpus plane in THREE scene, one camera path, canvas handoff | |
| Damped upgrade only | Keep transition.js architecture, re-drive with damped grammar; Option A stays pending | ✓ |
| Option A behind a go/no-go | Feasibility task with downgrade path | |

| Option | Description | Selected |
|--------|-------------|----------|
| All camera moves | One damped system: focus, transition, recenter, search fly-to | ✓ |
| Focus + transition only | Headline moves only; two motion dialects coexist | |
| You decide | Planner picks per call site | |

**User's choices:** Anticipation in; deepen focus dim/fog; transition = damped upgrade only; all camera moves adopt the damped grammar.

---

## Matcap sourcing & scope

| Option | Description | Selected |
|--------|-------------|----------|
| Script-generated in repo | Offline script renders studio-lit grayscale sphere → vendored PNG | ✓ |
| Founder renders in Blender | Research's literal suggestion; manual founder task | |
| Poly Haven HDRI-derived | CC0 HDRI bake; richer but heavier | |

| Option | Description | Selected |
|--------|-------------|----------|
| Selection + 1-hop only | Matcap on committed focus; hover keeps existing response | ✓ |
| Hover too | Hovered node also gets the mix | |
| Founder-tuned at checkpoint | Build either, decide live | |

| Option | Description | Selected |
|--------|-------------|----------|
| Damped fade-in | Mix factor damps 0→1 alongside the focus flight | ✓ |
| Snap on select | Instant application | |
| You decide | Planner picks | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, include | 32-seg focus geometry in the same focus-tier task | ✓ |
| No, skip | Accept faint faceting at close range | |

**User's choices:** Script-generated matcap; selection+1-hop only; damped fade-in; 32-seg geometry included.

---

## Checkpoint structure

| Option | Description | Selected |
|--------|-------------|----------|
| Two-stage, look then motion | Stage 1: static presentation + troika keep/kill; Stage 2: motion tune | ✓ |
| Single closing checkpoint | Everything judged once at the end | |
| Per-technique sign-offs | ~5 mini-checkpoints | |

| Option | Description | Selected |
|--------|-------------|----------|
| Screenshots + recordings | Stage 1 screenshots; Stage 2 adds screen recordings of motion | ✓ |
| Screenshots only | Static captures for both stages | |
| No artifacts | Founder eyeball is the whole record | |

| Option | Description | Selected |
|--------|-------------|----------|
| Palette-touching locks only | Machine-lock label color/amber rules + matcap grayscale + no LOCKED-constant drift; feel constants unlocked | ✓ |
| Extend to feel constants too | Also ratchet-lock approved motion values | |
| No new locks | Existing invariants file suffices | |

| Option | Description | Selected |
|--------|-------------|----------|
| Measure before/after | fps at both tiers, one-line comparison; regression = fix before close | ✓ |
| Founder feel only | No numbers captured | |
| Hard fps budget | Locked numeric floor | |

**User's choices:** Two-stage look-then-motion; screenshots + recordings; palette-touching locks only; measure fps before/after.

---

## Claude's Discretion

- Haze impostor falloff curve, blending specifics, raycast path (proxy spheres vs proximity fallback)
- Label N default, fade thresholds, appear-on-approach distance
- Damped-camera implementation shape (per-frame driven target vs sequenced calls)
- Hover damping lambdas and overshoot magnitude
- Specific open-licensed mono face to vendor
- Matcap script lighting rig and mix-factor bounds

## Deferred Ideas

- Full Option A corpus-plane fly-through (todo stays pending)
- Depth-buffer soft particles for haze
- HUD motion tokens / CSS custom properties → Phase 59
- Label interactivity (click-to-focus) → Phase 59 or later
