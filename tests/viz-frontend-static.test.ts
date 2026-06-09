/**
 * Static structural assertions for src/viz/index.html (Plan 10-04).
 *
 * Reads the file as text and validates key structural invariants without
 * running a browser. Visual/animation/GPU verification is deferred to
 * the Plan 05 human-verify checkpoint.
 *
 * Coverage:
 *   render — vendor load order, no-CDN, data wiring, applyTrace, rAF perf guard,
 *             emitParticle, type colors, tombstone toggle copy, no shell IPC
 *   detail — #detail hidden by default, a11y close button, Escape handler,
 *             metadata fields, neighbor wikilinks, #tooltip, nodeHover, no anatomical terms
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HTML_PATH = path.join(__dirname, '../src/viz/index.html');
let html: string;

beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
});

// ---------------------------------------------------------------------------
// render: vendor load order, data wiring, animation, SSE
// ---------------------------------------------------------------------------

describe('render', () => {
  it('sets window.THREE = THREE before injecting 3d-force-graph.min.js (D-93 load order)', () => {
    const threeIdx = html.indexOf('window.THREE = THREE');
    const fgIdx    = html.indexOf('3d-force-graph.min.js');
    expect(threeIdx).toBeGreaterThan(-1);
    expect(fgIdx).toBeGreaterThan(-1);
    expect(threeIdx).toBeLessThan(fgIdx);
  });

  it('has no CDN URLs (no cdn/unpkg/jsdelivr/googleapis)', () => {
    expect(html).not.toMatch(/cdn\.|unpkg\.com|jsdelivr\.net|googleapis\.com/i);
  });

  it('has no http(s) URLs pointing to external domains', () => {
    const external = html.match(/https?:\/\/(?!127\.0\.0\.1)[a-zA-Z0-9][^\s'"<>]*/g);
    expect(external).toBeNull();
  });

  it("fetches '/graph' on page load", () => {
    expect(html).toContain("fetch('/graph')");
  });

  it("connects EventSource to '/events'", () => {
    expect(html).toContain("EventSource('/events')");
  });

  it('has exactly one function applyTrace definition', () => {
    const defs = html.match(/function applyTrace/g);
    expect(defs).not.toBeNull();
    expect(defs!.length).toBe(1);
  });

  it('SSE trace event handler calls applyTrace (D-102 proof)', () => {
    const traceListenerIdx = html.indexOf("addEventListener('trace'");
    expect(traceListenerIdx).toBeGreaterThan(-1);
    // applyTrace must appear within a reasonable window after the SSE listener
    const window200 = html.slice(traceListenerIdx, traceListenerIdx + 400);
    expect(window200).toContain('applyTrace');
  });

  it('has at least 2 calls to applyTrace (SSE + local trigger)', () => {
    const calls = html.match(/applyTrace\(/g);
    expect(calls).not.toBeNull();
    expect(calls!.length).toBeGreaterThanOrEqual(2);
  });

  it('does not call Graph.refresh() inside the tick function (perf guard D-93)', () => {
    const tickStart = html.indexOf('function tick(');
    expect(tickStart).toBeGreaterThan(-1);
    const rafCall  = html.indexOf('requestAnimationFrame(tick)', tickStart);
    const tickBody = html.slice(tickStart, rafCall + 30);
    expect(tickBody).not.toContain('Graph.refresh()');
  });

  it('calls Graph.emitParticle (particle flow along activation edges)', () => {
    expect(html).toContain('emitParticle');
  });

  it('has entity type color 0x5b8dff', () => {
    expect(html).toContain('5b8dff');
  });

  it('has fact type color 0x9b8cff', () => {
    expect(html).toContain('9b8cff');
  });

  it('has schema type color 0xff6b9d', () => {
    expect(html).toContain('ff6b9d');
  });

  it('has tombstone toggle copy string "Show tombstones"', () => {
    expect(html).toContain('Show tombstones');
  });

  it('has tombstone toggle copy string "Hide tombstones"', () => {
    expect(html).toContain('Hide tombstones');
  });

  it('has no shell IPC coupling (no electron/ipcRenderer/nodeIntegration)', () => {
    expect(html).not.toMatch(/require\(['"]electron['"]\)|ipcRenderer|nodeIntegration/);
  });
});

// ---------------------------------------------------------------------------
// detail: node detail panel, tooltip, a11y, metadata, wikilinks
// ---------------------------------------------------------------------------

describe('detail', () => {
  it('has #detail element', () => {
    expect(html).toContain('id="detail"');
  });

  it('#detail is hidden by default (display:none)', () => {
    // The inline style on #detail div includes display:none
    expect(html).toMatch(/id="detail"[^>]*>|display\s*:\s*none/);
    expect(html).toContain('display:none');
  });

  it('has close button with aria-label="Close node detail"', () => {
    expect(html).toContain('aria-label="Close node detail"');
  });

  it('close button is rendered as a <button> element', () => {
    expect(html).toMatch(/<button[^>]*aria-label="Close node detail"/);
  });

  it('has Escape key dismiss handler', () => {
    expect(html).toContain('Escape');
  });

  it('has "strength" metadata field', () => {
    expect(html).toContain('strength');
  });

  it('has "confidence" metadata field', () => {
    expect(html).toContain('confidence');
  });

  it('has "origin" metadata field', () => {
    expect(html).toContain('origin');
  });

  it('has "tombstone" metadata field', () => {
    expect(html).toContain('tombstone');
  });

  it('has neighbor wikilink [[ format', () => {
    expect(html).toContain('[[');
  });

  it('has #tooltip element', () => {
    expect(html).toContain('id="tooltip"');
  });

  it('has onNodeHover handler', () => {
    expect(html).toContain('onNodeHover');
  });

  it('has no anatomical region terms (VIZ-06 copywriting contract)', () => {
    expect(html).not.toMatch(/hippocampus|cortex|amygdala|cerebellum|striatum|thalamus|prefrontal|synap[a-z]*/i);
    expect(html).not.toMatch(/\bneuron\b|\baxon\b/i);
  });
});
