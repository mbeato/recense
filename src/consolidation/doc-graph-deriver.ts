/**
 * DocGraphDeriver — offline doc-graph derivation (D-01..D-09, D-11).
 *
 * Runs inside the offline sleep pass (Phase C, after corpusPromoter.promote(),
 * before insightReflector.reflect()). Derives:
 *   DOC-01: subject↔subject `doc_reference` edges from shared schema-member IDF overlap
 *           + schema_rel adjacency (D-01/D-02/D-03/D-04/D-05).
 *   DOC-02: multi-level `doc_containment` edges from abstraction-ladder position (D-06/D-07/D-08/D-09).
 *           Includes hub→subject containment (folds promoteScope's hub→chapter path, D-11).
 * Both artifacts are wipe-and-rebuildable derived caches. Zero LLM calls (D-01 constraint).
 * All writes in a single atomic transaction (mirrors SchemaRelationDeriver D-04 discipline).
 *
 * Threat mitigations:
 *  - D-37 firewall: member expansion gated on tombstoned=0, origin!='inferred',
 *    type IN ('fact','entity') — inferred docs cannot launder into doc-edge signal.
 *  - D-43 self-confirmation guard: derives doc-edges only; never writes back to or
 *    strengthens source facts/entities/schemas.
 *  - D-04 idempotency: wipe+recompute run inside one db.transaction().immediate().
 *    A mid-derive crash leaves wipe-then-rebuild-clean state on the next pass.
 *  - CONSOL-03: all node/edge writes via owned primitives (store.upsertEdge) — no raw INSERT.
 *  - T-02-ASYNC: async-before-sync; NO await inside any db.transaction.
 *  - T-01-SQL: all queries via prepared statements compiled once in constructor.
 *  - D-12: all time reads via this.clock.nowMs() — never Date.now() directly.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { SemanticStore } from '../db/semantic-store';

// ---------------------------------------------------------------------------
// Constants — named for tuning visibility
// ---------------------------------------------------------------------------

/**
 * Maximum reference partners per subject doc (D-03 top-K cap).
 * A doc keeps only its K strongest-weighted reference edges; edge is retained
 * in the final set via union symmetry (D-05) — either endpoint keeps the other.
 */
const TOP_K = 7;

/**
 * Additive weight boost applied when two subject docs have schemas connected by
 * a `schema_rel` edge or sharing a common abstracts parent (D-02).
 *
 * Rationale: set below a typical single-rare-member IDF contribution so that
 * shared members dominate the signal and adjacency serves as tie-breaker/boost
 * for documents that are conceptually related but have disjoint literal members.
 * At 2 subjects: IDF of a member appearing in both = ln(2/2) = 0, so any
 * purely-adjacent pair has score = ADJACENCY_WEIGHT only. For larger corpora
 * a rare shared member contributes ln(N/2) which quickly exceeds this value.
 */
const ADJACENCY_WEIGHT = 0.3;

/**
 * DOC-01b: weight for a shared entity NAME between two subjects (cross-project bridge).
 * The same tech/tool/person surfaces as a DISTINCT node per project, so node-id sharing
 * never links them — the normalized name does. Multiplied by the name's IDF so a rare
 * substantive entity (a specific tool/person) dominates while ubiquitous process-exhaust
 * names (gsd-phase, plan, …) contribute ~0 (and df ≥ N/2 names are dropped outright).
 */
const ENTITY_NAME_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DocNodeRow {
  id: string;
  slug: string;
  scope: string;
}

interface EdgeDst {
  dst: string;
}

interface EdgeSrc {
  src: string;
}

interface EdgeNeighbor {
  neighbor: string;
}

interface MetaRow {
  value: string;
}

interface ClusterableNodeRow {
  id: string;
}

// ---------------------------------------------------------------------------
// NoopDocGraphDeriver — test/DI default (satisfies the same structural type)
// ---------------------------------------------------------------------------

/**
 * No-op implementation matching DocGraphDeriver's public contract.
 * Used as the Consolidator DI default — does nothing, returns zero counts.
 * The return type matches exactly so `DocGraphDeriver | NoopDocGraphDeriver`
 * is structurally type-compatible without a shared interface.
 */
export class NoopDocGraphDeriver {
  async deriveDocGraph(opts?: { dryRun?: boolean }): Promise<{ containment: number; reference: number }> {
    return { containment: 0, reference: 0 };
  }
}

// ---------------------------------------------------------------------------
// DocGraphDeriver
// ---------------------------------------------------------------------------

/**
 * Derives `doc_reference` (D-01..D-05) and `doc_containment` (D-06..D-10) edges
 * from the existing schema/fact graph. Offline, LLM-free, wipe-and-rebuild.
 */
export class DocGraphDeriver {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly config: EngineConfig;
  private readonly clock: Clock;

  // Prepared statements compiled once — never per-call (T-01-SQL)

  /** D-37 firewall — source ONLY observed, non-inferred, embedded fact/entity nodes. */
  private readonly stmtGetClusterableNodes: Database.Statement;

  /** Expand a schema's members via abstracts edges (one row per member). */
  private readonly stmtGetSchemaMembers: Database.Statement;

  /** DOC-01b: live observed entity id → value, for the shared-entity-name reference bridge. */
  private readonly stmtGetEntityNames: Database.Statement;

  /** Read a meta value by key (for subject-schema-ids:<slug>). */
  private readonly stmtGetMeta: Database.Statement;

  /** Live doc nodes (type='doc', not tombstoned) with slug + scope. */
  private readonly stmtGetDocNodes: Database.Statement;

  /** Walk the abstracts ladder upward: which schemas directly abstract a given schema. */
  private readonly stmtGetAbstractsParents: Database.Statement;

  /** schema_rel neighbors of a schema node (D-02 adjacency signal). */
  private readonly stmtGetSchemaRelNeighbors: Database.Statement;

  /** D-04 wipe: delete all doc_containment edges before recompute. */
  private readonly stmtWipeDocContainment: Database.Statement;

  /** D-04 wipe: delete all doc_reference edges before recompute. */
  private readonly stmtWipeDocReference: Database.Statement;

  constructor(
    db: Database.Database,
    store: SemanticStore,
    config: EngineConfig,
    clock: Clock,
  ) {
    this.db = db;
    this.store = store;
    this.config = config;
    this.clock = clock;

    // D-37 firewall — VERBATIM from schema-relations.ts L155-159 + corpus-promoter.ts L158-162
    // (both files copy this identically — preserve exactly):
    this.stmtGetClusterableNodes = db.prepare(
      "SELECT id, embedding FROM node " +
      "WHERE tombstoned = 0 AND origin != 'inferred' " +
      "AND type IN ('fact','entity') AND embedding IS NOT NULL"
    );

    // Schema members via abstracts edges (one row per member)
    this.stmtGetSchemaMembers = db.prepare(
      "SELECT dst FROM edge WHERE src = ? AND kind = 'abstracts'"
    );

    // DOC-01b: live observed entity names (id → value) for the cross-project name bridge.
    this.stmtGetEntityNames = db.prepare(
      "SELECT id, value FROM node " +
      "WHERE type = 'entity' AND tombstoned = 0 AND origin != 'inferred' AND TRIM(value) <> ''"
    );

    // subject-schema-ids meta per subject slug
    // (the entry handle: corpus-promoter.ts L1180-1183 writes this; we read it)
    this.stmtGetMeta = db.prepare(
      "SELECT value FROM meta WHERE key = ?"
    );

    // Live doc nodes with their slug + scope for hub detection
    this.stmtGetDocNodes = db.prepare(
      "SELECT n.id, nd.slug, ns.scope FROM node n " +
      "JOIN node_doc nd ON nd.node_id = n.id " +
      "JOIN node_scope ns ON ns.node_id = n.id " +
      "WHERE n.type = 'doc' AND n.tombstoned = 0"
    );

    // abstracts ladder: which schemas are direct parents of a given schema
    this.stmtGetAbstractsParents = db.prepare(
      "SELECT src FROM edge WHERE dst = ? AND kind = 'abstracts'"
    );

    // schema_rel adjacency (D-02 second reference signal)
    // Returns the "other end" for either direction of a schema_rel edge.
    this.stmtGetSchemaRelNeighbors = db.prepare(
      "SELECT CASE WHEN src = ? THEN dst ELSE src END AS neighbor " +
      "FROM edge WHERE kind = 'schema_rel' AND (src = ? OR dst = ?)"
    );

    // D-04 wipe-and-rebuild: delete ALL prior doc-graph edges before recompute
    this.stmtWipeDocContainment = db.prepare(
      "DELETE FROM edge WHERE kind = 'doc_containment'"
    );
    this.stmtWipeDocReference = db.prepare(
      "DELETE FROM edge WHERE kind = 'doc_reference'"
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Derive doc_reference + doc_containment edges from the schema/fact graph.
   *
   * Phase A (async-free — all reads from SQLite, no await):
   *   1. Load all live doc nodes.
   *   2. For each subject doc, expand its schema member set (D-37 gated).
   *   3. Compute corpus-wide document-frequency per member (IDF, D-03).
   *   4. For each subject pair, compute IDF-weighted shared-member score (D-01).
   *   5. Add schema_rel adjacency boost (D-02).
   *   6. Apply top-K per doc, union symmetry (D-03/D-05).
   *   7. Derive containment: strict-ALL schema ancestry (D-06/D-09).
   *   8. Add hub→subject containment for every subject (D-08).
   *   9. De-dup: suppress reference edges for pairs that also have containment.
   *
   * Phase B (sync write — one db.transaction().immediate(), NO await inside):
   *   Wipe + rewrite all doc_reference + doc_containment edges (CONSOL-03, D-04).
   *
   * @param opts - Optional. `dryRun: true` computes edges but does not write.
   * @returns Count of containment + reference edges written (or would-write in dryRun).
   */
  async deriveDocGraph(opts?: { dryRun?: boolean }): Promise<{ containment: number; reference: number }> {
    const isDryRun = opts?.dryRun ?? false;

    // ── Phase A: read-only prep ──────────────────────────────────────────

    // 1. Load all live doc nodes
    const allDocNodes = this.stmtGetDocNodes.all() as DocNodeRow[];

    // Fewer than 2 total doc nodes → nothing to derive. Still wipe for D-04 idempotency.
    if (allDocNodes.length < 2) {
      if (!isDryRun) {
        this.db.transaction(() => {
          this.stmtWipeDocContainment.run();
          this.stmtWipeDocReference.run();
        }).immediate();
      }
      return { containment: 0, reference: 0 };
    }

    // Identify hubs vs subjects vs UUID schema-chapter docs (D-10 includes all).
    // UUID_RE: matches UUID v4 format used for schema-chapter doc slugs.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isHub = (slug: string): boolean => !slug.includes(':') && !UUID_RE.test(slug);
    const isSubjectDoc = (slug: string): boolean => slug.includes(':');

    const subjectDocs = allDocNodes.filter(n => isSubjectDoc(n.slug));
    const hubDocs = allDocNodes.filter(n => isHub(n.slug));

    // Build a lookup: scope -> hub doc id (for D-08 hub→subject edges)
    const hubByScope = new Map<string, string>();
    for (const hub of hubDocs) {
      hubByScope.set(hub.slug, hub.id);  // hub.slug === its project scope
    }

    // 2. Build the D-37 gated node set (observed, non-inferred, embedded facts/entities)
    const clusterableRows = this.stmtGetClusterableNodes.all() as ClusterableNodeRow[];
    const clusterableIds = new Set<string>(clusterableRows.map(r => r.id));

    // DOC-01b: entity id → normalized name, so references can bridge on shared entity NAMES
    // across projects (the same tool/tech/person is a DISTINCT node per project; the name is
    // the only thing they share). IDF weighting (below) suppresses ubiquitous exhaust names.
    const entityNameById = new Map<string, string>();
    for (const row of this.stmtGetEntityNames.all() as Array<{ id: string; value: string }>) {
      const norm = row.value.trim().toLowerCase();
      if (norm) entityNameById.set(row.id, norm);
    }

    // 3. For each subject doc, resolve its schema member set (D-37 gated)
    interface SubjectInfo {
      node: DocNodeRow;
      schemaIds: string[];
      memberIds: Set<string>; // gated member ids
      entityNames: Set<string>; // DOC-01b: normalized entity names among members (cross-project bridge)
    }

    const subjects: SubjectInfo[] = [];
    for (const node of subjectDocs) {
      const metaRow = this.stmtGetMeta.get(`subject-schema-ids:${node.slug}`) as MetaRow | undefined;
      if (!metaRow) continue;

      let schemaIds: string[];
      try {
        schemaIds = JSON.parse(metaRow.value) as string[];
      } catch {
        continue;
      }

      // Expand each schema to its gated members (and collect member entity names — DOC-01b)
      const memberIds = new Set<string>();
      const entityNames = new Set<string>();
      for (const schemaId of schemaIds) {
        const memberRows = this.stmtGetSchemaMembers.all(schemaId) as EdgeDst[];
        for (const { dst } of memberRows) {
          if (clusterableIds.has(dst)) {
            memberIds.add(dst);
            const ename = entityNameById.get(dst);
            if (ename) entityNames.add(ename);
          }
        }
      }

      subjects.push({ node, schemaIds, memberIds, entityNames });
    }

    // ── Reference edge derivation (D-01..D-05) ──────────────────────────

    // 4. Compute corpus-wide document-frequency (IDF scope = all subject docs, D-04 cross-project safe)
    const N = subjects.length;
    const memberDocFreq = new Map<string, number>(); // memberId -> count of subjects containing it

    for (const sub of subjects) {
      for (const memberId of sub.memberIds) {
        memberDocFreq.set(memberId, (memberDocFreq.get(memberId) ?? 0) + 1);
      }
    }

    // IDF weight: ln(N / df(m)); members with df == N get IDF = 0 (ubiquitous, contributes nothing)
    const idf = (memberId: string): number => {
      const df = memberDocFreq.get(memberId) ?? 0;
      if (df === 0 || N === 0) return 0;
      return Math.log(N / df);
    };

    // DOC-01b: entity-name document frequency + IDF for the cross-project name bridge.
    const nameDocFreq = new Map<string, number>();
    for (const sub of subjects) {
      for (const ename of sub.entityNames) {
        nameDocFreq.set(ename, (nameDocFreq.get(ename) ?? 0) + 1);
      }
    }
    const nameIdf = (ename: string): number => {
      const df = nameDocFreq.get(ename) ?? 0;
      // Drop ubiquitous names (df ≥ N/2) entirely — process-exhaust noise (gsd-phase, plan…)
      // that would otherwise link every project to every other. ln(N/df) handles the rest.
      if (df === 0 || N === 0 || df >= N / 2) return 0;
      return Math.log(N / df);
    };

    // 5. Build schema adjacency lookup for D-02 boost
    // schemaA is adjacent to schemaB if they share a schema_rel edge or a common abstracts parent.
    // Compute schema->Set<adjacentSchemaId> lazily and cache.
    const schemaAdjacencyCache = new Map<string, Set<string>>();

    const getSchemaAdjacent = (schemaId: string): Set<string> => {
      if (schemaAdjacencyCache.has(schemaId)) return schemaAdjacencyCache.get(schemaId)!;

      const adj = new Set<string>();

      // Direct schema_rel neighbors
      const relNeighbors = this.stmtGetSchemaRelNeighbors.all(schemaId, schemaId, schemaId) as EdgeNeighbor[];
      for (const { neighbor } of relNeighbors) {
        adj.add(neighbor);
      }

      // Schemas sharing a common abstracts parent
      const parents = this.stmtGetAbstractsParents.all(schemaId) as EdgeSrc[];
      for (const { src: parentId } of parents) {
        // Siblings: other schemas that have this same parent
        const parentMemberRows = this.stmtGetSchemaMembers.all(parentId) as EdgeDst[];
        for (const { dst: siblingId } of parentMemberRows) {
          if (siblingId !== schemaId) {
            adj.add(siblingId);
          }
        }
      }

      schemaAdjacencyCache.set(schemaId, adj);
      return adj;
    };

    // Check if ANY schema of A is adjacent to ANY schema of B (D-02)
    const areSchemaAdjacent = (schemaIdsA: string[], schemaIdsB: string[]): boolean => {
      for (const sA of schemaIdsA) {
        const adj = getSchemaAdjacent(sA);
        for (const sB of schemaIdsB) {
          if (adj.has(sB)) return true;
        }
      }
      return false;
    };

    // 6. Compute pairwise reference scores
    interface RefEdgeCandidate {
      idxA: number;
      idxB: number;
      w: number;
    }

    const pairScores: RefEdgeCandidate[] = [];

    for (let i = 0; i < subjects.length; i++) {
      for (let j = i + 1; j < subjects.length; j++) {
        const subA = subjects[i]!;
        const subB = subjects[j]!;

        // Base IDF-weighted shared-member score (D-01/D-03)
        let score = 0;
        for (const memberId of subA.memberIds) {
          if (subB.memberIds.has(memberId)) {
            score += idf(memberId);
          }
        }

        // DOC-01b: shared entity-NAME bridge (cross-project). IDF-weighted by name rarity
        // and scaled by ENTITY_NAME_WEIGHT so substantive shared entities link projects
        // while exhaust names contribute ~0.
        for (const ename of subA.entityNames) {
          if (subB.entityNames.has(ename)) {
            score += nameIdf(ename) * ENTITY_NAME_WEIGHT;
          }
        }

        // D-02 adjacency boost: schemas related by schema_rel or shared parent
        if (areSchemaAdjacent(subA.schemaIds, subB.schemaIds)) {
          score += ADJACENCY_WEIGHT;
        }

        if (score > 0) {
          pairScores.push({ idxA: i, idxB: j, w: score });
        }
      }
    }

    // 7. Apply top-K per doc (D-03), then union symmetry (D-05)
    // For each subject, sort its candidates by weight and keep the top K.
    // Build per-subject ranked list.
    const topKSets: Map<number, Map<number, number>> = new Map(); // subjectIdx -> partnerIdx -> weight

    // Collect all candidates per subject
    const candidatesPerSubject = new Map<number, Array<{ partner: number; w: number }>>();
    for (const { idxA, idxB, w } of pairScores) {
      if (!candidatesPerSubject.has(idxA)) candidatesPerSubject.set(idxA, []);
      if (!candidatesPerSubject.has(idxB)) candidatesPerSubject.set(idxB, []);
      candidatesPerSubject.get(idxA)!.push({ partner: idxB, w });
      candidatesPerSubject.get(idxB)!.push({ partner: idxA, w });
    }

    // Per-subject: sort by weight descending, keep top K
    for (const [subIdx, candidates] of candidatesPerSubject) {
      candidates.sort((a, b) => b.w - a.w);
      const topK = candidates.slice(0, TOP_K);
      topKSets.set(subIdx, new Map(topK.map(c => [c.partner, c.w])));
    }

    // Union symmetry (D-05): pair retained if EITHER side ranked the other in its top K
    interface RefEdge {
      srcId: string;
      dstId: string;
      w: number;
    }

    const referenceEdges: RefEdge[] = [];
    const seenRefPairs = new Set<string>();

    for (let i = 0; i < subjects.length; i++) {
      for (let j = i + 1; j < subjects.length; j++) {
        const aKeepsB = topKSets.get(i)?.has(j) ?? false;
        const bKeepsA = topKSets.get(j)?.has(i) ?? false;
        if (!aKeepsB && !bKeepsA) continue;

        const subA = subjects[i]!;
        const subB = subjects[j]!;

        // Stable lexicographic ordering for deterministic idempotency (D-04)
        const [srcId, dstId] = subA.node.id < subB.node.id
          ? [subA.node.id, subB.node.id]
          : [subB.node.id, subA.node.id];

        const pairKey = `${srcId!}\0${dstId!}`;
        if (seenRefPairs.has(pairKey)) continue;
        seenRefPairs.add(pairKey);

        // Weight: maximum of the two directional scores (both sides may have ranked it)
        const wAB = topKSets.get(i)?.get(j) ?? 0;
        const wBA = topKSets.get(j)?.get(i) ?? 0;
        const w = Math.max(wAB, wBA);

        referenceEdges.push({ srcId: srcId!, dstId: dstId!, w });
      }
    }

    // ── Containment edge derivation (D-06..D-10) ────────────────────────

    // Helper: walk the abstracts ladder upward from schemaId to collect all ancestor schema ids.
    // Uses a BFS with a visited set to bound the walk (prevents infinite loops in cyclic schemas).
    const getAncestors = (schemaId: string): Set<string> => {
      const ancestors = new Set<string>();
      const queue = [schemaId];
      const visited = new Set<string>([schemaId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        const parents = this.stmtGetAbstractsParents.all(current) as EdgeSrc[];
        for (const { src: parentId } of parents) {
          if (!visited.has(parentId)) {
            visited.add(parentId);
            ancestors.add(parentId);
            queue.push(parentId);
          }
        }
      }
      return ancestors;
    };

    // For each subject, pre-compute its schema ancestors set
    interface SubjectAncestry {
      schemaIds: Set<string>;
      ancestors: Set<string>; // all ancestor schema ids (union of all schemas' ancestors)
    }

    const subjectAncestry: SubjectAncestry[] = subjects.map(sub => {
      const allAncestors = new Set<string>();
      for (const schemaId of sub.schemaIds) {
        for (const ancestor of getAncestors(schemaId)) {
          allAncestors.add(ancestor);
        }
      }
      return {
        schemaIds: new Set(sub.schemaIds),
        ancestors: allAncestors,
      };
    });

    // D-06/D-09: subject A contains subject B if EVERY schema of B has at least one ancestor
    // that is in A's schema set (strict-ALL rule).
    // Direction: A is parent (higher on ladder), B is child (more specific).
    interface ContainmentEdge {
      srcId: string; // parent subject doc id
      dstId: string; // child subject doc id
      w: number;
    }

    const containmentEdges: ContainmentEdge[] = [];
    // Track A->B pairs to detect potential cycles (belt-and-suspenders for D-09)
    const containmentSet = new Set<string>(); // "srcId\0dstId"

    for (let i = 0; i < subjects.length; i++) {
      for (let j = 0; j < subjects.length; j++) {
        if (i === j) continue;

        const subA = subjects[i]!;
        const subB = subjects[j]!;
        const ancestryB = subjectAncestry[j]!;
        const ancestryA = subjectAncestry[i]!;

        // Strict-ALL: every schema of B must have an ancestor in A's schema set
        if (ancestryB.schemaIds.size === 0) continue; // no schemas = cannot be contained

        let allAncestored = true;
        for (const bSchema of ancestryB.schemaIds) {
          // bSchema's ancestors must include at least one of A's schemas
          const bAncestors = getAncestors(bSchema);
          let hasAncestorInA = false;
          for (const aSchema of ancestryA.schemaIds) {
            if (bAncestors.has(aSchema)) {
              hasAncestorInA = true;
              break;
            }
          }
          if (!hasAncestorInA) {
            allAncestored = false;
            break;
          }
        }

        if (!allAncestored) continue;

        // D-09 acyclicity guard: skip A->B if B->A already exists
        const reverseKey = `${subB.node.id}\0${subA.node.id}`;
        if (containmentSet.has(reverseKey)) continue;

        const edgeKey = `${subA.node.id}\0${subB.node.id}`;
        if (containmentSet.has(edgeKey)) continue; // already added (shouldn't happen but defensive)

        containmentSet.add(edgeKey);
        containmentEdges.push({
          srcId: subA.node.id,
          dstId: subB.node.id,
          w: 1.0,
        });
      }
    }

    // D-08: hub→subject containment — every subject gets an edge from its project hub
    for (const sub of subjects) {
      const hubId = hubByScope.get(sub.node.scope);
      if (!hubId) continue; // no hub found for this scope (skip gracefully)

      // Only add if not already present (hub is not a subject so no cycle possible)
      const edgeKey = `${hubId}\0${sub.node.id}`;
      if (!containmentSet.has(edgeKey)) {
        containmentSet.add(edgeKey);
        containmentEdges.push({
          srcId: hubId,
          dstId: sub.node.id,
          w: 1.0,
        });
      }
    }

    // D-11 subject→chapter containment (Phase 39.2):
    // For each subject, for each schema in its schemaIds, if there is a chapter doc
    // (a doc whose slug === schemaId, UUID format), add a containment edge
    // subject → chapter. This wires the multi-level graph: hub→subject→chapter.
    // A chapter may receive multiple subject parents (DAG, D-07 — no cycle risk
    // because chapter docs are never subjects themselves).
    const slugToDocId = new Map<string, string>(allDocNodes.map(n => [n.slug, n.id]));

    for (const sub of subjects) {
      for (const schemaId of sub.schemaIds) {
        // A chapter doc has slug === schemaId (UUID_RE format)
        if (!UUID_RE.test(schemaId)) continue;
        const chapterDocId = slugToDocId.get(schemaId);
        if (!chapterDocId) continue; // no chapter doc exists yet for this schema

        const edgeKey = `${sub.node.id}\0${chapterDocId}`;
        if (containmentSet.has(edgeKey)) continue; // already present — skip

        containmentSet.add(edgeKey);
        containmentEdges.push({
          srcId: sub.node.id,
          dstId: chapterDocId,
          w: 1.0,
        });
      }
    }

    // 9. De-dup: suppress reference edges for pairs that also have containment (in either direction)
    // Build containment pair lookup
    const containmentPairs = new Set<string>(); // "minId\0maxId"
    for (const ce of containmentEdges) {
      const [a, b] = ce.srcId < ce.dstId ? [ce.srcId, ce.dstId] : [ce.dstId, ce.srcId];
      containmentPairs.add(`${a!}\0${b!}`);
    }

    const filteredReferenceEdges = referenceEdges.filter(re => {
      const [a, b] = re.srcId < re.dstId ? [re.srcId, re.dstId] : [re.dstId, re.srcId];
      return !containmentPairs.has(`${a!}\0${b!}`);
    });

    // ── dryRun short-circuit ─────────────────────────────────────────────

    if (isDryRun) {
      return {
        containment: containmentEdges.length,
        reference: filteredReferenceEdges.length,
      };
    }

    // ── Phase B: one db.transaction().immediate() — NO await inside (T-02-ASYNC) ──

    const nowMs = this.clock.nowMs();

    this.db.transaction(() => {
      // D-04 wipe-from-scratch: delete all prior derived artifacts (idempotent rebuild)
      this.stmtWipeDocContainment.run();
      this.stmtWipeDocReference.run();

      // Write new doc_containment edges via owned primitive (CONSOL-03)
      for (const { srcId, dstId, w } of containmentEdges) {
        this.store.upsertEdge({
          src: srcId,
          dst: dstId,
          rel: 'doc_containment',
          kind: 'doc_containment',
          w,
          last_access: nowMs, // D-12: always from clock
        });
      }

      // Write new doc_reference edges via owned primitive (CONSOL-03)
      // Stable src/dst ordering for deterministic idempotency (already done in Phase A)
      for (const { srcId, dstId, w } of filteredReferenceEdges) {
        this.store.upsertEdge({
          src: srcId,
          dst: dstId,
          rel: 'doc_reference',
          kind: 'doc_reference',
          w,
          last_access: nowMs, // D-12: always from clock
        });
      }
    }).immediate(); // M-5: write-lock discipline — avoid SQLITE_BUSY_SNAPSHOT in WAL mode

    return {
      containment: containmentEdges.length,
      reference: filteredReferenceEdges.length,
    };
  }
}
