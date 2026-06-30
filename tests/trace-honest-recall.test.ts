/**
 * tests/trace-honest-recall.test.ts
 *
 * Structural honesty tests for the Phase-52 honest-trace rewrite:
 *
 *   D-08 #1 — exactly-N-hops: a recall payload with N hop edges → applyTrace
 *             lights EXACTLY N hop nodes matching row.hops (no client BFS).
 *   D-07    — seed intensity tracks score: higher-score seed → higher __act
 *             than lower-score seed (real numeric comparison, not prose).
 *   D-08 #2 — no BFS: even with a dense ctx.adj, traceEdgesFromHops returns
 *             only row.hops.length entries (the honesty regression guard).
 *   WR-02   — score:null seeds/hops render at fixed mid intensity (not 0,
 *             not fabricated).
 *   Back-compat — bare-string seeds still work (legacy/ingestion shape).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore — three is mocked below; no type declarations in this project
import * as THREE from 'three';

// ── THREE mock ─────────────────────────────────────────────────────────────
// Mirrors tests/viz-haze-selection.test.ts; must be declared before vi.mock.
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
    set(hex: number) {
      this.r = ((hex >> 16) & 0xff) / 255;
      this.g = ((hex >> 8)  & 0xff) / 255;
      this.b = (hex         & 0xff) / 255;
      return this;
    }
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
  class SphereGeometry { constructor(_r?: number, _w?: number, _h?: number) {} }
  class ShaderMaterial { uniforms: any = {}; constructor(o: any) { this.uniforms = o?.uniforms ?? {}; } dispose() {} }
  class MeshBasicMaterial {
    color: Color;
    transparent?: boolean;
    depthWrite?: boolean;
    opacity = 1;
    constructor(p?: any) {
      this.color = new Color();
      if (p?.color instanceof Color) this.color.copy(p.color);
      if (p?.transparent !== undefined) this.transparent = p.transparent;
      if (p?.depthWrite  !== undefined) this.depthWrite  = p.depthWrite;
    }
    dispose() {}
  }
  class Mesh {
    position = { set(_x: number, _y: number, _z: number) {} };
    scale    = { set(_x: number, _y: number, _z: number) {}, setScalar(_s: number) {} };
    constructor(_geo?: any, _mat?: any) {}
    setRotationFromQuaternion(_q: any) {}
  }
  const AdditiveBlending = 2;
  return { Color, Vector3, Quaternion, CylinderGeometry, SphereGeometry, ShaderMaterial, MeshBasicMaterial, Mesh, AdditiveBlending };
});

// ── Browser globals ─────────────────────────────────────────────────────────
// Must be set BEFORE the module import so initTrace's getElementById call is safe.
if (typeof (globalThis as any).performance === 'undefined') {
  (globalThis as any).performance = { now: () => 0 };
}
(globalThis as any).document = {
  getElementById: (_id: string): any => null,
  querySelector:  (_sel: string): any => null,
  createElement:  (_tag: string): any => ({ style: {}, className: '', addEventListener() {} }),
  addEventListener(_: string, _cb: any) {},
  body: { appendChild() {} },
};
(globalThis as any).window = {
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener(_: string, _cb: any) {},
};
// no-op setTimeout so the fade-back timer inside applyTrace doesn't throw
(globalThis as any).setTimeout = (_fn: any, _ms: number) => { /* sync tests — timer is no-op */ };

// ── Imports ──────────────────────────────────────────────────────────────────
// @ts-ignore — browser ESM module, no type declarations
import { initTrace, traceEdgesFromHops, normalizeSeed } from '../src/viz/modules/trace.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal regular node (has __mat → passes the activate guard).
 * After applyTrace runs, check node.__act and node.__actPeak directly —
 * the local `activate` closure sets them synchronously; tick never runs.
 */
function makeNode(id: string): any {
  return {
    id,
    __mat:  { color: { copy(_: any) { return this; }, lerp(_: any, _t: any) { return this; } }, opacity: 0.85 },
    __mesh: { scale: { setScalar(_s: number) {} } },
    __base: null,
    __baseOp: 0.85,
    __baseR: 1,
    __actGain: 1,
    // These get written by activate():
    __act:     undefined as number | undefined,
    __actT0:   undefined as number | undefined,
    __actPeak: undefined as number | undefined,
  };
}

/** Build a minimal ctx and call initTrace on it. */
function makeCtx(nodes: any[] = []) {
  const idMap = new Map<string, any>();
  for (const n of nodes) idMap.set(n.id, n);

  const ctx: any = {
    idMap,
    adj: new Map<string, any[]>(),
    traceNodes: new Set<string>(),
    traceLinks: new Set<string>(),
    logEvent: vi.fn(),
    markAnimating: vi.fn(),
    revealTrace: vi.fn(),
    pulseGroup: { add: vi.fn() },
    registerTick: vi.fn(),
    linkKey: (e: any) => `${e.source}-${e.target}`,
    allNodes: nodes,
  };

  initTrace(ctx);
  return { ctx };
}

// ============================================================================
// traceEdgesFromHops — pure helper (no BFS, no ctx.adj)
// ============================================================================

describe('traceEdgesFromHops', () => {
  it('returns exactly N hop records matching row.hops node_ids', () => {
    const idMap = new Map([
      ['a', { id: 'a' }],
      ['b', { id: 'b' }],
      ['c', { id: 'c' }],
    ]);
    const row = {
      seeds: [{ node_id: 's', score: 0.9 }],
      hops: [
        { node_id: 'a', score: 0.5, hop: 1 },
        { node_id: 'b', score: 0.3, hop: 1 },
        { node_id: 'c', score: 0.2, hop: 1 },
      ],
    };
    const result = traceEdgesFromHops(row, idMap);
    expect(result.length).toBe(3);
    expect(result.map((r: any) => r.node_id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('dense-adjacency case: returns ONLY row.hops.length — no BFS leakage (D-08 #1)', () => {
    // Build idMap with 50 nodes; payload has only 2 hops.
    // traceEdgesFromHops must return 2, NOT 50.
    const idMap = new Map<string, any>();
    for (let i = 0; i < 50; i++) idMap.set(`node${i}`, { id: `node${i}` });

    const row = {
      seeds: [{ node_id: 'node0', score: 1.0 }],
      hops: [
        { node_id: 'node1', score: 0.5, hop: 1 },
        { node_id: 'node2', score: 0.4, hop: 1 },
      ],
    };
    const result = traceEdgesFromHops(row, idMap);
    // Load-bearing no-BFS assertion: helper returns ONLY row.hops.length,
    // even when idMap has 50 nodes — any more would mean BFS leaked in.
    expect(result.length).toBe(row.hops.length);
    expect(result.length).toBe(2);
  });

  it('skips hop nodes absent from idMap without inventing a substitute', () => {
    const idMap = new Map([['exists', { id: 'exists' }]]);
    const row = {
      seeds: [],
      hops: [
        { node_id: 'exists',  score: null, hop: 1 },
        { node_id: 'missing', score: null, hop: 1 },
      ],
    };
    const result = traceEdgesFromHops(row, idMap);
    expect(result.length).toBe(1);
    expect(result[0].node_id).toBe('exists');
  });

  it('returns empty array for row with zero hops (seed-only trace)', () => {
    const idMap = new Map([['s', { id: 's' }]]);
    const row = { seeds: [{ node_id: 's', score: 0.9 }], hops: [] };
    const result = traceEdgesFromHops(row, idMap);
    expect(result.length).toBe(0);
  });

  it('handles score:null hops without throwing', () => {
    const idMap = new Map([['h', { id: 'h' }]]);
    const row = {
      seeds: [],
      hops: [{ node_id: 'h', score: null, hop: 1 }],
    };
    const result = traceEdgesFromHops(row, idMap);
    expect(result.length).toBe(1);
    expect(result[0].score).toBeNull();
  });
});

// ============================================================================
// normalizeSeed — shape-normalise helper
// ============================================================================

describe('normalizeSeed', () => {
  it('normalizes bare string → {node_id, score: null} (legacy/ingestion back-compat)', () => {
    const r = normalizeSeed('abc');
    expect(r).toEqual({ node_id: 'abc', score: null });
  });

  it('normalizes {node_id, score} object', () => {
    const r = normalizeSeed({ node_id: 'x', score: 0.7 });
    expect(r).toEqual({ node_id: 'x', score: 0.7 });
  });

  it('normalizes {node_id, score: null} (WR-02 recall shape)', () => {
    const r = normalizeSeed({ node_id: 'y', score: null });
    expect(r).toEqual({ node_id: 'y', score: null });
  });
});

// ============================================================================
// applyTrace — driven by server row (seeds + hops, no BFS)
// ============================================================================
// After applyTrace() the local `activate` closure has written node.__act and
// node.__actPeak synchronously (tick never runs in unit tests). We check those
// fields directly — simpler and more accurate than wrapping ctx.activate.

describe('applyTrace — all seeds lit (D-07)', () => {
  it('lights BOTH seeds when row has 2 scored seeds', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const { ctx } = makeCtx([a, b]);

    ctx.applyTrace({
      seeds: [{ node_id: 'a', score: 0.9 }, { node_id: 'b', score: 0.3 }],
      hops: [],
    });

    expect(a.__actPeak).toBeGreaterThan(0);
    expect(b.__actPeak).toBeGreaterThan(0);
  });

  it('lights exactly M seed nodes — M=3 (exactly-M guarantee)', () => {
    const s1 = makeNode('s1');
    const s2 = makeNode('s2');
    const s3 = makeNode('s3');
    const { ctx } = makeCtx([s1, s2, s3]);

    ctx.applyTrace({
      seeds: [
        { node_id: 's1', score: 1.0 },
        { node_id: 's2', score: 0.6 },
        { node_id: 's3', score: 0.3 },
      ],
      hops: [],
    });

    expect(s1.__actPeak).toBeGreaterThan(0);
    expect(s2.__actPeak).toBeGreaterThan(0);
    expect(s3.__actPeak).toBeGreaterThan(0);
  });

  it('seed intensity tracks score: higher-score seed → higher intensity (D-07)', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const { ctx } = makeCtx([a, b]);

    ctx.applyTrace({
      seeds: [{ node_id: 'a', score: 0.9 }, { node_id: 'b', score: 0.3 }],
      hops: [],
    });

    // Load-bearing D-07 assertion: a (score=0.9) MUST be brighter than b (score=0.3).
    expect(a.__actPeak).toBeGreaterThan(b.__actPeak as number);
  });

  it('score:null seed renders at fixed mid intensity — not 0, not fabricated (WR-02)', () => {
    const x = makeNode('x');
    const { ctx } = makeCtx([x]);

    ctx.applyTrace({ seeds: [{ node_id: 'x', score: null }], hops: [] });

    expect(x.__actPeak).toBeGreaterThan(0.01);   // not zero / invisible
    expect(x.__actPeak).toBeLessThan(1.0);        // not at full (un-earned max)
  });

  it('bare-string seeds (legacy/ingestion shape) still light at mid fallback', () => {
    const y = makeNode('y');
    const { ctx } = makeCtx([y]);

    ctx.applyTrace({ seeds: ['y'], hops: [] });

    expect(y.__actPeak).toBeGreaterThan(0.01);
  });

  it('seed absent from idMap is silently skipped — no throw', () => {
    const real = makeNode('real');
    const { ctx } = makeCtx([real]);

    expect(() => {
      ctx.applyTrace({
        seeds: [{ node_id: 'ghost', score: 0.9 }, { node_id: 'real', score: 0.5 }],
        hops: [],
      });
    }).not.toThrow();

    expect(real.__actPeak).toBeGreaterThan(0);
    // 'ghost' never gets a node object → no __actPeak written
  });
});

describe('applyTrace — exactly-N hops, no BFS (D-08 #1)', () => {
  it('lights exactly N hop nodes from row.hops, ignoring ctx.adj completely', () => {
    const s  = makeNode('s');
    const h1 = makeNode('h1');
    const h2 = makeNode('h2');
    // Extra nodes that are in ctx.adj but NOT in row.hops — must NOT be lit
    const extras = Array.from({ length: 20 }, (_, i) => makeNode(`extra${i}`));
    const allNodes = [s, h1, h2, ...extras];
    const { ctx } = makeCtx(allNodes);

    // Dense adjacency for 's' (22 neighbors): applyTrace must IGNORE ctx.adj
    ctx.adj.set('s', [
      { source: 's', target: 'h1' },
      { source: 's', target: 'h2' },
      ...extras.map(e => ({ source: 's', target: e.id })),
    ]);

    ctx.applyTrace({
      seeds: [{ node_id: 's', score: 0.9 }],
      hops: [
        { node_id: 'h1', score: 0.5, hop: 1 },
        { node_id: 'h2', score: 0.3, hop: 1 },
      ],
    });

    // Seed lit
    expect(s.__actPeak).toBeGreaterThan(0);
    // Exactly 2 hop nodes lit
    expect(h1.__actPeak).toBeGreaterThan(0);
    expect(h2.__actPeak).toBeGreaterThan(0);
    // None of the 20 extra nodes (in ctx.adj but not in row.hops) should be lit
    for (const extra of extras) {
      expect(extra.__actPeak).toBeUndefined(); // activate() was never called
    }
  });

  it('empty hops row → zero hop nodes lit, seed still lights', () => {
    const s = makeNode('s');
    const phantom = makeNode('phantom');
    const { ctx } = makeCtx([s, phantom]);
    ctx.adj.set('s', [{ source: 's', target: 'phantom' }]);

    ctx.applyTrace({ seeds: [{ node_id: 's', score: 0.8 }], hops: [] });

    expect(s.__actPeak).toBeGreaterThan(0);
    expect(phantom.__actPeak).toBeUndefined(); // hops=[] → phantom never activated
  });

  it('hop absent from idMap is skipped without inventing a substitute', () => {
    const s = makeNode('s');
    const h = makeNode('h');
    const { ctx } = makeCtx([s, h]);

    ctx.applyTrace({
      seeds: [{ node_id: 's', score: 0.9 }],
      hops: [
        { node_id: 'h',       score: 0.5, hop: 1 },
        { node_id: 'missing', score: 0.4, hop: 1 }, // not in idMap
      ],
    });

    expect(h.__actPeak).toBeGreaterThan(0);
    // 'missing' is absent from idMap — traceEdgesFromHops skips it,
    // so no phantom node gets activated
  });
});
