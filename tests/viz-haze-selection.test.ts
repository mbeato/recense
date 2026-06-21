/**
 * tests/viz-haze-selection.test.ts
 *
 * TDD tests for the two residual B1 click-bug facets:
 *
 *   B1a — no persistent selection highlight on haze click:
 *     selectNode() (detail.js:395) gates RingGeometry behind node.__mesh.
 *     Haze nodes have no __mesh → no selection marker.
 *     Fix: add a standalone scene-level Mesh at node.x/y/z when __mesh is absent
 *     but __hazeIdx is set. Dispose on clearSelection().
 *
 * RED criteria (failing before fix):
 *   B1a: selectNode on a haze node does NOT add anything to ctx.Graph.scene()
 *
 * GREEN criteria (passing after fix):
 *   B1a: selectNode on a haze node adds a standalone Mesh to ctx.Graph.scene()
 *        at the node's x/y/z position
 *   B1a: clearSelection() removes and disposes that Mesh
 *   B1a: selectNode on a normal node (has __mesh) still uses the __mesh.add() path
 *        and does NOT add to scene
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore — three is mocked by vi.mock above; no type declarations in this project
import * as THREE from 'three';

// ── THREE mock ──────────────────────────────────────────────────────────────
// Must be declared before the vi.mock call (hoisted by vitest).
const _disposedGeometries: number[] = [];
const _disposedMaterials:  number[] = [];

vi.mock('three', () => {
  class Color {
    r = 0; g = 0; b = 0;
    constructor(hex?: number) {
      if (hex !== undefined) {
        this.r = ((hex >> 16) & 0xff) / 255;
        this.g = ((hex >> 8)  & 0xff) / 255;
        this.b = (hex         & 0xff) / 255;
      }
    }
    set(hex: number) { this.r = ((hex >> 16) & 0xff) / 255; this.g = ((hex >> 8) & 0xff) / 255; this.b = (hex & 0xff) / 255; return this; }
    copy(o: Color) { this.r = o.r; this.g = o.g; this.b = o.b; return this; }
    clone() { const c = new Color(); c.r = this.r; c.g = this.g; c.b = this.b; return c; }
    lerp(_o: Color, _t: number) { return this; }
  }
  class Vector3 {
    x = 0; y = 0; z = 0;
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    normalize() { return this; }
  }
  class Quaternion { setFromUnitVectors() { return this; } }
  class CylinderGeometry {}
  class SphereGeometry { constructor(_r?: number, _w?: number, _h?: number) {} dispose() {} }
  class ShaderMaterial { uniforms: any = {}; constructor(_a: any) {} }

  let _geoCounter = 0;
  class RingGeometry {
    _id: number;
    constructor(_inner?: number, _outer?: number, _seg?: number) { this._id = ++_geoCounter; }
    dispose() { disposedGeos.push(this._id); }
  }
  let _matCounter = 0;
  class MeshBasicMaterial {
    _id: number;
    transparent?: boolean;
    opacity?: number;
    side?: number;
    depthWrite?: boolean;
    constructor(p?: any) { this._id = ++_matCounter; Object.assign(this, p ?? {}); }
    dispose() { disposedMats.push(this._id); }
  }

  class Mesh {
    position = { _x: 0, _y: 0, _z: 0, set(x: number, y: number, z: number) { this._x = x; this._y = y; this._z = z; } };
    scale    = { set(_x: number, _y: number, _z: number) {}, setScalar(_s: number) {} };
    geometry: any = null;
    material: any = null;
    _children: any[] = [];
    constructor(geo?: any, mat?: any) { this.geometry = geo; this.material = mat; }
    add(child: any)    { this._children.push(child); }
    remove(child: any) { this._children = this._children.filter((c: any) => c !== child); }
    setRotationFromQuaternion(_q: any) {}
  }
  class Group {
    add(_m: any) {} remove(_m: any) {}
  }
  // These must be accessible from inside tests via the module reference — but
  // vi.mock factories are isolated. We expose via module-level arrays that the
  // factory writes to by closing over module-level refs. However, vi.mock is
  // hoisted before module-level declarations, so we cannot close over them.
  // Solution: attach to globalThis so the test body can observe them.
  const disposedGeos: number[] = [];
  const disposedMats: number[] = [];
  (globalThis as any).__testDisposedGeos = disposedGeos;
  (globalThis as any).__testDisposedMats = disposedMats;

  const AdditiveBlending = 2;
  const DoubleSide  = 2;
  const BackSide    = 1;
  return { Color, Vector3, Quaternion, CylinderGeometry, SphereGeometry, ShaderMaterial, RingGeometry, MeshBasicMaterial, Mesh, Group, AdditiveBlending, DoubleSide, BackSide };
});

// ── DOM / browser globals ───────────────────────────────────────────────────
// detail.js calls document.getElementById + querySelector, location.search,
// window.innerWidth/innerHeight, BroadcastChannel, addEventListener.
// Must be set BEFORE the module is imported.

function makeNullEl() {
  return {
    textContent: '',
    style: { display: '' },
    className: '',
    appendChild(_: any) {},
    querySelector(_: string): any { return null; },
    querySelectorAll(_: string) { return []; },
    addEventListener(_: string, _cb: any) {},
    removeEventListener(_: string, _cb: any) {},
    classList: { add(_: string) {}, remove(_: string) {}, contains(_: string) { return false; } },
    innerHTML: '',
    dataset: {},
  };
}

(globalThis as any).document = {
  getElementById: (_id: string) => makeNullEl(),
  querySelector:  (_sel: string) => makeNullEl(),
  createElement:  (_tag: string) => makeNullEl(),
  addEventListener(_: string, _cb: any) {},
  removeEventListener(_: string, _cb: any) {},
  body: makeNullEl(),
};
(globalThis as any).window = {
  innerWidth:  1024,
  innerHeight: 768,
  addEventListener(_: string, _cb: any) {},
  removeEventListener(_: string, _cb: any) {},
};
(globalThis as any).location = { search: '', href: '' };
(globalThis as any).BroadcastChannel = class { addEventListener() {} };
if (typeof (globalThis as any).performance === 'undefined') {
  (globalThis as any).performance = { now: () => Date.now() };
}

// @ts-ignore — browser ESM, no type declarations
import { initDetail } from '../src/viz/modules/detail.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeScene() {
  const adds: any[]    = [];
  const removes: any[] = [];
  return {
    _adds:    adds,
    _removes: removes,
    add(obj: any)    { adds.push(obj); },
    remove(obj: any) { removes.push(obj); },
  };
}

function makeCtx(scene: ReturnType<typeof makeScene>) {
  const ticks: Array<(now: number) => void> = [];
  const ctx: any = {
    idMap:         new Map(),
    adj:           new Map(),
    allNodes:      [],
    traceNodes:    new Set(),
    traceLinks:    new Set(),
    revealTrace:   vi.fn(),
    logEvent:      vi.fn(),
    markAnimating: vi.fn(),
    markActive:    vi.fn(),
    pulseGroup:    { add: vi.fn(), remove: vi.fn() },
    hazeMesh:      null,
    hazeMat:       null,
    hazeNodeIdMap: new Map(),
    nodeVisible:   (_n: any) => true,
    spawnPulse:    vi.fn(),
    recenter:      vi.fn(),

    Graph: {
      scene:          () => scene,
      cameraPosition: (_pos: any, _up: any, _ms: any) => {},
      camera:         () => ({ near: 0.1, far: 2000 }),
    },

    // detail.js reads ctx.THREE for RingGeometry / MeshBasicMaterial / Mesh construction
    THREE,

    registerTick: (fn: (now: number) => void) => { ticks.push(fn); },
  };
  return { ctx, ticks };
}

/** Haze node: has __hazeIdx/__hazeBase, deliberately NO __mesh/__mat/__baseR. */
function makeHazeNode(id: string, idx: number) {
  return {
    id,
    type: 'fact',
    __hazeIdx:  idx,
    __hazeBase: { r: 0.4, g: 0.5, b: 0.6 },
    x: 10, y: 20, z: 30,
    __cat: 'haze',
  };
}

/** Normal node: has __mesh/__baseR, NO __hazeIdx. */
function makeNormalNode(id: string) {
  const mesh: any = {
    _children: [],
    add(c: any)    { this._children.push(c); },
    remove(c: any) { this._children = this._children.filter((x: any) => x !== c); },
    scale: { setScalar(_: number) {} },
  };
  return {
    id,
    type: 'schema',
    __mesh:   mesh,
    __baseR:  3,
    __mat:    { color: {}, opacity: 1 },
    __cat:    'schema',
    x: 0, y: 0, z: 0,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('viz haze selection marker (B1a)', () => {

  beforeEach(() => {
    // Clear disposal tracking on globalThis between tests
    const dg = (globalThis as any).__testDisposedGeos;
    const dm = (globalThis as any).__testDisposedMats;
    if (dg) dg.length = 0;
    if (dm) dm.length = 0;
  });

  it('B1a RED: selectNode on a haze node must add a standalone Mesh to the scene', () => {
    const scene = makeScene();
    const { ctx } = makeCtx(scene);
    initDetail(ctx);

    const hazeNode = makeHazeNode('haze-001', 1);

    // Before fix: selectNode skips ring creation (no __mesh) and nothing reaches scene
    ctx.selectNode(hazeNode);

    expect(scene._adds.length).toBeGreaterThan(0);
  });

  it('B1a RED: haze selection marker position must be set to node.x/y/z', () => {
    const scene = makeScene();
    const { ctx } = makeCtx(scene);
    initDetail(ctx);

    const hazeNode = makeHazeNode('haze-002', 2);
    ctx.selectNode(hazeNode);

    expect(scene._adds.length).toBeGreaterThan(0);
    const marker = scene._adds[0];
    expect(marker.position._x).toBe(hazeNode.x);
    expect(marker.position._y).toBe(hazeNode.y);
    expect(marker.position._z).toBe(hazeNode.z);
  });

  it('B1a RED: closeDetail must remove haze selection marker from scene', () => {
    const scene = makeScene();
    const { ctx } = makeCtx(scene);
    initDetail(ctx);

    const hazeNode = makeHazeNode('haze-003', 3);
    ctx.selectNode(hazeNode);
    expect(scene._adds.length).toBeGreaterThan(0);

    ctx.closeDetail();

    expect(scene._removes.length).toBeGreaterThan(0);
  });

  it('B1a: selecting a second haze node disposes the first marker geometry', () => {
    const scene = makeScene();
    const { ctx } = makeCtx(scene);
    initDetail(ctx);

    const hazeNode1 = makeHazeNode('haze-010', 10);
    const hazeNode2 = makeHazeNode('haze-011', 11);

    ctx.selectNode(hazeNode1);
    ctx.selectNode(hazeNode2);

    // First marker must have been removed from scene before second was added
    expect(scene._removes.length).toBeGreaterThan(0);
    // And its geometry should be disposed
    const disposedGeos = (globalThis as any).__testDisposedGeos ?? [];
    expect(disposedGeos.length).toBeGreaterThan(0);
  });

  it('B1a: normal node (__mesh exists) uses __mesh.add path, NOT scene.add', () => {
    const scene = makeScene();
    const { ctx } = makeCtx(scene);
    initDetail(ctx);

    const normalNode = makeNormalNode('schema-1');
    ctx.selectNode(normalNode);

    // Ring added to node's own mesh, not to the scene
    expect(normalNode.__mesh._children.length).toBeGreaterThan(0);
    expect(scene._adds.length).toBe(0);
  });
});
