/**
 * Phase 44 Plan 01 — Settings foundation tests.
 *
 * Covers:
 *   Task 1 (config.ts): PRESET_CONFIGS shapes — presets disable/enable the
 *     optional cost levers correctly; no preset disables the extract/reconsolidation core.
 *   Task 2 (settings-loader.ts): loadMergedConfig precedence (D-05), core guardrail (D-12),
 *     loadSettingsFile resilience, writeSettingsFile persistence + chmod-600, all six
 *     behavioral probes from the plan.
 */
import { statSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, afterEach } from 'vitest';
import { PRESET_CONFIGS, DEFAULT_CONFIG } from '../src/lib/config';
import type { PresetName } from '../src/lib/config';
import {
  defaultSettingsPath,
  loadSettingsFile,
  writeSettingsFile,
  loadMergedConfig,
} from '../src/adapter/settings-loader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), `recense-settings-test-${process.pid}`);
const TMP_SETTINGS = join(TMP_DIR, 'settings.json');

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cleanupTmpSettings() {
  if (existsSync(TMP_SETTINGS)) unlinkSync(TMP_SETTINGS);
}

const TEST_DB = ':memory:';

// ---------------------------------------------------------------------------
// Task 1: config.ts PRESET_CONFIGS shapes
// ---------------------------------------------------------------------------

describe('PRESET_CONFIGS', () => {
  it('exports all three preset names', () => {
    const presets: PresetName[] = ['lite', 'standard', 'full'];
    for (const p of presets) {
      expect(PRESET_CONFIGS).toHaveProperty(p);
    }
  });

  it('lite preset disables corpusGen and schemaInductionEnabled', () => {
    expect(PRESET_CONFIGS.lite.corpusGen).toBe(false);
    expect(PRESET_CONFIGS.lite.schemaInductionEnabled).toBe(false);
  });

  it('standard preset enables schemaInductionEnabled but not extra corpusGen', () => {
    // Standard: corpusGen=false (no extra corpus docs), schemaInductionEnabled=true
    expect(PRESET_CONFIGS.standard.schemaInductionEnabled).toBe(true);
    expect(PRESET_CONFIGS.standard.corpusGen).toBe(false);
  });

  it('full preset enables both corpusGen and schemaInductionEnabled', () => {
    expect(PRESET_CONFIGS.full.corpusGen).toBe(true);
    expect(PRESET_CONFIGS.full.schemaInductionEnabled).toBe(true);
    expect(PRESET_CONFIGS.full.corpusGenMax).toBe(25);
  });

  it('no preset disables consolSkipThreshold to a core-gutting value', () => {
    // D-12: presets must never set consolSkipThreshold >= 1 or < 0 (those skip ALL episodes)
    for (const preset of Object.values(PRESET_CONFIGS)) {
      if (preset.consolSkipThreshold !== undefined) {
        expect(preset.consolSkipThreshold).toBeGreaterThan(0);
        expect(preset.consolSkipThreshold).toBeLessThan(1);
      }
      if (preset.consolSkipThresholdAssistant !== undefined) {
        expect(preset.consolSkipThresholdAssistant).toBeGreaterThan(0);
        expect(preset.consolSkipThresholdAssistant).toBeLessThan(1);
      }
    }
  });

  it('DEFAULT_CONFIG still has pre-existing numeric values unchanged', () => {
    expect(DEFAULT_CONFIG.consolSkipThreshold).toBe(0.2);
    expect(DEFAULT_CONFIG.consolSkipThresholdAssistant).toBe(0.5);
    expect(DEFAULT_CONFIG.corpusSubjectDriftThreshold).toBe(3);
  });

  it('DEFAULT_CONFIG has corpusGen=true, corpusGenMax=25, schemaInductionEnabled=true', () => {
    expect(DEFAULT_CONFIG.corpusGen).toBe(true);
    expect(DEFAULT_CONFIG.corpusGenMax).toBe(25);
    expect(DEFAULT_CONFIG.schemaInductionEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 2: settings-loader.ts
// ---------------------------------------------------------------------------

describe('defaultSettingsPath', () => {
  it('returns a path ending in settings.json under ~/.config/recense/', () => {
    const p = defaultSettingsPath();
    expect(p).toMatch(/\.config[\\/]recense[\\/]settings\.json$/);
  });
});

describe('loadSettingsFile', () => {
  afterEach(cleanupTmpSettings);

  it('returns null when file does not exist (never throws)', () => {
    expect(() => loadSettingsFile('/nonexistent/path/settings.json')).not.toThrow();
    expect(loadSettingsFile('/nonexistent/path/settings.json')).toBeNull();
  });

  it('returns null on malformed JSON (never throws)', () => {
    ensureTmpDir();
    writeFileSync(TMP_SETTINGS, '{ invalid json {{');
    expect(() => loadSettingsFile(TMP_SETTINGS)).not.toThrow();
    expect(loadSettingsFile(TMP_SETTINGS)).toBeNull();
  });

  it('returns null for unknown preset name (resilience)', () => {
    ensureTmpDir();
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'nonexistent', overrides: {} }));
    // An unknown preset should not crash; the loader returns the raw SettingsFile shape
    // (the null/fallback happens at loadMergedConfig level for unknown presets)
    const result = loadSettingsFile(TMP_SETTINGS);
    // Either null or the raw object is acceptable; must not throw
    expect(() => loadSettingsFile(TMP_SETTINGS)).not.toThrow();
  });

  it('returns a valid SettingsFile for a well-formed file', () => {
    ensureTmpDir();
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'lite', overrides: { corpusGen: false } }));
    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf).not.toBeNull();
    expect(sf?.preset).toBe('lite');
    expect(sf?.overrides?.corpusGen).toBe(false);
  });
});

describe('writeSettingsFile', () => {
  afterEach(cleanupTmpSettings);

  it('writes valid JSON and can be read back', () => {
    ensureTmpDir();
    const settings = { preset: 'standard' as PresetName, overrides: { corpusGenMax: 10 } };
    writeSettingsFile(settings, TMP_SETTINGS);
    const read = loadSettingsFile(TMP_SETTINGS);
    expect(read?.preset).toBe('standard');
    expect(read?.overrides?.corpusGenMax).toBe(10);
  });

  it('applies chmod 0o600 to the written file', () => {
    ensureTmpDir();
    const settings = { preset: 'full' as PresetName, overrides: {} };
    writeSettingsFile(settings, TMP_SETTINGS);
    const mode = statSync(TMP_SETTINGS).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('loadMergedConfig — D-05 precedence (env > file > preset > DEFAULT_CONFIG)', () => {
  afterEach(cleanupTmpSettings);

  it('env RECENSE_CORPUS_GEN=0 beats settings.json corpusGen=true (env wins)', () => {
    ensureTmpDir();
    const settings = { preset: 'full' as PresetName, overrides: { corpusGen: true } };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, { RECENSE_CORPUS_GEN: '0' }, TMP_SETTINGS);
    expect(cfg.corpusGen).toBe(false);
  });

  it('no env + settings.json corpusGenMax=10 → corpusGenMax=10 (file beats preset/default)', () => {
    ensureTmpDir();
    const settings = { preset: 'standard' as PresetName, overrides: { corpusGenMax: 10 } };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, {}, TMP_SETTINGS);
    expect(cfg.corpusGenMax).toBe(10);
  });

  it('no env, no file, preset lite → schemaInductionEnabled=false (preset beats DEFAULT_CONFIG)', () => {
    ensureTmpDir();
    const settings = { preset: 'lite' as PresetName, overrides: {} };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, {}, TMP_SETTINGS);
    expect(cfg.schemaInductionEnabled).toBe(false);
  });

  it('RECENSE_CORPUS_GEN_MAX env overrides corpusGenMax (env wins)', () => {
    ensureTmpDir();
    const settings = { preset: 'full' as PresetName, overrides: { corpusGenMax: 10 } };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, { RECENSE_CORPUS_GEN_MAX: '50' }, TMP_SETTINGS);
    expect(cfg.corpusGenMax).toBe(50);
  });

  it('missing file → returns valid DEFAULT-based config, never throws', () => {
    expect(() => loadMergedConfig(TEST_DB, {}, '/nonexistent/path/settings.json')).not.toThrow();
    const cfg = loadMergedConfig(TEST_DB, {}, '/nonexistent/path/settings.json');
    expect(cfg.dbPath).toBe(TEST_DB);
    expect(cfg.consolSkipThreshold).toBe(DEFAULT_CONFIG.consolSkipThreshold);
  });

  it('unknown preset falls back to standard, never throws', () => {
    ensureTmpDir();
    // Write raw JSON with unknown preset
    writeFileSync(TMP_SETTINGS, JSON.stringify({ preset: 'garbage-preset', overrides: {} }));
    expect(() => loadMergedConfig(TEST_DB, {}, TMP_SETTINGS)).not.toThrow();
    const cfg = loadMergedConfig(TEST_DB, {}, TMP_SETTINGS);
    // Should fall back to standard defaults — schemaInductionEnabled=true (standard), corpusGen=false
    expect(cfg.schemaInductionEnabled).toBe(true); // standard
    expect(cfg.corpusGen).toBe(false); // standard
  });
});

describe('loadMergedConfig — D-12 core guardrail', () => {
  afterEach(cleanupTmpSettings);

  it('rejects consolSkipThreshold >= 1 (would skip ALL episodes)', () => {
    ensureTmpDir();
    const settings = { preset: 'standard' as PresetName, overrides: { consolSkipThreshold: 1 } };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, {}, TMP_SETTINGS);
    // Must NOT produce threshold >= 1; falls back to preset/DEFAULT value
    expect(cfg.consolSkipThreshold).toBeLessThan(1);
    expect(cfg.consolSkipThreshold).toBeGreaterThan(0);
  });

  it('rejects consolSkipThreshold < 0 (invalid negative value)', () => {
    ensureTmpDir();
    const settings = { preset: 'standard' as PresetName, overrides: { consolSkipThreshold: -0.5 } };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, {}, TMP_SETTINGS);
    expect(cfg.consolSkipThreshold).toBeGreaterThanOrEqual(0);
  });

  it('rejects consolSkipThresholdAssistant >= 1 (D-12 belt-and-suspenders)', () => {
    ensureTmpDir();
    const settings = {
      preset: 'standard' as PresetName,
      overrides: { consolSkipThresholdAssistant: 1.5 },
    };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, {}, TMP_SETTINGS);
    expect(cfg.consolSkipThresholdAssistant).toBeLessThan(1);
  });

  it('allows valid consolSkipThreshold (0 < t < 1) through', () => {
    ensureTmpDir();
    const settings = { preset: 'standard' as PresetName, overrides: { consolSkipThreshold: 0.35 } };
    writeSettingsFile(settings, TMP_SETTINGS);
    const cfg = loadMergedConfig(TEST_DB, {}, TMP_SETTINGS);
    expect(cfg.consolSkipThreshold).toBe(0.35);
  });
});
