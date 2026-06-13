/**
 * apps/tray/src/detail-window.ts
 *
 * ONE lazily-created, reused frameless BrowserWindow that shows node detail
 * adjacent to the compact popover (quick-260612-sdk). Clicking another node
 * updates the same window in place (loadURL with the new id) — never a
 * second window, never open/close churn.
 *
 * Security posture matches popover.ts:
 *   T-16-09: Electron 42 defaults preserved — contextIsolation, sandbox,
 *            and nodeIntegration are NOT overridden; preload stays empty (D-102).
 *   T-16-10: will-navigate locked to the loopback origin; new windows denied.
 *
 * Sentinel pathnames (exact comparison — '/__recense/detail-close'
 * prefix-matches '/__recense/detail', so startsWith is a bug here):
 *   /__recense/detail-close  → hide this window (Esc / drag-strip ×)
 *   /__recense/detail?id=x   → update in place (future in-window neighbor clicks)
 *
 * Exports: openDetailWindow, hideDetailWindow, getDetailWindow
 */
import { BrowserWindow, screen } from 'electron';
import { join } from 'path';

const DETAIL_WIDTH = 360;
const DETAIL_HEIGHT = 420;

const LOOPBACK = 'http://127.0.0.1:7810';

/** Module-level singleton — the one reusable detail window. */
let _detailWin: BrowserWindow | null = null;

/**
 * Drag strip injected on every load (adapted from popover.ts DRAG_STRIP_ADD):
 * a 26px -webkit-app-region:drag band with a grab pill and an × button
 * (top-left) that navigates to the close sentinel. #detail is marked no-drag
 * so scrolling and text selection inside the panel keep working. Injected
 * from the MAIN process via executeJavaScript — the preload stays empty
 * (D-102 zero IPC surface) and the served frontend stays browser-neutral.
 */
const DETAIL_STRIP_ADD = `(() => {
  if (document.getElementById('recense-detail-strip')) return;
  const strip = document.createElement('div');
  strip.id = 'recense-detail-strip';
  strip.style.cssText = 'position:fixed;top:0;left:0;right:0;height:26px;z-index:60;-webkit-app-region:drag;';
  const pill = document.createElement('div');
  pill.style.cssText = 'margin:7px auto 0;width:44px;height:5px;border-radius:3px;background:rgba(240,233,228,0.28);pointer-events:none;';
  strip.appendChild(pill);
  const x = document.createElement('div');
  x.textContent = '×';
  x.title = 'Close';
  x.style.cssText = 'position:absolute;top:6px;left:8px;width:26px;height:26px;'
    + 'display:flex;align-items:center;justify-content:center;border-radius:6px;'
    + 'cursor:pointer;color:#d9cbc0;background:rgba(26,18,32,0.7);'
    + 'font:15px ui-sans-serif,system-ui;opacity:0.65;-webkit-app-region:no-drag;user-select:none;';
  x.addEventListener('mouseenter', () => { x.style.opacity = '1'; });
  x.addEventListener('mouseleave', () => { x.style.opacity = '0.65'; });
  x.addEventListener('click', () => { location.href = '/__recense/detail-close'; });
  strip.appendChild(x);
  document.body.appendChild(strip);
  const detail = document.getElementById('detail');
  if (detail) detail.style.setProperty('-webkit-app-region', 'no-drag');
})();`;

/**
 * Place the detail window adjacent to the popover: right of it with an 8px
 * gap when the work area allows, else to the left; y aligned with the
 * popover top, clamped into the work area.
 */
function positionAdjacent(popover: BrowserWindow, win: BrowserWindow): void {
  const pb = popover.getBounds();
  const wa = screen.getDisplayMatching(pb).workArea;
  let x = pb.x + pb.width + 8;
  if (x + DETAIL_WIDTH > wa.x + wa.width) {
    x = pb.x - DETAIL_WIDTH - 8;
  }
  const y = Math.min(Math.max(pb.y, wa.y), wa.y + wa.height - DETAIL_HEIGHT);
  win.setPosition(Math.round(x), Math.round(y), false);
}

/** True when the window's bounds intersect no part of its display's work area. */
function isFullyOffscreen(win: BrowserWindow): boolean {
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  return (
    b.x + b.width <= wa.x ||
    b.x >= wa.x + wa.width ||
    b.y + b.height <= wa.y ||
    b.y >= wa.y + wa.height
  );
}

/** Create the detail window and wire its one-time handlers. */
function createDetailWindow(popover: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: DETAIL_WIDTH,
    height: DETAIL_HEIGHT,
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

  // Sentinel interception + T-16-10 loopback lock. EXACT pathname comparison:
  // '/__recense/detail-close' starts with '/__recense/detail' — never prefix-match.
  win.webContents.on('will-navigate', (event, url) => {
    let pathname: string;
    let id: string | null = null;
    try {
      const u = new URL(url);
      pathname = u.pathname;
      id = u.searchParams.get('id');
    } catch {
      event.preventDefault();
      return;
    }
    if (pathname === '/__recense/detail-close') {
      event.preventDefault();
      win.hide();
      return;
    }
    if (pathname === '/__recense/detail') {
      // Future-proofs in-window neighbor clicks: update in place.
      event.preventDefault();
      if (id) {
        win.loadURL(LOOPBACK + '/?detail=' + encodeURIComponent(id)).catch(() => {});
      }
      return;
    }
    if (!url.startsWith(LOOPBACK)) {
      event.preventDefault();
    }
  });

  // T-16-10: deny any new-window request from the renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Drag strip + close affordance on every (re)load.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(DETAIL_STRIP_ADD).catch(() => {});
  });

  // Hide on blur UNLESS focus went to the popover — deferred one tick because
  // the newly-focused window may not resolve synchronously inside blur.
  win.on('blur', () => {
    setTimeout(() => {
      if (win.isDestroyed()) return;
      const f = BrowserWindow.getFocusedWindow();
      if (f !== popover) win.hide();
    }, 0);
  });

  win.on('closed', () => {
    _detailWin = null;
  });

  return win;
}

/**
 * Open (or update in place) the adjacent detail window for `nodeId`.
 *
 * Positioning runs ONLY when the window was just created or is fully
 * offscreen — if the user moved it, their position is kept (founder
 * decision: update in place, one calm panel).
 *
 * showInactive(): show WITHOUT stealing focus so the popover does not
 * blur-dismiss on open.
 */
export function openDetailWindow(nodeId: string, popover: BrowserWindow): void {
  let created = false;
  if (!_detailWin || _detailWin.isDestroyed()) {
    _detailWin = createDetailWindow(popover);
    created = true;
  }
  const win = _detailWin;
  if (created || isFullyOffscreen(win)) {
    positionAdjacent(popover, win);
  }
  win.loadURL(LOOPBACK + '/?detail=' + encodeURIComponent(nodeId)).catch(() => {});
  win.showInactive();
}

/** Hide the detail window if it exists and is visible. */
export function hideDetailWindow(): void {
  if (_detailWin && !_detailWin.isDestroyed() && _detailWin.isVisible()) {
    _detailWin.hide();
  }
}

/** Return the detail window (null when never created or destroyed). */
export function getDetailWindow(): BrowserWindow | null {
  return _detailWin && !_detailWin.isDestroyed() ? _detailWin : null;
}
