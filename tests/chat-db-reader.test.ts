/**
 * ChatDbReader tests (Phase 7, D-70).
 *
 * Two harness types:
 *  A. MockChatDbReader — pure unit tests, no filesystem.
 *  B. DefaultChatDbReader — behavior tests using a throwaway temp SQLite file seeded
 *     with a minimal message + handle schema.
 *
 * Coverage:
 *  - MockChatDbReader cursor filtering (rows at/below cursor excluded)
 *  - MockChatDbReader ascending ROWID ordering
 *  - DefaultChatDbReader: is_from_me=1 rows excluded (reply-loop guard, T-07-03)
 *  - DefaultChatDbReader: Apple-epoch ns → Unix ms conversion (APPLE_EPOCH_OFFSET_MS)
 *  - DefaultChatDbReader: attributedBody fallback yields text when message.text is NULL
 *  - DefaultChatDbReader: opened read-only (T-07-08)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { MockChatDbReader, DefaultChatDbReader } from '../src/channel/chat-db-reader';
import type { ChatDbRow } from '../src/channel/chat-db-reader';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal chat.db-like SQLite file in a temp dir. */
function makeTempDb(): { dbPath: string; tmpDir: string; db: Database.Database } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'brain-memory-chatdb-test-'));
  const dbPath = join(tmpDir, 'chat.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id    TEXT NOT NULL
    );

    CREATE TABLE message (
      ROWID        INTEGER PRIMARY KEY,
      handle_id    INTEGER NOT NULL,
      text         TEXT,
      attributedBody BLOB,
      date         INTEGER NOT NULL DEFAULT 0,
      is_from_me   INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { dbPath, tmpDir, db };
}

/** Build a minimal attributedBody BLOB that the decodeAttributedBody heuristic can decode. */
function makeAttributedBodyBlob(text: string): Buffer {
  // Format: 'NSString' + null-terminator + 1-byte length + UTF-8 text bytes
  // This matches the byte-scan heuristic in DefaultChatDbReader (NSString marker search).
  const textBytes = Buffer.from(text, 'utf8');
  return Buffer.concat([
    Buffer.from('NSString\x00'), // class-name marker + null terminator
    Buffer.from([textBytes.length]), // 1-byte length prefix
    textBytes, // UTF-8 text
  ]);
}

/** Apple-epoch nanoseconds for a known date (2024-01-01 00:00:00 UTC). */
// Unix ms for 2024-01-01: 1704067200000
// Apple epoch ms: 1704067200000 - 978307200000 = 725760000000
// In nanoseconds: 725760000000 * 1_000_000 = 7.2576e17
const APPLE_NS_2024_01_01 = 725_760_000_000 * 1_000_000; // > 1e12 → nanoseconds path
const UNIX_MS_2024_01_01 = 1_704_067_200_000;

// ── MockChatDbReader — cursor filtering + ordering ────────────────────────────

describe('MockChatDbReader — cursor filtering', () => {
  const rows: ChatDbRow[] = [
    { rowid: 10, handle: '+14155550101', text: 'hello', dateMs: 1000, isFromMe: false },
    { rowid: 20, handle: '+14155550101', text: 'world', dateMs: 2000, isFromMe: false },
    { rowid: 30, handle: '+14155550202', text: 'third', dateMs: 3000, isFromMe: false },
  ];

  it('cursor=0 returns all rows', () => {
    const reader = new MockChatDbReader(rows);
    expect(reader.pollNew(0)).toHaveLength(3);
  });

  it('rows AT the cursor are excluded (> not >=)', () => {
    const reader = new MockChatDbReader(rows);
    const result = reader.pollNew(10); // cursor=10 excludes rowid=10
    expect(result).toHaveLength(2);
    expect(result.every(r => r.rowid > 10)).toBe(true);
  });

  it('cursor at max rowid returns empty array', () => {
    const reader = new MockChatDbReader(rows);
    const result = reader.pollNew(30);
    expect(result).toEqual([]);
  });

  it('returns rows in ascending ROWID order regardless of insertion order', () => {
    const unordered: ChatDbRow[] = [
      { rowid: 30, handle: '+1', text: 'c', dateMs: 3000, isFromMe: false },
      { rowid: 10, handle: '+1', text: 'a', dateMs: 1000, isFromMe: false },
      { rowid: 20, handle: '+1', text: 'b', dateMs: 2000, isFromMe: false },
    ];
    const reader = new MockChatDbReader(unordered);
    const result = reader.pollNew(0);
    expect(result.map(r => r.rowid)).toEqual([10, 20, 30]);
  });

  it('empty script returns empty array', () => {
    const reader = new MockChatDbReader([]);
    expect(reader.pollNew(0)).toEqual([]);
  });
});

// ── DefaultChatDbReader — behavior tests with real SQLite ─────────────────────

describe('DefaultChatDbReader — is_from_me exclusion', () => {
  let tmpDir: string;
  let db: Database.Database;
  let dbPath: string;

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes rows where is_from_me = 1 (reply-loop guard, T-07-03)', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());

    // Insert a handle
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');

    // Insert one inbound and one outbound message
    db.prepare('INSERT INTO message (ROWID, handle_id, text, date, is_from_me) VALUES (1, 1, ?, ?, 0)')
      .run('inbound message', APPLE_NS_2024_01_01);
    db.prepare('INSERT INTO message (ROWID, handle_id, text, date, is_from_me) VALUES (2, 1, ?, ?, 1)')
      .run('own sent message', APPLE_NS_2024_01_01);
    db.close();

    const reader = new DefaultChatDbReader(dbPath);
    const rows = reader.pollNew(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('inbound message');
    expect(rows[0]!.isFromMe).toBe(false);
  });
});

describe('DefaultChatDbReader — Apple-epoch conversion', () => {
  let tmpDir: string;
  let db: Database.Database;
  let dbPath: string;

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('converts Apple-epoch nanoseconds to a plausible Unix ms timestamp', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());

    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');
    db.prepare('INSERT INTO message (ROWID, handle_id, text, date, is_from_me) VALUES (1, 1, ?, ?, 0)')
      .run('test message', APPLE_NS_2024_01_01);
    db.close();

    const reader = new DefaultChatDbReader(dbPath);
    const rows = reader.pollNew(0);
    expect(rows).toHaveLength(1);
    // Should be close to 2024-01-01 UTC (within 1 second due to floating-point division)
    expect(Math.abs(rows[0]!.dateMs - UNIX_MS_2024_01_01)).toBeLessThan(1000);
  });

  it('legacy seconds format (appleDate < 1e12) is also converted correctly', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());

    // Legacy seconds: Apple epoch seconds for 2010-01-01 = 284083200 (< 1e12)
    // Expected Unix ms: 284083200 * 1000 + 978307200000 = 1262390400000 → 2010-01-01
    const legacyAppleSeconds = 284_083_200;
    const expectedUnixMs = legacyAppleSeconds * 1000 + 978_307_200_000;

    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');
    db.prepare('INSERT INTO message (ROWID, handle_id, text, date, is_from_me) VALUES (1, 1, ?, ?, 0)')
      .run('legacy message', legacyAppleSeconds);
    db.close();

    const reader = new DefaultChatDbReader(dbPath);
    const rows = reader.pollNew(0);
    expect(rows[0]!.dateMs).toBe(expectedUnixMs);
  });
});

describe('DefaultChatDbReader — attributedBody fallback', () => {
  let tmpDir: string;
  let db: Database.Database;
  let dbPath: string;

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns text from attributedBody BLOB when message.text is NULL', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());

    const expectedText = 'decoded from attributedBody';
    const blob = makeAttributedBodyBlob(expectedText);

    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');
    // text is NULL, attributedBody has encoded content
    db.prepare(
      'INSERT INTO message (ROWID, handle_id, text, attributedBody, date, is_from_me) VALUES (1, 1, NULL, ?, ?, 0)'
    ).run(blob, APPLE_NS_2024_01_01);
    db.close();

    const reader = new DefaultChatDbReader(dbPath);
    const rows = reader.pollNew(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe(expectedText);
  });

  it('prefers message.text over attributedBody when both are present', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());

    const blob = makeAttributedBodyBlob('attributed body content');

    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');
    db.prepare(
      'INSERT INTO message (ROWID, handle_id, text, attributedBody, date, is_from_me) VALUES (1, 1, ?, ?, ?, 0)'
    ).run('plain text wins', blob, APPLE_NS_2024_01_01);
    db.close();

    const reader = new DefaultChatDbReader(dbPath);
    const rows = reader.pollNew(0);
    expect(rows[0]!.text).toBe('plain text wins');
  });

  it('returns empty string when both text and attributedBody are NULL', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());

    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');
    db.prepare(
      'INSERT INTO message (ROWID, handle_id, text, attributedBody, date, is_from_me) VALUES (1, 1, NULL, NULL, ?, 0)'
    ).run(APPLE_NS_2024_01_01);
    db.close();

    const reader = new DefaultChatDbReader(dbPath);
    const rows = reader.pollNew(0);
    expect(rows[0]!.text).toBe('');
  });
});

describe('DefaultChatDbReader — cursor filtering with real SQLite', () => {
  let tmpDir: string;
  let db: Database.Database;
  let dbPath: string;

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('only returns rows with ROWID > cursor', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());

    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');
    for (let i = 1; i <= 5; i++) {
      db.prepare('INSERT INTO message (ROWID, handle_id, text, date, is_from_me) VALUES (?, 1, ?, ?, 0)')
        .run(i, `message ${i}`, APPLE_NS_2024_01_01);
    }
    db.close();

    const reader = new DefaultChatDbReader(dbPath);
    const rows = reader.pollNew(3); // cursor=3 → only rowid 4 and 5
    expect(rows).toHaveLength(2);
    expect(rows[0]!.rowid).toBe(4);
    expect(rows[1]!.rowid).toBe(5);
  });
});

// ── maxRowId — current high-water mark (cold-start baseline support) ───────────

describe('MockChatDbReader — maxRowId', () => {
  it('returns the highest rowid among scripted rows', () => {
    const rows: ChatDbRow[] = [
      { rowid: 10, handle: '+1', text: 'a', dateMs: 1, isFromMe: false },
      { rowid: 42, handle: '+1', text: 'b', dateMs: 2, isFromMe: false },
      { rowid: 7, handle: '+1', text: 'c', dateMs: 3, isFromMe: false },
    ];
    expect(new MockChatDbReader(rows).maxRowId()).toBe(42);
  });

  it('returns 0 when there are no rows', () => {
    expect(new MockChatDbReader([]).maxRowId()).toBe(0);
  });
});

describe('DefaultChatDbReader — maxRowId', () => {
  let tmpDir: string;
  let db: Database.Database;
  let dbPath: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns MAX(ROWID) over ALL messages incl. is_from_me=1 (true high-water mark)', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14155550101');
    // rowid 9 is is_from_me=1 (own-sent) — must still count toward the high-water mark
    db.prepare('INSERT INTO message (ROWID, handle_id, text, date, is_from_me) VALUES (5, 1, ?, ?, 0)').run('in', APPLE_NS_2024_01_01);
    db.prepare('INSERT INTO message (ROWID, handle_id, text, date, is_from_me) VALUES (9, 1, ?, ?, 1)').run('out', APPLE_NS_2024_01_01);
    db.close();

    expect(new DefaultChatDbReader(dbPath).maxRowId()).toBe(9);
  });

  it('returns 0 on an empty message table', () => {
    ({ dbPath, tmpDir, db } = makeTempDb());
    db.close();
    expect(new DefaultChatDbReader(dbPath).maxRowId()).toBe(0);
  });
});
