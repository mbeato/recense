/**
 * HTTP proposal client for the proposal-reference adapter.
 *
 * Provides listProposals()/approve()/reject() against recense serve's frozen v66
 * `/v1/proposals` surface over plain-fetch HTTP with Authorization: Bearer.
 *
 * Zero src/ imports — CONSUME-02 enforced at build time by
 * clients/proposal-reference/tsconfig.json (no paths/references) and at scan time
 * by tests/import-boundary.test.ts. Zero imports at all — Node global `fetch` only,
 * mirroring clients/telegram/memory-client.ts.
 *
 * This module does NOT interpret or classify HTTP statuses and does NOT parse or
 * branch on the `detail` string in an error response — that discipline belongs to
 * the caller (67-02's index.ts). It only surfaces the raw numeric status via
 * ProposalHttpError so the caller can branch.
 */

// ---------------------------------------------------------------------------
// Locally-declared wire vocabulary (CONSUME-02: transcribed by hand, never imported)
// ---------------------------------------------------------------------------

/** Mirrors src/db/action-proposal-store.ts:ProposalKind. Declared locally per CONSUME-02. */
export type ProposalKind = 'belief';

/** Mirrors src/db/action-proposal-store.ts:ProposalStatus. Declared locally per CONSUME-02. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired';

/**
 * The `schema_version` value this adapter was written against (src/db/schema.ts
 * SCHEMA_VERSION === 17 at authoring time). A mismatch on a fetched record is a
 * stop condition for the caller (D-07) — never coerce a proposal with a different
 * schema_version into this adapter's mapping logic.
 */
export const PROPOSAL_SCHEMA_VERSION = 17;

/**
 * Mirrors src/db/action-proposal-store.ts:ActionProposalRecord (16 fields).
 * Declared locally, by hand — CONSUME-02 forbids importing this from `src/`.
 */
export interface ActionProposalRecord {
  id: string;
  kind: ProposalKind;
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

export interface ProposalClient {
  listProposals(): Promise<ActionProposalRecord[]>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP proposal client bound to a specific recense serve instance.
 *
 * @param serveUrl   Base URL of recense serve (e.g. 'http://127.0.0.1:7701')
 * @param serveToken Bearer token for recense serve. Built once at factory scope
 *                   (T-67-01) and never logged, stringified, or persisted.
 */
export function createProposalClient(serveUrl: string, serveToken: string): ProposalClient {
  // Construct the header value once — never logged (T-67-01)
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
    // the outcome (D-03).
  }

  return {
    /**
     * GET /v1/proposals — list pending proposals. No query parameters in v1;
     * the response is bounded server-side by PROPOSAL_LIST_LIMIT.
     *
     * Throws ProposalHttpError('serve HTTP {status}') on non-2xx.
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

    /** POST /v1/proposals/:id/approve. Throws ProposalHttpError on non-2xx. */
    async approve(id: string): Promise<void> {
      await postAction('/v1/proposals/' + id + '/approve');
    },

    /** POST /v1/proposals/:id/reject. Throws ProposalHttpError on non-2xx. */
    async reject(id: string): Promise<void> {
      await postAction('/v1/proposals/' + id + '/reject');
    },
  };
}
