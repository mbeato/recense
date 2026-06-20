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
import { generateDoc, generateDocForSchema } from '../reader/doc-generator';
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

  // Query ALL LIVE EMPTY doc stubs (both schema-chapter stubs and landing-doc stubs).
  //
  // A stub is:
  //   - type='doc', tombstoned=0, value='' (empty — CorpusPromoter's eager placeholder)
  //
  // Each stub is classified by its slug:
  //   - If nd.slug resolves to a live type='schema' node → schema chapter (existing path:
  //     computeSchemaCentroid + generateDocForSchema)
  //   - Otherwise → project-scope landing doc (new path: generateDoc(deps, slug))
  //     The landing-doc slug is a project scope string (e.g. 'usage', 'brain-memory'),
  //     not a schema id (Pitfall 4 distinction; mirrors generate-doc-cli.ts:149-166).
  //
  // Non-empty docs are excluded unconditionally — already generated (idempotency).
  // T-01-SQL: bound ? params only; no string interpolation.
  const stubStmt = db.prepare(`
    SELECT
      n.id    AS docId,
      nd.slug AS slug
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.type = 'doc'
      AND n.tombstoned = 0
      AND length(n.value) = 0
  `);

  // Prepared statement to check whether a slug resolves to a live schema node
  // (mirrors the dispatch in generate-doc-cli.ts lines 149-152)
  const stmtSchemaForSlug = db.prepare(
    "SELECT value FROM node WHERE id = ? AND type = 'schema' AND tombstoned = 0"
  );

  const stubs = stubStmt.all() as Array<{
    docId: string;
    slug: string;
  }>;

  // Classify each stub: schema-chapter vs landing-doc
  interface ClassifiedStub {
    docId: string;
    slug: string;
    schemaLabel: string | null; // non-null → schema chapter path; null → landing-doc path
  }

  const classifiedStubs: ClassifiedStub[] = stubs.map(({ docId, slug }) => {
    const schemaRow = stmtSchemaForSlug.get(slug) as { value: string } | undefined;
    return {
      docId,
      slug,
      schemaLabel: schemaRow?.value ?? null,
    };
  });

  const total = classifiedStubs.length;
  const toProcess = classifiedStubs.slice(0, maxDocs);
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

  for (const { docId: _docId, slug, schemaLabel } of toProcess) {
    try {
      let gen: Awaited<ReturnType<typeof generateDocForSchema>>;

      if (schemaLabel !== null) {
        // ── Schema-chapter path (existing, unchanged) ────────────────────────
        // Compute the D-37-gated centroid for this schema.
        // Returns null when no gated members have embeddings — semantic breadth is skipped;
        // spine + entity-hop still produce a doc (by design, not a fallback path).
        const schemaId = slug; // slug = schemaId for chapter stubs (Pitfall 4)
        const centroid = computeSchemaCentroid(db, schemaId);

        // Generate prose via the schema-anchored path (judge-tier model, D-04).
        // generateDocForSchema throws on empty output — caught below (per-doc isolation).
        gen = await generateDocForSchema(
          { db, store, provider },
          { schemaId, centroid, schemaLabel },
        );

        // Fill the stub IN PLACE (stable-edge invariant, BUG-2c).
        writeDoc(store, db, {
          docId: gen.docId,
          slug: schemaId,
          markdown: gen.markdown,
          citedFactIds: gen.citedFactIds,
          linkedDocRefs: gen.linkedDocRefs,
          now,
        });

        log(
          `corpus-generator: generated doc for schema ${schemaId} ` +
          `(citations=${gen.citationCount} invented=${gen.invented})`,
        );
      } else {
        // ── Landing-doc path (new, Plan 32-02) ──────────────────────────────
        // slug is a project scope string ('usage', 'brain-memory', etc.), not a schema id.
        // Route through the project-scope generateDoc path (mirrors generate-doc-cli.ts:165).
        // generateDoc throws on empty output — caught below (per-doc isolation).
        gen = await generateDoc({ db, store, provider }, slug);

        // Fill the stub IN PLACE (stable-edge invariant, BUG-2c).
        // Landing stub node id + doc_containment edges from promoteScope are preserved.
        writeDoc(store, db, {
          docId: gen.docId,
          slug,
          markdown: gen.markdown,
          citedFactIds: gen.citedFactIds,
          linkedDocRefs: gen.linkedDocRefs,
          now,
        });

        log(
          `corpus-generator: generated landing doc for scope ${slug} ` +
          `(citations=${gen.citationCount} invented=${gen.invented})`,
        );
      }

      generated++;
    } catch (err) {
      // Per-doc failure isolation: log + count; continue with the next stub.
      // Typical causes: LLM timeout (empty output throw), transient headless client failure,
      // or corrupt schema/scope data. A failed landing doc must not abort the schema loop.
      // Log message uses 'failed for schema' prefix for backward compatibility with existing tests.
      log(`corpus-generator: failed for schema ${slug}: ${err}`);
      failed++;
    }
  }

  log(
    `corpus-generator: done — generated=${generated} failed=${failed} ` +
    `skipped=0 deferred=${deferred}`,
  );

  return { generated, failed, deferred };
}
