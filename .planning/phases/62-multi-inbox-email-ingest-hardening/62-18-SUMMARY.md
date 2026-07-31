---
phase: 62-multi-inbox-email-ingest-hardening
plan: 18
subsystem: security
tags: [redos, quadratic-elimination, html-parsing, css-tree, email-ingest, prompt-injection]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening (plan 17)
    provides: "css-tree/tokenizer harvest (harvestFromStylesheet/preludeToBareSelectors/
      decodeIdentEscapes) replacing the hand-rolled CSS scanner, with STYLE_BLOCK_RE left
      byte-identical so the tokenizer swap was the only variable — this plan's explicit
      prerequisite for closing T-62-54/T62-91 in isolation"
provides:
  - "STYLE_BLOCK_RE deleted — the module's last quadratic (T-62-54, escalated as T62-91) is
    eliminated, not re-bounded. A new findRawtextCloseBounds primitive (shared by stage 2
    and stage 4) plus a START_TAG_RE cursor walk locate <style> elements in O(n), measured
    0.2-3.6 ms on shapes that cost 2.9-156.2 SECONDS under the deleted regex at the
    1,048,576-code-unit cap boundary"
  - "Stage 2 and stage 4 now share ONE opinion about a <style> element's boundary
    (START_TAG_RE + RAWTEXT_CLOSE_TAIL_RE), closing the T-62-43 cross-stage bug class for
    <style> specifically (BL-01/BL-02 were both instances of it)"
  - "Specified behavior change: an unterminated <style> element's content is now harvested
    to end of input (HTML section 13.2.5), locked in both directions (under-strip payload
    absence, over-strip control) and cross-checked against the 62-16 liveness oracle"
  - "MAX_STRIP_INPUT_CODE_UNITS's cost argument re-established on a corrected 25-shape set
    (62-14's 12 + T62-91's 3 + the new no-close shape + 9 adversarial CSS shapes from
    62-16's decision record), all newly measured against the post-fix module — cap value
    kept at 1 MiB, worst shape ~44-46ms (>20x headroom)"
  - "IN-05 closed — STRIP_INPUT_OMITTED_MARKER no longer cites the nonexistent
    MAX_STRIP_INPUT_BYTES constant"
affects: [62-19]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Forward-only close-tag cursor as a transitivity proof: findRawtextCloseBounds's
      RAWTEXT_CLOSE_OPENER_RE.lastIndex only ever advances, so a failed scan from position
      p proves no scan from any p' > p can succeed either — this licenses breaking an outer
      loop entirely on the first unterminated element instead of retrying a failing scan
      from every subsequent candidate, converting O(n^2) into O(n)."
    - "Delete-and-reuse over patch-and-diverge for cross-stage boundary agreement: rather
      than patching STYLE_BLOCK_RE to match START_TAG_RE's semantics (as 62-12/62-13 did
      twice), 62-18 deletes STYLE_BLOCK_RE outright and has stage 2 call the exact
      primitives stage 4 already used — agreement becomes structural (one shared scan) not
      incidental (two regexes built from the same fragment but maintained separately)."

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - src/source/gmail-adapter.ts
    - tests/strip-hidden.test.ts
    - tests/gmail-hidden-content.test.ts
    - tests/css-liveness-adjudication.test.ts

key-decisions:
  - "STYLE_BLOCK_RE deleted outright rather than re-bounded (the plan's own charter,
    honored exactly) — a linear findRawtextCloseBounds walk shares primitives with stage 4
    instead of maintaining a sixth independent tag-boundary regex."
  - "Unterminated <style> content is harvested to end of input (HTML section 13.2.5) rather
    than yielding nothing (STYLE_BLOCK_RE's old behavior) — verified against the 62-16
    liveness oracle before shipping, in both the under-strip and over-strip directions."
  - "<style/> (self-closing) is explicitly skipped by the new outer walk, leaving WR-03
    (62-REVIEW.md, still open) untouched — no attempt made to fix it in this plan's scope."
  - "1 MiB cap KEPT, not resized — every one of the 25 re-measured shapes clears the 1000ms
    budget by >20x margin post-fix, so only the cap's written justification needed
    correcting, not its value."
  - "IN-05's fix drops the implementation-detail identifier from the marker text entirely
    (rather than swapping in the current constant name) because the string lands in
    record.content, read by an LLM extractor, not a developer grepping source."

requirements-completed: [EMAIL-03]

# Metrics
duration: 21min
completed: 2026-07-31
---

# Phase 62 Plan 18: T62-91 Quadratic Elimination + Cap Re-Justification Summary

**Deleted STYLE_BLOCK_RE (the module's last quadratic, T-62-54/T62-91) in favor of a linear START_TAG_RE + findRawtextCloseBounds walk shared with stage 4, then re-measured the 1 MiB input cap's cost argument against a corrected 25-shape set and closed IN-05's dangling constant reference.**

## Performance

- **Duration:** 21 min
- **Started:** 2026-07-31T16:59:12Z (approx., per STATE.md session continuity)
- **Completed:** 2026-07-31T17:20:00Z (approx.)
- **Tasks:** 2 (1 TDD auto task, 1 auto task)
- **Files modified:** 5

## Accomplishments

- `STYLE_BLOCK_RE` deleted from `src/source/strip-hidden.ts`; `findRawtextCloseBounds` added
  (shared by stage 2's new `harvestHidingSelectors` cursor walk and stage 4's
  `findRawtextCloseEnd`, now a thin wrapper) — the close-tag scan exists exactly once
- Five cost shapes at exactly the 1,048,576-code-unit cap boundary: `STYLE_BLOCK_RE` measured
  2,887 ms - 156,223 ms; the linear replacement measures 0.2 - 3.6 ms on the same shapes —
  confirmed live via shipped tests, not just planning-time prototypes
- The T62-91-reported `<style ` -with-no-`>` shape (156,223 ms pre-fix, reachable end-to-end
  because stage 0's Bound A cannot truncate a body whose only `>` is its final byte) is now
  locked at 5.96 ms in the shipped suite
- Unterminated `<style>` behavior change specified and tested in both directions
  (under-strip payload-absence, over-strip control), cross-checked against the 62-16
  liveness oracle (`liveHidingSelectors`) before assertion
- T-62-43 cross-stage `<style>`-boundary bug class closed structurally: stage 2 and stage 4
  now call the same `START_TAG_RE`/`RAWTEXT_CLOSE_TAIL_RE` primitives instead of maintaining
  independently-agreeing regexes; source guard counts fell 5 -> 4 (mirror image of 62-13's
  4 -> 5 rise)
- Corrected 25-shape cost re-measurement against the post-fix built `dist/`: worst shape
  ~43.8 ms (`stripHiddenContent`) / ~45.7 ms end-to-end (`normalizeGmailMessage`) — the 1 MiB
  cap stays, with its doc comment now citing T62-91 as the reason the original
  justification (sized against Shape T alone) was wrong, not incomplete
- IN-05 closed: `STRIP_INPUT_OMITTED_MARKER` changed from
  `'[body omitted: exceeds MAX_STRIP_INPUT_BYTES]'` (a constant that never existed) to
  `'[body omitted: exceeds size limit]'`; `MAX_STRIP_INPUT_BYTES` now survives only in
  doc-comment prose (grep gate: 0 non-comment occurrences)
- Full suite: 3202 passed / 3 skipped (up from the 3191/3 baseline this plan started from)

## Task Commits

Followed the plan's own RED/GREEN split for Task 1 (`tdd="true"`):

1. **Task 1 — RED (failing tests first)** - `0463f45` (test): five cost-shape assertions at
   exactly the cap boundary plus the unterminated-`<style>` under-strip test, all confirmed
   failing (4 timing failures at 2.9s-156.7s wall clock, 1 behavioral failure). Production
   code untouched.
2. **Task 1 — GREEN (linear `<style>` location)** - `f84ba84` (feat): `findRawtextCloseBounds`
   added, `harvestHidingSelectors` rewritten as a `START_TAG_RE` cursor walk,
   `STYLE_BLOCK_RE` deleted, file-level doc block updated with the "62-18 gap closure"
   section, source guard counts corrected 5 -> 4.
3. **Task 2 — cap re-justification + IN-05** - `5012d40` (fix): 25-shape corrected
   measurement (12 + 3 + 1 + 9) against the post-Task-1 built `dist/`, cap kept at 1 MiB
   with its doc comment rewritten, a shipped end-to-end cost test for the three worst
   shapes, `STRIP_INPUT_OMITTED_MARKER` literal changed and all three test-file references
   to the old string/name updated.

**Plan metadata:** (this commit) `docs(62-18): complete T62-91 quadratic elimination plan`

_TDD Gate Compliance: RED commit `0463f45` precedes GREEN commit `f84ba84` in git log — gate
sequence satisfied._

## Files Created/Modified

- `src/source/strip-hidden.ts` — `STYLE_BLOCK_RE` and its ~30-line doc comment deleted;
  `findRawtextCloseBounds` added above `findRawtextCloseEnd` (now a thin wrapper);
  `harvestHidingSelectors` rewritten as a linear cursor walk with an updated doc comment
  inheriting the CR-01/BL-02 boundary decisions; file-level doc block updated (retired the
  "measured and named, not fixed" T-62-54 statement, added the "62-18 gap closure (T62-91)"
  section with the cost table and O(n) argument, updated the stage-order stage-2 entry)
- `src/source/gmail-adapter.ts` — `MAX_STRIP_INPUT_CODE_UNITS`'s doc comment rewritten to
  cite the corrected 25-shape measurement and name T62-91 as the reason the previous
  justification failed; `STRIP_INPUT_OMITTED_MARKER` literal changed (IN-05) with an added
  doc-comment rationale for why the new text omits any identifier
- `tests/strip-hidden.test.ts` — new "T62-91" describe block: 5 cost-shape assertions (4
  from `<measurements_from_planning>` plus a well-formed control) at exactly the cap
  boundary with idempotence checks, a result-parity test, and both unterminated-`<style>`
  direction tests cross-checked against the liveness oracle; source guard counts updated
  5 -> 4 with an extended rationale comment
- `tests/gmail-hidden-content.test.ts` — `OMISSION_MARKER`/`BYPASS_CORPUS` "WR-02 cap" row
  updated to the new IN-05 literal; new shipped end-to-end cost test for the three worst
  shapes of the corrected 25-shape set (`report`/`brace-free a<x`/`{` repeated) at exactly
  the cap boundary
- `tests/css-liveness-adjudication.test.ts` — test title referencing the nonexistent
  `MAX_STRIP_INPUT_BYTES` corrected to the real `MAX_STRIP_INPUT_CODE_UNITS` identifier

## Decisions Made

- **`STYLE_BLOCK_RE` deleted, not re-bounded** — the plan's own charter, honored exactly.
  Re-sizing the cap around the quadratic (the verification report's other suggested
  remedy) was rejected during planning because the required cap to bound the
  `<style ` -no-`>` shape would drop to roughly 8 KB, breaking legitimate HTML mail; deleting
  the mechanism removes the tradeoff entirely.
- **Unterminated `<style>` now harvests to end of input** — matches HTML section 13.2.5 and the
  range stage 4's own fail-safe already deletes. Verified against the 62-16 liveness oracle
  (`liveHidingSelectors('.legal{display:none}')` confirms a browser applies the rule) before
  shipping the assertion, per the plan's explicit cross-check instruction.
- **`<style/>` (self-closing) is skipped, unchanged from the WR-03 status quo** — the plan's
  action explicitly scoped this task to NOT attempt a WR-03 fix; the outer walk's
  `SELF_CLOSING_SUFFIX_RE` check preserves that disposition rather than resolving it.
- **1 MiB cap kept at its current value** — every one of the 25 re-measured shapes (worst
  ~44-46 ms) clears the 1000 ms budget with >20x headroom post-fix, so per the plan's
  decision branch ("if every shape is comfortably under budget, KEEP the cap"), only the
  written justification needed correcting.
- **IN-05's replacement literal omits any identifier entirely** rather than swapping in
  `MAX_STRIP_INPUT_CODE_UNITS` — the marker lands in `record.content`, consumed by an LLM
  extractor, and an implementation-detail constant name belongs in the doc comment (where
  the cross-reference is preserved), not in model-facing text.

## Deviations from Plan

None — plan executed exactly as written. The three test-file locations still asserting the
old `MAX_STRIP_INPUT_BYTES` string (verbatim in `tests/gmail-hidden-content.test.ts` twice,
by name in a test title in `tests/css-liveness-adjudication.test.ts`) were explicitly called
out by the plan's own acceptance criteria ("grep for any other assertion of the old string
before assuming that row is the only one") and updated as directed, not as an unplanned
deviation.

## Issues Encountered

None. The RED verification run for Task 1 took ~191 seconds wall clock (the four genuinely
quadratic pre-fix shapes ran to completion rather than being preempted by vitest's per-test
timeout, since `stripHiddenContent` is fully synchronous and blocks the event loop) — expected
per the plan's own "red-on-timeout" framing, not a defect.

## User Setup Required

None — no external service configuration required.

## Corrected Shape Set — Full Measurement Table (Task 2)

All 25 shapes measured directly against the POST-Task-1 built `dist/src/source/strip-hidden.js`
(via `dist/src/source/gmail-adapter.js` for the end-to-end row), one call per shape, at exactly
`MAX_STRIP_INPUT_CODE_UNITS` (1,048,576 code units). Not a shipped fixture — reproducible via
the shape generators inlined in this table's source rows (`tests/strip-hidden.test.ts`'s T62-91
describe block and this plan's own shape functions).

### 62-14's twelve ranked shapes (`stripHiddenContent`)

| Shape | Pre-Task-1 (STYLE_BLOCK_RE present) | Post-fix (this plan) |
|---|---|---|
| report (`a<x ` repeated, no braces) | n/a (measured at smaller sizes historically) | 43.82 ms |
| Shape A | n/a | 0.52 ms |
| Shape B | n/a | 0.56 ms |
| Shape S | n/a | 0.54 ms |
| Shape T (T-62-54, the original residual) | ~439 ms (62-15's own number, 1 MiB) | 18.72 ms |
| Shape U | n/a | 0.65 ms |
| Shape V | n/a | 4.92 ms |
| Shape W | n/a | 3.54 ms |
| Shape X | n/a | 3.83 ms |
| Shape X3 | n/a | 3.82 ms |
| Shape Y | n/a | 20.09 ms |
| Shape Z | n/a | 4.43 ms |

### T62-91's 3 reported parametrizations + the new no-close shape

| Shape | Pre-fix (`STYLE_BLOCK_RE`) | Post-fix |
|---|---|---|
| bare `<style>` repeated | 23,249 ms | 15.92 ms |
| four attribute pairs (Shape T unit) | 2,887 ms | 21.46 ms |
| single unquoted attribute triple | 8,381 ms | 30.84 ms |
| `<style ` repeated, no `>` until final byte | 156,223 ms | 5.96 ms |

### 9 adversarial CSS shapes (62-16 decision record item 4, re-measured post-Task-1)

| Shape | Post-fix |
|---|---|
| brace-free `a<x ` | 43.57 ms |
| `/*y` unterminated comment | 3.56 ms |
| `url(z` unterminated | 4.46 ms |
| `"x` unterminated string | 14.44 ms |
| `\a` repeated escapes | 7.64 ms |
| alternating quotes | 12.93 ms |
| real rules repeated | 13.00 ms |
| `{` repeated | 31.94 ms |
| `xurl(` repeated | 10.61 ms |

### Worst 3, end-to-end through `normalizeGmailMessage`

| Shape | `stripHiddenContent` | end-to-end |
|---|---|---|
| report (`a<x ` repeated, no braces) | 43.82 ms | 31.28 ms |
| CSS: brace-free `a<x ` | 43.57 ms | 45.68 ms |
| CSS: `{` repeated | 31.94 ms | 28.91 ms |

Worst measured value across all 25 shapes and both call paths: **45.68 ms**, against a
1000 ms budget — over 20x headroom, and no shape is bounded by a quadratic any longer. These
three are the ones shipped as a cost-assertion test in `tests/gmail-hidden-content.test.ts`.

## Next Phase Readiness

- 62-19 (WR-09 closure + full differential against the pre-wave-12 baseline) inherits a
  module with zero known quadratics and one more specified behavior change to account for:
  unterminated `<style>` elements are now harvested to end of input rather than yielding
  nothing. This is in addition to the three behavioral deltas 62-17 already flagged
  (non-ASCII class harvesting now correct, digit-leading invalid-selector harvesting now
  correctly excluded, residual (e) confirmed pre-existing). None require a scope change to
  62-19; they are additional rows its differential should expect and correctly classify as
  improvements.
- WR-03 (`<style/>` self-closing cross-stage disagreement, 62-REVIEW.md) remains open and
  untouched by this plan, as scoped.
- No blockers.

## Self-Check: PASSED

Verified via `git log --oneline -5`: all 3 commits (`0463f45`, `f84ba84`, `5012d40`, plus this
metadata commit once created) present. Verified via file reads: `src/source/strip-hidden.ts`
contains `findRawtextCloseBounds` and no longer contains `STYLE_BLOCK_RE` outside doc-comment
prose (grep gate: 0 non-comment matches). `src/source/gmail-adapter.ts`'s
`STRIP_INPUT_OMITTED_MARKER` is `'[body omitted: exceeds size limit]'`; `MAX_STRIP_INPUT_BYTES`
survives in `src/` and `tests/` only inside doc-comment prose (grep gate: 0 non-comment
occurrences). Full suite: 3202 passed / 3 skipped, `npx tsc --noEmit` clean, `npm run build`
succeeds. Frozen surface check (`git log --oneline 0ef9b5a6..HEAD` over the five frozen files)
returns 0 commits; `parseEmailDate` (lines 318-328) is untouched by either Task 2 commit's diff.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-31*
