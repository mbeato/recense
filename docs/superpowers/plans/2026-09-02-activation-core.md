# Activation Core (Graph-Aware Recall, Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the query-time multi-hop spreading-activation core (truncated personalized PageRank with path provenance), prove it against the Phase 1 bridge eval (target: approach the `ppr-exact` oracle ceiling of r@10 0.617; beat the e2e baseline of 0.150), and wire it into `retrieveRanked` behind a dark config flag with byte-identical off behavior.

**Architecture:** A pure `spreadActivation` function in `src/retrieval/activation.ts` propagates normalized seed mass over eligible edges (row-normalized transfer, per-hop damping, ε floor, frontier cap, cycle-guarded top-m path provenance), reading edges through a batched `SqliteSpreadReader` (one prepared statement per hop, no N+1). Two new arms (`spread-2hop`, `spread-3hop`) plug into the Phase 1 harness for tuning; an exact-PPR overlap test guards correctness. `RetrievalEngine.retrieveRanked` gains an opt-in associative channel (RRF-fused, slot-capped) that is skipped entirely when `spreadHops = 0` (the default — ships dark).

**Tech Stack:** TypeScript, better-sqlite3, vitest. Verify with `npm run typecheck`, `npx vitest run <file>`, and `npm run eval:bridge`.

**Spec:** `docs/superpowers/specs/2026-08-26-graph-aware-recall-design.md` §3.1–3.3 (core, seeding, fusion), §5 (oracle test). Phase 1 artifacts to read before starting: `src/eval/ppr-reference.ts` (the oracle; its `REFERENCE_REL_WEIGHTS` table is the source of the config defaults), `src/eval/bridge-arms.ts` (the arm seam), `scripts/eval/bridge-harness.cjs`, `scripts/eval/results/bridge-af2a5f5.json` (the baseline to beat).

## Global Constraints

- Do NOT modify `retrieve()` or `retrieveCueless()` in `src/retrieval/engine.ts` (D-29). `retrieveRanked` may be extended only additively via `opts`; with the new option absent or `spreadHops = 0`, output must be **byte-identical** to today (a test enforces this).
- The spread path performs zero writes and zero LLM/embedding calls. All DB access read-only.
- Harness/eval runs use `scripts/eval/fixtures/bridge-snapshot.db`, never `~/.config/recense/recense.db`.
- Tombstoned is `number` (0|1). Deterministic id-asc tiebreaks everywhere. Match repo style; tsconfig has `noUncheckedIndexedAccess` — use the `x[i]!` idiom as neighboring code does.
- Do not create branches or commits — the reviewer commits per task after reviewing the diff. Work on the already-created branch `activation-core` (verify with `git branch --show-current`).
- Commit messages are made by the reviewer; ignore any commit steps.
- Stop and report if: the oracle-overlap test cannot reach its threshold after checking the transfer math against `pprExact`; `spread-3hop` oracle r@10 < 0.45 after the tuning sweep; `path_valid_rate` for spread arms is ever < 1.0 (spread paths are real edges by construction — anything less is a bug); the byte-identity test fails; or any change outside the listed files becomes necessary.

---

### Task 1: Config knobs

**Files:**
- Modify: `src/lib/config.ts` (interface `EngineConfig` + `DEFAULT_CONFIG`)
- Test: `tests/activation-config.test.ts`

**Interfaces:**
- Produces (all new `EngineConfig` fields, defaults in parentheses):
  ```ts
  spreadHops: number;              // 0 = feature dark (0)
  spreadDamping: number;           // per-hop continue probability (0.5)
  spreadActivationFloor: number;   // ε: drop transfers below this absolute mass (0.02)
  spreadFrontierCap: number;       // max frontier nodes per hop, pruned after aggregation (64)
  spreadFanExponent: number;       // row-normalization exponent, 1.0 = mass-conserving (1.0)
  spreadPathsPerNode: number;      // top-m contribution paths kept per activated node (3)
  spreadAssocSlotCap: number;      // max associative rows admitted into a retrieveRanked result (2)
  spreadDocSeedWeight: number;     // seed-mass multiplier for doc-type nodes (0.05)
  spreadRelWeights: Record<string, { fwd: number; rev: number }>;  // copy REFERENCE_REL_WEIGHTS from src/eval/ppr-reference.ts verbatim
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/activation-config.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';

describe('spread config defaults', () => {
  it('ships dark with the spec §3.1/§4 defaults', () => {
    expect(DEFAULT_CONFIG.spreadHops).toBe(0);
    expect(DEFAULT_CONFIG.spreadDamping).toBe(0.5);
    expect(DEFAULT_CONFIG.spreadActivationFloor).toBe(0.02);
    expect(DEFAULT_CONFIG.spreadFrontierCap).toBe(64);
    expect(DEFAULT_CONFIG.spreadFanExponent).toBe(1.0);
    expect(DEFAULT_CONFIG.spreadPathsPerNode).toBe(3);
    expect(DEFAULT_CONFIG.spreadAssocSlotCap).toBe(2);
    expect(DEFAULT_CONFIG.spreadDocSeedWeight).toBe(0.05);
    expect(DEFAULT_CONFIG.spreadRelWeights['relation:*']).toEqual({ fwd: 1.0, rev: 0.8 });
    expect(DEFAULT_CONFIG.spreadRelWeights['doc_containment:*']).toEqual({ fwd: 0, rev: 0 });
  });
});
```

- [ ] **Step 2: Run it, verify it fails** (`npx vitest run tests/activation-config.test.ts`)

- [ ] **Step 3: Implement** — declare the nine fields in `EngineConfig` with doc comments in the style of the neighboring declarations (each citing "graph-aware recall spec §3.1/§3.2/§3.3"), and add the defaults to `DEFAULT_CONFIG`. `spreadRelWeights` value = the `REFERENCE_REL_WEIGHTS` literal from `src/eval/ppr-reference.ts`, copied verbatim (the eval file stays the frozen reference; config is what production reads).

- [ ] **Step 4: Run the test and `npm run typecheck`, verify both pass.** (Adding required fields to `EngineConfig` can break other DEFAULT_CONFIG-spreading code only if something constructs an EngineConfig literal without spreading DEFAULT_CONFIG — if typecheck surfaces such a site, report it rather than editing unlisted files.)

---

### Task 2: The spread core

**Files:**
- Create: `src/retrieval/activation.ts`
- Test: `tests/activation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpreadParams { hops: number; damping: number; activationFloor: number; frontierCap: number; fanExponent: number; pathsPerNode: number; relWeights: Record<string, { fwd: number; rev: number }> }
  export function spreadParamsFromConfig(c: EngineConfig, hopsOverride?: number): SpreadParams
  export interface SpreadEdgeRow { src: string; dst: string; rel: string; kind: string; w: number }
  export interface SpreadReader { edgesTouching(ids: string[]): SpreadEdgeRow[]; liveIds(ids: string[]): Set<string> }
  export interface PathStep { src: string; rel: string; dst: string }
  export interface ActivatedNode { activation: number; hopDepth: number; paths: PathStep[][] }  // paths[0] is the strongest
  export function relWeight(params: SpreadParams, kind: string, rel: string, dir: 'fwd' | 'rev'): number
  export function normalizeSeeds(raw: Map<string, number>): Map<string, number>
  export function prepareSeeds(rows: Array<{ id: string; score: number; type?: string }>, supportCounts: Map<string, number>, docWeight: number): Map<string, number>
  export function spreadActivation(reader: SpreadReader, seedsIn: Map<string, number>, params: SpreadParams): Map<string, ActivatedNode>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/activation.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';
import {
  spreadParamsFromConfig, normalizeSeeds, prepareSeeds, spreadActivation,
  type SpreadReader, type SpreadEdgeRow, type SpreadParams,
} from '../src/retrieval/activation';

/** In-memory reader over a fixed edge list; everything live unless listed dead. */
function makeReader(edges: SpreadEdgeRow[], dead: string[] = []): SpreadReader {
  const deadSet = new Set(dead);
  return {
    edgesTouching(ids) {
      const s = new Set(ids);
      return edges.filter(e => s.has(e.src) || s.has(e.dst));
    },
    liveIds(ids) { return new Set(ids.filter(id => !deadSet.has(id))); },
  };
}
const rel = (src: string, dst: string, rl = 'depends_on', kind = 'relation', w = 0.1): SpreadEdgeRow => ({ src, dst, rel: rl, kind, w });

const P: SpreadParams = spreadParamsFromConfig({ ...DEFAULT_CONFIG, dbPath: ':memory:' } as never, 3);

describe('normalizeSeeds / prepareSeeds', () => {
  it('normalizes total seed mass to 1', () => {
    const s = normalizeSeeds(new Map([['a', 2], ['b', 2]]));
    expect(s.get('a')).toBeCloseTo(0.5);
  });
  it('weights by score, penalizes support fan, down-weights docs, then normalizes', () => {
    const s = prepareSeeds(
      [{ id: 'a', score: 0.8 }, { id: 'b', score: 0.8 }, { id: 'd', score: 0.8, type: 'doc' }],
      new Map([['b', 4]]),   // b is supported by 4 episodes → specificity 1/4; a and d are orphans → 1
      0.05,
    );
    expect(s.get('a')! / s.get('b')!).toBeCloseTo(4);
    expect(s.get('a')! / s.get('d')!).toBeCloseTo(1 / 0.05);
    let sum = 0; for (const v of s.values()) sum += v;
    expect(sum).toBeCloseTo(1);
  });
});

describe('spreadActivation', () => {
  it('returns empty when hops=0 or no seeds', () => {
    expect(spreadActivation(makeReader([rel('a', 'b')]), new Map(), P).size).toBe(0);
    expect(spreadActivation(makeReader([rel('a', 'b')]), new Map([['a', 1]]), { ...P, hops: 0 }).size).toBe(0);
  });

  it('reaches a 2-hop terminal with a correct provenance path and decaying activation', () => {
    const r = makeReader([rel('A', 'B'), rel('B', 'C')]);
    const out = spreadActivation(r, new Map([['A', 1]]), P);
    const b = out.get('B')!; const c = out.get('C')!;
    expect(b.activation).toBeCloseTo(0.5);        // 1 × damping, single eligible edge = full share
    expect(c.activation).toBeCloseTo(0.25);       // second hop halves again
    expect(c.hopDepth).toBe(2);
    expect(c.paths[0]).toEqual([{ src: 'A', rel: 'depends_on', dst: 'B' }, { src: 'B', rel: 'depends_on', dst: 'C' }]);
    expect(out.has('A')).toBe(false);             // seeds are never in the output
  });

  it('accumulates convergent evidence from two seeds and keeps both paths', () => {
    const r = makeReader([rel('S1', 'X'), rel('S2', 'X')]);
    const one = spreadActivation(r, new Map([['S1', 1]]), P).get('X')!;
    const two = spreadActivation(r, new Map([['S1', 1], ['S2', 1]]), P).get('X')!;
    expect(two.activation).toBeCloseTo(one.activation); // seed mass is normalized: 2×(0.5×0.5) = 0.5
    expect(two.paths.length).toBe(2);
    const r3 = makeReader([rel('S1', 'X'), rel('S1', 'Y')]);
    const split = spreadActivation(r3, new Map([['S1', 1]]), P).get('X')!;
    expect(two.activation).toBeGreaterThan(split.activation); // convergence beats fan-out
  });

  it('row-normalizes: a hub splits its mass across its fan', () => {
    const edges = [rel('S', 'H'), rel('S', 'Q'), rel('Q', 'Qn')];
    for (let i = 0; i < 20; i++) edges.push(rel('H', `Hn${i}`));
    const out = spreadActivation(makeReader(edges), new Map([['S', 1]]), P);
    expect(out.get('Qn')!.activation).toBeGreaterThan(out.get('Hn0')!.activation * 10);
  });

  it('traverses reverse edges at the rev weight and skips zero-weight kinds', () => {
    const r = makeReader([
      { src: 'B', dst: 'A', rel: 'uses', kind: 'relation', w: 0.1 },          // A reachable via rev (0.8)
      { src: 'A', dst: 'D', rel: 'doc_containment', kind: 'doc_containment', w: 0.1 },
    ]);
    const out = spreadActivation(r, new Map([['A', 1]]), { ...P, hops: 1 });
    expect(out.get('B')!.activation).toBeCloseTo(0.5);  // sole eligible edge → full damped share
    expect(out.has('D')).toBe(false);
  });

  it('never walks back along its own path (cycle guard) and never re-activates a seed', () => {
    const r = makeReader([rel('A', 'B'), rel('B', 'A'), rel('B', 'C'), rel('C', 'B')]);
    const out = spreadActivation(r, new Map([['A', 1]]), P);
    expect(out.has('A')).toBe(false);
    // B's mass at hop 2 must not have bounced A→B→A→B; C exists via A→B→C only
    expect(out.get('C')!.paths[0]).toEqual([{ src: 'A', rel: 'depends_on', dst: 'B' }, { src: 'B', rel: 'depends_on', dst: 'C' }]);
  });

  it('drops sub-floor transfers and prunes the frontier after aggregation', () => {
    const edges: SpreadEdgeRow[] = [];
    for (let i = 0; i < 100; i++) edges.push(rel('S', `n${i}`));   // each share = 0.5/100 = 0.005 < floor
    const out = spreadActivation(makeReader(edges), new Map([['S', 1]]), P);
    expect(out.size).toBe(0);
    const capped = spreadActivation(makeReader(edges), new Map([['S', 1]]), { ...P, activationFloor: 0.001, frontierCap: 10 });
    expect(capped.size).toBe(100);                                  // all get booked (floor passes)…
    // …but only 10 propagate further; with no second-hop edges this just checks the cap didn't crash
  });

  it('skips tombstoned targets and is deterministic', () => {
    const r = makeReader([rel('A', 'B'), rel('A', 'Z')], ['Z']);
    const out = spreadActivation(r, new Map([['A', 1]]), P);
    expect(out.has('Z')).toBe(false);
    const a = JSON.stringify([...spreadActivation(r, new Map([['A', 1]]), P).entries()]);
    const b = JSON.stringify([...spreadActivation(r, new Map([['A', 1]]), P).entries()]);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail** (`npx vitest run tests/activation.test.ts`)

- [ ] **Step 3: Implement `src/retrieval/activation.ts`** — this code is the reviewed algorithm; keep it structurally as written:

```ts
/**
 * Query-time multi-hop spreading activation with path provenance — the graph-aware recall
 * core (spec §3.1). A truncated personalized-PageRank push: seed mass is normalized to 1,
 * each hop transfers a(u) × damping × w_e / outMass(u) along eligible edges (row-normalized,
 * mass-conserving at fanExponent=1), transfers below the ε floor are dropped, the frontier
 * is pruned to frontierCap AFTER per-hop aggregation, and every activated node keeps its
 * top-m contributing paths (real edges only). Read-only, LLM-free, deterministic (id-asc).
 * Oracle: src/eval/ppr-reference.ts (tests assert top-k overlap).
 */
import type { EngineConfig } from '../lib/config';

export interface SpreadParams {
  hops: number;
  damping: number;
  activationFloor: number;
  frontierCap: number;
  fanExponent: number;
  pathsPerNode: number;
  relWeights: Record<string, { fwd: number; rev: number }>;
}

export function spreadParamsFromConfig(c: EngineConfig, hopsOverride?: number): SpreadParams {
  return {
    hops: hopsOverride ?? c.spreadHops,
    damping: c.spreadDamping,
    activationFloor: c.spreadActivationFloor,
    frontierCap: c.spreadFrontierCap,
    fanExponent: c.spreadFanExponent,
    pathsPerNode: c.spreadPathsPerNode,
    relWeights: c.spreadRelWeights,
  };
}

export interface SpreadEdgeRow { src: string; dst: string; rel: string; kind: string; w: number }

export interface SpreadReader {
  /** All edge rows whose src OR dst is in ids — one batched call per hop, never per node. */
  edgesTouching(ids: string[]): SpreadEdgeRow[];
  /** Subset of ids that exist and are not tombstoned. */
  liveIds(ids: string[]): Set<string>;
}

export interface PathStep { src: string; rel: string; dst: string }
export interface ActivatedNode { activation: number; hopDepth: number; paths: PathStep[][] }

export function relWeight(params: SpreadParams, kind: string, rel: string, dir: 'fwd' | 'rev'): number {
  const entry = params.relWeights[`${kind}:${rel}`] ?? params.relWeights[`${kind}:*`];
  return entry ? entry[dir] : 0;
}

export function normalizeSeeds(raw: Map<string, number>): Map<string, number> {
  let sum = 0;
  for (const v of raw.values()) if (v > 0) sum += v;
  const out = new Map<string, number>();
  if (sum <= 0) return out;
  for (const [id, v] of raw) if (v > 0) out.set(id, v / sum);
  return out;
}

/** Spec §3.2: mass ∝ score × 1/max(1, supportCount) × docWeight-if-doc, normalized to Σ=1. */
export function prepareSeeds(
  rows: Array<{ id: string; score: number; type?: string }>,
  supportCounts: Map<string, number>,
  docWeight: number,
): Map<string, number> {
  const raw = new Map<string, number>();
  for (const r of rows) {
    const specificity = 1 / Math.max(1, supportCounts.get(r.id) ?? 0);
    const doc = r.type === 'doc' ? docWeight : 1;
    raw.set(r.id, Math.max(r.score, 0.01) * specificity * doc);
  }
  return normalizeSeeds(raw);
}

interface FrontierEntry { mass: number; path: PathStep[]; pathNodes: Set<string> }

interface Book {
  activation: number;
  hopDepth: number;
  candidates: Array<{ path: PathStep[]; contrib: number }>;
}

export function spreadActivation(
  reader: SpreadReader,
  seedsIn: Map<string, number>,
  params: SpreadParams,
): Map<string, ActivatedNode> {
  const out = new Map<string, ActivatedNode>();
  if (params.hops <= 0) return out;
  const seeds = normalizeSeeds(seedsIn);
  if (seeds.size === 0) return out;

  const books = new Map<string, Book>();
  let frontier = new Map<string, FrontierEntry>();
  for (const [id, mass] of seeds) frontier.set(id, { mass, path: [], pathNodes: new Set([id]) });

  for (let h = 1; h <= params.hops && frontier.size > 0; h++) {
    const frontierIds = Array.from(frontier.keys()).sort();
    const edges = reader.edgesTouching(frontierIds);

    // Directed eligible out-lists for this frontier (fwd along src→dst, rev along dst→src).
    const outLists = new Map<string, Array<{ to: string; w: number; step: PathStep }>>();
    const pushOut = (from: string, to: string, w: number, rel: string) => {
      if (w <= 0) return;
      let l = outLists.get(from);
      if (!l) { l = []; outLists.set(from, l); }
      l.push({ to, w, step: { src: from, rel, dst: to } });
    };
    for (const e of edges) {
      if (frontier.has(e.src)) pushOut(e.src, e.dst, relWeight(params, e.kind, e.rel, 'fwd') * e.w, e.rel);
      if (frontier.has(e.dst)) pushOut(e.dst, e.src, relWeight(params, e.kind, e.rel, 'rev') * e.w, e.rel);
    }

    // One batched liveness check for every transfer target this hop.
    const targetIds = new Set<string>();
    for (const l of outLists.values()) for (const t of l) targetIds.add(t.to);
    const live = reader.liveIds(Array.from(targetIds).sort());

    // Aggregate gains for the whole hop, then prune to frontierCap.
    const gained = new Map<string, FrontierEntry>();
    for (const u of frontierIds) {
      const entry = frontier.get(u)!;
      const list = outLists.get(u);
      if (!list) continue;
      list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
      let outMass = 0;
      for (const t of list) outMass += t.w;
      const denom = Math.pow(outMass, params.fanExponent);
      if (denom <= 0) continue;
      for (const t of list) {
        if (!live.has(t.to)) continue;
        if (seeds.has(t.to)) continue;              // never re-activate a seed
        if (entry.pathNodes.has(t.to)) continue;    // cycle guard: no revisits along the contributing path
        const contrib = entry.mass * params.damping * (t.w / denom);
        if (contrib < params.activationFloor) continue;

        let b = books.get(t.to);
        if (!b) { b = { activation: 0, hopDepth: h, candidates: [] }; books.set(t.to, b); }
        b.activation += contrib;
        b.candidates.push({ path: [...entry.path, t.step], contrib });

        const g = gained.get(t.to);
        if (!g || contrib > g.mass) {
          gained.set(t.to, {
            mass: (g?.mass ?? 0) + contrib - (g ? g.mass : 0) + (g ? g.mass : 0), // placeholder, fixed below
            path: [...entry.path, t.step],
            pathNodes: new Set([...entry.pathNodes, t.to]),
          });
        }
      }
    }
    // Recompute gained mass as the SUM of this hop's contributions per node (additive push),
    // while keeping the strongest single path for cycle-guarding the next hop.
    const hopSums = new Map<string, number>();
    for (const [id, b] of books) {
      if (b.hopDepth !== h) continue;
      let s = 0;
      for (const c of b.candidates) s += c.contrib;
      hopSums.set(id, s);
    }
    for (const [id, g] of gained) g.mass = hopSums.get(id) ?? g.mass;

    // Next frontier: top frontierCap gained nodes by mass (id-asc tiebreak).
    const ranked = Array.from(gained.entries())
      .sort((a, b) => (b[1].mass - a[1].mass) || (a[0] < b[0] ? -1 : 1))
      .slice(0, params.frontierCap);
    frontier = new Map(ranked);
  }

  for (const [id, b] of books) {
    b.candidates.sort((a, c) => (c.contrib - a.contrib) || (JSON.stringify(a.path) < JSON.stringify(c.path) ? -1 : 1));
    out.set(id, {
      activation: b.activation,
      hopDepth: b.hopDepth,
      paths: b.candidates.slice(0, params.pathsPerNode).map(c => c.path),
    });
  }
  return out;
}
```

Note on the `gained` placeholder line: implement it cleanly — track `bestContrib` alongside and only replace `path`/`pathNodes` when this contribution exceeds the previous best; the final mass always comes from `hopSums`. If the expression above is awkward, restructure (e.g. store `{ bestContrib, path, pathNodes }` and assign mass after the loop) — behavior, not shape, is the contract; the tests pin the behavior.

- [ ] **Step 4: Run tests, verify all pass.** The hop-2 accumulation test (`activation ≈ 0.25`) and the convergence test are the two most likely to expose double-counting bugs — if they fail, check that a node's second-hop propagation uses only mass gained in that hop, not its cumulative activation.

---

### Task 3: Batched SQLite reader

**Files:**
- Create: `src/retrieval/spread-reader.ts`
- Test: `tests/spread-reader.test.ts`

**Interfaces:**
- Consumes: `SpreadReader`, `SpreadEdgeRow` (Task 2).
- Produces: `export class SqliteSpreadReader implements SpreadReader { constructor(db: Database.Database) }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/spread-reader.test.ts
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
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement**

```ts
// src/retrieval/spread-reader.ts
/** Batched edge/liveness reader for spreadActivation — one prepared statement per hop (spec §3.1 "app-side batched frontier"). */
import type Database from 'better-sqlite3';
import type { SpreadEdgeRow, SpreadReader } from './activation';

export class SqliteSpreadReader implements SpreadReader {
  private readonly stmtEdges;
  private readonly stmtLive;

  constructor(db: Database.Database) {
    this.stmtEdges = db.prepare(`
      SELECT src, dst, rel, kind, w FROM edge
      WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?))
    `);
    this.stmtLive = db.prepare(`
      SELECT id FROM node WHERE tombstoned = 0 AND id IN (SELECT value FROM json_each(?))
    `);
  }

  edgesTouching(ids: string[]): SpreadEdgeRow[] {
    if (ids.length === 0) return [];
    const j = JSON.stringify(ids);
    return this.stmtEdges.all(j, j) as SpreadEdgeRow[];
  }

  liveIds(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    return new Set((this.stmtLive.all(JSON.stringify(ids)) as Array<{ id: string }>).map(r => r.id));
  }
}
```

- [ ] **Step 4: Run the test, verify it passes.**

---

### Task 4: Exact-PPR oracle overlap test

**Files:**
- Test: `tests/activation-oracle.test.ts` (test-only task; no production code)

- [ ] **Step 1: Write the test** (it should pass immediately if Task 2 is correct — if it fails, that is the point: stop and reconcile the transfer math before proceeding)

```ts
// tests/activation-oracle.test.ts
/**
 * Spec §5 "Exact-PPR oracle test": with generous budgets, truncated spread's top-k must
 * closely match exact PPR on the same graph and weights. Divergence flags over-truncation
 * or a weighting bug in either implementation.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { loadAdjacency, pprExact, rankFromScores } from '../src/eval/ppr-reference';
import { spreadActivation, spreadParamsFromConfig } from '../src/retrieval/activation';
import { SqliteSpreadReader } from '../src/retrieval/spread-reader';

/** Deterministic LCG so the random graph is stable across runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function buildRandomGraph(nodes: number, edges: number, seed: number) {
  const db = new Database(':memory:');
  initSchema(db);
  const store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  const rnd = lcg(seed);
  const rels = ['depends_on', 'uses', 'extends', 'part_of'];
  for (let i = 0; i < nodes; i++) store.upsertNode({ id: `n${i}`, type: 'fact', value: `node ${i}`, origin: 'observed' });
  const seen = new Set<string>();
  let added = 0;
  while (added < edges) {
    const a = Math.floor(rnd() * nodes); const b = Math.floor(rnd() * nodes);
    if (a === b) continue;
    const rel = rels[Math.floor(rnd() * rels.length)]!;
    const key = `${a}|${b}|${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    store.upsertEdge({ src: `n${a}`, dst: `n${b}`, rel, w: 0.1, kind: 'relation' });
    added++;
  }
  return db;
}

function overlapAt(a: string[], b: string[], k: number): number {
  const sa = new Set(a.slice(0, k));
  let hit = 0;
  for (const id of b.slice(0, k)) if (sa.has(id)) hit++;
  return hit / k;
}

describe('spread vs exact PPR', () => {
  it('top-10 overlap ≥ 0.7 on random graphs with generous spread budgets', () => {
    const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
    for (const seed of [7, 42, 1337]) {
      const db = buildRandomGraph(200, 500, seed);
      const adj = loadAdjacency(db);
      const seedId = adj.ids[0]!;
      const exact = rankFromScores(adj, pprExact(adj, new Map([[seedId, 1]])), new Set([seedId]), 10);
      const spread = spreadActivation(
        new SqliteSpreadReader(db),
        new Map([[seedId, 1]]),
        { ...spreadParamsFromConfig(cfg as never, 6), activationFloor: 1e-7, frontierCap: 100_000 },
      );
      const ranked = Array.from(spread.entries())
        .sort((a, b) => (b[1].activation - a[1].activation) || (a[0] < b[0] ? -1 : 1))
        .map(e => e[0]);
      expect(exact.length).toBeGreaterThan(0);
      expect(overlapAt(exact, ranked, Math.min(10, exact.length))).toBeGreaterThanOrEqual(0.7);
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run it.** Expected: PASS. Known honest divergences if it sits just under threshold: the spread's cycle guard blocks revisits that PPR allows, and truncation at 6 hops misses long-tail mass. If overlap is far below 0.7 (< 0.5), that is a bug — check row normalization (`denom` over eligible weights only) and the rev-direction weights first, and stop and report if it cannot be reconciled.

---

### Task 5: Harness arms + tuning sweep

**Files:**
- Modify: `src/eval/bridge-arms.ts` (add two arms + spread context)
- Modify: `scripts/eval/bridge-harness.cjs` (spread flag overrides, support-count map)
- Test: `tests/bridge-arms.test.ts` (extend)

**Interfaces:**
- Consumes: `spreadActivation`, `spreadParamsFromConfig`, `prepareSeeds`, `SqliteSpreadReader` (Tasks 2–3); the existing `Arm`/`ArmContext`/`resolveSeeds` seam.
- Produces: `ArmContext` gains `spreadParams2: SpreadParams; spreadParams3: SpreadParams; supportCounts: Map<string, number>; docIds: Set<string>`; arms `spread-2hop`, `spread-3hop` whose `ArmResult.paths` carries each surfaced node's strongest path (so `path_valid_rate` goes live).

- [ ] **Step 1: Extend the arms test** — add to `tests/bridge-arms.test.ts` (the existing fixture: seed→bridge→term, orthogonal embeddings):

```ts
  it('spread-2hop reaches the terminal with a verifiable path; spread-3hop too', () => {
    const input = { probe, queryVec: basis(0), mode: 'oracle' as const };
    for (const name of ['spread-2hop', 'spread-3hop']) {
      const res = ARMS.find(a => a.name === name)!.run(input, ctx)!;
      expect(res.rankedIds, name).toContain('term');
      const path = res.paths!.get('term')!;
      expect(path).toEqual([
        { src: 'seed', rel: 'runs_on', dst: 'bridge' },
        { src: 'bridge', rel: 'extends', dst: 'term' },
      ]);
      expect(res.nodesExpanded).toBeGreaterThan(0);
    }
  });
```

`ctx` construction in the test gains the new fields:

```ts
    const cfgAny = cfg as typeof cfg & { spreadHops: number };
    ctx = {
      db, store, retriever, engine, adjacency: loadAdjacency(db), k: 10, floor: 0.3, e2eSeedK: 3,
      spreadParams2: spreadParamsFromConfig(cfgAny, 2),
      spreadParams3: spreadParamsFromConfig(cfgAny, 3),
      supportCounts: new Map(),
      docIds: new Set(),
    };
```

(with `import { spreadParamsFromConfig } from '../src/retrieval/activation';` added — after Task 1 the cast is unnecessary; drop it if types are clean.)

- [ ] **Step 2: Run, verify the new test fails** (arms don't exist).

- [ ] **Step 3: Implement the arms** in `src/eval/bridge-arms.ts`:

```ts
import { spreadActivation, prepareSeeds, type SpreadParams } from '../retrieval/activation';
import { SqliteSpreadReader } from '../retrieval/spread-reader';
```

`ArmContext` gains `spreadParams2: SpreadParams; spreadParams3: SpreadParams; supportCounts: Map<string, number>; docIds: Set<string>`. Then:

```ts
/** Seed the spread: oracle = gold seed mass 1; e2e = prepareSeeds over hybrid hits (spec §3.2). */
function spreadSeeds(input: ProbeInput, ctx: ArmContext): Map<string, number> {
  if (input.mode === 'oracle') return new Map([[input.probe.seed.id, 1]]);
  const hits = ctx.engine.retrieveRanked(input.queryVec, ctx.e2eSeedK, 0, input.probe.query);
  return prepareSeeds(
    hits.map(h => ({ id: h.id, score: h.score, type: ctx.docIds.has(h.id) ? 'doc' : undefined })),
    ctx.supportCounts,
    0.05,
  );
}

function makeSpreadArm(name: string, pick: (ctx: ArmContext) => SpreadParams): Arm {
  return {
    name,
    usesSeeds: true,
    run: (input, ctx) => timed(() => {
      const seeds = spreadSeeds(input, ctx);
      const reader = new SqliteSpreadReader(ctx.db);
      const activated = spreadActivation(reader, seeds, pick(ctx));
      const entries = Array.from(activated.entries())
        .filter(([id]) => id !== input.probe.seed.id)
        .sort((a, b) => (b[1].activation - a[1].activation) || (a[0] < b[0] ? -1 : 1))
        .slice(0, ctx.k);
      const paths = new Map(entries.map(([id, n]) => [id, n.paths[0]!]));
      return { rankedIds: entries.map(([id]) => id), nodesExpanded: activated.size, paths };
    }),
  };
}

export const ARMS: Arm[] = [cosineArm, hybridArm, typedArm, pprExactArm,
  makeSpreadArm('spread-2hop', ctx => ctx.spreadParams2),
  makeSpreadArm('spread-3hop', ctx => ctx.spreadParams3),
];
```

- [ ] **Step 4: Wire the harness** (`scripts/eval/bridge-harness.cjs`): build the new ctx fields —

```js
const { spreadParamsFromConfig } = require('../../dist/src/retrieval/activation');
// after `config` is loaded:
const spreadOverride = (p) => ({
  ...p,
  damping: parseFloat(arg('--spread-damping', String(p.damping))),
  activationFloor: parseFloat(arg('--spread-floor', String(p.activationFloor))),
  frontierCap: parseInt(arg('--spread-frontier-cap', String(p.frontierCap)), 10),
  fanExponent: parseFloat(arg('--spread-fan-exp', String(p.fanExponent))),
});
const supportCounts = new Map(db.prepare(`SELECT node_id, COUNT(*) AS c FROM consolidation_event WHERE node_id IS NOT NULL GROUP BY node_id`).all().map(r => [r.node_id, r.c]));
const docIds = new Set(db.prepare(`SELECT id FROM node WHERE type = 'doc' AND tombstoned = 0`).all().map(r => r.id));
```

and pass `spreadParams2: spreadOverride(spreadParamsFromConfig(config, 2))`, `spreadParams3: spreadOverride(spreadParamsFromConfig(config, 3))`, `supportCounts`, `docIds` into `ctx`. Record the effective spread params into `meta.sut_config.spread`.

- [ ] **Step 5: Run unit tests + typecheck** (`npx vitest run tests/bridge-arms.test.ts && npm run typecheck`), verify green.

- [ ] **Step 6: Baseline-vs-spread run.** `npm run eval:bridge` — record the table. Tripwires (stop and report if hit): `spread-3hop` oracle r@10 < 0.45; `path_valid_rate` < 1.0 for either spread arm.

- [ ] **Step 7: Tuning sweep** (oracle mode is the fast, seed-independent signal). Run each combination via
`node scripts/eval/bridge-harness.cjs --run --db scripts/eval/fixtures/bridge-snapshot.db --mode oracle --spread-damping <d> --spread-floor <f> --out scripts/eval/results/sweep-d<d>-f<f>.json`
for d ∈ {0.4, 0.5, 0.6} × f ∈ {0.005, 0.02, 0.05}. Report a table of `spread-3hop` r@10/MRR per combination. If a non-default combination beats the default by ≥ 0.05 r@10, note it in the final report — do NOT change `DEFAULT_CONFIG` yourself; the reviewer decides. Then one final `--mode both` run with the winning params, saved as `scripts/eval/results/bridge-spread-<commit>.json`. Delete the intermediate `sweep-*.json` files.

---

### Task 6: `retrieveRanked` opt-in associative channel

**Files:**
- Modify: `src/retrieval/engine.ts` (additive only: new opts field, new private members, one insertion block)
- Test: `tests/retrieval-spread.test.ts`

**Interfaces:**
- Consumes: `spreadActivation`, `spreadParamsFromConfig`, `prepareSeeds`, `SqliteSpreadReader`, `rrfFuse` (already exported from `src/retrieval/topk.ts`).
- Produces: `retrieveRanked` `opts` gains `spreadHops?: number`. When `> 0`, the returned rows may include up to `config.spreadAssocSlotCap` associative rows; each carries its real activation as `score`. Rows keep the shape `Array<{ id: string; value: string; score: number }>` — no type change for existing callers.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/retrieval-spread.test.ts
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine } from '../src/retrieval/engine';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';

const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
function basis(i: number): Float32Array { const v = new Float32Array(16); v[i] = 1; return v; }

describe('retrieveRanked spread channel', () => {
  let db: Database.Database;
  let store: SemanticStore;
  let engine: RetrievalEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, cfg);
    const add = (id: string, value: string, vec: Float32Array) => {
      store.upsertNode({ id, type: 'fact', value, origin: 'observed', s: 0.5 });
      store.setEmbedding(id, vec);
    };
    add('seed', 'urby-www deploys to Cloudflare Pages', basis(0));
    add('near', 'urby-www deploy pipeline uses wrangler', basis(0)); // cosine sibling
    add('term', 'the dashboard custom domain attachment is locked', basis(2));
    store.upsertEdge({ src: 'seed', dst: 'term', rel: 'runs_on', w: 0.1, kind: 'relation' });
    engine = new RetrievalEngine(db, clock, cfg, new CandidateRetriever(db), store, new StrengthDecayManager(db, clock, cfg), new AllocationGate(cfg));
  });
  afterEach(() => db.close());

  it('is byte-identical with spreadHops absent, 0, or feature-dark', () => {
    const base = engine.retrieveRanked(basis(0), 5, 0.3);
    expect(engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 0 })).toEqual(base);
    expect(engine.retrieveRanked(basis(0), 5, 0.3, undefined, {})).toEqual(base);
  });

  it('surfaces a connected-but-orthogonal fact through the associative channel, slot-capped', () => {
    const base = engine.retrieveRanked(basis(0), 5, 0.3);
    expect(base.map(r => r.id)).not.toContain('term');
    const spread = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2 });
    expect(spread.map(r => r.id)).toContain('term');
    const assoc = spread.filter(r => !base.some(b => b.id === r.id));
    expect(assoc.length).toBeLessThanOrEqual(cfg.spreadAssocSlotCap);
    const term = spread.find(r => r.id === 'term')!;
    expect(term.score).toBeGreaterThan(0);   // real activation, never fabricated
    expect(term.score).toBeLessThanOrEqual(1);
  });

  it('associative rows never bypass tombstone discipline', () => {
    store.tombstone('term');
    const spread = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2 });
    expect(spread.map(r => r.id)).not.toContain('term');
  });

  it('fails open: a broken spread never breaks retrieval', () => {
    // Simulate breakage by dropping the edge table's index target — instead, monkeypatch:
    const anyEngine = engine as unknown as { spreadReader: { edgesTouching: () => never } };
    anyEngine.spreadReader.edgesTouching = () => { throw new Error('boom'); };
    const rows = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2 });
    expect(rows.length).toBeGreaterThan(0);  // hybrid results still returned
  });
});
```

- [ ] **Step 2: Run, verify failure** (unknown option / no channel).

- [ ] **Step 3: Implement in `src/retrieval/engine.ts`** — additive changes only:

1. Imports: `spreadActivation, spreadParamsFromConfig, prepareSeeds` from `./activation`; `SqliteSpreadReader` from `./spread-reader`; `rrfFuse` from `./topk` (extend the existing import).
2. Private members initialized in the constructor: `private readonly spreadReader = new SqliteSpreadReader(this.db);` and a prepared statement
   `private readonly stmtSupportCounts` = `SELECT node_id, COUNT(*) AS c FROM consolidation_event WHERE node_id IN (SELECT value FROM json_each(?)) GROUP BY node_id`.
3. `opts` type gains `spreadHops?: number` (document: "graph-aware recall spec §3.3 — associative channel; 0/absent = byte-identical legacy behavior").
4. Locate the point where the final result array is fully assembled (after the anchored-union + ordering logic, immediately before the viz/trace section and the `return`). Insert, guarded and fail-open:

```ts
    // ── Graph-aware associative channel (spec §3.3) — additive, dark by default ──
    // spreadHops absent/0 ⇒ this block is skipped entirely (byte-identity, D-29 discipline).
    if (opts?.spreadHops && opts.spreadHops > 0 && finalRows.length > 0) {
      try {
        const seedIds = finalRows.map(r => r.id);
        const counts = new Map<string, number>(
          (this.stmtSupportCounts.all(JSON.stringify(seedIds)) as Array<{ node_id: string; c: number }>)
            .map(r => [r.node_id, r.c]),
        );
        const seeds = prepareSeeds(
          finalRows.map(r => {
            const n = this.store.getNode(r.id);
            return { id: r.id, score: r.score, type: n?.type };
          }),
          counts,
          this.config.spreadDocSeedWeight,
        );
        const activated = spreadActivation(
          this.spreadReader,
          seeds,
          spreadParamsFromConfig(this.config, opts.spreadHops),
        );
        const present = new Set(finalRows.map(r => r.id));
        const assocRanked = Array.from(activated.entries())
          .filter(([id]) => !present.has(id) && !staleEntityIds.has(id))
          .sort((a, b) => (b[1].activation - a[1].activation) || (a[0] < b[0] ? -1 : 1));
        const assocRows: Array<{ id: string; value: string; score: number }> = [];
        for (const [id, node] of assocRanked) {
          if (assocRows.length >= this.config.spreadAssocSlotCap) break;
          const row = this.store.getNode(id);
          if (!row || row.tombstoned === 1) continue;  // graph arrival exempts nothing (B2 discipline)
          assocRows.push({ id, value: row.value, score: Math.min(1, node.activation) });
        }
        if (assocRows.length > 0) {
          // RRF-fuse the two orderings (spec §3.3), keep k rows, assoc contribution already capped.
          const fusedIds = rrfFuse([finalRows, assocRows], 60, k + assocRows.length).map(f => f.id);
          const byId = new Map<string, { id: string; value: string; score: number }>();
          for (const r of [...finalRows, ...assocRows]) if (!byId.has(r.id)) byId.set(r.id, r);
          finalRows = fusedIds.map(id => byId.get(id)!).filter(Boolean).slice(0, k);
        }
      } catch {
        // fail-open: associative channel must never break retrieval (spec §3.1)
      }
    }
```

Adapt `finalRows` to whatever the local variable holding the assembled result is actually named at that point (read the surrounding code first); if the method returns different arrays per branch, apply the block once on the value about to be returned. `staleEntityIds` is already in scope from the B2 filter earlier in the method — if the insertion point is after it goes out of scope, hoist the existing set, do not re-query.

- [ ] **Step 4: Run the new tests + the full retrieval suites** (`npx vitest run tests/retrieval-spread.test.ts tests/retrieval.test.ts && npm run typecheck`). The byte-identity test plus the pre-existing retrieval tests are the regression net — all must pass untouched.

---

### Task 7: Ambient wiring (dark) + full verification

**Files:**
- Modify: `src/adapter/ambient-recall.ts` (one line: pass the flag)
- Test: extend `tests/retrieval-spread.test.ts` with a config-driven case

- [ ] **Step 1:** In `ambient-recall.ts`, find the `engine.retrieveRanked(vec, AMBIENT_K, AMBIENT_FLOOR, undefined, { ... })` call and add `spreadHops: config.spreadHops` to its opts object. With the default `spreadHops: 0` this is a no-op in production (feature ships dark; flipping it on later is a config change, not a deploy).

- [ ] **Step 2:** Add to `tests/retrieval-spread.test.ts`:

```ts
  it('config-driven: spreadHops from config flows through opts (ambient wiring shape)', () => {
    const hot = { ...cfg, spreadHops: 2 };
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const e2 = new RetrievalEngine(db, clock, hot, new CandidateRetriever(db), store, new StrengthDecayManager(db, clock, hot), new AllocationGate(hot));
    const rows = e2.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: hot.spreadHops });
    expect(rows.map(r => r.id)).toContain('term');
  });
```

- [ ] **Step 3: Full verification.** `npm run typecheck && npm test` (expect the pre-existing HTTP-listener failures ONLY if sandboxed — note them as sandbox artifacts, they are not yours) and `npm run eval:bridge` one final time. The final report must include: the full before/after eval table (baseline `bridge-af2a5f5.json` vs the new run), the tuning-sweep table, `path_valid_rate` for the spread arms, and every file created/modified.

---

## Self-review notes

- Spec coverage: §3.1 core mechanics (T2), batched execution (T3), §3.2 seeding incl. specificity + doc weight (T2/T5/T6), §3.3 RRF fusion + assoc slot cap + byte-identity dark switch (T6), §5 oracle test (T4), harness arms + tuning (T5), ambient dark wiring (T7). Deferred per spec phasing: recall-CLI integration (Phase 3), path rendering + multi-hop viz traces (Phase 4).
- The `rrfFuse` signature is `rrfFuse(lists: Array<Array<{id: string}>>, k = 60, topK = 10, weights?: number[])` (src/retrieval/topk.ts:265) — both row arrays satisfy `{id}` structurally.
- Type consistency: `SpreadParams`/`PathStep`/`ActivatedNode` defined once in T2, consumed by T3–T6; `ArmResult.paths` shape matches Phase 1's `bridge-metrics.ts` `Array<{src, rel, dst}>` exactly, so `path_valid` verification works unchanged.
