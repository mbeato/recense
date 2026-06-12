/**
 * brain tray — Electron entry stub (rewritten in 16-05).
 *
 * This stub exists solely so `tsc --noEmit` has a valid entry point during
 * the scaffold phase. The full tray implementation (system-tray icon, viz
 * server spawn, SSE subscription) is implemented in plan 16-05.
 *
 * Design invariants carried from brain-viz-cli.ts:
 *   D-96: trace flag must be restored OFF on all exit paths (child process owns
 *         this via its own exit handlers; tray SIGTERMs the child on before-quit).
 *   ABI: never use process.execPath as node bin (that is the Electron binary);
 *         resolve via BRAIN_MEMORY_NODE_BIN or sleep.env instead (pin-node pattern).
 */
import { app } from 'electron';

// Tray app hides from the Dock — it lives in the menu bar only.
// setActivationPolicy is macOS-only; on Linux/Windows this is a no-op.
if (typeof app.setActivationPolicy === 'function') {
  app.setActivationPolicy('accessory');
}

app.whenReady().then(() => {
  // Full implementation in plan 16-05.
  // Stub intentionally left empty — tray window and server spawn added there.
}).catch(() => {
  // best-effort — not thrown at the process level
});
