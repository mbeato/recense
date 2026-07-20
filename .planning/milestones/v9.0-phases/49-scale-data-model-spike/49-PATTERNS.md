# Phase 49: Scale + Data-Model Spike - Pattern Map

**Mapped:** 2026-06-28
**Files analyzed:** 2 created (1 bench harness, 1 findings doc)
**Analogs found:** 2 / 2 (both exact — direct Phase-41 precedent)

> This is a **measurement + written-decision spike**. No production code ships. The two
> created artifacts are a standalone `scripts/eval/` bench harness (devDependency-isolated
> ANN, read-only on the live brain) and a written `49-SPIKE-FINDINGS.md`. PATTERNS below are
> copy-from sources for both. The planner should treat the Phase-41 harness trio as the
> skeleton to fork, not reinvent.

## File Classification

| Created File | Role | Data Flow | Closest Analog | Match Quality |
|--------------|------|-----------|----------------|---------------|
| `scripts/eval/49-crossover-spike.cjs` | eval-harness (CommonJS bench script) | batch / read-only-measure | `scripts/eval/41-index-spike.cjs` | exact (same role + same flow) |
| `.planning/phases/49-scale-data-model-spike/49-SPIKE-FINDINGS.md` | findings-doc (frontmatter + measured tables) | document | `.planning/phases/41-vector-index-and-hot-path-latency/41-SPIKE-FINDINGS.md` | exact |

**Reference (read-only, NOT modified) sources the harness imports/mirrors:**

| Source | Role | What the harness reuses from it |
|--------|------|--------------------------------|
| `src/retrieval/topk.ts` | production exact index | brute-force baseline arm + `cosineSimF32` ground-truth + flat-buffer marshaling |
| `src/db/schema.ts` | hand-written better-sqlite3 DDL (no ORM) | SCALE-02 migration-cost is measured against this schema delta |
| `src/db/semantic-store.ts` | single-writer store | SCALE-02 single-writer / setEmbedding doctrine the migration must preserve |

---

## Pattern Assignments

### `scripts/eval/49-crossover-spike.cjs` (eval-harness, batch read-only-measure)

**Analog:** `scripts/eval/41-index-spike.cjs` (fork this; it already does baseline-vs-candidate
top-k + p50/p95 over the live brain). Pull the recall-gate scoring from
`scripts/eval/41-topk-equivalence.cjs`, and the warm-vs-baseline same-run delta structure from
`scripts/eval/41-latency-after.cjs`.

**File header / boilerplate** (`41-index-spike.cjs:44-67`) — `'use strict'`, CommonJS requires,
DIST resolution, arg parser, live-DB path from env-or-homedir. Copy verbatim, adjust IDs:
```javascript
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '../../dist/src');
const { CandidateRetriever } = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG }     = require(DIST + '/lib/config');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DIMS    = DEFAULT_CONFIG.embeddingDimensions || 1536;
const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');
```
Note: the live DB default is `~/.config/recense/recense.db` (used by `41-index-spike.cjs:67`);
the older harnesses also default there. `embeddingDimensions` is 1536.

**Read-only live-brain open** (`41-index-spike.cjs:333`, `41-latency-after.cjs:128`,
`41-topk-equivalence.cjs:180`) — ALWAYS open the live brain read-only; never write it. This is
the load-bearing safety invariant for the spike:
```javascript
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
```

**Embedding BLOB → Float32Array decode** (`41-index-spike.cjs:109-113`) — Pitfall 5: pass
`byteOffset` + length; `new Float32Array(buf.buffer)` alone is wrong for sliced Buffers:
```javascript
function decodeEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
```

**The exact brute-force ground-truth arm** (`41-index-spike.cjs:144-190`) — `buildFlatIndex` +
`flatTopk` is the contiguous-buffer exact scan that IS the recall denominator. The row filter
`embedding IS NOT NULL AND tombstoned = 0` is canonical and matches `topk.ts:81` /
`topk.ts:295` exactly — the synthetic corpus and both arms MUST use it:
```javascript
const rows = db.prepare(
  'SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0'
).all();
// ... flat = Float32Array(n*DIMS), norms = Float64Array(n), ids = Array(n)
// cosine = dot / (qNorm * norms[r])  ← same formula as cosineSimF32 (topk.ts:200-211)
```
Prefer importing `cosineSimF32` directly from the built module (as `41-topk-equivalence.cjs:46`
does: `require(DIST + '/retrieval/topk')`) so the ground truth is byte-identical to production,
not a re-derivation.

**Synthetic corpus scale-up (D-01, NEW — no direct analog, this is the spike's novel part)** —
there is no existing "perturb + replicate embeddings" helper. Build it on top of the
`decodeEmbedding` + flat-buffer pattern: load the ~11.3k live `node.embedding` BLOBs, then for
each target scale {11.3k live, 25k, 50k} emit jittered+renormalized copies (small Gaussian jitter,
then divide by L2 norm — reuse the renormalize loop from `mockVector`, `41-index-spike.cjs:126-130`).
**Anchor the sweep on the UNMODIFIED live brain** as the real-distribution baseline (D-01). Do
NOT use random normalized vectors — HNSW recall is distribution-sensitive (D-01 rationale).

**ceil-based percentile** (`41-index-spike.cjs:97-102`, identical in `41-latency-after.cjs:76-81`)
— reuse verbatim so p50/p95 match every prior Phase-40/41 number:
```javascript
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}
```

**Warm timing loop with warm-up discard** (`41-latency-after.cjs:170-182`) — build/load index
once, run a discarded warm-up pass, then time REPEATS × queries, sort, percentile:
```javascript
function measureWarm(retriever, vecs) {
  for (const v of vecs) retriever.topk(v, K); // warm-up, discarded
  const lat = [];
  for (let r = 0; r < REPEATS; r++) for (const v of vecs) {
    const t0 = Date.now(); retriever.topk(v, K); lat.push(Date.now() - t0);
  }
  lat.sort((a, b) => a - b);
  return { p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95), samples: lat.length };
}
```

**recall@k vs exact ground truth (D-03, ADAPT from set-equivalence)** — Phase 41 measured
**set-equality** (exact-vs-exact, `41-topk-equivalence.cjs:137-171`). Phase 49 measures
**recall@5 / recall@10** of the ANN arm against the exact arm (ANN is approximate, so expect <1.0).
Adapt the set-overlap logic: `recall@k = |ann_topk ∩ exact_topk| / k`. The boundary-tie epsilon
machinery (`TIE_EPS = 1e-6`, `41-topk-equivalence.cjs:60`) is NOT needed for ANN recall — overlap
fraction is the metric. Keep the exact arm as the denominator built with `cosineSimF32`.

**ANN candidate loaded ONLY inside the harness (D-02 / D-02b)** — mirror the `trySqliteVec`
best-effort try/catch pattern (`41-index-spike.cjs:197-248`): attempt `require()` of the ANN lib,
and on any load/build failure return `{ available: false, error }` and record the candidate as
**`unmeasured-here`** — never fabricate numbers (D-02b, and the Phase-41 precedent where
sqlite-vec was unloadable). The ANN dep is a **devDependency**, never added to `dependencies`:
```javascript
function tryAnn() {
  let ann;
  try { ann = require('vectorlite'); }            // or hnswlib-node fallback (D-02b)
  catch (e) { return { available: false, error: `module not installed: ${e.message}` }; }
  try { /* build HNSW over the scaled corpus; record build_ms + memory footprint */ }
  catch (e) { return { available: false, error: `load/build failed: ${e.message}` }; }
}
```
Current state confirmed: **neither `vectorlite`, `hnswlib-node`, nor `sqlite-vec` is installed**
(`node_modules` scan returned none; `package.json` deps = better-sqlite3/openai/zod/etc, devDeps =
tsx/typescript/vitest only). If the chosen lib fails to load, that is a recordable `unmeasured-here`
result, exactly as Phase 41 recorded sqlite-vec.

**git commit hash for provenance** (`41-index-spike.cjs:104-107`) — stamp `sut_commit`:
```javascript
function getCommitHash() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}
```

**Results JSON shape + write** (`41-index-spike.cjs:444-462`) — `{ meta: {...}, results: [...],
... }`, `mkdirSync(recursive)` then `writeFileSync(JSON.stringify(out, null, 2) + '\n')`. Write
to `scripts/eval/results/49-crossover-spike.json`. Per `meta` include: `eval`, `date`,
`commit`, `node_count` per scale rung, `k`, `repeats`, `embed_model`. Add the recall + build_ms +
memory fields the crossover needs:
```javascript
const out = {
  meta: { eval: '49-crossover-spike', date: new Date().toISOString(), commit, k: K, repeats: REPEATS, dims: DIMS },
  scales: [ /* per rung: { n, exact: {p50,p95}, ann: {p50,p95, recall_at_5, recall_at_10, build_ms, mem_bytes} } */ ],
  ann_available: { available: false, error: '...' }, // or true + params
};
```

**Results gitignore (D-06)** — CONFIRMED from `.gitignore`: `scripts/eval/results/` is ignored
(line 32), with dated/committed results an explicit exception. Raw bench JSON lands under
`scripts/eval/results/` and stays **local-only / gitignored**, same as Phase 41
(`41-index-spike.json (gitignored, local-only)`).

**Top-level async IIFE + error trap** (`41-index-spike.cjs:326`, `:463`) — wrap main in
`(async () => { ... })().catch(e => { console.error(...); process.exit(1); })`.

**Build-before-run requirement** — the harness `require()`s `../../dist/src/retrieval/topk`
(compiled output, `41-index-spike.cjs:52-53`), NOT the `.ts` source. The planner's run step must
`tsc` / build `dist/` first, or the require fails.

---

### `.planning/phases/49-scale-data-model-spike/49-SPIKE-FINDINGS.md` (findings-doc)

**Analog:** `.planning/phases/41-vector-index-and-hot-path-latency/41-SPIKE-FINDINGS.md` (D-06
names this the explicit precedent).

**YAML frontmatter** (`41-SPIKE-FINDINGS.md:1-11`) — copy the shape, adjust values:
```yaml
---
phase: 49-scale-data-model-spike
plan: 01
artifact: SPIKE-FINDINGS
requirement: [SCALE-01, SCALE-02]
sut_commit: <git rev-parse --short HEAD>
date: 2026-06-28
harness: scripts/eval/49-crossover-spike.cjs
results: scripts/eval/results/49-crossover-spike.json (gitignored, local-only)
---
```

**Two top-level sections (D-06)** — unlike Phase 41's single-question structure, Phase 49 has
TWO requirements:
- **§ SCALE-01** — measured tables (recall@5/@10, p50/p95, build time, memory footprint per scale
  rung {11.3k, 25k, 50k}) + the explicit **go/no-go** verdict per D-04's gate.
- **§ SCALE-02** — written recommendation (Zep bi-temporal vs DCPM supersedes-chain vs
  tombstone-always) + better-sqlite3 migration-cost estimate. No tables required; prose +
  schema-delta bullet list.

**Measured-table format** (`41-SPIKE-FINDINGS.md:40-50`) — markdown table, bolded headline
numbers, a `Source` column distinguishing conditions. Mirror for the per-scale crossover sweep:
```markdown
| Scale (nodes) | Exact p50/p95 (ms) | ANN p50/p95 (ms) | recall@10 | build (ms) | mem (MB) |
|---------------|--------------------|--------------------|-----------|-----------|----------|
| 11.3k (live)  | ...                | ...                | ...       | ...       | ...      |
```

**Honesty discipline (D-02b, the load-bearing precedent)** — Phase 41 recorded sqlite-vec as
`**unavailable** (module not installed)` rather than fabricating (`41-SPIKE-FINDINGS.md:48`,
`:19`). Phase 49 MUST do the same if the ANN lib won't load: report `unmeasured-here` / blocked,
never invented numbers.

**Explicit decision block** (`41-SPIKE-FINDINGS.md:96-105`) — a `## Decision` heading stating the
verdict in the first sentence (`Decision: Ship the zero-dep ...`). Phase 49's SCALE-01 verdict is
a **go/no-go** per D-04 (go ONLY if exact p95 measurably exceeds the ~45/46 ms felt-path budget at
realistic scale AND ANN holds recall@10 ≥ 0.95; otherwise **no-go / defer** — defer is an
explicit valid result). SCALE-02 is a recommendation, which may also be **defer**.

**Closing provenance line** (`41-SPIKE-FINDINGS.md:137-138`) — restate read-only safety:
"Real numbers, live brain, read-only. No writes to `~/.config/recense/recense.db` occurred."

---

## SCALE-02 migration-cost reference (no code — written estimate only, D-05)

The SCALE-02 section estimates better-sqlite3 migration cost against the **current schema delta**.
This project uses **hand-written SQL DDL, NOT Drizzle/any ORM** — `src/db/schema.ts` is the single
source. The reconsolidation state the estimate is measured against lives in the `node` table.

**Current tombstone-reconsolidation columns** (`src/db/schema.ts:50-53`):
```sql
prev_value             TEXT,
prev_ts                INTEGER,
pending_contradictions TEXT    NOT NULL DEFAULT '[]',
tombstoned             INTEGER NOT NULL DEFAULT 0,
```
A bi-temporal (Zep) model adds validity-interval columns (e.g. `valid_from`, `valid_to`,
`tx_from`, `tx_to`); a DCPM supersedes-chain adds doubly-linked pointer columns (e.g.
`supersedes_id`, `superseded_by_id`) + an index. The estimate quantifies columns/indexes/backfill
on top of the four above.

**Two migration shapes already established in this codebase — the cost basis:**

1. **Additive column (cheap)** — `ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info`
   (`schema.ts:222-235`). SQLite `ADD COLUMN` is O(1) metadata-only when the column is nullable or
   has a constant DEFAULT; **no row rewrite, no backfill**. This is the cost of adding nullable
   `valid_from`/`valid_to`/`supersedes_id` columns.

2. **CHECK-constraint change or non-trivial reshape (expensive)** — full table recreation, because
   SQLite cannot ALTER a CHECK constraint (`schema.ts:394-435`): `PRAGMA foreign_keys=OFF` →
   `BEGIN; CREATE TABLE node_vN (...); INSERT INTO node_vN SELECT * FROM node; DROP TABLE node;
   ALTER TABLE node_vN RENAME TO node; COMMIT;` → **re-create every index** (`idx_node_dirty`) and
   **rebuild the `node_fts` virtual table** → `PRAGMA foreign_keys=ON`. This rewrites all ~11.3k
   rows and is the cost if the new model needs a typed/constrained column or a backfill from
   `prev_value`/`prev_ts` into validity intervals.

**Schema-version stamping the migration must extend** (`schema.ts:607-623`): bump
`SCHEMA_VERSION` (currently **14**, `schema.ts:11`), append the new migration branch idempotently,
and rely on the existing downgrade guard (throws when stored version > binary version).

**Correctness invariants the recommendation must preserve** (CLAUDE.md §Constraints +
`semantic-store.ts`): decay never deletes evidence-backed facts; graph is source of truth (vector
is derived cache); **single-writer** — `node.embedding` written only by `setEmbedding`
(`semantic-store.ts:13`, `:130`), all node mutation rides inside one IMMEDIATE transaction. Any
bi-temporal/supersedes write path must stay inside that single-writer discipline.

---

## Shared Patterns

### Read-only live-brain access (safety invariant)
**Source:** `41-index-spike.cjs:333`, `41-latency-after.cjs:128`, `41-topk-equivalence.cjs:180`
**Apply to:** the harness — every open of the live DB.
```javascript
new Database(DB_PATH, { readonly: true, fileMustExist: true });
```
Any candidate that must build its own table (an ANN/vec0 virtual table) does so on a **tmpdir COPY**
of the live DB, never the live file (`41-index-spike.cjs:206-209`: `fs.copyFileSync(liveDbPath,
scratchPath)`), and cleans up the scratch file after.

### Canonical row filter
**Source:** `topk.ts:81` / `topk.ts:295`, mirrored in all three Phase-41 harnesses
**Apply to:** corpus build + both retrieval arms.
```sql
WHERE embedding IS NOT NULL AND tombstoned = 0
```

### Embedding decode (Pitfall 5)
**Source:** `41-index-spike.cjs:109-113`, `topk.ts:89`
**Apply to:** anywhere a `node.embedding` BLOB becomes a Float32Array.
```javascript
new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
```

### Honesty / unmeasured-here discipline
**Source:** `41-index-spike.cjs:197-248` (try/catch → `{available:false,error}`),
`41-SPIKE-FINDINGS.md:19,48`
**Apply to:** the ANN arm (harness) AND the findings doc. Never fabricate a number; record the
load-error string and mark the candidate `unmeasured-here`.

### Results provenance + gitignore
**Source:** `41-index-spike.cjs:444-462`, `.gitignore:32`
**Apply to:** raw bench JSON → `scripts/eval/results/49-crossover-spike.json` (local-only).

---

## No Analog Found

| Aspect | Why no analog | Planner guidance |
|--------|---------------|------------------|
| Synthetic corpus scale-up (perturb + replicate live embeddings to 25k/50k, D-01) | No existing harness scales the corpus beyond the live node count; all Phase-41 harnesses run over the live brain as-is | Build on `decodeEmbedding` + the `mockVector` renormalize loop (`41-index-spike.cjs:126-130`); anchor on unmodified live brain; small Gaussian jitter + L2-renormalize. Jitter magnitude is Claude's discretion (D-07). |
| ANN/HNSW build + recall@k measurement | Phase 41 measured exact-vs-exact set-equality only; no ANN was ever built (sqlite-vec was unloadable) | Adapt set-overlap → `recall@k = |ann∩exact|/k`; sweep HNSW M / ef_construction / ef_search params (Claude's discretion, D-07); record build_ms + memory footprint, which Phase 41 never measured. |
| Memory-footprint measurement | No prior harness records index memory | Use `process.memoryUsage().heapUsed` deltas around index build, or the ANN lib's own reported size. |

---

## Metadata

**Analog search scope:** `scripts/eval/` (Phase-41 harness trio), `src/retrieval/topk.ts`,
`src/db/schema.ts`, `src/db/semantic-store.ts`, `.planning/phases/41-*/41-SPIKE-FINDINGS.md`,
`package.json`, `.gitignore`, `node_modules` (ANN-lib presence check).
**Files scanned:** 8 read + 3 grep/dependency probes.
**Key confirmations:** embeddingDimensions=1536; SCHEMA_VERSION=14; no ANN lib installed;
`scripts/eval/results/` gitignored; live DB default `~/.config/recense/recense.db`.
**Pattern extraction date:** 2026-06-28
