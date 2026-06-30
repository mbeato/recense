/**
 * tests/viz-ambient-liveliness.test.ts
 *
 * TDD tests for Phase 54 Plan 02 — three-layer ambient liveliness in trace.js:
 *   Layer 1 (Task 1): live recall amplification (ACT_SCALE_GAIN / ACT_BRIGHTEN_GAIN / ACT_HAZE_LERP)
 *   Layer 2 (Task 2): replay echo branch (row.replay === true → REPLAY_DIM intensity)
 *   Layer 3 (Task 3): ambient twinkle tick (ctx.registerTick; setColorAt only; no spawnPulse)
 *
 * RED/GREEN commits are per-task per the TDD execution flow.
 * Source-text guard pattern mirrors viz-layout-guards.test.ts (Phase 53).
 * Behavioral pattern mirrors viz-haze-activation.test.ts (Phase 52).
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── THREE mock ─────────────────────────────────────────────────────────────────
// Must be declared before any module import; factory is hoisted by vitest.
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
    set(_x: number, _y: number, _z: number) { return this; }
    normalize() { return this; }
  }
  class Quaternion { setFromUnitVectors() { return this; } }
  class CylinderGeometry {}
  class SphereGeometry { constructor(_r?: number, _w?: number, _h?: number) {} }
  class ShaderMaterial {
    uniforms: any = {};
    constructor(o: any) { this.uniforms = o?.uniforms ?? {}; }
    dispose() {}
  }
  class MeshBasicMaterial {
    color: Color;
    transparent?: boolean;
    depthWrite?: boolean;
    opacity = 1;
    constructor(p?: any) {
      this.color = new Color();
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
  return {
    Color, Vector3, Quaternion, CylinderGeometry, SphereGeometry,
    ShaderMaterial, MeshBasicMaterial, Mesh, AdditiveBlending,
  };
});

// ── Browser globals ─────────────────────────────────────────────────────────
// Must be set BEFORE the module import so initTrace's getElementById call is safe.
if (typeof (globalThis as any).performance === 'undefined') {
  (globalThis as any).performance = { now: () => Date.now() };
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
// no-op setTimeout so fade-back timers inside applyTrace/replay don't throw
(globalThis as any).setTimeout = (_fn: any, _ms: number) => {};

// ── Imports ──────────────────────────────────────────────────────────────────
// @ts-ignore — browser ESM; no type declarations in this project
import { initTrace } from '../src/viz/modules/trace.js';
// @ts-ignore
import {
  ACT_SCALE_GAIN,
  REPLAY_DIM,
  DECAY_ATTACK_MS,
} from '../src/viz/modules/constants.js';

// ── Source-text helpers ────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');

function readTraceJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/trace.js'), 'utf8');
}

/** Strip JSDoc inner lines and standalone comment lines before token assertions. */
function stripComments(src: string): string {
  return src.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a minimal regular (non-haze) node. setScalar is a spy for scale assertions. */
function makeRegularNode(id: string) {
  const setScalarSpy = vi.fn();
  const node: any = {
    id,
    __mat:    { color: { copy: () => ({ lerp: () => {} }), lerp: () => {} }, opacity: 0.85 },
    __mesh:   { scale: { setScalar: setScalarSpy } },
    __base:   null,
    __baseOp: 0.85,
    __baseR:  1,
    __actGain: 1,
    __act:     undefined as number | undefined,
    __actT0:   undefined as number | undefined,
    __actPeak: undefined as number | undefined,
  };
  return { node, setScalarSpy };
}

/** Build a minimal haze node (InstancedMesh path: __hazeIdx + __hazeBase, no __mat). */
function makeHazeNode(id: string, idx: number): any {
  return {
    id,
    __cat:      'haze',
    __hazeIdx:  idx,
    __hazeBase: {
      r: 0.4, g: 0.5, b: 0.6,
      clone: () => ({ r: 0.4, g: 0.5, b: 0.6, lerp: (_: any, _t: number) => ({}) }),
    },
    x: 0, y: 0, z: 0,
    __act:     undefined as number | undefined,
    __actT0:   undefined as number | undefined,
    __actPeak: undefined as number | undefined,
  };
}

/**
 * Build a minimal ctx and call initTrace.
 * ticks[] collects every fn passed to ctx.registerTick (in registration order).
 * hazeMesh is null unless hazeNodes is non-empty.
 */
function makeCtx(nodes: any[] = [], hazeNodes: any[] = []) {
  const ticks: Array<(now: number) => void> = [];
  const setColorAtSpy = vi.fn();

  const hazeMesh = hazeNodes.length > 0
    ? { setColorAt: setColorAtSpy, instanceColor: { needsUpdate: false } }
    : null;

  const idMap = new Map<string, any>();
  for (const n of [...nodes, ...hazeNodes]) idMap.set(n.id, n);

  const ctx: any = {
    idMap,
    adj:        new Map(),
    traceNodes: new Set<string>(),
    traceLinks: new Set<string>(),
    logEvent:      vi.fn(),
    markAnimating: vi.fn(),
    revealTrace:   vi.fn(),
    pulseGroup:    null,   // spawnPulse is a no-op when null
    hazeMesh,
    registerTick: (fn: (now: number) => void) => ticks.push(fn),
    linkKey: (e: any) => `${e.source}-${e.target}`,
    allNodes: [...nodes, ...hazeNodes],
  };

  initTrace(ctx);
  return { ctx, ticks, setColorAtSpy };
}

// =============================================================================
// Layer 1 — Live recall amplification (Task 1 TDD)
// RED: these tests fail because trace.js still uses inline 0.35 / 0.4 / 0.8
// GREEN: pass after importing + using ACT_SCALE_GAIN / ACT_BRIGHTEN_GAIN / ACT_HAZE_LERP
// =============================================================================

describe('Layer 1 — live recall amplification (SC2)', () => {

  it('regular node scale at peak uses ACT_SCALE_GAIN coefficient (not old 0.35)', () => {
    // At a=1.0 in the hold phase, scale should be baseR*(1 + ACT_SCALE_GAIN).
    // With ACT_SCALE_GAIN=0.9: expected 1.9.
    // Old code uses 0.35 → 1.35. Test FAILS in RED, PASSES in GREEN.
    const { node, setScalarSpy } = makeRegularNode('n1');
    const { ctx, ticks } = makeCtx([node]);

    ctx.activate(node, 1.0);
    // node.__actT0 is set by activate(); advance to hold phase (past DECAY_ATTACK_MS)
    const tickTime = (node.__actT0 as number) + DECAY_ATTACK_MS + 50;
    ticks[0]!(tickTime);

    const calls = setScalarSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastScale = calls[calls.length - 1][0] as number;
    // Must be close to 1 + ACT_SCALE_GAIN, NOT 1.35 (old inline 0.35)
    expect(lastScale).toBeCloseTo(1 + ACT_SCALE_GAIN, 3);
  });

  it('trace.js uses ACT_BRIGHTEN_GAIN for opacity boost (source-text guard)', () => {
    // The named constant must appear in non-comment source lines.
    // FAILS in RED (not yet imported/used). PASSES in GREEN (coefficient swapped).
    const src = stripComments(readTraceJs());
    expect(src).toContain('ACT_BRIGHTEN_GAIN');
  });

  it('trace.js uses ACT_HAZE_LERP for haze color lerp (source-text guard)', () => {
    // The haze lerp factor must be the named constant, not inline 0.8.
    // FAILS in RED. PASSES in GREEN.
    const src = stripComments(readTraceJs());
    expect(src).toContain('ACT_HAZE_LERP');
  });

  it('trace.js does not call setMatrixAt anywhere (SC5 perf invariant — non-regression)', () => {
    // Haze nodes must be touched via setColorAt only. setMatrixAt would update
    // the 6k-instance matrix buffer each frame — the perf invariant forbids it.
    // This guard is already satisfied in the current codebase; tests that it stays so.
    const src = stripComments(readTraceJs());
    expect(src).not.toContain('setMatrixAt');
  });

});
