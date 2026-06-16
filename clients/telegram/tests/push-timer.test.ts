/**
 * clients/telegram/tests/push-timer.test.ts
 *
 * Tests for the proactive push loop: runPushTick, isInQuietHours, send-then-mark,
 * P0/P1 split, digest-only, never-empty-digest, server-side dedup, off-switch.
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
 *
 * Scenarios:
 *   isInQuietHours():
 *     - no quiet hours (start === end → false)
 *     - non-crossing range (e.g., 9–17)
 *     - midnight-crossing range (22→7): hour 23 and hour 3 are quiet, hour 12 is not
 *   runPushTick():
 *     - proactiveEnabled:false → returns without sending
 *     - P0 item sends even during quiet hours (D-05)
 *     - P1 item held at non-digest hour
 *     - P1 item sent at digest hour, outside quiet hours (D-06/D-07)
 *     - P1 item held at digest hour but inside quiet hours
 *     - zero P1 items at digest hour → never-empty-digest, nothing sent
 *     - pushInFlight re-entry guard prevents overlap
 *     - messages have inline keyboard (Done/Dismiss/Snooze buttons)
 *     - send-then-mark ordering (D-02): sendMessage before surfaceSeen
 *     - server-side dedup: second surface() returning [] yields no new sends
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runPushTick, isInQuietHours } from '../index';
import { MockTelegramTransport } from '../transport';
import { createMemoryClient } from '../memory-client';
import type { SurfaceItem } from '../memory-client';
import type { ClientConfig } from '../config';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

function uniqueStatePath(): string {
  return path.join(os.tmpdir(), `brain-push-test-${Date.now()}-${++_counter}.json`);
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
  statePath?: string;
  serveUrl?: string;
  proactiveEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  digestHour?: number;
  snoozeDurationMs?: number;
}): ClientConfig {
  const allowlist = opts.allowlist ?? ['111'];
  return {
    telegramToken: 'test-token',
    serveUrl: opts.serveUrl ?? 'http://127.0.0.1:9999',
    serveToken: 'test-serve-token',
    allowlist,
    pollIntervalMs: 500,
    statePath: opts.statePath ?? uniqueStatePath(),
    enabled: allowlist.length > 0,
    proactiveEnabled: opts.proactiveEnabled ?? true,
    pushPollMs: 120_000,
    quietHoursStart: opts.quietHoursStart ?? 22,
    quietHoursEnd: opts.quietHoursEnd ?? 7,
    digestHour: opts.digestHour ?? 8,
    snoozeDurationMs: opts.snoozeDurationMs ?? 86_400_000,
  };
}

function makeSurfaceItem(overrides: Partial<SurfaceItem> = {}): SurfaceItem {
  return {
    node_id: '550e8400-e29b-41d4-a716-446655440001',
    value: 'Complete workout plan review',
    due_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // +10 min
    action_type: 'review',
    tier: 0,
    score: 0.9,
    ...overrides,
  };
}

// ── isInQuietHours tests (no HTTP server needed) ──────────────────────────────

describe('isInQuietHours', () => {
  it('returns false when start === end (no quiet hours configured)', () => {
    expect(isInQuietHours(12, 0, 0)).toBe(false);
    expect(isInQuietHours(22, 22, 22)).toBe(false);
    expect(isInQuietHours(0, 0, 0)).toBe(false);
  });

  it('non-crossing range (9–17): hour 9, 12, 16 are quiet; 8 and 17 are not', () => {
    expect(isInQuietHours(9, 9, 17)).toBe(true);
    expect(isInQuietHours(12, 9, 17)).toBe(true);
    expect(isInQuietHours(16, 9, 17)).toBe(true);
    expect(isInQuietHours(8, 9, 17)).toBe(false);
    expect(isInQuietHours(17, 9, 17)).toBe(false);  // end is exclusive
    expect(isInQuietHours(18, 9, 17)).toBe(false);
  });

  it('midnight-crossing (22→7): hour 23 and hour 3 are quiet; hour 12 is not', () => {
    expect(isInQuietHours(23, 22, 7)).toBe(true);
    expect(isInQuietHours(3, 22, 7)).toBe(true);
    expect(isInQuietHours(22, 22, 7)).toBe(true);
    expect(isInQuietHours(6, 22, 7)).toBe(true);
    expect(isInQuietHours(7, 22, 7)).toBe(false);   // end is exclusive
    expect(isInQuietHours(12, 22, 7)).toBe(false);
    expect(isInQuietHours(21, 22, 7)).toBe(false);
  });
});

// ── runPushTick tests (with mock HTTP memory API) ─────────────────────────────

describe('runPushTick', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let scriptedSurfaceItems: SurfaceItem[];
  let seenRequests: Array<{ node_id: string; outcome: string; snooze_until?: string }>;
  let surfaceCallCount: number;

  beforeEach(async () => {
    scriptedSurfaceItems = [];
    seenRequests = [];
    surfaceCallCount = 0;
    mockPort = await getFreePort();
    mockServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/v1/surface')) {
        surfaceCallCount++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: scriptedSurfaceItems }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/surface/seen') {
        let body = '';
        req.on('data', d => { body += String(d); });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { node_id: string; outcome: string; snooze_until?: string };
          seenRequests.push(parsed);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => mockServer.listen(mockPort, '127.0.0.1', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => mockServer.close(() => r()));
  });

  // ── Off-switch ──

  it('proactiveEnabled:false → returns without sending anything', async () => {
    const item = makeSurfaceItem({ tier: 0 });
    scriptedSurfaceItems = [item];
    const t = new MockTelegramTransport();
    const cfg = makeConfig({ serveUrl: `http://127.0.0.1:${mockPort}`, proactiveEnabled: false });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(t.sent).toHaveLength(0);
    expect(seenRequests).toHaveLength(0);
    expect(surfaceCallCount).toBe(0); // never even polled
  });

  // ── P0 always sends, regardless of quiet hours ──

  it('P0 item (tier=0): sent during quiet hours (D-05 pierce)', async () => {
    const localHour = new Date().getHours();
    // Wrap current hour in quiet hours so we're guaranteed in quiet hours
    const qStart = localHour;
    const qEnd = (localHour + 1) % 24;
    const item = makeSurfaceItem({ tier: 0 });
    scriptedSurfaceItems = [item];

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: qStart,
      quietHoursEnd: qEnd,
      digestHour: 99, // impossible — no digest fires
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.chatId).toBe(111);
  });

  it('P0 item: pushed with inline keyboard (Done/Dismiss/Snooze buttons)', async () => {
    const item = makeSurfaceItem({ tier: 0 });
    scriptedSurfaceItems = [item];

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: 0, quietHoursEnd: 0, // no quiet hours
      digestHour: 99,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(t.sent).toHaveLength(1);
    const sent = t.sent[0]!;
    expect(sent.replyMarkup).toBeDefined();
    expect(sent.replyMarkup!.inline_keyboard).toHaveLength(1);
    const row = sent.replyMarkup!.inline_keyboard[0]!;
    expect(row).toHaveLength(3);
    // Three buttons — texts indicate Done/Dismiss/Snooze
    const labels = row.map(b => b.text);
    expect(labels.some(l => l.includes('Done'))).toBe(true);
    expect(labels.some(l => l.includes('Snooze'))).toBe(true);
    expect(labels.some(l => l.includes('Dismiss'))).toBe(true);
    // callback_data must be ≤ 64 bytes each
    for (const btn of row) {
      expect(btn.callback_data.length).toBeLessThanOrEqual(64);
    }
  });

  it('P0 item: send-then-mark ordering (D-02) — sendMessage fires BEFORE surfaceSeen', async () => {
    const item = makeSurfaceItem({ tier: 0 });
    scriptedSurfaceItems = [item];

    const callOrder: string[] = [];
    let mockServerWithOrder: http.Server;
    const port2 = await getFreePort();
    mockServerWithOrder = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/v1/surface')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [item] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/surface/seen') {
        callOrder.push('surfaceSeen');
        let body = ''; req.on('data', d => { body += String(d); });
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => mockServerWithOrder.listen(port2, '127.0.0.1', r));

    // Intercept sendMessage to track ordering
    class OrderedMockTransport extends MockTelegramTransport {
      override async sendMessage(chatId: number, text: string, replyMarkup?: import('../transport').InlineKeyboardMarkup): Promise<void> {
        callOrder.push('sendMessage');
        return super.sendMessage(chatId, text, replyMarkup);
      }
    }

    const t = new OrderedMockTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${port2}`,
      quietHoursStart: 0, quietHoursEnd: 0,
      digestHour: 99,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    try {
      await runPushTick(cfg, t, mc);
      expect(callOrder).toEqual(['sendMessage', 'surfaceSeen']); // send-then-mark
    } finally {
      await new Promise<void>(r => mockServerWithOrder.close(() => r()));
    }
  });

  // ── P1 digest logic ──

  it('P1 item (tier=1): NOT sent at non-digest hour', async () => {
    const localHour = new Date().getHours();
    const nonDigestHour = (localHour + 12) % 24; // 12h away from current
    const item = makeSurfaceItem({ tier: 1 });
    scriptedSurfaceItems = [item];

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: 0, quietHoursEnd: 0, // no quiet hours
      digestHour: nonDigestHour,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(t.sent).toHaveLength(0);
    expect(seenRequests).toHaveLength(0);
  });

  it('P1 item: sent at digest hour, outside quiet hours (D-06/D-07)', async () => {
    const localHour = new Date().getHours();
    const item = makeSurfaceItem({ tier: 1 });
    scriptedSurfaceItems = [item];

    const t = new MockTelegramTransport();
    // digestHour = current hour; no quiet hours
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: 0, quietHoursEnd: 0,
      digestHour: localHour,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(t.sent).toHaveLength(1);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]!.outcome).toBe('surfaced');
  });

  it('P1 item: NOT sent at digest hour when inside quiet hours', async () => {
    const localHour = new Date().getHours();
    // Make current hour "quiet"
    const qStart = localHour;
    const qEnd = (localHour + 1) % 24;
    const item = makeSurfaceItem({ tier: 1 });
    scriptedSurfaceItems = [item];

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: qStart,
      quietHoursEnd: qEnd,
      digestHour: localHour, // digest is "now" but we're in quiet hours
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(t.sent).toHaveLength(0);
    expect(seenRequests).toHaveLength(0);
  });

  it('never-empty-digest (D-06): zero P1 items at digest hour → nothing sent', async () => {
    const localHour = new Date().getHours();
    // No items at all
    scriptedSurfaceItems = [];

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: 0, quietHoursEnd: 0,
      digestHour: localHour,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(t.sent).toHaveLength(0);
  });

  // ── pushInFlight re-entry guard ──

  it('pushInFlight: second concurrent runPushTick is a no-op', async () => {
    const item = makeSurfaceItem({ tier: 0 });
    scriptedSurfaceItems = [item];

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: 0, quietHoursEnd: 0,
      digestHour: 99,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    // Start two ticks synchronously: tick1 sets pushInFlight=true before yielding at surface();
    // tick2 sees the flag and returns immediately.
    const tick1 = runPushTick(cfg, t, mc);
    const tick2 = runPushTick(cfg, t, mc); // should be skipped (in-flight guard)
    await tick1;
    await tick2;

    // Only one send (tick2 was a no-op)
    expect(t.sent).toHaveLength(1);
    expect(seenRequests).toHaveLength(1);
  });

  // ── Server-side dedup ──

  it('server-side dedup: after items marked, second tick with empty surface → no new sends', async () => {
    const item = makeSurfaceItem({ tier: 0 });

    // First surface() call returns [item]; second returns [] (server excluded already-surfaced)
    let surfaceCallN = 0;
    let mockServer2: http.Server;
    const port2 = await getFreePort();
    mockServer2 = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/v1/surface')) {
        surfaceCallN++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: surfaceCallN === 1 ? [item] : [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/surface/seen') {
        let body = ''; req.on('data', d => { body += String(d); });
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => mockServer2.listen(port2, '127.0.0.1', r));

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${port2}`,
      quietHoursStart: 0, quietHoursEnd: 0,
      digestHour: 99,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    try {
      // First tick: item is sent and marked
      await runPushTick(cfg, t, mc);
      expect(t.sent).toHaveLength(1);

      // Second tick: server returns [] — no new sends
      await runPushTick(cfg, t, mc);
      expect(t.sent).toHaveLength(1); // still 1, no new send
    } finally {
      await new Promise<void>(r => mockServer2.close(() => r()));
    }
  });

  // ── surfaceSeen outcome is 'surfaced' for pushed items ──

  it('pushed items are marked with outcome:surfaced', async () => {
    const item = makeSurfaceItem({ tier: 0 });
    scriptedSurfaceItems = [item];

    const t = new MockTelegramTransport();
    const cfg = makeConfig({
      serveUrl: `http://127.0.0.1:${mockPort}`,
      quietHoursStart: 0, quietHoursEnd: 0,
      digestHour: 99,
    });
    const mc = createMemoryClient(cfg.serveUrl, cfg.serveToken);

    await runPushTick(cfg, t, mc);

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]!.node_id).toBe(item.node_id);
    expect(seenRequests[0]!.outcome).toBe('surfaced');
  });
});
