---
phase: 62-multi-inbox-email-ingest-hardening
plan: 17
subsystem: testing
tags: [css-tree, css-syntax-level-3, tokenizer, security, email-ingest, prompt-injection]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening (plan 16)
    provides: "css-tree@3.2.1 pinned as a tokenizer-only production dependency, the test-only
      liveness oracle, and the shipped per-finding adjudication table with operator-confirmed
      reclassify disposition (FB-01/CR-04 stay agreement rows; scope floor corrected to two
      escaped-selector leaks, not three)"
provides:
  - "A single css-tree/tokenizer token-stream pass (harvestFromStylesheet +
    preludeToBareSelectors + decodeIdentEscapes) replacing the hand-rolled
    stripCssComments/matchesUrlOpen/isCssWhitespaceCode/BARE_*_SELECTOR_RE scanner entirely"
  - "Both confirmed-live CSS-escaped-selector leaks closed (.leg\\61 l, #leg\\61 l), per §4.3.7
    escape decoding applied to harvested class/id names before comparison"
  - "The CR-04 mechanism finding (matchesUrlOpen had no token-boundary check) retired by
    deletion, not reclassification — tracking block in the adjudication test updated to record
    the retirement"
  - "End-to-end bypass-corpus coverage for both directions: leaks that must be absent, and
    adjudicated non-defects (FB-01, both CR-04 shapes, .leg\\al) whose payload must remain
    present, each reproduced against the built dist/"
affects: [62-18, 62-19]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Token-stream harvest over a hand-rolled raw-text scanner: rule boundaries come from
      {}/{} TOKENS (which a BadString/Url/Function token cannot forge), and selector shape is
      decided on TOKEN STRUCTURE (exactly Delim('.')+Ident, or a lone Hash) rather than a
      character-class regex over reconstructed text — closes an entire class of bug (six prior
      bypasses) by removing the reconstruction step those bugs all depended on."
    - "Explicit frame-stack depth tracking for CSS rule nesting, gated on whether a frame's
      prelude started with an AtKeyword token, so @media/@supports parity is preserved while
      declaration-block bodies suspend prelude collection (depth-0-only, per the reclassify
      disposition)."

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts
    - tests/css-liveness-adjudication.test.ts
    - tests/gmail-hidden-content.test.ts

key-decisions:
  - "reclassify disposition honored exactly: prelude collection stays depth-0-only (no
    close-anyway over-strip widening); FB-01 and CR-04 remain agreement rows, not 'fixed'."
  - "decodeIdentEscapes is a from-scratch §4.3.7 implementation in src/, not a reuse of
    css-tree's ident.decode — production code may only import tokenize/tokenTypes from the
    /tokenizer subpath (62-16's adopted-surface boundary); the oracle's own ident.decode stays
    test-only."
  - "Non-defect (payload-must-remain-present) corpus rows were added as adjacent it() cases in
    a new describe block, not as BypassCorpusRow entries — BypassCorpusRow's shape (built
    around asserting absence) never had to be reshaped to also express presence."
  - "MAX_HARVESTED_SELECTORS cap enforcement changed mechanism (throw-free, per-token no-op
    once the cap is hit, plus an outer-loop pre-check skipping further <style> blocks) rather
    than an early function return, to keep tokenize() a genuine single forward pass with no
    exception-based control flow crossing the third-party callback boundary."

patterns-established:
  - "A module's cap/quota enforcement over a callback-driven external API becomes a
    counter-check-and-no-op inside the callback (cheap on every token) plus an outer-loop
    pre-check to skip further iterations entirely, rather than throwing to unwind out of the
    callback — avoids exception-based control flow crossing a third-party library boundary."

requirements-completed: [EMAIL-03]

# Metrics
duration: 33min
completed: 2026-07-31
---

# Phase 62 Plan 17: Token-Stream CSS Hiding-Rule Harvest Summary

**Replaced the hand-rolled CSS scanner in `strip-hidden.ts` with a single `css-tree/tokenizer` pass reading rule boundaries from `{`/`}` tokens and selector shape from token structure, closing both confirmed-live CSS-escaped-selector leaks (`.leg\61 l`, `#leg\61 l`) via a from-scratch §4.3.7 escape decoder and retiring the CR-04 mechanism finding by deleting `matchesUrlOpen` outright.**

## Performance

- **Duration:** 33 min
- **Started:** 2026-07-31T16:22:00Z (approx.)
- **Completed:** 2026-07-31T16:55:00Z
- **Tasks:** 2 (1 TDD auto task, 1 auto task)
- **Files modified:** 4

## Accomplishments

- `stripCssComments` (with its ~90-line doc comment), `matchesUrlOpen`, `isCssWhitespaceCode`,
  `BARE_CLASS_SELECTOR_RE`, and `BARE_ID_SELECTOR_RE` deleted from `src/source/strip-hidden.ts`,
  replaced by `harvestFromStylesheet` (a single `tokenize` pass with an explicit frame stack),
  `preludeToBareSelectors` (token-shape selector matching), and `decodeIdentEscapes` (a
  from-scratch CSS Syntax Level 3 §4.3.7 escaped-code-point decoder)
- Both confirmed-live escaped-selector leaks closed: `.leg\61 l{display:none}` now correctly
  harvests class `legal`, `#leg\61 l{display:none}` now correctly harvests id `legal` — verified
  against production `stripHiddenContent`, the shipped adjudication table, and the built
  `dist/src/source/gmail-adapter.js`
- Every 62-16 adjudicated non-defect (FB-01, both CR-04 shapes, `.leg\al`) still keeps its
  payload present — no agreement row moved in the over-strip direction; `@media` parity, the
  unterminated-comment lock, and the >=2000-input ground-truth generator all pass unmodified
- `STYLE_BLOCK_RE`'s definition line stays byte-identical to its pre-task form (confirmed via
  `git show HEAD~1` diff); the CSS-layer swap is attributable to the tokenizer alone
- Full suite green at close: 3191 passed / 3 skipped (up from the 3169-passed/2-expected-fail
  baseline this plan started from — the two `it.fails` rows flipped to normal passes)

## Task Commits

Followed the plan's own RED/GREEN split for Task 1 (`tdd="true"`):

1. **Task 1 — RED (failing tests first)** - `47825e6` (test): added §4.3.7 decode edge-case
   tests to `strip-hidden.test.ts` and flipped the two confirmed-live escaped-selector rows in
   `css-liveness-adjudication.test.ts` from `it.fails` to normal `it`. 6 tests failed as
   expected; production code untouched.
2. **Task 1 — GREEN (token-stream harvest implementation)** - `188b513` (feat): deleted the
   five hand-rolled symbols, added the token-stream harvest, updated the file-level doc block
   (62-17 gap-closure section, stage-order entry, five residual limitations). Also fixed a
   flawed test expectation discovered during GREEN (see Deviations).
3. **Task 1 follow-up — CR-04 mechanism retirement doc update** - `985ec9e` (docs): required
   by the upstream context ("make sure that tracking block is updated to reflect the mechanism
   being retired, not left dangling") — updated the CR-04 mechanism tracking block and file
   DISPOSITION comment in `css-liveness-adjudication.test.ts` to record retirement rather than
   leaving them describing a defect that no longer exists in source.
4. **Task 2 — bypass-corpus pinning** - `52fc063` (test): added two `BYPASS_CORPUS` rows for
   the closed leaks and an adjacent "adjudicated non-defects" describe block for the four rows
   whose payload must remain present. No `src/` changes (verified via `git diff --name-only`).

**Plan metadata:** (this commit) `docs(62-17): complete token-stream CSS harvest plan`

_TDD Gate Compliance: RED commit `47825e6` precedes GREEN commit `188b513` in git log — gate
sequence satisfied._

## Files Created/Modified

- `src/source/strip-hidden.ts` — deleted `stripCssComments`/`matchesUrlOpen`/
  `isCssWhitespaceCode`/`BARE_CLASS_SELECTOR_RE`/`BARE_ID_SELECTOR_RE`; added
  `harvestFromStylesheet`, `preludeToBareSelectors`, `decodeIdentEscapes`,
  `requireTokenType` + nine resolved `TT_*` token-type constants; added the `css-tree/tokenizer`
  import; updated the file-level doc block (62-17 gap-closure section, stage-order item 2,
  residual limitations (d)/(e))
- `tests/strip-hidden.test.ts` — new describe block covering the two leak closures, the
  `.leg\al` non-leak, and four §4.3.7 decode edge cases (six-hex-digit cap, short-hex-run-no-
  separator, U+0000/surrogate/out-of-range → U+FFFD totality); three new fixtures added to
  `IDEMPOTENCE_FIXTURES`
- `tests/css-liveness-adjudication.test.ts` — the two confirmed-live-leak rows flipped from
  `it.fails` to normal `it`; the CR-04 mechanism tracking block and DISPOSITION doc comment
  updated to record retirement
- `tests/gmail-hidden-content.test.ts` — two new `BYPASS_CORPUS` rows (escaped class/id leaks,
  one using realistic injection text matching the VF-01 precedent); a new "adjudicated
  non-defects" describe block (FB-01, both CR-04 shapes, `.leg\al`); doc comment updated to
  describe both directions

## Decisions Made

- **`reclassify` disposition honored exactly, no `close-anyway` widening applied.** Prelude
  collection stays depth-0-only; a `{`/`}` pair inside an already-suspended declaration block
  is tracked for brace balance but never evaluated as a rule. Verified by hand-tracing FB-01's
  exact token stream against the frame-stack algorithm before writing any code: `.legal`
  never becomes a top-level frame because `.a`'s block is never closed by a real `}`.
- **`decodeIdentEscapes` is a from-scratch §4.3.7 implementation, not a reuse of css-tree's
  `ident.decode`.** Production code may import only `tokenize`/`tokenTypes` from the
  `/tokenizer` subpath (62-16's adopted-surface boundary, enforced by
  `src/types/css-tree-tokenizer.d.ts`); the oracle's `ident.decode` is test-only. The escape
  separator's whitespace set (space/tab/LF/CR/FF) was verified empirically against both
  css-tree's `WhiteSpace` token category and its own `ident.decode` behavior before choosing
  it, rather than assumed from the strict CSS "newline" definition.
- **Non-defect corpus rows live in an adjacent describe block, not as `BypassCorpusRow`
  entries.** `BypassCorpusRow`'s shape asserts absence; reshaping it to also express "payload
  must remain present" would have required renaming/overloading the `forbidden` field in a
  way that reads backward for a non-defect row. The plan explicitly offered "a negative
  corpus entry OR an adjacent documented test" as alternatives — the adjacent-test path keeps
  the interface additive-only (unchanged) rather than reshaped.
- **Cap enforcement (`MAX_HARVESTED_SELECTORS`) is throw-free.** `tokenize()`'s callback API
  gives no way to abort mid-stream; rather than throw a sentinel and catch it (which would
  cross a third-party callback boundary with exception-based control flow), the `onToken`
  handler no-ops once the cap is reached (cheap per-token check) and the outer per-`<style>`-
  block loop pre-checks the cap before calling `tokenize` on any further block. This keeps
  `tokenize` a genuine single forward pass and satisfies the "single forward pass" property
  the threat register (T-62-17-07) claims.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a flawed test expectation for the six-hex-digit escape case**
- **Found during:** Task 1 GREEN verification (first test run after implementation)
- **Issue:** The originally-written test used `.leg\00006cal{display:none}` expecting the
  6-digit hex run to stop at `00006c` and leave `al` as literal suffix — but `c` (the 6th
  character) is itself a valid hex digit, so the escape legitimately consumes all six
  characters `00006c` = U+006C (`l`), leaving only `al` as literal suffix and producing
  `"legl" + "al" = "leglal"`, not `"legal"`. The test's own arithmetic was wrong, not the
  production decoder.
- **Fix:** Rewrote the test input to `.leg\000061l{display:none}` (`000061` = U+0061 = `a`,
  followed by literal `l`), which correctly exercises "the hex run stops at the 6-digit cap
  regardless of what a hypothetical 7th character would have been" while decoding to the
  intended name `legal`.
- **Files modified:** `tests/strip-hidden.test.ts`
- **Verification:** Manually hand-traced the decode algorithm against both the flawed and
  corrected input before editing; confirmed the corrected test passes and the flawed one would
  have (correctly) failed against a spec-conformant decoder, not just against this
  implementation.
- **Committed in:** `188b513` (Task 1 GREEN commit, alongside the production implementation)

**2. [Rule 2 - missing critical functionality, per upstream context] Updated the CR-04 mechanism tracking block to reflect retirement**
- **Found during:** Post-implementation review of the upstream context's explicit instruction
  ("Make sure that tracking block is updated to reflect the mechanism being retired, not left
  dangling")
- **Issue:** `tests/css-liveness-adjudication.test.ts`'s dedicated CR-04-mechanism describe
  block and the file's DISPOSITION doc comment both still described `matchesUrlOpen` as "still
  open, still unfixed" after Task 1 deleted `matchesUrlOpen` entirely — a stale description of
  a defect that no longer exists in source.
- **Fix:** Rewrote both the tracking block's title/body and the DISPOSITION comment to record
  that 62-17's token-walk rewrite retired the mechanism by deletion (not reclassification),
  and to explain structurally why the replacement (token-shape matching in
  `preludeToBareSelectors`) cannot reproduce the same class of bug.
- **Files modified:** `tests/css-liveness-adjudication.test.ts`
- **Verification:** `npx vitest run tests/css-liveness-adjudication.test.ts` (38 passed);
  `npx tsc --noEmit` clean.
- **Committed in:** `985ec9e` (separate docs commit)

---

**Total deviations:** 2 auto-fixed (1 bug/test-correctness, 1 documentation completeness
mandated by upstream context)
**Impact on plan:** Neither changed scope or conclusions. No scope creep.

## Behavioral Differences Noticed (not all test-covered — recorded per this plan's Output instruction)

Beyond the two confirmed-live leaks this plan set out to close, hand-tracing and spot-checking
the new token-walk against the old regex-based harvest surfaced two additional, unrequested
behavior differences — both net-correctness improvements, neither covered by a dedicated test:

1. **Non-ASCII class names are now harvestable (was an unfiled under-strip).** The old
   `BARE_CLASS_SELECTOR_RE = /^\.[A-Za-z0-9_-]+$/` rejected any selector containing a
   non-ASCII letter, so `.café{display:none}` was NEVER harvested even though it is a
   perfectly valid CSS class selector a real browser applies. The new harvest accepts any
   `Ident` token (css-tree's tokenizer correctly includes non-ASCII letters in
   ident-sequences), so `.café` is now harvested like any other bare class selector. Verified
   directly: `oldRegex.test('.café')` → `false`; `tokenize('.café{...}')` → `Delim('.')` +
   `Ident('café')`.
2. **A digit-leading unescaped "class" like `.1abc` is now correctly NOT harvested (was an
   unfiled over-strip risk).** The old regex's character class permitted digits anywhere,
   including first position, so `.1abc{display:none}` was harvested as if it were a valid bare
   class selector — but `.1abc` is not valid CSS without escaping (it tokenizes as a single
   `Dimension` token, not `Delim`+`Ident`), so no real browser would ever apply this rule. The
   new harvest requires the token immediately after `.` to be type `Ident`; a `Dimension`
   token fails that shape check, so the rule is correctly skipped. Verified directly:
   `oldRegex.test('.1abc')` → `true`; `tokenize('.1abc{...}')` → single `Dimension` token, no
   `Delim`+`Ident` pair.
3. **Residual (e) (`#1abc`-shaped unrestricted-hash harvesting) is NOT a new behavior.** The
   file-level doc block's newly-added residual (e) describes the new mechanism (plain
   `tokenize` exposing only token type, not the id/unrestricted flag), but the OLD regex
   (`BARE_ID_SELECTOR_RE`, digits permitted anywhere) already harvested `#1abc`-shaped
   selectors too, by coincidence of its character class rather than by an explicit
   spec-aware decision. Recorded here so a future reader does not mistake residual (e) for a
   62-17 regression — it is a preserved behavior, newly named and explained.

## Measured Cost of the New Harvest

Measured directly against the built `dist/src/source/strip-hidden.js`, one `stripHiddenContent`
call per shape at the 1 MiB `MAX_STRIP_INPUT_BYTES` cap boundary (the size class the WR-02 gap
closure plans this cap against):

| Shape | 1 MiB elapsed |
|---|---|
| Report shape (`a<x ` repeated, no braces) | 43.1 ms |
| Shape V (open brace, brace-free tail) | 5.1 ms |
| Shape W (brace-free run + real rule) | 4.2 ms |
| Shape X (unterminated comment, no rule) | 3.7 ms |
| Shape X3 (unterminated comment that would carry a rule) | 3.5 ms |
| Shape Y (alternating quotes) | 21.7 ms |
| Shape Z (repeated unterminated url-tokens) | 4.3 ms |
| Shape S (no `>`, no closing quote — `STYLE_BLOCK_RE` open-tag stress) | 0.8 ms |
| Shape T (complete open tags, no `</style>` anywhere) | 434.0 ms |

All nine complete comfortably under the suite's 1000ms/512KB bound (measured here at the larger
1 MiB boundary, still under). Shape T's 434 ms is **not** attributable to this plan's change —
it is the pre-existing, explicitly-named, explicitly-deferred `STYLE_BLOCK_RE` lazy-tail-scan
quadratic (T-62-54), scoped to plan 62-18, not this one; `STYLE_BLOCK_RE` is byte-identical
before and after this plan. The remaining eight shapes are dominated by the CSS-layer harvest
this plan changed and all measure single-digit-to-low-double-digit milliseconds — noting this
corrects the threat register's (T-62-17-07) planning-time estimate of "2.6-11.4 ms," which this
executor's own measurement (43.1 ms for the report shape, 21.7 ms for Shape Y) modestly exceeds
at the 1 MiB boundary, though still ~20-230x under the suite's 1000ms assertion bound and with
no test regression.

## Residual Not Closed

`STYLE_BLOCK_RE`'s lazy `</style>` tail-scan quadratic (T-62-54, Shape T above) remains
unfixed, exactly as scoped — this plan changed only the CSS layer inside an already-matched
`<style>` block's content; `STYLE_BLOCK_RE` itself (which locates the `<style>...</style>`
span in the first place) is byte-identical to its pre-task form, confirmed via
`git show HEAD~1:src/source/strip-hidden.ts` diff. Closing it is plan 62-18's explicit charter.

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- 62-18 (the `STYLE_BLOCK_RE` quadratic, T-62-54) is unblocked: this plan's CSS-layer rewrite
  is isolated from `STYLE_BLOCK_RE`, so 62-18 can proceed against a stable, byte-identical
  `STYLE_BLOCK_RE` definition.
- 62-19 (WR-09 closure + full differential against the pre-wave-12 baseline) has three new
  behavioral differences to account for beyond the two intended leak closures — see
  "Behavioral Differences Noticed" above (non-ASCII class harvesting now correct, digit-leading
  invalid-selector harvesting now correctly excluded, residual (e) confirmed pre-existing not
  new). None require a scope change to 62-19; they are additional rows its differential should
  expect to see and correctly classify as improvements, not regressions.
- No blockers.

## Self-Check: PASSED

Verified via `git log --oneline -5`: all 5 commits (`47825e6`, `188b513`, `985ec9e`, `52fc063`,
and this metadata commit once created) present. Verified via file reads: `src/source/strip-
hidden.ts` contains `harvestFromStylesheet`/`preludeToBareSelectors`/`decodeIdentEscapes` and
no longer contains `stripCssComments`/`matchesUrlOpen`/`isCssWhitespaceCode`/
`BARE_CLASS_SELECTOR_RE`/`BARE_ID_SELECTOR_RE` (grep gate: 0 matches outside comments). Full
suite: 3191 passed / 3 skipped, `npx tsc --noEmit` clean, `npm run build` succeeds. Both leak
closures and all four non-defect rows reproduced against the built
`dist/src/source/gmail-adapter.js` directly via `node -e` (all 6 PASS).

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-31*
</content>
