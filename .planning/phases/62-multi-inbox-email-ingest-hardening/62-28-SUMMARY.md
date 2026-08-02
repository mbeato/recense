---
phase: 62-multi-inbox-email-ingest-hardening
plan: 28
subsystem: testing
tags: [parse5, html-differential, differential-testing, oracle-independence, WR-03, EMAIL-03]

# Dependency graph
requires:
  - phase: 62 (plan 26)
    provides: "parse5@7.3.0 exact-pinned devDependency + the <style/> real-element probe evidence this plan's oracle is built on"
  - phase: 62 (plan 27)
    provides: "tests/css-liveness-differential.test.ts's own marker/gate house convention (classMarker/idMarker/throwIfFailures), extracted here into the shared module"
provides:
  - "tests/support/html-render-oracle.ts — a parse5-derived rendered-text oracle for a FIXED hiding rule, importing neither src/ nor htmlparser2"
  - "tests/html-wrapper-differential.test.ts — a 22-shape HTML-wrapper alphabet crossed against {class,id} probes and {inside,after} payload placement (88 cases), hard-gated"
  - "tests/support/differential-helpers.ts — the ONE definition site for classMarker/idMarker/throwIfFailures, imported by both differentials"
  - "The verbatim pre-fix divergence report: this differential independently rediscovered CR-01 (8), CR-03 (6), and WR-01 (4) — 18 divergences total — before any of this round's fixes landed"
affects: [62-29, 62-30, future gap-closure rounds touching the HTML layer of src/source/strip-hidden.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fixed-CSS / varied-HTML differential: collapsing the CSS axis to one literal, whitespace-insensitive rule (.legal{display:none} / #legal{display:none}) turns every remaining degree of freedom into an HTML-layer question, adjudicated by a parser (parse5) production does not consume (htmlparser2) — the same oracle-independence discipline WR-09 already forced onto the CSS-tokenizer layer, applied one layer up"
    - "Shape-id-keyed, temporary named mechanisms (HF-*): a divergence is excused from the hard gate only if it matches a SHAPE ID a named predicate declares, never a substring of the input — and every predicate's doc comment names its owning plan and is written to be deleted, not to accumulate"
    - "Extract-not-copy shared test helpers: classMarker/idMarker/throwIfFailures now have exactly one definition site (tests/support/differential-helpers.ts), imported by both oracle-driven differentials"

key-files:
  created:
    - tests/support/html-render-oracle.ts
    - tests/html-wrapper-differential.test.ts
    - tests/support/differential-helpers.ts
  modified:
    - tests/css-liveness-differential.test.ts

key-decisions:
  - "The {inside, after} payload-placement axis is interpreted per shape family rather than as one universal template: for style-only shapes (1-9) 'inside' embeds the probe span as inert RAWTEXT before the (possibly malformed) close sequence — a control proving text embedded in <style>'s own body never becomes a real element; for RAWTEXT-container shapes (10-15) 'inside' is the literal PAYLOAD-embedded-in-the-tag shape and 'after' is an empty-tag-then-sibling-marker boundary control; for container-wrapping-style shapes (16-18) 'after' is the canonical WR-01 over-strip test (probe span outside the container) and 'inside' tests whether container-nested content ever leaks at all; for structural shapes (19, 22) 'inside' nests the probe one level deeper in a neutral <div>; shapes 8, 20, 21 collapse the two placements to one or two clearly-labeled variants where a second, distinct placement has no natural meaning (documented per-shape in the alphabet table's own reason field)"
  - "Shape 21 (WR-10) was adapted to also carry class=\"legal\"/id=\"legal\" alongside its original inline style=\"display:none\", because this oracle's stated blind spot (no inline-style-attribute modeling) would otherwise make the shape un-adjudicable by the fixed-rule oracle; the adaptation preserves WR-10's original close-tag-garbage-byte-survival shape while making the hiding half judgeable"
  - "No new HF-* mechanism was needed beyond HF-01/HF-02/HF-03: the full 88-case run (22 shapes x 2 probe kinds x 2 placements) against the unfixed module produced exactly 18 divergences, all falling cleanly into the three named families predicted by 62-VERIFICATION.md's CR-01/CR-03/WR-01 findings — including shape 7 (the RAWTEXT close-slash defect, a candidate for a NEW mechanism) which turned out to already agree between oracle and production (strip-hidden.ts carries its own hand-rolled fallback for this exact shape per D-62-21-01, confirmed correct, not a leak)"

requirements-completed: [EMAIL-03]

# Metrics
duration: ~25min
completed: 2026-08-02
---

# Phase 62 Plan 28: HTML-Wrapper Differential Against a Fixed Hiding Rule (WR-03 Closure) Summary

**Built the missing HTML-layer oracle (parse5-derived, `htmlparser2`-independent) and a 22-shape wrapper differential that, run against the unfixed module, independently rediscovered CR-01 (8 divergences), CR-03 (6 divergences) and WR-01 (4 divergences) on its own — then hard-gated the file so any OTHER HTML-layer divergence fails the suite outright.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-02T17:00:00Z (base commit `0bb2653`)
- **Completed:** 2026-08-02T17:20:00Z
- **Tasks:** 3
- **Files modified:** 4 (`tests/support/html-render-oracle.ts`, `tests/support/differential-helpers.ts`, `tests/html-wrapper-differential.test.ts` created; `tests/css-liveness-differential.test.ts` modified) — matches the plan's declared `files_modified` exactly

## Accomplishments

- WR-03 closed: an HTML-wrapper divergence between production (`htmlparser2`) and a conformant browser (`parse5`-derived ground truth) is now detectable by a shipped, hard-gated test
- The differential's non-vacuousness is demonstrated, not argued: run against the unfixed module at HEAD `0bb2653`, it independently rediscovered CR-01, CR-03 and WR-01's exact shapes, with zero unexpected/unnamed divergences elsewhere across 88 cases
- `classMarker`/`idMarker`/`throwIfFailures` extracted to `tests/support/differential-helpers.ts` — exactly 3 definition sites repo-wide, both differentials importing from the one shared module; CSS differential's own per-mechanism exact counts confirmed unchanged by the extraction
- The gate is proven to genuinely block (not merely pass because everything found a name) by a live injection proof, recorded verbatim below, injector removed before commit

## Task Commits

1. **Task 1: parse5-derived rendered-text oracle for a fixed hiding rule** — `6690fba` (test)
2. **Task 2: HTML-wrapper generator — run it against the unfixed module and record what it finds** — `39a09d9` (test)
3. **Task 3: Hard-gate the differential, name the open families, and prove the gate blocks** — `47062fc` (fix)

_Note: this SUMMARY's own commit follows as plan metadata (orchestrator-owned STATE.md/ROADMAP.md updates are out of scope for this executor per instructions)._

## Files Created/Modified

- `tests/support/html-render-oracle.ts` — `renderedText(html)` walks a `parse5.parseFragment` tree in two passes (collect applied stylesheet text, then accumulate rendered prose), applying the ONE fixed rule (`.legal{display:none}` / `#legal{display:none}`, whitespace-insensitive literal match) and naming every never-rendered tag (`script`/`style`/`head`/`title`/`template`/`noscript`/`svg`/`iframe`/`noembed`/`noframes`) with its HTML-spec citation. Imports neither `src/` nor `htmlparser2` (asserted by grep). States its blind spots explicitly (literal-only stylesheet check, SVG's own text-rendering model, parse5's known non-totality).
- `tests/support/differential-helpers.ts` — the ONE definition site for `classMarker`, `idMarker`, `throwIfFailures`, extracted from `tests/css-liveness-differential.test.ts` and imported by both differentials.
- `tests/html-wrapper-differential.test.ts` — the 22-shape wrapper alphabet (table below), the generator (every shape x `{class,id}` x `{inside,after}` = 88 cases), the three named/temporary `HF-*` mechanisms with exact counts and minimal `it.fails` locks, and the full header doc comment (WR-03 gap, fixed-CSS/varied-HTML rationale, parse5-vs-htmlparser2 independence, shipped counts, "fixes no leak" disclaimer).
- `tests/css-liveness-differential.test.ts` — `classMarker`/`idMarker`/`throwIfFailures` removed (now imported from `tests/support/differential-helpers.ts`); no other line changed.

## The 22-Shape Alphabet

| # | Template | Reason |
|---|---|---|
| 1 | `<style>CSS</style>` | Control — the ordinary, well-formed style wrapper; must be correct today |
| 2 | `<style/>CSS</style>` | CR-01 a — self-closing start-tag syntax on style (HTML §13.2.5: a spec-correct no-op) |
| 3 | `<style />CSS</style>` | CR-01 b — self-closing syntax with a space before the slash |
| 4 | `<STYLE/>CSS</STYLE>` | CR-01 c — self-closing syntax, case-insensitive tag name |
| 5 | `<style type=a/>CSS</style>` | CR-01 d — self-closing syntax on any unquoted attribute ending in "/" |
| 6 | `<style>CSS</style foo>` | D-62-21-01 — RAWTEXT close-tag residual (trailing garbage before the close tag's own ">") |
| 7 | `<style>CSS</style/>` | RAWTEXT close-slash defect — htmlparser2's own measured deviation (does NOT close) |
| 8 | `<style>CSS` | Unterminated to EOF — inside/after collapse (nothing exists "after" an EOF-terminated element) |
| 9 | `<!--<style>--><style>CSS</style>` | CR-10 regression lock — only the second `<style>` is a real element |
| 10 | `<iframe>PAYLOAD</iframe>` | CR-03 — iframe fallback content, never rendered by any modern browser |
| 11 | `<noembed>PAYLOAD</noembed>` | CR-03 — noembed fallback content, obsolete and never rendered |
| 12 | `<noframes>PAYLOAD</noframes>` | CR-03 — noframes fallback content, obsolete and never rendered |
| 13 | `<xmp>PAYLOAD</xmp>` | Over-strip control — xmp IS rendered by every browser |
| 14 | `<textarea>PAYLOAD</textarea>` | Over-strip control — textarea IS rendered |
| 15 | `<template>PAYLOAD</template>` | Inert — template content is never part of the rendered document (HTML §4.12.3) |
| 16 | `<noscript><style>CSS</style></noscript>` | WR-01 — a stylesheet nested in a never-rendered container must never apply outside it |
| 17 | `<iframe><style>CSS</style></iframe>` | WR-01 — same mechanism as shape 16, iframe container |
| 18 | `<svg><style>CSS</style></svg>` | Inline SVG shares the host document's CSSOM — genuinely different container semantics |
| 19 | `class="leg&#97;l"` / `id="leg&#97;l"` | Entity-encoded selector value — HTML §13.2.5.72 decodes before comparison |
| 20 | `<p>VISIBLE_SENTENCE<p>PAYLOAD` | Implied-close siblings — HTML's implicit `</p>` insertion rule |
| 21 | `<div style="display:none">PAYLOAD</div foo="a>b">tail` | WR-10 — quote-unaware close-tag scan; adapted with class/id="legal" so the oracle can adjudicate the hiding half |
| 22 | `<span class=legal/>PAYLOAD</span>` | Unquoted attribute value ending in "/" immediately before ">" |

All 22 shapes crossed against `{class, id}` probes and `{inside, after}` placement = 88 generated cases (`WRAPPER_SHAPES.length * 2 * 2`, asserted in the test file).

## The Verbatim Pre-Fix Divergence Report

Run at commit `6690fba` (Task 1's commit — `src/source/strip-hidden.ts` is byte-identical to this plan's base commit `0bb2653` throughout the entire plan; re-confirmed via `git status --porcelain src/` after every subsequent commit) against the shipped, UNFIXED module, via:

```
npx tsx <throwaway probe replicating the generator's exact logic — the committed
  generator itself, tests/html-wrapper-differential.test.ts, produces the identical
  report when run as `npx vitest run tests/html-wrapper-differential.test.ts` at
  Task 2's commit 39a09d9, before Task 3's HF-* classification was added>
```

```
caseCount=88 oracleUnavailable=0 failures=18

[1] UNDER-STRIP -- shape=2 probe=class placement=after html="<style/>.legal{display:none}</style>VISIBLE_SENTENCE<span class=\"legal\">PL[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPL[legal]"

[2] UNDER-STRIP -- shape=2 probe=id placement=after html="<style/>#legal{display:none}</style>VISIBLE_SENTENCE<span id=\"legal\">PLID[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPLID[legal]"

[3] UNDER-STRIP -- shape=3 probe=class placement=after html="<style />.legal{display:none}</style>VISIBLE_SENTENCE<span class=\"legal\">PL[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPL[legal]"

[4] UNDER-STRIP -- shape=3 probe=id placement=after html="<style />#legal{display:none}</style>VISIBLE_SENTENCE<span id=\"legal\">PLID[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPLID[legal]"

[5] UNDER-STRIP -- shape=4 probe=class placement=after html="<STYLE/>.legal{display:none}</STYLE>VISIBLE_SENTENCE<span class=\"legal\">PL[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPL[legal]"

[6] UNDER-STRIP -- shape=4 probe=id placement=after html="<STYLE/>#legal{display:none}</STYLE>VISIBLE_SENTENCE<span id=\"legal\">PLID[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPLID[legal]"

[7] UNDER-STRIP -- shape=5 probe=class placement=after html="<style type=a/>.legal{display:none}</style>VISIBLE_SENTENCE<span class=\"legal\">PL[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPL[legal]"

[8] UNDER-STRIP -- shape=5 probe=id placement=after html="<style type=a/>#legal{display:none}</style>VISIBLE_SENTENCE<span id=\"legal\">PLID[legal]</span>" oracle="VISIBLE_SENTENCE" out="VISIBLE_SENTENCEPLID[legal]"

[9] UNDER-STRIP -- shape=10 probe=class placement=inside html="<iframe>PL[legal]</iframe>VISIBLE_SENTENCE" oracle="VISIBLE_SENTENCE" out="PL[legal]VISIBLE_SENTENCE"

[10] UNDER-STRIP -- shape=10 probe=id placement=inside html="<iframe>PLID[legal]</iframe>VISIBLE_SENTENCE" oracle="VISIBLE_SENTENCE" out="PLID[legal]VISIBLE_SENTENCE"

[11] UNDER-STRIP -- shape=11 probe=class placement=inside html="<noembed>PL[legal]</noembed>VISIBLE_SENTENCE" oracle="VISIBLE_SENTENCE" out="PL[legal]VISIBLE_SENTENCE"

[12] UNDER-STRIP -- shape=11 probe=id placement=inside html="<noembed>PLID[legal]</noembed>VISIBLE_SENTENCE" oracle="VISIBLE_SENTENCE" out="PLID[legal]VISIBLE_SENTENCE"

[13] UNDER-STRIP -- shape=12 probe=class placement=inside html="<noframes>PL[legal]</noframes>VISIBLE_SENTENCE" oracle="VISIBLE_SENTENCE" out="PL[legal]VISIBLE_SENTENCE"

[14] UNDER-STRIP -- shape=12 probe=id placement=inside html="<noframes>PLID[legal]</noframes>VISIBLE_SENTENCE" oracle="VISIBLE_SENTENCE" out="PLID[legal]VISIBLE_SENTENCE"

[15] OVER-STRIP -- shape=16 probe=class placement=after html="<noscript><style>.legal{display:none}</style></noscript>VISIBLE_SENTENCE<span class=\"legal\">PL[legal]</span>" oracle="VISIBLE_SENTENCEPL[legal]" out="VISIBLE_SENTENCE"

[16] OVER-STRIP -- shape=16 probe=id placement=after html="<noscript><style>#legal{display:none}</style></noscript>VISIBLE_SENTENCE<span id=\"legal\">PLID[legal]</span>" oracle="VISIBLE_SENTENCEPLID[legal]" out="VISIBLE_SENTENCE"

[17] OVER-STRIP -- shape=17 probe=class placement=after html="<iframe><style>.legal{display:none}</style></iframe>VISIBLE_SENTENCE<span class=\"legal\">PL[legal]</span>" oracle="VISIBLE_SENTENCEPL[legal]" out="VISIBLE_SENTENCE"

[18] OVER-STRIP -- shape=17 probe=id placement=after html="<iframe><style>#legal{display:none}</style></iframe>VISIBLE_SENTENCE<span id=\"legal\">PLID[legal]</span>" oracle="VISIBLE_SENTENCEPLID[legal]" out="VISIBLE_SENTENCE"
```

This is exactly the set the plan's own acceptance criterion requires: an UNDER-STRIP divergence for shapes 2, 3, 4, 5 with shape 1 (the control) diverging on NONE of them, and an UNDER-STRIP divergence for shapes 10, 11, 12 — plus the OVER-STRIP family (16, 17) the differential also independently found. Zero divergences appeared anywhere else in the 88-case run (shapes 1, 6, 7, 8, 9, 13, 14, 15, 18, 19, 20, 21, 22, and the "inside" placement of shapes 2-5, and the "after"-boundary placement of shapes 10-12, all agreed between oracle and production).

**Notable non-finding:** shape 7 (`</style/>`, the RAWTEXT close-slash defect htmlparser2 is independently known to mishandle per `tests/html-parser-conformance.test.ts`) produced NO divergence. Production's own hand-rolled fallback for this exact shape (named D-62-21-01 in that file's header) correctly agrees with the oracle — confirmed, not merely assumed, by this differential actually exercising it.

## Per-Mechanism Exact Counts

| Mechanism | Shapes | Direction | Count | Owner |
|---|---|---|---|---|
| `HF01_selfClosingStyleExcludedFromHarvest` | 2, 3, 4, 5 | UNDER-STRIP | 8 | 62-29 (CR-01) |
| `HF02_rawtextFallbackEmittedVerbatim` | 10, 11, 12 | UNDER-STRIP | 6 | 62-29 (CR-03) |
| `HF03_neverAppliedStylesheetStillHarvested` | 16, 17 | OVER-STRIP | 4 | 62-30 (WR-01) |

8 + 6 + 4 = 18, matching the pre-fix report above exactly. No `toBeLessThan` anywhere in the file (`grep -c toBeLessThan tests/html-wrapper-differential.test.ts` = 0) — every count above is an exact assertion (`toBe`), and every OTHER divergence (matching no named shape id) reaches `failures` and throws.

**CSS differential's own counts, confirmed unchanged by the `classMarker`/`idMarker`/`throwIfFailures` extraction** (before = 62-27's recorded values, after = re-measured this plan): Generator 1 `NF01=86/NF03=10/NF04=1/NF05=16/NF06=0/NFSAFE=50`; Generator 2 `NF01=1921/NF03=51/NF04=9/NF05=461/NF06=2/NFSAFE=1768`; Generator 3 `NF01=407/NF03=0/NF04=0/NF05=277/NF06=0/NFSAFE=358` — identical before/after (`npx vitest run tests/css-liveness-differential.test.ts`: 16 passed | 5 expected fail, both before and after the extraction).

## Injection Proof (Task 3 Acceptance Criterion)

Temporarily edited `tests/html-wrapper-differential.test.ts` to force shape 1 (the control — owned by no `HF-*` mechanism) to leak its marker regardless of the oracle's verdict:

```ts
let out = stripHiddenContent(html);
if (shape.id === 1 && probeKind === 'class' && placement === 'after') {
  out = out + marker; // INJECTED FOR PROOF ONLY
}
```

Ran `npx vitest run tests/html-wrapper-differential.test.ts`:

```
 ❯ tests/html-wrapper-differential.test.ts (18 tests | 1 failed) 15ms
     × every shape x {class,id} x {inside,after} case: only the three named, temporary mechanisms diverge, with exact shipped counts 8ms

 FAIL  tests/html-wrapper-differential.test.ts > html-wrapper-differential — HTML-wrapper generator vs a fixed hiding rule > every shape x {class,id} x {inside,after} case: only the three named, temporary mechanisms diverge, with exact shipped counts
Error: html-wrapper-differential: 1 unclassified divergence(s) found. First 1:

UNDER-STRIP — shape=1 (Control — the ordinary, well-formed style wrapper; must be correct today.) probe=class placement=after generating html="<style>.legal{display:none}</style>VISIBLE_SENTENCE<span class=\"legal\">PL[legal]</span>" oracle text="VISIBLE_SENTENCE" observed output="VISIBLE_SENTENCEPL[legal]"

 Test Files  1 failed (1)
      Tests  1 failed | 14 passed | 3 expected fail (18)
```

Removed the injector, re-ran: `Test Files 1 passed (1)`, `Tests 15 passed | 3 expected fail (18)`. `git status --porcelain` / `git diff --stat tests/html-wrapper-differential.test.ts` confirmed clean (zero diff) before committing Task 3 — the injector was never committed. This proves the gate genuinely blocks an unnamed divergence rather than passing because every real divergence happened to find a name.

## The Oracle's Stated Blind Spots (`tests/support/html-render-oracle.ts`)

1. The stylesheet-applied check is a whitespace-insensitive LITERAL substring scan, not a CSS parser — a semantically-equivalent but non-literal rule (e.g. `.legal{color:red;display:none}`) is not recognized.
2. SVG's own rendering model (some SVG constructs, e.g. `<text>`, DO render) is not modeled — this oracle treats ALL text inside `<svg>` as non-rendered, an over-approximation.
3. parse5's own known non-totality (62-21 Task 2's "C3" finding) — a throw sets `oracleUnavailable: true` (measured at exactly 0 across this alphabet) and is never swallowed into a normal verdict.
4. No inline `style="..."` attribute, `visibility`/`opacity`/geometry-based hiding, or any hiding mechanism other than the two fixed selector rules is recognized (deliberate — the fixed rule needs none of it).

## Decisions Made

See `key-decisions` in frontmatter. Summarized: (1) the `{inside,after}` placement axis is interpreted per shape family, not as one universal template, with each shape's own `reason` field documenting the interpretation; (2) shape 21 (WR-10) was adapted to also carry `class`/`id="legal"` so the fixed-rule oracle — which deliberately does not model inline `style` attributes — can still adjudicate its hiding half while preserving the original close-tag-garbage-byte shape; (3) no fourth `HF-*` mechanism was needed — the 88-case run cleanly matched the three families 62-VERIFICATION.md predicted, with shape 7 (RAWTEXT close-slash) confirmed as a genuine non-finding rather than a gap.

## Deviations from Plan

None — plan executed exactly as written, including its own explicit design (Task 2 produces a RED, unclassified-divergence report; Task 3 adds the `HF-*` classification and the gate).

## Issues Encountered

`node_modules` was missing in this worktree (parse5 was added to `package.json`/`package-lock.json` by 62-26 in an earlier wave, but this worktree had never run `npm install`); ran `npm install` before any work, confirmed `npm run typecheck` clean at baseline before making any changes. Also needed `npm run build` before `npx vitest run` (several unrelated CLI-spawning tests — `adapter-capture`, `adapter-inject`, `locomo-*`, `eval-harness-smoke` — depend on a fresh `dist/`; `npm test`'s own `pretest` hook runs the build automatically, but a direct `npx vitest run` does not). Neither is a deviation from this plan's own scope — both are prerequisite housekeeping, not changes to any file this plan owns.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- WR-03's detection gap is closed: an HTML-layer divergence between production and a conformant browser is now detectable by a shipped, hard-gated test, proven non-vacuous by rediscovering CR-01/CR-03/WR-01 independently and proven blocking by live injection.
- **This plan fixes NO leak.** `git status --porcelain src/` is empty throughout. CR-01, CR-03 and WR-01 are still live in `src/source/strip-hidden.ts` exactly as `62-VERIFICATION.md` pass 5 found them.
- **HF-01 and HF-02 are OPEN, TEMPORARY, and owned by 62-29** (named in `62-VERIFICATION.md`'s own chartering and in this file's `it.fails` doc comments) — 62-29 is REQUIRED to delete both predicates, their locks, and this describe block's two `it`s, replacing the `it.fails` with a passing assertion, when it fixes CR-01/CR-03.
- **HF-03 is OPEN, TEMPORARY, and owned by 62-30** (WR-01) — same removal obligation.
- Full suite green at close: `npx vitest run` — 199 files passed / 1 skipped; 3306 passed / 9 expected-fail / 4 skipped. `npm run typecheck` and `npm run build` both exit 0.
- Frozen surface confirmed untouched: `git log --oneline 4354c81..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts` returns 0 lines.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-02*

## Self-Check: PASSED

- `tests/support/html-render-oracle.ts` exists: FOUND
- `tests/support/differential-helpers.ts` exists: FOUND
- `tests/html-wrapper-differential.test.ts` exists: FOUND
- `tests/css-liveness-differential.test.ts` modified (diff confirmed, extraction-only): FOUND
- Commit `6690fba` (Task 1) present in `git log --oneline --all`: FOUND
- Commit `39a09d9` (Task 2) present in `git log --oneline --all`: FOUND
- Commit `47062fc` (Task 3) present in `git log --oneline --all`: FOUND
- `git status --porcelain src/` empty: confirmed
- `npx vitest run` full suite green (199 passed / 1 skipped files, 3306 passed / 9 expected-fail / 4 skipped tests): confirmed
