/**
 * corpus-generator — offline batch prose generation for schema-anchored corpus docs (CORPUS-06).
 *
 * Moves doc-prose generation OFFLINE into the sleep pass so every promoted schema's
 * deep-dive is generated while no user is waiting, rather than on the online /doc click
 * (~42s headless LLM call on the hot path). The lazy-on-click path in generate-doc-cli
 * remains as a fallback (handles any stub the sleep pass hasn't reached yet).
 *
 * Contract:
 *  - Idempotent: only fills EMPTY value stubs (length(value)=0). A non-empty doc is
 *    skipped unconditionally (already generated). Re-running the same pass is safe.
 *  - Per-doc failure isolation: a single LLM timeout or empty-output throw MUST NOT
 *    abort the loop. The failure is logged and counted; the next stub continues.
 *  - maxDocs cap: generates up to maxDocs stubs per call, then logs and returns how
 *    many were deferred. No silent truncation — the summary line always shows deferred.
 *  - NO lock management: the caller owns the lock (sleep pass holds it; CLI acquires it
 *    before calling and releases in finally). This function is lock-agnostic.
 *  - NO clock read inside the function: `now` is passed in from the caller's clock so
 *    all writes in a batch share the same generation timestamp.
 *
 * Engine invariants upheld:
 *  - D-43 self-confirmation: generateDocForSchema is read-only; it does NOT strengthen,
 *    setEmbedding, or markActive on source schemas or their facts.
 *  - writeDoc fills the stub IN PLACE (stable-edge invariant, BUG-2c): corpus edges
 *    written by CorpusPromoter (doc_containment/doc_reference) keep pointing at the same
 *    stub node id after prose is filled in. The corpus forest never dangles.
 *  - net-zero deps: no new runtime dependencies beyond what the sleep pass already imports.
 *  - All SQL via bound ? params (T-01-SQL); read-only queries here; writes via writeDoc.
 *
 * Usage:
 *  - Sleep pass: call after consolidate() while lock is held (run-sleep-pass.ts).
 *  - CLI: `recense generate-corpus [--db <path>] [--max <n>]` (generate-corpus-cli.ts).
 */
import type Database from 'better-sqlite3';
import type { SemanticStore } from '../db/semantic-store';
import type { ModelProvider } from '../model/provider';
import { computeSchemaCentroid } from '../reader/doc-gather';
import { generateDocForSchema } from '../reader/doc-generator';
import { writeDoc } from './doc-writer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateCorpusDeps {
  db: Database.Database;
  store: SemanticStore;
  provider: ModelProvider;
}

export interface GenerateCorpusOpts {
  /**
   * Maximum number of empty stubs to generate in this call. Default: 25.
   * Stubs beyond the cap are left empty and counted as `deferred`.
   */
  maxDocs?: number;
  /**
   * Optional logger (receives one-line human-readable progress messages).
   * Defaults to a no-op so the function is usable without a logging context.
   */
  log?: (msg: string) => void;
  /**
   * Epoch-ms timestamp to use for all writes in this batch (caller's clock).
   * Defaults to Date.now() when omitted (CLI and test convenience).
   */
  now?: number;
}

export interface GenerateCorpusResult {
  /** Number of stubs successfully filled with prose. */
  generated: number;
  /** Number of stubs that threw during generation (LLM failure, empty output, etc.). */
  failed: number;
  /** Number of empty stubs skipped because the cap was reached. */
  deferred: number;
}

// ---------------------------------------------------------------------------
// generateCorpusDocs
// ---------------------------------------------------------------------------

/**
 * Fill empty schema-anchored corpus doc stubs with generated prose (CORPUS-06).
 *
 * Queries live empty stubs (type='doc', tombstoned=0, length(value)=0) whose
 * node_doc.slug resolves to a live type='schema' node, then generates prose for
 * each via generateDocForSchema (judge-tier model, same path as the lazy CLI).
 *
 * @param deps  Injected DB + SemanticStore + ModelProvider (judge-tier).
 * @param opts  Optional cap, logger, and timestamp.
 * @returns     Tally of generated / failed / deferred stubs.
 */
export async function generateCorpusDocs(
  deps: GenerateCorpusDeps,
  opts: GenerateCorpusOpts = {},
): Promise<GenerateCorpusResult> {
  const { db, store, provider } = deps;
  const { maxDocs = 25, log = () => undefined, now = Date.now() } = opts;

  // Query LIVE EMPTY schema doc stubs.
  //
  // A "schema doc stub" is:
  //   - type='doc', tombstoned=0, value='' (empty — the CorpusPromoter's eager placeholder)
  //   - whose node_doc.slug resolves to a LIVE type='schema' node (tombstoned=0)
  //
  // Non-empty docs are excluded unconditionally — they are already generated (idempotency).
  // The join to node_doc gives us the slug (= schemaId). The join to schema_node gives us
  // the schema's human label (value) for the generation prompt.
  //
  // T-01-SQL: bound ? params only. No string interpolation.
  const stubStmt = db.prepare(`
    SELECT
      n.id    AS docId,
      nd.slug AS schemaId,
      s.value AS schemaLabel
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    JOIN node s ON s.id = nd.slug
    WHERE n.type = 'doc'
      AND n.tombstoned = 0
      AND length(n.value) = 0
      AND s.type = 'schema'
      AND s.tombstoned = 0
  `);

  const stubs = stubStmt.all() as Array<{
    docId: string;
    schemaId: string;
    schemaLabel: string;
  }>;

  const total = stubs.length;
  const toProcess = stubs.slice(0, maxDocs);
  const deferred = Math.max(0, total - maxDocs);

  if (deferred > 0) {
    log(
      `corpus-generator: ${total} empty stubs found; processing first ${maxDocs}, deferring ${deferred}`,
    );
  } else {
    log(`corpus-generator: ${total} empty stubs found`);
  }

  let generated = 0;
  let failed = 0;

  for (const { docId: _docId, schemaId, schemaLabel } of toProcess) {
    try {
      // Compute the D-37-gated centroid for this schema.
      // Returns null when no gated members have embeddings — semantic breadth is skipped;
      // spine + entity-hop still produce a doc (by design, not a fallback path).
      const centroid = computeSchemaCentroid(db, schemaId);

      // Generate prose via the schema-anchored path (judge-tier model, D-04).
      // generateDocForSchema throws on empty output — that is caught below (per-doc isolation).
      const gen = await generateDocForSchema(
        { db, store, provider },
        { schemaId, centroid, schemaLabel },
      );

      // Fill the stub IN PLACE (stable-edge invariant, BUG-2c).
      // writeDoc detects the empty stub for schemaId and updates its value in place,
      // keeping the same node id so all corpus edges (doc_containment, doc_reference)
      // continue to reference a live node. It does NOT tombstone the stub or create a
      // new node — that would dangle every corpus edge written by CorpusPromoter.
      writeDoc(store, db, {
        docId: gen.docId,     // proposed fresh id — writeDoc will use the stub id instead
        slug: schemaId,        // node_doc.slug = schemaId (Pitfall 4)
        markdown: gen.markdown,
        citedFactIds: gen.citedFactIds,
        linkedDocRefs: gen.linkedDocRefs,
        now,
      });

      log(
        `corpus-generator: generated doc for schema ${schemaId} ` +
        `(citations=${gen.citationCount} invented=${gen.invented})`,
      );
      generated++;
    } catch (err) {
      // Per-doc failure isolation: log + count; continue with the next stub.
      // Typical causes: LLM timeout (empty output throw from generateDocForSchema),
      // transient headless client failure, or corrupt schema data.
      log(`corpus-generator: failed for schema ${schemaId}: ${err}`);
      failed++;
    }
  }

  log(
    `corpus-generator: done — generated=${generated} failed=${failed} ` +
    `skipped=0 deferred=${deferred}`,
  );

  return { generated, failed, deferred };
}
