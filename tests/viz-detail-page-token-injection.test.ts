/**
 * Regression lock for CR-01 (Phase 59 Plan 07 gap closure).
 *
 * Root cause: emitHudTokens() (css-tokens.js) — which injects the
 * `<style id="hud-tokens">` :root block that every var(--token) in
 * styles.css resolves against — was called only inside the graph-boot
 * else-arm of app.js's DETAIL_ID branch. The /?detail=<id> tray-detail
 * boot path returned before ever reaching that call, so the shipped
 * detail window rendered as an unstyled white page.
 *
 * Fix (Task 1 of this plan): relocate the single emitHudTokens() call to
 * run unconditionally before the DETAIL_ID branch splits.
 *
 * This file locks that fix two ways:
 *   Block A (boot-path reachability) — a source-text assertion on app.js:
 *     emitHudTokens() must appear exactly once, and its call site must
 *     precede the `DETAIL_ID !== null` branch check, proving it is
 *     reached by BOTH boot paths (VERIFICATION truth #2 / #6, D-12).
 *   Block B (functional) — exercises the real emitHudTokens() against a
 *     minimal document stub and asserts the injected element actually
 *     carries a resolved :root token block.
 *
 * No jsdom: this repo's vitest.config.ts is environment:'node' — Block A
 * reads source text via fs.readFileSync (mirrors tests/viz-frontend-static.test.ts),
 * Block B drives a tiny hand-rolled globalThis.document stub torn down in
 * afterAll (IN-05 lesson: never permanently clobber a global).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_JS_PATH = path.join(__dirname, '../src/viz/modules/app.js');

// ---------------------------------------------------------------------------
// Block A — boot-path reachability (source-order lock)
// ---------------------------------------------------------------------------

describe('detail-page boot-path token injection — reachability (CR-01)', () => {
  const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');

  it('emitHudTokens() appears exactly once in app.js', () => {
    const matches = appSrc.match(/emitHudTokens\(\)/g) || [];
    expect(matches).toHaveLength(1);
  });

  it('emitHudTokens() call precedes the DETAIL_ID mode branch, so it runs on BOTH the /?detail=<id> and graph-boot paths (VERIFICATION truth #2 / #6, D-12)', () => {
    const callIdx = appSrc.indexOf('emitHudTokens()');
    const branchIdx = appSrc.indexOf('DETAIL_ID !== null');

    expect(callIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(branchIdx);
  });
});

// ---------------------------------------------------------------------------
// Block B — injected #hud-tokens block resolves tokens (functional)
// ---------------------------------------------------------------------------

describe('emitHudTokens() injects a resolved :root token block', () => {
  const hadOwnDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const originalDocument = (globalThis as any).document;

  afterAll(() => {
    if (hadOwnDocument) {
      (globalThis as any).document = originalDocument;
    } else {
      delete (globalThis as any).document;
    }
  });

  it('appends a <style id="hud-tokens"> element whose textContent carries a resolved custom property', async () => {
    const appended: any[] = [];
    (globalThis as any).document = {
      getElementById: (_id: string) => null,
      createElement: (_tag: string) => ({} as any),
      head: {
        appendChild: (el: any) => {
          appended.push(el);
          return el;
        },
      },
    };

    // @ts-ignore — browser ESM module with no type declarations
    const { emitHudTokens } = await import('../src/viz/modules/css-tokens.js');
    emitHudTokens();

    expect(appended).toHaveLength(1);
    const [style] = appended;
    expect(style.id).toBe('hud-tokens');
    expect(style.textContent).toContain(':root {');
    expect(style.textContent).toContain('--glass-bg-ambient:');
  });
});
