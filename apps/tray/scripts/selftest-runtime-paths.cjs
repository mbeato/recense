#!/usr/bin/env node
'use strict';

/**
 * Zero-framework self-test for runtime-paths.ts (compiled to dist/runtime-paths.js).
 *
 * Asserts path-resolution precedence rules:
 *   (a) BRAIN_MEMORY_NODE_BIN env wins over sleep.env and fallback
 *   (b) sleep.env BRAIN_MEMORY_NODE_BIN= line is parsed when env is unset
 *   (c) 'node' is returned when neither env nor sleep.env has the value
 *   (d) resolveBrainJs() derives dirname(BRAIN_MEMORY_SLEEP_JS)/brain.js
 *
 * Run: node scripts/selftest-runtime-paths.cjs  (after tsc compiles dist/)
 * Exit non-zero on any failed assertion.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Require the COMPILED dist/src/runtime-paths.js (tsc must have run first).
// Note: rootDir="." with include=["src"] → output lands at dist/src/ not dist/
const {
  resolveNodeBin,
  resolveBrainJs,
  resolveDbPath,
  defaultDbPath,
  sleepEnvPath,
} = require('../dist/src/runtime-paths');

const tmpdir = os.tmpdir();
let passed = 0;
let failed = 0;

/** Run a single named test, catching assertion errors. */
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Set env vars from an object, run fn, restore originals.
 * Keys whose value is undefined are deleted.
 */
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  try {
    for (const [key, val] of Object.entries(overrides)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

// ── (a) BRAIN_MEMORY_NODE_BIN env wins ───────────────────────────────────────
test('resolveNodeBin: env var wins', () => {
  withEnv(
    {
      BRAIN_MEMORY_NODE_BIN: '/env/node',
      BRAIN_MEMORY_SLEEP_ENV: path.join(tmpdir, `nonexistent-${Date.now()}.env`),
    },
    () => {
      const result = resolveNodeBin();
      assert.strictEqual(result, '/env/node', `Expected '/env/node', got '${result}'`);
    },
  );
});

// ── (b) sleep.env parse when env unset ───────────────────────────────────────
test('resolveNodeBin: sleep.env parse (quoted value)', () => {
  const tmpEnv = path.join(tmpdir, `selftest-sleep-${Date.now()}.env`);
  fs.writeFileSync(tmpEnv, 'BRAIN_MEMORY_NODE_BIN="/x/node"\n');
  try {
    withEnv(
      { BRAIN_MEMORY_NODE_BIN: undefined, BRAIN_MEMORY_SLEEP_ENV: tmpEnv },
      () => {
        const result = resolveNodeBin();
        assert.strictEqual(result, '/x/node', `Expected '/x/node', got '${result}'`);
      },
    );
  } finally {
    fs.unlinkSync(tmpEnv);
  }
});

// ── (c) fallback to 'node' ────────────────────────────────────────────────────
test("resolveNodeBin: falls back to 'node' when nothing set", () => {
  withEnv(
    {
      BRAIN_MEMORY_NODE_BIN: undefined,
      BRAIN_MEMORY_SLEEP_ENV: path.join(tmpdir, `nonexistent-${Date.now()}.env`),
    },
    () => {
      const result = resolveNodeBin();
      assert.strictEqual(result, 'node', `Expected 'node', got '${result}'`);
    },
  );
});

// ── (d) resolveBrainJs: sibling derivation ───────────────────────────────────
test('resolveBrainJs: derives sibling brain.js from BRAIN_MEMORY_SLEEP_JS', () => {
  const tmpEnv = path.join(tmpdir, `selftest-brain-${Date.now()}.env`);
  fs.writeFileSync(
    tmpEnv,
    'BRAIN_MEMORY_SLEEP_JS=/r/dist/src/adapter/sleep-pass-cli.js\n',
  );
  try {
    withEnv(
      { BRAIN_MEMORY_BRAIN_JS: undefined, BRAIN_MEMORY_SLEEP_ENV: tmpEnv },
      () => {
        const result = resolveBrainJs();
        const expected = '/r/dist/src/adapter/brain.js';
        assert.strictEqual(result, expected, `Expected '${expected}', got '${result}'`);
      },
    );
  } finally {
    fs.unlinkSync(tmpEnv);
  }
});

// ── resolveDbPath: --db flag wins ─────────────────────────────────────────────
test('resolveDbPath: --db flag wins', () => {
  withEnv({ BRAIN_MEMORY_DB: '/env/brain.db' }, () => {
    const result = resolveDbPath(['node', 'brain.js', '--db', '/flag/brain.db']);
    assert.strictEqual(result, '/flag/brain.db', `Expected '/flag/brain.db', got '${result}'`);
  });
});

// ── resolveDbPath: env wins over default ──────────────────────────────────────
test('resolveDbPath: BRAIN_MEMORY_DB env wins over default', () => {
  withEnv({ BRAIN_MEMORY_DB: '/env/brain.db' }, () => {
    const result = resolveDbPath(['node', 'brain.js']);
    assert.strictEqual(result, '/env/brain.db', `Expected '/env/brain.db', got '${result}'`);
  });
});

// ── defaultDbPath is ~/.config/brain-memory/brain.db ─────────────────────────
test('defaultDbPath: correct default path', () => {
  const result = defaultDbPath();
  const expected = path.join(os.homedir(), '.config', 'brain-memory', 'brain.db');
  assert.strictEqual(result, expected, `Expected '${expected}', got '${result}'`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
