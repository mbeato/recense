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
import { findByProposalId, putLocalRow, newLocalId, type LocalRow } from './local-store';

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
  const report: SyncReport = { listed: 0, applied: 0, skipped: 0, refused: 0, deferred: 0 };

  const records = await client.listProposals();
  report.listed = records.length;

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
    const report = await syncProposals(client, config.localStorePath, log);
    log(
      `sync complete — listed=${String(report.listed)} applied=${String(report.applied)} ` +
        `skipped=${String(report.skipped)} refused=${String(report.refused)} ` +
        `deferred=${String(report.deferred)}`,
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
