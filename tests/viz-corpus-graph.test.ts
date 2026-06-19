/**
 * Tests for GET /graph?type=doc corpus endpoint (27-05 Task 2, READER-04).
 *
 * Coverage:
 *   - GET /graph?type=doc returns only doc nodes and only doc_link links
 *   - GET /graph?type=doc excludes fact/entity nodes and cites/relation links
 *   - GET /graph (no filter) still returns all nodes and all edges
 *   - GET /graph?type=doc with no doc nodes returns {nodes:[], links:[]}
 *   - Source assertions: type='doc' filter and kind='doc_link' filter present in server.ts
 *   - Source assertions: #btn-corpus in reader.js, index.html, styles.css (expanded-only gate)
 *
 * IMPORTANT: uses a TEMP throwaway DB; never touches ~/.config/recense/recense.db.
 * No live generation in tests — spawn is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { writeDoc } from '../src/consolidation/doc-writer';
import { startVizServer } from '../src/viz/server';

// ---------------------------------------------------------------------------
// Mock child_process.spawn so no real CLI is invoked
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `corpus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(port: number, urlPath: string): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeStore(db: Database.Database): SemanticStore {
  const clock = new FakeClock(1000);
  return new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
}

function seedFact(store: SemanticStore, id: string): void {
  store.upsertNode({
    id,
    type: 'fact',
    value: `Fact ${id} text`,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 500,
  });
}

function seedEntity(store: SemanticStore, id: string): void {
  store.upsertNode({
    id,
    type: 'entity',
    value: `Entity ${id}`,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 500,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /graph?type=doc corpus endpoint (READER-04)', () => {
  let dbPath: string;
  let db: Database.Database;
  let store: SemanticStore;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    store = makeStore(db);

    // Seed two fact nodes (for cites edges and general graph population)
    seedFact(store, 'fact-a');
    seedFact(store, 'fact-b');
    seedEntity(store, 'entity-z');

    // Write two doc nodes with a doc_link edge between them
    writeDoc(store, db, {
      docId: 'doc-one',
      slug: 'one',
      markdown: '# Doc One',
      citedFactIds: ['fact-a'],
      linkedDocRefs: ['doc-two'],  // will be skipped since doc-two doesn't exist yet
      now: 1000,
    });
    writeDoc(store, db, {
      docId: 'doc-two',
      slug: 'two',
      markdown: '# Doc Two',
      citedFactIds: ['fact-b'],
      linkedDocRefs: [],
      now: 2000,
    });
    // Manually create a doc_link edge from doc-one to doc-two (since doc-two didn't exist
    // when doc-one was written above — using store to stay single-writer-compliant)
    store.upsertEdge({
      src: 'doc-one',
      dst: 'doc-two',
      rel: 'doc_link',
      kind: 'doc_link',
      w: 1.0,
      last_access: 3000,
    });

    // Also create a relation edge between fact nodes for full-graph verification
    store.upsertEdge({
      src: 'fact-a',
      dst: 'fact-b',
      rel: 'related',
      kind: 'relation',
      w: 0.5,
      last_access: 1000,
    });

    // Close the write DB before the server opens it read-only
    db.close();

    port = await getFreePort();
    server = startVizServer(dbPath, port);
    await new Promise<void>(r => server.once('listening', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('GET /graph?type=doc returns only doc nodes', async () => {
    const res = await makeRequest(port, '/graph?type=doc');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { nodes: Array<{ id: string; type: string }>; links: unknown[] };
    const nodeIds = data.nodes.map(n => n.id);
    expect(nodeIds).toContain('doc-one');
    expect(nodeIds).toContain('doc-two');
    // Must NOT contain fact or entity nodes
    expect(nodeIds).not.toContain('fact-a');
    expect(nodeIds).not.toContain('fact-b');
    expect(nodeIds).not.toContain('entity-z');
    // All returned nodes are type='doc'
    for (const n of data.nodes) {
      expect(n.type).toBe('doc');
    }
  });

  it('GET /graph?type=doc returns only doc_link edges', async () => {
    const res = await makeRequest(port, '/graph?type=doc');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      nodes: unknown[];
      links: Array<{ source: string; target: string; kind: string }>;
    };
    // All returned links must be kind='doc_link'
    for (const l of data.links) {
      expect(l.kind).toBe('doc_link');
    }
    // The doc-one → doc-two link must appear
    const link = data.links.find(l => l.source === 'doc-one' && l.target === 'doc-two');
    expect(link).toBeDefined();
    // cites edges and relation edges must NOT appear
    const nonDocLinks = data.links.filter(l => l.kind !== 'doc_link');
    expect(nonDocLinks).toHaveLength(0);
  });

  it('GET /graph (no filter) still returns all nodes including facts', async () => {
    const res = await makeRequest(port, '/graph');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { nodes: Array<{ id: string }>; links: unknown[] };
    const nodeIds = data.nodes.map(n => n.id);
    // Full graph includes both doc nodes AND fact/entity nodes
    expect(nodeIds).toContain('doc-one');
    expect(nodeIds).toContain('fact-a');
    expect(nodeIds).toContain('entity-z');
  });

  it('GET /graph (no filter) still returns all edge kinds including cites', async () => {
    const res = await makeRequest(port, '/graph');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      nodes: unknown[];
      links: Array<{ kind: string }>;
    };
    const kinds = new Set(data.links.map(l => l.kind));
    // Full graph has both 'cites' and 'doc_link' edges
    expect(kinds.has('cites')).toBe(true);
    expect(kinds.has('doc_link')).toBe(true);
    expect(kinds.has('relation')).toBe(true);
  });

  it('GET /graph?type=doc with no doc nodes returns empty nodes and links', async () => {
    // Create a fresh DB with only fact nodes
    const emptyDbPath = makeTempDbPath();
    let emptyDb = new Database(emptyDbPath);
    emptyDb.pragma('foreign_keys = ON');
    initSchema(emptyDb);
    const emptyStore = makeStore(emptyDb);
    seedFact(emptyStore, 'fact-only');
    emptyDb.close();

    const emptyPort = await getFreePort();
    const emptyServer = startVizServer(emptyDbPath, emptyPort);
    await new Promise<void>(r => emptyServer.once('listening', r));

    try {
      const res = await makeRequest(emptyPort, '/graph?type=doc');
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body) as { nodes: unknown[]; links: unknown[] };
      expect(data.nodes).toHaveLength(0);
      expect(data.links).toHaveLength(0);
    } finally {
      await new Promise<void>(r => emptyServer.close(() => r()));
      try { fs.unlinkSync(emptyDbPath); } catch { /* ignore */ }
    }
  });

  // Source assertions

  it('source: server.ts has type=doc filter for corpus endpoint', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toMatch(/type\s*=\s*'doc'/);
    expect(src).toContain('type=doc');
  });

  it('source: server.ts has kind filter for corpus endpoint (doc_link, doc_containment, doc_reference)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    // CORPUS-04: stmtDocLinks now selects all three doc-edge kinds via IN (...)
    expect(src).toContain("'doc_link'");
    expect(src).toContain("'doc_containment'");
    expect(src).toContain("'doc_reference'");
  });

  it('source: corpus.js owns #btn-corpus + 2D force-graph + /graph?type=doc fetch', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/corpus.js'),
      'utf8',
    );
    // Corpus toggle button is owned here (moved out of reader.js)
    expect(src).toContain('btn-corpus');
    // Fetches the corpus data from the doc-only endpoint
    expect(src).toContain('/graph?type=doc');
    // Uses the vendored 2D force-graph library (NOT the 3D brain instance)
    expect(src).toContain('window.ForceGraph');
    // Has its own separate container (does NOT swap the 3D brain's #graph)
    expect(src).toContain('corpus-graph');
  });

  it('source: corpus.js does NOT swap data into the 3D brain (no ctx.Graph.graphData swap)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/corpus.js'),
      'utf8',
    );
    // The flat-graph approach uses its own ForceGraph() instance, never the brain's.
    // Guard against a regression to the 3D-data-swap approach.
    expect(src).not.toContain('ctx.Graph.graphData');
  });

  // Fix A — corpus zoom clamp
  it('source: corpus.js clamps zoom (MAX_ZOOM) after fit + fits on onEngineStop', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/corpus.js'),
      'utf8',
    );
    // A max-zoom ceiling exists so a tiny graph does not blow up
    expect(src).toContain('MAX_ZOOM');
    // Clamp applied via .zoom(k, ms)
    expect(src).toMatch(/\.zoom\(/);
    // Fit fires on layout settle, not only a fixed timeout
    expect(src).toContain('onEngineStop');
    // zoomToFit still used as the fit primitive
    expect(src).toContain('zoomToFit');
  });

  // Fix B — corpus doc-node click opens the reader IN PLACE (no page navigation)
  it('source: corpus.js onNodeClick calls ctx.openReader (NOT window.location)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/corpus.js'),
      'utf8',
    );
    // Opens the reader in-place via the ctx opener with from:'corpus'
    expect(src).toContain('ctx.openReader');
    expect(src).toContain("from: 'corpus'");
    // Must NOT navigate the page (the brain-detour bug)
    expect(src).not.toContain('window.location');
  });

  it('source: corpus.js registers ctx.returnToCorpus + ctx.showBrainFromCorpus hooks', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/corpus.js'),
      'utf8',
    );
    expect(src).toContain('ctx.returnToCorpus');
    expect(src).toContain('ctx.showBrainFromCorpus');
  });

  it('source: reader.js exports an in-place ctx.openReader honoring from:corpus', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/reader.js'),
      'utf8',
    );
    // In-place opener registered on ctx
    expect(src).toContain('ctx.openReader');
    // Close path returns to corpus when opened from corpus
    expect(src).toContain('ctx.returnToCorpus');
    // Provenance guard exists ('brain' vs 'corpus')
    expect(src).toContain("openFrom === 'corpus'");
    expect(src).toContain("openFrom === 'brain'");
    // openReader does NOT navigate the page
    expect(src).not.toContain('window.location.href');
  });

  it('source: reader.js no longer owns the corpus swap (moved to corpus.js)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/reader.js'),
      'utf8',
    );
    // The corpus logic was extracted to corpus.js; reader.js should not reference
    // btn-corpus or swapToCorpus anymore.
    expect(src).not.toContain('swapToCorpus');
    expect(src).not.toContain("getElementById('btn-corpus')");
  });

  it('source: app.js injects the vendored force-graph bundle and inits corpus', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/app.js'),
      'utf8',
    );
    expect(src).toContain('./vendor/force-graph.min.js');
    expect(src).toContain('initCorpus');
  });

  it('source: index.html has #btn-corpus button and #corpus-graph container', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/index.html'),
      'utf8',
    );
    expect(src).toContain('btn-corpus');
    expect(src).toContain('corpus-graph');
  });

  it('source: styles.css has expanded-only gate for #btn-corpus + corpus container', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/css/styles.css'),
      'utf8',
    );
    expect(src).toContain('#btn-corpus');
    expect(src).toContain('.mode-window #btn-corpus');
    expect(src).toContain('#corpus-graph');
  });

  it('vendored force-graph.min.js exists and is a non-empty UMD bundle exposing ForceGraph', () => {
    const fp = path.resolve(__dirname, '../src/viz/vendor/force-graph.min.js');
    expect(fs.existsSync(fp)).toBe(true);
    const content = fs.readFileSync(fp, 'utf8');
    // Non-empty
    expect(content.length).toBeGreaterThan(10000);
    // UMD bundle exposing the ForceGraph global
    expect(content).toContain('ForceGraph');
  });
});

// ---------------------------------------------------------------------------
// CORPUS-04: doc_containment / doc_reference edges — endpoint + renderer
// ---------------------------------------------------------------------------
//
// Plan 28-04: server.ts stmtDocLinks now returns all three kinds; corpus.js
// styles them by link.kind (containment solid/directed, reference faint/dashed).

describe('doc_containment/doc_reference edges in corpus endpoint and renderer (CORPUS-04)', () => {
  let dbPath: string;
  let db: Database.Database;
  let store: SemanticStore;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    store = makeStore(db);

    // Three doc nodes: parent, child (containment from parent), sibling (reference to parent)
    writeDoc(store, db, {
      docId: 'doc-parent',
      slug: 'parent',
      markdown: '# Parent Schema',
      citedFactIds: [],
      linkedDocRefs: [],
      now: 1000,
    });
    writeDoc(store, db, {
      docId: 'doc-child',
      slug: 'child',
      markdown: '# Child Schema',
      citedFactIds: [],
      linkedDocRefs: [],
      now: 1100,
    });
    writeDoc(store, db, {
      docId: 'doc-sibling',
      slug: 'sibling',
      markdown: '# Sibling Schema',
      citedFactIds: [],
      linkedDocRefs: [],
      now: 1200,
    });

    // A tombstoned doc — edges to/from it must be excluded from the payload.
    writeDoc(store, db, {
      docId: 'doc-dead',
      slug: 'dead',
      markdown: '# Dead',
      citedFactIds: [],
      linkedDocRefs: [],
      now: 1300,
    });
    // Tombstone it directly via the node table.
    db.prepare("UPDATE node SET tombstoned=1 WHERE id='doc-dead'").run();

    // doc_containment: parent → child (directed spine)
    store.upsertEdge({
      src: 'doc-parent',
      dst: 'doc-child',
      rel: 'doc_containment',
      kind: 'doc_containment',
      w: 1.0,
      last_access: 2000,
    });

    // doc_reference: sibling ↔ parent (undirected cross-link, modelled as src→dst)
    store.upsertEdge({
      src: 'doc-sibling',
      dst: 'doc-parent',
      rel: 'doc_reference',
      kind: 'doc_reference',
      w: 0.7,
      last_access: 2100,
    });

    // doc_link: child → sibling (classic cross-project link)
    store.upsertEdge({
      src: 'doc-child',
      dst: 'doc-sibling',
      rel: 'doc_link',
      kind: 'doc_link',
      w: 1.0,
      last_access: 2200,
    });

    // Edge from live doc to tombstoned doc — must be EXCLUDED (T-28-DANGLE).
    store.upsertEdge({
      src: 'doc-parent',
      dst: 'doc-dead',
      rel: 'doc_containment',
      kind: 'doc_containment',
      w: 0.9,
      last_access: 2300,
    });

    // Non-doc edges (cites, relation) — must never appear in the corpus payload.
    seedFact(store, 'fact-x');
    store.upsertEdge({
      src: 'doc-parent',
      dst: 'fact-x',
      rel: 'cites',
      kind: 'cites',
      w: 1.0,
      last_access: 2400,
    });

    db.close();

    port = await getFreePort();
    server = startVizServer(dbPath, port);
    await new Promise<void>(r => server.once('listening', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it(
    'GET /graph?type=doc returns doc_containment edges alongside doc_link edges ' +
    'when CorpusPromoter has written doc_containment rows between doc nodes',
    async () => {
      const res = await makeRequest(port, '/graph?type=doc');
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body) as {
        nodes: unknown[];
        links: Array<{ source: string; target: string; kind: string }>;
      };
      const containment = data.links.filter(l => l.kind === 'doc_containment');
      expect(containment.length).toBeGreaterThan(0);
      // The parent → child link must be present
      const spine = containment.find(l => l.source === 'doc-parent' && l.target === 'doc-child');
      expect(spine).toBeDefined();
    },
  );

  it(
    'GET /graph?type=doc returns doc_reference edges alongside doc_link edges ' +
    'when CorpusPromoter has written doc_reference rows between doc nodes',
    async () => {
      const res = await makeRequest(port, '/graph?type=doc');
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body) as {
        nodes: unknown[];
        links: Array<{ source: string; target: string; kind: string }>;
      };
      const refs = data.links.filter(l => l.kind === 'doc_reference');
      expect(refs.length).toBeGreaterThan(0);
      const crossLink = refs.find(l => l.source === 'doc-sibling' && l.target === 'doc-parent');
      expect(crossLink).toBeDefined();
    },
  );

  it(
    'GET /graph?type=doc only returns edges where both src and dst are live doc nodes ' +
    '(no cites/relation/abstracts edges leak through)',
    async () => {
      const res = await makeRequest(port, '/graph?type=doc');
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body) as {
        nodes: unknown[];
        links: Array<{ source: string; target: string; kind: string }>;
      };
      // No cites or relation edges
      for (const l of data.links) {
        expect(['doc_link', 'doc_containment', 'doc_reference']).toContain(l.kind);
      }
      // Edge to tombstoned doc must be excluded (T-28-DANGLE)
      const dangling = data.links.filter(l => l.target === 'doc-dead' || l.source === 'doc-dead');
      expect(dangling).toHaveLength(0);
    },
  );

  it(
    'source: server.ts stmtDocLinks fetches kind IN (doc_link, doc_containment, doc_reference) ' +
    'with src/dst doc-node filter',
    () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../src/viz/server.ts'),
        'utf8',
      );
      // The three kinds must all appear in the stmtDocLinks block
      expect(src).toContain('doc_containment');
      expect(src).toContain('doc_reference');
      expect(src).toContain('doc_link');
      // Both-endpoints-live guard
      expect(src).toMatch(/tombstoned\s*=\s*0/);
    },
  );

  it(
    'source: corpus.js linkDirectionalArrowLength is non-zero for doc_containment links ' +
    'and zero for doc_reference links (directed vs undirected rendering)',
    () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../src/viz/modules/corpus.js'),
        'utf8',
      );
      expect(src).toContain('linkDirectionalArrowLength');
      // containment gets a non-zero arrow; reference gets 0 (undirected)
      expect(src).toMatch(/doc_containment.*?4|4.*?doc_containment/s);
    },
  );

  it(
    'source: corpus.js linkLineDash returns [2,2] for doc_reference links ' +
    'and null for doc_containment links (solid vs dashed)',
    () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../src/viz/modules/corpus.js'),
        'utf8',
      );
      expect(src).toContain('linkLineDash');
      // reference gets a dash pattern; containment gets null (solid)
      expect(src).toMatch(/doc_reference/);
      expect(src).toMatch(/\[2,\s*2\]/);
    },
  );

  it(
    'source: corpus.js linkColor distinguishes doc_containment from doc_reference ' +
    '(distinct color constants in corpus.js)',
    () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../src/viz/modules/corpus.js'),
        'utf8',
      );
      // A dedicated containment color constant must exist
      expect(src).toContain('CONTAINMENT_COLOR');
      // It must be referenced in a linkColor callback
      expect(src).toMatch(/linkColor/);
      // CONTAINMENT_COLOR and LINK_REST must NOT be amber (#ffb866/ff8c00) or cyan (#00bfff)
      // (amber is activation-only HOVER_NODE; the palette rule is founder-locked).
      // Check the constant definitions directly (not comments, which may mention the word).
      expect(src).not.toMatch(/const CONTAINMENT_COLOR\s*=\s*['"][^'"]*(?:ff8c00|ffb866|00bfff)[^'"]*['"]/i);
      expect(src).not.toMatch(/const LINK_REST\s*=\s*['"][^'"]*(?:ff8c00|ffb866|00bfff)[^'"]*['"]/i);
    },
  );
});

// BUG-1 (28-04): corpus node label resolution. A schema-anchored doc has slug = schemaId
// (a UUID) and an empty stub value; the node MUST render the human schema label, not the UUID.
// The endpoint resolves COALESCE(NULLIF(schema.value,''), slug). Project-scope docs fall back.
describe('GET /graph?type=doc resolves human schema label (CORPUS-04 BUG-1)', () => {
  let dbPath: string;
  let db: Database.Database;
  let store: SemanticStore;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    store = makeStore(db);

    // A live schema node whose id is used as a doc slug (schema-anchored doc).
    store.upsertNode({ id: 'schema-bm', type: 'schema', value: 'Brain Memory', origin: 'observed', s: 0.3, c: 0.6, last_access: 400 });
    // Schema-anchored doc: slug = schema id → label should resolve to 'Brain Memory'.
    writeDoc(store, db, { docId: 'doc-bm', slug: 'schema-bm', markdown: '# stub', citedFactIds: [], linkedDocRefs: [], now: 1000 });
    // Project-scope doc: slug 'tonos' matches no schema → label falls back to slug.
    writeDoc(store, db, { docId: 'doc-tonos', slug: 'tonos', markdown: '# Tonos', citedFactIds: [], linkedDocRefs: [], now: 1100 });

    db.close();
    port = await getFreePort();
    server = startVizServer(dbPath, port);
    await new Promise<void>(r => server.once('listening', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('schema-anchored doc node carries label = schema.value (not the UUID slug)', async () => {
    const res = await makeRequest(port, '/graph?type=doc');
    const nodes = JSON.parse(res.body).nodes as Array<{ id: string; slug: string; label: string }>;
    const bm = nodes.find(n => n.id === 'doc-bm');
    expect(bm).toBeDefined();
    expect(bm!.slug).toBe('schema-bm');     // slug preserved for click→reader resolution
    expect(bm!.label).toBe('Brain Memory'); // label resolved from the schema node
  });

  it('project-scope doc node label falls back to the slug', async () => {
    const res = await makeRequest(port, '/graph?type=doc');
    const nodes = JSON.parse(res.body).nodes as Array<{ id: string; slug: string; label: string }>;
    const tonos = nodes.find(n => n.id === 'doc-tonos');
    expect(tonos).toBeDefined();
    expect(tonos!.label).toBe('tonos');
  });
});

