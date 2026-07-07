---
status: resolved
trigger: "after focusing a node (camera fly-to) and then unfocusing (exiting the node), the brain's idle auto-rotation does NOT resume. A manual drag-and-release nudges it back to life. Founder retested on a fresh app launch after fix fd8f224 - STILL REPRODUCES."
created: 2026-07-07T00:10:38Z
updated: 2026-07-07T14:35:07Z
---

## Current Focus

hypothesis: camera.js's own settle check reads the wrong "current lookAt" value. The vendor 3d-force-graph no-arg `Graph.cameraPosition()` accessor synthesizes its `lookAt` field via h() = camera.position + 1000*forwardUnitVector (a fixed-length-1000 point along the camera's facing ray), NOT the real `controls.target`. camera.js's tick uses this synthetic value as `curLookAt` and compares it against `targetLookAt` (the real desired world-space point, e.g. a focused node ~320 units away or the origin). Since h()'s distance is hardcoded at 1000 and real flight targets sit at other distances, `settled(curLookAt, targetLookAt, CAM_SETTLE_EPS)` can never converge, so `active` never clears on its own - exactly the reported "wedge," and exactly why fd8f224's `isCameraInFlight()` gate in stats.js made drift wait forever on a flag that never clears itself.
test: read vendor 3d-force-graph.min.js's `cameraPosition` accessor source directly (ground truth, not inference) to confirm h()'s formula and confirm the write path (`c(t)`) sets `controls.target` directly (a different code path than the read's h() approximation).
expecting: h() computes a fixed 1000-unit-ahead point from the camera's actual quaternion-derived forward direction; the write path assigns `controls.target = new Vector3(...)` directly. Confirms curLookAt (read) and targetLookAt (desired) are structurally different quantities whenever true distance != 1000.
next_action: fix implemented, self-verified (tsc clean, targeted + full test suite green including a red-before/green-after regression test, build refreshed), and committed as fix(59-06) (064a4a6). Founder retested live on a fresh app launch (focus a node, unfocus, wait past idle timeout) and confirmed auto-rotation resumes on its own without a manual drag. Approved as part of the 59-06 D-15 checkpoint (2026-07-07); session archived to resolved/.

## Symptoms

expected: after exiting a focused node, the brain resumes its slow idle auto-rotation on its own within ~1.2s of no interaction.
actual: idle auto-rotation stays frozen indefinitely after a focus -> unfocus cycle. A manual drag-and-release "nudges" it back to life.
errors: none (silent logic wedge, no console error)
reproduction: focus a node (camera fly-to dolly position/lookAt near the node), then unfocus (close detail panel -> recenter() fires an animated ctx.setCameraTarget back to the overview framing). Wait past the 1200ms idle timeout. Auto-rotation does not resume. A manual drag + release unwedges it.
started: reproduces on a fresh app launch after fd8f224 (prior incomplete fix attempt gating stats.js's updateIdleDrift on `!ctx.isCameraInFlight()`)

## Eliminated

- hypothesis: fd8f224's fix (gating idle drift on isCameraInFlight()) was sufficient
  evidence: founder retested on fresh launch - STILL REPRODUCES. The gate only changes WHAT drift waits on; it does not fix why isCameraInFlight() (i.e. camera.js's `active` flag) never clears on its own.
  timestamp: 2026-07-07T00:10:38Z (established before this session started, per prior debug history)

- hypothesis: OrbitControls' enableDamping / residual sphericalDelta momentum keeps nudging camera.position after a flight, preventing settle
  evidence: read vendor bundle's OrbitControls class constructor - `this.enableDamping=!1` (false by default), and this app's controls object is never reconfigured (grep for enableDamping/dampingFactor/minDistance/maxDistance across src/viz/modules/*.js found no overrides). With enableDamping false, `sphericalDelta` and `panOffset` are hard-reset to zero every update() call - no residual drift mechanism exists.
  timestamp: 2026-07-07T00:10:38Z

- hypothesis: OrbitControls caches a stale reference to `controls.target` internally (closure captured once), so camera.js's `Graph.cameraPosition(pos, lookAt, 0)` write (which replaces `controls.target` with a brand-new Vector3 each call) is invisible to OrbitControls' own update()/lookAt() logic
  evidence: read vendor bundle's OrbitControls.update() method body directly - `const t=this.object.position; RN.copy(t).sub(this.target)` and later `t.copy(this.target).add(RN)` and `this.object.lookAt(this.target)` - all reference `this.target` as a live property access, not a captured local, so target reassignment is picked up correctly. No stale-reference bug here.
  timestamp: 2026-07-07T00:10:38Z

- hypothesis: minDistance/maxDistance or minPolarAngle/maxPolarAngle clamps in OrbitControls silently pull camera.position away from what camera.js wrote, so cur position (read back) never matches targetPos
  evidence: vendor OrbitControls constructor defaults - minDistance=0, maxDistance=Infinity, minPolarAngle=0, maxPolarAngle=Math.PI (full range) - and no override anywhere in src/viz/modules/*.js. No clamp is active, so this cannot explain a permanent position mismatch.
  timestamp: 2026-07-07T00:10:38Z

## Evidence

- timestamp: 2026-07-07T00:10:38Z
  checked: vendor bundle src/viz/vendor/3d-force-graph.min.js, the `cameraPosition` Kapsule accessor function body (grep match at byte offset 1137726)
  found: |
    cameraPosition:function(e,t,n,i){var r=e.camera;if(t&&e.initialised){...write branch...
      function u(e){ if x/y/z defined, r.position.x=t etc }              // sets raw camera.position
      function c(t){ var n=new Vector3(t.x,t.y,t.z);
        e.controls.target ? e.controls.target=n : r.lookAt(n) }          // REPLACES controls.target with a fresh Vector3
    }
    // no-arg READ branch:
    return Object.assign({},r.position,{lookAt:h()});
    function h(){ return new Vector3(0,0,-1000).applyQuaternion(r.quaternion).add(r.position) }
  implication: the READ accessor's `lookAt` field is NOT `controls.target` - it is a synthetic point exactly 1000 world units in front of the camera along its current facing direction (derived from the camera's quaternion). The WRITE accessor, by contrast, sets `controls.target` directly to whatever lookAt is passed. These are different quantities whenever the true camera-to-target distance != 1000.

- timestamp: 2026-07-07T00:10:38Z
  checked: src/viz/modules/camera.js tick body (`ctx.registerTick` callback) and detail.js's focusCamera / graph.js's recenter (the two callers of ctx.setCameraTarget)
  found: |
    - focusCamera: dollyPos = node + {220,80,220}, lookAt = node position exactly -> geometric distance = sqrt(220^2+80^2+220^2) ~= 321 units.
    - recenter (full window): target z = BRAIN_SCALE*2.2 = 460*2.2 = 1012, lookAt = {0,0,0} -> distance = 1012 units (close to but not exactly 1000; off by 12 - still >> CAM_SETTLE_EPS=0.05).
    - camera.js's tick computes `curLookAt = cur.lookAt` (the h()-synthesized point, distance always ~1000 from position) and compares it via `settled(curLookAt, targetLookAt, CAM_SETTLE_EPS)` against the REAL target (distance ~321 for focus, ~1012 for recenter).
  implication: for the focus flight, curLookAt permanently sits ~679 world units past the real target along the same ray (1000 - 321); for recenter it is off by ~12 units. Both are enormously larger than CAM_SETTLE_EPS (0.05), so the lookAt half of the settle check can never pass. `active` therefore never clears on its own for either flight - matches "focus AND unfocus both leave it wedged," and matches why only a manual drag (which force-clears `active` via OrbitControls' 'start' handler) unwedges it.

## Resolution

root_cause: |
  camera.js's damp-tick settle check compares the WRONG "current lookAt" value against the desired target. It reads `cur.lookAt` from the vendor's no-arg `Graph.cameraPosition()` accessor, which synthesizes that field as a fixed-length-1000 point projected along the camera's current facing direction (`camera.position + 1000 * forwardUnitVector`) - not the real `controls.target`. Because actual flight targets (node focus ~321 units away, recenter ~1012 units away) sit at a different distance than 1000, this synthetic value can never converge to within CAM_SETTLE_EPS (0.05) of the real target. `settled(curLookAt, targetLookAt, CAM_SETTLE_EPS)` therefore never returns true, `active` never resets to false on its own, and fd8f224's stats.js gate (`!ctx.isCameraInFlight()`) then waits forever on a flag that structurally can never clear - converting the original two-writer race into a permanent wait. Only a manual drag/zoom (OrbitControls' 'start' event) force-clears `active`, which is why that "nudges it back to life."
fix: |
  camera.js's tick now reads the REAL current look target from `ctx.Graph.controls().target` (the same `controls` object already captured at init for the 'start' listener; `.target` is read fresh each tick since OrbitControls exposes it as a live property, not a cached closure value) instead of the synthetic `cur.lookAt`. This is also the correct quantity for `stepCameraDamp` to damp - it's the actual current gaze point, not an arbitrary distance-1000 approximation, so the "gaze settles faster than position" easing (CAM_LOOKAT_LAMBDA vs CAM_POS_LAMBDA) now operates on a meaningful value too. Falls back to `cur.lookAt || {x:0,y:0,z:0}` only if `controls`/`controls.target` is unavailable, preserving the existing mocked-controls unit tests in tests/viz-camera-damp.test.ts unchanged. fd8f224's stats.js gate (`!ctx.isCameraInFlight()`) is kept - it is correct now that the underlying flag actually clears when a flight settles.
verification: |
  New regression test (tests/viz-idle-drift-camera-flight.test.ts, "camera.js's
  real settle logic (not mocked)") drives camera.js's real initCamera()/tick
  through a vendor-faithful mock of Graph.cameraPosition()/controls() (same
  WRITE/READ asymmetry as the real vendor library - h()-synthesized read
  lookAt vs controls.target write) through a node-focus flight (~321 units)
  then an unfocus/recenter flight. Confirmed RED against the pre-fix
  camera.js (git stash of only that file): isCameraInFlight() stayed true
  forever after 320 simulated frames (~5.1s) - reproducing the exact live
  wedge. Confirmed GREEN after restoring the fix: isCameraInFlight() clears
  on its own after both the focus and the unfocus flight, no manual drag
  simulated. Full suite: npx tsc --noEmit -p . clean; targeted 3 files green
  (58 tests); full npm test green (2643 passed, 3 skipped, 177 files passed +
  1 pre-existing skip); npm run build clean (dist refreshed).
files_changed:
  - src/viz/modules/camera.js
  - tests/viz-idle-drift-camera-flight.test.ts (extended with a real-camera.js settle-path regression test)
