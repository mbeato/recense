/**
 * ChatDbReader — read-only chat.db reader (Phase 7, D-70/D-71).
 *
 * Provides a cursor-based, incremental read of new inbound messages from the
 * macOS Messages database (~/Library/Messages/chat.db), excluding own-sent rows.
 *
 * Threat mitigations:
 *  - T-07-08: Database opened with { readonly: true } — no write statement ever
 *    executes against the Messages database (correctness guard).
 *  - T-07-03: SQL WHERE is_from_me = 0 filters own-sent rows at the DB layer —
 *    reply-loop prevention independent of cursor position.
 *  - T-07-02: cursor and all query parameters use bound ? params — no string
 *    interpolation of handles, phone numbers, or cursor values (T-02-SQL).
 *  - T-07-SC: attributedBody decode is zero-dependency byte-scan; if a dep is
 *    genuinely required, raise a blocking-human legitimacy checkpoint (no auto-install).
 *
 * Structure: ChatDbReader interface + DefaultChatDbReader (readonly, prepared-once) +
 * MockChatDbReader (scripted rows, no filesystem, for unit tests).
 */
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Apple-epoch constant
// ---------------------------------------------------------------------------

/**
 * 2001→1970 epoch offset in milliseconds.
 * Apple timestamps use 2001-01-01 00:00:00 UTC as the reference epoch;
 * Unix timestamps use 1970-01-01 00:00:00 UTC.
 * Difference = 31 years * seconds/year * 1000 ms/s = 978_307_200_000 ms.
 */
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

// ---------------------------------------------------------------------------
// Apple-epoch conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Apple-epoch timestamp to Unix milliseconds.
 *
 * Modern macOS stores message.date as nanoseconds since 2001-01-01.
 * Older OS versions stored it as seconds (legacy format guard: value < 1e12).
 *
 * ns path:  unixMs = appleDate / 1_000_000 + APPLE_EPOCH_OFFSET_MS
 * sec path: unixMs = appleDate * 1_000     + APPLE_EPOCH_OFFSET_MS
 */
function appleEpochToUnixMs(appleDate: number): number {
  if (appleDate < 1e12) {
    // Legacy seconds format (pre-Catalina era messages)
    return appleDate * 1_000 + APPLE_EPOCH_OFFSET_MS;
  }
  // Modern nanoseconds format (post-2019 macOS/iOS)
  return appleDate / 1_000_000 + APPLE_EPOCH_OFFSET_MS;
}

// ---------------------------------------------------------------------------
// attributedBody decode (zero-dependency byte-scan heuristic)
// ---------------------------------------------------------------------------

/**
 * Decode an attributedBody BLOB to plain text.
 *
 * attributedBody is an archived NSAttributedString (typedstream / NSKeyedArchiver).
 * This zero-dependency heuristic:
 *  1. Locates the 'NSString' class-name marker (ASCII) in the buffer.
 *  2. Scans forward byte-by-byte from after the marker, treating each byte as a
 *     candidate 1-byte length prefix. Lengths in range [1, 0x7F] (128 bytes) are
 *     tried; the first length whose following bytes round-trip as valid UTF-8 with
 *     at least one non-whitespace character is returned.
 *  3. Falls back to '' if the scan finds nothing plausible.
 *
 * Known failure mode: a false-positive length byte before the real string may cause
 * the heuristic to return the wrong string or ''. Callers must handle '' gracefully.
 * This covers the common case; exotic message types (rich links, files) may return ''.
 *
 * DO NOT add an npm dependency to replace this (T-07-SC). If this heuristic is
 * insufficient, surface it as a tracked gap — never auto-install a package.
 */
function decodeAttributedBody(blob: Buffer): string {
  // Locate 'NSString' class-name marker (also covers NSMutableString since it starts with NSString)
  const NSSTRING = Buffer.from('NSString');
  const markerIdx = blob.indexOf(NSSTRING);
  if (markerIdx === -1) return '';

  // Advance past marker + null terminator (class name in typedstream is null-terminated)
  const scanStart = markerIdx + NSSTRING.length + 1;

  // Scan for a 1-byte length followed by that many valid UTF-8 bytes
  for (let i = scanStart; i < blob.length - 1; i++) {
    const len = blob[i]!;
    // Accept lengths 1–127; longer strings rare in SMS and more likely a false positive
    if (len < 1 || len > 0x7F) continue;
    if (i + 1 + len > blob.length) continue;
    try {
      const candidate = blob.subarray(i + 1, i + 1 + len).toString('utf8');
      // Validate: non-empty and contains at least one non-whitespace character
      if (candidate.length > 0 && /\S/.test(candidate)) {
        return candidate;
      }
    } catch {
      // malformed UTF-8 sequence — continue scanning
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Row shape returned by pollNew
// ---------------------------------------------------------------------------

export interface ChatDbRow {
  rowid: number;
  /** Normalized E.164 phone number or email from handle.id in chat.db. */
  handle: string;
  /** Decoded message text (attributedBody fallback applied when message.text is NULL). */
  text: string;
  /** Message timestamp converted to Unix milliseconds (Apple-epoch ns or s → Unix ms). */
  dateMs: number;
  /** Always false given the WHERE is_from_me = 0 filter; mapped honestly for type clarity. */
  isFromMe: boolean;
}

// ---------------------------------------------------------------------------
// ChatDbReader interface
// ---------------------------------------------------------------------------

/**
 * Read-only interface for incremental chat.db polling (D-70).
 *
 * cursor: Apple-epoch ROWID of the last processed message.
 *   Pass 0 to backfill all recent messages.
 *   Implementations advance the cursor externally (not stored by this interface).
 */
export interface ChatDbReader {
  /**
   * Return new inbound messages since lastRowId, excluding own-sent rows (is_from_me=0 only).
   * Returns rows in ascending ROWID order (oldest first).
   * Synchronous — better-sqlite3 statements are synchronous by design.
   */
  pollNew(cursor: number): ChatDbRow[];

  /**
   * Return the current maximum ROWID across ALL messages (sent and received), or 0 if
   * the table is empty. Used to baseline the cursor on first-ever watcher boot so a
   * reply-sending query channel never backfills/answers pre-existing history (D-71).
   * Synchronous.
   */
  maxRowId(): number;
}

// ---------------------------------------------------------------------------
// DefaultChatDbReader — production impl, read-only chat.db
// ---------------------------------------------------------------------------

/**
 * Production ChatDbReader backed by the real ~/Library/Messages/chat.db.
 *
 * Construction discipline (T-07-KEY mirror):
 *   Opens the DB and compiles the SELECT once in the constructor — never per-call.
 *   The db handle is opened { readonly: true } (T-07-08 correctness guard).
 *   No credentials at construction; no env reads here.
 */
export class DefaultChatDbReader implements ChatDbReader {
  private readonly db: Database.Database;

  // Prepared statement compiled once in constructor — never inside pollNew (T-02-SQL)
  private readonly stmt: Database.Statement;

  // High-water-mark statement compiled once — used by maxRowId() for cold-start baseline.
  private readonly maxStmt: Database.Statement;

  constructor(chatDbPath: string) {
    // T-07-08: open read-only — this reader NEVER writes to the Messages database
    this.db = new Database(chatDbPath, { readonly: true });

    // ── Prepared statement (all params bound via ? — T-02-SQL) ──────────────
    // JOIN message → handle to resolve the sender's phone/email handle.
    // WHERE is_from_me = 0: reply-loop guard (T-07-03) — own-sent rows excluded at SQL layer.
    // WHERE ROWID > ?: cursor filter ensures each row delivered exactly once.
    // ORDER BY ROWID ASC: oldest-first delivery order.
    this.stmt = this.db.prepare(`
      SELECT
        m.ROWID   AS rowid,
        h.id      AS handle,
        m.text    AS text,
        m.attributedBody AS attributedBody,
        m.date    AS date,
        m.is_from_me AS is_from_me
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.ROWID > ? AND m.is_from_me = 0
      ORDER BY m.ROWID ASC
    `);

    // High-water mark across ALL rows (sent + received) — the cold-start baseline.
    // Including is_from_me=1 guarantees every existing row is behind the baseline.
    this.maxStmt = this.db.prepare('SELECT MAX(ROWID) AS maxId FROM message');
  }

  maxRowId(): number {
    const row = this.maxStmt.get() as { maxId: number | null };
    return row.maxId ?? 0; // MAX over an empty table is NULL → 0
  }

  pollNew(cursor: number): ChatDbRow[] {
    const raw = this.stmt.all(cursor) as Array<{
      rowid: number;
      handle: string;
      text: string | null;
      attributedBody: Buffer | null;
      date: number;
      is_from_me: number;
    }>;

    return raw.map(row => {
      // Text: prefer message.text; fall back to attributedBody BLOB decode (modern macOS
      // often leaves message.text NULL for some message types — D-70 reader internals).
      let text = '';
      if (row.text != null) {
        text = row.text;
      } else if (row.attributedBody != null) {
        text = decodeAttributedBody(row.attributedBody);
      }

      return {
        rowid: row.rowid,
        handle: row.handle,
        text,
        dateMs: appleEpochToUnixMs(row.date),
        isFromMe: row.is_from_me === 1, // always false given WHERE is_from_me=0, mapped honestly
      };
    });
  }
}

// ---------------------------------------------------------------------------
// MockChatDbReader — scripted rows, no filesystem; for unit tests
// ---------------------------------------------------------------------------

/**
 * Scripted mock for unit tests. Mirrors the MockChannel pattern.
 *
 * Constructor accepts an array of pre-built ChatDbRow objects.
 * pollNew(cursor) filters and returns rows where rowid > cursor, in ascending ROWID order.
 * No filesystem, no sqlite, no credentials at construction.
 */
export class MockChatDbReader implements ChatDbReader {
  private readonly rows: ChatDbRow[];

  constructor(rows: ChatDbRow[] = []) {
    // Defensive copy; sort ascending by rowid for deterministic ordering
    this.rows = [...rows].sort((a, b) => a.rowid - b.rowid);
  }

  pollNew(cursor: number): ChatDbRow[] {
    return this.rows.filter(r => r.rowid > cursor);
  }

  maxRowId(): number {
    return this.rows.reduce((max, r) => Math.max(max, r.rowid), 0);
  }
}
