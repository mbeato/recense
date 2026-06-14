/**
 * viz server — local read-only HTTP/SSE server for brain-activation visualization (VIZ-03).
 *
 * Endpoints:
 *   GET /          → src/viz/index.html (Plan 04; 503 if absent)
 *   GET /index.html → same
 *   GET /vendor/*  → src/viz/vendor/<file> (path-traversal-safe, MIME-guarded)
 *   GET /graph     → { nodes, links } JSON from read-only DB handle
 *   GET /search?q= → BM25-ranked node IDs (string[]), LLM-free, tombstone-filtered (VIZ-07)
 *   GET /events    → SSE stream: polls activation_trace every 250ms past a cursor
 *
 * Security invariants (threat model T-10-07/08/09/10/11):
 *   T-10-07: path-traversal guard — resolves absolute path and asserts it stays
 *            inside __dirname (src/viz/) or vendor subdirectory; 403 on escape.
 *   T-10-08: DB opened { readonly: true } — no writes possible from this process.
 *   T-10-09: listens on 127.0.0.1 ONLY — loopback-only, never a wildcard.
 *   T-10-10: all assets vendored under src/viz/vendor — no CDN/fetch to external domains.
 *   T-10-11: SSE clients Set removes res on req 'close'; poll only reads rows past cursor.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { ftsQueryFromText } from '../retrieval/topk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_MS = 250;  // polling interval for activation_trace SSE broadcast
const SEARCH_LIMIT = 20;  // BM25 result cap for /search?q= endpoint (T-19-03)

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
 * @param dbPath - Absolute path to brain.db; opened read-only (D-95, T-10-08).
 * @param port   - TCP port to listen on (bound to 127.0.0.1 only, T-10-09).
 * @returns The http.Server instance (call .close() to stop).
 */
export function startVizServer(dbPath: string, port: number): http.Server {
  // D-95: open our OWN read-only handle — never share a write-enabled instance.
  const db = new Database(dbPath, { readonly: true });

  // Compile /graph prepared statements once (T-01-SQL pattern).
  const stmtNodes = db.prepare(
    'SELECT id, type, value, s, c, origin, tombstoned FROM node'
  );
  const stmtEdges = db.prepare(
    'SELECT src, dst, rel, w, kind FROM edge'
  );

  // Compile /search BM25 prepared statement once (T-19-01 — query passes through
  // ftsQueryFromText before reaching MATCH; JOIN ON tombstoned=0 excludes deleted nodes;
  // ORDER BY rank ascending = best BM25 first; LIMIT caps the result set, T-19-03).
  const stmtSearch = db.prepare(`
    SELECT f.node_id AS id
    FROM node_fts f JOIN node n ON n.id = f.node_id AND n.tombstoned = 0
    WHERE node_fts MATCH ?
    ORDER BY rank LIMIT ?
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
    if (url === '/graph') {
      try {
        const nodes = stmtNodes.all() as NodeRecord[];
        const edgeRows = stmtEdges.all() as Array<{
          src: string; dst: string; rel: string; w: number; kind: string;
        }>;
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
          '<p>brain viz — frontend not yet built. Run plan 04 to generate index.html.</p>' +
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
