// ---------------------------------------------------------------------------
// Client-local type contracts (engine-free copies of the channel shapes)
// ---------------------------------------------------------------------------

/** An inbound message from the Telegram channel. */
export interface InboundMessage {
  id: string;
  sender: string;
  text: string;
  ts: number;
}

/**
 * A callback_query update collected during fetchMessages.
 * Passed to runClientTick for draining after the message respond loop.
 */
export interface CollectedCallbackQuery {
  /** callback_query.id — passed to answerCallbackQuery to clear the Telegram spinner. */
  id: string;
  /** callback_query.data — the encoded payload (may be absent for URL buttons). */
  data: string | undefined;
  /** callback_query.from.id — checked against the allowlist before calling surfaceSeen. */
  fromId: number;
}

/**
 * Return value of a fetch operation.
 *
 * messages        — allowlisted inbound messages since the last committed cursor.
 * callbackQueries — button-tap updates collected from the same getUpdates batch.
 *                   Allowlist check is applied in runClientTick (not in fetchMessages).
 * commitTo        — the cursor value the caller SHOULD commit after processing all messages.
 *                   null on idle tick (nothing to process, no cursor advance needed).
 *                   On cold start (no cursor persisted), commitTo is the computed baseline
 *                   update_id even when messages is empty — the caller commits it to record
 *                   the baseline.
 */
export interface FetchResult {
  messages: InboundMessage[];
  callbackQueries: CollectedCallbackQuery[];
  commitTo: string | null;
}

// ---------------------------------------------------------------------------
// Approval-gated MCP execution types (Phase 23)
// ---------------------------------------------------------------------------

/**
 * Per-tool allowlist entry defined in the mcp-servers.json config file (D-05).
 *
 * destructive: D-08 — user-classified per tool; NEVER derived from server-advertised
 * `destructiveHint` / `readOnlyHint` annotations. Absence defaults to true (H-10):
 * callers parse with `entry.destructive ?? true`.
 */
export interface AllowlistEntry {
  /** Tool name exactly as returned by listTools(). */
  name: string;
  /**
   * Whether this tool is classified as destructive (D-08).
   * Must be set explicitly in mcp-servers.json; absence defaults to true (H-10).
   * Server-advertised destructiveHint / readOnlyHint NEVER influence this field.
   */
  destructive: boolean;
}

/**
 * A single MCP server entry from the mcp-servers.json config file (D-05).
 *
 * Secrets in `env` values and `url` are stored as `${ENV_VAR}` references and
 * are interpolated from process.env at load time (H-14). Never inline secrets
 * as literals in the config file.
 */
export interface McpServerConfig {
  /** Logical name for this server — referenced in allowlist enforcement (D-04). */
  name: string;
  /** Transport type: stdio (subprocess) or http (StreamableHTTP). */
  transport: 'stdio' | 'http';
  /** stdio only: executable command to run. */
  command?: string;
  /** stdio only: command-line arguments to pass to the subprocess. */
  args?: string[];
  /**
   * http only: base URL of the MCP server.
   * May contain ${ENV_VAR} references (H-14 — secrets stay in env, never inline).
   */
  url?: string;
  /**
   * Environment variables to inject into the stdio subprocess.
   * Values may contain ${ENV_VAR} references (H-14).
   */
  env?: Record<string, string>;
  /** Per-tool allowlist for this server (D-04). destructive defaults to true (D-08 / H-10). */
  allowedTools: AllowlistEntry[];
}

/**
 * An immutable pending tool-call proposal stored between propose-time and
 * execute-time (D-07).
 *
 * The `args` field is stored exactly as shown on the approval card and is NEVER
 * re-queried from the engine at execute-time — prevents TOCTOU where memory changes
 * between propose and execute (D-07).
 */
export interface StoredToolProposal {
  /** Discriminant — the tool-call proposal kind (Phase 68 D-01). */
  kind: 'tool';
  /** UUID v4 — the proposalId embedded in the v2 callback_data payload. */
  id: string;
  /** Matches McpServerConfig.name — used for allowlist re-check at execute-time (D-04). */
  serverName: string;
  /** Tool name from the allowlisted set — immutable after propose-time. */
  tool: string;
  /**
   * Exact tool arguments shown on the approval card (D-07 — IMMUTABLE).
   * Never re-fetched, re-generated, or overridden at execute-time.
   */
  args: Record<string, unknown>;
  /**
   * The surfaced item's node_id — paired with `dueAt` (as occurrence_due_at) to record
   * a terminal surfaceSeen outcome on execute-success or reject (GAP-02 / ACT-01).
   * Populated by tryGenerateProposal from item.node_id; carried through by handleEditPatch.
   */
  nodeId: string;
  /** P0 item's due_at (ISO 8601 UTC) — expiry anchor checked at execute-time (D-07). */
  dueAt: string;
  /**
   * Absolute max time-to-live in ms from createdAt (D-07).
   * Proposal is expired if createdAt + maxTtlMs < now(), even when dueAt is in the future.
   */
  maxTtlMs: number;
  /** ISO 8601 UTC timestamp when the proposal was written — included in the audit episode. */
  createdAt: string;
  /**
   * Whether this tool requires typed confirmation before execution (D-09 / D-08).
   * Sourced from AllowlistEntry.destructive (user-classified; never from server hints).
   */
  destructive: boolean;
  /**
   * The exact value the user must type to confirm a destructive action (D-09).
   * Set at propose-time from the immutable payload; NEVER re-derived at confirm-check time.
   * Typically the tool name or a key argument value (e.g. a recipient address).
   */
  expectedConfirmValue: string;
}

/**
 * The server-side status vocabulary for a belief-shaped action proposal (Phase 68 /
 * APPROVE-02). Mirrors `ActionProposalRecord.status` from the frozen `/v1/proposals`
 * contract (`clients/proposal-reference/proposal-client.ts:26`) — declared by hand
 * here, never imported from src/ (CLIENT-01).
 */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired';

/**
 * An immutable pending belief-shaped proposal, bridged from the frozen `/v1/proposals`
 * HTTP contract (Phase 66/68 — APPROVE-01/02).
 *
 * `dueAt` / `createdAt` / `maxTtlMs` exist SOLELY so this member satisfies the exact
 * field contract `proposal-store.ts`'s `isExpired()` reads (`p.dueAt`,
 * `p.createdAt + p.maxTtlMs`). Carrying them — synthesized from the server record's
 * `expires_at` at bridge time (see belief-bridge.ts) — is the concrete mechanism by
 * which this member rides the existing store with ZERO changes to proposal-store.ts
 * or proposal-engine.ts (APPROVE-02, locked verbatim in the ROADMAP SC).
 *
 * `confidence` is categorical-only and is NEVER a gate (D-06) — no numeric confidence
 * field is added on this type, ever. The PE gate upstream (engine-side) is the only gate.
 */
export interface StoredBeliefProposal {
  /** Discriminant — the belief-shaped proposal kind (Phase 68 D-01). */
  kind: 'belief';
  /** LOCAL store key — beliefLocalId(serverProposalId), NOT the server id (see belief-bridge.ts). */
  id: string;
  /** The server's 64-lowercase-hex sha256 proposal id — the only value ever interpolated into a request path. */
  serverProposalId: string;
  /** Verbatim from the record — never normalized, trimmed, or paraphrased (D-05). */
  entityDescriptor: string;
  /** Verbatim from the record (D-05). */
  changeField: string;
  /** Verbatim sentence, or null — never normalized (D-05). */
  changeFrom: string | null;
  /** Verbatim status token (D-05). */
  changeTo: string;
  /** Verbatim, rendered as fenced data only — never a gate (D-05/D-06). */
  evidenceQuote: string;
  /** Categorical only — never a numeric gate (D-06). */
  confidence: 'high' | 'medium' | 'low';
  /**
   * The server record's own `created_at` (epoch ms), carried through so a later
   * batching pass can headline the genuinely latest transition in a group instead
   * of inferring recency from expiry order.
   */
  serverCreatedAtMs: number;
  /** Client-local status tracking — mirrors the terminal/pending split used elsewhere in this client. */
  localStatus: 'pending' | 'terminal';
  /**
   * Store-compatibility field — synthesized so `Date.parse(dueAt) === record.expires_at`.
   * See the field-contract note on this interface and belief-bridge.ts's mapping.
   */
  dueAt: string;
  /** Store-compatibility field — ISO 8601 UTC timestamp when this row was bridged locally. */
  createdAt: string;
  /**
   * Store-compatibility field — synthesized so the two `isExpired()` conditions
   * (`now > Date.parse(dueAt)` and `now > Date.parse(createdAt) + maxTtlMs`) coincide
   * at the server's `expires_at`. NEVER 0 unless the record is already past expiry at
   * bridge time (see belief-bridge.ts's explicit warning comment on this mapping).
   */
  maxTtlMs: number;
}

/**
 * An immutable pending proposal stored between propose-time and decision-time.
 * Discriminated union over `kind`: `'tool'` (MCP tool-call proposals, Phase 23) and
 * `'belief'` (belief-shaped proposals bridged from `/v1/proposals`, Phase 68).
 */
export type StoredProposal = StoredToolProposal | StoredBeliefProposal;

/**
 * The four actions a user can take on a pending proposal via Telegram inline keyboard (ACT-01).
 * Maps to v2 callback_data single-character codes: a=approve, e=edit, r=reject, s=snooze.
 */
export type ProposalAction = 'approve' | 'edit' | 'reject' | 'snooze';
