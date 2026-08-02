---
phase: 63-offline-intent-classification
plan: 02
subsystem: ingestion
tags: [prompt-engineering, gmail, extraction, llm-prompt, classification]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening
    provides: EMAIL-03 hidden-content stripping (hard prerequisite before classification touches gmail content)
provides:
  - Shared GMAIL_INTENT_CLASSIFICATION_BLOCK constant carrying the four-state field contract,
    ambiguity-omit rule, confidence rubric, weak-prior domain caveat, and untrusted-content clause
  - Both gmail prompt constants (baseline + episodic) emitting intent_status/intent_entity/intent_confidence
  - Non-vacuous CLASSIFY-04 structural guard proving no ATS sender-domain fingerprint table exists in src/
affects: [63-04-consolidator-threading, 63-05-invariant-guards, 63-06-token-cost-measurement, 65-belief-gated-status-drift]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared prompt-block-as-constant interpolated via template-literal ${...} into multiple
      prompt variants, so an env-gated superset prompt cannot silently diverge from or drop
      instructions the baseline prompt carries (D-10 anti-drift measure)"
    - "Structural no-fingerprint-table guard: exported pure predicate + real src/ walk +
      non-vacuousness synthetic-offender test + explicit prose-allowed test, mirroring
      tests/src-import-boundary.test.ts's three-part shape"

key-files:
  created:
    - tests/extraction-prompts-intent.test.ts
    - tests/no-ats-domain-table.test.ts
    - .planning/phases/63-offline-intent-classification/deferred-items.md
  modified:
    - src/source/extraction-prompts.ts

key-decisions:
  - "Coverage-boundary sentence in the shared prompt block was worded WITHOUT naming specific
    extraction categories (receipts/flights/etc.) — naming them leaked those words into the
    BASELINE gmail prompt via the shared-block interpolation and broke a no-flight/receipt
    baseline assertion (Rule 1 fix, see Deviations)"

requirements-completed: [CLASSIFY-01, CLASSIFY-04]

# Metrics
duration: ~15min
completed: 2026-08-02
---

# Phase 63 Plan 02: Gmail Intent-Classification Prompt Summary

**Authored the gmail intent-classification prompt block as one shared constant interpolated into both existing gmail extraction prompts — zero new prompt variants, zero new LLM calls, zero ATS domain fingerprint table.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-08-02T20:43:27Z
- **Tasks:** 3
- **Files modified:** 1 created, 2 new test files, 1 deferred-items log

## Accomplishments

- `GMAIL_INTENT_CLASSIFICATION_BLOCK` — a single shared prompt-text constant carrying the
  four-state field contract, state definitions, ambiguity-omit instruction, confidence rubric,
  sender-domain weak-prior caveat, untrusted-content clause, and coverage boundary — interpolated
  identically into both `GMAIL_EXTRACTION_PROMPT` and `GMAIL_EPISODIC_EXTRACTION_PROMPT`
- 24 routing/ordering/isolation tests proving: always-on across all `RECENSE_ENABLE_EPISODIC_EMAIL`
  values, the existing temporal gate stays unbroken, zero classification leakage into 7 non-gmail
  sources, prefix-first ordering (`intent_status` precedes `Document type: `)
- 3 tests shipping the CLASSIFY-04 structural guard: a real `src/` walk finds zero ATS domain
  literals, a non-vacuousness check proves the predicate actually fires, and a prose-allowed
  check proves the guard forbids the fingerprint table, not the ATS concept

## Task Commits

Each task was committed atomically:

1. **Task 1: Author GMAIL_INTENT_CLASSIFICATION_BLOCK and interpolate it into both gmail prompts** - `8c809c9` (feat)
2. **Task 2: Prompt routing, ordering, and isolation tests** - `d848e81` (test) — includes the Rule 1 wording fix to Task 1's block, discovered while writing this task's baseline no-flight/receipt assertion
3. **Task 3: CLASSIFY-04 structural guard — no ATS sender-domain fingerprint table anywhere in src/** - `6f97eb1` (test)

_Note: worktree-mode plan (STATE.md/ROADMAP.md updates owned by the orchestrator, not this agent). No separate `docs:` metadata commit — SUMMARY.md commit is the final commit for this agent._

## Files Created/Modified

- `src/source/extraction-prompts.ts` - Adds `GMAIL_INTENT_CLASSIFICATION_BLOCK` constant and its interpolation into both gmail prompt constants (baseline example array gains one rejection-classified item; episodic example array gains one interviewing-classified item)
- `tests/extraction-prompts-intent.test.ts` - Routing/ordering/isolation/coverage-boundary test suite for the new block
- `tests/no-ats-domain-table.test.ts` - CLASSIFY-04 non-vacuous structural guard (exported `findAtsDomainOffenders` predicate + `ATS_DOMAIN_TOKENS` list)
- `.planning/phases/63-offline-intent-classification/deferred-items.md` - Logs 23 pre-existing, out-of-scope full-suite CLI subprocess test failures observed during verification

## The Confidence Rubric (verbatim — Phase 65 consumes this as the input to its PE-magnitude mapping decision)

> Confidence rubric: "high" means the email explicitly states the transition in its own words about an identifiable application. "medium" means the transition is clear but the entity or exact state must be inferred from surrounding context. "low" means the email is clearly about a specific application but the state is only indirectly worded. "low" is NOT the dumping ground for ambiguity — when in doubt whether the email is about a specific application at all, omit all three fields instead of emitting "low".

## Decisions Made

- Field names `intent_status` / `intent_entity` / `intent_confidence` and status literals `applied|interviewing|rejected|offer` were used verbatim in the prompt text to match the exact vocabulary `src/model/claim-extractor.ts` defines (per the plan's `read_first` cross-reference to that file's field-name source of truth — landed in the sibling 63-01 plan, out of this plan's file scope).
- The classification block's example JSON items were placed as an ADDITIONAL array entry in each prompt (not a replacement), preserving every existing unclassified example item so the array itself demonstrates all-or-nothing field presence.
- ATS domain token list (`ATS_DOMAIN_TOKENS`) is exported from the test file itself (not from `src/`) so the guard's ban list cannot become a fingerprint table living in production code — the guard's own list only needs to exist at test time.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Coverage-boundary sentence leaked "receipts" into the baseline gmail prompt, breaking a new isolation assertion**
- **Found during:** Task 2 (writing the coverage-boundary test)
- **Issue:** The initial wording of the shared block's coverage-boundary sentence ("no new coverage of receipts, shipping, or newsletter content...") named `receipts` literally. Because the block is interpolated identically into BOTH the baseline and episodic gmail prompts, that word leaked into the BASELINE prompt too — which broke the new `expect(prompt.toLowerCase()).not.toContain('receipt')` isolation test (baseline should read like the pre-classification prompt plus classification only, never mentioning episodic-only concepts).
- **Fix:** Reworded the sentence to state the boundary without naming specific extraction categories: "this block adds no new extraction coverage beyond what this prompt already extracts elsewhere." Preserves the semantic constraint (folded todo, content-hardening §3) without introducing category-name leakage.
- **Files modified:** `src/source/extraction-prompts.ts`
- **Verification:** `npx vitest run tests/extraction-prompts-intent.test.ts tests/extraction-prompts-temporal.test.ts` — 24/24 pass
- **Committed in:** `d848e81` (part of Task 2 commit — the fix and the test that caught it landed together)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary correctness fix caught by the plan's own test-writing process; no scope creep, no architectural change.

## Issues Encountered

Two acceptance-criteria misses were self-corrected before commit (not counted as plan deviations — caught during acceptance verification, not after):
- Initial JSDoc comments referenced the literal string `GMAIL_INTENT_CLASSIFICATION_BLOCK` twice extra, pushing `grep -c` to 5 instead of the required 3 (1 declaration + 2 interpolations). Reworded both JSDoc mentions to "the shared intent-classification block" before Task 1's commit.

Full-suite `npx vitest run` shows 23 pre-existing failures in 7 subprocess-CLI test files unrelated to this plan's files (see `deferred-items.md`) — not fixed, out of scope per the executor scope-boundary rule.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Both gmail prompts now emit the classification fields identically regardless of the episodic env flag — 63-04 (consolidator threading) can rely on `promptForSource('gmail')` always carrying classification instructions.
- CLASSIFY-04's "no fingerprint table" clause is now enforced by a shipped, non-vacuous test — future plans in this phase (or Phase 64/65) that touch `src/` will fail CI if they introduce an ATS domain literal.
- The confidence rubric above is locked language Phase 65 should treat as the source of truth for its PE-magnitude mapping decision.
- No blockers. `npm run typecheck` clean; all three plan-scoped test files pass (27/27); `git diff --exit-code package.json package-lock.json` clean (no new dependency).

---
*Phase: 63-offline-intent-classification*
*Completed: 2026-08-02*
