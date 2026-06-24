/**
 * CandidateRetriever — brute-force cosine top-k over non-null node embeddings (STORE-03).
 *
 * Design decisions:
 *  - Read-only: never writes the embedding column (graph is source of truth; vector is derived).
 *  - Brute-force: exact cosine scan is sub-ms at v1 scale (≤1k nodes × 1536 dims ≈ 1-3ms).
 *  - Seam: swap to sqlite-vec/HNSW only when measured latency hurts (v1.3 roadmap).
 *  - Pitfall 5: Float32Array decoded with byteOffset + length (Buffer slices may have nonzero byteOffset).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import { effectiveStrength } from '../strength/decay';

/**
 * Phase 41 (PERF-01, D-04/D-06): the persisted exact vector index.
 *
 * The spike (41-SPIKE-FINDINGS.md) chose the ZERO-DEP contiguous flat-`Float32Array`
 * exact scan over sqlite-vec: ~3.4× faster warm, byte-exact (20/20 top-k set-identical),
 * net-zero new deps. The COLD win (SessionStart-inject, recall-cli) only materializes when
 * the cold process reads a PRE-BUILT persisted sidecar instead of re-marshaling ~10k
 * embedding BLOB rows (D-06). This module is that sidecar.
 *
 * The index is a DERIVED cache (PERF-01): the graph is source of truth, the sidecar is
 * rebuildable from `node.embedding` at any time. It is built at the END of the offline
 * sleep pass (D-05) and read read-only by the online CandidateRetriever. On any load
 * failure (missing / corrupt / stale / dim-mismatch) the retriever falls back to the
 * brute-force scan — a corrupt artifact NEVER becomes authoritative (T-41-04).
 *
 * Sidecar binary layout (little-endian, one contiguous file next to the DB):
 *   [0..4)   magic   = "RVIX"            (4 bytes)
 *   [4..8)   version = INDEX_VERSION     (uint32)
 *   [8..12)  dim                          (uint32)  embedding dimensionality
 *   [12..16) count                        (uint32)  number of vectors
 *   then `count` id records:  uint16 byteLength + UTF-8 id bytes
 *   then count*dim float32 (row-major):   the contiguous embedding buffer
 *   then count float64:                    precomputed L2 row norms
 *
 * Norms are precomputed so a query scan is one dot product + one sqrt of the query norm
 * per row — the same `dot / (||q|| · ||row||)` as cosineSimF32, just without re-decoding a
 * Float32Array view per row per query.
 */
const INDEX_MAGIC = 'RVIX';
const INDEX_VERSION = 1;

/**
 * Canonical sidecar path for a given DB: `<dbPath>.vindex`, beside the DB file.
 * The end-of-pass build (run-sleep-pass.ts) and the three cold online readers
 * (session-start / recall / ambient) ALL derive the path through this one helper so they
 * never drift.
 */
export function vectorIndexPath(dbPath: string): string {
  return `${dbPath}.vindex`;
}

/** Loaded sidecar: parallel id array + contiguous f32 buffer + precomputed f64 norms. */
interface LoadedIndex {
  dim: number;
  count: number;
  ids: string[];
  /** length = count * dim, row-major. */
  data: Float32Array;
  /** length = count; ||row_i||. */
  norms: Float64Array;
}

/**
 * Serialize the live (non-tombstoned) embedded nodes into the flat-buffer sidecar and
 * persist it to `indexPath` (atomic: write to a temp file then rename). Returns the
 * number of vectors written.
 *
 * Mirrors the topk row filter exactly: `embedding IS NOT NULL AND tombstoned = 0`.
 * Rows whose decoded length differs from the first row's dim are SKIPPED (the same L-2
 * dim-mismatch guard the brute-force scan applies), so a legacy/mismatched vector never
 * corrupts the contiguous buffer.
 *
 * Offline only — called at the end of the sleep pass (D-05). Never called on the online
 * path. The graph stays source of truth; this is a rebuildable derived cache (PERF-01).
 */
export function buildVectorIndex(db: Database.Database, indexPath: string): number {
  const rows = db
    .prepare('SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0')
    .all() as Array<{ id: string; embedding: Buffer }>;

  // First pass: determine dim from the first decodable row and collect kept rows.
  const kept: Array<{ id: string; v: Float32Array }> = [];
  let dim = 0;
  for (const row of rows) {
    // Pitfall 5: byteOffset + length (Buffer slices may have a nonzero byteOffset).
    const v = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    if (dim === 0) dim = v.length;
    // L-2: skip dimension-mismatched vectors so the contiguous buffer stays uniform.
    if (v.length !== dim) continue;
    // Copy out of the Buffer-backed view — the underlying Buffer may be reused by sqlite.
    kept.push({ id: row.id, v: Float32Array.from(v) });
  }

  const count = kept.length;
  const ids = kept.map(r => r.id);

  // Compute id-section byte length.
  const idBytes = ids.map(id => Buffer.byteLength(id, 'utf8'));
  const idSectionLen = idBytes.reduce((sum, b) => sum + 2 + b, 0);

  const headerLen = 16;
  const dataLen = count * dim * 4;
  const normsLen = count * 8;
  const buf = Buffer.allocUnsafe(headerLen + idSectionLen + dataLen + normsLen);

  buf.write(INDEX_MAGIC, 0, 'ascii');
  buf.writeUInt32LE(INDEX_VERSION, 4);
  buf.writeUInt32LE(dim, 8);
  buf.writeUInt32LE(count, 12);

  let off = headerLen;
  for (let i = 0; i < count; i++) {
    const idLen = idBytes[i]!;
    buf.writeUInt16LE(idLen, off);
    off += 2;
    buf.write(ids[i]!, off, 'utf8');
    off += idLen;
  }

  // Contiguous f32 data + precomputed f64 norms.
  const dataView = new Float32Array(count * dim);
  const normsView = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const v = kept[i]!.v;
    let norm = 0;
    const base = i * dim;
    for (let j = 0; j < dim; j++) {
      const x = v[j]!;
      dataView[base + j] = x;
      norm += x * x;
    }
    normsView[i] = Math.sqrt(norm);
  }
  Buffer.from(dataView.buffer, dataView.byteOffset, dataLen).copy(buf, off);
  off += dataLen;
  Buffer.from(normsView.buffer, normsView.byteOffset, normsLen).copy(buf, off);

  // Atomic publish: write temp then rename so a reader never sees a half-written file.
  const tmpPath = `${indexPath}.tmp`;
  writeFileSync(tmpPath, buf);
  renameSync(tmpPath, indexPath);
  return count;
}

/**
 * Load a sidecar from disk. Returns null on any failure (missing, corrupt, wrong magic /
 * version, truncated) — the caller falls back to brute-force. A corrupt artifact NEVER
 * becomes authoritative (T-41-04: graph is source of truth, index is a derived cache).
 */
function loadVectorIndex(indexPath: string): LoadedIndex | null {
  try {
    if (!existsSync(indexPath)) return null;
    const buf = readFileSync(indexPath);
    if (buf.length < 16) return null;
    if (buf.toString('ascii', 0, 4) !== INDEX_MAGIC) return null;
    if (buf.readUInt32LE(4) !== INDEX_VERSION) return null;
    const dim = buf.readUInt32LE(8);
    const count = buf.readUInt32LE(12);
    if (dim === 0 || count === 0) return { dim, count: 0, ids: [], data: new Float32Array(0), norms: new Float64Array(0) };

    let off = 16;
    const ids: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
      if (off + 2 > buf.length) return null;
      const idLen = buf.readUInt16LE(off);
      off += 2;
      if (off + idLen > buf.length) return null;
      ids[i] = buf.toString('utf8', off, off + idLen);
      off += idLen;
    }

    const dataLen = count * dim * 4;
    const normsLen = count * 8;
    if (off + dataLen + normsLen > buf.length) return null;

    // Copy into freshly-aligned typed arrays (readFileSync's Buffer has no alignment guarantee
    // for a 4/8-byte typed-array view at an arbitrary byteOffset).
    const data = new Float32Array(count * dim);
    Buffer.from(data.buffer).set(buf.subarray(off, off + dataLen));
    off += dataLen;
    const norms = new Float64Array(count);
    Buffer.from(norms.buffer).set(buf.subarray(off, off + normsLen));

    return { dim, count, ids, data, norms };
  } catch {
    return null;
  }
}

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
  // Phase 35 RANK-01: fetch s + last_access for a set of candidate ids (D-02 pool query).
  // json_each pattern mirrors stmtLatestSupportTs in engine.ts.
  // Pool ids are internal UUIDs derived from cosine+BM25 scan — never user strings (D-02).
  // tombstoned nodes are excluded via the source queries (D-10); this stmt fetches any live
  // node by id; the pool already excludes tombstoned ids.
  private readonly stmtPoolStrength: Database.Statement;

  // Phase 41 (PERF-01/D-06): OPT-IN persisted exact index. Null = brute-force mode.
  // Loaded ONCE in the constructor when `opts.indexPath` points at a valid sidecar.
  // EXISTING callers that pass no opts (e.g. the offline consolidator, consolidator.ts
  // ~682) stay brute-force — D-07. On a missing/corrupt artifact this stays null and
  // topk falls back to the brute-force scan (the index is a derived cache, never
  // authoritative — graph is source of truth).
  private readonly index: LoadedIndex | null;

  constructor(db: Database.Database, opts?: { indexPath?: string }) {
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
    // Phase 35 RANK-01: parameterized json_each pool-strength lookup.
    // Selects s + last_access for the given set of candidate ids.
    // Pool ids are UUIDs from the cosine/BM25 scan — internal only, never user strings (T-35-02).
    this.stmtPoolStrength = db.prepare(
      'SELECT id, s, last_access FROM node WHERE id IN (SELECT value FROM json_each(?))'
    );

    // Phase 41: load the persisted exact index when a path is supplied AND the artifact is
    // valid. loadVectorIndex returns null on any failure → brute-force fallback. A one-line
    // warning is emitted to stderr (never stdout — the hot path emits structured output) so a
    // missing/corrupt sidecar is visible without ever breaking recall.
    if (opts?.indexPath) {
      this.index = loadVectorIndex(opts.indexPath);
      if (this.index === null) {
        process.stderr.write(
          `[recense] vector index unavailable at ${opts.indexPath} — falling back to brute-force scan\n`,
        );
      }
    } else {
      this.index = null;
    }
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
    // Phase 41 (PERF-01): index-backed exact scan over the persisted flat buffer when
    // loaded. Returns the SAME real cosine scores as cosineSimF32 (D-01 exact, byte-
    // equivalent — the spike proved 20/20 top-k set-identical). When the index is null
    // (no artifact / corrupt / not opted-in) this drops through to the brute-force scan
    // below — zero behavior change for the consolidator and any indexless caller (D-07).
    if (this.index !== null) {
      return this.topkIndexed(queryVec, k);
    }

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
   * Phase 41: index-backed exact top-k over the persisted flat buffer.
   *
   * Computes `dot / (||q|| · ||row||)` against the contiguous `Float32Array` using the
   * precomputed row norms — the identical cosine formula as cosineSimF32, so the returned
   * scores are byte-equivalent (PERF-03 by construction). Preserves the L-2 dim-mismatch
   * skip: when the query length differs from the indexed dim, returns [] (a cosine across
   * different dims is meaningless — matches the brute-force scan's skip).
   *
   * Only called when `this.index !== null`.
   */
  private topkIndexed(queryVec: Float32Array, k: number): Array<{ id: string; score: number }> {
    const idx = this.index!;
    // L-2: dim mismatch → no valid cosine. The brute-force scan skips per-row; here the
    // whole buffer is uniform-dim, so a query-dim mismatch means nothing scores.
    if (queryVec.length !== idx.dim) return [];

    // Precompute the query norm once.
    let qNorm = 0;
    for (let j = 0; j < idx.dim; j++) qNorm += queryVec[j]! * queryVec[j]!;
    qNorm = Math.sqrt(qNorm);

    const { dim, count, data, norms, ids } = idx;
    const scored: Array<{ id: string; score: number }> = new Array(count);
    for (let i = 0; i < count; i++) {
      const base = i * dim;
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += queryVec[j]! * data[base + j]!;
      const denom = qNorm * norms[i]!;
      // Same denom guard as cosineSimF32 (0 → score 0, never NaN/Infinity).
      scored[i] = { id: ids[i]!, score: denom === 0 ? 0 : dot / denom };
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, k);
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
    strengthWeight = 0,
    nowMs?: number,
    lambda?: number,
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

    // Phase 35 RANK-01: optional strength-ranked third list (D-01, D-02, D-04).
    // Only assembled when strengthWeight > 0; pool ids are internal UUIDs only (T-35-02).
    // Calls the shared pure effectiveStrength helper from decay.ts (T-35-01 one-place-math rule).
    // NEVER calls materializeDecay (Pitfall 4 — that mutates s/last_access, violating D-43).
    let fused;
    if (strengthWeight > 0) {
      // D-02: pool is the strict union of the cosine+BM25 candidate ids — never wider
      const poolIds = [...new Set([...cosineList.map(h => h.id), ...bm25List.map(h => h.id)])];
      const poolRows = this.stmtPoolStrength.all(JSON.stringify(poolIds)) as Array<{
        id: string; s: number; last_access: number;
      }>;
      const strengthList = poolRows
        .map(r => ({
          id: r.id,
          // Shared pure helper from decay.ts — one-place-math rule (no formula re-derivation here)
          effS: effectiveStrength(r.s, r.last_access, nowMs ?? Date.now(), lambda ?? 0.05),
        }))
        .sort((a, b) => b.effS - a.effS);

      fused = rrfFuse(
        [cosineList, bm25List, strengthList],
        60, k,
        [1, 1, strengthWeight],
      );
    } else {
      // D-04 dark default: strengthWeight=0 → exact current behavior, no DB strength query
      fused = rrfFuse([cosineList, bm25List], 60, k);
    }

    // Resolve cosine score for each fused result (needed by retrieveRanked's floor gate).
    // PRESERVE exactly: strength list changes fusion ORDER only, never the returned score (Pitfall 2).
    // BM25-only or strength-only hits (no cosine vector) retain score=0.
    const cosineScoreMap = new Map(cosineList.map(h => [h.id, h.score]));
    return fused.map(f => ({
      id: f.id,
      score: cosineScoreMap.get(f.id) ?? 0,  // 0 for BM25-only hits (no cosine scored)
    }));
  }
}
