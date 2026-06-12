/**
 * @module lod
 * brain-memory viz — schema-cluster LOD (Level of Detail) classification and
 * graph visibility callbacks.
 *
 * Preserves the exact observable semantics of the reference implementation
 * (src/viz/index.html lines 398–437): the overview stays at ~#schemas regardless
 * of total node count N; member nodes are hidden until their schema is drilled-in
 * or a trace reveals them; schema super-nodes float above the haze.
 *
 * Sets on ctx:
 *   nodeVisible   — (node) → boolean; LOD visibility predicate
 *   linkVis       — (link) → boolean; LOD link visibility predicate
 *   revealTrace   — () → void; re-applies nodeVisibility + linkVisibility on Graph
 *   expanded      — Set<schemaId>; schemas currently drilled-in by user
 *   traceNodes    — Set<nodeId>; nodes revealed by the active spreading-activation trace
 *   traceLinks    — Set<linkKey>; links revealed by the active trace
 *   memberSchema  — Map<memberId, schemaId>; inverse of 'abstracts' edges
 *   linkKey       — (link) → string; canonical '|'-delimited edge key
 *
 * Call order (enforced by app.js, Plan 07):
 *   initLod(ctx)   — classification + set callbacks on ctx
 *   initGraph(ctx) — wires nodeVisibility / linkVisibility reading ctx lazily
 *
 * @param {import('./constants.js').Ctx} ctx
 */

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

  // Compact viewports (tray popover ≤500px): glance surface, not exploration —
  // haze hidden at rest so the popover shows the schema constellation; traces
  // still reveal full pathways (founder: 1.8k nodes at 300px read as fog).
  const compact = Math.min(window.innerWidth, window.innerHeight) <= 500;

  const nodeVisible = n => {
    if (!n) return false;
    // Schema nodes are always visible in the overview
    if (n.__cat === 'schema') return true;
    // Haze: visible in the full window; in compact only when a trace lights it
    if (n.__cat === 'haze') return !compact || traceNodes.has(n.id);
    // Member nodes: show only if their schema is drilled-in OR the trace reveals them
    return expanded.has(n.__schemaId) || traceNodes.has(n.id);
  };

  const linkVis = l => {
    // Trace links are always visible (pathway highlight)
    if (traceLinks.has(linkKey(l))) return true;

    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;

    // 'abstracts' edges: show only while the schema is drilled-in
    if (l.kind === 'abstracts') return expanded.has(sid);

    // All other edges: show when both endpoints are visible AND at least one
    // endpoint's schema is expanded (keeps inter-member edges tidy in overview)
    return nodeVisible(idMap ? idMap.get(sid) : null) &&
           nodeVisible(idMap ? idMap.get(tid) : null) &&
           (expanded.has(memberSchema.get(sid)) ||
            expanded.has(memberSchema.get(tid)));
  };

  // ── revealTrace ────────────────────────────────────────────────────────
  // Re-applies nodeVisibility and linkVisibility on the Graph instance.
  // Called by trace.js after mutating traceNodes / traceLinks, and by
  // graph.js on schema expand/collapse.
  //
  // ctx.Graph is set by initGraph (which runs after initLod), so the
  // closure reference is safe — revealTrace is only called post-init.
  function revealTrace() {
    if (!ctx.Graph) return;
    ctx.Graph.nodeVisibility(nodeVisible);
    ctx.Graph.linkVisibility(linkVis);
  }

  // ── Publish onto ctx ───────────────────────────────────────────────────
  ctx.nodeVisible  = nodeVisible;
  ctx.linkVis      = linkVis;
  ctx.revealTrace  = revealTrace;
  ctx.expanded     = expanded;
  ctx.traceNodes   = traceNodes;
  ctx.traceLinks   = traceLinks;
  ctx.memberSchema = memberSchema;
  ctx.linkKey      = linkKey;
}
