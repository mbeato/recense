---
phase: 62-multi-inbox-email-ingest-hardening
plan: 09
subsystem: email-ingest-security
tags: [security, regex, style-tag, cr-01, gap-closure, redos]
dependency-graph:
  requires: [62-07]
  provides: [STYLE_BLOCK_RE-quote-aware, CR-01-bug-class-guard]
  affects: [src/source/strip-hidden.ts, tests/strip-hidden.test.ts, tests/fixtures/gmail-hidden-injection.html]
tech-stack:
  added: []
  patterns: [measured-red-before-green, source-level-regression-guard, adversarial-cost-bound]
key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts
    - tests/fixtures/gmail-hidden-injection.html
decisions:
  - "STYLE_BLOCK_RE adopts the [^'\"<>] unquoted class (excludes <, matching START_TAG_RE/ANY_TAG_TOKEN_RE) rather than ANY_TAG_RE's [^'\">] form, so stage 2's <style> open-tag boundary opinion cannot disagree with stage 4's removal of the same element."
  - "Source guard implemented as a runtime test (readFileSync + comment-stripping) rather than a lint rule, mirroring the existing source-order regression lock in tests/gmail-hidden-content.test.ts."
  - "Stage-2 </style>-tail O(n^2) is a named, accepted, pre-existing finding (T-62-54) — not fixed in this plan; bounding it needs an input-length cap or pre-scan, a separate scoped decision."
metrics:
  duration: "~35 min"
  completed: "2026-07-30"
---

# Phase 62 Plan 09: Close CR-01 stage-2 `<style>` harvest bypass Summary

Made the fourth (and last) attribute-scanning regex in `strip-hidden.ts` quote-aware, closing
the CR-01 BLOCKER where a quoted `>` inside a `<style>` open tag's attributes defeated the
class/id-hidden-selector harvest, letting hidden email content survive into episode content.

## What Was Built

`STYLE_BLOCK_RE` now uses the same `(?:"[^"]*"|'[^']*'|[^'"<>])*` quote-aware alternation as
the three regexes 62-07 already fixed (`START_TAG_RE`, `ANY_TAG_TOKEN_RE`, `ANY_TAG_RE`), so a
`<style type="text/css" data-y="x>y">` open tag still yields its `.legal{display:none}` rule to
`harvestHidingSelectors` instead of truncating mid-attribute. The named regression fixture
(`tests/fixtures/gmail-hidden-injection.html`) now carries that exact real-mail shape, so its
pre-existing episode-content assertion can actually reach the vector it was named for. A new
source-level test asserts no attribute-scanning regex in the file ever regresses to a bare
`[^>]*`/`[^<>]*` class again, and a new adversarial-cost-bound test proves the new alternation
stays polynomial under a 64 KB `<style>`-heavy attack shape.

## Task 1 — Measured RED (before the fix)

Fixture change: `tests/fixtures/gmail-hidden-injection.html` line 3 `<style>` became
`<style type="text/css" data-y="x>y">`. Nothing else in the fixture changed (verified:
`grep -c 'data-y="x>y"'` → 1, `grep -c 'SECOND HIDDEN PAYLOAD DO NOT EXTRACT'` → 1).

Ran `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts` against the
**unfixed** `STYLE_BLOCK_RE` (still `[^>]*`). Verify command exited **non-zero**. Verbatim
failure output:

```
❯ tests/strip-hidden.test.ts (66 tests | 4 failed) 241ms
     × removes content behind a double-quoted style-tag attribute containing a literal > 2ms
     × removes content behind the near-universal real-mail type="text/css" data-y="x>y" style-tag shape 0ms
     × removes content behind a single-quoted style-tag attribute containing a literal > 0ms
     × removes an id-hidden element whose hiding rule lives behind a quoted > in the <style> open tag 0ms
❯ tests/gmail-hidden-content.test.ts (12 tests | 1 failed) 7ms
     × does not contain the <style>-class-hidden payload 3ms

FAIL tests/strip-hidden.test.ts > ... > removes content behind a double-quoted style-tag attribute containing a literal >
AssertionError: expected 'visibleHIDDEN VIA CLASS' not to contain 'HIDDEN VIA CLASS'

FAIL tests/strip-hidden.test.ts > ... > removes content behind the near-universal real-mail type="text/css" data-y="x>y" style-tag shape
AssertionError: expected 'okPAYLOAD3' not to contain 'PAYLOAD3'

FAIL tests/strip-hidden.test.ts > ... > removes content behind a single-quoted style-tag attribute containing a literal >
AssertionError: expected 'okPAYLOAD4' not to contain 'PAYLOAD4'

FAIL tests/strip-hidden.test.ts > ... > removes an id-hidden element whose hiding rule lives behind a quoted > in the <style> open tag
AssertionError: expected 'okPAYLOAD5' not to contain 'PAYLOAD5'

FAIL tests/gmail-hidden-content.test.ts > EMAIL-03 ... > does not contain the <style>-class-hidden payload
AssertionError: expected 'From: ats@recruiting-system.example.c…' not to contain 'SECOND HIDDEN PAYLOAD'
- SECOND HIDDEN PAYLOAD
+ ... SECOND HIDDEN PAYLOAD DO NOT EXTRACT ...  (surfaced verbatim in record.content)

Test Files  2 failed (2)
     Tests  5 failed | 73 passed (78)
```

The two double-quoted-attribute payload leaks (`visibleHIDDEN VIA CLASS`, `okPAYLOAD3`) exactly
match the planning-time reproduction against shipped `dist/`. The no-over-correction control
(`VISIBLE6`) PASSED in this RED state, as required — it is a genuine control, not a
post-hoc rationalization. All five new inputs were added to the idempotence `fixtures` array.

## Task 2 — GREEN

Final `STYLE_BLOCK_RE` literal (`src/source/strip-hidden.ts:213`):

```ts
const STYLE_BLOCK_RE = /<style\b(?:"[^"]*"|'[^']*'|[^'"<>])*>([\s\S]*?)<\/style\s*>/gi;
```

Uses the `[^'"<>]` unquoted class (excludes `<`) rather than `ANY_TAG_RE`'s `[^'">]` form,
because stage 2's harvest and stage 4's removal both act on the same `<style>` open tag —
disagreement between them is the cross-stage boundary bug class T-62-43 (worse than the
original defect, since it could delete visible prose). Capture-group numbering is unchanged
(the alternation is non-capturing), so `harvestHidingSelectors`' `styleMatch[1]` needed no edit
— confirmed unedited by the `-U0` diff below.

Fixture diff: `<style>` → `<style type="text/css" data-y="x>y">` (line 3 only; the
`.legal{display:none}` rule, the class-hidden span, the `display:none` div, and the
zero-width-joined `THIRD` payload are all byte-identical to before).

Source guard (`tests/strip-hidden.test.ts`, `describe('strip-hidden.ts — no attribute-scanning
regex uses a bare attribute class (CR-01 bug-class guard)')`): reads
`src/source/strip-hidden.ts` via `readFileSync`, strips lines whose trimmed form starts with
`//`, `/*`, or `*`, then asserts the remaining source contains neither the substring `[^>]*`
nor `[^<>]*`, and contains at least 4 occurrences of the alternation prefix
`(?:"[^"]*"|'[^']*'|` — one per attribute-scanning regex. A fifth regex reintroducing the bug
class fails this test instead of shipping silently.

Full production diff (`git diff -U0 src/source/strip-hidden.ts` at this point):

```
@@ -26,0 +27,2 @@
+ *     The `<style>` open tag is matched quote-aware, so a `type="text/css" data-y="x>y"`
+ *     style tag still yields its rules to the harvest.
@@ -201 +203,11 @@
-const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
+/** [quote-awareness rationale comment] */
+const STYLE_BLOCK_RE = /<style\b(?:"[^"]*"|'[^']*'|[^'"<>])*>([\s\S]*?)<\/style\s*>/gi;
```

`harvestHidingSelectors` is byte-identical (untouched). All four CR-01 unit cases now PASS; the
episode-content-level case (`does not contain the <style>-class-hidden payload`) now PASSES
unmodified (`git diff --exit-code tests/gmail-hidden-content.test.ts` → 0); the no-over-correction
control still PASSES (`VISIBLE6` still present). Zero-import and no-runtime-RegExp invariants
hold (see verification below).

## Task 3 — Adversarial cost bound (CR-01 stage-2 ReDoS surface)

New `describe('stripHiddenContent — adversarial <style> cost bound (CR-01 stage-2 ReDoS
surface)')` with a 20000ms block timeout, two shapes, measured through `stripHiddenContent`
(the full 8-stage pipeline, not the bare regex):

- **Shape S** — `'<style a="' + 'y'.repeat(50)` repeated, no `>` and no closing quote anywhere.
- **Shape T** — `'<style ' + 'a="b" c=\'d\' '.repeat(4) + '>'` repeated, complete open tags with
  alternating double/single-quoted attributes but no `</style>` anywhere (the genuinely
  quadratic shape — the lazy `([\s\S]*?)<\/style\s*>` tail scans to end of string from every
  start position).

Three-point cost curve, measured through `stripHiddenContent` (full pipeline) on this machine:

| Size | Shape S | ratio | Shape T | ratio |
|---|---|---|---|---|
| ~16 KB | 5.68 ms | — | 1.02 ms | — |
| ~32 KB | 20.26 ms | 3.57x | 3.07 ms | 3.02x |
| ~64 KB | 79.39 ms | 3.92x | 11.86 ms | 3.86x |

Both shapes stay well under the 500ms gate at 64 KB (Shape S 79.39ms, Shape T 11.86ms) and both
grow at ~4x per doubling — polynomial (quadratic), not catastrophic. Neither shape throws. The
required growth-ratio assertion on Shape T (`t64/max(t32,1) <= 8`) passes at 3.86x.

**Named finding (per plan, not fixed here):** stage 2's `</style>`-tail scan
(`([\s\S]*?)<\/style\s*>`) is O(n²) in the number of `<style` start positions when no closing
`</style>` tag exists anywhere in the input — this is why Shape S (which additionally has no
closing quote, forcing every alternation attempt to fail character-by-character before the
engine advances to the next `<style` occurrence) costs measurably more than Shape T at the
same size (79ms vs 12ms at 64 KB) despite both showing the same ~4x-per-doubling polynomial
growth. This quadratic is **pre-existing and cost-neutral across this fix** — the old bare
`[^>]*` class had the identical tail-scan shape; only the attribute-scanning cost inside each
failed attempt changed. It compounds with the stage-6 O(n²) already named by plan 62-07. It is
**deliberately NOT fixed here** — bounding it needs an input length cap or a cheap pre-scan, a
separate scoped decision that would be scope creep inside a security regression fix. Flagged
for the backlog alongside 62-07's finding (tracked as T-62-54 in this plan's threat model).

## Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts` → 83 passed (0 failed)
- `grep -n 'const STYLE_BLOCK_RE' src/source/strip-hidden.ts` → matches the exact required literal
- `grep -c "^import\|require(" src/source/strip-hidden.ts` → 0 (zero-import preserved)
- `grep -c "new RegExp" src/source/strip-hidden.ts` → 1, but the sole match is a **pre-existing
  comment** at line 105 (`// fixed regexes instead of constructing a new RegExp per matched tag
  name`) predating this plan (confirmed via `git diff HEAD~1` — this line is unchanged by any
  commit in this plan). There is no actual `new RegExp(...)` constructor call anywhere in the
  file; the compile-once invariant holds. Recorded honestly rather than silently treated as a
  pass, since the plan's own verification grep is a literal substring match with no comment
  awareness.
- Source guard test passes (comment-stripped source has neither bare attribute class; ≥4
  quote-aware alternation occurrences — actual count is exactly 4)
- `git diff --exit-code tests/gmail-hidden-content.test.ts src/source/gmail-adapter.ts
  src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/lib/config.ts
  src/adapter/recense-doctor.ts src/db/schema.ts src/consolidation/update-decision.ts` → exit 0
  (all scope-fenced files untouched)
- Full suite: pre-plan baseline **2880 passed / 3 skipped / 0 failed / 193 files** (stated in
  plan). Post-plan measured (after `npm run build`, required because `dist/` did not exist in
  this fresh worktree — see Deviations): **2894 passed / 4 skipped / 0 failed / 193 files**.
  Net +15 tests (5 CR-01 stage-2 cases + 5 idempotence fixtures in Task 1, 2 source-guard cases
  in Task 2, 3 adversarial cost-bound cases in Task 3 = 15), reconciling exactly with the
  2895→2898 total-test delta (15) minus one test that is environment-conditionally skipped in
  this worktree (real-`recense.db`-guarded tests in `snapshot.test.ts`/`sink.test.ts`/etc. —
  unrelated to this plan's files) instead of run. **Zero new failures.**

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking issue] Missing `dist/` build artifact blocked full-suite verification**
- **Found during:** Task 2, running `npx vitest run` (full suite) to check for regressions
- **Issue:** 7 test files (`adapter-capture.test.ts`, `adapter-inject.test.ts`,
  `episodic-dryrun-gate.test.ts`, `eval-harness-smoke.test.ts`, `locomo-harness.test.ts`,
  `locomo-latency-curve.test.ts`, `locomo-scorer.test.ts`) spawn compiled CLI binaries from
  `dist/src/adapter/*.js` etc. The fresh worktree (reset to the plan's base commit) had no
  `dist/` directory, so all 23 of their tests failed with `expected 1 to be +0`
  (spawned-process exit code 1 = "file not found").
- **Fix:** Ran `npm run build` (the project's own `pretest` script does this automatically for
  `npm test`, but this executor ran `npx vitest run` directly per the plan's verify commands).
  Confirmed via `grep -n "dist/"` that these failing files explicitly document the dependency
  (`eval-harness-smoke.test.ts:289`: "Requires the dist/ build (pretest runs npm run build so
  this is always present in CI)"). None of the 7 files are in this plan's scope (`strip-hidden.ts`,
  `gmail-adapter.ts`, or any of its tests) and none reference `strip-hidden`.
- **Files modified:** none (build artifact only, not committed — `dist/` is gitignored)
- **Commit:** N/A (no source change)

None of the other deviation rules applied — the plan's literal, tests, and fixture edits were
implemented exactly as specified.

## Self-Check

- FOUND: src/source/strip-hidden.ts (STYLE_BLOCK_RE literal confirmed at line 213)
- FOUND: tests/strip-hidden.test.ts (new describe blocks confirmed present)
- FOUND: tests/fixtures/gmail-hidden-injection.html (data-y="x>y" confirmed present)
- FOUND commit 3a31938 (RED)
- FOUND commit 9d3b05e (GREEN)
- FOUND commit 148ab08 (adversarial cost bound)

## Self-Check: PASSED
