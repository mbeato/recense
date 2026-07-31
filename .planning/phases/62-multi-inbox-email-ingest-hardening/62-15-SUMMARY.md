---
phase: 62-multi-inbox-email-ingest-hardening
plan: 15
subsystem: security
tags: [strip-hidden, gmail-adapter, input-cap, dos, wr-02, availability, fail-closed]

# Dependency graph
requires:
  - phase: 62 (plan 62-14)
    provides: "Two exact linear bounds in strip-hidden.ts (Bound A, Bound B) closing the algorithmic half of WR-02; the twelve-shape ranked cost matrix naming Shape T (T-62-54) as the sole remaining quadratic and the worst shape at 512 KB, measured at 512 KB/1 MB/2 MB/4 MB for this plan to size its cap against"
  - phase: 62 (plan 62-13)
    provides: "VF-01/NEW-01 fixes in strip-hidden.ts (comment-aware harvest, RAWTEXT close-tag scan) this plan's dist/ reproduction pass re-verifies"
provides:
  - "MAX_STRIP_INPUT_CODE_UNITS (1,048,576 / 1 MiB) module-scope bound on raw.bodyText before stripHiddenContent, sized from 62-14's measured Shape T curve"
  - "Fail-closed over-cap handling: STRIP_INPUT_OMITTED_MARKER, a fixed ASCII constant with zero sender-controlled bytes, replaces the body entirely above the cap -- stripHiddenContent is not called at all"
  - "A measured disproof of truncate-then-strip: the rejected design leaks PAYLOAD_TAIL_RULE on the fail-closed control's exact body"
  - "A consolidated it.each bypass-corpus test (11 rows) answering 'does any known bypass of EMAIL-03 still work?' in one place"
  - "The phase-closing dist/ reproduction table for VF-01, NEW-01, WR-02 curve, WR-02 cap, and the full historical bypass set (BL-01/02/03, CR-01/02)"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Boundary length-comparison cap at the adapter call site, not inside the pure stripper -- keeps stripHiddenContent's zero-import/pure/total contract unchanged while bounding attacker-chosen input cost at the one place untrusted content enters"
    - "Fail-closed-by-construction over-cap handling (fixed marker, zero conditional stripping) chosen over truncate-then-strip after measuring the rejected alternative's leak directly, rather than arguing it"

key-files:
  created: []
  modified:
    - src/source/gmail-adapter.ts
    - tests/gmail-hidden-content.test.ts

key-decisions:
  - "Cap value is 1,048,576 UTF-16 code units (1 MiB), chosen as the largest power-of-two bound under which EVERY shape in 62-14's ranked set -- Shape T (worst) and the comment/url-scanner shapes X/X3/Y/Z -- stays under the 1000ms budget. Re-measured through normalizeGmailMessage (not just stripHiddenContent): Shape T at 1 MiB = 439.0ms, 2 MiB = 1,721.0ms (already over budget), 4 MiB = 6,892.5ms; X/X3/Y/Z all under 15ms even at 4 MiB. Matches 62-14's planning-time prediction (435ms at 1 MiB) within ~1%."
  - "Fail-closed, not truncate-then-strip: measured, not argued. Constructed the rejected design (truncate the fail-closed control body to the cap length, THEN run stripHiddenContent on the truncated prefix) and confirmed PAYLOAD_TAIL_RULE -- hidden by a <style> rule that sits past the cut -- survives into the output. This is the exact leak class EMAIL-03 exists to forbid, so the over-cap branch replaces the body entirely with a fixed marker instead."
  - "MAX_STRIP_INPUT_CODE_UNITS is a module constant in gmail-adapter.ts, not a config field -- src/lib/config.ts is under the EMAIL-01/EMAIL-02 zero-diff freeze this phase must not break, and independent of that freeze a boundary safety limit that must not be weakened by configuration is the better shape on its own merits."
  - "The stripHiddenContent(raw.bodyText) call text is kept verbatim inside the ternary's at-or-below-cap branch (not rewritten as stripHiddenContent(bounded)) so the pre-existing source-order regression lock (tests/gmail-hidden-content.test.ts:117-124) passes unedited."

requirements-completed: [EMAIL-03]

duration: ~60min
completed: 2026-07-30
---

# Phase 62 Plan 15: WR-02 Input-Cap Gap Closure + Phase-Closing Evidence Pass Summary

**A 1 MiB (1,048,576 UTF-16 code unit) fail-closed bound on `raw.bodyText` at the one call site where untrusted email content enters `stripHiddenContent`, sized from plan 62-14's measured Shape T curve and proven fail-closed by directly measuring the rejected truncate-then-strip alternative's leak — plus a `dist/`-level reproduction of every finding this three-wave gap-closure charter (62-13/62-14/62-15) closed.**

## Performance

- **Duration:** ~60 min
- **Tasks:** 3
- **Files modified:** 2 (`src/source/gmail-adapter.ts`, `tests/gmail-hidden-content.test.ts`)

## Accomplishments

- Closed the input-cap half of WR-02: `raw.bodyText` is now bounded by `MAX_STRIP_INPUT_CODE_UNITS` (1,048,576) before it reaches `stripHiddenContent` at all — attacker-chosen input length no longer buys unbounded ingest CPU.
- Proved fail-closed is the only safe design by measurement, not argument: constructed the rejected truncate-then-strip alternative and confirmed it leaks `PAYLOAD_TAIL_RULE` (a payload hidden by a `<style>` rule sitting past the truncation cut) into the output.
- Sized the cap from plan 62-14's real measured numbers (re-verified independently through `normalizeGmailMessage`, not assumed from planning text): 1 MiB is the largest power-of-two bound under which every shape in 62-14's ranked twelve-shape set — Shape T (worst) plus the comment/url-scanner shapes X/X3/Y/Z — stays under the 1000ms budget.
- Shipped a consolidated `it.each` bypass-corpus test (11 rows) that answers "does any known bypass of EMAIL-03 still work?" in one place, covering CR-01, CR-02, BL-01, both BL-02 forms, BL-03, VF-01's three shapes, NEW-01's both-directions twin, and the WR-02 over-cap body.
- Reproduced every finding this wave (and the two prior waves' charters) closed against the built `dist/` artifact — VF-01 (x3), NEW-01 (x3), the WR-02 cost curve, the WR-02 cap (x2), BL-01, both BL-02 forms, CR-01, CR-02, and one BL-03 carrier — all PASS.
- Confirmed the EMAIL-01/EMAIL-02/EMAIL-04 zero-diff freeze holds: 0 commits on the frozen surface, 0-diff on `episode-order.ts`.
- Full suite: 3,115 passed / 4 skipped (194 files) — exact reconciliation against the 3,098/4/0/194 baseline (62-14 close) plus the 17 tests this plan added.

## Task Commits

1. **Task 1: Encode the cap's behavior and its cost bound as failing tests (measured RED)** — `4a310a0` (test)
2. **Task 2: Bound raw.bodyText fail-closed at the adapter boundary (GREEN)** — `c61d5e6` (feat)
3. **Task 3: Phase-closing evidence pass against the built dist/** — `c8b0c82` (test)

## Files Created/Modified

- `src/source/gmail-adapter.ts` — Adds `MAX_STRIP_INPUT_CODE_UNITS` (1,048,576) and `STRIP_INPUT_OMITTED_MARKER` (`'[body omitted: exceeds MAX_STRIP_INPUT_BYTES]'`) as module-scope constants with a four-part doc comment (why a cap exists, why fail-closed, why this value, why a module constant not config); bounds the `strippedBody` expression at the `stripHiddenContent` call site with a length comparison, keeping the exact `stripHiddenContent(raw.bodyText)` call text in the at-or-below-cap branch; extends the file-level `EMAIL-03:` doc-block entry. `parseEmailDate`, `resolveAccountQuery`, `extractBodyText`, `RealGmailFetcher`, and `GmailAdapter.pull` are byte-identical to before this plan (confirmed via `git diff -U0`, diff confined to exactly the two new constants, the bounded call-site expression, and two doc-comment extensions).
- `tests/gmail-hidden-content.test.ts` — New `describe('EMAIL-03 WR-02 — the body handed to stripHiddenContent is bounded (fail-closed)')` block (6 tests: over-cap drop, at-cap boundary, one-over-boundary, fail-closed design control, 4 MiB end-to-end cost bound, under-cap regression); new consolidated `describe('EMAIL-03 bypass corpus — does any known bypass of EMAIL-03 still work?')` block (`it.each` over an 11-row `BYPASS_CORPUS` table).

## Task 1 — RED Evidence

Verify command: `npx vitest run tests/gmail-hidden-content.test.ts`. Exited non-zero as required. **3 failing tests**, **31 passing** (34 total, up from 28 baseline + 6 new).

| # | Test | Failure mode | Observed |
|---|------|---------------|----------|
| 1 | over-cap drop | AssertionError — `record.content` contains `SENTINEL_OVER_CAP` (no cap exists yet, so the sentinel passes through unstripped) | 6ms |
| 2 | one over the boundary | AssertionError — marker absent, sentinel present (no cap exists yet) | 4ms |
| 3 | end-to-end cost bound (4 MiB Shape T < 500ms) | AssertionError — `6931.xx` not < `500` | 6,931ms (matches this executor's own re-measurement of ~6,892.5ms plus test-harness overhead) |

**Passed in the RED state, as expected:**
- **At-cap boundary** — PASSED. Without a cap, the ordinary full pipeline runs on any body regardless of length, so the sentinel is present and the payload is stripped exactly as it would be after the cap ships (the cap changes nothing for bodies at-or-below its own boundary).
- **Under-cap regression** — PASSED. The named fixture body is far under any plausible cap value, unaffected either way.
- **Fail-closed design control** — PASSED, for a reason distinct from the two above and worth stating explicitly: without a cap, the FULL un-truncated body (including the `<style>` rule that in the capped design sits "past the cut") reaches `stripHiddenContent` as one document, so the existing (post-62-13/62-14) harvest correctly recognizes the far-away `.legal{display:none}` rule and strips `PAYLOAD_TAIL_RULE` regardless of cap. This test is designed to distinguish fail-closed from truncate-then-strip, not RED from GREEN — it holds in both states for different reasons, and Task 2's separate rejected-design measurement (below) is what actually demonstrates the leak this test exists to forbid.

`git diff --exit-code src/` exited 0 (no production edit in Task 1). `npx tsc --noEmit` exited 0.

### Cap-sizing measurements (through `normalizeGmailMessage`, this executor's own re-measurement)

| shape | 1 MiB | 2 MiB | 4 MiB |
|---|---|---|---|
| **T** (worst-ranked in 62-14's set) | **438.972 ms** | **1,721.019 ms** | **6,892.517 ms** |
| X | 3.761 ms | 7.174 ms | 14.711 ms |
| X3 | 3.788 ms | 7.163 ms | 13.501 ms |
| Y | 0.826 ms | 1.603 ms | 3.000 ms |
| Z | 0.733 ms | 1.470 ms | 5.980 ms |

**Chosen cap: 1,048,576 (1 MiB) UTF-16 code units.** Shape T is the shape that bounds it — at 1 MiB it measures 438.972ms, comfortably under the 1000ms budget; at 2 MiB it already measures 1,721.019ms, over budget. X/X3/Y/Z are nowhere close to the bound at any measured size (max 14.711ms at 4 MiB). This confirms 62-14's planning-time prediction of ~435ms at 1 MiB for Shape T (this executor's own number: 438.972ms, within ~1%) and 62-15-PLAN.md's own expected answer.

## Task 2 — GREEN: Bound raw.bodyText fail-closed

`grep -n 'MAX_STRIP_INPUT' src/source/gmail-adapter.ts` shows the module-scope `const MAX_STRIP_INPUT_CODE_UNITS = 1048576;` declaration, whose doc comment names the review's `MAX_STRIP_INPUT_BYTES` term and explains the UTF-16-code-unit naming. `grep -c 'stripHiddenContent(raw.bodyText)' src/source/gmail-adapter.ts` → **1** — the exact call text survives, kept inside the at-or-below-cap ternary branch.

```ts
const strippedBody =
  raw.bodyText.length <= MAX_STRIP_INPUT_CODE_UNITS
    ? stripHiddenContent(raw.bodyText)
    : STRIP_INPUT_OMITTED_MARKER;
```

Over the cap, `stripHiddenContent` is not called on the body at all; `STRIP_INPUT_OMITTED_MARKER = '[body omitted: exceeds MAX_STRIP_INPUT_BYTES]'` — a fixed ASCII constant containing no sender-controlled bytes — stands in for it.

### Measured the rejected truncate-then-strip design directly

Scratch script (not committed): took the fail-closed design control's exact body from Task 1 (`<span class="legal">PAYLOAD_TAIL_RULE</span>` + filler + `<style>.legal{display:none}</style>`, total length = cap + 500), truncated it to the cap length (1,048,576), and ran `stripHiddenContent` on the truncated prefix alone (the rejected design's behavior).

```
bodyText.length = 1049076 (cap + 500 = 1049076)
truncatedPrefix.length = 1048576
truncatedPrefix contains the <style> tag? false   <- the hiding rule sits PAST the cut, as designed
--- REJECTED (truncate-then-strip) output ---
contains PAYLOAD_TAIL_RULE? true
output starts with: "PAYLOAD_TAIL_RULExxxxxxxxxxxxx..."
```

**Confirmed: the rejected design leaks `PAYLOAD_TAIL_RULE` verbatim.** The `.legal{display:none}` rule that would have hidden it never reaches the truncated prefix's harvest, so `PAYLOAD_TAIL_RULE` is emitted as visible prose — exactly the leak class EMAIL-03 forbids, introduced by a performance guard. This is the measured justification for choosing fail-closed over truncate-then-strip, not an assumption.

### Before/after wall-clock, 4 MiB Shape T through `normalizeGmailMessage`

| | elapsed |
|---|---|
| Before the cap (RED, Task 1) | 6,931ms (test-harness) / 6,892.5ms (scratch measurement) |
| After the cap (GREEN) | **0.236ms** |

Verify command: `npx vitest run tests/gmail-hidden-content.test.ts tests/gmail-adapter.test.ts tests/gmail-adapter-multiaccount.test.ts tests/strip-hidden.test.ts`. **306 passed (306)**, 0 failed. `npx tsc --noEmit` exited 0.

`git diff -U0 src/source/gmail-adapter.ts` confirms the diff is confined to: the two new constants + their doc comments, the bounded body expression at the `stripHiddenContent` call site, and the `EMAIL-03` file-level doc-block extension. `parseEmailDate`, `resolveAccountQuery`, `extractBodyText`, `RealGmailFetcher`, and `GmailAdapter.pull` are byte-identical. `git diff --exit-code src/source/strip-hidden.ts src/adapter/ src/lib/config.ts src/consolidation/ src/db/schema.ts` exited 0.

## Task 3 — Phase-Closing Evidence Pass Against the Built `dist/`

`npm run build` exited 0; `ls dist/src/source/strip-hidden.js dist/src/source/gmail-adapter.js` succeeded.

### Reproduction table (all `node -e` against `dist/`)

| Finding | Command (input) | Verbatim output | Status |
|---|---|---|---|
| VF-01 (realistic injection payload) | `normalizeGmailMessage` on the verifier's exact injection body | `content` = `"From: sender@example.com · Re: Regarding your application · Acct: default\nThanks for applying."`; contains "Thanks for applying."=true; contains "Ignore all prior instructions"=false | PASS |
| VF-01 (comma list) | `stripHiddenContent('<style>.other, /*x*/.legal{display:none}</style>ok<span class="other">PAYLOAD_VF3a</span><span class="legal">PAYLOAD_VF3b</span>')` | `"ok"` (both payloads absent) | PASS |
| VF-01 (CSS-string-context control) | `stripHiddenContent('<style>.x{content:"/*"}.legal{display:none}.y{content:"*/"}</style>ok<span class="legal">PAYLOAD_STR</span>')` | `"ok"` | PASS |
| VF-01 (url-token control) | `stripHiddenContent('<style>.a{background:url(evil/*)}.legal{display:none}.b{background:url(x*/y)}</style>ok<span class="legal">PAYLOAD_URL</span>')` | `"ok"` | PASS |
| NEW-01 (`<style>` unquoted `<`) | `stripHiddenContent('<style>a<x{display:none}</style>VISIBLE AFTER')` | `"VISIBLE AFTER"` | PASS |
| NEW-01 (`<script>` `if (a<x)`) | `stripHiddenContent('<script>if (a<x) {}</script>VISIBLE AFTER SCRIPT')` | `"VISIBLE AFTER SCRIPT"` | PASS |
| NEW-01 (both-directions twin) | `stripHiddenContent('<style>a<x{q:1}.legal{display:none}</style>ok<span class="legal">PAYLOAD_N1</span>Tail.')` | `"okTail."` | PASS |
| WR-02 cost curve | `stripHiddenContent(shapeReport(size))` at 64/128/256/512 KB | 0.639/0.402/0.642/1.318 ms vs. report's 1,983/7,904/31,616/126,422 ms | PASS |
| WR-02 cap (over-by-one) | `normalizeGmailMessage` on a cap+1-length sentinel body | marker present=true; sentinel present=false | PASS |
| WR-02 cap (4 MiB Shape T timed) | `normalizeGmailMessage` on 4 MiB Shape T | 0.313ms; marker present=true | PASS |
| BL-01 | `stripHiddenContent('<style x=a<b>.legal{display:none}</style>ok<span class="legal">PAYLOAD_A</span>')` | `"ok"` | PASS |
| BL-02 (`</style foo>`) | `stripHiddenContent('<style>.legal{display:none}</style foo>ok<span class="legal">PAYLOAD_B</span>')` | `"ok"` | PASS |
| BL-02 (`</style/>`) | `stripHiddenContent('<style>.legal{display:none}</style/>ok<span class="legal">PAYLOAD_B2</span>')` | `"ok"` | PASS |
| CR-01 | `stripHiddenContent('<div data-x="a>b" style="display:none">SECRET3</div>Visible.')` | `"Visible."` | PASS |
| BL-03 (Variation Selectors Supplement carrier, header path) | `normalizeGmailMessage` with Subject carrying `U+E0100..U+E0102` | content contains Variation Selectors Supplement=false; contains "Your application"=true | PASS |
| CR-02 (Tags-block, header path) | `normalizeGmailMessage` with Subject carrying the Tags-block "IGNORE" payload | content contains Tags-block=false; contains "Your application"=true | PASS |

The `dist/`-level WR-02 measurement at 512 KB (1.318ms) is well under the 1000ms bound, printed beside the report's own 126,422ms. The `dist/`-level cap reproduction shows the marker present and no body text for a body one code unit over the cap.

### Zero-diff regression checks (the verifier's own commands)

```
$ git log --oneline 0ef9b5a6..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts
(no output — 0 commits)

$ git diff --exit-code 0ef9b5a6..HEAD -- src/consolidation/episode-order.ts
(exit 0 — no diff)
```

### Consolidated bypass-corpus test

`describe('EMAIL-03 bypass corpus — does any known bypass of EMAIL-03 still work?')` — `it.each` over an 11-row `BYPASS_CORPUS` table: CR-01, CR-02, BL-01, BL-02 (`</style foo>`), BL-02 (`</style/>`), BL-03, VF-01 (realistic payload), VF-01 (comma-list, first payload), VF-01 (comma-list, second payload), NEW-01 (both-directions twin), WR-02 cap (over-cap drop). Each row asserts the payload is absent from `record.content` AND the corresponding visible prose is present. All 11 PASS.

### Full-suite reconciliation

`npx vitest run` (full suite): **193 passed | 1 skipped (194 files); 3,115 passed | 4 skipped (0 failed) of 3,119 tests.**

Baseline (62-14-SUMMARY.md close): 3,098 passed / 4 skipped / 0 failed of 3,102 tests.

**Reconciliation:** This plan added exactly 17 tests — 6 in Task 1's WR-02 fail-closed describe block, 11 in Task 3's bypass-corpus `it.each`. `3,098 + 17 = 3,115` — exact reconciliation, no unexplained delta.

Full-phase reconciliation from the original `62-VERIFICATION.md` baseline (3,018 passed / 3 skipped / 0 failed / 194 files): 62-13 added 68 (net 3,085 after a one-test environment-conditional skip delta) → 62-14 added 13 (3,098) → 62-15 added 17 (**3,115**, matches the observed count exactly).

`npx tsc --noEmit` exits 0. `git diff --exit-code src/source/strip-hidden.ts src/adapter/ src/lib/config.ts src/consolidation/ src/db/schema.ts` exits 0. `git log --oneline 0ef9b5a6..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts` returns 0 commits — the frozen EMAIL-01/02/04 surface is untouched. `git diff --stat df2fca7..HEAD` touches exactly two files: `src/source/gmail-adapter.ts` and `tests/gmail-hidden-content.test.ts`.

## Decisions Made

See `key-decisions` in frontmatter. The most consequential: fail-closed over truncate-then-strip is justified by a direct measurement of the rejected design's leak (`PAYLOAD_TAIL_RULE` survives), not by argument alone — matching the plan's explicit requirement that the choice be "disproven the other way," not merely avoided.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing functionality, or blocking issues were found outside the plan's own charter.

**One in-scope wording adjustment (not a Rule 1-3 auto-fix):** the doc comment on the bounded call site initially repeated the literal substring `stripHiddenContent(raw.bodyText)` in an explanatory comment above the actual call, which — while harmless to the source-order lock's `indexOf` check (the comment occurrence still precedes `redactSecrets(combined)`) — created two occurrences of the exact call text in the file instead of one, muddying the "kept verbatim, exactly once" acceptance criterion. Reworded the comment to describe the call in prose without repeating the literal string. `grep -c 'stripHiddenContent(raw.bodyText)' src/source/gmail-adapter.ts` now returns exactly 1. No behavior change; committed as part of Task 2 (`c61d5e6`), not a separate deviation entry since it was caught and fixed before that commit, mirroring 62-13's own precedent for acceptance-criteria wording conflicts.

---

**Total deviations:** 0 auto-fixed (Rules 1-3); 1 in-task wording self-correction, resolved before commit.
**Impact on plan:** No scope creep. All work stayed within `src/source/gmail-adapter.ts` and `tests/gmail-hidden-content.test.ts`.

## Issues Encountered

None.

## Deliberately Unfixed Findings (Named, Carried Forward — Still-Open Ledger)

| Finding | Status |
|---|---|
| **T-62-54** (Shape T, `STYLE_BLOCK_RE`'s lazy `</style>` tail scan) | Bounded, not fixed. Its worst-case cost at the 1 MiB cap is ~439ms (measured, this plan); above the cap the marker replaces the body entirely so the algorithm never runs on attacker-chosen sizes beyond the bound. The quadratic itself remains in `strip-hidden.ts`, untouched per this plan's charter. |
| **WR-01** (MSO-conditional-comment-wrapped `<style>` destroys visible prose) | Named, not fixed. Confirmed still live as of `62-VERIFICATION.md`; adjacent to Phase 65's DRIFT-03 provenance work. |
| **WR-03** (`<style/>` self-closing mismatch: stage 2 harvests it as a block, stage 4 treats it as self-closing and leaves the raw CSS as visible prose) | Named in `62-REVIEW.md`, not fixed. Opposite-direction cross-stage disagreement from BL-02 (content-destruction risk is a leak of *raw CSS as prose*, not hidden-content survival) — outside `strip-hidden.ts`'s freeze for this plan. |
| **WR-04** (22 of 26 "stage-1 extraction is behavior-preserving" test cases in `strip-hidden.test.ts` are tautological — `f(s) === f(s)` for inputs with no invisible codepoint) | Named in `62-REVIEW.md`, not fixed. Test-quality issue in a frozen-for-this-plan test file. |
| **WR-05** (the invisible-codepoint coverage table in `strip-hidden.test.ts`/`gmail-hidden-content.test.ts` asserts the implementation's own codepoint ranges against itself, not the threat class) | Named in `62-REVIEW.md`, not fixed. Test-quality issue. |
| **WR-06** (the CR-01 "bug-class guard" is two `not.toContain` string checks that cannot structurally catch the bug class it claims to guard) | Named in `62-REVIEW.md`. The shared-`ATTRS`-fragment construction (62-12) resolves this in practice — a fifth regex built from `ATTRS` cannot reintroduce the bug — but the guard test itself was not rewritten to assert structurally. |
| **WR-07** (`GmailAdapter.pull()` reads `Date.now()` directly, bypassing the codebase's `Clock`/`FakeClock` seam — the CR-03 clamp is untestable end-to-end and one test depends on wall-clock) | Named in `62-REVIEW.md`, not fixed. Outside this plan's `gmail-adapter.ts` scope (the change would touch `GmailAdapter`'s constructor signature, not `normalizeGmailMessage`). |
| **WR-08** (the ` · ` provenance-delimiter forgery in `From:`/`Subject:` headers) | Confirmed still live (`62-VERIFICATION.md`). Deliberately not addressed by this plan — visible-content forgery, not hidden content; adjacent to Phase 65's DRIFT-03 provenance-distinctness work. |
| **IN-01** (`MAX_HARVESTED_SELECTORS` comment overstates what the cap does — it bounds selector-set size, not the stage-2 quadratic) | Named in `62-REVIEW.md`, not fixed. Doc-comment accuracy issue in `strip-hidden.ts`, frozen for this plan. |
| **IN-02** (the `lastIndex` regression lock in `strip-hidden.test.ts` cannot fail — the property it locks is spec-guaranteed) | Named in `62-REVIEW.md`, not fixed. |
| **IN-03** (wall-clock threshold assertions in the ReDoS tests are CI-flaky on a loaded runner) | Named in `62-REVIEW.md`, not fixed. This plan's own new tests use the same pattern (`expect(elapsed).toBeLessThan(...)`) deliberately, per the plan's explicit instruction, so IN-03's concern applies equally to the tests this plan added. |
| **IN-04** (`parseEmailDate` returns `NaN` instead of `null` when `nowMs` is itself `NaN`) | Named in `62-REVIEW.md`, not fixed. `parseEmailDate` is frozen (EMAIL-04, verified SATISFIED) — explicitly out of scope for this plan. |

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- WR-02 is fully closed: the algorithmic half (62-14, two exact linear bounds) and the input-cap half (this plan, fail-closed 1 MiB bound) together mean no attacker-chosen `raw.bodyText` size or shape buys more than a bounded, sub-second cost through `normalizeGmailMessage`.
- VF-01, NEW-01, and WR-02 all reproduce as CLOSED against the built `dist/` artifact using the verification report's own inputs and sizes.
- The EMAIL-01/EMAIL-02/EMAIL-04 zero-diff checks the verifier re-runs return clean (0 commits on the frozen surface, 0-diff on `episode-order.ts`).
- One named consolidated test (`EMAIL-03 bypass corpus`) answers "does any known bypass of EMAIL-03 still work?" across 11 historical/adversarial inputs in a single run.
- The still-open ledger above (WR-01, WR-03..WR-08, IN-01..IN-04, T-62-54) is accurate and carried forward for the next verification pass to inherit rather than rediscover.
- `src/adapter/gmail-auth-cli.ts`, `src/adapter/runtime-config.ts`, `src/adapter/recense-doctor.ts`, `src/lib/config.ts`, `src/consolidation/episode-order.ts`, and `src/source/strip-hidden.ts` are untouched by this plan — 0 commits / clean diff, confirmed by the verifier's own commands.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*
