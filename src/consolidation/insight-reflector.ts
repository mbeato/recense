/**
 * InsightReflector — offline reflection step for Phase C sleep pass (REFLECT-01, Plan 38-02).
 *
 * Synthesizes one higher-order `type='insight'` node per qualifying stale schema cluster and
 * wires it into Phase C between `corpusPromoter.promote()` and `runEvictionSweep()`.
 *
 * Design decisions:
 *  D-03: Reuses Phase-28 mass gate + member-shape noise filter (NOISE_PATTERNS, isNoiseMember).
 *  D-03/D-06: Staleness gate — acts ONLY on stale/new qualifying clusters; a second pass
 *             over an UNCHANGED graph calls provider.generate ZERO times. NOT a wipe-and-rebuild.
 *  D-04: One offline provider.generate() per qualifying stale cluster, judge-tier.
 *  D-04 SC3 / D-43: insight nodes are origin='inferred' → strengthen() already no-ops on them.
 *             synthesis is READ-ONLY over members (no strengthen/upsertNode/tombstone on members).
 *  T-02-ASYNC: Phase A runs all provider.generate() calls async BEFORE Phase B opens the
 *              .immediate() write transaction. NEVER await inside db.transaction().
 *  T-01-SQL: all queries via prepared statements compiled once in the constructor.
 *  D-12: all time via this.clock.nowMs() — never Date.now().
 *  D-06: dissolved clusters (mass < reflectMassFloorLow) → tombstone the insight (hysteresis-gated)
 *        so the SAME-pass eviction sweep can collect it.
 *  D-06 "decay (s drops)": insights are seeded with s > 0 (default 0.1) and decay over time;
 *        they are never strengthened, so s decays monotonically until tombstone+eviction.
 *  M-5 write-lock: db.transaction().immediate() to avoid SQLITE_BUSY_SNAPSHOT in WAL mode.
 *
 * Structural composite of:
 *  - CorpusPromoter (selection gate, NoopX DI default, write block shape, noise filter)
 *  - SchemaRelationDeriver (Phase-A-async → Phase-B-.immediate() mold, T-02-ASYNC invariant)
 *  - generateDocForSchema (judge-tier generate + empty-output throw + citation-verify)
 *
 * FK note: node_insight.node_id REFERENCES node(id). The eviction sweep in decay.ts already
 * handles the FK-safe child-wipe via stmtDeleteInsightForNode (T-38-01 / wave 1 patch).
 *
 * LANDMINE: unlike the deriver analogs (which wipe-and-rebuild), this reflector CANNOT blindly
 * wipe all insights on each pass — that would force a provider.generate() call for every cluster
 * every pass, destroying D-03 cost control. Instead: regen ONLY stale clusters (fill-in-place);
 * tombstone ONLY dissolved clusters.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { SemanticStore } from '../db/semantic-store';
import type { ModelProvider } from '../model/provider';
import { newId } from '../lib/hash';
import { synthesizeInsightForSchema } from '../reader/insight-generator';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InsightReflectorOpts {
  /** Promote a schema to insight generation when mass >= massFloorHigh. */
  massFloorHigh: number;
  /** Tombstone the insight when mass < massFloorLow (hysteresis demotion). */
  massFloorLow: number;
  /** Cap insight confidence at this value (must sit below typical schema confidence). */
  confidenceCeiling: number;
}

export interface ReflectResult {
  /** Schema ids for which a new/regenerated insight was written. */
  synthesized: string[];
  /** Schema ids whose insight was tombstoned (cluster dissolved). */
  tombstoned: string[];
  /** Schema ids that were up to date (no LLM call). */
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Noise patterns — verbatim from corpus-promoter.ts (D-03 requires SAME filter)
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
// NoopInsightReflector — test/legacy DI default (does nothing)
// ---------------------------------------------------------------------------

/**
 * No-op implementation for tests and call sites that don't need insight reflection.
 * Mirrors NoopCorpusPromoter — satisfies the Consolidator DI contract.
 */
export class NoopInsightReflector {
  async reflect(): Promise<ReflectResult> {
    return { synthesized: [], tombstoned: [], skipped: [] };
  }
}

// ---------------------------------------------------------------------------
// InsightReflector
// ---------------------------------------------------------------------------

/**
 * Derives one insight node per qualifying stale schema cluster.
 * Structural composite of CorpusPromoter + SchemaRelationDeriver + judge-tier generate.
 */
export class InsightReflector {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly provider: ModelProvider;
  private readonly config: EngineConfig;
  private readonly clock: Clock;
  private readonly opts: InsightReflectorOpts;

  // Prepared statements — compiled once in constructor (T-01-SQL)
  private readonly stmtGetSchemaNodes: Database.Statement;
  private readonly stmtGetSchemaMembersWithValues: Database.Statement;
  /** Find the live insight for a schema via incoming derived_from edges from type='insight' nodes. */
  private readonly stmtGetLiveInsightForSchema: Database.Statement;
  /** Get all derived_from members (dst) of an insight node — for staleness check. */
  private readonly stmtGetInsightMembers: Database.Statement;
  /** Get last_access of a member node — for staleness comparison. */
  private readonly stmtGetNodeLastAccess: Database.Statement;
  /** FTS delete — suppress insight text from BM25 keyword search (Pitfall 7). */
  private readonly stmtFtsDelete: Database.Statement;

  constructor(
    db: Database.Database,
    store: SemanticStore,
    provider: ModelProvider,
    config: EngineConfig,
    clock: Clock,
    opts: InsightReflectorOpts,
  ) {
    this.db = db;
    this.store = store;
    this.provider = provider;
    this.config = config;
    this.clock = clock;
    this.opts = opts;

    // Live schema nodes — same as SchemaRelationDeriver / CorpusPromoter
    this.stmtGetSchemaNodes = db.prepare(
      "SELECT id, value FROM node WHERE type = 'schema' AND tombstoned = 0",
    );

    // D-37 firewall: exclude origin='inferred' (same gate as CorpusPromoter)
    this.stmtGetSchemaMembersWithValues = db.prepare(
      "SELECT e.dst as id, n.value as value, n.last_access as last_access FROM edge e " +
        "JOIN node n ON n.id = e.dst " +
        "WHERE e.src = ? AND e.kind = 'abstracts' " +
        "AND n.type IN ('fact','entity') AND n.tombstoned = 0 AND n.origin != 'inferred'",
    );

    // Find the live (tombstoned=0) insight node whose derived_from edge points to schemaId
    // The insight → schema edge has kind='derived_from', dst=schemaId, src.type='insight'
    this.stmtGetLiveInsightForSchema = db.prepare(
      "SELECT n.id, ni.generated_at FROM node n " +
        "JOIN edge e ON e.src = n.id " +
        "JOIN node_insight ni ON ni.node_id = n.id " +
        "WHERE e.dst = ? AND e.kind = 'derived_from' AND n.type = 'insight' AND n.tombstoned = 0 " +
        "LIMIT 1",
    );

    // Get all derived_from members (the member edges, NOT the schema edge) for an insight
    // Filters to members that are fact/entity nodes so we don't pick up the schema anchor
    this.stmtGetInsightMembers = db.prepare(
      "SELECT e.dst as id, n.last_access as last_access FROM edge e " +
        "JOIN node n ON n.id = e.dst " +
        "WHERE e.src = ? AND e.kind = 'derived_from' AND n.type IN ('fact','entity')",
    );

    // Get a single node's last_access
    this.stmtGetNodeLastAccess = db.prepare(
      "SELECT last_access FROM node WHERE id = ?",
    );

    // FTS delete — mirrors corpus-promoter.ts Pitfall 7
    this.stmtFtsDelete = db.prepare(
      "DELETE FROM node_fts WHERE rowid = (SELECT rowid FROM node WHERE id = ?)",
    );
  }

  /**
   * Run the reflection pass. Called from Phase C between corpusPromoter.promote() and
   * runEvictionSweep() (D-07, consolidator.ts).
   *
   * Two-phase structure (T-02-ASYNC — hardest invariant):
   *  Phase A (async): for each stale qualifying schema, await synthesizeInsightForSchema().
   *                   provider.generate() runs HERE, before Phase B opens.
   *  Phase B (sync):  db.transaction().immediate() writes all nodes/edges/sidecars.
   *                   NO await inside.
   */
  async reflect(): Promise<ReflectResult> {
    const nowMs = this.clock.nowMs();

    // ── Phase A: selection + staleness + synthesis ─────────────────────────

    const schemaRows = this.stmtGetSchemaNodes.all() as Array<{ id: string; value: string }>;

    // Payloads for Phase B write
    interface SynthesisPayload {
      schemaId: string;
      schemaLabel: string;
      insightText: string;
      citedMemberIds: string[];
      allMemberIds: string[];         // ALL gated members (for derived_from edge coverage when citation is empty)
      existingInsightId: string | null; // non-null → fill-in-place regen (tombstone old, write new)
    }

    const toSynthesize: SynthesisPayload[] = [];
    const toTombstone: string[] = []; // insight node ids to tombstone (dissolved clusters)
    const skipped: string[] = [];

    for (const schema of schemaRows) {
      // 1. Get gated members (D-37 firewall: tombstoned=0, origin!='inferred', fact/entity)
      const members = this.stmtGetSchemaMembersWithValues.all(schema.id) as Array<{
        id: string;
        value: string;
        last_access: number;
      }>;

      const mass = members.length;

      // 2. Check existing insight (if any)
      const existingInsight = this.stmtGetLiveInsightForSchema.get(schema.id) as
        | { id: string; generated_at: number }
        | undefined;

      // 3. Hysteresis-gated dissolution check
      const qualifiesHigh = mass >= this.opts.massFloorHigh;
      const qualifiesLow = mass >= this.opts.massFloorLow;

      if (!qualifiesLow) {
        // Below low-water mark — tombstone existing insight if any
        if (existingInsight) {
          toTombstone.push(existingInsight.id);
        }
        continue;
      }

      if (!qualifiesHigh && !existingInsight) {
        // In hysteresis band but no existing insight → don't create one yet
        continue;
      }

      // 4. Noise filter (D-03): skip if noise fraction >= noiseCap (default 0.5)
      // Using the same D-07 logic as CorpusPromoter
      const noiseCount = members.filter(m => isNoiseMember(m.value)).length;
      const noiseFrac = members.length > 0 ? noiseCount / members.length : 0;
      const noiseCap = 0.5; // mirror CorpusPromoter default
      if (noiseFrac >= noiseCap) {
        // Noise-filtered — tombstone if we have an existing insight for this schema
        if (existingInsight) {
          toTombstone.push(existingInsight.id);
        }
        continue;
      }

      // 5. Staleness check (D-03/D-06)
      let isStale = false;
      if (!existingInsight) {
        // No insight yet → always generate
        isStale = true;
      } else {
        // Check if any cited member has been touched since generated_at
        const insightMembers = this.stmtGetInsightMembers.all(existingInsight.id) as Array<{
          id: string;
          last_access: number;
        }>;

        if (insightMembers.length === 0) {
          // No derived_from member edges (first-pass edge was not written yet / degenerate)
          // Fall through: also check the raw member last_access
          isStale = members.some(m => m.last_access > existingInsight.generated_at);
        } else {
          isStale = insightMembers.some(m => m.last_access > existingInsight.generated_at);
        }

        // Also check if any tombstoned member had tombstone time > generated_at
        // (tombstoned members are excluded from the members query; check raw tombstoned nodes)
        if (!isStale) {
          const tombstonedMemberAccess = this.db
            .prepare(
              "SELECT MAX(n.last_access) as max_la FROM edge e " +
                "JOIN node n ON n.id = e.dst " +
                "WHERE e.src = ? AND e.kind = 'abstracts' " +
                "AND n.tombstoned = 1 AND n.type IN ('fact','entity')",
            )
            .get(schema.id) as { max_la: number | null };
          if (tombstonedMemberAccess.max_la !== null &&
              tombstonedMemberAccess.max_la > existingInsight.generated_at) {
            isStale = true;
          }
        }
      }

      if (!isStale) {
        skipped.push(schema.id);
        continue;
      }

      // 6. Synthesize (Phase A async — MUST happen before Phase B transaction opens)
      let insightText: string;
      let citedMemberIds: string[];
      try {
        const result = await synthesizeInsightForSchema(
          { db: this.db, store: this.store, provider: this.provider },
          { schemaId: schema.id, schemaLabel: schema.value, members },
        );
        insightText = result.insightText;
        citedMemberIds = result.citedMemberIds;
      } catch (err) {
        // Empty output or synthesis failure — skip this cluster; log and continue
        // A failed synthesis never discards the existing insight
        console.warn(
          `InsightReflector: synthesis failed for schema ${schema.id} (${schema.value}): ${String(err)}`,
        );
        continue;
      }

      toSynthesize.push({
        schemaId: schema.id,
        schemaLabel: schema.value,
        insightText,
        citedMemberIds,
        allMemberIds: members.map(m => m.id),
        existingInsightId: existingInsight?.id ?? null,
      });
    }

    // ── Phase B: sync write inside one .immediate() transaction — NO await inside ──

    const synthesizedSchemaIds: string[] = [];

    this.db.transaction(() => {
      const now = nowMs; // captured before Phase B — consistent with Phase A

      // Tombstone dissolved insights first
      for (const insightId of toTombstone) {
        this.store.tombstone(insightId);
      }

      // Write new/regenerated insights
      for (const payload of toSynthesize) {
        // Fill-in-place regen: tombstone the prior insight + its derived_from edges, then write fresh
        if (payload.existingInsightId) {
          this.store.tombstone(payload.existingInsightId);
          // Delete the old derived_from edges so the new ones are written cleanly
          this.db
            .prepare("DELETE FROM edge WHERE src = ? AND kind = 'derived_from'")
            .run(payload.existingInsightId);
        }

        const insightId = newId();

        // Write the insight node (mirrors corpus-promoter.ts:443-475 eager-stub block)
        // type='insight', origin='inferred' → training_eligible=0, strengthen() no-ops
        // c capped at reflectConfidenceCeiling (NOT 1.0)
        // s > 0 (default 0.1) so the insight decays over time (D-06: "decay (s drops)")
        this.store.upsertNode({
          id: insightId,
          type: 'insight',
          value: payload.insightText,
          origin: 'inferred',
          s: 0.1,                              // decays; never strengthened → eviction follows
          c: this.opts.confidenceCeiling,       // capped at reflectConfidenceCeiling (~0.6)
          last_access: now,
        });

        // FTS suppression — insight text must not pollute BM25 keyword search (Pitfall 7)
        this.stmtFtsDelete.run(insightId);

        // node_insight sidecar: records anchor_schema_id + generated_at
        // generated_at is WRITE-ONCE (see store.upsertNodeInsight semantics)
        this.store.upsertNodeInsight({
          node_id: insightId,
          anchor_schema_id: payload.schemaId,
          generated_at: now,
          updated_at: now,
        });

        // derived_from edge: insight → anchor schema (D-02, discovery direction for recall)
        this.store.upsertEdge({
          src: insightId,
          dst: payload.schemaId,
          rel: 'derived_from',
          kind: 'derived_from',
          w: 1.0,
          last_access: now,
        });

        // derived_from edges: insight → each cited member (D-02, staleness dependency set)
        // When no citations were found (model didn't cite), fall back to all members
        const derivedFromTargets =
          payload.citedMemberIds.length > 0
            ? payload.citedMemberIds
            : payload.allMemberIds;

        for (const memberId of derivedFromTargets) {
          this.store.upsertEdge({
            src: insightId,
            dst: memberId,
            rel: 'derived_from',
            kind: 'derived_from',
            w: 1.0,
            last_access: now,
          });
        }

        synthesizedSchemaIds.push(payload.schemaId);
      }
    }).immediate(); // M-5 write-lock discipline — avoid SQLITE_BUSY_SNAPSHOT (WR-02)

    return {
      synthesized: synthesizedSchemaIds,
      tombstoned: toTombstone,
      skipped,
    };
  }
}
