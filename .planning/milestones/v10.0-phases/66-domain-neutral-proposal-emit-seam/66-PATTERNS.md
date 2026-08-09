# Phase 66: Domain-Neutral Proposal Emit Seam - Pattern Map

**Mapped:** 2026-08-03
**Files analyzed:** 7 (2 new modules, 1 new table via existing schema file, 2 modified files, 1 extended test, 1 new test group)
**Analogs found:** 7 / 7

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/consolidation/action-proposal-sink.ts` (NEW — or co-located in existing file, planner discretion) | service (sink interface + impls) | event-driven | `src/consolidation/sink.ts` (`ConsolidationSink`/`NoopConsolidationSink`/`SQLiteConsolidationSink`) | exact |
| `src/db/schema.ts` (MODIFIED — add `action_proposal` DDL + v17 migration block) | migration | CRUD (DDL) | `src/db/schema.ts` itself — `surfaced_event` DDL (:202-212) + v9 migration (:383-385) + `uq_episode_source_external` (:246-253) | exact (self-analog, brand-new-table precedent) |
| `src/db/proposal-store.ts` (NEW, suggested path per CONTEXT D-13/discretion) | model/store | CRUD | `src/db/surface-store.ts` | exact |
| `src/adapter/serve-cli.ts` (MODIFIED — two new routes) | route/controller | request-response | `src/adapter/serve-cli.ts` itself — `/v1/surface` (:401-431) + `/v1/surface/seen` (:433-510) | exact (self-analog) |
| `src/adapter/memory-ops.ts` (MODIFIED — new `listProposals`/`approveProposal`/`rejectProposal` ops functions backing the routes) | service | CRUD | `src/adapter/memory-ops.ts` itself — `surface()` (:440-447, lock-free read) + `surfaceSeen()` (:449-484, per-call lock) | exact (self-analog) |
| `src/consolidation/consolidator.ts` (MODIFIED — emission call sites inside `applyDecision`) | service (wiring, not new file) | event-driven | same file's existing `this.sink.emit(...)` call sites (:1290, :1322, :1343, :1367, :1468, :1497) | exact |
| `tests/emission-hold-sentinel.test.ts` (MODIFIED — extend to real `ActionProposalSink`) | test | event-driven | itself (Half A behavioral + Half B structural scan already shipped) | exact |
| `tests/action-proposal-write-isolation.test.ts` (NEW — "D-43-for-proposals" sentinel, two-layer) | test | event-driven / structural | `tests/no-ats-domain-table.test.ts` (exported predicate + real-scan + planted-offender) for the structural half; `src/adapter/memory-ops.ts` `surfaceSeen()`'s D-43 comment + `tests/emission-hold-sentinel.test.ts`'s whole-DB-row-comparison style for the runtime half | role-match (structural test) / exact (runtime sentinel style) |
| `tests/proposal-route-online-sentinel.test.ts` (NEW — extend 63's D-13 fail-if-called ModelProvider regression to `/v1/proposals`) | test | request-response | 63's fail-if-called `ModelProvider` online sentinel (referenced in CONTEXT; same file family as `tests/emission-hold-sentinel.test.ts`'s `MarkerProvider`/throw-on-call pattern) | role-match |

## Pattern Assignments

### `src/consolidation/action-proposal-sink.ts` (service, event-driven)

**Analog:** `src/consolidation/sink.ts` (full file, 203 lines — read whole, small enough)

**Header/doc comment convention** (lines 1-31): every sink file opens with a structured doc block: what SEAM this is, atomicity guarantee (same-transaction), what each stamped field is (id/ts/schema_version), list of implementations, threat-mitigation bullets (`T-xx-xxx:` prefixed). Mirror this shape exactly for the proposal sink, substituting `EMIT-0x` mitigation ids.

**Imports pattern** (lines 32-36):
```typescript
import type Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../db/schema';
import { newId } from '../lib/hash';        // proposal sink needs sha256 too — same module
import type { Clock } from '../lib/clock';
import type { EventStore } from '../db/event-store';   // swap for ProposalStore
```

**Interface (narrow, synchronous seam)** (lines 86-93):
```typescript
/**
 * Narrow seam called synchronously inside per-episode db.transaction (D-48).
 * No async/await — better-sqlite3 is synchronous; an await between the graph
 * mutation and its emit would break the atomicity guarantee.
 */
export interface ConsolidationSink {
  emit(event: ConsolidationEventInput): void;
}
```
Copy verbatim as `ActionProposalSink { emit(proposal: ActionProposalInput): void }` — same "no async/await" doc line applies (D-06's same-transaction prescription).

**SQLite implementation — mint stamped fields, delegate to store** (lines 99-127):
```typescript
export class SQLiteConsolidationSink implements ConsolidationSink {
  private readonly eventStore: EventStore;
  private readonly clock: Clock;

  constructor(eventStore: EventStore, clock: Clock) {
    this.eventStore = eventStore;
    this.clock = clock;
  }

  emit(event: ConsolidationEventInput): void {
    this.eventStore.append({
      id: newId(),
      ts: this.clock.nowMs(),
      schema_version: SCHEMA_VERSION,
      event_type: event.event_type,
      // ...rest of fields with ?? null fallbacks
    });
  }
}
```
For `SQLiteActionProposalSink`: the `id` field is NOT `newId()` (random UUID) — per D-07 it must be the deterministic `sha256(...)` content hash over `(entity_node_id, field, from, to, evidence_episode)`. This is the one deliberate deviation from the copy — call out in the plan.

**Noop default** (lines 133-138):
```typescript
export class NoopConsolidationSink implements ConsolidationSink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emit(_event: ConsolidationEventInput): void {
    // Intentional no-op — used as the default when no sink is injected.
  }
}
```
Copy verbatim as `NoopActionProposalSink`.

**Constructor injection convention** (`src/consolidation/consolidator.ts` :326-344):
```typescript
constructor(
  db: Database.Database,
  episodes: EpisodicStore,
  store: SemanticStore,
  strength: StrengthDecayManager,
  retriever: CandidateRetriever,
  provider: ModelProvider,
  inducer: SchemaInducer,
  config: EngineConfig,
  clock: Clock = realClock,
  sink: ConsolidationSink = new NoopConsolidationSink(),
  log: (msg: string) => void = () => {},
  deriver: SchemaRelationDeriver | NoopSchemaRelationDeriver = new NoopSchemaRelationDeriver(),
  corpusPromoter: CorpusPromoter | NoopCorpusPromoter = new NoopCorpusPromoter(),
  insightReflector: InsightReflector | NoopInsightReflector = new NoopInsightReflector(),
  docGraphDeriver: DocGraphDeriver | NoopDocGraphDeriver = new NoopDocGraphDeriver(),
) {
```
Every optional cross-cutting sink/deriver in this constructor follows the same shape: trailing parameter, `Type | NoopType = new NoopType()` default. Add `proposalSink: ActionProposalSink = new NoopActionProposalSink()` as one more trailing param — matches D-04's "same constructor/injection style" instruction exactly, and preserves existing test call sites that don't pass it.

---

### `src/db/schema.ts` (migration, DDL)

**Analog:** same file — `surfaced_event` DDL + v9 migration (this table shipped as a brand-new operational table exactly like `action_proposal` will)

**DDL block style** (lines 198-212):
```sql
-- SURF-02: operational surface-outcome log (append-only, single-writer: serve path only).
-- Idempotency key: (node_id, occurrence_due_at) — one row per node per occurrence.
CREATE TABLE IF NOT EXISTS surfaced_event (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id           TEXT    NOT NULL REFERENCES node(id),
  occurrence_due_at TEXT    NOT NULL,
  outcome           TEXT    NOT NULL DEFAULT 'surfaced'
                            CHECK(outcome IN ('surfaced','seen','snoozed','completed','dismissed')),
  snooze_until      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(node_id, occurrence_due_at)
);
```
For `action_proposal`: use `id TEXT PRIMARY KEY` (not AUTOINCREMENT — deterministic hash per D-07), `entity_node_id TEXT NOT NULL REFERENCES node(id)`, a `CHECK(status IN ('pending','approved','rejected','superseded','expired'))` in the exact same inline style, `created_at`/`updated_at INTEGER NOT NULL` epoch ms.

**SCHEMA_VERSION bump comment convention** (line 11-12):
```typescript
// v16: episode.event_ts (EMAIL-04: source-asserted event time)
export const SCHEMA_VERSION = 16;
```
Change to `// v17: action_proposal operational table (EMIT-01/02)` / `export const SCHEMA_VERSION = 17;`.

**Migration-block convention for a brand-new table (no ALTER needed)** (lines 383-394, the v9 migration — this is the load-bearing precedent, not the v2/v3 ALTER-guard pattern):
```typescript
// v9 migration: surfaced_event operational table (Phase 21, SURF-02).
// Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
// Existing v8 DBs: surfaced_event absent → DDL above creates it (IF NOT EXISTS catches it).
// No ALTER TABLE needed — the whole table is new.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_surfaced_event_node_occ
    ON surfaced_event(node_id, occurrence_due_at);
  CREATE INDEX IF NOT EXISTS idx_surfaced_event_outcome
    ON surfaced_event(outcome, snooze_until);
`);
```
Add a `// v17 migration: action_proposal operational table (Phase 66, EMIT-01/02).` block with the same three-comment shape (DDL-covers-fresh, no-ALTER-needed-whole-table-new) plus indexes on `(entity_node_id, status)` and `(status, expires_at)` for the D-10 stale-check query and the pending-list query.

**Dedup/idempotency precedent for the deterministic id** (lines 246-253):
```typescript
// uq_episode_source_external: the dedup backstop (D-59). NULL external_id rows are
// treated as distinct by SQLite's unique index semantics
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_episode_source_external
    ON episode(source, external_id);
`);
```
`action_proposal.id` being a content hash TEXT PRIMARY KEY makes `INSERT OR IGNORE` the direct mechanism (no separate UNIQUE index needed — the PK itself is the natural key) — simpler than this precedent, but this is the shipped justification to cite for "why a natural-key collision is safe to ignore silently."

**Tail-of-function stamp guard** (lines 649-665) — unchanged, no action needed; `initSchema` already throws on downgrade and stamps forward. New table just needs to exist before this runs (DDL/migration block placement above it in file order, matching v9's placement before v10).

---

### `src/db/proposal-store.ts` (model/store, CRUD)

**Analog:** `src/db/surface-store.ts` (full file, 294 lines — read whole, small enough)

**Class shape: prepared statements built once in constructor** (lines 145-208):
```typescript
export class SurfaceStore {
  private readonly db: Database.Database;
  private readonly clock: Clock;

  private readonly stmtEligible: Database.Statement;
  private readonly stmtCapWindowRows: Database.Statement;
  private readonly stmtSurfacedEvent: Database.Statement;

  constructor(db: Database.Database, clock: Clock) {
    this.db    = db;
    this.clock = clock;
    this.stmtEligible = db.prepare(`SELECT ... FROM node_temporal nt JOIN node n ...`);
    // ...
  }
```
Mirror for `ProposalStore`: prepared statements for `insert` (called inside the consolidator's transaction, D-06), `listPending` (status='pending', for GET /v1/proposals), `getById` (for approve/reject), `updateStatus` (approve/reject write path — status + updated_at ONLY, never touches `node`).

**Bound-parameter discipline (T-01-SQL)** — every query in `surface-store.ts` uses named bound params (`@pastCutoff`, `@node_id`, `@occurrence_due_at`), never string interpolation. Apply identically to `proposal-store.ts` (`@status`, `@id`, `@now`).

**Pure exclusion/business-logic helper kept outside the class** (lines 118-139, `isExcluded`):
```typescript
function isExcluded(evt: SurfacedEventRow | undefined, nowMs: number): boolean {
  if (!evt) return false;
  const { outcome, snooze_until } = evt;
  if (outcome === 'completed' || outcome === 'dismissed') return true;
  if (outcome === 'snoozed') {
    return snooze_until !== null && new Date(snooze_until).getTime() > nowMs;
  }
  if (outcome === 'surfaced' || outcome === 'seen') return true;
  return false;
}
```
Model D-10's "belief moved on" / expiry / tombstone staleness check as an equivalent pure function (e.g. `isStale(proposal, currentNodeValue, nowMs): 'ok' | 'superseded' | 'expired'`) — same shape: pure, no DB I/O, called by the store or the ops layer at approve time.

**Public row type + options interface convention** (lines 55-76): a plain exported interface for the returned item shape (`SurfaceItem`) and a separate `Opts` interface for call parameters. Mirror with `ProposalRecord`/`ProposalListOpts`.

**Read-only-by-construction doc comment** (line 4, line 213): `rank() is read-only by construction — D-43.` — `ProposalStore.listPending()` should carry the identical style of comment since it backs the lock-free GET route.

---

### `src/adapter/serve-cli.ts` (route/controller, request-response)

**Analog:** same file — `/v1/surface` (GET, lock-free) + `/v1/surface/seen` (POST, per-call lock)

**GET route — lock-free read, query-param parsing, try/catch/log/500** (lines 401-431):
```typescript
// GET /v1/surface — LLM-free ranked surface items; lock-free read (D-95, T-12-02 N/A)
if (url === '/v1/surface' && req.method === 'GET') {
  try {
    const sp = new URL(req.url ?? '/', 'http://x').searchParams;
    const surfaceOpts: { maxNonP0?: number; gracePeriodMs?: number } = {};
    const limitRaw = sp.get('limit');
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (Number.isFinite(n) && n > 0) surfaceOpts.maxNonP0 = Math.min(Math.floor(n), 50);
    }
    const items = await ops.surface(Object.keys(surfaceOpts).length > 0 ? surfaceOpts : undefined);
    jsonOk(res, { items });
    logRequest('GET', url, 200, Date.now() - start);
  } catch (err) {
    log(`/v1/surface error: ${err}`);
    jsonError(res, 500, { error: 'internal_error' });
    logRequest('GET', url, 500, Date.now() - start);
  }
  return;
}
```
Copy this exact structure for `GET /v1/proposals` — comment tag `(D-95-equivalent, lock-free read)`, optional `?status=` query param (planner discretion per CONTEXT), `ops.listProposals(...)`.

**POST route — read body, validate BEFORE any write, per-call lock, typed error mapping** (lines 433-510):
```typescript
// POST /v1/surface/seen — record outcome; per-call lock (T-12-02)
if (url === '/v1/surface/seen' && req.method === 'POST') {
  const rawBody = await readBody(req);
  if (rawBody === null) { jsonError(res, 413, { error: 'payload_too_large' }); ... return; }
  let parsed: { ... };
  try { parsed = JSON.parse(rawBody) as typeof parsed; } catch {
    jsonError(res, 400, { error: 'bad_request', detail: 'invalid json' }); ... return;
  }
  // T-21-07: validate all fields before any write
  if (typeof parsed.node_id !== 'string' /* ... */) {
    jsonError(res, 400, { error: 'bad_request', detail: '...' }); ... return;
  }
  try {
    const ack = await ops.surfaceSeen({ ... });
    jsonOk(res, ack);
    logRequest('POST', url, 200, Date.now() - start);
  } catch (err) {
    if (err instanceof MemoryBusyError) {
      jsonError(res, 503, { error: 'service_unavailable', detail: 'memory busy; retry in a moment' });
      ... return;
    }
    if (err instanceof SurfaceTargetNotFoundError) {
      jsonError(res, 404, { error: 'not_found', detail: 'node_id does not exist' });
      ... return;
    }
    log(`/v1/surface/seen error: ${err}`);
    jsonError(res, 500, { error: 'internal_error' });
    ... return;
  }
  return;
}
```
Copy this exact structure for `POST /v1/proposals/:id/approve` and `POST /v1/proposals/:id/reject` (two routes, or one route parameterized by the trailing path segment — planner discretion on routing style; note this file uses flat `url ===` string equality, so a `:id` segment requires either a regex/split on `url`, or two fixed prefixes checked with `.startsWith('/v1/proposals/') && url.endsWith('/approve')`). D-10's refusal is a NEW error type (e.g. `ProposalStaleError`) mapped to 409 exactly the way `SurfaceTargetNotFoundError` maps to 404 here — same `if (err instanceof X)` chain shape, same "explicit distinct response, never silent success" requirement from D-10.

**Auth gate — fires before ALL non-/health routes, unconditionally** (lines 278-290):
```typescript
if (url === '/health' && req.method === 'GET') { jsonOk(res, { status: 'ok', version: pkgVersion }); ... return; }
if (!checkAuth(req, opts.token)) {
  jsonError(res, 401, { error: 'unauthorized' });
  logRequest(req.method ?? 'UNKNOWN', url, 401, Date.now() - start, true);
  return;
}
```
No change needed — the two new routes land AFTER this gate (same as `/v1/surface`), inheriting T-12-03/T-12-04/T-12-05 automatically. Nothing to write for auth; just placement.

**jsonOk/jsonError helpers** (lines 199-209) — reuse verbatim, no new helper needed.

---

### `src/adapter/memory-ops.ts` (service, CRUD)

**Analog:** same file — `surface()` (lock-free) + `surfaceSeen()` (per-call lock, fail-fast-before-lock, try/finally release)

**Lock-free read op** (lines 439-447):
```typescript
/**
 * (or writeDb fallback when separateReadHandle is false). NO lock acquisition —
 * mirrors the search() read-only discipline (D-95).
 * D-43: surface() never writes. SurfaceStore.rank() is read-only by construction.
 */
async function surface(opts?: SurfaceOpts): Promise<SurfaceItem[]> {
  return surfaceStore!.rank({ nowMs: realClock.nowMs(), ...opts });
}
```
Model `listProposals()` on this exactly — no lock, delegates straight to `proposalStore.listPending(...)`.

**Write op — fail-fast-before-lock, single-writer lock, try/finally, typed errors** (lines 449-484):
```typescript
async function surfaceSeen(params: SurfaceSeenParams): Promise<{ status: string }> {
  const outcome = params.outcome ?? 'seen';

  // T-21-08: fast-fail for unknown node_id — no orphan rows (check BEFORE lock).
  const exists = stmtNodeExists.get(params.node_id);
  if (!exists) {
    throw new SurfaceTargetNotFoundError(params.node_id);
  }

  // Single-writer lock per call (T-12-02) — coexists with the hourly sleep pass.
  if (!(await acquireLockWithRetry())) {
    throw new MemoryBusyError();
  }
  try {
    stmtUpsertSurfacedEvent.run({ ... });
    return { status: 'recorded' };
  } finally {
    releaseLock();
  }
}
```
Model `approveProposal(id)`/`rejectProposal(id)` on this exactly:
1. Fast-fail BEFORE lock: proposal doesn't exist → 404-class error; proposal not `status='pending'` → conflict-class error (this IS the D-10 refusal path — do the "belief moved on"/tombstoned/expired re-check here, before acquiring the lock, since it's a pure read comparison against current node state).
2. Acquire lock (`acquireLockWithRetry()` / `MemoryBusyError` on failure) — needed because the write itself (status UPDATE) must be serialized against the sleep pass same as `surfaceSeen`.
3. try/finally around the single `UPDATE action_proposal SET status=?, updated_at=? WHERE id=?` — **this is the entire write**, per D-08/D-09 ("D-43-for-proposals"): no `node`/`edge` table touch anywhere in this function body.

**D-43 comment convention to replicate verbatim in spirit** (line 457): `// D-43: NEVER writes to node.s or node.c. Only surfaced_event is touched.` — write the exact analogous comment on `approveProposal`/`rejectProposal`: `// D-43-for-proposals: NEVER writes to node/edge. Only action_proposal.status (+updated_at) is touched.`

**Error class convention** (lines 116-131, `MemoryBusyError`/`SurfaceTargetNotFoundError`):
```typescript
export class SurfaceTargetNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`surface target not found: ${nodeId}`);
    this.name = 'SurfaceTargetNotFoundError';
  }
}
```
Add `ProposalNotFoundError` and `ProposalStaleError` (or `ProposalSupersededError`/`ProposalExpiredError` if the plan wants distinct terminal statuses distinguishable at the HTTP layer) following this exact two-line shape.

---

### `src/consolidation/consolidator.ts` (wiring inside `applyDecision`, event-driven)

**Analog:** same file's existing decisive-branch `sink.emit` call sites

**Site 1 — `contradict_reconcile` (mid-band tombstone-and-replace)** (lines 1477-1506, specifically 1497-1505):
```typescript
this.store.tombstone(decision.bestCandidateId);
const reconciledId = newId();
this.store.upsertNode({
  id: reconciledId, type: decision.claimType as 'entity' | 'fact' | 'schema',
  value: decision.claimValue, origin: decision.claimOrigin, prev_value: node.value,
});
if (decision.claimVec) { this.store.setEmbedding(reconciledId, decision.claimVec); }
this.maybeWriteNodeTemporal(reconciledId, decision);
// SEAM-02 D-49: tombstone-and-replace → 'contradict_reconcile'
this.sink.emit({
  event_type: 'contradict_reconcile',
  node_id: reconciledId,
  candidate_id: decision.bestCandidateId,
  episode_id: episodeId,
  value: decision.claimValue,
  origin: decision.claimOrigin,
  magnitude: decision.magnitude,
});
```
**Emission wiring pattern (add immediately after each of the 6 existing `this.sink.emit(...)` calls, at :1290/:1322/:1343/:1367/:1468/:1497):**
```typescript
if (isEmissionEligible(decision.relation === 'confirm' ? 'confirm' : /* map decision.relation → the exact event_type string used at THIS call site */ eventTypeAtThisSite)
    && decision.<resolved-entity-fields-present>) {
  this.proposalSink.emit({
    entity_node_id: <the node id this call site already computes: reconciledId / oscId / appendNewId / forceDestabilizeId>,
    // proposed_change: { field, from: node.value (or node.prev_value), to: decision.claimValue }
    evidence_episode: episodeId,
    evidence_quote: <verbatim slice of episode content — fetch via episodes store>,
    confidence: <63's D-06 coarse vocabulary, carried on decision>,
  });
}
```
Import `isEmissionEligible` from `../consolidation/status-drift` (NOT re-derived — D-05 is explicit on this). The gate is `isEmissionEligible(<the literal event_type string already passed to `this.sink.emit` at that exact call site>)` — since `EMISSION_ELIGIBLE_EVENT_TYPES` only contains `contradict_reconcile`/`contradict_append_new`/`contradict_force_destabilize`, in practice only 3 of the 6 existing `sink.emit` call sites (:1497 reconcile, the append-new site, and the force-destabilize site — NOT :1290 confirm, :1322/:1343/:1367 extend/unrelated/oscillation) ever pass the gate; still call the gate explicitly at all 6 sites per D-05's literal instruction rather than hand-picking 3, so a future new branch can't silently bypass the check.

**D-06 same-transaction placement** — every one of these `sink.emit` calls already sits inside the per-episode transaction the whole `applyDecision` runs in (see `sink.ts`'s header T-05-SINK-TX doc, lines 24-26) — no new transaction wiring needed; the proposal INSERT (via `this.proposalSink.emit(...)` → `SQLiteActionProposalSink` → `ProposalStore.insert(...)`) lands in the exact same `db.transaction` scope automatically by virtue of using the same `this.db` handle, synchronously, with no `await` in between (mirrors D-48's guarantee).

---

### `tests/emission-hold-sentinel.test.ts` (test, event-driven — EXTEND not replace)

**Analog:** itself, full file (523 lines — already read whole)

**What "extend to the real sink" means concretely:**
- `makeConsolidatorWithRealSink(h, provider)` (lines 140-147) currently wires only a real `SQLiteConsolidationSink`, passed as the `sink` constructor param. Add a real `SQLiteActionProposalSink` (once it exists) as the new trailing `proposalSink` constructor arg, backed by a real `ProposalStore`/`action_proposal` table in the same in-memory `h.db`.
- The Half A behavioral assertions (`consolidationEventRowsForCandidate` + `isEmissionEligible` filter, lines 226-400) need a parallel assertion reading `action_proposal` rows directly: the "ambiguous low-confidence contradiction produces zero emission-eligible rows" test (line 233) should ALSO assert zero `action_proposal` rows for that node; the "three distinct-provenance...cross force-destabilize" counterexample (line 307) should ALSO assert exactly one `action_proposal` row was minted.
- The Half B structural scan's `FORBIDDEN_EMISSION_IDENTIFIERS` list (lines 427-433) should gain `'proposalSink.emit'`/`'ActionProposalSink'` tokens if not already covered by the existing `'proposalSink'`/`'ActionProposalSink'` entries (they already are — lines 429-430 — so Half B needs NO changes, only re-verification against the real sink name chosen).
- Header comment (lines 1-47) should be updated in place to note the sentinel now runs against the REAL `ActionProposalSink`, not just the interface-shaped identifier list, closing the promise made at line 9-11.

**Whole-DB snapshot comparison style to reuse for D-43-for-proposals (Half B analog for the NEW test file)** — `getNodeById` (lines 156-160) + byte-comparison-by-refetch idiom used throughout 63/64/65 test suites: read the full `node` row before and after the operation under test, `expect(before).toEqual(after)`.

---

## Shared Patterns

### Authentication
**Source:** `src/adapter/serve-cli.ts` lines 278-290 (auth gate, unconditional for all non-`/health` paths) + lines 130-153 (`checkAuth`, constant-time compare)
**Apply to:** Both new `/v1/proposals*` routes — no new code needed, just correct placement after the existing gate.

### Single-writer lock discipline (T-12-02)
**Source:** `src/adapter/memory-ops.ts` lines 468-483 (`surfaceSeen`'s acquire/try/finally-release/MemoryBusyError shape)
**Apply to:** `approveProposal`/`rejectProposal` — the two write ops backing `POST /v1/proposals/:id/approve|reject`.

### Lock-free read discipline (D-95 precedent)
**Source:** `src/adapter/memory-ops.ts` lines 439-447 (`surface()`) + `src/db/surface-store.ts` line 4/213 doc comments ("read-only by construction")
**Apply to:** `listProposals()` backing `GET /v1/proposals`.

### Error response mapping (typed Error subclass → HTTP status)
**Source:** `src/adapter/serve-cli.ts` lines 494-504 (`MemoryBusyError` → 503, `SurfaceTargetNotFoundError` → 404) + `src/adapter/memory-ops.ts` lines 116-131 (error class definitions)
**Apply to:** New `ProposalNotFoundError` → 404, new stale/superseded/expired refusal error → 409 (D-10's explicit "409-class, never silent success" requirement).

### Deterministic content-hash id (replaces newId()/UUID for this one record type)
**Source:** `src/lib/hash.ts` lines 8-10 (`sha256`, already-shipped `node:crypto` wrapper — net-zero new dependency)
**Apply to:** `SQLiteActionProposalSink`'s id-minting step (D-07) — `sha256(JSON.stringify({ entity_node_id, field, from, to, evidence_episode }))` or equivalent stable serialization; exact encoding is planner discretion, but MUST reuse `sha256()` rather than hand-rolling `node:crypto` calls inline (matches the file's own "Don't Hand-Roll" convention note).

### Additive-migration + SCHEMA_VERSION bump discipline
**Source:** `src/db/schema.ts` lines 11-12 (version comment + bump), lines 383-394 (v9 brand-new-table migration block — the correct precedent, NOT the v2/v3 ALTER-guard pattern since `action_proposal` has no existing rows to migrate)
**Apply to:** The `action_proposal` DDL block + `// v17 migration:` comment block + `SCHEMA_VERSION = 17`.

### Structural "no forbidden identifier" test shape (exported predicate + real scan + planted offender)
**Source:** `tests/no-ats-domain-table.test.ts` (full pattern, lines 1-90+) and `tests/src-import-boundary.test.ts` (lines 1-70+) — both: `export function findXOffenders(...)`, a real-`src/`-walk test asserting `[]`, and a non-vacuousness test planting a synthetic offender through the SAME exported function.
**Apply to:** The new "D-43-for-proposals" structural half (D-09a) — export a `findWriteIsolationOffenders(files)` that greps for `UPDATE node`/`SET s`/`SET c` inside `proposal-store.ts` + the two new route handler blocks, plus an import-boundary check that `proposal-store.ts` never imports `semantic-store.ts`'s write API (`SemanticStore`/`upsertNode`/`setEmbedding`/`tombstone`).

## No Analog Found

None — every file in this phase's scope has a direct or near-direct shipped precedent (this milestone is explicitly a "copy-adapt, not an invention" per the CONTEXT's own framing of the `ConsolidationSink` triad, D-04).

## Metadata

**Analog search scope:** `src/consolidation/`, `src/db/`, `src/adapter/`, `src/lib/`, `src/strength/`, `tests/` (targeted reads only — no full-repo scan needed; CONTEXT.md's `canonical_refs` already pinpointed exact files/line numbers, confirmed against live source)
**Files scanned (Read/Grep):** `src/consolidation/sink.ts` (full), `src/consolidation/status-drift.ts` (:160-200), `src/consolidation/consolidator.ts` (:1260-1520, :326-344, :153-193), `src/db/schema.ts` (:1-30, :190-260, :360-420, :625-666), `src/db/surface-store.ts` (full), `src/adapter/serve-cli.ts` (:1-60, :195-300, :370-520), `src/adapter/memory-ops.ts` (:440-494 + grep-located sections), `src/lib/hash.ts` (full), `tests/emission-hold-sentinel.test.ts` (full), `tests/no-ats-domain-table.test.ts` (:1-90), `tests/src-import-boundary.test.ts` (:1-70), `src/lib/config.ts` (grep for dark-knob convention), `.planning/phases/64-entity-resolution-hardening/64-CONTEXT.md` (grep for D-08 descriptor semantics)
**Pattern extraction date:** 2026-08-03
