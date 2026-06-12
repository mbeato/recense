/**
 * tray-icon.ts — Tray creation + SSE subscription + pulse/dim/rest icon state machine.
 *
 * Responsibilities:
 *   - Create the macOS menu-bar Tray icon from the at-rest template image.
 *   - Subscribe to the viz server's /events SSE stream using undici EventSource.
 *   - Pulse the icon amber ONLY on real `trace` events (Phase 15 D-04 — no fake firing).
 *   - Dim the icon when the SSE connection errors / server is down (D-05 health).
 *   - Reconnect after sleep/wake via powerMonitor.on('resume').
 *   - Expose setDim/setRest so the main process can drive dim from a child-process-down signal.
 *
 * Logging: append-only /tmp/brain-memory-tray.log — never stdout (background-process pattern).
 */

import { Tray, nativeImage, powerMonitor } from 'electron';
import { EventSource } from 'undici';
import { join } from 'path';
import { appendFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/brain-memory-tray.log';

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
    tray.setImage(restIcon());
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
    // Restore the at-rest template image after 600 ms
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      if (!disposed && !isDim) {
        tray.setImage(restIcon());
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
      pulse();
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
    setDim(); // show offline state until the new connection fires a trace event
    connectSSE();
    // Restore rest icon once reconnected (immediate optimistic restore — the
    // next trace event will confirm the server is actually live).
    setTimeout(() => {
      if (!disposed && isDim) {
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
