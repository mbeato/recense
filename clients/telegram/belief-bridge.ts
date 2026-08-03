/**
 * Belief-shaped proposal record→row mapping and deterministic local id derivation
 * (Phase 68 — APPROVE-02).
 *
 * Zero src/ imports — this module imports only types from ./types and functions
 * from ./proposal-store (both local to clients/telegram/), never anything from src/
 * (CLIENT-01 / import-boundary guard).
 *
 * `proposal-store.ts` and `proposal-engine.ts` are consumed here exactly as-is,
 * with ZERO changes (APPROVE-02, locked verbatim in the ROADMAP SC). This module
 * is the concrete mechanism that makes that true: it maps a server `ActionProposalRecord`
 * onto a `StoredBeliefProposal` whose `dueAt`/`createdAt`/`maxTtlMs` fields satisfy the
 * exact contract `isExpired()` already reads.
 */

import type { StoredProposal, StoredBeliefProposal } from './types';

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
