/**
 * CorpusPromoter — D-04 idempotent corpus-promotion pass (Phase 28, CORPUS-02/03/05).
 *
 * Derives the schema-anchored doc corpus in one atomic transaction:
 *  1. LLM-free SQL/COUNT mass gate + token-shape noise filter (D-06/D-07, CORPUS-02)
 *  2. Centroid-cosine + mass-direction ladder (D-01R/D-02R, CORPUS-03):
 *       - CONTAINMENT (directed parent→child): cosine-connected pairs where masses differ
 *         by ≥ massGapMin; parent = larger-mass schema; child keeps single strongest parent
 *         → clean forest, not a hairball
 *       - REFERENCE (undirected): cosine-connected pairs not selected as containment parent/child
 *  3. Eager lifecycle-exempt doc-node stubs (D-04) for newly promoted schemas
 *  4. Wipe+rebuild of all doc_containment + doc_reference edges (derived cache)
 *
 * Engine invariants upheld:
 *  - D-03: ALL corpus edges are written between TYPE='doc' nodes only — source schemas
 *    never gain edges, s, or c updates. Self-confirmation guard holds by construction.
 *  - D-05 hysteresis: promote when mass ≥ highMass; tombstone doc only when mass < lowMass.
 *    Schemas in [lowMass, highMass) keep their earned doc stub once created.
 *  - T-02-ASYNC: Phase B is a single db.transaction().immediate() with NO await inside.
 *  - T-01-SQL: all queries via prepared statements compiled once in constructor.
 *  - D-12: all time reads via this.clock.nowMs() — never Date.now() directly.
 *  - D-37 firewall: centroid computation uses only tombstoned=0, origin!='inferred',
 *    type IN ('fact','entity') nodes (same gate as SchemaRelationDeriver).
 *  - Pitfall 5: Float32Array decoded with byteOffset + byteLength/4 (never bare Buffer).
 *  - Pitfall 6: promoter NEVER calls strengthen/setEmbedding/upsertEdge on a source schema.
 *
 * Threat mitigations:
 *  - T-28-D43 (Elevation of Privilege): writes only to type='doc' nodes + doc→doc edges.
 *    CORPUS-05 blocking test asserts source schema state unchanged.
 *  - T-28-TX (Denial of Service): single IMMEDIATE transaction; partial crash leaves prior
 *    derived cache intact or fully rebuilt on next pass (SchemaRelationDeriver discipline).
 *  - T-28-DUP (Tampering): D-05 hysteresis prevents stub thrash in the mass band.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { SemanticStore } from '../db/semantic-store';
import { cosineSimF32 } from '../retrieval/topk';
import { newId } from '../lib/hash';
import { GLOBAL_SCOPE } from '../lib/scope';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CorpusPromoterOpts {
  /** Promote schema when mass ≥ highMass (HIGH-water mark). */
  highMass: number;
  /** Tombstone a doc stub only when mass < lowMass (LOW-water mark). */
  lowMass: number;
  /** Exclude schema when noise_frac >= noiseCap (D-07). */
  noiseCap: number;
  /**
   * Cosine similarity threshold for corpus edge derivation (D-01R enrichment knob).
   * Set LOWER than config.schemaRelSimilarityThreshold to produce more corpus relations
   * among promoted schemas than the ~12 schema_rel baseline. Do NOT mutate the config field.
   */
  corpusCosineThreshold: number;
  /**
   * Minimum evidence-member mass gap between two cosine-connected schemas to assign
   * the CONTAINMENT direction (parent = larger mass). Pairs with gap < massGapMin get
   * a REFERENCE edge instead. Default: 2.
   */
  massGapMin?: number;
  /**
   * Minimum distinct members for a schema to participate in containment/reference derivation.
   * Guards against tiny schemas being spuriously nested. Default: 4.
   */
  minMembers?: number;
}

export interface PromoteResult {
  /** Schema IDs selected for promotion (gate + hysteresis passed). */
  promoted: string[];
  /** Number of doc_containment edges written (0 in dryRun). */
  containment: number;
  /** Number of doc_reference edges written (0 in dryRun). */
  reference: number;
  /** Number of doc stubs tombstoned (mass fell below lowMass). */
  tombstoned: number;
}

// ---------------------------------------------------------------------------
// Noise patterns (D-07 — calibrated against live brain 2026-06-19)
// ---------------------------------------------------------------------------

const NOISE_PATTERNS: RegExp[] = [
  /^\/private\//,
  /^\/tmp\//,
  /^\/Users\//,
  /^toolu_[A-Za-z0-9]+$/,          // Anthropic tool IDs
  /^[Cc]ommit\s+[`]?[0-9a-f]{6,}/, // git commit references
  /^worktreePath:/,
  /^\.claude\/worktrees/,
];

function isNoiseMember(value: string): boolean {
  return NOISE_PATTERNS.some(re => re.test(value));
}

// ---------------------------------------------------------------------------
// NoopCorpusPromoter — test/legacy default (does nothing)
// ---------------------------------------------------------------------------

/**
 * No-op implementation for tests and call sites that don't need corpus promotion.
 * Mirrors NoopSchemaRelationDeriver — satisfies the Consolidator DI contract.
 */
export class NoopCorpusPromoter {
  async promote(_opts?: { dryRun?: boolean }): Promise<PromoteResult> {
    return { promoted: [], containment: 0, reference: 0, tombstoned: 0 };
  }
}

// ---------------------------------------------------------------------------
// CorpusPromoter
// ---------------------------------------------------------------------------

/**
 * Derives the schema-anchored doc corpus idempotently.
 * Structural sibling of SchemaRelationDeriver (same constructor pattern, same Phase C slot).
 */
export class CorpusPromoter {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly clock: Clock;
  private readonly opts: Required<CorpusPromoterOpts>;

  // Prepared statements — compiled once in constructor (T-01-SQL)
  private readonly stmtGetSchemaNodes: Database.Statement;
  private readonly stmtGetClusterableNodes: Database.Statement;
  private readonly stmtGetSchemaMembersWithValues: Database.Statement;
  private readonly stmtGetLiveDocForSlug: Database.Statement;
  private readonly stmtWipeDocContainment: Database.Statement;
  private readonly stmtWipeDocReference: Database.Statement;
  private readonly stmtFtsDelete: Database.Statement;
  /** For promoteScope: find schemas that have at least one gated member with node_scope = S */
  private readonly stmtGetSchemasInScope: Database.Statement;

  constructor(
    db: Database.Database,
    store: SemanticStore,
    clock: Clock,
    opts: CorpusPromoterOpts,
  ) {
    this.db = db;
    this.store = store;
    this.clock = clock;
    this.opts = {
      massGapMin: 2,
      minMembers: 4,
      ...opts,
    };

    // D-37 firewall: same gated query as SchemaRelationDeriver — inferred content cannot
    // launder into corpus derivation (tombstoned=0, origin!='inferred', type IN ('fact','entity'))
    this.stmtGetClusterableNodes = db.prepare(
      "SELECT id, embedding FROM node " +
      "WHERE tombstoned = 0 AND origin != 'inferred' " +
      "AND type IN ('fact','entity') AND embedding IS NOT NULL"
    );

    // Live schema nodes — same as SchemaRelationDeriver.stmtGetSchemaNodes
    this.stmtGetSchemaNodes = db.prepare(
      "SELECT id, value FROM node WHERE type = 'schema' AND tombstoned = 0"
    );

    // Schema members with their node values (for mass + noise-fraction computation, D-07).
    // D-37 firewall (CR-01): exclude origin='inferred' here too — must match the centroid
    // query (stmtGetClusterableNodes) so inferred output cannot inflate a schema's mass or
    // dilute its noise fraction across the promotion gate (self-confirmation guard).
    this.stmtGetSchemaMembersWithValues = db.prepare(
      "SELECT e.dst as id, n.value as value FROM edge e " +
      "JOIN node n ON n.id = e.dst " +
      "WHERE e.src = ? AND e.kind = 'abstracts' " +
      "AND n.type IN ('fact','entity') AND n.tombstoned = 0 AND n.origin != 'inferred'"
    );

    // Find existing live doc stub for a schema (via node_scope.scope = schemaId)
    this.stmtGetLiveDocForSlug = db.prepare(
      "SELECT n.id FROM node n " +
      "JOIN node_scope ns ON ns.node_id = n.id " +
      "WHERE n.type = 'doc' AND n.tombstoned = 0 AND ns.scope = ? " +
      "LIMIT 1"
    );

    // D-04 wipe-and-rebuild: delete ALL prior doc-corpus edges (not scoped to a schema)
    // so the derived cache is rebuilt from scratch on every pass (idempotency + correctness)
    this.stmtWipeDocContainment = db.prepare(
      "DELETE FROM edge WHERE kind = 'doc_containment'"
    );
    this.stmtWipeDocReference = db.prepare(
      "DELETE FROM edge WHERE kind = 'doc_reference'"
    );

    // FTS suppression for new doc stubs (mirrors doc-writer.ts pattern)
    this.stmtFtsDelete = db.prepare('DELETE FROM node_fts WHERE node_id = ?');

    // promoteScope: schemas where at least one D-37-gated abstracts member has node_scope = ?
    // Same D-37 firewall: tombstoned=0, origin!='inferred', type IN ('fact','entity')
    this.stmtGetSchemasInScope = db.prepare(
      "SELECT DISTINCT e.src as schemaId FROM edge e " +
      "JOIN node m ON m.id = e.dst " +
      "JOIN node_scope ns ON ns.node_id = m.id " +
      "WHERE e.kind = 'abstracts' " +
      "AND m.type IN ('fact','entity') AND m.tombstoned = 0 AND m.origin != 'inferred' " +
      "AND ns.scope = ? " +
      "AND EXISTS (SELECT 1 FROM node s WHERE s.id = e.src AND s.type = 'schema' AND s.tombstoned = 0)"
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Run the D-04 idempotent promotion pass.
   *
   * Phase A (async-free, read-only): mass computation, noise filter, hysteresis, centroid
   *   derivation (SREL-01 math verbatim), cosine+mass ladder derivation.
   * Phase B (one db.transaction().immediate(), NO await inside — T-02-ASYNC):
   *   eager doc stubs for newly promoted schemas, tombstone for demoted ones,
   *   wipe+rebuild doc_containment + doc_reference edges.
   *
   * @param opts dryRun: return counts without writing (default: false)
   */
  async promote(opts: { dryRun?: boolean } = {}): Promise<PromoteResult> {
    const { dryRun = false } = opts;
    const now = this.clock.nowMs();
    const { highMass, lowMass, noiseCap, corpusCosineThreshold, massGapMin, minMembers } = this.opts;

    // ── Phase A: read-only analysis ───────────────────────────────────────

    // Build clusterableById from the D-37-gated query (Pitfall 5: byteOffset decode)
    const clusterableRows = this.stmtGetClusterableNodes.all() as Array<{
      id: string;
      embedding: Buffer;
    }>;
    const clusterableById = new Map<string, Buffer>();
    for (const row of clusterableRows) {
      clusterableById.set(row.id, row.embedding);
    }

    // Get all live schema nodes
    const schemaNodes = this.stmtGetSchemaNodes.all() as Array<{ id: string; value: string }>;

    // Per-schema: mass + noise_frac + centroid + existing doc stub
    interface SchemaInfo {
      id: string;
      value: string;
      mass: number;         // COUNT(DISTINCT live fact|entity members)
      noiseFrac: number;    // fraction of members that are noise tokens
      centroid: Float32Array | null;
      existingDocId: string | null;
    }

    const schemaInfos: SchemaInfo[] = [];

    for (const schema of schemaNodes) {
      // Get live fact/entity members WITH values (for noise detection)
      const members = this.stmtGetSchemaMembersWithValues.all(schema.id) as Array<{
        id: string;
        value: string;
      }>;

      const mass = members.length;
      if (mass === 0) continue; // empty schema — skip entirely

      // Noise fraction (D-07): fraction of members matching NOISE_PATTERNS
      const noiseCount = members.filter(m => isNoiseMember(m.value)).length;
      const noiseFrac = noiseCount / mass;

      // Centroid computation — verbatim from SchemaRelationDeriver (schema-relations.ts:285-310)
      // Pitfall 5: Float32Array decoded with byteOffset + byteLength/4 (never bare Buffer)
      const memberVecs: Float32Array[] = [];
      for (const member of members) {
        const embBuf = clusterableById.get(member.id);
        if (!embBuf) continue; // not in gated set (inferred/tombstoned/null-embedding/schema-type)
        memberVecs.push(
          new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4)
        );
      }

      let centroid: Float32Array | null = null;
      if (memberVecs.length > 0) {
        const dims = memberVecs[0]!.length;
        centroid = new Float32Array(dims);
        for (const vec of memberVecs) {
          for (let i = 0; i < dims; i++) {
            centroid[i]! += vec[i]!;
          }
        }
        for (let i = 0; i < dims; i++) {
          centroid[i]! /= memberVecs.length;
        }
      }

      // Check for an existing live doc stub
      const existingDocRow = this.stmtGetLiveDocForSlug.get(schema.id) as
        | { id: string }
        | undefined;
      const existingDocId = existingDocRow?.id ?? null;

      schemaInfos.push({
        id: schema.id,
        value: schema.value,
        mass,
        noiseFrac,
        centroid,
        existingDocId,
      });
    }

    // D-06/D-07/D-05: Promotion gate
    // A schema is PROMOTED if:
    //   (a) mass >= highMass AND noiseFrac < noiseCap  [new promotion]
    //   (b) mass >= lowMass AND noiseFrac < noiseCap AND existingDocId != null  [hysteresis keep]
    //
    // A schema is DEMOTED (its doc tombstoned) if:
    //   mass < lowMass AND existingDocId != null
    const promotedSchemas: SchemaInfo[] = [];
    const demotedDocIds: string[] = [];

    for (const info of schemaInfos) {
      const isClean = info.noiseFrac < noiseCap;

      if (!isClean) {
        // Noise schema: if it has a doc stub, tombstone it (it shouldn't have gotten in)
        if (info.existingDocId) {
          demotedDocIds.push(info.existingDocId);
        }
        continue;
      }

      if (info.mass >= highMass) {
        // (a) Above high-water mark → promote
        promotedSchemas.push(info);
      } else if (info.mass >= lowMass && info.existingDocId) {
        // (b) Hysteresis: in band [lowMass, highMass) with existing doc → keep
        promotedSchemas.push(info);
      } else if (info.mass < lowMass && info.existingDocId) {
        // Below low-water mark with existing doc → tombstone (demote)
        demotedDocIds.push(info.existingDocId);
      }
      // else: below lowMass, no doc → nothing to do
    }

    // ── Cosine+mass ladder derivation (D-01R/D-02R) ───────────────────────
    // For each promoted-schema pair: cosineSimF32(centroidA, centroidB)
    // If sim >= corpusCosineThreshold AND both have >= minMembers:
    //   - mass gap >= massGapMin → CONTAINMENT candidate (larger-mass = parent)
    //   - mass gap < massGapMin → REFERENCE candidate
    //
    // Forest rule (D-02R): each child keeps only its single strongest (highest-sim) parent

    // Filter to schemas with valid centroids and minMembers floor
    const schemasForLadder = promotedSchemas.filter(
      s => s.centroid !== null && s.mass >= minMembers
    );

    interface ContainmentCandidate {
      parentSchemaId: string;
      childSchemaId: string;
      sim: number;
    }

    interface ReferenceCandidate {
      schemaIdA: string;
      schemaIdB: string;
      sim: number;
    }

    // Best parent for each child (single strongest cosine-connected parent → forest)
    // Map: childSchemaId → { parentSchemaId, sim }
    const bestParent = new Map<string, { parentSchemaId: string; sim: number }>();
    const referencePairs: ReferenceCandidate[] = [];

    for (let i = 0; i < schemasForLadder.length; i++) {
      const a = schemasForLadder[i]!;
      for (let j = i + 1; j < schemasForLadder.length; j++) {
        const b = schemasForLadder[j]!;

        const sim = cosineSimF32(a.centroid!, b.centroid!);
        if (sim < corpusCosineThreshold) continue;

        const massGap = Math.abs(a.mass - b.mass);

        if (massGap >= massGapMin) {
          // CONTAINMENT direction: larger-mass = parent, smaller-mass = child
          const parent = a.mass >= b.mass ? a : b;
          const child = a.mass >= b.mass ? b : a;

          // Forest rule: keep only the strongest parent per child
          const existing = bestParent.get(child.id);
          if (!existing || sim > existing.sim) {
            bestParent.set(child.id, { parentSchemaId: parent.id, sim });
          }
        } else {
          // REFERENCE: cosine-connected, equal-ish mass
          referencePairs.push({ schemaIdA: a.id, schemaIdB: b.id, sim });
        }
      }
    }

    // Containment candidates from bestParent map
    const containmentCandidates: ContainmentCandidate[] = [];
    for (const [childSchemaId, { parentSchemaId, sim }] of bestParent) {
      containmentCandidates.push({ parentSchemaId, childSchemaId, sim });
    }

    // dryRun: return counts without writing
    if (dryRun) {
      return {
        promoted: promotedSchemas.map(s => s.id),
        containment: containmentCandidates.length,
        reference: referencePairs.length,
        tombstoned: demotedDocIds.length,
      };
    }

    // ── Phase B: atomic write (single db.transaction().immediate()) ───────
    // T-02-ASYNC: NO await inside the transaction body — all async work done in Phase A

    // Map from schemaId → docId (for writing corpus edges)
    // Populated during Phase B by looking up or creating doc stubs
    const schemaToDocId = new Map<string, string>();

    this.db.transaction(() => {
      // 0. Tombstone demoted doc stubs (mass < lowMass fell below the band)
      for (const docId of demotedDocIds) {
        this.store.tombstone(docId);
      }

      // 1. Create eager doc stubs for newly promoted schemas (no existing doc)
      //    Lifecycle-exempt: origin='inferred', s=0, c=1.0, no embed, FTS-suppressed
      //    slug = schemaId (Pitfall 4 — schemaId is the anchor, not the human label)
      for (const info of promotedSchemas) {
        if (info.existingDocId) {
          // Already has a live stub — use it
          schemaToDocId.set(info.id, info.existingDocId);
          continue;
        }

        // Create a new lifecycle-exempt doc stub
        // D-03: this is a TYPE='doc' node — Pitfall 6: do NOT touch the source schema
        const docId = newId();

        // Step 1: upsertNode (type='doc', origin='inferred' → training_eligible=0, s=0)
        this.store.upsertNode({
          id: docId,
          type: 'doc',
          value: '',          // empty stub — prose generated lazily on first /doc?slug= access
          origin: 'inferred',
          s: 0,               // lifecycle-exempt: no Hebbian contribution
          c: 1.0,
          last_access: now,
        });

        // Step 2: FTS suppression — delete from node_fts immediately (mirrors doc-writer)
        // The empty stub must not pollute BM25 keyword search (Pitfall 7)
        this.stmtFtsDelete.run(docId);

        // Step 3: node_doc sidecar (slug = schemaId, Pitfall 4)
        this.store.upsertNodeDoc({
          node_id: docId,
          slug: info.id,    // schemaId as slug — Pitfall 4 (not the human label)
          generated_at: now,
          updated_at: now,
        });

        // Step 4: node_scope (scope = schemaId for provenance)
        this.store.upsertNodeScope({
          node_id: docId,
          scope: info.id,
          updated_at: now,
        });

        schemaToDocId.set(info.id, docId);
      }

      // 2. Wipe ALL prior doc_containment + doc_reference edges (D-04 wipe-and-rebuild)
      //    Idempotent: next pass rebuilds from scratch; a crash mid-wipe leaves an empty
      //    derived cache that is correctly rebuilt on the next pass
      this.stmtWipeDocContainment.run();
      this.stmtWipeDocReference.run();

      // 3. Rebuild doc_containment edges (D-01R: parent→child, directed)
      //    D-03: src and dst are BOTH doc node ids — never schema ids (self-confirmation guard)
      for (const { parentSchemaId, childSchemaId, sim } of containmentCandidates) {
        const parentDocId = schemaToDocId.get(parentSchemaId);
        const childDocId = schemaToDocId.get(childSchemaId);
        if (!parentDocId || !childDocId) continue; // shouldn't happen; defensive skip

        // Pitfall 6: src/dst are doc node ids — source schemas never gain edges here
        this.store.upsertEdge({
          src: parentDocId,   // parent DOC
          dst: childDocId,    // child DOC
          rel: 'doc_containment',
          kind: 'doc_containment',
          w: sim,
          last_access: now,
        });
      }

      // 4. Rebuild doc_reference edges (D-02R: undirected, cosine-connected equal-mass pairs)
      //    D-03: both endpoints are doc node ids only
      for (const { schemaIdA, schemaIdB, sim } of referencePairs) {
        const docIdA = schemaToDocId.get(schemaIdA);
        const docIdB = schemaToDocId.get(schemaIdB);
        if (!docIdA || !docIdB) continue; // defensive skip

        // Stable ordering (lexicographic by doc id) for deterministic idempotency
        const [srcId, dstId] = docIdA < docIdB ? [docIdA, docIdB] : [docIdB, docIdA];

        // Pitfall 6: src/dst are doc node ids — source schemas never gain edges
        this.store.upsertEdge({
          src: srcId!,
          dst: dstId!,
          rel: 'doc_reference',
          kind: 'doc_reference',
          w: sim,
          last_access: now,
        });
      }
    }).immediate(); // M-5: write-lock discipline — avoid SQLITE_BUSY_SNAPSHOT in WAL mode

    return {
      promoted: promotedSchemas.map(s => s.id),
      containment: containmentCandidates.length,
      reference: referencePairs.length,
      tombstoned: demotedDocIds.length,
    };
  }

  /**
   * Scope-anchored always-promote bypass (D-04, Plan 32-02).
   *
   * For a given project scope S:
   *  - Identifies all schemas whose gated abstracts members (tombstoned=0, origin!='inferred',
   *    type IN ('fact','entity')) carry node_scope = S.
   *  - Force-promotes those schemas' chapter-doc stubs AND a landing-doc stub (slug = S),
   *    bypassing the mass/noise gate STRICTLY for scope S.
   *  - Writes doc_containment edges from the landing doc (parent) to each chapter doc (child).
   *
   * HARD BOUNDS (D-04):
   *  - GLOBAL_SCOPE / empty string → early return with empty result (never force-promote global).
   *  - Global and conversation-induced schemas (scoped to 'global') are NOT included.
   *  - Does NOT modify promote() or its mass-hysteresis gate.
   *  - Does NOT wipe the global doc_containment cache (organic promote() owns wipe-and-rebuild).
   *    Instead, landing→chapter edges are re-written on every promoteScope call (idempotent).
   *
   * D-43 self-confirmation guard: writes ONLY type='doc' nodes + doc→doc edges.
   * T-02-ASYNC: Phase B is a single this.db.transaction().immediate() with NO await inside.
   * Idempotent: stubs are looked up by slug before creation; existing stubs are reused.
   *
   * @param scope  The project scope string (e.g. 'usage', 'brain-memory').
   * @param opts   dryRun: return counts without writing (default false).
   */
  async promoteScope(scope: string, opts: { dryRun?: boolean } = {}): Promise<PromoteResult> {
    const { dryRun = false } = opts;

    // D-04 bound: never force-promote GLOBAL_SCOPE or empty scope
    if (!scope || scope === GLOBAL_SCOPE) {
      return { promoted: [], containment: 0, reference: 0, tombstoned: 0 };
    }

    const now = this.clock.nowMs();

    // ── Phase A (read-only): identify S's induced schemas ──────────────────
    // A schema is in scope S iff at least one of its D-37-gated abstracts members
    // (tombstoned=0, origin!='inferred', type IN ('fact','entity')) has node_scope = S.
    const scopedSchemaRows = this.stmtGetSchemasInScope.all(scope) as { schemaId: string }[];
    const scopedSchemaIds = scopedSchemaRows.map(r => r.schemaId);

    // Look up existing chapter-doc stubs for each in-scope schema
    const existingChapterDocIds = new Map<string, string>(); // schemaId → docId
    for (const schemaId of scopedSchemaIds) {
      const existing = this.stmtGetLiveDocForSlug.get(schemaId) as { id: string } | undefined;
      if (existing) {
        existingChapterDocIds.set(schemaId, existing.id);
      }
    }

    // Look up existing landing-doc stub (slug = scope string)
    const existingLandingRow = this.stmtGetLiveDocForSlug.get(scope) as { id: string } | undefined;
    const existingLandingDocId = existingLandingRow?.id ?? null;

    // promoted list = in-scope schema ids + the landing slug
    const promotedIds = [...scopedSchemaIds, scope];

    if (dryRun) {
      return {
        promoted: promotedIds,
        containment: scopedSchemaIds.length, // one landing→chapter edge per in-scope schema
        reference: 0,
        tombstoned: 0,
      };
    }

    // ── Phase B: atomic write (single db.transaction().immediate()) ──────────
    // T-02-ASYNC: NO await inside — all async work is done in Phase A above.

    const chapterDocIds = new Map<string, string>(); // schemaId → docId (for containment edges)
    let landingDocId: string;

    this.db.transaction(() => {
      // 1. Create chapter-doc stubs for each in-scope schema that lacks one.
      //    MIRROR the existing eager-stub block exactly (lines 419-461 of promote()).
      //    D-03 / Pitfall 6: writes ONLY type='doc' nodes, never touches source schemas.
      for (const schemaId of scopedSchemaIds) {
        const existingId = existingChapterDocIds.get(schemaId);
        if (existingId) {
          // Reuse existing stub (idempotent)
          chapterDocIds.set(schemaId, existingId);
          continue;
        }

        const docId = newId();

        this.store.upsertNode({
          id: docId,
          type: 'doc',
          value: '',          // empty stub — prose filled by generateCorpusDocs
          origin: 'inferred',
          s: 0,               // lifecycle-exempt: no Hebbian contribution
          c: 1.0,
          last_access: now,
        });

        this.stmtFtsDelete.run(docId);

        // node_doc: slug = schemaId (Pitfall 4 — schema chapters slug by schemaId, not label)
        this.store.upsertNodeDoc({
          node_id: docId,
          slug: schemaId,
          generated_at: now,
          updated_at: now,
        });

        // node_scope: scope = schemaId (chapter doc provenance = its schema)
        this.store.upsertNodeScope({
          node_id: docId,
          scope: schemaId,
          updated_at: now,
        });

        chapterDocIds.set(schemaId, docId);
      }

      // 2. Create (or reuse) landing-doc stub (slug = scope string, NOT a schemaId).
      //    Pitfall 4 distinction: the landing doc slug = the project scope string ('usage', etc.),
      //    unlike chapter docs whose slug = schemaId.
      if (existingLandingDocId) {
        landingDocId = existingLandingDocId;
      } else {
        const newLandingId = newId();

        this.store.upsertNode({
          id: newLandingId,
          type: 'doc',
          value: '',          // empty stub
          origin: 'inferred',
          s: 0,
          c: 1.0,
          last_access: now,
        });

        this.stmtFtsDelete.run(newLandingId);

        // node_doc: slug = scope string (the project scope is the landing doc's identifier)
        this.store.upsertNodeDoc({
          node_id: newLandingId,
          slug: scope,
          generated_at: now,
          updated_at: now,
        });

        // node_scope: scope = scope string
        this.store.upsertNodeScope({
          node_id: newLandingId,
          scope: scope,
          updated_at: now,
        });

        landingDocId = newLandingId;
      }

      // 3. Write landing→chapter doc_containment edges.
      //    D-03 / Pitfall 6: src = landing doc id, dst = chapter doc id (both type='doc').
      //    promoteScope is ADDITIVE — it does NOT wipe the global doc_containment cache
      //    (organic promote() owns wipe-and-rebuild). We re-add these edges on every call
      //    so they survive the next organic promote() wipe-and-rebuild (idempotent, w=1.0).
      for (const [, chapterDocId] of chapterDocIds) {
        this.store.upsertEdge({
          src: landingDocId,        // parent: landing doc
          dst: chapterDocId,        // child: chapter doc
          rel: 'doc_containment',
          kind: 'doc_containment',
          w: 1.0,                   // deterministic onboarding spine, not a cosine relation
          last_access: now,
        });
      }
    }).immediate();

    return {
      promoted: promotedIds,
      containment: chapterDocIds.size, // number of landing→chapter edges written
      reference: 0,
      tombstoned: 0,
    };
  }
}
