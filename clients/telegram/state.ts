import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Atomically write the Telegram poll cursor to a JSON state file.
 *
 * Uses tmp→rename for atomicity (WR-01: tmp file lives in the destination dir to avoid
 * cross-filesystem EXDEV on Linux). File permissions are set to 0600 (owner-only) both
 * in writeFileSync and via an explicit chmodSync (belt-and-suspenders against umask).
 *
 * Cursor is `null` on cold start (no persisted value), a numeric string update_id after
 * the first successful poll.
 */
export function writeStateCursor(statePath: string, cursor: string | null): void {
  mkdirSync(dirname(statePath), { recursive: true });
  // WR-01: tmp file in destination dir — rename(2) is not atomic across filesystems
  // and throws EXDEV when /tmp (tmpfs on Linux) and $HOME are on different mounts.
  const tmp = join(dirname(statePath), `.telegram-state-${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ cursor }), { mode: 0o600 });
  chmodSync(tmp, 0o600); // belt-and-suspenders (umask may limit mode in writeFileSync)
  renameSync(tmp, statePath);
}

/**
 * Read the Telegram poll cursor from the JSON state file.
 *
 * Returns null when: the file does not exist, the JSON is malformed, the `cursor` field is
 * not a string, or any other read error occurs. Unreadable state → cold start (safe
 * direction, D-09). Never throws.
 */
export function readStateCursor(statePath: string): string | null {
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { cursor?: unknown };
    return typeof parsed.cursor === 'string' ? parsed.cursor : null;
  } catch {
    return null; // unreadable state → cold start (safe direction, D-09)
  }
}
