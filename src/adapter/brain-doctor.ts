#!/usr/bin/env node
/**
 * brain doctor — 5-dimension install health audit (INSTALL-04).
 *
 * Checks five fixed dimensions and prints a human-readable pass/fail per
 * dimension. Exits non-zero if any dimension fails. `--json` is deferred
 * to INSTALL-07.
 *
 * Dimensions (INSTALL-04):
 *   1. DB reachability + schema version
 *   2. API key validity via live calls (Anthropic + OpenAI)
 *   3. Scheduler registered + running
 *   4. Hooks wired in ~/.claude/settings.json
 *   5. Node ABI match (BRAIN_MEMORY_NODE_BIN vs better-sqlite3 build)
 *
 * Design invariants:
 *  - DB opened readonly only — never writes the graph (T-09-10).
 *  - API key values are never written to stdout (T-09-09).
 *  - Failures aggregated; process.exitCode set at the end (CR-02: no
 *    process.exit() inside try/finally).
 *  - BRAIN_MEMORY_NODE_BIN used for ABI check (not process.execPath).
 *
 * Threat mitigations:
 *  - T-09-09: live-key check reports valid/invalid only; never echoes key bytes.
 *  - T-09-10: DB opened { readonly: true }; never writes.
 *  - T-09-11: failure aggregation → non-zero exit; asserted in test.
 */

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SCHEMA_VERSION } from '../db/schema';

// ── Check result type ─────────────────────────────────────────────────────────

export interface CheckResult {
  ok: boolean;
  detail: string;
}

function pass(detail: string): CheckResult { return { ok: true,  detail }; }
function fail(detail: string): CheckResult { return { ok: false, detail }; }

// ── Dimension 1: DB reachability + schema version ─────────────────────────────

/**
 * Open BRAIN_MEMORY_DB read-only, read meta.schema_version, compare to
 * the imported SCHEMA_VERSION constant.
 *
 * T-09-10: { readonly: true } prevents any accidental write.
 *
 * @exported — used by tests to exercise schema-pass/mismatch without live API.
 */
export function checkDb(dbPath: string): CheckResult {
  if (!dbPath) {
    return fail('BRAIN_MEMORY_DB not set — run `brain init`');
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    db.close();
    const v = row?.value;
    if (v !== String(SCHEMA_VERSION)) {
      return fail(`schema version mismatch: got ${v ?? '(none)'}, want ${SCHEMA_VERSION} — run \`brain init\``);
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
 * @exported — exported for type reference; live calls mean tests mock/skip it.
 */
export async function checkApiKeys(): Promise<CheckResult> {
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const openaiKey    = process.env['OPENAI_API_KEY'];
  const results: string[] = [];
  let anyFail = false;

  // ── Anthropic ──────────────────────────────────────────────────────────────
  if (!anthropicKey) {
    results.push('ANTHROPIC missing');
    anyFail = true;
  } else {
    try {
      const { default: Anthropic } = require('@anthropic-ai/sdk') as typeof import('@anthropic-ai/sdk');
      // T-09-09: apiKey not logged; client construction is opaque
      const client = new Anthropic({ apiKey: anthropicKey });
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
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
      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'hi' });
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
 * macOS: checks launchctl for com.brain-memory.sleep-pass.
 * Linux: pgrep-based liveness (informational — not a hard fail per D-92).
 *
 * @exported — used by tests; platform-specific branches make it deterministic
 *             in CI without mocking.
 */
export function checkScheduler(): CheckResult {
  if (process.platform === 'darwin') {
    const result = spawnSync(
      'launchctl',
      ['list', 'com.brain-memory.sleep-pass'],
      { stdio: 'pipe' },
    );
    if (result.status === 0) {
      return pass('com.brain-memory.sleep-pass registered (macOS launchd)');
    }
    return fail('com.brain-memory.sleep-pass not registered — run `brain scheduler install`');
  }
  // Linux: foreground process only (D-92 honesty principle)
  const result = spawnSync('pgrep', ['-f', 'brain scheduler run'], { stdio: 'pipe' });
  if (result.status === 0) {
    return pass('brain scheduler run process detected');
  }
  // Not running is informational on Linux (D-92) — not a hard failure
  return pass('scheduler: not running (start with `brain scheduler run`; Linux reboot-survival is v2.1)');
}

// ── Dimension 4: Hooks wired in settings.json ─────────────────────────────────

/**
 * Reads ~/.claude/settings.json and checks SessionStart, UserPromptSubmit,
 * and Stop each have a brain hook entry (new `brain ... hook` form OR the
 * pre-migration `brain-memory/dist/src/adapter/` path).
 *
 * @param settingsOverridePath — override the default path for testing.
 * @exported — used by tests to verify hook detection without modifying the
 *             real settings.json.
 */
export function checkHooks(settingsOverridePath?: string): CheckResult {
  const settingsPath = settingsOverridePath ?? join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return fail('~/.claude/settings.json not found — run `brain init`');
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
    return fail('no hooks section in settings.json — run `brain init`');
  }

  const events = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;
  const missing: string[] = [];

  for (const event of events) {
    const groups = hooks[event] as Array<{ hooks?: Array<{ command?: string }> }> | undefined;
    const hasBrainHook = groups?.some(group =>
      group.hooks?.some(h => {
        const cmd = h.command ?? '';
        // New-style: command contains 'brain' AND 'hook'
        // Pre-migration: command contains the old dist path
        return (cmd.includes('brain') && cmd.includes('hook')) ||
               cmd.includes('brain-memory/dist/src/adapter/');
      }),
    );
    if (!hasBrainHook) missing.push(event);
  }

  if (missing.length > 0) {
    return fail(`hooks not wired for: ${missing.join(', ')} — run \`brain init\``);
  }
  return pass('SessionStart, UserPromptSubmit, Stop wired');
}

// ── Dimension 5: Node ABI match ───────────────────────────────────────────────

/**
 * Spawn BRAIN_MEMORY_NODE_BIN and require better-sqlite3.
 * Non-zero exit or NODE_MODULE_VERSION in stderr = ABI mismatch.
 *
 * @exported — used by tests to assert fail behavior when BRAIN_MEMORY_NODE_BIN
 *             is unset, without requiring a live node binary.
 */
export function checkNodeAbi(): CheckResult {
  const nodeBin = process.env['BRAIN_MEMORY_NODE_BIN'];
  if (!nodeBin) {
    return fail('BRAIN_MEMORY_NODE_BIN not set — run `brain init`');
  }
  const result = spawnSync(nodeBin, ['-e', "require('better-sqlite3')"], { stdio: 'pipe' });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? '');
    if (stderr.includes('NODE_MODULE_VERSION')) {
      return fail('ABI mismatch — re-run `brain init` to recapture node binary');
    }
    return fail(`better-sqlite3 load error: ${stderr.slice(0, 200)}`);
  }
  return pass(`Node ABI match: NMV=${process.versions.modules}, bin=${nodeBin}`);
}

// ── Main run ──────────────────────────────────────────────────────────────────

interface DoctorDimension {
  name: string;
  result: CheckResult | Promise<CheckResult>;
}

async function runDoctor(): Promise<void> {
  const dbPath = process.env['BRAIN_MEMORY_DB'] ?? '';

  const dimensions: DoctorDimension[] = [
    { name: 'DB',       result: checkDb(dbPath)    },
    { name: 'API keys', result: checkApiKeys()      },
    { name: 'Scheduler',result: checkScheduler()   },
    { name: 'Hooks',    result: checkHooks()        },
    { name: 'Node ABI', result: checkNodeAbi()      },
  ];

  process.stdout.write('brain doctor:\n');

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

runDoctor().catch((err: unknown) => {
  process.stderr.write(`brain doctor fatal: ${err}\n`);
  process.exitCode = 1;
});
