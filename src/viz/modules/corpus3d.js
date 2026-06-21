import { layoutCorpus } from './corpus-layout.js';

const NODE_R = 2.2;
const PLANE_Y = 0;
const NODE_REST = 0x9c7080;
const NODE_HOVER = 0xd9a05c; // amber — hover/activation ONLY
const EDGE_REST = 0x6e5a82;
const LABEL_REST = '#c8bcd0';
const LABEL_HOVER = '#e7dfec';

// ── Button icon SVGs (inline — net-zero deps, no icon lib) ──────────────────────────
// BOOK icon: shown when brain is active (button = "go to corpus").
const ICON_BOOK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
// BRAIN icon: shown when corpus is active (button = "go back to brain").
// Side-view (sagittal) brain cross-section — cerebrum in profile facing left, a couple
// of internal gyri folds, and a small cerebellum/brainstem nub at the lower-back (right).
const ICON_BRAIN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16c-2 0-3-1.6-3-3.4 0-1.6 1-3 2.4-3.4C4.6 5.6 7.4 3 11 3c4.4 0 7.6 3.2 7.6 7 0 1 .4 1.6 1 2.2.8.8 1.2 1.6 1.2 2.6 0 1.6-1.4 3-3.2 3"/><path d="M17.6 17.8c.4 1.6-.6 3.2-2.4 3.2-1.4 0-2.4-1-2.4-2.4"/><path d="M7 10c1.2.4 1.8 1.4 1.8 2.6"/><path d="M12 8c1.4.6 2 1.8 2 3.4"/></svg>`;

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
  const h = NODE_R * 1.4, aspect = c.width / c.height;
  sprite.scale.set(h * aspect, h, 1);
  return sprite;
}

export function initCorpus(ctx) {
  const THREE = ctx.THREE;
  const corpusBtn = document.getElementById('btn-corpus');
  const canvasHost = document.getElementById('graph');
  if (!corpusBtn || !THREE || !ctx.Graph) return;

  let corpusActive = false;
  let built = false;
  let corpusGroup = null;
  const nodeMeshes = [];
  let statusEl = null;

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
      mesh.rotation.x = -Math.PI / 2;
      mesh.userData.corpusId = node.id;
      corpusGroup.add(mesh);
      const entry = {
        id: node.id,
        slug: node.slug || node.id,
        label: node.label || node.slug || node.id,
        mesh,
        basePos: new THREE.Vector3(p.x, PLANE_Y, p.z),
      };
      nodeMeshes.push(entry);
      const spriteText = node.slug || node.label || node.id;
      const sprite = makeLabelSprite(THREE, spriteText, LABEL_REST);
      sprite.position.set(p.x, PLANE_Y + NODE_R * 1.6, p.z);
      corpusGroup.add(sprite);
      entry.sprite = sprite;
    }

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

    corpusGroup.visible = false;
    ctx.Graph.scene().add(corpusGroup);
    built = true;
    return true;
  }

  const CAM_MS = 800;
  function enterCorpus() {
    corpusActive = true;
    corpusGroup.visible = true;
    const controls = ctx.Graph.controls && ctx.Graph.controls();
    if (controls) { controls.autoRotate = false; controls.enableRotate = false; }
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
    setTimeout(() => { if (!corpusActive && corpusGroup) corpusGroup.visible = false; }, CAM_MS);
    corpusBtn.innerHTML = ICON_BOOK;
    corpusBtn.setAttribute('aria-label', 'Corpus graph');
    corpusBtn.setAttribute('title', 'Corpus');
    corpusBtn.classList.remove('corpus-active');
  }

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
  function openDocReader(nm) {
    const slug = nm.slug;
    if (slug) window.location.href = `/?doc=${encodeURIComponent(slug)}&reader=1`;
  }
  if (dom) {
    dom.addEventListener('pointermove', (ev) => { if (corpusActive) setHover(pickNode(ev)); });
    dom.addEventListener('click', (ev) => { if (!corpusActive) return; const nm = pickNode(ev); if (nm) openDocReader(nm); });
  }

  corpusBtn.addEventListener('click', async () => {
    if (corpusActive) { enterBrain(); return; }
    if (!built) { const ok = await buildCorpus(); if (!ok) return; }
    enterCorpus();
  });

  ctx.returnToCorpus = function returnToCorpus() { if (built) enterCorpus(); };
  ctx.showBrainFromCorpus = function showBrainFromCorpus() { if (corpusActive) enterBrain(); };
}
