/**
 * @module graph
 * recense viz — data render, in-brain seeding, ForceGraph3D init (shared
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

// Adaptive-density haze multiplier (Phase 19 Item 2). lod.js computes
// ctx.hazeOpacityScale from the overview node count: 1.0 in/below the neutral
// band, lerping toward HAZE_DENSE_SCALE when dense so haze recedes and the
// schema constellation reads through it. initGraph sets this from ctx before
// the first makeNodeObject call (lod.js runs first); module-scoped because
// makeNodeObject is the nodeThreeObject factory and has no ctx in scope.
let _hazeOpacityScale = 1;

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
 * Word-boundary truncation for hover labels: cut at the last space before `max`
 * (falling back to a hard cut for a single very long token), append an ellipsis.
 * Keeps the hover label a tight title rather than a raw text dump.
 */
function truncLabel(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/\s+$/, '') + '…';
}



/**
 * Build (or reuse) the THREE.Mesh for a node.
 * Shared geometry + per-node material for independent color / opacity animation.
 * Annotates the node with __mesh, __mat, __base, __baseOp, __baseR, __act,
 * __actGain so trace.js can drive the activation animation.
 */
function makeNodeObject(node, ctx) {
  if (node.__mesh) return node.__mesh;

  // Focus un-haze: a haze node promoted into the real graph (ctx.focusedHaze)
  // must render BRIGHT, not at haze opacity — otherwise the "promoted" node is
  // a real node styled exactly like the cloud it came from and nothing pops.
  // Give it the normal (member-tier) radius + full opacity while focused.
  const focusedHaze = node.__cat === 'haze'
    && ctx && ctx.focusedHaze && ctx.focusedHaze.has(node.id);

  const radius = focusedHaze ? 2.5 : nodeRadius(node);
  const baseColor = node.tombstoned
    ? new THREE.Color(TOMBSTONE_COLOR)
    : new THREE.Color(TYPE_COLOR[node.type] ?? TYPE_COLOR.fact);

  const mat = new THREE.MeshBasicMaterial({
    color: baseColor.clone(),
    transparent: true,
    opacity: node.tombstoned ? 0.35
      : (node.__cat === 'haze' && !focusedHaze ? HAZE_OPACITY * _hazeOpacityScale : 0.88),
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

// ─── Instanced haze layer ────────────────────────────────────────────────────

/**
 * Simple deterministic integer hash (Knuth multiplicative) used to pick an
 * occupied voxel for each haze node without Math.random so reloads are stable.
 * Returns a value in [0, mod).
 */
function _hashIndex(idx, mod) {
  // 32-bit Knuth multiplicative hash; keep low bits for the range
  const h = (Math.imul(idx + 1, 0x9e3779b9) >>> 0);
  return h % mod;
}

/**
 * Build ONE InstancedMesh for all __cat==='haze' nodes.
 * Each instance shares the existing _sharedGeo + a Fresnel-rim MeshBasicMaterial
 * (identical to makeNodeObject's haze branch) so the rendered look is unchanged.
 * Positions scatter deterministically inside the brain occupancy volume; no
 * Math.random so reloads produce the same cloud shape.
 *
 * Sets on ctx:
 *   hazeMesh          — THREE.InstancedMesh (added to Graph.scene())
 *   hazeInstanceMap   — Map<instanceId, node>
 *   hazeNodeIdMap     — Map<nodeId, instanceId>
 */
function buildHazeLayer(ctx) {
  const hazeNodes = ctx.allNodes.filter(n => n.__cat === 'haze');
  const hazeCount = hazeNodes.length;
  if (!hazeCount) return; // nothing to render

  const { brainVol } = ctx;

  // ── Build occupied voxel list (same pattern as seedNodePositions) ────────
  let occupied = null;
  let rotMat   = null;
  if (brainVol) {
    const euler = new THREE.Euler(HULL_ROT_X, HULL_ROT_Y, HULL_ROT_Z);
    rotMat = new THREE.Matrix4().makeRotationFromEuler(euler);
    const R    = brainVol.res;
    const bits = brainVol.bits;
    const occ  = [];
    for (let iz = 0; iz < R; iz++) {
      for (let iy = 0; iy < R; iy++) {
        for (let ix = 0; ix < R; ix++) {
          const idx2 = (iz * R + iy) * R + ix;
          if (!((bits[idx2 >> 3] >> (idx2 & 7)) & 1)) continue;
          occ.push([(ix / R) * 2 - 1, (iy / R) * 2 - 1, (iz / R) * 2 - 1]);
        }
      }
    }
    if (occ.length) occupied = occ;
  }

  // ── Material — mirrors makeNodeObject's haze branch exactly ─────────────
  // Shared across all instances; hazeOpacityScale honored via the material opacity.
  const hazeMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: HAZE_OPACITY * _hazeOpacityScale,
    depthWrite: true,
    // vertexColors needed so per-instance color (instanceColor attribute) is applied
    vertexColors: false, // three.js InstancedMesh handles instanceColor separately
  });

  // Same Fresnel-rim onBeforeCompile as makeNodeObject — ensures lit-sphere look
  // matches individual node meshes exactly. Per-instance color comes through the
  // automatic vColor attribute populated by THREE.js from instanceColor.
  hazeMat.onBeforeCompile = (shader) => {
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

  // ── InstancedMesh ─────────────────────────────────────────────────────────
  const hazeMesh = new THREE.InstancedMesh(_sharedGeo, hazeMat, hazeCount);
  hazeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hazeMesh.count = hazeCount;

  // ── Per-instance color and transform ─────────────────────────────────────
  const dummy    = new THREE.Object3D();
  const colorBuf = new THREE.Color();
  const tmpV     = new THREE.Vector3();

  const hazeInstanceMap = new Map(); // instanceId (number) → node
  const hazeNodeIdMap   = new Map(); // nodeId (string) → instanceId (number)

  for (let i = 0; i < hazeCount; i++) {
    const node = hazeNodes[i];

    // ── Position: deterministic scatter inside brain volume ──────────────
    if (occupied && rotMat) {
      // Pick a voxel deterministically by hashing the node index
      const [lx, ly, lz] = occupied[_hashIndex(i, occupied.length)];
      tmpV.set(lx, ly, lz).applyMatrix4(rotMat).multiplyScalar(BRAIN_SCALE);
      // Small deterministic jitter: use hash of (i+voxelIdx) to avoid pile-up
      // at voxel centres. Scale: ±4 units (same as seedNodePositions).
      const jx = ((_hashIndex(i * 3 + 0, 1000) / 1000) - 0.5) * 8;
      const jy = ((_hashIndex(i * 3 + 1, 1000) / 1000) - 0.5) * 8;
      const jz = ((_hashIndex(i * 3 + 2, 1000) / 1000) - 0.5) * 8;
      dummy.position.set(tmpV.x + jx, tmpV.y + jy, tmpV.z + jz);
      // Store position on node object so raycaster and trace can read it
      node.x = dummy.position.x;
      node.y = dummy.position.y;
      node.z = dummy.position.z;
    } else {
      // Fallback if no brainVol: use node's seeded position (set by seedNodePositions
      // before this call, which ran for allNodes; haze was still in allNodes then
      // so x/y/z are set). If still undefined, hash-scatter in a sphere.
      if (node.x == null) {
        const r     = BRAIN_SCALE * 0.6 * Math.cbrt((_hashIndex(i, 1000) + 0.5) / 1000);
        const theta = (_hashIndex(i * 2 + 1, 1000) / 1000) * Math.PI * 2;
        const phi   = Math.acos(2 * (_hashIndex(i * 3 + 2, 1000) / 1000) - 1);
        node.x = r * Math.sin(phi) * Math.cos(theta);
        node.y = r * Math.sin(phi) * Math.sin(theta);
        node.z = r * Math.cos(phi);
      }
      dummy.position.set(node.x, node.y, node.z);
    }

    const radius = nodeRadius(node); // 2 for haze
    dummy.scale.setScalar(radius);
    dummy.updateMatrix();
    hazeMesh.setMatrixAt(i, dummy.matrix);

    // ── Per-instance color ────────────────────────────────────────────────
    const baseColor = node.tombstoned
      ? new THREE.Color(TOMBSTONE_COLOR)
      : colorBuf.set(TYPE_COLOR[node.type] ?? TYPE_COLOR.fact);
    hazeMesh.setColorAt(i, baseColor);

    // ── Store metadata on node for raycasting / trace ────────────────────
    node.__hazeIdx  = i;          // instanceId
    node.__hazeBase = baseColor.clone(); // rest color for un-hover/un-trace restore

    hazeInstanceMap.set(i, node);
    hazeNodeIdMap.set(node.id, i);
  }

  hazeMesh.instanceMatrix.needsUpdate = true;
  if (hazeMesh.instanceColor) hazeMesh.instanceColor.needsUpdate = true;

  // Save the calibrated base opacity on the material so detail.js clearFocusDim
  // can restore it after a focus-dim cycle (detail.js reads hazeMat._baseOpacity).
  hazeMat._baseOpacity = hazeMat.opacity;

  // ── Register on ctx and add to scene ─────────────────────────────────────
  ctx.hazeMesh        = hazeMesh;
  ctx.hazeMat         = hazeMat;
  ctx.hazeInstanceMap = hazeInstanceMap;
  ctx.hazeNodeIdMap   = hazeNodeIdMap;

  ctx.Graph.scene().add(hazeMesh);
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

  // Adopt the adaptive-density haze multiplier computed by lod.js (runs first).
  _hazeOpacityScale = ctx.hazeOpacityScale ?? 1;

  // Seed positions so layout starts inside the brain volume
  seedNodePositions(allNodes, brainVol);

  // ── ForceGraph3D init ──────────────────────────────────────────────────
  // nodeVisibility / linkVisibility read ctx lazily so lod.js callbacks are
  // picked up even if initLod ran first and set them synchronously.
  const Graph = ctx.ForceGraph3D()(document.getElementById('graph'))
    .backgroundColor('#000000')
    .graphData({ nodes: getVisibleNodes(), links: getVisibleLinks() })
    .nodeRelSize(nodeRelSize)
    .nodeThreeObject(node => makeNodeObject(node, ctx))
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

      // Tooltip: typographic label — a dim type·origin tag over a word-boundary
      // truncated title, instead of a raw 120-char text dump. textContent only —
      // NEVER innerHTML with node data (T-10-12). Full text lives in the detail panel.
      tooltipEl.textContent = '';  // clear prior children (safe: no user data)
      const tipTag = document.createElement('div');
      tipTag.className = 'tip-tag';
      tipTag.textContent = node.tombstoned
        ? 'tombstone'
        : (node.type || 'node') + (node.origin ? ' · ' + node.origin : '');
      const tipTitle = document.createElement('div');
      tipTitle.className = 'tip-title';
      tipTitle.textContent = truncLabel(node.value || node.id || '', 48);
      tooltipEl.appendChild(tipTag);
      tooltipEl.appendChild(tipTitle);
      tooltipEl.style.display = 'block';
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
      //
      // Haze nodes are NOT in graphData, so a haze click reaches fg3d as a
      // "background" click — and this fires AFTER _onHazePointerUp (pointerup)
      // has already opened the detail for it. Without the guard below it would
      // immediately tear that selection down (the live B1 bug: focus+trace
      // survive but detail+ring vanish). _onHazePointerUp sets _hazeClickConsumed
      // only when a haze node was actually hit, so true empty-space clicks (flag
      // unset) still dismiss as before.
      if (ctx._hazeClickConsumed) { ctx._hazeClickConsumed = false; return; }
      if (ctx.closeDetail) ctx.closeDetail();
    });

  ctx.Graph = Graph;

  // ── Instanced haze layer ───────────────────────────────────────────────
  // Build AFTER Graph is set (needs ctx.Graph.scene()) and AFTER
  // seedNodePositions (haze fallback reads node.x/y/z). Haze nodes are
  // excluded from the ForceGraph3D data (T1, app.js), so they live only
  // in this InstancedMesh from here on.
  buildHazeLayer(ctx);

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

  // ── Haze InstancedMesh raycasting (T3) ───────────────────────────────────
  // ForceGraph3D handles raycasting on its own nodes; haze nodes live only in
  // ctx.hazeMesh (excluded from graphData). We add a parallel raycaster pass
  // so hover + click on haze nodes work identically to regular nodes.
  //
  // Architecture: pointer events on the renderer canvas → NDC mouse → Raycaster
  // → InstancedMesh intersections (returns instanceId) → node lookup via
  // ctx.hazeInstanceMap → same hover/click affordances as graph.js callbacks.
  //
  // Guard: if no hazeMesh (no haze nodes), skip entirely.
  if (ctx.hazeMesh) {
    const renderer    = Graph.renderer();
    const camera      = Graph.camera();
    const domEl       = renderer.domElement;
    const hazeRay     = new THREE.Raycaster();
    hazeRay.params.Points = { threshold: 2 }; // not used (Mesh), but set defensively

    // NDC mouse updated on every pointermove
    const _mouse = new THREE.Vector2();
    // Track whether ForceGraph3D is currently over a (non-haze) node so we
    // don't fire haze hover when fg3d already caught something above us.
    // ForceGraph3D sets _hoveredNode before our listener fires (same-frame).
    let _hazeHoveredNode = null;

    // ── Color helpers ────────────────────────────────────────────────────
    const _highlightColor = new THREE.Color(0xffffff); // hover: brighten instance

    function _setHazeColor(node, color) {
      if (!ctx.hazeMesh || node.__hazeIdx == null) return;
      ctx.hazeMesh.setColorAt(node.__hazeIdx, color);
      ctx.hazeMesh.instanceColor.needsUpdate = true;
    }

    // ── Hover ────────────────────────────────────────────────────────────
    function _onHazePointerMove(e) {
      if (!ctx.hazeMesh) return;
      const rect = domEl.getBoundingClientRect();
      _mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      _mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

      hazeRay.setFromCamera(_mouse, camera);
      const hits = hazeRay.intersectObject(ctx.hazeMesh, false);

      if (hits.length && typeof hits[0].instanceId === 'number') {
        const instanceId = hits[0].instanceId;
        const node = ctx.hazeInstanceMap.get(instanceId);
        if (!node) return;

        // If fg3d already has a hovered non-haze node, don't override
        if (ctx._hoveredNode && ctx._hoveredNode.__cat !== 'haze') {
          // Un-hover any previous haze node
          if (_hazeHoveredNode && _hazeHoveredNode !== node) {
            _setHazeColor(_hazeHoveredNode, _hazeHoveredNode.__hazeBase);
            _hazeHoveredNode = null;
          }
          return;
        }

        if (_hazeHoveredNode && _hazeHoveredNode !== node) {
          // Un-hover previous haze node
          _setHazeColor(_hazeHoveredNode, _hazeHoveredNode.__hazeBase);
        }
        _hazeHoveredNode = node;

        // Brighten: lerp base color toward white slightly
        const hoverColor = node.__hazeBase.clone().lerp(_highlightColor, 0.5);
        _setHazeColor(node, hoverColor);
        domEl.style.cursor = 'pointer';

        // Tooltip (same structure as graph.js onNodeHover)
        const tooltipEl = document.getElementById('tooltip');
        if (tooltipEl) {
          tooltipEl.textContent = '';
          const tipTag = document.createElement('div');
          tipTag.className = 'tip-tag';
          tipTag.textContent = node.tombstoned
            ? 'tombstone'
            : (node.type || 'node') + (node.origin ? ' · ' + node.origin : '');
          const tipTitle = document.createElement('div');
          tipTitle.className = 'tip-title';
          tipTitle.textContent = truncLabel(node.value || node.id || '', 48);
          tooltipEl.appendChild(tipTag);
          tooltipEl.appendChild(tipTitle);
          tooltipEl.style.display = 'block';
        }
      } else {
        // No haze hit — restore previous haze hover if any
        if (_hazeHoveredNode) {
          _setHazeColor(_hazeHoveredNode, _hazeHoveredNode.__hazeBase);
          domEl.style.cursor = '';
          const tooltipEl = document.getElementById('tooltip');
          if (tooltipEl) tooltipEl.style.display = 'none';
          _hazeHoveredNode = null;
        }
      }
    }

    // ── Click ────────────────────────────────────────────────────────────
    // Use pointerdown+pointerup instead of 'click' to match fg3d's
    // click-vs-drag detection (a drag shouldn't open detail).
    let _hazePointerDownPos = null;

    function _onHazePointerDown(e) {
      _hazePointerDownPos = { x: e.clientX, y: e.clientY };
      // Clear any stale suppression flag so a genuine empty-space click later
      // can still dismiss (belt-and-suspenders if a prior onBackgroundClick
      // never fired).
      ctx._hazeClickConsumed = false;
    }

    function _onHazePointerUp(e) {
      if (!_hazePointerDownPos) return;
      const dx = e.clientX - _hazePointerDownPos.x;
      const dy = e.clientY - _hazePointerDownPos.y;
      _hazePointerDownPos = null;
      // If the pointer moved more than 4px it was a drag, not a click
      if (Math.sqrt(dx * dx + dy * dy) > 4) return;

      if (!ctx.hazeMesh) return;
      const rect = domEl.getBoundingClientRect();
      _mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      _mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

      hazeRay.setFromCamera(_mouse, camera);
      const hits = hazeRay.intersectObject(ctx.hazeMesh, false);

      if (hits.length && typeof hits[0].instanceId === 'number') {
        const node = ctx.hazeInstanceMap.get(hits[0].instanceId);
        if (node && ctx.selectNode) {
          // Suppress the impending fg3d background-click teardown (set before
          // selectNode; the background 'click' fires after this pointerup).
          ctx._hazeClickConsumed = true;
          ctx.selectNode(node);
        }
      } else {
        // Proximity fallback: the exact triangle-level InstancedMesh raycast can
        // miss near the silhouette edge of a small sphere (radius-2 haze nodes are
        // ~2% of screen at typical depth). Project every haze node to NDC and pick
        // the nearest one within a 10px screen-space threshold.
        // O(n_haze) per near-miss click — acceptable since this only fires when the
        // primary raycast returns nothing.
        const PROX_NDC = 10 / Math.max(rect.width, rect.height) * 2; // 10px → NDC units
        let bestDist = PROX_NDC;
        let bestNode = null;
        const _proxPt = new THREE.Vector3();
        for (const [, node] of ctx.hazeInstanceMap) {
          if (node.x == null) continue;
          _proxPt.set(node.x, node.y, node.z).project(camera);
          const d = Math.sqrt((_proxPt.x - _mouse.x) ** 2 + (_proxPt.y - _mouse.y) ** 2);
          if (d < bestDist) { bestDist = d; bestNode = node; }
        }
        if (bestNode && ctx.selectNode) {
          // Same background-click suppression as the direct-hit branch.
          ctx._hazeClickConsumed = true;
          ctx.selectNode(bestNode);
        }
      }
    }

    domEl.addEventListener('pointermove', _onHazePointerMove);
    domEl.addEventListener('pointerdown', _onHazePointerDown);
    domEl.addEventListener('pointerup',   _onHazePointerUp);

    // Store un-hover helper on ctx so trace.js and external code can restore
    // a haze hover highlight that gets clobbered mid-trace.
    ctx._clearHazeHover = () => {
      if (_hazeHoveredNode) {
        _setHazeColor(_hazeHoveredNode, _hazeHoveredNode.__hazeBase);
        _hazeHoveredNode = null;
      }
    };

    // ── Focus un-haze ──────────────────────────────────────────────────────
    // Restores the pre-instancing behavior: focusing a haze node lifts it and
    // its 1-hop haze neighbors OUT of the instanced cloud into the real graph
    // (bright nodes + connecting edges), instead of dimming them with the rest
    // of the haze. Mirrors schema drill-in: mutate graphData + refreshVisibility.
    //
    // Why promotion (not "just brighten"): all ~6k haze nodes share one material,
    // and InstancedMesh has no per-instance opacity — there is no way to keep a
    // few instances bright while dimming the rest. The faithful path is to render
    // the focused neighborhood as real nodes (getVisibleNodes/Links + ctx.focusedHaze).
    const FOCUS_HAZE_CAP = 16;        // cap neighbors for high-degree nodes
    const _hideDummy    = new THREE.Object3D();
    _hideDummy.scale.setScalar(0);
    _hideDummy.updateMatrix();        // zero-scale → instance renders to nothing
    const _restoreDummy = new THREE.Object3D();

    function _hideHazeInstance(idx) {
      ctx.hazeMesh.setMatrixAt(idx, _hideDummy.matrix);
      ctx.hazeMesh.instanceMatrix.needsUpdate = true;
    }
    function _restoreHazeInstance(n) {
      _restoreDummy.position.set(n.x || 0, n.y || 0, n.z || 0);
      _restoreDummy.scale.setScalar(nodeRadius(n)); // 2 for haze (mirror buildHazeLayer)
      _restoreDummy.updateMatrix();
      ctx.hazeMesh.setMatrixAt(n.__hazeIdx, _restoreDummy.matrix);
      ctx.hazeMesh.instanceMatrix.needsUpdate = true;
    }

    function _clearHazeFocus() {
      if (!ctx.focusedHaze || !ctx.focusedHaze.size) return;
      for (const id of ctx.focusedHaze) {
        const n = ctx.idMap.get(id);
        if (!n) continue;
        n.fx = undefined; n.fy = undefined; n.fz = undefined; // unpin
        if (n.__hazeIdx != null) _restoreHazeInstance(n);     // back into the cloud
      }
      ctx.focusedHaze = new Set();
      Graph.graphData({ nodes: getVisibleNodes(), links: getVisibleLinks() });
      if (ctx.refreshVisibility) ctx.refreshVisibility();
    }

    // Promote node + its 1-hop HAZE neighbors. Non-haze neighbors are already
    // real nodes and follow normal LOD; we only lift haze ones out of the cloud.
    ctx.focusHazeNeighborhood = function focusHazeNeighborhood(node) {
      _clearHazeFocus();                                   // drop any prior focus
      if (!node || node.__cat !== 'haze') return;          // only haze focus promotes
      const ids = new Set([node.id]);
      const edges = (ctx.adj.get(node.id) || []).slice(0, FOCUS_HAZE_CAP);
      for (const e of edges) {
        const sid = typeof e.source === 'object' ? e.source.id : e.source;
        const tid = typeof e.target === 'object' ? e.target.id : e.target;
        const nbId = sid === node.id ? tid : sid;
        const nb = ctx.idMap.get(nbId);
        if (nb && nb.__cat === 'haze') ids.add(nbId);       // only haze neighbors
      }
      ctx.focusedHaze = ids;
      for (const id of ids) {
        const n = ctx.idMap.get(id);
        if (!n) continue;
        n.fx = n.x; n.fy = n.y; n.fz = n.z;                 // pin in place (no drift)
        if (n.__hazeIdx != null) _hideHazeInstance(n.__hazeIdx); // avoid double-render
      }
      Graph.graphData({ nodes: getVisibleNodes(), links: getVisibleLinks() });
      if (ctx.refreshVisibility) ctx.refreshVisibility();
    };

    ctx.clearHazeFocus = _clearHazeFocus;
  }
}
