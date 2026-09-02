/** Retrieval-recall metrics for bridge probes (spec §5). Retrieval recall is primary; no answer scoring here. */

export interface ArmResult {
  rankedIds: string[];
  /** Walk-order steps; dir (optional, default 'fwd') says whether the stored edge is src→dst or dst→src. */
  paths?: Map<string, Array<{ src: string; rel: string; dst: string; dir?: 'fwd' | 'rev' }>>;
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
    path_valid = path.length > 0 && path.every(st =>
      st.dir === 'rev' ? edges.has(st.dst, st.rel, st.src) : edges.has(st.src, st.rel, st.dst));
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
