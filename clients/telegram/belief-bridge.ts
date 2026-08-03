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

import { appendFileSync } from 'fs';
import type { StoredProposal, StoredBeliefProposal, ProposalAction } from './types';
import { tryReserveProposalSlot, putProposal, getProposal, removeProposal, loadExecutable } from './proposal-store';
import {
  type BeliefProposalClient,
  type ActionProposalRecord as ClientActionProposalRecord,
  isInspectableProposalRecord,
  PROPOSAL_SCHEMA_VERSION,
  ProposalHttpError,
} from './belief-proposal-client';
import { renderBeliefDecisionMessage, beliefKeyboard, asDisplayText } from './belief-render';
import { readBeliefPromptLedger, writeBeliefPromptLedger } from './state';
import type { TelegramTransport } from './transport';
import type { MemoryClient } from './memory-client';

// ---------------------------------------------------------------------------
// Log helper — mirrors index.ts's own append-only file log (never stdout,
// T-13-05); duplicated locally rather than imported so this module keeps its
// own self-contained dependency surface (handleBeliefProposalAction's param
// list is deliberately config/log-free per the plan, so tests can drive it
// directly without wiring a log sink).
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/recense-telegram-client.log';

function log68(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] telegram-client (belief-bridge): ${msg}\n`);
  } catch { /* best-effort — logging must never throw */ }
}

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

// ---------------------------------------------------------------------------
// The belief decision handler (Plan 03 Task 1 — APPROVE-01/02, D-02/D-04)
// ---------------------------------------------------------------------------

/** Field cap (characters) for the confirmation line — mirrors belief-render.ts's TRANSITION_CAP. */
const CONFIRM_TRANSITION_CAP = 60;

/** Render the confirmation line naming the transition that was applied. */
function renderTransitionConfirmation(verb: string, row: StoredBeliefProposal): string {
  const from = row.changeFrom === null ? '(unset)' : asDisplayText(row.changeFrom, CONFIRM_TRANSITION_CAP);
  const to = asDisplayText(row.changeTo, CONFIRM_TRANSITION_CAP);
  return `${verb}: ${asDisplayText(row.changeField, CONFIRM_TRANSITION_CAP)}: ${from} → ${to}`;
}

/**
 * Handle a '3|' belief decision callback_query action: approve / reject / edit / snooze.
 *
 * Order (D-02): the belief path is decided before anything engine/LLM-adjacent can
 * run. Loads the row via loadExecutable (missing/expired short-circuit with no HTTP
 * call), asserts it is belief-kind (T-68-13 — the mirror of Plan 01's T-68-01
 * tool-path guard, closing the other direction: a forged '3|{id}|a' naming a TOOL
 * row must not act on it), short-circuits an already-terminal row (idempotent
 * double-tap, T-68-17 — Telegram redelivers taps), then branches on action.
 *
 * edit/snooze reply with a fixed sentence and audit belief-edit-refused. Editing a
 * belief proposal is consumer-side belief authoring, which Phase 66 forbids by
 * design — this is not a missing feature, it is the boundary. Critically: this
 * branch (and this whole function) never imports or calls anything from the LLM
 * tool-mapping module (proposal-engine.ts) or the MCP execution module
 * (mcp-client.ts) — there is no tool to map, the action is a fixed HTTP
 * approve/reject.
 *
 * approve/reject call the belief client with row.serverProposalId (the client
 * re-validates the 64-hex shape and builds no request on a malformed id). On
 * success the row is kept (not removed) and written back terminal — the derived
 * local id is also the dedup key, so a removed row would let the next poll pass
 * re-prompt a decided proposal. The confirmation names the applied transition via
 * the same asDisplayText sanitizer the card uses. The audit episode carries the
 * decision field ONLY (T-68-14) — never the entity descriptor, change text, or
 * evidence quote, so email-derived text cannot re-enter memory through the audit
 * path. hitl episodes are source:'hitl' and structurally excluded from
 * consolidation, so this audit cannot strengthen the very belief it records
 * (D-43 lineage).
 *
 * Any ProposalHttpError propagates to a single catch here that logs the numeric
 * status, leaves the row pending, and replies with a neutral message — Plan 03
 * Task 2 replaces this catch with the full refusal-status mapping (503 defers,
 * 400/404/409 terminal-refused, 401 neutral-pending).
 *
 * Does NOT call answerCallbackQuery — the outer callback drain calls it
 * unconditionally on every branch (Pitfall #1, mirrors handleProposalAction).
 *
 * Parameters only, no config reads — both the unit tests and the repo-level e2e
 * can drive this directly.
 */
export async function handleBeliefProposalAction(
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  client: BeliefProposalClient,
  storePath: string,
  statePath: string,
  chatId: number,
  decoded: { localId: string; action: ProposalAction },
  nowMs: number,
): Promise<void> {
  void statePath; // reserved for Task 2's approval-rate self-report (D-09)
  const { localId, action } = decoded;

  const loaded = loadExecutable(localId, storePath, nowMs);
  if (loaded.status !== 'ok') {
    const text = loaded.status === 'expired'
      ? 'that proposal lapsed — re-pull if still needed'
      : 'that proposal is no longer available';
    try { await transport.sendMessage(chatId, text); } catch (e) { log68('send error (belief-' + loaded.status + '): ' + String(e)); }
    return;
  }

  const row = loaded.proposal;

  // T-68-13: a forged '3|{localId}|a' naming a TOOL row must not act on it — the
  // mirror of Plan 01's T-68-01 tool-path guard, closing the other direction.
  if (!isBeliefProposal(row)) {
    log68('handleBeliefProposalAction: refusing tool-kind proposal on belief-decision path (T-68-13)');
    try { await transport.sendMessage(chatId, 'that decision is handled by the tool approval flow'); }
    catch (e) { log68('send error (tool-refusal): ' + String(e)); }
    return;
  }

  // T-68-17: an already-terminal row short-circuits before any POST — a replayed
  // button (Telegram redelivers taps) issues zero further state changes.
  if (row.localStatus === 'terminal') {
    try { await transport.sendMessage(chatId, 'that decision was already recorded'); }
    catch (e) { log68('send error (already-terminal): ' + String(e)); }
    return;
  }

  if (action === 'edit' || action === 'snooze') {
    // D-02: consumer-side belief authoring is Phase-66-forbidden by design — this
    // is not a missing feature, it is the boundary.
    try { await transport.sendMessage(chatId, 'belief proposals can only be approved or rejected'); }
    catch (e) { log68('send error (edit-refused): ' + String(e)); }
    try { await memoryClient.hitlEpisode({ decision: 'belief-edit-refused' }); }
    catch (e) { log68('hitlEpisode error (belief-edit-refused): ' + String(e)); }
    return;
  }

  // approve/reject: fixed HTTP POST against the frozen contract (D-02 — there is
  // no tool to map).
  try {
    if (action === 'approve') {
      await client.approve(row.serverProposalId);
    } else {
      await client.reject(row.serverProposalId);
    }

    // Keep the row (not remove it) — see function doc above.
    putProposal({ ...row, localStatus: 'terminal' }, storePath);

    const verb = action === 'approve' ? 'approved' : 'rejected';
    try { await transport.sendMessage(chatId, renderTransitionConfirmation(verb, row)); }
    catch (e) { log68('send error (belief-' + action + ' confirmation): ' + String(e)); }

    // T-68-14: decision field ONLY (see function doc above).
    try {
      await memoryClient.hitlEpisode({ decision: action === 'approve' ? 'belief-approve' : 'belief-reject' });
    } catch (e) { log68('hitlEpisode error (belief-' + action + '): ' + String(e)); }
  } catch (err) {
    // Placeholder mapping (Task 1) — Task 2 replaces this with the full
    // refusal-status mapping (503 defers, 400/404/409 terminal, 401 neutral).
    if (err instanceof ProposalHttpError) {
      log68('belief decision: HTTP ' + String(err.status) + ' for ' + row.serverProposalId);
    } else {
      log68('belief decision: unexpected error: ' + String(err));
    }
    try { await transport.sendMessage(chatId, 'could not record that decision — try again in a moment'); }
    catch (e) { log68('send error (belief-decision-failed): ' + String(e)); }
  }
}
