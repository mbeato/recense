/**
 * tests/viz-idle-drift-camera-flight.test.ts
 *
 * Regression test for the live founder bug (2026-07-06, Phase 59 Plan 06
 * D-15 checkpoint): "after focusing and unfocusing a node the brain rotation
 * gets stuck ... need to drag it and let go to get it spinning on idle
 * again."
 *
 * Root cause: stats.js's idle camera drift (updateIdleDrift) only gated on
 * ctx.isIdle() — it never checked ctx.isCameraInFlight() (camera.js, Phase 59
 * Plan 05). A still-in-flight programmatic move (detail.js focus /
 * closeDetail's recenter — CAM_POS_LAMBDA damping takes ~2s to settle within
 * CAM_SETTLE_EPS) routinely outlasts stats.js's 1200ms idle timeout, so the
 * drift started rotating cam.position directly while camera.js's own damp
 * tick was STILL writing cam.position back toward the fixed flight target
 * every frame. The two writers fought every frame — camera.js pulling toward
 * target, drift immediately nudging away again — so the flight's settled()
 * check (camera.js) never converged, `active` wedged true forever, and the
 * net camera motion read as frozen. A manual drag "fixed" it only as a side
 * effect: OrbitControls' 'start' event force-clears camera.js's `active`
 * flag unconditionally.
 *
 * Fix: updateIdleDrift also gates on ctx.isCameraInFlight() — drift stays
 * fully suppressed for the whole flight and resumes on its own the moment
 * the flight clears, with no manual drag required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 'three' is not an npm dependency (browser import-map only — same convention
// as tests/viz-camera-damp.test.ts); MathUtils.damp reproduced verbatim from
// the vendored formula for the real camera.js settle-path section below.
vi.mock('three', () => ({
  MathUtils: {
    damp: (x: number, y: number, lambda: number, dt: number) =>
      x + (y - x) * (1 - Math.exp(-lambda * dt)),
  },
}));
// @ts-ignore — browser ESM, no type declarations; mocked above for this test
import * as THREE from 'three';
// @ts-ignore — browser ESM, no type declarations
import { initCamera } from '../src/viz/modules/camera.js';

function makeEl() {
  return {
    id: '',
    style: { cssText: '', display: '' },
    textContent: '',
    appendChild(_: any) {},
    addEventListener(_: string, _cb: any) {},
  };
}

// stats.js reads window.innerWidth/innerHeight at module-eval time and touches
// document.createElement/body/addEventListener during initStats — same
// vi.hoisted DOM-stub convention as tests/viz-detail-focus-camera.test.ts.
vi.hoisted(() => {
  (globalThis as any).document = {
    createElement: (_tag: string) => makeEl(),
    addEventListener(_: string, _cb: any) {},
    body: { appendChild(_: any) {} },
  };
  (globalThis as any).window = { innerWidth: 1024, innerHeight: 768 };
  if (typeof (globalThis as any).performance === 'undefined') {
    (globalThis as any).performance = { now: () => Date.now() };
  }
  // Never actually fire — the tests drive frames manually via the captured
  // rAF callback, so a real recursive scheduling loop is neither needed nor
  // wanted here.
  (globalThis as any).setTimeout = (_cb: any, _delay?: number) => 0;
});

let rafCallback: ((now: number) => void) | null = null;
(globalThis as any).requestAnimationFrame = (cb: (now: number) => void) => {
  rafCallback = cb;
  return 0;
};

// @ts-ignore — browser ESM, no type declarations
import { initStats } from '../src/viz/modules/stats.js';

function makeCtx(inFlight: boolean) {
  const camPos = { x: 100, y: 0, z: 0 };
  const lookAtSpy = vi.fn();
  const cam = { position: camPos, lookAt: lookAtSpy };
  const controls = { target: { x: 0, y: 0, z: 0 } };
  const ctx: any = {
    Graph: { camera: () => cam, controls: () => controls },
    isCameraInFlight: vi.fn(() => inFlight),
  };
  return { ctx, cam, lookAtSpy };
}

describe('stats.js idle camera drift respects camera-in-flight (founder 260706 regression)', () => {
  beforeEach(() => { rafCallback = null; });

  it('does NOT rotate the camera while a programmatic flight is still in progress', () => {
    const { ctx, cam, lookAtSpy } = makeCtx(true);
    initStats(ctx);
    expect(rafCallback).toBeTruthy();

    const before = { x: cam.position.x, z: cam.position.z };
    // Ctx starts already idle by stats.js's own default (lastActiveTime seeded
    // in the past) — isolates the flight gate from the idle-timeout gate.
    rafCallback!(1000);
    rafCallback!(1016);
    rafCallback!(1033);

    expect(cam.position.x).toBe(before.x);
    expect(cam.position.z).toBe(before.z);
    expect(lookAtSpy).not.toHaveBeenCalled();
  });

  it('resumes rotating on its own once the flight clears — no drag required', () => {
    const { ctx, cam, lookAtSpy } = makeCtx(true);
    initStats(ctx);

    rafCallback!(1000); // still in flight — confirmed no motion
    expect(cam.position.z).toBe(0);

    (ctx.isCameraInFlight as any).mockReturnValue(false); // flight settled

    rafCallback!(1016); // first post-flight frame only arms lastDriftNow
    const armed = { x: cam.position.x, z: cam.position.z };
    rafCallback!(1033); // next frame actually rotates

    expect(cam.position.x === armed.x && cam.position.z === armed.z).toBe(false);
    expect(lookAtSpy).toHaveBeenCalled();
  });
});

// =============================================================================
// Root-cause regression: camera.js's OWN settle logic never clears `active`
// (260706 founder regression — fd8f224 above only gated stats.js on
// isCameraInFlight(), which never fixed why that flag stayed stuck true).
//
// The prior tests above mock ctx.isCameraInFlight() directly — that mocks
// away the exact thing that was actually broken. This section drives
// camera.js's REAL initCamera()/registerTick settle logic through a
// vendor-faithful mock of 3d-force-graph's cameraPosition()/controls():
//   - WRITE (pos, lookAt, 0): sets raw camera position directly; REPLACES
//     `controls.target` with a fresh object (verbatim vendor `c()` helper,
//     src/viz/vendor/3d-force-graph.min.js).
//   - READ (no args): returns raw position plus a SYNTHETIC `lookAt` computed
//     as `position + 1000 * normalize(target - position)` — verbatim vendor
//     `h()` helper. This is a fixed-length-1000 point along the camera's
//     facing ray, NOT literally `controls.target`.
//
// Root cause: camera.js used to feed this synthetic h() value into its
// settle check (and into stepCameraDamp) as "the current lookAt". For a node
// focus flight (~321 units from the node — see detail.js's dollyPos offset),
// h() permanently overshoots the real target by ~679 units along the same
// ray — settled() against the real target can never converge, so `active`
// (ctx.isCameraInFlight()) never clears on its own. Fix: camera.js reads
// `controls.target` directly (the same live property the write path sets)
// instead of the synthetic h() value.
// =============================================================================
type Vec3 = { x: number; y: number; z: number };

/**
 * Vendor-faithful cameraPosition()/controls() mock — reproduces the
 * WRITE/READ asymmetry that is the actual root cause (see block comment
 * above), not a simplified stand-in for it.
 */
function makeVendorLikeCtx(initialPos: Vec3, initialTarget: Vec3) {
  let position: Vec3 = { ...initialPos };
  let target: Vec3 = { ...initialTarget };

  function h(): Vec3 {
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const dz = target.z - position.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    return {
      x: position.x + 1000 * (dx / dist),
      y: position.y + 1000 * (dy / dist),
      z: position.z + 1000 * (dz / dist),
    };
  }

  const controls: any = {
    target,
    addEventListener: (_evt: string, _handler: () => void) => {},
  };

  const cameraPositionSpy = vi.fn((pos?: Partial<Vec3>, lookAt?: Vec3) => {
    if (pos === undefined) {
      return { x: position.x, y: position.y, z: position.z, lookAt: h() };
    }
    if (pos.x !== undefined) position.x = pos.x;
    if (pos.y !== undefined) position.y = pos.y;
    if (pos.z !== undefined) position.z = pos.z;
    if (lookAt) {
      target = { x: lookAt.x, y: lookAt.y, z: lookAt.z }; // vendor `c()`: REPLACES the target object
      controls.target = target; // mirror the vendor's `e.controls.target = n` reassignment
    }
    return undefined;
  });

  const ticks: Array<(now: number) => void> = [];
  const ctx: any = {
    THREE,
    Graph: { cameraPosition: cameraPositionSpy, controls: () => controls },
    registerTick: (fn: (now: number) => void) => ticks.push(fn),
    markActive: vi.fn(),
  };

  return { ctx, ticks, getPosition: () => position };
}

describe("camera.js's real settle logic (not mocked) — 260706 root-cause regression", () => {
  it('a node-focus-distance flight (~321 units) settles on its own — isCameraInFlight() clears without a manual drag', () => {
    const { ctx, ticks, getPosition } = makeVendorLikeCtx(
      { x: 0, y: 0, z: 1012 }, // overview camera pose
      { x: 0, y: 0, z: 0 },
    );
    initCamera(ctx);
    expect(ctx.isCameraInFlight()).toBe(false); // seeded settled, no flight yet

    // Node focus (detail.js's focusCamera): dolly to node+{220,80,220}, look at the node.
    const node = { x: 0, y: 0, z: 0 };
    ctx.setCameraTarget(
      { x: node.x + 220, y: node.y + 80, z: node.z + 220 },
      { x: node.x, y: node.y, z: node.z },
    );
    expect(ctx.isCameraInFlight()).toBe(true);

    let now = 1000;
    for (let i = 0; i < 320; i++) { now += 16; ticks[0]!(now); } // ~5.1s — well past the ~2s settle budget

    expect(ctx.isCameraInFlight()).toBe(false); // must clear on its own, no manual drag required

    // Unfocus (graph.js's recenter(), routed through closeDetail): fly back to the overview framing.
    ctx.setCameraTarget({ x: 0, y: 0, z: 1012 }, { x: 0, y: 0, z: 0 });
    expect(ctx.isCameraInFlight()).toBe(true);

    for (let i = 0; i < 320; i++) { now += 16; ticks[0]!(now); }

    expect(ctx.isCameraInFlight()).toBe(false); // unfocus flight also settles on its own
    expect(getPosition().z).toBeCloseTo(1012, 0);
  });
});
