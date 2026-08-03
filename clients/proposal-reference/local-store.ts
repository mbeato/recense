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

export type LocalStatus = 'pending' | 'applied' | 'refused' | 'skipped';

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

/** Type guard for a single stored row — used by the never-throw read path. */
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
      r['localStatus'] === 'refused' || r['localStatus'] === 'skipped') &&
    (r['refusalReason'] === null || typeof r['refusalReason'] === 'string') &&
    typeof r['updatedAtMs'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// Low-level read / write
// ---------------------------------------------------------------------------

/** Never throws — corrupt/missing file or wrong-shaped rows return []. */
function readRows(storePath: string): LocalRow[] {
  try {
    if (!existsSync(storePath)) return [];
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isLocalRow);
  } catch {
    return [];
  }
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
 * subsequent read. Never throws — see readRows.
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
 * (idempotent put), not appended.
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
