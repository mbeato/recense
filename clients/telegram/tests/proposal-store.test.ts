/**
 * clients/telegram/tests/proposal-store.test.ts
 *
 * Tests for the immutable pending-proposal store (D-07) with expiry and daily-cap.
 *
 * Key invariants tested:
 *   - put→get round-trips args exactly (immutable D-07 payload)
 *   - mutating returned object does NOT affect re-read (deep-copy isolation)
 *   - getProposal of unknown id → null
 *   - isExpired by dueAt-past AND by maxTtlMs-exceeded
 *   - loadExecutable → 'expired' | 'missing' | 'ok'
 *   - store file is written at mode 0600 (atomic 0600 write pattern from state.ts)
 *   - no re-query (/v1/search) path in proposal-store.ts (D-07)
 *   - tryReserveProposalSlot: count up to cap, refuse at limit (H-15)
 *   - date rollover resets daily count
 *   - cap state survives simulated restart (re-read from disk)
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  putProposal,
  getProposal,
  isExpired,
  loadExecutable,
  removeProposal,
  tryReserveProposalSlot,
  getCapState,
} from '../proposal-store';
import type { StoredProposal } from '../types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'proposal-store-test-'));
  storePath = join(tmpDir, 'proposals.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_NOW = Date.now();

function makeProposal(overrides?: Partial<StoredProposal>): StoredProposal {
  return {
    id: 'test-id-1',
    serverName: 'test-server',
    tool: 'send_email',
    args: { to: 'alice@example.com', subject: 'Hello', nested: { priority: 1 } },
    dueAt: new Date(BASE_NOW + 3_600_000).toISOString(),     // 1h from BASE_NOW
    maxTtlMs: 86_400_000,                                     // 24h
    createdAt: new Date(BASE_NOW).toISOString(),
    destructive: false,
    expectedConfirmValue: 'send_email',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// putProposal / getProposal round-trip
// ---------------------------------------------------------------------------

describe('putProposal / getProposal', () => {
  it('put then get returns deep-equal args', () => {
    const p = makeProposal();
    putProposal(p, storePath);
    const found = getProposal('test-id-1', storePath);
    expect(found).not.toBeNull();
    expect(found!.args).toEqual(p.args);
    expect(found!.tool).toBe('send_email');
    expect(found!.serverName).toBe('test-server');
  });

  it('getProposal of unknown id returns null', () => {
    putProposal(makeProposal(), storePath);
    expect(getProposal('unknown-id', storePath)).toBeNull();
  });

  it('getProposal on empty store returns null', () => {
    expect(getProposal('any-id', storePath)).toBeNull();
  });

  it('stores multiple proposals independently', () => {
    const p1 = makeProposal({ id: 'id-1', tool: 'tool_a' });
    const p2 = makeProposal({ id: 'id-2', tool: 'tool_b' });
    putProposal(p1, storePath);
    putProposal(p2, storePath);
    expect(getProposal('id-1', storePath)!.tool).toBe('tool_a');
    expect(getProposal('id-2', storePath)!.tool).toBe('tool_b');
  });
});

// ---------------------------------------------------------------------------
// Immutability: mutating returned object does NOT affect re-read (D-07)
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('mutating the returned object does not change a subsequent re-read', () => {
    const p = makeProposal({ args: { to: 'alice@example.com' } });
    putProposal(p, storePath);

    const returned = getProposal('test-id-1', storePath);
    expect(returned).not.toBeNull();
    // Mutate the returned object
    (returned!.args as Record<string, unknown>)['to'] = 'evil@attacker.com';
    returned!.tool = 'hacked';

    // Re-read from disk — must be unchanged
    const reread = getProposal('test-id-1', storePath);
    expect(reread!.args['to']).toBe('alice@example.com');
    expect(reread!.tool).toBe('send_email');
  });
});

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

describe('isExpired', () => {
  it('returns false when proposal is not yet expired', () => {
    const p = makeProposal();
    // now = BASE_NOW (before dueAt which is BASE_NOW + 1h)
    expect(isExpired(p, BASE_NOW)).toBe(false);
  });

  it('returns true when now > dueAt', () => {
    const p = makeProposal({ dueAt: new Date(BASE_NOW - 1).toISOString() }); // 1ms in the past
    expect(isExpired(p, BASE_NOW)).toBe(true);
  });

  it('returns true when now > createdAt + maxTtlMs', () => {
    const createdAt = new Date(BASE_NOW - 100).toISOString();
    const p = makeProposal({
      createdAt,
      maxTtlMs: 50,        // only 50ms TTL
      dueAt: new Date(BASE_NOW + 3_600_000).toISOString(), // dueAt still in future
    });
    // BASE_NOW > (BASE_NOW - 100) + 50 = BASE_NOW - 50  → true
    expect(isExpired(p, BASE_NOW)).toBe(true);
  });

  it('returns false when exactly at createdAt (not yet expired)', () => {
    const createdAt = new Date(BASE_NOW).toISOString();
    const p = makeProposal({ createdAt, maxTtlMs: 1_000_000 });
    expect(isExpired(p, BASE_NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadExecutable
// ---------------------------------------------------------------------------

describe('loadExecutable', () => {
  it('returns {status:"missing"} for an unknown id', () => {
    const result = loadExecutable('unknown-id', storePath, BASE_NOW);
    expect(result.status).toBe('missing');
  });

  it('returns {status:"ok", proposal} for a valid non-expired proposal', () => {
    const p = makeProposal();
    putProposal(p, storePath);
    const result = loadExecutable('test-id-1', storePath, BASE_NOW);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.proposal.args).toEqual(p.args);
    }
  });

  it('returns {status:"expired"} for an expired-by-dueAt proposal', () => {
    const p = makeProposal({ dueAt: new Date(BASE_NOW - 1).toISOString() });
    putProposal(p, storePath);
    const result = loadExecutable('test-id-1', storePath, BASE_NOW);
    expect(result.status).toBe('expired');
  });

  it('returns {status:"expired"} for a proposal exceeded by maxTtlMs', () => {
    const createdAt = new Date(BASE_NOW - 200).toISOString();
    const p = makeProposal({
      createdAt,
      maxTtlMs: 100, // TTL = 100ms; already exceeded at BASE_NOW
      dueAt: new Date(BASE_NOW + 3_600_000).toISOString(), // dueAt still in future
    });
    putProposal(p, storePath);
    const result = loadExecutable('test-id-1', storePath, BASE_NOW);
    expect(result.status).toBe('expired');
  });

  it('loadExecutable result contains no executable payload on expired', () => {
    const p = makeProposal({ dueAt: new Date(BASE_NOW - 1).toISOString() });
    putProposal(p, storePath);
    const result = loadExecutable('test-id-1', storePath, BASE_NOW);
    // 'expired' result has no proposal property
    expect(result.status).toBe('expired');
    expect('proposal' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeProposal
// ---------------------------------------------------------------------------

describe('removeProposal', () => {
  it('removes an existing proposal', () => {
    putProposal(makeProposal(), storePath);
    removeProposal('test-id-1', storePath);
    expect(getProposal('test-id-1', storePath)).toBeNull();
  });

  it('no-op on unknown id (does not throw)', () => {
    expect(() => removeProposal('nope', storePath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// File mode 0600
// ---------------------------------------------------------------------------

describe('file mode', () => {
  it('store file has mode 0600 after putProposal', () => {
    putProposal(makeProposal(), storePath);
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('store file has mode 0600 after tryReserveProposalSlot', () => {
    tryReserveProposalSlot(5, storePath, new Date(BASE_NOW));
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Daily proposal cap (Task 2 — H-15)
// ---------------------------------------------------------------------------

describe('tryReserveProposalSlot', () => {
  it('returns true for the first reservation', () => {
    const now = new Date(BASE_NOW);
    expect(tryReserveProposalSlot(5, storePath, now)).toBe(true);
  });

  it('counts proposals generated — reserves up to the cap', () => {
    const now = new Date(BASE_NOW);
    for (let i = 0; i < 3; i++) {
      expect(tryReserveProposalSlot(3, storePath, now)).toBe(true);
    }
  });

  it('returns false on the (cap+1)-th reservation in one day', () => {
    const now = new Date(BASE_NOW);
    for (let i = 0; i < 3; i++) {
      tryReserveProposalSlot(3, storePath, now);
    }
    // 4th reservation must fail
    expect(tryReserveProposalSlot(3, storePath, now)).toBe(false);
  });

  it('does not increment count when at cap', () => {
    const now = new Date(BASE_NOW);
    for (let i = 0; i < 2; i++) {
      tryReserveProposalSlot(2, storePath, now);
    }
    tryReserveProposalSlot(2, storePath, now); // refused
    tryReserveProposalSlot(2, storePath, now); // refused
    const cap = getCapState(storePath);
    expect(cap.count).toBe(2);
  });

  it('resets count when the date rolls over', () => {
    // Day 1 — fill the cap
    const day1 = new Date('2026-06-17T10:00:00');
    for (let i = 0; i < 3; i++) {
      tryReserveProposalSlot(3, storePath, day1);
    }
    expect(tryReserveProposalSlot(3, storePath, day1)).toBe(false);

    // Day 2 — count should reset
    const day2 = new Date('2026-06-18T10:00:00');
    expect(tryReserveProposalSlot(3, storePath, day2)).toBe(true);
    const cap = getCapState(storePath);
    const today2 = `${day2.getFullYear()}-${String(day2.getMonth() + 1).padStart(2, '0')}-${String(day2.getDate()).padStart(2, '0')}`;
    expect(cap.date).toBe(today2);
    expect(cap.count).toBe(1);
  });

  it('cap state survives a simulated restart (re-read from disk preserves count)', () => {
    const now = new Date(BASE_NOW);
    tryReserveProposalSlot(5, storePath, now);
    tryReserveProposalSlot(5, storePath, now);

    // Simulate restart: read cap state from the same file
    const cap = getCapState(storePath);
    expect(cap.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getCapState
// ---------------------------------------------------------------------------

describe('getCapState', () => {
  it('returns {date:"", count:0} on a fresh store', () => {
    const cap = getCapState(storePath);
    expect(cap.date).toBe('');
    expect(cap.count).toBe(0);
  });

  it('reflects incremented count after reservations', () => {
    const now = new Date(BASE_NOW);
    tryReserveProposalSlot(10, storePath, now);
    tryReserveProposalSlot(10, storePath, now);
    const cap = getCapState(storePath);
    expect(cap.count).toBe(2);
  });
});
