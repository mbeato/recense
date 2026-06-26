#!/usr/bin/env node
/**
 * recense doctor — 8-dimension install health audit (INSTALL-04; dimensions 7-8 added in Phase 45).
 *
 * Checks eight fixed dimensions and prints a human-readable pass/fail per
 * dimension. Exits non-zero if any dimension fails. `--json` is deferred
 * to INSTALL-07.
 *
 * Dimensions (INSTALL-04; 8 from Phase 45):
 *   1. DB reachability + schema version
 *   2. API key validity via live calls (Anthropic + OpenAI)
 *   3. Scheduler registered + running
 *   4. Hooks wired in ~/.claude/settings.json
 *   5. Node ABI match (RECENSE_NODE_BIN vs better-sqlite3 build)
 *   6. Serve token presence + env file mode (RECENSE_SERVE_TOKEN in chmod-600 sleep.env)
 *   7. Billing posture (subscription + ANTHROPIC_API_KEY in settings.json = footgun; D-12)
 *   8. claude CLI present + logged in via non-billed auth probe (D-13)
 *
 * Design invariants:
 *  - DB opened readonly only — never writes the graph (T-09-10).
 *  - API key values are never written to stdout (T-09-09).
 *  - Failures aggregated; process.exitCode set at the end (CR-02: no
 *    process.exit() inside try/finally).
 *  - RECENSE_NODE_BIN used for ABI check (not process.execPath).
 *  - checkBillingPosture is READ-ONLY — never writes ~/.claude/settings.json (T-45-05).
 *
 * Threat mitigations:
 *  - T-09-09: live-key check reports valid/invalid only; never echoes key bytes.
 *  - T-09-10: DB opened { readonly: true }; never writes.
 *  - T-09-11: failure aggregation → non-zero exit; asserted in test.
 *  - T-45-01: checkBillingPosture reports key presence only; never emits key value.
 *  - T-45-05: checkBillingPosture never writes settings.json (detect + warn only).
 *  - T-45-06: checkClaudeCli uses `claude auth status --json` (non-billed); never `claude -p`.
 */

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SCHEMA_VERSION } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { resolveExistingEnv } from './recense-init';
import { loadConfiguredEnv, resolveDbPath, sleepEnvPath } from './runtime-config';
import { settingsHasAnthropicKey } from './claude-settings-detector';

// ── Check result type ─────────────────────────────────────────────────────────

export interface CheckResult {
  ok: boolean;
  detail: string;
}

function pass(detail: string): CheckResult { return { ok: true,  detail }; }
function fail(detail: string): CheckResult { return { ok: false, detail }; }

// ── Shared provider resolution (D-11 + D-12 single source of truth) ──────────

/**
 * Resolve the active model provider from the configured env file (sleep.env).
 * Reads RECENSE_MODEL_PROVIDER; falls back to DEFAULT_CONFIG.modelProvider.
 * Treats 'claude-headless' as subscription mode.
 *
 * @param envPath - Override sleep.env path for testing (mirrors checkServeToken convention).
 */
export function resolveActiveProvider(envPath: string = sleepEnvPath()): string {
  const env = loadConfiguredEnv(envPath);
  return env['RECENSE_MODEL_PROVIDER'] ?? DEFAULT_CONFIG.modelProvider;
}

// ── Dimension 1: DB reachability + schema version ─────────────────────────────

/**
 * Open RECENSE_DB read-only, read meta.schema_version, compare to
 * the imported SCHEMA_VERSION constant.
 *
 * T-09-10: { readonly: true } prevents any accidental write.
 *
 * @exported — used by tests to exercise schema-pass/mismatch without live API.
 */
export function checkDb(dbPath: string): CheckResult {
  if (!dbPath) {
    return fail('RECENSE_DB not set — run `recense init`');
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    db.close();
    const v = row?.value;
    if (v !== String(SCHEMA_VERSION)) {
      return fail(`schema version mismatch: got ${v ?? '(none)'}, want ${SCHEMA_VERSION} — run \`recense init\``);
    }
    return pass(`DB at ${dbPath} — schema v${v}`);
  } catch (e) {
    return fail(`DB not reachable: ${e}`);
  }
}

// ── Dimension 2: API key validity (live calls) ────────────────────────────────

/**
 * Perform minimal live calls to validate both API keys.
 * T-09-09: reports valid/invalid only; key bytes are never written to stdout.
 *
 * D-11: under subscription mode ('claude-headless') a missing ANTHROPIC_API_KEY is
 * expected — emits a pass-style note and does NOT mark anyFail.
 *
 * @param envPath - Override sleep.env path for testing, so the no-false-failure
 *   test can point at a temp env file with RECENSE_MODEL_PROVIDER=claude-headless.
 *   Mirrors the checkServeToken / checkHooks override-path convention.
 * @exported — exported for type reference; live calls mean tests mock/skip it.
 */
export async function checkApiKeys(envPath: string = sleepEnvPath()): Promise<CheckResult> {
  const provider      = resolveActiveProvider(envPath);
  const isSubscription = provider === 'claude-headless';
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const openaiKey    = process.env['OPENAI_API_KEY'];
  const results: string[] = [];
  let anyFail = false;

  // ── Anthropic ──────────────────────────────────────────────────────────────
  if (!anthropicKey) {
    if (isSubscription) {
      // D-11: missing Anthropic key is expected under subscription — not a failure.
      results.push('subscription mode (Anthropic API key not needed)');
    } else {
      results.push('ANTHROPIC missing');
      anyFail = true;
    }
  } else {
    try {
      const { default: Anthropic } = require('@anthropic-ai/sdk') as typeof import('@anthropic-ai/sdk');
      // T-09-09: apiKey not logged; client construction is opaque
      const client = new Anthropic({ apiKey: anthropicKey });
      await client.messages.create({
        model: DEFAULT_CONFIG.anthropicModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      results.push('ANTHROPIC valid');
    } catch (e: unknown) {
      const msg = String(e);
      if (msg.includes('401') || msg.toLowerCase().includes('auth') || msg.includes('Authentication')) {
        results.push('ANTHROPIC invalid key');
      } else {
        results.push(`ANTHROPIC error: ${msg.slice(0, 100)}`);
      }
      anyFail = true;
    }
  }

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  if (!openaiKey) {
    results.push('OPENAI missing');
    anyFail = true;
  } else {
    try {
      const { default: OpenAI } = require('openai') as typeof import('openai');
      // T-09-09: apiKey not logged; client construction is opaque
      const client = new OpenAI({ apiKey: openaiKey });
      await client.embeddings.create({ model: DEFAULT_CONFIG.openaiEmbedModel, input: 'hi' });
      results.push('OPENAI valid');
    } catch (e: unknown) {
      const msg = String(e);
      if (msg.includes('401') || msg.toLowerCase().includes('auth') || msg.includes('Incorrect API key')) {
        results.push('OPENAI invalid key');
      } else {
        results.push(`OPENAI error: ${msg.slice(0, 100)}`);
      }
      anyFail = true;
    }
  }

  const detail = results.join(', ');
  return anyFail ? fail(detail) : pass(detail);
}

// ── Dimension 3: Scheduler registered + running ───────────────────────────────

/**
 * macOS: checks launchctl for com.recense.sleep-pass.
 * Linux: pgrep-based liveness (informational — not a hard fail per D-92).
 *
 * @exported — used by tests; platform-specific branches make it deterministic
 *             in CI without mocking.
 */
export function checkScheduler(): CheckResult {
  if (process.platform === 'darwin') {
    const result = spawnSync(
      'launchctl',
      ['list', 'com.recense.sleep-pass'],
      { stdio: 'pipe' },
    );
    if (result.status === 0) {
      return pass('com.recense.sleep-pass registered (macOS launchd)');
    }
    return fail('com.recense.sleep-pass not registered — run `recense scheduler install`');
  }
  // Linux: foreground process only (D-92 honesty principle).
  // WR-04: tolerate the compiled entry point — the systemd unit runs
  // `node .../recense.js scheduler run`, so the pattern must match both the npm bin
  // shim (`recense scheduler run`) and the direct invocation (`recense.js scheduler run`).
  const result = spawnSync('pgrep', ['-f', '(brain|recense)(\\.js)? scheduler run'], { stdio: 'pipe' });
  if (result.status === 0) {
    return pass('recense scheduler run process detected');
  }
  // Not running is informational on Linux (D-92) — not a hard failure
  return pass('scheduler: not running (start with `recense scheduler run`; for reboot-survival on Linux install the brain-scheduler systemd unit — see docs/server-mode.md)');
}

// ── Dimension 4: Hooks wired in settings.json ─────────────────────────────────

/**
 * Reads ~/.claude/settings.json and checks SessionStart, UserPromptSubmit,
 * and Stop each have a recense hook entry (new `brain ... hook` form OR the
 * pre-migration `recense/dist/src/adapter/` path).
 *
 * @param settingsOverridePath — override the default path for testing.
 * @exported — used by tests to verify hook detection without modifying the
 *             real settings.json.
 */
export function checkHooks(settingsOverridePath?: string): CheckResult {
  const settingsPath = settingsOverridePath ?? join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return fail('~/.claude/settings.json not found — run `recense init`');
  }
  let settings: Record<string, unknown>;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return fail(`settings.json parse error: ${e}`);
  }

  const hooks = settings['hooks'] as Record<string, unknown> | undefined;
  if (!hooks) {
    return fail('no hooks section in settings.json — run `recense init`');
  }

  const events = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;
  const missing: string[] = [];

  for (const event of events) {
    const groups = hooks[event] as Array<{ hooks?: Array<{ command?: string }> }> | undefined;
    const hasBrainHook = groups?.some(group =>
      group.hooks?.some(h => {
        const cmd = h.command ?? '';
        // New-style: command contains 'recense' (or legacy 'brain') AND 'hook'.
        // Pre-migration: command contains the old dist path.
        return ((cmd.includes('recense') || cmd.includes('brain')) && cmd.includes('hook')) ||
               cmd.includes('recense/dist/src/adapter/');
      }),
    );
    if (!hasBrainHook) missing.push(event);
  }

  if (missing.length > 0) {
    return fail(`hooks not wired for: ${missing.join(', ')} — run \`recense init\``);
  }
  return pass('SessionStart, UserPromptSubmit, Stop wired');
}

// ── Dimension 5: Node ABI match ───────────────────────────────────────────────

/**
 * Spawn RECENSE_NODE_BIN and require better-sqlite3.
 * Non-zero exit or NODE_MODULE_VERSION in stderr = ABI mismatch.
 *
 * @exported — used by tests to assert fail behavior when RECENSE_NODE_BIN
 *             is unset, without requiring a live node binary.
 */
export function checkNodeAbi(): CheckResult {
  const nodeBin = process.env['RECENSE_NODE_BIN'];
  if (!nodeBin) {
    return fail('RECENSE_NODE_BIN not set — run `recense init`');
  }
  // IN-04: print the SPAWNED binary's NODE_MODULE_VERSION before loading the addon.
  // Reporting process.versions.modules here would show the doctor process's NMV —
  // misleading exactly when the two binaries differ (the scenario this check exists for).
  const result = spawnSync(
    nodeBin,
    ['-e', "process.stdout.write(String(process.versions.modules)); require('better-sqlite3')"],
    { stdio: 'pipe' },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? '');
    if (stderr.includes('NODE_MODULE_VERSION')) {
      return fail('ABI mismatch — re-run `recense init` to recapture node binary');
    }
    return fail(`better-sqlite3 load error: ${stderr.slice(0, 200)}`);
  }
  const nmv = (result.stdout?.toString() ?? '').trim();
  return pass(`Node ABI match: NMV=${nmv}, bin=${nodeBin}`);
}

// ── Dimension 6: Serve token presence + env file mode ────────────────────────

/**
 * Check whether RECENSE_SERVE_TOKEN is set in sleep.env and that the env file
 * is chmod-600.
 *
 * Three outcomes:
 *  - env file absent → pass (token only needed when running `recense serve`)
 *  - env file present, mode != 0600 → fail with the actual mode and hint
 *  - env file present, 0600, no RECENSE_SERVE_TOKEN → pass (will generate on first serve)
 *  - env file present, 0600, RECENSE_SERVE_TOKEN set → pass
 *
 * T-12-10: the token VALUE is NEVER written to stdout; detail reports presence only.
 *
 * @param envPath — override sleep.env path for testing.
 * @exported — used by tests to exercise all branches without touching real env file.
 */
export function checkServeToken(envPath: string = sleepEnvPath()): CheckResult {
  if (!existsSync(envPath)) {
    return pass('RECENSE_SERVE_TOKEN not set (no serve token needed unless running `recense serve`)');
  }
  try {
    const { mode } = statSync(envPath);
    // eslint-disable-next-line no-bitwise
    if ((mode & 0o777) !== 0o600) {
      return fail(`env file mode is ${(mode & 0o777).toString(8)}, want 0600 — run \`recense init\``);
    }
  } catch (e) {
    return fail(`cannot stat env file: ${e}`);
  }
  const env = resolveExistingEnv(envPath);
  const token = env.get('RECENSE_SERVE_TOKEN');
  if (!token) {
    return pass('RECENSE_SERVE_TOKEN not set (will generate on first `recense serve` run)');
  }
  // T-12-10: report presence only — token value is never included in the detail string.
  return pass('RECENSE_SERVE_TOKEN set, env file mode 0600');
}

// ── Dimension 7: Billing posture (D-12) ──────────────────────────────────────

/**
 * Detect the ANTHROPIC_API_KEY-in-settings.json footgun under subscription mode.
 *
 * When recense runs via `claude -p` (subscription / claude-headless provider), an
 * ANTHROPIC_API_KEY in ~/.claude/settings.json `env` block causes Claude Code to
 * inject it into every subprocess — including the headless claude invocations — which
 * routes those calls to the direct API and incurs per-token billing even though the
 * user chose subscription mode.
 *
 * Outcomes:
 *  - subscription AND key present in settings.json → fail (footgun message with fix hint)
 *  - subscription AND key absent → pass (no footgun)
 *  - direct-API mode → pass (key is expected; different billing path)
 *
 * SCOPE FENCE (T-45-05): this function is READ-ONLY. It NEVER writes to
 * ~/.claude/settings.json. It detects and warns only.
 *
 * T-45-01: detail string reports key PRESENCE only; never emits the key value.
 *
 * @param settingsOverridePath - Override ~/.claude/settings.json path for testing
 *   (mirrors checkHooks convention).
 * @param envPath - Override sleep.env path for testing (mirrors checkServeToken convention).
 * @exported — used by tests with temp settings.json and temp env files.
 */
export function checkBillingPosture(
  settingsOverridePath?: string,
  envPath: string = sleepEnvPath(),
): CheckResult {
  const provider = resolveActiveProvider(envPath);
  const isSubscription = provider === 'claude-headless';

  // T-45-01: settingsHasAnthropicKey returns boolean only; key value never surfaces here.
  const keyPresent = settingsHasAnthropicKey(settingsOverridePath);

  if (isSubscription && keyPresent) {
    // T-45-05: report the footgun and the fix; do NOT edit the file.
    return fail(
      'ANTHROPIC_API_KEY in ~/.claude/settings.json will bill direct API even on subscription' +
      ' — remove it from the env block',
    );
  }

  if (isSubscription) {
    return pass('subscription billing, no direct-API key in settings.json');
  }

  return pass('direct-API mode');
}

// ── Dimension 8: claude CLI present + logged in (D-13) ───────────────────────

/**
 * Verify the claude CLI binary is present AND the user is logged in.
 *
 * Uses `claude auth status --json` — a NON-BILLED auth-state probe that exists
 * as a first-party subcommand (verified: `claude auth login|logout|status`).
 * This is intentionally NOT `claude --version` (exits 0 even when logged out,
 * producing a false pass) and NOT `claude -p` (inference call that would bill).
 *
 * Distinguishes:
 *  - binary missing (ENOENT spawn error) → fail 'claude CLI not found — run `claude login`'
 *  - present but logged out (non-zero exit or JSON reports unauthenticated) →
 *      fail 'claude CLI not logged in — run `claude login`'
 *  - present and logged in (exit 0, JSON confirms authenticated) →
 *      pass 'claude CLI present and logged in'
 *
 * Binary resolution mirrors claude-headless-client.ts:208 so tests can stub
 * the probe by pointing RECENSE_CLAUDE_BIN at a stub script.
 *
 * T-45-06: probe is `auth status --json` (no inference, no billing); greps
 * for absence of `-p` flag in acceptance tests enforce the constraint.
 *
 * @exported — used by tests with RECENSE_CLAUDE_BIN pointing at stub scripts.
 */
export function checkClaudeCli(): CheckResult {
  // Mirror claude-headless-client.ts:208 so tests can stub the binary.
  const bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude';

  // T-45-06: non-billed auth-state probe — NOT `claude -p`, NOT `claude --version`.
  const result = spawnSync(bin, ['auth', 'status', '--json'], { stdio: 'pipe' });

  if (result.error) {
    // Spawn error (e.g. ENOENT) means the binary is missing entirely.
    return fail('claude CLI not found — run `claude login`');
  }

  // Parse the JSON output defensively. Treat any parse/ambiguity as logged-out.
  const stdout = result.stdout?.toString() ?? '';
  let authenticated = false;
  try {
    const parsed: unknown = JSON.parse(stdout);
    // Claude auth status --json returns e.g. { "status": "logged_in" | "logged_out", ... }
    // or { "logged_in": true } depending on version. Accept any truthy indication.
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      // Check common field shapes from claude CLI auth status output.
      if (obj['status'] === 'logged_in') authenticated = true;
      else if (obj['logged_in'] === true) authenticated = true;
      else if (result.status === 0 && !('status' in obj) && !('logged_in' in obj)) {
        // Unknown JSON shape but exit 0: treat as authenticated (forward-compat).
        authenticated = true;
      }
    }
  } catch {
    // Unparseable output → treat as logged-out (never throw).
    authenticated = false;
  }

  if (result.status === 0 && authenticated) {
    return pass('claude CLI present and logged in');
  }

  // Non-zero exit or JSON reports unauthenticated → logged out.
  return fail('claude CLI not logged in — run `claude login`');
}

// ── Main run ──────────────────────────────────────────────────────────────────

interface DoctorDimension {
  name: string;
  result: CheckResult | Promise<CheckResult>;
}

async function runDoctor(): Promise<void> {
  // CR-01: resolve the same DB the hooks/init use (env > shared default), so a
  // `recense doctor` run immediately after `recense init` audits the configured DB
  // instead of falsely reporting "RECENSE_DB not set" when the var is only
  // in the env file and not the shell.
  const dbPath = resolveDbPath();

  const dimensions: DoctorDimension[] = [
    { name: 'DB',          result: checkDb(dbPath)           },
    { name: 'API keys',    result: checkApiKeys()             },
    { name: 'Scheduler',   result: checkScheduler()           },
    { name: 'Hooks',       result: checkHooks()               },
    { name: 'Node ABI',    result: checkNodeAbi()             },
    { name: 'Serve token', result: checkServeToken()          },
    { name: 'Billing',     result: checkBillingPosture()      },
    { name: 'claude CLI',  result: checkClaudeCli()           },
  ];

  process.stdout.write('recense doctor:\n');

  let failures = 0;
  for (const dim of dimensions) {
    const r = await dim.result;
    const icon = r.ok ? '✓' : '✗';
    process.stdout.write(`  ${icon} ${dim.name}: ${r.detail}\n`);
    if (!r.ok) {
      failures++;
    }
  }

  process.stdout.write('\n');
  if (failures === 0) {
    process.stdout.write('All checks passed.\n');
  } else {
    process.stdout.write(`${failures} check(s) failed.\n`);
  }

  // CR-02: set exitCode here; do NOT call process.exit() inside try/finally
  process.exitCode = failures > 0 ? 1 : 0;
}

// WR-01: only run when executed as the main module (dispatched via spawnScript from
// brain.ts). A bare top-level run fired on every `require()` — unit tests importing the
// check helpers triggered live API calls, process spawns, and exitCode mutation.
if (require.main === module) {
  runDoctor().catch((err: unknown) => {
    process.stderr.write(`recense doctor fatal: ${err}\n`);
    process.exitCode = 1;
  });
}
