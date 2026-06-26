/**
 * Single reader for ~/.claude/settings.json env.ANTHROPIC_API_KEY presence.
 *
 * Consumed by:
 *   - recense-init acknowledge gate (D-07, Plan 45-05)
 *   - recense-doctor billing dimension (D-12, Plan 45-06)
 *
 * Presence-only: the function returns a boolean and NEVER returns, logs,
 * console.*, or otherwise emits the ANTHROPIC_API_KEY value (T-45-01).
 *
 * Never throws: existsSync guard + try/catch covers all four inputs —
 * key-present, key-absent, missing-file, and malformed-JSON (T-45-02).
 *
 * Note: targets ~/.claude/settings.json (Claude Code's own settings), NOT
 * the recense settings at ~/.config/recense/settings.json. Do not reuse
 * settings-loader.ts (defaultSettingsPath / loadSettingsFile) — they point
 * to the wrong file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Default path to the Claude Code settings file.
 */
function defaultClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/**
 * Reports whether ANTHROPIC_API_KEY is set and non-empty in the Claude Code
 * ~/.claude/settings.json env block.
 *
 * @param settingsPath - Override path for testing. Defaults to ~/.claude/settings.json.
 * @returns true if ANTHROPIC_API_KEY is a non-empty string in settings.env; false otherwise.
 *
 * Never throws — all four inputs (key-present, key-absent, missing-file, malformed-JSON)
 * return a boolean cleanly (T-45-02).
 */
export function settingsHasAnthropicKey(
  settingsPath: string = defaultClaudeSettingsPath(),
): boolean {
  // Guard: file must exist
  if (!existsSync(settingsPath)) return false;

  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    // Defensive level-by-level narrowing — the file is user-owned and arbitrary
    if (typeof parsed !== 'object' || parsed === null) return false;

    const obj = parsed as Record<string, unknown>;
    const env = obj['env'];

    if (typeof env !== 'object' || env === null) return false;

    const envObj = env as Record<string, unknown>;
    const key = envObj['ANTHROPIC_API_KEY'];

    // Non-empty string required (D-14 "set & non-empty"); T-45-01: only check presence
    return typeof key === 'string' && key.length > 0;
  } catch {
    return false;
  }
}
