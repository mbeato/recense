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
 * Version-3 belief format (Phase 68 — APPROVE-01/02): `3|{localId}|{code}`
 *   - Version prefix `3` distinguishes belief-proposal callbacks from v1/v2
 *   - localId: 32-hex local store key (beliefLocalId(serverProposalId) — the server's
 *     64-hex sha256 id truncated, see belief-bridge.ts). The truncation exists BECAUSE
 *     the full 64-hex server id would push the payload to 68 bytes and silently fail
 *     Telegram's callback_data limit — 32 hex chars is the largest id that fits.
 *   - code: a=approve, e=edit, r=reject, s=snooze (same closed vocabulary as v2)
 *   Total: 36 bytes (1 version digit + 32 id chars + 1 code char + 2 pipe
 *   separators) — inside the 64-byte limit. (The local id is a 32-hex truncation
 *   of the server's 64-hex sha256 id specifically because the full id would push
 *   this to 68 bytes and silently overflow Telegram's 64-byte callback_data cap.)
 *   decodeBeliefCallbackData mirrors v2's strictness and adds one check v2 lacks: the id
 *   is validated against ^[0-9a-f]{32}$ before being returned, because callback_data is
 *   attacker-influenceable and the id is used directly as a store lookup key. v1, v2, and
 *   v3 are mutually exclusive by version prefix and part count — no cross-decoding.
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

// ---------------------------------------------------------------------------
// Version-3 belief-proposal codec (Phase 68 — APPROVE-01/02)
// ---------------------------------------------------------------------------

/** Single-character action codes carried in v3 callback_data (same closed set as v2). */
type BeliefCode = 'a' | 'e' | 'r' | 's';

const BELIEF_DECODE: Record<BeliefCode, ProposalAction> = {
  a: 'approve',
  e: 'edit',
  r: 'reject',
  s: 'snooze',
};

/**
 * The local store key shape: 32 lowercase hex characters (beliefLocalId's truncation
 * of the server's 64-hex sha256 id — see belief-bridge.ts). callback_data is
 * attacker-influenceable and this id is used directly as a store lookup key, so it is
 * validated here before being returned — a check v2's decodeProposalCallbackData does
 * not need because v2's UUID ids are never used to construct a filesystem/HTTP path
 * the way a malformed belief id could steer a lookup.
 */
const BELIEF_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Encode (localId, action code) into a v3 callback_data string: `3|{localId}|{code}`.
 *
 * @param localId The 32-hex local store key (beliefLocalId(serverProposalId)).
 * @param action  Short action code — 'a'=approve, 'e'=edit, 'r'=reject, 's'=snooze
 */
export function encodeBeliefCallbackData(localId: string, action: BeliefCode): string {
  return `3|${localId}|${action}`;
}

/**
 * Decode a v3 belief callback_data string back into { localId, action }.
 *
 * Mirrors v2's strictness (T-22-02) and adds the id-shape check v2 lacks: requires
 * exactly 3 pipe-delimited parts, version === '3', a localId matching
 * `^[0-9a-f]{32}$`, and a code in the closed set. Any malformed input returns null.
 * A v1 or v2 string returns null here (wrong part count or version), and a v3 string
 * returns null from decodeCallbackData / decodeProposalCallbackData — the three
 * versions never cross-decode.
 *
 * @param data Raw callback_data from Telegram (attacker-influenceable — never trust)
 */
export function decodeBeliefCallbackData(
  data: string,
): { localId: string; action: ProposalAction } | null {
  if (!data) return null;

  const parts = data.split('|');
  if (parts.length !== 3) return null;

  const [version, localId, code] = parts as [string, string, string];

  // Version check — only v3; a v1/v2 (or any other) string is rejected.
  if (version !== '3') return null;

  // Field presence + id shape (callback_data is attacker-influenceable — the id
  // is used as a store lookup key, so it is validated before being returned).
  if (!localId || !code) return null;
  if (!BELIEF_ID_RE.test(localId)) return null;

  // Action code mapping (closed set — any unknown code → null)
  const action = BELIEF_DECODE[code as BeliefCode] ?? null;
  if (!action) return null;

  return { localId, action };
}
