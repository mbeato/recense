/**
 * DefaultIMessageChannel — iMessage transport impl (Phase 7, D-70/D-74).
 *
 * Composes ChatDbReader (chat.db polling) with OsascriptSender (AppleScript delivery)
 * into a Channel that enforces the D-74 fail-closed allowlist at the transport edge.
 *
 * Design decisions baked in:
 *  - D-74: empty allowlist → receive() returns [] (answers no one until configured).
 *  - D-74: unlisted senders are silently ignored — logged to file only, never replied to.
 *  - cursor:imessage in the meta store: each ROWID returned at most once (dedup).
 *  - Cursor advanced past ALL scanned ROWIDs (listed or not) so unlisted messages
 *    are not re-scanned on the next poll. (T-07-03)
 *
 * Threat mitigations:
 *  - T-07-01: fail-closed allowlist — empty → [] (D-74); exact normalized handle match.
 *  - T-07-05: silent ignore for unlisted — no reply, log to file only; surface never confirmed.
 *  - T-07-02: DefaultOsascriptSender uses execFile (no shell); recipient+text are run-handler
 *    argv params, never concatenated into the AppleScript body or any shell string.
 *  - T-07-03: cursor:imessage advanced past every scanned rowid, not just allowlisted ones.
 *  - T-07-04: log calls go to the injected log fn (file-only); message body never logged.
 *
 * Structure: OsascriptSender (seam interface) + DefaultOsascriptSender (execFile, argv-passed)
 *            + MockOsascriptSender (scripted, no osascript) + DefaultIMessageChannel (Channel impl).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Channel, InboundMessage } from './channel';
import type { ChatDbReader } from './chat-db-reader';
import type { EngineConfig } from '../lib/config';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// AppleScript run-handler (fixed constant — never mutated, never interpolated)
// ---------------------------------------------------------------------------

/**
 * Fixed AppleScript on-run handler. recipient and text arrive ONLY as run-handler
 * arguments {targetBuddy, msgText} — they are separate argv items passed by execFile.
 *
 * T-07-02 injection guard:
 *   - This string is a constant. User-supplied values (recipient, text) are NEVER
 *     concatenated here or into any shell string.
 *   - execFile is used (not exec) so there is no shell — the argv array items are
 *     passed directly to the osascript process, not expanded by a shell.
 */
const RUN_HANDLER = `on run {targetBuddy, msgText}
  tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy targetBuddy of targetService
    send msgText to targetBuddy
  end tell
end run`;

// ---------------------------------------------------------------------------
// OsascriptSender seam (D-70)
// ---------------------------------------------------------------------------

/**
 * Seam for AppleScript message delivery (D-70).
 *
 * Injected into DefaultIMessageChannel so unit tests can replace the real osascript
 * call with MockOsascriptSender — no macOS dependency, no side effects in tests.
 *
 * Implementations: DefaultOsascriptSender (execFile, no shell) + MockOsascriptSender (scripted).
 */
export interface OsascriptSender {
  /**
   * Send a text message to the given recipient via Messages.app.
   *
   * recipient — normalized E.164 phone or email handle.
   * text      — reply body; treated as argv data, never interpolated. (T-07-02)
   */
  send(recipient: string, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// DefaultOsascriptSender — production impl, execFile (no shell)
// ---------------------------------------------------------------------------

/**
 * Production OsascriptSender backed by child_process.execFile.
 *
 * T-07-02: execFile (not exec) means there is no shell. recipient and text are
 * passed as discrete argv elements — they become the run-handler's {targetBuddy, msgText}
 * parameters inside osascript and are never part of the script source string.
 *
 * Construction is side-effect-free: no osascript is invoked at new time.
 */
export class DefaultOsascriptSender implements OsascriptSender {
  async send(recipient: string, text: string): Promise<void> {
    // T-07-02: recipient and text are argv params, never in the script body.
    // RUN_HANDLER is a fixed constant; execFile has no shell (no $ or glob expansion).
    await execFileAsync('osascript', ['-e', RUN_HANDLER, recipient, text]);
  }
}

// ---------------------------------------------------------------------------
// MockOsascriptSender — scripted mock, no osascript; for unit tests
// ---------------------------------------------------------------------------

/**
 * Mock OsascriptSender for unit tests.
 *
 * Records all send() calls on a public `sent` array for assertion.
 * Never invokes osascript — no macOS dependency, no side effects.
 */
export class MockOsascriptSender implements OsascriptSender {
  /** All send() calls: [{ recipient, text }, ...] — inspect in tests. */
  readonly sent: Array<{ recipient: string; text: string }> = [];

  async send(recipient: string, text: string): Promise<void> {
    this.sent.push({ recipient, text });
  }
}

// ---------------------------------------------------------------------------
// normalizeHandle — canonical form for allowlist comparison
// ---------------------------------------------------------------------------

/**
 * Normalize a sender handle for exact allowlist comparison.
 *
 * Email handles (contains '@'): trim whitespace + lowercase.
 * Phone handles: trim, then keep only leading '+' and digit characters,
 *   stripping spaces, dashes, parentheses, and other non-numeric characters.
 *
 * Both sides of the comparison (config.channel.allowlist entries and
 * incoming row.handle values from chat.db) must normalize the same way.
 * The README.md setup guide documents the expected format for the allowlist.
 */
function normalizeHandle(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed.includes('@')) {
    // Email: lowercase only (case-insensitive comparison)
    return trimmed.toLowerCase();
  }
  // Phone: retain + prefix and digits; strip all other characters
  return trimmed.replace(/[^\d+]/g, '');
}

// ---------------------------------------------------------------------------
// MetaStore interface (structural, avoids circular import)
// ---------------------------------------------------------------------------

interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// DefaultIMessageChannel — Channel impl (D-70/D-74)
// ---------------------------------------------------------------------------

/**
 * iMessage Channel implementation (D-70).
 *
 * Composes ChatDbReader + OsascriptSender with the D-74 fail-closed allowlist.
 *
 * Construction is SIDE-EFFECT-FREE: no chat.db connection, no osascript invocation at
 * new time. The reader is injected already-constructed; all I/O is deferred to
 * receive()/send() calls. (mirrors GmailAdapter lazy-credential discipline, D-68 analog)
 */
export class DefaultIMessageChannel implements Channel {
  private readonly config: EngineConfig;
  private readonly reader: ChatDbReader;
  private readonly sender: OsascriptSender;
  private readonly meta: MetaStore;
  private readonly log: (msg: string) => void;

  /**
   * @param config  EngineConfig — reads config.channel.allowlist (D-74 gating).
   * @param reader  Injected ChatDbReader — inject MockChatDbReader in unit tests (D-70).
   * @param sender  Injected OsascriptSender — inject MockOsascriptSender in unit tests (T-07-02).
   * @param meta    Meta store for cursor persistence — reads/writes 'cursor:imessage'.
   * @param log     Log fn (file-only sink). Used for ignored-sender notices (T-07-04/T-07-05).
   */
  constructor(
    config: EngineConfig,
    reader: ChatDbReader,
    sender: OsascriptSender,
    meta: MetaStore,
    log: (msg: string) => void
  ) {
    this.config = config;
    this.reader = reader;
    this.sender = sender;
    this.meta = meta;
    this.log = log;
  }

  /**
   * Poll for new allowlisted inbound messages (D-70/D-74).
   *
   * D-74 fail-closed: if allowlist is empty, returns [] immediately — answers no one
   * until the self-hoster opts a handle in.
   *
   * Cursor advancement: ALL scanned ROWIDs (listed and unlisted) advance the cursor
   * so unlisted messages are not re-scanned on subsequent polls. (T-07-03)
   *
   * Returns an empty array when there are no new rows; never throws.
   */
  async receive(): Promise<InboundMessage[]> {
    // D-74: fail-closed — empty allowlist = answer no one
    if (this.config.channel.allowlist.length === 0) {
      return [];
    }

    // Read dedup cursor from meta store.
    const cursorRaw = this.meta.getMeta('cursor:imessage');

    // Cold start (first-ever boot — no cursor persisted): baseline at the current
    // high-water ROWID and answer NOTHING pre-existing. A reply-sending query channel
    // must never replay/answer the existing conversation history (that mass-texts the
    // owner on first run). A crash / KeepAlive restart keeps a non-null persisted
    // cursor, so it still answers messages received during downtime — only the very
    // first start skips backfill. (D-71)
    if (cursorRaw === null) {
      const baseline = this.reader.maxRowId();
      this.meta.setMeta('cursor:imessage', String(baseline));
      this.log('cold start: baselined cursor at rowid ' + String(baseline) + ' — skipping backfill');
      return [];
    }

    const cursor = parseInt(cursorRaw, 10);

    // Poll new rows from ChatDbReader (synchronous, better-sqlite3)
    const rows = this.reader.pollNew(cursor);

    if (rows.length === 0) {
      return [];
    }

    // Advance cursor:imessage past ALL rows seen (including unlisted) — T-07-03
    // This ensures unlisted-sender rows are not re-delivered to pollNew on the next tick.
    const maxRowid = rows.reduce((max, r) => Math.max(max, r.rowid), 0);
    this.meta.setMeta('cursor:imessage', String(maxRowid));

    // Pre-normalize allowlist entries once per poll call
    const normalizedAllowlist = this.config.channel.allowlist.map(normalizeHandle);

    // Filter: only allowlisted senders reach the responder
    const result: InboundMessage[] = [];
    for (const row of rows) {
      const normHandle = normalizeHandle(row.handle);
      if (normalizedAllowlist.includes(normHandle)) {
        result.push({
          id: String(row.rowid),
          sender: row.handle,
          text: row.text,
          ts: row.dateMs,
        });
      } else {
        // D-74/T-07-05: silent ignore — log to file only; never reply, never confirm surface
        this.log('ignored unlisted sender');
      }
    }

    return result;
  }

  /**
   * Send a reply to the given recipient via the injected OsascriptSender.
   *
   * T-07-02: injection safety is enforced by DefaultOsascriptSender (execFile, argv-passed).
   * This method is a thin delegate — no string manipulation of recipient or text.
   */
  async send(recipient: string, text: string): Promise<void> {
    await this.sender.send(recipient, text);
  }
}
