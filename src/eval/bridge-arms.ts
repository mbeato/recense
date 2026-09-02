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
