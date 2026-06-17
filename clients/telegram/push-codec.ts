/**
 * clients/telegram/push-codec.ts
 *
 * Compact encode/decode for Telegram callback_data payload (D-10).
 *
 * Format: `1|{nodeId}|{epochSec}|{c|d|s}`
 *   - Version prefix `1` (2 bytes incl. separator) — future-proofs the encoding
 *   - nodeId: UUID v4 (36 chars)
 *   - epochSec: Unix epoch seconds from due_at (10 digits for dates 2001–2286)
 *   - code: c=completed, d=dismissed, s=snoozed (D-08)
 *
 * Total: ~51 bytes for a UUID v4 nodeId — safely within Telegram's 64-byte limit.
 * Naively concatenating uuid + ISO-8601 date + outcome string overflows (71 bytes).
 *
 * A1 mitigation: encode normalizes dueAt via new Date(dueAt).toISOString() before
 * converting to epoch seconds. Decode reconstructs via new Date(epochSec * 1000).toISOString().
 * Both produce the same .000Z form, ensuring the occurrenceDueAt value matches
 * node_temporal.due_at stored in SQLite (idempotency key exact match).
 *
 * Security (T-22-02): decodeCallbackData performs strict input validation before
 * any use. callback_data arrives over Telegram getUpdates and is attacker-influenceable.
 * Any malformed input returns null — the caller skips surfaceSeen on null.
 *
 * Version-2 proposal format (Phase 23): `2|{proposalId}|{code}`
 *   - Version prefix `2` distinguishes proposal-approval callbacks from v1 surface-seen
 *   - proposalId: UUID v4 (36 chars) generated at proposal-store write time
 *   - code: a=approve, e=edit, r=reject, s=snooze (D-08)
 *   Total for a UUID: 2 + 36 + 1 + 2 separators = 41 bytes — within the 64-byte limit.
 *   v1 and v2 are mutually exclusive by version prefix: decodeCallbackData rejects a v2
 *   string (requires version '1') and decodeProposalCallbackData rejects a v1 string.
 *
 * Zero src/ imports — CLIENT-01 invariant maintained.
 * Zero new npm dependencies — net-zero runtime deps.
 */

import type { ProposalAction } from './types';

/** The three outcome codes supported in callback_data (D-08). */
type OutcomeCode = 'c' | 'd' | 's';

/** Full outcome strings returned by decodeCallbackData. */
type Outcome = 'completed' | 'dismissed' | 'snoozed';

const OUTCOME_ENCODE: Record<Outcome, OutcomeCode> = {
  completed: 'c',
  dismissed: 'd',
  snoozed: 's',
};

const OUTCOME_DECODE: Record<OutcomeCode, Outcome> = {
  c: 'completed',
  d: 'dismissed',
  s: 'snoozed',
};

/**
 * Encode (node_id, occurrence_due_at, outcome_code) into a compact callback_data string.
 *
 * The caller passes outcome as 'c', 'd', or 's' (the short code, not the full word),
 * keeping the push-timer side minimal and the codec self-contained.
 *
 * @param nodeId UUID v4 (36 chars)
 * @param dueAt  ISO-8601 UTC from SurfaceItem.due_at (normalized via toISOString)
 * @param outcome Short outcome code — 'c'=completed, 'd'=dismissed, 's'=snoozed (D-08)
 */
export function encodeCallbackData(nodeId: string, dueAt: string, outcome: OutcomeCode): string {
  // Normalize to .000Z form (A1 mitigation) before converting to epoch seconds.
  const normalizedMs = new Date(dueAt).getTime();
  const epochSec = Math.floor(normalizedMs / 1000);
  return `1|${nodeId}|${String(epochSec)}|${outcome}`;
}

/**
 * Decode a callback_data string back into typed fields.
 *
 * Returns null on ANY malformed or unrecognized input (T-22-02).
 * The caller MUST check for null before calling surfaceSeen.
 *
 * @param data Raw callback_data string from Telegram (attacker-influenceable — never trust)
 */
export function decodeCallbackData(data: string): {
  nodeId: string;
  occurrenceDueAt: string;
  outcome: Outcome;
} | null {
  if (!data) return null;

  const parts = data.split('|');
  if (parts.length !== 4) return null;

  const [version, nodeId, epochStr, code] = parts as [string, string, string, string];

  // Version check — rejects old or future encodings
  if (version !== '1') return null;

  // Field presence
  if (!nodeId || !epochStr || !code) return null;

  // Epoch must be a string of digits only (guards against partial parseInt on ISO dates)
  if (!/^\d+$/.test(epochStr)) return null;
  const epochSec = parseInt(epochStr, 10);
  if (!Number.isFinite(epochSec)) return null;

  // Outcome code mapping (closed set — any unknown code → null)
  const outcome = OUTCOME_DECODE[code as OutcomeCode] ?? null;
  if (!outcome) return null;

  // Reconstruct ISO string via the same normalization path as encode (A1)
  const occurrenceDueAt = new Date(epochSec * 1000).toISOString();

  return { nodeId, occurrenceDueAt, outcome };
}

// ---------------------------------------------------------------------------
// Version-2 proposal codec (Phase 23 — approval-gated MCP execution)
// ---------------------------------------------------------------------------

/** Single-character action codes carried in v2 callback_data. */
type ProposalCode = 'a' | 'e' | 'r' | 's';

const PROPOSAL_DECODE: Record<ProposalCode, ProposalAction> = {
  a: 'approve',
  e: 'edit',
  r: 'reject',
  s: 'snooze',
};

/**
 * Encode (proposalId, action code) into a v2 callback_data string: `2|{proposalId}|{code}`.
 *
 * @param proposalId UUID v4 from the proposal store (the immutable payload key, D-07)
 * @param action     Short action code — 'a'=approve, 'e'=edit, 'r'=reject, 's'=snooze
 */
export function encodeProposalCallbackData(proposalId: string, action: ProposalCode): string {
  return `2|${proposalId}|${action}`;
}

/**
 * Decode a v2 proposal callback_data string back into { proposalId, action }.
 *
 * Mirrors v1 strictness (T-22-02): returns null on ANY malformed or unrecognized input.
 * Requires exactly 3 pipe-delimited parts, version === '2', a non-empty proposalId, and a
 * code in the closed set. A v1 string (`1|...`) returns null here, and a v2 string returns
 * null from decodeCallbackData — the two versions never cross-decode.
 *
 * @param data Raw callback_data from Telegram (attacker-influenceable — never trust)
 */
export function decodeProposalCallbackData(
  data: string,
): { proposalId: string; action: ProposalAction } | null {
  if (!data) return null;

  const parts = data.split('|');
  if (parts.length !== 3) return null;

  const [version, proposalId, code] = parts as [string, string, string];

  // Version check — only v2; a v1 (or any other) string is rejected.
  if (version !== '2') return null;

  // Field presence
  if (!proposalId || !code) return null;

  // Action code mapping (closed set — any unknown code → null)
  const action = PROPOSAL_DECODE[code as ProposalCode] ?? null;
  if (!action) return null;

  return { proposalId, action };
}
