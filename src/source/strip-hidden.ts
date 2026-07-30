/**
 * stripHiddenContent — pure, deterministic markup + hidden-content stripper (EMAIL-03).
 *
 * Applied unconditionally inside `normalizeGmailMessage` (src/source/gmail-adapter.ts)
 * to `raw.bodyText` BEFORE the provenance header is joined and BEFORE `redactSecrets`
 * runs. `extractBodyText`'s final fallback returns raw HTML whenever a Gmail message has
 * no `text/plain` part — a common shape for ATS/recruiting-system mail — so text a human
 * cannot see in Gmail (a `display:none` div, a zero-width-joined payload, a class-hidden
 * span) would otherwise reach the model's token stream intact. This is the EchoLeak-class
 * indirect-injection vector; email content is untrusted by construction (origin is
 * hard-coded 'observed', D-61).
 *
 * All regexes are compiled ONCE at module load — never per call — mirroring redact.ts's
 * compile-once discipline. Global regexes have their `lastIndex` reset immediately before
 * each manual `.exec()` loop for the same reason `redactSecrets` does; regexes driven
 * through `.replace()`/`.match()`/`.test()` with no manual loop need no such reset (the
 * built-in @@replace/@@match algorithms reset lastIndex themselves).
 *
 * Stage order (load-bearing — see the block comment above each stage):
 *  1. Invisible-codepoint removal (zero-width chars, BOM, soft hyphen, invisible math
 *     operators, the Unicode Tags block) — unconditional, applied to ALL input including
 *     plain text, and run FIRST so a payload cannot use zero-width characters to
 *     fragment a later stage's pattern match (e.g. `dis<ZWSP>play:none`). Also exported
 *     standalone as `stripInvisibleCodepoints` (CR-02) for non-markup callers — e.g.
 *     `normalizeGmailMessage`'s provenance header — that need invisible-codepoint removal
 *     WITHOUT the markup semantics of stages 2-6.
 *  2. CSS hiding-selector harvest from `<style>` blocks — BEFORE those blocks are
 *     discarded, so a `.legal{display:none}` rule is remembered even though the block
 *     carrying it is about to be deleted (stage 4). Bounded to 200 harvested selectors.
 *     The `<style>` open tag is matched quote-aware, so a `type="text/css" data-y="x>y"`
 *     style tag still yields its rules to the harvest.
 *  3. HTML comment removal.
 *  4. Non-content element removal (script/style/head/title/template/noscript/svg), with
 *     their contents.
 *  5. Hidden element removal, with contents — any start tag whose inline style matches a
 *     hiding signature, or whose class/id was harvested in stage 2, or which carries a
 *     bare `hidden` attribute / `aria-hidden="true"`.
 *  6. Remaining tag removal — every leftover `<...>` sequence is deleted.
 *  7. Minimal entity decoding — ONLY `&nbsp;`/`&#160;` become a space.
 *  8. Whitespace normalization that preserves paragraph structure.
 *
 * What is stripped:
 *  Shape                                          Result
 *  Zero-width / invisible Unicode codepoints       removed everywhere, incl. plain text
 *  HTML comments                                   removed, incl. unterminated (to EOS)
 *  <script>/<style>/<head>/<title>/<template>/
 *    <noscript>/<svg>, with contents               removed, incl. unterminated (to EOS)
 *  display:none / visibility:hidden|collapse /
 *    opacity:0 / font-size:0 / (max-)?height:0 /
 *    (max-)?width:0 / negative text-indent /
 *    off-canvas left|top / clip:rect(0 /
 *    clip-path:inset(100% / bare `hidden` attr /
 *    aria-hidden="true" / class-or-id-hidden-via-
 *    harvested-<style>-rule elements, with contents  removed, incl. unterminated (to EOS)
 *  Every remaining tag                             removed
 *
 * What is deliberately KEPT:
 *  - Visible prose and its line/paragraph structure (plain-text bodies pass through
 *    unchanged; this function is NOT a whitespace-collapsing sanitizer).
 *  - Email addresses and other PII (D-64 — out of this module's scope; redactSecrets
 *    handles secrets, this module handles markup/visibility, neither touches PII).
 *  - Every entity except `&nbsp;`/`&#160;` is left literal. Decoding `&amp;` or `&lt;`
 *    would break idempotence (`&amp;amp;` -> `&amp;` -> `&` on repeated passes; a decoded
 *    `&lt;` would be re-read as a tag start on a second pass). A stray `&amp;` left in
 *    prose is cosmetic noise; a non-idempotent boundary function is a correctness bug,
 *    since `redactSecrets` alongside it is idempotent and callers rely on that property.
 *
 * Three named residual limitations this module does NOT close (accepted, not silently
 * omitted — see 62-03-SUMMARY.md T-62-22, 62-07-SUMMARY.md for (c)):
 *  (a) White-text-on-white-background hiding is NOT detected. A color-only heuristic
 *      would drop legitimate dark-mode-styled prose, trading an injection risk for a
 *      classification-accuracy regression.
 *  (b) Hiding via an externally-linked stylesheet is NOT detected. recense never fetches
 *      remote resources during ingest, and not fetching is the correct posture.
 *  (c) Unbalanced quotes inside a tag (e.g. an unclosed `title="`) cause the stage-6
 *      fail-safe stray-`<` truncation to drop from that tag to end of string, which may
 *      remove visible prose that followed. Accepted because the alternative is guessing
 *      where a malformed tag ends, and guessing wrong reopens the CR-01 bypass this
 *      module exists to close — this is the deliberate cost of the CR-01 quote-aware fix
 *      (62-07-PLAN.md Task 2), consistent with the "monotone toward less content, never
 *      raw passthrough" contract below.
 *
 * Contract:
 *  - Pure: no side effects, no I/O, no randomness, no clock read (LLM-free online path).
 *  - Idempotent: stripHiddenContent(stripHiddenContent(x)) === stripHiddenContent(x).
 *  - Total: never throws, for any string including empty/malformed/unterminated/deeply
 *    nested input.
 *  - Monotone toward less content: for adversarial or malformed input, the output is a
 *    subset-shaped reduction of the input — never the raw input passed through.
 */

// ---------------------------------------------------------------------------
// Stage 1 — invisible codepoint removal
// ---------------------------------------------------------------------------

/**
 * Zero-width / invisible Unicode codepoints, including the whole Unicode Tags block
 * (U+E0000-U+E007F) — the "hidden Unicode instruction injection" carrier named in 2026
 * indirect-prompt-injection research. Renders as nothing at all; pure payload.
 * Requires the 'u' flag for the astral-plane Tags-block range.
 */
const INVISIBLE_CODEPOINTS_RE =
  /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E\u2061-\u2064]|[\u{E0000}-\u{E007F}]/gu;

// ---------------------------------------------------------------------------
// Shared tag-matching primitives (module scope; tag NAME is runtime data, so the
// forward matching-close scan cannot be precompiled per tag — it reuses these two
// fixed regexes instead of constructing a new RegExp per matched tag name)
// ---------------------------------------------------------------------------

/**
 * Matches one HTML open tag: `<name ...>` or self-closing `<name .../>`. Attribute
 * scanning is quote-aware: only an UNQUOTED `<` or `>` terminates the tag, since a
 * literal `>` inside a quoted attribute value (or a CSS string literal inside `style`)
 * is legal HTML and was the CR-01 bypass (a quoted `>` truncated the match before the
 * hiding declaration was ever seen).
 */
const START_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/g;

/**
 * Matches any open OR close tag token, used by the forward matching-close scan. Same
 * quote-awareness rule as `START_TAG_RE` — only an unquoted `<` or `>` ends the tag, so
 * this stage cannot disagree with `START_TAG_RE` about where a tag ends.
 */
const ANY_TAG_TOKEN_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b(?:"[^"]*"|'[^']*'|[^'"<>])*>/g;

/** True when a matched tag's raw text ends with a self-closing `/>`. */
const SELF_CLOSING_SUFFIX_RE = /\/\s*>$/;

/** HTML void elements — never have a closing tag; deleting the tag deletes the element. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Forward-scans from `fromIndex` counting nested same-name open/close tags to find the
 * tag matching the just-opened element, returning the index just past its closing tag.
 * Bounded by the remaining string length (each token is consumed once, no backtrack
 * across the whole scan). Fail-safe: returns `html.length` if no matching close exists —
 * "monotone toward less content, never raw passthrough" (T-62-18).
 */
function findMatchingCloseEnd(html: string, tagName: string, fromIndex: number): number {
  const lower = tagName.toLowerCase();
  ANY_TAG_TOKEN_RE.lastIndex = fromIndex;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = ANY_TAG_TOKEN_RE.exec(html)) !== null) {
    const name = m[2]!.toLowerCase();
    if (name !== lower) continue;
    const isClose = m[1] === '/';
    if (isClose) {
      depth -= 1;
      if (depth === 0) return m.index + m[0].length;
    } else {
      const selfClosing = SELF_CLOSING_SUFFIX_RE.test(m[0]) || VOID_ELEMENTS.has(name);
      if (!selfClosing) depth += 1;
    }
  }
  return html.length;
}

/**
 * Scans `html` for open tags satisfying `shouldRemove(tagName, attrs)` and returns the
 * `[start, end)` ranges spanning each matched element (tag + contents + matching close,
 * or just the tag for self-closing/void elements). Shared by stage 4 (fixed non-content
 * tag set) and stage 5 (per-element hiding-signature predicate).
 */
function collectRemovalRanges(
  html: string,
  shouldRemove: (tagName: string, attrs: string) => boolean
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  START_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = START_TAG_RE.exec(html)) !== null) {
    const tagName = match[1]!.toLowerCase();
    const attrs = match[2] ?? '';
    const tagEnd = START_TAG_RE.lastIndex;
    if (!shouldRemove(tagName, attrs)) continue;
    const selfClosing = SELF_CLOSING_SUFFIX_RE.test(match[0]) || VOID_ELEMENTS.has(tagName);
    const rangeEnd = selfClosing ? tagEnd : findMatchingCloseEnd(html, tagName, tagEnd);
    ranges.push([match.index, rangeEnd]);
    START_TAG_RE.lastIndex = rangeEnd;
  }
  return ranges;
}

/** Deletes every `[start, end)` range from `html`, preserving everything in between. */
function applyRemovalRanges(html: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return html;
  let result = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    result += html.slice(cursor, start);
    cursor = end;
  }
  result += html.slice(cursor);
  return result;
}

// ---------------------------------------------------------------------------
// Stage 2 — CSS hiding-selector harvest (before <style> blocks are discarded)
// ---------------------------------------------------------------------------

/**
 * Matches a `<style>` open tag through to its closing tag. Attribute scanning is
 * quote-aware: only an UNQUOTED `<` or `>` terminates the open tag, since a literal `>`
 * inside a quoted attribute value is legal HTML and was the CR-01 bypass — here it
 * truncated the harvested block content mid-attribute, so `RULE_RE` saw a garbage
 * selector and no hiding selector was ever recorded. The unquoted class excludes `<`
 * (matching `START_TAG_RE`/`ANY_TAG_TOKEN_RE`) rather than permitting it (as `ANY_TAG_RE`
 * does), because stage 2's opinion of where this same `<style>` open tag ends must agree
 * with stage 4's — disagreement between them is the cross-stage boundary bug class T-62-43.
 */
const STYLE_BLOCK_RE = /<style\b(?:"[^"]*"|'[^']*'|[^'"<>])*>([\s\S]*?)<\/style\s*>/gi;
/** Simple non-nested `selectorList { body }` rule matcher (plain CSS has no nesting). */
const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
const BARE_CLASS_SELECTOR_RE = /^\.[A-Za-z0-9_-]+$/;
const BARE_ID_SELECTOR_RE = /^#[A-Za-z0-9_-]+$/;

/** Cap on harvested selectors so a pathological stylesheet cannot cause quadratic work. */
const MAX_HARVESTED_SELECTORS = 200;

/**
 * Harvests bare `.class`/`#id` selectors (no combinators, pseudo-selectors, attribute
 * selectors, or media queries — those selector shapes simply fail the bare-selector
 * regex test below, which also excludes `@media` blocks) whose rule body matches a
 * hiding signature (stage 5's `hasHidingSignature`). The realistic ATS shape hides a
 * span by class, not by inline style, so simply deleting the `<style>` block (stage 4)
 * would destroy the evidence that the span is hidden while leaving its text behind.
 */
function harvestHidingSelectors(html: string): { classes: Set<string>; ids: Set<string> } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  let total = 0;
  for (const styleMatch of html.matchAll(STYLE_BLOCK_RE)) {
    const blockContent = styleMatch[1] ?? '';
    for (const ruleMatch of blockContent.matchAll(RULE_RE)) {
      if (total >= MAX_HARVESTED_SELECTORS) return { classes, ids };
      const selectorText = ruleMatch[1]!.trim();
      const body = ruleMatch[2] ?? '';
      const selectors = selectorText.split(',').map(s => s.trim()).filter(Boolean);
      if (selectors.length === 0) continue;
      const allBare = selectors.every(
        s => BARE_CLASS_SELECTOR_RE.test(s) || BARE_ID_SELECTOR_RE.test(s)
      );
      if (!allBare || !hasHidingSignature(body)) continue;
      for (const sel of selectors) {
        if (total >= MAX_HARVESTED_SELECTORS) break;
        if (sel.startsWith('.')) classes.add(sel.slice(1));
        else ids.add(sel.slice(1));
        total += 1;
      }
    }
  }
  return { classes, ids };
}

// ---------------------------------------------------------------------------
// Stage 3 — comment removal
// ---------------------------------------------------------------------------

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function removeComments(html: string): string {
  const s = html.replace(HTML_COMMENT_RE, '');
  const idx = s.indexOf('<!--');
  return idx === -1 ? s : s.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Stage 4 — non-content element removal (fixed tag set)
// ---------------------------------------------------------------------------

const NON_CONTENT_TAGS = new Set([
  'script', 'style', 'head', 'title', 'template', 'noscript', 'svg',
]);

// ---------------------------------------------------------------------------
// Stage 5 — hidden element removal (hiding-signature registry, compiled once)
// ---------------------------------------------------------------------------

const DISPLAY_NONE_RE = /display\s*:\s*none\b/i;
const VISIBILITY_HIDDEN_RE = /visibility\s*:\s*(?:hidden|collapse)\b/i;
const OPACITY_VALUE_RE = /opacity\s*:\s*([0-9.]+)/i;
const FONT_SIZE_VALUE_RE = /font-size\s*:\s*([0-9.]+)/i;
const HEIGHT_VALUE_RE = /(?<![-a-z])height\s*:\s*([0-9.]+)/i;
const MAX_HEIGHT_VALUE_RE = /max-height\s*:\s*([0-9.]+)/i;
const WIDTH_VALUE_RE = /(?<![-a-z])width\s*:\s*([0-9.]+)/i;
const MAX_WIDTH_VALUE_RE = /max-width\s*:\s*([0-9.]+)/i;
const TEXT_INDENT_NEGATIVE_RE = /text-indent\s*:\s*-[0-9.]+/i;
const OFFCANVAS_POSITION_RE = /\b(?:left|top)\s*:\s*-\d{3,}/i;
const CLIP_RECT_ZERO_RE = /clip\s*:\s*rect\(\s*0/i;
const CLIP_PATH_FULL_RE = /clip-path\s*:\s*inset\(\s*100%/i;

/** Extracts a numeric declaration value via `re` and reports whether it is exactly zero. */
function isZeroValue(text: string, re: RegExp): boolean {
  const m = text.match(re);
  return m !== null && parseFloat(m[1]!) === 0;
}

/**
 * True when `styleText` (an inline `style` attribute value, or a harvested `<style>`
 * rule's declaration block) contains any of the named hiding signatures. Zero-valued
 * properties are checked by extracting the number and comparing with `=== 0`, NOT by a
 * regex boundary trick — `opacity:0.85` must not match `opacity:0`.
 */
function hasHidingSignature(styleText: string): boolean {
  return (
    DISPLAY_NONE_RE.test(styleText) ||
    VISIBILITY_HIDDEN_RE.test(styleText) ||
    isZeroValue(styleText, OPACITY_VALUE_RE) ||
    isZeroValue(styleText, FONT_SIZE_VALUE_RE) ||
    isZeroValue(styleText, HEIGHT_VALUE_RE) ||
    isZeroValue(styleText, MAX_HEIGHT_VALUE_RE) ||
    isZeroValue(styleText, WIDTH_VALUE_RE) ||
    isZeroValue(styleText, MAX_WIDTH_VALUE_RE) ||
    TEXT_INDENT_NEGATIVE_RE.test(styleText) ||
    OFFCANVAS_POSITION_RE.test(styleText) ||
    CLIP_RECT_ZERO_RE.test(styleText) ||
    CLIP_PATH_FULL_RE.test(styleText)
  );
}

const STYLE_ATTR_RE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ARIA_HIDDEN_TRUE_RE = /\baria-hidden\s*=\s*["']?true["']?/i;
const BARE_HIDDEN_ATTR_RE = /(?:^|\s)hidden(?:\s|=|\/|$)/i;

/** Extracts an attribute's value (quoted or bare) using one of the ATTR_RE regexes above. */
function extractAttr(attrs: string, re: RegExp): string | null {
  const m = attrs.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * True when a start tag's raw attribute text matches any hiding shape: an inline style
 * hiding signature, the bare `hidden` boolean attribute, `aria-hidden="true"`, a `class`
 * containing a harvested (stage 2) name, or an `id` equal to a harvested id.
 */
function isHiddenStartTag(
  attrs: string,
  hiddenClasses: ReadonlySet<string>,
  hiddenIds: ReadonlySet<string>
): boolean {
  const style = extractAttr(attrs, STYLE_ATTR_RE);
  if (style !== null && hasHidingSignature(style)) return true;
  if (BARE_HIDDEN_ATTR_RE.test(attrs)) return true;
  if (ARIA_HIDDEN_TRUE_RE.test(attrs)) return true;
  const cls = extractAttr(attrs, CLASS_ATTR_RE);
  if (cls !== null) {
    for (const name of cls.split(/\s+/).filter(Boolean)) {
      if (hiddenClasses.has(name)) return true;
    }
  }
  const id = extractAttr(attrs, ID_ATTR_RE);
  if (id !== null && hiddenIds.has(id.trim())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stage 6 — remaining tag removal
// ---------------------------------------------------------------------------

/**
 * Same quote-awareness rule as `START_TAG_RE`/`ANY_TAG_TOKEN_RE` — only an unquoted `>`
 * ends the tag — but the unquoted class here is deliberately `[^'">]` rather than
 * `[^'"<>]`: this stage's leftover-tag sweep must preserve the pre-existing behavior
 * that a `<` may appear inside a stage-6 match, so `<` is not excluded here.
 */
const ANY_TAG_RE = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g;

// ---------------------------------------------------------------------------
// Stage 7 — minimal entity decoding
// ---------------------------------------------------------------------------

/**
 * ONLY `&nbsp;`/`&#160;` are decoded (to a single space). Every other entity is left
 * literal on purpose: decoding `&amp;` or `&lt;` would break idempotence (see the
 * file-level doc block above).
 */
const NBSP_ENTITY_RE = /&nbsp;|&#160;/gi;

// ---------------------------------------------------------------------------
// Stage 8 — whitespace normalization (preserves paragraph structure)
// ---------------------------------------------------------------------------

const SPACE_TAB_RUN_RE = /[ \t]+/g;
const NEWLINE_RUN_RE = /\n{3,}/g;

function normalizeWhitespace(text: string): string {
  let s = text.replace(SPACE_TAB_RUN_RE, ' ');
  s = s
    .split('\n')
    .map(line => line.trim())
    .join('\n');
  s = s.replace(NEWLINE_RUN_RE, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip invisible Unicode codepoints from `text` — stage 1 of `stripHiddenContent`,
 * exported standalone for callers that need invisible-codepoint removal WITHOUT markup
 * semantics (CR-02, `62-REVIEW.md`). The intended caller is `normalizeGmailMessage`'s
 * provenance header (`From:`/`Subject:`): both fields are 100% sender-controlled (RFC
 * 2047 encoded-words decode to arbitrary UTF-8), but neither is markup, so running the
 * full 8-stage `stripHiddenContent` on them would delete legitimate angle-bracketed
 * subject text (stages 4-6) — this narrow primitive cannot.
 *
 * Pure, total, idempotent, deterministic: `stripInvisibleCodepoints(stripInvisibleCodepoints(x))
 * === stripInvisibleCodepoints(x)`, never throws, no I/O, no clock read.
 *
 * Removes zero-width characters (U+200B-U+200D, U+2060), BOM (U+FEFF), soft hyphen
 * (U+00AD), the deprecated Mongolian vowel separator (U+180E), invisible math operators
 * (U+2061-U+2064), and the whole Unicode Tags block (U+E0000-U+E007F) — the "hidden
 * Unicode instruction injection" carrier this module's file-level doc block names.
 *
 * Deliberately NOT the full pipeline: does not touch markup, comments, or hiding
 * signatures — `stripInvisibleCodepoints('Re: <urgent> pricing & terms')` returns that
 * string byte-identical.
 *
 * @param text - Raw text (markup or plain) to strip invisible codepoints from.
 * @returns    `text` with every invisible codepoint removed; otherwise unchanged.
 */
export function stripInvisibleCodepoints(text: string): string {
  return text.replace(INVISIBLE_CODEPOINTS_RE, '');
}

/**
 * Strip markup and hidden content from `text`, returning plain visible prose.
 *
 * Pure, deterministic, idempotent, total (never throws). No LLM, no network, no
 * randomness, no clock read — this is an online-path function (ingest boundary).
 *
 * @param text - Raw Gmail body text (may be plain text or raw HTML).
 * @returns    Visible prose with all markup, hidden elements, and invisible Unicode
 *             codepoints removed. Plain-text input with none of the above is returned
 *             unchanged (aside from whitespace normalization, which is a no-op on
 *             already-normalized text).
 */
export function stripHiddenContent(text: string): string {
  // Stage 1: invisible codepoints first, so obfuscation like `dis<ZWSP>play:none`
  // cannot evade the stage-5 hiding-signature matcher.
  let s = stripInvisibleCodepoints(text);

  // Stage 2: harvest class/id hiding selectors from <style> blocks before they're
  // discarded in stage 4.
  const { classes: hiddenClasses, ids: hiddenIds } = harvestHidingSelectors(s);

  // Stage 3: strip comments.
  s = removeComments(s);

  // Stage 4: remove non-content elements (script/style/head/title/template/noscript/svg)
  // and their contents.
  s = applyRemovalRanges(
    s,
    collectRemovalRanges(s, tagName => NON_CONTENT_TAGS.has(tagName))
  );

  // Stage 5: remove hidden elements (inline style / class-or-id-hidden / hidden attr /
  // aria-hidden) and their contents.
  s = applyRemovalRanges(
    s,
    collectRemovalRanges(s, (_tagName, attrs) => isHiddenStartTag(attrs, hiddenClasses, hiddenIds))
  );

  // Stage 6: remove every remaining tag. An unterminated trailing `<` (no closing `>`
  // anywhere after it) is fail-safe-truncated to end of string rather than kept as
  // ambiguous, possibly-markup text.
  s = s.replace(ANY_TAG_RE, '');
  const strayAngleBracket = s.indexOf('<');
  if (strayAngleBracket !== -1) s = s.slice(0, strayAngleBracket);

  // Stage 7: decode only &nbsp;/&#160; — every other entity stays literal (idempotence).
  s = s.replace(NBSP_ENTITY_RE, ' ');

  // Stage 8: normalize whitespace while preserving paragraph structure.
  return normalizeWhitespace(s);
}
