import { appendFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { type ClientConfig, type ActionConfig, loadClientConfig, loadActionConfig, loadMcpConfig } from './config';
import { readStateCursor, writeStateCursor } from './state';
import { DefaultTelegramTransport, type TelegramTransport, type InlineKeyboardMarkup } from './transport';
import { type FetchResult, type InboundMessage, type CollectedCallbackQuery, type McpServerConfig, type StoredProposal, type ProposalAction } from './types';
import { createMemoryClient, type MemoryClient, type SurfaceItem } from './memory-client';
import { encodeCallbackData, decodeCallbackData, encodeProposalCallbackData, decodeProposalCallbackData } from './push-codec';
import { putProposal, tryReserveProposalSlot, loadExecutable, removeProposal } from './proposal-store';
import {
  filterAllowlisted,
  buildProposalPrompt,
  callDeepSeek,
  validateProposal,
  deriveConfirmValue,
  type FetchImpl,
} from './proposal-engine';
import { listServerTools, callServerTool, extractToolOutput, defaultConnectionFactory, type McpConnectionFactory } from './mcp-client';

// ---------------------------------------------------------------------------
// Log helper — append-only file log; never stdout (background process, T-13-05)
// Bearer token and bot token MUST NOT appear in log messages.
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/recense-telegram-client.log';

/** Append a timestamped line to the log file. */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] telegram-client: ${msg}\n`);

// ---------------------------------------------------------------------------
// In-process tick serialization guards
//
// tickInFlight: Set true BEFORE the first await inside runClientTick; cleared in
//   the outermost finally so it resets even on the early-return (ask error / idle)
//   paths. Prevents a second setInterval tick from overlapping with an in-flight respond.
//
// pushInFlight: Independent guard for runPushTick — the push timer and the reactive
//   tick run on separate setIntervals and must each have their own guard. Never share.
// ---------------------------------------------------------------------------

let tickInFlight = false;
let pushInFlight = false;

// ---------------------------------------------------------------------------
// Typed-confirm state machine — module-level pending map (D-09 / ACT-03)
// ---------------------------------------------------------------------------

/**
 * In-memory pending typed-confirm entries keyed by Telegram sender id (string).
 * Process lifetime only — if the client restarts, state is lost and the user must
 * re-tap Approve (safe: the proposal-store persists across restarts). Risk 2.
 *
 * Each entry carries the proposalId (to load the immutable payload at confirm time),
 * the exact expectedValue from the STORED payload (H-08 — never re-derived from
 * DeepSeek), and an expiresAt epoch-ms to bound the confirm window (5 minutes).
 */
const pendingTypedConfirm = new Map<string, {
  proposalId: string;
  expectedValue: string;
  expiresAt: number;
}>();

/**
 * Test helper: drain all pending typed-confirm entries between test cases.
 * Never called in production code paths.
 */
export function _clearPendingTypedConfirm(): void {
  pendingTypedConfirm.clear();
}

// ---------------------------------------------------------------------------
// Pending-edit state machine — module-level pending map (D-06)
// ---------------------------------------------------------------------------

/**
 * In-memory pending edit entries keyed by Telegram sender id (string).
 * Process lifetime only — if the client restarts, state is lost and the user must
 * re-tap Edit (safe: the proposal-store persists across restarts). Risk 2 (same as
 * pendingTypedConfirm).
 *
 * Each entry carries the proposalId and an expiresAt epoch-ms to bound the edit
 * window (5 minutes). The patch text arrives as the next message from this sender.
 */
const pendingEdit = new Map<string, {
  proposalId: string;
  expiresAt: number;
}>();

/**
 * Test helper: drain all pending edit entries between test cases.
 * Never called in production code paths.
 */
export function _clearPendingEdit(): void {
  pendingEdit.clear();
}

// ---------------------------------------------------------------------------
// Inlined Telegram fetch logic
// Ported from src/channel/telegram-channel.ts TelegramChannel.fetch().
// Cursor source is the client-local state file (readStateCursor), not MetaStore.
// ---------------------------------------------------------------------------

/**
 * Poll Telegram for new allowlisted messages and callback_query updates.
 * Performs NO state write (T-LOCK-01).
 *
 * Fail-closed: empty allowlist → {messages:[], callbackQueries:[], commitTo:null} — idle,
 *   no ask call made.
 * Private chats only: the allowlist authorizes the SENDER, but replies go to the CHAT —
 *   a group update from an allowlisted sender would broadcast memory content to unlisted
 *   members, so non-private chats are skipped (still confirmed via commitTo).
 * Cold start (no cursor): paginates to exhaustion (L-9), returns baseline commitTo with
 *   empty messages so the caller can commit the baseline and skip the backlog.
 * Normal: fetches updates after cursor; zero new → idle; otherwise returns allowlisted
 *   InboundMessages, collected callback_query items, and max scanned update_id as commitTo.
 * Never throws (C-1): transport errors are caught, logged, and returned as idle.
 */
export async function fetchMessages(
  transport: TelegramTransport,
  config: Pick<ClientConfig, 'allowlist' | 'statePath'>,
): Promise<FetchResult> {
  try {
    // Fail-closed — empty allowlist answers no one; commitTo=null signals idle (D-10)
    if (config.allowlist.length === 0) {
      return { messages: [], callbackQueries: [], commitTo: null };
    }

    const cursorRaw = readStateCursor(config.statePath);

    // Cold start (no cursor persisted): paginate to exhaustion to get the true current
    // max update_id — a >100-update backlog is only partially scanned by a single
    // getUpdates(0) call (Telegram default page = 100). Answer NOTHING; caller commits
    // the baseline so the next tick fetches only genuinely new messages (D-71, L-9).
    if (cursorRaw === null) {
      let offset = 0;
      let maxId = 0;
      while (true) {
        const page = await transport.getUpdates(offset);
        if (page.length === 0) break;
        for (const u of page) {
          if (u.update_id > maxId) maxId = u.update_id;
        }
        offset = maxId + 1;
      }
      log('cold start: telegram baseline at update_id ' + String(maxId) + ' — backlog skipped');
      return { messages: [], callbackQueries: [], commitTo: String(maxId) };
    }

    const cursor = parseInt(cursorRaw, 10);
    // offset = cursor + 1 → fetch updates with update_id > cursor (Telegram confirms <= cursor)
    const updates = await transport.getUpdates(cursor + 1);
    if (updates.length === 0) {
      // No new updates — commitTo:null signals idle (caller skips cursor write)
      return { messages: [], callbackQueries: [], commitTo: null };
    }

    // commitTo covers ALL scanned updates (listed or not) — unlisted ones are confirmed
    // so they are not re-fetched on the next tick.
    const maxId = updates.reduce((max, u) => Math.max(max, u.update_id), cursor);
    const allow = new Set(config.allowlist.map(s => s.trim()));

    const messages: InboundMessage[] = [];
    const callbackQueries: CollectedCallbackQuery[] = [];

    for (const u of updates) {
      // Collect callback_query updates (allowlist applied in runClientTick, not here,
      // so all callback_query items are returned; update_id already covered by maxId).
      if (u.callback_query) {
        const cq = u.callback_query;
        callbackQueries.push({ id: cq.id, data: cq.data, fromId: cq.from.id });
      }

      const msg = u.message;
      // Ignore non-text or malformed updates (stickers, photos, joins, channel posts, etc.)
      if (
        !msg ||
        !msg.from ||
        !msg.chat ||
        typeof msg.text !== 'string' ||
        msg.text.length === 0
      ) {
        continue;
      }
      const fromId = String(msg.from.id);
      if (!allow.has(fromId)) {
        log('ignored unlisted telegram sender');
        continue;
      }
      // Private chats only: in a Telegram private chat, chat.id === from.id — require
      // both the declared type and the id equality so a group reply target can never
      // leak memory content to unlisted chat members. Skipped updates stay covered by
      // commitTo (computed above), so they are confirmed and not re-fetched.
      if (msg.chat.type !== 'private' || String(msg.chat.id) !== fromId) {
        log('ignored non-private telegram chat');
        continue;
      }
      messages.push({
        id: String(u.update_id),
        sender: String(msg.chat.id), // reply target (=== sender id in a private chat)
        text: msg.text,
        ts: msg.date * 1000, // Telegram date is Unix seconds → ms
      });
    }

    return { messages, callbackQueries, commitTo: String(maxId) };
  } catch (err) {
    // C-1: "never throws" — transport errors must not crash the poll loop.
    // Log to file, return idle so the cursor is never advanced on fetch error.
    log('telegram fetch error: ' + String(err));
    return { messages: [], callbackQueries: [], commitTo: null };
  }
}

// ---------------------------------------------------------------------------
// Full tick: fetch + stale-filter + respond + callback_query drain + cursor commit
// Ported from src/adapter/watcher-cli.ts runLockedTick (engine lock removed).
// ---------------------------------------------------------------------------

/**
 * Fetch-then-respond tick, lock-free (cursor is client-local state file).
 *
 * Flow:
 *  1. tickInFlight guard — if already in-flight, log + return without fetching.
 *  2. fetchMessages() — write-free; errors return idle (C-1 never-throws).
 *  3. Idle check — commitTo === null && messages empty && no callbackQueries → return.
 *  4. Re-read live cursor via readStateCursor; drop messages with id <= cursor (stale).
 *  5. Monotonic commit check — if commitTo <= cursor, skip cursor write.
 *  6. Respond loop — ask() each message; safe-null: only send when answer !== null
 *     && origin !== 'none'. Inferred answers carry a visible '(inferred) ' prefix
 *     unless the server-composed answer already ends with the marker.
 *  7. D-04 no-loss: if ask() throws (serve unreachable / non-2xx), log + RETURN
 *     WITHOUT committing cursor → message retried next tick, no message loss.
 *  8. callback_query draining — decode → allowlist check → surfaceSeen → answerCallbackQuery.
 *     Critical: callback errors do NOT hold the cursor (unlike D-04 for messages). The
 *     surfaceSeen upsert is idempotent; a re-tap resends; cursor-hold would re-process
 *     the same callback on every tick. answerCallbackQuery ALWAYS called (clears spinner).
 *  9. Commit cursor via writeStateCursor when not skipCommit.
 */
export async function runClientTick(
  config: ClientConfig,
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  approvalHooks?: ApprovalTestHooks,
): Promise<void> {
  // ── 1. In-process tick guard (must be set BEFORE first await) ────────────
  if (tickInFlight) {
    log('tick already in flight — skipping re-entry');
    return;
  }
  tickInFlight = true;

  try {
    // ── 2. Fetch UNLOCKED — no state write ─────────────────────────────────
    // Belt-and-suspenders outer catch: fetchMessages should never throw (C-1),
    // but if it does, log and return without advancing the cursor.
    let messages: InboundMessage[];
    let callbackQueries: CollectedCallbackQuery[];
    let commitTo: string | null;
    try {
      ({ messages, callbackQueries, commitTo } = await fetchMessages(transport, config));
    } catch (err) {
      log('fetch error: ' + String(err));
      return;
    }

    // ── 3. Idle check ───────────────────────────────────────────────────────
    if (commitTo === null && messages.length === 0 && callbackQueries.length === 0) {
      return;
    }

    // ── 4. Re-read live cursor to drop stale messages ───────────────────────
    // A previous tick may have committed the cursor between our unlocked fetch()
    // and now. Drop any message whose id <= the current committed cursor.
    const cursor = readStateCursor(config.statePath);
    const filtered =
      cursor !== null
        ? messages.filter(m => Number(m.id) > Number(cursor))
        : messages;

    // ── 5. Monotonic commit check ───────────────────────────────────────────
    // If commitTo <= cursor, the cursor already covers this batch — skip the write.
    const skipCommit =
      commitTo !== null && cursor !== null && Number(commitTo) <= Number(cursor);

    // ── 5.5. Lazy approval-config getters ──────────────────────────────────
    // Computed on first use only — no config I/O overhead on idle or Q&A-only ticks.
    // Used by both the typed-confirm intercept (step 6.5, Task 2) and callback drain (step 8).
    let _approvalStorePath: string | undefined;
    let _approvalMcpConfigs: McpServerConfig[] | undefined;
    const getApprovalStorePath = (): string => {
      if (_approvalStorePath === undefined) {
        _approvalStorePath = approvalHooks?.storePath ?? loadActionConfig().proposalStorePath;
      }
      return _approvalStorePath;
    };
    const getApprovalMcpConfigs = (): McpServerConfig[] => {
      if (_approvalMcpConfigs === undefined) {
        _approvalMcpConfigs = approvalHooks?.mcpConfigs ?? loadMcpConfig();
      }
      return _approvalMcpConfigs;
    };

    // ── 6–7. Respond loop ───────────────────────────────────────────────────
    for (const m of filtered) {
      // ── Typed-confirm intercept (Pitfall #3 — BEFORE ask()) ──────────────
      // When a user has an open typed-confirm entry, their next message is the
      // confirmation, NOT a Q&A query. Checking here prevents the confirmation
      // value from being routed to memoryClient.ask (which would answer it as a
      // memory question and never fire the execute path).
      // Security: expectedValue comes from the STORED payload (H-08, not re-derived).
      const pendingConfirm = pendingTypedConfirm.get(m.sender);
      if (pendingConfirm !== undefined) {
        pendingTypedConfirm.delete(m.sender); // consume entry regardless of outcome
        if (pendingConfirm.expiresAt > Date.now()) {
          if (m.text.trim() === pendingConfirm.expectedValue) {
            // Correct value → execute the stored proposal via shared helper
            try {
              await executeStoredProposal(
                transport, memoryClient,
                getApprovalMcpConfigs(), getApprovalStorePath(),
                pendingConfirm.proposalId, Number(m.sender),
                approvalHooks?.connectionFactory,
              );
            } catch (err) {
              log('executeStoredProposal error (typed-confirm): ' + String(err));
            }
          } else {
            // Wrong value → abort; write failure episode
            try { await transport.sendMessage(Number(m.sender), 'Confirmation did not match — aborted.'); }
            catch (e) { log('send error (confirm-failed): ' + String(e)); }
            try { await memoryClient.hitlEpisode({ decision: 'confirm-failed' }); }
            catch (e) { log('hitlEpisode error (confirm-failed): ' + String(e)); }
          }
        }
        // Either way: skip Q&A for this message (Pitfall #3 — entry consumed above)
        continue;
      }

      // ── Pending-edit intercept (D-06 — BEFORE ask()) ─────────────────────
      // Mirror of the typed-confirm intercept: if the sender has a pending-edit
      // entry, consume the text as the patch, NOT a Q&A query (T-23-07-C).
      // Checked AFTER typed-confirm — they are mutually exclusive in practice
      // (a sender cannot simultaneously have both open), but typed-confirm has
      // semantic priority.
      const pendingEditEntry = pendingEdit.get(m.sender);
      if (pendingEditEntry !== undefined) {
        pendingEdit.delete(m.sender); // consume entry regardless of outcome
        if (pendingEditEntry.expiresAt > Date.now()) {
          try {
            await handleEditPatch(
              transport, memoryClient,
              getApprovalMcpConfigs(), getApprovalStorePath(),
              pendingEditEntry.proposalId, Number(m.sender), m.text,
              approvalHooks?.connectionFactory,
            );
          } catch (err) {
            log('handleEditPatch error: ' + String(err));
          }
        }
        // Either way: skip Q&A for this message (T-23-07-C — entry consumed above)
        continue;
      }

      let answer: string | null = null;
      let origin = 'none';
      try {
        ({ answer, origin } = await memoryClient.ask(m.text));
      } catch (err) {
        // D-04: serve unreachable or non-2xx → log, no reply, cursor NOT advanced.
        // Message will be retried on the next tick (no message loss).
        log('ask error — serve unreachable, cursor not advanced: ' + String(err));
        return;
      }
      // Safe-null (origin semantics D-09): only reply when memory has a grounded answer.
      // origin === 'none' or answer === null → stay silent (T-07-04 / D-75).
      if (answer !== null && origin !== 'none') {
        // Provenance presentation (docs/reference-client.md rule 1): mark inferred
        // answers visibly so the user knows they are reading an inference, not a
        // record. Idempotent: recense serve already embeds a trailing " (inferred)"
        // marker in inferred answers (src/responder), so the prefix is only added
        // when no marker is present — answers are never double-marked.
        const text =
          origin === 'inferred' && !answer.endsWith('(inferred)')
            ? '(inferred) ' + answer
            : answer;
        try {
          await transport.sendMessage(Number(m.sender), text);
        } catch (sendErr) {
          // Send errors do not prevent cursor advance — the message was answered.
          log('send error: ' + String(sendErr));
        }
      }
    }

    // ── 8. callback_query draining ──────────────────────────────────────────
    // MUST drain AFTER the message respond loop and BEFORE cursor commit.
    // Critical distinction from D-04: callback errors do NOT block cursor advance.
    // surfaceSeen is idempotent; a re-tap resends; cursor-hold would cause infinite
    // re-processing of the same callback. answerCallbackQuery is ALWAYS called on
    // every branch (allowlisted, unlisted, malformed, surfaceSeen-error, v2 proposal)
    // to clear the Telegram client-side spinner (Pitfall 1 — mandatory).
    //
    // Version-prefix routing (Phase 23):
    //   '2|...' → decodeProposalCallbackData → handleProposalAction (approval flow)
    //   '1|...' → decodeCallbackData → surfaceSeen (Phase-22 surface-seen flow, unchanged)
    //   other   → null → ack only (Pitfall 1 still applies)
    if (callbackQueries.length > 0) {
      const allow = new Set(config.allowlist.map(s => s.trim()));

      for (const cq of callbackQueries) {
        const fromId = String(cq.fromId);

        if (!allow.has(fromId)) {
          // Unlisted sender: skip surfaceSeen but still answer (T-22-01)
          log('callback_query from unlisted sender — ignored');
          try { await transport.answerCallbackQuery(cq.id); } catch (e) { log('answerCallbackQuery error (unlisted): ' + String(e)); }
          continue;
        }

        const data = cq.data ?? '';

        // ── v2 proposal callback (Phase 23) ───────────────────────────────
        // Check version prefix before passing to decodeCallbackData, so the v1
        // decoder is never called on a v2 string (they are mutually exclusive, Risk 5).
        if (data.startsWith('2|')) {
          const decodedProposal = decodeProposalCallbackData(data);
          if (decodedProposal) {
            try {
              await handleProposalAction(
                transport, memoryClient,
                getApprovalMcpConfigs(), getApprovalStorePath(),
                cq.fromId, decodedProposal,
                approvalHooks?.connectionFactory,
              );
            } catch (err) {
              log('handleProposalAction error: ' + String(err));
            }
          } else {
            log('callback_query: v2 malformed proposal data — skipping');
          }
          // MUST answer on every v2 branch — unconditional spinner clear (Pitfall 1)
          try { await transport.answerCallbackQuery(cq.id); } catch (e) { log('answerCallbackQuery error (v2): ' + String(e)); }
          continue;
        }

        // ── v1 surface-seen callback (Phase 22, unchanged) ────────────────
        // Decode callback_data — returns null on malformed input (T-22-02)
        const decoded = decodeCallbackData(data);
        if (!decoded) {
          log('callback_query: no callback_data or unrecognized format — skipping surfaceSeen');
          try { await transport.answerCallbackQuery(cq.id); } catch (e) { log('answerCallbackQuery error (malformed): ' + String(e)); }
          continue;
        }

        // Compute snooze_until only for snoozed outcome (D-09 fixed +snoozeDurationMs)
        const snoozeUntil =
          decoded.outcome === 'snoozed'
            ? new Date(Date.now() + config.snoozeDurationMs).toISOString()
            : undefined;

        try {
          await memoryClient.surfaceSeen({
            node_id: decoded.nodeId,
            occurrence_due_at: decoded.occurrenceDueAt,
            outcome: decoded.outcome,
            snooze_until: snoozeUntil,
          });
        } catch (err) {
          // Unlike message errors (D-04 no-loss), callback_query errors do NOT hold
          // the cursor. Log and continue — answerCallbackQuery still fires below.
          log('surfaceSeen error for callback_query: ' + String(err));
        }

        // MUST call on every branch — unconditional spinner clear (Pitfall 1)
        try {
          await transport.answerCallbackQuery(cq.id);
        } catch (err) {
          log('answerCallbackQuery error: ' + String(err));
        }
      }
    }

    // ── 9. Commit cursor AFTER successful processing ─────────────────────────
    // Cold start: commitTo is non-null with an empty filtered array — persists the
    // baseline so the next tick fetches only genuinely new messages (D-71).
    if (!skipCommit && commitTo !== null) {
      writeStateCursor(config.statePath, commitTo);
    }
  } finally {
    // Always reset the in-process guard — even on the ask-error return path
    tickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Proactive push helpers
// ---------------------------------------------------------------------------

/**
 * Check if a given local hour falls within quiet hours.
 *
 * Handles midnight-crossing ranges (start > end, e.g. 22→7):
 *   start === end → false (no quiet hours configured)
 *   start < end  → standard range: h >= start && h < end
 *   start > end  → midnight-crossing: h >= start || h < end
 *
 * Exported for direct testing of boundary conditions.
 */
export function isInQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // midnight-crossing (e.g. start=22, end=7): quiet from 22:00 to 06:59
  return hour >= start || hour < end;
}

/**
 * Build a Telegram inline keyboard with three buttons for a surfaced item.
 *
 * One row: "✅ Done" | "🗑 Dismiss" | "💤 Snooze"
 * callback_data uses the compact encoding from push-codec.ts (≤ 51 bytes, well within 64).
 * due_at normalized through new Date(item.due_at).toISOString() (A1 mitigation).
 */
function buildButtonMarkup(item: SurfaceItem): InlineKeyboardMarkup {
  const dueIso = new Date(item.due_at).toISOString();
  return {
    inline_keyboard: [[
      { text: '✅ Done',    callback_data: encodeCallbackData(item.node_id, dueIso, 'c') },
      { text: '🗑 Dismiss', callback_data: encodeCallbackData(item.node_id, dueIso, 'd') },
      { text: '💤 Snooze', callback_data: encodeCallbackData(item.node_id, dueIso, 's') },
    ]],
  };
}

/**
 * Render a surfaced item as a plain-text push message.
 * Data only — never interpolated as Telegram markup.
 */
function renderText(item: SurfaceItem): string {
  return `[${item.action_type}] ${item.value}\nDue: ${item.due_at}`;
}

/**
 * Send a surfaced item to a Telegram chat and mark it as surfaced (D-02 send-then-mark).
 *
 * Order:
 *   1. sendMessage() — at-least-once: a crash after send = rare duplicate, not silent drop.
 *   2. surfaceSeen({ outcome: 'surfaced' }) — marks the item so it is excluded from future
 *      surface() responses (server-side dedup via surfaced_event, D-03).
 *
 * T-22-03: text is plain data, never markup. Token never logged.
 */
async function sendSurfacedItem(
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  _config: ClientConfig,
  chatId: number,
  item: SurfaceItem,
): Promise<void> {
  // 1. Send first (at-least-once — D-02)
  await transport.sendMessage(chatId, renderText(item), buildButtonMarkup(item));
  // 2. Mark after send
  await memoryClient.surfaceSeen({
    node_id: item.node_id,
    occurrence_due_at: new Date(item.due_at).toISOString(),
    outcome: 'surfaced',
  });
}

// ---------------------------------------------------------------------------
// Proposal card rendering (ACT-01 / T-23-05-A)
// ---------------------------------------------------------------------------

/**
 * Render a pending proposal as a plain-text card.
 *
 * DATA ONLY — tool name, serialized args, and deadline.
 * NEVER contains DeepSeek prose or any LLM output (T-23-05-A / ACT-01).
 * Same no-markup discipline as renderText (plain text, not Telegram markdown).
 */
function renderProposalCard(proposal: StoredProposal): string {
  return `[Proposed Action]\nTool: ${proposal.tool}\nArgs: ${JSON.stringify(proposal.args)}\nDue: ${proposal.dueAt}`;
}

/**
 * Build the 4-button approval keyboard for a pending proposal (ACT-01).
 *
 * One row: "✅ Approve" | "✏️ Edit" | "❌ Reject" | "💤 Snooze"
 * Each button's callback_data is a v2 compact encoding (≤ 41 bytes, within 64-byte limit).
 */
function proposalKeyboard(proposalId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: encodeProposalCallbackData(proposalId, 'a') },
      { text: '✏️ Edit',   callback_data: encodeProposalCallbackData(proposalId, 'e') },
      { text: '❌ Reject', callback_data: encodeProposalCallbackData(proposalId, 'r') },
      { text: '💤 Snooze', callback_data: encodeProposalCallbackData(proposalId, 's') },
    ]],
  };
}

// ---------------------------------------------------------------------------
// Proposal generation (D-01 / D-02 / ACT-03)
// ---------------------------------------------------------------------------

/**
 * Test-injectable overrides for the proposal generation sub-path of runPushTick.
 *
 * Allows unit tests to pass scripted actionConfig, mcpConfigs, a mock
 * McpConnectionFactory, and a mock fetchImpl without any live network calls.
 */
export interface ProposalTestHooks {
  /** Override loadActionConfig() for deterministic daily cap / store path / DeepSeek key. */
  actionConfig?: ActionConfig;
  /** Override loadMcpConfig() to inject scripted server+allowlist configs. */
  mcpConfigs?: McpServerConfig[];
  /** Override the MCP connection factory (injectable McpConnection per mcp-client.ts). */
  connectionFactory?: McpConnectionFactory;
  /** Override global fetch for the DeepSeek HTTP call (no live network in tests). */
  fetchImpl?: FetchImpl;
}

/**
 * Test-injectable overrides for the approval handling sub-path of runClientTick.
 *
 * Allows unit tests to supply a scripted proposal store path, MCP server configs,
 * and connection factory without live filesystem writes or network calls.
 * Production code never passes this; it is only used in unit tests.
 */
export interface ApprovalTestHooks {
  /** Override loadActionConfig().proposalStorePath for deterministic proposal access. */
  storePath?: string;
  /** Override loadMcpConfig() to inject scripted server + allowlist configs. */
  mcpConfigs?: McpServerConfig[];
  /** Override the MCP connection factory (injectable McpConnection per mcp-client.ts). */
  connectionFactory?: McpConnectionFactory;
}

/**
 * Try to generate a confident tool proposal for a P0 surfaced item (D-01 / D-02).
 *
 * Flow:
 *   1. search(item.value) — memory context for arg parameterization.
 *   2. For each configured MCP server: listServerTools → filterAllowlisted.
 *      Connect + list errors are caught per-server; that server is skipped (Risk 3).
 *   3. If no allowlisted tools across all servers → null (plain notify fallback).
 *   4. buildProposalPrompt → callDeepSeek(temperature=0, json_object) → validateProposal.
 *   5. On confident {tool, args}: build StoredProposal with immutable payload (D-07).
 *   6. On {tool:null}, any engine error, or MCP timeout → null (D-02 plain notify fallback).
 *
 * Security invariants:
 *   - Tool descriptions are NEVER forwarded to DeepSeek (T-SEC-01 via buildAllowedToolSpec).
 *   - Memory data is delimiter-fenced as UNTRUSTED (T-SEC-03 via buildProposalPrompt).
 *   - Only allowlisted, fully-parameterized, validated proposals are returned (D-04).
 *   - The API key is NEVER logged (H-13 / T-13-05).
 *
 * @param memoryClient     Live or mock memory client (search + hitlEpisode).
 * @param item             The P0 surface item that triggered this proposal.
 * @param actionConfig     DeepSeek key, daily-cap config, store path, TTL.
 * @param mcpConfigs       Loaded server configs (already filtered by loadMcpConfig).
 * @param connectionFactory Injectable MCP connection factory (default: real SDK).
 * @param fetchImpl        Injectable fetch (default: global fetch for DeepSeek calls).
 * @returns                StoredProposal on success, null on any failure / unmappable item.
 */
export async function tryGenerateProposal(
  memoryClient: MemoryClient,
  item: SurfaceItem,
  actionConfig: ActionConfig,
  mcpConfigs: McpServerConfig[],
  connectionFactory?: McpConnectionFactory,
  fetchImpl?: FetchImpl,
): Promise<StoredProposal | null> {
  try {
    // 1. Memory context for arg parameterization (truncated in buildProposalPrompt, Risk 4)
    const searchResults = await memoryClient.search(item.value);

    // 2. Collect allowlisted tools across all servers
    // Track { descriptor, serverName, destructive } for post-validate lookup
    const toolEntries: Array<{
      descriptor: { name: string; inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] } };
      serverName: string;
      destructive: boolean;
    }> = [];

    for (const serverCfg of mcpConfigs) {
      if (serverCfg.allowedTools.length === 0) continue;
      try {
        // listServerTools already bounds with MCP_REQUEST_TIMEOUT_MS (SDK timeout).
        // Additional try/catch here: any connect/list/timeout error → skip this server (Risk 3).
        const serverTools = await listServerTools(serverCfg, connectionFactory);
        const filtered = filterAllowlisted(serverTools, serverCfg.allowedTools);
        for (const tool of filtered) {
          const allowlistEntry = serverCfg.allowedTools.find(e => e.name === tool.name);
          if (allowlistEntry !== undefined) {
            toolEntries.push({
              descriptor: tool,
              serverName: serverCfg.name,
              destructive: allowlistEntry.destructive,
            });
          }
        }
      } catch {
        // MCP timeout, connect failure, or list failure → skip server, degrade later (D-02)
      }
    }

    // No allowlisted tools found across any server → plain notify fallback (D-02)
    if (toolEntries.length === 0) return null;

    // 3. Build prompt with ALL collected allowlisted tool descriptors
    const descriptors = toolEntries.map(e => e.descriptor);
    const { systemPrompt, userPrompt } = buildProposalPrompt(item, searchResults, descriptors);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];

    // 4. Call DeepSeek (injectable fetchImpl for tests — key NEVER logged, H-13)
    const deepseekCfg = {
      apiKey: actionConfig.deepseekApiKey,
      baseUrl: actionConfig.deepseekBaseUrl,
      model: actionConfig.deepseekModel,
    };
    const rawJson = await callDeepSeek(messages, deepseekCfg, fetchImpl);

    // 5. Validate — D-02: only confident, fully-parameterized, allowlisted output passes
    const validated = validateProposal(rawJson, descriptors);
    if (validated.tool === null) return null;

    // 6. Find which server owns this tool (to get destructive + serverName)
    const toolEntry = toolEntries.find(e => e.descriptor.name === validated.tool);
    if (toolEntry === undefined) return null; // validateProposal already checks allowlist; defensive

    // 7. Build immutable StoredProposal (D-07 — payload never re-queried at execute time)
    const proposal: StoredProposal = {
      id: randomUUID(),
      serverName: toolEntry.serverName,
      tool: validated.tool,
      args: validated.args,
      dueAt: new Date(item.due_at).toISOString(),
      maxTtlMs: actionConfig.proposalMaxTtlMs,
      createdAt: new Date().toISOString(),
      destructive: toolEntry.destructive,
      expectedConfirmValue: deriveConfirmValue(validated.tool, validated.args),
    };

    return proposal;
  } catch {
    // Any uncaught error (network, parse, unexpected) → null → plain notify (D-02 / T-23-05-D)
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared execute helper for approve and typed-confirm paths (ACT-02 / ACT-03)
// ---------------------------------------------------------------------------

/**
 * Execute an approved proposal: re-check expiry + allowlist, run the immutable
 * stored payload via callServerTool, audit the outcome, remove the proposal.
 *
 * Used by BOTH the direct non-destructive approve path (Task 1) and the
 * typed-confirmation confirm path (Task 2). Sharing prevents the two paths
 * from diverging in security-critical checks.
 *
 * Does NOT call answerCallbackQuery — the callback drain always calls it.
 *
 * Security invariants:
 *   H-04: allowlist re-checked at execute time (D-04, not just propose time).
 *   H-05: expiry re-checked at execute time (D-07).
 *   H-06: immutable stored payload — args never re-queried (D-07).
 *   T-SEC-02: callTool result is data-only; never passed to any LLM.
 *   Pitfall #2: both transport throw and result.isError===true write failure episode.
 */
async function executeStoredProposal(
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  mcpConfigs: McpServerConfig[],
  storePath: string,
  proposalId: string,
  chatId: number,
  connectionFactory?: McpConnectionFactory,
): Promise<void> {
  // H-05: re-check expiry at execute time (not just at propose time)
  const loaded = loadExecutable(proposalId, storePath, Date.now());
  if (loaded.status !== 'ok') {
    const reason = loaded.status === 'expired' ? 'expired' : 'missing';
    try { await transport.sendMessage(chatId, `Proposal ${reason} — re-pull if still needed.`); }
    catch (e) { log('send error (proposal ' + reason + '): ' + String(e)); }
    try { await memoryClient.hitlEpisode({ decision: reason }); }
    catch (e) { log('hitlEpisode error (' + reason + '): ' + String(e)); }
    return;
  }

  const proposal = loaded.proposal;

  // H-04: re-check allowlist at execute time — post-propose config changes revoke access
  const serverCfg = mcpConfigs.find(s => s.name === proposal.serverName);
  const toolAllowed =
    serverCfg !== undefined &&
    serverCfg.allowedTools.some(e => e.name === proposal.tool);

  if (!toolAllowed) {
    try {
      await transport.sendMessage(
        chatId,
        `Tool '${proposal.tool}' is no longer in the allowlist — execution refused (H-04).`,
      );
    } catch (e) { log('send error (allowlist-revoked): ' + String(e)); }
    try {
      await memoryClient.hitlEpisode({
        decision: 'allowlist-revoked',
        tool: proposal.tool,
        serverName: proposal.serverName,
      });
    } catch (e) { log('hitlEpisode error (allowlist-revoked): ' + String(e)); }
    return;
  }

  // H-06: execute the immutable stored payload (D-07 — no re-query, no TOCTOU)
  // Pitfall #2: transport throw and result.isError===true are distinct error signals.
  let outputText = '';
  let isError = false;

  try {
    // callTool uses `arguments` key (NOT `args`) — RESEARCH Pitfall #1 / mcp-client.ts
    const result = await callServerTool(
      serverCfg,
      proposal.tool,
      proposal.args,
      connectionFactory ?? defaultConnectionFactory,
    );
    const extracted = extractToolOutput(result);
    outputText = extracted.text;
    isError = extracted.isError;
  } catch (err) {
    // Transport/protocol error (distinct from result.isError — Pitfall #2)
    outputText = String(err);
    isError = true;
  }

  // H-12: audit every execute outcome — success and failure both recorded
  try {
    await memoryClient.hitlEpisode({
      decision: 'execute',
      tool: proposal.tool,
      serverName: proposal.serverName,
      args: proposal.args,
      result: outputText,
      isError,
    });
  } catch (e) { log('hitlEpisode error (execute): ' + String(e)); }

  // Remove proposal after execution (at-most-once — success or failure)
  try { removeProposal(proposalId, storePath); }
  catch (e) { log('removeProposal error: ' + String(e)); }

  // Surface outcome to user (T-SEC-02: output is opaque data — never LLM-fed)
  const summary = isError
    ? `Action failed: ${outputText.slice(0, 200)}`
    : `Done: ${outputText.slice(0, 200) || '(no output)'}`;
  try { await transport.sendMessage(chatId, summary); }
  catch (e) { log('send error (execute summary): ' + String(e)); }
}

// ---------------------------------------------------------------------------
// Edit patch handler (D-06 / T-SEC-04) — implemented in Plan 07 Task 2
// ---------------------------------------------------------------------------

/**
 * Handle an incoming edit patch from a user with a pending-edit entry.
 * Implementation added in Plan 07 Task 2.
 */
async function handleEditPatch(
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  _mcpConfigs: McpServerConfig[],
  _storePath: string,
  _proposalId: string,
  chatId: number,
  _text: string,
  _connectionFactory?: McpConnectionFactory,
): Promise<void> {
  // Plan 07 Task 2: full D-06 implementation (parsePatch → validateEditedArgs → fresh proposal)
  try { await transport.sendMessage(chatId, 'Edit patch handler not yet implemented.'); }
  catch (e) { log('send error (edit-patch-stub): ' + String(e)); }
  try { await memoryClient.hitlEpisode({ decision: 'edit-rejected' }); }
  catch (e) { log('hitlEpisode error (edit-patch-stub): ' + String(e)); }
}

// ---------------------------------------------------------------------------
// v2 proposal callback handler (ACT-01 / ACT-02 / ACT-03)
// ---------------------------------------------------------------------------

/**
 * Handle a v2 proposal callback_query action: approve / reject / snooze / edit.
 * Edit is handled in Plan 07 (stub here).
 *
 * Does NOT call answerCallbackQuery — the outer callback drain calls it
 * unconditionally on every branch (Pitfall #1).
 *
 * Security invariants:
 *   H-04/H-05/H-06: non-destructive approve delegates to executeStoredProposal.
 *   D-09 / H-08: destructive approve registers a typed-confirm entry sourced from
 *     the STORED expectedConfirmValue — never re-derived from DeepSeek at confirm time.
 *   H-12: every decision writes a hitlEpisode.
 *
 * @param transport         Telegram transport for sendMessage.
 * @param memoryClient      MemoryClient for hitlEpisode audit writes.
 * @param mcpConfigs        MCP server configs for allowlist re-check (H-04).
 * @param storePath         Proposal store path (loadActionConfig().proposalStorePath).
 * @param chatId            Telegram chat ID for responses (=== fromId in private chats).
 * @param decoded           Parsed v2 callback data: { proposalId, action }.
 * @param connectionFactory Injectable MCP connection factory (default: real SDK).
 */
export async function handleProposalAction(
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  mcpConfigs: McpServerConfig[],
  storePath: string,
  chatId: number,
  decoded: { proposalId: string; action: ProposalAction },
  connectionFactory?: McpConnectionFactory,
): Promise<void> {
  const { proposalId, action } = decoded;

  if (action === 'reject') {
    try { removeProposal(proposalId, storePath); } catch { /* ignore store errors on reject */ }
    try { await memoryClient.hitlEpisode({ decision: 'reject' }); }
    catch (e) { log('hitlEpisode error (reject): ' + String(e)); }
    return;
  }

  if (action === 'snooze') {
    // Re-offer is out of scope here; just audit + ack (CONTEXT.md deferred section)
    try { await memoryClient.hitlEpisode({ decision: 'snooze' }); }
    catch (e) { log('hitlEpisode error (snooze): ' + String(e)); }
    return;
  }

  if (action === 'edit') {
    // D-06: check expiry before registering the edit state — no state on expired/missing
    const editLoaded = loadExecutable(proposalId, storePath, Date.now());
    if (editLoaded.status !== 'ok') {
      const editReason = editLoaded.status === 'expired' ? 'expired' : 'missing';
      try { await transport.sendMessage(chatId, `Proposal ${editReason} — re-pull if still needed.`); }
      catch (e) { log('send error (edit-' + editReason + '): ' + String(e)); }
      try { await memoryClient.hitlEpisode({ decision: editReason }); }
      catch (e) { log('hitlEpisode error (edit-' + editReason + '): ' + String(e)); }
      return;
    }
    // Register pending-edit (5-minute window — mirrors typed-confirm TTL, Risk 2)
    const EDIT_TTL_MS = 5 * 60_000;
    pendingEdit.set(String(chatId), { proposalId, expiresAt: Date.now() + EDIT_TTL_MS });
    try {
      await transport.sendMessage(
        chatId,
        'Reply with a JSON patch of the fields to change (e.g. {"key":"new-value"}).',
      );
    } catch (e) { log('send error (edit-prompt): ' + String(e)); }
    try {
      await memoryClient.hitlEpisode({
        decision: 'edit-requested',
        tool: editLoaded.proposal.tool,
        serverName: editLoaded.proposal.serverName,
      });
    } catch (e) { log('hitlEpisode error (edit-requested): ' + String(e)); }
    return;
  }

  // action === 'approve': load proposal to check destructive flag (D-08)
  const loaded = loadExecutable(proposalId, storePath, Date.now());
  if (loaded.status !== 'ok') {
    const reason = loaded.status === 'expired' ? 'expired' : 'missing';
    try { await transport.sendMessage(chatId, `Proposal ${reason} — re-pull if still needed.`); }
    catch (e) { log('send error (approve-' + reason + '): ' + String(e)); }
    try { await memoryClient.hitlEpisode({ decision: reason }); }
    catch (e) { log('hitlEpisode error (' + reason + '): ' + String(e)); }
    return;
  }

  const proposal = loaded.proposal;

  if (proposal.destructive) {
    // D-09 / H-08: destructive tool → typed confirmation required.
    // expectedConfirmValue is from the STORED payload — never re-derived at confirm time.
    const TYPED_CONFIRM_TTL_MS = 5 * 60_000; // 5-minute confirm window (RESEARCH Risk 2)
    pendingTypedConfirm.set(String(chatId), {
      proposalId,
      expectedValue: proposal.expectedConfirmValue,
      expiresAt: Date.now() + TYPED_CONFIRM_TTL_MS,
    });
    try {
      await transport.sendMessage(
        chatId,
        `Destructive action — reply with exactly: ${proposal.expectedConfirmValue} to confirm`,
      );
    } catch (e) { log('send error (typed-confirm prompt): ' + String(e)); }
    try {
      await memoryClient.hitlEpisode({
        decision: 'confirm-requested',
        tool: proposal.tool,
        serverName: proposal.serverName,
      });
    } catch (e) { log('hitlEpisode error (confirm-requested): ' + String(e)); }
    return;
  }

  // Non-destructive approve: execute directly via shared helper (H-04/H-05/H-06)
  await executeStoredProposal(
    transport, memoryClient, mcpConfigs, storePath,
    proposalId, chatId, connectionFactory,
  );
}

// ---------------------------------------------------------------------------
// Push tick (Phase 22 + Phase 23 proposal path)
// ---------------------------------------------------------------------------

/**
 * Proactive push tick: poll GET /v1/surface and push due items to Telegram.
 *
 * Never calls getUpdates (D-01 — the push timer is a SEPARATE timer from runClientTick).
 * Never throws (C-1) — errors are caught and logged; the setInterval callback is safe.
 *
 * P0 (tier=0): pushed immediately, bypassing quiet hours (D-05 — urgent deadline).
 *   Phase 23 addition (D-01): if MCP servers are configured and the daily proposal cap
 *   has not been reached, tries to generate a confident {tool,args} proposal via
 *   tryGenerateProposal. On success: stores + sends an approval card (ACT-01, T-23-05-A).
 *   On any failure or no-match: degrades to the Phase-22 plain notify (D-02, T-23-05-D).
 *   Both outcomes are audited via hitlEpisode (ACT-03 / H-12).
 * P1 (tier=1): held until the configured digestHour, outside quiet hours (D-06/D-07).
 *   P1 items remain Phase-22 plain notify ONLY — no auto-proposal (D-01).
 *   If digestHour has zero P1 items, sends nothing (never-empty-digest, D-06).
 *
 * Dedup is server-side (surfaced_event). No in-memory surfaced-set — a restarted client
 * polls GET /v1/surface and gets exactly the items not yet marked (D-03).
 *
 * Gate: if RECENSE_PROACTIVE_ENABLED is not "true" (D-11), this function returns
 * immediately without doing anything. Reactive Q&A is unaffected.
 *
 * @param testHooks  Optional injectable overrides (actionConfig, mcpConfigs,
 *                   connectionFactory, fetchImpl) for unit tests — never passed
 *                   from production main().
 */
export async function runPushTick(
  config: ClientConfig,
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  testHooks?: ProposalTestHooks,
): Promise<void> {
  // D-11: default-OFF gate. Belt-and-suspenders on top of the main() guard.
  if (!config.proactiveEnabled) return;

  if (pushInFlight) {
    log('push tick already in flight — skipping');
    return;
  }
  pushInFlight = true;

  try {
    const items = await memoryClient.surface();
    const localHour = new Date().getHours();
    const inQuiet = isInQuietHours(localHour, config.quietHoursStart, config.quietHoursEnd);
    const isDigest = localHour === config.digestHour;

    const p0 = items.filter(i => i.tier === 0);
    const p1 = items.filter(i => i.tier === 1);

    // ── Phase 23 — load proposal config once per tick (not per item) ──────────
    // testHooks override production values — allows unit tests to inject scripted
    // configs, store paths, connection factories, and fetch implementations.
    const mcpConfigs = testHooks?.mcpConfigs ?? loadMcpConfig();
    const actionCfg = testHooks?.actionConfig ?? loadActionConfig();
    // Proposal path is active when ≥1 MCP server is configured and DeepSeek key is set
    const hasProposalConfig = mcpConfigs.length > 0 && actionCfg.deepseekApiKey !== '';

    // D-05 / D-01 / D-02 / D-03: P0 always sends — bypasses quiet hours (urgent deadline).
    // Phase 23: if proposal config is present, try to generate a proposal before plain notify.
    for (const item of p0) {
      for (const chatIdStr of config.allowlist) {
        const chatId = Number(chatIdStr);
        let sentProposal = false;

        if (hasProposalConfig) {
          // H-15 / T-23-05-B: reserve a cap slot BEFORE calling DeepSeek — counts
          // proposals generated, not proposals sent, to prevent approval-fatigue DoS.
          const slotReserved = tryReserveProposalSlot(
            actionCfg.proposalDailyCap,
            actionCfg.proposalStorePath,
            new Date(),
          );

          if (slotReserved) {
            // Proposal flow: search → list tools → filter → prompt → DeepSeek → validate.
            // Bounded: any failure (MCP timeout, DeepSeek error, null tool) returns null.
            const proposal = await tryGenerateProposal(
              memoryClient,
              item,
              actionCfg,
              mcpConfigs,
              testHooks?.connectionFactory,
              testHooks?.fetchImpl,
            );

            if (proposal !== null) {
              // T-23-05-C: store first, then send — so the ID exists in the store before
              // the approval card reaches the user (no dangling button tap possible).
              putProposal(proposal, actionCfg.proposalStorePath);
              // D-02 send-then-mark order preserved: sendMessage → surfaceSeen.
              // D-03 / ACT-01: card is rendered from the serialized {tool,args} payload —
              // NEVER from DeepSeek prose (T-23-05-A enforced by renderProposalCard).
              await transport.sendMessage(chatId, renderProposalCard(proposal), proposalKeyboard(proposal.id));
              await memoryClient.surfaceSeen({
                node_id: item.node_id,
                occurrence_due_at: new Date(item.due_at).toISOString(),
                outcome: 'surfaced',
              });
              // ACT-03 / H-12: audit the propose decision — key never in content (H-13)
              try {
                await memoryClient.hitlEpisode({
                  decision: 'propose',
                  tool: proposal.tool,
                  args: proposal.args,
                  serverName: proposal.serverName,
                });
              } catch (auditErr) {
                // Episode loss is acceptable (H-12 comment) — log and continue
                log('hitlEpisode error (propose): ' + String(auditErr));
              }
              sentProposal = true;
            }

            if (!sentProposal) {
              // Slot was reserved but proposal generation returned null (D-02 fallback):
              // degrade to Phase-22 plain notify — the P0 is never silently dropped (T-23-05-D).
              await sendSurfacedItem(transport, memoryClient, config, chatId, item);
              // ACT-03: audit the fallback decision
              try {
                await memoryClient.hitlEpisode({ decision: 'notify-fallback' });
              } catch (auditErr) {
                log('hitlEpisode error (notify-fallback): ' + String(auditErr));
              }
            }
          } else {
            // Cap exhausted (H-15): skip proposal path, fall through to plain notify.
            await sendSurfacedItem(transport, memoryClient, config, chatId, item);
          }
        } else {
          // No proposal config (no MCP servers or missing DeepSeek key): Phase-22 plain notify.
          await sendSurfacedItem(transport, memoryClient, config, chatId, item);
        }
      }
    }

    // D-06/D-07: P1 only at digest hour, outside quiet hours, and only if ≥1 item.
    // P1 items remain Phase-22 plain notify ONLY — no auto-proposal for tier 1 (D-01).
    if (isDigest && !inQuiet && p1.length > 0) {
      for (const item of p1) {
        for (const chatIdStr of config.allowlist) {
          await sendSurfacedItem(transport, memoryClient, config, Number(chatIdStr), item);
        }
      }
    }
  } catch (err) {
    // C-1 never-throws — setInterval callback must not reject
    log('push tick error: ' + String(err));
  } finally {
    pushInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point for the Telegram reference client.
 *
 * Fail-closed (D-10): if config.enabled is false (token missing or allowlist empty),
 * logs the reason and returns WITHOUT starting the poll interval.
 * Process-not-running is NOT the gate — runtime flag is.
 *
 * When enabled: starts the reactive poll loop at config.pollIntervalMs (floor already
 * applied in loadClientConfig), logs startup, and holds the event loop indefinitely via
 * the live setInterval handle (launchd KeepAlive service lifecycle).
 *
 * When proactiveEnabled: additionally starts a SEPARATE push timer at config.pushPollMs
 * (D-01 split-timer design — push timer NEVER calls getUpdates). Guarded by the
 * default-OFF RECENSE_PROACTIVE_ENABLED flag (D-11).
 */
export async function main(): Promise<void> {
  const config = loadClientConfig();

  if (!config.enabled) {
    const reason =
      config.telegramToken === ''
        ? 'TELEGRAM_BOT_TOKEN missing'
        : config.serveToken === ''
          ? 'RECENSE_SERVE_TOKEN missing'
          : 'RECENSE_CLIENT_ALLOWLIST is empty';
    log('client disabled — ' + reason + ' (fail-closed, D-10); idling without polling');
    return;
  }

  const transport = new DefaultTelegramTransport(config.telegramToken);
  const memoryClient = createMemoryClient(config.serveUrl, config.serveToken);

  // Catch-all for stray rejections from setInterval callbacks (belt-and-suspenders)
  process.on('unhandledRejection', (err) => {
    appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] telegram-client FATAL unhandledRejection: ${String(err)}\n`,
    );
  });

  // Reactive Q&A loop — sole getUpdates consumer (D-01)
  setInterval(() => {
    runClientTick(config, transport, memoryClient).catch(err =>
      log('runClientTick rejected: ' + String(err)),
    );
  }, config.pollIntervalMs);

  log('telegram client started (pollIntervalMs=' + String(config.pollIntervalMs) + 'ms)');

  // D-01: SEPARATE push timer — never calls getUpdates; guarded by D-11 off-switch
  if (config.proactiveEnabled) {
    setInterval(() => {
      runPushTick(config, transport, memoryClient).catch(err =>
        log('runPushTick rejected: ' + String(err)),
      );
    }, config.pushPollMs);
    log('push timer started (pushPollMs=' + String(config.pushPollMs) + 'ms)');
  }

  // Hold the event loop indefinitely — the setInterval handle is the keep-alive.
  return new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// Entry guard — run only when invoked as the main module, not when imported
// by tests. Allows `require('./index')` without launching the poll loop.
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch(err => {
    appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] telegram-client FATAL: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
