# brain tray app

Always-accessible menu-bar app that shows the brain-memory second brain without opening a browser. The tray icon pulses amber when real activation traces fire; the popover loads the Phase 15 3D viz frontend over loopback.

---

## Prerequisites

A working `brain init` install is required before running the tray app:

1. Clone and install brain-memory:
   ```sh
   git clone https://github.com/<owner>/brain-memory.git
   cd brain-memory
   npm install
   npm run init
   ```

2. Verify the install is healthy:
   ```sh
   brain doctor
   ```

   The tray app reads `BRAIN_MEMORY_NODE_BIN` and `BRAIN_MEMORY_SLEEP_JS` from
   `~/.config/brain-memory/sleep.env` (written by `brain init`). If `brain doctor`
   reports a missing DB or unconfigured keys, resolve those before opening the tray.

3. `brain.db` must exist at the configured path (`~/.config/brain-memory/brain.db`
   by default, or the `BRAIN_MEMORY_DB` env var). The tray app will show an error
   dialog and quit if the DB is absent.

---

## Build from source (one command)

```sh
cd apps/tray && npm install && npm run pack
```

This runs TypeScript compilation then `electron-builder --mac dir`, which produces
an **unsigned local `.app`** in:

```
apps/tray/dist-app/mac-arm64/Recense.app   # Apple Silicon (M1/M2/M3/M4)
apps/tray/dist-app/mac/Recense.app          # Intel (x86_64)
```

Open it directly:

```sh
open "$(find apps/tray/dist-app -name Recense.app -maxdepth 3 | head -1)"
```

The build is unsigned (no Apple Developer ID or notarization) — this is intentional.
You build it yourself from the clone, so no download-trust is needed.

---

## macOS Gatekeeper caveat (Assumption A5)

The locally-built `.app` is ad-hoc signed by electron-builder. On macOS Sequoia
15.x this normally runs without intervention, but Gatekeeper may still quarantine it
on first open if it was copied across volumes (e.g., dragged from a Downloads folder).

If you see "damaged or can't be opened":

```sh
xattr -d com.apple.quarantine "$(find apps/tray/dist-app -name Recense.app -maxdepth 3 | head -1)"
```

Alternatively: right-click the `.app` in Finder → Open → Open.

---

## Lifecycle

### Server attachment (D-07)

At launch the tray checks whether port 7810 is already bound. If `brain viz` is
running, the tray attaches to that server — no second server is spawned. If nothing
is on 7810, the tray spawns the viz server as a child process using the pinned system
node from `BRAIN_MEMORY_NODE_BIN`.

### Launch at login (D-08)

`openAtLogin` is set **ON by default** on first launch. A "Launch at login" checkbox
in the tray context menu lets you toggle it. On macOS 13+ (Ventura/Sonoma/Sequoia)
the first registration uses SMAppService and may require your approval in:

**System Settings → General → Login Items**

If approval is needed, the tray opens that pane automatically.

### Trace flag and quit (D-96)

The tray spawns the viz server with `brain viz --no-open` and SIGTERMs it on every
quit path (`before-quit`). The child's own exit handler restores `viz_trace_enabled`
to OFF. The tray never opens a second write handle to the DB for this flag.

---

## Linux: experimental / untested

The Electron `Tray` API is best-effort on Linux — behavior varies by desktop
environment (GTK tray, libappindicator, KDE). macOS-only APIs
(`setActivationPolicy`, `getLoginItemSettings`) are platform-guarded in `main.ts`
so `cd apps/tray && npm ci && npx tsc --noEmit` passes on Linux CI.

Running the tray app on Linux is not validated. Issues welcome.

---

## Tray context menu

| Item | Function |
|------|----------|
| Pin | Converts the popover to an always-on-top floating window (blur no longer hides it) |
| Launch at login | Toggle macOS login-item registration (D-08) |
| Quit | Quit the tray app (SIGTERMs the viz server child) |

Left-click on the tray icon opens/closes the popover anchored below the icon. The
popover loads the Phase 15 3D viz frontend at `http://127.0.0.1:7810` — the same
frontend `brain viz` serves in a browser.

---

## Deep links

- [README.md](../README.md) — main project quickstart and command reference
- [docs/evals.md](evals.md) — eval methodology and correctness numbers
