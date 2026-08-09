---
phase: 62-multi-inbox-email-ingest-hardening
plan: 22
subsystem: security
tags: [htmlparser2, html-parsing, css-tree, cross-stage-boundary, email-ingest, EMAIL-03]

# Dependency graph
requires:
  - phase: 62 (plan 20)
    provides: "Token-derived CSS declaration-signature reconstruction (hasHidingSignatureFromTokens), EOF-drained frame stack, deletion of the fail-open MAX_HARVESTED_SELECTORS cap — unmodified by this plan"
  - phase: 62 (plan 21)
    provides: "htmlparser2@10.0.0 exact-pinned; the exact API surface (event names, inclusive [start,end] offsets, the D-62-21-01 RAWTEXT-close-tag residual) this plan's scanHtml is built against"
provides:
  - "scanHtml(html): one htmlparser2 pass yielding comment ranges, <style>-element ranges and start-tag records (HtmlScan/HtmlComment/HtmlStyleElement/HtmlStartTag), computed once per stripHiddenContent call"
  - "Stage 2 (harvestHidingSelectors) and stage 3 (removeComments) both consume scanHtml's single result, closing CR-10 (a <style> inside an HTML comment can no longer be harvested as live) by construction"
  - "MAX_STRIP_INPUT_CODE_UNITS's cost argument re-derived against the two-parser (css-tree + htmlparser2) cost curve over 29 shapes at the 1 MiB boundary; cap value unchanged"
affects: [62-24]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One conformant parser pass shared by every stage that needs to agree about document structure, computed once per call and passed by reference (mirrors 62-17/62-18's css-tree token-stream sharing, now extended across the HTML/CSS boundary)"
    - "Inclusive-to-exclusive offset conversion isolated entirely inside the primitive that owns the parser dependency (scanHtml), so no downstream stage ever reasons about htmlparser2's own [start,end] convention"
    - "Fail-closed parser-error fallback (maximallyReducingScan) as the total-function contract for a third-party parser dependency on the ingest hot path"

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - src/source/gmail-adapter.ts
    - tests/strip-hidden.test.ts
    - tests/gmail-hidden-content.test.ts
    - tests/css-liveness-differential.test.ts

key-decisions:
  - "startTags is produced and unit-tested (document order, decoded attrs, forward-scan-corrected elementEnd for the D-62-21-01 truncation case) but deliberately NOT wired into stage 4/5 in this plan — 62-24 owns that rewiring (CR-07 attribute decoding), per the plan's own interface contract"
  - "A self-closing <style/> is excluded from scanHtml's styleElements, preserving stage 4's own pre-existing SELF_CLOSING_SUFFIX_RE treatment of it (WR-03 status quo) rather than letting stage 2 silently start harvesting a shape stage 4 still treats as self-closing — desynchronizing the two stages again would reopen exactly the class this plan closes"
  - "NF-01 (unmatched CDO inside <style> truncating the whole document) closed as a predicted side effect of CR-10's fix; converted from it.fails to a passing it. NF-03/04/05 (the CDO/CDC-prelude-pollution and blockless-at-rule mechanisms) remain open, unaffected by this plan, and still locked as it.fails"
  - "runDifferential's hasUnmatchedCdo early return (previously a skip for inputs whose ground truth NF-01 made unreliable) is retained ONLY as an observability counter, no longer short-circuits — per the plan's own instruction, no magnitude bound was widened to accommodate what now flows through"
  - "Tasks 1+2 landed in one commit (documented deviation, precedent 62-20): scanHtml has no independent runtime behavior until stage 2/3 consume it, so a clean two-commit split would have meant writing prose in one commit and rewriting it in the next"

requirements-completed: [EMAIL-03]

# Metrics
duration: ~90min
completed: 2026-08-01
---

# Phase 62 Plan 22: HTML Parser Integration — scanHtml Closes CR-10 by Construction Summary

**One `htmlparser2@10.0.0` pass (`scanHtml`) now yields comment ranges and `<style>`-element ranges shared by stage 2 and stage 3, closing CR-10 (a `<style>` hidden inside an HTML comment can no longer be harvested as live) and NF-01 (an unmatched CDO inside `<style>` truncating the whole document) as predicted side effects, with the 1 MiB input cap's cost argument re-derived over 29 shapes and kept unchanged.**

## Performance

- **Duration:** ~90 min
- **Completed:** 2026-08-01
- **Tasks:** 3 (Task 1+2 combined per documented deviation, Task 3 separate)
- **Files modified:** 5 (`src/source/strip-hidden.ts`, `src/source/gmail-adapter.ts`, `tests/strip-hidden.test.ts`, `tests/gmail-hidden-content.test.ts`, `tests/css-liveness-differential.test.ts`)

## Accomplishments

- `scanHtml(html)` (new, exported from `strip-hidden.ts`): one `htmlparser2` `Parser` pass producing `HtmlScan { comments, styleElements, startTags }`. Converts the parser's own inclusive `[start,end]` offset convention to this file's `[start,end)` exclusive convention at construction time — no downstream code ever sees an inclusive offset. A parser-internal error (forced in a test via a `Parser.prototype.write` spy) returns a maximally-REDUCING scan (one comment and one styleElement spanning the whole input), never an empty fail-open one.
- Stage 2 (`harvestHidingSelectors`) and stage 3 (`removeComments`) now both consume the SAME `scan` object, computed once at the top of `stripHiddenContent` — closing the `<style>`-vs-comment half of the T-62-43 cross-stage boundary bug class (62-18 closed the `<style>`-vs-`<style>` half). `HTML_COMMENT_RE` and the `START_TAG_RE`+`findRawtextCloseBounds` walk stage 2 used to run are both deleted from those two stages.
- **CR-10 closed by construction**: comment-vs-element is decided once, by the parser, so a `<style>` open tag inside an HTML comment (`<!-- <style> -->`) can never be harvested as a live stylesheet, and a real stylesheet can never be paired with a bogus open tag. Both plan-specified shapes reproduced with the plan's exact expected outputs, against both the TS source and the built `dist/`:
  - `'<!-- <style> --><p>hi</p><style>.legal{display:none}</style>ok<span class="legal">PAYLOAD_C1</span>Thanks.'` → `"hiokThanks."`
  - `'<!--<style-->Dear applicant,<style>.legal{display:none}</style>ok<span class="legal">PAYLOAD_C2</span>Bye.'` → `"Dear applicant,okBye."`
- **NF-01 closed as a predicted side effect**: the parser never mistakes RAWTEXT content (a CDO inside `<style>`) for an HTML comment, so stage 3's old unterminated-comment truncation fail-safe — which used to destroy the rest of the document, including the real `</style>` tag and every visible sentence after it — has nothing left to guard against and is gone. Converted from `it.fails` to a passing `it` in `tests/css-liveness-differential.test.ts`. `runDifferential`'s `hasUnmatchedCdo` early return no longer skips those inputs (retained only as an observability counter); no magnitude bound was widened to accommodate what now flows through, and the full differential suite (Generators 1-3, ~25,000+ generated inputs) stayed green.
- Task 3: re-derived `MAX_STRIP_INPUT_CODE_UNITS`'s cost argument end-to-end over 29 shapes at exactly 1,048,576 code units (62-18's 25 + 2 HTML-layer shapes from 62-21's C4 + 2 new shapes stressing `scanHtml`'s own per-tag/per-close-tag bookkeeping). Worst shape: ~47 ms through `stripHiddenContent` — over 20x headroom under the 1000 ms budget, the same margin 62-18 measured; the second parser pass does not erode it. **1,048,576 (1 MiB) is KEPT, not resized** — only the argument changed. `gmail-adapter.ts`'s diff is confined to the `MAX_STRIP_INPUT_CODE_UNITS` doc comment (verified via the plan's own `git diff` grep gate); `parseEmailDate` (EMAIL-04 freeze) is byte-unchanged.

## Task Commits

1. **Task 1 (scanHtml) + Task 2 (wire stage 2/3, reconcile NF-01)** — `08efe05` (feat) — combined per documented deviation below
2. **Task 3 (re-derive MAX_STRIP_INPUT_CODE_UNITS)** — `0153064` (fix)
3. **Fixup: HTML_COMMENT_RE grep-gate compliance + shipped CR-10 locks** — `48c683f` (test)

## Files Created/Modified

- `src/source/strip-hidden.ts` — added `scanHtml`/`HtmlScan`/`HtmlComment`/`HtmlStyleElement`/`HtmlStartTag` (new section above stage 2), rewired `harvestHidingSelectors`/`removeComments`/`stripHiddenContent` to consume one shared scan, updated the file-level doc block's stage-order section and added a "62-22 gap closure" section, deleted `HTML_COMMENT_RE` and the stage-2 `START_TAG_RE`/`findRawtextCloseBounds` walk.
- `src/source/gmail-adapter.ts` — `MAX_STRIP_INPUT_CODE_UNITS`'s §3 doc comment only, re-deriving the cost argument for the two-parser pipeline; constant value unchanged (1,048,576); `parseEmailDate` untouched.
- `tests/strip-hidden.test.ts` — new `scanHtml` unit-test describe block (10 tests: CR-10 shape, unterminated `<style>`, self-closing `<style/>` exclusion, decoded-attrs startTags, bogus/unterminated comments, ascending-range check, 20,000-input totality, forced-parser-error fallback), new "62-22 gap closure" describe block (both CR-10 shapes as shipped locks + the "exactly one scanHtml call" conservation check via a `Parser.prototype.write` spy).
- `tests/gmail-hidden-content.test.ts` — new "62-22 gap closure" describe block, own block per the plan's instruction (WR-14's existing duplicate-shape rows in the prior block untouched): the two worst-measured shapes as a shipped cost-regression test.
- `tests/css-liveness-differential.test.ts` — NF-01 converted from `it.fails` to a passing `it`; `runDifferential`'s CDO early return removed (now an observability counter only); doc-comment updates on both.

## Decisions Made

- **`startTags` produced but not wired this plan** — the interface contract 62-24 needs (document order, lowercased name, decoded `attrs` map, `tagStart`/`tagEnd`/`elementEnd`) is established and unit-tested now, in the same pass that establishes the parser's offset arithmetic, but no stage 4/5 rewiring happens here — that is 62-24's CR-07 (attribute HTML-entity decoding) closure.
- **Self-closing `<style/>` excluded from `styleElements`** — preserves stage 4's existing `SELF_CLOSING_SUFFIX_RE` treatment (WR-03, still open, out of this plan's scope) rather than letting stage 2 silently diverge from stage 4 on that one shape.
- **`elementEnd` computed via a three-way rule** derived empirically against `htmlparser2`'s actual event stream (verified with a throwaway spike script, not assumed from the SUMMARY prose alone): a real (non-implied) close tag forward-scans to the true `>` (correcting D-62-21-01's truncated-offset gap, a no-op on well-formed close tags); an implied close whose reported position is BEFORE the element's own tag end is a void/self-closing echo (`elementEnd = tagEnd`); any other implied close (EOF, or an ancestor's close tag triggering an implied close) uses the implied close's own start as the boundary.
- **DOCTYPE and `<?...?>` folded into `comments`** alongside `<!x>`-shaped bogus comments — all three route through `htmlparser2`'s `onprocessinginstruction`, deleting a DOCTYPE is inert (no leak), and keeping `scanHtml`'s mental model to one rule avoids an unjustified carve-out.
- **Tasks 1+2 combined in one commit** (see Deviations below) — precedent 62-20.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Task 2's own verify command required zero occurrences of the literal string `HTML_COMMENT_RE` anywhere in the file, including doc-comment prose**
- **Found during:** post-Task-2 verification pass (re-reading the plan's exact verify command, not just running the test suite)
- **Issue:** Four doc-comment sentences explaining the OLD mechanism (for historical/explanatory context) still named the deleted constant literally, failing `test -z "$(grep -n 'HTML_COMMENT_RE' src/source/strip-hidden.ts)"`.
- **Fix:** Reworded all four mentions to describe "the old comment-matching regex" without naming the deleted identifier.
- **Files modified:** `src/source/strip-hidden.ts`
- **Verification:** `grep -c "HTML_COMMENT_RE" src/source/strip-hidden.ts` → `0`; full suite still green.
- **Committed in:** `48c683f`

**2. [Rule 2 - Missing critical] Task 2's own acceptance criteria (both CR-10 shapes "reproduced against `dist/` with exact outputs recorded" as SHIPPED tests, and "asserted by a spy/counter test" that `stripHiddenContent` computes exactly one `scanHtml` per call) were verified manually but not yet locked as tests after the initial implementation pass**
- **Found during:** post-Task-2 acceptance-criteria review
- **Issue:** The initial Task 1+2 commit verified both properties via scratch scripts, not shipped assertions — a future regression would not be caught by the suite.
- **Fix:** Added both as shipped `it()` tests (CR-10 shapes 1 and 2 exact-output locks; a `Parser.prototype.write` spy asserting exactly one construction per `stripHiddenContent` call).
- **Files modified:** `tests/strip-hidden.test.ts`
- **Verification:** `npx vitest run tests/strip-hidden.test.ts` — all green including the three new tests.
- **Committed in:** `48c683f`

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug fix, 1 Rule 2 missing-critical addition), plus the documented Tasks-1+2-combined-commit process deviation (precedent 62-20, not a Rule 1-4 deviation).
**Impact on plan:** No scope creep — both fixes close gaps between the plan's own stated acceptance criteria and the initial implementation pass, found by re-reading the plan's exact verify commands rather than assuming the test-suite-green signal was sufficient.

## Issues Encountered

- The worktree's initial branch base (a Phase-45-era commit, matching the pattern the two prior executors in this phase also hit) was stale relative to the required base (`b06e521`). Corrected per the mandatory `<worktree_branch_check>` protocol; working tree was clean beforehand.
- `htmlparser2`'s actual event-offset behavior for `elementEnd` computation (particularly the three-way implied-vs-real, void-echo-vs-EOF-vs-ancestor-implied distinction) was not fully specified by 62-21-SUMMARY.md's own "Exact API Surface" section (which covered comment/RAWTEXT-close semantics in detail but not general start-tag close matching). Resolved by writing a throwaway spike script (`spike-htmlparser2.ts`, deleted before commit — never part of any commit) tracing the parser's actual event stream against ~15 representative shapes (void elements, nested/unclosed elements, self-closing non-void elements, the two D-62-21-01 RAWTEXT-close deviations) before writing `scanHtml`'s implementation, rather than guessing from the SUMMARY prose alone.
- The full `npx vitest run` (whole repo) initially showed 23 pre-existing, unrelated failures (locomo-harness/scorer/adapter-capture/adapter-inject tests requiring `require()` against `dist/*.cjs` artifacts that did not exist yet in the freshly-reset worktree). Confirmed pre-existing via `git stash` against the unmodified base — not caused by this plan. Resolved as a side effect of running `npm run build` for Task 3's own verification; the full suite is green (197 files / 3261 tests passed, 4 expected `it.fails`, 4 skipped) at close.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `scanHtml`'s `HtmlScan`/`HtmlStartTag` contract is established and unit-tested; 62-24 can consume `startTags` directly without rediscovering the shape (document order, lowercased name, decoded attrs, the three offsets) or re-deriving the offset-conversion rule.
- **Scanners still hand-rolled after this plan** (no total-coverage claim): stage 0's hoisted stray-`<` fail-safe truncation and stage 6's `ANY_TAG_RE` remaining-tag sweep are both still raw regex scans over `html` — no plan in this wave set owns them. Stage 4 (non-content element removal) and stage 5 (hidden element removal) still use `collectRemovalRanges`/`findMatchingCloseEnd`/`START_TAG_RE` — **plan 62-24 owns rewiring that half onto `scanHtml().startTags`** (the CR-07 attribute-decoding closure this plan's `startTags` contract was built for).
- NF-03 (comma-separated selector list rejected all-or-nothing), NF-04 (blockless at-rule misattributing the next rule's block), and NF-05 (CDO/CDC not skipped at the stylesheet top level) remain open, unaffected by this plan, still locked as `it.fails` in `tests/css-liveness-differential.test.ts`. NF-01's own combined repro shape still leaks its PAYLOAD marker via the NF-05 mechanism specifically — documented in that test's own comment as the plan's acceptance criterion's stated escape hatch (NF-01 was filed as an availability defect only, never a leak defect).
- WR-03 (self-closing `<style/>` not harvested/removed per spec) remains open and untouched, its status quo deliberately preserved by `scanHtml`'s own self-closing-style exclusion rather than silently reopened.

### 29-Shape Cost Table (Task 3, `stripHiddenContent`, sorted worst-first, all at exactly 1,048,576 code units)

| ms | Shape |
|---|---|
| 47.34 | CSS: brace-free `a<x ` repeated (worst) |
| 46.83 | NEW: many `</style foo>` truncated-offset closes repeated |
| 42.60 | CSS: real rules repeated |
| 42.24 | NEW: many small tags (`<span>a</span>` repeated) |
| 41.88 | report (`a<x ` repeated, no braces) |
| 32.09 | single unquoted attribute triple |
| 25.25 | four attribute pairs (Shape T unit) |
| 22.01 | Shape Y |
| 20.36 | Shape T |
| 18.44 | bare `<style>` repeated |
| 18.03 | CSS: `"x` unterminated string |
| 15.72 | `<style ` repeated, no `>` until final byte |
| 15.30 | CSS: alternating quotes |
| 13.95 | NEW: `<style ` repeated, no `>` until final byte (HTML layer, 62-21 C4) |
| 12.06 | CSS: `xurl(` repeated |
| 9.87 | Shape V |
| 8.84 | CSS: `\a` repeated escapes |
| 8.62 | CSS: `{` repeated |
| 6.39 | Shape Z |
| 5.92 | Shape W |
| 5.83 | CSS: `url(z` unterminated |
| 5.28 | Shape X |
| 5.09 | Shape X3 |
| 5.03 | CSS: `/*y` unterminated comment |
| 0.73 | NEW: one unterminated HTML comment to EOF (HTML layer, 62-21 C4) |
| 0.69 | Shape S |
| 0.69 | Shape B |
| 0.66 | Shape U |
| 0.65 | Shape A |

End-to-end `normalizeGmailMessage`, worst 3 by `stripHiddenContent` time: 41.26 ms (many truncated `</style foo>` closes), 34.12 ms (CSS real rules repeated), 30.83 ms (CSS brace-free `a<x `). Worst measured value across all 29 shapes and both call paths: **47.34 ms**, against a 1000 ms budget — over 20x headroom. The two worst shapes are shipped as a regression test in `tests/gmail-hidden-content.test.ts`'s new "62-22 gap closure" block.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-01*

## Self-Check: PASSED

- FOUND: `src/source/strip-hidden.ts`
- FOUND: `src/source/gmail-adapter.ts`
- FOUND: `tests/strip-hidden.test.ts`
- FOUND: `tests/gmail-hidden-content.test.ts`
- FOUND: `tests/css-liveness-differential.test.ts`
- FOUND: `.planning/phases/62-multi-inbox-email-ingest-hardening/62-22-SUMMARY.md`
- FOUND commit `08efe05` (Task 1+2)
- FOUND commit `0153064` (Task 3)
- FOUND commit `48c683f` (Task 2 fixup)
- `npx vitest run` (full repo): 197 test files passed / 1 skipped, 3261 tests passed / 4 expected fail / 4 skipped, 0 unexpected failures
- `npx tsc --noEmit`: exits 0
- `npm run build`: exits 0
