# Phase 55: Honest 1-hop Pathways on Ambient Recall - Research

**Researched:** 2026-06-30
**Domain:** Server-side retrieval-engine emit change (TypeScript, better-sqlite3), presentation-trace honesty invariant
**Confidence:** HIGH (all findings verified against live source, file:line cited; no unresolved flags)

## Summary

All three research flags CONTEXT.md marked as "MUST resolve before planning locks" are RESOLVED
with direct evidence from live source. The single biggest correction to CONTEXT.md's framing:
**`kind='relation'` edges are neither bidirectional nor stored with the `schema_rel` lexicographic
`src<dst` convention — they are genuinely single-direction, semantically-directional edges** (the
CR-01 50%-undercount mechanism does not apply to them the way D-04 assumed). There is a real but
different sparsity risk (asymmetric edges mean "object-only" nodes show zero out-edges), which is
evidence for the founder checkpoint, not a defect in the decision.

The client (`hud.js`/`trace.js`) already fully supports the `{node_id, score}` seed shape via a
`normalizeSeed()` helper with graceful string-array fallback — D-06 is a safe, backward-compatible
change with zero client risk.

The edge read is cheap: `getOutEdges`/`getOutEdgesWithRel` are prepared statements querying
`WHERE src = ?` against a table whose PRIMARY KEY is `(src, dst, rel)` — `src` is the PK's leading
column, so the read is an indexed prefix scan. One important correction: the emit happens
**synchronously, before the caller's `return` statement** (better-sqlite3 has no async I/O) — it is
fire-and-forget only in the *error-handling* sense (try/catch swallows failures), not in the
*timing* sense. The per-seed edge reads DO count against the ~45ms p50 hot-path budget.

**Primary recommendation:** Implement both `retrieveRanked` emit sites by mirroring the existing
`retrieveCueless` 1-hop pattern (`engine.ts:262-324`) but adding an explicit `kind==='relation'`
filter (retrieveCueless does not kind-filter — do not copy that part) and an explicit liveness
check (`getNode(edge.dst)?.tombstoned !== 1`, mirroring `recall/index.ts:432`, since D-01's
weight-based top-N cap has no natural "undefined score" liveness gate the way retrieveCueless's
boost-accumulation does). Two existing test assertions in `tests/activation-trace-wiring.test.ts`
(lines 320, 333) assert bare-string `seeds` and **will break** under D-06 — the planner must
schedule their update as a task, not just add new guards.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| 1-hop edge read (per-seed out-edges) | API/Backend (engine) | Database/Storage (SQLite prepared stmt) | `retrieveRanked` is server-side engine code; the read is a thin wrapper over an existing prepared statement — no new tier introduced |
| Edge-kind allowlist filtering | API/Backend (engine) | — | Filtering logic belongs in the emit-preparation code inside `retrieveRanked`, not pushed into the store layer (store stays kind-agnostic per existing `getOutEdges` contract) |
| Seed/hop payload shape | API/Backend (engine emit) | — | The row shape contract (`{node_id,score}` seeds, `{node_id,score:null,hop}` hops) is defined and owned by the engine; client only consumes |
| Rendering seeds/hops | Browser/Client (`hud.js`/`trace.js`) | — | Already implemented (Phase 52); no change required this phase — confirmed no client work needed |
| Liveness (tombstone) filtering | API/Backend (engine, application-layer) | Database/Storage (tombstoned column) | `getOutEdges` intentionally does NOT filter tombstoned dst in SQL (per its own doc comment) — filtering is explicitly an application-layer responsibility, consistent across `retrieveCueless` and `recall/index.ts` |

## Research Flag 1: Edge-Storage Direction (HIGHEST PRIORITY)

**Verdict: RESOLVED.**

`kind='relation'` edges are written at exactly three sites, all single-direction, **none** using
the `schema_rel` lexicographic `src<dst` convention:

1. `src/seeder/cold-start.ts:103-109` — wikilink edges, `rel:'links_to'`, `src=srcId` (the claim
   that declares the link), `dst=dstId` (the linked-to claim). One-shot write, no reverse insert.
2. `src/consolidation/consolidator.ts:960-967` — typed-triple edges from parsed subject-predicate-
   object triples, `src=resolveEntityByName(subject)`, `dst=resolveEntityByName(object)`. No
   reverse insert.
3. `src/consolidation/consolidator.ts:1113-1119` — `rel:'extends'`, `src=bestCandidateId`
   (existing/superseded belief), `dst=newId_` (new evidence node). No reverse insert.

Grepped every `upsertEdge(` call site in the codebase (15 total) and every `kind:` literal — no
site writes both `(src,dst)` and `(dst,src)` for `kind='relation'`, and no site applies a
lexicographic `a<b` swap for `relation` edges the way `schema-relations.ts:333`
(`const [src, dst] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]`) does for `kind='schema_rel'`.

**The Phase 18 CR-01 lesson (lexicographic `src<dst`, ~50% undercount) is specific to
`kind='schema_rel'`** — confirmed by the comment at `src/recall/index.ts:446-449` ("schema_rel
edges are stored undirected with a lexicographic src<dst convention... we must scan both
out-edges AND in-edges, else ~50% of related schemas are silently missed"). That mechanism does
**not** apply to `kind='relation'`, because relation edges are never lexicographically normalized —
their direction is the real semantic direction (subject→object; superseded→new; link-declarer→
link-target).

**Corrected risk (not the one CONTEXT.md hypothesized, but real):** because relation edges are
genuinely asymmetric, a node that is frequently the **object/dst** of relations but rarely the
**subject/src** (e.g., a well-known entity that many facts point *at* but which itself makes no
assertions) will show few or zero `relation` out-edges under D-04's out-edges-only read, even
though it is richly connected as a target. This is not a storage-convention bug — it is the
correct behavior of a directional graph read — but it does mean pathway density will vary by
seed's structural role (subject-heavy nodes light up denser than object-heavy nodes). This is
evidence for, not against, the founder's out-edges-only decision holding; it is a different shape
of sparsity than the CR-01 mechanism.

**`getOutEdges`/`getOutEdgesWithRel` query confirmed** (`src/db/semantic-store.ts:170-172,178-180`):
```ts
this.stmtGetOutEdges = db.prepare('SELECT dst, w, kind FROM edge WHERE src = ?');
this.stmtGetOutEdgesWithRel = db.prepare('SELECT dst, rel, w, kind FROM edge WHERE src = ?');
```
Both query the `src` column exclusively — the 1-hop read for a seed returns edges where the seed
is the src, matching D-04's stated intent exactly.

**Planning implication:** D-04 stays out-edges-only (per founder lock). No code change required
to "fix" a bidirectional-storage bug because there isn't one — but flag the corrected risk
framing (asymmetric-edge sparsity, not lexicographic undercount) at the founder checkpoint so the
visual review has the right mental model if pathways look sparse for particular seeds.

## Research Flag 2: Client Seed-Shape Acceptance

**Verdict: RESOLVED — safe, zero client risk.**

`src/viz/modules/trace.js:132-144` defines `normalizeSeed(s)`:
```js
// @param {string | {node_id: string, score: number | null}} s
function normalizeSeed(s) {
  if (typeof s === 'string') return { node_id: s, score: null };
  return { node_id: s.node_id, score: (typeof s.score === 'number') ? s.score : null };
}
```
This is called at both hop-rendering paths (`trace.js:600`, `665`, `734`) — every seed consumer
already normalizes the union type before use. `trace.js:582-585` also has an outer back-compat
guard: a bare `string[]` row (not even `{seeds,hops}`) is wrapped into `{seeds: row, hops: []}`
before dispatch.

`src/viz/modules/hud.js:150-156` — the SSE listener also normalizes for logging
(`s => typeof s === 'string' ? s : s.node_id`) and passes the **full row** (not just seeds) into
`ctx.applyTrace(row)` — confirming hops are already piped through, unmodified since Phase 52.

The existing string-array fallback path (`normalizeSeed`'s `typeof s === 'string'` branch, and
`trace.js:864-865` which is the ambient-liveliness replay generator emitting synthetic
`{node_id,score:null}` seeds — not a live string producer) is exercised by
`tests/trace-honest-recall.test.ts:227-241` (`normalizeSeed` unit tests) and
`tests/trace-honest-recall.test.ts:309-316` ("bare-string seeds (legacy/ingestion shape) still
light at mid fallback"). D-06's change (ambient moving to `{node_id,score}` objects) does not
remove or need to remove this fallback — it is preserved for any remaining bare-string producer
(ingestion/cascade path, which is out of scope for this phase).

**Planning implication:** No client change required (confirms CONTEXT.md's "no client change
required" framing). No risk of breaking the string-array path — it stays intact for other
producers.

## Research Flag 3: Hot-Path Latency

**Verdict: RESOLVED — naive per-seed loop is acceptable; batching not required. One framing
correction: the read happens on the synchronous critical path, not "after return."**

**Correction to CONTEXT.md's framing:** `ActivationTraceSink.emit()` is documented as
"[c]alled synchronously by the engine after each spreading-activation pass. Synchronous only —
better-sqlite3 is sync" (`src/viz/activation-sink.ts:74-76`). `SQLiteActivationTraceSink.emit()`
(`activation-sink.ts:111-124`) runs a synchronous `INSERT` + eviction `DELETE`, no `setTimeout`/
`setImmediate`/Promise deferral anywhere in the call chain. Both `retrieveRanked` emit sites call
`this.traceSink.emit(...)` **before** their `return` statement (`engine.ts:499`→`504` return;
`518`→`524` return). So: the emit — and any edge reads added inside it — executes synchronously
and fully **before** the caller gets control back. T-10-05's fire-and-forget guarantee is about
**error isolation** (try/catch swallows sink failures so they never surface as thrown errors to
the caller), not about **timing** (it does not defer execution off the critical path). Any latency
added here is real, felt latency on the ~45ms p50 budget.

**Why the naive per-seed loop is still cheap:**
- `edge` table schema: `PRIMARY KEY (src, dst, rel)` (`src/db/schema.ts:57-65`) — `src` is the PK's
  leading column, so `WHERE src = ?` is an indexed prefix scan, not a full table scan.
- Both `getOutEdges` and `getOutEdgesWithRel` are prepared once in the `SemanticStore` constructor
  (`semantic-store.ts:170-180`) — no per-call compilation cost.
- The existing `retrieveCueless` path (`engine.ts:262-324`) already runs this exact
  `for (seed) { store.getOutEdges(seedId) }` shape **twice** per call (once for the boost-scan at
  line 272, again for the hop-collection at line 310) against up to `SEED_K` seeds, unconditionally,
  on the same hot path, and the project's own baseline states retrieval p50/p95 is 45/46ms
  (`.planning/STATE.md` v8.0 baseline; unchanged through v9.0 per REQUIREMENTS.md RETR-04 "no online
  LLM calls introduced" and no noted latency regression in Phase 47-51 history). Phase 55's ≤10
  seeds × one `getOutEdges` call each is strictly less work than what `retrieveCueless` already
  does inside the same budget today.
- No no-N+1 network hop — this is an in-process SQLite read, not a remote call.

**No batched/single-query alternative exists today** — no `getOutEdgesForNodes(nodeIds[])` or `IN
(?,?,...)` variant was found in `semantic-store.ts`. One could be added (a single
`SELECT dst,w,kind FROM edge WHERE src IN (...)` bound-param query), but given the evidence above
this is optimization the phase does not need to ship; note it as a Claude's Discretion "if a
profiling run during implementation shows measurable regression, batch via `IN (?,...)` — but do
not build it speculatively."

**Planning implication:** Implement with the naive per-seed loop (mirrors `retrieveCueless`
exactly). Add a lightweight timing assertion or manual `console.time` check during
implementation (not a blocking guard) to confirm the change stays within budget, since this is
now-confirmed real, felt latency, not deferred latency.

## Reuse Verification

### Two `retrieveRanked` emit sites (`src/retrieval/engine.ts`)

**`temporalAnnotate` branch — lines 497-503** (current):
```ts
const emitSeeds = vizSeedIds ?? annotated.map(r => r.id);
if (this.traceEnabled && emitSeeds.length > 0) {
  try {
    this.traceSink.emit({ query_id: newId(), seeds: emitSeeds, hops: [] });
  } catch { /* T-10-05 */ }
}
return annotated;  // line 504
```
`emitSeeds` is `string[]`; `hops` is always `[]`. Confirmed exact shape.

**Flat branch — lines 515-522** (current):
```ts
const emitSeeds = vizSeedIds ?? filtered.map(r => r.id);
if (this.traceEnabled && emitSeeds.length > 0) {
  try {
    this.traceSink.emit({ query_id: newId(), seeds: emitSeeds, hops: [] });
  } catch { /* T-10-05 */ }
}
return filtered;  // line 524
```
Same shape. CONTEXT.md's cited line numbers (~497-503, ~515-522) match current source exactly —
no drift.

### Curated mirror (`src/recall/index.ts:511-529`)

Confirmed exact shape:
```ts
if (this.traceEnabled) {
  try {
    const hops = neighborhood.map((n) => ({
      node_id: n.id,
      score:   null,   // WR-02: rank-only, no measured magnitude
      hop:     1 as const,
    }));
    this.traceSink.emit({ query_id: newId(), seeds: [{ node_id: bestMatch.id, score: null }], hops });
  } catch { /* T-10-05 */ }
}
```
Matches CONTEXT.md's cited target shape exactly: `seeds: [{node_id, score:null}]`,
`hops: [{node_id, score:null, hop:1}]`.

### `EdgeKind` enum (`src/lib/types.ts:38`)

```ts
export type EdgeKind = 'relation' | 'abstracts' | 'schema_rel' | 'cites' | 'doc_link' |
                        'doc_containment' | 'doc_reference' | 'derived_from';
```
8 kinds total, exactly matching D-05's allowlist framing (relation = allow; abstracts/schema_rel =
exclude structural; cites/doc_link/doc_containment/doc_reference = exclude corpus-document kinds).
`derived_from` (insight-reflector edges, Phase 38) is also structural, not associative — D-05's
"excluded" list in CONTEXT.md doesn't name it explicitly but it is correctly excluded by the
`kind==='relation'` allowlist regardless. Schema CHECK constraint at `src/db/schema.ts:63` mirrors
this exact 8-value enum (defense-in-depth at the DB layer).

**D-05a confirmed:** `links_to` (`cold-start.ts:108`) and `extends` (`consolidator.ts:1118`) DO
carry `kind='relation'` — verified directly at both write sites. This is also independently
documented at `src/recall/typed-traversal.ts:14-15,38-39,69,71` ("LANDMINE 2... links_to / extends
edges that share kind='relation'... PRED_SET.has(e.rel) && e.kind === 'relation'"). Since D-05's
allowlist is `kind==='relation'` (not additionally filtered by `rel` against `PRED_SET`), the
default lean in CONTEXT.md ("include all kind='relation' for simplicity") will include `links_to`/
`extends` edges as pathways. This is a deliberate scope choice already anticipated by CONTEXT.md,
not new information — reported here as confirmation only.

### Liveness filter (D-07)

The curated path filters BEFORE building `neighborhood` (not at emit time) — `recall/index.ts:432`
and `477`: `if (!neighbor || neighbor.tombstoned === 1) continue;`, applied while walking
`abstracts` edges into schema membership and while walking the sideways `schema_rel` hop's member
edges. By the time the emit code at line 511-529 runs, `neighborhood` already contains only live
nodes — there is no separate liveness check at the emit site itself.

`retrieveCueless`'s existing 1-hop pattern (`engine.ts:262-288`) applies the identical check
inline during the spread loop: `const neighbor = this.store.getNode(edge.dst); if (!neighbor ||
neighbor.tombstoned === 1) continue;` (line 275-276) — confirming this is the established,
consistent idiom across both existing emit-adjacent code paths.

**Planning implication for the ambient hop read:** apply the same explicit check
(`getNode(edge.dst)?.tombstoned !== 1`, or the exact `!neighbor || neighbor.tombstoned === 1`
form) when filtering each seed's out-edges before ranking by weight and truncating to top-N. Do
this filtering as an early step (before weight-sort/truncate), not after — otherwise a dead node
could occupy one of the N truncation slots and silently reduce live-hop density for that seed.
`getOutEdges`/`getOutEdgesWithRel` do **not** filter tombstoned dst themselves (explicit doc
comment, `semantic-store.ts:166-167`: "Excludes tombstoned neighbors at the application layer") —
this is by design, application-layer responsibility, consistently applied everywhere it's used.

### Machine-guard precedent (Phase 52 / honest-traces)

Two files carry the precedent:

1. **`tests/trace-honest-recall.test.ts`** (client-side, Phase 52) — the exact-N-hops / no-BFS /
   WR-02 / score-tracks-intensity guard pattern. Style: build a minimal `row` fixture, call the
   pure helper or `applyTrace`, assert exact-length matches and `null`-handling
   (`expect(result.length).toBe(row.hops.length)`, `expect(result[0].score).toBeNull()`). This
   file is **client-side** and does not need modification for Phase 55 (no client change) but is
   the template for phrasing "exactly N, never invented" assertions if the planner wants a
   parallel engine-side helper test.

2. **`tests/activation-trace-wiring.test.ts`** (server-side, engine trace wiring — **this is the
   file the planner must extend**):
   - `describe('engine: RecallEngine trace wiring')`, lines 146-196: the exact assertion style
     for the curated-path honesty guard — `expect(typeof trace.seeds[0]).toBe('object')`,
     `expect((trace.seeds[0] as any).score).toBeNull()`, and per-hop
     `expect(h.score).toBeNull(); expect(h.hop).toBe(1);` with a comment citing WR-02 directly.
   - `describe('engine: retrieveRanked vizFloor lights genuinely-retrieved nodes...')`, lines
     285-348: this is the **existing test block that exercises the exact two emit sites Phase 55
     changes**. **Load-bearing finding: lines 316-320 and 333 assert bare-string seeds** —
     `expect(sink.traces[0]!.seeds.sort()).toEqual(['hi','mid'])` and
     `expect([...sink.traces[0]!.seeds]).toEqual(['hi'])`. **These two assertions will fail once
     D-06 changes `seeds` to `{node_id,score}` objects** and MUST be updated (to e.g.
     `expect(sink.traces[0]!.seeds.map(s => (s as any).node_id).sort())`) as part of this phase's
     task list — not a new regression, but an existing test the phase will break if not updated.
   - `RetrievalEngine trace wiring`, lines 86-115: shows the existing pattern for asserting real
     (non-null) numeric hop scores via `typeof h.score === 'number'` — used by `retrieveCueless`,
     which has real boost-derived scores. Phase 55's `retrieveRanked` hops are rank-only
     (`score:null`, per D-06/WR-02) — the new guard should assert `h.score === null` (mirroring
     the `RecallEngine` block's style, not the `RetrievalEngine`/`retrieveCueless` block's style).

**Planning implication:** Task list must include (a) updating the two bare-string assertions in
the existing `retrieveRanked vizFloor` describe block, and (b) adding new assertions in the same
block (or a new describe block) for: exactly-top-N hops per seed, `kind==='relation'` filter
correctness (edges of other kinds present in a test fixture must not appear in `hops`), tombstoned
dst exclusion, and `score:null` on every hop while seed `score` carries the real value.

## Common Pitfalls

### Pitfall 1: Reusing `retrieveCueless`'s pattern verbatim (no kind filter)
**What goes wrong:** Copy-pasting `engine.ts:262-324` produces hops from `abstracts`/`schema_rel`/
doc-graph edges too, violating D-05.
**Why it happens:** `retrieveCueless` calls plain `getOutEdges` (no kind filter) because at the
time it was written there was no honesty-allowlist requirement — it predates Phase 55's scope.
**How to avoid:** Explicitly filter `edges.filter(e => e.kind === 'relation')` before rank/truncate
in the new code; do not assume the existing pattern already does this.
**Warning signs:** A guard test asserting a fixture with a mixed-kind edge set shows non-`relation`
edges leaking into `hops`.

### Pitfall 2: Truncating to top-N before the liveness filter
**What goes wrong:** If tombstoned-dst filtering happens after `slice(0, N)`, a dead edge can
occupy a truncation slot, silently reducing live pathway density below N even when more live
edges exist.
**Why it happens:** Natural code order is "get edges → sort by weight → take N → (then remember
to filter)" — liveness is easy to forget or place last.
**How to avoid:** Filter live-only, THEN sort-by-weight, THEN truncate to N (order matters).
**Warning signs:** Guard test with N+2 live edges + 1 tombstoned high-weight edge returns fewer
than N hops.

### Pitfall 3: Forgetting the two existing bare-string assertions
**What goes wrong:** CI goes red on unrelated-looking lines in `activation-trace-wiring.test.ts`
after the D-06 seed-shape change ships, looking like a regression rather than an expected update.
**Why it happens:** The assertions are in a describe block titled around `vizFloor`, not obviously
related to "seed shape" — easy to miss when scanning for D-06 impact.
**How to avoid:** Grep `tests/activation-trace-wiring.test.ts` for `.seeds` before considering the
phase's test changes complete; update lines ~316-320, ~333 explicitly.
**Warning signs:** `npm test` fails on `retrieveRanked vizFloor` tests after implementing D-06.

## Founder Checkpoint Items

1. **Edge-direction risk, corrected framing.** The out-edges-only decision (D-04) does NOT suffer
   the Phase-18 CR-01 lexicographic 50%-undercount mechanism — that only applies to `schema_rel`
   edges, and `kind='relation'` edges are genuinely directional, not lexicographically normalized.
   However, a related-but-different sparsity effect is real: nodes that are structurally
   "object-heavy" (frequently the target, rarely the source, of relation edges) will show fewer or
   zero out-edge hops even when well-connected. If the visual checkpoint shows some seed types
   (e.g., generic/canonical entities) consistently dark while others (subject-heavy facts) light
   up densely, this asymmetric-edge effect is the likely cause — not a bug, but worth the
   founder's eyes to confirm the resulting feel matches intent. The deferred "both-direction"
   option in CONTEXT.md remains the correct escape hatch if so.
2. **`links_to`/`extends` inclusion (D-05a).** Confirmed both carry `kind='relation'` and will be
   included under the default "include all relation-kind" lean. If pathways feel like they include
   too many wikilink/supersession edges (as opposed to purely associative triples) at the visual
   checkpoint, the fix is a `rel !== 'links_to' && rel !== 'extends'` exclusion inside the new
   filter — cheap to add later, not blocking for v1.
3. **Latency is real, not deferred.** Contrary to CONTEXT.md's framing suggestion that a slow read
   "would still not block the caller's return," the emit executes synchronously before return.
   The evidence strongly suggests this stays cheap (indexed prefix scan, ≤10 prepared-statement
   calls, less work than the existing `retrieveCueless` hot-path pattern already does under the
   same 45ms budget) — but this was reasoned from schema/code inspection, not an empirical
   benchmark run in this research session. Recommend a quick before/after timing check during
   implementation (not a blocking gate) rather than treating "no batching needed" as fully proven.

## Code Examples

### Existing canonical 1-hop pattern to mirror (with corrections noted)
```typescript
// Source: src/retrieval/engine.ts:262-324 (retrieveCueless) — mirror the SHAPE of this loop,
// but Phase 55 must ADD a kind==='relation' filter (this existing code has none) and an
// EXPLICIT liveness check applied BEFORE weight-sort/truncate (this existing code's liveness
// check is implicit via the `scores` map, which doesn't generalize to a weight-only top-N cap).
for (const [seedId, seedScore] of seeds) {
  const edges = this.store.getOutEdges(seedId);   // { dst, w, kind }[]
  for (const edge of edges) {
    const neighbor = this.store.getNode(edge.dst);
    if (!neighbor || neighbor.tombstoned === 1) continue;   // liveness (D-07) — mirror this
    // ... existing boost accumulation (NOT what Phase 55 does — Phase 55 ranks by edge.w, not boost)
  }
}
```

### Curated-path honest emit shape to replicate (seeds differ per D-06)
```typescript
// Source: src/recall/index.ts:511-529
const hops = neighborhood.map((n) => ({
  node_id: n.id,
  score:   null,      // WR-02 — Phase 55 hops are ALSO null (rank-only, real edge, no magnitude)
  hop:     1 as const,
}));
this.traceSink.emit({
  query_id: newId(),
  seeds: [{ node_id: bestMatch.id, score: null }],   // Phase 55: seeds carry REAL score (D-06)
  hops,
});
```

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The naive per-seed `getOutEdges` loop (≤10 calls) will stay within the ~45ms p50 budget without batching. | Research Flag 3 | Reasoned from schema (PK-prefix index) + prepared-statement reuse + comparison to `retrieveCueless`'s existing equal-or-greater workload on the same path — not empirically benchmarked in this session. If wrong, a bound `IN (?,...)` batched query is a low-risk mechanical follow-up, not a redesign. |

**No other assumptions** — all other claims in this research are `[VERIFIED: live source, file:line
cited]` via direct grep/Read of the actual TypeScript/JS source, not training-data recall or
unverified web search.

## Open Questions (RESOLVED)

None outstanding. All three CONTEXT.md research flags are resolved; all reuse-verification items
are confirmed with file:line anchors.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run tests/activation-trace-wiring.test.ts` |
| Full suite command | `npm test` (== `vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SC3 (honesty invariant) | `retrieveRanked` hops are real `kind='relation'` out-edges, never fabricated | unit | `npx vitest run tests/activation-trace-wiring.test.ts -t "retrieveRanked"` | ✅ existing describe block, needs new assertions + 2 fixed assertions |
| SC3 | Emitted hops exclude `abstracts`/`schema_rel`/doc-graph kinds (D-05 allowlist) | unit | same file, new `it()` | ❌ Wave 0 — new test |
| SC3 | Emitted hops exclude tombstoned dst (D-07 liveness) | unit | same file, new `it()` | ❌ Wave 0 — new test |
| SC3 | Seed shape is `{node_id, score}` with real score (D-06) | unit | same file, update existing `it()`s at lines ~307-334 | ⚠️ existing tests will FAIL until updated — this is expected/required, not a gap |
| — | Per-seed hop count ≤ N (D-01/D-02) | unit | same file, new `it()` | ❌ Wave 0 — new test |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/activation-trace-wiring.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- Update `tests/activation-trace-wiring.test.ts` lines ~316-320, ~333 (bare-string seed
  assertions → object-shape assertions) — required, not optional, or the suite goes red on
  implementation.
- New `it()` blocks in the same file/describe area for: kind-allowlist filtering, liveness
  filtering, top-N cap, real-vs-null score split (seed real, hop null).

*(No new test framework or fixture infrastructure needed — `MockActivationTraceSink` and
`makeRetrievalDeps`/`seedThreeNodes` helpers already exist and cover the needed shapes.)*

## Security Domain

`security_enforcement` is not set in `.planning/config.json` (absent = enabled), so this section
is included per protocol. This phase has no new external input surface: it reads from the
existing `edge` table (already-trusted, single-writer, sole-writer-is-Consolidator invariant
unchanged) via existing prepared statements, and writes to the existing `activation_trace` sink
via the existing bound-param INSERT. No new user input, no new SQL string construction, no new
network surface.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | No auth surface touched |
| V3 Session Management | No | — |
| V4 Access Control | No | Single-tenant, no new access boundary |
| V5 Input Validation | No (read-only reuse of existing validated writes) | N/A — no new external input parsed |
| V6 Cryptography | No | — |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via edge-kind filter | Tampering | N/A — `kind==='relation'` filtering happens in JS after the prepared-statement read returns rows; no new SQL string is built. Continue using bound `?` params only (T-01-SQL, already the existing convention throughout `semantic-store.ts`). |
| DoS via unbounded trace payload | Denial of Service | Already mitigated — D-01's per-seed top-N cap plus the existing `RING_CAP=50` ring-buffer eviction (`activation-sink.ts:33`) bound total payload size; no new unbounded loop introduced. |

## Project Constraints (from CLAUDE.md)

- **Consolidator-is-sole-graph-writer**: this phase performs reads only (`getOutEdges`/
  `getOutEdgesWithRel`, `getNode`) — no new writer introduced. Confirmed compliant by design (D-04
  scope is "read of edges that already exist").
- **Emits MUST be fire-and-forget, try/catch, never affect the retrieval path (T-10-05)**: both
  existing emit sites already wrap in try/catch; the new edge-read code must stay inside the same
  guard block (do not hoist the read outside the try/catch).
- **LLM-free hot path**: confirmed — no LLM call anywhere in this phase's scope; pure SQLite reads.
- **Graph is source of truth; vector store is derived cache**: unaffected — no vector-store
  interaction in this phase.
- **Net-zero new runtime dependencies**: confirmed satisfiable — no new package needed; reuses
  existing `getOutEdges`/`getOutEdgesWithRel` prepared statements.

## Sources

### Primary (HIGH confidence — live source read directly in this session)
- `src/retrieval/engine.ts` (lines 262-324, 460-524) — retrieveCueless 1-hop pattern, both
  retrieveRanked emit sites
- `src/recall/index.ts` (lines 430-460, 490-529) — curated-path liveness filter + emit shape
- `src/db/semantic-store.ts` (lines 160-220, 460-560) — `getOutEdges`/`getOutEdgesWithRel`
  prepared statements, upsertEdge, getInEdges
- `src/db/schema.ts` (lines 57-65) — `edge` table CREATE + PRIMARY KEY(src,dst,rel) + kind CHECK
- `src/lib/types.ts` (lines 1-70) — `EdgeKind` enum
- `src/consolidation/consolidator.ts` (lines 930-1130) — the two `kind='relation'` write sites
  (typed triples, extends)
- `src/seeder/cold-start.ts` (lines 85-115) — the third `kind='relation'` write site (links_to)
- `src/consolidation/schema-relations.ts` (lines 295-370) — the `schema_rel` lexicographic
  src<dst convention (confirming it is distinct from `relation`)
- `src/recall/typed-traversal.ts` (lines 1-75) — LANDMINE 2 documentation of links_to/extends
  sharing `kind='relation'`
- `src/viz/modules/trace.js` (lines 1-30, 130-145, 578-870) — `normalizeSeed`, back-compat wrapping
- `src/viz/modules/hud.js` (lines 145-160) — SSE listener, full-row pass-through
- `src/viz/activation-sink.ts` (full file) — synchronous emit contract, RING_CAP, sink variants
- `tests/activation-trace-wiring.test.ts` (full file) — existing machine guards + the two
  assertions that will break under D-06
- `tests/trace-honest-recall.test.ts` (full file) — Phase 52 client-side honesty guard template
- `.planning/config.json`, `package.json`, `vitest.config.ts` — workflow/test-framework config

### Secondary (MEDIUM confidence)
- None — every claim in this research was verified against live source in this session; no
  WebSearch or unverified secondary source was used (this phase is a pure internal-codebase
  research task, no external library/API knowledge needed).

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Edge-storage direction (Flag 1): HIGH — grepped every `upsertEdge` call site and every `kind:`
  literal in the codebase; exhaustive, not sampled.
- Client seed-shape acceptance (Flag 2): HIGH — read the exact `normalizeSeed` implementation and
  its call sites; confirmed by existing passing tests.
- Hot-path latency (Flag 3): MEDIUM-HIGH — schema/code evidence is strong (indexed PK, prepared
  statements, less work than existing equivalent-budget code), but no empirical timing benchmark
  was run this session (see Assumption A1).
- Reuse verification: HIGH — every cited file:line was read directly and quoted verbatim.

**Research date:** 2026-06-30
**Valid until:** Source-code research on an actively-developed internal codebase — valid until the
next commit touches `src/retrieval/engine.ts`, `src/db/semantic-store.ts`, `src/recall/index.ts`,
or `src/viz/modules/trace.js`/`hud.js`. Re-verify file:line anchors if planning is delayed by more
than a few days or if intervening phases (56+) touch these files.
