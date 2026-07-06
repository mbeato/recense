/**
 * @module hud-recede
 * recense viz — HUD chrome auto-recede (Phase 59 Plan 05, D-08/D-09/D-10/D-11).
 *
 * initHudRecede(ctx) drives an opacity-only `.hud-receded` class on the
 * chip/rail/topics-rail chrome so the scene gets the stage exactly when the
 * user is watching it:
 *   - Idle: no mouse movement for HUD_IDLE_TIMEOUT_MS (own threshold, reads
 *     ctx.msSinceActive() — NOT stats.js's separate 1200ms scene-drift
 *     IDLE_TIMEOUT_MS/ctx.isIdle(), RESEARCH Pitfall 2).
 *   - Camera flight: ctx.isCameraInFlight() true for the duration of any
 *     programmatic camera move (focus, recenter, transition).
 *   - Focus/detail-open: reuses the existing #detail panel-open signal
 *     (detail.js's showPanel/hidePanel) — read-only, no new coupling into
 *     detail.js internals. This path deepens the recede faster (motion-fast).
 *
 * Any mouse move already resets stats.js's lastActiveTime via the existing
 * global mousemove listener (app.js), so ctx.msSinceActive() drops
 * immediately and chrome returns — no second mousemove listener is added
 * here (RESEARCH Pitfall 4).
 *
 * Deliberately does not read any live-recall / server-push / activation
 * signal (D-10): activity firing on the wire must never force a recede.
 *
 * @param {import('./constants.js').Ctx} ctx
 */

import { HUD_IDLE_TIMEOUT_MS } from './constants.js';

const CHROME_SELECTORS = ['#hud-chip', '#hud-rail', '#topics-rail'];

export function initHudRecede(ctx) {
  if (!ctx.registerTick) return;

  const chromeEls = CHROME_SELECTORS
    .map(sel => document.querySelector(sel))
    .filter(Boolean);
  if (!chromeEls.length) return;

  const detailEl = document.getElementById('detail');

  let lastReceded = false;
  let lastFast = false;

  ctx.registerTick(() => {
    const idle = typeof ctx.msSinceActive === 'function' && ctx.msSinceActive() > HUD_IDLE_TIMEOUT_MS;
    const inFlight = typeof ctx.isCameraInFlight === 'function' && ctx.isCameraInFlight();
    const focused = !!(detailEl && detailEl.classList.contains('panel-open'));

    const receded = idle || inFlight || focused;
    if (receded === lastReceded && focused === lastFast) return; // no state change — skip DOM writes

    for (const el of chromeEls) {
      el.classList.toggle('hud-receded', receded);
      // Focus/detail-open deepens the recede with a quicker transition (D-10).
      el.classList.toggle('hud-recede-fast', receded && focused);
    }
    lastReceded = receded;
    lastFast = focused;
  });
}
