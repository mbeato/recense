/**
 * tests/viz-detail-focus-camera.test.ts
 *
 * 58-08 Stage-2 second-round rejection regression:
 *   "clicking a node feels awkward since there are 2 repositions — i don't
 *   really like it" — the D-06 orbit-then-dolly staged focus flight (a
 *   pull-back, then an orbit, then a dolly-in, each its own
 *   ctx.setCameraTarget call gated by a phase timer) read as two distinct
 *   repositions. Fixed by collapsing detail.js's focusCamera to ONE
 *   continuous setCameraTarget call to the final focus pose.
 *
 *   "trying to drag/move the brain while a node is focused is also pretty
 *   broken" — caused by the same phase timers re-issuing setCameraTarget
 *   mid-flight, stomping a manual drag the instant it started (each call
 *   re-arms camera.js's damp loop, per the 760b43b interrupt rule). With the
 *   phase timers removed, selectNode never schedules a second retarget, so
 *   nothing re-arms the damp loop after the initial move settles or is
 *   interrupted.
 *
 * These tests assert on ctx.setCameraTarget call counts/timing directly
 * (detail.js's own contract), complementing the lower-level damp-loop
 * interrupt invariants already covered in tests/viz-camera-damp.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — three is mocked by vi.mock above; no type declarations in this project
import * as THREE from 'three';

vi.mock('three', () => {
  class Color {
    r = 0; g = 0; b = 0;
    constructor(hex?: number) { if (hex !== undefined) this.set(hex); }
    set(hex: number) { this.r = ((hex >> 16) & 0xff) / 255; this.g = ((hex >> 8) & 0xff) / 255; this.b = (hex & 0xff) / 255; return this; }
    copy(o: Color) { this.r = o.r; this.g = o.g; this.b = o.b; return this; }
    clone() { const c = new Color(); c.r = this.r; c.g = this.g; c.b = this.b; return c; }
    lerp(_o: Color, _t: number) { return this; }
  }
  class Vector3 { x = 0; y = 0; z = 0; set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; } normalize() { return this; } }
  class Quaternion { setFromUnitVectors() { return this; } }
  class Matrix4 { elements = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
  class CylinderGeometry {}
  class SphereGeometry { constructor(_r?: number, _w?: number, _h?: number) {} dispose() {} }
  class PlaneGeometry { constructor(_w?: number, _h?: number) {} dispose?() {} }
  class ShaderMaterial { uniforms: any = {}; constructor(_a: any) {} }
  class TextureLoader { load(_url: string) { return {}; } }
  class RingGeometry { constructor(_inner?: number, _outer?: number, _seg?: number) {} dispose() {} }
  class MeshBasicMaterial { constructor(p?: any) { Object.assign(this, p ?? {}); } dispose() {} }
  class Mesh {
    position = { _x: 0, _y: 0, _z: 0, set(x: number, y: number, z: number) { this._x = x; this._y = y; this._z = z; } };
    scale = { set(_x: number, _y: number, _z: number) {}, setScalar(_s: number) {} };
    geometry: any = null; material: any = null; _children: any[] = [];
    constructor(geo?: any, mat?: any) { this.geometry = geo; this.material = mat; }
    add(child: any) { this._children.push(child); }
    remove(child: any) { this._children = this._children.filter((c: any) => c !== child); }
    setRotationFromQuaternion(_q: any) {}
  }
  class Group { add(_m: any) {} remove(_m: any) {} }
  const AdditiveBlending = 2;
  const DoubleSide = 2;
  const BackSide = 1;
  return { Color, Vector3, Quaternion, Matrix4, CylinderGeometry, SphereGeometry, PlaneGeometry, ShaderMaterial, TextureLoader, RingGeometry, MeshBasicMaterial, Mesh, Group, AdditiveBlending, DoubleSide, BackSide };
});

// detail.js imports graph.js, whose module scope reads window.innerWidth/
// innerHeight + loads a texture at import-evaluation time (hoisted before
// this file's own top-level statements) — vi.hoisted is required, same
// convention as tests/viz-haze-selection.test.ts.
vi.hoisted(() => {
  function makeNullEl() {
    return {
      textContent: '', style: { display: '' }, className: '',
      appendChild(_: any) {},
      querySelector(_: string): any { return null; },
      querySelectorAll(_: string) { return []; },
      addEventListener(_: string, _cb: any) {},
      removeEventListener(_: string, _cb: any) {},
      classList: { add(_: string) {}, remove(_: string) {}, contains(_: string) { return false; } },
      innerHTML: '', dataset: {}, offsetWidth: 0,
    };
  }
  (globalThis as any).document = {
    getElementById: (_id: string) => makeNullEl(),
    querySelector: (_sel: string) => makeNullEl(),
    createElement: (_tag: string) => makeNullEl(),
    addEventListener(_: string, _cb: any) {},
    removeEventListener(_: string, _cb: any) {},
    body: makeNullEl(),
  };
  (globalThis as any).window = {
    innerWidth: 1024, innerHeight: 768,
    addEventListener(_: string, _cb: any) {},
    removeEventListener(_: string, _cb: any) {},
  };
  (globalThis as any).location = { search: '', href: '' };
  (globalThis as any).BroadcastChannel = class { addEventListener() {} };
  if (typeof (globalThis as any).performance === 'undefined') {
    (globalThis as any).performance = { now: () => Date.now() };
  }
});

// @ts-ignore — browser ESM, no type declarations
import { initDetail } from '../src/viz/modules/detail.js';

function makeNode(id: string) {
  const mesh: any = {
    _children: [],
    add(c: any) { this._children.push(c); },
    remove(c: any) { this._children = this._children.filter((x: any) => x !== c); },
    scale: { setScalar(_: number) {} },
  };
  return { id, type: 'entity', __mesh: mesh, __baseR: 2, __mat: { color: {}, opacity: 1 }, __cat: 'entity', x: 10, y: 20, z: 30 };
}

function makeCtx() {
  const setCameraTarget = vi.fn();
  const ctx: any = {
    idMap: new Map(), adj: new Map(), allNodes: [],
    traceNodes: new Set(), traceLinks: new Set(),
    revealTrace: vi.fn(), logEvent: vi.fn(),
    markAnimating: vi.fn(), markActive: vi.fn(),
    pulseGroup: { add: vi.fn(), remove: vi.fn() },
    hazeMesh: null, hazeMat: null, hazeNodeIdMap: new Map(),
    nodeVisible: (_n: any) => true,
    spawnPulse: vi.fn(), activate: vi.fn(),
    recenter: vi.fn(),
    setCameraTarget,
    Graph: {
      scene: () => ({ add: vi.fn(), remove: vi.fn() }),
      cameraPosition: () => ({ x: 0, y: 0, z: 500, lookAt: { x: 0, y: 0, z: 0 } }),
      camera: () => ({ near: 0.1, far: 2000 }),
    },
    THREE,
    registerTick: (_fn: (now: number) => void) => {},
  };
  return { ctx, setCameraTarget };
}

describe('detail.js node focus — single continuous camera move (58-08 Stage-2 round 2)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('selectNode issues exactly ONE ctx.setCameraTarget call — no staged flight', () => {
    const { ctx, setCameraTarget } = makeCtx();
    initDetail(ctx);

    ctx.selectNode(makeNode('n1'));

    expect(setCameraTarget).toHaveBeenCalledTimes(1);
  });

  it('the single call targets the final focus pose immediately (no pull-back / orbit intermediate)', () => {
    const { ctx, setCameraTarget } = makeCtx();
    initDetail(ctx);
    const node = makeNode('n1');

    ctx.selectNode(node);

    expect(setCameraTarget).toHaveBeenCalledWith(
      { x: node.x + 220, y: node.y + 80, z: node.z + 220 },
      { x: node.x, y: node.y, z: node.z },
    );
  });

  it('no additional setCameraTarget call fires later — no phase timers left pending', () => {
    const { ctx, setCameraTarget } = makeCtx();
    initDetail(ctx);

    ctx.selectNode(makeNode('n1'));
    expect(setCameraTarget).toHaveBeenCalledTimes(1);

    // Advance well past the old FOCUS_ORBIT_MS (300) + FOCUS_DOLLY_MS (600)
    // phase-timer gates — a regression would fire a 2nd/3rd call here.
    vi.advanceTimersByTime(5000);

    expect(setCameraTarget).toHaveBeenCalledTimes(1);
  });

  it('re-selecting a different node while "in flight" still issues exactly one NEW call, not a queued extra', () => {
    const { ctx, setCameraTarget } = makeCtx();
    initDetail(ctx);

    ctx.selectNode(makeNode('n1'));
    vi.advanceTimersByTime(100); // well before the old phase gates would have fired
    ctx.selectNode(makeNode('n2'));
    vi.advanceTimersByTime(5000);

    // One call per selectNode — never a delayed 2nd/3rd call sneaking in for n1.
    expect(setCameraTarget).toHaveBeenCalledTimes(2);
  });

  it('closeDetail does not itself add an extra setCameraTarget call beyond ctx.recenter', () => {
    const { ctx, setCameraTarget } = makeCtx();
    initDetail(ctx);

    ctx.selectNode(makeNode('n1'));
    setCameraTarget.mockClear();

    ctx.closeDetail();

    // closeDetail delegates unframing to ctx.recenter (graph.js's single-move
    // recenter) — detail.js itself must not call setCameraTarget directly.
    expect(ctx.recenter).toHaveBeenCalledTimes(1);
    expect(setCameraTarget).not.toHaveBeenCalled();
  });
});
