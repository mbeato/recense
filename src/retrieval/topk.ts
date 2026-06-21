/**
 * CandidateRetriever — brute-force cosine top-k over non-null node embeddings (STORE-03).
 *
 * Design decisions:
 *  - Read-only: never writes the embedding column (graph is source of truth; vector is derived).
 *  - Brute-force: exact cosine scan is sub-ms at v1 scale (≤1k nodes × 1536 dims ≈ 1-3ms).
 *  - Seam: swap to sqlite-vec/HNSW only when measured latency hurts (v1.3 roadmap).
 *  - Pitfall 5: Float32Array decoded with byteOffset + length (Buffer slices may have nonzero byteOffset).
 */
import Database from 'better-sqlite3';

/**
 * Compute cosine similarity between two Float32Array vectors.
 * Returns 0 when either vector's norm is 0 (denom guard prevents NaN/Infinity).
 *
 * noUncheckedIndexedAccess: indices use non-null assertion (!) — safe because
 * both arrays have identical, known length `a.length`.
 */
export function cosineSimF32(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Convert free-form text to an FTS5 MATCH query: tokenize on Unicode letters/digits,
 * double-quote each token (escaping internal `"` as `""`), join with OR.
 * Returns null when no tokens are found (caller skips BM25 pass).
 * Load-bearing: never pass raw text to MATCH — FTS5 query syntax throws on `"`, `-`, parens, operators.
 * T-17-02-T: this is the sanitization gate; MATCH arg is also bound via `?` in stmtBm25.
 *
 * `prefix` (default false) appends `*` to each quoted token so a partial token
 * matches by prefix (`"gi"*` → "git", "give", …). Opt-in so engine retrieval
 * (CandidateRetriever BM25) keeps its exact-token semantics; only incremental UI
 * search (viz /search, VIZ-07) passes prefix:true. The `*` is a literal we append,
 * never user input — the sanitization/quoting guard is unchanged.
 */
export function ftsQueryFromText(text: string, prefix = false): string | null {
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  const suffix = prefix ? '*' : '';
  return tokens.map(t => `"${t.replaceAll('"', '""')}"${suffix}`).join(' OR ');
}

/**
 * Reciprocal Rank Fusion over multiple ranked lists.
 * k=60 is the standard smoothing constant (Cormack et al. 2009; Graphiti/LightRAG precedent).
 * Score-scale agnostic: RRF uses rank position only, so BM25 (negative-unbounded) and
 * cosine ([0,1]) combine correctly without normalization.
 */
export function rrfFuse(
  lists: Array<Array<{ id: string }>>,
  k = 60,
  topK = 10,
  weights?: number[],
): Array<{ id: string; rrfScore: number }> {
  const scores = new Map<string, number>();
  for (let li = 0; li < lists.length; li++) {
    const w = weights?.[li] ?? 1;
    lists[li]!.forEach((hit, rank) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + w / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, rrfScore]) => ({ id, rrfScore }));
}

/**
 * Brute-force cosine top-k retrieval over embedded, non-tombstoned nodes (STORE-03).
 *
 * Only nodes with `embedding IS NOT NULL AND tombstoned = 0` are scored.
 * - Dirty nodes (embedded_hash IS NULL) are excluded because they have no valid embedding.
 * - Tombstoned nodes are excluded because tombstone() sets tombstoned = 1 but does NOT null
 *   the embedding; without this filter a stale superseded node remains nominable and could be
 *   re-judged or re-confirmed (T-02-STALE). Exclusion is correct for both the Phase-2
 *   consolidator and Phase-3 retrieval since they share this primitive.
 */
export class CandidateRetriever {
  private readonly stmtSelectEmbedded: Database.Statement;
  // D-29: second scan includes tombstoned nodes (their embeddings are NOT nulled by tombstone())
  private readonly stmtSelectTombstoned: Database.Statement;
  // FTS5 BM25 query statement — compiled once (T-01-SQL).
  // bm25() returns negative-is-better; ORDER BY rank ascending = best first.
  // JOIN node excludes tombstoned rows (belt-and-braces — sync in tombstone() is structural).
  // MATCH argument is NEVER raw text: callers must pass ftsQueryFromText(text) output.
  private readonly stmtBm25: Database.Statement;

  constructor(db: Database.Database) {
    // Select only nodes that have been embedded AND are not tombstoned (T-02-STALE)
    this.stmtSelectEmbedded = db.prepare(
      'SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0'
    );
    // tombstone() does NOT null the embedding — tombstoned nodes remain cosine-scannable (D-29)
    this.stmtSelectTombstoned = db.prepare(
      'SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 1'
    );
    this.stmtBm25 = db.prepare(`
      SELECT f.node_id AS id, bm25(node_fts) AS bm25score
      FROM node_fts f JOIN node n ON n.id = f.node_id AND n.tombstoned = 0
      WHERE node_fts MATCH ?
      ORDER BY rank LIMIT ?
    `);
  }

  /**
   * Return the top-k nodes by cosine similarity to `queryVec`, sorted descending.
   * Nodes with null embedding are excluded (read-only on the graph).
   *
   * L-2 (topk side): rows whose decoded length !== queryVec.length are silently skipped.
   * This guards against legacy data or a future embed-provider change that produces a
   * different dimensionality — a mismatched cosine would yield NaN and scramble the sort.
   * The write-side dims assertion (plan 2 setEmbedding guard) prevents new mismatches;
   * this guard handles any pre-existing ones.
   */
  topk(queryVec: Float32Array, k: number): Array<{ id: string; score: number }> {
    const rows = this.stmtSelectEmbedded.all() as Array<{ id: string; embedding: Buffer }>;

    return rows
      .flatMap(row => {
        // Pitfall 5: pass byteOffset + length to handle Buffer slices correctly
        const v = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        // L-2: skip dimension-mismatched vectors rather than producing NaN scores
        if (v.length !== queryVec.length) return [];
        return [{ id: row.id, score: cosineSimF32(queryVec, v) }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * Return the top-k TOMBSTONED nodes by cosine similarity to `queryVec`, sorted descending.
   * Used for the 'deleted' classification second scan (D-29/RET-02).
   * Mirrors topk() exactly — same Float32Array decode (Pitfall 5), same dim guard (L-2), same sort+slice.
   */
  topkTombstoned(queryVec: Float32Array, k: number): Array<{ id: string; score: number }> {
    const rows = this.stmtSelectTombstoned.all() as Array<{ id: string; embedding: Buffer }>;

    return rows
      .flatMap(row => {
        // Pitfall 5: byteOffset + length (Buffer slices may have nonzero byteOffset)
        const v = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        // L-2: skip dimension-mismatched vectors
        if (v.length !== queryVec.length) return [];
        return [{ id: row.id, score: cosineSimF32(queryVec, v) }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * Hybrid BM25+cosine RRF top-k retrieval (Phase 17 LEVER 1).
   *
   * Combines:
   *  - Cosine list: topk(queryVec, preK) — exact cosine over embedded live nodes.
   *  - BM25 list: FTS5 MATCH on token-quoted queryText — lexical keyword match.
   * Fuses with RRF (k=60). Returns top-k fused results with cosine score (when available)
   * for use by retrieveRanked's floor gate.
   *
   * T-04-03-I: queryText must come from user/question input, never from LLM output.
   * This contract is upheld: the HybridResponder answer path no longer passes queryText
   * to retrieveRanked (17-08 GAP-03 — retrieve_miss=0 attribution; 9ea5eabc BM25 regression
   * removed). Direct callers (e.g. eval harness) must only supply user-derived text.
   * FTS5 MATCH receives only the sanitized ftsQueryFromText() output — never raw text (Pitfall 2).
   * Falls back to cosine-only when FTS5 table is absent or queryText yields no tokens.
   */
  hybridTopk(
    queryVec: Float32Array,
    queryText: string,
    k: number,
    preK = k * 3,
  ): Array<{ id: string; score: number }> {
    // Cosine list (pre-k for fusion input)
    const cosineList = this.topk(queryVec, preK);

    // BM25 list — sanitize before MATCH (Pitfall 2, T-17-02-T)
    const ftsQuery = ftsQueryFromText(queryText);
    let bm25List: Array<{ id: string }> = [];
    if (ftsQuery) {
      try {
        bm25List = this.stmtBm25.all(ftsQuery, preK) as Array<{ id: string }>;
      } catch {
        // FTS table absent or MATCH syntax error — fall back to cosine only (graceful degradation)
        bm25List = [];
      }
    }

    // RRF fusion — rank-based, no score normalization needed
    const fused = rrfFuse([cosineList, bm25List], 60, k);

    // Resolve cosine score for each fused result (needed by retrieveRanked's floor gate)
    const cosineScoreMap = new Map(cosineList.map(h => [h.id, h.score]));
    return fused.map(f => ({
      id: f.id,
      score: cosineScoreMap.get(f.id) ?? 0,  // 0 for BM25-only hits (no cosine scored)
    }));
  }
}
