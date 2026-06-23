---
phase: 40-competitive-benchmark-baseline
plan: 03
subsystem: eval
tags: [benchmark, locomo, scorer, llm-judge, gpt-4o-mini, config-snapshot, wave-2]
dependency_graph:
  requires:
    - scripts/eval/fixtures/locomo-mini.json (Plan 40-01)
    - tests/locomo-scorer.test.ts (Plan 40-01 scaffold — rewritten here)
  provides:
    - scripts/eval/locomo-scorer.cjs
    - tests/locomo-scorer.test.ts (rewritten with 4 active tests)
  affects:
    - tests/locomo-harness.test.ts (narrow Rule 1 fix — TS error unblocking build)
tech_stack:
  added: []
  patterns:
    - mem0 Appendix A LLM-judge protocol (gpt-4o-mini, temp=0, max_tokens=10, single user message, no system prompt)
    - Category-5 adversarial skip from scoring denominator
    - D-10 v7.0 config snapshot captured from live DEFAULT_CONFIG into result meta
    - --mock mode for zero-API CI validation
key_files:
  created:
    - scripts/eval/locomo-scorer.cjs
  modified:
    - tests/locomo-scorer.test.ts
    - tests/locomo-harness.test.ts
decisions:
  - "Judge model is gpt-4o-mini (paper version, arXiv 2504.19413) — recorded in meta.judge_model for BENCH-03 methodology traceability"
  - "Category-5 skip covers both numerator and denominator — adversarial_excluded count in meta for audit trail"
  - "D-10 config snapshot reads live DEFAULT_CONFIG at scorer time — no hardcoded values, always reflects actual frozen knobs"
  - "Verdict parser adds obj.label CORRECT/WRONG branch before existing yes/no/correct/incorrect fallbacks"
metrics:
  duration: "~35 minutes"
  completed: "2026-06-23"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 2
requirements: [BENCH-02, BENCH-03]
---

# Phase 40 Plan 03: LoCoMo Scorer — mem0 Appendix A Judge + D-10 Config Snapshot

`locomo-scorer.cjs` implementing the verbatim mem0 Appendix A judge protocol (gpt-4o-mini, temp=0, max_tokens=10) with category-5 skip and full D-10 v7.0 config snapshot in output meta — making recense's J score directly comparable to mem0's published 66.88%.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Clone scorer — mem0 Appendix A prompt, gpt-4o-mini judge, category-5 skip, --mock | `0205521` | `scripts/eval/locomo-scorer.cjs` |
| 2 | D-10 v7.0 config snapshot into result meta | `0205521` | `scripts/eval/locomo-scorer.cjs` |
| 3 | Un-skip scorer unit tests (--mock, zero API) | `ce83f0b` | `tests/locomo-scorer.test.ts`, `tests/locomo-harness.test.ts` |

Note: Tasks 1 and 2 were committed together in a single atomic commit since they implement different sections of the same file (`locomo-scorer.cjs`). Task 3 is a separate commit covering the test rewrite.

## Scorer Implementation Details

### Judge Protocol (BENCH-03 methodology compliance)

The scorer implements the exact mem0 Appendix A prompt verbatim (arXiv 2504.19413):
- **Model:** `gpt-4o-mini` (paper version — recorded in `meta.judge_model`)
- **Temperature:** 0
- **max_tokens:** 10
- **No system prompt** — single user message only
- **Prompt:** verbatim "be generous — same topic = CORRECT" template requesting `{"label":"CORRECT"|"WRONG"}` JSON

### Denominator Correctness (BENCH-03 no-inflated-metrics)

Category 5 (adversarial) rows are skipped with `if (category === 5) continue;`:
- Adversarial rows never reach the judge
- J-score denominator = count(category != 5 rows)
- `meta.questions_adversarial_excluded` records the exclusion count for audit trail
- Confirmed against Plan 40-01 empirical counts: 1,540 scoreable (not >1,600)

### D-10 v7.0 Config Snapshot (BENCH-02 reproducibility)

`meta.sut_config` captures all 15 frozen knobs from live `DEFAULT_CONFIG`:

| Field | Value (v7.0) |
|-------|-------------|
| openaiEmbedModel | text-embedding-3-small |
| embeddingDimensions | 1536 |
| claudeHeadlessExtractModel | claude-haiku-4-5 |
| claudeHeadlessJudgeModel | claude-sonnet-4-6 |
| consolSkipThreshold | 0.2 |
| consolSkipThresholdAssistant | 0.5 |
| rankStrengthWeight | 0 |
| rankedRetrievalK | 10 |
| rankedRetrievalFloor | 0.3 |
| candidateK | 5 |
| entityAnchorK | 5 |
| typedAnchorPoolK | 20 |
| injectionTokenBudget | 500 |
| insightSurfacingEnabled | false |
| predicateGlossThreshold | 0.35 |

Read from live `DEFAULT_CONFIG` at scorer time — no hardcoded values. The official run (Plan 40-05) will capture the actual frozen v7.0 state.

## Test Results

```
Test Files  1 passed (1)
     Tests  4 passed (4)
```

All 4 tests green under `--mock` (zero OpenAI API calls):
1. **Fixture contract:** locomo-mini.json 1-element array, ≥1 category-5 row, ≥2 non-adversarial categories
2. **Denominator:** questions_total = N - cat5_count; questions_adversarial_excluded = cat5_count
3. **Verdict-parse:** gold-in-hypothesis → label=1 (CORRECT); no-match → label=0 (WRONG)
4. **Config snapshot:** all 15 D-10 knob keys present in meta.sut_config; sut_commit + engine_version present

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] locomo-harness.test.ts TS2532 — split(':')[0] possibly undefined**
- **Found during:** Task 3 (build was failing due to TS strict checks)
- **Issue:** `dialogId.split(':')[0]` returns `string | undefined` in strict mode
- **Fix:** Added `?? ''` nullish coalescing: `(dialogId.split(':')[0] ?? '').replace('D', '')`
- **Files modified:** `tests/locomo-harness.test.ts` (Plan 40-02's file — narrow 1-line fix)
- **Commit:** `ce83f0b`

**2. [Rule 3 - Blocking] locomo-scorer.test.ts TS18048 — conv possibly undefined**
- **Found during:** Task 1/2 build verification
- **Issue:** `conversations[0]` is `LoCoMoConversation | undefined` in strict mode; original test accessed it without null check
- **Fix:** Full rewrite of `tests/locomo-scorer.test.ts` as planned by Task 3, which naturally fixed the type errors while adding the required tests
- **Files modified:** `tests/locomo-scorer.test.ts`
- **Commit:** `ce83f0b`

**3. [Rule 3 - Blocking] Worktree base commit drift**
- **Found during:** Initial setup
- **Issue:** Worktree HEAD was at `331efcd` (older than the base `dde0b25`); Plan 40-01 files were absent
- **Fix:** `git reset --hard dde0b250f8b46257e76aeee1d5f5a2f86ba86977` per worktree_branch_check protocol
- **Files modified:** None (worktree state correction)

**4. [Rule 1 - Bug] max_tokens spacing in scorer**
- **Found during:** Task 1 verify grep (`grep -q "max_tokens: 10"`)
- **Issue:** File had `max_tokens:  10` (two spaces) — grep pattern expected single space
- **Fix:** Normalized to `max_tokens: 10` (single space, consistent with codebase style)
- **Files modified:** `scripts/eval/locomo-scorer.cjs`
- **Commit:** `0205521` (same commit, fixed before committing)

## Threat Surface Scan

No new network endpoints or auth paths introduced. The scorer reads `OPENAI_API_KEY` from environment (gitignored `sleep.env`) and never writes it to the result JSON. `meta.judge_model` records the model name only, not secrets. T-40-06 and T-40-07 mitigations confirmed as implemented.

## Known Stubs

None. All 15 config knob fields read from live `DEFAULT_CONFIG` — no hardcoded placeholder values. The scorer runs against actual hypotheses from `locomo-harness.cjs` (Plan 40-02); both files needed for a real run.

## Self-Check: PASSED

- [x] `scripts/eval/locomo-scorer.cjs` exists (369 lines > min_lines: 150)
- [x] `grep -q "gpt-4o-mini"` passes
- [x] `grep -q "max_tokens: 10"` passes
- [x] `grep -q "temperature: 0"` passes
- [x] `grep -q "label === 'CORRECT'"` passes
- [x] `grep -q "category === 5"` passes
- [x] `grep -q "buildLoCoMoJudgePrompt"` passes
- [x] `grep -q "be generous"` passes
- [x] `grep -q "sut_config"` passes
- [x] `grep -q "sut_commit"` passes
- [x] `grep -q "DEFAULT_CONFIG.openaiEmbedModel"` passes
- [x] `grep -q "predicateGlossThreshold"` passes
- [x] `grep -q "insightSurfacingEnabled"` passes
- [x] `grep -q "questions_adversarial_excluded"` passes
- [x] `npx vitest run tests/locomo-scorer.test.ts` → 4 passed (4)
- [x] Commits verified: `0205521`, `ce83f0b`
