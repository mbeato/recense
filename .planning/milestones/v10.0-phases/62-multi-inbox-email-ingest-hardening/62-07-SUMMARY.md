---
phase: 62-multi-inbox-email-ingest-hardening
plan: 07
subsystem: security
tags: [email-ingest, prompt-injection, regex, redos, gap-closure]

# Dependency graph
requires:
  - phase: 62-03
    provides: stripHiddenContent (EMAIL-03 hidden-content stripper, 8-stage pipeline)
provides:
  - Quote-aware attribute scanning across all three tag-matching regexes in stripHiddenContent, closing the CR-01 EchoLeak-class bypass
  - Named + measured accepted residual (c): unbalanced-quote fail-safe truncation
  - Adversarial-input cost bound (500ms wall-clock gate, doubling-ratio gate) proving no ReDoS regression
affects: [63-offline-intent-classification]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Quote-aware tag-boundary regex alternation: (?:\"[^\"]*\"|'[^']*'|[^'\"<>])* — three module-scope regexes must change together or stages disagree about tag boundaries"]

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts
    - tests/gmail-hidden-content.test.ts

key-decisions:
  - "All three tag regexes (START_TAG_RE, ANY_TAG_TOKEN_RE, ANY_TAG_RE) changed together in one task rather than incrementally, per the plan's hard requirement — a partially-applied fix would relocate the boundary-disagreement bug class rather than close it"
  - "Accepted a new named residual (c): unbalanced quotes inside a tag now cause fail-safe truncation to end of string rather than the previous leak-shaped passthrough — this is a deliberate, tested trade explicitly required by the CR-01 fix, not an oversight"
  - "Did not fix the pre-existing stage-6 O(n^2) cost — measured, named, and flagged for backlog per plan scope; this plan's regex change is not the cause"

requirements-completed: [EMAIL-03]

# Metrics
duration: ~15min
completed: 2026-07-30
---

# Phase 62 Plan 07: Quote-Aware CR-01 Fix Summary

**Closed the EchoLeak-class CR-01 bypass by making all three `stripHiddenContent` tag regexes quote-aware, so a literal `>` inside a quoted attribute value can no longer truncate a tag match before the hiding declaration is seen — verified at both the unit and episode-content level, with the one resulting behavior change locked as a named residual and adversarial input measured to stay polynomial.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-30
- **Tasks:** 3 (RED / GREEN / adversarial cost bound)
- **Files modified:** 3 (1 production, 2 test)

## Accomplishments

- Closed `62-REVIEW.md` CR-01 (critical): a `>` inside a quoted attribute value (double-quote, single-quote, or a CSS string literal like `content:'>'`) no longer truncates the tag match early, so `isHiddenStartTag` reliably sees the `style="display:none"` (or `aria-hidden`, or class-hidden-via-harvested-`<style>`) declaration
- Verified the fix at the episode-content level (`normalizeGmailMessage(...).content`), not just the stripper's raw return value
- Kept all three regexes (`START_TAG_RE`, `ANY_TAG_TOKEN_RE`, `ANY_TAG_RE`) in agreement about where a tag ends, preserving `ANY_TAG_RE`'s deliberate `[^'">]` (not `[^'"<>]`) asymmetry
- Locked the one behavior change (unbalanced-quote fail-safe truncation) as a new named residual `(c)` in the module doc block, with two regression tests
- Measured and recorded a four-point adversarial cost curve pre- and post-fix, proving the fix stays polynomial and does not introduce ReDoS

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the failing regression cases first (RED)** - `0f89d5a` (test)
2. **Task 2: Make all three tag regexes quote-aware (GREEN)** - `b3c9750` (fix)
3. **Task 3: Bound the backtracking cost on adversarial input** - `a2a2584` (test)

**Plan metadata:** committed as part of this SUMMARY commit (worktree mode — STATE.md/ROADMAP.md updates deferred to orchestrator)

## RED evidence (Task 1)

Verify command exited non-zero as required: 7 of 61 tests in `tests/strip-hidden.test.ts` + `tests/gmail-hidden-content.test.ts` failed before the fix.

| Input | Verbatim leaked output (observed) |
|---|---|
| `<div data-x="a>b" style="display:none">SECRET3</div>Visible.` | `b" style="display:none">SECRET3Visible.` |
| `<div style="content:'>';display:none">HIDDEN INSTRUCTION PAYLOAD</div>Visible.` | `';display:none">HIDDEN INSTRUCTION PAYLOADVisible.` |
| `<div data-x='a>b' style='display:none'>SECRET4</div>Visible.` | `b' style='display:none'>SECRET4Visible.` |
| `<span title="a>b" aria-hidden="true">SECRET8</span>Keep.` | `b" aria-hidden="true">SECRET8Keep.` |
| `<style>.h{display:none}</style><div data-t="x>y" class="h">SECRET9</div>Visible.` | `y" class="h">SECRET9Visible.` |
| `bodyText` with `data-x="a>b"` variant (episode-content case) | leaked `IGNORE ALL PREVIOUS INSTRUCTIONS` into `record.content` |
| `bodyText` with `content:'>'` variant (episode-content case) | leaked `IGNORE ALL PREVIOUS INSTRUCTIONS` into `record.content` |

These exactly match the reproductions in `62-REVIEW.md` CR-01 and the plan's expected observations. The unquoted-`>` no-over-correction case (`SECRET6` present) passed in this state, as a control. All pre-existing tests passed. `git diff --exit-code src/source/strip-hidden.ts` exited 0 (no production edit in Task 1).

## The three final regex literals (Task 2)

```
const START_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/g;
const ANY_TAG_TOKEN_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b(?:"[^"]*"|'[^']*'|[^'"<>])*>/g;
const ANY_TAG_RE = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
```

**Why all three had to change together:** `START_TAG_RE` drives `collectRemovalRanges`, which feeds stage 5's `isHiddenStartTag`; `ANY_TAG_TOKEN_RE` drives `findMatchingCloseEnd`'s nesting scan, which decides where a removed element's content ENDS; `ANY_TAG_RE` drives stage 6's leftover-tag sweep. If only `START_TAG_RE` became quote-aware, stage 5 would correctly identify a hidden element's start tag while `findMatchingCloseEnd` (still using the old `[^<>]` class) mis-located its matching close tag — producing a removal range that is too short (leaking part of the hidden payload) or too long (deleting adjacent visible prose). All three now agree: only an UNQUOTED `<` or `>` terminates a tag. `ANY_TAG_RE` deliberately keeps its narrower unquoted class `[^'">]` (permits `<` inside a stage-6 match), preserving pre-existing behavior per the plan's interface note — this was NOT unified with the other two.

Capture-group numbering is unchanged in all three (verified `collectRemovalRanges`/`findMatchingCloseEnd` needed no edits — confirmed by reading them and by `git diff -U0` showing changes confined to the three regex declarations, their adjacent comments, and the file-level doc block).

## Accepted residual (c): unbalanced-quote fail-safe truncation

The quote-aware fix has exactly one behavior change, measured during planning and locked by two tests:

| Input | Shipped (pre-fix) output | Quote-aware (post-fix) output |
|---|---|---|
| `<div title="unclosed>Visible after.<a href="x">link</a>Tail.` | `Visible after.linkTail.` | `` (empty — `.trim() === ''`) |
| `<div title="unclosed>mid" class="c">Visible after.` | `mid" class="c">Visible after.` | `Visible after.` (no `class="c"`) |

With an unbalanced quote, no tag match succeeds under the quote-aware alternation, so stage 6's existing stray-`<` fail-safe truncates from the first `<` to end of string. This is accepted as residual `(c)`, documented in the module's doc block alongside the two pre-existing residuals (a) white-text-on-white and (b) externally-linked stylesheets — because guessing where a malformed tag ends is exactly the ambiguity CR-01 exploited, and it strictly improves the second case shown above (the shipped code leaked `class="c">Visible after.`; the fix drops only the malformed prefix).

Suite counts after Task 2, restricted to files relevant to this module: `tests/strip-hidden.test.ts` + `tests/gmail-hidden-content.test.ts` + `tests/gmail-adapter.test.ts` = 82 passed, 0 failed.

## Adversarial cost curve (Task 3)

Measured with `performance.now()` around a single `stripHiddenContent` call, Shape A (`'<div a="' + 'y'.repeat(50)'` repeated, no `>` anywhere, forcing every `<` through a full failing forward scan):

| Size | Pre-fix (observed) | Post-fix (observed) | Post/Pre ratio |
|---|---|---|---|
| ~58 KB | 21.4 ms | 67.8 ms | 3.17x |
| ~116 KB | 82.3 ms | 261.7 ms | 3.18x |
| ~232 KB | 381.0 ms | 1022.8 ms | 2.68x |
| ~464 KB | 1440.6 ms | 4092.8 ms | 2.84x |

Per-doubling growth ratios:
- Pre-fix: 82.3/21.4=3.85x, 381.0/82.3=4.63x, 1440.6/381.0=3.78x
- Post-fix: 261.7/67.8=3.86x, 1022.8/261.7=3.91x, 4092.8/1022.8=4.00x

Both curves sit consistently around ~4x per doubling — i.e. **stage 6 is O(n^2) in input length both before and after this fix.** This change multiplies the constant factor by roughly 2.7-3.2x (matching the plan's ~3x planning-time estimate) but does not change the complexity class. In-test assertions (independent of the above manual measurement script) confirmed: Shape A and Shape B at ~64 KB each complete under 500ms, and the 32KB->64KB doubling-ratio gate (`t64/max(t32,1) <= 8`) passed, well clear of the catastrophic-backtracking threshold.

**Named finding (not fixed, flagged for backlog):** `stripHiddenContent` is pre-existing O(n²) in stage 6 for input containing many `<` and no `>`, and `normalizeGmailMessage` applies it to the untruncated Gmail body (`stripHiddenContent(raw.bodyText)`, no length cap). A ~1 MB adversarial HTML email would cost single-digit seconds of CPU on the ingest path. This is pre-existing (confirmed present before this plan's changes, see pre-fix column above), not introduced by this plan, and deliberately not fixed here — it needs its own scoped decision (an input length cap, or a cheap pre-scan) and would be scope creep in a security regression fix.

## Full-suite counts

`npx vitest run` (whole repo, this worktree): 184 test files passed / 7 failed, 2847 passed / 23 failed / 9 skipped (2879 total). All 7 failing files (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`) spawn CLI binaries from `dist/src/adapter/*.js`, which does not exist in this worktree (no build step has run) — none reference `strip-hidden.ts` or `stripHiddenContent`. Excluding those 7 pre-existing-broken files: **184 test files passed / 2 skipped, 2829 passed / 5 skipped, 0 failed** — no regressions from this plan's changes. Logged to `deferred-items.md` per scope boundary (not fixed; out of scope for a security regression plan).

`npx tsc --noEmit` exits 0.

## Files Created/Modified

- `src/source/strip-hidden.ts` - Three tag regexes made quote-aware; doc block gained named residual (c)
- `tests/strip-hidden.test.ts` - CR-01 regression cases, unquoted-`>` lock, unbalanced-quote residual-(c) lock, adversarial cost-bound describe block, all six/eight new inputs added to idempotence fixtures
- `tests/gmail-hidden-content.test.ts` - Two episode-content-level CR-01 regression cases

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

None beyond what the plan itself scoped as expected/required (the unbalanced-quote residual (c) behavior change was explicitly anticipated and specified by the plan, not discovered ad hoc).

### Auto-fixed Issues

**1. [Rule 3-adjacent, scope-boundary] Logged pre-existing dist/-dependent CLI test failures as deferred, not fixed**
- **Found during:** Task 2 full-suite verification
- **Issue:** 7 test files spawn compiled binaries from `dist/src/adapter/*.js`; `dist/` does not exist in this worktree, so all 23 tests in those files fail regardless of this plan's changes
- **Fix:** None applied — out of scope per the executor's scope-boundary rule ("do not re-run builds hoping they resolve themselves"). Logged to `.planning/phases/62-multi-inbox-email-ingest-hardening/deferred-items.md`
- **Files modified:** `.planning/phases/62-multi-inbox-email-ingest-hardening/deferred-items.md` (new)
- **Verification:** Confirmed via `grep -l "strip-hidden\|stripHiddenContent"` across all 7 failing files — zero matches
- **Committed in:** `b3c9750` (part of Task 2 commit)

---

**Total deviations:** 1 logged-and-deferred (out of scope, not auto-fixed)
**Impact on plan:** None on this plan's own scope. The pre-existing dist/ build gap is unrelated to `strip-hidden.ts` and does not affect CR-01's closure or the plan's verification criteria, which target the strip-hidden/gmail-hidden-content/gmail-adapter test files specifically.

## Issues Encountered

None beyond the deferred item above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CR-01 is closed: quoted `>` before a hiding declaration no longer leaks hidden content, verified at both unit and episode-content granularity
- The remaining `62-REVIEW.md` items this gap-closure wave targets (WR-01, VERIFICATION gaps[0]) are addressed by sibling plans 62-06/62-08, not this plan
- Pre-existing stage-6 O(n²) cost is now measured and named — a candidate backlog item for future hardening (input length cap or cheap pre-scan), not blocking Phase 63

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*

## Self-Check: PASSED

- FOUND: src/source/strip-hidden.ts
- FOUND: tests/strip-hidden.test.ts
- FOUND: tests/gmail-hidden-content.test.ts
- FOUND: .planning/phases/62-multi-inbox-email-ingest-hardening/deferred-items.md
- FOUND commit: 0f89d5a (Task 1 RED)
- FOUND commit: b3c9750 (Task 2 GREEN)
- FOUND commit: a2a2584 (Task 3 adversarial cost bound)
