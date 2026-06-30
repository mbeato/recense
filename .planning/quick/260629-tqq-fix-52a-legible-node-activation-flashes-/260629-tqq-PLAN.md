---
quick_id: 260629-tqq
type: quick
slug: fix-52a-legible-node-activation-flashes
files_modified:
  - src/viz/modules/trace.js
must_haves:
  truths:
    - "A trace activation on a haze (InstancedMesh) node — recall seed, new_node, oscillation, reconsolidation — produces a prominent, kind-colored, bloom-catching visual at the node, legible at the default overview zoom (not only when zoomed in)"
    - "The reconsolidation magenta hero flash on a hub node is clearly visible at overview zoom"
    - "Zero change to activation_trace writes, kind mapping, choreography timing, or recall honesty; all Phase 52 tests stay green"
  artifacts:
    - path: "src/viz/modules/trace.js"
      provides: "additive node-flash halo spawned from activate(), updated + disposed in tick()"
      contains: "halo"
---

<objective>
Make node-activation flashes legible at overview zoom in `recense viz`. Phase 52's honest-traces
logic is correct, but on the ~2,700-node overview most nodes are **haze InstancedMesh instances**:
`activate(node, level, kindColor)` lights them via `setColorAt` color-tint only — no scale, no
additive bloom — which is imperceptible among thousands of points. By contrast `spawnPulse` edge
wavefronts (additive meshes in `ctx.pulseGroup`, caught by the bloom pass) ARE visible.

Reuse that proven-visible path: spawn a short-lived **additive halo mesh** at each trace-activated
node, kind-colored, brief grow→fade, following the node's live x/y/z each tick, disposed on expiry.

Presentation-only. Do NOT touch activation_trace writes, kind mapping, choreography timing, or the
recall honesty guarantees. Keep existing regular-mesh (scale+color) and haze (setColorAt) behavior
intact — the halo is purely additive on top.
</objective>

<tasks>

<task n="1">
  <name>Add additive node-flash halo to trace.js</name>
  <files>src/viz/modules/trace.js</files>
  <action>
    1. Add a module-level `halos` array (sibling to `pulses`) to track in-flight node halos.
    2. Build a shared halo geometry once at init (e.g. a small `THREE.SphereGeometry` or a
       billboarded plane) — analogous to the shared `_pulseGeo`. Do NOT allocate geometry per halo.
    3. In `activate(node, level, kindColor)`: after the existing `active.add(node)` bookkeeping,
       spawn a halo for this activation:
         - Create a `THREE.Mesh(_haloGeo, mat)` where `mat` is a per-halo additive ShaderMaterial
           (or MeshBasicMaterial with `blending: THREE.AdditiveBlending`, `transparent: true`,
           `depthWrite: false`), colored by `kindColor || HOT_COLOR`.
         - Add to `ctx.pulseGroup` (same group the visible wavefronts use, so it inherits the
           bloom pass). Guard `if (!ctx.pulseGroup) return;` like spawnPulse does.
         - Push `{ node, t0: performance.now(), level, mesh, mat }` to `halos`.
       Coalesce: if re-activating a node that already has a live halo, refresh its t0/level rather
       than stacking unbounded meshes (keeps the oscillation 3x-strobe and rapid recalls bounded).
    4. In `tick(now)`: add a loop (mirroring the `pulses` loop) that for each halo:
         - Samples the node's live position (`node.x/y/z`, like the pulses loop does for from/to).
         - Positions the halo mesh there.
         - Drives a grow→fade envelope over a fixed lifetime (reuse WF_* or DECAY_* constants;
           a fast attack to a visible size/opacity, then ease-out fade). Scale must be a FIXED
           world size (not node radius) so it reads at overview zoom regardless of node size.
         - On expiry: `ctx.pulseGroup.remove(mesh)`, `mat.dispose()`, splice from `halos`.
       The tick must remain allocation-light per frame (reuse scratch vectors; no per-frame `new`).
    5. Sizing/intensity: tune so a single hub-node flash is clearly visible at the default overview
       zoom — the bloom pass should catch it. Magenta (`reconsolidation`) must read as the hero.
  </action>
  <verify>npx tsc --noEmit && npm test  (2,442 tests stay green; no new failures)</verify>
  <done>
    - trace.js spawns + ticks + disposes additive node halos; existing activate/spawnPulse/tick
      behavior otherwise unchanged.
    - tsc clean, full suite green.
    - No changes outside src/viz/modules/trace.js for the rendering fix (constants additions in
      constants.js are acceptable if a new size/lifetime constant is cleaner than a literal).
  </done>
</task>

</tasks>

<verification>
Build + full test suite green. Visual confirmation deferred to founder (separate) — the goal is that
a node activation now produces a prominent additive halo via the same bloom-caught path as the
already-visible edge wavefronts.
</verification>
