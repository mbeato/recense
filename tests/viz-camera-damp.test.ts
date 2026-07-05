/**
 * tests/viz-camera-damp.test.ts
 *
 * Phase 58 Plan 06 — unit test for camera.js's pure `stepCameraDamp` helper:
 * the damp-step math driving the one damped, interruptible camera system
 * (D-05). Verifies (1) monotonic convergence toward a fixed target, and
 * (2) interruptibility — a mid-flight retarget redirects smoothly toward
 * the NEW target with no discontinuity (jump/teleport), never queuing the
 * old target.
 *
 * 'three' is not an npm dependency in this repo (browser import-map only —
 * see tests/viz-haze-selection.test.ts for the same mocking convention), so
 * MathUtils.damp is reproduced here verbatim from the vendored formula
 * (src/viz/vendor/three.core.js:372, confirmed in 58-RESEARCH.md): a plain
 * frame-rate-independent exponential lerp — not a fake/simplified stand-in.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => ({
  MathUtils: {
    // THREE.MathUtils.damp(x, y, lambda, dt) — verbatim vendored formula.
    damp: (x: number, y: number, lambda: number, dt: number) =>
      x + (y - x) * (1 - Math.exp(-lambda * dt)),
  },
}));

// @ts-ignore — browser ESM, no type declarations; mocked above for this test
import * as THREE from 'three';
// @ts-ignore — browser ESM, no type declarations
import { stepCameraDamp, initCamera } from '../src/viz/modules/camera.js';

type Vec3 = { x: number; y: number; z: number };

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('stepCameraDamp', () => {
  it('converges current position AND lookAt monotonically toward a fixed target', () => {
    let cur: Vec3 = { x: 0, y: 0, z: 0 };
    let curLookAt: Vec3 = { x: 0, y: 0, z: 0 };
    const targetPos: Vec3 = { x: 100, y: 50, z: -30 };
    const targetLookAt: Vec3 = { x: 10, y: 0, z: 0 };

    let prevPosDist = Infinity;
    let prevLookAtDist = Infinity;

    for (let i = 0; i < 120; i++) {
      const { pos, lookAt } = stepCameraDamp({
        THREE, cur, targetPos, curLookAt, targetLookAt, dt: 1 / 60,
      });
      const posDist = dist(pos, targetPos);
      const lookAtDist = dist(lookAt, targetLookAt);
      // Monotonic (allow tiny fp slack): each step must not move AWAY from target.
      expect(posDist).toBeLessThanOrEqual(prevPosDist + 1e-9);
      expect(lookAtDist).toBeLessThanOrEqual(prevLookAtDist + 1e-9);
      prevPosDist = posDist;
      prevLookAtDist = lookAtDist;
      cur = pos;
      curLookAt = lookAt;
    }

    // Converged (not just decreasing forever) within a reasonable frame budget.
    expect(dist(cur, targetPos)).toBeLessThan(1);
    expect(dist(curLookAt, targetLookAt)).toBeLessThan(1);
  });

  it('lookAt (CAM_LOOKAT_LAMBDA) settles faster than position (CAM_POS_LAMBDA) — Pitfall 4 gaze-first feel', () => {
    let curPos: Vec3 = { x: 0, y: 0, z: 0 };
    let curLookAt: Vec3 = { x: 0, y: 0, z: 0 };
    const targetPos: Vec3 = { x: 100, y: 0, z: 0 };
    const targetLookAt: Vec3 = { x: 100, y: 0, z: 0 };

    // After a fixed, small number of ticks, lookAt must have covered strictly
    // more of the distance to its target than position has — the higher
    // CAM_LOOKAT_LAMBDA converges faster (RESEARCH Pitfall 4).
    for (let i = 0; i < 10; i++) {
      const { pos, lookAt } = stepCameraDamp({
        THREE, cur: curPos, targetPos, curLookAt, targetLookAt, dt: 1 / 60,
      });
      curPos = pos;
      curLookAt = lookAt;
    }
    expect(dist(curLookAt, targetLookAt)).toBeLessThan(dist(curPos, targetPos));
  });

  it('redirects smoothly toward a NEW target mid-flight without a discontinuity (interruptibility)', () => {
    let cur: Vec3 = { x: 0, y: 0, z: 0 };
    let curLookAt: Vec3 = { x: 0, y: 0, z: 0 };
    let targetPos: Vec3 = { x: 100, y: 0, z: 0 };
    const targetLookAt: Vec3 = { x: 0, y: 0, z: 0 };

    // Fly most of the way toward the first target.
    for (let i = 0; i < 30; i++) {
      const { pos, lookAt } = stepCameraDamp({
        THREE, cur, targetPos, curLookAt, targetLookAt, dt: 1 / 60,
      });
      cur = pos;
      curLookAt = lookAt;
    }
    const preRetarget = { ...cur };

    // Mid-flight retarget (e.g. clicking node B while still flying to A):
    // the very next step must move a SMALL, continuous amount from wherever
    // the camera currently sits toward the NEW target — never teleport, and
    // never keep chasing the old (now-abandoned) target.
    targetPos = { x: -50, y: 0, z: 0 };
    const { pos: next } = stepCameraDamp({
      THREE, cur, targetPos, curLookAt, targetLookAt, dt: 1 / 60,
    });

    const stepSize = dist(next, preRetarget);
    const remainingToNewTarget = dist(preRetarget, targetPos);

    // No discontinuity: one frame moves a damped FRACTION of the remaining
    // distance to the new target, never the whole distance in one jump.
    expect(stepSize).toBeGreaterThan(0);
    expect(stepSize).toBeLessThan(remainingToNewTarget);
    // Heading toward the NEW target (leftward, x decreasing), not the old one.
    expect(next.x).toBeLessThan(preRetarget.x);
  });
});

// =============================================================================
// 58-08 Stage-2 rejection regression — user-interrupt releases the damp target
// "feels bad like the camera is locked in one place — whenever i grab and drag
// it moves but snaps back to original location, same with zoom" — the tick was
// steering the camera back toward a stale programmatic target underneath the
// user's own manual orbit/zoom. Fix: OrbitControls' 'start' event (fired for
// both pointer-drag orbit and wheel/pinch zoom) releases the damp target
// immediately; only a fresh ctx.setCameraTarget call re-arms it.
// =============================================================================

type CamState = { x: number; y: number; z: number; lookAt: { x: number; y: number; z: number } };

/**
 * Minimal ctx + mock Graph/controls for initCamera. cameraPositionSpy mimics
 * the real accessor: no-arg call reads the current state; a (pos, lookAt, 0)
 * call is the synchronous write branch this system always uses.
 */
function makeCameraCtx(initial: CamState) {
  let camState: CamState = { ...initial, lookAt: { ...initial.lookAt } };
  const cameraPositionSpy = vi.fn((pos?: any, lookAt?: any) => {
    if (pos === undefined) {
      return { x: camState.x, y: camState.y, z: camState.z, lookAt: { ...camState.lookAt } };
    }
    camState = { x: pos.x, y: pos.y, z: pos.z, lookAt: { ...lookAt } };
    return undefined;
  });

  let startHandler: (() => void) | null = null;
  const controls = {
    addEventListener: (evt: string, handler: () => void) => {
      if (evt === 'start') startHandler = handler;
    },
  };

  const ticks: Array<(now: number) => void> = [];
  const ctx: any = {
    THREE,
    Graph: {
      cameraPosition: cameraPositionSpy,
      controls: () => controls,
    },
    registerTick: (fn: (now: number) => void) => ticks.push(fn),
    markActive: vi.fn(),
  };

  return {
    ctx,
    ticks,
    getCamState: () => camState,
    setCamState: (s: CamState) => { camState = s; },
    fireUserInterrupt: () => { if (startHandler) (startHandler as () => void)(); },
  };
}

describe('initCamera — user-interrupt releases the damp target (58-08 regression)', () => {
  it('a fresh setCameraTarget drives the camera toward the target (sanity, before interrupt)', () => {
    const { ctx, ticks, getCamState } = makeCameraCtx({ x: 0, y: 0, z: 0, lookAt: { x: 0, y: 0, z: 0 } });
    initCamera(ctx);

    ctx.setCameraTarget({ x: 100, y: 0, z: 0 }, { x: 50, y: 0, z: 0 });
    ticks[0]!(1000);

    expect(getCamState().x).toBeGreaterThan(0);
  });

  it('manual orbit/zoom (OrbitControls "start") releases the target — no snap-back on later ticks', () => {
    const { ctx, ticks, getCamState, setCamState, fireUserInterrupt } =
      makeCameraCtx({ x: 0, y: 0, z: 0, lookAt: { x: 0, y: 0, z: 0 } });
    initCamera(ctx);

    // Programmatic move in flight (e.g. node focus).
    ctx.setCameraTarget({ x: 100, y: 0, z: 0 }, { x: 50, y: 0, z: 0 });
    ticks[0]!(1000);
    expect(getCamState().x).toBeGreaterThan(0);

    // User grabs and drags (or zooms) — OrbitControls fires 'start'.
    fireUserInterrupt();

    // Simulate what OrbitControls itself does to the camera during the drag/
    // zoom (outside this system's write path) — the user leaves it here.
    const userLeftIt: CamState = { x: 999, y: 5, z: -20, lookAt: { x: 10, y: 0, z: 0 } };
    setCamState(userLeftIt);

    // Subsequent ticks (including well after, simulating "let go") must NOT
    // steer the camera back toward the old target — this is the exact defect
    // reported: "snaps back to original location".
    ticks[0]!(1050);
    ticks[0]!(1100);
    ticks[0]!(3000);

    expect(getCamState()).toEqual(userLeftIt);
  });

  it('a new programmatic move after an interrupt re-arms the damp loop from the user-repositioned pose', () => {
    const { ctx, ticks, getCamState, setCamState, fireUserInterrupt } =
      makeCameraCtx({ x: 0, y: 0, z: 0, lookAt: { x: 0, y: 0, z: 0 } });
    initCamera(ctx);

    ctx.setCameraTarget({ x: 100, y: 0, z: 0 }, { x: 50, y: 0, z: 0 });
    ticks[0]!(1000);

    fireUserInterrupt();
    setCamState({ x: 999, y: 5, z: -20, lookAt: { x: 10, y: 0, z: 0 } });
    ticks[0]!(1050); // interrupted — no movement

    // Programmatic re-engagement (e.g. recenter, or a new node focus).
    ctx.setCameraTarget({ x: -50, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    ticks[0]!(1100);

    // Must move from the user's current (999,...) pose toward the NEW target,
    // never resume toward the old (100,0,0) target.
    expect(getCamState().x).toBeLessThan(999);
  });
});
