/**
 * apps/tray/src/main-window.ts
 *
 * Full-size resizable window for node exploration (founder addition at the
 * 16-06 acceptance gate, 2026-06-12). The tray popover is a glance surface;
 * deep exploration (detail panel, connections, log) wants a real window.
 *
 * Dock behavior (evolves D-06): the app runs as a menu-bar accessory by
 * default; while this window is open it adopts the 'regular' activation
 * policy (Dock icon, Cmd-Tab). Closing the window returns to accessory —
 * the tray icon and server keep running in the background.
 *
 * Security posture matches popover.ts (T-16-09/T-16-10): Electron 42
 * defaults preserved, navigation locked to the loopback origin, all
 * new-window requests denied.
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'path';

const VIZ_URL = 'http://127.0.0.1:7810';

/** Default exploration size — comfortably above the 500px compact-mode
 *  breakpoint so the full panel/legend/nav UI renders. */
const WIN_WIDTH = 1100;
const WIN_HEIGHT = 750;

let _win: BrowserWindow | null = null;

/**
 * Open (or focus, if already open) the full exploration window.
 * Safe to call repeatedly from the tray menu.
 */
export function openMainWindow(): void {
  if (_win && !_win.isDestroyed()) {
    _win.show();
    _win.focus();
    return;
  }

  // Dock icon + Cmd-Tab presence while the exploration window lives.
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
  }

  _win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    title: 'brain-memory',
    show: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // contextIsolation/sandbox/nodeIntegration: Electron 42 defaults (T-16-09)
    },
  });

  // T-16-10: abort any navigation that leaves the loopback origin.
  _win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(VIZ_URL)) {
      event.preventDefault();
    }
  });

  // T-16-10: deny any new-window request from the renderer.
  _win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  _win.loadURL(VIZ_URL).catch(() => {
    // Server may not be up yet — blank window; user can reopen from the tray.
  });

  _win.on('closed', () => {
    _win = null;
    // Back to menu-bar-only; tray + server keep running (D-06 baseline).
    if (process.platform === 'darwin') {
      app.setActivationPolicy('accessory');
    }
  });
}

/** Focus the window from a Dock-icon click while in 'regular' mode. */
app.on('activate', () => {
  if (_win && !_win.isDestroyed()) {
    _win.show();
    _win.focus();
  }
});
