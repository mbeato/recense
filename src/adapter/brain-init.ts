#!/usr/bin/env node
/**
 * brain-init — guided bootstrap wizard (INSTALL-01/02/03 + D-88/D-89/D-90/D-91).
 *
 * D-89 spine order:
 *   1. Parse existing env file (defaults for re-run)
 *   2. Prompt: DB path
 *   3. Prompt: ANTHROPIC_API_KEY + live validate if changed (D-90/D-91)
 *   4. Prompt: OPENAI_API_KEY + live validate if changed (D-90/D-91)
 *   5. Capture BRAIN_MEMORY_NODE_BIN = process.execPath (INSTALL-03)
 *   6. Write env file chmod-600 (atomic tmp→rename, T-09-17)
 *   7. Register scheduler (brain scheduler install)
 *   8. Wire settings.json hooks (surgical merge, D-88/T-09-18)
 *   9. Offer cold-start seed [y/N] default No (D-81 guard via seed-cli)
 *
 * Idempotent re-run: existing values are shown as defaults; live key validation
 * is skipped when the key hash is unchanged (D-90).
 *
 * Exported testable helpers (no readline, no real API calls in tests):
 *   resolveExistingEnv, isKeyUnchanged, captureNodeBin, writeEnvFile,
 *   validateApiKey, mergeSettingsHooks.
 *
 * Threat mitigations:
 *   T-09-17: env file written chmod-600 via atomic tmp→rename; keys never logged.
 *   T-09-18: settings.json merge is surgical (basename match) + atomic tmp→rename
 *            + 2-space JSON; non-brain hooks preserved.
 *   T-09-19: live validation before complete; skip is opt-in only (D-91).
 *   T-09-20: seed step spawns seed-cli which acquires the single-writer lock and
 *            honours the D-81 unconfigured guard; seeded flag not burned.
 */

import { createHash } from 'crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';

// Top-level imports so vi.mock() can intercept them in tests
// (lazy require inside validateApiKey was not interceptable in vitest forks/CJS mode)
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { defaultDbPath } from './runtime-config';

const LOG_PATH = '/tmp/brain-memory-init.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] brain-init: ${msg}\n`);

// ── Exported testable helpers ────────────────────────────────────────────────

/**
 * Parse an env file into a Map<string, string>.
 * Skips lines that start with '#' (comments) and blank lines.
 * Splits on the first '=' only — values may contain '=' characters.
 * Returns an empty Map when envPath does not exist.
 */
export function resolveExistingEnv(envPath: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(envPath)) return result;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    result.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
  }
  return result;
}

/**
 * Compare two API keys by their sha256 hashes (D-90).
 * Returns true when the keys are byte-for-byte identical.
 * Keys are NEVER logged or compared as raw strings.
 */
export function isKeyUnchanged(oldKey: string, newKey: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest('hex');
  return h(oldKey) === h(newKey);
}

/**
 * Returns the absolute path of the running Node.js binary (INSTALL-03).
 * process.execPath is set by Node.js itself and is always absolute.
 */
export function captureNodeBin(): string {
  return process.execPath;
}

/**
 * Atomically write an env file with restrictive permissions (T-09-17: chmod-600).
 * Writes to a tmp file with mode 0o600, then rename()s to the final path (atomic).
 * Parent directories are created if they do not exist.
 */
export function writeEnvFile(envPath: string, vars: Record<string, string>): void {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  mkdirSync(dirname(envPath), { recursive: true });
  // WR-01: write the tmp file in the destination dir, not os.tmpdir() — rename(2)
  // is not atomic across filesystems and throws EXDEV when /tmp (tmpfs on Linux)
  // and $HOME are on different mounts. An intra-directory rename is always atomic.
  const tmp = join(dirname(envPath), `.brain-env-${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, lines, { mode: 0o600 });
  chmodSync(tmp, 0o600); // belt-and-suspenders (umask may limit mode in writeFileSync)
  renameSync(tmp, envPath);
}

/**
 * Validate an API key with a minimal live call (D-91 / INSTALL-02).
 * Returns { ok: true } on success.
 * Returns { ok: false, error } on any failure.
 * The caller is responsible for the D-91 retry loop (~3 attempts) and opt-in skip.
 * Keys are NEVER logged; only status is returned.
 */
export async function validateApiKey(
  key: string,
  provider: 'anthropic' | 'openai',
): Promise<{ ok: boolean; error?: string }> {
  if (!key) return { ok: false, error: 'empty key' };
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey: key });
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } else {
      const client = new OpenAI({ apiKey: key });
      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'hi' });
    }
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * Surgically merge brain hooks into ~/.claude/settings.json (D-88 / T-09-18).
 *
 * For each of SessionStart, UserPromptSubmit, Stop:
 *   1. Remove old-style brain entries (basename match: *-cli.js patterns).
 *   2. Add a new-style `<nodeBin> <brainJs> hook <name>` entry if absent.
 *   3. Preserve ALL non-brain hooks (Pitfall 2 guard).
 *
 * Writes atomically via tmp→rename with JSON.stringify(obj, null, 2) (2-space
 * indent — avoids collapsing other tools' formatting).
 *
 * @param settingsPath override the default path (for testing — never touch real settings in tests).
 */
export function mergeSettingsHooks(
  settingsPath: string,
  nodeBin: string,
  brainJs: string,
  dbPath: string,
): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      log('settings.json parse error — starting from empty object');
    }
  }

  const hooksSection = (settings['hooks'] ?? {}) as Record<string, unknown>;
  settings['hooks'] = hooksSection;

  // Hook event → subcommand name mapping
  const hookMap: [string, string][] = [
    ['SessionStart', 'session-start'],
    ['UserPromptSubmit', 'turn-capture'],
    ['Stop', 'stop'],
  ];

  type HookEntry = { type?: string; command?: string; timeout?: number };
  type HookGroup = { hooks?: HookEntry[]; matcher?: unknown };

  for (const [event, hookSubcmd] of hookMap) {
    // Ensure the event array exists with at least one group
    if (!Array.isArray(hooksSection[event]) || (hooksSection[event] as unknown[]).length === 0) {
      hooksSection[event] = [{ hooks: [] }];
    }

    const groups = hooksSection[event] as HookGroup[];
    const group = groups[0]!;
    if (!Array.isArray(group.hooks)) {
      group.hooks = [];
    }

    // Remove any prior brain entry — old-style `*-cli.js` OR new-style `brain ... hook`
    // (T-09-18: surgical splice). Stripping the new-style entry too makes re-running
    // init re-pin the current --db path (idempotent AND correct when the DB path changes).
    const isBrainHook = (c: string): boolean =>
      /(session-start-cli|turn-capture-cli|stop-cli)\.js\b/.test(c) ||
      /brain(\.js)?\s+hook\s/.test(c);
    group.hooks = group.hooks.filter(h => !isBrainHook(h.command ?? ''));

    // CR-01: pin the configured DB into the hook command so the hook resolves the
    // init-configured DB regardless of the env Claude Code launches the hook with.
    const newCommand = `${nodeBin} ${brainJs} hook ${hookSubcmd} --db ${dbPath}`;
    group.hooks.push({ type: 'command', command: newCommand, timeout: 5 });
  }

  // Atomic write: tmp→rename; 2-space JSON to avoid collapsing other tools' formatting.
  // WR-01: tmp file in the destination dir, not os.tmpdir() (cross-fs rename throws EXDEV).
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = join(dirname(settingsPath), `.brain-settings-${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, settingsPath);
}

// ── Interactive readline helpers ─────────────────────────────────────────────

type Rl = ReturnType<typeof createInterface>;

function ask(rl: Rl, question: string, defaultVal?: string): Promise<string> {
  const promptStr =
    defaultVal != null ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise(res =>
    rl.question(promptStr, ans => res(ans.trim() || defaultVal || '')),
  );
}

/**
 * Prompt for an API key with the D-91 retry loop.
 *   - Shows existing key as '(set — press Enter to keep)' (raw key never echoed).
 *   - Skips live validation when the key hash is unchanged (D-90).
 *   - On validation failure: up to 3 attempts showing the provider error.
 *   - Offers opt-in '[s]kip validation' escape; NOT the default (INSTALL-02).
 */
async function promptAndValidateKey(
  rl: Rl,
  label: string,
  existingKey: string,
  provider: 'anthropic' | 'openai',
): Promise<string> {
  const hint = existingKey ? '(set — press Enter to keep)' : undefined;
  const entered = await ask(rl, label, hint);

  // Use existing key when user pressed Enter and there is one
  const key =
    entered === '(set — press Enter to keep)' || entered === '' ? existingKey : entered;

  // D-90: skip validation when the key is unchanged
  if (key && existingKey && isKeyUnchanged(existingKey, key)) {
    return key;
  }

  if (!key) {
    console.log(
      `  ${label} not set — skipping validation. Set it in the env file before use.`,
    );
    return key;
  }

  // D-91: retry loop (~3 attempts) with opt-in [s]kip escape
  let currentKey = key;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await validateApiKey(currentKey, provider);
    if (r.ok) {
      console.log(`  ${provider} key: valid`);
      return currentKey;
    }

    console.error(`  ${provider} key error: ${r.error}`);

    if (attempt < 3) {
      const next = await ask(
        rl,
        `  Re-enter ${label} (or 's' to skip validation)`,
        undefined,
      );
      if (next.toLowerCase() === 's') {
        console.log(
          `  Skipping validation — key written as-is. Verify later with 'brain doctor'.`,
        );
        return currentKey;
      }
      if (next) currentKey = next;
    } else {
      const skip = await ask(
        rl,
        `  3 attempts failed. Type 's' to skip validation, or enter a new key`,
        undefined,
      );
      if (skip.toLowerCase() === 's' || skip === '') {
        console.log('  Skipping validation.');
        return currentKey;
      }
      currentKey = skip;
    }
  }
  return currentKey;
}

// ── Main interactive wizard (D-89 spine) ─────────────────────────────────────

async function main(): Promise<void> {
  const envPath =
    process.env['BRAIN_MEMORY_SLEEP_ENV'] ??
    join(homedir(), '.config', 'brain-memory', 'sleep.env');

  const existing = resolveExistingEnv(envPath);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nbrain init — guided bootstrap\n');
  console.log('Press Enter to keep the current value shown in brackets.\n');

  // ── D-89 Step 1: DB path ──────────────────────────────────────────────────
  // CR-01: single source of truth for the default — must match what the hooks resolve.
  const defaultDb = existing.get('BRAIN_MEMORY_DB') ?? defaultDbPath();
  const dbPath = await ask(rl, 'DB path', defaultDb);

  // ── D-89 Steps 2-3: API keys with live validation ─────────────────────────
  const anthropicKey = await promptAndValidateKey(
    rl,
    'ANTHROPIC_API_KEY',
    existing.get('ANTHROPIC_API_KEY') ?? '',
    'anthropic',
  );

  const openaiKey = await promptAndValidateKey(
    rl,
    'OPENAI_API_KEY',
    existing.get('OPENAI_API_KEY') ?? '',
    'openai',
  );

  // ── D-89 Step 4: Capture node binary (INSTALL-03) ─────────────────────────
  const nodeBin = captureNodeBin();
  console.log(`\n  Node binary: ${nodeBin}`);

  // ── D-89 Step 5: Write env file (atomic chmod-600, T-09-17) ──────────────
  // Start with existing vars; overwrite only the known keys
  const vars: Record<string, string> = {};
  for (const [k, v] of existing) vars[k] = v;
  vars['BRAIN_MEMORY_NODE_BIN'] = nodeBin;
  vars['BRAIN_MEMORY_DB'] = dbPath;
  if (anthropicKey) vars['ANTHROPIC_API_KEY'] = anthropicKey;
  if (openaiKey) vars['OPENAI_API_KEY'] = openaiKey;

  writeEnvFile(envPath, vars);
  console.log(`  Env file written: ${envPath} (chmod 600)`);

  // ── D-89 Step 6: Scheduler registration ───────────────────────────────────
  console.log('\n  Registering scheduler...');
  try {
    const { runSchedulerCommand } =
      require('./brain-scheduler') as {
        runSchedulerCommand: (sub: string | undefined, args: string[]) => void;
      };
    runSchedulerCommand('install', []);
  } catch (e) {
    const msg = String(e);
    console.error(`  Scheduler registration failed: ${msg.slice(0, 200)}`);
    log(`scheduler registration error: ${msg}`);
  }

  // ── D-89 Step 7: Wire settings.json hooks (D-88) ──────────────────────────
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const brainJs = resolve(__dirname, 'brain.js');
  console.log('\n  Wiring hooks in settings.json...');
  try {
    mergeSettingsHooks(settingsPath, nodeBin, brainJs, dbPath);
    console.log('  Hooks wired: SessionStart, UserPromptSubmit, Stop');
  } catch (e) {
    const msg = String(e);
    console.error(`  Hook wiring failed: ${msg.slice(0, 200)}`);
    log(`hook wiring error: ${msg}`);
  }

  // ── D-89 Step 8: Optional cold-start seed [y/N] default No (D-81 guard) ──
  const seedAnswer = await ask(rl, '\nSeed from your MEMORY.md now? [y/N]', 'N');
  rl.close();

  if (seedAnswer.trim().toLowerCase() === 'y') {
    console.log('  Starting seed (logs: /tmp/brain-memory-seed.log)...');
    // Spawn seed-cli as a subprocess — it acquires the single-writer lock, honours
    // the D-81 unconfigured guard (no-op + warn, seeded flag NOT burned), and uses
    // the correct lock discipline (db?.close() → releaseLock() in finally).
    const seedJs = resolve(__dirname, 'seed-cli.js');
    const result = spawnSync(nodeBin, [seedJs], {
      stdio: 'inherit',
      env: {
        ...process.env,
        BRAIN_MEMORY_DB: dbPath,
        BRAIN_MEMORY_NODE_BIN: nodeBin,
        ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
        ...(openaiKey ? { OPENAI_API_KEY: openaiKey } : {}),
      },
    });
    if ((result.status ?? 1) !== 0) {
      console.error(
        '  Seed exited non-zero — check /tmp/brain-memory-seed.log for details.',
      );
    }
  } else {
    rl.close();
  }

  console.log('\nbrain init complete.\n');
  log('init complete');
}

if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] brain-init FATAL: ${err}\n`);
    process.exit(1);
  });
}
