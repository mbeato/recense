import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * The belief-proposal batching ledger (Phase 68 — D-07/APPROVE-03): tracks how many
 * prompts have already been sent per entity for the current local calendar day, so a
 * pass never sends a second prompt for the same entity on the same day. Mirrors
 * proposal-store.ts's CapState { date, count } naming symmetry.
 */
export interface BeliefPromptLedger {
  /** Local YYYY-MM-DD the counts apply to. */
  date: string;
  /** entityDescriptor -> number of prompts sent for that entity today. */
  counts: Record<string, number>;
}

const EMPTY_LEDGER: BeliefPromptLedger = { date: '', counts: {} };

/**
 * The full persisted state document. `cursor` is the Telegram getUpdates cursor
 * (pre-Phase-68 shape); `beliefPromptLedger` is optional so an old document with no
 * ledger field still reads cleanly.
 */
interface StateDocument {
  cursor: string | null;
  beliefPromptLedger?: BeliefPromptLedger;
}

// ---------------------------------------------------------------------------
// Low-level read / write — read-modify-write over the WHOLE document (Phase 68
// correctness fix, not an addition).
//
// Before this fix, writeStateCursor serialized JSON.stringify({ cursor }) directly,
// which clobbers every sibling key in the document. Without this fix, every reactive
// poll tick (which calls writeStateCursor far more often than the belief poll runs)
// would silently erase the belief prompt ledger on its very next write, and
// per-entity-per-day batching would stop working within one poll interval. Both
// writers below now go through readDoc()/writeDoc() so a write to one field never
// touches the other.
// ---------------------------------------------------------------------------

/** Never throws — corrupt / missing file → { cursor: null } (no ledger). */
function readDoc(statePath: string): StateDocument {
  try {
    if (!existsSync(statePath)) return { cursor: null };
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return { cursor: null };
    const obj = raw as Record<string, unknown>;

    const doc: StateDocument = {
      cursor: typeof obj['cursor'] === 'string' ? obj['cursor'] : null,
    };

    const rawLedger = obj['beliefPromptLedger'];
    if (
      typeof rawLedger === 'object' && rawLedger !== null &&
      typeof (rawLedger as Record<string, unknown>)['date'] === 'string' &&
      typeof (rawLedger as Record<string, unknown>)['counts'] === 'object' &&
      (rawLedger as Record<string, unknown>)['counts'] !== null
    ) {
      doc.beliefPromptLedger = {
        date: (rawLedger as Record<string, unknown>)['date'] as string,
        counts: (rawLedger as Record<string, unknown>)['counts'] as Record<string, number>,
      };
    }

    return doc;
  } catch {
    return { cursor: null }; // unreadable state → cold start (safe direction, D-09)
  }
}

/**
 * Atomically write the whole state document to `statePath`.
 *
 * Uses tmp→rename for atomicity (WR-01: tmp file lives in the destination dir to avoid
 * cross-filesystem EXDEV on Linux). File permissions are set to 0600 (owner-only) both
 * in writeFileSync and via an explicit chmodSync (belt-and-suspenders against umask).
 */
function writeDoc(statePath: string, doc: StateDocument): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = join(dirname(statePath), `.telegram-state-${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  chmodSync(tmp, 0o600); // belt-and-suspenders (umask may limit mode in writeFileSync)
  renameSync(tmp, statePath);
}

// ---------------------------------------------------------------------------
// Public API — cursor (pre-existing)
// ---------------------------------------------------------------------------

/**
 * Atomically write the Telegram poll cursor to the JSON state file, preserving
 * every other field already in the document (Phase 68 read-modify-write fix — see
 * the module-level comment above).
 *
 * Cursor is `null` on cold start (no persisted value), a numeric string update_id after
 * the first successful poll.
 */
export function writeStateCursor(statePath: string, cursor: string | null): void {
  const doc = readDoc(statePath);
  doc.cursor = cursor;
  writeDoc(statePath, doc);
}

/**
 * Read the Telegram poll cursor from the JSON state file.
 *
 * Returns null when: the file does not exist, the JSON is malformed, the `cursor` field is
 * not a string, or any other read error occurs. Unreadable state → cold start (safe
 * direction, D-09). Never throws.
 */
export function readStateCursor(statePath: string): string | null {
  return readDoc(statePath).cursor;
}

// ---------------------------------------------------------------------------
// Public API — belief prompt ledger (Phase 68 — D-07/APPROVE-03)
// ---------------------------------------------------------------------------

/**
 * Read the belief-proposal batching ledger, preserving the cursor field written by
 * any prior writeStateCursor call.
 *
 * A corrupt or missing document, or a document with no ledger field yet, reads as an
 * empty ledger for today ({ date: '', counts: {} }) — never throws.
 */
export function readBeliefPromptLedger(statePath: string): BeliefPromptLedger {
  return readDoc(statePath).beliefPromptLedger ?? { date: EMPTY_LEDGER.date, counts: {} };
}

/**
 * Atomically write the belief prompt ledger, preserving the cursor field already in
 * the document (Phase 68 read-modify-write fix — see the module-level comment above).
 */
export function writeBeliefPromptLedger(statePath: string, ledger: BeliefPromptLedger): void {
  const doc = readDoc(statePath);
  doc.beliefPromptLedger = ledger;
  writeDoc(statePath, doc);
}
