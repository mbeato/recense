/**
 * @module effects
 * brain-memory viz — cinematic effects: Fresnel rim-lit glass hull + UnrealBloomPass + idle shimmer.
 *
 * Exported API:
 *   initEffects(ctx) — call AFTER Graph is initialized.
 *     Sets: ctx.bloomPass, ctx.hullMat, ctx.setIdleShimmer(on).
 *
 * Design refs:
 *   D-01 cinematic glow (UnrealBloomPass on Graph.postProcessingComposer)
 *   D-02 rim-lit glass hull (Fresnel ShaderMaterial, depthWrite:false, AdditiveBlending)
 *   D-04 idle = hull shimmer only (rimOpacity sin wave; no node/edge changes)
 *
 * Threat mitigations:
 *   T-10-10  imports only '../vendor/addons/...' and 'three' — no CDN
 *   T-15-DBLCOMP  uses Graph.postProcessingComposer() — never constructs a second EffectComposer
 *   T-15-OCCLUDE  depthWrite:false + AdditiveBlending — hull never masks nodes
 *   T-04-FAKEFIRE idle path animates rimOpacity only — no node/edge activity
 */

import { STLLoader } from '../vendor/STLLoader.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';

// ── Fresnel vertex shader ──────────────────────────────────────────────────
// Passes world-space view direction and transformed normal to the fragment stage.
const VERTEX_SHADER = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// ── Fresnel fragment shader ────────────────────────────────────────────────
// fresnel = pow(1 - |dot(viewDir, normal)|, rimPower)
// — brighter at glancing angles (edge-lit), dark toward screen center (glass-interior)
const FRAGMENT_SHADER = /* glsl */`
  uniform vec3  rimColor;
  uniform float rimPower;
  uniform float rimOpacity;
  varying vec3  vNormal;
  varying vec3  vViewDir;
  void main() {
    float fresnel = pow(1.0 - abs(dot(vViewDir, vNormal)), rimPower);
    gl_FragColor = vec4(rimColor, fresnel * rimOpacity);
  }
`;

/**
 * Initialize the cinematic effects layer.
 *
 * Must be called AFTER Graph (ForceGraph3D instance) has been created, because
 * bloom is added to Graph.postProcessingComposer().
 *
 * Sets on ctx:
 *   ctx.hullMat       — Fresnel ShaderMaterial (idle shimmer writes rimOpacity)
 *   ctx.bloomPass     — UnrealBloomPass (stats.js degrades quality via this ref)
 *   ctx.setIdleShimmer(on) — toggle idle hull-breathing animation
 *
 * @param {import('./constants.js').Ctx} ctx
 */
export function initEffects(ctx) {
  const { THREE, Graph, hullGroup, brainVol, registerTick, isIdle } = ctx;

  // ── Fresnel rim ShaderMaterial (D-02) ─────────────────────────────────────
  //
  // Key rendering properties:
  //   transparent: true   — needed for alpha from the fresnel term
  //   depthWrite: false   — hull MUST NOT write depth; nodes behind it remain
  //                          visible regardless of z-order (Pitfall 6 / T-15-OCCLUDE)
  //   AdditiveBlending    — hull glow is added on top of whatever is behind it;
  //                          never darkens the scene or masks nodes
  //   DoubleSide          — STL may have inconsistent winding; inside visible when
  //                          camera flies through the hull
  const hullMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      rimColor:   { value: new THREE.Color(0x453d46) },  // rose-tinted charcoal — faint warm rim
      rimPower:   { value: 3.5 },                        // tighter rim falloff — edge light only
      rimOpacity: { value: 0.22 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  ctx.hullMat = hullMat;

  // ── STL brain-hull load (CC BY-SA, Nevit Dilmen — attribution: #hull-credit) ─
  //
  // VIZ-09 (D-06 fallback): render a Taubin-smoothed *display* derivative of the
  // model rather than the raw scan. The raw 82k-tri mesh's high-frequency cortical
  // folds present many near-glancing normals from front/top, whose Fresnel rims
  // stack additively into a jagged silhouette. Smoothing lowers fold amplitude so
  // the outline reads as a brain from every angle while keeping side-view character.
  // The derivative ships under the SAME CC BY-SA license + #hull-credit attribution
  // (brain-model.stl is retained as the upstream source; node containment uses the
  // occupancy grid, not this mesh, so smoothing the shell does not move any node).
  // Regenerate via scripts/smooth-display-hull.py (tune iterations for more/less fold).
  //
  // Path is page-origin-relative (Three.js FileLoader uses fetch internally).
  // Normalization: if occupancy grid is available, use its centroid + normScale so
  // the hull aligns exactly with the containment volume; otherwise just center it.
  new STLLoader().load('./vendor/brain-model-display.stl', (geometry) => {
    if (brainVol) {
      // Match the occupancy-grid normalization used by the seeding pass in graph.js:
      // translate to centroid then scale to the [-1, 1] cube used by brainOccupied().
      const c = brainVol.centroid;
      const s = brainVol.normScale;
      geometry.translate(-c[0], -c[1], -c[2]);
      geometry.scale(s, s, s);
    } else {
      geometry.center();
    }
    geometry.computeVertexNormals();

    const hullMesh = new THREE.Mesh(geometry, hullMat);
    // renderOrder -1: render before nodes (renderOrder 0).
    // Combined with depthWrite:false this means the hull draws first but writes
    // no depth — nodes then render at their own z and appear correctly in front.
    hullMesh.renderOrder = -1;
    hullGroup.add(hullMesh);
  });

  // ── UnrealBloomPass (D-01 cinematic glow) ──────────────────────────────────
  //
  // Uses Graph.postProcessingComposer() — do NOT construct a second EffectComposer
  // (Pitfall 2 / T-15-DBLCOMP). The composer already contains a RenderPass added by
  // 3d-force-graph. We append:
  //   [RenderPass (auto)] → [UnrealBloomPass] → [OutputPass] (last = sRGB)
  //
  // Threshold 0.7: base node luminance stays below this so only activation
  // flares (HOT = 0xffe08a, luminance ≈ 0.88) breach the bloom gate (Pitfall 4).
  const composer = Graph.postProcessingComposer();
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.7,   // strength  — restrained glow; ambient scene stays dark
    0.4,   // radius    — tight bloom halo around activated nodes
    0.75,  // threshold — darkened base palette sits well below; only HOT activation flares
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());  // tone-mapping + sRGB; MUST be last (A1 / r171)

  // Expose on ctx so stats.js (Plan 06) can toggle/resize for adaptive quality (D-06).
  ctx.bloomPass = bloomPass;

  // ── Idle hull shimmer (D-04) ───────────────────────────────────────────────
  //
  // When idle, breathes rimOpacity on a slow ~15.7-second sin cycle.
  // ONLY animates the hull's rim opacity — NEVER touches:
  //   • node material colors or opacity       (would fake activation — D-04 violation)
  //   • node mesh scale                       (ditto)
  //   • link/edge visibility                  (ditto)
  // Guarded by ctx.isIdle() so shimmer stops the moment a real trace fires.
  let shimmerActive = false;

  ctx.setIdleShimmer = (on) => {
    shimmerActive = on;
  };

  registerTick((now) => {
    if (!shimmerActive || !isIdle()) {
      // Restore the non-idle base on the idle→active transition so the hull
      // never stays dimmed at whatever phase the sine wave happened to be in.
      hullMat.uniforms.rimOpacity.value = 0.22;
      return;
    }
    const t = now / 1000;
    // Animate between 0.10 and 0.22 on a ~15.7-second period (0.4 rad/s);
    // peaks at the non-idle base so shimmer only ever dims, never flares.
    hullMat.uniforms.rimOpacity.value = 0.16 + 0.06 * Math.sin(t * 0.4);
  });

  // Arm the shimmer from init: the tick above gates on ctx.isIdle(), so this
  // only takes visible effect once the idle timeout elapses (D-04). Without
  // this call shimmerActive stays false forever and the feature is dead code.
  ctx.setIdleShimmer(true);
}
