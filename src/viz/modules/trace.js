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

// ============================================================================
// initTrace(ctx) — entry point
// ============================================================================

export function initTrace(ctx) {
  // ── Shared pulse geometry (exactly one allocation for all pulse meshes) ───
  const _pulseGeo = new THREE.CylinderGeometry(1.5, 1.5, 1, 6, 1);

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
  // Creates a traveling lit-wire segment that sweeps from→to.
  // Uses the shared _pulseGeo; each pulse owns only its MeshBasicMaterial.
  function spawnPulse(from, to) {
    if (!ctx.pulseGroup || !from || !to) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,  // white-gold — pulses belong to the warm activation family
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(_pulseGeo, mat);
    ctx.pulseGroup.add(mesh);
    pulses.push({ from, to, t0: performance.now(), mesh });
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

    // -- Pulse travel: sweep lit segment source→tip then fade -----------------
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const t = (now - p.t0) / PULSE_MS;

      if (t >= 1) {
        // Completed: remove mesh and dispose per-pulse material
        ctx.pulseGroup.remove(p.mesh);
        p.mesh.material.dispose();
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
        p.mesh.material.dispose();
        pulses.splice(i, 1);
        continue;
      }

      // Tip advances from source to dest over the full PULSE_MS.
      // The lit segment is a short window behind the tip (~30 % of edge length).
      const tipFrac  = t;
      const tailFrac = Math.max(0, t - 0.35);

      const cx = fx + dx * ((tipFrac + tailFrac) / 2);
      const cy = fy + dy * ((tipFrac + tailFrac) / 2);
      const cz = fz + dz * ((tipFrac + tailFrac) / 2);
      const segLen = len * (tipFrac - tailFrac);

      p.mesh.position.set(cx, cy, cz);

      // Scale: cylinder height = 1, so Y-scale = segment length
      p.mesh.scale.set(1, Math.max(0.01, segLen), 1);

      // Align cylinder Y-axis to edge direction (shared scratch objects)
      _dir.set(dx, dy, dz).normalize();
      _q.setFromUnitVectors(_up, _dir);
      p.mesh.setRotationFromQuaternion(_q);

      // Opacity: ramp in quickly, sustain, fade out in final 20 %
      const fade =
        t < 0.1 ? t / 0.1
        : t < 0.8 ? 1
        : (1 - t) / 0.2;
      p.mesh.material.opacity = fade * 0.85;
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
