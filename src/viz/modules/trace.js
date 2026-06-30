/**
 * @module trace
 * recense viz — spreading-activation module.
 *
 * initTrace(ctx) sets ctx.activate, ctx.spawnPulse, and ctx.applyTrace.
 *
 * Per-frame animation work is registered via ctx.registerTick (owned by
 * stats.js master rAF loop, Plan 06). This module registers its tick with
 * the central loop and does not own its own frame scheduling.
 *
 * Phase 52 semantics (D-102 / honest-trace rewrite):
 *   - applyTrace(row) accepts a full SSE row {seeds, hops, kind, query_id}.
 *     It lights EVERY seed in row.seeds (brightness ∝ retrieval score) and
 *     EVERY real 1-hop neighbour in row.hops (subordinate / dimmer, score-gated).
 *     NO client-side BFS — the BFS was deleted; the server payload is the
 *     authoritative lit set (D-08 honesty guarantee).
 *   - Per-frame tick implements the D-06 attack→hold→exponential-fade envelope
 *     instead of the old flat linear decay.
 *   - spawnPulse is preserved for detail.js ripple use; it is NOT called from
 *     applyTrace (no honest source-seed→hop edge exists to animate).
 *   - The same applyTrace serves both SSE traces and the local test trigger
 *     (D-102 proof): the test trigger builds a synthetic row from ctx.adj so
 *     both paths share the identical rendering code path.
 *
 * Exported helpers (testable, THREE-free):
 *   - normalizeSeed(s)         — shape-normalise seed union → {node_id, score}
 *   - traceEdgesFromHops(row, idMap) — resolve lit hop set from payload only
 */

import * as THREE from 'three';
import {
  HOT,
  KIND_COLOR,
  TRACE_MAX_EDGES,
  PULSE_MS,
  DECAY_ATTACK_MS,
  DECAY_HOLD_MS,
  DECAY_FADE_MS,
  DECAY_FLOOR,
  ACT_SCALE_GAIN,
  ACT_BRIGHTEN_GAIN,
  ACT_HAZE_LERP,
  REPLAY_DIM,
  TWINKLE_COUNT,
  TWINKLE_PERIOD_MS,
  TWINKLE_AMP,
} from './constants.js';

// ── Reusable scratch objects for pulse orientation (avoid per-frame alloc) ─
const _dir = new THREE.Vector3();
const _up  = new THREE.Vector3(0, 1, 0);
const _q   = new THREE.Quaternion();

// ── Pathway wavefront shader ───────────────────────────────────────────────
// "Light in the wire" (GMUNK / Tron, Territory Studio): a band of light races
// along the edge from→to and the wire behind it glows then decays — never a bead
// riding on top. vT runs 0 (from) → 1 (to) along a unit-height cylinder; the head
// is a bright band at uWavefront with a soft decaying tail behind it. Additive so
// it (and only it — amber on activation) catches the bloom. uIntensity carries the
// asymmetric ignite/decay envelope.
const WAVEFRONT_VERT = `
  varying float vT;
  void main() {
    vT = position.y + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const WAVEFRONT_FRAG = `
  uniform vec3  uColor;
  uniform float uWavefront;
  uniform float uIntensity;
  varying float vT;
  void main() {
    float head = smoothstep(0.14, 0.0, abs(vT - uWavefront));
    float tail = vT < uWavefront ? exp(-(uWavefront - vT) * 3.5) * 0.45 : 0.0;
    float a = (head + tail) * uIntensity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;
// Asymmetric timing (ms): fast attack, head sweep, long ease-out decay.
const WF_ATTACK = 140;
const WF_SWEEP  = 850;
const WF_DECAY  = 1150;
const WF_LIFE   = WF_SWEEP + WF_DECAY;

// Additive node-flash halo constants (FIX-52A).
// Fixed world-space radius so the glow reads at ~2,700-node overview zoom.
const HALO_RADIUS  = 16;   // world-space radius at peak (scene units)
const HALO_LIFE_MS = 900;  // total halo lifetime (ms): grow then fade
const HALO_ATTACK  = 150;  // grow phase (0 → HALO_RADIUS, ms)

// Soft-glow halo shader: a view-facing radial falloff (bright core fading to a
// soft silhouette) instead of a flat additive disc — reads as a dimensional orb,
// not a cheap sphere. `facing` = dot(normal, viewDir): 1 at the camera-facing
// center, 0 at the silhouette. A bright inner core + soft outer wash gives the
// layered glow; additive blending feeds the bloom pass.
const HALO_VERT = `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const HALO_FRAG = `
  uniform vec3  uColor;
  uniform float uIntensity;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float facing = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    float core = pow(facing, 3.0);        // tight bright center
    float wash = pow(facing, 1.2) * 0.45; // soft surrounding glow
    float a = (core + wash) * uIntensity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/** Clamped smoothstep on [0,1]. */
function _smooth01(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }

// ============================================================================
// Exported pure helpers — THREE-free, usable in unit tests
// ============================================================================

/**
 * Normalise a seed from the ActivationTraceInput union type to a consistent
 * {node_id, score} object.  Accepts both shapes:
 *   - bare string id  (legacy / ingestion-kind producers)
 *   - {node_id, score} (post-52 recall path; score may be null per WR-02)
 *
 * score: null → the caller should apply the fixed mid-intensity fallback (0.5).
 * This helper is exported so Plan 03 (ingestion colours) can reuse it.
 *
 * @param {string | {node_id: string, score: number | null}} s
 * @returns {{ node_id: string, score: number | null }}
 */
export function normalizeSeed(s) {
  if (typeof s === 'string') return { node_id: s, score: null };
  return { node_id: s.node_id, score: (typeof s.score === 'number') ? s.score : null };
}

/**
 * Pure helper: resolve the lit hop-node set from the SERVER PAYLOAD only.
 *
 * Each entry in row.hops (a real 1-hop neighbour as emitted by the engine)
 * is looked up in idMap.  Nodes absent from the map are skipped.  The
 * returned set is clamped to TRACE_MAX_EDGES as a defensive cap — honest
 * payloads are already within this limit; the cap guards against an
 * unexpectedly oversized row (T-52-04).
 *
 * CONTRACT: this function MUST NOT traverse ctx.adj, MAX_HOPS, or TRACE_FANOUT
 * inside hop resolution — those were the BFS tools; their use here would
 * reintroduce the dishonesty this phase kills (D-08 #1 regression guard).
 *
 * @param {{ hops: Array<{node_id: string, score: number|null, hop: number}> }} row
 * @param {Map<string, any>} idMap
 * @returns {Array<{node_id: string, score: number|null}>}
 */
export function traceEdgesFromHops(row, idMap) {
  const hops = row.hops || [];
  const result = [];
  for (const hop of hops) {
    if (!idMap.has(hop.node_id)) continue;  // skip nodes not in the render graph
    if (result.length >= TRACE_MAX_EDGES) break; // defensive cap (T-52-04)
    result.push({ node_id: hop.node_id, score: hop.score ?? null });
  }
  return result;
}

// ============================================================================
// D-06 activation envelope evaluator
// ============================================================================

/**
 * Compute the current activation level for a node given its envelope state.
 *
 * Three phases:
 *   [0, ATTACK)      → linear ramp  0 → peak
 *   [ATTACK, +HOLD)  → hold at peak
 *   [+HOLD, +FADE)   → exponential decay: peak → DECAY_FLOOR
 *   >= total         → returns 0 (caller should remove from active set)
 *
 * @param {number} now      - performance.now() at tick time (ms)
 * @param {number} t0       - when activate() was called (ms)
 * @param {number} peak     - activation level at the moment of firing (0–1)
 * @returns {number}        - current level (0 = expired)
 */
function evalEnvelope(now, t0, peak) {
  const elapsed = now - t0;
  if (elapsed < DECAY_ATTACK_MS) {
    // Linear attack: 0 → peak
    return peak * (elapsed / DECAY_ATTACK_MS);
  }
  const afterAttack = elapsed - DECAY_ATTACK_MS;
  if (afterAttack < DECAY_HOLD_MS) {
    // Hold at peak
    return peak;
  }
  const fadeT = afterAttack - DECAY_HOLD_MS;
  if (fadeT >= DECAY_FADE_MS) {
    // Fully expired
    return 0;
  }
  // Exponential fade: peak → DECAY_FLOOR over DECAY_FADE_MS
  // k=4 gives exp(-4)≈0.018 at the tail — well into the floor territory.
  const ratio = fadeT / DECAY_FADE_MS;
  return DECAY_FLOOR + (peak - DECAY_FLOOR) * Math.exp(-ratio * 4);
}

// ============================================================================
// initTrace(ctx) — entry point
// ============================================================================

export function initTrace(ctx) {
  // ── Shared wavefront geometry: unit-height tube, scaled to each edge's length
  // on Y and oriented along the edge. Thin radius gives the wire body so the glow
  // reads without looking like a fat rod. One allocation for all wavefront meshes.
  const _pulseGeo = new THREE.CylinderGeometry(1.3, 1.3, 1, 6, 1);
  // Shared halo geometry: unit sphere scaled per halo to HALO_RADIUS (FIX-52A).
  // One allocation for all halos — matches _pulseGeo pattern.
  const _haloGeo = new THREE.SphereGeometry(1, 8, 6);

  // Convert HOT constant to a THREE.Color for lerping
  const HOT_COLOR = new THREE.Color(HOT);

  // Per-kind colour objects (pre-built at init; zero allocation cost per-frame)
  const KIND_COLORS = {
    new_node:        new THREE.Color(KIND_COLOR.new_node),
    reconsolidation: new THREE.Color(KIND_COLOR.reconsolidation),
    oscillation:     new THREE.Color(KIND_COLOR.oscillation),
    neutral:         new THREE.Color(KIND_COLOR.neutral),
  };

  // Active node Set — the tick callback walks ONLY this set, never allNodes
  const active = new Set();

  // In-flight traveling pulse records (detail.js ripple path)
  const pulses = [];

  // In-flight node-flash halo records (FIX-52A)
  const halos = [];

  // ── activate(node, level) ─────────────────────────────────────────────────
  // Raises the node's activation level and enqueues it for animation.
  // Records __actT0 + __actPeak for the D-06 envelope evaluator in tick().
  // If the new level is higher than the current peak, the envelope restarts.
  //
  // Haze nodes (InstancedMesh, have __hazeIdx but no __mat) get a color-only
  // branch that drives ctx.hazeMesh.setColorAt — no per-frame setMatrixAt so
  // the 6k-instance matrix buffer stays untouched (performance constraint).
  // Regular nodes must have __mat to be rendered — early-return if absent.
  function activate(node, level, kindColor) {
    if (!node) return;

    // Spawn (or coalesce) an additive halo for this activation (FIX-52A).
    // Lives in ctx.pulseGroup so the bloom pass catches it — same proven-visible
    // path as edge wavefronts. The halo is an INDEPENDENT mesh at the node's
    // position, so it must spawn BEFORE the __mat/__hazeIdx guard below: that
    // guard bails for nodes not realized as a mesh/haze instance (the common
    // case at overview zoom), which previously suppressed every node flash.
    // Coalesce prevents unbounded stacking on rapid re-activations (oscillation
    // strobes, repeated recalls).
    if (ctx.pulseGroup) {
      let found = false;
      for (let hi = 0; hi < halos.length; hi++) {
        if (halos[hi].node === node) {
          halos[hi].t0    = performance.now();
          halos[hi].level = level;
          if (halos[hi].mat.uniforms && halos[hi].mat.uniforms.uColor) {
            halos[hi].mat.uniforms.uColor.value.copy(kindColor || HOT_COLOR);
          }
          found = true;
          break;
        }
      }
      if (!found) {
        const mat  = new THREE.ShaderMaterial({
          uniforms: {
            uColor:     { value: (kindColor || HOT_COLOR).clone() },
            uIntensity: { value: 0 },
          },
          vertexShader:   HALO_VERT,
          fragmentShader: HALO_FRAG,
          blending:    THREE.AdditiveBlending,
          transparent: true,
          depthWrite:  false,
        });
        const mesh = new THREE.Mesh(_haloGeo, mat);
        ctx.pulseGroup.add(mesh);
        halos.push({ node, t0: performance.now(), level, mesh, mat });
      }
    }

    // Per-node material/haze tint + scale path requires the node to be realized.
    if (node.__mat == null && node.__hazeIdx == null) return;
    if ((node.__act || 0) < level) {
      node.__act      = level;
      node.__actT0    = performance.now();
      node.__actPeak  = level;
      node.__actColor = kindColor || HOT_COLOR; // per-kind palette (D-03 / D-04)
    }
    active.add(node);
  }

  // ── spawnPulse(from, to) ──────────────────────────────────────────────────
  // Ignites a full-edge wavefront: a band of amber light races from→to and the
  // wire glows then decays (see WAVEFRONT_* shader above). Uses the shared
  // _pulseGeo; each wavefront owns only its (cheap) ShaderMaterial, disposed on
  // completion. Preserved for detail.js ripple — NOT called from applyTrace
  // (no honest source-seed→hop edge available from the server payload).
  function spawnPulse(from, to, color) {
    if (!ctx.pulseGroup || !from || !to) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor:     { value: color || HOT_COLOR }, // parameterised per-kind
        uWavefront: { value: 0 },
        uIntensity: { value: 0 },
      },
      vertexShader: WAVEFRONT_VERT,
      fragmentShader: WAVEFRONT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(_pulseGeo, mat);
    ctx.pulseGroup.add(mesh);
    pulses.push({ from, to, t0: performance.now(), mesh, mat });
  }

  // ── Per-frame tick (registered with the stats master rAF loop) ────────────
  // CONTRACT: touches ONLY the active Set and the pulses array.
  // Never iterates ctx.allNodes. Never calls Graph.refresh().
  let last = performance.now();

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // -- Activation decay: walk only the active set ---------------------------
    for (const node of [...active]) {
      // ── Haze (InstancedMesh) branch: color-only, no __mat / __mesh ──────────
      if (node.__hazeIdx != null && node.__hazeBase && ctx.hazeMesh) {
        // D-06 envelope (or legacy fallback if __actT0 absent)
        if (node.__actT0 != null) {
          node.__act = evalEnvelope(now, node.__actT0, node.__actPeak || node.__act || 1);
        } else {
          node.__act -= dt * 0.6; // legacy fallback (~1.6 s linear)
        }
        const elapsed = node.__actT0 != null ? (now - node.__actT0) : Infinity;
        const expired = node.__actT0 != null
          ? elapsed >= DECAY_ATTACK_MS + DECAY_HOLD_MS + DECAY_FADE_MS
          : node.__act <= 0.001;
        if (expired || node.__act <= 0) {
          node.__act      = 0;
          node.__actT0    = undefined;
          node.__actPeak  = undefined;
          node.__actColor = undefined;
          active.delete(node);
          // Restore rest color — copy __hazeBase into the instance color buffer
          ctx.hazeMesh.setColorAt(node.__hazeIdx, node.__hazeBase);
          ctx.hazeMesh.instanceColor.needsUpdate = true;
          continue;
        }
        const a = Math.max(0, node.__act);
        // Lerp toward the kind-specific activation colour (default: HOT amber)
        const activationColor = node.__hazeBase.clone().lerp(node.__actColor || HOT_COLOR, a * ACT_HAZE_LERP);
        ctx.hazeMesh.setColorAt(node.__hazeIdx, activationColor);
        ctx.hazeMesh.instanceColor.needsUpdate = true;
        continue;
      }

      // ── Regular (non-instanced) nodes: original material + scale path ────────
      if (!node.__mat || !node.__mesh) {
        active.delete(node);
        continue;
      }
      // D-06 envelope (or legacy fallback if __actT0 absent)
      if (node.__actT0 != null) {
        node.__act = evalEnvelope(now, node.__actT0, node.__actPeak || node.__act || 1);
      } else {
        node.__act -= dt * 0.6; // legacy fallback (~1.6 s linear)
      }
      const elapsed = node.__actT0 != null ? (now - node.__actT0) : Infinity;
      const expired = node.__actT0 != null
        ? elapsed >= DECAY_ATTACK_MS + DECAY_HOLD_MS + DECAY_FADE_MS
        : node.__act <= 0.001;
      if (expired || node.__act <= 0) {
        node.__act      = 0;
        node.__actT0    = undefined;
        node.__actPeak  = undefined;
        node.__actColor = undefined;
        active.delete(node);
        // Restore base appearance — scale restores to __baseR, NOT 1: node radius
        // lives in mesh.scale (shared unit geometry, D-05), so setScalar(1) would
        // permanently shrink every node that ever fired.
        if (node.__base) node.__mat.color.copy(node.__base);
        if (node.__baseOp !== undefined) node.__mat.opacity = node.__baseOp;
        node.__mesh.scale.setScalar(node.__baseR || 1);
        continue;
      }
      const a = Math.max(0, node.__act) * (node.__actGain || 1);
      if (node.__base) node.__mat.color.copy(node.__base).lerp(node.__actColor || HOT_COLOR, a * 0.8);
      node.__mat.opacity = Math.min(1, (node.__baseOp || 0.85) + a * ACT_BRIGHTEN_GAIN);
      node.__mesh.scale.setScalar((node.__baseR || 1) * (1 + a * ACT_SCALE_GAIN));
    }

    // -- Pathway wavefront: light races from→to, then the wire glows + decays --
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const elapsed = now - p.t0;

      if (elapsed >= WF_LIFE) {
        ctx.pulseGroup.remove(p.mesh);
        p.mat.dispose();
        pulses.splice(i, 1);
        continue;
      }

      // Sample live node positions (updated each tick by 3d-force-graph)
      const fx = p.from.x || 0, fy = p.from.y || 0, fz = p.from.z || 0;
      const tx = p.to.x   || 0, ty = p.to.y   || 0, tz = p.to.z   || 0;

      const dx = tx - fx, dy = ty - fy, dz = tz - fz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (len < 0.001) {
        ctx.pulseGroup.remove(p.mesh);
        p.mat.dispose();
        pulses.splice(i, 1);
        continue;
      }

      // Span the FULL edge: midpoint position, Y-scale = edge length, oriented
      // along the edge. The shader (not the geometry) carries the moving light.
      p.mesh.position.set((fx + tx) / 2, (fy + ty) / 2, (fz + tz) / 2);
      p.mesh.scale.set(1, len, 1);
      _dir.set(dx, dy, dz).normalize();
      _q.setFromUnitVectors(_up, _dir);
      p.mesh.setRotationFromQuaternion(_q);

      // Head sweeps 0→1 over WF_SWEEP, then holds at the far end while the wire
      // decays. Envelope = fast attack (easeOutCubic) × long ease-out decay.
      const wf   = Math.min(1, elapsed / WF_SWEEP);
      const up   = 1 - Math.pow(1 - Math.min(1, elapsed / WF_ATTACK), 3);
      const down = elapsed > WF_SWEEP ? 1 - _smooth01((elapsed - WF_SWEEP) / WF_DECAY) : 1;
      p.mat.uniforms.uWavefront.value = wf;
      p.mat.uniforms.uIntensity.value = up * down * 0.9;
    }

    // -- Node-flash halos: additive bloom sphere at each activated node --------
    // Each halo tracks a node's live position (same pattern as the pulses loop).
    // Envelope: grow 0 → HALO_RADIUS during attack, then ease-out fade.
    // Allocation-light: no per-frame `new`; position/scale set directly.
    for (let i = halos.length - 1; i >= 0; i--) {
      const h = halos[i];
      const elapsed = now - h.t0;

      if (elapsed >= HALO_LIFE_MS) {
        ctx.pulseGroup.remove(h.mesh);
        h.mat.dispose();
        halos.splice(i, 1);
        continue;
      }

      // Track node's live world position (force-graph updates x/y/z each tick)
      h.mesh.position.set(h.node.x || 0, h.node.y || 0, h.node.z || 0);

      // Grow→settle→fade. Eased grow (easeOutCubic) with a slight overshoot so it
      // breathes rather than pops; then a smooth ease-out fade of the glow
      // intensity. Scale grows to HALO_RADIUS; intensity carries the envelope.
      let scale, intensity;
      if (elapsed < HALO_ATTACK) {
        const t = elapsed / HALO_ATTACK;
        const e = 1 - Math.pow(1 - t, 3);          // easeOutCubic
        scale     = HALO_RADIUS * (0.6 + 0.45 * e); // grow from 0.6→1.05R (soft overshoot)
        intensity = e * h.level;
      } else {
        const t = (elapsed - HALO_ATTACK) / (HALO_LIFE_MS - HALO_ATTACK);
        scale     = HALO_RADIUS * (1.05 - 0.05 * _smooth01(t)); // settle 1.05R→1.0R
        intensity = (1 - _smooth01(t)) * h.level;
      }
      h.mesh.scale.setScalar(scale < 0.001 ? 0.001 : scale);
      if (h.mat.uniforms && h.mat.uniforms.uIntensity) {
        h.mat.uniforms.uIntensity.value = intensity;
      }
    }
  }

  // Register the tick callback with the stats master rAF loop (Plan 06).
  // The central loop governs all idle throttling — trace registers here only.
  ctx.registerTick(tick);

  // ── Layer 3 — Ambient twinkle tick (Phase 54) ────────────────────────────
  // Breathes a rotating subset of haze nodes with a neutral/cool tint on the
  // master rAF loop. Idle loop runs at IDLE_FPS (24) — no keep-alive needed
  // (confirmed in 54-RESEARCH.md: the master loop never sleeps while visible).
  //
  // Invariants:
  //   - setColorAt only — never setMatrixAt (SC5 perf invariant)
  //   - no spawnPulse, no halo, no ctx.revealTrace (SC3: twinkle fabricates nothing)
  //   - no size/scale changes on any node
  //   - subset built lazily once, rotated every TWINKLE_COUNT frames (Pitfall 2)
  //   - active nodes are skipped so a live/replay flash is never dimmed

  // Twinkle state (persistent across frames, scoped to initTrace closure)
  let twinkleSubset  = []; // persistent haze subset (built lazily)
  let twinklePtr     = 0;  // window-start pointer for subset rotation
  let twinkleFrame   = 0;  // frame counter for rotation cadence

  // Pre-built neutral/cool tint — intentionally NOT HOT amber and NOT any
  // KIND_COLOR event hue, so twinkle reads as decorative ambient (SC3 / D-04).
  const TWINKLE_TINT = new THREE.Color(0x7a8a9a); // quiet blue-gray

  function twinkleTick(now) {
    // Lazy guard: hazeMesh / __hazeIdx are populated by graph.js after initTrace.
    if (!ctx.hazeMesh || !ctx.allNodes?.length) return;

    // Build (or rotate) the subset — never re-filter allNodes every frame (Pitfall 2).
    // Re-pick every TWINKLE_COUNT frames for visual variation.
    if (twinkleSubset.length === 0 ||
        (twinkleFrame > 0 && twinkleFrame % TWINKLE_COUNT === 0)) {
      const hazePool = ctx.allNodes.filter(n => n.__cat === 'haze' && n.__hazeIdx != null);
      if (hazePool.length === 0) return;
      const startIdx = (twinklePtr * TWINKLE_COUNT) % hazePool.length;
      twinkleSubset = [];
      for (let i = 0; i < Math.min(TWINKLE_COUNT, hazePool.length); i++) {
        twinkleSubset.push(hazePool[(startIdx + i) % hazePool.length]);
      }
      twinklePtr++;
    }
    twinkleFrame++;

    // Per-node sine breathe: stateless, keyed on (now + __hazeIdx * OFFSET) so
    // each node breathes at a slightly different phase for visual spread.
    const TWO_PI = 2 * Math.PI;
    const OFFSET = 750; // per-instance phase spread (ms)
    let didUpdate = false;

    for (const node of twinkleSubset) {
      if (active.has(node)) continue;               // live/replay flash has priority
      if (node.__hazeIdx == null || !node.__hazeBase) continue; // safety guard

      const phase = (now + node.__hazeIdx * OFFSET) / TWINKLE_PERIOD_MS * TWO_PI;
      const breath = TWINKLE_AMP * (0.5 + 0.5 * Math.sin(phase)); // range [0, TWINKLE_AMP]
      const twinkleColor = node.__hazeBase.clone().lerp(TWINKLE_TINT, breath);
      ctx.hazeMesh.setColorAt(node.__hazeIdx, twinkleColor);
      didUpdate = true;
    }

    // One needsUpdate per tick (not per node) — same pattern as the main tick
    if (didUpdate) ctx.hazeMesh.instanceColor.needsUpdate = true;
  }

  // Register twinkleTick alongside the main tick on the master rAF loop.
  // Both run at IDLE_FPS (24) when idle; no additional scheduling needed.
  ctx.registerTick(twinkleTick);

  // Expose on ctx so callers (app.js, hud.js, detail.js) can reach them
  ctx.activate   = activate;
  ctx.spawnPulse = spawnPulse;

  // ── applyTrace(row) — honest payload-driven activation ────────────────────
  // Phase 52 rewrite: dispatches on row.kind for per-event vocabulary (Plan 03)
  // and falls through to the full recall path for recall / absent kind (Plan 02).
  //
  // Ingestion kinds handled (Plan 03):
  //   new_node        → quiet green blip on seed
  //   oscillation     → orange strobing pulse on seed (three re-triggers)
  //   reconsolidation → D-05 choreography: green arriving blip → magenta flash
  //   <other>         → muted neutral (non-amber) background consolidation
  //
  // Recall path (kind absent / null / 'recall') is byte-identical to Plan 02:
  //   lights ALL seeds ∝ score + ALL real 1-hop hops from payload; no BFS.
  //
  // Back-compat: bare string[] wraps into {seeds, hops:[]} before dispatch.
  // Called by SSE listener (hud.js) and local test trigger — same function.
  function applyTrace(row) {
    // Back-compat: bare string[] → synthetic row (legacy SSE shape before Phase 52)
    if (Array.isArray(row)) {
      row = { seeds: row, hops: [] };
    }

    // ── Layer 2 — Replay echo (Phase 54): re-render real hops at reduced intensity ─
    // Slots BEFORE kind dispatch so a replay row never enters _applyIngestion.
    // Uses the same honest seed/hop resolution as the recall path; never ctx.adj.
    // Intensity is intensity * REPLAY_DIM so replay is strictly dimmer than live (SC3).
    if (row.replay === true) {
      const rawSeeds = row.seeds || [];
      if (!rawSeeds.length) return;           // Pitfall 3: empty row → silent no-op

      const visited = new Set();
      const seedEntries = [];                 // {node, intensity}

      for (const raw of rawSeeds) {
        const { node_id, score } = normalizeSeed(raw);
        if (!node_id || visited.has(node_id)) continue;
        const node = ctx.idMap.get(node_id);
        if (!node) continue;
        visited.add(node_id);
        const intensity = typeof score === 'number'
          ? Math.max(0.2, Math.min(1.0, score))
          : 0.5;
        seedEntries.push({ node, intensity });
      }

      if (!seedEntries.length) return;        // all seeds absent from idMap → no-op

      const hopEntries = traceEdgesFromHops(row, ctx.idMap)
        .map(({ node_id, score }) => {
          const node = ctx.idMap.get(node_id);
          if (!node) return null;
          const intensity = typeof score === 'number'
            ? Math.max(0.1, Math.min(0.5, score * 0.55))
            : 0.3;
          return { node, intensity };
        })
        .filter(Boolean);

      if (ctx.markAnimating) ctx.markAnimating(DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS);

      const pathNodes = seedEntries.map(e => e.node).concat(hopEntries.map(e => e.node));
      seedEntries.forEach(e => ctx.traceNodes.add(e.node.id));
      hopEntries.forEach(e => ctx.traceNodes.add(e.node.id));
      if (ctx.revealTrace) ctx.revealTrace(pathNodes, []);

      // Activate at REPLAY_DIM intensity — replay is always strictly dimmer than live (SC3)
      seedEntries.forEach(({ node, intensity }) => activate(node, intensity * REPLAY_DIM));
      hopEntries.forEach(({ node, intensity }) => activate(node, intensity * REPLAY_DIM));

      const fadeMs = DECAY_ATTACK_MS + DECAY_HOLD_MS + 500;
      setTimeout(() => {
        ctx.traceNodes.clear();
        ctx.traceLinks.clear();
        if (ctx.revealTrace) ctx.revealTrace(pathNodes, []);
      }, fadeMs);
      return;
    }

    // ── Dispatch: ingestion hero kinds branch to _applyIngestion ──────────────
    const kind = row.kind ?? null;
    if (kind && kind !== 'recall') {
      _applyIngestion(row, kind);
      return;
    }

    // ── Phase-02 recall path (unchanged behavior) ─────────────────────────────
    const rawSeeds = row.seeds || [];
    const seedLog = rawSeeds.map(s => typeof s === 'string' ? s : s.node_id);
    if (ctx.logEvent) {
      ctx.logEvent('trace', `seeds=[${seedLog.join(',')}] hops=${(row.hops || []).length}`);
    }

    // ── Resolve seeds against the idMap ──────────────────────────────────────
    // Normalize seed union type → {node_id, score} at the client boundary.
    // intensity ∝ score (D-07): null score → fixed mid intensity (WR-02).
    const visited = new Set();
    const seedEntries = []; // {node, intensity}

    for (const raw of rawSeeds) {
      const { node_id, score } = normalizeSeed(raw);
      if (!node_id || visited.has(node_id)) continue;
      const node = ctx.idMap.get(node_id);
      if (!node) continue;
      visited.add(node_id);
      // Map score to [0.2, 1.0]; null → 0.5 mid-intensity fallback (WR-02)
      const intensity = typeof score === 'number'
        ? Math.max(0.2, Math.min(1.0, score))
        : 0.5;
      seedEntries.push({ node, intensity });
    }

    if (!seedEntries.length) return;

    // ── Resolve hop nodes from the honest server payload (traceEdgesFromHops) ─
    // NO ctx.adj traversal — hop nodes come from row.hops ONLY.
    // Hop brightness gated on hop score ALONE (no edge.w — not in the honest
    // payload; deriving it would re-invent client adjacency, which this kills).
    const hopEntries = traceEdgesFromHops(row, ctx.idMap)
      .map(({ node_id, score }) => {
        const node = ctx.idMap.get(node_id);
        if (!node) return null;
        const intensity = typeof score === 'number'
          ? Math.max(0.1, Math.min(0.5, score * 0.55))
          : 0.3; // mid fallback for null-score hops (schema-recall path)
        return { node, intensity };
      })
      .filter(Boolean);

    // ── Mark framerate hold for the decay window ──────────────────────────────
    const decayWindowMs = DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS;
    if (ctx.markAnimating) ctx.markAnimating(decayWindowMs);

    // ── Reveal pathway through the LOD ────────────────────────────────────────
    // Only nodes — no links (we have no honest seed→hop edges to reveal).
    const pathNodes = seedEntries.map(e => e.node)
      .concat(hopEntries.map(e => e.node));
    seedEntries.forEach(e => ctx.traceNodes.add(e.node.id));
    hopEntries.forEach(e => ctx.traceNodes.add(e.node.id));
    if (ctx.revealTrace) ctx.revealTrace(pathNodes, []);

    // ── Activate all seeds at score-proportional intensity (D-07) ─────────────
    seedEntries.forEach(({ node, intensity }) => activate(node, intensity));

    // ── Activate hop nodes at subordinate (dimmer) intensity ──────────────────
    // Gated on hop score alone; thinner/dimmer than seeds per spec.
    hopEntries.forEach(({ node, intensity }) => activate(node, intensity));

    // ── Fade the pathway back after the decay window ───────────────────────────
    const fadeMs = DECAY_ATTACK_MS + DECAY_HOLD_MS + 500;
    setTimeout(() => {
      ctx.traceNodes.clear();
      ctx.traceLinks.clear();
      if (ctx.revealTrace) ctx.revealTrace(pathNodes, []);
    }, fadeMs);
  }

  // ── _applyIngestion(row, kind) — per-kind ingestion color + motion ──────────
  // Handles new_node / oscillation / reconsolidation and the neutral fallback
  // for all other consolidation-kind values (confirm / extend / schema_emitted /
  // entity_merge / fact_merge / contradict_hold / etc.).
  //
  // Operates ONLY on nodes already in ctx.idMap — never mutates Graph.graphData.
  // Missing seed node is always a no-op (never throws).
  // Intensity scales with seed score per D-07 (null score → kind-appropriate mid).
  function _applyIngestion(row, kind) {
    const rawSeeds = row.seeds || [];
    if (!rawSeeds.length) return;

    const { node_id: seedId, score: seedScore } = normalizeSeed(rawSeeds[0]);
    const seedNode = ctx.idMap.get(seedId);

    // ── new_node: quiet single green blip — no spreading ─────────────────────
    if (kind === 'new_node') {
      if (!seedNode) return;
      // Modest intensity (new nodes are background arrivals, not recall peaks)
      const intensity = typeof seedScore === 'number'
        ? Math.max(0.2, Math.min(0.7, seedScore))
        : 0.4;
      if (ctx.markAnimating) ctx.markAnimating(DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS);
      ctx.traceNodes.add(seedId);
      if (ctx.revealTrace) ctx.revealTrace([seedNode], []);
      if (ctx.logEvent) ctx.logEvent('trace', `kind=new_node seed=${seedId} intensity=${intensity.toFixed(2)}`);
      activate(seedNode, intensity, KIND_COLORS.new_node);
      return;
    }

    // ── oscillation: orange strobing pulse — visibly unsettled ───────────────
    if (kind === 'oscillation') {
      if (!seedNode) return;
      const intensity = typeof seedScore === 'number'
        ? Math.max(0.25, Math.min(0.85, seedScore))
        : 0.6;
      // Strobe window: 3 activations ~280ms apart; bounded (T-52-07 accept).
      if (ctx.markAnimating) ctx.markAnimating(DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS + 700);
      ctx.traceNodes.add(seedId);
      if (ctx.revealTrace) ctx.revealTrace([seedNode], []);
      if (ctx.logEvent) ctx.logEvent('trace', `kind=oscillation seed=${seedId} intensity=${intensity.toFixed(2)}`);
      activate(seedNode, intensity,        KIND_COLORS.oscillation);
      setTimeout(() => activate(seedNode, intensity * 0.75, KIND_COLORS.oscillation), 280);
      setTimeout(() => activate(seedNode, intensity * 0.55, KIND_COLORS.oscillation), 560);
      return;
    }

    // ── reconsolidation hero choreography (D-05) ──────────────────────────────
    // seed  = existing / superseded belief node (row.seeds[0], normalised)
    // hops[0] = arriving candidate (new evidence node, row.hops[0].node_id)
    //
    // Sequence:
    //   1. Green "arriving" blip: candidate → existing (subordinate spawnPulse)
    //   2. After blip arrives (~WF_SWEEP ms), magenta error-flash on existing node
    //   3. Standard decay envelope → settle
    //
    // CRITICAL (T-52-06): no Graph.graphData mutation; only existing idMap nodes.
    // Missing candidate → flash-only, still no throw.
    if (kind === 'reconsolidation') {
      if (!seedNode) return; // existing node not rendered — no-op
      const intensity = typeof seedScore === 'number'
        ? Math.max(0.3, Math.min(1.0, seedScore))
        : 0.65; // slightly above recall mid — this is the hero moment
      if (ctx.markAnimating) ctx.markAnimating(WF_SWEEP + DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS);
      ctx.traceNodes.add(seedId);
      if (ctx.revealTrace) ctx.revealTrace([seedNode], []);
      if (ctx.logEvent) ctx.logEvent('trace', `kind=reconsolidation seed=${seedId} intensity=${intensity.toFixed(2)}`);

      const hops = row.hops || [];
      const candidateHop = hops[0];
      const candidateNode = candidateHop ? ctx.idMap.get(candidateHop.node_id) : null;

      if (candidateNode) {
        // Subordinate green blip: candidate → existing node
        ctx.traceNodes.add(candidateHop.node_id);
        if (ctx.revealTrace) ctx.revealTrace([candidateNode, seedNode], []);
        spawnPulse(candidateNode, seedNode, KIND_COLORS.new_node);
        // After blip arrives, flash the existing node magenta
        setTimeout(() => {
          if (!ctx.idMap.has(seedId)) return; // guard: node could have been removed
          activate(seedNode, intensity, KIND_COLORS.reconsolidation);
        }, WF_SWEEP);
      } else {
        // Candidate not in rendered graph — flash directly (graceful degradation)
        activate(seedNode, intensity, KIND_COLORS.reconsolidation);
      }
      return;
    }

    // ── neutral fallback — all other consolidation kinds (D-03 / D-04) ────────
    // confirm / extend / schema_emitted / entity_merge / fact_merge /
    // contradict_hold / etc. → muted slate; never amber.
    if (!seedNode) return;
    const intensity = typeof seedScore === 'number'
      ? Math.max(0.15, Math.min(0.5, seedScore * 0.6))
      : 0.25; // low enough to read as background; never competes with recall amber
    if (ctx.markAnimating) ctx.markAnimating(DECAY_ATTACK_MS + DECAY_HOLD_MS + PULSE_MS);
    ctx.traceNodes.add(seedId);
    if (ctx.revealTrace) ctx.revealTrace([seedNode], []);
    if (ctx.logEvent) ctx.logEvent('trace', `kind=${kind} (neutral) seed=${seedId} intensity=${intensity.toFixed(2)}`);
    activate(seedNode, intensity, KIND_COLORS.neutral);
  }

  ctx.applyTrace = applyTrace;

  // ── Local test-trace trigger (D-102: same applyTrace as the SSE path) ─────
  // Wires #btn-test-trace to pick the best-connected visible nodes and build a
  // synthetic row from ctx.adj — confirming SSE and local paths share applyTrace.
  const btnTrace = document.getElementById('btn-test-trace');
  if (btnTrace) {
    btnTrace.addEventListener('click', () => {
      const visible = (ctx.allNodes || []).filter(n =>
        ctx.nodeVisible ? ctx.nodeVisible(n) : true
      );
      if (!visible.length) {
        if (ctx.logEvent) ctx.logEvent('trace', 'no visible nodes for test trace');
        return;
      }
      // Pick the 3 nodes with the highest adjacency degree as seeds
      const scored = visible
        .map(n => ({ n, deg: (ctx.adj.get(n.id) || []).length }))
        .sort((a, b) => b.deg - a.deg);
      const seedNodes = scored.slice(0, 3).map((x, i) => ({
        node_id: x.n.id,
        score: Math.max(0.2, 1.0 - i * 0.25), // descending: 1.0, 0.75, 0.5
      }));

      // Build hop set from ctx.adj for the synthetic test row
      const hopSet = new Set();
      const seedIds = new Set(seedNodes.map(s => s.node_id));
      for (const { node_id } of seedNodes) {
        const edges = ctx.adj.get(node_id) || [];
        for (const edge of edges.slice(0, 5)) {
          const src = typeof edge.source === 'object' ? edge.source.id : edge.source;
          const tgt = typeof edge.target === 'object' ? edge.target.id : edge.target;
          const nbId = src === node_id ? tgt : src;
          if (!seedIds.has(nbId)) hopSet.add(nbId);
          if (hopSet.size >= 15) break;
        }
        if (hopSet.size >= 15) break;
      }
      const syntheticRow = {
        seeds: seedNodes,
        hops:  [...hopSet].map(id => ({ node_id: id, score: null, hop: 1 })),
        kind:  'recall',
        query_id: `test-${Date.now()}`,
      };
      applyTrace(syntheticRow);
    });
  }
}
