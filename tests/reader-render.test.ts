/**
 * Tests for src/viz/modules/reader.js (27-03 Task 2 — promoted reader).
 *
 * Coverage (node-only, no DOM — tests the pure renderMarkdown export):
 *   (a) XSS: a fact value containing <img onerror=...> is escaped — no raw HTML injected.
 *   (b) recense://fact/<uuid> link renders as <a class="fact-ref" data-fact="<uuid>">.
 *   (c) recense://doc/<slug> link renders as <a class="doc-ref" data-doc="<slug>">.
 *   (d) renderMarkdown escapes & < > " in body text.
 *   (e) Heading, list, paragraph, and hr blocks render correctly.
 *   (f) Bold and code inline markers work inside escaped text.
 *   (g) Plain markdown links are stripped to text-only (no outbound nav).
 *   (h) FACT_LINK regex only matches full 36-char UUIDs (consistent with
 *       the canonicalized doc body from doc-generator.ts).
 *
 * These tests run in node (no browser, no DOM) — renderMarkdown is pure string→string.
 */

import { describe, it, expect } from 'vitest';
// @ts-ignore — browser ESM, no type declarations; exercised directly in node
import { renderMarkdown } from '../src/viz/modules/reader.js';

// ---------------------------------------------------------------------------
// T-27-08 / T-10-12: XSS — malicious fact values must never reach innerHTML raw
// ---------------------------------------------------------------------------

describe('renderMarkdown — XSS safety (T-27-08 / T-10-12)', () => {
  it('escapes <img onerror=...> in paragraph text — no raw HTML tag', () => {
    const md = 'A fact: <img src=x onerror=alert(1)>';
    const html = renderMarkdown(md);
    // The raw <img tag must NOT appear (would be executable by the browser).
    expect(html).not.toContain('<img ');
    // The angle brackets are escaped so the browser sees literal text, not a tag.
    expect(html).toContain('&lt;img');
    expect(html).toContain('&gt;');
  });

  it('escapes <script> tags in headings', () => {
    const md = '# Title <script>alert(1)</script>';
    const html = renderMarkdown(md);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes ampersand in body text', () => {
    const html = renderMarkdown('A & B');
    expect(html).toContain('&amp;');
    expect(html).not.toMatch(/[^&]& /);
  });

  it('escapes double-quotes in paragraph text', () => {
    const html = renderMarkdown('He said "hello"');
    expect(html).toContain('&quot;');
  });

  it('escapes < > in list items', () => {
    const html = renderMarkdown('- item <b>bold attempt</b>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

// ---------------------------------------------------------------------------
// Fact-ref and doc-ref link rendering (T-27-09)
// ---------------------------------------------------------------------------

describe('renderMarkdown — fact-ref and doc-ref links', () => {
  it('renders recense://fact/<36-char-uuid> as <a class="fact-ref" data-fact="...">',  () => {
    const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const md = `A claim [proven here](recense://fact/${uuid}).`;
    const html = renderMarkdown(md);
    expect(html).toContain(`class="fact-ref"`);
    expect(html).toContain(`data-fact="${uuid}"`);
    expect(html).toContain('>proven here<');
    // href must be "#" (no outbound nav)
    expect(html).toContain('href="#"');
  });

  it('renders recense://doc/<slug> as <a class="doc-ref" data-doc="...">',  () => {
    const md = 'See [tonos](recense://doc/tonos).';
    const html = renderMarkdown(md);
    expect(html).toContain('class="doc-ref"');
    expect(html).toContain('data-doc="tonos"');
    expect(html).toContain('>tonos<');
  });

  it('does NOT render a truncated (8-char) id as a fact-ref (full UUID required)', () => {
    // The canonicalized doc body always uses full 36-char UUIDs (doc-generator.ts fix).
    // FACT_LINK regex requires [0-9a-f-]{36} — truncated ids must not match.
    const md = 'Claim [ref](recense://fact/aaaaaaaa).';
    const html = renderMarkdown(md);
    // Should be stripped to text (plain markdown link fallback)
    expect(html).not.toContain('fact-ref');
    expect(html).toContain('ref'); // text preserved
  });

  it('strips plain markdown links to text only (no outbound nav)', () => {
    const md = 'See [external](https://example.com).';
    const html = renderMarkdown(md);
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<a');
    expect(html).toContain('external');
  });
});

// ---------------------------------------------------------------------------
// Block-level markdown rendering
// ---------------------------------------------------------------------------

describe('renderMarkdown — block-level rendering', () => {
  it('renders h1 through h3', () => {
    const md = '# H1\n## H2\n### H3';
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>H1</h1>');
    expect(html).toContain('<h2>H2</h2>');
    expect(html).toContain('<h3>H3</h3>');
  });

  it('renders a horizontal rule', () => {
    const html = renderMarkdown('before\n---\nafter');
    expect(html).toContain('<hr/>');
  });

  it('renders an unordered list', () => {
    const md = '- item one\n- item two';
    const html = renderMarkdown(md);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>item one</li>');
    expect(html).toContain('<li>item two</li>');
    expect(html).toContain('</ul>');
  });

  it('wraps plain text in <p>', () => {
    const html = renderMarkdown('Hello world');
    expect(html).toBe('<p>Hello world</p>');
  });

  it('closes a list before a paragraph', () => {
    const md = '- item\n\nparagraph';
    const html = renderMarkdown(md);
    expect(html).toContain('</ul>');
    expect(html).toContain('<p>paragraph</p>');
    // List must close before the paragraph.
    expect(html.indexOf('</ul>')).toBeLessThan(html.indexOf('<p>paragraph</p>'));
  });
});

// ---------------------------------------------------------------------------
// Inline markdown rendering
// ---------------------------------------------------------------------------

describe('renderMarkdown — inline formatting', () => {
  it('renders **bold** as <strong>', () => {
    const html = renderMarkdown('**bold text**');
    expect(html).toContain('<strong>bold text</strong>');
  });

  it('renders `code` as <code>', () => {
    const html = renderMarkdown('use `foo()`');
    expect(html).toContain('<code>foo()</code>');
  });

  it('renders bold inside a list item', () => {
    const md = '- **important** fact';
    const html = renderMarkdown(md);
    expect(html).toContain('<strong>important</strong>');
  });
});

// ---------------------------------------------------------------------------
// fetch URL check (source-level assertion — T-27-08)
// ---------------------------------------------------------------------------

describe('reader.js source assertions (T-27-08)', () => {
  it('fetch uses /doc?slug= (not /doc?term=)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/viz/modules/reader.js'),
      'utf8',
    );
    // Must fetch the DB-backed route.
    expect(src).toContain("'/doc?slug='");
    // Must not use the old file-backed route.
    expect(src).not.toContain("'/doc?term='");
  });

  it('fetches /doc/meta after render (for graph focus)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/viz/modules/reader.js'),
      'utf8',
    );
    expect(src).toContain('/doc/meta');
  });

  it('calls ctx.selectNode in wireFactLinks (fact-ref→atom wiring)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/viz/modules/reader.js'),
      'utf8',
    );
    expect(src).toContain('selectNode');
  });

  it('has no raw innerHTML assignment of fact/node values (T-10-12)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/viz/modules/reader.js'),
      'utf8',
    );
    // The only innerHTML assignment must be renderMarkdown output.
    // Count innerHTML assignments: should be exactly 1 (body.innerHTML = renderMarkdown(...)).
    const inners = src.match(/\.innerHTML\s*=/g) ?? [];
    expect(inners.length).toBe(1);
    // That one assignment must be renderMarkdown output.
    expect(src).toContain('body.innerHTML = renderMarkdown(');
  });
});
