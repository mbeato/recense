/**
 * Belief-shaped proposal record→row mapping, deterministic local id derivation, and
 * the belief poll pass itself (Phase 68 — APPROVE-01/02/03).
 *
 * Zero src/ imports — this module imports only types from ./types and functions
 * from ./proposal-store, ./belief-proposal-client, ./belief-render, ./state, and
 * ./transport (all local to clients/telegram/), never anything from src/
 * (CLIENT-01 / import-boundary guard).
 *
 * `proposal-store.ts` and `proposal-engine.ts` are consumed here exactly as-is,
 * with ZERO changes (APPROVE-02, locked verbatim in the ROADMAP SC). This module
 * is the concrete mechanism that makes that true: it maps a server `ActionProposalRecord`
 * onto a `StoredBeliefProposal` whose `dueAt`/`createdAt`/`maxTtlMs` fields satisfy the
 * exact contract `isExpired()` already reads.
 */

import type { StoredProposal, StoredBeliefProposal } from './types';
import { tryReserveProposalSlot, putProposal, getProposal, removeProposal } from './proposal-store';
import {
  type BeliefProposalClient,
  type ActionProposalRecord as ClientActionProposalRecord,
  isInspectableProposalRecord,
  PROPOSAL_SCHEMA_VERSION,
  ProposalHttpError,
} from './belief-proposal-client';
import { renderBeliefDecisionMessage, beliefKeyboard } from './belief-render';
import { readBeliefPromptLedger, writeBeliefPromptLedger } from './state';
import type { TelegramTransport } from './transport';

// ---------------------------------------------------------------------------
// Locally-declared wire vocabulary (CONSUME-02: transcribed by hand, mirrors
// clients/telegram/belief-proposal-client.ts's ActionProposalRecord — never
// imported from src/).
// ---------------------------------------------------------------------------

/**
 * Mirrors clients/telegram/belief-proposal-client.ts:ActionProposalRecord (16 fields),
 * itself mirroring src/db/action-proposal-store.ts:ActionProposalRecord.
 */
export interface ActionProposalRecord {
  id: string;
  kind: 'belief';
  entity_node_id: string;
  entity_descriptor: string;
  belief_node_id: string;
  change_field: string;
  change_from: string | null;
  change_to: string;
  evidence_episode: string;
  evidence_quote: string;
  confidence: 'high' | 'medium' | 'low';
  schema_version: number;
  status: 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired';
  created_at: number;
  updated_at: number;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Local id derivation
// ---------------------------------------------------------------------------

/**
 * Derive the LOCAL store key from the server's 64-hex sha256 proposal id.
 *
 * Returns the first 32 characters of the server id. Truncation (rather than a
 * fresh `randomUUID()`) exists for two reasons:
 *
 *   1. It makes re-listing idempotent for free — a re-listed proposal maps to the
 *      same store key, so `getProposal(beliefLocalId(id))` IS the dedup check and
 *      no store-listing API has to be added to the frozen store.
 *   2. `2|` and `3|` callback_data payloads are capped at Telegram's 64-byte limit,
 *      and 32 hex chars keeps a `3|{id}|{code}` payload at 37 bytes.
 *
 * 128 bits of a sha256 prefix is not a collision concern at this scale.
 */
export function beliefLocalId(serverProposalId: string): string {
  return serverProposalId.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Record → row mapping
// ---------------------------------------------------------------------------

/**
 * Map a server `ActionProposalRecord` onto a `StoredBeliefProposal` row the
 * UNMODIFIED `proposal-store.ts` can persist, expire, and cap exactly like a
 * tool-kind row.
 *
 * Field mapping is verbatim — no normalization, no trimming, no paraphrase (D-05).
 * Display-time sanitization happens at render time, never here.
 *
 * @param record The server's action-proposal record from GET /v1/proposals.
 * @param nowMs  Epoch ms at bridge time (injectable for deterministic tests).
 */
export function toStoredBeliefProposal(record: ActionProposalRecord, nowMs: number): StoredBeliefProposal {
  return {
    kind: 'belief',
    id: beliefLocalId(record.id),
    serverProposalId: record.id,
    entityDescriptor: record.entity_descriptor,
    changeField: record.change_field,
    changeFrom: record.change_from,
    changeTo: record.change_to,
    evidenceQuote: record.evidence_quote,
    confidence: record.confidence,
    serverCreatedAtMs: record.created_at,
    localStatus: 'pending',
    dueAt: new Date(record.expires_at).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
    // maxTtlMs: 0 here would be WRONG. isExpired() evaluates
    // `now > Date.parse(createdAt) + maxTtlMs`, so a zero TTL expires the row on
    // the very next tick. The two expiry conditions (dueAt-past, createdAt+maxTtlMs
    // exceeded) must be made to coincide at the server's expires_at so the client's
    // local aging and the server's own expiry agree, and no row is surfaced past
    // its server-side window.
    maxTtlMs: Math.max(0, record.expires_at - nowMs),
  };
}

// ---------------------------------------------------------------------------
// Type predicate
// ---------------------------------------------------------------------------

/** Narrow a `StoredProposal` to its belief-kind member. */
export function isBeliefProposal(p: StoredProposal): p is StoredBeliefProposal {
  return p.kind === 'belief';
}

// ---------------------------------------------------------------------------
// Local calendar-day helper (Phase 68 — copied from proposal-store.ts's
// toLocalDate; the store is frozen and its helper is not exported).
// ---------------------------------------------------------------------------

/** Compute local YYYY-MM-DD string for the given Date. Mirrors proposal-store.ts. */
function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Batching (D-07 / APPROVE-03)
// ---------------------------------------------------------------------------

/** One batched group: all pending belief rows for one entity, one local day. */
export interface BeliefProposalGroup {
  entityDescriptor: string;
  localDate: string;
  rows: StoredBeliefProposal[];
}

/**
 * Group belief-proposal rows by entityDescriptor + local calendar day (the batch
 * identity D-07 defines), so same-entity same-day proposals collapse into ONE
 * Telegram prompt instead of one prompt per email. The local day is computed once
 * for the whole call from `nowMs` — the day the PASS is running, not each row's own
 * timestamp — since batch identity is about how many prompts go out today, not when
 * each underlying email arrived.
 *
 * Within a group, rows are ordered by serverCreatedAtMs ascending.
 */
export function groupBeliefProposals(rows: StoredBeliefProposal[], nowMs: number): BeliefProposalGroup[] {
  const localDate = toLocalDate(new Date(nowMs));
  const byEntity = new Map<string, StoredBeliefProposal[]>();

  for (const row of rows) {
    const existing = byEntity.get(row.entityDescriptor);
    if (existing) {
      existing.push(row);
    } else {
      byEntity.set(row.entityDescriptor, [row]);
    }
  }

  const groups: BeliefProposalGroup[] = [];
  for (const [entityDescriptor, groupRows] of byEntity) {
    groupRows.sort((a, b) => a.serverCreatedAtMs - b.serverCreatedAtMs);
    groups.push({ entityDescriptor, localDate, rows: groupRows });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The belief poll pass (D-03/D-04/D-07/D-08 — APPROVE-01/03)
// ---------------------------------------------------------------------------

/** Max constituents sent per group — earliest-expiring ten win; renderer names the rest. */
const MAX_GROUP_CONSTITUENTS = 10;

export interface BeliefBridgeDeps {
  client: BeliefProposalClient;
  transport: TelegramTransport;
  /** Numeric Telegram chat ids to send the batched prompt to (config.allowlist mapped to numbers). */
  chatIds: number[];
  storePath: string;
  statePath: string;
  dailyCap: number;
  log: (msg: string) => void;
  /** Epoch ms at pass time — injectable for deterministic tests. */
  nowMs: number;
}

/**
 * Poll GET /v1/proposals, gate/dedup/batch/cap the result, and send at most one
 * Telegram prompt per entity per local day (D-07). Never throws — every error path
 * logs and returns/continues rather than rejecting, so the caller's setInterval
 * callback is always safe.
 *
 * Order of operations (mirrors clients/proposal-reference/index.ts's fail-closed
 * list → wire-shape gate → schema gate → per-item filter shape):
 *   1. list (ProposalHttpError or any other throw → log + return; no privileged
 *      fallback for 401 — this loop just returns like any other status, since it has
 *      nothing sensitive to protect by staying up);
 *   2. wire-shape gate (isInspectableProposalRecord) — one malformed item stops the
 *      whole pass, applying nothing;
 *   3. schema gate (PROPOSAL_SCHEMA_VERSION) — a mismatch stops the whole pass;
 *   4. per-record filters that SKIP rather than stop: kind !== 'belief', status !== 'pending';
 *   5. dedup on the derived local id — a row already in the store is dropped (O(1)
 *      lookup via getProposal, no listing API added to the frozen store);
 *   6. group by entity + local day, then drop any group whose entity already has a
 *      non-zero count in today's ledger (D-07's one-prompt-per-entity-per-day invariant
 *      — this is what makes Pitfall 7's ">5 prompts/day for one entity" structurally
 *      unreachable);
 *   7. per group, earliest-dueAt-first: reserve one cap slot (one slot per PROMPT, not
 *      per constituent, since fatigue is measured in prompts) — on false, log and stop
 *      bridging for the WHOLE pass;
 *   8. store-first (putProposal every constituent BEFORE sending — no dangling button
 *      tap possible), then one sendMessage per group carrying the rendered message and
 *      keyboard. On a send failure, roll back (removeProposal every row just written)
 *      so the next pass retries, and leave the ledger untouched (T-68-11). On success,
 *      increment the entity's ledger count for today.
 */
export async function runBeliefBridgePass(deps: BeliefBridgeDeps): Promise<void> {
  const { client, transport, chatIds, storePath, statePath, dailyCap, log, nowMs } = deps;

  let records: ClientActionProposalRecord[];
  try {
    records = await client.listProposals();
  } catch (err) {
    if (err instanceof ProposalHttpError) {
      log('belief bridge: list failed with status ' + String(err.status));
    } else {
      log('belief bridge: list failed: ' + String(err));
    }
    return;
  }

  // Wire-shape gate (step 2) — one malformed item stops the pass, applies nothing.
  if (records.some(r => !isInspectableProposalRecord(r))) {
    log('belief bridge: malformed item in list response — stopping pass');
    return;
  }

  // Schema gate (step 3) — a mismatch stops the pass, applies nothing.
  const badSchema = records.find(r => r.schema_version !== PROPOSAL_SCHEMA_VERSION);
  if (badSchema !== undefined) {
    log('belief bridge: schema mismatch (' + String(badSchema.schema_version) + ') — stopping pass');
    return;
  }

  // Per-record filters that skip rather than stop (step 4).
  const pendingBeliefRecords = records.filter(r => r.kind === 'belief' && r.status === 'pending');

  // Dedup on the derived local id (step 5).
  const candidateRows: StoredBeliefProposal[] = [];
  for (const record of pendingBeliefRecords) {
    const row = toStoredBeliefProposal(record, nowMs);
    if (getProposal(row.id, storePath) !== null) continue; // already in the store
    candidateRows.push(row);
  }
  if (candidateRows.length === 0) return;

  // Group by entity + local day (step 6a).
  const groups = groupBeliefProposals(candidateRows, nowMs);
  const today = toLocalDate(new Date(nowMs));
  const ledger = readBeliefPromptLedger(statePath);
  const ledgerCounts: Record<string, number> = ledger.date === today ? { ...ledger.counts } : {};

  // Drop groups whose entity already has a non-zero count in today's ledger (step 6b).
  const eligibleGroups = groups.filter(g => (ledgerCounts[g.entityDescriptor] ?? 0) === 0);
  if (eligibleGroups.length === 0) return;

  // Process earliest-dueAt-first (step 7).
  const orderedGroups = [...eligibleGroups].sort((a, b) => {
    const aEarliest = Math.min(...a.rows.map(r => Date.parse(r.dueAt)));
    const bEarliest = Math.min(...b.rows.map(r => Date.parse(r.dueAt)));
    return aEarliest - bEarliest;
  });

  for (const group of orderedGroups) {
    const reserved = tryReserveProposalSlot(dailyCap, storePath, new Date(nowMs));
    if (!reserved) {
      log('belief bridge: daily cap reached — stopping pass');
      return;
    }

    // Cap constituents at MAX_GROUP_CONSTITUENTS, choosing the earliest-expiring ten;
    // the renderer's own overflow line names the remainder.
    const capped = [...group.rows]
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .slice(0, MAX_GROUP_CONSTITUENTS);

    // Store-first (step 8) — no button can ever reference a missing row.
    for (const row of capped) putProposal(row, storePath);

    const text = renderBeliefDecisionMessage(capped);
    const keyboard = beliefKeyboard(capped);

    try {
      for (const chatId of chatIds) {
        await transport.sendMessage(chatId, text, keyboard);
      }
    } catch (err) {
      // Roll back so the next pass retries — a lost message must never become a
      // permanently suppressed proposal (T-68-11). Ledger is left untouched.
      for (const row of capped) removeProposal(row.id, storePath);
      log('belief bridge: send failed for entity group, rolled back: ' + String(err));
      continue;
    }

    ledgerCounts[group.entityDescriptor] = (ledgerCounts[group.entityDescriptor] ?? 0) + 1;
    writeBeliefPromptLedger(statePath, { date: today, counts: ledgerCounts });
  }
}
