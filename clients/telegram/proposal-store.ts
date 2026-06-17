/**
 * Immutable pending-proposal store with expiry and daily-cap (Phase 23 — D-07, H-05, H-15).
 *
 * Persists a single JSON document { proposals: StoredProposal[]; cap: { date: string; count: number } }
 * at `storePath`, using the same atomic tmp→rename + 0600 chmod pattern from state.ts (WR-01).
 *
 * Design decisions:
 *   D-07: Proposals are stored as-is (deep-copy on write) and returned as deep-copies;
 *         no engine re-query ever happens at the store layer (D-07).
 *   H-05: loadExecutable() refuses to return an expired proposal — the stored payload is
 *         available only within its validity window.
 *   H-15: tryReserveProposalSlot() counts proposals GENERATED (called at DeepSeek-call time),
 *         not proposals sent; the counter persists across restarts.
 *
 * Never throws on read — a corrupt or missing file returns an empty document (safe direction, D-09).
 * Writes are atomic (tmp→rename) with explicit chmodSync for belt-and-suspenders 0600 (WR-01).
 * The tmp file lives in the destination directory to avoid EXDEV on cross-filesystem rename (WR-01).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import type { StoredProposal } from './types';

// ---------------------------------------------------------------------------
// Internal document shape
// ---------------------------------------------------------------------------

interface CapState {
  date: string;   // local YYYY-MM-DD
  count: number;
}

interface ProposalDocument {
  proposals: StoredProposal[];
  cap: CapState;
}

const EMPTY_DOC: ProposalDocument = Object.freeze({
  proposals: [],
  cap: { date: '', count: 0 },
});

// ---------------------------------------------------------------------------
// Low-level read / write
// ---------------------------------------------------------------------------

/** Never throws — corrupt / missing file → empty document. */
function readDoc(storePath: string): ProposalDocument {
  try {
    if (!existsSync(storePath)) return { proposals: [], cap: { date: '', count: 0 } };
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      return { proposals: [], cap: { date: '', count: 0 } };
    }
    const obj = raw as Record<string, unknown>;

    const proposals = Array.isArray(obj['proposals'])
      ? (obj['proposals'] as unknown[]).filter((p): p is StoredProposal =>
          typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>)['id'] === 'string',
        )
      : [];

    const rawCap = obj['cap'];
    const cap: CapState =
      typeof rawCap === 'object' && rawCap !== null &&
      typeof (rawCap as Record<string, unknown>)['date'] === 'string' &&
      typeof (rawCap as Record<string, unknown>)['count'] === 'number'
        ? {
            date: (rawCap as Record<string, unknown>)['date'] as string,
            count: (rawCap as Record<string, unknown>)['count'] as number,
          }
        : { date: '', count: 0 };

    return { proposals, cap };
  } catch {
    return { proposals: [], cap: { date: '', count: 0 } };
  }
}

/**
 * Atomic 0600 write: tmp file in destination dir (WR-01 EXDEV-safe) → chmodSync → renameSync.
 */
function writeDoc(storePath: string, doc: ProposalDocument): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = join(
    dirname(storePath),
    `.proposal-store-${Date.now()}-${process.pid}.tmp`,
  );
  writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  chmodSync(tmp, 0o600); // belt-and-suspenders against umask (WR-01)
  renameSync(tmp, storePath);
}

// ---------------------------------------------------------------------------
// Expiry (D-07 / H-05)
// ---------------------------------------------------------------------------

/**
 * Returns true when the proposal's approval window has closed.
 *
 * Two expiry conditions (OR):
 *   1. now > Date.parse(p.dueAt)             — past the item's deadline
 *   2. now > Date.parse(p.createdAt) + p.maxTtlMs — absolute TTL exceeded
 *
 * @param p   The proposal to test.
 * @param now Epoch ms (injectable for deterministic tests).
 */
export function isExpired(p: StoredProposal, now: number): boolean {
  return now > Date.parse(p.dueAt) || now > Date.parse(p.createdAt) + p.maxTtlMs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a proposal. If an entry with the same id already exists it is replaced
 * (idempotent put). The proposal is deep-cloned before writing so mutations to `p`
 * after the call do not affect the stored value (D-07 immutability).
 */
export function putProposal(p: StoredProposal, storePath: string): void {
  const doc = readDoc(storePath);
  // Remove any existing entry with the same id to avoid duplicates
  doc.proposals = doc.proposals.filter(q => q.id !== p.id);
  // Deep-copy before storing so caller mutations don't affect the persisted payload (D-07)
  doc.proposals.push(JSON.parse(JSON.stringify(p)) as StoredProposal);
  writeDoc(storePath, doc);
}

/**
 * Return the proposal with `id`, or null if not found.
 *
 * During read, expired entries are removed from the persistent store (cleanup-on-read).
 * The entry being queried is returned from the pre-cleanup snapshot even if it is
 * expired — the caller-facing `loadExecutable` is the enforcement point for execution
 * eligibility (H-05). The returned value is a deep-copy to prevent TOCTOU mutations
 * (D-07 immutability).
 */
export function getProposal(id: string, storePath: string): StoredProposal | null {
  const doc = readDoc(storePath);
  const now = Date.now();

  // Find the target before cleanup so we can return it even if expired
  const target = doc.proposals.find(p => p.id === id);

  // Cleanup: remove all expired entries from the persistent store
  const active = doc.proposals.filter(p => !isExpired(p, now));
  if (active.length !== doc.proposals.length) {
    writeDoc(storePath, { ...doc, proposals: active });
  }

  return target !== undefined ? (JSON.parse(JSON.stringify(target)) as StoredProposal) : null;
}

/**
 * Remove the proposal with `id` from the store. No-op if not found.
 */
export function removeProposal(id: string, storePath: string): void {
  const doc = readDoc(storePath);
  const filtered = doc.proposals.filter(p => p.id !== id);
  if (filtered.length !== doc.proposals.length) {
    writeDoc(storePath, { ...doc, proposals: filtered });
  }
  // If nothing to remove, still write once to create the file with 0600 if missing
  // (no-op is fine — caller does not rely on side effects here)
}

/**
 * High-level load for the execute path (H-05 / D-07).
 *
 * Checks expiry before returning the payload. An expired proposal is removed from
 * the persistent store as a side effect.
 *
 * @param id        proposalId from the callback_data.
 * @param storePath path to the proposal store file.
 * @param now       Epoch ms (injectable for deterministic tests).
 */
export function loadExecutable(
  id: string,
  storePath: string,
  now: number,
):
  | { status: 'ok'; proposal: StoredProposal }
  | { status: 'expired' }
  | { status: 'missing' } {
  const doc = readDoc(storePath);
  const proposal = doc.proposals.find(p => p.id === id);

  if (proposal === undefined) {
    return { status: 'missing' };
  }

  if (isExpired(proposal, now)) {
    // Clean up the expired entry — it is no longer executable (H-05)
    const cleaned = doc.proposals.filter(p => p.id !== id);
    writeDoc(storePath, { ...doc, proposals: cleaned });
    return { status: 'expired' };
  }

  // Deep-copy the payload — immutable return (D-07)
  return { status: 'ok', proposal: JSON.parse(JSON.stringify(proposal)) as StoredProposal };
}

// ---------------------------------------------------------------------------
// Daily proposal cap (H-15)
// ---------------------------------------------------------------------------

/** Compute local YYYY-MM-DD string for the given Date. */
function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Try to reserve a proposal slot for today (H-15).
 *
 * Counts proposals GENERATED (called at DeepSeek-call time), NOT proposals sent to
 * Telegram. This prevents approval-fatigue DoS even when proposals are snoozed or
 * re-sent.
 *
 * Returns true and increments the persisted count when today's count < `dailyCap`.
 * Returns false (without incrementing) when at or over the cap.
 * The count resets when the persisted date differs from today's local date.
 *
 * @param dailyCap  Maximum proposals allowed per local calendar day.
 * @param storePath Path to the proposal store file.
 * @param now       Injectable Date for deterministic testing.
 */
export function tryReserveProposalSlot(
  dailyCap: number,
  storePath: string,
  now: Date,
): boolean {
  const doc = readDoc(storePath);
  const today = toLocalDate(now);

  // Date rollover → reset count
  if (doc.cap.date !== today) {
    doc.cap = { date: today, count: 0 };
  }

  if (doc.cap.count >= dailyCap) {
    return false;
  }

  doc.cap.count++;
  writeDoc(storePath, doc);
  return true;
}

/**
 * Return the current cap state for inspection.
 * Returns { date: '', count: 0 } when the store has never been written to.
 */
export function getCapState(storePath: string): CapState {
  const doc = readDoc(storePath);
  return { ...doc.cap };
}

// Satisfy TypeScript that EMPTY_DOC is used (prevents unused-variable lint)
void EMPTY_DOC;
