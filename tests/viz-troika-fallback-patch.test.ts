/**
 * Guard for the vendored troika-three-text CDN-neutralization patch (T-10-10 /
 * Phase 58 CR-01). The patch has TWO required sites:
 *
 *   1. unicodeFontResolverClientFactory — neutralized to resolve with
 *      `fontUrls: []` so no runtime CDN fetch ever happens.
 *   2. resolveFallbacks' `.then` continuation — upstream only calls allDone()
 *      from inside per-fontUrl loadFont callbacks, so with an empty fontUrls
 *      array typesetting would never complete and the Text instance's sync
 *      pipeline would wedge forever (labels with any glyph outside JetBrains
 *      Mono — emoji/CJK — would silently never render). The patched
 *      continuation maps every fallback char to font 0 (primary; uncovered
 *      glyphs render as tofu) and completes immediately, loading the primary
 *      font first when nothing else resolved (all-fallback text).
 *
 * A troika re-vendor that re-applies only site 1 silently reintroduces the
 * CR-01 wedge, so this test pins both sites. Assertions are source-level
 * (same pattern as viz-frontend-static.test.ts): the vendored file imports
 * bare 'three', which only resolves via the browser import map, so it cannot
 * be imported directly under vitest.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TROIKA_PATH = path.join(
  __dirname,
  '../src/viz/vendor/troika/troika-three-text.esm.js'
);

let src: string;

beforeAll(() => {
  src = fs.readFileSync(TROIKA_PATH, 'utf8');
});

describe('vendored troika font-fallback patch (T-10-10 / CR-01)', () => {
  it('site 1: unicodeFontResolverClientFactory is neutralized (no CDN, empty fontUrls)', () => {
    // The factory's getFontsForString must resolve immediately with no
    // fallback font URLs — this is what prevents all runtime network fetches.
    expect(src).toMatch(
      /getFontsForString\(text\)\s*\{\s*return Promise\.resolve\(\{ fontUrls: \[\], chars: new Uint8Array\(text\.length\) \}\);/
    );
  });

  it('site 2: resolveFallbacks continuation completes on empty fontUrls', () => {
    // The .then handler must open with the patched continuation…
    expect(src).toMatch(
      /\.then\(\(\{fontUrls, chars\}\) => \{\s*\/\/ PATCHED continuation/
    );

    // …and the patched block must (a) guard on empty fontUrls, (b) map the
    // fallback ranges' chars to font 0, and (c) call allDone() on both arms
    // (primary-font-load arm and already-resolved arm) before returning.
    const patchBlock = src.match(
      /if \(!fontUrls\.length\) \{[\s\S]*?\n {10}\}/
    );
    expect(patchBlock).not.toBeNull();
    const block = patchBlock![0];
    expect(block).toContain('charResolutions[i] = 0;');
    expect(block).toContain('fallbackRanges.forEach');
    expect(block).toMatch(
      /loadFont\(userFonts\[0\]\.src, fontObj => \{\s*fontResolutions\[0\] = fontObj;\s*allDone\(\);/
    );
    expect(block).toMatch(/\} else \{\s*allDone\(\);\s*\}/);
    expect(block).toMatch(/return;?\s*\}$/);
  });

  it('site 2 precedes the per-fontUrl load loop it bypasses', () => {
    // The empty guard must run BEFORE the fontUrls.forEach(...) loadFont loop
    // (whose callbacks are the only upstream allDone() call sites).
    const guardIdx = src.indexOf('if (!fontUrls.length) {');
    const loopIdx = src.indexOf('fontUrls.forEach((url, i) => {');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(loopIdx);
  });
});
