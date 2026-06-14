/**
 * @module graph
 * brain-memory viz — data render, in-brain seeding, ForceGraph3D init (shared
 * geometry, D-05), force tuning, brain containment via onEngineTick (NOT
 * d3Force setter — Spike 001 landmine), settle-then-pin reveal, and camera
 * framing.
 *
 * Sets on ctx: Graph, hullGroup, pulseGroup.
 * Reads from ctx (must be set before initGraph by app.js):
 *   THREE, ForceGraph3D, allNodes, idMap, adj, getVisibleNodes, getVisibleLinks,
 *   brainVol, nodeVisible, linkVis (set by lod.js which runs first),
 *   selectNode (set by detail.js — guarded lazily on click).
 */

import * as THREE from 'three';
import {
  TYPE_COLOR,
  TOMBSTONE_COLOR,
  BG_COLOR,
  BRAIN_SCALE,
  HULL_ROT_X,
  HULL_ROT_Y,
  HULL_ROT_Z,
  CONTAIN_STRENGTH,
  HOVER_SCALE,
  nodeRelSize,
} from './constants.js';

// ─── Shared geometry (D-05) ──────────────────────────────────────────────────
// A unit sphere shared across ALL nodes; each node gets its own material and
// scales via mesh.scale.setScalar(radius). Reduces geometry objects from ~1500
// to exactly 1.
// 16×16 segments: smooth enough to read as a round orb (not a faceted gem) at
// rest and at HOVER_SCALE. Shared across all nodes, so this only raises vertex
// count, not draw calls — vertex throughput is not the bottleneck (bloom/fillrate is).
const _sharedGeo = new THREE.SphereGeometry(1, 16, 16);

// Haze nodes (unclassified — not a schema, not yet a schema member) render as
// barely-there mist so the schema constellation reads at a glance, in BOTH
// viewports (founder 2026-06-13: align the full window to the tray to fight
// clutter as N grows). Compact stays at its founder-tuned 0.12; the full
// window sits a hair higher (0.16) since it's the exploration surface — and
// low opacity does NOT block raycasting, so hazed nodes stay clickable.
const COMPACT = Math.min(window.innerWidth, window.innerHeight) <= 500;
const HAZE_COMPACT_OPACITY = 0.12;
const HAZE_FULL_OPACITY = 0.16;
const HAZE_OPACITY = COMPACT ? HAZE_COMPACT_OPACITY : HAZE_FULL_OPACITY;

// Scratch vectors reused in the hot containment tick (avoids per-tick allocation)
const _q   = new THREE.Vector3();
const _inv = new THREE.Matrix4();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the display radius for a node based on its LOD category.
 * Schema super-nodes scale with member count to form visual anchors.
 */
function nodeRadius(node) {
  if (node.__cat === 'schema') return 3 + Math.sqrt(node.__members || 0) * 0.8;
  if (node.__cat === 'member') return 2.5;
  return 2; // haze
}

/**
 * Build (or reuse) the THREE.Mesh for a node.
 * Shared geometry + per-node material for independent color / opacity animation.
 * Annotates the node with __mesh, __mat, __base, __baseOp, __baseR, __act,
 * __actGain so trace.js can drive the activation animation.
 */
function makeNodeObject(node) {
  if (node.__mesh) return node.__mesh;

  const radius = nodeRadius(node);
  const baseColor = node.tombstoned
    ? new THREE.Color(TOMBSTONE_COLOR)
    : new THREE.Color(TYPE_COLOR[node.type] ?? TYPE_COLOR.fact);

  const mat = new THREE.MeshBasicMaterial({
    color: baseColor.clone(),
    transparent: true,
    opacity: node.tombstoned ? 0.35
      : (node.__cat === 'haze' ? HAZE_OPACITY : 0.88),
    depthWrite: true,
  });

  // Subtle self-colored Fresnel rim — gives each orb a little depth (reads as a lit
  // sphere, not a flat disc) in the project's existing rim language (the hull uses
  // the same effect). On-palette: it brightens the node's OWN colour at the
  // silhouette, never amber, so D-04 (no fake activation) holds. Cheap: no extra
  // geometry/draw calls; identical injected source means all nodes share ONE compiled
  // program. For a unit sphere centred at the origin the local position equals the
  // normal, so we avoid the (unlit) normal attribute MeshBasic may omit. If a three.js
  // chunk name ever changes, the .replace() is a silent no-op (rim absent, never broken).
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvRimV = normalize(cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz);\nvRimN = normalize(mat3(modelMatrix) * transformed);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\nfloat _rim = pow(1.0 - abs(dot(normalize(vRimV), normalize(vRimN))), 2.0);\ngl_FragColor.rgb += _rim * 0.6 * mix(gl_FragColor.rgb, vec3(1.0), 0.3);');
  };

  const mesh = new THREE.Mesh(_sharedGeo, mat);
  mesh.scale.setScalar(radius);

  // Annotations used by trace.js for activation animation
  node.__mesh    = mesh;
  node.__mat     = mat;
  node.__base    = baseColor;           // THREE.Color at rest for lerp
  node.__baseOp  = mat.opacity;         // opacity at rest
  node.__baseR   = radius;              // world radius (detail.js selection ring)
  node.__act     = 0;                   // activation level [0,1]
  node.__actGain = node.__cat === 'schema' ? 1.2 : 1.0; // schemas pulse brighter

  return mesh;
}

/**
 * Test whether a point in the hull's local coordinate space (normalised [-1,1]
 * cube) is inside the brain occupancy grid.
 */
function brainOccupied(brainVol, qx, qy, qz) {
  const R = brainVol.res;
  const ix = ((qx + 1) * 0.5 * R) | 0;
  const iy = ((qy + 1) * 0.5 * R) | 0;
  const iz = ((qz + 1) * 0.5 * R) | 0;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= R || iy >= R || iz >= R) return false;
  const i = (iz * R + iy) * R + ix;
  return !!((brainVol.bits[i >> 3] >> (i & 7)) & 1);
}

/**
 * Seed all node positions inside the brain occupancy volume before the layout
 * simulation starts. Nodes begin inside the hull so the containment force has
 * less correction to do and the simulation converges faster.
 */
function seedNodePositions(allNodes, brainVol) {
  if (!brainVol) {
    // Fallback: random scatter in a sphere of radius BRAIN_SCALE * 0.6
    for (const n of allNodes) {
      const r     = BRAIN_SCALE * 0.6 * Math.cbrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      n.x = r * Math.sin(phi) * Math.cos(theta);
      n.y = r * Math.sin(phi) * Math.sin(theta);
      n.z = r * Math.cos(phi);
    }
    return;
  }

  // Build a rotation matrix matching the hull group orientation so sampled
  // occupancy-grid points map to the same world space as the hull mesh.
  const euler  = new THREE.Euler(HULL_ROT_X, HULL_ROT_Y, HULL_ROT_Z);
  const rotMat = new THREE.Matrix4().makeRotationFromEuler(euler);

  const R    = brainVol.res;
  const bits = brainVol.bits;

  // Collect occupied voxel centres (normalised to [-1,1] cube)
  const occupied = [];
  for (let iz = 0; iz < R; iz++) {
    for (let iy = 0; iy < R; iy++) {
      for (let ix = 0; ix < R; ix++) {
        const idx = (iz * R + iy) * R + ix;
        if (!((bits[idx >> 3] >> (idx & 7)) & 1)) continue;
        occupied.push([
          (ix / R) * 2 - 1,
          (iy / R) * 2 - 1,
          (iz / R) * 2 - 1,
        ]);
      }
    }
  }

  if (!occupied.length) { seedNodePositions(allNodes, null); return; }

  const v = new THREE.Vector3();
  for (const n of allNodes) {
    const [lx, ly, lz] = occupied[(Math.random() * occupied.length) | 0];
    v.set(lx, ly, lz)
     .applyMatrix4(rotMat)
     .multiplyScalar(BRAIN_SCALE);
    // Small jitter so co-located voxels diverge
    n.x = v.x + (Math.random() - 0.5) * 4;
    n.y = v.y + (Math.random() - 0.5) * 4;
    n.z = v.z + (Math.random() - 0.5) * 4;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialise the ForceGraph3D instance and wire all rendering, containment,
 * and reveal behaviour onto ctx.
 *
 * Call order (enforced by app.js, Plan 07):
 *   initLod(ctx)   → sets ctx.nodeVisible, ctx.linkVis, ctx.expanded, …
 *   initGraph(ctx) → sets ctx.Graph, ctx.hullGroup, ctx.pulseGroup
 *
 * @param {import('./constants.js').Ctx} ctx
 */
export function initGraph(ctx) {
  const { allNodes, getVisibleNodes, getVisibleLinks, brainVol } = ctx;

  // Seed positions so layout starts inside the brain volume
  seedNodePositions(allNodes, brainVol);

  // ── ForceGraph3D init ──────────────────────────────────────────────────
  // nodeVisibility / linkVisibility read ctx lazily so lod.js callbacks are
  // picked up even if initLod ran first and set them synchronously.
  const Graph = ctx.ForceGraph3D()(document.getElementById('graph'))
    .backgroundColor('#000000')
    .graphData({ nodes: getVisibleNodes(), links: getVisibleLinks() })
    .nodeRelSize(nodeRelSize)
    .nodeThreeObject(makeNodeObject)
    .nodeVisibility(n  => ctx.nodeVisible ? ctx.nodeVisible(n)  : true)
    .linkVisibility(l  => ctx.linkVis     ? ctx.linkVis(l)      : true)
    .linkColor(()      => 'rgba(125,112,122,0.30)')
    .linkWidth(0.8)
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

      // Tooltip text: textContent only — NEVER innerHTML with node data (T-10-12)
      tooltipEl.textContent    = (node.value || node.id || '').slice(0, 120);
      tooltipEl.style.display  = 'block';
    })
    .onNodeClick(node  => {
      if (!node) return;
      if (node.__cat === 'schema' && ctx.expanded) {
        // Re-click on the already-selected expanded schema: collapse + dismiss
        if (ctx.expanded.has(node.id) && ctx.selectedId === node.id) {
          ctx.expanded.delete(node.id);
          Graph.graphData({ nodes: getVisibleNodes(), links: getVisibleLinks() });
          if (ctx.refreshVisibility) ctx.refreshVisibility();
          if (ctx.closeDetail) ctx.closeDetail();
          return;
        }
        // Drill-in: reveal members, then fall through to the same select
        // treatment as every other node (panel + ripple + focus dim) so the
        // schema's constellation lights up instead of just appearing.
        if (!ctx.expanded.has(node.id)) {
          ctx.expanded.add(node.id);
          Graph.graphData({ nodes: getVisibleNodes(), links: getVisibleLinks() });
          if (ctx.refreshVisibility) ctx.refreshVisibility();
        }
      }
      // All nodes: open detail panel (detail.js sets ctx.selectNode)
      if (ctx.selectNode) ctx.selectNode(node);
    })
    .onBackgroundClick(() => {
      // Clicking empty space dismisses the focused node. Drags/orbits do not
      // trigger this — 3d-force-graph only fires it for true clicks.
      if (ctx.closeDetail) ctx.closeDetail();
    });

  ctx.Graph = Graph;

  // ── Scene groups ──────────────────────────────────────────────────────
  const hullGroup  = new THREE.Group();
  hullGroup.rotation.set(HULL_ROT_X, HULL_ROT_Y, HULL_ROT_Z);
  hullGroup.scale.setScalar(BRAIN_SCALE);   // normalized brain → world; matches containment
  const pulseGroup = new THREE.Group();
  // Background via scene.background, NOT .backgroundColor(): the latter sets the
  // renderer clear color, which three r152+ does not color-manage — the composer's
  // OutputPass then re-encodes it and the rendered background comes out one gamma
  // step lighter than authored (#060a0f rendered as a washed blue-gray). The
  // scene.background path is color-managed, so the authored hex is what renders.
  // .backgroundColor above stays pure black as a safe clear color underneath.
  Graph.scene().background = new THREE.Color(BG_COLOR);

  // Atmospheric depth: far nodes recede into the field instead of sitting equally
  // crisp (the flat-starfield tell). Linear fog matched to the background fades the
  // far side of the cloud into the aubergine; near side stays sharp. Near/far scale
  // with BRAIN_SCALE — widen them if it reads too hazy, tighten for more depth.
  // Node MeshBasicMaterial fogs by default; the hull's Fresnel shader and the trace
  // wavefront shader don't sample fog, so the shell and active pathways stay crisp.
  Graph.scene().fog = new THREE.Fog(BG_COLOR, BRAIN_SCALE * 1.8, BRAIN_SCALE * 4.2);

  // ── Stuck-drag guard (pinned tray window) ─────────────────────────────
  // If pointerup is lost (popover hidden mid-drag, drag ends outside the
  // frameless window), OrbitControls keeps tracking the pointer and rotates
  // on HOVER with no button held. Release: any pointer move with buttons===0
  // while a drag is tracked gets a synthetic pointercancel. Idle autoRotate
  // (stats.js) is camera-level and unaffected — rotation by hand needs a
  // real held button again.
  {
    const controlsEl = Graph.renderer().domElement;
    let activePointerId = null;
    controlsEl.addEventListener('pointerdown', (e) => { activePointerId = e.pointerId; });
    window.addEventListener('pointerup', () => { activePointerId = null; });
    const release = () => {
      if (activePointerId === null) return;
      controlsEl.dispatchEvent(new PointerEvent('pointercancel', { pointerId: activePointerId }));
      activePointerId = null;
    };
    window.addEventListener('pointermove', (e) => {
      if (activePointerId !== null && e.buttons === 0) release();
    });
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') release();
    });
  }

  Graph.scene().add(hullGroup);
  Graph.scene().add(pulseGroup);
  ctx.hullGroup  = hullGroup;
  ctx.pulseGroup = pulseGroup;

  // ── Force tuning ──────────────────────────────────────────────────────
  const chargeForce = Graph.d3Force('charge');
  if (chargeForce) chargeForce.strength(-15);
  const linkForce = Graph.d3Force('link');
  if (linkForce) linkForce.distance(l => l.kind === 'abstracts' ? 16 : 22);
  Graph.d3ReheatSimulation();

  // ── Brain containment via onEngineTick ────────────────────────────────
  // CRITICAL: do NOT pass a two-arg custom containment force to d3Force().
  // The two-arg setter re-registers forces in a way that nulls 3d-force-graph's
  // internal layout reference. The next tick throws:
  //   "Cannot read properties of undefined (reading 'tick')"
  // → canvas goes black. Always use onEngineTick for custom per-tick forces.
  // (Spike 001 landmine; see RESEARCH.md Pattern 7.)
  function brainContainment() {
    const nodes = Graph.graphData().nodes;
    if (!brainVol || !nodes.length) return;

    // Compute graph centroid
    let cx = 0, cy = 0, cz = 0;
    for (const n of nodes) { cx += n.x || 0; cy += n.y || 0; cz += n.z || 0; }
    cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;

    // Align hullGroup so the occupancy test is in hull-local space
    hullGroup.position.set(cx, cy, cz);
    hullGroup.updateMatrixWorld(true);
    _inv.copy(hullGroup.matrixWorld).invert();

    for (const n of nodes) {
      _q.set(n.x || 0, n.y || 0, n.z || 0).applyMatrix4(_inv);
      if (!brainOccupied(brainVol, _q.x, _q.y, _q.z)) {
        n.vx = (n.vx || 0) + (cx - (n.x || 0)) * CONTAIN_STRENGTH;
        n.vy = (n.vy || 0) + (cy - (n.y || 0)) * CONTAIN_STRENGTH;
        n.vz = (n.vz || 0) + (cz - (n.z || 0)) * CONTAIN_STRENGTH;
      }
    }
  }

  Graph.onEngineTick(brainContainment);

  // ── Settle-then-pin reveal ────────────────────────────────────────────
  // The canvas starts hidden (opacity 0). Once the simulation cools (or
  // 200 ms elapses — primary path since onEngineStop is unreliable/slow),
  // pin every node's fx/fy/fz at its settled position then fade in.
  Graph.cooldownTicks(12);
  const graphEl = document.getElementById('graph');
  graphEl.style.opacity = '0'; // hidden — no transition yet

  let _settled = false;
  function revealSettled() {
    if (_settled) return;
    _settled = true;
    for (const n of allNodes) {
      if (n.x != null) { n.fx = n.x; n.fy = n.y; n.fz = n.z; }
    }
    graphEl.style.transition = 'opacity 0.35s ease'; // fade IN only, never out
    graphEl.style.opacity    = '1';
  }

  Graph.onEngineStop(revealSettled);
  setTimeout(revealSettled, 200); // primary path (onEngineStop is unreliable/slow)

  // ── Camera framing ────────────────────────────────────────────────────
  // Compact viewports (tray popover ≤500px) sit slightly farther out so the
  // brain clears the frame; full-window framing unchanged (founder-tuned).
  // Compact also pans toward the brain's front (-x): the mesh's visual center
  // sits forward of the world origin, so an origin-locked camera crops the
  // frontal lobe at popover size. Passing lookAt also moves controls.target,
  // keeping the ambient idle rotation centered on the brain, not the origin.
  // recenter(ms) is the single framing source (quick-260612-v79): boot calls
  // recenter(0) for the instant founder-tuned framing; #btn-recenter animates it.
  // `compact` is read at CALL time so it's correct in either viewport. The
  // explicit {0,0,0} lookAt resets controls.target so framing restores
  // deterministically regardless of current pan/orbit (founder: restore Y/Z +
  // zoom/distance; X rotation doesn't matter). At boot (ms=0) target is already
  // origin, so this is visually identical to the prior framing call.
  function recenter(ms = 700) {
    const compact = Math.min(window.innerWidth, window.innerHeight) <= 500;
    // Pause idle drift around the transition so it lands (markActive). Skip at
    // boot (ms===0) to keep boot behavior unchanged.
    if (ms > 0 && ctx.markActive) ctx.markActive();
    if (compact) {
      const FRAME_X = -42;
      Graph.cameraPosition({ x: FRAME_X, z: BRAIN_SCALE * 2.35 }, { x: FRAME_X, y: 0, z: 0 }, ms);
    } else {
      Graph.cameraPosition({ z: BRAIN_SCALE * 2.2 }, { x: 0, y: 0, z: 0 }, ms);
    }
    if (ms > 0 && ctx.markActive) ctx.markActive();
  }
  ctx.recenter = recenter;
  recenter(0);

  // ── Track window resize ────────────────────────────────────────────────
  // 3d-force-graph does NOT auto-resize its canvas to the window in this setup
  // (verified: the canvas stayed at boot dimensions on window resize, so the
  // brain never rescaled). Push the new viewport size to the Graph on resize —
  // this resizes the renderer, the post-processing (bloom) composer, and the
  // camera aspect, so the brain grows/shrinks/zooms with the window while
  // preserving the user's current orbit and zoom (no reframe). rAF-coalesced so
  // a drag-resize fires at most once per frame.
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      Graph.width(window.innerWidth).height(window.innerHeight);
    });
  });

  // Always-visible recenter control (visible in compact popover where #panel is
  // display:none). graph.js owns framing — recenter is in scope, no ctx lookup.
  const btnRecenter = document.getElementById('btn-recenter');
  if (btnRecenter) btnRecenter.addEventListener('click', () => recenter());
}
