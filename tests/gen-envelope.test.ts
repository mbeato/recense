/**
 * gen-envelope.test.ts — unit tests for buildGeneratingEnvelope key-presence contract.
 *
 * The viz server delegates 202 body construction to the pure buildGeneratingEnvelope helper
 * (src/adapter/gen-status.ts). These tests prove the envelope contract:
 *   - phase:'failed' + error forwarded when status carries them
 *   - phase and error keys ABSENT (not undefined) when status is null
 *   - JSON.stringify of null-status result never contains "error" substring
 *
 * Pure in-memory: no FS, no network, no spawn.
 */
import { describe, test, expect } from 'vitest';
import { buildGeneratingEnvelope } from '../src/adapter/gen-status';
import type { GenStatus } from '../src/adapter/gen-status';

const NOW = Date.now();

// ---------------------------------------------------------------------------
// Case (a): failed status — phase and error must both be forwarded
// ---------------------------------------------------------------------------

describe('buildGeneratingEnvelope — failed status', () => {
  const failedStatus: GenStatus = {
    phase: 'failed',
    error: 'engine stayed busy',
    startedAt: NOW - 1200,
    updatedAt: NOW,
  };

  test('status key is always "generating"', () => {
    const env = buildGeneratingEnvelope(failedStatus, 1200);
    expect(env.status).toBe('generating');
  });

  test('elapsedMs is passed through', () => {
    const env = buildGeneratingEnvelope(failedStatus, 1200);
    expect(env.elapsedMs).toBe(1200);
  });

  test('phase:"failed" is forwarded', () => {
    const env = buildGeneratingEnvelope(failedStatus, 1200);
    expect(env.phase).toBe('failed');
  });

  test('error message is forwarded', () => {
    const env = buildGeneratingEnvelope(failedStatus, 1200);
    expect(env.error).toBe('engine stayed busy');
  });

  test('envelope matches expected shape', () => {
    const env = buildGeneratingEnvelope(failedStatus, 1200);
    expect(env).toMatchObject({
      status: 'generating',
      elapsedMs: 1200,
      phase: 'failed',
      error: 'engine stayed busy',
    });
  });
});

// ---------------------------------------------------------------------------
// Case (b): null status — phase and error keys must be ABSENT
// ---------------------------------------------------------------------------

describe('buildGeneratingEnvelope — null status', () => {
  test('status key is "generating"', () => {
    const env = buildGeneratingEnvelope(null, 0);
    expect(env.status).toBe('generating');
  });

  test('elapsedMs is 0', () => {
    const env = buildGeneratingEnvelope(null, 0);
    expect(env.elapsedMs).toBe(0);
  });

  test('"phase" key is ABSENT (not undefined)', () => {
    const env = buildGeneratingEnvelope(null, 0);
    expect('phase' in env).toBe(false);
  });

  test('"error" key is ABSENT (not undefined)', () => {
    const env = buildGeneratingEnvelope(null, 0);
    expect('error' in env).toBe(false);
  });

  test('JSON.stringify does not contain "error" substring', () => {
    const env = buildGeneratingEnvelope(null, 0);
    const json = JSON.stringify(env);
    expect(json).not.toContain('"error"');
  });
});

// ---------------------------------------------------------------------------
// Case (c): non-failed status — phase forwarded, error key absent
// ---------------------------------------------------------------------------

describe('buildGeneratingEnvelope — non-failed status', () => {
  const gatheringStatus: GenStatus = {
    phase: 'gathering',
    startedAt: NOW - 500,
    updatedAt: NOW,
  };

  test('phase:"gathering" is forwarded', () => {
    const env = buildGeneratingEnvelope(gatheringStatus, 500);
    expect(env.phase).toBe('gathering');
  });

  test('elapsedMs is passed through', () => {
    const env = buildGeneratingEnvelope(gatheringStatus, 500);
    expect(env.elapsedMs).toBe(500);
  });

  test('"error" key is ABSENT when status has no error', () => {
    const env = buildGeneratingEnvelope(gatheringStatus, 500);
    expect('error' in env).toBe(false);
  });
});
