// ---------------------------------------------------------------------------
// Thin MCP client wrapper (Phase 23 — ACT-02 / T-SEC-02)
// ---------------------------------------------------------------------------
//
// Connects to a user-configured MCP server (stdio subprocess or StreamableHTTP),
// lists its tools, executes a single tool, and ALWAYS closes the connection.
//
// This module is the one place that touches the @modelcontextprotocol/sdk Client.
// It encodes the v1.29.0 gotchas in one seam so the engine/index plans never call
// raw SDK methods:
//   - callTool uses the `arguments` key (NOT `args`) — RESEARCH Pitfall #1.
//   - imports use `.js` extensions (matching serve-cli.ts / mcp-cli.ts).
//   - close() runs in a finally on every path, even on connect/list/call throw
//     (RESEARCH Pitfall #4 — never leak the stdio subprocess).
//   - server-advertised destructive / read-only hint annotations are NEVER read
//     (D-08 / H-11) — they are not even referenced here.
//   - the server's "tool list changed" notification callback is NEVER registered
//     (H-11) — only the user's allowlist config is authoritative; a server cannot
//     expand its own blast radius.
//
// Tool output is treated as OPAQUE TEXT DATA. extractToolOutput() returns the
// joined text content plus a separate isError flag; this module imports no LLM /
// DeepSeek / proposal-engine module, so tool output can never be re-fed to an LLM
// (T-SEC-02 — enforced structurally, verified by the import-boundary test).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types';

/**
 * Per-request timeout (ms) bounding the MCP handshake / list / call. If a
 * user-configured server is slow to start or unresponsive, the call rejects and
 * the caller degrades to a plain notify (D-02 fallback). RESEARCH Risk 3.
 */
export const MCP_REQUEST_TIMEOUT_MS = 15_000;

/** A single content item from a callTool result (we only ever consume `text`). */
export interface McpContentItem {
  type: string;
  text?: string;
  [x: string]: unknown;
}

/**
 * The subset of a callTool result this wrapper consumes. `content` and `isError`
 * are both optional to remain assignable from the SDK's full result union.
 */
export interface McpToolResult {
  content?: McpContentItem[];
  isError?: boolean;
  [x: string]: unknown;
}

/** A tool descriptor as returned by listTools(). Descriptions/annotations are
 *  carried through but never acted on here (T-SEC-01 stripping is the engine's job;
 *  D-08 hint-ignoring is enforced by never reading the annotations field). */
export interface McpToolDescriptor {
  name: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
    [x: string]: unknown;
  };
  [x: string]: unknown;
}

/**
 * Minimal MCP connection seam consumed by the wrapper. The default factory wraps
 * a real SDK Client; unit tests inject a scripted implementation so no real
 * subprocess is ever spawned (mirrors the MockTelegramTransport pattern).
 */
export interface McpConnection {
  connect(): Promise<void>;
  listTools(): Promise<{ tools: McpToolDescriptor[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpToolResult>;
  close(): Promise<void>;
}

/** Builds an McpConnection from a server config. Injectable for tests. */
export type McpConnectionFactory = (cfg: McpServerConfig) => McpConnection;

/**
 * Production connection factory: builds the real stdio/http transport from the
 * (already env-interpolated) McpServerConfig and wraps the SDK Client.
 *
 * stdio: command + args + env + stderr:'pipe' (capture, never inherit).
 * http : new URL(cfg.url) + requestInit.headers built from cfg.env (already
 *        interpolated — Authorization etc. stay in env, never inline; H-14).
 */
export const defaultConnectionFactory: McpConnectionFactory = (cfg) => {
  const client = new Client(
    { name: 'recense-approval-client', version: '0.1.0' },
    { capabilities: {} },
  );

  let transport;
  if (cfg.transport === 'http') {
    if (!cfg.url) throw new Error(`mcp server '${cfg.name}': http transport requires a url`);
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.env ?? {} },
    });
  } else {
    const { command, args = [], env } = cfg;
    if (!command) throw new Error(`mcp server '${cfg.name}': stdio transport requires a command`);
    transport = new StdioClientTransport({
      command,
      args,
      env: env ?? {},
      stderr: 'pipe',
    });
  }

  const opts = { timeout: MCP_REQUEST_TIMEOUT_MS };
  return {
    async connect() {
      await client.connect(transport, opts);
    },
    async listTools() {
      const r = await client.listTools(undefined, opts);
      return { tools: r.tools };
    },
    async callTool(params) {
      return client.callTool(params, undefined, opts);
    },
    async close() {
      await client.close();
    },
  };
};

/**
 * Connect to the server, list its tools, and return them. The connection is
 * ALWAYS closed in a finally — even if connect or listTools throws.
 *
 * NOTE: the server's tool-list-change notification is never subscribed; only the
 * user allowlist is authoritative (H-11). Annotations on the returned tools are
 * never read here.
 */
export async function listServerTools(
  cfg: McpServerConfig,
  factory: McpConnectionFactory = defaultConnectionFactory,
): Promise<McpToolDescriptor[]> {
  const conn = factory(cfg);
  try {
    await conn.connect();
    const { tools } = await conn.listTools();
    return tools;
  } finally {
    // Best-effort close on every path (Pitfall #4 — never leak the subprocess).
    try {
      await conn.close();
    } catch {
      /* swallow close errors — the primary outcome/throw already propagated */
    }
  }
}

/**
 * Execute a single tool by name. Invokes the SDK with the `arguments` key (NOT
 * `args` — Pitfall #1) using the exact immutable payload supplied by the caller.
 * The raw result is returned; the connection is ALWAYS closed in a finally.
 *
 * A thrown error here is a transport/protocol failure (distinct from a tool that
 * ran and reported `isError === true` — see extractToolOutput).
 */
export async function callServerTool(
  cfg: McpServerConfig,
  name: string,
  toolArguments: Record<string, unknown>,
  factory: McpConnectionFactory = defaultConnectionFactory,
): Promise<McpToolResult> {
  const conn = factory(cfg);
  try {
    await conn.connect();
    return await conn.callTool({ name, arguments: toolArguments });
  } finally {
    try {
      await conn.close();
    } catch {
      /* swallow close errors — the primary outcome/throw already propagated */
    }
  }
}
