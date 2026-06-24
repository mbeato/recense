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

/** Called after a collapse-to-tray so the orchestrator can show the popover
 *  (true swap — symmetric with the popover's expand button). */
let _onCollapse: (() => void) | null = null;
let _collapseRequested = false;
export function setCollapseHandler(cb: () => void): void {
  _onCollapse = cb;
}
const COLLAPSE_BTN_JS = `(() => {
  if (document.getElementById('recense-collapse-btn')) return;
  const btn = document.createElement('div');
  btn.id = 'recense-collapse-btn';
  btn.textContent = '\u2199';
  btn.title = 'Collapse to menu bar';
  btn.style.cssText = 'position:fixed;top:10px;right:12px;z-index:70;width:30px;height:30px;'
    + 'display:flex;align-items:center;justify-content:center;border-radius:7px;cursor:pointer;'
    + 'color:#d9cbc0;background:rgba(26,18,32,0.7);'
    + 'font:17px ui-sans-serif,system-ui;opacity:0.65;user-select:none;';
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
      _collapseRequested = true; // swap completes in the 'closed' handler —
      _win?.close();             // showing the popover NOW gets blur-killed by
      return;                    // the focus churn of close + policy switch
    }
    if (!url.startsWith(VIZ_URL)) {
      event.preventDefault();
    }
  });

  // did-fail-load: bounded backoff retry until the viz server binds port 7810.
  // Mirrors the same fix in popover.ts — see there for rationale.
  // Declared before the did-finish-load handler below so clearLoadRetry is
  // in scope when the handler closure captures it.
  let loadRetries = 0;
  const LOAD_MAX_RETRIES = 30;
  const LOAD_RETRY_MS = 2_500;
  let loadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const clearLoadRetry = () => {
    if (loadRetryTimer !== null) { clearTimeout(loadRetryTimer); loadRetryTimer = null; }
    loadRetries = 0;
  };

  // Inject the collapse-to-tray affordance whenever the page (re)loads.
  // Clears the did-fail-load retry on success so duplicate retries never fire.
  _win.webContents.on('did-finish-load', () => {
    clearLoadRetry(); // cancel any pending retry — load succeeded
    _win?.webContents.executeJavaScript(COLLAPSE_BTN_JS).catch(() => {});
  });

  // T-16-10: deny any new-window request from the renderer.
  _win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  _win.webContents.on('did-fail-load', (_ev, errorCode) => {
    if (errorCode === -3) return; // ERR_ABORTED — user navigation, not server down
    if (loadRetryTimer !== null || loadRetries >= LOAD_MAX_RETRIES) return;
    loadRetryTimer = setTimeout(() => {
      loadRetryTimer = null;
      loadRetries++;
      _win?.loadURL(VIZ_URL).catch(() => {});
    }, LOAD_RETRY_MS);
  });

  _win.loadURL(VIZ_URL).catch(() => {});

  _win.on('closed', () => {
    clearLoadRetry(); // stop retrying if window was closed before server came up
    _win = null;
    // Back to menu-bar-only; tray + server keep running (D-06 baseline).
    if (process.platform === 'darwin') {
      app.setActivationPolicy('accessory');
    }
    // Collapse swap: show the popover only after the policy switch settles,
    // so the focus churn of closing can't blur-dismiss it.
    if (_collapseRequested) {
      _collapseRequested = false;
      setTimeout(() => _onCollapse?.(), 220);
    }
  });
}

/** Obsidian-style reopen: clicking the Dock icon or re-launching brain.app
 *  from Finder while the app is running opens (or focuses) the exploration
 *  window — the desktop icon is the front door to looking around. */
app.on('activate', () => {
  openMainWindow();
});
