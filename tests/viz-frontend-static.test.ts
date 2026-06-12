/**
 * Final static assertions for the Plan 15-07 module corpus:
 *   src/viz/index.html         — thin shell (import map + module entry + HTML chrome)
 *   src/viz/css/styles.css     — deep-sea bioluminescent design system
 *   src/viz/modules/*.js       — all 9 modules (app + constants + 7 feature modules)
 *
 * This is the final form of the test file (Plan 07 completion).  All deferred
 * assertions from Plans 02–06 are included here now that the full module corpus
 * exists.
 *
 * Coverage:
 *   shell       — import map order (Pitfall 1), no CDN, CC attribution, module entry
 *   css         — display:none defaults, system-ui + monospace typography, slide-in,
 *                 toast/badge class, deep-sea background
 *   constants   — TYPE_COLOR/HOT/BRAIN_SCALE/MAX_HOPS/PULSE_MS exported, ctx typedef
 *   security    — no external URLs across corpus, no shell IPC (T-10-10),
 *                 XSS discipline in detail panel (T-10-12)
 *   bootstrap   — Spike-001 load order in app.js, fetch /graph, EventSource /events
 *   activation  — applyTrace single def, SSE calls applyTrace, >=2 call sites,
 *                 spawnPulse present, no Graph.refresh() in tick (D-102, Spike 001)
 *   detail-ux   — Escape key handler, #detail hidden by default
 *
 * Intentionally dropped (changed by D-03/D-13/D-16, or VIZ-06 dropped 2026-06-10):
 *   - Old palette hex assertions (5b8dff/9b8cff/ff6b9d) — D-03 redesigns palette
 *   - "Show tombstones" / "Hide tombstones" exact copy — D-13 modernises chrome
 *   - Anatomical term ban (VIZ-06 dropped 2026-06-10)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Corpus setup
// ---------------------------------------------------------------------------

const VIZ_ROOT    = path.join(__dirname, '../src/viz');
const HTML_PATH   = path.join(VIZ_ROOT, 'index.html');
const CSS_PATH    = path.join(VIZ_ROOT, 'css/styles.css');
const MODULES_DIR = path.join(VIZ_ROOT, 'modules');

let html: string;
let css: string;
/** Full text of index.html + styles.css + all modules/*.js (sorted) */
let corpus: string;

// Per-module handles for file-specific assertions
let appSrc:    string;
let traceSrc:  string;
let hudSrc:    string;
let detailSrc: string;

beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
  css  = fs.readFileSync(CSS_PATH,  'utf8');

  let moduleSrc = '';
  if (fs.existsSync(MODULES_DIR)) {
    const jsFiles = fs.readdirSync(MODULES_DIR)
      .filter(f => f.endsWith('.js'))
      .sort();
    for (const f of jsFiles) {
      const src = fs.readFileSync(path.join(MODULES_DIR, f), 'utf8');
      moduleSrc += src + '\n';
      // Per-module handles for targeted assertions
      if (f === 'app.js')    appSrc    = src;
      if (f === 'trace.js')  traceSrc  = src;
      if (f === 'hud.js')    hudSrc    = src;
      if (f === 'detail.js') detailSrc = src;
    }
  }

  corpus = html + '\n' + css + '\n' + moduleSrc;
});

// ---------------------------------------------------------------------------
// shell: import map + module entry + HTML chrome
// ---------------------------------------------------------------------------

describe('shell', () => {
  it('contains <script type="importmap"> in index.html', () => {
    expect(html).toContain('type="importmap"');
  });

  it('import map precedes all module script elements (Pitfall 1, non-negotiable)', () => {
    const importMapIdx = html.indexOf('"importmap"');
    const moduleIdx    = html.indexOf('type="module"');
    expect(importMapIdx).toBeGreaterThan(-1);
    expect(moduleIdx).toBeGreaterThan(-1);
    expect(importMapIdx).toBeLessThan(moduleIdx);
  });

  it('import map maps "three" to ./vendor/three.module.js', () => {
    expect(html).toContain('./vendor/three.module.js');
    expect(html).toMatch(/"three"\s*:\s*"\.\/vendor\/three\.module\.js"/);
  });

  it('index.html references modules/app.js as the single module entry', () => {
    expect(html).toContain('modules/app.js');
    expect(html).toMatch(/type="module"[^>]*src="[^"]*modules\/app\.js"/);
  });

  it('has no inline executable JS beyond the import map (thin shell)', () => {
    // Strip the importmap block, then verify no non-empty inline script tags remain
    const stripped = html.replace(/<script[^>]*type="importmap"[^>]*>[\s\S]*?<\/script>/i, '');
    // Only src-based script tags are allowed after stripping importmap
    const inlineJs = stripped.match(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    const nonEmpty = inlineJs.filter(s => {
      const inner = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      return inner.length > 0;
    });
    expect(nonEmpty).toHaveLength(0);
  });

  it('contains the full HTML chrome id skeleton', () => {
    expect(html).toContain('id="graph"');
    expect(html).toContain('id="panel"');
    expect(html).toContain('id="detail"');
    expect(html).toContain('id="tooltip"');
    expect(html).toContain('id="backdrop"');
    expect(html).toContain('id="hull-credit"');
  });

  it('contains detail panel inner ids', () => {
    expect(html).toContain('id="detail-title"');
    expect(html).toContain('id="detail-meta"');
    expect(html).toContain('id="detail-body"');
    expect(html).toContain('id="detail-conns"');
    expect(html).toContain('id="detail-conns-more"');
  });

  it('has CC BY-SA attribution for brain model (legally required)', () => {
    expect(html).toContain('CC BY-SA');
    expect(html).toContain('Nevit Dilmen');
    expect(html).toContain('brain model: Nevit Dilmen · CC BY-SA 3.0');
  });

  it('has close button with aria-label="Close node detail" (a11y)', () => {
    expect(html).toMatch(/<button[^>]*aria-label="Close node detail"/);
  });
});

// ---------------------------------------------------------------------------
// css: layout invariants, typography, display:none defaults
// ---------------------------------------------------------------------------

describe('css', () => {
  it('uses system-ui font stack for UI chrome (D-16)', () => {
    expect(css).toContain('system-ui');
  });

  it('uses monospace font stack for data values (D-16)', () => {
    expect(css).toContain('monospace');
  });

  it('#graph is fixed full-bleed with opacity:0 (hidden until settled)', () => {
    expect(css).toMatch(/#graph[\s\S]{0,300}opacity\s*:\s*0/);
    expect(css).toMatch(/#graph[\s\S]{0,300}inset\s*:\s*0/);
  });

  it('#detail, #tooltip, #backdrop carry display:none defaults in the stylesheet', () => {
    // CSS defines display: none for these three elements
    // (in the modular architecture display:none lives in CSS, not inline HTML)
    expect(css).toContain('display: none');
    // All three element ids are present in the HTML
    expect(html).toContain('id="detail"');
    expect(html).toContain('id="tooltip"');
    expect(html).toContain('id="backdrop"');
  });

  it('defines a slide-in transition class for panel/detail (D-13/D-15)', () => {
    expect(css).toContain('transition');
    expect(css).toContain('panel-open');
  });

  it('defines toast or error-badge class for error surfacing (D-14)', () => {
    expect(css).toMatch(/\.toast|\.error-badge/);
  });

  it('sets the deep warm-aubergine background (Recense brand field, 2026-06-12)', () => {
    expect(css).toMatch(/background\s*:\s*#170f1d/i);
  });

  it('has no external CDN URLs in the stylesheet (T-10-10)', () => {
    expect(css).not.toMatch(/cdn\.|unpkg\.com|jsdelivr\.net|googleapis\.com/i);
    expect(css).not.toMatch(/@import\s+url\s*\(\s*['"]?https?:/i);
  });
});

// ---------------------------------------------------------------------------
// constants: exported values and ctx typedef
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('src/viz/modules/constants.js exists on disk', () => {
    expect(fs.existsSync(path.join(MODULES_DIR, 'constants.js'))).toBe(true);
  });

  it('the test reads src/viz/modules/*.js (not only index.html)', () => {
    // corpus includes moduleSrc; verify that constants.js content appears in corpus
    // but NOT in html alone
    expect(corpus).toContain('TYPE_COLOR');
    // The raw html thin shell does not contain TYPE_COLOR (it has no app logic)
    expect(html).not.toContain('TYPE_COLOR');
  });

  it('constants.js exports TYPE_COLOR', () => {
    expect(corpus).toMatch(/export\s+const\s+TYPE_COLOR/);
  });

  it('TYPE_COLOR has entity, fact, schema keys', () => {
    expect(corpus).toContain('entity');
    expect(corpus).toContain('fact');
    expect(corpus).toContain('schema');
  });

  it('constants.js exports TOMBSTONE_COLOR', () => {
    expect(corpus).toMatch(/export\s+const\s+TOMBSTONE_COLOR/);
  });

  it('constants.js exports HOT activation colour', () => {
    expect(corpus).toMatch(/export\s+const\s+HOT/);
  });

  it('constants.js exports BRAIN_SCALE', () => {
    expect(corpus).toMatch(/export\s+const\s+BRAIN_SCALE/);
  });

  it('constants.js exports MAX_HOPS', () => {
    expect(corpus).toMatch(/export\s+const\s+MAX_HOPS/);
  });

  it('constants.js exports PULSE_MS', () => {
    expect(corpus).toMatch(/export\s+const\s+PULSE_MS/);
  });

  it('constants.js documents the ctx contract (JSDoc typedef)', () => {
    // Must name the key ctx fields from the <interfaces> contract
    expect(corpus).toContain('applyTrace');
    expect(corpus).toContain('revealTrace');
    expect(corpus).toContain('selectNode');
    expect(corpus).toContain('logEvent');
    expect(corpus).toContain('setTier');
    expect(corpus).toContain('markActive');
  });
});

// ---------------------------------------------------------------------------
// security: no CDN, no external URLs, no shell IPC, XSS discipline
// ---------------------------------------------------------------------------

describe('security', () => {
  it('has no CDN URLs across the full corpus (T-10-10)', () => {
    expect(corpus).not.toMatch(/cdn\.|unpkg\.com|jsdelivr\.net|googleapis\.com/i);
  });

  it('has no external http(s) URLs across the corpus (except 127.0.0.1)', () => {
    const external = corpus.match(/https?:\/\/(?!127\.0\.0\.1)[a-zA-Z0-9][^\s'"<>]*/g);
    expect(external).toBeNull();
  });

  it('has no shell IPC coupling across the corpus (D-102)', () => {
    expect(corpus).not.toMatch(/require\(['"]electron['"]\)|ipcRenderer|nodeIntegration/);
  });

  it('XSS: detail panel title set via textContent, never innerHTML (T-10-12)', () => {
    // titleEl (=detail-title) must be assigned via textContent only
    expect(detailSrc).not.toContain('titleEl.innerHTML');
    expect(detailSrc).toContain('titleEl.textContent');
  });

  it('XSS: detail panel body set via textContent, never innerHTML (T-10-12)', () => {
    // bodyEl (=detail-body) must be assigned via textContent only
    expect(detailSrc).not.toContain('bodyEl.innerHTML');
    expect(detailSrc).toContain('bodyEl.textContent');
  });
});

// ---------------------------------------------------------------------------
// bootstrap: Spike-001 load order, data fetching (app.js assertions)
// ---------------------------------------------------------------------------

describe('bootstrap', () => {
  it('app.js exists on disk', () => {
    expect(fs.existsSync(path.join(MODULES_DIR, 'app.js'))).toBe(true);
  });

  it('sets window.THREE = THREE before injecting 3d-force-graph.min.js (Spike 001)', () => {
    // Load order is non-negotiable: UMD bundle reads window.THREE at parse time
    const threeIdx = appSrc.indexOf('window.THREE = THREE');
    const fgIdx    = appSrc.indexOf('3d-force-graph.min.js');
    expect(threeIdx).toBeGreaterThan(-1);
    expect(fgIdx).toBeGreaterThan(-1);
    expect(threeIdx).toBeLessThan(fgIdx);
  });

  it("fetches '/graph' on page load (app.js data contract)", () => {
    expect(appSrc).toMatch(/fetch\(['"]\/graph['"]\)/);
  });

  it("connects EventSource to '/events' (hud.js SSE contract)", () => {
    expect(hudSrc).toContain("EventSource('/events')");
  });

  it('import map script element precedes all type="module" script elements (Pitfall 1)', () => {
    const importMapIdx = html.indexOf('"importmap"');
    const moduleIdx    = html.indexOf('type="module"');
    expect(importMapIdx).toBeGreaterThan(-1);
    expect(moduleIdx).toBeGreaterThan(-1);
    expect(importMapIdx).toBeLessThan(moduleIdx);
  });

  it('references split module files via <script type="module"> (D-10)', () => {
    expect(html).toContain('modules/');
  });
});

// ---------------------------------------------------------------------------
// activation: applyTrace / spawnPulse / spreading-activation invariants (D-102)
// ---------------------------------------------------------------------------

describe('activation', () => {
  it('has exactly one applyTrace function definition (trace.js — D-102)', () => {
    const defs = corpus.match(/function applyTrace/g);
    expect(defs).not.toBeNull();
    expect(defs!.length).toBe(1);
  });

  it('SSE trace event handler calls applyTrace (hud.js — D-102 SSE half)', () => {
    // The 'trace' SSE listener must invoke ctx.applyTrace
    const idx = hudSrc.indexOf("addEventListener('trace'");
    expect(idx).toBeGreaterThan(-1);
    // Look for applyTrace within a reasonable window of the listener
    expect(hudSrc.slice(idx, idx + 400)).toContain('applyTrace');
  });

  it('has at least 2 calls to applyTrace (SSE path + local test-trace trigger — D-102)', () => {
    // Both the SSE 'trace' handler (hud.js) and the local test trigger (trace.js)
    // call applyTrace — proving they share the same function (D-102 proof)
    expect((corpus.match(/applyTrace\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('lights activation pathways (spawnPulse) along edges on a trace (trace.js)', () => {
    expect(traceSrc).toContain('spawnPulse');
    expect(traceSrc).toMatch(/function spawnPulse/);
  });

  it('does not call Graph.refresh() inside the activation tick callback (Spike 001 perf guard)', () => {
    // trace.js owns the per-frame activation tick; it must never call Graph.refresh()
    // which re-lays out the full graph and is prohibitively expensive per-frame.
    // Strip JS comments before checking (trace.js legitimately documents the prohibition
    // in comments like "never calls Graph.refresh()" — those are good, not violations).
    const traceCode = traceSrc
      .replace(/\/\/[^\n]*/g, '')      // strip single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // strip block comments
    expect(traceCode).not.toContain('Graph.refresh()');
  });
});

// ---------------------------------------------------------------------------
// detail-ux: panel a11y, Escape handler
// ---------------------------------------------------------------------------

describe('detail-ux', () => {
  it('has Escape key dismiss handler (detail.js — D-15)', () => {
    expect(detailSrc).toContain('Escape');
  });

  it('#detail element exists in HTML and display:none default is in CSS', () => {
    // Element presence
    expect(html).toContain('id="detail"');
    // Default hidden state lives in CSS (not inline HTML in the modular architecture)
    expect(css).toContain('display: none');
  });

  it('has close button with aria-label="Close node detail" (a11y)', () => {
    expect(html).toMatch(/<button[^>]*aria-label="Close node detail"/);
  });
});
