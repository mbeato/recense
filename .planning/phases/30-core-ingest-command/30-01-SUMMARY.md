---
phase: 30-core-ingest-command
plan: "01"
subsystem: survey-transport
tags: [survey, headless-client, pure-helpers, tdd, ingest]
dependency_graph:
  requires: [29-03]
  provides: [createClaudeHeadlessSurveyClient, buildSurveyHeadlessArgs, SURVEY_SYSTEM, splitObservations, isRefusalOrToolFailure, buildSurveyPrompt]
  affects: [30-02, 30-03]
tech_stack:
  added: []
  patterns: [tdd-red-green, pure-module, opt-in-factory]
key_files:
  created:
    - src/adapter/survey-observations.ts
    - tests/survey-observations.test.ts
  modified:
    - src/model/claude-headless-client.ts
    - tests/claude-headless-client.test.ts
decisions:
  - key: survey-transport-uses-tmpdir-not-surveydir-as-cwd
    rationale: "cwd: os.tmpdir() + --add-dir surveyDir is safer than cwd: surveyDir — prevents loading the target repo's project hooks/CLAUDE.md (RESEARCH Pitfall 4 / Test B); live probe confirmed --add-dir alone grants read access with zero permission_denials"
  - key: SURVEY_SYSTEM-separate-from-NEUTRAL_SYSTEM
    rationale: "NEUTRAL_SYSTEM says 'no tool use' and would suppress Read/Grep/Glob on the survey path; a separate minimal SURVEY_SYSTEM that permits tools is required"
  - key: gotchas-extra-clause-injected-at-splice
    rationale: "D-08 gotchas tightening: the extra why-level steering clause is inserted after the 'Only summarized' line, not appended — keeps the base structure identical to the 4 healthy areas except for the addition"
metrics:
  duration_minutes: 65
  completed_date: "2026-06-20T14:12:07Z"
  tasks_completed: 2
  files_changed: 4
---

# Phase 30 Plan 01: Survey Primitives + Survey Transport Summary

**One-liner:** Tool-enabled `claude -p` survey transport (Read/Grep/Glob via --add-dir from neutral tmpdir cwd) + D-08 pure helpers (splitObservations, isRefusalOrToolFailure, buildSurveyPrompt) extracted to real importable modules, both TDD-proven and the transport smoke-tested against a fixture.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 RED | Failing tests for survey-observations | `3dd6a0a` | tests/survey-observations.test.ts |
| 1 GREEN | Implement survey-observations pure helpers | `6203104` | src/adapter/survey-observations.ts |
| 2 RED | Failing tests for survey transport | `d8b2aa8` | tests/claude-headless-client.test.ts |
| 2 GREEN | Add opt-in survey transport to claude-headless-client | `344fd01` | src/model/claude-headless-client.ts |

## What Was Built

### Task 1: `src/adapter/survey-observations.ts` (new file)

Pure module — no DB, no I/O, no claude calls.

- **`SURVEY_AREAS`** + **`SurveyArea`** type + **`MAX_OBS_PER_AREA = 25`** — carried verbatim from `scripts/spike/survey-feeder.ts`
- **`splitObservations(text)`** — strips bullet/number markers, drops lines <20 chars / single-token / ending in `;{}` / containing `=>` or `require(`, caps at 25 — carried verbatim from spike
- **`isRefusalOrToolFailure(text)`** — D-07 pattern detection: "cannot access", "i'm sorry", "i am sorry", "no genuine observations", "unable to access", "permission denied" + empty/whitespace → true; case-insensitive
- **`buildSurveyPrompt(area, { repoDir, repoDesc })`** — D-08 calibrated base text parameterized (repoDir/repoDesc replace the spike's hardcoded values); 4 healthy areas byte-identical to 29-CALIBRATION Input 1; `gotchas` gets the extra why-level steering clause ("senior dev's hard-won warnings, NOT a list of what files do") per D-08 gotchas tightening

### Task 2: `src/model/claude-headless-client.ts` (additive only)

Three new exports added; nothing mutated:

- **`SURVEY_SYSTEM`** — minimal system prompt that permits Read/Grep/Glob tool use (NEUTRAL_SYSTEM says "no tool use" and cannot be reused)
- **`buildSurveyHeadlessArgs(model, systemPrompt, surveyDir)`** — survey argv: `--tools Read Grep Glob`, `--add-dir surveyDir`, `--permission-mode bypassPermissions`; KEEPS `--setting-sources project`, `--strict-mcp-config`, `--exclude-dynamic-system-prompt-sections`
- **`createClaudeHeadlessSurveyClient(config, surveyDir)`** — survey factory: `cwd: os.tmpdir()` (neutral — no target-repo hooks), `--add-dir surveyDir` (file access); API-key strip + `--setting-sources project` preserved verbatim from default path

Existing `buildHeadlessArgs` / `createClaudeHeadlessClient` are byte-for-byte unchanged.

## Manual Transport Smoke-Check (REQUIRED one-time behavioral gate)

**Purpose:** Prove the 3-flag union (`cwd: os.tmpdir()` + `--add-dir <dir>` + `--permission-mode bypassPermissions` + `--tools Read Grep Glob`) actually reads files — the argv-shape tests prove the flags are PASSED but not that tools WORK.

**Command run:**

```
FIXTURE_DIR="/var/folders/5p/nzjhym51403773yfzy68z2s00000gn/T/tmp.Ox2HQ1g3Bf"
# Fixture README.md contains: SMOKE-FIXTURE-MARKER-30-01-ALPHA7

cd /tmp && claude -p \
  --output-format json \
  --tools Read Grep Glob \
  --add-dir "$FIXTURE_DIR" \
  --permission-mode bypassPermissions \
  --setting-sources project \
  --system-prompt "You are a code repository surveyor. Use your Read, Grep, and Glob tools to read the target repository and report summarized why-level observations. Output only the observations, one per line." \
  "Read the file README.md in $FIXTURE_DIR and tell me the exact content of that file. Quote it verbatim."
```

**Observed result (full JSON envelope):**

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3141,
  "num_turns": 2,
  "result": "The exact content of the file is:\n\n```\nSMOKE-FIXTURE-MARKER-30-01-ALPHA7\n```",
  "permission_denials": [],
  "total_cost_usd": 0.0341635
}
```

**Assertion checks:**

| Check | Expected | Observed | Pass |
|-------|----------|----------|------|
| `.result` is NOT `"NO_TOOLS"` | NOT "NO_TOOLS" | Observation text with sentinel | PASS |
| `permission_denials` is `[]` | `[]` | `[]` | PASS |
| Real tool turns occurred | `num_turns > 1` | `num_turns: 2` (real read turn) | PASS |
| Fixture sentinel echoed | `SMOKE-FIXTURE-MARKER-30-01-ALPHA7` present | Quoted verbatim in `.result` | PASS |

**Conclusion: TRANSPORT PROVEN.** The exact 3-flag union reads arbitrary dirs correctly. Phase 30 is NOT blocked.

## Verification

```
npx vitest run tests/survey-observations.test.ts tests/claude-headless-client.test.ts
# → Test Files  2 passed (2) | Tests  71 passed (71)

npx tsc --noEmit
# → (clean, no output)

git diff --stat HEAD~4 HEAD
# → 4 files changed: src/adapter/survey-observations.ts (new),
#   src/model/claude-headless-client.ts (additive), tests/survey-observations.test.ts (new),
#   tests/claude-headless-client.test.ts (additive); scripts/spike/survey-feeder.ts untouched;
#   package.json unchanged (net-zero deps)
```

## Deviations from Plan

None — plan executed exactly as written.

The one behavioral detail that required a fix during Task 1 GREEN: the `buildSurveyPrompt` gotchas extra clause was initially split across two lines in the source array, causing the test assertion `toContain('NOT a list of what files do')` to fail (the newline split the phrase). Fixed by keeping the extra clause as a single line. Not a deviation — correct implementation of the D-08 spec.

## TDD Gate Compliance

| Phase | Commit | Type |
|-------|--------|------|
| Task 1 RED | `3dd6a0a` | `test(30-01)` |
| Task 1 GREEN | `6203104` | `feat(30-01)` |
| Task 2 RED | `d8b2aa8` | `test(30-01)` |
| Task 2 GREEN | `344fd01` | `feat(30-01)` |

Both RED and GREEN gate commits present in correct order for both tasks.

## Known Stubs

None. All exports are fully implemented pure functions or real transport factory. No placeholders or TODOs in the shipped code.

## Threat Flags

None. All STRIDE mitigations from the plan's threat register were implemented and tested:

- **T-30-01 (EoP):** Survey argv contains only `--tools Read Grep Glob` (no Bash/Write/Edit) — asserted in unit tests
- **T-30-02 (Tampering):** `cwd: os.tmpdir()` + `--add-dir <dir>` — no target-repo hooks loaded; asserted in unit tests
- **T-30-03 (Spoofing/billing):** `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` strip preserved verbatim on survey path — asserted in unit tests
- **T-30-04 (Repudiation/self-ingestion):** `--setting-sources project` preserved verbatim on survey path — asserted in unit tests
- **T-30-SC:** No new packages added (`package.json` unchanged)

## Self-Check: PASSED

All created files exist and all task commits are present in git history.

| Item | Status |
|------|--------|
| src/adapter/survey-observations.ts | FOUND |
| src/model/claude-headless-client.ts | FOUND |
| tests/survey-observations.test.ts | FOUND |
| tests/claude-headless-client.test.ts | FOUND |
| commit 3dd6a0a (test RED task 1) | FOUND |
| commit 6203104 (feat GREEN task 1) | FOUND |
| commit d8b2aa8 (test RED task 2) | FOUND |
| commit 344fd01 (feat GREEN task 2) | FOUND |
