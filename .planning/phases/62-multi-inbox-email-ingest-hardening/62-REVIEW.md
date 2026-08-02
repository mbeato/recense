---
phase: 62-multi-inbox-email-ingest-hardening
reviewed: 2026-08-02T00:00:00Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - .github/workflows/ci.yml
  - package.json
  - src/source/gmail-adapter.ts
  - src/source/strip-hidden.ts
  - tests/css-liveness-differential.test.ts
  - tests/gmail-hidden-content.test.ts
  - tests/html-parser-conformance.test.ts
  - tests/html-wrapper-differential.test.ts
  - tests/strip-hidden.test.ts
  - tests/support/differential-helpers.ts
  - tests/support/html-render-oracle.ts
findings:
  critical: 0
  warning: 1
  info: 1
  total: 2
status: issues_found
---

# Phase 62 (round 7, waves 20-24, plans 62-26..62-31): Code Review Report

**Reviewed:** 2026-08-02T00:00:00Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

This round closes the phase's fifth verification failure for real. I rebuilt `dist/` fresh
(`npm run build`, exit 0) and independently re-executed every payload the wave-18 review and
pass-5 verification filed, plus a substantial set of adversarial variations I constructed myself
rather than trusting the SUMMARYs' claims:

- **CR-01** (`<style/>`, `<style />`, `<STYLE/>`, `<style type=a/>`) — all four now return `"ok"`,
  matching the plain-`<style>` control. `scanHtml`'s self-closing exception is gone entirely (not
  just for `style` — I confirmed self-closing syntax is now a no-op for `iframe`, `noembed`,
  `script`, `title` too, and correctly still renders content for self-closing `textarea`/`xmp`).
- **CR-02** — I measured the "many `<` + one removable construct" family myself, independent of
  the shipped test: 1k/4k/16k/64k/256k/1,048,576 code units resolve in 1.4/0.3/1.3/1.7/2.5/9.9 ms
  (element trigger) and 0.8/12.3 ms at 64k/1,048,576 (comment trigger) — no quadratic growth. I
  then tried to find a *different* pathological shape the fix might have missed (multi-block `<`
  runs each terminating in a real `>`, unbalanced-quote-in-hidden-element, many malformed
  quote-bearing close tags at scale up to 64k repeats): every variant stayed linear. The fix
  generalizes; it is not a point patch for the two reported triggers.
- **CR-03** (`<iframe>`, `<noembed>`, `<noframes>`) — all three now return `"ok"`.
- **WR-01** (stylesheet-in-never-applied-context) — re-verified for `<iframe>`, `<noscript>`,
  `<template>`, and additionally for two-level nesting and mixed-ancestor cases the shipped tests
  don't exercise (`<iframe><svg><style>`, `<svg><iframe><style>`, `<iframe><div><style>`,
  sibling top-level + iframe-nested styles together) — the fix generalizes correctly through
  nesting, not just the single-level shapes in the test file.
- **WR-08/WR-09/WR-10** — `mockRestore()` is now in a `finally`; `applyRemovalRanges` normalizes
  its own ranges (verified against the 500-trial randomized property test plus my own read of the
  sort/skip/monotonic-cursor logic); the close-tag scan is quote-aware and the WR-10 repro now
  returns `"tail"`.
- **WR-02/WR-04** (`tests/css-liveness-differential.test.ts`) — `attributeLeak` now re-runs both
  the oracle and production against a counterfactual with the named mechanism's shape edited out
  before crediting a leak; `it.fails` bodies now assert exactly one subject, with the oracle
  precondition split into its own passing `it`. Both genuinely closed, not just renamed.
- **WR-03** — `tests/html-wrapper-differential.test.ts` + `tests/support/html-render-oracle.ts`
  is a real, independent HTML-layer oracle: it imports `parse5`, never `htmlparser2` or `src/`,
  and its own SUMMARY records that it *found* CR-01/CR-03/WR-01 (18 divergences) against the
  unfixed module before any production fix landed — this is proof by construction, not an
  assertion I have to take on faith, and I confirmed the oracle's rendering rules (never-rendered
  tags, hidden-by-fixed-rule, RAWTEXT-is-rendered controls) are each independently derived from
  spec citations rather than copied from `strip-hidden.ts`'s own logic.
- **WR-06** — `npm run typecheck` now runs in CI (`.github/workflows/ci.yml:49-50`), after Build.
- **WR-05** — the file-level doc block is collapsed to current-state + changelog + a deletion
  registry, gated by a shipped, demonstrably non-vacuous guard (`tests/strip-hidden.test.ts`,
  the backtick-identifier-resolution test) that I traced through its eight resolution categories
  by hand; the guard's two "not vacuous" tests (injected fake identifier, injected undocumented
  deletion) are real, not decorative.
- **WR-07** — the four absolute wall-clock assertions are now calibration-relative (same-process
  reference-body ratio), in both `tests/gmail-hidden-content.test.ts` and
  `tests/html-parser-conformance.test.ts`.

All of that is genuine, and it answers the phase's standing question honestly for once: I could
not find a fourth instance of "two parts of the module hold different opinions about one
boundary" in the security-relevant surface. `RAWTEXT_ELEMENT_NAMES` is now the file's only
hand-maintained element-name list, and `NON_CONTENT_TAGS` / `NEVER_APPLIED_STYLESHEET_CONTEXT_TAGS`
/ `RAWTEXT_CLOSE_SLASH_RE` all derive from it with a compile-time exhaustiveness check plus a
shipped exact-membership test — I confirmed both halves are load-bearing, not just present, by
reading the exhaustiveness check's type signature and the membership test's own non-vacuousness
proof.

I did find one real, reproducible defect, but it is a documentation/maintainability regression,
not a leak: the stage-6 comment that is supposed to justify the CR-02 fix's generality now points
to a section of the file's own doc block that 62-31 deleted in the same round. This is the exact
"argument that they agree lives in prose" failure mode the phase has been fighting, recurring in
a syntactic shape (a quoted section-name cross-reference, not a backtick-quoted identifier) that
the round's own new anti-drift guard cannot see. See WR-01 below.

## Warnings

### WR-01: the stage-6 CR-02 comment cites a "full equivalence argument" section that 62-31 deleted in the same round — and the round's own anti-drift guard cannot see this class of drift

**File:** `src/source/strip-hidden.ts:1589-1590`

**Issue:** The stage-6 comment reads:

```
// `.replace()` pays for it; see the file-level "62-30 gap closure" doc block above for the
// full equivalence argument and the measured growth curve this closes.
```

There is no file-level "62-30 gap closure" section in the current file. I confirmed this two
ways:

1. `grep -n '62-30' src/source/strip-hidden.ts` returns exactly two hits: the stale comment
   itself (line 1590) and one line in the collapsed changelog (line 172,
   `- 62-30 (CR-02): hoists the stray-\`<\` fail-safe truncation a second time...`) — a one-line
   summary, not "the full equivalence argument and the measured growth curve."
2. `git show f234cdb -- src/source/strip-hidden.ts` (62-30's own commit) shows it added a
   multi-paragraph "62-30 gap closure" doc-block section, and this is the section the stage-6
   comment's cross-reference was written against. `git show eb402d3 -- src/source/strip-hidden.ts`
   (62-31's "collapse doc block" commit) shows that exact section being deleted (`-` lines) as
   part of 62-31's WR-05 doc-collapse work — but the cross-reference at the stage-6 call site was
   never updated to match.

This is not a leak — I independently re-measured the CR-02 fix (see Summary) and it is correct
and genuinely linear, including on shapes I constructed myself that the shipped test does not
cover. The defect is that the file's own claim about *why* the fix generalizes is no longer
readable from the file at all — it now exists only in `62-30-SUMMARY.md`, which a future
gap-closure round is not guaranteed to read (the phase's own recurring lesson is that per-plan
SUMMARYs are exactly where arguments go to be forgotten; that is why 62-31 was chartered to
collapse the doc block into the file in the first place).

It also directly undermines a specific claim made one file over:
`gmail-adapter.ts`'s `MAX_STRIP_INPUT_CODE_UNITS` doc comment states the cap's real invariant is
"that every stage inside `stripHiddenContent` is linear in aggregate (argued once per stage, **in
that file's own doc comments**)" — for stage 6, that argument is not in the file's doc comments
anymore; only a name for it is.

Finally, this is a second, structurally distinct instance of the exact drift class
`tests/strip-hidden.test.ts`'s new WR-05 guard (T-62-31-03) was built to catch — a comment
describing something that no longer exists — but it evades that guard by construction: the
guard's `BACKTICK_TOKEN_RE` only matches backtick-quoted tokens shaped like a JS/TS identifier
(`^[A-Za-z_$][A-Za-z0-9_$]*$`, further filtered to CONSTANT_CASE or camelCase-with-internal-capital).
`"62-30 gap closure"` is a double-quoted prose phrase with spaces and a hyphen — it can never match
that regex, so the guard that exists specifically to prevent this failure mode cannot see this
occurrence of it.

**Fix:** Either restore a short version of the argument inline at the stage-6 call site (a few
lines is enough — the equivalence to stage 0's Bound A, plus the measured growth-curve numbers
already quoted in the changelog entry), or change the cross-reference to point at something that
still exists (e.g. `see gmail-adapter.ts's MAX_STRIP_INPUT_CODE_UNITS doc comment, section 3, for
the re-derivation this closes` — which does still contain the growth-curve numbers). Separately,
consider widening the WR-05 guard's token-selection rule (or adding a second, narrower guard) to
also flag a quoted `"NN-NN ... "` plan-and-topic phrase that does not appear as a heading/anchor
anywhere else in the file — the guard already resolves cross-file identifiers by grepping the
target file (`isVerifiedExternalIdentifier`); the same discipline could apply to same-file section
cross-references.

## Info

### IN-01: `html-wrapper-differential.test.ts` shape 22's "reason" field describes attribute parsing incorrectly, though the test itself is not affected

**File:** `tests/html-wrapper-differential.test.ts:322-324`

**Issue:** Shape 22's reason string is *"tests that attribute-value parsing reads 'legal', not
'legal/'"*. Per HTML §13.2.5.36 (attribute value, unquoted state), `/` has no special meaning
inside an unquoted attribute value — it is appended to the value like any other character. I
confirmed this directly against `parse5` (the file's own chosen ground truth):
`parseFragment('<span class=legal/>X</span>')` parses the attribute as `class="legal/"`, not
`class="legal"`. `htmlparser2` (production) agrees — I confirmed `stripHiddenContent` treats the
span's class as `legal/`, so it does **not** match a harvested `.legal` selector and the payload
correctly stays visible (`"VISIBLEPAYLOAD"`), which is the same verdict the oracle reaches for the
same reason. The test itself passes and is not wrong — both sides agree the trailing slash is part
of the value — but the "reason" comment asserts the opposite of what a conformant parser (and this
file's own oracle) actually does, which will mislead a future maintainer who reads the comment
without re-deriving the behavior.

**Fix:** Correct the reason string to something like: *"Unquoted attribute value ending in '/'
immediately before '>' — a conformant parser reads the value as 'legal/', not 'legal' (the `/`
has no special meaning inside an unquoted attribute value, HTML §13.2.5.36); this shape confirms
oracle and production agree that the class does NOT match the bare '.legal' selector."*

---

_Reviewed: 2026-08-02T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
