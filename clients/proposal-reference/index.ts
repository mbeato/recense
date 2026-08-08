/**
 * The proposal-reference adapter's outcome loop — the one genuinely new piece
 * of logic in this reference client (D-03): list pending proposals → map
 * each onto this adapter's own local row → approve or reject over HTTP →
 * mark a refusal terminal. This IS the demo of the milestone's
 * "context-layer proposes / system-of-record confirms" thesis.
 *
 * Imports only from ./config, ./proposal-client, ./local-store, and node:fs
 * (for the log append) — zero engine imports (CONSUME-02).
 */
import { appendFileSync } from 'node:fs';
import { loadAdapterConfig } from './config';
import {
  createProposalClient,
  PROPOSAL_SCHEMA_VERSION,
  ProposalHttpError,
  type ProposalClient,
  type ActionProposalRecord,
} from './proposal-client';
import {
  acquireSyncLock,
  findByProposalId,
  putLocalRow,
  newLocalId,
  LocalStoreCorruptError,
  SyncLockHeldError,
  type LocalRow,
} from './local-store';

// ---------------------------------------------------------------------------
// Decision policy (D-07, 66 D-12, APPROVE-04 spirit)
// ---------------------------------------------------------------------------

/**
 * The adapter's reference decision policy, kept as one small, obvious, pure
 * function so the demo's decision policy lives in one readable place rather
 * than buried in the loop. A real consumer replaces this with its own domain
 * rule.
 *
 * MUST NOT read `evidence_quote` — the quote is approver context/data, never
 * a programmatic gate (D-07, 66 D-12; mirrors the APPROVE-04 spirit that raw
 * confidence is not shown to a human as the decision surface either).
 */
export function decideOutcome(record: ActionProposalRecord): 'approve' | 'reject' {
  return record.confidence === 'high' ? 'approve' : 'reject';
}

// ---------------------------------------------------------------------------
// Outcome loop (D-03)
// ---------------------------------------------------------------------------

export interface SyncReport {
  listed: number;
  applied: number;
  skipped: number;
  refused: number;
  deferred: number;
  /** 409 on a resumed pending row — settled server-side, local outcome unknown (WR-01). */
  needsReconciliation: number;
}

/**
 * Map a refusal's HTTP status to the closed refusalReason vocabulary. Never
 * reads the `detail` string — only the numeric status + `error` enum value
 * are contract (docs/reference-client.md).
 */
function refusalReasonForStatus(status: number): 'bad_request' | 'not_found' | 'conflict' | null {
  if (status === 400) return 'bad_request';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return null;
}

/**
 * Proposal ids are sha256 hex by construction. Checked here as well as in
 * proposal-client.ts because this gate runs BEFORE anything is persisted, and a
 * non-conforming id must never reach the local store.
 */
const RECORD_ID_RE = /^[0-9a-f]{64}$/;

/**
 * The list response is an unchecked cast at a trust boundary (plain-HTTP
 * transport), so before the loop touches any item, every field the loop reads
 * must be present WITH the type the loop reads it as — a malformed item produces
 * the documented graceful stop (WR-03), never a raw TypeError escaping
 * syncProposals.
 *
 * WR-02 (v10 cross-review): this used to check key PRESENCE only, so a record
 * carrying `"id": 12345` or `"entity_descriptor": null` passed the gate, was
 * copied into a LocalRow, and was persisted by putLocalRow — which validates only
 * the pre-existing rows it READS, never the row it is about to write. The next
 * sync's readRows then ran isLocalRow over that row, failed it, and threw
 * LocalStoreCorruptError, which syncProposals deliberately re-throws — aborting
 * every future sync until a human restores the file. The adapter could brick
 * itself permanently by writing a row it had guaranteed itself it could not read.
 * The write path's guard set and the read path's guard set must be one source, so
 * these checks mirror local-store.ts:isLocalRow (and the sibling client's
 * isInspectableProposalRecord) rather than merely testing for keys.
 */
function isInspectableRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' && RECORD_ID_RE.test(r['id']) &&
    typeof r['kind'] === 'string' &&
    typeof r['entity_descriptor'] === 'string' &&
    typeof r['change_field'] === 'string' &&
    typeof r['change_to'] === 'string' &&
    (r['confidence'] === 'high' || r['confidence'] === 'medium' || r['confidence'] === 'low') &&
    typeof r['schema_version'] === 'number'
  );
}

/**
 * Run one full outcome-loop pass: list → map onto local rows → approve/reject
 * → refusal handling. Takes client/storePath/log as parameters rather than
 * reading config internally, so a repo-level e2e can drive it against a live
 * test server.
 */
export async function syncProposals(
  client: ProposalClient,
  storePath: string,
  log: (msg: string) => void,
): Promise<SyncReport> {
  // Single-flight guard (WR-06): the idempotency check is check-then-act over
  // a shared file, so overlapping sync invocations could each POST the same
  // proposal. Cross-process O_EXCL lock file, released in finally; a second
  // concurrent invocation throws SyncLockHeldError and does nothing.
  const releaseLock = acquireSyncLock(storePath);
  try {
    return await runSyncPass(client, storePath, log);
  } finally {
    releaseLock();
  }
}

async function runSyncPass(
  client: ProposalClient,
  storePath: string,
  log: (msg: string) => void,
): Promise<SyncReport> {
  const report: SyncReport = {
    listed: 0,
    applied: 0,
    skipped: 0,
    refused: 0,
    deferred: 0,
    needsReconciliation: 0,
  };

  const records = await client.listProposals();
  report.listed = records.length;

  // Wire-shape gate before anything else (WR-03): a non-object item or one
  // missing the required key set means the response is not the contract this
  // adapter was written against — stop, apply nothing (same discipline as the
  // schema gate below).
  if ((records as unknown[]).some(r => !isInspectableRecord(r))) {
    log(
      'malformed item in list response — not an object carrying the record fields at the ' +
        'types this adapter reads them as; stopping sync, applying nothing',
    );
    return report;
  }

  // Schema gate first, before any per-item work (D-07): unknown schema means
  // stop, not coerce and not partial-apply.
  const badSchema = records.find(r => r.schema_version !== PROPOSAL_SCHEMA_VERSION);
  if (badSchema !== undefined) {
    log(
      `schema mismatch — record schema_version=${String(badSchema.schema_version)} does not ` +
        `match adapter's PROPOSAL_SCHEMA_VERSION=${String(PROPOSAL_SCHEMA_VERSION)}; stopping ` +
        'sync, applying nothing',
    );
    return report;
  }

  for (const record of records) {
    // row is set once this record's local row exists on disk, so the catch
    // block below can update it on a refusal without re-deriving it.
    let row: LocalRow | undefined;
    // resumed is true when a prior sync already held a pending row for this
    // proposal — meaning a prior attempt may already have fired its HTTP call
    // before crashing. The catch block needs this bit to disambiguate a 409.
    let resumed = false;
    try {
      // Unknown kind skips this record only (D-07) — the loop keeps going.
      if (record.kind !== 'belief') {
        log(`skipping proposal ${record.id} — unrecognised kind "${String(record.kind)}"`);
        report.skipped++;
        continue;
      }

      // Idempotency (D-02, EMIT-04 consumer half): a re-listed or replayed
      // proposal must not create a second local row or a second HTTP call.
      const existing = findByProposalId(record.id, storePath);
      if (existing !== undefined && existing.localStatus !== 'pending') {
        report.skipped++;
        continue;
      }
      resumed = existing !== undefined;

      // Map onto the adapter's own vocabulary. entityDescriptor is the
      // semantic key this consumer resolves on — node ids are deliberately
      // not carried because 64's D-08 says they are not stable foreign keys
      // across belief-correction. Reuse existing.localId when a prior sync
      // crashed between insert and POST (existing is present and pending).
      row = {
        localId: existing !== undefined ? existing.localId : newLocalId(),
        proposalId: record.id,
        entityDescriptor: record.entity_descriptor,
        changeField: record.change_field,
        changeTo: record.change_to,
        localStatus: 'pending',
        refusalReason: null,
        updatedAtMs: Date.now(),
      };
      // Write pending BEFORE the HTTP call so a crash mid-flight leaves a
      // resumable pending row rather than an invisible applied change.
      putLocalRow(row, storePath);

      const action = decideOutcome(record);
      if (action === 'approve') {
        await client.approve(record.id);
      } else {
        await client.reject(record.id);
      }
      putLocalRow({ ...row, localStatus: 'applied', updatedAtMs: Date.now() }, storePath);
      report.applied++;
    } catch (err) {
      if (err instanceof LocalStoreCorruptError) {
        // The system of record itself cannot be trusted — abort the whole
        // sync with the operator-facing message (WR-05); never fall through
        // to per-item log-and-continue, which would retry into the same wall.
        throw err;
      }
      if (err instanceof ProposalHttpError) {
        if (err.status === 401) {
          // Auth is broken, not this item — abort the whole sync.
          throw err;
        }
        if (row !== undefined) {
          if (err.status === 503) {
            // Not terminal — leave the row pending, retry on a later sync.
            report.deferred++;
            continue;
          }
          if (err.status === 409 && resumed) {
            // Ambiguous crash-resume outcome (WR-01): the pending row was left
            // by a PRIOR sync, so that sync's HTTP call may already have
            // succeeded before it crashed — this 409 may be the server
            // refusing OUR OWN earlier, successful application. Recording
            // `refused` here would durably invert the truth. Record the
            // honest ambiguous state instead; it is terminal for the loop
            // (never re-POSTed) and a human/consumer reconciles it against
            // the server's proposal status.
            putLocalRow(
              {
                ...row,
                localStatus: 'needs_reconciliation',
                refusalReason: null,
                updatedAtMs: Date.now(),
              },
              storePath,
            );
            report.needsReconciliation++;
            log(
              `proposal ${record.id} — 409 on a resumed pending row; settled server-side but ` +
                'local outcome unknown; marked needs_reconciliation (not refused)',
            );
            continue;
          }
          const refusalReason = refusalReasonForStatus(err.status);
          if (refusalReason !== null) {
            // Terminal refusal — a refused row is never re-POSTed.
            putLocalRow(
              { ...row, localStatus: 'refused', refusalReason, updatedAtMs: Date.now() },
              storePath,
            );
            report.refused++;
            continue;
          }
        }
      }
      // One item's failure never aborts the batch.
      log(`proposal ${record.id} failed with an unexpected error: ${String(err)}`);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Log helper — append-only file log; the log path is adapter-owned and never
// carries the serve token (T-67-12).
// ---------------------------------------------------------------------------

/**
 * Resolve the adapter's own log path: RECENSE_REFERENCE_LOG_PATH if set, else
 * co-located with the local store's directory. Pure string handling (no
 * node:path import) to keep this module's import surface exactly as scoped.
 */
function resolveLogPath(): string {
  const override = process.env['RECENSE_REFERENCE_LOG_PATH'];
  if (override !== undefined && override !== '') return override;
  const storePath = loadAdapterConfig().localStorePath;
  const lastSlash = storePath.lastIndexOf('/');
  const dir = lastSlash === -1 ? '.' : storePath.slice(0, lastSlash);
  return dir + '/proposal-reference.log';
}

/** Append a timestamped line to the adapter's own log. Best-effort — logging must never throw. */
function log(msg: string): void {
  try {
    appendFileSync(resolveLogPath(), `[${new Date().toISOString()}] proposal-reference: ${msg}\n`);
  } catch {
    // best-effort; a logging failure must never crash the adapter
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const config = loadAdapterConfig();
  if (!config.enabled) {
    log('adapter disabled — RECENSE_SERVE_TOKEN missing (fail-closed); no network call made');
    return;
  }

  const client = createProposalClient(config.serveUrl, config.serveToken);
  const command = process.argv[2] ?? 'sync';

  if (command === 'sync') {
    let report: SyncReport;
    try {
      report = await syncProposals(client, config.localStorePath, log);
    } catch (err) {
      if (err instanceof SyncLockHeldError) {
        // Another sync is running — refusing to overlap is the correct
        // outcome, not a crash (WR-06). No request was made.
        log(err.message);
        return;
      }
      throw err;
    }
    log(
      `sync complete — listed=${String(report.listed)} applied=${String(report.applied)} ` +
        `skipped=${String(report.skipped)} refused=${String(report.refused)} ` +
        `deferred=${String(report.deferred)} ` +
        `needs_reconciliation=${String(report.needsReconciliation)}`,
    );
    return;
  }

  if (command === 'list') {
    const records = await client.listProposals();
    for (const r of records) {
      // Only closed-vocabulary/structured fields — never evidence_quote or
      // change_from, which is model prose and must never be the operator's
      // decision surface (D-07).
      console.log(
        JSON.stringify({
          id: r.id,
          entity_descriptor: r.entity_descriptor,
          change_field: r.change_field,
          change_to: r.change_to,
          confidence: r.confidence,
          expires_at: r.expires_at,
        }),
      );
    }
    return;
  }

  log(`usage: node index.js [sync|list] — unrecognised command "${command}"`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Entry guard — run only when invoked as the main module, not when imported
// by tests. Mirrors clients/telegram/index.ts verbatim.
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch(err => {
    log(`FATAL: ${String(err)}`);
    process.exit(1);
  });
}
