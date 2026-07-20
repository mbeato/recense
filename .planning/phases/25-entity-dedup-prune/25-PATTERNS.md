# Phase 25: Entity Dedup / Prune - Pattern Map

**Mapped:** 2026-06-18
**Files analyzed:** 3 new/modified files
**Analogs found:** 3 / 3

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/consolidation/entity-dedup.ts` | service | batch, transform | `src/consolidation/consolidator.ts` | role-match (same offline pass shape, same store primitives) |
| `src/adapter/dedup-entities-cli.ts` | CLI adapter | request-response | `src/adapter/import-memory-cli.ts` | exact (--dry-run pattern, lock/DB open, same bootstrap shape) |
| `src/db/semantic-store.ts` (small additions) | store | CRUD | `src/db/semantic-store.ts` itself | self-analog (additive prepared statements only) |

---

## Pattern Assignments

### `src/consolidation/entity-dedup.ts` (service, batch/transform)

**Analog:** `src/consolidation/consolidator.ts` + `src/consolidation/run-sleep-pass.ts`

**Imports pattern** (`consolidator.ts` lines 31-51):
```typescript
import Database, { type Statement } from 'better-sqlite3';
import { realClock, type Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { SemanticStore } from '../db/semantic-store';
import { cosineSimF32 } from '../retrieval/topk';
import type { NodeRow, EdgeRow, EdgeKind } from '../lib/types';
import { newId } from '../lib/hash';
import { normalizeValue } from './normalize';
import { EventStore } from '../db/event-store';
import { SQLiteConsolidationSink } from './sink';
import { SCHEMA_VERSION } from '../db/schema';
```

**Prepared statement pattern** (`consolidator.ts` lines 213-227, `semantic-store.ts` lines 72-75):
```typescript
// Compile once in constructor — never per-call (T-01-SQL, mirrors SemanticStore pattern)
// All ? / @named params; no string interpolation.
this.stmtLiveEntities = db.prepare(
  `SELECT id, value, c, last_access, origin, prev_value, embedding
   FROM node WHERE type = 'entity' AND tombstoned = 0`
);
// Node degree query for canonical selection (D-05)
this.stmtNodeDegree = db.prepare(
  `SELECT (SELECT COUNT(*) FROM edge WHERE src = ?) +
          (SELECT COUNT(*) FROM edge WHERE dst = ?) AS degree`
);
// Edge rewire reads (both directions — mirrors SemanticStore stmtGetOutEdges / stmtGetInEdges)
this.stmtEdgesWithSrc = db.prepare(
  'SELECT src, dst, rel, w, last_access, kind FROM edge WHERE src = ?'
);
this.stmtEdgesWithDst = db.prepare(
  'SELECT src, dst, rel, w, last_access, kind FROM edge WHERE dst = ?'
);
```

**Cosine similarity reuse** (`topk.ts` lines 19-30 — import and call directly):
```typescript
import { cosineSimF32 } from '../retrieval/topk';

// Inside cluster confirmation (Stage 2):
const v1 = decodeEmbedding(nodeA.embedding);  // Float32Array decode (Pitfall 5)
const v2 = decodeEmbedding(nodeB.embedding);
if (v1 && v2) {
  const sim = cosineSimF32(v1, v2);
  // cosine >= MERGE_THRESHOLD (D-01, default 0.88) → confirmed pair
}

// Buffer → Float32Array decode (Pitfall 5 pattern from topk.ts lines 128-133):
function decodeEmbedding(buf: Buffer | null): Float32Array | null {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
```

**normalizeValue blocking key** (`normalize.ts` lines 18-20):
```typescript
import { normalizeValue } from './normalize';
// Stage-1 blocking: bucket by normalizeValue(node.value)
const blockingKey = normalizeValue(node.value);
```

**Transaction pattern — synchronous, IMMEDIATE mode** (`consolidator.ts` lines 694-703 + `semantic-store.ts` lines 192-245):
```typescript
// ALL async work (embedding decode, cosine) must complete BEFORE any db.transaction.
// No await inside any db.transaction (T-02-ASYNC).
// Use .immediate() to prevent SQLITE_BUSY_SNAPSHOT in WAL mode (M-5).
//
// One transaction per cluster merge (mirrors one-transaction-per-episode in consolidator):
this.db.transaction(() => {
  // 1. Rewire edges (delete-old-edge + upsertEdge canonical) in FK-safe order (D-08)
  for (const dup of duplicateIds) {
    rewireEdgesForDuplicate(dup, canonicalId);
  }
  // 2. Assert PRAGMA foreign_key_check is empty BEFORE commit (D-08 load-bearing guard)
  const fkViolations = this.db.pragma('foreign_key_check') as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(`FK check failed for cluster ${canonicalId}: ${JSON.stringify(fkViolations)}`);
  }
  // 3. Tombstone duplicates (never delete — D-09)
  for (const dup of duplicateIds) {
    this.store.tombstone(dup);
  }
  // 4. Write consolidation_event rows (D-10)
  for (const dup of duplicateIds) {
    this.sink.emit({ event_type: 'entity_merge', node_id: canonicalId, candidate_id: dup, ... });
  }
}).immediate();
```

**FK-safe edge rewire pattern** (from T-FK-01 lesson, `consolidator.ts` lines 656-664):
```typescript
// T-FK-01: never write an edge referencing a non-existent / about-to-be-tombstoned id.
// Delete-old-edge FIRST, then upsertEdge canonical (no FK violation window).
// Drop self-loops (src==dst after rewire) — D-07.
function rewireEdge(oldSrc: string, oldDst: string, rel: string, w: number,
                    lastAccess: number, kind: EdgeKind, canonicalId: string): void {
  const newSrc = oldSrc === dupId ? canonicalId : oldSrc;
  const newDst = oldDst === dupId ? canonicalId : oldDst;
  if (newSrc === newDst) return; // drop self-loop (D-07)
  // Delete the old edge first (FK-safe)
  this.db.prepare('DELETE FROM edge WHERE src = ? AND dst = ? AND rel = ?')
    .run(oldSrc, oldDst, rel);
  // upsertEdge handles PK collision with max(w) / latest last_access (D-07)
  this.store.upsertEdge({ src: newSrc, dst: newDst, rel, w, kind, last_access: lastAccess });
}
```

**upsertEdge ON CONFLICT pattern** (`semantic-store.ts` lines 124-131):
```typescript
// upsertEdge already handles PK (src,dst,rel) collision correctly (D-07):
// ON CONFLICT DO UPDATE SET w = excluded.w, last_access = excluded.last_access, kind = excluded.kind
// For the merge collision, caller passes max(existing_w, rewired_w) before calling upsertEdge.
this.store.upsertEdge({ src, dst, rel, w: Math.max(existingW, rewiredW), kind, last_access });
```

**consolidation_event write pattern** (`sink.ts` lines 110-124, `event-store.ts` lines 36-55):
```typescript
// sink.emit() is sync — safe inside db.transaction (T-05-SINK-TX).
// New event_type 'entity_merge' — no schema change, consolidation_event.event_type is TEXT (D-10).
// payload carries cluster metadata (threshold, cosine score) as JSON string.
this.sink.emit({
  event_type: 'entity_merge',   // new type — extend ConsolidationEventType union
  node_id: canonicalId,          // survivor
  candidate_id: duplicateId,     // tombstoned duplicate
  episode_id: null,              // no episode — offline dedup pass
  value: canonicalNode.value,
  origin: null,
  magnitude: cosineSim,          // repurpose magnitude field for the confirming cosine
  payload: JSON.stringify({
    merge_threshold: MERGE_THRESHOLD,
    cosine: cosineSim,
    cluster_size: cluster.length,
  }),
});
```

**Sidecar handling (node_scope / node_temporal)** (`run-sleep-pass.ts` lines 119-151, CONTEXT.md D-06):
```typescript
// node_scope: if canonical has no scope, inherit from a duplicate's scope.
// Use store.getNodeScope() / store.upsertNodeScope() — same single-writer discipline.
// node_temporal: same — inherit if canonical has none.
// Both sidecars are FK→node and are NOT cascade-deleted on tombstone().
// Read before tombstone; write to canonical if needed.
const canonicalScope = this.store.getNodeScope(canonicalId);
if (!canonicalScope) {
  for (const dup of duplicateIds) {
    const dupScope = this.store.getNodeScope(dup);
    if (dupScope) {
      this.store.upsertNodeScope({ node_id: canonicalId, scope: dupScope, updated_at: clock.nowMs() });
      break;
    }
  }
}
```

**Dry-run report output** (`import-memory-cli.ts` lines 215-230):
```typescript
// Dry-run is stdout only — process.stdout.write, not console.log (mirrors printPlan pattern).
// Build the report from the same clustering logic; no DB writes.
function printDryRun(clusters: MergeCluster[]): void {
  process.stdout.write('recense dedup-entities — DRY RUN (nothing written)\n\n');
  for (const cluster of clusters) {
    process.stdout.write(`  MERGE  canonical: ${cluster.canonical.value}\n`);
    for (const dup of cluster.duplicates) {
      process.stdout.write(`    dup: ${dup.value} (cosine=${dup.cosine.toFixed(3)})\n`);
    }
  }
  process.stdout.write(`\nplan: ${clusters.length} cluster(s), ${totalDups} node(s) would be tombstoned\n`);
}
```

---

### `src/adapter/dedup-entities-cli.ts` (CLI adapter, request-response)

**Analog:** `src/adapter/import-memory-cli.ts` (exact match — same --dry-run default, lock/DB bootstrap, same argv parse shape)

**Imports pattern** (`import-memory-cli.ts` lines 29-40):
```typescript
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { EventStore } from '../db/event-store';
import { SQLiteConsolidationSink } from '../consolidation/sink';
import { EntityDedup } from '../consolidation/entity-dedup';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
```

**Arg parse pattern** (`import-memory-cli.ts` lines 248-253):
```typescript
// Parse --dry-run flag and --db path from argv.
// Validate DB path BEFORE acquiring lock (WR-02: lock-leak prevention).
const argv = process.argv;
const dryRun = argv.includes('--dry-run');
const threshold = parseFloat(
  argv[argv.indexOf('--threshold') + 1] ?? '0.88'  // D-01 default
);
```

**Dry-run short-circuit** (`import-memory-cli.ts` lines 256-259):
```typescript
// --dry-run: no lock, no DB open, no writes — pure read/report.
if (dryRun) {
  // open DB read-only just to enumerate candidates; no lock needed
  // OR: enumerate from a snapshot built without DB if clustering is pure in-memory
  printDryRun(clusters);
  return;
}
```

**Lock + DB open + error handling pattern** (`sleep-pass-cli.ts` lines 46-97 and `import-memory-cli.ts` lines 262-296):
```typescript
// Validate DB path BEFORE lock (WR-02)
const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
if (!dbPath) {
  process.stderr.write('No DB path (--db <path> or RECENSE_DB env var) — exiting\n');
  process.exit(0);
}

if (!acquireLock()) {
  process.stderr.write('Lock held by another process — exiting\n');
  process.exit(0);
}

let db: Database.Database | undefined;
try {
  db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const store = new SemanticStore(db, realClock, config);
  const eventStore = new EventStore(db);
  const sink = new SQLiteConsolidationSink(eventStore, realClock);
  const dedup = new EntityDedup(db, store, sink, realClock, config);
  const result = dedup.run({ threshold, dryRun: false });
  process.stdout.write(
    `dedup-entities: ${result.mergedClusters} cluster(s) merged, ${result.tombstoned} node(s) tombstoned\n`
  );
} catch (err) {
  fileLog(`error: ${err}`);
  process.exitCode = 1;
} finally {
  db?.close();
  releaseLock();
}
```

**Log file pattern** (`sleep-pass-cli.ts` lines 34-38, `import-memory-cli.ts` lines 233-234):
```typescript
const LOG_PATH = '/tmp/recense-dedup-entities.log';

const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] dedup-entities: ${msg}\n`);
```

**`require.main === module` guard** (`import-memory-cli.ts` lines 299-305):
```typescript
// Only run when invoked as entry point — NOT when imported by unit tests.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] dedup-entities FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
```

---

### `src/db/semantic-store.ts` (small additions — batched edge-rewire helpers)

**Analog:** `src/db/semantic-store.ts` itself — additive prepared statements following the exact same constructor-compiled pattern.

**New prepared statement addition pattern** (`semantic-store.ts` lines 46-62 for declaration, lines 137-147 for compile):
```typescript
// In the class body — declare field:
private readonly stmtDeleteEdge: Database.Statement;
private readonly stmtGetAllEdgesForNode: Database.Statement;

// In constructor — compile once (T-01-SQL: bound params, no interpolation):
this.stmtDeleteEdge = db.prepare(
  'DELETE FROM edge WHERE src = ? AND dst = ? AND rel = ?'
);
// Fetch all edges touching a node (both directions) for rewire planning
this.stmtGetAllEdgesForNode = db.prepare(
  'SELECT src, dst, rel, w, last_access, kind FROM edge WHERE src = ? OR dst = ?'
);
```

**Public method shape** (mirrors `upsertEdge` and `getOutEdges` at lines 344-375):
```typescript
/** Delete an edge by PK. Used by edge-rewire pass (T-01-SQL: bound params). */
deleteEdge(src: string, dst: string, rel: string): void {
  this.stmtDeleteEdge.run(src, dst, rel);
}

/** Read all edges where src OR dst equals nodeId (for rewire planning). */
getEdgesForNode(nodeId: string): Array<EdgeRow> {
  return this.stmtGetAllEdgesForNode.all(nodeId, nodeId) as EdgeRow[];
}
```

---

## Shared Patterns

### No async/await inside db.transaction (T-02-ASYNC)
**Source:** `src/consolidation/consolidator.ts` (comment at lines 686-703), `src/db/semantic-store.ts` (comment at lines 183-190)
**Apply to:** `entity-dedup.ts` — all embedding decoding and cosine computation must complete BEFORE entering any `db.transaction()`. The transaction body is pure synchronous prepared-statement calls.
```typescript
// WRONG — never do this:
db.transaction(async () => { ... await something ... });

// CORRECT — T-02-ASYNC pattern:
// Phase A: compute all decisions (cosine sims, cluster assignments) synchronously in-memory
// Phase B: db.transaction(() => { /* only sync store.tombstone(), store.upsertEdge() calls */ }).immediate()
```

### Single-writer store discipline (CONSOL-03)
**Source:** `src/consolidation/consolidator.ts` header comment (lines 1-30)
**Apply to:** `entity-dedup.ts`
All graph writes must route through `SemanticStore` owned primitives (`tombstone()`, `upsertEdge()`, `upsertNodeScope()`, `upsertNodeTemporal()`). No raw SQL writes to `node` or `edge` from `entity-dedup.ts`.

### WR-02 lock-leak prevention
**Source:** `src/adapter/import-memory-cli.ts` (lines 262-269), `src/adapter/sleep-pass-cli.ts` (lines 50-55)
**Apply to:** `dedup-entities-cli.ts`
```typescript
// Validate DB path BEFORE acquireLock() — process.exit() inside try/finally does not
// unwind the stack, so exiting with the lock held leaks it for up to LOCK_STALE_MS.
const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
if (!dbPath) { process.exit(0); }   // EXIT BEFORE lock
if (!acquireLock()) { process.exit(0); }  // EXIT if lock not acquired
// Now safe to enter try/finally
```

### T-01-SQL: bound parameters only
**Source:** `src/db/semantic-store.ts` (header comment lines 8-10, throughout constructor)
**Apply to:** All new prepared statements in `entity-dedup.ts` and any additions to `semantic-store.ts`
```typescript
// Correct — named params or positional ?
db.prepare('SELECT * FROM node WHERE id = ?').get(id)
db.prepare('DELETE FROM edge WHERE src = @src AND dst = @dst AND rel = @rel').run({ src, dst, rel })

// Forbidden — string interpolation
db.prepare(`SELECT * FROM node WHERE id = '${id}'`)  // NEVER
```

### IMMEDIATE transaction mode (M-5)
**Source:** `src/consolidation/consolidator.ts` lines 694-703, `src/db/semantic-store.ts` lines 244-245
**Apply to:** `entity-dedup.ts` cluster-merge transaction
```typescript
// .immediate() prevents SQLITE_BUSY_SNAPSHOT in WAL mode — required for any multi-statement
// write transaction (acquires RESERVED lock upfront, serializing concurrent access).
db.transaction(() => { /* rewire, tombstone, emit */ }).immediate();
```

### Tombstone + FTS sync (never delete)
**Source:** `src/db/semantic-store.ts` lines 306-310
**Apply to:** `entity-dedup.ts` — call `store.tombstone(dupId)`, never `DELETE FROM node`
```typescript
// tombstone() sets tombstoned=1, clears training_eligible=0, removes from node_fts.
// The FTS sync is inside tombstone() — callers do NOT call stmtFtsDelete separately.
tombstone(id: string): void {
  this.stmtTombstone.run(id);
  this.stmtFtsDelete.run(id);
}
```

### ConsolidationEventType extension
**Source:** `src/consolidation/sink.ts` lines 52-63
**Apply to:** Add `'entity_merge'` to the union in `sink.ts` ConsolidationEventType
```typescript
// Current type (lines 53-63) — ADD 'entity_merge':
export type ConsolidationEventType =
  | 'confirm' | 'extend' | 'unrelated'
  | 'contradict_hold' | 'contradict_reconcile' | 'contradict_oscillation'
  | 'contradict_append_new' | 'contradict_force_destabilize'
  | 'schema_emitted' | 'schema_falsified'
  | 'entity_merge';   // Phase 25 addition
```

### PRAGMA foreign_key_check guard (D-08, T-FK-01 lesson)
**Source:** `src/consolidation/consolidator.ts` T-FK-01 comment (lines 658-664), CONTEXT.md D-08
**Apply to:** `entity-dedup.ts` cluster-merge transaction — assert before commit
```typescript
this.db.transaction(() => {
  // ... rewire all edges ...
  // Load-bearing guard: assert FK integrity BEFORE tombstoning duplicates
  const fkViolations = this.db.pragma('foreign_key_check') as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(`FK violation in cluster merge (canonical=${canonicalId}): abort`);
    // Throwing inside transaction causes automatic rollback — no partial merge written
  }
  // FK clean — safe to tombstone
  for (const dup of duplicateIds) { this.store.tombstone(dup); }
  // Emit audit events
}).immediate();
```

---

## No Analog Found

None — all three files have strong analogs in the codebase. The patterns above cover every load-bearing implementation concern.

---

## Metadata

**Analog search scope:** `src/consolidation/`, `src/adapter/`, `src/db/`, `src/retrieval/`, `src/lib/`
**Files scanned:** 12 source files read in full
**Pattern extraction date:** 2026-06-18
