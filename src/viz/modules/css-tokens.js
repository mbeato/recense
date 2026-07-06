/**
 * @module css-tokens
 * recense viz — HUD token emission (Phase 59 Plan 01, D-11/D-14).
 *
 * emitHudTokens() is the JS→CSS consumer of constants.js's single authored
 * HUD_CSS_TOKENS source — it mirrors src/viz/server.ts's parseSchedulerScalars
 * (which derives scheduler scalars from the same file via source-parse), but
 * via a native ESM import: no regex needed, HUD_CSS_TOKENS is already plain
 * JS. Building a `<style id="hud-tokens">` :root block at boot lets
 * styles.css reference var(--glass-*), var(--radius-*), var(--motion-*)
 * without ever re-declaring a token value as its own literal (D-10).
 */

import { HUD_CSS_TOKENS } from './constants.js';

/**
 * Inject a `:root { --key: value; ... }` block built from HUD_CSS_TOKENS
 * into document.head, guarded against double-injection.
 */
export function emitHudTokens() {
  if (document.getElementById('hud-tokens')) return;

  const body = Object.entries(HUD_CSS_TOKENS)
    .map(([key, value]) => `  --${key}: ${value};`)
    .join('\n');

  const style = document.createElement('style');
  style.id = 'hud-tokens';
  style.textContent = `:root {\n${body}\n}`;
  document.head.appendChild(style);
}
