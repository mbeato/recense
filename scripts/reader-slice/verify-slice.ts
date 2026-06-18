/**
 * Reader-slice headless verification.
 *  1. renderMarkdown(out/tonos.md) → fact-ref anchors with data-fact ids + headings.
 *  2. startVizServer serves /doc, /, /modules/reader.js.
 *  3. INTEGRATION: every cited fact id in the doc is present in the /graph payload,
 *     so ctx.idMap.get(id) resolves and the prose→atom click works.
 */
import { readFileSync } from 'node:fs';
import { startVizServer } from '../../src/viz/server';
// @ts-ignore - plain ESM browser module; renderMarkdown is pure (no DOM at import)
import { renderMarkdown } from '../../src/viz/modules/reader.js';

const DB = process.env.RECENSE_DB || '/Users/vtx/.config/recense/recense.db';
const PORT = 7788;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

async function main() {
  // 1. Renderer
  const md = readFileSync('scripts/reader-slice/out/tonos.md', 'utf8');
  const html = renderMarkdown(md);
  const anchors = [...html.matchAll(/data-fact="([0-9a-f-]{36})"/g)].map(m => m[1]);
  ok('renderMarkdown emits fact-ref anchors', anchors.length >= 15, `${anchors.length} anchors`);
  ok('renderMarkdown emits headings', /<h[12]>/.test(html));
  ok('renderMarkdown escapes html (no raw <script)', !/<script/i.test(html));

  // 2. Server routes
  const server = startVizServer(DB, PORT);
  await new Promise(r => setTimeout(r, 300));
  try {
    const docRes = await fetch(`${BASE}/doc?term=tonos`);
    const docText = await docRes.text();
    ok('/doc?term=tonos serves markdown', docRes.ok && docText.includes('recense://fact/'));
    ok('/doc rejects traversal', (await fetch(`${BASE}/doc?term=../server`)).status !== 200);

    const indexRes = await fetch(`${BASE}/`);
    const indexHtml = await indexRes.text();
    ok('/ serves index with reader button', indexRes.ok && indexHtml.includes('id="btn-reader"'));
    ok('/ serves index with reader panel', indexHtml.includes('id="reader"'));

    const modRes = await fetch(`${BASE}/modules/reader.js`);
    ok('/modules/reader.js serves', modRes.ok && (await modRes.text()).includes('initReader'));

    // 3. INTEGRATION — cited ids ∈ graph nodes
    const graph = (await (await fetch(`${BASE}/graph`)).json()) as { nodes: Array<{ id: string }> };
    const graphIds = new Set(graph.nodes.map(n => n.id));
    const citedIds = [...new Set([...md.matchAll(/recense:\/\/fact\/([0-9a-f-]{36})/g)].map(m => m[1]!))];
    const present = citedIds.filter(id => graphIds.has(id));
    ok(
      'every cited fact id resolves in /graph payload',
      present.length === citedIds.length,
      `${present.length}/${citedIds.length} resolve (graph has ${graphIds.size} nodes)`,
    );
    if (present.length !== citedIds.length) {
      console.log('  MISSING:', citedIds.filter(id => !graphIds.has(id)).join(', '));
    }
  } finally {
    server.close();
  }

  console.log(failures ? `\nFAIL — ${failures} check(s) failed` : '\nPASS — all checks green');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('verify failed:', err?.message || err);
  process.exit(1);
});
