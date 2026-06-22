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
import type { EngineConfig } from '../lib/config';
import type { SemanticStore } from '../db/semantic-store';
import type { ModelProvider } from '../model/provider';
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

// ---------------------------------------------------------------------------
// normalizeSubjectName — slug normalization helper (Pattern 3 / RESEARCH)
// ---------------------------------------------------------------------------

/**
 * Normalize an LLM-proposed subject name to a stable slug segment.
 * Rule: lowercase → replace non-alphanumeric runs with '-' → trim leading/trailing '-'.
 * Examples: "Sleep Pass" → "sleep-pass"; "Config & Tuning" → "config-tuning"
 */
export function normalizeSubjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// SubjectPromoter types
// ---------------------------------------------------------------------------

export interface SubjectPromoteResult {
  /** Subjects proposed by Stage-2 LLM call (all, including existing+refresh). */
  proposed: Array<{ name: string; relatedSchemaIds: string[] }>;
  /** Count of truly new subject stubs created. */
  created: number;
  /** Subject slugs that already existed and have been queued for refresh. */
  refreshQueued: string[];
  /** Doc node id of the hub stub (slug = scope), or null if scope guard fired early. */
  hubDocId: string | null;
  /** Doc node ids of newly created subject stubs. */
  subjectDocIds: string[];
}

// ---------------------------------------------------------------------------
// SubjectPromoter
// ---------------------------------------------------------------------------

/**
 * SubjectPromoter — D-02/D-03/D-05/D-06 exhaust-gate subject promotion (Phase 39.1-02).
 *
 * Implements the two-stage promotion engine for project-hub + LLM-named subject docs:
 *
 * Stage 1 (LLM-free, read-only):
 *   - CREATE gate: for each candidate scope schema, check if mass >= threshold AND no
 *     existing live subject doc for its prospective slug.
 *   - REFRESH gate: for an existing subject doc, count abstracts members with
 *     last_access > node_doc.generated_at >= corpusSubjectDriftThreshold.
 *   - D-37 firewall on ALL member queries (origin!='inferred').
 *   - D-43 guard: inferred members NEVER contribute to mass or drift counts.
 *
 * Stage 2 (one LLM call per scope, only if a gate is open):
 *   - Calls provider.generate once with top-N schemas by mass as input.
 *   - Prompt anchors against existing subject slugs (idempotency, Pitfall 1).
 *   - Names length-bounded to 200 chars (Security V5).
 *   - Response: JSON [{name, relatedSchemaIds}]. Each accepted subject either matches
 *     an existing slug (→ REFRESH queued) or is genuinely new (→ CREATE stub).
 *
 * Phase C (single IMMEDIATE transaction, NO await inside):
 *   - Creates hub stub (slug = scope).
 *   - Creates each new subject stub (slug = scope:name).
 *   - Writes hub→subject doc_containment edges (fill-in-place).
 *   - Persists subject-schema-ids:<subjectSlug> meta key per subject (Plan 03 contract).
 *   - All stubs stay empty (value=''); FTS-suppressed; origin='inferred'.
 *
 * Threat mitigations:
 *   - T-39.1-04: LLM subject names length-bounded, treated as labels, never executed.
 *   - T-39.1-05: D-37 firewall on every member/drift query.
 *   - T-39.1-06: hub stub + subject stubs created in one IMMEDIATE transaction; stubs empty.
 */
export class SubjectPromoter {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly clock: Clock;
  private readonly provider: ModelProvider;
  private readonly config: Pick<EngineConfig, 'corpusSubjectDriftThreshold'>;

  // Prepared statements (T-01-SQL: compiled once in constructor)

  /** Members of a schema with D-37 firewall (excludes inferred). Used for mass gate. */
  private readonly stmtGetSchemaMembersInScope: Database.Statement;
  /** Count of members touched after doc.generated_at (REFRESH drift gate). */
  private readonly stmtDriftCount: Database.Statement;
  /** Find live doc node by slug (node_doc.slug column). */
  private readonly stmtGetLiveDocBySlug: Database.Statement;
  /** All live subject doc slugs for a scope (scope:* prefix, not bare scope slug). */
  private readonly stmtGetExistingSubjectSlugs: Database.Statement;
  /** Schemas in scope sorted by member count desc (for top-N proposal input). */
  private readonly stmtGetSchemasInScopeWithMass: Database.Statement;
  /** FTS suppression (mirrors CorpusPromoter). */
  private readonly stmtFtsDelete: Database.Statement;

  constructor(
    db: Database.Database,
    store: SemanticStore,
    clock: Clock,
    provider: ModelProvider,
    config: Pick<EngineConfig, 'corpusSubjectDriftThreshold'>,
  ) {
    this.db = db;
    this.store = store;
    this.clock = clock;
    this.provider = provider;
    this.config = config;

    // D-37 firewall: members for a schema in a scope, non-inferred, for mass computation.
    // We need two constraints: the edge kind + destination node filter + scope membership.
    this.stmtGetSchemaMembersInScope = db.prepare(`
      SELECT DISTINCT m.id
      FROM edge e
      JOIN node m ON m.id = e.dst
        AND m.type IN ('fact','entity')
        AND m.tombstoned = 0
        AND m.origin != 'inferred'
      JOIN node_scope ns ON ns.node_id = m.id AND ns.scope = ?
      WHERE e.src = ? AND e.kind = 'abstracts'
    `);

    // REFRESH drift gate: count of abstracts members touched after generated_at.
    // D-37 firewall: origin!='inferred', tombstoned=0, type IN ('fact','entity').
    this.stmtDriftCount = db.prepare(`
      SELECT COUNT(*) AS driftCount
      FROM edge e
      JOIN node m ON m.id = e.dst
        AND m.type IN ('fact','entity')
        AND m.tombstoned = 0
        AND m.origin != 'inferred'
        AND m.last_access > ?
      WHERE e.src = ? AND e.kind = 'abstracts'
    `);

    // Look up a live doc node by slug (node_doc.slug = ?).
    this.stmtGetLiveDocBySlug = db.prepare(`
      SELECT n.id, nd.generated_at
      FROM node n
      JOIN node_doc nd ON nd.node_id = n.id
      WHERE n.type = 'doc' AND n.tombstoned = 0 AND nd.slug = ?
      LIMIT 1
    `);

    // Existing live subject doc slugs for this scope: slugs matching 'scope:%'.
    // Excludes the bare scope hub slug and UUID chapter slugs (which don't have ':' prefix).
    this.stmtGetExistingSubjectSlugs = db.prepare(`
      SELECT nd.slug
      FROM node n
      JOIN node_doc nd ON nd.node_id = n.id
      WHERE n.type = 'doc' AND n.tombstoned = 0
        AND nd.slug LIKE ? ESCAPE '\\'
    `);

    // Schemas in scope ordered by member mass desc (for top-20 proposal input).
    // D-37 firewall applied to member counts.
    this.stmtGetSchemasInScopeWithMass = db.prepare(`
      SELECT s.id AS schemaId, s.value AS schemaLabel,
             COUNT(DISTINCT m.id) AS memberCount
      FROM node s
      JOIN edge e ON e.src = s.id AND e.kind = 'abstracts'
      JOIN node m ON m.id = e.dst
        AND m.type IN ('fact','entity')
        AND m.tombstoned = 0
        AND m.origin != 'inferred'
      JOIN node_scope ns ON ns.node_id = m.id AND ns.scope = ?
      WHERE s.type = 'schema' AND s.tombstoned = 0
      GROUP BY s.id, s.value
      ORDER BY memberCount DESC
      LIMIT 20
    `);

    // FTS suppression (mirrors CorpusPromoter / doc-writer.ts pattern)
    this.stmtFtsDelete = db.prepare('DELETE FROM node_fts WHERE node_id = ?');
  }

  // ── Private: Stage-1 gate helpers ──────────────────────────────────────────

  /**
   * Evaluate the Stage-1 gates for a scope.
   * Returns: createGateOpen (any schema crosses mass threshold with no existing subject doc)
   *          and refreshGateOpen (any existing subject doc has drift >= threshold).
   * LLM-free — only SQL reads (D-05).
   */
  private evaluateStage1Gates(
    scope: string,
    existingSubjectSlugs: string[],
    schemas: Array<{ schemaId: string; schemaLabel: string; memberCount: number }>,
    driftThreshold: number,
  ): { createGateOpen: boolean; refreshGateOpen: boolean } {
    const minMass = 4; // minMembers floor for CREATE gate (mirrors CorpusPromoter.minMembers)

    let createGateOpen = false;
    let refreshGateOpen = false;

    // CREATE gate: schema meets mass threshold AND no existing subject doc for its slug.
    for (const schema of schemas) {
      if (schema.memberCount < minMass) continue;

      const subjectSlug = `${scope}:${normalizeSubjectName(schema.schemaLabel)}`;
      if (!existingSubjectSlugs.includes(subjectSlug)) {
        createGateOpen = true;
        break; // found at least one CREATE candidate — no need to scan further
      }
    }

    // REFRESH gate: for each existing subject doc, check if drift >= threshold.
    // Evaluated independently of minMass — an existing subject can drift regardless of
    // whether its underlying schemas still meet the mass floor.
    if (!refreshGateOpen) {
      // Build a map from normalized slug suffix → schema for drift lookup.
      const slugToSchema = new Map<string, (typeof schemas)[0]>();
      for (const schema of schemas) {
        const subjectSlug = `${scope}:${normalizeSubjectName(schema.schemaLabel)}`;
        slugToSchema.set(subjectSlug, schema);
      }

      for (const subjectSlug of existingSubjectSlugs) {
        const schema = slugToSchema.get(subjectSlug);
        if (!schema) continue; // slug exists but no matching schema in scope — skip

        const docRow = this.stmtGetLiveDocBySlug.get(subjectSlug) as
          | { id: string; generated_at: number }
          | undefined;
        if (!docRow) continue;

        const drift = (
          this.stmtDriftCount.get(docRow.generated_at, schema.schemaId) as
          | { driftCount: number }
          | undefined
        )?.driftCount ?? 0;

        if (drift >= driftThreshold) {
          refreshGateOpen = true;
          break;
        }
      }
    }

    return { createGateOpen, refreshGateOpen };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run the exhaust-gate subject promotion for a scope.
   *
   * Phase A (LLM-free, read-only): evaluate Stage-1 CREATE + REFRESH gates.
   * Phase B (LLM call, only when a gate is open): propose subjects via provider.generate.
   * Phase C (single IMMEDIATE transaction, NO await inside): create hub + subject stubs,
   *   write hub→subject doc_containment edges, persist subject-schema-ids meta.
   *
   * @param scope Project scope string (e.g. 'brain-memory').
   * @returns SubjectPromoteResult with created stubs, refresh queue, hub/subject doc ids.
   */
  async promoteSubjects(scope: string): Promise<SubjectPromoteResult> {
    const emptyResult: SubjectPromoteResult = {
      proposed: [],
      created: 0,
      refreshQueued: [],
      hubDocId: null,
      subjectDocIds: [],
    };

    // D-04 guard: never promote GLOBAL_SCOPE or empty scope
    if (!scope || scope === GLOBAL_SCOPE) {
      return emptyResult;
    }

    const driftThreshold = this.config.corpusSubjectDriftThreshold;

    // ── Phase A: Stage-1 LLM-free gates ────────────────────────────────────

    // Get schemas in scope sorted by mass (top-20 for proposal input)
    const schemas = this.stmtGetSchemasInScopeWithMass.all(scope) as Array<{
      schemaId: string;
      schemaLabel: string;
      memberCount: number;
    }>;

    if (schemas.length === 0) {
      return emptyResult;
    }

    // Get existing subject doc slugs for this scope (scope:* pattern)
    const escapedScope = scope.replace(/[%_\\]/g, '\\$&');
    const existingSubjectRows = this.stmtGetExistingSubjectSlugs.all(
      `${escapedScope}:%`
    ) as Array<{ slug: string }>;
    const existingSubjectSlugs = existingSubjectRows.map(r => r.slug);

    const { createGateOpen, refreshGateOpen } = this.evaluateStage1Gates(
      scope,
      existingSubjectSlugs,
      schemas,
      driftThreshold,
    );

    // D-05: if no gate is open, return without an LLM call
    if (!createGateOpen && !refreshGateOpen) {
      return emptyResult;
    }

    // ── Phase B: Stage-2 subject-proposal LLM call ─────────────────────────

    // Build the subject-names list from existing slugs (strip the 'scope:' prefix)
    const existingSubjectNames = existingSubjectSlugs.map(s => s.slice(scope.length + 1));

    // Prompt: top-N schemas as label:memberCount lines
    const schemaInputLines = schemas
      .map(s => `${s.schemaLabel}: ${s.memberCount}`)
      .join('\n');

    const anchorBlock = existingSubjectNames.length > 0
      ? `EXISTING SUBJECTS (do NOT rename these): ${existingSubjectNames.join(', ')}\n\n`
      : '';

    const proposalPrompt = `You are categorizing memory schemas for the project "${scope}" into named subject areas.

${anchorBlock}SCHEMAS (label: member count):
${schemaInputLines}

Propose a small set of named subject areas (3-8) that group these schemas into coherent topics. For each subject, list the schema IDs that belong to it.

Output ONLY valid JSON (no markdown, no explanation):
[{"name": "subject-name-hyphenated", "relatedSchemaIds": ["uuid1", "uuid2"]}]`;

    const md = await this.provider.generate(proposalPrompt, { maxTokens: 2000 });
    if (md.trim().length === 0) {
      throw new Error(`SubjectPromoter: subject-proposal for scope "${scope}" returned empty output`);
    }

    // Parse the JSON response
    let rawProposals: Array<{ name: string; relatedSchemaIds: string[] }>;
    try {
      const jsonStr = md.trim().replace(/^```json\s*|^```\s*|```\s*$/g, '').trim();
      rawProposals = JSON.parse(jsonStr);
      if (!Array.isArray(rawProposals)) throw new Error('not an array');
    } catch {
      throw new Error(`SubjectPromoter: subject-proposal JSON parse failed for scope "${scope}": ${md.slice(0, 200)}`);
    }

    // Validate and normalize each proposed subject
    const MAX_NAME_LEN = 200; // Security V5 — length-bound subject names
    const schemaIdSet = new Set(schemas.map(s => s.schemaId));

    interface AcceptedSubject {
      name: string;
      normalizedName: string;
      subjectSlug: string;
      relatedSchemaIds: string[];
      isNew: boolean;
    }

    const accepted: AcceptedSubject[] = [];
    const seenSlugs = new Set<string>();

    for (const proposal of rawProposals) {
      if (!proposal || typeof proposal.name !== 'string') continue;

      const name = proposal.name.trim();
      if (!name || name.length > MAX_NAME_LEN) continue;

      const normalizedName = normalizeSubjectName(name);
      if (!normalizedName) continue;

      const subjectSlug = `${scope}:${normalizedName}`;
      if (seenSlugs.has(subjectSlug)) continue; // deduplicate proposals
      seenSlugs.add(subjectSlug);

      // Filter relatedSchemaIds to only include schemas that exist in scope
      const relatedSchemaIds = Array.isArray(proposal.relatedSchemaIds)
        ? proposal.relatedSchemaIds.filter(
            (id): id is string => typeof id === 'string' && schemaIdSet.has(id)
          )
        : [];

      const isNew = !existingSubjectSlugs.includes(subjectSlug);

      accepted.push({ name, normalizedName, subjectSlug, relatedSchemaIds, isNew });
    }

    if (accepted.length === 0) {
      return emptyResult;
    }

    // ── Phase C: atomic write (single IMMEDIATE transaction, NO await inside) ────

    const now = this.clock.nowMs();

    // Look up hub stub (slug = scope)
    const existingHubRow = this.stmtGetLiveDocBySlug.get(scope) as
      | { id: string; generated_at: number }
      | undefined;

    // Prepare new subject creation data (read existing subject docs before transaction)
    const existingSubjectDocs = new Map<string, string>(); // subjectSlug → docId
    for (const slug of existingSubjectSlugs) {
      const row = this.stmtGetLiveDocBySlug.get(slug) as { id: string } | undefined;
      if (row) existingSubjectDocs.set(slug, row.id);
    }

    let hubDocId: string = ''; // assigned inside transaction — TypeScript flow guard
    const newSubjectDocIds: string[] = [];
    const refreshQueued: string[] = [];

    this.db.transaction(() => {
      // 1. Create (or reuse) hub stub (slug = scope).
      //    Hub stays empty — prose filled by Plan 03's generateDocForHub.
      if (existingHubRow) {
        hubDocId = existingHubRow.id;
      } else {
        hubDocId = newId();
        this.store.upsertNode({
          id: hubDocId,
          type: 'doc',
          value: '',          // empty stub — fill-in-place (BUG-2c / Pitfall 2)
          origin: 'inferred',
          s: 0,
          c: 1.0,
          last_access: now,
        });
        this.stmtFtsDelete.run(hubDocId);
        this.store.upsertNodeDoc({
          node_id: hubDocId,
          slug: scope,
          generated_at: now,
          updated_at: now,
        });
        this.store.upsertNodeScope({
          node_id: hubDocId,
          scope: scope,
          updated_at: now,
        });
      }

      // 2. Create new subject stubs; mark existing as refresh-queued.
      for (const subject of accepted) {
        if (!subject.isNew) {
          // Existing subject: queue for refresh (no new stub)
          refreshQueued.push(subject.subjectSlug);
        } else {
          // New subject: create stub (slug = scope:name, scope annotation = scope string)
          // D-03 demotion: scope = project scope string, NOT a schemaId
          const docId = newId();
          this.store.upsertNode({
            id: docId,
            type: 'doc',
            value: '',          // empty stub — prose filled by Plan 03
            origin: 'inferred',
            s: 0,
            c: 1.0,
            last_access: now,
          });
          this.stmtFtsDelete.run(docId);
          this.store.upsertNodeDoc({
            node_id: docId,
            slug: subject.subjectSlug,
            generated_at: now,
            updated_at: now,
          });
          this.store.upsertNodeScope({
            node_id: docId,
            scope: scope,       // project scope, NOT schemaId (D-03)
            updated_at: now,
          });
          existingSubjectDocs.set(subject.subjectSlug, docId);
          newSubjectDocIds.push(docId);
        }

        // 3. Persist subject-schema-ids meta key for Plan 03 (BLOCKER-2 contract).
        //    Written for ALL subjects (new AND refreshed) so Plan 03 can always read it.
        this.store.setMeta(
          `subject-schema-ids:${subject.subjectSlug}`,
          JSON.stringify(subject.relatedSchemaIds),
        );
      }

      // 4. Write hub→subject doc_containment edges for ALL live subject stubs.
      //    Includes pre-existing subject stubs (fill-in-place idempotency).
      for (const [subjectSlug, subjectDocId] of existingSubjectDocs) {
        // Only write edges for subjects in the accepted set (newly created or known)
        const isKnown = accepted.some(a => a.subjectSlug === subjectSlug);
        if (!isKnown) continue;
        this.store.upsertEdge({
          src: hubDocId,
          dst: subjectDocId,
          rel: 'doc_containment',
          kind: 'doc_containment',
          w: 1.0,
          last_access: now,
        });
      }
    }).immediate();

    return {
      proposed: accepted.map(a => ({ name: a.name, relatedSchemaIds: a.relatedSchemaIds })),
      created: newSubjectDocIds.length,
      refreshQueued,
      hubDocId,
      subjectDocIds: newSubjectDocIds,
    };
  }
}
