/**
 * gen-status.ts — shared status-file primitives for the reader generation pipeline.
 *
 * The detached `generate-doc` CLI (sole writer) uses writeStatus to report phase.
 * The read-only viz server (reader) uses readStatus to surface phase in the 202 envelope.
 * buildGeneratingEnvelope is a pure helper for constructing the 202 body.
 *
 * Atomic write discipline: write to a per-call temp sibling then renameSync into place,
 * mirroring lockfile.ts's discipline so the server never reads a half-written file.
 *
 * Path-traversal guard: statusPath hashes the slug via sha1.slice(0,16) so no `/` or
 * `..` from a URL-supplied slug can escape the status directory. Satisfies T-39.3-01.
 *
 * Stale detection: readStatus returns null when updatedAt is older than STALE_MS so a
 * crashed child reads as absent and the reader never freezes. Satisfies T-39.3-03.
 *
 * Leaf module: no imports from src/reader, src/viz, or src/consolidation.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Frozen ordered list of generation phases. The lock on this array is D-1.
 */
export const PHASES = Object.freeze([
  'queued',
  'gathering',
  'generating',
  'verifying',
  'finalizing',
  'done',
  'failed',
] as const);

export type Phase = (typeof PHASES)[number];

/** Directory where per-slug status JSON files are stored. */
const STATUS_DIR = '/tmp/recense-gen-status/';

/**
 * Treat updatedAt older than this as a crashed child — readStatus returns null.
 * ~15 min, matching the spec's "~15min" guidance.
 */
export const STALE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenStatus {
  phase: Phase;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface GeneratingEnvelope {
  status: 'generating';
  elapsedMs: number;
  phase?: Phase;
  error?: string;
}

// ---------------------------------------------------------------------------
// statusPath — path-safe slug → file path
// ---------------------------------------------------------------------------

/**
 * Return the absolute path for the status file of `slug`.
 *
 * Uses sha1(slug).slice(0,16) as the filename so no path separators or `..`
 * from a URL-supplied slug can escape the status directory (T-39.3-01).
 */
export function statusPath(slug: string): string {
  const hash = createHash('sha1').update(slug).digest('hex').slice(0, 16);
  return join(STATUS_DIR, `${hash}.json`);
}

// ---------------------------------------------------------------------------
// writeStatus — atomic write via temp-then-rename
// ---------------------------------------------------------------------------

/**
 * Write a status file for `slug` with the given `phase` and optional `extra` fields.
 *
 * Preserves `startedAt` from an existing status file across phase transitions.
 * Always bumps `updatedAt` to now.
 * `error` is included only when supplied in `extra`.
 *
 * Atomic: writes to a `.tmp` sibling then renameSync into place so the reader
 * never observes a half-written file.
 */
export function writeStatus(
  slug: string,
  phase: Phase,
  extra?: { error?: string },
): void {
  // Ensure status dir exists on first write (not at import time).
  mkdirSync(STATUS_DIR, { recursive: true });

  const path = statusPath(slug);

  // Preserve startedAt from an existing file if present and parseable.
  let startedAt: number | undefined;
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as Partial<GenStatus>;
      if (typeof existing.startedAt === 'number') {
        startedAt = existing.startedAt;
      }
    } catch {
      // Malformed existing file — start fresh
    }
  }

  const now = Date.now();
  const record: GenStatus = {
    phase,
    startedAt: startedAt ?? now,
    updatedAt: now,
  };

  if (extra?.error !== undefined) {
    record.error = extra.error;
  }

  // Atomic place: write to temp then rename.
  const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of temp file on failure.
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// readStatus — parse or return null on missing/stale
// ---------------------------------------------------------------------------

/**
 * Read the status file for `slug`.
 *
 * Returns the parsed GenStatus, or null when:
 * - the file does not exist, OR
 * - the file is unparseable, OR
 * - updatedAt is older than STALE_MS (treats crashed child as absent; T-39.3-03).
 */
export function readStatus(slug: string): GenStatus | null {
  const path = statusPath(slug);
  if (!existsSync(path)) return null;

  let record: GenStatus;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as GenStatus;
  } catch {
    return null;
  }

  if (
    typeof record.phase !== 'string' ||
    typeof record.startedAt !== 'number' ||
    typeof record.updatedAt !== 'number'
  ) {
    return null;
  }

  if (Date.now() - record.updatedAt >= STALE_MS) {
    return null;
  }

  return record;
}

// ---------------------------------------------------------------------------
// clearStatus — remove status file; no-op when absent
// ---------------------------------------------------------------------------

/**
 * Remove the status file for `slug`.
 * Safe to call when no file exists.
 */
export function clearStatus(slug: string): void {
  const path = statusPath(slug);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // ENOENT = already gone; no-op
  }
}

// ---------------------------------------------------------------------------
// buildGeneratingEnvelope — pure 202-body builder (no FS, no IO)
// ---------------------------------------------------------------------------

/**
 * Build the 202 "generating" envelope for the viz server's /doc/generate response.
 *
 * Pure function — no filesystem access, no I/O. The viz server wires readStatus
 * to produce `status` and passes `elapsedMs` from its in-flight Set bookkeeping.
 *
 * Key-presence invariants (critical for T-39.3-01 + acceptance tests):
 * - `phase` key is present ONLY when status?.phase is defined.
 * - `error` key is present ONLY when status?.error is defined.
 * - NEVER emits phase:undefined or error:undefined.
 */
export function buildGeneratingEnvelope(
  status: GenStatus | null,
  elapsedMs: number,
): GeneratingEnvelope {
  const envelope: GeneratingEnvelope = { status: 'generating', elapsedMs };

  if (status?.phase !== undefined) {
    envelope.phase = status.phase;
  }

  if (status?.error !== undefined) {
    envelope.error = status.error;
  }

  return envelope;
}
