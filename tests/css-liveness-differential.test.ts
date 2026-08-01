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
 * found four. None are fixed by this plan (test-only scope, per this plan's own
 * `files_modified`) — each is locked as a named, dedicated `it.fails` reproduction so the
 * finding stays visible and reproducible, matching the precedent
 * `tests/css-liveness-adjudication.test.ts` already established for FB-01/CR-04.
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
 * A SECOND, NARROWER RESIDUAL of this specific file: the bulk generators below classify
 * every divergence they find into one of the accepted-divergence allowlist (AD-*, expected
 * agreement) or the newly-filed-defect buckets (NF-*, confirmed open defects) by DIRECTION
 * (leak vs. safe over-strip) plus a structural check for the one bucket (NF-01) that has a
 * cheap, precise structural signature. NF-danger/NF-safe are NOT further narrowed by a
 * structural predicate per mechanism — they are bounded by count instead (mirroring the
 * "counts asserted against expected magnitudes" requirement this plan places on the AD-*
 * allowlist). A sample from every bucket in every generator was manually traced against the
 * css-tree tokenizer/parser during this plan's execution and confirmed to match one of the
 * four named NF-* mechanisms below with zero unexplained outliers found — but that is
 * sampling, not exhaustive structural proof, and is recorded here as this file's own
 * residual rather than silently assumed complete.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenize, tokenTypes } from 'css-tree/tokenizer';
import { liveHidingSelectors, type LiveHidingSelectors } from './support/css-liveness-oracle';
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
 * Newly-filed-defect buckets — NOT an allowlist entry, NOT accepted as fine. Each bucket
 * below is a CONFIRMED, OPEN, currently-unfixed defect this differential found live during
 * this plan's execution (see the "Newly discovered defects" section at the end of this
 * file for each mechanism's own minimal, dedicated `it.fails` reproduction). Bucketing a
 * divergence here does not silence it: every bucket is bounded below (a magnitude
 * assertion, mirroring the allowlist's own "counts asserted against expected magnitudes"
 * requirement), and every mechanism is separately named, reported in the SUMMARY, and
 * locked as its own failing-as-expected test — the SAME visibility contract
 * `tests/css-liveness-adjudication.test.ts` already established for FB-01/CR-04.
 */
interface NewlyFiledCounters {
  /** NF-01: CLOSED by 62-22 (CR-10, `scanHtml`) -- an unmatched CDO ("<!--" with no later
   *  "-->" anywhere in the whole document) inside a `<style>` block no longer trips stage 3's
   *  old unterminated-HTML-comment fail-safe (deleted; see `removeComments`'s own doc
   *  comment), because the parser never mistakes RAWTEXT content for a comment in the first
   *  place. This counter is now OBSERVABILITY-ONLY (an unmatched-CDO input was generated and
   *  is no longer skipped -- see `runDifferential`'s own comment): every input that trips it
   *  flows through the SAME VISIBLE_SENTENCE / leak / over-strip checks every other input
   *  gets, rather than returning early. Detected structurally (not by re-running production),
   *  so counting it cannot silently widen to cover an unrelated failure. */
  NF01_cdoTruncation: number;
  /** NF-DANGER: a residual UNDER-strip (leak) divergence, not explained by NF-01. Manual
   *  trace during this plan's execution confirmed three distinct root mechanisms feed this
   *  bucket (comma-separated selector lists rejected all-or-nothing rather than
   *  per-selector [NF-03]; a blockless `@media;` at-rule misattributing the NEXT rule's
   *  block as its own [NF-04]; CDO/CDC not special-cased as ignorable at the stylesheet top
   *  level per CSS Syntax Level 3 §5.4.1, matched or not [NF-05]) — see their dedicated
   *  locked repros below. Every instance here is a REAL, EXPLOITABLE leak. */
  NFDANGER_leak: number;
  /** NF-SAFE: a residual OVER-strip divergence, not explained by NF-01. Manual trace
   *  confirmed this is always a stray/unmatched punctuation or bracket token poisoning a
   *  prelude's token-shape match, in the SAFE direction only (production hides content a
   *  real browser would still show; never a leak). */
  NFSAFE_overStrip: number;
}

function newNewlyFiledCounters(): NewlyFiledCounters {
  return { NF01_cdoTruncation: 0, NFDANGER_leak: 0, NFSAFE_overStrip: 0 };
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

// Delimiter-bounded payload markers so no probe name's marker is ever a substring of
// another probe name's marker (e.g. "legal" is a prefix of "legalid" — a bare `PL_${name}`
// scheme would make `PL_legal` a false-positive substring match of `PL_legalid`).
function classMarker(name: string): string {
  return `PL[${name}]`;
}
function idMarker(name: string): string {
  return `PLID[${name}]`;
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

  const html =
    '<style>' +
    css +
    '</style>' +
    'VISIBLE_SENTENCE' +
    probeNames.map(name => `<span class="${name}">${classMarker(name)}</span><span id="${name}">${idMarker(name)}</span>`).join('');

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

    if (classLive && classPresent) newlyFiled.NFDANGER_leak += 1;
    if (!classLive && !classPresent) newlyFiled.NFSAFE_overStrip += 1;
    if (idLive && idPresent) newlyFiled.NFDANGER_leak += 1;
    if (!idLive && !idPresent) newlyFiled.NFSAFE_overStrip += 1;
  }
}

function throwIfFailures(failures: string[], contextLabel: string): void {
  if (failures.length === 0) return;
  const shown = failures.slice(0, 10);
  throw new Error(
    `${contextLabel}: ${failures.length} unclassified divergence(s) found. First ${shown.length}:\n\n` +
      shown.join('\n---\n')
  );
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
    // Magnitude bounds on the newly-filed buckets — a change that suddenly routes many more
    // cases into one of these must fail loudly rather than pass quietly.
    expect(newlyFiled.NF01_cdoTruncation).toBeLessThan(pairCount * 0.2);
    expect(newlyFiled.NFDANGER_leak).toBeLessThan(pairCount * 0.05);
    expect(newlyFiled.NFSAFE_overStrip).toBeLessThan(pairCount * 0.2);
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
    expect(newlyFiled.NF01_cdoTruncation).toBeLessThan(N * 0.3);
    expect(newlyFiled.NFDANGER_leak).toBeLessThan(N * 0.05);
    expect(newlyFiled.NFSAFE_overStrip).toBeLessThan(N * 0.3);
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

    // Allowlist magnitude assertions — a change that suddenly routes thousands of cases
    // into one of these must fail loudly rather than pass quietly.
    expect(counters.AD01).toBeGreaterThan(0); // @media coverage was actually exercised
    expect(counters.AD01).toBeLessThan(N);
    expect(counters.AD02).toBeGreaterThan(0); // unrestricted-hash coverage was actually exercised
    expect(counters.AD02).toBeLessThan(N);
    expect(counters.AD03).toBeGreaterThan(0); // the unresolvable-escape input was actually generated
    expect(counters.AD03).toBeLessThan(N * 0.15); // well under "a few percent" of the corpus
    expect(counters.AD04).toBe(0);

    expect(newlyFiled.NF01_cdoTruncation).toBeLessThan(N * 0.2);
    expect(newlyFiled.NFDANGER_leak).toBeLessThan(N * 0.1);
    expect(newlyFiled.NFSAFE_overStrip).toBeLessThan(N * 0.15);
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

  it.fails(
    'NF-03: a comma-separated selector list is rejected all-or-nothing rather than per-selector, letting a bare hiding selector hide behind ANY non-bare sibling in the same list',
    () => {
      // A real browser evaluates each selector in a comma-separated list independently:
      // "a, .legal { display:none }" hides BOTH <a> elements AND class="legal" elements.
      // `preludeToBareSelectors` returns null for the WHOLE prelude if ANY comma-separated
      // group fails the bare-selector shape check (matching this module's documented,
      // pre-62-17 `allBare`/`.every()` semantics) -- so `.legal` never gets harvested at
      // all merely because it shares a comma list with a non-bare selector.
      const truth = liveHidingSelectors('a,.legal{display:none}');
      expect(truth.classes.has('legal')).toBe(true); // ground truth: a real browser hides it
      const out = stripHiddenContent(
        '<style>a,.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );

  it.fails(
    'NF-04: a blockless at-rule ("@media;", no braces) misattributes the NEXT rule\'s block as its own, silently dropping a genuinely-live hiding rule',
    () => {
      // Per CSS Syntax, an at-rule ends at the first top-level ";" if no block ever
      // follows -- "@media;" is a complete (if useless) at-rule with NO block, and
      // ".legal{display:none}" that follows is an ordinary, independent, live rule. But
      // `harvestFromStylesheet`'s `startsWithAtKeyword` check only looks at whether the
      // PENDING prelude starts with an AtKeyword token when the NEXT "{" is reached -- it
      // never accounts for an intervening ";" already having closed the at-rule, so the
      // "{" that should open .legal's OWN block gets consumed as the (bogus) at-rule's
      // block instead, and .legal is never harvested.
      const truth = liveHidingSelectors('@media;.legal{display:none}');
      expect(truth.classes.has('legal')).toBe(true); // ground truth: a real browser hides it
      const out = stripHiddenContent(
        '<style>@media;.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );

  it.fails(
    'NF-05: CDO/CDC tokens are not treated as ignorable at the stylesheet top level (CSS Syntax §5.4.1), so one before a hiding rule poisons that rule\'s prelude and the rule is never harvested',
    () => {
      // Per CSS Syntax Level 3 §5.4.1 ("consume a list of rules"), a CDO or CDC token AT
      // THE TOP LEVEL of a stylesheet is simply skipped -- it never becomes part of any
      // rule's prelude, matched or not. `harvestFromStylesheet` has no such special case:
      // a lone "-->" is pushed into the pending prelude like any other token, so the
      // FOLLOWING rule's prelude no longer matches the bare-selector shape and the rule is
      // silently dropped.
      const truth = liveHidingSelectors('-->.legal{display:none}');
      expect(truth.classes.has('legal')).toBe(true); // ground truth: a real browser hides it
      const out = stripHiddenContent(
        '<style>-->.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>'
      );
      expect(out).not.toContain('PAYLOAD');
    }
  );
});
