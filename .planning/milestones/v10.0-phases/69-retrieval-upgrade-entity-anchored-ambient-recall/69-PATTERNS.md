# Phase 69: Retrieval Upgrade — Entity-Anchored Ambient Recall - Pattern Map

**Mapped:** 2026-08-03
**Files analyzed:** 10 (7 modified, 3 new)
**Analogs found:** 10 / 10 (all in-repo; every seam this phase touches has a direct or near-direct
precedent — this phase composes existing machinery more than it invents new shapes)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/adapter/ambient-recall.ts` (MOD) | adapter/orchestrator | request-response | itself (prior version) — extend in place | exact (self) |
| `src/retrieval/engine.ts` `retrieveRanked` (MOD) | service (retrieval engine method) | request-response | itself (prior version) — extend in place | exact (self) |
| `src/consolidation/entity-resolution.ts` (MOD, light refactor) | service (candidate generator) | CRUD (read-only lookup) | itself — `generateCandidates` is already the Phase-69 reuse seam per its own header | exact (self) |
| `src/retrieval/entity-anchor.ts` (NEW) | utility/service | transform + CRUD (read-only) | `src/consolidation/entity-resolution.ts` (generator shape) + `src/db/semantic-store.ts:resolveEntityByName` (lookup ladder) | role-match |
| `src/recall/index.ts` `RecallEngine.recall()` (MOD, new evidence branch) | service | request-response | itself — extend the existing Case A/B schema branch shape | exact (self) |
| `src/adapter/recall-cli.ts` (MOD, `--evidence` flag) | controller/CLI adapter | request-response | itself — mirrors the existing `--scope` flag plumbing exactly (lines 76-88, 113-118) | exact (self) |
| `src/lib/config.ts` (MOD, new knobs) | config | — | `entityResolutionFloor`/`entityResolutionMargin` (:380-403) + `bm25FusionWeight`/`rankStrengthWeight` (:474-496) dark-knob doc-comment shape | exact (convention) |
| `scripts/eval/recall-audit-gate.cjs` (NEW) | test/gate runner | batch | `scripts/eval/drift-05-dry-run.cjs` (dry-run/real-run split) + `scripts/eval/gate-accuracy-runner.cjs` (mode-guard, baseline-floor gate shape) | role-match |
| `tests/entity-anchor.test.ts` (NEW) | test | request-response | `tests/recall-scope.test.ts` (temp-DB, fixed-vec, deterministic-order harness) | exact |
| `tests/ambient-recall.test.ts` (MOD, new cases) | test | request-response | itself — extend existing `describe('ambientRecall', ...)` block | exact (self) |

## Pattern Assignments

### `src/adapter/ambient-recall.ts` (adapter, request-response) — RECALL-01/02/03

**Analog:** itself (prior version), `src/adapter/turn-capture-cli.ts` (cwd availability), `src/adapter/session-start-cli.ts:134-136` (cwd-threading precedent)

**Imports pattern** (lines 22-30, keep as-is, add):
```typescript
import { SemanticStore } from '../db/semantic-store';
import { CandidateRetriever, vectorIndexPath } from '../retrieval/topk';
import { StrengthDecayManager } from '../strength/decay';
import { AllocationGate } from '../gate/allocation-gate';
import { RetrievalEngine } from '../retrieval/engine';
import { SwitchableActivationTraceSink } from '../viz/activation-sink';
// NEW for RECALL-01:
import { EntityResolver } from '../consolidation/entity-resolution'; // or the extracted entity-anchor.ts wrapper
import { cwdToScope, GLOBAL_SCOPE } from '../lib/scope'; // NEW for RECALL-02 nudge
```

**Tuning-knob block convention** (lines 37-73) — every new knob follows this exact doc-comment
shape (rationale + calibration note + dark-default statement):
```typescript
/** Max facts surfaced per prompt (breadth of the ambient block). */
export const AMBIENT_K = 5;

/**
 * Minimum cosine for a fact to surface ambiently. Deliberately ABOVE the
 * memory_search floor (0.3): ambient injection is unsolicited, so precision
 * beats recall here.
 * ...
 */
export const AMBIENT_FLOOR = 0.45;
```
New RECALL-01/02/03 knobs (`entityAnchorEnabled`, `sameProjectRankNudge`/`foreignDocDemotion`,
`ambientHopInjectionEnabled` or similar — naming is planner discretion) belong in
**`src/lib/config.ts`**, not as module constants here — this file's constants (AMBIENT_K,
AMBIENT_FLOOR, AMBIENT_VIZ_FLOOR, MAX_VALUE_CHARS) are non-config tunables (D-05/55-01
precedent: "private, not config" for topN-style literals vs `EngineConfig` for
behavior-toggling dark knobs). Follow which bucket each new knob belongs to:
- **behavior-toggling / dark-launch-gated** (entity anchoring on/off, nudge on/off, hop-injection
  on/off) → `EngineConfig` fields in `src/lib/config.ts` (see that section below).
- **pure magnitude tuning** (AMBIENT_HOP_TOPN-style caps) → private module constant, per the
  55-01 precedent already in `engine.ts:50`.

**Core retrieveRanked call — the exact seam to extend** (lines 126-133):
```typescript
// retrieveRanked emits the viz trace itself when the flag is on. With vizFloor it
// lights the genuinely-retrieved nodes down to AMBIENT_VIZ_FLOOR even when nothing
// clears the injection floor — so the brain lights on essentially every prompt (a
// real read happened), while injection still uses AMBIENT_FLOOR. Do NOT add a second
// emit here.
const engine = new RetrievalEngine(db, clock, config, retriever, store, strength, gate, traceSink);
const results = engine.retrieveRanked(vec, AMBIENT_K, AMBIENT_FLOOR, undefined, { vizFloor: AMBIENT_VIZ_FLOOR });
if (results.length === 0) return '';
```
RECALL-01 union point: generate entity-anchored candidates from `promptText` (distinctive-token
extraction → `resolveEntityByName`/`generateCandidates`) BEFORE or alongside this call, then
union their facts into `results` (or pass as a new `retrieveRanked` opt — see engine.ts section)
before the `AMBIENT_K` slice at line 138. The `undefined` 4th arg (queryText) intentionally
routes to pure cosine topk (per-file header: "LLM-free by construction... ONE embedding call");
entity anchoring is a SEPARATE indexed-lookup channel, not a change to that `undefined` — do not
flip it to `promptText` (that would silently re-enable `bm25FusionWeight`, violating D-04).

**Injected-block renderer — the exact seam to extend** (lines 135-153):
```typescript
const surfaced = results.slice(0, AMBIENT_K);

// D-S6 provenance surfacing: batch-read scopes AFTER ranking/selection — this read
// NEVER influences score, filter, or order (D-S1). A non-global scope renders as a
// `[slug]` prefix; 'global' and unscoped nodes render with no marker (keeps the block
// lean — only project-specific provenance is flagged). Display-only by construction.
const scopes = store.getNodeScopes(surfaced.map(r => r.id));

const lines = ['Recalled from recense (ambient):'];
for (const r of surfaced) {
  const origin = store.getNode(r.id)?.origin ?? 'observed';
  const scope = scopes.get(r.id);
  const marker = scope && scope !== 'global' ? `[${scope}] ` : '';
  lines.push(`- ${marker}${r.value.slice(0, MAX_VALUE_CHARS)} (${origin}, score ${r.score.toFixed(2)})`);
}
return lines.join('\n');
```
RECALL-03 (hop injection) and RECALL-02 (doc-type rendering) both extend this loop:
- Doc-type check: `store.getNode(r.id)?.type === 'doc'` (NodeType includes `'doc'`,
  `src/lib/types.ts:26`) → render `title + recense://doc/<id>` instead of
  `r.value.slice(0, MAX_VALUE_CHARS)`. The `recense://doc/<id>` format precedent is the corpus
  layer's citation vocabulary (`src/reader/doc-generator.ts:56-70`, `src/reader/insight-generator.ts:104`
  — `recense://fact/<id>` and `recense://doc/<id>`, both raw node ids, never transformed).
  `node_doc.slug` (`src/lib/types.ts:178-183`) carries the project slug if a human-readable
  identifier is wanted in the title instead of/alongside the id.
- Hop lines: reuse `buildHonestOneHopTrace` (already imported transitively via engine.ts, or
  call directly — see honest-trace.ts section) on `surfaced` as seeds; render `relation +
  neighbor label` compactly per fact, inside the existing per-line budget. D-06: facts win over
  hops if budget forces a choice.

**RECALL-02 nudge — the cwd/scope threading gap (must be added, does not exist today):**
`ambientRecall()`'s signature currently takes NO `cwd` param, so there is no "current project"
to compare a candidate's scope against. `turn-capture-cli.ts:68,86` already extracts `cwd` from
the hook payload but does not thread it into `ambientRecall()` (line 118: `ambientRecall(db,
promptText, provider, config, realClock)` — 5 args, no cwd). The precedent for threading cwd
into a retrieval call is `session-start-cli.ts:134-136`:
```typescript
// Pass cwd for soft project scoping (DEBT-06): project-specific + global facts surface;
const result = engine.retrieveCueless(cwd);
```
and the scope derivation is `cwdToScope` (`src/lib/scope.ts:43-59`, pure, no I/O). The nudge
compares `cwdToScope(cwd)` (current project) against each candidate's `store.getNodeScope(id)`
(already read via `getNodeScopes` at line 144) — same batch scope read, reused for BOTH the
existing `[slug]` marker AND the new nudge, not a second read.

**Threat-mitigation doc-comment header convention** (lines 1-20) — every new behavior this
phase adds should get a corresponding bullet in the file's threat-mitigations header (mirrors
T-RT1-01/03/05 style): e.g. a new T-RT1-06 for "entity-anchor lookup is read-only, indexed,
no new network I/O" if the planner wants to keep the numbering scheme going.

---

### `src/retrieval/engine.ts` `retrieveRanked` (service, request-response) — RECALL-01/02

**Analog:** itself (prior version) — this method already has the exact extension points

**Signature + the flat-topk-vs-hybrid branch** (lines 415-435):
```typescript
retrieveRanked(
  queryVec: Float32Array,
  k: number,
  floor: number,
  queryText?: string,
  opts?: { temporalAnnotate?: boolean; vizFloor?: number },
): Array<{ id: string; value: string; score: number }> {
  const hits = queryText
    ? this.retriever.hybridTopk(
        queryVec, queryText, k, undefined,
        this.config.rankStrengthWeight,
        this.clock.nowMs(),
        this.config.lambda,
        this.config.bm25FusionWeight,
      )
    : this.retriever.topk(queryVec, k);
  ...
```
This is the "flat top-k + floor + stale-entity filter" the seed's `engine.ts:542` comment
names as the thing being upgraded (comment now sits at line 542, confirmed live). Precedent for
extending `opts` with a new optional field is `opts.vizFloor` and `opts.temporalAnnotate`
themselves — both are opt-in, non-breaking additions to the same object, gated by `!= null`
checks (line 470: `if (opts?.vizFloor != null && opts.vizFloor < floor)`). RECALL-01 candidate
union should follow the SAME pattern: e.g. `opts?.entityAnchoredIds?: string[]` or a fully
separate pre-union performed by the caller (`ambient-recall.ts`) BEFORE `retrieveRanked` is
called, unioned into `candidates` after line 449 (post-floor-filter) or merged into `hits`
before line 440 (pre-floor, so entity-anchored facts still pass through the same floor/
stale-entity-filter/vizFloor machinery uniformly). Prefer union-before-floor so a
weakly-cosine-but-name-matched fact still needs to clear SOME bar (own bar or same bar — planner
discretion) rather than bypassing the floor guard entirely.

**Stale-entity filter (reuse as-is, do not duplicate)** (lines 451-456):
```typescript
const staleEntityIds = new Set<string>(
  (this.stmtStaleEntityIds.all() as Array<{ id: string }>).map(r => r.id),
);
const filtered = candidates.filter(r => !staleEntityIds.has(r.id));
```
Entity-anchored candidates MUST pass through this same filter — do not special-case them around
B2 stale-entity exclusion.

**Trace-emission fire-and-forget guard (mirror exactly for any new emit path)** (lines 556-563):
```typescript
if (this.traceEnabled && emitSeeds.length > 0) {
  try {
    const { seeds, hops } = this.buildAmbientTracePayload(emitSeeds);
    this.traceSink.emit({ query_id: newId(), seeds, hops });
  } catch {
    // Fire-and-forget: a sink failure must never surface to the caller (T-10-05).
  }
}
```

**Header doc-comment to extend** (lines 393-414) — the big method-level comment already
documents B1/B2/B3, LEVER 2, and the "DO NOT modify retrieve()/retrieveCueless()" guard; add
the RECALL-01/02 union+nudge behavior here following the same D-xx-tagged prose style.

---

### `src/consolidation/entity-resolution.ts` (service, CRUD read-only) — RECALL-01 (D-02)

**Analog:** itself — already the designated reuse seam, header says so explicitly

**The exact reuse contract** (lines 1-13, verbatim):
```typescript
/**
 * EntityResolver — standalone, reusable entity-resolution seam (Phase 64, Plan 64-02).
 *
 * Two responsibilities, both exported for reuse:
 *  (a) `generateCandidates` — a **three-channel union candidate generator**
 *      (exact/entity-keyed ∪ BM25 lexical ∪ dense cosine), deduped across channels by node id.
 *      This is the Phase 69 (Entity-Anchored Ambient Recall) reuse contract: the generator
 *      is type-agnostic (`nodeType` is opt-in, not hard-coded) so a future caller can anchor
 *      retrieval against any node type without a second divergent implementation.
 *  (b) `resolve` — a **confident-or-null** decision over that generator ...
 */
```

**`generateCandidates` call shape** (lines 171-268) — call this directly for RECALL-01, do NOT
call `resolve()` (that applies the confident-or-null floor/margin policy, which is wrong for
recall — recall wants to UNION candidates for ranking, per D-02: "The recall path needs the
GENERATOR..., not the confident-or-null resolver policy: recall unions candidates for ranking
rather than abstaining"):
```typescript
generateCandidates(opts: {
  text: string;
  vec?: Float32Array;
  nodeType?: string;
  k?: number;
}): { candidates: EntityCandidate[]; channelCounts: ChannelCounts }
```
`EntityCandidate` shape (lines 64-74) carries `id, value, lex, dense, score, channels` — the
recall path needs to map `EntityCandidate.id` to a node lookup (`store.getNode(id)`) and then
walk its facts/edges (via `getOutEdgesWithRel` or `getEdgesForNode`) to union in the ENTITY'S
FACTS, not just the entity node's own value — an entity node's value is usually just its name;
the facts are elsewhere in the graph, connected by edges (see semantic-store.ts section below).

**D-02's own anticipated light-refactor note** — if `generateCandidates` needs to be called from
`ambient-recall.ts` without instantiating a full `EntityResolver` (which requires `db, store,
config` in its constructor, lines 149-165), either: (a) construct `EntityResolver` in
`ambient-recall.ts` exactly like `RetrievalEngine` already is (same file, same DI pattern), or
(b) extract `generateCandidates`'s logic into a standalone exported function callable without
the class wrapper. D-02 explicitly pre-authorized this: "If the seam needs a light refactor to
expose generation without resolution policy, that refactor is in scope... duplicating it is
not." Prefer (a) — matches the file's existing DI-everywhere convention and needs zero new
exports.

**Constructor DI shape to mirror** (lines 149-165):
```typescript
constructor(db: Database.Database, store: SemanticStore, config: EngineConfig) {
  this.store = store;
  this.config = config;
  this.stmtCandidateNodes = db.prepare(`...`);
  this.stmtFtsCandidates = db.prepare(`...`);
}
```

---

### `src/retrieval/entity-anchor.ts` (NEW — utility, transform + read-only CRUD) — RECALL-01 (D-03)

**Closest analogs:** `src/consolidation/entity-resolution.ts` (candidate-generator shape),
`src/db/semantic-store.ts:519-528` `resolveEntityByName` (the lookup ladder), and
`src/consolidation/normalize.ts` `normalizeValue` (referenced at entity-resolution.ts:54,
used for tokenization).

**`resolveEntityByName` — the exact indexed-lookup primitive to build on** (lines 507-528):
```typescript
/**
 * Resolve a typed-triple entity NAME to a node id for typed-edge minting (Phase 37 Fix-2).
 *
 * Priority order, returning the first hit:
 *   1. exact match on a `type='entity'` node (case-insensitive)
 *   2. exact match on any node type (rare — a fact node whose value IS the name)
 *   3. shortest `type='entity'` node CONTAINING the name, length-capped at 3× the name
 *      so a short name cannot bind to a long fact-sentence that merely contains it
 * ...
 */
resolveEntityByName(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  const exact = this.stmtResolveExactEntity.get(n) as { id: string } | undefined;
  if (exact) return exact.id;
  const exactAny = this.stmtResolveExactAny.get(n) as { id: string } | undefined;
  if (exactAny) return exactAny.id;
  const contains = this.stmtResolveContainsEntity.get({ name: n }) as { id: string } | undefined;
  return contains?.id ?? null;
}
```
This is a SINGLE-name resolver. D-03 requires DISTINCTIVE-TOKEN extraction from the whole
prompt first (capitalization/rarity heuristics, planner discretion) — the new file's job is:
(1) tokenize/extract candidate name-strings from `promptText` (pure function, no DB), (2) for
each candidate string call `resolveEntityByName` (or the `generateCandidates` exact-channel,
which already calls `resolveEntityByName` internally at line 187) against live entity nodes,
(3) for each resolved entity id, fetch its connected facts (via `getOutEdgesWithRel`/
`getEdgesForNode`, see semantic-store section), (4) return a candidate-fact list ready to union
into `retrieveRanked`'s output.

**LLM-free constraint (header convention to mirror)** — `entity-resolution.ts:23-24`:
```typescript
*  D-04  Zero net-new LLM calls — TYPE-LEVEL guarantee: the constructor below has no
*        `ModelProvider` parameter, so this module cannot call a provider even by mistake.
```
The new module should carry the same type-level guarantee: no `ModelProvider` import, no
`provider.embed`/`provider.generate` call anywhere in the file — enforce this by NOT accepting
a provider param in any exported function signature.

---

### `src/db/semantic-store.ts` — entity-fact traversal + scope reads — RECALL-01/02

**Analog:** itself — the read methods already exist; no new SQL needed for the base traversal

**`getOutEdgesWithRel` — typed traversal (use this, not `getOutEdges`)** (lines 491-504):
```typescript
/**
 * Read all outgoing edges from a node, INCLUDING the `rel` predicate field (Phase 37, D-01).
 * Use this for ANY predicate-filtered typed traversal — getOutEdges omits rel, causing
 * predicate filters to silently drop all edges (LANDMINE 1 / Pitfall 1).
 * After calling, always filter by PRED_SET.has(edge.rel) to exclude `links_to` / `extends`
 * edges that share kind='relation' but are NOT typed predicates (LANDMINE 2).
 */
getOutEdgesWithRel(nodeId: string): Array<{ dst: string; rel: string; w: number; kind: string }> {
  return this.stmtGetOutEdgesWithRel.all(nodeId) as Array<{ dst: string; rel: string; w: number; kind: string }>;
}
```
This IS the `HonestTraceReader` interface method `buildHonestOneHopTrace` depends on
(`honest-trace.ts:32`) — reuse the identical read for entity-anchoring's "what facts does this
entity connect to" question. Filter with `PRED_SET` (imported from `../model/typed-predicates`)
exactly as `honest-trace.ts:49` does, so entity-anchored facts and 1-hop-injected facts share
one filtering discipline.

**`getEdgesForNode` — bidirectional, less commonly what you want** (lines 550-557): reads
edges in EITHER direction; used today only by the entity-dedup rewire pass. Prefer
`getOutEdgesWithRel` for the entity→facts direction (entities are typically the `src` of their
defining relation edges).

**`getNodeScopes` — the batch scope read to reuse for the nudge (already used for the `[slug]`
marker)** (lines 659-675):
```typescript
/**
 * Batch-read scopes for several node ids → Map<node_id, scope> (recall surfacing, D-S6).
 * Avoids N queries on the recall display path. Nodes without a scope row are simply
 * absent from the returned Map (caller treats absence as 'global'). Display-only — this
 * read happens AFTER ranking and never influences selection/order (D-S1).
 */
getNodeScopes(nodeIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (nodeIds.length === 0) return out;
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = this.db
    .prepare(`SELECT node_id, scope FROM node_scope WHERE node_id IN (${placeholders})`)
    .all(...nodeIds) as Array<{ node_id: string; scope: string }>;
  for (const r of rows) out.set(r.node_id, r.scope);
  return out;
}
```
IMPORTANT: the doc-comment says "never influences selection/order (D-S1)" — this is the EXACT
line D-01 (the phase's D-S1 reversal) partially overrides for the ambient path ONLY. When the
planner wires the nudge, update THIS comment (or add an adjacent one) to record that
`ambient-recall.ts` now reads this map for BOTH display AND a bounded rank nudge, while
`RecallEngine.recall --scope` and every other caller keeps the original filter-never semantics
untouched. Do not silently let the nudge look like a violation of the stated invariant — the
comment must explain the carve-out inline, per D-01's requirement that "the planner must carry
it into the plan and the SUMMARY must restate it."

**`resolveEntityByName`** — already excerpted above (entity-anchor.ts section).

---

### `src/recall/index.ts` `RecallEngine.recall()` (service, request-response) — RECALL-04 (D-07)

**Analog:** itself — the existing Case A/B branch structure is the shape to extend

**Method signature + doc comment to extend** (lines 119-139):
```typescript
/**
 * ...
 * Optional `scope` parameter (RECALL-01, D-01): when provided, the assembled neighborhood
 * is post-filtered to retain only members whose node_scope is `scope` OR `GLOBAL_SCOPE`.
 * ...
 */
async recall(query: string, sessionId: string, scope?: string): Promise<RecallResult> {
```
RECALL-04's evidence mode is a NEW optional parameter in the same style (`evidence?: boolean`),
mirroring how `scope?: string` was added in a prior phase without breaking the default (prose)
path. Precedent for "prose is default, new mode is opt-in via an extra param" is this exact
`scope` param.

**`RecallResult` interface — extend, don't replace** (lines 54-63):
```typescript
export interface RecallResult {
  /** The ephemeral schema-prior inference. null if no schema found or compose failed. */
  inference: string | null;
  /** The id of the logged inferred-origin episode (for source_inference_id backfill). */
  episodeId: string | null;
  /** Tagged 'inferred' — callers must treat this as ephemeral, never write it to the graph. */
  origin: 'inferred';
}
```
RECALL-04 output (cited node ids + traversed edges) is a NEW field on this interface (e.g.
`evidence?: { nodeIds: string[]; edges: Array<{src: string; rel: string; dst: string}> }`) or a
sibling interface returned instead of `inference` when evidence mode is on — planner discretion,
but whichever shape is chosen, it must NOT remove or repurpose the existing 3 fields (every
current caller destructures them).

**Where evidence data already exists in this method (reuse, don't re-fetch):** the typed-path
branch (lines 179-253) already assembles `typedFrontier` (node ids) + `matchedPredicate` (the
traversed relation) + `anchorNode`/`anchorLabel` — this IS a cited-node-ids-plus-traversed-edges
payload already sitting in memory before the LLM `generate()` call at line 228. Evidence mode
should short-circuit HERE (before the `provider.generate` prompt-compose call) and return the
raw triples instead of composing prose — this is genuinely LLM-free for the typed-path branch.
The schema-neighborhood branch (lines 255+, not fully read but structurally symmetric per the
header) will have its own bestMatch/schemaNode/neighborhood node ids to expose the same way.

**Hard invariant to preserve (header, lines 18-24, do not weaken):**
```typescript
/**
 * Hard invariants:
 *  - NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen.
 *    The inference is NEVER a graph fact (LEARN-02 ephemeral-as-fact guarantee).
 * ...
 */
```
Evidence mode must be READ-ONLY exactly like prose mode — D-07's requirement ("read-only — no
strengthening, no `activation_trace` fabrication, D-43 untouched") is already this file's
existing discipline; do not add a new write path.

---

### `src/adapter/recall-cli.ts` (controller/CLI, request-response) — RECALL-04 (D-07)

**Analog:** itself — the `--scope` flag is the EXACT precedent for a new `--evidence` flag

**Flag resolver pattern to copy verbatim-shape** (lines 81-88):
```typescript
/**
 * Resolve the optional --scope <slug> flag from argv (RECALL-01).
 * Returns the lowercased slug, or undefined if --scope is absent or its value is empty.
 * Validation is permissive — an empty/missing value resolves to undefined (treated as no scope).
 * T-04-03-I: slug is used only as an equality filter in RecallEngine, never interpolated.
 */
function resolveScope(): string | undefined {
  const argv = process.argv;
  const idx = argv.indexOf('--scope');
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  if (typeof val !== 'string' || val.trim() === '' || val.startsWith('-')) return undefined;
  return val.trim().toLowerCase();
}
```
A bare boolean flag (`--evidence`, no value) is even simpler — mirror the `IS_PROBE`/`IS_RUN`
boolean-flag pattern from `gate-accuracy-runner.cjs:37-38` instead
(`process.argv.includes('--evidence')`) since there's no value to parse.

**`resolveQuery`'s flag-skip list must be updated** (lines 56-73) — the `--db`/`--query`/
`--scope` skip-list at line 68 (`if (a === '--db' || a === '--query' || a === '--scope') { i++;
continue; }`) consumes a VALUE for each flag it lists. A bare `--evidence` boolean flag does NOT
consume a following token, so it must be added to the "skip flags" branch (line 69:
`if (a === undefined || a.startsWith('-')) continue;`) which already catches any bare `-`-
prefixed token — no change needed there, but confirm `--evidence` isn't accidentally treated as
a value-consuming flag in the first skip-list.

**Call-site to extend** (lines 172-174):
```typescript
const result = await engine.recall(query, 'recall-session', scope);
process.stdout.write(JSON.stringify(result));
```
Thread the new `evidence` boolean through to `engine.recall(query, 'recall-session', scope,
evidence)` (or an opts object if the signature is getting crowded — planner discretion).

**Error-discipline convention (JSON-always-on-stdout, never raw errors)** — the whole file's
governing rule (lines 90, 128-131, 177-180): `SAFE_NULL_RESULT` is always written before any
early exit. If evidence mode's output shape differs from prose mode's, `SAFE_NULL_RESULT` may
need an evidence-mode-shaped sibling constant so early exits under `--evidence` still return
parseable JSON matching the caller's expected shape.

---

### `src/lib/config.ts` (config) — dark-knob conventions for ALL new RECALL-0x knobs (D-05, D-09)

**Analog:** `entityResolutionFloor`/`entityResolutionMargin` (lines 380-403) — MOST RECENT
precedent, same phase-64 lineage this phase extends; `bm25FusionWeight` (lines 489-496) —
the canonical "isolation switch" dark-default pattern; `rankStrengthWeight` (lines 476-487) —
the canonical "ships at 0, no behavior change at merge" pattern; `insightSurfacingEnabled`
(referenced around line 704-711) — the canonical boolean dark-knob pattern.

**Doc-comment shape to copy exactly** (lines 489-496):
```typescript
/**
 * Phase 47 RETR-02: BM25 fusion weight for the rrfFuse call in hybridTopk.
 * Controls how strongly lexical (BM25) matches contribute relative to cosine (fixed at 1.0).
 * Dark isolation switch: weight=0 reproduces exactly today's pure-cosine behavior
 * (mirrors bm25CandidateK=0 and rankStrengthWeight=0 conventions — D-02).
 * Tune via held-out LoCoMo sweep; ship w* = argmax(R@5) with zero per-category regression (D-04/D-05).
 */
bm25FusionWeight: number;
```
Every new RECALL-0x knob in `EngineConfig` needs: (1) a phase/decision tag in the first line,
(2) what the knob controls, (3) the exact dark-default value AND why that value reproduces
pre-phase behavior byte-for-byte, (4) what un-gates it (the eval gate, per D-09: "enabling them
live is gated on D-08 passing"). Candidate new fields (naming is planner discretion per
CONTEXT.md "Claude's Discretion"):
- `entityAnchoringEnabled: boolean` (dark default `false`) — RECALL-01 master switch.
- `sameProjectRankNudge` / `foreignDocDemotion` (numeric weight(s), dark default `0`) — RECALL-02,
  mirroring `bm25FusionWeight`'s "weight=0 → pure pre-phase behavior" isolation-switch shape.
- `ambientHopInjectionEnabled: boolean` (dark default `false`) — RECALL-03.
- `recallEvidenceModeEnabled` is likely NOT needed as a config knob at all — D-07 frames it as a
  CLI flag/mode (caller-selected), not a dark-launch-gated behavior change to existing output
  (prose stays default regardless). Only add a config knob here if the planner decides evidence
  mode itself needs a kill-switch independent of the `--evidence` flag.

**`DEFAULT_CONFIG` entries — the value+comment pairing convention** (lines 961-1005):
```typescript
entityResolutionFloor: 0.75,   // Phase 64 D-05: conservative confident-or-null score floor
entityResolutionMargin: 0.15,  // Phase 64 D-05: conservative confident-or-null top-2 margin
...
rankStrengthWeight: 0,  // D-04: dark default — ships w=0; no behavior change at merge
bm25FusionWeight: 0,  // Phase 47 D-05: w* = 0 (held-out LoCoMo sweep null result — R@5 max at w=0, no positive weight passes per-category no-regression gate); set 0 to use pure cosine
...
insightSurfacingEnabled: false,     // D-05: ship DARK — no recall behavior change until 38-04 eval proves compose-token win (mirrors rankStrengthWeight:0)
```
New RECALL-0x defaults must follow this inline-comment convention (short phase/decision tag +
one-line rationale), placed near their thematically-related existing neighbors (entity knobs
near `entityResolutionFloor`, rank knobs near `rankStrengthWeight`/`bm25FusionWeight`).

---

### `scripts/eval/recall-audit-gate.cjs` (NEW — gate runner, batch) — RECALL-05 (D-08/D-09)

**Analog:** `scripts/eval/drift-05-dry-run.cjs` (dry-run/real-run mode split, scratch-DB
discipline) + `scripts/eval/gate-accuracy-runner.cjs` (mode-guard + baseline-floor-breach gate
shape) + `scripts/eval/recall-audit-evalset.py` (the eval-set INPUT this gate consumes)

**Mode-guard pattern to copy** (`gate-accuracy-runner.cjs` lines 37-54):
```javascript
const IS_PROBE = process.argv.includes('--probe');
const IS_RUN   = process.argv.includes('--run');

if (!IS_PROBE && !IS_RUN) {
  console.error('Usage: gate-accuracy-runner.cjs [--probe | --run] [options]');
  ...
  process.exit(1);
}
```
The RECALL-05 gate should reject silent no-op invocation the same way — e.g. require an
explicit `--set <path>` pointing at the (gitignored, never-committed) `memory-shaped-evalset.jsonl`,
and fail loudly (not silently pass) if that file is absent, mirroring `gate-accuracy-runner.cjs`'s
fail-closed baseline read (below).

**Fail-closed-on-missing-input pattern** (`gate-accuracy-runner.cjs` lines 76-84):
```javascript
function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`GATE FAIL: baseline not found at ${BASELINE_PATH} — cannot enforce accuracy floors`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    console.error(`GATE FAIL: could not parse baseline at ${BASELINE_PATH}: ${e.message} — cannot enforce accuracy floors`);
    process.exit(1);
  }
}
```
Apply the identical fail-closed shape to the missing/unparseable eval-set JSONL — never treat
"file absent" as "gate trivially passes."

**File-header convention (Run: block + key-requirements + gotchas)** — copy the doc-comment
STRUCTURE from `drift-05-dry-run.cjs:1-60` (Run invocation lines, dry-run vs real-run semantics,
gotchas section) but the RECALL-05 gate is simpler: no paid LLM axis is strictly required (D-08's
"grading is by injected-line relevance" can be manual/scripted heuristic OR an LLM judge — planner
discretion) — if an LLM judge IS used for relevance grading, gate it behind the SAME `--probe`/
`--run` paid-tier split `gate-accuracy-runner.cjs` uses, never make it the default `npm run gate`
path (per that file's own warning: "THIS IS NOT WHAT `npm run gate` RUNS").

**Hard gates to encode (verbatim from CONTEXT.md D-08 and the seed):**
```
- "contract with vtx" class surfaces contract facts
- foreign deep-dives no longer outrank own-project facts at equal-or-better relevance
- zero regression on the 42 currently-hit prompts
- token budget held (ambient block ≤ current ~5 lines × 200 chars unless explicitly re-budgeted)
```

**Privacy discipline (verbatim precedent)** — `recall-audit-evalset.py:14`:
```python
PRIVACY: output contains verbatim prompts — keep under scripts/eval/results/.
```
The gate script reads `scripts/eval/results/recall-audit/memory-shaped-evalset.jsonl` (gitignored)
and must never echo full verbatim prompts into a COMMITTED results file — any summary JSON this
gate writes for the SUMMARY.md should aggregate (counts/pass-fail per hard gate), not reproduce
raw prompt text, consistent with D-08's "results recorded honestly... these are founder-personal
numbers, interview-defensible" framing (aggregate numbers are fine to commit; verbatim prompts
are not).

---

### Tests — `tests/entity-anchor.test.ts` (NEW) + `tests/ambient-recall.test.ts` (MOD)

**Analog:** `tests/recall-scope.test.ts` (deterministic-cosine-order harness) +
`tests/ambient-recall.test.ts` (existing ambientRecall coverage, extend in place)

**Full harness pattern to copy (temp-DB + fixed-vec determinism)** (`recall-scope.test.ts` lines 1-51):
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { FakeClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { MockModelProvider } from '../src/model/provider';
import { ambientRecall } from '../src/adapter/ambient-recall';

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `recall-scope-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// Query vector and three node embeddings with strictly decreasing cosine to it, all above
// the AMBIENT_FLOOR (0.45) → deterministic order A (1.0) > B (0.8) > C (0.6).
const QUERY_VEC = new Float32Array([1, 0, 0]);
const VEC_A = new Float32Array([1, 0, 0]);     // cosine 1.0
const VEC_B = new Float32Array([0.8, 0.6, 0]); // cosine 0.8
const VEC_C = new Float32Array([0.6, 0.8, 0]); // cosine 0.6
```
For entity-anchoring tests specifically, seed an entity node with `type: 'entity'` and a NAME
that appears verbatim in the test prompt (e.g. "rileys"), plus a connected fact node via
`store.upsertEdge`, and assert the fact surfaces even when its embedding is ORTHOGONAL to the
mock embed output (proving the anchor path fires independent of cosine — this is the F2 "contract
with vtx" regression test).

**`ambient-recall.test.ts`'s existing setup helpers to reuse verbatim** (lines 40-70):
```typescript
function makeTempDbPath(): string { ... }
const FIXED_VEC = new Float32Array([0, 1, 0]);
const ORTHO_VEC = new Float32Array([1, 0, 0]);
function seedNode(db: Database.Database, value: string = SEEDED_VALUE): void { ... }
function setFlag(db: Database.Database, value: '0' | '1'): void { ... }
function countTraceRows(db: Database.Database): number { ... }
```
New test cases (doc-type rendering, hop injection, nudge) belong as additional `it(...)` blocks
inside the SAME `describe('ambientRecall', ...)` block (line 113) per the existing lettered-case
convention (`a.`, `b.`, `c.`, ... continue the sequence).

**Latency-measurement precedent** — `scripts/eval/live-latency.cjs` (percentile helper +
warm-up-then-measure loop) and `scripts/eval/41-latency-after.cjs` (before/after comparison
shape) are the precedent for D-03's "measure the added latency" requirement — a small
`scripts/eval/69-entity-anchor-latency.cjs` probe (not a vitest unit test) following
`live-latency.cjs`'s percentile-over-repeats shape is the right form for reporting p50/p95
added-latency numbers honestly in the phase SUMMARY, rather than asserting a latency threshold
inside a unit test (flaky on CI/dev-machine variance).

---

## Shared Patterns

### Dark-knob / eval-gate discipline (applies to ALL new behavior in this phase)
**Source:** `src/lib/config.ts:961-1005` (DEFAULT_CONFIG dark-default convention) +
`.planning/phases/69-.../69-CONTEXT.md` D-09
**Apply to:** `ambient-recall.ts`, `engine.ts`, `entity-resolution.ts`, `recall/index.ts`, `config.ts`
```typescript
bm25FusionWeight: 0,  // Phase 47 D-05: w* = 0 (held-out LoCoMo sweep null result...); set 0 to use pure cosine
```
Every RECALL-01/02/03 behavior ships behind a config knob whose DEFAULT reproduces exact
pre-phase output; the eval gate (RECALL-05) is what flips the default, not a code merge.

### Read-only / no-strengthening invariant (D-43 lineage)
**Source:** `src/recall/index.ts:18-24`, `src/consolidation/entity-resolution.ts:33-37` (D-12)
**Apply to:** `entity-anchor.ts` (NEW), evidence mode in `recall/index.ts`, any new
`ambient-recall.ts` reads
```typescript
* D-12  Read-only contract: this module never calls `upsertNode`, `upsertEdge`, `strengthen`,
*        or `tombstone`, and never opens a transaction.
```

### Honest-trace / no-fabricated-edges invariant (55-01/56 lineage)
**Source:** `src/retrieval/honest-trace.ts:1-27` (buildHonestOneHopTrace header)
**Apply to:** RECALL-03 hop rendering in `ambient-recall.ts` — only real edges, never invented,
scores always `null` for hops (rank-only, WR-02).

### Scope-is-provenance-not-a-filter invariant (D-S1), PARTIALLY REVERSED here (D-01)
**Source:** `src/db/semantic-store.ts:636-638, 660-664` (node_scope write/read comments)
**Apply to:** `ambient-recall.ts` only. The reversal is BOUNDED: nudge, never filter; every
other caller of `getNodeScope`/`getNodeScopes` (`RecallEngine.recall --scope`, any future
caller) keeps the original filter-never semantics. Update the `getNodeScopes` doc-comment
in-place to record the carve-out (see semantic-store.ts section above) rather than letting it
silently go stale.

### `recense://` citation id format (corpus-layer precedent, reused for doc-type rendering)
**Source:** `src/reader/doc-generator.ts:56-70`, `src/reader/insight-generator.ts:104`
**Apply to:** RECALL-02 doc-type rendering in `ambient-recall.ts`
```typescript
return full ? `recense://fact/${full}` : _whole; // leave invented refs untouched
```
Format is `recense://<fact|doc>/<raw node id, never transformed/prettified>` — mirror this
exactly for the new injected-block doc link rather than inventing a new URI shape.

### Fire-and-forget trace-emission guard (D-08/T-10-05 lineage)
**Source:** `src/retrieval/engine.ts:556-563`
**Apply to:** any new emit call added inside `retrieveRanked` for entity-anchored seeds
```typescript
try {
  const { seeds, hops } = this.buildAmbientTracePayload(emitSeeds);
  this.traceSink.emit({ query_id: newId(), seeds, hops });
} catch {
  // Fire-and-forget: a sink failure must never surface to the caller (T-10-05).
}
```

### CLI boolean/value flag resolution (recall-cli.ts convention)
**Source:** `src/adapter/recall-cli.ts:56-88`
**Apply to:** `--evidence` flag addition
Value flags (`--scope <slug>`) get an `indexOf` + next-token read + trim/lowercase/empty-guard;
bare boolean flags (`--evidence`) get a simple `argv.includes('--evidence')` (mirrors
`gate-accuracy-runner.cjs`'s `IS_PROBE`/`IS_RUN`). Both must be added to `resolveQuery`'s
flag-skip list if they could otherwise be mistaken for the positional query argument.

## No Analog Found

None — every file in scope has at least a role-match analog in the existing codebase. This
phase is explicitly scoped (per CONTEXT.md and the roadmap) to REUSE existing seams
(`entity-resolution.ts`'s generator, `buildHonestOneHopTrace`, the `recense://` citation
vocabulary, the `--scope` CLI-flag precedent, the dark-knob convention) rather than introduce a
new architectural shape.

## Metadata

**Analog search scope:** `src/adapter/`, `src/retrieval/`, `src/consolidation/`, `src/db/`,
`src/recall/`, `src/lib/config.ts`, `src/lib/scope.ts`, `src/lib/types.ts`, `src/reader/`,
`scripts/eval/`, `tests/`
**Files scanned:** ~25 read/grepped directly (ambient-recall.ts, engine.ts, honest-trace.ts,
topk.ts, entity-resolution.ts, semantic-store.ts, recall/index.ts, recall-cli.ts,
session-start-cli.ts, turn-capture-cli.ts, config.ts, scope.ts, types.ts, doc-generator.ts,
insight-generator.ts, recall-audit-evalset.py, drift-05-dry-run.cjs, gate-accuracy-runner.cjs,
live-latency.cjs, ambient-recall.test.ts, recall-scope.test.ts)
**Pattern extraction date:** 2026-08-03
