/**
 * corpus-generator — offline batch prose generation for corpus docs (CORPUS-06, Plan 39.1-03).
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
 *  - maxDocs cap: generates up to maxDocs stubs per call (D-07 budget cap). Stubs
 *    beyond the cap get a 'pending-subject-doc-gen:<scope>:<slug>' meta marker for
 *    crash-safe retry next pass (self-draining priority queue). No silent truncation.
 *  - NO lock management: the caller owns the lock (sleep pass holds it; CLI acquires it
 *    before calling and releases in finally). This function is lock-agnostic.
 *  - NO clock read inside the function: `now` is passed in from the caller's clock so
 *    all writes in a batch share the same generation timestamp.
 *
 * Doc-type dispatch (Plan 39.1-03, D-01/D-03):
 *  - slug = bare scope string (no ':', not a UUID) → hub doc path (generateDocForHub).
 *    Hub receives a LINKED {name, docId}[] index built from doc_containment children so
 *    writeDoc materialises doc_link edges (D-04 navigable index, BLOCKER-1).
 *  - slug = 'scope:name' → subject doc path (generateDocForSubject). schemaIds rebuilt
 *    from 'subject-schema-ids:<slug>' meta key; NO second LLM call (BLOCKER-2).
 *  - slug = UUID (resolves to a live schema node) → schema-chapter path (backward compat;
 *    generateDocForSchema is still importable but no longer called here — D-03 demotion).
 *
 * Engine invariants upheld:
 *  - D-43 self-confirmation: all generators are read-only; no strengthen/setEmbedding.
 *  - writeDoc fills the stub IN PLACE (stable-edge invariant, BUG-2c).
 *  - D-37 firewall: subject schemaIds from meta are in-scope IDs (filtered at write time).
 *  - net-zero deps: no new runtime dependencies.
 *  - All SQL via bound ? params (T-01-SQL).
 *
 * Usage:
 *  - Sleep pass: call after consolidate() + promoteSubjects() while lock is held.
 *  - CLI: `recense generate-corpus [--db <path>] [--max <n>]` (generate-corpus-cli.ts).
 */
import type Database from 'better-sqlite3';
import type { SemanticStore } from '../db/semantic-store';
import type { ModelProvider } from '../model/provider';
import { computeSchemaCentroid } from '../reader/doc-gather';
import { generateDoc, generateDocForSchema, generateDocForHub, generateDocForSubject } from '../reader/doc-generator';
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
 * Fill empty corpus doc stubs with generated prose (CORPUS-06, Plan 39.1-03).
 *
 * Queries live empty stubs (type='doc', tombstoned=0, length(value)=0) and dispatches
 * each by slug shape:
 *  - UUID slug → schema-chapter path (generateDocForSchema, backward compat)
 *  - bare scope slug (no ':') → hub doc path (generateDocForHub with linked {name,docId}[])
 *  - 'scope:name' slug → subject doc path (generateDocForSubject with meta-rebuilt schemaIds)
 *
 * Stubs are sorted by priority (hubs first, then subjects by slug) before slicing at
 * maxDocs. Overflow stubs get 'pending-subject-doc-gen:<scope>:<slug>' meta markers
 * for crash-safe retry next pass (D-07 self-draining queue).
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

  // Query ALL LIVE EMPTY doc stubs.
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
  // (schema-chapter path: slug = UUID = schemaId — Pitfall 4)
  const stmtSchemaForSlug = db.prepare(
    "SELECT value FROM node WHERE id = ? AND type = 'schema' AND tombstoned = 0"
  );

  // Prepared statement to fetch doc_containment children of a hub stub.
  // Used to build the {name, docId}[] linked index for generateDocForHub (D-04 / BLOCKER-1).
  // Returns child doc node id + slug — name is derived from the slug suffix after 'scope:'.
  const stmtContainmentChildren = db.prepare(`
    SELECT c.id AS childId, nd.slug AS childSlug
    FROM edge e
    JOIN node c ON c.id = e.dst AND c.type = 'doc' AND c.tombstoned = 0
    JOIN node_doc nd ON nd.node_id = c.id
    WHERE e.src = ? AND e.kind = 'doc_containment'
  `);

  const stubs = stubStmt.all() as Array<{
    docId: string;
    slug: string;
  }>;

  // ── Slug-shape classification ─────────────────────────────────────────────
  //
  // UUID_PATTERN: matches 8-4-4-4-12 hex UUID format (schema-chapter slugs, Pitfall 4)
  // SUBJECT_SLUG: matches 'scope:name' (contains exactly one ':')
  // Otherwise: bare scope string → hub doc
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  type StubKind = 'schema' | 'hub' | 'subject';

  interface ClassifiedStub {
    docId: string;
    slug: string;
    kind: StubKind;
    schemaLabel: string | null; // non-null only for schema-chapter path
    /** Sort priority: 0 = hub (highest), 1 = subject, 2 = schema-chapter (deferred). */
    priority: number;
  }

  const classifiedStubs: ClassifiedStub[] = stubs.map(({ docId, slug }) => {
    if (UUID_PATTERN.test(slug)) {
      // Schema-chapter path (backward compat — D-03 demoted but still supported)
      const schemaRow = stmtSchemaForSlug.get(slug) as { value: string } | undefined;
      return { docId, slug, kind: 'schema', schemaLabel: schemaRow?.value ?? null, priority: 2 };
    }
    if (slug.includes(':')) {
      // Subject doc path: 'scope:name'
      return { docId, slug, kind: 'subject', schemaLabel: null, priority: 1 };
    }
    // Hub doc path: bare scope string
    return { docId, slug, kind: 'hub', schemaLabel: null, priority: 0 };
  });

  // Sort by priority (hubs first, then subjects, then schema-chapters)
  classifiedStubs.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));

  const total = classifiedStubs.length;
  const toProcess = classifiedStubs.slice(0, maxDocs);
  const overflowStubs = classifiedStubs.slice(maxDocs);
  const deferred = overflowStubs.length;

  if (deferred > 0) {
    log(
      `corpus-generator: ${total} empty stubs found; processing first ${maxDocs}, deferring ${deferred}`,
    );
  } else {
    log(`corpus-generator: ${total} empty stubs found`);
  }

  // D-07: Write deferred-stub markers for overflow stubs (crash-safe retry next pass).
  // Key format: 'pending-subject-doc-gen:<scope>:<slug>'
  // Only write markers for hub and subject stubs (not schema-chapters — those use the
  // existing pending-corpus-promotion:<scope> marker pattern).
  for (const stub of overflowStubs) {
    if (stub.kind === 'hub' || stub.kind === 'subject') {
      const markerKey = `pending-subject-doc-gen:${stub.slug}`;
      store.setMeta(markerKey, '1');
      log(`corpus-generator: deferred stub marker written: ${markerKey}`);
    }
  }

  let generated = 0;
  let failed = 0;

  for (const { docId: _docId, slug, kind, schemaLabel } of toProcess) {
    try {
      let gen: Awaited<ReturnType<typeof generateDocForSchema>>;

      if (kind === 'schema') {
        // ── Schema-chapter path (D-03 backward compat — no longer primary path) ──
        // slug = schemaId (UUID); generateDocForSchema is NOT called for hub/subject stubs.
        if (schemaLabel === null) {
          // Slug is UUID-shaped but no live schema found — skip gracefully
          log(`corpus-generator: skipping schema stub ${slug} (schema node not found)`);
          failed++;
          continue;
        }
        const schemaId = slug;
        const centroid = computeSchemaCentroid(db, schemaId);
        gen = await generateDocForSchema(
          { db, store, provider },
          { schemaId, centroid, schemaLabel },
        );
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

      } else if (kind === 'hub') {
        // ── Hub doc path (D-01/D-04) ─────────────────────────────────────────
        // slug is a bare scope string (e.g. 'brain-memory').
        // Build {name, docId}[] from the hub's doc_containment children so the hub index
        // renders recense://doc/<docId> refs and writeDoc materialises doc_link edges.
        // BLOCKER-1: must pass LINKED refs, not bare names.
        const childRows = stmtContainmentChildren.all(_docId) as Array<{
          childId: string;
          childSlug: string;
        }>;

        // Derive subject name from child slug suffix (strip 'scope:' prefix).
        const subjectDocs = childRows
          .filter(r => r.childSlug.startsWith(`${slug}:`))
          .map(r => ({
            name: r.childSlug.slice(slug.length + 1), // strip 'scope:' prefix
            docId: r.childId,
          }));

        gen = await generateDocForHub({ db, store, provider }, slug, subjectDocs);
        writeDoc(store, db, {
          docId: gen.docId,
          slug,
          markdown: gen.markdown,
          citedFactIds: gen.citedFactIds,
          linkedDocRefs: gen.linkedDocRefs,
          now,
        });
        log(
          `corpus-generator: generated hub doc for scope ${slug} ` +
          `(subjects=${subjectDocs.length} citations=${gen.citationCount} invented=${gen.invented})`,
        );

        // Clear deferred marker if present (this hub was previously deferred)
        const markerKey = `pending-subject-doc-gen:${slug}`;
        store.deleteMeta(markerKey);

      } else {
        // ── Subject doc path (D-02, BLOCKER-2) ───────────────────────────────
        // slug = 'scope:name'; schemaIds rebuilt from 'subject-schema-ids:<slug>' meta.
        // NO second LLM call to reconstruct the schema set — read from meta only.
        const colonIdx = slug.indexOf(':');
        const scope = slug.slice(0, colonIdx);
        const subjectName = slug.slice(colonIdx + 1);

        const metaKey = `subject-schema-ids:${slug}`;
        const metaValue = store.getMeta(metaKey);

        if (metaValue == null) {
          // BLOCKER-2 guard: if meta key is missing, log and skip (no LLM call fallback)
          log(`corpus-generator: skipping subject stub ${slug} — meta key '${metaKey}' not found`);
          failed++;
          continue;
        }

        let schemaIds: string[];
        try {
          schemaIds = JSON.parse(metaValue) as string[];
        } catch {
          log(`corpus-generator: skipping subject stub ${slug} — failed to parse '${metaKey}'`);
          failed++;
          continue;
        }

        gen = await generateDocForSubject(
          { db, store, provider },
          { scope, subjectName, schemaIds },
        );
        writeDoc(store, db, {
          docId: gen.docId,
          slug,
          markdown: gen.markdown,
          citedFactIds: gen.citedFactIds,
          linkedDocRefs: gen.linkedDocRefs,
          now,
        });
        log(
          `corpus-generator: generated subject doc ${slug} ` +
          `(schemaIds=${schemaIds.length} citations=${gen.citationCount} invented=${gen.invented})`,
        );

        // Clear deferred marker on success (crash-safe: only delete AFTER success)
        const markerKey = `pending-subject-doc-gen:${slug}`;
        store.deleteMeta(markerKey);
      }

      generated++;
    } catch (err) {
      // Per-doc failure isolation: log + count; continue with the next stub.
      // Typical causes: LLM timeout (empty output throw), transient headless client failure,
      // or corrupt schema/scope data. A failed doc must not abort the loop.
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
