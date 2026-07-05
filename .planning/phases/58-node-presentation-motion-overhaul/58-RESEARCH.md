# Phase 58: Node Presentation & Motion Overhaul - Research

**Researched:** 2026-07-04
**Domain:** three.js r171 / 3d-force-graph node rendering + camera choreography, implemented against the live `recense viz` codebase
**Confidence:** HIGH on codebase facts and vendored-library facts (read from live source + actual downloaded npm tarballs), MEDIUM on shader/perf-tuning specifics (sound graphics-engineering reasoning, not yet prototyped), LOW where flagged

## Summary

The domain research (`.planning/research/viz-polish-2026.md`) already picked the techniques and ranked them; this document is the implementation layer — what actually has to change in `src/viz/modules/*.js`, what the vendored troika-three-text dependency chain really contains, and where the domain research's recommendations meet load-bearing existing code (the LOCKED bloom/tone-mapping/palette constants, the shared-program rim injection, 3d-force-graph's own internal camera tweening).

Three findings materially change how the planner should scope tasks, beyond what the domain research said:

1. **troika-three-text has a live CDN fallback path** (`unicode-font-resolver` via jsDelivr) that fires automatically whenever any rendered character isn't covered by the vendored font's loaded glyphs — and critically, pointing its config at a local/broken URL does **not** suppress it; on failure it retries the *real* default CDN once. The only way to honor T-10-10 (vendor-everything, zero CDN) is a small source patch to the vendored `troika-three-text.esm.js` (see Common Pitfalls). This is not mentioned in the domain research and is a hard requirement for D-01 to actually hold.
2. **3d-force-graph's `cameraPosition(pos, lookAt, ms)` accessor already has a synchronous, non-tweened code path** — calling it with `ms` falsy (0/undefined) sets `camera.position` and `controls.target` directly with no internal TWEEN.js involvement (verified by reading the vendored, minified `3d-force-graph.min.js`). This is the correct, idiomatic mechanism for D-05's damped camera system: drive `Graph.cameraPosition(dampedPos, dampedLookAt, 0)` every `registerTick` frame. No raw `Graph.camera()`/`Graph.controls()` poking needed, no fight with the library's own tween group.
3. **The haze impostor swap interacts with two LOCKED invariants** the domain research didn't flag: (a) the existing haze material has `depthWrite: true` — switching to a radial-falloff translucent quad without an `alphaTest` discard will produce hard rectangular occlusion artifacts; (b) if the quads use `AdditiveBlending` (as the domain research suggests for "no sort needed"), dense overlapping haze clusters can sum luminance across many overlapping fragments and cross the LOCKED 0.72 bloom threshold in crowded regions even though each instance's own color sits far below it — an unintended, D-04-violating "fake flare." `alphaTest` + `depthWrite:true` + normal (non-additive) alpha blending gets the same "no sort needed" property (discarded fragments write nothing, kept fragments replace via depth test) without the stacking risk.

**Primary recommendation:** Implement the haze impostor as a **new custom `ShaderMaterial`** (not an `onBeforeCompile` extension of the existing haze `MeshBasicMaterial` — the billboard vertex logic and radial-falloff fragment logic don't fit the "inject into standard chunks" pattern that the rim injection uses), keep the matcap mix as an extension of the **existing** `onBeforeCompile` injection on individual node materials only (never the haze InstancedMesh material — haze-tier nodes never get matcap per D-10), and drive every camera move (focus, recenter, transition, search fly-to) through one `registerTick`-resident damp system that writes into `Graph.cameraPosition(pos, lookAt, 0)`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Haze impostor rendering (quads + falloff shader) | Browser/Client (WebGL scene, `graph.js`) | — | Pure GPU-side rendering; no data dependency beyond existing node positions/colors already in `ctx` |
| SDF schema labels (troika-three-text) | Browser/Client (new `labels.js` module) | API/Backend (existing `/graph` payload for member counts) | Rendering is 100% client; the top-N-by-member-count selection reads data already served by the existing read-only `/graph` endpoint — no server change |
| Focus-tier matcap mix | Browser/Client (`graph.js` `onBeforeCompile`) | — | Extends an already-client-side shared shader program; matcap PNG is a vendored static asset, not a service |
| Damped hover/selection grammar | Browser/Client (`stats.js`/`registerTick` + `graph.js` hover handlers) | — | Pure interaction-response math in the existing rAF loop |
| Unified damped camera system | Browser/Client (new small module or extension of `graph.js`) | — | Wraps `Graph.cameraPosition()`, an existing client-only accessor; no backend involvement |
| Transition re-drive | Browser/Client (`transition.js`) | — | Re-drives its own existing camera calls through the new damped system; crossfade/DOM logic untouched |
| Focus depth deepening (dim + fog) | Browser/Client (`detail.js` non-neighbor dim, `graph.js` fog) | — | Both are already client-only scene parameters |
| Perf measurement (before/after fps) | Browser/Client (`stats.js` overlay, already exists) | — | `stats.js`'s existing hidden 'S' hotkey overlay already reports fps; no new harness needed, see Validation Architecture |

No capability in this phase touches the API/Backend tier's write path, the database, or any consolidation/retrieval code — 100% presentation-tier, consistent with the phase boundary.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)

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
</user_constraints>

<phase_requirements>
## Phase Requirements

This phase has no `REQUIREMENTS.md`-tracked requirement IDs — the project's `.planning/REQUIREMENTS.md` tracks the unrelated v9.0 "Memory Quality" engine milestone (RECON/RETR/HARD/SCALE/GATE), which is presentation-agnostic and does not cover viz work. Phase 58's requirement set is the CONTEXT.md decisions D-01 through D-16 above, mapped here to the research that supports each:

| Decision | Description | Research Support |
|----------|-------------|-------------------|
| D-01–D-04 | Vendored troika-three-text SDF labels, top-N by member count, appear-on-approach, vendored mono font | Standard Stack, Package Legitimacy Audit, Common Pitfall "troika's hidden CDN fallback", Code Examples |
| D-05, D-06 | Unified damped camera system, orbit-then-dolly focus flight | Common Pitfall "3d-force-graph's synchronous cameraPosition path" (verified from vendored source), Architecture Patterns |
| D-07 | Focus depth deepening (dim + fog) | Existing `detail.js`/`graph.js` constant locations identified below |
| D-08 | Transition re-drive through the damped grammar | `transition.js` read in full; exact call sites identified |
| D-09–D-12 | Script-generated matcap, selection+1-hop scope, damped fade-in, 32-seg geometry | Architecture Patterns (matcap UV code example), existing `onBeforeCompile` seam confirmed reusable |
| D-13–D-16 | Two-stage checkpoint, evidence, machine locks, perf measurement | Validation Architecture, existing invariants-test pattern (`tests/viz-activity-palette-invariants.test.ts`) |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `troika-three-text` | 0.52.4 | SDF text rendering for schema labels | De-facto standard for in-scene three.js text; the domain research already selected it — this phase vendors it |
| `troika-three-utils` | 0.52.4 | Shared shader-patching utilities troika-three-text imports | Direct runtime dependency of troika-three-text (`createDerivedMaterial`, `voidMainRegExp`) |
| `troika-worker-utils` | 0.52.0 | Web Worker helper troika-three-text uses for off-main-thread typesetting/SDF generation | Direct runtime dependency; constructs its Worker via an inline Blob URL — no separate worker file to vendor |
| `webgl-sdf-generator` | 1.1.1 | GPU-accelerated SDF atlas generation | Direct runtime dependency of troika-three-text |
| `bidi-js` | 1.0.3 | Bidirectional text segmentation | Direct runtime dependency of troika-three-text (used for RTL script support; inert for the ASCII schema-name case but required at import time) |

**Version verification [VERIFIED: npm registry]:** confirmed 2026-07-04 via `npm view <pkg> version` — all five packages resolve to the versions above on the public npm registry, matching (or exceeding) the versions troika-three-text's own `package.json` declares as dependencies.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| JetBrains Mono (or IBM Plex Mono) TTF | current release | Vendored humanist mono font for the SDF atlas (D-04) | Download the Regular weight TTF from the official GitHub Releases page, vendor as a static asset — do not fetch at runtime |

**Font license [CITED: github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt]:** JetBrains Mono ships under SIL OFL 1.1 (free for commercial use, no attribution requirement, redistribution permitted). IBM Plex Mono is also OFL-1.1-licensed and is the equally valid alternative named in D-04; either satisfies the "open-licensed humanist mono" constraint — final pick is Claude's Discretion per CONTEXT.md.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| troika-three-text | Hand-rolled canvas-texture text sprites | Rejected by the domain research and by D-01 — SDF atlas generation is exactly the kind of thing the Don't-Hand-Roll table below flags; canvas-texture text blurs at any non-1:1 zoom and can't occlude correctly against 3D geometry the way an SDF mesh with `depthTest` can |
| Custom `ShaderMaterial` haze impostor | Extending the existing haze `MeshBasicMaterial` via a second `onBeforeCompile` pass | The billboard-facing vertex logic and radial-falloff fragment logic don't fit inside three.js's standard `#include` chunk points the way the rim injection does; a from-scratch `ShaderMaterial` is simpler and clearer for a wholesale geometry+shading swap |

**Installation:**
```bash
# From project root — download and extract the ESM dist files only (no npm install,
# no package.json entry: 'three' itself is vendored the same way, not an npm dependency)
cd /tmp && npm pack troika-three-text@0.52.4 troika-three-utils@0.52.4 \
  troika-worker-utils@0.52.0 webgl-sdf-generator@1.1.1 bidi-js@1.0.3
# Extract each tarball's dist/*.esm.js (or .mjs) file into src/viz/vendor/troika/
```

Each package's ESM dist file imports its dependencies by **bare specifier** (`import ... from 'troika-worker-utils'`, `from 'three'`, etc. — confirmed by extracting and reading the actual `.esm.js`/`.mjs` files), so the vendoring approach is: copy each dist ESM file into `src/viz/vendor/troika/`, then add one import-map entry per package to `src/viz/index.html`'s existing `<script type="importmap">` block (currently only maps `"three"`). This mirrors the project's existing zero-build-step, pure-ESM-import-map vendoring pattern exactly — `scripts/copy-viz-assets.cjs` already recursively copies the whole `vendor/` directory into `dist/`, so no build-script change is needed beyond adding the files.

## Package Legitimacy Audit

`slopcheck` could not be installed in this research environment (the local Python 3.14/pip toolchain is broken — `pyexpat` fails to load with a missing symbol, unrelated to this phase). Per the graceful-degradation protocol, every package below is tagged `[ASSUMED]` and the planner must gate each install behind a `checkpoint:human-verify` task.

That said, manual verification was performed (npm registry age/downloads, actual tarball extraction and source inspection of every dist file) and the evidence is unusually strong for an "assumed" package set:

| Package | Registry | Age | Downloads (last 7d) | Source Repo | slopcheck | Disposition |
|---------|----------|-----|----------------------|--------------|-----------|--------------|
| troika-three-text | npm | created 2020-07-06 (~6 yrs) | 2,903,050 | github.com/protectwise/troika | unavailable — `[ASSUMED]` | Approved (manual verification: real repo, MIT, matches its own declared deps) |
| troika-three-utils | npm | created 2019-08-16 (~7 yrs) | 2,904,842 | github.com/protectwise/troika | unavailable — `[ASSUMED]` | Approved |
| troika-worker-utils | npm | created 2019-06-22 (~7 yrs) | 2,897,160 | github.com/protectwise/troika | unavailable — `[ASSUMED]` | Approved |
| webgl-sdf-generator | npm | created 2021-11-20 (~5 yrs) | 2,863,624 | github.com/lojjic/webgl-sdf-generator | unavailable — `[ASSUMED]` | Approved |
| bidi-js | npm | created 2021-04-15 (~5 yrs) | 23,538,740 | github.com/lojjic/bidi-js | unavailable — `[ASSUMED]` | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none — but per protocol, the planner should still insert one `checkpoint:human-verify` task before the vendoring task, since slopcheck itself never ran. No `postinstall` scripts exist on any of the five packages (all are pure-JS ESM/UMD dist bundles with no install-time script — checked via `npm view <pkg> scripts.postinstall`, all empty).

*All packages above are tagged `[ASSUMED]` per the graceful-degradation protocol; the planner must gate each install behind a `checkpoint:human-verify` task even though the manual npm-registry + source-inspection evidence is strong.*

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │   registerTick (stats.js, existing rAF loop)  │
                    │   — the home for ALL new per-frame math       │
                    └───────────────┬───────────────────────────────┘
                                    │ every frame (24fps idle / 60fps active)
        ┌───────────────────────────┼───────────────────────────────┐
        ▼                           ▼                                ▼
 ┌─────────────┐          ┌──────────────────┐            ┌──────────────────┐
 │ Hover/select │          │  Damped camera    │            │  Matcap mix-     │
 │ scale damp   │          │  system (new)      │            │  factor damp     │
 │ (graph.js)   │          │  — chases a        │            │  (graph.js       │
 │              │          │  retargetable      │            │  onBeforeCompile │
 │ THREE.MathUtils │        │  {pos, lookAt}     │            │  uniform)        │
 │ .damp()      │          │  via               │            └──────────────────┘
 └──────┬───────┘          │  Graph.cameraPosition
        │                  │  (pos, lookAt, 0)  │
        │                  └─────────┬──────────┘
        │                            │ drives, retargetable at any time
        │             ┌──────────────┼───────────────┬───────────────┐
        │             ▼              ▼               ▼               ▼
        │      detail.js       transition.js      search.js      graph.js
        │      selectNode      toCorpus/toBrain   pick()         recenter()
        │      focusCamera     pullBackCamera/     fly-to         home framing
        │      (D-06 orbit-    diveCamera
        │       then-dolly)    (D-08 re-drive)
        │
        ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │  Scene graph (Graph.scene())                                            │
 │                                                                          │
 │  ┌───────────────┐   ┌──────────────────┐   ┌─────────────────────────┐ │
 │  │ Haze           │   │ Schema/member/    │   │ SDF labels (new         │ │
 │  │ InstancedMesh  │   │ selected node      │   │ labels.js, troika)      │ │
 │  │ — NEW: quad    │   │ meshes             │   │ — top-N schemas,        │ │
 │  │ geometry +     │   │ — _sharedGeo (16²) │   │ depthTest:true,         │ │
 │  │ custom Shader- │   │ + NEW 32²-seg      │   │ distance-faded,         │ │
 │  │ Material       │   │ focus geometry     │   │ occluded by opaque      │ │
 │  │ (billboard +   │   │ (D-12); matcap     │   │ nodes (not by the       │ │
 │  │ radial falloff)│   │ mix on focus       │   │ depthWrite:false hull)  │ │
 │  └───────────────┘   └──────────────────┘   └─────────────────────────┘ │
 └────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

No new top-level directories. New files fit the existing flat `src/viz/modules/` + `src/viz/vendor/` layout:

```
src/viz/
├── modules/
│   ├── graph.js         # MODIFIED: haze impostor swap, matcap mix injection, 32-seg focus geo
│   ├── labels.js         # NEW: troika-three-text schema-label module (initLabels(ctx) pattern, mirrors detail.js/search.js's initX(ctx) convention)
│   ├── camera.js          # NEW (or folded into graph.js): the one damped-target camera system
│   ├── transition.js     # MODIFIED: pullBackCamera/diveCamera re-drive through camera.js
│   ├── detail.js          # MODIFIED: focusCamera call site migrates to the damped system; dim strength constant tune (D-07)
│   ├── search.js          # MODIFIED: pick() fly-to migrates to the damped system
│   ├── stats.js           # MODIFIED (maybe): registerTick already exists — likely no change needed, damp math lives in the new module(s)
│   └── constants.js       # MODIFIED: new named constants (HOVER lambda, camera phase timings, matcap mix bounds, label N/thresholds)
├── vendor/
│   ├── troika/            # NEW: vendored troika-three-text + 4 transitive deps' ESM dist files
│   └── fonts/              # NEW: vendored JetBrains Mono (or IBM Plex Mono) TTF
scripts/
└── gen-matcap.mjs         # NEW: offline three.js/canvas script rendering a grayscale studio-lit sphere → PNG (mirrors scripts/smooth-display-hull.py's "regenerable derived asset" convention)
```

### Pattern 1: Driving the damped camera through 3d-force-graph's existing accessor

**What:** `Graph.cameraPosition(pos, lookAt, ms)` has two code paths — read the vendored, minified bundle and it is unambiguous: when `ms` is truthy, it spins up its own internal `TWEEN.js`-family tween group (`easing(Quadratic.Out)`, position over `ms`, lookAt over `ms/3`); when `ms` is falsy, it takes a **synchronous** branch that directly sets `camera.position.{x,y,z}` and `controls.target` (or `camera.lookAt()` if there's no orbit-controls `target`).

**When to use:** Every camera move in the phase (D-05). Calling this accessor with `ms=0` every `registerTick` frame, fed with the current damped position/lookAt, is the correct drop-in replacement for the current nonzero-`ms` calls scattered across `detail.js` (800ms), `graph.js` (700ms `recenter`), and `transition.js` (750ms `DUR`) — it bypasses the library's own internal tween entirely, so a hand-rolled damp system never fights it.

**Example:**
```js
// Source: read directly from src/viz/vendor/3d-force-graph.min.js (verified, not CDN docs —
// the minified accessor's actual body, decoded):
//
//   cameraPosition:function(e,t,n,i){
//     var r=e.camera;
//     if(t&&e.initialised){
//       if(i){ /* i = ms, truthy: internal TWEEN group, Quadratic.Out easing */ }
//       else { u(s); c(a); }   // i falsy: SYNCHRONOUS set, no tween
//       return this;
//     }
//     return Object.assign({}, r.position, {lookAt: h()});  // no-arg call = read current
//   }
//   function u(pos){ /* camera.position.x/y/z = pos.x/y/z (partial updates OK) */ }
//   function c(lookAt){ /* controls.target = lookAt vector, or camera.lookAt(lookAt) */ }

// New camera.js — one damped target the whole app retargets:
let targetPos = { x: 0, y: 0, z: BRAIN_SCALE * 2.2 };
let targetLookAt = { x: 0, y: 0, z: 0 };

function setCameraTarget(pos, lookAt) {
  targetPos = pos;
  targetLookAt = lookAt;
}

ctx.registerTick((now) => {
  const dt = /* seconds since last tick, tracked separately */ ;
  const cur = ctx.Graph.cameraPosition(); // no-arg read: { x, y, z, lookAt }
  const dampedPos = {
    x: THREE.MathUtils.damp(cur.x, targetPos.x, CAM_LAMBDA, dt),
    y: THREE.MathUtils.damp(cur.y, targetPos.y, CAM_LAMBDA, dt),
    z: THREE.MathUtils.damp(cur.z, targetPos.z, CAM_LAMBDA, dt),
  };
  const dampedLookAt = { /* same damp on cur.lookAt.{x,y,z} → targetLookAt */ };
  ctx.Graph.cameraPosition(dampedPos, dampedLookAt, 0); // ms=0 → synchronous branch
});

ctx.setCameraTarget = setCameraTarget; // detail.js/search.js/transition.js call this instead
                                       // of Graph.cameraPosition(pos, lookAt, ms>0) directly
```

### Pattern 2: Matcap mix inside the existing shared `onBeforeCompile` program

**What:** The existing rim injection (`graph.js:125-136`) already adds `vRimN`/`vRimV` varyings computed from the unit-sphere's local position (== normal, since it's centered at the origin). Matcap needs a **view-space** normal, which is a different quantity — the standard matcap UV formula is `uv = normalize(viewSpaceNormal).xy * 0.5 + 0.5`, sampled against a square grayscale texture. Because every node's `MeshBasicMaterial` shares this identical `onBeforeCompile` function body (that's *why* they all compile to one shared program today), adding the matcap sampling code to the same function keeps that invariant — every node's shader gains the capability, but only focused nodes ever set `uMatcapMix > 0`.

**When to use:** D-10/D-11 — selection + 1-hop only, damped fade-in. Do NOT touch `buildHazeLayer`'s separate `hazeMat.onBeforeCompile` — haze-tier nodes never get matcap (and haze already compiles to a structurally different program anyway, since `InstancedMesh` injects its own `USE_INSTANCING` define).

**Example:**
```js
// Source: standard matcap UV technique (same approach three.js's own
// MeshMatcapMaterial fragment shader uses internally) + this codebase's
// existing onBeforeCompile convention (graph.js:125-136):
mat.onBeforeCompile = (shader) => {
  // ...existing rim injection unchanged...
  shader.uniforms.uMatcapTex  = { value: null };   // set once: the shared grayscale PNG
  shader.uniforms.uMatcapMix  = { value: 0 };       // per-node: damped 0→1 on focus (D-11)
  mat.userData.matcapMixUniform = shader.uniforms.uMatcapMix; // mirrors __baseOp tracking

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>',
      '#include <common>\nvarying vec3 vViewNormal;')
    .replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvViewNormal = normalize(normalMatrix * normal);');

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>',
      '#include <common>\nuniform sampler2D uMatcapTex;\nuniform float uMatcapMix;\nvarying vec3 vViewNormal;')
    .replace('#include <dithering_fragment>',
      `#include <dithering_fragment>
       vec2 matcapUv = vViewNormal.xy * 0.495 + 0.5;
       vec3 matcapColor = texture2D(uMatcapTex, matcapUv).rgb * gl_FragColor.rgb; // grayscale × node hue (D-10)
       gl_FragColor.rgb = mix(gl_FragColor.rgb, matcapColor, uMatcapMix);`);
};
```

### Pattern 3: Haze impostor billboard quad (custom ShaderMaterial, not onBeforeCompile)

**What:** Per-instance camera-facing billboarding computed entirely in the vertex shader (zero CPU-side per-frame matrix updates for 2000+ instances) by discarding the instance's rotation component and re-deriving a camera-facing basis from the view matrix, exactly as the domain research's cited Ben Golus article describes. Fragment shader does the radial `smoothstep` falloff and an `alphaTest` discard (not additive blending) so overlapping instances still occlude correctly via the depth buffer without needing a sort — solving both the depthWrite:true hard-edge problem and the bloom-threshold-stacking risk noted in the Summary.

**When to use:** The haze `InstancedMesh` geometry + material swap (`graph.js:381-510`, `buildHazeLayer`).

**Example:**
```glsl
// Vertex: billboard by rebuilding a camera-facing basis, keeping the instance's
// position/scale from instanceMatrix but discarding its rotation.
#include <begin_vertex>
vec3 instancePos = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
float instanceScale = length(instanceMatrix[0].xyz); // uniform scale assumption (haze radius)
vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
vec3 billboardPos = instancePos + (camRight * position.x + camUp * position.y) * instanceScale;
gl_Position = projectionMatrix * viewMatrix * vec4(billboardPos, 1.0);

// Fragment: radial falloff + alphaTest discard (no sort, correct depth occlusion,
// no additive luminance-stacking risk against the LOCKED 0.72 bloom threshold)
float dist = length(vUv - 0.5) * 2.0;
float alpha = smoothstep(1.0, 0.0, dist) * hazeOpacity;
if (alpha < ALPHA_TEST_THRESHOLD) discard;
gl_FragColor = vec4(instanceColor, alpha);
```

### Anti-Patterns to Avoid

- **Calling `Graph.cameraPosition(pos, lookAt, ms)` with a nonzero `ms` from more than one call site per frame-window** — this re-enters the internal TWEEN group and will visibly fight a `registerTick`-driven damp system (two competing animators writing `camera.position` in the same frame). Once D-05 lands, every call site should use `ms=0` (or omit it) and let the new damp system own all motion.
- **Additive blending on the haze impostor quads** — reads as "correct" in isolation and matches the domain research's "no sort needed" framing, but risks crossing the LOCKED 0.72 bloom threshold in dense overlapping clusters. Use `alphaTest` discard + normal blending instead (same "no sort needed" property, no stacking risk).
- **Extending the haze `InstancedMesh`'s `onBeforeCompile` for matcap** — haze never gets matcap per D-10; don't add unused uniform plumbing to a program that's already structurally distinct (`USE_INSTANCING`).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SDF text atlas generation for in-scene labels | A hand-rolled canvas-texture-per-label or manual glyph-triangulation SDF generator | `troika-three-text` (vendored) | SDF atlas generation, glyph packing, bidi text segmentation, and worker-offloaded typesetting are exactly the kind of multi-week edge-case-riddled subsystem this table exists for — the domain research already reached this conclusion; this phase's job is vendoring it correctly, not re-deriving it |
| Frame-rate-independent damping math | A hand-rolled exponential-decay formula reinvented per call site | `THREE.MathUtils.damp(x, y, lambda, dt)` — confirmed present in the vendored `three.core.js` (r171, `function damp(x, y, lambda, dt)` at the source level) | Already vendored, already used elsewhere in the three.js ecosystem convention the domain research cites (`maath/easing.damp`); no reason to hand-roll an equivalent 3-line function when the exact primitive is already available in the vendored bundle |

**Key insight:** Both of this phase's "don't hand-roll" items are already either vendored (damp) or about to be vendored (troika) — the discipline here is resisting the temptation to write a "simpler" substitute for either once the vendoring friction (import-map entries, the CDN-fallback patch below) becomes visible during implementation.

## Common Pitfalls

### Pitfall 1: troika-three-text's hidden CDN fallback survives a naive "just vendor it" approach

**What goes wrong:** Even after vendoring `troika-three-text` and its 4 dependencies with zero import-time network calls, the library still reaches out to `https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/...` at **render time**, silently, the first time any rendered character isn't already covered by glyphs loaded from the explicitly-specified `font` prop.

**Why it happens:** `troika-three-text`'s `createFontResolver` marks any character not yet resolved by the primary font as `NEEDS_FALLBACK` and calls `unicodeFontResolverClient.getFontsForString(...)`, which by default fetches JSON metadata from the jsDelivr CDN (verified by extracting and reading `troika-three-text.esm.js`: the constant `v = "https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data"` is the hardcoded default, and the config option `unicodeFontsURL` only changes the *first* URL tried — on a fetch failure from a custom URL, the code explicitly falls back to retrying the real default CDN (`if (l !== v) { l = v; ... retry }`), so pointing it at a broken local path does not prevent the network call, it just delays it by one failed request.

**How to avoid:** Since the vendored copy is a plain static ESM file already living in the repo (not an npm-managed black box), patch it directly — following the exact convention this codebase already uses for `.replace()`-based shader patching (`onBeforeCompile`). The safest, simplest patch: replace the body of the exported `unicodeFontResolverClientFactory`'s returned `getFontsForString` (or the `resolveFallbacks()` call site) with a no-op that resolves immediately using only the primary font (worst case: a genuinely uncovered glyph renders as tofu/blank, never a network call). Because schema names are engine-derived text (predominantly ASCII/Latin), this has effectively zero visible cost in practice. Document the patch inline with a comment matching the existing "if a three.js chunk name ever changes, the `.replace()` is a silent no-op" style already used for the rim injection.

**Warning signs:** A stray network request to `cdn.jsdelivr.net` visible in DevTools' Network tab the first time a label containing an unusual character renders; this would be a T-10-10 violation and should be caught during the Stage-1 checkpoint if the electron/browser devtools network panel is checked once with labels visible.

### Pitfall 2: `depthWrite: true` + translucent radial-falloff quads = hard rectangular occlusion artifacts

**What goes wrong:** The existing haze material keeps `depthWrite: true` (matches the individual node material, so haze correctly occludes nodes behind it and vice versa). A naive port of "translucent quad with soft alpha falloff" to the same `depthWrite: true` setting means every fragment — including the ones near-zero alpha at the quad's corners — still writes to the depth buffer, producing a hard rectangular silhouette baked into the depth buffer even though the visible color fades to nothing. Anything rendered afterward that should be visible "through" the faded corner gets incorrectly depth-occluded by an invisible rectangle.

**Why it happens:** WebGL's depth test/write is per-fragment and doesn't know about your fragment shader's alpha value unless you tell it to (`alphaTest`/`discard`).

**How to avoid:** Add an `alphaTest`-style `discard` in the fragment shader for any fragment below a small alpha threshold, before the depth write happens. This is exactly the standard "alpha-tested billboard" technique and preserves `depthWrite: true`'s correct mutual-occlusion behavior between haze instances (and between haze and everything else) with zero sorting required — matching the domain research's "no sort needed" framing through a different (safer) mechanism than additive blending.

### Pitfall 3: The hull's `depthWrite: false` means it cannot occlude anything, including labels — this is by design, not a bug to fix

**What goes wrong (if misunderstood):** D-03 says label rendering uses `depthTest: true` so "hull/nodes occlude naturally." A planner reading `effects.js` will notice the hull's `ShaderMaterial` has `depthWrite: false` (intentional — `T-15-OCCLUDE`, so the hull glow never masks nodes behind it) and might conclude this is a contradiction requiring a fix.

**Why it happens:** It isn't a bug. The hull was never meant to occlude anything — its entire rendering philosophy (translucent Fresnel-lit glass shell, additive rim only) means nodes (and now labels) are *always* meant to show through it, by design, exactly like nodes already do today. `depthTest: true` on labels will correctly get occluded by **opaque node meshes** (which do write depth) exactly the same way nodes occlude each other; it will simply never be occluded by the hull itself, consistent with how the scene already renders.

**How to avoid:** No code change needed here — just don't spend a task "fixing" this. Verify at the Stage-1 checkpoint that labels behind the far side of the node cloud (but in front of/behind the translucent hull) look visually correct — i.e., consistent with how nodes on the far side already look today.

### Pitfall 4: Migrating camera call sites to `ms=0` changes existing tween-derived visual behavior subtly

**What goes wrong:** The vendored `3d-force-graph.min.js` accessor tweens `lookAt` at `ms/3` — three times faster than `position` — when a nonzero `ms` is passed. This is an intentional-looking design choice in the library (the camera "settles its gaze" on the target quickly, then continues drifting into final position) that the *existing* `recenter`/`focusCamera`/`transition` calls all currently benefit from, invisibly. Once camera moves are driven by a from-scratch damp system (`ms=0` every frame with independently-damped position and lookAt), this "lookAt settles 3x faster" behavior disappears unless the new system deliberately reproduces it (e.g., a higher damp lambda for lookAt than for position).

**Why it happens:** The old and new systems have genuinely different underlying math (tween-to-endpoint-over-fixed-duration vs. continuously-retargetable exponential decay); matching the *feel* requires an explicit choice, not an automatic carry-over.

**How to avoid:** When tuning D-06's orbit-then-dolly timings at the Stage-2 checkpoint, consider giving the lookAt/target damp lambda a measurably higher value than the position damp lambda (the "gaze settles before the body catches up" effect the old code had). Flag this explicitly for founder feedback rather than silently reproducing or silently dropping it.

## Code Examples

### Existing camera call sites that migrate to the D-05 damped system

| File:Line | Current call | What it currently does |
|-----------|---------------|-------------------------|
| `graph.js:810` (compact) / `:812` (full) | `Graph.cameraPosition({...}, {...}, ms)` inside `recenter(ms=700)` | Home/recenter framing, called at boot with `ms=0` (unaffected — already synchronous) and from `#btn-recenter` with the default 700ms tween |
| `detail.js:409` | `ctx.Graph.cameraPosition({x: x+220, y: y+80, z: z+220}, {x,y,z}, 800)` inside `focusCamera(node)` | Node-focus flight — the exact call D-06's orbit-then-dolly replaces |
| `transition.js:48` | `ctx.Graph.cameraPosition({x: p.x*PULL_K, ...}, {x:0,y:0,z:0}, DUR)` inside `pullBackCamera()` | Brain-recede pull-back at transition start |
| `transition.js:54` | `ctx.Graph.cameraPosition({x: homeCam.x, ...}, {x:0,y:0,z:0}, DUR)` inside `diveCamera()` | Brain-return dive on transition close |

All four are candidates for D-08/D-05's re-drive; none require touching `transition.js`'s crossfade/DOM logic (opacity fades, `markActive` calls, the 4 baked-in lessons) — only the two `ctx.Graph.cameraPosition(...)` calls inside `pullBackCamera`/`diveCamera` change to `ctx.setCameraTarget(...)` calls into the new damped system.

### `THREE.MathUtils.damp` signature (verified in vendored source)

```js
// Source: src/viz/vendor/three.core.js:372 (r171, vendored — not CDN, not training-data guess)
function damp( x, y, lambda, dt ) {
	return MathUtils.lerp( x, y, 1 - Math.exp( - lambda * dt ) );
}
```
Confirms the exact signature the domain research cites (`THREE.MathUtils.damp(current, target, lambda, dt)`) is present and usable with zero additional vendoring — `MathUtils` is already exported from the vendored `three.core.js`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Snap-scale hover (`HOVER_SCALE = 1.8`, instant set) | `THREE.MathUtils.damp`-driven scale with asymmetric overshoot-in/no-overshoot-out | This phase (D-05 discretion) | Frame-rate-independent across the 24↔60fps idle/active tier swing — a fixed-duration tween would visibly change speed across tiers, which `damp` avoids by construction |
| Single-tween node-focus flight (`cameraPosition(pos, lookAt, 800)`) | Orbit-then-dolly with anticipation pull-back (D-06) | This phase | Matches the "Linear-grade feel" bar the domain research identified; the old single tween is functionally identical to what most "AI-generated three.js" output ships |
| No in-scene labels | Vendored troika-three-text SDF labels on top-N schemas | This phase (D-01) | Closes the one gap the domain research identified as the highest-impact remaining "premium bar" item after haze/matcap |

**Deprecated/outdated:** Nothing in this phase deprecates an existing locked system — it extends the Phase-57 palette/motion-profile discipline into interaction/camera territory, exactly as scoped.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | JetBrains Mono (vs. IBM Plex Mono) is the better pick for the vendored SDF font | Standard Stack | Low — both are OFL-1.1, both satisfy D-04's "open-licensed humanist mono" constraint; this is explicitly Claude's Discretion in CONTEXT.md, not a locked decision, so no confirmation needed before proceeding |
| A2 | Patching the vendored `troika-three-text.esm.js` to no-op the unicode-fallback CDN call is the right fix (vs. attempting a config-only suppression) | Common Pitfalls / Pitfall 1 | Medium — this is my own synthesis from reading the actual vendored-candidate source, not a citation from an official troika doc; if wrong, the mitigation could be simpler (e.g., an as-yet-undiscovered `unicodeFontsURL: false` opt-out) or could require a different patch location. Verify by testing devtools Network tab during Stage-1 checkpoint regardless of which mitigation is chosen |
| A3 | `alphaTest` discard + non-additive blending fully replaces additive blending's "no sort needed" property for the haze impostor without a visible quality loss | Architecture Patterns / Common Pitfalls Pitfall 2 | Medium — sound graphics-engineering reasoning (standard alpha-tested billboard technique) but not yet prototyped against this specific hull/fog/bloom stack; if the visual result looks worse, additive blending with a hard per-quad max-alpha cap (low enough that N-fold overlap still stays under 0.72 threshold) is the fallback, at the cost of needing to calculate/verify that cap empirically |
| A4 | `Graph.cameraPosition(pos, lookAt, 0)` called every `registerTick` frame has no meaningful performance cost from the (`Object.assign` + `Vector3` allocation)-per-call overhead visible in the minified accessor | Architecture Patterns / Pattern 1 | Low — this accessor is already called at up to 60fps-equivalent frequency by 3d-force-graph's own internals for other purposes-adjacent code paths in similar libraries; if profiling during Stage-2 shows GC pressure, the fallback is reaching into `Graph.camera()`/`Graph.controls()` directly (bypassing the accessor's allocation, at the cost of needing to independently verify `controls.update()` is called correctly) |

## Open Questions

1. **Does troika-three-text's `useWorker: true` (default) typesetting introduce a visible one-frame pop-in for the first ~30 labels at boot?**
   - What we know: `getTextRenderInfo` is asynchronous by design (worker-offloaded); the domain research and D-03 already scope labels to "appear-on-approach" (distance-gated), which likely masks any boot-time pop-in since labels aren't visible until the camera approaches anyway.
   - What's unclear: whether the first-approach frame (crossing the distance threshold) shows a visible 1-frame "SDF texture not ready yet" flash for a schema the user approaches immediately at boot, before the worker has finished typesetting.
   - Recommendation: Cheap to pre-warm — call `Text.sync()` for all top-N labels immediately at boot (invisible, opacity 0, off the distance-fade path) rather than lazily on first approach; verify at Stage-1 checkpoint whether this is even a visible issue before adding pre-warming complexity.

2. **Exact haze raycast strategy after the geometry swap (invisible proxy spheres vs. relying on the existing proximity fallback) — explicitly Claude's Discretion, not resolved here.**
   - What we know: The existing proximity fallback (`graph.js:976-991`, 10px NDC nearest-node reprojection) is completely geometry-agnostic — it never raycasts the mesh at all, just reprojects `node.x/y/z` to screen space, so it works identically regardless of whether haze instances are spheres or camera-facing quads.
   - What's unclear: whether the *primary* exact raycast path (`hazeRay.intersectObject(ctx.hazeMesh, false)`) still needs to work correctly against billboarded quads, given that `THREE.Raycaster` tests the CPU-side `instanceMatrix` transform (which — per Pattern 3 — no longer encodes the true billboard-facing rotation, since that's now computed only in the vertex shader). A raycast against a non-billboarded quad transform could miss at oblique camera angles even where the visible billboard is squarely on-screen.
   - Recommendation: The simplest safe choice is to keep the *invisible raycast proxy* as `_sharedGeo` spheres (orientation-agnostic — a sphere's hit-test is identical regardless of instance rotation) in a separate, `visible: false` `InstancedMesh` sharing the same instance positions/scale, used only for raycasting; the visible billboarded quads never need to be raycast-accurate themselves. This adds one extra (invisible, cheap) `InstancedMesh` but sidesteps the whole oblique-angle correctness question. Final call is explicitly deferred to Claude's Discretion per CONTEXT.md.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| npm (for `npm pack`/`npm view`, dev-time only — not a runtime dependency) | Vendoring troika-three-text + transitive deps | ✓ | 11.8.0 | — |
| node | Running `scripts/gen-matcap.mjs` (D-09) and any build/copy scripts | ✓ | v25.5.0 | — |
| curl / network access | One-time download of the JetBrains Mono (or IBM Plex Mono) TTF release asset | ✓ | curl 8.7.1 | — |
| WebGL2 (browser/Electron runtime) | All rendering in this phase | Assumed ✓ (existing app already requires it) | — | — |

No missing dependencies. Nothing in this phase requires a runtime service, database, or external API beyond one-time, dev-time asset acquisition (npm packages + a font file), all of which get vendored into the repo before shipping — the running app itself makes zero new network calls once Pitfall 1's patch is applied.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 (`vitest run` via `npm test`) |
| Config file | none dedicated — vitest runs against the project's existing `tsconfig`/test glob; `tests/*.test.ts` is the convention |
| Quick run command | `npx vitest run tests/viz-activity-palette-invariants.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Decision | Behavior | Test Type | Automated Command | File Exists? |
|----------|----------|-----------|---------------------|--------------|
| D-15 | Label color stays in the D-02 luminance band and never amber-family | unit (source-parse invariant) | `npx vitest run tests/viz-activity-palette-invariants.test.ts` | ❌ Wave 0 — extend the existing file with a new `describe` block for the label slate color, mirroring the existing `IDENTITY_KEYS`/`relativeLuminance` pattern |
| D-15 | Matcap asset is grayscale-only (no hue baked into the PNG) | unit (script self-check) | New: `node scripts/gen-matcap.mjs --check` (mirrors `scripts/gen-simd-kernel.cjs --check`'s pattern) | ❌ Wave 0 — the matcap-generation script itself should assert its own output is R≈G≈B before writing, and a `--check` mode should re-verify the committed PNG |
| D-15 | LOCKED bloom/tone-mapping/motion-profile constants show no drift | unit (source-parse invariant) | `npx vitest run tests/viz-activity-palette-invariants.test.ts` | ✅ already covers `constants.js`'s exported values — no new test needed, only verify the phase doesn't touch any LOCKED export |
| D-05/D-06/D-16 (feel constants: camera timings, anticipation factor, matcap mix strength, dim/fog values) | Founder-tuned, explicitly UNLOCKED — no ratchet test per D-15 | manual-only (Stage 1/2 founder checkpoint) | — | N/A — D-15 explicitly excludes these from machine locks; screenshots/recordings are the verification record, matching the Phase-57 precedent |
| D-16 | fps at both tiers (overview idle ~24fps, focus interaction ~60fps) before/after | manual (existing overlay) | Press `S` in-app to toggle `stats.js`'s existing fps overlay; no new harness | ✅ already exists (`stats.js`'s hidden hotkey overlay) |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/viz-activity-palette-invariants.test.ts` (fast, targeted — this is the file every locked-constant guard in this phase extends)
- **Per wave merge:** `npm test` (full suite — catches any accidental regression in unrelated viz tests, e.g. `tests/viz-haze-activation.test.ts`, `tests/viz-haze-selection.test.ts`, `tests/viz-seed-determinism.test.ts`, `tests/viz-layout-guards.test.ts`, all of which touch code this phase modifies)
- **Phase gate:** Full suite green + both founder checkpoints (Stage 1 look, Stage 2 motion) signed off before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] Extend `tests/viz-activity-palette-invariants.test.ts` with a label-color luminance-band + non-amber assertion (D-15)
- [ ] `scripts/gen-matcap.mjs --check` mode asserting the committed matcap PNG is grayscale (R≈G≈B within tolerance) — new script, no existing equivalent
- [ ] Existing haze-related tests (`tests/viz-haze-activation.test.ts`, `tests/viz-haze-selection.test.ts`) mock `THREE.SphereGeometry` directly (see their `class SphereGeometry { constructor(...) {} }` stubs) — the haze geometry swap to camera-facing quads means these mocks may need a parallel `class PlaneGeometry`/custom-geometry stub added, or the tests may need re-scoping if they assert sphere-specific behavior. Read both files in full before the haze-impostor task starts.

## Security Domain

`security_enforcement` is absent from `.planning/config.json` (treated as enabled per default), but this phase has essentially no new attack surface: no new user input paths, no new network calls (once Pitfall 1's patch lands), no new DOM injection points beyond the existing `textContent`-only convention (`T-10-12`) this codebase already enforces everywhere.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Viz has no auth surface; unaffected by this phase |
| V3 Session Management | No | Unaffected |
| V4 Access Control | No | Unaffected |
| V5 Input Validation | Marginal | Schema label text comes from the existing `/graph` payload (already `textContent`-rendered elsewhere in `detail.js`/`search.js` per T-10-12); troika-three-text's `Text.text` prop must be set the same way — a plain string assignment, never any HTML-interpreting API — to preserve the existing XSS-safe discipline |
| V6 Cryptography | No | Unaffected |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| A vendored third-party library silently phoning home (troika's unicode-font-resolver CDN fallback) | Information Disclosure (of corpus label content, via query strings/paths, to a third-party CDN) | Patch the vendored source per Pitfall 1 — this is the one genuine, concrete security-relevant finding of this phase's research, not a generic checklist item |

## Sources

### Primary (HIGH confidence — read directly, not cited secondhand)

- `src/viz/modules/graph.js`, `transition.js`, `detail.js`, `search.js`, `lod.js`, `effects.js`, `constants.js`, `stats.js` — full read, live source, 2026-07-04
- `src/viz/vendor/three.core.js` — grepped for `REVISION`, `MathUtils`/`damp` export, confirming r171 and the exact `damp()` function body
- `src/viz/vendor/3d-force-graph.min.js` — grepped and decoded the minified `cameraPosition:function(...)` accessor body directly
- `src/viz/index.html` — import map structure (`"three": "./vendor/three.module.js"`)
- `scripts/copy-viz-assets.cjs`, `scripts/smooth-display-hull.py`, `scripts/gen-simd-kernel.cjs` — existing vendoring/offline-generation-script conventions
- `tests/viz-activity-palette-invariants.test.ts` — the exact invariants-test pattern D-15's new locks extend
- `tests/viz-haze-activation.test.ts` — existing `SphereGeometry` mock pattern relevant to the haze geometry swap
- npm registry (`npm view`, `npm pack`, `curl registry.npmjs.org`) — version, license, download counts, repo URLs, and actual extracted tarball contents for `troika-three-text@0.52.4`, `troika-three-utils@0.52.4`, `troika-worker-utils@0.52.0`, `webgl-sdf-generator@1.1.1`, `bidi-js@1.0.3` — all fetched and read in full, 2026-07-04

### Secondary (MEDIUM confidence)

- [github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt) — license confirmation for the D-04 vendored font pick, via WebSearch cross-referenced against the official repo

### Tertiary (LOW confidence, flagged in Assumptions Log)

- The troika unicode-fallback patch approach (A2) and the alphaTest-vs-additive haze blending call (A3) are this researcher's own synthesis from reading the vendored/downloaded source, not confirmed against an official troika-three-text issue/discussion thread or a shipped precedent in another three.js production app — flagged accordingly.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package version/license/dependency-chain fact was verified by actually downloading and reading the tarball contents, not just trusting `npm view` metadata
- Architecture: HIGH for the camera-accessor and damp-math findings (read directly from vendored source); MEDIUM for the haze shader/blending specifics (sound reasoning, not yet prototyped)
- Pitfalls: HIGH for Pitfall 1 (troika CDN fallback) and Pitfall 3 (hull depthWrite) — both verified by direct source reading; MEDIUM for Pitfall 2/4 (established graphics-engineering patterns, not yet tested against this exact stack)

**Research date:** 2026-07-04
**Valid until:** ~2026-08-04 (30 days) for codebase facts (stable, LOCKED constants don't change without a founder checkpoint); troika/npm ecosystem facts valid until the next `npm view` check — these are mature, slow-moving packages (oldest release cadence in the whole stack), so 30 days is conservative, not risky
