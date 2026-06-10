/**
 * mcp-cli — stdio MCP server adapter (Phase 11, MCP-01/MCP-02).
 *
 * Entry point: `brain mcp --db <path>` (dispatched via spawnScript from brain.ts so the
 * `require.main === module` guard fires in the child — a bare require() would never start
 * the server because require.main would stay brain.js).
 *
 * Exposes exactly three snake_case tools (D-01/D-03/D-04):
 *   memory_search — embed query → RetrievalEngine.retrieve(cueVec) → structured provenance
 *                   rows. LLM-free (embedding only, zero generation calls — D-08).
 *                   Read-only: no lock acquisition (spec §8).
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
import { acquireLockWithRetry, releaseLock } from './lockfile';

const LOG_PATH = '/tmp/brain-memory-mcp.log';

/** Append a timestamped line to the log file (never stdout — the transport owns it). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] mcp-cli: ${msg}\n`);

/** T-11-02: bound the query before embedding (mirrors HybridResponder MAX_QUERY_BYTES). */
const MAX_QUERY_BYTES = 4_000;

/** T-11-03: bound memory_add content at the handler boundary (DoS cap). */
const MAX_CONTENT_CHARS = 8_000;

/**
 * D-05 origin clamp (defense in depth behind the zod enum, T-11-01): a client can
 * never mint inferred-origin content — 'inferred' would let an agent's own output
 * strengthen a fact (self-confirmation, spec §4). Returns 'asserted_by_user' ONLY
 * on an exact match; everything else (incl. 'inferred', unknown values, undefined)
 * clamps to 'observed'. Exported for direct unit testing.
 */
export function validateOrigin(raw: string | undefined): 'observed' | 'asserted_by_user' {
  return raw === 'asserted_by_user' ? 'asserted_by_user' : 'observed';
}

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
    async ({ content, origin: rawOrigin }) => {
      // ── Validate BEFORE the lock (T-11-05: early exits must be lock-free) ──
      // T-11-03: DoS bound at the handler boundary; redactSecrets runs inside recordEvent.
      const bounded = content.slice(0, MAX_CONTENT_CHARS);
      // D-05: clamp origin — 'inferred' (or anything unknown) can never reach the engine.
      const origin = validateOrigin(rawOrigin);

      // Single-writer lock per call: coexists with the hourly sleep pass and the
      // always-on watcher. Lock-fail returns to the CLIENT — never process.exit
      // (the server must keep serving; T-11-05).
      if (!(await acquireLockWithRetry())) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: 'Memory busy (consolidation in progress); retry in a moment.',
          }],
        };
      }
      try {
        // Episodic path ONLY (MCP-03): recordEvent → gate.score → episode append.
        // No graph node is ever created or mutated here — the sleep pass remains
        // the sole graph writer. Flat source='mcp' (D-06), no dedup key (D-07).
        pipeline.recordEvent({
          content: bounded,
          role: 'user',
          origin,
          sessionId,
          source: 'mcp',
          externalId: null,
        });
        // D-10: honest deferred ack — searchable only after the next sleep pass.
        const ack = {
          status: 'queued',
          message: 'stored as episode; becomes searchable after the next consolidation pass (runs hourly)',
        };
        return {
          content: [{
            type: 'text' as const,
            text: 'Stored as episode; becomes searchable after the next consolidation pass (runs hourly).',
          }],
          structuredContent: ack,
        };
      } catch (err) {
        // T-11-06: never rethrow across the transport — log file-side, generic text out.
        log(`memory_add error: ${err}`);
        return { isError: true, content: [{ type: 'text' as const, text: 'memory_add failed' }] };
      } finally {
        releaseLock();
      }
    },
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
    async ({ query }) => {
      // ── Validate BEFORE the lock (T-11-05: early exits must be lock-free) ──
      // T-11-02: query is data only — bounded, embedded/prompted, never interpolated.
      const bounded = query.slice(0, MAX_QUERY_BYTES);

      // The responder's facts-first branch appends ONE origin='inferred', salience=0
      // episode — that is a write, so the single-writer lock is required (coexists
      // with the hourly sleep pass and the always-on watcher).
      if (!(await acquireLockWithRetry())) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Memory busy; retry in a moment.' }],
        };
      }
      try {
        // D-04 graceful no-key: respond() is internally safe-null — a missing LLM
        // key (or any throw) yields { reply: null, origin: 'none' }, never a crash.
        const r = await responder.respond(bounded, sessionId);
        // D-09 mapping: reply → answer, origin → origin, drop episodeId. Channel
        // presentation stays OUT of MCP: when origin is 'none' the responder's
        // reply is its Telegram honest-no-answer phrasing — the MCP contract is a
        // structured null instead. No inferred-marker text suffix is added here
        // either; the raw structured origin carries that signal.
        const out = { answer: r.origin === 'none' ? null : r.reply, origin: r.origin };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out) }],
          structuredContent: out,
        };
      } catch (err) {
        // T-11-06: defensive — never rethrow across the transport.
        log(`memory_ask error: ${err}`);
        return { isError: true, content: [{ type: 'text' as const, text: 'memory_ask failed' }] };
      } finally {
        releaseLock();
      }
    },
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
