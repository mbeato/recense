/**
 * HTTP bridge client for belief-shaped proposals (Phase 68 — APPROVE-01/02).
 *
 * Provides listProposals()/approve()/reject() against recense serve's frozen v66
 * `/v1/proposals` surface over plain-fetch HTTP with Authorization: Bearer.
 *
 * Zero imports — Node global `fetch` only, mirroring
 * clients/telegram/memory-client.ts's zero-import posture and satisfying CLIENT-01
 * (the hardened import-boundary guard scans this file automatically).
 *
 * This module does NOT interpret or classify HTTP statuses and does NOT parse or
 * branch on the `detail` string in an error response — that discipline belongs to
 * the caller (Plan 03's handler), exactly as clients/proposal-reference/index.ts
 * splits it from clients/proposal-reference/proposal-client.ts.
 */

// ---------------------------------------------------------------------------
// Locally-declared wire vocabulary (CONSUME-02-style discipline: transcribed by
// hand, never imported from src/)
// ---------------------------------------------------------------------------

/** Mirrors src/db/action-proposal-store.ts:ProposalStatus. Declared locally. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired';

/**
 * The `schema_version` value this client was written against (src/db/schema.ts
 * SCHEMA_VERSION === 17 at authoring time). A mismatch on a fetched record is a
 * stop condition for the caller — never a coercion.
 */
export const PROPOSAL_SCHEMA_VERSION = 17;

/**
 * Mirrors src/db/action-proposal-store.ts:ActionProposalRecord (16 fields).
 * Declared locally, by hand — never imported from `src/`.
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
  status: ProposalStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

/**
 * Returns true only when `v` is a non-null object carrying every key
 * `ActionProposalRecord` requires WITH the value type the consumer reads
 * (WR-05): strings where strings are read (`id` additionally matching the
 * 64-hex sha256 shape it is later interpolated from), `string | null` for
 * `change_from`, numbers for the timestamps and `schema_version`, and the
 * closed categorical enum for `confidence` (it is rendered as plain text, so
 * free text there could carry structure into the decision card). `kind` and
 * `status` are checked as strings only — unknown vocabulary there is a
 * per-record SKIP decision for the caller (bridge step 4), not a
 * stop-the-pass malformation.
 *
 * A false return is a stop condition for the whole pass: nothing may be
 * persisted or rendered from a list response containing a malformed item.
 */
export function isInspectableProposalRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' && PROPOSAL_ID_RE.test(r['id']) &&
    typeof r['kind'] === 'string' &&
    typeof r['entity_node_id'] === 'string' &&
    typeof r['entity_descriptor'] === 'string' &&
    typeof r['belief_node_id'] === 'string' &&
    typeof r['change_field'] === 'string' &&
    (r['change_from'] === null || typeof r['change_from'] === 'string') &&
    typeof r['change_to'] === 'string' &&
    typeof r['evidence_episode'] === 'string' &&
    typeof r['evidence_quote'] === 'string' &&
    (r['confidence'] === 'high' || r['confidence'] === 'medium' || r['confidence'] === 'low') &&
    typeof r['schema_version'] === 'number' &&
    typeof r['status'] === 'string' &&
    typeof r['created_at'] === 'number' &&
    typeof r['updated_at'] === 'number' &&
    typeof r['expires_at'] === 'number'
  );
}

/**
 * Proposal ids are sha256 hex by construction (docs/reference-client.md) and the
 * server enforces this shape inbound. Enforce the same shape client-side before
 * interpolating an id into a request path: WHATWG URL normalization in `fetch`
 * collapses dot segments, so an id containing `/`, `..`, `?`, or `#` from a
 * malformed list response would steer the authenticated POST onto a route this
 * client never intended to call (67's WR-04 lesson). Fail-closed: a
 * non-conforming id builds no request at all.
 */
const PROPOSAL_ID_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown on any non-2xx response. Carries the raw numeric status in a
 * machine-readable field so the caller can branch on it — this module never
 * interprets the status or the `detail` string itself.
 */
export class ProposalHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('serve HTTP ' + String(status));
    this.status = status;
    this.name = 'ProposalHttpError';
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface BeliefProposalClient {
  listProposals(): Promise<ActionProposalRecord[]>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP belief-proposal client bound to a specific recense serve instance.
 *
 * @param serveUrl   Base URL of recense serve (e.g. 'http://127.0.0.1:7701')
 * @param serveToken Bearer token for recense serve. Built once at factory scope
 *                   and never logged, stringified, or returned.
 */
export function createBeliefProposalClient(serveUrl: string, serveToken: string): BeliefProposalClient {
  // Construct the header value once — never logged, never in an Error message,
  // never returned (T-68-03).
  const authHeader = 'Bearer ' + serveToken;

  /**
   * Shared POST helper for the no-body approve/reject routes. Both routes take
   * no request body and never parse one server-side.
   */
  async function postAction(path: string): Promise<void> {
    const res = await fetch(serveUrl + path, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ProposalHttpError(res.status);
    // Discard the { status } ack — the caller's own local row is the record of
    // the outcome.
  }

  return {
    /**
     * GET /v1/proposals — list pending proposals. No query parameters in v1;
     * the response is bounded server-side by PROPOSAL_LIST_LIMIT.
     *
     * Throws ProposalHttpError('serve HTTP {status}') on non-2xx. Never throws
     * on an unexpected body shape — a body with no `items` array resolves to [].
     */
    async listProposals(): Promise<ActionProposalRecord[]> {
      const res = await fetch(serveUrl + '/v1/proposals', {
        method: 'GET',
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new ProposalHttpError(res.status);
      const body = await res.json() as { items?: unknown };
      return Array.isArray(body.items) ? body.items as ActionProposalRecord[] : [];
    },

    /**
     * POST /v1/proposals/:id/approve. Throws ProposalHttpError on non-2xx, and a
     * plain Error (before any request is made) on a malformed proposal id.
     */
    async approve(id: string): Promise<void> {
      if (!PROPOSAL_ID_RE.test(id)) {
        throw new Error('malformed proposal id — refusing to build request path');
      }
      await postAction('/v1/proposals/' + id + '/approve');
    },

    /**
     * POST /v1/proposals/:id/reject. Throws ProposalHttpError on non-2xx, and a
     * plain Error (before any request is made) on a malformed proposal id.
     */
    async reject(id: string): Promise<void> {
      if (!PROPOSAL_ID_RE.test(id)) {
        throw new Error('malformed proposal id — refusing to build request path');
      }
      await postAction('/v1/proposals/' + id + '/reject');
    },
  };
}
