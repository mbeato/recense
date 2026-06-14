/**
 * @module trace
 * brain-memory viz — spreading-activation module.
 *
 * initTrace(ctx) sets ctx.activate, ctx.spawnPulse, and ctx.applyTrace.
 *
 * Per-frame animation work is registered via ctx.registerTick (owned by
 * stats.js master rAF loop, Plan 06). This module registers its tick with
 * the central loop and does not own its own frame scheduling.
 *
 * Locked semantics (D-102 / D-09):
 *   - applyTrace runs multi-hop BFS spreading activation: seeds pulse, hop
 *     waves propagate outward, the pathway is revealed through the LOD then
 *     fades.
 *   - The per-frame activation loop touches ONLY the active Set, never the
 *     full graph, and never calls Graph.refresh().
 *   - spawnPulse lights a traveling segment along each edge as energy
 *     propagates source→dest.
 *   - The same applyTrace serves both SSE traces and the local test trigger
 *     (D-102 proof).
 */

import * as THREE from 'three';
import {
  HOT,
  MAX_HOPS,
  HOP_MS,
  TRACE_FANOUT,
  TRACE_MAX_EDGES,
  PULSE_MS,
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
// Sweep slowed (520→850) so the light visibly travels the wire rather than
// snapping; decay lengthened (900→1150) so each trace lingers longer on screen.
const WF_ATTACK = 140;
const WF_SWEEP  = 850;
const WF_DECAY  = 1150;
const WF_LIFE   = WF_SWEEP + WF_DECAY;

/** Clamped smoothstep on [0,1]. */
function _smooth01(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }

// ============================================================================
// initTrace(ctx) — entry point
// ============================================================================

export function initTrace(ctx) {
  // ── Shared wavefront geometry: unit-height tube, scaled to each edge's length
  // on Y and oriented along the edge. Thin radius gives the wire body so the glow
  // reads without looking like a fat rod. One allocation for all wavefront meshes.
  const _pulseGeo = new THREE.CylinderGeometry(1.3, 1.3, 1, 6, 1);

  // Convert HOT constant to a THREE.Color for lerping
  const HOT_COLOR = new THREE.Color(HOT);

  // Active node Set — the tick callback walks ONLY this set, never allNodes
  const active = new Set();

  // In-flight traveling pulse records
  const pulses = [];

  // ── activate(node, level) ─────────────────────────────────────────────────
  // Raises the node's activation level and enqueues it for animation.
  // No-op if the node has no material (not yet rendered).
  function activate(node, level) {
    if (!node || !node.__mat) return;
    node.__act = Math.max(node.__act || 0, level);
    active.add(node);
  }

  // ── spawnPulse(from, to) ──────────────────────────────────────────────────
  // Ignites a full-edge wavefront: a band of amber light races from→to and the
  // wire glows then decays (see WAVEFRONT_* shader above). Uses the shared
  // _pulseGeo; each wavefront owns only its (cheap) ShaderMaterial, disposed on
  // completion. Name kept for callers (trace BFS + detail.js ripple).
  function spawnPulse(from, to) {
    if (!ctx.pulseGroup || !from || !to) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor:     { value: HOT_COLOR },
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
      if (!node.__mat || !node.__mesh) {
        active.delete(node);
        continue;
      }
      node.__act -= dt * 0.6; // ~1.6 s full decay
      if (node.__act <= 0.001) {
        node.__act = 0;
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
      if (node.__base) node.__mat.color.copy(node.__base).lerp(HOT_COLOR, a * 0.8);
      node.__mat.opacity = Math.min(1, (node.__baseOp || 0.85) + a * 0.4);
      node.__mesh.scale.setScalar((node.__baseR || 1) * (1 + a * 0.35));
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
  }

  // Register the tick callback with the stats master rAF loop (Plan 06).
  // The central loop governs all idle throttling — trace registers here only.
  ctx.registerTick(tick);

  // Expose on ctx so callers (app.js, hud.js) can reach them
  ctx.activate   = activate;
  ctx.spawnPulse = spawnPulse;

  // ── applyTrace(seedIds) — BFS spreading activation ────────────────────────
  // Locked semantics: resolve seeds → BFS hop-waves → reveal pathway through
  // LOD → animate pulses per hop → fade pathway back.
  // Called by both the SSE trace listener (hud.js) and the local test trigger
  // — the same function in both cases (D-102 proof).
  function applyTrace(seedIds) {
    if (ctx.logEvent) {
      ctx.logEvent('trace', `seeds=[${(seedIds || []).join(',')}]`);
    }

    // Resolve and deduplicate seed ids → node objects
    const visited = new Set();
    const seeds = [];
    for (const sid of (seedIds || [])) {
      const s = ctx.idMap.get(sid);
      if (s && !visited.has(sid)) {
        visited.add(sid);
        seeds.push(s);
      }
    }
    if (!seeds.length) return;

    // BFS outward — build hop-ordered waves
    const waves = [];
    let frontier = seeds;
    let budget = TRACE_MAX_EDGES;

    for (let hop = 1; hop <= MAX_HOPS && frontier.length && budget > 0; hop++) {
      const wave = [];
      const next = [];

      for (const node of frontier) {
        const edges = (ctx.adj.get(node.id) || []).slice(0, TRACE_FANOUT);
        for (const edge of edges) {
          // ctx.adj lists each edge under BOTH endpoints, so the neighbor is
          // whichever endpoint is NOT the frontier node (same pattern as
          // detail.js getConnections) — always taking edge.target would drop
          // every incoming edge as a self-visit.
          const sid = typeof edge.source === 'object' ? edge.source.id : edge.source;
          const tid = typeof edge.target === 'object' ? edge.target.id : edge.target;
          const nbId = sid === node.id ? tid : sid;
          const nb = ctx.idMap.get(nbId);
          if (!nb || visited.has(nb.id)) continue;
          // Spend budget only on edges actually traversed, not on skips
          if (budget-- <= 0) break;
          visited.add(nb.id);
          wave.push({ edge, from: node, to: nb });
          next.push(nb);
        }
      }
      if (wave.length) waves.push(wave);
      frontier = next;
    }

    // Hold full framerate for the whole trace window WITHOUT resetting the
    // idle timer (D-07) — covers hop scheduling + final pulse + pathway
    // fade-back (waves.length*HOP_MS + 2800) + activation decay tail (~1.6s,
    // rounded up). Over-estimating only costs full-rate frames.
    if (ctx.markAnimating) ctx.markAnimating(waves.length * HOP_MS + PULSE_MS + 2800 + 1800);

    // Reveal pathway through the LOD before pulses start. Collect the bounded
    // pathway object set (seeds + every BFS-revealed node/edge) so revealTrace
    // can delta-sync .visible on just these objects instead of re-digesting
    // the full graph (the old full re-eval caused a visible frame hitch).
    const pathNodes = [...seeds];
    const pathLinks = [];
    seeds.forEach(s => ctx.traceNodes.add(s.id));
    for (const wave of waves) {
      for (const { edge, to } of wave) {
        ctx.traceNodes.add(to.id);
        ctx.traceLinks.add(ctx.linkKey(edge));
        pathNodes.push(to);
        pathLinks.push(edge);
      }
    }
    ctx.revealTrace(pathNodes, pathLinks);

    // Activate all seeds immediately at full intensity
    seeds.forEach(s => activate(s, 1.0));

    // Schedule per-hop waves: HOP_MS between hops, 35 ms intra-wave stagger
    waves.forEach((wave, h) => {
      const intensity = Math.max(0.3, 1 - (h + 1) * 0.18);
      setTimeout(() => {
        wave.forEach(({ from, to }, i) => {
          setTimeout(() => {
            spawnPulse(from, to);
            setTimeout(() => activate(to, intensity), PULSE_MS * 0.6);
          }, i * 35);
        });
      }, h * HOP_MS);
    });

    // Fade the pathway back after all pulses have had time to complete.
    // Re-evaluating the SAME bounded object set after clearing the sets hides
    // exactly what the trace revealed (schemas expanded mid-trace stay visible).
    setTimeout(() => {
      ctx.traceNodes.clear();
      ctx.traceLinks.clear();
      ctx.revealTrace(pathNodes, pathLinks);
    }, waves.length * HOP_MS + 2800);
  }

  ctx.applyTrace = applyTrace;

  // ── Local test-trace trigger (D-102: same applyTrace as the SSE path) ─────
  // Wires #btn-test-trace to pick the best-connected visible nodes and call
  // the shared applyTrace — confirming SSE and local paths share the function.
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
      const seedIds = scored.slice(0, 3).map(x => x.n.id);
      applyTrace(seedIds);
    });
  }
}
