/**
 * tests/proposal-settle-race.test.ts — CR-01 regression tests (phase 66 code review).
 *
 * approve/reject must be DECIDED under the single-writer lock with a compare-and-set
 * transition. The pre-fix check-then-act shape shipped three concrete races:
 *  1. double-settle — concurrent approve + reject both read 'pending' pre-lock, both
 *     write, both callers get 200 with contradictory acks;
 *  2. non-durable refusal — a terminal status written by a stale refusal (D-10) could be
 *     overwritten by a racing settle that read 'pending' before it;
 *  3. staleness TOCTOU — the sleep pass tombstones the belief between the pre-lock 'ok'
 *     verdict and the approve's lock acquisition, and the approve still lands.
 *
 * Each test here fails against the pre-fix code (unconditional UPDATE + pre-lock checks).
 *
 * Race choreography note: memory-ops pre-lock reads and better-sqlite3 writes are fully
 * synchronous; the ONLY suspension points are `await acquireLockWithRetry()`'s retry
 * timers. Starting an op while the (per-test) lockfile is held by our own live pid
 * freezes it deterministically between its pre-lock reads and its under-lock re-checks —
 * exactly the window CR-01 is about.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { ActionProposalStore, type ActionProposalRecord } from '../src/db/action-proposal-store';
import {
  wireMemoryEngine,
  ProposalNotPendingError,
  ProposalStaleError,
  type MemoryOps,
} from '../src/adapter/memory-ops';
import { MockModelProvider } from '../src/model/provider';

function makeTempPath(prefix: string, ext: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

describe('proposal settle races (CR-01)', () => {
  let tmpDbPath: string;
  let tmpLockPath: string;
  let closeEngine: (() => void) | undefined;
  let ops: MemoryOps;
  let entityId: string;
  let beliefId: string;
  let proposalId: string;

  beforeEach(async () => {
    tmpDbPath = makeTempPath('settle-race', '.db');
    tmpLockPath = makeTempPath('settle-race-lock', '.lock');
    process.env['RECENSE_LOCK_PATH'] = tmpLockPath;

    const setupDb = new Database(tmpDbPath);
    initSchema(setupDb);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const config = { ...DEFAULT_CONFIG, dbPath: tmpDbPath };
    const store = new SemanticStore(setupDb, clock, config);
    const episodes = new EpisodicStore(setupDb, clock, config);

    entityId = 'node-entity-race';
    beliefId = 'node-belief-race';
    store.upsertNode({ id: entityId, type: 'entity', value: 'Acme Corp', origin: 'observed', s: 0.8, c: 0.7, last_access: 1_000 });
    store.upsertNode({ id: beliefId, type: 'fact', value: 'Acme status: submitted', origin: 'observed', s: 0.5, c: 0.6, last_access: 2_000 });
    const episode = episodes.append({
      content: 'Acme: application submitted.',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-race', source: 'gmail',
    });

    const proposalStore = new ActionProposalStore(setupDb, clock);
    // Real wall-clock time, NOT the FakeClock: approveProposal gates staleness on
    // realClock.nowMs(), so expires_at must be anchored to real time.
    const nowMs = Date.now();
    proposalId = 'proposal-race';
    const row: ActionProposalRecord = {
      id: proposalId, kind: 'belief',
      entity_node_id: entityId, entity_descriptor: 'Acme Corp',
      belief_node_id: beliefId,
      change_field: 'status', change_from: null, change_to: 'submitted',
      evidence_episode: episode.id, evidence_quote: 'application submitted',
      confidence: 'high', schema_version: 17, status: 'pending',
      created_at: nowMs, updated_at: nowMs, expires_at: nowMs + 1_000_000,
    };
    proposalStore.insert(row);
    setupDb.close();

    const wired = await wireMemoryEngine({
      dbPath: tmpDbPath,
      provider: new MockModelProvider(),
      source: 'http',
      separateReadHandle: true,
    });
    ops = wired.ops;
    closeEngine = wired.close;
  });

  afterEach(() => {
    try { closeEngine?.(); } catch { /* ignore */ }
    try { unlinkSync(tmpDbPath); } catch { /* ignore */ }
    delete process.env['RECENSE_LOCK_PATH'];
    try { unlinkSync(tmpLockPath); } catch { /* ignore */ }
  });

  function readStatus(): string {
    const db = new Database(tmpDbPath, { readonly: true });
    const row = db.prepare('SELECT status FROM action_proposal WHERE id = ?').get(proposalId) as { status: string };
    db.close();
    return row.status;
  }

  it('concurrent approve + reject: exactly one settles; the loser gets ProposalNotPendingError, never a false 200', async () => {
    // Both calls run their pre-lock getById against status='pending' (the fast-fail reads
    // execute synchronously before either write lands), then serialize on the lock —
    // the exact double-settle interleaving from CR-01.
    const results = await Promise.allSettled([
      ops.approveProposal(proposalId),
      ops.rejectProposal(proposalId),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ status: string }> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ProposalNotPendingError);

    // The stored terminal status agrees with the single successful ack — no last-writer-wins.
    expect(readStatus()).toBe(fulfilled[0]!.value.status);
  });

  it('EMIT-07 staleness is re-checked under the lock: a belief tombstoned while approve waits for the lock is refused, not approved', async () => {
    // Hold the lock first (our own live pid → acquireLock treats it as held), so the
    // approve completes its pre-lock reads against a FRESH graph and then queues.
    writeFileSync(tmpLockPath, String(process.pid));
    const pendingApprove = ops.approveProposal(proposalId);

    // While approve waits: ordinary reconsolidation moves the belief on (the sleep pass
    // holds the same lockfile in production — this models its tombstone write).
    const sideDb = new Database(tmpDbPath);
    sideDb.prepare('UPDATE node SET tombstoned = 1 WHERE id = ?').run(beliefId);
    sideDb.close();

    // Release the lock; approve acquires it and must re-classify UNDER the lock.
    unlinkSync(tmpLockPath);

    await expect(pendingApprove).rejects.toBeInstanceOf(ProposalStaleError);
    await expect(pendingApprove).rejects.toMatchObject({ reason: 'superseded' });
    // D-10 durable refusal survived the race.
    expect(readStatus()).toBe('superseded');
  });

  it('a settled proposal is never overwritten: reject after approve throws ProposalNotPendingError and the status stays approved', async () => {
    await expect(ops.approveProposal(proposalId)).resolves.toEqual({ status: 'approved' });
    await expect(ops.rejectProposal(proposalId)).rejects.toBeInstanceOf(ProposalNotPendingError);
    expect(readStatus()).toBe('approved');
  });

  it('a durable stale refusal is never overwritten: reject racing a stale approve loses and the terminal status stays superseded', async () => {
    // Tombstone the belief up front — the approve will refuse as stale and write the
    // durable terminal status (D-10).
    const sideDb = new Database(tmpDbPath);
    sideDb.prepare('UPDATE node SET tombstoned = 1 WHERE id = ?').run(beliefId);
    sideDb.close();

    // Start both concurrently: reject's pre-lock read sees 'pending', then queues behind
    // the approve's lock. Pre-fix, reject would overwrite 'superseded' with 'rejected'.
    const results = await Promise.allSettled([
      ops.approveProposal(proposalId),
      ops.rejectProposal(proposalId),
    ]);

    expect(results[0]!.status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProposalStaleError);
    expect(results[1]!.status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ProposalNotPendingError);
    expect(readStatus()).toBe('superseded');
  });
});
