# Phase 48: Correctness Hardening - Pattern Map

**Mapped:** 2026-06-27
**Files analyzed:** 5 (1 source, 4 test locations)
**Analogs found:** 5 / 5

---

## Critical Pre-Planning Finding

Three of the four HARD-0X regression tests **already exist** in the codebase, unlabeled. The planner must verify before writing new tests:

| Requirement | Existing test | Location |
|-------------|---------------|----------|
| HARD-01 (C-2 no-strengthen) | `it('C-2: assistant-role confirm does NOT strengthen...')` | `tests/consolidation.test.ts:1302` |
| HARD-02 (M-5 immediate txn) | **No existing test** | — must write |
| HARD-03 (M-9 downgrade throw) | `it('throws "newer than this binary"...')` | `tests/schema.test.ts:74` |
| HARD-04 dims mismatch | `it('L-2: setEmbedding with different dims...throws')` | `tests/store.test.ts:218` |

HARD-04 code gap: the `embedding_model` stamp is **absent**. Dims test exists; model test does not.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/db/semantic-store.ts` | service (write primitive) | CRUD | same file lines 384–393 (`embedding_dims` guard) | exact — mirror within the same function |
| `tests/store.test.ts` | test | CRUD | same file lines 203–224 (existing L-2 dims tests) | exact — same describe block |
| `tests/consolidation.test.ts` | test | event-driven | same file lines 1302–1344 (C-2 test) for HARD-01; lines 1753–1783 (D-48 in-transaction test) for HARD-02 | exact |
| `tests/schema.test.ts` | test | CRUD | same file lines 74–86 (existing M-9 test) | exact — HARD-03 already written |

---

## Pattern Assignments

### `src/db/semantic-store.ts` — HARD-04 code change (service, CRUD)

**Analog:** same file, `setEmbedding`, lines 384–393 (the `embedding_dims` guard)

**Existing dims guard to mirror** (`src/db/semantic-store.ts:384-393`):
```typescript
// L-2: stamp embedding dims on first write; assert consistency on subsequent writes
const dims = vec.length;
const storedDims = this.getMeta('embedding_dims');
if (storedDims === null) {
  this.setMeta('embedding_dims', String(dims));
} else if (parseInt(storedDims, 10) !== dims) {
  throw new Error(
    `embedding_dims mismatch: stored=${storedDims}, received=${dims} for node ${id} — provider dimensionality changed`
  );
}
```

**New `embedding_model` guard — insert immediately after the dims block, same shape:**
```typescript
// HARD-04 (L-2): stamp embedding model on first write; assert consistency on subsequent writes
const model = this.config.openaiEmbedModel;
const storedModel = this.getMeta('embedding_model');
if (storedModel === null) {
  this.setMeta('embedding_model', model);
} else if (storedModel !== model) {
  throw new Error(
    `embedding_model mismatch: stored=${storedModel}, received=${model} for node ${id} — embedding provider model changed`
  );
}
```

**Source of model string:** `this.config.openaiEmbedModel` — `SemanticStore` already holds `private readonly config: EngineConfig` (line 37). No signature change to `setEmbedding`. No new config surface. `EngineConfig.openaiEmbedModel` is defined at `src/lib/config.ts:222` and defaults to `'text-embedding-3-small'` at line 781.

**setEmbedding full insertion point** — after existing dims block, before the `Buffer.from` call at line 395:
```
L-2 dims block (384–393)
→ INSERT HARD-04 model block HERE (7 lines)
→ Float32Array → Buffer (line 395)
→ stmtSetEmbedding.run (lines 396–400)
```

---

### `tests/store.test.ts` — HARD-04 regression tests (test, CRUD)

**Analog:** same file, `describe('setEmbedding')` block, lines 203–224 (existing L-2 dims tests)

**Imports pattern** (lines 1–15) — copy as-is:
```typescript
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
```

**Test harness setup** (lines 57–70):
```typescript
let db: Database.Database;
let clock: FakeClock;
let store: SemanticStore;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  clock = new FakeClock(Date.UTC(2026, 0, 1));
  store = new SemanticStore(db, clock, testConfig);
});

afterEach(() => {
  db.close();
});
```

**Closest analog tests — dims stamp/assert pattern** (lines 203–224):
```typescript
it('L-2: first setEmbedding stamps embedding_dims in meta', () => {
  store.upsertNode({ id: 'n1', type: 'fact', value: 'dims test', origin: 'observed' });
  const vec = new Float32Array(8); // 8-dim
  store.setEmbedding('n1', vec);
  expect(store.getMeta('embedding_dims')).toBe('8');
});

it('L-2: setEmbedding with different dims than first write throws (provider mismatch guard)', () => {
  store.upsertNode({ id: 'n1', type: 'fact', value: 'a', origin: 'observed' });
  store.upsertNode({ id: 'n2', type: 'fact', value: 'b', origin: 'observed' });
  store.setEmbedding('n1', new Float32Array(8)); // stamps dims=8
  // Different dims — must throw
  expect(() => store.setEmbedding('n2', new Float32Array(4))).toThrow(/embedding_dims mismatch/);
});
```

**New HARD-04 model tests to add** — inside same `describe('setEmbedding')` block, after the existing L-2 dims tests. Config override required to control the model name:

```typescript
it('HARD-04 (L-2): first setEmbedding stamps embedding_model in meta', () => {
  const customConfig = { ...testConfig, openaiEmbedModel: 'test-model-v1' };
  const store2 = new SemanticStore(db, clock, customConfig);
  store2.upsertNode({ id: 'm1', type: 'fact', value: 'model stamp test', origin: 'observed' });
  store2.setEmbedding('m1', new Float32Array(8));
  expect(store2.getMeta('embedding_model')).toBe('test-model-v1');
});

it('HARD-04 (L-2): setEmbedding with mismatched model throws fail-closed', () => {
  // First write with model-A stamps meta
  const configA = { ...testConfig, openaiEmbedModel: 'model-a' };
  const storeA = new SemanticStore(db, clock, configA);
  storeA.upsertNode({ id: 'ma1', type: 'fact', value: 'a', origin: 'observed' });
  storeA.setEmbedding('ma1', new Float32Array(8)); // stamps embedding_model='model-a'

  // Second write with model-B on SAME db — mismatch must throw
  const configB = { ...testConfig, openaiEmbedModel: 'model-b' };
  const storeB = new SemanticStore(db, clock, configB);
  storeB.upsertNode({ id: 'ma2', type: 'fact', value: 'b', origin: 'observed' });
  expect(() => storeB.setEmbedding('ma2', new Float32Array(8))).toThrow(/embedding_model mismatch/);
});

it('HARD-04 (L-2): setEmbedding with matching model succeeds (happy path)', () => {
  const customConfig = { ...testConfig, openaiEmbedModel: 'same-model' };
  const store2 = new SemanticStore(db, clock, customConfig);
  store2.upsertNode({ id: 'sm1', type: 'fact', value: 'a', origin: 'observed' });
  store2.upsertNode({ id: 'sm2', type: 'fact', value: 'b', origin: 'observed' });
  store2.setEmbedding('sm1', new Float32Array(8)); // stamps model
  expect(() => store2.setEmbedding('sm2', new Float32Array(8))).not.toThrow();
});
```

---

### `tests/schema.test.ts` — HARD-03 regression test (test, CRUD)

**STATUS: Test already written.** The required regression test exists at `tests/schema.test.ts:74-86`. Work = verify it's correct, add `HARD-03` label in comment.

**Existing test (lines 74–86) — this IS the HARD-03 regression test:**
```typescript
it('throws "newer than this binary" when stored schema_version > SCHEMA_VERSION (M-9 downgrade guard)', () => {
  const db = new Database(':memory:');
  try {
    initSchema(db); // stamps SCHEMA_VERSION
    // Simulate a future DB by hand-stamping a version one above the binary
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION + 1),
    );
    expect(() => initSchema(db)).toThrow(/newer than this binary/);
  } finally {
    db.close();
  }
});
```

Add `// HARD-03 (M-9)` comment to label it. No behavior change.

**Imports pattern** (lines 11–13):
```typescript
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
```

Note: this file uses `try/finally { db.close() }` rather than `beforeEach`/`afterEach` — follow that pattern for any new cases added to this file.

---

### `tests/consolidation.test.ts` — HARD-01 and HARD-02 (test, event-driven)

#### HARD-01 (C-2 no-strengthen)

**STATUS: Primary test already written.** Verify existing test at lines 1302–1344; add `HARD-01` label.

**Existing C-2 test to label** (lines 1302–1344 — representative excerpt):
```typescript
it('C-2: assistant-role confirm does NOT strengthen (s and c unchanged)', async () => {
  const nodeId = newId();
  const nodeValue = 'always use TypeScript';

  h.store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed', s: 0.3, c: 0.5 });
  // ... embed node ...
  const sBefore = h.store.getNode(nodeId)!.s;
  const cBefore = h.store.getNode(nodeId)!.c;

  const provider = new MockModelProvider({
    embedFn: embedder.fn,
    generateScript: [JSON.stringify([{ type: 'fact', value: nodeValue }])], // D-17 fast path
    judgeScript: [],
  });
  const sink = new MockConsolidationSink();
  const consolidator = new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever, provider,
    makeNoOpSchemaInducer(h), h.config, h.clock, sink,
  );

  h.episodes.append({
    content: 'assistant confirming content',
    origin: 'observed',
    salience: 0.8,
    hard_keep: 0,
    role: 'assistant',   // <-- the key field
    session_id: 'session-c2-assistant',
  });

  await consolidator.consolidate();

  expect(h.store.getNode(nodeId)!.s).toBe(sBefore);  // s unchanged
  expect(h.store.getNode(nodeId)!.c).toBe(cBefore);  // c unchanged
  expect(sink.events[0]!.event_type).toBe('confirm'); // audit trail still emitted
});
```

Happy-path counterpart (user-role DOES strengthen) exists at line 238; no new case needed.

#### HARD-02 (M-5 `.immediate()` mode)

**No existing test.** Write new test inside `describe('Consolidator')` in `tests/consolidation.test.ts`.

**Closest analog:** D-48 in-transaction test (lines 1753–1783) — it uses a custom sink to inspect behavior inside the Phase-B transaction. HARD-02 uses the same technique: inject a `MockConsolidationSink`-style observer to verify the transaction is IMMEDIATE.

**D-48 analog pattern** (lines 1753–1783):
```typescript
it('D-48: sink.emit is called inside the transaction (Consolidator emits synchronously with graph write)', async () => {
  // Custom sink reads the DB inside emit() to verify visibility during transaction
  const nodeValue = 'in-tx-node';
  let nodeVisibleDuringEmit = false;
  const coTxSink = {
    emit(_event: { event_type: string }) {
      const rows = h.db.prepare('SELECT count(*) as c FROM node WHERE value = ?').get(nodeValue) as { c: number };
      nodeVisibleDuringEmit = rows.c > 0;
    },
  };
  // ...
  await consolidator.consolidate();
  expect(nodeVisibleDuringEmit).toBe(true);
});
```

**HARD-02 test shape** — spy on `db.transaction` to assert `.immediate()` is the call path. Add inside the existing `describe('Consolidator')` block:

```typescript
it('HARD-02 (M-5): Phase-B write transaction runs in IMMEDIATE mode (.immediate() call path)', async () => {
  // Spy: intercept db.transaction and track whether .immediate() is invoked.
  // This asserts the call path without a flaky real-concurrency race (D-04).
  let immediateCallCount = 0;
  const originalTransaction = h.db.transaction.bind(h.db);
  (h.db as any).transaction = (...args: Parameters<typeof h.db.transaction>) => {
    const txn = originalTransaction(...args);
    const origImmediate = txn.immediate.bind(txn);
    txn.immediate = (...iArgs: unknown[]) => {
      immediateCallCount++;
      return origImmediate(...iArgs);
    };
    return txn;
  };

  const provider = new MockModelProvider({
    embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
    generateScript: [JSON.stringify([{ type: 'fact', value: 'some-new-fact' }])],
    judgeScript: [],
  });
  const consolidator = new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever, provider,
    makeNoOpSchemaInducer(h), h.config, h.clock,
  );

  h.episodes.append({
    content: 'test episode for M-5',
    origin: 'observed',
    salience: 0.8,
    hard_keep: 0,
    role: 'user',
    session_id: 'session-m5',
  });

  await consolidator.consolidate();

  // At least one IMMEDIATE transaction must have fired (the Phase-B per-episode write)
  expect(immediateCallCount).toBeGreaterThanOrEqual(1);
});
```

**Imports already present in consolidation.test.ts** — no new imports needed; `makeZeroEmbedFn` is already defined at line 86.

---

## Shared Patterns

### Test harness (applies to all four test files)

**Source:** `tests/consolidation.test.ts:115-132` (canonical `makeHarness`)

```typescript
function makeHarness(): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    consolSkipThreshold: 0.2,
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}
```

Apply to: all test files that need the full engine stack (HARD-01, HARD-02). HARD-03/HARD-04 use simpler per-test setup with `try/finally { db.close() }` or `beforeEach`/`afterEach`.

### getMeta / setMeta pattern (HARD-04)

**Source:** `src/db/semantic-store.ts:384-393` (within `setEmbedding`)

- `getMeta(key)` returns `string | null` — `null` = key absent (first write)
- `setMeta(key, value)` writes the meta key
- On mismatch: `throw new Error(...)` — fail closed, no warn-and-continue
- Error message convention: `<key> mismatch: stored=X, received=Y for node <id> — <reason>`

### Fail-closed throw convention

**Source:** `src/db/semantic-store.ts:389-393` (dims) and `src/db/schema.ts:614-618` (schema_version)

Both use a throw (never warn-and-continue). HARD-04 model guard must match. The throw message must include enough context for debugging (`stored=`, `received=`, `for node <id>`).

### MockModelProvider construction

**Source:** `tests/consolidation.test.ts:148-165`

```typescript
const provider = new MockModelProvider({
  embedFn: makeSyntheticEmbedFn(h.config.embeddingDimensions),
  generateScript: [JSON.stringify([{ type: 'fact', value: 'claim text' }])],
  judgeScript: [],  // empty = no judge calls expected
});
```

`embedFn` choices: `makeSyntheticEmbedFn(dims)` (content-hash, high similarity for same text), `makeZeroEmbedFn(dims)` (zero vector, cosine=0, auto-unrelated), `makeAlwaysSameEmbedFn(dims)` (unit vector at dim 0, cosine=1 for all pairs).

### Consolidator construction

**Source:** `tests/consolidation.test.ts:259-261`, `1320-1323`

```typescript
const consolidator = new Consolidator(
  h.db, h.episodes, h.store, h.strength, h.retriever,
  provider, makeNoOpSchemaInducer(h), h.config, h.clock,
  /* optional sink */ sink,  // omit for tests that don't inspect sink events
);
```

---

## Test Framework Conventions

| Convention | Value |
|------------|-------|
| Framework | Vitest 4.1.8 |
| Config | `vitest.config.ts` — `environment: 'node'`, `pool: 'forks'`, `include: ['tests/**/*.test.ts']` |
| Run command | `npm test` (calls `vitest run`) |
| Test location | `tests/` directory — NOT colocated with source |
| File naming | `tests/<unit-under-test>.test.ts` |
| DB | `new Database(':memory:')` for pure unit tests; file DB via `tmpdir()` for two-connection concurrency tests |
| Build required | `npm run build` runs before test (pretest hook); changes must compile |
| Imports | `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'` |

---

## No Analog Found

All files have direct analogs in the codebase. No cases where RESEARCH.md patterns must be used instead.

---

## Metadata

**Analog search scope:** `src/db/`, `src/consolidation/`, `src/model/`, `src/lib/`, `tests/`
**Files scanned:** 12
**Pattern extraction date:** 2026-06-27
