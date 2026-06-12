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
 * Collapse-to-tray button, injected from the main process (zero-IPC posture:
 * the page commands Electron by navigating to a sentinel the will-navigate
 * guard intercepts — same pattern as the popover's expand button).
 */
const COLLAPSE_SENTINEL = 'http://127.0.0.1:7810/__recense/collapse';
const COLLAPSE_BTN_JS = `(() => {
  if (document.getElementById('recense-collapse-btn')) return;
  const btn = document.createElement('div');
  btn.id = 'recense-collapse-btn';
  btn.textContent = '\u2199';
  btn.title = 'Collapse to menu bar';
  btn.style.cssText = 'position:fixed;top:10px;right:12px;z-index:70;width:26px;height:26px;'
    + 'line-height:26px;text-align:center;border-radius:7px;cursor:pointer;'
    + 'color:#d9cbc0;background:rgba(26,18,32,0.7);border:1px solid rgba(170,150,180,0.18);'
    + 'font:15px ui-sans-serif,system-ui;opacity:0.65;user-select:none;';
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.65'; });
  btn.addEventListener('click', () => { location.href = '${COLLAPSE_SENTINEL}'; });
  document.body.appendChild(btn);
})();`;

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
    title: 'Recense',
    show: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // contextIsolation/sandbox/nodeIntegration: Electron 42 defaults (T-16-09)
    },
  });

  // T-16-10: abort any navigation that leaves the loopback origin.
  // The collapse sentinel is intercepted FIRST as a command (demote window →
  // tray-only); prevented like any navigation, so the page never leaves.
  _win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(COLLAPSE_SENTINEL)) {
      event.preventDefault();
      _win?.close(); // close IS the demote: accessory mode resumes, tray keeps running
      return;
    }
    if (!url.startsWith(VIZ_URL)) {
      event.preventDefault();
    }
  });

  // Inject the collapse-to-tray affordance whenever the page (re)loads.
  _win.webContents.on('did-finish-load', () => {
    _win?.webContents.executeJavaScript(COLLAPSE_BTN_JS).catch(() => {});
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

/** Obsidian-style reopen: clicking the Dock icon or re-launching brain.app
 *  from Finder while the app is running opens (or focuses) the exploration
 *  window — the desktop icon is the front door to looking around. */
app.on('activate', () => {
  openMainWindow();
});
