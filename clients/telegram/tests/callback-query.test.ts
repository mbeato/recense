/**
 * clients/telegram/tests/callback-query.test.ts
 *
 * Tests for callback_query draining inside runClientTick:
 *   button tap → allowlist check → decodeCallbackData → surfaceSeen → answerCallbackQuery
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
 *
 * Scenarios:
 *   - callback_query from allowlisted sender → surfaceSeen POST called (correct body),
 *       answerCallbackQuery called
 *   - answerCallbackQuery called even when surfaceSeen returns 404
 *   - surfaceSeen 404 → cursor still advances (NOT D-04 blocked)
 *   - unlisted sender → surfaceSeen NOT called, answerCallbackQuery still called
 *   - malformed callback_data (decode → null) → surfaceSeen NOT called, answerCallbackQuery called
 *   - snoozed outcome → snooze_until present in POST body (ISO-8601, ≈ now + snoozeDurationMs)
 *   - cursor advance covers callback_query update_id (monotonic, alongside message updates)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runClientTick } from '../index';
import { MockTelegramTransport } from '../transport';
import type { TelegramUpdate } from '../transport';
import { writeStateCursor, readStateCursor } from '../state';
import { createMemoryClient } from '../memory-client';
import { encodeCallbackData } from '../push-codec';
import type { ClientConfig } from '../config';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_ID = '111';
let _counter = 0;

function uniqueStatePath(): string {
  return path.join(os.tmpdir(), `brain-cq-test-${Date.now()}-${++_counter}.json`);
}

function rmFile(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function makeConfig(opts: {
  allowlist?: string[];
  statePath: string;
  serveUrl?: string;
  snoozeDurationMs?: number;
}): ClientConfig {
  const allowlist = opts.allowlist ?? [ALLOWED_ID];
  return {
    telegramToken: 'test-token',
    serveUrl: opts.serveUrl ?? 'http://127.0.0.1:9999',
    serveToken: 'test-serve-token',
    allowlist,
    pollIntervalMs: 500,
    statePath: opts.statePath,
    enabled: allowlist.length > 0,
    proactiveEnabled: false,
    pushPollMs: 120_000,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    digestHour: 8,
    snoozeDurationMs: opts.snoozeDurationMs ?? 86_400_000,
  };
}

/** Build a valid callback_data string for the test node. */
function makeCallbackData(outcome: 'c' | 'd' | 's' = 'c'): string {
  const nodeId = '550e8400-e29b-41d4-a716-446655440099';
  const dueAt = '2026-07-01T10:00:00.000Z';
  return encodeCallbackData(nodeId, dueAt, outcome);
}

function makeCqUpdate(opts: {
  updateId?: number;
  fromId?: number;
  callbackData?: string;
  cqId?: string;
}): TelegramUpdate {
  return {
    update_id: opts.updateId ?? 20,
    callback_query: {
      id: opts.cqId ?? 'cq-001',
      from: { id: opts.fromId ?? Number(ALLOWED_ID) },
      data: opts.callbackData ?? makeCallbackData('c'),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('callback_query draining in runClientTick', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let seenRequests: Array<{ node_id: string; outcome: string; occurrence_due_at: string; snooze_until?: string }>;
  let seenStatusCode: number;
  let askStatusCode: number;

  beforeEach(async () => {
    seenRequests = [];
    seenStatusCode = 200;
    askStatusCode = 200;
    mockPort = await getFreePort();
    mockServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/surface/seen') {
        let body = '';
        req.on('data', d => { body += String(d); });
        req.on('end', () => {
          const parsed = JSON.parse(body) as typeof seenRequests[number];
          seenRequests.push(parsed);
          res.writeHead(seenStatusCode, { 'content-type': 'application/json' });
          res.end(seenStatusCode >= 400 ? '{"error":"scripted error"}' : '{"ok":true}');
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/ask') {
        res.writeHead(askStatusCode, { 'content-type': 'application/json' });
        res.end('{"answer":null,"origin":"none"}');
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => mockServer.listen(mockPort, '127.0.0.1', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => mockServer.close(() => r()));
  });

  // ── Happy path ──

  it('callback_query from allowlisted sender → surfaceSeen POST called with correct body', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const cbData = makeCallbackData('c');
    const t = new MockTelegramTransport([makeCqUpdate({ callbackData: cbData })]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]!.node_id).toBe('550e8400-e29b-41d4-a716-446655440099');
      expect(seenRequests[0]!.outcome).toBe('completed');
      expect(seenRequests[0]!.occurrence_due_at).toBe('2026-07-01T10:00:00.000Z');
    } finally {
      rmFile(sp);
    }
  });

  it('callback_query from allowlisted sender → answerCallbackQuery called', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const t = new MockTelegramTransport([makeCqUpdate({ cqId: 'cq-test-001' })]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(t.answeredCallbacks).toHaveLength(1);
      expect(t.answeredCallbacks[0]).toBe('cq-test-001');
    } finally {
      rmFile(sp);
    }
  });

  // ── answerCallbackQuery always called ──

  it('surfaceSeen 404 → answerCallbackQuery still called (spinner always cleared)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    seenStatusCode = 404;
    const t = new MockTelegramTransport([makeCqUpdate({ cqId: 'cq-404-test' })]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      // answerCallbackQuery MUST be called even on surfaceSeen error
      expect(t.answeredCallbacks).toHaveLength(1);
      expect(t.answeredCallbacks[0]).toBe('cq-404-test');
    } finally {
      rmFile(sp);
    }
  });

  // ── D-04 inapplicable to callback_query: cursor advances despite surfaceSeen error ──

  it('surfaceSeen 404 → cursor still advances (NOT D-04 blocked)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    seenStatusCode = 404;
    const t = new MockTelegramTransport([makeCqUpdate({ updateId: 30 })]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      // Cursor must advance past the callback_query update_id (30)
      const cursor = readStateCursor(sp);
      expect(cursor).not.toBeNull();
      expect(Number(cursor)).toBeGreaterThanOrEqual(30);
    } finally {
      rmFile(sp);
    }
  });

  // ── Unlisted sender ──

  it('unlisted sender → surfaceSeen NOT called, answerCallbackQuery still called', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const t = new MockTelegramTransport([
      makeCqUpdate({ fromId: 999, cqId: 'cq-unlisted' }), // 999 is not in allowlist
    ]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(seenRequests).toHaveLength(0);          // surfaceSeen NOT called
      expect(t.answeredCallbacks).toHaveLength(1);   // spinner still cleared
      expect(t.answeredCallbacks[0]).toBe('cq-unlisted');
    } finally {
      rmFile(sp);
    }
  });

  // ── Malformed callback_data ──

  it('malformed callback_data → surfaceSeen NOT called, answerCallbackQuery called', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const t = new MockTelegramTransport([
      makeCqUpdate({ callbackData: 'not-valid-data', cqId: 'cq-malformed' }),
    ]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(seenRequests).toHaveLength(0);
      expect(t.answeredCallbacks).toHaveLength(1);
      expect(t.answeredCallbacks[0]).toBe('cq-malformed');
    } finally {
      rmFile(sp);
    }
  });

  it('absent callback_data (undefined) → surfaceSeen NOT called, answerCallbackQuery called', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const update: TelegramUpdate = {
      update_id: 21,
      callback_query: { id: 'cq-no-data', from: { id: Number(ALLOWED_ID) } }, // no data field
    };
    const t = new MockTelegramTransport([update]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(seenRequests).toHaveLength(0);
      expect(t.answeredCallbacks).toHaveLength(1);
      expect(t.answeredCallbacks[0]).toBe('cq-no-data');
    } finally {
      rmFile(sp);
    }
  });

  // ── Snoozed outcome ──

  it('snoozed outcome → snooze_until present in POST body (≈ now + snoozeDurationMs)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const before = Date.now();
    const snoozeMs = 3_600_000; // 1 hour for test clarity
    const cbData = makeCallbackData('s');
    const t = new MockTelegramTransport([makeCqUpdate({ callbackData: cbData })]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}`, snoozeDurationMs: snoozeMs });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]!.outcome).toBe('snoozed');
      const snoozeUntil = seenRequests[0]!.snooze_until;
      expect(snoozeUntil).toBeDefined();
      const snoozeTs = new Date(snoozeUntil!).getTime();
      const after = Date.now();
      // snooze_until ≈ request_time + snoozeDurationMs (within 5s tolerance)
      expect(snoozeTs).toBeGreaterThanOrEqual(before + snoozeMs - 5_000);
      expect(snoozeTs).toBeLessThanOrEqual(after + snoozeMs + 5_000);
    } finally {
      rmFile(sp);
    }
  });

  it('non-snoozed outcome (completed) → snooze_until absent from POST body', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const cbData = makeCallbackData('c');
    const t = new MockTelegramTransport([makeCqUpdate({ callbackData: cbData })]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]!.outcome).toBe('completed');
      expect(seenRequests[0]!.snooze_until).toBeUndefined();
    } finally {
      rmFile(sp);
    }
  });

  // ── Cursor advance covers callback_query update_id ──

  it('callback_query update_id is covered by cursor commit (monotonic with message updates)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '5');
    // callback_query with update_id=25
    const t = new MockTelegramTransport([makeCqUpdate({ updateId: 25 })]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(readStateCursor(sp)).toBe('25');
    } finally {
      rmFile(sp);
    }
  });

  // ── callback_data byte-size invariant ──

  it('callback_data ≤ 64 bytes for all three outcome codes', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const due = '2026-06-20T14:00:00.000Z';
    expect(encodeCallbackData(uuid, due, 'c').length).toBeLessThanOrEqual(64);
    expect(encodeCallbackData(uuid, due, 'd').length).toBeLessThanOrEqual(64);
    expect(encodeCallbackData(uuid, due, 's').length).toBeLessThanOrEqual(64);
  });

  // ── Mixed: message + callback_query in same batch ──

  it('message and callback_query in same update batch: both processed, cursor covers both', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');

    const messageUpdate: TelegramUpdate = {
      update_id: 10,
      message: {
        message_id: 10,
        from: { id: Number(ALLOWED_ID) },
        chat: { id: Number(ALLOWED_ID), type: 'private' },
        date: 1_700_000_000,
        text: 'what is my load?',
      },
    };
    const cqUpdate: TelegramUpdate = makeCqUpdate({ updateId: 11, cqId: 'cq-mixed' });

    const t = new MockTelegramTransport([messageUpdate, cqUpdate]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      // The ask returned { answer:null, origin:'none' } → no message send
      expect(t.sent).toHaveLength(0);
      // The callback_query was answered
      expect(t.answeredCallbacks).toHaveLength(1);
      expect(t.answeredCallbacks[0]).toBe('cq-mixed');
      // Cursor covers BOTH update_ids (max = 11)
      expect(readStateCursor(sp)).toBe('11');
    } finally {
      rmFile(sp);
    }
  });

  // ── D-04 message no-loss path is UNCHANGED ──

  it('D-04 message ask error still holds cursor (callback_query errors do NOT change this)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    askStatusCode = 503; // ask fails → D-04: cursor not advanced

    const messageUpdate: TelegramUpdate = {
      update_id: 10,
      message: {
        message_id: 10,
        from: { id: Number(ALLOWED_ID) },
        chat: { id: Number(ALLOWED_ID), type: 'private' },
        date: 1_700_000_000,
        text: 'some question',
      },
    };
    const t = new MockTelegramTransport([messageUpdate]);
    const cfg = makeConfig({ statePath: sp, serveUrl: `http://127.0.0.1:${mockPort}` });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      // D-04: message error → cursor NOT advanced
      expect(readStateCursor(sp)).toBe('0');
    } finally {
      rmFile(sp);
    }
  });
});
