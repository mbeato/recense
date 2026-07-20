---
phase: 30-core-ingest-command
verified: 2026-06-20T13:10:00Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
---

# Phase 30: Core Ingest Command Verification Report

**Phase Goal:** A user runs `recense ingest-project <dir>` on an unexplored repo: an agent surveys it and emits summarized observations as episodes via the existing offline pipeline, scope-tagged to that project, yielding facts + schemas after a sleep pass. Carries the Phase-29 calibration (prompt shape, quality gate, scope-tagging convention).
**Verified:** 2026-06-20T13:10:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | `recense ingest-project <dir>` completes, episodes written to DB, no online path blocked, command returns promptly | VERIFIED | `ingest-project-cli.ts` default path holds no write lock (acquireLock only on --consolidate). Deferred sentinel handoff via `resolveDirtySentinelPath()` in config. 76 survey episodes consolidated in live run (30-03-VALIDATION.md). Dispatcher wired in recense.ts:95. |
| SC2 | After a sleep pass, ingested facts retrievable via `recense recall` with correct `[scope]` attribution | VERIFIED | 233 survey facts scoped `usage` at data layer (`node_scope`). Live ambientRecall rendered `[usage]` prefix for 5/5 tested queries. Synthetic-cwd mechanism (`resolveSurveyCwd`) verified by cwdToScope round-trip test (test 21 in ingest-project-cli.test.ts). |
| SC3 | Brain produces at least one schema induced from surveyed project — abstraction pipeline fires | VERIFIED | 23 schemas abstract over >=1 usage-scoped fact (abstracts-edge query). Schemas include repo-specific generalizations ("Cache tier cost splitting", "No shadcn raw Tailwind") that were never explicitly stated. Baseline-delta metric was confounded (brain-wide -2 net); abstracts-edge count is the sound measure and confirms SC3 PASS. |
| SC4 | Raw code lines and low-value structural facts absent — quality gate enforced | VERIFIED | Facts in 30-03-VALIDATION.md are why-level and contextscope-specific (TOCTOU symlink-rename guard, per-(filePath,mtime) streaming cache, etc.). One preamble line slipped past splitObservations ("The repository is now well understood...") — non-blocking, noted as follow-up. No raw code lines or structural trivia ("file X imports Y") in the fact set. |

**Score:** 4/4 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/adapter/survey-observations.ts` | Pure helpers: splitObservations, isRefusalOrToolFailure, buildSurveyPrompt, SURVEY_AREAS | VERIFIED | File exists, 161 lines. Exports all 5 required symbols. Pure module — no DB/I/O/claude calls confirmed. |
| `src/model/claude-headless-client.ts` | New exports: createClaudeHeadlessSurveyClient, buildSurveyHeadlessArgs, SURVEY_SYSTEM; existing path byte-for-byte unchanged | VERIFIED | All three exports confirmed present. buildHeadlessArgs still returns '--tools','none' (line 112). createClaudeHeadlessClient unchanged. Additive-only pattern confirmed by grep. |
| `src/adapter/ingest-project-cli.ts` | Survey orchestration -> recordEvent -> deferred/inline consolidation; min 120 lines; imports createClaudeHeadlessSurveyClient | VERIFIED | 456 lines. Imports createClaudeHeadlessSurveyClient (not createClaudeHeadlessClient). Full survey loop, retry-skip, deferred and --consolidate paths, all flags implemented. |
| `src/adapter/recense.ts` | Dispatcher case + usage string for ingest-project | VERIFIED | Line 95: `case 'ingest-project': spawnScript('ingest-project-cli.js', process.argv.slice(3)); break;`. Usage string includes 'ingest-project'. grep count 3. |
| `.planning/phases/30-core-ingest-command/30-03-VALIDATION.md` | Written evidence: per-area counts, [scope] recall samples, schema count, min 30 lines | VERIFIED | 281 lines. Contains per-area genuine counts (248 total facts across 5 areas, all >= 5), recall spot-check samples with [usage] prefix, schema count (23 abstracts-edge schemas), GO/NO-GO decision. |
| `dist/src/adapter/ingest-project-cli.js` | Compiled dist file exists | VERIFIED | File exists, 19470 bytes, dated 2026-06-20. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| ingest-project-cli.ts | createClaudeHeadlessSurveyClient | per-area survey call | WIRED | Line 337: `const { client, model } = createClaudeHeadlessSurveyClient(judgeConfig, repoDir);` |
| ingest-project-cli.ts recordEvent | node_scope at consolidation | cwd = real dir OR synthetic /Users/<user>/<scope> | WIRED | resolveSurveyCwd synthesizes home-rooted path; cwdToScope round-trip test asserts cwdToScope(result)==='my-clone'; stampNodeScopes derives scope from episode cwd with zero consolidation-engine change. |
| recense.ts | ingest-project-cli.js | spawnScript dispatch | WIRED | Line 95: case 'ingest-project': spawnScript('ingest-project-cli.js', process.argv.slice(3)); |
| survey transport | --tools Read Grep Glob (not --tools none) | buildSurveyHeadlessArgs | WIRED | Line 152-154 of claude-headless-client.ts: '--tools','Read','Grep','Glob', '--add-dir', surveyDir, '--permission-mode','bypassPermissions'. Smoke-tested behaviorally (fixture sentinel echoed, 0 denials, NOT NO_TOOLS). |
| isRefusalOrToolFailure gate | retry-once-skip (never ingest apology) | runSurveyAndFeed | WIRED | Lines 242-251: refusal check -> retry once -> skip on second failure. origin='observed' hardcoded at line 267, never 'asserted_by_user'. |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| ingest-project-cli.ts main() | observations (per area) | createClaudeHeadlessSurveyClient -> claude -p with --tools Read Grep Glob -> live repo files | Yes — transport smoke-proven (fixture sentinel echoed verbatim); live run produced 248 distinct facts across 5 areas | FLOWING |
| runSurveyAndFeed | pipeline.recordEvent(content, origin='observed', cwd) | splitObservations(response) from real agent read | Yes — 76 episodes consolidated in the live run | FLOWING |
| recense recall [scope] | ambientRecall | node_scope join on facts derived from episode cwd | Yes — 233 survey facts scoped 'usage', 5/5 recall queries returned [usage] prefix | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Unit tests (92 total: 71 + 21) | npx vitest run tests/survey-observations.test.ts tests/claude-headless-client.test.ts tests/ingest-project-cli.test.ts | 3 passed (3), 92 passed (92) | PASS |
| TypeScript type-check | npx tsc --noEmit | Clean (no output) | PASS |
| Dispatcher wiring | grep -c "ingest-project" src/adapter/recense.ts | 3 | PASS |
| Net-zero deps | git diff package.json | Empty | PASS |
| Transport smoke-check (from 30-01-SUMMARY.md) | claude -p --tools Read Grep Glob --add-dir <fixture> --permission-mode bypassPermissions [...] | .result echoed sentinel verbatim, permission_denials:[], NOT NO_TOOLS, num_turns:2 | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| INGEST-01 | 30-01, 30-02, 30-03 | User can run `recense ingest-project <dir>` to onboard a project via agentic survey | SATISFIED | Command exists, dispatched, surveys via tool-enabled transport, emits episodes. Live run on /Users/vtx/usage confirmed. |
| INGEST-02 | 30-02, 30-03 | Ingested project knowledge is scope-tagged (node_scope), recalled under correct [scope] | SATISFIED | 233 facts scoped 'usage'. cwdToScope round-trip test. ambientRecall confirmed [usage] prefix 5/5. |
| INGEST-04 | 30-02, 30-03 | Ingestion runs entirely offline (origin=observed), yields facts+schemas, never blocks online path | SATISFIED | origin='observed' enforced (never 'asserted_by_user'). Default path holds no lock. Deferred to scheduled sleep pass. 23 schemas induced. |

---

### Anti-Patterns Found

No anti-pattern markers (TBD/FIXME/XXX) found in any Phase 30 modified file. No stub implementations or placeholder returns in the shipped code. One cosmetic finding:

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| ingest-project-cli.ts (runtime behavior) | n/a | splitObservations preamble pass-through: "The repository is now well understood. Here are the architecture observations:" slipped past the filter in the live run | Info | One non-fact line per survey run at most. Quality gate catches it via the judge at consolidation. Non-blocking follow-up identified in 30-03-VALIDATION.md. |

---

### Human Verification Required

None. All success criteria were verified programmatically and via the documented live run (30-03-VALIDATION.md). The Plan-03 blocking human checkpoint was satisfied: founder delegated autonomous execution, live run completed, results recorded, GO/NO-GO = GO.

---

## Gaps Summary

No gaps. All four ROADMAP success criteria are verified:

- SC1: command completes, episodes written, no online path blocked — codebase evidence + live run confirmation
- SC2: [scope] attribution correct — 233 usage-scoped facts, 5/5 recall queries render [usage] prefix
- SC3: abstraction pipeline fired — 23 schemas abstract over usage-scoped facts (abstracts-edge query; baseline-delta metric was confounded and is documented as unsound in VALIDATION.md)
- SC4: quality gate holds — no raw code lines or structural trivia in the live fact set

**Non-blocking follow-ups (informational):**
1. `splitObservations` preamble filter: the architecture preamble line "The repository is now well understood..." passes the filter. A one-line fix would drop lines matching `/now well understood|here are the.*observations/i`. Not a correctness failure — the consolidation judge rejects it as a low-value fact.
2. SC3 metric: replace the baseline-delta schema count check in future validations with the abstracts-edge query (`SELECT count(DISTINCT n.id) FROM node n JOIN edge e ON e.to_node=n.id WHERE n.type='schema' AND n.tombstoned=0 AND e.kind='abstracts'` joined to scoped facts). The brain-wide delta is confounded by unrelated tombstoning passes.

---

_Verified: 2026-06-20T13:10:00Z_
_Verifier: Claude (gsd-verifier)_
