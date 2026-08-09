---
phase: 62-multi-inbox-email-ingest-hardening
plan: 25
subsystem: testing
tags: [css-tree, differential-testing, css-liveness, hard-gate, email-ingest, EMAIL-03]

# Dependency graph
requires:
  - phase: 62 (plan 20)
    provides: "Token-derived CSS declaration-signature reconstruction (hasHidingSignatureFromTokens) on the production side, closing CR-05's production half"
  - phase: 62 (plan 22)
    provides: "scanHtml (CR-10 closure); NF-01 converted from it.fails to a passing it, with runDifferential's hasUnmatchedCdo early return retained as observability-only"
  - phase: 62 (plan 24)
    provides: "Stage 4/5 driven by scanHtml().startTags (CR-07 closure); confirmed NF-03/04/05/REG-01 as the exact residual it.fails set entering this plan"
provides:
  - "Oracle declaration verdict (tests/support/css-liveness-oracle.ts) derived from css-tree's parsed Declaration.property/Declaration.value nodes, closing CR-05's oracle half — the judge no longer shares a copy of production's twelve regexes"
  - "Hard-gated leak bucket (tests/css-liveness-differential.test.ts): every leak is attributed to a NAMED mechanism (NF03_commaList/NF04_blocklessAtRule/NF05_topLevelCdoCdc) with its own structural predicate, or reaches `failures` and fails the suite — closes CR-11"
  - "Injection proof (Task 3, not committed — see below) demonstrating the gate genuinely blocks on a leak it cannot name"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Oracle declaration verdict computed structurally from css-tree's own parsed AST (Identifier/Number/Dimension/Percentage/Function nodes), never from a regex copied from the module under test — extends the same independence principle plan 62-16 established for the selector layer to the declaration layer"
    - "Leak attribution via ordered structural predicates (isNf03CommaList/isNf04BlocklessAtRule/isNf05TopLevelCdoCdc), each computed independently via css-tree's parser/tokenizer, never by re-running production's harvestFromStylesheet/preludeToBareSelectors — an unattributed leak is a hard failure, not a wider catch-all"

key-files:
  created: []
  modified:
    - tests/support/css-liveness-oracle.ts
    - tests/css-liveness-differential.test.ts

key-decisions:
  - "Structural predicates over textual-shape matching for NF-04/NF-05: both are implemented as small finite-state tokenizer walks (AtKeyword-first-token + Semicolon-before-next-brace for NF-04; CDO/CDC-before-next-brace for NF-05) that reproduce the STRUCTURAL condition production's frame-walker mishandles, rather than re-deriving production's own bug via its own code — chosen so a genuinely different implementation is doing the judging"
  - "The oracle's declaration-layer rewrite preserves each of the twelve hiding shapes' exact prior semantics (including production's own looseness, e.g. clip:rect(0.5...) still counts as clip:rect(0... via a raw-text-prefix check on the parsed Number/Dimension node's own value field) rather than 'fixing' them to be more spec-correct — the goal was independence from production's regex copy, not a stricter judge that would manufacture new divergences unrelated to this plan's scope"
  - "The six behavior-list assertions from Task 1's <behavior> block are shipped in tests/css-liveness-differential.test.ts (this plan's other declared file), not tests/css-liveness-adjudication.test.ts — keeps both new test locks inside this plan's own files_modified scope with zero out-of-scope edits"
  - "NF-01 exact count is asserted as an exact toBe(N) alongside NF03/04/05, even though it is observability-only and unrelated to the leak/over-strip gate itself — 'every remaining toBeLessThan is replaced' was applied uniformly rather than leaving one bound in place"

requirements-completed: [EMAIL-03]

# Metrics
duration: ~55min
completed: 2026-08-01
---

# Phase 62 Plan 25: CSS Liveness Differential — Hard-Gated Leak Bucket + Independent Oracle Declaration Layer (CR-05/CR-11) Summary

**The CSS-liveness differential's leak bucket is now a hard gate (three named, exact-counted mechanism predicates plus an unattributed-leak hard failure, replacing the `toBeLessThan(pairCount * 0.05)` bound CR-11 found silently absorbing 19 real leaks), and the test-only oracle's declaration verdict is now derived from css-tree's own parsed `Declaration` nodes instead of a copy of production's twelve regexes — closing the WR-09 root cause (a judge sharing its decision procedure with the judged) on the declaration layer specifically.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-01T19:07:02-04:00 (base commit)
- **Completed:** 2026-08-01T23:31:00Z
- **Tasks:** 3 (Task 3 produced no committed code changes — its injection proof was deliberately reverted per the plan's own instruction; its deliverable is this SUMMARY)
- **Files modified:** 2 (`tests/support/css-liveness-oracle.ts`, `tests/css-liveness-differential.test.ts`) — matches the plan's declared `files_modified` exactly, verified via `git diff --stat` against the base commit

## Accomplishments

- **CR-05's oracle half closed.** `liveHidingSelectors` (`tests/support/css-liveness-oracle.ts`) no longer copies production's twelve declaration regexes over a raw block-text slice. It now parses with `parseValue: true` and reads each `Declaration` node's `property`/`value` structurally (`Identifier`/`Number`/`Dimension`/`Percentage`/`Function`), fixing two genuine false verdicts the raw-text approach produced: `display:/*x*/none` used to report NOT LIVE (a comment between colon and value defeated the regex), and `/*display:none*/color:red` used to report LIVE (the regex matched literal comment text a browser never tokenizes as a declaration at all). `display:\6eone` now resolves via `ident.decode`, the same decode path the selector layer already used. All twelve hiding shapes' SEMANTICS are preserved structurally, including production's own looseness on `clip:rect(0.5...)`/`clip-path:inset(100%...)` (a raw-text-prefix check on the parsed value node, not a stricter numeric-equality check, to avoid manufacturing new divergences outside this plan's scope).
- **CR-11 closed: the leak bucket is now a gate.** `runDifferential`'s under-strip branch (`tests/css-liveness-differential.test.ts`) no longer routes every leak into one `NFDANGER_leak` counter bounded by `toBeLessThan(pairCount * 0.05)`. Three named, independent structural predicates (`isNf03CommaList`, `isNf04BlocklessAtRule`, `isNf05TopLevelCdoCdc` — none re-running production's `harvestFromStylesheet`/`preludeToBareSelectors`) attribute each confirmed leak to its mechanism via `attributeLeak`; a leak matching none of them is pushed to `failures`, and `throwIfFailures` fails the suite. `grep -c "toBeLessThan" tests/css-liveness-differential.test.ts` is 0.
- **Exact, measured per-mechanism counts across all three generators, zero unattributed leaks:**

  | Generator | NF01 (observability) | NF03_commaList | NF04_blocklessAtRule | NF05_topLevelCdoCdc | NFSAFE_overStrip | Unattributed |
  |---|---|---|---|---|---|---|
  | 1 (exhaustive k=2, 1936 pairs) | 86 | 10 | 1 | 16 | 50 | 0 |
  | 2 (seeded k=3..6, N=20000) | 1921 | 52 | 10 | 461 | 1768 | 0 |
  | 3 (structured, N=5000) | 407 | 0 | 0 | 277 | 358 | 0 |

  Generator 3's NF03/NF04 = 0 is a real absence for that seed (its `RULE_LIBRARY` hiding rules never form a comma list or sit adjacent to a blockless at-rule, and its noise pieces did not construct either shape across 5,000 documents this run) — Generators 1 and 2 both exercise NF03/NF04 directly, so neither mechanism is uncovered by the suite as a whole.
- **Injection proof performed and recorded (Task 3) — the gate is demonstrated to fail on a leak it cannot name, not merely asserted to.** A temporary, uncommitted `it` block was added to `tests/css-liveness-differential.test.ts`:
  - **Setup:** `css = '  .legal{display:none}'` (a plain stylesheet with no NF-03/04/05 trigger shape). `liveHidingSelectors(css).classes.has('legal')` confirmed `true` (genuinely live). The REAL `stripHiddenContent` was called and confirmed CORRECT today (`realOut` does not contain the payload marker).
  - **Injector:** `const injectedOut = realOut + classMarker('legal');` — a thin, test-side forced re-insertion of the payload marker into the (real, correct) output, simulating a leak without touching production source.
  - **Command:** `npx vitest run tests/css-liveness-differential.test.ts -t "INJECTION PROOF" --reporter=verbose`
  - **Verbatim failure output:**
    ```
    × tests/css-liveness-differential.test.ts > INJECTION PROOF (temporary, not committed) > a synthetic leak on a real generated input makes throwIfFailures fail the suite 5ms
       → INJECTION PROOF (62-25 Task 3): 1 unclassified divergence(s) found. First 1:

    UNATTRIBUTED LEAK (matches no named mechanism — NF03/NF04/NF05) — probe=legal (class) generating input="  .legal{display:none}"

    ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

     FAIL  tests/css-liveness-differential.test.ts > INJECTION PROOF (temporary, not committed) > a synthetic leak on a real generated input makes throwIfFailures fail the suite
    Error: INJECTION PROOF (62-25 Task 3): 1 unclassified divergence(s) found. First 1:

    UNATTRIBUTED LEAK (matches no named mechanism — NF03/NF04/NF05) — probe=legal (class) generating input="  .legal{display:none}"
     ❯ throwIfFailures tests/css-liveness-differential.test.ts:554:9

     Test Files  1 failed (1)
          Tests  1 failed | 14 skipped (15)
    ```
  - **Restoration:** `git checkout -- tests/css-liveness-differential.test.ts` (working tree was otherwise clean at the time — no uncommitted changes existed outside the injector). Verified: `git status --short` → empty; `git diff --stat` → empty; full `npx vitest run` → `198 files passed | 1 skipped`, `3286 passed | 4 expected fail | 4 skipped`, 0 unexpected failures — the exact same result as before the injection. The injector was never staged or committed.

## Task Commits

1. **Task 1: Derive the oracle's declaration verdict from css-tree's parsed declarations** — `e7e951e` (test)
2. **Task 2: Turn the leak bucket into a gate — named predicates, exact counts, no magnitude bounds** — `34de47e` (test)
3. **Task 3: Prove the gate is blocking, and write the phase's honest residual register** — no commit (injection proof deliberately reverted per the plan's own instruction; this SUMMARY is the deliverable)

## Files Created/Modified

- `tests/support/css-liveness-oracle.ts` — deleted the twelve copied regexes (`DISPLAY_NONE_RE` etc.) and `hasHidingSignature`/`isZeroValue`; added `declarationHasHidingSignature` + seven per-shape structural predicates reading parsed `Declaration` nodes; `parse()` now called with `parseValue: true` (was `false`); rewrote the file's doc comment to state what is/isn't shared with production post-rewrite.
- `tests/css-liveness-differential.test.ts` — added six oracle-behavior locks (Task 1); replaced `NFDANGER_leak` with three named per-mechanism counters + `attributeLeak` + three structural predicates (Task 2); replaced every `toBeLessThan` with `toBe(<exact>)` across all three generators; rewrote the file's header doc comment to name CR-11 and describe the new gate design.

## Decisions Made

See `key-decisions` in the frontmatter above. One additional note: NF-04/NF-05's predicates check the WHOLE generated stylesheet at nesting depth 0 (not scoped to literal-substring-search around the specific probe's own rule) — this matches `hasUnmatchedCdo`'s own existing whole-document-check precedent in this file, and was validated empirically (zero unattributed leaks, zero cross-mechanism misattribution observed) rather than assumed correct by construction; a per-rule-scoped version was considered and rejected as unnecessary complexity given the empirical result.

## Deviations from Plan

None — plan executed exactly as written. Task 3's own action text explicitly instructs "Do not commit the injector," so the absence of a Task 3 commit is the plan's own specified outcome, not a deviation.

## Issues Encountered

- The injection proof's first attempt used `css = 'ident' + 'ident' + '.legal{display:none}'` as the "plain, no-trigger" input — this accidentally produced a COMPOUND selector (`identident.legal`, a type selector glued to a class selector), which the oracle correctly reports as NOT bare (not live), failing the proof's own ground-truth setup assertion before the injected leak logic ever ran. Fixed by using a whitespace prefix (`'  ' + '.legal{display:none}'`) instead, which cannot glue onto the selector token. Caught immediately by the proof's own `expect(truth.classes.has('legal')).toBe(true)` assertion, not a silent pass.

## User Setup Required

None — no external service configuration required.

## Residual Register (this wave set's honest close-out)

This wave set (waves 16-19, plans 62-20/22/24/25) was chartered against exactly eight findings: **CR-05, CR-06, CR-07, CR-08, CR-09, CR-10, CR-11, WR-10**. Status, verified against `SUMMARY.md`s and this plan's own execution (not assumed):

| Finding | Status | Closed by | Evidence |
|---|---|---|---|
| CR-05 (declaration raw-text regex — production half) | CLOSED | 62-20 | `hasHidingSignatureFromTokens` reconstructs declaration text from tokens |
| CR-05 (declaration raw-text regex — oracle half) | CLOSED | 62-25 (this plan, Task 1) | `declarationHasHidingSignature` reads parsed `Declaration` nodes |
| CR-06 (unterminated final block drops rules) | CLOSED | 62-20 | EOF-drain in `harvestFromStylesheet`, evaluates every still-open frame |
| CR-07 (HTML entity decode in class/id/style) | CLOSED | 62-24 | `isHiddenStartTag` reads `scanHtml().startTags[].attrs`, htmlparser2-decoded |
| CR-08 (CRLF escape-terminator decode divergence) | CLOSED | 62-20 | Locked regression test, `decodeIdentEscapes` fix |
| CR-09 (`MAX_HARVESTED_SELECTORS` fail-open) | CLOSED | 62-20 | Cap deleted outright (measured ~30x headroom under budget) |
| CR-10 (`<style>` inside HTML comment hijacks stage 2) | CLOSED | 62-22 | `scanHtml`, one shared htmlparser2 pass for stages 2+3 |
| CR-11 (differential leak bucket cannot fail) | CLOSED | 62-25 (this plan, Task 2+3) | Named per-mechanism gate + injection proof (above) |
| WR-10 (`src/` can import bare `css-tree`/test oracle) | CLOSED | 62-23 | Compile-time boundary + `tests/src-import-boundary.test.ts` |

**All eight chartered findings are closed.** This is the full extent of the claim — nothing wider.

### Module's five named residuals (`src/source/strip-hidden.ts`, accepted, unchanged by this wave set)

- **(a) White-on-white hiding** — not detected; a color-only heuristic would regress legitimate dark-mode prose. Owner: none assigned, accepted design limitation.
- **(b) External stylesheets** — not detected; recense never fetches remote resources during ingest (correct posture). Owner: none assigned, accepted design limitation.
- **(c) Unbalanced quotes inside a tag** — stage-6 stray-`<` fail-safe truncates from an unclosed `title="` to end-of-string. Owner: none assigned, accepted cost of the CR-01 quote-aware fix (62-07).
- **(d) `@media`/`@supports` non-evaluation** — at-rule contents harvested unconditionally, matching the shared oracle blind spot named below. Owner: none assigned, deliberate (62-17), errs toward removing content.
- **(e) Unrestricted-hash `id` harvesting** (e.g. `#1abc`) — harvested as a valid id regardless of CSS Syntax's unrestricted-hash distinction. Owner: none assigned, deliberate (62-17), errs toward removing content.

### Hand-rolled scanners surviving this wave set (both operate on already-reduced text, neither participates in the hiding decision)

- **Stage 0's hoisted stray-`<` fail-safe truncation** (62-14, Bound A) — a duplicate of stage 6's own truncation, run early for cost reasons. Acceptable: runs on already-committed-to-truncate text, cannot itself leak.
- **Stage 6's `ANY_TAG_RE` leftover-tag sweep** — deletes any remaining `<...>` sequence after every prior stage has run. Acceptable: final cleanup pass over content already decided safe or removed elsewhere.

### CSS-tokenizer-layer residuals — open, locked, this plan's own Task 2 gate now covers them structurally

- **NF-03** (comma-separated selector list rejected all-or-nothing) — `it.fails` lock: `tests/css-liveness-differential.test.ts` ("NF-03: a comma-separated selector list is rejected..."). Owner: none assigned, CSS-tokenizer layer (`preludeToBareSelectors`), out of every plan's fix scope so far in this wave set.
- **NF-04** (blockless `@media;` at-rule misattributing the next rule's block) — `it.fails` lock: same file ("NF-04: a blockless at-rule..."). Owner: none assigned, same layer (`harvestFromStylesheet`'s `startsWithAtKeyword` check), same scope status.
- **NF-05** (CDO/CDC not ignorable at stylesheet top level) — `it.fails` lock: same file ("NF-05: CDO/CDC tokens are not treated as ignorable..."). Owner: none assigned, same layer, same scope status.
- **REG-01** (`tests/strip-hidden.test.ts`, an unclosed Function/Url token before a complete `{}` pair causes a later rule to be treated as top-level — over-strip, safe direction) — `it.fails` lock in `tests/strip-hidden.test.ts` ("REG-01: an unclosed Function/Url token..."). Owner: none assigned, same CSS-tokenizer layer, unaffected by this plan (this plan's own files are the CSS-liveness oracle and differential, not `strip-hidden.test.ts`).

All four are now covered by this plan's own Task 2 gate design: NF-03/04/05 each have a NAMED structural predicate feeding an EXACT-counted bucket (not silently absorbed), and any FUTURE mechanism found by the differential's generators will hard-fail the suite as an unattributed leak rather than pass under a bound.

### Out-of-scope findings from `62-REVIEW.md` — explicitly OUT OF SCOPE for this wave set, listed OPEN

This wave set (plans 62-20/22/23/24/25) was scoped to the seven Criticals plus WR-10 only. The following remain OPEN, none touched by any plan in this wave set:

| Finding | Status | Note |
|---|---|---|
| WR-11 (`. legal` whitespace-between-dot-and-ident now harvested — over-strip regression) | OPEN | Verified still reproducible against current `dist/`: `stripHiddenContent('<style>. legal{display:none}</style>ok<span class="legal">VISIBLE_D1</span>Thanks.')` → `"okThanks."` (VISIBLE_D1 still destroyed) |
| WR-12 (comment inside declaration block counts as hiding signature) | **CLOSED INCIDENTALLY by 62-20** | Verified against current `dist/`: `stripHiddenContent('<style>.legal{/*display:none*/color:red}</style>ok<span class="legal">VISIBLE_K4</span>')` → `"okVISIBLE_K4"` (correct). Same finding already recorded as an incidental closure in `62-20-SUMMARY.md`; re-verified here independently rather than trusted on citation alone. |
| WR-13 (`class` split on JS `\s`, not HTML's five ASCII whitespace chars) | OPEN | Confirmed still open in `62-24-SUMMARY.md` ("NOT incidentally closed... deliberately kept the SAME split regex"), unaffected by this plan |
| WR-14 (two of the three "worst 3" cap-boundary shapes are byte-identical) | OPEN | `tests/gmail-hidden-content.test.ts`, untouched by any plan in this wave set |
| WR-15 (`AD04` never incremented — tautological `toBe(0)` assertion) | OPEN | `tests/css-liveness-differential.test.ts`'s `AD04` counter still has no write site; this plan's own `expect(counters.AD04).toBe(0)` assertions (kept unmodified in all three generators) remain tautologically true rather than a real constraint |
| WR-16 (stale doc comments contradicting the code beneath them) | **PARTIALLY CLOSED** | The oracle's own file-level doc comment (`tests/support/css-liveness-oracle.ts`) was fully rewritten by this plan's Task 1 and no longer describes the deleted "brace-partition scan" — that one of WR-16's three named locations is fixed as a side effect. The other two (`tests/css-liveness-adjudication.test.ts`'s stale "never harvested by shipped code" block header; `tests/gmail-hidden-content.test.ts`'s stale "Shape T bounds the cap" claim) are untouched, neither file being in this plan's declared scope, and remain OPEN. |
| IN-06 (vacuous `expect(true).toBe(true)` structural-proof placeholder) | OPEN | `tests/css-liveness-adjudication.test.ts`, untouched |
| IN-07 (stale test comment re: `decodeIdentEscapes`'s 7th-position handling) | OPEN | `tests/strip-hidden.test.ts`, untouched |
| IN-08 (out-of-range-escape test asserts only non-throwing, not the U+FFFD mapping) | OPEN | `tests/strip-hidden.test.ts`, untouched |
| IN-09 (`findRawtextCloseEnd` single-caller pass-through) | OPEN | Untouched |

### Oracle's remaining blind spots after this plan (stated plainly, per the oracle's own rewritten doc comment)

- **Tokenizer layer** — the oracle and production both ultimately read the SAME `css-tree`/`css-tree/tokenizer` token stream. A tokenizer defect shared by both would be invisible to this differential by construction. Independently gated against CSS Syntax Level 3 §4.3 by `tests/css-tokenizer-conformance.test.ts` (built from the spec, not from either side) — mitigated, not eliminated.
- **`@media`/`@supports` condition evaluation** — deliberately unevaluated by both the oracle and production (a stated, shared blind spot, matching residual (d) above), pinned by the adjudication test's `@media screen`/`@media print` rows as an accepted over-strip.
- **Selector-decode layer** — both sides trust css-tree's own `ident.decode`; a defect in that shared dependency would be invisible to either side.

## Next Phase Readiness

- All eight of this wave set's chartered findings (CR-05..CR-11, WR-10) are closed with `dist/`-level or code-level evidence, recorded above — no wider claim.
- The differential's leak bucket is now a proven-blocking gate (injection proof above); any FUTURE leak this differential's generators surface — named or not — will hard-fail the suite rather than pass silently under a bound.
- Named, out-of-scope residuals (NF-03/04/05, REG-01, WR-11/13/14/15/16, IN-06..IN-09) are enumerated above with status and location; none were silently dropped from tracking. This is the fourth SUMMARY in this phase to record a residual register — unlike the prior three, this one's total-coverage claim is scoped to exactly the eight findings this wave set was chartered against, not wider.
- Phase 62 has no further plans queued in this wave set; verification of this close-out is the phase verifier's job, not this plan's own.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-01*

## Self-Check: PASSED

- FOUND: `tests/support/css-liveness-oracle.ts`
- FOUND: `tests/css-liveness-differential.test.ts`
- FOUND: `.planning/phases/62-multi-inbox-email-ingest-hardening/62-25-SUMMARY.md`
- FOUND commit `e7e951e` (Task 1)
- FOUND commit `34de47e` (Task 2)
- `npx vitest run` (full repo): 198 test files passed / 1 skipped, 3286 tests passed / 4 expected fail / 4 skipped, 0 unexpected failures
- `npx tsc --noEmit -p tsconfig.json` and `-p tests/tsconfig.json`: both exit 0
- `npm run build`: exits 0
- `grep -c "toBeLessThan" tests/css-liveness-differential.test.ts`: 0
- `git diff --stat f395a47895c86ea3606a5ca0468d8f089521d672 HEAD`: exactly `tests/support/css-liveness-oracle.ts` and `tests/css-liveness-differential.test.ts` — matches this plan's declared `files_modified`, zero scope creep
- `git log --oneline 0ef9b5a6..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts`: 0 lines (frozen surface untouched)
- Working tree after injection-proof restoration: `git status --short` empty, `git diff --stat` empty
