/**
 * clients/telegram/tests/telegram-client.test.ts
 *
 * Ported telegram-channel + watcher test scenarios, rewired against a mock HTTP
 * memory API instead of an in-process engine responder.
 *
 * Imports only from ../ (client modules) and node built-ins / vitest.
 * No imports from ../../src/ — CLIENT-01 structural guard enforced.
 *
 * Scenarios:
 *   fetchMessages():
 *     (a) empty allowlist → fail-closed, idle
 *     (b)/(c) allowlist filtering + InboundMessage mapping
 *     (d) non-text updates ignored
 *     (e) fetch is write-free (cursor only changes via runClientTick commit path)
 *     (f) cold-start L-9 pagination → baseline, no messages
 *   runClientTick():
 *     (a) empty allowlist → transport.sent empty, no ask calls
 *     (g) idle tick (empty transport) → no /v1/ask call
 *     (h) tickInFlight overlap → second tick is a no-op
 *     (i) monotonic commit → stale messages (id ≤ cursor) dropped
 *     (j) cold-start baseline committed, backlog NOT answered
 *     (k) null/origin:'none' ask reply → no Telegram send
 *     (l) non-null reply → exactly one send
 *     D-04 no-loss: serve returns 503 → cursor NOT advanced, no reply sent
 *     C-1 never-throw: serve error resolves (does not reject) runClientTick
 *   DefaultTelegramTransport:
 *     M-2 non-2xx error surfacing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fetchMessages, runClientTick } from '../index';
import { MockTelegramTransport, DefaultTelegramTransport } from '../transport';
import type { TelegramTransport, TelegramUpdate } from '../transport';
import { writeStateCursor, readStateCursor } from '../state';
import { createMemoryClient } from '../memory-client';
import type { ClientConfig } from '../config';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALLOWED_ID = '111';
let _counter = 0;

function makeUpdate(
  update_id: number,
  fromId: number,
  text: string | undefined,
  date = 1_700_000_000,
): TelegramUpdate {
  return {
    update_id,
    message:
      text === undefined
        ? undefined
        : { message_id: update_id, from: { id: fromId }, chat: { id: fromId }, date, text },
  };
}

/** Generates a unique temp file path; safe even when Date.now() collides across tests. */
function uniqueStatePath(): string {
  return path.join(
    os.tmpdir(),
    `brain-client-test-${Date.now()}-${++_counter}.json`,
  );
}

function makeConfig(opts: {
  allowlist: string[];
  statePath: string;
  serveUrl?: string;
}): ClientConfig {
  return {
    telegramToken: 'test-token',
    serveUrl: opts.serveUrl ?? 'http://127.0.0.1:9999',
    serveToken: 'test-serve-token',
    allowlist: opts.allowlist,
    pollIntervalMs: 500,
    statePath: opts.statePath,
    enabled: opts.allowlist.length > 0,
  };
}

function rmFile(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore — file may not exist */ }
}

// ── Mock HTTP server helpers (used by runClientTick tests) ────────────────────

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

// ── fetchMessages tests (no HTTP server needed) ───────────────────────────────

// (a) Empty allowlist fail-closed
describe('fetchMessages — (a) empty allowlist fail-closed', () => {
  it('returns {messages:[], commitTo:null} when allowlist is empty', async () => {
    const sp = uniqueStatePath();
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'hi')]);
    try {
      const r = await fetchMessages(t, { allowlist: [], statePath: sp });
      expect(r).toEqual({ messages: [], commitTo: null });
    } finally {
      rmFile(sp);
    }
  });
});

// (b)/(c) Allowlist filtering + InboundMessage mapping
describe('fetchMessages — (b)/(c) allowlist filtering + InboundMessage mapping', () => {
  it('returns only allowlisted updates; unlisted dropped; commitTo covers all scanned', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0'); // non-cold-start: cursor pre-seeded
    const t = new MockTelegramTransport([
      makeUpdate(10, 111, 'what is my load?'),
      makeUpdate(11, 999, 'spam'),
    ]);
    try {
      const r = await fetchMessages(t, { allowlist: [ALLOWED_ID], statePath: sp });
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]!.text).toBe('what is my load?');
      expect(r.commitTo).toBe('11'); // covers both scanned updates
    } finally {
      rmFile(sp);
    }
  });

  it('maps update → InboundMessage (id=update_id, sender=chat.id, ts=date*1000)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const t = new MockTelegramTransport([makeUpdate(42, 111, 'q', 1_700_000_500)]);
    try {
      const r = await fetchMessages(t, { allowlist: [ALLOWED_ID], statePath: sp });
      expect(r.messages[0]).toMatchObject({
        id: '42',
        sender: '111',
        text: 'q',
        ts: 1_700_000_500_000,
      });
      expect(r.commitTo).toBe('42');
    } finally {
      rmFile(sp);
    }
  });
});

// (d) Non-text updates ignored
describe('fetchMessages — (d) non-text updates ignored', () => {
  it('ignores non-text updates; commitTo still covers them', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    const t = new MockTelegramTransport([
      makeUpdate(10, 111, undefined), // sticker / photo / join — no text
      makeUpdate(11, 111, 'real question'),
    ]);
    try {
      const r = await fetchMessages(t, { allowlist: [ALLOWED_ID], statePath: sp });
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]!.text).toBe('real question');
      expect(r.commitTo).toBe('11');
    } finally {
      rmFile(sp);
    }
  });
});

// (e) Fetch is write-free — cursor only changes via runClientTick commit path
describe('fetchMessages — (e) fetch is write-free (T-LOCK-01 analog)', () => {
  it('state file unchanged after fetchMessages() on normal path', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '5');
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'q')]);
    try {
      await fetchMessages(t, { allowlist: [ALLOWED_ID], statePath: sp });
      expect(readStateCursor(sp)).toBe('5'); // must NOT advance the cursor
    } finally {
      rmFile(sp);
    }
  });

  it('state file absent after fetchMessages() on cold start (never writes)', async () => {
    const sp = uniqueStatePath(); // no file pre-created
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'hi')]);
    try {
      expect(fs.existsSync(sp)).toBe(false);
      await fetchMessages(t, { allowlist: [ALLOWED_ID], statePath: sp });
      // fetchMessages NEVER writes the state file — write-free (T-LOCK-01)
      expect(fs.existsSync(sp)).toBe(false);
    } finally {
      rmFile(sp);
    }
  });
});

// (f) Cold-start L-9 pagination to exhaustion
describe('fetchMessages — (f) cold-start L-9 pagination', () => {
  it('paginates to exhaustion, returns baseline commitTo with empty messages; state file absent', async () => {
    const sp = uniqueStatePath();

    // 130 queued updates: page1 (ids 0–99) then page2 (ids 100–129) then empty
    const page1: TelegramUpdate[] = Array.from({ length: 100 }, (_, i) => ({
      update_id: i,
      message: {
        message_id: i,
        from: { id: 111 },
        chat: { id: 111 },
        date: 1_700_000_000,
        text: 'old',
      },
    }));
    const page2: TelegramUpdate[] = Array.from({ length: 30 }, (_, i) => ({
      update_id: 100 + i,
      message: {
        message_id: 100 + i,
        from: { id: 111 },
        chat: { id: 111 },
        date: 1_700_000_001,
        text: 'old2',
      },
    }));

    const pagedTransport: TelegramTransport = {
      async getUpdates(offset: number): Promise<TelegramUpdate[]> {
        if (offset === 0) return page1;
        if (offset === 100) return page2;
        return [];
      },
      async sendMessage(): Promise<void> {},
    };

    try {
      const r = await fetchMessages(pagedTransport, { allowlist: [ALLOWED_ID], statePath: sp });
      expect(r.messages).toEqual([]);
      expect(r.commitTo).toBe('129'); // max update_id across both pages
      expect(fs.existsSync(sp)).toBe(false); // write-free
    } finally {
      rmFile(sp);
    }
  });
});

// ── runClientTick tests (with mock HTTP memory API) ───────────────────────────

describe('runClientTick', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let scriptedStatusCode: number;
  let scriptedAskReply: { answer: string | null; origin: string };
  let askRequestCount: number;

  beforeEach(async () => {
    scriptedStatusCode = 200;
    scriptedAskReply = { answer: null, origin: 'none' };
    askRequestCount = 0;
    mockPort = await getFreePort();
    mockServer = http.createServer((_req, res) => {
      askRequestCount++;
      res.writeHead(scriptedStatusCode, { 'content-type': 'application/json' });
      res.end(
        scriptedStatusCode >= 400
          ? JSON.stringify({ error: 'scripted error' })
          : JSON.stringify(scriptedAskReply),
      );
    });
    await new Promise<void>(r => mockServer.listen(mockPort, '127.0.0.1', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => mockServer.close(() => r()));
  });

  // ── (a) Empty allowlist → transport.sent.length === 0 ──

  it('(a) empty allowlist → transport.sent empty, no ask calls made', async () => {
    const sp = uniqueStatePath();
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'hi')]);
    const cfg = makeConfig({
      allowlist: [],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(t.sent).toHaveLength(0);
      expect(askRequestCount).toBe(0);
    } finally {
      rmFile(sp);
    }
  });

  // ── (g) Idle tick → no /v1/ask call ──

  it('(g) idle tick (no new updates) → no ask call, no send', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0'); // non-cold-start: cursor already set
    const t = new MockTelegramTransport([]); // no updates
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(askRequestCount).toBe(0);
      expect(t.sent).toHaveLength(0);
    } finally {
      rmFile(sp);
    }
  });

  // ── (h) tickInFlight overlap → second tick is a no-op ──

  it('(h) overlapping ticks → second tick is a no-op (tickInFlight guard)', async () => {
    // tickInFlight is set synchronously before the first await in runClientTick.
    // tick2, started synchronously after tick1, immediately sees the flag and returns.
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    scriptedAskReply = { answer: 'memory reply', origin: 'fact' };
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'q')]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      const tick1 = runClientTick(cfg, t, mc); // sets tickInFlight=true, yields at first await
      const tick2 = runClientTick(cfg, t, mc); // sees tickInFlight=true, returns immediately
      await tick1;
      await tick2;
      // tick1 sent one reply; tick2 was a complete no-op
      expect(t.sent).toHaveLength(1);
      expect(readStateCursor(sp)).toBe('10'); // cursor committed exactly once
    } finally {
      rmFile(sp);
    }
  });

  // ── (i) Monotonic commit → stale messages (id <= cursor) dropped ──

  it('(i) stale messages (id ≤ cursor) dropped; commit skipped when commitTo ≤ cursor', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '5');

    // Custom transport that returns update_id=3 regardless of offset, simulating a message
    // the cursor has already passed (cursor=5, message_id=3 → stale).
    const sent: Array<{ chatId: number; text: string }> = [];
    const staleTransport: TelegramTransport = {
      async getUpdates(_offset: number): Promise<TelegramUpdate[]> {
        return [{
          update_id: 3,
          message: {
            message_id: 3,
            from: { id: 111 },
            chat: { id: 111 },
            date: 1_700_000_000,
            text: 'stale',
          },
        }];
      },
      async sendMessage(chatId: number, text: string): Promise<void> {
        sent.push({ chatId, text });
      },
    };

    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, staleTransport, mc);
      // id=3 ≤ cursor=5 → message filtered out; no send
      expect(sent).toHaveLength(0);
      // commitTo max(5,3)=5 ≤ cursor=5 → skipCommit=true; no cursor write
      expect(readStateCursor(sp)).toBe('5');
      expect(askRequestCount).toBe(0);
    } finally {
      rmFile(sp);
    }
  });

  // ── (j) Cold-start baseline committed; backlog NOT answered ──

  it('(j) cold-start baseline committed; backlog NOT answered; no ask calls', async () => {
    const sp = uniqueStatePath(); // no state file → cold start
    const t = new MockTelegramTransport([
      makeUpdate(5, 111, 'old1'),
      makeUpdate(10, 111, 'old2'),
      makeUpdate(15, 111, 'old3'),
    ]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      // Baseline committed to max update_id
      expect(readStateCursor(sp)).toBe('15');
      // Backlog not answered — cold start skips all prior messages
      expect(t.sent).toHaveLength(0);
      expect(askRequestCount).toBe(0);
    } finally {
      rmFile(sp);
    }
  });

  // ── (k) null/origin:'none' ask reply → no Telegram send ──

  it('(k) null answer → no send (safe-null discipline)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    scriptedAskReply = { answer: null, origin: 'none' };
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'q')]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(t.sent).toHaveLength(0);
    } finally {
      rmFile(sp);
    }
  });

  it('(k) origin:"none" with non-null answer → no send (safe-null discipline)', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    scriptedAskReply = { answer: 'some text', origin: 'none' };
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'q')]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(t.sent).toHaveLength(0);
    } finally {
      rmFile(sp);
    }
  });

  // ── (l) Non-null reply → exactly one send ──

  it('(l) non-null answer with non-none origin → exactly one send', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    scriptedAskReply = { answer: 'your training load is 42', origin: 'fact' };
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'what is my load?')]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toEqual({ chatId: 111, text: 'your training load is 42' });
    } finally {
      rmFile(sp);
    }
  });

  // ── D-04 no-loss: serve unreachable → cursor NOT advanced ──

  it('D-04 no-loss: serve returns 503 → cursor NOT advanced, no reply sent', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    scriptedStatusCode = 503;
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'q')]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      // No reply sent (serve error → no answer)
      expect(t.sent).toHaveLength(0);
      // Cursor NOT advanced (D-04: message retried next tick, no message loss)
      expect(readStateCursor(sp)).toBe('0');
    } finally {
      rmFile(sp);
    }
  });

  it('D-04 no-loss: serve returns 500 → cursor NOT advanced, no reply sent', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    scriptedStatusCode = 500;
    const t = new MockTelegramTransport([makeUpdate(20, 111, 'q')]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await runClientTick(cfg, t, mc);
      expect(t.sent).toHaveLength(0);
      expect(readStateCursor(sp)).toBe('0');
    } finally {
      rmFile(sp);
    }
  });

  // ── C-1 never-throw: serve error resolves (does not reject) runClientTick ──

  it('C-1 never-throw: runClientTick resolves (not rejects) when serve returns non-2xx', async () => {
    const sp = uniqueStatePath();
    writeStateCursor(sp, '0');
    scriptedStatusCode = 500;
    const t = new MockTelegramTransport([makeUpdate(10, 111, 'q')]);
    const cfg = makeConfig({
      allowlist: [ALLOWED_ID],
      statePath: sp,
      serveUrl: `http://127.0.0.1:${mockPort}`,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);
    try {
      await expect(runClientTick(cfg, t, mc)).resolves.toBeUndefined();
    } finally {
      rmFile(sp);
    }
  });
});

// ── M-2: DefaultTelegramTransport non-2xx error surfacing ─────────────────────

describe('DefaultTelegramTransport — M-2 non-2xx error surfacing', () => {
  it('getUpdates() throws on non-ok HTTP response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
    try {
      const transport = new DefaultTelegramTransport('test-token');
      await expect(transport.getUpdates(0)).rejects.toThrow('telegram getUpdates HTTP 500');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('sendMessage() throws on non-ok HTTP response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
    try {
      const transport = new DefaultTelegramTransport('test-token');
      await expect(transport.sendMessage(123, 'hi')).rejects.toThrow('telegram sendMessage HTTP 400');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
