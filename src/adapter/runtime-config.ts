/**
 * runtime-config — single source of truth for how brain hooks/CLIs discover
 * their DB path and runtime environment.
 *
 * Phase 9 CR-01 fix: `recense init` and the three Claude Code hooks previously
 * hard-coded THREE different default DB paths and only read RECENSE_DB from
 * the process env — which the shell Claude Code launches the hooks from does not
 * have. The result: a default `recense init` install silently operated the hooks on
 * an empty DB at the wrong path. The default path is now defined ONCE here,
 * `recense init` pins `--db <path>` into each settings.json hook command, and the
 * per-turn sleep pass inherits API keys from the configured env file (WR-04).
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * The one true default DB location.
 * MUST stay in sync across `recense init` and every hook/CLI — never re-derive it
 * inline. This is the value whose divergence caused CR-01.
 */
export function defaultDbPath(): string {
  return join(homedir(), '.config', 'recense', 'recense.db');
}

/** Default location of the env file written by `recense init` (chmod-600). */
export function sleepEnvPath(): string {
  return (
    process.env['RECENSE_SLEEP_ENV'] ??
    join(homedir(), '.config', 'recense', 'sleep.env')
  );
}

/**
 * Resolve the DB path for a hook/CLI invocation.
 * Precedence: `--db <path>` argv flag > RECENSE_DB env > defaultDbPath().
 *
 * Pinning `--db` into the settings.json hook commands (done by `recense init`)
 * makes the init-configured DB authoritative regardless of the env Claude Code
 * launches the hook process with.
 *
 * M-8: `opts.fallbackToDefault` controls the no-match case.
 *   - Omitted / true (default): returns `string` — falls back to `defaultDbPath()` when
 *     neither --db nor env is set. Correct for hooks (session-start, stop, doctor, viz)
 *     that must always resolve a path.
 *   - false: returns `string | undefined` — returns `undefined` when neither --db nor env
 *     is set. Writer CLIs (watcher, ingest, sleep-pass, seed, recall, snapshot) use this
 *     so they can `process.exit(0)` on a missing path instead of silently using the wrong DB.
 *
 * Overloads ensure callers without opts (or with fallbackToDefault=true) get `string` back.
 */
export function resolveDbPath(argv?: string[], opts?: { fallbackToDefault?: true }): string;
export function resolveDbPath(argv: string[], opts: { fallbackToDefault: false }): string | undefined;
export function resolveDbPath(
  argv: string[] = process.argv,
  opts: { fallbackToDefault?: boolean } = {},
): string | undefined {
  const i = argv.indexOf('--db');
  if (i !== -1 && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') {
    return argv[i + 1] as string;
  }
  const fromEnv = process.env['RECENSE_DB'];
  if (fromEnv !== undefined) return fromEnv;
  if (opts.fallbackToDefault !== false) return defaultDbPath();
  return undefined;
}

/**
 * Parse the configured env file (sleep.env) into a plain object.
 * Used to give spawned background work (the per-turn sleep pass) the API keys
 * that live in the env file but are absent from the hook's ambient env (WR-04).
 * Comment (`#`) and blank lines are skipped; split on the first `=` only.
 * Returns {} when the file does not exist or cannot be read.
 */
export function loadConfiguredEnv(
  envPath: string = sleepEnvPath(),
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq)] = t.slice(eq + 1);
    }
  } catch {
    return {};
  }
  return out;
}

/**
 * Resolve the dirty-sentinel path for on-write sleep-pass triggering (L8N-01).
 * Returns RECENSE_DIRTY_SENTINEL from process.env, or '' (disabled) if unset.
 *
 * The dispatcher's existing hydrateRuntimeEnv() populates this var from sleep.env for
 * hook processes (turn-capture, stop) before they build their config. The launchd
 * sleep-pass and ingest jobs source sleep.env directly via the wrapper script — so
 * all four writer paths see the same path that the launchd WatchPaths watcher watches.
 *
 * '' = disabled (no filesystem access) — safe default when the env var is absent,
 * which covers tests, embedded uses, and installs that haven't re-run setup-dogfood.sh.
 */
export function resolveDirtySentinelPath(): string {
  return process.env['RECENSE_DIRTY_SENTINEL'] ?? '';
}

/**
 * Resolve the list of enabled ingest sources from RECENSE_ENABLED_SOURCES.
 *
 * Preserves the default-off fail-safe (D-66/D-63): when the env var is absent
 * or empty, returns [] — no adapters are activated. Sources are only built when
 * explicitly listed here, keeping ingest a controlled opt-in per environment.
 *
 * Accepts an optional `env` param (defaulting to process.env) for testability so
 * tests need not mutate process.env — mirrors the style of resolveDirtySentinelPath().
 *
 * Usage in sleep.env: RECENSE_ENABLED_SOURCES=gmail,gcal
 */
export function resolveEnabledSources(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['RECENSE_ENABLED_SOURCES'];
  if (raw === undefined) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Resolve the list of configured Google accounts + their per-account Gmail query
 * from RECENSE_GOOGLE_ACCOUNTS / RECENSE_GMAIL_QUERY_<UPPER_ID> (EMAIL-02).
 *
 * Fail-safe posture mirrors resolveEnabledSources: never throws, absent/empty/
 * wholly-invalid input falls back to today's single-account default — hardcoded
 * here as `[{ id: 'default' }]` rather than importing DEFAULT_CONFIG (this module
 * sits on the hook load path and must keep importing only Node builtins). See
 * `DEFAULT_CONFIG.googleAccounts` in src/lib/config.ts, which must match this
 * fallback; tests/google-accounts-config.test.ts asserts they stay in sync.
 *
 * Id charset `/^[a-z][a-z0-9_]{0,31}$/` (shared with the onboarding flow, T-62-01):
 * lowercase-only so the uppercase env-key derivation is unambiguous, and excludes
 * commas/`=`/newlines so a crafted id cannot inject a second entry into the
 * comma-separated list or a bogus line into the env-file grammar. Non-conforming
 * ids are silently dropped (T-62-02), never thrown.
 *
 * Per-account query is read from RECENSE_GMAIL_QUERY_<UPPER_ID> and attached only
 * when its trimmed value is non-empty. That query bounds the account's INITIAL
 * BACKFILL ONLY (see the googleAccounts doc comment in src/lib/config.ts) —
 * incremental pulls via `users.history.list` accept no `q` and are unaffected.
 */
export function resolveGoogleAccounts(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ id: string; query?: string }> {
  const raw = env['RECENSE_GOOGLE_ACCOUNTS'];
  const idPattern = /^[a-z][a-z0-9_]{0,31}$/;
  const seen = new Set<string>();
  const ids: string[] = [];
  if (raw !== undefined) {
    for (const candidate of raw.split(',').map((s) => s.trim())) {
      if (candidate === '' || !idPattern.test(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      ids.push(candidate);
    }
  }
  if (ids.length === 0) return [{ id: 'default' }];
  return ids.map((id) => {
    const query = env[`RECENSE_GMAIL_QUERY_${id.toUpperCase()}`]?.trim();
    return query ? { id, query } : { id };
  });
}

/**
 * Hydrate process.env from the configured env file (sleep.env) for any key NOT already
 * set in the ambient environment, then return the keys it applied.
 *
 * The launchd jobs source sleep.env directly (`set -a; . sleep.env`), so they run with the
 * real DB path, API keys, and model config. Interactive `brain <cmd>` does NOT — its shell
 * lacks those vars, so it fell back to an empty default DB and missing keys. Calling this
 * once at dispatcher startup makes interactive `brain` resolve the SAME config the jobs do.
 *
 * Set-only-if-missing preserves precedence: an explicit shell env var or `--db <flag>` still
 * wins; the file only provides defaults. Secrets are read but only the absent ones are set.
 */
export function hydrateRuntimeEnv(envPath: string = sleepEnvPath()): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(loadConfiguredEnv(envPath))) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
