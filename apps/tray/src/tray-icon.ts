/**
 * tray-icon.ts — Tray creation + SSE subscription + pulse/dim/rest icon state machine.
 *
 * Responsibilities:
 *   - Create the macOS menu-bar Tray icon from the at-rest template image.
 *   - Subscribe to the viz server's /events SSE stream using the eventsource package
 *     (undici's EventSource resolves in dev only via transitive node_modules — it is NOT
 *     packaged into the asar and crashes the built .app; OQ-2 re-resolved 2026-06-12).
 *   - Pulse the icon amber ONLY on real `trace` events (Phase 15 D-04 — no fake firing).
 *   - Dim the icon when the SSE connection errors / server is down (D-05 health).
 *   - Reconnect after sleep/wake via powerMonitor.on('resume').
 *   - Expose setDim/setRest so the main process can drive dim from a child-process-down signal.
 *
 * Logging: append-only /tmp/recense-tray.log — never stdout (background-process pattern).
 */

import { Tray, nativeImage, powerMonitor } from 'electron';
import { EventSource } from 'eventsource';
import { join } from 'path';
import { appendFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/recense-tray.log';

function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] tray-icon: ${msg}\n`);
  } catch {
    // best-effort — never throw in a background utility function
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrayIconOptions {
  onClick: () => void;
  /** Right-click handler — pops the context menu. A persistent setContextMenu
   *  is deliberately avoided: on macOS it opens on LEFT click too, double-firing
   *  alongside onClick (acceptance feedback 2026-06-12). */
  onRightClick?: () => void;
}

export interface TrayIconHandle {
  tray: Tray;
  pulse(): void;
  setDim(): void;
  setRest(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Icon paths
// ---------------------------------------------------------------------------

const ICONS_DIR = join(__dirname, 'icons');

function restIcon() {
  return nativeImage.createFromPath(join(ICONS_DIR, 'iconTemplate.png'));
}

function activeIcon() {
  return nativeImage.createFromPath(join(ICONS_DIR, 'icon-active.png'));
}

function dimIcon() {
  // 40%-alpha template variant — visually distinct server-offline state (D-05)
  return nativeImage.createFromPath(join(ICONS_DIR, 'iconDimTemplate.png'));
}

// ---------------------------------------------------------------------------
// SSE endpoint
// ---------------------------------------------------------------------------

const SSE_URL = 'http://127.0.0.1:7810/events';

// ---------------------------------------------------------------------------
// initTrayIcon
// ---------------------------------------------------------------------------

export function initTrayIcon(opts: TrayIconOptions): TrayIconHandle {
  // ---- Tray setup ---------------------------------------------------------
  const tray = new Tray(restIcon());
  tray.setToolTip('brain');
  tray.on('click', opts.onClick);
  if (opts.onRightClick) tray.on('right-click', opts.onRightClick);

  // ---- State ---------------------------------------------------------------
  let isDim = false;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  let es: InstanceType<typeof EventSource> | null = null;
  let disposed = false;

  // ---- Icon state helpers --------------------------------------------------

  function setRest(): void {
    isDim = false;
    tray.setImage(restIcon());
    tray.setToolTip('brain');
  }

  function setDim(): void {
    isDim = true;
    tray.setImage(dimIcon());
    tray.setToolTip('brain — server offline');
  }

  function pulse(): void {
    if (disposed) return;
    // Cancel any in-progress pulse restore so we don't flicker back prematurely
    if (pulseTimer !== null) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    tray.setImage(activeIcon());
    // Restore the correct base image after 600 ms — dim if the connection
    // dropped mid-pulse, rest otherwise (never leave the active image stuck).
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      if (!disposed) {
        tray.setImage(isDim ? dimIcon() : restIcon());
      }
    }, 600);
  }

  // ---- SSE connection ------------------------------------------------------

  function connectSSE(): void {
    if (disposed) return;

    // Close the previous connection before opening a new one so duplicate
    // connections never accumulate (important on sleep/wake reconnect).
    if (es !== null) {
      try { es.close(); } catch { /* best-effort */ }
      es = null;
    }

    log('connecting SSE: ' + SSE_URL);

    try {
      es = new EventSource(SSE_URL);
    } catch (err) {
      log('failed to construct EventSource: ' + String(err));
      setDim();
      return;
    }

    // Pulse ONLY on real activation trace events — Phase 15 D-04 no-fake-firing.
    // Event name is `trace` (NOT `message`, NOT `activation`) — locked in server.ts.
    es.addEventListener('trace', (_e: Event) => {
      log('trace event received — pulsing icon');
      // A received trace proves the server is alive — clear any dim state.
      // No setRest() needed: pulse() sets the active image immediately, so
      // clearing the flag is sufficient and avoids an image flicker.
      isDim = false;
      pulse();
    });

    // Successful (re)connect — restore the rest icon. The eventsource package
    // emits 'open' on auto-reconnects as well as the initial connect, so this
    // closes the startup race: the first error dims the icon, the auto-reconnect
    // succeeds ~1s later, and this open restores rest. Redundant fires while
    // already at rest are fine — setRest() is idempotent.
    es.addEventListener('open', (_e: Event) => {
      if (disposed) return;
      log('SSE open — restoring rest icon');
      setRest();
    });

    // Server down / connection error — dim the icon (D-05 health).
    es.addEventListener('error', (_e: Event) => {
      log('SSE error — dimming icon');
      setDim();
    });
  }

  // Initial connection
  connectSSE();

  // ---- Sleep/wake reconnect ------------------------------------------------
  // powerMonitor fires 'resume' when the system wakes from sleep.
  // Close the stale connection and open a fresh one.
  powerMonitor.on('resume', () => {
    log('powerMonitor resume — reconnecting SSE');
    setDim(); // show offline state until the new connection confirms the server
    connectSSE();
    // Restore the rest icon only if the fresh connection actually opened.
    // setDim() above forces isDim=true, so isDim alone can't distinguish a
    // successful reconnect from a failed one — gate on readyState instead.
    // If the server is down, readyState stays CONNECTING/CLOSED and the
    // icon remains dim until a later successful connection or trace event.
    setTimeout(() => {
      if (!disposed && isDim && es !== null && es.readyState === EventSource.OPEN) {
        setRest();
      }
    }, 3000);
  });

  // ---- Dispose -------------------------------------------------------------

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (pulseTimer !== null) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    if (es !== null) {
      try { es.close(); } catch { /* best-effort */ }
      es = null;
    }
    log('tray icon disposed');
  }

  // ---- Return handle -------------------------------------------------------

  return { tray, pulse, setDim, setRest, dispose };
}
