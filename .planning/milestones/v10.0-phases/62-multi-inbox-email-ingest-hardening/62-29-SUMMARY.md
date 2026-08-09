---
phase: 62-multi-inbox-email-ingest-hardening
plan: 29
subsystem: security
tags: [html-parsing, prompt-injection, EMAIL-03, strip-hidden, htmlparser2, gap-closure]

# Dependency graph
requires:
  - phase: 62 (plan 24)
    provides: "scanHtml — one htmlparser2 pass sharing comment/style-element/start-tag ranges across stages 2-5"
  - phase: 62 (plan 28)
    provides: "tests/html-wrapper-differential.test.ts — the parse5-derived oracle differential that independently rediscovered CR-01 (8), CR-03 (6), WR-01 (4) and shipped three temporary HF-* predicates for this plan (and, per a stale attribution, 62-30) to retire"
provides:
  - "HTML_ELEMENT_DISPOSITIONS — the ONE keyed source for which element names are special and how (rendersText, appliesStylesheets), replacing two independently hand-maintained lists"
  - "NON_CONTENT_TAGS and NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS — both exported, both derived from the one map, consumed by stage 4/5 and stage 2 respectively"
  - "A compile-time exhaustiveness check (T-62-29-03) plus a shipped exact-set-equality membership guard (T-62-29-04) — the two halves needed to catch a name added without a disposition AND a disposition silently flipped"
  - "CR-01, CR-03 and WR-01 closed with dist/-level, freshly-built evidence; all three temporary HF-* predicates retired with a corrected ownership record"
affects: [62-30, 62-31, future gap-closure rounds touching src/source/strip-hidden.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One dispositioned element-name map, two independent boolean facts (rendersText, appliesStylesheets), every consumer (NON_CONTENT_TAGS, NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS, RAWTEXT_CLOSE_SLASH_RE) DERIVES from it rather than restating its own copy — the fix for the T-62-43 cross-stage-boundary-disagreement class this phase has now hit six times"
    - "Compile-time exhaustiveness (Record<RawtextName, ElementDisposition> type-checked against the map) catches an ADDED name with no disposition; a shipped exact-set-equality test (sorted-array comparison) catches a FLIPPED disposition — neither alone is sufficient, both are required and both are proven non-vacuous by an injected failure, recorded verbatim, then reverted"
    - "Ancestor-containment filtering (WR-01) reuses the existing collectStartTagRemovalRanges primitive rather than a second range-computation function, with an explicit, documented exclusion of the target element's own type from the ancestor predicate to avoid a self-containment false positive"

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts
    - tests/html-wrapper-differential.test.ts

key-decisions:
  - "HF-03's true owner is 62-29, not 62-30 as 62-28 originally wrote: WR-01 (a stylesheet in a never-applied context) is fixed in this plan's Task 2, per 62-29-PLAN.md:58 and its GREEN outputs at :239-244. Deleted all three temporary predicates together with corrected attribution, per the orchestrator's explicit hf_ownership_correction instruction."
  - "harvestHidingSelectors's WR-01 ancestor filter explicitly excludes 'style' from the never-applied-context predicate used for range computation, even though HTML_ELEMENT_DISPOSITIONS.style.appliesStylesheets is false: collectStartTagRemovalRanges would otherwise push a self-covering range for every <style> tag (since style also matches the predicate), and every style element's own contentStart trivially falls inside its own range — silently excluding ALL style elements, including the plain control, from harvest. The exported disposition-derived set itself is untouched (style stays in NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS per the table); only the internal ancestor-range predicate carries the one-line exclusion, documented in-place."
  - "The end-to-end normalizeGmailMessage assertion for CR-01/CR-03 is recorded here as a dist/-level probe (see below) rather than shipped as a test in tests/strip-hidden.test.ts, per the plan's own instruction: that file cannot import the adapter without taking on 62-30's gmail-hidden-content.test.ts ownership. The dist/-level evidence is quoted verbatim below."

requirements-completed: [EMAIL-03]

# Metrics
duration: ~90min
completed: 2026-08-02
---

# Phase 62 Plan 29: One Dispositioned Element-Name Source — CR-01/CR-03/WR-01 Closure Summary

**Replaced two independently hand-maintained element-name lists and a one-sided self-closing exclusion with a single keyed disposition map, closing CR-01 (self-closing `<style/>` bypass), CR-03 (`iframe`/`noembed`/`noframes` fallback-text leak), and WR-01 (over-strip from a never-applied stylesheet context), each proven RED-then-GREEN against a freshly built `dist/`.**

## Performance

- **Duration:** ~90 min
- **Started:** 2026-08-02 (base commit `ad1efd7`)
- **Completed:** 2026-08-02
- **Tasks:** 3
- **Files modified:** 3 (`src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`, `tests/html-wrapper-differential.test.ts`) — matches the plan's declared `files_modified` exactly

## Accomplishments

- CR-01 closed: a self-closing `<style/>` start tag is a spec-correct no-op (HTML §13.2.5) and is now harvested exactly like any other `<style>` — the one-sided `selfClosingSyntax`/`SELF_CLOSING_SUFFIX_RE` exclusion is deleted outright, not patched
- CR-03 closed: `iframe`/`noembed`/`noframes` are now dispositioned `rendersText: false` and their contents are deleted by stage 4/5, closing the guard-set-vs-ship-set mismatch between `RAWTEXT_CLOSE_SLASH_RE` (8 names) and the old `NON_CONTENT_TAGS` (a different 7)
- WR-01 closed: a `<style>` nested inside a never-applied context (`<iframe>`, `<noscript>`, `<template>`, ...) is filtered out of the stage-2 harvest before its rules can hide prose OUTSIDE the container
- One dispositioned source (`HTML_ELEMENT_DISPOSITIONS`) replaces the two hand-maintained lists; `NON_CONTENT_TAGS` and `NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS` are both derived and exported; `RAWTEXT_CLOSE_SLASH_RE` is built from `RAWTEXT_ELEMENT_NAMES` instead of restating the eight names
- Both halves of the "cannot silently diverge again" guarantee are shipped and independently proven non-vacuous: a compile-time exhaustiveness check (T-62-29-03, proven by an injected ninth raw-text name with no disposition) and a shipped exact-set-equality test (T-62-29-04, proven by an injected `iframe` disposition flip run against the real source)
- All three temporary `HF-*` predicates 62-28 shipped are retired, including the one (WR-01's) whose ownership 62-28 mis-attributed to 62-30 — corrected here per the orchestrator's explicit instruction, with the stale attribution removed from the file's own header and section comments

## Task Commits

1. **Task 1: One dispositioned element-name source; delete the one-sided self-closing exclusion** — `ef0e591` (fix)
2. **Task 2: Do not harvest a stylesheet from a context a browser never applies** — `3c2d94b` (fix)
3. **Task 3: Leak locks, WR-08 spy restoration, and retirement of the temporary HF-* predicates** — `309a3b2` (test)

_Note: this SUMMARY's own commit follows as plan metadata (orchestrator-owned STATE.md/ROADMAP.md updates are out of scope for this executor per instructions)._

## Files Created/Modified

- `src/source/strip-hidden.ts` — `HTML_ELEMENT_DISPOSITIONS` (the one keyed source), `RAWTEXT_ELEMENT_NAMES`/`RawtextName`/the compile-time exhaustiveness check, `NON_CONTENT_TAGS` and `NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS` (both derived and exported), `RAWTEXT_CLOSE_SLASH_RE` (now built from the array), `scanHtml`'s `OpenFrame` wrapper deleted (stack now holds `HtmlStartTag` records directly, no `selfClosingSyntax`), `filterStyleElementsOutsideNeverAppliedContext` (WR-01's ancestor-containment filter), corrected stale doc-block prose (WR-03 status, the deleted `SELF_CLOSING_SUFFIX_RE`).
- `tests/strip-hidden.test.ts` — 13 exact-output leak locks, the exact-membership guard (2 tests) plus its non-vacuousness simulation, the WR-08 `try/finally` fix, corrected the stale self-closing-`<style/>`-exclusion test and the new-RegExp-count guard (1 → 2, explained in place).
- `tests/html-wrapper-differential.test.ts` — retired all three `HF-*` predicates and their `it.fails` locks, replaced with 3 positive agreement assertions; corrected the WR-01/`HF-03` ownership attribution in the file header; the hard gate is now unconditional (no named exemptions left).

## RED / GREEN Evidence — All Twelve `stripHiddenContent` Payloads

All twelve payloads run via a node probe against `dist/src/source/strip-hidden.js`, at the exact build produced from each commit. RED recorded against base commit `ad1efd7` (before any of this plan's edits); GREEN recorded against `309a3b2` (this plan's final commit), freshly rebuilt (`npm run build` immediately before the probe, `git status --porcelain` clean).

| Payload | Input | RED (`ad1efd7`) | GREEN (`309a3b2`) | Expected |
|---|---|---|---|---|
| CR-01 a | `<style/>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>` | `"okPAYLOAD"` | `"ok"` | `"ok"` |
| CR-01 b | `<style />...` (same shape, space before slash) | `"okPAYLOAD"` | `"ok"` | `"ok"` |
| CR-01 c | `<STYLE/>...</STYLE>` (case-insensitive) | `"okPAYLOAD"` | `"ok"` | `"ok"` |
| CR-01 d | `<style type=a/>...` (unquoted attr ending `/`) | `"okPAYLOAD"` | `"ok"` | `"ok"` |
| control | `<style>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>` | `"ok"` | `"ok"` | `"ok"` (unchanged) |
| CR-03 a | `<iframe>INJECT_U1</iframe>ok` | `"INJECT_U1ok"` | `"ok"` | `"ok"` |
| CR-03 b | `<noembed>INJECT_U2</noembed>ok` | `"INJECT_U2ok"` | `"ok"` | `"ok"` |
| CR-03 c | `<noframes>INJECT_U3</noframes>ok` | `"INJECT_U3ok"` | `"ok"` | `"ok"` |
| keep 1 | `<xmp>KEEP_X</xmp>ok` | `"KEEP_Xok"` | `"KEEP_Xok"` | `"KEEP_Xok"` (unchanged) |
| keep 2 | `<textarea>KEEP_T</textarea>ok` | `"KEEP_Tok"` | `"KEEP_Tok"` | `"KEEP_Tok"` (unchanged) |
| WR-01 a | `<iframe><style>.legal{display:none}</style></iframe>ok<span class="legal">VIS</span>` | `"ok"` | `"okVIS"` | `"okVIS"` |
| WR-01 b | `<noscript><style>.legal{display:none}</style></noscript>VIS<span class="legal">Q</span>` | `"VIS"` | `"VISQ"` | `"VISQ"` |
| head control | `<head><style>.legal{display:none}</style></head>ok<span class="legal">P</span>` | `"ok"` | `"ok"` | `"ok"` (unchanged — `head` deliberately keeps `appliesStylesheets: true`) |

All twelve GREEN outputs reproduce exactly as expected. (Thirteen rows above including the `head` control, which is a Task 2 regression control rather than one of the plan's ten named `<behavior>` payloads.)

## End-to-End `normalizeGmailMessage` Evidence

Run via a node probe against `dist/src/source/gmail-adapter.js` at this plan's final commit (`309a3b2`), freshly built:

```
CR-01 a e2e record.content = "From: a@b.com · Re: hi · Acct: acct1\nok"
CR-03 a e2e record.content = "From: a@b.com · Re: hi · Acct: acct1\nok"
```

Neither contains `PAYLOAD` nor `INJECT_U1`. (Pre-fix, at `ad1efd7`, the same probe produced `"...\nokPAYLOAD"` and `"...\nINJECT_U1ok"` respectively — the same leaks `62-VERIFICATION.md` pass 5 and `62-REVIEW.md` recorded.)

Per the plan's own instruction (`62-29-PLAN.md` Task 3), this pair is recorded here as `dist/`-level evidence rather than shipped as a test in `tests/strip-hidden.test.ts`, because asserting it there would require importing `gmail-adapter.ts`, whose test file (`tests/gmail-hidden-content.test.ts`) belongs to 62-30 (wave 23).

## Compile-Time Exhaustiveness Check (T-62-29-03) — Non-Vacuousness Proof

Injected a ninth name into `RAWTEXT_ELEMENT_NAMES` (`'plaintext'`) with no corresponding entry in `HTML_ELEMENT_DISPOSITIONS`, ran `npx tsc --noEmit -p tsconfig.json`:

```
src/source/strip-hidden.ts(537,7): error TS2741: Property 'plaintext' is missing in type '{ readonly script: { readonly rendersText: false; readonly appliesStylesheets: false; }; readonly style: { readonly rendersText: false; readonly appliesStylesheets: false; }; readonly head: { readonly rendersText: false; readonly appliesStylesheets: true; }; ... 8 more ...; readonly xmp: { ...; }; }' but required in type 'Record<"script" | "style" | "title" | "iframe" | "noembed" | "noframes" | "textarea" | "xmp" | "plaintext", ElementDisposition>'.
```

Reverted; `npx tsc --noEmit -p tsconfig.json` exits 0; `git status --porcelain src/source/strip-hidden.ts` empty.

## Exact-Membership Guard (T-62-29-04) — Non-Vacuousness Proof

Flipped `iframe`'s disposition in the real, shipped source from `{ rendersText: false, appliesStylesheets: false }` to `{ rendersText: true, appliesStylesheets: false }`, ran the membership guard test (`npx vitest run tests/strip-hidden.test.ts -t "NON_CONTENT_TAGS"`):

```
 FAIL  tests/strip-hidden.test.ts > strip-hidden.ts — 62-29 T-62-29-04: exact-membership guard over both derived element-name sets > NON_CONTENT_TAGS === {script, style, head, title, template, noscript, svg, iframe, noembed, noframes}
AssertionError: expected [ 'head', 'noembed', 'noframes', …(6) ] to deeply equal [ 'head', 'iframe', 'noembed', …(7) ]

- Expected
+ Received

@@ -1,8 +1,7 @@
  [
    "head",
-   "iframe",
    "noembed",
    "noframes",
    "noscript",
    "script",
    "style",
```

Reverted; re-ran the same test filter — 2 passed, 323 skipped; `git status --porcelain src/source/strip-hidden.ts` empty.

## Exact Membership of the Derived Sets (as shipped)

- `NON_CONTENT_TAGS` = `{script, style, head, title, template, noscript, svg, iframe, noembed, noframes}` (10 names — `rendersText === false`)
- `NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS` = `{script, style, title, template, noscript, iframe, noembed, noframes, textarea, xmp}` (10 names — `appliesStylesheets === false`)

Both read directly off `HTML_ELEMENT_DISPOSITIONS`'s table per the plan's stated derivation rules, not hand-adjusted. `head` and `svg` are the only two names excluded from the second set (both deliberately keep `appliesStylesheets: true`).

## HF-* Retirement

**Ownership correction applied** (per the orchestrator's explicit `hf_ownership_correction` instruction): 62-28 shipped three temporary predicates in `tests/html-wrapper-differential.test.ts` — the first two (CR-01 family, CR-03 family) correctly named `62-29` as owner; the third (WR-01 family, over-strip from a never-applied stylesheet context) incorrectly named `62-30`. WR-01 is fixed by THIS plan's Task 2 (`62-29-PLAN.md:58`, GREEN outputs given at `:239-244`), not by 62-30 (which only mentions WR-01 in passing, as payloads it separately locks against regression). All three predicates are owned by this plan and all three are retired here together.

Verified all three genuinely closed (not merely made to look closed) by running the differential BEFORE deleting the predicates: at this plan's post-Task-2 state, the differential's own `it.fails` locks for all three families FLIPPED to passing (causing `it.fails` itself to report "Expect test to fail"), and the main exact-count assertion failed because all three counts dropped from their shipped values (8/6/4) to 0 — confirmed via `npx vitest run tests/html-wrapper-differential.test.ts` before Task 3's edits. This is the "STOP and report if still firing" check the plan required; none fired, so all three were deleted together with their `it.fails` locks and their shipped exact counts, replaced by three positive agreement assertions. The file's header and section doc comments no longer contain the literal strings `HF-01`/`HF-02`/`HF-03` (`grep -c` = 0, matching Task 3's own verify gate) — the retirement narrative and ownership correction are described in prose instead, with the exact names and shipped counts pointed at `62-28-SUMMARY.md`.

## Decisions Made

See `key-decisions` in frontmatter. Summarized: (1) corrected the HF-03/WR-01 ownership attribution from 62-30 to 62-29, per explicit orchestrator instruction and verified against both plans' own text; (2) excluded `'style'` from the WR-01 ancestor-containment predicate to avoid a self-containment false positive that would have silently broken the plain `<style>` control; (3) recorded the CR-01/CR-03 end-to-end evidence as a `dist/`-level probe in this SUMMARY rather than a shipped test, per the plan's own instruction not to take on 62-30's `tests/gmail-hidden-content.test.ts` ownership.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Excluded `'style'` from the WR-01 ancestor-containment predicate**
- **Found during:** Task 2 implementation
- **Issue:** The plan's literal instruction — compute never-applied ancestor ranges via `collectStartTagRemovalRanges` with a predicate reading `appliesStylesheets === false` off the full disposition map — would include `'style'` itself (disposition `F/F`). Since `collectStartTagRemovalRanges` pushes a range for every matching tag including nested-inside-itself checks, and every `<style>` element's own `contentStart` trivially falls inside its own `[tagStart, elementEnd)` range, applying the predicate unmodified would have self-excluded EVERY `<style>` element from harvest — including the plain top-level control, which must return `"ok"` (i.e., must still hide the payload).
- **Fix:** Added an explicit `name !== 'style'` exclusion to the predicate used ONLY for the ancestor-range computation (the exported `NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS` set itself is untouched and still includes `'style'` per the disposition table, satisfying the Task 3 exact-membership guard's expected list verbatim). Documented in place with the reasoning (a `<style>` element cannot meaningfully be its own ancestor container; its body is RAWTEXT, so a genuinely nested `<style>` can never exist).
- **Verified:** All twelve `<behavior>` payloads (control, WR-01 a/b, head control) reproduce their exact expected outputs; full suite green.
- **Files modified:** `src/source/strip-hidden.ts`
- **Commit:** `3c2d94b`

**2. [Rule 3 - Blocking] `HF-01`/`HF-02`/`HF-03` literal-substring acceptance criterion required rewriting the retirement narrative in prose**
- **Found during:** Task 3, running the plan's own `<verify>` grep gate
- **Issue:** The plan's verify gate requires `grep -c 'HF-01\|HF-02\|HF-03' tests/html-wrapper-differential.test.ts` to equal 0 — a stricter, literal reading than "delete the predicates and their locks" alone, since the file's header doc comment legitimately wants to narrate what was retired and why (including the ownership correction).
- **Fix:** Rewrote the header and section comments to describe the three retired predicates and the ownership correction without using the literal tokens `HF-01`/`HF-02`/`HF-03`, pointing to `62-28-SUMMARY.md` for their exact original names and shipped counts.
- **Verified:** `grep -c 'HF-01\|HF-02\|HF-03' tests/html-wrapper-differential.test.ts` = 0.
- **Files modified:** `tests/html-wrapper-differential.test.ts`
- **Commit:** `309a3b2`

## CR-02 Status

**CR-02 is NOT closed by this plan and remains open**, as scoped. This plan's `must_haves` and `<threat_model>` cover only CR-01, CR-03, and WR-01 (T-62-29-01 through T-62-29-05); WR-08 (Task 3's spy-restoration fix, unrelated to any of the three) is closed as a drive-by fix explicitly named in Task 3's own action block. WR-05 (comment drift) is addressed only insofar as this plan's own doc-block corrections remove the specific stale references CR-01's root-cause analysis named; a broader WR-05 sweep is out of scope.

## Frozen Surface

`git log --oneline 4354c81..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts` returns 0 lines. `git diff 4354c81..HEAD -- src/source/gmail-adapter.ts` is empty (the file was not touched at all by this plan) — `resolveAccountQuery`/`parseEmailDate`/`event_ts` are unchanged.

## Full Suite / Build / Typecheck

- `npm run build` exits 0.
- `npm run typecheck` (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json`) exits 0.
- `npx vitest run` (full suite): 199 files passed / 1 skipped; 3322 passed / 6 expected-fail / 4 skipped — up from 62-28's baseline of 3306 passed / 9 expected-fail (net +16 passed, -3 expected-fail, matching the 3 retired `HF-*` `it.fails` locks plus this plan's new leak/guard/positive-agreement tests).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- CR-01, CR-03, and WR-01 are closed with `dist/`-level, freshly-built evidence, both in isolation and end-to-end through `normalizeGmailMessage`.
- The module now holds exactly one dispositioned source for special element names, with both a compile-time guard (catches an added name with no disposition) and a shipped runtime guard (catches a flipped disposition) — both proven non-vacuous against the real, shipped source, not simulated in isolation.
- All three temporary `HF-*` predicates are retired with a corrected ownership record; `tests/html-wrapper-differential.test.ts`'s hard gate is now unconditional.
- CR-02 remains open, scoped to a future plan.
- Frozen surface confirmed untouched.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-02*

## Self-Check: PASSED

- `.planning/phases/62-multi-inbox-email-ingest-hardening/62-29-SUMMARY.md` exists: FOUND
- Commit `ef0e591` (Task 1) present in `git log --oneline --all`: FOUND
- Commit `3c2d94b` (Task 2) present in `git log --oneline --all`: FOUND
- Commit `309a3b2` (Task 3) present in `git log --oneline --all`: FOUND
- `git status --porcelain` clean (no uncommitted diffs to `src/`/`tests/`): confirmed
- `npx vitest run` full suite green (199 passed / 1 skipped files, 3322 passed / 6 expected-fail / 4 skipped tests): confirmed
- `npm run typecheck` and `npm run build` both exit 0: confirmed
