---
phase: 40-competitive-benchmark-baseline
plan: 01
subsystem: eval
tags: [benchmark, locomo, dataset, test-scaffold, wave-0]
dependency_graph:
  requires: []
  provides:
    - scripts/eval/locomo10.json (acquired, gitignored — CC BY-NC 4.0)
    - scripts/eval/fixtures/locomo-mini.json
    - tests/locomo-scorer.test.ts
    - tests/locomo-harness.test.ts
  affects:
    - .gitignore
tech_stack:
  added: []
  patterns:
    - Wave 0 dataset acquisition before harness build
    - Test scaffolds with it.skip naming the unblocking plan
key_files:
  created:
    - scripts/eval/fixtures/locomo-mini.json
    - tests/locomo-scorer.test.ts
    - tests/locomo-harness.test.ts
  modified:
    - .gitignore
decisions:
  - "locomo-mini.json uses flat top-level sessions (normalised from conversation-nested raw schema)"
  - "Turn field is 'speaker' not 'name' — RESEARCH inaccuracy corrected in tests and fixture"
  - "locomo10.json already present in worktree from pre-existing work — verified and gitignored"
metrics:
  duration: "~25 minutes"
  completed: "2026-06-23"
  tasks_completed: 3
  tasks_total: 3
  files_created: 3
  files_modified: 1
requirements: [BENCH-01]
---

# Phase 40 Plan 01: LoCoMo Dataset Acquisition and Wave 0 Test Scaffolds

Wave 0 foundation for the LoCoMo benchmark: acquired LoCoMo-10 dataset, verified category codes empirically, built the dry-run fixture, and stood up unit-test scaffolds pinning the category-5 filter and R@K session-hit logic.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Acquire LoCoMo-10, gitignore, verify categories | `3d552d7` | `.gitignore` |
| 2 | Build locomo-mini.json dry-run fixture | `b2e8952` | `scripts/eval/fixtures/locomo-mini.json` |
| 3 | Wave 0 unit-test scaffolds | `ff198dd` | `tests/locomo-scorer.test.ts`, `tests/locomo-harness.test.ts` |

## Category Code Verification (Assumption A2 mitigation)

Empirically counted category values across all 10 conversations (1,986 total QA pairs):

| Category | Label | Count | Notes |
|----------|-------|-------|-------|
| 1 | Multi-hop | 282 | |
| 2 | Temporal | 321 | |
| 3 | Open-domain | 96 | |
| 4 | Single-hop | 841 | |
| 5 | Adversarial | 446 | EXCLUDED from scoring denominator |
| **Total** | | **1,986** | |
| **Scoreable** | non-cat5 | **1,540** | Within expected band (not >1,600) |

Confirms: category 5 is adversarial and present; scoreable total 1,540 is plausible (RESEARCH estimated ~1,491 based on secondary sources; 1,540 is within the ballpark and not above the 1,600 red-flag threshold). The scorer must filter `qa.category === 5` to avoid inflating the J score.

## Schema Deviation Found

RESEARCH documented LoCoMo turns as `{name, dia_id, text}` but the actual `locomo10.json` uses `{speaker, dia_id, text}`. Additionally, sessions are nested under a top-level `conversation` key in the raw dataset, not at the top level of each conversation object.

**Actual raw schema (abbreviated):**
```
{ sample_id, conversation: { speaker_a, speaker_b, session_1: [{speaker, dia_id, text}], session_1_date_time, ... }, qa: [...] }
```

**Fixture normalisation:** `locomo-mini.json` flattens sessions to top-level (matching the PLAN's intended target format for the harness). The harness implementation (Plan 40-02) must read sessions from `c.conversation.session_N` in the raw locomo10.json.

**Tests corrected:** Both test files check for `speaker` (not `name`). This prevents Plan 40-02/03 from silently building against the wrong field name.

## Deviations from Plan

### Auto-corrected Schema Inaccuracy

**[Rule 1 - Bug] Actual turn field is 'speaker' not 'name'**
- **Found during:** Task 3 (inspecting locomo10.json before writing tests)
- **Issue:** RESEARCH documented `{name, dia_id, text}` turns; actual data uses `{speaker, dia_id, text}`. Sessions in raw locomo10.json are nested under `conversation.session_N`, not top-level.
- **Fix:** Test files check `speaker` field; fixture built with actual native shape; downstream plan authors warned via comments.
- **Files modified:** `tests/locomo-harness.test.ts`, `tests/locomo-scorer.test.ts`, `scripts/eval/fixtures/locomo-mini.json`
- **Commits:** `ff198dd`, `b2e8952`

## Test Results

```
Test Files  2 passed (2)
     Tests  4 passed | 2 skipped (6)
```

- **4 active tests pass:** fixture contract, mini.json schema, full dataset schema (conditional on locomo10.json), R@K session-hit predicate math
- **2 scaffolds correctly skipped:** scorer denominator (Plan 40-03 gate), harness --dry-run spawn (Plan 40-02 gate)

## Known Stubs

None — this plan creates data artifacts and test scaffolds, not feature code.

## Self-Check: PASSED

- [x] `scripts/eval/locomo10.json` present (10-element array, 1,986 QA, cat5=446, scoreable=1,540)
- [x] `git check-ignore scripts/eval/locomo10.json` returns the path (gitignored)
- [x] `scripts/eval/fixtures/locomo-mini.json` exists (1 conversation, 5 QA, cat5 present, 3+ categories)
- [x] `tests/locomo-scorer.test.ts` exists, runs green (1 active + 1 skipped)
- [x] `tests/locomo-harness.test.ts` exists, runs green (3 active + 1 skipped)
- [x] Commits verified: `3d552d7`, `b2e8952`, `ff198dd`
