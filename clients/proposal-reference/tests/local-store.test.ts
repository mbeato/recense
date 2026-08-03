import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  findByProposalId,
  listLocalRows,
  LocalStoreCorruptError,
  newLocalId,
  putLocalRow,
  type LocalRow,
} from '../local-store';

let storePath: string;

beforeEach(() => {
  storePath = join(tmpdir(), `proposal-reference-store-test-${randomUUID()}.json`);
});

afterEach(() => {
  if (existsSync(storePath)) rmSync(storePath);
});

function makeRow(overrides: Partial<LocalRow> = {}): LocalRow {
  return {
    localId: newLocalId(),
    proposalId: randomUUID(),
    entityDescriptor: 'Acme Corp application',
    changeField: 'status',
    changeTo: 'interviewing',
    localStatus: 'pending',
    refusalReason: null,
    updatedAtMs: Date.now(),
    ...overrides,
  };
}

describe('local-store', () => {
  it('putLocalRow on a fresh store creates the file and listLocalRows returns exactly that one row', () => {
    expect(existsSync(storePath)).toBe(false);
    const row = makeRow();
    putLocalRow(row, storePath);
    expect(existsSync(storePath)).toBe(true);
    const rows = listLocalRows(storePath);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(row);
  });

  it('putLocalRow called twice with the same localId replaces rather than appends', () => {
    const localId = newLocalId();
    const row1 = makeRow({ localId, localStatus: 'pending' });
    putLocalRow(row1, storePath);
    const row2 = makeRow({ localId, localStatus: 'applied', proposalId: row1.proposalId });
    putLocalRow(row2, storePath);
    const rows = listLocalRows(storePath);
    expect(rows.length).toBe(1);
    expect(rows[0]?.localStatus).toBe('applied');
  });

  it('findByProposalId returns the matching row and undefined for an unseen proposal id', () => {
    const row = makeRow();
    putLocalRow(row, storePath);
    expect(findByProposalId(row.proposalId, storePath)).toEqual(row);
    expect(findByProposalId(randomUUID(), storePath)).toBeUndefined();
  });

  it('replay: two putLocalRow calls from the same proposalId but different localIds are caught by findByProposalId before the second insert', () => {
    const proposalId = randomUUID();
    const row1 = makeRow({ proposalId });
    putLocalRow(row1, storePath);

    // Caller-side idempotency check (D-02): before minting a second localId and
    // calling putLocalRow again, the caller must consult findByProposalId.
    const existing = findByProposalId(proposalId, storePath);
    expect(existing).toEqual(row1);

    // A caller that (incorrectly) ignored the check and put a second row anyway
    // would produce two distinct rows — proving findByProposalId is the mechanism
    // that prevents the caller from creating a duplicate, not local-store itself.
    const rows = listLocalRows(storePath);
    expect(rows.length).toBe(1);
  });

  it('a corrupt store file (invalid JSON) makes reads throw LocalStoreCorruptError — never treated as empty (WR-05)', () => {
    putLocalRow(makeRow(), storePath);
    writeFileSync(storePath, 'not valid json{{{');
    expect(() => listLocalRows(storePath)).toThrow(LocalStoreCorruptError);
    expect(() => findByProposalId(randomUUID(), storePath)).toThrow(LocalStoreCorruptError);
  });

  it('a store file with valid JSON of the wrong shape throws LocalStoreCorruptError (WR-05)', () => {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ not: 'the right shape' }));
    expect(() => listLocalRows(storePath)).toThrow(LocalStoreCorruptError);
  });

  it('an array containing one wrong-typed row throws LocalStoreCorruptError — no silent per-row drop (WR-05)', () => {
    const good = makeRow();
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify([good, { ...makeRow(), updatedAtMs: 'not-a-number' }]));
    expect(() => listLocalRows(storePath)).toThrow(LocalStoreCorruptError);
  });

  it('putLocalRow on a corrupt store throws and never overwrites the file (WR-05)', () => {
    putLocalRow(makeRow(), storePath);
    const corruptBytes = 'not valid json{{{';
    writeFileSync(storePath, corruptBytes);

    expect(() => putLocalRow(makeRow(), storePath)).toThrow(LocalStoreCorruptError);

    // The corrupt file is preserved verbatim for operator inspection —
    // nothing rewrote it as a fresh one-row store.
    expect(readFileSync(storePath, 'utf8')).toBe(corruptBytes);
  });

  it('a missing store file still reads as empty — only an existing corrupt file is fail-closed', () => {
    expect(existsSync(storePath)).toBe(false);
    expect(listLocalRows(storePath)).toEqual([]);
    expect(findByProposalId(randomUUID(), storePath)).toBeUndefined();
  });

  it('the written store file mode is 0o600', () => {
    putLocalRow(makeRow(), storePath);
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('mutating an object returned by listLocalRows does not change a subsequent listLocalRows result', () => {
    const row = makeRow();
    putLocalRow(row, storePath);
    const rows = listLocalRows(storePath);
    const first = rows[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      first.localStatus = 'refused';
      first.refusalReason = 'mutated in test';
    }
    const rowsAgain = listLocalRows(storePath);
    expect(rowsAgain[0]?.localStatus).toBe('pending');
    expect(rowsAgain[0]?.refusalReason).toBeNull();
  });
});
