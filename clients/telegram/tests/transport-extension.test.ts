/**
 * clients/telegram/tests/transport-extension.test.ts
 *
 * TDD RED tests for Phase 22 Plan 01 Task 2:
 *   - callback_query field on TelegramUpdate
 *   - InlineKeyboardMarkup / InlineKeyboardButton / CallbackQuery interfaces
 *   - sendMessage extended with optional replyMarkup (backward-compatible)
 *   - answerCallbackQuery on TelegramTransport interface and DefaultTelegramTransport
 *   - MockTelegramTransport: sent[] captures replyMarkup; answeredCallbacks[] records calls
 *
 * No src/ imports — CLIENT-01 structural guard enforced.
 */

import { describe, it, expect } from 'vitest';
import {
  MockTelegramTransport,
  DefaultTelegramTransport,
  type TelegramUpdate,
  type InlineKeyboardMarkup,
  type CallbackQuery,
} from '../transport';

// ── Type-level assertions (fail at compile time if interfaces are missing) ────

describe('TelegramUpdate — callback_query field', () => {
  it('TelegramUpdate accepts a callback_query field alongside message', () => {
    const cq: CallbackQuery = {
      id: 'cq-001',
      from: { id: 111 },
      data: '1|550e8400-e29b-41d4-a716-446655440000|1750420800|c',
      message: { message_id: 5, chat: { id: 111 } },
    };

    const update: TelegramUpdate = {
      update_id: 20,
      callback_query: cq,
    };

    expect(update.update_id).toBe(20);
    expect(update.callback_query?.id).toBe('cq-001');
    expect(update.callback_query?.from.id).toBe(111);
    expect(update.callback_query?.data).toBe('1|550e8400-e29b-41d4-a716-446655440000|1750420800|c');
    expect(update.message).toBeUndefined();
  });

  it('TelegramUpdate can carry both message and callback_query (both optional)', () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 111 },
        chat: { id: 111, type: 'private' },
        date: 1_700_000_000,
        text: 'hello',
      },
    };
    expect(update.message?.text).toBe('hello');
    expect(update.callback_query).toBeUndefined();
  });
});

// ── MockTelegramTransport extensions ─────────────────────────────────────────

describe('MockTelegramTransport — answeredCallbacks', () => {
  it('starts with empty answeredCallbacks array', () => {
    const t = new MockTelegramTransport();
    // @ts-expect-error — property does not exist until implemented
    expect(t.answeredCallbacks).toEqual([]);
  });

  it('answerCallbackQuery appends id to answeredCallbacks', async () => {
    const t = new MockTelegramTransport();
    // @ts-expect-error — method does not exist until implemented
    await t.answerCallbackQuery('cq-123');
    // @ts-expect-error
    expect(t.answeredCallbacks).toHaveLength(1);
    // @ts-expect-error
    expect(t.answeredCallbacks[0]).toBe('cq-123');
  });

  it('multiple answerCallbackQuery calls accumulate in order', async () => {
    const t = new MockTelegramTransport();
    // @ts-expect-error
    await t.answerCallbackQuery('cq-a');
    // @ts-expect-error
    await t.answerCallbackQuery('cq-b');
    // @ts-expect-error
    expect(t.answeredCallbacks).toEqual(['cq-a', 'cq-b']);
  });
});

describe('MockTelegramTransport — sendMessage with replyMarkup', () => {
  it('sendMessage without replyMarkup still records entry (backward-compatible)', async () => {
    const t = new MockTelegramTransport();
    await t.sendMessage(111, 'hello');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ chatId: 111, text: 'hello' });
  });

  it('sendMessage with replyMarkup records replyMarkup on sent entry', async () => {
    const t = new MockTelegramTransport();
    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: 'Done', callback_data: '1|uuid|123|c' },
          { text: 'Dismiss', callback_data: '1|uuid|123|d' },
          { text: 'Snooze', callback_data: '1|uuid|123|s' },
        ],
      ],
    };
    await t.sendMessage(111, 'push message', markup);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ chatId: 111, text: 'push message', replyMarkup: markup });
  });

  it('sent entries carry replyMarkup only when provided', async () => {
    const t = new MockTelegramTransport();
    const markup: InlineKeyboardMarkup = { inline_keyboard: [[{ text: 'Done', callback_data: 'x' }]] };
    await t.sendMessage(111, 'no-markup');
    await t.sendMessage(222, 'with-markup', markup);
    expect(t.sent[0]).not.toHaveProperty('replyMarkup');
    expect(t.sent[1]).toHaveProperty('replyMarkup', markup);
  });
});

describe('MockTelegramTransport — getUpdates with callback_query updates', () => {
  it('returns callback_query updates from scripted updates', async () => {
    const cqUpdate: TelegramUpdate = {
      update_id: 20,
      callback_query: {
        id: 'cq-001',
        from: { id: 111 },
        data: '1|550e8400-e29b-41d4-a716-446655440000|1750420800|c',
        message: { message_id: 5, chat: { id: 111 } },
      },
    };
    const t = new MockTelegramTransport([cqUpdate]);
    const updates = await t.getUpdates(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.callback_query?.id).toBe('cq-001');
    expect(updates[0]!.message).toBeUndefined();
  });
});

// ── DefaultTelegramTransport — answerCallbackQuery ────────────────────────────

describe('DefaultTelegramTransport — answerCallbackQuery', () => {
  it('answerCallbackQuery throws on non-ok HTTP response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
    try {
      const transport = new DefaultTelegramTransport('test-token');
      await expect(transport.answerCallbackQuery('cq-id')).rejects.toThrow(
        'telegram answerCallbackQuery HTTP 400',
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('answerCallbackQuery succeeds on 200 response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;
    try {
      const transport = new DefaultTelegramTransport('test-token');
      await expect(transport.answerCallbackQuery('cq-id')).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('DefaultTelegramTransport — sendMessage with reply_markup', () => {
  it('sendMessage includes reply_markup in body when provided', async () => {
    let capturedBody: string | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;
    try {
      const transport = new DefaultTelegramTransport('test-token');
      const markup: InlineKeyboardMarkup = {
        inline_keyboard: [[{ text: 'Done', callback_data: '1|x|123|c' }]],
      };
      await transport.sendMessage(111, 'hello', markup);
      const parsed = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
      expect(parsed['reply_markup']).toEqual(markup);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('sendMessage omits reply_markup from body when not provided', async () => {
    let capturedBody: string | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;
    try {
      const transport = new DefaultTelegramTransport('test-token');
      await transport.sendMessage(111, 'hello');
      const parsed = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
      expect(parsed['reply_markup']).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
