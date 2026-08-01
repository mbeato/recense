/**
 * TEST-ONLY liveness oracle (62-16-PLAN.md, Task 3; declaration layer rewritten 62-25-PLAN.md,
 * Task 1).
 *
 * `WR-09` (`62-REVIEW.md`) named the root cause behind three waves of missed EMAIL-03
 * defects: every shipped oracle was drawn from the same enumeration it existed to
 * validate, so a defect outside that enumeration was structurally unfindable. This module
 * is the first oracle in the phase that answers a DIFFERENT question than the production
 * code: given a stylesheet's text, which bare `.class` / `#id` names does a conformant CSS
 * engine treat as carrying a genuinely live hiding declaration — using css-tree's PARSER
 * (its §5.4 layer) for both the selector and (as of 62-25) the declaration layer, never a
 * copy of production's own logic.
 *
 * 62-25 gap closure (CR-11/T-62-25-03): through 62-24 this file's declaration-signature check
 * (`hasHidingSignature`) was a line-for-line COPY of production's twelve regexes, run over a
 * raw source-text slice of the rule's block (`css.slice(blockLoc.start, blockLoc.end)`). That
 * made the judge share its decision procedure with the judged on exactly the layer where
 * CR-05's leaks lived (`display:/*x*\/none`, `display:\6eone` both slipped past both sides
 * identically) — copying a raw-text regex over a comment-containing slice was ALSO an
 * independent false-positive risk in its own right (a `/*display:none*\/color:red` block would
 * have matched the raw-text regex even though the tokenizer never sees "display:none" as CSS
 * text at all). Both defects are structural, not incidental, and are why the declaration side
 * is rewritten here to read PARSED `Declaration` nodes (`property`/`value`, from `parse(css,
 * { parseValue: true })`) instead of re-running a text pattern over unprocessed source. The
 * twelve hiding shapes keep the same SEMANTICS production's registry encodes, but every shape
 * is now decided from the AST css-tree already built, not from a second opinion about what the
 * source text says.
 *
 * WHAT THIS ORACLE NOW SHARES WITH PRODUCTION: only the css-tree TOKENIZER (its §4.3 layer),
 * independently gated against the spec text by `tests/css-tokenizer-conformance.test.ts` (built
 * from the spec, not from either this oracle or production). A tokenizer defect shared by both
 * layers would still be invisible to any differential built on this oracle — that residual is
 * real and is not claimed closed by this rewrite.
 *
 * WHAT THIS ORACLE NO LONGER SHARES WITH PRODUCTION (as of 62-25): the declaration-signature
 * layer. `liveHidingSelectors` derives its hiding verdict from css-tree's own parsed
 * `Declaration.property`/`Declaration.value` nodes; production's `hasHidingSignatureFromTokens`
 * (`src/source/strip-hidden.ts`) derives its verdict from a hand-reconstructed token-text
 * string fed through twelve regexes. Two independent implementations of the same twelve
 * semantic shapes, not one implementation compared against itself.
 *
 * WHAT REMAINS A BLIND SPOT AFTER 62-25: the selector-decode layer (`ident.decode`, shared with
 * production's `decodeIdentEscapes` only in the sense that both ultimately trust css-tree's own
 * escape-decoding semantics — a defect in css-tree's own decode would be invisible to either
 * side); and, as documented below, `@media`/`@supports` condition evaluation (deliberately
 * unevaluated by both this oracle and production — a shared, STATED blind spot, not an
 * oversight).
 *
 * MUST NEVER be imported from `src/` — it is test-only ground truth, enforced by the
 * plan-62-23 import-boundary test.
 *
 * Deliberately does NOT evaluate `@media`/`@supports` conditions — `walk()` finds `Rule`
 * nodes at any nesting depth, including inside an `@media` block, and treats them exactly
 * like a top-level rule. This is not an oversight: production's harvest has the identical
 * blind spot (it walks rule frames wherever they occur, with no awareness of the surrounding
 * at-rule). Sharing the blind spot is intentional — see the adjudication test's `@media
 * screen`/`@media print` rows, which pin this as an ACCEPTED over-strip rather than leaving it
 * an unstated assumption.
 */
import { parse, walk, ident } from 'css-tree';

// ---------------------------------------------------------------------------
// Declaration-layer hiding-signature check — reads css-tree's own PARSED `Declaration` nodes
// (property + value, from a `parseValue: true` parse), never a copy of production's regexes
// and never a raw source-text slice. The twelve shapes below are semantically the same
// registry production's `hasHidingSignature` (`src/source/strip-hidden.ts`) encodes, RE-
// DESCRIBED structurally, not imported — kept in agreement by the adjudication test's own
// coverage of both this oracle and the shipped module, not by a shared import or a shared
// regex literal.
// ---------------------------------------------------------------------------

/**
 * The first non-whitespace/non-comment child of a parsed `Value` node, or `null` for an empty
 * value or a `Raw` fallback (the value failed to parse structurally — css-tree's own generic
 * grammar rejected it; ground truth for that declaration is then simply "not a recognized
 * hiding shape", the same conservative default an unmatched regex would have produced).
 * `Value.children` never contains whitespace/comment nodes — css-tree's own sequence reader
 * strips both while building the list, so no explicit skip is needed here.
 */
function firstValueChild(value: any): any | null {
  if (!value || value.type !== 'Value') return null;
  return value.children.first ?? null;
}

/** Decoded (§4.3.7), lowercased identifier equality — `node.name`/`node.property` come back
 *  RAW (still-escaped) from css-tree's reader (`this.consume(Ident)`, a plain substring), so
 *  every ident-bearing comparison in this file decodes via `ident.decode` first, exactly like
 *  the selector layer already does. */
function decodedIdentEquals(node: any, target: string): boolean {
  return node !== null && node.type === 'Identifier' && ident.decode(node.name).toLowerCase() === target;
}

function decodedFunctionNameIs(node: any, target: string): boolean {
  return node !== null && node.type === 'Function' && ident.decode(node.name).toLowerCase() === target;
}

/** `opacity`/`font-size`/`(max-)?height`/`(max-)?width`: exactly-zero check on a Number,
 *  Dimension or Percentage value node — mirrors production's `isZeroValue` (`parseFloat(...)
 *  === 0`), read from the node's own numeric text instead of a regex-captured group. */
function isZeroNumeric(node: any): boolean {
  if (node === null) return false;
  if (node.type !== 'Number' && node.type !== 'Dimension' && node.type !== 'Percentage') return false;
  const n = parseFloat(node.value);
  return !Number.isNaN(n) && n === 0;
}

/** `text-indent`: a negative Number/Dimension value node — mirrors production's
 *  `TEXT_INDENT_NEGATIVE_RE` (a literal leading "-" immediately after the colon). */
function isNegativeNumeric(node: any): boolean {
  return (
    node !== null &&
    (node.type === 'Number' || node.type === 'Dimension') &&
    typeof node.value === 'string' &&
    node.value.startsWith('-')
  );
}

/** `left`/`top`: an "off-canvas" negative value whose magnitude's integer part is at least
 *  three digits — mirrors production's `OFFCANVAS_POSITION_RE` (`-\d{3,}` immediately after
 *  the colon, i.e. the digit run right after the minus sign, before any decimal point, is
 *  3+ characters long). Read from the node's own raw numeric text, not a source-text regex. */
function isOffCanvasNegative(node: any): boolean {
  if (node === null || (node.type !== 'Number' && node.type !== 'Dimension')) return false;
  const raw: string = node.value;
  if (!raw.startsWith('-')) return false;
  const digits = /^\d+/.exec(raw.slice(1));
  return digits !== null && digits[0].length >= 3;
}

/** `clip: rect(0...)`: the `rect(` function's first argument's raw numeric text starts with
 *  "0" — mirrors production's `CLIP_RECT_ZERO_RE` (`clip\s*:\s*rect\(\s*0`, a literal "0"
 *  character immediately after "rect(" and optional whitespace) exactly, including its
 *  looseness (a first argument of "0.5" also matches, same as the regex it replaces). */
function isClipRectZero(node: any): boolean {
  if (!decodedFunctionNameIs(node, 'rect')) return false;
  const arg = node.children.first ?? null;
  return (
    arg !== null &&
    (arg.type === 'Number' || arg.type === 'Dimension') &&
    typeof arg.value === 'string' &&
    arg.value.startsWith('0')
  );
}

/** `clip-path: inset(100%...)`: the `inset(` function's first argument is a Percentage whose
 *  raw numeric text starts with "100" — mirrors production's `CLIP_PATH_FULL_RE`
 *  (`clip-path\s*:\s*inset\(\s*100%`) exactly. */
function isClipPathFullInset(node: any): boolean {
  if (!decodedFunctionNameIs(node, 'inset')) return false;
  const arg = node.children.first ?? null;
  return arg !== null && arg.type === 'Percentage' && typeof arg.value === 'string' && arg.value.startsWith('100');
}

/**
 * True when `decl` (a parsed `Declaration` node) carries one of the twelve named hiding
 * shapes. `decl.property` is decoded+lowercased before comparison (§4.3.7 escapes apply to
 * property names too, not just selector names — `disp\6cay:none` must resolve the same as
 * `display:none`). Only the FIRST non-whitespace value-child is inspected per shape, matching
 * each mirrored regex's own single-capture behavior.
 */
function declarationHasHidingSignature(decl: any): boolean {
  const property = ident.decode(decl.property).toLowerCase();
  const first = firstValueChild(decl.value);

  switch (property) {
    case 'display':
      return decodedIdentEquals(first, 'none');
    case 'visibility':
      return decodedIdentEquals(first, 'hidden') || decodedIdentEquals(first, 'collapse');
    case 'opacity':
    case 'font-size':
    case 'height':
    case 'max-height':
    case 'width':
    case 'max-width':
      return isZeroNumeric(first);
    case 'text-indent':
      return isNegativeNumeric(first);
    case 'left':
    case 'top':
      return isOffCanvasNegative(first);
    case 'clip':
      return isClipRectZero(first);
    case 'clip-path':
      return isClipPathFullInset(first);
    default:
      return false;
  }
}

/** True when ANY declaration in `block` (a parsed Rule's `Block` node) carries a live hiding
 *  signature — mirrors production's "any one declaration in the block is enough" semantics
 *  (the old raw-text regex ran unconditionally over the whole block slice, matching
 *  regardless of which declaration the match came from; walking every `Declaration` child and
 *  OR-ing their individual verdicts reproduces exactly that scope, structurally). Non-
 *  `Declaration` block children (a `Raw` fallback from an unparseable declaration, or a
 *  nested `Atrule`/`Rule`) are skipped — a declaration that failed to parse structurally
 *  carries no hiding verdict either way, the same conservative default a non-matching regex
 *  would have produced. */
function blockHasHidingSignature(block: any): boolean {
  for (const child of block.children) {
    if (child.type === 'Declaration' && declarationHasHidingSignature(child)) return true;
  }
  return false;
}

/**
 * Result of `liveHidingSelectors`. `classes`/`ids` hold DECODED (unescaped) names — the
 * names a browser would actually compare against an element's `class`/`id` attribute
 * value. `unresolved` holds RAW (still-escaped) selector text for any name whose decode
 * required css-tree's own U+FFFD fallback (an escape encoding zero, a surrogate, or a
 * code point past the maximum) — a fabricated replacement character could never truthfully
 * equal a real HTML class/id token, so such names are reported as a limitation rather than
 * silently compared as if they were ordinary text.
 */
export interface LiveHidingSelectors {
  classes: Set<string>;
  ids: Set<string>;
  unresolved: string[];
}

/**
 * Decodes a css-tree selector `name` per CSS Syntax Level 3 §4.3.7 using css-tree's OWN
 * `ident.decode` — the same decode logic its tokenizer's escape handling is built on —
 * rather than a hand-rolled re-implementation, so this oracle's decoding can never drift
 * from the library its raw (still-escaped) selector names come from. css-tree's parser
 * does NOT decode `ClassSelector`/`IdSelector.name` itself: `.leg\61 l` arrives as the raw
 * 7-character string `leg\61 l`, not `legal`. Skipping this step would make the oracle
 * silently reproduce the exact leak it exists to detect (the three escaped-selector rows
 * in the adjudication test).
 */
function decodeSelectorName(raw: string): { decoded: string; ok: boolean } {
  const decoded = ident.decode(raw);
  return { decoded, ok: !decoded.includes('�') };
}

/**
 * Given a stylesheet's text, returns which bare `.class` / `#id` selector names (no
 * combinators, no compounds, no pseudo-classes/attribute-selectors) a conformant CSS
 * engine treats as carrying a live hiding declaration.
 *
 * Parses with `onParseError` swallowing so a malformed stylesheet produces a best-effort
 * AST rather than throwing — the error-recovery behavior real browsers have and postcss
 * (disqualified per `62-16-PLAN.md`'s `<decision_record>` item 2) lacks. `parseValue: true`
 * (62-25 gap closure) additionally parses each declaration's value into structured nodes
 * (`Number`/`Dimension`/`Percentage`/`Identifier`/`Function`/...) instead of leaving it as
 * unparsed `Raw` text — see `declarationHasHidingSignature` above for what reads those nodes.
 *
 * A rule contributes only when its `prelude` is a `SelectorList` — a `Raw` prelude means
 * the selector failed to parse, so the rule is DEAD (this is the distinction that decides
 * CR-04 shape 2 and the NEW-01 shape: `xurl(a/*z*\/b).legal` and `a<x{q:1}` both produce a
 * `Raw` prelude and contribute nothing).
 */
export function liveHidingSelectors(css: string): LiveHidingSelectors {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const unresolved: string[] = [];

  const ast = parse(css, {
    parseValue: true,
    parseCustomProperty: false,
    onParseError: () => {
      // Swallowed deliberately — best-effort AST, matching browser error recovery.
    },
  });

  walk(ast, (node: any) => {
    if (node.type !== 'Rule') return;
    if (node.prelude.type !== 'SelectorList') return; // Raw prelude -> dead rule

    if (!blockHasHidingSignature(node.block)) return;

    for (const selector of node.prelude.children) {
      if (selector.type !== 'Selector') continue;
      const parts = [...selector.children];
      if (parts.length !== 1) continue; // combinator/compound -> not a bare selector
      const only = parts[0]!;
      if (only.type !== 'ClassSelector' && only.type !== 'IdSelector') continue;
      const raw = (only as { name: string }).name;
      const { decoded, ok } = decodeSelectorName(raw);
      if (!ok) {
        unresolved.push(raw);
        continue;
      }
      if (only.type === 'ClassSelector') classes.add(decoded);
      else ids.add(decoded);
    }
  });

  return { classes, ids, unresolved };
}
