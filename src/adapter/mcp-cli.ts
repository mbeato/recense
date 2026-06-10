/**
 * mcp-cli — stdio MCP server adapter (Phase 11, MCP-01/MCP-02).
 *
 * Entry point: `brain mcp --db <path>` (dispatched via spawnScript from brain.ts so the
 * `require.main === module` guard fires in the child — a bare require() would never start
 * the server because require.main would stay brain.js).
 *
 * Exposes exactly three snake_case tools (D-01/D-03/D-04):
 *   memory_search — IMPLEMENTED here: embed query → RetrievalEngine.retrieve(cueVec) →
 *                   structured provenance rows. LLM-free (embedding only, zero generation
 *                   calls — D-08). Read-only: no lock acquisition (spec §8).
 *   memory_add    — registered with schema; handler stub until Plan 03.
 *   memory_ask    — registered with schema; handler stub until Plan 03 (always registered, D-04).
 *
 * Design invariants:
 *  - One DB handle for the server lifetime; one session ID (UUID) per server process
 *    (RESEARCH Session-ID recommendation — consumed by Plan 03 writes).
 *  - All logging goes to LOG_PATH (file only) — stdout/stderr belong to the stdio transport.
 *  - createBrainMcpServer({ dbPath, provider? }) is exported for in-process tests; tests
 *    inject MockModelProvider and stay offline (D-11/D-12).
 *
 * Threat mitigations:
 *  - T-11-02: query treated as data only (embedded, never shell-interpolated or eval'd);
 *    bounded to MAX_QUERY_BYTES before embedding (mirrors HybridResponder).
 *  - T-11-04: resolveDbPath(..., { fallbackToDefault: false }) — no silent default DB.
 *  - T-11-06: handlers catch errors and return { isError: true, content } text; raw
 *    errors/stack traces never cross the transport.
 */
import { appendFileSync } from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever } from '../retrieval/topk';
import { AllocationGate } from '../gate/allocation-gate';
import { DefaultModelProvider } from '../model/provider';
import type { ModelProvider } from '../model/provider';
import { RetrievalEngine } from '../retrieval/engine';
import { RecallEngine } from '../recall';
import { HybridResponder } from '../responder';
import { IngestionPipeline } from '../ingest/pipeline';
import { NoopActivationTraceSink } from '../viz/activation-sink';
import { resolveDbPath } from './runtime-config';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';

const LOG_PATH = '/tmp/brain-memory-mcp.log';

/** Append a timestamped line to the log file (never stdout — the transport owns it). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] mcp-cli: ${msg}\n`);

/** T-11-02: bound the query before embedding (mirrors HybridResponder MAX_QUERY_BYTES). */
const MAX_QUERY_BYTES = 4_000;

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
 */
export async function createBrainMcpServer(
  opts: CreateBrainMcpServerOptions,
): Promise<McpServer> {
  // ── 1. Open DB and initialize schema (one handle per server lifetime) ────────
  const db = new Database(opts.dbPath);
  initSchema(db);
  opts.onDbOpen?.(db);

  const config = { ...DEFAULT_CONFIG, dbPath: opts.dbPath };

  // ── 2. Wire the full collaborator graph (same as watcher-cli.ts) ─────────────
  const episodes = new EpisodicStore(db, realClock, config);
  const store    = new SemanticStore(db, realClock, config);
  const strength = new StrengthDecayManager(db, realClock, config);
  const retriever = new CandidateRetriever(db);
  const gate     = new AllocationGate(config);

  // M-7 overlay pattern: generate+judge follow provider env overrides; embed stays base.
  // Only constructed when no provider is injected (tests inject MockModelProvider).
  const generateConfig = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_EXTRACTOR_PROVIDER') };
  const judgeConfig    = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_JUDGE_PROVIDER') };
  const provider = opts.provider
    ?? new DefaultModelProvider({ generateConfig, judgeConfig, embedConfig: config });

  // No viz in the MCP surface — Noop sink, zero per-call trace cost (D-97).
  const traceSink = new NoopActivationTraceSink();

  const retrieval = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate, traceSink);
  const recall    = new RecallEngine(db, realClock, config, provider, retriever, store, strength, episodes, traceSink);
  const responder = new HybridResponder(realClock, config, provider, retrieval, recall, episodes);
  const pipeline  = new IngestionPipeline(gate, episodes);

  // One session ID per server process (RESEARCH Session-ID recommendation, A3).
  const sessionId = randomUUID();

  // Plan 03 consumes these in the memory_add / memory_ask handlers; referenced here so
  // the wiring is complete (and type-checked) from day one.
  void responder; void pipeline; void sessionId; void strength;

  // ── 3. Server + exactly three tools (D-01/D-03; memory_ask always registered, D-04) ──
  const server = new McpServer(
    { name: 'brain-memory', version: '0.1.0' },
    {
      instructions:
        'brain-memory tools: memory_search (LLM-free semantic retrieval), memory_add ' +
        '(record a fact/observation), memory_ask (question answering over memory). ' +
        'Writes land as episodes; abstraction/consolidation runs in the hourly sleep pass, not inline.',
    },
  );

  server.registerTool(
    'memory_search',
    {
      description:
        'Search the memory graph. LLM-free retrieval (embedding-based semantic match, no generation). ' +
        'Returns matching facts with provenance (origin, score, last-updated time).',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        results: z.array(z.object({
          value: z.string(),
          origin: z.string(),
          score: z.number(),
          lastUpdatedMs: z.number(),
        })),
      }),
    },
    async ({ query }) => {
      try {
        // T-11-02: query is data only — bounded, embedded, never interpolated.
        const bounded = query.slice(0, MAX_QUERY_BYTES);
        // A1: one embedding call, zero generation calls (D-08). This mirrors the
        // existing hook recall path — embedding is not generation.
        const [cueVec] = await provider.embed([bounded]);
        if (!cueVec) {
          return { content: [{ type: 'text' as const, text: '[]' }], structuredContent: { results: [] } };
        }
        // Read-only path: NO lock acquisition (spec §8); retrieve never writes.
        const { results } = retrieval.retrieve(cueVec);
        const rows = results.map(r => {
          const node = store.getNode(r.id);
          return {
            value: r.value,
            origin: node?.origin ?? 'unknown',
            score: r.score,
            lastUpdatedMs: node?.last_access ?? 0,
          };
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(rows) }],
          structuredContent: { results: rows },
        };
      } catch (err) {
        // T-11-06: log the detail file-side; return a generic error text — never a stack.
        log(`memory_search error: ${err}`);
        return { isError: true, content: [{ type: 'text' as const, text: 'memory_search failed' }] };
      }
    },
  );

  server.registerTool(
    'memory_add',
    {
      description:
        'Record a fact or observation into memory. Stored as an episode; consolidation ' +
        'into the semantic graph happens in the hourly sleep pass.',
      // D-05: 'inferred' is intentionally NOT in the enum — clients can never mint
      // inferred-origin content (self-confirmation guard).
      inputSchema: z.object({
        content: z.string(),
        origin: z.enum(['asserted_by_user', 'observed']).optional(),
      }),
      outputSchema: z.object({ status: z.string(), message: z.string() }),
    },
    async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'memory_add not yet implemented (Plan 03)' }],
    }),
  );

  server.registerTool(
    'memory_ask',
    {
      description:
        'Ask the memory a question. Answers from stored facts first, schema-based inference ' +
        'as fallback; honest null when neither path answers.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        answer: z.string().nullable(),
        origin: z.enum(['fact', 'inferred', 'none']),
      }),
    },
    async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'memory_ask not yet implemented (Plan 03)' }],
    }),
  );

  return server;
}

// ─── stdio entry point — fires ONLY when spawned as the main module ────────────
if (require.main === module) {
  (async () => {
    // T-11-04: explicit DB path required — never silently open a default DB.
    const dbPath = resolveDbPath(process.argv, { fallbackToDefault: false });
    if (!dbPath) {
      // Lock-free early exit (no lock is ever held on this path).
      log('No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var) — exiting');
      process.exit(0);
    }

    let dbHandle: Database.Database | undefined;
    const server = await createBrainMcpServer({ dbPath, onDbOpen: db => { dbHandle = db; } });

    process.on('exit', () => { try { dbHandle?.close(); } catch { /* best-effort */ } });
    process.on('SIGINT',  () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));

    await server.connect(new StdioServerTransport());
    log(`server connected on stdio (db: ${dbPath})`);
  })().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] mcp-cli FATAL: ${err}\n`);
    process.exit(1);
  });
}
