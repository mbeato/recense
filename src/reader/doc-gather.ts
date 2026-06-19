/**
 * doc-gather — scope ∪ semantic ∪ entity-hop fact gather for a project slug (READER-01).
 *
 * Implements D-01: gather = node_scope.scope='<slug>' (primary) ∪ hybridTopk semantic
 * (embedding breadth beyond facts that literally name the project) ∪ entity-name LIKE →
 * 1-hop fact neighbors (augmentation). The lexical-only LIKE on fact.value is DROPPED
 * as the spine.
 *
 * Lifecycle: read-only — no DB writes. Injected deps so the function is unit-testable
 * against a seeded in-memory DB without hitting the real RECENSE_DB.
 *
 * Design invariants:
 *  - D-01: scope + semantic is the spine; entity-hop is augmentation.
 *  - Tombstoned facts are excluded from ALL sources.
 *  - Multi-source facts are deduped to one row (union by id Map).
 *  - `via` tags the source(s): 'scope', 'semantic', 'linked', and '+'-joined combinations.
 *  - No raw string interpolation in SQL (T-01-SQL: bound ? params only).
 *  - No writes to the DB (read-only gather).
 */
import Database from 'better-sqlite3';
import type { SemanticStore } from '../db/semantic-store';
import type { ModelProvider } from '../model/provider';
import { CandidateRetriever } from '../retrieval/topk';

/** Shape of a gathered fact row returned to the generator. */
export interface GatheredFact {
  id: string;
  value: string;
  c: number;
  origin: string;
  last_access: number;
  via: string;  // 'scope', 'semantic', 'linked', or combinations joined with '+'
}

/** Injectable deps for unit-testability. */
export interface GatherDeps {
  db: Database.Database;
  store: SemanticStore;
  provider: ModelProvider;
  /** Optional pre-constructed retriever (injected in tests; created from db if absent). */
  retriever?: CandidateRetriever;
}

type Row = { id: string; value: string; c: number; origin: string; last_access: number };

/**
 * Gather facts for `slug` from three sources, union/dedup by id.
 *
 * @param deps  Injected DB + store + retriever + provider (testable; no hard-coded paths).
 * @param slug  Project slug to gather facts for.
 * @param opts  Optional tuning knobs.
 * @param opts.semanticK  Max hits from hybridTopk (default 60).
 */
export async function gatherFacts(
  deps: GatherDeps,
  slug: string,
  opts: { semanticK?: number } = {},
): Promise<GatheredFact[]> {
  const { db, provider } = deps;
  // Create a CandidateRetriever from db if not injected (normal path creates it here;
  // tests may inject a pre-built retriever to share the same in-memory DB instance).
  const retriever = deps.retriever ?? new CandidateRetriever(db);
  const semanticK = opts.semanticK ?? 60;

  // ── 1. Scope gather: facts attributed to this slug via node_scope ────────────
  // D-01: this is the primary spine — project-attributed facts (SCOPE-01 provenance).
  // ORDER BY s DESC: strongest facts first so context budget is well-spent.
  const scopeStmt = db.prepare(`
    SELECT n.id, n.value, n.c, n.origin, n.last_access
    FROM node_scope ns
    JOIN node n ON n.id = ns.node_id
    WHERE ns.scope = ? AND n.type = 'fact' AND n.tombstoned = 0
    ORDER BY n.s DESC
  `);
  const scopedFacts = scopeStmt.all(slug) as Row[];

  // ── 2. Semantic gather: embed the slug + hybridTopk ─────────────────────────
  // D-01: semantic breadth beyond facts that literally mention the project name.
  // One embed call per gatherFacts invocation (no per-fact embedding).
  let semanticFacts: Row[] = [];
  try {
    const queryVecs = await provider.embed([slug]);
    const queryVec = queryVecs[0];
    if (queryVec) {
      // hybridTopk returns {id, score}; filter to type='fact', tombstoned=0.
      // Use hybridTopk with the slug as queryText for BM25 co-signal.
      const hits = retriever.hybridTopk(queryVec, slug, semanticK);
      if (hits.length > 0) {
        const hitIds = hits.map(h => h.id);
        // Filter hits to type='fact', tombstoned=0 using a parameterised query.
        // Build placeholders for the IN clause from the hit list.
        const placeholders = hitIds.map(() => '?').join(',');
        const semanticStmt = db.prepare(`
          SELECT id, value, c, origin, last_access
          FROM node
          WHERE id IN (${placeholders}) AND type = 'fact' AND tombstoned = 0
        `);
        semanticFacts = semanticStmt.all(...hitIds) as Row[];
      }
    }
  } catch {
    // Embedding failures are non-fatal — fall back to scope + entity-hop only.
  }

  // ── 3. Entity-hop: entity-name LIKE slug → 1-hop fact neighbors ─────────────
  // Reuses the gather.ts entity-name LIKE pattern verbatim as augmentation (D-01).
  // Entity-name LIKE is allowed (D-01 — only lexical LIKE on fact.value is dropped).
  const entityIdStmt = db.prepare(
    `SELECT id FROM node WHERE type = 'entity' AND tombstoned = 0 AND lower(value) LIKE ?`,
  );
  const entityIds = (entityIdStmt.all(`%${slug.toLowerCase()}%`) as Array<{ id: string }>).map(
    r => r.id,
  );

  const linkedFacts: Row[] = [];
  if (entityIds.length > 0) {
    const placeholders = entityIds.map(() => '?').join(',');
    // 1-hop: edges where entity is src OR dst; the neighbor must be a live fact.
    const neighborSql = `
      SELECT DISTINCT n.id, n.value, n.c, n.origin, n.last_access
      FROM edge e
      JOIN node n ON n.id = (CASE WHEN e.src IN (${placeholders}) THEN e.dst ELSE e.src END)
      WHERE (e.src IN (${placeholders}) OR e.dst IN (${placeholders}))
        AND n.type = 'fact' AND n.tombstoned = 0
    `;
    linkedFacts.push(
      ...(db
        .prepare(neighborSql)
        .all(...entityIds, ...entityIds, ...entityIds) as Row[]),
    );
  }

  // ── 4. Union / dedup by id ────────────────────────────────────────────────
  // Reuses the gather.ts union pattern verbatim, tagging `via` for each source.
  const byId = new Map<string, GatheredFact>();

  for (const r of scopedFacts) {
    byId.set(r.id, { ...r, via: 'scope' });
  }
  for (const r of semanticFacts) {
    const existing = byId.get(r.id);
    if (existing) {
      // Multi-source: combine via tags
      existing.via = existing.via.includes('semantic') ? existing.via : `${existing.via}+semantic`;
    } else {
      byId.set(r.id, { ...r, via: 'semantic' });
    }
  }
  for (const r of linkedFacts) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.via = existing.via.includes('linked') ? existing.via : `${existing.via}+linked`;
    } else {
      byId.set(r.id, { ...r, via: 'linked' });
    }
  }

  return [...byId.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// gatherFactsForSchema — D-09: schema-anchored fact gather (CORPUS-01)
//
// Re-anchors the gather from a project scope-slug to a schema node, keeping the
// same three-source union/dedup structure as gatherFacts:
//
//  (1) SPINE — facts and entities directly abstracted by the schema via
//              kind='abstracts' edges. This replaces node_scope.scope = slug.
//              Tagged via 'scope' so downstream via-handling is identical to the
//              scope-anchored path (code comment explains the reuse rationale).
//
//  (2) SEMANTIC BREADTH — hybridTopk seeded by the precomputed member CENTROID
//              (NOT the schema label, which is often a weak "super:a + b + c"
//              fallback). If centroid is null, this source is SKIPPED entirely —
//              no provider.embed call, no throw. This is the whole point of D-09:
//              the centroid is pre-computed by the caller, so no extra embed call.
//
//  (3) ENTITY-HOP — 1-hop fact neighbors of entities that the schema directly
//              abstracts (collected from source 1). Re-rooted at the schema's
//              own abstracted entities instead of entity-name LIKE slug.
//
// Read-only — no DB writes. All SQL uses bound ? params (T-01-SQL).
// ─────────────────────────────────────────────────────────────────────────────

/** Parameters for schema-anchored gather (D-09). */
export interface GatherSchemaParams {
  /** The UUID of the schema node to gather facts for. */
  schemaId: string;
  /**
   * Pre-computed member centroid (mean embedding of the schema's abstracted
   * live observed nodes). If null, the semantic breadth pass is skipped
   * entirely — no provider.embed call is made.
   */
  centroid: Float32Array | null;
  /**
   * Optional human-readable schema label used as queryText in hybridTopk
   * (BM25 co-signal). Falls back to '' when absent (centroid alone is used).
   */
  schemaLabel?: string;
}

/**
 * Gather facts for a schema from three D-09 sources, union/dedup by id.
 *
 * @param deps    Injected DB + store + provider (same shape as gatherFacts).
 * @param params  Schema id + precomputed centroid + optional label.
 * @param opts    Optional tuning (semanticK defaults to 60).
 */
export async function gatherFactsForSchema(
  deps: GatherDeps,
  params: GatherSchemaParams,
  opts: { semanticK?: number } = {},
): Promise<GatheredFact[]> {
  const { db } = deps;
  // Create CandidateRetriever if not injected (mirrors gatherFacts pattern).
  const retriever = deps.retriever ?? new CandidateRetriever(db);
  const semanticK = opts.semanticK ?? 60;
  const { schemaId, centroid, schemaLabel = '' } = params;

  // ── 1. SPINE — facts directly abstracted by the schema ──────────────────
  // SELECT facts (and collect entity ids for source 3) via kind='abstracts' edges.
  // Tagged 'scope' — identical tag to the scope-gather so downstream via-handling
  // (citation verify, via filter) requires no change.
  const evidenceStmt = db.prepare(`
    SELECT n.id, n.value, n.c, n.origin, n.last_access, n.type
    FROM edge e
    JOIN node n ON n.id = e.dst
    WHERE e.src = ? AND e.kind = 'abstracts' AND n.tombstoned = 0
  `);
  const evidenceRows = evidenceStmt.all(schemaId) as Array<Row & { type: string }>;

  const spineFacts: Row[] = [];
  const abstractedEntityIds: string[] = [];
  for (const row of evidenceRows) {
    if (row.type === 'fact') {
      spineFacts.push({ id: row.id, value: row.value, c: row.c, origin: row.origin, last_access: row.last_access });
    } else if (row.type === 'entity') {
      abstractedEntityIds.push(row.id);
    }
  }

  // ── 2. SEMANTIC BREADTH — centroid-seeded hybridTopk ────────────────────
  // Only when centroid is non-null. Never calls provider.embed — the caller
  // must pre-compute the centroid (e.g. from SchemaRelationDeriver's centroid
  // math). Skipping on null is intentional — not a fallback, a design decision.
  let semanticFacts: Row[] = [];
  if (centroid !== null) {
    try {
      const hits = retriever.hybridTopk(centroid, schemaLabel, semanticK);
      if (hits.length > 0) {
        const hitIds = hits.map(h => h.id);
        const placeholders = hitIds.map(() => '?').join(',');
        const semanticStmt = db.prepare(`
          SELECT id, value, c, origin, last_access
          FROM node
          WHERE id IN (${placeholders}) AND type = 'fact' AND tombstoned = 0
        `);
        semanticFacts = semanticStmt.all(...hitIds) as Row[];
      }
    } catch {
      // Non-fatal — fall back to spine + entity-hop.
    }
  }

  // ── 3. ENTITY-HOP — 1-hop fact neighbors of abstracted entities ──────────
  // Re-rooted at the schema's own abstracted entity ids (from source 1) instead
  // of entity-name LIKE slug. Same 1-hop pattern as gatherFacts.
  const linkedFacts: Row[] = [];
  if (abstractedEntityIds.length > 0) {
    const placeholders = abstractedEntityIds.map(() => '?').join(',');
    const neighborSql = `
      SELECT DISTINCT n.id, n.value, n.c, n.origin, n.last_access
      FROM edge e
      JOIN node n ON n.id = (CASE WHEN e.src IN (${placeholders}) THEN e.dst ELSE e.src END)
      WHERE (e.src IN (${placeholders}) OR e.dst IN (${placeholders}))
        AND n.type = 'fact' AND n.tombstoned = 0
    `;
    linkedFacts.push(
      ...(db
        .prepare(neighborSql)
        .all(...abstractedEntityIds, ...abstractedEntityIds, ...abstractedEntityIds) as Row[]),
    );
  }

  // ── 4. Union / dedup by id (verbatim from gatherFacts) ──────────────────
  const byId = new Map<string, GatheredFact>();

  for (const r of spineFacts) {
    byId.set(r.id, { ...r, via: 'scope' });
  }
  for (const r of semanticFacts) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.via = existing.via.includes('semantic') ? existing.via : `${existing.via}+semantic`;
    } else {
      byId.set(r.id, { ...r, via: 'semantic' });
    }
  }
  for (const r of linkedFacts) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.via = existing.via.includes('linked') ? existing.via : `${existing.via}+linked`;
    } else {
      byId.set(r.id, { ...r, via: 'linked' });
    }
  }

  return [...byId.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// computeSchemaCentroid — D-37-gated mean embedding for a schema (CORPUS-06)
//
// Factored out of generate-doc-cli.ts (BUG-2b fix inline copy) so that
// generateCorpusDocs can compute centroids without importing the CLI layer.
//
// Gate (D-37 firewall, verbatim from CorpusPromoter and generate-doc-cli):
//   tombstoned=0, origin!='inferred', type IN ('fact','entity'), embedding IS NOT NULL
//
// Pitfall 5: Float32Array decoded with byteOffset + byteLength/4, never bare Buffer.
//
// Returns null when no members pass the gate (semantic breadth pass is skipped —
// spine + entity-hop still produce a doc; this is a design decision, not an error).
//
// Read-only — no DB writes. All SQL uses bound ? params (T-01-SQL).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the D-37-gated centroid (mean embedding) for a schema node's abstracted members.
 *
 * @param db        SQLite database handle (read-only use).
 * @param schemaId  UUID of the schema node whose `abstracts` edges are traversed.
 * @returns Float32Array of the mean embedding, or null when no gated members have embeddings.
 */
export function computeSchemaCentroid(
  db: Database.Database,
  schemaId: string,
): Float32Array | null {
  // D-37 gate: same gated query as CorpusPromoter and SchemaRelationDeriver —
  // inferred content cannot launder into centroid derivation.
  const memberRows = db.prepare(
    "SELECT m.embedding AS embedding FROM edge e " +
    "JOIN node m ON m.id = e.dst " +
    "WHERE e.src = ? AND e.kind = 'abstracts' " +
    "AND m.tombstoned = 0 AND m.origin != 'inferred' " +
    "AND m.type IN ('fact','entity') AND m.embedding IS NOT NULL",
  ).all(schemaId) as Array<{ embedding: Buffer }>;

  if (memberRows.length === 0) return null;

  // Pitfall 5: decode each Buffer as a Float32Array using byteOffset + byteLength/4.
  const vecs = memberRows.map(
    r => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  );

  const dims = vecs[0]!.length;
  const centroid = new Float32Array(dims);
  for (const v of vecs) {
    for (let i = 0; i < dims; i++) centroid[i]! += v[i]!;
  }
  for (let i = 0; i < dims; i++) centroid[i]! /= vecs.length;

  return centroid;
}

/** A sibling doc (another live deep-dive) the generator can link to. */
export interface SiblingDoc {
  /** Full doc NODE id (used in recense://doc/<id> refs). */
  id: string;
  /** Project slug of the sibling doc. */
  slug: string;
  /** Display title: the doc's first H1, falling back to the slug. */
  title: string;
}

/**
 * Gather the OTHER live docs the current doc can cross-link to (READER-04).
 *
 * Returns one entry per `type='doc'` node that is NOT tombstoned and NOT the current
 * slug. `title` is the doc body's first markdown H1 (`# ...`), falling back to the slug.
 * Read-only — no DB writes; used to build the generator's RELATED DOCS prompt block so
 * doc→doc refs (and therefore doc_link edges) form organically in production.
 *
 * @param db    Database handle (read-only use).
 * @param slug  The slug of the doc being generated (excluded from the result).
 */
export function gatherSiblingDocs(db: Database.Database, slug: string): SiblingDoc[] {
  // Live doc nodes (excluding the current slug) with their slug + body for title extraction.
  const stmt = db.prepare(`
    SELECT n.id AS id, nd.slug AS slug, n.value AS value
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.type = 'doc' AND n.tombstoned = 0 AND nd.slug != ?
  `);
  const rows = stmt.all(slug) as Array<{ id: string; slug: string; value: string }>;

  return rows.map(r => {
    // Title = first markdown H1 in the doc body, else the slug.
    let title = r.slug;
    const m = (r.value ?? '').match(/^#\s+(.+?)\s*$/m);
    if (m && m[1]) title = m[1].trim();
    return { id: r.id, slug: r.slug, title };
  });
}
