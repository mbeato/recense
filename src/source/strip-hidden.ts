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
 * built-in @@replace/@@match algorithms reset lastIndex themselves). `ANY_TAG_RE` (stage 6)
 * is RegExp-constructed from a shared template-literal fragment (`ATTRS`, see below) rather
 * than written as a bare literal; it is still constructed exactly once, at module load, so
 * the compile-once invariant holds literally. `RAWTEXT_CLOSE_SLASH_RE` is a second,
 * independent dynamic construction, built from `RAWTEXT_ELEMENT_NAMES` rather than `ATTRS`
 * (see the "residual source-text checks" describe block in `tests/strip-hidden.test.ts` for
 * the exact-count guard over both).
 *
 * Stage order (load-bearing — see the block comment above each stage):
 *  0. Hoisted stray-`<` fail-safe truncation (62-14, Bound A) — runs immediately after stage
 *     1 and before stage 2; a DUPLICATE of the stage-6 truncation below, not a move of it.
 *     Still a hand-rolled regex scan — no plan in this wave set owns it.
 *  1. Invisible-codepoint removal (zero-width chars, BOM, soft hyphen, invisible math
 *     operators, the Unicode Tags block) — unconditional, applied to ALL input including
 *     plain text, and run FIRST so a payload cannot use zero-width characters to
 *     fragment a later stage's pattern match (e.g. `dis<ZWSP>play:none`). Also exported
 *     standalone as `stripInvisibleCodepoints` (CR-02) for non-markup callers — e.g.
 *     `normalizeGmailMessage`'s provenance header — that need invisible-codepoint removal
 *     WITHOUT the markup semantics of stages 2-6.
 *  1.5. `scanHtml` — ONE conformant `htmlparser2` pass over the post-stage-0/1 string,
 *     computed once and shared by stages 2, 3, 4 and 5 below (62-22 CR-10; 62-24 CR-07).
 *  2. CSS hiding-selector harvest from `<style>` blocks — BEFORE those blocks are
 *     discarded, so a `.legal{display:none}` rule is remembered even though the block
 *     carrying it is about to be deleted (stage 4). No cap on harvested selectors (62-20,
 *     CR-09 — the prior 200-selector cap failed OPEN and was deleted, not resized).
 *     `<style>` elements are located via `scanHtml().styleElements` (62-22) rather than a
 *     second, independently-maintained tag scan, so a `type="text/css" data-y="x>y"` style
 *     tag still yields its rules to the harvest, and an unterminated `<style>`'s content is
 *     harvested to end of input rather than silently dropped — and a `<style>` written
 *     inside an HTML comment can no longer be mistaken for a live element (CR-10). Block
 *     content is read as a css-tree TOKEN STREAM (62-17) — rule boundaries come from `{`/`}`
 *     tokens and selector shape from token structure, not from a comment-stripped text scan.
 *  3. HTML comment removal — `scanHtml().comments` (62-22) rather than the old
 *     comment-matching regex plus an `indexOf('<!--')` truncation fail-safe; the parser sees
 *     an unterminated comment's true extent and never mistakes RAWTEXT content (a CDO inside
 *     `<style>`) for a comment, so the fail-safe this replaced had nothing left to guard.
 *     Applied TOGETHER with stages 4/5 below, in one combined deletion pass (62-24).
 *  4. Non-content element removal (script/style/head/title/template/noscript/svg), with
 *     their contents — `scanHtml().startTags` (62-24), the same scan stages 2/3 read, rather
 *     than a second regex-driven tag/close-tag discovery.
 *  5. Hidden element removal, with contents — any start tag whose DECODED inline style
 *     matches a hiding signature, or whose DECODED class/id was harvested in stage 2, or
 *     which carries a bare `hidden` attribute / `aria-hidden="true"` (62-24: reads
 *     `scanHtml().startTags[].attrs`, an already-HTML-decoded map, not a raw source slice).
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
 * Five named residual limitations this module does NOT close (accepted, not silently
 * omitted — see 62-03-SUMMARY.md T-62-22, 62-07-SUMMARY.md for (c), 62-17-SUMMARY.md for
 * (d)/(e)):
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
 *  (d) An at-rule's contents are harvested WITHOUT evaluating the media query itself, so a
 *      `@media print` hiding rule is treated as unconditionally live (62-17). This is TODAY'S
 *      behavior, preserved deliberately, not a new gap: the hand-rolled scanner this replaced
 *      had the identical blind spot (its brace-partition scan found `selector{body}` shapes
 *      anywhere, including inside `@media`, with no awareness of the surrounding at-rule).
 *      Errs toward removing content, the module's stated safe direction.
 *  (e) A `Hash` token whose value would be an "unrestricted hash" rather than a valid `id`
 *      per CSS Syntax (e.g. `#1abc`, which cannot legally be an HTML `id` either, but IS a
 *      syntactically valid CSS hash) is harvested as an id name regardless (62-17): the plain
 *      `tokenize` callback exposes only a token's TYPE, not the id/unrestricted flag css-tree's
 *      parser layer computes internally. Reachable only when a matching `id="1abc"` attribute
 *      also exists on some element in the same document, and — like (d) — errs toward removing
 *      content rather than leaking it.
 *
 * Contract:
 *  - Pure: no side effects, no I/O, no randomness, no clock read (LLM-free online path).
 *  - Idempotent: stripHiddenContent(stripHiddenContent(x)) === stripHiddenContent(x).
 *  - Total: never throws, for any string including empty/malformed/unterminated/deeply
 *    nested input.
 *  - Monotone toward less content: for adversarial or malformed input, the output is a
 *    subset-shaped reduction of the input — never the raw input passed through.
 *
 * Changelog (62-31 gap closure, WR-05, T-62-31-03) — one line per plan that changed this
 * module's behavior; the reasoning, measurements and repros live in each plan's own
 * SUMMARY.md, not restated here. This replaces the accumulated per-plan "gap closure"
 * narrative that used to sit inline above each stage — the exact drift `62-VERIFICATION.md`
 * named as the direct mechanism of CR-01 (a justification comment describing code 62-24 had
 * already deleted). Every identifier below that no longer exists is carried in the deletion
 * registry after this list, not left as a dangling backtick reference.
 *  - 62-03: stage-1 invisible-codepoint stripping baseline (zero-width chars incl. ZWNJ
 *    U+200C).
 *  - 62-07: CR-01 quote-aware close-tag fix; established residual (c) (unbalanced quotes).
 *  - 62-09: source guard for the CR-01/BL-01/BL-02 tag-boundary bug class.
 *  - 62-12 (BL-01/BL-02/BL-03): unified the tag-scanning character class into the shared
 *    `ATTRS` fragment (permits unquoted `<`); widened `INVISIBLE_CODEPOINTS_RE` to a
 *    `Default_Ignorable_Code_Point`-derived set plus two explicit extras.
 *  - 62-13 (VF-01/NEW-01): CSS-comment stripping ahead of selector harvest (superseded
 *    62-17); RAWTEXT-aware close-tag handling for the eight raw-text elements (superseded
 *    62-24).
 *  - 62-14 (WR-02): Bound A, the hoisted stray-`<` fail-safe truncation (stage 0, still
 *    present); Bound B, a linear cursor-walk selector harvest replacing a backtracking
 *    regex (superseded 62-17).
 *  - 62-17: rewrote the CSS layer onto `css-tree/tokenizer`'s token stream; restricted this
 *    file's adopted css-tree surface to `tokenize`/`tokenTypes` only.
 *  - 62-18 (T62-91): eliminated `STYLE_BLOCK_RE`'s lazy `</style>`-tail quadratic by
 *    locating `<style>` elements via the same tag-matching primitives stage 4 used
 *    (superseded 62-22).
 *  - 62-20 (CR-05/CR-06/CR-08/CR-09): `hasHidingSignatureFromTokens`, a token-derived
 *    declaration reconstruction, replaces every raw-slice `hasHidingSignature` call; deleted
 *    the 200-selector harvest cap (failed open); evaluates an unterminated final
 *    declaration block at EOF; consumes a CRLF pair as one escape separator.
 *  - 62-21: adopted `htmlparser2@10.0.0` as this file's one conformant HTML tokenizer;
 *    named the RAWTEXT close-slash defect (D-62-21-01), recovered at the source by 62-24.
 *  - 62-22 (CR-10): `scanHtml`, one parser pass shared by stages 2 and 3, replacing two
 *    independent regex-driven scans that could disagree about a comment/`<style>` boundary.
 *  - 62-24 (CR-07): stages 4 and 5 read `scanHtml().startTags` directly instead of a second
 *    regex-driven tag walk; `neutralizeRawtextCloseDefect` recovers D-62-21-01 pre-parse;
 *    comment and element ranges are merged and deleted in one `applyRemovalRanges` call.
 *  - 62-29 (CR-01/CR-03/WR-01): `HTML_ELEMENT_DISPOSITIONS`, the one dispositioned
 *    element-name source, replacing two independently hand-maintained lists and a one-sided
 *    self-closing-`<style/>` exclusion; added the WR-01 never-applied-stylesheet-context
 *    filter.
 *  - 62-30 (CR-02): hoists the stray-`<` fail-safe truncation a second time, immediately
 *    before stage 6's sweep, closing an O(n^2) the sweep paid on a post-deletion `<`-run.
 *  - 62-31 (WR-05/WR-09/WR-10): `applyRemovalRanges` now normalizes its ranges (total sort,
 *    consumed-range skip, monotonic cursor) instead of assuming a prior stage argued the
 *    ascending/non-overlapping precondition correctly; the close-tag boundary scan
 *    (`scanHtml`'s `onclosetag`) is now quote-aware (`findUnquotedGt`); this doc block is
 *    collapsed to current-state-plus-changelog, with the guard below keeping it honest.
 *  - CR-01 stealth-regression addendum (corrects `62-24-SUMMARY.md`'s divergence table,
 *    per `62-VERIFICATION.md` pass 5's `re_verification.regressions` note): the self-closing
 *    `<style/>` shape, run through `stripHiddenContent('<style/>.legal{display:none}</style>
 *    ok<span class="legal">PAYLOAD</span>')`, produced three different outputs across this
 *    round. At base `c144c23` (before 62-24): `".legal{display:none}okPAYLOAD"` — the leak
 *    announced itself by dumping the raw stylesheet as prose. After 62-24: `"okPAYLOAD"` —
 *    the identical payload leaked, but behind clean-looking output with no CSS text to
 *    signal a problem; this is the stealth regression 62-24-SUMMARY.md's own
 *    divergence table never named. After 62-29: `"ok"` — closed. `62-24-SUMMARY.md` is a
 *    historical record and is not edited by this addendum.
 *
 * Deletion registry (62-31 gap closure, WR-05) — every identifier this file's own comments
 * still name that no longer has a definition or import in this file, with the plan that
 * removed it. The guard in `tests/strip-hidden.test.ts` resolves every backtick-quoted,
 * identifier-shaped token in this file against a definition, an import, or an entry here;
 * an entry that stops being referenced anywhere may be deleted from this list.
 *  - `STYLE_BLOCK_RE (deleted, 62-18)`
 *  - `START_TAG_RE (deleted, 62-24)`
 *  - `ANY_TAG_TOKEN_RE (deleted, 62-24)`
 *  - `RAWTEXT_CLOSE_TAIL_RE (deleted, 62-24)`
 *  - `findMatchingCloseEnd (deleted, 62-24)`
 *  - `collectRemovalRanges (deleted, 62-24)`
 *  - `RAWTEXT_ELEMENTS (deleted, 62-24)`
 *  - `VOID_ELEMENTS (deleted, 62-24)`
 *  - `RAWTEXT_CLOSE_OPENER_RE (deleted, 62-24)`
 *  - `findRawtextCloseBounds (deleted, 62-24)`
 *  - `findRawtextCloseEnd (deleted, 62-24)`
 *  - `extractAttr (deleted, 62-24)`
 *  - `STYLE_ATTR_RE (deleted, 62-24)`
 *  - `CLASS_ATTR_RE (deleted, 62-24)`
 *  - `ID_ATTR_RE (deleted, 62-24)`
 *  - `ARIA_HIDDEN_TRUE_RE (deleted, 62-24)`
 *  - `BARE_HIDDEN_ATTR_RE (deleted, 62-24)`
 *  - `stripCssComments (deleted, 62-17)`
 *  - `matchesUrlOpen (deleted, 62-17)`
 *  - `isCssWhitespaceCode (deleted, 62-17)`
 *  - `BARE_CLASS_SELECTOR_RE (deleted, 62-17)`
 *  - `BARE_ID_SELECTOR_RE (deleted, 62-17)`
 *  - `selfClosingSyntax (deleted, 62-29)`
 *  - `SELF_CLOSING_SUFFIX_RE (deleted, 62-29)`
 */

// `src/` may import ONLY `tokenize`/`tokenTypes` from the `/tokenizer` subpath (62-16's
// `src/types/css-tree-tokenizer.d.ts` declares nothing else reachable from here) — never the
// bare `css-tree` package, never its parser/lexer/walker/generator. `62-17-SUMMARY.md` records
// the adopted-vs-not-adopted surface and why; `tests/src-import-boundary.test.ts` enforces it.
import { tokenize, tokenTypes } from 'css-tree/tokenizer';
// `htmlparser2` (62-21, exact-pinned `10.0.0`) is the single conformant HTML tokenizer this
// module now shares between stage 2 (<style> location) and stage 3 (comment location) —
// `62-22-SUMMARY.md` records why one shared scan replaced two independent walks, and
// `62-21-SUMMARY.md` the parser's exact event/offset semantics this file's offset arithmetic
// is built against.
import { Parser } from 'htmlparser2';

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
// Shared tag-matching primitives (module scope)
// ---------------------------------------------------------------------------

/**
 * Shared unquoted-attribute fragment. Per HTML section 13.2.5.36 (attribute value,
 * unquoted state), only an UNQUOTED `>` terminates a tag; an unquoted `<` inside the
 * attribute region is a parse error that the HTML tokenizer APPENDS to the attribute
 * value, so it does NOT terminate the tag. 62-24 gap closure (CR-07): stage 4/5's own
 * regex-driven tag/close-tag discovery (`START_TAG_RE`, `ANY_TAG_TOKEN_RE`,
 * `RAWTEXT_CLOSE_TAIL_RE`, `findMatchingCloseEnd`, `collectRemovalRanges`, and the
 * `RAWTEXT_ELEMENTS`/`VOID_ELEMENTS`/`RAWTEXT_CLOSE_OPENER_RE` support they depended on)
 * is DELETED, not migrated — those stages now read element boundaries from
 * `scanHtml().startTags` (see `collectStartTagRemovalRanges`, near stage 4/5 below)
 * instead of re-deriving them with a second, independently-maintained scan. `ATTRS` is
 * kept: stage 6's `ANY_TAG_RE` (the leftover-tag sweep, a residual hand-rolled scanner
 * this plan does not touch) is still built from it.
 */
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;

/**
 * The same quoting rule `ATTRS` encodes (a `"..."` or `'...'` run is opaque; anything else,
 * including `<`, is plain), applied as a hand-written forward scan rather than a second
 * regex literal — 62-31 gap closure (WR-10, T-62-31-02) requires this, not a regex, so the
 * module keeps exactly one quoting opinion (`ATTRS` for regex-driven scans, this function
 * for the one caller — `scanHtml`'s `onclosetag` handler — that needs to walk forward from
 * an arbitrary offset rather than match a whole tag). Returns the index of the first
 * UNQUOTED `>` at or after `from`, or -1 if none exists before the end of input (an
 * unterminated quoted attribute value — residual (c), unbalanced quotes; the caller falls
 * back to its pre-existing `closeEnd + 1` behavior in that case).
 */
function findUnquotedGt(html: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/**
 * 62-29 gap closure (CR-01/CR-03/WR-01, T-62-29-01..T-62-29-05) — the ONE source of truth
 * this module holds about which element names are special, and in what way. Before this
 * closure, `NON_CONTENT_TAGS` (stage 4/5's deletion set) and `RAWTEXT_CLOSE_SLASH_RE` (the
 * RAWTEXT close-slash defect guard) were two independently hand-maintained lists of raw-text
 * names, and a self-closing `<style/>` was excluded from harvest by a check stage 4/5 had no
 * matching opinion on — two parts of the module holding different opinions about one
 * boundary, with the argument that they agreed living only in a comment (CR-01's and CR-03's
 * shared root cause, named six times across this phase's verification passes). Every
 * consumer below derives from `HTML_ELEMENT_DISPOSITIONS`; none restates its own copy.
 *
 * Two independent facts about how a browser treats an element, each load-bearing on its own:
 *  - `rendersText`: does a human ever see text placed directly inside this element? False
 *    means stage 4/5 deletes the element and its contents outright (`NON_CONTENT_TAGS`,
 *    derived below).
 *  - `appliesStylesheets`: would a browser apply a `<style>` written as a DESCENDANT of this
 *    element to the rest of the document? False means a `<style>` found inside this
 *    element's subtree must not be harvested by stage 2
 *    (`NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS`, derived below) — WR-01.
 */
interface ElementDisposition {
  readonly rendersText: boolean;
  readonly appliesStylesheets: boolean;
}

/**
 * The single dispositioned source. `head` and `svg` deliberately keep
 * `appliesStylesheets: true` — a browser DOES apply `<head><style>` and an inline SVG's own
 * `<style>` (SVG shares the host document's CSSOM, unlike `<iframe>`/`<noscript>`/
 * `<template>`, which do not) — both confirmed against `tests/support/html-render-oracle.ts`.
 * `style` itself keeps `appliesStylesheets: false`: the question ("would a browser apply a
 * `<style>` nested inside this element") is inert for `style` at runtime (its own body is
 * RAWTEXT, so a genuinely nested `<style>` element can never exist inside it), the same
 * "inert, not optional" reasoning that applies to `xmp` below — but it is still read off the
 * table honestly rather than special-cased away, and `harvestHidingSelectors`'s own
 * ancestor-containment check (Task 2) is the one place that must NOT treat a `<style>` tag as
 * its own ancestor container (see that function's doc comment for why).
 */
const HTML_ELEMENT_DISPOSITIONS = {
  script: { rendersText: false, appliesStylesheets: false },
  style: { rendersText: false, appliesStylesheets: false },
  head: { rendersText: false, appliesStylesheets: true },
  title: { rendersText: false, appliesStylesheets: false },
  template: { rendersText: false, appliesStylesheets: false },
  noscript: { rendersText: false, appliesStylesheets: false },
  svg: { rendersText: false, appliesStylesheets: true },
  iframe: { rendersText: false, appliesStylesheets: false },
  noembed: { rendersText: false, appliesStylesheets: false },
  noframes: { rendersText: false, appliesStylesheets: false },
  textarea: { rendersText: true, appliesStylesheets: false },
  xmp: { rendersText: true, appliesStylesheets: false },
} as const satisfies Record<string, ElementDisposition>;

/**
 * `</` + one of these 8 names + `/` is a real htmlparser2 defect (see `RAWTEXT_CLOSE_SLASH_RE`
 * below). The eight names appear as a literal list exactly ONCE, here; `RAWTEXT_CLOSE_SLASH_RE`
 * is BUILT from this array rather than restating them in a regex literal.
 */
const RAWTEXT_ELEMENT_NAMES = [
  'script', 'style', 'title', 'textarea', 'iframe', 'noembed', 'noframes', 'xmp',
] as const;

type RawtextName = (typeof RAWTEXT_ELEMENT_NAMES)[number];

/**
 * T-62-29-03 — compile-time exhaustiveness check: a name added to `RAWTEXT_ELEMENT_NAMES`
 * without a matching entry in `HTML_ELEMENT_DISPOSITIONS` fails THIS assignment to compile (a
 * required property would be missing from the right-hand side's type). Proven non-vacuous in
 * `62-29-SUMMARY.md` by adding a ninth name with no disposition and recording the verbatim
 * `tsc` error, then reverting. This check CANNOT catch a disposition flipped from `false` to
 * `true` (still compiles) — `tests/strip-hidden.test.ts`'s exact-membership guard (T-62-29-04)
 * is the other half; see that test for the injected-flip proof.
 */
const RAWTEXT_DISPOSITIONS_EXHAUSTIVE_CHECK: Record<RawtextName, ElementDisposition> =
  HTML_ELEMENT_DISPOSITIONS;

/**
 * Derives the fixed tag set stage 4/5 deletes contents for (`rendersText === false`).
 * Exported for `tests/strip-hidden.test.ts`'s exact-set-equality membership guard
 * (T-62-29-04) to import and compare against a literal expected list — NOT
 * unused-by-production; do not remove this export as dead code.
 */
export const NON_CONTENT_TAGS: ReadonlySet<string> = new Set(
  (Object.keys(HTML_ELEMENT_DISPOSITIONS) as Array<keyof typeof HTML_ELEMENT_DISPOSITIONS>).filter(
    name => !HTML_ELEMENT_DISPOSITIONS[name].rendersText
  )
);

/**
 * Derives the set of element names inside which a browser never applies a descendant
 * `<style>` (`appliesStylesheets === false`) — WR-01's fix, consumed by
 * `harvestHidingSelectors`'s ancestor-containment filter (Task 2). Exported for the SAME
 * reason as `NON_CONTENT_TAGS` above: `tests/strip-hidden.test.ts`'s exact-set-equality
 * membership guard (T-62-29-04) imports this, not a second hand-copied list.
 */
export const NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS: ReadonlySet<string> = new Set(
  (Object.keys(HTML_ELEMENT_DISPOSITIONS) as Array<keyof typeof HTML_ELEMENT_DISPOSITIONS>).filter(
    name => !HTML_ELEMENT_DISPOSITIONS[name].appliesStylesheets
  )
);

/**
 * Deletes every `[start, end)` range from `html`, preserving everything in between.
 *
 * 62-31 gap closure (WR-09, T-62-31-01): every documented caller already argues its own
 * ranges are ascending and pairwise non-overlapping (`collectStartTagRemovalRanges`'s
 * document-order/child-never-exceeds-parent argument, `mergeCommentAndElementRanges`'s
 * contained-or-disjoint argument) — but that agreement lived in each caller's OWN prose,
 * never checked here, in the one function every stage's output flows through. A caller
 * whose argument is ever wrong (a future stage, a refactor that drops the sort) would
 * silently walk the cursor BACKWARDS on a nested or out-of-order range: the pre-fix
 * function did exactly `result += html.slice(cursor, start); cursor = end;` per range with
 * no ordering check, so a nested range `[[1,8],[3,5]]` moved the cursor from 8 back to 5 and
 * the trailing `html.slice(cursor)` re-emitted characters 5-7 that the FIRST range had
 * already deleted — a content leak, not a crash, in the one function this whole module
 * funnels through.
 *
 * The precondition is now ENFORCED, not assumed: sort by start ascending, then by end
 * descending (a total order, so ties are no longer processing-order-dependent — two ranges
 * sharing a start are visited widest-first, so the narrower one is always "already
 * consumed" by the time it is reached); skip any range whose `end` does not exceed the
 * cursor already reached (fully consumed by a prior range); advance the cursor
 * monotonically to `Math.max(cursor, end)` otherwise. The cursor can now never move
 * backwards, so the trailing `html.slice(cursor)` can never re-include a character an
 * earlier range covered. Exported for `tests/strip-hidden.test.ts`'s WR-09 property
 * assertions (five fixed cases plus a 500-trial randomized check) to import directly,
 * matching this file's existing test-only export pattern (`NON_CONTENT_TAGS`, etc.) — not
 * unused-by-production; do not remove this export as dead code.
 */
export function applyRemovalRanges(html: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return html;
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let result = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) {
      if (end > cursor) cursor = end; // partial overlap: extend, emit nothing new
      continue; // fully consumed by a prior range
    }
    result += html.slice(cursor, start);
    cursor = end;
  }
  result += html.slice(cursor);
  return result;
}

// ---------------------------------------------------------------------------
// scanHtml — ONE conformant parser pass, shared by stages 2, 3, 4 and 5 (62-22/62-24)
// ---------------------------------------------------------------------------

/**
 * 62-22 gap closure (CR-10, 62-REVIEW.md) — gives the module ONE opinion about HTML
 * structure, the adopted parser's (`htmlparser2@10.0.0`, 62-21, exact-pinned), for comments
 * and `<style>` elements. Before this closure, stage 2 (`START_TAG_RE` +
 * `findRawtextCloseBounds`) and stage 3 (its own separate comment-matching regex) held two
 * INDEPENDENT opinions about where a comment and a RAWTEXT element begin and end — the T-62-43
 * cross-stage
 * boundary bug class this file exists to close (CR-01, BL-01, BL-02, NEW-01, FB-01 were all
 * prior instances; 62-18 closed it for `<style>`-vs-`<style>` by sharing one primitive
 * between stages 2 and 4). `scanHtml` closes it for `<style>`-vs-comment the only way that
 * generalizes: both stages now read the same conformant tokenizer's output. A `<style>`
 * opening tag appearing inside an HTML comment (`<!-- <style> -->`) can no longer be
 * harvested as a live stylesheet, and a real stylesheet can no longer be paired with a bogus
 * open tag, because comment-vs-element is decided ONCE, by the parser, not by two regexes
 * that happen to (dis)agree.
 *
 * `scanHtml` is a RANGE-ONLY primitive: it never serializes a parse tree, never emits text,
 * and never decodes an entity into prose. This is load-bearing, not a style choice — the
 * module's two documented contracts (idempotence; every entity except `&nbsp;`/`&#160;` is
 * left literal) both depend on `stripHiddenContent` staying a range-deleting transformer over
 * the ORIGINAL source string (see the file-level doc block's "Contract" section). A
 * parse-then-serialize design would break both (`&amp;amp;` -> `&amp;` -> `&` across two
 * passes). `HtmlStartTag.attrs` values ARE decoded (`htmlparser2`'s own `decodeEntities: true`)
 * because that decoded map is compared against, never emitted into, the output text — a
 * design 62-24 (CR-07) will consume, not this plan.
 *
 * Offset convention: `htmlparser2`'s own `parser.startIndex`/`endIndex` are an INCLUSIVE
 * `[start, end]` pair (62-21-SUMMARY.md's "Exact API Surface"), NOT the `[start, end)`
 * exclusive convention this file's OTHER primitives (`collectStartTagRemovalRanges`,
 * `applyRemovalRanges`, css-tree's own token offsets) already use. Every range this function
 * returns is converted to `[start, end)` exclusive at the point of construction — callers of
 * `scanHtml` never see an inclusive offset. `tests/html-parser-conformance.test.ts` is the
 * gate that keeps the inclusive-offset premise this conversion depends on from silently
 * drifting under a future `htmlparser2` upgrade.
 *
 * Two named residuals, each a deliberate, faithful reading of the parser's OWN behavior
 * rather than a bug this function introduces (a THIRD, `</style/>`, was accepted-not-recovered
 * through 62-22 and is now RECOVERED at the source by `neutralizeRawtextCloseDefect`, below):
 *  - `</style foo>` (D-62-21-01): the close tag's own reported end is truncated before the
 *    real `>`; a forward `indexOf('>', ...)` scan from the truncated offset recovers the true
 *    boundary (a no-op, not just a correction, on a well-formed close tag, which already sits
 *    on its own `>`).
 *  - The empty bogus comment `<!>` fires NEITHER `oncomment` NOR `onprocessinginstruction`
 *    (62-21-SUMMARY.md: "a genuine gap... no offset information at all") -- accepted, not
 *    recovered, matching 62-21's own disposition. An empty bogus comment carries no content,
 *    so it cannot hide a `<style>` open tag inside it (CR-10's threat shape needs comment
 *    DATA, which `<!>` has none of).
 *
 * A DOCTYPE declaration (`<!DOCTYPE html>`) and an HTML-bogus-comment-shaped `<?...?>` both
 * route through `onprocessinginstruction` in htmlparser2, same as a `<!x>` bogus comment --
 * HTML §13.2.5.1 sends `<?` to the SAME bogus-comment state a doctype's malformed sibling
 * would reach. Both are included in `comments` alongside real `<!--...-->` comments and `<!x>`
 * bogus comments: deleting a DOCTYPE is inert (no leak; email body fragments essentially never
 * carry one), and folding it in keeps `scanHtml`'s mental model to one rule -- "every
 * `oncomment` and `onprocessinginstruction` event is a comment range" -- rather than a
 * doctype-shaped carve-out with no threat-model justification.
 */
export interface HtmlComment {
  /** Index of the comment's first character (`<`, [start, end) over the input). */
  readonly start: number;
  /** Index just past the comment's last character. */
  readonly end: number;
}

export interface HtmlStyleElement {
  /** Index just past the `<style ...>` open tag -- where the element's RAWTEXT content begins. */
  readonly contentStart: number;
  /** Index of the `<` that opens the matching (or EOF-implied) close tag. */
  readonly contentEnd: number;
  /** Index just past the whole element, including its close tag (or `html.length`). */
  readonly elementEnd: number;
}

export interface HtmlStartTag {
  /** Lowercased tag name. */
  name: string;
  /** Lowercased attribute name -> DECODED value (CR-07, wired in 62-24). */
  attrs: ReadonlyMap<string, string>;
  /** Index of the tag's own `<`. */
  readonly tagStart: number;
  /** Index just past the tag's own `>`. */
  readonly tagEnd: number;
  /** Index just past the element's end, including its close tag (or `html.length`). Mutated
   *  once, when the matching close event fires -- see `scanHtml`'s own body. */
  elementEnd: number;
}

export interface HtmlScan {
  readonly comments: readonly HtmlComment[];
  readonly styleElements: readonly HtmlStyleElement[];
  readonly startTags: readonly HtmlStartTag[];
}

/**
 * `</` + one of these 8 names + `/` (RAWTEXT_CLOSE_SLASH_RE below) is a real htmlparser2 defect
 * (D-62-21-01, 62-21-SUMMARY.md, widened 62-24): the RAWTEXT tokenizer only recognizes an
 * "appropriate end tag" when the character immediately after the tag NAME is whitespace, `>`,
 * or EOF -- `/` fails that check (verified directly against htmlparser2@10.0.0: `</style
 * foo>`/`</style >` close correctly, `</style/>`/`</style/ >` do not), so the tokenizer
 * swallows everything from there to EOF as RAWTEXT content -- including any REAL tags after
 * it (a `<span class="legal">`, say) -- rather than closing the element and resuming ordinary
 * tokenization. 62-21/62-22 accepted this as a named, NOT-recovered residual, because at the
 * time the only consumer of the boundary (stage 2's harvest) treats over-inclusion as harmless
 * (more selectors harvested, never fewer). 62-24 makes the SAME boundary load-bearing for
 * REMOVAL (stage 4/5, `collectStartTagRemovalRanges`) AND for start-tag DISCOVERY (a `<span>`
 * hidden behind a missed close must still be found), where the identical residual would both
 * delete real, visible prose after a `</style/>`-shaped close (a regression of the BL-02 lock,
 * 62-13) AND make a genuinely hidden element behind it invisible to `scan.startTags` entirely.
 *
 * 62-29 gap closure (CR-03, T-62-29-02/T-62-29-03): BUILT from `RAWTEXT_ELEMENT_NAMES` above
 * rather than restating the eight names in a second regex literal — `NON_CONTENT_TAGS` used to
 * be a DIFFERENT hand-maintained seven that omitted `iframe`/`noembed`/`noframes` (CR-03); both
 * now derive from the same `HTML_ELEMENT_DISPOSITIONS` source, so they cannot silently diverge
 * again.
 */
const RAWTEXT_CLOSE_SLASH_RE = new RegExp(`</(${RAWTEXT_ELEMENT_NAMES.join('|')})/`, 'gi');

/**
 * SAME-LENGTH, pre-parse neutralization of `RAWTEXT_CLOSE_SLASH_RE`'s trigger: replaces the
 * offending `/` with an ASCII space, which htmlparser2 (and a real browser) both treat
 * identically to any other RAWTEXT-close-tag-name-terminating whitespace. Because the
 * replacement is the SAME LENGTH as the match, every OTHER character's offset is unchanged, so
 * the sanitized string can be fed to the ONE `Parser` this file constructs without perturbing
 * any offset `scanHtml` reports. This is pre-conditioning of htmlparser2's OWN INPUT, not a
 * second scanner: it corrects the dependency's known gap once, ahead of parsing, so its own
 * event stream stays the sole source of truth for every stage that reads `scanHtml`'s result --
 * unlike a post-hoc numeric `elementEnd` correction (rejected: it cannot resurrect tags
 * htmlparser2 already decided were RAWTEXT text and never tokenized at all).
 */
function neutralizeRawtextCloseDefect(html: string): string {
  if (html.indexOf('/') === -1) return html; // fast path: nothing this regex could match
  return html.replace(RAWTEXT_CLOSE_SLASH_RE, '</$1 ');
}

/**
 * T-62-22-02: a parser-internal error (a future `htmlparser2` regression, not observed today --
 * Block 3 of `tests/html-parser-conformance.test.ts` measures 0/20,000 throws) must never
 * degrade to an EMPTY scan. An empty scan reads as "no comments, no style elements anywhere in
 * this document" -- FAIL-OPEN, and this module's one hard invariant is that a failure mode
 * never leaks more than the happy path would. This is the opposite: one comment spanning the
 * entire input (stage 3 deletes everything) and one style element whose content is the entire
 * input (stage 2 harvests from the whole document as if it were one stylesheet) -- the
 * maximally-REDUCING scan, matching "monotone toward less content, never raw passthrough."
 */
function maximallyReducingScan(html: string): HtmlScan {
  return {
    comments: [{ start: 0, end: html.length }],
    styleElements: [{ contentStart: 0, contentEnd: html.length, elementEnd: html.length }],
    startTags: [],
  };
}

/**
 * Runs `htmlparser2`'s low-level `Parser` ONCE over `html` (no rescanning -- the cost table in
 * this file's `MAX_STRIP_INPUT_CODE_UNITS` re-derivation, `gmail-adapter.ts` §3, is what proves
 * this stays bounded) and returns the `HtmlScan` shape documented above. See that doc block for
 * the offset-conversion rule, the two named residuals, and the DOCTYPE/bogus-comment folding
 * decision.
 */
export function scanHtml(html: string): HtmlScan {
  const comments: HtmlComment[] = [];
  const styleElements: HtmlStyleElement[] = [];
  const startTags: HtmlStartTag[] = [];

  // 62-29 gap closure (CR-01): the stack now holds `HtmlStartTag` records directly, not a
  // wrapper frame carrying a self-closing flag. A self-closing `<style/>` start tag no
  // longer gets a divergent, stage-2-only opinion about whether the element exists --
  // stage 2 and stage 4/5 now agree BY CONSTRUCTION because neither has a self-closing
  // exception left to hold.
  const stack: HtmlStartTag[] = [];

  const recordComment = (start: number, end: number): void => {
    comments.push({ start, end: Math.min(end, html.length) });
  };

  try {
    let parser: Parser;
    const handler = {
      onopentag(name: string, attribs: Record<string, string>): void {
        const tagStart = parser.startIndex;
        const tagEnd = parser.endIndex + 1;
        const attrs = new Map<string, string>();
        for (const key of Object.keys(attribs)) {
          attrs.set(key.toLowerCase(), attribs[key]!);
        }
        const record: HtmlStartTag = { name, attrs, tagStart, tagEnd, elementEnd: tagEnd };
        startTags.push(record); // document order -- pushed at OPEN, mutated at CLOSE below
        stack.push(record);
      },
      onclosetag(_name: string, isImplied: boolean): void {
        const record = stack.pop();
        if (!record) return; // defensive; htmlparser2's own tree construction keeps this balanced
        const closeStart = parser.startIndex;
        const closeEnd = parser.endIndex;
        let elementEnd: number;
        if (!isImplied) {
          // D-62-21-01: the RAWTEXT close tag's OWN reported end may be truncated before the
          // real `>` (`</style foo>`). Forward-scan for it -- a no-op on a well-formed close
          // tag, which is already sitting on its own `>`. `neutralizeRawtextCloseDefect`
          // (called on `parser.write`'s input below) means a `</style/>`-shaped close now
          // ALSO reaches this branch instead of the EOF-implied one.
          //
          // 62-31 gap closure (WR-10, T-62-31-02): this scan is now QUOTE-AWARE
          // (`findUnquotedGt`, same rule `ATTRS` encodes), not a bare `html.indexOf('>', ...)`.
          // htmlparser2 does not itself apply attribute-quoting rules to a close tag's bogus
          // trailing content, so its OWN reported `closeEnd` can already sit before a
          // sender-controlled quoted value containing a literal `>` (`</div foo="a>b">tail`);
          // a bare `indexOf` from that offset finds the IN-QUOTE `>` first and stops there,
          // leaking `b">tail` into `record.content` even though the module's own "every
          // remaining tag is removed" contract says that cannot happen. Falls back to the
          // pre-existing `closeEnd + 1` behavior when no unquoted `>` exists before EOF --
          // named residual (c) (unbalanced quotes), unchanged by this fix.
          const realGt = findUnquotedGt(html, closeEnd);
          elementEnd = realGt === -1 ? closeEnd + 1 : realGt + 1;
        } else if (closeStart < record.tagEnd) {
          // Synthetic close ECHOING the open tag's own position (a void element, or a
          // self-closing void like `<br/>`) -- there is no separate close location; the
          // element's range is exactly its own open tag.
          elementEnd = record.tagEnd;
        } else {
          // EOF-implied, or an ancestor's close tag triggered an implied close: the element's
          // content runs up to (never including) the position the synthetic close was
          // recognized at -- `html.length` for EOF, or the ancestor's own close-tag start.
          elementEnd = closeStart;
        }
        record.elementEnd = elementEnd;

        if (record.name === 'style') {
          // 62-29 gap closure (CR-01): a self-closing `<style/>` start tag is a spec-correct
          // no-op on a non-void element (HTML §13.2.5, tests/html-parser-conformance.test.ts:283)
          // -- it opens the element normally, so it is harvested here exactly like any other
          // `<style>`, closing the one-sided exclusion that let stage 4/5 delete the element
          // while stage 2 refused to harvest it (the stylesheet vanished; the elements it hid
          // did not).
          styleElements.push({
            contentStart: record.tagEnd,
            contentEnd: Math.min(closeStart, html.length),
            elementEnd: Math.min(elementEnd, html.length),
          });
        }
      },
      oncomment(): void {
        recordComment(parser.startIndex, parser.endIndex + 1);
      },
      onprocessinginstruction(): void {
        // A bogus comment (`<!x>`, `<?xml?>`) or a DOCTYPE -- see this section's doc block for
        // why all three are folded into `comments` uniformly.
        recordComment(parser.startIndex, parser.endIndex + 1);
      },
    };
    parser = new Parser(handler, { decodeEntities: true });
    // 62-24 gap closure: feed the RAWTEXT-close-defect-neutralized copy to the parser, not
    // `html` itself -- see `neutralizeRawtextCloseDefect`'s own doc comment. Every offset
    // this handler reads (`parser.startIndex`/`endIndex`, `html.indexOf('>', closeEnd)`
    // above) stays valid against the ORIGINAL `html` because the substitution is same-length.
    parser.write(neutralizeRawtextCloseDefect(html));
    parser.end();
  } catch {
    return maximallyReducingScan(html);
  }

  // Defensive drain: htmlparser2 always emits a synthetic EOF close for every still-open
  // element (verified directly -- a multiply-nested unclosed input drains the whole stack at
  // EOF, one isImplied close per frame), so this loop is not expected to run. Kept so a future
  // htmlparser2 behavior change cannot silently leave `elementEnd` at its `tagEnd` placeholder.
  for (const record of stack) {
    record.elementEnd = html.length;
    if (record.name === 'style') {
      styleElements.push({
        contentStart: record.tagEnd,
        contentEnd: html.length,
        elementEnd: html.length,
      });
    }
  }

  return { comments, styleElements, startTags };
}

// ---------------------------------------------------------------------------
// Stage 2 — CSS hiding-selector harvest (before <style> blocks are discarded)
// ---------------------------------------------------------------------------

// `<style>` elements are located via `scanHtml().styleElements` (see `scanHtml`'s own doc
// block, above), computed once and shared with stage 3 — not a second, independently
// maintained tag scan. See `harvestHidingSelectors`'s own doc comment below for the boundary
// decisions this inherits from `scanHtml` (see the file-level doc block's changelog for the
// plans that established and later superseded the mechanisms this stage no longer uses).

// CR-09 (62-REVIEW.md, closed by 62-20): the prior hard cap of 200 on the number of harvested
// class/id hiding selectors is DELETED, not re-sized. Its own doc comment ("so a pathological
// stylesheet cannot cause quadratic work") named a quadratic 62-18 already deleted; its only
// remaining OBSERVABLE effect was a fail-open bypass: every check on the cap was a
// `return`/`break`/`continue` that abandoned further harvesting and proceeded to strip with a
// knowingly-incomplete hidden-set, so 250 attacker-authored `.fN{display:none}` rules could
// starve out a real `.legal{display:none}` and leak the payload behind it (CR-09's own
// reproduced payload). The real bound on harvest cost is the caller's 1 MiB
// `MAX_STRIP_INPUT_CODE_UNITS` (`gmail-adapter.ts`), and 62-18 already established the token
// walk is linear regardless of brace shape — the cap no longer bought anything, and its
// deletion was verified in-plan to stay well under the 1000 ms / 1 MiB budget (see this file's
// 62-20-SUMMARY.md for the measurement table).

/**
 * `stripCssComments`'s naive `.replace()` fix and its follow-up string-aware-but-quadratic
 * regex fix were both measured and rejected during 62-13/62-14 — see 62-13-SUMMARY.md for the
 * two measured leak shapes and 62-14-SUMMARY.md for the quadratic-cost measurement. Comment
 * skipping is now structural (62-17): `Comment` tokens are simply never appended to a prelude
 * (see `harvestFromStylesheet` below), so neither rejected form's failure mode is reachable.
 */

/**
 * The eleven css-tree token type NUMBERS this harvest depends on, resolved from `tokenTypes`
 * ONCE at module load rather than compared by name in the hot loop (62-17; extended 62-20 with
 * `Function`/`Url` for the token-derived declaration signature, see `hasHidingSignatureFromTokens`
 * below). Resolving through a helper that throws on an unknown name means a future css-tree
 * upgrade that renames or removes one of these types fails LOUDLY at import time, rather than
 * silently mis-classifying every token of that kind as "none of the above" and quietly
 * under-harvesting.
 */
function requireTokenType(name: string): number {
  const type = tokenTypes[name];
  if (type === undefined) {
    throw new Error(
      `strip-hidden.ts: css-tree/tokenizer has no token type named "${name}" -- a css-tree ` +
        "upgrade likely renamed or removed it, and this module's CSS harvest depends on the name."
    );
  }
  return type;
}

const TT_COMMENT = requireTokenType('Comment');
const TT_WHITESPACE = requireTokenType('WhiteSpace');
const TT_DELIM = requireTokenType('Delim');
const TT_IDENT = requireTokenType('Ident');
const TT_HASH = requireTokenType('Hash');
const TT_COMMA = requireTokenType('Comma');
const TT_LEFT_CURLY = requireTokenType('LeftCurlyBracket');
const TT_RIGHT_CURLY = requireTokenType('RightCurlyBracket');
const TT_AT_KEYWORD = requireTokenType('AtKeyword');
const TT_FUNCTION = requireTokenType('Function');
const TT_URL = requireTokenType('Url');

/** One prelude token, captured as a `[type, start, end]` triple into the `css` string. */
type PreludeToken = readonly [type: number, start: number, end: number];

/** True for the five CSS whitespace code points (space, tab, LF, CR, FF) — matches css-tree's
 * own `WhiteSpace` token category, and (verified directly against `css-tree`'s `ident.decode`
 * during planning) that a hex escape's optional trailing separator is consumed for all five
 * single code units, not just space/tab/LF.
 *
 * CORRECTED 62-20 (CR-08, 62-REVIEW.md): the ORIGINAL version of this comment additionally
 * claimed the check was "verified ... for all five whitespace code points" without qualifying
 * that the verification covered only ONE-code-unit separators. It did not cover the
 * TWO-code-unit CRLF case — a CR immediately followed by LF is, per CSS Syntax §3.3, ONE
 * preprocessed whitespace code point (CR/CRLF/FF are folded to a single LF before
 * tokenization), and must be consumed as a pair. `decodeIdentEscapes`'s caller now consumes a
 * CRLF pair as one separator explicitly (see the `isCr` branch there) — this function still
 * only classifies a SINGLE code unit, unchanged. */
function isEscapeSeparatorCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function isHexDigitCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/**
 * Decodes a CSS identifier/hash name per CSS Syntax Level 3 §4.3.7 ("consume an escaped code
 * point"), applied to the RAW (still-escaped) text css-tree's tokenizer captured for an
 * `Ident` or `Hash` token — e.g. the 8-character string `leg\61 l`, not `legal`. Decoding is
 * MANDATORY, not cosmetic. CORRECTED 62-24 (CR-07, 62-REVIEW.md): the ORIGINAL version of
 * this comment asserted the class/id ATTRIBUTE side is "compared literally against an
 * unescaped HTML attribute value" — that premise was false. A browser decides "is this
 * element hidden?" in two ordered layers, and this file now implements both, in that
 * order: layer 1 (HTML) tokenizes the start tag and decodes character references in each
 * attribute value — owned by `scanHtml`'s `HtmlStartTag.attrs`, an already-HTML-decoded
 * map (62-22/62-24); layer 2 (CSS) tokenizes the resulting value/selector text and
 * decodes ident escapes — owned by THIS function (`decodeIdentEscapes`) and
 * `hasHidingSignatureFromTokens` below. The attribute side was never comparing against
 * raw HTML text; it now decodes at the HTML layer BEFORE this function's CSS-layer decode
 * ever runs, so an entity-encoded attribute value (`class="leg&#97;l"`) and a
 * backslash-escaped selector name (`.leg\61 l`) both reach the SAME decoded string. Before
 * this correction, an undecoded harvested name could never equal a name a browser
 * matches — exactly the defect the 62-16 liveness oracle found and no report had filed
 * (`BARE_CLASS_SELECTOR_RE`/`BARE_ID_SELECTOR_RE` categorically rejected any selector text
 * containing a backslash, so an escaped selector was never even a harvest CANDIDATE,
 * regardless of what it decoded to).
 *
 * Returns `raw` unchanged and unallocated when it contains no backslash (the common case), so
 * the fast path costs one `indexOf`.
 *
 * A backslash followed by 1-6 hex digits, optionally followed by ONE trailing whitespace code
 * point (consumed as part of the escape, not part of the name), decodes to that code point —
 * except when the value is zero, a UTF-16 surrogate, or greater than the maximum code point
 * (U+10FFFF), which the spec maps to U+FFFD (REPLACEMENT CHARACTER). A backslash followed by
 * any other code point decodes to that code point literally. A backslash at the end of input
 * (no following code point) decodes to U+FFFD per the spec's EOF case.
 */
function decodeIdentEscapes(raw: string): string {
  if (raw.indexOf('\\') === -1) return raw;
  const n = raw.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const code = raw.charCodeAt(i);
    if (code !== 0x5c /* \ */) {
      const cp = raw.codePointAt(i)!;
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    i += 1; // consume the backslash
    if (i >= n) {
      out += '\uFFFD'; // trailing backslash at EOF (§4.3.7 EOF case)
      break;
    }
    if (isHexDigitCode(raw.charCodeAt(i))) {
      let hex = '';
      let digits = 0;
      while (i < n && digits < 6 && isHexDigitCode(raw.charCodeAt(i))) {
        hex += raw[i];
        i += 1;
        digits += 1;
      }
      if (i < n && isEscapeSeparatorCode(raw.charCodeAt(i))) {
        const isCr = raw.charCodeAt(i) === 0x0d;
        i += 1; // one trailing whitespace code point is part of the escape, not the name
        // CR-08 (62-REVIEW.md): per CSS Syntax §3.3, CR / CRLF / FF are preprocessed to a
        // single LF BEFORE tokenization, so a CRLF following a hex escape is ONE whitespace
        // code point, consumed whole — not just the CR, leaving the LF stranded in the name.
        if (isCr && i < n && raw.charCodeAt(i) === 0x0a) i += 1;
      }
      const codePoint = parseInt(hex, 16);
      const outOfRange =
        codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
      out += outOfRange ? '\uFFFD' : String.fromCodePoint(codePoint);
      continue;
    }
    const cp = raw.codePointAt(i)!;
    out += String.fromCodePoint(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

interface BareSelector {
  readonly kind: 'class' | 'id';
  readonly name: string;
}

/**
 * Decides whether `prelude` (the token triples collected before a declaration block's `{`) is
 * a comma-separated list of BARE `.class` / `#id` selectors only — no combinators,
 * pseudo-classes, attribute selectors, type selectors, or element-qualified classes. Splits on
 * `Comma` tokens; per group, drops `WhiteSpace` tokens and requires EXACTLY one of two token
 * shapes: a `Delim` whose single source character is `.` immediately followed by an `Ident`,
 * or a lone `Hash`. Any other shape makes the WHOLE rule non-bare (returns `null`), matching
 * this module's pre-62-17 all-selectors-bare semantics — reproduced here on
 * TOKEN STRUCTURE instead of a character-class regex over reconstructed text, which is why
 * `BARE_CLASS_SELECTOR_RE`/`BARE_ID_SELECTOR_RE` are gone: the token shape IS the check, so a
 * comment or function token that used to get glued onto reconstructed text (VF-01, CR-04)
 * cannot fool it — there is no reconstructed text to glue onto.
 *
 * An empty comma-separated entry (a stray leading/trailing/doubled comma) is DROPPED, not
 * treated as a shape failure — matching the pre-62-17 `.split(',').filter(Boolean)` behavior.
 * An empty prelude, or a prelude whose every entry was empty, yields `null` (nothing to
 * harvest), matching the pre-62-17 `selectors.length === 0` skip.
 */
function preludeToBareSelectors(
  css: string,
  prelude: readonly PreludeToken[]
): BareSelector[] | null {
  const groups: PreludeToken[][] = [[]];
  for (const token of prelude) {
    if (token[0] === TT_COMMA) groups.push([]);
    else groups[groups.length - 1]!.push(token);
  }

  const result: BareSelector[] = [];
  for (const group of groups) {
    const tokens = group.filter(([type]) => type !== TT_WHITESPACE);
    if (tokens.length === 0) continue;

    if (tokens.length === 1 && tokens[0]![0] === TT_HASH) {
      const [, start, end] = tokens[0]!;
      const raw = css.slice(start + 1, end); // strip the leading '#'
      result.push({ kind: 'id', name: decodeIdentEscapes(raw) });
      continue;
    }

    if (
      tokens.length === 2 &&
      tokens[0]![0] === TT_DELIM &&
      css.slice(tokens[0]![1], tokens[0]![2]) === '.' &&
      tokens[1]![0] === TT_IDENT
    ) {
      const [, start, end] = tokens[1]!;
      const raw = css.slice(start, end);
      result.push({ kind: 'class', name: decodeIdentEscapes(raw) });
      continue;
    }

    return null;
  }

  return result.length === 0 ? null : result;
}

/**
 * Single-pass token-stream walk over one `<style>` block's content (62-17), replacing the
 * hand-rolled `stripCssComments` + brace-partition cursor scan entirely. Maintains an explicit
 * frame stack so rule boundaries come from `{`/`}` TOKENS — a `BadString`, `Url`/`BadUrl`, or
 * `Function` token cannot forge or swallow a brace, closing the raw-text-brace-counting
 * mechanism CR-04 (a fake `url(` span) and FB-01 (a raw-newline-broken string) both probed.
 *
 * Prelude (selector) tokens are collected only while "collecting" is true: at the top level of
 * the stylesheet, or one level inside a conditional-group at-rule (`@media`, `@supports`, ...)
 * whose contents are themselves rules — this is what preserves today's `@media` harvest (a
 * `.legal{display:none}` nested inside `@media screen {...}` is still found). The first time a
 * `{` is reached while collecting, the just-collected prelude decides the new frame's kind:
 * starts with an `AtKeyword` (skipping leading whitespace) -> conditional group, so collecting
 * continues for its children; otherwise -> an ordinary declaration block, whose prelude is the
 * pending selector list and whose content is evaluated against `hasHidingSignature` when its
 * matching `}` is reached. `Comment` tokens are skipped entirely during collection — never
 * appended to a prelude, so a comment adjacent to a selector (VF-01) cannot poison it the way
 * string-glued reconstructed text could.
 *
 * Collecting is SUSPENDED for the entire body of a declaration block — matches this plan's
 * `reclassify` disposition (depth-0-only prelude collection; see `62-17-PLAN.md`'s SCOPE
 * CORRECTION note). A nested `{`/`}` pair inside a declaration block (invalid CSS, but must not
 * desync the walk) is still pushed/popped for brace-balance bookkeeping, but its prelude is
 * never evaluated (`hasPrelude: false`) — this is exactly the mechanism that keeps FB-01's
 * `.legal{...}` un-harvested: it sits at depth 1 inside `.a`'s still-open (never closed by a
 * real `}`) block, so the frame that would evaluate it as a selector is never reached.
 *
 * A frame's declaration content is evaluated by `evaluateFrame` below, a single local function
 * shared by BOTH the `}` branch and the EOF drain that follows the `tokenize` call — two copies
 * of that logic is exactly the T-62-43 cross-boundary shape this phase keeps re-filing, so
 * factoring it out means the two paths cannot diverge (CR-06, 62-REVIEW.md). Its declaration
 * text is fed to `hasHidingSignatureFromTokens` (CR-05), a token-derived reconstruction, never
 * `css.slice(...)` handed straight to `hasHidingSignature`. The pre-62-20 cap on harvested
 * selectors was DELETED (CR-09; see its own doc comment above the stage-2 section for why): a
 * stylesheet with 250+ hiding rules is harvested in full rather than abandoning the scan and
 * stripping with a knowingly-incomplete hidden-set.
 *
 * CR-06 (62-REVIEW.md): per CSS Syntax (consume-a-simple-block, EOF case), an unterminated
 * block is closed at EOF and its declarations apply — css-tree's parser agrees. Before this
 * closure, a frame was evaluated ONLY when a `RightCurlyBracket` token popped it, so a
 * stylesheet whose last block is unterminated silently dropped every hiding rule in it. The
 * drain below (after `tokenize` returns) evaluates each frame still on the stack exactly as the
 * `}` branch would, with the frame's content running to `css.length` — the faithful outcome per
 * §4.3, not an over-reach (this module already harvests an unterminated `<style>` ELEMENT to
 * EOF for the identical reason, 62-18's T62-91).
 */
function harvestFromStylesheet(css: string, classes: Set<string>, ids: Set<string>): void {
  interface Frame {
    readonly isAtRule: boolean;
    readonly hasPrelude: boolean;
    readonly preludeTokens: readonly PreludeToken[];
    readonly contentStart: number;
  }
  const EMPTY_PRELUDE: readonly PreludeToken[] = [];
  const stack: Frame[] = [];
  let prelude: PreludeToken[] = [];

  const startsWithAtKeyword = (tokens: readonly PreludeToken[]): boolean => {
    for (const [type] of tokens) {
      if (type === TT_WHITESPACE) continue;
      return type === TT_AT_KEYWORD;
    }
    return false;
  };

  // Shared evaluate-and-add path — the ONLY place a frame's declaration content is checked
  // against the hiding-signature registry and its bare selectors added to the harvest. Used by
  // both the `}` branch (closingOffset = the `}` token's `start`) and the post-tokenize EOF
  // drain (closingOffset = `css.length`), so the two can never disagree about what "closing" a
  // block means (CR-06).
  const evaluateFrame = (frame: Frame, closingOffset: number): void => {
    if (!frame.hasPrelude) return;
    const contentStart = Math.min(frame.contentStart, css.length);
    const contentEnd = Math.min(closingOffset, css.length);
    const declarationSlice = css.slice(contentStart, contentEnd);
    if (!hasHidingSignatureFromTokens(declarationSlice)) return;
    const bareSelectors = preludeToBareSelectors(css, frame.preludeTokens);
    if (!bareSelectors) return;
    for (const sel of bareSelectors) {
      if (sel.kind === 'class') classes.add(sel.name);
      else ids.add(sel.name);
    }
  };

  tokenize(css, (type, start, end) => {
    if (type === TT_COMMENT) return;

    if (type === TT_LEFT_CURLY) {
      const collecting = stack.length === 0 || stack[stack.length - 1]!.isAtRule;
      const isAtRule = collecting && startsWithAtKeyword(prelude);
      const hasPrelude = collecting && !isAtRule;
      stack.push({
        isAtRule,
        hasPrelude,
        preludeTokens: hasPrelude ? prelude : EMPTY_PRELUDE,
        contentStart: end,
      });
      prelude = [];
      return;
    }

    if (type === TT_RIGHT_CURLY) {
      const frame = stack.pop();
      prelude = [];
      if (frame) evaluateFrame(frame, start);
      return;
    }

    const collecting = stack.length === 0 || stack[stack.length - 1]!.isAtRule;
    if (collecting) prelude.push([type, start, end]);
  });

  // CR-06: EOF closes every still-open block (CSS Syntax: consume-a-simple-block, EOF case).
  // Drained in LIFO pop order — the order frames close does not affect the RESULT (each frame's
  // hiding-selector contribution is independent of every other frame's), only bookkeeping, so
  // draining innermost-first is safe.
  while (stack.length > 0) {
    const frame = stack.pop()!;
    evaluateFrame(frame, css.length);
  }
}

/**
 * Harvests bare `.class`/`#id` selectors (no combinators, pseudo-selectors, attribute
 * selectors, or type-qualified compounds — those shapes simply fail `preludeToBareSelectors`,
 * which also excludes `@media`'s OWN prelude, a media query rather than a selector) whose rule
 * body matches a hiding signature (stage 5's `hasHidingSignature`). The realistic ATS shape
 * hides a span by class, not by inline style, so simply deleting the `<style>` block (stage 4)
 * would destroy the evidence that the span is hidden while leaving its text behind.
 *
 * Each `<style>` element's boundaries come from `scanHtml().styleElements` (see `scanHtml`'s
 * own doc block, above the Stage 2 header) — computed once per `stripHiddenContent` call and
 * shared with stage 3, so a `<style>` open tag written inside an HTML comment can never be
 * mistaken for a live element (there is no second, independently-maintained scan left to
 * disagree with the parser). Two boundary properties this inherits from `scanHtml`, both load
 * -bearing:
 *  - OPEN TAG: quote-aware, only an unquoted `<` or `>` terminates it — a literal `>` inside a
 *    quoted attribute value and an unquoted `<` per HTML §13.2.5.36 are both legal HTML that
 *    must not truncate the tag early.
 *  - CLOSE TAG: `</style foo>` and `</style/>` both legally end a `<style>` element (the
 *    RAWTEXT end-tag-name state transitions to before-attribute-name on whitespace and to
 *    self-closing-start-tag on `/`) — see `scanHtml`'s own `onclosetag` handler for the
 *    D-62-21-01 recovery this depends on. A self-closing `<style/>` opens the element
 *    normally (HTML §13.2.5, a spec-correct no-op on a non-void element) and is harvested
 *    like any other `<style>` — see `HTML_ELEMENT_DISPOSITIONS` and `scanHtml`'s `onclosetag`
 *    handler.
 *
 * An UNTERMINATED `<style>` (no matching `</style...>` anywhere at or after the open tag) is
 * harvested to end of input, per HTML §13.2.5: a browser applies an unterminated `<style>`
 * block's rules too, so harvesting the element's content to EOF is the faithful outcome, not
 * an over-reach.
 *
 * Block content is read as a css-tree TOKEN STREAM (`harvestFromStylesheet`), reading rule
 * boundaries from `{`/`}` TOKENS rather than raw-text brace counting: a `{`/`}` TOKEN cannot
 * be forged by a `BadString`, `Url`/`BadUrl`, or `Function` token — a raw-text brace-counting
 * scan CAN be desynchronized by a bad string, which is exactly the class of bug this design
 * closes structurally rather than by patching a specific repro. See `harvestFromStylesheet`'s
 * own doc comment for the frame-stack argument, and `preludeToBareSelectors`'s for the
 * selector-shape argument.
 */
function harvestHidingSelectors(
  html: string,
  styleElements: readonly HtmlStyleElement[]
): { classes: Set<string>; ids: Set<string> } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  for (const el of styleElements) {
    harvestFromStylesheet(html.slice(el.contentStart, el.contentEnd), classes, ids);
  }
  return { classes, ids };
}

/**
 * 62-29 gap closure (WR-01): filters `styleElements` down to those NOT nested inside an
 * element in `NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS` — a browser never applies a
 * stylesheet written as a descendant of e.g. `<iframe>`/`<noscript>`/`<template>`, so
 * harvesting one anyway deletes visible prose OUTSIDE the container that never should
 * have been hidden.
 *
 * Reuses `collectStartTagRemovalRanges` (stage 4/5's own primitive) to compute the
 * never-applied ANCESTOR ranges — no second walk, no second notion of an element range.
 * `style` is EXCLUDED from the predicate here even though
 * `HTML_ELEMENT_DISPOSITIONS.style.appliesStylesheets` is `false`: that disposition
 * answers "would a browser apply a `<style>` nested INSIDE another `<style>`" (inert — a
 * `<style>` element's own body is RAWTEXT, so a genuinely nested `<style>` can never
 * exist), never "is a `<style>` element its own ancestor container." Without this
 * exclusion, `collectStartTagRemovalRanges` would push a range for every MATCHING tag
 * including `<style>` itself, and a plain `<style>` element's own `contentStart` always
 * lies inside its OWN `[tagStart, elementEnd)` range — every `<style>` element, including
 * the ordinary top-level control, would spuriously self-exclude from harvest.
 *
 * Both `neverAppliedAncestorRanges` (`collectStartTagRemovalRanges`'s own documented
 * contract) and `styleElements` (pushed by `scanHtml` in document order, and never nested
 * inside one another — `<style>` is RAWTEXT, so one `<style>` element can never contain
 * another) are ascending and pairwise non-overlapping, so this is a single O(n+m)
 * two-pointer sweep, not a nested scan — load-bearing on the online ingest path.
 */
function filterStyleElementsOutsideNeverAppliedContext(
  startTags: readonly HtmlStartTag[],
  styleElements: readonly HtmlStyleElement[]
): readonly HtmlStyleElement[] {
  const neverAppliedAncestorRanges = collectStartTagRemovalRanges(
    startTags,
    name => name !== 'style' && NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS.has(name)
  );
  if (neverAppliedAncestorRanges.length === 0) return styleElements;

  const kept: HtmlStyleElement[] = [];
  let i = 0;
  for (const el of styleElements) {
    while (
      i < neverAppliedAncestorRanges.length &&
      neverAppliedAncestorRanges[i]![1] <= el.contentStart
    ) {
      i += 1;
    }
    const range = neverAppliedAncestorRanges[i];
    const insideNeverApplied =
      range !== undefined && range[0] <= el.contentStart && el.contentStart < range[1];
    if (!insideNeverApplied) kept.push(el);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Stage 3 — comment removal
// ---------------------------------------------------------------------------

/**
 * Deletes `scan.comments` — `scanHtml`'s own, conformant-tokenizer-derived comment ranges.
 * `scanHtml`'s parser sees an unterminated comment's true extent (it reports the comment
 * running to `html.length`, per `tests/html-parser-conformance.test.ts`'s own pinned
 * deviation numbers) and never mistakes RAWTEXT content for a comment (an unmatched
 * CDO/HTML-comment-opener INSIDE a `<style>` block is ordinary, spec-legal CSS syntax, not an
 * HTML comment at all) — the NF-01 defect this closes.
 *
 * Stage 3 does not run as its own `applyRemovalRanges` call ahead of stage 4/5: stage 3's
 * comment ranges and stage 4/5's element ranges must be resolved against the SAME original
 * (pre-any-deletion) string, since stage 4/5 read element boundaries from `scanHtml().startTags`
 * directly (see `collectStartTagRemovalRanges` below) rather than re-deriving tag positions
 * from whatever string a prior stage's deletion left behind. `mergeCommentAndElementRanges`
 * (near stage 5, below) is where `scan.comments` is combined with stage 4/5's element ranges
 * into the single ordered list `applyRemovalRanges` deletes in one pass.
 */

// ---------------------------------------------------------------------------
// Stage 4 — non-content element removal (fixed tag set)
// ---------------------------------------------------------------------------

// 62-29 gap closure (CR-03): `NON_CONTENT_TAGS` is now derived from
// `HTML_ELEMENT_DISPOSITIONS` (defined in the "Shared tag-matching primitives" section,
// above `scanHtml`) rather than a second hand-maintained literal. The literal this replaced
// was a DIFFERENT seven names that omitted `iframe`/`noembed`/`noframes` — their fallback
// text, rendered by no browser and stripped by Gmail, was emitted verbatim into
// `record.content`.

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
 * CR-05 (62-REVIEW.md) — reconstructs `source` (a declaration block's content, or an inline
 * `style` attribute value) the way a conformant CSS engine reads it, then returns
 * `hasHidingSignature`'s verdict over THAT reconstruction, never over raw/untokenized text. A
 * regex over raw source is comparing against a string a browser never sees: a browser removes
 * comments and decodes `\`-escapes in idents at tokenize time, before any declaration is read
 * (see this file's `<why_a_raw_slice_can_never_agree>` in `62-20-PLAN.md` — under-strip on
 * `display:/*x*\/none` and `display:\6eone`, over-strip on `disp/*x*\/lay:none`). Both call
 * sites of `hasHidingSignature` (`harvestFromStylesheet`'s frame evaluation and
 * `isHiddenStartTag`'s inline-style check) go through this helper; `hasHidingSignature` itself
 * and its twelve regexes are UNCHANGED — only what reaches them changes.
 *
 * One `tokenize` pass, three reconstruction rules, in order of applicability:
 *  - `Comment` token -> emit ONE SPACE. Never the comment text (that is today's under-strip
 *    leak) and never nothing (`disp/*x*\/lay:none` would collapse to `display:none`, which a
 *    browser reads as two separate idents and does NOT treat as a hiding declaration — emitting
 *    nothing would manufacture a false positive the comment-adjacency VF-01 fix already had to
 *    avoid on the selector side).
 *  - ident-bearing tokens (`Ident`, `Function`, `Hash`, `AtKeyword`, `Url`) -> emit
 *    `decodeIdentEscapes` applied to the raw slice, since these are exactly the token kinds
 *    whose text a browser escape-decodes before comparison (CSS Syntax §4.3.7).
 *  - every other token -> emit `source.slice(start, end)` verbatim, clamped with
 *    `Math.min(offset, source.length)` per the characterized css-tree end-offset overrun this
 *    module already accounts for elsewhere (characterized in `62-17-SUMMARY.md`).
 */
function hasHidingSignatureFromTokens(source: string): boolean {
  let text = '';
  tokenize(source, (type, start, end) => {
    if (type === TT_COMMENT) {
      text += ' ';
      return;
    }
    const s = Math.min(start, source.length);
    const e = Math.min(end, source.length);
    if (
      type === TT_IDENT ||
      type === TT_FUNCTION ||
      type === TT_HASH ||
      type === TT_AT_KEYWORD ||
      type === TT_URL
    ) {
      text += decodeIdentEscapes(source.slice(s, e));
    } else {
      text += source.slice(s, e);
    }
  });
  return hasHidingSignature(text);
}

/**
 * True when `styleText` (an inline `style` attribute value, or a harvested `<style>`
 * rule's declaration block) contains any of the named hiding signatures. Zero-valued
 * properties are checked by extracting the number and comparing with `=== 0`, NOT by a
 * regex boundary trick — `opacity:0.85` must not match `opacity:0`.
 *
 * NEVER call this directly with a raw source slice (`css.slice(...)`, an unprocessed attribute
 * value, etc.) — every call site must go through `hasHidingSignatureFromTokens` above, which
 * reconstructs the text the way a conformant engine would read it first (CR-05). This is
 * enforced by a shipped source guard in `tests/strip-hidden.test.ts`.
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

/**
 * True when a start tag's DECODED attribute map matches any hiding shape: an inline
 * `style` hiding signature, the bare `hidden` boolean attribute, `aria-hidden="true"`, a
 * `class` containing a harvested (stage 2) name, or an `id` equal to a harvested id.
 *
 * 62-24 gap closure (CR-07, 62-REVIEW.md): `attrs` is now `scan.startTags[].attrs` — a
 * `ReadonlyMap<string, string>` whose values already went through `htmlparser2`'s own
 * character-reference decoding (`scanHtml`'s `decodeEntities: true`) — instead of a raw
 * source-text region matched by a hand-rolled `STYLE_ATTR_RE`/`CLASS_ATTR_RE`/`ID_ATTR_RE`
 * regex. This closes the two-layer bug the file-level "the layering this restores" section
 * (and `decodeIdentEscapes`'s own doc comment) describes: `class="leg&#97;l"`,
 * `id="leg&#97;l"`, `style="display&#58;none"` and `style="display&colon;none"` all
 * decode to the SAME text a harvested `.legal`/`#legal`/`display:none` selector or
 * declaration was built from, so an entity-encoded attribute value can no longer disagree
 * with a harvested selector name. Layer order matters and is now structural: the `style`
 * value is the HTML-LAYER-DECODED string (`attrs.get('style')`), fed into
 * `hasHidingSignatureFromTokens` (the CSS-LAYER tokenize-and-decode-escapes step) — HTML
 * decode always runs before CSS tokenize, never the reverse, which is what makes
 * `style="display&#58;/*x*\/none"` resolve to the hiding declaration `display:/*x*\/none`
 * (HTML-decoded first) rather than being CSS-tokenized as literal `&#58;` text (which would
 * never match). `class` is still split on JavaScript `\s` (not HTML's five ASCII whitespace
 * characters, WR-13) — that mismatch is a NAMED, OUT-OF-SCOPE residual (62-24-PLAN.md), not
 * silently reintroduced.
 */
function isHiddenStartTag(
  attrs: ReadonlyMap<string, string>,
  hiddenClasses: ReadonlySet<string>,
  hiddenIds: ReadonlySet<string>
): boolean {
  const style = attrs.get('style');
  if (style !== undefined && hasHidingSignatureFromTokens(style)) return true;
  if (attrs.has('hidden')) return true;
  const ariaHidden = attrs.get('aria-hidden');
  if (ariaHidden !== undefined && ariaHidden.toLowerCase() === 'true') return true;
  const cls = attrs.get('class');
  if (cls !== undefined) {
    for (const name of cls.split(/\s+/).filter(Boolean)) {
      if (hiddenClasses.has(name)) return true;
    }
  }
  const id = attrs.get('id');
  if (id !== undefined && hiddenIds.has(id.trim())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stages 3+4+5 combined — removal-range computation (62-24 gap closure, CR-07)
// ---------------------------------------------------------------------------

/**
 * Walks `scan.startTags` ONCE (document order — pushed at OPEN in `scanHtml`), combining
 * what used to be two independent regex-driven scans (stage 4's fixed non-content tag set,
 * stage 5's per-element hiding-signature predicate) into a single pass. For each tag whose
 * `tagStart` is NOT already inside a range this walk has already decided to remove,
 * `shouldRemove(name, attrs)` decides whether `[tag.tagStart, tag.elementEnd)` is added to
 * the removal set. A tag nested inside an already-emitted range is skipped outright: it is
 * already being deleted as part of its ancestor's content, and emitting a second, NESTED
 * range for it would break `applyRemovalRanges`'s ascending-non-overlapping-cursor contract
 * (the exact reason the pre-62-24 regex walk advanced `START_TAG_RE.lastIndex` past a
 * removed range's end rather than resuming immediately after the matched open tag — this
 * cursor mirrors that same discipline over `scan.startTags` instead of a live regex).
 *
 * Ranges are guaranteed pairwise non-overlapping and ascending by construction: `startTags`
 * is document-order and `scanHtml`'s own stack-based `elementEnd` computation guarantees a
 * child's `elementEnd` never exceeds its parent's (proper HTML nesting, or an EOF/ancestor
 * -implied close bounded the same way) — so once a range `[tagStart, elementEnd)` is
 * emitted, every subsequent tag with `tagStart < elementEnd` is necessarily nested inside
 * it and correctly skipped by the cursor check above.
 */
function collectStartTagRemovalRanges(
  startTags: readonly HtmlStartTag[],
  shouldRemove: (tagName: string, attrs: ReadonlyMap<string, string>) => boolean
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (const tag of startTags) {
    if (tag.tagStart < cursor) continue;
    if (!shouldRemove(tag.name, tag.attrs)) continue;
    ranges.push([tag.tagStart, tag.elementEnd]);
    cursor = tag.elementEnd;
  }
  return ranges;
}

/**
 * Merges stage 3's comment ranges with stage 4/5's combined element ranges into ONE
 * ascending, non-overlapping range list, so `applyRemovalRanges` can delete all three
 * stages' output in a single pass over the ORIGINAL (pre-any-deletion) string — required
 * once stage 4/5 stopped re-deriving tag positions from whatever string a prior stage's
 * deletion left behind (see stage 3's own doc comment above for why sequential deletion no
 * longer composes).
 *
 * `elementRanges` (from `collectStartTagRemovalRanges`) is already ascending and pairwise
 * non-overlapping. A comment range can only ever be fully CONTAINED in one such element
 * range or entirely DISJOINT from all of them — never partially overlapping — because
 * `scanHtml`'s parser never recognizes a tag as a real element while it is inside comment
 * data (a `<style>` open tag written inside `<!-- -->` never fires `onopentag`, CR-10), so
 * no element's start tag can begin inside an earlier comment's span, and per HTML's
 * tokenizer a comment is one atomic lexical span that cannot itself straddle an element
 * boundary. A contained comment is dropped (its ancestor element's own range already
 * deletes it; keeping both would violate `applyRemovalRanges`'s monotonic-cursor
 * contract). `scan.comments` is itself already ascending and non-overlapping (one forward
 * parser pass), so this is a single O(n+m) two-pointer sweep, not a nested scan.
 */
function mergeCommentAndElementRanges(
  comments: readonly HtmlComment[],
  elementRanges: readonly (readonly [number, number])[]
): Array<[number, number]> {
  const standaloneComments: Array<[number, number]> = [];
  let i = 0;
  for (const c of comments) {
    while (i < elementRanges.length && elementRanges[i]![1] <= c.start) i += 1;
    const container = elementRanges[i];
    const contained = container !== undefined && container[0] <= c.start && c.end <= container[1];
    if (!contained) standaloneComments.push([c.start, c.end]);
  }
  const combined: Array<[number, number]> = [
    ...elementRanges.map((r): [number, number] => [r[0], r[1]]),
    ...standaloneComments,
  ];
  combined.sort((a, b) => a[0] - b[0]);
  return combined;
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

  // Stage 0 (62-14, Bound A, WR-02/T-62-77): hoisted duplicate of the stage-6 stray-`<`
  // fail-safe, run BEFORE stage 2 so no later scan pays for the failing-scan region. A
  // forward scan of the shared ATTRS fragment that reaches an unquoted `>` succeeds and
  // advances past it (O(n) in aggregate); it can only fail repeatedly in the region after
  // the LAST `>` in the string, where no complete tag can exist — that is exactly the region
  // stage 6 already deletes, so deleting it here removes the entire failing-scan surface
  // before stages 2-6 ever see it. `lastCloseAngle + 1` is 0 when there is no `>` at all,
  // which correctly scans the whole string for a stray `<` in that case too.
  const lastCloseAngle = s.lastIndexOf('>');
  const earlyStrayAngleBracket = s.indexOf('<', lastCloseAngle + 1);
  if (earlyStrayAngleBracket !== -1) s = s.slice(0, earlyStrayAngleBracket);

  // 62-22/62-24 gap closure (CR-10/CR-07): ONE `scanHtml` pass, computed here and shared by
  // stages 2, 3, 4 and 5 below — see `scanHtml`'s own doc block for why. Ranges are offsets
  // into THIS string (post-stage-0/1), which is exactly the basis every later stage already
  // works on; do not compute a second scan and do not re-scan after a deletion.
  const scan = scanHtml(s);

  // Stage 2: harvest class/id hiding selectors from <style> blocks before they're
  // discarded in stage 4. 62-29 gap closure (WR-01): a stylesheet nested inside a
  // never-applied context (<iframe>/<noscript>/<template>, ...) is filtered OUT before
  // harvest — a browser never applies it, so harvesting it anyway would delete visible
  // prose outside the container that never should have been hidden.
  const harvestableStyleElements = filterStyleElementsOutsideNeverAppliedContext(
    scan.startTags,
    scan.styleElements
  );
  const { classes: hiddenClasses, ids: hiddenIds } = harvestHidingSelectors(
    s,
    harvestableStyleElements
  );

  // Stages 3+4+5 (62-24 gap closure, CR-07): comment ranges (stage 3), non-content-element
  // ranges (stage 4, fixed tag set) and hidden-element ranges (stage 5, hiding-signature
  // predicate over `scan.startTags`' DECODED attrs) are all computed against the SAME
  // `scan` object and deleted TOGETHER in one `applyRemovalRanges` call — see
  // `collectStartTagRemovalRanges` and `mergeCommentAndElementRanges` (defined near stage
  // 5, above) for why a single combined deletion is required once stage 4/5 stopped
  // re-deriving tag positions with their own regex walk over the current string.
  const elementRanges = collectStartTagRemovalRanges(
    scan.startTags,
    (name, attrs) => NON_CONTENT_TAGS.has(name) || isHiddenStartTag(attrs, hiddenClasses, hiddenIds)
  );
  s = applyRemovalRanges(s, mergeCommentAndElementRanges(scan.comments, elementRanges));

  // Stage 6: remove every remaining tag. CR-02 gap closure (62-30): stages 3/4/5's own
  // deletion just above can expose a NEW stray `<` with no later `>` — deleting a single
  // element or comment is enough to strip every `>` from the tail. `ANY_TAG_RE` is built
  // from the shared `ATTRS` fragment, which PERMITS an unquoted `<`, so a scan starting
  // inside such a run fails from every start position after consuming the whole remaining
  // tail (O(n^2)). Re-hoisting stage 0's Bound A truncation to run immediately BEFORE the
  // sweep — on THIS, post-deletion string — removes that failing-scan region before
  // `.replace()` pays for it. The full equivalence argument (200+-input corpus, byte-identical
  // output) and the measured growth curve live in `62-30-SUMMARY.md`; the file-level doc block
  // above carries only the one-line changelog entry. Cite documents, not doc-block sections —
  // a section name is a cross-reference the identifier guard below cannot resolve, which is
  // how this comment came to point at a section 62-31 had already collapsed.
  const lastCloseAngleBeforeSweep = s.lastIndexOf('>');
  const strayAngleBracketBeforeSweep = s.indexOf('<', lastCloseAngleBeforeSweep + 1);
  if (strayAngleBracketBeforeSweep !== -1) s = s.slice(0, strayAngleBracketBeforeSweep);

  // An unterminated trailing `<` (no closing `>` anywhere after it) is fail-safe-truncated
  // to end of string rather than kept as ambiguous, possibly-markup text. This second
  // truncation still guards a `<` that sits BEFORE the last `>` in the pre-sweep string
  // (matching no complete tag) — the hoisted truncation above is an ADDITION, not a
  // replacement, exactly as stage 0's Bound A is to this one.
  s = s.replace(ANY_TAG_RE, '');
  const strayAngleBracket = s.indexOf('<');
  if (strayAngleBracket !== -1) s = s.slice(0, strayAngleBracket);

  // Stage 7: decode only &nbsp;/&#160; — every other entity stays literal (idempotence).
  s = s.replace(NBSP_ENTITY_RE, ' ');

  // Stage 8: normalize whitespace while preserving paragraph structure.
  return normalizeWhitespace(s);
}
