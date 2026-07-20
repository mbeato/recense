# Phase 58: Node Presentation & Motion Overhaul - Pattern Map

**Mapped:** 2026-07-04
**Files analyzed:** 11 (5 new, 6 modified)
**Analogs found:** 11 / 11 (all analogs are in-repo — this phase has no true "no analog" gaps;
every new file extends a directly adjacent existing module in the same flat `src/viz/modules/` layout)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/viz/modules/graph.js` (haze impostor swap, `:381-510`) | component (WebGL scene builder) | transform (per-instance GPU data build) | itself — `buildHazeLayer` (pre-change) | exact (modify-in-place) |
| `src/viz/modules/graph.js` (matcap mix injection, extends `:125-136`) | component (shader patch) | transform | itself — the existing rim `onBeforeCompile` | exact (modify-in-place) |
| `src/viz/modules/graph.js` (32-seg focus geometry, D-12) | component (shared geometry) | transform | `_sharedGeo` at `graph.js:37` | exact (sibling constant) |
| `src/viz/modules/graph.js` (damped hover, replaces `:588` snap) | component (interaction handler) | event-driven | `onNodeHover` callback (`graph.js:569-606`) | exact (modify-in-place) |
| `src/viz/modules/camera.js` (NEW) | provider (per-frame damped-target system) | streaming (rAF-driven) | `stats.js`'s `registerTick`/idle-drift system (`updateIdleDrift`, `:189-217`) | role-match (closest existing per-frame camera-driving code) |
| `src/viz/modules/labels.js` (NEW) | component (SDF text layer) | request-response (reads `/graph` payload, one-time build) | `search.js` (`initX(ctx)` module shape, DOM-adjacent rendering) + `effects.js` (vendored-addon import + scene-object lifecycle) | role-match (composite of two analogs) |
| `src/viz/modules/transition.js` (re-drive `pullBackCamera`/`diveCamera`) | controller (state machine) | event-driven | itself — pre-change `transition.js` | exact (modify-in-place) |
| `src/viz/modules/detail.js` (`focusCamera` → damped system, `:403-414`; dim tune `:150-165`) | controller (selection/focus logic) | event-driven | itself — pre-change `detail.js` | exact (modify-in-place) |
| `src/viz/modules/search.js` (`pick()` fly-to, `:93-100`) | controller (search-result dispatch) | request-response | itself — pre-change `search.js` | exact (modify-in-place, no direct camera call today — see note) |
| `src/viz/vendor/troika/*.esm.js` (NEW, vendored) | utility (vendored 3rd-party lib) | file-I/O (static asset) | `src/viz/vendor/addons/postprocessing/UnrealBloomPass.js` + `STLLoader.js` (existing vendored-addon convention) | exact |
| `scripts/gen-matcap.mjs` (NEW) | utility (offline asset-generation script) | batch | `scripts/gen-simd-kernel.cjs` (regenerable-derived-asset + `--check` mode convention) | exact |
| `tests/viz-activity-palette-invariants.test.ts` (extended) | test (invariants) | transform (source-parse assertions) | itself — existing D-02 luminance-band `describe` block | exact (modify-in-place) |

**Note on search.js:** `pick()` does not call `Graph.cameraPosition` directly today — it calls `ctx.selectNode(node)`, which internally calls `detail.js`'s `focusCamera(node)` (`detail.js:439`/`:525`). So D-05's migration of search fly-to is satisfied for free once `detail.js`'s `focusCamera` is migrated to `ctx.setCameraTarget(...)` — no `search.js` code change is actually required for the camera part. Flag this to the planner: `search.js` may need zero edits for D-05, contrary to CONTEXT.md's file list assumption.

## Pattern Assignments

### `src/viz/modules/graph.js` — haze impostor swap (`buildHazeLayer`, lines 392-535)

**Analog:** itself (pre-change) + Pattern 3 from RESEARCH.md's Architecture Patterns section

**Current material/geometry construction to replace** (`graph.js:424-450`):
```javascript
// Material — mirrors makeNodeObject's haze branch exactly
const hazeMat = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: HAZE_OPACITY * _hazeOpacityScale,
  depthWrite: true,
  vertexColors: false,
});

hazeMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRimV = normalize(cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz);\nvRimN = normalize(mat3(modelMatrix) * transformed);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
    .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nfloat _rim = pow(1.0 - abs(dot(normalize(vRimV), normalize(vRimN))), 2.0);\ngl_FragColor.rgb += _rim * 0.6 * mix(gl_FragColor.rgb, vec3(1.0), 0.3);');
};

const hazeMesh = new THREE.InstancedMesh(_sharedGeo, hazeMat, hazeCount);
```

**What stays unchanged (this is the load-bearing bookkeeping to preserve verbatim):**
- The whole per-instance loop (`graph.js:464-518`): Halton position sampling, `dummy.scale.setScalar(radius)`, `hazeMesh.setMatrixAt`, `hazeMesh.setColorAt`, `hazeInstanceMap`/`hazeNodeIdMap` population.
- `hazeMat._baseOpacity = hazeMat.opacity;` (`:525`) — `detail.js`'s `clearFocusDim` reads this.
- `ctx.hazeMesh`/`ctx.hazeMat` registration (`:528-529`).

**What changes:** swap `THREE.MeshBasicMaterial` (Fresnel-rim `onBeforeCompile`) for a new `THREE.ShaderMaterial` implementing Pattern 3's billboard-vertex + radial-falloff-fragment shader (RESEARCH.md lines 358-376), with `alphaTest` discard (not additive blending — see Pitfall 2) and `_sharedGeo` swapped for a new `THREE.PlaneGeometry(2, 2)` (or equivalent quad) shared instance analogous to `_sharedGeo`'s "one geometry, N instances" discipline (`graph.js:30-37` header comment).

**Raycast integration point to preserve** (`graph.js:964-996`, the proximity fallback): this code is geometry-agnostic (projects `node.x/y/z` to NDC, never touches the mesh) and needs zero changes. The primary exact raycast (`hazeRay.intersectObject(ctx.hazeMesh, false)`, `:965`) is the one at risk per Open Question 2 in RESEARCH.md — the recommended mitigation (invisible `visible:false` sphere `InstancedMesh` proxy sharing the same instance transforms) is a new sibling structure to `hazeMesh`, built in the same `buildHazeLayer` function, reusing `_sharedGeo` (spheres) exactly as today.

---

### `src/viz/modules/graph.js` — matcap mix (extends `onBeforeCompile`, lines 125-136)

**Analog:** the existing rim injection itself (single shared program, `makeNodeObject`)

**Exact seam to extend** (`graph.js:109-136`):
```javascript
const mat = new THREE.MeshBasicMaterial({
  color: baseColor.clone(),
  transparent: true,
  opacity: node.tombstoned ? 0.35
    : (node.__cat === 'haze' && !focusedHaze ? HAZE_OPACITY * _hazeOpacityScale : 0.88),
  depthWrite: true,
});

mat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRimV = normalize(cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz);\nvRimN = normalize(mat3(modelMatrix) * transformed);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
    .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nfloat _rim = pow(1.0 - abs(dot(normalize(vRimV), normalize(vRimN))), 2.0);\ngl_FragColor.rgb += _rim * 0.6 * mix(gl_FragColor.rgb, vec3(1.0), 0.3);');
};
```

**Extension pattern (Pattern 2 from RESEARCH.md, lines 324-349):** add `uMatcapTex`/`uMatcapMix` uniforms and a `vViewNormal` varying inside this SAME function body (do not create a second `onBeforeCompile` — the file's own header comment at `:117-124` explains why identical injected source is required for the one-shared-compiled-program property). Mirror the existing `.replace('#include <dithering_fragment>', ...)` insertion point, appending after the rim's `_rim` line rather than replacing it. Store the mix uniform on `mat.userData` (mirrors `node.__mat`/`node.__baseOp` tracking convention at `:142-148`) so the damped fade (D-11) can write to it per-frame from the new `camera.js`/hover-damp system.

**Constraint from RESEARCH.md Anti-Patterns (line 382):** never extend `hazeMat.onBeforeCompile` (the separate haze material, above) with matcap uniforms — haze never gets matcap per D-10, and it already compiles to a structurally distinct program (`USE_INSTANCING`).

---

### `src/viz/modules/graph.js` — 32-seg focus geometry (D-12)

**Analog:** `_sharedGeo` declaration itself (`graph.js:30-37`)
```javascript
// A unit sphere shared across ALL nodes; each node gets its own material and
// scales via mesh.scale.setScalar(radius). Reduces geometry objects from ~1500
// to exactly 1.
// 16×16 segments: smooth enough to read as a round orb (not a faceted gem) at
// rest and at HOVER_SCALE. Shared across all nodes, so this only raises vertex
// count, not draw calls — vertex throughput is not the bottleneck (bloom/fillrate is).
const _sharedGeo = new THREE.SphereGeometry(1, 16, 16);
```
**Pattern:** add a sibling `const _focusGeo = new THREE.SphereGeometry(1, 32, 32);` at module scope, same file, same comment discipline (explain why: focused nodes are large/close enough on screen that the 16-seg facet count becomes visible). Swap `mesh.geometry` (not the shared `_sharedGeo` reference) when a node enters focus, restore on deselect — follows the existing "swap material's opacity, not create a new mesh" idiom already used for hover scale (`:588`) and focus dim (`detail.js:156`).

---

### `src/viz/modules/graph.js` — damped hover (replaces the `HOVER_SCALE` snap, line 588)

**Analog:** the hover handler itself (`graph.js:569-589`)
```javascript
.onNodeHover(node  => {
  const tooltipEl = document.getElementById('tooltip');
  if (!tooltipEl) return;

  if (!node) {
    tooltipEl.style.display = 'none';
    if (ctx._hoveredNode && ctx._hoveredNode.__mesh) {
      ctx._hoveredNode.__mesh.scale.setScalar(ctx._hoveredNode.__baseR || 2);
    }
    ctx._hoveredNode = null;
    return;
  }
  // Reset previously hovered scale
  if (ctx._hoveredNode && ctx._hoveredNode !== node && ctx._hoveredNode.__mesh) {
    ctx._hoveredNode.__mesh.scale.setScalar(ctx._hoveredNode.__baseR || 2);
  }
  ctx._hoveredNode = node;
  if (node.__mesh && node.__baseR) {
    node.__mesh.scale.setScalar(node.__baseR * HOVER_SCALE);
  }
  // ...tooltip content unchanged...
})
```
**Pattern:** replace the two `setScalar(... * HOVER_SCALE)` / `setScalar(baseR)` snap-writes with a target-scale variable (`node.__hoverTarget = HOVER_SCALE` or `1`) written on hover-enter/leave; the actual `mesh.scale.setScalar(...)` write moves into a new `ctx.registerTick` callback that reads `THREE.MathUtils.damp(currentScale, node.__hoverTarget * baseR, HOVER_LAMBDA, dt)` per hovered/un-hovering node — mirrors `stats.js`'s `updateIdleDrift` shape (own `registerTick` callback, own damp-relevant state, `:196-217`) but applied to node scale instead of camera position. Asymmetric overshoot-in/no-overshoot-out (D-06 discretion) needs a small state machine (e.g. two different lambdas or a one-shot overshoot-then-settle) — not present in any existing pattern, net-new ~15-line logic per D-05's own estimate.

---

### `src/viz/modules/camera.js` (NEW) — unified damped camera system

**Analog:** `stats.js`'s `registerTick`-resident idle-drift system (closest existing "per-frame camera math" precedent)
```javascript
// stats.js:189-217 — the closest existing analog for camera.js's shape:
// a registerTick callback that reads ctx.Graph.camera()/controls(), computes a
// delta from `now`, and writes camera.position/lookAt every frame.
const IDLE_ORBIT_RAD_PER_SEC = 0.08;
let lastDriftNow = null;
function updateIdleDrift(now) {
  if (!ctx.isIdle()) { lastDriftNow = null; return; }
  const cam = ctx.Graph && typeof ctx.Graph.camera === 'function' ? ctx.Graph.camera() : null;
  if (!cam) return;
  if (lastDriftNow === null) { lastDriftNow = now; return; }
  const dt = Math.min(0.1, (now - lastDriftNow) / 1000);
  lastDriftNow = now;
  // ...rotate cam.position around controls.target, cam.lookAt(target)...
}
```
**Pattern to build (RESEARCH.md Pattern 1, lines 293-316):** module-scoped `targetPos`/`targetLookAt`, a `setCameraTarget(pos, lookAt)` export, and a `ctx.registerTick` callback that reads `ctx.Graph.cameraPosition()` (no-arg = read current), damps toward the target with `THREE.MathUtils.damp`, and writes back via `ctx.Graph.cameraPosition(dampedPos, dampedLookAt, 0)` (verified synchronous branch — RESEARCH.md Finding 2). Register in `app.js`'s init chain (see Shared Patterns below) — a new `initCamera(ctx)` call, positioned after `initGraph` (needs `ctx.Graph`) and before `initDetail`/`initTransition` (they call `ctx.setCameraTarget`).

**Must coexist with `stats.js`'s idle drift** (Integration Points, CONTEXT.md line 213-215): idle drift directly mutates `cam.position`/`cam.lookAt()` outside the damped system. `ctx.markActive()` already suppresses idle drift (`stats.js:56-61`); the new damped camera system should call `ctx.markActive()` at the start of every retarget (mirrors `transition.js`'s lesson 2, `markActive()` before each camera move) so the two systems never fight in the same frame — same discipline `transition.js` already documents.

---

### `src/viz/modules/labels.js` (NEW) — SDF schema labels

**Analog 1 (module shape):** `search.js`'s `initX(ctx)` convention
```javascript
// search.js:35 — the initX(ctx) module convention labels.js should mirror:
export function initSearch(ctx) {
  // ...builds DOM elements, reads ctx.allNodes / ctx.selectNode, no return value;
  // sets fields on ctx for other modules to call...
}
```
**Analog 2 (vendored-addon import + scene lifecycle):** `effects.js`'s header + import block
```javascript
// effects.js:1-22 — the vendored-import + Design-refs/Threat-mitigations JSDoc
// convention labels.js's header should follow:
/**
 * @module effects
 * recense viz — cinematic effects: Fresnel rim-lit glass hull + UnrealBloomPass + idle shimmer.
 * ...
 * Threat mitigations:
 *   T-10-10  imports only '../vendor/addons/...' and 'three' — no CDN
 */
import { STLLoader } from '../vendor/STLLoader.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
```
**Pattern:** `labels.js` imports `Text` from `../vendor/troika/troika-three-text.esm.js` (mirrors the `../vendor/addons/...` relative-path convention above), builds one `Text` mesh per top-N schema node (member counts read from `ctx.allNodes` — already-loaded `/graph` payload data, no new fetch per Architectural Responsibility Map), sets `depthTest: true`/distance-fade per D-03, and registers a `ctx.registerTick` callback for the appear-on-approach distance check (same `registerTick` home as everything else in this phase). Text content must be set via the plain string prop (`textObj.text = node.value`), never any HTML-interpreting API — mirrors the existing `textContent`-only discipline already enforced in `graph.js:594` (`tooltipEl.textContent = ...`) and `detail.js`'s panel rendering (T-10-12).

**Vendoring convention to follow exactly:** `scripts/copy-viz-assets.cjs`'s `assets = ['index.html', 'vendor', 'css', 'modules']` already recursively copies the whole `vendor/` tree — no build-script change needed, only adding files under `src/viz/vendor/troika/` and one import-map entry per package in `index.html`'s existing block:
```html
<!-- index.html:9-13 (current state — only 'three' mapped) -->
<script type="importmap">
{
  "imports": {
    "three": "./vendor/three.module.js"
  }
}
```

---

### `src/viz/modules/transition.js` — re-drive through the damped system (D-08)

**Analog:** itself, pre-change (full file read — 120 lines)

**Exact two call sites that change** (`transition.js:43-58`):
```javascript
function pullBackCamera() {
  if (!canCam()) return;
  const p = ctx.Graph.cameraPosition();
  if (!p) return;
  homeCam = { x: p.x, y: p.y, z: p.z }; // lesson 1: exact home, restored verbatim
  ctx.Graph.cameraPosition(
    { x: p.x * PULL_K, y: p.y * PULL_K, z: p.z * PULL_K }, { x: 0, y: 0, z: 0 }, DUR,
  );
}
function diveCamera() {
  if (canCam() && homeCam) {
    ctx.Graph.cameraPosition({ x: homeCam.x, y: homeCam.y, z: homeCam.z }, { x: 0, y: 0, z: 0 }, DUR);
  } else if (typeof ctx.recenter === 'function') {
    ctx.recenter(DUR);
  }
}
```
**Pattern:** replace the two `ctx.Graph.cameraPosition(pos, lookAt, DUR)` calls with `ctx.setCameraTarget(pos, lookAt)` (the new `camera.js` export). Everything else in the file — `homeCam` capture (lesson 1), `markActive()` calls (lesson 2), `fadeBrain`'s opacity-only CSS transition (lesson 3), the `onBeforeReveal`-before-reveal sequencing (lesson 4) — is explicitly OUT of scope per D-08 and must not be touched. The file's own header docblock (`:11-19`) is the authoritative list of the 4 lessons; the planner/implementer should re-read it verbatim before editing, not paraphrase from this pattern doc.

---

### `src/viz/modules/detail.js` — `focusCamera` migration (D-06) + focus-dim tune (D-07)

**Analog:** itself, pre-change

**`focusCamera`, exact current body** (`detail.js:402-414`):
```javascript
/** Gently move the camera to frame the selected node (D-15, smooth not a jump). */
function focusCamera(node) {
  if (!ctx.Graph || typeof ctx.Graph.cameraPosition !== 'function') return;
  const x = node.x || 0;
  const y = node.y || 0;
  const z = node.z || 0;
  // Offset camera ~280 units from the node (visible without too much zoom)
  ctx.Graph.cameraPosition(
    { x: x + 220, y: y + 80, z: z + 220 },
    { x, y, z },
    800  // 800ms smooth transition
  );
}
```
**Pattern:** this single call site is the D-06 orbit-then-dolly implementation point. Replace the one `ctx.Graph.cameraPosition(...)` call with a small sequenced series of `ctx.setCameraTarget(...)` calls (pull-back target → orbit target → dolly-in target), each phase's duration driven by the new damped system's lambda rather than the old `800`ms literal. Guard clause (`if (!ctx.Graph...) return;`) and the offset-vector math (`x+220, y+80, z+220`) stay as the geometric basis for the dolly-in target.

**Focus-dim tune target** (`detail.js:150-165`, `FOCUS_DIM_OPACITY` at `:26`):
```javascript
const FOCUS_DIM_OPACITY = 0.05;
// ...
function applyFocusDim(node) {
  clearFocusDim();
  const keep = new Set([node.id]);
  for (const nb of getNeighbors(node)) keep.add(nb.id);
  for (const n of (ctx.allNodes || [])) {
    if (keep.has(n.id) || !n.__mat) continue;
    n.__mat.opacity = FOCUS_DIM_OPACITY;
    dimmedNodes.push(n);
  }
  if (ctx.hazeMat) {
    ctx.hazeMat.opacity = FOCUS_DIM_OPACITY;
    ctx._hazeDimmed = true;
  }
}
```
D-07 only tunes the `FOCUS_DIM_OPACITY` named constant (move it to `constants.js` alongside the other named-constant discipline, see Shared Patterns) plus a new fog near-plane constant applied to `Graph.scene().fog` (see `graph.js:690` below) — the `applyFocusDim`/`clearFocusDim` bookkeeping logic itself is unchanged.

---

### `src/viz/modules/graph.js` — fog near-plane (D-07 second half)

**Analog:** the existing fog setup (`graph.js:684-690`)
```javascript
// ...Linear fog matched to the background fades the... crisp (the flat-starfield tell).
// Node MeshBasicMaterial fogs by default; the hull's Fresnel shader and the trace
// wavefront shader don't sample fog, so the shell and active pathways stay crisp.
Graph.scene().fog = new THREE.Fog(BG_COLOR, BRAIN_SCALE * 1.8, BRAIN_SCALE * 4.2);
```
**Pattern:** D-07's fog tightening means swapping the near-plane literal (`BRAIN_SCALE * 1.8`) to a smaller named constant only while focused (e.g. `ctx.fog.near = FOCUS_FOG_NEAR` on focus-enter, restore to `BRAIN_SCALE * 1.8` on deselect) — same "save + restore on deselect" idiom as `clearFocusDim`'s opacity restore (`detail.js:167-180`).

---

## Shared Patterns

### Named tunable constants — `constants.js` discipline

**Source:** `src/viz/modules/constants.js:205-230` (Sizing section) — section-header comment convention
```javascript
// ============================================================================
// Sizing
// ============================================================================

/** Max neighbour connections shown in the detail panel before "+ N more" */
export const MAX_FAN_OUT = 8;

/** 3d-force-graph nodeRelSize multiplier */
export const nodeRelSize = 4;

/** Node mesh scale factor while hovered */
export const HOVER_SCALE = 1.8;
```
**Apply to:** every new Phase-58 feel/geometry constant — `HOVER_LAMBDA`, `CAM_POS_LAMBDA`, `CAM_LOOKAT_LAMBDA` (deliberately higher per Pitfall 4), the D-06 phase timings (pull-back %, orbit ms, dolly ms), `MATCAP_MIX_LAMBDA`, `LABEL_TOP_N`, `LABEL_DISTANCE_THRESHOLD`, `FOCUS_FOG_NEAR`, `FOCUS_DIM_OPACITY` (moved from `detail.js:26` into this file to join the discipline). Each gets a one-line JSDoc comment in the same terse style, grouped under a new `// === Phase 58 ===`-style section header matching the existing `// === Adaptive density (Phase 19 Item 2) ===` precedent (`constants.js:232-234`).

### Invariants test file extension (D-15)

**Source:** `tests/viz-activity-palette-invariants.test.ts` — the `describe('D-02 luminance-band membership', ...)` block (lines 113-171) is the exact structural analog for the new label-color lock.
```typescript
// The parseConst/parseKindColorHex + relativeLuminance harness this file already
// has (lines 30-41, 86-90, 121-127, 156-161) is reused verbatim — no new harness code,
// only a new `describe` block + a new color-source parse (the label slate hex, likely
// a new constants.js export like LABEL_COLOR) run through the same relativeLuminance
// + Y_MIN/Y_MAX band check, plus a same-file "never amber-family" hue-distance assertion.
```
**Apply to:** the new D-15 label-color-band + non-amber test, and the matcap-grayscale self-check (separate file, `scripts/gen-matcap.mjs --check`, patterned after `scripts/gen-simd-kernel.cjs --check` below, not this test file).

### Offline regenerable-asset script (D-09 matcap)

**Source:** `scripts/gen-simd-kernel.cjs` (full header + `--check` mode convention, lines 1-24 read in full)
```javascript
#!/usr/bin/env node
/**
 * gen-simd-kernel — regenerate the committed WASM SIMD cosine kernel blob.
 *
 * STANDALONE MANUAL DEV COMMAND. ...
 * MUST NOT run at install or build time...
 *
 * Usage:
 *   node scripts/gen-simd-kernel.cjs           — regen the blob (writes file)
 *   node scripts/gen-simd-kernel.cjs --check   — verify committed blob matches ... (no write)
 */
'use strict';
const CHECK_MODE = process.argv.includes('--check');
```
**Apply to:** `scripts/gen-matcap.mjs` — same "manual dev command, not in postinstall/build, `--check` mode re-verifies the committed asset without writing" shape. `--check` mode should read the committed PNG and assert R≈G≈B per pixel (or a sampled subset) within tolerance, exiting non-zero on drift — mirrors `gen-simd-kernel.cjs --check`'s "compare freshly-derived output against committed blob" self-test pattern (its lines 52+, not fully quoted here as the byte-comparison specifics don't transfer to a grayscale-tolerance check).

### Vendored 3rd-party library convention (T-10-10)

**Source:** `src/viz/modules/effects.js:21-23` (import block) + `scripts/copy-viz-assets.cjs` (copy step) + `index.html:9-13` (import map)
```javascript
import { STLLoader } from '../vendor/STLLoader.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
```
**Apply to:** all troika imports across `labels.js` — same `../vendor/<name>.esm.js` relative-import shape, no bare-specifier `import 'troika-three-text'` (that would require the import-map entry, which is also fine per RESEARCH.md's stated approach — either relative-path-direct or import-map-mediated is consistent with this codebase's existing "three" import-map precedent). The `gen-simd-kernel.cjs` docblock's "MUST NOT run at install/build time" T-10-10 framing also applies to the one-time `npm pack`/extract vendoring step for troika — it is a dev-time-only action, never a build or postinstall script.

### `registerTick` as the home for all new per-frame math (D-05, hover damp, matcap fade)

**Source:** `stats.js:42-45` (the registry itself) + `stats.js:189-217` (`updateIdleDrift`, the closest existing per-frame-camera-math consumer)
```javascript
const callbacks = [];
ctx.registerTick = fn => { callbacks.push(fn); };
```
**Apply to:** `camera.js`'s damped-target tick, the hover-scale damp tick (in `graph.js` or a new small block), and the matcap mix-factor damp tick (in `graph.js`'s selection logic, reading the `mat.userData` uniform stored per Pattern 2 above). All three register via this exact one-line API — no new tick infrastructure needed.

## No Analog Found

None. Every file in this phase's scope either modifies an existing file in place or is a new file that closely mirrors an existing sibling module's shape (`initX(ctx)` convention, vendored-addon import convention, or offline-script convention). The one soft gap is `camera.js`'s exact internal shape (a brand-new small module) — RESEARCH.md's own Pattern 1 code example (already vendored/verified against the real `3d-force-graph.min.js` source) substitutes for a codebase analog here, since no prior "unified damped camera" module exists to copy from; `stats.js`'s idle-drift tick is the closest structural precedent and is cited above.

## Metadata

**Analog search scope:** `src/viz/modules/*.js`, `src/viz/vendor/**`, `scripts/*.{cjs,py}`, `tests/viz-*.test.ts`, `src/viz/index.html`
**Files scanned:** `graph.js` (1093 lines, 3 targeted reads), `transition.js` (120 lines, full read), `detail.js` (638 lines, 2 targeted reads), `search.js` (188 lines, 1 targeted read), `stats.js` (290 lines, full read), `lod.js` (grepped), `effects.js` (grepped + 40-line read), `constants.js` (grepped + 35-line read), `app.js` (grepped, init-order), `index.js` (grepped), `tests/viz-activity-palette-invariants.test.ts` (254 lines, full read), `tests/viz-haze-activation.test.ts` / `viz-haze-selection.test.ts` (grepped for `SphereGeometry` mock, per RESEARCH.md's Wave-0-gap flag), `scripts/gen-simd-kernel.cjs` (60-line read), `scripts/copy-viz-assets.cjs` (full read), `src/viz/index.html` (grepped, import map)
**Pattern extraction date:** 2026-07-04
