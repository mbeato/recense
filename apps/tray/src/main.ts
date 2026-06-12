/**
 * apps/tray/src/main.ts — brain tray orchestrator.
 *
 * Wires server lifecycle (16-02), tray icon (16-03), and popover (16-04)
 * into a menu-bar-only Electron app.
 *
 * Design invariants:
 *   D-06: menu-bar-only — no Dock icon, no Cmd-Tab; Quit lives in tray context menu.
 *   D-07: attach to an already-running server on port 7810; else spawn on system node.
 *   D-08: openAtLogin default ON on first launch; toggle in tray context menu.
 *   D-96: stopServer() SIGTERMs the child on every quit path; the child's own exit
 *         handler restores viz_trace_enabled OFF — the tray never opens a second
 *         DB write handle for the flag.
 *   L-10: a missing brain.db shows a dialog and quits; no silent empty-DB spawn.
 *   D-12: macOS-only APIs (setActivationPolicy, getLoginItemSettings) are guarded
 *         by process.platform === 'darwin' so the type-check passes on Linux CI.
 *   T-16-12: 'requires-approval' login-item status opens System Settings immediately
 *            — never fail silently (macOS 13+ SMAppService caveat).
 */

import { appendFileSync } from 'fs';
import { app, Menu, dialog, shell } from 'electron';
import {
  ensureServer,
  stopServer,
  MissingDbError,
  MissingBrainJsError,
} from './server-lifecycle';
import type { ServerHandle } from './server-lifecycle';
import { initTrayIcon } from './tray-icon';
import type { TrayIconHandle } from './tray-icon';
import { createPopover, togglePopover, setPinned, isPinned } from './popover';
import { openMainWindow, setCollapseHandler } from './main-window';

// ---------------------------------------------------------------------------
// Logging (append-only — never stdout for a background app)
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/brain-memory-tray.log';

function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] main: ${msg}\n`);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// D-06: Accessory mode — menu-bar only, no Dock icon, no Cmd-Tab.
// Must be called before app.ready. Guarded by platform check (D-12).
// Belt-and-suspenders: LSUIElement: 1 is also set in electron-builder.yml.
// ---------------------------------------------------------------------------

if (process.platform === 'darwin' && typeof app.setActivationPolicy === 'function') {
  app.setActivationPolicy('accessory');
}

// ---------------------------------------------------------------------------
// Login-item helpers (D-08 / T-16-12)
// ---------------------------------------------------------------------------

/**
 * Set openAtLogin to true on first launch (status 'not-registered').
 * macOS only — on Linux getLoginItemSettings() is a no-op.
 */
function initLoginItem(): void {
  if (process.platform !== 'darwin') return;
  const settings = app.getLoginItemSettings();
  if (settings.status === 'not-registered') {
    app.setLoginItemSettings({ openAtLogin: true });
    checkRequiresApproval();
  }
}

/**
 * T-16-12: Surface a 'requires-approval' status by opening System Settings.
 * macOS 13+ SMAppService demands explicit user approval in Login Items.
 * Never fail silently — the user must approve for launch-at-login to work.
 */
function checkRequiresApproval(): void {
  const after = app.getLoginItemSettings();
  if (after.status === 'requires-approval') {
    log("openAtLogin requires-approval — opening System Settings (T-16-12)");
    shell
      .openExternal(
        'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
      )
      .catch(() => {
        // Best-effort: if the URL scheme fails, the user can approve manually.
      });
  }
}

// ---------------------------------------------------------------------------
// Context menu builder
// ---------------------------------------------------------------------------

/**
 * Build the tray right-click context menu.
 *
 * Rebuilt after each state change (Pin toggle, Launch-at-login toggle) so
 * the checkbox states stay in sync with the underlying flags.
 */
function buildMenu(
  popover: Electron.BrowserWindow,
  icon: TrayIconHandle,
): Electron.Menu {
  const loginOpen =
    process.platform === 'darwin'
      ? app.getLoginItemSettings().openAtLogin
      : false;

  return Menu.buildFromTemplate([
    {
      label: 'Open Brain Window',
      click() {
        // Promote: the window supersedes the popover — never both (founder, 2026-06-12)
        if (isPinned()) setPinned(popover, false);
        popover.hide();
        openMainWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Pin',
      type: 'checkbox',
      checked: isPinned(),
      click() {
        setPinned(popover, !isPinned());
        // No rebuild needed — the menu is built fresh on each right-click popup.
      },
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: loginOpen,
      enabled: process.platform === 'darwin',
      click() {
        if (process.platform !== 'darwin') return;
        const current = app.getLoginItemSettings().openAtLogin;
        app.setLoginItemSettings({ openAtLogin: !current });
        // T-16-12: when enabling, check whether approval is required
        if (!current) {
          checkRequiresApproval();
        }
        // No rebuild needed — the menu is built fresh on each right-click popup.
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click() {
        app.quit();
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app
  .whenReady()
  .then(async () => {
    log('app ready');

    // D-08: set openAtLogin default ON on first launch
    initLoginItem();

    // L-10: ensure viz server is running or can be spawned before creating
    // the popover/tray — a missing brain.db shows a dialog and quits cleanly.
    let handle: ServerHandle = { attached: false, child: null };

    // Temporary icon/popover references; assigned after ensureServer resolves.
    let icon!: TrayIconHandle;
    let popover!: Electron.BrowserWindow;

    try {
      handle = await ensureServer({
        onUnhealthy: () => {
          log('server unhealthy — dimming tray icon');
          icon?.setDim();
        },
        onHealthy: () => {
          log('server healthy after respawn — restoring tray icon');
          icon?.setRest();
        },
      });
    } catch (err) {
      if (err instanceof MissingDbError) {
        dialog.showErrorBox(
          'Recense',
          `DB not found at ${err.dbPath}\n\nRun \`brain init\` first to set up brain-memory.`,
        );
      } else if (err instanceof MissingBrainJsError) {
        dialog.showErrorBox('Recense', (err as Error).message);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        dialog.showErrorBox('Recense', `Failed to start viz server: ${msg}`);
      }
      app.quit();
      return;
    }

    log(`server ready (attached=${handle.attached})`);

    // -- Popover: frameless BrowserWindow that loads the Phase 15 frontend ----
    popover = createPopover();

    // -- Tray icon: SSE subscription + amber pulse + dim/rest state -----------
    // Left-click on the tray icon toggles the popover.
    // Use a two-step let + assignment to safely capture `icon` in the onClick
    // closure (the callback runs after `icon` is fully assigned — rule: never
    // call icon.tray synchronously inside initTrayIcon's constructor).
    icon = initTrayIcon({
      onClick() {
        togglePopover(icon.tray, popover);
      },
      // Right-click pops the menu, built fresh so checkbox states are current.
      // NEVER setContextMenu: on macOS it opens on left click too, double-firing
      // with the popover toggle (acceptance feedback 2026-06-12).
      onRightClick() {
        icon.tray.popUpContextMenu(buildMenu(popover, icon));
      },
    });

    // -- D-96: SIGTERM child on every quit path ------------------------------
    // stopServer() sets stopping=true (suppresses backoff respawn), clears
    // the backoff timer, and SIGTERMs the active child. The child's own
    // process.on('exit') handler restores viz_trace_enabled OFF (D-96).
    // Never open a second DB write handle for the flag here.
    app.on('before-quit', () => {
      log('before-quit: stopping server + disposing tray icon');
      stopServer(handle);
      icon.dispose();
    });

    // -- Menu-bar app must stay alive with no visible windows (D-06) ---------
    // Without this handler, Electron quits when the last BrowserWindow closes.
    app.on('window-all-closed', () => {
      // no-op — the tray lives in the menu bar, not in a window
    });

    // -- Collapse-to-tray = true swap: closing the Brain Window via its
    // collapse button surfaces the popover under the tray icon (founder:
    // window vanishing with nothing appearing read as "app closed").
    setCollapseHandler(() => {
      if (!popover.isVisible()) togglePopover(icon.tray, popover);
    });

    // -- Obsidian-style entry (founder, 2026-06-12) ---------------------------
    // An explicit user launch (Finder/Dock double-click) opens the exploration
    // window — the desktop icon is the front door to looking around. A
    // login-item launch stays ambient: tray only, no window at every boot.
    const openedAtLogin =
      process.platform === 'darwin' &&
      app.getLoginItemSettings().wasOpenedAtLogin;
    if (!openedAtLogin) {
      openMainWindow();
    }

    log('tray app fully initialized');
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`fatal boot error: ${msg}`);
    // Ensure a clean exit rather than leaving a zombie process
    app.quit();
  });
