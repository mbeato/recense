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

/** One traversal step: src→dst is walk order; dir says whether the stored edge is src→dst ('fwd') or dst→src ('rev'). */
export interface PathStep { src: string; rel: string; dst: string; dir: 'fwd' | 'rev' }
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
    const pushOut = (from: string, to: string, w: number, rel: string, dir: 'fwd' | 'rev') => {
      if (w <= 0) return;
      let l = outLists.get(from);
      if (!l) { l = []; outLists.set(from, l); }
      l.push({ to, w, step: { src: from, rel, dst: to, dir } });
    };
    for (const e of edges) {
      if (frontier.has(e.src)) pushOut(e.src, e.dst, relWeight(params, e.kind, e.rel, 'fwd') * e.w, e.rel, 'fwd');
      if (frontier.has(e.dst)) pushOut(e.dst, e.src, relWeight(params, e.kind, e.rel, 'rev') * e.w, e.rel, 'rev');
    }

    // One batched liveness check for every transfer target this hop.
    const targetIds = new Set<string>();
    for (const l of outLists.values()) for (const t of l) targetIds.add(t.to);
    const live = reader.liveIds(Array.from(targetIds).sort());

    // Aggregate gains for the whole hop, then prune to frontierCap.
    const gained = new Map<string, FrontierEntry>();
    const bestContrib = new Map<string, number>();
    for (const u of frontierIds) {
      const entry = frontier.get(u)!;
      const list = outLists.get(u);
      if (!list) continue;
      list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
      const eligible = list.filter(t => live.has(t.to) && !seeds.has(t.to) && !entry.pathNodes.has(t.to));
      let outMass = 0;
      for (const t of eligible) outMass += t.w;
      const denom = Math.pow(outMass, params.fanExponent);
      if (denom <= 0) continue;
      for (const t of eligible) {
        const contrib = entry.mass * params.damping * (t.w / denom);
        if (contrib < params.activationFloor) continue;

        let b = books.get(t.to);
        if (!b) { b = { activation: 0, hopDepth: h, candidates: [] }; books.set(t.to, b); }
        b.activation += contrib;
        b.candidates.push({ path: [...entry.path, t.step], contrib });

        const g = gained.get(t.to);
        const path = [...entry.path, t.step];
        const pathNodes = new Set([...entry.pathNodes, t.to]);
        if (!g) {
          gained.set(t.to, { mass: contrib, path, pathNodes });
          bestContrib.set(t.to, contrib);
        } else {
          g.mass += contrib;
          if (contrib > bestContrib.get(t.to)!) {
            g.path = path;
            g.pathNodes = pathNodes;
            bestContrib.set(t.to, contrib);
          }
        }
      }
    }

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
