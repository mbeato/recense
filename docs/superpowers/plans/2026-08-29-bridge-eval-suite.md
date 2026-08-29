# Bridge-Recall Eval Suite (Graph-Aware Recall, Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the associative-recall eval suite that Phase 2 (the activation core) will be tuned against: bridge probes mined from the real graph, a harness with pluggable retrieval arms (today's product path as the graph-off baseline plus an exact-PPR reference arm), retrieval-recall metrics, and a committed baseline.

**Architecture:** Pure logic (probe filtering, metrics, exact PPR, arm runners) lives in `src/eval/*.ts` and is unit-tested with vitest on in-memory SQLite fixtures. Two thin `.cjs` CLIs under `scripts/eval/` require the compiled `dist/` (house convention): a miner that reads a read-only DB snapshot and emits a probe set, and a harness that runs every arm over every probe and writes a `{ meta, scores, per_probe }` results envelope. No LLM or embedding API calls anywhere: each probe's query is its seed node's own value, so the query vector is the seed's stored embedding.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Node CJS harness scripts. Runner: `npm test` (= `vitest run`, pretest builds `dist/`). Typecheck: `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-08-26-graph-aware-recall-design.md` — §5 (Testing & evaluation) and §6 Phase 1. Read §3.1's edge eligibility table; the PPR reference arm implements it verbatim.

## Global Constraints

- Never open the live DB at `~/.config/recense/recense.db` for writing. The miner and harness open their `--db` argument with `{ readonly: true }`. Use the snapshot at `scripts/eval/fixtures/bridge-snapshot.db` (gitignored; created with `sqlite3 <live> ".backup <snapshot>"` — a plain `cp` loses WAL contents).
- Mined probe values are personal-graph content. `scripts/eval/cases/bridge-probes.json` is gitignored; results files contain node ids and metrics only, never node values.
- No fabricated numbers: every gold is a real live node reachable by a real edge path (queries-37 precedent, `_meta.founder_signoff` starts as `"PENDING"`).
- Tombstoned is `number` (0|1), compare with `=== 1` / `=== 0`. Edge `kind === 'relation'` is NOT sufficient for "typed predicate" — always AND with `PRED_SET.has(rel)`.
- `RetrievalEngine` constructor order is `(db, clock, config, retriever, store, strength, gate)` — `retriever` before `store`.
- Embeddings: read with `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)`. In tests all vectors share one dimension (16) because `setEmbedding` stamps `meta.embedding_dims` and throws on mismatch.
- Commit messages: conventional prefix (`feat:`/`test:`/`docs:`), no Co-Authored-By trailers.
- Stop and report if: `npm run typecheck` fails for reasons outside the files you touched; the snapshot DB is missing; a task's test cannot be made to pass without changing files outside its `Files:` list.

---

### Task 1: Probe types, tokenizer, and candidate filter

**Files:**
- Create: `src/eval/bridge-probes.ts`
- Test: `tests/bridge-probes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProbeNode { id: string; type: string; value: string }
  export interface ProbeStep { src: string; rel: string; kind: string; dir: 'fwd' | 'rev'; dst: string }
  export interface BridgeProbe {
    id: string;                 // 'bp001'
    query: string;              // === seed.value
    seed: ProbeNode; bridge: ProbeNode; terminal: ProbeNode;
    path: [ProbeStep, ProbeStep];
    seed_outdeg: number;
    dilution: 'lo' | 'mid' | 'hi';
    stratum: string;            // `${bridge.type}:${dilution}`
    cosine_seed_terminal: number;
  }
  export interface ProbeSet {
    _meta: { db_source: string; generated_at: string; total: number; strata: Record<string, number>; founder_signoff: string; cosine_ceiling: number };
    probes: BridgeProbe[];
  }
  export const COSINE_CEILING = 0.5;
  export function tokenize(text: string): Set<string>
  export function lexicalOverlap(a: string, b: string): number   // count of shared tokens
  export function isLexicallyDisjoint(query: string, terminal: string): boolean
  export function dilutionTier(outdeg: number, terciles: [number, number]): 'lo' | 'mid' | 'hi'
  export function roundRobinSample<T extends { stratum: string }>(items: T[], target: number, key: (t: T) => string): T[]
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/bridge-probes.test.ts
import { describe, it, expect } from 'vitest';
import {
  tokenize, lexicalOverlap, isLexicallyDisjoint, dilutionTier, roundRobinSample,
} from '../src/eval/bridge-probes';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and short tokens', () => {
    const t = tokenize('The Cloudflare worker runs on the apex domain, and it is fast!');
    expect(t).toEqual(new Set(['cloudflare', 'worker', 'runs', 'apex', 'domain', 'fast']));
  });
});

describe('lexicalOverlap / isLexicallyDisjoint', () => {
  it('counts shared content tokens', () => {
    expect(lexicalOverlap('urby-www runs on Cloudflare', 'Cloudflare Pages hosts the site')).toBe(1);
  });
  it('is disjoint only at zero shared tokens', () => {
    expect(isLexicallyDisjoint('urby-www deploys to Cloudflare', 'the dashboard custom domain is attached')).toBe(true);
    expect(isLexicallyDisjoint('urby-www deploys to Cloudflare', 'Cloudflare dashboard custom domain')).toBe(false);
  });
});

describe('dilutionTier', () => {
  it('maps out-degree to lo/mid/hi by terciles', () => {
    expect(dilutionTier(1, [3, 8])).toBe('lo');
    expect(dilutionTier(3, [3, 8])).toBe('mid');
    expect(dilutionTier(9, [3, 8])).toBe('hi');
  });
});

describe('roundRobinSample', () => {
  it('draws evenly across strata in deterministic key order and never exceeds target', () => {
    const items = [
      { stratum: 'a', id: 'a1' }, { stratum: 'a', id: 'a2' }, { stratum: 'a', id: 'a3' },
      { stratum: 'b', id: 'b1' }, { stratum: 'c', id: 'c1' }, { stratum: 'c', id: 'c2' },
    ];
    const out = roundRobinSample(items, 4, i => i.id);
    expect(out.map(i => i.id)).toEqual(['a1', 'b1', 'c1', 'a2']);
  });
  it('returns everything when target exceeds supply', () => {
    const items = [{ stratum: 'a', id: 'a1' }, { stratum: 'b', id: 'b1' }];
    expect(roundRobinSample(items, 10, i => i.id)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge-probes.test.ts`
Expected: FAIL — cannot resolve `../src/eval/bridge-probes`.

- [ ] **Step 3: Implement**

```ts
// src/eval/bridge-probes.ts
/**
 * Bridge-probe types and pure filters for the associative-recall eval suite
 * (spec: docs/superpowers/specs/2026-08-26-graph-aware-recall-design.md §5).
 *
 * A bridge probe is a real 2-edge path seed → bridge → terminal mined from a live
 * graph where the terminal shares no content tokens with the query (= seed value) and
 * has low cosine to it — the case hybrid BM25+cosine retrieval cannot reach on its own.
 */

export interface ProbeNode { id: string; type: string; value: string }
export interface ProbeStep { src: string; rel: string; kind: string; dir: 'fwd' | 'rev'; dst: string }

export interface BridgeProbe {
  id: string;
  query: string;
  seed: ProbeNode;
  bridge: ProbeNode;
  terminal: ProbeNode;
  path: [ProbeStep, ProbeStep];
  seed_outdeg: number;
  dilution: 'lo' | 'mid' | 'hi';
  stratum: string;
  cosine_seed_terminal: number;
}

export interface ProbeSet {
  _meta: {
    db_source: string;
    generated_at: string;
    total: number;
    strata: Record<string, number>;
    founder_signoff: string;
    cosine_ceiling: number;
  };
  probes: BridgeProbe[];
}

/** Terminal must sit below this cosine to the seed — otherwise dense retrieval already finds it. */
export const COSINE_CEILING = 0.5;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'has', 'have',
  'had', 'not', 'but', 'its', 'into', 'onto', 'over', 'via', 'you', 'your', 'our', 'can',
  'will', 'when', 'then', 'than', 'also', 'all', 'any', 'each', 'per', 'use', 'used', 'uses',
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function lexicalOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  let n = 0;
  for (const t of tokenize(b)) if (ta.has(t)) n++;
  return n;
}

export function isLexicallyDisjoint(query: string, terminal: string): boolean {
  return lexicalOverlap(query, terminal) === 0;
}

export function dilutionTier(outdeg: number, terciles: [number, number]): 'lo' | 'mid' | 'hi' {
  if (outdeg < terciles[0]) return 'lo';
  if (outdeg < terciles[1]) return 'mid';
  return 'hi';
}

/**
 * Deterministic stratified draw: items are bucketed by `stratum`, each bucket sorted by
 * `key`, buckets visited in sorted stratum order, one item per bucket per round until
 * `target` is reached or supply is exhausted.
 */
export function roundRobinSample<T extends { stratum: string }>(
  items: T[],
  target: number,
  key: (t: T) => string,
): T[] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const b = buckets.get(it.stratum) ?? [];
    b.push(it);
    buckets.set(it.stratum, b);
  }
  const order = Array.from(buckets.keys()).sort();
  for (const s of order) buckets.get(s)!.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const out: T[] = [];
  let progressed = true;
  while (out.length < target && progressed) {
    progressed = false;
    for (const s of order) {
      const b = buckets.get(s)!;
      if (b.length === 0) continue;
      out.push(b.shift()!);
      progressed = true;
      if (out.length >= target) break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bridge-probes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/eval/bridge-probes.ts tests/bridge-probes.test.ts
git commit -m "feat(eval): bridge-probe types, tokenizer and stratified sampler"
```

---

### Task 2: Retrieval metrics and path verification

**Files:**
- Create: `src/eval/bridge-metrics.ts`
- Test: `tests/bridge-metrics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ArmResult {
    rankedIds: string[];                              // best first, seeds excluded
    paths?: Map<string, Array<{ src: string; rel: string; dst: string }>>;  // optional provenance per surfaced id
    nodesExpanded: number;
    latencyMs: number;
  }
  export interface ProbeScore {
    terminal_at_5: 0 | 1; terminal_at_10: 0 | 1; terminal_at_20: 0 | 1;
    bridge_at_10: 0 | 1;
    reciprocal_rank: number;                          // 1/rank of terminal, 0 if absent
    path_valid: boolean | null;                       // null when the arm returned no path for the terminal
    nodes_expanded: number; latency_ms: number;
  }
  export interface EdgeExistence { has(src: string, rel: string, dst: string): boolean }
  export function scoreProbe(result: ArmResult, terminalId: string, bridgeId: string, edges: EdgeExistence): ProbeScore
  export interface ArmAggregate {
    n: number; r5: number; r10: number; r20: number; bridge_r10: number; mrr: number;
    path_valid_rate: number | null; nodes_expanded_mean: number; latency_p50: number; latency_p95: number;
  }
  export function aggregate(scores: ProbeScore[]): ArmAggregate
  export function percentile(values: number[], p: number): number
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/bridge-metrics.test.ts
import { describe, it, expect } from 'vitest';
import { scoreProbe, aggregate, percentile } from '../src/eval/bridge-metrics';

const edges = { has: (s: string, r: string, d: string) => `${s}|${r}|${d}` === 'seed|uses|bridge' || `${s}|${r}|${d}` === 'bridge|extends|term' };

describe('scoreProbe', () => {
  it('scores recall@k, MRR and bridge hit from a ranked list', () => {
    const s = scoreProbe(
      { rankedIds: ['x', 'bridge', 'y', 'term'], nodesExpanded: 12, latencyMs: 3 },
      'term', 'bridge', edges,
    );
    expect(s.terminal_at_5).toBe(1);
    expect(s.terminal_at_10).toBe(1);
    expect(s.bridge_at_10).toBe(1);
    expect(s.reciprocal_rank).toBeCloseTo(0.25);
    expect(s.path_valid).toBeNull();
  });
  it('gives zero recall and rr when the terminal is absent', () => {
    const s = scoreProbe({ rankedIds: ['a', 'b'], nodesExpanded: 2, latencyMs: 1 }, 'term', 'bridge', edges);
    expect(s.terminal_at_20).toBe(0);
    expect(s.reciprocal_rank).toBe(0);
    expect(s.bridge_at_10).toBe(0);
  });
  it('verifies a returned path against real edges', () => {
    const good = new Map([['term', [{ src: 'seed', rel: 'uses', dst: 'bridge' }, { src: 'bridge', rel: 'extends', dst: 'term' }]]]);
    const bad = new Map([['term', [{ src: 'seed', rel: 'uses', dst: 'term' }]]]);
    expect(scoreProbe({ rankedIds: ['term'], paths: good, nodesExpanded: 1, latencyMs: 1 }, 'term', 'bridge', edges).path_valid).toBe(true);
    expect(scoreProbe({ rankedIds: ['term'], paths: bad, nodesExpanded: 1, latencyMs: 1 }, 'term', 'bridge', edges).path_valid).toBe(false);
  });
});

describe('aggregate / percentile', () => {
  it('averages hit flags and rr, and reports latency percentiles', () => {
    const base = { bridge_at_10: 0 as const, path_valid: null, nodes_expanded: 10 };
    const a = aggregate([
      { ...base, terminal_at_5: 1, terminal_at_10: 1, terminal_at_20: 1, reciprocal_rank: 1, latency_ms: 10 },
      { ...base, terminal_at_5: 0, terminal_at_10: 1, terminal_at_20: 1, reciprocal_rank: 0.1, latency_ms: 30 },
    ]);
    expect(a.n).toBe(2);
    expect(a.r5).toBe(0.5);
    expect(a.r10).toBe(1);
    expect(a.mrr).toBeCloseTo(0.55);
    expect(a.path_valid_rate).toBeNull();
    expect(a.latency_p50).toBe(10);
    expect(a.latency_p95).toBe(30);
  });
  it('percentile uses nearest-rank on a sorted copy', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([], 50)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge-metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/eval/bridge-metrics.ts
/** Retrieval-recall metrics for bridge probes (spec §5). Retrieval recall is primary; no answer scoring here. */

export interface ArmResult {
  rankedIds: string[];
  paths?: Map<string, Array<{ src: string; rel: string; dst: string }>>;
  nodesExpanded: number;
  latencyMs: number;
}

export interface ProbeScore {
  terminal_at_5: 0 | 1;
  terminal_at_10: 0 | 1;
  terminal_at_20: 0 | 1;
  bridge_at_10: 0 | 1;
  reciprocal_rank: number;
  path_valid: boolean | null;
  nodes_expanded: number;
  latency_ms: number;
}

export interface EdgeExistence { has(src: string, rel: string, dst: string): boolean }

function hitAt(ranked: string[], id: string, k: number): 0 | 1 {
  return ranked.slice(0, k).includes(id) ? 1 : 0;
}

export function scoreProbe(
  result: ArmResult,
  terminalId: string,
  bridgeId: string,
  edges: EdgeExistence,
): ProbeScore {
  const rank = result.rankedIds.indexOf(terminalId);
  let path_valid: boolean | null = null;
  const path = result.paths?.get(terminalId);
  if (path) {
    path_valid = path.length > 0 && path.every(st => edges.has(st.src, st.rel, st.dst));
  }
  return {
    terminal_at_5: hitAt(result.rankedIds, terminalId, 5),
    terminal_at_10: hitAt(result.rankedIds, terminalId, 10),
    terminal_at_20: hitAt(result.rankedIds, terminalId, 20),
    bridge_at_10: hitAt(result.rankedIds, bridgeId, 10),
    reciprocal_rank: rank === -1 ? 0 : 1 / (rank + 1),
    path_valid,
    nodes_expanded: result.nodesExpanded,
    latency_ms: result.latencyMs,
  };
}

export interface ArmAggregate {
  n: number;
  r5: number;
  r10: number;
  r20: number;
  bridge_r10: number;
  mrr: number;
  path_valid_rate: number | null;
  nodes_expanded_mean: number;
  latency_p50: number;
  latency_p95: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function aggregate(scores: ProbeScore[]): ArmAggregate {
  const withPath = scores.filter(s => s.path_valid !== null);
  return {
    n: scores.length,
    r5: mean(scores.map(s => s.terminal_at_5)),
    r10: mean(scores.map(s => s.terminal_at_10)),
    r20: mean(scores.map(s => s.terminal_at_20)),
    bridge_r10: mean(scores.map(s => s.bridge_at_10)),
    mrr: mean(scores.map(s => s.reciprocal_rank)),
    path_valid_rate: withPath.length === 0 ? null : mean(withPath.map(s => (s.path_valid ? 1 : 0))),
    nodes_expanded_mean: mean(scores.map(s => s.nodes_expanded)),
    latency_p50: percentile(scores.map(s => s.latency_ms), 50),
    latency_p95: percentile(scores.map(s => s.latency_ms), 95),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bridge-metrics.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/eval/bridge-metrics.ts tests/bridge-metrics.test.ts
git commit -m "feat(eval): bridge-probe recall/MRR metrics and path verification"
```

---

### Task 3: Exact personalized-PageRank reference

This is the Phase 2 oracle (spec §5 "Exact-PPR oracle test") and the only graph arm that exists in Phase 1. It implements the spec §3.1 edge-eligibility table verbatim so the baseline run also estimates the ceiling for graph methods.

**Files:**
- Create: `src/eval/ppr-reference.ts`
- Test: `tests/ppr-reference.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const REFERENCE_REL_WEIGHTS: Record<string, { fwd: number; rev: number }>   // spec §3.1 table, keyed by `${kind}:${rel}` with `${kind}:*` fallback
  export function eligibleWeight(kind: string, rel: string, dir: 'fwd' | 'rev'): number
  export interface Adjacency { ids: string[]; index: Map<string, number>; out: Array<Array<{ to: number; w: number; rel: string; kind: string }>> }
  export function loadAdjacency(db: import('better-sqlite3').Database): Adjacency   // live nodes only; both directions with per-dir weights
  export function pprExact(adj: Adjacency, seeds: Map<string, number>, opts?: { damping?: number; iterations?: number }): Float64Array
  export function rankFromScores(adj: Adjacency, scores: Float64Array, excludeIds: Set<string>, k: number): string[]
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ppr-reference.test.ts
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { eligibleWeight, loadAdjacency, pprExact, rankFromScores } from '../src/eval/ppr-reference';

const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

describe('eligibleWeight', () => {
  it('follows the spec table with kind fallback', () => {
    expect(eligibleWeight('relation', 'depends_on', 'fwd')).toBe(1.0);
    expect(eligibleWeight('relation', 'depends_on', 'rev')).toBe(0.8);
    expect(eligibleWeight('relation', 'extends', 'fwd')).toBe(0.7);
    expect(eligibleWeight('abstracts', 'abstracts', 'rev')).toBe(0.8);
    expect(eligibleWeight('doc_containment', 'doc_containment', 'fwd')).toBe(0);
  });
});

describe('pprExact', () => {
  let db: Database.Database;
  let store: SemanticStore;
  const node = (id: string, type: 'fact' | 'entity' | 'schema' = 'fact') =>
    store.upsertNode({ id, type, value: `value of ${id}`, origin: 'observed' });
  const edge = (src: string, dst: string, rel = 'depends_on', kind: 'relation' | 'abstracts' = 'relation') =>
    store.upsertEdge({ src, dst, rel, w: 0.1, kind });

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), cfg);
  });
  afterEach(() => db.close());

  it('reaches a 2-hop terminal and conserves total mass', () => {
    node('A'); node('B'); node('C'); node('Z');
    edge('A', 'B'); edge('B', 'C');
    const adj = loadAdjacency(db);
    const scores = pprExact(adj, new Map([['A', 1]]));
    const sum = Array.from(scores).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(scores[adj.index.get('C')!]).toBeGreaterThan(0);
    expect(scores[adj.index.get('Z')!]).toBe(0);
    expect(rankFromScores(adj, scores, new Set(['A']), 10)).toEqual(['B', 'C']);
  });

  it('row-normalizes so a hub does not out-emit a quiet node', () => {
    node('S'); node('H'); node('Q'); node('Qn');
    for (let i = 0; i < 50; i++) { node(`Hn${i}`); edge('H', `Hn${i}`); }
    edge('S', 'H'); edge('S', 'Q'); edge('Q', 'Qn');
    const adj = loadAdjacency(db);
    const scores = pprExact(adj, new Map([['S', 1]]));
    expect(scores[adj.index.get('Qn')!]).toBeGreaterThan(scores[adj.index.get('Hn0')!] * 10);
  });

  it('traverses abstracts in reverse to reach sibling facts under a schema', () => {
    node('F1'); node('F2'); node('SCH', 'schema');
    edge('F1', 'SCH', 'abstracts', 'abstracts'); edge('F2', 'SCH', 'abstracts', 'abstracts');
    const adj = loadAdjacency(db);
    const scores = pprExact(adj, new Map([['F1', 1]]));
    expect(scores[adj.index.get('F2')!]).toBeGreaterThan(0);
  });

  it('ignores tombstoned nodes', () => {
    node('A'); node('B'); node('C');
    edge('A', 'B'); edge('B', 'C');
    store.tombstone('B');
    const adj = loadAdjacency(db);
    expect(adj.index.has('B')).toBe(false);
    const scores = pprExact(adj, new Map([['A', 1]]));
    expect(scores[adj.index.get('C')!]).toBe(0);
  });

  it('is deterministic', () => {
    node('A'); node('B'); node('C');
    edge('A', 'B'); edge('A', 'C');
    const adj = loadAdjacency(db);
    const a = Array.from(pprExact(adj, new Map([['A', 1]])));
    const b = Array.from(pprExact(adj, new Map([['A', 1]])));
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ppr-reference.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/eval/ppr-reference.ts
/**
 * Exact personalized PageRank over the live graph — the eval reference arm and the
 * Phase 2 oracle (spec §3.1 transfer semantics, §5 "Exact-PPR oracle test").
 *
 * Transition mass from u to v is eligibleWeight(kind, rel, dir) × w, row-normalized over
 * u's eligible edges (mass-conserving, 1/weighted-fan). Dangling nodes return their mass
 * to the seed distribution. Power iteration; at ~30k edges this is milliseconds.
 */
import type Database from 'better-sqlite3';

/** Spec §3.1 edge eligibility table. Keys are `${kind}:${rel}`; `${kind}:*` is the fallback. */
export const REFERENCE_REL_WEIGHTS: Record<string, { fwd: number; rev: number }> = {
  'relation:*': { fwd: 1.0, rev: 0.8 },
  'relation:extends': { fwd: 0.7, rev: 0.5 },
  'abstracts:*': { fwd: 0.8, rev: 0.8 },
  'derived_from:*': { fwd: 0.9, rev: 0.6 },
  'schema_rel:*': { fwd: 0.6, rev: 0.6 },
  'cites:*': { fwd: 0.4, rev: 0.2 },
  'doc_link:*': { fwd: 0.3, rev: 0.3 },
  'doc_reference:*': { fwd: 0.3, rev: 0.3 },
  'doc_containment:*': { fwd: 0, rev: 0 },
};

export function eligibleWeight(kind: string, rel: string, dir: 'fwd' | 'rev'): number {
  const entry = REFERENCE_REL_WEIGHTS[`${kind}:${rel}`] ?? REFERENCE_REL_WEIGHTS[`${kind}:*`];
  return entry ? entry[dir] : 0;
}

export interface Adjacency {
  ids: string[];
  index: Map<string, number>;
  out: Array<Array<{ to: number; w: number; rel: string; kind: string }>>;
}

export function loadAdjacency(db: Database.Database): Adjacency {
  const ids = (db.prepare(`SELECT id FROM node WHERE tombstoned = 0 ORDER BY id ASC`).all() as Array<{ id: string }>)
    .map(r => r.id);
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));
  const out: Adjacency['out'] = ids.map(() => []);
  const rows = db.prepare(`SELECT src, dst, rel, kind, w FROM edge`).all() as Array<{
    src: string; dst: string; rel: string; kind: string; w: number;
  }>;
  for (const e of rows) {
    const s = index.get(e.src);
    const d = index.get(e.dst);
    if (s === undefined || d === undefined) continue; // tombstoned or missing endpoint
    const fwd = eligibleWeight(e.kind, e.rel, 'fwd') * e.w;
    const rev = eligibleWeight(e.kind, e.rel, 'rev') * e.w;
    if (fwd > 0) out[s]!.push({ to: d, w: fwd, rel: e.rel, kind: e.kind });
    if (rev > 0) out[d]!.push({ to: s, w: rev, rel: e.rel, kind: e.kind });
  }
  return { ids, index, out };
}

export function pprExact(
  adj: Adjacency,
  seeds: Map<string, number>,
  opts: { damping?: number; iterations?: number } = {},
): Float64Array {
  const alpha = opts.damping ?? 0.5;       // probability of continuing the walk (HippoRAG's 0.5)
  const iterations = opts.iterations ?? 40;
  const n = adj.ids.length;
  const restart = new Float64Array(n);
  let seedMass = 0;
  for (const [id, m] of seeds) {
    const i = adj.index.get(id);
    if (i !== undefined && m > 0) { restart[i] += m; seedMass += m; }
  }
  if (seedMass === 0) return new Float64Array(n);
  for (let i = 0; i < n; i++) restart[i] /= seedMass;

  const outMass = new Float64Array(n);
  for (let u = 0; u < n; u++) for (const e of adj.out[u]!) outMass[u] += e.w;

  let p = Float64Array.from(restart);
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let u = 0; u < n; u++) {
      const pu = p[u]!;
      if (pu === 0) continue;
      if (outMass[u] === 0) { dangling += pu; continue; }
      const scale = (alpha * pu) / outMass[u]!;
      for (const e of adj.out[u]!) next[e.to] += scale * e.w;
    }
    const restartShare = 1 - alpha + alpha * dangling;
    for (let i = 0; i < n; i++) next[i] += restartShare * restart[i]!;
    p = next;
  }
  return p;
}

/** Ranked ids by score desc, id-asc tiebreak, excluding `excludeIds` (normally the seeds). */
export function rankFromScores(adj: Adjacency, scores: Float64Array, excludeIds: Set<string>, k: number): string[] {
  const pairs: Array<{ id: string; s: number }> = [];
  for (let i = 0; i < adj.ids.length; i++) {
    const id = adj.ids[i]!;
    const s = scores[i]!;
    if (s > 0 && !excludeIds.has(id)) pairs.push({ id, s });
  }
  pairs.sort((a, b) => (b.s - a.s) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return pairs.slice(0, k).map(p => p.id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ppr-reference.test.ts`
Expected: PASS (6 tests). If the hub test fails, check that `outMass` is computed over the *eligible-weighted* out list (not raw degree) — the 50 hub edges must split the hub's mass 50 ways.

- [ ] **Step 5: Commit**

```bash
git add src/eval/ppr-reference.ts tests/ppr-reference.test.ts
git commit -m "feat(eval): exact personalized-PageRank reference arm"
```

---

### Task 4: Retrieval arms and per-probe runner

Arms are the pluggable seam Phase 2 will extend with `spread-2hop` / `spread-3hop`. Phase 1 ships: `cosine`, `hybrid` (today's product path = graph-off baseline), `typed` (typedReach with the probe's gold predicates — an oracle upper bound for typed traversal, `null` when the path is not two forward typed predicates), `ppr-exact`.

**Files:**
- Create: `src/eval/bridge-arms.ts`
- Test: `tests/bridge-arms.test.ts`

**Interfaces:**
- Consumes: `ArmResult` (Task 2), `loadAdjacency/pprExact/rankFromScores` (Task 3), `BridgeProbe` (Task 1), `RetrievalEngine.retrieveRanked(vec, k, floor, queryText)`, `CandidateRetriever.topk(vec, k)`, `typedReach(store, anchor, predicatePath, K)` from `src/recall/typed-traversal`, `PRED_SET` from `src/model/typed-predicates`.
- Produces:
  ```ts
  export type SeedMode = 'oracle' | 'e2e';
  export interface ArmContext {
    db: Database; store: SemanticStore; retriever: CandidateRetriever; engine: RetrievalEngine;
    adjacency: Adjacency; k: number; floor: number; e2eSeedK: number;
  }
  export interface ProbeInput { probe: BridgeProbe; queryVec: Float32Array; mode: SeedMode }
  export interface Arm { name: string; usesSeeds: boolean; run(input: ProbeInput, ctx: ArmContext): ArmResult | null }
  export const ARMS: Arm[]
  export function resolveSeeds(input: ProbeInput, ctx: ArmContext): Map<string, number>   // oracle → {seed:1}; e2e → hybrid top e2eSeedK with their scores (min 0.01)
  export function readEmbedding(db: Database, id: string): Float32Array | null
  export function edgeExistence(db: Database): EdgeExistence
  ```

- [ ] **Step 1: Write the failing test**

The fixture makes the whole suite's point in miniature: the terminal is reachable in 2 hops but orthogonal in embedding space, so `hybrid` misses it and `ppr-exact` finds it.

```ts
// tests/bridge-arms.test.ts
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
import { ARMS, resolveSeeds, readEmbedding, edgeExistence, type ArmContext } from '../src/eval/bridge-arms';
import { loadAdjacency } from '../src/eval/ppr-reference';
import type { BridgeProbe } from '../src/eval/bridge-probes';

const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

function basis(i: number): Float32Array { const v = new Float32Array(16); v[i] = 1; return v; }

describe('bridge arms', () => {
  let db: Database.Database;
  let store: SemanticStore;
  let ctx: ArmContext;
  let probe: BridgeProbe;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, cfg);
    const add = (id: string, value: string, vec: Float32Array, type: 'fact' | 'entity' = 'fact') => {
      store.upsertNode({ id, type, value, origin: 'observed', s: 0.5 });
      store.setEmbedding(id, vec);
    };
    add('seed', 'urby-www deploys to Cloudflare Pages', basis(0));
    add('bridge', 'Cloudflare', basis(1), 'entity');
    add('term', 'the dashboard custom domain attachment is locked', basis(2));
    add('noise', 'unrelated weekend plans', basis(3));
    store.upsertEdge({ src: 'seed', dst: 'bridge', rel: 'runs_on', w: 0.1, kind: 'relation' });
    store.upsertEdge({ src: 'bridge', dst: 'term', rel: 'extends', w: 0.1, kind: 'relation' });

    const retriever = new CandidateRetriever(db);
    const engine = new RetrievalEngine(db, clock, cfg, retriever, store, new StrengthDecayManager(db, clock, cfg), new AllocationGate(cfg));
    ctx = { db, store, retriever, engine, adjacency: loadAdjacency(db), k: 10, floor: 0.3, e2eSeedK: 3 };
    probe = {
      id: 'bp001', query: 'urby-www deploys to Cloudflare Pages',
      seed: { id: 'seed', type: 'fact', value: 'urby-www deploys to Cloudflare Pages' },
      bridge: { id: 'bridge', type: 'entity', value: 'Cloudflare' },
      terminal: { id: 'term', type: 'fact', value: 'the dashboard custom domain attachment is locked' },
      path: [
        { src: 'seed', rel: 'runs_on', kind: 'relation', dir: 'fwd', dst: 'bridge' },
        { src: 'bridge', rel: 'extends', kind: 'relation', dir: 'fwd', dst: 'term' },
      ],
      seed_outdeg: 1, dilution: 'lo', stratum: 'entity:lo', cosine_seed_terminal: 0,
    };
  });
  afterEach(() => db.close());

  it('reads a stored embedding back as Float32Array', () => {
    expect(Array.from(readEmbedding(db, 'seed')!)).toEqual(Array.from(basis(0)));
    expect(readEmbedding(db, 'nope')).toBeNull();
  });

  it('hybrid (graph-off baseline) does not reach the orthogonal terminal; ppr-exact does', () => {
    const input = { probe, queryVec: basis(0), mode: 'oracle' as const };
    const hybrid = ARMS.find(a => a.name === 'hybrid')!.run(input, ctx)!;
    const ppr = ARMS.find(a => a.name === 'ppr-exact')!.run(input, ctx)!;
    expect(hybrid.rankedIds).not.toContain('term');
    expect(ppr.rankedIds).toContain('term');
    expect(ppr.rankedIds).not.toContain('seed');
    expect(ppr.nodesExpanded).toBeGreaterThan(0);
  });

  it('typed arm walks the gold predicate path only when both hops are forward typed predicates', () => {
    const typed = ARMS.find(a => a.name === 'typed')!;
    expect(typed.run({ probe, queryVec: basis(0), mode: 'oracle' }, ctx)).toBeNull(); // 'extends' is not in PRED_SET
    store.upsertEdge({ src: 'bridge', dst: 'term', rel: 'uses', w: 0.1, kind: 'relation' });
    const typedProbe = { ...probe, path: [probe.path[0], { ...probe.path[1], rel: 'uses' }] as BridgeProbe['path'] };
    expect(typed.run({ probe: typedProbe, queryVec: basis(0), mode: 'oracle' }, ctx)!.rankedIds).toContain('term');
  });

  it('resolveSeeds: oracle returns the gold seed; e2e returns hybrid hits', () => {
    expect(Array.from(resolveSeeds({ probe, queryVec: basis(0), mode: 'oracle' }, ctx).keys())).toEqual(['seed']);
    const e2e = resolveSeeds({ probe, queryVec: basis(0), mode: 'e2e' }, ctx);
    expect(e2e.has('seed')).toBe(true);
    for (const m of e2e.values()) expect(m).toBeGreaterThan(0);
  });

  it('edgeExistence checks real edge rows', () => {
    const ex = edgeExistence(db);
    expect(ex.has('seed', 'runs_on', 'bridge')).toBe(true);
    expect(ex.has('seed', 'runs_on', 'term')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge-arms.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/eval/bridge-arms.ts
/**
 * Pluggable retrieval arms for the bridge-probe harness (spec §5 "Ablation arms").
 * Phase 1 arms: cosine, hybrid (today's product path — the graph-off baseline), typed
 * (oracle upper bound via the probe's gold predicates), ppr-exact (reference). Phase 2 adds
 * the activation-core arms here without touching the harness.
 */
import type Database from 'better-sqlite3';
import type { SemanticStore } from '../db/semantic-store';
import type { CandidateRetriever } from '../retrieval/topk';
import type { RetrievalEngine } from '../retrieval/engine';
import { typedReach } from '../recall/typed-traversal';
import { PRED_SET } from '../model/typed-predicates';
import type { BridgeProbe } from './bridge-probes';
import type { ArmResult, EdgeExistence } from './bridge-metrics';
import { pprExact, rankFromScores, type Adjacency } from './ppr-reference';

export type SeedMode = 'oracle' | 'e2e';

export interface ArmContext {
  db: Database.Database;
  store: SemanticStore;
  retriever: CandidateRetriever;
  engine: RetrievalEngine;
  adjacency: Adjacency;
  k: number;
  floor: number;
  e2eSeedK: number;
}

export interface ProbeInput { probe: BridgeProbe; queryVec: Float32Array; mode: SeedMode }

export interface Arm {
  name: string;
  usesSeeds: boolean;
  run(input: ProbeInput, ctx: ArmContext): ArmResult | null;
}

export function readEmbedding(db: Database.Database, id: string): Float32Array | null {
  const row = db.prepare(`SELECT embedding FROM node WHERE id = ?`).get(id) as { embedding: Buffer | null } | undefined;
  const buf = row?.embedding;
  if (!buf || buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function edgeExistence(db: Database.Database): EdgeExistence {
  const stmt = db.prepare(`SELECT 1 FROM edge WHERE src = ? AND rel = ? AND dst = ?`);
  return { has: (src, rel, dst) => stmt.get(src, rel, dst) !== undefined };
}

/** oracle → the gold seed with mass 1; e2e → hybrid top-N ids with their cosine (floored at 0.01 so BM25-only hits still seed). */
export function resolveSeeds(input: ProbeInput, ctx: ArmContext): Map<string, number> {
  if (input.mode === 'oracle') return new Map([[input.probe.seed.id, 1]]);
  const hits = ctx.engine.retrieveRanked(input.queryVec, ctx.e2eSeedK, 0, input.probe.query);
  const seeds = new Map<string, number>();
  for (const h of hits) seeds.set(h.id, Math.max(0.01, h.score));
  return seeds;
}

const timed = (fn: () => { rankedIds: string[]; nodesExpanded: number; paths?: ArmResult['paths'] }): ArmResult => {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ...r, latencyMs };
};

const cosineArm: Arm = {
  name: 'cosine',
  usesSeeds: false,
  run: (input, ctx) => timed(() => {
    const hits = ctx.retriever.topk(input.queryVec, ctx.k + 1).filter(h => h.id !== input.probe.seed.id);
    return { rankedIds: hits.slice(0, ctx.k).map(h => h.id), nodesExpanded: 0 };
  }),
};

const hybridArm: Arm = {
  name: 'hybrid',
  usesSeeds: false,
  run: (input, ctx) => timed(() => {
    const hits = ctx.engine
      .retrieveRanked(input.queryVec, ctx.k + 1, ctx.floor, input.probe.query)
      .filter(h => h.id !== input.probe.seed.id);
    return { rankedIds: hits.slice(0, ctx.k).map(h => h.id), nodesExpanded: 0 };
  }),
};

const typedArm: Arm = {
  name: 'typed',
  usesSeeds: true,
  run: (input, ctx) => {
    const [s1, s2] = input.probe.path;
    if (s1.dir !== 'fwd' || s2.dir !== 'fwd' || !PRED_SET.has(s1.rel) || !PRED_SET.has(s2.rel)) return null;
    const seeds = Array.from(resolveSeeds(input, ctx).keys());
    return timed(() => {
      const ids = typedReach(ctx.store, seeds, [s1.rel, s2.rel], ctx.k).filter(id => id !== input.probe.seed.id);
      return { rankedIds: ids, nodesExpanded: ids.length };
    });
  },
};

const pprExactArm: Arm = {
  name: 'ppr-exact',
  usesSeeds: true,
  run: (input, ctx) => timed(() => {
    const seeds = resolveSeeds(input, ctx);
    const scores = pprExact(ctx.adjacency, seeds);
    let touched = 0;
    for (let i = 0; i < scores.length; i++) if (scores[i]! > 0) touched++;
    const exclude = new Set([...seeds.keys(), input.probe.seed.id]);
    return { rankedIds: rankFromScores(ctx.adjacency, scores, exclude, ctx.k), nodesExpanded: touched };
  }),
};

export const ARMS: Arm[] = [cosineArm, hybridArm, typedArm, pprExactArm];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge-arms.test.ts`
Expected: PASS (5 tests). If `typedReach`'s anchor parameter rejects an array, check its signature at `src/recall/typed-traversal.ts:51` (`anchor: string | string[]`).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/eval/bridge-arms.ts tests/bridge-arms.test.ts
git commit -m "feat(eval): pluggable retrieval arms (cosine, hybrid, typed, ppr-exact)"
```

---

### Task 5: Probe miner CLI

Mines bridge probes from a read-only DB snapshot. Query = seed value; terminal must be a live fact with zero token overlap and cosine < 0.5 to the seed (both from stored embeddings), reachable by exactly two eligible edges with no direct seed↔terminal edge.

**Files:**
- Create: `scripts/eval/derive-bridge-probes.cjs`
- Modify: `.gitignore` (append two lines)
- Modify: `package.json` scripts (add `eval:bridge:derive`)

**Interfaces:**
- Consumes: `dist/src/eval/bridge-probes.js` (`COSINE_CEILING`, `isLexicallyDisjoint`, `dilutionTier`, `roundRobinSample`), `dist/src/eval/ppr-reference.js` (`eligibleWeight`), `dist/src/retrieval/topk.js` (`cosineSimF32`), `dist/src/eval/bridge-arms.js` (`readEmbedding`), `dist/src/lib/hash.js` (`sha256`).
- Produces: `scripts/eval/cases/bridge-probes.json` in the `ProbeSet` shape from Task 1.

- [ ] **Step 1: Create the DB snapshot (one-time, never committed)**

Run: `mkdir -p scripts/eval/fixtures && sqlite3 "$HOME/.config/recense/recense.db" ".backup scripts/eval/fixtures/bridge-snapshot.db" && sqlite3 scripts/eval/fixtures/bridge-snapshot.db "SELECT COUNT(*) FROM node WHERE tombstoned=0"`
Expected: a count in the tens of thousands (≈29k). Stop and report if the live DB path does not exist.

- [ ] **Step 2: Append to `.gitignore`**

```
scripts/eval/fixtures/bridge-snapshot.db*
scripts/eval/cases/bridge-probes.json
```

- [ ] **Step 3: Write the miner**

```js
#!/usr/bin/env node
/**
 * Bridge-probe miner (graph-aware recall Phase 1, spec §5).
 *
 * Mines real seed → bridge → terminal paths from a READ-ONLY recense.db snapshot where the
 * terminal is a live fact that shares no content tokens with the seed value and sits below
 * COSINE_CEILING to it (both from stored embeddings — no API calls). Query text = seed value.
 *
 * Usage: npm run build && node scripts/eval/derive-bridge-probes.cjs --db scripts/eval/fixtures/bridge-snapshot.db [--out scripts/eval/cases/bridge-probes.json] [--target 60]
 *
 * Golds are real reachable nodes (no-inflated-metrics). Output is gitignored: it contains
 * personal-graph values. _meta.founder_signoff starts PENDING.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { COSINE_CEILING, isLexicallyDisjoint, dilutionTier, roundRobinSample } = require('../../dist/src/eval/bridge-probes');
const { eligibleWeight } = require('../../dist/src/eval/ppr-reference');
const { readEmbedding } = require('../../dist/src/eval/bridge-arms');
const { cosineSimF32 } = require('../../dist/src/retrieval/topk');
const { sha256 } = require('../../dist/src/lib/hash');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DB_PATH = arg('--db', null);
const OUT = arg('--out', path.resolve(__dirname, 'cases/bridge-probes.json'));
const TARGET = parseInt(arg('--target', '60'), 10);
const MAX_SEED_LEN = 200;
const MAX_TERM_LEN = 240;

if (!DB_PATH || !fs.existsSync(DB_PATH)) {
  console.error('ERROR: --db <snapshot path> is required and must exist (never point this at the live DB).');
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

// Undirected edge view with direction tag; both hops restricted to relation/abstracts kinds.
const candidates = db.prepare(`
  WITH u AS (
    SELECT src AS a, dst AS b, rel, kind, 'fwd' AS dir FROM edge WHERE kind IN ('relation','abstracts')
    UNION ALL
    SELECT dst AS a, src AS b, rel, kind, 'rev' AS dir FROM edge WHERE kind IN ('relation','abstracts')
  )
  SELECT s.id AS seed_id, s.type AS seed_type, s.value AS seed_value,
         b.id AS bridge_id, b.type AS bridge_type, b.value AS bridge_value,
         t.id AS term_id, t.value AS term_value,
         e1.rel AS rel1, e1.kind AS kind1, e1.dir AS dir1,
         e2.rel AS rel2, e2.kind AS kind2, e2.dir AS dir2,
         (SELECT COUNT(*) FROM edge o WHERE o.src = s.id) AS seed_outdeg
  FROM u e1
  JOIN u e2 ON e1.b = e2.a
  JOIN node s ON s.id = e1.a
  JOIN node b ON b.id = e1.b
  JOIN node t ON t.id = e2.b
  WHERE s.tombstoned = 0 AND b.tombstoned = 0 AND t.tombstoned = 0
    AND t.type = 'fact' AND s.type IN ('fact','entity')
    AND s.id <> t.id AND s.id <> b.id AND b.id <> t.id
    AND s.embedding IS NOT NULL AND t.embedding IS NOT NULL
    AND LENGTH(s.value) <= ${MAX_SEED_LEN} AND LENGTH(t.value) <= ${MAX_TERM_LEN}
    AND NOT EXISTS (
      SELECT 1 FROM edge d WHERE (d.src = s.id AND d.dst = t.id) OR (d.src = t.id AND d.dst = s.id)
    )
`).all();
console.error(`raw 2-hop candidates: ${candidates.length}`);

// Global out-degree terciles over live nodes with >=1 out-edge (queries-37 dilution precedent).
const degs = db.prepare(`SELECT COUNT(*) AS d FROM edge e JOIN node n ON n.id = e.src WHERE n.tombstoned = 0 GROUP BY e.src ORDER BY d`).all().map(r => r.d);
const terciles = [degs[Math.floor(degs.length / 3)] ?? 1, degs[Math.floor((2 * degs.length) / 3)] ?? 2];

// Cheap filters first (eligibility + lexical), then a deterministic shuffle, then lazy cosine.
const lexOk = candidates.filter(c =>
  eligibleWeight(c.kind1, c.rel1, c.dir1) > 0 &&
  eligibleWeight(c.kind2, c.rel2, c.dir2) > 0 &&
  isLexicallyDisjoint(c.seed_value, c.term_value),
);
console.error(`after eligibility + lexical disjointness: ${lexOk.length}`);

const embCache = new Map();
const emb = id => { if (!embCache.has(id)) embCache.set(id, readEmbedding(db, id)); return embCache.get(id); };

const seen = new Set();
const enriched = [];
for (const c of lexOk) {
  const pairKey = `${c.seed_id}|${c.term_id}`;
  if (seen.has(pairKey)) continue; // one path variant per (seed, terminal) pair
  seen.add(pairKey);
  const dilution = dilutionTier(c.seed_outdeg, terciles);
  enriched.push({ ...c, dilution, stratum: `${c.bridge_type}:${dilution}`, sortKey: sha256(pairKey) });
}

// Draw more than TARGET so the cosine filter has headroom, then apply cosine lazily.
const drawn = roundRobinSample(enriched, TARGET * 4, c => c.sortKey);
const accepted = [];
const strata = {};
for (const c of drawn) {
  if (accepted.length >= TARGET) break;
  const cos = cosineSimF32(emb(c.seed_id), emb(c.term_id));
  if (!(cos < COSINE_CEILING)) continue;
  strata[c.stratum] = (strata[c.stratum] ?? 0) + 1;
  accepted.push({
    id: `bp${String(accepted.length + 1).padStart(3, '0')}`,
    query: c.seed_value,
    seed: { id: c.seed_id, type: c.seed_type, value: c.seed_value },
    bridge: { id: c.bridge_id, type: c.bridge_type, value: c.bridge_value },
    terminal: { id: c.term_id, type: 'fact', value: c.term_value },
    path: [
      { src: c.seed_id, rel: c.rel1, kind: c.kind1, dir: c.dir1, dst: c.bridge_id },
      { src: c.bridge_id, rel: c.rel2, kind: c.kind2, dir: c.dir2, dst: c.term_id },
    ],
    seed_outdeg: c.seed_outdeg,
    dilution: c.dilution,
    stratum: c.stratum,
    cosine_seed_terminal: Number(cos.toFixed(4)),
  });
}

const out = {
  _meta: {
    db_source: DB_PATH,
    generated_at: new Date().toISOString(),
    total: accepted.length,
    strata,
    founder_signoff: 'PENDING',
    cosine_ceiling: COSINE_CEILING,
  },
  probes: accepted,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`accepted ${accepted.length}/${TARGET} probes; strata: ${JSON.stringify(strata)}`);
if (accepted.length < TARGET) console.error(`NOTE: supply below target — ${drawn.length} drawn, cosine ceiling ${COSINE_CEILING} rejected the rest. Not a silent cap.`);
console.log(OUT);
```

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, after `"eval:recall-gate"`, add:

```json
"eval:bridge:derive": "npm run build && node scripts/eval/derive-bridge-probes.cjs --db scripts/eval/fixtures/bridge-snapshot.db",
```

- [ ] **Step 5: Run the miner against the snapshot**

Run: `npm run eval:bridge:derive`
Expected: stderr shows candidate counts shrinking through each filter and `accepted N/60 probes`; stdout prints the output path; `scripts/eval/cases/bridge-probes.json` exists with `_meta.total === N`. Stop and report if `N < 20` — the graph may need a looser `COSINE_CEILING` or a third eligible kind, and that is a spec decision, not an executor call.

- [ ] **Step 6: Sanity-check three probes by hand**

Run: `node -e "const p=require('./scripts/eval/cases/bridge-probes.json');for(const b of p.probes.slice(0,3))console.log(b.id,'|',b.query.slice(0,60),'->',b.bridge.value.slice(0,40),'->',b.terminal.value.slice(0,60),'| cos',b.cosine_seed_terminal)"`
Expected: three readable chains where the terminal plausibly relates through the bridge but shares no words with the query.

- [ ] **Step 7: Commit (the probes file itself is gitignored)**

```bash
git add scripts/eval/derive-bridge-probes.cjs .gitignore package.json
git commit -m "feat(eval): bridge-probe miner over a read-only graph snapshot"
```

---

### Task 6: Harness CLI, abstention probes, baseline run

**Files:**
- Create: `scripts/eval/bridge-harness.cjs`
- Create: `scripts/eval/cases/abstention-probes.json`
- Create: `scripts/eval/BRIDGE-EVAL.md`
- Modify: `package.json` scripts (add `eval:bridge`)
- Test: `tests/bridge-harness-smoke.test.ts`

**Interfaces:**
- Consumes: `ARMS`, `readEmbedding`, `edgeExistence` (Task 4); `scoreProbe`, `aggregate` (Task 2); `loadAdjacency` (Task 3); `loadMergedConfig` from `dist/src/adapter/settings-loader`; engine collaborators as in `src/eval/snapshot.ts:135-139`.
- Produces: results envelope `scripts/eval/results/bridge-<commit>.json`:
  ```
  { meta: { eval:'bridge-probes', date, sut_commit, db_source, probes_total, founder_signoff, k, floor, e2e_seed_k, sut_config:{bm25FusionWeight, rankStrengthWeight, lambda, spreadDecay, rankedRetrievalFloor} },
    scores: { oracle: { [arm]: ArmAggregate|null }, e2e: { [arm]: ArmAggregate|null }, delta_vs_hybrid: { oracle: {[arm]: {r10, mrr}}, e2e: {...} },
              abstention: { [arm]: { n, false_positive_rate } } },
    per_probe: [ { id, mode, arm, ...ProbeScore } ] }   // ids and numbers only — no node values
  ```

- [ ] **Step 1: Write the abstention probe file**

Abstention probes are out-of-domain queries with no gold; the metric is the rate at which an arm returns *anything* above the floor (hybrid/cosine) or any associative candidate (seed-based arms with empty seeds). They need query vectors, which the harness embeds via `OpenAIEmbedder` **only when `--embed-abstention` is passed** and caches into `scripts/eval/fixtures/abstention-embeddings.json` (committed; keyed by model+dims). Without the cache file the abstention block is reported as `null`, never fabricated.

```json
{
  "_meta": { "note": "Out-of-domain queries; expected: nothing above floor. Vectors cached separately by --embed-abstention." },
  "probes": [
    { "id": "ab01", "query": "melting point of tungsten carbide under vacuum" },
    { "id": "ab02", "query": "how to repot an orchid after flowering" },
    { "id": "ab03", "query": "rules of curling scoring in the final end" },
    { "id": "ab04", "query": "history of the Hanseatic League trade routes" },
    { "id": "ab05", "query": "recipe for sourdough starter with rye flour" },
    { "id": "ab06", "query": "tidal locking of exoplanets around red dwarfs" },
    { "id": "ab07", "query": "medieval falconry training techniques" },
    { "id": "ab08", "query": "differences between baroque and classical counterpoint" },
    { "id": "ab09", "query": "maintenance schedule for a two-stroke outboard motor" },
    { "id": "ab10", "query": "symptoms of iron chlorosis in citrus trees" },
    { "id": "ab11", "query": "origin of the Basque language" },
    { "id": "ab12", "query": "how glaciers form moraines" },
    { "id": "ab13", "query": "care instructions for cast iron cookware seasoning" },
    { "id": "ab14", "query": "scoring a perfect game in ten-pin bowling" },
    { "id": "ab15", "query": "knitting a cable pattern with circular needles" },
    { "id": "ab16", "query": "migration patterns of arctic terns" },
    { "id": "ab17", "query": "restoring a vintage mechanical typewriter platen" },
    { "id": "ab18", "query": "difference between sake and shochu brewing" },
    { "id": "ab19", "query": "how to read a nautical chart depth sounding" },
    { "id": "ab20", "query": "pruning espalier apple trees in winter" }
  ]
}
```

- [ ] **Step 2: Write the harness**

```js
#!/usr/bin/env node
/**
 * Bridge-probe harness (graph-aware recall Phase 1, spec §5).
 *
 * Runs every retrieval arm over every bridge probe in oracle-seed and end-to-end modes on a
 * READ-ONLY DB snapshot, scores retrieval recall (never answer quality), reports graph-off
 * deltas vs the `hybrid` arm on every run, and writes the house results envelope.
 * Zero LLM/embedding calls: query vectors are the seeds' stored embeddings.
 *
 * Usage:
 *   npm run build && node scripts/eval/bridge-harness.cjs --run --db scripts/eval/fixtures/bridge-snapshot.db [--probes scripts/eval/cases/bridge-probes.json] [--mode oracle|e2e|both] [--k 10] [--floor 0.3] [--e2e-seed-k 10] [--out scripts/eval/results/bridge-<commit>.json]
 *   OPENAI_API_KEY=... node scripts/eval/bridge-harness.cjs --embed-abstention   # one-time cache of abstention query vectors
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const { realClock } = require('../../dist/src/lib/clock');
const { loadMergedConfig } = require('../../dist/src/adapter/settings-loader');
const { SemanticStore } = require('../../dist/src/db/semantic-store');
const { CandidateRetriever } = require('../../dist/src/retrieval/topk');
const { StrengthDecayManager } = require('../../dist/src/strength/decay');
const { AllocationGate } = require('../../dist/src/gate/allocation-gate');
const { RetrievalEngine } = require('../../dist/src/retrieval/engine');
const { ARMS, readEmbedding, edgeExistence } = require('../../dist/src/eval/bridge-arms');
const { scoreProbe, aggregate } = require('../../dist/src/eval/bridge-metrics');
const { loadAdjacency } = require('../../dist/src/eval/ppr-reference');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const RUN = process.argv.includes('--run');
const EMBED_ABSTENTION = process.argv.includes('--embed-abstention');
const DB_PATH = arg('--db', 'scripts/eval/fixtures/bridge-snapshot.db');
const PROBES = arg('--probes', 'scripts/eval/cases/bridge-probes.json');
const ABSTENTION = path.resolve(__dirname, 'cases/abstention-probes.json');
const ABSTENTION_CACHE = path.resolve(__dirname, 'fixtures/abstention-embeddings.json');
const MODE = arg('--mode', 'both');
const K = parseInt(arg('--k', '10'), 10);
const FLOOR = parseFloat(arg('--floor', '0.3'));
const E2E_SEED_K = parseInt(arg('--e2e-seed-k', '10'), 10);
let COMMIT = 'unknown';
try { COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const OUT = arg('--out', path.resolve(__dirname, `results/bridge-${COMMIT}.json`));

if (!RUN && !EMBED_ABSTENTION) {
  console.error('Usage: bridge-harness.cjs --run --db <snapshot> [--probes ...] [--mode oracle|e2e|both] [--k N] [--floor F] [--out ...]\n       bridge-harness.cjs --embed-abstention   (requires OPENAI_API_KEY)');
  process.exit(1);
}

// ---- one-time abstention vector cache -------------------------------------
if (EMBED_ABSTENTION) {
  if (!process.env.OPENAI_API_KEY) { console.error('ERROR: OPENAI_API_KEY required for --embed-abstention'); process.exit(1); }
  const { OpenAIEmbedder } = require('../../dist/src/model/embedder');
  const cfg = loadMergedConfig(DB_PATH);
  const set = JSON.parse(fs.readFileSync(ABSTENTION, 'utf8'));
  (async () => {
    const embedder = new OpenAIEmbedder(cfg.openaiEmbedModel, cfg.embeddingDimensions);
    const vecs = await embedder.embed(set.probes.map(p => p.query));
    const cache = { _meta: { model: cfg.openaiEmbedModel, dims: cfg.embeddingDimensions }, vectors: {} };
    set.probes.forEach((p, i) => { cache.vectors[p.id] = Array.from(vecs[i]); });
    fs.writeFileSync(ABSTENTION_CACHE, JSON.stringify(cache));
    console.log(`cached ${set.probes.length} abstention vectors → ${ABSTENTION_CACHE}`);
  })().catch(e => { console.error(e); process.exit(1); });
  return;
}

// ---- run ------------------------------------------------------------------
if (!fs.existsSync(DB_PATH)) { console.error(`ERROR: snapshot not found: ${DB_PATH}`); process.exit(1); }
if (!fs.existsSync(PROBES)) { console.error(`ERROR: probe set not found: ${PROBES} (run npm run eval:bridge:derive)`); process.exit(1); }

const db = new Database(DB_PATH, { readonly: true });
const config = loadMergedConfig(DB_PATH);
const store = new SemanticStore(db, realClock, config);
const retriever = new CandidateRetriever(db);
const strength = new StrengthDecayManager(db, realClock, config);
const gate = new AllocationGate(config);
const engine = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate);
const ctx = { db, store, retriever, engine, adjacency: loadAdjacency(db), k: K, floor: FLOOR, e2eSeedK: E2E_SEED_K };
const edges = edgeExistence(db);
const probeSet = JSON.parse(fs.readFileSync(PROBES, 'utf8'));
const modes = MODE === 'both' ? ['oracle', 'e2e'] : [MODE];

const perProbe = [];
const buckets = {}; // mode -> arm -> ProbeScore[]
let skippedNoEmbedding = 0;
for (const mode of modes) {
  buckets[mode] = {};
  for (const arm of ARMS) buckets[mode][arm.name] = [];
  for (const probe of probeSet.probes) {
    const queryVec = readEmbedding(db, probe.seed.id);
    if (!queryVec) { skippedNoEmbedding++; continue; }
    for (const arm of ARMS) {
      const res = arm.run({ probe, queryVec, mode }, ctx);
      if (res === null) continue; // arm not applicable to this probe (e.g. typed on non-typed path)
      const s = scoreProbe(res, probe.terminal.id, probe.bridge.id, edges);
      buckets[mode][arm.name].push(s);
      perProbe.push({ id: probe.id, mode, arm: arm.name, ...s });
    }
    process.stdout.write('.');
  }
}
process.stdout.write('\n');
if (skippedNoEmbedding > 0) console.error(`skipped ${skippedNoEmbedding} probe(s) whose seed embedding is missing in this snapshot`);

const scores = {};
const delta = {};
for (const mode of modes) {
  scores[mode] = {};
  delta[mode] = {};
  for (const arm of ARMS) {
    const list = buckets[mode][arm.name];
    scores[mode][arm.name] = list.length === 0 ? null : aggregate(list);
  }
  const base = scores[mode].hybrid;
  for (const arm of ARMS) {
    const a = scores[mode][arm.name];
    delta[mode][arm.name] = a && base ? { r10: +(a.r10 - base.r10).toFixed(4), mrr: +(a.mrr - base.mrr).toFixed(4) } : null;
  }
}

// ---- abstention (only if the vector cache exists and matches the config) ---
let abstention = null;
if (fs.existsSync(ABSTENTION_CACHE)) {
  const cache = JSON.parse(fs.readFileSync(ABSTENTION_CACHE, 'utf8'));
  if (cache._meta.model !== config.openaiEmbedModel || cache._meta.dims !== config.embeddingDimensions) {
    console.error('abstention cache model/dims mismatch — rerun --embed-abstention; reporting abstention as null');
  } else {
    const set = JSON.parse(fs.readFileSync(ABSTENTION, 'utf8'));
    abstention = {};
    for (const arm of ARMS) {
      let fp = 0, n = 0;
      for (const p of set.probes) {
        const vec = Float32Array.from(cache.vectors[p.id]);
        const fake = { id: p.id, query: p.query, seed: { id: '__none__', type: 'fact', value: p.query }, bridge: { id: '__none__', type: 'fact', value: '' }, terminal: { id: '__none__', type: 'fact', value: '' }, path: [{ src: '', rel: '', kind: '', dir: 'fwd', dst: '' }, { src: '', rel: '', kind: '', dir: 'fwd', dst: '' }], seed_outdeg: 0, dilution: 'lo', stratum: '', cosine_seed_terminal: 0 };
        const res = arm.run({ probe: fake, queryVec: vec, mode: 'e2e' }, ctx);
        if (res === null) continue;
        n++;
        if (res.rankedIds.length > 0) fp++;
      }
      abstention[arm.name] = n === 0 ? null : { n, false_positive_rate: +(fp / n).toFixed(4) };
    }
  }
} else {
  console.error('no abstention vector cache — abstention block reported as null (run --embed-abstention once)');
}

const envelope = {
  meta: {
    eval: 'bridge-probes',
    date: new Date().toISOString().slice(0, 10),
    sut_commit: COMMIT,
    db_source: probeSet._meta.db_source,
    probes_total: probeSet.probes.length,
    founder_signoff: probeSet._meta.founder_signoff,
    k: K, floor: FLOOR, e2e_seed_k: E2E_SEED_K,
    sut_config: {
      bm25FusionWeight: config.bm25FusionWeight,
      rankStrengthWeight: config.rankStrengthWeight,
      lambda: config.lambda,
      spreadDecay: config.spreadDecay,
      rankedRetrievalFloor: config.rankedRetrievalFloor,
    },
  },
  scores: { ...scores, delta_vs_hybrid: delta, abstention },
  per_probe: perProbe,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(envelope, null, 2));

// ---- console report ---------------------------------------------------------
for (const mode of modes) {
  console.log(`\n== ${mode} (k=${K}, floor=${FLOOR}) ==`);
  console.log('arm         n    r@5    r@10   r@20   bridge@10  MRR    p50ms  p95ms  Δr10 vs hybrid');
  for (const arm of ARMS) {
    const a = scores[mode][arm.name];
    if (!a) { console.log(`${arm.name.padEnd(11)} n/a`); continue; }
    const d = delta[mode][arm.name];
    console.log(`${arm.name.padEnd(11)} ${String(a.n).padEnd(4)} ${a.r5.toFixed(3)}  ${a.r10.toFixed(3)}  ${a.r20.toFixed(3)}  ${a.bridge_r10.toFixed(3)}      ${a.mrr.toFixed(3)}  ${a.latency_p50.toFixed(1).padEnd(6)} ${a.latency_p95.toFixed(1).padEnd(6)} ${d ? (d.r10 >= 0 ? '+' : '') + d.r10.toFixed(3) : '-'}`);
  }
}
if (abstention) {
  console.log('\n== abstention (false-positive rate over out-of-domain queries) ==');
  for (const arm of ARMS) { const a = abstention[arm.name]; console.log(`${arm.name.padEnd(11)} ${a ? a.false_positive_rate.toFixed(3) : 'n/a'}`); }
}
console.log(`\nresults → ${OUT}`);
```

- [ ] **Step 3: Add the npm script**

In `package.json` `scripts`, after `"eval:bridge:derive"`, add:

```json
"eval:bridge": "npm run build && node scripts/eval/bridge-harness.cjs --run --db scripts/eval/fixtures/bridge-snapshot.db",
```

- [ ] **Step 4: Write the smoke test (scratch DB, spawns the harness)**

```ts
// tests/bridge-harness-smoke.test.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { hasDistEntries, distSkipReason } from './support/dist-build';

const DIST = ['dist/src/eval/bridge-arms.js', 'dist/src/adapter/settings-loader.js'];
const SKIP = !hasDistEntries(...DIST);

describe.skipIf(SKIP)('bridge-harness.cjs smoke', () => {
  it('runs both modes on a scratch DB and writes the envelope (ids only, no values)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-smoke-'));
    const dbPath = path.join(dir, 'snap.db');
    const db = new Database(dbPath);
    initSchema(db);
    const store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), { ...DEFAULT_CONFIG, dbPath });
    const vec = (i: number) => { const v = new Float32Array(16); v[i] = 1; return v; };
    const add = (id: string, value: string, i: number, type: 'fact' | 'entity' = 'fact') => {
      store.upsertNode({ id, type, value, origin: 'observed', s: 0.5 }); store.setEmbedding(id, vec(i));
    };
    add('seed', 'urby-www deploys to Cloudflare Pages', 0);
    add('bridge', 'Cloudflare', 1, 'entity');
    add('term', 'the dashboard custom domain attachment is locked', 2);
    store.upsertEdge({ src: 'seed', dst: 'bridge', rel: 'runs_on', w: 0.1, kind: 'relation' });
    store.upsertEdge({ src: 'bridge', dst: 'term', rel: 'extends', w: 0.1, kind: 'relation' });
    db.close();

    const probes = path.join(dir, 'probes.json');
    fs.writeFileSync(probes, JSON.stringify({
      _meta: { db_source: dbPath, generated_at: 'test', total: 1, strata: { 'entity:lo': 1 }, founder_signoff: 'test', cosine_ceiling: 0.5 },
      probes: [{
        id: 'bp001', query: 'urby-www deploys to Cloudflare Pages',
        seed: { id: 'seed', type: 'fact', value: 'urby-www deploys to Cloudflare Pages' },
        bridge: { id: 'bridge', type: 'entity', value: 'Cloudflare' },
        terminal: { id: 'term', type: 'fact', value: 'the dashboard custom domain attachment is locked' },
        path: [
          { src: 'seed', rel: 'runs_on', kind: 'relation', dir: 'fwd', dst: 'bridge' },
          { src: 'bridge', rel: 'extends', kind: 'relation', dir: 'fwd', dst: 'term' },
        ],
        seed_outdeg: 1, dilution: 'lo', stratum: 'entity:lo', cosine_seed_terminal: 0,
      }],
    }));
    const out = path.join(dir, 'out.json');
    const r = spawnSync(process.execPath, [
      'scripts/eval/bridge-harness.cjs', '--run', '--db', dbPath, '--probes', probes, '--out', out, '--mode', 'both',
    ], { encoding: 'utf8', env: { ...process.env, HOME: dir } }); // HOME=dir → no user settings.json → DEFAULT_CONFIG
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(env.scores.oracle['ppr-exact'].r10).toBe(1);
    expect(env.scores.oracle.hybrid.r10).toBe(0);
    expect(env.scores.delta_vs_hybrid.oracle['ppr-exact'].r10).toBe(1);
    expect(env.scores.abstention).toBeNull();
    expect(JSON.stringify(env.per_probe)).not.toContain('Cloudflare');
  }, 60_000);

  it.skipIf(!SKIP)('skipped: ' + distSkipReason(...DIST), () => {});
});
```

- [ ] **Step 5: Build and run the smoke test**

Run: `npm run build && npx vitest run tests/bridge-harness-smoke.test.ts`
Expected: PASS. If `loadMergedConfig` still picks up the real user settings, check `defaultSettingsPath()` in `src/adapter/settings-loader.ts:38` for the env var it honours and set that instead of `HOME`.

- [ ] **Step 6: Run the real baseline**

Run: `npm run eval:bridge`
Expected: the console table for `oracle` and `e2e`; `hybrid` r@10 should be low (that is the whole premise — terminals were mined to be below the cosine ceiling) and `ppr-exact` should be materially higher. Record the numbers. Stop and report if `ppr-exact` r@10 in oracle mode is not above `hybrid` — that would mean the miner or the PPR reference has a bug, not that the design is wrong.

- [ ] **Step 7: Write `scripts/eval/BRIDGE-EVAL.md`**

```markdown
# Bridge-probe eval (graph-aware recall)

Measures associative recall: can retrieval reach a fact that is 2 edges from the query's
seed but shares no words and low cosine with it? Spec: docs/superpowers/specs/2026-08-26-graph-aware-recall-design.md §5.

## One-time setup
1. Snapshot the live DB (never run against it directly):
   `sqlite3 ~/.config/recense/recense.db ".backup scripts/eval/fixtures/bridge-snapshot.db"`
2. Mine probes (gitignored — personal-graph values): `npm run eval:bridge:derive`
3. Review `scripts/eval/cases/bridge-probes.json`, then set `_meta.founder_signoff`.
4. Optional, once: `OPENAI_API_KEY=... node scripts/eval/bridge-harness.cjs --embed-abstention`

## Run
`npm run eval:bridge` → `scripts/eval/results/bridge-<commit>.json` + console table.

Modes: `oracle` (gold seed handed to seed-based arms — propagation quality in isolation),
`e2e` (seeds come from hybrid top-N — the product path). Arms: `cosine`, `hybrid` (graph-off
baseline; every run reports Δ vs it), `typed` (oracle upper bound, null on non-typed paths),
`ppr-exact` (reference / Phase 2 oracle). Phase 2 adds `spread-*` arms in `src/eval/bridge-arms.ts`.

Metrics are retrieval recall only (r@5/10/20, bridge@10, MRR, path-validity when an arm returns
paths, nodes expanded, p50/p95 latency). No LLM, no embedding calls: query vectors are stored seed
embeddings, so the seed is trivially retrievable — the suite measures propagation, not seeding.
Paraphrased-query probes are deferred.

Results files contain node ids and numbers only.
```

- [ ] **Step 8: Commit code, docs, and the baseline results file**

```bash
git add scripts/eval/bridge-harness.cjs scripts/eval/cases/abstention-probes.json scripts/eval/BRIDGE-EVAL.md tests/bridge-harness-smoke.test.ts package.json scripts/eval/results/bridge-*.json
git commit -m "feat(eval): bridge-probe harness with graph-off baseline and exact-PPR reference"
```

- [ ] **Step 9: Full verification**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass (the five new files plus the existing suite).

---

## Self-review notes

- Spec §5 coverage: bridge probes (T5), single-hop regression set — **reuses the existing `queries-37.json` typed single-hop set rather than building a second one**; running it stays `npm run` of `37-precision-harness.cjs` and is not duplicated here. Abstention (T6), oracle-seed vs e2e modes (T4/T6), retrieval-recall metrics (T2), matched-budget arms incl. exact PPR (T3/T4), graph-off delta every run (T6), latency p50/p95 (T2/T6), exact-PPR oracle for Phase 2 (T3 — the overlap@10 assertion against the production pass is written in Phase 2 when that pass exists). Deferred by design: paraphrased-query probes, context-token accounting (no composed context exists in Phase 1).
- Type consistency: `ArmResult`/`ProbeScore`/`EdgeExistence` defined in T2, consumed unchanged in T4/T6; `BridgeProbe.path` is a 2-tuple everywhere; `ArmContext` fields match between T4 and the harness.
