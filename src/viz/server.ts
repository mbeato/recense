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
import type { PresetName, SettingsFile } from '../lib/config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_MS = 250;  // polling interval for activation_trace SSE broadcast
const SEARCH_LIMIT = 20;  // BM25 result cap for /search?q= endpoint (T-19-03)

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
}

// ---------------------------------------------------------------------------
// Path-traversal-safe static file serving
// ---------------------------------------------------------------------------

/** Allowed root directories for static serving (src/viz/ and subdirectories). */
const VIZ_ROOT = path.resolve(__dirname);
const VENDOR_ROOT = path.resolve(VIZ_ROOT, 'vendor');
const MODULES_ROOT = path.resolve(VIZ_ROOT, 'modules');
const CSS_ROOT = path.resolve(VIZ_ROOT, 'css');

// T-27-10: track in-flight slug generations to prevent duplicate concurrent spawns.
// Key = slug, Value = Date.now() when the generate-doc CLI was first spawned for it.
// Storing the start time (not just a boolean) lets the 202 payload report the REAL
// elapsed generation time, so a reader reopened mid-generation resumes its progress bar
// from where the backend actually is instead of restarting at 0s (the detached child
// keeps running across reader close/reopen; only the UI used to forget).
const inFlightSlugs = new Map<string, number>();

/**
 * Serve a file from the filesystem with:
 *   - MIME type enforcement (.html → text/html, .js/.mjs → text/javascript, else text/plain)
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
  // CORPUS-04: Return doc_link + doc_containment + doc_reference edges, but only between
  // live (tombstoned=0) doc nodes on both ends. Dangling edges whose src or dst has been
  // tombstoned or is not a doc node are excluded (T-28-DANGLE guard).
  const stmtDocLinks = db.prepare(
    "SELECT src, dst, rel, w, kind FROM edge" +
    " WHERE kind IN ('doc_link','doc_containment','doc_reference')" +
    " AND src IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)" +
    " AND dst IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)"
  );

  // Compile /doc?slug= prepared statements once (READER-02, T-27-11 — read-only only).
  // Returns the live doc node for the given scope (slug); tombstoned docs are excluded.
  const stmtGetDoc = db.prepare(`
    SELECT n.id, n.value, nd.generated_at
    FROM node n
    JOIN node_doc nd ON nd.node_id = n.id
    JOIN node_scope ns ON ns.node_id = n.id
    WHERE n.type = 'doc' AND ns.scope = ? AND n.tombstoned = 0
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

  // Compile /events polling statement once.
  const stmtTrace = db.prepare(
    'SELECT id, ts, query_id, seeds, hops FROM activation_trace WHERE id > ? ORDER BY id ASC'
  );

  // Active SSE response objects (T-10-11: removed on req 'close').
  const clients = new Set<http.ServerResponse>();

  // Highest activation_trace.id already broadcast (monotonically increasing AUTOINCREMENT).
  // WR-01: seed the cursor at the current max id so retained historical rows (the
  // table is a persistent ring buffer) are NOT replayed as "live" on first connect —
  // only genuinely new traces stream.
  let cursor = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activation_trace').get() as { m: number }).m;

  // D-98: poll activation_trace every POLL_MS ms and push new rows to all SSE clients.
  const pollInterval = setInterval(() => {
    if (clients.size === 0) return;
    const fresh = stmtTrace.all(cursor) as Array<{
      id: number; ts: number; query_id: string; seeds: string; hops: string;
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
      const payload = `event: trace\ndata: ${JSON.stringify({
        id: row.id,
        ts: row.ts,
        query_id: row.query_id,
        seeds,
        hops,
      })}\n\n`;
      for (const res of clients) {
        res.write(payload);
      }
    }
  }, POLL_MS);

  // Prevent the interval from keeping the process alive after server.close().
  pollInterval.unref();

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
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'generating', elapsedMs }));
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
        if (qType === 'doc') {
          // Corpus graph: only live doc nodes + doc_link edges (READER-04 / T-27-16).
          nodes = stmtDocNodes.all() as NodeRecord[];
          edgeRows = stmtDocLinks.all() as Array<{ src: string; dst: string; rel: string; w: number; kind: string }>;
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
        const payload: GraphPayload = { nodes, links };
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
          // BUG-2a fix (28-04): an empty-value stub (value='') means the CorpusPromoter
          // created an eager placeholder but generation hasn't run yet. Treat it as a miss
          // → spawn + 202 so the reader can poll for the real content.
          if (row && row.value.trim().length > 0) {
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
        // BUG-2a fix (28-04): an empty-value stub (value='') must be treated as a miss so
        // the CorpusPromoter's eager-but-empty placeholder triggers lazy generation. A stub
        // with non-empty prose is served normally.
        if (row && row.value.trim().length > 0) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(row.value);
        } else {
          // No row OR empty-stub row — spawn CLI and return 202.
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
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
        // Partition each doc into the section of ITS TREE ROOT's type (hybrid): a schema whose
        // root is a project lands in Projects (nested under it); schema-rooted trees stay in Schemas.
        type Entry = { slug: string; label: string; id: string; parentId: string | null; depth: number };
        const projects: Entry[] = [];
        const schemas: Entry[] = [];
        for (const row of rows) {
          const { root, depth } = rootAndDepth(row.id);
          const entry: Entry = {
            slug: row.slug, label: row.label, id: row.id,
            parentId: childToParent.get(row.id) ?? null, depth,
          };
          (typeById.get(root) === 'project' ? projects : schemas).push(entry);
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

            // Merge onto current SettingsFile (preset-or-current, overrides merged in).
            const current = loadSettingsFile(settingsPath) ??
              ({ preset: 'standard' as PresetName, overrides: {} } satisfies SettingsFile);
            const updated: SettingsFile = {
              preset: newPreset ?? current.preset,
              overrides: newOverrides !== undefined
                ? { ...current.overrides, ...newOverrides }
                : current.overrides,
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
    db.close();
  });

  return server;
}
