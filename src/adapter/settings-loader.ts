/**
 * settings-loader — disk persistence foundation for Phase 44 settings surface.
 *
 * Mirrors runtime-config.ts exactly in structure:
 *   - defaultSettingsPath() mirrors defaultDbPath()
 *   - loadSettingsFile() mirrors loadConfiguredEnv() (existsSync guard + try/catch → null)
 *   - writeSettingsFile() mirrors the chmod-600 posture of sleep.env writes
 *   - loadMergedConfig() builds the effective EngineConfig with D-05 precedence:
 *       explicit env var > settings.json overrides > preset baseline > DEFAULT_CONFIG
 *   - D-12 core guardrail: hard-rejects any override that would disable extraction
 *     by cranking consolSkipThreshold/consolSkipThresholdAssistant to >= 1 or < 0
 *     (a threshold of 1 skips EVERY episode, gutting extraction without a toggle).
 *     The core (extract + PE-gated reconsolidation) has no toggle at all — this
 *     is the belt-and-suspenders indirect-disable path guard.
 *
 * File I/O only — never touches the DB (D-03: settings.json is the persisted store).
 *
 * Consumers: 44-02 (run-sleep-pass), 44-04 (config CLI), 44-05 (viz-server routes).
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  DEFAULT_CONFIG,
  PRESET_CONFIGS,
} from '../lib/config';
import type { EngineConfig, PresetName, SettingsFile } from '../lib/config';

// ---------------------------------------------------------------------------
// Path helpers (mirror runtime-config.ts defaultDbPath / sleepEnvPath)
// ---------------------------------------------------------------------------

/**
 * Default location of the settings file.
 * Lives in the same ~/.config/recense/ directory as recense.db and sleep.env (D-04).
 */
export function defaultSettingsPath(): string {
  return join(homedir(), '.config', 'recense', 'settings.json');
}

// ---------------------------------------------------------------------------
// loadSettingsFile — resilient JSON reader (mirrors loadConfiguredEnv posture)
// ---------------------------------------------------------------------------

/**
 * Read and parse the settings file. Returns null on missing file, parse error,
 * or any unexpected shape — NEVER throws (mirrors loadConfiguredEnv posture, T-44-03).
 *
 * Callers must treat null as "use defaults"; they should not attempt error recovery.
 */
export function loadSettingsFile(path: string = defaultSettingsPath()): SettingsFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isSettingsFileShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// writeSettingsFile — atomic write + chmod-600 (mirrors sleep.env posture, T-44-02)
// ---------------------------------------------------------------------------

/**
 * Persist settings to disk as JSON (pretty-printed).
 * Applies chmod 0o600 after writing so other local users cannot read/alter
 * the file (mirrors the chmod-600 posture of sleep.env — T-44-02).
 *
 * The directory must already exist (same contract as writeFileSync for sleep.env).
 * The caller (`recense config` or viz-server POST /settings) is responsible for
 * creating ~/.config/recense/ before the first write.
 */
export function writeSettingsFile(
  settings: SettingsFile,
  path: string = defaultSettingsPath(),
): void {
  writeFileSync(path, JSON.stringify(settings, null, 2));
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// loadMergedConfig — D-05 precedence + D-12 core guardrail
// ---------------------------------------------------------------------------

/**
 * Build the effective EngineConfig from all sources, in D-05 precedence order
 * (later wins): DEFAULT_CONFIG → preset baseline → settings.json overrides → explicit env.
 *
 * D-12 CORE GUARDRAIL (belt-and-suspenders):
 *   Before applying overrides, sanitize consolSkipThreshold and consolSkipThresholdAssistant.
 *   A value >= 1 skips EVERY episode (100% skip rate → extraction disabled) and a value < 0
 *   is invalid. Both are hard-rejected; the field falls back to the preset/DEFAULT value.
 *   There is no toggle for the core (extract + PE-gated reconsolidation) — this guard closes
 *   the only indirect-disable path.
 *
 * Env-var overrides (applied last, after the sanitized merge — env wins regardless of file):
 *   RECENSE_CORPUS_GEN:                  '0' → corpusGen=false; anything else defined → true
 *   RECENSE_CORPUS_GEN_MAX:              parseInt → corpusGenMax
 *   RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD: parseInt → corpusSubjectDriftThreshold
 *
 * Never throws (T-44-03): a missing or malformed file silently falls back to DEFAULT_CONFIG.
 * Unknown preset names fall back to 'standard' (T-44-04).
 */
export function loadMergedConfig(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = defaultSettingsPath(),
): EngineConfig {
  // 1. Read settings file (null-safe)
  const sf = loadSettingsFile(settingsPath);

  // 2. Resolve preset — unknown preset falls back to 'standard' (T-44-04)
  const preset: PresetName =
    sf !== null && isValidPresetName(sf.preset) ? sf.preset : 'standard';

  // 3. Get overrides from file (empty object if file missing)
  const rawOverrides = sf?.overrides ?? {};

  // 4. D-12 core guardrail: sanitize salience thresholds before applying
  const sanitizedOverrides = sanitizeCoreGuardrail(rawOverrides);

  // 5. Merge in D-05 precedence order (later wins):
  //    DEFAULT_CONFIG → preset baseline → sanitized overrides → dbPath
  const merged: EngineConfig = {
    ...DEFAULT_CONFIG,
    ...PRESET_CONFIGS[preset],
    ...sanitizedOverrides,
    dbPath,
  };

  // 6. Apply explicit env-var overrides on top (env wins — D-05)
  applyEnvOverrides(merged, env);

  return merged;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for the SettingsFile shape.
 * Accepts any object with a string preset field and an overrides object.
 * Deliberately lenient — unknown keys in overrides are silently ignored by the spread.
 */
function isSettingsFileShape(v: unknown): v is SettingsFile {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['preset'] !== 'string') return false;
  if (typeof obj['overrides'] !== 'object' || obj['overrides'] === null) return false;
  return true;
}

function isValidPresetName(name: string): name is PresetName {
  return name === 'lite' || name === 'standard' || name === 'full';
}

/**
 * D-12 core guardrail: strip/reset any override that would disable extraction by
 * cranking consolSkipThreshold or consolSkipThresholdAssistant to >= 1 or < 0.
 * Returns a safe copy of the overrides with only the valid fields kept.
 */
function sanitizeCoreGuardrail(
  overrides: SettingsFile['overrides'],
): Omit<SettingsFile['overrides'], 'sleepFrequencyHours'> {
  const safe: Omit<SettingsFile['overrides'], 'sleepFrequencyHours'> = { ...overrides };

  // Guard: consolSkipThreshold must be in (0, 1) exclusive
  if (
    safe.consolSkipThreshold !== undefined &&
    (safe.consolSkipThreshold >= 1 || safe.consolSkipThreshold < 0)
  ) {
    delete safe.consolSkipThreshold;
  }

  // Guard: consolSkipThresholdAssistant must be in (0, 1) exclusive
  if (
    safe.consolSkipThresholdAssistant !== undefined &&
    (safe.consolSkipThresholdAssistant >= 1 || safe.consolSkipThresholdAssistant < 0)
  ) {
    delete safe.consolSkipThresholdAssistant;
  }

  return safe;
}

/**
 * Apply the env-var cost-lever overrides on top of the already-merged config.
 * Mutates the config object in place (env wins — last step, D-05).
 *
 * Env vars that are UNDEFINED are skipped (env absent = no override, default behaviour).
 * This preserves the D-05 precedence: an env var that is explicitly set wins over settings.json;
 * an absent env var defers to the settings.json / preset / DEFAULT value.
 */
function applyEnvOverrides(config: EngineConfig, env: NodeJS.ProcessEnv): void {
  // RECENSE_CORPUS_GEN: '0' → disable; any other defined value → enable
  if (env['RECENSE_CORPUS_GEN'] !== undefined) {
    config.corpusGen = env['RECENSE_CORPUS_GEN'] !== '0';
  }

  // RECENSE_CORPUS_GEN_MAX: integer parse
  if (env['RECENSE_CORPUS_GEN_MAX'] !== undefined) {
    const parsed = parseInt(env['RECENSE_CORPUS_GEN_MAX'] ?? '', 10);
    if (!isNaN(parsed) && parsed > 0) {
      config.corpusGenMax = parsed;
    }
  }

  // RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD: integer parse
  if (env['RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD'] !== undefined) {
    const parsed = parseInt(env['RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD'] ?? '', 10);
    if (!isNaN(parsed) && parsed > 0) {
      config.corpusSubjectDriftThreshold = parsed;
    }
  }
}
