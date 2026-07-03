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
import { ACT_SCALE_GAIN, REPLAY_DIM, DECAY_ATTACK_MS, HOT, KIND_COLOR } from '../src/viz/modules/constants.js';
// The mocked 'three' Color class (CR-02 assertions build expected colours with it).
// @ts-ignore — no type declarations for 'three' in this project (see initTrace import above)
import * as THREE from 'three';

// ── Source-text helpers ────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');

function readTraceJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/trace.js'), 'utf8');
}

function readConstantsJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/constants.js'), 'utf8');
}

function readServer(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/server.ts'), 'utf8');
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
    const lastScale = calls[calls.length - 1]![0] as number;
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

// =============================================================================
// Layer 2 — Replay echo (row.replay === true) (Task 2 TDD)
// RED: these tests fail because applyTrace has no replay branch yet
// GREEN: pass after adding the replay branch with REPLAY_DIM intensity
// =============================================================================

describe('Layer 2 — replay echo (row.replay === true) (SC3)', () => {

  it('replay row produces strictly dimmer activation than same live row (SC3)', () => {
    // Live row seeds node 'a' at score=0.9 → __actPeak = 0.9
    // Replay row seeds node 'b' at score=0.9 → __actPeak should be 0.9 * REPLAY_DIM = 0.45
    // In RED (no replay branch), both go through the recall path at full intensity:
    //   replayPeak === livePeak → expect(replayPeak).toBeLessThan(livePeak) FAILS
    const { node: nodeA } = makeRegularNode('a');
    const { node: nodeB } = makeRegularNode('b');
    const { ctx } = makeCtx([nodeA, nodeB]);

    // Live call
    ctx.applyTrace({ seeds: [{ node_id: 'a', score: 0.9 }], hops: [] });
    const livePeak = nodeA.__actPeak as number;

    // Replay call — same seed score, different node
    ctx.applyTrace({ seeds: [{ node_id: 'b', score: 0.9 }], hops: [], replay: true });
    const replayPeak = nodeB.__actPeak as number;

    expect(livePeak).toBeGreaterThan(0);
    expect(replayPeak).toBeGreaterThan(0);       // replay must still fire (not silently skip)
    expect(replayPeak).toBeLessThan(livePeak);   // SC3: replay strictly dimmer than live
  });

  it('replay peak matches live peak * REPLAY_DIM (exact multiplier)', () => {
    // After GREEN implementation: activate(node, intensity * REPLAY_DIM)
    // For score=0.9, live peak = 0.9, replay peak = 0.9 * REPLAY_DIM = 0.45
    const { node: nodeLive } = makeRegularNode('live');
    const { node: nodeReplay } = makeRegularNode('replay');
    const { ctx } = makeCtx([nodeLive, nodeReplay]);

    ctx.applyTrace({ seeds: [{ node_id: 'live',   score: 0.9 }], hops: [] });
    ctx.applyTrace({ seeds: [{ node_id: 'replay', score: 0.9 }], hops: [], replay: true });

    const livePeak   = nodeLive.__actPeak   as number;
    const replayPeak = nodeReplay.__actPeak as number;

    // replayPeak should be approximately livePeak * REPLAY_DIM
    expect(replayPeak).toBeCloseTo(livePeak * REPLAY_DIM, 5);
  });

  it('replay resolves hops via traceEdgesFromHops — no ctx.adj traversal (no fabricated edges)', () => {
    // A replay row with hops should light the hop node.
    // Neither path should touch ctx.adj (same honesty rule as live recall).
    const { node: seed } = makeRegularNode('s');
    const { node: hop  } = makeRegularNode('h');
    // extra node in adj but NOT in row.hops — must NOT be lit
    const { node: extra } = makeRegularNode('x');

    const { ctx } = makeCtx([seed, hop, extra]);
    ctx.adj.set('s', [
      { source: 's', target: 'h' },
      { source: 's', target: 'x' },  // only in adj, not in hops → must stay dark
    ]);

    ctx.applyTrace({
      seeds: [{ node_id: 's', score: 0.9 }],
      hops:  [{ node_id: 'h', score: 0.5, hop: 1 }],
      replay: true,
    });

    expect(seed.__actPeak).toBeGreaterThan(0);
    expect(hop.__actPeak).toBeGreaterThan(0);    // in row.hops → lit
    expect(extra.__actPeak).toBeUndefined();      // in adj only → not lit (honesty)
  });

  it('replay with no seeds is a no-op (Pitfall 3 guard)', () => {
    // An empty/malformed row should return without side effects.
    const { node } = makeRegularNode('n');
    const { ctx } = makeCtx([node]);

    expect(() => {
      ctx.applyTrace({ seeds: [], hops: [], replay: true });
    }).not.toThrow();

    expect(node.__actPeak).toBeUndefined(); // no activation
  });

  it('non-replay row (recall) is unchanged by replay branch (recall path byte-identical)', () => {
    // After adding the replay branch, a live recall must still behave exactly as before.
    const { node } = makeRegularNode('s');
    const { ctx } = makeCtx([node]);

    ctx.applyTrace({ seeds: [{ node_id: 's', score: 0.8 }], hops: [] });

    expect(node.__actPeak).toBeCloseTo(0.8, 5);
  });

  it('trace.js contains row.replay === true branch (source-text guard)', () => {
    // The branch must exist in non-comment source lines.
    // FAILS in RED. PASSES in GREEN.
    const src = stripComments(readTraceJs());
    expect(src).toContain('row.replay === true');
  });

  it('trace.js replay branch uses REPLAY_DIM constant (source-text guard)', () => {
    // REPLAY_DIM must appear in non-comment source lines.
    // FAILS in RED. PASSES in GREEN.
    const src = stripComments(readTraceJs());
    expect(src).toContain('REPLAY_DIM');
  });

});

// =============================================================================
// Layer 3 — Ambient twinkle tick (Task 3 auto)
// These tests are added with the implementation and verify the full structure.
// =============================================================================

describe('Layer 3 — ambient twinkle tick (SC1, SC3, SC5)', () => {

  it('initTrace registers a second tick (twinkleTick) via ctx.registerTick (SC1)', () => {
    // After initTrace, two ticks should be registered: main tick (ticks[0])
    // and twinkleTick (ticks[1]). Without twinkleTick, ticks.length === 1.
    const hazeNode = makeHazeNode('h0', 0);
    const { ticks } = makeCtx([], [hazeNode]);
    expect(ticks.length).toBe(2);
  });

  it('twinkleTick calls setColorAt for a haze node on first tick (SC1)', () => {
    // Lazy init happens on first tick: subset is built and setColorAt is called.
    const hazeNode = makeHazeNode('h0', 0);
    const { ticks, setColorAtSpy } = makeCtx([], [hazeNode]);

    // Invoke only the twinkle tick (ticks[1])
    ticks[1]!(performance.now());

    expect(setColorAtSpy).toHaveBeenCalled();
    const [idx] = setColorAtSpy.mock.calls[0] as [number, any];
    expect(idx).toBe(0); // hazeIdx of our test node
  });

  it('twinkleTick skips active nodes (live/replay flash has priority)', () => {
    // An activated haze node should be in the `active` Set inside initTrace.
    // twinkleTick must skip it so the live/replay color is not overwritten.
    const { node: regular } = makeRegularNode('r');
    const hazeNode = makeHazeNode('h0', 0);
    const { ctx, ticks, setColorAtSpy } = makeCtx([regular], [hazeNode]);

    ctx.activate(hazeNode, 1.0); // adds hazeNode to the active Set

    // Run only the twinkle tick (NOT the main tick, to isolate twinkle behavior)
    ticks[1]!(performance.now());

    // setColorAt must NOT be called by twinkle (active node skipped)
    expect(setColorAtSpy).not.toHaveBeenCalled();
  });

  it('twinkleTick does not call ctx.revealTrace (SC3 — no fabricated edges)', () => {
    const hazeNode = makeHazeNode('h0', 0);
    const { ctx, ticks } = makeCtx([], [hazeNode]);

    ticks[1]!(performance.now());

    expect(ctx.revealTrace).not.toHaveBeenCalled();
  });

  it('twinkleTick is a no-op when ctx.hazeMesh is null (lazy guard)', () => {
    // With no hazeNodes, makeCtx sets hazeMesh=null. twinkleTick should return early.
    const { node } = makeRegularNode('n');
    const { ticks, setColorAtSpy } = makeCtx([node]);

    // Should not throw, and setColorAt is never called (no hazeMesh)
    expect(() => ticks[1]!(performance.now())).not.toThrow();
    expect(setColorAtSpy).not.toHaveBeenCalled();
  });

  it('trace.js contains TWINKLE_COUNT, TWINKLE_PERIOD_MS, TWINKLE_AMP constants (source-text guard)', () => {
    const src = stripComments(readTraceJs());
    expect(src).toContain('TWINKLE_COUNT');
    expect(src).toContain('TWINKLE_PERIOD_MS');
    expect(src).toContain('TWINKLE_AMP');
  });

  it('trace.js still has no setMatrixAt after twinkle implementation (SC5 regression guard)', () => {
    const src = stripComments(readTraceJs());
    expect(src).not.toContain('setMatrixAt');
  });

});

// =============================================================================
// SC5/constants — constants.js source-text guards (Phase 54 Plan 04)
// Assert all 10 Phase-54 constants are exported; REPLAY_DIM < 1 numeric invariant.
// =============================================================================

describe('SC5/constants — Phase 54 constant exports and invariants', () => {
  const src = stripComments(readConstantsJs());

  it('exports ACT_SCALE_GAIN (Layer 1 — live amplification gain, SC2/SC5)', () => {
    expect(src).toMatch(/export const ACT_SCALE_GAIN\s*=/);
  });

  it('exports ACT_BRIGHTEN_GAIN (Layer 1 — opacity boost gain, SC2/SC5)', () => {
    expect(src).toMatch(/export const ACT_BRIGHTEN_GAIN\s*=/);
  });

  it('exports ACT_HAZE_LERP (Layer 1 — haze color lerp factor, SC2/SC5)', () => {
    expect(src).toMatch(/export const ACT_HAZE_LERP\s*=/);
  });

  it('exports REPLAY_IDLE_GAP_MS (Layer 2 — idle replay gap, SC1/SC3)', () => {
    expect(src).toMatch(/export const REPLAY_IDLE_GAP_MS\s*=/);
  });

  it('exports REPLAY_CADENCE_MS (Layer 2 — replay cadence, SC1/SC3)', () => {
    expect(src).toMatch(/export const REPLAY_CADENCE_MS\s*=/);
  });

  it('exports REPLAY_DIM (Layer 2 — replay intensity multiplier, SC3)', () => {
    expect(src).toMatch(/export const REPLAY_DIM\s*=/);
  });

  it('exports REPLAY_HISTORY_N (Layer 2 — replay ring buffer size, SC1/SC3)', () => {
    expect(src).toMatch(/export const REPLAY_HISTORY_N\s*=/);
  });

  it('exports TWINKLE_COUNT (Layer 3 — twinkle subset size, SC1/SC5)', () => {
    expect(src).toMatch(/export const TWINKLE_COUNT\s*=/);
  });

  it('exports TWINKLE_PERIOD_MS (Layer 3 — twinkle breathe period, SC1/SC5)', () => {
    expect(src).toMatch(/export const TWINKLE_PERIOD_MS\s*=/);
  });

  it('exports TWINKLE_AMP (Layer 3 — twinkle breathe amplitude, SC1/SC5)', () => {
    expect(src).toMatch(/export const TWINKLE_AMP\s*=/);
  });

  // SC3: REPLAY_DIM < 1 source-parse lock moved to
  // tests/viz-activity-palette-invariants.test.ts ("D-06 motion-profile SC3
  // ordering + D-05 dim floors") — D-12 consolidation, Phase 57 Plan 04.

});

// =============================================================================
// SC2/SC3/SC1 — additional compound source-text guards (Layer 1-3, Plan 04)
// The existing Layer 1-3 tests check constant NAMES. These guards check the
// USAGE expressions (a * GAIN) that confirm the constants drive the computation,
// not just that the names appear (e.g. in import lines).
// =============================================================================

describe('SC2/SC3/SC1 — additional compound source-text guards (Layer 1-3)', () => {
  const traceSrc = stripComments(readTraceJs());

  // ── Layer 1: compound gain expression guards ────────────────────────────────

  it('SC2: trace.js scale formula contains "1 + a * ACT_SCALE_GAIN" (compound expression)', () => {
    // Confirms the constant drives the scale computation, not just that it is imported.
    expect(traceSrc).toContain('1 + a * ACT_SCALE_GAIN');
  });

  it('SC2: trace.js opacity formula contains "a * ACT_BRIGHTEN_GAIN" (compound expression)', () => {
    // More specific than checking the name alone: confirms the usage in the expression context.
    expect(traceSrc).toContain('a * ACT_BRIGHTEN_GAIN');
  });

  it('SC2: trace.js haze lerp formula contains "a * ACT_HAZE_LERP" (compound expression)', () => {
    expect(traceSrc).toContain('a * ACT_HAZE_LERP');
  });

  // ── Layer 2: replay-branch traceEdgesFromHops and REPLAY_DIM usage guards ──

  it('SC3: replay branch references traceEdgesFromHops (honest hops — no ctx.adj fabrication)', () => {
    // Confirm traceEdgesFromHops is called INSIDE the row.replay === true block.
    const replayStart = traceSrc.indexOf('row.replay === true');
    expect(replayStart).toBeGreaterThanOrEqual(0);
    // Extract 2000 chars from the replay branch to cover the full block
    const replayBlock = traceSrc.slice(replayStart, replayStart + 2000);
    expect(replayBlock).toContain('traceEdgesFromHops');
  });

  it('SC3: replay branch multiplies activate by REPLAY_DIM ("* REPLAY_DIM" compound guard)', () => {
    // The activate call inside the replay path must multiply by REPLAY_DIM.
    // "* REPLAY_DIM" catches both "intensity * REPLAY_DIM" and similar patterns.
    expect(traceSrc).toContain('* REPLAY_DIM');
  });

  // ── Layer 3: twinkleTick registration and isolation guards ──────────────────

  it('SC1: trace.js registers twinkleTick via ctx.registerTick (source-text guard)', () => {
    // The exact registration call must appear in non-comment lines.
    expect(traceSrc).toContain('ctx.registerTick(twinkleTick)');
  });

  it('SC1/SC3: twinkleTick body contains no spawnPulse call (isolation from pulse machinery)', () => {
    // Extract from the twinkleTick function definition to the registration line so we
    // cover the full function body. spawnPulse inside twinkle would mix the decorative
    // ambient layer with the event-triggered pulse machinery — a SC1/SC3 violation.
    const fnMarker  = 'function twinkleTick(';
    const regMarker = 'ctx.registerTick(twinkleTick)';
    const fnStart   = traceSrc.indexOf(fnMarker);
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const regEnd = traceSrc.indexOf(regMarker, fnStart);
    expect(regEnd).toBeGreaterThanOrEqual(0);
    const twinkleBody = traceSrc.slice(fnStart, regEnd + regMarker.length);
    expect(twinkleBody).not.toContain('spawnPulse(');
  });

});

// =============================================================================
// SC1+SC5/server — server.ts source-text guards (Phase 54 Plan 04)
// Read server.ts as text, strip comment lines, assert structural invariants:
//   - replay: true present (replay payload marker)
//   - replayBuffer declared (ring buffer exists)
//   - exactly one new Database( occurrence (single read-only handle)
//   - no fetch( / embed( / provider token (no outbound calls / LLM)
//   - zero cursor = / cursor= assignments inside the replay-scheduler block
//     (replay is a side-channel re-emit; the /events cursor is forward-only)
// =============================================================================

describe('SC1+SC5/server — server.ts structural invariants', () => {
  const serverSrc = readServer(); // raw (need both stripped and raw for counting)
  const stripped  = stripComments(serverSrc);

  it('SC1: server.ts replay payload includes replay: true marker (SC1 signal to client)', () => {
    expect(stripped).toContain('replay: true');
  });

  it('SC1/SC5: server.ts declares replayBuffer (ring buffer for idle replay)', () => {
    expect(stripped).toContain('replayBuffer');
  });

  it('SC5: server.ts contains exactly one new Database( occurrence (single read-only handle)', () => {
    // Multiple Database handles would break the D-95 / T-10-08 read-only boundary.
    // Comments mentioning new Database() are stripped; only code-level occurrences count.
    const count = (stripped.match(/new Database\(/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('SC5: server.ts contains no fetch( call in non-comment lines (no outbound network)', () => {
    // The viz server is read-only and local; fetch() to external URLs is forbidden.
    expect(stripped).not.toContain('fetch(');
  });

  it('SC5: server.ts contains no embed( call in non-comment lines (no LLM embed calls)', () => {
    expect(stripped).not.toContain('embed(');
  });

  it('SC5: server.ts contains no "provider" token in non-comment lines (no LLM provider)', () => {
    expect(stripped).not.toContain('provider');
  });

  it('SC1/SC5: replay-scheduler block contains no cursor = assignment (forward-only cursor guard)', () => {
    // The /events cursor is a forward-only AUTOINCREMENT pointer seeded at the current
    // max id. Rewinding it inside the replay scheduler would re-broadcast historical
    // rows as "new" live events — a SC1/SC5 violation.
    //
    // Implementation: locate the replay-scheduler block by its opening marker, extract
    // to the unique closing marker (}, REPLAY_CADENCE_MS)), and assert NO cursor assignment
    // inside it. The whole-file count gate is intentionally NOT used: server.ts has two
    // legitimate cursor assignments at rest — the `let cursor = ...` declaration and the
    // `cursor = fresh[...]` forward poll update — both outside the replay block.
    const startMarker = 'replayInterval = setInterval(';
    const endMarker   = '}, REPLAY_CADENCE_MS)';
    const start = stripped.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0); // replay block must exist
    const end = stripped.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThanOrEqual(0);   // block must close
    const replayBlock = stripped.slice(start, end + endMarker.length);
    // Assert no `cursor =` or `cursor=` (assignment, not comparison) inside the block.
    expect(replayBlock).not.toMatch(/cursor\s*=[^=]/);
  });

});

// =============================================================================
// WR-06 / D-11 — own-trace-scoped fades (Phase 57 Plan 06)
// 56-REVIEW.md WR-06: spontaneous fires every SPONT_CADENCE_MS during idle; a
// live recall is exactly the event that ends idle; a live trace arriving inside
// a pending spontaneous (or replay) fade window previously had its just-added
// traceNodes wiped by that timeout's global `.clear()`. All three fade branches
// must delete ONLY the ids each trace added.
// =============================================================================

describe('WR-06 / D-11 — own-trace-scoped fades', () => {

  it('trace.js contains zero global ctx.traceNodes.clear() calls (source-guard)', () => {
    const src = stripComments(readTraceJs());
    expect(src).not.toContain('ctx.traceNodes.clear()');
  });

  it('trace.js contains zero global ctx.traceLinks.clear() calls in fade timeouts (source-guard)', () => {
    const src = stripComments(readTraceJs());
    expect(src).not.toContain('ctx.traceLinks.clear()');
  });

  it('trace.js has >=3 own-trace-scoped ctx.traceNodes.delete( call sites (one per fade branch)', () => {
    const src = stripComments(readTraceJs());
    const count = (src.match(/ctx\.traceNodes\.delete\(/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('a live trace survives a concurrent spontaneous trace fade timeout (WR-06 regression guard)', () => {
    // Capture scheduled fade callbacks instead of using the file-level no-op
    // setTimeout, so the exact WR-06 race can be simulated: a spontaneous fade
    // timeout firing AFTER a live trace has added its own node id to the same
    // shared ctx.traceNodes set.
    const scheduled: Array<() => void> = [];
    const realSetTimeout = (globalThis as any).setTimeout;
    (globalThis as any).setTimeout = (fn: any, _ms: number) => { scheduled.push(fn); return 0; };

    const { node: spontSeed } = makeRegularNode('spont-seed');
    const { node: liveSeed }  = makeRegularNode('live-seed');
    const { ctx } = makeCtx([spontSeed, liveSeed]);

    try {
      // 1. Spontaneous trace fires first, schedules its own (scoped) fade timeout.
      ctx.applyTrace({ seeds: [{ node_id: 'spont-seed', score: null }], hops: [], kind: 'spontaneous' });
      expect(ctx.traceNodes.has('spont-seed')).toBe(true);

      // 2. Before the spontaneous fade fires, a live recall arrives — a DIFFERENT
      //    trace of a different kind — adding its own id to the same shared set.
      ctx.applyTrace({ seeds: [{ node_id: 'live-seed', score: 0.9 }], hops: [] });
      expect(ctx.traceNodes.has('live-seed')).toBe(true);

      // 3. The spontaneous trace's fade timeout fires. Own-trace-scoped (D-11):
      //    it must delete ONLY 'spont-seed', never clobber 'live-seed'.
      expect(scheduled.length).toBeGreaterThanOrEqual(2); // spontaneous + live both scheduled a fade
      scheduled[0]!();

      expect(ctx.traceNodes.has('spont-seed')).toBe(false); // spontaneous's own id faded
      expect(ctx.traceNodes.has('live-seed')).toBe(true);   // WR-06: live survives the collision
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
    }
  });

});

// =============================================================================
// CR-01 / CR-02 gap closure (Phase 57-08) — WR-03-class code-path-selection
// regression guards. 57-VERIFICATION.md found two blocker gaps introduced by
// the 57-06 WR-06 fix: an ingestion-kind trace's traceNodes ids leaked forever
// (CR-01), and a replayed non-recall row's undefined seedColor/hopColor fell
// through activate()'s kindColor || HOT_COLOR fallback to live-amber (CR-02).
// These lock the PATH the code takes, not just a constant's value.
// =============================================================================

describe('CR-01/CR-02 gap closure — Phase 57-08', () => {

  it('CR-02: a replayed ingestion-kind row activates its seed at KIND_COLOR.neutral, never HOT amber', () => {
    const { node } = makeRegularNode('seed-1');
    const { ctx } = makeCtx([node]);

    ctx.applyTrace({
      seeds: [{ node_id: 'seed-1', score: 0.9 }],
      hops: [],
      replay: true,
      kind: 'oscillation', // non-recall ingestion kind, replayed
    });

    expect(node.__actColor).toBeDefined();
    const neutral = new THREE.Color(KIND_COLOR.neutral);
    const hot = new THREE.Color(HOT);

    // Matches the neutral slate hue exactly (D-04-compliant)...
    expect(node.__actColor.r).toBeCloseTo(neutral.r);
    expect(node.__actColor.g).toBeCloseTo(neutral.g);
    expect(node.__actColor.b).toBeCloseTo(neutral.b);

    // ...and does NOT match HOT amber (at least one channel differs) — the
    // defect this test locks: reverting the CR-02 fix (seedColor back to
    // undefined) would resolve __actColor to HOT via activate()'s
    // `kindColor || HOT_COLOR` fallback, making this assertion fail.
    const matchesHot = node.__actColor.r === hot.r
      && node.__actColor.g === hot.g
      && node.__actColor.b === hot.b;
    expect(matchesHot).toBe(false);
  });

  it('CR-01: an ingestion-kind trace bounds ctx.traceNodes — its own scoped fade empties the set', () => {
    // Capture the scheduled fade callback instead of using the file-level
    // no-op setTimeout, so the fade can actually be fired and asserted
    // (mirrors the WR-06 test's setTimeout-capture pattern above).
    const scheduled: Array<() => void> = [];
    const realSetTimeout = (globalThis as any).setTimeout;
    (globalThis as any).setTimeout = (fn: any, _ms: number) => { scheduled.push(fn); return 0; };

    const { node } = makeRegularNode('new-node-1');
    const { ctx } = makeCtx([node]);

    try {
      ctx.applyTrace({ seeds: [{ node_id: 'new-node-1', score: 0.6 }], hops: [], kind: 'new_node' });

      expect(ctx.traceNodes.has('new-node-1')).toBe(true);
      expect(ctx.traceNodes.size).toBe(1);

      // new_node schedules exactly one setTimeout — its own scoped fade.
      expect(scheduled.length).toBe(1);
      scheduled[0]!();

      // The leak this test locks: without CR-01's scoped fade, traceNodes
      // would never shrink back to 0 — a monotonic overview-LOD defeat.
      expect(ctx.traceNodes.has('new-node-1')).toBe(false);
      expect(ctx.traceNodes.size).toBe(0);
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
    }
  });

});
