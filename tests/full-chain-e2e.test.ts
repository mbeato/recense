/**
 * tests/full-chain-e2e.test.ts — quick task 260809-2qe.
 *
 * Closes the v10.0 milestone-audit WARNING (.planning/v10.0-MILESTONE-AUDIT.md §3 seam 8):
 * the full E2E chain (gmail raw bytes -> normalize/strip -> ingest pipeline -> consolidation
 * -> proposal emission -> proposal store -> GET /v1/proposals -> Telegram approval) was
 * proven only by COMPOSITION across three separate files
 * (tests/drift-belief-correction-e2e.test.ts, tests/action-proposal-emission.test.ts,
 * tests/telegram-belief-e2e.test.ts / tests/proposal-reference-e2e.test.ts) — a regression
 * exactly at the emit->store join could slip between the composed suites without any single
 * test catching it. This file drives one fixture Gmail message's raw bytes all the way to a
 * Telegram-side approval that settles the server-side proposal row, in one continuous
 * `it`, so the join is a first-class assertion instead of an inference across suite
 * boundaries.
 *
 * Every helper below is COPIED, not imported, per the existing e2e files' documented "each
 * consumer keeps its own copy" convention (MarkerProvider is not exported anywhere):
 *  - makeTempDbPath / getFreePort / RECENSE_LOCK_PATH handling — tests/proposal-reference-e2e.test.ts
 *  - constVec / constEmbedFn / MarkerProvider / swapProvider / seedNode / seedEntity /
 *    findNodeIdByValue / getNodeById / makeConsolidatorWithProposalSink — tests/action-proposal-emission.test.ts
 *  - FakeGmailFetcher shape — tests/gmail-adapter.test.ts, extended to a scripted queue (P-5)
 *  - makeLlmFreeProvider / getProposalStatus / assertDb split — tests/telegram-belief-e2e.test.ts
 *
 * Seams that are REAL (never mocked) in this file: GmailAdapter (with an injected fake
 * GmailFetcher only — no network), runPullPhase, IngestionPipeline, AllocationGate,
 * Consolidator.consolidate() (real graph mutation + drift + emission logic),
 * SQLiteConsolidationSink, SQLiteActionProposalSink over a REAL ActionProposalStore,
 * createBrainHttpServer, the real Telegram belief-bridge (runBeliefBridgePass,
 * handleBeliefProposalAction, decodeBeliefCallbackData). Seams that stay STUBBED, exactly as
 * the composed suites already stub them: LLM calls, via the content-keyed MarkerProvider
 * offline (extraction + judge) and a fail-if-called ModelProvider online (the HTTP server's
 * provider) — proving the online path (GET /v1/proposals, the approve POST) never invokes
 * an LLM.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import type { ModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { MockModelProvider } from '../src/model/provider';
import { SQLiteConsolidationSink, type ConsolidationSink } from '../src/consolidation/sink';
import { EventStore } from '../src/db/event-store';
import { newId } from '../src/lib/hash';
import type { NodeRow, EpisodeRow } from '../src/lib/types';
import {
  SQLiteActionProposalSink,
  PROPOSAL_CONTRACT_VERSION,
  proposalId,
  type ActionProposalSink,
} from '../src/consolidation/action-proposal-sink';
import { ActionProposalStore, type ActionProposalRecord } from '../src/db/action-proposal-store';
import { AllocationGate, IngestionPipeline } from '../src/ingest/pipeline';
import { GmailAdapter, parseEmailDate, type RawGmailMessage, type GmailFetcher } from '../src/source/gmail-adapter';
import { COLLAPSED_GMAIL_PROVENANCE_KEY } from '../src/source/provenance-key';
import { runPullPhase } from '../src/adapter/ingest-cli';
import { createBrainHttpServer, type BrainHttpServer } from '../src/adapter/serve-cli';
import { createBeliefProposalClient } from '../clients/telegram/belief-proposal-client';
import { runBeliefBridgePass, handleBeliefProposalAction } from '../clients/telegram/belief-bridge';
import { decodeBeliefCallbackData } from '../clients/telegram/push-codec';
import { MockTelegramTransport } from '../clients/telegram/transport';
import { getProposal } from '../clients/telegram/proposal-store';
import type { MemoryClient } from '../clients/telegram/memory-client';

// ---------------------------------------------------------------------------
// Embed helper — constant vector for every text (cosine 1.0 between any two embedded texts).
// Copied from tests/action-proposal-emission.test.ts.
// ---------------------------------------------------------------------------

function constVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  v[0] = 1.0;
  return v;
}

function constEmbedFn(dims: number): (_t: string) => Float32Array {
  return (_t: string) => constVec(dims);
}

// ---------------------------------------------------------------------------
// Harness — copied from tests/action-proposal-emission.test.ts / tests/drift-belief-correction-e2e.test.ts,
// but P-1 requires a file-backed temp DB (createBrainHttpServer opens its own handles on
// dbPath) so this harness's db field is opened against tmpDbPath, never ':memory:'.
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  episodes: EpisodicStore;
  store: SemanticStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  config: EngineConfig;
}

function makeHarness(dbPath: string, db: Database.Database): Harness {
  // P-2: seed the FakeClock at real Date.now(), NOT the customary Date.UTC(2026, 0, 1).
  // SQLiteActionProposalSink stamps expires_at = clock.nowMs() + PROPOSAL_TTL_MS (14 days),
  // and the HTTP server's ActionProposalStore filters expires_at > now against realClock.
  // Seeding the customary 2026-01-01 fake clock would make every emitted proposal already
  // expired by the time GET /v1/proposals runs against real wall-clock time, so stage 7-8
  // would silently prove nothing (empty list, test passes for the wrong reason). Seeding at
  // real Date.now() keeps determinism WITHIN this run (the clock never advances after
  // construction) while keeping the TTL window open against the real clock the server uses.
  const clock = new FakeClock(Date.now());
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath,
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.0,
    salience: {
      ...DEFAULT_CONFIG.salience,
      consolSkipThresholdBySource: { gmail: 0.0 },
    },
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
    // P-3: provenanceDistinctnessEnabled is left at its stock (dark) DEFAULT_CONFIG value —
    // this file must exercise the chain that SHIPS. Not overridden here.
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Copied from tests/action-proposal-emission.test.ts: a REAL SQLiteConsolidationSink AND a
 * REAL proposal sink (SQLiteActionProposalSink over a REAL ActionProposalStore, per P-1/P-2). */
function makeConsolidatorWithProposalSink(
  h: Harness,
  provider: ModelProvider,
  proposalSink: ActionProposalSink,
): Consolidator {
  const sink: ConsolidationSink = new SQLiteConsolidationSink(new EventStore(h.db), h.clock);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink, () => {}, undefined, undefined, undefined, undefined,
    proposalSink,
  );
}

function seedNode(h: Harness, value: string, opts: { s?: number; c?: number } = {}): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'fact', value, origin: 'observed', s: opts.s, c: opts.c });
  h.store.setEmbedding(id, constVec(h.config.embeddingDimensions));
  return id;
}

function seedEntity(h: Harness, value: string): string {
  const id = newId();
  h.store.upsertNode({ id, type: 'entity', value, origin: 'observed' });
  h.store.setEmbedding(id, constVec(h.config.embeddingDimensions));
  return id;
}

function getNodeById(h: Harness, id: string): NodeRow {
  const row = h.db.prepare('SELECT * FROM node WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) throw new Error(`getNodeById: node ${id} not found`);
  return row;
}

function findNodeIdByValue(h: Harness, value: string): string | null {
  const row = h.db.prepare('SELECT id FROM node WHERE value = ?').get(value) as { id: string } | undefined;
  return row?.id ?? null;
}

function getEpisodeById(h: Harness, id: string): EpisodeRow {
  const row = h.db.prepare('SELECT * FROM episode WHERE id = ?').get(id) as EpisodeRow | undefined;
  if (!row) throw new Error(`getEpisodeById: episode ${id} not found`);
  return row;
}

function consolidationEventTypesForNode(h: Harness, nodeId: string): string[] {
  return (
    h.db
      .prepare('SELECT event_type FROM consolidation_event WHERE node_id = ? OR candidate_id = ?')
      .all(nodeId, nodeId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

// ---------------------------------------------------------------------------
// MarkerProvider — content-keyed extraction + claim-value-keyed judge resolution.
// Copied from tests/action-proposal-emission.test.ts / tests/drift-belief-correction-e2e.test.ts
// per that file's documented duplication convention.
// ---------------------------------------------------------------------------

class MarkerProvider implements ModelProvider {
  constructor(
    private readonly embedFn: (t: string) => Float32Array,
    private readonly extractionByMarker: Array<{ marker: string; claims: Record<string, unknown>[] }>,
    private readonly judgeResolver: (
      claim: string,
      candidates: Array<{ id: string; value: string }>,
    ) => JudgeVerdict,
  ) {}

  async generate(prompt: string): Promise<string> {
    const hit = this.extractionByMarker.find(({ marker }) => prompt.includes(marker));
    if (!hit) {
      throw new Error(`MarkerProvider: unrecognized prompt (no known marker matched): ${prompt}`);
    }
    return JSON.stringify(hit.claims);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(this.embedFn);
  }

  async judge(claim: string, candidates: Array<{ id: string; value: string }>): Promise<JudgeVerdict> {
    return this.judgeResolver(claim, candidates);
  }

  async judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>,
  ): Promise<JudgeVerdict[]> {
    const results: JudgeVerdict[] = [];
    for (const item of items) results.push(await this.judge(item.claim, item.candidates));
    return results;
  }
}

// ---------------------------------------------------------------------------
// Fail-if-called provider — copied from tests/proposal-reference-e2e.test.ts /
// tests/telegram-belief-e2e.test.ts. Proves the online path (HTTP server + Telegram bridge)
// never invokes an LLM.
// ---------------------------------------------------------------------------

function makeLlmFreeProvider(): ModelProvider {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array([0, 1, 0]));
    },
    async generate(): Promise<string> {
      throw new Error('generate must not be called on the full-chain e2e online path');
    },
    async judge(): Promise<never> {
      throw new Error('judge must not be called on the full-chain e2e online path');
    },
    async judgeBatch(): Promise<never> {
      throw new Error('judgeBatch must not be called on the full-chain e2e online path');
    },
  };
}

// ---------------------------------------------------------------------------
// FakeGmailFetcher — shape from tests/gmail-adapter.test.ts, extended to a scripted queue
// (P-5): successive fetchMessages calls shift successive batches off an array.
// ---------------------------------------------------------------------------

class FakeGmailFetcher implements GmailFetcher {
  constructor(
    private readonly batches: Array<{ messages: RawGmailMessage[]; newHistoryId: string | null }>,
  ) {}

  async fetchMessages(
    _query: string,
    _startHistoryId: string | null,
  ): Promise<{ messages: RawGmailMessage[]; newHistoryId: string | null }> {
    const batch = this.batches.shift();
    if (!batch) return { messages: [], newHistoryId: null };
    return batch;
  }
}

// ---------------------------------------------------------------------------
// FakeMetaStore — structural { getMeta, setMeta } interface, Map-backed. No import needed.
// ---------------------------------------------------------------------------

class FakeMetaStore {
  private readonly map = new Map<string, string>();
  getMeta(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.map.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// Temp path helpers — copied from tests/proposal-reference-e2e.test.ts.
// ---------------------------------------------------------------------------

function makeTempDbPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeTempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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

const noopLog = (_msg: string): void => {};

function makeNoopMemoryClient(): MemoryClient {
  return {
    async ask() { return { answer: null, origin: 'none' }; },
    async search() { return []; },
    async surface() { return []; },
    async surfaceSeen() {},
    async hitlEpisode() {},
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('full-chain e2e: gmail raw bytes -> normalize/strip -> ingest -> consolidation -> emission -> store -> /v1/proposals -> telegram approval', () => {
  const TEST_TOKEN = 'f'.repeat(64);
  const CHAT_ID = 555555;

  it('drives one fixture Gmail contradiction through all 8 stages in a single continuous run, pinning the emit->store join across the whole chain', async () => {
    // ── Fixture constants (single nowMs so parseEmailDate assertions can reuse it) ──
    const nowMs = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const mintDate = new Date(nowMs - 3 * ONE_DAY_MS).toUTCString();
    const contradictDate = new Date(nowMs - 1 * ONE_DAY_MS).toUTCString();

    const ENTITY = 'Acme Corp';
    const BELIEF_VALUE = 'Acme Corp application status: submitted, awaiting review';
    const CONTRADICT_VALUE = 'Acme Corp application status: rejected';
    const MINT_MARKER = '[EP-CHAIN-MINT]';
    const REJECT_MARKER = '[EP-CHAIN-REJECT]';
    const VISIBLE_PAYLOAD = 'the hiring committee has made a final decision on your candidacy';
    const HIDDEN_TOKEN = 'RECENSE-HIDDEN-CANARY';

    // Message 1 (mint): plain-text, ~3 days before now.
    const RAW: RawGmailMessage[] = [
      {
        id: 'gmail-msg-chain-mint-001',
        threadId: 'thread-chain-mint-001',
        headers: { from: 'HR <hr@acme-corp.example>', subject: `Update ${MINT_MARKER}`, date: mintDate },
        bodyText: `${MINT_MARKER} ${BELIEF_VALUE}`,
      },
      // Message 2 (contradiction): HTML body with a display:none hidden canary, a quoted
      // tail, and a zero-width character (U+200B) in the Subject header so the
      // stripInvisibleCodepoints header path is exercised too.
      {
        id: 'gmail-msg-chain-reject-002',
        threadId: 'thread-chain-reject-002',
        headers: {
          from: 'HR <hr@acme-corp.example>',
          subject: `Decision​ update ${REJECT_MARKER}`,
          date: contradictDate,
        },
        bodyText:
          `<div>${REJECT_MARKER} ${CONTRADICT_VALUE} — ${VISIBLE_PAYLOAD}.</div>` +
          `<div style="display:none">${HIDDEN_TOKEN}</div>` +
          `<div>&gt; On an earlier date, HR wrote: original submission acknowledged.</div>`,
      },
    ];

    // ── Stage 0: file-backed temp DB (P-1) — never :memory:, so createBrainHttpServer's
    // own handles (stage 7-8) see the same rows the consolidation half (stage 1-6) writes.
    const tmpDbPath = makeTempDbPath('full-chain-e2e');
    const tmpLockPath = path.join(
      os.tmpdir(),
      `full-chain-e2e-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
    );
    process.env['RECENSE_LOCK_PATH'] = tmpLockPath;
    const storePath = makeTempPath('full-chain-e2e-store');
    const statePath = makeTempPath('full-chain-e2e-state');

    let db: Database.Database | undefined;
    let assertDb: Database.Database | undefined;
    let serverResult: BrainHttpServer | undefined;

    try {
      db = new Database(tmpDbPath);
      initSchema(db);

      const h = makeHarness(tmpDbPath, db);

      // ── Data preconditions: seed the entity + an anchor fact node (comment, not stub —
      // EntityResolver still runs for real against these; in production these come from
      // prior consolidation passes). ──
      const entityId = seedEntity(h, ENTITY);
      const anchorId = seedNode(h, `anchor placeholder (${ENTITY})`);

      // One MarkerProvider for the whole run — no swapProvider needed. The judge resolver
      // branches on the CLAIM VALUE, never call order (T-62-36 discipline).
      const provider = new MarkerProvider(
        constEmbedFn(h.config.embeddingDimensions),
        [
          { marker: MINT_MARKER, claims: [{ type: 'fact', value: BELIEF_VALUE }] },
          {
            marker: REJECT_MARKER,
            claims: [{
              type: 'fact', value: CONTRADICT_VALUE,
              intent_status: 'rejected', intent_entity: ENTITY, intent_confidence: 'high',
            }],
          },
        ],
        (claim, candidates) => {
          if (claim === BELIEF_VALUE) {
            return { relation: 'extend', best_candidate_id: anchorId, magnitude: 0.1, contradicted_ids: [] };
          }
          if (claim === CONTRADICT_VALUE) {
            const target = candidates.find((c) => c.value === BELIEF_VALUE);
            if (!target) throw new Error('full-chain fixture: belief node not found among candidates');
            // P-4: fresh-mint resistance (s=0.1, c=0.5 -> resistance=0.05); magnitude 0.06 ->
            // ratio 1.2 -> inside [peReconcileBandLow 0.8, peReconcileBandHigh 2.0) -> mid-band
            // reconcile (tombstone old, mint new carrying prev_value, event contradict_reconcile).
            return { relation: 'contradict', best_candidate_id: target.id, magnitude: 0.06, contradicted_ids: [target.id] };
          }
          throw new Error(`full-chain fixture: unrecognized claim value: ${claim}`);
        },
      );

      const proposalSink: ActionProposalSink = new SQLiteActionProposalSink(
        new ActionProposalStore(h.db, h.clock), h.clock,
      );
      const consolidator = makeConsolidatorWithProposalSink(h, provider, proposalSink);

      // P-5: one adapter instance reused across both cycles so the cursor round-trips
      // through fakeMeta. Batch 1 (mint) on the first fetchMessages call, batch 2
      // (contradiction) on the second.
      const fakeMeta = new FakeMetaStore();
      const fakeFetcher = new FakeGmailFetcher([
        { messages: [RAW[0]!], newHistoryId: 'history-1' },
        { messages: [RAW[1]!], newHistoryId: 'history-2' },
      ]);
      const adapter = new GmailAdapter(h.config, fakeMeta, 'default', fakeFetcher);

      // ── Cycle 1: ingest + consolidate the mint email ──
      await runPullPhase([adapter], new IngestionPipeline(new AllocationGate(h.config), h.episodes), h.db, noopLog);
      await consolidator.consolidate();

      // ── Cycle 2: ingest + consolidate the contradiction email ──
      await runPullPhase([adapter], new IngestionPipeline(new AllocationGate(h.config), h.episodes), h.db, noopLog);
      await consolidator.consolidate();

      // ── Stage 2 (ingest join): both episode rows exist with the expected join fields. ──
      const episode0 = h.db.prepare('SELECT * FROM episode WHERE external_id = ?').get(RAW[0]!.id) as EpisodeRow | undefined;
      const episode1 = h.db.prepare('SELECT * FROM episode WHERE external_id = ?').get(RAW[1]!.id) as EpisodeRow | undefined;
      expect(episode0).toBeDefined();
      expect(episode1).toBeDefined();
      for (const [i, row] of [episode0!, episode1!].entries()) {
        expect(row.external_id).toBe(RAW[i]!.id);
        expect(row.source).toBe('gmail');
        expect(row.origin).toBe('observed');
        // P-3: stock (dark) provenanceDistinctnessEnabled -> collapsed session_id.
        expect(row.session_id).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
      }
      const parsedTs0 = parseEmailDate(RAW[0]!.headers.date, nowMs);
      const parsedTs1 = parseEmailDate(RAW[1]!.headers.date, nowMs);
      expect(episode0!.event_ts).not.toBeNull();
      expect(episode1!.event_ts).not.toBeNull();
      expect(episode0!.event_ts).toBe(parsedTs0);
      expect(episode1!.event_ts).toBe(parsedTs1);
      expect(episode0!.event_ts!).toBeLessThan(episode1!.event_ts!);

      // ── Stage 1 (normalize/strip): message 2's stored content carries the visible marker
      // and visible payload, and does NOT carry the hidden div's content nor the header's
      // zero-width codepoint. ──
      expect(episode1!.content).toContain(REJECT_MARKER);
      expect(episode1!.content).toContain(VISIBLE_PAYLOAD);
      expect(episode1!.content).not.toContain(HIDDEN_TOKEN);
      expect(episode1!.content).not.toContain('display:none');
      expect(episode1!.content).not.toMatch(/​/u);

      // ── Stages 3-5 (classify -> resolve -> drift): mint tombstoned, contradicting live
      // node exists with prev_value, contradict_reconcile recorded. ──
      const mintNodeId = findNodeIdByValue(h, BELIEF_VALUE);
      expect(mintNodeId).not.toBeNull();
      const mintNode = getNodeById(h, mintNodeId!);
      expect(mintNode.tombstoned).toBeTruthy();

      const liveNodeId = findNodeIdByValue(h, CONTRADICT_VALUE);
      expect(liveNodeId).not.toBeNull();
      const liveNode = getNodeById(h, liveNodeId!);
      expect(liveNode.tombstoned).toBeFalsy();
      expect(liveNode.prev_value).toBe(BELIEF_VALUE);

      expect(consolidationEventTypesForNode(h, mintNodeId!)).toContain('contradict_reconcile');

      // ── Stage 6 (emission + emit->store join — THE REASON THIS FILE EXISTS): exactly one
      // action_proposal row, with the unbroken gmail-message-id -> episode -> proposal chain. ──
      const proposalRows = h.db.prepare('SELECT * FROM action_proposal').all() as ActionProposalRecord[];
      expect(proposalRows).toHaveLength(1);
      const row = proposalRows[0]!;

      expect(row.evidence_episode).toBe(episode1!.id);
      const evidenceEpisode = getEpisodeById(h, row.evidence_episode);
      expect(evidenceEpisode.external_id).toBe(RAW[1]!.id);

      // EMIT-06: byte-identical strict equality, not substring/trimmed comparison.
      expect(row.evidence_quote).toBe(evidenceEpisode.content);
      expect(row.evidence_quote).not.toContain(HIDDEN_TOKEN);

      // The recomputed proposalId, from the row's own columns, using the REAL exported
      // proposalId — fails if the sink's id derivation ever drifts from what was persisted.
      const recomputedId = proposalId({
        entity_node_id: row.entity_node_id,
        change_field: row.change_field,
        change_from: row.change_from,
        change_to: row.change_to,
        evidence_episode: row.evidence_episode,
      });
      expect(row.id).toBe(recomputedId);

      expect(row.entity_node_id).toBe(entityId);
      expect(row.change_to).toBe('rejected');
      expect(row.change_field).toBe('status');
      expect(row.confidence).toBe('high');
      expect(row.status).toBe('pending');
      expect(row.schema_version).toBe(PROPOSAL_CONTRACT_VERSION);
      // P-2 guard, stated as an assertion so a future clock regression fails loudly here
      // instead of silently emptying stage 7.
      expect(row.expires_at).toBeGreaterThan(Date.now());

      const emittedProposalId = row.id;

      // ── Close the engine-half DB handle BEFORE createBrainHttpServer opens its own,
      // per proposal-reference-e2e.test.ts's setup/seed handle split (Task 2 sequencing,
      // step 1) — keeps the approve path's per-call lock from contending with an open
      // writer. ──
      db.close();
      db = undefined;

      // ── Stage 7: /v1/proposals over the real HTTP server ──
      const port = await getFreePort();
      serverResult = await createBrainHttpServer({ dbPath: tmpDbPath, token: TEST_TOKEN, provider: makeLlmFreeProvider() });
      serverResult.server.listen(port, '127.0.0.1');
      await new Promise<void>((resolve) => {
        if (serverResult!.server.listening) { resolve(); return; }
        serverResult!.server.once('listening', resolve);
      });

      assertDb = new Database(tmpDbPath);
      function getProposalStatus(id: string): string {
        const r = assertDb!.prepare('SELECT status FROM action_proposal WHERE id = ?').get(id) as { status: string } | undefined;
        return r?.status ?? '';
      }

      const client = createBeliefProposalClient(`http://127.0.0.1:${String(port)}`, TEST_TOKEN);
      const transport = new MockTelegramTransport();
      const memoryClient = makeNoopMemoryClient();

      await runBeliefBridgePass({
        client, transport, chatIds: [CHAT_ID], storePath, statePath,
        dailyCap: 10, log: noopLog, nowMs: Date.now(),
      });

      expect(transport.sent).toHaveLength(1);
      const sent = transport.sent[0];
      expect(sent?.text).toContain(ENTITY);
      const buttons = sent?.replyMarkup?.inline_keyboard.flat() ?? [];
      // APPROVE-01: the approve button's callback_data starts with the belief-kind prefix
      // and its label carries the transition target 'rejected' — never a bare "Approve".
      const approveButton = buttons.find((b) => b.callback_data.startsWith('3|') && b.text.includes('rejected'));
      expect(approveButton).toBeDefined();

      // ── Stage 8: decode the REAL callback_data, drive the approval ──
      const decoded = decodeBeliefCallbackData(approveButton?.callback_data ?? '');
      expect(decoded).not.toBeNull();
      expect(decoded?.action).toBe('approve');

      await handleBeliefProposalAction(
        transport, memoryClient, client, storePath, statePath, CHAT_ID,
        decoded as { localId: string; action: 'approve' | 'edit' | 'reject' | 'snooze' },
        Date.now(),
      );

      expect(getProposalStatus(emittedProposalId)).toBe('approved');
      const localId = decoded?.localId ?? '';
      const localRow = getProposal(localId, storePath);
      expect(localRow && 'localStatus' in localRow ? localRow.localStatus : undefined).toBe('terminal');

      // Cross-boundary id conservation (the emit->store pin extended across the HTTP seam):
      // asserted against the CAPTURED constant, not a re-query — a re-query would pass even
      // if the surface listed a different row.
      expect(row.id).toBe(emittedProposalId);
    } finally {
      try { assertDb?.close(); } catch { /* ignore */ }
      if (serverResult) { try { await serverResult.close(); } catch { /* ignore */ } }
      try { db?.close(); } catch { /* ignore */ }
      delete process.env['RECENSE_LOCK_PATH'];
      try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(storePath); } catch { /* ignore */ }
      try { fs.unlinkSync(statePath); } catch { /* ignore */ }
    }
  });
});
