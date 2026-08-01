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
 * The one quadratic this module still exhibited — `STYLE_BLOCK_RE`'s lazy `</style>` tail scan
 * on a body with complete open tags but no close tag anywhere (T-62-54) — was untouched here;
 * it was measured and named, not fixed, and was the residual plan 62-15's input cap was sized
 * against. It is ELIMINATED, not re-bounded, by the "62-18 gap closure" section below.
 *
 * 62-17 gap closure — the third rewrite of this module's CSS layer, and the first that
 * replaces the underlying MECHANISM (raw-text scanning) instead of patching another
 * disagreement it produced. Six independent bypasses of one contract (CR-01, BL-01, BL-02 x2,
 * BL-03, CR-04's mechanism, VF-01, NEW-01, WR-02's quadratic, two escaped-selector leaks) had
 * been found by reconstructing CSS Syntax Level 3 §4.3 one adversarial repro at a time.
 * `stripCssComments`, `matchesUrlOpen`, `isCssWhitespaceCode` and `BARE_CLASS_SELECTOR_RE`/
 * `BARE_ID_SELECTOR_RE` are deleted, replaced by a single `tokenize` pass over
 * `css-tree/tokenizer` (`css-tree@3.2.1`, pinned `--save-exact`, 62-16) reading rule boundaries
 * from `{`/`}` TOKENS and selector shape from TOKEN STRUCTURE, so agreement with a conformant
 * CSS engine is structural rather than the outcome of enumerating repros.
 *  - Adopted surface: `src/` may import ONLY `tokenize`/`tokenTypes` from the `/tokenizer`
 *    subpath (`src/types/css-tree-tokenizer.d.ts`, 62-16) — never the bare `css-tree` package,
 *    never its parser/lexer/walker/generator. The parser IS used, deliberately, by a test-only
 *    liveness oracle under `tests/support/` (62-16) that answers which bare selectors a
 *    conformant engine treats as live, independent of this module's own code — that oracle
 *    must never be imported from `src/` (T-62-17-08, enforced by grep in the verify gate).
 *  - postcss was measured and DISQUALIFIED as an alternative (62-16): wrong on both FB-01's and
 *    CR-04's own input shapes, so a postcss-based rewrite would have reproduced the same two
 *    findings under a different implementation rather than closing them.
 *  - Two characterized css-tree tokenizer deviations from a naive reading of §4.3 (62-16,
 *    locked by `tests/css-tokenizer-conformance.test.ts`) this harvest tolerates rather than
 *    re-discovers: a leading U+FEFF is skipped (so a token's first offset may start at 1 —
 *    unreachable in the real pipeline, since stage 1 removes U+FEFF before stage 2 runs, but
 *    not assumed here); a token `end` offset may exceed `source.length` by at most 1 (every
 *    slice below clamps with `Math.min(offset, css.length)` accordingly).
 *  - 62-16's liveness-oracle adjudication — its own independent re-derivation, using css-tree's
 *    PARSER, a different layer than this module's tokenizer-only production surface — found
 *    both filed blockers reclassified as AGREEMENT on their reported inputs: FB-01 (a browser
 *    never treats `.legal{display:none}` as reaching top level inside `.a`'s still-open,
 *    bad-string-broken block either) and both CR-04 shapes (a browser drops the malformed
 *    selector too). CR-04's underlying MECHANISM finding — `matchesUrlOpen` had no
 *    token-boundary check — was left explicitly open by that reclassification; THIS gap
 *    closure is what actually retires it, by deleting `matchesUrlOpen` outright rather than
 *    patching it. The SAME re-derivation found two escaped-selector leaks genuinely LIVE and
 *    never previously filed (`.leg\61 l` vs `class="legal"`, `#leg\61 l` vs `id="legal"` —
 *    both now closed by `decodeIdentEscapes`, §4.3.7); a third row planning's own throwaway
 *    table had guessed at, `.leg\al`, was found by that SAME re-derivation to decode to
 *    `"leg\nl"` (one hex digit, the `content:"\A"` newline idiom) rather than `"legal"` — a
 *    correctly-adjudicated NON-leak, not a third finding (see `62-16-SUMMARY.md` for the full
 *    decode derivation). This gap closure's scope floor is therefore TWO closed leaks, not
 *    three.
 *
 * 62-18 gap closure (T62-91, 62-VERIFICATION.md) — eliminates the one quadratic 62-14 named
 * but did not fix. `62-VERIFICATION.md` found that plan 62-15's 1 MiB cap was sized against
 * ONE parametrization of `STYLE_BLOCK_RE`'s lazy `</style>`-tail scan (T-62-54); a denser,
 * cheaper-to-construct variant costs far more at the identical cap boundary. Measured in
 * isolation at exactly 1,048,576 code units, comparing `html.matchAll(STYLE_BLOCK_RE)`
 * (left) against this plan's linear replacement (right):
 *
 *   shape at exactly 1,048,576 code units                     STYLE_BLOCK_RE   linear walk
 *   bare `<style>` repeated (T62-91's own worst case)            23,249 ms         0.3 ms
 *   62-15's Shape T, 4 attribute pairs                            2,887 ms         0.2 ms
 *   single unquoted attribute triple                              8,381 ms         0.2 ms
 *   `<style ` repeated with NO `>` until the final byte (new)   156,223 ms         2.5 ms
 *   well-formed `<style>.g{display:none}</style>` repeated           2.5 ms         3.6 ms
 *
 * The `<style ` -with-no-`>` shape had never been measured by any prior wave: it is reachable
 * end-to-end because stage 0 (Bound A, 62-14) truncates from the first `<` that FOLLOWS the
 * last `>`, so a body whose only `>` is its final byte is not truncated at all and reaches
 * `harvestHidingSelectors` in full. At 156 seconds it is 7x worse than the 22.7 s the
 * verification report found and 156x the wave's own 1000 ms budget.
 *
 * `STYLE_BLOCK_RE` is DELETED, not re-bounded, in favor of stage 2 locating `<style>`
 * elements with the SAME primitives stage 4 already uses: `START_TAG_RE` finds each
 * `<style ...>` open tag (its attribute region is built from the shared `ATTRS` fragment,
 * which PERMITS an unquoted `<` per HTML §13.2.5.36, so `<style<style<style…>` is ONE start
 * tag, not thousands of failing scans — the same amortization argument Bound A already
 * established for stage 0 (62-14), now applied to stage 2 as well); `findRawtextCloseBounds`
 * (placed above `findRawtextCloseEnd`, in the shared tag-matching primitives section) then
 * finds the matching `</style...>` close tag with a cursor that only moves FORWARD. The first
 * failure to find any further `</style` proves no LATER `<style` can find one either (the
 * cursor never rewinds), so the walk BREAKS on the first unterminated element rather than
 * retrying a failing scan from every subsequent `<style` — this is what converts T-62-54's
 * O(n²) into O(n).
 *
 * On the pathological shapes above, the two implementations also disagree on RESULT, not just
 * cost: `matchAll` requires a close tag and finds 0 blocks; the linear walk finds 1 block
 * whose content runs to end of input. This is a DELIBERATE, specified behavior change: per
 * HTML §13.2.5, an unterminated `<style>` element's content runs to end of input — exactly
 * the range stage 4's own `findRawtextCloseEnd` fail-safe already deletes. Harvesting it is
 * the FAITHFUL outcome (a browser applies the hiding rule too), not an over-reach: before
 * this closure, a class-hidden payload behind an unterminated `<style>` leaked as prose
 * (under-strip); after, it is correctly hidden, and a separate hiding-signature-negative test
 * confirms harvesting to EOF does not start removing content no rule actually hides
 * (over-strip control).
 *
 * Also closes the T-62-43 cross-stage boundary bug class for `<style>` specifically: BL-01
 * and BL-02 (62-12 gap closure #1, above) were both instances of stage 2 and stage 4 holding
 * DIFFERENT opinions about where a `<style>` element begins and ends. Both properties those
 * fixes established — the CR-01 quote-aware open tag, the BL-02 ATTRS-built close tail
 * (rejecting a simpler `<\/style\b[^>]*>` form, which would both reintroduce the 62-09 source
 * guard's banned substring and reopen a fifth independent boundary opinion) — are now
 * INHERITED by stage 2 rather than re-asserted by a separate regex, because stage 2 uses the
 * exact same `START_TAG_RE` and `RAWTEXT_CLOSE_TAIL_RE` primitives stage 4 already used.
 * There is now only one opinion about a `<style>` element's boundary, not two that happen to
 * agree.
 *
 * `<style/>` (self-closing) is unaffected by this closure — the outer walk below skips any
 * match `SELF_CLOSING_SUFFIX_RE` reports as self-closing, leaving WR-03 (62-REVIEW.md, still
 * open) exactly as it was, not attempting to fix it here.
 *
 * 62-20 gap closure (CR-05/CR-06/CR-08/CR-09, 62-REVIEW.md/62-VERIFICATION.md) — migrates the
 * one part of the CSS layer 62-17 left on raw text: the DECLARATION side. `hasHidingSignature`
 * ran twelve regexes over `css.slice(contentStart, contentEnd)` — comments and escapes
 * included — so `display:/*x*\/none` and `display:\6eone` both applied `display:none` to a
 * conformant engine while this module saw neither (CR-05). `hasHidingSignatureFromTokens`
 * (stage 5, immediately above `hasHidingSignature`) closes this the same way 62-17 closed the
 * selector side: reconstruct from tokens (Comment -> one space, ident-bearing tokens
 * escape-decoded), never compare raw text. Both call sites (`harvestFromStylesheet`'s frame
 * evaluation, `isHiddenStartTag`'s inline-style check) are migrated; a shipped source guard
 * bans a raw-slice call from reappearing. Two structural gaps in the same function are also
 * closed: an unterminated final declaration block is now evaluated at EOF instead of silently
 * abandoned (CR-06), and the 200-selector harvest cap — which failed OPEN, proceeding to strip
 * with a known-incomplete hidden-set once exhausted — is deleted outright rather than resized,
 * measured safe at the 1 MiB input boundary (CR-09). `decodeIdentEscapes` additionally now
 * consumes a CRLF pair as one escape separator per CSS Syntax §3.3, matching css-tree's own
 * decode (CR-08) — MIME's native line ending, not a corner case.
 *
 * 62-22 gap closure (CR-10, 62-REVIEW.md) — closes the LAST T-62-43 cross-stage boundary
 * disagreement this file names: stage 2 and stage 3 held TWO independent opinions about where
 * a comment and a `<style>` element begin and end (`START_TAG_RE`+`findRawtextCloseBounds` vs
 * `HTML_COMMENT_RE`), so a `<style>` open tag written inside an HTML comment could be harvested
 * as a live stylesheet, and an unterminated CDO (`<!--`) inside a `<style>` block could trigger
 * stage 3's own truncation fail-safe and destroy the rest of the document (NF-01). Both stages
 * now read ONE `scanHtml` pass (`htmlparser2@10.0.0`, exact-pinned, 62-21) computed once per
 * `stripHiddenContent` call — see `scanHtml`'s own doc block, placed just above the Stage 2
 * section, for the offset-conversion rule and the three named residuals it accepts rather than
 * hand-rolls a fallback for. `scanHtml` is a RANGES-ONLY primitive (comment ranges, `<style>`
 * content/element ranges, start-tag records) — it never serializes a parse tree, preserving the
 * "range-deleting transformer over the original source" contract every idempotence/entity
 * guarantee below depends on. `startTags` is produced and unit-tested in this plan but not yet
 * consumed by any stage — **plan 62-24 owns wiring it into stages 4/5** (the CR-07
 * attribute-decoding closure); stage 0's hoisted stray-`<` truncation and stage 6's
 * `ANY_TAG_RE` sweep remain hand-rolled scanners after this plan, an ACCEPTED residual, not an
 * oversight (no total-coverage claim is made here).
 *
 * Stage order (load-bearing — see the block comment above each stage):
 *  0. Hoisted stray-`<` fail-safe truncation (62-14, Bound A) — runs immediately after stage
 *     1 and before stage 2; a DUPLICATE of the stage-6 truncation below, not a move of it.
 *     Still a hand-rolled regex scan after 62-22 — no plan in this wave set owns it.
 *  1. Invisible-codepoint removal (zero-width chars, BOM, soft hyphen, invisible math
 *     operators, the Unicode Tags block) — unconditional, applied to ALL input including
 *     plain text, and run FIRST so a payload cannot use zero-width characters to
 *     fragment a later stage's pattern match (e.g. `dis<ZWSP>play:none`). Also exported
 *     standalone as `stripInvisibleCodepoints` (CR-02) for non-markup callers — e.g.
 *     `normalizeGmailMessage`'s provenance header — that need invisible-codepoint removal
 *     WITHOUT the markup semantics of stages 2-6.
 *  1.5. `scanHtml` — ONE conformant `htmlparser2` pass over the post-stage-0/1 string,
 *     computed once and shared by stages 2 and 3 below (62-22, CR-10).
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
 *  3. HTML comment removal — deletes `scanHtml().comments` (62-22) rather than
 *     `HTML_COMMENT_RE` plus an `indexOf('<!--')` truncation fail-safe; the parser sees an
 *     unterminated comment's true extent and never mistakes RAWTEXT content (a CDO inside
 *     `<style>`) for a comment, so the fail-safe this replaced had nothing left to guard.
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
 */

// `src/` may import ONLY `tokenize`/`tokenTypes` from the `/tokenizer` subpath (62-16's
// `src/types/css-tree-tokenizer.d.ts` declares nothing else reachable from here) — never the
// bare `css-tree` package, never its parser/lexer/walker/generator. See the file-level "62-17
// gap closure" section above for the adopted-vs-not-adopted surface and why.
import { tokenize, tokenTypes } from 'css-tree/tokenizer';
// `htmlparser2` (62-21, exact-pinned `10.0.0`) is the single conformant HTML tokenizer this
// module now shares between stage 2 (<style> location) and stage 3 (comment location) — see
// the "62-22 gap closure" section below for why, and `62-21-SUMMARY.md` for the parser's exact
// event/offset semantics this file's offset arithmetic is built against.
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
 * so the FIRST matching close tag ends the element (no depth counting). Returns both
 * boundaries a caller might need — `contentEnd` (the index of the `<` that opens the end
 * tag, i.e. where the element's TEXT CONTENT ends) and `elementEnd` (the index just past
 * the end tag's `>`, i.e. where the ELEMENT itself ends) — or `null` when no matching end
 * tag exists at or after `fromIndex` (62-18, T62-91: added so stage 2's `<style>` walk and
 * stage 4's `findRawtextCloseEnd` share ONE scan instead of stage 2 running a second,
 * independent one).
 *
 * The scan cursor (`RAWTEXT_CLOSE_OPENER_RE.lastIndex`) only ever MOVES FORWARD: a failed
 * sticky tail match at one candidate does not rewind before retrying the opener regex at
 * the next one. This is what makes a caller's "no match found" conclusion transitive — if
 * scanning from `fromIndex` finds no matching close tag, scanning from any `fromIndex' >
 * fromIndex` cannot find one either, since every candidate the second scan would visit was
 * already visited (and rejected) by the first. `harvestHidingSelectors` below relies on
 * exactly this property to break out of its outer loop on the first unterminated `<style>`
 * rather than repeating a failing scan from every subsequent one.
 */
function findRawtextCloseBounds(
  html: string,
  tagName: string,
  fromIndex: number
): { contentEnd: number; elementEnd: number } | null {
  const lower = tagName.toLowerCase();
  RAWTEXT_CLOSE_OPENER_RE.lastIndex = fromIndex;
  let m: RegExpExecArray | null;
  while ((m = RAWTEXT_CLOSE_OPENER_RE.exec(html)) !== null) {
    const name = m[1]!.toLowerCase();
    if (name !== lower) continue;
    RAWTEXT_CLOSE_TAIL_RE.lastIndex = RAWTEXT_CLOSE_OPENER_RE.lastIndex;
    if (RAWTEXT_CLOSE_TAIL_RE.exec(html) !== null) {
      return { contentEnd: m.index, elementEnd: RAWTEXT_CLOSE_TAIL_RE.lastIndex };
    }
    // Sticky tail match failed (e.g. no `>` anywhere after this candidate) — keep
    // scanning forward for another `</tagName` occurrence rather than giving up.
  }
  return null;
}

/**
 * Thin wrapper over `findRawtextCloseBounds` returning only `elementEnd` (or `html.length`
 * on no match, matching `findMatchingCloseEnd`'s fail-safe contract) — kept so stage 4's one
 * remaining caller (`findMatchingCloseEnd`) does not need to unpack the pair itself. The
 * close-tag scan exists exactly ONCE, in `findRawtextCloseBounds` above.
 */
function findRawtextCloseEnd(html: string, tagName: string, fromIndex: number): number {
  const bounds = findRawtextCloseBounds(html, tagName, fromIndex);
  return bounds === null ? html.length : bounds.elementEnd;
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
// scanHtml — ONE conformant parser pass, shared by stage 2 and stage 3 (62-22 gap closure)
// ---------------------------------------------------------------------------

/**
 * 62-22 gap closure (CR-10, 62-REVIEW.md) — gives the module ONE opinion about HTML
 * structure, the adopted parser's (`htmlparser2@10.0.0`, 62-21, exact-pinned), for comments
 * and `<style>` elements. Before this closure, stage 2 (`START_TAG_RE` +
 * `findRawtextCloseBounds`) and stage 3 (`HTML_COMMENT_RE`) held two INDEPENDENT opinions
 * about where a comment and a RAWTEXT element begin and end — the T-62-43 cross-stage
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
 * exclusive convention this file's OTHER primitives (`collectRemovalRanges`,
 * `applyRemovalRanges`, css-tree's own token offsets) already use. Every range this function
 * returns is converted to `[start, end)` exclusive at the point of construction — callers of
 * `scanHtml` never see an inclusive offset. `tests/html-parser-conformance.test.ts` is the
 * gate that keeps the inclusive-offset premise this conversion depends on from silently
 * drifting under a future `htmlparser2` upgrade.
 *
 * Three named residuals, each a deliberate, faithful reading of the parser's OWN behavior
 * rather than a bug this function introduces:
 *  - `</style/>` (D-62-21-01, 62-21-SUMMARY.md): htmlparser2 does not recognize this as a
 *    close tag at all -- the element swallows everything through EOF as RAWTEXT content. This
 *    function does NOT hand-roll a fallback detector for this one shape (a fallback the
 *    residual note flags as an acceptable alternative, not a requirement): the resulting
 *    over-inclusive `styleElements`/`comments` range is MONOTONE TOWARD LESS CONTENT (more of
 *    the document gets treated as hidden `<style>` content, never less), which is this
 *    module's stated safe direction, so accepting the parser's own (deviant) EOF-implied
 *    close here costs nothing beyond what 62-18 already accepted for a genuinely-unterminated
 *    `<style>`.
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
 * the offset-conversion rule, the three named residuals, and the DOCTYPE/bogus-comment folding
 * decision.
 */
export function scanHtml(html: string): HtmlScan {
  const comments: HtmlComment[] = [];
  const styleElements: HtmlStyleElement[] = [];
  const startTags: HtmlStartTag[] = [];

  interface OpenFrame {
    readonly record: HtmlStartTag;
    readonly selfClosingSyntax: boolean;
  }
  const stack: OpenFrame[] = [];

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
        const selfClosingSyntax = SELF_CLOSING_SUFFIX_RE.test(html.slice(tagStart, tagEnd));
        startTags.push(record); // document order -- pushed at OPEN, mutated at CLOSE below
        stack.push({ record, selfClosingSyntax });
      },
      onclosetag(_name: string, isImplied: boolean): void {
        const frame = stack.pop();
        if (!frame) return; // defensive; htmlparser2's own tree construction keeps this balanced
        const closeStart = parser.startIndex;
        const closeEnd = parser.endIndex;
        let elementEnd: number;
        if (!isImplied) {
          // D-62-21-01: the RAWTEXT close tag's OWN reported end may be truncated before the
          // real `>` (`</style foo>`). Forward-scan for it -- a no-op on a well-formed close
          // tag, which is already sitting on its own `>`.
          const realGt = html.indexOf('>', closeEnd);
          elementEnd = realGt === -1 ? closeEnd + 1 : realGt + 1;
        } else if (closeStart < frame.record.tagEnd) {
          // Synthetic close ECHOING the open tag's own position (a void element, or a
          // self-closing void like `<br/>`) -- there is no separate close location; the
          // element's range is exactly its own open tag.
          elementEnd = frame.record.tagEnd;
        } else {
          // EOF-implied, or an ancestor's close tag triggered an implied close: the element's
          // content runs up to (never including) the position the synthetic close was
          // recognized at -- `html.length` for EOF, or the ancestor's own close-tag start.
          elementEnd = closeStart;
        }
        frame.record.elementEnd = elementEnd;

        if (frame.record.name === 'style' && !frame.selfClosingSyntax) {
          // WR-03 (62-REVIEW.md, still open, out of THIS plan's scope): a self-closing
          // `<style/>` is deliberately excluded here, preserving stage 4's own pre-existing
          // `SELF_CLOSING_SUFFIX_RE` treatment of it -- this plan does not touch stage 4, so
          // stage 2 must not silently start harvesting a shape stage 4 still treats as
          // self-closing (that would desynchronize the two stages' opinions again, the exact
          // class this plan exists to close, not reopen).
          styleElements.push({
            contentStart: frame.record.tagEnd,
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
    parser.write(html);
    parser.end();
  } catch {
    return maximallyReducingScan(html);
  }

  // Defensive drain: htmlparser2 always emits a synthetic EOF close for every still-open
  // element (verified directly -- a multiply-nested unclosed input drains the whole stack at
  // EOF, one isImplied close per frame), so this loop is not expected to run. Kept so a future
  // htmlparser2 behavior change cannot silently leave `elementEnd` at its `tagEnd` placeholder.
  for (const frame of stack) {
    frame.record.elementEnd = html.length;
    if (frame.record.name === 'style' && !frame.selfClosingSyntax) {
      styleElements.push({
        contentStart: frame.record.tagEnd,
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

// `STYLE_BLOCK_RE` (a lazy `<style\bATTRS>([\s\S]*?)<\/style\bATTRS>` scan) located `<style>`
// elements here through 62-17. DELETED in 62-18 (T62-91): its lazy `</style>`-tail scan was
// the module's one remaining quadratic. Stage 2 now locates `<style>` elements with the same
// `START_TAG_RE` + `findRawtextCloseBounds` primitives stage 4 already used — see the
// file-level doc block's "62-18 gap closure" section for the cost table and the O(n) argument,
// and `harvestHidingSelectors`'s own doc comment below for the CR-01/BL-01/BL-02 boundary
// decisions this deletion INHERITS rather than re-asserts.

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
 * MANDATORY, not cosmetic: the class/id ATTRIBUTE side (`isHiddenStartTag`, stage 5) is
 * compared literally against an unescaped HTML attribute value, so an undecoded harvested name
 * can NEVER equal a name a browser matches — exactly the defect the 62-16 liveness oracle found
 * and no report had filed (`BARE_CLASS_SELECTOR_RE`/`BARE_ID_SELECTOR_RE` categorically
 * rejected any selector text containing a backslash, so an escaped selector was never even a
 * harvest CANDIDATE, regardless of what it decoded to).
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
 * this module's pre-62-17 `allBare` semantics (`selectors.every(...)`) — reproduced here on
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
 * 62-17 gap closure: replaces the hand-rolled `stripCssComments` + `indexOf`/`lastIndexOf`
 * brace-partition cursor walk entirely with a single `tokenize` pass per `<style>` block
 * (`harvestFromStylesheet`) reading rule boundaries from `{`/`}` TOKENS rather than raw-text
 * brace counting. Brace counting over raw text is retired because raw-text brace counting is
 * the exact mechanism FB-01 probed (a raw-text scan can be desynchronized by a bad string); a
 * `{`/`}` TOKEN cannot be forged by a `BadString`, `Url`/`BadUrl`, or `Function` token, so the
 * class of bug FB-01/CR-04 both probed (something OTHER than the tokenizer deciding a token's
 * boundary) cannot recur here by construction. See `harvestFromStylesheet`'s own doc comment
 * for the frame-stack argument, and `preludeToBareSelectors`'s for the selector-shape argument
 * that replaces `BARE_CLASS_SELECTOR_RE`/`BARE_ID_SELECTOR_RE`.
 *
 * SUPERSEDED, kept for history rather than deleted silently: the 62-14 "Bound B" cursor-walk
 * equivalence argument this replaces was a correct proof that the linear `indexOf`/
 * `lastIndexOf` cursor walk produced the same `(selectorText, body)` pairs as the `matchAll`
 * regex it replaced — see 62-14-SUMMARY.md for the full text. It is now MOOT: this function no
 * longer partitions raw text into `(selectorText, body)` pairs at all, so there is nothing left
 * for that argument to be an equivalence proof ABOUT. The property that argument actually
 * protected — no quadratic blowup on a brace-free or brace-heavy adversarial `<style>` body —
 * is now structural: `tokenize` is one linear pass regardless of brace shape, so there is no
 * failing-scan region to retry, matching this module's WR-02 property by construction rather
 * than by cursor-walk proof.
 *
 * 62-18 gap closure (T62-91): the OUTER loop that finds each `<style>` element's boundaries is
 * now a `START_TAG_RE.exec` cursor walk over `html`, not `html.matchAll(STYLE_BLOCK_RE)` —
 * `STYLE_BLOCK_RE`'s lazy `</style>`-tail scan was the module's one remaining quadratic
 * (T-62-54), and this is what deletes it (see the file-level doc block's "62-18 gap closure"
 * section for the cost table and the O(n) argument). This inherits, rather than re-asserts,
 * the two boundary decisions `STYLE_BLOCK_RE`'s own doc comment used to record:
 *  - OPEN TAG (CR-01/BL-01, 62-12): quote-aware, only an unquoted `<` or `>` terminates it —
 *    a literal `>` inside a quoted attribute value (CR-01) and an unquoted `<` per HTML
 *    §13.2.5.36 (BL-01) are both legal HTML that must not truncate the tag early. This is now
 *    inherited for free: `START_TAG_RE` already has this property, since it is built from the
 *    same shared `ATTRS` fragment `STYLE_BLOCK_RE` used to be built from.
 *  - CLOSE TAG (BL-02, 62-13): `</style foo>` and `</style/>` both legally end a `<style>`
 *    element (the RAWTEXT end-tag-name state transitions to before-attribute-name on
 *    whitespace and to self-closing-start-tag on `/`); a bare `<\/style\s*>` tail would miss
 *    both. Also inherited for free: `findRawtextCloseBounds` (above `findRawtextCloseEnd`)
 *    uses `RAWTEXT_CLOSE_TAIL_RE`, built from the same `ATTRS` fragment, deliberately NOT the
 *    simpler `<\/style\b[^>]*>` a code reviewer once proposed — `[^>]*` would both reintroduce
 *    the exact substring the 62-09 source guard bans and give the close tag a boundary rule
 *    independent of `ANY_TAG_TOKEN_RE`/`START_TAG_RE`.
 * Because stage 2 now uses the EXACT SAME `START_TAG_RE` and `RAWTEXT_CLOSE_TAIL_RE` primitives
 * stage 4 (`findMatchingCloseEnd`/`collectRemovalRanges`) already used, agreement between the
 * two stages about a `<style>` element's boundary is now structural rather than the outcome of
 * two independently-maintained regexes happening to carry the same character class — this
 * closes the T-62-43 cross-stage boundary bug class for `<style>` specifically (BL-01 and
 * BL-02 were both instances of that class).
 *
 * `<style/>` (self-closing) is skipped by the outer walk, unchanged from before this closure —
 * WR-03 (62-REVIEW.md, still open) is not addressed here.
 *
 * On an UNTERMINATED `<style>` (no matching `</style...>` anywhere at or after the open tag),
 * this walk harvests the element's content to end of input, per HTML §13.2.5. This is a
 * deliberate, specified behavior change from `STYLE_BLOCK_RE` (which required a close tag and
 * harvested nothing from an unterminated element): a browser applies an unterminated `<style>`
 * block's rules too, so harvesting is the faithful outcome, not an over-reach.
 *
 * 62-22 gap closure (CR-10, 62-REVIEW.md): the OUTER loop that finds each `<style>` element's
 * boundaries is no longer `START_TAG_RE` + `findRawtextCloseBounds` — it is `scanHtml().styleElements`,
 * computed ONCE per `stripHiddenContent` call and shared with stage 3 (see `scanHtml`'s own doc
 * block, above the Stage 2 header, for the full argument). This closes the LAST remaining
 * instance of the T-62-43 boundary-disagreement class this file has been retiring stage by
 * stage: `<style>`-vs-`<style>` (62-18) and now `<style>`-vs-COMMENT. A `<style>` opening tag
 * that appears inside an HTML comment (`<!-- <style> -->`) can no longer be mistaken for a live
 * element, because `scanHtml`'s single parser pass is the one place that decision is made, for
 * BOTH `comments` and `styleElements` at once — there is no second, independently-maintained
 * regex left to disagree with it. Two decisions this inherits from `scanHtml` rather than
 * re-deriving here:
 *  - A self-closing `<style/>` is excluded from `styleElements` (WR-03, 62-REVIEW.md, still
 *    open, untouched by this plan) — see `scanHtml`'s own comment on why.
 *  - An unterminated `<style>`'s content runs to `html.length` (`contentEnd === elementEnd`),
 *    the SAME 62-18 behavior this doc block's paragraph above describes, now produced by the
 *    parser directly instead of `findRawtextCloseBounds`'s forward-only-cursor break.
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

// ---------------------------------------------------------------------------
// Stage 3 — comment removal
// ---------------------------------------------------------------------------

/**
 * 62-22 gap closure (CR-10, T-62-22-03): deletes `scan.comments` — `scanHtml`'s own,
 * conformant-tokenizer-derived comment ranges — instead of running `HTML_COMMENT_RE` plus an
 * `indexOf('<!--')` truncation fail-safe. That fail-safe existed because a regex over raw text
 * cannot SEE an unterminated comment's true extent (it can only detect "no match, therefore
 * truncate to end of string" — the NF-01 defect: an unmatched CDO/HTML-comment-opener INSIDE a
 * `<style>` block is ordinary, spec-legal CSS syntax, not an HTML comment at all, yet the old
 * fail-safe could not tell the difference and destroyed the rest of the document, including a
 * real `</style>` tag and every visible sentence after it). `scanHtml`'s parser CAN see an
 * unterminated comment's true extent (it reports the comment running to `html.length`, per
 * `tests/html-parser-conformance.test.ts`'s own pinned deviation numbers) and never mistakes
 * RAWTEXT content for a comment in the first place — so the truncation fail-safe has nothing
 * left to guard against and is deleted, not kept as a blunter instrument. `applyRemovalRanges`
 * (already shared with stages 4/5) does the deletion — `scan.comments` is naturally
 * non-overlapping and ascending, since it is built from one forward parser pass, matching that
 * helper's existing contract.
 */
function removeComments(html: string, comments: readonly HtmlComment[]): string {
  return applyRemovalRanges(html, comments.map(c => [c.start, c.end] as [number, number]));
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
 *    module already accounts for elsewhere (see the file-level "62-17 gap closure" section).
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
  // CR-05 call site 2: the inline `style` attribute value goes through the same
  // token-derived reconstruction as the declaration side (`hasHidingSignatureFromTokens`),
  // not straight into `hasHidingSignature`. This value is still the RAW (not yet
  // HTML-entity-decoded) attribute value at this point — CR-07's decoding step lands ahead
  // of it in plan 62-24; the layering is HTML decode first, CSS tokenize second, and this
  // call is the CSS half.
  const style = extractAttr(attrs, STYLE_ATTR_RE);
  if (style !== null && hasHidingSignatureFromTokens(style)) return true;
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

  // 62-22 gap closure (CR-10): ONE `scanHtml` pass, computed here and shared by stage 2 and
  // stage 3 below — see `scanHtml`'s own doc block for why. Ranges are offsets into THIS
  // string (post-stage-0/1), which is exactly the basis every later stage already works on;
  // do not compute a second scan and do not re-scan after a deletion.
  const scan = scanHtml(s);

  // Stage 2: harvest class/id hiding selectors from <style> blocks before they're
  // discarded in stage 4.
  const { classes: hiddenClasses, ids: hiddenIds } = harvestHidingSelectors(s, scan.styleElements);

  // Stage 3: strip comments.
  s = removeComments(s, scan.comments);

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
