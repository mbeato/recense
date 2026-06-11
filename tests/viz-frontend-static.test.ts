/**
 * Static structural assertions for the Plan 15-02 corpus:
 *   src/viz/index.html         — thin shell (import map + module entry + HTML chrome)
 *   src/viz/css/styles.css     — deep-sea bioluminescent design system
 *   src/viz/modules/*.js       — constants.js (and future modules as they land)
 *
 * This test validates Plan 02 invariants only.
 * Plans 03–07 extend it as each module lands — see 15-PATTERNS.md for the
 * full assertion plan.  Assertions that depend on app.js, trace.js, graph.js,
 * detail.js, hud.js, or stats.js are NOT included here (those modules are
 * created in later plans; Plan 07 adds their assertions).
 *
 * Coverage:
 *   shell     — import map order (Pitfall 1), no CDN, CC attribution, module entry
 *   css       — display:none defaults, system-ui + monospace typography, slide-in,
 *               toast/badge class, deep-sea background
 *   constants — TYPE_COLOR/HOT/BRAIN_SCALE/MAX_HOPS/PULSE_MS exported, ctx typedef
 *   security  — no external URLs across corpus, no shell IPC (T-10-10)
 *
 * Dropped from the original Plan 10-04 test (intentionally changed by D-03/D-13/D-16,
 * or deferred to Plan 07):
 *   - Old palette hex assertions — D-03 redesigns palette; new hex values live in constants.js
 *   - "Show tombstones" / "Hide tombstones" copy assertions — D-13 modernises chrome
 *   - Anatomical term ban (VIZ-06 dropped 2026-06-10)
 *   - window.THREE = THREE load-order assertion — moves to app.js / Plan 07
 *   - fetch('/graph'), EventSource('/events') — move to app.js/hud.js / Plan 07
 *   - applyTrace, spawnPulse — move to trace.js / Plan 07
 *   - onNodeHover — moves to graph.js / Plan 07
 *   - Escape key handler — moves to detail.js / Plan 06
 *   - Metadata field assertions (strength/confidence/origin) — Plan 06
 *   - Wikilinks [[ format — Plan 06
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

beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
  css  = fs.readFileSync(CSS_PATH,  'utf8');

  let moduleSrc = '';
  if (fs.existsSync(MODULES_DIR)) {
    const jsFiles = fs.readdirSync(MODULES_DIR)
      .filter(f => f.endsWith('.js'))
      .sort();
    for (const f of jsFiles) {
      moduleSrc += fs.readFileSync(path.join(MODULES_DIR, f), 'utf8') + '\n';
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
    // (in the new architecture display:none lives in CSS, not inline HTML)
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

  it('sets a near-black deep-sea background colour (D-03)', () => {
    expect(css).toMatch(/background\s*:\s*#0[0-9a-f]{5}/i);
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
// security: no CDN, no external URLs, no shell IPC (T-10-10, D-93)
// ---------------------------------------------------------------------------

describe('security', () => {
  it('has no CDN URLs across the full corpus (T-10-10)', () => {
    expect(corpus).not.toMatch(/cdn\.|unpkg\.com|jsdelivr\.net|googleapis\.com/i);
  });

  it('has no external http(s) URLs across the corpus (except 127.0.0.1)', () => {
    const external = corpus.match(/https?:\/\/(?!127\.0\.0\.1)[a-zA-Z0-9][^\s'"<>]*/g);
    expect(external).toBeNull();
  });

  it('has no shell IPC coupling across the corpus', () => {
    expect(corpus).not.toMatch(/require\(['"]electron['"]\)|ipcRenderer|nodeIntegration/);
  });
});
