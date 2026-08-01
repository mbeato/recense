---
phase: 62-multi-inbox-email-ingest-hardening
plan: 20
subsystem: security
tags: [css-tree, tokenizer, css-syntax, indirect-prompt-injection, gmail-adapter, echoleak]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening (plan 62-17)
    provides: css-tree tokenizer migration of the CSS selector layer (hasHidingSignature registry, decodeIdentEscapes, harvestFromStylesheet frame-stack walk)
provides:
  - Token-derived CSS declaration-signature reconstruction (hasHidingSignatureFromTokens) at both hasHidingSignature call sites
  - EOF-drained frame stack in harvestFromStylesheet (unterminated final declaration block no longer silently dropped)
  - Deletion of the fail-open MAX_HARVESTED_SELECTORS cap (no bounded-harvest failure mode that proceeds to strip with a known-incomplete hidden-set)
  - CRLF-correct escape decoding in decodeIdentEscapes (CSS Syntax section 3.3)
  - Locked regression tests for CR-05/CR-06/CR-08/CR-09, source guard against the raw-slice mechanism reappearing
affects: [62-21, 62-22, 62-23, 62-24, 62-25]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Token-derived text reconstruction before regex-signature matching (never regex over raw/untokenized CSS text)"
    - "Shared evaluate-and-add local function reused by a tokenize callback branch AND a post-tokenize EOF drain, so the two paths cannot diverge (T-62-43 cross-boundary class)"
    - "Delete-not-resize disposition for a fail-open cap, backed by an in-plan cost/memory measurement at the input-size boundary"

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts

key-decisions:
  - "CR-09 disposition: deleted MAX_HARVESTED_SELECTORS outright (primary disposition), not the fail-closed overflowed fallback -- measured 33ms / ~2-12MB RSS growth at the 1 MiB input boundary, well under the 1000ms budget"
  - "hasHidingSignatureFromTokens takes the same content slice the pre-existing frame-stack walk already computed and re-tokenizes just that slice, rather than collecting per-frame body-token arrays -- preserves the existing linearity argument (hasPrelude frames are pairwise disjoint) without adding a second bookkeeping structure"
  - "Tasks 1 and 2's source changes landed in one commit (1d90eb2) rather than two: Task 2's action explicitly requires factoring the exact code Task 1 just wired into a shared evaluateFrame() local function, so a clean two-commit split would have required writing then immediately rewriting the same lines"

requirements-completed: [EMAIL-03]

# Metrics
duration: ~25min
completed: 2026-07-31
---

# Phase 62 Plan 20: CSS Declaration-Signature Token Migration Summary

**Migrated the CSS declaration-signature layer to the token stream (mirroring 62-17's selector-side migration), drained the frame stack at EOF, deleted the fail-open 200-selector harvest cap, and fixed CRLF escape decoding in `decodeIdentEscapes`.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-31
- **Tasks:** 3 (all completed)
- **Files modified:** 2 (`src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`)

## Accomplishments

- `hasHidingSignatureFromTokens()` reconstructs a declaration block's content (or an inline `style` attribute value) from the token stream — `Comment` tokens become one space, ident-bearing tokens (`Ident`/`Function`/`Hash`/`AtKeyword`/`Url`) are escape-decoded via `decodeIdentEscapes`, everything else is emitted verbatim — before the result reaches `hasHidingSignature`'s unchanged twelve regexes. Both call sites (`harvestFromStylesheet`'s frame evaluation, `isHiddenStartTag`'s inline-style check) are migrated; `hasHidingSignature` is never reachable with a raw `css.slice(...)` anywhere in the module (grep-verified, locked by a shipped source guard).
- `harvestFromStylesheet`'s evaluate-and-add logic is factored into one shared `evaluateFrame()` local function used by both the `RightCurlyBracket` branch and a new post-`tokenize` EOF drain — an unterminated final declaration block (`.legal{display:none` with no closing `}`) is now evaluated instead of silently abandoned.
- `MAX_HARVESTED_SELECTORS` (200) and its three fail-open `return`/`break`/`continue` checks are deleted outright, not resized. Measured at the 1 MiB input boundary: 250 attacker-authored junk rules ahead of a real `.legal{display:none}` rule no longer starve out the real rule and the payload no longer leaks.
- `decodeIdentEscapes` now consumes a CRLF pair as ONE escape separator per CSS Syntax §3.3, matching css-tree's own `ident.decode` — a hex-escaped selector authored with Windows line endings (the native MIME line ending) now decodes correctly instead of leaving a stray LF in the name.
- Ten locked repro tests added (one per finding: CR-05a/b/c + over-strip control, CR-06 x3, CR-08 + control, CR-09), plus CR/CRLF/FF rows in the §4.3.7 escape-decode block, a `'\r\n'` fragment in the WR-02 deterministic fuzz alphabet, and a new source guard banning `hasHidingSignature(css.slice` / any bare `.slice(...)` argument to `hasHidingSignature`, with a non-vacuousness assertion.

## Task Commits

Each task was committed atomically (Tasks 1 and 2 combined per the note below):

1. **Task 1 + Task 2: token-derived declaration signature, EOF drain, cap deletion, CRLF fix** — `1d90eb2` (fix)
2. **Task 3: locked repros, escape-decode extension, source guard** — `daf0783` (test)
3. **Follow-up: file-level doc-comment section for the 62-20 gap closure** — `ba91c25` (docs)

_Note: Tasks 1 and 2 (both `tdd="true"`) landed in a single commit because Task 2's own action text requires factoring `harvestFromStylesheet`'s just-wired evaluate-and-add logic (Task 1) into a shared `evaluateFrame()` local function in the same edit — a clean two-commit split would have meant writing, then immediately rewriting, the identical lines. Both changes are verified together against the full existing test suite (which already exercised the affected code paths) plus the ten new locked repros added in the Task 3 commit._

## Files Created/Modified

- `src/source/strip-hidden.ts` — added `hasHidingSignatureFromTokens` (token-derived declaration signature reconstruction), `TT_FUNCTION`/`TT_URL` token-type resolutions, factored `evaluateFrame` + EOF drain in `harvestFromStylesheet`, deleted `MAX_HARVESTED_SELECTORS` and its three checks + the `counter` parameter threading, fixed CRLF consumption in `decodeIdentEscapes`, corrected an overstating doc comment, added a `62-20 gap closure` file-level doc section.
- `tests/strip-hidden.test.ts` — ten locked repro tests (CR-05a/b/c + control, CR-06 x3, CR-08 + control, CR-09), CR/CRLF/FF escape-decode rows, `'\r\n'` in the fuzz alphabet, source guard against the raw-slice mechanism reappearing.

## Decisions Made

- **CR-09 disposition: deleted, not fail-closed fallback.** Measured a `<style>` body of exactly 1,048,576 code units of maximal distinct `.aN{display:none}` rules through `stripHiddenContent`:

  | run | elapsed | RSS before | RSS after | RSS delta |
  |-----|---------|------------|-----------|-----------|
  | 1   | 32.35ms | 63.25MB    | 74.89MB   | 11.64MB   |
  | 2   | 33.25ms | 71.58MB    | 83.52MB   | 11.94MB   |
  | 3   | 27.75ms | 81.06MB    | 83.53MB   | 2.47MB    |

  All three runs completed in under 34ms — roughly 30x headroom under the 1000ms budget named in the plan's named fallback trigger — so the primary disposition (delete the cap outright) ships; the fail-closed `overflowed` fallback was not implemented.
- `hasHidingSignatureFromTokens` re-tokenizes the same content slice the existing frame-stack walk already computes the boundaries of, rather than collecting a per-frame body-token array. This preserves the linearity argument already established in the file (`hasPrelude` frames are pairwise disjoint, so total re-tokenized text is bounded by input length) without introducing a second bookkeeping structure.
- Tasks 1 and 2's source edits landed in one commit — see the Task Commits note above.

## Deviations from Plan

None (Rules 1-4) beyond the one documented commit-boundary note above, which is a mechanical consequence of the plan's own task sequencing (Task 2 explicitly rewrites code Task 1 just added), not a scope or correctness deviation.

## Issues Encountered

- The worktree's initial branch base (`f779bfb`, a Phase 45 commit) was stale relative to the required base (`c144c231...`, the latest Phase 62 planning commit) — `src/source/strip-hidden.ts` and its test files did not exist at the stale base. Corrected per the mandatory `<worktree_branch_check>` protocol (`git reset --hard` to the required base; working tree was clean beforehand, verified via `git status --short`).
- `node_modules` was absent in the freshly-checked-out worktree (this repo's `.planning/` — and, transitively, no prior `npm ci` — is gitignored/local-only per this repo's `.gitignore`). Ran `npm ci` against the existing `package-lock.json` (a lockfile-pinned install of already-declared dependencies, not a new package addition) to make `vitest`/`tsc`/`tsx` available.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The declaration-signature layer is now token-derived at every call site, EOF-closed blocks are harvested, the CRLF escape case decodes correctly, and every reproduced payload is locked by a shipped test and re-reproduced against `dist/`.
- **Explicit statement of what in this module is still a hand-rolled scanner after this plan** (per the plan's `<output>` instruction): stage 0 / stage 6 stray-`<` fail-safe truncation (a raw-text forward scan for a stray `<`, not token-derived — no owning plan in this wave set touches it), `ANY_TAG_RE` (stage 6's remaining-tag removal — a regex over raw HTML text, not tokenized; out of this plan's `<files>` scope), `extractAttr` (stage 5's attribute-value extraction via regex on raw attribute text — CR-07, the HTML-entity-decoding gap, is scoped to plan 62-24 per this plan's own `isHiddenStartTag` comment), `removeComments` (stage 3's `HTML_COMMENT_RE` — HTML comment removal, a regex scan, not CSS-tokenizer-related and out of scope here). None of these four are owned by this plan; this plan's scope was exclusively the CSS declaration-signature layer inside `<style>` blocks and inline `style` attributes.
- No total-coverage claim is made: this plan closes CR-05/CR-06/CR-08/CR-09 specifically. CR-07 (HTML entity decoding in attribute values) is explicitly deferred to plan 62-24 per this plan's own `isHiddenStartTag` doc comment. CR-10 (a `<style>` inside an HTML comment hijacking stage 2) and CR-11 (the differential's leak-bucket assertion gap) are untouched by this plan and remain open per `62-REVIEW.md`.
- Incidental closure check (per this plan's `<why_a_raw_slice_can_never_agree>` note): WR-12 (an over-strip false positive from a comment inside a declaration VALUE, e.g. `.legal{/*display:none*/color:red}`) was named as potentially closed as a side effect of the CR-05 fix. Verified directly: `stripHiddenContent('<style>.legal{/*display:none*/color:red}</style>ok<span class="legal">VISIBLE_WR12</span>')` returns `"okVISIBLE_WR12"` — the element is correctly kept visible (the commented-out `display:none` text is replaced by a single space at tokenize time, so the reconstructed declaration text is `" color:red"`, which does not match any hiding signature). This is recorded as an **incidental closure**, not claimed as this plan's own scope — WR-12 was explicitly named out-of-scope for this round as a finding.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-31*

## Self-Check: PASSED

- FOUND: `src/source/strip-hidden.ts`
- FOUND: `tests/strip-hidden.test.ts`
- FOUND: `.planning/phases/62-multi-inbox-email-ingest-hardening/62-20-SUMMARY.md`
- FOUND commit: `1d90eb2`
- FOUND commit: `daf0783`
- FOUND commit: `ba91c25`
