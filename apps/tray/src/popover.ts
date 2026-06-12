/**
 * apps/tray/src/popover.ts
 *
 * Frameless BrowserWindow that serves as the brain viz popover panel (D-04).
 * Loads the unchanged Phase 15 frontend at http://127.0.0.1:7810 (D-03/D-102).
 * Navigation is locked to the loopback origin (T-16-10).
 * Electron 42 security defaults are preserved — contextIsolation, sandbox,
 * and nodeIntegration are NOT overridden (T-16-09).
 *
 * Exports: createPopover, positionUnder, togglePopover, setPinned, isPinned
 */
import { BrowserWindow, Tray } from 'electron';
import { join } from 'path';

/** Small square — glance surface sized so the brain fills the frame; the viz
 *  frontend switches to compact mode (discrete legend, tighter camera) ≤500px. */
const WIN_WIDTH = 300;
const WIN_HEIGHT = 300;

/** Module-level pin state. Accessed only through isPinned() / setPinned(). */
let _pinned = false;

/**
 * Create the frameless popover BrowserWindow.
 *
 * The URL is loaded immediately with show:false so the renderer's
 * visibilityState starts as 'hidden' — the Phase 15 D-07 idle throttle
 * engages until the first win.show() call.
 *
 * Security posture (T-16-09): contextIsolation/sandbox/nodeIntegration are
 * NOT set — Electron 42 defaults (contextIsolation:true, sandbox:true,
 * nodeIntegration:false) are correct and must remain.
 *
 * Navigation lock (T-16-10):
 *  - will-navigate: aborts any destination outside 127.0.0.1:7810
 *  - setWindowOpenHandler: denies all new-window requests from the renderer
 *
 * Blur-dismiss (D-04): an unpinned popover hides on blur; a pinned window
 * stays floating as an always-on-top surface (see setPinned).
 */
export function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    frame: false,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // contextIsolation: true  — Electron 42 default; do NOT override (T-16-09)
      // sandbox: true           — Electron 42 default; do NOT override (T-16-09)
      // nodeIntegration: false  — Electron 42 default; do NOT override (T-16-09)
    },
  });

  // Load while show:false so visibilityState starts as 'hidden'.
  // The Phase 15 D-07 render-pause activates immediately; rendering is
  // paused until the first win.show() call.
  win.loadURL('http://127.0.0.1:7810').catch(() => {
    // Server may not be up yet — renderer will retry when shown.
  });

  // T-16-10: abort any navigation that leaves the loopback origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:7810')) {
      event.preventDefault();
    }
  });

  // T-16-10: deny any new-window request from the renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // D-04: blur-dismiss — hide the popover on loss of focus unless pinned.
  // Pinned windows survive blur and remain as an always-on-top floating surface.
  win.on('blur', () => {
    if (!_pinned) {
      win.hide();
    }
  });

  return win;
}

/**
 * Position the popover anchored horizontally under the tray icon.
 *
 * Uses screen-space coordinates returned by tray.getBounds() — correct on
 * secondary displays where the tray bounds have a non-zero y offset
 * (multi-monitor aware).
 *
 * Centering formula: x = round(b.x + b.width/2 - w/2)
 */
export function positionUnder(tray: Tray, win: BrowserWindow): void {
  const b = tray.getBounds();
  const [w] = win.getSize();
  const x = Math.round(b.x + b.width / 2 - (w ?? WIN_WIDTH) / 2);
  const y = Math.round(b.y + b.height);
  win.setPosition(x, y, false);
}

/**
 * Toggle the popover open/closed.
 *
 * If visible: hide it.
 * If hidden: anchor it under the tray icon, show it, and focus it.
 */
export function togglePopover(tray: Tray, win: BrowserWindow): void {
  if (win.isVisible()) {
    win.hide();
  } else {
    positionUnder(tray, win);
    win.show();
    win.focus();
  }
}

/**
 * Set the pin state.
 *
 * Pinned → window becomes always-on-top; blur no longer hides it.
 *   Promotes the popover to an all-day ambient floating window (D-04).
 * Unpinned → reverts to blur-dismiss behavior; stays visible until next blur.
 */
export function setPinned(win: BrowserWindow, pinned: boolean): void {
  _pinned = pinned;
  win.setAlwaysOnTop(pinned);
}

/**
 * Return the current pin state.
 */
export function isPinned(): boolean {
  return _pinned;
}
