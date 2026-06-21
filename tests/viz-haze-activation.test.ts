/**
 * tests/viz-haze-activation.test.ts
 *
 * TDD test for the instanced-haze activation branch in trace.js.
 *
 * Root cause: activate(node) in trace.js bails on `!node.__mat` (line 99).
 * Haze nodes rendered via InstancedMesh never get __mat set — they only have
 * __hazeIdx and __hazeBase. So prompt-triggered traces never light them up.
 *
 * Fix target: add a color-only instanced-haze branch in activate() and the
 * decay tick so haze nodes light with amber (HOT) and restore __hazeBase on decay.
 *
 * RED criteria (failing before fix):
 *   - ctx.hazeMesh.setColorAt is NOT called when activate() is given a haze node
 *
 * GREEN criteria (passing after fix):
 *   - ctx.hazeMesh.setColorAt IS called after activate() + one tick
 *   - After decay, color is restored to __hazeBase
 *
 * Pattern mirrors viz-lod-density.test.ts: import the browser ESM directly,
 * exercise via a fake ctx, mock the THREE import so it runs headlessly.
 */

import { describe, it, expect, vi } from 'vitest';

// ── THREE mock must be fully self-contained (vi.mock factory is hoisted) ──────
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
    copy(other: Color) {
      this.r = other.r; this.g = other.g; this.b = other.b;
      return this;
    }
    clone(): Color {
      return new Color().copy(this);
    }
    lerp(other: Color, t: number): Color {
      this.r += (other.r - this.r) * t;
      this.g += (other.g - this.g) * t;
      this.b += (other.b - this.b) * t;
      return this;
    }
  }

  class Vector3 {
    x = 0; y = 0; z = 0;
    set(_x: number, _y: number, _z: number) { return this; }
    normalize() { return this; }
  }
  class Quaternion {
    setFromUnitVectors() { return this; }
  }
  class CylinderGeometry {}
  class ShaderMaterial {
    uniforms: any = {};
    constructor(_a: any) {}
  }
  class Mesh {
    position = { set(_x: number, _y: number, _z: number) {} };
    scale    = { set(_x: number, _y: number, _z: number) {}, setScalar(_s: number) {} };
    setRotationFromQuaternion(_q: any) {}
  }
  class Group {
    add(_m: any) {} remove(_m: any) {}
  }
  const AdditiveBlending = 2;
  return { Color, Vector3, Quaternion, CylinderGeometry, ShaderMaterial, Mesh, Group, AdditiveBlending };
});

// trace.js calls document.getElementById at module init time (D-102 test button wiring).
// Stub it globally so initTrace doesn't throw in a headless Node environment.
(globalThis as any).document = {
  getElementById: (_id: string) => null,
};
// performance.now is available in Node 18+ but guard it anyway
if (typeof (globalThis as any).performance === 'undefined') {
  (globalThis as any).performance = { now: () => Date.now() };
}

// @ts-ignore — browser ESM; no type declarations
import { initTrace } from '../src/viz/modules/trace.js';
// @ts-ignore
import { HOT } from '../src/viz/modules/constants.js';

// ── Test-side color helper (mirrors the mock Color above) ────────────────────
// Used to create __hazeBase and __base values and to snapshot colors at assertion time.
// Needs copy/lerp so it works when passed to __base (existing non-haze path reads it).
class FakeColor {
  r = 0; g = 0; b = 0;
  constructor(hex?: number) {
    if (hex !== undefined) {
      this.r = ((hex >> 16) & 0xff) / 255;
      this.g = ((hex >> 8)  & 0xff) / 255;
      this.b = (hex         & 0xff) / 255;
    }
  }
  set(hex: number): this {
    this.r = ((hex >> 16) & 0xff) / 255;
    this.g = ((hex >> 8)  & 0xff) / 255;
    this.b = (hex         & 0xff) / 255;
    return this;
  }
  copy(other: FakeColor): this {
    this.r = other.r; this.g = other.g; this.b = other.b;
    return this;
  }
  clone(): FakeColor {
    const c = new FakeColor();
    c.r = this.r; c.g = this.g; c.b = this.b;
    return c;
  }
  lerp(other: FakeColor, t: number): this {
    this.r += (other.r - this.r) * t;
    this.g += (other.g - this.g) * t;
    this.b += (other.b - this.b) * t;
    return this;
  }
  equals(other: FakeColor, eps = 1e-4): boolean {
    return Math.abs(this.r - other.r) < eps &&
           Math.abs(this.g - other.g) < eps &&
           Math.abs(this.b - other.b) < eps;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build the minimal ctx that initTrace needs to initialise. */
function makeCtx() {
  const ticks: Array<(now: number) => void> = [];

  // Recorded setColorAt calls: [instanceId, cloned color at call time]
  const colorSetCalls: Array<{ idx: number; color: FakeColor }> = [];

  const hazeMesh = {
    setColorAt: vi.fn((idx: number, color: any) => {
      // Clone via FakeColor to capture the rgb values at call time
      const snap = new FakeColor();
      snap.r = color.r; snap.g = color.g; snap.b = color.b;
      colorSetCalls.push({ idx, color: snap });
    }),
    instanceColor: { needsUpdate: false },
  };

  const ctx: any = {
    idMap:         new Map(),
    adj:           new Map(),
    traceNodes:    new Set<string>(),
    traceLinks:    new Set<string>(),
    revealTrace:   vi.fn(),
    logEvent:      vi.fn(),
    markAnimating: vi.fn(),
    pulseGroup:    null,  // spawnPulse is a no-op when null

    hazeMesh,
    hazeNodeIdMap: new Map<string, number>(),

    registerTick: (fn: (now: number) => void) => { ticks.push(fn); },
  };

  return { ctx, ticks, colorSetCalls, hazeMesh };
}

/** Build a haze node: has __hazeIdx + __hazeBase, deliberately NO __mat / __mesh. */
function makeHazeNode(id: string, idx: number): any {
  const baseColor = new FakeColor(0x6d7890); // TYPE_COLOR.fact
  return {
    id,
    type: 'fact',
    __hazeIdx:  idx,
    __hazeBase: baseColor,
    x: 0, y: 0, z: 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('viz haze activation (instanced-haze color-only branch)', () => {

  it('RED: activate() on a haze node must call hazeMesh.setColorAt during the tick', () => {
    const { ctx, ticks, colorSetCalls } = makeCtx();
    initTrace(ctx);

    const node = makeHazeNode('haze-007', 7);
    ctx.hazeNodeIdMap.set('haze-007', 7);

    // Before the fix, activate() returns early on !node.__mat and this call is a no-op
    ctx.activate(node, 1.0);

    // Run tick with small dt so activation level stays > 0
    ticks[0]!(performance.now());

    // Must have called setColorAt for instance 7
    const callsForIdx7 = colorSetCalls.filter(c => c.idx === 7);
    expect(callsForIdx7.length).toBeGreaterThan(0);

    // The color must differ from base (lerped toward HOT amber, not stuck at base)
    const baseColor = node.__hazeBase as FakeColor;
    const activationColor = callsForIdx7[0]!.color;
    expect(activationColor.equals(baseColor)).toBe(false);
  });

  it('RED: hazeMesh.instanceColor.needsUpdate must be true after haze activation tick', () => {
    const { ctx, ticks, hazeMesh } = makeCtx();
    initTrace(ctx);

    const node = makeHazeNode('haze-042', 42);
    ctx.hazeNodeIdMap.set('haze-042', 42);

    ctx.activate(node, 1.0);
    ticks[0]!(performance.now());

    // Without the fix, needsUpdate stays false (setColorAt never called)
    expect(hazeMesh.instanceColor.needsUpdate).toBe(true);
  });

  it('RED: haze node color restores to __hazeBase after full decay', () => {
    const { ctx, ticks, colorSetCalls } = makeCtx();
    initTrace(ctx);

    const node = makeHazeNode('haze-099', 99);
    ctx.hazeNodeIdMap.set('haze-099', 99);

    // Very low activation — one tick at max dt (50ms → 0.03 decay) evicts the node
    ctx.activate(node, 0.001);

    let now = performance.now();
    ticks[0]!((now += 50));

    // A restore call must have set instance 99 back to __hazeBase
    const callsForIdx99 = colorSetCalls.filter(c => c.idx === 99);
    expect(callsForIdx99.length).toBeGreaterThan(0);

    const lastCall = callsForIdx99[callsForIdx99.length - 1]!;
    const baseColor = node.__hazeBase as FakeColor;
    expect(lastCall.color.equals(baseColor)).toBe(true);
  });

  it('non-haze node with __mat is unaffected (existing path preserved)', () => {
    const { ctx, ticks, colorSetCalls } = makeCtx();
    initTrace(ctx);

    // Use FakeColor (has copy/lerp) so trace.js's existing path can run it
    const matColor = new FakeColor(0x82698c);
    const baseR = matColor.r; const baseG = matColor.g; const baseB = matColor.b;

    const node: any = {
      id: 'schema-1',
      type: 'schema',
      __mat:    { color: matColor, opacity: 0.9 },
      __mesh:   { scale: { setScalar: vi.fn() } },
      __base:   new FakeColor(0x82698c),
      __baseOp: 0.9,
      __baseR:  1,
      __actGain: 1,
    };

    ctx.activate(node, 1.0);
    ticks[0]!(performance.now());

    // setColorAt must NOT be called for a non-haze node
    expect(colorSetCalls.length).toBe(0);
    // __mat.color SHOULD have changed (the existing lerp path ran)
    const isStillBase = matColor.r === baseR && matColor.g === baseG && matColor.b === baseB;
    expect(isStillBase).toBe(false);
  });
});
