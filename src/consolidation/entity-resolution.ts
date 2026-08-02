/**
 * EntityResolver — standalone, reusable entity-resolution seam (Phase 64, Plan 64-02).
 *
 * Two responsibilities, both exported for reuse:
 *  (a) `generateCandidates` — a **three-channel union candidate generator**
 *      (exact/entity-keyed ∪ BM25 lexical ∪ dense cosine), deduped across channels by node id.
 *      This is the Phase 69 (Entity-Anchored Ambient Recall) reuse contract: the generator
 *      is type-agnostic (`nodeType` is opt-in, not hard-coded) so a future caller can anchor
 *      retrieval against any node type without a second divergent implementation.
 *  (b) `resolve` — a **confident-or-null** decision over that generator (score floor + top-2
 *      margin, both config knobs — `entityResolutionFloor` / `entityResolutionMargin`), scoped
 *      to live `type='entity'` nodes (D-11: the candidate universe for resolution, not for the
 *      generator seam itself).
 *
 * Design decisions implemented here (CONTEXT.md D-01/D-02/D-04/D-05/D-08/D-11/D-12):
 *  D-01  Standalone module, not inlined into consolidator.ts — Phase 69 reuses generateCandidates.
 *  D-02  Channels mirror shipped machinery (resolveEntityByName, ftsQueryFromText, cosineSimF32)
 *        rather than reinventing them; never dense-only — a resolution may succeed on lexical
 *        evidence alone (dense channel structurally empty) or on dense evidence alone (zero
 *        lexical overlap). Weakening either direction silently reduces the union back to
 *        dense-gated candidate generation — the exact defect a prior milestone spent fixing
 *        one layer down. Both directions are structurally tested in entity-resolution.test.ts.
 *  D-04  Zero net-new LLM calls — TYPE-LEVEL guarantee: the constructor below has no
 *        `ModelProvider` parameter, so this module cannot call a provider even by mistake.
 *  D-05  Floor/margin are conservative dark config knobs (src/lib/config.ts); defaults err
 *        toward abstention (a missed resolution costs nothing, a wrong one silently corrupts
 *        an external system of record recense cannot fix — research Pitfall 4).
 *  D-08  `resolve`'s `descriptor` output field is the resolved node's own canonical `value`
 *        string verbatim — never a consumer id, never transformed or prettified.
 *  D-11  Resolution's candidate universe is live (non-tombstoned) `type='entity'` nodes only
 *        (`resolve` always calls generateCandidates with `nodeType: 'entity'`); the generator
 *        itself stays type-agnostic for Phase 69 reuse.
 *  D-12  Read-only contract: this module never calls `upsertNode`, `upsertEdge`, `strengthen`,
 *        or `tombstone`, and never opens a transaction. Its only SQL is two read-only prepared
 *        SELECTs plus reads through `store` (`resolveEntityByName` / `getNode`). An unknown
 *        entity MUST abstain, never mint a node on a miss — that is the extraction pipeline's
 *        job, not this module's.
 *
 * Known precision limits (stated honestly, not hidden):
 *  (a) Callers typically pass `vec` as the embedding of the surrounding claim/episode text,
 *      not of the descriptor itself — the dense channel is therefore a PROXY signal. The
 *      exact and BM25 channels carry descriptor-precise evidence; callers relying solely on
 *      the dense channel should expect lower precision than the lexical channels.
 *  (b) Same-company multi-role granularity ("Stripe — Backend" vs "Stripe — Platform") is
 *      already merged into one node by the Phase 25 entity-dedup pass. Resolving both
 *      descriptors to that single node is honest given the graph's current shape; per-role
 *      splitting is a Phase 65+ concern gated on measurement. This module does not "fix"
 *      entity-dedup granularity.
 */
import Database from 'better-sqlite3';
import type { SemanticStore } from '../db/semantic-store';
import type { EngineConfig } from '../lib/config';
import { cosineSimF32, ftsQueryFromText } from '../retrieval/topk';
import { normalizeValue } from './normalize';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which channel(s) surfaced a candidate — attribution for tests/counters, not just outcome. */
export type ChannelName = 'exact' | 'bm25' | 'dense';

/** One candidate node produced by the union generator, scored across all channels. */
export interface EntityCandidate {
  id: string;
  value: string;
  /** Dice lexical score against the query text, computed for every candidate regardless of channel. */
  lex: number;
  /** Cosine similarity clamped to [0, 1]; 0 when the dense channel is unavailable for this candidate. */
  dense: number;
  /** max(lex, dense) — load-bearing for the never-dense-only property. */
  score: number;
  channels: ChannelName[];
}

/** Per-channel candidate counts, recorded for observability (D-06 counter precedent). */
export interface ChannelCounts {
  exact: number;
  bm25: number;
  dense: number;
}

export type ResolutionResult =
  | {
      resolved: true;
      nodeId: string;
      descriptor: string;
      score: number;
      channelCounts: ChannelCounts;
    }
  | {
      resolved: false;
      reason: 'no-candidates' | 'below-floor' | 'margin-too-close';
      topScore?: number;
      channelCounts: ChannelCounts;
    };

// ---------------------------------------------------------------------------
// Module-private constant (Phase 55-01 D-01/D-02 precedent — private, not config)
// ---------------------------------------------------------------------------

/** Per-channel candidate cap for BM25 and dense channels (Task 3 guards this literal). */
const ENTITY_CANDIDATE_K = 5;

// ---------------------------------------------------------------------------
// Pure helper: lexicalScore
// ---------------------------------------------------------------------------

function tokenSet(s: string): Set<string> {
  const norm = normalizeValue(s);
  if (norm === '') return new Set();
  return new Set(norm.split(' '));
}

/**
 * Dice coefficient over normalized whitespace-tokenized sets: 2 * |A ∩ B| / (|A| + |B|).
 * 0 when either input is empty (after normalization). Symmetric — chosen over containment
 * deliberately: containment scores "Stripe" against "Stripe Backend Role" as 1.0 and
 * over-resolves, while Dice errs toward abstention (D-05).
 */
export function lexicalScore(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

// ---------------------------------------------------------------------------
// EntityResolver
// ---------------------------------------------------------------------------

export class EntityResolver {
  private readonly store: SemanticStore;
  private readonly config: EngineConfig;

  // Read-only prepared statements (mirrors entity-dedup.ts:144-149 shape). No writes, ever (D-12).
  private readonly stmtCandidateNodes: Database.Statement;
  private readonly stmtFtsCandidates: Database.Statement;

  /**
   * D-04: constructor MUST NOT accept a ModelProvider. That omission is the type-level
   * guarantee behind the zero-net-new-LLM-calls property — this module cannot call a
   * provider even by accident because it never receives one.
   */
  constructor(db: Database.Database, store: SemanticStore, config: EngineConfig) {
    this.store = store;
    this.config = config;

    this.stmtCandidateNodes = db.prepare(`
      SELECT id, value, embedding FROM node
      WHERE tombstoned = 0 AND (@type IS NULL OR type = @type)
      ORDER BY id
    `);

    this.stmtFtsCandidates = db.prepare(`
      SELECT f.node_id AS id, n.value AS value
      FROM node_fts f JOIN node n ON n.id = f.node_id AND n.tombstoned = 0
      WHERE node_fts MATCH @q AND (@type IS NULL OR n.type = @type)
      ORDER BY rank LIMIT @k
    `);
  }

  /**
   * The reusable three-channel union candidate generator (Phase 69 seam).
   * Type-agnostic: `nodeType` is opt-in so a future caller can anchor against any node type.
   */
  generateCandidates(opts: {
    text: string;
    vec?: Float32Array;
    nodeType?: string;
    k?: number;
  }): { candidates: EntityCandidate[]; channelCounts: ChannelCounts } {
    const type = opts.nodeType ?? null;
    const k = opts.k ?? ENTITY_CANDIDATE_K;

    // Merged-by-id accumulator — dedup across channels (mirrors cosineIdSet, consolidator.ts:781).
    const merged = new Map<string, { value: string; channels: Set<ChannelName>; dense: number }>();
    let exactCount = 0;
    let bm25Count = 0;
    let denseCount = 0;

    // 1. exact / entity-keyed — the shipped priority ladder, reused per D-02.
    const exactId = this.store.resolveEntityByName(opts.text.trim());
    if (exactId !== null) {
      const node = this.store.getNode(exactId);
      if (node && (opts.nodeType === undefined || node.type === opts.nodeType)) {
        merged.set(node.id, { value: node.value, channels: new Set<ChannelName>(['exact']), dense: 0 });
        exactCount = 1;
      }
    }

    // 2. BM25 lexical — ftsQueryFromText is the ONLY path to MATCH (T-17-02-T); never raw text.
    const ftsQuery = ftsQueryFromText(opts.text);
    if (ftsQuery !== null) {
      try {
        const rows = this.stmtFtsCandidates.all({ q: ftsQuery, type, k }) as Array<{
          id: string;
          value: string;
        }>;
        bm25Count = rows.length;
        for (const row of rows) {
          const existing = merged.get(row.id);
          if (existing) existing.channels.add('bm25');
          else merged.set(row.id, { value: row.value, channels: new Set<ChannelName>(['bm25']), dense: 0 });
        }
      } catch {
        // FTS table absent or MATCH syntax error — graceful degradation (mirrors
        // consolidator.ts:833-835, topk.ts hybridTopk).
      }
    }

    // 3. dense cosine — skipped entirely when no vec is passed (the "never dense-only" property
    // must hold with this channel structurally empty).
    if (opts.vec !== undefined) {
      const vec = opts.vec;
      const rows = this.stmtCandidateNodes.all({ type }) as Array<{
        id: string;
        value: string;
        embedding: Buffer | null;
      }>;
      const scored: Array<{ id: string; value: string; dense: number }> = [];
      for (const row of rows) {
        if (!row.embedding) continue;
        if (row.embedding.byteLength % 4 !== 0) continue;
        const decoded = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        if (decoded.length !== vec.length) continue;
        // Explicit clamp: cosineSimF32 returns raw cosine in [-1, 1] (NOT pre-clamped). Without
        // this, an opposed vector yields a negative score, breaking the [0, 1] score domain the
        // floor/margin are calibrated against and the entityResolutionFloor > 1.0 dark-off switch.
        let dense = Math.max(0, cosineSimF32(vec, decoded));
        // Belt-and-braces defense against a malformed stored embedding — cosineSimF32 already
        // returns 0 for a zero-norm vector via its own denom===0 guard, so this is secondary;
        // the primary concern is the negative half of the range handled by Math.max above.
        if (!Number.isFinite(dense)) dense = 0;
        scored.push({ id: row.id, value: row.value, dense });
      }
      scored.sort((a, b) => b.dense - a.dense);
      const top = scored.slice(0, k);
      denseCount = top.length;
      for (const s of top) {
        const existing = merged.get(s.id);
        if (existing) {
          existing.channels.add('dense');
          existing.dense = s.dense;
        } else {
          merged.set(s.id, { value: s.value, channels: new Set<ChannelName>(['dense']), dense: s.dense });
        }
      }
    }

    // score = max(lex, dense) — load-bearing for RESOLVE-01: a lexical-only hit and a
    // dense-only hit each carry a candidate over the floor independently.
    const candidates: EntityCandidate[] = [];
    for (const [id, c] of merged) {
      const lex = lexicalScore(opts.text, c.value);
      const score = Math.max(lex, c.dense);
      candidates.push({ id, value: c.value, lex, dense: c.dense, score, channels: [...c.channels] });
    }

    return {
      candidates,
      channelCounts: { exact: exactCount, bm25: bm25Count, dense: denseCount },
    };
  }

  /**
   * Confident-or-null decision (D-04, both halves of research Pitfall 4's prescription):
   * top candidate must clear the floor AND be separated from the runner-up by the margin,
   * or resolution abstains. Never lets "closest" stand in for "correct".
   */
  resolve(opts: { descriptor: string; vec?: Float32Array }): ResolutionResult {
    const { candidates, channelCounts } = this.generateCandidates({
      text: opts.descriptor,
      vec: opts.vec,
      nodeType: 'entity',
    });

    if (candidates.length === 0) {
      return { resolved: false, reason: 'no-candidates', channelCounts };
    }

    // Sort by score descending, tie-broken by id ascending — determinism: a second run over
    // unchanged state must produce the identical outcome.
    const sorted = [...candidates].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const top = sorted[0]!;

    if (top.score < this.config.entityResolutionFloor) {
      return { resolved: false, reason: 'below-floor', topScore: top.score, channelCounts };
    }

    if (sorted.length >= 2) {
      const second = sorted[1]!;
      if (top.score - second.score < this.config.entityResolutionMargin) {
        return { resolved: false, reason: 'margin-too-close', topScore: top.score, channelCounts };
      }
    }

    return {
      resolved: true,
      nodeId: top.id,
      descriptor: top.value,
      score: top.score,
      channelCounts,
    };
  }
}
