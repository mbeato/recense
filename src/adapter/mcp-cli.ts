/**
 * mcp-cli — stdio MCP server adapter (Phase 11, MCP-01/MCP-02).
 *
 * Entry point: `brain mcp --db <path>` (dispatched via spawnScript from brain.ts so the
 * `require.main === module` guard fires in the child — a bare require() would never start
 * the server because require.main would stay brain.js).
 *
 * Exposes exactly three snake_case tools (D-01/D-03/D-04):
 *   memory_search — embed query → retriever.topk(cueVec, SEARCH_TOP_K) → drop hits below
 *                   SEARCH_SCORE_FLOOR → ranked structured provenance rows. LLM-free
 *                   (embedding only, zero generation calls — D-08). Read-only: no lock
 *                   acquisition (spec §8). Live nodes only (topk excludes tombstoned).
 *   memory_add    — episodic-only write via IngestionPipeline.recordEvent (source='mcp',
 *                   externalId=null — D-06/D-07). NEVER touches the graph (MCP-03: the
 *                   sleep pass stays the sole graph writer). Origin clamped via
 *                   validateOrigin (D-05). Honest deferred ack (D-10). Per-call lock.
 *   memory_ask    — HybridResponder.respond → { answer, origin } (D-09); no-answer is a
 *                   structured { answer: null, origin: 'none' } — Telegram channel phrasing
 *                   and text markers stay out of MCP. Always registered (D-04); safe-null on
 *                   a missing LLM key. Per-call lock (facts-first branch writes one
 *                   inferred/salience-0 episode).
 *
 * Design invariants:
 *  - One DB handle for the server lifetime; one session ID (UUID) per server process
 *    (RESEARCH Session-ID recommendation — consumed by Plan 03 writes).
 *  - All logging goes to LOG_PATH (file only) — stdout/stderr belong to the stdio transport.
 *  - createBrainMcpServer({ dbPath, provider? }) is exported for in-process tests; tests
 *    inject MockModelProvider and stay offline (D-11/D-12).
 *
 * Phase 12 refactor (Plan 01, D-02):
 *  - Operation logic extracted to src/adapter/memory-ops.ts (wireMemoryEngine /
 *    registerMemoryTools). This module delegates to the shared core so the HTTP surface
 *    (Plan 02) reuses the same operation code without duplication.
 *  - Behavior is unchanged: same tool names, descriptions, schemas, content shapes, source
 *    tag ('mcp'), lock discipline, and error handling (Phase 11 regression gate preserved).
 *
 * Threat mitigations:
 *  - T-11-02: query treated as data only (embedded, never shell-interpolated or eval'd);
 *    bounded to MAX_QUERY_CHARS before embedding (mirrors HybridResponder).
 *  - T-11-04: resolveDbPath(..., { fallbackToDefault: false }) — no silent default DB.
 *  - T-11-06: handlers catch errors and return { isError: true, content } text; raw
 *    errors/stack traces never cross the transport.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ModelProvider } from '../model/provider';
import { resolveDbPath } from './runtime-config';
import { wireMemoryEngine, registerMemoryTools } from './memory-ops';

// Re-export validateOrigin so that existing importers (tests, downstream code) still resolve it
// without needing to update their import path.
export { validateOrigin } from './memory-ops';

const LOG_PATH = '/tmp/brain-memory-mcp.log';

export interface CreateBrainMcpServerOptions {
  dbPath: string;
  /** Tests inject MockModelProvider here; omitted → DefaultModelProvider (production). */
  provider?: ModelProvider;
  /**
   * CLI-only hook: receives the factory-owned DB handle so the process exit handler
   * can close it. Tests omit this — the handle is GC'd with the server.
   */
  onDbOpen?: (db: Database.Database) => void;
}

/**
 * Build the brain-memory MCP server: open ONE DB handle for the server lifetime,
 * wire the existing engine collaborator graph (same wiring as watcher-cli.ts), and
 * register exactly three tools. Importing this module never starts a server —
 * the stdio entry point below is guarded by `require.main === module`.
 *
 * Delegates to wireMemoryEngine + registerMemoryTools (shared core, D-02) so the
 * HTTP surface (Plan 02) uses the same operation code without duplication.
 */
export async function createBrainMcpServer(
  opts: CreateBrainMcpServerOptions,
): Promise<McpServer> {
  // D-02: delegate to the shared core. NO separateReadHandle — stdio keeps the
  // single-handle-per-lifetime behavior documented in this module's header (A3).
  const { ops } = await wireMemoryEngine({
    dbPath: opts.dbPath,
    provider: opts.provider,
    source: 'mcp',
    onDbOpen: opts.onDbOpen,
  });

  const server = new McpServer(
    { name: 'brain-memory', version: '0.1.0' },
    {
      instructions:
        'brain-memory tools: memory_search (LLM-free semantic retrieval), memory_add ' +
        '(record a fact/observation), memory_ask (question answering over memory). ' +
        'Writes land as episodes; abstraction/consolidation runs in the hourly sleep pass, not inline.',
    },
  );

  // Register the three tools via the shared core (same names, descriptions, schemas, shapes).
  registerMemoryTools(server, ops);

  return server;
}

// ─── stdio entry point — fires ONLY when spawned as the main module ────────────
if (require.main === module) {
  (async () => {
    // T-11-04: explicit DB path required — never silently open a default DB.
    const dbPath = resolveDbPath(process.argv, { fallbackToDefault: false });
    if (!dbPath) {
      // Lock-free early exit (no lock is ever held on this path).
      appendFileSync(LOG_PATH, `[${new Date().toISOString()}] mcp-cli: No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var) — exiting\n`);
      process.exit(0);
    }

    let dbHandle: Database.Database | undefined;
    const server = await createBrainMcpServer({ dbPath, onDbOpen: db => { dbHandle = db; } });

    process.on('exit', () => { try { dbHandle?.close(); } catch { /* best-effort */ } });
    process.on('SIGINT',  () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));

    await server.connect(new StdioServerTransport());
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] mcp-cli: server connected on stdio (db: ${dbPath})\n`);
  })().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] mcp-cli FATAL: ${err}\n`);
    process.exit(1);
  });
}
