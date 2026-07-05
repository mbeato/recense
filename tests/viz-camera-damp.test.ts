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
import { stepCameraDamp } from '../src/viz/modules/camera.js';

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
