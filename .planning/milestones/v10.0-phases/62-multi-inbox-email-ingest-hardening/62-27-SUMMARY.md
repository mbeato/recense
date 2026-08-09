---
phase: 62-multi-inbox-email-ingest-hardening
plan: 27
subsystem: testing
tags: [css-tree, differential-testing, css-liveness, counterfactual, ci, requirements-tracking, EMAIL-03]

# Dependency graph
requires:
  - phase: 62 (plan 25)
    provides: "Hard-gated leak bucket (NF03_commaList/NF04_blocklessAtRule/NF05_topLevelCdoCdc named predicates + failures hard-fail) that this plan makes causal"
provides:
  - "Causal leak attribution: attributeLeak re-runs both liveHidingSelectors and stripHiddenContent against a counterfactual (the named mechanism's shape removed) before crediting a leak, closing WR-02's co-occurrence-not-causation gap"
  - "A new, independently-discovered compound-leak mechanism (NF-06, two locked it.fails minimal repros) found live by the causal-attribution fix itself"
  - "Precondition-separated it.fails defect locks (WR-04): every it.fails body now asserts exactly one subject (production's output); the oracle ground-truth precondition moved to its own passing it"
  - "npm run typecheck wired into CI after Build, closing the tests/ typecheck coverage hole opened by 62-23 (WR-06)"
  - ".planning/REQUIREMENTS.md's EMAIL-01..04 checkboxes and traceability rows corrected to match 62-VERIFICATION.md pass 5 (the inversion carried since round 4)"
affects: [62-28, 62-29, future gap-closure rounds reading REQUIREMENTS.md or this differential file]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Counterfactual causal attribution: a predicate exposes its structural test AND the text edits that remove its named shape (TextEdit[]); attributeLeak applies the edits and re-verifies BOTH the oracle (liveHidingSelectors) and production (stripHiddenContent) before crediting a leak to that mechanism — a leak surviving its own predicate's removal is DIFFERENT MECHANISM, not a co-occurrence match"
    - "Compound attribution as a second pass, not a new co-occurrence predicate: when no single matched predicate's solo counterfactual clears a leak but >= 2 predicates matched structurally, the UNION of their edits is re-verified with the same causal standard before crediting a new named NF-06 bucket — built entirely from existing predicates' own edits, never a new shape-matching heuristic"
    - "it.fails precondition separation (WR-04): the oracle ground-truth check that used to share a body with the defect assertion is now its own ordinary passing it, so an it.fails body contains exactly one assertion subject and an oracle regression fails its own test instead of masquerading as the lock passing"

key-files:
  created: []
  modified:
    - tests/css-liveness-differential.test.ts
    - .github/workflows/ci.yml
    - .planning/REQUIREMENTS.md

key-decisions:
  - "Two genuinely new compound leaks surfaced by the causal fix (Generator 2, LCG seed 0x62191a2c): an input where NF-04's blockless-at-rule shape and NF-05's top-level-CDO/CDC shape co-occur such that removing EITHER alone leaves the leak (the other construct alone still corrupts the same rule's prelude) — only removing BOTH clears it. Per the plan's own instruction ('If a leak lands in DIFFERENT MECHANISM... report it as a new finding... do not add a predicate to absorb it'), this was NOT folded into NF-03/04/05's existing co-occurrence-only predicates. Instead: a second attribution pass tries the UNION of every ALREADY-matched predicate's edits (re-verified with the identical causal standard, never asserted), and only if that union clears the leak does it get a new name (NF06_compoundCooccurrence) with its own locked it.fails minimal repro. This is attribution refinement using existing predicates' own proven edits, not a new heuristic that would re-introduce co-occurrence."
  - "Predicate dispatch stays priority-ordered (NF-03 -> NF-04 -> NF-05) with no fallthrough between DIFFERENT structural predicates in the solo pass — matching the shipped module's own dispatch order and avoiding two named mechanisms silently trading credit for the same leak. Fallthrough only happens in the explicit compound (union) pass, which is gated on >= 2 predicates having ALREADY matched structurally on the same input."
  - "REQUIREMENTS.md's traceability table uses 'Satisfied'/'Blocked' (matching 62-VERIFICATION.md's own Requirements Coverage vocabulary) rather than the table's pre-existing 'Complete'/'Pending' pair for the four corrected rows, per the plan's own acceptance criteria; the source-of-truth prose line was placed immediately after the FULL 30-row table (not mid-table after just the EMAIL rows) since inserting it mid-table would visually split the CLASSIFY/RESOLVE/DRIFT/EMIT/CONSUME/APPROVE rows that follow EMAIL in the same table."

requirements-completed: [EMAIL-03]

# Metrics
duration: ~55min
completed: 2026-08-02
---

# Phase 62 Plan 27: Causal Leak Attribution, Precondition-Separated Defect Locks, CI Typecheck, Requirements Correction Summary

**`attributeLeak` now proves a leak's mechanism by counterfactual re-run instead of asserting it by co-occurrence — and the fix immediately found a genuine new compound-leak defect (NF-06) that the old co-occurrence gate had been silently misattributing to NF-03/NF-04.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-02T00:19:00Z (base commit `a9d2a21`)
- **Completed:** 2026-08-02T04:44:00Z
- **Tasks:** 3
- **Files modified:** 3 (`tests/css-liveness-differential.test.ts`, `.github/workflows/ci.yml`, `.planning/REQUIREMENTS.md`) — matches the plan's declared `files_modified` exactly

## Accomplishments

- WR-02 closed: leak attribution is now causal (counterfactual re-run of both `liveHidingSelectors` and `stripHiddenContent`), not co-occurrence-based
- A genuinely new finding (NF-06 compound co-occurrence) discovered live by the fix itself, named, causally verified, and locked with two minimal `it.fails` reproductions — not folded into an existing bucket
- WR-04 closed: every `it.fails` defect lock now asserts exactly one subject; oracle preconditions are separate passing tests, proven by a live oracle-break regression test
- WR-06 closed: `npm run typecheck` wired into CI after Build, proven non-vacuous by an injected type error and its removal
- The `.planning/REQUIREMENTS.md` EMAIL-01..04 inversion (carried since round 4) corrected against `62-VERIFICATION.md` pass 5

## Task Commits

1. **Task 1: Make leak attribution causal** — `1bc5261` (test)
2. **Task 2: Separate the oracle precondition from the defect assertion in every `it.fails` lock** — `4e253cc` (test)
3. **Task 3: Wire `npm run typecheck` into CI and correct the inverted EMAIL requirement record** — `29dee2c` (fix)

_Note: this SUMMARY's own commit follows as plan metadata._

## Files Created/Modified

- `tests/css-liveness-differential.test.ts` — `nf03Counterfactual`/`nf04Counterfactual`/`nf05Counterfactual` now return `{matches, edits: TextEdit[]}` instead of a boolean; `attributeLeak` applies edits and re-verifies both sides via `verifyCounterfactual`; new `NF06_compoundCooccurrence` counter + two locked `it.fails`; every `it.fails` body now contains only the production-output assertion, with the oracle precondition split into its own passing `it`; wrapper HTML construction factored into one `buildDifferentialHtml` helper used by both the main check and the counterfactual re-run.
- `.github/workflows/ci.yml` — added a `Typecheck` step (`npm run typecheck`) immediately after `Build`.
- `.planning/REQUIREMENTS.md` — EMAIL-01/02/04 checkboxes `[x]`/traceability `Satisfied`; EMAIL-03 checkbox `[ ]`/traceability `Blocked`; source-of-truth line added after the full traceability table.

## Per-Mechanism Counts: Old -> New, With Reasons

All three generators' exact-count assertions were re-measured against the shipped alphabet/LCG seeds after the causal-attribution rewrite.

**Generator 1 (exhaustive k=2 cross product, `TOKEN_ALPHABET.length^2` = 2,116 pairs):** no counts moved.

| Counter | Before | After |
|---|---|---|
| NF01_cdoTruncation | 86 | 86 |
| NF03_commaList | 10 | 10 |
| NF04_blocklessAtRule | 1 | 1 |
| NF05_topLevelCdoCdc | 16 | 16 |
| NF06_compoundCooccurrence | (new) | 0 |
| NFSAFE_overStrip | 50 | 50 |

Reason: every leak in this alphabet's 2-token combinations is explained by exactly one named mechanism's SOLO counterfactual — no compound case exists at k=2.

**Generator 2 (seeded k=3..6, LCG seed `0x62191a2c`, 20,000 inputs):** two counts moved.

| Counter | Before | After | Reason |
|---|---|---|---|
| NF01_cdoTruncation | 1921 | 1921 | unchanged |
| NF03_commaList | 52 | **51** | 1 leak reclassified: the co-occurrence-only predicate had been crediting NF-03 for an input where a top-level CDC (NF-05's own mechanism) ALSO co-occurred and, independently verified, is ALSO necessary — solo removal of the comma-list construct alone does not clear the leak |
| NF04_blocklessAtRule | 10 | **9** | 1 leak reclassified: same shape, with a top-level CDO co-occurring with a blockless at-rule — solo removal of the at-rule alone does not clear the leak |
| NF05_topLevelCdoCdc | 461 | 461 | unchanged |
| NF06_compoundCooccurrence | (new) | **2** | the exact 2 leaks reclassified out of NF03/NF04 above — both require removing BOTH co-occurring constructs together to clear |
| NFSAFE_overStrip | 1768 | 1768 | unchanged |

**Generator 3 (structured stylesheets, LCG seed `0xba5eba11`, 5,000 documents):** no counts moved.

| Counter | Before | After |
|---|---|---|
| NF01_cdoTruncation | 407 | 407 |
| NF03_commaList | 0 | 0 |
| NF04_blocklessAtRule | 0 | 0 |
| NF05_topLevelCdoCdc | 277 | 277 |
| NF06_compoundCooccurrence | (new) | 0 |
| NFSAFE_overStrip | 358 | 358 |

Reason: `RULE_LIBRARY`'s own hiding rules never form a comma list or sit adjacent to a blockless at-rule across this seed's 5,000 documents — a real absence for this seed, not a skip (Generator 2's larger seeded stream already proves NF-06 is reachable).

**Wall clock for the full differential file:** before this plan (baseline, pre-Task-1), `npx vitest run tests/css-liveness-differential.test.ts` ran in **2.49s** (2.31s test time). After all three tasks, the same command runs in **2.55-2.62s** (2.41-2.45s test time) — within the same band as required by the task's `<behavior>` (the extra counterfactual re-runs execute only on the leak branch, never on the overwhelmingly common no-leak path).

## New Finding: NF-06 (Compound Co-occurrence)

Per the plan's own instruction ("If a leak lands in DIFFERENT MECHANISM or COUNTERFACTUAL VACUOUS: STOP... Report it as a new finding... that is the correct outcome of this task, not a failure of it"), the two reclassified Generator 2 leaks are reported here as a genuinely new, independently-verified defect — **NF-06 (compound co-occurrence)**, not folded into NF-03/04/05.

**Mechanism:** a top-level CDO/CDC (NF-05's own construct) co-occurs with either a blockless at-rule (NF-04) or a comma-list rejection (NF-03) such that BOTH constructs independently corrupt the same rule's prelude — solo removal of either one alone leaves the leak in place because the other, still-present construct alone is sufficient to corrupt the harvest.

**Minimal repro A** (`@media;<!--.legal{display:none}`), independently verified by hand (node, direct calls, not via the test file):

```
BEFORE (generating input):                        "@media;<!--.legal{display:none}"
  oracle live?           true
  production output:     "VISIBLE_SENTENCEPL[legal]PLID[legal]"   -> LEAKS

Remove NF-04 only ("@media;"):                     "<!--.legal{display:none}"
  oracle live?           true
  production output leaks?  true   <- still leaks (the "<!--" alone still corrupts it)

Remove NF-05 only ("<!--"):                        "@media;.legal{display:none}"
  oracle live?           true
  production output leaks?  true   <- still leaks (the "@media;" alone still corrupts it)

Remove BOTH:                                        ".legal{display:none}"
  oracle live?           true
  production output leaks?  false  <- clears ONLY when both are removed together
```

**Minimal repro B** (`-->a,.legal{display:none}`), same pattern verified by hand: solo removal of the comma-list's non-bare sibling (`a,`) alone still leaks (the `-->` alone corrupts it); solo removal of `-->` alone still leaks (the `a,` alone corrupts it); removing both clears it.

**Status:** NOT fixed by this plan (test-only scope, matching NF-03/04/05's own disposition) — locked as two new `it.fails` minimal reproductions (`NF-06a`, `NF-06b`) in `tests/css-liveness-differential.test.ts`, with a passing precondition `it` for each (per Task 2's own fix, applied to the new locks from the start).

## Hand-Checked Counterfactual (Task 1 Acceptance Criterion)

Took a Generator-1-style input the shipped code attributes to NF-05 (`'--> .legal{display:none}'`, TOKEN_ALPHABET pair `'-->'` + `' '`), ran its counterfactual by hand outside the test file:

```
BEFORE: input="--> .legal{display:none}"
  oracle live?              true
  production output:        "VISIBLE_SENTENCEPL[legal]PLID[legal]"
  LEAKS (PL[legal] present)?  true

AFTER (NF-05 counterfactual — "-->" removed): input=" .legal{display:none}"
  oracle live?              true
  production output:        "VISIBLE_SENTENCEPLID[legal]"
  LEAKS (PL[legal] present)?  false
```

The leak disappears while the probe stays live — proof the new attribution is not vacuously passing.

## Regression Proof (Task 2 Acceptance Criterion — WR-04)

Temporarily made `liveHidingSelectors` (`tests/support/css-liveness-oracle.ts`) return `{ classes: new Set(), ids: new Set(), unresolved: [] }` unconditionally, ran the differential file:

```
FAIL  NF-03 precondition: ... expected false to be true
FAIL  NF-04 precondition: ... expected false to be true
FAIL  NF-05 precondition: ... expected false to be true
FAIL  NF-06a precondition: ... expected false to be true
FAIL  NF-06b precondition: ... expected false to be true
Tests  12 failed | 4 passed | 5 expected fail (21)
```

All 5 precondition tests failed loudly, exactly as WR-04's fix requires — an oracle regression now fails its own passing test instead of masquerading as the `it.fails` locks silently passing. Restored `liveHidingSelectors` verbatim; `git status --porcelain` / `git diff --stat tests/support/css-liveness-oracle.ts` confirmed clean (zero diff) before committing.

## Injected Type Error (Task 3 Acceptance Criterion — WR-06)

Created `tests/__verifier_probe_typecheck_ci.ts` with `const x: number = 'not a number';`, ran `npm run typecheck`:

```
> recense@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json

tests/__verifier_probe_typecheck_ci.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
EXIT CODE: 2
```

Non-zero exit, error text verbatim, proving the wired CI step is non-vacuous (a type error anywhere under `tests/` now fails it). Deleted the probe file, re-ran `npm run typecheck`: `EXIT CODE: 0`, `git status --short` clean.

## REQUIREMENTS.md Diff (Task 3 Acceptance Criterion)

```diff
-- [ ] **EMAIL-01**: ...
-- [ ] **EMAIL-02**: ...
-- [x] **EMAIL-03**: ...
-- [ ] **EMAIL-04**: ...
+- [x] **EMAIL-01**: ...
+- [x] **EMAIL-02**: ...
+- [ ] **EMAIL-03**: ...
+- [x] **EMAIL-04**: ...

-| EMAIL-01 | 62 | Pending |
-| EMAIL-02 | 62 | Pending |
-| EMAIL-03 | 62 | Complete |
-| EMAIL-04 | 62 | Pending |
+| EMAIL-01 | 62 | Satisfied |
+| EMAIL-02 | 62 | Satisfied |
+| EMAIL-03 | 62 | Blocked |
+| EMAIL-04 | 62 | Satisfied |

+_Source of truth for the EMAIL-01..04 rows above: `62-VERIFICATION.md` (pass 5, 2026-08-01) —
+future rounds must update the verification report and this table together, not one without
+the other._
```

`git diff --stat .planning/REQUIREMENTS.md`: `1 file changed, 12 insertions(+), 8 deletions(-)` — a small, enumerable diff touching only the four EMAIL rows and the two traceability rows, plus the added source-of-truth line. No other requirement row changed.

## Which of WR-02 / WR-04 / WR-06 Are Closed

- **WR-02: CLOSED.** Leak attribution is causal (counterfactual re-run of both sides), proven by the hand-check above; the fix's own rigor immediately surfaced a real, previously-misattributed compound defect (NF-06), which is the exact class of bug WR-02 named as its concern.
- **WR-04: CLOSED.** No `liveHidingSelectors` call remains inside any `it.fails` body (verified by reading all 5 locks); the regression proof above confirms an oracle regression now fails its own precondition test.
- **WR-06: CLOSED.** `npm run typecheck` runs in CI after Build, proven non-vacuous by the injected type error above.

## Decisions Made

See `key-decisions` in frontmatter — summarized: (1) the two Generator-2 compound leaks are reported as a new, independently-named finding (NF-06) rather than absorbed into NF-03/04/05, using a union-of-already-matched-predicates' edits re-verified with the identical causal standard, never a new co-occurrence heuristic; (2) predicate dispatch stays priority-ordered with no fallthrough in the solo pass, fallthrough only in the explicit compound pass; (3) REQUIREMENTS.md's traceability status vocabulary uses "Satisfied"/"Blocked" (matching `62-VERIFICATION.md`'s own vocabulary) for the corrected rows, and the source-of-truth prose line sits after the full 30-row table rather than mid-table.

## Deviations from Plan

None — plan executed exactly as written, including its own explicit escape hatch for new findings surfaced by the causal fix (NF-06), which the plan's `<action>` block anticipated as "the correct outcome of this task, not a failure of it."

## Issues Encountered

The initial causal rewrite (solo-only, first-matching-predicate-wins) surfaced 2 unclassified `failures` entries on Generator 2's first run — both later characterized as the genuine NF-06 compound-co-occurrence finding described above, not a bug in the rewrite. Resolved by adding the compound (union) attribution pass described in Decisions, re-verified against the exact same causal standard as every solo predicate.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- All three chartered findings (WR-02, WR-04, WR-06) closed and independently verified.
- The documentation defect (EMAIL requirement inversion) corrected against `62-VERIFICATION.md` pass 5.
- Full suite green (198 files / 3291 passed / 6 expected-fail / 4 skipped at close), `npm run typecheck` and `npm run build` both exit 0.
- Frozen surface confirmed untouched: `git log --oneline 4354c81..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts` returns 0 lines.
- **New finding carried forward:** NF-06 (compound co-occurrence, two minimal repros) is a genuine, still-open production defect in `src/source/strip-hidden.ts`'s frame-based prelude walker — same root class as NF-03/04/05, out of this plan's fix scope (CSS-tokenizer layer), locked and visible for a future round to fix.
- This plan deliberately touched neither `src/source/strip-hidden.ts` nor `tests/strip-hidden.test.ts`, keeping wave 20 conflict-free with sibling plan 62-26 (package.json/package-lock.json only) and preserving the one-plan-per-wave discipline on the frozen blocker-fix surface for wave 21+.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-02*

## Self-Check: PASSED

All claimed files exist (`tests/css-liveness-differential.test.ts`, `.github/workflows/ci.yml`,
`.planning/REQUIREMENTS.md`, this SUMMARY) and all three task commits (`1bc5261`, `4e253cc`,
`29dee2c`) are present in `git log --oneline --all`.
