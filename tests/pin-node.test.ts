/**
 * Tests for src/adapter/pin-node.ts — the pure decision logic of the Node-runtime pin.
 *
 * Covers readPinnedNodeBin (env override + env-file parse) and shouldReexec (the skip/go
 * decision). The imperative pinNodeRuntime (spawnSync + process.exit) is verified manually
 * by running `brain` under a mismatched Node — not unit-tested here.
 */
import { describe, it, expect } from 'vitest';
import { readPinnedNodeBin, shouldReexec } from '../src/adapter/pin-node';

describe('readPinnedNodeBin', () => {
  const FILE = '/fake/sleep.env';
  const fileWith = (content: string) => ({
    exists: (_p: string) => true,
    readFile: (_p: string) => content,
  });

  it('env override (RECENSE_NODE_BIN) wins over the file', () => {
    const bin = readPinnedNodeBin(FILE, '/usr/bin/node', fileWith('RECENSE_NODE_BIN=/other/node'));
    expect(bin).toBe('/usr/bin/node');
  });

  it('parses RECENSE_NODE_BIN from the env file when no override', () => {
    const content = [
      '# comment',
      'RECENSE_NODE_BIN=/Users/x/.nvm/versions/node/v25.5.0/bin/node',
      'RECENSE_DB=/Users/x/recense.db',
      'ANTHROPIC_API_KEY=secret',
    ].join('\n');
    const bin = readPinnedNodeBin(FILE, undefined, fileWith(content));
    expect(bin).toBe('/Users/x/.nvm/versions/node/v25.5.0/bin/node');
  });

  it('strips surrounding quotes from the value', () => {
    const bin = readPinnedNodeBin(FILE, undefined, fileWith('RECENSE_NODE_BIN="/path/with space/node"'));
    expect(bin).toBe('/path/with space/node');
  });

  it('returns undefined when the env file is absent', () => {
    const bin = readPinnedNodeBin(FILE, undefined, { exists: () => false, readFile: () => '' });
    expect(bin).toBeUndefined();
  });

  it('returns undefined when the key is not present in the file', () => {
    const bin = readPinnedNodeBin(FILE, undefined, fileWith('RECENSE_DB=/x/recense.db'));
    expect(bin).toBeUndefined();
  });

  it('ignores an empty/whitespace override and falls back to the file', () => {
    const bin = readPinnedNodeBin(FILE, '   ', fileWith('RECENSE_NODE_BIN=/file/node'));
    expect(bin).toBe('/file/node');
  });
});

describe('shouldReexec', () => {
  const present = { exists: (_p: string) => true };

  it('returns the pinned bin when on a different Node than the pin', () => {
    expect(shouldReexec('/nvm/v25/bin/node', '/nvm/v22/bin/node', false, present)).toBe('/nvm/v25/bin/node');
  });

  it('returns null when already running under the pinned bin', () => {
    expect(shouldReexec('/nvm/v25/bin/node', '/nvm/v25/bin/node', false, present)).toBeNull();
  });

  it('returns null when the re-exec guard is already set (one-hop)', () => {
    expect(shouldReexec('/nvm/v25/bin/node', '/nvm/v22/bin/node', true, present)).toBeNull();
  });

  it('returns null when no pin is configured', () => {
    expect(shouldReexec(undefined, '/nvm/v22/bin/node', false, present)).toBeNull();
  });

  it('returns null when the pinned bin is missing on disk (best-effort)', () => {
    expect(shouldReexec('/nvm/v25/bin/node', '/nvm/v22/bin/node', false, { exists: () => false })).toBeNull();
  });
});
