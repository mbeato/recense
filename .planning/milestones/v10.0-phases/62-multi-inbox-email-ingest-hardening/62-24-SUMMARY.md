---
phase: 62-multi-inbox-email-ingest-hardening
plan: 24
subsystem: security
tags: [htmlparser2, html-parsing, attribute-decoding, cross-stage-boundary, email-ingest, EMAIL-03]

# Dependency graph
requires:
  - phase: 62 (plan 20)
    provides: "Token-derived CSS declaration-signature reconstruction (hasHidingSignatureFromTokens) — the CSS-layer half of the two-layer decode this plan composes with"
  - phase: 62 (plan 21)
    provides: "htmlparser2@10.0.0 exact-pinned; the D-62-21-01 RAWTEXT-close-tag residual this plan widens the disposition of"
  - phase: 62 (plan 22)
    provides: "scanHtml(html) — one htmlparser2 pass yielding comment ranges, <style>-element ranges and start-tag records (HtmlScan/HtmlStartTag), with startTags produced and unit-tested but deliberately NOT wired into any stage — this plan's job"
provides:
  - "Stages 4 (non-content elements) and 5 (hidden elements) driven by scanHtml().startTags instead of a second, independently-maintained START_TAG_RE + findMatchingCloseEnd regex walk — closing CR-07 by deleting the second opinion, the same way CR-10 was closed"
  - "isHiddenStartTag reads a DECODED ReadonlyMap (scanHtml's own HTML-character-reference decode) instead of a raw source-text slice — an entity-encoded class/id/style attribute value can no longer disagree with a harvested selector/declaration built from the same decoded text"
  - "neutralizeRawtextCloseDefect — a same-length pre-parse substitution correcting a real htmlparser2 defect (a RAWTEXT close tag immediately followed by '/', e.g. </style/>, was never recognized as a close at all) at the source, so the ONE parser pass this file makes stays the sole source of truth for every stage"
  - "Stage 3 (comments) + stage 4/5 (elements) ranges, all derived from the SAME scanHtml pass, merged into one applyRemovalRanges call (collectStartTagRemovalRanges + mergeCommentAndElementRanges) instead of three sequential deletions"
affects: [62-25]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-parse, same-length text neutralization of a known third-party-parser defect, so the correction lives in the ONE shared scan rather than a post-hoc numeric patch that cannot resurrect tags the parser already decided were raw text"
    - "Comment + element removal ranges computed once against a pristine pre-mutation string, then merged (not applied sequentially) — required once every stage stopped re-deriving tag positions from whatever a prior stage's deletion left behind"

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts

key-decisions:
  - "The </style/> RAWTEXT-close defect (D-62-21-01, accepted-not-recovered through 62-22) is now RECOVERED, not left as a residual: 62-22 accepted it because stage 2 (harvest-only) treats over-inclusion as harmless, but 62-24 makes the SAME boundary load-bearing for REMOVAL, where the identical residual destroys real visible prose (a BL-02 regression) AND makes a hidden element behind the missed close invisible to scan.startTags entirely (htmlparser2 never tokenizes tags inside content it already decided was RAWTEXT). A post-hoc numeric elementEnd correction was tried FIRST and rejected (see Deviations) — it fixed the deletion-range boundary but could not resurrect a real <span> htmlparser2 had already swallowed as text; the pre-parse same-length substitution fixes it at the source instead, letting htmlparser2 re-enter normal tokenization after the corrected close."
  - "Stage 3 (comments) and stage 4/5 (elements) are now ONE combined applyRemovalRanges call, not three sequential ones — collectStartTagRemovalRanges (stage 4+5, single walk, cursor-skip over already-decided-removed ranges) and mergeCommentAndElementRanges (stage 3, filters comments fully CONTAINED in an element range, keeps standalone ones) both read the SAME pristine scan. Comments can only ever be fully contained in an element range or fully disjoint from all of them — never partially overlapping — because scanHtml's parser never recognizes a tag inside comment data, so no element can start inside a comment, and a comment is one atomic lexical span that cannot itself straddle an element boundary."
  - "class is still split on JavaScript \\s (not HTML's five ASCII whitespace characters, WR-13) — kept UNCHANGED deliberately, per the plan's own instruction that WR-13 is out of scope and must not become an acceptance criterion. NOT incidentally closed by this plan (see below)."

requirements-completed: [EMAIL-03]

# Metrics
duration: ~55min
completed: 2026-08-01
---

# Phase 62 Plan 24: Attribute-Decoding Closure — Stage 4/5 Read scanHtml().startTags (CR-07) Summary

**Stage 4 (non-content elements) and stage 5 (hidden elements) now read `scanHtml().startTags` — the same single parser pass stages 2/3 already used — instead of a second, independently-maintained regex-driven tag scan, so an entity-encoded `class`/`id`/`style` attribute value can no longer disagree with a harvested selector/declaration; the differential harness built to measure the blast radius of that change found ONE divergence class, a genuine pre-existing availability bug the rewrite fixes (not a regression).**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-08-01
- **Tasks:** 3 (all separate commits, no combining needed)
- **Files modified:** 2 (`src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`)

## Accomplishments

- **CR-07 closed by composition, not by special case.** `isHiddenStartTag` now takes `scanHtml().startTags[].attrs` — a `ReadonlyMap<string,string>` whose values are already HTML-character-reference-decoded by htmlparser2 (`decodeEntities: true`) — instead of a raw source-text region matched by `STYLE_ATTR_RE`/`CLASS_ATTR_RE`/`ID_ATTR_RE`/`ARIA_HIDDEN_TRUE_RE`/`BARE_HIDDEN_ATTR_RE` (all five deleted, along with `extractAttr`). The two layers a browser actually applies — HTML character-reference decode, THEN CSS tokenize/escape-decode (`hasHidingSignatureFromTokens`, 62-20) — are now both implemented, in that order, so `class="leg&#97;l"`, `id="leg&#97;l"`, `style="display&#58;none"` and `style="display&colon;none"` all resolve to the same decoded text a harvested `.legal`/`#legal`/`display:none` rule was built from.
- **The false premise in `decodeIdentEscapes`'s doc comment is corrected**, not just the code: it used to assert the attribute side is "compared literally against an unescaped HTML attribute value" — that was false even before this plan (it was simply unfixed), and the corrected comment states which layer each function owns.
- **`START_TAG_RE`, `ANY_TAG_TOKEN_RE`, `RAWTEXT_CLOSE_TAIL_RE` (the original), `findMatchingCloseEnd`, `findRawtextCloseEnd`/`findRawtextCloseBounds`, `RAWTEXT_CLOSE_OPENER_RE`, `RAWTEXT_ELEMENTS` (the original), `VOID_ELEMENTS` and `collectRemovalRanges` are all deleted** — the regex-driven tag/close-tag discovery stage 4/5 used to run on the CURRENT (possibly already-reduced) string is gone; only stage 6's leftover-tag sweep (`ANY_TAG_RE`) still needs the shared `ATTRS` fragment (the source guard's own regex-literal count fell from 4 to 1, updated and re-asserted, not silently left stale).
- **A genuine htmlparser2 defect widened in disposition, not silently inherited by a new consumer.** D-62-21-01 (62-21-SUMMARY.md) named `</style/>` as a RAWTEXT close tag htmlparser2 fails to recognize (swallowing the rest of the document as RAWTEXT content) and 62-22 accepted it as a residual because stage 2's harvest-only consumer treats over-inclusion as harmless. 62-24 makes the SAME boundary load-bearing for element REMOVAL and start-tag DISCOVERY, where the identical residual (a) destroys real visible prose after the missed close (a regression of the shipped BL-02 lock, caught immediately by Task 1's own verify run) and (b) makes any element hidden BEHIND the missed close (e.g. `<span class="legal">`) invisible to `scan.startTags` entirely, since htmlparser2 never tokenizes tags inside content it has already decided is RAWTEXT. Closed at the source via `neutralizeRawtextCloseDefect` — a same-length, pre-parse substitution (`/` → space, immediately after a RAWTEXT tag's close-tag name) that lets htmlparser2 itself re-enter normal tokenization, rather than a post-hoc numeric `elementEnd` correction (tried first, rejected — see Deviations).
- **Stage 3 (comments) and stage 4/5 (elements) are now one combined deletion**, not three sequential ones: `collectStartTagRemovalRanges` (a single walk over `scan.startTags` with the SAME `NON_CONTENT_TAGS.has(name) || isHiddenStartTag(...)` predicate, cursor-skipping tags nested inside an already-decided-removed range) and `mergeCommentAndElementRanges` (filters `scan.comments` down to ones NOT fully contained in an element range, since a browser proves — and this file's own reasoning confirms — a comment can only ever be fully contained in an element range or fully disjoint from all of them, never partially overlapping) feed one `applyRemovalRanges` call. Required because stage 4/5 no longer re-derive tag positions from whatever string a prior stage's deletion left behind — every range now traces to the ONE pristine scan.
- **A differential harness (Task 2) measured the blast radius directly rather than assuming it.** 32,291 inputs: every literal in `tests/strip-hidden.test.ts`/`tests/gmail-hidden-content.test.ts` (275, including all fixture arrays), the full generated output of the three `css-liveness-differential.test.ts` generators (26,904), and 5,200 seeded documents built specifically to exercise implied/omitted end tags across 13 shapes × 6 hiding-attribute variants. Zero divergence on the CSS-corpus inputs (26,904 + 187 net-new after dedup with the 88 direct strip-hidden.test.ts literals — see disposition table below for the exact count); all 2,644 divergences trace to exactly ONE mechanism, confirmed IMPROVEMENT.

## Task Commits

1. **Task 1: Drive stages 4/5 from `scanHtml().startTags`, decoded attrs (CR-07)** — `cf9af45` (feat)
2. **Task 2: Disposition every divergence the range-discovery change introduces** — `e25455e` (test)
3. **Task 3: Lock CR-07's payloads B1-B6, extend the source guard** — `de5654a` (test)

## Files Created/Modified

- `src/source/strip-hidden.ts` — deleted the stage-4/5 regex-driven tag/close-tag discovery machinery (10 symbols); rewrote `isHiddenStartTag` to take a decoded `ReadonlyMap`; added `collectStartTagRemovalRanges` + `mergeCommentAndElementRanges` (combined stage 3/4/5 removal computation); added `RAWTEXT_CLOSE_SLASH_RE` + `neutralizeRawtextCloseDefect` inside `scanHtml`'s own section (widens D-62-21-01's disposition); corrected the false premise in `decodeIdentEscapes`'s doc comment; updated the file-level doc block (62-24 gap closure section, revised stage-order narrative, revised residual list).
- `tests/strip-hidden.test.ts` — updated the source guard's stale regex-literal counts (4→1); added a new describe block locking the implied-close availability fix (7 tests, one a deliberate control); added a new describe block locking CR-07 payloads B1-B6 (6 tests); extended the 62-20 source guard with a CR-07-specific offender predicate (2 tests: the real check + its own non-vacuousness check, matching the `tests/src-import-boundary.test.ts`/62-23 shared-predicate precedent).

## Decisions Made

See `key-decisions` in the frontmatter above for the two architectural calls (RAWTEXT-defect recovery at the source vs. post-hoc, and combining stage 3/4/5 into one deletion pass) and the WR-13 non-closure. One further note: the differential harness's corpus deliberately excluded `normalizeGmailMessage`-level inputs beyond their `bodyText` literal (the gmail-adapter wrapping layer is untouched by this plan's `files_modified`, so comparing at the `stripHiddenContent` boundary directly is the correct, narrowest scope).

## Divergence Disposition Table (Task 2)

Ran `pre-plan module` (commit `d251b4d`, the base this plan started from, built in a scratch `git worktree`) against the `current module` over 32,291 inputs.

| Corpus | Inputs | Diffs |
|---|---|---|
| Every literal in `tests/strip-hidden.test.ts` + `tests/gmail-hidden-content.test.ts` (direct-call literals + all fixture arrays + the CR-09 computed junk-rules case) | 187 | 0 |
| Full generated output of the three `css-liveness-differential.test.ts` generators (Generator 1 exhaustive k=2 cross product, Generator 2 20,000 seeded k=3..6, Generator 3 5,000 structured stylesheets) | 26,904 | 0 |
| New seeded implied/omitted-end-tag corpus (13 shapes × 6 hiding-attribute variants, LCG-seeded) | 5,200 | 2,644 |
| **Total** | **32,291** | **2,644** |

**Shapes exercised** (13, each combined with 6 hiding-attribute variants: none/visible-control, `style="display:none"`, `class="legal"` harvested-class, `id="legalid"` harvested-id, `hidden`, `aria-hidden="true"`): `<p>a<p>b`; `<ul><li>a<li>b</ul>`; `<div><li>a</div>b` (no `ul`/`ol` wrapper); `<div><span>a</div>b` (span closed by ancestor); `<article><section><span>a</section></article>b` (two-level ancestor close); `<table><span>a</span><tr><td>b</td></tr></table>` (foster-parented, explicit close); `<table><span>a<tr><td>b</td></tr></table>` (foster-parented, no close); `<p>a<div>b</div>` (p implicitly closed by disallowed child); `<dl><dt>a<dd>b</dd></dl>`; `<select><option>a<option>b</option></select>`; `<table><tr><td>a</td><tr><td>b</td></tr></table>`; `<p>ab` (unclosed at true EOF); `<b>a<i>b</b></i>` (misnesting/adoption-agency).

Of these 13, **8 shapes produced divergence** (`<p>a<p>b`, `<ul><li>a<li>b</ul>`, `<div><li>a</div>b`, `<div><span>a</div>b`, two-level ancestor close, `<p>a<div>b</div>`, `<dl><dt>a<dd>b</dd></dl>`, `<select><option>a<option>b</option></select>`) × 5 non-control hiding variants each = 40 distinct (shape, variant) classes, 2,644 total instances. **5 shapes produced zero divergence**: the foster-parented shapes (both — the hiding attribute in this generator design landed on `<span>`, which has an explicit close in one variant and no close-tag disambiguation issue in the other, so neither exercised the old bug's specific trigger); the `<tr>`/`<tr>` shape (the hiding attribute landed on `<td>`, which always has an explicit close — a generator design gap, not a finding: the `<tr>` implied-close case itself was never actually probed with a hidden element); the unclosed-at-EOF `<p>` (both old and new correctly extend to EOF — no sibling exists to trigger the bug); the misnesting `<b>/<i>` shape (the old depth-counter never got confused here, since `<i>` tokens are a different tag name and do not affect `<b>`'s own same-name depth count).

### Disposition

| Divergence Class | Reproduction | Old Output | New Output | Verdict |
|---|---|---|---|---|
| **A hidden/removed element with NO explicit close tag, immediately followed by a sibling HTML implicitly closes it for** (same-tag-name sibling for `<p>`/`<li>`/`<dt>`/`<option>`; a disallowed child for `<p>`+`<div>`; an ancestor's own close tag for nested `<span>`) | `<p style="display:none">HIDDEN1<p>VISIBLE1</p>` | `""` | `"VISIBLE1"` | **IMPROVEMENT** |

**Mechanism:** the pre-plan `findMatchingCloseEnd` depth-counted SAME-NAME open/close tokens to find a hidden element's matching close. When the hidden element had no explicit close and was followed by a sibling HTML auto-closes it for, the old scanner mistook the sibling's OPEN tag for a nested child of the same name, incremented its depth counter for a nesting level that (per HTML's own tag-omission rules) never really existed, never found a matching close for that fictional level, and fell through to the "no match found" fail-safe — `return html.length`. That deleted from the hidden element's start to END OF THE DOCUMENT, destroying legitimate trailing visible prose that was never inside the hidden element at all.

**Why IMPROVEMENT, not REGRESSION:** manually traced against HTML's own tag-omission rules (which `scan.startTags`' elementEnd computation inherits directly from htmlparser2's real tree-construction event stream, not from a hand-derived approximation) for every one of the 8 divergent shapes — a conformant browser closes the first `<p>` when the second opens (§13.2.6.4.7's implicit-end-tag list includes `p`), closes `<li>`/`<dt>`/`<option>` the same way for their own auto-closer rules, closes a `<p>` when a `<div>` (not permitted in `<p>`'s content model) opens inside it, and closes any element when its own ancestor's real close tag is reached. In every case the SECOND payload (`VISIBLE1`/`PAYLOAD2_*`) sits OUTSIDE the hidden element in a real browser's DOM and is rendered normally — the new output matches that; the old output destroyed it. Verified this is not a NEW leak in the other direction: the FIRST payload (the genuinely hidden one) is absent from the new output in every one of the 2,644 instances (checked programmatically, not sampled) — confirmed via a script asserting the exact pattern `oldOut === '' && newOut === 'PAYLOAD2_N' && !newOut.includes('PAYLOAD1')` held for all 2,644, zero exceptions.

**Control that isolates the mechanism:** `<p style="display:none">HIDDEN1</p><p>VISIBLE1</p>` (the FIRST `<p>` has an explicit `</p>`) produces `"VISIBLE1"` on BOTH old and new — confirming the bug needed an implied close specifically, not merely "a hidden `<p>` followed by any sibling `<p>`." Locked as its own test.

**Zero REGRESSION rows.** Nothing required fixing; the finding is a pre-existing availability defect the parser-based rewrite closes as a structural side effect, not a new one introduced by it.

## WR-13 (incidental closure check)

**NOT incidentally closed.** `class` is still split with `.split(/\s+/)` (JavaScript `\s`, a superset of HTML's five ASCII whitespace characters `\t\n\f\r `) — this plan deliberately kept the SAME split regex `isHiddenStartTag` already used, per the plan's own instruction that WR-13 is out of scope and must not become an acceptance criterion. The parser did NOT incidentally supply a spec-conformant split (htmlparser2's `attribs` object hands back the raw decoded attribute VALUE string, not a pre-split token list), so there was nothing to incidentally inherit here.

## it.fails Reconciliation (Task 3)

Re-ran the full suite after all three tasks. **4 pre-existing `it.fails` remain failing, unchanged — none flipped to passing, nothing to convert:**

| Finding ID | Location | Mechanism | Why unaffected by this plan |
|---|---|---|---|
| NF-03 | `tests/css-liveness-differential.test.ts` | Comma-separated selector list rejected all-or-nothing rather than per-selector | Pure CSS-tokenizer-layer defect in `harvestFromStylesheet`/`preludeToBareSelectors` (stage 2) — this plan touches stage 4/5 element discovery and stage 5's attribute decode only |
| NF-04 | `tests/css-liveness-differential.test.ts` | A blockless `@media;` at-rule misattributes the next rule's block as its own | Same layer (`harvestFromStylesheet`), same reason |
| NF-05 | `tests/css-liveness-differential.test.ts` | CDO/CDC not treated as ignorable at the stylesheet top level | Same layer, same reason |
| REG-01 | `tests/strip-hidden.test.ts` | An unclosed Function/Url token before an intermediate complete `{}`-pair causes a later rule to be treated as top-level (over-strip, safe direction, not a leak) | Same layer (`harvestFromStylesheet`'s brace-nesting walk), untouched by this plan |

Full suite at close: 198 test files passed / 1 skipped, 3,280 tests passed / 4 expected fail / 4 skipped — 0 unexpected failures.

## `dist/` Reproduction (Task 3, verbatim)

```
$ node -e "const {stripHiddenContent:s}=require('./dist/src/source/strip-hidden.js');const c=[['<style>.legal{display:none}</style>ok<span class=\"leg&#97;l\">PAYLOAD_B1</span>','ok'],['<div style=\"display&#58;none\">PAYLOAD_B3</div>ok','ok'],['<div style=\"display&colon;none\">PAYLOAD_B4</div>ok','ok']];let bad=0;for(const [i,e] of c){const o=s(i);if(o!==e){console.error('FAIL',JSON.stringify(i),JSON.stringify(o));bad++}}if(bad)process.exit(1);console.log('dist repro: CR-07 closed')"
dist repro: CR-07 closed
```

All six B1-B6 payloads (including B2, B5, B6, not in the plan's own inline verify command but locked as shipped tests in Task 3) were additionally verified against `dist/` with a superset script during Task 1/3 execution; all passed.

## Revised Residual List (what remains hand-rolled in this module)

After this plan, exactly two hand-rolled regex scanners remain, both operating on already-reduced text and neither participating in the hiding decision:

1. **Stage 0's hoisted stray-`<` fail-safe truncation** (62-14, Bound A) — a duplicate of stage 6's own truncation, run early for cost reasons.
2. **Stage 6's `ANY_TAG_RE` leftover-tag sweep** — deletes any remaining `<...>` sequence after every prior stage has run.

One NEW narrow, self-correcting primitive was added, living entirely INSIDE `scanHtml` (not a competing scanner elsewhere): `neutralizeRawtextCloseDefect` (+ its `RAWTEXT_CLOSE_SLASH_RE`) — a same-length, pre-parse text substitution correcting htmlparser2's own D-62-21-01 RAWTEXT-close-tag-recognition gap before the ONE `Parser` construction this file makes ever sees the input. This is a correction of the adopted parser dependency's own known defect, not a second, independently-maintained opinion about where an element begins or ends — every stage still reads exactly one `scanHtml` result, and the "exactly one `Parser.prototype.write` call per `stripHiddenContent` call" conservation test (62-22) still holds unmodified.

No total-coverage claim is made here — this residual list names what is hand-rolled today, not a promise nothing else will be found next round.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Post-hoc `elementEnd`/`contentEnd` numeric correction for the D-62-21-01 `</style/>` defect could not recover a REAL start tag htmlparser2 had already swallowed as RAWTEXT text**
- **Found during:** Task 1, immediately after the initial stage 4/5 rewire — the shipped `BL-02: </style/> end tag` lock (`tests/strip-hidden.test.ts`) failed: `<style>.legal{display:none}</style/>ok<span class="legal">PAYLOAD_B2</span>` returned `""` instead of `"ok"`.
- **Issue:** First attempt added a fallback inside `scanHtml`'s `onclosetag`/defensive-drain that forward-scanned for a missed `</style ...>`-shaped close and recomputed a corrected `elementEnd`/`contentEnd` numerically. This fixed the STYLE element's own removal-range boundary (stopping the deletion at the right offset), but did NOT fix the underlying problem: htmlparser2 had already decided the entire region from the open `<style>` tag to the (missed) close was RAWTEXT content, so it never fired `onopentag`/`onclosetag` for the `<span class="legal">` sitting after the missed close — that tag was simply ABSENT from `scan.startTags`, so stage 5 could never find and remove it, leaking `PAYLOAD_B2`.
- **Fix:** Replaced the post-hoc numeric correction with `neutralizeRawtextCloseDefect` — a same-length pre-parse substitution (the `/` immediately after a RAWTEXT close-tag name, e.g. in `</style/`, is replaced with a space) applied to the string handed to `Parser.write()` (not to `html` itself — every downstream offset stays valid against the original string because the substitution never changes length). This lets htmlparser2 recognize the close correctly and re-enter normal tokenization afterward, so the `<span>` is discovered like any other tag. Verified empirically against `htmlparser2@10.0.0` directly (a throwaway spike script, not committed) before writing the fix, confirming `</style/>` → `</style >` and `</style/ >` → `</style  >` both parse identically to an already-correct `</style foo>`/`</style >` close.
- **Files modified:** `src/source/strip-hidden.ts`
- **Verification:** `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts` — all green, including both `BL-02: </style foo>`/`</style/>` locks; full suite (198 files, 3,280 tests) green at close.
- **Committed in:** `cf9af45` (part of Task 1's own commit — found and fixed before that commit, not a separate follow-up commit)

**2. [Rule 3 - Blocking] The 62-20 source guard's own hardcoded regex-literal counts (`attrsInterpolationLines`/`newRegExpLines` both asserted `=== 4`) became stale the moment `START_TAG_RE`/`ANY_TAG_TOKEN_RE`/`RAWTEXT_CLOSE_TAIL_RE` were deleted, blocking Task 1's own verify command (which runs the full `tests/strip-hidden.test.ts` file)**
- **Found during:** Task 1, first `npx vitest run tests/strip-hidden.test.ts` after the rewrite.
- **Issue:** The test asserted exactly 4 `${ATTRS}`-interpolation lines and 4 `new RegExp(` constructions; after deleting the three stage-4/5 discovery literals only 1 remains (stage 6's `ANY_TAG_RE`).
- **Fix:** Updated both assertions to `1`, with a new paragraph in the same comment block explaining the 4→1 fall (mirroring the same guard's own 62-13 rise-from-4-to-5 and 62-18 fall-from-5-to-4 precedent narrative already in that comment).
- **Files modified:** `tests/strip-hidden.test.ts`
- **Verification:** `npx vitest run tests/strip-hidden.test.ts` green.
- **Committed in:** `cf9af45` (part of Task 1's own commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug fix — the post-hoc-vs-pre-parse RAWTEXT defect correction — and 1 Rule 3 blocking-issue fix — the stale source-guard counts). Neither is scope creep: both close gaps between the plan's own stated acceptance criteria (all shipped `BL-02` locks pass; the whole test file's verify command passes) and the initial implementation pass.

## Issues Encountered

- The differential harness's corpus-extraction script could not robustly recover EVERY literal via static AST-free regex extraction (one computed value — the `CR-09: 250 junk hiding rules` test's dynamically-built `junk` string — needed manual reconstruction rather than a direct literal-eval). Handled by hand-reconstructing that one case and the three module-scope fixture arrays (`IDEMPOTENCE_FIXTURES`, `BL03_THREAT_CLASS_CARRIERS`, `INVISIBLE_UNICODE_INPUTS`) verbatim from the shipped source rather than attempting a general TS-array-literal evaluator — acceptable for a throwaway, not-committed harness whose deliverable is the disposition table, not the extraction tooling itself.
- `describe`/`it` from `vitest` throw when called outside an active vitest run (`Cannot read properties of undefined (reading 'config')`), ruling out directly importing the test files as plain ES modules to recover their fixture arrays programmatically — confirmed via a throwaway probe script before choosing the hand-reconstruction approach above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- CR-07 is closed: no raw attribute-value string reaches `isHiddenStartTag` anywhere in the module, enforced by a shipped, non-vacuous source guard (Task 3).
- `scanHtml` is now the SOLE source of element/comment structure for stages 2 through 5 — the T-62-43 cross-stage boundary bug class (CR-01, BL-01, BL-02, NEW-01, FB-01, CR-10 were all prior instances) has no remaining un-closed instance this phase has named.
- Two hand-rolled regex scanners remain (stage 0 truncation, stage 6 leftover-tag sweep) — named above, not claimed complete.
- WR-13 (class split on JS `\s` vs HTML's five whitespace chars) remains open, unaffected by this plan, not incidentally closed.
- The four `it.fails` locks (NF-03/04/05, REG-01) remain open, all in the CSS-tokenizer layer (`harvestFromStylesheet`) this plan did not touch — 62-25 (per `62-25-PLAN.md`, not read as part of this plan's own scope) is the next plan in this wave set.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-01*

## Self-Check: PASSED

- FOUND: `src/source/strip-hidden.ts`
- FOUND: `tests/strip-hidden.test.ts`
- FOUND: `.planning/phases/62-multi-inbox-email-ingest-hardening/62-24-SUMMARY.md`
- FOUND commit `cf9af45` (Task 1)
- FOUND commit `e25455e` (Task 2)
- FOUND commit `de5654a` (Task 3)
- `npx vitest run` (full repo): 198 test files passed / 1 skipped, 3280 tests passed / 4 expected fail / 4 skipped, 0 unexpected failures
- `npx tsc --noEmit -p tsconfig.json` and `-p tests/tsconfig.json`: both exit 0
- `npm run build`: exits 0
- `git diff --name-only d251b4d HEAD`: exactly `src/source/strip-hidden.ts` and `tests/strip-hidden.test.ts` — matches this plan's declared `files_modified`, zero scope creep
- `git log --oneline 0ef9b5a6..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts`: 0 lines (frozen surface untouched)
