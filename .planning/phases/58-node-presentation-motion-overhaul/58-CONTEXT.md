# Phase 58: Node Presentation & Motion Overhaul - Context

**Gathered:** 2026-07-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Nodes and interactions reach the July-2026 premium bar, per the ranked techniques in
`.planning/research/viz-polish-2026.md`:

**In scope:**
- **Soft-sprite haze impostors** — replace the haze `InstancedMesh`'s shared sphere geometry
  with instanced camera-facing quads carrying a procedural radial-falloff fragment shader
  (research area 1 #1: the biggest "default orbs → crafted" upgrade; no full depth-buffer
  soft particles).
- **Diegetic SDF labels** via vendored troika-three-text on the top-N schemas by member
  count — appear-on-approach, depth-occluded, vendored humanist mono font.
- **Focus-tier matcap mix** — script-generated grayscale matcap multiplied by the node's own
  palette color, on selection + 1-hop only, damped fade-in; plus the 32-seg focus geometry.
- **Damped hover/selection grammar** — frame-rate-independent (`damp`-style) replacing the
  `HOVER_SCALE` snap at `graph.js:588`; asymmetric feel (slight overshoot in, none out).
- **One damped, interruptible camera system** driving ALL camera moves: two-phase
  orbit-then-dolly node focus with anticipation pull-back, the brain↔corpus transition
  (re-drive of existing `transition.js`), recenter/home framing, and search fly-to.
- **Focus depth deepening** — slightly stronger non-neighbor dim + tightened fog near-plane
  during focus (the research's cheap alternative to rejected DOF).
- Two-stage founder checkpoint (look, then motion) with screenshots + screen recordings as
  the approval record; before/after fps measurement at both tiers.

**Out of scope (hard):**
- Everything LOCKED by Phase 57: activity palette + D-02 luminance band [170, 228],
  amber-exclusive-to-live (D-04), four-layer motion profiles, 0.72 bloom threshold,
  `NoToneMapping` + exposure 1. Research explicitly rejects AgX/ACES — a tone curve would
  silently re-grade every locked hue.
- HUD/overlay work (⌘K palette, glass panels, CSS tokens, screen-space labels) — Phase 59.
- Full Option A corpus-plane fly-through (corpus rendered inside the THREE scene with camera
  handoff) — deferred; this phase only re-drives the existing transition architecture.
- WebGPU/TSL migration — stay WebGL2 (3d-force-graph blocks it; no perf problem at 17k nodes).
- The research's slop lists are binding: no AO, no per-node emissive-HDR bloom hacks, no
  per-kind geometry, no node textures, no DOF, no fixed-duration tween library deps, no LUTs.
- Honesty invariant untouched — presentation/interaction only; no fabricated engine activity.

</domain>

<decisions>
## Implementation Decisions

### Diegetic labels & the troika dep
- **D-01: Adopt troika-three-text now, vendored.** Committed as a planned task per the
  T-10-10 vendor-everything rule (no CDN fetch, including its font). The Stage-1 founder
  checkpoint judges the RESULT (keep/kill verdict on the rendered look), not the adoption.
- **D-02: Label scope = top-N schemas by member count**, regardless of hierarchy level.
  N is a named tunable constant (starting point ~30, planner picks), ratcheted at the
  checkpoint. Adaptive as the brain grows — not a fixed super-schema-only or all-schema set.
- **D-03: Appear-on-approach visibility.** Labels fade in only under a camera-distance
  threshold (zoomed in / focused region); the overview stays pure constellation in both
  viewports. Rendering mechanics locked from research: `depthTest: true` (hull/nodes occlude
  naturally), distance-faded, slate `0xaab3c4`-family at ~0.7 alpha, never amber.
- **D-04: Vendored humanist mono font** (JetBrains Mono / IBM Plex Mono class, open-licensed)
  for the SDF atlas — instrument-panel register, intended to be shared with Phase-59 HUD
  typography so scene and chrome speak one type vocabulary.

### Camera & interaction motion
- **D-05: One damped-target camera system for ALL camera moves** — node focus, the
  brain↔corpus transition, recenter/home framing (`graph.js:810-812`), and search fly-to.
  Interruptibility-as-a-rule holds everywhere by construction: clicking node B mid-flight to
  A retargets smoothly — never queues, never jumps. No tween/animation library; springs and
  `damp` are ~15 lines in the existing `registerTick` loop.
- **D-06: Focus flight = orbit-then-dolly WITH the anticipation beat.** 3–5% initial
  pull-back, then rotate-on-axis (~300ms, ease-out), then dolly in (~600ms, ease-in-out) —
  timings start at research defaults as named constants, tuned at Stage 2.
- **D-07: Focus depth deepening in scope.** Small named-constant adjustments to the
  detail.js non-neighbor dim strength and the fog near-plane while focused; tuned at Stage 2.
- **D-08: Transition = damped upgrade only.** Keep `transition.js`'s architecture
  (pull-back + opacity crossfade, "brain recedes first" founder-chosen feel) and its 4
  baked-in patch-era lessons (exact-home restore, markActive suppression, opacity-only fades,
  prepared-before-reveal); re-drive its camera moves through the new damped grammar. The
  todo's Option A stays deferred (see Deferred Ideas).

### Focus-tier matcap
- **D-09: Matcap is script-generated in-repo.** A small offline script (three.js or canvas,
  in `scripts/`) renders a studio-lit grayscale sphere → PNG vendored as an asset.
  Deterministic, regenerable, zero license exposure. nidorx/matcaps may be browsed as a
  catalog but never shipped.
- **D-10: Selection + 1-hop only.** Matcap mix applies on committed focus (click/drill-in)
  to the focused node + 1-hop neighbors; hover keeps the existing scale+brighten response.
  Never on overview tiers — flat+rim is the quiet-ghost-brain identity. Grayscale matcap
  contributes luminance shaping only; hue stays the node's own palette color (D-04-safe).
- **D-11: Damped fade-in.** The matcap mix factor damps 0→1 alongside the focus flight and
  fades back out on deselect — one coherent motion event, sampled in the existing
  `onBeforeCompile` injection.
- **D-12: 32-seg focus geometry included.** A second shared `SphereGeometry(1, 32, 32)` for
  the selected node + hover-scaled state; lands in the same focus-tier task.

### Checkpoints, evidence, invariants, perf
- **D-13: Two-stage founder checkpoint — look, then motion.** Stage 1 (mid-phase): static
  presentation on the live install — haze impostors + labels + matcap; the troika keep/kill
  verdict lands here, before motion work builds on it. Stage 2 (closing): full motion tune
  (hover, focus flight, transition, dim/fog) + final constant values.
- **D-14: Evidence = screenshots + screen recordings.** Stage 1 keeps the Phase-57
  per-technique screenshot pattern; Stage 2 adds short screen recordings of the motion
  moments (hover, focus flight, transition) as the durable approval record.
- **D-15: Machine locks for palette-touching constants only.** New invariants (extend the
  Phase-57 invariants test file): label color inside the D-02 band and never amber-family;
  matcap asset grayscale-only (hue must come from node color); no drift of the LOCKED
  bloom/tone-mapping/motion-profile constants. Feel constants (camera timings, anticipation
  factor, matcap mix strength, dim/fog focus values) stay founder-tuned and UNLOCKED — named
  constants, no ratchet test.
- **D-16: Perf measured before/after.** Capture fps at both tiers (overview idle ~24fps,
  focus interaction ~60fps) on the live install before and after the phase; one-line
  comparison in checkpoint notes. Regression = fix before close. No hard numeric floor.

### Claude's Discretion
- Haze impostor details: falloff curve shape/softness, blending specifics, and the raycast
  path (invisible proxy spheres vs the existing proximity fallback at `graph.js:976`).
- Exact N default for labels, distance-fade thresholds, and the appear-on-approach camera
  distance — provisional values in plans, tuned at Stage 1.
- Damped-camera implementation shape (drive `Graph.cameraPosition` per-frame from a damped
  target vs sequenced calls) — research forbids swapping in yomotsu camera-controls; the
  library is the feel reference only.
- Hover damping lambda values and the overshoot magnitude (~1.05×, one oscillation max).
- Which specific open-licensed mono face gets vendored (D-04's class constraint applies).
- Matcap script's lighting rig and the mix-factor bounds.

### Folded Todos
- **`corpus-brain-3d-transition.md`** (founder-requested at the 34-03 checkpoint) —
  PARTIALLY folded. This phase re-drives the existing `transition.js` pull-back/crossfade
  through the new damped, interruptible camera grammar (D-08). The todo's core ask — the
  full Option A shared-space camera fly-through — is explicitly NOT resolved here and the
  todo stays pending for it.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The phase's technique contract (read first)
- `.planning/research/viz-polish-2026.md` — THE source for this phase: verified codebase
  baseline (2026-07-04, live source), ranked techniques with effort/impact, the binding
  "do not do" slop lists per area, license table (nidorx unsafe, Poly Haven CC0), the
  negative recommendations (no tone-mapping change, no DOF, no camera-controls dep, stay
  WebGL2), and suggested sequencing. Requirements derive from its ranked list.
- `.planning/ROADMAP.md` (Phase 58 entry, ~line 1156) — goal statement and lock summary.

### Locked systems this phase must not disturb
- `.planning/phases/57-viz-activity-palette-redesign/57-CONTEXT.md` — the palette-redesign
  decisions (D-02 luminance band, D-04 amber exclusivity, motion-profile system, shared
  constants source, invariants-file pattern) that are now LOCKED and carried forward.
- `src/viz/modules/constants.js` — LOCKED `TYPE_COLOR`/`BG_COLOR`/band constants + the
  per-layer motion profiles; new Phase-58 constants join this file's discipline.
- `src/viz/modules/effects.js:139-165` — bloom threshold margin analysis (load-bearing) +
  `UnrealBloomPass(0.6, 0.4, 0.72)` composer setup; `graph.js:668-683` — `NoToneMapping` +
  exposure 1, founder-approved 2026-07-03.
- `CLAUDE.md` (project) — faithfulness clause: viz is decorative chrome; engine mechanisms
  untouched; viz server read-only/LLM-free.

### Code to change
- `src/viz/modules/graph.js:37` — `_sharedGeo` SphereGeometry(1,16,16); `:381-510` — the
  haze `InstancedMesh` build (impostor target); `:588` — the `HOVER_SCALE` snap (damped
  hover target); `:810-812` — recenter/home `cameraPosition` tweens; `:976` — haze raycast
  proximity fallback; `:125-136` — the `onBeforeCompile` fresnel rim injection the matcap
  mix extends.
- `src/viz/modules/transition.js` — the brain↔corpus transition controller to re-drive
  (D-08); its header documents the 4 patch-era lessons that MUST NOT regress.
- `src/viz/modules/detail.js` — non-neighbor focus dim (D-07 deepening target) and the
  node-focus flight call site.
- `src/viz/modules/search.js` — fly-to-node call site (D-05 migration).
- `src/viz/modules/lod.js` — haze/overview tier logic the impostors must respect
  (`OVERVIEW_NODE_CAP = 3000`).
- Phase-57 invariants test file (locate via `git log --diff-filter=A` or grep for the
  luminance-band test) — D-15's new locks extend it.

### Folded todo (partial)
- `.planning/todos/pending/corpus-brain-3d-transition.md` — founder verbatim ask, why it's
  structural, Option A/B sketches. Phase 58 delivers only the damped re-drive; keep the todo.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `transition.js` already implements an interruptible state machine for the brain↔corpus
  swap with founder-approved feel — the damped re-drive slots into `pullBackCamera()`/
  `diveCamera()` without touching the crossfade logic.
- The `onBeforeCompile` rim injection (`graph.js:125-136`, single shared program) is the
  proven seam for the matcap mix — extend the same injection, keep one compiled program.
- The instanced-haze build (`graph.js:381-510`) already owns per-instance matrices/colors —
  the impostor swap changes geometry + material, not the instancing bookkeeping.
- `registerTick` loop + `IDLE_FPS`/`FULL_FPS` tiers — the home for all damping math;
  frame-rate independence (`THREE.MathUtils.damp`) is required precisely because of the
  24↔60fps tier swing.
- Phase-57 invariants test file + shared constants module — the discipline new constants
  join (D-15).

### Established Patterns
- Named tunable constants in `constants.js` + founder checkpoint on the live install
  (54-05/56-05/57 pattern) — every new feel value follows it.
- Vendor-everything (T-10-10): troika + font + matcap PNG all vendored, no CDN.
- Amber is the only warm signal (D-04): every addition must pass "does this compete with
  amber?" — labels slate, matcap hue-neutral.
- Screenshot-as-approval-record established in Phase 57 (D-15 there); this phase extends it
  with recordings for motion.

### Integration Points
- Haze impostors must keep working with `lod.js` tier switching and the trace/twinkle layers
  that tint haze instances.
- Labels need schema member counts — available from the existing `/graph` payload
  (schema nodes + `abstracts` edges from Phase 18); no engine change.
- The damped camera must coexist with stats.js idle camera drift (`markActive()` suppression
  — transition.js lesson 2) and 3d-force-graph's control ownership (drive
  `Graph.cameraPosition`, don't replace controls).
- Tray app consumes SSE trace events only — no color/motion assumptions; no tray changes
  expected.

</code_context>

<specifics>
## Specific Ideas

- The premium bar, in the research's words: "everything is a spring/damp toward a target
  that can move at any frame" — fixed-duration uninterruptible tweens are the tell of junior
  work. Interruptibility is the single behavioral property separating Linear-grade feel from
  tween soup.
- Asymmetry as craft: hover grows with a slight overshoot (~1.05×, one oscillation max) and
  shrinks with none; the camera gathers itself (anticipation pull-back) before diving.
- The haze should read as atmosphere, not dim geometry — radial `smoothstep(0.5, 0.0, dist)`
  falloff alone gets 90% of the soft-particle look for 10% of the cost.
- Labels are place-names on a map: rare landmarks (top-N), revealed as you approach, occluded
  naturally by the brain itself — never floating HTML pretending to be in the scene.
- yomotsu camera-controls v3 is the reference for what focus should FEEL like
  (`smoothTime`/`restThreshold` damping) — a feel reference, not a dependency.

</specifics>

<deferred>
## Deferred Ideas

- **Full Option A corpus↔brain fly-through** — render the corpus layout as a flat plane
  inside the THREE scene, fly one camera path from brain framing to corpus framing, hand off
  to the 2D canvas (reverse on return). Explicitly kept out of Phase 58 (D-08); the
  `corpus-brain-3d-transition.md` todo stays pending for a future phase, which will now have
  the damped camera grammar to build on.
- **Depth-buffer soft particles** for the haze (fade on geometry intersection) — research
  says not needed; revisit only if impostors visibly clip against the hull.
- **HUD motion tokens / CSS custom properties** (research area 2 #4) — one motion vocabulary
  across canvas and chrome; belongs with Phase 59's HUD work, where the CSS side gets its
  token discipline.
- **Label interactivity** (click a label to focus its schema) — not discussed/committed;
  natural Phase-59-or-later candidate once labels exist.

### Reviewed Todos (not folded)
- `viz-search-and-hull-quality.md` — in-app search affordance is Phase-59 HUD territory
  (⌘K palette absorbs it); hull front/top jaggedness is structural mesh work, not node
  presentation. Stays pending.
- `content-hardening-deferred.md` — engine-side; keyword-match noise, no viz relevance.

</deferred>

---

*Phase: 58-node-presentation-motion-overhaul*
*Context gathered: 2026-07-04*
