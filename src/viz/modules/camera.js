/**
 * @module camera
 * recense viz — one damped, interruptible camera-target system (Phase 58
 * Plan 06, D-05).
 *
 * initCamera(ctx) implements:
 *   - ctx.setCameraTarget(pos, lookAt) — retarget the damped camera. Every
 *     other camera-driving module (detail.js focus, graph.js recenter,
 *     transition.js pull-back/dive) calls this instead of
 *     Graph.cameraPosition(pos, lookAt, ms>0) directly. Interruptible by
 *     construction: calling it again mid-flight just changes what the tick
 *     chases next frame — never queues, never jumps. Calls ctx.markActive()
 *     so stats.js's idle camera drift never fights an in-flight retarget
 *     (transition.js lesson 2). Also re-arms the damp loop (see interrupt
 *     below) so a fresh programmatic move always takes over from wherever
 *     the camera currently sits.
 *   - A ctx.registerTick callback that reads the current camera via the
 *     verified no-arg `Graph.cameraPosition()` accessor (RESEARCH Pattern 1),
 *     damps pos.{x,y,z} toward the target with CAM_POS_LAMBDA and
 *     lookAt.{x,y,z} with CAM_LOOKAT_LAMBDA (deliberately higher — the gaze
 *     settles before the body catches up, reproducing the old tween
 *     accessor's lookAt/ms-3 feel, RESEARCH Pitfall 4), and writes back via
 *     `Graph.cameraPosition(dampedPos, dampedLookAt, 0)` — the verified
 *     SYNCHRONOUS branch, so this system never re-enters 3d-force-graph's own
 *     internal TWEEN group (RESEARCH Anti-Pattern: two animators writing
 *     camera.position in the same frame).
 *   - Skips the write once both pos and lookAt have settled within
 *     CAM_SETTLE_EPS of target, avoiding needless per-frame allocation once
 *     converged.
 *   - User-interrupt: the damp loop only DRIVES the camera for programmatic
 *     moves (focus flight, recenter, brain⇄corpus transition). It never owns
 *     manual orbit/zoom. OrbitControls' own 'start' event (fired on both
 *     pointer-drag orbit and wheel/pinch zoom) flips an internal `active`
 *     flag off, which stops the per-frame write immediately — the camera
 *     stays exactly where OrbitControls leaves it, with no resume-toward-
 *     the-old-target once the user lets go (58-08 Stage-2 rejection: "snaps
 *     back" was the damp loop fighting OrbitControls every frame). The next
 *     ctx.setCameraTarget call re-arms `active` and resumes damping normally
 *     from the camera's current (user-repositioned) pose.
 *
 * Exported pure helper (for unit testing without a live Graph/ctx):
 *   stepCameraDamp({ THREE, cur, targetPos, curLookAt, targetLookAt, dt })
 *
 * @param {import('./constants.js').Ctx} ctx
 */

import { CAM_POS_LAMBDA, CAM_LOOKAT_LAMBDA } from './constants.js';

/** Below this per-axis delta (world units), pos/lookAt are considered settled
 *  and the per-frame write is skipped (avoids needless allocation once the
 *  camera has converged on its target). */
const CAM_SETTLE_EPS = 0.05;

/**
 * Pure damp step: given the current camera pos/lookAt and a target pos/
 * lookAt, returns the next-frame damped values. No ctx/Graph/registerTick
 * dependency — exported standalone so the damp math is unit-testable
 * (tests/viz-camera-damp.test.ts) without a live three.js/Graph stack.
 *
 * @param {Object} args
 * @param {{MathUtils: {damp: Function}}} args.THREE
 * @param {{x:number,y:number,z:number}} args.cur
 * @param {{x:number,y:number,z:number}} args.targetPos
 * @param {{x:number,y:number,z:number}} args.curLookAt
 * @param {{x:number,y:number,z:number}} args.targetLookAt
 * @param {number} args.dt seconds since the last tick
 * @returns {{pos:{x:number,y:number,z:number}, lookAt:{x:number,y:number,z:number}}}
 */
export function stepCameraDamp({ THREE, cur, targetPos, curLookAt, targetLookAt, dt }) {
  const damp = THREE.MathUtils.damp;
  return {
    pos: {
      x: damp(cur.x, targetPos.x, CAM_POS_LAMBDA, dt),
      y: damp(cur.y, targetPos.y, CAM_POS_LAMBDA, dt),
      z: damp(cur.z, targetPos.z, CAM_POS_LAMBDA, dt),
    },
    lookAt: {
      x: damp(curLookAt.x, targetLookAt.x, CAM_LOOKAT_LAMBDA, dt),
      y: damp(curLookAt.y, targetLookAt.y, CAM_LOOKAT_LAMBDA, dt),
      z: damp(curLookAt.z, targetLookAt.z, CAM_LOOKAT_LAMBDA, dt),
    },
  };
}

/** True when every axis of `a` sits within `eps` of the matching axis of `b`. */
function settled(a, b, eps) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

export function initCamera(ctx) {
  if (!ctx.Graph || typeof ctx.Graph.cameraPosition !== 'function' || !ctx.registerTick) return;

  // Seed the damped target from wherever the camera already sits (set by
  // graph.js's boot-time recenter(0), which runs before this module inits —
  // see app.js wiring order) so the very first tick is already settled.
  const initial = ctx.Graph.cameraPosition(); // no-arg read: { x, y, z, lookAt }
  let targetPos = { x: initial.x, y: initial.y, z: initial.z };
  let targetLookAt = initial.lookAt
    ? { x: initial.lookAt.x, y: initial.lookAt.y, z: initial.lookAt.z }
    : { x: 0, y: 0, z: 0 };

  // The damp loop only drives the camera while `active` is true — i.e. for
  // programmatic moves. A manual orbit/zoom (OrbitControls 'start') flips it
  // off so the user's input is never overridden; setCameraTarget flips it
  // back on for the next programmatic move.
  let active = false;

  ctx.setCameraTarget = (pos, lookAt) => {
    targetPos = pos;
    targetLookAt = lookAt;
    active = true;
    if (typeof ctx.markActive === 'function') ctx.markActive(); // suppress idle drift (lesson 2)
  };

  // Read-only in-flight signal (Phase 59 Plan 05, D-08/D-09): true whenever a
  // programmatic move is currently driving the camera. hud-recede.js reads
  // this to deepen the chrome recede during camera flights.
  ctx.isCameraInFlight = () => active;

  // Release the damp target the instant the user manually orbits or zooms.
  // OrbitControls dispatches 'start' for both pointer-drag rotation/pan AND
  // wheel/pinch zoom, so one listener covers both cases (58-08 Stage-2
  // rejection: the tick used to keep steering the camera back toward a
  // stale target underneath the user's own drag/zoom, reading as "snaps
  // back"). This is an interrupt, not a pause — 'end' does NOT re-arm
  // `active`; only the next ctx.setCameraTarget call does.
  const controls = typeof ctx.Graph.controls === 'function' ? ctx.Graph.controls() : null;
  if (controls && typeof controls.addEventListener === 'function') {
    controls.addEventListener('start', () => { active = false; });
  }

  let lastNow = null;

  ctx.registerTick((now) => {
    const dt = lastNow == null ? 1 / 60 : Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;

    if (!active) return; // no programmatic move in flight — leave the camera to the user

    const cur = ctx.Graph.cameraPosition();
    if (!cur) return;
    const curLookAt = cur.lookAt || { x: 0, y: 0, z: 0 };

    if (settled(cur, targetPos, CAM_SETTLE_EPS) && settled(curLookAt, targetLookAt, CAM_SETTLE_EPS)) {
      active = false; // reached target — release so a later manual interrupt is a no-op, not required
      return; // already at target — skip the write
    }

    const { pos, lookAt } = stepCameraDamp({
      THREE: ctx.THREE, cur, targetPos, curLookAt, targetLookAt, dt,
    });
    ctx.Graph.cameraPosition(pos, lookAt, 0); // ms=0 — the verified synchronous branch
  });
}
