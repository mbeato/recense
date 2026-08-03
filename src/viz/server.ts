/**
 * viz server — local read-only HTTP/SSE server for brain-activation visualization (VIZ-03).
 *
 * Endpoints:
 *   GET /              → src/viz/index.html (Plan 04; 503 if absent)
 *   GET /index.html    → same
 *   GET /vendor/*      → src/viz/vendor/<file> (path-traversal-safe, MIME-guarded)
 *   GET /graph         → { nodes, links } JSON from read-only DB handle
 *   GET /search?q=     → BM25-ranked node IDs (string[]), LLM-free, tombstone-filtered (VIZ-07)
 *   GET /events        → SSE stream: polls activation_trace every 250ms past a cursor
 *   GET /doc?slug=     → markdown body of the type='doc' node for <slug> (DB-backed, READER-02)
 *                        If no doc exists, returns 202 {status:'generating'} and spawns CLI.
 *   GET /doc/meta?slug= → {nodeId, generated_at, citedFactIds:[...]} (DB-backed, READER-02)
 *   POST /doc/generate?slug= → force-spawns CLI, returns 202 {status:'generating'} (READER-02)
 *   GET /doc/staleness?slug= → {generated_at, stale:[{factId,prev_value,value}], tombstoned:[id,...]} (READER-03)
 *   GET /doc/backlinks?slug= → {backlinks:[{srcId,slug,label,kind}]} incoming doc wiki refs (WIKI-02, 39-01)
 *   GET /doc/backlinks?fact= → {citedByDocs:[{srcId,slug,label}]} docs citing a fact (WIKI-02, 39-01)
 *   GET /settings            → {preset, overrides, effective} merged config (44-05, D-03)
 *   POST /settings           → write settings.json with key-whitelisted payload (44-05, D-03)
 *   GET /usage               → 30d + all-time token readout by feature (44-05, D-09/D-10)
 *   GET /stats/usage?window= → windowed daily/weekly burn buckets + per-feature/per-model
 *                              totals + retail-$ + cost-event before/after deltas (Phase 60, D-09/D-10/D-11/D-12)
 *   GET /stats/brain-health  → node growth, kind mix, reconsolidations/tombstones per day,
 *                              judge activity, episodes pending/consolidated, last sleep-pass (Phase 60, D-13/D-14)
 *
 * Security invariants (threat model T-10-07/08/09/10/11, T-27-08/09/10/11, T-44-15..18):
 *   T-10-07: path-traversal guard — resolves absolute path and asserts it stays
 *            inside __dirname (src/viz/) or vendor subdirectory; 403 on escape.
 *   T-10-08: DB opened { readonly: true } — no writes possible from this process.
 *   T-10-09: listens on 127.0.0.1 ONLY — loopback-only, never a wildcard.
 *   T-10-10: all assets vendored under src/viz/vendor — no CDN/fetch to external domains.
 *   T-10-11: SSE clients Set removes res on req 'close'; poll only reads rows past cursor.
 *   T-27-10: in-flight-slug Set prevents duplicate concurrent generate spawns; slug sanitized.
 *   T-27-11: viz server DB handle stays read-only; all writes happen inside the spawned CLI.
 *   T-27-13: /doc/staleness is read-only SELECT; never touches last_access of cited facts.
 *   T-44-15: POST /settings whitelists override keys; unknown/dangerous keys → 400.
 *   T-44-16: /settings + /usage inherit the DNS-rebinding 403 guard (loopback bind only).
 *   T-44-17: all handlers catch → 500 'internal error'; never echo stack/SQL/values.
 *   T-44-18: settings writes are filesystem-only (settings.json); DB handle stays read-only.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import Database from 'better-sqlite3';
import { ftsQueryFromText } from '../retrieval/topk';
import {
  defaultSettingsPath,
  loadMergedConfig,
  loadSettingsFile,
  writeSettingsFile,
} from '../adapter/settings-loader';
import {
  readStatus,
  buildGeneratingEnvelope,
} from '../adapter/gen-status';
import type { PresetName, SettingsFile } from '../lib/config';
import { PRED_SET } from '../model/typed-predicates';
import { buildHonestOneHopTrace, projectHopsForSink, type HonestTraceReader } from '../retrieval/honest-trace';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_MS = 250;  // polling interval for activation_trace SSE broadcast
const SEARCH_LIMIT = 20;  // BM25 result cap for /search?q= endpoint (T-19-03)
// GET /stats/brain-health last_sleep_pass (Phase 60, D-14): no persisted pass-boundary
// record exists (No Analog Found), so a "batch" is approximated as every
// consolidation_event row within this window of the most recent event.
const BATCH_WINDOW_MS = 30 * 60_000; // 30 minutes

// Names of the scheduler scalars authored ONLY in src/viz/modules/constants.js (D-10).
// The server derives these values at startVizServer init via source-parse — see
// parseSchedulerScalars() below — instead of re-declaring them as literals (kills the
// WR-01 client/server mirror-drift class: SPONT_HOP_TOPN had already drifted 6 vs 3).
const SCHEDULER_SCALAR_NAMES = [
  'REPLAY_IDLE_GAP_MS',
  'REPLAY_CADENCE_MS',
  'REPLAY_HISTORY_N',
  'SPONT_CADENCE_MS',
  'SPONT_SEED_COUNT',
  'SPONT_HOP_TOPN',
  'SPONT_POOL_REFRESH_MS',
] as const;
type SchedulerScalarName = (typeof SCHEDULER_SCALAR_NAMES)[number];

/**
 * Parse every named scheduler scalar out of constants.js's source text (fail-fast: throws
 * if any name is absent rather than silently defaulting — T-57-01). Reused across both
 * dev (__dirname = src/viz/) and prod (__dirname = dist/src/viz/, per copy-viz-assets.cjs)
 * since MODULES_ROOT resolves relative to __dirname either way. Exported for direct unit
 * testing (D-10/D-12 shared-source-sync lock), mirroring the pickSpontaneousSeeds convention.
 */
export function parseSchedulerScalars(modulesRoot: string): Record<SchedulerScalarName, number> {
  const src = fs.readFileSync(path.join(modulesRoot, 'constants.js'), 'utf8');
  const result = {} as Record<SchedulerScalarName, number>;
  for (const name of SCHEDULER_SCALAR_NAMES) {
    const match = src.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([\\d.]+)`));
    if (!match) {
      throw new Error(`viz server: constants.js is missing required scheduler scalar '${name}'`);
    }
    result[name] = Number(match[1]);
  }
  return result;
}

/** One dated cost-lever marker parsed from constants.js's COST_EVENTS array (D-11). */
export interface CostEventMarker {
  date: string;
  label: string;
}

/**
 * Parse the COST_EVENTS array literal out of constants.js's source text (fail-fast,
 * mirroring parseSchedulerScalars() above — T-60-09 single-source: the marker list is
 * authored ONLY in constants.js, D-11, and MUST NOT be re-declared as a server literal
 * or the client/server mirror-drift class parseSchedulerScalars already exists to kill
 * would reopen for cost markers). Exported for direct unit testing.
 */
export function parseCostEvents(modulesRoot: string): CostEventMarker[] {
  const src = fs.readFileSync(path.join(modulesRoot, 'constants.js'), 'utf8');
  const arrayMatch = src.match(/export\s+const\s+COST_EVENTS\s*=\s*\[([\s\S]*?)\];/);
  if (!arrayMatch) {
    throw new Error("viz server: constants.js is missing required 'COST_EVENTS' array");
  }
  const entries: CostEventMarker[] = [];
  const entryRe = /\{\s*date:\s*'([^']*)'\s*,\s*label:\s*'([^']*)'\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(arrayMatch[1]!)) !== null) {
    entries.push({ date: m[1]!, label: m[2]! });
  }
  return entries;
}

/**
 * Sample `count` DISTINCT ids uniformly at random from `pool` using the injected `rng`
 * (Math.random in production, a seeded fn in tests). Returns fewer only when the pool is
 * smaller than `count`. Pure / side-effect-free — exported for direct unit testing (D-03).
 * Score is a fixed passthrough placeholder; the emitted hop scores are always null regardless.
 */
export function pickSpontaneousSeeds(
  pool: string[],
  count: number,
  rng: () => number,
): Array<{ node_id: string; score: number }> {
  const n = Math.min(count, pool.length);
  const shuffled = [...pool];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (shuffled.length - i));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  return shuffled.slice(0, n).map(node_id => ({ node_id, score: 0 }));
}

// ---------------------------------------------------------------------------
// POST /settings — key whitelist (T-44-15)
// ---------------------------------------------------------------------------

/**
 * Override keys accepted by POST /settings. Matches the keys allowed in SettingsFile.overrides
 * (src/lib/config.ts). Any key not in this set → 400 'unknown key' (T-44-15).
 */
const SETTABLE_OVERRIDE_KEYS = new Set<string>([
  'consolSkipThreshold',
  'consolSkipThresholdAssistant',
  'corpusSubjectDriftThreshold',
  'corpusGen',
  'corpusGenMax',
  'schemaInductionEnabled',
  'sleepFrequencyHours',
]);

/** Override keys that expect boolean JSON values (all others expect number). */
const BOOLEAN_OVERRIDE_KEYS = new Set<string>(['corpusGen', 'schemaInductionEnabled']);

// ---------------------------------------------------------------------------
// /graph link-key contract (LOCKED — Plan 04 frontend depends on this shape)
// ---------------------------------------------------------------------------

interface NodeRecord {
  id: string;
  type: string;
  value: string;
  s: number;
  c: number;
  origin: string;
  tombstoned: number;
}

interface LinkRecord {
  source: string;   // mapped from edge.src
  target: string;   // mapped from edge.dst
  rel: string;
  w: number;
  kind: string;
}

interface GraphPayload {
  nodes: NodeRecord[];
  links: LinkRecord[];
  /** type=doc branch only: root scopes of recognized projects (61-15, WR-03). */
  projectScopes?: string[];
}

// ---------------------------------------------------------------------------
// Path-traversal-safe static file serving
// ---------------------------------------------------------------------------

/** Allowed root directories for static serving (src/viz/ and subdirectories). */
const VIZ_ROOT = path.resolve(__dirname);
const VENDOR_ROOT = path.resolve(VIZ_ROOT, 'vendor');
const MODULES_ROOT = path.resolve(VIZ_ROOT, 'modules');
const CSS_ROOT = path.resolve(VIZ_ROOT, 'css');

/**
 * Serve a file from the filesystem with:
 *   - MIME type enforcement (.html → text/html, .js/.mjs → text/javascript,
 *     .css → text/css, .png → image/png, .ttf → font/ttf, else text/plain)
 *   - 404 on read error
 */
function serveFile(res: http.ServerResponse, fp: string): void {
  fs.readFile(fp, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    const mime =
      ext === '.html' ? 'text/html' :
      (ext === '.js' || ext === '.mjs') ? 'text/javascript' :
      ext === '.css' ? 'text/css' :
      ext === '.png' ? 'image/png' :
      ext === '.ttf' ? 'font/ttf' :
      'text/plain';
    res.writeHead(200, { 'content-type': mime });
    res.end(buf);
  });
}

/**
 * Resolve a vendor URL segment to an absolute path and assert it stays inside
 * VENDOR_ROOT (T-10-07 path-traversal guard).
 * Returns the resolved absolute path if safe, null if the request escapes the root.
 */
function safeVendorPath(segment: string): string | null {
  // path.join normalises /../ sequences; path.resolve makes it absolute
  const resolved = path.resolve(VENDOR_ROOT, segment);
  // Boundary check: resolved must be exactly VENDOR_ROOT or a child of it
  if (resolved !== VENDOR_ROOT && !resolved.startsWith(VENDOR_ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// startVizServer
// ---------------------------------------------------------------------------

/**
 * Start the viz HTTP server.
 *
 * @param dbPath - Absolute path to recense.db; opened read-only (D-95, T-10-08).
 * @param port   - TCP port to listen on (bound to 127.0.0.1 only, T-10-09).
 * @param opts   - Optional overrides for test isolation (e.g. settingsPath for tmp file).
 * @returns The http.Server instance (call .close() to stop).
 */
export function startVizServer(
  dbPath: string,
  port: number,
  opts?: { settingsPath?: string },
): http.Server {
  // Resolve the settings file path — callers can supply a tmp path for test isolation
  // so the founder's live ~/.config/recense/settings.json is never touched in tests.
  const settingsPath = opts?.settingsPath ?? defaultSettingsPath();
  // D-95: open our OWN read-only handle — never share a write-enabled instance.
  const db = new Database(dbPath, { readonly: true });

  // D-10: derive the scheduler scalars from constants.js (the single authored source)
  // rather than re-declaring hand-mirrored literals. One-time sync read at init —
  // startVizServer is synchronous, and this small local read adds no per-request I/O
  // (T-57-02).
  const {
    REPLAY_IDLE_GAP_MS,
    REPLAY_CADENCE_MS,
    REPLAY_HISTORY_N,
    SPONT_CADENCE_MS,
    SPONT_SEED_COUNT,
    SPONT_HOP_TOPN,
    SPONT_POOL_REFRESH_MS,
  } = parseSchedulerScalars(MODULES_ROOT);

  // D-11: source-parse cost-event markers from constants.js at init (same fail-fast
  // single-source mechanism as the scheduler scalars above) — never re-declared here.
  const costEvents = parseCostEvents(MODULES_ROOT);

  // T-27-10: track in-flight slug generations to prevent duplicate concurrent spawns.
  // Key = slug, Value = Date.now() when the generate-doc CLI was first spawned for it.
  // Storing the start time (not just a boolean) lets the 202 payload report the REAL
  // elapsed generation time, so a reader reopened mid-generation resumes its progress bar
  // from where the backend actually is instead of restarting at 0s (the detached child
  // keeps running across reader close/reopen; only the UI used to forget).
  // Per-instance (not module-level) so multiple servers in one process — e.g. tests — don't
  // leak in-flight state into each other now that GET /doc consults this map (RGS-01).
  const inFlightSlugs = new Map<string, number>();

  // Compile /graph prepared statements once (T-01-SQL pattern).
  const stmtNodes = db.prepare(
    'SELECT id, type, value, s, c, origin, tombstoned FROM node'
  );
  const stmtEdges = db.prepare(
    'SELECT src, dst, rel, w, kind FROM edge'
  );

  // Compile /graph?type=doc corpus statements once (READER-04 — doc-only corpus graph).
  // Returns live (tombstoned=0) type='doc' nodes with their slug (from node_doc sidecar)
  // so the client can resolve doc-node click → slug → reader open (D-08).
  // BUG-1 fix (28-04): for schema-anchored docs the slug = schemaId (UUID). LEFT JOIN the
  // schema node to resolve its human label; COALESCE(NULLIF(sch.value,''), nd.slug) gives
  // the human label when the schema has one, or falls back to the slug (which = schemaId UUID
  // for schema docs, or the project name string for project-scope docs). Project-scope docs
  // (slug='tonos' etc.) won't match any schema.id → sch.value IS NULL → fall back to slug.
  const stmtDocNodes = db.prepare(`
    SELECT n.id, n.type, n.value, n.s, n.c, n.origin, n.tombstoned, nd.slug,
           COALESCE(NULLIF(sch.value, ''), nd.slug) AS label,
           ns.scope
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    LEFT JOIN node sch ON sch.id = nd.slug AND sch.type = 'schema' AND sch.tombstoned = 0
    LEFT JOIN node_scope ns ON ns.node_id = n.id
    WHERE n.type='doc' AND n.tombstoned=0
  `);

  // GAP-8 (61-17, WR-04/IN-06): shared UUID guard + humanTitle() derivation, hoisted here so
  // BOTH the /graph?type=doc doc-node mapping and the /index handler read stmtDocNodes rows
  // through the SAME guard — a doc-node label can never drift between the two surfaces.
  // A schema-anchored doc whose backing schema node has no value falls back to nd.slug in the
  // stmtDocNodes COALESCE label above — but for those docs nd.slug IS the schema UUID, leaking
  // it as a visible label. humanTitle() derives a human title instead: keep already-human labels
  // as-is, else pull the doc's first markdown H1, else a human generic. Never a UUID.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const humanTitle = (row: { label: string; value: string }): string => {
    if (row.label && !UUID_RE.test(row.label)) return row.label;
    const h1 = row.value.match(/^\s*#\s+(.+?)\s*$/m);
    if (h1) return h1[1]!.trim();
    return 'Untitled note';
  };

  // CORPUS-04: Return doc_link + doc_containment + doc_reference edges, but only between
  // live (tombstoned=0) doc nodes on both ends. Dangling edges whose src or dst has been
  // tombstoned or is not a doc node are excluded (T-28-DANGLE guard).
  const stmtDocLinks = db.prepare(
    "SELECT src, dst, rel, w, kind FROM edge" +
    " WHERE kind IN ('doc_link','doc_containment','doc_reference')" +
    " AND src IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)" +
    " AND dst IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)"
  );

  // GAP-4 (61-08, read-only schema→project resolution): for each schema, the project scopes
  // its D-37-gated 'abstracts' members carry, grouped with member counts. Mirrors
  // corpus-promoter.ts stmtGetSchemasInScope (lines 244-254), but reversed (schema → scopes,
  // not scope → schemas) and grouped so the caller can pick the DOMINANT scope. D-37 firewall
  // predicates kept verbatim: type IN ('fact','entity'), tombstoned=0, origin != 'inferred'.
  // 'global'-scoped members are excluded — they never resolve to a PROJECT.
  const stmtSchemaProjectScopes = db.prepare(`
    SELECT e.src AS schemaId, ns.scope AS scope, COUNT(*) AS members
    FROM edge e
    JOIN node m ON m.id = e.dst
    JOIN node_scope ns ON ns.node_id = m.id
    WHERE e.kind = 'abstracts'
      AND m.type IN ('fact','entity') AND m.tombstoned = 0 AND m.origin != 'inferred'
      AND ns.scope != 'global'
      AND EXISTS (SELECT 1 FROM node s WHERE s.id = e.src AND s.type='schema' AND s.tombstoned=0)
    GROUP BY e.src, ns.scope
  `);

  /**
   * Resolve each schema's single dominant owning project scope (GAP-4, read-only).
   * A schema belongs to project scope S iff at least one D-37-gated abstracts member has
   * node_scope = S. When a schema's gated members span multiple project scopes, the scope
   * with the MOST members wins; ties break alphabetically — a single deterministic parent.
   * Recomputed fresh per request (cheap; no caching needed for a read-only projection).
   */
  function resolveSchemaToProject(): Map<string, string> {
    const rows = stmtSchemaProjectScopes.all() as Array<{ schemaId: string; scope: string; members: number }>;
    const best = new Map<string, { scope: string; members: number }>();
    for (const row of rows) {
      const cur = best.get(row.schemaId);
      if (!cur || row.members > cur.members || (row.members === cur.members && row.scope < cur.scope)) {
        best.set(row.schemaId, { scope: row.scope, members: row.members });
      }
    }
    const out = new Map<string, string>();
    for (const [schemaId, v] of best) out.set(schemaId, v.scope);
    return out;
  }

  // Compile /doc?slug= prepared statements once (READER-02, T-27-11 — read-only only).
  // Resolve by node_doc.slug — the canonical doc identifier the client passes. The
  // prior version keyed on node_scope.scope, which only worked for docs whose scope
  // happened to equal their slug (hubs, and subject docs left on the stale slug-scope).
  // Subject docs correctly scoped to the bare project root (e.g. brain-memory's) were
  // unresolvable by slug. Keying on the slug decouples resolution from node_scope so
  // scope can be the project root for coloring/containment without breaking /doc.
  const stmtGetDoc = db.prepare(`
    SELECT n.id, n.value, nd.generated_at
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.type = 'doc' AND nd.slug = ? AND n.tombstoned = 0
    LIMIT 1
  `);

  // Resolve a live doc node's slug by its NODE id (READER-04 doc-ref click, ?id= path).
  // Exact match first; else unique-prefix match (the doc generator can TRUNCATE doc ids
  // the same way it truncates fact ids — see the 27-02 fix). LIMIT 2 detects ambiguity.
  // Returns node_doc.slug so the existing slug-based statements can serve the doc as today.
  const stmtDocSlugByExactId = db.prepare(`
    SELECT nd.slug
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.id = ? AND n.type = 'doc' AND n.tombstoned = 0
    LIMIT 1
  `);
  const stmtDocSlugByPrefixId = db.prepare(`
    SELECT nd.slug
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    WHERE n.id LIKE ? AND n.type = 'doc' AND n.tombstoned = 0
    LIMIT 2
  `);

  /**
   * Resolve a doc-node id (full or truncated prefix) to its live doc slug.
   * Exact match → that slug. Else unique-prefix match → that slug. Unknown or
   * ambiguous (>1 prefix match) → null. Read-only; T-27-11 posture preserved.
   */
  function resolveDocSlugById(rawId: string): string | null {
    // Sanitize to the doc-id charset (hex + dashes); cap length defensively.
    const id = rawId.toLowerCase().replace(/[^a-f0-9-]/g, '').slice(0, 64);
    if (!id) return null;
    const exact = stmtDocSlugByExactId.get(id) as { slug: string } | undefined;
    if (exact) return exact.slug;
    // Unique-prefix: escape LIKE metacharacters (ids are hex+dashes, guard defensively).
    const likePattern = id.replace(/[%_]/g, '') + '%';
    const rows = stmtDocSlugByPrefixId.all(likePattern) as Array<{ slug: string }>;
    if (rows.length === 1) return rows[0]!.slug;
    return null; // 0 matches → unknown; >1 → ambiguous
  }

  // Compile /doc/meta?slug= cited-ids statement once (READER-02).
  // Returns the set of fact ids cited by the doc node (kind='cites' outgoing edges).
  const stmtCitedIds = db.prepare(`
    SELECT dst AS factId FROM edge WHERE src = ? AND kind = 'cites'
  `);

  // Compile /doc/staleness cited-facts statement once (READER-03, T-27-13 — read-only).
  // Joins the cites edges to the cited fact node rows; caller compares n.last_access to
  // node_doc.generated_at to determine which refs have changed or been tombstoned.
  const stmtCitedFacts = db.prepare(`
    SELECT ce.dst AS factId, n.value, n.prev_value, n.prev_ts, n.last_access, n.tombstoned
    FROM edge ce
    JOIN node n ON n.id = ce.dst
    WHERE ce.src = ? AND ce.kind = 'cites'
  `);

  // Compile /doc/backlinks incoming-edge statement once (39-01, WIKI-02 — read-only).
  // Returns incoming doc→doc wiki-meaningful edges for a given destination doc id.
  // Filters to kind IN ('doc_link','doc_reference','doc_containment') per D-06 — engine
  // kinds (derived_from, abstracts, schema membership) are excluded from browsing surfaces.
  // src must be a live (tombstoned=0) doc node; dangling edges from tombstoned src excluded.
  // JOIN node_doc + LEFT JOIN schema node mirrors stmtDocNodes COALESCE label resolution.
  // WR-04 (39 review): GROUP BY e.src so a source doc linking via >1 wiki edge kind renders
  // ONCE (slug/label are functionally dependent on e.src; MIN(e.kind) picks one representative).
  const stmtDocBacklinks = db.prepare(`
    SELECT e.src AS srcId, nd.slug,
           COALESCE(NULLIF(sch.value, ''), nd.slug) AS label,
           MIN(e.kind) AS kind
    FROM edge e
    JOIN node src_n ON src_n.id = e.src AND src_n.type = 'doc' AND src_n.tombstoned = 0
    JOIN node_doc nd ON nd.node_id = e.src
    LEFT JOIN node sch ON sch.id = nd.slug AND sch.type = 'schema' AND sch.tombstoned = 0
    WHERE e.dst = ? AND e.kind IN ('doc_link', 'doc_reference', 'doc_containment')
    GROUP BY e.src
  `);

  // Compile /doc/backlinks?fact= reverse-cites statement once (39-01, D-05 atom view).
  // Returns live doc nodes that cite the given fact id via kind='cites' edges.
  // Same COALESCE label resolution as stmtDocBacklinks.
  const stmtCitingDocs = db.prepare(`
    SELECT e.src AS srcId, nd.slug,
           COALESCE(NULLIF(sch.value, ''), nd.slug) AS label
    FROM edge e
    JOIN node src_n ON src_n.id = e.src AND src_n.type = 'doc' AND src_n.tombstoned = 0
    JOIN node_doc nd ON nd.node_id = e.src
    LEFT JOIN node sch ON sch.id = nd.slug AND sch.type = 'schema' AND sch.tombstoned = 0
    WHERE e.dst = ? AND e.kind = 'cites'
    GROUP BY e.src
  `);

  // Compile /search BM25 prepared statement once (T-19-01 — query passes through
  // ftsQueryFromText before reaching MATCH; JOIN ON tombstoned=0 excludes deleted nodes;
  // ORDER BY rank ascending = best BM25 first; LIMIT caps the result set, T-19-03).
  const stmtSearch = db.prepare(`
    SELECT f.node_id AS id
    FROM node_fts f JOIN node n ON n.id = f.node_id AND n.tombstoned = 0
    WHERE node_fts MATCH ?
    ORDER BY rank LIMIT ?
  `);

  // Compile /usage aggregate prepared statements once (44-05, D-09/D-10, T-44-18 read-only).
  // Rolling-30d: WHERE ts > ? (caller passes Date.now() - 30d cutoff ms).
  // All-time: no WHERE clause.
  // Each row: feature_tag + per-token-column sums + total_cost_usd sum.
  // GROUP BY feature_tag so each row maps 1:1 to a cost-bearing toggle in the panel (D-09).
  const stmtUsage30d = db.prepare(`
    SELECT feature_tag,
           SUM(input_tokens)       AS input_tokens,
           SUM(output_tokens)      AS output_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(total_cost_usd)     AS total_cost_usd
    FROM token_usage_ledger
    WHERE ts > ?
    GROUP BY feature_tag
  `);
  const stmtUsageAllTime = db.prepare(`
    SELECT feature_tag,
           SUM(input_tokens)       AS input_tokens,
           SUM(output_tokens)      AS output_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(total_cost_usd)     AS total_cost_usd
    FROM token_usage_ledger
    GROUP BY feature_tag
  `);

  // Compile GET /stats/usage prepared statements once (Phase 60, D-09/D-10/D-12,
  // T-44-18 read-only). Daily buckets (window=7d/30d/90d) and weekly buckets
  // (window=all) both take a single ts cutoff bind (0 = no lower bound / all-time).
  // Bucketing follows the same strftime idiom stmtUsage30d's neighbours use for
  // grouping — no new query shape, just a different GROUP BY key.
  const stmtUsageDailyBuckets = db.prepare(`
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
           SUM(input_tokens + output_tokens) AS tokens,
           SUM(total_cost_usd)               AS cost_usd
    FROM token_usage_ledger
    WHERE ts > ?
    GROUP BY date
    ORDER BY date ASC
  `);
  // Phase 60-03 fix (Rule 1): the original '%Y-%W' week-number grouping key is not a
  // parseable calendar date, but the client (stats-dashboard.js/charts.js fmtDate)
  // renders every bucket's `date` as a real date for the X-axis/hover — required by
  // the UI-SPEC's "weekly-bucket tick labels the bucket start date". Group by the
  // Monday-start ISO week date instead (same GROUP BY shape, different key expression,
  // per this block's own "different GROUP BY key" comment above): subtract
  // ((weekday + 6) % 7) days from each row's date to land on that week's Monday.
  const stmtUsageWeeklyBuckets = db.prepare(`
    SELECT date(ts/1000, 'unixepoch',
             '-' || ((CAST(strftime('%w', ts/1000, 'unixepoch') AS INTEGER) + 6) % 7) || ' days'
           ) AS date,
           SUM(input_tokens + output_tokens) AS tokens,
           SUM(total_cost_usd)               AS cost_usd
    FROM token_usage_ledger
    WHERE ts > ?
    GROUP BY date
    ORDER BY date ASC
  `);
  const stmtUsageByModel = db.prepare(`
    SELECT model,
           SUM(input_tokens)       AS input_tokens,
           SUM(output_tokens)      AS output_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(total_cost_usd)     AS total_cost_usd
    FROM token_usage_ledger
    WHERE ts > ?
    GROUP BY model
  `);

  // Compile GET /stats/usage `summary` prepared statements once (Phase 60-08,
  // GAP-2a/2b, T-44-18 read-only). All cutoffs are server-derived Date.now()-based
  // ms bound via '?' — never raw request input (T-60-08-01). These feed the
  // stat-tile row + subscription-limit framing, independent of the `window` pill.
  const stmtTokensSince = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(total_cost_usd), 0)                AS cost
    FROM token_usage_ledger
    WHERE ts > ?
  `);
  const stmtTokensBetween = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(total_cost_usd), 0)                AS cost
    FROM token_usage_ledger
    WHERE ts > ? AND ts <= ?
  `);
  const stmtHeaviestDaySince = db.prepare(`
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
           SUM(input_tokens + output_tokens) AS tokens
    FROM token_usage_ledger
    WHERE ts > ?
    GROUP BY date
    ORDER BY tokens DESC
    LIMIT 1
  `);

  // Compile GET /stats/usage `lever_deltas` prepared statement once (Phase 60-08,
  // GAP-2c). Unwindowed daily buckets across the FULL ledger span (no lower bound)
  // so the "did this lever work?" card stays stable regardless of the range pill —
  // unlike the windowed cost_event_deltas above, which can be distorted to 0/day
  // garbage when the window precedes both events.
  const stmtUsageDailyBucketsAll = db.prepare(`
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
           SUM(input_tokens + output_tokens) AS tokens,
           SUM(total_cost_usd)               AS cost_usd
    FROM token_usage_ledger
    WHERE ts > 0
    GROUP BY date
    ORDER BY date ASC
  `);

  // Compile GET /stats/brain-health prepared statements once (Phase 60, D-13/D-14,
  // T-44-18 read-only). node.created_at does not exist (D-13) — growth is
  // reconstructed from node-birth consolidation_event rows (event_type in the
  // node-creation set with a non-null node_id); the handler accumulates the
  // per-day counts into a running total and flags the series `approximate: true`
  // per D-13 (old events may have been pruned, so this is a lower bound).
  // Event set = events that MINT a node (consolidator.ts applyDecision):
  //   'extend' / 'unrelated' / 'contradict_append_new' / 'contradict_oscillation'
  //   each upsert a brand-new node; 'schema_emitted' mints a schema node.
  // Excluded: 'confirm' strengthens the EXISTING candidate (node_id is the existing
  // node, not a birth); 'contradict_hold' creates nothing. 'contradict_reconcile'
  // and the force-reconcile variant of 'contradict_force_destabilize' mint a
  // replacement node but tombstone the superseded one — net-zero growth, so they
  // are deliberately excluded (documented choice per the D-13 approximation flag).
  const stmtNodeGrowthDaily = db.prepare(`
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date, COUNT(*) AS count
    FROM consolidation_event
    WHERE node_id IS NOT NULL
      AND event_type IN ('schema_emitted', 'extend', 'unrelated',
                         'contradict_append_new', 'contradict_oscillation')
    GROUP BY date
    ORDER BY date ASC
  `);
  const stmtKindMix = db.prepare(`
    SELECT type, COUNT(*) AS count FROM node WHERE tombstoned = 0 GROUP BY type
  `);
  const stmtReconsPerDay = db.prepare(`
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date, COUNT(*) AS count
    FROM consolidation_event
    WHERE event_type IN ('contradict_reconcile', 'contradict_force_destabilize', 'contradict_oscillation')
    GROUP BY date
    ORDER BY date ASC
  `);
  // Tombstone set includes the dedup-pass merges ('entity_merge'/'fact_merge'
  // tombstone their loser nodes). APPROXIMATE: 'contradict_force_destabilize' has
  // two variants not distinguishable from the event row alone — the force-reconcile
  // variant tombstones, the oscillation variant appends a coexisting node and does
  // not — so this per-day count can overcount; the client renders an approximation
  // caption on this chart (and on reconsolidations/day, whose 'contradict_oscillation'
  // rows are coexistence appends, not in-place updates).
  const stmtTombstonesPerDay = db.prepare(`
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date, COUNT(*) AS count
    FROM consolidation_event
    WHERE event_type IN ('contradict_reconcile', 'contradict_force_destabilize',
                         'schema_falsified', 'entity_merge', 'fact_merge')
    GROUP BY date
    ORDER BY date ASC
  `);
  // NOTE (no-fabricated-metrics): the ledger CANNOT measure judge escalation.
  // feature_tag for judge calls is derived from the model name (claude-headless-
  // client.ts deriveFeatureTag: Haiku→'extract', Sonnet→'judge'; there is no
  // setHeadlessFeature('judge') bracket), so every feature_tag='judge' row is a
  // Sonnet row by construction — a "escalated / fires" ratio computed from these
  // rows is structurally 1.0 regardless of the twoTierJudge setting. The handler
  // therefore reports escalation_rate: null (unavailable) until the ledger can
  // distinguish tiers; only honest fires are counted here.
  const stmtJudgeFires = db.prepare(`
    SELECT COUNT(*) AS count FROM token_usage_ledger WHERE feature_tag = 'judge'
  `);
  const stmtEpisodesByConsolidated = db.prepare(`
    SELECT consolidated, COUNT(*) AS count FROM episode GROUP BY consolidated
  `);
  // last_sleep_pass (D-14, No-Analog-Found): no persisted last-pass record exists.
  // Approximate a "batch" as every consolidation_event row within BATCH_WINDOW_MS
  // of the most recent event — honest best-effort, never a fabricated success flag.
  const stmtLastEventMaxTs = db.prepare(`SELECT MAX(ts) AS maxTs FROM consolidation_event`);
  const stmtLastEventBatchSpan = db.prepare(`
    SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM consolidation_event WHERE ts >= ?
  `);

  // Compile /events polling statement once.
  // D-07-seedshape: seeds column may hold legacy string[] OR post-52 [{node_id,score}] objects;
  // server is shape-transparent and ships whatever the column holds (client normalises).
  const stmtTrace = db.prepare(
    'SELECT id, ts, query_id, seeds, hops, kind FROM activation_trace WHERE id > ? ORDER BY id ASC'
  );

  // Active SSE response objects (T-10-11: removed on req 'close').
  const clients = new Set<http.ServerResponse>();

  // Highest activation_trace.id already broadcast (monotonically increasing AUTOINCREMENT).
  // WR-01: seed the cursor at the current max id so retained historical rows (the
  // table is a persistent ring buffer) are NOT replayed as "live" on first connect —
  // only genuinely new traces stream.
  let cursor = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activation_trace').get() as { m: number }).m;

  // Phase 54 (Task 1 — Plan 54-03): replay ring buffer + idle timer.
  // Populated by the live poll; read by the replay scheduler below. No extra DB handle.
  interface ReplayRow {
    id: number; ts: number; query_id: string;
    seeds: unknown; hops: unknown; kind: string | null;
  }
  const replayBuffer: ReplayRow[] = [];
  let lastLiveRow = Date.now();

  // D-98: poll activation_trace every POLL_MS ms and push new rows to all SSE clients.
  const pollInterval = setInterval(() => {
    if (clients.size === 0) return;
    const fresh = stmtTrace.all(cursor) as Array<{
      id: number; ts: number; query_id: string; seeds: string; hops: string; kind: string | null;
    }>;
    if (!fresh.length) return;
    cursor = fresh[fresh.length - 1]!.id;
    for (const row of fresh) {
      // seeds/hops are TEXT columns holding JSON-encoded strings (written via
      // JSON.stringify in activation-sink.ts). Parse them server-side so the SSE
      // wire contract ships real arrays, not nested JSON strings (CR-01).
      // L-4: guard corrupt rows — invalid JSON must not kill the setInterval callback.
      let seeds: unknown;
      let hops: unknown;
      try {
        seeds = JSON.parse(row.seeds);
        hops  = JSON.parse(row.hops);
      } catch {
        continue; // skip corrupt row, keep polling and streaming
      }
      // Phase 54 (Task 1): push into replay ring — only rows with non-empty seeds arrays
      // (Pitfall 3: skip empty/malformed rows so replay never re-emits a no-op trace).
      // CR-02 defense-in-depth (Phase 57-08): also require null/recall kind — replay
      // echoes recalls only (per TRIGGER-STEPS.md); ingestion-kind rows never enter the
      // replay buffer at all. The client-side neutral fallback above remains as a second
      // guard against any future regression; this admission guard is belt-and-suspenders.
      if (Array.isArray(seeds) && seeds.length > 0 && (row.kind == null || row.kind === 'recall')) {
        replayBuffer.push({ id: row.id, ts: row.ts, query_id: row.query_id, seeds, hops, kind: row.kind ?? null });
        if (replayBuffer.length > REPLAY_HISTORY_N) {
          replayBuffer.splice(0, replayBuffer.length - REPLAY_HISTORY_N);
        }
      }
      const payload = `event: trace\ndata: ${JSON.stringify({
        id: row.id,
        ts: row.ts,
        query_id: row.query_id,
        // seeds: shape-transparent passthrough — may be legacy string[] OR
        // post-52 [{node_id,score}] from Plan 02; client normalises (D-07-seedshape).
        seeds,
        hops,
        // kind: null for back-compat recall rows (client treats null as recall).
        kind: row.kind ?? null,
      })}\n\n`;
      for (const res of clients) {
        res.write(payload);
      }
    }
    // Phase 54 (Task 1): record timestamp of last real row batch (live-preempt signal for
    // the replay scheduler). fresh.length > 0 is guaranteed here by the early-return above.
    lastLiveRow = Date.now();
  }, POLL_MS);

  // Prevent the interval from keeping the process alive after server.close().
  pollInterval.unref();

  // Phase 54 (Task 2 — Plan 54-03): idle-gated replay scheduler.
  // Re-emits a recent real row tagged `replay: true` over /events when the live poll
  // has been silent for REPLAY_IDLE_GAP_MS. Gives the brain real (but past) activity
  // to echo during idle sessions without fabricating data (SC1 + SC3).
  //
  // Boundary invariants (T-54-05, T-54-06):
  //   - Reads ONLY replayBuffer (in-memory ring populated by the live poll)
  //   - Opens no new Database(); no LLM calls, no outbound network requests
  //   - Does NOT reference or assign `cursor` — replay is a side-channel re-emit;
  //     the /events cursor is forward-only and must never be rewound
  const replayInterval = setInterval(() => {
    if (clients.size === 0) return;
    if (replayBuffer.length === 0) return;
    if (Date.now() - lastLiveRow < REPLAY_IDLE_GAP_MS) return;  // live preempts replay (SC3)
    // Pick a row from the recency-trimmed buffer (uniform random over the ring).
    const row = replayBuffer[Math.floor(Math.random() * replayBuffer.length)]!;
    const replayPayload = `event: trace\ndata: ${JSON.stringify({
      id: row.id,
      ts: row.ts,
      query_id: row.query_id,
      seeds: row.seeds,
      hops: row.hops,
      kind: row.kind,
      replay: true,
    })}\n\n`;
    for (const res of clients) {
      res.write(replayPayload);
    }
  }, REPLAY_CADENCE_MS);
  replayInterval.unref();

  // Phase 56 (Plan 02): eligible-seed pool for the spontaneous idle emitter.
  // Read-only: a single bounded DISTINCT SELECT over live nodes with at least one real
  // PRED_SET semantic out-edge (T-56-04) — guarantees every sampled seed has ≥1 honest
  // edge, so a tick never comes up empty (D-02). Cached and rebuilt lazily, at most once
  // per SPONT_POOL_REFRESH_MS (not per tick).
  const stmtEligibleSeeds = db.prepare(
    `SELECT DISTINCT e.src AS src, e.rel AS rel
     FROM edge e JOIN node n ON n.id = e.src
     WHERE e.kind = 'relation' AND n.tombstoned = 0`
  );
  let spontaneousPool: string[] = [];
  let poolBuiltAt = 0;
  function refreshSpontaneousPool(): void {
    const rows = stmtEligibleSeeds.all() as Array<{ src: string; rel: string }>;
    const distinctSrc = new Set<string>();
    for (const row of rows) {
      if (PRED_SET.has(row.rel)) distinctSrc.add(row.src);
    }
    spontaneousPool = Array.from(distinctSrc);
    poolBuiltAt = Date.now();
  }
  refreshSpontaneousPool();

  // Phase 56 (Plan 02): read-only HonestTraceReader over the SAME readonly db handle
  // (T-56-02) — no new Database(), no write-capable SemanticStore. Two prepared SELECTs
  // mirror SemanticStore.getOutEdgesWithRel / getNode exactly.
  const stmtSpontOutEdges = db.prepare('SELECT dst, rel, w, kind FROM edge WHERE src = ?');
  const stmtSpontGetNode = db.prepare('SELECT tombstoned FROM node WHERE id = ?');
  const spontaneousReader: HonestTraceReader = {
    getOutEdgesWithRel(id: string) {
      return stmtSpontOutEdges.all(id) as Array<{ dst: string; rel: string; w: number; kind: string }>;
    },
    getNode(id: string) {
      return stmtSpontGetNode.get(id) as { tombstoned: number } | undefined;
    },
  };

  // Phase 56 (Plan 02): idle-gated spontaneous emitter — mirrors the replay scheduler's
  // gating shape exactly. Fires an honest 1-hop SSE trace ONLY when the replay buffer is
  // EMPTY (replay is the fallback-owner of the idle gap, D-01) and the shared idle gap has
  // elapsed (live preempts, SC3). Never writes an activation_trace row and never touches
  // `cursor` (side-channel re-emit, like replay).
  const spontaneousInterval = setInterval(() => {
    if (clients.size === 0) return;
    if (replayBuffer.length !== 0) return;                       // replay owns the idle gap (D-01)
    if (Date.now() - lastLiveRow < REPLAY_IDLE_GAP_MS) return;    // live preempts (SC3)
    if (Date.now() - poolBuiltAt >= SPONT_POOL_REFRESH_MS) refreshSpontaneousPool();
    const seeds = pickSpontaneousSeeds(spontaneousPool, SPONT_SEED_COUNT, Math.random);
    if (seeds.length === 0) return;
    const { hops } = buildHonestOneHopTrace(seeds, spontaneousReader, SPONT_HOP_TOPN);
    if (hops.length === 0) return;
    // Phase 69 (Plan 02, D-06): project the additive `rel` key back off before this hits the
    // SSE payload — the spontaneous emitter's wire shape stays byte-identical to pre-phase.
    const spontaneousPayload = `event: trace\ndata: ${JSON.stringify({
      seeds,
      hops: projectHopsForSink(hops),
      kind: 'spontaneous',
    })}\n\n`;
    for (const res of clients) {
      res.write(spontaneousPayload);
    }
  }, SPONT_CADENCE_MS);
  spontaneousInterval.unref();

  // ── spawnGenerateDoc: shell out to generate-doc CLI (T-27-11) ─────────────
  // The viz server's DB handle is READ-ONLY, so it cannot write doc nodes directly.
  // Instead, it spawns the `recense generate-doc <slug>` CLI as a detached subprocess.
  // T-27-10: an in-flight Set prevents duplicate concurrent spawns for the same slug.
  function spawnGenerateDoc(slug: string, force = false): void {
    if (inFlightSlugs.has(slug)) return; // T-27-10: already generating (start time preserved)
    inFlightSlugs.set(slug, Date.now());

    // Resolve the compiled CLI script path from the adapter directory.
    const cliScript = path.resolve(__dirname, '../adapter/generate-doc-cli.js');
    const args = [cliScript, slug, '--db', dbPath];
    if (force) args.push('--force');

    // Use process.execPath so we always match the pinned Node binary (same ABI as
    // better-sqlite3 in the child). detached:true + stdio:'ignore' → fire-and-forget.
    const child = child_process.spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref(); // don't prevent the viz server from exiting

    // Clear in-flight once the child exits (success or failure).
    child.on('close', () => inFlightSlugs.delete(slug));
    child.on('error', () => inFlightSlugs.delete(slug));
  }

  // Emit the 202 "generating" envelope with the REAL elapsed generation time for the slug.
  // elapsedMs is derived from the in-flight start time recorded by spawnGenerateDoc, so a
  // reader reopened mid-generation seeds its progress bar from the true elapsed instead of 0
  // (call this AFTER spawnGenerateDoc so a freshly-started slug reports ~0). Falls back to 0
  // if the slug somehow isn't tracked (e.g. the child exited between spawn and this read).
  function send202Generating(res: http.ServerResponse, slug: string): void {
    const startedAt = inFlightSlugs.get(slug);
    const elapsedMs = startedAt != null ? Math.max(0, Date.now() - startedAt) : 0;
    const st = readStatus(slug);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildGeneratingEnvelope(st, elapsedMs)));
  }

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;

    // L-5: DNS rebinding guard — only accept Host headers that match the loopback bind
    // address (T-10-09). A mismatched Host (e.g. attacker.com pointing to 127.0.0.1 via
    // DNS rebinding) is rejected 403; the server never acts as a proxy for external origins.
    const requestHost = req.headers['host'] ?? '';
    if (requestHost !== `127.0.0.1:${port}` && requestHost !== `localhost:${port}`) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    // ── /graph ─────────────────────────────────────────────────────────────
    // ?type=doc returns the doc-only corpus graph (READER-04).
    // No type param (or any other value) returns the full brain graph.
    if (url === '/graph') {
      try {
        const qType = new URLSearchParams(req.url?.split('?')[1] ?? '').get('type');
        let nodes: NodeRecord[];
        let edgeRows: Array<{ src: string; dst: string; rel: string; w: number; kind: string }>;
        let projectScopes: string[] | undefined;
        if (qType === 'doc') {
          // Corpus graph: only live doc nodes + doc_link edges (READER-04 / T-27-16).
          nodes = stmtDocNodes.all() as NodeRecord[];
          edgeRows = stmtDocLinks.all() as Array<{ src: string; dst: string; rel: string; w: number; kind: string }>;
          // GAP-4 (61-08): attach ownerScope to each doc node — for a schema-anchored node
          // (slug = schemaId UUID) this is its resolved project scope, or null when unresolved.
          // Lets the client owner map (corpus.js) group a resolved schema node under its
          // project instead of treating it as a free-floating peer. Non-schema doc nodes
          // always carry ownerScope: null.
          const schemaToProject = resolveSchemaToProject();
          const graphSchemaSlugRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          nodes = (nodes as Array<NodeRecord & { slug?: string; label: string; value: string }>).map(n => {
            const slug = n.slug;
            const ownerScope = slug && graphSchemaSlugRe.test(slug) ? (schemaToProject.get(slug) ?? null) : null;
            // GAP-8 (61-17): pass the doc-node label through the same humanTitle() UUID guard
            // as /index, so hovering a schema-anchored doc with an empty backing schema value
            // never shows the raw UUID slug.
            return { ...n, ownerScope, label: humanTitle(n) };
          }) as NodeRecord[];
          // WR-03 (61-15): ship the single recognized-project root-scope set, mirroring the
          // /index recognized-project rule (a doc is a project when its slug is NOT a UUID) —
          // this admits BOTH hub docs and colon-slug subject docs, excludes UUID chapter docs.
          // The client (corpus.js) consumes this instead of hand-deriving a divergent set.
          const projectScopeSet = new Set<string>();
          for (const n of nodes as Array<NodeRecord & { slug?: string; scope?: string | null }>) {
            const slug = n.slug;
            if (slug && !graphSchemaSlugRe.test(slug) && n.scope) {
              projectScopeSet.add(n.scope.split(':')[0]!);
            }
          }
          projectScopes = [...projectScopeSet];
        } else {
          // Full brain graph (default — no type filter).
          nodes = stmtNodes.all() as NodeRecord[];
          edgeRows = stmtEdges.all() as Array<{ src: string; dst: string; rel: string; w: number; kind: string }>;
        }
        // Map src/dst → source/target (LOCKED link-key contract for Plan 04).
        const links: LinkRecord[] = edgeRows.map(e => ({
          source: e.src,
          target: e.dst,
          rel: e.rel,
          w: e.w,
          kind: e.kind,
        }));
        const payload: GraphPayload = projectScopes !== undefined
          ? { nodes, links, projectScopes }
          : { nodes, links };
        const body = JSON.stringify(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── /search?q= ─────────────────────────────────────────────────────────
    // Read-only BM25 route (VIZ-07). Security invariants:
    //   T-19-01: raw query tokenized + quoted by ftsQueryFromText (never concatenated into SQL).
    //   T-19-02: inherits Host-header guard above — not bypassed.
    //   T-19-04: raw query sliced to 200 chars before tokenizing (ReDoS / unbounded-MATCH guard).
    //   T-19-05: catch returns generic 'internal error'; no SQL/stack detail leaked.
    //   T-19-06: response is a string[] — no DOM injection; callers set textContent.
    // NO new Database(), NO embed/LLM/provider, NO outbound fetch.
    if (url === '/search') {
      const rawQ = new URLSearchParams(req.url?.split('?')[1] ?? '').get('q') ?? '';
      const boundQ = rawQ.slice(0, 200); // T-19-04: length cap before tokenizing
      // prefix:true → incremental matching as the user types ("gi" finds "git"), VIZ-07.
      const ftsQ = ftsQueryFromText(boundQ, true);
      try {
        const ids: string[] = ftsQ
          ? (stmtSearch.all(ftsQ, SEARCH_LIMIT) as Array<{ id: string }>).map(r => r.id)
          : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ids));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── /events (SSE) ───────────────────────────────────────────────────────
    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // ── Static: / and /index.html ───────────────────────────────────────────
    if (url === '/' || url === '/index.html') {
      const indexPath = path.join(VIZ_ROOT, 'index.html');
      // Plan 04 creates index.html; if absent, return a friendly error (not a crash).
      if (!fs.existsSync(indexPath)) {
        res.writeHead(503, { 'content-type': 'text/html' });
        res.end(
          '<!doctype html><html><body>' +
          '<p>recense viz — frontend not yet built. Run plan 04 to generate index.html.</p>' +
          '</body></html>'
        );
        return;
      }
      serveFile(res, indexPath);
      return;
    }

    // ── Static: /vendor/* ───────────────────────────────────────────────────
    if (url.startsWith('/vendor/')) {
      const segment = url.slice('/vendor/'.length);
      const safePath = safeVendorPath(segment);
      if (!safePath) {
        // T-10-07: path escapes vendor root → 403
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      serveFile(res, safePath);
      return;
    }

    // ── Static: /modules/*.js ───────────────────────────────────────────────
    if (url.startsWith('/modules/')) {
      const segment = url.slice('/modules/'.length);
      const resolved = path.resolve(MODULES_ROOT, segment);
      if (resolved !== MODULES_ROOT && !resolved.startsWith(MODULES_ROOT + path.sep)) {
        // T-10-07: path escapes modules root → 403
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      serveFile(res, resolved);
      return;
    }

    // ── Static: /css/*.css ──────────────────────────────────────────────────
    if (url.startsWith('/css/')) {
      const segment = url.slice('/css/'.length);
      const resolved = path.resolve(CSS_ROOT, segment);
      if (resolved !== CSS_ROOT && !resolved.startsWith(CSS_ROOT + path.sep)) {
        // T-10-07: path escapes css root → 403
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      serveFile(res, resolved);
      return;
    }

    // ── /doc?slug= (DB-backed project deep-dive, READER-02) ─────────────────
    // Returns the markdown body of the type='doc' node for the given slug.
    // If no doc exists, lazily spawns `recense generate-doc <slug>` and returns
    // 202 {status:'generating'} so the client can poll (D-02/D-03).
    // The server handle is READ-ONLY (T-27-11) — all writes happen inside the CLI.
    if (url === '/doc') {
      const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
      const rawId = params.get('id') ?? '';
      const rawSlug = params.get('slug') ?? '';
      // READER-04 doc-ref click: ?id=<docNodeId> resolves (exact-or-unique-prefix) to a
      // slug. An unknown/ambiguous id → 404 (a stale/bad doc-ref must NOT trigger a
      // generate-on-miss spawn — that path is slug-only). T-27-11 read-only preserved.
      if (rawId) {
        const resolvedSlug = resolveDocSlugById(rawId);
        if (!resolvedSlug) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no live doc for id' }));
          return;
        }
        try {
          const row = stmtGetDoc.get(resolvedSlug) as { id: string; value: string; generated_at: number } | undefined;
          // RGS-01 (parity with the slug branch): a force-regen in flight for this slug means
          // the old row is stale until the CLI finishes — report 202 so the reader polls and
          // shows the phase stepper instead of re-serving the stale doc.
          // BUG-2a fix (28-04): an empty-value stub (value='') means the CorpusPromoter
          // created an eager placeholder but generation hasn't run yet. Treat it as a miss
          // → spawn + 202 so the reader can poll for the real content.
          if (inFlightSlugs.has(resolvedSlug)) {
            send202Generating(res, resolvedSlug);
          } else if (row && row.value.trim().length > 0) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(row.value);
          } else if (row && row.value.trim().length === 0) {
            // Empty stub — spawn generation and return 202.
            spawnGenerateDoc(resolvedSlug);
            send202Generating(res, resolvedSlug);
          } else {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'no live doc for id' }));
          }
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error');
        }
        return;
      }
      // T-27-10: sanitize slug to [a-z0-9:-], length-cap. The colon is REQUIRED — subject docs
      // have slug 'scope:name'; stripping it (old [a-z0-9-]) regenerated a malformed colon-less
      // hub doc (duplicate). Colon is safe here: SQL lookups are parameterized and spawnGenerateDoc
      // uses a spawn args array (no shell), so ':' cannot enable injection.
      const slug = rawSlug.toLowerCase().replace(/[^a-z0-9:-]/g, '').slice(0, 64);
      if (!slug) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad slug');
        return;
      }
      try {
        const row = stmtGetDoc.get(slug) as { id: string; value: string; generated_at: number } | undefined;
        // RGS-01 regenerate fix: if a (re)generation is already in flight for this slug, the
        // OLD doc row still exists (the force-regen replaces it only when the CLI finishes).
        // Serving it with 200 here makes the reader's regenerate button flicker back to the
        // stale doc and never show the phase stepper. Report 202 so the reader polls instead.
        // BUG-2a fix (28-04): an empty-value stub (value='') must be treated as a miss so
        // the CorpusPromoter's eager-but-empty placeholder triggers lazy generation. A stub
        // with non-empty prose is served normally.
        if (!inFlightSlugs.has(slug) && row && row.value.trim().length > 0) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(row.value);
        } else {
          // No row, empty-stub row, OR regeneration in flight — spawn (self-guards against
          // a double-spawn while in flight) and return 202 so the client polls.
          spawnGenerateDoc(slug);
          send202Generating(res, slug);
        }
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── /doc/meta?slug= (cited fact ids, READER-02) ──────────────────────────
    // Returns {nodeId, generated_at, citedFactIds:[...]} for the graph-focus step.
    if (url === '/doc/meta') {
      const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
      const rawId = params.get('id') ?? '';
      // READER-04: ?id=<docNodeId> alternative — resolve (exact-or-unique-prefix) to a slug.
      let slug: string;
      if (rawId) {
        const resolvedSlug = resolveDocSlugById(rawId);
        if (!resolvedSlug) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no live doc for id' }));
          return;
        }
        slug = resolvedSlug;
      } else {
        const rawSlug = params.get('slug') ?? '';
        slug = rawSlug.toLowerCase().replace(/[^a-z0-9:-]/g, '').slice(0, 64);
        if (!slug) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad slug');
          return;
        }
      }
      try {
        const row = stmtGetDoc.get(slug) as { id: string; value: string; generated_at: number } | undefined;
        if (!row) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no doc for slug' }));
          return;
        }
        const cited = stmtCitedIds.all(row.id) as Array<{ factId: string }>;
        const citedFactIds = cited.map(r => r.factId);
        // Include the resolved slug so an id-addressed open (doc-ref click) can update
        // its title/state once meta resolves (READER-04).
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nodeId: row.id, slug, generated_at: row.generated_at, citedFactIds }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── /doc/staleness?slug= (citation staleness check, READER-03) ─────────────
    // Returns {generated_at, stale:[{factId,prev_value,value}], tombstoned:[factId,...]}
    // comparing each cited fact's last_access against node_doc.generated_at.
    // T-27-13: read-only SELECT only — never touches last_access of the cited facts.
    if (url === '/doc/staleness') {
      const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
      const rawId = params.get('id') ?? '';
      // READER-04: ?id=<docNodeId> alternative — resolve (exact-or-unique-prefix) to a slug.
      let slug: string;
      if (rawId) {
        const resolvedSlug = resolveDocSlugById(rawId);
        if (!resolvedSlug) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no live doc for id' }));
          return;
        }
        slug = resolvedSlug;
      } else {
        const rawSlug = params.get('slug') ?? '';
        slug = rawSlug.toLowerCase().replace(/[^a-z0-9:-]/g, '').slice(0, 64);
        if (!slug) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad slug');
          return;
        }
      }
      try {
        const docRow = stmtGetDoc.get(slug) as { id: string; value: string; generated_at: number } | undefined;
        if (!docRow) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no doc for slug' }));
          return;
        }
        const { generated_at } = docRow;
        // Fetch all cited facts and classify as stale (last_access > generated_at)
        // or tombstoned. Unchanged facts are excluded from the response.
        const citedRows = stmtCitedFacts.all(docRow.id) as Array<{
          factId: string;
          value: string;
          prev_value: string | null;
          prev_ts: number | null;
          last_access: number;
          tombstoned: number;
        }>;
        const stale: Array<{ factId: string; prev_value: string | null; value: string }> = [];
        const tombstoned: string[] = [];
        for (const row of citedRows) {
          if (row.tombstoned === 1) {
            tombstoned.push(row.factId);
          } else if (row.last_access > generated_at) {
            stale.push({ factId: row.factId, prev_value: row.prev_value, value: row.value });
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ generated_at, stale, tombstoned }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── GET /doc/backlinks?slug= | ?fact= (incoming references, WIKI-02, 39-01) ─────────
    // Doc view (?slug=): returns { backlinks: [{srcId, slug, label, kind}] } — the set
    // of live doc nodes that link HERE via wiki-meaningful edge kinds (doc_link,
    // doc_reference, doc_containment). Engine kinds (derived_from, abstracts) excluded (D-06).
    // Atom view (?fact=<factId>): returns { citedByDocs: [{srcId, slug, label}] } — docs
    // that cite the given fact via kind='cites'. Both paths are GET-only, read-only (WIKI-03).
    // T-39-01: slug sanitized; fact param validated to id charset; no new Database() (T-39-03).
    if (url === '/doc/backlinks') {
      // WR-02 (39 review): enforce the documented GET-only contract (mirrors /doc/generate's guard).
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
      const rawFact = params.get('fact') ?? '';

      // Atom/fact view — if ?fact= provided, return reverse-cites docs
      if (rawFact) {
        // Validate fact id to safe charset (hex + dashes, UUID-ish)
        const factId = rawFact.toLowerCase().replace(/[^a-f0-9-]/g, '').slice(0, 64);
        if (!factId) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad fact id');
          return;
        }
        try {
          const rows = stmtCitingDocs.all(factId) as Array<{ srcId: string; slug: string; label: string }>;
          const citedByDocs = rows.map(r => ({ srcId: r.srcId, slug: r.slug, label: r.label }));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ citedByDocs }));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error');
        }
        return;
      }

      // Doc view — resolve slug → doc row → incoming wiki edges
      const rawId = params.get('id') ?? '';
      let slug: string;
      if (rawId) {
        const resolvedSlug = resolveDocSlugById(rawId);
        if (!resolvedSlug) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no live doc for id' }));
          return;
        }
        slug = resolvedSlug;
      } else {
        const rawSlug = params.get('slug') ?? '';
        slug = rawSlug.toLowerCase().replace(/[^a-z0-9:-]/g, '').slice(0, 64);
        if (!slug) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad slug');
          return;
        }
      }
      try {
        const docRow = stmtGetDoc.get(slug) as { id: string; value: string; generated_at: number } | undefined;
        if (!docRow) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no doc for slug' }));
          return;
        }
        const rows = stmtDocBacklinks.all(docRow.id) as Array<{ srcId: string; slug: string; label: string; kind: string }>;
        const backlinks = rows.map(r => ({ srcId: r.srcId, slug: r.slug, label: r.label, kind: r.kind }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ backlinks }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── GET /index (live doc corpus index, WIKI-01, 39-02) ─────────────────────
    // Returns { projects: [{slug,label,id},...], schemas: [{slug,label,id},...] }.
    // Reuses the already-compiled stmtDocNodes (no new DB, no new prepare — T-39-07).
    // Grouping: a row is "schema-anchored" when its slug matches a UUID regex (D-03);
    // otherwise it is project-scoped. Labels come from the COALESCE column (D-04).
    // GET-only, read-only, no params, no write/LLM — live projection (D-01/D-02/WIKI-03).
    if (url === '/index') {
      // WR-02 (39 review): enforce the documented GET-only contract.
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      try {
        // UUID_RE + humanTitle() are hoisted above (near stmtDocNodes) and shared with
        // /graph?type=doc (GAP-8, 61-17) — this handler's behavior is unchanged.
        const rows = stmtDocNodes.all() as Array<{
          id: string; slug: string; label: string;
          type: string; value: string; s: number; c: number;
          origin: string; tombstoned: number;
        }>;
        // Containment hierarchy (WIKI-01, 39-02 re-verify): reuse stmtDocLinks (already compiled,
        // no new statement / no new Database — T-39-07) and keep only doc_containment edges.
        // doc_containment is directed source=parent → dst=child.
        const typeById = new Map<string, 'project' | 'schema'>();
        for (const r of rows) typeById.set(r.id, UUID_RE.test(r.slug) ? 'schema' : 'project');
        // A child may gain >1 containment parent once Phase 32 promoteScope adds project-landing →
        // chapter edges atop the organic schema ladder. Prefer the PROJECT parent so chapter docs
        // nest under their project (hybrid index — founder direction). Today there is no multi-parent.
        const parentsByChild = new Map<string, string[]>();
        for (const e of stmtDocLinks.all() as Array<{ src: string; dst: string; kind: string }>) {
          if (e.kind !== 'doc_containment') continue;
          if (!parentsByChild.has(e.dst)) parentsByChild.set(e.dst, []);
          parentsByChild.get(e.dst)!.push(e.src);
        }
        const childToParent = new Map<string, string>();
        for (const [child, parents] of parentsByChild) {
          if (parents.length === 0) continue; // never happens (only pushed entries), satisfies types
          const projParent = parents.find(p => typeById.get(p) === 'project');
          childToParent.set(child, projParent ?? parents[0]!);
        }
        // Walk to the tree root (cycle-guarded) → {root, depth-from-root}.
        const rootAndDepth = (id: string): { root: string; depth: number } => {
          let cur = id, depth = 0;
          const seen = new Set<string>([id]);
          while (childToParent.has(cur)) {
            const p = childToParent.get(cur)!;
            if (seen.has(p)) break;
            seen.add(p); cur = p; depth++;
          }
          return { root: cur, depth };
        };
        // GAP-4 (61-08): resolve each schema-rooted TREE's root to a project, read-only, so it
        // nests under that project instead of rendering as a free-floating peer. A root's
        // schemaId = its own doc slug (schema-anchored docs are slug=schemaId). Both the
        // schema→scope resolution AND a matching project doc must exist for nesting to apply;
        // otherwise the tree stays in `schemas` unchanged (fallback — no regression).
        const schemaToProject = resolveSchemaToProject();
        const projectDocIdBySlug = new Map<string, string>();
        for (const row of rows) {
          if (!UUID_RE.test(row.slug)) projectDocIdBySlug.set(row.slug, row.id);
        }
        const resolvedRootParent = new Map<string, string>(); // schema root doc id -> project doc id
        for (const row of rows) {
          if (typeById.get(row.id) !== 'schema') continue;
          if (childToParent.has(row.id)) continue; // only tree ROOTS resolve this way
          const scope = schemaToProject.get(row.slug);
          if (!scope) continue;
          const projectDocId = projectDocIdBySlug.get(scope);
          if (!projectDocId) continue;
          resolvedRootParent.set(row.id, projectDocId);
        }

        // Partition each doc into the section of ITS TREE ROOT's type (hybrid): a schema whose
        // root is a project lands in Projects (nested under it); schema-rooted trees stay in Schemas
        // UNLESS resolvedRootParent nests the root under a project (GAP-4).
        type Entry = { slug: string; label: string; id: string; parentId: string | null; depth: number };
        const projects: Entry[] = [];
        const schemas: Entry[] = [];
        for (const row of rows) {
          const { root, depth } = rootAndDepth(row.id);
          const resolvedParent = row.id === root ? resolvedRootParent.get(root) : undefined;
          const entry: Entry = {
            slug: row.slug, label: humanTitle(row), id: row.id,
            parentId: resolvedParent ?? childToParent.get(row.id) ?? null, depth,
          };
          const effectiveRootType = resolvedRootParent.has(root) ? 'project' : typeById.get(root);
          (effectiveRootType === 'project' ? projects : schemas).push(entry);
        }
        // Sort each group by label for stable ordering (index.js reorders into the tree).
        // WR-03 (39 review): null-safe comparator (matches client) — a NULL label can't 500 /index.
        const byLabel = (a: Entry, b: Entry) => (a.label || a.slug || '').localeCompare(b.label || b.slug || '');
        projects.sort(byLabel);
        schemas.sort(byLabel);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ projects, schemas }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── GET /settings, POST /settings (44-05, D-03) ───────────────────────────
    // GET: returns {preset, overrides, effective} from settings.json + loadMergedConfig.
    // POST: validates + whitelists override payload, writes settings.json, returns same shape.
    // Writes are filesystem-only (settings.json) — the DB handle stays read-only (T-44-18).
    // Both paths inherit the loopback-only Host guard above (T-44-16).
    if (url === '/settings') {
      if (req.method === 'GET') {
        try {
          const sf = loadSettingsFile(settingsPath) ??
            ({ preset: 'standard' as PresetName, overrides: {} } satisfies SettingsFile);
          const effective = loadMergedConfig(dbPath, process.env, settingsPath);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ preset: sf.preset, overrides: sf.overrides, effective }));
        } catch {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error');
        }
        return;
      }

      if (req.method === 'POST') {
        // Collect body chunks (req body is NOT yet read anywhere else in this handler).
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try {
              body = JSON.parse(rawBody);
            } catch {
              res.writeHead(400, { 'content-type': 'text/plain' });
              res.end('bad json');
              return;
            }
            if (typeof body !== 'object' || body === null) {
              res.writeHead(400, { 'content-type': 'text/plain' });
              res.end('bad json');
              return;
            }
            const patch = body as Record<string, unknown>;

            // Validate top-level preset if provided.
            let newPreset: PresetName | undefined;
            if ('preset' in patch) {
              const p = patch['preset'];
              if (p !== 'lite' && p !== 'standard' && p !== 'full') {
                res.writeHead(400, { 'content-type': 'text/plain' });
                res.end('invalid preset');
                return;
              }
              newPreset = p as PresetName;
            }

            // Validate overrides if provided — key whitelist (T-44-15).
            let newOverrides: SettingsFile['overrides'] | undefined;
            if ('overrides' in patch) {
              const ov = patch['overrides'];
              if (typeof ov !== 'object' || ov === null) {
                res.writeHead(400, { 'content-type': 'text/plain' });
                res.end('bad json');
                return;
              }
              const ovMap = ov as Record<string, unknown>;
              const validated: Record<string, unknown> = {};
              for (const [key, val] of Object.entries(ovMap)) {
                if (!SETTABLE_OVERRIDE_KEYS.has(key)) {
                  res.writeHead(400, { 'content-type': 'text/plain' });
                  res.end('unknown key');
                  return;
                }
                // Type coercion: boolean fields or number fields.
                if (BOOLEAN_OVERRIDE_KEYS.has(key)) {
                  if (typeof val !== 'boolean') {
                    res.writeHead(400, { 'content-type': 'text/plain' });
                    res.end('invalid type');
                    return;
                  }
                } else {
                  if (typeof val !== 'number') {
                    res.writeHead(400, { 'content-type': 'text/plain' });
                    res.end('invalid type');
                    return;
                  }
                }
                validated[key] = val;
              }
              newOverrides = validated as SettingsFile['overrides'];
            }

            // Apply onto current SettingsFile (preset-or-current). When the request
            // carries an overrides object it REPLACES the stored set (the client
            // sends the full desired overrides each save) — merging would make
            // override removal impossible: a key omitted because the user reverted
            // it to the preset default would silently keep its stale stored value
            // (one-way ratchet). Requests without an overrides key leave the
            // stored set untouched.
            const current = loadSettingsFile(settingsPath) ??
              ({ preset: 'standard' as PresetName, overrides: {} } satisfies SettingsFile);
            const updated: SettingsFile = {
              preset: newPreset ?? current.preset,
              overrides: newOverrides ?? current.overrides,
            };

            // Ensure ~/.config/recense/ exists before first write (D-04).
            const dir = path.dirname(settingsPath);
            fs.mkdirSync(dir, { recursive: true });
            writeSettingsFile(updated, settingsPath);

            // Return updated state — same shape as GET /settings.
            const effective = loadMergedConfig(dbPath, process.env, settingsPath);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ preset: updated.preset, overrides: updated.overrides, effective }));
          } catch {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('internal error');
          }
        });
        return;
      }

      // Non-GET/POST on /settings → 405 (method guard T-44-15).
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }

    // ── GET /usage (44-05, D-09/D-10) ────────────────────────────────────────
    // Returns rolling-30d + all-time token totals broken down by feature_tag.
    // Each feature_tag maps 1:1 to a cost-bearing toggle so the panel shows cost-per-lever.
    // Uses the read-only DB handle (T-44-18). Empty ledger → zeroed aggregates, not error.
    if (url === '/usage') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      try {
        type LedgerRow = {
          feature_tag: string;
          input_tokens: number;
          output_tokens: number;
          cache_write_tokens: number;
          cache_read_tokens: number;
          total_cost_usd: number;
        };
        const cutoff30d = Date.now() - 30 * 86_400_000;
        const rows30d = stmtUsage30d.all(cutoff30d) as LedgerRow[];
        const rowsAll = stmtUsageAllTime.all() as LedgerRow[];

        const summarise = (rows: LedgerRow[]) => {
          let totalTokens = 0;
          let totalCostUsd = 0;
          for (const r of rows) {
            totalTokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
            totalCostUsd += r.total_cost_usd ?? 0;
          }
          return { byFeature: rows, totalTokens, totalCostUsd };
        };

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          window_days: 30,
          rolling_30d: summarise(rows30d),
          all_time: summarise(rowsAll),
        }));
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── GET /stats/usage?window= (Phase 60, D-09/D-10/D-11/D-12) ─────────────
    // Windowed daily-bucketed (weekly for window=all) token burn, per-feature and
    // per-model totals, retail-$ equivalent, and live before/after avg-daily-burn
    // deltas for each COST_EVENTS marker (source-parsed from constants.js, D-11).
    // Uses the read-only DB handle (T-44-18). Empty ledger → zeroed aggregates, not error.
    if (url === '/stats/usage') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      try {
        type BucketRow = { date: string; tokens: number; cost_usd: number };

        const rawWindow = new URLSearchParams(req.url?.split('?')[1] ?? '').get('window');
        const ALLOWED_WINDOWS = new Set(['7d', '30d', '90d', 'all']);
        const window = rawWindow !== null && ALLOWED_WINDOWS.has(rawWindow) ? rawWindow : '30d';

        const now = Date.now();
        const cutoff =
          window === '7d' ? now - 7 * 86_400_000 :
          window === '90d' ? now - 90 * 86_400_000 :
          window === 'all' ? 0 :
          now - 30 * 86_400_000; // '30d' default

        const bucketGranularity: 'daily' | 'weekly' = window === 'all' ? 'weekly' : 'daily';
        let buckets = (
          bucketGranularity === 'weekly' ? stmtUsageWeeklyBuckets : stmtUsageDailyBuckets
        ).all(cutoff) as BucketRow[];

        // Zero-fill missing calendar days for daily windows (skipped when the
        // ledger is empty — the zeroed-aggregates contract returns []). Without
        // this, days with no ledger writes vanish: the client scales x by array
        // index (time distorts), and the cost-event before/after averages divide
        // by ACTIVE days only — biasing the delta against exactly the levers that
        // reduce usage to zero on most days. With the fill, averages divide by
        // calendar days. Weekly (window=all) is unfilled: cutoff=0 has no start.
        if (bucketGranularity === 'daily' && buckets.length > 0) {
          const byDate = new Map(buckets.map((b) => [b.date, b]));
          const filled: BucketRow[] = [];
          for (let t = cutoff; t <= now; t += 86_400_000) {
            const date = new Date(t).toISOString().slice(0, 10);
            filled.push(byDate.get(date) ?? { date, tokens: 0, cost_usd: 0 });
          }
          buckets = filled;
        }

        const byFeature = stmtUsage30d.all(cutoff);
        const byModel = stmtUsageByModel.all(cutoff);

        let retailUsd = 0;
        for (const b of buckets) retailUsd += b.cost_usd ?? 0;

        // T-60-01: window is validated against ALLOWED_WINDOWS above; cutoff is always
        // bound via '?' — no raw param ever reaches SQL text.
        const costEventDeltas = costEvents.map((marker) => {
          const before = buckets.filter((b) => b.date < marker.date);
          const after = buckets.filter((b) => b.date >= marker.date);
          const avg = (rows: BucketRow[]) =>
            rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0) / rows.length;
          return {
            date: marker.date,
            label: marker.label,
            before_avg: avg(before),
            after_avg: avg(after),
          };
        });

        // Phase 60-08 GAP-2a/2b: `summary` stat-tile + subscription-limit framing.
        // Fixed today/week/30d periods, computed UNCONDITIONALLY — independent of
        // the `window` pill above. All cutoffs are server-derived Date.now() ms
        // bound via '?' (T-60-08-01). Honest-labeling: these are ledger-derived
        // baselines ("vs your typical"), never a fabricated provider-quota number.
        const [todayY, todayM, todayD] = new Date().toISOString().slice(0, 10).split('-').map(Number) as [
          number, number, number,
        ];
        const todayCutoff = Date.UTC(todayY, todayM - 1, todayD); // Date.UTC month is 0-indexed
        const todayRow = stmtTokensSince.get(todayCutoff) as { tokens: number; cost: number };
        const weekRow = stmtTokensSince.get(now - 7 * 86_400_000) as { tokens: number; cost: number };
        const monthRow = stmtTokensSince.get(now - 30 * 86_400_000) as { tokens: number; cost: number };
        const prevWeekRow = stmtTokensBetween.get(now - 14 * 86_400_000, now - 7 * 86_400_000) as {
          tokens: number; cost: number;
        };
        const heaviestRow = stmtHeaviestDaySince.get(now - 7 * 86_400_000) as
          | { date: string; tokens: number }
          | undefined;

        const todayTokens = todayRow.tokens;
        const weekTokens = weekRow.tokens;
        const monthTokens = monthRow.tokens;
        const avgTokensPerDay = monthTokens / 30;
        const typicalDay = avgTokensPerDay;
        const typicalWeek = avgTokensPerDay * 7;
        const prevWeekTokens = prevWeekRow.tokens;

        const trendPct = prevWeekTokens > 0 ? ((weekTokens - prevWeekTokens) / prevWeekTokens) * 100 : null;
        const trendDirection: 'up' | 'down' | 'flat' =
          weekTokens > prevWeekTokens ? 'up' : weekTokens < prevWeekTokens ? 'down' : 'flat';

        const summary = {
          today_tokens: todayTokens,
          week_tokens: weekTokens,
          month_tokens: monthTokens,
          avg_tokens_per_day: avgTokensPerDay,
          retail_usd_30d: monthRow.cost,
          today_vs_typical_pct: typicalDay > 0 ? (todayTokens / typicalDay) * 100 : null,
          week_vs_typical_pct: typicalWeek > 0 ? (weekTokens / typicalWeek) * 100 : null,
          trend_pct: trendPct,
          trend_direction: trendDirection,
          heaviest_day: heaviestRow ? { date: heaviestRow.date, tokens: heaviestRow.tokens } : null,
        };

        // Phase 60-08 GAP-2c: `lever_deltas` — a STABLE, window-independent
        // per-lever before/after for the visible "levers" card. Unlike
        // cost_event_deltas above (windowed, feeds the burn-chart marker
        // hover), this spans the FULL ledger calendar range so the pill
        // can't distort it to 0/day garbage when it precedes both events.
        const allBuckets = stmtUsageDailyBucketsAll.all() as BucketRow[];
        let leverDeltas: Array<{
          date: string; label: string; before_avg: number; after_avg: number; pct_saved: number | null;
        }> = [];
        if (allBuckets.length > 0) {
          // Zero-fill the full calendar span (earliest ledger day → today) so
          // before/after averages divide by CALENDAR days, not just active
          // days — same rationale as the windowed zero-fill above.
          const minDate = allBuckets[0]!.date;
          const [minY, minM, minD] = minDate.split('-').map(Number) as [number, number, number];
          const minTs = Date.UTC(minY, minM - 1, minD); // Date.UTC month is 0-indexed
          const byDateAll = new Map(allBuckets.map((b) => [b.date, b]));
          const filledAll: BucketRow[] = [];
          for (let t = minTs; t <= now; t += 86_400_000) {
            const date = new Date(t).toISOString().slice(0, 10);
            filledAll.push(byDateAll.get(date) ?? { date, tokens: 0, cost_usd: 0 });
          }
          const avgAll = (rows: BucketRow[]) =>
            rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0) / rows.length;
          leverDeltas = costEvents.map((marker) => {
            const before = filledAll.filter((b) => b.date < marker.date);
            const after = filledAll.filter((b) => b.date >= marker.date);
            const beforeAvg = avgAll(before);
            const afterAvg = avgAll(after);
            return {
              date: marker.date,
              label: marker.label,
              before_avg: beforeAvg,
              after_avg: afterAvg,
              pct_saved: beforeAvg > 0 ? ((beforeAvg - afterAvg) / beforeAvg) * 100 : null,
            };
          });
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          window,
          bucket_granularity: bucketGranularity,
          buckets,
          by_feature: byFeature,
          by_model: byModel,
          retail_usd: retailUsd,
          cost_event_deltas: costEventDeltas,
          summary,
          lever_deltas: leverDeltas,
        }));
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── GET /stats/brain-health (Phase 60, D-13/D-14) ─────────────────────────
    // Six honest metric groups + a derived last-sleep-pass. Uses the read-only DB
    // handle (T-44-18). Empty DB → zeroed groups, not error.
    if (url === '/stats/brain-health') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      try {
        type DayCountRow = { date: string; count: number };

        const growthRows = stmtNodeGrowthDaily.all() as DayCountRow[];
        let cumulative = 0;
        const growthPoints = growthRows.map((r) => {
          cumulative += r.count;
          return { date: r.date, count: cumulative };
        });

        const kindRows = stmtKindMix.all() as Array<{ type: string; count: number }>;
        const kindMix: Record<string, number> = { entity: 0, fact: 0, schema: 0, doc: 0, insight: 0 };
        for (const r of kindRows) {
          if (r.type in kindMix) kindMix[r.type] = r.count;
        }

        const reconsolidationsPerDay = stmtReconsPerDay.all() as DayCountRow[];
        const tombstonesPerDay = stmtTombstonesPerDay.all() as DayCountRow[];

        // escalation_rate is null (unavailable) — the ledger cannot distinguish
        // escalated judge calls; see the stmtJudgeFires comment above.
        const judgeFires = (stmtJudgeFires.get() as { count: number }).count;
        const escalationRate: number | null = null;

        const episodeRows = stmtEpisodesByConsolidated.all() as Array<{ consolidated: number; count: number }>;
        let pending = 0;
        let consolidated = 0;
        for (const r of episodeRows) {
          if (r.consolidated === 0) pending = r.count;
          else consolidated = r.count;
        }

        // Derive last_sleep_pass (D-14, honest-labeling — never fabricate a success flag).
        const maxTsRow = stmtLastEventMaxTs.get() as { maxTs: number | null };
        let lastSleepPass: { ts: number | null; duration_ms: number | null; status: string };
        if (maxTsRow.maxTs == null) {
          lastSleepPass = { ts: null, duration_ms: null, status: 'none' };
        } else {
          const batch = stmtLastEventBatchSpan.get(maxTsRow.maxTs - BATCH_WINDOW_MS) as {
            minTs: number;
            maxTs: number;
          };
          lastSleepPass = { ts: maxTsRow.maxTs, duration_ms: batch.maxTs - batch.minTs, status: 'unknown' };
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          node_growth: { points: growthPoints, approximate: true },
          kind_mix: kindMix,
          reconsolidations_per_day: reconsolidationsPerDay,
          tombstones_per_day: tombstonesPerDay,
          judge_activity: { fires: judgeFires, escalation_rate: escalationRate },
          episodes: { pending, consolidated },
          last_sleep_pass: lastSleepPass,
        }));
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
      return;
    }

    // ── POST /doc/generate?slug= (force-spawn generate-doc CLI, READER-02) ───
    // Triggers doc generation/regeneration for the given slug. Returns 202 immediately.
    // Used by the reader's regenerate button (27-04) and explicit regen.
    if (url === '/doc/generate' && req.method === 'POST') {
      const rawSlug = new URLSearchParams(req.url?.split('?')[1] ?? '').get('slug') ?? '';
      const slug = rawSlug.toLowerCase().replace(/[^a-z0-9:-]/g, '').slice(0, 64);
      if (!slug) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad slug');
        return;
      }
      spawnGenerateDoc(slug, true);
      send202Generating(res, slug);
      return;
    }

    // ── Catch-all (IN-01) ────────────────────────────────────────────────────
    // We do NOT serve arbitrary top-level static files (only / , /index.html, and
    // /vendor/* are served). This remaining branch is the traversal-guarded 404:
    // resolve the path and 403 if it escapes VIZ_ROOT (T-10-07 — this is the live
    // guard for non-/vendor paths like /../package.json), otherwise 404.
    const candidate = path.resolve(VIZ_ROOT, url.slice(1));
    if (candidate !== VIZ_ROOT && !candidate.startsWith(VIZ_ROOT + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  // T-10-09: bind to 127.0.0.1 ONLY — loopback-only, never a wildcard.
  // No stdout here — the CLI launcher (brain-viz-cli) owns the user-facing URL
  // print (IN-02); a library start fn must not write to stdout (pollutes callers/tests).
  server.listen(port, '127.0.0.1');

  // Clean up on server close.
  server.on('close', () => {
    clearInterval(pollInterval);
    clearInterval(replayInterval);
    clearInterval(spontaneousInterval);
    db.close();
  });

  return server;
}
