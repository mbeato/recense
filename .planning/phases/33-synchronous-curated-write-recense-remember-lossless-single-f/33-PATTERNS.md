# Phase 33: Synchronous Curated Write (recense remember) - Pattern Map

**Mapped:** 2026-06-20
**Files analyzed:** 1 new + 9 reuse/modify
**Analogs found:** 1/1 new file has an exact analog; all 9 reuse targets verified live

> No RESEARCH.md (research disabled). File list extracted from `33-CONTEXT.md`
> `<canonical_refs>` + `<code_context>` and verified against live source. **All paths and
> symbols below were grep/Read-confirmed in the live tree — drift notes are called out inline.**

---

## File Classification

| New/Modified File | New? | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|------|-----------|----------------|---------------|
| `src/adapter/remember-cli.ts` | **NEW** | adapter / CLI | request-response (sync write) | `src/adapter/dedup-facts-cli.ts` | exact (write-CLI: lock → DB → sink) |
| `src/adapter/recense.ts` | modify | dispatcher | request-response | (self — add `case 'remember'`) | exact |
| `src/db/semantic-store.ts` | reuse | model / store | CRUD | (self — `upsertNode`/`setEmbedding`/`getNode`/`tombstone`/`upsertNodeScope`) | exact |
| `src/consolidation/update-decision.ts` | reuse (pure) | service | transform | (self — `routeContradiction`/`isOscillation`/`countDistinctProvenance`) | exact |
| `src/consolidation/sink.ts` | reuse | service | event-driven | (self — `SQLiteConsolidationSink.emit`) | exact |
| `src/consolidation/consolidator.ts` | reference | service | event-driven | (self — `applyDecision` contradict branch) | exact (copy the branch shape) |
| `src/consolidation/run-sleep-pass.ts` | reuse helpers | service | batch | (self — `stampNodeScopes`, `resolveProviderOverlay`) | exact |
| `src/lib/scope.ts` | reuse (pure) | utility | transform | (self — `cwdToScope`) | exact |
| `src/adapter/lockfile.ts` | reuse | utility | — | (self — `acquireLock`/`releaseLock`) | exact |
| `src/model/claude-headless-client.ts` | reuse (indirect) | model | request-response | (self — via `DefaultModelProvider.judge`) | exact |
| `src/db/schema.ts` | reference / maybe-modify | config | — | (self — `node` table DDL) | exact |

**Key architectural call left to the planner (D-58 discretion):** `remember-cli.ts` may either
(a) construct a one-candidate path through `Consolidator.applyDecision`'s contradict branch, or
(b) build a **thinner bespoke loop** (embed → top-k → judge → route → apply) that calls the same
**pure** `update-decision.ts` functions + the same `SQLiteConsolidationSink`. The analogs below
support **both**; option (b) is the cleaner fit because D-04 force-reconcile must be layered at the
call site (the in-class `applyDecision` cannot be mutated), and because `remember` stores a single
verbatim claim (no extraction, no candidate-set batching).

---

## Pattern Assignments

### `src/adapter/remember-cli.ts` (NEW — adapter/CLI, sync write)

**Analog:** `src/adapter/dedup-facts-cli.ts` (closest live write-capable CLI: validate-args →
acquireLock → open DB → build `SemanticStore` + `EventStore` + `SQLiteConsolidationSink` → run →
release in `finally`; `require.main === module` guard so unit tests can import its helpers).

**File-header + import pattern** (`dedup-facts-cli.ts:28-39`):
```typescript
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { EventStore } from '../db/event-store';
import { SQLiteConsolidationSink } from '../consolidation/sink';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
// ADD for remember: cwdToScope (scope.ts), DefaultModelProvider (model/provider),
// CandidateRetriever (retrieval/topk), resolveProviderOverlay (consolidation/run-sleep-pass),
// routeContradiction/isOscillation (consolidation/update-decision), newId (lib/hash).
```

**Lock + DB + sink construction (real mutating run)** (`dedup-facts-cli.ts:110-150`):
```typescript
// WR-02: validate DB path BEFORE acquiring the lock — process.exit() w/ lock held leaks it.
const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
if (!dbPath) { process.stderr.write('... No DB path ...\n'); process.exit(0); }

// Shared write lock (races the hourly sleep pass — acquireLock FAST-FAILS, no queue)
if (!acquireLock()) {
  process.stderr.write('recense remember: Lock held by another process — exiting\n');
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
  // ... remember work here ...
} catch (err) { fileLog(`error: ${err}`); process.exitCode = 1; }
finally { db?.close(); releaseLock(); }
```

**`require.main` guard at bottom** (`dedup-facts-cli.ts:158-165`) — **MUST** match so the dispatcher's
`spawnScript('remember-cli.js', …)` fires `main()` while unit tests can import exported helpers:
```typescript
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] remember FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
```

> **Note (planner's call, D-58):** CONTEXT.md says in-process `require('./remember-cli')` MAY fit
> better than `spawnScript` because the path holds the lock + runs the judge synchronously. BUT
> every live write-CLI (`dedup-facts`, `dedup-entities`, `import-memory`, `generate-doc`,
> `ingest-project`) uses the `require.main === module` + `spawnScript` pattern specifically so the
> guard fires in the child. If `remember-cli` exports helpers for unit tests, **keep the
> `spawnScript` pattern** (it's the established convention; see Shared Pattern "Dispatcher wiring").

---

### `src/adapter/recense.ts` (dispatcher — add `remember` case)

**Analog:** the `dedup-facts` / `ingest-project` cases (lines 95-101). All `require.main`-guarded
CLIs dispatch via `spawnScript(... process.argv.slice(3))` — **slice(3) not the local `rest`
(slice(4))**, because slice(4) drops `argv[3]` (the first positional / `"<fact>"`).

**Add (mirror `recense.ts:99-101`):**
```typescript
// remember-cli.ts guards execution with `require.main === module` (it exports helpers for
// unit tests + holds the write lock + runs the judge synchronously), so spawn as a subprocess.
case 'remember': spawnScript('remember-cli.js', process.argv.slice(3)); break;
```

**Usage string update** (`recense.ts:124-127`) — append `remember` to the `Commands:` line.

---

### `src/adapter/import-memory-cli.ts` (scope-tagging shape — reuse, NOT the extraction)

**Used as a reference only** for the scope-tag/`cwd` shape and the migration scan, NOT its
`recordEvent` (that path is the LOSSY one `remember` replaces). For the **D-08 migration**
(feed the 12 `.md` through `remember`), reuse:

**Folder→cwd + scan glue** (`import-memory-cli.ts:125-191`): `folderToCwd`, `defaultProjectsDir`,
`planImport` already enumerate `~/.claude/projects/*/memory/*.md` and skip `MEMORY.md` /
policy-bundles / trackers. The migration step can reuse `planImport` to enumerate, but must call the
NEW `remember` per file instead of `runImport`'s `pipeline.recordEvent`.

**Origin precedent** (`import-memory-cli.ts:217-224`) — the vault importer already uses
`origin: 'asserted_by_user'`; curated `remember` rides the **same origin** (D-03, no new enum):
```typescript
pipeline.recordEvent({
  content, role: 'user',
  origin: 'asserted_by_user',   // ← same origin remember uses
  sessionId: `${IMPORT_SOURCE}:${item.project}`,
  source: IMPORT_SOURCE, externalId: item.externalId, cwd: item.cwd,
});
```

---

### `src/db/semantic-store.ts` (write primitive — verbatim node create + embed + value_hash gate)

**Verbatim node create** — `upsertNode` (`semantic-store.ts:291`) is the ONLY writer of `node.value`;
it sets `value_hash = sha256(value)` and nulls `embedded_hash` on value-change (dirty-flag).
**For D-03 high-resistance seeding, pass explicit `s`/`c`** (defaults are `s=0.1, c=0.5` →
resistance `0.05`, far too weak):
```typescript
store.upsertNode({
  id: newId(),
  type: 'fact',
  value: verbatimText,             // VERBATIM — no extraction
  origin: 'asserted_by_user',      // D-03 curated origin
  s: <SEED_S>, c: <SEED_C>,        // ← PLANNER FLAG: seed high so s·c resists passive observed
});
```
`upsertNode` defaults preserved/overridden at `semantic-store.ts:234-247`:
```typescript
const c = params.c !== undefined ? params.c : (existing?.c ?? 0.5);
const s = params.s !== undefined ? params.s : (existing?.s ?? 0.1);
// training_eligible: origin ∈ {observed,asserted_by_user} ∧ ¬tombstoned ∧ c ≥ τ  ← auto-set
```

**Embed (single-writer, stale-guard)** — `setEmbedding(id, vec, expectedValueHash?)`
(`semantic-store.ts:309`) is the ONLY writer of `node.embedding`. Capture `value_hash` at read,
pass it as `expectedValueHash` to close the race. The sleep pass does this at
`consolidator.ts:305`: `store.setEmbedding(dirtyRows[i].id, vecs[i], dirtyRows[i].value_hash)`.

**D-08 verify gate (deterministic, NON-cosine)** — `value_hash` is the exact-content key. The gate
is: after `remember`, confirm a live (`tombstoned=0`) node exists whose `value_hash` (or `value`)
matches the verbatim text. `getNode(id)` returns the full `NodeRow` incl. `value`/`value_hash`/
`tombstoned`/`prev_value` (`semantic-store.ts:370`). **Do NOT use `recall` (cosine-gated) as the
gate** (per the cosine-weakness lessons + D-08).

**Scope sidecar** — `upsertNodeScope({ node_id, scope, updated_at })` (`semantic-store.ts:501`) is the
ONLY write path for `node_scope` (INSERT OR REPLACE, idempotent).

---

### `src/consolidation/update-decision.ts` (PURE routing — reuse verbatim; D-04 at the CALL SITE)

All three functions are pure (no DB, no clock). **D-04 force-reconcile must NOT mutate these** —
layer it at the call site (see "D-04 layering" below).

**`routeContradiction(peMagnitude, resistance, config)`** (`update-decision.ts:45-61`):
```typescript
const ratio = peMagnitude / Math.max(resistance, EPS);
if (ratio < config.peReconcileBandLow) return 'hold';
if (ratio < config.peReconcileBandHigh) return 'reconcile';
if (resistance < config.peAppendNewMinResistance) return 'reconcile';
return 'append-new';
```
resistance = `effectiveStrength(node.s, node.last_access, now, lambda) * node.c` (D-16).

**`isOscillation(newValue, prevValue)`** (`update-decision.ts:74-77`) — escalate flip-back to
append-new (D-20). **`countDistinctProvenance(entries)`** (`update-decision.ts:90-98`) — only
relevant if `remember` ever takes the HOLD path; with D-04 force-reconcile it likely doesn't.

> **D-04 layering:** `routeContradiction` for a curated (high-resistance) node + a fresh
> remember-magnitude will often return `'hold'` (weak ratio vs strong resistance). D-04 says an
> explicit `remember` contradiction must **always at least reconcile**. So at the call site:
> if the judge verdict is `relation==='contradict'`, **force `action='reconcile'`** (skip / override
> the `routeContradiction` result for the EXPLICIT direction), then run the same tombstone+mint as the
> consolidator's reconcile branch. Keep `isOscillation` as the only escape to append-new.

---

### `src/consolidation/sink.ts` (event emit — exactly one per branch, inside the txn)

**Analog:** `SQLiteConsolidationSink.emit` (`sink.ts:112-126`). The in-place-update event type is
**`'contradict_reconcile'`**; a plain insert is **`'unrelated'`** (standalone new node). Emit
**exactly one event per branch, INSIDE the `db.transaction`** with the graph mutation (D-48
atomicity). Event-type enum incl. `contradict_reconcile` at `sink.ts:53-65`.

```typescript
sink.emit({
  event_type: 'contradict_reconcile',   // in-place update (D-01 preview surfaces this)
  node_id: reconciledId,
  candidate_id: supersededId,
  episode_id: <episodeId or null>,       // remember has no episode → may be null
  value: verbatimText,
  origin: 'asserted_by_user',
  magnitude: verdict.magnitude,
});
```

> **Drift note:** every existing `emit` carries `episode_id`. `remember` has no episode row (it's a
> direct curated write, not an ingested turn). `ConsolidationEventInput.episode_id` is
> `string | null` (`sink.ts:73`), so passing `null` is type-safe. Planner: decide whether `remember`
> mints a lightweight episode for provenance/scope-join, OR writes `node_scope` directly (see scope
> note below — `stampNodeScopes` joins through `episode.cwd`, so a no-episode write needs a direct
> `upsertNodeScope`).

---

### `src/consolidation/consolidator.ts` (reference — copy the reconcile branch shape)

**Analog:** `applyDecision` contradict→reconcile branch (`consolidator.ts:913-964`). This is the
**reference implementation** for the in-place update; the thinner `remember` loop copies its shape:

```typescript
// resistance = effective_s * c   (consolidator.ts:905-908)
const effectiveS = this.strength.effectiveStrength(node.s, node.last_access, this.clock.nowMs(), this.config.lambda);
const resistance = effectiveS * node.c;
const action = routeContradiction(decision.magnitude, resistance, this.config); // ← remember FORCES 'reconcile' (D-04)

if (action === 'reconcile') {
  if (isOscillation(decision.claimValue, node.prev_value)) {
    /* append standalone, emit 'contradict_oscillation' */
  } else {
    this.store.tombstone(decision.bestCandidateId);          // 1. tombstone superseded
    const reconciledId = newId();
    this.store.upsertNode({                                  // 2. mint new current
      id: reconciledId, type: '...', value: decision.claimValue, origin: decision.claimOrigin,
      prev_value: node.value,                                // explicit one-deep breadcrumb (D-20)
    });
    this.sink.emit({ event_type: 'contradict_reconcile', node_id: reconciledId, candidate_id: decision.bestCandidateId, /* ... */ });
  }
}
```

**Plain-insert (no contradiction) branch shape** — `unrelated` case (`consolidator.ts:863-882`):
`upsertNode` standalone + `sink.emit({ event_type: 'unrelated', candidate_id: null, ... })`.

**The whole reconcile + emit MUST be wrapped in one `db.transaction(...).immediate()`** — see the
per-episode wrapper at `consolidator.ts:703-705`:
```typescript
this.db.transaction(() => { this.applyDecision(decision, episodeId); }).immediate();
```

> **Decay/eviction note for D-05 (load-bearing finding):** eviction is **AND-gated on
> `tombstoned === 1`** (`decay.ts:178-181`): `tombstoned===1 ∧ effectiveS<evictionSThreshold ∧
> age>30d`. A **live curated node (`tombstoned=0`) is already eviction-immune** regardless of
> origin — the decay sweep can never delete it. Lazy decay (`materializeDecay`) only lowers `s`; it
> never tombstones. **So `origin='asserted_by_user'` + the D-03 high `s`/`c` seed is sufficient for
> the decay/eviction shield; NO new node column is required for D-05.** The only remaining shield
> question is "sleep pass never re-extracts/mangles it" — `remember` writes a `node` directly (not an
> `episode`), and the consolidator extracts from `episode`s, so a curated node is never re-extracted.
> (Confirm: `remember` does NOT write an extractable episode, OR writes one already-consolidated.)

---

### `src/consolidation/run-sleep-pass.ts` (reuse helpers — scope-stamp + provider overlay)

**`stampNodeScopes(db, store, clock, sinceTs)`** (`run-sleep-pass.ts:122-155`) joins
`consolidation_event → episode.cwd`, maps via `cwdToScope`, resolves via `resolveNodeScope`, then
`store.upsertNodeScope`. **It joins through `episode.cwd`** — so it only works if `remember` wrote an
episode. **If `remember` writes no episode, call `store.upsertNodeScope` directly** with
`scope = cwdToScope(--scope override ?? process.cwd())` (the simpler path; D-10 = cwd-derived default).

**`resolveProviderOverlay(env, 'RECENSE_JUDGE_PROVIDER')`** (`run-sleep-pass.ts:162,231,291`) — the
exact mechanism that selects the `claude-headless` judge transport. Reuse it to build the judge
config (see judge note below). `VALID_PROVIDERS` includes `'claude-headless'` (`:162`).

---

### `src/lib/scope.ts` (pure — `cwdToScope`)

`cwdToScope(cwd)` (`scope.ts:43-59`) → lowercase project slug or `'global'`. D-10: default to
`cwdToScope(process.cwd())`; `--scope <s>` overrides (pass the override straight through as the
resolved scope, or synthesize a cwd — `import-memory`/`ingest-project` use synthetic cwds).
`resolveNodeScope` (`:70`) is only needed if collapsing multiple contributing cwds — not needed for a
single-cwd `remember`.

---

### `src/adapter/lockfile.ts` (global write lock)

`acquireLock()` (`lockfile.ts:78`) **fast-fails** (no queue) — returns `false` if held. Default path
`tmpdir/recense-sleep.lock`; override via `RECENSE_LOCK_PATH` (`:40-44`). Hold ONLY for the brief
per-write transaction (NOT across the judge call if avoidable — but the judge call is ~2-5s and the
write must be atomic with it, so the lock is held across embed→judge→apply; that's acceptable for an
explicit ~2-5s write per CONTEXT D-58). A concurrent hourly sleep pass means `remember` may
fast-fail; surface a clean "lock held, try again" message (mirror `dedup-facts-cli.ts:120`).

---

### `src/model/claude-headless-client.ts` (judge transport — reached via DefaultModelProvider)

**Do NOT call `createClaudeHeadlessClient` directly.** The clean seam is
`DefaultModelProvider.judge(claim, candidates)` (`provider.ts:160-165`), which lazily builds an
`AnthropicJudge` from `judgeConfig` (and `TwoTierJudge` if `twoTierJudge` is set). Build the provider
exactly as the sleep pass does (`run-sleep-pass.ts:291,305-309`):
```typescript
const judgeConfig = { ...config, ...resolveProviderOverlay(env, 'RECENSE_JUDGE_PROVIDER') };
const provider = new DefaultModelProvider({ extractorConfig: config, judgeConfig, embedConfig: config });
// embed the verbatim fact + neighbors:
const [qvec] = await provider.embed([verbatimText]);
// judge ONE claim vs top-k neighbors:
const verdict = await provider.judge(verbatimText, candidates); // candidates: {id, value}[]
```
`createClaudeHeadlessClient` (`claude-headless-client.ts:279`) strips `ANTHROPIC_API_KEY`/
`ANTHROPIC_AUTH_TOKEN` (subscription billing) and uses `--setting-sources project` (self-ingestion
guard) — already correct below the seam. `JudgeVerdict` shape: `{ best_candidate_id, relation,
magnitude, contradicted_ids? }` (`judge.ts:33-44`). Validate any judge-prompt tweak on local 35b
temp-0 (no temp-0 on headless).

**Neighbor retrieval** — `CandidateRetriever.topk(queryVec, k)` (`topk.ts:122`) returns
`{id, score}[]` over live embedded nodes (RRF of vector + FTS). The sleep pass calls
`this.retriever.topk(queryVec, this.config.candidateK)` (`consolidator.ts:520`). Reuse it; planner
picks `k` and any cosine floor for "which beliefs the judge sees."

---

### `src/db/schema.ts` (node table — D-05 / D-08 reference; likely NO migration needed)

`node` DDL (`schema.ts:39-55`):
```sql
CREATE TABLE IF NOT EXISTS node (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('entity','fact','schema','doc')),
  value TEXT NOT NULL,
  value_hash TEXT NOT NULL,                  -- D-08 deterministic verify key
  embedding BLOB, embedded_hash TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('observed','asserted_by_user','inferred')),  -- D-03 rides asserted_by_user
  s REAL NOT NULL DEFAULT 0.1,               -- D-03 seed override target
  c REAL NOT NULL DEFAULT 0.5,               -- D-03 seed override target
  last_access INTEGER NOT NULL,
  prev_value TEXT, prev_ts INTEGER,          -- D-20 one-deep breadcrumb
  pending_contradictions TEXT NOT NULL DEFAULT '[]',
  tombstoned INTEGER NOT NULL DEFAULT 0,     -- eviction AND-gate (live node = immune)
  training_eligible INTEGER NOT NULL DEFAULT 0
);
```
**CONFIRMED: `node` has NO `hard_keep`.** `hard_keep` exists ONLY on `episode`
(`schema.ts:29`). **D-05 conclusion: no new column needed** — `origin='asserted_by_user'` + high
`s`/`c` seed + the `tombstoned=0` eviction immunity carry the decay/eviction shield. If the planner
DOES decide a node-level flag is required, that's a `SCHEMA_VERSION` bump (`schema.ts:11`, currently
**12**) + a new migration branch (pattern: the `node_v11`/`edge_v12` rebuild blocks at
`schema.ts:368,447`).

---

## Shared Patterns

### Dispatcher wiring (D-87 lazy-require / spawnScript)
**Source:** `src/adapter/recense.ts:43-48` (`spawnScript`) + `:95-101` (guarded-CLI cases).
**Apply to:** the new `remember` case. Use `process.argv.slice(3)` (NOT `rest`/slice(4) — drops the
positional). All `require.main`-guarded write-CLIs follow this; `remember` should too.

### Validate-args-before-lock (WR-02) + lock-in-finally
**Source:** `src/adapter/dedup-facts-cli.ts:110-150` + `import-memory-cli.ts:281-315`.
**Apply to:** `remember-cli.ts` real-write path. `resolveSharedDbPath(argv, { fallbackToDefault:
false })` → `acquireLock()` → DB work in `try` → `db?.close(); releaseLock()` in `finally`.

### Atomic graph-mutation + sink.emit inside one db.transaction (D-48)
**Source:** `consolidator.ts:703-705` (the `.immediate()` wrapper) + each `applyDecision` branch's
`store.*` + `sink.emit` pair.
**Apply to:** the `remember` tombstone+mint+emit (reconcile) and upsert+emit (insert) — both inside
ONE `db.transaction(() => { ... }).immediate()`. No `await` inside the transaction (the judge/embed
awaits happen in "Phase A" BEFORE the transaction — see `consolidator.ts:439,634`).

### Curated origin = `asserted_by_user` (no new enum)
**Source:** `import-memory-cli.ts:221` (vault importer precedent).
**Apply to:** every `remember` node write (D-03).

### Scope sidecar write
**Source:** `run-sleep-pass.ts:150` (`store.upsertNodeScope(...)`) + `semantic-store.ts:501`.
**Apply to:** every `remember` node — `upsertNodeScope({ node_id, scope: cwdToScope(--scope ??
process.cwd()), updated_at: now })` (D-10). Curated facts must get a `node_scope` row so recall
renders the `[scope]` prefix.

### Judge via DefaultModelProvider (subscription-billed headless Sonnet)
**Source:** `run-sleep-pass.ts:291,305-309` + `provider.ts:160-165`.
**Apply to:** the synchronous contradiction call: `provider.judge(verbatimText, neighborCandidates)`.
Transport (key-strip, `--setting-sources project`) is correct below the seam.

---

## No Analog Found

| File | Role | Reason |
|------|------|--------|
| (none) | — | Every new-file concern has an exact in-repo analog (`dedup-facts-cli.ts` for the CLI skeleton; the consolidator reconcile branch for the in-place update). |

**Non-code deliverables (no code analog — handled in plan, not by pattern-copy):**
- **D-06** global directive → edit `~/.claude/CLAUDE.md` (text, additive directive).
- **D-07** settings.json kill-switch → research task (investigate `~/.claude/settings.json` native-memory
  toggle; apply only if a real switch exists; do NOT build a PreToolUse-deny hook unless research proves
  it's the only mechanism).
- **D-09** archive → move verified `.md` files to `~/.claude/projects/-Users-vtx-brain-memory/memory/.migrated/`
  (filesystem move, not `rm`).

---

## Drift / Verification Notes (live source vs CONTEXT.md)

1. **All CONTEXT.md paths verified present.** No path drift — every file under `<canonical_refs>`
   exists at the stated location with the stated symbols.
2. **`node` has NO `hard_keep` — CONFIRMED** (only `episode` does; `schema.ts:29` vs `:39-55`). CONTEXT
   D-05's note is accurate.
3. **`SCHEMA_VERSION` is 12** (`schema.ts:11`) — CONTEXT says 12. Accurate.
4. **Eviction is `tombstoned=1`-gated** (`decay.ts:178-181`) — this is the load-bearing D-05 finding:
   a live curated node is intrinsically eviction-immune; `origin` alone need not be the shield.
5. **`sink.emit` event_type for in-place update = `'contradict_reconcile'`** (`sink.ts:58`), already in
   the live enum (no enum change needed for `remember`).
6. **`episode_id` is nullable on `ConsolidationEventInput`** (`sink.ts:73`) — `remember` (no episode)
   can emit with `episode_id: null`. BUT `stampNodeScopes` joins through `episode.cwd`
   (`run-sleep-pass.ts:140-145`), so a no-episode `remember` must call `upsertNodeScope` **directly**
   rather than relying on `stampNodeScopes`. Flagged for the planner.
7. **Dispatcher arg slice:** guarded CLIs use `process.argv.slice(3)` (not the local `rest = slice(4)`,
   which drops `argv[3]` = the `"<fact>"` positional). `remember` must use `slice(3)`.

---

## Metadata

**Analog search scope:** `src/adapter/`, `src/consolidation/`, `src/db/`, `src/model/`, `src/lib/`,
`src/strength/`, `src/retrieval/`.
**Files scanned (Read or targeted grep):** recense.ts, import-memory-cli.ts, dedup-facts-cli.ts,
recall-cli.ts, update-decision.ts, sink.ts, consolidator.ts, run-sleep-pass.ts, semantic-store.ts,
schema.ts, scope.ts, lockfile.ts, claude-headless-client.ts, provider.ts, judge.ts, decay.ts, topk.ts.
**Pattern extraction date:** 2026-06-20
