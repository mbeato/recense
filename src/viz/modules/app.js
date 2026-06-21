/**
 * @module app
 * recense viz — bootstrap entry module (Plan 15-07).
 *
 * Spike-001 load-order (non-negotiable):
 *   1. import THREE via the import map ('three' → ./vendor/three.module.js)
 *   2. window.THREE = THREE   ← MUST precede the UMD injection below
 *   3. await dynamic injection of ./vendor/3d-force-graph.min.js as a <script>
 *   4. fetch /graph (allNodes + allLinks) in parallel with ./vendor/brain-volume.json
 *   5. build idMap + adj BEFORE 3d-force-graph can mutate link.source / link.target
 *   6. construct shared ctx
 *   7. initStats → initHud → initLod → initGraph → initEffects → initTrace → initDetail
 *
 * Detail mode (quick-260612-sdk): when the page is loaded as /?detail=<id>
 * (the shell's adjacent detail window), the lean detail-page module renders
 * instead and ALL 3D/graph boot below is skipped — no UMD injection, no
 * scene, no module wiring.
 *
 * No CDN: all imports are local (import map resolves 'three'; ./vendor/ for UMD).
 */

import * as THREE from 'three';
import { initStats }   from './stats.js';
import { initHud }     from './hud.js';
import { initLod }     from './lod.js';
import { initGraph }   from './graph.js';
import { initEffects } from './effects.js';
import { initTrace }   from './trace.js';
import { initDetail }  from './detail.js';
import { initSearch }  from './search.js';
import { initTopics }  from './topics.js';
import { initReader }  from './reader.js';
import { initCorpus }  from './corpus.js';
import { initIndex }   from './index.js';

// ── Spike 001: window.THREE MUST be set BEFORE injecting 3d-force-graph.min.js ─
// The UMD bundle reads window.THREE at parse time to acquire the THREE namespace.
// If this assignment comes after the UMD script element, ForceGraph3D will not
// find THREE and the canvas will be black / throw immediately.
window.THREE = THREE;

// ── Detail mode branch — /?detail=<id> renders the lean detail page ──────────
const DETAIL_ID = new URLSearchParams(location.search).get('detail');

if (DETAIL_ID !== null) {
  const { renderDetailPage } = await import('./detail-page.js');
  await renderDetailPage(DETAIL_ID);
} else {

// ── Inject vendored 3d-force-graph UMD bundle ─────────────────────────────────
// We create the <script> element dynamically (rather than statically in index.html)
// so that the window.THREE assignment above is guaranteed to have run first.
// Top-level await suspends module evaluation here until the script fully loads.
await new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = './vendor/3d-force-graph.min.js';
  s.onload = resolve;
  s.onerror = () => reject(new Error('failed to load vendored 3d-force-graph.min.js'));
  document.head.appendChild(s);
});

// ── Inject vendored 2D force-graph UMD bundle (READER-04 corpus graph) ────────
// The flat Obsidian-style doc→doc corpus view (corpus.js) uses the 2D `force-graph`
// library — the canvas sibling of 3d-force-graph (same author), exposing window.ForceGraph.
// It has NO THREE dependency (pure 2D canvas). Injected here alongside the 3D bundle so
// corpus.js can lazy-init on first Corpus open. Non-fatal on failure: the brain still works;
// only the corpus toggle is unavailable (corpus.js guards on typeof window.ForceGraph).
await new Promise((resolve) => {
  const s = document.createElement('script');
  s.src = './vendor/force-graph.min.js';
  s.onload = resolve;
  s.onerror = () => resolve(); // non-fatal — corpus.js no-ops if window.ForceGraph absent
  document.head.appendChild(s);
});

// Tag the document so chrome (e.g. #btn-recenter) can align with each shell's
// injected affordance: the popover (?shell=1) carries the expand button at
// top:6/right:8 (26px); the promoted app window carries the collapse button at
// top:10/right:12 (larger). Drives the context CSS in styles.css.
document.documentElement.classList.add(
  new URLSearchParams(location.search).has('shell') ? 'mode-popover' : 'mode-window'
);

/** @type {Function} — read after UMD load guarantees it is populated */
const ForceGraph3D = window.ForceGraph3D;

// ── DOM refs used during bootstrap ────────────────────────────────────────────
const loadingEl = document.getElementById('detail-loading');

// ── Fetch graph data and brain-volume in parallel ─────────────────────────────
let allNodes = [];
let allLinks  = [];
let brainVol  = null;
let graphLoadError = false;

const [graphResult, volumeResult] = await Promise.allSettled([
  fetch('/graph').then(r => {
    if (!r.ok) throw new Error('GET /graph → ' + r.status);
    return r.json();
  }),
  fetch('./vendor/brain-volume.json').then(r => r.ok ? r.json() : null),
]);

// Process /graph result
if (graphResult.status === 'fulfilled') {
  const data = graphResult.value || {};
  allNodes = data.nodes || [];
  allLinks  = data.links  || [];
} else {
  graphLoadError = true;
  if (loadingEl) {
    loadingEl.textContent = 'Failed to load graph: ' + String(graphResult.reason);
  }
}

// Process brain-volume result (optional — no brainVol if absent/failed)
if (volumeResult.status === 'fulfilled' && volumeResult.value) {
  try {
    const vj      = volumeResult.value;
    const rawBits = atob(vj.bits);
    const bits    = new Uint8Array(rawBits.length);
    for (let i = 0; i < rawBits.length; i++) bits[i] = rawBits.charCodeAt(i);
    brainVol = { res: vj.res, bits, centroid: vj.centroid, normScale: vj.normScale };
  } catch (_) {
    // malformed volume — continue without occupancy containment
  }
}

// Empty-graph state: not an error, but worth surfacing
if (!graphLoadError && !allNodes.length && loadingEl) {
  loadingEl.textContent = 'No nodes in memory yet.';
}

// ── Build idMap + adjacency BEFORE 3d-force-graph mutates link endpoints ──────
// After graphData() is called, 3d-force-graph replaces link.source / link.target
// with node object references.  We must capture the original string IDs here so
// idMap and adj remain correct throughout the session.

/** @type {Map<string, Object>} node.id → node object */
const idMap = new Map();
for (const n of allNodes) idMap.set(n.id, n);

/** @type {Map<string, Array>} node.id → adjacency list (both directions) */
const adj = new Map();
for (const n of allNodes) adj.set(n.id, []);
for (const l of allLinks) {
  const sid = typeof l.source === 'object' ? l.source.id : l.source;
  const tid = typeof l.target === 'object' ? l.target.id : l.target;
  if (adj.has(sid)) adj.get(sid).push(l);
  if (adj.has(tid)) adj.get(tid).push(l);
}

// ── Shared context object ──────────────────────────────────────────────────────
// The single ctx object is passed to every initX(ctx) call.  Fields are populated
// progressively as each module initialises; only fields set before a module's init
// are guaranteed available in that module's synchronous init body.
// See constants.js for the complete @typedef.
const ctx = {
  THREE,
  ForceGraph3D,
  allNodes,
  allLinks,
  idMap,
  adj,
  brainVol,

  // getVisibleNodes respects the tombstone toggle managed by hud.js and excludes
  // haze nodes (instanced haze layer — graph.js renders them as one InstancedMesh,
  // so they must not enter the d3 force sim or the per-mesh ForceGraph3D system).
  // __cat is set by initLod (runs before initGraph), so the filter is correct at
  // the first getVisibleNodes() call inside initGraph.
  // (ctx.showTombstones is pre-seeded to false so this works before initHud runs)
  getVisibleNodes() {
    return allNodes.filter(n =>
      (n.__cat !== 'haze' || ctx.focusedHaze.has(n.id))
      && (ctx.showTombstones || !n.tombstoned)
    );
  },

  // getVisibleLinks mirrors getVisibleNodes: when tombstones are hidden, every
  // link touching a tombstoned endpoint must be dropped too — d3's link force
  // resolves endpoints against the supplied node array and THROWS on a miss
  // ("node not found"), so passing unfiltered links with filtered nodes kills
  // the layout. Also exclude any link incident to a haze node — haze nodes are
  // not in the force sim; a link to one would cause the same "node not found" throw.
  // Endpoints may be string ids (before the first graphData call)
  // or node object refs (after 3d-force-graph mutates them) — handle both.
  getVisibleLinks() {
    const ok = id => {
      const n = idMap.get(id);
      return n && (n.__cat !== 'haze' || ctx.focusedHaze.has(id))
        && (ctx.showTombstones || !n.tombstoned);
    };
    return allLinks.filter(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return ok(s) && ok(t);
    });
  },

  showTombstones: false,  // toggled by hud.js initHud's btn-tombstones handler

  // Haze node ids temporarily promoted into the real graph by a focus-unhaze
  // (graph.js focusHazeNeighborhood) — getVisibleNodes/Links + lod.linkVis honor
  // this set so a focused haze node + its 1-hop haze neighbors render as real
  // nodes with edges, restoring the pre-instancing focus behavior. Cleared on
  // deselect.
  focusedHaze: new Set(),
};

// ── Ordered module wiring ──────────────────────────────────────────────────────
// Dependency order — each module reads only ctx fields set by earlier inits:
//
//   initStats    provides: registerTick, markActive, isIdle, setTier
//   initHud      provides: logEvent, setSSEStatus; opens EventSource('/events') SSE
//   initLod      provides: nodeVisible, linkVis, revealTrace, expanded,
//                          traceNodes, traceLinks, memberSchema, linkKey
//   initGraph    creates:  Graph (reads nodeVisible/linkVis lazily via ctx closure)
//                          hullGroup, pulseGroup
//   initEffects  adds:     bloom pass + Fresnel hull mesh (reads Graph, registerTick)
//   initTrace    provides: applyTrace, activate, spawnPulse; registers its tick
//   initDetail   provides: selectNode, closeDetail (reads THREE, adj, idMap)

initStats(ctx);
initHud(ctx);
initLod(ctx);
initGraph(ctx);
initEffects(ctx);
initTrace(ctx);
initDetail(ctx);
initSearch(ctx);  // Plan 19-01: after initDetail — reads ctx.activate, ctx.Graph, ctx.allNodes
initTopics(ctx);  // Phase 19 exploration: topic browser — after initDetail (reads ctx.selectNode)
initReader(ctx);  // Reader slice: doc overlay; fact-refs call ctx.selectNode (after initDetail)
initCorpus(ctx);  // READER-04: flat 2D Obsidian corpus graph (#btn-corpus full-window toggle)
initIndex(ctx);   // READER-WP: browsable text index (#btn-index full-window toggle, WIKI-01)

// Clear bootstrap loading message now that modules are wired — but NOT when it
// carries the load-error or empty-graph message set above (clearing those would
// leave a silent black screen, the exact failure D-14 forbids).
if (loadingEl && !graphLoadError && allNodes.length) loadingEl.textContent = '';

// ── Tooltip position tracking ──────────────────────────────────────────────────
// graph.js onNodeHover drives tooltip text + visibility; here we track the mouse
// position so the tooltip follows the cursor.  Also resets the stats.js idle timer
// on any pointer or keyboard activity (D-07 idle throttle).
document.addEventListener('mousemove', e => {
  const tooltipEl = document.getElementById('tooltip');
  if (tooltipEl) {
    tooltipEl.style.left = (e.clientX + 14) + 'px';
    tooltipEl.style.top  = (e.clientY + 18) + 'px';
  }
  if (ctx.markActive) ctx.markActive();
});

// Keyboard activity resets the idle timer too (catches hotkeys, S overlay, etc.)
document.addEventListener('keydown', () => {
  if (ctx.markActive) ctx.markActive();
});

} // end graph-boot else (detail mode skips everything above in this block)
