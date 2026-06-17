/**
 * clients/telegram/tests/mcp-client.test.ts
 *
 * Phase 23 Plan 02 — MCP client wrapper coverage (ACT-02 / T-SEC-02).
 *
 *   (a) callServerTool fires the SDK with the exact { name, arguments } payload
 *       (the key is `arguments`, NOT `args` — RESEARCH Pitfall #1).
 *   (b) extractToolOutput keeps only text content; image/non-text dropped.
 *   (c) result.isError === true is reported as a distinct failure flag while the
 *       extracted text is preserved (Pitfall #2).
 *   (d) a transport that throws still invokes close() (finally) and the error
 *       surfaces to the caller (Pitfall #4 — no leaked subprocess).
 *   (e) T-SEC-02 structural guard: mcp-client.ts imports no proposal-engine /
 *       DeepSeek / LLM module — tool output can never be re-fed to an LLM.
 *
 * No src/ imports — CLIENT-01 structural guard enforced.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  callServerTool,
  listServerTools,
  extractToolOutput,
  type McpConnection,
  type McpToolResult,
  type McpToolDescriptor,
} from '../mcp-client';
import type { McpServerConfig } from '../types';

const CFG: McpServerConfig = {
  name: 'test-server',
  transport: 'stdio',
  command: 'noop',
  allowedTools: [],
};

/** Scripted MCP connection — records calls; never spawns a real subprocess. */
class MockMcpConnection implements McpConnection {
  connectCalls = 0;
  closeCalls = 0;
  capturedCall: { name: string; arguments: Record<string, unknown> } | undefined;
  constructor(
    private readonly opts: {
      tools?: McpToolDescriptor[];
      result?: McpToolResult;
      throwOn?: 'connect' | 'list' | 'call';
    } = {},
  ) {}
  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.opts.throwOn === 'connect') throw new Error('connect boom');
  }
  async listTools(): Promise<{ tools: McpToolDescriptor[] }> {
    if (this.opts.throwOn === 'list') throw new Error('list boom');
    return { tools: this.opts.tools ?? [] };
  }
  async callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<McpToolResult> {
    this.capturedCall = params;
    if (this.opts.throwOn === 'call') throw new Error('call boom');
    return this.opts.result ?? { content: [] };
  }
  async close(): Promise<void> {
    this.closeCalls++;
  }
}

describe('callServerTool — payload + lifecycle', () => {
  it('(a) invokes the SDK with the `arguments` key (not `args`)', async () => {
    const mock = new MockMcpConnection({ result: { content: [{ type: 'text', text: 'done' }] } });
    const args = { to: 'alice@example.com', body: 'hi' };
    await callServerTool(CFG, 'send_email', args, () => mock);

    expect(mock.capturedCall).toEqual({ name: 'send_email', arguments: args });
    expect(Object.keys(mock.capturedCall ?? {})).toContain('arguments');
    expect(Object.keys(mock.capturedCall ?? {})).not.toContain('args');
    expect(mock.connectCalls).toBe(1);
    expect(mock.closeCalls).toBe(1);
  });

  it('(d) closes the connection and surfaces the error when the transport throws', async () => {
    const mock = new MockMcpConnection({ throwOn: 'call' });
    await expect(callServerTool(CFG, 'send_email', { to: 'x' }, () => mock)).rejects.toThrow(
      'call boom',
    );
    // finally ran even though callTool threw — no leaked subprocess (Pitfall #4).
    expect(mock.closeCalls).toBe(1);
  });

  it('(d2) closes the connection even when connect() throws', async () => {
    const mock = new MockMcpConnection({ throwOn: 'connect' });
    await expect(callServerTool(CFG, 't', {}, () => mock)).rejects.toThrow('connect boom');
    expect(mock.closeCalls).toBe(1);
  });
});

describe('listServerTools — lifecycle', () => {
  it('returns the tools array and closes in finally', async () => {
    const tools: McpToolDescriptor[] = [{ name: 't1', inputSchema: { type: 'object' } }];
    const mock = new MockMcpConnection({ tools });
    const out = await listServerTools(CFG, () => mock);
    expect(out).toEqual(tools);
    expect(mock.closeCalls).toBe(1);
  });

  it('closes even when listTools throws', async () => {
    const mock = new MockMcpConnection({ throwOn: 'list' });
    await expect(listServerTools(CFG, () => mock)).rejects.toThrow('list boom');
    expect(mock.closeCalls).toBe(1);
  });
});

describe('extractToolOutput — data-only text extraction (T-SEC-02)', () => {
  it('(b) keeps only text content; image/non-text dropped', () => {
    const out = extractToolOutput({
      content: [
        { type: 'image', data: 'base64...', mimeType: 'image/png' },
        { type: 'text', text: 'ok' },
      ],
    });
    expect(out.text).toBe('ok');
    expect(out.isError).toBe(false);
  });

  it('joins multiple text items with newlines', () => {
    const out = extractToolOutput({
      content: [
        { type: 'text', text: 'line1' },
        { type: 'resource', resource: { uri: 'x', text: 'ignored' } },
        { type: 'text', text: 'line2' },
      ],
    });
    expect(out.text).toBe('line1\nline2');
  });

  it('(c) reports isError true while preserving the extracted text', () => {
    const out = extractToolOutput({
      content: [{ type: 'text', text: 'tool failed: bad input' }],
      isError: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toBe('tool failed: bad input');
  });

  it('handles a result with no content array (legacy/empty shape)', () => {
    const out = extractToolOutput({});
    expect(out.text).toBe('');
    expect(out.isError).toBe(false);
  });
});

describe('(e) T-SEC-02 structural guard — no LLM re-feed path', () => {
  it('mcp-client.ts imports no proposal-engine / DeepSeek / LLM module', () => {
    const src = readFileSync(resolve(__dirname, '..', 'mcp-client.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*proposal-engine/);
    expect(src).not.toMatch(/from\s+['"][^'"]*deepseek/i);
    expect(src).not.toMatch(/from\s+['"][^'"]*openai['"]/i);
  });
});
