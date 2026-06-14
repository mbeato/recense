/**
 * pin-node — re-exec the `brain` CLI under the pinned Node runtime (DX hardening).
 *
 * better-sqlite3 is a native addon ABI-locked to the Node that compiled it
 * (NODE_MODULE_VERSION). When a user's shell runs a different Node — common with nvm,
 * where the global default rarely matches the build Node — `brain` would crash with a
 * raw NODE_MODULE_VERSION stack trace. The launchd jobs already avoid this by exec'ing
 * under RECENSE_NODE_BIN (from the recense env file); this brings the same pin
 * to the interactive `brain` command, so it works in any terminal regardless of the
 * ambient Node — WITHOUT forcing the user to change their global nvm default.
 *
 * Security: parses ONLY the RECENSE_NODE_BIN line — it never sources the rest of the
 * env file (which holds API keys / tokens) into this process, unlike the launchd wrappers.
 *
 * The pure decision helpers (readPinnedNodeBin, shouldReexec) are exported for unit testing;
 * pinNodeRuntime is the thin imperative shell that performs the one-hop re-exec.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** Env var marking that a re-exec already happened — prevents an infinite loop. */
export const PIN_GUARD = 'RECENSE_NODE_PINNED';

export interface PinnedBinDeps {
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

/**
 * Resolve the pinned Node binary: an explicit RECENSE_NODE_BIN env value wins, else
 * parse it from the recense env file (the same file the launchd wrappers source).
 * Returns undefined when no pin is configured (e.g. a fresh clone before `recense init`).
 */
export function readPinnedNodeBin(
  envFilePath: string,
  envBin: string | undefined,
  deps: PinnedBinDeps = {},
): string | undefined {
  if (envBin && envBin.trim()) return envBin.trim();
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  if (!exists(envFilePath)) return undefined;
  for (const line of readFile(envFilePath).split('\n')) {
    const m = line.match(/^\s*RECENSE_NODE_BIN\s*=\s*(.+?)\s*$/);
    if (m) return m[1]!.replace(/^['"]|['"]$/g, '').trim() || undefined;
  }
  return undefined;
}

export interface ReexecDeps {
  exists?: (p: string) => boolean;
}

/**
 * Decide whether to re-exec. Returns the target bin, or null to keep the current runtime.
 * Skips when: already re-exec'd (guard), no pin configured, the pinned bin is missing on
 * disk, or this process is already running under the pinned bin.
 */
export function shouldReexec(
  pinnedBin: string | undefined,
  execPath: string,
  alreadyPinned: boolean,
  deps: ReexecDeps = {},
): string | null {
  if (alreadyPinned) return null;
  if (!pinnedBin) return null;
  const exists = deps.exists ?? existsSync;
  if (!exists(pinnedBin)) return null;
  if (resolve(pinnedBin) === resolve(execPath)) return null;
  return pinnedBin;
}

/**
 * Re-exec `brain` under the pinned Node if the current runtime differs (one-hop).
 * `entryPath` is the brain.js entry to re-run (pass the dispatcher's __filename).
 * No-op when already correct, when no pin is configured, or when the pinned bin is absent.
 */
export function pinNodeRuntime(entryPath: string): void {
  const envFilePath =
    process.env['RECENSE_SLEEP_ENV'] ??
    join(homedir(), '.config', 'recense', 'sleep.env');
  const pinnedBin = readPinnedNodeBin(envFilePath, process.env['RECENSE_NODE_BIN']);
  const target = shouldReexec(pinnedBin, process.execPath, process.env[PIN_GUARD] === '1');
  if (!target) return;
  const res = spawnSync(target, [entryPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [PIN_GUARD]: '1' },
  });
  process.exit(res.status ?? 1);
}
