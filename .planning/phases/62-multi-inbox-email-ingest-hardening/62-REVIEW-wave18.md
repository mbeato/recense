---
phase: 62-multi-inbox-email-ingest-hardening
reviewed: 2026-08-01T02:55:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - src/source/strip-hidden.ts
  - src/source/gmail-adapter.ts
  - src/types/css-tree-tokenizer.d.ts
  - tests/strip-hidden.test.ts
  - tests/gmail-hidden-content.test.ts
  - tests/css-liveness-differential.test.ts
  - tests/support/css-liveness-oracle.ts
  - tests/support/css-tree-ambient.d.ts
  - tests/html-parser-conformance.test.ts
  - tests/src-import-boundary.test.ts
  - tests/tsconfig.json
  - tsconfig.json
  - package.json
findings:
  critical: 3
  warning: 10
  info: 0
  total: 13
status: issues_found
---

# Phase 62 (waves 15-18): Code Review Report

**Reviewed:** 2026-08-01T02:55:00Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Waves 15-18 (plans 62-20..62-25) move the CSS declaration layer and the whole HTML layer
onto conformant third-party tokenizers, split the tsconfig projects, and turn the CSS
liveness differential into a hard gate. The wave-scoped work is real: `hasHidingSignatureFromTokens`,
the EOF frame drain, the deleted fail-open cap, the CRLF escape fix, `scanHtml`'s single pass,
and the `attributeLeak` predicate gate all do what their plans claim, and the full suite passes
(404 passed / 4 expected-fail, `npm run typecheck` clean).

That is not the same as the module being correct. Three defects survive at the ingest boundary,
all reproduced by direct execution against the shipped module at HEAD:

1. **A CSS-hidden injection payload still leaks** on `<style/>` (self-closing start-tag syntax) —
   the shape whose exclusion `scanHtml` re-asserts in NEW code, with a justification (`"preserving
   stage 4's NON_CONTENT_TAGS removal's own treatment of it"`) that 62-24 made factually false when
   it deleted the code that treatment lived in.
2. **A ~18-minute-CPU availability hole** inside the 1 MiB cap, in the one stage this wave set
   explicitly waved through as an "ACCEPTED residual", directly falsifying 62-22's own
   re-derivation of `MAX_STRIP_INPUT_CODE_UNITS` (measured: 68 s at 256 KB, 4.0 s end-to-end
   through `normalizeGmailMessage` at 64 KB).
3. **`<iframe>` / `<noembed>` / `<noframes>` fallback content** — text no browser ever renders —
   passes straight into `record.content`, in a module whose entire stated purpose is that text a
   human cannot see must not reach the model's token stream.

None of the three is reachable by the phase's own oracle-driven differential, because that
differential holds the HTML wrapper fixed at `'<style>' + css + '</style>' + ...` and varies only
the CSS. Three consecutive plans (62-21/62-22/62-24) rewrote the HTML layer; no HTML-layer
differential was built for any of them. That coverage shape — not any individual bug — is the
finding I would fix first (WR-03).

Defects 1 and 3 also exist at the review base (`c144c23`), verified by running the base revision;
they are reported here because no prior round dispositioned them in the form they actually take
(wave10's WR-03 described a *different, weaker* symptom and rated it WARNING), and because this
wave's own code and doc comments re-assert premises the repros contradict.

## Critical Issues

### CR-01: `<style/>` bypasses the hiding-selector harvest while stage 4 deletes the stylesheet — CSS-hidden payload reaches `record.content`

**File:** `src/source/strip-hidden.ts:663`, `:694-704`, `:1576-1580`

**Issue:** `scanHtml` marks any `<style>` start tag whose raw text ends `/>` as `selfClosingSyntax`
and excludes it from `styleElements` (`:694`), so stage 2 harvests **nothing** from it. Stage 4/5
(`collectStartTagRemovalRanges`, `:1576-1579`) does **not** share that opinion — it removes
`[tagStart, elementEnd)` for every `style` start tag unconditionally, and `elementEnd` comes from
htmlparser2's real close event. Net effect: the stylesheet text is deleted (so nothing looks wrong
in the output) and the elements it hides are **not** removed.

HTML does not honour self-closing syntax on non-foreign elements — this file's own conformance gate
asserts it (`tests/html-parser-conformance.test.ts:283`: *"self-closing start-tag syntax `<style/>`
is a spec-correct no-op (style is not a void element): the element opens normally"*). A browser
applies the rule; recense does not. Reproduced at HEAD:

```
in : '<style/>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>'
out: "okPAYLOAD"                      // browser: "ok"

in : '<style />.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>'
out: "okPAYLOAD"

in : '<STYLE/>.legal{display:none}</STYLE>ok<span class="legal">PAYLOAD</span>'
out: "okPAYLOAD"

in : '<style type=a/>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>'
out: "okPAYLOAD"                      // any unquoted attribute ending in "/" also triggers it

control:
in : '<style>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>'
out: "ok"
```

The comment justifying the exclusion at `:695-698` is stale in a load-bearing way:

> *"a self-closing `<style/>` is deliberately excluded here, preserving stage 4's `NON_CONTENT_TAGS`
> removal's own treatment of it (`SELF_CLOSING_SUFFIX_RE`, above) — stage 2 must not silently start
> harvesting a shape stage 4/5 still treats as self-closing."*

Stage 4/5 stopped treating it as self-closing in 62-24, when `collectRemovalRanges` (the only
consumer of `SELF_CLOSING_SUFFIX_RE` outside `scanHtml`) was deleted. The exclusion is now
one-sided, which is precisely the T-62-43 cross-stage boundary class the file claims to have
retired — re-introduced by the plan that claimed to close it.

**Fix:** RAWTEXT elements are never self-closing. Drop the flag for them so stage 2 and stage 4
agree, and delete `SELF_CLOSING_SUFFIX_RE`'s remaining use:

```ts
// scanHtml, onopentag — style/script/title/textarea can never be self-closed by syntax
const selfClosingSyntax = false; // (or: remove the field entirely for RAWTEXT names)
```

i.e. in `onclosetag`, push to `styleElements` for every `frame.record.name === 'style'`. Add
the four repro rows above to `tests/strip-hidden.test.ts` as leak locks, and a control asserting
`<style/>` no longer emits its own CSS text as prose (the wave10 WR-03 symptom, already fixed by
stage 4's removal).

---

### CR-02: stage 6's `ANY_TAG_RE` sweep is quadratic on input the earlier stages *create* — ~18 min of ingest CPU inside the 1 MiB cap

**File:** `src/source/strip-hidden.ts:1468` (`ANY_TAG_RE`), `:1585-1587` (stage 6), `:293-296`
(the "ACCEPTED residual" claim), `src/source/gmail-adapter.ts:384-407` (62-22's cap re-derivation), `:419`

**Issue:** `ANY_TAG_RE = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g` is run with `.replace()` over the
post-deletion string. `[^'">]` **includes** `<`, so on a run of `<` with no `>` anywhere after it,
the scan fails from every start position after consuming the whole remaining tail — O(n²). Stage 0
(Bound A) hoists a stray-`<` truncation that would delete exactly that region, but it runs *before*
stages 3/4/5; stage 6's own truncation (`:1586-1587`) runs *after* the expensive `.replace()`. The
file anticipates the input shape and guards the wrong side of it:

> `:112-113` — *"stages 4 and 5 delete ranges and can expose a NEW stray `<` that stage 0 could not
> have seen; Bound A is an addition, not a move."*

Deleting a single element or comment is enough to strip every `>` from the document and expose a
million-character `<` run. Measured at HEAD (`stripHiddenContent`, body = `'<'.repeat(n) + '<div
style="display:none">Y</div>'`):

| n (code units) | wall clock |
|---|---|
| 1,000   | 2.4 ms |
| 4,000   | 19.9 ms |
| 16,000  | 266.5 ms |
| 64,000  | 4,287.5 ms |
| 256,000 | 68,242.9 ms |
| 1,048,543 (the cap) | ~1,090,000 ms extrapolated (~18 min) at the clean 16x-per-4x curve |

A trailing HTML comment is an equally good trigger (no hidden element needed):
`'<'.repeat(64000) + '<!--c-->'` → 4,012.6 ms. End-to-end through the real ingest path,
`normalizeGmailMessage` with a 64 KB body: **4,018.0 ms** — already 4x the module's own 1000 ms
budget at 1/16 of the permitted body size, and the sender chooses both the bytes and the size.

This falsifies 62-22's re-derivation of `MAX_STRIP_INPUT_CODE_UNITS` in the same way T62-91
falsified 62-15's: the 29-shape set is drawn from prior waves' shape history and contains no
"many `<` + one removable construct" row, so the claimed *"Every shape stays over 20x under the
1000 ms budget"* (`gmail-adapter.ts:403-405`) is a statement about the shape set, not about the
cap. The new cost block in `tests/gmail-hidden-content.test.ts` measures two shapes and inherits
the same blind spot. The residual note at `:293-296` rests on the premise *"both run on a string
later stages have already reduced"* — the reduction is what builds the pathological input.

**Fix (minimal, mirrors Bound A exactly):** re-hoist the truncation to just *before* the stage-6
sweep, on the post-deletion string, so the failing-scan region is gone before `.replace()` pays
for it:

```ts
s = applyRemovalRanges(s, mergeCommentAndElementRanges(scan.comments, elementRanges));

// Bound A, re-applied: stages 3/4/5 can expose a NEW stray `<` after the last `>`.
const lastGt = s.lastIndexOf('>');
const strayAfterRemoval = s.indexOf('<', lastGt + 1);
if (strayAfterRemoval !== -1) s = s.slice(0, strayAfterRemoval);

s = s.replace(ANY_TAG_RE, '');
```

Add the `'<'.repeat(n) + <removable>` family (both triggers) to the cap measurement block at
exactly `MAX_STRIP_INPUT_CODE_UNITS`, and re-derive the constant against it before claiming the
20x margin again.

---

### CR-03: `<iframe>` / `<noembed>` / `<noframes>` fallback content — never rendered by any browser — is emitted verbatim into `record.content`

**File:** `src/source/strip-hidden.ts:1225-1227` (`NON_CONTENT_TAGS`), `:593` (`RAWTEXT_CLOSE_SLASH_RE`)

**Issue:** Guard-set ≠ ship-set, inside one file. `RAWTEXT_CLOSE_SLASH_RE` enumerates the eight
raw-text element names the module knows about (`script|style|title|textarea|iframe|noembed|noframes|xmp`);
`NON_CONTENT_TAGS` — the set whose contents stage 4 actually deletes — is a *different*,
hand-maintained seven (`script|style|head|title|template|noscript|svg`). `iframe`, `noembed` and
`noframes` appear in the first and not the second. Their contents are invisible in every modern
browser (an `<iframe>`'s fallback content is never rendered; `<noembed>`/`<noframes>` likewise),
and Gmail strips the elements outright, so a human sees nothing — while the text reaches the LLM
extractor's token stream. That is the EchoLeak-class carrier this module exists to close.
Reproduced at HEAD:

```
in : '<iframe>INJECT_U1</iframe>ok'      out: "INJECT_U1ok"
in : '<noembed>INJECT_U2</noembed>ok'    out: "INJECT_U2ok"
in : '<noframes>INJECT_U3</noframes>ok'  out: "INJECT_U3ok"
```

(`<xmp>` and `<plaintext>` are correctly kept — both *are* rendered. `<textarea>` is arguably
keepable; Gmail strips it, but its value is visible in a browser.)

Secondary consequence of the same gap: htmlparser2 does not treat `iframe`/`noembed`/`noframes` as
RAWTEXT either, so markup inside them is tokenized as real elements — see WR-01.

**Fix:** one source for the set, and add the three names:

```ts
const NON_CONTENT_TAGS = new Set([
  'script', 'style', 'head', 'title', 'template', 'noscript', 'svg',
  'iframe', 'noembed', 'noframes',
]);
```

and add a leak lock per name to `tests/strip-hidden.test.ts`. If the two lists must stay separate,
add a source guard asserting `RAWTEXT_CLOSE_SLASH_RE`'s name list ⊆ (`NON_CONTENT_TAGS` ∪ an
explicitly-named rendered-RAWTEXT allowlist) so the next divergence fails the suite.

## Warnings

### WR-01: a `<style>` in a context a browser never applies (inside `<iframe>`/`<noscript>`/`<template>`) is harvested and deletes visible prose

**File:** `src/source/strip-hidden.ts:1179-1189`, `:694-704`

**Issue:** `harvestHidingSelectors` consumes every `styleElement` `scanHtml` reports, with no notion
of whether a browser would apply that stylesheet. htmlparser2 does not implement RAWTEXT for
`iframe` (nor scripting-enabled RAWTEXT for `noscript`), so a `<style>` written inside them is
parsed as a live element. Reproduced:

```
in : '<iframe><style>.legal{display:none}</style></iframe>ok<span class="legal">VIS</span>'
out: "ok"          // browser: "okVIS" — iframe content is raw text, the rule is never applied

in : '<noscript><style>.legal{display:none}</style></noscript>VIS<span class="legal">Q</span>'
out: "VIS"         // Q deleted on a rule a scripting-enabled browser never applies
```

Same direction as documented residuals (d)/(e) (errs toward removing content), but this one is
undocumented and, unlike them, deletes prose the recipient *does* see. Fix: skip harvest for
`styleElements` whose `contentStart` lies inside an `iframe`/`noembed`/`noframes`/`template`
element range (available from `scan.startTags`), or accept it explicitly as residual (f) with a
repro row, rather than leaving it unnamed.

### WR-02: `attributeLeak` attributes by co-occurrence, not causation — a novel leak mechanism co-occurring with a CDO/CDC is silently absorbed

**File:** `tests/css-liveness-differential.test.ts:417-439`, `:346-406`

**Issue:** `isNf04BlocklessAtRule(css)` and `isNf05TopLevelCdoCdc(css)` take no probe name and test
only whether the *input contains* the named shape anywhere; `isNf03CommaList` at least matches on
the probe but still only asserts the shape exists. A leak caused by a mechanism nobody has named
yet, in an input that also happens to carry a top-level `-->`, is counted as NF-05 and never
reaches `failures`. That is not hypothetical scale: the generators' own alphabet contains `<!--`
and `-->`, and NF-05 fires on 16 / 461 / 277 inputs across the three generators. The gate is
strictly better than the magnitude bound it replaced, but the file's claim that a leak "matching no
named predicate is NOT counted anywhere" understates how wide the named predicates are.

**Fix:** make each predicate causal — re-run the harvest with the offending construct removed
(`css.replace('-->','')`, `@media;` deleted, the non-bare sibling dropped) and require that the
leak *disappears*. If it persists, it is a different mechanism and must reach `failures`.

### WR-03: the phase's only oracle-driven differential holds the HTML wrapper fixed, so no HTML-layer divergence is reachable by it

**File:** `tests/css-liveness-differential.test.ts:510-515`

**Issue:** every generated case is `'<style>' + css + '</style>' + 'VISIBLE_SENTENCE' + <span
class="…">/<span id="…">`. The wrapper never varies: no self-closing `<style/>`, no `</style foo>`,
no attribute entity encoding, no nested/implied-close shapes, no non-`<style>` RAWTEXT elements.
Plans 62-21, 62-22 and 62-24 moved the *entire* HTML layer onto a new parser; the only HTML-layer
test built for them (`tests/html-parser-conformance.test.ts`) exercises htmlparser2 in isolation
and explicitly *"must never import the markup stripper module"* — so nothing differentially tests
production's *use* of the parser. CR-01 and CR-03 both live in exactly that uncovered band, which
is the same WR-09 root cause this file's own header says it exists to close, displaced one layer up.

**Fix:** add an HTML-wrapper generator: a small alphabet of tag shapes (`<style>`, `<style/>`,
`</style foo>`, `</style/>`, entity-encoded `class`/`id`/`style` values, implied-close siblings,
`<iframe>`/`<noscript>` nesting) crossed against a fixed hiding rule, with ground truth from a
conformant parser (`parse5`, already evaluated in 62-21) rather than from htmlparser2 — which
production now shares and therefore cannot adjudicate.

### WR-04: the `it.fails` repros bundle a ground-truth precondition with the defect assertion, so an oracle regression makes them pass for the wrong reason

**File:** `tests/css-liveness-differential.test.ts:768-822`

**Issue:** each `it.fails` block asserts the oracle verdict first (`expect(truth.classes.has('legal')).toBe(true)`)
and the leak second. `it.fails` passes when *anything* in the body throws. If `liveHidingSelectors`
regresses and stops reporting `.legal` as live, the first assertion throws, the test still passes,
and the phase's ground-truth oracle silently rots inside the tests that exist to keep the defect
visible. Fix: assert the precondition in a separate passing `it`, and leave only the leak assertion
inside `it.fails`.

### WR-05: ~14 deleted identifiers are still referenced ~60 times in the doc block, including as "see X below" navigation

**File:** `src/source/strip-hidden.ts:520`, `:748-754`, `:1127-1151`, `:1217`, and throughout

**Issue:** counted against the shipped file — mentions / definitions: `START_TAG_RE` 15/0,
`STYLE_BLOCK_RE` 14/0, `findRawtextCloseBounds` 7/0, `stripCssComments` 7/0,
`RAWTEXT_CLOSE_TAIL_RE` 6/0, `findMatchingCloseEnd` 5/0, `ANY_TAG_TOKEN_RE` 5/0,
`findRawtextCloseEnd` 4/0, `RAWTEXT_ELEMENTS` 4/0, `collectRemovalRanges` 3/0, `matchesUrlOpen` 3/0,
`VOID_ELEMENTS` 1/0, `collectRemovalAndElementRanges` 1/0. Two are actively misleading rather than
merely historical:

- `:520` — *"a THIRD, `</style/>`, … is now RECOVERED -- see `RAWTEXT_ELEMENTS`'s own doc comment
  below"*: `RAWTEXT_ELEMENTS` does not exist; the doc is on `RAWTEXT_CLOSE_SLASH_RE`.
- `:748-754` — the Stage 2 section header still describes the **current** mechanism as
  *"Stage 2 now locates `<style>` elements with the same `START_TAG_RE` + `findRawtextCloseBounds`
  primitives stage 4 already used"*, corrected only 400 lines later.
- `:1217` — points readers at `collectRemovalAndElementRanges`; the function is
  `mergeCommentAndElementRanges`.

CR-01 is a direct consequence of this class of drift (a justification comment that outlived the
code it describes). Fix: collapse the per-plan gap-closure narrative into a short current-state
description plus a dated changelog, and add a source guard asserting every backticked
`CONSTANT_CASE`/`camelCase` identifier in the doc block resolves to a definition in the file or to
a `(deleted, 62-NN)` marker.

### WR-06: `npm run typecheck` is not wired into CI, and the root project no longer typechecks `tests/`

**File:** `tsconfig.json:17`, `package.json:37`, `.github/workflows/ci.yml:46-50`

**Issue:** 62-23 narrowed the root `include` from `["src","tests","scripts"]` to `["src","scripts"]`
— correct for the WR-10 boundary fix — and added a `typecheck` script covering both projects. CI
runs `npm run build` (root project only) and `npm test` (vitest, which transpiles without
typechecking); nothing runs `npm run typecheck`. Before this change `npm run build` typechecked the
test tree; now a type error anywhere under `tests/` passes CI silently. The `src/` boundary itself
is still enforced (root project runs in CI), so this is enforcement coverage, not a boundary hole.
Fix: add `- name: Typecheck / run: npm run typecheck` to `.github/workflows/ci.yml` next to the
existing Build step (an `apps/tray` typecheck step already sets the precedent).

### WR-07: two new hard wall-clock assertions in CI

**File:** `tests/gmail-hidden-content.test.ts` (62-22 block, `expect(elapsed).toBeLessThan(1000)` at
exactly 1 MiB), `tests/html-parser-conformance.test.ts:384` (`expect(elapsed).toBeLessThan(5000)` for
20,000 parses)

**Issue:** both are absolute wall-clock thresholds on shared CI runners (ubuntu-22.04 + macos-15
matrix), the same construction as the already-known-flaky WR-02 growth-ratio assertion. The 1000 ms
budget is measured at ~47 ms locally — 20x headroom, which is defensible — but a loaded macOS runner
regularly exceeds 20x on a single-threaded 1 MiB workload. Fix: keep the budget as the *documented*
contract but assert it against a same-process calibration baseline (e.g. time a fixed reference
workload in the same test and assert a ratio), or mark both as `it.concurrent`-free perf tests
gated behind an env flag so a runner hiccup does not red the merge queue.

### WR-08: spy on `Parser.prototype.write` is restored outside `try/finally`

**File:** `tests/strip-hidden.test.ts` — "stripHiddenContent computes exactly one scanHtml pass per call"

**Issue:** `const spy = vi.spyOn(Parser.prototype, 'write'); … expect(callsAfter - callsBefore).toBe(1); spy.mockRestore();`
— if the expectation fails, `mockRestore()` never runs and the prototype stays patched for every
subsequent test in the file. The T-62-22-02 test immediately above gets this right with
`try/finally`; this one does not. Fix: wrap in `try/finally` (or `afterEach(() => vi.restoreAllMocks())`).

### WR-09: `applyRemovalRanges` silently re-emits deleted text if its ascending/non-overlapping precondition is ever violated

**File:** `src/source/strip-hidden.ts:467-477`, `:1433-1451`

**Issue:** the precondition is argued in prose (`mergeCommentAndElementRanges`'s doc block) and
never checked. If a nested range ever reaches it — e.g. `[[10,50],[20,30]]` — the cursor moves
*backwards* (`cursor = end` with `end < cursor`) and the final `result += html.slice(cursor)`
re-emits characters 30..50 that the earlier range was supposed to delete. The failure mode of a
broken containment argument is therefore a **content leak**, not a crash or a truncation, in the
one function every stage's output flows through. `mergeCommentAndElementRanges` also sorts by
`a[0]` only, so ties are order-dependent. Fix: normalize instead of assuming —

```ts
function applyRemovalRanges(html: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return html;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let result = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;          // fully consumed by a prior range
    if (start > cursor) result += html.slice(cursor, start);
    cursor = end;                          // monotonic by construction
  }
  return result + html.slice(cursor);
}
```

### WR-10: the close-tag end scan is not quote-aware, leaving attribute fragments in the output

**File:** `src/source/strip-hidden.ts:679-680`

**Issue:** `html.indexOf('>', closeEnd)` finds the first literal `>` — including one inside a quoted
attribute value on the close tag — and htmlparser2's own `fastForwardTo('>')` has the same gap. Per
HTML §13.2.5, a close tag's attributes are tokenized like a start tag's, so `</div foo="a>b">` ends
at the *last* `>`. Reproduced:

```
in : '<div style="display:none">SECRET</div foo="a>b">tail'
out: "b\">tail"      // browser: "tail"
```

The hidden payload is correctly removed (this is not a leak), but `b">` — sender-controlled bytes
from inside a tag — survives into `record.content`, which the module's own "every remaining tag is
removed" contract says should not happen. Fix: reuse the shared `ATTRS` quote-aware fragment for
the forward scan rather than a bare `indexOf('>')`, or accept it as a named residual with a repro
row (the file names five residuals already; this is a sixth).

---

_Reviewed: 2026-08-01T02:55:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
