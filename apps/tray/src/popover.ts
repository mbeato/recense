/**
 * apps/tray/src/popover.ts
 *
 * Frameless BrowserWindow that serves as the brain viz popover panel (D-04).
 * Loads the unchanged Phase 15 frontend at http://127.0.0.1:7810 (D-03/D-102).
 * Navigation is locked to the loopback origin (T-16-10).
 * Electron 42 security defaults are preserved — contextIsolation, sandbox,
 * and nodeIntegration are NOT overridden (T-16-09).
 *
 * Exports: createPopover
 * Extended by Task 2: positionUnder, togglePopover, setPinned, isPinned
 */
import { BrowserWindow } from 'electron';
import { join } from 'path';

/** Default window dimensions (Claude's discretion per plan). */
const WIN_WIDTH = 420;
const WIN_HEIGHT = 640;

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

  return win;
}
