---
phase: 62-multi-inbox-email-ingest-hardening
reviewed: 2026-07-31T14:40:00Z
depth: standard
scope: "waves 11-14 (plans 62-16..62-19), git diff 0714166..HEAD"
prior_review: 62-REVIEW-wave10.md (waves 1-10; CR-01..CR-04, FB-01, WR-01..WR-09, BL-01..BL-03, IN-01..IN-05 dispositioned there, not re-filed here)
files_reviewed: 11
files_reviewed_list:
  - src/source/strip-hidden.ts
  - src/source/gmail-adapter.ts
  - src/types/css-tree-tokenizer.d.ts
  - package.json
  - tests/support/css-liveness-oracle.ts
  - tests/support/css-tree-ambient.d.ts
  - tests/css-tokenizer-conformance.test.ts
  - tests/css-liveness-adjudication.test.ts
  - tests/css-liveness-differential.test.ts
  - tests/gmail-hidden-content.test.ts
  - tests/strip-hidden.test.ts
findings:
  critical: 7
  warning: 7
  info: 4
  total: 18
status: issues_found
---

# Phase 62 (waves 11-14): Code Review Report

**Reviewed:** 2026-07-31T14:40:00Z
**Depth:** standard (with targeted dynamic probing — every Critical below has a reproduced repro against HEAD)
**Files Reviewed:** 11
**Status:** issues_found

## Summary

Waves 11-14 replaced a hand-rolled CSS scanner with a `css-tree/tokenizer` token-stream walk,
deleted `STYLE_BLOCK_RE`, and built an oracle-driven differential. The tokenizer adoption is
genuinely good: the `{`/`}`-token frame stack and `preludeToBareSelectors`'s token-shape check do
close the FB-01/CR-04 mechanism class, and 62-18's linear `<style>` walk is a real structural
improvement over the deleted regex.

But the wave's own framing — "agreement with a conformant CSS engine is now structural rather than
the outcome of enumerating repros" — is only true for **one half** of the hiding decision. The
CSS selector layer got tokenized; the **declaration-signature layer** (`hasHidingSignature`) and
the **HTML attribute layer** (`isHiddenStartTag`) are still raw-text regex scans, and both are
trivially bypassable. Worse, the liveness oracle built to catch exactly this class of defect
carries a **verbatim copy** of production's declaration regexes, so the 62-19 differential is
structurally blind to every defect on that layer — the WR-09 root cause ("every shipped oracle was
drawn from the same enumeration it existed to validate") reproducing itself inside the artifact
built to close WR-09.

I reproduced **six independent under-strip leaks** against HEAD. Every one of them survives the
full shipped suite (`npx vitest run tests/css-liveness-differential.test.ts
tests/css-liveness-adjudication.test.ts tests/css-tokenizer-conformance.test.ts` → 59 passed,
4 expected-fail). Five are pre-existing (verified byte-identical against `0714166`); one
(CR-08) is **new code written by 62-17**. Their inputs are ordinary attacker-authored email HTML,
not exotic tokenizer corner cases:

| repro | leaks today |
| --- | --- |
| `<style>.legal{display:/*x*/none}</style>` | yes |
| `<style>.legal{display:\6eone}</style>` | yes |
| `<style>.legal{display:none</style>` (no `}`) | yes |
| `<span class="leg&#97;l">` vs `.legal{display:none}` | yes |
| `<style>.leg\61<CR><LF>l{display:none}</style>` vs `class="legal"` | yes |
| 200 filler `.fN{display:none}` rules then `.legal{display:none}` | yes |
| `<!-- <style> -->` before the real `<style>` | yes |

Additionally, the T-62-17-08 invariant this review was asked to verify — "the oracle must never be
reachable from `src/`" — **does not hold**, and neither does the compile-time guard
`src/types/css-tree-tokenizer.d.ts` documents. Proven by construction below (WR-10).

No structural-findings block was supplied for this review.

---

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-05: The hiding-declaration test is still a raw-text regex scan — a CSS comment or an escaped ident defeats it, and the liveness oracle carries a verbatim copy so the differential cannot see it

**File:** `src/source/strip-hidden.ts:986-1026` (declaration side), `src/source/strip-hidden.ts:846-847` (call site), `tests/support/css-liveness-oracle.ts:37-70` (copy), `tests/css-liveness-differential.test.ts:41-53` (the residual claim that is wrong)

**Issue:** 62-17 made the *selector* side token-structural but left the *declaration* side exactly
as it was: `hasHidingSignature` runs twelve regexes over `css.slice(frame.contentStart, start)` —
**raw, untokenized text**, comments and escapes included. A browser removes comments at tokenize
time and decodes `\`-escapes in idents, so all three of these apply `display:none` and none is
detected:

```
<style>.legal{display:/*x*/none}</style>ok<span class="legal">PAYLOAD</span>  -> "okPAYLOAD"
<style>.legal{display:\6eone}</style>ok<span class="legal">PAYLOAD</span>     -> "okPAYLOAD"
<div style="display:/*x*/none">PAYLOAD</div>ok                               -> "PAYLOADok"
```

(`\6e` = `n`, so `\6eone` is the ident `none`. The inline-`style` form goes through the same
`hasHidingSignature`, so the attribute path leaks identically.)

This is the *same* mechanism VF-01 filed and 62-13 fixed — on the selector side only. The
declaration side was never migrated.

The compounding problem: `tests/support/css-liveness-oracle.ts:37-70` is a **line-for-line copy**
of these twelve regexes (deliberately, per its own doc comment). So `liveHidingSelectors('.legal{display:/*x*/none}')`
returns `classes=[]` — the oracle agrees with the bug, `runDifferential` scores it as agreement,
and no generator can ever surface it. The differential's stated residual
(`tests/css-liveness-differential.test.ts:41-53`) claims the *only* shared layer is the tokenizer
and that "the oracle's PARSE and SELECTOR-VALIDITY layers ... are independent of production's
hand-written token-shape matcher". That is materially incomplete: the **declaration-signature
layer is 100% shared, by copy-paste**, and it is where the leaks are.

**Fix:** Two changes, both required — fixing only one leaves either the leak or the blind spot
standing.

1. Production: read the declaration block from the token stream you already have, not from raw
   text. Collect declaration tokens in `harvestFromStylesheet` the way preludes are collected
   (skipping `Comment`), decode `Ident` tokens through the existing `decodeIdentEscapes`, and run
   the signature match over the reconstructed text:

```ts
// in harvestFromStylesheet's frame: collect body tokens for hasPrelude frames
// and build declarationText from them instead of css.slice(contentStart, contentEnd):
const declarationText = frame.bodyTokens
  .filter(([type]) => type !== TT_COMMENT)
  .map(([type, s, e]) => (type === TT_IDENT ? decodeIdentEscapes(css.slice(s, e)) : css.slice(s, e)))
  .join('');
```

   For the inline-`style` attribute path (`isHiddenStartTag`), run the attribute value through
   `tokenize` before the signature match rather than regexing the raw value.

2. Oracle: derive its verdict from css-tree's parsed `Declaration` nodes (parse with
   `parseValue: true`, read `property`/`value`), **not** from a copy of production's regexes. An
   oracle that shares production's decision procedure cannot adjudicate production.

---

### CR-06: An unterminated final declaration block silently drops every hiding rule in the stylesheet

**File:** `src/source/strip-hidden.ts:798-862` (`harvestFromStylesheet`; the `RightCurlyBracket` branch at 839-857 is the only place a frame is ever evaluated), missing drain after `tokenize` returns at line 861

**Issue:** A frame is only evaluated when a `RightCurlyBracket` token pops it. At EOF the stack is
simply abandoned, so a stylesheet whose last block is unterminated contributes nothing. Per CSS
Syntax, EOF closes an open block and the rule applies; css-tree's parser agrees.

```
<style>.legal{display:none</style>ok<span class="legal">PAYLOAD_A1</span>Thanks.
  oracle: classes=['legal'] (LIVE)   production: "okPAYLOAD_A1Thanks."   -> LEAK
<style>#legal{display:none</style>ok<span id="legal">PAYLOAD_A2</span>    -> LEAK
<style>.a{color:red}.legal{display:none</style>...                       -> LEAK
```

I ran 5,000 seeded stylesheets whose final block is deliberately unterminated (CDO/NF-01 cases
excluded): **474 confirmed leaks**, including the pure ` .legal{display:none` shape with no
comment, CDO, or at-rule involvement — i.e. a distinct mechanism from NF-05, not a re-report of it.

None of the three shipped generators can construct this: Generator 1 always appends
`.legal{display:none}` (closed), Generator 2 splices closed rules, Generator 3 draws from
`RULE_LIBRARY`, all closed. This defect is *outside the generators' reachable input space* — the
same class of gap WR-09 named.

**Fix:** Drain the stack after tokenization, treating each remaining frame as closing at EOF:

```ts
tokenize(css, (type, start, end) => { /* ...existing... */ });

// EOF closes every still-open block (CSS Syntax: consume-a-simple-block, EOF case).
while (stack.length > 0) {
  const frame = stack.pop()!;
  if (!frame.hasPrelude) continue;
  if (counter.total >= MAX_HARVESTED_SELECTORS) break;
  const declarationText = css.slice(Math.min(frame.contentStart, css.length));
  if (!hasHidingSignature(declarationText)) continue;
  const bare = preludeToBareSelectors(css, frame.preludeTokens);
  if (!bare) continue;
  for (const sel of bare) { /* ...same add-with-cap loop... */ }
}
```

Add a locked repro to `BYPASS_CORPUS` and an unterminated-block generator to
`tests/css-liveness-differential.test.ts` (its `AD04` counter already claims to reserve space for
"no end tag" shapes and is asserted at zero — see WR-15).

---

### CR-07: HTML character references in `class` / `id` / `style` attribute values are never decoded, so a browser-equal name is never equal here

**File:** `src/source/strip-hidden.ts:1035-1064` (`extractAttr`, `isHiddenStartTag`), `src/source/strip-hidden.ts:1092` (`NBSP_ENTITY_RE` — the only decoding, and it runs at stage 7, after tags are already deleted), false invariant asserted at `src/source/strip-hidden.ts:644-649`

**Issue:** 62-17's own doc comment justifies `decodeIdentEscapes` by asserting that "the class/id
ATTRIBUTE side (`isHiddenStartTag`, stage 5) is compared literally against **an unescaped HTML
attribute value**". That premise is false. `extractAttr` returns raw source text out of
`START_TAG_RE`'s attribute region; HTML character references in it are never decoded. So 62-17
fixed one side of an equality and left the mirror-image bypass wide open:

```
<style>.legal{display:none}</style>ok<span class="leg&#97;l">PAYLOAD_B1</span>  -> "okPAYLOAD_B1"
<style>#legal{display:none}</style>ok<span id="leg&#97;l">PAYLOAD_B2</span>     -> "okPAYLOAD_B2"
<div style="display&#58;none">PAYLOAD_B3</div>ok                               -> "PAYLOAD_B3ok"
<div style="display&colon;none">PAYLOAD_B4</div>ok                             -> "PAYLOAD_B4ok"
```

All four render hidden in Gmail. This is the *exact* threat model this module exists for: an
ATS-shaped mail hiding an injection payload behind a class, with the class name entity-encoded.
The named-reference form (`&colon;`) makes this reachable without any numeric-reference heuristic.

**Fix:** Decode HTML character references on the extracted attribute value before comparing or
signature-scanning. A minimal decoder (numeric references plus the small set of named references
that can appear inside a name or declaration: `&colon;`, `&sol;`, `&period;`, `&num;`, `&lowbar;`,
`&hyphen;`, `&NewLine;`, `&Tab;`) applied **only** inside `extractAttr` never touches prose, so the
stage-7 idempotence argument in the file-level doc block is unaffected:

```ts
function extractAttr(attrs: string, re: RegExp): string | null {
  const m = attrs.match(re);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? null;
  return raw === null ? null : decodeHtmlCharRefs(raw);
}
```

Then correct the false premise at `src/source/strip-hidden.ts:644-649` and add both shapes to
`BYPASS_CORPUS`.

---

### CR-08: `decodeIdentEscapes` consumes only the CR of a CRLF escape terminator, diverging from css-tree's own decode — a hex-escaped selector with CRLF leaks

**File:** `src/source/strip-hidden.ts:632-634` (`isEscapeSeparatorCode`), `src/source/strip-hidden.ts:687-689` (the single-code-point consume)

**Issue:** This is **new code written by 62-17**, and it disagrees with the library it is supposed
to mirror. Per CSS Syntax §3.3, CR / CRLF / FF are preprocessed to a single LF *before*
tokenization, so a CRLF following a hex escape is **one** whitespace code point and is consumed
whole. `decodeIdentEscapes` consumes one UTF-16 code unit (the CR) and leaves the LF in the name.

Measured directly against the tokenizer and the oracle:

```
css        = ".leg\61\r\nl{display:none}"
tokens     = Delim(".") Ident("leg\61\r\nl") LeftCurly ...
oracle     = classes: ['legal']                (css-tree ident.decode -> "legal")
production = decodes to "leg" + "a" + "\n" + "l"  -> no match against class="legal"
result     = stripHiddenContent(...) === "okPAYLOAD_CRLF"    -> LEAK
```

CRLF is the *native* line ending of MIME email bodies, so this is not a contrived shape — a
`<style>` block authored with Windows line endings and a hex-escaped selector hits it directly.
The escape-decode tests at `tests/strip-hidden.test.ts:651-720` cover space, no-separator, and the
6-digit cap, but never CR, CRLF, or FF, and `TOKEN_ALPHABET` contains no `\r`.

**Fix:** Consume CRLF as a single separator. Also note that the doc comment at
`src/source/strip-hidden.ts:628-631` claims this was "verified directly against `css-tree`'s
`ident.decode` during planning" for all five whitespace code points — that verification did not
cover the two-code-unit CRLF case, so the comment overstates the check that was actually done.

```ts
if (i < n && isEscapeSeparatorCode(raw.charCodeAt(i))) {
  const isCr = raw.charCodeAt(i) === 0x0d;
  i += 1;
  if (isCr && i < n && raw.charCodeAt(i) === 0x0a) i += 1; // CRLF is ONE whitespace (§3.3)
}
```

Add CR / CRLF / FF rows to `tests/strip-hidden.test.ts`'s escape block and a `'\r\n'` entry to
`TOKEN_ALPHABET`.

---

### CR-09: `MAX_HARVESTED_SELECTORS` fails OPEN — 200 junk hiding rules starve out the attacker's real one

**File:** `src/source/strip-hidden.ts:586` (the cap), `src/source/strip-hidden.ts:843`, `:851`, `:940` (the three checks)

**Issue:** Every cap check is a `return` / `break` / `continue` that **abandons further harvesting
and proceeds to strip with an incomplete hidden-set**. An attacker controls the whole stylesheet,
so exhausting the cap is a one-line operation:

```
<style>.f0{display:none}...(250 of them)....legal{display:none}</style>
ok<span class="legal">PAYLOAD_J</span>
  -> "okPAYLOAD_J"     (PAYLOAD_J leaks)
```

This is a deterministic, zero-effort bypass of the module's headline contract. Wave 10's IN-01
flagged only that the cap's *comment* overstates what it does; the fail-open security consequence
was never filed.

**Fix:** Fail closed. When the cap is hit the harvest is known-incomplete, so the document can no
longer be safely partially-stripped. Either drop the cap entirely (the real bound is the caller's
1 MiB `MAX_STRIP_INPUT_CODE_UNITS`, and 62-18 already established the token walk is linear
regardless of brace shape, so the cap no longer buys anything), or propagate an `overflowed` flag
out of `harvestHidingSelectors` and have `stripHiddenContent` emit the same fail-closed omitted
body the over-cap branch in `gmail-adapter.ts` already uses:

```ts
function harvestHidingSelectors(html: string):
  { classes: Set<string>; ids: Set<string>; overflowed: boolean } { /* ... */ }
```

Note the cap's own doc comment ("so a pathological stylesheet cannot cause quadratic work") is now
doubly wrong: the quadratic it referenced was deleted in 62-18, and the cap's only remaining
observable effect is this bypass.

---

### CR-10: A `<style>` element inside an HTML comment hijacks stage 2, so the real stylesheet's rules are never harvested

**File:** `src/source/strip-hidden.ts:1174` (stage 2) vs `:1177` (stage 3), `src/source/strip-hidden.ts:933-960` (`harvestHidingSelectors`), the `break` at `:956`

**Issue:** Stage 2 runs *before* comment removal, so `START_TAG_RE` matches `<style>` tags that a
browser sees only as comment data. `findRawtextCloseBounds` then pairs that bogus open tag with
the **real** `</style>`, feeds the whole span (HTML markup included) to `harvestFromStylesheet`
where the real rule's prelude is poisoned by the intervening HTML tokens, and advances
`START_TAG_RE.lastIndex` past the real `</style>` — so the real stylesheet is never harvested at
all.

```
<!-- <style> --><p>hi</p><style>.legal{display:none}</style>ok<span class="legal">PAYLOAD_C1</span>Thanks.
  -> "hiokPAYLOAD_C1Thanks."     (oracle: .legal is LIVE)
<!--<style-->Dear applicant,<style>.legal{display:none}</style>ok<span class="legal">PAYLOAD_C2</span>Bye.
  -> "Dear applicant,okPAYLOAD_C2Bye."
```

62-18's new `break`-on-unterminated (`:956`) widens the blast radius: a single commented-out
`<style` with no later `</style` now abandons **every** subsequent `<style>` in the document, not
just the current one. The forward-cursor transitivity argument in `findRawtextCloseBounds`'s doc
comment is correct about *close-tag scanning cost* but does not justify abandoning *open-tag
discovery*.

**Fix:** Compute the HTML comment ranges once, before stage 2, and share that list between stage 2
(skip any `<style>` open tag that begins inside a comment range) and stage 3. That single shared
range list closes NF-01 and this finding together, since both are the same root cause: stage 2 and
stage 3 disagreeing about where a comment and a RAWTEXT element begin and end — the T-62-43 bug
class 62-18 closed for `<style>`-vs-`<style>` but not for `<style>`-vs-comment.

Separately, `:956`'s `break` should become a `continue` past the current tag; only the *close-tag
scan* is transitively hopeless, not the rest of the document.

---

### CR-11: The 62-19 differential can never fail on a leak — every under-strip divergence is counted, never asserted

**File:** `tests/css-liveness-differential.test.ts:295-307` (the bucket writes), `:310-317` (`throwIfFailures`), `:344-346`, `:378-380`, `:471-473` (the magnitude bounds)

**Issue:** `runDifferential` pushes to `failures` in exactly one place — a lost `VISIBLE_SENTENCE`
(`:289-293`). Every genuine leak (`classLive && classPresent`) goes into `newlyFiled.NFDANGER_leak`,
which is only ever asserted **below a fraction of the corpus**. So the three test titles
("both directions, zero unclassified divergences") describe something that cannot happen: there is
no such thing as an unclassified leak, because the leak bucket is unconditional and needs no
predicate to enter.

Measured on a faithful replica of Generator 1 against HEAD:

```
pairs=1936  cdoSkipped=86
NFDANGER_leak    = 19    (bound: < 96.8)     <- 5x headroom for a future regression
NFSAFE_overStrip = 49    (bound: < 387.2)
```

Nineteen live leaks are being absorbed today, with room for 77 more before the gate notices. Given
that CR-05 / CR-06 / CR-07 / CR-08 / CR-09 / CR-10 above all sailed through this suite, this is the
single highest-leverage defect in the wave: it is the mechanism by which the other six ship.

The file's own doc comment concedes the design ("NF-danger/NF-safe are NOT further narrowed by a
structural predicate per mechanism — they are bounded by count instead"), but a bounded counter is
not a gate. It is also inconsistent with `tests/strip-hidden.test.ts:1354-1400`, whose fuzz probe
*does* push leaks into `leakFailures` and asserts `toEqual([])` — the correct shape, already
present in the codebase.

**Fix:** Give each NF bucket a structural predicate the way NF-01 already has (`hasUnmatchedCdo`),
and route anything that matches none of them into `failures`:

```ts
if (classLive && classPresent) {
  if (isNf03CommaList(css) || isNf04BlocklessAtRule(css) || isNf05TopLevelCdoCdc(css)) {
    newlyFiled.NFDANGER_leak += 1;
  } else {
    failures.push(`UNCLASSIFIED LEAK: css=${JSON.stringify(css)} truth=${truthSummary(truth)} out=${JSON.stringify(out)}`);
  }
}
```

Then assert `expect(newlyFiled.NFDANGER_leak).toBe(<exact count>)`, not
`toBeLessThan(N * 0.05)` — an exact count is what makes a *new* leak mechanism fail loudly.

---

## Warnings

### WR-10: `src/` can import the full `css-tree` parser AND the test-only liveness oracle — the documented compile-time guard does not exist and nothing enforces T-62-17-08

**File:** `tests/support/css-tree-ambient.d.ts:14`, `src/types/css-tree-tokenizer.d.ts:10-16`, `tsconfig.json` (`include`)

**Issue:** `src/types/css-tree-tokenizer.d.ts:10-16` states:

> "an accidental future import of the bare `css-tree` package (its parser, lexer, walker or
> generator) from a file under `src/` fails to compile, since no ambient declaration exists for
> that import path from `src/`'s perspective."

This is false. `declare module 'css-tree'` in `tests/support/css-tree-ambient.d.ts` is a
**program-global** ambient declaration — TypeScript ambient module declarations have no directory
scope, and `tsconfig.json`'s `include` is `["src","tests","scripts"]`, so the whole program sees
it. Proven by construction (probe file created, checked, deleted; working tree left clean):

```ts
// src/source/__probe-ambient.ts
import { parse, walk, ident } from 'css-tree';
import { liveHidingSelectors } from '../../tests/support/css-liveness-oracle';
export const probe = [parse, walk, ident, liveHidingSelectors];
```
```
$ npx tsc --noEmit   ->  exit 0, zero errors
$ mv tests/support/css-tree-ambient.d.ts /tmp/ && npx tsc --noEmit
src/source/__probe2.ts(1,23): error TS7016: Could not find a declaration file for module 'css-tree'.
```

So the ambient file is precisely what unlocks `src/`, and removing it restores the intended error.
Both halves of T-62-17-08 fail: the parser surface *and* the oracle import compile cleanly from
`src/`. The only enforcement anywhere is a one-shot `grep` embedded in `62-17-PLAN.md:315`'s verify
gate — a planning artifact, not a shipped test. `tests/` is also inside `rootDir`, so a `src/`
import of the oracle would be emitted into `dist/` by `npm run build`.

Not classified Critical because no `src/` file violates the invariant today — but the invariant is
documented as guaranteed, is not, and has no regression lock.

**Fix:** Two parts.

1. Replace the global ambient with a scoped one so `src/` genuinely cannot see it — e.g. give
   `tests/` its own `tsconfig` with a `paths` entry, or narrow the declaration to a private
   specifier the oracle re-exports (`declare module 'css-tree-parser-testonly'` plus a `paths`
   alias under a tests-only config).
2. Ship the grep as a test alongside the existing source-guard block in
   `tests/strip-hidden.test.ts:1441+`:

```ts
it('T-62-17-08: no file under src/ imports the bare css-tree package or the test-only oracle', () => {
  const offenders: string[] = [];
  for (const f of walkSync('src')) {
    const src = readFileSync(f, 'utf8');
    if (/from ['"]css-tree['"]/.test(src)) offenders.push(`${f}: bare css-tree`);
    if (/tests\/support\//.test(src)) offenders.push(`${f}: tests/support`);
  }
  expect(offenders).toEqual([]);
});
```

---

### WR-11: `. legal` (whitespace between the `.` and the ident) is now harvested — an over-strip regression introduced by 62-17

**File:** `src/source/strip-hidden.ts:738` (the unconditional whitespace filter), `:748-758`

**Issue:** `preludeToBareSelectors` drops **all** `WhiteSpace` tokens before shape-matching, so
`. legal` and `.legal` become indistinguishable. In CSS, whitespace between `.` and an ident is a
descendant combinator, making the selector invalid — a browser drops the rule entirely.
Confirmed regression against `0714166`:

```
<style>. legal{display:none}</style>ok<span class="legal">VISIBLE_D1</span>Thanks.
  oracle: NOT LIVE      old (0714166): "okVISIBLE_D1Thanks."      new: "okThanks."
```

Safe direction (content loss, not a leak), but it is real content loss on input a browser shows,
and it is a behavior change this wave's own equivalence claims did not identify. It is also not
reachable by any shipped generator (`.legal` is always a single alphabet unit, never `.` + ` ` +
ident), so nothing locks it either way.

**Fix:** Reject a group whose `Delim('.')` is not *immediately adjacent* to its `Ident`, using the
offsets already carried in the token triples:

```ts
if (
  tokens.length === 2 &&
  tokens[0]![0] === TT_DELIM &&
  css.slice(tokens[0]![1], tokens[0]![2]) === '.' &&
  tokens[1]![0] === TT_IDENT &&
  tokens[0]![2] === tokens[1]![1]   // adjacency: no whitespace between . and ident
) { /* ... */ }
```

(Careful: a `Comment` between them, `./*x*/legal`, *is* still `.legal` to a browser, so adjacency
must be computed after comment removal, not before.)

---

### WR-12: Comment text inside a declaration block counts as a hiding signature (over-strip half of CR-05)

**File:** `src/source/strip-hidden.ts:846-847`

**Issue:** Same raw-text mechanism as CR-05, opposite direction — the declaration slice includes
comment bodies, so a commented-out declaration hides the element:

```
<style>.legal{/*display:none*/color:red}</style>ok<span class="legal">VISIBLE_K4</span>
  -> "ok"     (VISIBLE_K4 destroyed; a browser shows it in red)
```

Commented-out CSS is extremely common in real marketing/ATS templates, so this is not a synthetic
shape. The prelude side already skips `Comment` tokens (`:823`); the declaration side does not.

**Fix:** Covered by CR-05's fix (build `declarationText` from tokens, skipping `Comment`).

---

### WR-13: `class` attribute values are split on JavaScript `\s`, not HTML's five ASCII whitespace characters

**File:** `src/source/strip-hidden.ts:1057`

**Issue:** `cls.split(/\s+/)` splits on NBSP, `\v`, and the Unicode space separators. HTML splits a
`class` attribute on ASCII whitespace only (space, tab, LF, FF, CR), so `class="a<NBSP>legal"` is
**one** token to a browser and `.legal` does not match it. recense splits and matches:

```
<style>.legal{display:none}</style>ok<span class="a<NBSP>legal">VISIBLE_NBSP</span>  -> "ok"
```

Over-strip, so not Critical, but it is a divergence from the spec the module claims fidelity to,
and NBSP is common in HTML mail.

**Fix:** `cls.split(/[ \t\n\f\r]+/)`.

---

### WR-14: Two of the three "worst 3" cap-boundary shapes are byte-identical, so only two shapes are actually measured

**File:** `tests/gmail-hidden-content.test.ts:432-454`

**Issue:** `worst3Shapes[0]` ("report (a<x repeated, no braces, in `<style>`)") and
`worst3Shapes[1]` ("CSS: brace-free a<x (62-16 decision record item 4)") build the **exact same
string** — same unit `'a<x '`, same `padToExactLength`, same wrapper, same length. Different
labels, identical input. So the block that exists to "re-establish the cap's cost argument on the
CORRECTED shape set" measures two distinct shapes while claiming three, and one of the shapes named
in the 62-18 justification is silently unmeasured.

**Fix:** Make the second row the shape its label claims, or delete it and rename the block to
"worst 2". If both genuinely are the same shape, that fact belongs in the 62-18 SUMMARY's
measurement table too, which currently lists them as separate rows.

---

### WR-15: `AD04` is never incremented, so `expect(counters.AD04).toBe(0)` is a tautology asserted three times

**File:** `tests/css-liveness-differential.test.ts:154-159` (declaration), `:163` (init), `:341`, `:377`, `:469` (assertions)

**Issue:** Nothing anywhere writes `counters.AD04`. The three assertions can never fail. The
comment frames this as "included and asserted at exactly zero, so the constraint stays visible" —
but a counter with no write site does not encode a constraint; if a future generator *did* start
emitting unterminated-`<style>` inputs, `AD04` would still be 0 and the assertion would still pass.

This matters concretely: CR-06 above is exactly the unterminated-block family `AD04` claims to
reserve space for, and it is a live leak.

**Fix:** Either delete `AD04` and its three assertions, or give it a real write site and extend the
generators to construct such inputs (which doubles as the CR-06 regression lock):

```ts
if (!/<\/style\b/i.test(html)) counters.AD04 += 1;
```

---

### WR-16: Several doc comments now contradict the code directly beneath them

**File:** `tests/css-liveness-adjudication.test.ts:322-329`, `tests/support/css-liveness-oracle.ts:9-11` and `:21-27`, `tests/gmail-hidden-content.test.ts:325-335`

**Issue:** In a module whose entire safety argument is carried in prose, prose that contradicts the
code is a correctness hazard, not a style nit:

- `tests/css-liveness-adjudication.test.ts:322-327` states "shipped `stripHiddenContent` **NEVER**
  harvests an escaped selector regardless of what it decodes to — **every row here has payload
  PRESENT**", and the `describe` on `:329` is titled "never harvested by shipped code". The two
  tests immediately below (`:339-345`, `:356-362`) assert `shippedPresent(row) === false`, i.e. the
  exact opposite. 62-17 changed the behavior and updated the individual `it` titles but not the
  block header.
- `tests/support/css-liveness-oracle.ts:9-11` and `:21-27` describe production as "the production
  regex/cursor scan `strip-hidden.ts` hand-rolls" and "production's **brace-partition scan** has
  the identical blind spot". That scan was deleted in 62-17. A future reader auditing the oracle's
  independence claim will be reading a description of a module that no longer exists — and, per
  CR-05, the layer that *is* still shared goes unmentioned.
- `tests/gmail-hidden-content.test.ts:325-335` still concludes "**Shape T is what bounds the cap
  value**" — the claim 62-18 explicitly falsified, and which the same commit rewrote
  `gmail-adapter.ts`'s doc block to call "WRONG, not merely incomplete". The same file now carries
  both the falsified claim and its refutation, ~100 lines apart.

**Fix:** Update all three to describe the shipped behavior. For the oracle, restate the
independence argument in terms of what is actually shared today (tokenizer **and**
declaration-signature regexes).

---

## Info

### IN-06: Vacuous assertion standing in for a structural check

**File:** `tests/css-liveness-adjudication.test.ts:157-166`

**Issue:** `expect(true).toBe(true)` inside a test whose stated purpose is "structural proof ...
`strip-hidden.ts`'s source no longer contains `matchesUrlOpen` at all". The proof is delegated to a
grep in a planning document; the test asserts nothing.

**Fix:** Make it the grep it describes — `tests/strip-hidden.test.ts` already has `SOURCE` /
`COMMENT_STRIPPED_SOURCE` helpers to copy:
`expect(COMMENT_STRIPPED_SOURCE).not.toMatch(/matchesUrlOpen|stripCssComments|BARE_(CLASS|ID)_SELECTOR_RE/)`.

### IN-07: Test comment describes behavior the code does not have

**File:** `tests/strip-hidden.test.ts:677-679`

**Issue:** "the run stops at exactly 6 digits (**the 7th input position is never consulted**)".
`decodeIdentEscapes` does consult it — `src/source/strip-hidden.ts:687` checks it for a whitespace
separator immediately after the digit loop. The test passes only because `l` is not whitespace; a
reader relying on this comment would mispredict `.leg\000061 l`.

**Fix:** Reword to "the 7th position is consulted only as a possible whitespace terminator, never
as a 7th hex digit", and add `\000061<space>l` as its own row (it is also adjacent to CR-08).

### IN-08: The out-of-range-escape test asserts only that nothing throws

**File:** `tests/strip-hidden.test.ts:714-718`

**Issue:** Unlike its U+0000 and surrogate siblings (`:702-712`), the `\110000` row never checks
whether `PAYLOAD_OOR` survives — so the actual U+FFFD mapping for the `> U+10FFFF` branch
(`src/source/strip-hidden.ts:691-693`) is untested; only totality is.

**Fix:** Add `expect(stripHiddenContent(...)).toContain('PAYLOAD_OOR')` to match the other two rows.

### IN-09: `findRawtextCloseEnd` is now a single-caller pass-through

**File:** `src/source/strip-hidden.ts:493-496`, sole caller at `:514`

**Issue:** After 62-18 introduced `findRawtextCloseBounds`, this wrapper adds one line of
null-coalescing for exactly one caller, and its doc comment (`:487-492`) is four times the length
of its body and mostly explains why it still exists.

**Fix:** Inline it into `findMatchingCloseEnd`
(`const b = findRawtextCloseBounds(html, lower, fromIndex); return b?.elementEnd ?? html.length;`)
and move the fail-safe rationale into that function's comment. Low priority; noted for the record.

---

## Verification notes

- All Critical repros were run against HEAD via `npx tsx` importing `src/source/strip-hidden.ts`
  directly, with `tests/support/css-liveness-oracle.ts` supplying the browser-verdict ground truth.
- CR-05 / CR-06 / CR-07 / CR-09 / CR-10 were also run against
  `git show 0714166:src/source/strip-hidden.ts` and produce **byte-identical output there** —
  pre-existing, not regressions from waves 11-14. CR-08 (CRLF) is in code introduced by 62-17.
  WR-11 (`. legal`) is a confirmed behavior change from `0714166`.
- A 30,000-input old-vs-new differential over `<style>`-shell and prelude-shape variations found
  **zero** leak-direction regressions between `0714166` and HEAD, which corroborates the wave's own
  equivalence claims for the shapes it enumerated. Every finding above is outside that enumeration.
- `npx vitest run tests/css-liveness-differential.test.ts tests/css-liveness-adjudication.test.ts
  tests/css-tokenizer-conformance.test.ts` passes on HEAD (59 passed, 4 expected-fail) with all
  seven Critical findings live.
- No source files were modified. The temporary `src/source/__probe-ambient.ts` /
  `src/source/__probe2.ts` used to prove WR-10 were deleted, and
  `tests/support/css-tree-ambient.d.ts` was moved and restored; `git status --porcelain` is clean.
- Known open items (NF-01, NF-03, NF-04, NF-05, REG-01, WR-03, T-62-16-02) were re-checked and are
  correctly stated in their locked repros; none is re-filed here. One correction: NF-01's `it.fails`
  repro at `tests/css-liveness-differential.test.ts:486-500` is accurate, but CR-10 above shows the
  same stage-2/stage-3 boundary disagreement also produces a **leak**, not only NF-01's
  availability loss — one shared fix (a single pre-computed comment-range list) closes both.

---

_Reviewed: 2026-07-31T14:40:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
