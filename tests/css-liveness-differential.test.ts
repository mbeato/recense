/**
 * css-liveness-differential.test.ts (62-19-PLAN.md, Task 1) — the oracle-driven,
 * both-directions differential this phase's WR-09 closure requires.
 *
 * WR-09 (62-REVIEW.md) named the exact reason CR-04 survived three prior waves of
 * measurement: every shipped oracle for the CSS layer — the ground-truth-by-construction
 * generator, the differential harness, the deterministic fuzz test — was drawn from the
 * SAME case enumeration it existed to validate, so a defect outside that enumeration was
 * structurally unfindable regardless of corpus size. This file is the first oracle in the
 * phase that satisfies all three of WR-09's constraints at once:
 *   1. its generated alphabet (`TOKEN_ALPHABET` below) is derived from the css-tree
 *      tokenizer's own token-type list, not from this phase's case-report history, and its
 *      exhaustive k=2 cross product can (and does) construct the `<letter>url(` adjacency
 *      CR-04 exploited without anyone having had to think of it specifically;
 *   2. its ground truth comes from `liveHidingSelectors` (62-16) — css-tree's PARSER,
 *      independent of recense's own harvest code — not from a second copy of the module
 *      under test, so a defect shared by two versions of the SAME implementation is no
 *      longer invisible to it;
 *   3. every assertion below checks hidden-content LEAKAGE (a payload marker's presence or
 *      absence in both directions), not totality/idempotence/no-stray-`<` alone.
 *
 * IT WORKED: running the three generators below against the shipped module surfaced FOUR
 * previously-undiscovered defects (NF-01..NF-05, see the "Newly discovered defects" section
 * at the end of this file) that no prior wave's case-driven oracle could have found, because
 * none of them involve a `url(`/comment/escape shape at all — they involve CSS constructs
 * (comma-separated selector lists, blockless at-rules, CDO/CDC tokens) nobody on this phase
 * had reason to enumerate. This is exactly the WR-09 failure mode being closed: a
 * differential drawn from the same case enumeration it validates cannot find a defect
 * outside that enumeration; this one's alphabet was NOT drawn from that enumeration, and it
 * found four. NF-01 closed as a predicted side effect of 62-22 (CR-10); NF-03/04/05 remain
 * open (CSS-tokenizer layer, out of every plan's scope in this wave set so far) — each is
 * locked as a named, dedicated `it.fails` reproduction so the finding stays visible and
 * reproducible, matching the precedent `tests/css-liveness-adjudication.test.ts` already
 * established for FB-01/CR-04.
 *
 * 62-25 gap closure (CR-11, T-62-25-01/02): through 62-19..62-24, EVERY leak this differential
 * found — named (NF-03/04/05) or not — landed in one bucket (`NFDANGER_leak`) bounded only by
 * an upper-magnitude assertion (`< pairCount * 0.05`). A magnitude bound is a counter, not a
 * gate: `62-VERIFICATION.md` independently re-ran the shipped exhaustive cross-product and
 * measured 19 genuine leaks passing silently under that bound, with room for 77 more before it
 * would even notice — directly contradicting this file's own three test titles ("zero
 * unclassified divergences"), which described a property the suite never actually enforced.
 * This plan closes that gap: every leak is now attributed to a NAMED mechanism with its own
 * structural predicate and its own exact-count assertion, or it is unattributed and fails the
 * suite outright (`attributeLeak`, below) — the gate is proven blocking by Task 3's injection
 * proof, recorded in `62-25-SUMMARY.md`, not merely asserted.
 *
 * WHAT THIS ORACLE CAN DETECT: a divergence between recense's harvest and a conformant CSS
 * engine's verdict on ANY input its three generators can construct — including shapes
 * nobody on this phase enumerated, because the generators' alphabet and combination
 * strategy do not consult recense's own code or this phase's case-report history at any
 * point.
 *
 * WHAT THIS ORACLE CANNOT DETECT: a defect the judge SHARES with the production path.
 * `liveHidingSelectors` and `stripHiddenContent` both ultimately read the SAME
 * `css-tree/tokenizer` token stream (62-16/62-17) — the oracle's PARSE and
 * SELECTOR-VALIDITY layers (css-tree's `parse`/`walk`, §5.4) are independent of
 * production's hand-written token-shape matcher (`preludeToBareSelectors`), but the
 * TOKENIZER layer underneath both is the exact same third-party code. A tokenizer defect
 * shared by both layers would therefore be invisible to this differential by construction.
 * That risk is not left unmitigated: the tokenizer half is independently gated against CSS
 * Syntax Level 3 §4.3 by `tests/css-tokenizer-conformance.test.ts`, built from the spec
 * text, not from either this oracle or production. Naming this residual here, rather than
 * claiming the oracle is unconditional, is the point — an oracle with an unstated blind
 * spot is how this phase got to WR-09 in the first place (T-62-19-01, this plan's threat
 * register).
 *
 * A SECOND, NARROWER RESIDUAL of this specific file: the over-strip bucket (`NFSAFE_overStrip`)
 * is NOT narrowed to a per-mechanism structural predicate the way the leak buckets are as of
 * 62-25 — WR-11/12/13 (`62-REVIEW.md`) are out of this plan's fix scope, and building
 * per-mechanism over-strip predicates was judged out of scope for the same reason. It is,
 * however, no longer absorbed by a magnitude bound either: it carries an exact count per
 * generator, so a change in over-strip volume still fails loudly and must be dispositioned,
 * even though WHICH mechanism moved stays undifferentiated. This is a real, named residual —
 * not silently assumed complete — and is carried forward in `62-25-SUMMARY.md`'s residual
 * register.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenize, tokenTypes } from 'css-tree/tokenizer';
import { parse as parseCss, walk as walkCss, ident } from 'css-tree';
import { liveHidingSelectors, type LiveHidingSelectors } from './support/css-liveness-oracle';
import { classMarker, idMarker, throwIfFailures } from './support/differential-helpers';
import { stripHiddenContent } from '../src/source/strip-hidden';

// ---------------------------------------------------------------------------
// Deterministic seeded LCG (Numerical Recipes constants) — the same convention used
// throughout tests/strip-hidden.test.ts. NOT Math.random: every failure below is
// reproducible purely from the printed generating input, with no seed bookkeeping needed.
// ---------------------------------------------------------------------------
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// TOKEN_ALPHABET — one representative source fragment per css-tree tokenizer token type
// (WR-09 item 1's fix). Derived from `tokenTypes`'s own name list (asserted below by the
// coverage test, not just claimed in prose): each entry is chosen so that tokenizing it in
// isolation visits the named type at least once. This is what makes the exhaustive k=2
// cross product below able to construct `<letter>url(` — CR-04's exact adjacency — and
// every other token-boundary shape, without the alphabet having been built by re-reading
// this phase's own case reports. It is also what surfaced NF-01..NF-05: none of them
// involve `url(` at all, and the alphabet reaches them anyway because it was derived from
// the tokenizer's own type list, not from this phase's history.
// ---------------------------------------------------------------------------
const TOKEN_ALPHABET: readonly string[] = [
  '/*c*/', '/*', '*/', // Comment (closed, unterminated-open, close-only-as-two-Delims)
  '"s"', "'s'", '"x\n', // String (double, single), BadString (unterminated across a newline)
  'url(a)', 'url(', 'URL(', 'url("a")', 'xurl(', 'url(a b)', // Url, unterminated Url, case, quoted-Url (Function+String), Ident+LeftParenthesis (NOT a Url/Function), BadUrl (unquoted space)
  'f(', // Function
  ')', '(', '[', ']', '{', '}', // Right/LeftParenthesis, brackets, curlies
  ',', ':', ';', // Comma, Colon, Semicolon
  '#h', '#1a', // Hash (ident-start name, unrestricted/digit-start name)
  '@media', // AtKeyword
  '\\', '\\61 ', '\\/', // Delim (lone trailing backslash), a hex escape, an identity escape
  'ident', 'a', 'x', // Ident
  '1', '1px', '50%', // Number, Dimension, Percentage
  '<!--', '-->', // CDO, CDC
  ' ', '\n', // WhiteSpace (space, newline)
  '.', '*', '>', '+', '~', '|', // Delim (combinators / selector punctuation)
];

describe('css-liveness-differential — TOKEN_ALPHABET coverage', () => {
  it('spans every css-tree tokenizer token type the callback API can emit (26 named types minus EOF, which tokenize() never invokes the callback for)', () => {
    const seen = new Set<number>();
    for (const frag of TOKEN_ALPHABET) {
      tokenize(frag, type => {
        seen.add(type);
      });
    }
    const namedTypeCount = Object.keys(tokenTypes).length;
    expect(namedTypeCount).toBe(26);
    expect(seen.size).toBeGreaterThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// Oracle self-test (62-25-PLAN.md Task 1): the six declaration-layer independence behaviors
// the oracle rewrite (`tests/support/css-liveness-oracle.ts`) must produce, asserted here
// (not in `tests/css-liveness-adjudication.test.ts`) because this plan's own `files_modified`
// scope is exactly this file and the oracle module itself — no third file is touched to ship
// these locks. Behaviors 1-3 are genuine FIXES (the old oracle, which ran production's twelve
// regexes over a raw block-text slice, got all three wrong — see the oracle's own updated
// file-level doc comment for the false-positive/false-negative trace on each). Behavior 4 is a
// preserved-behavior regression guard (the old oracle already got it right). Behaviors 5-6 are
// already independently enforced by shipped tests this plan does not modify
// (`tests/src-import-boundary.test.ts`'s src-side boundary guard; the FB-01/CR-04/NEW-01 rows
// in `tests/css-liveness-adjudication.test.ts`, which already exercise malformed CSS through
// `liveHidingSelectors` without throwing) — re-asserted here in this behavior's own terms so
// the six-item list from the plan is fully accounted for in one place.
// ---------------------------------------------------------------------------
describe('css-liveness-oracle — 62-25 Task 1: declaration-layer independence (CR-05 blind spot closed)', () => {
  it('behavior 1 (FIX): display:/*x*/none — a comment between the colon and the value no longer hides a live declaration from the oracle (old oracle: NOT live, wrong; new oracle: LIVE)', () => {
    const { classes } = liveHidingSelectors('.legal{display:/*x*/none}');
    expect(classes.has('legal')).toBe(true);
  });

  it('behavior 2 (FIX): display:\\6eone — a hex-escaped ident value ("none" spelled \\6e + "one") resolves to a live hiding declaration (old oracle: NOT live, wrong; new oracle: LIVE)', () => {
    const { classes } = liveHidingSelectors('.legal{display:\\6eone}');
    expect(classes.has('legal')).toBe(true);
  });

  it('behavior 3 (FIX): /*display:none*/color:red — a hiding declaration entirely INSIDE a comment is not a declaration at all (a browser never tokenizes it), so the rule is NOT live (old oracle: LIVE, a false positive from matching raw comment text; new oracle: NOT live)', () => {
    const { classes } = liveHidingSelectors('.legal{/*display:none*/color:red}');
    expect(classes.has('legal')).toBe(false);
  });

  it('behavior 4 (preserved): opacity:0.85 is NOT live (not exactly zero); opacity:0 IS live', () => {
    expect(liveHidingSelectors('.legal{opacity:0.85}').classes.has('legal')).toBe(false);
    expect(liveHidingSelectors('.legal{opacity:0}').classes.has('legal')).toBe(true);
  });

  it('behavior 5: the oracle module imports nothing from src/ (also independently enforced from the src/ side by the shipped tests/src-import-boundary.test.ts, not modified by this plan)', () => {
    const oracleSource = readFileSync(resolve(__dirname, 'support', 'css-liveness-oracle.ts'), 'utf8');
    expect(oracleSource).not.toMatch(/from\s+['"][^'"]*\/src\//);
    expect(oracleSource).not.toMatch(/require\(\s*['"][^'"]*\/src\//);
  });

  it('behavior 6: a malformed stylesheet still produces a best-effort AST rather than throwing (onParseError swallowed, browser-like error recovery)', () => {
    // Unterminated block (no closing "}"): css-tree recovers to EOF, the same browser-like
    // behavior 62-18 already relies on for unterminated <style> harvest — the declaration
    // still parses cleanly, so the rule IS live, not an exception.
    expect(() => liveHidingSelectors('.legal{display:none')).not.toThrow();
    expect(liveHidingSelectors('.legal{display:none').classes.has('legal')).toBe(true);
    // CR-04 shape 2 (invalid prelude, `xurl(a/*z*/b)` glued onto `.legal`): the Rule's own
    // prelude fails to parse as a SelectorList (Raw fallback), so the rule contributes
    // nothing — not an exception, and not a false LIVE either.
    expect(() => liveHidingSelectors('xurl(a/*z*/b).legal{display:none}')).not.toThrow();
    expect(liveHidingSelectors('xurl(a/*z*/b).legal{display:none}').classes.has('legal')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Accepted-divergence allowlist — named, predicate-checked, counted. NEVER a blanket
// tolerance: every entry below is either (a) a documented case where agreement is EXPECTED
// and the standard checks run unmodified — counted for coverage, never skipped (AD-01,
// AD-02), (b) a genuine skip of an input whose ground truth is itself undefined (AD-03), or
// (c) a completeness placeholder this generator structurally cannot trigger (AD-04).
// ---------------------------------------------------------------------------
interface AllowlistCounters {
  /** AD-01: an `@media`-containing input was checked. Both the oracle and production walk
   *  into at-rule bodies without evaluating the query, so agreement is EXPECTED — the
   *  standard checks below run unmodified; if they fail on such an input, that is a real
   *  failure, not an allowlisted one (per this plan's own instruction). */
  AD01: number;
  /** AD-02: an id probe whose name does not start with an ident-start code point (an
   *  "unrestricted hash" per CSS Syntax terms, e.g. `#1abc`) was checked. Verified directly
   *  against css-tree's own parser (see `RULE_LIBRARY`'s `1digitH` entry and this file's own
   *  empirical check during planning): the oracle's PARSER accepts `#<unrestricted-hash>` as
   *  a valid `IdSelector` exactly like production's plain-Hash-token harvest does
   *  (strip-hidden.ts residual (e)) — both sides already agree, so this counter is
   *  coverage-only, never a skip. */
  AD02: number;
  /** AD-03: the oracle could not decode one or more selector names on THIS SPECIFIC input
   *  (an escape encoding U+0000, a UTF-16 surrogate, or a code point past U+10FFFF) — ground
   *  truth is undefined for that input, so its checks are skipped entirely rather than risk
   *  a false failure built on an unreliable verdict. */
  AD03: number;
  /** AD-04: an input whose `<style>` element has no end tag (62-18's unterminated-`<style>`
   *  harvest-to-EOF behavior). This differential's own `html` construction always closes
   *  `</style>` explicitly, so this predicate is structurally unreachable here — included
   *  and asserted at exactly zero, so the constraint stays visible rather than silently
   *  omitted. */
  AD04: number;
}

function newAllowlistCounters(): AllowlistCounters {
  return { AD01: 0, AD02: 0, AD03: 0, AD04: 0 };
}

/**
 * Newly-filed-defect buckets — NOT an allowlist entry, NOT accepted as fine.
 *
 * 62-25 gap closure (CR-11, T-62-25-01): through 62-19..62-24 every leak (`NFDANGER_leak`)
 * fell into ONE bucket bounded only by an upper-magnitude assertion (less than 5% of the
 * generator's pair count) — a magnitude bound is a counter, not a gate, and
 * `62-VERIFICATION.md` independently measured 19 genuine leaks passing silently under that
 * bound with room for 77 more before it would even notice. This
 * plan replaces the single bounded bucket with NAMED, PER-MECHANISM counters (`NF03_*`,
 * `NF04_*`, `NF05_*` below), each backed by its own structural predicate and its own minimal
 * `it.fails` reproduction in the "Newly discovered defects" section at the end of this file.
 * A leak matching NO named predicate is no longer counted anywhere — it is pushed straight to
 * `failures` (see `runDifferential`'s `attributeLeak` helper) and fails the suite. Every
 * per-mechanism counter below is asserted with `toBe(<exact count>)`, not a bound: a NEW
 * instance of a KNOWN mechanism must fail loudly, the same way an unnamed one already does.
 */
interface NewlyFiledCounters {
  /** NF-01: CLOSED by 62-22 (CR-10, `scanHtml`) -- an unmatched CDO ("<!--" with no later
   *  "-->" anywhere in the whole document) inside a `<style>` block no longer trips stage 3's
   *  old unterminated-HTML-comment fail-safe (deleted; see `removeComments`'s own doc
   *  comment), because the parser never mistakes RAWTEXT content for a comment in the first
   *  place. This counter is OBSERVABILITY-ONLY and unrelated to the leak/over-strip gate below
   *  (an unmatched-CDO input was generated and is no longer skipped -- see `runDifferential`'s
   *  own comment): every input that trips it flows through the SAME VISIBLE_SENTENCE / leak /
   *  over-strip checks every other input gets, rather than returning early. Detected
   *  structurally (not by re-running production), so counting it cannot silently widen to
   *  cover an unrelated failure. */
  NF01_cdoTruncation: number;
  /** NF-03 (open, CSS-tokenizer layer, out of this plan's fix scope): a comma-separated
   *  selector list is rejected all-or-nothing rather than per-selector
   *  (`preludeToBareSelectors`'s `allBare` semantics) — a bare hiding selector sharing a comma
   *  list with any non-bare sibling is silently dropped from the harvest. Detected by
   *  `isNf03CommaList`, a structural check independent of production (css-tree's own
   *  parser/walker, never `preludeToBareSelectors`). Minimal repro: "a,.legal{display:none}". */
  NF03_commaList: number;
  /** NF-04 (open, CSS-tokenizer layer, out of this plan's fix scope): a semicolon-terminated,
   *  blockless at-rule ("@media;", no braces) leaves a stale AtKeyword-first pending prelude
   *  that production's frame walker only clears on `{`/`}`, never on `;` — so the NEXT rule's
   *  own "{" gets misread as opening the stale at-rule's conditional-group body, and that
   *  rule's hiding declaration is never evaluated. Detected by `isNf04BlocklessAtRule`, a
   *  structural tokenizer-only check independent of production. Minimal repro:
   *  "@media;.legal{display:none}". */
  NF04_blocklessAtRule: number;
  /** NF-05 (open, CSS-tokenizer layer, out of this plan's fix scope): CDO ("<!--")/CDC
   *  ("-->") tokens are not special-cased as ignorable at the stylesheet top level (CSS Syntax
   *  Level 3 §5.4.1), so one poisons the pending prelude's token-shape check for whichever
   *  rule's "{" is reached next. Detected by `nf05Counterfactual`, a structural tokenizer-only
   *  check independent of production. Minimal repro: "-->.legal{display:none}". */
  NF05_topLevelCdoCdc: number;
  /** NF-06 (NEW, found live by this plan's WR-02 causal-attribution fix, open — same
   *  CSS-tokenizer layer, out of this plan's fix scope): a leak where TWO named mechanisms
   *  co-occur such that solo removal of EITHER ONE leaves the leak in place — the OTHER
   *  mechanism alone still corrupts the prelude — and only removing BOTH together clears it.
   *  Every occurrence measured so far pairs NF-05's top-level CDO/CDC with either NF-03's
   *  comma-list rejection or NF-04's blockless at-rule (minimal repros:
   *  "@media;<!--.legal{display:none}" and "-->a,.legal{display:none}", both independently
   *  verified: removing only the at-rule/comma-list leaves the leak because the CDO/CDC alone
   *  still corrupts the next rule's prelude; removing only the CDO/CDC leaves the leak because
   *  the at-rule/comma-list alone still does; removing both clears it). This is NOT a predicate
   *  that absorbs by co-occurrence — attribution is proven by re-running both oracle and
   *  production against the COMBINED counterfactual, the same causal standard NF-03/04/05
   *  individually meet; it is a distinct, newly-discovered compound-interaction defect, not a
   *  loosening of any existing predicate's own solo test. */
  NF06_compoundCooccurrence: number;
  /** NF-SAFE: a residual OVER-strip divergence, not explained by NF-01/03/04/05/06. WR-11/12/13
   *  (`62-REVIEW.md`) are out of this plan's fix scope, so this bucket is not narrowed to a
   *  per-mechanism breakdown the way the leak buckets above now are — but per this plan's own
   *  instruction it is no longer absorbed by a magnitude bound either: an exact count per
   *  generator (asserted below) means a change in over-strip volume fails loudly and must be
   *  dispositioned, even though the mechanism behind it stays undifferentiated. */
  NFSAFE_overStrip: number;
}

function newNewlyFiledCounters(): NewlyFiledCounters {
  return {
    NF01_cdoTruncation: 0,
    NF03_commaList: 0,
    NF04_blocklessAtRule: 0,
    NF05_topLevelCdoCdc: 0,
    NF06_compoundCooccurrence: 0,
    NFSAFE_overStrip: 0,
  };
}

/** A single source-text replacement: `css.slice(start, end)` is replaced by `replacement`. */
interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * A predicate's verdict on `css`: whether its named structural shape is present, and — if so —
 * the edit(s) that remove it (the counterfactual `attributeLeak` re-runs both oracle and
 * production against, per WR-02's fix). Exposed as edits rather than a pre-built string so
 * `attributeLeak` can also apply the UNION of two co-occurring predicates' edits in one pass
 * (the compound-mechanism case below) without re-deriving either predicate's removal logic.
 * `edits` is empty when `matches` is false; callers must check `matches` before trusting it.
 */
interface CounterfactualCheck {
  matches: boolean;
  edits: TextEdit[];
}

/** Applies `edits` (in any order) to `css`, replacing each `[start, end)` span in one pass. */
function applyEdits(css: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return css;
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const edit of sorted) {
    result += css.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  result += css.slice(cursor);
  return result;
}

/**
 * NF-03 (CR-11 gate closure; causal as of WR-02 fix): true when `css` contains a Rule whose
 * prelude is a comma-separated `SelectorList` (more than one `Selector`) where one `Selector`
 * is a BARE class/id equal to `probeName` and at least one OTHER `Selector` in the SAME list is
 * NOT bare. This is exactly the shape production's `preludeToBareSelectors`
 * (`src/source/strip-hidden.ts`) rejects all-or-nothing. Computed independently via css-tree's
 * own parser/walker — the same library the oracle itself is built on, never production's
 * `preludeToBareSelectors`. The counterfactual drops every non-bare sibling from each matching
 * comma list (keeping only its bare selectors, rejoined with `,`) — WR-02's fix: a predicate
 * that only detects co-occurrence cannot attribute; `attributeLeak` re-runs both
 * `liveHidingSelectors` and `stripHiddenContent` against this counterfactual before crediting
 * NF-03 with the leak.
 */
function nf03Counterfactual(css: string, probeName: string): CounterfactualCheck {
  const ast = parseCss(css, { positions: true, onParseError: () => {} });
  const edits: TextEdit[] = [];

  walkCss(ast, (node: any) => {
    if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') return;
    const selectors = node.prelude.children.toArray();
    if (selectors.length < 2) return;
    let hasProbeBare = false;
    let hasNonBare = false;
    for (const sel of selectors) {
      if (sel.type !== 'Selector') continue;
      const parts = sel.children.toArray();
      const only = parts.length === 1 ? parts[0] : null;
      const isBare = only !== null && (only.type === 'ClassSelector' || only.type === 'IdSelector');
      if (isBare) {
        if (ident.decode((only as { name: string }).name) === probeName) hasProbeBare = true;
      } else {
        hasNonBare = true;
      }
    }
    if (!(hasProbeBare && hasNonBare)) return;

    const keptSelectors: string[] = [];
    for (const sel of selectors) {
      if (sel.type !== 'Selector') continue;
      const parts = sel.children.toArray();
      const only = parts.length === 1 ? parts[0] : null;
      const isBare = only !== null && (only.type === 'ClassSelector' || only.type === 'IdSelector');
      if (isBare) keptSelectors.push(css.slice(sel.loc.start.offset, sel.loc.end.offset));
    }
    edits.push({
      start: node.prelude.loc.start.offset,
      end: node.prelude.loc.end.offset,
      replacement: keptSelectors.join(','),
    });
  });

  return edits.length === 0 ? { matches: false, edits: [] } : { matches: true, edits };
}

/**
 * NF-04 (CR-11 gate closure; causal as of WR-02 fix): true when `css` contains a semicolon-
 * terminated at-rule prelude (an `AtKeyword`-first token run, at nesting depth 0, that reaches
 * a `Semicolon` before any `{`/`}`), with no intervening `{`/`}` reset before the NEXT `{`.
 * Production's frame-based walker (`harvestFromStylesheet`) never clears its pending prelude
 * on `;`, only on `{`/`}`, so that `{` gets misread as opening the STALE at-rule's
 * conditional-group body instead of an ordinary declaration block, and the rule it actually
 * belongs to is never evaluated. Minimal repro: "@media;.legal{display:none}". Computed via
 * the shared css-tree tokenizer only, never by calling production's `harvestFromStylesheet`.
 * The counterfactual removes each matched at-rule prelude (from its `AtKeyword` start through
 * its terminating `;`) verbatim — WR-02's fix: `attributeLeak` re-runs both
 * `liveHidingSelectors` and `stripHiddenContent` against this counterfactual before crediting
 * NF-04 with the leak.
 */
function nf04Counterfactual(css: string): CounterfactualCheck {
  let depth = 0;
  let firstTokenSinceReset: number | null = null;
  let preludeStart = -1;
  let sawSemicolonSinceReset = false;
  let semicolonEnd = -1;
  const edits: TextEdit[] = [];

  tokenize(css, (type, start, end) => {
    if (type === tokenTypes.WhiteSpace || type === tokenTypes.Comment) return;
    if (type === tokenTypes.LeftCurlyBracket) {
      if (depth === 0 && firstTokenSinceReset === tokenTypes.AtKeyword && sawSemicolonSinceReset) {
        edits.push({ start: preludeStart, end: semicolonEnd, replacement: '' });
      }
      depth += 1;
      firstTokenSinceReset = null;
      preludeStart = -1;
      sawSemicolonSinceReset = false;
      return;
    }
    if (type === tokenTypes.RightCurlyBracket) {
      depth = Math.max(0, depth - 1);
      firstTokenSinceReset = null;
      preludeStart = -1;
      sawSemicolonSinceReset = false;
      return;
    }
    if (depth !== 0) return;
    if (firstTokenSinceReset === null) {
      firstTokenSinceReset = type;
      preludeStart = start;
    }
    if (type === tokenTypes.Semicolon) {
      sawSemicolonSinceReset = true;
      semicolonEnd = end;
    }
  });

  return edits.length === 0 ? { matches: false, edits: [] } : { matches: true, edits };
}

/**
 * NF-05 (CR-11 gate closure; causal as of WR-02 fix): true when `css` contains a CDO ("<!--")
 * or CDC ("-->") token at nesting depth 0, before the next `{`. CSS Syntax Level 3 §5.4.1 says
 * such a token MUST be ignored at the stylesheet top level, but production's frame-based
 * walker has no such special case — the token is pushed into the pending prelude like any
 * other, so the prelude's token-shape check (exactly a `Hash`, or `Delim('.')` + `Ident`) fails
 * for whichever rule's `{` is reached next. Minimal repro: "-->.legal{display:none}". Computed
 * via the shared css-tree tokenizer only, never by calling production's
 * `harvestFromStylesheet`. The counterfactual removes every top-level CDO/CDC token that
 * preceded a `{` verbatim — WR-02's fix: `attributeLeak` re-runs both `liveHidingSelectors`
 * and `stripHiddenContent` against this counterfactual before crediting NF-05 with the leak.
 */
function nf05Counterfactual(css: string): CounterfactualCheck {
  let depth = 0;
  let pendingEdits: TextEdit[] = [];
  const edits: TextEdit[] = [];

  tokenize(css, (type, start, end) => {
    if (type === tokenTypes.LeftCurlyBracket) {
      if (depth === 0 && pendingEdits.length > 0) edits.push(...pendingEdits);
      depth += 1;
      pendingEdits = [];
      return;
    }
    if (type === tokenTypes.RightCurlyBracket) {
      depth = Math.max(0, depth - 1);
      pendingEdits = [];
      return;
    }
    if (depth !== 0) return;
    if (type === tokenTypes.CDO || type === tokenTypes.CDC) pendingEdits.push({ start, end, replacement: '' });
  });

  return edits.length === 0 ? { matches: false, edits: [] } : { matches: true, edits };
}

/**
 * Re-runs BOTH sides against `edits` applied to `css` (WR-02's fix: an attribution claim is
 * proven, never asserted, by re-running `liveHidingSelectors` (the oracle) and
 * `stripHiddenContent` (production) on the resulting counterfactual) and reports whether the
 * probe both stays live and its marker vanishes from production's output — the two-part test
 * every named mechanism below must pass before a counter increments.
 */
function verifyCounterfactual(
  css: string,
  edits: readonly TextEdit[],
  probeName: string,
  selectorKind: 'class' | 'id'
): { attributed: boolean; probeStillLive: boolean; counterfactual: string; counterfactualTruth: LiveHidingSelectors; counterfactualOut: string } {
  const counterfactual = applyEdits(css, edits);
  const marker = selectorKind === 'class' ? classMarker(probeName) : idMarker(probeName);
  const counterfactualTruth = liveHidingSelectors(counterfactual);
  const counterfactualOut = stripHiddenContent(buildDifferentialHtml(counterfactual, [probeName]));
  const probeStillLive =
    selectorKind === 'class' ? counterfactualTruth.classes.has(probeName) : counterfactualTruth.ids.has(probeName);
  const markerAbsent = !counterfactualOut.includes(marker);
  return { attributed: probeStillLive && markerAbsent, probeStillLive, counterfactual, counterfactualTruth, counterfactualOut };
}

/**
 * The gate itself (CR-11 closure, made causal by WR-02's fix): attributes one confirmed leak
 * (`probeName`, `selectorKind`) to the NAMED mechanism(s) whose structural shape is present in
 * `css` AND whose counterfactual — `css` with that shape removed, re-verified by
 * `verifyCounterfactual` — makes the leak disappear while the probe stays live.
 *
 * Checked in priority order NF-03 -> NF-04 -> NF-05, matching the shipped module's own dispatch
 * order. Two passes:
 *   1. SOLO — each structurally-matching predicate's OWN counterfactual, alone. The first one
 *      that attributes wins; this is the common case and covers every leak this differential
 *      found before the compound cases below.
 *   2. COMPOUND (NF-06) — if no solo counterfactual attributes but >= 2 predicates matched
 *      structurally, re-verify the UNION of every matched predicate's edits together. This
 *      covers a leak that needs BOTH named mechanisms removed at once (found live by this
 *      fix: solo removal of either one leaves the OTHER mechanism still corrupting the same
 *      rule's prelude) — still fully causal (proven by the same `verifyCounterfactual` re-run,
 *      never asserted), and still built entirely from the SAME already-existing predicates'
 *      edits, not a new co-occurrence-only shape test.
 *
 * Before WR-02, each predicate only tested whether `css` CONTAINED the named shape anywhere —
 * co-occurrence, not causation — so a leak caused by an unnamed mechanism that merely shared an
 * input with (for example) a top-level CDO/CDC was silently absorbed as NF-05 and never reached
 * `failures`. A leak matching no named predicate's structural shape, or one whose every
 * causally-checked combination does not make the leak disappear (a different, unnamed
 * mechanism) or makes the probe non-live (a vacuous counterfactual, proving nothing), is NOT
 * counted anywhere — it is pushed to `failures` with the generating input, the counterfactual
 * input, both oracle verdicts and both outputs verbatim, so `throwIfFailures` fails the suite
 * with a reproducible, labeled finding rather than silently widening a co-occurrence bucket.
 */
function attributeLeak(
  css: string,
  probeName: string,
  selectorKind: 'class' | 'id',
  newlyFiled: NewlyFiledCounters,
  failures: string[]
): void {
  const predicates: ReadonlyArray<{
    label: string;
    counter: 'NF03_commaList' | 'NF04_blocklessAtRule' | 'NF05_topLevelCdoCdc';
    result: CounterfactualCheck;
  }> = [
    { label: 'NF-03 (comma-list all-or-nothing rejection)', counter: 'NF03_commaList', result: nf03Counterfactual(css, probeName) },
    { label: 'NF-04 (blockless semicolon-terminated at-rule)', counter: 'NF04_blocklessAtRule', result: nf04Counterfactual(css) },
    { label: 'NF-05 (top-level CDO/CDC token)', counter: 'NF05_topLevelCdoCdc', result: nf05Counterfactual(css) },
  ];
  const matched = predicates.filter(p => p.result.matches);

  if (matched.length === 0) {
    failures.push(
      `UNATTRIBUTED LEAK (matches no named mechanism — NF03/NF04/NF05/NF06) — probe=${probeName} (${selectorKind}) generating input=${JSON.stringify(css)}`
    );
    return;
  }

  // Pass 1: solo — first structurally-matching predicate whose OWN counterfactual attributes.
  for (const predicate of matched) {
    const verdict = verifyCounterfactual(css, predicate.result.edits, probeName, selectorKind);
    if (verdict.attributed) {
      newlyFiled[predicate.counter] += 1;
      return;
    }
  }

  // Pass 2: compound (NF-06) — the union of every matched predicate's edits, still re-verified
  // causally, never asserted. Only reachable when >= 2 predicates matched structurally.
  if (matched.length >= 2) {
    const unionEdits = matched.flatMap(p => p.result.edits);
    const verdict = verifyCounterfactual(css, unionEdits, probeName, selectorKind);
    if (verdict.attributed) {
      newlyFiled.NF06_compoundCooccurrence += 1;
      return;
    }
  }

  // Nothing attributed, solo or combined — report the highest-priority matched predicate's
  // own solo verdict as the representative, reproducible finding.
  const first = matched[0]!;
  const verdict = verifyCounterfactual(css, first.result.edits, probeName, selectorKind);
  const label = matched.length >= 2 ? `${matched.map(p => p.label).join(' + ')}, solo and combined` : first.label;

  if (!verdict.probeStillLive) {
    failures.push(
      `COUNTERFACTUAL VACUOUS (${label}) — removing the named mechanism(s) also removed the probe's own ` +
        `liveness, so attribution is unproven — probe=${probeName} (${selectorKind}) ` +
        `generating input=${JSON.stringify(css)} counterfactual input=${JSON.stringify(verdict.counterfactual)} ` +
        `oracle verdict on generating input=${truthSummary(liveHidingSelectors(css))} ` +
        `oracle verdict on counterfactual=${truthSummary(verdict.counterfactualTruth)} ` +
        `counterfactual output=${JSON.stringify(verdict.counterfactualOut)}`
    );
    return;
  }

  failures.push(
    `DIFFERENT MECHANISM (${label} shape present but not causal — the leak survives its own removal) — ` +
      `probe=${probeName} (${selectorKind}) generating input=${JSON.stringify(css)} ` +
      `counterfactual input=${JSON.stringify(verdict.counterfactual)} ` +
      `oracle verdict on generating input=${truthSummary(liveHidingSelectors(css))} ` +
      `oracle verdict on counterfactual=${truthSummary(verdict.counterfactualTruth)} ` +
      `counterfactual output=${JSON.stringify(verdict.counterfactualOut)}`
  );
}

/**
 * True when `html` contains a CDO ("<!--") with no later CDC ("-->") anywhere after it —
 * the exact structural condition that trips stage 3's unterminated-HTML-comment fail-safe
 * (`removeComments` in `src/source/strip-hidden.ts`) and truncates the rest of the document.
 * A precise, cheap, purely-structural check — not a re-implementation of production's own
 * logic, so this cannot mask a defect by construction.
 */
function hasUnmatchedCdo(html: string): boolean {
  let idx = 0;
  while (true) {
    const cdo = html.indexOf('<!--', idx);
    if (cdo === -1) return false;
    const cdc = html.indexOf('-->', cdo + 4);
    if (cdc === -1) return true;
    idx = cdc + 3;
  }
}

/** True for the CSS ident-start code points: letter, `_`, or non-ASCII (CSS Syntax §4.2). */
function nameStartsWithIdentStart(name: string): boolean {
  if (name.length === 0) return false;
  const cp = name.codePointAt(0)!;
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f || cp >= 0x80;
}

function truthSummary(truth: LiveHidingSelectors): string {
  return `classes=[${[...truth.classes].join(',')}] ids=[${[...truth.ids].join(',')}] unresolved=[${truth.unresolved.join(',')}]`;
}

/**
 * The ONE wrapper-construction site in this file (WR-02/T-62-27-05 fix): both `runDifferential`
 * (the main under/over-strip check) and `attributeLeak`'s counterfactual re-run (WR-02) build
 * their HTML through this exact helper, so a counterfactual document can never drift into a
 * second, independently-maintained copy of the string concatenation — the two-opinions-about-
 * one-boundary failure mode this phase has hit repeatedly. Grepping this file for the wrapper's
 * opening-tag concatenation literal must find exactly this one construction site.
 */
function buildDifferentialHtml(css: string, probeNames: readonly string[]): string {
  return (
    '<style>' +
    css +
    '</style>' +
    'VISIBLE_SENTENCE' +
    probeNames.map(name => `<span class="${name}">${classMarker(name)}</span><span id="${name}">${idMarker(name)}</span>`).join('')
  );
}

/**
 * The core routine (62-19-PLAN.md Task 1's `<behavior>`): given a generated stylesheet and
 * the probe names to test, asserts both the under-strip and over-strip directions against
 * `liveHidingSelectors`'s verdict, appending any UNCLASSIFIED divergence to `failures` with
 * the generating input, the oracle verdict, the observed output and the failing probe name
 * all printed verbatim — reproducible from the test log alone, no seed bookkeeping needed.
 * A classified divergence (AD-* agreement/skip, or NF-* confirmed-open-defect) is counted
 * but does not reach `failures`.
 *
 * Neither direction consults recense's harvest logic to compute its expectation (the
 * expectation is `liveHidingSelectors`, a different implementation), and the generators that
 * call this do not know the enumeration `liveHidingSelectors` uses internally — that is what
 * makes this able to detect a divergence the authors did not anticipate.
 */
function runDifferential(
  css: string,
  probeNames: readonly string[],
  counters: AllowlistCounters,
  newlyFiled: NewlyFiledCounters,
  failures: string[]
): void {
  const truth = liveHidingSelectors(css);

  if (css.includes('@media')) counters.AD01 += 1;

  if (truth.unresolved.length > 0) {
    counters.AD03 += 1;
    return;
  }

  const html = buildDifferentialHtml(css, probeNames);

  // 62-22 gap closure (CR-10) closed NF-01: `scanHtml`'s conformant tokenizer never mistakes
  // a CDO inside `<style>` RAWTEXT for an HTML comment, so stage 3 no longer truncates the
  // rest of the document on an unmatched "<!--". `NF01_cdoTruncation` is NO LONGER a skip of
  // an input whose ground truth cannot be checked (the `return` below is deleted) — it is
  // retained ONLY as an observability counter (an unmatched-CDO input was generated), and the
  // input now flows through to the SAME VISIBLE_SENTENCE / leak / over-strip checks every
  // other input gets. Per this plan's own instruction: do not widen any bound here to
  // accommodate what falls out; any newly surfaced divergence is 62-25's hard-gate redesign
  // to fix, not this plan's to silence.
  if (hasUnmatchedCdo(html)) newlyFiled.NF01_cdoTruncation += 1;

  const out = stripHiddenContent(html);

  if (!out.includes('VISIBLE_SENTENCE')) {
    failures.push(
      `VISIBLE_SENTENCE lost (no unmatched CDO — unclassified) — generating input=${JSON.stringify(css)} observedOutput=${JSON.stringify(out)}`
    );
  }

  for (const name of probeNames) {
    if (!nameStartsWithIdentStart(name)) counters.AD02 += 1;

    const classLive = truth.classes.has(name);
    const idLive = truth.ids.has(name);
    const classPresent = out.includes(classMarker(name));
    const idPresent = out.includes(idMarker(name));

    if (classLive && classPresent) attributeLeak(css, name, 'class', newlyFiled, failures);
    if (!classLive && !classPresent) newlyFiled.NFSAFE_overStrip += 1;
    if (idLive && idPresent) attributeLeak(css, name, 'id', newlyFiled, failures);
    if (!idLive && !idPresent) newlyFiled.NFSAFE_overStrip += 1;
  }
}

// ---------------------------------------------------------------------------
// Generator 1 — exhaustive token-boundary adjacency (k=2). Full cross product, no sampling
// — this is the property that would have caught CR-04 (a bare `.legal{display:none}` glued
// directly onto a fake `url(` span with no token boundary between them).
// ---------------------------------------------------------------------------
describe('css-liveness-differential — Generator 1: exhaustive token-boundary adjacency (k=2)', () => {
  it(`full ${TOKEN_ALPHABET.length}x${TOKEN_ALPHABET.length} cross product, both directions, zero unclassified divergences`, () => {
    const counters = newAllowlistCounters();
    const newlyFiled = newNewlyFiledCounters();
    const failures: string[] = [];
    let pairCount = 0;

    for (const a of TOKEN_ALPHABET) {
      for (const b of TOKEN_ALPHABET) {
        pairCount += 1;
        const css = a + b + '.legal{display:none}';
        runDifferential(css, ['legal'], counters, newlyFiled, failures);
      }
    }

    expect(pairCount).toBe(TOKEN_ALPHABET.length * TOKEN_ALPHABET.length);
    throwIfFailures(failures, 'Generator 1 (exhaustive k=2)');
    expect(counters.AD04).toBe(0);
    // Exact counts (CR-11 gate closure) — measured against this file's own alphabet and this
    // generator's exhaustive k=2 cross product, not a re-derivable formula. A count that moves
    // means the corpus or the shipped module changed; either way it must be re-measured and
    // re-recorded here, not silently absorbed by a bound.
    // WR-02 fix: none of Generator 1's counts moved. Every leak this exhaustive k=2 cross
    // product finds is explained by exactly one named mechanism's SOLO counterfactual — no
    // compound (NF-06) case exists in this alphabet's 2-token combinations.
    expect(newlyFiled.NF01_cdoTruncation).toBe(86);
    expect(newlyFiled.NF03_commaList).toBe(10);
    expect(newlyFiled.NF04_blocklessAtRule).toBe(1);
    expect(newlyFiled.NF05_topLevelCdoCdc).toBe(16);
    expect(newlyFiled.NF06_compoundCooccurrence).toBe(0);
    expect(newlyFiled.NFSAFE_overStrip).toBe(50);
  });
}, 30000);

// ---------------------------------------------------------------------------
// Generator 2 — seeded adjacency at k=3..6, >= 20,000 inputs, two planted rules (a class
// rule and an id rule) inserted at random positions among the alphabet pieces so the
// planted rule is not always last.
// ---------------------------------------------------------------------------
describe('css-liveness-differential — Generator 2: seeded adjacency k=3..6', () => {
  it('>= 20,000 seeded inputs, both directions, zero unclassified divergences', () => {
    const rand = makeLcg(0x62191a2c);
    const N = 20000;
    const counters = newAllowlistCounters();
    const newlyFiled = newNewlyFiledCounters();
    const failures: string[] = [];

    for (let i = 0; i < N; i++) {
      const pieceCount = 3 + Math.floor(rand() * 4); // 3..6
      const pieces: string[] = [];
      for (let p = 0; p < pieceCount; p++) {
        pieces.push(TOKEN_ALPHABET[Math.floor(rand() * TOKEN_ALPHABET.length)]!);
      }
      pieces.splice(Math.floor(rand() * (pieces.length + 1)), 0, '.legal{display:none}');
      pieces.splice(Math.floor(rand() * (pieces.length + 1)), 0, '#legalid{display:none}');
      const css = pieces.join('');
      runDifferential(css, ['legal', 'legalid'], counters, newlyFiled, failures);
      if (failures.length > 500) break; // large enough a sample to triage; stop generating more
    }

    throwIfFailures(failures, 'Generator 2 (seeded k=3..6)');
    expect(counters.AD04).toBe(0);
    // Exact counts (CR-11 gate closure), measured against this LCG seed's own 20,000-input
    // stream — see Generator 1's comment for why a moved count must be re-measured, not bound.
    // WR-02 fix (62-27): NF03 moved 52 -> 51 and NF04 moved 10 -> 9, both by exactly 1, with
    // NF06_compoundCooccurrence appearing at exactly 2 — not noise, a real reclassification.
    // Before this plan, isNf03CommaList/isNf04BlocklessAtRule tested co-occurrence only (did
    // `css` CONTAIN the shape?), so two inputs where a comma-list/blockless-at-rule shape
    // co-occurred with an ALSO-present top-level CDO/CDC were silently counted as NF03/NF04
    // even though solo removal of the comma-list/at-rule shape does NOT clear the leak (the
    // co-occurring CDO/CDC alone still corrupts the same rule's prelude). The causal
    // counterfactual now proves this: solo removal of either mechanism leaves the leak; only
    // removing BOTH together (re-verified against both `liveHidingSelectors` and
    // `stripHiddenContent`) clears it. Both instances reclassified from NF03/NF04 to the new
    // NF06 bucket; see "NF-06" below for the two locked minimal reproductions.
    expect(newlyFiled.NF01_cdoTruncation).toBe(1921);
    expect(newlyFiled.NF03_commaList).toBe(51);
    expect(newlyFiled.NF04_blocklessAtRule).toBe(9);
    expect(newlyFiled.NF05_topLevelCdoCdc).toBe(461);
    expect(newlyFiled.NF06_compoundCooccurrence).toBe(2);
    expect(newlyFiled.NFSAFE_overStrip).toBe(1768);
  });
}, 60000);

// ---------------------------------------------------------------------------
// Generator 3 — structured stylesheets assembled from whole rules: a mix of hiding and
// non-hiding declarations, bare and non-bare selectors, an escaped (decodable) selector
// name, an unresolvable escape, an @media wrapper and an "unrestricted hash" id, randomly
// interleaved with alphabet-piece noise at rule boundaries. 2-4 rules (probe names) chosen
// per document from the library below.
// ---------------------------------------------------------------------------
interface RuleSpec {
  probeName: string;
  text: string;
}

const RULE_LIBRARY: readonly RuleSpec[] = [
  { probeName: 'plainA', text: '.plainA{display:none}' },
  { probeName: 'plainB', text: '#plainB{display:none}' },
  { probeName: 'visibleC', text: '.visibleC{color:red}' },
  { probeName: 'visibleD', text: '#visibleD{color:blue}' },
  // Non-bare (type-qualified) selector — a real browser would apply this rule to a
  // matching element, but it is OUTSIDE the bare-selector scope both the oracle and
  // production deliberately narrow to (see the oracle's own file-level doc comment); both
  // sides must agree it is NOT LIVE as a bare selector.
  { probeName: 'notBareE', text: 'div.notBareE{display:none}' },
  // Non-bare (pseudo-class-qualified) selector — same narrowing, different shape.
  { probeName: 'notBareF', text: '.notBareF:hover{display:none}' },
  // Escaped selector name that DECODES cleanly (§4.3.7): "n" + \61 (=0x61="a") + "me" =
  // "name". Exercises the same decode path 62-17 closed for `.leg\61 l`, independently
  // implemented by both the oracle (css-tree's `ident.decode`) and production
  // (`decodeIdentEscapes`).
  { probeName: 'name', text: '.n\\61 me{display:none}' },
  // @media-wrapped hiding rule — AD-01 coverage: both sides harvest it without evaluating
  // the media condition.
  { probeName: 'mediaG', text: '@media screen{.mediaG{display:none}}' },
  // "Unrestricted hash" id (does not start with an ident-start code point) — AD-02
  // coverage: both the oracle's parser and production harvest it as a live id regardless.
  { probeName: '1digitH', text: '#1digitH{display:none}' },
];

// An escape that decodes to U+FFFD ("\0" is a one-digit hex escape for the null code
// point, which §4.3.7 explicitly maps to the replacement character, not a literal name) —
// AD-03 coverage: the oracle reports this in `unresolved`, so the whole input's checks are
// skipped rather than compared against an undefined ground truth.
const UNRESOLVED_FRAGMENT = '.\\0zzz{display:none}';

describe('css-liveness-differential — Generator 3: structured stylesheets from whole rules', () => {
  it('>= 5,000 seeded structured stylesheets, 2-4 probes each, zero unclassified divergences', () => {
    const rand = makeLcg(0xba5eba11);
    const N = 5000;
    const counters = newAllowlistCounters();
    const newlyFiled = newNewlyFiledCounters();
    const failures: string[] = [];

    for (let i = 0; i < N; i++) {
      const k = 2 + Math.floor(rand() * 3); // 2..4
      const indices = RULE_LIBRARY.map((_, idx) => idx);
      for (let s = indices.length - 1; s > 0; s--) {
        const j = Math.floor(rand() * (s + 1));
        const tmp = indices[s]!;
        indices[s] = indices[j]!;
        indices[j] = tmp;
      }
      const chosen = indices.slice(0, k).map(idx => RULE_LIBRARY[idx]!);

      const parts: string[] = [];
      for (const rule of chosen) {
        parts.push(TOKEN_ALPHABET[Math.floor(rand() * TOKEN_ALPHABET.length)]!);
        parts.push(rule.text);
      }
      parts.push(TOKEN_ALPHABET[Math.floor(rand() * TOKEN_ALPHABET.length)]!);
      if (rand() < 0.05) parts.push(UNRESOLVED_FRAGMENT);

      const css = parts.join('');
      const probeNames = chosen.map(r => r.probeName);
      runDifferential(css, probeNames, counters, newlyFiled, failures);
    }

    throwIfFailures(failures, 'Generator 3 (structured stylesheets)');

    // Allowlist coverage assertions — "this path was actually exercised", never an upper
    // magnitude tolerance standing in for a gate (CR-11).
    expect(counters.AD01).toBeGreaterThan(0); // @media coverage was actually exercised
    expect(counters.AD02).toBeGreaterThan(0); // unrestricted-hash coverage was actually exercised
    expect(counters.AD03).toBeGreaterThan(0); // the unresolvable-escape input was actually generated
    expect(counters.AD04).toBe(0);

    // Exact counts (CR-11 gate closure), measured against this LCG seed's own 5,000-document
    // stream — see Generator 1's comment for why a moved count must be re-measured, not bound.
    // NF03/NF04 measure zero here: RULE_LIBRARY's own hiding rules never form a comma list or
    // sit adjacent to a blockless at-rule, and this generator's noise pieces did not happen to
    // construct either shape across 5,000 seeded documents — a real absence for THIS seed, not
    // a skip; Generator 1's exhaustive cross product and Generator 2's larger seeded stream
    // both DO exercise NF03/NF04, so neither mechanism is uncovered by the suite as a whole.
    // WR-02 fix: none of Generator 3's counts moved — RULE_LIBRARY's own rules never form a
    // comma list or a blockless at-rule adjacent to a top-level CDO/CDC across this seed's
    // 5,000 documents, so NF06 measures zero here too (a real absence for THIS seed, not a
    // skip; Generator 2's larger seeded stream already proves NF06 is reachable).
    expect(newlyFiled.NF01_cdoTruncation).toBe(407);
    expect(newlyFiled.NF03_commaList).toBe(0);
    expect(newlyFiled.NF04_blocklessAtRule).toBe(0);
    expect(newlyFiled.NF05_topLevelCdoCdc).toBe(277);
    expect(newlyFiled.NF06_compoundCooccurrence).toBe(0);
    expect(newlyFiled.NFSAFE_overStrip).toBe(358);
  });
}, 30000);

// ---------------------------------------------------------------------------
// Newly discovered defects — locked minimal repros. Found live by the generators above,
// NOT fixed by this plan (test-only scope), NOT silenced by widening the accepted-
// divergence allowlist. Each `it.fails` here is a documented expected-failure: the suite
// stays green, the defect stays visible and unmistakably named, and the moment a future
// plan fixes it this row flips to a hard failure — the same signal
// `tests/css-liveness-adjudication.test.ts` already uses for FB-01/CR-04.
// ---------------------------------------------------------------------------
describe('css-liveness-differential — newly discovered defects (found by this differential, not fixed here)', () => {
  // CLOSED by 62-22 (CR-10, scanHtml): htmlparser2's conformant tokenizer knows a CDO
  // ("<!--") inside a <style> RAWTEXT body is ordinary CSS text (the historic "SGML comment
  // hack", CSS Syntax §4.3.3), never an HTML comment — so `scan.comments` contains no entry
  // for it at all, and stage 3's old `indexOf('<!--')` truncation fail-safe (which had no way
  // to distinguish this from a genuinely unterminated HTML comment) is gone. The document's
  // real </style> tag and every visible sentence after it survive. Converted from `it.fails`
  // to a passing `it`, per this plan's own instruction, rather than silently deleting the
  // lock.
  //
  // NOT closed by this same conversion: PAYLOAD in this exact combined shape still leaks --
  // NOT because NF-01 reopened, but because of a SEPARATE, already-filed, still-open defect
  // (NF-05, own locked repro below): `harvestFromStylesheet`'s prelude collection has no
  // special case for a CDO token at the stylesheet top level (CSS Syntax §5.4.1 says it MUST
  // be skipped there), so the leading CDO token is pushed into the pending prelude and
  // corrupts the shape-match for the ".legal{display:none}" rule that immediately follows it
  // -- the SAME mechanism NF-05's own repro demonstrates with a CDC ("-->") instead of a CDO.
  // This is exactly the acceptance criterion's documented escape hatch ("or the SUMMARY
  // states precisely why it did not close [in the leak dimension]") -- NF-01 was filed as an
  // AVAILABILITY defect only ("Severity: availability (total content loss), not a leak"), and
  // this test's assertion was always scoped to that dimension, not to PAYLOAD's presence.
  it('NF-01 (CLOSED, 62-22/CR-10): an unmatched CDO ("<!--") inside a <style> block no longer truncates the rest of the document (stage 3 now respects the RAWTEXT boundary via scanHtml)', () => {
    const out = stripHiddenContent(
      '<style><!--.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
    );
    expect(out).toContain('VISIBLE_SENTENCE');
  });

  // WR-04 fix (62-27-PLAN.md Task 2): each defect lock below asserts EXACTLY ONE subject
  // inside its `it.fails` body -- production's output. The oracle ground-truth precondition
  // that used to live INSIDE the same `it.fails` block is now its own ordinary, PASSING `it`,
  // named so the pairing with its lock is obvious. `it.fails` passes when ANYTHING in its body
  // throws, so a precondition assertion sharing the block made an oracle REGRESSION (not just
  // a defect fix) silently satisfy the lock for the wrong reason: if `liveHidingSelectors`
  // stopped reporting `.legal` as live, the precondition line would throw first, `it.fails`
  // would still pass, and the defect could reopen in production with the suite staying green.
  // Splitting the precondition out means an oracle regression now fails ITS OWN passing test
  // instead of masquerading as this lock's expected failure -- proven by deliberately breaking
  // `liveHidingSelectors` and observing the precondition tests fail (recorded in
  // `62-27-SUMMARY.md`, not merely asserted here).

  it('NF-03 precondition: the oracle reports "legal" live for "a,.legal{display:none}" (a real browser evaluates each selector in a comma-separated list independently)', () => {
    const truth = liveHidingSelectors('a,.legal{display:none}');
    expect(truth.classes.has('legal')).toBe(true);
  });

  it.fails(
    'NF-03: a comma-separated selector list is rejected all-or-nothing rather than per-selector, letting a bare hiding selector hide behind ANY non-bare sibling in the same list',
    () => {
      // `preludeToBareSelectors` returns null for the WHOLE prelude if ANY comma-separated
      // group fails the bare-selector shape check (matching this module's documented,
      // pre-62-17 `allBare`/`.every()` semantics) -- so `.legal` never gets harvested at
      // all merely because it shares a comma list with a non-bare selector.
      const out = stripHiddenContent(
        '<style>a,.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );

  it('NF-04 precondition: the oracle reports "legal" live for "@media;.legal{display:none}" (a blockless "@media;" is a complete, independent at-rule; ".legal" that follows is an ordinary, independent, live rule)', () => {
    const truth = liveHidingSelectors('@media;.legal{display:none}');
    expect(truth.classes.has('legal')).toBe(true);
  });

  it.fails(
    'NF-04: a blockless at-rule ("@media;", no braces) misattributes the NEXT rule\'s block as its own, silently dropping a genuinely-live hiding rule',
    () => {
      // `harvestFromStylesheet`'s `startsWithAtKeyword` check only looks at whether the
      // PENDING prelude starts with an AtKeyword token when the NEXT "{" is reached -- it
      // never accounts for an intervening ";" already having closed the at-rule, so the
      // "{" that should open .legal's OWN block gets consumed as the (bogus) at-rule's
      // block instead, and .legal is never harvested.
      const out = stripHiddenContent(
        '<style>@media;.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );

  it('NF-05 precondition: the oracle reports "legal" live for "-->.legal{display:none}" (CSS Syntax §5.4.1: a CDC at the stylesheet top level is simply skipped, never part of any prelude)', () => {
    const truth = liveHidingSelectors('-->.legal{display:none}');
    expect(truth.classes.has('legal')).toBe(true);
  });

  it.fails(
    'NF-05: CDO/CDC tokens are not treated as ignorable at the stylesheet top level (CSS Syntax §5.4.1), so one before a hiding rule poisons that rule\'s prelude and the rule is never harvested',
    () => {
      // `harvestFromStylesheet` has no special case for a top-level CDO/CDC: a lone "-->"
      // is pushed into the pending prelude like any other token, so the FOLLOWING rule's
      // prelude no longer matches the bare-selector shape and the rule is silently dropped.
      const out = stripHiddenContent(
        '<style>-->.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );

  // NF-06 (NEW, found live by this plan's WR-02 causal-attribution fix): a compound leak where
  // a top-level CDO/CDC (NF-05's own mechanism) co-occurs with EITHER a blockless at-rule
  // (NF-04) or a comma-list rejection (NF-03) such that solo removal of EITHER construct alone
  // leaves the leak in place -- the other construct alone still corrupts the same rule's
  // prelude -- and only removing BOTH together clears it. Independently verified (see
  // `62-27-SUMMARY.md`): removing only "@media;" from "@media;<!--.legal{display:none}" still
  // leaks (the leading "<!--" alone still corrupts .legal's prelude); removing only "<!--"
  // still leaks (the leading "@media;" alone still does); removing both clears it. Same
  // structure for the comma-list pairing.

  it('NF-06a precondition: the oracle reports "legal" live for "@media;<!--.legal{display:none}"', () => {
    const truth = liveHidingSelectors('@media;<!--.legal{display:none}');
    expect(truth.classes.has('legal')).toBe(true);
  });

  it.fails(
    'NF-06a: a blockless at-rule ("@media;") AND a top-level CDO ("<!--") co-occurring both corrupt the SAME following rule\'s prelude -- solo removal of either one alone still leaks; only removing both clears it',
    () => {
      const out = stripHiddenContent(
        '<style>@media;<!--.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );

  it('NF-06b precondition: the oracle reports "legal" live for "-->a,.legal{display:none}"', () => {
    const truth = liveHidingSelectors('-->a,.legal{display:none}');
    expect(truth.classes.has('legal')).toBe(true);
  });

  it.fails(
    'NF-06b: a top-level CDC ("-->") AND a comma-list rejection co-occurring both corrupt the SAME rule\'s prelude -- solo removal of either one alone still leaks; only removing both clears it',
    () => {
      const out = stripHiddenContent(
        '<style>-->a,.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );
});
