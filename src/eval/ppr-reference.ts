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
    if (s === undefined || d === undefined) continue;
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
  const alpha = opts.damping ?? 0.5;
  const iterations = opts.iterations ?? 40;
  const n = adj.ids.length;
  const restart = new Float64Array(n);
  let seedMass = 0;
  for (const [id, m] of seeds) {
    const i = adj.index.get(id);
    if (i !== undefined && m > 0) { restart[i] = restart[i]! + m; seedMass += m; }
  }
  if (seedMass === 0) return new Float64Array(n);
  for (let i = 0; i < n; i++) restart[i] = restart[i]! / seedMass;

  const outMass = new Float64Array(n);
  for (let u = 0; u < n; u++) for (const e of adj.out[u]!) outMass[u] = outMass[u]! + e.w;

  let p = Float64Array.from(restart);
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let u = 0; u < n; u++) {
      const pu = p[u]!;
      if (pu === 0) continue;
      if (outMass[u] === 0) { dangling += pu; continue; }
      const scale = (alpha * pu) / outMass[u]!;
      for (const e of adj.out[u]!) next[e.to] = next[e.to]! + scale * e.w;
    }
    const restartShare = 1 - alpha + alpha * dangling;
    for (let i = 0; i < n; i++) next[i] = next[i]! + restartShare * restart[i]!;
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
