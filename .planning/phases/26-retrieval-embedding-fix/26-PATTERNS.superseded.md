# Phase 26: Retrieval-Embedding Fix - Pattern Map

**Mapped:** 2026-06-18
**Files analyzed:** 7 modified files + 1 new CLI file
**Analogs found:** 8 / 8

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/config.ts` | config | N/A | self (line 623–624) | exact |
| `src/model/embedder.ts` | model/utility | request-response | self (comment update only) | exact |
| `src/db/semantic-store.ts` | service | CRUD | self (setEmbedding L-2 dims guard, lines 287–312) | exact |
| `src/db/schema.ts` | config/migration | CRUD | self (v2–v10 migration branches, lines 178–353) | exact |
| `src/retrieval/topk.ts` | service | request-response | self (L-2 guard, lines 119–138) | exact — no change needed |
| `src/consolidation/consolidator.ts` | service | batch | self (`reembedDirty`, lines 282–302) | exact — pattern to mirror |
| `src/adapter/reembed-cli.ts` (**new**) | adapter/CLI | batch | `src/adapter/dedup-entities-cli.ts` | exact |
| `src/eval/snapshot.ts` | eval/utility | batch | self (no code change — harness already correct) | exact |

---

## Pattern Assignments

### `src/lib/config.ts` — change `openaiEmbedModel` default

**What changes:** Line 623: `'text-embedding-3-small'` → `'text-embedding-3-large'`. No other config field changes (D-05 keeps `embeddingDimensions: 1536`).

**Relevant existing shape** (lines 623–624):
```typescript
openaiEmbedModel: 'text-embedding-3-small',
embeddingDimensions: 1536,
```

**Constraint from `EngineConfig` interface** (lines 213–219):
```typescript
/**
 * OpenAI embedding model — Phase 2+ only.
 */
openaiEmbedModel: string;

/**
 * Embedding vector dimensions — must match openaiEmbedModel output.
 * 1536 dims → 6KB/node at v1 scale (negligible).
 */
embeddingDimensions: number;
```

**Provider consumption** (`src/model/provider.ts` lines 131–139): the config value flows directly into `OpenAIEmbedder` constructor with no intermediate logic — one string change is system-wide:
```typescript
async embed(texts: string[]): Promise<Float32Array[]> {
  if (!this._embedder) {
    this._embedder = new OpenAIEmbedder(
      this.embedConfig.openaiEmbedModel,
      this.embedConfig.embeddingDimensions
    );
  }
  return this._embedder.embed(texts);
}
```

---

### `src/model/embedder.ts` — update EMBEDDER_INPUT_MAX_CHARS comment only

**What changes:** The constant value (24,000 chars) is unchanged; the comment on line 27 references `text-embedding-3-small` — update to `text-embedding-3-large` (or remove the model-specific reference). No logic changes.

**Comment that needs updating** (lines 26–29):
```typescript
/**
 * The OpenAI text-embedding-3-small model has an 8192-token context limit.
 * ~24 000 chars ≈ 6 000 tokens (4 chars/token average)...
 */
export const EMBEDDER_INPUT_MAX_CHARS = 24_000;
```
`text-embedding-3-large` has the same 8192-token limit, so the value is unchanged.

---

### `src/db/schema.ts` — add v11 migration: stamp `embedding_model` in meta

**What changes:** Bump `SCHEMA_VERSION` from 10 → 11. Add a v11 migration block following the established pattern. The `meta` table (already in DDL, line 67–69) holds arbitrary key/value pairs — no DDL change needed.

**Existing migration block pattern to copy** (lines 325–334, the v10 block):
```typescript
// v10 migration: node_scope sidecar for single-tenant provenance (Phase 999.3, SCOPE-01).
// Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
// Existing v9 DBs: node_scope absent → DDL above creates it (IF NOT EXISTS catches it).
// No ALTER TABLE needed — the whole table is new (no column additions to existing tables).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_node_scope_scope
    ON node_scope(scope);
`);
```

**meta stamp pattern** (lines 339–352 — how `schema_version` is stamped; `embedding_model` should use the same `INSERT OR REPLACE`):
```typescript
const storedRaw = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
  { value: string } | undefined;
const stored = storedRaw ? Number(storedRaw.value) : null;
if (stored === null || stored < SCHEMA_VERSION) {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
  ).run(String(SCHEMA_VERSION));
}
```

**v11 migration must:** read `meta WHERE key='embedding_model'`; if absent (existing DBs) write `'text-embedding-3-small:1536'` (the OLD value so the reembed-cli can detect the mismatch and know a re-embed is required). For fresh DBs, write `'text-embedding-3-small:1536'` on first init — the reembed-cli will then update it to `'text-embedding-3-large:1536'` after the full re-embed completes. The stamp format is `<model>:<dims>` (a single meta value, not two rows).

**Existing `stmtGetMeta` / `stmtSetMeta` prepared statements** in SemanticStore are the runtime read/write path. The migration writes directly via `db.prepare(...)` (consistent with how `schema_version` is written).

---

### `src/db/semantic-store.ts` — clear `embedding_dims` on model change + update meta stamp

**What changes:** The `setEmbedding` L-2 guard (lines 296–303) already asserts `embedding_dims` matches. When the model changes from `small` to `large` (both at 1536 dims), the dims do NOT change — so the L-2 dims guard fires correctly with no code change. However, the `embedding_dims` meta key acts as a guard for future dim changes. No code change is strictly needed for this phase (dims stay 1536).

**Existing setEmbedding guard** (lines 295–303) — for reference only, no change:
```typescript
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

**getMeta / setMeta** — the public read/write path for the new `embedding_model` stamp key:
```typescript
/** Read a meta value by key. Returns null if not found. */
getMeta(key: string): string | null {
  const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Write or overwrite a meta key/value pair. */
setMeta(key: string, value: string): void {
  this.stmtSetMeta.run(key, value);
}
```

The reembed-cli uses `store.setMeta('embedding_model', 'text-embedding-3-large:1536')` after the full re-embed completes.

---

### `src/retrieval/topk.ts` — no code change required

The L-2 dims-mismatch skip guard (lines 133–134) already silently skips vectors whose length doesn't match the query vector. Since both `small` and `large` at 1536 dims produce the same length, no code change is needed. After the re-embed, all stored vectors will be `large@1536`, matching the new query vectors exactly.

**Existing guard** (lines 126–136) — no change, for planner reference:
```typescript
return rows
  .flatMap(row => {
    const v = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    // L-2: skip dimension-mismatched vectors rather than producing NaN scores
    if (v.length !== queryVec.length) return [];
    return [{ id: row.id, score: cosineSimF32(queryVec, v) }];
  })
```

---

### `src/consolidation/consolidator.ts` — `reembedDirty()` already handles tombstoned correctly?

**IMPORTANT FINDING:** The current `reembedDirty()` at lines 288–301 queries:
```typescript
const dirtyRows = this.db
  .prepare('SELECT id, value, value_hash FROM node WHERE embedded_hash IS NULL')
  .all() as Array<{ id: string; value: string; value_hash: string }>;
```

This query covers ALL nodes where `embedded_hash IS NULL` — including `tombstoned=1` rows — because there is no `tombstoned = 0` filter. This matches D-06's requirement that tombstoned nodes be re-embedded. The reembed-cli MUST mirror this inclusive query (no tombstone exclusion filter).

**Full pattern to copy for reembed-cli** (lines 282–302):
```typescript
private async reembedDirty(): Promise<void> {
  const dirtyRows = this.db
    .prepare('SELECT id, value, value_hash FROM node WHERE embedded_hash IS NULL')
    .all() as Array<{ id: string; value: string; value_hash: string }>;

  if (dirtyRows.length === 0) return;

  const values = dirtyRows.map(r => r.value);
  const vecs = await this.provider.embed(values);

  // Synchronous writes after the await (T-02-ASYNC: no await inside any write)
  for (let i = 0; i < dirtyRows.length; i++) {
    // L-1: pass captured value_hash — setEmbedding skips if the value changed (stale guard)
    this.store.setEmbedding(dirtyRows[i]!.id, vecs[i]!, dirtyRows[i]!.value_hash);
  }
}
```

**However:** before calling `reembedDirty`, the reembed-cli must first NULL all embeddings. The pattern for that is a single bulk SQL UPDATE (not via `upsertNode` which re-derives dirty state from value changes):
```sql
UPDATE node SET embedding = NULL, embedded_hash = NULL
```
This is a one-shot bulk write that must happen atomically before any re-embed.

---

### `src/adapter/reembed-cli.ts` (NEW FILE)

**Analog:** `src/adapter/dedup-entities-cli.ts` — same structure: manual CLI, `require.main` guard, dry-run default, lock/DB lifecycle, `resolveDbPath` pattern.

**Imports pattern** (from `dedup-entities-cli.ts` lines 23–33):
```typescript
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
```

Reembed-cli additionally needs `DefaultModelProvider` from `../model/provider` and `OpenAIEmbedder` is reached through it.

**Main provider construction pattern** (from `run-sleep-pass.ts` lines 299–303):
```typescript
const consolidatorProvider = new DefaultModelProvider({
  generateConfig: extractorConfig,
  judgeConfig,
  embedConfig: config,   // <-- embed uses the base config (openaiEmbedModel + embeddingDimensions)
});
```

**Dry-run / real-run structure** (from `dedup-entities-cli.ts` lines 59–144):
```typescript
async function main(): Promise<void> {
  const argv = process.argv;
  const isDryRun = !argv.includes('--no-dry-run'); // default=dry-run

  if (isDryRun) {
    const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
    if (!dbPath) { process.stderr.write('...'); process.exit(0); }
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      initSchema(db);
      // ... count dirty + tombstoned nodes, print plan
    } catch (err) {
      fileLog(`dry-run error: ${err}`);
      process.exitCode = 1;
    } finally {
      db?.close();
    }
    return;
  }

  // Real (mutating) run: validate DB path BEFORE acquiring the lock (WR-02)
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) { process.stderr.write('...'); process.exit(0); }

  if (!acquireLock()) { process.stderr.write('...'); process.exit(0); }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath };
    // ... run re-embed
  } catch (err) {
    fileLog(`error: ${err}`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] reembed FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
```

**Dispatcher registration** (`src/adapter/recense.ts` line 94 pattern):
```typescript
// dedup-entities-cli.ts guards execution with `require.main === module` (it exports ...
case 'dedup-entities': spawnScript('dedup-entities-cli.js', process.argv.slice(3)); break;
```
Add analogously:
```typescript
case 'reembed': spawnScript('reembed-cli.js', process.argv.slice(3)); break;
```
And add `'reembed'` to the usage string on line 108.

**Dry-run output (no DB writes):** query `SELECT count(*) FROM node` and `SELECT count(*) FROM node WHERE tombstoned = 1` to show total vs tombstoned count; confirm current `embedding_model` meta value vs config value.

**Real-run sequence:**
1. Read current `embedding_model` from `store.getMeta('embedding_model')` — log it
2. `db.prepare('UPDATE node SET embedding = NULL, embedded_hash = NULL').run()` — bulk dirty
3. Batch-embed all nodes via `provider.embed()` following `reembedDirty()` pattern (inclusive of tombstoned)
4. `store.setEmbedding(id, vec, valueHash)` for each — L-1 stale guard included
5. `store.setMeta('embedding_model', 'text-embedding-3-large:1536')` — stamp the new model

**BATCHING CONSTRAINT:** `EMBEDDER_MAX_BATCH = 2048` (embedder.ts line 39). The ~3.5k live nodes plus tombstoned rows may exceed 2048 in total. The `OpenAIEmbedder.embed()` already handles chunking internally (embedder.ts lines 90–101) — no manual chunking needed in the CLI.

---

### `src/eval/snapshot.ts` — no code change required

The harness at lines 122–177 calls `embed(texts)` (passed in by the caller) and runs the LLM-free `RetrievalEngine.retrieve()`. After the config change and re-embed, the harness will automatically use the new `text-embedding-3-large` embedder via the `DefaultModelProvider` wired in by the eval script. No changes to this file.

**The harness already takes `embed` as a parameter** (line 123):
```typescript
export async function replaySnapshots(
  db: Database.Database,
  embed: (texts: string[]) => Promise<Float32Array[]>,
  config: EngineConfig,
): Promise<SnapshotResult[]>
```

---

## Shared Patterns

### Lock/DB lifecycle (all CLI adapters)
**Source:** `src/adapter/dedup-entities-cli.ts` lines 104–144
**Apply to:** `src/adapter/reembed-cli.ts`
```typescript
// WR-02: validate dbPath BEFORE acquireLock() so process.exit() with lock held is impossible
const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
if (!dbPath) { process.stderr.write('...'); process.exit(0); }
if (!acquireLock()) { process.stderr.write('...'); process.exit(0); }
let db: Database.Database | undefined;
try {
  db = new Database(dbPath);
  initSchema(db);
  // ... work
} catch (err) {
  fileLog(`error: ${err}`);
  process.exitCode = 1;
} finally {
  db?.close();
  releaseLock();
}
```

### Meta key read/write
**Source:** `src/db/semantic-store.ts` lines 409–418
**Apply to:** reembed-cli reading/writing `embedding_model` meta key
```typescript
store.getMeta('embedding_model')          // returns null if not yet stamped
store.setMeta('embedding_model', value)   // INSERT OR REPLACE
```

### Async-before-sync discipline
**Source:** `src/consolidation/consolidator.ts` lines 282–302 (`reembedDirty`)
**Apply to:** reembed-cli real-run embed loop
All `await provider.embed(values)` calls must complete BEFORE any synchronous `store.setEmbedding()` writes. Never `await` inside a synchronous DB write loop.

### Schema migration pattern (ALTER-free new meta key)
**Source:** `src/db/schema.ts` lines 325–334 (v10), lines 339–352 (schema_version stamp)
**Apply to:** v11 migration in `schema.ts`
The `meta` table already exists (DDL line 67–69). No `ALTER TABLE` needed — just `INSERT OR REPLACE INTO meta`. Use `db.prepare(...).get(...)` to check for the key first, then stamp only when absent (so existing correct stamps are preserved on re-run).

---

## No Analog Found

None. All files either have a direct self-analog or mirror `dedup-entities-cli.ts` exactly.

---

## Critical Implementation Notes for Planner

1. **`embedding_dims` vs `embedding_model` meta keys are distinct.** `embedding_dims` already exists (written by `setEmbedding` L-2 guard). `embedding_model` is new (Phase 26 D-08). Do not conflate them. The dims guard will NOT fire on this swap (both models at 1536 dims) — the model stamp is a separate sentinel.

2. **Tombstoned nodes MUST be re-embedded.** The `reembedDirty()` query in `consolidator.ts` has no `tombstoned = 0` filter. The bulk-null UPDATE and the re-embed loop must match this: `UPDATE node SET embedding = NULL, embedded_hash = NULL` (no WHERE clause excluding tombstoned rows).

3. **Dry-run for reembed-cli opens DB read-only** (same as dedup dry-run) — no lock, no writes. It counts total nodes and tombstoned nodes, reports current vs. target `embedding_model` meta value.

4. **`setEmbedding` dims assertion will re-stamp `embedding_dims` to 1536** on the first write. If `embedding_dims` is already `'1536'` in meta, the assertion passes silently (no change). If for any reason it is missing, it gets written on the first `setEmbedding` call. This is benign.

5. **Dispatcher wiring:** add `case 'reembed': spawnScript('reembed-cli.js', process.argv.slice(3)); break;` to `src/adapter/recense.ts` following the `dedup-entities` precedent at line 94. Update the usage string at line 108.

---

## Metadata

**Analog search scope:** `src/adapter/`, `src/db/`, `src/model/`, `src/consolidation/`, `src/retrieval/`, `src/lib/`, `src/eval/`
**Files scanned:** 12
**Pattern extraction date:** 2026-06-18
