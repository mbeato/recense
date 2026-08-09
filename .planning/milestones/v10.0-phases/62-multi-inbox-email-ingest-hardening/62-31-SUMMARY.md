---
phase: 62-multi-inbox-email-ingest-hardening
plan: 31
subsystem: security
tags: [html-parsing, prompt-injection, EMAIL-03, strip-hidden, doc-hygiene, gap-closure, round-7-close]

# Dependency graph
requires:
  - phase: 62 (plan 29)
    provides: "HTML_ELEMENT_DISPOSITIONS; CR-01/CR-03/WR-01 closed"
  - phase: 62 (plan 30)
    provides: "Stage-6 linear sweep (CR-02 closed); calibration-relative cost gates"
provides:
  - "applyRemovalRanges — self-normalizing removal-range application (total sort, consumed-range skip, monotonic cursor), closing WR-09's silent-re-emission failure mode"
  - "findUnquotedGt — quote-aware close-tag boundary scan, closing WR-10's in-tag-byte survival"
  - "strip-hidden.ts's file-level doc block collapsed to current-state + changelog + deletion registry, with a shipped, non-vacuous guard (tests/strip-hidden.test.ts) that fails the suite on a stale identifier reference"
  - "Round-7 (waves 20-24, plans 62-27..62-31) closed with dist/-level, freshly-rebuilt evidence: CR-01, CR-02, CR-03, WR-01, WR-05, WR-09, WR-10 all confirmed; residual register for everything still open"
affects: [future gap-closure rounds touching src/source/strip-hidden.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Self-normalizing range application over trust-the-caller's-argument: applyRemovalRanges now enforces its own ascending/non-overlapping precondition (total sort by start-ascending/end-descending, consumed-range skip, monotonic cursor) instead of relying on every caller's own prose argument staying correct forever — the same 'make the machine check the claim' fix this round applied to CR-01/CR-03 (62-29) and WR-07 (62-30)"
    - "Doc-comment identifier resolution as a shipped, mechanically-verified guard: every backtick-quoted, identifier-shaped token in strip-hidden.ts must resolve to a real definition, an import, a real code-usage site, a css-tree token-type name (verified against the live tokenTypes export), a valid Unicode property name (verified by constructing the regex), a verified cross-file identifier (verified by grepping the actual defining file), or an explicit deletion-registry entry naming the plan that removed it — closing the exact drift class (a comment describing deleted code) that 62-VERIFICATION.md named as CR-01's direct mechanism"

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts

key-decisions:
  - "WR-10's fix keeps the scan's start point at closeEnd (the D-62-21-01 truncated-offset argument already established), making ONLY the scan itself quote-aware (findUnquotedGt) rather than restarting the scan from closeStart — traced empirically (htmlparser2 trace below) that closeEnd never itself falls inside sender-controlled quoted content for the repro shape, so the minimal fix (quote-awareness only) is sufficient and does not change the scan's starting position"
  - "The deletion-registry line format places the removed identifier's name AND its '(deleted, 62-NN)' marker inside ONE backtick span (`` `NAME (deleted, 62-NN)` ``), not two separate backtick-delimited pieces — required so the plan's own coarse <verify> gate (a bare-substring proximity check that treats a backtick as a hard stop) and this plan's shipped, precise guard (which needs the marker resolvable from a bare backtick-quoted NAME occurring anywhere else in the file) can both pass against the identical registry text"
  - "The doc-identifier guard's resolution categories go beyond the plan's literal three (definition/import/deletion-registry) to also recognize: real code-usage sites (method/property access, calls, type positions — covers indexOf/ReadonlyMap/etc.), css-tree token-type names (verified against the live tokenTypes import), Unicode property names (verified by constructing the \\p{} regex), and a small set of cross-file production identifiers (verified by grepping the actual defining file) — without these, the guard would false-positive on every legitimate non-strip-hidden.ts-local reference this file's comments make, eroding trust in the guard rather than protecting it"

requirements-completed: [EMAIL-03]

# Metrics
duration: ~150min
completed: 2026-08-02
---

# Phase 62 Plan 31: Range-Application Normalization, Quote-Aware Close Scan, Doc-Block Collapse — Round-7 Close Summary

**Closed the round's three remaining warnings (WR-09 leak-on-violated-precondition, WR-10 in-tag-byte survival, WR-05 stale-doc-identifier drift — the recorded direct mechanism of CR-01) with shipped, machine-enforced guards rather than prose arguments, then produced the round-7 evidence sweep and residual register.**

## Performance

- **Duration:** ~150 min
- **Started:** 2026-08-02 (base commit `1d487fb`)
- **Completed:** 2026-08-02
- **Tasks:** 3
- **Files modified:** 2 (`src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`) — matches the plan's declared `files_modified` exactly

## Accomplishments

- **WR-09 closed.** `applyRemovalRanges` normalizes rather than assumes: sorts ranges by start-ascending/end-descending (a total order, so ties are no longer processing-order-dependent), skips any range fully consumed by a prior one, and advances the cursor monotonically. A violated containment argument now truncates instead of silently re-emitting text an earlier stage deleted.
- **WR-10 closed.** The close-tag boundary scan in `scanHtml`'s `onclosetag` handler is quote-aware (`findUnquotedGt`, the same quoting rule the shared `ATTRS` fragment encodes, implemented as a hand-written scan rather than a second regex literal). Sender-controlled bytes inside a close tag's bogus quoted attributes no longer survive into `record.content`.
- **WR-05 closed with a shipped guard, not a one-time cleanup.** The file-level doc block's ~440-line accumulated per-plan "gap closure" narrative is collapsed into a current-state description, a one-line-per-plan changelog, and an explicit deletion registry naming every removed identifier with the plan that removed it. A shipped test in `tests/strip-hidden.test.ts` resolves every backtick-quoted, identifier-shaped token in the file against a definition, an import, a real code-usage site, or a deletion-registry entry, and fails the suite if any resolve to nothing — proven non-vacuous against both a fabricated identifier and a genuinely-unregistered deleted one.
- **CR-01 stealth-regression addendum recorded** in the changelog (not by editing `62-24-SUMMARY.md`, which is a historical record): the self-closing `<style/>` shape leaked `.legal{display:none}okPAYLOAD` at base `c144c23` (announcing itself), then the identical `PAYLOAD` behind clean-looking `okPAYLOAD` output after 62-24 (the stealth regression 62-24-SUMMARY.md's own divergence table never named), closed to `ok` by 62-29. All three outputs re-verified directly against isolated builds of each commit (below), not quoted from memory.
- **Round-7 evidence sweep** re-runs every payload this round (waves 20-24, plans 62-27..62-31) touched, against a freshly built `dist/` at the final commit — table below.
- **Residual register** written honestly: exactly what this round closed (CR-01, CR-02, CR-03, WR-01, WR-05, WR-09, WR-10) and nothing wider, plus every open item this phase still carries.

## Task Commits

1. **Task 1: Normalize removal ranges instead of assuming them, and make the close-tag boundary quote-aware** — `49ef77a` (fix)
2. **Task 2: Collapse the doc block to current state and ship a guard that keeps it honest** — `eb402d3` (docs)
3. **Task 3: Round-7 evidence sweep and the phase's residual register** — evidence-only; no source changes (this SUMMARY is the deliverable). Committed as part of this plan's final metadata commit, per the pattern 62-29/62-30 already established for evidence-only work.

_Note: this SUMMARY's own commit follows as plan metadata (orchestrator-owned STATE.md/ROADMAP.md updates are out of scope for this executor per instructions)._

## Files Created/Modified

- `src/source/strip-hidden.ts` — `applyRemovalRanges` rewritten and exported (self-normalizing); `findUnquotedGt` added (quote-aware forward scan, shared quoting rule with `ATTRS`); `onclosetag`'s close-tag boundary scan now calls `findUnquotedGt` instead of a bare `indexOf`; the file-level doc block collapsed to current-state + changelog + deletion registry; the four specifically misleading sites (scanHtml's dangling `RAWTEXT_ELEMENTS` pointer, stage 2's stale `START_TAG_RE`+`findRawtextCloseBounds` header, `harvestHidingSelectors`'s stale outer-loop narrative, stage 3's `collectRemovalAndElementRanges` typo) rewritten to describe current code.
- `tests/strip-hidden.test.ts` — WR-09 property tests (5 fixed cases + a 500-trial randomized property check); WR-10 exact-output lock plus D-62-21-01 controls; the WR-05 doc-identifier guard (3 tests: the real guard, plus two non-vacuousness proofs) with its full resolution-category implementation.

## WR-09 Evidence: Before/After, Both Nested-Range Cases

RED recorded against the pre-fix algorithm (reproduced standalone, since `applyRemovalRanges` was not previously exported):

```js
function applyRemovalRangesOld(html, ranges) {
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
```

| Case | Input ranges | RED (pre-fix) | GREEN (this plan) | Expected |
|---|---|---|---|---|
| Ascending order | `[[1,8],[3,5]]` on `'0123456789'` | `"056789"` — re-emits chars 5-7, already deleted by `[1,8)` | `"089"` | `"089"` |
| Reversed order | `[[3,5],[1,8]]` on `'0123456789'` | `"01289"` — a DIFFERENT wrong output, proving order-dependence | `"089"` | `"089"` |
| Single range (unchanged) | `[[2,5]]` | `"0156789"` | `"0156789"` | `"0156789"` |
| Duplicate | `[[2,5],[2,5]]` | — | `"0156789"` | idempotent |
| Touching | `[[2,5],[5,8]]` | — | `"0189"` | idempotent |

500-trial randomized property check (base-36-indexed strings, random range sets up to 5 ranges per trial) confirms the output never contains a character covered by any input range — shipped as a test, not a one-off script.

## WR-10 Evidence: Before/After

```
Input:  <div style="display:none">SECRET</div foo="a>b">tail
RED  (bare html.indexOf('>', closeEnd)):  "b\">tail"
GREEN (findUnquotedGt, quote-aware):      "tail"
```

htmlparser2 trace confirming the mechanism (recorded during investigation, not asserted from memory): for this input, `parser.startIndex`/`endIndex` on the close-tag event are `32`/`37` — `html.slice(32,38) === "</div "` — htmlparser2's own close-tag tokenizer does not apply attribute-quoting rules to a close tag's bogus trailing content, so its own reported end sits BEFORE the sender-controlled `foo="a>b"` region. The pre-fix bare `indexOf('>', 37)` then finds the FIRST `>`, which is the one INSIDE the quoted value (`a>b`, at index 44), landing `elementEnd` at 45 — one past that in-quote `>`, leaking `b">tail`. `findUnquotedGt(html, 37)` correctly tracks quote state through `foo="a>b"` and returns the real terminator at index 47.

Controls unaffected: `<style foo>...</style foo>` and `<style >...</style >` (the D-62-21-01 recovery) both still return `"ok"`; a well-formed `<div>hi</div>tail` still returns `"hitail"`.

## WR-05 Evidence: Guard Non-Vacuousness and the Four Rewritten Sites

**Injected-failure proof (live, against the real source file):** appended `` See `findRawtextQuoteBoundaryScanner`'s own doc comment for the shared discipline this follows. `` to `findUnquotedGt`'s doc comment, ran the guard:

```
AssertionError: expected [ 'findRawtextQuoteBoundaryScanner' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "findRawtextQuoteBoundaryScanner",
+ ]
```

Reverted; `git diff --stat src/source/strip-hidden.ts` showed zero diff after reversion; guard re-ran green (3/3 passed). This is in addition to the two permanently-shipped non-vacuousness tests (a fabricated identifier and a genuinely-unregistered deleted identifier, both self-contained in the test file per this phase's established "shipped simulation + one-time injected proof recorded in the SUMMARY" pattern — see `62-29-SUMMARY.md`'s T-62-29-03/04 for the precedent).

**Four rewritten doc sites**, each before/after:

1. **`scanHtml`'s dangling pointer** (was: `` ...through 62-22 and is now RECOVERED -- see `RAWTEXT_ELEMENTS`'s own doc comment below, 62-24 gap closure): `` — pointed at an identifier deleted by 62-24. Now: `` ...through 62-22 and is now RECOVERED at the source by `neutralizeRawtextCloseDefect`, below): ``.

2. **Stage 2's header** (was: `` `STYLE_BLOCK_RE` ... DELETED in 62-18 ... Stage 2 now locates `<style>` elements with the same `START_TAG_RE` + `findRawtextCloseBounds` primitives stage 4 already used ``) — presented a mechanism 62-22/62-24 had already superseded as CURRENT. Now: `` `<style>` elements are located via `scanHtml().styleElements` (see `scanHtml`'s own doc block, above), computed once and shared with stage 3 -- not a second, independently maintained tag scan. ``

3. **`harvestHidingSelectors`'s doc comment** — an 83-line accumulation of three superseded "gap closure" narratives (62-17, 62-18, 62-22), each describing a mechanism the NEXT one had already replaced. Collapsed to ~28 lines describing the current mechanism (`scanHtml().styleElements`, the two boundary properties it inherits, the unterminated-`<style>`-harvests-to-EOF behavior, and the `{`/`}`-token brace-forgery argument) with no archaeology.

4. **Stage 3's `collectRemovalAndElementRanges` typo** — this identifier never existed; the real function is `mergeCommentAndElementRanges`. Fixed in place, with the surrounding comment trimmed of the "62-22 gap closure"/"62-24 gap closure" narrative headers (moved to the changelog).

## CR-01 Stealth-Regression Addendum (corrects `62-24-SUMMARY.md`'s divergence table)

Per `62-VERIFICATION.md` pass 5's `re_verification.regressions` note, `62-24-SUMMARY.md`'s divergence table never named that its own fix changed the self-closing `<style/>` shape's leak from an ANNOUNCING form to a STEALTHY one. Verified directly against isolated builds of each named commit (not quoted from a prior SUMMARY):

| Point | Commit | `stripHiddenContent('<style/>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>')` |
|---|---|---|
| Base | `c144c23` | `".legal{display:none}okPAYLOAD"` — the leak announces itself by dumping the raw stylesheet as prose |
| After 62-24 | `d6bf645` | `"okPAYLOAD"` — the IDENTICAL payload leaks, but behind clean-looking output with no CSS text to signal a problem (the stealth regression) |
| After 62-29 | current `dist/` (`eb402d3`) | `"ok"` — closed |

`62-24-SUMMARY.md` is a historical record and is not edited by this addendum; the corrected row lives in `strip-hidden.ts`'s own changelog and here.

## Round-7 Evidence Sweep

Run via a node probe against `dist/src/source/strip-hidden.js` and `dist/src/source/gmail-adapter.js`, freshly rebuilt (`npm run build` immediately before the probe) at the final commit of this plan (`eb402d3`, `git status --porcelain` clean at probe time).

### CR-01 (self-closing `<style/>` shapes, all five expect `"ok"`)

| Shape | Input | Output |
|---|---|---|
| a (bare `/`) | `<style/>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>` | `"ok"` |
| b (space before `/`) | `<style />...` | `"ok"` |
| c (case-insensitive) | `<STYLE/>...</STYLE>` | `"ok"` |
| d (unquoted attr ending `/`) | `<style type=a/>...` | `"ok"` |
| control | `<style>...` (no self-closing) | `"ok"` |

### CR-03 (raw-text fallback) + keep-controls

| Shape | Input | Output | Expected |
|---|---|---|---|
| a iframe | `<iframe>INJECT_U1</iframe>ok` | `"ok"` | `"ok"` |
| b noembed | `<noembed>INJECT_U2</noembed>ok` | `"ok"` | `"ok"` |
| c noframes | `<noframes>INJECT_U3</noframes>ok` | `"ok"` | `"ok"` |
| keep xmp | `<xmp>KEEP_X</xmp>ok` | `"KEEP_Xok"` | `"KEEP_Xok"` |
| keep textarea | `<textarea>KEEP_T</textarea>ok` | `"KEEP_Tok"` | `"KEEP_Tok"` |

### WR-01 (never-applied stylesheet context)

| Shape | Input | Output | Expected |
|---|---|---|---|
| a iframe | `<iframe><style>.legal{display:none}</style></iframe>ok<span class="legal">VIS</span>` | `"okVIS"` | `"okVIS"` |
| b noscript | `<noscript><style>.legal{display:none}</style></noscript>VIS<span class="legal">Q</span>` | `"VISQ"` | `"VISQ"` |
| head control | `<head><style>.legal{display:none}</style></head>ok<span class="legal">P</span>` | `"ok"` | `"ok"` |

### WR-10 and WR-09

| Check | Input / Ranges | Output | Expected |
|---|---|---|---|
| WR-10 | `<div style="display:none">SECRET</div foo="a>b">tail` | `"tail"` | `"tail"` |
| WR-09 nested | `applyRemovalRanges('0123456789', [[1,8],[3,5]])` | `"089"` | `"089"` |
| WR-09 nested (reversed) | `applyRemovalRanges('0123456789', [[3,5],[1,8]])` | `"089"` | `"089"` |

### CR-02 (stage-6 sweep, linear growth, T1/T2)

| n (code units) | T1 (element trigger) | T2 (comment trigger) |
|---|---|---|
| 1,000 | 0.25 ms | 0.22 ms |
| 4,000 | 0.44 ms | 0.40 ms |
| 16,000 | 0.46 ms | 0.34 ms |
| 64,000 | 1.00 ms | 0.71 ms |
| 256,000 | 2.70 ms | 2.35 ms |
| 1,048,576 (cap) | 9.27 ms | 10.43 ms |

Growth stays linear across the full range (no 16x-per-4x quadratic signature); both cap rows execute in ~10 ms, consistent with 62-30's own measured GREEN numbers.

### End-to-end `normalizeGmailMessage` (CR-01 a, CR-03 a)

```
CR-01 a e2e record.content = "From: a@b.com · Re: hi · Acct: acct1\nok"
CR-03 a e2e record.content = "From: a@b.com · Re: hi · Acct: acct1\nok"
```

Neither contains `PAYLOAD` nor `INJECT_U1`.

### CR-05..CR-10 (13 payloads, regression controls — all previously confirmed closed by round 6's verification pass 5)

| # | Payload | Output | Expected |
|---|---|---|---|
| 1 | CR-05a comment in declaration | `"ok"` | `"ok"` |
| 2 | CR-05b escaped ident (`\6eone`) | `"ok"` | `"ok"` |
| 3 | CR-05c inline style attribute comment | `"ok"` | `"ok"` |
| 4 | CR-06 unterminated block, class form | `"okThanks."` | `"okThanks."` |
| 5 | CR-06 unterminated block, id form | `"ok"` | `"ok"` |
| 6 | CR-07 B1 class numeric entity | `"ok"` | `"ok"` |
| 7 | CR-07 B2 id numeric entity | `"ok"` | `"ok"` |
| 8 | CR-07 B3 style numeric entity colon | `"ok"` | `"ok"` |
| 9 | CR-07 B4 style named entity colon | `"ok"` | `"ok"` |
| 10 | CR-08 CRLF hex-escape separator | `"ok"` | `"ok"` |
| 11 | CR-08 plain-space control | `"ok"` | `"ok"` |
| 12 | CR-09 250 junk rules ahead of the real one | `"ok"` | `"ok"` |
| 13 | CR-10 `<style>` after a bare `<style>` mention inside a comment | `"hiokThanks."` | `"hiokThanks."` |

All thirteen re-confirm exactly as expected — zero regressions across this round's changes.

## Residual Register (phase-wide, as of this plan's final commit)

**What this round (waves 20-24, plans 62-27..62-31) closed, with `dist/`-level evidence, and nothing wider:** CR-01, CR-02, CR-03, WR-01, WR-05, WR-09, WR-10. (CR-05..CR-11 and WR-07/WR-08 were closed by the PRIOR round, waves 15-19, and are re-confirmed as regression controls above, not re-claimed as this round's own closures.)

**The module's five named residuals** (see `strip-hidden.ts`'s own file-level doc block, "Five named residual limitations"), status unchanged by this round:
- (a) White-text-on-white-background hiding — NOT detected (accepted, classification-accuracy tradeoff).
- (b) Externally-linked stylesheet hiding — NOT detected (recense never fetches remote resources).
- (c) Unbalanced quotes inside a tag — the stage-6 fail-safe truncates to end of string. **Narrowed further by this plan's WR-10 fix in one specific case**: a close tag's own bogus quoted attribute no longer causes an over-inclusive `>` match, but residual (c) itself (a genuinely unterminated quote) is unchanged — `findUnquotedGt` falls back to the pre-existing `closeEnd + 1` behavior when no unquoted `>` exists before EOF, per T-62-31-05's `accept` disposition in this plan's own threat model.
- (d) `@media` non-evaluation — an at-rule's contents are harvested without evaluating the media query (errs toward removing content).
- (e) Unrestricted `Hash` tokens harvested as id names regardless of HTML `id` validity (errs toward removing content).

**Hand-rolled scanners that survive**, each with the reason it is acceptable where it sits:
- Stage 0's hoisted stray-`<` truncation and stage 6's now-duplicated stray-`<` truncation (immediately before AND after the sweep) — both bounded linear (62-14/62-30), neither participates in the hiding decision itself, both proven behavior-preserving against a mechanically-captured equivalence corpus (5,725 inputs, 62-30).
- `ANY_TAG_RE` itself (stage 6's leftover-tag sweep) — the ONE remaining `ATTRS`-built regex literal in the file (down from four before 62-24); its quoting rule is now also independently implemented as `findUnquotedGt` for the one caller (`scanHtml`'s `onclosetag`) that needs to walk forward from an arbitrary offset rather than match a whole tag — two implementations of the SAME quoting rule, not two independent opinions about what the rule is (the rule itself, `"..."`/`'...'` opaque, `[^'">]` plain, is stated once and referenced by both).

**Every NF-* mechanism named in the CSS differential, with its status:**
- NF-01 (unmatched CDO inside `<style>` truncating the whole document) — **CLOSED** as a predicted side effect of 62-22's `scanHtml`.
- NF-03 (comma-separated selector list rejected all-or-nothing) — **OPEN**, CSS-tokenizer layer (`preludeToBareSelectors`), locked as `it.fails` in `tests/css-liveness-differential.test.ts`. No owner assigned across this or any prior wave.
- NF-04 (blockless `@media;` at-rule misattributes the next rule's block) — **OPEN**, same layer (`harvestFromStylesheet`'s `startsWithAtKeyword`), same status.
- NF-05 (CDO/CDC not treated as ignorable at the stylesheet top level) — **OPEN**, same layer, same status.
- NF-06 (compound co-occurrence: NF-04/NF-05 or NF-03/NF-05 combined defeat the harvest even when neither alone would) — **OPEN**, discovered by 62-27, same layer, locked as two `it.fails` minimal reproductions (`NF-06a`, `NF-06b`).
- REG-01 (unclosed Function/Url token before an intermediate complete `{}`-pair causes a later rule to be treated as top-level) — **OPEN**, over-strip only (SAFE direction, never a leak), locked as `it.fails`, unfixed since 62-19 by deliberate scope choice (a real fix needs paren/function-depth tracking, the exact mechanism 62-17 removed to close FB-01/CR-04).
- All six of the above are unaffected by this plan's changes (none touch `harvestFromStylesheet`'s frame-walker or `preludeToBareSelectors`).

**The HTML-wrapper differential's coverage (`tests/html-wrapper-differential.test.ts`, 62-28):** a 22-shape alphabet crossed against `{class,id}` probes and `{inside,after}` payload placement (88 cases), hard-gated. The alphabet covers: self-closing-syntax variants (shapes 2-5), the D-62-21-01/RAWTEXT-close-slash residuals (6-7), unterminated-to-EOF (8), style-in-comment (9), raw-text fallback containers (10-12), rendered-content over-strip controls (13-15), never-applied-stylesheet containers (16-18), entity-encoded selector values (19), implied-close siblings (20), the WR-10 quote-unaware close scan (21), and an unquoted-attribute-ending-in-slash variant (22). **This is a sample, not a proof**: the alphabet does not include, among others, malformed/nested comment interactions with `<style>` beyond CR-10's own shape, `<template>` content interacting with a script-modified shadow tree, attribute-value entity encodings other than the single numeric-reference case tested, or any multi-level nesting combination beyond two containers deep. A shape outside this alphabet that diverges between `htmlparser2` and a real browser would not be caught by this differential.

**The parse5 oracle's blind spots** (`tests/support/html-render-oracle.ts`, stated in its own doc comment): no CSS cascade, no specificity resolution (the oracle applies exactly ONE fixed, literal, whitespace-insensitive rule — `.legal{display:none}` / `#legal{display:none}` — never a real stylesheet), no `@media` evaluation, no external stylesheet fetching, and no inline-`style`-attribute modeling (shape 21 was adapted to carry `class`/`id="legal"` specifically because of this blind spot). Non-totality (parse5's own "C3" finding, 62-21 Task 2): a throw sets `oracleUnavailable: true` rather than a false verdict — measured at exactly 0 across the 88-case alphabet, never silently swallowed into a normal verdict.

**Out-of-scope residuals this phase has carried across multiple rounds, re-confirmed still open and unaffected by this plan** (none silently dropped from tracking):
- WR-11 (`. legal` — whitespace between `.` and the ident — now harvested, an over-strip regression), WR-13 (`class` split on JS `\s`, not HTML's five ASCII whitespace chars), WR-14 (two of the "worst 3" cap-boundary shapes are byte-identical in `tests/gmail-hidden-content.test.ts`), WR-15 (`AD04` counter in the CSS differential never incremented — a tautological `toBe(0)`), WR-16 (stale doc comments elsewhere — `tests/css-liveness-adjudication.test.ts`'s header, `tests/gmail-hidden-content.test.ts`'s stale cap-bounding claim — both untouched by this plan, out of its declared file scope).
- IN-06 (vacuous `expect(true).toBe(true)` placeholder, `tests/css-liveness-adjudication.test.ts`), IN-07 (stale comment re: `decodeIdentEscapes`'s 7th-position handling, `tests/strip-hidden.test.ts`), IN-08 (out-of-range-escape test asserts only non-throwing, not the `U+FFFD` mapping).
- IN-09 (`findRawtextCloseEnd` single-caller pass-through) — **now MOOT**, not merely "still open": `findRawtextCloseEnd` was deleted outright by 62-24 (confirmed: `grep -rn findRawtextCloseEnd tests/` returns zero matches outside `strip-hidden.ts`'s own deletion registry and changelog). The finding described code that no longer exists; recorded here rather than silently dropped, per this plan's own WR-05 discipline.
- The pre-existing, out-of-scope flaky test `deferred-items.md` logged during 62-30 (`tests/strip-hidden.test.ts`'s WR-02 report-shape growth-ratio assertion under parallel load) — left deferred, per this plan's phase-context instruction not to chase it. Not observed to fire during this plan's own full-suite runs.

**No total-coverage claim is made anywhere in this SUMMARY.** The HTML-wrapper differential's alphabet is explicitly a sample; the CSS liveness differential's leak bucket is gated but its NF-03/04/05/06/REG-01 mechanisms remain open; the parse5 oracle's blind spots are named, not silently assumed away.

## Decisions Made

See `key-decisions` in frontmatter. Summarized: (1) WR-10's fix keeps the scan's start point at `closeEnd`, adding only quote-awareness — traced via an htmlparser2 instrumentation run, not assumed; (2) the deletion-registry line format places name and marker in one backtick span so both this plan's precise guard and the plan's own coarser `<verify>` gate script can independently pass against identical text; (3) the guard's resolution categories extend beyond the plan's literal three to cover real code-usage sites, css-tree token types, Unicode property names, and verified cross-file identifiers — each mechanically checked, none a blind trust list — because a guard that only recognized definitions/imports/registry entries would false-positive on this file's own legitimate cross-references and get suppressed rather than trusted.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan's own coarse `<verify>` gate for Task 2 initially failed against the natural deletion-registry format**
- **Found during:** Task 2, running the plan's own `<verify>` automated check
- **Issue:** The plan's verify gate (`n+'[^\`]{0,80}deleted, 62-'`) requires the raw identifier text to be followed, with NO intervening backtick, by "deleted, 62-" within 80 characters. The natural registry format this plan's own guard design implies (`` `NAME` (deleted, 62-NN) `` — name and marker in separate backtick-delimited pieces) places a closing backtick immediately after the name, which the gate's `[^\`]` character class cannot cross, so the gate failed for `RAWTEXT_ELEMENTS`/`START_TAG_RE`/`STYLE_BLOCK_RE`/`findRawtextCloseBounds` despite the shipped guard resolving them correctly.
- **Fix:** Reformatted every deletion-registry line to place the name and its marker inside ONE backtick span (`` `NAME (deleted, 62-NN)` ``), and updated the shipped guard's own registry-lookup regex to match this format. Both the plan's coarse gate and the shipped precise guard now pass against the identical text.
- **Verified:** `node -e "..."` (the plan's exact verify-gate script) prints `no orphaned identifier references`; the shipped guard's 3 tests (including both non-vacuousness proofs) pass.
- **Files modified:** `src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`
- **Commit:** `eb402d3`

## Frozen Surface

`git log --oneline 4354c81..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts` returns 0 lines. `git diff 4354c81..HEAD -- src/source/gmail-adapter.ts` shows only 62-30's own doc-block re-derivation (36 changed lines, all inside the `MAX_STRIP_INPUT_CODE_UNITS` comment) — filtered for `resolveAccountQuery`/`parseEmailDate`/`event_ts`, zero added or removed lines across the entire range.

## Full Suite / Build / Typecheck

- `npm run build` exits 0.
- `npm run typecheck` (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json`) exits 0.
- `npx vitest run` (full suite, at commit `eb402d3`): **199 files passed / 1 skipped; 3341 passed / 6 expected-fail / 4 skipped** — up from 62-30's baseline of 3330 passed (net +11 passed: 5 WR-09 tests + 3 WR-10 tests + 3 WR-05 guard tests).
- `git status --porcelain --untracked-files=all | grep -v '^ M '` — empty (no stray artifacts; the probe scripts used for the evidence sweep and the temporary c144c23/d6bf645 comparison builds all lived in the scratchpad directory or were deleted before commit, never touching the repo).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Round 7 (waves 20-24, plans 62-27..62-31) closes with `dist/`-level, freshly-rebuilt evidence for CR-01, CR-02, CR-03, WR-01, WR-05, WR-09, and WR-10 — every warning `62-VERIFICATION.md` pass 5 and `62-REVIEW.md`'s round-7 charter named.
- `applyRemovalRanges` and the close-tag boundary scan are now self-normalizing/quote-aware rather than trusting a caller's prose argument — the same class of fix this round applied twice before (CR-01/CR-03's dispositioned single-source map, WR-07's calibration-relative gates).
- The file-level doc block is honest about current state, with a shipped, non-vacuous guard preventing the exact drift class (`stale identifier describing deleted code`) that produced this round's own first blocker (CR-01) — a future deletion in this file cannot silently leave the doc block lying again without failing the suite.
- A fresh verification pass should find EMAIL-03 with the seven round-7 warnings closed; the residual register above is the honest starting point for what remains open (NF-03/04/05/06, REG-01, WR-11/13/14/15/16, IN-06/07/08, residuals (a)-(e), and the HTML-wrapper/parse5-oracle coverage boundaries) — none of it silently narrowed or widened by this plan.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-02*

## Self-Check: PASSED

- `.planning/phases/62-multi-inbox-email-ingest-hardening/62-31-SUMMARY.md` exists: FOUND
- Commit `49ef77a` (Task 1) present in `git log --oneline --all`: FOUND
- Commit `eb402d3` (Task 2) present in `git log --oneline --all`: FOUND
- `git status --short` shows only this SUMMARY.md pending (force-added; `.planning/` is gitignored, matching how prior plan SUMMARY.md files in this phase are tracked): confirmed
- Targeted suite (`tests/strip-hidden.test.ts`, `tests/gmail-hidden-content.test.ts`, `tests/css-liveness-differential.test.ts`, `tests/html-wrapper-differential.test.ts`, `tests/html-parser-conformance.test.ts`) green: confirmed
- Full suite (`npx vitest run`) green: 199 files passed / 1 skipped, 3341 passed / 6 expected-fail / 4 skipped: confirmed
- `npm run typecheck` and `npm run build` both exit 0: confirmed
- Frozen surface gate (`git log --oneline 4354c81..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts` returns 0 lines; `gmail-adapter.ts` frozen regions show no added/removed lines): confirmed
