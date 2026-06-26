/**
 * gen-status.ts — unit tests for the shared generation-status file primitives.
 *
 * Covers: PHASES array, statusPath determinism + traversal-safety, writeStatus/readStatus
 * round-trip, startedAt preservation, error field, staleness, clearStatus, and
 * buildGeneratingEnvelope key-presence invariants.
 *
 * FS cleanup: clearStatus in afterEach for all slugs written by tests.
 */
import { writeFileSync } from 'fs';
import { describe, test, expect, afterEach } from 'vitest';
import {
  PHASES,
  statusPath,
  writeStatus,
  readStatus,
  clearStatus,
  buildGeneratingEnvelope,
} from '../src/adapter/gen-status';

const STATUS_DIR = '/tmp/recense-gen-status/';

// Slugs used across tests — cleared in afterEach.
const TEST_SLUG = `test-slug-${process.pid}`;
const TRAVERSAL_SLUG_1 = '../../etc/passwd';
const TRAVERSAL_SLUG_2 = 'a/b/c';

afterEach(() => {
  // Best-effort cleanup: remove status files written by any test.
  clearStatus(TEST_SLUG);
  clearStatus(TRAVERSAL_SLUG_1);
  clearStatus(TRAVERSAL_SLUG_2);
});

// ---------------------------------------------------------------------------
// PHASES array
// ---------------------------------------------------------------------------

describe('PHASES', () => {
  test('contains the 7 locked phases in order', () => {
    expect(PHASES).toEqual([
      'queued',
      'gathering',
      'generating',
      'verifying',
      'finalizing',
      'done',
      'failed',
    ]);
  });

  test('is frozen (immutable)', () => {
    expect(Object.isFrozen(PHASES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// statusPath — determinism and traversal-safety
// ---------------------------------------------------------------------------

describe('statusPath', () => {
  test('returns a deterministic path under the status dir', () => {
    const p1 = statusPath('my-slug');
    const p2 = statusPath('my-slug');
    expect(p1).toBe(p2);
    expect(p1.startsWith(STATUS_DIR)).toBe(true);
  });

  test('different slugs produce different paths', () => {
    expect(statusPath('slug-a')).not.toBe(statusPath('slug-b'));
  });

  test('traversal slug ../../etc/passwd stays inside status dir', () => {
    const p = statusPath(TRAVERSAL_SLUG_1);
    expect(p.startsWith(STATUS_DIR)).toBe(true);
    expect(p).not.toContain('..');
    expect(p).not.toContain('etc/passwd');
  });

  test('traversal slug a/b/c stays inside status dir', () => {
    const p = statusPath(TRAVERSAL_SLUG_2);
    expect(p.startsWith(STATUS_DIR)).toBe(true);
  });

  test('returned path ends with .json', () => {
    expect(statusPath(TEST_SLUG).endsWith('.json')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeStatus / readStatus — round-trip
// ---------------------------------------------------------------------------

describe('writeStatus / readStatus round-trip', () => {
  test('read of a never-written slug returns null', () => {
    expect(readStatus(`never-written-${process.pid}`)).toBeNull();
  });

  test('write then read returns correct phase and timestamps', () => {
    const before = Date.now();
    writeStatus(TEST_SLUG, 'gathering');
    const after = Date.now();

    const status = readStatus(TEST_SLUG);
    expect(status).not.toBeNull();
    expect(status!.phase).toBe('gathering');
    expect(status!.startedAt).toBeGreaterThanOrEqual(before);
    expect(status!.startedAt).toBeLessThanOrEqual(after);
    expect(status!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(status!.updatedAt).toBeLessThanOrEqual(after);
    expect('error' in status!).toBe(false);
  });

  test('second writeStatus preserves startedAt and bumps updatedAt', async () => {
    writeStatus(TEST_SLUG, 'gathering');
    const first = readStatus(TEST_SLUG)!;
    const firstStartedAt = first.startedAt;

    // Small delay so updatedAt can actually change
    await new Promise((r) => setTimeout(r, 10));

    writeStatus(TEST_SLUG, 'generating');
    const second = readStatus(TEST_SLUG)!;

    expect(second.phase).toBe('generating');
    expect(second.startedAt).toBe(firstStartedAt); // preserved
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt); // bumped
  });

  test('writeStatus with error field stores error and readStatus returns it', () => {
    writeStatus(TEST_SLUG, 'failed', { error: 'engine stayed busy' });
    const status = readStatus(TEST_SLUG)!;
    expect(status.phase).toBe('failed');
    expect(status.error).toBe('engine stayed busy');
  });

  test('writeStatus without error leaves no error key on result', () => {
    writeStatus(TEST_SLUG, 'gathering');
    const status = readStatus(TEST_SLUG)!;
    expect('error' in status).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Staleness — readStatus returns null past STALE_MS
// ---------------------------------------------------------------------------

describe('staleness', () => {
  test('readStatus returns null when updatedAt is older than stale threshold', () => {
    // Write a valid status file...
    writeStatus(TEST_SLUG, 'generating');

    // ...then overwrite the file with a back-dated updatedAt (>15min ago)
    const stalePath = statusPath(TEST_SLUG);
    const staleTs = Date.now() - 20 * 60 * 1000; // 20 minutes ago
    const staleContent = JSON.stringify({
      phase: 'generating',
      startedAt: staleTs - 1000,
      updatedAt: staleTs,
    });
    writeFileSync(stalePath, staleContent, 'utf8');

    expect(readStatus(TEST_SLUG)).toBeNull();
  });

  test('readStatus returns the status when updatedAt is recent', () => {
    writeStatus(TEST_SLUG, 'verifying');
    // Should not be null for a just-written status
    expect(readStatus(TEST_SLUG)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearStatus
// ---------------------------------------------------------------------------

describe('clearStatus', () => {
  test('clearStatus removes the file; subsequent readStatus returns null', () => {
    writeStatus(TEST_SLUG, 'gathering');
    expect(readStatus(TEST_SLUG)).not.toBeNull();

    clearStatus(TEST_SLUG);
    expect(readStatus(TEST_SLUG)).toBeNull();
  });

  test('clearStatus on a missing file does not throw', () => {
    expect(() => clearStatus(`never-written-clear-${process.pid}`)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildGeneratingEnvelope — key-presence invariants
// ---------------------------------------------------------------------------

describe('buildGeneratingEnvelope', () => {
  test('null status → {status,elapsedMs} with no phase key and no error key', () => {
    const env = buildGeneratingEnvelope(null, 0);
    expect(env.status).toBe('generating');
    expect(env.elapsedMs).toBe(0);
    expect('phase' in env).toBe(false);
    expect('error' in env).toBe(false);
  });

  test('failed status → phase and error carried through', () => {
    const statusObj = {
      phase: 'failed' as const,
      startedAt: Date.now() - 5000,
      updatedAt: Date.now(),
      error: 'engine stayed busy',
    };
    const env = buildGeneratingEnvelope(statusObj, 1200);
    expect(env.status).toBe('generating');
    expect(env.elapsedMs).toBe(1200);
    expect(env.phase).toBe('failed');
    expect(env.error).toBe('engine stayed busy');
  });

  test('non-failed status → phase carried, error key absent', () => {
    const statusObj = {
      phase: 'gathering' as const,
      startedAt: Date.now() - 500,
      updatedAt: Date.now(),
    };
    const env = buildGeneratingEnvelope(statusObj, 500);
    expect(env.status).toBe('generating');
    expect(env.elapsedMs).toBe(500);
    expect(env.phase).toBe('gathering');
    expect('error' in env).toBe(false);
  });

  test('elapsedMs is set correctly for any value', () => {
    const env = buildGeneratingEnvelope(null, 9999);
    expect(env.elapsedMs).toBe(9999);
  });
});
