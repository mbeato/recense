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
 * 62-13 gap closure (VF-01/NEW-01, 62-VERIFICATION.md) — two more decisions recorded here:
 *  1. VF-01 (BLOCKER, falsified roadmap SC #3 / EMAIL-03): `harvestHidingSelectors` now
 *     passes each harvested `<style>` block's content through `stripCssComments` (a
 *     LINEAR, regex-free scan of the three CSS Syntax contexts in which a `/*` is not a
 *     comment — see `stripCssComments`'s own doc comment for the closed enumeration and
 *     the two rejected fix forms) BEFORE the rule harvest scans it. Previously a CSS comment
 *     anywhere near a hiding selector — before it, after it, inside its comma list, or
 *     between the selector and `{` — made the exact-match bare-selector test fail, so
 *     NOTHING in that rule was harvested and the class/id-hidden element's text reached
 *     `record.content`.
 *  2. NEW-01 (regression introduced by 62-12's `ATTRS` widening): `findMatchingCloseEnd`
 *     now delegates to `findRawtextCloseEnd` for the `RAWTEXT_ELEMENTS` set (script,
 *     style, title, textarea, iframe, noembed, noframes, xmp — `noscript` deliberately
 *     excluded, see `RAWTEXT_ELEMENTS`'s own doc comment). Per HTML §13.2.5.1-13.2.5.20,
 *     inside a raw-text element NOTHING in the body is a tag except the element's own end
 *     tag, so the old depth-counting `ANY_TAG_TOKEN_RE` scan — which tokenizes arbitrary
 *     tags in the body — mis-tokenized an unquoted `<` plus an ASCII letter as a new open
 *     tag, whose `ATTRS` region then consumed forward through the real close tag's `>`. No
 *     matching close was found, the fail-safe returned `html.length`, and everything from
 *     the open tag to EOF was deleted — reachable by ordinary JavaScript
 *     (`<script>if (a<x) {}</script>`), not only adversarial input.
 *
 * The 62-09 source guard (tests/strip-hidden.test.ts) is UPDATED, not removed, by this
 * change: its first assertion (no bare `[^>]*`/`[^<>]*` class survives) is kept UNCHANGED
 * — true only because the shared `ATTRS` fragment's `STYLE_BLOCK_RE` close tail is built
 * from the shared ATTRS fragment, NOT the reviewer-proposed `[^>]*` tail, which would have reintroduced
 * that exact banned substring. Its second assertion (a `>= 4` count of the alternation
 * prefix) is REPLACED with single-source-of-truth counts, since the alternation now
 * appears exactly once (inside `ATTRS` itself) rather than once per regex; 62-13 raises
 * both counts from 4 to 5, since `RAWTEXT_CLOSE_TAIL_RE` is a fifth literal built from the
 * shared `ATTRS` fragment (the guard working as intended, not weakened — see
 * `RAWTEXT_CLOSE_TAIL_RE`'s own doc comment).
 *
 * 62-14 gap closure (WR-02, 62-VERIFICATION.md) — the algorithmic half of the availability
 * gap escalated from "accepted residual" to a filed gap: two exact linear bounds replace the
 * module's two backtracking-heavy scans, both measured behavior-preserving against the
 * pre-change module over the shipped test corpus and tens of thousands of generated inputs
 * (zero differences — see the 62-14 SUMMARY for the exact counts).
 *  1. Bound A (new stage 0, runs immediately after stage 1): duplicates stage 6's stray-`<`
 *     fail-safe truncation BEFORE any later stage's scan can pay for it. A forward scan of
 *     the shared `ATTRS` fragment that reaches an unquoted `>` succeeds and advances past it,
 *     so successful matches cost O(n) in aggregate; a scan can only fail repeatedly in the
 *     region AFTER the last `>` in the string, where no complete tag can exist — that region
 *     is exactly what stage 6 already deletes, so hoisting an identical deletion ahead of
 *     stages 2-6 removes the entire failing-scan region before anything else pays for it.
 *     Stage 6's own truncation stays in place — stages 4 and 5 delete ranges and can expose a
 *     NEW stray `<` that stage 0 could not have seen; Bound A is an addition, not a move.
 *  2. Bound B: `harvestHidingSelectors`'s rule scan is now a linear `indexOf`/`lastIndexOf`
 *     cursor walk in place of a `matchAll` loop over a backtracking-heavy regex. A `<style>`
 *     body with no `{` at all — the cheapest possible attacker-authored stylesheet — forced
 *     the old regex to retry a failing forward scan at every start position: this is why the
 *     verification report's shape (`<style>` + `a<x ` repeated + `</style>`, no braces
 *     anywhere) cost 126 SECONDS at 512 KB despite carrying no hiding rule at all, and why
 *     shapes V, W, Y and Z (reached through different byte patterns — an open brace with a
 *     brace-free tail, a brace-free run before a real rule, alternating quotes, and repeated
 *     unterminated url-tokens, respectively) cost the same. `stripCssComments` (62-13) is NOT
 *     the cause for any of these: it is measured directly (per-stage, at every size) to cost
 *     under a millisecond even where it returns its input completely unchanged (shapes Y and
 *     Z contain no `/*`, so its early exit fires immediately) — the cost is 100% downstream,
 *     in the rule scan this bound replaces. The scan's full equivalence argument is stated in
 *     `harvestHidingSelectors`'s own doc comment.
 * The one quadratic this module still exhibits — `STYLE_BLOCK_RE`'s lazy `</style>` tail scan
 * on a body with complete open tags but no close tag anywhere (T-62-54) — is untouched here;
 * it is measured and named, not fixed, and is the residual plan 62-15's input cap is sized
 * against.
 *
 * Stage order (load-bearing — see the block comment above each stage):
 *  0. Hoisted stray-`<` fail-safe truncation (62-14, Bound A) — runs immediately after stage
 *     1 and before stage 2; a DUPLICATE of the stage-6 truncation below, not a move of it.
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
 *     style tag still yields its rules to the harvest. Block content is passed through
 *     `stripCssComments` (62-13, VF-01) before the bare-selector check.
 *  3. HTML comment removal.
 *  4. Non-content element removal (script/style/head/title/template/noscript/svg), with
 *     their contents. For `RAWTEXT_ELEMENTS`, the removal range's end is found by
 *     `findRawtextCloseEnd` (62-13, NEW-01) rather than the depth-counting tag scan, since
 *     nothing in a raw-text body is a tag except the element's own end tag.
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
 * HTML raw-text / escapable-raw-text elements (HTML §13.2.5.1-13.2.5.20, 62-13 gap
 * closure, NEW-01). Inside one of these elements the ONLY thing that can end the element
 * is its own end tag: `</` + the element's name, followed by whitespace, `/`, or `>`.
 * NOTHING else in the body is a tag — nesting is impossible, so the FIRST matching end tag
 * closes the element (this is why `<script>var s = "</script>";</script>` famously ends at
 * the first `</script>`). `noscript` is DELIBERATELY EXCLUDED: mail clients parse with
 * scripting disabled, where `<noscript>` content is ordinary markup, so the existing
 * depth-counting `ANY_TAG_TOKEN_RE` scan is the faithful one there — and stage 4 deletes
 * the element wholesale either way, since `noscript` is also in `NON_CONTENT_TAGS`.
 */
const RAWTEXT_ELEMENTS = new Set([
  'script', 'style', 'title', 'textarea', 'iframe', 'noembed', 'noframes', 'xmp',
]);

/**
 * Matches only a close-tag OPENER — `</` plus an ASCII tag name, no attribute region — used
 * by `findRawtextCloseEnd` to locate end-tag candidates inside a raw-text element body
 * without tokenizing the body as ordinary tags (which was NEW-01: an unquoted `<` plus a
 * letter mis-tokenized as a new open tag whose ATTRS region consumed through the real
 * close tag's `>`).
 */
const RAWTEXT_CLOSE_OPENER_RE = /<\/([a-zA-Z][a-zA-Z0-9]*)/g;

/**
 * STICKY match for a raw-text close tag's tail — the shared `ATTRS` fragment followed by
 * `>` — anchored at `lastIndex` via the `y` flag so it only matches immediately after a
 * confirmed end-tag-opener match. Built from `ATTRS`, not a hand-written class, so
 * `</style foo>`, `</style/>`, `</style   >` and `</style>` are all accepted exactly as
 * `ANY_TAG_TOKEN_RE` accepts them (BL-02 stays closed) and the T-62-43 cross-stage
 * boundary agreement stays structural.
 */
const RAWTEXT_CLOSE_TAIL_RE = new RegExp(`${ATTRS}>`, 'y');

/**
 * Forward-scans from `fromIndex` for the first `</tagName ...>` close tag, per the
 * raw-text parsing model: nothing in the body is a tag except the element's own end tag,
 * so the FIRST matching close tag ends the element (no depth counting). Fail-safe: returns
 * `html.length` if no matching close exists, matching `findMatchingCloseEnd`'s contract.
 */
function findRawtextCloseEnd(html: string, tagName: string, fromIndex: number): number {
  const lower = tagName.toLowerCase();
  RAWTEXT_CLOSE_OPENER_RE.lastIndex = fromIndex;
  let m: RegExpExecArray | null;
  while ((m = RAWTEXT_CLOSE_OPENER_RE.exec(html)) !== null) {
    const name = m[1]!.toLowerCase();
    if (name !== lower) continue;
    RAWTEXT_CLOSE_TAIL_RE.lastIndex = RAWTEXT_CLOSE_OPENER_RE.lastIndex;
    if (RAWTEXT_CLOSE_TAIL_RE.exec(html) !== null) {
      return RAWTEXT_CLOSE_TAIL_RE.lastIndex;
    }
    // Sticky tail match failed (e.g. no `>` anywhere after this candidate) — keep
    // scanning forward for another `</tagName` occurrence rather than giving up.
  }
  return html.length;
}

/**
 * Forward-scans from `fromIndex` counting nested same-name open/close tags to find the
 * tag matching the just-opened element, returning the index just past its closing tag.
 * Bounded by the remaining string length (each token is consumed once, no backtrack
 * across the whole scan). Fail-safe: returns `html.length` if no matching close exists —
 * "monotone toward less content, never raw passthrough" (T-62-18).
 *
 * Delegates to `findRawtextCloseEnd` for `RAWTEXT_ELEMENTS` (62-13 gap closure, NEW-01):
 * tokenizing arbitrary tags in a raw-text element's body is not HTML-faithful — only the
 * element's own end tag can close it — so the depth-counting scan below stays exactly as
 * written for every OTHER element, where tokenizing tags in the body IS the faithful
 * behavior.
 */
function findMatchingCloseEnd(html: string, tagName: string, fromIndex: number): number {
  const lower = tagName.toLowerCase();
  if (RAWTEXT_ELEMENTS.has(lower)) {
    return findRawtextCloseEnd(html, lower, fromIndex);
  }
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
 * harvested block content mid-attribute, so the rule harvest saw a garbage selector and no
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
const BARE_CLASS_SELECTOR_RE = /^\.[A-Za-z0-9_-]+$/;
const BARE_ID_SELECTOR_RE = /^#[A-Za-z0-9_-]+$/;

/** Cap on harvested selectors so a pathological stylesheet cannot cause quadratic work. */
const MAX_HARVESTED_SELECTORS = 200;

/** True for the five CSS whitespace code points (space, tab, LF, CR, FF). */
function isCssWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/** True when `css[i..i+3]` is `url(`, matched ASCII-case-insensitively. */
function matchesUrlOpen(css: string, i: number): boolean {
  if (i + 4 > css.length) return false;
  return (
    (css.charCodeAt(i) | 0x20) === 0x75 /* u */ &&
    (css.charCodeAt(i + 1) | 0x20) === 0x72 /* r */ &&
    (css.charCodeAt(i + 2) | 0x20) === 0x6c /* l */ &&
    css.charCodeAt(i + 3) === 0x28 /* ( */
  );
}

/**
 * Removes CSS comments from `css` (a harvested `<style>` block's content) ahead of the
 * bare-selector check in `harvestHidingSelectors` (VF-01, 62-VERIFICATION.md). Returns
 * `css` unchanged when it contains no `/*`.
 *
 * A LINEAR, regex-free `charCodeAt` cursor scan built from a CLOSED enumeration of the CSS
 * Syntax Level 3 productions that can consume a `/` away from a token boundary — no regex
 * of any kind appears in this function, deliberately (see the two rejected forms below).
 * CSS Syntax §4.3.1 ("consume a token") invokes §4.3.2 ("consume comments") at EVERY token
 * boundary, so `/*` starts a comment at every token boundary without exception; it
 * therefore fails to start a comment only when the `/` has already been consumed by one of
 * exactly three productions that have not returned to a token boundary:
 *
 *  Case 1 — §4.3.5 consume a string token: a double- or single-quote opens a string; a
 *    backslash consumes the following code point; a raw (unescaped) newline ends the
 *    string unterminated (a "bad string" per spec — see the Task 3 SUMMARY for the
 *    residual on whether tokenizing genuinely resumes after that newline rather than
 *    running to EOF, which this case treats as running to EOF for simplicity).
 *  Case 2 — §4.3.7 consume an escaped code point, reached from ident-sequence consumption
 *    (§4.3.11/§4.3.12): a backslash NOT already inside a string or url span consumes the
 *    following code point, UNLESS that code point is a newline (not a valid escape per
 *    spec, so a `/*` right after `\` + newline IS a comment).
 *  Case 3 — §4.3.6 consume a url token (unquoted form only) + §4.3.14 consume the
 *    remnants of a bad url: an ASCII-case-insensitive `url(` followed by optional
 *    whitespace. If the next code point is a quote, this is NOT a raw url span — it is a
 *    function token followed by a string token (case 1's job); entering "url mode" here
 *    would let a `)` inside the quoted URL desynchronize the scan, so only `url(` itself
 *    is consumed and scanning resumes normally. Otherwise skip to the first `)` not
 *    preceded by a backslash escape.
 *
 * The enumeration is closed because no other production consumes a `/` away from a token
 * boundary: `/` is not an ident code point, numeric-token consumption cannot include it,
 * and every remaining token is single-code-point or delimiter-shaped. Every OTHER function
 * token (`calc(`, `attr(`, ...) tokenizes normally inside it, so `/*` IS a comment there —
 * `url(` is the only raw-consuming function, which is why case 3 exists at all.
 *
 * Every unterminated case (string, url, comment) TERMINATES THE WHOLE SCAN rather than
 * advancing, matching the spec (an unterminated string/url/comment runs to end of the
 * stylesheet) and keeping the scan linear — without this, each unterminated opener would
 * re-scan to end of string from every subsequent position, reproducing the exact quadratic
 * the regex form below is rejected for. An unterminated STRING or URL is not itself
 * comment syntax, so everything from the current anchor through EOF is KEPT unchanged; an
 * unterminated COMMENT genuinely runs to end of stylesheet in real CSS (the rule inside it
 * never applies, so not harvesting through it is the faithful outcome), so everything from
 * the comment's `/*` through EOF is DROPPED — this is the deliberate "an unterminated
 * comment before a rule leaves the rule un-harvested, span stays visible" decision this
 * module locks with a test.
 *
 * TWO REJECTED FORMS, each for a DIFFERENT measured reason a future reader must not
 * re-propose either of:
 *  1. The verification report's naive one-line `.replace()` fix -- `blockContent` run
 *     through a lazy-alternation `RegExp` matching `/` `*` ... `*` `/` globally -- is
 *     rejected because a `/*` inside a quoted CSS string is not a comment: measured, it
 *     deletes from the `/*` in `.x{content:"/*"}` through the `*\/` in `.y{content:"*\/"}`,
 *     taking an intervening `.legal{display:none}` rule out of the harvest and leaking the
 *     class-hidden payload (measured `okPAYLOAD_STR`) — a fifth bypass of the same
 *     contract, introduced by the fix for the fourth. A string-only scan (case 1 and the
 *     comment case, without cases 2 and 3) is rejected for the identical reason one
 *     context lower: measured, it leaks on five separate url-token and escape shapes
 *     (unquoted `url(`, `URL(`/`Url(`, `url( ... )` with whitespace, an escaped `)` inside
 *     a url, and an identity escape `\/` before `*`), each with a live
 *     `.legal{display:none}` rule confirmed by a real CSS parser — which is why the case
 *     list is derived from the spec's productions rather than from the repros that
 *     happened to be filed.
 *  2. A string-aware REGEX form — one alternation of a double-quoted string, a
 *     single-quoted string and a lazy `/*` ... `*\/` comment, driven through `.replace()` —
 *     is rejected because it is QUADRATIC on attacker-controlled input: measured 47.8 /
 *     203.8 / 749.0 / 3,009.5 ms at 32 / 64 / 128 / 256 KB for block content shaped as
 *     `/*y` repeated (no `*\/` anywhere, so every `/*` starts a lazy forward scan to end of
 *     string that never finds its terminator), versus 0.2-0.9 ms for this linear scan, and
 *     it makes a currently-0.1 ms input (the same shape with a trailing hiding rule)
 *     quadratic — a scan whose cost the sender chooses does not belong in the same module
 *     as the WR-02 gap plans 62-14/62-15 exist to remove.
 */
function stripCssComments(css: string): string {
  if (css.indexOf('/*') === -1) return css;
  const n = css.length;
  let out = '';
  let anchor = 0;
  let i = 0;
  while (i < n) {
    const code = css.charCodeAt(i);

    // Case 1 -- string token (SS4.3.5): skip to the matching quote.
    if (code === 0x22 /* " */ || code === 0x27 /* ' */) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const cj = css.charCodeAt(j);
        if (cj === 0x5c /* \ */) { j += 2; continue; }
        if (cj === code) { j += 1; closed = true; break; }
        if (cj === 0x0a /* \n */) break; // raw newline: bad-string, treated as unterminated
        j += 1;
      }
      if (!closed) {
        out += css.slice(anchor, n);
        return out;
      }
      i = j;
      continue;
    }

    // Case 2 -- escape outside a string or url (SS4.3.7): a backslash consumes the
    // following code point unless it is a newline (not a valid escape).
    if (code === 0x5c /* \ */) {
      i += (i + 1 < n && css.charCodeAt(i + 1) !== 0x0a) ? 2 : 1;
      continue;
    }

    // Case 3 -- unquoted url-token (SS4.3.6 + SS4.3.14).
    if (matchesUrlOpen(css, i)) {
      let j = i + 4;
      while (j < n && isCssWhitespaceCode(css.charCodeAt(j))) j += 1;
      if (j < n && (css.charCodeAt(j) === 0x22 || css.charCodeAt(j) === 0x27)) {
        // Quoted form -- a function token + string token, not a raw url span. Advance
        // past `url(` only; case 1 handles the quoted string on a later position, so a
        // `)` inside it cannot desynchronize this scan.
        i += 4;
        continue;
      }
      let k = j;
      let closed = false;
      while (k < n) {
        const ck = css.charCodeAt(k);
        if (ck === 0x5c /* \ */) { k += 2; continue; }
        if (ck === 0x29 /* ) */) { k += 1; closed = true; break; }
        k += 1;
      }
      if (!closed) {
        out += css.slice(anchor, n);
        return out;
      }
      i = k;
      continue;
    }

    // Case 4 -- the comment itself.
    if (code === 0x2f /* / */ && i + 1 < n && css.charCodeAt(i + 1) === 0x2a /* * */) {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) {
        out += css.slice(anchor, i);
        return out;
      }
      out += css.slice(anchor, i);
      i = end + 2;
      anchor = i;
      continue;
    }

    i += 1;
  }
  out += css.slice(anchor, n);
  return out;
}

/**
 * Harvests bare `.class`/`#id` selectors (no combinators, pseudo-selectors, attribute
 * selectors, or media queries — those selector shapes simply fail the bare-selector
 * regex test below, which also excludes `@media` blocks) whose rule body matches a
 * hiding signature (stage 5's `hasHidingSignature`). The realistic ATS shape hides a
 * span by class, not by inline style, so simply deleting the `<style>` block (stage 4)
 * would destroy the evidence that the span is hidden while leaving its text behind.
 *
 * VF-01 gap closure (62-13): block content is passed through `stripCssComments` BEFORE
 * the rule scan below sees it, so a `/* comment *\/` adjacent to a hiding selector (before
 * it, after it, inside its comma list, or between the selector and `{`) can no longer make
 * the exact-match bare-selector test fail and drop the whole rule from the harvest.
 *
 * WR-02 gap closure (62-14, Bound B): the rule scan is a LINEAR `indexOf`/`lastIndexOf`
 * cursor walk, not a regex `matchAll` loop. Plain CSS has no rule nesting, so a
 * `selectorList { body }` rule could be described by the pattern `[^{}]+\{[^{}]*\}` — but
 * driving that pattern with a global regex retried at every start position is what made a
 * brace-free `<style>` body quadratic (WR-02, T-62-75): every retried start position
 * re-scans forward looking for a `{`, and on a long run with no `{` at all that scan pays
 * for the whole remaining string at every position.
 *
 * Equivalence argument (checkable, not just trusted): partition the cleaned block content on
 * `}` into segments — the text strictly between two consecutive `}` characters, or between
 * the start and the first `}`. Within a segment, a `[^{}]*` declaration body terminated by
 * `}` can only begin right after that segment's LAST `{` — any earlier `{` would leave a
 * dangling unconsumed `{` before the body could reach its terminating `}`. The selector run
 * `[^{}]+` immediately preceding that body must, symmetrically, begin right after the
 * PRECEDING `{` in the same segment, or at the segment start when the last `{` has no
 * earlier `{` before it (including when the last `{` IS the segment's first character). A
 * segment with no `{` at all cannot start a body, so it yields no rule — the same outcome as
 * this function's existing `selectors.length === 0` skip below, since `[^{}]+` can never
 * match zero characters and a zero-length selector slice fails that same downstream check.
 * This produces exactly the same sequence of `(selectorText, body)` pairs, in the same
 * order, that the regex form produced — checked, not just argued, by a differential harness
 * over the shipped corpus and tens of thousands of generated inputs (62-14 SUMMARY).
 * `MAX_HARVESTED_SELECTORS` is checked at the same two points as before: once per candidate
 * rule (mirroring the old per-match check) and once per selector inside the allowed rule.
 */
function harvestHidingSelectors(html: string): { classes: Set<string>; ids: Set<string> } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  let total = 0;
  for (const styleMatch of html.matchAll(STYLE_BLOCK_RE)) {
    const blockContent = stripCssComments(styleMatch[1] ?? '');
    const len = blockContent.length;
    let cursor = 0;
    while (cursor < len) {
      const closeBrace = blockContent.indexOf('}', cursor);
      if (closeBrace === -1) break;
      const segment = blockContent.slice(cursor, closeBrace);
      cursor = closeBrace + 1;
      const lastOpen = segment.lastIndexOf('{');
      if (lastOpen === -1) continue;
      const precedingOpen = lastOpen > 0 ? segment.lastIndexOf('{', lastOpen - 1) : -1;
      const selectorStart = precedingOpen === -1 ? 0 : precedingOpen + 1;
      if (total >= MAX_HARVESTED_SELECTORS) return { classes, ids };
      const selectorText = segment.slice(selectorStart, lastOpen).trim();
      const body = segment.slice(lastOpen + 1);
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
