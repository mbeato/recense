---
phase: 62-multi-inbox-email-ingest-hardening
plan: 14
subsystem: security
tags: [strip-hidden, quadratic-cost, wr-02, availability, dos]

# Dependency graph
requires:
  - phase: 62 (plan 62-13)
    provides: "stripCssComments (linear CSS comment scanner), RAWTEXT close-tag scan, 62-09 source guard baseline (5 ATTRS literals)"
provides:
  - "Bound A: hoisted stray-`<` fail-safe (stage 0) removing the region where unquoted-attribute forward scans can fail repeatedly"
  - "Bound B: linear indexOf/lastIndexOf rule scan in harvestHidingSelectors, replacing the deleted RULE_RE backtracking regex"
  - "Twelve-shape measured cost matrix (pre-fix and post-fix) at 64/128/256/512 KB, with per-stage attribution"
  - "Deterministic seeded fuzz test (2000 inputs) locking totality/idempotence/no-stray-< as generated-input invariants"
  - "Shape T (T-62-54) measured at 512 KB/1 MB/2 MB/4 MB — the named, unfixed residual plan 62-15's cap is sized against"
affects: [62-15]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Linear cursor-partition scan (indexOf/lastIndexOf, no regex) replacing a backtracking-heavy matchAll loop, mirroring 62-13's stripCssComments pattern"
    - "Stage-0 hoisted fail-safe duplicate: moving a correctness-preserving truncation earlier in a pipeline to remove a cost surface without changing output"

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts

key-decisions:
  - "stripCssComments (62-13) is UNCHANGED. Shapes Y and Z measured quadratic pre-fix (RED), which a naive reading of the plan's framing would attribute to a stripCssComments regression -- per-stage instrumentation instead shows stripCssComments returns Y/Z's content COMPLETELY UNCHANGED in under 0.1ms (both contain no `/*`, so its early-exit fires), and the actual cost (~7,900-8,030ms at 128KB alone, matching the full-pipeline number almost exactly) is 100% downstream in the deleted RULE_RE. Bound B (already targeting RULE_RE for the report's shape) therefore fixes Y and Z as a direct, measured consequence, with zero code change to stripCssComments -- 'Task 2's scope extends accordingly' is satisfied by asserting Y/Z at 512KB (Task 1) and confirming Bound B's fix covers them (Task 2/3), not by touching an already-correct, already-linear function."
  - "Bound A is a stage-0 ADDITION duplicating stage 6's existing stray-< truncation, not a move of it -- stage 6 stays in place because stages 4/5 delete ranges and can expose a NEW stray < that stage 0 could not have seen."
  - "Bound B's linear scan partitions block content on `}`; within each segment the body starts after the segment's LAST `{`, and the selector starts after the PRECEDING `{` (or segment start) -- this is the exact match sequence RULE_RE's global retry-at-every-position produced, argued in the function's own doc comment and checked (not just argued) by a 55,335-input differential harness against the pre-change module (0 differences)."
  - "Absolute cost ceilings for Shapes A/B/S/T/U moved DOWN from 5000ms to 1000ms (the opposite direction from 62-12's 500ms->5000ms raise) because the constant they guarded against collapsed -- growth-ratio (toBeLessThanOrEqual(8)) assertions are unchanged, remaining the ReDoS instrument of record."
  - "Shape T (T-62-54, STYLE_BLOCK_RE's lazy </style> tail scan) is deliberately NOT given a 512KB assertion -- it is the one quadratic this plan does not fix, and asserting it at 512KB would imply otherwise. It is instead measured at 512KB/1MB/2MB/4MB in this SUMMARY for plan 62-15 to size its input cap against."

requirements-completed: [EMAIL-03]

duration: ~75min
completed: 2026-07-30
---

# Phase 62 Plan 14: WR-02 Quadratic-Cost Gap Closure (Bound A + Bound B) Summary

**Two exact linear bounds — a hoisted stray-`<` fail-safe and a linear cursor-partition rule scan replacing a deleted backtracking regex — take the verification report's 126-second, 512 KB adversarial email down to 1.2 ms, with zero output differences over 335 corpus literals and 55,000 generated inputs.**

## Performance

- **Duration:** ~75 min (including ~23 min of unavoidable pre-fix measurement wall-clock: the RED verification run alone took 674.96s / ~11.25 min because five of the new tests each require a genuinely-quadratic ~126s synchronous call to complete before their assertion can fail)
- **Tasks:** 3
- **Files modified:** 2 (`src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`)

## Accomplishments

- Closed the algorithmic half of WR-02 (EMAIL-03, roadmap SC #3): the verification report's exact 512 KB adversarial shape goes from 126,422 ms (report) / 131,676 ms (this executor's own pre-fix measurement) to **1.21 ms** — measured against `src/`, and **1.345 ms** measured against the built `dist/` artifact the verifier reads.
- Confirmed root cause exactly as planning-time instrumentation predicted: `RULE_RE`'s backtracking-heavy `matchAll` loop, not the `ATTRS` widening the report blamed, carried ~99.9%+ of the cost at every measured size for the report's shape.
- Extended the measured shape set to twelve total (report, A, B, S, T, U, V, W, X, X3, Y, Z) and discovered, with numbers, that shapes Y and Z (which 62-13's own cost table for `stripCssComments` in isolation might suggest are safe) are ALSO quadratic pre-fix — via the exact same `RULE_RE` cause, not a `stripCssComments` regression. `stripCssComments` needed no changes.
- Shipped a deterministic seeded fuzz test (2000 generated inputs, no `Math.random`) locking totality, idempotence, and the no-stray-`<` invariant as generated-input properties, after confirming the no-stray-`<` invariant already held on the pre-change module.
- Retired five stale 5000ms cost ceilings to 1000ms and extended four shapes (A, B, S, U) to 512 KB assertions, so the suite now asserts the property at the size the gap was filed about.
- Named and quantified the one quadratic this plan does not fix — Shape T / T-62-54 — at 512 KB, 1 MB, 2 MB and 4 MB, handing plan 62-15 real numbers to size its input cap against.

## Task Commits

1. **Task 1: Measure the post-62-13 cost curve and encode the target bound as a failing test (measured RED)** — `6e06e44` (test)
2. **Task 2: Two exact linear bounds, with demonstrated behavior equivalence (GREEN)** — `4a86d1a` (feat)
3. **Task 3: Re-measure, retire the stale ceilings, and name the remaining quadratic with numbers** — `ab7e85f` (test)

## Files Created/Modified

- `src/source/strip-hidden.ts` — Adds a stage-0 hoisted stray-`<` fail-safe (Bound A, duplicate of the existing stage-6 truncation) in `stripHiddenContent`; replaces `harvestHidingSelectors`'s `RULE_RE`-driven `matchAll` loop with a linear `indexOf`/`lastIndexOf` cursor-partition scan (Bound B); deletes `RULE_RE` (not left as dead code); updates every doc comment that referenced `RULE_RE` by name; adds a "62-14 gap closure" section to the file-level doc block and a stage-0 entry to the stage list. `collectRemovalRanges`, `findMatchingCloseEnd`, `findRawtextCloseEnd`, `applyRemovalRanges`, `isHiddenStartTag`, `hasHidingSignature`, `normalizeWhitespace`, `stripInvisibleCodepoints` and **`stripCssComments`** bodies are byte-identical to before this plan (confirmed via `git diff -U0`, see below).
- `tests/strip-hidden.test.ts` — New WR-02 RED describe block (8 tests: report/V/W/X/X3/Y/Z at 512 KB + report's growth-ratio); new deterministic fuzz-test describe block (1 test, 2000 generated inputs); five `toBeLessThan(5000)` ceilings retired to `toBeLessThan(1000)`; four new 512 KB assertions (Shapes A, B, S, U).

## Task 1 — RED Evidence

Verify command: `npx vitest run tests/strip-hidden.test.ts`. Exited non-zero as required (exit code 1). **6 failing tests**, **232 passing** (238 total, up from 230 baseline + 8 new).

| # | Test | Failure mode | Observed elapsed |
|---|------|---------------|-------------------|
| 1 | report shape at 512 KB < 1000ms | AssertionError (`126393.91` not < `1000`) | 126,397 ms |
| 2 | report shape growth 128→256 KB ≤ 8x | **Test timed out in 20000ms** (the only test caught by vitest's own timeout rather than running to completion — its two sequential ~8s+~33s calls together exceed the 20s block budget) | ≥ 20,000 ms (killed) |
| 3 | Shape V at 512 KB < 1000ms | AssertionError (`126183.81` not < `1000`) | 126,184 ms |
| 4 | Shape W at 512 KB < 1000ms | AssertionError (`126071.68` not < `1000`) | 126,072 ms |
| 5 | Shape Y at 512 KB < 1000ms | AssertionError (`126253.61` not < `1000`) | 126,254 ms |
| 6 | Shape Z at 512 KB < 1000ms | AssertionError (`126198.89` not < `1000`) | 126,199 ms |

**Controls that PASSED in RED** (as the plan anticipated): Shapes X and X3 at 512 KB both completed in the low single-digit milliseconds and passed their `< 1000ms` assertions unmodified.

**The three-way halt/extend decision, resolved with numbers:** `RULE_RE` dominates the report's shape (confirmed below) — no halt condition (1) triggered. Shapes X and X3 measured LINEAR as expected. Shapes Y and Z measured QUADRATIC — triggering the plan's literal instruction to "extend Task 2's scope... to fixing [stripCssComments] here." Per-stage instrumentation (below) shows this would have been the WRONG fix: `stripCssComments` is not the cause for Y or Z. No other stage dominated for any shape — halt condition (3) never triggered either. See "Key Decision" below for the resolution actually taken.

### Twelve-shape × four-size measured curve (PRE-FIX, post-62-13 code)

| shape | 64 KB | 128 KB | 256 KB | 512 KB | ratio 128/64 | ratio 256/128 | ratio 512/256 |
|---|---|---|---|---|---|---|---|
| report | 2,160.89 ms | 7,957.61 ms | 33,761.02 ms | 131,676.49 ms | 3.68 | 4.24 | 3.90 |
| A | 228.25 ms | 911.88 ms | 3,641.76 ms | 14,608.98 ms | 4.00 | 3.99 | 4.01 |
| B | 146.79 ms | 580.25 ms | 2,286.18 ms | 9,148.34 ms | 3.95 | 3.94 | 4.00 |
| S | 303.79 ms | 1,183.92 ms | 4,746.32 ms | 18,815.14 ms | 3.90 | 4.01 | 3.96 |
| T | 1.95 ms | 7.03 ms | 28.21 ms | 108.31 ms | 3.60 | 4.02 | 3.84 |
| U | 1,311.81 ms | 5,373.28 ms | 22,632.24 ms | 85,293.85 ms | 4.10 | 4.21 | 3.77 |
| V | 2,033.70 ms | 8,077.87 ms | 32,209.67 ms | 128,544.63 ms | 3.97 | 3.99 | 3.99 |
| W | 2,010.09 ms | 8,034.02 ms | 32,204.31 ms | 128,155.85 ms | 4.00 | 4.01 | 3.98 |
| X | 0.27 ms | 0.51 ms | 1.11 ms | 1.76 ms | 1.89 | 2.18 | 1.58 |
| X3 | 0.22 ms | 0.46 ms | 0.96 ms | 1.73 ms | 2.12 | 2.10 | 1.79 |
| **Y** | **2,027.05 ms** | **8,028.06 ms** | **31,980.10 ms** | **128,637.20 ms** | 3.96 | 3.98 | 4.02 |
| **Z** | **2,016.96 ms** | **7,985.54 ms** | **31,933.70 ms** | **127,588.46 ms** | 3.96 | 4.00 | 4.00 |

Nine of twelve shapes reproduce the report's ~4x-per-doubling quadratic signature at these sizes; X and X3 are the only shapes measuring linear pre-fix.

### Per-stage instrumentation (report shape, PRE-FIX)

| size | `STYLE_BLOCK_RE` matchAll | `stripCssComments` | `RULE_RE` matchAll | `START_TAG_RE` exec loop | `ANY_TAG_RE` replace |
|---|---|---|---|---|---|
| 64 KB | 0.08 ms | 0.07 ms | **2,021.89 ms** | 0.29 ms | 0.10 ms |
| 128 KB | 0.07 ms | 0.00 ms | **8,027.34 ms** | 0.31 ms | 0.14 ms |
| 256 KB | 0.32 ms | 0.01 ms | **32,015.08 ms** | 0.50 ms | 0.30 ms |
| 512 KB | 0.14 ms | 0.01 ms | **129,753.85 ms** | 1.41 ms | 0.58 ms |

`RULE_RE` carries 99.9%+ of the cost at every size — confirms the planning-time attribution and directly contradicts the verification report's own attribution to `ATTRS`. Halt condition (1) ("RULE_RE does not dominate the report's shape") did NOT trigger.

### Per-stage instrumentation for Shapes Y and Z (128 KB, PRE-FIX) — the decisive evidence

| shape | size | `STYLE_BLOCK_RE` | `stripCssComments` | `RULE_RE` | `START_TAG_RE` | `ANY_TAG_RE` | block content length after `stripCssComments` |
|---|---|---|---|---|---|---|---|
| Y | 128 KB | 0.67 ms | **0.04 ms** | **7,986.63 ms** | 0.17 ms | 0.09 ms | 131,072 (unchanged — full input length) |
| Z | 128 KB | 0.07 ms | **0.00 ms** | **7,906.64 ms** | 0.04 ms | 0.04 ms | 131,075 (unchanged — full input length) |

`stripCssComments`'s own cost (0.00–0.04 ms) is negligible and matches its documented behavior exactly: Shapes Y and Z contain no `/*` at all, so `css.indexOf('/*') === -1` fires immediately and the function returns its argument byte-identical, in O(1). The full, UNSHORTENED content then reaches `RULE_RE`, whose cost (7,906–7,987 ms) accounts for essentially the entire full-pipeline number for both shapes at 128 KB (7,985.54 ms / 8,028.06 ms respectively). **Y and Z are quadratic via the identical `RULE_RE` mechanism as the report's shape — not via any defect in `stripCssComments`.**

`npx tsc --noEmit` exited 0 during this task. `git diff --exit-code src/` exited 0 (no production edit in Task 1).

## Task 2 — GREEN: Bound A + Bound B (with demonstrated equivalence)

### Key Decision: `stripCssComments` was NOT changed

The plan's action text anticipated that measuring Shapes X/X3/Y/Z as quadratic would mean "62-13's linear scanner regressed or was not implemented as specified," directing that "Task 2's scope extends to cover it" by rewriting `stripCssComments`. The per-stage evidence above shows this diagnosis does not hold for Y and Z: `stripCssComments` is measured, directly, to be exactly what it claims to be — a linear, sub-millisecond scan, including in its early-exit path. Its own cost is not the bottleneck for any of the twelve shapes at any size measured. The bottleneck for Y and Z is textually and numerically the same downstream function (`RULE_RE`) that Bound B already exists to replace for the report's shape, V, and W. Rewriting an already-correct, already-linear function would have been scope creep with no basis in the measured evidence, and risked reopening the class of defect 62-13's own SUMMARY warned against (a "fix" that changes behavior without a measured cause to justify it). **Resolution: Bound B (unconditional; report/V/W's exact fix) is the fix for Y and Z too, verified by the same 512 KB assertions Task 1 already wrote for them.** This is recorded as the deciding measurement per the plan's own instruction ("Record which of the two outcomes you observed, with numbers, before proceeding").

### Bound A — hoisted stray-`<` fail-safe (stage 0)

Inserted in `stripHiddenContent`, immediately after stage 1 (`stripInvisibleCodepoints`) and before stage 2 (`harvestHidingSelectors`):

```ts
const lastCloseAngle = s.lastIndexOf('>');
const earlyStrayAngleBracket = s.indexOf('<', lastCloseAngle + 1);
if (earlyStrayAngleBracket !== -1) s = s.slice(0, earlyStrayAngleBracket);
```

Equivalence argument (stated in the code): a forward scan of the shared `ATTRS` fragment that reaches an unquoted `>` succeeds and advances past it, so successful matches cost O(n) in aggregate; a scan can only fail repeatedly in the region AFTER the last `>` in the string, where no complete tag can exist. That region is exactly what stage 6's existing truncation already deletes — hoisting an identical deletion to stage 0 removes the entire failing-scan region before stages 2–6 ever pay for it. Stage 6's own truncation is **unchanged and still present** (`grep -c "indexOf('<')" src/source/strip-hidden.ts` → 2, one per stage), because stages 4 and 5 delete ranges and can expose a NEW stray `<` that stage 0 could not have seen.

This bound closes Shapes A, B, S, U (the `ATTRS` forward-scan-to-EOF class from 62-12's widening).

### Bound B — linear rule scan (replaces the deleted `RULE_RE`)

`harvestHidingSelectors`'s `for (const ruleMatch of blockContent.matchAll(RULE_RE))` loop is replaced with a cursor-partition scan over `}` characters; within each segment, the declaration body starts after the segment's LAST `{`, and the selector starts after the PRECEDING `{` (or the segment start). Full equivalence argument is stated in the function's own doc comment (see the diff). `MAX_HARVESTED_SELECTORS` is checked at the same two points as before (once per candidate rule, once per selector). `RULE_RE` is deleted, not left as dead code (`grep -c 'RULE_RE' src/source/strip-hidden.ts` → 0), and its doc comment's "plain CSS has no nesting" observation is folded into the new scan's comment. Every doc comment that previously named `RULE_RE` (the file-level VF-01 note, `STYLE_BLOCK_RE`'s doc block) is updated to describe "the rule harvest"/"the rule scan" generically instead.

This bound closes the report's shape, V, W, and — as the deciding measurement above shows — Y and Z as well.

### Behavior equivalence — demonstrated, not asserted

Differential harness (scratch, not committed): pre-change module extracted via `git show HEAD:src/source/strip-hidden.ts` (HEAD at the time = the 62-13-closing commit, before this plan's edits), compared against the changed module.

- **Corpus literals compared:** 335 (every string literal extracted from `tests/strip-hidden.test.ts` and `tests/gmail-hidden-content.test.ts`, plus the full text of `tests/fixtures/gmail-hidden-injection.html` as a single item)
- **Corpus differences:** **0**
- **Generated inputs compared:** 55,000 (LCG-seeded, alphabet includes `<`, `>`, `/`, `"`, `'`, `{`, `}`, `/*`, `*/`, `<!--`, `-->`, `<style`, `</style`, `<script`, `</script`, `url(`, `(`, `)`, `\`, `display:none`, `class`, `legal`, whitespace, letters)
- **Generated differences:** **0**

**ZERO differences across both corpora**, exceeding the plan's ≥50,000-generated-input requirement.

### Deterministic seeded fuzz test (shipped)

A seeded LCG (`0xfeed5eed`, Numerical Recipes constants, no `Math.random`) generates 2,000 inputs from the same alphabet family used by the differential harness. Asserts, for every generated input: totality (`stripHiddenContent` never throws), idempotence (`f(f(x)) === f(x)`), and that the output contains no `<` character. The no-`<` invariant was confirmed to already hold on the PRE-change module first (same 2,000-case seeded run against the unmodified module: `throwCount=0 idempotenceFails=0 strayAngleFails=0`), per the plan's requirement not to ship a "preserved" claim that wasn't actually checked against the baseline.

### Locks re-verified

Every 62-13 lock (VF-01's five shapes, NEW-01's four shapes and its both-directions twin, the eleven CSS-context controls) and every historical lock (BL-01, both BL-02 forms, CR-01, `SECRET6`/`VISIBLE6`, both residual-(c) unbalanced-quote locks, basic class/id harvests, every BL-03 carrier row) passed verbatim in the full-suite run below — no lock needed re-statement since the full suite covers them all with 0 failures.

`npx tsc --noEmit` exited 0. `npm run build` and `npx vitest run` both exited 0.

## Task 3 — Re-measurement, Ceiling Retirement, and Naming the Residual

### Twelve-shape × four-size measured curve (POST-FIX)

| shape | 64 KB | 128 KB | 256 KB | 512 KB | ratio 128/64 | ratio 256/128 | ratio 512/256 |
|---|---|---|---|---|---|---|---|
| report | 0.548 ms | 0.381 ms | 0.610 ms | 1.210 ms | 0.70 | 1.60 | 1.99 |
| A | 0.058 ms | 0.115 ms | 0.208 ms | 0.407 ms | 1.98 | 1.81 | 1.96 |
| B | 0.052 ms | 0.142 ms | 0.398 ms | 0.377 ms | 2.72 | 2.81 | 0.95 |
| S | 0.046 ms | 0.103 ms | 0.192 ms | 0.361 ms | 2.23 | 1.86 | 1.88 |
| **T** | **1.755 ms** | **6.915 ms** | **27.317 ms** | **109.156 ms** | 3.94 | 3.95 | 4.00 |
| U | 0.054 ms | 0.130 ms | 0.207 ms | 0.389 ms | 2.41 | 1.59 | 1.88 |
| V | 0.127 ms | 0.212 ms | 0.389 ms | 1.182 ms | 1.67 | 1.84 | 3.03 |
| W | 0.193 ms | 0.294 ms | 0.454 ms | 0.796 ms | 1.52 | 1.55 | 1.75 |
| X | 0.244 ms | 0.441 ms | 0.860 ms | 1.731 ms | 1.81 | 1.95 | 2.01 |
| X3 | 0.216 ms | 0.443 ms | 0.863 ms | 1.738 ms | 2.05 | 1.95 | 2.01 |
| Y | 0.047 ms | 0.108 ms | 0.216 ms | 0.597 ms | 2.28 | 2.00 | 2.76 |
| Z | 0.048 ms | 0.116 ms | 0.199 ms | 0.397 ms | 2.41 | 1.71 | 2.00 |

**The claim this data supports:** the complexity class changed (quadratic → effectively-linear, sub-2ms even at 512 KB) for eleven of the twelve shapes — report, A, B, S, U, V, W, X, X3, Y, Z. T-62-54 (Shape T) is the sole exception, still growing ~4x per doubling exactly as before (unaffected by either bound, as designed — neither Bound A nor Bound B touches `STYLE_BLOCK_RE`). X and X3 were already linear pre-fix (`stripCssComments`'s correctly-linear early-exit path) and remain linear post-fix, confirming rather than assuming that class held.

### Ranked by 512 KB cost (worst first)

| rank | shape | 512 KB cost |
|---|---|---|
| 1 | **T** | **109.156 ms** |
| 2 | X3 | 1.738 ms |
| 3 | X | 1.731 ms |
| 4 | report | 1.210 ms |
| 5 | V | 1.182 ms |
| 6 | W | 0.796 ms |
| 7 | Y | 0.597 ms |
| 8 | A | 0.407 ms |
| 9 | Z | 0.397 ms |
| 10 | U | 0.389 ms |
| 11 | B | 0.377 ms |
| 12 | S | 0.361 ms |

**Shape T is the WORST shape at 512 KB by nearly two orders of magnitude** over the second-worst (X3, 1.738 ms) — exactly matching the plan's expectation that T-62-54 would be both the worst shape and the only remaining quadratic. Shape T and "the worst shape" are the same shape, so only one further measurement was needed.

### Shape T (T-62-54) at larger sizes — the residual plan 62-15 sizes its cap against

| size | measured (this executor) | planning-measured (plan text) |
|---|---|---|
| 512 KB | **111.252 ms** | 111 ms |
| 1 MB | **433.303 ms** | 435 ms |
| 2 MB | **1,722.784 ms** | 1,751 ms |
| 4 MB | **6,876.732 ms** | 6,946 ms |

Remarkably close to the planning-time numbers (within ~2% at every size), confirming the planning measurement was accurate and machine-independent enough to plan against. **Shape T / T-62-54 is the residual: plan 62-15 sizes its input cap using these four numbers.** It is untouched by this plan, per the plan's explicit out-of-scope directive.

### `dist/`-level reproduction of the verification report's exact shape

Reproduced via `node -e` against the built `dist/src/source/strip-hidden.js` (`npm run build` exited 0):

| size | `dist/`-level (this executor) | `62-VERIFICATION.md` report's own number |
|---|---|---|
| 64 KB | **0.894 ms** | 1,983 ms |
| 128 KB | **0.363 ms** | 7,904 ms |
| 256 KB | **0.676 ms** | 31,616 ms |
| 512 KB | **1.345 ms** | 126,422 ms |

The 512 KB `dist/`-level measurement (1.345 ms) is well under the 1000 ms bound required by the verification criteria. This is the exact comparison the next verifier will make.

### Ceiling retirement

Five `toBeLessThan(5000)` absolute ceilings (Shapes A, B, U at ~64 KB; S, T at ~64 KB) retired to `toBeLessThan(1000)` — moving DOWN, not up, because the constant they guard against collapsed (post-fix, these shapes measure 0.05–1.76 ms at 64 KB — see the table above). Every `toBeLessThanOrEqual(8)` growth-ratio assertion is UNCHANGED (still the ReDoS instrument of record). Four new 512 KB assertions added for Shapes A, B, S, U — extending the shipped bound to the size the gap is about. Shape T deliberately does NOT get a 512 KB assertion (it would pass — 109 ms < 1000 ms — but asserting it would misleadingly imply this plan closed T-62-54, which it explicitly does not).

`grep -c 'toBeLessThan(5000)' tests/strip-hidden.test.ts` → **0**. `grep -c 'toBeLessThan(1000)' tests/strip-hidden.test.ts` → **16** (5 retired ceilings + 11 new-or-existing 512 KB assertions: report/V/W/X/X3/Y/Z from Task 1, A/B/S/U from Task 3). `grep -c 'toBeLessThanOrEqual(8)' tests/strip-hidden.test.ts` → **4** (unchanged in count and content from before this plan, plus the report shape's new growth-ratio test — no existing growth-ratio assertion was touched).

## Full Suite Reconciliation

`npm run build` exited 0. `npx vitest run` (full suite): **193 passed | 1 skipped (194 files); 3098 passed | 4 skipped (0 failed) of 3102 tests.**

Baseline (62-13-SUMMARY.md close): 3085 passed / 4 skipped / 0 failed of 3089 tests.

**Reconciliation:** This plan added exactly 13 tests:
- 8 in Task 1's WR-02 RED describe block (report + growth-ratio + V + W + X + X3 + Y + Z)
- 1 in Task 2's deterministic fuzz test describe block
- 4 in Task 3 (Shapes A, B, S, U at 512 KB)

8 + 1 + 4 = 13. `3085 + 13 = 3098` — exact reconciliation, no unexplained delta.

`npx tsc --noEmit` exits 0. `grep -c 'RULE_RE' src/source/strip-hidden.ts` → 0. `grep -c "^import\|require(" src/source/strip-hidden.ts` → 0. `git diff --exit-code src/source/gmail-adapter.ts src/adapter/ src/lib/config.ts src/consolidation/ src/db/schema.ts` → exits 0. `git log --oneline 64c2f04..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts` → 0 commits — the frozen EMAIL-01/02/04 surface is untouched. `git diff --stat 64c2f04..HEAD` touches exactly two files: `src/source/strip-hidden.ts` and `tests/strip-hidden.test.ts`.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing functionality, or blocking issues were found outside the plan's own charter.

### Interpretation Resolved with Evidence (not a Rule 1-3 auto-fix, not a Rule 4 architectural question — a measurement-driven resolution of an explicit plan-provided branch)

**1. Shapes Y and Z measured quadratic pre-fix; `stripCssComments` was NOT touched, despite the plan's literal instruction anticipating that outcome would require rewriting it.**
- **Found during:** Task 1's per-stage instrumentation of Shapes Y and Z (extending beyond the report-shape-only instrumentation the plan's read_first anticipated).
- **The plan's literal branch:** "If shapes X/X3/Y/Z measure quadratic, do NOT stop: that means 62-13's linear scanner regressed or was not implemented as specified, and Task 2's scope extends to cover it... replace whatever scan it uses with a regex-free charCodeAt cursor loop."
- **What the measurement actually showed:** `stripCssComments` costs 0.00–0.04 ms for Y and Z at 128 KB and returns their content byte-identical (both contain no `/*`, so its documented early-exit fires) — it did not regress and was implemented exactly as specified. The quadratic cost (~7,900–8,030 ms at 128 KB) is 100% attributable to the same deleted `RULE_RE` function that Bound B was already built to replace for the report's shape.
- **Resolution:** Bound B — already in scope, already planned, unconditional on this finding — fixes Y and Z as a direct, measured consequence (post-fix: 0.597 ms and 0.397 ms at 512 KB respectively). No change was made to `stripCssComments`. "Task 2's scope extends accordingly" is satisfied by Task 1's 512 KB assertions for Y and Z (which now pass) and by this SUMMARY's explicit statement of the deciding measurement, per the plan's own instruction to "record which of the two outcomes you observed, with numbers, before proceeding" rather than by a code change with no measured basis.
- **Files modified:** None beyond the two authorized files; `stripCssComments`'s body is byte-identical to before this plan (confirmed via `git diff -U0`).
- **Verification:** Per-stage table in Task 1's evidence section above; differential harness confirms zero output difference including for Y/Z-shaped generated inputs (the alphabet includes `"`, `url(`, `(`, `)` — the exact tokens Y and Z are built from).
- **Committed in:** `6e06e44` (Task 1, measurement + RED test), `4a86d1a` (Task 2, the fix that covers it), `ab7e85f` (Task 3, the 512 KB assertions that lock it).

---

**Total deviations:** 0 auto-fixed; 1 measurement-driven interpretation of an explicit plan branch, resolved in the direction the evidence supported rather than the plan's anticipated default.
**Impact on plan:** No scope creep — `stripCssComments` remains exactly as 62-13 shipped it. No functionality gap — Y and Z are covered by both the fix and a shipped 512 KB regression test.

## Deliberately Unfixed Findings (Named, Carried Forward)

- **T-62-54** (Shape T, `STYLE_BLOCK_RE`'s lazy `</style>` tail scan) — the one quadratic this plan does not fix. Measured at 512 KB / 1 MB / 2 MB / 4 MB above; **plan 62-15 sizes its input cap from these four numbers.**
- **The input cap itself** at `src/source/gmail-adapter.ts:362` — plan 62-15's charter, in the next wave. `src/source/gmail-adapter.ts` was not touched by this plan.
- **WR-01, WR-03..WR-08, IN-01..IN-04** — named by prior waves, not fixed here (out of this plan's charter).
- **Finding B** (62-13-SUMMARY.md) — a raw-newline-broken CSS string can suppress a following hiding rule's harvest. Out of this plan's charter (this plan's charter is WR-02, the cost gap, not a correctness/leak defect). Not observed to interact with either bound during this plan's work; not investigated further here.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- WR-02's algorithmic half is closed: the report's exact 512 KB shape is 1.2–1.3 ms (src/ and dist/), against 126–132 seconds before, with zero output differences over 335 corpus literals and 55,000 generated inputs.
- Eleven of twelve measured shapes changed complexity class; the twelfth (T-62-54) is named, quantified at four sizes, and explicitly handed to plan 62-15 to size its input cap against — it is the worst of the twelve shapes at 512 KB by nearly two orders of magnitude.
- The module remains pure, zero-import, compile-once, idempotent, deterministic, total, and monotone toward less content.
- `src/adapter/gmail-auth-cli.ts`, `src/adapter/runtime-config.ts`, `src/adapter/recense-doctor.ts`, `src/lib/config.ts`, `src/consolidation/episode-order.ts` and `src/source/gmail-adapter.ts` (including `parseEmailDate`) are untouched — 0 commits, `git diff --exit-code` clean.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*

## Self-Check: PASSED

All modified files confirmed present (`src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`); all three task commits confirmed present in `git log --oneline --all` (`6e06e44`, `4a86d1a`, `ab7e85f`).
