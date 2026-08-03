/**
 * Adapter-owned local row store — the "system of record" half of the D-02
 * demonstration: the adapter maps recense proposals onto its own local rows,
 * keyed for replay-safety on the recense proposal id.
 *
 * Imports only from node:fs, node:path, node:crypto — nothing from `../` or
 * `src/` (CONSUME-02).
 *
 * Deliberately does NOT persist `evidence_quote`, `change_from`, or any other
 * free-text field carrying attacker-influenced prose (T-67-02): the local store
 * is the system-of-record row, and only closed-vocabulary/structured fields
 * belong in it. Quote is data — 66's D-12, this phase's D-07.
 *
 * Deliberately does NOT persist `entity_node_id`/`belief_node_id` as a foreign
 * key: 64's D-08 says they are recense-internal lineage, not stable across
 * belief-correction (tombstone-and-mint). `entityDescriptor` is the semantic
 * key the adapter resolves on instead.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Local vocabulary
// ---------------------------------------------------------------------------

/**
 * `needs_reconciliation` marks the ambiguous crash-resume outcome (WR-01): a
 * resumed pending row drew a 409 on its re-POST, so the proposal is settled
 * server-side but this adapter cannot know whether its OWN earlier call was
 * the one that settled it (all 409 subtypes share `error: 'conflict'`, and
 * `detail` is non-contract). It is terminal for the sync loop — never
 * re-POSTed — but honest: a human or the consumer's own reconciliation job
 * resolves it to applied/refused by consulting the server's proposal status.
 */
export type LocalStatus = 'pending' | 'applied' | 'refused' | 'skipped' | 'needs_reconciliation';

export interface LocalRow {
  /** This adapter's OWN id (randomUUID) — its vocabulary, not recense's. */
  localId: string;
  /** recense action_proposal.id — the idempotency key (D-02/D-03). */
  proposalId: string;
  /** The semantic key the adapter resolves on (D-02, ARCHITECTURE Q4). */
  entityDescriptor: string;
  changeField: string;
  /** Closed IntentStatus token — the field a consumer maps on. */
  changeTo: string;
  localStatus: LocalStatus;
  /** Set on a terminal refusal (D-03); null otherwise. */
  refusalReason: string | null;
  updatedAtMs: number;
}

/**
 * Thrown when the store file exists but cannot be trusted (unparseable JSON,
 * not an array, or a row failing shape validation). Fail-closed (WR-05):
 * treating a corrupt store as empty would let the next putLocalRow rewrite
 * the file as a one-row store — silently destroying every terminal
 * applied/refused marker and re-POSTing previously-applied proposals on the
 * next sync. The sync must abort instead, and the operator must inspect or
 * restore the file.
 */
export class LocalStoreCorruptError extends Error {
  constructor(storePath: string, cause: string) {
    super(
      `local store file ${storePath} is corrupt (${cause}); refusing to treat it as empty — ` +
        'inspect or restore the file, then re-run sync',
    );
    this.name = 'LocalStoreCorruptError';
  }
}

/** Type guard for a single stored row — used by the fail-closed read path. */
function isLocalRow(v: unknown): v is LocalRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['localId'] === 'string' &&
    typeof r['proposalId'] === 'string' &&
    typeof r['entityDescriptor'] === 'string' &&
    typeof r['changeField'] === 'string' &&
    typeof r['changeTo'] === 'string' &&
    (r['localStatus'] === 'pending' || r['localStatus'] === 'applied' ||
      r['localStatus'] === 'refused' || r['localStatus'] === 'skipped' ||
      r['localStatus'] === 'needs_reconciliation') &&
    (r['refusalReason'] === null || typeof r['refusalReason'] === 'string') &&
    typeof r['updatedAtMs'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// Low-level read / write
// ---------------------------------------------------------------------------

/**
 * Missing file returns []. A file that exists but is corrupt — unparseable
 * JSON, not an array, or any row failing shape validation — throws
 * LocalStoreCorruptError (WR-05): the store is the system of record, and
 * silently reading a corrupt file as empty would let the next write destroy
 * every terminal row.
 */
function readRows(storePath: string): LocalRow[] {
  if (!existsSync(storePath)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(storePath, 'utf8'));
  } catch {
    throw new LocalStoreCorruptError(storePath, 'invalid JSON');
  }
  if (!Array.isArray(raw)) throw new LocalStoreCorruptError(storePath, 'not a JSON array');
  if (!raw.every(isLocalRow)) {
    throw new LocalStoreCorruptError(storePath, 'a row failed shape validation');
  }
  return raw as LocalRow[];
}

/**
 * Atomic 0600 write: tmp file in the destination directory (EXDEV-safe) →
 * chmodSync → renameSync — mirrors clients/telegram/proposal-store.ts.
 */
function writeRows(storePath: string, rows: LocalRow[]): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = join(
    dirname(storePath),
    `.proposal-reference-store-${Date.now()}-${process.pid}.tmp`,
  );
  writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
  chmodSync(tmp, 0o600); // belt-and-suspenders against umask
  renameSync(tmp, storePath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return every local row, deep-copied so caller mutations never affect a
 * subsequent read. Throws LocalStoreCorruptError on a corrupt store file —
 * see readRows (WR-05).
 */
export function listLocalRows(storePath: string): LocalRow[] {
  return readRows(storePath).map(r => JSON.parse(JSON.stringify(r)) as LocalRow);
}

/**
 * Return the row whose proposalId matches, or undefined for an unseen proposal
 * id. Callers MUST check this before minting a new local row from a listed
 * proposal — it is the mechanism that prevents a replayed proposal from
 * creating a second local row (D-02, EMIT-04's consumer half).
 */
export function findByProposalId(proposalId: string, storePath: string): LocalRow | undefined {
  return listLocalRows(storePath).find(r => r.proposalId === proposalId);
}

/**
 * Persist a row. If a row with the same localId already exists it is replaced
 * (idempotent put), not appended. Throws LocalStoreCorruptError (before
 * writing anything) if the existing store file is corrupt — a corrupt store
 * is never overwritten (WR-05).
 */
export function putLocalRow(row: LocalRow, storePath: string): void {
  const rows = readRows(storePath).filter(r => r.localId !== row.localId);
  rows.push(JSON.parse(JSON.stringify(row)) as LocalRow);
  writeRows(storePath, rows);
}

/** Generate this adapter's own local id — its vocabulary, not recense's. */
export function newLocalId(): string {
  return randomUUID();
}
