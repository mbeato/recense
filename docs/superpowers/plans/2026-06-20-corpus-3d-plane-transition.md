# Corpus as a 3D Plane + Pull-Back Transition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate 2D-canvas corpus view with a flat constellation rendered inside the brain's THREE scene, switched to via a real camera pull-back ("rise up to a map") instead of an insta-pop DOM swap.

**Architecture:** A new `corpus3d.js` owns a `THREE.Group` (nodes + edges + billboarded labels) on a horizontal plane added to `ctx.Graph.scene()`. The `#btn-corpus` toggle drives a camera mode (`brain ⇄ corpus`) using the existing `Graph.cameraPosition(pos, lookAt, ms)` / `ctx.recenter()` framing and `Graph.controls()`. The vendored 2D `force-graph` library, its injection, and the `#corpus-graph` canvas are removed; node layout is computed by a pure plain-JS force module.

**Tech Stack:** THREE (already loaded, `window.THREE` / `ctx.THREE`), 3d-force-graph's `cameraPosition`/`controls` API, vanilla ESM browser modules, vitest (node env — frontend verified by source-pattern assertions + server contract + founder-visual).

**Spec:** `docs/superpowers/specs/2026-06-20-corpus-3d-plane-transition-design.md`

**Testing reality (read before starting):** vitest runs in `environment: 'node'` with no jsdom — the viz `.js` modules are NOT executed in tests. Frontend behavior is locked by (a) **source-pattern assertions** (`fs.readFileSync` + `toContain`/`toMatch`) and (b) the **server `/graph?type=doc` contract** (already tested, unchanged). The ONE exception is the pure layout function (Task 1), which has no DOM/THREE deps and gets a real executed unit test. Everything visual (THREE render, camera feel, labels) is verified by `npm run build` + the founder visual checkpoint (Task 8). Visually-tuned constants are given concrete starting values — tune them during Task 8, they are not placeholders.

---

## File Structure

- **Create** `src/viz/modules/corpus-layout.js` — pure ESM force layout: `layoutCorpus(nodes, links, opts) → Map<id,{x,z}>`. No DOM/THREE imports → unit-testable.
- **Create** `src/viz/modules/corpus3d.js` — the 3D corpus: builds `corpusGroup` (nodes/edges/labels), camera-mode transitions, raycast hover/click, state overlay. Exports `initCorpus(ctx)` (same entry name as today, so `app.js` wiring barely changes).
- **Create** `tests/corpus-layout.test.ts` — executed unit test for the pure layout.
- **Modify** `src/viz/modules/app.js` — import `initCorpus` from `./corpus3d.js`; remove the `force-graph.min.js` injection block (lines ~61–72).
- **Modify** `src/viz/index.html` — remove the `#corpus-graph` element; keep `#btn-corpus`.
- **Modify** `src/viz/css/styles.css` — remove `#corpus-graph` rules; keep `#btn-corpus` rules; add `.corpus-status` DOM-overlay rules (re-home the existing status styling onto a canvas overlay).
- **Delete** `src/viz/modules/corpus.js` and `src/viz/vendor/force-graph.min.js`.
- **Modify** `tests/viz-corpus-graph.test.ts` and `tests/viz-frontend-static.test.ts` — replace 2D-force-graph source assertions with 3D-plane assertions.

---

## Task 1: Pure corpus force-layout module (TDD)

**Files:**
- Create: `src/viz/modules/corpus-layout.js`
- Test: `tests/corpus-layout.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/corpus-layout.test.ts
import { describe, it, expect } from 'vitest';
import { layoutCorpus } from '../src/viz/modules/corpus-layout.js';

const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
const links = [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }];

describe('layoutCorpus', () => {
  it('returns one finite {x,z} per node, centered near origin', () => {
    const pos = layoutCorpus(nodes, links);
    expect(pos.size).toBe(4);
    for (const id of ['a', 'b', 'c', 'd']) {
      const p = pos.get(id);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
    const cx = [...pos.values()].reduce((s, p) => s + p.x, 0) / pos.size;
    const cz = [...pos.values()].reduce((s, p) => s + p.z, 0) / pos.size;
    expect(Math.abs(cx)).toBeLessThan(1e-6);
    expect(Math.abs(cz)).toBeLessThan(1e-6);
  });

  it('is deterministic (no Math.random) — same input, same output', () => {
    const a = layoutCorpus(nodes, links);
    const b = layoutCorpus(nodes, links);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(a.get(id)).toEqual(b.get(id));
    }
  });

  it('pulls linked nodes closer than unlinked on average', () => {
    const pos = layoutCorpus(nodes, links);
    const d = (i: string, j: string) =>
      Math.hypot(pos.get(i).x - pos.get(j).x, pos.get(i).z - pos.get(j).z);
    const linked = (d('a', 'b') + d('a', 'c')) / 2;
    const unlinked = d('b', 'd'); // no edge b–d
    expect(linked).toBeLessThan(unlinked);
  });

  it('handles a single node and zero links without throwing', () => {
    const pos = layoutCorpus([{ id: 'solo' }], []);
    expect(pos.get('solo')).toEqual({ x: 0, z: 0 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run tests/corpus-layout.test.ts`
Expected: FAIL — `layoutCorpus` is not exported / module missing.

- [ ] **Step 3: Implement the pure layout**

```javascript
// src/viz/modules/corpus-layout.js
//
// Pure, deterministic 2D force layout for the corpus doc-graph. No DOM, no THREE,
// no Math.random — initial positions are seeded deterministically on a ring by index
// so the same graph always lays out identically (and the layout is unit-testable in
// the node test env). Returns plane coordinates as {x, z} (the y=0 floor plane in 3D).

const DEFAULTS = {
  ticks: 200,        // settle iterations (small corpora settle fast)
  charge: -30,       // node-node repulsion strength (negative = repel)
  linkDist: 14,      // desired edge length
  linkStrength: 0.08,
  center: 0.04,      // pull toward origin per tick (× alpha)
  collide: 8,        // min center-to-center spacing (label-aware)
  ringRadius: 20,    // seed ring radius for initial placement
};

export function layoutCorpus(nodes, links, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = nodes.length;
  const pos = new Map();
  if (n === 0) return pos;
  if (n === 1) { pos.set(nodes[0].id, { x: 0, z: 0 }); return pos; }

  // Deterministic seed: evenly spaced on a ring by index.
  const P = nodes.map((node, i) => {
    const a = (i / n) * Math.PI * 2;
    return { id: node.id, x: Math.cos(a) * o.ringRadius, z: Math.sin(a) * o.ringRadius, vx: 0, vz: 0 };
  });
  const idx = new Map(P.map((p, i) => [p.id, i]));
  // Normalize links to index pairs (source/target may be id strings or node refs).
  const L = links
    .map((l) => [idx.get(typeof l.source === 'object' ? l.source.id : l.source),
                 idx.get(typeof l.target === 'object' ? l.target.id : l.target)])
    .filter(([a, b]) => a != null && b != null);

  for (let t = 0; t < o.ticks; t++) {
    const alpha = 1 - t / o.ticks;
    // Charge: pairwise repulsion (O(n²) — fine for small doc corpora).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = P[i].x - P[j].x, dz = P[i].z - P[j].z;
        let dist2 = dx * dx + dz * dz || 0.01;
        const f = (o.charge * alpha) / dist2;
        const dist = Math.sqrt(dist2);
        const ux = dx / dist, uz = dz / dist;
        P[i].vx -= ux * f; P[i].vz -= uz * f;
        P[j].vx += ux * f; P[j].vz += uz * f;
        // Collision: hard-ish push apart if overlapping.
        if (dist < o.collide) {
          const push = (o.collide - dist) * 0.5;
          P[i].vx += ux * push; P[i].vz += uz * push;
          P[j].vx -= ux * push; P[j].vz -= uz * push;
        }
      }
    }
    // Link spring toward desired distance.
    for (const [a, b] of L) {
      let dx = P[b].x - P[a].x, dz = P[b].z - P[a].z;
      const dist = Math.hypot(dx, dz) || 0.01;
      const f = (dist - o.linkDist) * o.linkStrength * alpha;
      const ux = dx / dist, uz = dz / dist;
      P[a].vx += ux * f; P[a].vz += uz * f;
      P[b].vx -= ux * f; P[b].vz -= uz * f;
    }
    // Integrate + centering pull + damping.
    for (const p of P) {
      p.vx -= p.x * o.center * alpha; p.vz -= p.z * o.center * alpha;
      p.x += p.vx; p.z += p.vz;
      p.vx *= 0.6; p.vz *= 0.6;
    }
  }

  // Recenter on centroid so the map sits on the origin.
  const cx = P.reduce((s, p) => s + p.x, 0) / n;
  const cz = P.reduce((s, p) => s + p.z, 0) / n;
  for (const p of P) pos.set(p.id, { x: p.x - cx, z: p.z - cz });
  return pos;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run tests/corpus-layout.test.ts`
Expected: PASS (4 tests). If the "linked closer than unlinked" assertion is flaky, raise `linkStrength` to `0.12` or `ticks` to `300` — keep it deterministic.

- [ ] **Step 5: Commit**

```bash
git add src/viz/modules/corpus-layout.js tests/corpus-layout.test.ts
git commit -m "feat(corpus3d): pure deterministic corpus force layout + unit test"
```

---

## Task 2: corpus3d.js scaffold — data, state overlay, node meshes

**Files:**
- Create: `src/viz/modules/corpus3d.js`
- Modify: `src/viz/css/styles.css` (add `.corpus-status` overlay rules)

This task builds the module skeleton: lazy state, the `#btn-corpus` wiring, the data fetch with correct loading/empty/error states (carrying the `fa0e206` control-flow fixes), and the node circle meshes assembled into `corpusGroup` on the `y=0` plane. Camera/edges/labels/interaction come in later tasks.

- [ ] **Step 1: Write the module skeleton**

```javascript
// src/viz/modules/corpus3d.js
//
// Corpus as a flat 3D plane inside the brain's THREE scene (replaces the 2D force-graph
// corpus). Lazy-built on first open. The #btn-corpus toggle drives a camera mode
// (brain ⇄ corpus) — see enterCorpus()/enterBrain() in Task 4.

import { layoutCorpus } from './corpus-layout.js';

const NODE_R = 2.2;            // plane-space node radius (starting value — tune in Task 8)
const PLANE_Y = 0;            // floor plane height
const NODE_REST = 0x9c7080;  // muted rose
const NODE_HOVER = 0xd9a05c; // amber — allowed on hover/activation only
const EDGE_REST = 0x6e5a82;  // muted slate/mauve
const LABEL_REST = '#c8bcd0';
const LABEL_HOVER = '#e7dfec';

export function initCorpus(ctx) {
  const THREE = ctx.THREE;
  const corpusBtn = document.getElementById('btn-corpus');
  const canvasHost = document.getElementById('graph'); // the THREE canvas host (for the DOM overlay)
  if (!corpusBtn || !THREE || !ctx.Graph) return;

  let corpusActive = false;
  let built = false;
  let corpusGroup = null;             // THREE.Group added to the scene
  const nodeMeshes = [];              // {id, slug, mesh, label, basePos}
  let statusEl = null;                // DOM overlay for loading/empty/error

  function setStatus(text, isHtml = false) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'corpus-status';
      canvasHost.parentElement.appendChild(statusEl);
    }
    if (isHtml) statusEl.innerHTML = text; else statusEl.textContent = text;
    statusEl.style.display = 'block';
  }
  function clearStatus() { if (statusEl) statusEl.style.display = 'none'; }

  async function buildCorpus() {
    setStatus('Loading corpus…');
    let data = { nodes: [], links: [] };
    let errored = false;
    try {
      const res = await fetch('/graph?type=doc');
      if (res.ok) data = await res.json(); else errored = true;
    } catch (_) { errored = true; }

    if (errored) { setStatus('Failed to load corpus'); return false; }
    if ((data.nodes || []).length === 0) {
      setStatus('No docs yet<br><code>recense generate-doc &lt;slug&gt;</code>', true);
      return false;
    }
    clearStatus();

    const pos = layoutCorpus(data.nodes, data.links || []);
    corpusGroup = new THREE.Group();
    corpusGroup.name = 'corpusGroup';

    const geo = new THREE.CircleGeometry(NODE_R, 24);
    for (const node of data.nodes) {
      const p = pos.get(node.id) || { x: 0, z: 0 };
      const mat = new THREE.MeshBasicMaterial({ color: NODE_REST });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, PLANE_Y, p.z);
      mesh.rotation.x = -Math.PI / 2; // lie flat on the floor plane
      mesh.userData.corpusId = node.id;
      corpusGroup.add(mesh);
      nodeMeshes.push({
        id: node.id,
        slug: node.slug || node.id,
        label: node.label || node.slug || node.id,
        mesh,
        basePos: new THREE.Vector3(p.x, PLANE_Y, p.z),
      });
    }
    // Edges (Task 3) and labels (Task 3) are added here.
    corpusGroup.visible = false;
    ctx.Graph.scene().add(corpusGroup);
    built = true;
    return true;
  }

  // enterCorpus / enterBrain implemented in Task 4.
  // raycast hover/click implemented in Task 5.

  corpusBtn.addEventListener('click', async () => {
    if (corpusActive) { /* enterBrain() — Task 4 */ return; }
    if (!built) { const ok = await buildCorpus(); if (!ok) return; }
    /* enterCorpus() — Task 4 */
  });

  // Reader re-entry hooks (parity with old corpus.js): wired in Task 4.
  ctx.returnToCorpus = function returnToCorpus() { /* Task 4 */ };
  ctx.showBrainFromCorpus = function showBrainFromCorpus() { /* Task 4 */ };
}
```

- [ ] **Step 2: Add `.corpus-status` overlay CSS**

In `src/viz/css/styles.css`, replace any `#corpus-graph` block with a DOM-overlay rule (centered over the canvas):

```css
/* Corpus state overlay (loading / empty / error) — centered over the brain canvas.
   Muted mauve/slate, never amber. */
.corpus-status {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  z-index: 6;
  text-align: center;
  color: #6b5f73;
  font-size: 13px;
  line-height: 1.5;
  pointer-events: none;
  display: none;
}
.corpus-status code { color: #8b7090; font-size: 12px; }
```

- [ ] **Step 3: Verify build is clean (no execution test — node meshes are visual)**

Run: `npx tsc --noEmit && echo TSC_OK`
Expected: `TSC_OK` (the `.js` modules aren't type-checked, but this confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add src/viz/modules/corpus3d.js src/viz/css/styles.css
git commit -m "feat(corpus3d): module scaffold — data fetch, state overlay, node meshes"
```

---

## Task 3: Edges + billboarded labels

**Files:**
- Modify: `src/viz/modules/corpus3d.js`

- [ ] **Step 1: Add edges (LineSegments) inside `buildCorpus`, after the node loop**

```javascript
    // Edges: doc_link lines on the plane.
    if ((data.links || []).length) {
      const pts = [];
      for (const l of data.links) {
        const a = pos.get(typeof l.source === 'object' ? l.source.id : l.source);
        const b = pos.get(typeof l.target === 'object' ? l.target.id : l.target);
        if (!a || !b) continue;
        pts.push(a.x, PLANE_Y, a.z, b.x, PLANE_Y, b.z);
      }
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const emat = new THREE.LineBasicMaterial({ color: EDGE_REST, transparent: true, opacity: 0.55 });
      corpusGroup.add(new THREE.LineSegments(eg, emat));
    }
```

- [ ] **Step 2: Add a billboarded label sprite factory (module-scope helper)**

```javascript
// Build a canvas-texture sprite for an always-on label. Billboarded by default
// (THREE.Sprite always faces the camera), so it stays readable at any tilt.
function makeLabelSprite(THREE, text, color) {
  const pad = 6, font = 28;
  const c = document.createElement('canvas');
  const cx = c.getContext('2d');
  cx.font = `${font}px -apple-system, system-ui, sans-serif`;
  const w = Math.ceil(cx.measureText(text).width) + pad * 2;
  c.width = w; c.height = font + pad * 2;
  cx.font = `${font}px -apple-system, system-ui, sans-serif`;
  cx.fillStyle = color;
  cx.textBaseline = 'middle';
  cx.fillText(text, pad, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  // Scale to plane units: keep label height ~ NODE_R*1.4; width by aspect.
  const h = NODE_R * 1.4, aspect = c.width / c.height;
  sprite.scale.set(h * aspect, h, 1);
  sprite._canvas = c; sprite._tex = tex; sprite._cx = cx; // kept for hover recolor
  return sprite;
}
```

- [ ] **Step 3: Attach a label to each node inside the node loop**

After `corpusGroup.add(mesh);` in `buildCorpus`, add:

```javascript
      const sprite = makeLabelSprite(THREE, node.slug || node.label || node.id, LABEL_REST);
      sprite.position.set(p.x, PLANE_Y + NODE_R * 1.6, p.z); // float just above the node
      corpusGroup.add(sprite);
      nodeMeshes[nodeMeshes.length] && (nodeMeshes[nodeMeshes.length - 1].sprite = sprite);
```

(Adjust so the `sprite` is stored on the same `nodeMeshes` entry pushed for this node — push the entry first, then set `.sprite`.)

- [ ] **Step 4: Build & visually sanity-check via dist (deferred to Task 8 for the full check)**

Run: `npm run build && echo BUILD_OK`
Expected: `BUILD_OK`, `copy-viz-assets` line present.

- [ ] **Step 5: Commit**

```bash
git add src/viz/modules/corpus3d.js
git commit -m "feat(corpus3d): doc_link edges + billboarded canvas-texture labels"
```

---

## Task 4: Camera pull-back transition + mode toggle

**Files:**
- Modify: `src/viz/modules/corpus3d.js`

The brain's home framing is `ctx.recenter(ms)` (graph.js, set on ctx). The corpus framing pulls the camera up and back to look down at the plane.

- [ ] **Step 1: Add framing constants + camera helpers in `initCorpus`**

```javascript
  // Corpus framing: camera high above + slightly back, looking down at the plane.
  // BRAIN_SCALE-relative is not exported; use the scene's existing scale via the
  // brain's home distance as a reference. Starting values — tune in Task 8.
  const CAM_MS = 800;
  function enterCorpus() {
    corpusActive = true;
    corpusGroup.visible = true;
    const controls = ctx.Graph.controls && ctx.Graph.controls();
    if (controls) { controls.autoRotate = false; controls.enableRotate = false; }
    // Pull up and back, look down at the plane origin.
    ctx.Graph.cameraPosition({ x: 0, y: 90, z: 60 }, { x: 0, y: 0, z: 0 }, CAM_MS);
    corpusBtn.innerHTML = ICON_BRAIN;
    corpusBtn.setAttribute('aria-label', 'Show brain');
    corpusBtn.setAttribute('title', 'Show brain');
    corpusBtn.classList.add('corpus-active');
  }
  function enterBrain() {
    corpusActive = false;
    const controls = ctx.Graph.controls && ctx.Graph.controls();
    if (controls) { controls.enableRotate = true; }
    if (typeof ctx.recenter === 'function') ctx.recenter(CAM_MS);
    // Hide the plane after the camera has dived back in.
    setTimeout(() => { if (!corpusActive && corpusGroup) corpusGroup.visible = false; }, CAM_MS);
    corpusBtn.innerHTML = ICON_BOOK;
    corpusBtn.setAttribute('aria-label', 'Corpus graph');
    corpusBtn.setAttribute('title', 'Corpus');
    corpusBtn.classList.remove('corpus-active');
  }
```

- [ ] **Step 2: Add the ICON_BOOK / ICON_BRAIN constants (carry over from corpus.js)**

Copy the two inline-SVG string constants `ICON_BOOK` and `ICON_BRAIN` from the deleted `corpus.js` (the side-profile brain glyph from commit `e6098c9`) to the top of `corpus3d.js`. They are net-zero inline SVG.

- [ ] **Step 3: Wire the button + reader re-entry hooks**

```javascript
  corpusBtn.addEventListener('click', async () => {
    if (corpusActive) { enterBrain(); return; }
    if (!built) { const ok = await buildCorpus(); if (!ok) return; }
    enterCorpus();
  });
  ctx.returnToCorpus = function returnToCorpus() {
    if (!built) return;
    enterCorpus();
  };
  ctx.showBrainFromCorpus = function showBrainFromCorpus() {
    if (corpusActive) enterBrain();
  };
```

(Replace the stub click handler and stub hooks from Task 2.)

- [ ] **Step 4: Build**

Run: `npm run build && echo BUILD_OK`
Expected: `BUILD_OK`.

- [ ] **Step 5: Commit**

```bash
git add src/viz/modules/corpus3d.js
git commit -m "feat(corpus3d): camera pull-back transition + brain/corpus mode toggle"
```

---

## Task 5: Raycast hover + click→reader

**Files:**
- Modify: `src/viz/modules/corpus3d.js`

- [ ] **Step 1: Add a raycaster and pointer handlers (inside `initCorpus`)**

```javascript
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  const renderer = ctx.Graph.renderer && ctx.Graph.renderer();
  const dom = renderer && renderer.domElement;

  function pickNode(ev) {
    if (!corpusActive || !corpusGroup) return null;
    const rect = dom.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, ctx.Graph.camera());
    const meshes = nodeMeshes.map((nm) => nm.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const id = hits[0].object.userData.corpusId;
    return nodeMeshes.find((nm) => nm.id === id) || null;
  }

  function setHover(nm) {
    if (hovered === nm) return;
    if (hovered) hovered.mesh.material.color.set(NODE_REST);
    hovered = nm;
    if (hovered) hovered.mesh.material.color.set(NODE_HOVER);
    if (dom) dom.style.cursor = hovered ? 'pointer' : '';
  }

  if (dom) {
    dom.addEventListener('pointermove', (ev) => { if (corpusActive) setHover(pickNode(ev)); });
    dom.addEventListener('click', (ev) => {
      if (!corpusActive) return;
      const nm = pickNode(ev);
      if (nm) openDocReader(nm);
    });
  }

  function openDocReader(nm) {
    // Parity with old corpus.js openDocReader: navigate to the reader for this doc.
    const slug = nm.slug;
    if (slug) window.location.href = `/?doc=${encodeURIComponent(slug)}&reader=1`;
  }
```

- [ ] **Step 2: Build**

Run: `npm run build && echo BUILD_OK`
Expected: `BUILD_OK`.

- [ ] **Step 3: Commit**

```bash
git add src/viz/modules/corpus3d.js
git commit -m "feat(corpus3d): raycast hover (amber) + click→reader navigation"
```

---

## Task 6: Wire into app.js, remove 2D corpus + force-graph

**Files:**
- Modify: `src/viz/modules/app.js`
- Modify: `src/viz/index.html`
- Delete: `src/viz/modules/corpus.js`, `src/viz/vendor/force-graph.min.js`

- [ ] **Step 1: Swap the import in `app.js`**

Change line 33 from `import { initCorpus } from './corpus.js';` to:

```javascript
import { initCorpus } from './corpus3d.js';
```

- [ ] **Step 2: Remove the force-graph injection block**

Delete the `force-graph.min.js` injection block in `app.js` (the `await new Promise(...)` that sets `s.src = './vendor/force-graph.min.js'`, ~lines 61–72) and its comment header. The 3d-force-graph injection stays. `initCorpus(ctx)` at the bottom stays unchanged (same entry name).

- [ ] **Step 3: Remove `#corpus-graph` from `index.html`**

Delete the `<div id="corpus-graph">` element (and its comment). `#btn-corpus` stays.

- [ ] **Step 4: Delete the dead files**

```bash
git rm src/viz/modules/corpus.js src/viz/vendor/force-graph.min.js
```

- [ ] **Step 5: Grep to confirm no dangling references**

Run: `grep -rn "force-graph\|corpus-graph\|corpus.js" src/viz/ | grep -v 3d-force-graph`
Expected: no matches (3d-force-graph references are fine and excluded).

- [ ] **Step 6: Build**

Run: `npm run build && echo BUILD_OK`
Expected: `BUILD_OK`. `copy-viz-assets` should no longer copy `force-graph.min.js`.

- [ ] **Step 7: Commit**

```bash
git add src/viz/modules/app.js src/viz/index.html
git commit -m "feat(corpus3d): wire 3D corpus into app.js; remove 2D force-graph + #corpus-graph"
```

---

## Task 7: Update source-pattern + static tests

**Files:**
- Modify: `tests/viz-corpus-graph.test.ts`
- Modify: `tests/viz-frontend-static.test.ts`

The server `/graph?type=doc` contract tests (data shape) are unchanged and must still pass. Only the **source-pattern** assertions that referenced the 2D force-graph need rewriting.

- [ ] **Step 1: Update `viz-corpus-graph.test.ts` source assertions**

Replace the three `corpus.js` source-pattern tests (the ones asserting `window.ForceGraph`, "does NOT swap data into the 3D brain", and `MAX_ZOOM`) with assertions against `corpus3d.js`:

```typescript
  it('source: corpus3d.js renders the corpus as a THREE group in the brain scene', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/viz/modules/corpus3d.js'), 'utf8');
    expect(src).toContain("ctx.Graph.scene().add(corpusGroup)");
    expect(src).toContain('cameraPosition');          // real camera transition
    expect(src).not.toContain('window.ForceGraph');   // 2D force-graph removed
  });

  it('source: corpus3d.js fetches /graph?type=doc and handles error/empty distinctly', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/viz/modules/corpus3d.js'), 'utf8');
    expect(src).toContain("/graph?type=doc");
    expect(src).toContain('Failed to load corpus');
    expect(src).toContain('No docs yet');
    // error returns before the empty branch (CR-01 regression guard)
    expect(src).toMatch(/errored[\s\S]*Failed to load corpus[\s\S]*return/);
  });

  it('source: corpus layout is a pure module (no DOM/THREE) reused by corpus3d', () => {
    const layout = fs.readFileSync(path.resolve(__dirname, '../src/viz/modules/corpus-layout.js'), 'utf8');
    expect(layout).not.toMatch(/document\.|window\.|THREE/);
    const src = fs.readFileSync(path.resolve(__dirname, '../src/viz/modules/corpus3d.js'), 'utf8');
    expect(src).toContain("from './corpus-layout.js'");
  });
```

Also update the `index.html`/`styles.css` assertions in that file: `#btn-corpus` must still be present; `#corpus-graph` must be ABSENT:

```typescript
  it('source: #btn-corpus present, #corpus-graph removed', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../src/viz/index.html'), 'utf8');
    expect(html).toContain('id="btn-corpus"');
    expect(html).not.toContain('id="corpus-graph"');
  });
```

- [ ] **Step 2: Update `viz-frontend-static.test.ts`**

In its module-corpus string assembly (it concatenates module sources into `corpus`), remove any assertion that requires `force-graph` / `#corpus-graph`, and ensure the security assertion ("no external URLs") still holds for `corpus3d.js` + `corpus-layout.js` (they use only same-origin `/graph?type=doc` and `/?doc=`). If the file globs module sources, confirm `corpus.js` removal doesn't break the read (it should glob existing files).

- [ ] **Step 3: Run the full viz test subset**

Run: `npx vitest run tests/viz-corpus-graph.test.ts tests/viz-frontend-static.test.ts tests/corpus-layout.test.ts`
Expected: PASS. Fix any assertion still referencing removed symbols.

- [ ] **Step 4: Run the full suite to catch collateral**

Run: `npx vitest run`
Expected: PASS (no corpus/viz regressions; server contract tests green). Note: a parallel Phase 35 may touch engine tests — if a non-viz test fails, confirm it's unrelated to this change (check `git blame`/the failing path is engine, not viz) before proceeding.

- [ ] **Step 5: Commit**

```bash
git add tests/viz-corpus-graph.test.ts tests/viz-frontend-static.test.ts
git commit -m "test(corpus3d): retarget source-pattern assertions to the 3D corpus module"
```

---

## Task 8: Rebuild + founder visual checkpoint

**Files:** none (verification)

- [ ] **Step 1: Rebuild dist**

Run: `npm run build && echo BUILD_OK`
Expected: `BUILD_OK`.

- [ ] **Step 2: Guard greps (founder-locked)**

```bash
git diff <merge-base>..HEAD -- package.json package-lock.json   # → empty (net-zero; force-graph removed only improves it)
git diff <merge-base>..HEAD --stat -- src/viz/modules/brain.js src/viz/modules/haze.js  # → empty (density anchor untouched)
```

Expected: deps empty; brain density modules untouched. (graph.js is unchanged except nothing — corpus3d only *reads* ctx.Graph; confirm no edits to graph.js render path.)

- [ ] **Step 3: Founder visual checkpoint**

Launch: `cp ~/.config/recense/recense.db /tmp/corpus3d-review.db && recense viz --db /tmp/corpus3d-review.db` → open `http://127.0.0.1:7810`.

Verify:
- Click the corpus button → camera **pulls back/up** and the brain **recedes into the fog** while the doc-map resolves below (no insta-pop).
- The map reads as a flat constellation: muted-rose nodes, slate/mauve edges, readable always-on labels (billboarded).
- Hover a node → it brightens (amber ok on hover); cursor is a pointer.
- Click a node → opens that doc in the reader.
- Toggle back → camera **dives into the cloud**, brain returns, rotation resumes; corpus button glyph restores to the book.
- Empty/error: against an empty DB, "No docs yet" shows centered; a fetch failure shows "Failed to load corpus" (not overwritten).
- Brain density unchanged vs. before.

Tune the starting constants if needed: `enterCorpus` camera `{x:0,y:90,z:60}` framing, `NODE_R`, label scale, `CAM_MS`. Re-`npm run build` after any tweak.

- [ ] **Step 4: On approval, final commit (if constants were tuned)**

```bash
git add src/viz/modules/corpus3d.js
git commit -m "fix(corpus3d): founder-tuned camera framing + node/label sizing"
```

---

## Self-Review

- **Spec coverage:** permanent 3D plane (Tasks 2–3) ✓; pull-back camera transition (Task 4) ✓; preserve data/states/click→reader (Tasks 2,5) ✓; drop force-graph + #corpus-graph, net-zero-or-better (Task 6) ✓; amber-only-on-hover (Task 5 `NODE_HOVER`) ✓; density anchor untouched (Task 8 guard) ✓; tests reworked (Task 7) ✓; lazy-build + top-down lock + ~800ms (Tasks 2,4) ✓.
- **Placeholder scan:** visual constants carry concrete starting values (not TBD); the only "tune in Task 8" notes are explicit, value-bearing, and expected for a visual feature.
- **Type/name consistency:** `layoutCorpus` (Task 1) → imported in Task 2/asserted in Task 7; `corpusGroup`, `nodeMeshes`, `enterCorpus`/`enterBrain`, `ICON_BOOK`/`ICON_BRAIN`, `buildCorpus`, `openDocReader`, `setStatus`/`clearStatus` are defined once and reused consistently across Tasks 2–5.
- **Known follow-through:** in Task 3 Step 3, push the `nodeMeshes` entry first, then attach `.sprite` (noted inline) so the label binds to the right node.
