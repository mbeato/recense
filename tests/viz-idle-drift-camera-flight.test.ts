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
