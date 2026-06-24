/**
 * apps/tray/src/popover.ts
 *
 * Frameless BrowserWindow that serves as the recense viz popover panel (D-04).
 * Loads the unchanged Phase 15 frontend at http://127.0.0.1:7810 (D-03/D-102).
 * Navigation is locked to the loopback origin (T-16-10).
 * Electron 42 security defaults are preserved — contextIsolation, sandbox,
 * and nodeIntegration are NOT overridden (T-16-09).
 *
 * Exports: createPopover, positionUnder, togglePopover, setPinned, isPinned
 */
import { BrowserWindow, Tray } from 'electron';
import { join } from 'path';
import { openMainWindow } from './main-window';
// No cycle: detail-window.ts imports nothing from popover.ts — the popover
// window is passed as an argument to openDetailWindow.
import { openDetailWindow, hideDetailWindow, getDetailWindow } from './detail-window';

/**
 * Sentinel URL for the injected expand button (promote popover → app window).
 * The popover page has NO IPC surface (D-102 empty preload), so the button
 * "commands" the main process by navigating here; the will-navigate guard
 * intercepts it as a command and prevents the navigation — the URL never
 * loads, and plain browsers never see the button (it is injected only in
 * the Electron context).
 */
const EXPAND_SENTINEL = 'http://127.0.0.1:7810/__recense/expand';

/** Sentinel for the pinned strip's close button: unpin + hide (back to ambient). */
const UNPIN_SENTINEL = 'http://127.0.0.1:7810/__recense/unpin-hide';

/** Sentinel for the unpinned popover's pin button: pin (promote to floating). */
const PIN_SENTINEL = 'http://127.0.0.1:7810/__recense/pin';

/** Injected expand affordance — top-right ↗, subtle, no-drag. */
const EXPAND_BTN_JS = `(() => {
  if (document.getElementById('recense-expand-btn')) return;
  const btn = document.createElement('div');
  btn.id = 'recense-expand-btn';
  btn.textContent = '\\u2197';
  btn.title = 'Open Brain Window';
  btn.style.cssText = 'position:fixed;top:6px;right:8px;z-index:70;width:26px;height:26px;'
    + 'display:flex;align-items:center;justify-content:center;border-radius:7px;cursor:pointer;'
    + 'color:#d9cbc0;background:rgba(26,18,32,0.7);'
    + 'font:15px ui-sans-serif,system-ui;opacity:0.65;-webkit-app-region:no-drag;user-select:none;';
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.65'; });
  btn.addEventListener('click', () => { location.href = '${EXPAND_SENTINEL}'; });
  document.body.appendChild(btn);
})();`;

/** Small square — glance surface sized so the brain fills the frame; the viz
 *  frontend switches to compact mode (discrete legend, tighter camera) ≤500px. */
const WIN_WIDTH = 300;
const WIN_HEIGHT = 300;

/** Module-level pin state. Accessed only through isPinned() / setPinned(). */
let _pinned = false;

/** Blur-dismiss grace: ignore blur briefly after show — macOS focus churn
 *  (e.g. activation-policy switches during a window→tray swap) fires a
 *  spurious blur right after the popover appears. */
let _blurGraceUntil = 0;

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
  // ?shell=1 marks the shell context for the viz (detail.js shellCompact):
  // the server strips query strings before routing, so it still serves
  // index.html unchanged.
  win.loadURL('http://127.0.0.1:7810/?shell=1').catch(() => {});

  // did-fail-load: bounded backoff retry until the viz server binds port 7810.
  // Addresses the cold-start race: the spawned node child has not yet bound the
  // port when the first loadURL fires, so loadURL fails and stays blank forever
  // (Electron does not auto-retry). 30 × 2.5 s ≈ 75 s max; clears on success.
  let _loadRetries = 0;
  const LOAD_MAX_RETRIES = 30;
  const LOAD_RETRY_MS = 2_500;
  let _loadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const clearLoadRetry = () => {
    if (_loadRetryTimer !== null) { clearTimeout(_loadRetryTimer); _loadRetryTimer = null; }
    _loadRetries = 0;
  };
  win.webContents.on('did-fail-load', (_ev, errorCode) => {
    if (errorCode === -3) return; // ERR_ABORTED — user navigation, not server down
    if (_loadRetryTimer !== null || _loadRetries >= LOAD_MAX_RETRIES) return;
    _loadRetryTimer = setTimeout(() => {
      _loadRetryTimer = null;
      _loadRetries++;
      win.loadURL('http://127.0.0.1:7810/?shell=1').catch(() => {});
    }, LOAD_RETRY_MS);
  });

  // T-16-10: abort any navigation that leaves the loopback origin.
  // The expand sentinel is intercepted FIRST as a command (promote popover
  // → app window); it is prevented like any other navigation, so the page
  // never actually leaves the viz URL.
  win.webContents.on('will-navigate', (event, url) => {
    // Detail sentinel — MUST be intercepted BEFORE the generic loopback check
    // (it starts with the loopback prefix, so the generic branch would let it
    // through and the page would actually navigate to a 404). EXACT pathname
    // comparison: '/__recense/detail-close' prefix-matches '/__recense/detail',
    // so startsWith is a bug here.
    try {
      const u = new URL(url);
      if (u.pathname === '/__recense/detail') {
        event.preventDefault();
        const id = u.searchParams.get('id');
        if (id) openDetailWindow(id, win);
        return;
      }
    } catch {
      // unparseable URL — fall through to the generic guards below
    }
    if (url.startsWith(UNPIN_SENTINEL)) {
      event.preventDefault();
      setPinned(win, false); // removes the strip; restores the pin button
      win.hide();            // back to ambient; tray icon remains
      return;
    }
    if (url.startsWith(PIN_SENTINEL)) {
      event.preventDefault();
      setPinned(win, true); // swaps the pin button for the drag strip + × close
      return;               // stay visible — pinning promotes to a floating surface
    }
    if (url.startsWith(EXPAND_SENTINEL)) {
      event.preventDefault();
      if (_pinned) setPinned(win, false); // also removes the drag strip
      win.hide();
      openMainWindow();
      return;
    }
    if (!url.startsWith('http://127.0.0.1:7810')) {
      event.preventDefault();
    }
  });

  // T-16-10: deny any new-window request from the renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Inject the expand affordance whenever the page (re)loads — and restore
  // the drag strip if we are pinned (a reload, or a pin issued before the
  // page was ready, would otherwise silently lose it).
  win.webContents.on('did-finish-load', () => {
    clearLoadRetry(); // cancel any pending retry — load succeeded
    win.webContents.executeJavaScript(EXPAND_BTN_JS).catch(() => {});
    // Restore the top-left affordance for the current pin state: the drag strip
    // (with × close) when pinned, otherwise the pin button in the same spot. A
    // reload would otherwise drop whichever one was injected.
    win.webContents.executeJavaScript(_pinned ? DRAG_STRIP_ADD : PIN_BTN_ADD).catch(() => {});
  });

  // D-04: blur-dismiss — hide the popover on loss of focus unless pinned.
  // Pinned windows survive blur and remain as an always-on-top floating surface.
  // The hide decision is deferred one tick: when focus moved to the detail
  // window the popover must NOT hide (getFocusedWindow does not resolve the
  // new focus synchronously inside the blur event).
  win.on('blur', () => {
    if (Date.now() < _blurGraceUntil) return;
    if (_pinned) return;
    setTimeout(() => {
      if (win.isDestroyed()) return;
      const f = BrowserWindow.getFocusedWindow();
      if (f !== null && f === getDetailWindow()) return;
      win.hide();
    }, 0);
  });

  // Every popover-hide path (blur, togglePopover, unpin sentinel, expand
  // sentinel, collapse handler) also hides the detail window — one hook
  // covers them all; main.ts needs no changes.
  win.on('hide', () => hideDetailWindow());

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
    _blurGraceUntil = Date.now() + 800;
    win.show();
    win.focus();
  }
}

/**
 * Drag strip injected while pinned (founder request, 2026-06-12): a pinned
 * floating window should be movable away from the tray anchor (mid-screen
 * tray icons drop it over content). Injected from the MAIN process via
 * executeJavaScript — the preload stays empty (D-102 zero IPC surface) and
 * the served frontend stays browser-neutral. The strip is a 26px
 * -webkit-app-region:drag band at the top with a subtle grab pill; #panel
 * is marked no-drag so the SSE dot stays interactive. Unpin removes it,
 * and the next unpinned open re-anchors via positionUnder().
 */
const DRAG_STRIP_ADD = `(() => {
  if (document.getElementById('recense-drag-strip')) return;
  const strip = document.createElement('div');
  strip.id = 'recense-drag-strip';
  strip.style.cssText = 'position:fixed;top:0;left:0;right:0;height:26px;z-index:60;-webkit-app-region:drag;';
  const pill = document.createElement('div');
  pill.style.cssText = 'margin:7px auto 0;width:44px;height:5px;border-radius:3px;background:rgba(240,233,228,0.28);pointer-events:none;';
  strip.appendChild(pill);
  const x = document.createElement('div');
  x.textContent = '\u00d7';
  x.title = 'Close (back to menu bar)';
  x.style.cssText = 'position:absolute;top:6px;left:8px;width:26px;height:26px;'
    + 'display:flex;align-items:center;justify-content:center;border-radius:6px;'
    + 'cursor:pointer;color:#d9cbc0;background:rgba(26,18,32,0.7);'
    + 'font:15px ui-sans-serif,system-ui;opacity:0.65;-webkit-app-region:no-drag;user-select:none;';
  x.addEventListener('mouseenter', () => { x.style.opacity = '1'; });
  x.addEventListener('mouseleave', () => { x.style.opacity = '0.65'; });
  x.addEventListener('click', () => { location.href = '${UNPIN_SENTINEL}'; });
  strip.appendChild(x);
  document.body.appendChild(strip);
  // Reparent the expand affordance INTO the strip as a no-drag child: its
  // top half overlaps the 26px drag band, and a no-drag *sibling* does not
  // reliably carve out of an app-region:drag region (only nested no-drag
  // children do — the × close proves the pattern). position:fixed keeps its
  // screen coords unchanged. (Recenter sits at top:38, below the strip.)
  const ex = document.getElementById('recense-expand-btn');
  if (ex) strip.appendChild(ex);
  const panel = document.getElementById('panel');
  if (panel) panel.style.setProperty('-webkit-app-region', 'no-drag');
})();`;
// Rescue the reparented expand button back to <body> before removing the strip,
// so unpinning never destroys it.
const DRAG_STRIP_REMOVE = `(() => {
  const ex = document.getElementById('recense-expand-btn');
  if (ex) document.body.appendChild(ex);
  document.getElementById('recense-drag-strip')?.remove();
})();`;

/**
 * Pin button injected while UNPINNED (founder request): the unpinned popover shows a
 * pin icon in the SAME top-left slot the × close occupies when pinned (top:6px,left:8px,
 * 26×26) — they are mutually exclusive, so the corner reads as a single toggle. Clicking
 * it navigates to PIN_SENTINEL; the will-navigate guard intercepts that and pins the
 * window (setPinned(win,true) then swaps in the drag strip + × and removes this button).
 * Mirrors the × styling (muted glyph in a translucent rounded square), but uses a
 * monochrome SVG pushpin so it inherits the muted color instead of rendering as a
 * colored emoji. No-drag so the click always lands on the button.
 */
const PIN_BTN_ADD = `(() => {
  if (document.getElementById('recense-pin-btn')) return;
  const btn = document.createElement('div');
  btn.id = 'recense-pin-btn';
  btn.title = 'Pin (keep floating on top)';
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
  btn.style.cssText = 'position:fixed;top:6px;left:8px;z-index:70;width:26px;height:26px;'
    + 'display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;'
    + 'color:#d9cbc0;background:rgba(26,18,32,0.7);'
    + 'opacity:0.65;-webkit-app-region:no-drag;user-select:none;';
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.65'; });
  btn.addEventListener('click', () => { location.href = '${PIN_SENTINEL}'; });
  document.body.appendChild(btn);
})();`;
const PIN_BTN_REMOVE = `(() => {
  document.getElementById('recense-pin-btn')?.remove();
})();`;

/**
 * Set the pin state.
 *
 * Pinned → window becomes always-on-top; blur no longer hides it; a drag
 *   strip appears along the top edge (with the × close at top-left) so the
 *   window can be moved off the tray anchor. Promotes the popover to an
 *   all-day ambient floating window (D-04). The unpinned pin button is removed.
 * Unpinned → reverts to blur-dismiss behavior; drag strip removed; the pin
 *   button is restored in the same top-left slot; stays visible until next
 *   blur and re-anchors under the tray on next open.
 */
export function setPinned(win: BrowserWindow, pinned: boolean): void {
  _pinned = pinned;
  win.setAlwaysOnTop(pinned);
  // Swap the top-left affordance to match the new state — the two are mutually
  // exclusive in the same slot: pinned shows the drag strip + × (and removes the
  // pin button); unpinned removes the strip and restores the pin button. Both
  // snippets are self-contained IIFEs, so concatenating them runs as one atomic
  // executeJavaScript call (no flicker between the remove and add).
  const apply = () =>
    win.webContents.executeJavaScript(
      pinned ? DRAG_STRIP_ADD + PIN_BTN_REMOVE : DRAG_STRIP_REMOVE + PIN_BTN_ADD,
    );
  apply().catch(() => {
    // Page may still be loading — retry once; did-finish-load also restores.
    setTimeout(() => { apply().catch(() => {}); }, 400);
  });
}

/**
 * Return the current pin state.
 */
export function isPinned(): boolean {
  return _pinned;
}
