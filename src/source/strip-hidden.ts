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
 * built-in @@replace/@@match algorithms reset lastIndex themselves). Four of these regexes
 * are RegExp-constructed from a shared template-literal fragment (`ATTRS`, see below)
 * rather than written as bare literals; each is still constructed exactly once, at
 * module load, so the compile-once invariant holds literally. This SUPERSEDES 62-07's
 * acceptance criterion `grep -c "new RegExp" == 0`, which was a proxy for the real
 * invariant ("compiled once, never per call") rather than the invariant itself — the thing
 * that criterion was actually guarding against, constructing a regex per matched tag name
 * inside `findMatchingCloseEnd`, remains forbidden and remains absent.
 *
 * 62-12 gap closure (BL-01/BL-02/BL-03, 62-REVIEW.md) — three decisions recorded here:
 *  1. REVERSED 62-09's decision to exclude `<` from the unquoted-attribute class in
 *     `STYLE_BLOCK_RE` (and, by the same reasoning, in `START_TAG_RE`/`ANY_TAG_TOKEN_RE`).
 *     Per HTML §13.2.5.36 (attribute value, unquoted state), `<` is a parse error but is
 *     APPENDED to the attribute value — it does NOT terminate the tag; only an unquoted
 *     `>` does. 62-09 excluded `<` to keep stage 2 in agreement with stage 4. They did
 *     agree — they agreed on FAILING, and the shared failure was the leak (BL-01): a
 *     class-hidden payload and the raw `<style>` block both reached `record.content`. All
 *     four tag-scanning literals now share ONE fragment (`ATTRS`, permitting `<`), so
 *     agreement is structural rather than four literals happening to carry the same
 *     character class — a fifth literal built from the shared ATTRS fragment cannot silently diverge.
 *  2. REJECTED `\p{Cf}\p{Variation_Selector}` (the code-reviewer's proposed
 *     `INVISIBLE_CODEPOINTS_RE`) in favor of `\p{Default_Ignorable_Code_Point}`. Verified
 *     during planning by enumerating all of Unicode: `\p{Cf}` NARROWS current coverage by
 *     31 codepoints (`U+E0000`, `U+E0002-U+E001F` — the unassigned part of the Tags block
 *     the shipped literal already covers and `\p{Cf}` does not), which would have regressed
 *     part of the very carrier BL-03 is about. `\p{Default_Ignorable_Code_Point}` misses
 *     ZERO currently-covered codepoints, covers every BL-03 threat-class row except
 *     `U+2028`/`U+2029` (added explicitly), and additionally reaches the unassigned
 *     plane-14 remainder (`U+E0080-U+E00FF`, `U+E01F0-U+E0FFF`) that neither the shipped
 *     literal nor `\p{Cf}` reaches — coverage goes from 139 to 4176 codepoints, with zero
 *     narrowing anywhere. `\p{Cf}` would also strip the Arabic/Syriac prepended
 *     concatenation marks (`U+0600-U+0605`, `U+06DD`, `U+070F`, `U+08E2`, `U+110BD`,
 *     `U+110CD`) — legitimate formatting characters in Arabic/Syriac prose that
 *     `Default_Ignorable_Code_Point` correctly excludes. `U+FFF9-U+FFFB` (interlinear
 *     annotation anchors) are `Cf` but NOT `Default_Ignorable` — they are meant to be
 *     rendered in fallback, are not in BL-03's table, and are deliberately not added.
 *  3. ACCEPTED two behavior changes on legitimate (non-attacker) mail as a consequence of
 *     widening `INVISIBLE_CODEPOINTS_RE` to a Unicode-property-derived set: (a) bidi
 *     embedding/override/isolate controls and LRM/RLM/ALM are now stripped from
 *     legitimate right-to-left subjects/bodies, changing how such text would render in a
 *     client — but this module produces text for an LLM extractor, not for display, and
 *     Trojan-Source-class visual reordering is exactly the threat this stage exists to
 *     stop; only invisible controls are touched, letters are never touched (verified: the
 *     property matches no ASCII codepoint and no Arabic/Hebrew LETTER codepoint), and the
 *     precedent already exists in shipped code (`U+200C` ZWNJ — required for correct
 *     Persian/Devanagari rendering — has been stripped since 62-03). (b) `U+FE0F`
 *     VARIATION SELECTOR-16 is now stripped, so an emoji written with an explicit
 *     presentation selector loses it (e.g. a heart-plus-VS16 sequence renders as a bare
 *     heart) — the same class of accepted loss as the existing ZWJ stripping.
 *
 * The 62-09 source guard (tests/strip-hidden.test.ts) is UPDATED, not removed, by this
 * change: its first assertion (no bare `[^>]*`/`[^<>]*` class survives) is kept UNCHANGED
 * — true only because the shared `ATTRS` fragment's `STYLE_BLOCK_RE` close tail is built
 * from the shared ATTRS fragment, NOT the reviewer-proposed `[^>]*` tail, which would have reintroduced
 * that exact banned substring. Its second assertion (a `>= 4` count of the alternation
 * prefix) is REPLACED with single-source-of-truth counts, since the alternation now
 * appears exactly once (inside `ATTRS` itself) rather than once per regex.
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
 *      raw passthrough" contract below. NARROWED by 62-12: an unquoted `<` inside an
 *      attribute region was a SECOND, previously undocumented trigger of this same
 *      truncation (BL-01's over-removal direction) — that trigger is now closed, since
 *      `<` no longer terminates the attribute-scanning fragment, so only unbalanced
 *      quotes remain as a trigger of residual (c).
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
 * Invisible / non-rendering codepoints, derived from the Unicode `Default_Ignorable_
 * Code_Point` property (BL-03, 62-REVIEW.md/62-12-PLAN.md) rather than a hand-maintained
 * enumeration, plus two explicit extras. `Default_Ignorable_Code_Point` covers zero-width
 * chars, BOM, soft hyphen, U+180E, invisible math operators, the whole Unicode Tags block
 * (U+E0000-U+E007F — the "hidden Unicode instruction injection" carrier named in 2026
 * indirect-prompt-injection research), the Variation Selectors (U+FE00-U+FE0F) and
 * Variation Selectors Supplement (U+E0100-U+E01EF — the 2025 arbitrary-byte smuggling
 * carrier), bidi embed/override/isolate controls, LRM/RLM/ALM, the combining grapheme
 * joiner, deprecated format chars, and Hangul fillers — see the file-level doc block's
 * "62-12 gap closure" note for the full rationale, including why the reviewer's `\p{Cf}`
 * proposal was rejected (31-codepoint narrowing) and the two accepted behavior changes on
 * legitimate RTL mail and VS16-suffixed emoji. `U+2028`/`U+2029` (line/paragraph
 * separator) are added explicitly — they are NOT Default_Ignorable but are a named
 * BL-03 threat-class row (structure forgery in a header field). The property matches no
 * ASCII codepoint, so `\n`/`\t`/space are preserved (stage 8 owns whitespace) and 62-11's
 * accepted `\n`-in-header disposition is unchanged by this widening. Requires the 'u'
 * flag for the astral-plane ranges.
 */
const INVISIBLE_CODEPOINTS_RE = /[\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

// ---------------------------------------------------------------------------
// Shared tag-matching primitives (module scope; tag NAME is runtime data, so the
// forward matching-close scan cannot be precompiled per tag — it reuses these two
// fixed regexes instead of constructing a new RegExp per matched tag name)
// ---------------------------------------------------------------------------

/**
 * Shared unquoted-attribute fragment — single source of truth for all four tag-scanning
 * literals below. Per HTML section 13.2.5.36 (attribute value, unquoted state), only an
 * UNQUOTED `>` terminates a tag; an unquoted `<` inside the attribute region is a parse
 * error that the HTML tokenizer APPENDS to the attribute value, so it does NOT terminate
 * the tag. Building every tag-scanning regex from this ONE fragment means agreement
 * between them is structural, not four literals happening to carry the same character
 * class by coincidence -- a fifth literal built from the shared ATTRS fragment cannot silently diverge
 * (T-62-43, the cross-stage boundary bug class this file exists to close).
 */
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;

/**
 * Matches one HTML open tag: `<name ...>` or self-closing `<name .../>`. Attribute
 * scanning is quote-aware via the shared `ATTRS` fragment: only an UNQUOTED `<` or `>`
 * terminates the tag, since a literal `>` inside a quoted attribute value (or a CSS
 * string literal inside `style`) is legal HTML and was the CR-01 bypass (a quoted `>`
 * truncated the match before the hiding declaration was ever seen), and an unquoted `<`
 * is legal HTML per section 13.2.5.36 and was the BL-01 bypass (62-12-PLAN.md) -- 62-09
 * excluded `<` here to keep agreement with the (then-unfixed) `STYLE_BLOCK_RE`; both are
 * now built from `ATTRS` instead, so agreement is guaranteed by construction rather than
 * by two literals happening to carry the same character class.
 */
const START_TAG_RE = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b(${ATTRS})>`, 'g');

/**
 * Matches any open OR close tag token, used by the forward matching-close scan. Same
 * quote-awareness rule as `START_TAG_RE` (built from the same `ATTRS` fragment) -- only
 * an unquoted `<` or `>` ends the tag, so this stage cannot disagree with `START_TAG_RE`
 * (or, after 62-12, `STYLE_BLOCK_RE`) about where a tag ends.
 */
const ANY_TAG_TOKEN_RE = new RegExp(`<(\\/?)([a-zA-Z][a-zA-Z0-9]*)\\b${ATTRS}>`, 'g');

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
 * Matches a `<style>` open tag through to its closing tag, built from the shared `ATTRS`
 * fragment on BOTH the open tag and the close-tag tail (62-12 gap closure, BL-01/BL-02).
 *
 * OPEN TAG: quote-aware -- only an unquoted `<` or `>` terminates it, since a literal `>`
 * inside a quoted attribute value is legal HTML and was the CR-01 bypass (truncated the
 * harvested block content mid-attribute, so `RULE_RE` saw a garbage selector and no
 * hiding selector was ever recorded), and an unquoted `<` is legal HTML per section
 * 13.2.5.36 and was the BL-01 bypass -- 62-09 excluded `<` here to keep this regex's
 * open-tag boundary opinion in agreement with `START_TAG_RE`/`ANY_TAG_TOKEN_RE`, but they
 * agreed on FAILING: a class-hidden payload and the raw stylesheet both leaked into
 * `record.content`. All four tag-scanning literals now share `ATTRS`, so agreement is
 * structural rather than incidental.
 *
 * CLOSE TAG: the tail is built from the same ATTRS fragment, closing BL-02 (62-REVIEW.md) --
 * `</style foo>` and `</style/>` both legally end a `<style>` element (the RAWTEXT
 * end-tag-name state transitions to before-attribute-name on whitespace and to
 * self-closing-start-tag on `/`), and `ANY_TAG_TOKEN_RE` already accepted both; the old
 * `<\/style\s*>` tail did not, so stage 4 could delete the block while stage 2 harvested
 * nothing -- the evidence that the span was hidden was destroyed while the span's text
 * survived. The tail is deliberately built from the ATTRS fragment, NOT the simpler
 * `<\/style\b[^>]*>` a code reviewer proposed: `[^>]*` would (a) reintroduce the exact
 * substring the 62-09 source guard bans, forcing either a self-inflicted red suite or a
 * weakened guard, and (b) give the close tag a different boundary rule from
 * `ANY_TAG_TOKEN_RE` -- exactly the T-62-43 cross-stage disagreement this file exists to
 * prevent.
 */
const STYLE_BLOCK_RE = new RegExp(`<style\\b${ATTRS}>([\\s\\S]*?)<\\/style\\b${ATTRS}>`, 'gi');
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
 * Same quote-awareness rule as `START_TAG_RE`/`ANY_TAG_TOKEN_RE`/`STYLE_BLOCK_RE` — only
 * an unquoted `>` ends the tag — and, after 62-12, built from the SAME shared `ATTRS`
 * fragment as the other three. Before 62-12 this stage deliberately used a different,
 * more-permissive `[^'">]` class than the other three's `[^'"<>]` (62-07 documented the
 * asymmetry: this stage's leftover-tag sweep needed to preserve the pre-existing behavior
 * that a `<` may appear inside a stage-6 match). That asymmetry no longer exists —
 * `ATTRS` IS `[^'">]` (permitting `<`), so all four literals converge onto this stage's
 * pre-existing, already-shipped, HTML-tokenizer-faithful form; only the construction
 * changed here, not the semantics.
 */
const ANY_TAG_RE = new RegExp(`<${ATTRS}>`, 'g');

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
