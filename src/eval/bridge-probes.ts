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
