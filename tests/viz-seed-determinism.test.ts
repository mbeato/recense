/**
 * tests/viz-seed-determinism.test.ts
 *
 * TDD test for the Phase 53 seedNodePositions() rewrite in graph.js.
 *
 * Verifies (D-08) determinism: identical corpus → identical positions on every call.
 * Verifies (D-02) clustering: member nodes land within CLUSTER_RADIUS of their hub.
 * Verifies (D-04) no-lattice: continuous placement passes brainOccupied.
 *
 * Pattern mirrors viz-haze-activation.test.ts: vi.mock('three') headless,
 * window/document stubbed, import the ESM directly.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Globals needed by graph.js module-level code — set via vi.hoisted() ──────
// vi.hoisted() runs before static imports, so window/document are available
// when graph.js evaluates `const COMPACT = Math.min(window.innerWidth, ...)`.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { innerWidth: 1920, innerHeight: 1080 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    getElementById: (_id: string) => ({ style: { opacity: '1', transition: '' } }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).performance === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).performance = { now: () => Date.now() };
  }
});

// ── THREE mock — must be fully self-contained (vi.mock factory is hoisted) ──────
// Implements real matrix/vector math so positions are meaningful, not trivially 0.
vi.mock('three', () => {
  // 16-element column-major matrix tuple (fixed indices → TypeScript knows they exist)
  type M16 = [
    number,number,number,number,
    number,number,number,number,
    number,number,number,number,
    number,number,number,number,
  ];

  class Euler {
    x: number; y: number; z: number; order: string;
    constructor(x = 0, y = 0, z = 0, order = 'XYZ') {
      this.x = x; this.y = y; this.z = z; this.order = order;
    }
  }

  class Matrix4 {
    elements: M16;
    constructor() {
      this.elements = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    }
    makeRotationFromEuler(e: Euler) {
      // THREE.js XYZ Euler → rotation matrix (column-major, same formula as THREE source)
      const a = Math.cos(e.x), b = Math.sin(e.x);
      const c = Math.cos(e.y), d = Math.sin(e.y);
      const ec = Math.cos(e.z), f = Math.sin(e.z);
      const ae = a * ec, af = a * f, be = b * ec, bf = b * f;
      this.elements = [
        c*ec,          af+be*d, bf-ae*d, 0,
        -c*f,          ae-bf*d, be+af*d, 0,
        d,             -b*c,    a*c,     0,
        0,             0,       0,       1,
      ];
      return this;
    }
    clone(): Matrix4 {
      const m = new Matrix4();
      m.elements = [...this.elements] as M16;
      return m;
    }
    invert(): Matrix4 {
      // For a pure rotation matrix, inverse = transpose of the 3×3 sub-block
      const [e0,e1,e2,e3, e4,e5,e6,e7, e8,e9,e10,e11, e12,e13,e14,e15] = this.elements;
      this.elements = [
        e0, e4, e8,  e12,
        e1, e5, e9,  e13,
        e2, e6, e10, e14,
        e3, e7, e11, e15,
      ];
      return this;
    }
    copy(m: Matrix4): Matrix4 { this.elements = [...m.elements] as M16; return this; }
  }

  class Vector3 {
    x: number; y: number; z: number;
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x: number, y: number, z: number): Vector3 { this.x = x; this.y = y; this.z = z; return this; }
    clone(): Vector3 { return new Vector3(this.x, this.y, this.z); }
    multiplyScalar(s: number): Vector3 { this.x *= s; this.y *= s; this.z *= s; return this; }
    applyMatrix4(m: Matrix4): Vector3 {
      // Standard THREE.js column-major multiply (no translation in our rotation matrices)
      const [e0,e1,e2,e3, e4,e5,e6,e7, e8,e9,e10,e11, e12,e13,e14,e15] = m.elements;
      const x = this.x, y = this.y, z = this.z;
      const w = 1 / (e3*x + e7*y + e11*z + e15);
      this.x = (e0*x + e4*y + e8*z  + e12) * w;
      this.y = (e1*x + e5*y + e9*z  + e13) * w;
      this.z = (e2*x + e6*y + e10*z + e14) * w;
      return this;
    }
    normalize(): Vector3 { return this; }
  }

  class SphereGeometry { constructor(_r?: number, _w?: number, _h?: number) {} }
  // Phase 58: buildHazeLayer's module-scope _hazeQuadGeo constructs this at
  // import time (graph.js top-level), so it must be mocked even though this
  // test never exercises buildHazeLayer directly.
  class PlaneGeometry { constructor(_w?: number, _h?: number) {} dispose?() {} }
  class MeshBasicMaterial {
    color = {}; transparent = false; depthWrite = true; opacity = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(p?: any) { if (p) Object.assign(this, p); }
    dispose() {}
  }
  class Mesh {
    position = { set(_x: number, _y: number, _z: number) {} };
    scale = { set(_x: number, _y: number, _z: number) {}, setScalar(_s: number) {} };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class Group { add(_m: any) {} remove(_m: any) {} }
  const AdditiveBlending = 2;

  return { Euler, Matrix4, Vector3, SphereGeometry, PlaneGeometry, MeshBasicMaterial, Mesh, Group, AdditiveBlending };
});

// @ts-ignore — browser ESM; no type declarations
import { seedNodePositions } from '../src/viz/modules/graph.js';
// @ts-ignore
import { BRAIN_SCALE } from '../src/viz/modules/constants.js';

// ── Shared node type for this test ────────────────────────────────────────────
interface TestNode {
  id: string;
  __cat: string;
  __members?: number;
  __schemaId?: string;
  x?: number;
  y?: number;
  z?: number;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Build a fake brainVol with ALL voxels occupied.
 * res=8 → 512 voxels, bits all 0xFF → brainOccupied always true for
 * in-bounds coords. Every placement attempt succeeds on the first try.
 */
function makeFakeBrainVol(res = 8) {
  const bitCount = res * res * res;
  const byteCount = Math.ceil(bitCount / 8);
  const bits = new Uint8Array(byteCount).fill(0xFF);
  return { res, bits };
}

/** 1 schema hub + 2 members that point to it + 1 haze node. */
function makeNodes(): TestNode[] {
  return [
    { id: 'hub1',  __cat: 'schema', __members: 2 },
    { id: 'mem1',  __cat: 'member', __schemaId: 'hub1' },
    { id: 'mem2',  __cat: 'member', __schemaId: 'hub1' },
    { id: 'haze1', __cat: 'haze' },
  ];
}

/** Snapshot positions (all as number, seeding must have set them). */
function snapPositions(nodes: TestNode[]) {
  return nodes.map(n => ({
    id: n.id,
    x: n.x as number,
    y: n.y as number,
    z: n.z as number,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('seedNodePositions', () => {
  // Mirrors the internal constant in graph.js (0.12 * BRAIN_SCALE)
  const CLUSTER_RADIUS: number = 0.12 * (BRAIN_SCALE as number);

  it('produces identical positions on two consecutive calls (determinism D-08)', () => {
    const brainVol = makeFakeBrainVol();

    const nodes1 = makeNodes();
    seedNodePositions(nodes1, brainVol);
    const snap1 = snapPositions(nodes1);

    const nodes2 = makeNodes();
    seedNodePositions(nodes2, brainVol);
    const snap2 = snapPositions(nodes2);

    for (let i = 0; i < snap1.length; i++) {
      const s1 = snap1[i]!;
      const s2 = snap2[i]!;
      expect(s2.x).toBeCloseTo(s1.x, 10);
      expect(s2.y).toBeCloseTo(s1.y, 10);
      expect(s2.z).toBeCloseTo(s1.z, 10);
    }
  });

  it('all seeded positions are finite and defined (valid hull points D-04)', () => {
    const brainVol = makeFakeBrainVol();
    const nodes = makeNodes();
    seedNodePositions(nodes, brainVol);

    for (const n of nodes) {
      expect(n.x).toBeDefined();
      expect(n.y).toBeDefined();
      expect(n.z).toBeDefined();
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(Number.isFinite(n.z)).toBe(true);
    }
  });

  it('member nodes land within CLUSTER_RADIUS of their schema hub per axis (clustering D-02)', () => {
    const brainVol = makeFakeBrainVol();
    const nodes = makeNodes();
    seedNodePositions(nodes, brainVol);

    const hub  = nodes.find(n => n.id === 'hub1')!;
    const mem1 = nodes.find(n => n.id === 'mem1')!;
    const mem2 = nodes.find(n => n.id === 'mem2')!;

    // Hub placed in Pass 1 — must be defined before member placement
    expect(hub.x).toBeDefined();

    // All voxels occupied → first cluster attempt always succeeds →
    // per-axis offset is bounded by exactly CLUSTER_RADIUS.
    const eps = 1e-9;
    expect(Math.abs((mem1.x ?? 0) - (hub.x ?? 0))).toBeLessThanOrEqual(CLUSTER_RADIUS + eps);
    expect(Math.abs((mem1.y ?? 0) - (hub.y ?? 0))).toBeLessThanOrEqual(CLUSTER_RADIUS + eps);
    expect(Math.abs((mem1.z ?? 0) - (hub.z ?? 0))).toBeLessThanOrEqual(CLUSTER_RADIUS + eps);

    expect(Math.abs((mem2.x ?? 0) - (hub.x ?? 0))).toBeLessThanOrEqual(CLUSTER_RADIUS + eps);
    expect(Math.abs((mem2.y ?? 0) - (hub.y ?? 0))).toBeLessThanOrEqual(CLUSTER_RADIUS + eps);
    expect(Math.abs((mem2.z ?? 0) - (hub.z ?? 0))).toBeLessThanOrEqual(CLUSTER_RADIUS + eps);
  });

  it('haze nodes are placed without error (Pass 3)', () => {
    const brainVol = makeFakeBrainVol();
    const nodes = makeNodes();
    seedNodePositions(nodes, brainVol);

    const hazeNode = nodes.find(n => n.id === 'haze1')!;
    expect(hazeNode.x).toBeDefined();
    expect(Number.isFinite(hazeNode.x)).toBe(true);
  });

  it('null brainVol fallback runs without crash (random scatter path)', () => {
    const nodes = makeNodes();
    expect(() => seedNodePositions(nodes, null)).not.toThrow();
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
    }
  });
});
