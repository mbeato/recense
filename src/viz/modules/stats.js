/**
 * @module stats
 * brain-memory viz — master rAF loop, fps overlay, adaptive quality, idle throttle
 * (Plan 15-06, Task 3)
 *
 * initStats(ctx) implements:
 *   - ctx.registerTick(fn)  — register a per-frame callback (trace activation, effects shimmer)
 *   - ctx.markActive()      — reset idle timer; called on pointer/keyboard events
 *   - ctx.isIdle()          — returns true after IDLE_TIMEOUT_MS of no markActive() calls
 *   - ctx.setTier(tier)     — 0=FULL / 1=REDUCED / 2=MINIMAL quality tier
 *   - Single requestAnimationFrame loop: measures fps, invokes all registered ticks,
 *     auto-adapts quality, gates frame rate when idle (D-06/D-07)
 *   - Toggleable stats overlay showing fps + renderer.info draw-call metrics (D-08)
 *   - Adaptive quality: fps<DEGRADE_FPS → REDUCED (halve bloom res) → MINIMAL (disable bloom)
 *   - Idle throttle: ~IDLE_FPS via setTimeout+rAF when idle; full rAF when active (D-07)
 *   - document.visibilitychange: hidden → pauseAnimation(); visible → resumeAnimation() (D-07)
 *   - Idle camera drift: autoRotate at slow speed when idle; disabled on markActive() (D-04)
 *     NOTE: autoRotate is camera-only — never touches node/edge state
 */

import { IDLE_FPS, DEGRADE_FPS } from './constants.js';

// ── Quality tier enum ─────────────────────────────────────────────────────────
const QualityTier = { FULL: 0, REDUCED: 1, MINIMAL: 2 };
Object.freeze(QualityTier);

// ── Idle timeout: silence after this many ms = idle state ────────────────────
const IDLE_TIMEOUT_MS = 8000; // 8s quiet period triggers idle throttle + autoRotate

// ── FPS measurement hysteresis windows ───────────────────────────────────────
const DEGRADE_FRAMES = 120; // ~2s of low fps before downgrade
const RESTORE_FRAMES = 180; // ~3s of healthy fps before upgrade

export function initStats(ctx) {
  // ── Tick registry ─────────────────────────────────────────────────────────
  const callbacks = [];
  ctx.registerTick = fn => { callbacks.push(fn); };

  // ── Idle state ────────────────────────────────────────────────────────────
  let lastActiveTime = performance.now();

  ctx.markActive = () => {
    lastActiveTime = performance.now();
    // Disable autoRotate immediately on any activity (D-04)
    const controls = ctx.Graph && typeof ctx.Graph.controls === 'function' ? ctx.Graph.controls() : null;
    if (controls) controls.autoRotate = false;
  };

  ctx.isIdle = () => (performance.now() - lastActiveTime) > IDLE_TIMEOUT_MS;

  // ── Quality tier ──────────────────────────────────────────────────────────
  let currentTier = QualityTier.FULL;

  ctx.setTier = (newTier) => {
    if (newTier === currentTier) return;
    currentTier = newTier;
    const bp = ctx.bloomPass;
    if (!bp) return;
    // Resize via setSize(): UnrealBloomPass copies `resolution` into its render
    // targets in the constructor only — mutating the Vector2 afterwards is a no-op.
    if (newTier === QualityTier.FULL) {
      bp.enabled = true;
      if (typeof bp.setSize === 'function') bp.setSize(window.innerWidth, window.innerHeight);
    } else if (newTier === QualityTier.REDUCED) {
      bp.enabled = true;
      if (typeof bp.setSize === 'function') bp.setSize(
        Math.floor(window.innerWidth  / 2),
        Math.floor(window.innerHeight / 2)
      );
    } else {
      bp.enabled = false;
    }
  };

  // ── FPS rolling window (60-sample ring buffer) ────────────────────────────
  const fpsWindow = new Float32Array(60);
  let   fpsIdx    = 0;
  let   lastFrame = performance.now();

  function measureFps(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    // Guard against zero-length frames (tab-suspend recovery)
    fpsWindow[fpsIdx % 60] = dt > 0 ? Math.min(1000 / dt, 200) : 60;
    fpsIdx++;
  }

  function currentFps() {
    return fpsWindow.reduce((s, v) => s + v, 0) / 60;
  }

  // ── Stats overlay (D-08 — hidden hotkey 'S') ──────────────────────────────
  let statsVisible = false;

  const statsEl = document.createElement('div');
  statsEl.id = 'stats-overlay';
  statsEl.style.cssText = [
    'position:fixed',
    'top:8px',
    'right:360px',
    'z-index:30',
    'background:rgba(7,8,10,0.82)',
    'color:#00d4b0',
    'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'padding:4px 10px',
    'border-radius:6px',
    'border:1px solid rgba(140,150,165,0.18)',
    'display:none',
    'pointer-events:none',
    'white-space:pre',
  ].join(';');
  document.body.appendChild(statsEl);

  document.addEventListener('keydown', e => {
    if (e.key === 'S' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      statsVisible = !statsVisible;
      statsEl.style.display = statsVisible ? 'block' : 'none';
    }
  });

  function updateStatsOverlay(fps) {
    if (!statsVisible) return;
    const renderer = ctx.Graph && typeof ctx.Graph.renderer === 'function'
      ? ctx.Graph.renderer()
      : null;
    if (!renderer) {
      statsEl.textContent = 'fps: ' + fps.toFixed(1) + '  |  renderer unavailable';
      return;
    }
    const info = renderer.info;
    statsEl.textContent = [
      'fps: '   + fps.toFixed(1),
      'calls: ' + info.render.calls,
      'tris: '  + (info.render.triangles / 1000).toFixed(1) + 'k',
      'geo: '   + info.memory.geometries,
      'tex: '   + info.memory.textures,
      'tier: '  + ['FULL','REDUCED','MINIMAL'][currentTier],
    ].join('  |  ');
  }

  // ── Adaptive quality auto-degrade / restore ───────────────────────────────
  let tierDownCount = 0;
  let tierUpCount   = 0;

  function autoAdaptQuality(fps) {
    if (!ctx.bloomPass) return; // bloom not available yet, skip
    if (fps < DEGRADE_FPS) {
      tierDownCount++;
      tierUpCount = 0;
      if (tierDownCount >= DEGRADE_FRAMES) {
        ctx.setTier(Math.min(QualityTier.MINIMAL, currentTier + 1));
        tierDownCount = 0;
      }
    } else if (fps > DEGRADE_FPS + 10 && currentTier > QualityTier.FULL) {
      tierUpCount++;
      tierDownCount = 0;
      if (tierUpCount >= RESTORE_FRAMES) {
        ctx.setTier(Math.max(QualityTier.FULL, currentTier - 1));
        tierUpCount = 0;
      }
    } else {
      // In comfortable range: reset both counters
      tierDownCount = 0;
      tierUpCount   = 0;
    }
  }

  // ── Idle camera drift (D-04: camera-only, never node/edge changes) ─────────
  // Implemented manually: the bundled OrbitControls' autoRotate is inert (its
  // update() applies no rotation — verified empirically), so we rotate the
  // camera position around the target's vertical axis ourselves each idle
  // frame. Stops instantly on interaction because the gate is ctx.isIdle().
  const IDLE_ORBIT_RAD_PER_SEC = 0.02; // full orbit ≈ 5 min — ambient drift
  let lastDriftNow = null;
  function updateIdleDrift(now) {
    if (!ctx.isIdle()) { lastDriftNow = null; return; }
    const cam = ctx.Graph && typeof ctx.Graph.camera === 'function'
      ? ctx.Graph.camera()
      : null;
    if (!cam) return;
    if (lastDriftNow === null) { lastDriftNow = now; return; }
    const dt = Math.min(0.1, (now - lastDriftNow) / 1000);
    lastDriftNow = now;

    const controls = ctx.Graph && typeof ctx.Graph.controls === 'function'
      ? ctx.Graph.controls()
      : null;
    const target = (controls && controls.target) || { x: 0, y: 0, z: 0 };
    const a = IDLE_ORBIT_RAD_PER_SEC * dt;
    const cos = Math.cos(a), sin = Math.sin(a);
    const dx = cam.position.x - target.x;
    const dz = cam.position.z - target.z;
    cam.position.x = target.x + dx * cos - dz * sin;
    cam.position.z = target.z + dx * sin + dz * cos;
    cam.lookAt(target.x, target.y || 0, target.z);
  }

  // ── Master rAF loop ───────────────────────────────────────────────────────
  let loopRunning = false;
  let lastTickErr = ''; // dedupe: report each unique tick error once, not 60x/s

  function scheduleFrame() {
    if (!loopRunning) return;
    if (ctx.isIdle()) {
      // Throttle to ~IDLE_FPS to keep fans quiet (D-07)
      const delay = Math.max(0, 1000 / IDLE_FPS - (performance.now() - lastFrame));
      setTimeout(() => { if (loopRunning) requestAnimationFrame(frame); }, delay);
    } else {
      requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    if (!loopRunning) return;

    // 1. Measure fps
    measureFps(now);
    const fps = currentFps();

    // 2. Invoke all registered tick callbacks — keep the loop alive on error,
    // but never silently (D-14): surface once per unique error message.
    for (const fn of callbacks) {
      try { fn(now); } catch (err) {
        const m = (err && err.message) || String(err);
        if (m !== lastTickErr) {
          lastTickErr = m;
          if (ctx.logEvent) ctx.logEvent('tick-error', m);
          else console.error('tick error:', err);
        }
      }
    }

    // 3. Update stats overlay
    updateStatsOverlay(fps);

    // 4. Auto-adapt quality based on measured fps (D-06)
    autoAdaptQuality(fps);

    // 5. Drive idle camera drift (D-04)
    updateIdleDrift(now);

    // 6. Schedule next frame (idle-throttled or full rate)
    scheduleFrame();
  }

  // ── Visibility pause/resume (D-07: fans quiet all day) ────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      loopRunning = false;
      if (ctx.Graph && typeof ctx.Graph.pauseAnimation === 'function') {
        ctx.Graph.pauseAnimation();
      }
    } else {
      loopRunning = true;
      if (ctx.Graph && typeof ctx.Graph.resumeAnimation === 'function') {
        ctx.Graph.resumeAnimation();
      }
      lastFrame = performance.now(); // reset to avoid fps spike on resume
      scheduleFrame();
    }
  });

  // ── Bootstrap the loop ────────────────────────────────────────────────────
  // Wait one tick so ctx.Graph (set by graph.js in the same wave) can settle.
  // The rAF fires naturally on the next paint, so no meaningful delay in practice.
  loopRunning = true;
  requestAnimationFrame(frame);
}
