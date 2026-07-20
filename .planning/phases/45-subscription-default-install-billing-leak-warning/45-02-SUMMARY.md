---
phase: 45-subscription-default-install-billing-leak-warning
plan: "02"
subsystem: config
tags: [config, default, subscription, billing, test-reconciliation]
dependency_graph:
  requires: []
  provides: ["DEFAULT_CONFIG.modelProvider='claude-headless'", reconciled-provider-test-suite]
  affects: [sleep-pass-provider, anthropic-client, claude-headless-client]
tech_stack:
  added: []
  patterns: [in-code-default-flip, grep-before-edit]
key_files:
  created: []
  modified:
    - src/lib/config.ts
    - tests/sleep-pass-provider.test.ts
    - tests/anthropic-client.test.ts
    - src/model/claude-headless-client.ts
decisions:
  - "DEFAULT_CONFIG.modelProvider flipped to 'claude-headless' (subscription default); direct-API 'anthropic' is now opt-in via RECENSE_MODEL_PROVIDER"
  - "anthropic-client.test.ts default-resolves assertion updated to claudeHeadlessModel -- resolveModelId branches on 'claude-headless' returning claudeHeadlessModel not anthropicModel"
  - "claude-headless-client.ts stale comment updated alongside the two config.ts stale clauses (honesty)"
  - "23 pre-existing dist-dependent test failures confirmed unrelated -- worktree lacks dist/; failures exist at base commit too"
metrics:
  duration: "~12 minutes"
  completed: "2026-06-26"
  tasks_completed: 2
  files_modified: 4
---

# Phase 45 Plan 02: Config Default Flip Summary

Flipped DEFAULT_CONFIG.modelProvider from 'anthropic' to 'claude-headless' and reconciled all test/comment fallout via grep-not-guess, satisfying D-01, D-02, and D-03.

## What Was Built

**Task 1 (D-01, D-02): Flip default + update stale comments** (655bfbd)

- src/lib/config.ts:758 -- modelProvider: 'anthropic' changed to modelProvider: 'claude-headless'
- Comment at ~:131 -- removed "Default 'anthropic' = ZERO behavior change." clause; replaced with subscription-as-default copy
- Comment at ~:136 -- removed "opt-in via env ONLY, default unchanged" clause; replaced with statement that direct-API 'anthropic' is now opt-in via RECENSE_MODEL_PROVIDER
- Comment satisfies T-45-03 honesty constraint: states OpenAI key still required for embeddings; makes no "no keys needed" claim; does not describe any env-strip as preventing API billing
- Type union ('anthropic' | 'vertex' | 'local' | 'deepseek' | 'claude-headless') untouched
- claudeHeadlessModel, claudeHeadlessJudgeModel, claudeHeadlessExtractModel values untouched

**Task 2 (D-03): Grep-and-reconcile fallout** (83c6b66)

Full grep triage of stale 'anthropic' default assumptions across src/ and tests/:

| File | Line | Hit | Action |
|------|------|-----|--------|
| tests/sleep-pass-provider.test.ts | 21 | toBe('anthropic') in "unset env -> DEFAULT_CONFIG" -- default-dependent | Changed to 'claude-headless' |
| tests/sleep-pass-provider.test.ts | 113 | toBe('anthropic') in "neither role nor base set -> DEFAULT_CONFIG" -- default-dependent | Changed to 'claude-headless' |
| tests/anthropic-client.test.ts | 154 | toBe(DEFAULT_CONFIG.anthropicModel) -- resolveModelId(baseConfig) now returns claudeHeadlessModel | Updated to toBe(DEFAULT_CONFIG.claudeHeadlessModel), renamed test |
| tests/anthropic-client.test.ts | 139 | Test description "(default)" stale -- body uses explicit override | Updated description to "(explicit opt-in)" |
| src/model/claude-headless-client.ts | 9 | Comment "default stays 'anthropic'" -- stale copy | Updated to reflect new default |
| tests/sleep-pass-provider.test.ts | 83-90 | RECENSE_MODEL_PROVIDER: 'anthropic' -- explicit-set, not default-dependent | Left unchanged |
| tests/sleep-pass-provider.test.ts | 148-153 | RECENSE_JUDGE_PROVIDER: 'anthropic' -- explicit-set | Left unchanged |
| tests/sleep-pass-provider.test.ts | 155-167 | Split routing with RECENSE_JUDGE_PROVIDER: 'anthropic' -- explicit-set | Left unchanged |
| tests/sleep-pass-provider.test.ts | 222-228 | RECENSE_JUDGE_PROVIDER: 'anthropic' -- explicit-set | Left unchanged |
| src/adapter/recense-init.ts | 152 | if (provider === 'anthropic') -- runtime branch, not a default assumption | Left unchanged |
| src/adapter/recense-doctor.ts | 100 | require('@anthropic-ai/sdk') -- SDK import, not a default assumption | Left unchanged |
| src/model/anthropic-client.ts | 119 | Comment "when modelProvider === 'anthropic'" -- accurate description of branch | Left unchanged |
| src/adapter/backfill-subjects-cli.ts | 85 | Comment says "(claude-headless)" -- already correct per plan | Left unchanged |

## Test Results

- npx vitest run tests/sleep-pass-provider.test.ts -- 22/22 pass
- npx vitest run tests/anthropic-client.test.ts -- 26/26 pass
- npx tsc --noEmit -- clean
- Full npx vitest run: 2319 pass / 9 skip / 23 fail (pre-existing, see below)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed anthropic-client.test.ts:154 default-resolves assertion**
- **Found during:** Task 2 grep triage
- **Issue:** Test asserted resolveModelId(baseConfig) === DEFAULT_CONFIG.anthropicModel. With baseConfig = {...DEFAULT_CONFIG} and DEFAULT_CONFIG.modelProvider now 'claude-headless', resolveModelId returns claudeHeadlessModel -- assertion would fail.
- **Fix:** Changed to toBe(DEFAULT_CONFIG.claudeHeadlessModel) and renamed test to 'default config resolves to claudeHeadlessModel (subscription default)'
- **Files modified:** tests/anthropic-client.test.ts
- **Commit:** 83c6b66

**2. [Rule 2 - Stale copy] Updated stale comment in claude-headless-client.ts**
- **Found during:** Task 2 grep triage
- **Issue:** src/model/claude-headless-client.ts:9 said "default stays 'anthropic'" -- same category as D-02 stale comments in config.ts
- **Fix:** Updated to reflect new default
- **Files modified:** src/model/claude-headless-client.ts
- **Commit:** 83c6b66

### Pre-existing Failures (NOT caused by this plan)

23 test failures in adapter-capture, adapter-inject, locomo-harness, locomo-latency-curve, locomo-scorer, episodic-dryrun-gate, eval-harness-smoke all require a compiled dist/ directory via subprocess spawns. The worktree was created without dist/. These failures exist at the base commit a0370e2 too.

## Known Stubs

None. This plan modifies only a default constant, comments, and test assertions.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes introduced. T-45-03 (honesty constraint) satisfied in updated comment copy.

## Self-Check: PASSED

Files modified exist and verified:
- src/lib/config.ts -- grep confirmed modelProvider: 'claude-headless' at :758; both stale clauses at 0 occurrences
- tests/sleep-pass-provider.test.ts -- 22/22 tests pass
- tests/anthropic-client.test.ts -- 26/26 tests pass
- src/model/claude-headless-client.ts -- tsc clean

Commits exist:
- 655bfbd -- feat(45-02): flip DEFAULT_CONFIG.modelProvider to 'claude-headless' (D-01, D-02)
- 83c6b66 -- fix(45-02): reconcile stale 'anthropic'-default assertions (D-03)
