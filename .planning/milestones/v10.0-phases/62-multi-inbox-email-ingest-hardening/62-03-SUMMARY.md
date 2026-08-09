---
phase: 62-multi-inbox-email-ingest-hardening
plan: 03
subsystem: ingest
tags: [gmail, security, injection, strip-hidden, ingest]

# Dependency graph
requires: [62-01]
provides:
  - "stripHiddenContent(text) — pure, deterministic, idempotent, LLM-free markup + hidden-content stripper (src/source/strip-hidden.ts)"
  - "normalizeGmailMessage applies stripHiddenContent to raw.bodyText before the provenance header is joined and before redactSecrets"
  - "Named regression fixture tests/fixtures/gmail-hidden-injection.html — HTML-only email with three hidden payload shapes"
affects: [63]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Compile-once regex registry (module-scope constants) mirroring redact.ts's discipline; zero imports in strip-hidden.ts"
    - "Removal-by-range: collectRemovalRanges scans start tags matching a predicate, applyRemovalRanges deletes the matched spans — shared by non-content-element removal (stage 4) and hidden-element removal (stage 5)"
    - "Extract-then-parseFloat for zero-valued CSS properties (opacity/font-size/height/width) instead of a pure regex boundary trick, avoiding the opacity:0 vs opacity:0.85 false positive"
    - "Fail-safe-to-end-of-string on any unterminated construct (comment, non-content element, hidden element) — monotone toward less content, never raw passthrough"

key-files:
  created:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts
    - tests/gmail-hidden-content.test.ts
    - tests/fixtures/gmail-hidden-injection.html
  modified:
    - src/source/gmail-adapter.ts

key-decisions:
  - "Stage order is load-bearing and documented in the file's doc block: invisible-codepoint removal runs FIRST so zero-width obfuscation (dis<ZWSP>play:none) cannot evade the stage-5 hiding-signature matcher; CSS class/id hiding-selector harvest runs BEFORE <style> blocks are discarded so class-hidden spans aren't orphaned evidence."
  - "Zero-valued CSS properties (opacity/font-size/height/max-height/width/max-width) are checked by extracting the numeric value and comparing with parseFloat(...) === 0, not a regex boundary trick — this is what correctly distinguishes opacity:0 (hidden) from opacity:0.85 (kept)."
  - "The forward matching-close-tag scan and the non-content/hidden-element removal scan share one generic mechanism (collectRemovalRanges + findMatchingCloseEnd) parameterized by a shouldRemove predicate, keeping only two runtime-tag-name-agnostic regexes (START_TAG_RE, ANY_TAG_TOKEN_RE) doing all the structural matching."
  - "stripHiddenContent runs on raw.bodyText ONLY, not the provenance header, and BEFORE redactSecrets — both ordering decisions are recorded as comments in normalizeGmailMessage and the second is enforced by a source-order regression test."
  - "stripHiddenContent is deliberately NOT called from src/ingest/pipeline.ts — that pass is source-agnostic and stripping would destroy legitimate Markdown/formatting in Obsidian or transcript content. It is a Gmail-adapter-boundary concern only."

requirements-completed: [EMAIL-03]

# Metrics
duration: ~35min
completed: 2026-07-29
---

# Phase 62 Plan 03: Deterministic Hidden-Content Stripping at the Gmail Ingest Boundary Summary

**A pure, dependency-free, compile-once-regex `stripHiddenContent` pipeline removes markup, CSS/attribute-hidden elements, and invisible Unicode from every Gmail body before it reaches the extractor — closing the raw-HTML-fallback indirect-injection vector `extractBodyText` opened for HTML-only (ATS-style) emails.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-29
- **Tasks:** 2 (both `type="auto"`, no checkpoints)
- **Files modified:** 1 (+4 new: 1 source module, 2 test files, 1 fixture)

## Accomplishments

- `extractBodyText`'s raw-HTML fallback (`src/source/gmail-adapter.ts:99-117`) no longer hands hidden/injected content straight to the sleep-pass classifier — this closes the hard prerequisite EMAIL-03 named for Phase 63 (classification is the first LLM consumer of this content an attacker can actually steer).
- The stripper is a self-contained, 8-stage, module-scope-compiled, zero-import string pipeline: invisible-codepoint removal, CSS hiding-selector harvest, comment removal, non-content-element removal, hidden-element removal, remaining-tag removal, minimal `&nbsp;` decoding, and paragraph-preserving whitespace normalization.
- Every enumerated hiding signature from the plan is implemented and test-covered: `display:none`, `visibility:hidden`/`collapse`, exactly-zero `opacity`/`font-size`/`height`/`max-height`/`width`/`max-width`, negative `text-indent`, off-canvas `left`/`top` (3+ digit negative), `clip:rect(0`, `clip-path:inset(100%`, the bare boolean `hidden` attribute, `aria-hidden="true"`, and class/id names harvested from a `<style>` block's hiding rules.
- Zero-width Unicode (U+200B-U+200D, U+2060, U+FEFF, U+00AD, U+180E, U+2061-U+2064) and the entire Unicode Tags block (U+E0000-U+E007F) are stripped unconditionally, including from plain text, and the removal runs first specifically so a `dis<ZWSP>play:none` obfuscation attempt cannot evade the stage-5 hiding-signature matcher — a dedicated test proves this.
- Malformed/adversarial input (unterminated comment, unterminated hidden div, unterminated `<script`) is fail-safe: every unterminated construct deletes to end of string rather than passing raw content through. Totality is proven against empty string, a lone `<`/`>`, 10 KB of nested unclosed divs, and a 5000-selector `<style>` block — all complete without throwing.
- The named regression fixture (`tests/fixtures/gmail-hidden-injection.html`) carries three distinct hidden-payload shapes (a `display:none` div, a `<style>`-class-hidden span, and a zero-width-joined "THIRD" fragment inside a hidden inline span) plus legitimate visible prose, a link, and a table wrapper; `tests/gmail-hidden-content.test.ts` proves none of the three payloads, no stray `U+200B`, and no surviving markup reach `NormalizedRecord.content`, while the visible sentence and provenance header do.

## Task Commits

Each task was committed atomically:

1. **Task 1: stripHiddenContent — the deterministic, idempotent, fail-safe stripper** — `6d78e1a` (feat)
2. **Task 2: Apply unconditionally in normalizeGmailMessage + the named EMAIL-03 regression fixture** — `c33b49c` (feat)

**Plan metadata:** (this SUMMARY commit, made by the orchestrator/executor immediately after this file)

## Files Created/Modified

- `src/source/strip-hidden.ts` (new, 420 lines) — `stripHiddenContent(text: string): string`. Imports nothing. Full hiding-signature registry, CSS class/id harvest (capped at 200 selectors), shared removal-by-range mechanism for stages 4/5, minimal entity decoding, paragraph-preserving whitespace normalization. File-level doc block enumerates what's stripped/kept and names both accepted residual risks.
- `tests/strip-hidden.test.ts` (new) — 37 tests: every named hiding shape, no-false-positive KEEP cases (`opacity:0.85`, `font-size:14px`), CSS class/id harvest, zero-width + Tags-block removal (incl. the `dis<ZWSP>play:none` obfuscation case), nested-same-name matching-close scanning, fail-safe unterminated-markup truncation, entity handling (`&nbsp;` decoded, `&amp;` literal + idempotent), plain-text byte-identical passthrough, an idempotence property test over 10 fixtures, and totality against empty/malformed/pathological input.
- `src/source/gmail-adapter.ts` (modified) — imports `stripHiddenContent`; `normalizeGmailMessage` strips `raw.bodyText` before joining the provenance header and before `redactSecrets`; corrected `extractBodyText`'s misleading fallback comment; added an EMAIL-03 note to the file-level decision block; documented both ordering decisions (strip-before-redact, body-only-not-header) as inline comments.
- `tests/fixtures/gmail-hidden-injection.html` (new) — the named regression fixture: HTML-only body with a `<style>.legal{display:none}</style>` block, a `display:none` div payload, a `class="legal"` span payload, a zero-width-joined "THIRD" fragment inside a hidden inline span, a normal link, and a table layout wrapper, alongside the required visible sentence.
- `tests/gmail-hidden-content.test.ts` (new) — 10 tests: all three payloads absent, no stray `U+200B`, no surviving markup, visible sentence present, provenance header shape intact, `origin==='observed'` untouched, an all-hidden body degrades to header-only content, determinism across repeated calls, and a source-order regression lock (`stripHiddenContent` call precedes `redactSecrets` call in `gmail-adapter.ts`'s source text).

## Decisions Made

- Zero-valued CSS properties are checked via numeric extraction + `parseFloat(...) === 0`, not a pure regex lookahead — this is the only reliable way to keep `opacity:0.85`/`font-size:14px` while removing `opacity:0`/`font-size:0`.
- The stage-4 (non-content element) and stage-5 (hidden element) removal logic share one generic `collectRemovalRanges`/`findMatchingCloseEnd` mechanism, parameterized by a `shouldRemove(tagName, attrs)` predicate. This keeps only two tag-name-agnostic regexes (`START_TAG_RE`, `ANY_TAG_TOKEN_RE`) doing all structural tag matching, since the matched tag name is runtime data from untrusted input and cannot be precompiled ahead of time the way the fixed hiding-signature registry can be.
- `stripHiddenContent` is applied to `raw.bodyText` only, never to the provenance header, and strictly before `redactSecrets` — both decisions are recorded as inline comments in `normalizeGmailMessage`, and the strip-before-redact ordering is additionally enforced by a source-order regression test (not just a comment), per the plan's explicit instruction to encode the ordering as a test.
- `stripHiddenContent` is deliberately NOT wired into `src/ingest/pipeline.ts`'s source-agnostic second `redactSecrets` pass — stripping markup there would corrupt legitimate Markdown/formatting from Obsidian or transcript sources. This keeps the invariant enforced at exactly one site (the Gmail adapter boundary).

## Accepted Named Residual Risks (NOT closed by this plan)

Per the plan's threat model (T-62-22, disposition `accept`) and the honest-null convention, these two hiding shapes are explicitly NOT detected and must not be claimed as covered:

1. **White-text-on-white-background hiding** — not detected. A color-only heuristic would drop legitimate dark-mode-styled prose, trading an injection risk for a classification-accuracy regression.
2. **Hiding via an externally-linked stylesheet** — not detected. recense never fetches remote resources during ingest, and not fetching is the correct posture.

Both are named explicitly in `src/source/strip-hidden.ts`'s file-level doc block.

## Deviations from Plan

None — plan executed exactly as written. Regex design choices (extract-then-parseFloat for zero-value CSS properties, the shared removal-by-range mechanism, the manual construction of the fixture's zero-width fragment via a generation script to guarantee exact codepoint placement) were implementation details within the plan's explicit specification, not deviations from it.

## Issues Encountered

None.

## Verification Results

- `npx tsc --noEmit` — exits 0.
- `npx vitest run tests/strip-hidden.test.ts` — 37/37 pass.
- `npx vitest run tests/gmail-hidden-content.test.ts tests/gmail-adapter.test.ts tests/gmail-adapter-multiaccount.test.ts tests/strip-hidden.test.ts` — 76/76 pass.
- `npx vitest run tests/gmail-adapter.test.ts tests/gmail-adapter-multiaccount.test.ts tests/redact.test.ts` — 53/53 pass, zero pre-existing assertion edits.
- `grep -n "stripHiddenContent" src/source/gmail-adapter.ts` — shows the import and exactly one call site (`stripHiddenContent(raw.bodyText)`) inside `normalizeGmailMessage`.
- `git diff --stat src/ingest/pipeline.ts src/source/redact.ts` — empty; neither file was modified.
- `git diff --stat package.json` — empty; net-zero new runtime dependencies.
- **Full suite `npx vitest run`:**
  - **Pre-plan baseline** (this plan's parent commit `d410a49`, i.e. 62-01's post-plan state per `62-01-SUMMARY.md`): **23 failed / 2710 passed / 9 skipped.**
  - **Post-plan (this branch, after both tasks):** **23 failed / 2757 passed / 9 skipped.**
  - **Diff:** the same 23 pre-existing failures in both runs — all subprocess-spawning CLI tests (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`), environment-flaky and unrelated to any file this plan touched. **Zero new failures.** The +47 passed delta is exactly the two new test files added by this plan (37 in `strip-hidden.test.ts` + 10 in `gmail-hidden-content.test.ts`).

## User Setup Required

None — no external service configuration required; this is a pure code change to an existing offline/online boundary.

## Next Phase Readiness

- EMAIL-03 is closed. Phase 63 (Offline Intent Classification) can proceed against Gmail episode content that is guaranteed markup-free and hidden-content-free, satisfying its stated hard prerequisite.
- The two accepted named residual risks (white-on-white, external stylesheet) are recorded here and in the module's own doc block for Phase 63 (or any future hardening pass) to reference without re-discovering them as "surprises."
- No blockers for plan 62-04 or 62-05 — this plan's file set (`src/source/strip-hidden.ts`, `src/source/gmail-adapter.ts`, its own tests/fixture) is disjoint from 62-02's declared files (`src/adapter/gmail-auth-cli.ts`, `src/adapter/recense.ts`).

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-29*
