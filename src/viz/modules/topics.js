/**
 * @module topics
 * recense viz — topic browser (Phase 19 / VIZ-08, exploration revision).
 *
 * initTopics(ctx) renders a broad-entry list of every schema ("topic") in the
 * graph so a user can start exploring WITHOUT first finding a node: see all
 * topics, click one to light its whole region. Clicking routes through
 * ctx.selectNode(schemaNode), which already (Plan 19-02) glows the schema + its
 * abstracts-members as a cohesive region and opens the detail panel — so topic
 * membership stays engine-served (SC2), not a client-side approximation.
 *
 * Full-window only (gated by .mode-window CSS on #topic-wrap); graceful no-op
 * when the topic DOM is absent (popover / detail-page modes).
 *
 * Data timing: app.js builds ctx.allNodes / ctx.idMap / ctx.adj before any
 * initX(ctx) call (top-level await on /graph), so the schema set is available
 * synchronously here. The set is static for the session (the graph reloads only
 * on a full page boot), so we render once.
 *
 * Security: T-10-12 — topic names + counts reach the DOM via textContent only.
 * Palette: amber appears only as a hover/active border tint on HTML chrome; the
 * node glow itself is a Three.js material change via ctx.selectNode/ctx.activate.
 */

export function initTopics(ctx) {
  const wrapEl = document.getElementById('topic-wrap');
  const listEl = document.getElementById('topic-list');
  if (!wrapEl || !listEl) return;  // graceful no-op (popover / detail-page)

  // Resolve the edge endpoint id whether or not 3d-force-graph has replaced
  // string endpoints with node objects yet.
  const endId = v => (typeof v === 'object' && v ? v.id : v);

  /** Count a schema's abstracts-members (outgoing schema → member edges). */
  function memberCount(schema) {
    const edges = (ctx.adj && ctx.adj.get(schema.id)) || [];
    let n = 0;
    for (const e of edges) {
      if (e.kind === 'abstracts' && endId(e.source) === schema.id) n++;
    }
    return n;
  }

  // Schema set from the raw payload field `type` (always present; __cat may not
  // be assigned until 3d-force-graph builds the node meshes). Skip tombstoned.
  const schemas = (ctx.allNodes || [])
    .filter(n => n.type === 'schema' && !n.tombstoned)
    .map(n => ({ node: n, count: memberCount(n) }))
    .sort((a, b) => b.count - a.count || (a.node.value || '').localeCompare(b.node.value || ''));

  function render() {
    listEl.textContent = '';   // textContent '' clears children (T-10-12 safe)
    for (const { node, count } of schemas) {
      const row = document.createElement('div');
      row.className = 'topic-row';
      row.setAttribute('role', 'option');

      const name = document.createElement('span');
      name.className = 'topic-name';
      name.textContent = (node.value || node.id || '').slice(0, 60);
      row.appendChild(name);

      const cnt = document.createElement('span');
      cnt.className = 'topic-count';
      cnt.textContent = String(count);
      row.appendChild(cnt);

      // Hover: peek the schema node in space. Click: light the whole region.
      row.addEventListener('mouseenter', () => { if (ctx.activate) ctx.activate(node, 1.0); });
      row.addEventListener('click', () => {
        if (ctx.selectNode) ctx.selectNode(node);   // 19-02 region glow + detail
        if (ctx.markActive) ctx.markActive();
      });
      listEl.appendChild(row);
    }
  }

  render();
}
