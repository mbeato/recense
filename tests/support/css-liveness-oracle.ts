/**
 * TEST-ONLY liveness oracle (62-16-PLAN.md, Task 3).
 *
 * `WR-09` (`62-REVIEW.md`) named the root cause behind three waves of missed EMAIL-03
 * defects: every shipped oracle was drawn from the same enumeration it existed to
 * validate, so a defect outside that enumeration was structurally unfindable. This module
 * is the first oracle in the phase that answers a DIFFERENT question than the production
 * code: given a stylesheet's text, which bare `.class` / `#id` names does a conformant CSS
 * engine treat as carrying a genuinely live `display:none`-class hiding declaration — using
 * css-tree's PARSER (its §5.4 layer), not the production regex/cursor scan `strip-hidden.ts`
 * hand-rolls.
 *
 * MUST NEVER be imported from `src/` — it is test-only ground truth. It shares only the
 * tokenizer with the production path (independently gated against §4.3 by
 * `tests/css-tokenizer-conformance.test.ts`); the parse layer and selector-validity
 * judgments this file exercises are precisely the layers `strip-hidden.ts` hand-rolls, so
 * importing `hasHidingSignature` from production here would make this oracle circular on
 * the declaration side. Its semantics are RE-DESCRIBED below instead (see
 * `hasHidingSignature`), duplicated deliberately.
 *
 * Deliberately does NOT evaluate `@media`/`@supports` conditions — `walk()` finds `Rule`
 * nodes at any nesting depth, including inside an `@media` block, and treats them exactly
 * like a top-level rule. This is not an oversight: production's brace-partition scan has
 * the identical blind spot (it finds `selector{body}` patterns anywhere, including inside
 * `@media`, with no awareness of the surrounding at-rule). Sharing the blind spot is
 * intentional — see the adjudication test's `@media screen`/`@media print` rows, which pin
 * this as an ACCEPTED over-strip rather than leaving it an unstated assumption.
 */
import { parse, walk, ident } from 'css-tree';

// ---------------------------------------------------------------------------
// hasHidingSignature, RE-DESCRIBED from src/source/strip-hidden.ts (NOT imported — see
// file-level doc comment). Kept in agreement by the adjudication test's own coverage of
// both this oracle and the shipped module, not by a shared import.
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

function isZeroValue(text: string, re: RegExp): boolean {
  const m = text.match(re);
  return m !== null && parseFloat(m[1]!) === 0;
}

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
 * (disqualified per `62-16-PLAN.md`'s `<decision_record>` item 2) lacks.
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
    parseValue: false,
    parseCustomProperty: false,
    positions: true,
    onParseError: () => {
      // Swallowed deliberately — best-effort AST, matching browser error recovery.
    },
  });

  walk(ast, (node: any) => {
    if (node.type !== 'Rule') return;
    if (node.prelude.type !== 'SelectorList') return; // Raw prelude -> dead rule

    const blockLoc = node.block.loc;
    if (!blockLoc) return; // positions:true is always set above; defensive only
    const blockText = css.slice(blockLoc.start.offset, blockLoc.end.offset);
    if (!hasHidingSignature(blockText)) return;

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
