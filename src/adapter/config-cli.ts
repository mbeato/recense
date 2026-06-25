/**
 * config-cli — `recense config` subcommand dispatcher (44-04).
 *
 * Exports runConfigCommand(sub, args) dispatched by recense.ts 'config' case.
 * Non-auto-invoking — mirrors runSchedulerCommand pattern (no require.main guard).
 *
 * Subcommands:
 *  show   — effective merged config + source per lever; D-11 divergence label
 *  get    — single key effective value + source
 *  set    — write override to settings.json (whitelisted keys only; D-12 core guard)
 *  preset — set preset name, clear conflicting overrides (D-11 clean switch)
 *  apply  — regenerate launchd plist StartInterval from sleepFrequencyHours (D-07)
 *
 * Threat mitigations:
 *  T-44-11: set whitelists known settable keys; unknowns (including core) rejected + exit 1
 *  T-44-12: post-write loadMergedConfig re-check; warns if D-12 guardrail stripped value
 *  T-44-13: apply delegates to runSchedulerCommand('install', []) — reuses idempotent path
 *  T-44-14: frequency coerced to integer seconds before plist substitution (in scheduler)
 */

import {
  defaultSettingsPath,
  loadMergedConfig,
  loadSettingsFile,
  writeSettingsFile,
} from './settings-loader';
import { DEFAULT_CONFIG, PRESET_CONFIGS } from '../lib/config';
import type { PresetName, SettingsFile } from '../lib/config';
import { resolveDbPath } from './runtime-config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keys settable via `recense config set` (T-44-11 whitelist).
 * The core (extract + reconsolidation) is intentionally absent — it has no toggle (D-12).
 * schemaInductionEnabled is controlled via preset, not direct set.
 */
const SETTABLE_KEYS = new Set<string>([
  'consolSkipThreshold',
  'consolSkipThresholdAssistant',
  'corpusSubjectDriftThreshold',
  'corpusGen',
  'corpusGenMax',
  'sleepFrequencyHours',
]);

/** Boolean-typed keys (coerce '1'/'true' → true, all else → false). */
const BOOLEAN_KEYS = new Set<string>(['corpusGen']);

/**
 * Cost levers shown in `config show` output.
 * Each entry: [configKey, envVarName | null].
 * sleepFrequencyHours is displayed separately (scheduler artifact, not in EngineConfig).
 */
const DISPLAY_LEVERS: ReadonlyArray<[string, string | null]> = [
  ['consolSkipThreshold',          null],
  ['consolSkipThresholdAssistant', null],
  ['corpusSubjectDriftThreshold',  'RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD'],
  ['corpusGen',                    'RECENSE_CORPUS_GEN'],
  ['corpusGenMax',                 'RECENSE_CORPUS_GEN_MAX'],
  ['schemaInductionEnabled',       null],
];

/** Env-var override mapping for source detection. */
const ENV_VAR_MAP: Readonly<Record<string, string>> = {
  corpusSubjectDriftThreshold: 'RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD',
  corpusGen:                   'RECENSE_CORPUS_GEN',
  corpusGenMax:                'RECENSE_CORPUS_GEN_MAX',
};

// ---------------------------------------------------------------------------
// Main dispatcher — exported for recense.ts
// ---------------------------------------------------------------------------

/**
 * Route `recense config <sub>` to the correct handler.
 * settingsPath and schedulerOverride are injected by tests; callers from recense.ts
 * omit them (defaults to the canonical paths and require()-loaded scheduler).
 */
export function runConfigCommand(
  sub: string | undefined,
  args: string[],
  settingsPath: string = defaultSettingsPath(),
  schedulerOverride?: (sub: string, args: string[]) => void,
): void {
  switch (sub) {
    case 'show':
      return runShow(settingsPath);
    case 'get':
      return runGet(args[0], settingsPath);
    case 'set':
      return runSet(args[0], args[1], settingsPath);
    case 'preset':
      return runPreset(args[0], settingsPath);
    case 'apply':
      return runApply(settingsPath, schedulerOverride);
    default:
      process.stderr.write(
        'Usage: recense config show|get <key>|set <key> <value>|preset <lite|standard|full>|apply\n',
      );
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// show — effective merged config + source + D-11 divergence label
// ---------------------------------------------------------------------------

function runShow(settingsPath: string): void {
  const sf = loadSettingsFile(settingsPath);
  const preset = resolvePreset(sf);
  const overrides = sf?.overrides ?? {};

  // D-11: detect divergence — any override whose value differs from the preset+DEFAULT baseline
  const presetBaseline: Record<string, unknown> = { ...DEFAULT_CONFIG, ...PRESET_CONFIGS[preset] };
  const isModified = Object.entries(overrides).some(([k, v]) => {
    if (k === 'sleepFrequencyHours') return false; // scheduler-only — not a runtime divergence
    return presetBaseline[k] !== v;
  });

  const label = `${capitalizeFirst(preset)}${isModified ? ' (modified)' : ''}`;
  console.log(`Preset: ${label}`);
  console.log('');

  // Get effective merged config for all runtime lever values
  const dbPath = resolveDbPath(process.argv);
  const merged = loadMergedConfig(dbPath, process.env, settingsPath) as unknown as Record<string, unknown>;

  const COL1 = 34;
  const COL2 = 12;
  console.log(`  ${'Key'.padEnd(COL1)} ${'Value'.padEnd(COL2)} Source`);
  console.log(`  ${'─'.repeat(COL1)} ${'─'.repeat(COL2)} ${'─'.repeat(20)}`);

  for (const [key, envVarName] of DISPLAY_LEVERS) {
    const value = merged[key];
    const source = getSource(key, sf, preset, envVarName ?? null, process.env);
    console.log(`  ${key.padEnd(COL1)} ${String(value).padEnd(COL2)} ${source}`);
  }

  // sleepFrequencyHours — settings-only artifact; not in EngineConfig (D-07)
  const freq = overrides.sleepFrequencyHours;
  const freqDisplay = freq !== undefined ? String(freq) : '(not set)';
  const freqSource = freq !== undefined ? 'settings.json' : 'default';
  console.log(`  ${'sleepFrequencyHours'.padEnd(COL1)} ${freqDisplay.padEnd(COL2)} ${freqSource}`);

  console.log('');
  console.log('  extract + reconsolidation: always on (this is recense)');
}

// ---------------------------------------------------------------------------
// get — single lever value + source
// ---------------------------------------------------------------------------

function runGet(key: string | undefined, settingsPath: string): void {
  if (!key) {
    process.stderr.write('Usage: recense config get <key>\n');
    process.exit(1);
  }

  const sf = loadSettingsFile(settingsPath);
  const preset = resolvePreset(sf);

  // sleepFrequencyHours is a settings-only field not in EngineConfig
  if (key === 'sleepFrequencyHours') {
    const freq = sf?.overrides?.sleepFrequencyHours;
    if (freq !== undefined) {
      console.log(`${key} = ${freq}  (source: settings.json)`);
    } else {
      console.log(`${key} = (not set)  (source: default)`);
    }
    return;
  }

  const dbPath = resolveDbPath(process.argv);
  const merged = loadMergedConfig(dbPath, process.env, settingsPath) as unknown as Record<string, unknown>;
  const value = merged[key];

  if (value === undefined) {
    process.stderr.write(`Unknown key: ${key}\n`);
    process.exit(1);
  }

  const envVarName = ENV_VAR_MAP[key] ?? null;
  const source = getSource(key, sf, preset, envVarName, process.env);
  console.log(`${key} = ${String(value)}  (source: ${source})`);
}

// ---------------------------------------------------------------------------
// set — write override to settings.json (T-44-11 whitelist + T-44-12 guardrail)
// ---------------------------------------------------------------------------

function runSet(
  key: string | undefined,
  rawValue: string | undefined,
  settingsPath: string,
): void {
  if (!key || rawValue === undefined) {
    process.stderr.write('Usage: recense config set <key> <value>\n');
    process.exit(1);
  }

  // T-44-11: whitelist — reject unknown keys and any attempt to address the core
  if (!SETTABLE_KEYS.has(key)) {
    process.stderr.write(
      `Unknown or non-settable key: '${key}'. ` +
        `Settable keys: ${[...SETTABLE_KEYS].join(', ')}\n`,
    );
    process.exit(1);
  }

  // Coerce value by key type
  let coerced: boolean | number;
  if (BOOLEAN_KEYS.has(key)) {
    coerced = rawValue === '1' || rawValue.toLowerCase() === 'true';
  } else {
    const n = Number(rawValue);
    if (isNaN(n)) {
      process.stderr.write(`Invalid numeric value for '${key}': ${rawValue}\n`);
      process.exit(1);
    }
    coerced = n;
  }

  // Load existing settings or start from a default baseline
  const sf: SettingsFile = loadSettingsFile(settingsPath) ?? {
    preset: 'standard',
    overrides: {},
  };

  // Apply override
  (sf.overrides as Record<string, unknown>)[key] = coerced;
  writeSettingsFile(sf, settingsPath);

  // T-44-12: post-write check for core-disabling values (consolSkipThreshold fields)
  if (key === 'consolSkipThreshold' || key === 'consolSkipThresholdAssistant') {
    const dbPath = resolveDbPath(process.argv);
    const merged = loadMergedConfig(dbPath, process.env, settingsPath) as unknown as Record<string, unknown>;
    const effectiveValue = merged[key];
    if (effectiveValue !== coerced) {
      process.stderr.write(
        `Warning: value ${String(coerced)} for '${key}' was rejected by the D-12 core guardrail ` +
          `(must be in (0, 1) exclusive — a value ≥1 or <0 disables extraction). ` +
          `The setting was not applied.\n`,
      );
      return;
    }
  }

  console.log(`Set ${key} = ${String(coerced)}`);
}

// ---------------------------------------------------------------------------
// preset — set preset name + clear conflicting overrides (D-11)
// ---------------------------------------------------------------------------

function runPreset(name: string | undefined, settingsPath: string): void {
  if (!name || !isValidPreset(name)) {
    process.stderr.write('Usage: recense config preset <lite|standard|full>\n');
    process.exit(1);
  }

  const preset = name as PresetName;
  const sf: SettingsFile = loadSettingsFile(settingsPath) ?? {
    preset: 'standard',
    overrides: {},
  };

  sf.preset = preset;

  // D-11: clear overrides whose key the new preset explicitly defines (clean switch)
  // The override becomes redundant/conflicting once the preset defines the key.
  const presetKeys = Object.keys(PRESET_CONFIGS[preset]);
  for (const k of presetKeys) {
    delete (sf.overrides as Record<string, unknown>)[k];
  }

  writeSettingsFile(sf, settingsPath);
  console.log(`Preset set to: ${preset}`);
}

// ---------------------------------------------------------------------------
// apply — regenerate launchd plist frequency from sleepFrequencyHours (D-07)
// ---------------------------------------------------------------------------

function runApply(
  _settingsPath: string,
  schedulerOverride?: (sub: string, args: string[]) => void,
): void {
  const platform = process.platform;

  if (platform === 'darwin') {
    // Delegate to scheduler install — installMacOSScheduler reads sleepFrequencyHours
    // from defaultSettingsPath() and substitutes __FREQUENCY__ in the plist (D-07).
    const schedFn =
      schedulerOverride ??
      (
        require('./recense-scheduler') as {
          runSchedulerCommand: (s: string, a: string[]) => void;
        }
      ).runSchedulerCommand;
    schedFn('install', []);
  } else {
    // Linux: croner reads frequency at process start; restart to pick up changes (D-92)
    console.log('recense config apply (Linux):');
    console.log('  The sleep pass frequency is applied via croner.');
    console.log('  Restart the scheduler to pick up the new frequency:');
    console.log('    recense scheduler run');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePreset(sf: SettingsFile | null): PresetName {
  if (sf && isValidPreset(sf.preset)) return sf.preset;
  return 'standard';
}

function isValidPreset(name: string): name is PresetName {
  return name === 'lite' || name === 'standard' || name === 'full';
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Determine the source of a config key's effective value (D-05 precedence labels).
 * Returns: 'env' | 'settings.json' | 'preset:<name>' | 'default'
 */
function getSource(
  key: string,
  sf: SettingsFile | null,
  preset: PresetName,
  envVarName: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (envVarName && env[envVarName] !== undefined) return 'env';
  if (sf?.overrides && key in (sf.overrides as Record<string, unknown>)) return 'settings.json';
  if (key in PRESET_CONFIGS[preset]) return `preset:${preset}`;
  return 'default';
}
