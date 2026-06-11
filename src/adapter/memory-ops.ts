/**
 * memory-ops — shared memory operation core (Phase 12, D-02).
 *
 * Extracted from mcp-cli.ts so that both the stdio MCP surface and the HTTP serving
 * surface (Plan 02) call the SAME operation code against ONE engine instance. Prevents
 * ~150 lines of duplication and ensures the inferred-origin self-confirmation guard
 * (D-05, spec §4) is enforced on every surface.
 *
 * Exports:
 *   wireMemoryEngine  — open DB handle(s) + wire collaborator graph + return operation set
 *   registerMemoryTools — register memory_search/memory_add/memory_ask on an McpServer
 *   validateOrigin    — D-05 origin clamp (also re-exported from mcp-cli.ts for back-compat)
 *   MemoryBusyError   — thrown by add/ask when acquireLockWithRetry returns false
 *
 * Threat mitigations:
 *  - T-12-01: validateOrigin clamp survives extraction — 'inferred'/unknown → 'observed'.
 *  - T-12-02: add/ask acquire acquireLockWithRetry and release in finally; sleep pass
 *    stays sole graph writer (episodic-only recordEvent, no graph mutation).
 */
import { appendFileSync } from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';
import { acquireLockWithRetry, releaseLock } from './lockfile';

const LOG_PATH = '/tmp/brain-memory-ops.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] memory-ops: ${msg}\n`);

/**
 * T-12-02 / T-11-02: bound the query before embedding (mirrors HybridResponder).
 * IN-03: String.prototype.slice counts UTF-16 code units, NOT bytes — a fully
 * multibyte query can reach ~4x this in UTF-8 bytes at the embedding API. The
 * looser bound is accepted; the name says CHARS so it is not mistaken for a byte cap.
 */
const MAX_QUERY_CHARS = 4_000;

/** T-11-03: bound memory_add content at the handler boundary (DoS cap). */
const MAX_CONTENT_CHARS = 8_000;

/**
 * Max ranked results memory_search returns. Search wants more breadth than the
 * judge's candidateK (5); bounded to keep the response size sane.
 */
const SEARCH_TOP_K = 10;

/**
 * Minimum cosine for a hit to surface in memory_search. Aligns with the existing
 * "extremely dissimilar" cutpoint (unrelatedSimilarityThreshold = 0.3) and sits
 * well below deletedSimilarityThreshold (0.7): real queries score 0.4–0.6
 * (UAT-measured — "telegram" best 0.485) so they surface, while genuine noise
 * (<0.3) is excluded. Owned by the search path — deliberately NOT read from
 * config and NOT to be conflated with deletedSimilarityThreshold, whose D-29
 * deleted-classification semantics are a separate concern.
 */
const SEARCH_SCORE_FLOOR = 0.3;

/**
 * D-05 origin clamp (defense in depth behind the zod enum, T-12-01): a client can
 * never mint inferred-origin content — 'inferred' would let an agent's own output
 * strengthen a fact (self-confirmation, spec §4). Returns 'asserted_by_user' ONLY
 * on an exact match; everything else (incl. 'inferred', unknown values, undefined)
 * clamps to 'observed'. Exported for direct unit testing and re-exported from mcp-cli.ts.
 */
export function validateOrigin(raw: string | undefined): 'observed' | 'asserted_by_user' {
  return raw === 'asserted_by_user' ? 'asserted_by_user' : 'observed';
}

/**
 * Thrown by add() and ask() when acquireLockWithRetry returns false — the DB is
 * locked by a live sleep pass or concurrent writer. Callers map this to a
 * surface-appropriate busy response (MCP: isError content; HTTP: 503).
 */
export class MemoryBusyError extends Error {
  constructor() {
    super('Memory busy; retry in a moment.');
    this.name = 'MemoryBusyError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchRow {
  value: string;
  origin: string;
  score: number;
  lastUpdatedMs: number;
}

export interface MemoryOps {
  /** One UUID per engine instance (RESEARCH Session-ID recommendation, A3). */
  sessionId: string;
  /**
   * LLM-free read path: embed query → topk → filter → map to rows.
   * NO lock acquisition (spec §8 — read-only path).
   */
  search(query: string): Promise<SearchRow[]>;
  /**
   * Episodic-only write via IngestionPipeline.recordEvent. Acquires the single-
   * writer lock per call; throws MemoryBusyError on lock failure. try/finally
   * releases the lock (T-12-02). Returns deferred ack (D-10, honest).
   */
  add(content: string, rawOrigin?: string): Promise<{ status: string; message: string }>;
  /**
   * HybridResponder.respond → { answer, origin }. Acquires lock (the facts-first
   * branch writes one inferred episode); throws MemoryBusyError on lock failure.
   * try/finally releases. Maps no-answer to { answer: null, origin: 'none' }.
   */
  ask(query: string): Promise<{ answer: string | null; origin: 'fact' | 'inferred' | 'none' }>;
}

export interface WireMemoryEngineOpts {
  dbPath: string;
  /** Tests inject MockModelProvider; omitted → DefaultModelProvider (production). */
  provider?: ModelProvider;
  /**
   * Source tag written into every recordEvent call so the graph tracks which
   * surface created the episode (D-06 one-adapter-one-source). stdio MCP passes
   * 'mcp'; HTTP surface passes 'http'.
   */
  source: string;
  /**
   * When true, open an additional `{ readonly: true }` DB handle exclusively for
   * the search read path (D-95: read-only handle prevents any accidental write from
   * the search code path). The write handle still backs add/ask. When false/absent,
   * search uses the writable handle's retriever/store — matches current stdio MCP
   * behavior (one handle per server lifetime).
   */
  separateReadHandle?: boolean;
  /**
   * CLI-only hook: receives the factory-owned writable DB handle so the process
   * exit handler can close it. Tests omit this.
   */
  onDbOpen?: (db: Database.Database) => void;
}

// ---------------------------------------------------------------------------
// wireMemoryEngine
// ---------------------------------------------------------------------------

/**
 * Open DB handle(s), wire the full engine collaborator graph (same as watcher-cli.ts
 * and mcp-cli.ts), and return plain-data operation functions plus a close().
 *
 * The operations are NOT MCP-shaped — they return plain TypeScript objects.
 * registerMemoryTools wraps them in the MCP { content, structuredContent } envelopes.
 */
export function wireMemoryEngine(
  opts: WireMemoryEngineOpts,
): Promise<{ ops: MemoryOps; close: () => void }> {
  // ── 1. Open writable handle + initialize schema ───────────────────────────
  const writeDb = new Database(opts.dbPath);
  initSchema(writeDb);
  opts.onDbOpen?.(writeDb);

  // ── 2. Optionally open a dedicated read-only handle for the search path ───
  // D-95: a read-only handle prevents any accidental write from the search code
  // path. The HTTP surface requests this; the stdio MCP surface omits it to
  // preserve the single-handle-per-lifetime behavior documented in its header.
  let readDb: Database.Database | null = null;
  let searchRetriever: CandidateRetriever;
  let searchStore: SemanticStore;

  if (opts.separateReadHandle) {
    readDb = new Database(opts.dbPath, { readonly: true });
    const readConfig = { ...DEFAULT_CONFIG, dbPath: opts.dbPath };
    searchRetriever = new CandidateRetriever(readDb);
    searchStore = new SemanticStore(readDb, realClock, readConfig);
  }

  // ── 3. Wire the full collaborator graph against the writable handle ───────
  // Exact wiring as in mcp-cli.ts and watcher-cli.ts (copied verbatim, M-7 overlay).
  const config = { ...DEFAULT_CONFIG, dbPath: opts.dbPath };

  const episodes  = new EpisodicStore(writeDb, realClock, config);
  const store     = new SemanticStore(writeDb, realClock, config);
  const strength  = new StrengthDecayManager(writeDb, realClock, config);
  const retriever = new CandidateRetriever(writeDb);
  const gate      = new AllocationGate(config);

  // M-7 overlay: generate+judge follow provider env overrides; embed stays base.
  // Only constructed when no provider is injected (tests inject MockModelProvider).
  const generateConfig = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_EXTRACTOR_PROVIDER') };
  const judgeConfig    = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_JUDGE_PROVIDER') };
  const provider = opts.provider
    ?? new DefaultModelProvider({ generateConfig, judgeConfig, embedConfig: config });

  // No viz in the MCP/HTTP surfaces — Noop sink, zero per-call trace cost (D-97).
  const traceSink = new NoopActivationTraceSink();

  const retrieval = new RetrievalEngine(writeDb, realClock, config, retriever, store, strength, gate, traceSink);
  const recall    = new RecallEngine(writeDb, realClock, config, provider, retriever, store, strength, episodes, traceSink);
  const responder = new HybridResponder(realClock, config, provider, retrieval, recall, episodes);
  const pipeline  = new IngestionPipeline(gate, episodes);

  // One session ID per engine instance (RESEARCH Session-ID recommendation, A3).
  const sessionId = randomUUID();

  // When no separate read handle, search uses the writable handle's retriever/store.
  if (!opts.separateReadHandle) {
    searchRetriever = retriever;
    searchStore = store;
  }

  // ── 4. Plain-data operation functions ────────────────────────────────────

  async function search(query: string): Promise<SearchRow[]> {
    // T-11-02/T-12-02: query is data only — bounded, embedded, never interpolated.
    const bounded = query.slice(0, MAX_QUERY_CHARS);
    // A1: one embedding call, zero generation calls (D-08). LLM-free read path.
    const [cueVec] = await provider.embed([bounded]);
    if (!cueVec) return [];
    // Read-only path: NO lock acquisition (spec §8); topk never writes.
    const hits = searchRetriever!.topk(cueVec, SEARCH_TOP_K);
    return hits
      .filter(hit => hit.score >= SEARCH_SCORE_FLOOR)
      .flatMap(hit => {
        // Defensive: skip any id whose node row vanished between scan and lookup.
        const node = searchStore!.getNode(hit.id);
        if (!node) return [];
        return [{
          value: node.value,
          origin: node.origin,
          score: hit.score,
          lastUpdatedMs: node.last_access,
        }];
      });
  }

  async function add(content: string, rawOrigin?: string): Promise<{ status: string; message: string }> {
    // T-11-03: DoS bound at handler boundary.
    const bounded = content.slice(0, MAX_CONTENT_CHARS);
    // D-05: clamp origin — 'inferred' (or anything unknown) can never reach the engine.
    const origin = validateOrigin(rawOrigin);

    // Single-writer lock per call (T-12-02): coexists with the hourly sleep pass
    // and the always-on watcher. Lock-fail throws MemoryBusyError — callers surface
    // an appropriate busy response for their transport.
    if (!(await acquireLockWithRetry())) {
      throw new MemoryBusyError();
    }
    try {
      // Episodic path ONLY (MCP-03): recordEvent → gate.score → episode append.
      // No graph node is ever created or mutated here — the sleep pass remains
      // the sole graph writer. source from opts (D-06), no dedup key (D-07).
      pipeline.recordEvent({
        content: bounded,
        role: 'user',
        origin,
        sessionId,
        source: opts.source,
        externalId: null,
      });
      // D-10: honest deferred ack — searchable only after the next sleep pass.
      return {
        status: 'queued',
        message: 'stored as episode; becomes searchable after the next consolidation pass (runs hourly)',
      };
    } finally {
      releaseLock();
    }
  }

  async function ask(query: string): Promise<{ answer: string | null; origin: 'fact' | 'inferred' | 'none' }> {
    // T-11-02: query is data only — bounded before any LLM call.
    const bounded = query.slice(0, MAX_QUERY_CHARS);

    // The responder's facts-first branch appends ONE origin='inferred', salience=0
    // episode — that is a write, so the single-writer lock is required.
    if (!(await acquireLockWithRetry())) {
      throw new MemoryBusyError();
    }
    try {
      // D-04 graceful no-key: respond() is internally safe-null — a missing LLM key
      // yields { reply: null, origin: 'none' }, never a crash.
      const r = await responder.respond(bounded, sessionId);
      // D-09 mapping: reply → answer, origin → origin. When origin is 'none' the
      // responder's reply is its Telegram honest-no-answer phrasing — the shared
      // core contract is a structured null instead.
      return { answer: r.origin === 'none' ? null : r.reply, origin: r.origin };
    } finally {
      releaseLock();
    }
  }

  // ── 5. close() ───────────────────────────────────────────────────────────
  function close(): void {
    if (readDb) {
      try { readDb.close(); } catch { /* best-effort */ }
    }
    try { writeDb.close(); } catch { /* best-effort */ }
  }

  return Promise.resolve({ ops: { sessionId, search, add, ask }, close });
}

// ---------------------------------------------------------------------------
// registerMemoryTools
// ---------------------------------------------------------------------------

/**
 * Register memory_search / memory_add / memory_ask on `server`, mapping ops results
 * to MCP { content, structuredContent } envelopes with the EXACT same names,
 * descriptions, zod schemas, and content text as Phase 11 mcp-cli.ts.
 *
 * Error handling:
 *  - MemoryBusyError → { isError: true, content: [busy text] } (two distinct strings
 *    preserved: add uses 'Memory busy (consolidation in progress)...', ask uses
 *    'Memory busy; retry in a moment.')
 *  - Any other error → log to LOG_PATH + generic 'memory_X failed' isError text
 *    (T-11-06: never rethrow across the transport).
 */
export function registerMemoryTools(server: McpServer, ops: MemoryOps): void {
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
        const rows = await ops.search(query);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(rows) }],
          structuredContent: { results: rows },
        };
      } catch (err) {
        // T-11-06: log detail file-side; return generic error — never a stack.
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
      try {
        const ack = await ops.add(content, rawOrigin);
        return {
          content: [{
            type: 'text' as const,
            text: 'Stored as episode; becomes searchable after the next consolidation pass (runs hourly).',
          }],
          structuredContent: ack,
        };
      } catch (err) {
        if (err instanceof MemoryBusyError) {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: 'Memory busy (consolidation in progress); retry in a moment.',
            }],
          };
        }
        // T-11-06: log file-side; generic text out.
        log(`memory_add error: ${err}`);
        return { isError: true, content: [{ type: 'text' as const, text: 'memory_add failed' }] };
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
      try {
        const out = await ops.ask(query);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out) }],
          structuredContent: out,
        };
      } catch (err) {
        if (err instanceof MemoryBusyError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'Memory busy; retry in a moment.' }],
          };
        }
        // T-11-06: defensive — never rethrow across the transport.
        log(`memory_ask error: ${err}`);
        return { isError: true, content: [{ type: 'text' as const, text: 'memory_ask failed' }] };
      }
    },
  );
}
