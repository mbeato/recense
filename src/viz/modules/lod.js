/**
 * @module lod
 * recense viz — schema-cluster LOD (Level of Detail) classification and
 * graph visibility callbacks.
 *
 * Preserves the exact observable semantics of the reference implementation
 * (src/viz/index.html lines 398–437): the overview stays at ~#schemas regardless
 * of total node count N; member nodes are hidden until their schema is drilled-in
 * or a trace reveals them; schema super-nodes float above the haze.
 *
 * Sets on ctx:
 *   nodeVisible       — (node) → boolean; LOD visibility predicate
 *   linkVis           — (link) → boolean; LOD link visibility predicate
 *   refreshVisibility — () → void; full-graph re-eval (re-applies nodeVisibility +
 *                       linkVisibility on Graph); reserved for global LOD changes
 *                       (schema expand/collapse in graph.js)
 *   revealTrace       — (pathNodes, pathLinks) → void; TRACE-ONLY delta sync that
 *                       flips .visible directly on the bounded pathway object set
 *                       (compare-before-write; zero writes when already in sync)
 *   expanded          — Set<schemaId>; schemas currently drilled-in by user
 *   traceNodes        — Set<nodeId>; nodes revealed by the active spreading-activation trace
 *   traceLinks        — Set<linkKey>; links revealed by the active trace
 *   memberSchema      — Map<memberId, schemaId>; inverse of 'abstracts' edges
 *   linkKey           — (link) → string; canonical '|'-delimited edge key
 *
 * Call order (enforced by app.js, Plan 07):
 *   initLod(ctx)   — classification + set callbacks on ctx
 *   initGraph(ctx) — wires nodeVisibility / linkVisibility reading ctx lazily
 *
 * @param {import('./constants.js').Ctx} ctx
 */

import {
  DENSITY_FILL_BELOW,
  DENSITY_FILL_TARGET,
  DENSITY_THIN_START,
  DENSITY_THIN_FULL,
  HAZE_DENSE_SCALE,
  HOT,
} from './constants.js';

// Lazily-initialised haze trace-highlight color (THREE.Color built on first use
// via ctx.THREE to avoid importing THREE in lod.js — lod.js is tested standalone
// in vitest/Node where the 'three' package isn't wired). Reused across calls.
let _traceColor = null;
function _getTraceColor(THREE) {
  if (!_traceColor) _traceColor = new THREE.Color(HOT);
  return _traceColor;
}

export function initLod(ctx) {
  const { allNodes, allLinks, idMap } = ctx;

  // ── Classification ──────────────────────────────────────────────────────
  // Build schemaMembers and memberSchema from 'abstracts' edges.
  // An 'abstracts' link is: source=schema, target=member.

  const schemaMembers = new Map(); // schemaId → Set<memberId>
  const memberSchema  = new Map(); // memberId → schemaId

  for (const l of allLinks) {
    if (l.kind !== 'abstracts') continue;
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const m = typeof l.target === 'object' ? l.target.id : l.target;
    if (!schemaMembers.has(s)) schemaMembers.set(s, new Set());
    schemaMembers.get(s).add(m);
    if (!memberSchema.has(m)) memberSchema.set(m, s);
  }

  // Classify every node into one of three LOD categories:
  //   'schema'  — an explicit schema node (has outgoing 'abstracts' edges)
  //   'member'  — a node abstracted by a schema (has an incoming 'abstracts' edge)
  //   'haze'    — everything else (unclassified; visible in overview)
  for (const n of allNodes) {
    if (n.type === 'schema') {
      n.__cat     = 'schema';
      n.__members = (schemaMembers.get(n.id) || new Set()).size;
    } else if (memberSchema.has(n.id)) {
      n.__cat      = 'member';
      n.__schemaId = memberSchema.get(n.id);
    } else {
      n.__cat = 'haze';
    }
  }

  // ── Adaptive density (Phase 19 Item 2) ─────────────────────────────────
  // The overview renders only schema + haze; members are hidden. So screen
  // fullness tracks overviewCount = #schema + #haze. Adapt AROUND the founder's
  // calibrated neutral band (see constants.js) without touching absolute sizing.
  //
  //   sparse (overview < DENSITY_FILL_BELOW): reveal real hidden members,
  //     largest schemas first (so they cluster as coherent constellations around
  //     their hub), up to DENSITY_FILL_TARGET — capped by how many members exist.
  //     Never fabricates nodes (D-04 honesty); a tiny brain stays a tiny brain.
  //   dense (overview > DENSITY_THIN_START): lerp a haze-opacity multiplier
  //     1.0 → HAZE_DENSE_SCALE (consumed by graph.js makeNodeObject) so the
  //     unclassified noise recedes and the schema constellation reads through it.
  //
  // Computed once at init from the static classification — stable thereafter, so
  // refreshVisibility/revealTrace stay consistent.
  let overviewCount = 0;
  for (const n of allNodes) if (n.__cat === 'schema' || n.__cat === 'haze') overviewCount++;

  const densityRevealed = new Set(); // member ids force-shown to fill a sparse overview
  if (overviewCount < DENSITY_FILL_BELOW) {
    const budget = DENSITY_FILL_TARGET - overviewCount;
    // Largest schemas first → most coherent fill.
    const schemasBySize = [...schemaMembers.entries()]
      .sort((a, b) => b[1].size - a[1].size);
    outer:
    for (const [, members] of schemasBySize) {
      for (const m of members) {
        if (densityRevealed.size >= budget) break outer;
        densityRevealed.add(m);
      }
    }
  }

  // Haze-opacity multiplier: 1.0 in-band and when sparse, lerps to
  // HAZE_DENSE_SCALE between DENSITY_THIN_START and DENSITY_THIN_FULL.
  let hazeOpacityScale = 1;
  if (overviewCount > DENSITY_THIN_START) {
    const t = Math.min(1, (overviewCount - DENSITY_THIN_START) /
                          (DENSITY_THIN_FULL - DENSITY_THIN_START));
    hazeOpacityScale = 1 + t * (HAZE_DENSE_SCALE - 1);
  }

  // ── Visibility state ────────────────────────────────────────────────────
  // All three sets are mutated directly by graph.js (expand/collapse on click)
  // and trace.js (applyTrace / revealTrace cycle).

  const expanded   = new Set(); // schema ids currently drilled-in
  const traceNodes = new Set(); // node ids revealed by active trace
  const traceLinks = new Set(); // link keys revealed by active trace

  // ── linkKey ────────────────────────────────────────────────────────────
  // Canonical edge key with the literal '|' delimiter (not a control char).
  // Normalises source/target order so the same edge gets the same key
  // regardless of which endpoint appears first.
  const linkKey = l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return s < t ? s + '|' + t : t + '|' + s;
  };

  // ── Visibility callbacks ───────────────────────────────────────────────
  // These functions are called per-node/link by 3d-force-graph every frame.
  // They must be fast — no map construction, only Set.has() / Map.get().

  const nodeVisible = n => {
    if (!n) return false;
    // Schema and haze nodes are visible in the overview; in compact viewports
    // haze is rendered near-invisible instead of hidden (graph.js dims it) —
    // schema constellation forward, haze as barely-there mist (founder-tuned).
    if (n.__cat !== 'member') return true;
    // Member nodes: show if their schema is drilled-in, the trace reveals them,
    // OR adaptive density promoted them to fill a sparse overview.
    return expanded.has(n.__schemaId) || traceNodes.has(n.id) || densityRevealed.has(n.id);
  };

  const linkVis = l => {
    // Trace links are always visible (pathway highlight)
    if (traceLinks.has(linkKey(l))) return true;

    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;

    // Focus-unhaze: a haze node promoted on focus (graph.js focusHazeNeighborhood)
    // adds itself + its haze neighbors to ctx.focusedHaze. Both endpoints in that
    // set are both promoted-and-visible haze nodes, so show the connecting edge —
    // normal linkVis below would reject it (haze nodes have no expanded schema).
    if (ctx.focusedHaze && ctx.focusedHaze.has(sid) && ctx.focusedHaze.has(tid)) return true;

    // 'abstracts' edges (source=schema, target=member): show while the schema is
    // drilled-in OR the member was density-revealed (connects the revealed member
    // to its hub so a sparse overview reads as a constellation, not loose dots).
    if (l.kind === 'abstracts') return expanded.has(sid) || densityRevealed.has(tid);

    // All other edges: show when both endpoints are visible AND at least one
    // endpoint's schema is expanded (keeps inter-member edges tidy in overview)
    return nodeVisible(idMap ? idMap.get(sid) : null) &&
           nodeVisible(idMap ? idMap.get(tid) : null) &&
           (expanded.has(memberSchema.get(sid)) ||
            expanded.has(memberSchema.get(tid)));
  };

  // ── refreshVisibility ──────────────────────────────────────────────────
  // FULL-GRAPH re-eval: re-applies nodeVisibility and linkVisibility on the
  // Graph instance, which synchronously re-digests every node/link object.
  // Reserved for global LOD changes (schema expand/collapse in graph.js),
  // where the preceding Graph.graphData(...) swap re-digests anyway.
  //
  // ctx.Graph is set by initGraph (which runs after initLod), so the
  // closure reference is safe — refreshVisibility is only called post-init.
  function refreshVisibility() {
    if (!ctx.Graph) return;
    ctx.Graph.nodeVisibility(nodeVisible);
    ctx.Graph.linkVisibility(linkVis);
  }

  // ── revealTrace ────────────────────────────────────────────────────────
  // TRACE-ONLY delta sync. A trace touches a bounded set (seeds +
  // ≤TRACE_MAX_EDGES revealed nodes/links), so instead of the full-graph
  // re-digest above, flip .visible directly on the bounded set's three.js
  // objects (node.__threeObj / link.__lineObj — this graph uses no arrows
  // or particles). Compare-before-write IS the fast path: when the whole
  // pathway is already visible under the current LOD (common case), the
  // loop performs zero writes and never touches the Graph setters.
  //
  // The same call serves both phases of the trace lifecycle:
  //   arrival   — trace.js has ADDED to traceNodes/traceLinks, so the
  //               predicates now return true → hidden members flip on;
  //   fade-back — trace.js has CLEARED the sets, so the predicates return
  //               the plain LOD answer → trace-only reveals flip off, while
  //               nodes whose schema got expanded mid-trace correctly stay
  //               visible. Re-evaluating the predicate on the same bounded
  //               object set hides exactly what the trace revealed without
  //               separate bookkeeping.
  //
  // Nodes without __threeObj (tombstone-filtered, not in graphData) are
  // skipped — they have no scene object to flip.
  function revealTrace(pathNodes, pathLinks) {
    if (!ctx.Graph) return;
    let hazeColorDirty = false;
    for (const n of (pathNodes || [])) {
      // ── Haze nodes: no __threeObj (excluded from graphData); highlight via
      // per-instance color bump on the InstancedMesh. Trace reveal = HOT amber;
      // trace clear = restore __hazeBase. D-04: amber only on real activation.
      if (n.__cat === 'haze') {
        if (!ctx.hazeMesh || n.__hazeIdx == null) continue;
        const lit = traceNodes.has(n.id);
        const traceCol = ctx.THREE ? _getTraceColor(ctx.THREE) : null;
        if (!traceCol && lit) continue; // no THREE yet — skip highlight safely
        ctx.hazeMesh.setColorAt(n.__hazeIdx, lit ? traceCol : n.__hazeBase);
        hazeColorDirty = true;
        continue;
      }
      if (!n.__threeObj) continue;
      const desired = nodeVisible(n);
      if (n.__threeObj.visible !== desired) n.__threeObj.visible = desired;
    }
    if (hazeColorDirty && ctx.hazeMesh && ctx.hazeMesh.instanceColor) {
      ctx.hazeMesh.instanceColor.needsUpdate = true;
    }
    for (const l of (pathLinks || [])) {
      if (!l.__lineObj) continue;
      const desired = linkVis(l);
      if (l.__lineObj.visible !== desired) l.__lineObj.visible = desired;
    }
  }

  // ── Publish onto ctx ───────────────────────────────────────────────────
  ctx.nodeVisible       = nodeVisible;
  ctx.linkVis           = linkVis;
  ctx.refreshVisibility = refreshVisibility;
  ctx.revealTrace       = revealTrace;
  ctx.expanded          = expanded;
  ctx.traceNodes        = traceNodes;
  ctx.traceLinks        = traceLinks;
  ctx.memberSchema      = memberSchema;
  ctx.linkKey           = linkKey;
  ctx.densityRevealed   = densityRevealed;   // member ids force-shown when sparse
  ctx.hazeOpacityScale  = hazeOpacityScale;  // graph.js multiplies HAZE_OPACITY by this
}
