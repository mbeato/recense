/**
 * clients/telegram/tests/belief-union-store.test.ts — Phase 68 Plan 01 Task 3.
 *
 * Proves a belief-kind StoredProposal rides the REAL, UNMODIFIED proposal-store.ts
 * (isExpired, putProposal, getProposal, tryReserveProposalSlot) — no mocks of the
 * store — plus the D-10 zero-diff hash lock on proposal-store.ts / proposal-engine.ts.
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  isExpired,
  putProposal,
  getProposal,
  tryReserveProposalSlot,
} from '../proposal-store';
import { toStoredBeliefProposal, beliefLocalId, isBeliefProposal, type ActionProposalRecord } from '../belief-bridge';
import type { StoredToolProposal } from '../types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'belief-union-store-test-'));
  storePath = join(tmpDir, 'proposals.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let _idCounter = 0;

function makeRecord(overrides: Partial<ActionProposalRecord> = {}): ActionProposalRecord {
  _idCounter += 1;
  const id = createHash('sha256').update(`belief-union-test-${String(_idCounter)}`).digest('hex');
  const now = Date.now();
  return {
    id,
    kind: 'belief',
    entity_node_id: 'node-' + id,
    entity_descriptor: 'entity for ' + id,
    belief_node_id: 'belief-' + id,
    change_field: 'status',
    change_from: 'applied',
    change_to: 'interviewing',
    evidence_episode: 'episode-' + id,
    evidence_quote: 'quote for ' + id,
    confidence: 'high',
    schema_version: 17,
    status: 'pending',
    created_at: now,
    updated_at: now,
    expires_at: now + 86_400_000,
    ...overrides,
  };
}

function makeToolProposal(overrides: Partial<StoredToolProposal> = {}): StoredToolProposal {
  _idCounter += 1;
  return {
    kind: 'tool',
    id: `tool-prop-${String(_idCounter)}`,
    serverName: 'test-server',
    tool: 'read_file',
    args: { path: '/tmp/notes.txt' },
    nodeId: 'test-node',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxTtlMs: 3_600_000,
    createdAt: new Date().toISOString(),
    destructive: false,
    expectedConfirmValue: 'read_file',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Field-mapping / expiry-coincidence behaviors
// ---------------------------------------------------------------------------

describe('toStoredBeliefProposal — field mapping (APPROVE-02)', () => {
  it('produces a row where Date.parse(dueAt) === record.expires_at', () => {
    const record = makeRecord();
    const row = toStoredBeliefProposal(record, Date.now());
    expect(Date.parse(row.dueAt)).toBe(record.expires_at);
  });

  it('the produced row satisfies Date.parse(createdAt) + maxTtlMs === record.expires_at', () => {
    const nowMs = Date.now();
    const record = makeRecord();
    const row = toStoredBeliefProposal(record, nowMs);
    expect(Date.parse(row.createdAt) + row.maxTtlMs).toBe(record.expires_at);
  });

  it('isExpired(row, expires_at - 1) is false; isExpired(row, expires_at + 1) is true', () => {
    const nowMs = Date.now();
    const record = makeRecord();
    const row = toStoredBeliefProposal(record, nowMs);
    expect(isExpired(row, record.expires_at - 1)).toBe(false);
    expect(isExpired(row, record.expires_at + 1)).toBe(true);
  });

  it('a record whose expires_at is already in the past yields maxTtlMs === 0 (never negative)', () => {
    const nowMs = Date.now();
    const record = makeRecord({ expires_at: nowMs - 60_000 });
    const row = toStoredBeliefProposal(record, nowMs);
    expect(row.maxTtlMs).toBe(0);
  });

  it('beliefLocalId(serverId) returns the first 32 characters and is stable across calls', () => {
    const record = makeRecord();
    const a = beliefLocalId(record.id);
    const b = beliefLocalId(record.id);
    expect(a).toBe(record.id.slice(0, 32));
    expect(a).toHaveLength(32);
    expect(a).toBe(b);
  });

  it('toStoredBeliefProposal copies serverCreatedAtMs from record.created_at unchanged', () => {
    const record = makeRecord();
    const row = toStoredBeliefProposal(record, Date.now());
    expect(row.serverCreatedAtMs).toBe(record.created_at);
  });
});

// ---------------------------------------------------------------------------
// Real-store round-trip (no mocks of proposal-store.ts)
// ---------------------------------------------------------------------------

describe('belief row through the UNMODIFIED proposal-store.ts', () => {
  it('putProposal(row) then getProposal(row.id) returns a deep-equal row', () => {
    const record = makeRecord();
    const row = toStoredBeliefProposal(record, Date.now());
    putProposal(row, storePath);
    const found = getProposal(row.id, storePath);
    expect(found).toEqual(row);
  });

  it('a belief row and a tool row coexist in one store file; getProposal returns each by its own id', () => {
    const beliefRow = toStoredBeliefProposal(makeRecord(), Date.now());
    const toolRow = makeToolProposal();
    putProposal(beliefRow, storePath);
    putProposal(toolRow, storePath);

    const foundBelief = getProposal(beliefRow.id, storePath);
    const foundTool = getProposal(toolRow.id, storePath);

    expect(foundBelief).toEqual(beliefRow);
    expect(foundTool).toEqual(toolRow);
    expect(foundBelief).not.toBeNull();
    expect(foundBelief !== null && isBeliefProposal(foundBelief)).toBe(true);
  });

  it('tryReserveProposalSlot decrements the same shared daily budget regardless of which kind consumed it', () => {
    const now = new Date();
    const ok1 = tryReserveProposalSlot(2, storePath, now);
    const ok2 = tryReserveProposalSlot(2, storePath, now);
    const ok3 = tryReserveProposalSlot(2, storePath, now);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(ok3).toBe(false); // cap exhausted regardless of what kind of proposal triggered each call
  });

  it('the store file written with a belief row inside reloads correctly after a simulated process restart', () => {
    const record = makeRecord();
    const row = toStoredBeliefProposal(record, Date.now());
    putProposal(row, storePath);

    // Simulate a process restart: re-read directly from disk, independent of any
    // in-memory reference to `row`.
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { proposals: unknown[] };
    const reloaded = raw.proposals.find((p): p is Record<string, unknown> =>
      typeof p === 'object' && p !== null && (p as Record<string, unknown>)['id'] === row.id,
    );
    expect(reloaded).toBeDefined();
    expect(reloaded?.['kind']).toBe('belief');

    const foundViaApi = getProposal(row.id, storePath);
    expect(foundViaApi).toEqual(row);
  });
});

// ---------------------------------------------------------------------------
// D-10 zero-diff hash lock — "convention-enforced invariants fail"
//
// proposal-store.ts and proposal-engine.ts are FROZEN for the lifetime of
// APPROVE-02 (the roadmap SC locks this verbatim). If this block ever fails, the
// zero-fork success criterion was breached. Updating a pinned constant below is a
// deliberate decision requiring the APPROVE-02 success criterion to be revisited
// — NOT a routine test fix.
// ---------------------------------------------------------------------------

describe('D-10 zero-diff hash lock (proposal-store.ts / proposal-engine.ts frozen)', () => {
  const PINNED_PROPOSAL_STORE_SHA256 =
    '53cdb9bd4b3699fcb4f58561d708aec32698a8497d24dde326fb93f575b1eac4';
  const PINNED_PROPOSAL_ENGINE_SHA256 =
    'd446e461ebaeee421f8849f72680f1a73dc761096fe28fb8dc44f951b50586f7';

  function sha256Of(relativePath: string): string {
    const contents = readFileSync(join(__dirname, '..', relativePath));
    return createHash('sha256').update(contents).digest('hex');
  }

  it('proposal-store.ts is byte-identical to the pinned hash', () => {
    expect(sha256Of('proposal-store.ts')).toBe(PINNED_PROPOSAL_STORE_SHA256);
  });

  it('proposal-engine.ts is byte-identical to the pinned hash', () => {
    expect(sha256Of('proposal-engine.ts')).toBe(PINNED_PROPOSAL_ENGINE_SHA256);
  });
});
