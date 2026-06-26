/**
 * Contract tests for settingsHasAnthropicKey (D-14, Plan 45-01).
 *
 * Covers the four-outcome contract:
 *   (a) key-present:      settings.json with env.ANTHROPIC_API_KEY set & non-empty -> true
 *   (b) key-absent:       settings.json with empty env block or missing key -> false
 *   (c) empty-string key: settings.json with env.ANTHROPIC_API_KEY="" -> false (non-empty required)
 *   (d) missing-file:     path does not exist -> false, no throw
 *   (e) malformed-JSON:   file contains invalid JSON -> false, no throw
 *
 * Security invariant (T-45-01): no test asserts on the key VALUE; only the boolean result.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsHasAnthropicKey } from '../src/adapter/claude-settings-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(suffix: string): string {
  const dir = join(tmpdir(), `claude-settings-detector-${process.pid}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSettings(dir: string, content: unknown): string {
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settingsHasAnthropicKey', () => {
  // (a) key present — well-formed settings.json with a non-empty ANTHROPIC_API_KEY
  it('(a) returns true when ANTHROPIC_API_KEY is set and non-empty', () => {
    const dir = makeTmpDir('a');
    try {
      const file = writeSettings(dir, { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-xxx' } });
      expect(settingsHasAnthropicKey(file)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  // (b) key absent — env block present but key missing
  it('(b) returns false when env block exists but ANTHROPIC_API_KEY is absent', () => {
    const dir = makeTmpDir('b-absent');
    try {
      const file = writeSettings(dir, { env: { OTHER_KEY: 'value' } });
      expect(settingsHasAnthropicKey(file)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  // (b2) key absent — no env block at all
  it('(b2) returns false when settings.json has no env block', () => {
    const dir = makeTmpDir('b-noenv');
    try {
      const file = writeSettings(dir, { hooks: {} });
      expect(settingsHasAnthropicKey(file)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  // (c) empty-string key — must be non-empty per D-14
  it('(c) returns false when ANTHROPIC_API_KEY is an empty string', () => {
    const dir = makeTmpDir('c');
    try {
      const file = writeSettings(dir, { env: { ANTHROPIC_API_KEY: '' } });
      expect(settingsHasAnthropicKey(file)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  // (d) missing file — path does not exist
  it('(d) returns false (no throw) when the settings file does not exist', () => {
    const missingPath = join(tmpdir(), `claude-settings-detector-${process.pid}-nonexistent.json`);
    expect(() => settingsHasAnthropicKey(missingPath)).not.toThrow();
    expect(settingsHasAnthropicKey(missingPath)).toBe(false);
  });

  // (e) malformed JSON — file exists but contains invalid JSON
  it('(e) returns false (no throw) when settings file contains malformed JSON', () => {
    const dir = makeTmpDir('e');
    try {
      const file = join(dir, 'settings.json');
      writeFileSync(file, '{not valid json', 'utf8');
      expect(() => settingsHasAnthropicKey(file)).not.toThrow();
      expect(settingsHasAnthropicKey(file)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
