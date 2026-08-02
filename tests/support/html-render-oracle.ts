/**
 * TEST-ONLY parse5-derived rendered-text oracle for a FIXED hiding rule (62-28-PLAN.md, Task 1).
 *
 * `WR-03` (`62-VERIFICATION.md`) named the coverage gap this oracle exists to close: the
 * phase's only oracle-driven differential (`tests/css-liveness-differential.test.ts`) holds
 * the HTML wrapper fixed and varies only the CSS, so an entire layer of production — the HTML
 * structure handling driven by the runtime parser production consumes — shipped with no
 * ground truth of its own. `CR-01`/`CR-02`/`CR-03` all live in that unvalidated band.
 *
 * WHAT THIS ORACLE SHARES WITH PRODUCTION: only the JavaScript runtime. It imports `parse5`,
 * a parser production does not use for its own runtime HTML consumption — a judge sharing
 * the judged's own parser cannot adjudicate a parsing disagreement between the two; this is
 * the WR-09 root cause (`62-REVIEW.md`) reproduced once already at the CSS-tokenizer layer,
 * displaced one layer up to HTML. `parse5` was chosen specifically because 62-21's own
 * bake-off measured it spec-conformant on `<style/>` (HTML §13.2.5: self-closing-tag syntax
 * on a non-void RAWTEXT element is a no-op; the element opens normally) — the exact rule
 * production's own runtime parser gets wrong and CR-01 exploits
 * (`tests/html-parser-conformance.test.ts:283`).
 *
 * WHAT THIS ORACLE DOES NOT DO: it does not implement CSS parsing, an HTML tokenizer, or any
 * copy of the production markup-stripper module's own algorithm. It answers exactly one
 * question —
 * "what text would a browser show a human, given the one fixed hiding rule below?" — by
 * walking parse5's own parsed tree and applying a small, spec-cited set of rendering rules.
 * Every rule below carries its spec citation; there is no rule in this file that exists
 * merely because production happens to behave that way.
 *
 * THE FIXED HIDING RULE: `.legal{display:none}` (class probe) and `#legal{display:none}`
 * (id probe), and nothing else. A stylesheet is APPLIED — its rule considered live — iff a
 * whitespace-insensitive literal scan of its own text contains that exact fragment. This is
 * deliberately NOT a CSS parser: no cascade, no specificity, no inheritance, no `@media`/
 * `@supports` evaluation, no external stylesheets (`<link>` is never fetched), and no other
 * hiding mechanism (`visibility`, `opacity`, absolute-position-off-canvas, `clip`/`clip-path`,
 * inline `style="display:none"` attributes) is recognized. The fixed rule needs none of that
 * machinery — collapsing the CSS side to a literal check is what makes every remaining
 * degree of freedom in this differential an HTML-layer question, which is the point (see
 * `tests/html-wrapper-differential.test.ts`'s own header for why the CSS axis is held fixed).
 *
 * NEVER-RENDERED ELEMENTS, each with its citation:
 *   - `script`, `style` — metadata/scripting content (HTML §4.2.6, §4.12.1): never flow
 *     content, never shown to a human as prose. A `<style>` element's own text is handled
 *     separately, below, as a candidate stylesheet — never as prose.
 *   - `head`, `title` — document metadata (HTML §4.2): the `head` element and everything
 *     inside it (including `title`, whose content is the document's title, not body prose)
 *     is never part of the rendered body.
 *   - `template` — HTML §4.12.3: a `<template>` element's contents are an inert
 *     `DocumentFragment` that is never inserted into the rendered document. parse5 exposes
 *     this content on `node.content`, a separate subtree from `node.childNodes` — this
 *     oracle never descends into it, for either text or stylesheet collection, so a `<style>`
 *     written inside a `<template>` is correctly never treated as applied either.
 *   - `noscript` — HTML §13.2.5.44 (the "noscript" tokenizer state): with scripting enabled
 *     (parse5's `scriptingEnabled: true` default, matching every evergreen browser with
 *     JavaScript on), a `<noscript>` element's content is tokenized as a single RAWTEXT-like
 *     blob and never rendered. Because it is raw text rather than parsed elements, a
 *     `<style>` written inside it is not a `style` ELEMENT at all — it never reaches this
 *     oracle's stylesheet-collection pass, which only recognizes real `style` element nodes.
 *   - `iframe`, `noembed`, `noframes` — these three are RAWTEXT elements at the tokenizer
 *     level (HTML §13.2.5.1, "the list of elements with raw text or escapable raw text
 *     content model"). Their fallback content exists only for user agents that lack the
 *     corresponding capability (frames/embed/scripting); no modern browser renders it, and
 *     Gmail itself strips it. Being RAWTEXT, their content is likewise never parsed into real
 *     elements — a `<style>` written inside any of the three is raw text, not an element, and
 *     is (correctly) never treated as an applied stylesheet by this oracle's collection pass.
 *   - `svg` — a deliberate SIMPLIFICATION, named as a blind spot below, not a spec claim: SVG
 *     has its own rendering model in which some constructs (e.g. an `<text>` element) DO
 *     render to a human. This oracle treats ALL text inside `<svg>` as non-rendered, which is
 *     an over-approximation for the rare case of genuine SVG text content. A `<style>`
 *     element nested inside inline SVG IS a real element under parse5's foreign-content
 *     parsing, and inline SVG shares the host document's CSSOM, so this oracle DOES still
 *     treat it as a candidate applied stylesheet (the never-rendered rule above governs only
 *     the text-accumulation pass, not the stylesheet-collection pass).
 *
 * HIDDEN ELEMENTS: an element (of any tag not already excluded above) is hidden — contributing
 * no text, and neither does its subtree — iff the class-probe stylesheet is applied AND the
 * element's decoded `class` attribute value, split on ASCII whitespace, contains the literal
 * token `legal`; OR the id-probe stylesheet is applied AND the element's decoded `id`
 * attribute value equals `legal` exactly. parse5 decodes attribute character references
 * itself (CSS Syntax is irrelevant here; this is plain HTML §13.2.5.72 attribute-value
 * decoding), so no separate decode step is needed in this file.
 *
 * EVERY OTHER TEXT NODE contributes its `value` verbatim, including inside RAWTEXT/RCDATA
 * elements this oracle does not name above as never-rendered (`xmp`, `textarea`) — these are
 * the over-strip controls: a browser DOES show a human the literal text inside either.
 *
 * BLIND SPOTS, stated explicitly rather than left as an unstated assumption (an oracle with
 * an unstated blind spot is this phase's own root cause, named in `62-28-PLAN.md`'s own
 * objective — do not replace one overclaim with another):
 *   1. The stylesheet-applied check is a literal substring scan, not a CSS parser. A
 *      semantically equivalent rule split across declarations (e.g.
 *      `.legal{color:red;display:none}`) or reordered/reformatted in any way that is not
 *      whitespace-only is NOT recognized as applying the fixed rule. This is intentional —
 *      see the module-level rationale above — but it means this oracle cannot adjudicate a
 *      divergence caused by a non-literal but equivalent hiding rule.
 *   2. SVG's own rendering model (some SVG constructs DO render text) is not modeled; see the
 *      `svg` bullet above.
 *   3. parse5's own known non-totality (62-21 Task 2's "C3" finding): a small number of
 *      pathological inputs can make `parseFragment` throw rather than return a best-effort
 *      tree. This oracle never swallows that into a normal verdict — see `oracleUnavailable`
 *      below — but it also cannot adjudicate those inputs at all.
 *   4. No inline `style="..."` attribute, `visibility`/`opacity`/geometry-based hiding, or any
 *      hiding mechanism other than the two fixed selector rules is recognized — deliberate,
 *      per the module-level rationale above.
 *
 * MUST NEVER be imported from production code and MUST NEVER import the runtime HTML parser
 * production consumes — it is test-only ground truth, drawn from a parser production does
 * not share. A judge that imports the parser it is meant to adjudicate against could never
 * find a parsing disagreement — the exact WR-09/T-62-28-02 failure mode this file exists to
 * avoid.
 */
import { parseFragment } from 'parse5';

/**
 * `text` is the prose a browser would show a human for `html`, given the fixed rule.
 * `oracleUnavailable` is true iff `parse5` threw while parsing `html` — in that case `text`
 * is always the empty string and MUST NOT be read as "no visible text", only as "no verdict".
 */
export interface RenderedTextVerdict {
  text: string;
  oracleUnavailable: boolean;
}

/** Tags whose own text (and subtree) never contributes to rendered prose. See the file-level
 *  doc comment above for each entry's citation. */
const NEVER_RENDERED_TAGS = new Set<string>([
  'script',
  'style',
  'head',
  'title',
  'template',
  'noscript',
  'svg',
  'iframe',
  'noembed',
  'noframes',
]);

/** Whitespace-insensitive literal match — the deliberate non-CSS-parser check described in
 *  the file-level doc comment's "THE FIXED HIDING RULE" section. */
function normalizeWhitespace(css: string): string {
  return css.replace(/\s+/g, '');
}

/**
 * Walks `node`'s subtree (parse5's `DocumentFragment`/element node shape — `childNodes`, plus
 * `#text` nodes' own `value`) collecting the raw text content of every real `style` ELEMENT
 * found, so the caller can decide which fixed rules are applied before any hidden-element
 * decision is made — a rule declared textually after the element it hides must still apply,
 * exactly like a browser's own two-phase parse-then-render model.
 *
 * `template` is skipped entirely (never descended into) per HTML §4.12.3 — its content lives
 * on a separate `content` property this walk never visits, so a `<style>` inside a `<template>`
 * can never be collected as applied. `iframe`/`noembed`/`noframes`/`noscript` need no special
 * case here: their RAWTEXT/noscript-state content model means parse5 never creates a `style`
 * ELEMENT inside them in the first place (see the file-level doc comment) — this walk simply
 * finds a `#text` node there, which contributes nothing to `sheets`.
 */
function collectAppliedStylesheetTexts(node: any, sheets: string[]): void {
  const children = node.childNodes as any[] | undefined;
  if (!children) return;
  for (const child of children) {
    if (child.nodeName === 'style') {
      const textChild = (child.childNodes as any[] | undefined)?.find(c => c.nodeName === '#text');
      if (textChild) sheets.push(textChild.value as string);
      continue; // a style element's only meaningful content is its own RAWTEXT child, above
    }
    if (child.nodeName === 'template') continue; // HTML §4.12.3 — inert, content on node.content
    collectAppliedStylesheetTexts(child, sheets);
  }
}

/** True iff `element` carries the decoded `class`/`id` attribute value the given applied
 *  rule targets. parse5 decodes attribute character references itself (HTML §13.2.5.72),
 *  so `attr.value` is already the decoded string — no separate decode step needed here. */
function isHiddenByFixedRule(element: any, classRuleApplied: boolean, idRuleApplied: boolean): boolean {
  const attrs = element.attrs as Array<{ name: string; value: string }> | undefined;
  if (!attrs) return false;
  for (const attr of attrs) {
    if (classRuleApplied && attr.name === 'class') {
      const classes = attr.value.split(/\s+/).filter(token => token.length > 0);
      if (classes.includes('legal')) return true;
    }
    if (idRuleApplied && attr.name === 'id' && attr.value === 'legal') return true;
  }
  return false;
}

/**
 * Walks `node`'s subtree accumulating rendered prose into `out`, in document order. Skips
 * every never-rendered tag (see `NEVER_RENDERED_TAGS` and its citations above) and every
 * element hidden by the fixed rule (and, per the file-level doc comment, that element's
 * entire subtree — a hidden container hides everything inside it, exactly like `display:none`
 * does in a real browser).
 */
function accumulateRenderedText(node: any, classRuleApplied: boolean, idRuleApplied: boolean, out: string[]): void {
  const children = node.childNodes as any[] | undefined;
  if (!children) return;
  for (const child of children) {
    if (child.nodeName === '#text') {
      out.push(child.value as string);
      continue;
    }
    if (child.nodeName === '#comment') continue;
    if (NEVER_RENDERED_TAGS.has(child.nodeName)) continue;
    if (isHiddenByFixedRule(child, classRuleApplied, idRuleApplied)) continue;
    accumulateRenderedText(child, classRuleApplied, idRuleApplied, out);
  }
}

/**
 * Returns the prose a browser would show a human for `html`, given the ONE fixed hiding rule
 * this module documents above. Never throws: a `parse5` parse failure is reported as
 * `{ text: '', oracleUnavailable: true }`, never silently folded into a normal verdict (per
 * `T-62-28-05` in `62-28-PLAN.md`'s threat register).
 */
export function renderedText(html: string): RenderedTextVerdict {
  let fragment: any;
  try {
    fragment = parseFragment(html);
  } catch {
    return { text: '', oracleUnavailable: true };
  }

  const stylesheetTexts: string[] = [];
  collectAppliedStylesheetTexts(fragment, stylesheetTexts);
  const normalizedSheets = stylesheetTexts.map(normalizeWhitespace);
  const classRuleApplied = normalizedSheets.some(sheet => sheet.includes('.legal{display:none}'));
  const idRuleApplied = normalizedSheets.some(sheet => sheet.includes('#legal{display:none}'));

  const out: string[] = [];
  accumulateRenderedText(fragment, classRuleApplied, idRuleApplied, out);

  return { text: out.join(''), oracleUnavailable: false };
}
