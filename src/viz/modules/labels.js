/**
 * @module labels
 * recense viz — diegetic SDF schema-label layer (Phase 58 Plan 03, D-01..D-04, D-15).
 *
 * initLabels(ctx) implements:
 *   - One vendored troika-three-text `Text` mesh per top-N schema (by member
 *     count, via ctx.schemaMembers), added to ctx.Graph.scene() as crisp
 *     in-scene SDF glyphs — no HTML/DOM.
 *   - Appear-on-approach (D-03): every label starts at opacity 0; a
 *     ctx.registerTick callback damps each label's material opacity toward
 *     ~0.7 when the camera sits within LABEL_DISTANCE_THRESHOLD of the
 *     label's schema node, and back toward 0 otherwise — so the overview
 *     constellation stays label-free and labels only resolve on approach.
 *   - `depthTest: true` on every label material so opaque node meshes occlude
 *     labels naturally (never rendered "through" a node).
 *   - Slate LABEL_COLOR (D-15 locked, never amber — see the invariants test).
 *   - `.sync()` called on all N labels at boot to pre-warm the SDF atlas
 *     (avoids a pop-in stutter on the first real camera approach).
 *
 * Exported API:
 *   initLabels(ctx) — call AFTER initLod (needs ctx.schemaMembers) and
 *     initGraph (needs ctx.Graph.scene() + ctx.registerTick, from initStats).
 *   selectTopSchemas(ctx, n) — pure top-N-by-member-count helper, exported
 *     standalone for unit testing without a live troika/THREE stack.
 *
 * Threat mitigations:
 *   T-10-10   imports only '../vendor/troika/...' and './constants.js' — no CDN
 *   T-58-03   `.text` is always a plain string assignment; troika renders it
 *             as SDF glyph geometry, never HTML/innerHTML — same textContent-
 *             only discipline as graph.js:594's T-10-12 tooltip rule
 *
 * @param {import('./constants.js').Ctx} ctx
 */

import { Text } from '../vendor/troika/troika-three-text.esm.js';
import { LABEL_TOP_N, LABEL_DISTANCE_THRESHOLD, LABEL_COLOR } from './constants.js';

/**
 * Vendored SDF label font (Plan 01). Resolved to an absolute URL against
 * THIS MODULE via import.meta.url — troika resolves plain relative font
 * URLs against the document (its toAbsoluteURL uses an <a> element, since
 * the actual fetch happens inside a blob-URL worker where module-relative
 * resolution is impossible), so a bare '../vendor/...' string would only
 * work while the page is served at the origin root.
 */
const FONT_URL = new URL('../vendor/fonts/JetBrainsMono-Regular.ttf', import.meta.url).href;

/** Peak label opacity on approach (D-03: slate @ ~0.7 alpha). */
const LABEL_TARGET_OPACITY = 0.7;

/** Exponential-damp smoothing rate for the opacity fade (THREE.MathUtils.damp). */
const LABEL_FADE_LAMBDA = 8;

const EMPTY_MEMBER_SET = new Set();

/**
 * Pure top-N selection: the N schema nodes with the largest member sets,
 * descending. Reads ctx.allNodes (filtered to __cat === 'schema', set by
 * lod.js's classification pass) and ctx.schemaMembers (Map<schemaId,
 * Set<memberId>>, also built by lod.js from 'abstracts' edges). Exported
 * standalone so it is unit-testable against a synthetic ctx, no live
 * troika/THREE stack required.
 *
 * @param {import('./constants.js').Ctx} ctx
 * @param {number} n
 * @returns {Array<Object>} schema node objects, largest member set first
 */
export function selectTopSchemas(ctx, n) {
  const { allNodes, schemaMembers } = ctx || {};
  if (!allNodes || !schemaMembers) return [];
  return allNodes
    .filter(node => node.__cat === 'schema')
    .sort((a, b) => {
      const sizeA = (schemaMembers.get(a.id) || EMPTY_MEMBER_SET).size;
      const sizeB = (schemaMembers.get(b.id) || EMPTY_MEMBER_SET).size;
      return sizeB - sizeA;
    })
    .slice(0, n);
}

export function initLabels(ctx) {
  if (!ctx.Graph || typeof ctx.Graph.scene !== 'function' || !ctx.registerTick) return;

  const schemaNodes = selectTopSchemas(ctx, LABEL_TOP_N);
  if (!schemaNodes.length) return;

  const scene = ctx.Graph.scene();

  const labels = schemaNodes.map(node => {
    const text = new Text();
    text.text = String(node.value || node.id || '');   // plain string only — T-10-12
    text.font = FONT_URL;
    text.fontSize = Math.max(2, (node.__baseR || 3) * 0.6);
    text.color = LABEL_COLOR;
    text.anchorX = 'center';
    text.anchorY = 'middle';
    text.material.depthTest = true;      // occlude naturally behind opaque nodes
    text.material.transparent = true;
    text.material.opacity = 0;           // hidden until an approach fades it in (D-03)
    text.sync();                         // pre-warm the SDF atlas at boot
    scene.add(text);
    return { text, node, opacity: 0 };
  });

  let lastNow = null;

  // D-03 appear-on-approach: fade each label toward LABEL_TARGET_OPACITY only
  // while the camera sits within LABEL_DISTANCE_THRESHOLD of its schema node;
  // otherwise damp back toward 0. Also re-positions + billboards each label
  // every frame so it tracks its node through the force simulation.
  ctx.registerTick((now) => {
    const camera = ctx.Graph.camera ? ctx.Graph.camera() : null;
    if (!camera) return;
    const dt = lastNow == null ? 1 / 60 : Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;

    for (const label of labels) {
      const { text, node } = label;
      const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
      text.position.set(nx, ny + (node.__baseR || 3) + 3, nz);
      text.quaternion.copy(camera.quaternion); // billboard toward camera

      const dx = camera.position.x - nx;
      const dy = camera.position.y - ny;
      const dz = camera.position.z - nz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const target = dist < LABEL_DISTANCE_THRESHOLD ? LABEL_TARGET_OPACITY : 0;

      label.opacity = ctx.THREE.MathUtils.damp(label.opacity, target, LABEL_FADE_LAMBDA, dt);
      text.material.opacity = label.opacity;
    }
  });
}
