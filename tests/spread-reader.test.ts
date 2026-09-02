import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SqliteSpreadReader } from '../src/retrieval/spread-reader';

describe('SqliteSpreadReader', () => {
  let db: Database.Database;
  let store: SemanticStore;
  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), { ...DEFAULT_CONFIG, dbPath: ':memory:' });
    for (const id of ['a', 'b', 'c', 'dead']) store.upsertNode({ id, type: 'fact', value: id, origin: 'observed' });
    store.upsertEdge({ src: 'a', dst: 'b', rel: 'uses', w: 0.1, kind: 'relation' });
    store.upsertEdge({ src: 'c', dst: 'a', rel: 'extends', w: 0.2, kind: 'relation' });
    store.tombstone('dead');
  });
  afterEach(() => db.close());

  it('returns edges touching the id set in either direction, in one batch', () => {
    const r = new SqliteSpreadReader(db);
    const edges = r.edgesTouching(['a']);
    expect(edges.map(e => `${e.src}->${e.dst}:${e.rel}:${e.w}`).sort()).toEqual(['a->b:uses:0.1', 'c->a:extends:0.2']);
    expect(r.edgesTouching([])).toEqual([]);
  });

  it('liveIds filters tombstoned and unknown ids', () => {
    const r = new SqliteSpreadReader(db);
    expect(r.liveIds(['a', 'dead', 'nope'])).toEqual(new Set(['a']));
    expect(r.liveIds([])).toEqual(new Set());
  });
});
